"""SAP tools for SAP ERP / SLT / custom SAP connections with the Palantir SAP add-on
(connectors/sap.py): the add-on's resource check, function module (BAPI) metadata and write-back —
one call, or one call per row of a dataset through parallel_writeback — and DMS documents copied
into Files (as Foundry's SAP media set syncs).

Write-back and BAPI calls change SAP data, so like table exports they need "Enable exports to this
source" on the connection. DMS sync keeps its state with the connection's media sync state
(file_transfers.py): a document is copied again only when its metadata changes.

Mounted by datasources.py under /api/datasources/connections.
"""

from __future__ import annotations

import io
import json
import mimetypes
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/connections")

BULK_CHUNK = 500
MAX_BULK_ROWS = 50_000
MAX_DOCS = 500


def _sap(conn_id: str):  # noqa: ANN202
    import datasources as ds
    from connectors import ConnectorError
    from connectors.sap import SapConnector

    try:
        c = ds._open(conn_id)
    except ConnectorError as e:
        raise HTTPException(400, str(e)) from None
    if not isinstance(c, SapConnector):
        c.close()
        raise HTTPException(400, "SAP tools work with SAP ERP, SAP SLT and SAP (custom source) connections")
    return c


def _run(fn):  # noqa: ANN001, ANN202
    from connectors import ConnectorError

    try:
        return fn()
    except ConnectorError as e:
        raise HTTPException(400, str(e)) from None


def _function_name(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_/]{1,30}", name):
        raise HTTPException(400, "Not a function module name")
    return name.upper()


def return_messages(result: Any) -> dict:
    """Counts of SAP RETURN messages by type (S success, I info, W warning, E error, A abort)."""
    counts: dict[str, int] = {}

    def walk(v: Any) -> None:
        if isinstance(v, dict):
            if "TYPE" in v and "MESSAGE" in v:
                counts[str(v["TYPE"]) or "?"] = counts.get(str(v["TYPE"]) or "?", 0) + 1
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(result)
    return counts


@router.get("/{conn_id}/sap/resources")
def resources(conn_id: str) -> list[dict]:
    with _sap(conn_id) as c:
        return _run(c.resources)


@router.get("/{conn_id}/sap/functions/{name}/metadata")
def function_metadata(conn_id: str, name: str) -> Any:
    fn = _function_name(name)
    with _sap(conn_id) as c:
        return _run(lambda: c.function_metadata(fn))


class Call(BaseModel):
    input: dict = Field(default_factory=dict)
    output: list[str] = Field(default_factory=lambda: ["RETURN"])
    commit: bool = False


@router.post("/{conn_id}/sap/functions/{name}/call")
def call_function(conn_id: str, name: str, req: Call) -> dict:
    import exports

    exports._check_connection(conn_id)
    fn = _function_name(name)
    with _sap(conn_id) as c:
        result = _run(lambda: c.call_function(fn, req.input, req.output, req.commit))
    return {"function": fn, "result": result, "messages": return_messages(result)}


class BulkCall(BaseModel):
    dataset: dict
    # the function's input with {{column}} placeholders, filled from each row
    template: dict
    output: list[str] = Field(default_factory=lambda: ["RETURN"])
    commit: bool = False
    parallel: bool = True
    jobs: int = Field(5, ge=1, le=50)
    per_job: int = Field(10, ge=1, le=1000)


_PLACEHOLDER = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


def fill(template: Any, row: dict) -> Any:
    """{{column}} placeholders → the row's values (a whole-string placeholder keeps the value's type)."""
    if isinstance(template, dict):
        return {k: fill(v, row) for k, v in template.items()}
    if isinstance(template, list):
        return [fill(v, row) for v in template]
    if isinstance(template, str):
        whole = _PLACEHOLDER.fullmatch(template.strip())
        if whole:
            if whole.group(1) not in row:
                raise HTTPException(400, f'The dataset has no column "{whole.group(1)}"')
            v = row[whole.group(1)]
            return v.isoformat() if hasattr(v, "isoformat") else v

        def sub(m: re.Match) -> str:
            if m.group(1) not in row:
                raise HTTPException(400, f'The dataset has no column "{m.group(1)}"')
            v = row[m.group(1)]
            return "" if v is None else (v.isoformat() if hasattr(v, "isoformat") else str(v))

        return _PLACEHOLDER.sub(sub, template)
    return template


