"""Hospital × period features of the v4 models (layer C of kriteria_v4.json "aturan_tambahan"): schemes that run hospital-wide and
are invisible on one claim. Upcoding (the hospital's severity mix moves up), premature discharge (stays systematically shorter than
the code's norm; INA-CBG pays per episode, so a short stay saves the hospital money), top-up inflation, secondary-diagnosis inflation.
Synthetic data only.

Every claim gets features of ITS hospital over trailing windows of 30 and 90 days before the claim's date (claims dated strictly
earlier AND arrived earlier: causal on both), compared with peer hospitals (same jenis_fkrtl + tipe_fkrtl) over the same window:
  history     before 18 Dec 2024: silver reguler claims of training-role members only (bersih.peran == "latih"); from 18 Dec: the
              stream's claims and, in a chunk's world, the chunk's claims before this one
  peers       the peer group's claims in the same window minus the hospital's own (leave-one-out), from training-role silver claims
              and stream claims only; chunk rows never feed them (`bekukan()` before the first chunk row), so they are frozen before any
              validation or test chunk is seen. A peer group with < 30 inpatient claims in the window falls back to all hospitals.
  case mix    severity is the code's suffix (-I/-II/-III, III = berat); the expected share of III (and of II+III) of each inpatient
              claim is the 2024 share of its code family (code without the suffix) in its peer group (training-role silver, shrunk
              towards the family's national share), so "more severe" means more severe than the same diagnoses at peers
  small data  a window with < 30 inpatient claims of the hospital gives NaN for the inpatient features (and < 30 claims for the
              all-claim ones) plus the flag rs: sedikit_data_<W>, never a noisy ratio; z-scores use binomial SEs
One per-claim path (FiturRS.tambah: the row from earlier claims, then the claim is indexed); matriks_rs only loops over it.
Run: .venv/Scripts/python.exe testing/fitur_rs_v4.py cek   (alignment + the normal-vs-scheme sanity table on the chunks)"""
from __future__ import annotations

import copy
import hashlib
import math
import pickle
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TMP = ROOT / ".tmp"
sys.path.insert(0, str(HERE))
import fitur_v4 as F4  # noqa: E402

CACHE = TMP / "fitur_rs_v4_ref.pkl"
PETA = TMP / "fitur_rs_v4_peta_stream.npz"      # row map stream cache -> stream_x4 (resolved once from the realtime sqlite)
STREAM = TMP / "v2_stream_satu_jalur.npz"
STREAM_X4 = TMP / "data_v4" / "stream_x4.npz"
SQLITE = TMP / "testing-data" / "aip" / "realtime" / "realtime.sqlite"
VERSI = "rs-v4-1"
BASIS = date(2024, 9, 1)          # day 0 of the window arrays
ND = 184                          # days 2024-09-01 … 2025-03-03
N_SILVER = (F4.SEBELUM - BASIS).days   # silver history days (to 17 Dec 2024)
WINS = (30, 90)
MIN_N = 30
SHRINK = 20.0

NAMES_RS = [
    "rs: n_rawat_inap_90h", "rs: n_klaim_90h", "rs: sedikit_data_30h", "rs: sedikit_data_90h",
    "rs: sev3_lebih_vs_peer_90h", "rs: sev3_z_90h", "rs: sev3_z_30h", "rs: sev23_lebih_vs_peer_90h",
    "rs: los_rasio_vs_peer_90h", "rs: rawat_pendek_vs_peer_90h", "rs: rawat_pendek_z_90h", "rs: rawat_pendek_z_30h",
    "rs: biaya_rasio_vs_peer_90h", "rs: topup_laju_vs_peer_90h", "rs: topup_rasio_vs_peer_90h", "rs: dx_sekunder_vs_peer_90h",
    "rs: tren_sev3", "rs: tren_sev23", "rs: tren_los_rasio", "rs: tren_rawat_pendek",
    "rs: tren_biaya_rasio", "rs: tren_topup_laju", "rs: tren_topup_rasio", "rs: tren_dx_sekunder",
    "rs: sev_famili_ini_z_90h",
]
X4_KOLOM = {"lr": "v4: los_rasio_median_kode", "br": "v4: biaya_rasio_median_kode", "tr": "v4: topup_rasio_median_kode",
            "dx": "v4: dx_sekunder_di_atas_p90", "b25": "v4: los_di_bawah_p25"}
