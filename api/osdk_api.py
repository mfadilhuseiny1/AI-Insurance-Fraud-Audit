"""The OSDK REST API: a Foundry Platform API (Ontologies v2) shaped subset over this platform's Ontology.

Applications built with the generated SDK (developer_console.py) — or anything that speaks HTTP — call it with a
bearer token: a Developer Console application's OAuth2 access token (limited to the application's resources), a
personal API token, or the session cookie. Everything goes through the Ontology's own checks: object type markings,
object and property security policies, action criteria.

  GET  /api/v2/ontologies                                      the ontology
  GET  /api/v2/ontologies/{o}/objectTypes[/{objectType}]       object types and their properties
  GET  /api/v2/ontologies/{o}/objects/{objectType}             list (pageSize, pageToken, orderBy=prop:asc|desc, select)
  POST /api/v2/ontologies/{o}/objects/{objectType}/search      where (eq, gt, gte, lt, lte, isNull, contains, startsWith,
                                                               in, and, or, not), orderBy, pageSize, pageToken, select,
                                                               derivedProperties {name: {link, aggregation, property?}}:
                                                               aggregates over a link, usable in where / orderBy
  POST /api/v2/ontologies/{o}/objects/{objectType}/aggregate   aggregation (count, sum, avg, min, max, approximateDistinct)
                                                               with groupBy (exact) and where
  GET  /api/v2/ontologies/{o}/objects/{objectType}/{pk}        one object
  GET  /api/v2/ontologies/{o}/objects/{objectType}/{pk}/links/{link}   linked objects
  POST /api/v2/ontologies/{o}/actions/{action}/apply           apply an action ({parameters, options: {mode:
                                                               VALIDATE_ONLY | VALIDATE_AND_EXECUTE, returnEdits: ALL | NONE}});
                                                               VALIDATE_ONLY checks parameters, submission criteria and
                                                               rules and writes nothing
  POST /api/v2/ontologies/attachments/upload?filename=         upload an attachment (the body is the file) → {rid, filename,
                                                               sizeBytes, mediaType}; GET …/attachments/{rid}[/content]
  POST /api/v2/ontologies/{o}/objectTypes/{objectType}/media/{property}/upload?mediaItemPath=
                                                               upload media for a media property → a media reference
  GET  /api/v2/ontologies/{o}/objects/{objectType}/{pk}/media/{property}/metadata | /content
                                                               the media of an object's media property
  POST /api/v2/ontologies/{o}/queries/{query}/execute          run a published function by API name ({parameters})
  GET  /api/v2/admin/users/getCurrent                          the user
"""

from __future__ import annotations

import base64
import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/v2", tags=["osdk"])
ONTOLOGY_RID = "ri.ontology.main.ontology.default"
TYPES = {"string": "string", "integer": "integer", "double": "double", "boolean": "boolean", "date": "date", "timestamp": "timestamp", "long": "long",
         "short": "short", "byte": "byte", "float": "float", "decimal": "decimal", "media": "mediaReference", "string_array": "array",
         "geopoint": "geopoint", "geoshape": "geoshape", "timeseries": "timeseries", "vector": "vector", "attachment": "attachment"}


def _app_scope() -> Optional[dict]:
    """The calling application's resources (None for a user's own token or session: their full access)."""
    p = auth.current() or {}
    scope = str(p.get("scope") or "")
    if not scope.startswith("oauth:"):
        return None
    import developer_console

    return developer_console.app_resources(scope[6:])


def _check(kind: str, rid: str, what: str) -> None:
    res = _app_scope()
    if res is not None and rid not in (res.get(kind) or []):
        raise HTTPException(403, {"errorCode": "PERMISSION_DENIED", "errorName": "ApplicationScopeMissing",
                                  "parameters": {"resource": what}, "message": f"the application's scopes do not include {what}"})


def _ontology(o: str) -> None:
    if o not in ("default", ONTOLOGY_RID) and not o.startswith("ri.ontology."):
        raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "OntologyNotFound", "parameters": {"ontology": o}})


def _type_by_api(api_name: str) -> dict:
    import ontology

    for s in ontology.list_object_types():
        if s.get("api_name") == api_name or s["id"] == api_name:
            return ontology._object_type(s["id"])
    raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ObjectTypeNotFound", "parameters": {"objectType": api_name}})


