"""SaaS application connectors on the REST base (rest.py), each following its vendor's API docs.

Every class names its documentation; tables are the documented list endpoints. Incremental
filters (`Since`) are used where the API documents a "modified since" parameter; elsewhere
incremental syncs filter the cursor here while reading.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator, Optional
from urllib.parse import quote

from .base import ConnectorError
from .rest import OAuth2, Paging, RestConnector, Since, Table, Write, dig, flatten, iso

ODATA_PAGE = Paging("offset", 500, "$top", "$skip")


def _odata_ts(field: str) -> Since:
    return Since(build=lambda v, f=field: {"$filter": f"{f} gt {iso(v)}"})


# --------------------------------------------------------------------------------------------
# Act! CRM — Act! Web API (Act! Web API Administrator's Guide; apimta.act.com/act.web.api)
# GET {url}/authorize with Basic auth and the Act-Database-Name header returns a JWT, sent as a
# Bearer token. Collections take OData $top / $skip / $filter. Table exports POST one entity per
# request to the collection (POST api/contacts with the contact's fields).
# --------------------------------------------------------------------------------------------


class ActCrmConnector(RestConnector):
    auth = "custom"
    paging = ODATA_PAGE
    exports_records = True
    tables = [
        Table("contacts", "api/contacts", pk=["id"], cursor="edited", since=_odata_ts("edited"), write=Write()),
        Table("companies", "api/companies", pk=["id"], cursor="edited", since=_odata_ts("edited"), write=Write()),
        Table("groups", "api/groups", pk=["id"], cursor="edited", since=_odata_ts("edited"), write=Write()),
        Table("opportunities", "api/opportunities", pk=["id"], cursor="edited", since=_odata_ts("edited"), write=Write()),
        Table("activities", "api/activities", pk=["id"], cursor="edited", since=_odata_ts("edited"), write=Write()),
        Table("histories", "api/histories", pk=["id"], cursor="edited", since=_odata_ts("edited"), write=Write()),
        Table("products", "api/products", pk=["id"], write=Write()),
    ]

    def base_url(self) -> str:
        return str(self.config.get("url") or "https://apius.act.com/act.web.api").rstrip("/")

    def database(self) -> str:
        return self.config.get("act_database") or "Act!"

    def authenticate(self) -> None:
        r = self.http.get(
            f"{self.base_url()}/authorize",
            auth=(self.config["user"], self.secrets.get("password", "")),
            headers={"Act-Database-Name": self.config["act_database"]},
        )
        if r.status_code >= 400:
            raise ConnectorError(f"Act! sign-in failed: HTTP {r.status_code} {self.reason(r)}")
        self.session_headers = {"Authorization": f"Bearer {r.text.strip().strip(chr(34))}"}


# --------------------------------------------------------------------------------------------
# Act-On — REST API (developer.act-on.com). OAuth 2.0 password grant at /token; lists at
# /api/1/list, a list's contacts at /api/1/list/{id}?count&offset as {headers, data}. Table
# exports add contacts to a list (POST /api/1/list/{id}/record, the record's fields as JSON); with
# the e-mail as key field they upsert (PUT /api/1/list/{id}/record?email=…).
# --------------------------------------------------------------------------------------------


def _acton_write(list_id: str) -> Write:
    def upsert(records: list[dict], key: str) -> tuple[str, str, Any]:
        email = records[0].get(key)
        if not email:
            raise ConnectorError(f"Act-On upserts contacts by e-mail: the key field {key} is empty")
        return "PUT", f"api/1/list/{list_id}/record?email={quote(str(email))}", records[0]

    def check(body: Any) -> Optional[str]:
        if isinstance(body, dict) and str(body.get("status", "")).lower() in ("error", "failure"):
            return str(body.get("message") or body)
        return None

    return Write(path=f"api/1/list/{list_id}/record", body=lambda records: records[0], upsert=upsert, check=check)


class ActOnConnector(RestConnector):
    auth = "oauth2"
    exports_records = True

    def base_url(self) -> str:
        return str(self.config.get("url") or "https://api.actonsoftware.com").rstrip("/")

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            self.config.get("token_url") or "https://restapi.actonsoftware.com/token",
            "password",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            username=self.config.get("user") or "",
            password=self.secrets.get("password") or "",
        )

    def database(self) -> str:
        return "Act-On"

    @staticmethod
    def _lists(body: Any) -> list[dict]:
        """GET /api/1/list answers folders of entries (or a flat result list)."""
        out = []
        for folder in body.get("folders", []) if isinstance(body, dict) else []:
            for e in folder.get("entries", []):
                out.append({**e, "folder": folder.get("name")})
        if not out and isinstance(body, dict):
            out = body.get("result") or body.get("lists") or []
        return out

    def discover(self) -> list[Table]:
        tables = [Table("lists", "api/1/list", params={"listingtype": "CONTACT_LIST"}, pk=["id"], transform=None)]
        if not hasattr(self, "_list_cache"):
            r = self.request("GET", self.url("api/1/list"), "Could not list contact lists", params={"listingtype": "CONTACT_LIST"})
            self._list_cache = self._lists(self.body(r))
        for entry in self._list_cache:
            if entry.get("id"):
                tables.append(Table(f"list: {entry.get('name') or entry['id']}", f"api/1/list/{entry['id']}", description=f"Contacts of list {entry['id']}",
                                    write=_acton_write(str(entry["id"]))))
        return tables

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        if tbl.name == "lists":
            r = self.request("GET", url, "Could not list contact lists", params=tbl.params)
            recs = self._lists(self.body(r))
            yield recs[:limit] if limit else recs
            return
        offset, left = 0, limit
        while True:
            count = min(1000, left) if left else 1000
            body = self.body(self.request("GET", url, f"Reading {tbl.name} failed", params={"count": count, "offset": offset}))
            headers, data = body.get("headers", []), body.get("data", [])
            recs = [dict(zip(headers, row)) for row in data]
            if recs:
                yield recs
            if left is not None:
                left -= len(recs)
            if len(recs) < count or (left is not None and left <= 0):
                return
            offset += len(recs)


# --------------------------------------------------------------------------------------------
# ActiveCampaign — API v3 (developers.activecampaign.com): {account}.api-us1.com/api/3, the
# Api-Token header, limit (≤ 100) / offset paging, records under the resource's name. Table
# exports POST one record per request wrapped in its singular name ({"contact": {...}}); contacts
# keyed by email upsert through POST contact/sync.
# --------------------------------------------------------------------------------------------


def _ac_write(one: str, sync: bool = False) -> Write:
    def upsert(records: list[dict], key: str) -> tuple[str, str, Any]:
        if key != "email":
            raise ConnectorError("ActiveCampaign updates contacts by email: use email as the key field")
        return "POST", "contact/sync", {one: records[0]}

    return Write(body=lambda records: {one: records[0]}, upsert=upsert if sync else None)


def _ac(name: str, key: str = "", cursor: Optional[str] = None, since: Optional[str] = None, write: Optional[Write] = None) -> Table:
    return Table(
        name,
        name,
        records=key or name,
        pk=["id"],
        cursor=cursor,
        since=Since(since, extra={}) if since else None,
        write=write,
    )


class ActiveCampaignConnector(RestConnector):
    auth = "header"
    auth_header = "Api-Token"
    paging = Paging("offset", 100)
    exports_records = True
    tables = [
        _ac("contacts", cursor="udate", since="filters[updated_after]", write=_ac_write("contact", sync=True)),
        _ac("accounts", write=_ac_write("account")),
        _ac("deals", cursor="mdate", since="filters[updated_after]", write=_ac_write("deal")),
        _ac("lists", write=_ac_write("list")),
        _ac("campaigns"),
        _ac("messages"),
        _ac("automations"),
        _ac("tags", write=_ac_write("tag")),
        _ac("users"),
        _ac("fields"),
        _ac("dealStages"),
        _ac("dealGroups"),
        _ac("notes", write=_ac_write("note")),
        _ac("contactAutomations", write=_ac_write("contactAutomation")),
    ]

    def base_url(self) -> str:
        url = str(self.config.get("url") or "").rstrip("/")
        return url if url.endswith("/api/3") else f"{url}/api/3"

    def database(self) -> str:
        return "ActiveCampaign"


# --------------------------------------------------------------------------------------------
# Adobe Analytics — Analytics 2.0 APIs (developer.adobe.com/analytics-apis): OAuth
# Server-to-Server credentials (client_credentials at ims-na1.adobelogin.com/ims/token/v3);
# x-api-key = client ID; analytics.adobe.io/api/{globalCompanyId}. The company comes from the
# discovery service when not given. "report" runs POST /reports by day for chosen metrics.
# --------------------------------------------------------------------------------------------

_ADOBE_PAGE = Paging("page", 1000, limit_param="limit", page_param="page", start=0)


class AdobeAnalyticsConnector(RestConnector):
    auth = "oauth2"

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            "https://ims-na1.adobelogin.com/ims/token/v3",
            "client_credentials",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            scope=self.config.get("scope") or "openid,AdobeID,additional_info.projectedProductContext",
        )

    def company(self) -> str:
        if not self.config.get("company_id"):
            r = self.request("GET", "https://analytics.adobe.io/discovery/me", "Could not discover the Analytics company")
            ids = [c.get("globalCompanyId") for org in self.body(r).get("imsOrgs", []) for c in org.get("companies", [])]
            if not ids:
                raise ConnectorError("The credentials have access to no Analytics company")
            self.config["company_id"] = ids[0]
        return str(self.config["company_id"])

    def extra_headers(self) -> dict[str, str]:
        h = {"x-api-key": self.config.get("client_id") or ""}
        if self.config.get("company_id"):
            h["x-proxy-global-company-id"] = self.config["company_id"]
        return h

    def base_url(self) -> str:
        return f"https://analytics.adobe.io/api/{self.company()}"

    def database(self) -> str:
        return self.config.get("rsid") or "Adobe Analytics"

    def discover(self) -> list[Table]:
        rsid = {"rsid": self.config.get("rsid") or ""}
        tables = [
            Table("report_suites", "reportsuites/collections/suites", records="content", pk=["rsid"], paging=_ADOBE_PAGE),
            Table("segments", "segments", records="content", pk=["id"], paging=_ADOBE_PAGE),
            Table("calculated_metrics", "calculatedmetrics", records="content", pk=["id"], paging=_ADOBE_PAGE),
            Table("projects", "projects", records="content", pk=["id"], paging=_ADOBE_PAGE),
            Table("date_ranges", "dateranges", records="content", pk=["id"], paging=_ADOBE_PAGE),
        ]
        if rsid["rsid"]:
            tables += [
                Table("dimensions", "dimensions", params=rsid, pk=["id"]),
                Table("metrics", "metrics", params=rsid, pk=["id"]),
                Table("report", "reports", method="POST", pk=["day"], cursor="day", description="Daily totals of the chosen metrics"),
            ]
        return tables

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        if tbl.name != "report":
            yield from super()._paged(tbl, url, limit, params)
            return
        metrics = [m.strip() for m in str(self.config.get("metrics") or "metrics/visits,metrics/pageviews").split(",") if m.strip()]
        start = str(params.get("from") or self.config.get("start_date") or (date.today() - timedelta(days=90)).isoformat())[:10]
        end = (date.today() + timedelta(days=1)).isoformat()
        page = 0
        while True:
            body = {
                "rsid": self.config["rsid"],
                "globalFilters": [{"type": "dateRange", "dateRange": f"{start}T00:00:00.000/{end}T00:00:00.000"}],
                "metricContainer": {"metrics": [{"id": m if m.startswith("metrics/") else f"metrics/{m}", "columnId": str(i)} for i, m in enumerate(metrics)]},
                "dimension": "variables/daterangeday",
                "settings": {"limit": 400, "page": page, "dimensionSort": "asc"},
            }
            data = self.body(self.request("POST", url, "Running the report failed", json=body))
            recs = []
            for row in data.get("rows", []):
                rec: dict[str, Any] = {"day": _adobe_day(row.get("value"))}
                for m, v in zip(metrics, row.get("data", [])):
                    rec[m.split("/", 1)[-1]] = v
                recs.append(rec)
            if limit:
                recs = recs[:limit]
            if recs:
                yield recs
            if data.get("lastPage", True) or (limit and len(recs) >= limit):
                return
            page += 1

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if table == "report" and lower is not None:
            return self._paged(self._table_def("report"), self.url("reports"), None, {"from": iso(lower)})
        return None


def _adobe_day(v: Any) -> Any:
    """Adobe's day values ("Jan 5, 2024") → ISO dates."""
    try:
        return datetime.strptime(str(v), "%b %d, %Y").date().isoformat()
    except ValueError:
        return v


