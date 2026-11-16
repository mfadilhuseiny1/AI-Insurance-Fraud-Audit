"""Training data v4 (stage 1 of the plan of 2026-11-12, after generator 2 and the v3 retrain): the clean draw of data_v2 (fixed
member roles, no echo, single feature path) with fraud of every strength and realistic normal journeys, plus the features X4
(testing/fitur_v4.py). Written to .tmp/data_v4/fitur_<c>.npz with the keys of data_v2 plus X4 and varian; chunks 0–7 are training
members, 8–9 validation members (testing/bersih.py roles). Synthetic data only.

What changed against data_v2 (and why):
- magnitudes from subtle to blatant for every single-claim scheme (v3 learned generator 1's blatant magnitudes and missed subtler
  ones): secondary diagnoses p90+1..3 or p99+3..12; top-ups 1.3–6x the code's median (added or raised); upcoding one or two steps at
  ×1.15–2.2; fictitious top-ups 0.3–9 million (log-uniform);
- length of stay as INA-CBG pays it (the user, 2026-11-12: the claim is per episode, the abuse is the SHORT stay): premature discharge
  (stay cut to 30–65 % of the code's usual, hospital-wide and scattered; a quality issue, labelled "pulang_cepat") and premature
  discharge followed by a readmission billed as a second episode (both claims labelled "pulang_cepat_readmisi"); a few prolonged
  stays kept ("los_bergeser");
- repeat billing and cloning in exact and near forms (dates shifted 0–3 days, bills ±3 %); episode splitting;
- a card used at another hospital; rings of 3–8 members over 2–4 hospitals within 1–10 days with partial participation; a few claims
  billed for members from far away ("klaim_fiktif_jauh");
- normal claims include members' natural repeat visits (sequences of 2–4 claims within 13 days, moved together with their gaps), so
  repeat visits are not a fraud marker.
Usage: .venv/Scripts/python.exe testing/data_v4.py jalankan | chunk <c> | stream"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import uji100k as U  # noqa: E402

KERJA = ROOT / ".tmp" / "data_v4"
N_V4, VALIDASI = 10, (8, 9)
ASAL = (date(2024, 1, 1), date(2024, 8, 31))
W0, W1 = U.W0, U.W1
SPECIALS, SEV3 = U.SPECIALS, U.SEV3
SEV2 = "Sedang (rawat inap keparahan 2)"
N = {"kelas_naik": 25, "dx_sekunder": 25, "topup_fiktif": 25, "topup_inflasi": 25, "prosedur_fiktif": 25, "kode_tidak_sesuai": 20,
     "upcoding_sebar": 12, "pulang_cepat_sebar": 8, "pulang_cepat_readmisi": 10, "los_bergeser": 6, "pemecahan_episode": 6,
     "kloning": 4, "klaim_ganda": 12, "kartu_dipinjam": 8, "cincin": 2, "klaim_fiktif_jauh": 8, "normal": 3000, "perjalanan": 350}
T0 = time.time()


def say(*a) -> None:
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def chunk(c: int, keluar: Path) -> None:
    import pandas as pd

    import bersih as BS

    data_root = KERJA / f"data_{c:02d}"
    U.salin(data_root)
    say("data copied", data_root)
    os.environ["BLUESANDAI_AUTH"] = "off"
    sys.path.insert(0, str(ROOT / "api"))
    from mailer import env
    from aip import vertex

    vertex.configure(data_root, env)
    import platform_lokal

    platform_lokal.pasang()
    import duckdb
    import joblib
    from aip import layanan as L
    from aip.realtime import mesin as E
    import fitur as FT
    import fitur_v4 as F4

    E.ENGINE.start(None)
    while not E.ENGINE.ready():
        time.sleep(1)
    eng = E.ENGINE
    say("engine ready")
    m = joblib.load(HERE / "model" / "model.joblib")  # the standardisation (mu, sd) only
    ssl = FT.load_ssl(None)
    con = sqlite3.connect(f"file:{data_root / 'aip' / 'realtime' / 'realtime.sqlite'}?mode=ro", uri=True)
    recs = [json.loads(r) for r, in con.execute("""SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                 WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'uji:%' OR p.sumber LIKE 'aug:%') ORDER BY p.seq""")]
    con.close()
    st = FT.Stream(FT.sys_features(recs, ssl), [FT.claim_fields(e) for e in recs], m["mu"], m["sd"])
    say("stream", len(st), "claims")

    rng = random.Random(25000 + c)
    stream_members = BS.dipakai()["aliran"] | {int(fd["peserta"]) for fd in st.f if str(fd["peserta"]).isdigit()}
    tidak = BS.semua_dipakai()
    have = {r[0] for r in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{U.SILVER.as_posix()}')").fetchall()}
    cols = [f for f in L.KlaimIn.model_fields if f in have]
    peran = BS.tabel_peran(U.SILVER)
    pilih = peran[(peran.peran == "latih") & (peran.ember8 == c)] if c not in VALIDASI else peran[(peran.peran == "validasi") & (peran.ember2 == c - VALIDASI[0])]
    duckdb.register("anggota_chunk", pilih[["peserta_id"]])
    semua = duckdb.sql(f"""SELECT {', '.join(cols)} FROM read_parquet('{U.SILVER.as_posix()}')
                           WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{ASAL[0]}' AND DATE '{ASAL[1]}'
                           AND peserta_id IN (SELECT peserta_id FROM anggota_chunk)""").df()
    semua = semua[~semua.peserta_id.isin(stream_members | tidak)].reset_index(drop=True)
    # natural journeys: members with 2–4 claims within 13 days (one sequence per member, moved together)
    semua["_d"] = pd.to_datetime(semua.tgl_datang)
    semua = semua.sort_values(["peserta_id", "_d"]).reset_index(drop=True)
    jalan: list[list[int]] = []
    pakai_jalan: set[int] = set()
    for pid, g in semua.groupby("peserta_id"):
        if len(g) < 2:
            continue
        idx, ds = list(g.index), list(g._d)
        for a in range(len(idx) - 1):
            b = a
            while b + 1 < len(idx) and (ds[b + 1] - ds[a]).days <= 13 and b - a < 3:
                b += 1
            if b > a:
                jalan.append(idx[a:b + 1]); pakai_jalan.add(int(pid))
                break
    rng.shuffle(jalan)
    jalan = jalan[:N["perjalanan"]]
    jalan_pid = {int(semua.loc[j[0], "peserta_id"]) for j in jalan}
    pool = semua[~semua.peserta_id.isin(jalan_pid)].sample(frac=1, random_state=c + 2500).drop_duplicates("peserta_id").reset_index(drop=True)
    pool["prof"] = pool.kabkota_fkrtl_kode.astype(str) + "|" + pool.kepemilikan_fkrtl.astype(str) + "|" + pool.jenis_fkrtl.astype(str) + "|" + pool.tipe_fkrtl.astype(str)
    say(f"pool {len(pool)} members, {len(jalan)} journeys")
    used: set[int] = set()

    def bersihkan(row) -> dict:
        return {k: (None if (isinstance(v, float) and v != v) else v) for k, v in row.to_dict().items()}

    def ambil(mask) -> dict:
        idx = [i for i in pool.index[mask] if i not in used]
        if not idx:
            raise LookupError
        i = rng.choice(idx[:400])
        used.add(i)
        return bersihkan(pool.loc[i])

    def tanggal_baru(d0, lo=None) -> date:
        d0 = pd.Timestamp(d0).date()
        lo = max(W0, d0 + timedelta(days=45)) if lo is None else lo
        return lo + timedelta(days=rng.randint(0, max(0, (W1 - lo).days)))

    def pindah(r: dict, target: date | None = None) -> dict:
        d0 = pd.Timestamp(r["tgl_datang"]).date()
        t = target or tanggal_baru(d0)
        delta = t - d0
        r["tgl_datang"] = t
        if r.get("tgl_pulang") is not None:
            r["tgl_pulang"] = pd.Timestamp(r["tgl_pulang"]).date() + delta
        return r

    ritl = pool.tingkat_pelayanan == "RITL"
    out: list[tuple[dict, str, str]] = []
    nomor = [0]

    def tambah(r: dict, sk: str, varian: str = "") -> dict:
        nomor[0] += 1
        r.setdefault("_asal", str(r.get("kunjungan_fkrtl_id")))
        r["kunjungan_fkrtl_id"] = f"V4L{c:02d}{nomor[0]:06d}"
        r["edisi"] = "reguler"
        if r["tgl_datang"] > W1:  # stays inside the window
            sh = r["tgl_datang"] - W1
            r["tgl_datang"] -= sh
            r["tgl_pulang"] = (r["tgl_pulang"] - sh) if r.get("tgl_pulang") is not None else None
        out.append((r, sk, varian))
        return r

    def coba(n: int, buat) -> int:
        k = 0
        for _ in range(n):
            try:
                buat(); k += 1
            except (LookupError, ValueError, KeyError):
                pass
        return k

    ref = eng.ref
    los_ref = eng.los_ref  # code -> (median, p90)
    reg = eng.con.cursor()
    reg.register("ids", pd.DataFrame({"peserta_id": pool.peserta_id.astype("int64").unique()}))
    pbi3 = {int(p) for p, in reg.execute("""SELECT peserta_id FROM anggota WHERE edisi = 'reguler' AND segmen LIKE 'PBI%' AND hak = 3
                                                AND peserta_id IN (SELECT peserta_id FROM ids)""").fetchall()}
    reg.close()
    n200 = pool.inacbg_kode.map(lambda k: (ref.kode.get(k) or {}).get("n", 0) >= 200)
    R4 = F4.referensi()
    lu = lambda a, b: math.exp(rng.uniform(math.log(a), math.log(b)))  # noqa: E731  log-uniform

    def kelas_naik():
        r = pindah(ambil(ritl & pool.peserta_id.isin(pbi3)))
        r["kelas_rawat"] = rng.choice(["Kelas 1", "Kelas 2"])
        if rng.random() < 0.6:
            add = int((r.get("tarif_inacbg_rp") or 0) * rng.uniform(0.1, 0.4))
            r["tarif_inacbg_rp"] = int(r.get("tarif_inacbg_rp") or 0) + add; r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + add
        tambah(r, "kelas_naik")

    def dx_sekunder():
        r = pindah(ambil(n200 & (ritl if rng.random() < 0.7 else ~ritl)))
        km = R4["kode"].get(r["inacbg_kode"]) or {}
        if rng.random() < 0.4:
            r["jumlah_dx_sekunder"] = int(math.ceil(km.get("p90_dxs", 2))) + rng.randint(1, 3); v = "halus"
        else:
            r["jumlah_dx_sekunder"] = int(ref.kode[r["inacbg_kode"]]["dx_sek_p99"]) + rng.randint(3, 12); v = "mencolok"
        tambah(r, "dx_sekunder", v)

    def jarang(k) -> list[str]:
        return [s for s in SPECIALS if (ref.topup.get((k, s)) or {}).get("n", 0) <= 2]

    def topup_fiktif():
        r = pindah(ambil(n200 & pool.inacbg_kode.map(lambda k: bool(jarang(k))) & (ritl if rng.random() < 0.8 else ~ritl)))
        col = rng.choice(jarang(r["inacbg_kode"]))
        amt = int(round(lu(3e5, 9e6), -4))
        r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + amt - int(r.get(col) or 0); r[col] = amt
        tambah(r, "topup_fiktif", "halus" if amt < 1.5e6 else "mencolok")

    def lazim(k) -> list[str]:
        return [s for s in SPECIALS if (ref.topup.get((k, s)) or {}).get("n", 0) >= 20]

    def topup_inflasi():
        r = pindah(ambil(pool.inacbg_kode.map(lambda k: bool(lazim(k)))))
        col = rng.choice(lazim(r["inacbg_kode"]))
        base = (R4["kode"].get(r["inacbg_kode"]) or {}).get("med_topup") or ref.topup[(r["inacbg_kode"], col)]["p95"] / 2
        mult = lu(1.3, 6.0)
        amt = int(round(max(float(r.get(col) or 0), base) * mult, -3))
        r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + amt - int(r.get(col) or 0); r[col] = amt
        tambah(r, "topup_inflasi", "halus" if mult < 2 else "mencolok")

    prosedur = pool.inacbg_kode.astype(str).str[2].isin(["1", "3"]) & pool.prosedur.notna()
    medis_pros = [p for p in pool[pool.inacbg_kode.astype(str).str[2].isin(["4", "5"]) & pool.prosedur.notna()].prosedur.head(300)]

    def prosedur_fiktif():
        r = pindah(ambil(prosedur))
        if rng.random() < 0.6 or not medis_pros:
            r["prosedur"] = None; v = "dikosongkan"
        else:
            r["prosedur"] = rng.choice(medis_pros); v = "tindakan_ringan"
        tambah(r, "prosedur_fiktif", v)

    for sk, fn in (("kelas_naik", kelas_naik), ("dx_sekunder", dx_sekunder), ("topup_fiktif", topup_fiktif),
                   ("topup_inflasi", topup_inflasi), ("prosedur_fiktif", prosedur_fiktif)):
        say(sk, coba(N[sk], fn))

    # an INA-CBG code that almost never goes with the diagnosis (as data_v2), half of them a higher-tariff code
    n_kts, idx_ritl = 0, list(pool.index[ritl][:5000])
    for _ in range(8000):
        if n_kts >= N["kode_tidak_sesuai"]:
            break
        i, j = rng.choice(idx_ritl), rng.choice(idx_ritl)
        if i in used or j in used or i == j:
            continue
        t, o = pool.loc[i], pool.loc[j]
        if o.inacbg_kode and ref.rare_pair(t.dx_primer_icd3, o.inacbg_kode) and (rng.random() < 0.5 or (o.tarif_inacbg_rp or 0) > (t.tarif_inacbg_rp or 0)):
            used.update({i, j})
            r = bersihkan(o)
            tt = pindah(bersihkan(t))
            r.update(peserta_id=int(t.peserta_id), dx_primer_icd3=t.dx_primer_icd3, dx_primer_kode=t.dx_primer_kode, dx_primer_nama=t.dx_primer_nama,
                     tgl_datang=tt["tgl_datang"], tgl_pulang=tt["tgl_datang"] + timedelta(days=int(o.los_hari or 2)))
            tambah(r, "kode_tidak_sesuai"); n_kts += 1
    say("kode_tidak_sesuai", n_kts)

    # upcoding: two hospital batches of 6–12 plus scattered; one step (70 %) or two
    def opsi_naik(k) -> list[str]:
        base, _, sev = str(k).rpartition("-")
        return [f"{base}-{s}" for s in {"I": ("II", "III"), "II": ("III",)}.get(sev, ()) if f"{base}-{s}" in eng.known_codes]

    bisa_naik = pool.inacbg_kode.map(lambda k: bool(opsi_naik(k)))

    def upcode(r: dict) -> str:
        ops = opsi_naik(r["inacbg_kode"])
        up = ops[0] if rng.random() < 0.7 else ops[-1]
        tarif0 = r.get("tarif_inacbg_rp") or r["biaya_tagih_rp"]
        tarif = int(tarif0 * rng.uniform(1.15, 2.2))
        r.update(inacbg_kode=up, inacbg_keparahan=SEV3 if up.endswith("-III") else SEV2,
                 inacbg_deskripsi=(eng.code_ref.get(up) or {}).get("inacbg_deskripsi") or r.get("inacbg_deskripsi"),
                 biaya_tagih_rp=tarif + int((r["biaya_tagih_rp"] or 0) - (r.get("tarif_inacbg_rp") or 0)), tarif_inacbg_rp=tarif,
                 jumlah_dx_sekunder=int(r.get("jumlah_dx_sekunder") or 0) + rng.randint(0, 3))
        return "satu_tingkat" if up == ops[0] else "dua_tingkat"

    # premature discharge (INA-CBG: same claim, fewer days): the stay cut to 30–65 % of the code's usual
    def los_med(k) -> float:
        return float((los_ref.get(k) or (0, 0))[0] or (R4["kode"].get(k) or {}).get("med_los") or 0)

    bisa_pendek = ritl & pool.inacbg_kode.map(lambda k: los_med(k) >= 3) & (pool.los_hari.fillna(0) >= 3)

    def pendek(r: dict) -> str:
        los = max(1, int(round(max(los_med(r["inacbg_kode"]), float(r.get("los_hari") or 0)) * rng.uniform(0.3, 0.65))))
        los = min(los, max(1, int(r.get("los_hari") or 1) - 1))
        r.update(los_hari=los, tgl_pulang=r["tgl_datang"] + timedelta(days=los), status_pulang="Sehat")
        return ""

    profs_ritl = list(pool[ritl].prof.value_counts().index[:40])
    for sk, mask, ubah, n_sebar in (("upcoding", ritl & bisa_naik, upcode, N["upcoding_sebar"]), ("pulang_cepat", bisa_pendek, pendek, N["pulang_cepat_sebar"])):
        k = 0
        prs = profs_ritl[:]; rng.shuffle(prs)
        for _batch in range(2 if sk == "upcoding" else 1):
            n = rng.randint(6, 12) if sk == "upcoding" else rng.randint(4, 8)
            for prof in prs:
                cand = [i for i in pool.index[mask & (pool.prof == prof)] if i not in used]
                if len(cand) >= n:
                    prs.remove(prof)
                    for i in cand[:n]:
                        used.add(i)
                        r = pindah(bersihkan(pool.loc[i])); v = ubah(r); tambah(r, sk, v or "rs"); k += 1
                    break

        def satu(mask=mask, ubah=ubah, sk=sk):
            r = pindah(ambil(mask)); v = ubah(r); tambah(r, sk, v or "sebar")

        k += coba(n_sebar, satu)
        say(sk, k)

    # premature discharge then a readmission billed as a second episode (both claims)
    def pulang_cepat_readmisi():
        r = pindah(ambil(bisa_pendek), target=W0 + timedelta(days=rng.randint(0, 6)))
        pendek(r)
        a = tambah(r, "pulang_cepat_readmisi", "rawat_pertama")
        x = {k: v for k, v in a.items() if not k.startswith("_") and k != "kunjungan_fkrtl_id"}
        d = a["tgl_pulang"] + timedelta(days=rng.randint(1, 7))
        los2 = rng.randint(1, max(2, int(los_med(a["inacbg_kode"]))))
        base = a["inacbg_kode"].rsplit("-", 1)[0]
        kode2 = rng.choice([k for k in (f"{base}-I", f"{base}-II", f"{base}-III") if k in eng.known_codes] or [a["inacbg_kode"]])
        x.update(tgl_datang=d, tgl_pulang=d + timedelta(days=los2), los_hari=los2, inacbg_kode=kode2,
                 inacbg_deskripsi=(eng.code_ref.get(kode2) or {}).get("inacbg_deskripsi") or a.get("inacbg_deskripsi"), _asal=a["_asal"])
        if rng.random() < 0.2:  # sometimes at another hospital of the same kab/kota
            o = ambil(ritl & (pool.kabkota_fkrtl_kode == a["kabkota_fkrtl_kode"]) & (pool.prof != f"{a['kabkota_fkrtl_kode']}|{a['kepemilikan_fkrtl']}|{a['jenis_fkrtl']}|{a['tipe_fkrtl']}"))
            x.update({k: o[k] for k in ("kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl", "kabkota_fkrtl_kode", "kabkota_fkrtl", "provinsi_fkrtl", "regional_tarif") if k in o})
        tambah(x, "pulang_cepat_readmisi", "readmisi")

    say("pulang_cepat_readmisi", coba(N["pulang_cepat_readmisi"], pulang_cepat_readmisi))

    def los_bergeser():
        r = pindah(ambil(ritl))
        los = int(r.get("los_hari") or 2) + rng.randint(1, 3) if rng.random() < 0.5 else max(4, int(r.get("los_hari") or 2) * 2)
        r.update(los_hari=los, tgl_pulang=r["tgl_datang"] + timedelta(days=los)); tambah(r, "los_bergeser")

    def pemecahan():
        r = pindah(ambil(ritl & (pool.los_hari.fillna(0) >= 4)), target=W0 + timedelta(days=rng.randint(0, 6)))
        los0, k = int(r["los_hari"]), rng.randint(1, int(r["los_hari"]) - 2)
        a = dict(r); a.update(los_hari=k, tgl_pulang=r["tgl_datang"] + timedelta(days=k))
        a = tambah(a, "pemecahan_episode", "bagian_1")
        b = {kk: v for kk, v in r.items() if not kk.startswith("_") and kk != "kunjungan_fkrtl_id"}
        d = a["tgl_pulang"] + timedelta(days=rng.randint(0, 1))
        b.update(tgl_datang=d, los_hari=max(1, los0 - k), tgl_pulang=d + timedelta(days=max(1, los0 - k)), _asal=a["_asal"])
        tambah(b, "pemecahan_episode", "bagian_2")

    say("los_bergeser", coba(N["los_bergeser"], los_bergeser), "pemecahan_episode", coba(N["pemecahan_episode"], pemecahan))

    # cloning: one claim on 2–6 other members, exact or with small changes
    k = 0
    for _ in range(N["kloning"]):
        try:
            t = pindah(ambil(ritl & (pool.los_hari.fillna(0) >= 2)))
        except LookupError:
            continue
        for _k in range(rng.randint(2, 6)):
            try:
                mbr = ambil(pool.index >= 0)
            except LookupError:
                break
            r = {**t, "peserta_id": int(mbr["peserta_id"])}
            if rng.random() < 0.5:
                r["biaya_tagih_rp"] = int(round(int(t["biaya_tagih_rp"]) * rng.uniform(0.97, 1.03), -3))
            sh = timedelta(days=rng.randint(0, 3))
            r["tgl_datang"] = t["tgl_datang"] + sh
            r["tgl_pulang"] = (t["tgl_pulang"] + sh) if t.get("tgl_pulang") is not None else None
            tambah(r, "kloning"); k += 1
    say("kloning", k)

    # rings: 3–8 members, 2–4 hospitals of one province, within 1–10 days, partial participation
    besar = pool.prof.value_counts()
    besar = set(besar[besar >= 6].index)
    sub = pool[pool.prof.isin(besar)]
    prov = sub.groupby(sub.kabkota_fkrtl_kode // 100).prof.nunique()
    k = 0
    for _ in range(N["cincin"]):
        nh, nm, span = rng.randint(2, 4), rng.randint(3, 8), rng.randint(1, 10)
        pvs = [p for p, n in prov.items() if n >= nh]
        if not pvs:
            continue
        pv = rng.choice(pvs)
        profs = rng.sample(sorted(p for p in pool[(pool.kabkota_fkrtl_kode // 100) == pv].prof.unique() if p in besar), nh)
        d0 = W0 + timedelta(days=rng.randint(0, max(0, (W1 - W0).days - span)))
        for _m in range(nm):
            try:
                mbr = int(ambil(pool.index >= 0)["peserta_id"])
            except LookupError:
                break
            ikut = [p for p in profs if rng.random() < 0.75]
            ikut = ikut if len(ikut) >= 2 else rng.sample(profs, 2)
            for prof in ikut:
                pm = pool.prof == prof
                try:
                    r = ambil(pm & (pool.tingkat_pelayanan == "RJTL"))
                except LookupError:
                    try:
                        r = ambil(pm)
                    except LookupError:
                        continue
                d = d0 + timedelta(days=rng.randint(0, span))
                los = 2 if r.get("tingkat_pelayanan") == "RITL" else 0
                r.update(peserta_id=mbr, tgl_datang=d, tgl_pulang=d + timedelta(days=los))
                tambah(r, "cincin_kolusi"); k += 1
    say("cincin_kolusi", k)

    # claims billed for members from far away (another province), who never came
    def jauh():
        r = pindah(ambil(pool.tingkat_pelayanan == "RJTL"))
        o = ambil((pool.kabkota_fkrtl_kode // 100) != int(r["kabkota_fkrtl_kode"]) // 100)
        r.update(peserta_id=int(o["peserta_id"]))
        tambah(r, "klaim_fiktif_jauh")

    say("klaim_fiktif_jauh", coba(N["klaim_fiktif_jauh"], jauh))

    # normal claims: single claims and natural journeys
    k = coba(N["normal"], lambda: tambah(pindah(ambil(pool.index >= 0)), "normal"))
    kj = 0
    sumber_jalan = []
    for j in jalan:
        rows = [bersihkan(semua.loc[i]) for i in j]
        sumber_jalan += [dict(r) for r in rows]  # the ORIGINAL rows (dates before moving) for the echo removal
        d0 = pd.Timestamp(rows[0]["tgl_datang"]).date()
        span = (pd.Timestamp(rows[-1]["tgl_datang"]).date() - d0).days
        t = W0 + timedelta(days=rng.randint(0, max(0, (W1 - W0).days - span)))
        for r in rows:
            r.pop("_d", None)
            pindah(r, target=t + (pd.Timestamp(r["tgl_datang"]).date() - d0))
            tambah(r, "normal", "perjalanan"); kj += 1
    say("normal", k, "journey claims", kj)
    rng.shuffle(out)
    normals = [b for b, sk, _ in out if sk == "normal"]
    # repeat billing: exact copies or near duplicates (date 0–2 days later, bill ±3 %), arriving after the original
    for b in rng.sample(normals, N["klaim_ganda"]):
        x = {kk: v for kk, v in b.items() if not kk.startswith("_") and kk != "kunjungan_fkrtl_id"}
        x["_asal"] = b["_asal"]
        if rng.random() < 0.6:
            sh = timedelta(days=rng.randint(0, 2))
            x["tgl_datang"] = b["tgl_datang"] + sh
            x["tgl_pulang"] = (b["tgl_pulang"] + sh) if b.get("tgl_pulang") is not None else None
            x["biaya_tagih_rp"] = int(round(int(b["biaya_tagih_rp"]) * rng.uniform(0.97, 1.03), -3)); v = "mirip"
        else:
            v = "persis"
        tambah(x, "klaim_ganda", v)
    inap = [b for b in normals if b.get("tingkat_pelayanan") == "RITL" and int(b.get("los_hari") or 0) >= 3]
    kd = 0
    for t0 in rng.sample(inap, min(N["kartu_dipinjam"], len(inap))):
        try:
            same_prov = rng.random() < 0.5
            o = ambil(ritl & (((pool.kabkota_fkrtl_kode // 100) == int(t0["kabkota_fkrtl_kode"]) // 100) & (pool.kabkota_fkrtl_kode != int(t0["kabkota_fkrtl_kode"]))
                              if same_prov else ((pool.kabkota_fkrtl_kode // 100) != int(t0["kabkota_fkrtl_kode"]) // 100)))
        except LookupError:
            continue
        d = t0["tgl_datang"] + timedelta(days=rng.randint(0, int(t0["los_hari"]) - 1))
        los = rng.randint(1, 4)
        o.update(peserta_id=int(t0["peserta_id"]), tgl_datang=d, tgl_pulang=d + timedelta(days=los), los_hari=los)
        tambah(o, "kartu_dipinjam", "provinsi_sama" if same_prov else "provinsi_lain"); kd += 1
    say("klaim_ganda", N["klaim_ganda"], "kartu_dipinjam", kd, "· claims", len(out), "fraud", sum(1 for _, s, _v in out if s != "normal"))
    out.sort(key=lambda t: (t[0]["tgl_datang"], t[0]["kunjungan_fkrtl_id"]))

    def ke_klaim(b: dict):
        b = {k: v for k, v in b.items() if k in L.KlaimIn.model_fields}
        for k in ("tgl_datang", "tgl_pulang"):
            if b.get(k) is not None:
                b[k] = pd.Timestamp(b[k]).date()
        for k in ("peserta_id", "kabkota_fkrtl_kode", "tarif_inacbg_rp", *SPECIALS, "biaya_tagih_rp", "los_hari", "jumlah_dx_sekunder"):
            if b.get(k) is not None:
                b[k] = int(b[k])
        for k in SPECIALS:
            b[k] = b.get(k) or 0
        for k in ("flag_calon_klaim_ganda", "flag_los_ekstrem", "layanan_covid"):
            b[k] = bool(b.get(k) or False)
        b = {k: v for k, v in b.items() if v is not None or k in ("tipe_fkrtl", "prosedur")}
        return L.KlaimIn.model_validate(b)

    objs, labels, varian, asal = [], [], [], []
    for b, sk, v in out:
        try:
            objs.append(ke_klaim(b)); labels.append(sk); varian.append(v); asal.append(b.get("_asal") or "")
        except Exception as e:  # noqa: BLE001
            say("skipped a claim:", sk, str(e)[:120])
    # no echo: every source claim used leaves the member history before anything is ingested
    sumber = [bersihkan(pool.loc[i]) for i in sorted(used)] + sumber_jalan
    gema = BS.hapus_gema(eng.con, sumber)
    gema["sisa"] = BS.sisa_gema(eng.con, sumber)
    say("echo removed", gema)
    t1 = time.time()
    ids = []
    for a in range(0, len(objs), 2000):
        ids += eng.ingest(objs[a:a + 2000], f"datav4:{c}", None)
        while len(eng.q) > 3000:
            time.sleep(0.5)
    briefs = eng.wait(ids, 3600)
    keep = [k for k, b in enumerate(briefs) if b and b.get("keputusan") not in ("GAGAL", "DIGANTIKAN")]
    say(f"engine judged {len(keep)}/{len(ids)} in {time.time() - t1:.0f} s")
    recs_new = [eng.store.event(ids[k]) for k in keep]
    labels, varian, asal = [labels[k] for k in keep], [varian[k] for k in keep], [asal[k] for k in keep]
    S_new = FT.sys_features(recs_new, ssl)
    rows1, rows2, rowsr = [], [], []
    for x, e in zip(S_new, recs_new):
        i = st.append(x, FT.claim_fields(e))
        rows1.append(st.agg_row(i)); rows2.append(st.s2_row(i)); rowsr.append(st.r2_row(i))
    # X4: the stream first (same events, same order as the Stream), then the new claims, one at a time
    dom = F4.domisili([e.get("peserta") for e in recs] + [e.get("peserta") for e in recs_new])
    f4 = F4.Fitur4(R4, dom)
    for e in recs:
        f4.tambah(e)
    X4 = np.vstack([f4.tambah(e) for e in recs_new]).astype(np.float32)
    lab = np.array(labels)
    np.savez_compressed(keluar, sk=lab, varian=np.array(varian), X1=np.vstack(rows1).astype(np.float32), X2=np.vstack(rows2).astype(np.float32),
                        XR=np.vstack(rowsr).astype(np.float32), X4=X4,
                        tahan=np.array([e.get("keputusan") == "TAHAN" for e in recs_new]), periksa=np.array([e.get("keputusan") == "PERIKSA" for e in recs_new]),
                        peserta=np.array([str(e.get("peserta")) for e in recs_new]), faskes=np.array([str(e.get("faskes")) for e in recs_new]),
                        tgl=np.array([str(e.get("tgl_datang"))[:10] for e in recs_new]), kode=np.array([str(e.get("kode")) for e in recs_new]),
                        asal=np.array(asal), chunk=np.full(len(lab), c), gema=np.array([json.dumps(gema)]))
    say(f"chunk {c} saved: {len(lab)} claims, fraud {int((lab != 'normal').sum())}", {s: int((lab == s).sum()) for s in sorted(set(lab)) if s != "normal"})
    eng.stop() if hasattr(eng, "stop") else None


def stream() -> None:
    """X4 of the labelled stream (latih_model.load_labeled order, as the stream caches), with the claim ids for alignment."""
    os.environ["BLUESANDAI_AUTH"] = "off"
    sys.path.insert(0, str(ROOT / "api"))
    import fitur_v4 as F4
    import latih_model as LM

    recs, y, sk = LM.load_labeled(ROOT / ".tmp" / "testing-data" / "aip" / "realtime" / "realtime.sqlite")
    X4 = F4.matriks(recs)
    KERJA.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(KERJA / "stream_x4.npz", X4=X4.astype(np.float32), klaim=np.array([str(e.get("klaim")) for e in recs]), sk=sk, y=y)
    say("stream X4", X4.shape, "→", KERJA / "stream_x4.npz")


def jalankan() -> None:
    KERJA.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONUTF8": "1", "TEMP": str(ROOT / ".tmp"), "TMP": str(ROOT / ".tmp")}
    for c in range(N_V4):
        keluar = KERJA / f"fitur_{c:02d}.npz"
        if keluar.exists():
            say("chunk", c, "done earlier")
            continue
        for coba_ in range(3):
            log = KERJA / f"log_{c:02d}.txt"
            say("chunk", c, "running" + (f" (retry {coba_})" if coba_ else ""))
            with log.open("w", encoding="utf-8") as fh:
                r = subprocess.run([sys.executable, str(Path(__file__)), "chunk", str(c)], stdout=fh, stderr=subprocess.STDOUT, env=env)
            shutil.rmtree(KERJA / f"data_{c:02d}", ignore_errors=True)
            say("chunk", c, "exit", r.returncode, (log.read_text("utf-8").strip().splitlines() or [""])[-1][:240])
            # the native access violation (0xC0000005) sometimes hits at process exit, after the chunk was saved
            if keluar.exists() and f"chunk {c} saved" in log.read_text("utf-8"):
                break
        else:
            say("stopped: chunk", c, "failed 3 times"); sys.exit(1)
    stream()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["chunk", "jalankan", "stream"])
    ap.add_argument("c", nargs="?", type=int, default=0)
    a = ap.parse_args()
    if a.perintah == "chunk":
        KERJA.mkdir(parents=True, exist_ok=True)
        chunk(a.c, KERJA / f"fitur_{a.c:02d}.npz")
        os._exit(0)
    elif a.perintah == "stream":
        stream()
    else:
        jalankan()
