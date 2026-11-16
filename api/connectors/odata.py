"""OData services (v2 and v4): SAP Gateway (SAP ERP / S/4HANA), SAP SLT through ODP services, SAP
Business One Service Layer, SAP Business ByDesign, SAP Cloud for Customer, SAP SuccessFactors,
Acumatica and any other OData source.

Each OData service is a database; its entity sets are tables. Columns, types and keys come from
the service's $metadata (EDMX), so nothing is sampled. Records are read with server-driven paging
(v2 `d.__next`, v4 `@odata.nextLink`) or $top / $skip; navigation properties are left out.
Incremental reads push the lower bound down as a $filter on the cursor property (DateTime,
DateTimeOffset, Date or integer), in the literal syntax of the service's OData version.

Delta syncs (change tracking): entity sets that track changes — SAP ODP services generated for
extractors (DataSources exposed with RODPS_OS_EXPOSE / ODQMON) and CDS views with change data
capture (sap:change-tracking="true" or a DeltaLinksOf<set> companion set), or any OData v4 service
answering Prefer: odata.track-changes — are read with that header on the first run; the last page's
delta link (v2 `d.__delta`, v4 `@odata.deltaLink`) is kept, and the next run reads only the changes
from it. ODP rows carry their own ODQ_CHANGEMODE / ODQ_ENTITYCNTR (C new, U changed, D deleted).
OData v4 entity sets get the same ODQ_CHANGEMODE column (unless the service has its own): empty on
full reads and the initial load, "U" for an entity added or changed in a delta, "D" for a deleted
entity (`@removed` / `@odata.removed` in 4.01, `$deletedEntity` in 4.0), written as a row with the
key properties, taken from the entry or parsed from its `@id`. Link and deleted-link entries are
skipped. net_changes() collapses such a change log (initial load plus appended deltas) to the rows
a full read returns.

SAP Gateway can list its services from the catalog service
(/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection) instead of a fixed list.

References: OData v2 URI conventions (odata.org/documentation/odata-version-2-0/uri-conventions),
OData v4.01 Part 2 URL conventions (docs.oasis-open.org/odata/odata/v4.01), SAP Gateway catalog
service, SAP Business One Service Layer (POST /Login → B1SESSION cookie).
"""

from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Iterator, Optional
from urllib.parse import quote, urljoin

from .base import ConnectorError
from .records import column
from .rest import OAuth2, RestConnector, Table, keep_rotated

PAGE = 1000
CHANGEMODE = "ODQ_CHANGEMODE"
CATALOG ="/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection"

EDM = {
    "Edm.Boolean": "Boolean",
    "Edm.SByte": "Byte",
    "Edm.Byte": "Short",
    "Edm.Int16": "Short",
    "Edm.Int32": "Integer",
    "Edm.Int64": "Long",
    "Edm.Single": "Float",
    "Edm.Double": "Double",
    "Edm.Decimal": "Decimal",
    "Edm.DateTime": "Timestamp",
    "Edm.DateTimeOffset": "Timestamp",
    "Edm.Date": "Date",
}

_MSDATE = re.compile(r"^/Date\((-?\d+)([+-]\d{4})?\)/$")


