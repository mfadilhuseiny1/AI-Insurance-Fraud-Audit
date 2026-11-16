"""Features X4 of the v4 models (stage 2 of the plan of 2026-11-12, after generator 2): fraud-mechanism features that the 124
system features lack. Computed ONE claim at a time, in arrival order, against the claims that arrived before (causal); there is
no batch path, so training and serving cannot drift apart (the skew of v3). Synthetic data only.

Per claim (an engine event: peserta, faskes, kode, dx3, los, tingkat, tgl_datang, tgl_pulang, biaya, ssl.x raw inputs):
  residence        the member's registered FKTP and home kab/kota against the hospital's: 0 same kab, 1 same province, 2 other
  near duplicates  earlier claims of the same member at the same hospital and code within ±3 days; within ±1 day and a bill ±5 %;
                   the member's claims at any hospital within ±1 day
  clones           (inpatient) earlier claims of OTHER members at the same hospital with the same code, diagnosis and LOS (±1) and a bill
                   within ±5 %, within ±3 and ±14 days
  length of stay   LOS against the code's median and p10/p25 (INA-CBG pays per episode: the abuse is the SHORT stay, the user
                   2026-11-12); readmission after a short stay (an earlier inpatient claim of the member ending 0–14 days before
                   this admission whose LOS was < 60 % of its code's median; gap, same hospital, same diagnosis)
  hospital drift   among the hospital's earlier inpatient claims in the window: mean LOS ratio, share of severity III and share of
                   short stays, each minus the hospital's own 2024 baseline; how many such claims
  bills            top-up against the code's median top-up, the code's top-up rarity, secondary diagnoses above the code's p90,
                   the bill against the code's median bill
Reference tables come from the 2024 reguler claims before the window (1 Jan – 17 Dec) and the member registry."""
from __future__ import annotations

import hashlib
import math
import os
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
# FITUR_V4_DRIVE / FITUR_V4_CACHE (testing/uji_riil.py): the real sample's Files folder and a cache of its own
_DRIVE = Path(os.environ.get("FITUR_V4_DRIVE") or ROOT / "data" / "drive")
SILVER = _DRIVE / "217f2b804b0c4525"
PESERTA = _DRIVE / "9d7869ab23424a4e"
CACHE = Path(os.environ.get("FITUR_V4_CACHE") or ROOT / ".tmp" / "fitur_v4_ref.pkl")
SEBELUM = date(2024, 12, 18)

NAMES = [
    "v4: domisili_fktp_jarak", "v4: domisili_tinggal_jarak",
    "v4: ganda_dekat", "v4: ganda_dekat_biaya_mirip", "v4: peserta_hari_sama_rs_lain",
    "v4: klon_mirip_3h", "v4: klon_mirip_14h",
    "v4: los_rasio_median_kode", "v4: los_di_bawah_p10", "v4: los_di_bawah_p25",
    "v4: readmisi_setelah_rawat_pendek", "v4: readmisi_jeda_hari", "v4: readmisi_rs_sama", "v4: readmisi_dx_sama",
    "v4: rs_los_rasio_drift", "v4: rs_sev3_drift", "v4: rs_rawat_pendek_drift", "v4: rs_n_rawat_inap_jendela",
    "v4: topup_rasio_median_kode", "v4: topup_kode_jarang", "v4: dx_sekunder_di_atas_p90", "v4: biaya_rasio_median_kode",
]
# rule candidates of v4 (thresholds are chosen on the validation members only; see pilih_aturan)
ATURAN = {"GANDA_DEKAT_BIAYA_MIRIP": "v4: ganda_dekat_biaya_mirip", "KLON_MIRIP": "v4: klon_mirip_3h",
          "READMISI_SETELAH_RAWAT_PENDEK": "v4: readmisi_setelah_rawat_pendek", "RAWAT_TERLALU_PENDEK": "v4: los_di_bawah_p10"}
X_TARIF_TAMBAHAN, X_DX_SEKUNDER = 7, 21  # positions in ssl.x (aip.realtime.ssl SPECS["fkrtl"].base_cols)


def profil(kab, kep, jenis, tipe) -> str:
    parts = ["FKRTL", None if kab is None else str(int(kab)), kep, jenis, tipe if isinstance(tipe, str) and tipe else None]
    return hashlib.md5("|".join(p for p in parts if p is not None).encode("utf-8")).hexdigest()


