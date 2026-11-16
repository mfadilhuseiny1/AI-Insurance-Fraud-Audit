"""Training data v2 for the rule-aware architecture (testing/latih_v2.py).

Why: the 100.000-claim test (uji100k.py) showed the current model catches 28 % of fraud on claims it never saw. Every
fraud claim it trained on is a copy of an existing claim, on a member with no earlier claim at that hospital, so it learned
that journey ("days since the previous claim", visit counts) and gave the rule signal of each scheme almost no weight.

What this builds: real claims of January–August 2024 (synthetic FKRTL, edisi reguler), moved into the replay window the
same way as the test claims, so fraud and normal claims both sit on members with an ordinary history. Per chunk about 310
fraud claims of the 12 schemes with randomized magnitudes and placements (not the test's fixed values: other top-up
columns and amounts, other class jumps, II as well as III severity, rings of other sizes, ...) and 3.000 normal claims.

Kept apart from the test: members who are in the stream or in the 100.000-claim test are left out, the source period
(Jan–Aug) does not overlap the test's (Sep–Nov), and each member gives at most one claim. Chunks are member buckets
(hash(member) % 10), so chunks never share a member; chunks 8 and 9 are the validation set for every model choice and are
never trained on. Features are computed exactly as for the test (the realtime engine on a fresh data copy, then the stream
features) and saved to .tmp/data_v2/fitur_<c>.npz. Synthetic data only.

Usage: .venv/Scripts/python.exe testing/data_v2.py jalankan        (all chunks, resumable)
       .venv/Scripts/python.exe testing/data_v2.py chunk <c>"""
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
sys.path.insert(0, str(HERE))
import uji100k as U  # noqa: E402

# DATA_V2_BERSIH=1 (2026-11-12, after generator 2): the clean draw for the v3 retrain (testing/bersih.py): members by fixed role
# (chunks 0–7 training, 8–9 validation), none of the replay stream, tests A/B or generator 2's first run, and every source claim taken
# out of the chunk's in-memory history before ingest (no echo). Written to .tmp/data_v2_bersih; the published .tmp/data_v2 stays.
BERSIH = bool(os.environ.get("DATA_V2_BERSIH"))
KERJA = ROOT / ".tmp" / ("data_v2_bersih" if BERSIH else "data_v2")
N_V2 = 10
VALIDASI = (8, 9)
ASAL = (date(2024, 1, 1), date(2024, 8, 31))
W0, W1 = U.W0, U.W1
SPECIALS, SEV3 = U.SPECIALS, U.SEV3
SEV2 = "Sedang (rawat inap keparahan 2)"
SINGLE = {"kelas_naik": 30, "dx_sekunder": 30, "topup_fiktif": 30, "topup_inflasi": 30, "prosedur_fiktif": 30, "kode_tidak_sesuai": 25}
NORMAL = 3000
T0 = time.time()


def say(*a):
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def anggota_uji() -> set[int]:
    """The members of the 100.000-claim test (left out of the training data)."""
    out: set[int] = set()
    for f in sorted(U.KERJA.glob("hasil_[0-9][0-9].npz")):
        out.update(int(p) for p in np.load(f)["peserta"] if str(p).isdigit())
    return out