# --------------------------------------------------------------------------------------------
# Adobe Commerce (Magento) — REST API (developer.adobe.com/commerce/webapi/rest): an
# integration's access token as Bearer; searchCriteria paging; past the last page Magento
# repeats it, so total_count stops the reading.
# --------------------------------------------------------------------------------------------

_MAGENTO_PAGE = Paging("page", 200, limit_param="searchCriteria[pageSize]", page_param="searchCriteria[currentPage]", start=1, total_path="total_count")


def _magento_since(field_: str = "updated_at") -> Since:
    def build(v: Any) -> dict:
        t = v.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if isinstance(v, datetime) else str(v)
        p = "searchCriteria[filter_groups][0][filters][0]"
        return {f"{p}[field]": field_, f"{p}[value]": t, f"{p}[condition_type]": "gteq"}

    return Since(build=build)


def _magento(name: str, path: str, pk: str = "entity_id", cursor: Optional[str] = "updated_at", write: Optional[Write] = None) -> Table:
    return Table(name, path, records="items", pk=[pk], cursor=cursor, since=_magento_since() if cursor else None, paging=_MAGENTO_PAGE, write=write)


def _magento_product_upsert(records: list[dict], key: str) -> tuple[str, str, Any]:
    """PUT /V1/products/{sku} creates the product or updates it."""
    if key != "sku":
        raise ConnectorError("Adobe Commerce updates products by SKU: use sku as the key field")
    return "PUT", f"products/{quote(str(records[0].get('sku') or ''), safe='')}", {"product": records[0]}


