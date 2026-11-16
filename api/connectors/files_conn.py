"""File sources: Amazon S3 (and S3-compatible stores) and a directory on this server's disk.

Browsing is root → folder → file: the database is the bucket (or the directory), schemas are
its folders (two levels deep, "/" for the root) and tables are the data files in a folder —
CSV, TSV, Parquet, JSON and JSON Lines — plus each subfolder holding data files, read as one
table of all its files (a partitioned dataset, `name/`). Columns are the first file's (Parquet
footers, or a bounded read of a text file); a folder's other files fill the same columns.

Every row carries `_file` and `_file_modified`. `_file_modified` is the recommended incremental
cursor: a sync reads only the files changed since the last one, as Foundry's file-based syncs
do. Any date, date-time or integer column can be a cursor too (filtered while reading).

The local directory source only reads below the roots in BLUESANDAI_FILESYSTEM_ROOTS (paths
separated by the OS path separator; default: data/filesystem), never follows symbolic links,
and ignores files modified less than `fileMustNotChangeDuration` ago (files still being written).
"""

from __future__ import annotations

import io
import os
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Iterator, Optional

import pyarrow as pa

from .base import ConnectorError
from .records import RecordConnector, column

FORMATS = {".csv": "csv", ".tsv": "tsv", ".parquet": "parquet", ".pq": "parquet", ".json": "json", ".jsonl": "jsonl", ".ndjson": "jsonl"}
MAX_SCHEMAS = 500
MAX_FOLDER_FILES = 10_000
TEXT_SAMPLE_BYTES = 4 << 20
FILE_COLUMNS = ("_file", "_file_modified")


@dataclass
class Entry:
    path: str  # relative to the root, "/"-separated
    folder: bool
    size: int = 0
    modified: Optional[datetime] = None


def file_format(name: str) -> Optional[str]:
    return FORMATS.get(os.path.splitext(name.lower())[1])


def arrow_kind(t: pa.DataType) -> str:
    if pa.types.is_boolean(t):
        return "Boolean"
    if pa.types.is_int8(t) or pa.types.is_uint8(t):
        return "Byte" if pa.types.is_int8(t) else "Short"
    if pa.types.is_int16(t) or pa.types.is_uint16(t):
        return "Short" if pa.types.is_int16(t) else "Integer"
    if pa.types.is_int32(t):
        return "Integer"
    if pa.types.is_integer(t):
        return "Long"
    if pa.types.is_float16(t) or pa.types.is_float32(t):
        return "Float"
    if pa.types.is_floating(t):
        return "Double"
    if pa.types.is_decimal(t):
        return "Decimal" if t.scale <= 18 and t.precision - t.scale <= 20 else "Double"
    if pa.types.is_date(t):
        return "Date"
    if pa.types.is_timestamp(t):
        return "Timestamp"
    if pa.types.is_binary(t) or pa.types.is_large_binary(t) or pa.types.is_fixed_size_binary(t):
        return "Binary"
    return "String"


# --------------------------------------------------------------------------------------------
# where the files are
# --------------------------------------------------------------------------------------------


class Backend(ABC):
    @abstractmethod
    def list(self, rel: str) -> list[Entry]:
        """The entries directly in a folder ("" is the root)."""

    @abstractmethod
    def open(self, rel: str) -> BinaryIO:
        """A seekable binary stream of a file."""

    @abstractmethod
    def write(self, rel: str, data: bytes, content_type: str) -> None:
        """Create or replace a file (file exports)."""

    def open_stream(self, rel: str) -> BinaryIO:
        """A forward-only binary stream of a file, read in chunks by the caller (media syncs copy files with it):
        unlike open(), it never holds the whole file in memory."""
        return self.open(rel)

    def walk(self, rel: str, limit: int) -> list[Entry]:
        """Files below a folder (at most `limit`), in path order."""
        out: list[Entry] = []
        stack = [rel]
        while stack and len(out) < limit:
            folder = stack.pop()
            entries = sorted(self.list(folder), key=lambda e: e.path)
            out.extend(e for e in entries if not e.folder)
            stack.extend(reversed([e.path for e in entries if e.folder]))
        return sorted(out[:limit], key=lambda e: e.path)


