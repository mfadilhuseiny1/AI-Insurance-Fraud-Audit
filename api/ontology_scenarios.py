"""Ontology scenarios, modelled on Foundry's Ontology scenarios (Beta): what-if sandboxes on top of the Ontology.

A scenario holds edits made by applying actions (or Ontology edits) in it: objects created, modified (the changed
properties only) or deleted, and join table links added or removed. While a request works in a scenario
(`ontology.SCENARIO`), every read sees main with the scenario's edits on top — Object Explorer searches, aggregations,
links, derived properties, action forms — and every edit goes to the scenario instead of main: no edit history,
indexing or automations run on main. Submission criteria can tell the two apart: the execution context is "scenario".

Because edits store only what changed, a scenario always sits on the latest main: the auto-rebase (every 10 minutes)
records the time and the conflicts — a modified object deleted on main, or a created object whose primary key main
now uses. Scenarios are not snapshots of the past.

Lifetime: temporary scenarios end with the session (one day without use here); persisted ones are shared, have an
owner, description and a review status (draft, in review, approved, rejected). Every scenario is deleted 30 days
after it was created (its time to live), with its edits.

Merging: through an action type with an "Apply scenario" rule (ontology_actions.py) whose Scenario parameter holds the
scenario's RID; the rule lists the object types and link types the scenario may change, the action's permissions and
submission criteria govern who may merge, and all edits are applied to main as one transaction. Comparing runs the
same aggregation on main and on each scenario.

Staged writes (Python functions' WriteableClient): a function run gets a hidden temporary scenario as its
transaction. The runtime syncs its staged edits to it (PUT /staged-writes/<id>) before every read and sends its
requests with the header x-bluesandai-scenario, so reads see the edits (read-after-write) while nothing reaches main;
the edits are committed by the function-backed action at the end and the scenario is deleted (or discarded on error).
Nested calls: a query or staged-write function called from inside the run executes with the same header, so it reads
the caller's staged edits; a staged-write one joins the transaction as a layer ("<id>~<layer>", applied after the
caller's edits) and returns its edits to the caller, which stages them as its own — committed with the outer run, or
discarded with it when any call raises. A write made inside the transaction without staging (a called function
applying an action with the run's header) is recorded as a direct edit of the run whose header it carried; the run
takes it (POST /staged-writes/<id>/direct) and stages it as its own, so its next sync does not drop it and the action
commits it — like Foundry, where every operation inside a staged-write run joins the staged edits. Until taken, direct
edits are applied on top of the layers at each rebuild; a nested call that ends without taking them hands them to its
caller. A plain query called inside the run that itself calls a staged-write function has no staged edits to hold the
ones it gets back: it adds them as direct edits under its caller's header (POST /staged-writes/<id>/direct/add), so it
reads them and its caller takes them. Any call inside the transaction that fails marks it failed (also when a function
in between caught the error); a run learns it when it takes direct edits or ends the transaction, and discards all.

Records are JSON files under data/ontology/scenarios/. Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import contextlib
import contextvars
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import ontology
from ontology import _lock, _now, _read, _write

router = APIRouter(prefix="/api/ontology")

TTL_DAYS = 30
TEMPORARY_IDLE = timedelta(days=1)
REBASE_EVERY = 600  # seconds
ACTIVITY_KEPT = 500
STATUSES = ("draft", "in_review", "approved", "rejected", "merged")
# set while a scenario route applies an action: (label, run id) of the activity entry its edits go to
_RUN: contextvars.ContextVar[Optional[tuple[str, str]]] = contextvars.ContextVar("scenario_run", default=None)
# the scenario header of the request (a staged-write run's layer "<id>~<layer>" kept whole: writes made with it belong
# to that run) and whether a staged transaction is being rebuilt from its layers (those writes are not direct writes)
_REQ_SID: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("scenario_request_sid", default=None)
_REBUILDING: contextvars.ContextVar[bool] = contextvars.ContextVar("staged_rebuilding", default=False)


def configure() -> None:
    (ontology.DIR / "scenarios").mkdir(parents=True, exist_ok=True)
    ontology.MODEL_HOOKS.update({
        "scenario_objects": _overlay_objects, "scenario_links": _overlay_links, "scenario_write": _write_edits,
        "scenario_link_write": _write_links, "scenario_merge_edits": merge_edits, "scenario_merged": _mark_merged,
    })


def startup() -> None:
    threading.Thread(target=_rebase_loop, daemon=True, name="scenario-rebase").start()


# ------------------------------------------------------------------------------------------------
# storage
# ------------------------------------------------------------------------------------------------


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def _path(sid: str):
    return ontology._path("scenarios", sid)


def _resolve(ref: Any) -> str:
    """A scenario id from its id or RID."""
    ref = str(ref or "").strip()
    if ref.startswith("ri."):
        ref = "scn-" + ref.rsplit(".", 1)[-1]
    if not ref:
        raise HTTPException(400, "pick a scenario")
    return ref


def _load(ref: Any) -> dict:
    sid = _resolve(ref)
    sc = _read(_path(sid))
    if not sc or _expired(sc):
        raise HTTPException(404, "scenario not found (it may have expired)")
    return sc


def _save(sc: dict) -> dict:
    sc["updated_at"] = _now()
    _write(_path(sc["id"]), sc)
    return sc


def _expired(sc: dict, now: Optional[datetime] = None) -> bool:
    now = now or datetime.now(timezone.utc)
    if now >= _parse(sc["expires_at"]):
        return True
    return not sc.get("persisted") and now - _parse(sc.get("last_used_at") or sc["created_at"]) > TEMPORARY_IDLE


def _who() -> str:
    return auth.actor_id() or (auth.current() or {}).get("username") or "local"


def _can_read(sc: dict) -> bool:
    # temporary scenarios belong to the session that made them; persisted ones are shared
    return bool(sc.get("persisted")) or sc.get("created_by") == _who() or not auth.enabled()


def _owned(ref: Any) -> dict:
    sc = _load(ref)
    if not _can_read(sc):
        raise HTTPException(404, "scenario not found")
    return sc


@contextlib.contextmanager
def active(ref: Any) -> Iterator[dict]:
    """Work in a scenario for the duration of the block."""
    sc = _owned(ref)
    if sc.get("merged"):
        raise HTTPException(400, "this scenario was merged: create a new one to keep exploring")
    token = ontology.SCENARIO.set(sc["id"])
    try:
        yield sc
    finally:
        ontology.SCENARIO.reset(token)


# ------------------------------------------------------------------------------------------------
# overlay (ontology.py hooks)
# ------------------------------------------------------------------------------------------------


def _overlay_objects(sid: str, type_id: str, main: dict) -> dict:
    sc = _read(_path(sid)) or {}
    edits = (sc.get("objects") or {}).get(type_id)
    if not edits:
        return main
    out = dict(main)
    for pk, e in edits.items():
        if e["op"] == "delete":
            out.pop(pk, None)
        elif e["op"] == "create":
            out[pk] = {"properties": dict(e["properties"]), "created_at": e["at"], "updated_at": e["at"]}
        else:
            base = main.get(pk)
            if base is None:
                # deleted on main since: a conflict, the scenario cannot modify it any more
                continue
            out[pk] = {**base, "properties": {**(base.get("properties") or {}), **e["properties"]}, "updated_at": e["at"]}
    return out


def _overlay_links(sid: str, link_type_id: str, main: list) -> list:
    sc = _read(_path(sid)) or {}
    ln = (sc.get("links") or {}).get(link_type_id)
    if not ln:
        return main
    removed = {tuple(map(str, p)) for p in ln.get("remove") or []}
    pairs = [p for p in main if tuple(map(str, p)) not in removed]
    have = {tuple(map(str, p)) for p in pairs}
    return pairs + [list(p) for p in ln.get("add") or [] if tuple(map(str, p)) not in have]


def _write_edits(sid: str, by_type: dict[str, dict], written: list[dict]) -> None:
    """Store the edits apply_edits made in the scenario as differences from main."""
    sc = _read(_path(sid))
    if not sc:
        raise HTTPException(404, "scenario not found")
    now = _now()
    # a write inside a staged-write transaction that is not the transaction's own rebuild (an action applied by a
    # function the run called, say): it joins the staged edits of the run whose header it came with
    direct = [] if sc.get("staged") and not _REBUILDING.get() else None
    for tid, final in by_type.items():
        main = ontology.load_objects(tid)
        edits = sc.setdefault("objects", {}).setdefault(tid, {})
        for w in written:
            if w["object_type_id"] != tid:
                continue
            pk = str(w["primary_key"])
            f, m = final.get(pk), main.get(pk)
            if direct is not None:
                d = _direct_edit(tid, pk, f, m, edits.get(pk))
                if d:
                    direct.append(d)
            if f is None:
                if m is None:
                    edits.pop(pk, None)
                else:
                    edits[pk] = {"op": "delete", "properties": {}, "at": now}
            elif m is None:
                edits[pk] = {"op": "create", "properties": dict(f.get("properties") or {}), "at": now}
            else:
                mp = m.get("properties") or {}
                changed = {k: v for k, v in (f.get("properties") or {}).items() if mp.get(k) != v}
                if changed:
                    edits[pk] = {"op": "modify", "properties": changed, "at": now}
                else:
                    edits.pop(pk, None)
        if not edits:
            sc["objects"].pop(tid, None)
    if direct:
        _add_direct(sc, direct)
    _activity(sc, [{"op": w["op"], "object_type_id": w["object_type_id"], "primary_key": str(w["primary_key"])} for w in written], 0)
    _save(sc)


def _direct_edit(tid: str, pk: str, final: Optional[dict], main: Optional[dict], prior_edit: Optional[dict]) -> Optional[dict]:
    """A direct write as an Ontology edit against what the transaction showed before it (main with its staged edits)."""
    mp = (main or {}).get("properties") or {}
    if prior_edit is None:
        prior = None if main is None else dict(mp)
    elif prior_edit["op"] == "delete":
        prior = None
    elif prior_edit["op"] == "create":
        prior = dict(prior_edit["properties"])
    else:
        prior = None if main is None else {**mp, **prior_edit["properties"]}
    if final is None:
        return None if prior is None else {"op": "delete", "object_type_id": tid, "primary_key": pk, "properties": {}}
    props = dict(final.get("properties") or {})
    if prior is None:
        return {"op": "create", "object_type_id": tid, "primary_key": pk, "properties": props}
    changed = {k: v for k, v in props.items() if prior.get(k) != v}
    return {"op": "modify", "object_type_id": tid, "primary_key": pk, "properties": changed} if changed else None


def _add_direct(sc: dict, edits: list[dict]) -> None:
    key = _REQ_SID.get() or sc["id"]
    if _split(key)[0] != sc["id"]:
        key = sc["id"]
    sc.setdefault("direct", {}).setdefault(key, []).extend(edits)


def _write_links(sid: str, links: list[dict]) -> list[dict]:
    sc = _read(_path(sid))
    if not sc:
        raise HTTPException(404, "scenario not found")
    done = []
    for ln in links:
        main = {tuple(map(str, p)) for p in _read(ontology.DIR / "links" / f"{ln['link_type_id']}.json", []) or []}
        rec = sc.setdefault("links", {}).setdefault(ln["link_type_id"], {"add": [], "remove": []})
        add = {tuple(p) for p in rec["add"]}
        rem = {tuple(p) for p in rec["remove"]}
        pair = (str(ln["source"]), str(ln["target"]))
        visible = (pair in main and pair not in rem) or pair in add
        if ln["op"] == "add" and not visible:
            rem.discard(pair)
            if pair not in main:
                add.add(pair)
            done.append(ln)
        elif ln["op"] == "remove" and visible:
            add.discard(pair)
            if pair in main:
                rem.add(pair)
            done.append(ln)
        rec["add"], rec["remove"] = sorted(map(list, add)), sorted(map(list, rem))
        if not rec["add"] and not rec["remove"]:
            sc["links"].pop(ln["link_type_id"], None)
    if done and sc.get("staged") and not _REBUILDING.get():
        _add_direct(sc, [{"kind": "link", "op": x["op"], "link_type_id": x["link_type_id"], "source": str(x["source"]), "target": str(x["target"])} for x in done])
    if done:
        _activity(sc, [], len(done))
        _save(sc)
    return done


def _activity(sc: dict, edited: list[dict], links: int) -> None:
    sc["last_used_at"] = _now()
    label, run = _RUN.get() or ("Ontology edits", None)
    acts = sc.setdefault("activity", [])
    # an action's object edits and link edits are one entry
    if run and acts and acts[-1].get("run") == run:
        acts[-1]["edited"] = (acts[-1]["edited"] + edited)[:200]
        acts[-1]["links"] += links
    else:
        acts.append({"at": _now(), "user": _who(), "label": label, "run": run, "edited": edited[:200], "links": links})
    sc["activity"] = acts[-ACTIVITY_KEPT:]


# ------------------------------------------------------------------------------------------------
# conflicts, rebase and merge
# ------------------------------------------------------------------------------------------------


def _conflicts(sc: dict) -> list[dict]:
    out = []
    for tid, edits in (sc.get("objects") or {}).items():
        main = ontology.load_objects(tid)
        for pk, e in edits.items():
            if e["op"] == "modify" and pk not in main:
                out.append({"object_type_id": tid, "primary_key": pk, "reason": "deleted on main after the scenario modified it"})
            elif e["op"] == "create" and pk in main:
                out.append({"object_type_id": tid, "primary_key": pk, "reason": "main now has an object with this primary key"})
    return out


def _rebase(sc: dict) -> dict:
    sc["rebase"] = {"at": _now(), "conflicts": _conflicts(sc)}
    return sc


def _rebase_loop() -> None:
    while True:
        time.sleep(REBASE_EVERY)
        try:
            sweep()
        except Exception:  # noqa: BLE001 - the loop must survive
            pass


def sweep() -> dict:
    """Delete expired scenarios and auto-rebase the others."""
    now = datetime.now(timezone.utc)
    deleted = rebased = 0
    with _lock:
        for p in (ontology.DIR / "scenarios").glob("*.json"):
            sc = _read(p)
            if not sc:
                continue
            if _expired(sc, now):
                p.unlink(missing_ok=True)
                deleted += 1
            elif not sc.get("merged"):
                _write(p, _rebase(sc))
                rebased += 1
    return {"deleted": deleted, "rebased": rebased}


def merge_edits(ref: Any, object_type_ids: list[str], link_type_ids: list[str]) -> tuple[list[dict], list[dict]]:
    """The edits that merge a scenario into main (the Apply scenario rule), checked against its scope and main."""
    sc = _load(ref)
    if sc.get("merged"):
        raise HTTPException(400, f"{sc['name']} was already merged")
    edits: list[dict] = []
    for tid, objs in (sc.get("objects") or {}).items():
        if tid not in object_type_ids:
            name = (_read(ontology._path("object-types", tid)) or {}).get("display_name", tid)
            raise HTTPException(400, f"{sc['name']} edits {name}, which this merge action does not cover")
        main = ontology.load_objects(tid)
        for pk, e in objs.items():
            if e["op"] == "create":
                if pk in main:
                    raise HTTPException(409, f"{pk} was created in the scenario but main now has it: resolve the conflict first")
                edits.append({"op": "create", "object_type_id": tid, "primary_key": pk, "properties": e["properties"]})
            elif e["op"] == "modify":
                if pk not in main:
                    raise HTTPException(409, f"{pk} was modified in the scenario but deleted on main: discard that edit first")
                edits.append({"op": "modify", "object_type_id": tid, "primary_key": pk, "properties": e["properties"]})
            elif pk in main:
                edits.append({"op": "delete", "object_type_id": tid, "primary_key": pk, "properties": {}})
    links: list[dict] = []
    for lid, rec in (sc.get("links") or {}).items():
        if lid not in link_type_ids:
            raise HTTPException(400, f"{sc['name']} edits links of a link type this merge action does not cover")
        links += [{"op": "remove", "link_type_id": lid, "source": s, "target": t} for s, t in rec.get("remove") or []]
        links += [{"op": "add", "link_type_id": lid, "source": s, "target": t} for s, t in rec.get("add") or []]
    if not edits and not links:
        raise HTTPException(400, f"{sc['name']} has no edits to merge")
    return edits, links


def _mark_merged(ref: Any, action_rid: str) -> None:
    sc = _read(_path(_resolve(ref)))
    if sc:
        sc["merged"] = {"at": _now(), "by": _who(), "action_rid": action_rid}
        sc["status"] = "merged"
        _save(sc)


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


def _counts(sc: dict) -> dict:
    objs = sum(len(v) for v in (sc.get("objects") or {}).values())
    links = sum(len(v.get("add") or []) + len(v.get("remove") or []) for v in (sc.get("links") or {}).values())
    return {"object_edits": objs, "link_edits": links}


def _summary(sc: dict) -> dict:
    return {k: sc.get(k) for k in ("id", "rid", "name", "description", "persisted", "status", "created_by", "created_at", "updated_at",
                                    "expires_at", "last_used_at", "merged", "rebase")} | _counts(sc)


@router.get("/scenarios")
def list_scenarios(include_merged: bool = True) -> list[dict]:
    sweep_expired()
    out = []
    for p in (ontology.DIR / "scenarios").glob("*.json"):
        sc = _read(p)
        if sc and not sc.get("staged") and not _expired(sc) and _can_read(sc) and (include_merged or not sc.get("merged")):
            out.append(_summary(sc))
    return sorted(out, key=lambda s: s["updated_at"] or "", reverse=True)


def sweep_expired() -> None:
    now = datetime.now(timezone.utc)
    for p in (ontology.DIR / "scenarios").glob("*.json"):
        sc = _read(p)
        if sc and _expired(sc, now):
            p.unlink(missing_ok=True)


class ScenarioIn(BaseModel):
    name: str = Field("", max_length=200)
    description: str = Field("", max_length=2000)
    persisted: bool = False


@router.post("/scenarios")
def create_scenario(req: ScenarioIn) -> dict:
    now = datetime.now(timezone.utc)
    hexid = uuid.uuid4().hex[:16]
    sc = {"id": f"scn-{hexid}", "rid": f"ri.actions.main.scenario.{hexid}", "name": req.name.strip() or f"Scenario {now:%d %b %H:%M}",
          "description": req.description.strip(), "persisted": req.persisted, "status": "draft", "created_by": _who(),
          "created_at": now.isoformat(timespec="seconds"), "last_used_at": now.isoformat(timespec="seconds"),
          "expires_at": (now + timedelta(days=TTL_DAYS)).isoformat(timespec="seconds"),
          "objects": {}, "links": {}, "activity": [], "merged": None, "rebase": {"at": now.isoformat(timespec="seconds"), "conflicts": []}}
    with _lock:
        return _save(sc) | _counts(sc)


class ScenarioPatch(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    persisted: Optional[bool] = None
    status: Optional[Literal["draft", "in_review", "approved", "rejected"]] = None


# ------------------------------------------------------------------------------------------------
# staged writes
# ------------------------------------------------------------------------------------------------

SCENARIO_HEADER = "x-bluesandai-scenario"
# nested staged-write calls: a function called inside a run's transaction joins it as a layer, "<scenario id>~<layer>"
_LAYER_SEP = "~"


def _split(sid: str) -> tuple[str, str]:
    """(transaction id, layer) of a staged-writes id; the run that opened the transaction is layer ""."""
    base, _, layer = str(sid or "").partition(_LAYER_SEP)
    return base, layer


def staged_base(sid: Optional[str]) -> Optional[str]:
    """The staged-writes transaction a scenario id belongs to (None when it is an ordinary scenario)."""
    if not sid:
        return None
    base, _ = _split(sid)
    try:
        rec = _read(_path(_resolve(base)))
    except HTTPException:
        return None
    return base if rec and rec.get("staged") else None


def _staged(sid: str) -> dict:
    sc = _owned(_split(sid)[0])
    if not sc.get("staged"):
        raise HTTPException(400, "not a staged-writes transaction")
    return sc


class StagedBeginIn(BaseModel):
    # nested staged-write calls: the transaction of the calling run, which this run joins
    parent: Optional[str] = None


@router.post("/staged-writes")
def staged_begin(request: Request, req: Optional[StagedBeginIn] = None) -> dict:
    """A hidden temporary scenario holding one function run's staged edits — or, for a staged-write function called
    from inside another one's run (a nested call), a layer of the caller's transaction: the nested run reads the
    caller's staged edits, and its own edits go back to the caller, committed or discarded with the outer run."""
    parent = (req.parent if req else None) or _token_parent(request)
    if parent:
        layer = uuid.uuid4().hex[:10]
        with _lock:
            sc = _staged(parent)
            sc.setdefault("layers", [["", []]]).append([layer, []])
            _save(sc)
        return {"id": f"{sc['id']}{_LAYER_SEP}{layer}", "parent": sc["id"]}
    sc = create_scenario(ScenarioIn(name="Staged writes"))
    with _lock:
        rec = _read(_path(sc["id"]))
        rec["staged"] = True
        rec["layers"] = [["", []]]
        _save(rec)
    return {"id": sc["id"]}