class AdobeCommerceConnector(RestConnector):
    """Table exports POST one entity per request (POST /V1/products {"product": {...}}); products
    keyed by sku upsert with PUT /V1/products/{sku}."""

    auth = "bearer"
    exports_records = True
    tables = [
        _magento("products", "products", "id", write=Write(path="products", body=lambda r: {"product": r[0]}, upsert=_magento_product_upsert)),
        _magento("orders", "orders"),
        _magento("customers", "customers/search", "id", write=Write(path="customers", body=lambda r: {"customer": r[0]})),
        _magento("invoices", "invoices"),
        _magento("credit_memos", "creditmemos"),
        _magento("shipments", "shipments"),
        _magento("cms_pages", "cmsPage/search", "id", cursor="update_time", write=Write(path="cmsPage", body=lambda r: {"page": r[0]})),
        _magento("categories", "categories/list", "id", write=Write(path="categories", body=lambda r: {"category": r[0]})),
    ]

    def base_url(self) -> str:
        url = str(self.config.get("url") or "").rstrip("/")
        return url if "/rest" in url else f"{url}/rest/V1"

    def database(self) -> str:
        return "Adobe Commerce"


# --------------------------------------------------------------------------------------------
# ADP Workforce Now — ADP API Central (developers.adp.com): OAuth 2.0 client credentials with
# mutual TLS (the ADP-issued client certificate on every call, the token request included),
# accounts.adp.com/auth/oauth/v2/token, api.adp.com, OData $top / $skip; 204 past the end.
# Table exports go through ADP's event APIs: each row is one event (POST /events/hr/v1/<event>)
# whose eventContext names the worker (associateOID) and whose transform carries the new value.
# --------------------------------------------------------------------------------------------


def _adp_event(event: str, field: str, path: list[str]) -> Write:
    def body(records: list[dict]) -> dict:
        r = records[0]
        if not r.get("associateOID"):
            raise ConnectorError("each row needs the worker's associateOID")
        value: Any = {field: r.get(field)}
        for p in reversed(path):
            value = {p: value}
        return {"events": [{"data": {"eventContext": {"worker": {"associateOID": r["associateOID"]}}, "transform": {"worker": value}}}]}

    def check(answer: Any) -> Optional[str]:
        events = answer.get("events") if isinstance(answer, dict) else None
        problems = [m.get("userMessage", {}).get("messageTxt") or str(m) for e in events or [] for m in (e.get("confirmMessage", {}) or {}).get("processMessages", [])
                    if str(m.get("messageTypeCode", {}).get("codeValue", "")).lower() == "error"]
        return "; ".join(problems) or None

    return Write(path=f"events/hr/v1/{event}", body=body, check=check)


ADP_EVENTS = [
    ("worker.business-communication.email.change", "emailUri", ["businessCommunication", "email"]),
    ("worker.personal-communication.email.change", "emailUri", ["person", "communication", "email"]),
    ("worker.personal-communication.mobile.change", "formattedNumber", ["person", "communication", "mobile"]),
    ("worker.personal-communication.landline.change", "formattedNumber", ["person", "communication", "landline"]),
]


class AdpConnector(RestConnector):
    auth = "oauth2"
    exports_records = True
    paging = Paging("offset", 100, "$top", "$skip")
    tables = [
        Table("workers", "hr/v2/workers", records="workers", pk=["associateOID"], transform=lambda r: flatten(r, depth=1)),
        Table("worker_demographics", "hr/v2/worker-demographics", records="workers", pk=["associateOID"], transform=lambda r: flatten(r, depth=1)),
        Table("organization_departments", "core/v1/organization-departments", records="organizationDepartments"),
        Table("work_assignments_meta", "hr/v2/workers/meta", records="meta", paging=Paging()),
        # write-only: table exports send one event per row
        *[Table(f"event: {e}", f"events/hr/v1/{e}/meta", records="meta", paging=Paging(), columns=[("associateOID", "String", "string"), (f, "String", "string")],
                description=f"Export rows (associateOID, {f}) as {e} events", write=_adp_event(e, f, p)) for e, f, p in ADP_EVENTS],
    ]

    def writable_columns(self, database: str, table: str) -> Optional[list[str]]:
        t = self._table_def(table)
        return [c[0] for c in t.columns] if t.columns and t.write else None

    def base_url(self) -> str:
        return str(self.config.get("url") or "https://api.adp.com").rstrip("/")

    def client_cert(self) -> Optional[tuple[str, str]]:
        return self.secrets.get("certificate") or "", self.secrets.get("private_key") or ""

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            self.config.get("token_url") or "https://accounts.adp.com/auth/oauth/v2/token",
            "client_credentials",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            client_auth="basic",
        )

    def database(self) -> str:
        return "ADP Workforce Now"


# --------------------------------------------------------------------------------------------
# Authorize.Net — API reference (developer.authorize.net/api/reference): one JSON endpoint;
# merchantAuthentication {name, transactionKey} in each request. Settled batches are listed per
# date range (at most 31 days), their transactions per batch with paging {limit, offset=page}.
# --------------------------------------------------------------------------------------------