def allowed_roots() -> list[Path]:
    raw = os.environ.get("BLUESANDAI_FILESYSTEM_ROOTS", "")
    roots = [p for p in raw.split(os.pathsep) if p.strip()] or [str(Path(os.environ.get("BLUESANDAI_DATA_DIR", Path(__file__).resolve().parents[2] / "data")) / "filesystem")]
    return [Path(p).expanduser().resolve() for p in roots]


class LocalBackend(Backend):
    def __init__(self, root: str, settle_s: float):
        r = Path(root).expanduser()
        if not r.is_absolute():
            raise ConnectorError("Root directory must be an absolute path")
        r = r.resolve()
        if not any(r == a or a in r.parents for a in allowed_roots()):
            raise ConnectorError(
                f"{r} is outside the directories this server may read. Allowed: {', '.join(str(a) for a in allowed_roots())} (set BLUESANDAI_FILESYSTEM_ROOTS)"
            )
        if not r.is_dir():
            raise ConnectorError(f"{r} is not a directory")
        self.root = r
        self.settle_s = settle_s

    def _path(self, rel: str) -> Path:
        p = (self.root / rel).resolve() if rel else self.root
        if p != self.root and self.root not in p.parents:
            raise ConnectorError(f'"{rel}" is outside the root directory')
        return p

    def list(self, rel: str) -> list[Entry]:
        out = []
        now = time.time()
        try:
            it = os.scandir(self._path(rel))
        except OSError as e:
            raise ConnectorError(f'Could not list "{rel or "/"}": {e.strerror}') from None
        with it:
            for d in it:
                if d.is_symlink() or d.name.startswith("."):
                    continue
                path = f"{rel}/{d.name}" if rel else d.name
                if d.is_dir(follow_symlinks=False):
                    out.append(Entry(path, True))
                elif d.is_file(follow_symlinks=False):
                    st = d.stat(follow_symlinks=False)
                    if now - st.st_mtime < self.settle_s:
                        continue  # still being written
                    out.append(Entry(path, False, st.st_size, datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)))
        return out

    def open(self, rel: str) -> BinaryIO:
        p = self._path(rel)
        if p.is_symlink() or not p.is_file():
            raise ConnectorError(f'"{rel}" is not a readable file')
        return open(p, "rb")

    def write(self, rel: str, data: bytes, content_type: str) -> None:
        p = self._path(rel)
        if p.is_symlink():
            raise ConnectorError(f'"{rel}" is a symbolic link')
        p.parent.mkdir(parents=True, exist_ok=True)
        if self.root not in p.parents:
            raise ConnectorError(f'"{rel}" is outside the root directory')
        tmp = p.with_name(f".{p.name}.part")
        tmp.write_bytes(data)
        tmp.replace(p)  # readers never see a partial file