def _type_json(t: dict) -> dict:
    return {"apiName": t.get("api_name") or t["id"], "displayName": t["display_name"], "description": t.get("description") or "", "rid": t.get("rid") or f"ri.ontology.main.object-type.{t['id']}",
            "primaryKey": t["primary_key"], "titleProperty": t.get("title_property"), "status": str(t.get("status") or "experimental").upper(),
            "properties": {p["api_name"]: {"displayName": p["display_name"], "description": p.get("description") or "", "dataType": {"type": TYPES.get(p["type"], "string")}}
                           for p in t["properties"]}}


def _rows(t: dict) -> list[dict]:
    import workshop

    _check("object_types", t["id"], f"the object type {t.get('api_name') or t['id']}")
    _, _, rows = workshop._object_rows(t["id"])
    return rows


def _obj(t: dict, row: dict, select: Optional[list[str]] = None) -> dict:
    props = {k: v for k, v in row.items() if k != "__pk" and (not select or k in select)}
    return {"__apiName": t.get("api_name") or t["id"], "__primaryKey": row["__pk"], "__rid": f"ri.phonograph2-objects.main.object.{t['id']}.{row['__pk']}", **props}


def _match(row: dict, w: Optional[dict]) -> bool:
    if not w:
        return True
    k = w.get("type")
    if k == "and":
        return all(_match(row, x) for x in w.get("value") or [])
    if k == "or":
        return any(_match(row, x) for x in w.get("value") or [])
    if k == "not":
        return not _match(row, w.get("value"))
    v = row.get(w.get("field") or w.get("propertyIdentifier", {}).get("apiName", ""))
    x = w.get("value")
    try:
        if k == "eq":
            return v == x or (v is not None and x is not None and str(v) == str(x))
        if k == "gt":
            return v is not None and v > x
        if k == "gte":
            return v is not None and v >= x
        if k == "lt":
            return v is not None and v < x
        if k == "lte":
            return v is not None and v <= x
        if k == "isNull":
            return (v is None) == bool(x)
        if k == "in":
            return v in (x or [])
        if k in ("contains", "containsAnyTerm", "containsAllTerms", "containsAllTermsInOrder"):
            if isinstance(v, list):
                return x in v
            hay, terms = str(v or "").lower(), str(x or "").lower().split()
            return all(t in hay for t in terms) if k != "containsAnyTerm" else any(t in hay for t in terms)
        if k == "startsWith":
            return str(v or "").lower().startswith(str(x or "").lower())
    except TypeError:
        return False
    raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "InvalidQuery", "parameters": {"type": k}})


def _page(items: list, page_size: int, token: Optional[str]) -> tuple[list, Optional[str]]:
    start = int(base64.urlsafe_b64decode(token.encode()).decode()) if token else 0
    size = max(1, min(int(page_size or 1000), 10_000))
    nxt = base64.urlsafe_b64encode(str(start + size).encode()).decode() if start + size < len(items) else None
    return items[start:start + size], nxt


def _sorted(rows: list[dict], order: list[tuple[str, bool]]) -> list[dict]:
    for field, desc in reversed(order):
        rows = sorted(rows, key=lambda r: (r.get(field) is None, r.get(field) if not isinstance(r.get(field), (dict, list)) else str(r.get(field))), reverse=desc)
    return rows


@router.get("/ontologies")
def ontologies() -> dict:
    return {"data": [{"apiName": "default", "displayName": "Ontology", "description": "", "rid": ONTOLOGY_RID}]}


@router.get("/ontologies/{o}/objectTypes")
def object_types(o: str) -> dict:
    _ontology(o)
    import ontology

    res = _app_scope()
    out = []
    for s in ontology.list_object_types():
        if res is not None and s["id"] not in (res.get("object_types") or []):
            continue
        try:
            out.append(_type_json(ontology._object_type(s["id"])))
        except HTTPException:
            continue
    return {"data": out}


@router.get("/ontologies/{o}/objectTypes/{object_type}")
def object_type(o: str, object_type: str) -> dict:
    _ontology(o)
    t = _type_by_api(object_type)
    _check("object_types", t["id"], f"the object type {object_type}")
    return _type_json(t)


