"""Reading raw files as a dataset, following Palantir's Dataset Preview docs ("CSV parsing"), plus the table operations
Dataset Preview runs on any dataset version. No Files / web dependencies: dataset_preview.py feeds it bytes.

Schema (stored per dataset, as Foundry's):
    {"fieldSchemaList": [{"type": "INTEGER", "name": "a", "nullable": null, "customMetadata": {}, ...}],
     "dataFrameReaderClass": "com.palantir.foundry.spark.input.TextDataFrameReader",
     "customMetadata": {"textParserParams": {...}}}
- TextDataFrameReader: parser (CSV_PARSER: quotes may not span records; MULTILINE_CSV_PARSER: they may; SIMPLE_PARSER:
  no quoting; SINGLE_COLUMN_PARSER: one field per record), nullValues, fieldDelimiter, recordDelimiter, quoteCharacter,
  dateFormat ({column: JodaTime pattern}), skipLines (per file), jaggedRowBehavior (THROW_EXCEPTION | DROP_ROW),
  parseErrorBehavior (THROW_EXCEPTION | REPLACE_WITH_NULL), charsetName, addFilePath / addFilePathInsteadOfUri,
  addImportedAt, addByteOffset, addRowNumber (extra columns _file_path, _import_timestamp, _byte_offset, _row_number),
  initialReadTimeout (accepted).
- DataSourceDataFrameReader with customMetadata {"format": "csv" | "json" | "parquet", "options": {...}}: Spark's CSV
  options header, sep / delimiter, quote, escape, multiLine, mode (PERMISSIVE: short rows padded with nulls, long rows
  cut, bad values null — the FAQ's standardized schema over CSVs with more columns; DROPMALFORMED; FAILFAST), nullValue,
  encoding / charset, ignoreLeadingWhiteSpace, ignoreTrailingWhiteSpace, comment, dateFormat / timestampFormat,
  unescapedQuoteHandling (accepted); JSON lines (multiLine: one JSON array or document per file); Parquet with
  mergeSchema.
- ParquetDataFrameReader: Parquet files (mergeSchema unions their columns).
Types: STRING, BOOLEAN, BYTE, SHORT, INTEGER, LONG, FLOAT, DOUBLE, DECIMAL (precision, scale), DATE, TIMESTAMP.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Optional

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

TEXT_READER = "com.palantir.foundry.spark.input.TextDataFrameReader"
SOURCE_READER = "com.palantir.foundry.spark.input.DataSourceDataFrameReader"
PARQUET_READER = "com.palantir.foundry.spark.input.ParquetDataFrameReader"
READERS = (TEXT_READER, SOURCE_READER, PARQUET_READER)
PARSERS = ("CSV_PARSER", "MULTILINE_CSV_PARSER", "SIMPLE_PARSER", "SINGLE_COLUMN_PARSER")
TYPES = ("STRING", "BOOLEAN", "BYTE", "SHORT", "INTEGER", "LONG", "FLOAT", "DOUBLE", "DECIMAL", "DATE", "TIMESTAMP")
EXTRA_COLUMNS = {"addFilePath": "_file_path", "addImportedAt": "_import_timestamp", "addByteOffset": "_byte_offset", "addRowNumber": "_row_number"}
MAX_ERRORS = 50
INT_RANGE = {"BYTE": 2**7, "SHORT": 2**15, "INTEGER": 2**31, "LONG": 2**63}


class ParseError(ValueError):
    """A dataset that does not parse with its schema (THROW_EXCEPTION / FAILFAST); `errors` holds where."""

    def __init__(self, message: str, errors: Optional[list[dict]] = None) -> None:
        super().__init__(message)
        self.errors = errors or []


def default_text_params(**over: Any) -> dict:
    p = {"parser": "CSV_PARSER", "charsetName": "UTF-8", "fieldDelimiter": ",", "recordDelimiter": "\n", "quoteCharacter": '"',
         "dateFormat": {}, "skipLines": 1, "jaggedRowBehavior": "THROW_EXCEPTION", "parseErrorBehavior": "THROW_EXCEPTION",
         "addFilePath": False, "addFilePathInsteadOfUri": False, "addImportedAt": False, "addByteOffset": False, "addRowNumber": False,
         "initialReadTimeout": "1 hour", "nullValues": [""]}
    p.update(over)
    return p


def field(name: str, ftype: str = "STRING", **extra: Any) -> dict:
    return {"type": ftype, "name": name, "nullable": None, "userDefinedTypeClass": None, "customMetadata": {}, "arraySubtype": None,
            "precision": extra.get("precision"), "scale": extra.get("scale"), "mapKeyType": None, "mapValueType": None, "subSchemas": None}


def text_schema(fields: list[dict], **params: Any) -> dict:
    return {"fieldSchemaList": fields, "dataFrameReaderClass": TEXT_READER, "customMetadata": {"textParserParams": default_text_params(**params)}}


def check_schema(schema: dict) -> list[str]:
    """What is wrong with a schema's shape (not with the data)."""
    out = []
    if not isinstance(schema, dict):
        return ["the schema must be a JSON object"]
    reader = schema.get("dataFrameReaderClass")
    if reader not in READERS:
        out.append(f"dataFrameReaderClass must be one of {', '.join(READERS)}")
    fields = schema.get("fieldSchemaList")
    if not isinstance(fields, list):
        out.append("fieldSchemaList must be a list")
        fields = []
    names = set()
    for i, f in enumerate(fields):
        if not isinstance(f, dict) or not str(f.get("name") or "").strip():
            out.append(f"fieldSchemaList[{i}] needs a name")
            continue
        if f.get("type") not in TYPES:
            out.append(f"{f['name']}: type {f.get('type')!r} is not one of {', '.join(TYPES)}")
        if f["name"].lower() in names:
            out.append(f"{f['name']}: repeated column name")
        names.add(f["name"].lower())
    meta = schema.get("customMetadata") or {}
    if reader == TEXT_READER:
        p = meta.get("textParserParams") or {}
        if p.get("parser", "CSV_PARSER") not in PARSERS:
            out.append(f"textParserParams.parser must be one of {', '.join(PARSERS)}")
        for k in ("fieldDelimiter", "quoteCharacter"):
            if k in p and p[k] is not None and len(str(p[k])) != 1:
                out.append(f"textParserParams.{k} must be one character")
        if p.get("jaggedRowBehavior", "THROW_EXCEPTION") not in ("THROW_EXCEPTION", "DROP_ROW"):
            out.append("jaggedRowBehavior must be THROW_EXCEPTION or DROP_ROW")
        if p.get("parseErrorBehavior", "THROW_EXCEPTION") not in ("THROW_EXCEPTION", "REPLACE_WITH_NULL"):
            out.append("parseErrorBehavior must be THROW_EXCEPTION or REPLACE_WITH_NULL")
        if not isinstance(p.get("skipLines", 0), int) or p.get("skipLines", 0) < 0:
            out.append("skipLines must be a non-negative number")
    elif reader == SOURCE_READER:
        if meta.get("format") not in ("csv", "json", "parquet"):
            out.append('customMetadata.format must be "csv", "json" or "parquet"')
        mode = str((meta.get("options") or {}).get("mode", "PERMISSIVE")).upper()
        if mode not in ("PERMISSIVE", "DROPMALFORMED", "FAILFAST"):
            out.append("options.mode must be PERMISSIVE, DROPMALFORMED or FAILFAST")
    return out