X1_RITL = "klaim: tingkat_pelayanan=RITL"
# components of a claim's contribution (summed per hospital × day, float64)
(C_N, C_RI, C_NS, C_O3, C_E3, C_V3, C_O23, C_E23, C_V23, C_NL, C_SL, C_NM, C_KP, C_SB, C_NT, C_ST, C_KD) = range(17)
K = 17
SEV = {"I": 1, "II": 2, "III": 3}


def _hari(s) -> int:
    return (date.fromisoformat(str(s)[:10]) - BASIS).days


def _famili(kode: str) -> tuple[str, int]:
    fam, _, suf = str(kode).rpartition("-")
    return fam, SEV.get(suf, 0)


def _q(a: float, b: float) -> float:
    return a / b if b > 0 else math.nan


# ---- reference: hospital → peer group, family severity shares, the training-role silver history (cached)
def referensi() -> dict:
    if CACHE.exists():
        with CACHE.open("rb") as fh:
            R = pickle.load(fh)
        if R.get("versi") == VERSI:
            return R
    import duckdb
    import pandas as pd
    import bersih

    R4 = F4.referensi()
    con = duckdb.connect()
    con.execute("SET memory_limit='1500MB'; SET threads=2")
    src = f"read_parquet('{F4.SILVER.as_posix()}')"
    ids = con.execute(f"SELECT DISTINCT peserta_id FROM {src} WHERE edisi = 'reguler'").df()
    ids = ids[bersih.peran_array(ids.peserta_id) == "latih"]
    con.register("latih", ids)
    rs_peer = {}
    for kab, kep, jenis, tipe in con.execute(f"SELECT DISTINCT kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl FROM {src} WHERE edisi = 'reguler'").fetchall():
        rs_peer[F4.profil(kab, kep, jenis, tipe)] = f"{jenis}|{tipe if isinstance(tipe, str) and tipe else '-'}"
    base = f"""FROM {src} s JOIN latih USING (peserta_id) WHERE s.edisi = 'reguler' AND s.tgl_datang < DATE '{F4.SEBELUM}'"""
    # family severity shares (inpatient, the whole pre-window 2024, training-role members)
    fam = con.execute(f"""SELECT jenis_fkrtl, tipe_fkrtl, regexp_extract(inacbg_kode, '^(.*)-[^-]*$', 1) fam, regexp_extract(inacbg_kode, '-([^-]*)$', 1) suf, count(*)
                          {base} AND tingkat_pelayanan = 'RITL' AND inacbg_kode IS NOT NULL GROUP BY ALL""").fetchall()
    tot, glob, peer = np.zeros(3), defaultdict(lambda: np.zeros(3)), defaultdict(lambda: np.zeros(3))
    for jenis, tipe, f, suf, n in fam:
        s = SEV.get(suf, 0)
        if not s:
            continue
        v = np.array([n, n * (s == 3), n * (s >= 2)], float)
        g = f"{jenis}|{tipe if isinstance(tipe, str) and tipe else '-'}"
        tot += v; glob[f] += v; peer[(g, f)] += v
    P3, P23 = tot[1] / tot[0], tot[2] / tot[0]
    g3 = {f: (v[1] + SHRINK * P3) / (v[0] + SHRINK) for f, v in glob.items()}
    g23 = {f: (v[2] + SHRINK * P23) / (v[0] + SHRINK) for f, v in glob.items()}
    p3 = {k: (v[1] + SHRINK * g3[k[1]]) / (v[0] + SHRINK) for k, v in peer.items()}
    p23 = {k: (v[2] + SHRINK * g23[k[1]]) / (v[0] + SHRINK) for k, v in peer.items()}
    R = {"versi": VERSI, "rs_peer": rs_peer, "P3": float(P3), "P23": float(P23), "g3": g3, "g23": g23, "p3": p3, "p23": p23,
         "kode": {k: {"med_los": v.get("med_los", 0.0)} for k, v in R4["kode"].items()}, "silver": {}, "famili": {}}
    # the history: every training-role silver claim from BASIS to 17 Dec, through the same per-claim contribution as the stream
    df = con.execute(f"""SELECT kabkota_fkrtl_kode kab, kepemilikan_fkrtl kep, jenis_fkrtl jenis, tipe_fkrtl tipe, tingkat_pelayanan = 'RITL' ritl,
                                coalesce(inacbg_kode, '') kode, coalesce(los_hari, 0) los, coalesce(biaya_tagih_rp, 0) biaya,
                                coalesce(sa_tarif_rp, 0) + coalesce(sp_tarif_rp, 0) + coalesce(rr_tarif_rp, 0) + coalesce(si_tarif_rp, 0) + coalesce(sd_tarif_rp, 0) topup,
                                coalesce(jumlah_dx_sekunder, 0) dxs, (tgl_datang - DATE '{BASIS}')::INT hari
                         {base} AND tgl_datang >= DATE '{BASIS}' ORDER BY tgl_datang, kunjungan_fkrtl_id""").df()
    con.close()
    prof = {k: F4.profil(*k) for k in df[["kab", "kep", "jenis", "tipe"]].drop_duplicates().itertuples(index=False, name=None)}
    keys = [prof[k] for k in df[["kab", "kep", "jenis", "tipe"]].itertuples(index=False, name=None)]
    fr = FiturRS(R, kosong=True)
    harian: dict[str, np.ndarray] = {}
    famili: dict = defaultdict(list)
    for h, ritl, kode, los, biaya, topup, dxs, d in zip(keys, df.ritl, df.kode, df.los, df.biaya, df.topup, df.dxs, df.hari):
        km = R4["kode"].get(kode) or {}
        med = km.get("med_los") or 0.0
        x4 = {"lr": los / med if (ritl and med > 0) else -1.0,
              "b25": float(bool(ritl) and med >= 3 and los < (km.get("p25_los") or 0)),
              "tr": (topup / km["med_topup"]) if km.get("med_topup") and topup > 0 else (0.0 if topup <= 0 else 10.0),
              "dx": float(dxs) - km.get("p90_dxs", 0.0),
              "br": (biaya / km["med_biaya"]) if km.get("med_biaya") else 1.0}
        c = fr.kontribusi(h, bool(ritl), kode, x4)
        harian.setdefault(h, np.zeros((N_SILVER, K)))[int(d)] += c
        f, s = _famili(kode)
        if ritl and s:
            famili[(h, f)].append((int(d), c[C_O23], c[C_E23], c[C_V23]))
    R["silver"], R["famili"] = harian, dict(famili)
    R["n_silver_klaim"] = int(len(df))
    with CACHE.open("wb") as fh:
        pickle.dump(R, fh)
    return R