class AuthorizeNetConnector(RestConnector):
    tables = [
        Table("settled_batches", "", pk=["batchId"], cursor="settlementTimeUTC"),
        Table("transactions", "", pk=["transId"], cursor="submitTimeUTC"),
        Table("unsettled_transactions", "", pk=["transId"]),
        Table("customer_profile_ids", "", pk=["value"]),
        Table("subscriptions", "", pk=["id"]),
    ]

    def base_url(self) -> str:
        host = "apitest.authorize.net" if self.config.get("sandbox") else "api.authorize.net"
        return f"https://{host}/xml/v1/request.api"

    def database(self) -> str:
        return "Authorize.Net"

    def call(self, name: str, payload: dict) -> dict:
        body = {name: {"merchantAuthentication": {"name": self.config["api_login_id"], "transactionKey": self.secrets.get("transaction_key", "")}, **payload}}
        data = self.body(self.request("POST", self.base_url(), f"{name} failed", json=body))
        msg = data.get("messages", {})
        if msg.get("resultCode") == "Error":
            m = (msg.get("message") or [{}])[0]
            if m.get("code") == "I00004":  # no records found
                return {}
            raise ConnectorError(f"{name} failed: {m.get('code')} {m.get('text')}")
        return data

    def test_connection(self) -> dict:
        self.call("authenticateTestRequest", {})
        return {"version": f"Authorize.Net ({'sandbox' if self.config.get('sandbox') else 'production'})"}

    def _batches(self, since: Optional[datetime]) -> Iterator[list[dict]]:
        start = since or datetime.combine(date.fromisoformat(str(self.config.get("start_date") or (date.today() - timedelta(days=365)).isoformat())[:10]), datetime.min.time(), timezone.utc)
        now = datetime.now(timezone.utc)
        while start < now:
            end = min(start + timedelta(days=30), now)
            data = self.call("getSettledBatchListRequest", {"includeStatistics": False, "firstSettlementDate": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "lastSettlementDate": end.strftime("%Y-%m-%dT%H:%M:%SZ")})
            if data.get("batchList"):
                yield data["batchList"]
            start = end

    def _paged_call(self, name: str, payload: dict, key: str, sub: str = "") -> Iterator[list[dict]]:
        page = 1
        while True:
            data = self.call(name, {**payload, "paging": {"limit": 1000, "offset": page}})
            recs = dig(data, key) or []
            if sub and isinstance(recs, dict):
                recs = recs.get(sub, [])
            if recs:
                yield recs
            if len(recs) < 1000:
                return
            page += 1

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        since = params.get("since")
        if tbl.name == "settled_batches":
            gen = self._batches(since)
        elif tbl.name == "transactions":
            gen = (
                [{"batchId": b["batchId"], **t} for t in recs]
                for batch in self._batches(since)
                for b in batch
                for recs in self._paged_call("getTransactionListRequest", {"batchId": b["batchId"], "sorting": {"orderBy": "submitTimeUTC", "orderDescending": False}}, "transactions")
            )
        elif tbl.name == "unsettled_transactions":
            gen = self._paged_call("getUnsettledTransactionListRequest", {"sorting": {"orderBy": "submitTimeUTC", "orderDescending": False}}, "transactions")
        elif tbl.name == "customer_profile_ids":
            data = self.call("getCustomerProfileIdsRequest", {})
            gen = iter([[{"value": i} for i in data.get("ids", [])]])
        else:
            gen = self._paged_call("ARBGetSubscriptionListRequest", {"searchType": "subscriptionActive", "sorting": {"orderBy": "id", "orderDescending": False}}, "subscriptionDetails")
        left = limit
        for recs in gen:
            if left is not None:
                recs = recs[:left]
                left -= len(recs)
            if recs:
                yield recs
            if left is not None and left <= 0:
                return

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if table in ("settled_batches", "transactions") and isinstance(lower, datetime):
            return self._paged(self._table_def(table), "", None, {"since": lower - timedelta(days=2)})
        return None


# --------------------------------------------------------------------------------------------
# Avalara AvaTax — REST v2 (developer.avalara.com/api-reference/avatax/rest/v2): Basic auth
# (account ID + license key, or user + password), the X-Avalara-Client header, $top/$skip with
# @nextLink, $filter. Transactions, nexus, items and customers are read per company.
# --------------------------------------------------------------------------------------------

_AVA_PAGE = Paging("next", next_path="@nextLink")


class AvalaraConnector(RestConnector):
    auth = "basic"
    paging = _AVA_PAGE
    tables = [
        Table("companies", "companies", records="value", pk=["id"], params={"$top": 1000}),
        Table("transactions", "companies/{companyCode}/transactions", records="value", pk=["id"], each=("companies", "companyCode", "companyCode"),
              cursor="modifiedDate", since=Since(build=lambda v: {"$filter": f"modifiedDate gt '{iso(v)}'"}), params={"$top": 1000}),
        Table("nexus", "companies/{companyId}/nexus", records="value", pk=["id"], each=("companies", "id", "companyId")),
        Table("items", "companies/{companyId}/items", records="value", pk=["id"], each=("companies", "id", "companyId")),
        Table("customers", "companies/{companyId}/customers", records="value", pk=["id"], each=("companies", "id", "companyId")),
        Table("tax_codes", "definitions/taxcodes", records="value", pk=["id"], params={"$top": 1000}),
    ]

    def base_url(self) -> str:
        return "https://sandbox-rest.avatax.com/api/v2" if self.config.get("sandbox") else "https://rest.avatax.com/api/v2"

    def extra_headers(self) -> dict[str, str]:
        return {"X-Avalara-Client": "BluesandAI; 1.0; Data Connection; 1.0"}

    def database(self) -> str:
        return "AvaTax"


# --------------------------------------------------------------------------------------------
# Microsoft Entra ID (Azure Active Directory) — Microsoft Graph v1.0: client credentials at
# login.microsoftonline.com/{tenant}/oauth2/v2.0/token with scope https://graph.microsoft.com/.default
# (application permissions such as Directory.Read.All), records in value, @odata.nextLink.
# --------------------------------------------------------------------------------------------


def _ms_oauth(c: RestConnector, scope: str) -> OAuth2:
    return OAuth2(
        f"https://login.microsoftonline.com/{c.config.get('tenant_id') or 'common'}/oauth2/v2.0/token",
        "client_credentials",
        c.config.get("client_id") or "",
        c.secrets.get("client_secret") or "",
        scope=scope,
    )


_GRAPH_PAGE = Paging("next", next_path="@odata.nextLink")