# ------------------------------------------------------------------------------------------------
# values
# ------------------------------------------------------------------------------------------------

_JODA = [("yyyy", "%Y"), ("YYYY", "%Y"), ("yy", "%y"), ("MMMM", "%B"), ("MMM", "%b"), ("MM", "%m"), ("M", "%m"), ("dd", "%d"), ("d", "%d"),
         ("HH", "%H"), ("H", "%H"), ("hh", "%I"), ("h", "%I"), ("mm", "%M"), ("m", "%M"), ("ss", "%S"), ("s", "%S"), ("SSSSSS", "%f"),
         ("SSS", "%f"), ("EEEE", "%A"), ("EEE", "%a"), ("a", "%p"), ("ZZ", "%z"), ("Z", "%z"), ("XXX", "%z"), ("X", "%z"), ("z", "%Z")]


def joda_to_strptime(pattern: str) -> str:
    """A JodaTime / Java DateTimeFormatter pattern (yyyy-MM-dd'T'HH:mm:ss) as a strptime format."""
    out, i = [], 0
    while i < len(pattern):
        if pattern[i] == "'":
            j = pattern.find("'", i + 1)
            j = len(pattern) if j < 0 else j
            out.append(pattern[i + 1 : j].replace("%", "%%") or "'")
            i = j + 1
            continue
        for tok, rep in _JODA:
            if pattern.startswith(tok, i):
                out.append(rep)
                i += len(tok)
                break
        else:
            out.append("%%" if pattern[i] == "%" else pattern[i])
            i += 1
    return "".join(out)


_TRUE = {"true", "t", "yes", "y", "1"}
_FALSE = {"false", "f", "no", "n", "0"}


def convert(text: str, f: dict, fmt: Optional[str]) -> Any:
    """A field's text as its type; ValueError when it does not parse."""
    t = f.get("type", "STRING")
    if t == "STRING":
        return text
    s = text.strip()
    if t in INT_RANGE:
        if not re.fullmatch(r"[+-]?\d+", s):
            # "3.0" is an integer in many exports
            if re.fullmatch(r"[+-]?\d+\.0+", s):
                s = s.split(".")[0]
            else:
                raise ValueError(f"{text!r} is not an integer")
        v = int(s)
        if not -INT_RANGE[t] <= v < INT_RANGE[t]:
            raise ValueError(f"{text!r} is out of range for {t}")
        return v
    if t in ("DOUBLE", "FLOAT"):
        try:
            v = float(s.replace(",", "")) if re.fullmatch(r"[+-]?[\d,]*\.?\d+(e[+-]?\d+)?", s, re.I) else float(s)
        except ValueError:
            raise ValueError(f"{text!r} is not a number") from None
        return v
    if t == "DECIMAL":
        try:
            d = Decimal(s)
        except InvalidOperation:
            raise ValueError(f"{text!r} is not a decimal") from None
        scale = f.get("scale")
        return d.quantize(Decimal(1).scaleb(-int(scale))) if scale is not None else d
    if t == "BOOLEAN":
        low = s.lower()
        if low in _TRUE:
            return True
        if low in _FALSE:
            return False
        raise ValueError(f"{text!r} is not a boolean")
    if t == "DATE":
        if fmt:
            return datetime.strptime(s, joda_to_strptime(fmt)).date()
        return date.fromisoformat(s[:10])
    if t == "TIMESTAMP":
        if fmt:
            d = datetime.strptime(s, joda_to_strptime(fmt))
        else:
            d = datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T", 1) if "T" not in s and " " in s else s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    raise ValueError(f"unknown type {t}")


def arrow_type(f: dict) -> pa.DataType:
    t = f.get("type")
    return {"STRING": pa.string(), "BOOLEAN": pa.bool_(), "BYTE": pa.int8(), "SHORT": pa.int16(), "INTEGER": pa.int32(), "LONG": pa.int64(),
            "FLOAT": pa.float32(), "DOUBLE": pa.float64(), "DATE": pa.date32(), "TIMESTAMP": pa.timestamp("us", tz="UTC")}.get(
        t, pa.decimal128(int(f.get("precision") or 38), int(f.get("scale") or 0)) if t == "DECIMAL" else pa.string())