# ---- the one per-claim path
class FiturRS:
    """The hospital windows of one world (silver history, then stream rows, then — after bekukan() — one chunk's rows).
    `tambah(row)` returns the claim's NAMES_RS row from the claims before it, then indexes the claim."""

    def __init__(self, R: dict, kosong: bool = False) -> None:
        self.R = R
        self.beku = False
        self.own: dict[str, np.ndarray] = {}       # all of the hospital's claims (silver + stream + chunk), per day
        self.own_ref: dict[str, np.ndarray] = {}   # the part that fed the peers (silver + stream)
        self.peer: dict[str, np.ndarray] = {}
        self.glob = np.zeros((ND, K))
        self.fam: dict = {}
        if kosong:
            return
        for h in sorted(R["silver"]):
            a = R["silver"][h]
            g = R["rs_peer"].get(h, "?")
            self.peer.setdefault(g, np.zeros((ND, K)))[: len(a)] += a
            self.glob[: len(a)] += a

    def bekukan(self) -> None:
        """From here on claims feed only their own hospital's windows, never the peers (chunk rows)."""
        self.beku = True

    def _rs(self, h: str) -> tuple[np.ndarray, np.ndarray]:
        if h not in self.own:
            a = np.zeros((ND, K))
            s = self.R["silver"].get(h)
            if s is not None:
                a[: len(s)] = s
            self.own[h], self.own_ref[h] = a, a.copy()
        return self.own[h], self.own_ref[h]

    def kontribusi(self, h: str, ritl: bool, kode: str, x4: dict) -> np.ndarray:
        c = np.zeros(K)
        c[C_N] = 1.0
        if ritl:
            c[C_RI] = 1.0
            f, s = _famili(kode)
            if s:
                g = self.R["rs_peer"].get(h, "?")
                p3 = self.R["p3"].get((g, f), self.R["g3"].get(f, self.R["P3"]))
                p23 = self.R["p23"].get((g, f), self.R["g23"].get(f, self.R["P23"]))
                c[C_NS], c[C_O3], c[C_E3], c[C_V3] = 1.0, float(s == 3), p3, p3 * (1 - p3)
                c[C_O23], c[C_E23], c[C_V23] = float(s >= 2), p23, p23 * (1 - p23)
            if x4["lr"] >= 0:
                c[C_NL], c[C_SL] = 1.0, min(float(x4["lr"]), 4.0)
            if ((self.R["kode"].get(kode) or {}).get("med_los") or 0) >= 3:
                c[C_NM], c[C_KP] = 1.0, float(x4["b25"] > 0)
        c[C_SB] = math.log(min(max(float(x4["br"]), 0.05), 20.0))
        if x4["tr"] > 0:
            c[C_NT], c[C_ST] = 1.0, min(float(x4["tr"]), 10.0)
        c[C_KD] = float(x4["dx"] > 0)
        return c

    @staticmethod
    def _nilai(S: np.ndarray, P: np.ndarray) -> dict:
        """The window's values of the hospital (S) against its peers (P); NaN where the hospital has < MIN_N claims."""
        ri, al = S[C_RI] >= MIN_N, S[C_N] >= MIN_N
        nan = math.nan
        d3 = _q(P[C_O3] - P[C_E3], P[C_NS])
        d23 = _q(P[C_O23] - P[C_E23], P[C_NS])
        pp = min(max(_q(P[C_KP], P[C_NM]) if P[C_NM] > 0 else 0.1, 0.01), 0.99)
        mt = _q(P[C_ST], P[C_NT]) if P[C_NT] > 0 else 1.0
        v = {
            "sev3": (_q(S[C_O3] - S[C_E3], S[C_NS]) - d3) if ri else nan,
            "sev3_z": ((S[C_O3] - S[C_E3] - S[C_NS] * (0.0 if d3 != d3 else d3)) / math.sqrt(max(S[C_V3], 1.0))) if ri else nan,
            "sev23": (_q(S[C_O23] - S[C_E23], S[C_NS]) - d23) if ri else nan,
            "los": (_q(S[C_SL], S[C_NL]) - _q(P[C_SL], P[C_NL])) if ri else nan,
            "pendek": (_q(S[C_KP], S[C_NM]) - _q(P[C_KP], P[C_NM])) if ri else nan,
            "pendek_z": ((S[C_KP] - S[C_NM] * pp) / math.sqrt(max(S[C_NM] * pp * (1 - pp), 1.0))) if ri else nan,
            "biaya": (_q(S[C_SB], S[C_N]) - _q(P[C_SB], P[C_N])) if al else nan,
            "topup_laju": (_q(S[C_NT], S[C_N]) - _q(P[C_NT], P[C_N])) if al else nan,
            "topup_rasio": ((S[C_ST] + 5.0 * mt) / (S[C_NT] + 5.0) - mt) if al else nan,   # shrunk towards the peers' mean
            "dx": (_q(S[C_KD], S[C_N]) - _q(P[C_KD], P[C_N])) if al else nan,
        }
        return v

    def _jendela(self, h: str, d: int, W: int) -> tuple[np.ndarray, np.ndarray]:
        a, b = max(0, d - W), min(max(d, 0), ND)
        if b <= a:
            return np.zeros(K), np.zeros(K)
        own, ref = self._rs(h)
        S = own[a:b].sum(0)
        mine = ref[a:b].sum(0)
        g = self.R["rs_peer"].get(h, "?")
        P = self.peer[g][a:b].sum(0) - mine if g in self.peer else None
        if P is None or P[C_RI] < MIN_N:
            P = self.glob[a:b].sum(0) - mine
        return S, P

    def tambah(self, row: dict) -> np.ndarray:
        """row: faskes, tgl (YYYY-MM-DD), kode, ritl (bool), lr, br, tr, dx, b25 (the X4 values of the claim)."""
        h, kode, ritl = str(row["faskes"]), str(row["kode"]), bool(row["ritl"])
        d = _hari(row["tgl"])
        S30, P30 = self._jendela(h, d, 30)
        S90, P90 = self._jendela(h, d, 90)
        v30, v90 = self._nilai(S30, P30), self._nilai(S90, P90)
        f, s = _famili(kode)
        O = E = V = 0.0
        for (dd, o, e, var) in (self.fam.get((h, f)) or self.R["famili"].get((h, f)) or ()):
            if d - 90 <= dd < d:
                O += o; E += e; V += var
        tr = lambda k: v30[k] - v90[k]  # noqa: E731  (NaN when either is NaN)
        out = [math.log1p(S90[C_RI]), math.log1p(S90[C_N]), float(S30[C_RI] < MIN_N), float(S90[C_RI] < MIN_N),
               v90["sev3"], v90["sev3_z"], v30["sev3_z"], v90["sev23"],
               v90["los"], v90["pendek"], v90["pendek_z"], v30["pendek_z"],
               v90["biaya"], v90["topup_laju"], v90["topup_rasio"], v90["dx"],
               tr("sev3"), tr("sev23"), tr("los"), tr("pendek"), tr("biaya"), tr("topup_laju"), tr("topup_rasio"), tr("dx"),
               (O - E) / math.sqrt(V + 1.0)]
        row_out = np.array(out, dtype=np.float32)
        # index the claim for the ones after it
        c = self.kontribusi(h, ritl, kode, row)
        if 0 <= d < ND:
            own, ref = self._rs(h)
            own[d] += c
            if not self.beku:
                ref[d] += c
                self.peer.setdefault(self.R["rs_peer"].get(h, "?"), np.zeros((ND, K)))[d] += c
                self.glob[d] += c
        if ritl and s:
            if (h, f) not in self.fam:
                self.fam[(h, f)] = list(self.R["famili"].get((h, f), ()))
            self.fam[(h, f)].append((d, c[C_O23], c[C_E23], c[C_V23]))
        return row_out


