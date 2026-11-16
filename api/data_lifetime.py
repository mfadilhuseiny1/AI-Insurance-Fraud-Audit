"""Data Lifetime (Security & Governance → Data Lifetime): lineage-aware deletion policies for datasets.

A policy is one of
  fixed        every transaction of a root dataset is deleted on a date (optionally only transactions committed before
               a cutoff date)
  latest_view  transactions not in the dataset's current view are deleted at once (their deletion date is the newest
               transaction's creation); the current view is kept
and is applied to root (or other upstream) datasets. Deletion dates flow down the lineage (Data Lineage's graph):
a downstream transaction gets the earliest deletion date of the upstream transactions it was built from (the
upstream view current when it was built), or none when they have none. An override on a dataset breaks that
inheritance for it and everything downstream: with a superseding policy it is evaluated as a root of that policy,
without one its transactions get no deletion date.

The executor (every INTERVAL seconds, at most BATCH transactions a run) deletes due transactions: the stored copy of
the transaction is removed and the transaction is marked deleted; when the current view itself is due, the dataset is
replaced by an empty table with the same columns (a transaction recorded as "data_lifetime"). Deletions are logged
(Deletions tab, filter by transaction or time) and written to audit.3 as dataDelete.

Permissions (the reference's matrix): data governance officers (administrators) create, update and delete policies
and set overrides; a dataset's Editors (and administrators) apply policies to it or remove them; every signed-in user
sees policies and a dataset's policies when they can view it. Applying and removing policies is the Checkpoints type
"Retention policy application". Retention policies (dataset_retention.py) are separate and not lineage-aware; Data
Lifetime does not take them into account when showing deletion dates.

Mounted by server.py under /api/data-lifetime.
"""

from __future__ import annotations

import io
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import audit3
import auth

log = logging.getLogger("bluesandai.data_lifetime")
router = APIRouter(prefix="/api/data-lifetime", tags=["data-lifetime"])
DIR = Path("data/data_lifetime")
INTERVAL = int(os.environ.get("BLUESANDAI_DATA_LIFETIME_INTERVAL", "600"))
BATCH = 200
_lock = threading.RLock()
_started = False


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "data_lifetime"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _policies() -> list[dict]:
    return audit3._read(DIR / "policies.json", [])


def _save_policies(rows: list[dict]) -> None:
    audit3._write(DIR / "policies.json", rows)


def _apps() -> dict:
    """dataset item id -> {"policy": id | None, "override": bool, "at", "by"}"""
    return audit3._read(DIR / "applications.json", {})


def _save_apps(a: dict) -> None:
    audit3._write(DIR / "applications.json", a)


def _policy(pid: str) -> dict:
    p = next((x for x in _policies() if x["id"] == pid), None)
    if not p:
        raise HTTPException(404, "policy not found")
    return p


def _history(pid: str, action: str, dataset: Optional[str] = None, detail: str = "") -> None:
    rows = _policies()
    p = next((x for x in rows if x["id"] == pid), None)
    if p is None:
        return
    p.setdefault("history", []).insert(0, {"at": _now(), "by": (auth.current() or {}).get("username") or "system", "action": action, "dataset": dataset,
                                          "detail": detail})
    p["history"] = p["history"][:500]
    _save_policies(rows)


# ------------------------------------------------------------------------------------------------
# computing deletion dates
# ------------------------------------------------------------------------------------------------


# the last lineage walk: building the whole lineage graph takes from seconds to minutes, so the pages reuse it briefly
_parents_cache: tuple[float, dict[str, set[str]]] = (0.0, {})
PARENTS_MAX_AGE = 120.0


