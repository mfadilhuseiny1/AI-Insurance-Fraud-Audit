"""Uji 100.000 klaim di luar data latih (the user, 2026-11-12: "coba ke 100 rb data diluar training data, hasilnya bagus ga,
laporin di ML studio di bagian bawah").

The test claims come from the synthetic FKRTL claims of 1 September – 15 November 2024 (the models were trained on the
replay window 18–31 December 2024 only), of members with no claim in that window, moved into the window by at least 45
days (member, hospital, codes, procedures and bills unchanged), so the engine judges them as new arrivals. About 2.6 %
become fraud, built as the simulator plants 12 schemes (the single-claim schemes on the claim's own member, the others
as the simulator does: an exact copy of a stream claim, a borrowed card at another province, one claim cloned onto four
members, upcoding and lengthened stays across one hospital, five members circulating among three hospitals).

20 chunks of 5.000 claims, each on a fresh copy of the /testing data (the hospitals' volumes stay realistic and nothing
is written to the bench's own data): the realtime engine judges each chunk, then the current model, the old model (trained
on the simulator alone) and the engine's own decision are scored. Aggregates go to
data/aip/ml/sistem_terbaru/uji_100k.json (laporan_ml.py adds them to ML Studio). Synthetic data only.

Usage: .venv/Scripts/python.exe testing/uji100k.py jalankan     (all chunks, resumable; then gabung)
       .venv/Scripts/python.exe testing/uji100k.py chunk 0 [--normal 1000]
       .venv/Scripts/python.exe testing/uji100k.py gabung"""
from __future__ import annotations