def _token_parent(request: Any) -> Optional[str]:
    """The transaction a TypeScript run was started in (functions_ts records it under the run's job token: its
    runtime opens staged writes without naming a parent)."""
    if request is None:
        return None
    import functions_ts

    auth_header = request.headers.get("authorization") or ""
    return functions_ts.STAGED_PARENTS.get(auth_header[7:]) if auth_header.lower().startswith("bearer ") else None


class StagedIn(BaseModel):
    # the run's edits so far, as an Ontology edit function returns them (objects and links)
    edits: list[dict] = []


def _rebuild(sid: str, layers: list) -> None:
    """The transaction's scenario holds every layer's edits, applied in order (the caller's, then a nested call's)."""
    with _lock:
        sc = _staged(sid)
        sc["objects"], sc["links"] = {}, {}
        sc["layers"] = layers
        _save(sc)
    # direct writes no run has taken yet stay on top (a run takes them right after the call that made them)
    pending = [e for _, edits in (sc.get("direct") or {}).items() for e in edits]
    token = _REBUILDING.set(True)
    try:
        with active(sc["id"]):
            for _, edits in layers:
                _apply_layer(edits)
            if pending:
                _apply_layer(pending, tolerant=True)
    finally:
        _REBUILDING.reset(token)


def _apply_layer(edits: list, tolerant: bool = False) -> None:
    import ontology_actions

    objs = [e for e in edits if e.get("kind") != "link"]
    links = [{"op": e["op"], "link_type_id": e["link_type_id"], "source": str(e["source"]), "target": str(e["target"])} for e in edits if e.get("kind") == "link"]
    if objs and not tolerant:
        ontology.apply_edits(objs, source="staged-writes")
    for e in objs if tolerant else []:
        # pending direct writes over layers that changed since: a create of an object that exists modifies it, an edit
        # of an object that is gone is dropped
        try:
            ontology.apply_edits([e], source="staged-writes")
        except HTTPException:
            if e["op"] == "create":
                try:
                    ontology.apply_edits([{**e, "op": "modify"}], source="staged-writes")
                except HTTPException:
                    pass
    if links:
        ontology_actions._apply_links(links)


