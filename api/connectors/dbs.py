"""Hadoop, SAP HANA and Azure data stores.

  Apache Hive        HiveServer2 through PyHive (SHOW DATABASES / SHOW TABLES / DESCRIBE)
  Apache Phoenix     the Phoenix Query Server (Avatica) through phoenixdb, catalog from its metadata
  SAP HANA (XSA)     hdbcli, catalog from SYS.SCHEMAS / SYS.TABLES / SYS.TABLE_COLUMNS; HDI
                     containers of XSA applications are schemas; HANA information views
                     (calculation views) are read from _SYS_BIC
  Apache HBase       the HBase REST server (Stargate): tables from GET /, rows from scanners;
                     column values are text (or base64 when not UTF-8); `_timestamp` (newest cell)
                     is the incremental cursor, pushed down as the scanner's startTime
  Azure Cosmos DB    the NoSQL REST API with a master key (HMAC-SHA256 authorization token);
                     documents from the read feed, incremental by `_ts` with a query
  Azure Table        the Table service REST API with Shared Key Lite (or a SAS token); entities
  Storage            with $filter on Timestamp, continuation headers for paging

The Python drivers (PyHive, phoenixdb, hdbcli) are imported when a connection opens, so the server
runs without them; a missing driver is reported with the package to install.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from datetime import datetime, timezone
from email.utils import formatdate
from typing import Any, Iterator, Optional
from urllib.parse import quote

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates
from .records import parse_datetime
from .rest import RestConnector, Table


def _driver(module: str, package: str) -> Any:
    import importlib

    try:
        return importlib.import_module(module)
    except ImportError:
        raise ConnectorError(f"This connector needs the {package} package on the server: pip install {package}") from None


# --------------------------------------------------------------------------------------------
# Apache Hive
# --------------------------------------------------------------------------------------------


class HiveConnector(SqlConnector):
    statement_timeout_s = 300
    hidden_schemas = ("sys", "information_schema")

    def quote(self, ident: str) -> str:
        return "`" + ident.replace("`", "``") + "`"

    def _connect(self, database: str) -> Any:
        hive = _driver("pyhive.hive", "pyhive[hive_pure_sasl]")
        c = self.config
        mode = c.get("auth_mode") or ("LDAP" if self.secrets.get("password") else "NONE")
        return hive.Connection(
            host=c["host"],
            port=int(c.get("port") or 10000),
            username=c.get("user") or None,
            password=self.secrets.get("password") if mode in ("LDAP", "CUSTOM") else None,
            auth=mode,
            database=database or c.get("database") or "default",
        )

    def _reset(self, conn: Any) -> None:
        pass  # no transactions

    def test_connection(self) -> dict:
        self.query("SELECT 1", action="Connected, but could not run a query")
        return {"version": "Apache Hive (HiveServer2)"}

    def list_databases(self) -> list[str]:
        return [r[0] for r in self.query("SHOW DATABASES", action="Could not list databases") if r[0] not in self.hidden_schemas]

    def list_schemas(self, database: str) -> list[str]:
        return [database]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        if database not in self.list_databases():
            raise ConnectorError(f'Database "{database}" was not found')
        rows = self.query(f"SHOW TABLES IN {self.ident(database)}", action="Could not list tables")
        names = [r[-1] for r in rows]
        return [{"name": n, "kind": "table", "rows": None, "comment": None} for n in names if not search or search.lower() in n.lower()]

    def table_ref(self, database: str, schema: str, table: str) -> str:
        if not any(t["name"] == table for t in self.list_tables(database, schema, table)):
            raise ConnectorError(f'Table "{database}.{table}" was not found or is not readable')
        return f"{self.ident(database)}.{self.ident(table)}"

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self.query(f"DESCRIBE {self.table_ref(database, schema, table)}", action="Could not describe the table")
        cols = []
        for r in rows:
            name = (r[0] or "").strip()
            if not name or name.startswith("#"):
                break  # partition / detailed sections follow a blank line
            t = (r[1] or "").strip()
            m = re.match(r"decimal\((\d+),\s*(\d+)\)", t)
            prec, scale = (int(m.group(1)), int(m.group(2))) if m else (None, None)
            cols.append({"name": name, "db_type": t, "type": column_type(t, prec, scale), "nullable": True, "comment": (r[2] or None) if len(r) > 2 else None, "scale": scale})
        cursor_candidates(cols, [])
        return {"columns": cols, "primary_key": [], "rows": None, "comment": None}


# --------------------------------------------------------------------------------------------
# Apache Phoenix
# --------------------------------------------------------------------------------------------


def _phoenixdb(spnego: bool) -> Any:
    """phoenixdb imports gssapi / requests_gssapi (Kerberos) at import time, which need a Kerberos
    build; without SPNEGO they are never called, so placeholders stand in when they are missing."""
    import sys
    import types

    if not spnego:
        try:
            import gssapi  # noqa: F401
            import requests_gssapi  # noqa: F401
        except ImportError:
            g = types.ModuleType("gssapi")
            g.mechs = types.SimpleNamespace(Mechanism=None)  # type: ignore[attr-defined]
            g.OID = None  # type: ignore[attr-defined]
            r = types.ModuleType("requests_gssapi")
            r.HTTPSPNEGOAuth = None  # type: ignore[attr-defined]
            sys.modules.setdefault("gssapi", g)
            sys.modules.setdefault("requests_gssapi", r)
    return _driver("phoenixdb", "phoenixdb" if not spnego else "phoenixdb (with gssapi and requests-gssapi for SPNEGO)")


class PhoenixConnector(SqlConnector):
    shared_connection = True
    hidden_schemas = ("SYSTEM",)
    DEFAULT = "(default)"

    def _connect(self, database: str) -> Any:
        c = self.config
        phoenixdb = _phoenixdb(spnego=(c.get("authentication") == "SPNEGO"))
        kw: dict[str, Any] = {"autocommit": True}
        if c.get("user"):
            kw.update(authentication=c.get("authentication") or "BASIC", avatica_user=c["user"], avatica_password=self.secrets.get("password") or "")
        return phoenixdb.connect(c["url"], **kw)

    def prepare(self, sql: str, params: tuple) -> tuple[str, Any]:
        return sql.replace("%s", "?"), params

    def _reset(self, conn: Any) -> None:
        pass

    def test_connection(self) -> dict:
        self.query("SELECT 1 FROM SYSTEM.CATALOG LIMIT 1", action="Connected, but could not run a query")
        return {"version": "Apache Phoenix (Query Server)"}

    def list_databases(self) -> list[str]:
        return ["Phoenix"]

    def list_schemas(self, database: str) -> list[str]:
        rows = self.query("SELECT DISTINCT TABLE_SCHEM FROM SYSTEM.CATALOG", action="Could not list schemas")
        names = sorted({r[0] or self.DEFAULT for r in rows})
        return [n for n in names if n not in self.hidden_schemas]

    def _schema_cond(self, schema: str) -> tuple[str, tuple]:
        return ("TABLE_SCHEM IS NULL", ()) if schema == self.DEFAULT else ("TABLE_SCHEM = %s", (schema,))

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        cond, params = self._schema_cond(schema)
        rows = self.query(f"SELECT DISTINCT TABLE_NAME, TABLE_TYPE FROM SYSTEM.CATALOG WHERE {cond} AND TABLE_TYPE IS NOT NULL", params, action="Could not list tables")
        out = [{"name": r[0], "kind": "view" if r[1] == "v" else "table", "rows": None, "comment": None} for r in rows if r[1] in ("u", "v")]
        return sorted([t for t in out if not search or search.lower() in t["name"].lower()], key=lambda t: t["name"])

    def table_ref(self, database: str, schema: str, table: str) -> str:
        if not any(t["name"] == table for t in self.list_tables(database, schema, table)):
            raise ConnectorError(f'Table "{table}" was not found or is not readable')
        return self.ident(table) if schema == self.DEFAULT else f"{self.ident(schema)}.{self.ident(table)}"

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        cond, params = self._schema_cond(schema)
        rows = self.query(
            f"SELECT COLUMN_NAME, COLUMN_FAMILY, DATA_TYPE, NULLABLE, DECIMAL_DIGITS, COLUMN_SIZE, KEY_SEQ FROM SYSTEM.CATALOG"
            f" WHERE {cond} AND TABLE_NAME = %s AND COLUMN_NAME IS NOT NULL ORDER BY ORDINAL_POSITION",
            (*params, table),
            action="Could not read the table's columns",
        )
        # java.sql.Types codes
        jdbc = {-7: "boolean", 16: "boolean", -6: "tinyint", 5: "smallint", 4: "integer", -5: "bigint", 6: "float", 7: "real", 8: "double", 2: "decimal", 3: "decimal",
                91: "date", 92: "time", 93: "timestamp", -2: "binary", -3: "varbinary"}
        cols, pk = [], []
        for name, family, dtype, nullable, scale, size, key_seq in rows:
            t = jdbc.get(int(dtype or 12), "varchar")
            cols.append({"name": name, "db_type": f"{family}.{t}" if family else t, "type": column_type(t, size, scale), "nullable": nullable == 1, "comment": None, "scale": scale})
            if key_seq:
                pk.append((key_seq, name))
        if not cols:
            raise ConnectorError(f'Table "{table}" was not found or is not readable')
        keys = [n for _, n in sorted(pk)]
        cursor_candidates(cols, keys)
        return {"columns": cols, "primary_key": keys, "rows": None, "comment": None}


# --------------------------------------------------------------------------------------------
# SAP HANA (XSA)
# --------------------------------------------------------------------------------------------


class HanaConnector(SqlConnector):
    shared_connection = True
    hidden_schemas = ("SYS", "_SYS_BI", "_SYS_REPO", "_SYS_STATISTICS", "_SYS_XS", "_SYS_AFL", "_SYS_TASK", "_SYS_EPM", "_SYS_SQL_ANALYZER", "UIS", "HANA_XS_BASE", "SAP_XS_LM")
    statement_timeout_s = 60

    def _connect(self, database: str) -> Any:
        dbapi = _driver("hdbcli.dbapi", "hdbcli")
        c = self.config
        conn = dbapi.connect(
            address=c["host"],
            port=int(c.get("port") or 443),
            user=c["user"],
            password=self.secrets.get("password") or "",
            encrypt=bool(c.get("ssl", True)),
            sslValidateCertificate=bool(c.get("ssl", True)),
            **({"databaseName": c["database"]} if c.get("database") else {}),
        )
        conn.setautocommit(False)
        cur = conn.cursor()
        if not self.writable:
            cur.execute("SET TRANSACTION READ ONLY")
        cur.close()
        return conn

    def prepare(self, sql: str, params: tuple) -> tuple[str, Any]:
        return sql.replace("%s", "?"), params

    def test_connection(self) -> dict:
        (row,) = self.query("SELECT VERSION FROM SYS.M_DATABASE", action="Connected, but could not run a query")
        return {"version": f"SAP HANA {row[0]}"}

    def list_databases(self) -> list[str]:
        return [self.config.get("database") or "HANA"]

    def list_schemas(self, database: str) -> list[str]:
        rows = self.query("SELECT SCHEMA_NAME FROM SYS.SCHEMAS WHERE HAS_PRIVILEGES = 'TRUE' ORDER BY SCHEMA_NAME", action="Could not list schemas")
        # _SYS_BIC holds the HANA information views (calculation / analytic / attribute views)
        return [r[0] for r in rows if r[0] == "_SYS_BIC" or (r[0] not in self.hidden_schemas and not r[0].startswith("_SYS"))]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        like = f"%{search.upper()}%"
        rows = self.query(
            "SELECT TABLE_NAME, 'table', COMMENTS FROM SYS.TABLES WHERE SCHEMA_NAME = %s AND UPPER(TABLE_NAME) LIKE %s"
            " UNION ALL SELECT VIEW_NAME, 'view', COMMENTS FROM SYS.VIEWS WHERE SCHEMA_NAME = %s AND UPPER(VIEW_NAME) LIKE %s ORDER BY 1",
            (schema, like, schema, like),
            action="Could not list tables",
        )
        counts = dict(self.query("SELECT TABLE_NAME, RECORD_COUNT FROM SYS.M_TABLES WHERE SCHEMA_NAME = %s", (schema,), action="Could not read row counts"))
        return [{"name": r[0], "kind": r[1], "rows": counts.get(r[0]), "comment": r[2]} for r in rows]

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self.query(
            "SELECT COLUMN_NAME, DATA_TYPE_NAME, IS_NULLABLE, LENGTH, SCALE, COMMENTS, POSITION FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = %s AND TABLE_NAME = %s"
            " UNION ALL SELECT COLUMN_NAME, DATA_TYPE_NAME, IS_NULLABLE, LENGTH, SCALE, COMMENTS, POSITION FROM SYS.VIEW_COLUMNS WHERE SCHEMA_NAME = %s AND VIEW_NAME = %s ORDER BY 7",
            (schema, table, schema, table),
            action="Could not read the table's columns",
        )
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        hana = {"SECONDDATE": "timestamp", "SHORTTEXT": "varchar", "ALPHANUM": "varchar", "NVARCHAR": "varchar", "NCLOB": "text", "TINYINT": "smallint"}
        cols = []
        for name, t, nullable, length, scale, comment, _ in rows:
            base = hana.get(t, t.lower())
            cols.append({"name": name, "db_type": t, "type": column_type(base, length, scale), "nullable": nullable == "TRUE", "comment": comment, "scale": scale})
        pk = [r[0] for r in self.query(
            "SELECT COLUMN_NAME FROM SYS.CONSTRAINTS WHERE SCHEMA_NAME = %s AND TABLE_NAME = %s AND IS_PRIMARY_KEY = 'TRUE' ORDER BY POSITION",
            (schema, table),
            action="Could not read the primary key",
        )]
        cursor_candidates(cols, pk)
        return {"columns": cols, "primary_key": pk, "rows": None, "comment": None}


# --------------------------------------------------------------------------------------------
# Apache HBase (REST server)
# --------------------------------------------------------------------------------------------


def _b64text(v: Optional[str]) -> Any:
    if v is None:
        return None
    raw = base64.b64decode(v)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return v


class HBaseConnector(RestConnector):
    accept = "application/json"

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self.auth = "basic" if config.get("user") else "none"

    def database(self) -> str:
        return "HBase"

    def test_connection(self) -> dict:
        r = self.request("GET", self.url("version/cluster"), "Could not connect")
        return {"version": f"HBase {r.text.strip().strip(chr(34))}"}

    def discover(self) -> list[Table]:
        if not hasattr(self, "_tables"):
            body = self.body(self.request("GET", self.url(""), "Could not list tables"))
            self._tables = [Table(t["name"], quote(t["name"], safe=":"), pk=["_row"], cursor="_timestamp") for t in body.get("table", [])]
        return self._tables

    def _scan(self, table: str, limit: Optional[int], start_time: Optional[int]) -> Iterator[list[dict]]:
        spec: dict[str, Any] = {"batch": 1000}
        if start_time is not None:
            spec["startTime"] = start_time
        r = self.request("PUT", self.url(f"{quote(table, safe=':')}/scanner"), "Could not open a scanner", json=spec, headers={"Content-Type": "application/json"})
        loc = r.headers.get("Location")
        if not loc:
            raise ConnectorError("The REST server returned no scanner location")
        left = limit
        try:
            while True:
                r = self.request("GET", loc, f"Scanning {table} failed")
                if r.status_code == 204 or not r.content:
                    return
                recs = []
                for row in self.body(r).get("Row", []):
                    rec: dict[str, Any] = {"_row": _b64text(row.get("key"))}
                    newest = 0
                    for cell in row.get("Cell", []):
                        rec[_b64text(cell.get("column"))] = _b64text(cell.get("$"))
                        newest = max(newest, int(cell.get("timestamp") or 0))
                    rec["_timestamp"] = newest
                    recs.append(rec)
                if left is not None:
                    recs = recs[:left]
                    left -= len(recs)
                if recs:
                    yield recs
                if left is not None and left <= 0:
                    return
        finally:
            try:
                self.http.delete(loc, headers=self._headers(), auth=self._basic())
            except Exception:
                pass

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        self._table_def(table)
        return self._scan(table, limit, None)

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if col["name"] == "_timestamp" and isinstance(lower, int):
            return self._scan(table, None, lower if lower_inclusive else lower + 1)
        return None


# --------------------------------------------------------------------------------------------
# Azure Cosmos DB (NoSQL API, REST)
# --------------------------------------------------------------------------------------------

_COSMOS_SYSTEM = ("_rid", "_self", "_etag", "_attachments")


def cosmos_auth(verb: str, resource_type: str, resource_link: str, date: str, key: str) -> str:
    """The master key authorization token of the Cosmos DB REST API."""
    payload = f"{verb.lower()}\n{resource_type.lower()}\n{resource_link}\n{date.lower()}\n\n"
    sig = base64.b64encode(hmac.new(base64.b64decode(key), payload.encode(), hashlib.sha256).digest()).decode()
    return quote(f"type=master&ver=1.0&sig={sig}", safe="")


class CosmosConnector(RestConnector):
    def base_url(self) -> str:
        return str(self.config.get("url") or "").rstrip("/")

    def _cosmos(self, method: str, path: str, rtype: str, link: str, action: str, **kw: Any) -> Any:
        date = formatdate(usegmt=True)
        headers = {
            "x-ms-date": date,
            "x-ms-version": "2018-12-31",
            "Authorization": cosmos_auth(method, rtype, link, date, self.secrets.get("key", "")),
            **kw.pop("headers", {}),
        }
        return self.request(method, f"{self.base_url()}/{path}", action, headers=headers, **kw)

    def test_connection(self) -> dict:
        n = len(self.list_databases())
        return {"version": f"Azure Cosmos DB · {n} database{'s' if n != 1 else ''}"}

    def list_databases(self) -> list[str]:
        if self.config.get("database"):
            return [self.config["database"]]
        r = self._cosmos("GET", "dbs", "dbs", "", "Could not list databases")
        return sorted(d["id"] for d in self.body(r).get("Databases", []))

    def _list_tables(self, database: str, search: str) -> list[dict]:
        r = self._cosmos("GET", f"dbs/{quote(database)}/colls", "colls", f"dbs/{database}", "Could not list containers")
        return [{"name": c["id"], "kind": "table", "rows": None, "comment": None} for c in self.body(r).get("DocumentCollections", [])]

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        return ["id"]

    def _feed(self, database: str, table: str, limit: Optional[int], query: Optional[dict]) -> Iterator[list[dict]]:
        link = f"dbs/{database}/colls/{table}"
        cont = None
        left = limit
        while True:
            headers = {"x-ms-max-item-count": str(min(1000, left) if left else 1000)}
            if cont:
                headers["x-ms-continuation"] = cont
            if query:
                headers.update({"x-ms-documentdb-isquery": "True", "x-ms-documentdb-query-enablecrosspartition": "True", "Content-Type": "application/query+json"})
                r = self._cosmos("POST", f"{quote(link, safe='/')}/docs", "docs", link, f"Querying {table} failed", headers=headers, json=query)
            else:
                r = self._cosmos("GET", f"{quote(link, safe='/')}/docs", "docs", link, f"Reading {table} failed", headers=headers)
            docs = [{k: v for k, v in d.items() if k not in _COSMOS_SYSTEM} for d in self.body(r).get("Documents", [])]
            if left is not None:
                docs = docs[:left]
                left -= len(docs)
            if docs:
                yield docs
            cont = r.headers.get("x-ms-continuation")
            if not cont or (left is not None and left <= 0):
                return

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        return self._feed(database, table, limit, None)

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if col["name"] != "_ts" or not isinstance(lower, int):
            return None
        q = {"query": f"SELECT * FROM c WHERE c._ts {'>=' if lower_inclusive else '>'} @lower", "parameters": [{"name": "@lower", "value": lower}]}
        return self._feed(database, table, None, q)

    def discover(self) -> list[Table]:
        return []

    def _table_def(self, name: str) -> Table:
        return Table(name, "")


# --------------------------------------------------------------------------------------------
# Azure Table Storage (REST, Shared Key Lite or SAS)
# --------------------------------------------------------------------------------------------


class AzureTableConnector(RestConnector):
    accept = "application/json;odata=minimalmetadata"

    def base_url(self) -> str:
        return str(self.config.get("url") or f"https://{self.config['account']}.table.core.windows.net").rstrip("/")

    def _table_request(self, resource: str, action: str, params: Optional[dict] = None) -> Any:
        date = formatdate(usegmt=True)
        headers = {"x-ms-date": date, "x-ms-version": "2019-02-02", "DataServiceVersion": "3.0;NetFx", "MaxDataServiceVersion": "3.0;NetFx"}
        params = dict(params or {})
        sas = (self.secrets.get("sas_token") or "").lstrip("?")
        if sas:
            params.update(dict(p.split("=", 1) for p in sas.split("&") if "=" in p))
        else:
            # Shared Key Lite: StringToSign = Date \n CanonicalizedResource (with ?comp= when present)
            path = re.sub(r"^https?://[^/]+", "", self.base_url())
            canon = f"/{self.config['account']}{path}/{resource}"
            sig = base64.b64encode(hmac.new(base64.b64decode(self.secrets.get("account_key", "")), f"{date}\n{canon}".encode(), hashlib.sha256).digest()).decode()
            headers["Authorization"] = f"SharedKeyLite {self.config['account']}:{sig}"
        return self.request("GET", f"{self.base_url()}/{resource}", action, params=params, headers=headers)

    def database(self) -> str:
        return self.config.get("account") or "Table Storage"

    def test_connection(self) -> dict:
        n = len(self._list_tables("", ""))
        return {"version": f"Azure Table Storage · {n} table{'s' if n != 1 else ''}"}

    def _list_tables(self, database: str, search: str) -> list[dict]:
        out, nxt = [], None
        while True:
            r = self._table_request("Tables", "Could not list tables", {"NextTableName": nxt} if nxt else None)
            out += [t["TableName"] for t in self.body(r).get("value", [])]
            nxt = r.headers.get("x-ms-continuation-NextTableName")
            if not nxt:
                break
        return [{"name": n, "kind": "table", "rows": None, "comment": None} for n in out]

    def discover(self) -> list[Table]:
        return []

    def _table_def(self, name: str) -> Table:
        return Table(name, "")

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        return ["PartitionKey", "RowKey"]

    @staticmethod
    def _entity(e: dict) -> dict:
        out = {}
        for k, v in e.items():
            if k.startswith("odata.") or "@odata" in k:
                continue
            t = e.get(f"{k}@odata.type")
            if t == "Edm.Int64" and isinstance(v, str):
                v = int(v)
            elif (t == "Edm.DateTime" or k == "Timestamp") and isinstance(v, str) and v:
                try:
                    v = parse_datetime(v)
                except ValueError:
                    pass
            out[k] = v
        return out

    def _query(self, table: str, limit: Optional[int], flt: Optional[str]) -> Iterator[list[dict]]:
        pk = rk = None
        left = limit
        while True:
            params: dict[str, Any] = {"$top": min(1000, left) if left else 1000}
            if flt:
                params["$filter"] = flt
            if pk:
                params["NextPartitionKey"] = pk
                if rk:
                    params["NextRowKey"] = rk
            r = self._table_request(f"{quote(table)}()", f"Reading {table} failed", params)
            recs = [self._entity(e) for e in self.body(r).get("value", [])]
            if left is not None:
                recs = recs[:left]
                left -= len(recs)
            if recs:
                yield recs
            pk, rk = r.headers.get("x-ms-continuation-NextPartitionKey"), r.headers.get("x-ms-continuation-NextRowKey")
            if not pk or (left is not None and left <= 0):
                return

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        return self._query(table, limit, None)

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if col["name"] != "Timestamp" or not isinstance(lower, datetime):
            return None
        t = lower.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        return self._query(table, None, f"Timestamp {'ge' if lower_inclusive else 'gt'} datetime'{t}'")
