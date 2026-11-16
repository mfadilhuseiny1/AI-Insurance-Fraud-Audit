"""Multi-datasource object types (column-wise MDOs), modelled on Palantir's "Multi-datasource object types".

Besides its backing dataset (ontology_datasources.py), an object type can take more Files datasets, each with a
column holding the primary key and columns mapped to other properties. A property comes from exactly one datasource
(no property multiplicity); at most 70 datasources. Objects are every primary key found in any of them: a key
missing from a datasource leaves that datasource's properties null. A user who cannot view one of the datasets sees
the properties it maps as null, while the object type's schema stays visible. User edits and materializations work
as for any object type. Additional datasets re-index the object type when they change.

Routes under /api/ontology/object-types/<id>/datasources. Mounted by server.py.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
from ontology import _lock

router = APIRouter(prefix="/api/ontology")
MAX_DATASOURCES = 70
_access: dict[tuple, tuple[float, bool]] = {}


def configure() -> None:
    ontology.MODEL_HOOKS.update({"mdo_rows": merge_rows, "mdo_hidden": hidden_properties})


def startup() -> None:
    threading.Thread(target=_watch, daemon=True, name="mdo-watch").start()


def _extra(t: dict) -> list[dict]:
    return t.get("additional_datasources") or []


def merge_rows(t: dict, objs: dict) -> dict:
    """Add the additional datasources' columns to the indexed rows (and objects only they hold)."""
    import ontology_datasources

    extra = _extra(t)
    if not extra:
        return objs
    props = {p["api_name"]: p for p in t["properties"]}
    now = ontology._now()
    for ds in extra:
        _, _, rows = ontology_datasources._read(ds["dataset_id"])
        by_pk = {}
        for r in rows:
            pk = r.get(ds["pk_column"])
            if pk not in (None, ""):
                by_pk[str(pk)] = r
        mapped = list(ds["columns"].items())
        for pk in set(objs) | set(by_pk):
            if pk not in objs:
                # a key only this datasource holds: the backing dataset's properties are null
                base = {api: None for api in ((t.get("backing_dataset") or {}).get("columns") or {}).values()}
                objs[pk] = {"properties": {**base, t["primary_key"]: pk}, "created_at": now, "updated_at": now}
            o = objs[pk]
            r = by_pk.get(pk)
            for col, api in mapped:
                p = props.get(api)
                if p is None:
                    continue
                if r is None:
                    o["properties"][api] = None
                    continue
                try:
                    o["properties"][api] = ontology.coerce_property({**p, "value_type_id": None}, r.get(col), api)
                except HTTPException:
                    o["properties"][api] = None
    return objs


def _can_view(dataset_id: str) -> bool:
    p = auth.current()
    if p is None or p.get("service") or not auth.enabled():
        return True
    key = (p.get("id"), dataset_id)
    hit = _access.get(key)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    try:
        import drive

        drive._item(dataset_id)
        ok = True
    except HTTPException:
        ok = False
    _access[key] = (time.time(), ok)
    return ok


def hidden_properties(t: dict, obj: Optional[dict] = None) -> list[str]:
    """Properties of datasources the user cannot view, or whose mandatory control they do not satisfy (null for them)."""
    out: list[str] = []
    controls = {p["api_name"] for p in t["properties"] if p.get("mandatory_control")}
    p = auth.current()
    have = set((p or {}).get("markings") or set())
    enforce = p is not None and not p.get("service") and auth.enabled()
    for ds in _extra(t):
        mine = list(ds["columns"].values())
        if not _can_view(ds["dataset_id"]):
            out += mine
        elif enforce and obj is not None and any(not ontology.control_ok((obj.get("properties") or {}).get(c), have) for c in mine if c in controls):
            out += mine
    b = t.get("backing_dataset")
    if b and _extra(t) and not _can_view(b["dataset_id"]):
        out += [api for api in b["columns"].values() if api != t["primary_key"]]
    return out


class ExtraIn(BaseModel):
    dataset_id: str
    pk_column: str
    # column -> property api name; a new property is created for names the object type does not have
    columns: dict[str, str] = Field(min_length=1)
    create_missing: bool = True


@router.get("/object-types/{type_id}/datasources")
def list_datasources(type_id: str) -> dict:
    t = ontology._object_type(type_id)
    return {"primary": t.get("backing_dataset"), "additional": _extra(t), "limit": MAX_DATASOURCES}


