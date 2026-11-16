"""Apache CouchDB (HTTP API): each CouchDB database is a table of its documents.

The server is the only database; its CouchDB databases are listed as tables (design documents
are left out). Columns are the top-level fields of a bounded sample; nested values become JSON
text. Row counts are each database's doc_count.

Documents are read in key order through _all_docs pages. Integer cursor ranges are pushed down
as a Mango _find selector; date-time strings are filtered here (their text order depends on the
offsets they were written with).
"""

from __future__ import annotations

import json
from typing import Any, Iterator, Optional
from urllib.parse import quote

import httpx

from .base import ConnectorError
from .records import RecordConnector

PAGE_DOCS = 1000


class CouchDbConnector(RecordConnector):
    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._http: Optional[httpx.Client] = None

    @property
    def http(self) -> httpx.Client:
        if self._http is None:
            user = self.config.get("user") or ""
            auth = (user, self.secrets.get("password") or "") if user else None
            self._http = httpx.Client(base_url=self.config["url"].rstrip("/"), auth=auth, timeout=self.statement_timeout_s, follow_redirects=False)
        return self._http

    def close(self) -> None:
        if self._http is not None:
            self._http.close()
            self._http = None

    def _get(self, path: str, action: str, **params: Any) -> Any:
        return self._call("GET", path, action, params=params)

    def _call(self, method: str, path: str, action: str, **kw: Any) -> Any:
        try:
            r = self.http.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise self.error(e, action) from None
        if r.status_code == 401:
            raise ConnectorError(f"{action}: the user name or password was not accepted")
        if r.status_code >= 400:
            try:
                body = r.json()
                reason = f"{body.get('error', '')}: {body.get('reason', '')}".strip(": ")
            except ValueError:
                reason = r.text[:200]
            raise ConnectorError(f"{action}: HTTP {r.status_code} {reason}")
        return r.json()

    # -- discovery --

    def test_connection(self) -> dict:
        info = self._get("/", "Could not connect")
        if "couchdb" not in info:
            raise ConnectorError("Connected, but the server is not CouchDB")
        self._get("/_all_dbs", "Connected, but could not list databases", limit=1)
        return {"version": f"CouchDB {info.get('version', '')}".strip()}

    def list_databases(self) -> list[str]:
        return ["CouchDB"]

    def _list_tables(self, database: str, search: str) -> list[dict]:
        names = [n for n in self._get("/_all_dbs", "Could not list databases") if not n.startswith("_")]
        if search:
            names = [n for n in names if search.lower() in n.lower()]
        out = []
        for n in names:
            rows = None
            if len(out) < 300:
                try:
                    rows = self._get(f"/{quote(n, safe='')}", "Could not read the database")["doc_count"]
                except ConnectorError:
                    pass
            out.append({"name": n, "kind": "table", "rows": rows, "comment": None})
        return out

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        return ["_id"] if any(c["name"] == "_id" for c in columns) else []

    def _schema(self, database: str, table: str) -> dict:
        info = super()._schema(database, table)
        names = [c["name"] for c in info["columns"]]
        info["columns"].sort(key=lambda c: (c["name"] not in ("_id", "_rev"), names.index(c["name"])))
        return info

    # -- reads --

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        path = f"/{quote(table, safe='')}/_all_docs"
        start: Optional[str] = None
        left = limit
        while True:
            params: dict[str, Any] = {"include_docs": "true", "limit": PAGE_DOCS + (1 if start else 0)}
            if start is not None:
                params["startkey"] = json.dumps(start)
            rows = self._get(path, "Could not read documents", **params)["rows"]
            if start is not None:
                rows = rows[1:]  # the page's first row is the previous page's last
            if not rows:
                return
            docs = [r["doc"] for r in rows if r.get("doc") and not r["id"].startswith("_design/")]
            if left:
                docs = docs[:left]
                left -= len(docs)
            if docs:
                yield docs
            if (left is not None and left <= 0) or len(rows) < PAGE_DOCS:
                return
            start = rows[-1]["id"]

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if col["type"] not in ("Integer", "Long") or not all(isinstance(v, int) for v in (lower, upper) if v is not None):
            return None
        cond: dict[str, Any] = {}
        if upper is not None:
            cond["$lte"] = upper
        if lower is not None:
            cond["$gte" if lower_inclusive else "$gt"] = lower
        selector = {col["name"]: cond or {"$exists": True}}
        path = f"/{quote(table, safe='')}/_find"

        def pages() -> Iterator[list[dict]]:
            bookmark = None
            while True:
                body: dict[str, Any] = {"selector": selector, "limit": PAGE_DOCS}
                if bookmark:
                    body["bookmark"] = bookmark
                res = self._call("POST", path, "Reading new documents failed", json=body)
                docs = res.get("docs", [])
                if docs:
                    yield docs
                if len(docs) < PAGE_DOCS or not res.get("bookmark"):
                    return
                bookmark = res["bookmark"]

        return pages()