@router.put("/staged-writes/{sid}")
def staged_sync(sid: str, req: StagedIn) -> dict:
    """Replace this run's staged edits (its layer of the transaction) with its current edits."""
    _, layer = _split(sid)
    with _lock:
        sc = _staged(sid)
        layers = sc.get("layers") or [["", []]]
        at = next((i for i, (name, _) in enumerate(layers) if name == layer), None)
        if at is None:
            raise HTTPException(409, "this nested staged-writes call has ended")
    # calls are synchronous: a layer that syncs again is running, so any call it made (a later layer) has returned
    _rebuild(sid, layers[:at] + [[layer, req.edits]])
    return {"staged": len(req.edits)}


@router.delete("/staged-writes/{sid}")
def staged_end(sid: str) -> dict:
    """End a run's transaction (its edits were returned to the action), or a nested call's layer (its edits were
    returned to the caller, which stages them as its own)."""
    _, layer = _split(sid)
    with _lock:
        sc = _staged(sid)
        if not layer:
            _path(sc["id"]).unlink(missing_ok=True)
            # direct writes no run took (a runtime that does not take them): returned so the run can still add them to
            # its edits; they are gone with the transaction otherwise
            untaken = [e for edits in (sc.get("direct") or {}).values() for e in edits]
            return {"ended": sc["id"], **({"direct": untaken} if untaken else {}), **({"failed": sc["failed"]} if sc.get("failed") else {})}
        names = [x[0] for x in sc.get("layers") or []]
        layers = [x for x in sc.get("layers") or [] if x[0] != layer]
        left = (sc.get("direct") or {}).pop(sid, None)
        if left:
            # direct writes the ended call did not take (a runtime that does not take them): they go to its caller,
            # the layer before it (calls are synchronous, so the layers are the call stack)
            at = names.index(layer) if layer in names else len(names)
            caller = names[at - 1] if at > 0 else ""
            sc.setdefault("direct", {}).setdefault(f"{sc['id']}{_LAYER_SEP}{caller}" if caller else sc["id"], []).extend(left)
            _save(sc)
    _rebuild(sid, layers)
    return {"ended": sid}