def ms_date(v: Any) -> Any:
    """OData v2 JSON dates ("/Date(1700000000000)/") → UTC date-times."""
    if isinstance(v, str):
        m = _MSDATE.match(v)
        if m:
            return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=int(m.group(1)))
    return v


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_metadata(xml: bytes) -> dict:
    """EDMX → {version, sets: {name: {type, columns, key}}}."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        raise ConnectorError(f"The service's $metadata is not valid XML: {e}") from None
    version = root.get("Version", "1.0")
    v4 = version.startswith("4")
    types: dict[str, dict] = {}
    sets: dict[str, dict] = {}
    for schema in (e for e in root.iter() if _local(e.tag) == "Schema"):
        ns = schema.get("Namespace", "")
        alias = schema.get("Alias", "")
        for et in (e for e in schema if _local(e.tag) in ("EntityType", "ComplexType")):
            key = [r.get("Name") for k in et if _local(k.tag) == "Key" for r in k if _local(r.tag) == "PropertyRef"]
            cols = []
            for p in (e for e in et if _local(e.tag) == "Property"):
                t = p.get("Type", "Edm.String")
                kind = EDM.get(t, "String")
                if kind == "Decimal":
                    prec, scale = p.get("Precision"), p.get("Scale")
                    if not (prec and scale and scale.isdigit() and int(scale) <= 18 and int(prec) - int(scale) <= 20):
                        kind = "Double"
                cols.append({"name": p.get("Name"), "type": kind, "edm": t, "nullable": p.get("Nullable", "true") != "false"})
            info = {"columns": cols, "key": key, "base": et.get("BaseType")}
            for prefix in {ns, alias} - {""}:
                types[f"{prefix}.{et.get('Name')}"] = info
        for container in (e for e in schema if _local(e.tag) == "EntityContainer"):
            for es in (e for e in container if _local(e.tag) == "EntitySet"):
                track = any(_local(k) == "change-tracking" and str(v).lower() == "true" for k, v in es.attrib.items())
                sets[es.get("Name")] = {"type": es.get("EntityType"), "track": track}
    out = {}
    for name, s in sets.items():
        t = types.get(s["type"] or "")
        if not t:
            continue
        cols, key = list(t["columns"]), list(t["key"])
        base = t.get("base")
        while base and base in types:  # inherited properties (v4)
            b = types[base]
            cols = b["columns"] + cols
            key = key or b["key"]
            base = b.get("base")
        out[name] = {"columns": cols, "key": key, "delta": bool(s.get("track")) or f"DeltaLinksOf{name}" in sets}
    return {"version": "4" if v4 else "2", "sets": out}


def literal(value: Any, edm: str, v4: bool) -> str:
    """A $filter literal for a cursor value."""
    if isinstance(value, datetime):
        utc = value.astimezone(timezone.utc) if value.tzinfo else value
        if v4:
            return utc.strftime("%Y-%m-%dT%H:%M:%S.%fZ").replace(".000000Z", "Z")
        if edm == "Edm.DateTimeOffset":
            return f"datetimeoffset'{utc.strftime('%Y-%m-%dT%H:%M:%SZ')}'"
        return f"datetime'{utc.strftime('%Y-%m-%dT%H:%M:%S')}'"
    if isinstance(value, date):
        return value.isoformat() if v4 else f"datetime'{value.isoformat()}T00:00:00'"
    if isinstance(value, Decimal):
        return f"{value}M" if not v4 else str(value)
    if edm == "Edm.Int64" and not v4:
        return f"{int(value)}L"
    return str(int(value)) if isinstance(value, int) else f"'{str(value).replace(chr(39), chr(39) * 2)}'"


# --------------------------------------------------------------------------------------------
# delta responses (OData v4 JSON format, "Delta Payload": deleted entities, added / deleted links)
# --------------------------------------------------------------------------------------------


def _context(rec: dict) -> str:
    return str(rec.get("@context") or rec.get("@odata.context") or rec.get("odata.context") or "")


def delta_entry_kind(rec: dict) -> str:
    """"entity" (added or changed), "removed" (a deleted entity) or "link" (an added or deleted link)."""
    ctx = _context(rec)
    if ctx.endswith("$link") or ctx.endswith("$deletedLink") or ({"source", "relationship", "target"} <= set(rec) and not any(k for k in rec if not k.startswith("@") and k not in ("source", "relationship", "target"))):
        return "link"
    if "@removed" in rec or "@odata.removed" in rec or ctx.endswith("$deletedEntity"):
        return "removed"
    return "entity"


def _split_top(text: str) -> list[str]:
    """Splits a key predicate on the commas outside quoted strings."""
    parts, cur, quoted = [], "", False
    for ch in text:
        if ch == "'":
            quoted = not quoted  # '' (an escaped quote) toggles twice
        if ch == "," and not quoted:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return parts


def key_literal(text: str, edm: str) -> Any:
    """A key value from its URL literal ('ALFKI', 42, 42L, guid'…', 2024-01-01T00:00:00Z, …)."""
    t = text.strip()
    m = re.fullmatch(r"(?:[A-Za-z]+)?'(.*)'", t, re.S)
    if m:  # strings, and v2's typed literals (guid'…', datetime'…')
        inner = m.group(1).replace("''", "'")
        if edm in ("Edm.DateTime", "Edm.DateTimeOffset"):
            t = inner
        else:
            return inner
    t = re.sub(r"(?<=\d)[LlMmDdFf]$", "", t) if edm not in ("Edm.String", "Edm.Guid") else t
    try:
        if edm in ("Edm.Int16", "Edm.Int32", "Edm.Int64", "Edm.Byte", "Edm.SByte"):
            return int(t)
        if edm == "Edm.Decimal":
            return Decimal(t)
        if edm in ("Edm.Double", "Edm.Single"):
            return float(t)
        if edm == "Edm.Boolean":
            return t.lower() == "true"
        if edm in ("Edm.DateTime", "Edm.DateTimeOffset"):
            d = datetime.fromisoformat(t.replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        if edm == "Edm.Date":
            return date.fromisoformat(t)
    except ValueError:
        pass
    return t


def removed_keys(rec: dict, key: list[str], edms: dict[str, str]) -> Optional[dict]:
    """The key properties of a deleted-entity entry: given in the entry (4.01 may include them), else parsed
    from its id (`Customers('ALFKI')`, `Orders(OrderID=1,Line=2)` or key-as-segment `Customers/ALFKI`)."""
    if key and all(k in rec for k in key):
        return {k: rec[k] for k in key}
    rid = rec.get("@id") or rec.get("@odata.id") or rec.get("id") or rec.get("odata.id")
    if not isinstance(rid, str) or not key:
        return None
    from urllib.parse import unquote

    path = unquote(rid.split("?", 1)[0]).rstrip("/")
    m = re.fullmatch(r"(?:.*/)?[^/'()]+\((.*)\)", path, re.S)
    if m:
        parts = _split_top(m.group(1))
        out: dict = {}
        for i, p in enumerate(parts):
            name, eq, val = p.partition("=")
            if eq and re.fullmatch(r"\s*[A-Za-z_][\w.]*\s*", name) and not name.strip().startswith("'"):
                name = name.strip()
            elif len(key) == 1 and len(parts) == 1:
                name, val = key[0], p
            else:
                return None
            if name not in key:
                return None
            out[name] = key_literal(val, edms.get(name, "Edm.String"))
        return out if set(out) == set(key) else None
    if len(key) == 1 and "/" in path:  # key-as-segment (OData 4.01)
        return {key[0]: key_literal(path.rsplit("/", 1)[1], edms.get(key[0], "Edm.String"))}
    return None


def net_changes(rows: list[dict], key: list[str], mode_col: str = CHANGEMODE) -> list[dict]:
    """The current rows of a delta-token dataset (the initial load, then each delta's changes, oldest first):
    the last image of each key, and nothing for a key whose last change is a deletion (ODQ_CHANGEMODE = D)."""
    if not key:
        raise ValueError("The entity set has no key: changes cannot be applied")
    cur: dict[tuple, dict] = {}
    for r in rows:
        k = tuple(r.get(n) for n in key)
        if str(r.get(mode_col) or "").upper() == "D":
            cur.pop(k, None)
        else:
            cur[k] = r
    return list(cur.values())


def net_changes_arrow(table: Any, key: list[str], mode_col: str = CHANGEMODE) -> Any:
    """net_changes() of a pyarrow table (rows oldest first), vectorized for big change logs: per key the
    row with the highest position, dropped when it is a deletion (D); rows keep their relative order."""
    import pyarrow as pa
    import pyarrow.compute as pc

    if not key:
        raise ValueError("The entity set has no key: changes cannot be applied")
    seq = "__bsai_seq"
    t = table.append_column(seq, pa.array(range(table.num_rows), pa.int64()))
    last = t.select([*key, seq]).group_by(key, use_threads=False).aggregate([(seq, "max")])[f"{seq}_max"]
    t = t.filter(pc.is_in(t[seq], value_set=last))
    if mode_col in t.column_names:
        deleted = pc.fill_null(pc.equal(pc.utf8_upper(pc.cast(t[mode_col], pa.string())), "D"), False)
        t = t.filter(pc.invert(deleted))
    return t.drop_columns([seq])


def conform_table(table: Any, schema: Any) -> Any:
    """A table (or record batch) in the dataset's schema: columns cast to it, a column the file lacks (an
    upsert file that dropped ODQ_CHANGEMODE, a change log written before the column existed) as nulls."""
    import pyarrow as pa

    if isinstance(table, pa.RecordBatch):
        table = pa.Table.from_batches([table])
    if table.schema.equals(schema):
        return table
    cols = [table[f.name].cast(f.type) if f.name in table.column_names else pa.nulls(table.num_rows, f.type) for f in schema]
    return pa.Table.from_arrays(cols, schema=schema)


def _sql_name(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _sql_text(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _stream_rows(paths: list[str], schema: Any, out_path: str, keep: Any = None, drop: tuple = (), batch_rows: int = 65536) -> int:
    """Copies the rows of Parquet files (in order) into one file in `schema` without `drop`, batch by batch.
    keep: an iterator of sorted row positions (file index << 40 | row in the file) to copy; None copies all."""
    import numpy as np
    import pyarrow as pa
    import pyarrow.parquet as pq

    out_schema = pa.schema([f for f in schema if f.name not in drop])
    pending = np.empty(0, np.int64)
    done = keep is None
    total = 0
    with pq.ParquetWriter(out_path, out_schema, compression="snappy") as writer:
        for i, path in enumerate(paths):
            lo = i << 40
            # no pre-buffering, a buffered stream, one thread: the read stays within a few batches even in
            # big row groups (files written by pq.write_table have row groups of up to 1M rows)
            reader = pq.ParquetFile(path, pre_buffer=False, buffer_size=1 << 20)
            for batch in reader.iter_batches(batch_size=batch_rows, use_threads=False):
                hi = lo + batch.num_rows
                if keep is None:
                    sel = None
                else:
                    while not done and (pending.size == 0 or pending[-1] < hi):
                        nxt = next(keep, None)
                        if nxt is None:
                            done = True
                        else:
                            pending = np.concatenate([pending, nxt])
                    cut = int(np.searchsorted(pending, hi))
                    sel, pending = pending[:cut], pending[cut:]
                    sel = sel[sel >= lo]
                if sel is None or sel.size:
                    t = conform_table(batch, schema)
                    if sel is not None:
                        t = t.take(pa.array(sel - lo))
                    t = t.select(out_schema.names)
                    writer.write_table(t, row_group_size=batch_rows)
                    total += t.num_rows
                lo = hi
    return total


def concat_files(paths: list[str], schema: Any, out_path: str, batch_rows: int = 65536) -> int:
    """The rows of Parquet files, in order, as one file in `schema` (missing columns as nulls), streamed."""
    return _stream_rows(paths, schema, out_path, batch_rows=batch_rows)


def net_changes_files(paths: list[str], schema: Any, key: list[str], out_path: str, mode_col: str = CHANGEMODE, drop: tuple = (),
                      memory_limit: str = "256MB", batch_rows: int = 65536, temp_dir: Optional[str] = None) -> int:
    """net_changes_arrow() of Parquet files (a change log, oldest file and row first) written to out_path, out of
    core: DuckDB finds the last position of each key (hash aggregate and sort spill to disk past memory_limit),
    whose rows — unless deletions — are then copied batch by batch, in their order. The result equals
    net_changes_arrow() over the files read in `schema`, without the `drop` columns. Returns the row count."""
    import os
    import shutil
    import tempfile

    import duckdb
    import pyarrow.parquet as pq

    if not key:
        raise ValueError("The entity set has no key: changes cannot be applied")
    if len(paths) >= 1 << 23:
        raise ValueError("Too many files to merge")
    tmp = tempfile.mkdtemp(prefix="bluesandai-upsert-", dir=temp_dir)
    try:
        keys = ", ".join(_sql_name(k) for k in key)
        parts = []
        for i, path in enumerate(paths):
            names = pq.read_schema(path).names
            missing = [k for k in key if k not in names]
            if missing:
                raise ValueError(f"The key column{'s' if len(missing) > 1 else ''} {', '.join(missing)} not in a dataset file: changes cannot be applied")
            deleted = f"coalesce(upper(CAST({_sql_name(mode_col)} AS VARCHAR)) = 'D', false)" if mode_col in names else "false"
            parts.append(f"SELECT {keys}, {deleted} AS __bsai_del, ({i}::BIGINT << 40) + file_row_number AS __bsai_seq"
                         f" FROM read_parquet({_sql_text(path)}, file_row_number = true)")
        kept = os.path.join(tmp, "kept.parquet")
        con = duckdb.connect(":memory:")
        try:
            con.execute(f"SET memory_limit = {_sql_text(memory_limit)}")
            con.execute(f"SET temp_directory = {_sql_text(os.path.join(tmp, 'spill'))}")
            con.execute("SET threads = 2")
            con.execute("SET preserve_insertion_order = false")
            con.execute(
                "COPY (SELECT s FROM (SELECT max(__bsai_seq) AS s, arg_max(__bsai_del, __bsai_seq) AS d"
                f" FROM ({' UNION ALL '.join(parts)}) GROUP BY {keys}) WHERE NOT d ORDER BY s)"
                f" TO {_sql_text(kept)} (FORMAT parquet)"
            )
        finally:
            con.close()
        positions = (b.column(0).to_numpy(zero_copy_only=False).astype("int64") for b in pq.ParquetFile(kept).iter_batches(batch_size=batch_rows))
        return _stream_rows(paths, schema, out_path, keep=positions, drop=drop, batch_rows=batch_rows)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------------------------
# sync options of SAP sources (Palantir's SAP connector docs: filters with dynamic keywords,
# the /PALANTIR/TIMESTAMP and /PALANTIR/ROWNO columns, masking / hashing of sensitive fields)
# --------------------------------------------------------------------------------------------

TIMESTAMP_COL = "/PALANTIR/TIMESTAMP"
ROWNO_COL = "/PALANTIR/ROWNO"


def _parse8(v: str) -> tuple[date, str]:
    """An 8-digit date: YYYYMMDD (as the keywords give) or DDMMYYYY (as the docs' examples)."""
    v = v.strip()
    if not re.fullmatch(r"\d{8}", v):
        raise ValueError(f'"{v}" is not an 8-digit date')
    if 1900 <= int(v[:4]) <= 2999 and 1 <= int(v[4:6]) <= 12:
        return date(int(v[:4]), int(v[4:6]), int(v[6:])), "ymd"
    return date(int(v[4:]), int(v[2:4]), int(v[:2])), "dmy"


def _fmt8(d: date, style: str) -> str:
    return d.strftime("%Y%m%d" if style == "ymd" else "%d%m%Y")


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(d.day, last))


