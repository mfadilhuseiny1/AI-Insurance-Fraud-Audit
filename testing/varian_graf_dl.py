"""v4 variants A, B, (C), D, E, F with ONE evaluation path (testing/kriteria_v4.json, written before any v4 variant was trained).

  A  LightGBM (v3 Model 1 parameters) on X1: the claim's 124 own features + the mean of its earlier neighbours over 4 relations
     (same member, same hospital, same hospital + INA-CBG code, same code) + 4 log-degrees (testing/fitur.py)
  B  A + X4 (22 mechanism features, testing/fitur_v4.py)
  C  B + hospital x period features (testing/fitur_rs_v4.py, written by another session; added only when that file exists and
     its own equality test passes)
  D  GNN on the causal claim graph: GraphSAGE (mean over the union of the 4 relations) and R-GCN (a weight matrix per relation);
     node attributes = own 124 + X4 + 4 log-degrees, NOT the neighbour means (the GNN learns the aggregation)
  E  hybrid: B + the GNN's out-of-fold outputs (fraud logit + scheme probabilities; never from a model that saw the node's label)
  F  tabular deep learning on B's features: an MLP and a small FT-Transformer

Data (kriteria_v4.json): training = the labelled replay stream (.tmp/v2_stream_satu_jalur.npz, X4 from .tmp/data_v4/stream_x4.npz)
+ data_v4 chunks 0-7; validation = chunks 8-9, the only place anything is chosen. Each chunk was judged in its own copy of the
world after the whole stream, so the graph of chunk c = the stream followed by chunk c. Because every edge runs from an earlier
claim to a later one, a stream claim's GNN state does not depend on any chunk, so one union graph (stream once + every chunk,
chunk c's claims linked to the stream and to the earlier claims of chunk c only) is exactly the set of per-chunk graphs, and each
label is counted once. No test set is read. Synthetic data only.

Heavy runs take .tmp/BERAT.lock (one heavy job at a time on the shared machine).

Usage: .venv/Scripts/python.exe testing/varian_graf_dl.py uji                     (light: unit tests on data_v2_bersih slices)
       .venv/Scripts/python.exe testing/varian_graf_dl.py jalankan --varian A,B   (heavy, under the lock)
       .venv/Scripts/python.exe testing/varian_graf_dl.py ringkas                 (bootstrap CI, comparison, selection -> json)"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import deque
from contextlib import contextmanager
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TMP = ROOT / ".tmp"
STREAM = TMP / "v2_stream_satu_jalur.npz"
DV4 = TMP / "data_v4"
STREAM_X4 = DV4 / "stream_x4.npz"
DV2B = TMP / "data_v2_bersih"
KERJA = TMP / "varian_graf_dl"
HASIL = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "varian_v4_graf_dl.json"
LOCK = TMP / "BERAT.lock"
LOCK_NAMA = "graph-dl-subagen"

NORMAL = ("normal", "aug:normal")
LATIH_CHUNK, VALIDASI = tuple(range(8)), (8, 9)
ES_CHUNK, ES_STREAM_FRAKSI = 7, 0.10  # early-stopping split of the TRAINING rows: chunk 7 + the last 10 % of the stream
N_FOLD = 4                            # out-of-fold folds for E: stream time blocks, chunk c -> c % 4
SEEDS = (0, 1, 2)
REL = ("peserta", "faskes", "faskes_kode", "kode")
CAPS = {"peserta": 10, "faskes": 10, "faskes_kode": 10, "kode": 5}  # = fitur.CAPS
N_SYS = 124
KOLOM_KUNJUNGAN = "klaim: kunjungan_peserta_faskes"
P1 = dict(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=20, subsample=0.8, subsample_freq=1,
          colsample_bytree=0.8, reg_lambda=1.0, verbose=-1)  # = latih_v2.P1 (v3 Model 1)
THREADS = 8
URUTAN = {"A": 0, "B": 1, "C": 2, "E": 3, "D": 4, "F": 5}  # kriteria_v4 "seri": the simpler wins a tie
T0 = time.time()


def say(*a) -> None:
    msg = f"[{(time.time() - T0) / 60:6.1f} min] " + " ".join(str(x) for x in a)
    print(msg, flush=True)
    try:
        KERJA.mkdir(parents=True, exist_ok=True)
        with (KERJA / "log.txt").open("a", encoding="utf-8") as fh:
            fh.write(time.strftime("%H:%M:%S ") + msg + "\n")
    except OSError:
        pass


@contextmanager
def kunci_berat(maks_tunggu: int = 3600):
    """.tmp/BERAT.lock: wait (60 s polls, at most 60 min) while someone else holds it; create it atomically; always remove ours."""
    t0 = time.time()
    while True:
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.time() - t0 > maks_tunggu:
                raise SystemExit(f"BERAT.lock still held after {maks_tunggu // 60} min: {LOCK.read_text('utf-8', 'replace').strip()}")
            try:
                isi = LOCK.read_text("utf-8", "replace").strip()
            except OSError:
                isi = "?"
            say("waiting for BERAT.lock:", isi)
            time.sleep(60)
    tanda = f"{LOCK_NAMA} {time.strftime('%Y-%m-%d %H:%M:%S')}"
    os.write(fd, (tanda + "\n").encode("utf-8")); os.close(fd)
    say("lock taken:", tanda)
    try:
        yield
    finally:
        try:
            if LOCK.read_text("utf-8").strip() == tanda:
                LOCK.unlink()
                say("lock released")
        except OSError:
            pass


# ============================================================ metrics (importable; one path for every variant)

def ambang_fpr(skor_normal: np.ndarray, fpr: float) -> float:
    """The threshold t such that the share of normal claims with score > t is at most `fpr` (flag = score > t)."""
    sn = np.sort(np.asarray(skor_normal, dtype=np.float64))[::-1]
    k = int(np.floor(fpr * len(sn)))
    return float(sn[min(k, len(sn) - 1)])


def presisi_prevalensi(recall: float, fpr: float, p: float) -> float:
    """Precision re-weighted to fraud prevalence p: R*p / (R*p + FPR*(1-p))."""
    den = recall * p + fpr * (1 - p)
    return float(recall * p / den) if den > 0 else 0.0


def recall_pada_fpr(y: np.ndarray, s: np.ndarray, fpr: float) -> tuple[float, float, float]:
    """(recall, actual FPR, threshold) with the threshold set on the normals of the same set."""
    y = np.asarray(y).astype(bool)
    t = ambang_fpr(s[~y], fpr)
    flag = s > t
    return float(flag[y].mean()) if y.any() else 0.0, float(flag[~y].mean()), t


def skema_dasar(sk: str) -> str:
    return sk[4:] if sk.startswith("aug:") else sk


def recall_per_skema(sk: np.ndarray, flag: np.ndarray) -> dict:
    sk = np.asarray(sk).astype(str)
    base = np.array([skema_dasar(x) for x in sk])
    return {x: round(float(flag[base == x].mean()), 4) for x in sorted(set(base)) if x != "normal"}


def ember_jumlah_klaim(n_sebelum: np.ndarray) -> np.ndarray:
    """Buckets of the member's number of earlier claims (the member relation's neighbour count, capped at 10)."""
    return np.select([n_sebelum == 0, n_sebelum == 1, n_sebelum <= 4], ["0", "1", "2-4"], "5+")


def nilai(y: np.ndarray, s: np.ndarray, sk: np.ndarray, pertama: np.ndarray | None = None,
          n_klaim_peserta: np.ndarray | None = None) -> dict:
    """Every reported metric of one score vector on one set. FPR targets 1 % (the review queue) and 0.1 % (automatic hold);
    thresholds set on the normal claims of this set. `pertama` = the claim is the member's first visit to that hospital."""
    from sklearn.metrics import average_precision_score, roc_auc_score

    y = np.asarray(y).astype(int); s = np.asarray(s, dtype=np.float64); sk = np.asarray(sk).astype(str)
    nrm = y == 0
    r1, f1, t1 = recall_pada_fpr(y, s, 0.01)
    r01, f01, t01 = recall_pada_fpr(y, s, 0.001)
    flag1, flag01 = s > t1, s > t01
    out = {"n": int(len(y)), "fraud": int(y.sum()), "normal": int(nrm.sum()),
           "recall_fpr1": round(r1, 4), "fpr1_aktual": round(f1, 5),
           "presisi_fpr1_mentah": round(float(y[flag1].mean()) if flag1.any() else 0.0, 4),
           "presisi_fpr1_prev": {str(p): round(presisi_prevalensi(r1, f1, p), 4) for p in (0.005, 0.02, 0.05)},
           "recall_fpr01": round(r01, 4), "fpr01_aktual": round(f01, 5),
           "presisi_fpr01_prev2": round(presisi_prevalensi(r01, f01, 0.02), 4),
           "presisi_fpr01_mentah": round(float(y[flag01].mean()) if flag01.any() else 0.0, 4),
           "auprc": round(float(average_precision_score(y, s)), 4), "auroc": round(float(roc_auc_score(y, s)), 4),
           "recall_per_skema_fpr1": recall_per_skema(sk[y == 1], flag1[y == 1])}
    if pertama is not None:
        pertama = np.asarray(pertama).astype(bool)
        a, b = nrm & pertama, nrm & ~pertama
        out["fpr1_kunjungan_pertama"] = round(float(flag1[a].mean()), 5) if a.any() else None
        out["fpr1_pasien_lama"] = round(float(flag1[b].mean()), 5) if b.any() else None
        out["n_normal_pertama"], out["n_normal_lama"] = int(a.sum()), int(b.sum())
    if n_klaim_peserta is not None:
        e = ember_jumlah_klaim(np.asarray(n_klaim_peserta))
        out["fpr1_menurut_jumlah_klaim_peserta"] = {k: {"fpr": round(float(flag1[nrm & (e == k)].mean()), 5), "n_normal": int((nrm & (e == k)).sum())}
                                                    for k in ("0", "1", "2-4", "5+") if (nrm & (e == k)).any()}
    return out