@router.post("/staged-writes/{sid}/direct")
def staged_take_direct(sid: str) -> dict:
    """The writes made inside the transaction outside staging since this run last asked — an action applied by a
    function it called, say. The run stages them as its own edits (they join the staged edits, as in Foundry), so its
    next sync keeps them and the action commits them with the rest; they are no longer pending afterwards."""
    with _lock:
        sc = _staged(sid)
        taken = (sc.get("direct") or {}).pop(sid, None) or []
        if taken:
            _save(sc)
    # a call inside the transaction failed (one a called plain query caught, say): the run discards every edit
    return {"edits": taken, **({"failed": sc["failed"]} if sc.get("failed") else {})}


@router.post("/staged-writes/{sid}/direct/add")
def staged_add_direct(sid: str, req: StagedIn) -> dict:
    """Edits a plain query running inside the transaction (with its caller's header, `sid`) got back from a
    staged-write function it called: the query has no staged edits of its own to hold them, so they join the
    transaction as writes made with that header — read from now on, taken by the caller after the call
    (POST …/direct) and committed or discarded with the outer run, as Foundry stages every edit of the execution."""
    with _lock:
        sc = _staged(sid)
        if req.edits:
            sc.setdefault("direct", {}).setdefault(sid if _split(sid)[0] == sc["id"] else sc["id"], []).extend(req.edits)
            _save(sc)
        layers = sc.get("layers") or [["", []]]
    _rebuild(sid, layers)
    return {"added": len(req.edits)}