import argparse
import json
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
# UJI100K_SET=B: a second, fresh test (2026-11-12, for architecture v3): other claims of Sep–Nov (another hash), members
# outside test A and outside every training set, other seeds, and two ring shapes no training data has
# UJI100K_SET=C (2026-11-12, after generator 2): the clean test for the v3 retrain (testing/bersih.py): members of the fixed role
# "uji_c" only (none of the stream, tests A/B, generator 2's first run, or either training draw), claims of Jan–15 Nov, and every
# source claim taken out of the chunk's in-memory history before ingest, so first visits occur as in the stream (no echo)
SET = os.environ.get("UJI100K_SET", "A")
# UJI100K_SET=C2 (final test of v4, 2026-11-12): role uji_c members again, one OTHER claim per member (none used by test C, A or B),
# new seeds, echo removed, and the v4 features X4 (testing/fitur_v4.py) saved too
KERJA = ROOT / ".tmp" / {"A": "uji100k", "B": "uji100k_b", "C": "uji100k_c", "C2": "uji100k_c2"}[SET]
# UJI100K_OUT: another folder for the results (a re-run); UJI100K_FITUR=1 also saves the feature rows (scoring new models offline)
HASIL = Path(os.environ.get("UJI100K_OUT") or KERJA)
SRC_DATA = ROOT / ".tmp" / "testing-data"
SILVER = ROOT / "data" / "drive" / "217f2b804b0c4525"
REPLAY = ROOT / "data" / "aip" / "realtime" / "replay_fkrtl_2024-12-18_2024-12-31.parquet"
N_CHUNK, NORMAL = (10 if SET in ("C", "C2") else 20), 4870
W0, W1 = date(2024, 12, 18), date(2024, 12, 31)
ASAL = (date(2024, 9, 1), date(2024, 11, 15)) if SET not in ("C", "C2") else (date(2024, 1, 1), date(2024, 11, 15))
SINGLE = {"kelas_naik": 13, "dx_sekunder": 13, "topup_fiktif": 13, "topup_inflasi": 13, "prosedur_fiktif": 13, "kode_tidak_sesuai": 12}
if SET != "A":  # test B has fewer fresh members (about 2.400 claims per chunk): half the single-claim plants
    SINGLE = {k: (v + 1) // 2 for k, v in SINGLE.items()}
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
SEV3 = "Berat (rawat inap keparahan 3)"
T0 = time.time()


def say(*a):
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


# ---------------------------------------------------------------------------------------------------------- data copy
def salin(dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    src_rt, dst_rt = SRC_DATA / "aip" / "realtime", dst / "aip" / "realtime"
    for item in (SRC_DATA / "aip").iterdir():
        if item.name != "realtime":
            (shutil.copytree if item.is_dir() else shutil.copy2)(item, dst / "aip" / item.name)
    dst_rt.mkdir(parents=True, exist_ok=True)
    for item in src_rt.iterdir():
        if item.name.startswith("realtime.sqlite") or item.name == "duckdb":
            continue
        (shutil.copytree if item.is_dir() else shutil.copy2)(item, dst_rt / item.name)
    src = sqlite3.connect(f"file:{src_rt / 'realtime.sqlite'}?mode=ro", uri=True)
    out = sqlite3.connect(dst_rt / "realtime.sqlite")
    src.backup(out)
    out.close(); src.close()


# ---------------------------------------------------------------------------------------------------------- one chunk
def chunk(c: int, n_normal: int, keluar: Path) -> None:
    import pandas as pd

    data_root = KERJA / f"data_{c:02d}"
    salin(data_root)
    say("data copied", data_root)
    os.environ["BLUESANDAI_AUTH"] = "off"
    sys.path.insert(0, str(ROOT / "api")); sys.path.insert(0, str(HERE))
    from mailer import env
    from aip import vertex

    vertex.configure(data_root, env)
    import platform_lokal

    platform_lokal.pasang()
    import joblib
    import duckdb
    from aip import layanan as L
    from aip.realtime import mesin as E
    import fitur as FT

    E.ENGINE.start(None)
    while not E.ENGINE.ready():
        time.sleep(1)
    eng = E.ENGINE
    say("engine ready")
    m = joblib.load(HERE / "model" / "model.joblib")
    mo = joblib.load(HERE / "model_tanpa_aug" / "model.joblib")
    ssl = FT.load_ssl(data_root / "aip" / "realtime" / "al")
    con = sqlite3.connect(f"file:{data_root / 'aip' / 'realtime' / 'realtime.sqlite'}?mode=ro", uri=True)
    recs = [json.loads(r) for r, in con.execute("""SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                 WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'uji:%' OR p.sumber LIKE 'aug:%') ORDER BY p.seq""")]
    con.close()
    st = FT.Stream(FT.sys_features(recs, ssl), [FT.claim_fields(e) for e in recs], m["mu"], m["sd"])
    same_std = np.allclose(m["mu"], mo["mu"]) and np.allclose(m["sd"], mo["sd"])
    st_old = st if same_std else FT.Stream(FT.sys_features(recs, ssl), [FT.claim_fields(e) for e in recs], mo["mu"], mo["sd"])
    say("stream", len(st), "claims; same standardisation for both models:", same_std)

    # ---- the claims of this chunk
    rng = random.Random({"A": 1000, "B": 9000, "C": 13000, "C2": 17000}[SET] + c)
    rp = pd.read_parquet(REPLAY)
    # members with any claim in the stream (the replay window, the bench's tests and the training plants) are left out
    stream_members = set(int(x) for x in rp.peserta_id.unique()) | {int(fd["peserta"]) for fd in st.f if str(fd["peserta"]).isdigit()}
    have = {r[0] for r in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{SILVER.as_posix()}')").fetchall()}
    cols = [f for f in L.KlaimIn.model_fields if f in have]
    if SET in ("C", "C2"):
        import bersih as BS

        peran = BS.tabel_peran(SILVER)
        duckdb.register("anggota_chunk", peran[(peran.peran == "uji_c") & (peran.ember10 == c)][["peserta_id"]])
        pool = duckdb.sql(f"""SELECT {', '.join(cols)} FROM read_parquet('{SILVER.as_posix()}')
                              WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{ASAL[0]}' AND DATE '{ASAL[1]}'
                              AND peserta_id IN (SELECT peserta_id FROM anggota_chunk)""").df()
        # left out: the stream's members and the old training data's (below); tests A/B's SOURCE CLAIMS (not their members: test-only,
        # never trained on). Generator 2's first run is not left out either (generated claims). Test C v2 (2026-11-12): the first build
        # moved every Jan–Nov claim of a member into the same two weeks (84 % of normals from members with >= 2 such claims, flagged up to
        # 31 %), a construction bug; now one claim per member, as in the training data. That build is kept in .tmp/uji100k_c_ongeldig.
        dp = BS.dipakai()
        stream_members |= dp["aliran"]
        asal_ab = {str(x) for d_ in ("uji100k", "uji100k_b", *(("uji100k_c",) if SET == "C2" else ())) for f in sorted((ROOT / ".tmp" / d_).glob("hasil_[0-9][0-9].npz"))
                   for x in np.load(f)["asal"]}
        pool = pool[~pool.kunjungan_fkrtl_id.astype(str).isin(asal_ab)]
    else:
        pool = duckdb.sql(f"""SELECT {', '.join(cols)} FROM read_parquet('{SILVER.as_posix()}')
                              WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{ASAL[0]}' AND DATE '{ASAL[1]}'
                              AND abs(hash({'kunjungan_fkrtl_id' if SET == 'A' else "kunjungan_fkrtl_id::VARCHAR || 'B'"})) % {N_CHUNK} = {c}""").df()
    if SET != "A":  # test B: no member of test A and none of the v2/v3 training data (test C: the training data only)
        for f in [*(sorted((ROOT / ".tmp" / "uji100k").glob("hasil_[0-9][0-9].npz")) if SET == "B" else []), *sorted((ROOT / ".tmp" / "data_v2").glob("fitur_[0-9][0-9].npz")),
                  *(sorted((ROOT / ".tmp" / "data_v4").glob("fitur_[0-9][0-9].npz")) if SET == "C2" else [])]:
            stream_members.update(int(x) for x in np.load(f)["peserta"] if str(x).isdigit())
    pool = pool[~pool.peserta_id.isin(stream_members)].sample(frac=1, random_state=c + {"A": 0, "B": 500, "C": 900, "C2": 1300}[SET]).reset_index(drop=True)
    if SET in ("C", "C2"):  # one claim per member (a random one of the member's Jan–15 Nov claims)
        pool = pool.drop_duplicates("peserta_id").reset_index(drop=True)
    pool["prof"] = pool.kabkota_fkrtl_kode.astype(str) + "|" + pool.kepemilikan_fkrtl.astype(str) + "|" + pool.jenis_fkrtl.astype(str) + "|" + pool.tipe_fkrtl.astype(str)
    say("template pool", len(pool))
    used: set[int] = set()

    def ambil(mask) -> dict:
        idx = [i for i in pool.index[mask] if i not in used]
        if not idx:
            raise LookupError
        i = rng.choice(idx[:400])
        used.add(i)
        return {k: (None if (isinstance(v, float) and v != v) else v) for k, v in pool.loc[i].to_dict().items()}

    def pindah(r: dict, target: date | None = None) -> dict:
        d0 = pd.Timestamp(r["tgl_datang"]).date()
        lo = max(W0, d0 + timedelta(days=45))
        t = target or (lo + timedelta(days=rng.randint(0, max(0, (W1 - lo).days))))
        delta = t - d0
        r["tgl_datang"] = t
        if r.get("tgl_pulang") is not None:
            r["tgl_pulang"] = pd.Timestamp(r["tgl_pulang"]).date() + delta
        return r

    ritl = pool.tingkat_pelayanan == "RITL"
    out: list[tuple[dict, str]] = []
    nomor = [0]

    def tambah(r: dict, sk: str) -> None:
        nomor[0] += 1
        r.setdefault("_asal", str(r.get("kunjungan_fkrtl_id")))  # the source claim (Sept–Nov), for the overlap check
        r["kunjungan_fkrtl_id"] = f"U100K{c:02d}{nomor[0]:06d}"
        r["edisi"] = "reguler"
        out.append((r, sk))

    ref = eng.ref
    # single-claim schemes on the claim's own member
    reg = eng.con.cursor()
    reg.register("ids", pd.DataFrame({"peserta_id": pool.peserta_id.astype("int64").unique()}))
    pbi3 = set(int(x) for x in reg.execute("""SELECT peserta_id FROM anggota WHERE edisi = 'reguler' AND segmen LIKE 'PBI%' AND hak = 3
                                              AND peserta_id IN (SELECT peserta_id FROM ids)""").df().peserta_id)
    reg.close()
    for _ in range(SINGLE["kelas_naik"]):
        r = pindah(ambil(ritl & pool.peserta_id.isin(pbi3))); r["kelas_rawat"] = "Kelas 1"; tambah(r, "kelas_naik")
    n200 = pool.inacbg_kode.map(lambda k: (ref.kode.get(k) or {}).get("n", 0) >= 200)
    for _ in range(SINGLE["dx_sekunder"]):
        r = pindah(ambil(ritl & n200)); r["jumlah_dx_sekunder"] = int(ref.kode[r["inacbg_kode"]]["dx_sek_p99"]) + 8; tambah(r, "dx_sekunder")
    sd_jarang = pool.inacbg_kode.map(lambda k: (ref.topup.get((k, "sd_tarif_rp")) or {}).get("n", 0) <= 2)
    for _ in range(SINGLE["topup_fiktif"]):
        r = pindah(ambil(ritl & n200 & sd_jarang)); r["sd_tarif_rp"] = 4_500_000; r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + 4_500_000; tambah(r, "topup_fiktif")
    ada_topup = pool.inacbg_kode.map(lambda k: any((ref.topup.get((k, s)) or {}).get("n", 0) >= 20 for s in SPECIALS))
    for _ in range(SINGLE["topup_inflasi"]):
        r = pindah(ambil(ada_topup))
        col = next(s for s in SPECIALS if (ref.topup.get((r["inacbg_kode"], s)) or {}).get("n", 0) >= 20)
        amt = int(ref.topup[(r["inacbg_kode"], col)]["p95"] * 3)
        r[col] = amt; r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + amt; tambah(r, "topup_inflasi")
    prosedur = pool.inacbg_kode.astype(str).str[2].isin(["1", "3"]) & pool.prosedur.notna()
    for _ in range(SINGLE["prosedur_fiktif"]):
        r = pindah(ambil(prosedur)); r["prosedur"] = None; tambah(r, "prosedur_fiktif")
    n_kts = 0
    for _ in range(4000):
        if n_kts >= SINGLE["kode_tidak_sesuai"]:
            break
        i, j = rng.choice(list(pool.index[ritl][:3000])), rng.choice(list(pool.index[ritl][:3000]))
        if i in used or j in used or i == j:
            continue
        t, o = pool.loc[i], pool.loc[j]
        code = o.inacbg_kode
        if code and ref.rare_pair(t.dx_primer_icd3, code) and str(code)[:1] != str(t.inacbg_kode)[:1]:
            used.update({i, j})
            r = {k: (None if (isinstance(v, float) and v != v) else v) for k, v in o.to_dict().items()}
            tt = pindah({**{k: (None if (isinstance(v, float) and v != v) else v) for k, v in t.to_dict().items()}})
            r.update(peserta_id=int(t.peserta_id), dx_primer_icd3=t.dx_primer_icd3, dx_primer_kode=t.dx_primer_kode, dx_primer_nama=t.dx_primer_nama,
                     tgl_datang=tt["tgl_datang"], tgl_pulang=tt["tgl_datang"] + timedelta(days=int(o.los_hari or 2)))
            tambah(r, "kode_tidak_sesuai"); n_kts += 1
    # across one hospital: upcoding (10) and lengthened stays (12)
    for sk, n in (("upcoding", 10), ("los_bergeser", 12)):
        best: list = []
        for prof in pool[ritl].prof.value_counts().index[:60]:  # the hospital with the most usable inpatient claims
            cand = [i for i in pool.index[ritl & (pool.prof == prof)] if i not in used]
            if sk == "upcoding":
                cand = [i for i in cand if str(pool.loc[i].inacbg_kode).rsplit("-", 1)[0] + "-III" in eng.known_codes and not str(pool.loc[i].inacbg_kode).endswith("-III")]
            if len(cand) > len(best):
                best = cand
            if len(best) >= n:
                break
        for i in best[:n]:
            used.add(i)
            r = pindah({k: (None if (isinstance(v, float) and v != v) else v) for k, v in pool.loc[i].to_dict().items()})
            if sk == "upcoding":
                up = str(r["inacbg_kode"]).rsplit("-", 1)[0] + "-III"
                tarif = int((r.get("tarif_inacbg_rp") or r["biaya_tagih_rp"]) * 1.8)
                r.update(inacbg_kode=up, inacbg_keparahan=SEV3, inacbg_deskripsi=(eng.code_ref.get(up) or {}).get("inacbg_deskripsi") or r.get("inacbg_deskripsi"),
                         biaya_tagih_rp=tarif + int((r["biaya_tagih_rp"] or 0) - (r.get("tarif_inacbg_rp") or 0)), tarif_inacbg_rp=tarif)
            else:
                los = max(4, int(r.get("los_hari") or 2) * 3)
                r.update(los_hari=los, tgl_pulang=r["tgl_datang"] + timedelta(days=los))
            tambah(r, sk)
    # cloning: one claim on four other members
    for _ in range(2):
        t = pindah(ambil(ritl & (pool.los_hari.fillna(0) >= 3)))
        bill = int(t.get("tarif_inacbg_rp") or 0) + sum(int(t.get(s) or 0) for s in SPECIALS) + 750_000
        for _k in range(4):
            mbr = ambil(pool.index >= 0)
            tambah({**t, "peserta_id": int(mbr["peserta_id"]), "biaya_tagih_rp": bill}, "kloning")
    # a ring: five members circulating among three hospitals of one province within six days
    besar = pool.prof.value_counts()
    besar = set(besar[besar >= 6].index)  # hospitals with enough claims for five members
    prov = pool[pool.prof.isin(besar)].groupby(pool.kabkota_fkrtl_kode // 100).prof.nunique()
    pv = rng.choice([p for p, n in prov.items() if n >= 3])
    profs = rng.sample(sorted(p for p in pool[(pool.kabkota_fkrtl_kode // 100) == pv].prof.unique() if p in besar), 3)
    members = [int(ambil(pool.index >= 0)["peserta_id"]) for _ in range(5)]
    d0 = W0 + timedelta(days=rng.randint(0, (W1 - W0).days - 6))
    for j, mbr in enumerate(members):
        for k, prof in enumerate(profs):
            pm = pool.prof == prof
            try:
                r = ambil(pm & (pool.tingkat_pelayanan == "RJTL"))
            except LookupError:
                r = ambil(pm)
            d = d0 + timedelta(days=k * 2 + j % 2)
            los = 2 if r.get("tingkat_pelayanan") == "RITL" else 0
            r.update(peserta_id=mbr, tgl_datang=d, tgl_pulang=d + timedelta(days=los))
            tambah(r, "cincin_kolusi")
    if SET != "A":  # ring shapes no training data has: a slow ring (9 members, 2 hospitals, 5–9 days apart) and a chain (3 members, 4 hospitals, every 4 days)
        for nm, nh, gap in ((9, 2, None), (3, 4, 4)):
            pvs = [p for p, n in prov.items() if n >= nh]
            pv = rng.choice(pvs)
            hs = rng.sample(sorted(p for p in pool[(pool.kabkota_fkrtl_kode // 100) == pv].prof.unique() if p in besar), nh)
            mem = [int(ambil(pool.index >= 0)["peserta_id"]) for _ in range(nm)]
            d0 = W0 + timedelta(days=rng.randint(0, 1))
            for j, mbr in enumerate(mem):
                hari = [d0 + timedelta(days=j % 4)]
                for _k in range(1, nh):
                    hari.append(hari[-1] + timedelta(days=gap or rng.randint(5, 9)))
                for prof, d in zip(hs, hari):
                    if d > W1:
                        continue
                    pm = pool.prof == prof
                    try:
                        r = ambil(pm & (pool.tingkat_pelayanan == "RJTL"))
                    except LookupError:
                        try:
                            r = ambil(pm)
                        except LookupError:
                            continue
                    los = 2 if r.get("tingkat_pelayanan") == "RITL" else 0
                    r.update(peserta_id=mbr, tgl_datang=d, tgl_pulang=d + timedelta(days=los))
                    tambah(r, "cincin_bentuk_baru")
    for _ in range(n_normal if SET == "A" else min(n_normal, len(pool) - len(used) - 60)):
        tambah(pindah(ambil(pool.index >= 0)), "normal")
    # the fraud spread among the normal claims (the order the engine sees them)
    rng.shuffle(out)
    # two schemes need a claim to copy or to overlap: they use a test claim of this chunk (never a training claim) and
    # arrive after it: an exact copy under another id, and the member's card used again in another province next day
    normals = [b for b, sk in out if sk == "normal"]
    for b in rng.sample(normals, 5):
        tambah(dict(b), "klaim_ganda")
    inap = [b for b in normals if b.get("tingkat_pelayanan") == "RITL" and int(b.get("los_hari") or 0) >= 4]
    for t0 in rng.sample(inap, min(3, len(inap))):
        o = ambil(ritl & ((pool.kabkota_fkrtl_kode // 100) != int(t0["kabkota_fkrtl_kode"]) // 100))
        d = t0["tgl_datang"] + timedelta(days=1)
        o.update(peserta_id=int(t0["peserta_id"]), tgl_datang=d, tgl_pulang=d + timedelta(days=3), los_hari=3)
        tambah(o, "kartu_dipinjam")
    n_fraud = sum(1 for _, sk in out if sk != "normal")
    say("claims", len(out), "fraud", n_fraud)

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

    objs, labels, asal, bs = [], [], [], []
    for b, sk in out:
        try:
            objs.append(ke_klaim(b)); labels.append(sk); asal.append(b.get("_asal") or ""); bs.append(b)
        except Exception as e:  # noqa: BLE001
            say("skipped a claim:", sk, str(e)[:120])
    gema = None
    if SET in ("C", "C2"):  # no echo: every source claim this chunk used leaves the member history before anything is ingested
        sumber = [{k: (None if (isinstance(v, float) and v != v) else v) for k, v in pool.loc[i].to_dict().items()} for i in sorted(used)]
        gema = BS.hapus_gema(eng.con, sumber)
        gema["sisa"] = BS.sisa_gema(eng.con, sumber)
        say("echo removed", gema)
    t1 = time.time()
    ids = []
    for a in range(0, len(objs), 2000):
        ids += eng.ingest(objs[a:a + 2000], f"uji100k:{c}", None)
        while len(eng.q) > 3000:
            time.sleep(0.5)
    briefs = eng.wait(ids, 3600)
    ok = [i for i, b in zip(ids, briefs) if b and b.get("keputusan") not in ("GAGAL", "DIGANTIKAN")]
    say(f"engine judged {len(ok)}/{len(ids)} in {time.time() - t1:.0f} s")
    keep = [k for k, b in enumerate(briefs) if b and b.get("keputusan") not in ("GAGAL", "DIGANTIKAN")]
    recs_new = [eng.store.event(ids[k]) for k in keep]
    labels = [labels[k] for k in keep]
    asal = [asal[k] for k in keep]
    bs = [bs[k] for k in keep]
    S_new = FT.sys_features(recs_new, ssl)
    rows1, rows2, rowsr, rows1o, rows2o, rowsro = [], [], [], [], [], []
    for x, e in zip(S_new, recs_new):
        fd = FT.claim_fields(e)
        i = st.append(x, fd)
        rows1.append(st.agg_row(i)); rows2.append(st.s2_row(i)); rowsr.append(st.r2_row(i))
        if st_old is not st:
            io = st_old.append(x, fd)
            rows1o.append(st_old.agg_row(io)); rows2o.append(st_old.s2_row(io)); rowsro.append(st_old.r2_row(io))
    X1, X2, XR = np.vstack(rows1), np.vstack(rows2), np.vstack(rowsr)
    X4 = None
    if SET == "C2":  # the v4 features, the stream first then the new claims, one at a time (testing/fitur_v4.py)
        import fitur_v4 as F4

        f4 = F4.Fitur4(F4.referensi(), F4.domisili([e.get("peserta") for e in recs] + [e.get("peserta") for e in recs_new]))
        for e in recs:
            f4.tambah(e)
        X4 = np.vstack([f4.tambah(e) for e in recs_new]).astype(np.float32)
    X1o, X2o, XRo = (np.vstack(rows1o), np.vstack(rows2o), np.vstack(rowsro)) if rows1o else (X1, X2, XR)

    def skor(mm, a1, a2, ar):
        lg = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))  # noqa: E731
        p1, p2 = mm["m1"].predict_proba(a1)[:, 1], mm["m2"].predict_proba(a2)[:, 1]
        ps = mm["stacker"].predict_proba(np.column_stack([lg(p1), lg(p2)]))[:, 1]
        cal = mm["iso"].predict(ps)
        pm = mm["mono"].predict_proba(ar)[:, 1]
        flag = (cal >= mm["kartu"]["ambang_peluang"]) | (pm > mm["kartu"]["ambang_alert_ring"])
        return p1, p2, ps, cal, pm, flag

    p1, p2, ps, cal, pm, flag = skor(m, X1, X2, XR)
    p1o, p2o, pso, calo, pmo, flago = skor(mo, X1o, X2o, XRo)
    lab = np.array(labels)
    if os.environ.get("UJI100K_REKAM"):  # the claim records for the Blu 3.0 data package (testing/blu3_data.py); the label apart
        masuk = ("kunjungan_fkrtl_id", "peserta_id", "tgl_datang", "tgl_pulang", "kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl",
                 "tingkat_pelayanan", "kelas_rawat", "inacbg_kode", "inacbg_deskripsi", "inacbg_keparahan", "dx_primer_icd3", "dx_primer_kode",
                 "dx_primer_nama", "jumlah_dx_sekunder", "prosedur", "los_hari", "tarif_inacbg_rp", *SPECIALS, "biaya_tagih_rp")
        with (keluar.parent / f"rekam_{c:02d}.jsonl").open("w", encoding="utf-8") as fh:
            for b, e in zip(bs, recs_new):
                an = e.get("anggota") or {}
                fh.write(json.dumps({**{k: b.get(k) for k in masuk}, "id": e.get("id"), "faskes": e.get("faskes"), "faskes_label": e.get("faskes_label"),
                                     "kab": e.get("kab"), "provinsi": e.get("provinsi"), "keputusan": e.get("keputusan"), "skor_rule": e.get("skor"),
                                     "sinyal": [{k: x.get(k) for k in ("kode", "label", "tag", "s", "w")} for x in (e.get("sinyal") or [])],
                                     "modus": e.get("modus") or [], "segmen": an.get("segmen"), "hak_kelas": an.get("hak_kelas"),
                                     "jk": an.get("jk"), "tahun_lahir": an.get("tahun_lahir")}, ensure_ascii=False, default=str) + "\n")
        (keluar.parent / f"kebenaran_{c:02d}.json").write_text(json.dumps(dict(zip([e.get("id") for e in recs_new], labels))), "utf-8")
    np.savez_compressed(keluar, sk=lab, y=(lab != "normal").astype(int), p1=p1, p2=p2, ps=ps, cal=cal, pm=pm, flag=flag,
                        p1o=p1o, ps_old=pso, cal_old=calo, flag_old=flago,
                        **({"X1": X1.astype(np.float32), "X2": X2.astype(np.float32), "XR": XR.astype(np.float32)} if os.environ.get("UJI100K_FITUR") else {}),
                        tahan=np.array([e.get("keputusan") == "TAHAN" for e in recs_new]), periksa=np.array([e.get("keputusan") == "PERIKSA" for e in recs_new]),
                        # for the overlap check with the training data only (local file, not in the report)
                        peserta=np.array([str(e.get("peserta")) for e in recs_new]), faskes=np.array([str(e.get("faskes")) for e in recs_new]),
                        tgl=np.array([str(e.get("tgl_datang"))[:10] for e in recs_new]), kode=np.array([str(e.get("kode")) for e in recs_new]), asal=np.array(asal),
                        **({"gema": np.array([json.dumps(gema)])} if gema else {}), **({"X4": X4} if X4 is not None else {}))
    y = (lab != "normal")
    say(f"chunk {c}: fraud {int(y.sum())} · caught {int((flag & y).sum())} · normal flagged {int((flag & ~y).sum())} of {int((~y).sum())}"
        f" · old caught {int((flago & y).sum())}, old normal flagged {int((flago & ~y).sum())}")
    eng.stop() if hasattr(eng, "stop") else None


# ---------------------------------------------------------------------------------------------------------- all chunks
def jalankan() -> None:
    KERJA.mkdir(parents=True, exist_ok=True); HASIL.mkdir(parents=True, exist_ok=True)
    for c in range(N_CHUNK):
        keluar = HASIL / f"hasil_{c:02d}.npz"
        if keluar.exists():
            say("chunk", c, "done earlier")
            continue
        log = HASIL / f"log_{c:02d}.txt"
        for coba in range(3):  # the native access violation (0xC0000005) also hits chunks, sometimes only at exit after saving
            say("chunk", c, "running" + (f" (retry {coba})" if coba else ""))
            with log.open("w", encoding="utf-8") as fh:
                r = subprocess.run([sys.executable, str(Path(__file__)), "chunk", str(c), "--keluar", str(keluar)], stdout=fh, stderr=subprocess.STDOUT, env={**os.environ, "PYTHONUTF8": "1"})
            say("chunk", c, "exit", r.returncode, (log.read_text("utf-8").strip().splitlines() or [""])[-1][:200])
            shutil.rmtree(KERJA / f"data_{c:02d}", ignore_errors=True)
            if keluar.exists() and f"chunk {c}: fraud" in log.read_text("utf-8"):
                break
        else:
            say("stopped: chunk", c, "failed 3 times (see", log, ")")
            return
    if HASIL == KERJA and SET == "A":  # a re-run elsewhere, or test B, does not overwrite the published report
        gabung()


def gabung() -> None:
    from sklearn.metrics import average_precision_score, roc_auc_score

    sys.path.insert(0, str(ROOT / "api")); sys.path.insert(0, str(HERE))
    os.environ.setdefault("BLUESANDAI_AUTH", "off")
    files = sorted(KERJA.glob("hasil_[0-9][0-9].npz"))
    ds = [np.load(f, allow_pickle=False) for f in files]
    cat = {k: np.concatenate([d[k] for d in ds]) for k in ds[0].files}
    y, sk = cat["y"].astype(int), cat["sk"]
    flag, flago, tahan = cat["flag"].astype(bool), cat["flag_old"].astype(bool), cat["tahan"].astype(bool)

    def ringkas(f: np.ndarray, s: np.ndarray | None) -> dict:
        tp, fp = int((f & (y == 1)).sum()), int((f & (y == 0)).sum())
        fn, tn = int((~f & (y == 1)).sum()), int((~f & (y == 0)).sum())
        out = {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(tp / max(1, tp + fp), 4), "recall": round(tp / max(1, tp + fn), 4),
               "fpr": round(fp / max(1, fp + tn), 5)}
        if s is not None:
            out["auprc"] = round(float(average_precision_score(y, s)), 4); out["auroc"] = round(float(roc_auc_score(y, s)), 4)
        return out

    def pk(s: np.ndarray, ks: list[int]) -> dict:
        o = np.argsort(-s, kind="stable"); tp = np.cumsum(y[o])
        ks = [k for k in ks if k <= len(o)]
        return {"k": ks, "precision": [round(float(tp[k - 1] / k), 4) for k in ks], "recall": [round(float(tp[k - 1] / max(1, y.sum())), 4) for k in ks]}

    import penjelas as PJ
    from aip.realtime import simulator as SIM

    daftar = PJ.modus_daftar()
    skema = []
    for s in sorted(set(sk.tolist()) - {"normal"}):
        mk = sk == s
        ms = (SIM.SCENARIOS.get(s) or ("", [], set()))[1]
        skema.append({"skema": s, "label": (SIM.SCENARIOS.get(s) or (s,))[0], "modus": [{"kode": ("M07" if x == "M19" else x), "nama": daftar.get("M07" if x == "M19" else x, x)} for x in ms],
                      "n": int(mk.sum()), "recall": round(float(flag[mk].mean()), 4), "recall_lama": round(float(flago[mk].mean()), 4), "recall_rule": round(float(tahan[mk].mean()), 4)})
    p0 = float(y.mean())
    tingkat = sorted({0.001, 0.002, 0.005, 0.01, 0.02, round(p0, 4), 0.05, 0.1, 0.2})

    def prev(f: np.ndarray) -> list[float]:
        tpr = (f & (y == 1)).sum() / max(1, y.sum()); fpr = (f & (y == 0)).sum() / max(1, (y == 0).sum())
        return [round(float(tpr * p / max(1e-12, tpr * p + fpr * (1 - p))), 4) for p in tingkat]

    k2 = int(round(0.02 * len(y)))

    def top(s: np.ndarray, k: int) -> np.ndarray:
        f = np.zeros(len(s), bool); f[np.argsort(-s, kind="stable")[:k]] = True
        return f

    hasil = {
        "dibuat": time.strftime("%Y-%m-%d %H:%M"), "chunk": len(files), "klaim": int(len(y)), "fraud": int(y.sum()), "normal": int((y == 0).sum()),
        "sumber": f"klaim sintetis FKRTL {ASAL[0]}–{ASAL[1]} (di luar jendela latih {W0}–{W1}), dipindah ≥ 45 hari ke jendela; peserta tanpa klaim di jendela latih",
        "sekarang": ringkas(flag, cat["ps"]), "lama": ringkas(flago, cat["ps_old"]), "rule": ringkas(tahan, None),
        "presisi_k": {"sekarang": pk(cat["ps"], [50, 100, 250, 500, 1000, 1500, 2000, 2500, 3000, 5000]), "lama": pk(cat["ps_old"], [50, 100, 250, 500, 1000, 1500, 2000, 2500, 3000, 5000])},
        "prevalensi": {"tingkat": tingkat, "aliran": round(p0, 4), "anggaran_k": k2,
                       "keputusan": {"sekarang": prev(flag), "lama": prev(flago), "rule": prev(tahan)},
                       "anggaran": {"sekarang": prev(top(cat["ps"], k2)), "lama": prev(top(cat["ps_old"], k2)), "rule": prev(tahan)}},
        "distribusi": {"batas": [round(x, 2) for x in np.linspace(0, 1, 21)], "normal": np.histogram(cat["cal"][y == 0], np.linspace(0, 1, 21))[0].tolist(),
                       "fraud": np.histogram(cat["cal"][y == 1], np.linspace(0, 1, 21))[0].tolist()},
        "skema": skema,
    }
    # what the numbers say, in short lines for the page (computed, not written by hand)
    kartu = json.loads((HERE / "model" / "kartu.json").read_text("utf-8"))
    oof_recall = float(kartu.get("oof_ditandai_recall") or 0)
    s_ = hasil["sekarang"]
    periksa = cat["periksa"].astype(bool)
    lolos = (y == 1) & ~flag
    rule_lihat = float(((periksa | tahan) & lolos).sum() / max(1, lolos.sum()))
    kuat = [x["label"] for x in sorted(skema, key=lambda x: -x["recall"]) if x["recall"] >= 0.8]
    lemah = [x["label"] for x in sorted(skema, key=lambda x: x["recall"]) if x["recall"] < 0.3]
    temuan = [{"ikon": "alert" if s_["recall"] < oof_recall - 0.1 else "check", "nada": "buruk" if s_["recall"] < oof_recall - 0.1 else "baik",
               "judul": f"Recall {s_['recall'] * 100:.0f}% (evaluasi biasa {oof_recall * 100:.0f}%)",
               "isi": f"{s_['tp']:,} dari {int(y.sum()):,} fraud tertangkap pada klaim yang tidak pernah dilihat model.".replace(",", ".")},
              {"ikon": "check" if s_["fpr"] <= 0.005 else "alert", "nada": "baik" if s_["fpr"] <= 0.005 else "buruk",
               "judul": f"Klaim normal ditandai {s_['fpr'] * 100:.2f}%".replace(".", ","),
               "isi": f"{s_['fp']:,} dari {int((y == 0).sum()):,} klaim normal; precision {s_['precision'] * 100:.0f}%.".replace(",", ".")}]
    if kuat:
        temuan.append({"ikon": "star", "nada": "baik", "judul": f"Tetap tertangkap: {len(kuat)} skema", "isi": ", ".join(kuat[:5]) + ("…" if len(kuat) > 5 else "")})
    if lemah:
        temuan.append({"ikon": "eye", "nada": "buruk", "judul": f"Sering lolos: {len(lemah)} skema", "isi": ", ".join(lemah[:5]) + ("…" if len(lemah) > 5 else "")})
    temuan.append({"ikon": "search", "nada": "netral", "judul": f"Rule melihat {rule_lihat * 100:.0f}% fraud yang lolos",
                   "isi": "Pemeriksaan otomatis memberi 'perlu diperiksa' atau 'ditahan', tetapi model tidak menaikkan skornya."})
    # the ranking still carries signal below the threshold, and what model + rule would give (analysis, not the system)
    top2 = top(cat["ps"], k2)
    r_top = float((top2 & (y == 1)).sum() / max(1, y.sum())); p_top = float((top2 & (y == 1)).sum() / max(1, top2.sum()))
    gab = flag | tahan | periksa
    r_gab = float((gab & (y == 1)).sum() / max(1, y.sum())); p_gab = float((gab & (y == 1)).sum() / max(1, gab.sum()))
    f_gab = float((gab & (y == 0)).sum() / max(1, (y == 0).sum()))
    temuan.append({"ikon": "sliders", "nada": "netral", "judul": f"2% skor teratas: {r_top * 100:.0f}% fraud tertangkap",
                   "isi": f"Urutan skor masih berguna (precision {p_top * 100:.0f}% pada {k2:,} klaim); ambang 50% terlalu ketat untuk klaim jenis ini.".replace(",", ".")})
    temuan.append({"ikon": "layers", "nada": "netral", "judul": f"Model + rule: {r_gab * 100:.0f}% tertangkap",
                   "isi": f"Bila 'perlu diperiksa'/'ditahan' ikut ditandai: precision {p_gab * 100:.0f}%, klaim normal ditandai "
                          f"{f'{f_gab * 100:.1f}'.replace('.', ',')}% (analisis, belum dipakai sistem)."})
    hasil["temuan"] = temuan
    tujuan = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "uji_100k.json"
    tujuan.parent.mkdir(parents=True, exist_ok=True)
    tujuan.write_text(json.dumps(hasil, ensure_ascii=False, indent=1), "utf-8")
    say("written", tujuan, {k: hasil["sekarang"][k] for k in ("precision", "recall", "fpr", "auprc")}, "old", {k: hasil["lama"][k] for k in ("precision", "recall", "fpr", "auprc")})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["chunk", "jalankan", "gabung"])
    ap.add_argument("c", nargs="?", type=int, default=0)
    ap.add_argument("--normal", type=int, default=NORMAL)
    ap.add_argument("--keluar", default=None)
    a = ap.parse_args()
    if a.perintah == "chunk":
        KERJA.mkdir(parents=True, exist_ok=True)
        chunk(a.c, a.normal, Path(a.keluar) if a.keluar else KERJA / f"hasil_{a.c:02d}.npz")
        os._exit(0)  # the engine's threads end with the process
    elif a.perintah == "jalankan":
        jalankan()
    else:
        gabung()