@router.get("/ontologies/{o}/objects/{object_type}")
def list_objects(o: str, object_type: str, pageSize: int = 1000, pageToken: Optional[str] = None, orderBy: Optional[str] = None, select: Optional[str] = None) -> dict:  # noqa: N803
    _ontology(o)
    t = _type_by_api(object_type)
    rows = _rows(t)
    if orderBy:
        f, _, d = orderBy.removeprefix("p.").partition(":")
        rows = _sorted(rows, [(f, d == "desc")])
    page, nxt = _page(rows, pageSize, pageToken)
    sel = select.split(",") if select else None
    return {"data": [_obj(t, r, sel) for r in page], "nextPageToken": nxt, "totalCount": str(len(rows))}


class SearchIn(BaseModel):
    where: Optional[dict] = None
    orderBy: Optional[dict] = None  # noqa: N815
    pageSize: int = Field(1000, ge=1, le=10_000)  # noqa: N815
    pageToken: Optional[str] = None  # noqa: N815
    select: list[str] = Field(default_factory=list)
    # {name: {link: link API name, aggregation: count | sum | avg | min | max | approximateDistinct | exactDistinct |
    #  collectList | collectSet | selectProperty, property?: linked property API name}}
    derivedProperties: dict[str, dict] = Field(default_factory=dict)  # noqa: N815


AGGREGATIONS = {"count": "count", "sum": "sum", "avg": "avg", "min": "min", "max": "max", "approximateDistinct": "approximate_distinct",
                "exactDistinct": "exact_distinct", "collectList": "collect_list", "collectSet": "collect_set", "selectProperty": "select"}


def _with_derived(t: dict, rows: list[dict], defs: dict[str, dict]) -> list[dict]:
    """The rows with derived properties (ontology_search.apply_derived), links named by their API names."""
    if not defs:
        return rows
    import ontology_model as om
    import ontology_search

    specs = []
    for name, d in defs.items():
        link = str(d.get("link") or "")
        hit = None
        for lt, direction in om.links_of(t["id"]):
            _start, reach = om.side_of(lt, direction)
            if link in (reach.get("api_name"), lt["id"]):
                hit = (lt, direction)
                break
        if not hit:
            raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "LinkTypeNotFound", "parameters": {"linkType": link}})
        agg = AGGREGATIONS.get(str(d.get("aggregation") or "count"))
        if not agg:
            raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "InvalidAggregation", "parameters": {"aggregation": d.get("aggregation")}})
        try:
            specs.append(ontology_search.DerivedProperty(api_name=name, link_type_id=hit[0]["id"], direction=hit[1], metric=agg, property=d.get("property")))
        except ValueError as e:
            raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "InvalidDerivedProperty", "parameters": {"name": name, "message": str(e)}}) from None
    objs = [{"primary_key": r["__pk"], "properties": {k: v for k, v in r.items() if k != "__pk"}} for r in rows]
    ontology_search.apply_derived(t, objs, specs)
    return [{**x["properties"], "__pk": x["primary_key"]} for x in objs]


@router.post("/ontologies/{o}/objects/{object_type}/search")
def search(o: str, object_type: str, req: SearchIn) -> dict:
    _ontology(o)
    t = _type_by_api(object_type)
    rows = [r for r in _with_derived(t, _rows(t), req.derivedProperties) if _match(r, req.where)]
    order = [(f["field"], str(f.get("direction", "asc")).lower() == "desc") for f in (req.orderBy or {}).get("fields") or []]
    rows = _sorted(rows, order)
    page, nxt = _page(rows, req.pageSize, req.pageToken)
    return {"data": [_obj(t, r, req.select or None) for r in page], "nextPageToken": nxt, "totalCount": str(len(rows))}


class AggregateIn(BaseModel):
    aggregation: list[dict] = Field(default_factory=list)
    groupBy: list[dict] = Field(default_factory=list)  # noqa: N815
    where: Optional[dict] = None


