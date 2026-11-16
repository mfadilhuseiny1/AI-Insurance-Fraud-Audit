"""Features of the /testing fraud models, computed the same way for training (all claims at once) and for the service
(one new claim appended to the stream).

Model 1 (graph + neighbours): the claim's own system features (the realtime engine's signal vector and the claim fields,
scaled with the frozen penskala_fkrtl.json; no VIME), plus, for each of four graph relations (same member, same hospital, same
hospital + INA-CBG code, same code), the mean of the earlier neighbours' standardized features (causal: claims that
arrived before; at most 10/10/10/5) and log(1 + number of neighbours).
Model 2 (rings): for windows of +-3/7/14 days, the most other members sharing this hospital and another hospital this
member visited (rs), all such co-members (co), and the hospitals the member visited (nh); plus inpatient. The ring alert
uses rs and co for +-3/7/14/30/60 days.
Synthetic data only."""
from __future__ import annotations

import bisect
import json
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Optional

import numpy as np

CAPS = {"peserta": 10, "faskes": 10, "faskes_kode": 10, "kode": 5}
G3_WINS = (3, 7, 14)
R2_WINS = (3, 7, 14, 30, 60)
RELASI_NAMA = {"peserta": "peserta sama", "faskes": "RS sama", "faskes_kode": "RS + kode INA-CBG sama", "kode": "kode INA-CBG sama"}

# ONE feature path for training and serving (the train/serve skew found 2026-11-12 with generator 2). Before, the batch path
# (agg_matrix, the training stream) averaged the neighbours with a float32 sparse product (weights 1/n) and took log1p in float32,
# while the service, data v2 and the tests (Stream.agg_row) used np.mean and a float64 log1p. Near-constant neighbour means then
# differed in the last digits (-0.1544088721 vs -0.1544088870), Model 1 split between them (416 splits inside that noise) and
# could tell a training row from a served one. Both paths now call rata_tetangga and DEG_LOG, so they are bit-identical
# (testing/test_fitur_satu_jalur.py checks max |diff| == 0).
DEG_LOG = np.log1p(np.arange(max(CAPS.values()) + 1, dtype=np.float64)).astype(np.float32)  # log(1 + number of neighbours)


def rata_tetangga(rows: np.ndarray) -> np.ndarray:
    """The mean of a claim's neighbour rows (standardized, float32, in arrival order): summed in float64 row by row, divided
    once, cast to float32 once. The only neighbour mean in this module."""
    return (np.asarray(rows, dtype=np.float64).sum(axis=0) / len(rows)).astype(np.float32)


def engine_cols() -> tuple[list[int], list[str]]:
    from aip.realtime import aktif as AK

    idx = [i for i, n in enumerate(AK.NAMES) if n not in AK.SSL_COLS and n != "s:ANOMALI_SSL"]
    return idx, [AK.NAMES[i] for i in idx]


# No VIME in /testing (the user, 2026-11-12: "buat sekarang ga usah dulu ada VIME SSL"). The models never used VIME's
# embedding or anomaly as features (engine_cols drops them); what they used is the median/IQR scaling of the claim fields
# from VIME's preprocessor. That scaling is frozen in penskala_fkrtl.json (same numbers, version ssl-fkrtl-20261110093004),
# so no VIME model or torch is loaded and a retrained VIME cannot shift the inputs. The VIME anomaly signal is also taken
# out of the rule score of stored events (tanpa_vime); the engine raises it no more (platform_lokal.InputSaja).
PENSKALA = Path(__file__).resolve().parent / "penskala_fkrtl.json"


class Penskala:
    """The frozen claim-field scaling: raw inputs (an event's ssl.x) → the 70 scaled claim fields of the models."""

    def __init__(self, path: Path = PENSKALA) -> None:
        from aip.realtime import ssl as SS

        d = json.loads(path.read_text("utf-8"))
        self.spec = SS.SPECS["fkrtl"]
        if self.spec.key() != d["spek"]:
            raise RuntimeError(f"{path.name}: input spec {d['spek']} is not the engine's {self.spec.key()}")
        self.prep = SS.Prep(self.spec, d["med"], d["iqr"])
        self.versi = d["versi"]

    def transform(self, xs: list[list]) -> np.ndarray:
        import pandas as pd

        from aip.realtime import ssl as SS

        return self.prep.transform(SS.derive(self.spec, pd.DataFrame(xs, columns=self.spec.base_cols), None))