class AzureAdConnector(RestConnector):
    auth = "oauth2"
    paging = _GRAPH_PAGE
    tables = [
        Table("users", "users", records="value", pk=["id"], params={"$top": 999}),
        Table("groups", "groups", records="value", pk=["id"], params={"$top": 999}),
        Table("devices", "devices", records="value", pk=["id"], params={"$top": 999}),
        Table("applications", "applications", records="value", pk=["id"], params={"$top": 999}),
        Table("service_principals", "servicePrincipals", records="value", pk=["id"], params={"$top": 999}),
        Table("directory_roles", "directoryRoles", records="value", pk=["id"]),
        Table("organization", "organization", records="value", pk=["id"]),
        Table("subscribed_skus", "subscribedSkus", records="value", pk=["id"]),
        Table("org_contacts", "contacts", records="value", pk=["id"]),
        Table("directory_audits", "auditLogs/directoryAudits", records="value", pk=["id"], cursor="activityDateTime",
              since=Since(build=lambda v: {"$filter": f"activityDateTime gt {iso(v)}"})),
        Table("sign_ins", "auditLogs/signIns", records="value", pk=["id"], cursor="createdDateTime",
              since=Since(build=lambda v: {"$filter": f"createdDateTime gt {iso(v)}"})),
    ]

    def base_url(self) -> str:
        return "https://graph.microsoft.com/v1.0"

    def oauth(self) -> Optional[OAuth2]:
        return _ms_oauth(self, "https://graph.microsoft.com/.default")

    def database(self) -> str:
        return self.config.get("tenant_id") or "Entra ID"


# --------------------------------------------------------------------------------------------
# Azure Data Catalog — REST API 2016-03-30: an Entra ID token for https://api.azuredatacatalog.com;
# GET catalogs/{catalog}/search/search?searchTerms=&count=&startPage= → results[].content.
# --------------------------------------------------------------------------------------------


def _adc_record(r: dict) -> dict:
    content = r.get("content") or {}
    props = content.get("properties") or {}
    return {
        "id": r.get("id") or content.get("id"),
        "name": props.get("name"),
        "type": r.get("type") or content.get("type"),
        "source_type": dig(props, "dataSource.sourceType"),
        "object_type": dig(props, "dataSource.objectType"),
        "location": json.dumps(props.get("dsl")) if props.get("dsl") else None,
        "updated": r.get("updatedAt") or content.get("timestamp"),
        "annotations": json.dumps(content.get("annotations")) if content.get("annotations") else None,
        "content": content,
    }


class AzureDataCatalogConnector(RestConnector):
    auth = "oauth2"
    paging = Paging("page", 100, limit_param="count", page_param="startPage", start=1)

    def base_url(self) -> str:
        return f"https://api.azuredatacatalog.com/catalogs/{quote(self.config.get('catalog') or 'DefaultCatalog')}"

    def oauth(self) -> Optional[OAuth2]:
        return _ms_oauth(self, "https://api.azuredatacatalog.com/.default")

    def database(self) -> str:
        return self.config.get("catalog") or "DefaultCatalog"

    def discover(self) -> list[Table]:
        v = {"api-version": "2016-03-30"}
        return [
            Table("assets", "search/search", records="results", params={**v, "searchTerms": "*"}, transform=_adc_record),
            Table("tables", "search/search", records="results", params={**v, "searchTerms": "objectType:Table"}, transform=_adc_record),
            Table("reports", "search/search", records="results", params={**v, "searchTerms": "objectType:Report"}, transform=_adc_record),
        ]


# --------------------------------------------------------------------------------------------
# Azure DevOps — REST API 7.1 (dev.azure.com/{organization}): a personal access token as Basic
# auth with an empty user; continuation tokens in the x-ms-continuationtoken header; work items
# through a WIQL query, then read 200 ids at a time.
# --------------------------------------------------------------------------------------------

_ADO_PAGE = Paging("token", token_param="continuationToken", token_header="x-ms-continuationtoken")
_V = {"api-version": "7.1"}


class AzureDevOpsConnector(RestConnector):
    paging = _ADO_PAGE
    tables = [
        Table("projects", "_apis/projects", records="value", pk=["id"], params={**_V, "$top": 500}),
        Table("teams", "_apis/teams", records="value", pk=["id"], params={"api-version": "7.1-preview.3", "$top": 500}),
        Table("repositories", "_apis/git/repositories", records="value", pk=["id"], params=_V),
        Table("builds", "{project}/_apis/build/builds", records="value", pk=["id"], each=("projects", "name", "project"), params={**_V, "$top": 1000},
              cursor="lastChangedDate"),
        Table("pipelines", "{project}/_apis/pipelines", records="value", pk=["id"], each=("projects", "name", "project"), params=_V),
        Table("pull_requests", "{project}/_apis/git/pullrequests", records="value", pk=["pullRequestId"], each=("projects", "name", "project"),
              params={**_V, "searchCriteria.status": "all", "$top": 1000}),
        Table("work_items", "{project}/_apis/wit/wiql", pk=["id"], cursor="System.ChangedDate"),
    ]

    def base_url(self) -> str:
        return f"https://dev.azure.com/{quote(self.config['organization'])}"

    def _basic(self) -> Optional[tuple[str, str]]:
        return ("", self.secrets.get("token", ""))

    def database(self) -> str:
        return self.config.get("organization") or "Azure DevOps"

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        if tbl.name != "work_items":
            yield from super()._paged(tbl, url, limit, params)
            return
        since = params.get("since")
        where = f" AND [System.ChangedDate] >= '{since.strftime('%Y-%m-%dT%H:%M:%SZ')}'" if isinstance(since, datetime) else ""
        left = limit
        for batch in self._pages(self._table_def("projects"), None, {}):
            for p in batch:
                wiql = {"query": f"SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{p['name'].replace(chr(39), chr(39) * 2)}'{where} ORDER BY [System.ChangedDate]"}
                res = self.body(self.request("POST", self.url(f"{quote(p['name'])}/_apis/wit/wiql"), "Work item query failed", params={**_V, "$top": 20000}, json=wiql))
                ids = [w["id"] for w in res.get("workItems", [])]
                for i in range(0, len(ids), 200):
                    chunk = ids[i : i + 200]
                    data = self.body(self.request("GET", self.url("_apis/wit/workitems"), "Reading work items failed", params={**_V, "ids": ",".join(map(str, chunk)), "$expand": "fields"}))
                    recs = [{"id": w["id"], "rev": w.get("rev"), "project": p["name"], **w.get("fields", {})} for w in data.get("value", [])]
                    if left is not None:
                        recs = recs[:left]
                        left -= len(recs)
                    if recs:
                        yield recs
                    if left is not None and left <= 0:
                        return

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if table == "work_items" and isinstance(lower, datetime):
            return self._paged(self._table_def(table), "", None, {"since": lower})
        return None