def _parents(max_age: float = 0.0) -> dict[str, set[str]]:
    """dataset item id -> the datasets it is built from (through pipelines, transforms, syncs… in Data Lineage).
    max_age > 0: a walk at most that many seconds old is reused (pages); deletions always walk afresh."""
    global _parents_cache
    if max_age > 0 and time.time() - _parents_cache[0] < max_age:
        return _parents_cache[1]
    import lineage

    g = lineage.build_graph()
    out_edges: dict[str, list[str]] = {}
    for (a, b) in g.edges:
        out_edges.setdefault(a, []).append(b)
    parents: dict[str, set[str]] = {}
    for nid in g.nodes:
        if not nid.startswith("dataset:"):
            continue
        # walk through non-dataset nodes to the next datasets
        seen, stack = set(), list(out_edges.get(nid, []))
        while stack:
            n = stack.pop()
            if n in seen:
                continue
            seen.add(n)
            if n.startswith("dataset:"):
                parents.setdefault(n[8:], set()).add(nid[8:])
            else:
                stack.extend(out_edges.get(n, []))
    _parents_cache = (time.time(), parents)
    return parents


def _txs(item_id: str) -> list[dict]:
    """A dataset's committed transactions, oldest first."""
    import dataset_versions

    return [t for t in reversed(dataset_versions.history(item_id)) if t.get("kind") != "aborted"]


def _root_dates(policy: dict, txs: list[dict], branch: str = "master") -> dict[str, Optional[str]]:
    """Deletion dates of a policy's dataset (or a branch copy of it): fixed dates apply on every branch; keep latest
    view only keeps the current view on the policy's branches, and deletes everything on other branches at once
    (the deletion date is each transaction's creation)."""
    if policy["type"] == "fixed":
        cut = policy.get("cutoff_date")
        return {t["id"]: (policy["deletion_date"] if not cut or t["at"] < cut else None) for t in txs}
    if not txs:
        return {}
    if branch not in (policy.get("branches") or ["master"]):
        return {t["id"]: t["at"] for t in txs}
    newest = txs[-1]
    return {t["id"]: (None if t["id"] == newest["id"] else newest["at"]) for t in txs}


class Plan:
    """Deletion dates of every transaction of every dataset under a policy (directly or through lineage)."""

    def __init__(self, max_age: float = 0.0) -> None:
        self.policies = {p["id"]: p for p in _policies()}
        self.apps = _apps()
        self.parents = _parents(max_age) if self.apps else {}
        self.children: dict[str, set[str]] = {}
        for c, ps in self.parents.items():
            for p in ps:
                self.children.setdefault(p, set()).add(c)
        self.memo: dict[str, dict[str, dict]] = {}
        self.visiting: set[str] = set()
        # branch copies of datasets with a policy: copy id -> (master id, branch)
        self.branch_apps: dict[str, tuple[str, str]] = {}
        if self.apps:
            import dataset_preview
            import db

            for mid in list(self.apps):
                item = db.drive_get(mid) if db.enabled() else None
                if not item:
                    continue
                try:
                    for b in dataset_preview.branches(item):
                        if b["branch"] != "master" and b["item_id"] != mid:
                            self.branch_apps[b["item_id"]] = (mid, b["branch"])
                except Exception:  # noqa: BLE001
                    pass

    def governed(self) -> set[str]:
        """Datasets with an application (and their branch copies), and everything downstream of them."""
        out: set[str] = set()
        stack = list(self.apps) + list(self.branch_apps)
        while stack:
            d = stack.pop()
            if d in out:
                continue
            out.add(d)
            stack.extend(self.children.get(d, ()))
        return out

    def dates(self, item_id: str) -> dict[str, dict]:
        """tx id -> {"date": iso | None, "policy": id | None, "source": dataset item id (where the date comes from)}"""
        if item_id in self.memo:
            return self.memo[item_id]
        if item_id in self.visiting:
            return {}
        self.visiting.add(item_id)
        try:
            txs = _txs(item_id)
            app = self.apps.get(item_id)
            branch = "master"
            if not app and item_id in self.branch_apps:
                mid, branch = self.branch_apps[item_id]
                app = self.apps.get(mid)
            out: dict[str, dict] = {}
            if app:
                pol = self.policies.get(app.get("policy") or "")
                if pol:
                    for tid, d in _root_dates(pol, txs, branch).items():
                        out[tid] = {"date": d, "policy": pol["id"], "source": item_id, **({"branch": branch} if branch != "master" else {})}
                else:
                    out = {t["id"]: {"date": None, "policy": None, "source": item_id, "override": True} for t in txs}
            else:
                parents = [p for p in self.parents.get(item_id, ()) if p in self.governed_set]
                for t in txs:
                    best: Optional[dict] = None
                    read = (t.get("source") or {}).get("input_transactions") or {}
                    for p in parents:
                        # the upstream transaction this one was built from (recorded at build time), else the upstream
                        # view current when it was built
                        if read.get(p):
                            ptx_id = read[p]
                        else:
                            ptx = [x for x in _txs(p) if x["at"] <= t["at"]]
                            if not ptx:
                                continue
                            ptx_id = ptx[-1]["id"]
                        d = self.dates(p).get(ptx_id) or {}
                        if d.get("date") and (best is None or d["date"] < best["date"]):
                            best = {"date": d["date"], "policy": d.get("policy"), "source": d.get("source"), "inherited_from": p}
                    out[t["id"]] = best or {"date": None, "policy": None, "source": None}
            self.memo[item_id] = out
            return out
        finally:
            self.visiting.discard(item_id)

    def all(self) -> dict[str, dict[str, dict]]:
        self.governed_set = self.governed()
        return {d: self.dates(d) for d in self.governed_set}