def load_ssl(al_dir: Optional[Path] = None) -> Penskala:
    """Kept under its old name for the scripts that call it. `al_dir` is ignored: no VIME model is read any more."""
    return Penskala()


def tanpa_vime(e: dict) -> dict:
    """The event without the VIME anomaly signal, its rule scores recomputed as mesin.score does: 100 × (1 − e^−Σ)."""
    sig = e.get("sinyal") or []
    if not any(x.get("kode") == "ANOMALI_SSL" for x in sig):
        return e
    rest = [x for x in sig if x.get("kode") != "ANOMALI_SSL"]
    tot = sum(float(x.get("kontribusi") or 0) for x in rest)
    raw = sum(float(x.get("kontribusi_tanpa_mitigasi") or 0) for x in rest)
    skor = round(100 * (1 - np.exp(-tot)), 1)
    out = {**e, "sinyal": rest, "skor_tanpa_mitigasi": round(100 * (1 - np.exp(-raw)), 1)}
    if "skor_aturan" in e:  # the active-learning model decided: its score stays, the rule score changes
        out["skor_aturan"] = skor
    else:
        out["skor"] = skor
    return out


def sys_features(recs: list[dict], penskala: Penskala) -> np.ndarray:
    """The system features of events: the engine vector without the VIME anomaly + the scaled claim fields."""
    from aip.realtime import aktif as AK

    idx, _ = engine_cols()
    eng = np.vstack([np.asarray(AK.vec(tanpa_vime(e)), dtype=np.float64)[idx] for e in recs])
    z = penskala.transform([e["ssl"]["x"] for e in recs])
    return np.hstack([eng, np.asarray(z, dtype=np.float64)]).astype(np.float32)


def claim_fields(e: dict) -> dict:
    """What the graph and ring features need from one event."""
    return {"peserta": e.get("peserta"), "faskes": e.get("faskes") or "", "kode": e.get("kode") or "",
            "day": int(np.datetime64((e.get("tgl_datang") or "1970-01-01")[:10], "D").astype(int)),
            "ritl": 1.0 if e.get("tingkat") == "RITL" else 0.0}


