"""Generator 3: an independent synthetic FKRTL claim generator for an honest out-of-distribution test (synthetic data only).

Written without reading how generators 1 and 2 build claims or plant fraud. Everything it learns comes from the silver
claims of 2024 (reguler edition) and the member registry; the fraud is written from the Permenkes 16/2019 definitions and
from what a dishonest hospital would plausibly do, with parameters fixed in SKEMA before any test was run.

NORMAL CLAIMS: semi-Markov member journeys with episode-level clinical derivation
-------------------------------------------------------------------------------
Not CART leaf-donor sampling of whole rows and not field-by-field sampling from per-code aggregates. A claim is the end
of a causal chain that starts from the member, not from a code:

1. Journey (when and where). Each member's claims form a renewal process. The daily hazard of the member's next claim is
   learned with censoring (Kaplan-Meier style, Jan-17 Dec 2024) for the state "last claim's INA-CBG base x the gap that led
   into it" (the member's own rhythm: twice-weekly dialysis, monthly control, a one-off), backed off to (care level x CMG x
   rhythm) and (care level x rhythm). A member with history enters the window from their real last claim before 18 Dec,
   so the first window claim follows naturally from that history (date, hospital, diagnosis). A transition table learned
   from consecutive claim pairs (keyed by the previous state and the gap) decides whether the next claim is at the same
   hospital, for the same diagnosis, and outpatient or inpatient. A new hospital is one the member used before or one
   from the member's residence (kab/kota) referral flow.
2. Episode (what). Diagnosis given care level, hospital group (general / clinic / each specialty), age band and sex; the
   INA-CBG base group given diagnosis and care level (the grouper's empirical mapping); the number of secondary
   diagnoses given care level, age band and CMG; severity (I/II/III) given base group and secondary diagnoses (as the
   grouper derives severity from comorbidities); length of stay from a discharge process: the code's empirical survival
   curve under a proportional-hazards modifier for the hospital's own LOS index and the member's age band.
3. Money. The tariff is looked up in the real INA-CBG tariff table (one tariff per code x regional x hospital type x
   ownership x class, all 54,716 keys of silver); a key a hospital has not used yet takes its siblings' tariff (same
   code, regional, type, class, government/private group) only when all siblings agree. A tariff is never invented:
   without a key the episode is re-derived. Special-CMG top-ups follow the code's own top-up incidence and their fixed amounts per
   (top-up code x regional x type x ownership). The bill is tariff + top-ups (and the dialysis 85 % billing where the
   hospital does it). The silver flags are recomputed by their own rules (LOS above the code's extreme threshold; same
   member, date and code twice).

FRAUD (SKEMA): 22 schemes over the FKRTL modes M04-M17 in five families (koding, tagihan, episode, identitas, jaringan),
plus one quality deviation (pulang_dini, label "mutu", not fraud). Hospital-level schemes act on a share of chosen
hospitals' claims in every chunk (the dishonest hospitals are fixed once, globally); individual schemes are scattered.
Fraud is applied to the episodes of the same simulated member population as the normal claims (or to reserve members
drawn by the same journey model), so fraud and normal share the history mix.

Fingerprints of earlier generators avoided:
1. Same population: fraud transforms or extends the journeys of the same simulated members; phantom claims use the
   hospital's own past patients first. `contoh` reports the history share of normal and fraud claims side by side.
2. No scheme duplicates a claim at another hospital on the same day; cross-hospital schemes always leave >= 1 day.
3. No historical row is copied: the window claims are new episodes derived from the member's state; a continuation
   visit repeats hospital and code on a new date (a control visit), never a twin of a history claim.
4. Window counts come from the members' own hazards (most members 1 claim, some 2-4), not from compressing a year.

Interface: buat(c, kecuali) -> chunk c's claims (dates as datetime.date; KlaimIn(**{k: v for k not starting with '_'})
validates them) with _sk, _varian, _m, _urut; adalah_fraud(sk) tells fraud from 'normal' and from the quality scheme.

CLI:  python testing/generator3.py fit        learn the world (writes .tmp/gen3/)
      python testing/generator3.py contoh <c> one chunk: counts, mix, KlaimIn validation, fidelity vs 1-14 Nov 2024;
                                              exit code 0 only if generation succeeded and every claim validates
"""
from __future__ import annotations

import hashlib
import os
import pickle
import sys
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TMP = ROOT / ".tmp"
OUT = TMP / "gen3"
SILVER = ROOT / "data" / "drive" / "217f2b804b0c4525"
REGISTRI = ROOT / "data" / "drive" / "9d7869ab23424a4e"

# GEN3_W1 (testing/gen_tema.py, 2026-11-14): a longer window (a year of one theme in one branch); default the 14-day window
W0, W1 = date(2024, 12, 18), (date.fromisoformat(os.environ["GEN3_W1"]) if os.environ.get("GEN3_W1") else date(2024, 12, 31))
NDAY = (W1 - W0).days + 1
N_CHUNK = 8
TARGET = 5000  # claims per chunk before fraud additions
GARAM = os.environ.get("GEN3_GARAM") or "gen3-v1"  # v5: a fresh seed for the one-shot test (GEN3_GARAM=gen3-v5)
MAXH = 170  # days of the learned hazard; beyond it a flat tail hazard
TOPUP_COLS = ("sa", "sp", "rr", "si", "sd")

# ------------------------------------------------------------------------------------------------------------------
# SKEMA: the fraud (and one quality) schemes, parameters fixed before any test (rates set once, from the claim volumes
# alone, so that fraud is about 2-3 % of a chunk; no model or detector was consulted).
#   modus     Permenkes 16/2019 mode(s)          famili   koding / tagihan / episode / identitas / jaringan
#   label     short Indonesian label             baru     a scheme a typical generator would likely not include
#   kelas     "fraud" or "mutu" (quality / standard-of-care deviation, not fraud)
#   rs        hospitals running it systematically (0 = individual only), porsi_rs = share of their eligible claims
#   p         individual rate per eligible claim elsewhere; the rest are the scheme's own parameters
# INA-CBG pays per episode: a longer stay earns nothing, so los_diperpanjang is minor; the realistic abuse is the
# opposite, discharging early to save cost (pulang_dini, quality) and billing the return as a second episode
# (pulang_dini_readmisi, fraud with financial loss).
# ------------------------------------------------------------------------------------------------------------------
SKEMA: dict[str, dict[str, Any]] = {
    # koding
    "upcoding_keparahan": dict(modus="M04", famili="koding", label="Upcoding keparahan: diagnosis sekunder ditambah", baru=False, kelas="fraud",
                               rs=3, porsi_rs=0.45, p=0.010, tambah_dxs=(1, 3), naik_dua=0.15),
    "geser_bertahap": dict(modus="M04", famili="koding", label="Case-mix RS digeser naik bertahap", baru=True, kelas="fraud",
                           rs=2, p_awal=0.05, p_akhir=0.60, tambah_dxs=(1, 2)),
    "diagnosis_utama_diganti": dict(modus="M04", famili="koding", label="Diagnosis utama diganti yang lebih mahal", baru=False, kelas="fraud",
                                    rs=0, p=0.008, rasio_min=1.25),
    "tindakan_fiktif": dict(modus="M14", famili="koding", label="Tindakan ditagih tetapi tidak dilakukan", baru=False, kelas="fraud",
                            rs=0, p_rj=0.003, p_ri=0.005, varian={"rj_prosedur/ri_bedah": 0.8, "tanpa_catatan": 0.2}),
    "operasi_batal_ditagih": dict(modus="M14", famili="koding", label="Operasi batal tetap ditagih", baru=True, kelas="fraud",
                                  rs=0, p=0.02, varian={"batal_saja": 0.5, "dijadwal_ulang": 0.5}, jeda_ulang=(3, 10)),
    "tidak_sesuai_indikasi": dict(modus="M15", famili="koding", label="Tindakan tidak sesuai indikasi medis", baru=False, kelas="fraud",
                                  rs=0, p_sc=0.05, p_lain=0.002, lazim_maks=0.01),  # varian sc_tanpa_indikasi (of vaginal deliveries), prosedur_tidak_lazim
    # tagihan
    "tagihan_gelembung": dict(modus="M07", famili="tagihan", label="Tagihan di atas tarif paket INA-CBG", baru=False, kelas="fraud",
                              rs=1, porsi_rs=0.25, p=0.0015, faktor=(1.08, 1.40)),
    "topup_gelembung": dict(modus="M07/M19", famili="tagihan", label="Top-up special CMG digelembungkan", baru=False, kelas="fraud",
                            rs=0, p=0.25, faktor=(1.7, 3.2)),
    "obat_alkes_fiktif": dict(modus="M17", famili="tagihan", label="Obat/alkes/pemeriksaan fiktif lewat top-up", baru=False, kelas="fraud",
                              rs=0, p_ri=0.005, p_rj=0.0005, varian={"topup_lazim": 0.6, "topup_tidak_lazim": 0.4}),
    "naik_kelas": dict(modus="M13", famili="tagihan", label="Kelas rawat ditagih di atas hak", baru=False, kelas="fraud",
                       rs=1, porsi_rs=0.40, p=0.004, naik_dua=0.3),
    # episode
    "rawat_inap_tanpa_indikasi": dict(modus="M15", famili="episode", label="Rawat inap untuk kasus tingkat rawat jalan", baru=True, kelas="fraud",
                                      rs=2, porsi_rs=0.15, p=0.0006, los=(1, 3)),
    "sesi_rutin_fiktif": dict(modus="M06", famili="episode", label="Sesi rutin tambahan yang tidak terjadi", baru=True, kelas="fraud",
                              rs=2, porsi_rs=0.50, tambah=(1, 2)),
    "klaim_berulang": dict(modus="M11", famili="episode", label="Klaim berulang: satu layanan ditagih dua kali", baru=False, kelas="fraud",
                           rs=0, p=0.002, varian={"id_baru": 0.4, "geser_sehari": 0.35, "kode_beda": 0.25}),
    "pemecahan_episode": dict(modus="M08/M09", famili="episode", label="Pemecahan episode", baru=False, kelas="fraud",
                              rs=0, p_ri_dipecah=0.01, p_rj_ri=0.008, p_rj_poli=0.0008),
    "readmisi_direncanakan": dict(modus="M16", famili="episode", label="Readmisi direncanakan tanpa kebutuhan klinis", baru=False, kelas="fraud",
                                  rs=0, p=0.02, jeda=(4, 14), dx_sama=0.7),
    "pulang_dini": dict(modus="M12 (kebalikan)", famili="episode", label="Pulang dini: penyimpangan standar pelayanan (mutu)", baru=True, kelas="mutu",
                        rs=4, porsi_rs=0.70, los_min=2, potong=(0.35, 0.60)),
    "pulang_dini_readmisi": dict(modus="M09/M16", famili="episode", label="Pulang dini lalu readmisi: episode kedua ditagih", baru=True, kelas="fraud",
                                 rs=2, porsi_rs=0.30, p=0.006, los_min=2, potong=(0.35, 0.60), jeda=(1, 7), rs_sama=0.8, dx_sama=0.65,
                                 naik_keparahan=0.3),
    "los_diperpanjang": dict(modus="M12", famili="episode", label="Lama rawat diperpanjang (minor: tarif per episode)", baru=False, kelas="fraud",
                             rs=0, p=0.001, faktor=(1.8, 3.0)),
    # identitas
    "klaim_fiktif": dict(modus="M06", famili="identitas", label="Klaim fiktif: pasien tidak pernah datang", baru=False, kelas="fraud",
                         rs=2, porsi_rs=0.06, varian={"pasien_lama": 0.6, "data_baksos": 0.3, "pasien_meninggal": 0.1}, ri=0.3),
    "kartu_dipinjam": dict(modus="M06", famili="identitas", label="Kartu peserta dipakai orang lain", baru=False, kelas="fraud",
                           rs=0, p=0.001, varian={"tidak_cocok": 0.5, "cocok": 0.5}),
    "kloning": dict(modus="M05", famili="identitas", label="Kloning klaim: rekam medis disalin", baru=False, kelas="fraud",
                    rs=2, porsi_rs=0.50, grup=(2, 4), varian={"hari_sama": 0.4, "beda_hari": 0.6}),
    # jaringan
    "rujukan_semu": dict(modus="M10", famili="jaringan", label="Rujukan semu ke RS afiliasi", baru=False, kelas="fraud",
                         rs=2, porsi_rs=0.15, jeda=(1, 4), ri=0.25),
    "dokter_tiga_rs": dict(modus="M10", famili="jaringan", label="Dokter praktik di tiga RS: pasien diputar", baru=True, kelas="fraud",
                           rs=2, porsi_rs=0.50, jeda=(3, 7)),
}


def adalah_fraud(sk: str) -> bool:
    """True for a fraud scheme; False for 'normal' and for the quality deviation (kelas 'mutu')."""
    return sk != "normal" and SKEMA.get(sk, {}).get("kelas") == "fraud"


# ------------------------------------------------------------------------------------------------------------------
# small helpers
# ------------------------------------------------------------------------------------------------------------------
def _h(s: str) -> int:
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


def chunk_of(pid: int) -> int:
    return _h(f"{int(pid)}|{GARAM}|chunk") % N_CHUNK


def _ab(age: Optional[float]) -> int:
    """Age band: 0 <2, 1 2-14, 2 15-44, 3 45-59, 4 60+."""
    if age is None or age != age:
        return 2
    return 0 if age < 2 else 1 if age < 15 else 2 if age < 45 else 3 if age < 60 else 4


def _gb(g: int) -> str:
    """Gap bin of the transition table."""
    return "0" if g <= 0 else "1-3" if g <= 3 else "4-10" if g <= 10 else "11-30" if g <= 30 else "31-90" if g <= 90 else "91+"


def _pgb(g: Optional[int]) -> str:
    """Rhythm bin: the gap that led into a claim (None = first claim of the year)."""
    if g is None or g != g:
        return "baru"
    g = int(g)
    return "0" if g <= 0 else "1-3" if g <= 3 else "4-10" if g <= 10 else "11-20" if g <= 20 else "21-40" if g <= 40 else "41-90" if g <= 90 else "91+"


def _hg(tipe: Optional[str], jenis: Optional[str]) -> str:
    if tipe and str(tipe).startswith("Khusus"):
        return str(tipe)
    return "Klinik" if jenis == "Klinik Utama" else "Umum"


def _k(v: Any) -> str:
    return "" if v is None or (isinstance(v, float) and v != v) else str(v)


def _grup_kep(kep: Any) -> str:
    """The INA-CBG tariff tables differ between government and private hospitals."""
    return "swasta" if _k(kep) in ("Swasta", "BUMN") else "pemerintah"


class Tab:
    """A discrete distribution: values and cumulative weights."""
    __slots__ = ("v", "c")

    def __init__(self, vals: list, w: list) -> None:
        self.v = list(vals)
        self.c = np.cumsum(np.asarray(w, dtype=float))

    def pick(self, rng: np.random.Generator) -> Any:
        return self.v[int(np.searchsorted(self.c, rng.random() * self.c[-1], side="right"))]

    def n(self) -> float:
        return float(self.c[-1]) if len(self.c) else 0.0

    def p(self, val: Any) -> float:
        tot = self.n()
        if tot <= 0:
            return 0.0
        w = np.diff(np.concatenate([[0.0], self.c]))
        return float(sum(wi for vi, wi in zip(self.v, w) if vi == val) / tot)