def foundry_type(t: pa.DataType) -> str:
    if pa.types.is_boolean(t):
        return "BOOLEAN"
    if pa.types.is_int8(t):
        return "BYTE"
    if pa.types.is_int16(t):
        return "SHORT"
    if pa.types.is_int32(t) or pa.types.is_uint8(t) or pa.types.is_uint16(t):
        return "INTEGER"
    if pa.types.is_integer(t):
        return "LONG"
    if pa.types.is_float32(t):
        return "FLOAT"
    if pa.types.is_floating(t):
        return "DOUBLE"
    if pa.types.is_decimal(t):
        return "DECIMAL"
    if pa.types.is_date(t):
        return "DATE"
    if pa.types.is_timestamp(t):
        return "TIMESTAMP"
    return "STRING"


def schema_of_table(table: pa.Table, reader: str = PARQUET_READER) -> dict:
    fields = []
    for f in table.schema:
        x = field(f.name, foundry_type(f.type), precision=getattr(f.type, "precision", None), scale=getattr(f.type, "scale", None))
        md = f.metadata or {}
        if b"description" in md:
            x["customMetadata"]["description"] = md[b"description"].decode("utf-8", "replace")
        fields.append(x)
    return {"fieldSchemaList": fields, "dataFrameReaderClass": reader, "customMetadata": {}}


# ------------------------------------------------------------------------------------------------
# splitting text into records and fields
# ------------------------------------------------------------------------------------------------


def _records(text: str, parser: str, delim: str, quote: str, record_delim: str, escape: Optional[str] = None,
             comment: Optional[str] = None) -> Iterable[tuple[int, list[str]]]:
    """(byte offset of the record, fields) for every record of a file."""
    if parser == "MULTILINE_CSV_PARSER":
        offsets = _line_offsets(text)
        buf = io.StringIO(text, newline="")
        reader = csv.reader(buf, delimiter=delim, quotechar=quote or None, escapechar=escape, doublequote=escape is None,
                            quoting=csv.QUOTE_MINIMAL if quote else csv.QUOTE_NONE, strict=False)
        line_no = 0
        for rec in reader:
            start = offsets[min(line_no, len(offsets) - 1)] if offsets else 0
            line_no = reader.line_num
            if comment and rec and rec[0].startswith(comment):
                continue
            yield start, rec
        return
    rd = record_delim or "\n"
    pos = 0
    for raw in text.split(rd):
        start = pos
        pos += len(raw) + len(rd)
        line = raw[:-1] if rd == "\n" and raw.endswith("\r") else raw
        if comment and line.startswith(comment):
            continue
        if parser == "SINGLE_COLUMN_PARSER":
            yield start, [line]
        elif parser == "SIMPLE_PARSER":
            yield start, line.split(delim)
        else:
            row = next(csv.reader([line], delimiter=delim, quotechar=quote or None, escapechar=escape, doublequote=escape is None,
                                  quoting=csv.QUOTE_MINIMAL if quote else csv.QUOTE_NONE, strict=False), [])
            yield start, row if line else []


def _line_offsets(text: str) -> list[int]:
    out, pos = [0], 0
    for line in text.splitlines(keepends=True):
        pos += len(line)
        out.append(pos)
    return out


def _decode(data: bytes, charset: str) -> str:
    try:
        return data.decode(charset or "utf-8")
    except (LookupError, UnicodeDecodeError):
        return data.decode("utf-8", "replace")


# ------------------------------------------------------------------------------------------------
# reading
# ------------------------------------------------------------------------------------------------


def read(files: list[tuple[str, bytes]], schema: dict, imported_at: Optional[datetime] = None, strict: bool = True,
         dataset_uri: str = "") -> tuple[pa.Table, list[dict]]:
    """The files as one table with the schema. Returns (table, problems): with strict, a THROW_EXCEPTION / FAILFAST
    problem raises ParseError instead; otherwise every problem is reported (validation) and the row is skipped."""
    reader = schema.get("dataFrameReaderClass") or TEXT_READER
    meta = schema.get("customMetadata") or {}
    if reader == PARQUET_READER or (reader == SOURCE_READER and meta.get("format") == "parquet"):
        return _read_parquet(files, schema, bool((meta.get("options") or {}).get("mergeSchema") or meta.get("mergeSchema"))), []
    if reader == SOURCE_READER and meta.get("format") == "json":
        return _read_json(files, schema, meta.get("options") or {}, strict)
    fields = list(schema.get("fieldSchemaList") or [])
    if reader == SOURCE_READER:
        o = {str(k).lower(): v for k, v in (meta.get("options") or {}).items()}
        header = str(o.get("header", "false")).lower() == "true"
        mode = str(o.get("mode", "PERMISSIVE")).upper()
        params = {"parser": "MULTILINE_CSV_PARSER" if str(o.get("multiline", "false")).lower() == "true" else "CSV_PARSER",
                  "fieldDelimiter": o.get("sep", o.get("delimiter", ",")), "quoteCharacter": o.get("quote", '"'),
                  "escape": o.get("escape"),
                  "charsetName": o.get("encoding", o.get("charset", "UTF-8")), "skipLines": 1 if header else 0,
                  "nullValues": [o.get("nullvalue", "")], "comment": o.get("comment"),
                  "jaggedRowBehavior": {"PERMISSIVE": "PAD", "DROPMALFORMED": "DROP_ROW", "FAILFAST": "THROW_EXCEPTION"}[mode],
                  "parseErrorBehavior": {"PERMISSIVE": "REPLACE_WITH_NULL", "DROPMALFORMED": "DROP_ROW", "FAILFAST": "THROW_EXCEPTION"}[mode],
                  "trimLeft": str(o.get("ignoreleadingwhitespace", "false")).lower() == "true",
                  "trimRight": str(o.get("ignoretrailingwhitespace", "false")).lower() == "true",
                  "dateFormat": {f["name"]: o["timestampformat" if f.get("type") == "TIMESTAMP" else "dateformat"]
                                 for f in fields if (f.get("type") == "TIMESTAMP" and o.get("timestampformat")) or (f.get("type") == "DATE" and o.get("dateformat"))},
                  "header": header}
        if not fields:
            # no schema: names from the header (or _c0, _c1, ...), every column a string
            first = files[0] if files else None
            rows = list(_records(_decode(first[1], params["charsetName"]), params["parser"], params["fieldDelimiter"], params["quoteCharacter"], "\n")) if first else []
            names = rows[0][1] if header and rows else [f"_c{i}" for i in range(len(rows[0][1]) if rows else 0)]
            fields = [field(n) for n in names]
    else:
        params = {**default_text_params(skipLines=0), **(meta.get("textParserParams") or {})}
    return _read_text(files, fields, params, imported_at, strict, dataset_uri)


