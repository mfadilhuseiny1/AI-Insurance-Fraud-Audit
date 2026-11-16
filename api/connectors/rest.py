"""REST API connectors: a declarative base for SaaS applications.

An application connector is a `RestConnector` subclass that names its base URL, how it signs in
and its tables (`Table`: an endpoint, where the records are in the response, how it pages, its
primary key and incremental cursor). This module does the HTTP: authentication schemes, paging,
retries on rate limits, and pushing an incremental lower bound down to the API when the endpoint
has a "modified since" filter (`Since`).

Authentication (`auth` on the connector):
  basic          user + password                       (Authorization: Basic)
  bearer         an API token                          (Authorization: Bearer)
  header         an API key in a named header
  oauth2         OAuth 2.0: client credentials, refresh token (from the sign-in flow in
                 oauth.py) or resource owner password, with the access token cached until it
                 expires and renewed once on a 401
  custom         the connector's `authenticate()` (session logins: Act!, SAP Business One, …)
Client certificates (mutual TLS, ADP) are given as PEM text and written to private temp files.

Writes (table exports): a table with `write` (`Write`) takes new records: each request carries up
to `batch` records in the body `body` builds; `upsert` builds the create-or-update request used
when the export has a key field, and `check` finds per-record errors in a successful answer.

Paging (`Paging.kind`):
  none · offset (limit + offset) · page (page number) · next (a next-page URL in the body) ·
  link (RFC 5988 Link header) · token (a continuation token from the body or a header)
"""

from __future__ import annotations

import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Callable, Iterator, Optional
from urllib.parse import quote, urljoin

import httpx

from .base import ConnectorError
from .records import RecordConnector, column

MAX_RETRY_WAIT_S = 60


@dataclass
class Paging:
    kind: str = "none"  # none | offset | page | next | link | token
    size: int = 100
    limit_param: str = "limit"
    offset_param: str = "offset"
    page_param: str = "page"
    start: int = 0
    # next: where the next URL is in the body; token: where the token is (body path or header)
    next_path: str = ""
    token_param: str = ""
    token_header: str = ""
    # offset / page: stop when a page has fewer records than this (default: size)
    full_page: Optional[int] = None
    # offset / page: the total record count (or page count with total_pages) in the body
    total_path: str = ""
    total_pages: bool = False


@dataclass
class Since:
    """An endpoint filter for records changed after a value: `param` gets `format(value)`, or
    `build(value)` returns the query parameters."""

    param: str = ""
    format: Callable[[Any], str] = lambda v: iso(v)
    # extra parameters sent with the filter (e.g. a sort order)
    extra: dict = field(default_factory=dict)
    build: Optional[Callable[[Any], dict]] = None

    def params(self, value: Any) -> dict:
        return self.build(value) if self.build else {self.param: self.format(value), **self.extra}


@dataclass
class Write:
    path: str = ""  # default: the table's path
    method: str = "POST"
    batch: int = 1
    body: Callable[[list[dict]], Any] = lambda records: records[0]
    # (records, key field) → (method, path, body) of a create-or-update request
    upsert: Optional[Callable[[list[dict], str], tuple[str, str, Any]]] = None
    # the answer's body → an error message (per-record failures in a 2xx answer)
    check: Optional[Callable[[Any], Optional[str]]] = None


@dataclass
class Table:
    name: str
    path: str
    records: str = ""  # dotted path to the record list ("" = the body itself)
    method: str = "GET"
    params: dict = field(default_factory=dict)
    body: Optional[dict] = None
    pk: list[str] = field(default_factory=list)
    cursor: Optional[str] = None  # the field Since filters on
    since: Optional[Since] = None
    paging: Optional[Paging] = None
    # declared columns: [(name, type, source type)] (None: inferred from a sample)
    columns: Optional[list[tuple[str, str, str]]] = None
    description: str = ""
    # record → row dict (flattening, renaming); default: the record as it is
    transform: Optional[Callable[[dict], dict]] = None
    # read once per record of another table: (parent table, parent field, path placeholder);
    # each record gets the parent's value in a column named after the placeholder
    each: Optional[tuple[str, str, str]] = None
    # how the table takes new records (table exports)
    write: Optional[Write] = None