def expand_keywords(text: str, today: Optional[date] = None) -> str:
    """Dynamic filter keywords: [TODAY], [CURRENTYEAR], [FIRSTDAYOFMONTH], [LASTDAYOFMONTH],
    [FIRSTDAYOFLASTMONTH], [LASTDAYOFLASTMONTH], and the functions [ADDDAY(d,n)], [ADDMONTH(d,n)],
    [ADDYEAR(d,n)], [GETDAY(d)], [GETMONTH(d)], [GETYEAR(d)], nested innermost first."""
    t = today or date.today()
    first = t.replace(day=1)
    last_prev = first - timedelta(days=1)
    fixed = {
        "TODAY": t.strftime("%Y%m%d"),
        "CURRENTYEAR": t.strftime("%Y"),
        "FIRSTDAYOFMONTH": first.strftime("%Y%m%d"),
        "LASTDAYOFMONTH": (_add_months(first, 1) - timedelta(days=1)).strftime("%Y%m%d"),
        "FIRSTDAYOFLASTMONTH": last_prev.replace(day=1).strftime("%Y%m%d"),
        "LASTDAYOFLASTMONTH": last_prev.strftime("%Y%m%d"),
    }

    def fn(m: re.Match) -> str:
        name, args = m.group(1).upper(), [a.strip() for a in m.group(2).split(",")]
        d, style = _parse8(args[0])
        if name in ("ADDDAY", "ADDMONTH", "ADDYEAR"):
            n = int(args[1])
            d = d + timedelta(days=n) if name == "ADDDAY" else _add_months(d, n if name == "ADDMONTH" else 12 * n)
            return _fmt8(d, style)
        return {"GETDAY": f"{d.day:02d}", "GETMONTH": f"{d.month:02d}", "GETYEAR": f"{d.year}"}[name]

    out = re.sub(r"\[(" + "|".join(fixed) + r")\]", lambda m: fixed[m.group(1)], text, flags=re.I)
    # functions, innermost first
    pattern = re.compile(r"\[(ADDDAY|ADDMONTH|ADDYEAR|GETDAY|GETMONTH|GETYEAR)\(([^()\[\]]*)\)\]", re.I)
    for _ in range(20):
        new = pattern.sub(fn, out)
        if new == out:
            break
        out = new
    return out


