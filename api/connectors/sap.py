"""SAP ERP / SLT / custom SAP sources: OData services, plus the Palantir Foundry Connector 2.0 for
SAP Applications add-on when it is installed on the SAP system.

Data is read through SAP Gateway OData services (odata.py). When "Palantir SAP add-on" is turned
on, the add-on's REST API at https://<host>:<port>/sap/palantir is used for what Palantir
documents publicly (Available connectors → SAP ERP → Use in code repositories, and the SAP add-on
docs):

  GET  /system?obj=resource                       resource check (CPU, memory, work processes)
  GET  /v2/function/{name}/metadata               a function module's inputs and outputs
  POST /v2/function/{name}/writeback              call a function module / BAPI
                                                  {"commit", "input", "output": [tables]}
  POST /v2/function/{name}/parallel_writeback     the same for many inputs, parallelized in SAP
                                                  {"commit", "output", "bulkinput", "parallel",
                                                   "paralleljobs", "functioncallperjob"}
  GET  /v2/get_documents                          DMS documents (DOCUMENTTYPE, FILEFORMAT,
                                                  FILENAME, OBJECTLINK filters)
  GET  /v2/get_document?DOCUMENT_ID=…             one DMS document's content

On top of these: function modules as tables ("SAP functions": a BAPI's output table, called
without commit), the DMS document list as a table ("SAP DMS"), BAPI write-back and DMS media sync
(sap_tools.py). The add-on's own table-extraction endpoints are not publicly documented, so tables
are read through OData.

Authentication is the technical user (Basic), or a named user signed in through SAP's OAuth 2.0
server (/sap/bc/sec/oauth2/authorize, scope /PALANTIR/SRV_0001 for add-on write-back), so SAP
applies that user's authorizations.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterator, Optional
from urllib.parse import quote

from .base import ConnectorError
from .odata import ODataConnector

FUNCTIONS_DB = "SAP functions"
DMS_DB = "SAP DMS"


def parse_function_tables(text: str) -> list[dict]:
    """Lines "FUNCTION -> OUTPUT_TABLE {json input}" (input optional) → [{name, function, output, input}]."""
    out = []
    for line in str(text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_/]+)\s*(?:->\s*([A-Za-z0-9_/]+))?\s*(\{.*\})?\s*$", line)
        if not m:
            raise ConnectorError(f'Function table line not understood: "{line}" (use FUNCTION -> OUTPUT_TABLE {{"PARAM": "value"}})')
        try:
            inp = json.loads(m.group(3)) if m.group(3) else {}
        except ValueError as e:
            raise ConnectorError(f'Input of "{m.group(1)}" is not valid JSON: {e}') from None
        fn, output = m.group(1).upper(), (m.group(2) or "RETURN").upper()
        out.append({"name": f"{fn}.{output}", "function": fn, "output": output, "input": inp})
    return out


def parse_resources(text: str) -> list[dict]:
    """The resource check's tab-separated MSGTYP / MSGTXT lines."""
    rows = []
    for line in text.splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2 and parts[0].strip() and parts[0].strip() != "MSGTYP":
            rows.append({"type": parts[0].strip(), "message": parts[1].strip()})
    return rows


