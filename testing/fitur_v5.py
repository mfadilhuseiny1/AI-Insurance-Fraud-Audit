"""X5: mechanism features for Permenkes 16/2019 modes the v4 features cover thinly (ML v5, testing/kriteria_ml_v5.json).
Written from the mode definitions (borrowed cards, routine sessions billed, sudden code spikes, shared-member referral
rings), not from any test generator's scheme list. Every feature is causal: only claims that arrived earlier count.

Inputs per claim: member, hospital, date, INA-CBG code (every data set has them). The member's sex and age come from the
registry; the code's demographic norms from the silver claims (the same world the platform and v4's references use).

    X5 = Fitur5(stream arrays).blok(arrays of one chunk)   # the stream as history, then the chunk's own earlier claims
Synthetic data only."""
from __future__ import annotations

import bisect
import math
import pickle
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SILVER = ROOT / "data" / "drive" / "217f2b804b0c4525"
PESERTA = ROOT / "data" / "drive" / "9d7869ab23424a4e"
CACHE = ROOT / ".tmp" / "fitur_v5_ref.pkl"
UMUR = (1, 5, 15, 25, 45, 56, 60)  # bands <1, 1-4, 5-14, 15-24, 25-44, 45-55, 56-59, 60+
NAMES = ["v5: kode_langka_demografi", "v5: cmg_langka_demografi", "v5: kode_mustahil_demografi", "v5: sesi_kode_sama_14h",
         "v5: sesi_kode_sama_30h", "v5: hari_sejak_kode_sama", "v5: rs_kode_hari_sama", "v5: lonjakan_rs_kode_7h",
         "v5: peserta_rs_berbeda_7h", "v5: rs_pasangan_bersama_7h", "v5: peserta_klaim_7h"]


def _hari(s) -> int:
    return (date.fromisoformat(str(s)[:10]) - date(2024, 1, 1)).days


def _band(u: float | None) -> int:
    return -1 if u is None or u != u else sum(u >= b for b in UMUR)


