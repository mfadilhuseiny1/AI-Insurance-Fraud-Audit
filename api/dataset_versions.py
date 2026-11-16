"""Dataset transactions: every pipeline deploy and code build of a Parquet dataset keeps a copy of what it
wrote, so Data Lineage can show the dataset's history and roll it back, like Foundry's dataset rollback.

A transaction is {id, at, kind (build | deploy | rollback), rows, columns, size, source {kind, id, name,
commit?, branch?}}; the newest KEEP copies are kept per dataset (older ones lose their data but stay in the
history). Rolling back writes an earlier transaction's data as a new "rollback" transaction and marks the
ones after it as rolled back. Files: data/lineage/versions/<item id>/ (index.json + <tx id>.parquet).

Maintenance (Foundry's "maintaining high performance"):
- retention policies (dataset_retention.py) decide which transactions keep their data; they run after every
  record() and periodically. KEEP is only the fallback when that module is unavailable.
- projections (dataset_projections.py) are rebuilt in the background after every record().
- abort_if_empty() lets a writer skip a write (and its transaction) that holds no rows, when the dataset's
  policy says so. Call it BEFORE writing the file.
"""

from __future__ import annotations

import io
import json
import sys
import threading
import uuid
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pyarrow.parquet as pq

DIR: Path = Path()
KEEP = 20
_lock = threading.Lock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "lineage" / "versions"
    DIR.mkdir(parents=True, exist_ok=True)


def _folder(item_id: str) -> Path:
    if not item_id.isalnum():
        raise ValueError("bad dataset id")
    return DIR / item_id


def history(item_id: str, aborted: bool = False) -> list[dict]:
    """The dataset's transactions, newest first. Aborted transactions (a job that succeeded without committing:
    abort(), abort_job(), an aborted empty write) hold no data and are left out unless `aborted` is set: the
    transaction history shows them greyed out, everything else reads committed transactions only."""
    try:
        txs = json.loads((_folder(item_id) / "index.json").read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return []
    return txs if aborted else [t for t in txs if not t.get("aborted")]


def _save(item_id: str, txs: list[dict]) -> None:
    f = _folder(item_id)
    f.mkdir(parents=True, exist_ok=True)
    tmp = f / f"index.{uuid.uuid4().hex[:8]}.tmp"  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(txs, ensure_ascii=False), "utf-8")
    tmp.replace(f / "index.json")


# transaction-level provenance: the input transactions a build read, noted when its output inherits markings
# (auth.propagate) and attached to the output's transaction (before or just after it is recorded)
_pending_inputs: dict[str, tuple[float, dict[str, Optional[str]]]] = {}
PROVENANCE_WINDOW_S = 300


def note_inputs(item_id: str, inputs: list[Optional[str]]) -> None:
    """Record which transaction of each input (Files dataset ids) an output's current build read. Never raises."""
    try:
        cur = {}
        for i in inputs:
            if i and str(i).isalnum() and i != item_id:
                h = history(i)
                cur[i] = h[0]["id"] if h else None
        if not cur:
            return
        with _lock:
            txs = history(item_id, aborted=True)
            newest = txs[0] if txs else None
            fresh = newest and not (newest.get("source") or {}).get("input_transactions") and \
                newest["at"] >= datetime.fromtimestamp(time.time() - PROVENANCE_WINDOW_S, timezone.utc).isoformat(timespec="seconds")
            if fresh:
                newest.setdefault("source", {})["input_transactions"] = cur
                _save(item_id, txs)
            else:
                _pending_inputs[item_id] = (time.time(), cur)
    except Exception:  # noqa: BLE001
        pass


def record(item_id: str, data: bytes, kind: str, source: dict[str, Any]) -> dict:
    """Keep a copy of what was just written. Never raises: history is an audit aid, not the write itself."""
    pend = _pending_inputs.pop(item_id, None)
    if pend and time.time() - pend[0] < PROVENANCE_WINDOW_S and "input_transactions" not in source:
        source = {**source, "input_transactions": pend[1]}
    try:
        meta = pq.ParquetFile(io.BytesIO(data)).metadata
        schema = meta.schema.to_arrow_schema()
        rows, columns = meta.num_rows, [f.name for f in schema]
    except Exception:  # noqa: BLE001
        rows, columns = None, []
    tx = {"id": uuid.uuid4().hex[:12], "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "kind": kind,
          "rows": rows, "columns": columns, "size": len(data), "source": source, "kept": True}
    try:
        retention = _maintenance("dataset_retention")
        with _lock:
            f = _folder(item_id)
            f.mkdir(parents=True, exist_ok=True)
            (f / f"{tx['id']}.parquet").write_bytes(data)
            txs = [tx, *history(item_id, aborted=True)]
            if retention is None:  # fallback: the newest KEEP copies
                for old in txs[KEEP:]:
                    if old.get("kept"):
                        (f / f"{old['id']}.parquet").unlink(missing_ok=True)
                        old["kept"] = False
            _save(item_id, txs)
    except Exception:  # noqa: BLE001
        return tx
    _after_record(item_id, tx)
    return tx