def referensi() -> dict:
    """Code norms, hospital baselines and the hospital kab/kota (cached)."""
    import pickle

    if CACHE.exists():
        with CACHE.open("rb") as fh:
            return pickle.load(fh)
    import duckdb

    con = duckdb.connect()
    con.execute(f"""CREATE VIEW s AS SELECT *, coalesce(sa_tarif_rp, 0) + coalesce(sp_tarif_rp, 0) + coalesce(rr_tarif_rp, 0) + coalesce(si_tarif_rp, 0)
                    + coalesce(sd_tarif_rp, 0) AS topup FROM read_parquet('{SILVER.as_posix()}') WHERE edisi = 'reguler' AND tgl_datang < DATE '{SEBELUM}'""")
    R: dict[str, Any] = {"kode": {}, "rs": {}}
    for k, med, p10, p25, p90d, medtu, shtu, medb in con.execute("""
            SELECT inacbg_kode, median(los_hari) FILTER (WHERE tingkat_pelayanan = 'RITL'), quantile_cont(los_hari, 0.10) FILTER (WHERE tingkat_pelayanan = 'RITL'),
                   quantile_cont(los_hari, 0.25) FILTER (WHERE tingkat_pelayanan = 'RITL'), quantile_cont(coalesce(jumlah_dx_sekunder, 0), 0.90),
                   median(topup) FILTER (WHERE topup > 0), avg((topup > 0)::INT), median(biaya_tagih_rp)
            FROM s WHERE inacbg_kode IS NOT NULL GROUP BY 1""").fetchall():
        R["kode"][k] = {"med_los": float(med or 0), "p10_los": float(p10 or 0), "p25_los": float(p25 or 0), "p90_dxs": float(p90d or 0),
                        "med_topup": float(medtu or 0), "share_topup": float(shtu or 0), "med_biaya": float(medb or 0)}
    con.execute("""CREATE TABLE ri AS SELECT kabkota_fkrtl_kode kab, kepemilikan_fkrtl kep, jenis_fkrtl jenis, tipe_fkrtl tipe, inacbg_kode kode, los_hari los
                   FROM s WHERE tingkat_pelayanan = 'RITL' AND inacbg_kode IS NOT NULL""")
    rows = con.execute("SELECT kab, kep, jenis, tipe, kode, los FROM ri").fetchall()
    acc: dict[str, list] = defaultdict(lambda: [0, 0.0, 0, 0])
    for kab, kep, jenis, tipe, kode, los in rows:
        km = R["kode"].get(kode) or {}
        a = acc[profil(kab, kep, jenis, tipe)]
        a[0] += 1
        a[1] += (los or 0) / km["med_los"] if km.get("med_los") else 1.0
        a[2] += int(str(kode).endswith("-III"))
        a[3] += int(km.get("p25_los") is not None and (los or 0) < km.get("p25_los", 0))
    for p, (n, s_, s3, sh) in acc.items():
        R["rs"][p] = {"n": n, "los_rasio": s_ / n, "sev3": s3 / n, "pendek": sh / n}
    for kab, kep, jenis, tipe in con.execute("SELECT DISTINCT kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl FROM s").fetchall():
        R["rs"].setdefault(profil(kab, kep, jenis, tipe), {"n": 0, "los_rasio": 1.0, "sev3": 0.0, "pendek": 0.0})["kab"] = int(kab) if kab is not None else None
    con.close()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE.open("wb") as fh:
        pickle.dump(R, fh)
    return R


def domisili(peserta_ids) -> dict[int, tuple]:
    """The registry's FKTP and home kab/kota per member."""
    import duckdb
    import pandas as pd

    con = duckdb.connect()
    con.register("ids", pd.DataFrame({"peserta_id": sorted({int(p) for p in peserta_ids if str(p).isdigit()})}))
    out = {int(p): (a, b) for p, a, b in con.execute(f"""SELECT peserta_id, kabkota_fktp_terdaftar_kode, kabkota_tinggal_kode FROM read_parquet('{PESERTA.as_posix()}')
                                                       WHERE edisi = 'reguler' AND peserta_id IN (SELECT peserta_id FROM ids)""").fetchall()}
    con.close()
    return out


def _jarak(a, b) -> float:
    if a is None or b is None or a != a or b != b:
        return -1.0
    a, b = int(a), int(b)
    return 0.0 if a == b else 1.0 if a // 100 == b // 100 else 2.0


def _hari(s) -> int:
    return (date.fromisoformat(str(s)[:10]) - date(2024, 1, 1)).days