def _tabs(df, keys: list[str], val: str, cnt: str = "n", top: Optional[int] = None, min_n: float = 0) -> dict:
    """{key tuple (or scalar): Tab} from a long count table."""
    out: dict = {}
    if df.empty:
        return out
    df = df.assign(_v=df[val].astype(str)).sort_values(keys + [cnt, "_v"], ascending=[True] * len(keys) + [False, True], kind="mergesort")
    for k, g in df.groupby(keys, sort=False, dropna=False):
        if g[cnt].sum() < min_n:
            continue
        if top:
            g = g.head(top)
        kk = tuple(_k(x) if not isinstance(x, (int, np.integer)) else int(x) for x in (k if isinstance(k, tuple) else (k,)))
        out[kk if len(kk) > 1 else kk[0]] = Tab([None if (isinstance(x, float) and x != x) else x for x in g[val].tolist()], g[cnt].tolist())
    return out


# ------------------------------------------------------------------------------------------------------------------
# fit: learn the world from silver (claims before the window for behaviour; all of 2024 for the tariff structure)
# ------------------------------------------------------------------------------------------------------------------
def _con():
    import duckdb

    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")
    con.execute(f"SET temp_directory='{(OUT / 'duckdb').as_posix()}'")
    con.execute("SET memory_limit='4GB'")
    con.execute(f"""CREATE VIEW s AS SELECT *, md5(concat_ws('|','FKRTL',kabkota_fkrtl_kode::VARCHAR,kepemilikan_fkrtl,jenis_fkrtl,tipe_fkrtl)) f,
                    regexp_replace(inacbg_kode, '-[0IV]+$', '') basis, regexp_extract(inacbg_kode, '-([0IV]+)$', 1) sev,
                    substr(inacbg_kode, 1, 1) cmg1, substr(inacbg_kode, 3, 1) dg2
                    FROM read_parquet('{SILVER.as_posix()}') WHERE edisi = 'reguler'""")
    con.execute(f"CREATE VIEW r AS SELECT * FROM read_parquet('{REGISTRI.as_posix()}') WHERE edisi = 'reguler'")
    return con


AB_SQL = """CASE WHEN r.tgl_lahir IS NULL THEN 2 WHEN date_diff('day', r.tgl_lahir, s.tgl_datang) < 2*365.25 THEN 0
            WHEN date_diff('day', r.tgl_lahir, s.tgl_datang) < 15*365.25 THEN 1 WHEN date_diff('day', r.tgl_lahir, s.tgl_datang) < 45*365.25 THEN 2
            WHEN date_diff('day', r.tgl_lahir, s.tgl_datang) < 60*365.25 THEN 3 ELSE 4 END"""
JK_SQL = "CASE WHEN r.jenis_kelamin = 'LAKI-LAKI' THEN 'L' WHEN r.jenis_kelamin = 'PEREMPUAN' THEN 'P' ELSE '' END"
HG_SQL = "CASE WHEN s.tipe_fkrtl LIKE 'Khusus%' THEN s.tipe_fkrtl WHEN s.jenis_fkrtl = 'Klinik Utama' THEN 'Klinik' ELSE 'Umum' END"