def ringkas_seed(per_seed: list[dict]) -> dict:
    """Mean and range over seeds of every numeric metric (nested dicts recursively)."""
    def gabung(vals: list):
        if all(isinstance(v, dict) for v in vals):
            keys = sorted(set().union(*[v.keys() for v in vals]))
            return {k: gabung([v[k] for v in vals if k in v]) for k in keys}
        if all(isinstance(v, (int, float)) and v is not None and not isinstance(v, bool) for v in vals):
            a = np.array(vals, dtype=np.float64)
            return {"rata": round(float(a.mean()), 4), "min": round(float(a.min()), 4), "maks": round(float(a.max()), 4)}
        return vals[0]
    return gabung(per_seed)


def _metrik_cepat(y: np.ndarray, s: np.ndarray) -> tuple[float, float]:
    r1, _, _ = recall_pada_fpr(y, s, 0.01)
    r01, f01, _ = recall_pada_fpr(y, s, 0.001)
    return r1, presisi_prevalensi(r01, f01, 0.02)


def bootstrap_ci(y: np.ndarray, skor_seed: list[np.ndarray], kelompok: np.ndarray, B: int = 1000, seed: int = 0,
                 pembanding: list[np.ndarray] | None = None) -> dict:
    """Member-level bootstrap (members drawn with replacement, all their claims follow; thresholds re-set on each resample's
    normals) of the seed-mean recall at FPR 1 % and the seed-mean precision at FPR 0.1 % at 2 % prevalence; 95 % percentile
    intervals. With `pembanding` (another variant's seed scores), also the paired difference on the same resamples."""
    y = np.asarray(y).astype(int)
    _, inv = np.unique(np.asarray(kelompok).astype(str), return_inverse=True)
    M = inv.max() + 1
    rng = np.random.default_rng(seed)
    rec, pre, drec, dpre = [], [], [], []
    for _ in range(B):
        w = np.bincount(rng.integers(0, M, M), minlength=M)[inv]
        idx = np.repeat(np.arange(len(y)), w)
        yy = y[idx]
        m = np.array([_metrik_cepat(yy, s[idx]) for s in skor_seed]).mean(0)
        rec.append(m[0]); pre.append(m[1])
        if pembanding is not None:
            mb = np.array([_metrik_cepat(yy, s[idx]) for s in pembanding]).mean(0)
            drec.append(m[0] - mb[0]); dpre.append(m[1] - mb[1])
    ci = lambda a: [round(float(np.percentile(a, 2.5)), 4), round(float(np.percentile(a, 97.5)), 4)]  # noqa: E731
    out = {"B": B, "unit": "peserta", "recall_fpr1_ci95": ci(rec), "presisi_fpr01_prev2_ci95": ci(pre)}
    if pembanding is not None:
        out["selisih_recall_fpr1_ci95"] = ci(drec); out["selisih_presisi_fpr01_prev2_ci95"] = ci(dpre)
        out["p_selisih_recall_le_0"] = round(float(np.mean(np.array(drec) <= 0)), 4)
    return out


# ============================================================ data

def _str(a) -> np.ndarray:
    return np.asarray(a).astype(str)


