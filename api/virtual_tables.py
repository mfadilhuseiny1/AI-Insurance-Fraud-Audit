"""Virtual tables: tables in an external system (Snowflake, BigQuery, Databricks, an Iceberg catalog, files in S3 or a
directory) registered in Files without copying their data — Palantir's virtual tables, for Python transforms.

A virtual table is a Files item (content type VT_TYPE) holding its source (a Data Connection connection) and its
locator — the `transforms.tables` class that names it: SnowflakeTable(database, schema, table), BigQueryTable(project,
dataset, table), DatabricksTable(catalog, schema, table, format, location), IcebergTable(table, warehouse_path),
FilesTable(path, format), DeltaTable(path) (Delta Lake through deltalake, in a filesystem or S3 source). Its RID is `ri.tables.main.table.<item id>`, like a managed table's.

Foundry-native compute (code_repos.py): a TableInput on a virtual table is read through the connection before the
transform runs; a TableOutput(path, source, Locator(...)) registers the virtual table on its first build (its source
and location cannot change afterwards) and what the transform writes replaces the external table through the
connection: CREATE + INSERT in a transaction on SQL warehouses, a table overwrite in an Iceberg catalog, a part file in
a folder for files. Compute pushdown (Snowpark, Databricks Connect, Ibis on BigQuery) is not available.
"""

from __future__ import annotations

import io
import json
import re
from typing import Any, Optional

import pyarrow as pa

import datasources as ds
import db
import drive
import pipeline_datasets

VT_TYPE = "application/vnd.bluesandai.virtual-table+json"
FILE_FORMATS = {"parquet": ".parquet", "csv": ".csv", "avro": ".avro", "jsonl": ".jsonl"}
# locator → the connection kinds it may be used with
LOCATOR_KINDS = {
    "SnowflakeTable": ("snowflake",),
    "BigQueryTable": ("bigquery",),
    "DatabricksTable": ("databricks",),
    "IcebergTable": ("iceberg-rest",),
    "FilesTable": ("s3", "filesystem", "azure-blob", "gcs"),
    "DeltaTable": ("s3", "filesystem", "azure-blob", "gcs"),
}


class VirtualTableError(ValueError):
    pass


def is_virtual(item: Optional[dict]) -> bool:
    return bool(item) and item.get("kind") == "file" and item.get("content_type") == VT_TYPE


def record(item: dict) -> dict:
    return json.loads(drive.read_bytes(item))


def connection_id(source: str) -> str:
    """A source RID (ri.magritte..source.<id>), a connection id or a connection name → the connection id."""
    ref = (source or "").strip()
    m = re.fullmatch(r"ri\.magritte\.\.source\.([0-9a-zA-Z-]+)", ref)
    cid = m.group(1) if m else ref
    rows = ds._rows("SELECT id FROM db_connections WHERE id = %s OR name = %s ORDER BY id = %s DESC LIMIT 1", (cid, ref, cid))
    if not rows:
        raise VirtualTableError(f'TableOutput source "{source}": no such Data Connection source')
    return rows[0]["id"]


def _kind(conn_id: str) -> str:
    return ds._rows("SELECT kind FROM db_connections WHERE id = %s", (conn_id,))[0]["kind"]