def plan() -> dict[str, dict[str, dict]]:
    return Plan().all()


# ------------------------------------------------------------------------------------------------
# deleting
# ------------------------------------------------------------------------------------------------


def _log_deletion(rec: dict) -> None:
    with _lock, (DIR / "deletions.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def _deletions() -> list[dict]:
    p = DIR / "deletions.jsonl"
    if not p.exists():
        return []
    return [json.loads(x) for x in p.read_text("utf-8").splitlines() if x.strip()]


def _empty_like(item: dict) -> bytes:
    import drive
    import pyarrow as pa
    import pyarrow.parquet as pq

    try:
        schema = pq.read_schema(io.BytesIO(drive.read_bytes(item)))
    except Exception:  # noqa: BLE001
        schema = pa.schema([])
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_batches([], schema=schema), buf)
    return buf.getvalue()


def execute(now: Optional[str] = None, dry_run: bool = False) -> dict:
    """Delete due transactions (BATCH at most); dry_run lists what would be deleted."""
    import dataset_versions
    import db
    import pipeline_datasets

    now = now or _now()
    p = plan()
    due = []
    for item_id, txs in p.items():
        hist = {t["id"]: t for t in dataset_versions.history(item_id)}
        for tid, d in txs.items():
            t = hist.get(tid)
            if not t or not d.get("date") or d["date"] > now or t.get("lifetime_deleted") or (t.get("source") or {}).get("kind") == "data_lifetime":
                continue
            due.append((item_id, t, d))
    due.sort(key=lambda x: x[2]["date"])
    if dry_run:
        return {"due": [{"dataset": i, "transaction": t["id"], "at": t["at"], **d} for i, t, d in due]}
    done = []
    for item_id, t, d in due[:BATCH]:
        try:
            with dataset_versions._lock:
                txs = dataset_versions.history(item_id, aborted=True)
                cur = txs[0] if txs else None
                for x in txs:
                    if x["id"] == t["id"]:
                        (dataset_versions._folder(item_id) / f"{x['id']}.parquet").unlink(missing_ok=True)
                        x.update(kept=False, lifetime_deleted=_now(), lifetime_policy=d.get("policy"))
                dataset_versions._save(item_id, txs)
            emptied = False
            if cur and cur["id"] == t["id"]:
                item = db.drive_get(item_id)
                if item and not item.get("trashed_at"):
                    data = _empty_like(item)
                    pipeline_datasets._replace_content(item, data)
                    if item.get("stored_in") == "s3":
                        # the deleted view must not survive as an older version of the object
                        import storage

                        try:
                            storage.purge_versions(f"drive/{item_id}")
                        except Exception:  # noqa: BLE001
                            log.exception("purging S3 versions of %s", item_id)
                    dataset_versions.record(item_id, data, "build", {"kind": "data_lifetime", "transaction": "SNAPSHOT", "policy": d.get("policy"),
                                                                     "deleted": t["id"]})
                    emptied = True
            rec = {"at": _now(), "dataset": item_id, "transaction": t["id"], "transaction_at": t["at"], "deletion_date": d["date"], "policy": d.get("policy"),
                   "source": d.get("source"), "inherited_from": d.get("inherited_from"), "emptied_current_view": emptied}
            _log_deletion(rec)
            done.append(rec)
            audit3.emit("DATA_LIFETIME_DELETE_TRANSACTION", ["dataDelete"], {"deletedResources": [{"type": "dataset", "id": item_id}, {"type": "transaction", "id": t["id"]}]},
                        {"policy": d.get("policy")}, product="data-lifetime")
        except Exception:  # noqa: BLE001
            log.exception("deleting %s/%s", item_id, t["id"])
    return {"deleted": done, "remaining": max(0, len(due) - BATCH)}