def peta_x4_pasti(sk_cache: np.ndarray, sk_x4: np.ndarray) -> np.ndarray | None:
    """For the sensitivity check only: each cache row's x4 row if it is the same in EVERY subsequence embedding of the cache's
    sk in x4's sk (leftmost == rightmost; every valid embedding lies pointwise between the two, the true one too), else -1."""
    a, b = _str(sk_cache), _str(sk_x4)

    def embed(a, b):
        out = np.empty(len(a), np.int64); j = 0
        for i in range(len(a)):
            while j < len(b) and b[j] != a[i]:
                j += 1
            if j == len(b):
                return None
            out[i] = j; j += 1
        return out
    kiri = embed(a, b)
    if kiri is None:
        return None
    kanan = (len(b) - 1 - embed(a[::-1], b[::-1]))[::-1]
    return np.where(kiri == kanan, kiri, -1)


def selaraskan_x4(sk_cache: np.ndarray, sk_x4: np.ndarray) -> tuple[np.ndarray | None, str]:
    """Row map cache -> stream_x4. Identical sk arrays: identity. Otherwise the cache may be the x4 order minus whole dropped
    rows (latih_v2.stream_fitur drops 30 % of the ring members): accepted only if the leftmost and the rightmost subsequence
    embeddings of the cache's sk in x4's sk coincide (then the embedding is unique, hence the true one). Else None."""
    a, b = _str(sk_cache), _str(sk_x4)
    if len(a) == len(b) and (a == b).all():
        return np.arange(len(a)), "identik (sk sama baris demi baris)"
    if len(a) > len(b):
        return None, f"tidak selaras: cache {len(a)} baris > stream_x4 {len(b)}"

    def embed(a, b):
        out = np.empty(len(a), np.int64); j = 0
        for i in range(len(a)):
            while j < len(b) and b[j] != a[i]:
                j += 1
            if j == len(b):
                return None
            out[i] = j; j += 1
        return out
    kiri = embed(a, b)
    if kiri is None:
        return None, "tidak selaras: sk cache bukan subbarisan sk stream_x4"
    kanan = embed(a[::-1], b[::-1])
    kanan = (len(b) - 1 - kanan)[::-1]
    lompat = np.setdiff1d(np.arange(len(b)), kiri)
    jenis = sorted(set(b[lompat].tolist()))
    if (kiri == kanan).all():
        return kiri, f"selaras sebagai subbarisan unik: {len(lompat)} baris stream_x4 tanpa pasangan (sk {jenis})"
    return None, f"tidak selaras: {int((kiri != kanan).sum())} baris cache punya lebih dari satu kemungkinan pasangan (lompat {len(lompat)}, sk {jenis})"