def _read_text(files, fields, p, imported_at, strict, dataset_uri) -> tuple[pa.Table, list[dict]]:
    parser = p.get("parser") or "CSV_PARSER"
    delim = (p.get("fieldDelimiter") or ",")[:1]
    quote = p.get("quoteCharacter")
    quote = quote[:1] if quote else None
    nulls = set(p.get("nullValues") if p.get("nullValues") is not None else [""])
    formats = p.get("dateFormat") or {}
    jagged = p.get("jaggedRowBehavior") or "THROW_EXCEPTION"
    bad = p.get("parseErrorBehavior") or "THROW_EXCEPTION"
    skip = int(p.get("skipLines") or 0)
    extras = [c for k, c in EXTRA_COLUMNS.items() if p.get(k)]
    imported = (imported_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cols: list[list[Any]] = [[] for _ in fields]
    extra_cols: dict[str, list[Any]] = {c: [] for c in extras}
    problems: list[dict] = []
    n = len(fields)

    def fail(file: str, row: int, msg: str, behavior: str) -> None:
        problems.append({"file": file, "row": row, "error": msg})
        if strict and behavior in ("THROW_EXCEPTION",):
            raise ParseError(f"{file}, row {row}: {msg}", problems[:MAX_ERRORS])

    for name, data in files:
        text = _decode(data, p.get("charsetName") or "UTF-8")
        if text.startswith("﻿"):
            text = text[1:]
        row_no = 0
        for i, (offset, rec) in enumerate(_records(text, parser, delim, quote, p.get("recordDelimiter") or "\n", p.get("escape"), p.get("comment"))):
            if i < skip:
                continue
            if not rec or rec == [""] and n != 1:
                continue  # blank line (or the end of the file)
            row_no += 1
            if p.get("trimLeft") or p.get("trimRight"):
                rec = [v.lstrip() if p.get("trimLeft") else v for v in rec]
                rec = [v.rstrip() if p.get("trimRight") else v for v in rec]
            if len(rec) != n and parser != "SINGLE_COLUMN_PARSER":
                if jagged == "PAD":
                    rec = (rec + [None] * n)[:n]
                else:
                    fail(name, row_no, f"has {len(rec)} fields, the schema has {n} columns", jagged)
                    continue
            values, ok = [], True
            for j, f in enumerate(fields):
                v = rec[j] if j < len(rec) else None
                if v is None or v in nulls:
                    values.append(None)
                    continue
                try:
                    values.append(convert(v, f, formats.get(f["name"])))
                except (ValueError, TypeError) as e:
                    if bad == "REPLACE_WITH_NULL":
                        values.append(None)
                    else:
                        ok = False
                        fail(name, row_no, f"{f['name']}: {e}", bad)
                        break
            if not ok:
                continue
            for j, v in enumerate(values):
                cols[j].append(v)
            for c in extras:
                extra_cols[c].append({"_file_path": name if p.get("addFilePathInsteadOfUri") or not dataset_uri else f"{dataset_uri.rstrip('/')}/{name}",
                                      "_import_timestamp": imported, "_byte_offset": len(text[:offset].encode("utf-8")), "_row_number": row_no}[c])
    arrays = [pa.array(c, type=arrow_type(f)) for c, f in zip(cols, fields)]
    names = [f["name"] for f in fields]
    for c in extras:
        names.append(c)
        arrays.append(pa.array(extra_cols[c], type={"_file_path": pa.string(), "_import_timestamp": pa.timestamp("us", tz="UTC"),
                                                     "_byte_offset": pa.int64(), "_row_number": pa.int64()}[c]))
    return pa.Table.from_arrays(arrays, names=names) if names else pa.table({}), problems


def _read_json(files, schema, options, strict) -> tuple[pa.Table, list[dict]]:
    fields = list(schema.get("fieldSchemaList") or [])
    multi = str(options.get("multiLine", options.get("multiline", "false"))).lower() == "true"
    records, problems = [], []
    for name, data in files:
        text = _decode(data, "utf-8")
        docs: list[Any] = []
        if multi:
            try:
                d = json.loads(text)
                docs = d if isinstance(d, list) else [d]
            except json.JSONDecodeError as e:
                problems.append({"file": name, "row": 1, "error": str(e)})
        else:
            for i, line in enumerate(text.splitlines(), 1):
                if not line.strip():
                    continue
                try:
                    docs.append(json.loads(line))
                except json.JSONDecodeError as e:
                    problems.append({"file": name, "row": i, "error": str(e)})
        records += [d for d in docs if isinstance(d, dict)]
    if problems and strict and str(options.get("mode", "PERMISSIVE")).upper() == "FAILFAST":
        raise ParseError(f"{problems[0]['file']}, row {problems[0]['row']}: {problems[0]['error']}", problems)
    if not fields:
        names: list[str] = []
        for r in records:
            names += [k for k in r if k not in names]
        fields = [field(k) for k in names]
    cols = []
    for f in fields:
        vals = []
        for r in records:
            v = r.get(f["name"])
            if v is None:
                vals.append(None)
                continue
            try:
                vals.append(convert(json.dumps(v) if isinstance(v, (dict, list)) else str(v).lower() if isinstance(v, bool) else str(v), f, None))
            except ValueError:
                vals.append(None)
        cols.append(pa.array(vals, type=arrow_type(f)))
    return pa.Table.from_arrays(cols, names=[f["name"] for f in fields]) if fields else pa.table({}), problems


def _read_parquet(files, schema, merge: bool) -> pa.Table:
    tables = [pq.read_table(io.BytesIO(d)) for _, d in files]
    if not tables:
        fields = schema.get("fieldSchemaList") or []
        return pa.Table.from_arrays([pa.array([], type=arrow_type(f)) for f in fields], names=[f["name"] for f in fields]) if fields else pa.table({})
    if merge:
        return pa.concat_tables(tables, promote_options="default")
    first = tables[0].schema
    for (name, _), t in zip(files[1:], tables[1:]):
        if not t.schema.equals(first, check_metadata=False):
            raise ParseError(f"{name} has a different schema; set mergeSchema to combine Parquet files with different columns")
    return pa.concat_tables(tables)


# ------------------------------------------------------------------------------------------------
# inference
# ------------------------------------------------------------------------------------------------


def _guess_type(values: list[str]) -> str:
    vals = [v for v in values if v not in ("", None)]
    if not vals:
        return "STRING"
    for t in ("BOOLEAN", "INTEGER", "LONG", "DOUBLE", "DATE", "TIMESTAMP"):
        f = field("x", t)
        try:
            for v in vals:
                if t == "BOOLEAN" and v.strip().lower() not in ("true", "false"):
                    raise ValueError
                if t in ("DATE",) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v.strip()):
                    raise ValueError
                if t == "TIMESTAMP" and not re.match(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", v.strip()):
                    raise ValueError
                if t == "DOUBLE" and not re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", v.strip()):
                    raise ValueError
                convert(v, f, None)
            return t
        except (ValueError, TypeError):
            continue
    return "STRING"


def sniff(sample: str) -> dict:
    """Delimiter, quote character and whether the first row is a header."""
    try:
        d = csv.Sniffer().sniff(sample[:20000], delimiters=",;\t|")
        delim, quote = d.delimiter, d.quotechar or '"'
    except csv.Error:
        delim, quote = ("\t" if sample.count("\t") > sample.count(",") else ","), '"'
    try:
        header = csv.Sniffer().has_header(sample[:20000])
    except csv.Error:
        header = True
    return {"fieldDelimiter": delim, "quoteCharacter": quote, "header": header}


def infer(files: list[tuple[str, bytes]], options: Optional[dict] = None, sample_rows: int = 1000) -> dict:
    """A TextDataFrameReader schema for CSV / TSV files (or a DataSourceDataFrameReader json / parquet one): delimiter,
    quote and header sniffed from the first file unless given in `options` (textParserParams), column names from the
    header (column_N when there is none), types from up to `sample_rows` rows of every file."""
    options = dict(options or {})
    if not files:
        return text_schema([], **options)
    first_name, first = files[0]
    low = first_name.lower()
    if low.endswith(".parquet"):
        return {**schema_of_table(pq.read_table(io.BytesIO(first))), "dataFrameReaderClass": PARQUET_READER,
                "customMetadata": {"mergeSchema": len(files) > 1}}
    if low.endswith((".json", ".jsonl", ".ndjson")):
        text = _decode(first, "utf-8").lstrip()
        multi = text.startswith("[")
        t, _ = _read_json(files[:5], {"fieldSchemaList": []}, {"multiLine": multi}, False)
        fields = []
        for c in t.column_names:
            fields.append(field(c, _guess_type([v for v in t.column(c).to_pylist()[:sample_rows] if v is not None])))
        return {"fieldSchemaList": fields, "dataFrameReaderClass": SOURCE_READER, "customMetadata": {"format": "json", "options": {"multiLine": multi}}}
    text = _decode(first, options.get("charsetName") or "UTF-8").lstrip("﻿")
    guess = sniff(text)
    if low.endswith(".tsv") and "fieldDelimiter" not in options:
        guess["fieldDelimiter"] = "\t"
    params = default_text_params(fieldDelimiter=options.get("fieldDelimiter", guess["fieldDelimiter"]),
                                 quoteCharacter=options.get("quoteCharacter", guess["quoteCharacter"]),
                                 skipLines=options.get("skipLines", 1 if guess["header"] else 0))
    params.update({k: v for k, v in options.items() if k in default_text_params()})
    multiline = any(_open_quote(line, params["quoteCharacter"]) for line in text.splitlines()[:5000])
    if multiline and "parser" not in options:
        params["parser"] = "MULTILINE_CSV_PARSER"
    recs = list(_records(text, params["parser"], params["fieldDelimiter"], params["quoteCharacter"], params["recordDelimiter"]))
    recs = [r for _, r in recs if r and r != [""]]
    header = recs[0] if params["skipLines"] >= 1 and recs else None
    width = max((len(r) for r in recs[:sample_rows + 1]), default=0)
    names = [(header[i].strip() if header and i < len(header) and header[i].strip() else f"column_{i + 1}") for i in range(width)]
    seen: dict[str, int] = {}
    for i, nme in enumerate(names):
        k = nme.lower()
        seen[k] = seen.get(k, 0) + 1
        if seen[k] > 1:
            names[i] = f"{nme}_{seen[k]}"
    samples: list[list[str]] = [[] for _ in names]
    for _, data in files:
        t = _decode(data, params["charsetName"]).lstrip("﻿")
        rows = [r for _, r in _records(t, params["parser"], params["fieldDelimiter"], params["quoteCharacter"], params["recordDelimiter"]) if r and r != [""]]
        for r in rows[params["skipLines"] : params["skipLines"] + sample_rows]:
            for i, v in enumerate(r[: len(names)]):
                samples[i].append(v)
    fields = [field(n, _guess_type(s)) for n, s in zip(names, samples)]
    return text_schema(fields, **{k: v for k, v in params.items()})


def _open_quote(line: str, quote: Optional[str]) -> bool:
    return bool(quote) and line.count(quote) % 2 == 1


def validate(files: list[tuple[str, bytes]], schema: dict) -> dict:
    """Parse every file with the schema: {ok, rows, failed_rows, errors (first 50), problems (schema shape)}."""
    shape = check_schema(schema)
    if shape:
        return {"ok": False, "rows": 0, "failed_rows": 0, "errors": [], "problems": shape}
    try:
        t, problems = read(files, schema, strict=False)
    except ParseError as e:
        return {"ok": False, "rows": 0, "failed_rows": len(e.errors) or 1, "errors": e.errors[:MAX_ERRORS] or [{"error": str(e)}], "problems": []}
    except Exception as e:  # noqa: BLE001 - unreadable files
        return {"ok": False, "rows": 0, "failed_rows": 0, "errors": [{"error": str(e)}], "problems": []}
    reader = schema.get("dataFrameReaderClass")
    p = (schema.get("customMetadata") or {}).get("textParserParams") or {}
    # problems that DROP_ROW / REPLACE_WITH_NULL settle are reported but do not fail validation
    lenient = reader == SOURCE_READER and str(((schema.get("customMetadata") or {}).get("options") or {}).get("mode", "PERMISSIVE")).upper() != "FAILFAST"
    blocking = [] if lenient else [x for x in problems if not (
        ("fields, the schema has" in x["error"] and p.get("jaggedRowBehavior") == "DROP_ROW"))]
    return {"ok": not blocking, "rows": t.num_rows, "failed_rows": len(blocking), "dropped_rows": len(problems) - len(blocking),
            "errors": problems[:MAX_ERRORS], "problems": []}


# ------------------------------------------------------------------------------------------------
# queries over a table: filters, sort, SQL, statistics
# ------------------------------------------------------------------------------------------------

OPS = ("eq", "neq", "in", "not_in", "contains", "not_contains", "gt", "gte", "lt", "lte", "is_null", "not_null")


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _where(table: pa.Table, filters: list[dict]) -> tuple[str, list[Any]]:
    parts, args = [], []
    names = set(table.column_names)
    for f in filters or []:
        col, op, val = f.get("column"), f.get("op", "eq"), f.get("value")
        if col not in names:
            raise ValueError(f"unknown column {col}")
        if op not in OPS:
            raise ValueError(f"unknown filter {op}")
        c = _q(col)
        if op == "is_null":
            parts.append(f"{c} IS NULL")
        elif op == "not_null":
            parts.append(f"{c} IS NOT NULL")
        elif op in ("in", "not_in"):
            vals = val if isinstance(val, list) else [val]
            if not vals:
                parts.append("FALSE" if op == "in" else "TRUE")
                continue
            has_null = any(v is None for v in vals)
            vals = [v for v in vals if v is not None]
            inner = f"CAST({c} AS VARCHAR) IN ({', '.join('?' for _ in vals)})" if vals else "FALSE"
            args += [str(v) if not isinstance(v, bool) else str(v).lower() for v in vals]
            if has_null:
                inner = f"({inner} OR {c} IS NULL)"
            parts.append(inner if op == "in" else f"NOT COALESCE({inner}, FALSE)" + ("" if has_null else f" OR {c} IS NULL"))
        elif op in ("contains", "not_contains"):
            parts.append(f"{'NOT ' if op == 'not_contains' else ''}COALESCE(contains(lower(CAST({c} AS VARCHAR)), lower(?)), FALSE)")
            args.append(str(val))
        else:
            sym = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            t = table.schema.field(col).type
            if pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t):
                parts.append(f"{c} {sym} CAST(? AS DOUBLE)")
            elif pa.types.is_boolean(t):
                parts.append(f"{c} {sym} CAST(? AS BOOLEAN)")
            else:
                parts.append(f"CAST({c} AS VARCHAR) {sym} ?")
            args.append(str(val).lower() if isinstance(val, bool) else str(val))
    return (" AND ".join(f"({p})" for p in parts) or "TRUE"), args