def staged_failed(sid: Optional[str], error: str) -> None:
    """Record that a call made inside a staged-write transaction failed: like Foundry, the whole set of staged edits
    is discarded, even when a function in between caught the error (the outer run learns it at its next take)."""
    base = staged_base(sid)
    if not base:
        return
    with _lock:
        sc = _read(_path(_resolve(base)))
        if sc and sc.get("staged") and not sc.get("failed"):
            sc["failed"] = str(error or "a call failed")[:1000]
            _save(sc)


def request_sid() -> Optional[str]:
    """The scenario header of the current request as sent (a nested staged-write call's layer kept whole)."""
    return _REQ_SID.get()


async def middleware(request: Any, call_next: Any) -> Any:
    """Requests carrying the staged-writes header read and write inside that transaction (inside auth.middleware,
    so the transaction's owner is checked); the snapshot header pins reads to a function run's snapshot."""
    snap = request.headers.get("x-bluesandai-snapshot")
    # reads only: a write must never start from a frozen copy (it would overwrite newer objects)
    path = request.url.path
    # a query the run calls (functions.Query.execute, a function's execute) shares the run's snapshot ("a single
    # function-backed action, along with any queries within"); it returns edits, it never applies them
    nested = request.method == "POST" and path.startswith("/api/functions/") and path.endswith("/execute")
    if snap and (request.method == "GET" or nested or path.endswith(("/search", "/explorer/search", "/aggregate"))):
        # a function run with consistent snapshots (ontology.stored_objects)
        token = ontology.SNAPSHOT.set(snap[:64])
        try:
            return await _scenario_call(request, call_next)
        finally:
            ontology.SNAPSHOT.reset(token)
    return await _scenario_call(request, call_next)