@router.post("/{conn_id}/sap/functions/{name}/bulk")
def call_function_bulk(conn_id: str, name: str, req: BulkCall) -> dict:
    """One call per dataset row through parallel_writeback, BULK_CHUNK rows per request."""
    import dc_datasets
    import exports

    exports._check_connection(conn_id)
    fn = _function_name(name)
    table, _, dataset_name = dc_datasets.read(dc_datasets.parse_ref(req.dataset))
    if table.num_rows > MAX_BULK_ROWS:
        raise HTTPException(400, f"The dataset has {table.num_rows:,} rows; at most {MAX_BULK_ROWS:,} per run")
    inputs = [fill(req.template, r) for r in table.to_pylist()]
    results: list = []
    errors: list[dict] = []
    with _sap(conn_id) as c:
        for start in range(0, len(inputs), BULK_CHUNK):
            chunk = inputs[start : start + BULK_CHUNK]
            try:
                res = _run(lambda: c.call_function_bulk(fn, chunk, req.output, req.commit, req.parallel, req.jobs, req.per_job))
            except HTTPException as e:
                errors.append({"rows": f"{start + 1}–{start + len(chunk)}", "error": str(e.detail)[:300]})
                continue
            results += res if isinstance(res, list) else [res]
    return {
        "function": fn,
        "dataset": dataset_name,
        "rows": len(inputs),
        "calls": len(results),
        "messages": return_messages(results),
        "errors": errors,
        "results": results[:200],
    }


@router.get("/{conn_id}/sap/documents")
def documents(conn_id: str, documenttype: str = "", fileformat: str = "", filename: str = "", objectlink: str = "") -> list[dict]:
    flt = {"DOCUMENTTYPE": documenttype, "FILEFORMAT": fileformat, "FILENAME": filename, "OBJECTLINK": objectlink}
    with _sap(conn_id) as c:
        return _run(lambda: c.documents(flt))[:1000]


class DmsSync(BaseModel):
    documenttype: str = ""
    fileformat: str = ""
    filename: str = ""
    objectlink: str = ""
    path_matches: str = r"\.pdf$"  # a regular expression on the file name (the docs' default: .pdf)
    max_bytes: Optional[int] = None
    exclude_synced: bool = True


def _doc_name(d: dict) -> str:
    for k in ("DOCUMENT_NAME", "FILENAME", "FILE_NAME", "NAME"):
        if d.get(k):
            return str(d[k])
    return str(d.get("DOCUMENT_ID") or "document")