# --------------------------------------------------------------------------------------------
# Basecamp — Basecamp 4 API (github.com/basecamp/bc3-api): OAuth 2.0 only (Launchpad), a
# User-Agent with contact details, 3.basecampapi.com/{account_id}, Link header paging.
# --------------------------------------------------------------------------------------------

_RECORDING_TYPES = ["Todo", "Todolist", "Message", "Document", "Comment", "Upload", "Schedule::Entry", "Question::Answer", "Vault"]


class BasecampConnector(RestConnector):
    auth = "oauth2"
    paging = Paging("link")

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            "https://launchpad.37signals.com/authorization/token",
            "refresh_token",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            type="refresh",
            refresh_token=self.secrets.get("refresh_token") or "",
        )

    def base_url(self) -> str:
        return f"https://3.basecampapi.com/{self.config['account_id']}"

    def database(self) -> str:
        return f"Basecamp {self.config.get('account_id', '')}".strip()

    def discover(self) -> list[Table]:
        tables = [
            Table("projects", "projects.json", pk=["id"]),
            Table("archived_projects", "projects.json", params={"status": "archived"}, pk=["id"]),
            Table("people", "people.json", pk=["id"]),
        ]
        for t in _RECORDING_TYPES:
            tables.append(Table(f"recordings: {t}", "projects/recordings.json", params={"type": t, "sort": "updated_at", "direction": "asc"}, pk=["id"],
                                transform=lambda r: flatten(r, depth=1)))
        return tables


# --------------------------------------------------------------------------------------------
# Asana — REST API 1.0 (developers.asana.com): a personal access token or OAuth (Bearer);
# limit ≤ 100 with the next_page offset; workspace-scoped lists; tasks per project with
# modified_since.
# --------------------------------------------------------------------------------------------

_ASANA = Paging("next", next_path="next_page.uri")
_TASK_FIELDS = "name,completed,completed_at,created_at,modified_at,due_on,start_on,assignee.name,assignee.gid,notes,num_subtasks,permalink_url,resource_subtype,parent.gid,memberships.section.name"


class AsanaConnector(RestConnector):
    paging = _ASANA
    tables = [
        Table("workspaces", "workspaces", records="data", pk=["gid"], params={"limit": 100}),
        Table("users", "workspaces/{workspace}/users", records="data", pk=["gid"], each=("workspaces", "gid", "workspace"), params={"limit": 100, "opt_fields": "name,email"}),
        Table("teams", "workspaces/{workspace}/teams", records="data", pk=["gid"], each=("workspaces", "gid", "workspace"), params={"limit": 100}),
        Table("projects", "workspaces/{workspace}/projects", records="data", pk=["gid"], each=("workspaces", "gid", "workspace"),
              params={"limit": 100, "opt_fields": "name,archived,created_at,modified_at,owner.name,team.name,due_on,current_status_update.title"}),
        Table("tags", "workspaces/{workspace}/tags", records="data", pk=["gid"], each=("workspaces", "gid", "workspace"), params={"limit": 100}),
        Table("tasks", "projects/{project}/tasks", records="data", pk=["gid"], each=("projects", "gid", "project"), params={"limit": 100, "opt_fields": _TASK_FIELDS},
              cursor="modified_at", since=Since("modified_since", extra={"limit": 100, "opt_fields": _TASK_FIELDS}), transform=lambda r: flatten(r, depth=1)),
        Table("sections", "projects/{project}/sections", records="data", pk=["gid"], each=("projects", "gid", "project"), params={"limit": 100}),
    ]

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self.auth = "oauth2" if secrets.get("refresh_token") else "bearer"

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            "https://app.asana.com/-/oauth_token",
            "refresh_token",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            refresh_token=self.secrets.get("refresh_token") or "",
        )

    def base_url(self) -> str:
        return "https://app.asana.com/api/1.0"

    def database(self) -> str:
        return "Asana"


# --------------------------------------------------------------------------------------------
# BigCommerce — REST API (developer.bigcommerce.com): api.bigcommerce.com/stores/{store_hash},
# the X-Auth-Token header; v3 pages with meta.pagination, v2 answers 204 past the last page.
# --------------------------------------------------------------------------------------------

_BC3 = Paging("page", 250, limit_param="limit", page_param="page", start=1, total_path="meta.pagination.total_pages", total_pages=True)
_BC2 = Paging("page", 250, limit_param="limit", page_param="page", start=1)


def _bc_since(param: str) -> Since:
    return Since(param, format=lambda v: iso(v))


class BigCommerceConnector(RestConnector):
    auth = "header"
    auth_header = "X-Auth-Token"
    tables = [
        Table("products", "v3/catalog/products", records="data", pk=["id"], cursor="date_modified", since=_bc_since("date_modified:min"), paging=_BC3),
        Table("categories", "v3/catalog/categories", records="data", pk=["id"], paging=_BC3),
        Table("brands", "v3/catalog/brands", records="data", pk=["id"], paging=_BC3),
        Table("customers", "v3/customers", records="data", pk=["id"], cursor="date_modified", since=_bc_since("date_modified:min"), paging=_BC3),
        Table("price_lists", "v3/pricelists", records="data", pk=["id"], paging=_BC3),
        Table("channels", "v3/channels", records="data", pk=["id"], paging=_BC3),
        Table("orders", "v2/orders", pk=["id"], cursor="date_modified", since=_bc_since("min_date_modified"), paging=_BC2),
        Table("coupons", "v2/coupons", pk=["id"], paging=_BC2),
    ]

    def base_url(self) -> str:
        return f"https://api.bigcommerce.com/stores/{self.config['store_hash']}"

    def database(self) -> str:
        return self.config.get("store_hash") or "BigCommerce"


# --------------------------------------------------------------------------------------------
# Blackbaud Raiser's Edge NXT — SKY API (developer.blackbaud.com/skyapi): OAuth 2.0
# authorization code (oauth2.sky.blackbaud.com), the Bb-Api-Subscription-Key header,
# api.sky.blackbaud.com, records in value with next_link.
# --------------------------------------------------------------------------------------------

_SKY = Paging("next", next_path="next_link")


