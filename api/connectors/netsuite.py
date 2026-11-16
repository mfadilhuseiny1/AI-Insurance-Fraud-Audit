"""Oracle NetSuite: SuiteQL and SuiteTalk REST web services, and SuiteAnalytics Connect.

REST (SuiteTalk REST Web Services, docs.oracle.com/en/cloud/saas/netsuite): the host is
https://{account}.suitetalk.api.netsuite.com (the account ID lowercase, "_" as "-"). Requests are
signed with Token-Based Authentication — OAuth 1.0a with HMAC-SHA256, realm = the account ID in
upper case (consumer key/secret of an integration record, token ID/secret of an access token) —
or carry an OAuth 2.0 bearer token (authorization code flow, scope rest_webservices).

  SuiteQL    POST /services/rest/query/v1/suiteql?limit=1000&offset=n with Prefer: transient and
             {"q": "SELECT …"}; answers {items, hasMore}. Tables are the record types of
             GET /services/rest/record/v1/metadata-catalog. Reads page by id (keyset) so tables
             larger than SuiteQL's offset limit are read whole; `id` is the incremental cursor.
  SuiteTalk  GET /services/rest/record/v1/{type}?limit&offset lists ids; each record is then
             read from /record/v1/{type}/{id}.

SuiteAnalytics Connect (the NetSuite2.com data source) is ODBC/JDBC only: it is read through the
NetSuite ODBC driver with pyodbc (installed separately, with the driver from NetSuite's
SuiteAnalytics Connect download page).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets as pysecrets
import time
from typing import Any, Iterator, Optional
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit

import httpx

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates
from .rest import OAuth2, RestConnector, Table

PAGE = 1000


def _enc(s: str) -> str:
    return quote(str(s), safe="~-._")


def oauth1_header(method: str, url: str, realm: str, consumer_key: str, consumer_secret: str, token: str, token_secret: str, nonce: Optional[str] = None, timestamp: Optional[str] = None) -> str:
    """The OAuth 1.0a Authorization header (RFC 5849) signed with HMAC-SHA256, as NetSuite TBA."""
    parts = urlsplit(url)
    base_url = urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, "", ""))
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_token": token,
        "oauth_signature_method": "HMAC-SHA256",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_nonce": nonce or pysecrets.token_hex(16),
        "oauth_version": "1.0",
    }
    params = sorted([(_enc(k), _enc(v)) for k, v in [*parse_qsl(parts.query, keep_blank_values=True), *oauth.items()]])
    base = "&".join([method.upper(), _enc(base_url), _enc("&".join(f"{k}={v}" for k, v in params))])
    key = f"{_enc(consumer_secret)}&{_enc(token_secret)}"
    oauth["oauth_signature"] = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha256).digest()).decode()
    return "OAuth " + ", ".join([f'realm="{realm}"', *(f'{k}="{_enc(v)}"' for k, v in oauth.items())])


def account_host(account: str) -> str:
    """The account ID as a host label (1234567_SB1 → 1234567-sb1); anything else is refused, as it
    would point the connection (and its credentials) at another host than egress checks see."""
    host = account.strip().lower().replace("_", "-")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", host):
        raise ConnectorError(f'"{account}" is not a NetSuite account ID (letters, digits, - and _)')
    return host


class NetSuiteRest(RestConnector):
    """Shared REST plumbing: host, TBA signing or OAuth 2.0, record-type discovery."""

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self.auth = "oauth2" if secrets.get("refresh_token") else "none"
        self._types: Optional[list[str]] = None

    def base_url(self) -> str:
        return f"https://{account_host(self.config['account_id'])}.suitetalk.api.netsuite.com/services/rest"

    def database(self) -> str:
        return self.config.get("account_id") or "NetSuite"

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            f"{self.base_url()}/auth/oauth2/v1/token",
            "refresh_token",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            client_auth="basic",
            refresh_token=self.secrets.get("refresh_token") or "",
        )

    def request(self, method: str, url: str, action: str = "Request failed", **kw: Any) -> httpx.Response:
        if self.auth == "none":
            # TBA signs each request, query parameters included
            full = str(httpx.URL(url, params=kw.get("params") or {}))
            sig = oauth1_header(
                method,
                full,
                self.config["account_id"].upper().replace("-", "_"),
                self.config.get("consumer_key") or "",
                self.secrets.get("consumer_secret") or "",
                self.config.get("token_id") or "",
                self.secrets.get("token_secret") or "",
            )
            kw["headers"] = {**kw.get("headers", {}), "Authorization": sig}
        return super().request(method, url, action, **kw)

    def record_types(self) -> list[str]:
        if self._types is None:
            body = self.body(self.request("GET", self.url("record/v1/metadata-catalog"), "Could not read the metadata catalog"))
            self._types = sorted(i["name"] for i in body.get("items", []) if i.get("name"))
        return self._types


class SuiteQLConnector(NetSuiteRest):
    """SuiteQL over REST: record types as tables, keyset paging on id."""

    def discover(self) -> list[Table]:
        extra = ["transaction", "transactionline", "transactionaccountingline"]
        return [Table(t, "query/v1/suiteql", pk=["id"]) for t in sorted({*self.record_types(), *extra})]

    def _query(self, sql: str, limit: int) -> dict:
        r = self.request("POST", self.url("query/v1/suiteql"), "SuiteQL query failed", params={"limit": limit, "offset": 0}, json={"q": sql}, headers={"Prefer": "transient"})
        return self.body(r)

    @staticmethod
    def _item(item: dict) -> dict:
        rec = {k: v for k, v in item.items() if k != "links"}
        # SuiteQL returns every value as text: ids are numbers
        if isinstance(rec.get("id"), str) and rec["id"].lstrip("-").isdigit():
            rec["id"] = int(rec["id"])
        return rec

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        name = tbl.name
        if not name.replace("_", "").isalnum():
            raise ConnectorError(f'"{name}" is not a SuiteQL table name')
        last = params.get("after")
        left = limit
        keyset = True
        offset = 0
        while True:
            size = min(PAGE, left) if left else PAGE
            if keyset:
                where = f" WHERE id > {int(last)}" if last is not None else ""
                sql = f"SELECT * FROM {name}{where} ORDER BY id"
                try:
                    body = self._query(sql, size)
                except ConnectorError as e:
                    if last is None and "id" in str(e).lower():
                        keyset = False  # a table without an id column: plain offset paging
                        continue
                    raise
            else:
                r = self.request("POST", self.url("query/v1/suiteql"), "SuiteQL query failed", params={"limit": size, "offset": offset}, json={"q": f"SELECT * FROM {name}"}, headers={"Prefer": "transient"})
                body = self.body(r)
            recs = [self._item(i) for i in body.get("items", [])]
            if left is not None:
                recs = recs[:left]
                left -= len(recs)
            if recs:
                yield recs
            if not body.get("hasMore") or not recs or (left is not None and left <= 0):
                return
            if keyset:
                last = recs[-1].get("id")
                if last is None:
                    return
            else:
                offset += len(recs)

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if col["name"] == "id" and isinstance(lower, int):
            return self._paged(self._table_def(table), "", None, {"after": lower - 1 if lower_inclusive else lower})
        return None

    def test_connection(self) -> dict:
        self._query("SELECT id FROM subsidiary", 1)
        return {"version": f"NetSuite {self.config['account_id']} · SuiteQL"}


class SuiteTalkConnector(NetSuiteRest):
    """REST record service: list ids, then read each record."""

    def discover(self) -> list[Table]:
        return [Table(t, f"record/v1/{t}", pk=["id"]) for t in self.record_types()]

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        offset, left = 0, limit
        while True:
            size = min(PAGE, left) if left else PAGE
            body = self.body(self.request("GET", url, f"Listing {tbl.name} failed", params={"limit": size, "offset": offset}))
            ids = [i.get("id") for i in body.get("items", []) if i.get("id")]
            recs = []
            for rid in ids[: left if left else None]:
                rec = self.body(self.request("GET", f"{url}/{quote(str(rid))}", f"Reading {tbl.name} {rid} failed"))
                recs.append({k: v for k, v in rec.items() if k != "links"})
            if left is not None:
                left -= len(recs)
            if recs:
                yield recs
            if not body.get("hasMore") or (left is not None and left <= 0):
                return
            offset += len(ids)

    def test_connection(self) -> dict:
        n = len(self.record_types())
        return {"version": f"NetSuite {self.config['account_id']} · {n} record types"}


class SuiteAnalyticsConnector(SqlConnector):
    """SuiteAnalytics Connect (NetSuite2.com) through the NetSuite ODBC driver (pyodbc)."""

    shared_connection = True
    hidden_schemas = ()

    def _connect(self, database: str) -> Any:
        try:
            import pyodbc
        except ImportError:
            raise ConnectorError("SuiteAnalytics Connect needs pyodbc and the NetSuite ODBC driver installed on this server") from None
        c = self.config
        parts = {
            "DRIVER": "{" + (c.get("driver") or "NetSuite Drivers 64bit") + "}",
            "Host": f"{account_host(c['account_id'])}.connect.api.netsuite.com",
            "Port": c.get("port") or 1708,
            "Encrypted": 1,
            "AllowSinglePacketLogout": 1,
            "Truststore": "system",
            "SDSN": "NetSuite2.com",
            "UID": c["user"],
            "PWD": self.secrets.get("password", ""),
            "CustomProperties": f"AccountID={c['account_id']};RoleID={c['role_id']}",
        }
        return pyodbc.connect(";".join(f"{k}={v}" for k, v in parts.items()), timeout=10, readonly=True)

    def prepare(self, sql: str, params: tuple) -> tuple[str, Any]:
        return sql.replace("%s", "?"), params

    def limit(self, select: str, n: int) -> str:
        return f"SELECT TOP {int(n)} " + select[len("SELECT "):]

    def test_connection(self) -> dict:
        self.query("SELECT TOP 1 id FROM subsidiary", action="Connected, but could not run a query")
        return {"version": "SuiteAnalytics Connect · NetSuite2.com"}

    def list_databases(self) -> list[str]:
        return ["NetSuite2.com"]

    def list_schemas(self, database: str) -> list[str]:
        return ["NetSuite2.com"]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        cur = self.conn().cursor()
        try:
            rows = cur.tables(tableType="TABLE").fetchall()
        except Exception as e:
            raise self.error(e, "Could not list tables") from None
        return [{"name": r.table_name, "kind": "table", "rows": None, "comment": r.remarks} for r in rows if not search or search.lower() in r.table_name.lower()]

    def table_ref(self, database: str, schema: str, table: str) -> str:
        if not any(t["name"] == table for t in self.list_tables(database, schema, table)):
            raise ConnectorError(f'Table "{table}" was not found or is not readable')
        return self.ident(table)

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        cur = self.conn().cursor()
        try:
            rows = cur.columns(table=table).fetchall()
        except Exception as e:
            raise self.error(e, "Could not read the table's columns") from None
        if not rows:
            raise ConnectorError(f'Table "{table}" was not found or is not readable')
        cols = [
            {"name": r.column_name, "db_type": r.type_name, "type": column_type(r.type_name, r.column_size, r.decimal_digits), "nullable": bool(r.nullable), "comment": r.remarks, "scale": r.decimal_digits}
            for r in rows
        ]
        pk = ["id"] if any(c["name"] == "id" for c in cols) else []
        cursor_candidates(cols, pk)
        return {"columns": cols, "primary_key": pk, "rows": None, "comment": None}
