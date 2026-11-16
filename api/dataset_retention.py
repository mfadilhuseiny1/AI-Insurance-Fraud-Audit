"""Retention policies for dataset transactions, like Foundry Retention.

Every dataset keeps a copy of each transaction it wrote (dataset_versions.py). A retention policy decides which
of those copies are deleted, so history does not grow without bounds:

  keep_last      keep the data of the newest N transactions (None = no limit by count)
  max_age_days   delete the data of transactions older than X days (None = no limit by age)
  purge_history  also drop deleted transactions from the history list (otherwise they stay, marked deleted)
  abort_empty    writes with 0 rows are aborted instead of committed (see dataset_versions.abort_if_empty)

The current transaction (the newest one, whose data is the dataset's view) is never deleted. Each dataset
uses its own policy or, without one, the default policy (keep_last = dataset_versions.KEEP, which matches the
behaviour before policies existed). Policies run after every new transaction (dataset_versions.record) and
every INTERVAL seconds in a background thread (startup()); a dry run shows what a run would delete.

Settings: data/lineage/retention.json {"default": {...}, "datasets": {item id: {...}}, "stats": {item id: {...}}}.
API (mounted under /api/pipeline by pipeline_datasets.py):
  GET  /datasets/{id}/retention          policy (own or inherited), default, stats, transaction summary
  PUT  /datasets/{id}/retention          set the dataset's policy ({"inherit": true} removes it)
  POST /datasets/{id}/retention/apply    {"dry_run": bool} -> what is (or would be) deleted
  GET/PUT /retention/default             the default policy
  POST /retention/apply                  {"dry_run": bool} -> every dataset
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import dataset_versions

log = logging.getLogger(__name__)
router = APIRouter()

INTERVAL = 3600  # seconds between background runs (env BLUESANDAI_RETENTION_INTERVAL)
_lock = threading.Lock()
_started = False


class Policy(BaseModel):
    keep_last: Optional[int] = Field(None, ge=1, le=100_000)
    max_age_days: Optional[float] = Field(None, gt=0, le=36_500)
    purge_history: bool = False
    abort_empty: bool = False


def _default_policy() -> dict:
    return Policy(keep_last=dataset_versions.KEEP).model_dump()


def _path() -> Path:
    return dataset_versions.DIR.parent / "retention.json"


def _load() -> dict:
    try:
        s = json.loads(_path().read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        s = {}
    s.setdefault("default", _default_policy())
    s.setdefault("datasets", {})
    s.setdefault("stats", {})
    return s


def _store(s: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(p)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def policy_for(item_id: Optional[str]) -> dict:
    """The policy that applies to a dataset: its own, else the default."""
    s = _load()
    own = s["datasets"].get(item_id or "")
    return {**_default_policy(), **(own if own is not None else s["default"])}


def note_aborted(item_id: Optional[str], source: dict[str, Any]) -> None:
    """Count an aborted (empty) write in the dataset's stats."""
    with _lock:
        s = _load()
        st = s["stats"].setdefault(item_id or "_new", {})
        st["aborted"] = st.get("aborted", 0) + 1
        st["last_aborted"] = {"at": _now().isoformat(timespec="seconds"), "source": source}
        _store(s)


def _age_days(tx: dict, now: datetime) -> Optional[float]:
    try:
        at = datetime.fromisoformat(tx["at"])
    except (KeyError, TypeError, ValueError):
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return (now - at) / timedelta(days=1)


def plan(txs: list[dict], policy: dict, now: Optional[datetime] = None) -> tuple[list[dict], list[dict]]:
    """(transactions whose data is deleted, transactions dropped from the history) under `policy`.
    txs are newest first; the first one is current and always kept."""
    now = now or _now()
    keep_last, max_age = policy.get("keep_last"), policy.get("max_age_days")
    delete, purge = [], []
    for i, t in enumerate(txs):
        if i == 0:
            continue
        expired = (keep_last is not None and i >= keep_last) or (
            max_age is not None and (_age_days(t, now) or 0) > max_age)
        if t.get("kept") and expired:
            delete.append(t)
        if policy.get("purge_history") and (not t.get("kept") or expired):
            purge.append(t)
    return delete, purge


def _summary(t: dict) -> dict:
    return {k: t.get(k) for k in ("id", "at", "kind", "rows", "size", "kept", "rolled_back")}


def apply(item_id: str, dry_run: bool = False, policy: Optional[dict] = None) -> dict:
    """Apply the dataset's retention policy (or `policy`, for previews). Returns what was (or would be)
    deleted. Never deletes the current transaction."""
    policy = {**_default_policy(), **(policy or policy_for(item_id))}
    with dataset_versions._lock:
        every = dataset_versions.history(item_id, aborted=True)
        txs = [t for t in every if not t.get("aborted")]
        delete, purge = plan(txs, policy)
        if not dry_run and (delete or purge):
            folder = dataset_versions._folder(item_id)
            at = _now().isoformat(timespec="seconds")
            for t in delete:
                (folder / f"{t['id']}.parquet").unlink(missing_ok=True)
                t["kept"] = False
                t["deleted"] = {"at": at, "by": "retention"}
            gone = {t["id"] for t in purge}
            dataset_versions._save(item_id, [t for t in every if t["id"] not in gone])
    result = {
        "item_id": item_id, "dry_run": dry_run, "policy": policy,
        "deleted": [_summary(t) for t in delete], "purged": [_summary(t) for t in purge],
        "freed_bytes": sum(t.get("size") or 0 for t in delete),
        "transactions": len(txs),
        "kept_after": sum(1 for t in txs if t.get("kept")) - (len(delete) if dry_run else 0),
    }
    if not dry_run and (delete or purge):
        with _lock:
            s = _load()
            st = s["stats"].setdefault(item_id, {})
            st["deleted"] = st.get("deleted", 0) + len(delete)
            st["freed_bytes"] = st.get("freed_bytes", 0) + result["freed_bytes"]
            st["last_run"] = _now().isoformat(timespec="seconds")
            _store(s)
    return result