# ---- inputs and the matrix
_X1_IDX: dict = {}


def _ritl_idx() -> int:
    if "ritl" not in _X1_IDX:
        import joblib

        _X1_IDX["ritl"] = list(joblib.load(HERE / "model_v3_bersih" / "model.joblib")["sys_names"]).index(X1_RITL)
    return _X1_IDX["ritl"]


def baris(D: dict) -> list[dict]:
    """The per-claim inputs of a stream or chunk dict (npz contents with X1, X4, faskes, tgl, kode)."""
    if "X4" not in D:
        raise KeyError("X4 missing: merge the stream with stream_x4 first (muat_stream)")
    ix = {k: F4.NAMES.index(n) for k, n in X4_KOLOM.items()}
    X4 = np.asarray(D["X4"], np.float64)
    ritl = np.asarray(D["X1"])[:, _ritl_idx()] > 0.5
    fk, tg, kd = np.asarray(D["faskes"]).astype(str), np.asarray(D["tgl"]).astype(str), np.asarray(D["kode"]).astype(str)
    return [{"faskes": fk[i], "tgl": tg[i], "kode": kd[i], "ritl": bool(ritl[i]), **{k: float(X4[i, j]) for k, j in ix.items()}}
            for i in range(len(fk))]


def _stack(rows: list) -> np.ndarray:
    return np.vstack(rows) if rows else np.zeros((0, len(NAMES_RS)), np.float32)