@router.post("/ontologies/{o}/objects/{object_type}/aggregate")
def aggregate(o: str, object_type: str, req: AggregateIn) -> dict:
    _ontology(o)
    t = _type_by_api(object_type)
    rows = [r for r in _rows(t) if _match(r, req.where)]
    groups: dict[tuple, list[dict]] = {}
    keys = [g["field"] for g in req.groupBy]
    for r in rows:
        groups.setdefault(tuple(r.get(k) for k in keys), []).append(r)
    out = []
    for gk, rs in groups.items():
        metrics = []
        for a in req.aggregation or [{"type": "count"}]:
            kind, field = a.get("type"), a.get("field")
            vals = [r.get(field) for r in rs if isinstance(r.get(field), (int, float)) and not isinstance(r.get(field), bool)] if field else []
            value: Any
            if kind == "count":
                value = len(rs)
            elif kind == "sum":
                value = sum(vals)
            elif kind == "avg":
                value = sum(vals) / len(vals) if vals else None
            elif kind == "min":
                value = min(vals) if vals else None
            elif kind == "max":
                value = max(vals) if vals else None
            elif kind in ("approximateDistinct", "exactDistinct"):
                value = len({json.dumps(r.get(field), default=str) for r in rs})
            else:
                raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "InvalidAggregation", "parameters": {"type": kind}})
            metrics.append({"name": a.get("name") or f"{kind}{'.' + field if field else ''}", "value": value})
        out.append({"group": dict(zip(keys, gk)), "metrics": metrics})
    return {"accuracy": "ACCURATE", "data": out}


@router.get("/ontologies/{o}/objects/{object_type}/{pk}")
def get_object(o: str, object_type: str, pk: str, select: Optional[str] = None) -> dict:
    _ontology(o)
    t = _type_by_api(object_type)
    row = next((r for r in _rows(t) if str(r["__pk"]) == pk), None)
    if not row:
        raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ObjectNotFound", "parameters": {"objectType": object_type, "primaryKey": pk}})
    return _obj(t, row, select.split(",") if select else None)


@router.get("/ontologies/{o}/objects/{object_type}/{pk}/links/{link}")
def links(o: str, object_type: str, pk: str, link: str, pageSize: int = 1000, pageToken: Optional[str] = None) -> dict:  # noqa: N803
    _ontology(o)
    t = _type_by_api(object_type)
    _check("object_types", t["id"], f"the object type {object_type}")
    import ontology
    import ontology_model

    hit = next((x for x in ontology_model.object_links(t["id"], pk, limit=100_000) if link in (x["api_name"], x["link_type_id"], x["name"])), None)
    if not hit:
        raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "LinkTypeNotFound", "parameters": {"linkType": link}})
    _check("object_types", hit["object_type_id"], f"the linked object type {hit['object_type']}")
    other = ontology._object_type(hit["object_type_id"])
    rows = [{**x["properties"], "__pk": x["primary_key"]} for x in hit["objects"]]
    page, nxt = _page(rows, pageSize, pageToken)
    return {"data": [_obj(other, r) for r in page], "nextPageToken": nxt}


class ApplyIn(BaseModel):
    parameters: dict = Field(default_factory=dict)
    options: dict = Field(default_factory=dict)


def _action_by_api(api_name: str) -> dict:
    import ontology

    for a in ontology.list_action_types():
        if a.get("api_name") == api_name or a["id"] == api_name:
            return a
    raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ActionTypeNotFound", "parameters": {"actionType": api_name}})


@router.post("/ontologies/{o}/actions/{action}/apply")
def apply_action(o: str, action: str, req: ApplyIn) -> dict:
    _ontology(o)
    a = _action_by_api(action)
    _check("action_types", a["id"], f"the action type {action}")
    import ontology

    opts = req.options or {}
    mode = opts.get("mode") or "VALIDATE_AND_EXECUTE"
    if mode not in ("VALIDATE_ONLY", "VALIDATE_AND_EXECUTE"):
        raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "InvalidApplyActionOptionCombination", "parameters": {"mode": mode}})
    validation = _validate(a, req.parameters)
    if mode == "VALIDATE_ONLY":
        return {"validation": validation}
    if validation["result"] != "VALID":
        # like Foundry: an invalid action is not applied; the response says why
        raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "ActionValidationFailed", "parameters": {"actionType": action, "validation": validation},
                                  "message": _first_failure(validation)})
    out = ontology.apply_action(a["id"], ontology.ApplyAction(parameters=req.parameters))
    res: dict = {"validation": validation}
    if opts.get("returnEdits") != "NONE":
        res["edits"] = {"type": "edits", "edits": out.get("edits") or []}
    return res