async def _scenario_call(request: Any, call_next: Any) -> Any:
    sid = request.headers.get(SCENARIO_HEADER)
    if not sid:
        return await call_next(request)
    from fastapi.responses import JSONResponse

    token = _REQ_SID.set(sid)
    try:
        # a nested staged-write call's layer ("<id>~<layer>") reads and writes in its transaction
        with active(_split(sid)[0]):
            return await call_next(request)
    except HTTPException as e:
        return JSONResponse({"detail": e.detail}, status_code=e.status_code)
    finally:
        _REQ_SID.reset(token)


@router.patch("/scenarios/{sid}")
def update_scenario(sid: str, req: ScenarioPatch) -> dict:
    with _lock:
        sc = _owned(sid)
        if sc.get("merged"):
            raise HTTPException(400, "a merged scenario cannot change")
        if req.status and not sc.get("persisted") and not req.persisted:
            raise HTTPException(400, "persist the scenario before it can be reviewed")
        for k in ("name", "description", "persisted", "status"):
            v = getattr(req, k)
            if v is not None:
                sc[k] = v.strip() if isinstance(v, str) and k != "status" else v
        if req.status in ("approved", "rejected"):
            sc["reviewed_by"], sc["reviewed_at"] = _who(), _now()
        return _summary(_save(sc))


@router.delete("/scenarios/{sid}")
def delete_scenario(sid: str) -> dict:
    with _lock:
        sc = _owned(sid)
        _path(sc["id"]).unlink(missing_ok=True)
    return {"deleted": sc["id"]}


@router.get("/scenarios/{sid}")
def get_scenario(sid: str) -> dict:
    """The scenario with every edited object before (main) and after (the scenario)."""
    with _lock:
        sc = _owned(sid)
        conflicts = {(c["object_type_id"], c["primary_key"]): c["reason"] for c in _conflicts(sc)}
        edits = []
        for tid, objs in (sc.get("objects") or {}).items():
            t = _read(ontology._path("object-types", tid))
            if not t:
                continue
            main = ontology.load_objects(tid)
            for pk, e in objs.items():
                before = (main.get(pk) or {}).get("properties")
                after = None if e["op"] == "delete" else {**(before or {}), **e["properties"]}
                title_src = after or before or {}
                edits.append({"object_type_id": tid, "object_type": t["display_name"], "primary_key": pk, "op": e["op"], "at": e["at"],
                              "title": str(title_src.get(t["title_property"]) or pk), "changed": sorted(e["properties"]) if e["op"] == "modify" else [],
                              "before": before, "after": after, "conflict": conflicts.get((tid, pk))})
        links = []
        for lid, rec in (sc.get("links") or {}).items():
            lt = _read(ontology._path("link-types", lid)) or {}
            links += [{"link_type_id": lid, "link_type": lt.get("display_name", lid), "op": op, "source": s, "target": t}
                      for op in ("add", "remove") for s, t in rec.get(op) or []]
    return _summary(sc) | {"edits": sorted(edits, key=lambda e: e["at"], reverse=True), "links": links,
                           "activity": list(reversed(sc.get("activity") or []))[:100], "reviewed_by": sc.get("reviewed_by"),
                           "reviewed_at": sc.get("reviewed_at")}