def _loop() -> None:
    while True:
        time.sleep(INTERVAL)
        try:
            if _apps():
                execute()
        except Exception:  # noqa: BLE001
            log.exception("data lifetime run")


def startup() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="data-lifetime", daemon=True).start()


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


def _dgo() -> dict:
    p = auth.require_user()
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "Only data governance officers (administrators) create, change and delete Data Lifetime policies and set overrides")
    return p


def _dataset_editor(item_id: str) -> dict:
    import drive

    p = auth.require_user()
    item = drive._item(item_id, need="editor") if not (not auth.enabled() or p.get("role") == "admin") else drive._item(item_id)
    if item["kind"] != "file":
        raise HTTPException(400, "Data Lifetime policies apply to datasets")
    return item


class PolicyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    type: Literal["fixed", "latest_view"]
    deletion_date: Optional[str] = None
    cutoff_date: Optional[str] = None
    branches: list[str] = Field(default_factory=lambda: ["master"])


def _check_policy(req: PolicyIn) -> None:
    if req.type == "fixed" and not req.deletion_date:
        raise HTTPException(400, "a fixed deletion date policy needs a deletion date")
    for v in (req.deletion_date, req.cutoff_date):
        if v:
            try:
                datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(400, f"not a date: {v}") from None


def _norm(v: Optional[str]) -> Optional[str]:
    if not v:
        return None
    t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds")


@router.get("/policies")
def list_policies() -> list[dict]:
    auth.require_user()
    apps = _apps()
    return [{**{k: v for k, v in p.items() if k != "history"}, "datasets": sorted(d for d, a in apps.items() if a.get("policy") == p["id"] and not a.get("override")),
             "overrides": sorted(d for d, a in apps.items() if a.get("policy") == p["id"] and a.get("override"))} for p in _policies()]


@router.post("/policies")
def create_policy(req: PolicyIn) -> dict:
    p = _dgo()
    _check_policy(req)
    pol = {"id": uuid.uuid4().hex[:12], **req.model_dump(), "deletion_date": _norm(req.deletion_date), "cutoff_date": _norm(req.cutoff_date),
           "created_by": p.get("username"), "created_at": _now(), "history": []}
    with _lock:
        _save_policies([*_policies(), pol])
    _history(pol["id"], "created", detail=f"{req.type}{' on ' + pol['deletion_date'] if pol['deletion_date'] else ''}")
    audit3.emit("DATA_LIFETIME_CREATE_POLICY", ["appConfigCreate"], {"createAppConfigDescription": f"deletion policy {req.name}"}, {"createdAppConfigIds": [pol["id"]]},
                product="data-lifetime")
    return pol


@router.put("/policies/{pid}")
def update_policy(pid: str, req: PolicyIn) -> dict:
    _dgo()
    _check_policy(req)
    with _lock:
        rows = _policies()
        pol = next((x for x in rows if x["id"] == pid), None)
        if not pol:
            raise HTTPException(404, "policy not found")
        pol.update(req.model_dump(), deletion_date=_norm(req.deletion_date), cutoff_date=_norm(req.cutoff_date), updated_at=_now())
        _save_policies(rows)
    _history(pid, "updated", detail=f"{req.type}{' on ' + str(pol['deletion_date']) if pol['deletion_date'] else ''}")
    return pol


@router.delete("/policies/{pid}")
def delete_policy(pid: str) -> dict:
    _dgo()
    with _lock:
        apps = _apps()
        if any(a.get("policy") == pid for a in apps.values()):
            raise HTTPException(409, "remove the policy from its datasets (and overrides) first")
        _save_policies([x for x in _policies() if x["id"] != pid])
    return {"deleted": pid}