def fit() -> None:
    import pandas as pd

    sys.path.insert(0, str(HERE))
    import bersih

    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "duckdb").mkdir(parents=True, exist_ok=True)
    con = _con()
    q = lambda sql: con.execute(sql).df()  # noqa: E731
    W0s = f"DATE '{W0.isoformat()}'"
    M: dict[str, Any] = {"garam": GARAM, "dibuat": time.strftime("%Y-%m-%d %H:%M")}

    def log(msg: str) -> None:
        print(f"[{time.time() - t0:6.1f}s] {msg}", flush=True)

    # hospitals (facility profiles)
    rs = q(f"""SELECT f, kabkota_fkrtl_kode kab, any_value(kabkota_fkrtl) kab_nama, any_value(provinsi_fkrtl) prov_nama,
                      kepemilikan_fkrtl kep, jenis_fkrtl jenis, tipe_fkrtl tipe, mode(regional_tarif) regional, count(*) n,
                      sum((tingkat_pelayanan = 'RITL')::INT) n_ri
               FROM s WHERE tgl_datang < {W0s} GROUP BY f, kab, kep, jenis, tipe""")
    medlos = q("SELECT inacbg_kode, median(los_hari) m FROM s WHERE tingkat_pelayanan = 'RITL' GROUP BY 1")
    con.register("medlos", medlos)
    li = q(f"""SELECT f, sum(los_hari / greatest(m, 1)) sr, count(*) k FROM s JOIN medlos USING (inacbg_kode)
               WHERE tingkat_pelayanan = 'RITL' AND tgl_datang < {W0s} GROUP BY f""")
    rs = rs.merge(li, on="f", how="left")
    # LOS / code median averages above 1 (skewed stays): indices are taken relative to that population mean
    g_los = float(q(f"""SELECT avg(los_hari / greatest(m, 1)) FROM s JOIN medlos USING (inacbg_kode)
                        WHERE tingkat_pelayanan = 'RITL' AND tgl_datang < {W0s}""").iloc[0, 0])
    M["los_g"] = g_los
    rs["los_idx"] = (((rs.sr.fillna(0) + 20 * g_los) / (rs.k.fillna(0) + 20)) / g_los).clip(0.5, 2.0)
    rs["hg"] = [_hg(t, j) for t, j in zip(rs.tipe, rs.jenis)]
    M["rs"] = {r["f"]: {k: (None if (isinstance(v, float) and v != v) else v) for k, v in r.items() if k not in ("sr", "k")} for r in rs.to_dict("records")}
    log(f"hospitals {len(rs)}")

    # the tariff table (all of 2024): one tariff per code x regional x type x ownership x class
    tf = q("SELECT inacbg_kode, regional_tarif, tipe_fkrtl, kepemilikan_fkrtl, kelas_rawat, any_value(tarif_inacbg_rp) t FROM s GROUP BY ALL")
    M["tarif"] = {(a, _k(b), _k(c), _k(d), _k(e)): int(t) for a, b, c, d, e, t in tf.itertuples(index=False)}
    # a key a hospital has not used yet takes its siblings' tariff (same code, regional, type, class and ownership group:
    # government or private), and only when every sibling carries the same tariff (98 % of sibling groups do)
    sib: dict[tuple, set] = defaultdict(set)
    for (a, b, c, d, e), t in M["tarif"].items():
        sib[(a, b, c, _grup_kep(d), e)].add(t)
    M["tarif_saudara"] = {k: next(iter(v)) for k, v in sib.items() if len(v) == 1}
    log(f"tariff keys {len(M['tarif'])}, sibling keys {len(M['tarif_saudara'])}")

    # code descriptions and the LOS-extreme thresholds
    kd = q("""SELECT inacbg_kode, mode(inacbg_deskripsi) des, mode(inacbg_cmg) cmg, mode(inacbg_tipe_kasus) tk, mode(inacbg_keparahan) kep,
                     min(los_hari) FILTER (WHERE flag_los_ekstrem) mn_f, max(los_hari) FILTER (WHERE NOT flag_los_ekstrem) mx_nf,
                     median(los_hari) FILTER (WHERE tingkat_pelayanan = 'RITL') med, count(*) n FROM s GROUP BY 1""")
    M["kode"] = {r["inacbg_kode"]: dict(des=r["des"], cmg=r["cmg"], tk=r["tk"], kep=r["kep"], n=int(r["n"]),
                                        ekstrem=int(r["mn_f"]) if r["mn_f"] == r["mn_f"] and r["mn_f"] is not None else int((r["mx_nf"] if r["mx_nf"] == r["mx_nf"] else 400) + 1),
                                        med=float(r["med"]) if r["med"] == r["med"] and r["med"] is not None else 0.0)
                 for r in kd.to_dict("records")}

    # special-CMG top-ups: incidence per code, amounts per (type, code, regional, type, ownership)
    parts = []
    for col in TOPUP_COLS:
        des = f"{col}_deskripsi" if col != "sa" else "NULL"
        parts.append(f"""SELECT '{col}' col, inacbg_kode, {col}_kode tk, {des} des, regional_tarif, tipe_fkrtl, kepemilikan_fkrtl, {col}_tarif_rp v
                         FROM s WHERE {col}_tarif_rp > 0""")
    con.execute("CREATE TEMP TABLE tu AS " + " UNION ALL ".join(parts))
    inc = q("SELECT inacbg_kode, col, tk, mode(des) des, count(*) n FROM tu GROUP BY ALL ORDER BY inacbg_kode, col, tk")
    M["topup_inc"] = defaultdict(list)
    for r in inc.to_dict("records"):
        M["topup_inc"][r["inacbg_kode"]].append((r["col"], r["tk"], r["des"], int(r["n"])))
    M["topup_inc"] = dict(M["topup_inc"])
    am = q("SELECT col, tk, regional_tarif, tipe_fkrtl, kepemilikan_fkrtl, mode(v) v FROM tu GROUP BY ALL")
    M["topup_amt"] = {(a, b, _k(c), _k(d), _k(e)): int(v) for a, b, c, d, e, v in am.itertuples(index=False)}
    amm = q("SELECT col, tk, median(v) v, quantile_cont(v, 0.95) p95, count(*) n FROM tu GROUP BY ALL")
    M["topup_med"] = {(a, b): (int(v), float(p), int(n)) for a, b, v, p, n in amm.itertuples(index=False)}
    # the CMG letter's top-up types (for a top-up a code rarely carries)
    M["topup_cmg"] = _tabs(q("SELECT substr(inacbg_kode,1,1) cmg1, col || '|' || tk ct, count(*) n FROM tu GROUP BY ALL"), ["cmg1"], "ct")
    log("top-ups")

    # the 85 % billing some hospitals use for dialysis (and rare others)
    b85 = q(f"""SELECT f, inacbg_kode, avg((biaya_tagih_rp = round(tarif_inacbg_rp * 0.85) + sa_tarif_rp + sp_tarif_rp + rr_tarif_rp + si_tarif_rp + sd_tarif_rp)::INT) sh,
                       count(*) n FROM s WHERE tgl_datang < {W0s} GROUP BY 1, 2 HAVING n >= 10 AND sh > 0.05""")
    M["b85"] = {(a, b): float(c) for a, b, c, _ in b85.itertuples(index=False)}

    # ---- the journey: sequences of each member's claims before the window ----
    con.execute(f"""CREATE TEMP TABLE seq AS
        WITH c AS (SELECT peserta_id pid, tgl_datang d, tgl_pulang p, kunjungan_fkrtl_id id, basis, tingkat_pelayanan tk, cmg1, f,
                          dx_primer_icd3 dx, poli, prosedur, dx_primer_kode dxk, inacbg_kode kode FROM s WHERE tgl_datang < {W0s})
        SELECT *, date_diff('day', lag(p) OVER w, d) pg, lead(d) OVER w nd, lead(f) OVER w nf, lead(dx) OVER w ndx, lead(tk) OVER w ntk,
               lead(basis) OVER w nbasis, lead(poli) OVER w npoli, lead(prosedur) OVER w nprosedur, lead(dxk) OVER w ndxk, lead(kode) OVER w nkode
        FROM c WINDOW w AS (PARTITION BY pid ORDER BY d, p, id)""")
    con.execute(f"""CREATE TEMP TABLE ev AS SELECT *,
        CASE WHEN pg IS NULL THEN 'baru' WHEN pg <= 0 THEN '0' WHEN pg <= 3 THEN '1-3' WHEN pg <= 10 THEN '4-10' WHEN pg <= 20 THEN '11-20'
             WHEN pg <= 40 THEN '21-40' WHEN pg <= 90 THEN '41-90' ELSE '91+' END pgb,
        greatest(date_diff('day', p, nd), 0) g, date_diff('day', p, {W0s} - 1) cz, nd IS NOT NULL e FROM seq WHERE p < {W0s}""")
    # hazard of the next claim per day since discharge (events and at-risk counts, censored at 17 Dec)
    haz = {}
    for lvl, key in (("L1", "basis || '|' || pgb"), ("L3", "tk || '|' || cmg1 || '|' || pgb"), ("L4", "tk || '|' || pgb")):
        d = q(f"""WITH t AS (SELECT {key} k, least(CASE WHEN e THEN g ELSE cz END, {MAXH}) tt, e AND g < {MAXH} ee FROM ev)
                  SELECT k, tt, sum(ee::INT) ev, count(*) n FROM t GROUP BY 1, 2""")
        tab = {}
        for k, g in d.groupby("k"):
            evs = np.zeros(MAXH + 1)
            ends = np.zeros(MAXH + 1)
            evs[g.tt.values.astype(int)] += g.ev.values
            ends[g.tt.values.astype(int)] += g.n.values
            atrisk = ends[::-1].cumsum()[::-1]  # still at risk on day t: ended (event or censoring) on day >= t
            tab[k] = (evs[:MAXH], atrisk[:MAXH])
        haz[lvl] = tab
    # smoothed hazards: L4 raw, L3 toward L4, L1 toward L3
    H: dict[str, dict[str, np.ndarray]] = {"L1": {}, "L3": {}, "L4": {}}

    def smooth(e, r, parent, m=30.0):
        return (e + m * parent) / (r + m)

    for k, (e, r) in haz["L4"].items():
        H["L4"][k] = np.clip((e + 0.5 * 0.01) / (r + 0.5), 1e-5, 0.95)
    for k, (e, r) in haz["L3"].items():
        tk, _, pgb = k.split("|")
        par = H["L4"].get(f"{tk}|{pgb}")
        if par is None or e.sum() < 150:
            continue
        H["L3"][k] = np.clip(smooth(e, r, par), 1e-5, 0.95)
    l1_parent = q("SELECT basis, arg_max(tk, n) tk, any_value(cmg1) cmg1 FROM (SELECT basis, tk, cmg1, count(*) n FROM ev GROUP BY ALL) GROUP BY basis")
    par_of = {b: f"{t}|{c}" for b, t, c in l1_parent.itertuples(index=False)}
    for k, (e, r) in haz["L1"].items():
        b, pgb = k.rsplit("|", 1)
        tc = par_of.get(b)
        par = H["L3"].get(f"{tc}|{pgb}") if tc else None
        if par is None:
            par = H["L4"].get(f"{tc.split('|')[0]}|{pgb}") if tc else None
        if par is None or e.sum() < 200:
            continue
        H["L1"][k] = np.clip(smooth(e, r, par), 1e-5, 0.95)
    # the flat tail beyond MAXH: hazard over days 120-169 of each curve
    M["haz"] = {lvl: {k: (h, float(h[120:MAXH].mean())) for k, h in tab.items()} for lvl, tab in H.items()}
    M["basis_tc"] = par_of
    log(f"hazards L1 {len(H['L1'])} L3 {len(H['L3'])} L4 {len(H['L4'])}")

    # transitions: same hospital? same diagnosis? next care level? keyed by the previous state and the gap
    con.execute("""CREATE TEMP TABLE tr AS SELECT *, CASE WHEN g <= 0 THEN '0' WHEN g <= 3 THEN '1-3' WHEN g <= 10 THEN '4-10' WHEN g <= 30 THEN '11-30'
                   WHEN g <= 90 THEN '31-90' ELSE '91+' END gb, (nf = f)::INT sf, (ndx = dx)::INT sd FROM ev WHERE e""")
    M["trans"] = {}
    for lvl, key, mn in (("T1", "basis || '|' || gb", 300), ("T2", "tk || '|' || cmg1 || '|' || gb", 300), ("T3", "tk || '|' || gb", 0)):
        d = q(f"SELECT {key} k, sf || '|' || sd || '|' || ntk o, count(*) n FROM tr GROUP BY 1, 2")
        M["trans"][lvl] = _tabs(d, ["k"], "o", min_n=mn)
    # a different hospital: one the member used before?
    used = q("""WITH fv AS (SELECT pid, f, min(d) d0 FROM seq GROUP BY 1, 2)
                SELECT avg((fv.d0 < tr.d)::INT) FROM tr LEFT JOIN fv ON fv.pid = tr.pid AND fv.f = tr.nf WHERE tr.sf = 0""")
    M["p_rs_lama"] = float(used.iloc[0, 0])
    # continuation code for the same diagnosis, and what a control visit repeats
    d = q("SELECT basis || '|' || ntk k, nbasis v, count(*) n FROM tr WHERE sd = 1 GROUP BY ALL")
    M["lanjut_basis"] = _tabs(d, ["k"], "v", top=15)
    rep = q("""SELECT avg((npoli IS NOT DISTINCT FROM poli)::INT) poli, avg((nprosedur IS NOT DISTINCT FROM prosedur)::INT) pros,
                      avg((ndxk = dxk)::INT) dxk FROM tr WHERE sf = 1 AND sd = 1 AND nbasis = basis""")
    M["ulang"] = {k: float(rep.iloc[0][k]) for k in ("poli", "pros", "dxk")}
    rep2 = q("SELECT avg((ndxk = dxk)::INT) FROM tr WHERE sd = 1")
    M["ulang"]["dxk_dx"] = float(rep2.iloc[0, 0])
    log(f"transitions; p(used hospital) {M['p_rs_lama']:.2f}, repeats {M['ulang']}")

    # ---- the episode: diagnosis, code, comorbidity, severity, LOS, procedure, poli, status, class ----
    con.execute(f"""CREATE TEMP TABLE ep AS SELECT s.*, {AB_SQL} ab, {JK_SQL} jk, {HG_SQL} hg, r.kelas_rawat hak,
                    (r.segmen IN ('PBI APBN', 'PBI APBD'))::INT pbi, r.kabkota_tinggal_kode kabt
                    FROM s LEFT JOIN r USING (peserta_id) WHERE s.tgl_datang < {W0s}""")
    M["dx"] = {
        "a": _tabs(q("SELECT tingkat_pelayanan tk, hg, ab, jk, dx_primer_icd3 v, count(*) n FROM ep GROUP BY ALL"), ["tk", "hg", "ab", "jk"], "v", min_n=300),
        "b": _tabs(q("SELECT tingkat_pelayanan tk, hg, dx_primer_icd3 v, count(*) n FROM ep GROUP BY ALL"), ["tk", "hg"], "v", min_n=100),
        "c": _tabs(q("SELECT tingkat_pelayanan tk, ab, jk, dx_primer_icd3 v, count(*) n FROM ep GROUP BY ALL"), ["tk", "ab", "jk"], "v"),
    }
    M["basis_dx"] = _tabs(q("SELECT dx_primer_icd3 dx, tingkat_pelayanan tk, basis v, count(*) n FROM ep GROUP BY ALL"), ["dx", "tk"], "v")
    M["basis_tk"] = _tabs(q("SELECT tingkat_pelayanan tk, basis v, count(*) n FROM ep GROUP BY ALL"), ["tk"], "v")
    M["dxs"] = {
        "a": _tabs(q("SELECT tingkat_pelayanan tk, ab, cmg1, least(jumlah_dx_sekunder, 25) v, count(*) n FROM ep GROUP BY ALL"), ["tk", "ab", "cmg1"], "v", min_n=200),
        "b": _tabs(q("SELECT tingkat_pelayanan tk, ab, least(jumlah_dx_sekunder, 25) v, count(*) n FROM ep GROUP BY ALL"), ["tk", "ab"], "v"),
    }
    M["sev"] = {
        "a": _tabs(q("SELECT basis, least(jumlah_dx_sekunder, 4) d4, sev v, count(*) n FROM ep GROUP BY ALL"), ["basis", "d4"], "v", min_n=40),
        "b": _tabs(q("SELECT tingkat_pelayanan tk, cmg1, dg2, least(jumlah_dx_sekunder, 4) d4, sev v, count(*) n FROM ep GROUP BY ALL"), ["tk", "cmg1", "dg2", "d4"], "v"),
    }
    M["los"] = {
        "a": _tabs(q("SELECT inacbg_kode, los_hari v, count(*) n FROM ep WHERE tingkat_pelayanan = 'RITL' GROUP BY ALL"), ["inacbg_kode"], "v", min_n=150),
        "b": _tabs(q("SELECT cmg1, dg2, sev, los_hari v, count(*) n FROM ep WHERE tingkat_pelayanan = 'RITL' GROUP BY ALL"), ["cmg1", "dg2", "sev"], "v", min_n=50),
        "c": _tabs(q("SELECT sev, los_hari v, count(*) n FROM ep WHERE tingkat_pelayanan = 'RITL' GROUP BY ALL"), ["sev"], "v"),
    }
    la = q("SELECT ab, avg(los_hari / greatest(m, 1)) r FROM ep JOIN medlos USING (inacbg_kode) WHERE tingkat_pelayanan = 'RITL' GROUP BY 1")
    M["los_age"] = {int(a): float(r) / g_los for a, r in la.itertuples(index=False)}
    M["prosedur"] = {
        "a": _tabs(q("SELECT inacbg_kode, prosedur v, count(*) n FROM ep GROUP BY ALL"), ["inacbg_kode"], "v", top=80, min_n=30),
        "b": _tabs(q("SELECT basis, prosedur v, count(*) n FROM ep GROUP BY ALL"), ["basis"], "v", top=80),
    }
    M["poli"] = {
        "a": _tabs(q("SELECT inacbg_kode, dx_primer_icd3 dx, poli v, count(*) n FROM ep WHERE tingkat_pelayanan = 'RJTL' GROUP BY ALL"), ["inacbg_kode", "dx"], "v", min_n=60),
        "b": _tabs(q("SELECT inacbg_kode, poli v, count(*) n FROM ep WHERE tingkat_pelayanan = 'RJTL' GROUP BY ALL"), ["inacbg_kode"], "v"),
    }
    M["dxk"] = _tabs(q("SELECT dx_primer_icd3 dx, dx_primer_kode v, count(*) n FROM ep GROUP BY ALL"), ["dx"], "v", top=40)
    M["dxk_nama"] = dict(q("SELECT dx_primer_kode, mode(dx_primer_nama) FROM s GROUP BY 1").itertuples(index=False))
    M["masuk"] = _tabs(q("SELECT dx_primer_icd3 dx, dx_masuk_kode v, count(*) n FROM ep GROUP BY ALL"), ["dx"], "v", top=30)
    M["masuk_nama"] = dict(q("SELECT dx_masuk_kode, mode(dx_masuk_nama) FROM s GROUP BY 1").itertuples(index=False))
    M["status"] = _tabs(q("SELECT tingkat_pelayanan tk, sev, ab, status_pulang v, count(*) n FROM ep GROUP BY ALL"), ["tk", "sev", "ab"], "v")
    M["kelas"] = _tabs(q("SELECT coalesce(hak, '') hak, pbi, kelas_rawat v, count(*) n FROM ep WHERE tingkat_pelayanan = 'RITL' GROUP BY ALL"), ["hak", "pbi"], "v")
    M["flow"] = {
        "kab": _tabs(q("SELECT kabt, f v, count(*) n FROM ep WHERE kabt IS NOT NULL GROUP BY ALL"), ["kabt"], "v", top=60, min_n=30),
        "prov": _tabs(q("SELECT kabt // 100 pv, f v, count(*) n FROM ep WHERE kabt IS NOT NULL GROUP BY ALL"), ["pv"], "v", top=120),
        "nas": _tabs(q("SELECT 'x' k, f v, count(*) n FROM ep GROUP BY ALL"), ["k"], "v", top=400),
    }
    # per hospital and care level: its own most frequent codes (the last fallback of an episode)
    M["rs_kode"] = _tabs(q("SELECT f, tingkat_pelayanan tk, inacbg_kode v, count(*) n FROM ep GROUP BY ALL"), ["f", "tk"], "v", top=25)
    M["rs_poli"] = _tabs(q("SELECT f, poli v, count(*) n FROM ep WHERE tingkat_pelayanan = 'RJTL' GROUP BY ALL"), ["f"], "v", top=30)
    log("episode tables")

    # new claimants (first claim of the year in Sep-Dec 17): their care level and age/sex propensity against the registry
    nw = q("""WITH fst AS (SELECT peserta_id, min(tgl_datang) d0 FROM s GROUP BY 1)
               SELECT ep.tingkat_pelayanan tk, ep.ab, ep.jk, count(*) n FROM ep JOIN fst ON fst.peserta_id = ep.peserta_id AND ep.tgl_datang = fst.d0
               WHERE fst.d0 >= DATE '2024-09-01' GROUP BY ALL""")
    M["baru_tk"] = _tabs(nw.groupby("tk", as_index=False).n.sum().assign(k="x"), ["k"], "tk")["x"]
    reg = q(f"SELECT {AB_SQL.replace('s.tgl_datang', W0s)} ab, {JK_SQL} jk, count(*) n FROM r GROUP BY ALL")
    a = nw.groupby(["ab", "jk"]).n.sum() / nw.n.sum()
    b = reg.set_index(["ab", "jk"]).n / reg.n.sum()
    M["baru_w"] = {(int(k[0]), k[1]): float(a.get(k, 0) / v) for k, v in b.items() if v > 0}

    # calendar weights of the window per care level (the real daily volume shape of 18-31 Dec)
    cal = q("SELECT tgl_datang d, tingkat_pelayanan tk, count(*) n FROM s WHERE tgl_datang BETWEEN DATE '2024-12-18' AND DATE '2024-12-31' GROUP BY ALL")
    M["kalender"] = {}
    for tk, g in cal.groupby("tk"):
        w = {pd.Timestamp(x).date(): float(n) for x, n in zip(g.d, g.n)}
        mx = max(w.values())
        M["kalender"][tk] = {k: v / mx for k, v in w.items()}

    # registry segment spelling as the claims write it
    M["segmen_map"] = {"PBI APBN": "PBI APBN", "PBI APBD": "PBI APBD", "PBPU": "PBPU", "PPU": "PPU", "BUKAN PEKERJA": "Bukan pekerja"}
    log("new claimants, calendar")

    # ---- the member pool: test roles only, without the replay stream's members and old training members ----
    reg = q("""SELECT peserta_id pid, jenis_kelamin, tgl_lahir lahir, kelas_rawat hak, segmen, kabkota_tinggal_kode kab, kabkota_fktp_terdaftar_kode kab_fktp,
                      keluarga_id kel, tahun_meninggal thn_mati, flag_tgl_lahir_pengganti lahir_pengganti FROM r""")
    reg["peran"] = bersih.peran_array(reg.pid.values)
    reg = reg[reg.peran.isin(["uji_c", "gen2_baru"])].copy()
    ex = bersih.dipakai()["aliran"] | bersih._peserta_npz("data_v2/fitur_*.npz") | bersih._peserta_npz("data_v2_bersih/fitur_*.npz")
    reg = reg[~reg.pid.isin(ex)].copy()
    reg["jk"] = reg.jenis_kelamin.map({"LAKI-LAKI": "L", "PEREMPUAN": "P"}).fillna("")
    reg["chunk"] = [chunk_of(p) for p in reg.pid.values]
    con.register("pool", reg[["pid"]])
    hist = q(f"""SELECT s.peserta_id pid, tgl_datang d, tgl_pulang p, kunjungan_fkrtl_id id, f, tingkat_pelayanan tk, inacbg_kode kode, basis, cmg1,
                        dx_primer_icd3 dx, dx_primer_kode dxk, poli, prosedur, status_pulang status, segmen, kelas_rawat kelas, los_hari los,
                        jumlah_dx_sekunder dxs FROM s JOIN pool ON pool.pid = s.peserta_id WHERE tgl_datang < {W0s} ORDER BY pid, d, p, id""")
    reg["n_hist"] = reg.pid.map(hist.groupby("pid").size()).fillna(0).astype(int)
    reg["mati_hist"] = reg.pid.isin(set(hist.loc[hist.status == "Meninggal", "pid"]))
    reg = reg.drop(columns=["jenis_kelamin", "peran"]).sort_values("pid", kind="mergesort").reset_index(drop=True)
    reg.to_parquet(OUT / "anggota.parquet", index=False)
    hist.to_parquet(OUT / "riwayat.parquet", index=False)
    log(f"pool {len(reg):,} members ({(reg.n_hist > 0).sum():,} with history), history rows {len(hist):,}")

    with open(OUT / "model.pkl", "wb") as fh:
        pickle.dump(M, fh, protocol=pickle.HIGHEST_PROTOCOL)
    log(f"saved {OUT}")


# ------------------------------------------------------------------------------------------------------------------
# the world: the fitted model, the hospitals, the member pool and their history
# ------------------------------------------------------------------------------------------------------------------
_DUNIA: Optional["Dunia"] = None


def dunia() -> "Dunia":
    global _DUNIA
    if _DUNIA is None:
        _DUNIA = Dunia()
    return _DUNIA