class BlackbaudConnector(RestConnector):
    auth = "oauth2"
    paging = _SKY
    tables = [
        Table("constituents", "constituent/v1/constituents", records="value", pk=["id"], params={"limit": 500}, cursor="date_modified",
              since=Since("date_modified", extra={"limit": 500})),
        Table("gifts", "gift/v1/gifts", records="value", pk=["id"], params={"limit": 500}, cursor="date_modified",
              since=Since("last_modified", extra={"limit": 500})),
        Table("actions", "constituent/v1/actions", records="value", pk=["id"], params={"limit": 500}, cursor="date_modified",
              since=Since("date_modified", extra={"limit": 500})),
        Table("campaigns", "fundraising/v1/campaigns", records="value", pk=["id"], params={"limit": 500}),
        Table("funds", "fundraising/v1/funds", records="value", pk=["id"], params={"limit": 500}),
        Table("appeals", "fundraising/v1/appeals", records="value", pk=["id"], params={"limit": 500}),
        Table("opportunities", "opportunity/v1/opportunities", records="value", pk=["id"], params={"limit": 500}),
        Table("events", "event/v1/eventlist", records="value", pk=["id"], params={"limit": 500}),
    ]

    def base_url(self) -> str:
        return "https://api.sky.blackbaud.com"

    def extra_headers(self) -> dict[str, str]:
        return {"Bb-Api-Subscription-Key": self.secrets.get("subscription_key", "")}

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            "https://oauth2.sky.blackbaud.com/token",
            "refresh_token",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            refresh_token=self.secrets.get("refresh_token") or "",
        )

    def database(self) -> str:
        return "Raiser's Edge NXT"


# --------------------------------------------------------------------------------------------
# Bugzilla — REST API v1 (bugzilla.readthedocs.io/en/latest/api): {url}/rest, an API key in
# the X-BUGZILLA-API-KEY header; bug search with limit / offset and last_change_time.
# --------------------------------------------------------------------------------------------


class BugzillaConnector(RestConnector):
    auth = "header"
    auth_header = "X-BUGZILLA-API-KEY"
    tables = [
        Table("bugs", "bug", records="bugs", pk=["id"], params={"order": "bug_id"}, cursor="last_change_time", since=Since("last_change_time"),
              paging=Paging("offset", 500)),
        Table("products", "product", records="products", pk=["id"], params={"type": "accessible"}),
        Table("classifications", "classification/_all", records="classifications", pk=["id"]),
    ]

    def base_url(self) -> str:
        url = str(self.config.get("url") or "").rstrip("/")
        return url if url.endswith("/rest") else f"{url}/rest"

    def database(self) -> str:
        return "Bugzilla"


# --------------------------------------------------------------------------------------------
# SAP Ariba — Operational Reporting for Procurement API (Synchronous + View Management):
# OAuth client credentials at api.ariba.com/v2/oauth/token?grant_type=openapi_2lo (Basic
# client ID:secret), the apiKey header, realm on every call; view templates are the tables, read
# with updatedDateFrom/To filters (one year at most per call) and pageToken paging.
# --------------------------------------------------------------------------------------------


class AribaConnector(RestConnector):
    auth = "oauth2"
    paging = Paging("token", token_param="pageToken", next_path="PageToken")

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            self.config.get("token_url") or "https://api.ariba.com/v2/oauth/token",
            "openapi_2lo",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            client_auth="basic",
        )

    def extra_headers(self) -> dict[str, str]:
        return {"apiKey": self.secrets.get("api_key", "")}

    def base_url(self) -> str:
        return str(self.config.get("url") or "https://openapi.ariba.com/api").rstrip("/")

    def database(self) -> str:
        return self.config.get("realm") or "Ariba"

    def discover(self) -> list[Table]:
        if not hasattr(self, "_views"):
            r = self.request("GET", self.url("procurement-reporting-view/v2/prod/viewTemplates"), "Could not list view templates", params={"realm": self.config["realm"]})
            body = self.body(r)
            items = body if isinstance(body, list) else body.get("Records") or body.get("viewTemplates") or body.get("records") or []
            self._views = [v.get("viewTemplateName") or v.get("name") for v in items if isinstance(v, dict)]
        return [Table(v, f"procurement-reporting-details/v2/prod/views/{quote(v)}", records="Records", cursor="TimeUpdated") for v in self._views if v]

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        start = params.get("since") or datetime.combine(date.fromisoformat(str(self.config.get("start_date") or (date.today() - timedelta(days=365)).isoformat())[:10]), datetime.min.time(), timezone.utc)
        now = datetime.now(timezone.utc)
        left = limit
        while start < now:
            end = min(start + timedelta(days=365), now)
            flt = json.dumps({"updatedDateFrom": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "updatedDateTo": end.strftime("%Y-%m-%dT%H:%M:%SZ")})
            for recs in super()._paged(tbl, url, left, {"realm": self.config["realm"], "filters": flt, "includeInactive": "false"}):
                yield recs
                if left is not None:
                    left -= len(recs)
                    if left <= 0:
                        return
            start = end

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if isinstance(lower, datetime):
            return self._paged(self._table_def(table), self.url(self._table_def(table).path), None, {"since": lower})
        return None


# --------------------------------------------------------------------------------------------
# SAP Concur — Expense / Invoice v3.0 APIs and the Authentication API (developer.concur.com):
# a refresh token (company or user) exchanged at {geo}/oauth2/v0/token; the token response's
# geolocation is the API host; lists return Items with a NextPage URL.
# --------------------------------------------------------------------------------------------

_CONCUR = Paging("next", next_path="NextPage")


class ConcurConnector(RestConnector):
    auth = "oauth2"
    paging = _CONCUR
    tables = [
        Table("expense_reports", "api/v3.0/expense/reports", records="Items", pk=["ID"], params={"limit": 100, "user": "ALL"}, cursor="LastModifiedDate",
              since=Since("modifiedDateAfter", format=lambda v: iso(v), extra={"limit": 100, "user": "ALL"})),
        Table("expense_entries", "api/v3.0/expense/entries", records="Items", pk=["ID"], params={"limit": 100, "user": "ALL"}, cursor="LastModifiedDate"),
        Table("expense_itemizations", "api/v3.0/expense/itemizations", records="Items", pk=["ID"], params={"limit": 100, "user": "ALL"}),
        Table("expense_attendees", "api/v3.0/expense/attendees", records="Items", pk=["ID"], params={"limit": 100}),
        Table("payment_requests", "api/v3.0/invoice/paymentrequestdigests", records="PaymentRequestDigest", pk=["ID"], params={"limit": 100}),
        Table("vendors", "api/v3.0/invoice/vendors", records="Vendor", pk=["ID"], params={"limit": 100}),
        Table("lists", "api/v3.0/common/lists", records="Items", pk=["ID"], params={"limit": 100}),
        Table("users", "api/v3.0/common/users", records="Items", pk=["ID"], params={"limit": 100}),
    ]

    def oauth(self) -> Optional[OAuth2]:
        return OAuth2(
            f"{self.config.get('token_host') or 'https://us.api.concursolutions.com'}/oauth2/v0/token",
            "refresh_token",
            self.config.get("client_id") or "",
            self.secrets.get("client_secret") or "",
            refresh_token=self.secrets.get("refresh_token") or "",
        )

    def base_url(self) -> str:
        self._headers()  # the token response names the data center
        geo = (self._oauth.extra.get("geolocation") if self._oauth else None) or self.config.get("token_host") or "https://us.api.concursolutions.com"
        return str(geo).rstrip("/")

    def database(self) -> str:
        return "SAP Concur"