class Fitur4:
    """The stream's claims in arrival order with the indexes X4 needs; `tambah(e)` returns the claim's row and then indexes it."""

    def __init__(self, R: dict, dom: dict[int, tuple]) -> None:
        self.R, self.dom = R, dom
        self.by_mem: dict[str, list] = defaultdict(list)          # (day, faskes, kode, biaya, tingkat, pulang_day, los_ratio, dx3)
        self.by_rs_kode: dict[tuple, list] = defaultdict(list)    # (day, member, dx3, los, biaya)
        self.rs_ri: dict[str, list] = defaultdict(lambda: [0, 0.0, 0, 0])  # n, sum los ratio, n sev3, n short (window, inpatient)

    def tambah(self, e: dict) -> np.ndarray:
        R = self.R
        mem, f, kode, dx3 = str(e.get("peserta")), str(e.get("faskes")), str(e.get("kode")), str(e.get("dx3"))
        d = _hari(e["tgl_datang"])
        dp = _hari(e.get("tgl_pulang") or e["tgl_datang"])
        ritl = e.get("tingkat") == "RITL"
        los = float(e.get("los") or 0)
        biaya = float(e.get("biaya") or 0)
        x = (e.get("ssl") or {}).get("x") or []
        topup = float(x[X_TARIF_TAMBAHAN] or 0) if len(x) > X_TARIF_TAMBAHAN and x[X_TARIF_TAMBAHAN] is not None else 0.0
        dxs = float(x[X_DX_SEKUNDER] or 0) if len(x) > X_DX_SEKUNDER and x[X_DX_SEKUNDER] is not None else 0.0
        km = R["kode"].get(kode) or {}
        rs = R["rs"].get(f) or {}
        kab_rs = rs.get("kab")
        fk, tg = self.dom.get(int(mem), (None, None)) if mem.isdigit() else (None, None)
        # near duplicates and same-day use of the card
        ganda = ganda_b = lain = 0
        prev_ri = None
        for (dd, ff, kk, bb, tt, pd_, lr, dx) in self.by_mem.get(mem, ()):
            if ff == f and kk == kode and abs(dd - d) <= 3:
                ganda += 1
                ganda_b += int(abs(dd - d) <= 1 and biaya > 0 and abs(bb / biaya - 1) <= 0.05)
            if ff != f and abs(dd - d) <= 1:
                lain += 1
            if tt == "RITL" and 0 <= d - pd_ <= 14 and (prev_ri is None or pd_ > prev_ri[0]):
                prev_ri = (pd_, ff, lr, dx)
        # clones: other members, same hospital + code + diagnosis + LOS (±1), bill ±5 %
        k3 = k14 = 0
        for (dd, mm, dx, ll, bb) in (self.by_rs_kode.get((f, kode), ()) if ritl else ()):  # inpatient only: outpatient tariffs are flat
            if mm != mem and dx == dx3 and ll >= 1 and abs(ll - los) <= 1 and biaya > 0 and abs(bb / biaya - 1) <= 0.05:
                k14 += int(abs(dd - d) <= 14)
                k3 += int(abs(dd - d) <= 3)
        # length of stay
        med = km.get("med_los") or 0.0
        lr = los / med if (ritl and med > 0) else -1.0
        bawah10 = float(ritl and med >= 3 and los < (km.get("p10_los") or 0))
        bawah25 = float(ritl and med >= 3 and los < (km.get("p25_los") or 0))
        readm = float(prev_ri is not None and 0 <= prev_ri[2] < 0.6)
        jeda = float(d - prev_ri[0]) if prev_ri is not None else -1.0
        # hospital drift in the window (earlier inpatient claims only)
        h = self.rs_ri[f]
        n_h = h[0]
        drift_los = (h[1] / n_h - rs.get("los_rasio", 1.0)) if n_h else 0.0
        drift_s3 = (h[2] / n_h - rs.get("sev3", 0.0)) if n_h else 0.0
        drift_pd = (h[3] / n_h - rs.get("pendek", 0.0)) if n_h else 0.0
        row = np.array([
            _jarak(fk, kab_rs), _jarak(tg, kab_rs),
            ganda, ganda_b, lain,
            k3, k14,
            lr, bawah10, bawah25,
            readm, jeda, float(prev_ri is not None and prev_ri[1] == f), float(prev_ri is not None and prev_ri[3] == dx3),
            drift_los, drift_s3, drift_pd, math.log1p(n_h),
            (topup / km["med_topup"]) if km.get("med_topup") and topup > 0 else (0.0 if topup <= 0 else 10.0),
            (km.get("share_topup", 0.0) if topup > 0 else -1.0),
            dxs - km.get("p90_dxs", 0.0),
            (biaya / km["med_biaya"]) if km.get("med_biaya") else 1.0,
        ], dtype=np.float32)
        # index this claim for the ones after it
        self.by_mem[mem].append((d, f, kode, biaya, e.get("tingkat"), dp, lr, dx3))
        self.by_rs_kode[(f, kode)].append((d, mem, dx3, los, biaya))
        if ritl:
            h[0] += 1; h[1] += lr if lr >= 0 else 1.0; h[2] += int(kode.endswith("-III")); h[3] += int(bawah25 > 0)
        return row


def matriks(recs: list[dict], dom: dict[int, tuple] | None = None, R: dict | None = None) -> np.ndarray:
    """X4 for events in arrival order (each against the ones before it), the same per-claim path as Fitur4.tambah."""
    R = R or referensi()
    dom = dom if dom is not None else domisili([e.get("peserta") for e in recs])
    f4 = Fitur4(R, dom)
    return np.vstack([f4.tambah(e) for e in recs]) if recs else np.zeros((0, len(NAMES)), np.float32)