class Dunia:
    def __init__(self) -> None:
        import pandas as pd

        if not (OUT / "model.pkl").is_file():
            raise RuntimeError(f"{OUT / 'model.pkl'} belum ada: jalankan `python testing/generator3.py fit` dulu")
        class _Unpickler(pickle.Unpickler):  # the model loads whether this file runs as a script or is imported
            def find_class(self, module, name):
                return Tab if name == "Tab" else super().find_class(module, name)

        with open(OUT / "model.pkl", "rb") as fh:
            self.M = _Unpickler(fh).load()
        M = self.M
        self.rs: dict[str, dict] = M["rs"]
        self.tarif: dict[tuple, int] = M["tarif"]
        self.kode: dict[str, dict] = M["kode"]
        # LOS distributions sorted by value (for the proportional-hazards draw)
        self.los: dict[str, dict] = {}
        for lvl, tabs in M["los"].items():
            out = {}
            for k, t in tabs.items():
                w = np.diff(np.concatenate([[0.0], t.c]))
                o = np.argsort(np.asarray(t.v, dtype=float))
                v = np.asarray(t.v, dtype=float)[o]
                c = np.cumsum(w[o])
                out[k] = (v, c / c[-1])
            self.los[lvl] = out
        # inverse grouper map: which diagnoses lead to a base group (a plausible diagnosis for a given code)
        inv: dict[tuple, Counter] = defaultdict(Counter)
        for (dx, tk), t in M["basis_dx"].items():
            w = np.diff(np.concatenate([[0.0], t.c]))
            for b, wi in zip(t.v, w):
                inv[(b, tk)][dx] += wi
        self.dx_of = {k: Tab(list(c.keys()), list(c.values())) for k, c in inv.items()}
        # base groups per (CMG letter, 2nd digit, care level) with their volume
        bt: dict[tuple, Counter] = defaultdict(Counter)
        for tk, t in M["basis_tk"].items():
            w = np.diff(np.concatenate([[0.0], t.c]))
            for b, wi in zip(t.v, w):
                bt[(b[0], b[2], tk)][b] += wi
        self.basis_grup = {k: Tab(list(c.keys()), list(c.values())) for k, c in bt.items()}
        self.topup_des = {(col, tk): des for lst in M["topup_inc"].values() for col, tk, des, _ in lst}
        # members and their history
        a = pd.read_parquet(OUT / "anggota.parquet")
        lahir = pd.to_datetime(a.lahir)
        a["usia"] = ((pd.Timestamp(W0) - lahir).dt.days / 365.25).astype(float)
        self.anggota = a
        h = pd.read_parquet(OUT / "riwayat.parquet")
        h["d"] = pd.to_datetime(h.d).dt.date
        h["p"] = pd.to_datetime(h.p).dt.date
        self.riwayat = {pid: g for pid, g in h.groupby("pid", sort=False)}
        # routine-series patients of each hospital among the pool (dialysis / physiotherapy / rehabilitation / wound care)
        self.rutin_pool = h[h.kode.isin(RUTIN)].groupby("f").pid.nunique().to_dict()
        self.rng_global = np.random.default_rng(_h(GARAM + "|rs"))
        self.rs_skema = self._pilih_rs()

    # ---- the dishonest hospitals, fixed once for every chunk ----
    def _pilih_rs(self) -> dict[str, list]:
        rng = self.rng_global
        R = self.rs
        dipakai: set[str] = set()

        def ambil(cands: list[tuple[str, float]], k: int) -> list[str]:
            c = [(x, float(w)) for x, w in cands if x not in dipakai and w > 0]
            out = []
            for _ in range(k):
                if not c:
                    break
                p = np.array([w for _, w in c], dtype=float)
                i = int(rng.choice(len(c), p=p / p.sum()))
                out.append(c[i][0])
                dipakai.add(c[i][0])
                c.pop(i)
            return out

        # hospitals large enough for a systematic scheme to show in a 14-day sample of members
        ri = sorted((f, r["n_ri"]) for f, r in R.items() if r["n_ri"] >= 450 and r["jenis"] == "Rumah sakit")
        rj = sorted((f, r["n"]) for f, r in R.items() if r["n"] >= 4000 and r["jenis"] == "Rumah sakit")
        mid = sorted((f, r["n"]) for f, r in R.items() if r["n"] >= 1500 and r["jenis"] == "Rumah sakit")
        out: dict[str, list] = {}
        for sk in ("upcoding_keparahan", "geser_bertahap", "pulang_dini", "pulang_dini_readmisi", "naik_kelas", "kloning"):
            out[sk] = ambil(ri, SKEMA[sk]["rs"])
        for sk in ("tagihan_gelembung", "klaim_fiktif", "rawat_inap_tanpa_indikasi"):
            out[sk] = ambil(rj, SKEMA[sk]["rs"])
        # routine series: hospitals whose outpatient volume leans on dialysis / physiotherapy / rehabilitation / wound care
        rutin = sorted((f, float(n) ** 2) for f, n in self.rutin_pool.items() if R[f]["jenis"] == "Rumah sakit")  # many series patients
        out["sesi_rutin_fiktif"] = ambil(rutin, SKEMA["sesi_rutin_fiktif"]["rs"])
        # referral pairs: A refers to an affiliated B in the same kab/kota
        def kawan(f: str, same, k: int) -> bool:
            return sum(1 for g, _ in mid if g != f and g not in dipakai and same(R[g], R[f])) >= k

        pairs = []
        for _ in range(SKEMA["rujukan_semu"]["rs"]):
            a = ambil([(f, w) for f, w in rj if kawan(f, lambda x, y: x["kab"] == y["kab"], 1)], 1)
            if not a:
                break
            b = ambil([(f, w) for f, w in mid if R[f]["kab"] == R[a[0]]["kab"]], 1)
            if b:
                pairs.append((a[0], b[0]))
        out["rujukan_semu"] = pairs
        # a specialist practising at three hospitals of one province (A is where the patients start)
        groups = []
        for _ in range(SKEMA["dokter_tiga_rs"]["rs"]):
            a = ambil([(f, w) for f, w in rj if kawan(f, lambda x, y: x["kab"] // 100 == y["kab"] // 100, 2)], 1)
            if not a:
                break
            pv = R[a[0]]["kab"] // 100
            bc = ambil([(f, w) for f, w in mid if R[f]["kab"] // 100 == pv], 2)
            if len(bc) == 2:
                pa = self.M["rs_poli"].get(a[0])
                spes = [p for p in (pa.v if pa else []) if p not in (None, "IGD", "HDL", "IRM", "GIG", "KON", "BDM", "RDT", "KEM")]
                groups.append((a[0], bc[0], bc[1], spes[0] if spes else "INT"))
        out["dokter_tiga_rs"] = groups
        return out

    # ---- lookups ----
    def hazard(self, basis: str, tk: str, pgb: str) -> tuple:
        H = self.M["haz"]
        r = H["L1"].get(f"{basis}|{pgb}")
        if r is None:
            tc = self.M["basis_tc"].get(basis) or f"{tk}|{basis[:1]}"
            r = H["L3"].get(f"{tc}|{pgb}")
        if r is None:
            r = H["L4"].get(f"{tk}|{pgb}") or H["L4"][f"{tk}|baru"]
        return r

    def tarif_of(self, kode: str, f: str, kelas: str) -> Optional[int]:
        r = self.rs[f]
        t = self.tarif.get((kode, _k(r["regional"]), _k(r["tipe"]), _k(r["kep"]), _k(kelas)))
        if t is None:
            t = self.M["tarif_saudara"].get((kode, _k(r["regional"]), _k(r["tipe"]), _grup_kep(r["kep"]), _k(kelas)))
        return t

    def topup_amt(self, col: str, tk: str, f: str) -> int:
        r = self.rs[f]
        v = self.M["topup_amt"].get((col, tk, _k(r["regional"]), _k(r["tipe"]), _k(r["kep"])))
        if v is None:
            v = self.M["topup_med"].get((col, tk), (0, 0, 0))[0]
        return int(v)

    def los_draw(self, kode: str, rng: np.random.Generator, rho: float) -> int:
        L = self.los
        sev = kode.rsplit("-", 1)[1]
        t = L["a"].get(kode) or L["b"].get((kode[0], kode[2], sev)) or L["c"].get(sev) or L["c"]["I"]
        v, cdf = t
        u = 1.0 - rng.random() ** rho  # proportional hazards: rho > 1 gives longer stays
        return int(v[min(int(np.searchsorted(cdf, u, side="left")), len(v) - 1)])


RUTIN = ("N-3-15-0", "M-3-16-0", "Z-3-12-0", "Z-3-27-0")  # dialysis, physiotherapy, rehabilitation, wound care


# ------------------------------------------------------------------------------------------------------------------
# episodes
# ------------------------------------------------------------------------------------------------------------------
def _hak(m: dict) -> str:
    return {"KELAS I": "Kelas 1", "KELAS II": "Kelas 2", "KELAS III": "Kelas 3"}.get(m.get("hak") or "", "Kelas 3")


def _pick_kelas(D: Dunia, m: dict, rng) -> str:
    t = D.M["kelas"].get((m.get("hak") or "", int(m["pbi"]))) or D.M["kelas"].get(("", int(m["pbi"])))
    return t.pick(rng) if t is not None else _hak(m)


def _isi_biaya(D: Dunia, e: dict, rng, topup_baru: bool = True) -> bool:
    """Tariff, top-ups and bill of an episode; False when the hospital's tariff table has no such key."""
    t = D.tarif_of(e["kode"], e["f"], e["kelas"])
    if t is None:
        return False
    e["tarif"] = t
    if topup_baru:
        e["topup"] = {}
        n = D.kode.get(e["kode"], {}).get("n", 0)
        for col, tk, des, k in D.M["topup_inc"].get(e["kode"], []):
            if col not in e["topup"] and n > 0 and rng.random() < k / n:
                e["topup"][col] = (tk, des, D.topup_amt(col, tk, e["f"]))
    else:
        e["topup"] = {col: (tk, des, D.topup_amt(col, tk, e["f"])) for col, (tk, des, _) in e.get("topup", {}).items()}
    _tagih(D, e, rng)
    return True


def _tagih(D: Dunia, e: dict, rng=None) -> None:
    tu = sum(v[2] for v in e["topup"].values())
    b85 = e.get("_b85")
    if b85 is None:
        sh = D.M["b85"].get((e["f"], e["kode"]), 0.0)
        b85 = bool(rng is not None and sh > 0 and rng.random() < sh)
        e["_b85"] = b85
    e["bill"] = int(round(e["tarif"] * 0.85)) + tu if b85 else e["tarif"] + tu


def _sev_tab(D: Dunia, basis: str, tk: str, dxs: int):
    S = D.M["sev"]
    return S["a"].get((basis, min(dxs, 4))) or S["b"].get((tk, basis[0], basis[2], min(dxs, 4)))


def _set_kode(D: Dunia, e: dict, kode: str, rng, topup_baru: bool = False) -> bool:
    """Re-code an episode (same hospital and class) and re-price it from the tariff table; False if the key is missing."""
    old = {k: e.get(k) for k in ("kode", "basis", "sev", "tarif", "topup", "bill", "_b85")}
    e["kode"], e["basis"], e["sev"] = kode, kode.rsplit("-", 1)[0], kode.rsplit("-", 1)[1]
    e["_b85"] = None
    if not _isi_biaya(D, e, rng, topup_baru=topup_baru):
        e.update(old)
        return False
    return True


def _pros(D: Dunia, kode: str, rng, wajib: bool = False) -> Optional[str]:
    t = D.M["prosedur"]["a"].get(kode) or D.M["prosedur"]["b"].get(kode.rsplit("-", 1)[0])
    if t is None:
        return None
    for _ in range(12):
        x = t.pick(rng)
        if x or not wajib:
            return x
    return next((x for x in t.v if x), None)


def episode(D: Dunia, m: dict, f: str, tk: str, d: date, rng, dx: Optional[str] = None, basis: Optional[str] = None,
            prev: Optional[dict] = None, rho: float = 1.0, ab: Optional[int] = None, jk: Optional[str] = None) -> Optional[dict]:
    """One episode for member m at hospital f on day d: diagnosis -> base group -> comorbidity -> severity -> class -> tariff
    -> LOS -> procedure, poli, status. prev: the claim this one continues (a control visit repeats its poli/procedure).
    ab/jk: the demography of the person actually treated (a borrowed card), default the member's."""
    M = D.M
    R = D.rs[f]
    hg = R["hg"]
    ab = m["ab"] if ab is None else ab
    jk = m["jk"] if jk is None else jk
    kode = None
    for tries in range(8):
        dx_i = dx if (dx and tries < 5) else None
        if dx_i is None:
            t = M["dx"]["a"].get((tk, hg, ab, jk)) or (M["dx"]["b"].get((tk, hg)) if hg != "Umum" else None) \
                or M["dx"]["c"].get((tk, ab, jk)) or M["dx"]["c"].get((tk, 2, "P"))
            dx_i = t.pick(rng)
        b = basis if (basis and tries < 3) else None
        if b is None:
            t = M["basis_dx"].get((dx_i, tk)) or M["basis_tk"][tk]
            b = t.pick(rng)
        td = M["dxs"]["a"].get((tk, ab, b[0])) or M["dxs"]["b"].get((tk, ab)) or M["dxs"]["b"][(tk, 2)]
        dxs = int(td.pick(rng))
        st = _sev_tab(D, b, tk, dxs)
        sevs = [st.pick(rng)] if st is not None else []
        sevs += [s for s in (["I", "II", "III"] if tk == "RITL" else ["0"]) if s not in sevs]
        kelas = _pick_kelas(D, m, rng) if tk == "RITL" else "Kelas 3"
        for sv in sevs:
            k = f"{b}-{sv}"
            if D.tarif_of(k, f, kelas) is not None:
                kode = k
                break
        if kode is not None:
            break
    if kode is None:
        # the hospital's own frequent codes for this care level
        t = M["rs_kode"].get((f, tk))
        if t is None:
            return None
        kelas = _pick_kelas(D, m, rng) if tk == "RITL" else "Kelas 3"
        for _ in range(10):
            k = t.pick(rng)
            if D.tarif_of(k, f, kelas) is not None:
                kode = k
                break
        if kode is None:
            return None
        b = kode.rsplit("-", 1)[0]
        dx_i = (D.dx_of.get((b, tk)) or M["dx"]["c"][(tk, 2, "P")]).pick(rng)
        dxs = int((M["dxs"]["b"].get((tk, ab)) or M["dxs"]["b"][(tk, 2)]).pick(rng))
    sev = kode.rsplit("-", 1)[1]
    e = {"pid": m["pid"], "f": f, "tk": tk, "d": d, "dx": dx_i, "basis": kode.rsplit("-", 1)[0], "kode": kode, "sev": sev, "dxs": dxs,
         "kelas": kelas, "segmen": m["segmen"], "_sk": "normal", "_varian": "", "_menit": int(rng.integers(0, 1440)), "_b85": None}
    e["los"] = D.los_draw(kode, rng, rho * float(R.get("los_idx") or 1.0) * M["los_age"].get(ab, 1.0)) if tk == "RITL" else 0
    e["p"] = d + timedelta(days=e["los"])
    U = M["ulang"]
    same = prev is not None and prev.get("f") == f and prev.get("kode") == kode
    e["prosedur"] = prev.get("prosedur") if (same and rng.random() < U["pros"]) else _pros(D, kode, rng)
    if tk == "RJTL":
        if same and prev.get("poli") and rng.random() < U["poli"]:
            e["poli"] = prev.get("poli")
        else:
            t = M["poli"]["a"].get((kode, dx_i)) or M["poli"]["b"].get(kode) or M["rs_poli"].get(f)
            e["poli"] = t.pick(rng) if t is not None else "INT"
    else:
        e["poli"] = None
    if prev is not None and prev.get("dx") == dx_i and prev.get("dxk") and rng.random() < U["dxk_dx"]:
        e["dxk"] = prev["dxk"]
    else:
        t = M["dxk"].get(dx_i)
        e["dxk"] = t.pick(rng) if t is not None else dx_i
    t = M["masuk"].get(dx_i)
    e["masuk"] = t.pick(rng) if t is not None else e["dxk"]
    t = M["status"].get((tk, sev, ab)) or M["status"].get((tk, sev, 2))
    e["status"] = t.pick(rng) if t is not None else "Sehat"
    if not _isi_biaya(D, e, rng):
        return None
    return e


# ------------------------------------------------------------------------------------------------------------------
# journeys
# ------------------------------------------------------------------------------------------------------------------
def _kalender(D: Dunia, tk: str, d: date, rng) -> date:
    """Move a visit off a day hospitals barely work (Sunday, Christmas) to the next day, as patients do."""
    w = D.M["kalender"].get(tk, {})
    for _ in range(3):
        if d > W1 or rng.random() < w.get(d, 1.0):
            return d
        d = d + timedelta(days=1)
    return d


def _h_at(h: tuple, g: int) -> float:
    arr, tail = h
    return float(arr[g]) if g < len(arr) else tail


def p_jendela(D: Dunia, st: dict) -> float:
    """The member's natural probability of >= 1 claim in the window, from the state of their last claim."""
    h = D.hazard(st["basis"], st["tk"], st["pgb"])
    g0 = max((W0 - st["p"]).days, 0)
    n = (W1 - max(st["p"], W0)).days + 1
    s = 1.0
    for g in range(g0, g0 + n):
        s *= 1.0 - _h_at(h, g)
    return 1.0 - s


def _transisi(D: Dunia, st: dict, g: int, rng) -> tuple[int, int, str]:
    T = D.M["trans"]
    gb = _gb(g)
    t = T["T1"].get(f"{st['basis']}|{gb}") or T["T2"].get(f"{st['tk']}|{st['basis'][:1]}|{gb}") or T["T3"].get(f"{st['tk']}|{gb}") \
        or T["T3"][f"RJTL|{gb}"]
    sf, sd, ntk = t.pick(rng).split("|")
    return int(sf), int(sd), ntk


def _rs_lain(D: Dunia, m: dict, f_not: Optional[str], rng, lama: bool = True) -> str:
    """A hospital other than f_not: one the member used before (as often as the data shows) or one from the member's
    kab/kota referral flow (then province, then national)."""
    used = [x for x in m["rs_set"] if x != f_not]
    if lama and used and rng.random() < D.M["p_rs_lama"]:
        return used[int(rng.integers(0, len(used)))]
    fl = D.M["flow"]
    kab = int(m["kab"]) if m.get("kab") else -1
    for t in (fl["kab"].get(kab), fl["prov"].get(kab // 100), fl["nas"]["x"]):
        if t is None:
            continue
        for _ in range(8):
            x = t.pick(rng)
            if x != f_not and x in D.rs:
                return x
    return next(x for x in D.rs if x != f_not)


def _lanjut(D: Dunia, m: dict, st: dict, d: date, g: int, rng) -> Optional[dict]:
    """The next claim after state st, on day d (g days after st's discharge)."""
    sf, sd, ntk = _transisi(D, st, g, rng)
    f = st["f"] if (sf and st["f"] in D.rs) else _rs_lain(D, m, st["f"], rng)
    d = _kalender(D, ntk, d, rng)
    if d > W1:
        return None
    if sd:
        t = D.M["lanjut_basis"].get(f"{st['basis']}|{ntk}")
        return episode(D, m, f, ntk, d, rng, dx=st["dx"], basis=t.pick(rng) if t is not None else None, prev=st)
    return episode(D, m, f, ntk, d, rng)


def jalani(D: Dunia, m: dict, rng, mulai: Optional[date] = None, maks: int = 12) -> list[dict]:
    """A member's claims in the window. With history: the first claim follows the last history claim (conditioned on
    falling in the window); then each claim's own hazard drives the next. New member: first claim on day `mulai`."""
    eps: list[dict] = []
    st = m.get("last")
    if st is None:
        tk = D.M["baru_tk"].pick(rng)
        f = _rs_lain(D, m, None, rng, lama=False)
        d = _kalender(D, tk, mulai or W0, rng)
        if d > W1:
            return eps
        e = episode(D, m, f, tk, d, rng)
        if e is None:
            return eps
        e["_pg"] = None
        eps.append(e)
    else:
        # first claim: its day drawn from S(g) h(g), the law of the first return given one falls in the window
        h = D.hazard(st["basis"], st["tk"], st["pgb"])
        g0 = max((W0 - st["p"]).days, 0)
        start = max(st["p"], W0)
        n = (W1 - start).days + 1
        s, w = 1.0, []
        for g in range(g0, g0 + n):
            hg_ = _h_at(h, g)
            w.append(s * hg_)
            s *= 1.0 - hg_
        w = np.asarray(w)
        if n <= 0 or w.sum() <= 0:
            return eps
        i = int(rng.choice(len(w), p=w / w.sum()))
        e = _lanjut(D, m, st, start + timedelta(days=i), g0 + i, rng)
        if e is None:
            return eps
        e["_pg"] = g0 + i
        eps.append(e)
    while len(eps) < maks and eps[-1]["status"] != "Meninggal":
        cur = eps[-1]
        cur_st = {**cur, "pgb": _pgb(cur.get("_pg"))}
        h = D.hazard(cur["basis"], cur["tk"], cur_st["pgb"])
        nxt = None
        for g in range(0, (W1 - cur["p"]).days + 1):
            if rng.random() < _h_at(h, g):
                nxt = g
                break
        if nxt is None:
            break
        e = _lanjut(D, m, cur_st, cur["p"] + timedelta(days=nxt), nxt, rng)
        if e is None:
            break
        e["_pg"] = nxt
        eps.append(e)
    return eps


# ------------------------------------------------------------------------------------------------------------------
# the chunk's population: members with history (natural window probability), new claimants, reserve, deceased
# ------------------------------------------------------------------------------------------------------------------
P_RIWAYAT = 0.84  # share of window claims by members with an earlier 2024 claim (silver: 0.83 on 1-14 Nov, 0.85 on 18-31 Dec)
PBI_REG = ("PBI APBN", "PBI APBD")


def _anggota(D: Dunia, r: Any) -> dict:
    kab = None if r.kab is None or r.kab != r.kab else int(r.kab)
    m = {"pid": int(r.pid), "jk": r.jk or "", "usia": None if r.usia != r.usia else float(r.usia), "ab": _ab(r.usia), "hak": r.hak,
         "pbi": int(r.segmen in PBI_REG), "segmen_reg": r.segmen, "kab": kab, "kel": r.kel, "thn_mati": r.thn_mati, "n_hist": int(r.n_hist),
         "segmen": D.M["segmen_map"].get(r.segmen or "", r.segmen), "rs_set": [], "rs": None, "last": None, "riwayat_rs": {}}
    g = D.riwayat.get(int(r.pid))
    if g is not None and len(g):
        rows = g.to_dict("records")
        last = rows[-1]
        pg = (last["d"] - rows[-2]["p"]).days if len(rows) > 1 else None
        m["last"] = {"f": last["f"], "tk": last["tk"], "kode": last["kode"], "basis": last["basis"], "dx": last["dx"], "dxk": last["dxk"],
                     "poli": last["poli"], "prosedur": last["prosedur"], "d": last["d"], "p": last["p"], "pgb": _pgb(pg)}
        m["rs"] = last["f"]
        m["rs_set"] = list(dict.fromkeys(x["f"] for x in rows))
        m["riwayat_rs"] = {x["f"]: x for x in rows}  # the last claim at each hospital
        if last.get("segmen"):
            m["segmen"] = last["segmen"]
    return m


def _populasi(D: Dunia, c: int, kecuali: set[int], rng) -> dict:
    a = D.anggota
    a = a[(a.chunk == c) & ~a.pid.isin(kecuali)].sort_values("pid", kind="mergesort")
    hidup = a.thn_mati.isna() & ~a.mati_hist
    H, N, X = a[hidup & (a.n_hist > 0)], a[hidup & (a.n_hist == 0)], a[~hidup]
    eps: list[dict] = []
    members: dict[int, dict] = {}
    cad_h: list[dict] = []
    # members with history: weighted sampling without replacement by the natural window probability
    hm = [_anggota(D, r) for r in H.itertuples(index=False)]
    p = np.array([max(p_jendela(D, m["last"]), 1e-6) for m in hm])
    order = np.argsort(-(rng.random(len(hm)) ** (1.0 / p)))
    target_h = int(round(TARGET * P_RIWAYAT))
    n_h = 0
    for i in order:
        m = hm[i]
        if n_h >= target_h:
            cad_h.append(m)
            continue
        e = jalani(D, m, rng)
        if not e:
            cad_h.append(m)
            continue
        m["sumber"] = "perjalanan"
        members[m["pid"]] = m
        eps += e
        n_h += len(e)
    # new claimants (no 2024 claim before the window): weighted by the age/sex propensity of a first claim
    w = np.array([max(D.M["baru_w"].get((_ab(u), j or ""), 0.0), 1e-3) for u, j in zip(N.usia.values, N.jk.values)])
    order = np.argsort(-(rng.random(len(N)) ** (1.0 / w)))
    rows = list(N.itertuples(index=False))
    n_b, target_b = 0, TARGET - n_h
    cad_b: list = []
    for i in order:
        if n_b >= target_b:
            cad_b.append(rows[i])
            continue
        m = _anggota(D, rows[i])
        e = jalani(D, m, rng, mulai=W0 + timedelta(days=int(rng.integers(0, NDAY))))
        if not e:
            continue
        m["sumber"] = "baru"
        members[m["pid"]] = m
        eps += e
        n_b += len(e)
    return {"eps": eps, "members": members, "cad_h": cad_h, "cad_b": cad_b, "mati": list(X.itertuples(index=False))}


# ------------------------------------------------------------------------------------------------------------------
# fraud
# ------------------------------------------------------------------------------------------------------------------
class Ctx:
    """The chunk under construction: its episodes, members, reserve, and the helpers the schemes share."""

    def __init__(self, D: Dunia, pop: dict, rng) -> None:
        self.D, self.rng = D, rng
        self.eps: list[dict] = pop["eps"]
        self.members: dict[int, dict] = pop["members"]
        self.cad_h: list[dict] = pop["cad_h"]
        self.cad_b: list = pop["cad_b"]
        self.mati: list = pop["mati"]
        self.terpakai: set[int] = set(self.members)
        self.seq = 0
        for e in self.eps:
            self._seq(e)

    def _seq(self, e: dict) -> dict:
        e["_seq"] = self.seq
        self.seq += 1
        return e

    def tambah(self, e: dict) -> dict:
        self.eps.append(self._seq(e))
        return e

    def of(self, pid: int) -> list[dict]:
        return [x for x in self.eps if x["pid"] == pid]

    def normal(self, cond=None) -> list[dict]:
        return [e for e in self.eps if e["_sk"] == "normal" and (cond is None or cond(e))]

    @staticmethod
    def _span(e: dict) -> tuple[date, date]:
        return e["d"], (e["p"] - timedelta(days=1)) if e["los"] >= 1 else e["d"]

    def bebas(self, pid: int, e_new: dict, abaikan: tuple = (), hari_sama_rs_lain: bool = True) -> bool:
        """No overlap of e_new's stay with the member's other claims, and (by default) no claim the same day."""
        a0, a1 = self._span(e_new)
        for x in self.of(pid):
            if any(x is y for y in abaikan) or x is e_new:
                continue
            b0, b1 = self._span(x)
            if a0 <= b1 and b0 <= a1:
                return False
            if hari_sama_rs_lain and x["d"] == e_new["d"]:
                return False
        return True

    def p(self, x: float) -> bool:
        return self.rng.random() < x

    def u(self, ab: tuple) -> float:
        return float(self.rng.uniform(ab[0], ab[1]))

    def ri(self, ab: tuple) -> int:
        return int(self.rng.integers(ab[0], ab[1] + 1))

    def varian(self, w: dict) -> str:
        k = list(w)
        p = np.array([w[x] for x in k], dtype=float)
        return k[int(self.rng.choice(len(k), p=p / p.sum()))]

    def m(self, pid: int) -> dict:
        return self.members[pid]


def _tandai(e: dict, sk: str, var: str = "") -> dict:
    e["_sk"], e["_varian"] = sk, var
    return e


def _salin(e: dict, **kw) -> dict:
    x = {k: (dict(v) if isinstance(v, dict) else v) for k, v in e.items()}
    x.update(kw)
    return x


def _naik_sev(sev: str, dua: bool = False) -> Optional[str]:
    order = ["I", "II", "III"]
    if sev not in order or sev == "III":
        return None
    return order[min(order.index(sev) + (2 if dua else 1), 2)]


def _dx_terkait(D: Dunia, m: dict, e: dict, f: str, rng) -> str:
    """A related diagnosis (same ICD-10 chapter letter) for a complication or a return."""
    M = D.M
    t = M["dx"]["a"].get(("RITL", D.rs[f]["hg"], m["ab"], m["jk"])) or M["dx"]["c"].get(("RITL", m["ab"], m["jk"])) or M["dx"]["c"][("RITL", 2, "P")]
    for _ in range(40):
        x = t.pick(rng)
        if x[0] == e["dx"][0] and x != e["dx"]:
            return x
    return e["dx"]


def _fr_pulang_dini(C: Ctx) -> None:
    S = SKEMA["pulang_dini"]
    rs = set(C.D.rs_skema["pulang_dini"])
    # a stay at or above its code's median (and >= los_min days) is cut to 35-60 %
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["f"] in rs and e["los"] >= max(S["los_min"], C.D.kode[e["kode"]]["med"])
                      and e["status"] != "Meninggal"):
        if not C.p(S["porsi_rs"]):
            continue
        new = max(1, int(round(e["los"] * C.u(S["potong"]))))
        if new < e["los"]:
            e["los"], e["p"] = new, e["d"] + timedelta(days=new)
            _tandai(e, "pulang_dini", "rs")


def _fr_pulang_dini_readmisi(C: Ctx) -> None:
    S = SKEMA["pulang_dini_readmisi"]
    D, rng = C.D, C.rng
    rs = set(D.rs_skema["pulang_dini_readmisi"])
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["los"] >= max(S["los_min"], D.kode[e["kode"]]["med"]) and e["status"] != "Meninggal"
                      and e["d"] <= W1 - timedelta(days=2)):
        if not C.p(S["porsi_rs"] if e["f"] in rs else S["p"]):
            continue
        m = C.m(e["pid"])
        l1 = max(1, int(round(e["los"] * C.u(S["potong"]))))
        if l1 >= e["los"]:
            continue
        p1 = e["d"] + timedelta(days=l1)
        d2 = min(p1 + timedelta(days=C.ri(S["jeda"])), W1)
        if (d2 - p1).days < 1:
            continue
        sama_rs = C.p(S["rs_sama"])
        f2 = e["f"] if sama_rs else _rs_lain(D, m, e["f"], rng, lama=False)
        dx2 = e["dx"] if C.p(S["dx_sama"]) else _dx_terkait(D, m, e, f2, rng)
        e2 = episode(D, m, f2, "RITL", d2, rng, dx=dx2, basis=e["basis"] if dx2 == e["dx"] else None, prev=e)
        if e2 is None:
            continue
        los2 = max(1, e["los"] - l1) + C.ri((0, 2))
        e2["los"], e2["p"], e2["status"] = los2, d2 + timedelta(days=los2), "Sehat"
        if C.p(S["naik_keparahan"]):
            sv = _naik_sev(e2["sev"])
            if sv:
                _set_kode(D, e2, f"{e2['basis']}-{sv}", rng)
        los_asli = e["los"]
        e["los"], e["p"] = l1, p1
        if not C.bebas(e["pid"], e2):
            e["los"], e["p"] = los_asli, e["d"] + timedelta(days=los_asli)
            continue
        if e["status"] not in ("Sehat", "Pulang Paksa"):
            e["status"] = "Sehat"
        _tandai(e, "pulang_dini_readmisi", "episode_1_pulang_dini")
        C.tambah(_tandai(e2, "pulang_dini_readmisi", "episode_2_rs_sama" if f2 == e["f"] else "episode_2_rs_lain"))


def _fr_pemecahan(C: Ctx) -> None:
    S = SKEMA["pemecahan_episode"]
    D, rng = C.D, C.rng
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["los"] >= 4 and e["status"] != "Meninggal"):
        if not C.p(S["p_ri_dipecah"]):
            continue
        k = C.ri((1, e["los"] - 2))
        geser = 0 if C.p(0.6) else 1
        d2 = e["d"] + timedelta(days=k + geser)
        if d2 > W1:
            continue
        los2 = max(1, e["los"] - k - geser)
        e2 = _salin(e, d=d2, los=los2, p=d2 + timedelta(days=los2), dxs=int(rng.integers(0, e["dxs"] + 1)), _menit=int(rng.integers(0, 1440)), _b85=None)
        if C.p(0.3) and e["sev"] != "I":
            _set_kode(D, e2, f"{e['basis']}-I", rng)
        e["los"], e["p"], e["status"] = k, e["d"] + timedelta(days=k), "Sehat"
        _tagih(D, e2, rng)
        _tandai(e, "pemecahan_episode", "ri_dipecah_1")
        C.tambah(_tandai(e2, "pemecahan_episode", "ri_dipecah_2"))
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["status"] != "Meninggal"):
        if not C.p(S["p_rj_ri"]):
            continue
        m = C.m(e["pid"])
        if any(x["d"] == e["d"] and x is not e for x in C.of(e["pid"])):
            continue
        e2 = episode(D, m, e["f"], "RJTL", e["d"], rng, dx=e["dx"])
        if e2 is None:
            continue
        if C.p(0.5):
            e2["poli"] = "IGD"
        e2["_menit"] = max(0, e["_menit"] - int(rng.integers(30, 300)))
        C.tambah(_tandai(e2, "pemecahan_episode", "rj_ri_hari_sama"))
    for e in C.normal(lambda e: e["tk"] == "RJTL" and e["kode"][2] == "5"):
        if not C.p(S["p_rj_poli"]):
            continue
        m = C.m(e["pid"])
        e2 = episode(D, m, e["f"], "RJTL", e["d"], rng, dx=e["dx"])
        if e2 is None or e2["kode"] == e["kode"]:
            continue
        tp = D.M["rs_poli"].get(e["f"])
        for _ in range(8):
            if e2["poli"] != e["poli"]:
                break
            e2["poli"] = tp.pick(rng) if tp is not None else "INT"
        if e2["poli"] == e["poli"]:
            continue
        e2["_menit"] = min(1439, e["_menit"] + int(rng.integers(10, 120)))
        C.tambah(_tandai(e2, "pemecahan_episode", "rj_dipecah_poli"))


def _fr_readmisi(C: Ctx) -> None:
    S = SKEMA["readmisi_direncanakan"]
    D, rng = C.D, C.rng
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["status"] == "Sehat" and e["p"] + timedelta(days=S["jeda"][0]) <= W1):
        if not C.p(S["p"]):
            continue
        m = C.m(e["pid"])
        d2 = min(e["p"] + timedelta(days=C.ri(S["jeda"])), W1)
        sama = C.p(S["dx_sama"])
        dx2 = e["dx"] if sama else _dx_terkait(D, m, e, e["f"], rng)
        e2 = episode(D, m, e["f"], "RITL", d2, rng, dx=dx2, basis=e["basis"] if dx2 == e["dx"] else None, prev=e)
        if e2 is None or not C.bebas(e["pid"], e2):
            continue
        C.tambah(_tandai(e2, "readmisi_direncanakan", "dx_sama" if dx2 == e["dx"] else "dx_terkait"))


def _fr_rawat_inap_tanpa_indikasi(C: Ctx) -> None:
    S = SKEMA["rawat_inap_tanpa_indikasi"]
    D, rng = C.D, C.rng
    rs = set(D.rs_skema["rawat_inap_tanpa_indikasi"])
    for e in C.normal(lambda e: e["tk"] == "RJTL" and e["kode"][2] == "5" and e["status"] == "Sehat"):
        if not C.p(S["porsi_rs"] if e["f"] in rs else S["p"]):
            continue
        t = D.M["basis_dx"].get((e["dx"], "RITL"))
        if t is None:
            continue
        m = C.m(e["pid"])
        kelas = _pick_kelas(D, m, rng)
        for _ in range(10):
            b = t.pick(rng)
            if b[2] == "4" and D.tarif_of(f"{b}-I", e["f"], kelas) is not None:
                break
        else:
            continue
        los = C.ri(S["los"])
        trial = _salin(e, tk="RITL", los=los, p=e["d"] + timedelta(days=los))
        if not C.bebas(e["pid"], trial, abaikan=(e,)):
            continue
        e.update(tk="RITL", los=los, p=e["d"] + timedelta(days=los), kelas=kelas, poli=None, dxs=min(e["dxs"], 1), status="Sehat")
        _set_kode(D, e, f"{b}-I", rng, topup_baru=True)
        e["prosedur"] = _pros(D, e["kode"], rng)
        _tandai(e, "rawat_inap_tanpa_indikasi", "rs" if e["f"] in rs else "individu")


def _fr_los_diperpanjang(C: Ctx) -> None:
    S = SKEMA["los_diperpanjang"]
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["los"] >= 1 and e["status"] != "Meninggal"):
        if not C.p(S["p"]):
            continue
        new = max(e["los"] + 2, int(round(e["los"] * C.u(S["faktor"]))))
        trial = _salin(e, los=new, p=e["d"] + timedelta(days=new))
        if not C.bebas(e["pid"], trial, abaikan=(e,), hari_sama_rs_lain=False):
            continue
        e["los"], e["p"] = new, trial["p"]
        _tandai(e, "los_diperpanjang")


def _fr_operasi_batal(C: Ctx) -> None:
    S = SKEMA["operasi_batal_ditagih"]
    D, rng = C.D, C.rng
    for e in C.normal(lambda e: (e["tk"] == "RITL" and e["kode"][2] == "1") or (e["tk"] == "RJTL" and e["kode"][2] == "2")):
        if not C.p(S["p"]):
            continue
        m = C.m(e["pid"])
        if e["tk"] == "RITL":
            e["los"] = 1 if C.p(0.7) else 0
            e["p"] = e["d"] + timedelta(days=e["los"])
            e["status"] = "Sehat"
        var = C.varian(S["varian"])
        if var == "dijadwal_ulang":
            d2 = e["p"] + timedelta(days=C.ri(S["jeda_ulang"]))
            e2 = episode(D, m, e["f"], e["tk"], d2, rng, dx=e["dx"], basis=e["basis"], prev=e) if d2 <= W1 else None
            if e2 is not None and e2["kode"][2] == e["kode"][2] and C.bebas(e["pid"], e2):
                e2["prosedur"] = e["prosedur"] or e2["prosedur"]
                C.tambah(e2)  # the surgery actually done later: a genuine claim
            else:
                var = "batal_saja"
        _tandai(e, "operasi_batal_ditagih", var)


def _fr_kloning(C: Ctx) -> None:
    S = SKEMA["kloning"]
    D, rng = C.D, C.rng
    for f in D.rs_skema["kloning"]:
        pool = C.normal(lambda e: e["tk"] == "RITL" and e["f"] == f and e["status"] != "Meninggal")
        if len(pool) < 2:
            continue
        n_clone = int(rng.binomial(len(pool), S["porsi_rs"]))
        if n_clone == 0:
            continue
        pool.sort(key=lambda e: -e["tarif"])
        tpl_pool = pool[: max(1, len(pool) // 2)]
        tpl = tpl_pool[int(rng.integers(0, len(tpl_pool)))]
        rest = [e for e in pool if e is not tpl]
        rng.shuffle(rest)
        while rest and n_clone > 0:
            g = min(C.ri(S["grup"]) - 1, n_clone, len(rest))
            for x in rest[:g]:
                var = C.varian(S["varian"])
                old = _salin(x)
                if var == "hari_sama":
                    x["d"] = tpl["d"]
                for k in ("dx", "dxk", "masuk", "basis", "sev", "kode", "dxs", "los", "prosedur"):
                    x[k] = tpl[k]
                x["topup"] = {k: v for k, v in tpl["topup"].items()}
                x["p"] = x["d"] + timedelta(days=x["los"])
                x["status"] = "Sehat"
                x["_b85"] = None
                if not _isi_biaya(D, x, rng, topup_baru=False) or not C.bebas(x["pid"], x, abaikan=(x,)):
                    if var == "hari_sama":  # fall back to the clone's own date
                        x["d"] = old["d"]
                        x["p"] = x["d"] + timedelta(days=x["los"])
                        var = "beda_hari"
                        if _isi_biaya(D, x, rng, topup_baru=False) and C.bebas(x["pid"], x, abaikan=(x,)):
                            _tandai(x, "kloning", var)
                            n_clone -= 1
                            continue
                    x.clear()
                    x.update(old)
                    continue
                _tandai(x, "kloning", var)
                n_clone -= 1
            rest = rest[g:]
            if rest:
                tpl = rest.pop(0)  # a further template for the next group


def _fr_koding(C: Ctx) -> None:
    D, rng = C.D, C.rng
    # upcoding of severity (systematic at some hospitals, scattered elsewhere)
    S = SKEMA["upcoding_keparahan"]
    rs = set(D.rs_skema["upcoding_keparahan"])
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["sev"] in ("I", "II")):
        if not C.p(S["porsi_rs"] if e["f"] in rs else S["p"]):
            continue
        sv = _naik_sev(e["sev"], C.p(S["naik_dua"]))
        if sv and _set_kode(D, e, f"{e['basis']}-{sv}", rng):
            e["dxs"] += C.ri(S["tambah_dxs"])
            _tandai(e, "upcoding_keparahan", "rs" if e["f"] in rs else "individu")
    # gradual case-mix creep: the share upcoded rises over the window
    S = SKEMA["geser_bertahap"]
    rs = set(D.rs_skema["geser_bertahap"])
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["f"] in rs and e["sev"] in ("I", "II")):
        t = (e["d"] - W0).days / (NDAY - 1)
        if not C.p(S["p_awal"] + (S["p_akhir"] - S["p_awal"]) * t):
            continue
        sv = _naik_sev(e["sev"])
        if sv and _set_kode(D, e, f"{e['basis']}-{sv}", rng):
            e["dxs"] += C.ri(S["tambah_dxs"])
            _tandai(e, "geser_bertahap", f"hari_{(e['d'] - W0).days + 1}")
    # the principal diagnosis swapped for a better-paying one of the same body system
    S = SKEMA["diagnosis_utama_diganti"]
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["kode"][2] == "4"):
        if not C.p(S["p"]):
            continue
        grp = D.basis_grup.get((e["basis"][0], "4", "RITL"))
        if grp is None:
            continue
        cands, w = [], []
        wv = np.diff(np.concatenate([[0.0], grp.c]))
        for b, wi in zip(grp.v, wv):
            if b == e["basis"]:
                continue
            t = D.tarif_of(f"{b}-{e['sev']}", e["f"], e["kelas"])
            if t is not None and t >= S["rasio_min"] * e["tarif"] and (b, "RITL") in D.dx_of:
                cands.append(b)
                w.append(wi)
        if not cands:
            continue
        b = cands[int(rng.choice(len(cands), p=np.array(w) / sum(w)))]
        if _set_kode(D, e, f"{b}-{e['sev']}", rng):
            e["dx"] = D.dx_of[(b, "RITL")].pick(rng)
            t = D.M["dxk"].get(e["dx"])
            e["dxk"] = t.pick(rng) if t is not None else e["dx"]
            _tandai(e, "diagnosis_utama_diganti")
    # procedures billed but not performed
    S = SKEMA["tindakan_fiktif"]
    for e in C.normal(lambda e: (e["tk"] == "RJTL" and e["kode"][2] == "5") or (e["tk"] == "RITL" and e["kode"][2] == "4")):
        if not C.p(S["p_rj"] if e["tk"] == "RJTL" else S["p_ri"]):
            continue
        want = "23" if e["tk"] == "RJTL" else "1"
        t = D.M["basis_dx"].get((e["dx"], e["tk"]))
        cands = [b for b in (t.v if t is not None else []) if b[2] in want]
        if not cands and e["tk"] == "RITL":
            g = D.basis_grup.get((e["basis"][0], "1", "RITL"))
            cands = list(g.v[:10]) if g is not None else []
        if not cands:
            continue
        b = cands[int(rng.integers(0, len(cands)))]
        sevs = [e["sev"]] + [s for s in ("I", "II", "III", "0") if s != e["sev"]]
        if not any(_set_kode(D, e, f"{b}-{s}", rng) for s in sevs):
            continue
        tanpa = C.p(S["varian"]["tanpa_catatan"])
        e["prosedur"] = None if tanpa else _pros(D, e["kode"], rng, wajib=True)
        _tandai(e, "tindakan_fiktif", "tanpa_catatan" if tanpa else ("rj_prosedur" if e["tk"] == "RJTL" else "ri_bedah"))
    # treatment not matching the indication
    S = SKEMA["tidak_sesuai_indikasi"]
    vag = [k for k, v in D.kode.items() if k.startswith("O-6-") and "VAGINAL" in (v["des"] or "").upper()]
    sc = sorted({k.rsplit("-", 1)[0] for k, v in D.kode.items() if k.startswith("O-6-") and "CAESAR" in (v["des"] or "").upper()})
    vag_b = {k.rsplit("-", 1)[0] for k in vag}
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["basis"] in vag_b):
        if sc and C.p(S["p_sc"]):
            if any(_set_kode(D, e, f"{sc[0]}-{s}", rng) for s in [e["sev"], "I", "II", "III"]):
                e["prosedur"] = _pros(D, e["kode"], rng, wajib=True)
                _tandai(e, "tidak_sesuai_indikasi", "sc_tanpa_indikasi")
    for e in C.normal(lambda e: e["kode"][2] in "45"):
        if not C.p(S["p_lain"]):
            continue
        letters = set()
        for tk in ("RJTL", "RITL"):
            t = D.M["basis_dx"].get((e["dx"], tk))
            letters |= {b[0] for b in (t.v if t is not None else []) if b[0] not in "QZ"}
        want = "1" if e["tk"] == "RITL" else "23"
        t_own = D.M["basis_dx"].get((e["dx"], e["tk"]))
        cands, w = [], []
        for L in letters:
            for dg in want:
                g = D.basis_grup.get((L, dg, e["tk"]))
                if g is None:
                    continue
                wv = np.diff(np.concatenate([[0.0], g.c]))
                for b, wi in zip(g.v, wv):
                    if (t_own.p(b) if t_own is not None else 0.0) < S["lazim_maks"]:
                        cands.append(b)
                        w.append(wi)
        if not cands:
            continue
        b = cands[int(rng.choice(len(cands), p=np.array(w) / sum(w)))]
        if any(_set_kode(D, e, f"{b}-{s}", rng) for s in ([e["sev"], "I", "II"] if e["tk"] == "RITL" else ["0"])):
            e["prosedur"] = _pros(D, e["kode"], rng, wajib=True)
            _tandai(e, "tidak_sesuai_indikasi", "prosedur_tidak_lazim")