@router.post("/{conn_id}/sap/dms-sync")
def dms_sync(conn_id: str, req: DmsSync) -> dict:
    import datasources as ds
    import drive
    import file_transfers as ft

    ds._require()
    try:
        rx = re.compile(req.path_matches or ".*", re.I)
    except re.error as e:
        raise HTTPException(400, f"Path matches is not a valid regular expression: {e}") from None
    row = ds._connection_row(conn_id)

    def label(n: str) -> str:
        return drive._clean_name(drive.BAD_NAME.sub("_", n)) or "document"

    with ft._conn_lock(conn_id):
        st = ft._load(conn_id)
        items: dict[str, str] = st.setdefault("items", {})
        copied: list[str] = []
        failed: list[dict] = []
        skipped = 0
        todo: list[dict] = []
        target = None
        try:
            with _sap(conn_id) as c:
                docs = _run(lambda: c.documents({"DOCUMENTTYPE": req.documenttype, "FILEFORMAT": req.fileformat, "FILENAME": req.filename, "OBJECTLINK": req.objectlink}))
                for d in docs:
                    key = f"dms:{d.get('DOCUMENT_ID')}"
                    stamp = json.dumps(d, sort_keys=True, default=str)
                    if not d.get("DOCUMENT_ID") or not rx.search(_doc_name(d)):
                        continue
                    size = d.get("FILE_SIZE") or d.get("FILESIZE")
                    if req.max_bytes and size and str(size).isdigit() and int(size) > req.max_bytes:
                        skipped += 1
                        continue
                    if req.exclude_synced and st["synced"].get(key) == stamp:
                        continue
                    todo.append({**d, "_key": key, "_stamp": stamp})
                target = drive._ensure_folders(drive.default_folder("sources"), [label(n) for n in ["Media", row["name"], "DMS"]])
                for d in todo[:MAX_DOCS]:
                    name = label(_doc_name(d))
                    try:
                        data = _run(lambda: c.document(str(d["DOCUMENT_ID"])))
                        if req.max_bytes and len(data) > req.max_bytes:
                            skipped += 1
                            continue
                        doc_type = str(d.get("DOCUMENTTYPE") or d.get("DOCUMENT_TYPE") or "")
                        parent = drive._ensure_folders(target, [label(doc_type)]) if doc_type else target
                        if items.get(d["_key"]):
                            try:
                                drive.trash(items.pop(d["_key"]))
                            except HTTPException:
                                pass
                        item = drive._store(parent, name, io.BytesIO(data), len(data), mimetypes.guess_type(name)[0] or "application/octet-stream")
                        items[d["_key"]] = item["id"]
                        st["synced"][d["_key"]] = d["_stamp"]
                        copied.append(name)
                    except Exception as err:  # noqa: BLE001 - one document's failure never loses the run's state
                        detail = err.detail if isinstance(err, HTTPException) else str(err)
                        failed.append({"document": str(d.get("DOCUMENT_ID")), "error": str(detail)[:200]})
        finally:
            run = {
                "at": datetime.now(timezone.utc).isoformat(),
                "folder": "SAP DMS",
                "copied": len(copied),
                "failed": len(failed),
                "skipped": skipped,
                "remaining": max(0, len(todo) - MAX_DOCS),
                "target_folder_id": target,
            }
            if target is not None or copied:
                st["runs"] = [*st["runs"][-49:], run]
                ft._state_path(conn_id).write_text(json.dumps(st))
    return {**run, "files": copied[:50], "errors": failed[:20]}


@router.get("/delta-sources/{source_id}/current")
def delta_current(source_id: str) -> dict:
    """The current rows of a delta-token source (SAP ODP or OData v4 change tracking): its dataset is the
    initial load plus every delta's changes, and this applies them by the entity set's key — the last image of
    each key, deleted keys (ODQ_CHANGEMODE = D) left out — so it equals a full read of the entity set."""
    import datasources as ds
    from connectors import ConnectorError
    from connectors.odata import CHANGEMODE, net_changes

    ds._require()
    row = ds._source_row(source_id)
    if row["mode"] != "incremental" or row["config"].get("cursor_column") != ds.DELTA_CURSOR:
        raise HTTPException(400, "Not a delta-token data source")
    table = ds.source_table(source_id)
    if row["config"].get("delta_write") == "upsert" and not (row["state"] or {}).get("compact"):
        # upsert by key: the dataset already holds the current rows (once a run after the switch wrote them)
        return {"columns": table["columns"], "rows": table["rows"], "key": row["config"].get("delta_key") or [], "changes": None,
                "name": table["name"], "delta_write": "upsert"}
    try:
        with ds._open(row["connection_id"]) as c:
            key = c.get_table_schema(row["database_name"], row["schema_name"], row["table_name"]).get("primary_key") or []
    except ConnectorError as e:
        raise HTTPException(400, str(e)) from None
    names = {col["name"] for col in table["columns"]}
    if not key or not set(key) <= names:
        raise HTTPException(400, "The source's columns do not include the entity set's key: changes cannot be applied")
    if CHANGEMODE not in names:
        raise HTTPException(400, f"The source has no {CHANGEMODE} column: deletions are not in its dataset")
    rows = net_changes(table["rows"], key)
    return {"columns": table["columns"], "rows": rows, "key": key, "changes": len(table["rows"]), "name": table["name"]}
