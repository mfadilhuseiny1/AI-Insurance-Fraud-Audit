"""Join table datasets for many-to-many link types (Palantir's "Join table dataset relationship type").

A join table link type can be backed by a Files dataset holding every combination of the two object types' primary
keys: one column mapped to each side (a column backs one side only). The links are the dataset's rows plus the
links users add or remove (actions, Object Views, Peer Manager), kept apart so a re-index does not lose them — like
user edits on objects. "Generate join table" writes a dataset with the right schema from the current links and backs
the link type with it. A dataset can back one link type (Phonograph2:DatasetAndBranchAlreadyRegistered otherwise),
and links whose keys are not objects are reported. The link type re-indexes when its dataset changes (watcher) or on
request.

After a join table link type is converted to object-backed, its old join table dataset keeps being written: the
watcher rewrites it from the backing objects' links whenever they change (`join_table_sync` on the link type), so
pipelines reading it keep working; DELETE .../join-table-sync stops that.

Routes under /api/ontology/link-types/<id>/datasource. Mounted by server.py.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import ontology
import ontology_model as om
from ontology import _lock, _now, _read, _write

router = APIRouter(prefix="/api/ontology")


def configure() -> None:
    ontology.MODEL_HOOKS["link_edits"] = record_edits


def startup() -> None:
    threading.Thread(target=_watch, daemon=True, name="link-datasets").start()


def _edits_path(lt_id: str):
    return ontology.DIR / "links" / f"{lt_id}.edits.json"


def edits(lt_id: str) -> dict:
    return _read(_edits_path(lt_id), {}) or {"add": [], "remove": []}


def record_edits(lt_id: str, done: list[dict]) -> None:
    """Links users added or removed on a dataset-backed link type (kept across re-indexes)."""
    lt = _read(ontology._path("link-types", lt_id))
    if not lt or not lt.get("backing_dataset"):
        return
    e = edits(lt_id)
    add = {tuple(p) for p in e["add"]}
    rem = {tuple(p) for p in e["remove"]}
    for ln in done:
        pair = (str(ln["source"]), str(ln["target"]))
        if ln["op"] == "add":
            rem.discard(pair)
            add.add(pair)
        else:
            add.discard(pair)
            rem.add(pair)
    _write(_edits_path(lt_id), {"add": sorted(map(list, add)), "remove": sorted(map(list, rem))})


def _used(dataset_id: str, except_lt: Optional[str] = None) -> Optional[str]:
    for lt in ontology._all("link-types"):
        if (lt.get("backing_dataset") or {}).get("dataset_id") == dataset_id and lt["id"] != except_lt:
            return lt.get("display_name") or lt["id"]
    for t in ontology._all("object-types"):
        if (t.get("backing_dataset") or {}).get("dataset_id") == dataset_id:
            return t["display_name"]
    return None


def reindex(lt_id: str) -> dict:
    """The links from the dataset's rows, with users' additions and removals on top."""
    import ontology_datasources

    lt = ontology._get("link-types", lt_id, "link type")
    b = lt.get("backing_dataset")
    if not b:
        raise HTTPException(400, "this link type has no join table dataset")
    info, cols, rows = ontology_datasources._read(b["dataset_id"])
    names = {c["name"] for c in cols}
    missing = [c for c in (b["source_column"], b["target_column"]) if c not in names]
    if missing:
        raise HTTPException(400, f"FoundryColumnNameNotFound: the dataset has no column {missing[0]}")
    pairs = {(str(r.get(b["source_column"])), str(r.get(b["target_column"]))) for r in rows
             if r.get(b["source_column"]) not in (None, "") and r.get(b["target_column"]) not in (None, "")}
    e = edits(lt_id)
    pairs = (pairs - {tuple(p) for p in e["remove"]}) | {tuple(p) for p in e["add"]}
    src = ontology.stored_objects(lt["source"]["object_type_id"])
    tgt = ontology.stored_objects(lt["target"]["object_type_id"])
    dangling = sum(1 for s, t in pairs if s not in src or t not in tgt)
    with _lock:
        _write(ontology.DIR / "links" / f"{lt_id}.json", sorted(map(list, pairs)))
        lt = ontology._get("link-types", lt_id, "link type")
        lt["backing_dataset"] = {**b, "synced_at": _now(), "dataset_updated_at": info.get("updated_at"), "rows": len(rows), "dangling": dangling}
        ontology._put("link-types", lt)
    return {"links": len(pairs), "rows": len(rows), "user_added": len(e["add"]), "user_removed": len(e["remove"]), "dangling": dangling}


class DatasourceIn(BaseModel):
    dataset_id: str
    source_column: str
    target_column: str
    auto_reindex: bool = True


def _join_table(lt_id: str) -> dict:
    lt = ontology._get("link-types", lt_id, "link type")
    if lt.get("kind") != "join_table":
        raise HTTPException(400, "only many-to-many (join table) link types are backed by a join table dataset")
    om.require_role(lt.get("ontology_id"), "editor", lt, "change the link type's datasource")
    return lt


@router.get("/link-types/{lt_id}/datasource")
def get_datasource(lt_id: str) -> dict:
    lt = ontology._get("link-types", lt_id, "link type")
    return {"backing_dataset": lt.get("backing_dataset"), "user_edits": edits(lt_id) if lt.get("backing_dataset") else None}


@router.put("/link-types/{lt_id}/datasource")
def set_datasource(lt_id: str, req: DatasourceIn) -> dict:
    """Back the link type with a dataset: a column per side (each mapped once); its rows become the links. Links that
    existed before are kept as user additions."""
    import ontology_datasources

    lt = _join_table(lt_id)
    if req.source_column == req.target_column:
        raise HTTPException(400, "a column can only be mapped to one primary key")
    other = _used(req.dataset_id, lt_id)
    if other:
        raise HTTPException(409, f"Phonograph2:DatasetAndBranchAlreadyRegistered: the dataset already backs {other}")
    info, cols, _ = ontology_datasources._read(req.dataset_id)
    names = {c["name"] for c in cols}
    for c in (req.source_column, req.target_column):
        if c not in names:
            raise HTTPException(400, f"FoundryColumnNameNotFound: the dataset has no column {c}")
    with _lock:
        if not lt.get("backing_dataset"):
            current = _read(ontology.DIR / "links" / f"{lt_id}.json", []) or []
            _write(_edits_path(lt_id), {"add": sorted(map(list, {tuple(map(str, p)) for p in current})), "remove": []})
        lt["backing_dataset"] = {"dataset_id": req.dataset_id, "name": info.get("name"), "source_column": req.source_column,
                                 "target_column": req.target_column, "auto_reindex": req.auto_reindex}
        ontology._put("link-types", lt)
    return {**reindex(lt_id), "backing_dataset": ontology._get("link-types", lt_id, "link type")["backing_dataset"]}


class GenerateIn(BaseModel):
    name: Optional[str] = None
    folder_id: Optional[str] = None


@router.post("/link-types/{lt_id}/datasource/generate")
def generate(lt_id: str, req: GenerateIn) -> dict:
    """Generate join table: a dataset with one column per side's primary key, filled with the current links, then
    back the link type with it."""
    import drive
    import pipeline_datasets
    import pyarrow as pa

    lt = _join_table(lt_id)
    s_t = ontology._object_type(lt["source"]["object_type_id"])
    t_t = ontology._object_type(lt["target"]["object_type_id"])
    s_col, t_col = f"{s_t['api_name']}_{s_t['primary_key']}", f"{t_t['api_name']}_{t_t['primary_key']}"
    if s_col == t_col:
        t_col += "_target"
    pairs = _read(ontology.DIR / "links" / f"{lt_id}.json", []) or []
    table = pa.table({s_col: pa.array([str(p[0]) for p in pairs], pa.string()), t_col: pa.array([str(p[1]) for p in pairs], pa.string())})
    item = drive.save_bytes(req.folder_id or drive.default_folder("ontology"), f"{req.name or (lt.get('display_name') or lt_id) + ' join table'}.parquet",
                            pipeline_datasets._parquet_bytes(table), pipeline_datasets.PARQUET)
    with _lock:
        lt = ontology._get("link-types", lt_id, "link type")
        lt["backing_dataset"] = {"dataset_id": item["id"], "name": item["name"], "source_column": s_col, "target_column": t_col, "auto_reindex": True}
        ontology._put("link-types", lt)
        _write(_edits_path(lt_id), {"add": [], "remove": []})
    return {**reindex(lt_id), "dataset_id": item["id"], "columns": [s_col, t_col]}


@router.post("/link-types/{lt_id}/datasource/reindex")
def reindex_route(lt_id: str) -> dict:
    _join_table(lt_id)
    return reindex(lt_id)


@router.delete("/link-types/{lt_id}/datasource")
def detach(lt_id: str) -> dict:
    """Stop backing the link type with the dataset (the links stay, edited internally from now on)."""
    with _lock:
        lt = _join_table(lt_id)
        lt.pop("backing_dataset", None)
        ontology._put("link-types", lt)
        _edits_path(lt_id).unlink(missing_ok=True)
    return {"detached": lt_id}


def _watch() -> None:
    import db

    while True:
        time.sleep(30)
        if not db.enabled():
            continue
        for lt in ontology._all("link-types"):
            b = lt.get("backing_dataset")
            if not b or not b.get("auto_reindex", True):
                continue
            try:
                item = db.drive_get(b["dataset_id"])
                if item and str(item.get("updated_at")) != str(b.get("dataset_updated_at")):
                    reindex(lt["id"])
            except Exception:  # noqa: BLE001 - kept for the next tick
                continue
        for lt in ontology._all("link-types"):
            if (lt.get("join_table_sync") or {}).get("dataset_id"):
                try:
                    sync_join_table(lt["id"])
                except Exception:  # noqa: BLE001 - kept for the next tick
                    continue


def sync_join_table(lt_id: str) -> dict:
    """Rewrite a converted link type's old join table dataset from its current links (when they changed)."""
    import hashlib

    import db
    import pipeline_datasets
    import pyarrow as pa

    lt = ontology._get("link-types", lt_id, "link type")
    js = lt.get("join_table_sync") or {}
    if not js.get("dataset_id"):
        raise HTTPException(400, "the link type keeps no join table dataset in sync")
    pairs = sorted({(str(a), str(b)) for a, b in om._pairs(lt)})
    digest = hashlib.sha256(repr(pairs).encode()).hexdigest()
    if digest == js.get("digest"):
        return {"written": False, "links": len(pairs)}
    item = db.drive_get(js["dataset_id"])
    if not item or item.get("trashed_at"):
        with _lock:
            lt = ontology._get("link-types", lt_id, "link type")
            lt.pop("join_table_sync", None)
            ontology._put("link-types", lt)
        return {"written": False, "stopped": "the dataset was deleted"}
    table = pa.table({js["source_column"]: pa.array([p[0] for p in pairs], pa.string()), js["target_column"]: pa.array([p[1] for p in pairs], pa.string())})
    pipeline_datasets._replace_content(item, pipeline_datasets._parquet_bytes(table))
    with _lock:
        lt = ontology._get("link-types", lt_id, "link type")
        lt["join_table_sync"] = {**(lt.get("join_table_sync") or js), "digest": digest, "synced_at": _now(), "rows": len(pairs)}
        ontology._put("link-types", lt)
    return {"written": True, "links": len(pairs)}