def location(conn_id: str, locator: dict) -> tuple[str, str, str]:
    """(database, schema, table) of a locator in its connection's browsing terms."""
    t = locator.get("type")
    kinds = LOCATOR_KINDS.get(t or "")
    if not kinds:
        raise VirtualTableError(f"unknown table locator {t}")
    kind = _kind(conn_id)
    if kind not in kinds:
        raise VirtualTableError(f"{t} is for {' / '.join(kinds)} sources; this source is {kind}")
    if t == "SnowflakeTable":
        return locator["database"], locator["schema"], locator["table"]
    if t == "BigQueryTable":
        return locator["project"], locator["dataset"], locator["table"]
    if t == "DatabricksTable":
        return locator["catalog"], locator["schema"], locator["table"]
    if t == "IcebergTable":
        parts = [p for p in str(locator["table"]).split(".") if p]
        if len(parts) < 2:
            raise VirtualTableError("IcebergTable needs a namespace and a table name (namespace.table)")
        with ds._open(conn_id) as c:
            database = c.list_databases()[0]
        return database, ".".join(parts[:-1]), parts[-1]
    if t == "DeltaTable":
        path = str(locator.get("path") or "").strip("/")
        if not path or ".." in path.split("/"):
            raise VirtualTableError("DeltaTable needs a folder path inside the source")
        with ds._open(conn_id) as c:
            database = c.list_databases()[0]
        return database, path, ""
    # FilesTable: a folder of files, read as one table (the files connector's `name/` tables)
    fmt = str(locator.get("format") or "parquet").lower()
    if fmt not in FILE_FORMATS or fmt == "avro":
        raise VirtualTableError(f"FilesTable format {fmt}: use parquet, csv or jsonl")
    path = str(locator["path"]).strip("/")
    if not path or ".." in path.split("/"):
        raise VirtualTableError("FilesTable needs a folder path inside the source")
    with ds._open(conn_id) as c:
        database = c.list_databases()[0]
    folder, _, name = path.rpartition("/")
    return database, folder or "/", name + "/"


def register(folder_id: str, name: str, source: str, locator: dict) -> dict:
    """Create (or check) the virtual table item: a created table's source and location cannot change."""
    conn = connection_id(source)
    db_, schema, table = location(conn, locator)
    existing = next((c for c in db.drive_list(folder_id) if c["name"] == name and not c.get("trashed_at")), None)
    rec = {"virtual_table": True, "connection_id": conn, "source": source, "locator": locator, "database": db_, "schema": schema, "table": table}
    if existing:
        if not is_virtual(existing):
            raise VirtualTableError(f'"{name}" already exists in the output folder and is not a virtual table')
        old = record(existing)
        if old.get("connection_id") != conn or old.get("locator") != locator:
            raise VirtualTableError(f'the virtual table "{name}" was created on {old.get("source")} at {old.get("locator")}: '
                                    "its source and location cannot be changed (use a new output path)")
        return existing
    data = json.dumps(rec, indent=1).encode()
    item = drive._store(folder_id, name, io.BytesIO(data), len(data), VT_TYPE)
    return db.drive_get(item["id"])


def _delta(c, locator: dict) -> tuple[str, dict]:
    """(table URI, deltalake storage options) of a DeltaTable locator in a filesystem or S3 source."""
    path = str(locator["path"]).strip("/")
    fs = c.fs
    if hasattr(fs, "root"):
        p = fs._path(path)
        return str(p), {}
    opts = {k: v for k, v in {
        "AWS_ACCESS_KEY_ID": c.config.get("access_key_id") or "", "AWS_SECRET_ACCESS_KEY": c.secrets.get("secret_access_key") or "",
        "AWS_SESSION_TOKEN": c.secrets.get("session_token") or "", "AWS_REGION": c.config.get("region") or "",
    }.items() if v}
    endpoint = (c.config.get("endpoint") or "").strip()
    if endpoint:
        opts["AWS_ENDPOINT_URL"] = endpoint if endpoint.startswith(("http://", "https://")) else f"https://{endpoint}"
        if opts["AWS_ENDPOINT_URL"].startswith("http://"):
            opts["AWS_ALLOW_HTTP"] = "true"
    opts.setdefault("AWS_S3_ALLOW_UNSAFE_RENAME", "true")
    return f"s3://{fs.bucket}/{fs.prefix}{path}", opts


def read(rec: dict) -> pa.Table:
    """The external table's rows (the whole table, through the connection)."""
    if (rec.get("locator") or {}).get("type") == "DeltaTable":
        from deltalake import DeltaTable

        with ds._open(rec["connection_id"], extract=True) as c:
            uri, opts = _delta(c, rec["locator"])
            return DeltaTable(uri, storage_options=opts or None).to_pyarrow_table()
    with ds._open(rec["connection_id"], extract=True) as c:
        if hasattr(c, "read_arrow"):
            return c.read_arrow(rec["database"], rec["schema"], rec["table"])
        info = c.get_table_schema(rec["database"], rec["schema"], rec["table"])
        names = [col["name"] for col in info["columns"]]
        rows: list[dict] = []
        for batch in c.stream_table(rec["database"], rec["schema"], rec["table"], names, 10_000):
            rows.extend(dict(zip(names, r)) for r in batch)
    if not rows:
        return pa.table({n: pa.array([], pa.string()) for n in names})
    return pa.Table.from_pylist(rows)