class DiscardIn(BaseModel):
    object_type_id: Optional[str] = None
    primary_key: Optional[str] = None
    link_type_id: Optional[str] = None
    source: Optional[str] = None
    target: Optional[str] = None


@router.post("/scenarios/{sid}/discard")
def discard_edit(sid: str, req: DiscardIn) -> dict:
    """Drop one object edit (or link edit) from the scenario."""
    with _lock:
        sc = _owned(sid)
        if req.object_type_id:
            objs = (sc.get("objects") or {}).get(req.object_type_id) or {}
            if objs.pop(str(req.primary_key), None) is None:
                raise HTTPException(404, "the scenario has no edit of that object")
            if not objs:
                sc["objects"].pop(req.object_type_id, None)
        elif req.link_type_id:
            rec = (sc.get("links") or {}).get(req.link_type_id) or {}
            pair = [str(req.source), str(req.target)]
            for op in ("add", "remove"):
                if pair in (rec.get(op) or []):
                    rec[op].remove(pair)
            if rec and not rec.get("add") and not rec.get("remove"):
                sc["links"].pop(req.link_type_id, None)
        else:
            raise HTTPException(400, "pick the object or link edit to discard")
        return _summary(_save(_rebase(sc)))


@router.post("/scenarios/{sid}/rebase")
def rebase_now(sid: str) -> dict:
    with _lock:
        return _summary(_save(_rebase(_owned(sid))))


class ApplyIn(BaseModel):
    parameters: dict[str, Any] = {}


@router.post("/scenarios/{sid}/actions/{action_id}/apply")
def apply_in_scenario(sid: str, action_id: str, req: ApplyIn) -> dict:
    """Apply an action to the scenario instead of main."""
    action = ontology._action_type(action_id)
    with active(sid) as sc:
        token = _RUN.set((action["display_name"], uuid.uuid4().hex[:12]))
        try:
            result = ontology.apply_action(action_id, ontology.ApplyAction(parameters=req.parameters))
        finally:
            _RUN.reset(token)
    return {**result, "scenario": _summary(_read(_path(sc["id"])))}


@router.post("/scenarios/{sid}/actions/{action_id}/form")
def form_in_scenario(sid: str, action_id: str, req: dict) -> dict:
    """An action form's state (options, criteria) as seen from the scenario."""
    import ontology_actions

    with active(sid):
        return ontology_actions.action_form(action_id, ontology_actions.FormIn(**(req or {})))


@router.post("/scenarios/{sid}/search")
def search_in_scenario(sid: str, req: dict, request: Request = None) -> dict:  # type: ignore[assignment]
    """Object Explorer search on the scenario's view of the Ontology (for a build: as the build's identity)."""
    import build_calls
    import ontology_explorer

    # the scenario is the build's user's: resolved as them (a scenario belongs to its creator)
    with build_calls.acting_for(request), active(sid):
        return ontology_explorer.search(ontology_explorer.SearchIn(**req), request)


@router.get("/scenarios/{sid}/objects/{type_id}/{pk}")
def object_in_scenario(sid: str, type_id: str, pk: str, request: Request = None) -> dict:  # type: ignore[assignment]
    import build_calls

    with build_calls.acting_for(request), active(sid):
        return ontology.get_object(type_id, pk, request)


class CompareIn(BaseModel):
    scenario_ids: list[str] = Field([], max_length=10)
    include_main: bool = True
    object_type_id: str
    filters: list[dict] = []
    metric: Literal["count", "sum", "avg", "min", "max"] = "count"
    property: Optional[str] = None
    group_by: Optional[str] = None


@router.post("/scenarios/compare")
def compare(req: CompareIn) -> dict:
    """The same aggregation on main and on each scenario, side by side."""
    import ontology_explorer as ox

    spec = ox.SearchIn(object_type_id=req.object_type_id, filters=[ox.Filter(**f) for f in req.filters], limit=1, histograms=False,
                       aggregate=ox.Aggregate(metric=req.metric, property=req.property, group_by=req.group_by), resource="ontology-scenarios")
    columns = []
    if req.include_main:
        with _lock:
            r = ox.run_search(spec)
        columns.append({"scenario_id": None, "name": "Main", "total": len(r["rows"]), "aggregation": ox._aggregate(r["type"], r["rows"], spec.aggregate)})
    for ref in req.scenario_ids:
        sc = _owned(ref)
        token = ontology.SCENARIO.set(sc["id"])
        try:
            with _lock:
                r = ox.run_search(spec)
                agg = ox._aggregate(r["type"], r["rows"], spec.aggregate)
        finally:
            ontology.SCENARIO.reset(token)
        columns.append({"scenario_id": sc["id"], "name": sc["name"], "total": len(r["rows"]), "aggregation": agg})
    groups = sorted({g["group"] for c in columns for g in c["aggregation"]["groups"]})
    return {"metric": req.metric, "property": req.property, "group_by": req.group_by, "groups": groups,
            "columns": [{**c, "values": {g["group"]: g["value"] for g in c["aggregation"]["groups"]}} for c in columns]}