# --------------------------------------------------------------------------------------------
# SAP Fieldglass — REST API Integration (SAP Fieldglass Integration Guide): a token from
# {url}/api/oauth2/v2.0/token?grant_type=client_credentials&response_type=token with Basic
# user:password and the x-ApplicationKey header; download connectors at
# {url}/api/vc/connector/{name} (__p1… parameters), answered as CSV or JSON.
# --------------------------------------------------------------------------------------------


class FieldglassConnector(RestConnector):
    auth = "custom"
    oauth_based = True  # an OAuth 2.0 client credentials token
    accept = "text/csv, application/json"

    def base_url(self) -> str:
        return str(self.config.get("url") or "").rstrip("/")

    def database(self) -> str:
        return "SAP Fieldglass"

    def extra_headers(self) -> dict[str, str]:
        return {"x-ApplicationKey": self.secrets.get("application_key", "")}

    def authenticate(self) -> None:
        r = self.http.post(
            f"{self.base_url()}/api/oauth2/v2.0/token",
            params={"grant_type": "client_credentials", "response_type": "token"},
            auth=(self.config["user"], self.secrets.get("password", "")),
            headers=self.extra_headers(),
        )
        if r.status_code >= 400:
            raise ConnectorError(f"Fieldglass sign-in failed: HTTP {r.status_code} {self.reason(r)}")
        self.session_headers = {"Authorization": f"Bearer {self.body(r).get('access_token', '')}"}

    def discover(self) -> list[Table]:
        names = [n.strip() for n in str(self.config.get("connectors") or "").splitlines() if n.strip()]
        return [Table(n, f"api/vc/connector/{quote(n)}") for n in names]

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        q = {f"__p{i + 1}": v.strip() for i, v in enumerate(str(self.config.get("parameters") or "").split(",")) if v.strip()}
        r = self.request("GET", url, f"Downloading {tbl.name} failed", params=q)
        if "json" in r.headers.get("content-type", ""):
            body = self.body(r)
            recs = body if isinstance(body, list) else next((v for v in body.values() if isinstance(v, list)), [body]) if isinstance(body, dict) else []
        else:
            recs = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
        if limit:
            recs = recs[:limit]
        if recs:
            yield recs


# --------------------------------------------------------------------------------------------
# SAP BusinessObjects BI — RESTful Web Service SDK (biprws): POST /logon/long → logonToken in
# the X-SAP-LogonToken header; Web Intelligence documents and reports through raylight/v1; a
# report's data is GET …/reports/{id} with Accept: text/csv.
# --------------------------------------------------------------------------------------------


class BusinessObjectsConnector(RestConnector):
    auth = "custom"

    def base_url(self) -> str:
        url = str(self.config.get("url") or "").rstrip("/")
        return url if url.endswith("/biprws") else f"{url}/biprws"

    def database(self) -> str:
        return "BusinessObjects"

    def authenticate(self) -> None:
        r = self.http.post(
            f"{self.base_url()}/logon/long",
            json={"userName": self.config["user"], "password": self.secrets.get("password", ""), "auth": self.config.get("auth_type") or "secEnterprise"},
            headers={"Content-Type": "application/json"},
        )
        if r.status_code >= 400:
            raise ConnectorError(f"BusinessObjects logon failed: HTTP {r.status_code} {self.reason(r)}")
        token = self.body(r).get("logonToken") or r.headers.get("X-SAP-LogonToken", "")
        self.session_headers = {"X-SAP-LogonToken": f'"{token.strip(chr(34))}"'}

    def close(self) -> None:
        if self._http is not None and self.session_headers:
            try:
                self._http.post(f"{self.base_url()}/logoff", headers=self.session_headers)
            except Exception:
                pass
        super().close()

    def discover(self) -> list[Table]:
        if hasattr(self, "_tables"):
            return self._tables
        tables = [
            Table("documents", "raylight/v1/documents", records="documents.document", pk=["id"], paging=Paging("offset", 50)),
            Table("universes", "raylight/v1/universes", records="universes.universe", pk=["id"], paging=Paging("offset", 50)),
        ]
        docs = self.body(self.request("GET", self.url("raylight/v1/documents"), "Could not list documents", params={"limit": int(self.config.get("max_documents") or 50)}))
        for d in dig(docs, "documents.document") or []:
            reps = self.body(self.request("GET", self.url(f"raylight/v1/documents/{d['id']}/reports"), "Could not list reports"))
            rlist = dig(reps, "reports.report") or []
            for rep in rlist if isinstance(rlist, list) else [rlist]:
                tables.append(Table(f"{d.get('name')} / {rep.get('name')}", f"raylight/v1/documents/{d['id']}/reports/{rep['id']}", description="Web Intelligence report"))
        self._tables = tables
        return tables

    def _paged(self, tbl: Table, url: str, limit: Optional[int], params: dict) -> Iterator[list[dict]]:
        if tbl.name in ("documents", "universes"):
            yield from super()._paged(tbl, url, limit, params)
            return
        r = self.request("GET", url, f"Exporting {tbl.name} failed", headers={"Accept": "text/csv"})
        recs = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
        if limit:
            recs = recs[:limit]
        if recs:
            yield recs


__all__ = [
    "ActCrmConnector",
    "ActOnConnector",
    "ActiveCampaignConnector",
    "AdobeAnalyticsConnector",
    "AdobeCommerceConnector",
    "AdpConnector",
    "AribaConnector",
    "AuthorizeNetConnector",
    "AvalaraConnector",
    "AzureAdConnector",
    "AzureDataCatalogConnector",
    "AzureDevOpsConnector",
    "BasecampConnector",
    "BigCommerceConnector",
    "BlackbaudConnector",
    "BugzillaConnector",
    "BusinessObjectsConnector",
    "ConcurConnector",
    "FieldglassConnector",
    "AsanaConnector",
]