@router.get("/policies/{pid}")
def get_policy(pid: str) -> dict:
    auth.require_user()
    pol = _policy(pid)
    apps = _apps()
    import db

    def named(i: str) -> dict:
        it = db.drive_get(i)
        return {"id": i, "name": it["name"] if it else "(deleted dataset)", "visible": bool(it) and auth.can_access(i)}

    pl = Plan(PARENTS_MAX_AGE)
    all_dates = pl.all()
    downstream = sorted({d for d, txs in all_dates.items() if any(x.get("policy") == pid and x.get("source") != d for x in txs.values())})
    return {**pol, "datasets": [named(d) for d, a in apps.items() if a.get("policy") == pid and not a.get("override")],
            "overrides": [named(d) for d, a in apps.items() if a.get("policy") == pid and a.get("override")],
            "downstream": [named(d) for d in downstream]}


class ApplyIn(BaseModel):
    dataset_id: str


@router.post("/policies/{pid}/apply")
def apply_policy(pid: str, req: ApplyIn) -> dict:
    """Apply a policy to a (root) dataset: its transactions and everything built from them get deletion dates."""
    _policy(pid)
    item = _dataset_editor(req.dataset_id)
    with _lock:
        apps = _apps()
        cur = apps.get(item["id"])
        if cur and cur.get("override"):
            raise HTTPException(409, "the dataset has a policy override: change it in the dataset's Lineage-aware retention policies")
        apps[item["id"]] = {"policy": pid, "override": False, "at": _now(), "by": (auth.current() or {}).get("username")}
        _save_apps(apps)
    _history(pid, "applied", item["id"], item["name"])
    if cur and cur.get("policy") and cur["policy"] != pid:
        _history(cur["policy"], "removed", item["id"], f"{item['name']} (replaced)")
    audit3.emit("DATA_LIFETIME_APPLY_POLICY", ["metaDataUpdate"], {"updatedMetaDataResources": [{"type": "dataset", "id": item["id"]}],
                                                                   "updatedMetaDataDescription": f"deletion policy {pid} applied"}, product="data-lifetime")
    return dataset_view(item["id"])


@router.delete("/policies/{pid}/datasets/{item_id}")
def remove_policy(pid: str, item_id: str) -> dict:
    item = _dataset_editor(item_id)
    with _lock:
        apps = _apps()
        cur = apps.get(item_id)
        if not cur or cur.get("policy") != pid or cur.get("override"):
            raise HTTPException(404, "the policy is not applied to this dataset")
        apps.pop(item_id)
        _save_apps(apps)
    _history(pid, "removed", item_id, item["name"])
    audit3.emit("DATA_LIFETIME_REMOVE_POLICY", ["metaDataUpdate"], {"updatedMetaDataResources": [{"type": "dataset", "id": item_id}],
                                                                    "updatedMetaDataDescription": f"deletion policy {pid} removed"}, product="data-lifetime")
    return dataset_view(item_id)


class OverrideIn(BaseModel):
    policy_id: Optional[str] = None  # None: override without a superseding policy


@router.put("/datasets/{item_id}/override")
def set_override(item_id: str, req: OverrideIn) -> dict:
    """Break the inheritance of deletion dates for the dataset and everything downstream (data governance officers)."""
    _dgo()
    import drive

    item = drive._item(item_id)
    if req.policy_id:
        _policy(req.policy_id)
    with _lock:
        apps = _apps()
        prev = apps.get(item_id)
        apps[item_id] = {"policy": req.policy_id, "override": True, "at": _now(), "by": (auth.current() or {}).get("username")}
        _save_apps(apps)
    if req.policy_id:
        _history(req.policy_id, "override", item_id, item["name"])
    if prev and prev.get("policy") and prev["policy"] != req.policy_id:
        _history(prev["policy"], "removed", item_id, f"{item['name']} (overridden)")
    audit3.emit("DATA_LIFETIME_SET_OVERRIDE", ["metaDataUpdate"], {"updatedMetaDataResources": [{"type": "dataset", "id": item_id}],
                                                                   "updatedMetaDataDescription": f"override: {req.policy_id or 'no superseding policy'}"}, product="data-lifetime")
    return dataset_view(item_id)