class S3Backend(Backend):
    def __init__(self, config: dict, secrets: dict, timeout_s: int):
        import boto3
        from botocore.config import Config

        m = re.fullmatch(r"s3a?://([a-z0-9][a-z0-9.\-]{1,61}[a-z0-9])/?(.*)", (config.get("url") or "").strip())
        if not m:
            raise ConnectorError("URL must look like s3://bucket-name/ or s3://bucket-name/folder/")
        self.bucket, prefix = m.group(1), m.group(2).strip("/")
        self.prefix = f"{prefix}/" if prefix else ""
        endpoint = (config.get("endpoint") or "").strip()
        if endpoint and not endpoint.startswith(("http://", "https://")):
            endpoint = f"https://{endpoint}"
        session = boto3.session.Session(
            aws_access_key_id=config.get("access_key_id") or None,
            aws_secret_access_key=secrets.get("secret_access_key") or None,
            aws_session_token=secrets.get("session_token") or None,
            region_name=config.get("region") or None,
        )
        role = (config.get("sts_role_arn") or "").strip()
        if role:
            creds = session.client("sts").assume_role(RoleArn=role, RoleSessionName="bluesandai-connector")["Credentials"]
            session = boto3.session.Session(
                aws_access_key_id=creds["AccessKeyId"],
                aws_secret_access_key=creds["SecretAccessKey"],
                aws_session_token=creds["SessionToken"],
                region_name=config.get("region") or None,
            )
        self.s3 = session.client(
            "s3",
            endpoint_url=endpoint or None,
            config=Config(
                connect_timeout=10,
                read_timeout=timeout_s,
                retries={"max_attempts": 3},
                s3={"addressing_style": "path" if config.get("path_style") else "auto"},
            ),
        )

    def list(self, rel: str) -> list[Entry]:
        base = self.prefix + (f"{rel}/" if rel else "")
        out = []
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=base, Delimiter="/"):
            for p in page.get("CommonPrefixes", []):
                out.append(Entry(p["Prefix"][len(self.prefix):].rstrip("/"), True))
            for o in page.get("Contents", []):
                if o["Key"].endswith("/"):
                    continue  # folder markers
                out.append(Entry(o["Key"][len(self.prefix):], False, o["Size"], o["LastModified"].astimezone(timezone.utc)))
        return out

    def open(self, rel: str) -> BinaryIO:
        # Parquet needs random access: the object is read into memory
        body = self.s3.get_object(Bucket=self.bucket, Key=self.prefix + rel)["Body"]
        return io.BytesIO(body.read())

    def open_stream(self, rel: str) -> BinaryIO:
        # the object's body as it arrives over the connection (read(n) reads at most n bytes of it)
        return _BodyStream(self.s3.get_object(Bucket=self.bucket, Key=self.prefix + rel)["Body"])

    def write(self, rel: str, data: bytes, content_type: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=self.prefix + rel.lstrip("/"), Body=data, ContentType=content_type)


class _BodyStream(io.RawIOBase):
    """An S3 GetObject body (botocore StreamingBody) as a forward-only binary file: read(n) pulls at most n bytes
    from the connection, close() releases it."""

    def __init__(self, body: Any):
        self._body = body

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        data = self._body.read(len(b))
        n = len(data)
        b[:n] = data
        return n

    def read(self, size: int = -1) -> bytes:
        return self._body.read() if size is None or size < 0 else self._body.read(size)

    def close(self) -> None:
        if not self.closed:
            try:
                self._body.close()
            finally:
                super().close()


# --------------------------------------------------------------------------------------------
# reading files
# --------------------------------------------------------------------------------------------


def read_batches(f: BinaryIO, fmt: str, limit: Optional[int] = None) -> Iterator[pa.RecordBatch]:
    if fmt == "parquet":
        import pyarrow.parquet as pq

        yield from pq.ParquetFile(f).iter_batches(batch_size=min(limit or 10_000, 10_000))
        return
    if fmt in ("csv", "tsv"):
        import pyarrow.csv as pcsv

        reader = pcsv.open_csv(
            f,
            read_options=pcsv.ReadOptions(block_size=1 << 20),
            parse_options=pcsv.ParseOptions(delimiter="\t" if fmt == "tsv" else ","),
        )
        yield from reader
        return
    import pyarrow.json as pjson

    # a bounded read only for JSON Lines: a cut JSON document no longer parses
    data = f.read(TEXT_SAMPLE_BYTES) if limit and fmt == "jsonl" else f.read()
    if fmt == "json":
        import json

        try:
            parsed = json.loads(data)
        except ValueError:
            parsed = None
        if isinstance(parsed, list):
            yield pa.RecordBatch.from_pylist([r if isinstance(r, dict) else {"value": r} for r in parsed[: limit or None]])
            return
        if isinstance(parsed, dict):
            yield pa.RecordBatch.from_pylist([parsed])
            return
    if limit and fmt == "jsonl" and len(data) == TEXT_SAMPLE_BYTES:
        data = data[: data.rfind(b"\n") + 1]  # whole lines only
    yield from pjson.read_json(io.BytesIO(data)).to_batches()