def _con(table: pa.Table):
    import duckdb

    con = duckdb.connect()
    con.register("dataset", table)
    return con


def query_rows(table: pa.Table, filters: Optional[list[dict]] = None, sort: Optional[list[dict]] = None, offset: int = 0,
               limit: int = 100) -> dict:
    """Rows of the table that pass the filters, sorted, as JSON-ready dicts; total = matching rows."""
    where, args = _where(table, filters or [])
    order = ", ".join(f"{_q(s['column'])} {'DESC' if s.get('desc') else 'ASC'} NULLS LAST" for s in sort or [] if s.get("column") in table.column_names)
    con = _con(table)
    total = con.execute(f"SELECT COUNT(*) FROM dataset WHERE {where}", args).fetchone()[0]
    out = con.execute(f"SELECT * FROM dataset WHERE {where}{f' ORDER BY {order}' if order else ''} LIMIT {int(limit)} OFFSET {int(offset)}", args).arrow()
    return {"total": total, "rows": json_rows(out.read_all() if hasattr(out, "read_all") else out)}


def run_sql(table: pa.Table, sql: str, limit: int = 1000) -> dict:
    """A read-only SQL query over the table, which is named `dataset` (e.g. SELECT city, COUNT(*) FROM dataset GROUP BY 1)."""
    text = sql.strip().rstrip(";")
    if not re.match(r"(?is)^\s*(select|with)\b", text) or ";" in text:
        raise ValueError("only one SELECT (or WITH … SELECT) statement over `dataset` can run here")
    if re.search(r"(?i)\b(read_csv|read_parquet|read_json|copy|attach|install|load|pragma|export|import)\b", text):
        raise ValueError("only the dataset can be read")
    con = _con(table)
    res = con.execute(f"SELECT * FROM ({text}) AS q LIMIT {int(limit) + 1}").arrow()
    res = res.read_all() if hasattr(res, "read_all") else res
    rows = json_rows(res)
    return {"columns": [{"name": f.name, "type": foundry_type(f.type)} for f in res.schema], "rows": rows[:limit], "truncated": len(rows) > limit}