def _validate(a: dict, parameters: dict) -> dict:
    """Foundry's validation result: each parameter (required, VALID / INVALID with the reason), the submission criteria
    and — when those hold — the rules evaluated without writing (a failing rule makes the action INVALID)."""
    import ontology_actions as OA

    with ontology_lock():
        form = OA.resolve_form(a, parameters or {}, OA._user(), None, False)
    errors = form.get("errors") or {}
    params = {}
    for p in a.get("parameters") or []:
        st = next((s for s in form.get("parameters") or [] if s.get("id") == p["id"]), {})
        err = errors.get(p["id"])
        required = bool(st.get("required", p.get("required")))
        if not err and required and st.get("visible", True) and (form.get("values") or {}).get(p["id"]) in (None, "", []):
            err = f"{p.get('display_name') or p['id']} is required"
            errors = {**errors, p["id"]: err}
        params[p["id"]] = {"result": "INVALID" if err else "VALID", "required": required,
                           "evaluatedConstraints": [{"type": "unevaluable", "message": err}] if err else []}
    crit = form.get("criteria") or {}
    criteria = [{"configuredFailureMessage": m, "result": "INVALID"} for m in crit.get("failures") or []]
    result = "VALID" if not errors and crit.get("passed", True) else "INVALID"
    out = {"result": result, "submissionCriteria": criteria, "parameters": params}
    if result == "VALID":
        try:
            OA.execute(a, parameters or {}, "validate")
        except HTTPException as e:
            out["result"] = "INVALID"
            out["submissionCriteria"] = [{"configuredFailureMessage": str(e.detail), "result": "INVALID"}]
    return out


def ontology_lock():
    import ontology

    return ontology._lock


def _first_failure(v: dict) -> str:
    for c in v.get("submissionCriteria") or []:
        return str(c.get("configuredFailureMessage"))
    for pid, p in (v.get("parameters") or {}).items():
        if p.get("result") == "INVALID":
            return f"{pid}: {(p.get('evaluatedConstraints') or [{}])[0].get('message') or 'invalid'}"
    return "the action is not valid"


# ------------------------------------------------------------------------------------------------
# attachments and media
# ------------------------------------------------------------------------------------------------

ATTACHMENT_RID = "ri.attachments.main.attachment."
MAX_UPLOAD = 200 * 1024 * 1024


def _att_id(rid: str) -> str:
    return rid[len(ATTACHMENT_RID):] if rid.startswith(ATTACHMENT_RID) else rid


def _att_json(meta: dict) -> dict:
    return {"rid": ATTACHMENT_RID + meta["id"], "filename": meta["name"], "sizeBytes": meta["size_bytes"], "mediaType": meta["media_type"]}


async def _body(request: Request) -> bytes:
    data = await request.body()
    if not data:
        raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "EmptyUpload", "parameters": {}, "message": "send the file as the request body"})
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, {"errorCode": "REQUEST_ENTITY_TOO_LARGE", "errorName": "AttachmentSizeExceededLimit", "parameters": {"maxBytes": MAX_UPLOAD}})
    return data


@router.post("/ontologies/attachments/upload")
async def upload_attachment(request: Request, filename: str) -> dict:
    """Upload an attachment: set its rid on an attachment property (or pass it to an action) to keep it."""
    import drive
    import ontology_attachments as AT

    data = await _body(request)
    import mimetypes

    mt = request.headers.get("content-type") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    if mt in ("application/octet-stream", "*/*"):
        mt = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return _att_json(AT._meta(drive.save_bytes(AT._attachments_folder(), filename, data, mt)))


@router.get("/ontologies/attachments/{rid}")
def attachment(rid: str) -> dict:
    import ontology_attachments as AT

    return _att_json(AT.metadata(_att_id(rid)))


