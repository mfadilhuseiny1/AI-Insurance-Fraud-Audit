"""Airtable (Web API with a personal access token): bases as databases, their tables as tables.

Columns come from the base's schema (Metadata API), not from a sample: every table has
`_record_id` (the primary key) and `_created_time` (the recommended incremental cursor), then its
fields. Linked records, attachments, multiple selects and other structured fields become JSON
text. Airtable allows 5 requests per second per base: a 429 waits 30 seconds and retries.

The token (a personal access token, or OAuth 2.0 with PKCE through the Sign in button) needs the
scopes data.records:read and schema.bases:read, and access to the bases.

Table exports create records 10 per request (POST /v0/{base}/{table}, the API's limit) with
typecast on, so text values fill select options and linked records; with a key field they
upsert (PATCH with performUpsert.fieldsToMergeOn). They need the data.records:write scope.
Computed fields (formulas, rollups, lookups, counts, auto numbers, created / modified times
and users, buttons) cannot be written.
"""

from __future__ import annotations

import re
import time
from typing import Any, Iterator, Optional

import httpx

from .base import ConnectorError
from .records import RecordConnector, column

API = "https://api.airtable.com/v0"
PAGE = 100
WRITE_BATCH = 10

_COMPUTED = ("formula", "rollup", "count", "lookup", "multipleLookupValues", "autoNumber", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy", "button")

_LONG = ("autoNumber", "count", "rating")
_DOUBLE = ("number", "currency", "percent", "duration")
_TIMESTAMP = ("dateTime", "createdTime", "lastModifiedTime")


def field_kind(f: dict) -> str:
    t = f.get("type", "")
    if t in _LONG or (t == "number" and (f.get("options") or {}).get("precision") == 0):
        return "Long"
    if t in _DOUBLE:
        return "Double"
    if t == "checkbox":
        return "Boolean"
    if t == "date":
        return "Date"
    if t in _TIMESTAMP:
        return "Timestamp"
    if t == "formula":
        # a formula's result type is declared in its options
        result = (f.get("options") or {}).get("result") or {}
        return field_kind(result) if result.get("type") else "String"
    return "String"


class AirtableConnector(RecordConnector):
    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._http: Optional[httpx.Client] = None
        self._bases: Optional[list[dict]] = None
        self._tables: dict[str, list[dict]] = {}
        self._oauth: Any = None

    @property
    def http(self) -> httpx.Client:
        if self._http is None:
            self._http = httpx.Client(base_url=API, headers={"Authorization": f"Bearer {self._access_token()}"}, timeout=self.statement_timeout_s)
        return self._http

    def _access_token(self, force: bool = False) -> str:
        """The personal access token, or an OAuth access token from the refresh token (Airtable OAuth:
        airtable.com/oauth2/v1/token, Basic client auth for apps with a secret). Airtable refresh
        tokens are single-use: the rotated one replaces it in the secrets (rest.keep_rotated)."""
        if self.secrets.get("token"):
            return self.secrets["token"]
        if not self.secrets.get("refresh_token"):
            raise ConnectorError("Give a personal access token, or sign in with Airtable (OAuth)")
        if self._oauth is None:
            from .rest import OAuth2, keep_rotated

            secret = self.secrets.get("client_secret") or ""
            self._oauth = keep_rotated(self, OAuth2("https://airtable.com/oauth2/v1/token", "refresh_token", self.config.get("client_id") or "", secret,
                                                    client_auth="basic" if secret else "body", refresh_token=self.secrets["refresh_token"]))
        with httpx.Client(timeout=30) as h:
            return self._oauth.token(h, force=force)

    def close(self) -> None:
        if self._http is not None:
            self._http.close()
            self._http = None

    def _get(self, path: str, action: str, params: Optional[dict] = None) -> Any:
        return self._call("GET", path, action, params=params)

    def _call(self, method: str, path: str, action: str, params: Optional[dict] = None, json: Any = None) -> Any:
        renewed = False
        for attempt in range(4):
            try:
                r = self.http.request(method, path, params=params, json=json)
            except httpx.HTTPError as e:
                raise self.error(e, action) from None
            if r.status_code == 429 and attempt < 3:
                time.sleep(30)
                continue
            if r.status_code == 401 and self._oauth is not None and not renewed:
                # OAuth access tokens last 60 minutes: renew once and retry
                renewed = True
                self.http.headers["Authorization"] = f"Bearer {self._access_token(force=True)}"
                continue
            if r.status_code == 401:
                raise ConnectorError(f"{action}: the access token was not accepted")
            if r.status_code == 403:
                scopes = "data.records:read, schema.bases:read" if method == "GET" else "data.records:write"
                raise ConnectorError(f"{action}: the token lacks a scope ({scopes}) or access to this base")
            if r.status_code >= 400:
                try:
                    err = r.json().get("error")
                    reason = err.get("message") if isinstance(err, dict) else str(err)
                except ValueError:
                    reason = r.text[:200]
                raise ConnectorError(f"{action}: HTTP {r.status_code} {reason}")
            return r.json()
        raise ConnectorError(f"{action}: Airtable's rate limit was hit repeatedly")

    # -- bases and tables --

    def _base_list(self) -> list[dict]:
        if self._bases is None:
            only = (self.config.get("base_id") or "").strip()
            bases: list[dict] = []
            offset = None
            while True:
                page = self._get("/meta/bases", "Could not list bases", {"offset": offset} if offset else None)
                bases.extend(page.get("bases", []))
                offset = page.get("offset")
                if not offset:
                    break
            if only:
                bases = [b for b in bases if b["id"] == only] or [{"id": only, "name": only}]
            self._bases = bases
        return self._bases

    @staticmethod
    def _label(b: dict) -> str:
        return f"{b['name']} ({b['id']})" if b["name"] != b["id"] else b["id"]

    def _base_id(self, database: str) -> str:
        m = re.search(r"\b(app[A-Za-z0-9]{14})\)?$", database)
        if not m or not any(b["id"] == m.group(1) for b in self._base_list()):
            raise ConnectorError(f'Base "{database}" was not found or is not shared with the token')
        return m.group(1)

    def _table_list(self, database: str) -> list[dict]:
        base = self._base_id(database)
        if base not in self._tables:
            self._tables[base] = self._get(f"/meta/bases/{base}/tables", "Could not read the base's tables").get("tables", [])
        return self._tables[base]

    def _table_info(self, database: str, table: str) -> dict:
        t = next((t for t in self._table_list(database) if t["name"] == table), None)
        if not t:
            raise ConnectorError(f'Table "{table}" was not found in the base')
        return t

    # -- discovery --

    def test_connection(self) -> dict:
        bases = self._base_list()
        if not bases:
            raise ConnectorError("Connected, but the token has access to no bases")
        if self.config.get("base_id"):
            self._table_list(self._label(bases[0]))
        return {"version": f"Airtable · {len(bases)} base{'s' if len(bases) != 1 else ''}"}

    def list_databases(self) -> list[str]:
        return [self._label(b) for b in self._base_list()]

    def _list_tables(self, database: str, search: str) -> list[dict]:
        return [{"name": t["name"], "kind": "table", "rows": None, "comment": t.get("description")} for t in self._table_list(database)]

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        cols = [column("_record_id", "String", "record id", nullable=False), column("_created_time", "Timestamp", "createdTime", nullable=False)]
        for f in self._table_info(database, table)["fields"]:
            if f["name"] in ("_record_id", "_created_time"):
                continue
            cols.append(column(f["name"], field_kind(f), f.get("type", ""), comment=f.get("description")))
        return cols

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        return ["_record_id"]

    # -- reads --

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        base, tid = self._base_id(database), self._table_info(database, table)["id"]
        offset = None
        left = limit
        while True:
            params: dict[str, Any] = {"pageSize": min(PAGE, left) if left else PAGE, "returnFieldsByFieldId": "false"}
            if offset:
                params["offset"] = offset
            page = self._get(f"/{base}/{tid}", "Could not read records", params)
            recs = [{"_record_id": r["id"], "_created_time": r.get("createdTime"), **r.get("fields", {})} for r in page.get("records", [])]
            if recs:
                yield recs
            if left:
                left -= len(recs)
                if left <= 0:
                    return
            offset = page.get("offset")
            if not offset:
                return

    # -- writes (table exports) --

    exports_records = True

    def writable_columns(self, database: str, table: str) -> Optional[list[str]]:
        return [f["name"] for f in self._table_info(database, table)["fields"] if f.get("type") not in _COMPUTED]

    def write_size(self, database: str, table: str) -> int:
        return WRITE_BATCH

    def write_records(self, database: str, table: str, records: list[dict], key: Optional[str] = None) -> None:
        base, tid = self._base_id(database), self._table_info(database, table)["id"]
        body: dict[str, Any] = {"records": [{"fields": r} for r in records], "typecast": True}
        if key:
            body["performUpsert"] = {"fieldsToMergeOn": [key]}
        self._call("PATCH" if key else "POST", f"/{base}/{tid}", f"Writing to {table} failed", json=body)