def _fr_tagihan(C: Ctx) -> None:
    D, rng = C.D, C.rng
    # a class above the entitlement billed
    S = SKEMA["naik_kelas"]
    rs = set(D.rs_skema["naik_kelas"])
    lvl = {"Kelas 1": 1, "Kelas 2": 2, "Kelas 3": 3}
    for e in C.normal(lambda e: e["tk"] == "RITL" and e["kelas"] in ("Kelas 2", "Kelas 3")):
        m = C.m(e["pid"])
        hak = lvl[_hak(m)]
        if lvl[e["kelas"]] < hak or not C.p(S["porsi_rs"] if e["f"] in rs else S["p"]):
            continue
        new = max(1, lvl[e["kelas"]] - (2 if C.p(S["naik_dua"]) else 1))
        old = e["kelas"]
        e["kelas"] = f"Kelas {new}"
        if not _set_kode(D, e, e["kode"], rng):
            e["kelas"] = old
            continue
        _tandai(e, "naik_kelas", "pbi" if m["pbi"] else "non_pbi")
    # the bill above the package tariff
    S = SKEMA["tagihan_gelembung"]
    rs = set(D.rs_skema["tagihan_gelembung"])
    for e in C.normal():
        if not C.p(S["porsi_rs"] if e["f"] in rs else S["p"]):
            continue
        e["bill"] = int(round(e["bill"] * C.u(S["faktor"]), -2))
        _tandai(e, "tagihan_gelembung", "rs" if e["f"] in rs else "individu")
    # an inflated special-CMG top-up
    S = SKEMA["topup_gelembung"]
    for e in C.normal(lambda e: bool(e["topup"])):
        if not C.p(S["p"]):
            continue
        col = list(e["topup"])[int(rng.integers(0, len(e["topup"])))]
        tk, des, v = e["topup"][col]
        e["topup"][col] = (tk, des, int(round(v * C.u(S["faktor"]), -2)))
        _tagih(D, e, rng)
        _tandai(e, "topup_gelembung", col)
    # a fictitious drug / device / investigation top-up
    S = SKEMA["obat_alkes_fiktif"]
    for e in C.normal():
        if not C.p(S["p_ri"] if e["tk"] == "RITL" else S["p_rj"]):
            continue
        n = D.kode.get(e["kode"], {}).get("n", 0) or 1
        lazim = [(col, tk, des) for col, tk, des, k in D.M["topup_inc"].get(e["kode"], []) if k / n >= 0.01 and col not in e["topup"]]
        own = {(col, tk): k for col, tk, des, k in D.M["topup_inc"].get(e["kode"], [])}
        g = D.M["topup_cmg"].get(e["kode"][0])
        jarang = []
        if g is not None:
            for ct in g.v:
                col, tk = ct.split("|", 1)
                if col not in e["topup"] and own.get((col, tk), 0) / n <= 0.005:
                    jarang.append((col, tk))
        var = C.varian(S["varian"])
        if var == "topup_lazim" and not lazim:
            var = "topup_tidak_lazim"
        if var == "topup_tidak_lazim" and not jarang:
            var = "topup_lazim" if lazim else ""
        if not var:
            continue
        if var == "topup_lazim":
            col, tk, des = lazim[int(rng.integers(0, len(lazim)))]
        else:
            col, tk = jarang[int(rng.integers(0, len(jarang)))]
            des = D.topup_des.get((col, tk))
        amt = D.topup_amt(col, tk, e["f"])
        if amt <= 0:
            continue
        e["topup"][col] = (tk, des, amt)
        _tagih(D, e, rng)
        _tandai(e, "obat_alkes_fiktif", var)