class Stream:
    """The FKRTL claims in arrival order, with the indexes the features need. New claims are appended."""

    def __init__(self, sys_mat: np.ndarray, fields: list[dict], mu: np.ndarray, sd: np.ndarray) -> None:
        self.SYS = [row for row in sys_mat]
        self.mu, self.sd = mu, sd
        self.XS = [self._std(r) for r in self.SYS]
        self.f = list(fields)
        self.rel: dict[str, dict[Any, list[int]]] = {r: defaultdict(list) for r in CAPS}
        self.by_fac: dict[str, list[tuple[int, int, Any]]] = defaultdict(list)
        self.by_mem: dict[Any, list[tuple[int, int, str]]] = defaultdict(list)
        for i, fd in enumerate(self.f):
            self._index(i, fd)

    def _std(self, row: np.ndarray) -> np.ndarray:  # from the float32 row, as agg_matrix
        return np.clip(np.nan_to_num((np.asarray(row, dtype=np.float32) - self.mu) / self.sd, nan=0.0), -10, 10).astype(np.float32)

    @staticmethod
    def keys(fd: dict) -> dict[str, Any]:
        return {"peserta": fd["peserta"], "faskes": fd["faskes"], "faskes_kode": f"{fd['faskes']}|{fd['kode']}", "kode": fd["kode"]}

    def _index(self, i: int, fd: dict) -> None:
        for r, k in self.keys(fd).items():
            if k not in (None, "", "|"):
                self.rel[r][k].append(i)
        bisect.insort(self.by_fac[fd["faskes"]], (fd["day"], i, fd["peserta"]))
        self.by_mem[fd["peserta"]].append((fd["day"], i, fd["faskes"]))

    def __len__(self) -> int:
        return len(self.f)

    def append(self, sys_row: np.ndarray, fd: dict) -> int:
        i = len(self.f)
        self.SYS.append(sys_row); self.XS.append(self._std(sys_row)); self.f.append(fd)
        self._index(i, fd)
        return i

    # ---- Model 1
    def neighbours(self, i: int) -> dict[str, list[int]]:
        """The earlier claims of each relation (arrival order), at most CAPS[r]."""
        out = {}
        for r, k in self.keys(self.f[i]).items():
            lst = self.rel[r].get(k, [])
            pos = bisect.bisect_left(lst, i)
            out[r] = lst[max(0, pos - CAPS[r]):pos]
        return out

    def agg_row(self, i: int) -> np.ndarray:
        nb = self.neighbours(i)
        parts = [np.asarray(self.SYS[i], dtype=np.float32)]
        degs = []
        for r in CAPS:
            ids = nb[r]
            parts.append(rata_tetangga(np.stack([self.XS[j] for j in ids])) if ids else np.zeros(len(self.XS[i]), np.float32))
            degs.append(DEG_LOG[len(ids)])
        return np.concatenate(parts + [np.array(degs, np.float32)])

    # ---- Model 2
    def _members(self, fac: str, d: int, W: int) -> set:
        v = self.by_fac.get(fac, [])
        lo = bisect.bisect_left(v, (d - W, -1, -(1 << 62))); hi = bisect.bisect_right(v, (d + W, 1 << 40, 1 << 62))
        return {m for _d, _s, m in v[lo:hi]}

    def ring_detail(self, i: int, W: int) -> tuple[int, int, int, dict]:
        """(rs, co, nh, {other hospital: shared members}) for claim i and window W."""
        fd = self.f[i]
        other = {g for dd, s, g in self.by_mem[fd["peserta"]] if g != fd["faskes"] and abs(dd - fd["day"]) <= W}
        if not other:
            return 0, 0, 0, {}
        here = self._members(fd["faskes"], fd["day"], W) - {fd["peserta"]}
        inter = {g: here & self._members(g, fd["day"], W) for g in other}
        rs = max(len(x) for x in inter.values())
        co = len(set().union(*inter.values()))
        return rs, co, len(other), inter

    def s2_row(self, i: int) -> np.ndarray:
        vals = []
        for W in G3_WINS:
            rs, co, nh, _ = self.ring_detail(i, W)
            vals += [np.log1p(rs), np.log1p(co), nh]
        vals.append(self.f[i]["ritl"])
        return np.array(vals, np.float32)

    def r2_row(self, i: int) -> np.ndarray:
        vals = []
        for W in R2_WINS:
            rs, co, _, _ = self.ring_detail(i, W)
            vals += [np.log1p(rs), np.log1p(co)]
        return np.array(vals, np.float32)


def agg_matrix(SYS: np.ndarray, fields: list[dict], mu: np.ndarray, sd: np.ndarray) -> np.ndarray:
    """All Model 1 rows at once (each claim against the claims before it), bit-identical to Stream.agg_row for every i:
    the same standardization, the same last-CAPS[r] earlier neighbours in arrival order, the same rata_tetangga and DEG_LOG."""
    n = len(fields)
    S32 = np.asarray(SYS, dtype=np.float32)
    XS = np.clip(np.nan_to_num((S32 - mu) / sd, nan=0.0), -10, 10).astype(np.float32)
    parts, degs = [S32], []
    for r, cap in CAPS.items():
        last: dict[Any, deque] = defaultdict(deque)
        M = np.zeros((n, XS.shape[1]), np.float32)
        k = np.zeros(n, np.int64)
        for i, fd in enumerate(fields):
            key = Stream.keys(fd)[r]
            if key in (None, "", "|"):
                continue
            q = last[key]
            if q:
                M[i] = rata_tetangga(XS[list(q)])
                k[i] = len(q)
            q.append(i)
            if len(q) > cap:
                q.popleft()
        parts.append(M)
        degs.append(DEG_LOG[k][:, None])
    return np.hstack(parts + degs)


def feature_names(sys_names: list[str]) -> list[str]:
    names = list(sys_names)
    for r in CAPS:
        names += [f"tetangga {RELASI_NAMA[r]}: {n}" for n in sys_names]
    names += [f"jumlah tetangga {RELASI_NAMA[r]} (log)" for r in CAPS]
    return names


def vime_names(ssl_model: Any, n: int) -> list[str]:
    for attr in ("cols", "columns", "names", "out_cols"):
        v = getattr(ssl_model.prep, attr, None)
        if v is not None and len(v) == n:
            return [f"klaim: {x}" for x in v]
    return [f"klaim (VIME) #{i}" for i in range(n)]