def datasets() -> list[str]:
    d = dataset_versions.DIR
    return sorted(p.name for p in d.iterdir() if p.is_dir() and p.name.isalnum()) if d.exists() else []


def apply_all(dry_run: bool = False) -> dict:
    results = []
    for item_id in datasets():
        try:
            r = apply(item_id, dry_run)
        except Exception:  # noqa: BLE001
            log.exception("retention failed for %s", item_id)
            continue
        if r["deleted"] or r["purged"]:
            results.append(r)
    return {"dry_run": dry_run, "datasets": results, "freed_bytes": sum(r["freed_bytes"] for r in results),
            "deleted": sum(len(r["deleted"]) for r in results)}


def _loop(interval: float) -> None:
    while True:
        time.sleep(interval)
        try:
            apply_all()
        except Exception:  # noqa: BLE001
            log.exception("retention run failed")
        try:
            import dataset_projections
            dataset_projections.refresh_all()
        except Exception:  # noqa: BLE001
            log.exception("projection refresh failed")


def startup() -> None:
    """Apply every policy once now and then every INTERVAL seconds; also rebuilds stale projections.
    Call once from the server's startup (after dataset_versions.configure)."""
    global _started
    if _started:
        return
    _started = True
    try:
        interval = max(60.0, float(os.environ.get("BLUESANDAI_RETENTION_INTERVAL") or INTERVAL))
    except ValueError:
        interval = INTERVAL

    def first() -> None:
        try:
            apply_all()
            import dataset_projections
            dataset_projections.refresh_all()
        except Exception:  # noqa: BLE001
            log.exception("retention run failed")
        _loop(interval)

    threading.Thread(target=first, name="dataset-retention", daemon=True).start()


# ---------------------------------------------------------------- API

def _check(item_id: str, need: str = "viewer") -> None:
    """A dataset id the caller may see (markings, Project Viewer), or change the retention of (Editor)."""
    if not item_id.isalnum():
        raise HTTPException(400, "bad dataset id")
    import auth

    auth.check_item_id(item_id, need)


def _view(item_id: str) -> dict:
    s = _load()
    own = s["datasets"].get(item_id)
    txs = dataset_versions.history(item_id)
    return {
        "item_id": item_id, "inherit": own is None, "policy": policy_for(item_id), "default": {**_default_policy(), **s["default"]},
        "stats": s["stats"].get(item_id, {}),
        "transactions": {"total": len(txs), "kept": sum(1 for t in txs if t.get("kept")),
                         "kept_bytes": sum(t.get("size") or 0 for t in txs if t.get("kept")),
                         "current": _summary(txs[0]) if txs else None},
    }


class PolicyChange(Policy):
    inherit: bool = False


class ApplyRequest(BaseModel):
    dry_run: bool = True
    policy: Optional[Policy] = None  # preview an unsaved policy (dry runs only)


@router.get("/datasets/{item_id}/retention")
def get_policy(item_id: str) -> dict:
    _check(item_id)
    return _view(item_id)


@router.put("/datasets/{item_id}/retention")
def put_policy(item_id: str, req: PolicyChange) -> dict:
    _check(item_id, "editor")
    with _lock:
        s = _load()
        if req.inherit:
            s["datasets"].pop(item_id, None)
        else:
            s["datasets"][item_id] = Policy(**req.model_dump(exclude={"inherit"})).model_dump()
        _store(s)
    return _view(item_id)


@router.post("/datasets/{item_id}/retention/apply")
def post_apply(item_id: str, req: ApplyRequest) -> dict:
    _check(item_id, "viewer" if req.dry_run else "editor")
    if req.policy is not None and not req.dry_run:
        raise HTTPException(400, "save the policy before applying it")
    return apply(item_id, req.dry_run, req.policy.model_dump() if req.policy else None)


@router.get("/retention/default")
def get_default() -> dict:
    return {**_default_policy(), **_load()["default"]}


@router.put("/retention/default")
def put_default(req: Policy) -> dict:
    # the default applies to every dataset without its own policy: an enrollment setting
    import auth

    auth.require_admin()
    with _lock:
        s = _load()
        s["default"] = req.model_dump()
        _store(s)
    return s["default"]


@router.post("/retention/apply")
def post_apply_all(req: ApplyRequest) -> dict:
    import auth

    if not req.dry_run:
        auth.require_admin()
    return apply_all(req.dry_run)