def _sql_type(c: Any, f: pa.Field) -> str:
    kind = pipeline_datasets._column_type(f.type)
    text = {"bigquery": "STRING", "databricks": "STRING", "snowflake": "VARCHAR"}.get(getattr(c.spec, "id", ""), "TEXT")
    return {"Boolean": "BOOLEAN", "Byte": "SMALLINT", "Short": "SMALLINT", "Integer": "INTEGER", "Long": "BIGINT", "Float": "REAL",
            "Double": "DOUBLE PRECISION" if text == "TEXT" else "DOUBLE", "Decimal": "DECIMAL(38, 18)", "Date": "DATE",
            "Timestamp": "TIMESTAMP"}.get(kind, text)


def write_sql(c: Any, database: str, schema: str, table: str, data: pa.Table) -> None:
    """Replace a SQL table with `data`: DROP + CREATE + INSERT in one transaction (where the database allows DDL in one)."""
    from connectors.base import SqlConnector

    if not isinstance(c, SqlConnector):
        raise VirtualTableError("this source does not take table writes")
    ref = f"{c.ident(schema)}.{c.ident(table)}"
    if c.qualify_database and database:
        ref = f"{c.ident(database)}.{ref}"
    cols = ", ".join(f"{c.ident(f.name)} {_sql_type(c, f)}" for f in data.schema)
    conn = c.conn(database or c.config.get("database") or "")
    c.begin_write(conn)
    cur = conn.cursor()
    try:
        cur.execute(f"DROP TABLE IF EXISTS {ref}")
        cur.execute(f"CREATE TABLE {ref} ({cols})")
        if data.num_rows:
            sql, _ = c.prepare(f"INSERT INTO {ref} ({', '.join(c.ident(f.name) for f in data.schema)}) VALUES ({', '.join(['%s'] * data.num_columns)})", ())
            for batch in data.to_batches(max_chunksize=5000):
                columns = [batch.column(i).to_pylist() for i in range(batch.num_columns)]
                values = [tuple(col[r] for col in columns) for r in range(batch.num_rows)]
                c.bind_rows(cur, values)
                cur.executemany(sql, values)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        raise
    finally:
        cur.close()


def write(rec: dict, data: pa.Table) -> dict:
    """Replace the external table with `data`; returns {rows, columns}."""
    from connectors.files_conn import FileConnector

    with ds._open(rec["connection_id"], extract=True, writable=True) as c:
        if (rec.get("locator") or {}).get("type") == "DeltaTable":
            from deltalake import write_deltalake

            uri, opts = _delta(c, rec["locator"])
            write_deltalake(uri, data, mode="overwrite", schema_mode="overwrite", storage_options=opts or None)
        elif hasattr(c, "write_arrow"):
            c.write_arrow(rec["schema"], rec["table"], data)
        elif isinstance(c, FileConnector):
            loc = rec["locator"]
            fmt = str(loc.get("format") or "parquet").lower()
            folder = str(loc["path"]).strip("/")
            buf = io.BytesIO()
            if fmt == "parquet":
                import pyarrow.parquet as pq

                pq.write_table(data, buf)
            elif fmt == "csv":
                import pyarrow.csv as pcsv

                pcsv.write_csv(data, buf)
            else:
                for r in data.to_pylist():
                    buf.write((json.dumps(r, default=str, ensure_ascii=False) + "\n").encode())
            c.fs.write(f"{folder}/part-00000{FILE_FORMATS[fmt]}", buf.getvalue(), "application/octet-stream")
        else:
            write_sql(c, rec["database"], rec["schema"], rec["table"], data)
    return {"rows": data.num_rows, "columns": [{"name": f.name, "type": str(f.type)} for f in data.schema]}


# --------------------------------------------------------------------------------------------
# registering a virtual table (Data Connection → a source's table → Register as virtual table)
# --------------------------------------------------------------------------------------------

from fastapi import APIRouter, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

router = APIRouter(prefix="/api/virtual-tables")