def dunia_stream(stream: dict, R: dict | None = None) -> tuple[FiturRS, np.ndarray]:
    """A world after the stream: its state (frozen) and the stream's rows."""
    fr = FiturRS(R or referensi())
    rows = _stack([fr.tambah(r) for r in baris(stream)])
    fr.bekukan()
    return fr, rows


def matriks_rs(stream: dict, chunk: dict | None = None, R: dict | None = None) -> np.ndarray:
    """NAMES_RS rows (float32) for the chunk's rows (the stream first, then the chunk in file order), or for the stream's rows."""
    fr, rows = dunia_stream(stream, R)
    if chunk is None:
        return rows
    return _stack([fr.tambah(r) for r in baris(chunk)])


def matriks_rs_chunks(stream: dict, chunks: list[dict], R: dict | None = None) -> list[np.ndarray]:
    """matriks_rs for several chunks, each its own world, the stream processed once (a deep copy of its state per chunk)."""
    fr0, _ = dunia_stream(stream, R)
    out = []
    for ch in chunks:
        fr = copy.deepcopy(fr0)
        out.append(_stack([fr.tambah(r) for r in baris(ch)]))
    return out


# ---- the stream cache with its X4
def _peta_stream(S: dict, Z) -> tuple[np.ndarray, str]:
    a, b = S["sk"].astype(str), Z["sk"].astype(str)
    if len(a) == len(b) and (a == b).all():
        return np.arange(len(a)), "aligned: sk identical row by row"
    tanda = hashlib.md5(a.tobytes() + Z["klaim"].astype(str).tobytes()).hexdigest()
    if PETA.exists():
        p = np.load(PETA, allow_pickle=False)
        if str(p["tanda"]) == tanda:
            return p["peta"], str(p["ket"])
    # the cache is stream_x4's order minus dropped rows (latih_v2.stream_fitur drops 30 % of ring members): match on the full keys
    import sqlite3

    con = sqlite3.connect(f"file:{SQLITE.as_posix()}?mode=ro", uri=True)
    rows = con.execute("""SELECT json_extract(p.rec, '$.klaim'), json_extract(p.rec, '$.peserta'), json_extract(p.rec, '$.faskes'),
                                 json_extract(p.rec, '$.kode'), substr(json_extract(p.rec, '$.tgl_datang'), 1, 10),
                                 coalesce(k.skenario, 'aug:' || substr(p.sumber, 5))
                          FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                          WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'aug:%') ORDER BY p.seq""").fetchall()
    con.close()
    if [str(r[0]) for r in rows] != Z["klaim"].astype(str).tolist():
        raise RuntimeError("stream_x4 claim ids differ from the realtime sqlite: cannot align")
    A = list(zip(*(S[k].astype(str) for k in ("sk", "peserta", "faskes", "kode", "tgl"))))
    B = [(r[5], str(r[1]), str(r[2]), str(r[3]), str(r[4])) for r in rows]

    def embed(a, b):
        out, j = np.empty(len(a), np.int64), 0
        for i in range(len(a)):
            while j < len(b) and b[j] != a[i]:
                j += 1
            if j == len(b):
                return None
            out[i] = j; j += 1
        return out
    kiri = embed(A, B)
    kanan = embed(A[::-1], B[::-1])
    if kiri is None or kanan is None or not np.array_equal(kiri, (len(B) - 1 - kanan)[::-1]):
        raise RuntimeError("stream cache is not a unique subsequence of stream_x4 on (sk, peserta, faskes, kode, tgl)")
    lompat = np.setdiff1d(np.arange(len(B)), kiri)
    ket = (f"aligned as a unique subsequence on (sk, peserta, faskes, kode, tgl): {len(a)} of {len(b)} stream_x4 rows, "
           f"{len(lompat)} without a partner (sk {sorted(set(b[lompat].tolist()))})")
    np.savez(PETA, peta=kiri, tanda=np.array(tanda), ket=np.array(ket))
    return kiri, ket