def iso(v: Any) -> str:
    """A cursor value as ISO-8601 text (UTC with Z for date-times)."""
    if isinstance(v, datetime):
        v = v.astimezone(timezone.utc) if v.tzinfo else v.replace(tzinfo=timezone.utc)
        return v.strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(v, date):
        return v.isoformat()
    return str(v)


def dig(obj: Any, path: str) -> Any:
    """obj["a"]["b"] for "a.b" (None when missing); "" is obj itself."""
    if not path:
        return obj
    if isinstance(obj, dict) and path in obj:
        return obj[path]  # keys with dots (@odata.nextLink)
    for part in path.split("."):
        if isinstance(obj, dict):
            obj = obj.get(part)
        elif isinstance(obj, list) and part.isdigit() and int(part) < len(obj):
            obj = obj[int(part)]
        else:
            return None
    return obj


def flatten(record: dict, sep: str = "_", depth: int = 1) -> dict:
    """Nested objects become prefixed columns (`address_city`), `depth` levels deep."""
    out: dict = {}
    for k, v in record.items():
        if isinstance(v, dict) and depth > 0 and v:
            for k2, v2 in flatten(v, sep, depth - 1).items():
                out[f"{k}{sep}{k2}"] = v2
        else:
            out[k] = v
    return out


class OAuth2:
    """An OAuth 2.0 access token, fetched and renewed as needed."""

    def __init__(self, token_url: str, grant: str, client_id: str = "", client_secret: str = "", client_auth: str = "body", **params: str):
        self.token_url = token_url
        self.grant = grant  # client_credentials | refresh_token | password
        self.client_id = client_id
        self.client_secret = client_secret
        self.client_auth = client_auth  # body | basic
        self.params = {k: v for k, v in params.items() if v not in (None, "")}
        self.access: Optional[str] = None
        self.expires = 0.0
        self.refresh_token = params.get("refresh_token")
        self.extra: dict = {}
        # called with (old, new) when the provider rotates the refresh token (Airtable, Blackbaud
        # SKY): the old one stops working, so the new one must replace it where it is stored
        self.on_rotate: Optional[Callable[[str, str], None]] = None

    def token(self, http: httpx.Client, force: bool = False) -> str:
        if self.access and not force and time.time() < self.expires - 60:
            return self.access
        data = {"grant_type": self.grant, **self.params}
        if self.grant == "refresh_token":
            data["refresh_token"] = self.refresh_token or ""
        auth = None
        if self.client_auth == "basic":
            auth = (self.client_id, self.client_secret)
        else:
            if self.client_id:
                data["client_id"] = self.client_id
            if self.client_secret:
                data["client_secret"] = self.client_secret
        try:
            r = http.post(self.token_url, data=data, auth=auth, headers={"Accept": "application/json"})
        except httpx.HTTPError as e:
            raise ConnectorError(f"Could not reach the token endpoint: {type(e).__name__}") from None
        if r.status_code >= 400:
            try:
                body = r.json()
                reason = body.get("error_description") or body.get("error") or r.text[:200]
            except ValueError:
                reason = r.text[:200]
            raise ConnectorError(f"Sign-in failed (HTTP {r.status_code}): {reason}")
        body = r.json()
        self.access = body.get("access_token")
        if not self.access:
            raise ConnectorError("Sign-in failed: the token endpoint returned no access token")
        self.expires = time.time() + float(body.get("expires_in") or 3600)
        new = body.get("refresh_token")
        if new and new != self.refresh_token:
            old, self.refresh_token = self.refresh_token, new
            if old and self.on_rotate:
                self.on_rotate(old, new)
        self.extra = body
        return self.access