@router.post("/object-types/{type_id}/datasources")
def add_datasource(type_id: str, req: ExtraIn) -> dict:
    """Add a column-wise datasource: its primary key column and the properties it backs; then re-index."""
    import ontology_datasources
    import ontology_model as om

    with _lock:
        t = ontology._object_type(type_id)
        om.require_role(t.get("ontology_id"), "editor", t, "change the object type's datasources")
        if not t.get("backing_dataset"):
            raise HTTPException(400, f"{t['display_name']} has no backing dataset: add the first datasource in the Datasources tab")
        if 1 + len(_extra(t)) >= MAX_DATASOURCES:
            raise HTTPException(400, f"an object type has at most {MAX_DATASOURCES} datasources")
        used = ontology_datasources._registered(req.dataset_id) or next((x for x in ontology._all("object-types") if any(d["dataset_id"] == req.dataset_id for d in _extra(x))), None)
        if used or t["backing_dataset"]["dataset_id"] == req.dataset_id:
            raise HTTPException(409, f"DatasetAndBranchAlreadyRegistered: the dataset already backs {(used or t)['display_name']}")
    info, cols, rows = ontology_datasources._read(req.dataset_id)
    by_col = {c["name"]: c for c in cols}
    if req.pk_column not in by_col:
        raise HTTPException(400, f"FoundryColumnNameNotFound: the dataset has no column {req.pk_column}")
    if not ontology_datasources._unique(rows, req.pk_column):
        raise HTTPException(400, f"DuplicatePrimaryKey: {req.pk_column} must be unique and set on every row")
    with _lock:
        t = ontology._object_type(type_id)
        taken = {api: "the backing dataset" for api in t["backing_dataset"]["columns"].values()}
        for d in _extra(t):
            taken.update({api: d.get("name") or d["dataset_id"] for api in d["columns"].values()})
        names = {p["api_name"] for p in t["properties"]}
        new_props = []
        for col, api in req.columns.items():
            if col not in by_col:
                raise HTTPException(400, f"FoundryColumnNameNotFound: the dataset has no column {col}")
            if not by_col[col]["supported"]:
                raise HTTPException(400, f"UnsupportedColumnType: {col} cannot back a property")
            if api == t["primary_key"]:
                raise HTTPException(400, "the primary key comes from the pk column, not a mapped column")
            if api in taken:
                raise HTTPException(400, f"{api} already comes from {taken[api]}: a property comes from one datasource only")
            if api not in names:
                if not req.create_missing:
                    raise HTTPException(400, f"{t['display_name']} has no property {api}")
                ontology.check_api_name(api, "property")
                new_props.append({"api_name": api, "display_name": col.replace("_", " ").capitalize(), "type": by_col[col]["property_type"], "description": "",
                                  **({"array": True} if by_col[col]["array"] else {})})
                names.add(api)
            taken[api] = info.get("name")
        if new_props:
            for p in new_props:
                ontology._check_property(p)
            t["properties"] = t["properties"] + new_props
        t["additional_datasources"] = _extra(t) + [{"dataset_id": req.dataset_id, "name": info.get("name"), "pk_column": req.pk_column, "columns": req.columns,
                                                    "dataset_updated_at": info.get("updated_at")}]
        ontology._put("object-types", t)
    res = ontology_datasources.reindex(type_id)
    return {**list_datasources(type_id), "reindex": res}


@router.delete("/object-types/{type_id}/datasources/{dataset_id}")
def remove_datasource(type_id: str, dataset_id: str) -> dict:
    """Remove an additional datasource; the properties it backed keep their last values (edits only from now on)."""
    with _lock:
        t = ontology._object_type(type_id)
        if not any(d["dataset_id"] == dataset_id for d in _extra(t)):
            raise HTTPException(404, "not an additional datasource of this object type")
        t["additional_datasources"] = [d for d in _extra(t) if d["dataset_id"] != dataset_id]
        ontology._put("object-types", t)
    return list_datasources(type_id)


def _watch() -> None:
    import db
    import ontology_datasources

    while True:
        time.sleep(30)
        if not db.enabled():
            continue
        for t in ontology._all("object-types"):
            changed = False
            for d in _extra(t):
                try:
                    item = db.drive_get(d["dataset_id"])
                except Exception:  # noqa: BLE001
                    continue
                if item and str(item.get("updated_at")) != str(d.get("dataset_updated_at")):
                    d["dataset_updated_at"] = str(item.get("updated_at"))
                    changed = True
            if changed:
                with _lock:
                    cur = ontology._object_type(t["id"])
                    cur["additional_datasources"] = _extra(t)
                    ontology._put("object-types", cur)
                try:
                    ontology_datasources.reindex(t["id"])
                except Exception:  # noqa: BLE001 - errors are kept on the datasource
                    continue