def referensi() -> dict:
    """Code and CMG counts per (sex, age band) from the silver claims joined to the registry (cached)."""
    if CACHE.exists():
        with CACHE.open("rb") as fh:
            return pickle.load(fh)
    import duckdb

    con = duckdb.connect()
    rows = con.execute(f"""
        WITH s AS (SELECT peserta_id, inacbg_kode k, tgl_datang FROM read_parquet('{SILVER.as_posix()}') WHERE edisi = 'reguler' AND inacbg_kode IS NOT NULL),
             p AS (SELECT peserta_id, CASE WHEN jenis_kelamin ILIKE 'laki%' THEN 'L' ELSE 'P' END jk, tgl_lahir FROM read_parquet('{PESERTA.as_posix()}')
                   WHERE edisi = 'reguler' AND tgl_lahir IS NOT NULL)
        SELECT k, jk, date_diff('day', tgl_lahir, tgl_datang) / 365.25 u FROM s JOIN p USING (peserta_id)""").fetchall()
    con.close()
    kode, cmg, sel = Counter(), Counter(), Counter()
    kode_all, cmg_all = Counter(), Counter()
    for k, jk, u in rows:
        c = (jk, _band(u))
        kode[(k, c)] += 1; cmg[(k[:1], c)] += 1; sel[c] += 1; kode_all[k] += 1; cmg_all[k[:1]] += 1
    R = {"kode": kode, "cmg": cmg, "sel": sel, "kode_all": kode_all, "cmg_all": cmg_all, "n": len(rows)}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE.open("wb") as fh:
        pickle.dump(R, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return R


def demografi(peserta_ids) -> dict[str, tuple[str, date]]:
    import duckdb
    import pandas as pd

    ids = sorted({int(p) for p in peserta_ids if str(p).isdigit()})
    con = duckdb.connect()
    con.register("ids", pd.DataFrame({"peserta_id": ids}))
    out = {str(p): (jk, lahir) for p, jk, lahir in con.execute(f"""SELECT peserta_id, CASE WHEN jenis_kelamin ILIKE 'laki%' THEN 'L' ELSE 'P' END, tgl_lahir
        FROM read_parquet('{PESERTA.as_posix()}') WHERE edisi = 'reguler' AND peserta_id IN (SELECT peserta_id FROM ids)""").fetchall()}
    con.close()
    return out


class Riwayat:
    """Indexes of earlier claims: (member, code) days, member visits, (hospital, code) days, hospital visits."""

    def __init__(self) -> None:
        self.mk: dict = defaultdict(list); self.m: dict = defaultdict(list); self.hk: dict = defaultdict(list); self.h: dict = defaultdict(list)
        self.hk_hari: dict = defaultdict(Counter)

    def tambah(self, m: str, h: str, k: str, d: int) -> None:
        bisect.insort(self.mk[(m, k)], d); self.m[m].append((d, h)); bisect.insort(self.hk[(h, k)], d); self.h[h].append((d, m))
        self.hk_hari[(h, k)][d] += 1


class Fitur5:
    def __init__(self, stream: dict) -> None:
        self.R = referensi()
        self.base = Riwayat()
        self.d0 = None
        self.X_stream = self._jalan(self.base, stream, simpan_awal=True)

    def _rarity(self, key, cell, tab, sel, all_, n, alpha=20.0) -> float:
        p_prior = (all_.get(key, 0) + 1.0) / (n + len(all_) + 1.0)
        p = (tab.get((key, cell), 0) + alpha * p_prior) / (sel.get(cell, 0) + alpha)
        return -math.log(max(p, 1e-12))

    def _jalan(self, base: Riwayat, arr: dict, simpan_awal: bool = False) -> np.ndarray:
        """Features for the claims of arr in order, each against base + the earlier claims of arr (base is not changed
        unless simpan_awal: the stream itself becomes the base history)."""
        dem = demografi(arr["peserta"])
        ov = base if simpan_awal else Riwayat()
        out = np.full((len(arr["peserta"]), len(NAMES)), np.nan, np.float32)
        R = self.R

        def days(idx_base, idx_ov, key):
            a = idx_base.get(key, []) if not simpan_awal else []
            b = idx_ov.get(key, [])
            return a, b

        for i, (m, h, t, k) in enumerate(zip(arr["peserta"], arr["faskes"], arr["tgl"], arr["kode"])):
            m, h, k = str(m), str(h), str(k)
            d = _hari(t)
            jk, lahir = dem.get(m, (None, None))
            u = None if lahir is None else (date.fromisoformat(str(t)[:10]) - lahir).days / 365.25
            cell = (jk, _band(u))
            if jk is not None:
                out[i, 0] = self._rarity(k, cell, R["kode"], R["sel"], R["kode_all"], R["n"])
                out[i, 1] = self._rarity(k[:1], cell, R["cmg"], R["sel"], R["cmg_all"], R["n"])
                c = k[:1]
                out[i, 2] = float((c == "O" and (jk == "L" or (u is not None and (u < 10 or u > 55)))) or (c == "W" and jk == "L") or (c == "V" and jk == "P")
                                  or (c == "P" and u is not None and u >= 1))
            # member x code sessions
            a, b = days(base.mk, ov.mk, (m, k))
            hit14 = sum(1 for x in (a + b) if d - 14 <= x <= d)
            hit30 = sum(1 for x in (a + b) if d - 30 <= x <= d)
            prev = [x for x in (a + b) if x <= d]
            out[i, 3], out[i, 4] = hit14, hit30
            out[i, 5] = min(365, d - max(prev)) if prev else -1
            # hospital x code: same day and the 7-day spike against the hospital-code's earlier daily rate
            a, b = days(base.hk, ov.hk, (h, k))
            hk_all = a + b
            out[i, 6] = sum(1 for x in hk_all if x == d)
            last7 = sum(1 for x in hk_all if d - 7 <= x <= d)
            older = [x for x in hk_all if x < d - 7]
            if older:
                span = max(7.0, (d - 7) - min(older))
                out[i, 7] = (last7 + 1.0) / (len(older) * 7.0 / span + 1.0)
            else:
                out[i, 7] = last7 + 1.0
            # member across hospitals in 7 days
            mv = (base.m.get(m, []) if not simpan_awal else []) + ov.m.get(m, [])
            recent = [(x, hh) for x, hh in mv if d - 7 <= x <= d]
            out[i, 8] = len({hh for _, hh in recent if hh != h})
            out[i, 10] = len(recent)
            # hospital pairs sharing members in 7 days: members seen at h recently, and the other hospitals they used
            hv = (base.h.get(h, []) if not simpan_awal else []) + ov.h.get(h, [])
            mem_h = {mm for x, mm in hv if d - 7 <= x <= d} | {m}
            partner = Counter()
            for mm in list(mem_h)[:400]:
                mmv = (base.m.get(mm, []) if not simpan_awal else []) + ov.m.get(mm, [])
                for hh in {hh for x, hh in mmv if d - 7 <= x <= d and hh != h}:
                    partner[hh] += 1
            out[i, 9] = max(partner.values()) if partner else 0
            ov.tambah(m, h, k, d)
        return out

    def blok(self, arr: dict) -> np.ndarray:
        return self._jalan(self.base, arr)