class SapConnector(ODataConnector):
    """OData services, and with use_addon the Palantir add-on's documented endpoints."""

    def addon_url(self) -> str:
        return str(self.config.get("addon_url") or f"{self.base_url()}/sap/palantir").rstrip("/")

    def _addon(self) -> None:
        if not self.config.get("use_addon"):
            raise ConnectorError('Turn on "Palantir SAP add-on" in the connection to use SAP functions and DMS documents')

    # -- the add-on's documented endpoints --

    def resources(self) -> list[dict]:
        self._addon()
        r = self.request("GET", f"{self.addon_url()}/system", "Resource check failed", params={"obj": "resource", **self._sap_params()}, headers={"Accept": "text/plain, */*"})
        return parse_resources(r.text)

    def function_metadata(self, function: str) -> Any:
        self._addon()
        return self.body(self.request("GET", f"{self.addon_url()}/v2/function/{quote(function, safe='')}/metadata", f"Reading {function}'s metadata failed", params=self._sap_params()))

    def call_function(self, function: str, input: dict, output: list[str], commit: bool) -> Any:
        self._addon()
        body = {"commit": bool(commit), "input": input or {}, "output": [o.upper() for o in output]}
        return self.body(self.request("POST", f"{self.addon_url()}/v2/function/{quote(function, safe='')}/writeback", f"Calling {function} failed", params=self._sap_params(), json=body))

    def call_function_bulk(self, function: str, bulkinput: list[dict], output: list[str], commit: bool, parallel: bool = True, jobs: int = 5, per_job: int = 10) -> Any:
        self._addon()
        body = {
            "commit": bool(commit),
            "output": [o.upper() for o in output],
            "bulkinput": bulkinput,
            "parallel": bool(parallel),
            "paralleljobs": int(jobs),
            "functioncallperjob": int(per_job),
        }
        return self.body(self.request("POST", f"{self.addon_url()}/v2/function/{quote(function, safe='')}/parallel_writeback", f"Calling {function} in bulk failed", params=self._sap_params(), json=body))

    def documents(self, filters: Optional[dict] = None) -> list[dict]:
        self._addon()
        params = {k.upper(): v for k, v in (filters or {}).items() if v not in (None, "")}
        body = self.body(self.request("GET", f"{self.addon_url()}/v2/get_documents", "Listing DMS documents failed", params={**params, **self._sap_params()}))
        return body if isinstance(body, list) else body.get("documents") or body.get("DOCUMENTS") or []

    def document(self, document_id: str) -> bytes:
        self._addon()
        r = self.request("GET", f"{self.addon_url()}/v2/get_document", f"Downloading DMS document {document_id} failed", params={"DOCUMENT_ID": document_id, **self._sap_params()}, headers={"Accept": "*/*"})
        return r.content

    # -- add-on tables beside the OData services --

    def _function_tables(self) -> list[dict]:
        return parse_function_tables(self.config.get("function_tables") or "") if self.config.get("use_addon") else []

    def services(self) -> dict[str, str]:
        if self.config.get("use_addon") and not (self.config.get("gateway_catalog") or str(self.config.get("service_urls") or "").strip()):
            return {}  # add-on only
        return super().services()

    def test_connection(self) -> dict:
        if self.config.get("use_addon"):
            checks = self.resources()
            bad = [c["message"] for c in checks if c["type"] not in ("S", "I", "W")]
            if bad:
                raise ConnectorError(f"Connected, but the add-on's resource check failed: {bad[0]}")
            if not self.services():
                return {"version": f"Palantir SAP add-on · {len(checks)} resource checks passed"}
        return super().test_connection()

    def list_databases(self) -> list[str]:
        dbs = list(self.services())
        if self.config.get("use_addon"):
            dbs += [FUNCTIONS_DB, DMS_DB]
        return dbs

    def _list_tables(self, database: str, search: str) -> list[dict]:
        if database == FUNCTIONS_DB:
            return [{"name": t["name"], "kind": "view", "rows": None, "comment": f"{t['function']} output table {t['output']}"} for t in self._function_tables()]
        if database == DMS_DB:
            self._addon()
            return [{"name": "documents", "kind": "table", "rows": None, "comment": "Document Management System documents (metadata)"}]
        return super()._list_tables(database, search)

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        if database in (FUNCTIONS_DB, DMS_DB):
            return None  # inferred from a sample
        return super()._declared_columns(database, table)

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        if database == DMS_DB:
            return ["DOCUMENT_ID"] if any(c["name"] == "DOCUMENT_ID" for c in columns) else []
        if database == FUNCTIONS_DB:
            return []
        return super()._primary_key(database, table, columns)

    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        if database == FUNCTIONS_DB:
            t = next((t for t in self._function_tables() if t["name"] == table), None)
            if not t:
                raise ConnectorError(f'"{table}" is not one of the connection\'s function tables')
            res = self.call_function(t["function"], t["input"], [t["output"]], commit=False)
            rows = (res or {}).get(t["output"]) if isinstance(res, dict) else res
            rows = rows if isinstance(rows, list) else ([rows] if isinstance(rows, dict) else [])
            rows = [r if isinstance(r, dict) else {"value": r} for r in rows]
            return iter([rows[:limit] if limit else rows])
        if database == DMS_DB:
            docs = self.documents(parse_filters(self.config.get("dms_filters") or ""))
            return iter([docs[:limit] if limit else docs])
        return super()._records(database, table, limit)

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        if database in (FUNCTIONS_DB, DMS_DB):
            return None  # snapshots, filtered here
        return super()._range_records(database, table, col, lower, lower_inclusive, upper)


def parse_filters(text: str) -> dict:
    """"DOCUMENTTYPE=CPT, FILEFORMAT=pdf" → {DOCUMENTTYPE: CPT, FILEFORMAT: pdf}"""
    out = {}
    for part in re.split(r"[,\n]", str(text or "")):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip():
                out[k.strip().upper()] = v.strip()
    return out