class FileConnector(RecordConnector):

    @abstractmethod
    def _backend(self) -> Backend: ...

    @property
    def fs(self) -> Backend:
        if not hasattr(self, "_fs"):
            self._fs = self._backend()
        return self._fs

    def _ls(self, rel: str) -> list[Entry]:
        return self._safe(lambda: self.fs.list(rel), f'Could not list "{rel or "/"}"')

    # -- discovery --

    def list_schemas(self, database: str) -> list[str]:
        out = ["/"]
        for top in sorted((e for e in self._ls("") if e.folder), key=lambda e: e.path):
            out.append(top.path)
            for sub in sorted((e for e in self._ls(top.path) if e.folder), key=lambda e: e.path):
                out.append(sub.path)
                if len(out) >= MAX_SCHEMAS:
                    return out
        return out

    @staticmethod
    def _folder(schema: str) -> str:
        return "" if schema in ("", "/") else schema.strip("/")

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        folder = self._folder(schema)
        out = []
        for e in sorted(self._ls(folder), key=lambda e: e.path):
            name = e.path.rsplit("/", 1)[-1]
            if search and search.lower() not in name.lower():
                continue
            if e.folder:
                files = self._data_files(e.path)
                if files:
                    out.append({"name": f"{name}/", "kind": "view", "rows": None, "comment": f"Folder · {len(files)} file{'s' if len(files) != 1 else ''} ({files[0][1]})"})
            elif file_format(name):
                out.append({"name": name, "kind": "table", "rows": None, "comment": f"{file_format(name)} · {_size(e.size)}"})
        return out

    def _data_files(self, rel: str) -> list[tuple[Entry, str]]:
        files = self._safe(lambda: self.fs.walk(rel, MAX_FOLDER_FILES), f'Could not list "{rel}"')
        typed = [(e, file_format(e.path)) for e in files if file_format(e.path) and not os.path.basename(e.path).startswith(("_", "."))]
        if not typed:
            return []
        fmt = typed[0][1]
        return [(e, f) for e, f in typed if f == fmt]

    def _files(self, schema: str, table: str) -> list[tuple[Entry, str]]:
        """The files of a table, in path order."""
        folder = self._folder(schema)
        name = table.rstrip("/")
        if "/" in name or name in ("", ".", ".."):
            raise ConnectorError(f'"{table}" is not a table of this folder')
        rel = f"{folder}/{name}" if folder else name
        if table.endswith("/"):
            files = self._data_files(rel)
            if not files:
                raise ConnectorError(f'Folder "{rel}" holds no data files')
            return files
        e = next((e for e in self._ls(folder) if e.path == rel and not e.folder), None)
        if not e or not file_format(name):
            raise ConnectorError(f'"{rel}" was not found or is not a CSV, TSV, Parquet or JSON file')
        return [(e, file_format(name))]  # type: ignore[list-item]

    # tables are addressed by (schema, table): RecordConnector's hooks take them joined
    @staticmethod
    def _key(schema: str, table: str) -> str:
        return f"{schema}\x00{table}"

    def _split(self, key: str) -> tuple[str, str]:
        schema, _, table = key.partition("\x00")
        return schema, table

    def _list_tables(self, database: str, search: str) -> list[dict]:
        return self.list_tables(database, "/", search)

    def _table(self, database: str, table: str) -> None:
        self._files(*self._split(table))

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        schema, name = self._split(table)
        entry, fmt = self._files(schema, name)[0]

        def first_schema() -> pa.Schema:
            with self.fs.open(entry.path) as f:
                if fmt == "parquet":
                    import pyarrow.parquet as pq

                    return pq.ParquetFile(f).schema_arrow
                for b in read_batches(f, fmt, limit=1000):
                    return b.schema
            return pa.schema([])

        sch = self._safe(first_schema, f'Could not read "{entry.path}"')
        cols = [column(fld.name, arrow_kind(fld.type), str(fld.type)) for fld in sch if fld.name not in FILE_COLUMNS]
        cols.append(column("_file", "String", "file path", nullable=False, comment="Path of the file the row was read from"))
        cols.append(column("_file_modified", "Timestamp", "file modified", nullable=False, comment="When the file was last modified"))
        return cols

    def _file_records(self, entry: Entry, fmt: str, limit: Optional[int]) -> Iterator[list[dict]]:
        left = limit
        with self.fs.open(entry.path) as f:
            for b in read_batches(f, fmt, limit):
                rows = b.to_pylist()
                if left is not None:
                    rows = rows[:left]
                    left -= len(rows)
                for r in rows:
                    r["_file"] = entry.path
                    r["_file_modified"] = entry.modified
                if rows:
                    yield rows
                if left is not None and left <= 0:
                    return

    def _records(self, database: str, table: str, limit: Optional[int] = None, files: Optional[list[tuple[Entry, str]]] = None) -> Iterator[list[dict]]:
        schema, name = self._split(table)
        left = limit
        for entry, fmt in files if files is not None else self._files(schema, name):
            for rows in self._file_records(entry, fmt, left):
                yield rows
                if left is not None:
                    left -= len(rows)
            if left is not None and left <= 0:
                return

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if col["name"] != "_file_modified":
            return None
        schema, name = self._split(table)
        chosen = []
        for e, fmt in self._files(schema, name):
            m = e.modified
            if m is None or (upper is not None and m > upper) or (lower is not None and (m < lower or (m == lower and not lower_inclusive))):
                continue
            chosen.append((e, fmt))
        return self._records(database, table, files=chosen)

    def get_incremental_metadata(self, database: str, schema: str, table: str, column: str) -> dict:
        if column == "_file_modified":
            files = self._files(schema, table)
            return {"max": max((e.modified for e, _ in files if e.modified), default=None)}
        return super().get_incremental_metadata(database, database, self._key(schema, table), column)

    # the connector interface, with (schema, table) folded into RecordConnector's table key
    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        n = len(self._files(schema, table))
        return {**self._schema(database, self._key(schema, table)), "comment": f"{n} file{'s' if n != 1 else ''}; columns from the first"}

    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        return super().preview_rows(database, database, self._key(schema, table), limit)

    def count_range(self, database: str, schema: str, table: str, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> int:
        return super().count_range(database, database, self._key(schema, table), column, lower, lower_inclusive, upper)

    def read_range(
        self, database: str, schema: str, table: str, columns: list[str], column: str, lower: Any, lower_inclusive: bool, upper: Any, limit: Optional[int]
    ) -> list[tuple]:
        return super().read_range(database, database, self._key(schema, table), columns, column, lower, lower_inclusive, upper, limit)

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        return super().stream_table(database, database, self._key(schema, table), columns, batch_size)


def _size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n} B"