def _json(v: Any) -> Any:
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, bytes):
        return v.hex()
    if isinstance(v, (list, dict)):
        return json.loads(json.dumps(v, default=str))
    return v


def json_rows(table: pa.Table) -> list[dict]:
    return [{k: _json(v) for k, v in r.items()} for r in table.to_pylist()]


def column_stats(table: pa.Table, top: int = 5) -> list[dict]:
    """Per column: type, null %, distinct count, the most common values and min / max / mean for numbers and dates."""
    con = _con(table)
    n = table.num_rows
    out = []
    for f in table.schema:
        c = _q(f.name)
        nulls, distinct = con.execute(f"SELECT COUNT(*) - COUNT({c}), approx_count_distinct({c}) FROM dataset").fetchone()
        s: dict[str, Any] = {"name": f.name, "type": foundry_type(f.type), "nulls": nulls, "null_pct": round(100 * nulls / n, 2) if n else 0.0,
                             "distinct": distinct}
        md = f.metadata or {}
        if b"description" in md:
            s["description"] = md[b"description"].decode("utf-8", "replace")
        if pa.types.is_integer(f.type) or pa.types.is_floating(f.type) or pa.types.is_decimal(f.type):
            lo, hi, mean = con.execute(f"SELECT MIN({c}), MAX({c}), AVG(CAST({c} AS DOUBLE)) FROM dataset").fetchone()
            s.update(min=_json(lo), max=_json(hi), mean=_json(mean))
        elif pa.types.is_temporal(f.type):
            lo, hi = con.execute(f"SELECT MIN({c}), MAX({c}) FROM dataset").fetchone()
            s.update(min=_json(lo), max=_json(hi))
        s["top"] = [{"value": _json(v), "count": k} for v, k in con.execute(
            f"SELECT {c}, COUNT(*) AS k FROM dataset WHERE {c} IS NOT NULL GROUP BY 1 ORDER BY k DESC, 1 LIMIT {int(top)}").fetchall()]
        out.append(s)
    return out