def _fr_berulang(C: Ctx) -> None:
    S = SKEMA["klaim_berulang"]
    D, rng = C.D, C.rng
    for e in C.normal():
        if not C.p(S["p"]):
            continue
        var = C.varian(S["varian"])
        if var == "geser_sehari" and e["tk"] != "RITL":
            var = "id_baru"
        if var == "kode_beda" and e["tk"] != "RJTL":
            var = "geser_sehari"
        x = _salin(e, _menit=min(1439, e["_menit"] + int(rng.integers(1, 240))))
        if var == "geser_sehari":
            d2 = e["d"] + timedelta(days=1)
            if d2 > W1:
                continue
            los2 = max(1, e["los"] - 1)
            x.update(d=d2, los=los2, p=d2 + timedelta(days=los2))
        elif var == "kode_beda":
            t = D.M["basis_dx"].get((e["dx"], "RJTL"))
            alts = [b for b in (t.v if t is not None else []) if b != e["basis"]] or ["Q-5-18"]
            if not any(_set_kode(D, x, f"{b}-0", rng) for b in alts[:6]):
                continue
            tp = D.M["rs_poli"].get(e["f"])
            if tp is not None:
                x["poli"] = tp.pick(rng)
            x["prosedur"] = _pros(D, x["kode"], rng)
        C.tambah(_tandai(x, "klaim_berulang", var))