def _maintenance(name: str) -> Any:
    """dataset_retention / dataset_projections, imported lazily (they import this module)."""
    try:
        return __import__(name)
    except Exception:  # noqa: BLE001
        return None


def _after_record(item_id: str, tx: dict) -> None:
    """Retention applies to the dataset right away; projections rebuild in the background."""
    retention = _maintenance("dataset_retention")
    if retention is not None:
        try:
            retention.apply(item_id)
        except Exception:  # noqa: BLE001
            pass
    projections = _maintenance("dataset_projections")
    if projections is not None:
        try:
            projections.on_transaction(item_id, tx["id"])
        except Exception:  # noqa: BLE001
            pass
    studio = _maintenance("model_studio")
    if studio is not None:
        try:
            # Model Studio: studios set to retrain when their training data updates
            studio.on_dataset_transaction(item_id)
        except Exception:  # noqa: BLE001
            pass
    sds = _maintenance("sds")
    if sds is not None:
        try:
            # Sensitive Data Scanner: continuous scans scan a dataset when it gets new data
            sds.on_transaction(item_id)
        except Exception:  # noqa: BLE001
            pass
    deployments = sys.modules.get("model_deployments")  # only when the API loaded it: never imported by a commit
    if deployments is not None:
        try:
            # batch model deployments reading this dataset rebuild now, not at the monitor's next check; in the
            # background (it reads every deployment's record), so the commit is neither slowed nor failed by it
            threading.Thread(target=_deployments_hook, args=(deployments, item_id), name="model-deployments-input", daemon=True).start()
        except Exception:  # noqa: BLE001
            pass


def _deployments_hook(deployments: Any, item_id: str) -> None:
    try:
        deployments.on_dataset_transaction(item_id)
    except Exception:  # noqa: BLE001 - the monitor's periodic check still finds the change
        pass


def current(item_id: str) -> Optional[dict]:
    """The transaction whose data is the dataset's current view (the newest one), if any."""
    txs = history(item_id)
    return txs[0] if txs else None


def abort_if_empty(item_id: Optional[str], rows: Optional[int], source: Optional[dict[str, Any]] = None) -> bool:
    """True when a write of `rows` rows to the dataset should be aborted instead of committed: it holds no
    rows and the dataset's policy (or the default policy) has "abort empty transactions" on. The caller then
    skips writing the file and calling record(), like Foundry's output.abort(): no transaction, nothing
    downstream triggered. The abort is counted in the dataset's policy stats."""
    if rows != 0:
        return False
    retention = _maintenance("dataset_retention")
    if retention is None:
        return False
    try:
        if not retention.policy_for(item_id).get("abort_empty"):
            return False
        retention.note_aborted(item_id, source or {})
    except Exception:  # noqa: BLE001
        return False
    record_aborted(item_id, {**(source or {}), "reason": "empty"})
    return True


# aborted transactions kept per dataset (newest first)
KEEP_ABORTED = 100


def record_aborted(item_id: Optional[str], source: dict[str, Any]) -> Optional[dict]:
    """An aborted transaction: the job succeeded, nothing was committed. Recorded without data so the
    dataset's transaction history can show it greyed out. Never raises."""
    if not item_id or not str(item_id).isalnum():
        return None
    tx = {"id": uuid.uuid4().hex[:12], "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "kind": "aborted", "aborted": True,
          "rows": None, "columns": [], "size": 0, "source": source, "kept": False}
    try:
        with _lock:
            txs = [tx, *history(item_id, aborted=True)]
            extra = [t["id"] for t in txs if t.get("aborted")][KEEP_ABORTED:]
            _save(item_id, [t for t in txs if t["id"] not in extra])
    except Exception:  # noqa: BLE001
        return None
    return tx


def data(item_id: str, tx_id: str) -> Optional[bytes]:
    if not tx_id.isalnum():
        return None
    p = _folder(item_id) / f"{tx_id}.parquet"
    return p.read_bytes() if p.exists() else None


def mark_rolled_back(item_id: str, to_tx: str, new_tx: dict) -> None:
    """Every transaction after `to_tx` (except the new rollback one) is marked as rolled back."""
    with _lock:
        txs = history(item_id, aborted=True)
        for t in txs:
            if t["id"] == to_tx:
                break
            if t["id"] != new_tx["id"] and not t.get("aborted"):
                t["rolled_back"] = True
        _save(item_id, txs)