def muat_stream() -> dict:
    """.tmp/v2_stream_satu_jalur.npz with X4 from .tmp/data_v4/stream_x4.npz (row-aligned; key '_x4_ket' says how)."""
    S = dict(np.load(STREAM, allow_pickle=False))
    Z = np.load(STREAM_X4, allow_pickle=False)
    peta, ket = _peta_stream(S, Z)
    S["X4"] = Z["X4"][peta]
    S["_x4_ket"] = ket
    return S


# ---- sanity: feature means for normal vs scheme rows on the chunks
def cek() -> None:
    import time

    t0 = time.time()
    R = referensi()
    print(f"reference: {R.get('n_silver_klaim')} training-role silver claims since {BASIS}, {len(R['silver'])} hospitals, "
          f"P(III)={R['P3']:.3f} P(II+)={R['P23']:.3f}  [{time.time() - t0:.0f}s]")
    S = muat_stream()
    print("stream X4:", S["_x4_ket"])
    files = sorted((TMP / "data_v4").glob("fitur_[0-9][0-9].npz"))
    chunks = [dict(np.load(f, allow_pickle=False)) for f in files]
    Ms = matriks_rs_chunks(S, chunks, R)
    print(f"{len(files)} chunks computed [{time.time() - t0:.0f}s]")
    M = np.vstack(Ms)
    sk = np.concatenate([c["sk"].astype(str) for c in chunks])
    var = np.concatenate([c["varian"].astype(str) for c in chunks])
    fk = np.concatenate([c["faskes"].astype(str) for c in chunks])
    cid = np.concatenate([np.full(len(c["sk"]), i) for i, c in enumerate(chunks)])
    batch_up = np.zeros(len(sk), bool)
    for i in np.where(sk == "upcoding")[0]:
        batch_up[i] = ((sk == "upcoding") & (fk == fk[i]) & (cid == cid[i])).sum() >= 5
    grp = {"normal": sk == "normal", "upcoding (batch RS)": batch_up, "upcoding (sebar)": (sk == "upcoding") & ~batch_up,
           "pulang_cepat (batch RS)": (sk == "pulang_cepat") & (var == "rs"), "pulang_cepat (sebar)": (sk == "pulang_cepat") & (var == "sebar"),
           "topup_inflasi": sk == "topup_inflasi", "dx_sekunder": sk == "dx_sekunder"}
    hd = list(grp)
    print(f"\n{'feature':34s}" + "".join(f"{g[:22]:>24s}" for g in hd))
    print(f"{'rows':34s}" + "".join(f"{int(m.sum()):>24d}" for m in grp.values()))
    for j, n in enumerate(NAMES_RS):
        cells = []
        for m in grp.values():
            x = M[m, j]
            cells.append(f"{np.nanmean(x) if np.isfinite(x).any() else float('nan'):>10.3f} (NaN {np.isnan(x).mean():4.0%})".rjust(24))
        print(f"{n:34s}" + "".join(cells))
    print(f"[{time.time() - t0:.0f}s]")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "cek":
        cek()
    else:
        print(__doc__)