@router.get("/ontologies/attachments/{rid}/content")
def attachment_content(rid: str) -> Response:
    import drive
    import ontology_attachments as AT

    item = AT._file(_att_id(rid))
    return Response(drive.read_bytes(item), media_type=item.get("content_type") or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{item["name"]}"'})


def _media_prop(t: dict, prop: str) -> dict:
    p = next((x for x in t["properties"] if x["api_name"] == prop), None)
    if not p or p["type"] != "media":
        raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "PropertyNotFound", "parameters": {"property": prop},
                                  "message": f"{t['api_name']} has no media reference property {prop}"})
    return p


@router.post("/ontologies/{o}/objectTypes/{object_type}/media/{prop}/upload")
async def upload_media(request: Request, o: str, object_type: str, prop: str, mediaItemPath: str = "upload") -> dict:  # noqa: N803
    """Upload media for a media reference property (into its upload destination): the reference to set on an object
    with an action."""
    _ontology(o)
    t = _type_by_api(object_type)
    _check("object_types", t["id"], f"the object type {object_type}")
    _media_prop(t, prop)
    import mimetypes

    import drive
    import ontology

    data = await _body(request)
    name = mediaItemPath.replace("\\", "/").rsplit("/", 1)[-1] or "upload"
    mt = mimetypes.guess_type(name)[0] or request.headers.get("content-type") or "application/octet-stream"
    item = drive.save_bytes(ontology.media_folder(t["id"], prop)["id"], name, data, mt)
    return {"mimeType": mt, "reference": {"type": "mediaSetViewItem", "mediaSetViewItem": {"mediaSetRid": "ri.mio.main.media-set." + str(item.get("parent_id") or ""),
                                                                                         "mediaSetViewRid": "ri.mio.main.view." + str(item.get("parent_id") or ""), "mediaItemRid": item["id"]}},
            "mediaItemRid": item["id"], "sizeBytes": len(data)}


def _object_media(o: str, object_type: str, pk: str, prop: str) -> dict:
    import drive
    import pipeline_ai

    _ontology(o)
    t = _type_by_api(object_type)
    _check("object_types", t["id"], f"the object type {object_type}")
    _media_prop(t, prop)
    row = next((r for r in _rows(t) if str(r.get("__primaryKey", r.get(t["primary_key"]))) == pk), None)
    if row is None:
        raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ObjectNotFound", "parameters": {"primaryKey": pk}})
    ref = row.get(prop)
    if not ref:
        raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "MediaItemNotFound", "parameters": {"property": prop}, "message": "the property is empty"})
    return drive._item(pipeline_ai.parse_ref(ref.get("id") if isinstance(ref, dict) else str(ref))[0])


@router.get("/ontologies/{o}/objects/{object_type}/{pk}/media/{prop}/metadata")
def media_metadata(o: str, object_type: str, pk: str, prop: str) -> dict:
    item = _object_media(o, object_type, pk, prop)
    return {"path": item["name"], "sizeBytes": item.get("size_bytes", item.get("size")) or 0, "mediaType": item.get("content_type") or "application/octet-stream"}


@router.get("/ontologies/{o}/objects/{object_type}/{pk}/media/{prop}/content")
def media_content(o: str, object_type: str, pk: str, prop: str) -> Response:
    import drive

    item = _object_media(o, object_type, pk, prop)
    return Response(drive.read_bytes(item), media_type=item.get("content_type") or "application/octet-stream")


class ExecuteIn(BaseModel):
    parameters: dict = Field(default_factory=dict)


@router.post("/ontologies/{o}/queries/{query}/execute")
def execute(o: str, query: str, req: ExecuteIn) -> dict:
    _ontology(o)
    import functions_registry

    fid = next((f["id"] for f in functions_registry.list_functions("", None) if f.get("api_name") == query or f["id"] == query), None)
    _check("functions", fid or query, f"the function {query}")
    r = functions_registry.execute_query(query, functions_registry.ExecuteIn(inputs=req.parameters))
    if not r.get("ok", True):
        raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "QueryRuntimeError", "parameters": {"message": r.get("error")}})
    return {"value": r.get("value")}


@router.get("/admin/users/getCurrent")
def current_user() -> dict:
    p = auth.current() or {}
    return {"id": p.get("id"), "username": p.get("username"), "givenName": p.get("first_name"), "familyName": p.get("last_name"),
            "email": p.get("email"), "realm": "palantir-internal-realm", "attributes": {}}
