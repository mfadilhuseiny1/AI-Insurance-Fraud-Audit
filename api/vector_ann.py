"""Approximate nearest neighbour (ANN) index for KNN on Ontology vector properties (ontology_semantic.knn).

KNN used to score every object with a Python cosine loop. Now:

* Small sets (fewer than ANN_MIN objects, default 5000) and exact mode: an exact scan in numpy, the top candidates
  re-scored with the original cosine, so results and scores are the same as the old scan.
* Large sets: an IVF index (inverted file, no packages beyond numpy). Spherical k-means puts ~4·√n centroids on the
  unit-normalized vectors; each vector is filed under its nearest centroid. A query scores the centroids, scans the
  vectors of the nearest lists and returns candidates; ontology_semantic re-scores them with the exact cosine on the
  objects' own vectors. How many lists are probed is calibrated when the index is trained: 64 queries made from its
  own vectors (pushed off the data) are searched exactly and approximately, and the smallest fraction of lists in PROBES reaching TARGET_RECALL (recall@10)
  is kept (at least MIN_PROBE lists, more when k is large). Vectors without cluster structure (e.g. uniform random)
  reach it at no fraction: the index is then not used and KNN scans exactly.
* One index per (object type, vector property), persisted as data/ontology/vector-index/<type id>.<property>.npz next
  to the objects. It records the stored objects' signature (ontology.objects_stat: mtime and size of the file or shards) it was built from and is only used while that matches,
  so a query never sees a stale index: after any write the query falls back to the exact scan and a background thread
  updates the index incrementally (unchanged vectors keep their list, changed / added vectors are filed under the
  existing centroids, deleted ones dropped; k-means is re-run only when the set doubled, halved or changed more than
  its trained size). Deleting the .npz files is safe: KNN scans exactly until the index is rebuilt.
* Not used inside an Ontology scenario or a function run snapshot (their objects differ from the stored ones): those
  scan the rows' own vectors. With `exact`, a narrow filter (rows searched less than half of the indexed objects) or an
  index whose calibration failed, a current index is still used, as a ready matrix scanned exactly (no conversion of
  the JSON lists). Results that the re-score leaves short of k (vectors hidden by property security) fall back to
  scanning the rows.
* With a current index the semantic search / KNN routes do not load the object type at all (ontology_semantic.knn_fast):
  the index ranks the vectors (`current` reads the .npz when it is not in memory yet, `ranked` searches it) and only
  the candidates' records are read (ontology_store.get_many), checked for visibility and re-scored.

Environment: BLUESANDAI_ANN_MIN (objects before an index is built), BLUESANDAI_ANN_PROBE (fraction of lists probed).
"""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import numpy as np

log = logging.getLogger("bluesandai.vector_ann")

ANN_MIN = int(os.environ.get("BLUESANDAI_ANN_MIN") or 5000)
PROBE_ENV = os.environ.get("BLUESANDAI_ANN_PROBE")  # a fixed fraction of lists to probe instead of the calibrated one
PROBES = (0.1, 0.2, 0.3)  # fractions tried at calibration, smallest first
TARGET_RECALL = 0.97  # recall@10 a calibrated index must reach on its own vectors, or it is not used
MIN_PROBE = 8
NUMPY_MIN = 64  # below this many rows the Python scan is as fast
FORMAT = 1

_lock = threading.RLock()
_indexes: dict[tuple[str, str], "Index"] = {}
_threads: dict[tuple[str, str], threading.Thread] = {}
STATS = {"builds": 0, "updates": 0, "ann_queries": 0, "exact_queries": 0}


# ------------------------------------------------------------------------------------------------
# the IVF index
# ------------------------------------------------------------------------------------------------


