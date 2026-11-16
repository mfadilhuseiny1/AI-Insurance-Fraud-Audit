"""CRM connectors on the REST base (rest.py): Salesforce and HubSpot, read and written (table exports).

Salesforce — REST API (developer.salesforce.com/docs/atlas.en-us.api_rest.meta). OAuth 2.0 against
the org's My Domain URL: the Sign in button (web server flow with PKCE, scopes "api refresh_token")
or a connected app's client credentials flow. The token answer's instance_url is where the API
is. Tables are the queryable sObjects (GET /sobjects); columns come from each object's describe;
reads run SOQL (GET /query, nextRecordsUrl paging) and push an incremental lower bound on
SystemModstamp down as a WHERE clause. Table exports create records 200 per request through
sObject Collections (POST /composite/sobjects, allOrNone), or upsert them by an external ID field
(PATCH /composite/sobjects/{object}/{field}).

HubSpot — CRM API v3 (developers.hubspot.com/docs/api/crm). A private app access token, or OAuth
2.0 (Sign in). Tables are the CRM objects (contacts, companies, deals, tickets, …) and custom
objects (GET /crm/v3/schemas); columns are the object's properties (GET /crm/v3/properties/{object})
plus id, createdAt, updatedAt and archived; reads page with `after`. Table exports create records
100 per request (POST /crm/v3/objects/{object}/batch/create), or upsert them by a unique property
(POST …/batch/upsert with idProperty). Read-only and calculated properties cannot be written.
"""

from __future__ import annotations

from typing import Any, Iterator, Optional
from urllib.parse import quote

from .base import ConnectorError
from .records import column
from .rest import OAuth2, Paging, RestConnector, Since, Table, Write, iso

# --------------------------------------------------------------------------------------------
# Salesforce
# --------------------------------------------------------------------------------------------

SF_API = "v61.0"
SF_BATCH = 200  # sObject Collections: at most 200 records per request

_SF_KIND = {
    "boolean": "Boolean",
    "int": "Long",
    "long": "Long",
    "double": "Double",
    "currency": "Double",
    "percent": "Double",
    "date": "Date",
    "datetime": "Timestamp",
}


def _sf_errors(body: Any) -> Optional[str]:
    """The first per-record failure of a sObject Collections answer (allOrNone rolls back the rest)."""
    if not isinstance(body, list):
        return None
    for i, r in enumerate(body):
        if isinstance(r, dict) and not r.get("success", True):
            errs = [e for e in r.get("errors") or [] if e.get("statusCode") != "ALL_OR_NONE_OPERATION_ROLLED_BACK"]
            if errs:
                e = errs[0]
                fields = f" ({', '.join(e['fields'])})" if e.get("fields") else ""
                return f"record {i + 1}: {e.get('statusCode')}: {e.get('message')}{fields}"
    return None