def muat_data(uji: bool = False) -> dict:
    """The union of the stream and the chunks, with masks. uji=True: small slices of data_v2_bersih (no X4) for the unit tests."""
    S = np.load(STREAM, allow_pickle=False)
    ns = 5000 if uji else len(S["sk"])
    seg = {"X1": S["X1"][:ns], "sk": _str(S["sk"][:ns]), "peserta": _str(S["peserta"][:ns]), "faskes": _str(S["faskes"][:ns]),
           "kode": _str(S["kode"][:ns])}
    info: dict = {"stream_baris": int(ns)}
    x4s = np.full((ns, 22), np.nan, np.float32)
    D_alt = None
    if uji:
        x4s[:] = 0.0
        info["x4_stream"] = "uji: X4 = 0"
    elif STREAM_X4.exists():
        Z = np.load(STREAM_X4, allow_pickle=False)
        peta, ket = selaraskan_x4(seg["sk"], Z["sk"])
        info["x4_stream"] = ket + ("" if peta is not None else " -> X4 TIDAK dipakai untuk baris stream (NaN), sesuai instruksi")
        if peta is not None:
            x4s = Z["X4"][peta].astype(np.float32)
        else:  # kept aside for the sensitivity check B_x4stream only
            pp = peta_x4_pasti(seg["sk"], Z["sk"])
            if pp is not None:
                alt = np.full((ns, 22), np.nan, np.float32)
                alt[pp >= 0] = Z["X4"][pp[pp >= 0]]
                info["x4_stream_pasti"] = f"{int((pp >= 0).sum())}/{ns} baris stream punya pasangan pasti (hanya untuk cek sensitivitas B_x4stream)"
                D_alt = alt
        say("stream X4:", info["x4_stream"])
    else:
        info["x4_stream"] = "stream_x4.npz belum ada: X4 stream kosong (NaN)"
    seg["X4"] = x4s
    parts = [dict(seg, chunk=np.full(ns, -1), pos=np.arange(ns))]
    chunks = (0, 1, 7, 8, 9) if uji else tuple(range(10))
    for c in chunks:
        p = (DV2B if uji else DV4) / f"fitur_{c:02d}.npz"
        d = np.load(p, allow_pickle=False)
        n = 300 if uji else len(d["sk"])
        x4 = np.zeros((n, 22), np.float32) if uji else d["X4"][:n].astype(np.float32)
        parts.append({"X1": d["X1"][:n], "sk": _str(d["sk"][:n]), "peserta": _str(d["peserta"][:n]), "faskes": _str(d["faskes"][:n]),
                      "kode": _str(d["kode"][:n]), "X4": x4, "chunk": np.full(n, c), "pos": np.arange(n)})
    D = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    D["Ns"] = ns
    if D_alt is not None:
        D["X4_alt"] = np.vstack([D_alt, D["X4"][ns:]])
    D["y"] = (~np.isin(D["sk"], NORMAL)).astype(int)
    st = D["chunk"] == -1
    D["latih"] = st | np.isin(D["chunk"], LATIH_CHUNK)
    D["val"] = np.isin(D["chunk"], VALIDASI)
    D["es"] = (D["chunk"] == ES_CHUNK) | (st & (D["pos"] >= (1 - ES_STREAM_FRAKSI) * ns))
    fold = np.full(len(st), -1)
    fold[st] = np.minimum(D["pos"][st] * N_FOLD // ns, N_FOLD - 1)
    ch = np.isin(D["chunk"], LATIH_CHUNK)
    fold[ch] = D["chunk"][ch] % N_FOLD
    D["fold"] = fold
    D["x4_ada"] = ~np.isnan(D["X4"]).any(1)
    D["info"] = info
    import joblib

    b = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    names = list(b["sys_names"])
    D["sys_names"] = names
    D["mu"], D["sd"] = np.asarray(b["mu"], np.float32), np.asarray(b["sd"], np.float32)
    j = names.index(KOLOM_KUNJUNGAN)
    col = D["X1"][:, j]
    D["pertama"] = col <= col.min() + 1e-6
    info["kolom_kunjungan_pertama"] = {"nama": KOLOM_KUNJUNGAN, "indeks": j, "nilai_min": float(col.min())}
    return D


def kunci(D: dict) -> dict[str, list]:
    """The relation keys as fitur.Stream.keys, None where the key is missing (as fitur skips None, '' and '|')."""
    bad = {"", "None", "nan"}
    ps = [None if x in bad else x for x in D["peserta"].tolist()]
    fs = [None if x in bad else x for x in D["faskes"].tolist()]
    ks = [None if x in bad else x for x in D["kode"].tolist()]
    fk = [None if (f is None and k is None) else f"{f or ''}|{k or ''}" for f, k in zip(fs, ks)]
    return {"peserta": ps, "faskes": fs, "faskes_kode": fk, "kode": ks}


def bangun_tepi(D: dict) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Causal edges (dst, src) per relation: each claim <- the last CAPS[r] earlier claims with the same key, as
    fitur.Stream.neighbours. Stream claims see earlier stream claims; chunk c's claims see the stream and the earlier claims of
    chunk c (each chunk is its own copy of the world after the stream)."""
    K = kunci(D)
    ns = D["Ns"]
    chunk = D["chunk"]
    urut_chunk = [c for c in dict.fromkeys(chunk[ns:].tolist())]
    out = {}
    for r in REL:
        cap, kr = CAPS[r], K[r]
        src: list[int] = []; dst: list[int] = []
        last: dict = {}
        for i in range(ns):
            k = kr[i]
            if k is None:
                continue
            q = last.get(k)
            if q is None:
                q = last[k] = deque(maxlen=cap)
            for j in q:
                src.append(j); dst.append(i)
            q.append(i)
        for c in urut_chunk:
            loc: dict = {}
            for i in np.where(chunk == c)[0].tolist():
                k = kr[i]
                if k is None:
                    continue
                q = loc.get(k)
                if q is None:
                    q = loc[k] = deque(last.get(k, ()), maxlen=cap)
                for j in q:
                    src.append(j); dst.append(i)
                q.append(i)
        out[r] = (np.array(dst, np.int64), np.array(src, np.int64))
    return out


def derajat(D: dict, E: dict) -> np.ndarray:
    N = len(D["sk"])
    return np.column_stack([np.bincount(E[r][0], minlength=N) for r in REL])


def adj_mean(N: int, dst: np.ndarray, src: np.ndarray):
    """Row-normalised (mean) adjacency, scipy CSR float64."""
    import scipy.sparse as sp

    A = sp.csr_matrix((np.ones(len(dst)), (dst, src)), shape=(N, N))
    A.sum_duplicates()
    deg = np.asarray(A.sum(1)).ravel()
    return sp.diags(np.where(deg > 0, 1.0 / np.maximum(deg, 1), 0.0)) @ A


def xs_sendiri(D: dict) -> np.ndarray:
    """The own 124 features standardised exactly as fitur.Stream._std (float32)."""
    S32 = np.asarray(D["X1"][:, :N_SYS], dtype=np.float32)
    return np.clip(np.nan_to_num((S32 - D["mu"]) / D["sd"], nan=0.0), -10, 10).astype(np.float32)


def fitur_node(D: dict, E: dict) -> tuple[np.ndarray, list[str]]:
    """GNN node attributes: own 124 (standardised) + X4 (standardised on training rows, missing -> 0, plus an indicator if any
    is missing) + the 4 log-degrees. No neighbour means."""
    x4 = D["X4"].astype(np.float64)
    tr = D["latih"] & D["x4_ada"]
    m, s = np.nanmean(x4[tr], 0), np.nanstd(x4[tr], 0)
    x4z = np.clip(np.nan_to_num((x4 - m) / np.where(s > 0, s, 1.0), nan=0.0), -10, 10)
    deg = np.log1p(derajat(D, E)).astype(np.float32)
    parts = [xs_sendiri(D), x4z.astype(np.float32), deg]
    names = [f"sendiri:{n}" for n in D["sys_names"]] + [f"x4:{i}" for i in range(22)] + [f"logderajat:{r}" for r in REL]
    if not D["x4_ada"].all():
        parts.append(D["x4_ada"].astype(np.float32)[:, None]); names.append("x4_ada")
    return np.hstack(parts).astype(np.float32), names


def masukan_gnn(jenis: str, X: np.ndarray, E: dict):
    """Layer-1 input [x, A_1 x, ..., A_R x] (precomputed, float64 sums) and the layer-2 operator (torch sparse CSR, (R*N, N))."""
    import scipy.sparse as sp
    import torch

    N = len(X)
    if jenis == "sage":
        dst = np.concatenate([E[r][0] for r in REL]); src = np.concatenate([E[r][1] for r in REL])
        key = np.unique(dst * N + src)  # the union of the relations, each neighbour once
        As = [adj_mean(N, key // N, key % N)]
    else:
        As = [adj_mean(N, *E[r]) for r in REL]
    X64 = X.astype(np.float64)
    Z1 = np.hstack([X] + [(A @ X64).astype(np.float32) for A in As])
    St = sp.vstack(As).tocsr().astype(np.float32)
    At = torch.sparse_csr_tensor(torch.from_numpy(St.indptr.astype(np.int64)), torch.from_numpy(St.indices.astype(np.int64)),
                                 torch.from_numpy(St.data), size=St.shape)
    import varian_graf_dl_model as VM

    return Z1, VM.operator_ke_dev(At), len(As)


def kelas_skema(D: dict, min_contoh: int = 30) -> tuple[np.ndarray, list[str]]:
    """Classes of the auxiliary head: normal, every base scheme with >= min_contoh training claims, 'lain' (other fraud)."""
    base = np.array([skema_dasar(x) for x in D["sk"]])
    tr = D["latih"] & (D["y"] == 1)
    u, n = np.unique(base[tr], return_counts=True)
    nama = ["normal"] + sorted(u[n >= min_contoh].tolist()) + ["lain"]
    idx = {k: i for i, k in enumerate(nama)}
    cls = np.array([0 if y == 0 else idx.get(b, len(nama) - 1) for b, y in zip(base, D["y"])])
    return cls, nama


def fitur_B(D: dict) -> np.ndarray:
    return np.hstack([D["X1"], D["X4"]]).astype(np.float32)


# ============================================================ variants

def _lgb(X: np.ndarray, D: dict, seed: int) -> np.ndarray:
    import lightgbm as lgb

    m = lgb.LGBMClassifier(**P1, n_jobs=THREADS, random_state=seed).fit(X[D["latih"]], D["y"][D["latih"]])
    return m.predict_proba(X[D["val"]])[:, 1]


def _nilai_val(D: dict, s: np.ndarray) -> dict:
    v = D["val"]
    return nilai(D["y"][v], s, D["sk"][v], D["pertama"][v], D["n_peserta"][v])


def varian_lgb(nama: str, X: np.ndarray, D: dict, seeds=SEEDS) -> tuple[dict, list[np.ndarray]]:
    per, skor, t0 = [], [], time.time()
    for sd in seeds:
        t = time.time()
        s = _lgb(X, D, sd)
        per.append(_nilai_val(D, s)); skor.append(s)
        say(f"  {nama} seed {sd}: recall@1% {per[-1]['recall_fpr1']:.4f} prec@0.1%/2% {per[-1]['presisi_fpr01_prev2']:.4f} "
            f"AUPRC {per[-1]['auprc']:.4f} ({time.time() - t:.0f}s)")
    return {"per_seed": per, "ringkas": ringkas_seed(per), "detik": round(time.time() - t0, 1), "kolom": int(X.shape[1])}, skor


def varian_gnn(jenis: str, D: dict, E: dict, seeds=SEEDS, max_ep: int = 300, patience: int = 40) -> tuple[dict, list[np.ndarray], dict]:
    import varian_graf_dl_model as VM

    t0 = time.time()
    X, _ = fitur_node(D, E)
    Z1, At, R = masukan_gnn(jenis, X, E)
    cls, kn = kelas_skema(D)
    say(f"  D_{jenis}: nodes {len(X)}, attributes {X.shape[1]}, layer-1 input {Z1.shape[1]}, operator nnz {At._nnz()}, classes {len(kn)}, "
        f"device {VM.DEV}")
    per, skor, ep_terbaik, info = [], [], {}, {}
    for sd in seeds:
        t = time.time()
        _, ep, inf = VM.latih_gnn(Z1, At, R, D["y"], cls, len(kn), D["latih"] & ~D["es"], D["es"], sd, max_ep=max_ep, patience=patience, log=say)
        say(f"  D_{jenis} seed {sd}: early stop at epoch {ep} (training split criterion {inf['es_terbaik']}), refit on all training rows")
        model, _, inf2 = VM.latih_gnn(Z1, At, R, D["y"], cls, len(kn), D["latih"], None, sd, epochs=ep)
        s = VM.prediksi_gnn(model, Z1, At)[0][D["val"]]
        VM.simpan_model(model, KERJA / f"model_D_{jenis}_s{sd}.pt", {"kelas": "GNN", "f_in": int(X.shape[1]), "h": 64, "R": int(R),
                                                                    "n_cls": len(kn), "kelas_bantu": kn, "epoch": int(ep)})
        per.append(_nilai_val(D, s)); skor.append(s); ep_terbaik[sd] = ep
        info[sd] = {"epoch_es": ep, "es_terbaik": inf["es_terbaik"], "detik_es": inf["detik"], "detik_refit": inf2["detik"]}
        say(f"  D_{jenis} seed {sd}: recall@1% {per[-1]['recall_fpr1']:.4f} prec@0.1%/2% {per[-1]['presisi_fpr01_prev2']:.4f} "
            f"AUPRC {per[-1]['auprc']:.4f} ({time.time() - t:.0f}s)")
    return ({"per_seed": per, "ringkas": ringkas_seed(per), "detik": round(time.time() - t0, 1), "latih": info,
             "konfig": {"lapisan": 2, "h": 64, "agregasi": "mean" + (" (gabungan 4 relasi)" if jenis == "sage" else " per relasi"),
                        "atribut_node": int(X.shape[1]), "kelas_bantu": kn, "bobot_bantu": VM.AUX_W, "pos_weight": VM.POS_WEIGHT,
                        "es": f"chunk {ES_CHUNK} + {int(ES_STREAM_FRAKSI * 100)}% stream terakhir (data latih), refit pada semua data latih"}},
            skor, ep_terbaik)


def oof_gnn(jenis: str, D: dict, E: dict, sd: int, ep: int) -> np.ndarray:
    """Out-of-fold GNN outputs [logit, scheme probabilities]: training node in fold k <- the model trained without fold k's
    labels; validation nodes <- the mean of the N_FOLD models (none saw a validation label)."""
    import varian_graf_dl_model as VM

    X, _ = fitur_node(D, E)
    Z1, At, R = masukan_gnn(jenis, X, E)
    cls, kn = kelas_skema(D)
    F = np.zeros((len(X), 1 + len(kn)), np.float32)
    for k in range(N_FOLD):
        t = time.time()
        fit = D["latih"] & (D["fold"] != k)
        model, _, _ = VM.latih_gnn(Z1, At, R, D["y"], cls, len(kn), fit, None, sd, epochs=ep)
        o, p = VM.prediksi_gnn(model, Z1, At)
        Fk = np.column_stack([o, p])
        te = D["fold"] == k
        F[te] = Fk[te]
        F[D["val"]] += Fk[D["val"]] / N_FOLD
        say(f"    E_{jenis} seed {sd} fold {k}: {ep} epochs ({time.time() - t:.0f}s)")
    return F


def varian_E(jenis: str, D: dict, E: dict, ep_terbaik: dict, seeds=SEEDS) -> tuple[dict, list[np.ndarray]]:
    XB = fitur_B(D)
    per, skor, t0 = [], [], time.time()
    for sd in seeds:
        t = time.time()
        F = oof_gnn(jenis, D, E, sd, ep_terbaik[sd])
        s = _lgb(np.hstack([XB, F]), D, sd)
        per.append(_nilai_val(D, s)); skor.append(s)
        say(f"  E_{jenis} seed {sd}: recall@1% {per[-1]['recall_fpr1']:.4f} prec@0.1%/2% {per[-1]['presisi_fpr01_prev2']:.4f} "
            f"AUPRC {per[-1]['auprc']:.4f} ({time.time() - t:.0f}s)")
    return {"per_seed": per, "ringkas": ringkas_seed(per), "detik": round(time.time() - t0, 1), "kolom": int(XB.shape[1] + F.shape[1]),
            "konfig": {"gnn": jenis, "fitur_gnn": "logit fraud + peluang kelas skema, out-of-fold (4 fold: blok waktu stream, chunk % 4); "
                       "validasi = rata-rata 4 model fold", "epoch_per_seed": {str(k): int(v) for k, v in ep_terbaik.items()}}}, skor


def siapkan_tabel(D: dict) -> tuple[np.ndarray, list[int], list[list[int]]]:
    """B's features quantile-transformed (fitted on training rows) to a normal shape; missing -> 0 (+ indicator)."""
    from sklearn.preprocessing import QuantileTransformer

    X = fitur_B(D).astype(np.float64)
    qt = QuantileTransformer(n_quantiles=1000, output_distribution="normal", subsample=200_000, random_state=0)
    qt.fit(X[D["latih"]])
    Z = np.nan_to_num(qt.transform(X), nan=0.0).astype(np.float32)
    skalar = list(range(N_SYS)) + list(range(5 * N_SYS, 5 * N_SYS + 4)) + list(range(624, 646))
    blok = [list(range(N_SYS * (1 + i), N_SYS * (2 + i))) for i in range(4)]
    if not D["x4_ada"].all():
        Z = np.hstack([Z, D["x4_ada"].astype(np.float32)[:, None]]); skalar.append(Z.shape[1] - 1)
    return Z, skalar, blok


def varian_F(jenis: str, D: dict, seeds=SEEDS, max_ep: int | None = None) -> tuple[dict, list[np.ndarray]]:
    import varian_graf_dl_model as VM

    t0 = time.time()
    Z, skalar, blok = siapkan_tabel(D)
    if jenis == "mlp":
        buat = lambda: VM.MLP(Z.shape[1])  # noqa: E731
        kw = dict(max_ep=max_ep or 40, patience=6, batch=512, lr=1e-3, frac_normal=1.0)
    else:
        buat = lambda: VM.FTTransformer(skalar, blok)  # noqa: E731
        kw = dict(max_ep=max_ep or 15, patience=3, batch=512, lr=1e-3, frac_normal=0.25)
    per, skor, info = [], [], {}
    for sd in seeds:
        t = time.time()
        _, ep, inf = VM.latih_tabel(buat, Z, D["y"], D["latih"] & ~D["es"], D["es"], sd, log=say, **kw)
        kw2 = {k: v for k, v in kw.items() if k not in ("max_ep", "patience")}
        model, _, inf2 = VM.latih_tabel(buat, Z, D["y"], D["latih"], None, sd, epochs=ep, **kw2)
        s = VM.prediksi_tabel(model, Z[D["val"]])
        VM.simpan_model(model, KERJA / f"model_F_{jenis}_s{sd}.pt", {"kelas": "MLP" if jenis == "mlp" else "FTTransformer", "f_in": int(Z.shape[1]),
                                                                    "skalar": skalar, "blok": blok, "epoch": int(ep)})
        per.append(_nilai_val(D, s)); skor.append(s)
        info[sd] = {"epoch_es": ep, "es_terbaik": inf["es_terbaik"], "detik_es": inf["detik"], "detik_refit": inf2["detik"]}
        say(f"  F_{jenis} seed {sd}: epoch {ep}, recall@1% {per[-1]['recall_fpr1']:.4f} prec@0.1%/2% {per[-1]['presisi_fpr01_prev2']:.4f} "
            f"AUPRC {per[-1]['auprc']:.4f} ({time.time() - t:.0f}s)")
    return {"per_seed": per, "ringkas": ringkas_seed(per), "detik": round(time.time() - t0, 1), "latih": info,
            "konfig": {**{k: v for k, v in kw.items()}, "masukan": "fitur B (X1 + X4), quantile -> normal (fit pada data latih)",
                       "perangkat": str(VM.DEV), "arsitektur": "MLP 512-256 BN ReLU dropout 0.2" if jenis == "mlp" else
                       "FT-Transformer token per fitur skalar (own 124 + 4 derajat + X4 22) + 4 token blok rata-rata tetangga, d 32, 2 lapis, 4 head",
                       "es": f"chunk {ES_CHUNK} + {int(ES_STREAM_FRAKSI * 100)}% stream terakhir (data latih), refit pada semua data latih"}}, skor


def fitur_C(D: dict) -> tuple[np.ndarray, list[str]] | None:
    """Hospital x period features from testing/fitur_rs_v4.py (another session's file; planned interface
    matriks_rs(stream: dict, chunk: dict | None) -> rows of that chunk, or of the stream when called with the stream alone;
    NAMES_RS; the dicts are the npz contents). The module's own tests (functions named test_* / uji*) run first and must pass.
    Rows aligned with D (stream cache rows, then chunks 0..9). None if the file is absent."""
    import inspect

    p = HERE / "fitur_rs_v4.py"
    if not p.exists():
        return None
    import fitur_rs_v4 as RS

    # the module's own tests live in testing/test_fitur_rs_v4.py; they must pass before C is used
    import test_fitur_rs_v4 as TRS

    tes = [n for n in dir(TRS) if n.startswith("test_") and callable(getattr(TRS, n))]
    if not tes:
        raise RuntimeError("test_fitur_rs_v4 has no test_* function: C is not run")
    for n in tes:
        getattr(TRS, n)()  # raises on failure
    say(f"  test_fitur_rs_v4: {len(tes)} tests passed")
    S = RS.muat_stream()  # the stream cache with its X4 (row-aligned by the module)
    rows = [np.asarray(RS.matriks_rs(S), dtype=np.float32)]
    rows += [np.asarray(x, dtype=np.float32) for x in RS.matriks_rs_chunks(S, [dict(np.load(DV4 / f"fitur_{c:02d}.npz", allow_pickle=False)) for c in range(10)])]
    M = np.vstack(rows)
    if len(M) != len(D["sk"]):
        raise RuntimeError(f"fitur_rs_v4 rows {len(M)} != data rows {len(D['sk'])}")
    return M, list(RS.NAMES_RS)


# ============================================================ results

def simpan_varian(nama: str, isi: dict, skor: list[np.ndarray], D: dict) -> None:
    KERJA.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(KERJA / f"skor_{nama}.npz", skor=np.vstack(skor))
    H = json.loads(HASIL.read_text("utf-8")) if HASIL.exists() else {}
    H.setdefault("varian", {})[nama] = isi
    H["data"] = data_info(D)
    HASIL.parent.mkdir(parents=True, exist_ok=True)
    HASIL.write_text(json.dumps(H, indent=1, ensure_ascii=False), "utf-8")
    say("saved", nama, "->", HASIL)


def data_info(D: dict) -> dict:
    tr, v = D["latih"], D["val"]
    E = D.get("_E")
    out = {"latih": {"baris": int(tr.sum()), "fraud": int(D["y"][tr].sum()), "stream": int(D["Ns"]), "chunk": list(LATIH_CHUNK)},
           "validasi": {"baris": int(v.sum()), "fraud": int(D["y"][v].sum()), "normal": int((v & (D["y"] == 0)).sum()), "chunk": list(VALIDASI),
                        "peserta": int(len(np.unique(D["peserta"][v])))},
           "es_split": {"baris": int(D["es"].sum()), "fraud": int(D["y"][D["es"]].sum())}, **D["info"]}
    if E is not None:
        out["graf"] = {"tepi_per_relasi": {r: int(len(E[r][0])) for r in REL}, "simpul": int(len(D["sk"]))}
    if "cek_graf" in D:
        out["cek_graf"] = D["cek_graf"]
    return out


def cek_graf(D: dict, E: dict) -> dict:
    """Do the edges reproduce X1's neighbour means and log-degrees? Exactly expected for the stream rows (the cache was built
    from the same rows); for chunk rows X1 was computed against the chunk's own copy of the stream, which also holds claims the
    stream cache does not (ring members dropped by latih_v2, unlabelled 'uji:' claims), so a share of rows differ."""
    XS = xs_sendiri(D).astype(np.float64)
    N = len(XS)
    deg = derajat(D, E)
    out = {}
    for ri, r in enumerate(REL):
        M = adj_mean(N, *E[r]) @ XS
        ref = D["X1"][:, N_SYS * (1 + ri):N_SYS * (2 + ri)].astype(np.float64)
        dif = np.abs(M - ref).max(1)
        ddeg = np.abs(np.log1p(deg[:, ri]).astype(np.float32) - D["X1"][:, 5 * N_SYS + ri])
        st = D["chunk"] == -1
        out[r] = {"stream_maks_selisih": float(dif[st].max()), "stream_derajat_maks_selisih": float(ddeg[st].max()),
                  "chunk_baris_sama": round(float((dif[~st] < 1e-4).mean()), 4) if (~st).any() else None}
    return out


def siapkan(uji: bool = False) -> tuple[dict, dict]:
    t = time.time()
    D = muat_data(uji)
    E = bangun_tepi(D)
    D["_E"] = E
    D["n_peserta"] = derajat(D, E)[:, 0]
    D["cek_graf"] = cek_graf(D, E)
    say(f"data: {len(D['sk'])} nodes ({D['Ns']} stream), training {int(D['latih'].sum())} (fraud {int(D['y'][D['latih']].sum())}), "
        f"validation {int(D['val'].sum())} (fraud {int(D['y'][D['val']].sum())}), edges {sum(len(E[r][0]) for r in REL)} ({time.time() - t:.0f}s)")
    say("graph check:", json.dumps(D["cek_graf"]))
    return D, E


def jalankan(varian: list[str], e_gnn: list[str], ft_ep: int | None) -> None:
    import torch

    torch.set_num_threads(THREADS)
    D, E = siapkan()
    H = json.loads(HASIL.read_text("utf-8")) if HASIL.exists() else {}
    for v in varian:
        say("variant", v)
        if v == "A":
            isi, skor = varian_lgb("A", D["X1"], D); simpan_varian("A", isi, skor, D)
        elif v == "B":
            isi, skor = varian_lgb("B", fitur_B(D), D); simpan_varian("B", isi, skor, D)
        elif v == "B_x4stream":  # sensitivity only (not a pre-registered variant): X4 on the provably matched stream rows
            if "X4_alt" not in D:
                say("B_x4stream: no alternative X4"); continue
            isi, skor = varian_lgb("B_x4stream", np.hstack([D["X1"], D["X4_alt"]]).astype(np.float32), D)
            isi["catatan"] = "cek sensitivitas, bukan varian pra-registrasi: " + D["info"].get("x4_stream_pasti", "")
            simpan_varian("B_x4stream", isi, skor, D)
        elif v == "C":
            rc = fitur_C(D)
            if rc is None:
                say("C pending: testing/fitur_rs_v4.py does not exist"); continue
            isi, skor = varian_lgb("C", np.hstack([fitur_B(D), rc[0]]), D)
            isi["fitur_rs"] = rc[1]; simpan_varian("C", isi, skor, D)
        elif v in ("D_sage", "D_rgcn"):
            isi, skor, ep = varian_gnn(v[2:], D, E)
            simpan_varian(v, isi, skor, D)
            H = json.loads(HASIL.read_text("utf-8"))
        elif v in ("E_sage", "E_rgcn"):
            H = json.loads(HASIL.read_text("utf-8")) if HASIL.exists() else {}
            dd = H.get("varian", {}).get("D_" + v[2:])
            if not dd:
                say(f"{v}: D_{v[2:]} must run first (epoch counts)"); continue
            ep = {int(k): int(x["epoch_es"]) for k, x in dd["latih"].items()}
            isi, skor = varian_E(v[2:], D, E, ep); simpan_varian(v, isi, skor, D)
        elif v in ("F_mlp", "F_ft"):
            isi, skor = varian_F(v[2:], D, max_ep=ft_ep if v == "F_ft" else None); simpan_varian(v, isi, skor, D)
        else:
            say("unknown variant", v)


# ============================================================ summary, comparison, selection

def ringkas() -> dict:
    """Bootstrap CIs, per-scheme change against B, and the pre-registered selection, from the saved scores and metrics."""
    H = json.loads(HASIL.read_text("utf-8"))
    D = muat_data_val()
    V = H.get("varian", {})
    skor = {v: list(np.load(KERJA / f"skor_{v}.npz")["skor"]) for v in V if (KERJA / f"skor_{v}.npz").exists()}
    for v in V:
        if v in skor:
            V[v]["bootstrap"] = bootstrap_ci(D["y"], skor[v], D["peserta"], pembanding=skor.get("B") if v != "B" else None)
            say("bootstrap", v, V[v]["bootstrap"])
    if "B" in V:
        b = V["B"]["ringkas"]["recall_per_skema_fpr1"]
        for v in V:
            if v == "B":
                continue
            r = V[v]["ringkas"]["recall_per_skema_fpr1"]
            d = {k: round(r[k]["rata"] - b[k]["rata"], 4) for k in r if k in b}
            V[v]["skema_selisih_vs_B"] = dict(sorted(d.items(), key=lambda kv: -abs(kv[1]))[:3])
    resmi = [v for v in V if v[0] in URUTAN and "x4stream" not in v]  # the sensitivity check is not a candidate
    rec = {v: V[v]["ringkas"]["recall_fpr1"]["rata"] for v in resmi}
    pre = {v: V[v]["ringkas"]["presisi_fpr01_prev2"]["rata"] for v in resmi}
    best = max(rec, key=rec.get)
    seri = [v for v in rec if rec[best] - rec[v] < 0.01]
    pilih = min(seri, key=lambda v: (URUTAN[v[0]], -rec[v]))
    H["pemilihan"] = {"aturan": "kriteria_v4.json ukuran_pemilihan: recall pada FPR 1% (rata-rata 3 seed); selisih < 1 poin = seri -> yang lebih sederhana (A < B < C < E < D < F)",
                      "recall_fpr1_rata": rec, "presisi_fpr01_prev2_rata": pre, "tertinggi": best, "seri_dengan_tertinggi": seri, "terpilih": pilih,
                      "kandidat": resmi, "C": "ada" if "C" in V else "tertunda (testing/fitur_rs_v4.py belum ada / belum lulus uji)",
                      "D_E_F": "ditunda (keputusan pengguna)" if not any(v[0] in "DEF" for v in resmi) else "ada"}
    tunda = "ditunda (keputusan pengguna)"
    H["status_varian"] = {"A": "selesai" if "A" in V else "belum", "B": "selesai" if "B" in V else "belum",
                          "C": "selesai" if "C" in V else "tertunda: testing/fitur_rs_v4.py belum ada / belum lulus uji; jalankan nanti: "
                          "varian_graf_dl.py jalankan --varian C lalu ringkas",
                          "D": "selesai" if any(v.startswith("D_") for v in V) else tunda,
                          "E": "selesai" if any(v.startswith("E_") for v in V) else tunda,
                          "F": "selesai" if any(v.startswith("F_") for v in V) else tunda,
                          "B_x4stream": "cek sensitivitas (bukan kandidat): X4 dipakai pada baris stream yang pasangannya pasti"}
    H["dibuat"] = time.strftime("%Y-%m-%d %H:%M")
    H["skrip"] = "testing/varian_graf_dl.py (+ varian_graf_dl_model.py)"
    H["kriteria"] = "testing/kriteria_v4.json (ditulis sebelum varian v4 dilatih)"
    HASIL.write_text(json.dumps(H, indent=1, ensure_ascii=False), "utf-8")
    say("selection:", H["pemilihan"])
    return H


def muat_data_val() -> dict:
    """Validation rows only (the order muat_data produces), for the bootstrap."""
    parts = [np.load(DV4 / f"fitur_{c:02d}.npz", allow_pickle=False) for c in VALIDASI]
    sk = np.concatenate([_str(p["sk"]) for p in parts])
    return {"sk": sk, "y": (~np.isin(sk, NORMAL)).astype(int), "peserta": np.concatenate([_str(p["peserta"]) for p in parts])}


# ============================================================ unit tests (light)

def uji() -> None:
    import torch

    torch.set_num_threads(4)
    # metrics
    rng = np.random.default_rng(0)
    y = np.r_[np.zeros(10000, int), np.ones(500, int)]
    s = np.r_[rng.normal(0, 1, 10000), rng.normal(3, 1, 500)]
    sk = np.where(y == 1, "upcoding", "normal")
    r, f, t = recall_pada_fpr(y, s, 0.01)
    assert f <= 0.01 and abs(f - 0.01) < 0.0002, f
    assert abs(r - (1 - __import__("scipy").stats.norm.cdf(t - 3))) < 0.05, (r, t)
    m = nilai(y, s, sk, rng.random(len(y)) < 0.3, rng.integers(0, 8, len(y)))
    assert m["fpr01_aktual"] <= 0.001 and abs(presisi_prevalensi(0.5, 0.001, 0.02) - 0.01 / (0.01 + 0.00098)) < 1e-12
    assert nilai(y, y.astype(float) + 0.0, sk)["recall_fpr1"] == 1.0
    say("metrics ok:", {k: m[k] for k in ("recall_fpr1", "fpr1_aktual", "presisi_fpr01_prev2", "auprc")})
    bs = bootstrap_ci(y, [s], np.arange(len(y)) // 3, B=50, pembanding=[s + rng.normal(0, 0.5, len(s))])
    say("bootstrap ok:", bs)
    # X4 alignment
    a = np.array(["n", "c", "n", "c", "x"]); b = np.array(["n", "c", "n", "c", "c", "x"])
    assert selaraskan_x4(a, a)[0] is not None and selaraskan_x4(a, b)[0] is None
    assert (selaraskan_x4(np.array(["n", "c", "x"]), np.array(["n", "c", "n", "x"]))[0] == [0, 1, 3]).all()
    say("alignment ok")
    # graph on the data_v2_bersih slices
    D, E = siapkan(uji=True)
    for r, c in D["cek_graf"].items():
        assert c["stream_maks_selisih"] < 1e-4 and c["stream_derajat_maks_selisih"] == 0, (r, c)
    # causality: every edge goes from an earlier row of the same world
    for r in REL:
        dst, src = E[r]
        assert (src < dst).all()
        cd, cs = D["chunk"][dst], D["chunk"][src]
        assert ((cs == -1) | (cs == cd)).all()
        n = np.bincount(dst, minlength=len(D["sk"]))
        assert n.max() <= CAPS[r]
    say("graph ok: stream rows reproduce X1 neighbour means and degrees; edges causal and within one world")
    # every variant end to end, tiny
    isi, skor = varian_lgb("A", D["X1"], D, seeds=(0,)); assert len(skor[0]) == D["val"].sum()
    isi, skor = varian_lgb("B", fitur_B(D), D, seeds=(0,))
    for j in ("sage", "rgcn"):
        t = time.time()
        isi, skor, ep = varian_gnn(j, D, E, seeds=(0,), max_ep=10, patience=5)
        say(f"  D_{j} tiny: {time.time() - t:.1f}s, epoch {ep}")
        isi, skor = varian_E(j, D, E, {0: 5}, seeds=(0,))
    for j in ("mlp", "ft"):
        t = time.time()
        isi, skor = varian_F(j, D, seeds=(0,), max_ep=2)
        say(f"  F_{j} tiny: {time.time() - t:.1f}s")
    say("ALL UNIT TESTS PASSED")


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    os.environ.setdefault("PYTHONUTF8", "1")
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["uji", "jalankan", "ringkas"])
    ap.add_argument("--varian", default="A,B,D_sage,D_rgcn,E_sage,F_mlp,F_ft")
    ap.add_argument("--ft-ep", type=int, default=None)
    a = ap.parse_args()
    if a.perintah == "uji":
        uji()
    elif a.perintah == "jalankan":
        with kunci_berat():
            jalankan(a.varian.split(","), [], a.ft_ep)
    else:
        ringkas()