def chart(table: pa.Table, column: str, bins: int = 20, filters: Optional[list[dict]] = None) -> dict:
    """A histogram (numbers, dates) or the most common values (anything else) of a column, after the filters."""
    if column not in table.column_names:
        raise ValueError(f"unknown column {column}")
    where, args = _where(table, filters or [])
    con = _con(table)
    t = table.schema.field(column).type
    c = _q(column)
    numeric = pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t)
    if numeric or pa.types.is_temporal(t):
        expr = f"CAST({c} AS DOUBLE)" if numeric else f"epoch({c})"
        lo, hi = con.execute(f"SELECT MIN({expr}), MAX({expr}) FROM dataset WHERE {where}", args).fetchone()
        if lo is None:
            return {"kind": "histogram", "bins": []}
        width = (hi - lo) / bins if hi > lo else 1
        rows = con.execute(f"SELECT LEAST(CAST(FLOOR(({expr} - ?) / ?) AS BIGINT), {bins - 1}) AS b, COUNT(*) FROM dataset "
                           f"WHERE {where} AND {c} IS NOT NULL GROUP BY 1 ORDER BY 1", [lo, width, *args]).fetchall()
        counts = dict(rows)
        conv = (lambda x: x) if numeric else (lambda x: datetime.fromtimestamp(x, timezone.utc).isoformat())
        return {"kind": "histogram", "temporal": not numeric,
                "bins": [{"from": conv(lo + i * width), "to": conv(lo + (i + 1) * width), "count": counts.get(i, 0)} for i in range(bins if hi > lo else 1)]}
    rows = con.execute(f"SELECT {c}, COUNT(*) AS k FROM dataset WHERE {where} GROUP BY 1 ORDER BY k DESC LIMIT 25", args).fetchall()
    return {"kind": "values", "values": [{"value": _json(v), "count": k} for v, k in rows]}


# ------------------------------------------------------------------------------------------------
# comparing versions: compare, Time Travel range and bisect
# ------------------------------------------------------------------------------------------------


def schema_changes(a: pa.Table, b: pa.Table) -> list[dict]:
    sa = {f.name: foundry_type(f.type) for f in a.schema}
    sb = {f.name: foundry_type(f.type) for f in b.schema}
    return ([{"column": c, "change": "added", "type": sb[c]} for c in sb if c not in sa]
            + [{"column": c, "change": "removed", "type": sa[c]} for c in sa if c not in sb]
            + [{"column": c, "change": "type", "from": sa[c], "to": sb[c]} for c in sa if c in sb and sa[c] != sb[c]])