class SalesforceConnector(RestConnector):
    auth = "oauth2"
    paging = Paging("next", next_path="nextRecordsUrl")
    exports_records = True
    oauth_based = True

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._objects: Optional[list[dict]] = None
        self._describe: dict[str, dict] = {}

    def _login(self) -> str:
        url = str(self.config.get("url") or "").rstrip("/")
        if not url.startswith("https://"):
            raise ConnectorError("The My Domain URL must start with https:// (e.g. https://yourcompany.my.salesforce.com)")
        return url

    def oauth(self) -> Optional[OAuth2]:
        token_url = f"{self._login()}/services/oauth2/token"
        client_id, client_secret = self.config.get("client_id") or "", self.secrets.get("client_secret") or ""
        if self.secrets.get("refresh_token"):
            return OAuth2(token_url, "refresh_token", client_id, client_secret, refresh_token=self.secrets["refresh_token"])
        if client_id and client_secret:
            return OAuth2(token_url, "client_credentials", client_id, client_secret)
        return None

    def base_url(self) -> str:
        # the token answer names the instance the API runs on (the My Domain URL otherwise)
        if self._oauth is None:
            self._headers()
        instance = (self._oauth.extra.get("instance_url") if self._oauth else None) or self._login()
        return str(instance).rstrip("/")

    def database(self) -> str:
        return "Salesforce"

    def _api(self, path: str) -> str:
        return f"services/data/{SF_API}/{path}"

    def _get_json(self, path: str, action: str) -> Any:
        return self.body(self.request("GET", self.url(self._api(path)), action))

    # -- objects --

    def _object_list(self) -> list[dict]:
        if self._objects is None:
            body = self._get_json("sobjects", "Could not list objects")
            self._objects = [o for o in body.get("sobjects", []) if o.get("queryable")]
        return self._objects

    def _describe_of(self, name: str) -> dict:
        if name not in self._describe:
            self._describe[name] = self._get_json(f"sobjects/{quote(name, safe='')}/describe", f"Could not describe {name}")
        return self._describe[name]

    def _fields(self, name: str) -> list[dict]:
        # binary (base64) fields are read through their own blob URLs, not SOQL
        return [f for f in self._describe_of(name).get("fields", []) if f.get("type") != "base64"]

    def _soql(self, name: str, where: str = "") -> str:
        cols = ", ".join(f["name"] for f in self._fields(name))
        return f"SELECT {cols} FROM {name}" + (f" WHERE {where}" if where else "")

    def discover(self) -> list[Table]:
        out = []
        for o in self._object_list():
            name = o["name"]
            out.append(
                Table(
                    name,
                    self._api("query"),
                    records="records",
                    pk=["Id"],
                    cursor="SystemModstamp",
                    since=Since(build=lambda v, n=name: {"q": self._soql(n, f"SystemModstamp > {iso(v)}")}),
                    description=o.get("label") or "",
                    transform=lambda r: {k: v for k, v in r.items() if k != "attributes"},
                    write=self._write(name) if o.get("createable") else None,
                )
            )
        return out

    def _write(self, name: str) -> Write:
        def body(records: list[dict]) -> dict:
            return {"allOrNone": True, "records": [{"attributes": {"type": name}, **r} for r in records]}

        def upsert(records: list[dict], key: str) -> tuple[str, str, Any]:
            field = next((f for f in self._fields(name) if f["name"].lower() == key.lower()), None)
            if not field or not (field.get("externalId") or field.get("idLookup")):
                raise ConnectorError(f'"{key}" is not an external ID field of {name}: upserts match records by an external ID')
            return "PATCH", self._api(f"composite/sobjects/{quote(name, safe='')}/{quote(field['name'], safe='')}"), body(records)

        return Write(path=self._api("composite/sobjects"), batch=SF_BATCH, body=body, upsert=upsert, check=_sf_errors)

    def _pages(self, tbl: Table, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        if "q" not in params:
            params = {**params, "q": self._soql(tbl.name)}
        yield from super()._pages(tbl, limit, params)

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        self._table_def(table)
        return [
            column(f["name"], _SF_KIND.get(f.get("type", ""), "String"), f.get("type", ""), nullable=bool(f.get("nillable", True)), comment=f.get("label"))
            for f in self._fields(table)
        ]

    def writable_columns(self, database: str, table: str) -> Optional[list[str]]:
        return [f["name"] for f in self._fields(table) if f.get("createable") or f.get("updateable") or f.get("externalId") or f.get("idLookup")]

    def test_connection(self) -> dict:
        objects = self._object_list()
        return {"version": f"Salesforce {SF_API} · {len(objects)} queryable objects"}


# --------------------------------------------------------------------------------------------
# HubSpot
# --------------------------------------------------------------------------------------------

HS_API = "https://api.hubapi.com"
HS_BATCH = 100  # batch create / upsert: at most 100 inputs
HS_OBJECTS = ["contacts", "companies", "deals", "tickets", "products", "line_items", "quotes", "calls", "emails", "meetings", "notes", "tasks"]

_HS_KIND = {"number": "Double", "bool": "Boolean", "date": "Date", "datetime": "Timestamp"}


def _hs_errors(body: Any) -> Optional[str]:
    """Batch answers report failed inputs under errors (HTTP 207 multi-status)."""
    errs = body.get("errors") if isinstance(body, dict) else None
    if errs:
        e = errs[0]
        return f"{e.get('category') or 'error'}: {e.get('message')}" + (f" (and {len(errs) - 1} more)" if len(errs) > 1 else "")
    return None


def _hs_record(r: dict) -> dict:
    return {"id": r.get("id"), "createdAt": r.get("createdAt"), "updatedAt": r.get("updatedAt"), "archived": r.get("archived"), **(r.get("properties") or {})}


class HubSpotConnector(RestConnector):
    paging = Paging("token", token_param="after", next_path="paging.next.after")
    exports_records = True
    oauth_based = True

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        # a private app token, or OAuth (refresh token from Sign in)
        self.auth = "bearer" if secrets.get("token") else "oauth2"
        self._props: dict[str, list[dict]] = {}
        self._custom: Optional[list[dict]] = None

    def base_url(self) -> str:
        return HS_API

    def database(self) -> str:
        return "HubSpot"

    def oauth(self) -> Optional[OAuth2]:
        if not self.secrets.get("refresh_token"):
            return None
        return OAuth2(f"{HS_API}/oauth/v1/token", "refresh_token", self.config.get("client_id") or "", self.secrets.get("client_secret") or "",
                      refresh_token=self.secrets["refresh_token"])

    def _custom_objects(self) -> list[dict]:
        if self._custom is None:
            try:
                body = self.body(self.request("GET", self.url("crm/v3/schemas"), "Could not list custom objects"))
                self._custom = body.get("results", [])
            except ConnectorError:
                self._custom = []  # the token lacks the custom objects schema scope
        return self._custom

    def _objects(self) -> list[tuple[str, str, str]]:
        """(table name, object type in URLs, label)."""
        out = [(o, o, o.replace("_", " ").title()) for o in HS_OBJECTS]
        for c in self._custom_objects():
            label = (c.get("labels") or {}).get("plural") or c.get("name")
            out.append((c.get("name") or c["objectTypeId"], c["objectTypeId"], label))
        return out

    def _type(self, table: str) -> str:
        t = next((o for o in self._objects() if o[0] == table), None)
        if not t:
            raise ConnectorError(f'"{table}" is not a HubSpot object')
        return t[1]

    def _properties(self, table: str) -> list[dict]:
        if table not in self._props:
            body = self.body(self.request("GET", self.url(f"crm/v3/properties/{quote(self._type(table), safe='')}"), f"Could not read the properties of {table}"))
            self._props[table] = [p for p in body.get("results", []) if not p.get("hidden")]
        return self._props[table]

    def discover(self) -> list[Table]:
        tables = []
        for name, otype, label in self._objects():
            path = f"crm/v3/objects/{quote(otype, safe='')}"
            tables.append(
                Table(
                    name,
                    path,
                    records="results",
                    params={"limit": 100},
                    pk=["id"],
                    cursor="updatedAt",
                    description=label,
                    transform=_hs_record,
                    write=self._write(path),
                )
            )
        return tables

    def _write(self, path: str) -> Write:
        def upsert(records: list[dict], key: str) -> tuple[str, str, Any]:
            inputs = []
            for r in records:
                if r.get(key) in (None, ""):
                    raise ConnectorError(f'A record has no value in the key field "{key}"')
                inputs.append({"idProperty": key, "id": str(r[key]), "properties": {k: v for k, v in r.items() if k != key}})
            return "POST", f"{path}/batch/upsert", {"inputs": inputs}

        return Write(path=f"{path}/batch/create", batch=HS_BATCH, body=lambda records: {"inputs": [{"properties": r} for r in records]}, upsert=upsert, check=_hs_errors)

    def _pages(self, tbl: Table, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        if "properties" not in params:
            params = {**params, "properties": ",".join(p["name"] for p in self._properties(tbl.name))}
        yield from super()._pages(tbl, limit, params)

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        cols = [
            column("id", "String", "object id", nullable=False),
            column("createdAt", "Timestamp", "datetime"),
            column("updatedAt", "Timestamp", "datetime"),
            column("archived", "Boolean", "bool"),
        ]
        fixed = {c["name"] for c in cols}
        for p in self._properties(table):
            if p["name"] not in fixed:
                cols.append(column(p["name"], _HS_KIND.get(p.get("type", ""), "String"), p.get("type", ""), comment=p.get("label")))
        return cols

    def writable_columns(self, database: str, table: str) -> Optional[list[str]]:
        return [p["name"] for p in self._properties(table) if not (p.get("modificationMetadata") or {}).get("readOnlyValue") and not p.get("calculated")]

    def test_connection(self) -> dict:
        for _ in self._pages(self._table_def("contacts"), 1, {}):
            break
        return {"version": f"HubSpot CRM v3 · {len(self._objects())} objects"}