class S3Connector(FileConnector):
    def _backend(self) -> Backend:
        return self._safe(lambda: S3Backend(self.config, self.secrets, int(self.statement_timeout_s)), "Could not connect")

    def test_connection(self) -> dict:
        fs: S3Backend = self.fs  # type: ignore[assignment]
        self._safe(lambda: fs.s3.list_objects_v2(Bucket=fs.bucket, Prefix=fs.prefix, MaxKeys=1), "Could not list the bucket")
        return {"version": f"Amazon S3 · s3://{fs.bucket}/{fs.prefix}"}

    def list_databases(self) -> list[str]:
        fs: S3Backend = self.fs  # type: ignore[assignment]
        return [fs.bucket]


class FilesystemConnector(FileConnector):
    def _backend(self) -> Backend:
        settle = parse_duration(self.config.get("file_must_not_change") or "PT2S")
        return LocalBackend(self.config["root_directory"], settle)

    def test_connection(self) -> dict:
        n = len(self._ls(""))
        return {"version": f"Directory {self.fs.root} · {n} entr{'ies' if n != 1 else 'y'}"}  # type: ignore[attr-defined]

    def list_databases(self) -> list[str]:
        return [self.fs.root.name or str(self.fs.root)]  # type: ignore[attr-defined]


def parse_duration(text: str) -> float:
    """An ISO-8601 duration of hours, minutes and seconds (PT2S, PT1M30S) in seconds."""
    m = re.fullmatch(r"PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?", text.strip().upper())
    if not m or not any(m.groups()):
        raise ConnectorError(f'"{text}" is not an ISO-8601 duration such as PT2S or PT1M')
    h, mi, s = (float(g) if g else 0.0 for g in m.groups())
    return h * 3600 + mi * 60 + s