def chunk(c: int, keluar: Path) -> None:
    import pandas as pd

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
    m = joblib.load(HERE / "model" / "model.joblib")  # the standardisation (mu, sd) only, the same for every model
    ssl = FT.load_ssl(data_root / "aip" / "realtime" / "al")
    con = sqlite3.connect(f"file:{data_root / 'aip' / 'realtime' / 'realtime.sqlite'}?mode=ro", uri=True)
    recs = [json.loads(r) for r, in con.execute("""SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                 WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'uji:%' OR p.sumber LIKE 'aug:%') ORDER BY p.seq""")]
    con.close()
    st = FT.Stream(FT.sys_features(recs, ssl), [FT.claim_fields(e) for e in recs], m["mu"], m["sd"])
    say("stream", len(st), "claims")

    rng = random.Random((15000 if BERSIH else 5000) + c)
    rp = pd.read_parquet(U.REPLAY)
    stream_members = set(int(x) for x in rp.peserta_id.unique()) | {int(fd["peserta"]) for fd in st.f if str(fd["peserta"]).isdigit()}
    uji = anggota_uji()
    have = {r[0] for r in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{U.SILVER.as_posix()}')").fetchall()}
    cols = [f for f in L.KlaimIn.model_fields if f in have]
    if BERSIH:
        import bersih as BS

        peran = BS.tabel_peran(U.SILVER)
        pilih = peran[(peran.peran == "latih") & (peran.ember8 == c)] if c not in VALIDASI else peran[(peran.peran == "validasi") & (peran.ember2 == c - VALIDASI[0])]
        duckdb.register("anggota_chunk", pilih[["peserta_id"]])
        pool = duckdb.sql(f"""SELECT {', '.join(cols)} FROM read_parquet('{U.SILVER.as_posix()}')
                              WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{ASAL[0]}' AND DATE '{ASAL[1]}'
                              AND peserta_id IN (SELECT peserta_id FROM anggota_chunk)
                              ORDER BY hash(kunjungan_fkrtl_id::VARCHAR || '{c}b') LIMIT 80000""").df()
        uji = uji | BS.semua_dipakai()
    else:
        pool = duckdb.sql(f"""SELECT {', '.join(cols)} FROM read_parquet('{U.SILVER.as_posix()}')
                              WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{ASAL[0]}' AND DATE '{ASAL[1]}'
                              AND abs(hash(peserta_id)) % {N_V2} = {c}
                              ORDER BY hash(kunjungan_fkrtl_id::VARCHAR || '{c}') LIMIT 80000""").df()
    n0 = len(pool)
    pool = pool[~pool.peserta_id.isin(stream_members | uji)].drop_duplicates("peserta_id").sample(frac=1, random_state=c).reset_index(drop=True)
    pool["prof"] = pool.kabkota_fkrtl_kode.astype(str) + "|" + pool.kepemilikan_fkrtl.astype(str) + "|" + pool.jenis_fkrtl.astype(str) + "|" + pool.tipe_fkrtl.astype(str)
    say(f"template pool {len(pool)} (of {n0}; test members left out: {len(uji)})")
    used: set[int] = set()

    def bersih(row) -> dict:
        return {k: (None if (isinstance(v, float) and v != v) else v) for k, v in row.to_dict().items()}

    def ambil(mask) -> dict:
        idx = [i for i in pool.index[mask] if i not in used]
        if not idx:
            raise LookupError
        i = rng.choice(idx[:400])
        used.add(i)
        return bersih(pool.loc[i])

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
        r.setdefault("_asal", str(r.get("kunjungan_fkrtl_id")))
        r["kunjungan_fkrtl_id"] = f"V2L{c:02d}{nomor[0]:06d}"
        r["edisi"] = "reguler"
        out.append((r, sk))

    def coba(n: int, buat) -> int:
        k = 0
        for _ in range(n):
            try:
                buat(); k += 1
            except LookupError:
                pass
        return k

    ref = eng.ref
    reg = eng.con.cursor()
    reg.register("ids", pd.DataFrame({"peserta_id": pool.peserta_id.astype("int64").unique()}))
    # PBI members (premium paid by the state) must stay in Kelas 3; other members may pay to move up a class (allowed)
    pbi3 = {int(p) for p, in reg.execute("""SELECT peserta_id FROM anggota WHERE edisi = 'reguler' AND segmen LIKE 'PBI%' AND hak = 3
                                                AND peserta_id IN (SELECT peserta_id FROM ids)""").fetchall()}
    reg.close()

    # class above the member's right (M13): PBI members billed Kelas 1 or Kelas 2; half also bill the room
    pbi = ritl & pool.peserta_id.isin(pbi3)

    def kelas_naik():
        r = pindah(ambil(pbi))
        r["kelas_rawat"] = rng.choice(["Kelas 1", "Kelas 2"])
        if rng.random() < 0.5:
            add = int((r.get("tarif_inacbg_rp") or 0) * rng.uniform(0.15, 0.4))
            r["tarif_inacbg_rp"] = int(r.get("tarif_inacbg_rp") or 0) + add; r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + add
        tambah(r, "kelas_naik")

    # secondary diagnoses far above the code (M04): p99 + 3..12, mostly inpatient
    n200 = pool.inacbg_kode.map(lambda k: (ref.kode.get(k) or {}).get("n", 0) >= 200)

    def dx_sekunder():
        r = pindah(ambil(n200 & (ritl if rng.random() < 0.7 else ~ritl)))
        r["jumlah_dx_sekunder"] = int(ref.kode[r["inacbg_kode"]]["dx_sek_p99"]) + rng.randint(3, 12)
        tambah(r, "dx_sekunder")

    # a top-up the code almost never has (M17): any rare special-CMG column, 1.5–9 million
    def jarang(k) -> list[str]:
        return [s for s in SPECIALS if (ref.topup.get((k, s)) or {}).get("n", 0) <= 2]

    ada_jarang = pool.inacbg_kode.map(lambda k: bool(jarang(k)))

    def topup_fiktif():
        r = pindah(ambil(n200 & ada_jarang & (ritl if rng.random() < 0.8 else ~ritl)))
        col = rng.choice(jarang(r["inacbg_kode"]))
        amt = int(round(rng.uniform(1.5e6, 9e6), -4))
        r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + amt - int(r.get(col) or 0); r[col] = amt
        tambah(r, "topup_fiktif")

    # a usual top-up inflated (M07): p95 x 1.8–4.5 on any common column
    def lazim(k) -> list[str]:
        return [s for s in SPECIALS if (ref.topup.get((k, s)) or {}).get("n", 0) >= 20]

    ada_topup = pool.inacbg_kode.map(lambda k: bool(lazim(k)))

    def topup_inflasi():
        r = pindah(ambil(ada_topup))
        col = rng.choice(lazim(r["inacbg_kode"]))
        amt = int(ref.topup[(r["inacbg_kode"], col)]["p95"] * rng.uniform(1.8, 4.5))
        r["biaya_tagih_rp"] = int(r["biaya_tagih_rp"] or 0) + amt - int(r.get(col) or 0); r[col] = amt
        tambah(r, "topup_inflasi")

    # a procedure code with no procedure recorded (M14)
    prosedur = pool.inacbg_kode.astype(str).str[2].isin(["1", "3"]) & pool.prosedur.notna()

    def prosedur_fiktif():
        r = pindah(ambil(prosedur)); r["prosedur"] = None; tambah(r, "prosedur_fiktif")

    for sk, fn in (("kelas_naik", kelas_naik), ("dx_sekunder", dx_sekunder), ("topup_fiktif", topup_fiktif),
                   ("topup_inflasi", topup_inflasi), ("prosedur_fiktif", prosedur_fiktif)):
        say(sk, coba(SINGLE[sk], fn))

    # an INA-CBG code that almost never goes with the diagnosis (M15)
    n_kts = 0
    idx_ritl = list(pool.index[ritl][:5000])
    for _ in range(8000):
        if n_kts >= SINGLE["kode_tidak_sesuai"]:
            break
        i, j = rng.choice(idx_ritl), rng.choice(idx_ritl)
        if i in used or j in used or i == j:
            continue
        t, o = pool.loc[i], pool.loc[j]
        code = o.inacbg_kode
        if code and ref.rare_pair(t.dx_primer_icd3, code) and (rng.random() < 0.5 or str(code)[:1] != str(t.inacbg_kode)[:1]):
            used.update({i, j})
            r = bersih(o)
            tt = pindah(bersih(t))
            r.update(peserta_id=int(t.peserta_id), dx_primer_icd3=t.dx_primer_icd3, dx_primer_kode=t.dx_primer_kode, dx_primer_nama=t.dx_primer_nama,
                     tgl_datang=tt["tgl_datang"], tgl_pulang=tt["tgl_datang"] + timedelta(days=int(o.los_hari or 2)))
            tambah(r, "kode_tidak_sesuai"); n_kts += 1
    say("kode_tidak_sesuai", n_kts)

    # upcoding (M04) and lengthened stays (M12): two hospital-wide batches of 6–10 plus scattered claims
    def opsi_naik(k) -> list[str]:
        base, _, sev = str(k).rpartition("-")
        if sev == "I":
            return [f"{base}-{s}" for s in ("II", "III") if f"{base}-{s}" in eng.known_codes]
        if sev == "II":
            return [f"{base}-III"] if f"{base}-III" in eng.known_codes else []
        return []

    bisa_naik = pool.inacbg_kode.map(lambda k: bool(opsi_naik(k)))

    def upcode(r: dict) -> None:
        ops = opsi_naik(r["inacbg_kode"])
        up = ops[0] if (len(ops) > 1 and rng.random() < 0.3) else ops[-1]
        tarif0 = r.get("tarif_inacbg_rp") or r["biaya_tagih_rp"]
        tarif = int(tarif0 * rng.uniform(1.4, 2.2))
        r.update(inacbg_kode=up, inacbg_keparahan=SEV3 if up.endswith("-III") else SEV2,
                 inacbg_deskripsi=(eng.code_ref.get(up) or {}).get("inacbg_deskripsi") or r.get("inacbg_deskripsi"),
                 biaya_tagih_rp=tarif + int((r["biaya_tagih_rp"] or 0) - (r.get("tarif_inacbg_rp") or 0)), tarif_inacbg_rp=tarif)

    def panjang(r: dict) -> None:
        los = max(4, round(int(r.get("los_hari") or 2) * rng.uniform(2, 4)))
        r.update(los_hari=los, tgl_pulang=r["tgl_datang"] + timedelta(days=los))

    profs_ritl = list(pool[ritl].prof.value_counts().index[:40])
    for sk, mask, ubah, n_sebar in (("upcoding", ritl & bisa_naik, upcode, 10), ("los_bergeser", ritl, panjang, 8)):
        k = 0
        prs = profs_ritl[:]; rng.shuffle(prs)
        for _batch in range(2):
            n = rng.randint(6, 10)
            for prof in prs:
                cand = [i for i in pool.index[mask & (pool.prof == prof)] if i not in used]
                if len(cand) >= n:
                    prs.remove(prof)
                    for i in cand[:n]:
                        used.add(i)
                        r = pindah(bersih(pool.loc[i])); ubah(r); tambah(r, sk); k += 1
                    break

        def satu(mask=mask, ubah=ubah, sk=sk):
            r = pindah(ambil(mask)); ubah(r); tambah(r, sk)

        k += coba(n_sebar, satu)
        say(sk, k)

    # cloning (M05): one claim on 2–5 other members, sometimes a day or two apart
    k = 0
    for _ in range(4):
        try:
            t = pindah(ambil(ritl & (pool.los_hari.fillna(0) >= 3)))
        except LookupError:
            continue
        bill = int(t.get("tarif_inacbg_rp") or 0) + sum(int(t.get(s) or 0) for s in SPECIALS) + int(round(rng.uniform(0, 1.5e6), -4))
        for _k in range(rng.randint(2, 5)):
            try:
                mbr = ambil(pool.index >= 0)
            except LookupError:
                break
            r = {**t, "peserta_id": int(mbr["peserta_id"]), "biaya_tagih_rp": bill}
            if rng.random() < 0.3:
                sh = timedelta(days=rng.randint(1, 2))
                r["tgl_datang"] = t["tgl_datang"] + sh
                r["tgl_pulang"] = (t["tgl_pulang"] + sh) if t.get("tgl_pulang") is not None else None
            tambah(r, "kloning"); k += 1
    say("kloning", k)

    # rings (M10): 4–6 members circulating among 2–4 hospitals of one province within 4–12 days
    besar = pool.prof.value_counts()
    besar = set(besar[besar >= 8].index)
    sub = pool[pool.prof.isin(besar)]
    prov = sub.groupby(sub.kabkota_fkrtl_kode // 100).prof.nunique()
    k = 0
    for _ in range(2):
        nh, nm, gap = rng.randint(2, 4), rng.randint(4, 6), rng.randint(1, 3)
        pvs = [p for p, n in prov.items() if n >= nh]
        if not pvs:
            continue
        pv = rng.choice(pvs)
        profs = rng.sample(sorted(p for p in pool[(pool.kabkota_fkrtl_kode // 100) == pv].prof.unique() if p in besar), nh)
        members = [int(ambil(pool.index >= 0)["peserta_id"]) for _ in range(nm)]
        d0 = W0 + timedelta(days=rng.randint(0, max(0, (W1 - W0).days - nh * gap - 1)))
        for j, mbr in enumerate(members):
            for kk, prof in enumerate(profs):
                pm = pool.prof == prof
                try:
                    r = ambil(pm & (pool.tingkat_pelayanan == "RJTL"))
                except LookupError:
                    try:
                        r = ambil(pm)
                    except LookupError:
                        continue
                d = d0 + timedelta(days=kk * gap + j % 2)
                los = 2 if r.get("tingkat_pelayanan") == "RITL" else 0
                r.update(peserta_id=mbr, tgl_datang=d, tgl_pulang=d + timedelta(days=los))
                tambah(r, "cincin_kolusi"); k += 1
    say("cincin_kolusi", k)

    k = coba(NORMAL, lambda: tambah(pindah(ambil(pool.index >= 0)), "normal"))
    say("normal", k)
    rng.shuffle(out)
    # repeat billing (M11) and a borrowed card (M06) need a claim of this chunk to copy or to overlap; they arrive after it
    normals = [b for b, sk in out if sk == "normal"]
    for b in rng.sample(normals, 12):
        d = dict(b)
        if rng.random() < 0.3:
            d["biaya_tagih_rp"] = int(int(d["biaya_tagih_rp"] or 0) * rng.uniform(0.98, 1.02))
        tambah(d, "klaim_ganda")
    inap = [b for b in normals if b.get("tingkat_pelayanan") == "RITL" and int(b.get("los_hari") or 0) >= 3]
    k = 0
    for t0 in rng.sample(inap, min(8, len(inap))):
        try:
            o = ambil(ritl & ((pool.kabkota_fkrtl_kode // 100) != int(t0["kabkota_fkrtl_kode"]) // 100))
        except LookupError:
            continue
        d = t0["tgl_datang"] + timedelta(days=rng.randint(0, int(t0["los_hari"]) - 1))
        los = rng.randint(2, 5)
        o.update(peserta_id=int(t0["peserta_id"]), tgl_datang=d, tgl_pulang=d + timedelta(days=los), los_hari=los)
        tambah(o, "kartu_dipinjam"); k += 1
    say("klaim_ganda 12, kartu_dipinjam", k, "· claims", len(out), "fraud", sum(1 for _, s in out if s != "normal"))

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

    objs, labels, asal = [], [], []
    for b, sk in out:
        try:
            objs.append(ke_klaim(b)); labels.append(sk); asal.append(b.get("_asal") or "")
        except Exception as e:  # noqa: BLE001
            say("skipped a claim:", sk, str(e)[:120])
    gema = None
    if BERSIH:  # no echo: every source claim this chunk used leaves the member history before anything is ingested
        sumber = [{k: (None if (isinstance(v, float) and v != v) else v) for k, v in pool.loc[i].to_dict().items()} for i in sorted(used)]
        gema = BS.hapus_gema(eng.con, sumber)
        gema["sisa"] = BS.sisa_gema(eng.con, sumber)
        say("echo removed", gema)
    t1 = time.time()
    ids = []
    for a in range(0, len(objs), 2000):
        ids += eng.ingest(objs[a:a + 2000], f"datav2:{c}", None)
        while len(eng.q) > 3000:
            time.sleep(0.5)
    briefs = eng.wait(ids, 3600)
    keep = [k for k, b in enumerate(briefs) if b and b.get("keputusan") not in ("GAGAL", "DIGANTIKAN")]
    say(f"engine judged {len(keep)}/{len(ids)} in {time.time() - t1:.0f} s")
    recs_new = [eng.store.event(ids[k]) for k in keep]
    labels = [labels[k] for k in keep]
    asal = [asal[k] for k in keep]
    S_new = FT.sys_features(recs_new, ssl)
    rows1, rows2, rowsr = [], [], []
    for x, e in zip(S_new, recs_new):
        i = st.append(x, FT.claim_fields(e))
        rows1.append(st.agg_row(i)); rows2.append(st.s2_row(i)); rowsr.append(st.r2_row(i))
    lab = np.array(labels)
    np.savez_compressed(keluar, sk=lab, X1=np.vstack(rows1).astype(np.float32), X2=np.vstack(rows2).astype(np.float32), XR=np.vstack(rowsr).astype(np.float32),
                        tahan=np.array([e.get("keputusan") == "TAHAN" for e in recs_new]), periksa=np.array([e.get("keputusan") == "PERIKSA" for e in recs_new]),
                        peserta=np.array([str(e.get("peserta")) for e in recs_new]), faskes=np.array([str(e.get("faskes")) for e in recs_new]),
                        tgl=np.array([str(e.get("tgl_datang"))[:10] for e in recs_new]), kode=np.array([str(e.get("kode")) for e in recs_new]),
                        asal=np.array(asal), chunk=np.full(len(lab), c), **({"gema": np.array([json.dumps(gema)])} if gema else {}))
    say(f"chunk {c} saved: {len(lab)} claims, fraud {int((lab != 'normal').sum())}", {s: int((lab == s).sum()) for s in sorted(set(lab)) if s != "normal"})
    eng.stop() if hasattr(eng, "stop") else None


def jalankan() -> None:
    KERJA.mkdir(parents=True, exist_ok=True)
    for c in range(N_V2):
        keluar = KERJA / f"fitur_{c:02d}.npz"
        if keluar.exists():
            say("chunk", c, "done earlier")
            continue
        log = KERJA / f"log_{c:02d}.txt"
        say("chunk", c, "running")
        with log.open("w", encoding="utf-8") as fh:
            r = subprocess.run([sys.executable, str(Path(__file__)), "chunk", str(c)], stdout=fh, stderr=subprocess.STDOUT, env={**os.environ, "PYTHONUTF8": "1"})
        say("chunk", c, "exit", r.returncode, (log.read_text("utf-8").strip().splitlines() or [""])[-1][:240])
        shutil.rmtree(KERJA / f"data_{c:02d}", ignore_errors=True)
        if r.returncode != 0:
            say("stopped: chunk", c, "failed (see", log, ")")
            sys.exit(1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["chunk", "jalankan"])
    ap.add_argument("c", nargs="?", type=int, default=0)
    a = ap.parse_args()
    if a.perintah == "chunk":
        KERJA.mkdir(parents=True, exist_ok=True)
        chunk(a.c, KERJA / f"fitur_{a.c:02d}.npz")
        os._exit(0)
    else:
        jalankan()
