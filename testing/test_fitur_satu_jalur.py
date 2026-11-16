"""Step 1 of the v3 repair (the user, 2026-11-12: "oke kerjakan"): training and serving compute Model 1's features through ONE
path. fitur.agg_matrix (all claims at once, the training stream) must be bit-identical to fitur.Stream.agg_row (one claim at
a time: the /testing service, data v2, the tests, generator 2): max |diff| == 0 on every row and column.

Two checks, each also run against the OLD code (kept below, verbatim), to show the check catches the skew it guards against:
  sintetis    random claims with near-constant one-hot columns (the kind Model 1 split on);
  data nyata  the first generator 2 chunk (.tmp/gen2/hasil_00.npz: its system rows and claim fields) with model_v3's
              standardization, skipped if the file is missing.
Run: .venv/Scripts/python.exe testing/test_fitur_satu_jalur.py   (or pytest testing/test_fitur_satu_jalur.py)"""
from __future__ import annotations

import sys
from collections import defaultdict, deque
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import fitur as FT  # noqa: E402


# ---- the code before 2026-11-12, verbatim, for the "would the check have caught it" half
def _lama_agg_row(st: FT.Stream, i: int) -> np.ndarray:
    nb = st.neighbours(i)
    parts, degs = [st.SYS[i]], []
    for r in FT.CAPS:
        ids = nb[r]
        parts.append(np.mean([st.XS[j] for j in ids], axis=0).astype(np.float32) if ids else np.zeros_like(st.XS[i]))
        degs.append(np.float32(np.log1p(len(ids))))
    return np.concatenate(parts + [np.array(degs, np.float32)])


def _lama_agg_matrix(SYS, fields, mu, sd) -> np.ndarray:
    import scipy.sparse as sp

    n = len(fields)
    XS = np.clip(np.nan_to_num((SYS - mu) / sd, nan=0.0), -10, 10).astype(np.float32)
    parts, degs = [SYS.astype(np.float32)], []
    for r, cap in FT.CAPS.items():
        last: dict = defaultdict(deque)
        src, dst = [], []
        for i, fd in enumerate(fields):
            k = FT.Stream.keys(fd)[r]
            if k in (None, "", "|"):
                continue
            q = last[k]
            for j in q:
                src.append(j); dst.append(i)
            q.append(i)
            if len(q) > cap:
                q.popleft()
        src, dst = np.array(src, np.int64), np.array(dst, np.int64)
        deg = np.bincount(dst, minlength=n).astype(np.float32)
        A = sp.csr_matrix((1.0 / np.maximum(deg[dst], 1.0), (dst, src)), shape=(n, n))
        parts.append(np.asarray(A @ XS, np.float32))
        degs.append(np.log1p(deg)[:, None].astype(np.float32))
    return np.hstack(parts + degs)


# ---- helpers
def _kedua_jalur(SYS, fields, mu, sd, lama: bool = False) -> tuple[np.ndarray, np.ndarray]:
    st = FT.Stream(SYS, fields, mu, sd)
    if lama:
        return _lama_agg_matrix(SYS, fields, mu, sd), np.vstack([_lama_agg_row(st, i) for i in range(len(fields))])
    return FT.agg_matrix(SYS, fields, mu, sd), np.vstack([st.agg_row(i) for i in range(len(fields))])


def _beda(a: np.ndarray, b: np.ndarray) -> dict:
    d = np.abs(a.astype(np.float64) - b.astype(np.float64))
    return {"maks": float(d.max()), "sel_beda": int((d > 0).sum()), "kolom_beda": int((d > 0).any(0).sum()), "baris": int(a.shape[0])}


def _data_sintetis(n: int = 4000, seed: int = 7):
    rng = np.random.default_rng(seed)
    d = 124
    SYS = rng.normal(size=(n, d)).astype(np.float32)
    for j in range(0, 40):  # near-constant one-hot columns: mostly 0, a few 1 (jenis_fkrtl=..., keparahan=..., rule signals)
        SYS[:, j] = (rng.random(n) < (0.002 if j % 3 else 0.05)).astype(np.float32)
    SYS[:, 40:50] = np.round(SYS[:, 40:50] * 4) / 4  # a few discrete values
    days = np.sort(rng.integers(19700, 19760, n))
    fields = [{"peserta": int(rng.integers(0, 600)), "faskes": f"RS{int(rng.integers(0, 25))}", "kode": f"K{int(rng.integers(0, 70))}",
               "day": int(days[i]), "ritl": float(rng.random() < 0.2)} for i in range(n)]
    S64 = SYS.astype(np.float64)
    mu, sd = S64.mean(0), np.where(S64.std(0) > 0, S64.std(0), 1.0)
    return SYS, fields, mu, sd


def _data_nyata():
    import joblib

    f = ROOT / ".tmp" / "gen2" / "hasil_00.npz"
    if not f.exists():
        return None
    b = joblib.load(HERE / "model_v3" / "model.joblib")
    n_sys = len(b["sys_names"])
    z = np.load(f, allow_pickle=False)
    SYS = z["X1"][:, :n_sys].astype(np.float32)
    fields = [{"peserta": p, "faskes": fk, "kode": k, "day": int(np.datetime64(t[:10], "D").astype(int)), "ritl": 0.0}
              for p, fk, k, t in zip(z["peserta"].astype(str), z["faskes"].astype(str), z["kode"].astype(str), z["tgl"].astype(str))]
    return SYS, fields, np.asarray(b["mu"]), np.asarray(b["sd"])


# ---- the checks
def test_sintetis_identik():
    SYS, fields, mu, sd = _data_sintetis()
    a, r = _kedua_jalur(SYS, fields, mu, sd)
    assert a.dtype == r.dtype == np.float32
    assert np.array_equal(a, r), f"batch and per-claim rows differ: {_beda(a, r)}"


def test_data_nyata_identik():
    d = _data_nyata()
    if d is None:
        return
    a, r = _kedua_jalur(*d)
    assert np.array_equal(a, r), f"batch and per-claim rows differ: {_beda(a, r)}"


def main() -> int:
    gagal = 0
    for nama, buat in (("sintetis", _data_sintetis), ("data nyata (generator 2, chunk 0)", _data_nyata)):
        d = buat()
        if d is None:
            print(f"{nama}: skipped (no data)")
            continue
        baru_a, baru_r = _kedua_jalur(*d)
        lama_a, lama_r = _kedua_jalur(*d, lama=True)
        ok = np.array_equal(baru_a, baru_r)
        gagal += not ok
        print(f"{nama}: {len(d[1])} claims × {baru_a.shape[1]} features")
        print(f"  new code, batch vs per claim: {'IDENTICAL' if ok else 'DIFFERENT'} {_beda(baru_a, baru_r)}")
        print(f"  old code, batch vs per claim: {_beda(lama_a, lama_r)}   (the skew the check guards against)")
        print(f"  new vs old per-claim values:  {_beda(baru_r, lama_r)}   (how far served features move)")
    print("PASS" if not gagal else "FAIL")
    return 1 if gagal else 0


if __name__ == "__main__":
    sys.exit(main())