@router.delete("/datasets/{item_id}/override")
def remove_override(item_id: str) -> dict:
    _dgo()
    with _lock:
        apps = _apps()
        cur = apps.get(item_id)
        if not cur or not cur.get("override"):
            raise HTTPException(404, "no override on this dataset")
        apps.pop(item_id)
        _save_apps(apps)
    if cur.get("policy"):
        _history(cur["policy"], "removed", item_id, "override removed")
    return dataset_view(item_id)


@router.get("/datasets/{item_id}")
def dataset_view(item_id: str) -> dict:
    """A dataset's lineage-aware retention: the policy applied to it (or the override), and each transaction's deletion
    date with where it comes from."""
    import drive

    auth.require_user()
    drive._item(item_id)
    pl = Plan(PARENTS_MAX_AGE)
    pl.governed_set = pl.governed()
    dates = pl.dates(item_id) if item_id in pl.governed_set else {}
    app = pl.apps.get(item_id)
    pols = {p["id"]: p["name"] for p in pl.policies.values()}
    import dataset_versions

    txs = []
    for t in dataset_versions.history(item_id):
        d = dates.get(t["id"]) or {}
        txs.append({"id": t["id"], "at": t["at"], "kind": t.get("kind"), "rows": t.get("rows"), "deletion_date": d.get("date"), "policy": d.get("policy"),
                    "policy_name": pols.get(d.get("policy") or ""), "inherited_from": d.get("inherited_from"), "deleted_at": t.get("lifetime_deleted")})
    return {"dataset_id": item_id, "application": {**app, "policy_name": pols.get(app.get("policy") or "")} if app else None, "transactions": txs,
            "inherited": sorted({x["inherited_from"] for x in txs if x.get("inherited_from")})}


@router.get("/deletions")
def deletions(policy: Optional[str] = None, transaction: Optional[str] = None, start: Optional[str] = None, end: Optional[str] = None, scheduled: bool = True) -> dict:
    """Transactions deleted, and (scheduled=true) those marked for deletion, newest first."""
    auth.require_user()
    import db

    names: dict[str, str] = {}

    def name(i: str) -> str:
        if i not in names:
            it = db.drive_get(i)
            names[i] = it["name"] if it else "(deleted dataset)"
        return names[i]

    done = [d for d in _deletions() if auth.can_access(d["dataset"])]
    rows = [{**d, "status": "deleted", "dataset_name": name(d["dataset"])} for d in done]
    if scheduled:
        import dataset_versions

        deleted_ids = {d["transaction"] for d in done}
        for item_id, txs in plan().items():
            if not auth.can_access(item_id):
                continue
            hist = {t["id"]: t for t in dataset_versions.history(item_id)}
            for tid, d in txs.items():
                t = hist.get(tid)
                if t and d.get("date") and tid not in deleted_ids and not t.get("lifetime_deleted") and (t.get("source") or {}).get("kind") != "data_lifetime":
                    rows.append({"dataset": item_id, "dataset_name": name(item_id), "transaction": tid, "transaction_at": t["at"], "deletion_date": d["date"],
                                 "policy": d.get("policy"), "inherited_from": d.get("inherited_from"), "status": "scheduled"})
    if policy:
        rows = [r for r in rows if r.get("policy") == policy]
    if transaction:
        rows = [r for r in rows if transaction in (r["transaction"], f"ri.foundry.main.transaction.{r['transaction']}")]
    if start:
        rows = [r for r in rows if (r.get("at") or r["deletion_date"]) >= start]
    if end:
        rows = [r for r in rows if (r.get("at") or r["deletion_date"]) <= end]
    rows.sort(key=lambda r: r.get("at") or r["deletion_date"], reverse=True)
    return {"total": len(rows), "rows": rows[:2000]}


class RunIn(BaseModel):
    dry_run: bool = True


@router.post("/run")
def run_now(req: RunIn) -> dict:
    _dgo()
    return execute(dry_run=req.dry_run)