class MergeActionIn(BaseModel):
    display_name: str = Field("Merge scenario", min_length=1, max_length=200)
    object_type_ids: list[str] = Field(min_length=1)
    link_type_ids: list[str] = []


@router.post("/scenarios/merge-action-type")
def create_merge_action(req: MergeActionIn) -> dict:
    """An action type that merges a scenario: one Scenario parameter and an Apply scenario rule (Ontology Manager's
    Scenario tab in the new action type wizard)."""
    return ontology.create_action_type(ontology.ActionTypeIn(
        display_name=req.display_name, object_type_id=req.object_type_ids[0], kind="rules",
        description="Applies a scenario's edits to the Ontology as one transaction.",
        parameters=[ontology.Parameter(id="scenario", display_name="Scenario", type="string", required=True, type_classes=["scenario:reference"])],
        rules=[{"kind": "apply_scenario", "scenario_param": "scenario", "object_type_ids": req.object_type_ids, "link_type_ids": req.link_type_ids}],
        type_classes=["scenario:merge"]))


class MergeIn(BaseModel):
    action_type_id: str


@router.post("/scenarios/{sid}/merge")
def merge(sid: str, req: MergeIn) -> dict:
    """Merge with an action type that has an Apply scenario rule (its permissions and criteria apply)."""
    sc = _owned(sid)
    action = ontology._action_type(req.action_type_id)
    rule = next((r for r in action.get("rules") or [] if r.get("kind") == "apply_scenario"), None)
    if not rule:
        raise HTTPException(400, f"{action['display_name']} has no Apply scenario rule")
    result = ontology.apply_action(action["id"], ontology.ApplyAction(parameters={rule["scenario_param"]: sc["rid"]}))
    return {**result, "scenario": _summary(_read(_path(sc["id"])))}


# ------------------------------------------------------------------------------------------------
# duplicating and saving (Workshop scenarios [Legacy])
# ------------------------------------------------------------------------------------------------


class DuplicateIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    persisted: bool = False


@router.post("/scenarios/{sid}/duplicate")
def duplicate_scenario(sid: str, req: Optional[DuplicateIn] = None) -> dict:
    """A new scenario holding a copy of another's edits and applied actions, named "<name> (copy)" (the new one is
    the caller's, temporary unless persisted; the original is unchanged)."""
    import copy

    req = req or DuplicateIn()
    with _lock:
        src = _owned(sid)
        if src.get("staged"):
            raise HTTPException(400, "a function run's transaction cannot be duplicated")
        if src.get("merged"):
            raise HTTPException(400, f"{src['name']} was merged: its edits are on main now")
        name = (req.name or "").strip() or f"{src['name']} (copy)"
        new = create_scenario(ScenarioIn(name=name[:200], description=src.get("description") or "", persisted=req.persisted))
        sc = _read(_path(new["id"]))
        sc["objects"] = copy.deepcopy(src.get("objects") or {})
        sc["links"] = copy.deepcopy(src.get("links") or {})
        sc["activity"] = copy.deepcopy(src.get("activity") or [])
        sc["duplicated_from"] = {"id": src["id"], "name": src["name"], "at": _now()}
        return _summary(_save(_rebase(sc))) | {"duplicated_from": sc["duplicated_from"]}


def _content_sig(sc: dict) -> str:
    """What a save keeps: the name, description and edits (a later change makes a saved scenario "updated")."""
    import hashlib
    import json

    body = json.dumps([sc.get("name"), sc.get("description"), sc.get("objects") or {}, sc.get("links") or {}], sort_keys=True, default=str)
    return hashlib.sha1(body.encode("utf-8")).hexdigest()


def save_state(sc: dict) -> dict:
    """new (never saved), saved, or updated (changed since it was saved), with the object that stores it."""
    saved = sc.get("saved")
    if not saved:
        return {"state": "new", "saved": None}
    return {"state": "saved" if saved.get("sig") == _content_sig(sc) else "updated", "saved": {k: v for k, v in saved.items() if k != "sig"}}


def saved_state(ref: Any) -> dict:
    return save_state(_owned(ref))


def mark_saved(ref: Any, object_type_id: Optional[str], primary_key: Optional[str], name: Optional[str] = None) -> dict:
    """Persist a scenario and remember the scenario object that stores it, if any (Workshop's Save scenario)."""
    with _lock:
        sc = _owned(ref)
        if sc.get("merged"):
            raise HTTPException(400, "a merged scenario cannot change")
        sc["persisted"] = True
        if name and name.strip():
            sc["name"] = name.strip()[:200]
        sc["saved"] = {"at": _now(), "by": _who(), "object_type_id": object_type_id, "primary_key": primary_key, "sig": _content_sig(sc)}
        return _summary(_save(sc)) | save_state(sc)