def normalize(X: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(X, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return (X / n).astype(np.float32, copy=False)


def _assign(X: np.ndarray, C: np.ndarray, batch: int = 8192) -> np.ndarray:
    out = np.empty(len(X), np.int32)
    for s in range(0, len(X), batch):
        out[s:s + batch] = np.argmax(X[s:s + batch] @ C.T, axis=1)
    return out


def n_lists(n: int) -> int:
    return int(max(1, min(n // 8, round(4 * math.sqrt(n)))))


def kmeans(X: np.ndarray, nlist: int, iters: int = 10, sample: int = 64, seed: int = 0) -> np.ndarray:
    """Spherical k-means: nlist unit centroids (trained on up to nlist·sample vectors)."""
    rng = np.random.default_rng(seed)
    S = X if len(X) <= nlist * sample else X[rng.choice(len(X), nlist * sample, replace=False)]
    C = S[rng.choice(len(S), nlist, replace=False)].copy()
    for _ in range(iters):
        a = _assign(S, C)
        order = np.argsort(a, kind="stable")
        counts = np.bincount(a, minlength=nlist)
        starts = np.concatenate(([0], np.cumsum(counts)[:-1]))
        nz = counts > 0
        C[nz] = np.add.reduceat(S[order], starts[nz], axis=0)
        empty = np.flatnonzero(~nz)
        if len(empty):
            C[empty] = S[rng.choice(len(S), len(empty), replace=False)]
        C = normalize(C)
    return C


class Index:
    """IVF-flat over unit vectors, stored in list order (X, pks, assign sorted by list; offsets per list)."""

    def __init__(self, dim: int, pks: list[str], X: np.ndarray, assign: np.ndarray, C: np.ndarray, n_trained: int,
                 updates: int, stat: Any, sorted_: bool = False, probe: Optional[float] = 0.1) -> None:
        if not sorted_:
            order = np.argsort(assign, kind="stable")
            X, assign, pks = X[order], assign[order], [pks[i] for i in order]
        self.dim, self.C, self.n_trained, self.updates, self.stat, self.probe = dim, C, n_trained, updates, stat, probe
        self.calibration: dict = {}
        self.X = np.ascontiguousarray(X, dtype=np.float32)
        self.assign = assign.astype(np.int32, copy=False)
        self.pks = pks
        self.offsets = np.concatenate(([0], np.cumsum(np.bincount(self.assign, minlength=len(C))))).astype(np.int64)
        self.pos = {pk: i for i, pk in enumerate(pks)}

    @property
    def n(self) -> int:
        return len(self.pks)

    def search(self, q: np.ndarray, m: int, nprobe: Optional[int] = None) -> tuple[np.ndarray, np.ndarray]:
        """Positions of the ~m nearest vectors to the unit vector q, nearest first, with their cosines."""
        nlist = len(self.C)
        frac = float(PROBE_ENV) if PROBE_ENV else (self.probe or 1.0)
        # more candidates need more lists: the calibrated fraction is for k=10 (m=26), grown with √(m/26) for larger k
        nprobe = min(nlist, nprobe or max(MIN_PROBE, math.ceil(nlist * frac * max(1.0, math.sqrt(m / 26)))))
        cs = self.C @ q
        order = np.argsort(-cs)
        sizes = np.diff(self.offsets)[order]
        # and always enough lists to scan at least 10·m vectors
        need = int(np.searchsorted(np.cumsum(sizes), min(self.n, 10 * m))) + 1
        probe = [int(i) for i in order[:max(nprobe, min(need, nlist))] if self.offsets[i + 1] > self.offsets[i]]
        if not probe:
            return np.empty(0, np.int64), np.empty(0, np.float32)
        # each list is a contiguous slice: score it in place (no gather copy)
        sims = np.concatenate([self.X[self.offsets[i]:self.offsets[i + 1]] @ q for i in probe])
        idx = np.concatenate([np.arange(self.offsets[i], self.offsets[i + 1]) for i in probe])
        if len(idx) > m:
            top = np.argpartition(-sims, m - 1)[:m]
            idx, sims = idx[top], sims[top]
        o = np.argsort(-sims, kind="stable")
        return idx[o], sims[o]

    def calibrate(self, samples: int = 64, seed: int = 0) -> dict:
        """Set `probe` to the smallest fraction in PROBES whose recall@10 reaches TARGET_RECALL on queries made from
        sampled own vectors pushed off the data (an isotropic random direction three times their length added, so the query
        has a cosine of about 0.3 with its source, harder than a text query against documents); None when none does."""
        rng = np.random.default_rng(seed)
        src = self.X[rng.choice(self.n, min(samples, self.n), replace=False)]
        g = rng.standard_normal(src.shape).astype(np.float32)
        Q = normalize(src + 3.0 * normalize(g))
        truth = [set(np.argpartition(-(self.X @ q), 9)[:10].tolist()) for q in Q]
        nlist = len(self.C)
        out: dict = {}
        self.probe = None
        for frac in PROBES:
            got = 0
            for q, tr in zip(Q, truth):
                pos, _ = self.search(q, 10, max(MIN_PROBE, math.ceil(nlist * frac)))
                got += len(set(pos.tolist()) & tr)
            out[frac] = round(got / (10 * len(Q)), 4)
            if out[frac] >= TARGET_RECALL:
                self.probe = frac
                break
        self.calibration = out
        return out

    def save(self, path: Path, type_id: str, prop: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        meta = {"format": FORMAT, "type_id": type_id, "property": prop, "dim": self.dim, "n": self.n, "lists": len(self.C),
                "n_trained": self.n_trained, "updates": self.updates, "stat": self.stat, "probe": self.probe,
                "calibration": {str(k): v for k, v in self.calibration.items()},
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        # a temp file per write: two saves of one index at once never write into the same file
        tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.tmp")
        try:
            with open(tmp, "wb") as f:
                np.savez(f, X=self.X, assign=self.assign, C=self.C, pks=np.array(self.pks, dtype=str), meta=np.array(json.dumps(meta)))
            for attempt in range(20):
                try:
                    os.replace(tmp, path)
                    return
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(0.05)
        except BaseException:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise

    @classmethod
    def load(cls, path: Path) -> Optional["Index"]:
        try:
            with np.load(path, allow_pickle=False) as z:
                meta = json.loads(str(z["meta"]))
                if meta.get("format") != FORMAT:
                    return None
                idx = cls(int(meta["dim"]), z["pks"].tolist(), z["X"], z["assign"], z["C"], int(meta["n_trained"]),
                          int(meta.get("updates") or 0), meta.get("stat"), sorted_=True, probe=meta.get("probe"))
                idx.calibration = {float(k): v for k, v in (meta.get("calibration") or {}).items()}
                return idx
        except FileNotFoundError:
            return None
        except Exception:  # noqa: BLE001 - a damaged file is rebuilt
            log.exception("vector index %s unreadable; rebuilding", path)
            return None


# ------------------------------------------------------------------------------------------------
# indexes of the Ontology's vector properties
# ------------------------------------------------------------------------------------------------


def _ontology() -> Any:
    import ontology

    return ontology


def index_dir() -> Path:
    return _ontology().DIR / "vector-index"


def index_path(type_id: str, prop: str) -> Path:
    return index_dir() / f"{type_id}.{prop}.npz"


def _stat(type_id: str) -> Any:
    """A cheap signature of the stored objects (ontology.objects_stat: format, mtime, size of the file or shards); it
    changes on every write, so an index recorded with another signature is stale."""
    s = _ontology().objects_stat(type_id)
    return [s.get("format"), s.get("mtime_ns"), s.get("size")] if s else None


def _load(type_id: str) -> dict:
    return _ontology().load_objects(type_id) or {}


def _matrix(vecs: list[Any], dim: int) -> tuple[list[int], Optional[np.ndarray]]:
    """Positions of the vectors of length dim and their float32 matrix (None if values are not numbers)."""
    keep = [i for i, v in enumerate(vecs) if isinstance(v, list) and len(v) == dim]
    try:
        return keep, np.asarray([vecs[i] for i in keep], dtype=np.float32).reshape(len(keep), dim)
    except (TypeError, ValueError):
        good = []
        for i in keep:
            try:
                np.asarray(vecs[i], dtype=np.float32)
                good.append(i)
            except (TypeError, ValueError):
                pass
        if not good:
            return [], None
        return good, np.asarray([vecs[i] for i in good], dtype=np.float32).reshape(len(good), dim)


def _stored(type_id: str, prop: str, dim: int) -> tuple[list[str], np.ndarray, Any]:
    stat = _stat(type_id)  # before the read: a write after it makes the index stale, never wrongly current
    objs = _load(type_id)
    pks = [str(pk) for pk in objs]
    vecs = [(o.get("properties") or {}).get(prop) for o in objs.values()]
    keep, X = _matrix(vecs, dim)
    if X is None:
        return [], np.zeros((0, dim), np.float32), stat
    return [pks[i] for i in keep], normalize(X), stat


def refresh(type_id: str, prop: str, dim: int) -> Optional[Index]:
    """Bring the index up to date with the stored objects (incrementally when it exists) and save it."""
    key = (type_id, prop)
    path = index_path(type_id, prop)
    with _lock:
        cur = _indexes.get(key)
    if cur is None:
        cur = Index.load(path)
    if cur is not None and cur.stat == _stat(type_id) and cur.dim == dim:
        with _lock:
            _indexes[key] = cur
        return cur
    pks, X, stat = _stored(type_id, prop, dim)
    n = len(pks)
    if n < ANN_MIN:
        with _lock:
            _indexes.pop(key, None)
        try:
            path.unlink()
        except OSError:
            pass
        return None
    started = time.monotonic()
    retrain = cur is None or cur.dim != dim or n > 2 * cur.n_trained or n < cur.n_trained / 2 or cur.updates > cur.n_trained
    if retrain:
        C = kmeans(X, n_lists(n))
        assign, n_trained, updates = _assign(X, C), n, 0
        STATS["builds"] += 1
    else:
        C = cur.C
        old = np.fromiter((cur.pos.get(pk, -1) for pk in pks), np.int64, count=n)
        have = old >= 0
        same = np.zeros(n, bool)
        if have.any():
            same[have] = np.all(np.abs(cur.X[old[have]] - X[have]) <= 1e-6, axis=1)
        assign = np.empty(n, np.int32)
        assign[same] = cur.assign[old[same]]
        todo = ~same
        if todo.any():
            assign[todo] = _assign(X[todo], C)
        n_trained = cur.n_trained
        updates = cur.updates + int(todo.sum()) + (cur.n - int(have.sum()))
        STATS["updates"] += 1
    idx = Index(dim, pks, X, assign, C, n_trained, updates, stat, probe=None if retrain else cur.probe)
    if retrain:
        idx.calibrate()
    else:
        idx.calibration = cur.calibration
    idx.save(path, type_id, prop)
    with _lock:
        _indexes[key] = idx
    log.info("vector index %s.%s: %d vectors, %d lists, %s in %.1fs", type_id, prop, n, len(C), "trained" if retrain else "updated",
             time.monotonic() - started)
    return idx


def schedule(type_id: str, prop: str, dim: int) -> None:
    """Refresh the index in a background thread (one at a time per index)."""
    key = (type_id, prop)
    with _lock:
        th = _threads.get(key)
        if th and th.is_alive():
            return

        def run() -> None:
            try:
                refresh(type_id, prop, dim)
            except Exception:  # noqa: BLE001
                log.exception("vector index %s.%s failed", type_id, prop)

        th = threading.Thread(target=run, daemon=True, name=f"vector-index-{type_id}")
        _threads[key] = th
        th.start()


def wait(type_id: str, prop: str, timeout: float = 600) -> None:
    with _lock:
        th = _threads.get((type_id, prop))
    if th:
        th.join(timeout)


def forget(type_id: str, prop: str) -> None:
    """Drop the in-memory copy (tests: the next use loads the file)."""
    with _lock:
        _indexes.pop((type_id, prop), None)


def status(type_id: str, prop: str) -> dict:
    with _lock:
        idx = _indexes.get((type_id, prop))
    path = index_path(type_id, prop)
    return {"loaded": idx is not None, "file": path.exists(), "current": bool(idx and idx.stat == _stat(type_id)),
            "vectors": idx.n if idx else 0, "lists": len(idx.C) if idx else 0, "probe": idx.probe if idx else None}


def current(type_id: str, prop: str, dim: int) -> Optional[Index]:
    """The index of (type, property) when it is current (built from the objects as stored now), else None. An index not
    in memory yet is read from its .npz here (a few ms; a stale one is kept in memory for the incremental update), so
    the first query after a start does not have to scan. None in a scenario or a function run snapshot."""
    o = _ontology()
    if o.SCENARIO.get() or o.SNAPSHOT.get():
        return None
    key = (type_id, prop)
    with _lock:
        idx = _indexes.get(key)
    if idx is None:
        path = index_path(type_id, prop)
        if path.exists():
            loaded = Index.load(path)
            if loaded is not None and loaded.dim == dim:
                with _lock:
                    idx = _indexes.setdefault(key, loaded)
    if idx is None or idx.dim != dim or idx.stat != _stat(type_id):
        return None
    return idx


def ranked(idx: Index, qv: list[float], m: int, allowed: Optional[Any] = None,
           exact: bool = False) -> Optional[tuple[list[str], bool, bool]]:
    """(primary keys of about the m indexed objects nearest qv, nearest first; whether they came from the ANN search;
    whether they are every allowed indexed object). `allowed` (a set or dict of primary keys, None = all) is applied
    before an exact scan and after an ANN search (over-fetched by n / allowed). Exact: an exact scan of the index's
    matrix, for `exact`, a filter keeping less than half of the indexed objects, or an index whose calibration failed.
    None when the query vector has no direction."""
    q = np.asarray(qv, dtype=np.float32)
    nq = float(np.linalg.norm(q))
    if not nq or not np.isfinite(nq):
        return None
    q = q / nq
    n_allowed = idx.n if allowed is None else len(allowed)
    if exact or (idx.probe is None and not PROBE_ENV) or n_allowed < idx.n / 2:
        if allowed is None:
            pos = np.arange(idx.n, dtype=np.int64)
            sims = idx.X @ q
        else:
            pos = np.fromiter((i for i in (idx.pos.get(pk) for pk in allowed) if i is not None), np.int64)
            if not len(pos):
                return [], False, True
            sims = idx.X[pos] @ q
        total = len(pos)
        if total > m:
            top = np.argpartition(-sims, m - 1)[:m]
            pos, sims = pos[top], sims[top]
        STATS["exact_queries"] += 1
        return [idx.pks[i] for i in pos[np.argsort(-sims, kind="stable")]], False, total <= m
    want = min(idx.n, math.ceil(m * idx.n / max(1, n_allowed)))
    pos, _ = idx.search(q, want)
    STATS["ann_queries"] += 1
    return [pk for pk in (idx.pks[i] for i in pos) if allowed is None or pk in allowed], True, False


def candidates(type_id: str, prop: str, qv: list[float], rows: int, allowed: dict, m: int,
               exact: bool = False) -> Optional[tuple[list[str], bool]]:
    """Primary keys (in `allowed`) of about the m objects nearest qv, nearest first, and whether they came from the ANN
    search (False: an exact scan of the index's matrix, used for `exact`, a narrow filter or an index whose calibration
    failed). None when there is no current index (none yet, stale, scenario, snapshot): the caller then scans the rows'
    own vectors. Never blocks on a build."""
    o = _ontology()
    if o.SCENARIO.get() or o.SNAPSHOT.get():
        return None
    dim = len(qv)
    idx = current(type_id, prop, dim)
    if idx is None:
        with _lock:
            known = (type_id, prop) in _indexes
        if rows >= ANN_MIN or known:
            schedule(type_id, prop, dim)
        return None
    got = ranked(idx, qv, m, allowed, exact)
    return None if got is None else (got[0], got[1])


def exact_top(qv: list[float], vecs: list[Any], m: int) -> Optional[list[int]]:
    """Positions of the m vectors nearest qv by cosine (numpy scan); None when the vectors are not numeric."""
    keep, M = _matrix(vecs, len(qv))
    if M is None:
        return [] if not keep else None
    STATS["exact_queries"] += 1
    q = np.asarray(qv, dtype=np.float32)
    norms = np.linalg.norm(M, axis=1)
    norms[norms == 0] = 1.0
    sims = (M @ q) / norms
    if len(sims) > m:
        top = np.argpartition(-sims, m - 1)[:m]
    else:
        top = np.arange(len(sims))
    return sorted(keep[i] for i in top)