def _fr_sesi_rutin(C: Ctx) -> None:
    S = SKEMA["sesi_rutin_fiktif"]
    D, rng = C.D, C.rng
    w = D.M["kalender"].get("RJTL", {})
    for f in D.rs_skema["sesi_rutin_fiktif"]:
        by: dict[tuple, list] = defaultdict(list)
        for e in C.normal(lambda e: e["f"] == f and e["tk"] == "RJTL" and e["kode"] in RUTIN):
            by[(e["pid"], e["kode"])].append(e)
        for (pid, kode), ss in by.items():
            # dialysis, physiotherapy, rehabilitation and wound care are series treatments: any session marks a series patient
            if not C.p(S["porsi_rs"]):
                continue
            ss.sort(key=lambda e: e["d"])
            busy = {x["d"] for x in C.of(pid)}
            lo, hi = max(W0, ss[0]["d"] - timedelta(days=3)), min(W1, ss[-1]["d"] + timedelta(days=3))
            days = [lo + timedelta(days=i) for i in range((hi - lo).days + 1)]
            days = [d for d in days if d not in busy]
            if not days:
                continue
            pw = np.array([w.get(d, 1.0) for d in days])
            k = min(C.ri(S["tambah"]), len(days))
            pick = rng.choice(len(days), size=k, replace=False, p=pw / pw.sum())
            for i in pick:
                tpl = ss[int(rng.integers(0, len(ss)))]
                x = _salin(tpl, d=days[int(i)], p=days[int(i)], _menit=int(rng.integers(0, 1440)))
                busy.add(x["d"])
                C.tambah(_tandai(x, "sesi_rutin_fiktif", kode))


def _hari_acak(C: Ctx, tk: str) -> date:
    return _kalender(C.D, tk, W0 + timedelta(days=int(C.rng.integers(0, NDAY))), C.rng)