def parse_rules(text: str) -> dict[str, str]:
    """Lines "EntitySet: <expression>" (or "EntitySet.Field = rule") → {key: value}."""
    out = {}
    for line in str(text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([^:=]+?)\s*[:=]\s*(.+)$", line)
        if m:
            out[m.group(1).strip()] = m.group(2).strip()
    return out


def apply_mask(value: Any, rule: str) -> Any:
    """hide | md5 | sha1 | sha256 | mask:* | mask:# | mask:clear, with an optional :<regex> for masks."""
    if value is None:
        return None
    text = str(value)
    kind = rule.split()[0]
    if kind in ("md5", "sha1", "sha256"):
        return hashlib.new(kind, text.encode()).hexdigest()
    if kind.startswith("mask"):
        parts = kind.split(":", 2)
        char = {"*": "*", "#": "#", "clear": " "}.get(parts[1] if len(parts) > 1 else "*", "*")
        if len(parts) > 2 and parts[2]:
            return re.sub(parts[2], lambda m: char * len(m.group(0)), text)
        return char * len(text)
    return value


class ODataConnector(RestConnector):
    """Config: service_urls (one per line, absolute or relative to url), or gateway_catalog with url."""

    accept = "application/json"

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._meta: dict[str, dict] = {}
        self._services: Optional[dict[str, str]] = None
        mode = config.get("auth_type") or ("Basic" if config.get("user") else "None")
        self.named_user = mode == "OAuth 2.0 (named user)"
        self.auth = {"Basic": "basic", "OAuth 2.0 client credentials": "oauth2", "OAuth 2.0 (named user)": "oauth2", "Bearer token": "bearer", "None": "none"}.get(mode, "basic")
        self._rowno = 0
        self._run_at = datetime.now(timezone.utc)

    def oauth(self) -> Optional[OAuth2]:
        if self.named_user:
            # SAP NetWeaver OAuth 2.0 server: a user's refresh token from the Sign in flow
            # (/sap/bc/sec/oauth2/authorize), renewed at /sap/bc/sec/oauth2/token
            return keep_rotated(self, OAuth2(
                self.config.get("token_url") or f"{self.base_url()}/sap/bc/sec/oauth2/token",
                "refresh_token",
                self.config.get("client_id") or "",
                self.secrets.get("client_secret") or "",
                client_auth="basic",
                refresh_token=self.secrets.get("refresh_token") or "",
            ))
        return OAuth2(
            self.config.get("token_url") or "",
            "client_credentials",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            client_auth="basic",
            scope=self.config.get("scope") or "",
        )

    # -- sync options --

    def _row_filter(self, table: str) -> Optional[str]:
        rules = parse_rules(self.config.get("row_filters") or "")
        expr = rules.get(table) or rules.get("*")
        return expand_keywords(expr) if expr else None

    def _masks(self, table: str) -> dict[str, tuple[str, bool]]:
        """{field: (rule, as a new column)}"""
        out = {}
        for key, rule in parse_rules(self.config.get("masking") or "").items():
            t, _, f = key.rpartition(".")
            if t in (table, "*") and f:
                words = rule.split()
                out[f] = (words[0].lower(), "new" in [w.lower() for w in words[1:]])
        return out

    # -- services --

    def _sap_params(self) -> dict:
        return {"sap-client": self.config["sap_client"]} if self.config.get("sap_client") else {}

    def services(self) -> dict[str, str]:
        """{label: service root URL}"""
        if self._services is None:
            out: dict[str, str] = {}
            if self.config.get("gateway_catalog"):
                r = self.request("GET", self.url(CATALOG), "Could not read the Gateway service catalog", params={"$format": "json", **self._sap_params()})
                for s in (self.body(r).get("d") or {}).get("results", []):
                    url = s.get("ServiceUrl") or ""
                    if url:
                        out[s.get("TechnicalServiceName") or s.get("ID") or url] = re.sub(r"^https?://[^/]+", self.base_url(), url.rstrip("/"))
            for line in str(self.config.get("service_urls") or "").splitlines():
                line = line.strip().rstrip("/")
                if line:
                    out[line.rsplit("/", 1)[-1] or line] = line if re.match(r"^https?://", line) else f"{self.base_url()}/{line.lstrip('/')}"
            if not out:
                raise ConnectorError("No OData services: add service paths (or turn on the Gateway catalog)")
            self._services = out
        return self._services

    def _service(self, database: str) -> str:
        s = self.services().get(database)
        if not s:
            raise ConnectorError(f'OData service "{database}" is not configured')
        return s

    def metadata(self, database: str) -> dict:
        if database not in self._meta:
            r = self.request("GET", f"{self._service(database)}/$metadata", "Could not read the service's $metadata", params=self._sap_params(), headers={"Accept": "application/xml"})
            self._meta[database] = parse_metadata(r.content)
        return self._meta[database]

    # -- discovery --

    def test_connection(self) -> dict:
        services = self.services()
        first = next(iter(services))
        meta = self.metadata(first)
        return {"version": f"OData v{meta['version']} · {len(services)} service{'s' if len(services) != 1 else ''}, {len(meta['sets'])} entity sets in {first}"}

    def list_databases(self) -> list[str]:
        return list(self.services())

    def discover(self) -> list[Table]:
        return []

    def _list_tables(self, database: str, search: str) -> list[dict]:
        return [{"name": n, "kind": "table", "rows": None, "comment": None} for n in self.metadata(database)["sets"]]

    def _set(self, database: str, table: str) -> dict:
        s = self.metadata(database)["sets"].get(table)
        if not s:
            raise ConnectorError(f'Entity set "{table}" is not in {database}')
        return s

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        masks = self._masks(table)
        cols = []
        for c in self._set(database, table)["columns"]:
            rule = masks.get(c["name"])
            if not rule:
                cols.append({**column(c["name"], c["type"], c["edm"], c["nullable"]), "edm": c["edm"]})
            elif rule[0] != "hide":
                suffix = ("_HASH" if rule[0] in ("md5", "sha1", "sha256") else "_MASKED") if rule[1] else ""
                cols.append({**column(c["name"] + suffix, "String", f"{c['edm']} ({rule[0]})", True), "edm": "Edm.String"})
        if self._synthetic_changemode(database, table):
            cols.append(column(CHANGEMODE, "String", "change mode (delta syncs: U added or changed, D deleted)", True))
        if self.config.get("timestamp_columns"):
            cols += [column(TIMESTAMP_COL, "Timestamp", "sync run time", False), column(ROWNO_COL, "Long", "record order", False)]
        return cols

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        return self._set(database, table)["key"]

    def _synthetic_changemode(self, database: str, table: str) -> bool:
        """OData v4 sets get an ODQ_CHANGEMODE column for delta syncs (ODP services have their own)."""
        return self.metadata(database)["version"] == "4" and all(c["name"] != CHANGEMODE for c in self._set(database, table)["columns"])

    # -- reads --

    def _clean(self, rec: dict, edms: dict[str, str], masks: Optional[dict] = None) -> dict:
        out = {}
        for k, v in rec.items():
            if k not in edms:
                continue  # __metadata, @odata.*, navigation properties
            v = ms_date(v) if edms[k] in ("Edm.DateTime", "Edm.DateTimeOffset") else v
            rule = (masks or {}).get(k)
            if rule:
                if rule[0] == "hide":
                    continue
                suffix = ("_HASH" if rule[0] in ("md5", "sha1", "sha256") else "_MASKED") if rule[1] else ""
                out[k + suffix] = apply_mask(v, rule[0])
            else:
                out[k] = v
        if self.config.get("timestamp_columns"):
            self._rowno += 1
            out[TIMESTAMP_COL] = self._run_at
            out[ROWNO_COL] = self._rowno
        return out

    def _read(self, database: str, table: str, limit: Optional[int], flt: Optional[str]) -> Iterator[list[dict]]:
        meta = self.metadata(database)
        v4 = meta["version"] == "4"
        edms = {c["name"]: c["edm"] for c in self._set(database, table)["columns"]}
        masks = self._masks(table)
        url = f"{self._service(database)}/{quote(table)}"
        params: Optional[dict] = {**self._sap_params(), **({} if v4 else {"$format": "json"})}
        # the sync's filter (with dynamic keywords) is always applied, the cursor range on top
        base = self._row_filter(table)
        flt = f"({base}) and ({flt})" if base and flt else (base or flt)
        if flt:
            params["$filter"] = flt
        skip = 0
        left = limit
        size = min(PAGE, limit) if limit else PAGE
        headers = {"Prefer": f"odata.maxpagesize={size}"} if v4 else {}
        while True:
            q = dict(params or {})
            if params is not None:
                q["$top"] = size
                if skip:
                    q["$skip"] = skip
            r = self.request("GET", url, f"Reading {table} failed", headers=headers, **({"params": q} if params is not None else {}))
            body = self.body(r)
            if v4 or "value" in body:
                recs, nxt = body.get("value", []), body.get("@odata.nextLink") or body.get("odata.nextLink")
            else:
                d = body.get("d", {})
                recs, nxt = (d.get("results", []) if isinstance(d, dict) else d), (d.get("__next") if isinstance(d, dict) else None)
            recs = [self._clean(x, edms, masks) for x in recs]
            if left is not None:
                recs = recs[:left]
                left -= len(recs)
            if recs:
                yield recs
            if left is not None and left <= 0:
                return
            if nxt:
                url, params = urljoin(url + "/", nxt) if not re.match(r"^https?://", nxt) else nxt, None
            elif params is not None and len(recs) >= size:
                skip += len(recs)
            else:
                return

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        return self._read(database, table, limit, None)

    # -- delta (change tracking) --

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        info = super().get_table_schema(database, schema, table)
        try:
            info["delta"] = self.supports_delta(database, schema, table)
        except ConnectorError:
            info["delta"] = False
        return info

    def supports_delta(self, database: str, schema: str, table: str) -> bool:
        s = self._set(database, table)
        return bool(s.get("delta")) or self.metadata(database)["version"] == "4" or bool(self.config.get("delta_all"))

    def read_delta(self, database: str, schema: str, table: str, columns: list[str], token: Optional[str], batch_size: int, holder: dict) -> Iterator[list[tuple]]:
        """Rows of the initial load (token None, with Prefer: odata.track-changes) or of the changes since a delta link;
        holder["token"] is the next delta link once every page is read, holder["deleted"] the v4 removals seen.
        A v4 source with the ODQ_CHANGEMODE column writes each removal as a row of the key properties with
        ODQ_CHANGEMODE = D (as ODP does), and its added / changed entities with U; without that column (a
        source created before it existed) removals are only counted."""
        cols = self._cols(database, table, columns or None)
        meta = self.metadata(database)
        v4 = meta["version"] == "4"
        entity = self._set(database, table)
        edms = {c["name"]: c["edm"] for c in entity["columns"]}
        masks = self._masks(table)
        mark = v4 and self._synthetic_changemode(database, table) and any(c["name"] == CHANGEMODE for c in cols)
        headers = {"Prefer": "odata.track-changes" + (f", odata.maxpagesize={PAGE}" if v4 else "")}
        if token:
            url = token if re.match(r"^https?://", token) else urljoin(f"{self._service(database)}/", token)
            params: Optional[dict] = None
            if not v4 and "$format" not in url:
                # params would replace the link's own query (!deltatoken): extend it instead
                url += ("&" if "?" in url else "?") + "$format=json"
        else:
            url = f"{self._service(database)}/{quote(table)}"
            params = {**self._sap_params(), **({} if v4 else {"$format": "json"})}
            flt = self._row_filter(table)
            if flt:
                params["$filter"] = flt
        delta, deleted, links, pending = None, 0, 0, []
        while True:
            r = self.request("GET", url, f"Reading the changes of {table} failed", headers=headers, **({"params": params} if params else {}))
            body = self.body(r)
            if v4 or "value" in body:
                recs = body.get("value", [])
                nxt = body.get("@odata.nextLink") or body.get("odata.nextLink")
                delta = body.get("@odata.deltaLink") or body.get("odata.deltaLink") or delta
            else:
                d = body.get("d", {})
                recs = d.get("results", []) if isinstance(d, dict) else d
                nxt = d.get("__next") if isinstance(d, dict) else None
                delta = (d.get("__delta") if isinstance(d, dict) else None) or delta
            for rec in recs:
                kind = delta_entry_kind(rec) if v4 or "value" in body else "entity"
                if kind == "link":
                    links += 1
                    continue
                if kind == "removed":
                    deleted += 1
                    if not mark:
                        continue
                    keys = removed_keys(rec, entity["key"], edms)
                    if keys is None:
                        raise ConnectorError(f"{table}: a deleted entity in the delta has no key ({rec.get('@id') or rec.get('id') or 'no id'}); "
                                             "re-sync the source for a new initial load")
                    out = self._clean(keys, edms, masks)
                    out[CHANGEMODE] = "D"
                    pending.append(self._row(out, cols))
                    continue
                out = self._clean(rec, edms, masks)
                if mark and token:
                    out[CHANGEMODE] = "U"
                pending.append(self._row(out, cols))
            while len(pending) >= batch_size:
                yield pending[:batch_size]
                pending = pending[batch_size:]
            if not nxt:
                break
            url, params = (urljoin(url + "/", nxt) if not re.match(r"^https?://", nxt) else nxt), None
        if pending:
            yield pending
        if not delta:
            raise ConnectorError(f"{table} returned no delta link: the entity set does not track changes (use a cursor column or a snapshot)")
        holder["token"] = delta
        holder["deleted"] = deleted
        holder["links"] = links

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if lower is None:
            return None
        v4 = self.metadata(database)["version"] == "4"
        edm = col.get("edm") or ""
        flt = f"{col['name']} {'ge' if lower_inclusive else 'gt'} {literal(lower, edm, v4)}"
        return self._read(database, table, None, flt)


CONTRACT = "Contract-based REST API"


class AcumaticaConnector(ODataConnector):
    """Acumatica: reads over OData v4 (DACs and generic inquiries), and table exports through the contract-based REST
    API — POST {url}/entity/auth/login (name, password, tenant, branch) signs in (session cookies), then
    PUT {url}/entity/{endpoint}/{Entity} with each field as {"value": …} creates or updates the record (Acumatica
    matches it on the entity's key fields). The configured entities appear as tables of the "Contract-based REST API"
    database; reading them lists the entity's records ($top / $skip)."""

    exports_records = True

    def _entities(self) -> list[str]:
        return [e.strip() for e in re.split(r"[,\n]", str(self.config.get("export_entities") or "")) if e.strip()]

    def _endpoint(self) -> str:
        return str(self.config.get("endpoint") or "Default/24.200.001").strip("/")

    def list_databases(self) -> list[str]:
        out = list(self.services()) if self.config.get("service_urls") else []
        return out + ([CONTRACT] if self._entities() else [])

    def _list_tables(self, database: str, search: str) -> list[dict]:
        if database == CONTRACT:
            return [{"name": e, "kind": "table", "rows": None, "comment": f"{self._endpoint()}/{e} (contract-based REST)"} for e in self._entities()]
        return super()._list_tables(database, search)

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        return None if database == CONTRACT else super()._declared_columns(database, table)

    def _login(self) -> None:
        if getattr(self, "_signed_in", False):
            return
        user = str(self.config.get("user") or "")
        name, _, tenant = user.partition("@")
        body = {"name": name, "password": self.secrets.get("password", "")}
        if self.config.get("tenant") or tenant:
            body["tenant"] = self.config.get("tenant") or tenant
        if self.config.get("branch"):
            body["branch"] = self.config["branch"]
        r = self.http.post(f"{self.base_url()}/entity/auth/login", json=body)
        if r.status_code >= 400:
            raise ConnectorError(f"Acumatica sign-in failed: HTTP {r.status_code} {self.reason(r)}")
        self._signed_in = True

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        if database != CONTRACT:
            return super()._records(database, table, limit)
        return self._contract_records(table, limit)

    def _contract_records(self, table: str, limit: Optional[int]) -> Iterator[list[dict]]:
        self._login()
        skip, left = 0, limit
        while True:
            top = min(PAGE, left) if left else PAGE
            r = self.http.get(f"{self.base_url()}/entity/{self._endpoint()}/{table}", params={"$top": top, "$skip": skip}, headers={"Accept": "application/json"})
            if r.status_code >= 400:
                raise ConnectorError(f"Reading {table} failed: HTTP {r.status_code} {self.reason(r)}")
            recs = [{k: (v.get("value") if isinstance(v, dict) and "value" in v else v) for k, v in rec.items() if k not in ("custom", "_links", "files")}
                    for rec in (r.json() or [])]
            if recs:
                yield recs
            if left is not None:
                left -= len(recs)
            if len(recs) < top or (left is not None and left <= 0):
                return
            skip += len(recs)

    def write_records(self, database: str, table: str, records: list[dict], key: Optional[str] = None) -> None:
        if database != CONTRACT:
            raise ConnectorError(f"Acumatica takes table exports through its contract-based REST API: export to the {CONTRACT} database "
                                 "(add the entity in the connection's Export entities)")
        if table not in self._entities():
            raise ConnectorError(f"{table} is not one of the connection's export entities ({', '.join(self._entities())})")
        self._login()
        for rec in records:
            body = {k: {"value": v} for k, v in rec.items() if k not in ("id", "rowNumber")}
            r = self.http.put(f"{self.base_url()}/entity/{self._endpoint()}/{table}", json=body, headers={"Accept": "application/json"})
            if r.status_code >= 400:
                raise ConnectorError(f"Writing to {table} failed: HTTP {r.status_code} {self.reason(r)}")


class BusinessOneConnector(ODataConnector):
    """SAP Business One Service Layer: POST {url}/Login with CompanyDB, UserName and Password sets
    the B1SESSION (and ROUTEID) cookies; the root URL is the one service (…/b1s/v1 or …/b1s/v2)."""

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self.auth = "custom"

    def services(self) -> dict[str, str]:
        if self._services is None:
            self._services = {self.config.get("company_db") or "Service Layer": self.base_url()}
        return self._services

    def authenticate(self) -> None:
        r = self.http.post(
            f"{self.base_url()}/Login",
            json={"CompanyDB": self.config["company_db"], "UserName": self.config["user"], "Password": self.secrets.get("password", "")},
        )
        if r.status_code >= 400:
            raise ConnectorError(f"Service Layer login failed: HTTP {r.status_code} {self.reason(r)}")
        # the session cookies are kept by the client; a header marks the session as started
        self.session_headers = {"B1S-ReplaceCollectionsFields": "false"}