class _Keep(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def keep_rotated(connector: Any, oauth: OAuth2) -> OAuth2:
    """Have a connector's token source swap a rotated refresh token into its secrets (the same dict
    the server saves) and report it through `on_token_rotated` (set by datasources.py)."""

    def rotated(old: str, new: str) -> None:
        for k, v in connector.secrets.items():
            if v == old:
                connector.secrets[k] = new
        hook = getattr(connector, "on_token_rotated", None)
        if hook:
            hook(old, new)

    oauth.on_rotate = rotated
    return oauth


def write_pem(text: str) -> str:
    """PEM text into a private temp file (for httpx client certificates)."""
    fd, path = tempfile.mkstemp(prefix="bluesandai-", suffix=".pem")
    with os.fdopen(fd, "w") as f:
        f.write(text.strip() + "\n")
    os.chmod(path, 0o600)
    return path


class RestConnector(RecordConnector):
    """Subclasses set `tables` (or override `discover`), `base_url()` and the auth hooks."""

    tables: list[Table] = []
    paging = Paging()
    # basic | bearer | header | oauth2 | custom | none
    auth = "none"
    auth_header = ""  # for auth == "header"
    user_agent = "BluesandAI-Connector/1.0 (+https://github.com/mfadilhuseiny1/BluesandAI-Foundry)"
    accept = "application/json"

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._http: Optional[httpx.Client] = None
        self._oauth: Optional[OAuth2] = None
        self._temp: list[str] = []
        self.session_headers: dict[str, str] = {}

    # -- hooks --

    def base_url(self) -> str:
        return str(self.config.get("url") or "").rstrip("/")

    def database(self) -> str:
        """The single database name shown for the source."""
        return self.spec.name if hasattr(self, "spec") else "API"

    def oauth(self) -> Optional[OAuth2]:
        """The OAuth 2.0 token source for auth == "oauth2"."""
        return None

    def authenticate(self) -> None:
        """auth == "custom": sign in and set `session_headers` (or cookies on self.http)."""

    def client_cert(self) -> Optional[tuple[str, str]]:
        """(certificate PEM, private key PEM) for mutual TLS."""
        return None

    def extra_headers(self) -> dict[str, str]:
        return {}

    def discover(self) -> list[Table]:
        return list(self.tables)

    def test_connection(self) -> dict:
        tables = self.discover()
        if not tables:
            raise ConnectorError("Connected, but no tables are readable")
        # one bounded read proves the credentials
        for _ in self._pages(tables[0], 1, {}):
            break
        return {"version": f"{self.database()} · {len(tables)} table{'s' if len(tables) != 1 else ''}"}

    # -- plumbing --

    @property
    def http(self) -> httpx.Client:
        if self._http is None:
            cert = None
            pem = self.client_cert()
            if pem and pem[0] and pem[1]:
                c, k = write_pem(pem[0]), write_pem(pem[1])
                self._temp += [c, k]
                cert = (c, k)
            self._http = httpx.Client(
                timeout=self.statement_timeout_s,
                cert=cert,
                follow_redirects=True,
                headers={"User-Agent": self.user_agent, "Accept": self.accept},
            )
        return self._http

    def close(self) -> None:
        if self._http is not None:
            self._http.close()
            self._http = None
        for p in self._temp:
            try:
                os.remove(p)
            except OSError:
                pass
        self._temp = []

    def url(self, path: str) -> str:
        if re.match(r"^https?://", path):
            return path
        # {placeholders} from the config; unknown ones (per-parent paths) are left as they are
        path = path.format_map(_Keep({k: v for k, v in self.config.items() if v is not None}))
        return f"{self.base_url()}/{path.lstrip('/')}"

    def _headers(self, refresh: bool = False) -> dict[str, str]:
        h = dict(self.extra_headers())
        if self.auth == "bearer":
            h["Authorization"] = f"Bearer {self.secrets.get('token', '')}"
        elif self.auth == "header":
            h[self.auth_header] = self.secrets.get("token", "")
        elif self.auth == "oauth2":
            if self._oauth is None:
                o = self.oauth()
                self._oauth = keep_rotated(self, o) if o is not None else None
            if self._oauth is None:
                raise ConnectorError("Sign in first (OAuth 2.0)")
            h["Authorization"] = f"Bearer {self._oauth.token(self.http, force=refresh)}"
        elif self.auth == "custom":
            if refresh or not self.session_headers:
                self.authenticate()
            h.update(self.session_headers)
        return h

    def _basic(self) -> Optional[tuple[str, str]]:
        if self.auth == "basic":
            return (str(self.config.get("user") or ""), self.secrets.get("password") or "")
        return None

    def request(self, method: str, url: str, action: str = "Request failed", **kw: Any) -> httpx.Response:
        refreshed = False
        extra = kw.pop("headers", {})
        for attempt in range(4):
            headers = {**self._headers(refresh=refreshed), **extra}
            try:
                r = self.http.request(method, url, headers=headers, auth=self._basic(), **kw)
            except httpx.HTTPError as e:
                raise ConnectorError(f"{action}: {type(e).__name__} reaching {httpx.URL(url).host}") from None
            if r.status_code == 401 and self.auth in ("oauth2", "custom") and not refreshed:
                refreshed = True
                self.session_headers = {}
                continue
            if r.status_code in (429, 503) and attempt < 3:
                try:
                    wait = float(r.headers.get("Retry-After") or 0)
                except ValueError:
                    wait = 0
                time.sleep(min(MAX_RETRY_WAIT_S, wait or 2 ** (attempt + 1)))
                continue
            if r.status_code >= 400:
                raise ConnectorError(f"{action}: HTTP {r.status_code} {self.reason(r)}")
            return r
        raise ConnectorError(f"{action}: the API's rate limit was hit repeatedly")

    @staticmethod
    def reason(r: httpx.Response) -> str:
        if r.status_code == 401:
            return "the credentials were not accepted"
        if r.status_code == 403:
            return "the user lacks permission for this data"
        try:
            body = r.json()
        except ValueError:
            return re.sub(r"\s+", " ", r.text)[:200]
        for path in ("error.message", "error_description", "message", "Message", "error.message.value", "errors.0.message", "detail", "title", "error"):
            v = dig(body, path)
            if isinstance(v, str) and v:
                return v[:300]
        return str(body)[:200]

    def body(self, r: httpx.Response) -> Any:
        if r.status_code == 204 or not r.content.strip():
            return {}
        try:
            # some APIs (Authorize.Net) send a byte order mark
            return r.json() if r.content[:3] != b"\xef\xbb\xbf" else __import__("json").loads(r.content[3:])
        except ValueError:
            raise ConnectorError(f"Expected JSON from {httpx.URL(str(r.url)).path}, got {r.headers.get('content-type', 'unknown content')}") from None

    def records_of(self, tbl: Table, body: Any) -> list[dict]:
        recs = dig(body, tbl.records)
        if recs is None:
            return []
        if isinstance(recs, dict):
            recs = [recs]
        out = [r if isinstance(r, dict) else {"value": r} for r in recs]
        return [tbl.transform(r) for r in out] if tbl.transform else out

    def _pages(self, tbl: Table, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        if tbl.each:
            yield from self._each(tbl, limit, params)
            return
        yield from self._paged(tbl, self.url(tbl.path), limit, params)

    def _each(self, tbl: Table, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        parent_name, parent_field, placeholder = tbl.each  # type: ignore[misc]
        parent = self._table_def(parent_name)
        left = limit
        for batch in self._pages(parent, None, {}):
            for p in batch:
                value = p.get(parent_field)
                if value in (None, ""):
                    continue
                url = self.url(tbl.path.replace("{" + placeholder + "}", quote(str(value), safe="")))
                for recs in self._paged(tbl, url, left, params):
                    yield [{placeholder: value, **r} for r in recs]
                    if left is not None:
                        left -= len(recs)
                        if left <= 0:
                            return

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        pg = tbl.paging or self.paging
        base = {**tbl.params, **params}
        pos = pg.start
        left = limit
        query: Optional[dict] = dict(base)
        while True:
            q = dict(query or {})
            if pg.kind == "offset":
                q[pg.limit_param] = pg.size
                q[pg.offset_param] = pos
            elif pg.kind == "page":
                if pg.limit_param:
                    q[pg.limit_param] = pg.size
                q[pg.page_param] = pos
            # a next-page URL carries its own query: no params (httpx would replace the query)
            kw: dict[str, Any] = {"params": q} if query is not None else {}
            if tbl.body is not None:
                kw["json"] = tbl.body
            r = self.request(tbl.method, url, f"Reading {tbl.name} failed", **kw)
            data = self.body(r)
            recs = self.records_of(tbl, data)
            if left is not None:
                recs = recs[:left]
                left -= len(recs)
            if recs:
                yield recs
            if left is not None and left <= 0:
                return
            if pg.kind in ("offset", "page"):
                n = len(dig(data, tbl.records) or [])
                if n < (pg.full_page or pg.size) or n == 0:
                    return
                pos += n if pg.kind == "offset" else 1
                total = dig(data, pg.total_path) if pg.total_path else None
                if total is not None:
                    done = (pos - pg.start) * (1 if pg.kind == "offset" else pg.size) if not pg.total_pages else pos - pg.start
                    if done >= int(total):
                        return
            elif pg.kind == "next":
                nxt = dig(data, pg.next_path)
                if not nxt or not isinstance(nxt, str):
                    return
                url, query = urljoin(url, nxt), None  # the next URL carries the query
            elif pg.kind == "link":
                nxt = r.links.get("next", {}).get("url")
                if not nxt:
                    return
                url, query = urljoin(url, nxt), None
            elif pg.kind == "token":
                tok = r.headers.get(pg.token_header) if pg.token_header else dig(data, pg.next_path)
                if not tok:
                    return
                query = {**base, pg.token_param: tok}
            else:
                return

    # -- RecordConnector --

    def _table_def(self, name: str) -> Table:
        t = next((t for t in self.discover() if t.name == name), None)
        if not t:
            raise ConnectorError(f'"{name}" is not a table of this source')
        return t

    def list_databases(self) -> list[str]:
        return [self.database()]

    def _list_tables(self, database: str, search: str) -> list[dict]:
        return [{"name": t.name, "kind": "table", "rows": None, "comment": t.description or None} for t in self.discover()]

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        t = self._table_def(table)
        if t.columns is None:
            return None
        return [column(n, k, s) for n, k, s in t.columns]

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        names = {c["name"] for c in columns}
        return [k for k in self._table_def(table).pk if k in names]

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        return self._pages(self._table_def(table), limit, {})

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        t = self._table_def(table)
        if lower is None or not t.since or col["name"] != t.cursor:
            return None
        # the API filters from the lower bound; the exact range is still checked per record
        return self._pages(t, None, t.since.params(lower))

    # -- writes --

    def _write_def(self, table: str) -> Write:
        w = self._table_def(table).write
        if w is None:
            raise ConnectorError(f'"{table}" does not take new records (table exports write to: {", ".join(t.name for t in self.discover() if t.write) or "no table of this source"})')
        return w

    def write_size(self, database: str, table: str) -> int:
        return self._write_def(table).batch

    def write_records(self, database: str, table: str, records: list[dict], key: Optional[str] = None) -> None:
        t, w = self._table_def(table), self._write_def(table)
        if key:
            if w.upsert is None:
                raise ConnectorError(f'"{table}" cannot update records by a key field: export without one (records are created)')
            method, path, body = w.upsert(records, key)
        else:
            method, path, body = w.method, w.path or t.path, w.body(records)
        r = self.request(method, self.url(path), f"Writing to {table} failed", json=body)
        problem = w.check(self.body(r)) if w.check else None
        if problem:
            raise ConnectorError(f"Writing to {table} failed: {problem}")