class RegisterIn(BaseModel):
    folder_id: str
    name: str = Field(min_length=1, max_length=200)
    source: str
    # {"type": "SnowflakeTable", "database": ..., "schema": ..., "table": ...} and the other locators' fields
    locator: dict


@router.post("")
def register_table(req: RegisterIn) -> dict:
    drive._item(req.folder_id, need="editor")
    try:
        item = register(req.folder_id, req.name.strip(), req.source, req.locator)
    except VirtualTableError as e:
        raise HTTPException(400, str(e)) from None
    return {**drive._public(item), "rid": f"ri.tables.main.table.{item['id']}", "virtual_table": record(item)}


@router.get("/{item_id}")
def get_table(item_id: str, preview: int = 0) -> dict:
    item = drive._item(item_id)
    if not is_virtual(item):
        raise HTTPException(404, "Not a virtual table")
    rec = record(item)
    out = {**drive._public(item), "rid": f"ri.tables.main.table.{item['id']}", "virtual_table": rec}
    if preview:
        try:
            data = read(rec)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"Reading the virtual table failed: {getattr(e, 'detail', e)}") from None
        out["preview"] = {"columns": [{"name": f.name, "type": str(f.type)} for f in data.schema], "rows": data.slice(0, max(1, min(preview, 500))).to_pylist(),
                          "row_count": data.num_rows}
    return out


@router.get("")
def list_tables() -> list[dict]:
    """Every virtual table the caller can see, with its source and location."""
    rows = db.drive_query("d.content_type = %s AND d.trashed_at IS NULL", (VT_TYPE,), limit=500)
    out = []
    for item in rows:
        try:
            drive._item(item["id"])
        except HTTPException:
            continue
        rec = record(item)
        conn = ds._rows("SELECT name, kind FROM db_connections WHERE id = %s", (rec.get("connection_id"),))
        out.append({**drive._with_path(item), "rid": f"ri.tables.main.table.{item['id']}", "virtual_table": rec,
                    "connection": {"id": rec.get("connection_id"), "name": conn[0]["name"] if conn else "(deleted)", "kind": conn[0]["kind"] if conn else None}})
    return out


def default_locator(conn_id: str, database: str, schema: str, table: str) -> dict:
    """The locator a source's table registers with (Data Connection → Virtual tables)."""
    kind = _kind(conn_id)
    if kind == "snowflake":
        return {"type": "SnowflakeTable", "database": database, "schema": schema, "table": table}
    if kind == "bigquery":
        return {"type": "BigQueryTable", "project": database, "dataset": schema, "table": table}
    if kind == "databricks":
        return {"type": "DatabricksTable", "catalog": database, "schema": schema, "table": table}
    if kind == "iceberg-rest":
        return {"type": "IcebergTable", "table": f"{schema}.{table}"}
    if kind in LOCATOR_KINDS["FilesTable"]:
        folder = table.rstrip("/")
        path = folder if schema in ("", "/") else f"{schema.strip('/')}/{folder}"
        ext = folder.rsplit(".", 1)[-1].lower() if "." in folder else "parquet"
        return {"type": "FilesTable", "path": path, "format": {"csv": "csv", "jsonl": "jsonl", "json": "jsonl"}.get(ext, "parquet")}
    raise VirtualTableError(f"{kind} sources do not hold virtual tables (Snowflake, BigQuery, Databricks, Iceberg catalogs, S3 and filesystem sources do)")


class RegisterTableIn(BaseModel):
    folder_id: str
    name: str = Field(min_length=1, max_length=200)
    connection_id: str
    database: str
    schema_: str = Field(alias="schema")
    table: str

    model_config = {"populate_by_name": True}


@router.post("/from-source")
def register_from_source(req: RegisterTableIn) -> dict:
    """Register a source's table as a virtual table (its locator from the source's type)."""
    drive._item(req.folder_id, need="editor")
    try:
        loc = default_locator(req.connection_id, req.database, req.schema_, req.table)
        item = register(req.folder_id, req.name.strip(), req.connection_id, loc)
    except VirtualTableError as e:
        raise HTTPException(400, str(e)) from None
    return {**drive._public(item), "rid": f"ri.tables.main.table.{item['id']}", "virtual_table": record(item)}