@router.post("/link-types/{lt_id}/join-table-sync")
def sync_now(lt_id: str) -> dict:
    return sync_join_table(lt_id)


@router.delete("/link-types/{lt_id}/join-table-sync")
def stop_sync(lt_id: str) -> dict:
    """Stop writing the old join table dataset (it keeps its last contents)."""
    with _lock:
        lt = ontology._get("link-types", lt_id, "link type")
        om.require_role(lt.get("ontology_id"), "editor", lt, "change the link type")
        lt.pop("join_table_sync", None)
        ontology._put("link-types", lt)
    return {"stopped": lt_id}


# ------------------------------------------------------------------------------------------------
# converting links to object-backed link types
# ------------------------------------------------------------------------------------------------


class ConvertIn(BaseModel):
    backing_object_type_id: str
    # the backing object type's properties holding the source and target primary keys
    source_property: str
    target_property: str
    # create a backing object for each existing link that has none
    migrate_links: bool = True


@router.post("/link-types/{lt_id}/convert-to-object-backed")
def convert(lt_id: str, req: ConvertIn) -> dict:
    """Update a foreign key or join table link type to an object-backed one ("Update to object-backed")."""
    with _lock:
        lt = ontology._get("link-types", lt_id, "link type")
        om.require_role(lt.get("ontology_id"), "editor", lt, "change the link type")
        if lt["kind"] == "object_backed":
            raise HTTPException(400, "the link type is already object-backed")
        bt = ontology._object_type(req.backing_object_type_id)
        if bt["id"] in (lt["source"]["object_type_id"], lt["target"]["object_type_id"]):
            raise HTTPException(400, "the backing object type sits between the two sides: pick a third object type")
        props = {p["api_name"]: p for p in bt["properties"]}
        for name in (req.source_property, req.target_property):
            if name not in props or props[name].get("array") or props[name]["type"] not in ontology.PK_TYPES:
                raise HTTPException(400, f"{bt['display_name']} has no scalar key property {name}")
        if req.source_property == req.target_property:
            raise HTTPException(400, "the source and target properties must differ")
        pairs = om._pairs(lt)
        existing = {(str((o.get("properties") or {}).get(req.source_property)), str((o.get("properties") or {}).get(req.target_property)))
                    for o in ontology.stored_objects(bt["id"]).values()}
        todo = [p for p in pairs if p not in existing] if req.migrate_links else []
        if todo and not bt.get("generate_primary_key") and ontology._ptype(bt, bt["primary_key"]) != "string":
            raise HTTPException(400, f"{bt['display_name']} needs a string primary key to create backing objects for the existing links")
        old = {k: lt.get(k) for k in ("kind", "foreign_key", "cardinality", "backing")}
        jt = lt.get("backing_dataset") if lt["kind"] == "join_table" else None
        lt["kind"] = "object_backed"
        lt["backing"] = {"object_type_id": bt["id"], "source_property": req.source_property, "target_property": req.target_property}
        lt["cardinality"] = "many_to_many" if old["kind"] == "join_table" else (old["cardinality"] or "many_to_one")
        lt.pop("foreign_key", None)
        lt.pop("backing_dataset", None)
        om._check_link_type(lt)
        lt["converted_from"] = {**old, "at": _now()}
        if jt and jt.get("dataset_id"):
            # keep the old join table dataset written from the object-backed links (pipelines may read it)
            lt["join_table_sync"] = {"dataset_id": jt["dataset_id"], "name": jt.get("name"), "source_column": jt["source_column"], "target_column": jt["target_column"]}
        ontology._put("link-types", lt)
    created = 0
    if todo:
        edits = [{"op": "create", "object_type_id": bt["id"], "primary_key": f"{s}|{t}",
                  "properties": {bt["primary_key"]: f"{s}|{t}", req.source_property: s, req.target_property: t}} for s, t in todo]
        ontology.apply_edits(edits, source="link-conversion")
        created = len(edits)
    return {"link_type": ontology._get("link-types", lt_id, "link type"), "links": len(pairs), "backing_objects_created": created}