def _fr_fiktif(C: Ctx) -> None:
    S = SKEMA["klaim_fiktif"]
    D, rng = C.D, C.rng
    for f in D.rs_skema["klaim_fiktif"]:
        n_f = sum(1 for e in C.eps if e["f"] == f)
        k = int(rng.poisson(S["porsi_rs"] * max(n_f, 1)))
        kab = D.rs[f]["kab"]
        for _ in range(k):
            var = C.varian(S["varian"])
            m = None
            if var == "pasien_lama":
                cands = [x for x in C.cad_h if f in x["rs_set"] and x["pid"] not in C.terpakai]
                if cands:
                    m = cands[int(rng.integers(0, len(cands)))]
            elif var == "data_baksos":
                cands = [r for r in C.cad_b if r.kab == kab and int(r.pid) not in C.terpakai] or \
                        [r for r in C.cad_b if r.kab == r.kab and r.kab is not None and int(r.kab) // 100 == kab // 100 and int(r.pid) not in C.terpakai]
                if cands:
                    m = _anggota(D, cands[int(rng.integers(0, len(cands)))])
            else:
                mm = [_anggota(D, r) for r in C.mati if int(r.pid) not in C.terpakai]
                cands = [x for x in mm if f in x["rs_set"]] or [x for x in mm if x["kab"] and x["kab"] // 100 == kab // 100] or mm
                if cands:
                    m = cands[int(rng.integers(0, len(cands)))]
            if m is None:
                continue
            tk = "RITL" if C.p(S["ri"]) else "RJTL"
            prev = m["riwayat_rs"].get(f)
            d = _hari_acak(C, tk)
            if d > W1:
                continue
            if prev is not None and tk == prev["tk"]:
                e = episode(D, m, f, tk, d, rng, dx=prev["dx"], basis=prev["basis"], prev=prev)
            else:
                e = episode(D, m, f, tk, d, rng)
            if e is None:
                continue
            if tk == "RITL":
                e["los"] = min(e["los"], C.ri((2, 4)))
                e["p"] = e["d"] + timedelta(days=e["los"])
            if e["status"] == "Meninggal":
                e["status"] = "Sehat"
            m["sumber"] = "cadangan"
            C.members[m["pid"]] = m
            C.terpakai.add(m["pid"])
            C.tambah(_tandai(e, "klaim_fiktif", var))


def _fr_kartu(C: Ctx) -> None:
    S = SKEMA["kartu_dipinjam"]
    D, rng = C.D, C.rng
    k = int(rng.poisson(S["p"] * len(C.eps)))
    for _ in range(k):
        if C.p(P_RIWAYAT):
            cands = [x for x in C.cad_h if x["pid"] not in C.terpakai]
            m = cands[int(rng.integers(0, len(cands)))] if cands else None
        else:
            cands = [r for r in C.cad_b[:5000] if int(r.pid) not in C.terpakai]
            m = _anggota(D, cands[int(rng.integers(0, len(cands)))]) if cands else None
        if m is None:
            continue
        var = C.varian(S["varian"])
        f = _rs_lain(D, m, None, rng, lama=False)
        if var == "cocok":
            for _ in range(5):
                if f not in m["rs_set"]:
                    break
                f = _rs_lain(D, m, None, rng, lama=False)
            tk = "RITL" if C.p(0.3) else "RJTL"
            e = episode(D, m, f, tk, _hari_acak(C, tk), rng)
        else:
            if m["jk"] == "L":
                ab, jk, tk, want = 2, "P", "RITL", "O"
            elif (m["usia"] or 30) > 2 and C.p(0.5):
                ab, jk, tk, want = 0, ("L" if C.p(0.5) else "P"), "RITL", "P"
            else:
                ab, jk, tk, want = 3, "L", "RJTL", "N4"
            t = D.M["dx"]["a"].get((tk, D.rs[f]["hg"], ab, jk)) or D.M["dx"]["c"].get((tk, ab, jk))
            dx = None
            for _ in range(60):
                x = t.pick(rng)
                if x.startswith(want) and (want != "N4" or x <= "N51"):
                    dx = x
                    break
            e = episode(D, m, f, tk, _hari_acak(C, tk), rng, dx=dx, ab=ab, jk=jk)
        if e is None or e["d"] > W1:
            continue
        m["sumber"] = "cadangan"
        C.members[m["pid"]] = m
        C.terpakai.add(m["pid"])
        C.tambah(_tandai(e, "kartu_dipinjam", var))


def _fr_jaringan(C: Ctx) -> None:
    D, rng = C.D, C.rng
    S = SKEMA["rujukan_semu"]
    for a, b in D.rs_skema["rujukan_semu"]:
        for e in C.normal(lambda e: e["f"] == a and e["tk"] == "RJTL" and e["poli"] not in ("IGD", "HDL", "IRM", "GIG") and e["status"] == "Sehat"):
            if not C.p(S["porsi_rs"]):
                continue
            m = C.m(e["pid"])
            d2 = e["d"] + timedelta(days=C.ri(S["jeda"]))
            if d2 > W1:
                continue
            tk2 = "RITL" if C.p(S["ri"]) else "RJTL"
            basis = None
            if tk2 == "RJTL":
                t = D.M["basis_dx"].get((e["dx"], "RJTL"))
                pr = [x for x in (t.v if t is not None else []) if x[2] in "23"]
                if pr and C.p(0.7):
                    basis = pr[int(rng.integers(0, len(pr)))]
            e2 = episode(D, m, b, tk2, d2, rng, dx=e["dx"], basis=basis)
            if e2 is None or not C.bebas(e["pid"], e2):
                continue
            e["status"] = "Rujuk"
            C.tambah(_tandai(e2, "rujukan_semu", tk2.lower()))
    S = SKEMA["dokter_tiga_rs"]
    for a, b, c, poli in D.rs_skema["dokter_tiga_rs"]:
        for e in C.normal(lambda e: e["f"] == a and e["tk"] == "RJTL" and e["poli"] == poli and e["status"] != "Meninggal"):
            if not C.p(S["porsi_rs"]):
                continue
            m = C.m(e["pid"])
            d = e["d"]
            for f2, var in ((b, "rs_kedua"), (c, "rs_ketiga")):
                d = d + timedelta(days=C.ri(S["jeda"]))
                if d > W1:
                    break
                e2 = episode(D, m, f2, "RJTL", d, rng, dx=e["dx"])
                if e2 is None or not C.bebas(e["pid"], e2):
                    break
                e2["poli"] = poli
                C.tambah(_tandai(e2, "dokter_tiga_rs", var))


URUTAN = (_fr_pulang_dini, _fr_pulang_dini_readmisi, _fr_pemecahan, _fr_readmisi, _fr_rawat_inap_tanpa_indikasi, _fr_los_diperpanjang,
          _fr_operasi_batal, _fr_kloning, _fr_koding, _fr_tagihan, _fr_berulang, _fr_sesi_rutin, _fr_fiktif, _fr_kartu, _fr_jaringan)


# ------------------------------------------------------------------------------------------------------------------
# claims out
# ------------------------------------------------------------------------------------------------------------------
_ALFA = np.array(list("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"))


def _klaim(D: Dunia, e: dict, kid: str) -> dict:
    R = D.rs[e["f"]]
    kd = D.kode.get(e["kode"], {})
    out = {"kunjungan_fkrtl_id": kid, "edisi": "reguler", "peserta_id": int(e["pid"]), "tgl_datang": e["d"], "tgl_pulang": e["p"],
           "kabkota_fkrtl_kode": int(R["kab"]), "kepemilikan_fkrtl": R["kep"], "jenis_fkrtl": R["jenis"], "tipe_fkrtl": R["tipe"],
           "tingkat_pelayanan": e["tk"], "poli": e["poli"], "segmen": e["segmen"], "kelas_rawat": e["kelas"], "status_pulang": e["status"],
           "dx_primer_icd3": e["dx"], "inacbg_kode": e["kode"], "inacbg_cmg": kd.get("cmg"), "inacbg_tipe_kasus": kd.get("tk"),
           "inacbg_keparahan": kd.get("kep"), "regional_tarif": R["regional"], "prosedur": e["prosedur"], "tarif_inacbg_rp": int(e["tarif"])}
    for col in TOPUP_COLS:
        v = e["topup"].get(col)
        out[f"{col}_tarif_rp"] = int(v[2]) if v else 0
    out.update({"biaya_tagih_rp": int(e["bill"]), "los_hari": int(e["los"]), "jumlah_dx_sekunder": int(e["dxs"]),
                "flag_calon_klaim_ganda": False, "flag_los_ekstrem": bool(e["tk"] == "RITL" and e["los"] >= kd.get("ekstrem", 10 ** 6)),
                "layanan_covid": False, "dx_masuk_kode": e["masuk"], "dx_masuk_nama": D.M["masuk_nama"].get(e["masuk"]),
                "dx_primer_kode": e["dxk"], "dx_primer_nama": D.M["dxk_nama"].get(e["dxk"]), "inacbg_deskripsi": kd.get("des")})
    for col in TOPUP_COLS:
        v = e["topup"].get(col)
        out[f"{col}_kode"] = v[0] if v else None
        if col != "sa":
            out[f"{col}_deskripsi"] = (v[1] if v else None)
    out.update({"kabkota_fkrtl": R["kab_nama"], "provinsi_fkrtl": R["prov_nama"]})
    return out


def buat(c: int, kecuali: set[int]) -> list[dict]:
    """Chunk c (0-7) of generator 3: about 5,000 claims of 18-31 Dec 2024 in arrival order, each a KlaimIn dict plus
    _sk (scheme or 'normal'), _varian, _m (the member: pid, rs = hospital profile of the last claim before the window or
    None, ...), _urut. Members are split between chunks by hash, so chunks never share a member."""
    if not 0 <= int(c) < N_CHUNK:
        raise ValueError(f"chunk {c} di luar 0..{N_CHUNK - 1}")
    D = dunia()
    rng = np.random.default_rng(_h(f"{GARAM}|chunk|{int(c)}"))
    pop = _populasi(D, int(c), {int(x) for x in (kecuali or set())}, rng)
    C = Ctx(D, pop, rng)
    for fn in URUTAN:
        fn(C)
    eps = [e for e in C.eps if e.get("pid") is not None]
    eps.sort(key=lambda e: (e["d"], e["_menit"], e["_seq"]))
    # the silver duplicate flag: the same member, date and code claimed more than once
    dup = Counter((e["pid"], e["d"], e["kode"]) for e in eps)
    ids = ["SYN" + "".join(x) for x in _ALFA[rng.integers(0, 36, size=(len(eps), 13))]]
    out = []
    for i, (e, kid) in enumerate(zip(eps, ids)):
        k = _klaim(D, e, kid)
        k["flag_calon_klaim_ganda"] = dup[(e["pid"], e["d"], e["kode"])] > 1
        m = C.members[e["pid"]]
        k["_sk"], k["_varian"], k["_urut"] = e["_sk"], e["_varian"], i
        k["_m"] = {"pid": m["pid"], "rs": m["rs"], "n_riwayat": m["n_hist"], "rs_riwayat": list(m["rs_set"]), "jk": m["jk"],
                   "usia": None if m["usia"] is None else round(m["usia"], 1), "segmen_registri": m["segmen_reg"], "hak_kelas": m["hak"],
                   "sumber": m.get("sumber", "perjalanan"), "chunk": int(c)}
        out.append(k)
    return out


# ------------------------------------------------------------------------------------------------------------------
# contoh: one chunk's counts, mix, validation, fingerprint checks and fidelity against 1-14 Nov 2024
# ------------------------------------------------------------------------------------------------------------------
def _profil(k: dict) -> str:
    parts = ["FKRTL", str(int(k["kabkota_fkrtl_kode"])), k.get("kepemilikan_fkrtl"), k.get("jenis_fkrtl"), k.get("tipe_fkrtl") or None]
    return hashlib.md5("|".join(p for p in parts if p is not None).encode("utf-8")).hexdigest()


def _silver_ref() -> dict:
    con = _con()
    a, b = "DATE '2024-11-01'", "DATE '2024-11-14'"
    r = con.execute(f"""WITH w AS (SELECT * FROM s WHERE tgl_datang BETWEEN {a} AND {b}),
        h AS (SELECT DISTINCT peserta_id, f FROM s WHERE tgl_datang < {a}),
        hp AS (SELECT DISTINCT peserta_id FROM s WHERE tgl_datang < {a}),
        hl AS (SELECT peserta_id, arg_max(f, tgl_datang) lf FROM s WHERE tgl_datang < {a} GROUP BY 1)
        SELECT count(*) n, avg((tingkat_pelayanan = 'RITL')::INT) ri, avg(los_hari) FILTER (WHERE tingkat_pelayanan = 'RITL') los,
               median(biaya_tagih_rp) FILTER (WHERE tingkat_pelayanan = 'RITL') bill_ri, median(biaya_tagih_rp) FILTER (WHERE tingkat_pelayanan = 'RJTL') bill_rj,
               avg(jumlah_dx_sekunder) dxs, avg((sa_tarif_rp + sp_tarif_rp + rr_tarif_rp + si_tarif_rp + sd_tarif_rp > 0)::INT) topup,
               avg((prosedur IS NOT NULL)::INT) pros, avg((sev = 'II')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL') sev2,
               avg((sev = 'III')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL') sev3, avg(flag_los_ekstrem::INT) ekstrem,
               avg((hp.peserta_id IS NOT NULL)::INT) any_hist, avg((h.peserta_id IS NOT NULL)::INT) same_rs, avg(coalesce(hl.lf = w.f, false)::INT) last_rs,
               avg((status_pulang = 'Rujuk')::INT) rujuk, avg((biaya_tagih_rp <> tarif_inacbg_rp + sa_tarif_rp + sp_tarif_rp + rr_tarif_rp + si_tarif_rp + sd_tarif_rp)::INT) beda_tagih
        FROM w LEFT JOIN hp USING (peserta_id) LEFT JOIN h USING (peserta_id, f) LEFT JOIN hl USING (peserta_id)""").df().iloc[0].to_dict()
    pm = con.execute(f"""SELECT least(k, 5) k, count(*) m FROM (SELECT peserta_id, count(*) k FROM s WHERE tgl_datang BETWEEN {a} AND {b} GROUP BY 1)
                         GROUP BY 1 ORDER BY 1""").df()
    r["per_member"] = {int(k): int(v) for k, v in zip(pm.k, pm.m)}
    hm = con.execute(f"""SELECT avg((hp.peserta_id IS NOT NULL)::INT) FROM (SELECT DISTINCT peserta_id FROM s WHERE tgl_datang BETWEEN {a} AND {b}) w
                         LEFT JOIN (SELECT DISTINCT peserta_id FROM s WHERE tgl_datang < {a}) hp USING (peserta_id)""").fetchone()[0]
    r["member_hist"] = float(hm)
    return r


def contoh(c: int) -> int:
    """Print one chunk's summary; return 0 only when generation succeeded and every claim validates with KlaimIn."""
    import traceback

    import pandas as pd
    from pydantic import ValidationError

    sys.path.insert(0, str(ROOT / "api"))
    from aip.layanan import KlaimIn

    t0 = time.time()
    try:
        claims = buat(c, set())
    except Exception:
        traceback.print_exc()
        print(f"GAGAL: chunk {c} tidak bisa dibuat")
        return 2
    if not claims:
        print(f"GAGAL: chunk {c} kosong")
        return 3
    print(f"chunk {c}: {len(claims):,} klaim dalam {time.time() - t0:.1f} s")
    gagal, alasan = 0, Counter()
    for k in claims:
        try:
            KlaimIn(**{a: v for a, v in k.items() if not a.startswith("_")})
        except ValidationError as ex:
            gagal += 1
            for er in ex.errors()[:3]:
                alasan[f"{'.'.join(str(x) for x in er['loc'])}: {er['msg'][:60]}"] += 1
    df = pd.DataFrame([{a: v for a, v in k.items() if a != "_m"} for k in claims])
    mm = pd.DataFrame([k["_m"] for k in claims])
    df["f"] = [_profil(k) for k in claims]
    df["kelas_sk"] = [("normal" if s == "normal" else SKEMA[s]["kelas"]) for s in df._sk]
    df["any_hist"] = (mm.n_riwayat > 0).values
    df["same_rs"] = [f in set(r) for f, r in zip(df.f, mm.rs_riwayat)]
    df["last_rs"] = [f == r for f, r in zip(df.f, mm.rs)]
    cek = []
    cek.append(("tgl_datang di 18-31 Des", bool(((df.tgl_datang >= W0) & (df.tgl_datang <= W1)).all())))
    cek.append(("urutan kedatangan (tanggal)", bool((df.tgl_datang.values[1:] >= df.tgl_datang.values[:-1]).all() and (df._urut.diff().dropna() == 1).all())))
    cek.append(("id unik", bool(df.kunjungan_fkrtl_id.is_unique)))
    cek.append(("tgl_pulang >= tgl_datang", bool((df.tgl_pulang >= df.tgl_datang).all())))
    cek.append(("chunk tidak berbagi anggota (hash)", bool(all(chunk_of(p) == c for p in df.peserta_id.unique()))))
    print("\n== skema ==")
    n = len(df)
    rows = []
    for sk, g in df.groupby("_sk"):
        var = ", ".join(f"{v or '-'} {k}" for v, k in g._varian.value_counts().items()) if sk != "normal" else ""
        rows.append((sk, len(g), SKEMA.get(sk, {}).get("modus", ""), SKEMA.get(sk, {}).get("kelas", ""), var))
    rows.sort(key=lambda r: (r[0] != "normal", -r[1]))
    for sk, k, mo, kl, var in rows:
        print(f"  {sk:<28} {k:>6} {k / n:7.2%}  {mo:<16} {kl:<6} {var[:110]}")
    nf, nq = int((df.kelas_sk == "fraud").sum()), int((df.kelas_sk == "mutu").sum())
    print(f"  prevalensi fraud {nf} ({nf / n:.2%}); mutu (bukan fraud) {nq} ({nq / n:.2%}); skema terwakili {df._sk.nunique() - 1} dari {len(SKEMA)}")
    print("\n== campuran ==")
    print(f"  rawat inap (semua) {(df.tingkat_pelayanan == 'RITL').mean():.2%}")
    per = df.groupby("peserta_id").size()
    dist = per.clip(upper=5).value_counts().sort_index()
    print("  klaim per peserta: " + ", ".join(f"{'5+' if k == 5 else k}: {v} ({v / len(per):.1%})" for k, v in dist.items()) + f"   rata-rata {per.mean():.2f}")
    print(f"  peserta dengan klaim sebelumnya (per peserta) {(mm.groupby('pid').n_riwayat.first() > 0).mean():.2%}")
    print("  riwayat per klaim            any_hist  same_rs  last_rs  rata2_riwayat")
    for nm, g in (("normal", df[df.kelas_sk == "normal"]), ("fraud", df[df.kelas_sk == "fraud"]), ("mutu", df[df.kelas_sk == "mutu"])):
        if len(g):
            nh = mm.loc[g.index, "n_riwayat"]
            print(f"    {nm:<26} {g.any_hist.mean():8.2%} {g.same_rs.mean():8.2%} {g.last_rs.mean():8.2%} {nh.mean():10.1f}")
    # fingerprint 2: another hospital the same day
    key = df.groupby(["peserta_id", "tgl_datang"]).f.transform("nunique") > 1
    for nm in ("normal", "fraud"):
        g = df[df.kelas_sk == nm]
        print(f"  klaim dengan klaim RS lain di hari yang sama ({nm}): {int(key[g.index].sum())} ({key[g.index].mean():.2%})")
    print(f"  sumber anggota: {dict(Counter(mm.drop_duplicates('pid').sumber))}")
    print("\n== validasi KlaimIn ==")
    print(f"  gagal {gagal} dari {n}")
    for r, k in alasan.most_common(8):
        print(f"    {k:>5}  {r}")
    for nm, ok in cek:
        print(f"  {'ok ' if ok else 'GAGAL'} {nm}")
    print("\n== fidelitas: klaim normal vs silver 1-14 Nov 2024 ==")
    ref = _silver_ref()
    g = df[df._sk == "normal"]
    ri = g[g.tingkat_pelayanan == "RITL"]
    rj = g[g.tingkat_pelayanan == "RJTL"]
    sev = ri.inacbg_kode.str.rsplit("-", n=1).str[1]
    tu = (g[[f"{x}_tarif_rp" for x in TOPUP_COLS]].sum(axis=1) > 0)
    tot = g.tarif_inacbg_rp + g[[f"{x}_tarif_rp" for x in TOPUP_COLS]].sum(axis=1)
    pm = g.groupby("peserta_id").size().clip(upper=5).value_counts(normalize=True).sort_index()
    rpm = pd.Series(ref["per_member"]) / sum(ref["per_member"].values())
    lines = [("klaim", f"{len(g):,}", f"{int(ref['n']):,}"),
             ("rawat inap", f"{(g.tingkat_pelayanan == 'RITL').mean():.2%}", f"{ref['ri']:.2%}"),
             ("rata-rata LOS rawat inap", f"{ri.los_hari.mean():.2f}", f"{ref['los']:.2f}"),
             ("median tagihan rawat inap", f"{ri.biaya_tagih_rp.median():,.0f}", f"{ref['bill_ri']:,.0f}"),
             ("median tagihan rawat jalan", f"{rj.biaya_tagih_rp.median():,.0f}", f"{ref['bill_rj']:,.0f}"),
             ("rata-rata dx sekunder", f"{g.jumlah_dx_sekunder.mean():.2f}", f"{ref['dxs']:.2f}"),
             ("klaim dengan top-up", f"{tu.mean():.2%}", f"{ref['topup']:.2%}"),
             ("klaim dengan prosedur", f"{g.prosedur.notna().mean():.2%}", f"{ref['pros']:.2%}"),
             ("keparahan II (rawat inap)", f"{(sev == 'II').mean():.2%}", f"{ref['sev2']:.2%}"),
             ("keparahan III (rawat inap)", f"{(sev == 'III').mean():.2%}", f"{ref['sev3']:.2%}"),
             ("flag LOS ekstrem", f"{g.flag_los_ekstrem.mean():.2%}", f"{ref['ekstrem']:.2%}"),
             ("status Rujuk", f"{(g.status_pulang == 'Rujuk').mean():.2%}", f"{ref['rujuk']:.2%}"),
             ("tagihan != tarif + top-up", f"{(g.biaya_tagih_rp != tot).mean():.2%}", f"{ref['beda_tagih']:.2%}"),
             ("klaim: peserta punya riwayat", f"{g.any_hist.mean():.2%}", f"{ref['any_hist']:.2%}"),
             ("klaim: di RS yang pernah dipakai", f"{g.same_rs.mean():.2%}", f"{ref['same_rs']:.2%}"),
             ("klaim: di RS klaim terakhir", f"{g.last_rs.mean():.2%}", f"{ref['last_rs']:.2%}"),
             ("peserta punya riwayat", f"{(mm.loc[g.index].groupby('pid').n_riwayat.first() > 0).mean():.2%}", f"{ref['member_hist']:.2%}")]
    lines += [(f"peserta dengan {'5+' if k == 5 else k} klaim", f"{pm.get(k, 0):.1%}", f"{rpm.get(k, 0):.1%}") for k in range(1, 6)]
    print(f"  {'ukuran':<34} {'generator 3':>14} {'silver Nov':>14}")
    for a, b, cc in lines:
        print(f"  {a:<34} {b:>14} {cc:>14}")
    ok = gagal == 0 and all(v for _, v in cek)
    print(f"\n{'OK' if ok else 'GAGAL'}: chunk {c}, {n:,} klaim, {gagal} gagal validasi, {time.time() - t0:.1f} s")
    return 0 if ok else 1


if __name__ == "__main__":
    perintah = sys.argv[1] if len(sys.argv) > 1 else ""
    if perintah == "fit":
        fit()
    elif perintah == "contoh" and len(sys.argv) > 2:
        sys.exit(contoh(int(sys.argv[2])))
    else:
        print(__doc__.split("CLI:")[-1])
        sys.exit(64)