def compare(a: pa.Table, b: pa.Table, key: Optional[str] = None, limit: int = 200) -> dict:
    """What changed from a (older / base) to b: schema changes and added / removed rows; with a key column present in
    both, rows whose key is in both but whose values differ are modified, with the cells that changed."""
    common = [c for c in a.column_names if c in b.column_names]
    ra, rb = json_rows(a.select(common)), json_rows(b.select(common))
    out: dict[str, Any] = {"rows_a": a.num_rows, "rows_b": b.num_rows, "schema": schema_changes(a, b), "compared_columns": common, "key": None}
    if key and key in common:
        ia: dict[str, dict] = {}
        dup = False
        for r in ra:
            k = json.dumps(r[key], default=str)
            dup |= k in ia
            ia[k] = r
        ib = {json.dumps(r[key], default=str): r for r in rb}
        added = [r for k, r in ib.items() if k not in ia]
        removed = [r for k, r in ia.items() if k not in ib]
        modified = []
        for k, r in ib.items():
            if k in ia and ia[k] != r:
                modified.append({"key": r[key], "before": ia[k], "after": r, "cells": [c for c in common if ia[k].get(c) != r.get(c)]})
        out.update(key=key, key_unique=not dup, added=len(added), removed=len(removed), modified=len(modified),
                   added_rows=added[:limit], removed_rows=removed[:limit], modified_rows=modified[:limit])
        return out
    count: dict[str, int] = {}
    for r in ra:
        k = json.dumps(r, default=str, sort_keys=True)
        count[k] = count.get(k, 0) + 1
    added = []
    for r in rb:
        k = json.dumps(r, default=str, sort_keys=True)
        if count.get(k):
            count[k] -= 1
        else:
            added.append(r)
    removed = []
    for r in ra:
        k = json.dumps(r, default=str, sort_keys=True)
        if count.get(k):
            count[k] -= 1
            removed.append(r)
    out.update(added=len(added), removed=len(removed), modified=0, added_rows=added[:limit], removed_rows=removed[:limit], modified_rows=[])
    return out


def _find(t: pa.Table, key: str, value: Any) -> Optional[dict]:
    if key not in t.column_names:
        return None
    for r in json_rows(t.filter(pc.equal(pc.cast(t.column(key), pa.string()), str(value)))) if t.num_rows else []:
        return r
    return None


def _same(a: Any, b: Any) -> bool:
    """A cell value equals a typed-in target (99.0 is "99", true is "true")."""
    if str(a) == str(b) or (isinstance(a, bool) and str(a).lower() == str(b).lower()):
        return True
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return False


def bisect(versions: list[tuple[str, pa.Table]], mode: str, key: str, key_value: Any, column: Optional[str] = None,
           value: Any = None) -> dict:
    """The first version (oldest first) where: row_added — the row with key_value appears; row_removed — it disappears;
    value_changed — its `column` changes (to `value`, when given). Searches only the versions given."""
    prev: Optional[dict] = None
    have_prev = False
    for i, (tx, t) in enumerate(versions):
        r = _find(t, key, key_value)
        if mode == "row_added" and r is not None and (have_prev and prev is None or i == 0):
            if i == 0:
                return {"found": True, "transaction": tx, "index": i, "note": "present in the oldest version searched", "row": r}
            return {"found": True, "transaction": tx, "index": i, "row": r}
        if mode == "row_removed" and r is None and have_prev and prev is not None:
            return {"found": True, "transaction": tx, "index": i, "before": prev}
        if mode == "value_changed" and have_prev and prev is not None and r is not None and column:
            if r.get(column) != prev.get(column) and (value in (None, "") or _same(r.get(column), value)):
                return {"found": True, "transaction": tx, "index": i, "before": prev.get(column), "after": r.get(column), "row": r}
        prev, have_prev = r, True
    return {"found": False, "searched": len(versions)}


def to_csv(table: pa.Table, delimiter: str = ",", bom: bool = False) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=delimiter, lineterminator="\r\n" if bom else "\n")
    w.writerow(table.column_names)
    for r in table.to_pylist():
        w.writerow(["" if v is None else _json(v) if not isinstance(v, str) else v for v in r.values()])
    data = buf.getvalue().encode("utf-8")
    return (b"\xef\xbb\xbf" + data) if bom else data


def to_parquet(table: pa.Table) -> bytes:
    buf = io.BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


def excel_to_csv(name: str, data: bytes, sheet: Optional[str] = None, calculate: bool = True,
                 warnings: Optional[list[str]] = None) -> tuple[str, bytes]:
    """An uploaded workbook's sheet (default: the first) as CSV, as uploading .xls / .xlsx / .xlsm into a dataset does.
    Formulas without a saved result (a workbook written by a program) are calculated (excel_calc.py; not when
    `calculate` is False); a cell that could not be calculated is empty and a "warning: …" naming it is appended to
    `warnings` when given (and logged)."""
    low = name.lower()
    rows: list[list[Any]] = []
    if low.endswith((".xlsx", ".xlsm")):
        import openpyxl

        import excel_calc

        if calculate and excel_calc.has_uncached_formulas(data):
            by_sheet, found = excel_calc.rows_with_calculated_values(data, [sheet])
            rows = [list(r) for r in next(iter(by_sheet.values()))]
            if warnings is not None:
                warnings.extend(found)
        else:
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            ws = wb[sheet] if sheet else wb.worksheets[0]
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
    elif low.endswith(".xls"):
        try:
            import xlrd
        except ImportError:
            raise ValueError(".xls uploads need xlrd (pip install xlrd)") from None
        book = xlrd.open_workbook(file_contents=data)
        sh = book.sheet_by_name(sheet) if sheet else book.sheet_by_index(0)
        for i in range(sh.nrows):
            row = []
            for c in sh.row(i):
                if c.ctype == xlrd.XL_CELL_DATE:
                    row.append(xlrd.xldate.xldate_as_datetime(c.value, book.datemode))
                elif c.ctype == xlrd.XL_CELL_NUMBER and float(c.value).is_integer():
                    row.append(int(c.value))
                else:
                    row.append(c.value if c.ctype != xlrd.XL_CELL_EMPTY else None)
            rows.append(row)
    else:
        raise ValueError("not an Excel file")
    while rows and all(v in (None, "") for v in rows[-1]):
        rows.pop()
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    for r in rows:
        w.writerow(["" if v is None else v.isoformat(sep=" ") if isinstance(v, datetime) else v for v in r])
    base = name.rsplit(".", 1)[0]
    return f"{base}.csv", buf.getvalue().encode("utf-8")
