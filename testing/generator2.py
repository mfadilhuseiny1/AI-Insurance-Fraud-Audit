"""Generator 2: a second synthetic claim generator, independent of the first (the user, 2026-11-12: "coba bikin generator 2
data sintesis, bikin 200rb data klaim campur fraud dan normal, coba workflow v3 ... konsisten ga, give honest answer").

Why: every number of the v3 models so far (out-of-fold, tests A and B) is measured on claims made by ONE generator: the
sequential CART synthesizer (synthetic-gen/, leaf-donor sampling of whole rows) for the normal claims, and the planting code
of uji100k.py / data_v2.py for the fraud. A model can learn how that one generator writes claims. Generator 2 writes them
another way, so the same v3 workflow can be checked on claims that share none of that machinery.

What is different from generator 1:
- Normal claims are built field by field from a parametric, hierarchical model fitted on aggregates of the 2024 reguler
  claims (1 Jan – 17 Dec, before the replay window). No claim row is copied:
    hospital  from the member's residence (same kab/kota 74.6 %, same province 96.2 %) or the hospital of the member's last
              claim (89 % for members with history), by volume;
    code      from the hospital's case mix, reweighted by the member's sex and age band (P(cell | code) / P(cell));
    diagnosis from the code's diagnoses for the member's sex; LOS and secondary diagnoses from negative binomials per code;
    procedure from the code's procedure rate and its usual procedure lists;
    tariff    from the tariff book (code × regional × hospital type × ownership × class: one tariff per cell, as INA-CBG);
    top-ups   per code and column: a rate and a log-normal amount; class from the member's entitlement (non-PBI members
              may upgrade at the observed rate, PBI members stay in their class);
    journeys  claims per member in 14 days, gaps, same hospital / code / level of care for repeat visits, all measured on
              1–14 Nov 2024; arrival days weighted by weekday.
- Fraud is written from the Permenkes 16/2019 definitions with its own parameters, chosen before any result was seen and
  not changed afterwards: realistic magnitudes (upcoding one severity step at the tariff book's price, a stay 1–3 days longer,
  top-ups 1.3–2x the code's median, ...), upcoding and longer stays applied to 25–60 % of a hospital's eligible claims, and
  rarity judged on generator 2's own counts, never on the engine's references. Two schemes generator 1 never wrote:
  phantom billing (claims for members from other regions who never came) and upcoding to a procedural code with a procedure
  listed.
- Fraud and normal claims are drawn from the same members (80 % with an earlier claim, as in the data), so neither fingerprint
  of generator 1's plants exists here (same-day claims at another hospital; members new to the hospital).

What it shares with generator 1 (the limits of the comparison): the world. Hospitals, codes, the tariff book, the member
registry and every member's history before the window are generator 1's synthetic data, the aggregates it is fitted on are
generator 1's claims, and the v3 model has seen these hospitals' other claims through its neighbour features. Members of the
training data (replay stream, data v2, bench plants) are left out.

Usage: .venv/Scripts/python.exe testing/generator2.py fit       (aggregates → .tmp/gen2/param.pkl)
       .venv/Scripts/python.exe testing/generator2.py contoh 0  (one chunk's claims, counts only; no engine)
Synthetic data only."""
from __future__ import annotations

import math
import os
import pickle
import random
import sys
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
# GEN2_BARU=1 (step 4 of the v3 retrain, 2026-11-12): the same generator (same fitted parameters) with a new seed, on members of the
# fixed role "gen2_baru" only (testing/bersih.py), 8 chunks, into .tmp/gen2_baru; the first run (.tmp/gen2) was used for diagnosis
# GEN2_PERAN / GEN2_BENIH / GEN2_KERJA / GEN2_NCHUNK (ML v5, 2026-11-13): a member pool (bersih.py role), a seed, an output folder
PERAN_ENV = os.environ.get("GEN2_PERAN")
BARU = bool(os.environ.get("GEN2_BARU") or os.environ.get("GEN2_SEED3") or PERAN_ENV)
# GEN2_HALUS (ML v7, 2026-11-13, reviewer note on distribution shift): the schemes that add claims for outside members (phantom billing,
# borrowed card, collusion ring) use LOCAL members with an earlier claim instead, so fraud carries no "far from home / first visit"
# fingerprint. Off by default: every earlier run is unchanged.
HALUS = bool(os.environ.get("GEN2_HALUS"))
SEED3 = bool(os.environ.get("GEN2_SEED3"))  # final test of v4: role gen2_baru members, a third seed, into .tmp/gen2_seed3
KERJA = Path(os.environ["GEN2_KERJA"]) if os.environ.get("GEN2_KERJA") else ROOT / ".tmp" / ("gen2_seed3" if SEED3 else "gen2_baru" if BARU else "gen2")
PARAM = ROOT / ".tmp" / "gen2" / "param.pkl"
SILVER = ROOT / "data" / "drive" / "217f2b804b0c4525"
PESERTA = ROOT / "data" / "drive" / "9d7869ab23424a4e"
REPLAY = ROOT / "data" / "aip" / "realtime" / "replay_fkrtl_2024-12-18_2024-12-31.parquet"
FIT = (date(2024, 1, 1), date(2024, 12, 17))
W0, W1 = date(2024, 12, 18), date(2024, 12, 31)
N_CHUNK, KLAIM_PER_CHUNK = (int(os.environ.get("GEN2_NCHUNK") or 8) if BARU else 40), 5000
BENIH = int(os.environ["GEN2_BENIH"]) if os.environ.get("GEN2_BENIH") else 111_000 if SEED3 else 99_000 if BARU else 77_000
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
SEL = {c: c.split("_")[0] for c in SPECIALS}  # sa_tarif_rp -> sa (its kode/deskripsi columns)
UMUR = (2, 5, 15, 25, 45, 56, 60)  # bands <2, 2-4, 5-14, 15-24, 25-44, 45-55, 56-59, 60+ (the engine's perinatal and obstetric age limits)
NB = len(UMUR) + 1  # bands per sex; a cell = sex x band

# the schemes of generator 2: Permenkes 16/2019 mode, family (arsitektur_v2.FAMILI), and whether generator 1 ever wrote it
SKEMA = {
    "upcoding": ("Upcoding satu tingkat keparahan (harga buku tarif)", "M04", "koding", False),
    "dx_sekunder": ("Diagnosis sekunder ditambah (p90 + 2–5)", "M04", "koding", False),
    "prosedur_fiktif": ("Kode prosedur tanpa tindakan yang sesuai", "M14", "koding", False),
    "kode_tidak_sesuai": ("Kode INA-CBG lebih mahal, langka untuk diagnosis", "M15", "koding", False),
    "upcoding_prosedur": ("Kode medis dinaikkan ke kode prosedur, tindakan dicantumkan", "M04", "koding", True),
    "kelas_naik": ("Peserta PBI ditagih kelas 2/1", "M13", "tagihan", False),
    "topup_inflasi": ("Top-up dinaikkan/ditambah ke 1,3–2x median kode", "M07", "tagihan", False),
    "topup_fiktif": ("Top-up kolom yang hampir tak pernah ada untuk kode", "M17", "tagihan", False),
    "los_bergeser": ("Lama rawat +1–3 hari di satu RS", "M12", "episode", False),
    "pemecahan_episode": ("Satu rawat inap dipecah jadi dua klaim", "M09", "episode", False),
    "readmisi": ("Readmisi diagnosis sama 1–5 hari", "M16", "episode", False),
    "episode_hari_sama": ("Rawat jalan + rawat inap hari yang sama", "M08", "episode", False),
    "klaim_ganda": ("Klaim diajukan ulang (tanggal/biaya sedikit berubah)", "M11", "identitas", False),
    "kartu_dipinjam": ("Kartu dipakai di RS lain saat rawat inap", "M06", "identitas", False),
    "kloning": ("Satu klaim disalin ke 3–6 peserta lain", "M05", "identitas", False),
    "phantom_billing": ("Klaim palsu: peserta daerah lain yang tak pernah datang", "M06", "identitas", True),
    "cincin_kolusi": ("Collusion ring 3–8 peserta × 2–4 RS, 1–10 hari", "M10", "jaringan", False),
}
PER_CHUNK = {"kelas_naik": 8, "dx_sekunder": 8, "prosedur_fiktif": 6, "kode_tidak_sesuai": 6, "topup_fiktif": 6, "topup_inflasi": 6, "upcoding_prosedur": 6,
             "klaim_ganda": 5, "kartu_dipinjam": 4, "pemecahan_episode": 4, "readmisi": 4, "episode_hari_sama": 3}
T0 = time.time()


def say(*a) -> None:
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def kunci(kab, kep, jenis, tipe) -> str:
    return f"{int(kab)}|{kep}|{jenis}|{tipe if isinstance(tipe, str) else ''}"


# ------------------------------------------------------------------------------------------------------------------ fit
def fit() -> dict:
    """Aggregates only (counts, means, variances, medians, top lists); no claim row is kept."""
    import duckdb

    KERJA.mkdir(parents=True, exist_ok=True)
    (KERJA / "duckdb").mkdir(exist_ok=True)
    con = duckdb.connect()
    con.execute("SET threads = 4"); con.execute("SET memory_limit = '3GB'"); con.execute(f"SET temp_directory = '{(KERJA / 'duckdb').as_posix()}'")
    con.execute(f"""CREATE TABLE a AS SELECT peserta_id, CASE WHEN jenis_kelamin ILIKE 'laki%' THEN 'L' ELSE 'P' END AS jk,
                    date_diff('day', tgl_lahir, DATE '2024-12-25') / 365.25 AS umur, segmen,
                    CASE kelas_rawat WHEN 'KELAS I' THEN 1 WHEN 'KELAS II' THEN 2 WHEN 'KELAS III' THEN 3 END AS hak,
                    kabkota_fktp_terdaftar_kode AS kab FROM read_parquet('{PESERTA.as_posix()}') WHERE edisi = 'reguler'""")
    sel = ", ".join(f"{s}_kode, {s}_tarif_rp" + (f", {s}_deskripsi" if s != "sa" else "") for s in ("sa", "sp", "rr", "si", "sd"))
    con.execute(f"""CREATE TABLE s AS SELECT k.peserta_id, tgl_datang, tingkat_pelayanan AS t, kabkota_fkrtl_kode AS kab, kepemilikan_fkrtl AS kep,
                    jenis_fkrtl AS jenis, tipe_fkrtl AS tipe, kabkota_fkrtl, provinsi_fkrtl, regional_tarif, kelas_rawat, poli, status_pulang,
                    dx_primer_icd3 AS dx, dx_primer_kode, dx_primer_nama, inacbg_kode AS kode, inacbg_deskripsi, inacbg_cmg, inacbg_tipe_kasus,
                    inacbg_keparahan, prosedur, tarif_inacbg_rp, {sel}, los_hari, jumlah_dx_sekunder,
                    a.jk, CASE WHEN a.umur < 2 THEN 0 WHEN a.umur < 5 THEN 1 WHEN a.umur < 15 THEN 2 WHEN a.umur < 25 THEN 3 WHEN a.umur < 45 THEN 4
                         WHEN a.umur < 56 THEN 5 WHEN a.umur < 60 THEN 6 ELSE 7 END AS ub
                    FROM read_parquet('{SILVER.as_posix()}') k LEFT JOIN a USING (peserta_id)
                    WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{FIT[0]}' AND DATE '{FIT[1]}' AND inacbg_kode IS NOT NULL""")
    n = con.execute("SELECT count(*) FROM s").fetchone()[0]
    say("fit rows", n)
    P: dict = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "baris_fit": int(n), "periode_fit": [str(FIT[0]), str(FIT[1])]}

    # hospitals per level of care, their volume and labels
    P["rs"] = {}
    for t, kab, kep, jenis, tipe, nn, kabn, prov, reg in con.execute("""SELECT t, kab, kep, jenis, tipe, count(*), mode(kabkota_fkrtl), mode(provinsi_fkrtl),
                                                                      mode(regional_tarif) FROM s GROUP BY 1, 2, 3, 4, 5""").fetchall():
        P["rs"][(t, kunci(kab, kep, jenis, tipe))] = {"t": t, "kab": int(kab), "kep": kep, "jenis": jenis, "tipe": tipe, "n": int(nn),
                                                       "kab_nama": kabn, "prov_nama": prov, "regional": reg}
    # case mix per hospital
    mix: dict = defaultdict(lambda: ([], []))
    for t, kab, kep, jenis, tipe, kode, nn in con.execute("SELECT t, kab, kep, jenis, tipe, kode, count(*) FROM s GROUP BY ALL").fetchall():
        m = mix[(t, kunci(kab, kep, jenis, tipe))]
        m[0].append(kode); m[1].append(int(nn))
    P["mix"] = {k: (v[0], np.array(v[1], float)) for k, v in mix.items()}
    # per code: level, labels, LOS and secondary diagnoses (negative binomial moments), procedures
    P["kode"] = {}
    for row in con.execute("""SELECT kode, mode(t), count(*), mode(inacbg_deskripsi), mode(inacbg_cmg), mode(inacbg_tipe_kasus), mode(inacbg_keparahan),
                                     avg(greatest(coalesce(los_hari, 0) - 1, 0)), var_samp(greatest(coalesce(los_hari, 0) - 1, 0)),
                                     quantile_cont(los_hari, 0.99), avg(coalesce(jumlah_dx_sekunder, 0)), var_samp(coalesce(jumlah_dx_sekunder, 0)),
                                     quantile_cont(coalesce(jumlah_dx_sekunder, 0), 0.9), avg((prosedur IS NOT NULL)::INT), median(tarif_inacbg_rp)
                              FROM s GROUP BY 1""").fetchall():
        k = row[0]
        P["kode"][k] = {"t": row[1], "n": int(row[2]), "deskripsi": row[3], "cmg": row[4], "tipe_kasus": row[5], "keparahan": row[6],
                        "los_m": float(row[7] or 0), "los_v": float(row[8] or 0), "los_p99": float(row[9] or 0), "dxs_m": float(row[10] or 0),
                        "dxs_v": float(row[11] or 0), "dxs_p90": float(row[12] or 0), "p_pros": float(row[13] or 0), "tarif_med": float(row[14] or 0)}
    for kode, pros, nn in con.execute("""SELECT kode, prosedur, n FROM (SELECT kode, prosedur, count(*) n, row_number() OVER (PARTITION BY kode ORDER BY count(*) DESC) r
                                         FROM s WHERE prosedur IS NOT NULL GROUP BY 1, 2) WHERE r <= 15""").fetchall():
        P["kode"][kode].setdefault("pros", ([], []))
        P["kode"][kode]["pros"][0].append(pros); P["kode"][kode]["pros"][1].append(int(nn))
    for kode, poli, nn in con.execute("""SELECT kode, poli, n FROM (SELECT kode, poli, count(*) n, row_number() OVER (PARTITION BY kode ORDER BY count(*) DESC) r
                                         FROM s WHERE t = 'RJTL' AND poli IS NOT NULL GROUP BY 1, 2) WHERE r <= 5""").fetchall():
        P["kode"][kode].setdefault("poli", ([], []))
        P["kode"][kode]["poli"][0].append(poli); P["kode"][kode]["poli"][1].append(int(nn))
    # sex x age band per code (smoothed) and per level of care: the reweighting of the case mix
    sel_ = defaultdict(lambda: np.full(2 * NB, 0.05))
    for kode, jk, ub, nn in con.execute("SELECT kode, jk, ub, count(*) FROM s WHERE jk IS NOT NULL AND ub IS NOT NULL GROUP BY ALL").fetchall():
        sel_[kode][(0 if jk == "L" else NB) + int(ub)] += nn
    P["sel"] = {k: v / v.sum() for k, v in sel_.items()}
    base = {}
    for t in ("RITL", "RJTL"):
        v = np.full(2 * NB, 1.0)
        for jk, ub, nn in con.execute("SELECT jk, ub, count(*) FROM s WHERE t = ? AND jk IS NOT NULL AND ub IS NOT NULL GROUP BY ALL", [t]).fetchall():
            v[(0 if jk == "L" else NB) + int(ub)] += nn
        base[t] = v / v.sum()
    P["sel_dasar"] = base
    # diagnoses per code and cell (sex x age band), then per code and sex, then per code (top 12 each)
    P["dx"] = {}
    for kode, sel, dx, dk, dn, nn in con.execute(f"""SELECT kode, sel, dx, dx_primer_kode, dx_primer_nama, n FROM (
                 SELECT kode, (CASE WHEN jk = 'L' THEN 0 ELSE {NB} END) + ub AS sel, dx, mode(dx_primer_kode) dx_primer_kode, mode(dx_primer_nama) dx_primer_nama,
                 count(*) n, row_number() OVER (PARTITION BY kode, (CASE WHEN jk = 'L' THEN 0 ELSE {NB} END) + ub ORDER BY count(*) DESC) r
                 FROM s WHERE dx IS NOT NULL AND jk IS NOT NULL AND ub IS NOT NULL GROUP BY 1, 2, 3) WHERE r <= 12""").fetchall():
        d = P["dx"].setdefault((kode, int(sel)), ([], []))
        d[0].append((dx, dk, dn)); d[1].append(int(nn))
    for kode, jk, dx, dk, dn, nn in con.execute("""SELECT kode, jk, dx, dx_primer_kode, dx_primer_nama, n FROM (
                 SELECT kode, coalesce(jk, '?') jk, dx, mode(dx_primer_kode) dx_primer_kode, mode(dx_primer_nama) dx_primer_nama, count(*) n,
                 row_number() OVER (PARTITION BY kode, coalesce(jk, '?') ORDER BY count(*) DESC) r FROM s WHERE dx IS NOT NULL GROUP BY 1, 2, 3) WHERE r <= 12""").fetchall():
        d = P["dx"].setdefault((kode, jk), ([], []))
        d[0].append((dx, dk, dn)); d[1].append(int(nn))
    for kode, dx, dk, dn, nn in con.execute("""SELECT kode, dx, dx_primer_kode, dx_primer_nama, n FROM (
                 SELECT kode, dx, mode(dx_primer_kode) dx_primer_kode, mode(dx_primer_nama) dx_primer_nama, count(*) n,
                 row_number() OVER (PARTITION BY kode ORDER BY count(*) DESC) r FROM s WHERE dx IS NOT NULL GROUP BY 1, 2) WHERE r <= 12""").fetchall():
        d = P["dx"].setdefault((kode, "*"), ([], []))
        d[0].append((dx, dk, dn)); d[1].append(int(nn))
    # pairs (diagnosis, code) for generator 2's own rarity
    P["pasangan"] = {(dx, k): int(nn) for dx, k, nn in con.execute("SELECT dx, kode, count(*) FROM s WHERE dx IS NOT NULL GROUP BY 1, 2").fetchall()}
    P["dx_n"] = {dx: int(nn) for dx, nn in con.execute("SELECT dx, count(*) FROM s WHERE dx IS NOT NULL GROUP BY 1").fetchall()}
    # the tariff book and its fallbacks
    P["tarif"] = {}
    for k, reg, tipe, kep, kel, tr in con.execute("SELECT kode, regional_tarif, tipe, kep, kelas_rawat, median(tarif_inacbg_rp) FROM s GROUP BY ALL").fetchall():
        P["tarif"][(k, reg, tipe, kep, kel)] = int(tr or 0)
    for k, reg, kel, tr in con.execute("SELECT kode, regional_tarif, kelas_rawat, median(tarif_inacbg_rp) FROM s GROUP BY ALL").fetchall():
        P["tarif"][(k, reg, kel)] = int(tr or 0)
    for k, kel, tr in con.execute("SELECT kode, kelas_rawat, median(tarif_inacbg_rp) FROM s GROUP BY ALL").fetchall():
        P["tarif"][(k, kel)] = int(tr or 0)
    # class ratio per level (a class the book has not seen for a code: the median ratio over codes)
    rr = con.execute("""SELECT kelas_rawat, median(r) FROM (SELECT kode, kelas_rawat, median(tarif_inacbg_rp) / nullif(median(median(tarif_inacbg_rp)) OVER (PARTITION BY kode), 0) r
                        FROM s WHERE t = 'RITL' GROUP BY 1, 2) GROUP BY 1""").fetchall()
    P["rasio_kelas"] = {k: float(v or 1) for k, v in rr}
    # top-ups per code and column: rate, log-normal amount, usual code and description; and per column overall
    P["topup"], P["topup_kolom"] = {}, {}
    for c in SPECIALS:
        s_ = SEL[c]
        desk = f"mode({s_}_deskripsi) FILTER (WHERE {c} > 0)" if s_ != "sa" else "NULL"
        for k, nn, nz, mu, sd, kd, ds in con.execute(f"""SELECT kode, count(*), count(*) FILTER (WHERE {c} > 0), avg(ln(greatest({c}, 1))) FILTER (WHERE {c} > 0),
                       stddev_samp(ln(greatest({c}, 1))) FILTER (WHERE {c} > 0), mode({s_}_kode) FILTER (WHERE {c} > 0), {desk}
                       FROM s GROUP BY 1""").fetchall():
            if nz:
                P["topup"][(k, c)] = {"p": nz / nn, "n": int(nz), "mu": float(mu), "sd": float(sd or 0.3), "kode": kd, "desk": ds, "med": float(math.exp(mu))}
            else:
                P["topup"][(k, c)] = {"p": 0.0, "n": 0}
        mu, sd, kd, ds = con.execute(f"""SELECT avg(ln(greatest({c}, 1))), stddev_samp(ln(greatest({c}, 1))), mode({s_}_kode), {('mode(' + s_ + '_deskripsi)') if s_ != 'sa' else 'NULL'}
                                        FROM s WHERE {c} > 0""").fetchone()
        P["topup_kolom"][c] = {"mu": float(mu), "sd": float(sd or 0.5), "kode": kd, "desk": ds}
    P["status"] = {t: ([x for x, _ in r], np.array([n_ for _, n_ in r], float)) for t in ("RITL", "RJTL")
                   for r in [con.execute("SELECT status_pulang, count(*) FROM s WHERE t = ? AND status_pulang IS NOT NULL GROUP BY 1", [t]).fetchall()]}
    # class billed (inpatient) by entitlement and PBI
    P["kelas"] = {}
    for pbi, hak, kel, nn in con.execute("""SELECT a.segmen LIKE 'PBI%', a.hak, s.kelas_rawat, count(*) FROM s JOIN a USING (peserta_id)
                                          WHERE t = 'RITL' AND a.hak IS NOT NULL GROUP BY ALL""").fetchall():
        d = P["kelas"].setdefault((bool(pbi), int(hak)), ([], []))
        d[0].append(kel); d[1].append(int(nn))
    P["hari"] = {t: np.array([x[1] for x in sorted(con.execute("SELECT isodow(tgl_datang), count(*) FROM s WHERE t = ? GROUP BY 1", [t]).fetchall())], float)
                 for t in ("RITL", "RJTL")}
    # journeys: a 14-day window (1–14 Nov 2024)
    con.execute("""CREATE TABLE w AS SELECT peserta_id, tgl_datang, t, kode, kab, kep, jenis, tipe, los_hari, row_number() OVER (PARTITION BY peserta_id ORDER BY tgl_datang, t) i
                   FROM s WHERE tgl_datang BETWEEN DATE '2024-11-01' AND DATE '2024-11-14'""")
    P["k_klaim"] = dict(con.execute("SELECT n, count(*) FROM (SELECT peserta_id, count(*) n FROM w GROUP BY 1) GROUP BY 1").fetchall())
    j = con.execute("""SELECT date_diff('day', a.tgl_datang + CAST(CASE WHEN a.t = 'RITL' THEN coalesce(a.los_hari, 0) ELSE 0 END AS INT), b.tgl_datang) g,
                              (a.kab = b.kab AND a.kep = b.kep AND a.jenis = b.jenis AND coalesce(a.tipe, '') = coalesce(b.tipe, '')) rs, a.kode = b.kode kd, a.t = b.t tt
                       FROM w a JOIN w b ON a.peserta_id = b.peserta_id AND b.i = a.i + 1""").df()
    P["ulang"] = {"gap": Counter(int(max(0, g)) for g in j.g), "p_rs": float(j.rs.mean()), "p_kode": float(j.kd.mean()), "p_t": float(j.tt.mean())}
    # a repeat claim in the window, jointly: (its level, days after the claim before ends, same hospital, same code) given the level of the
    # claim before (sampling these apart made same-day copies of a claim, which the engine rightly calls duplicates)
    P["ulang_joint"] = {}
    for ta, tb, g, rs, kd, nn in con.execute("""SELECT a.t, b.t, least(greatest(date_diff('day', a.tgl_datang + CAST(CASE WHEN a.t = 'RITL' THEN coalesce(a.los_hari, 0) ELSE 0 END AS INT), b.tgl_datang), 0), 13),
                       (a.kab = b.kab AND a.kep = b.kep AND a.jenis = b.jenis AND coalesce(a.tipe, '') = coalesce(b.tipe, '')), a.kode = b.kode, count(*)
                       FROM w a JOIN w b ON a.peserta_id = b.peserta_id AND b.i = a.i + 1 GROUP BY ALL""").fetchall():
        d = P["ulang_joint"].setdefault(ta, ([], []))
        d[0].append((tb, int(g), bool(rs), bool(kd))); d[1].append(int(nn))
    # a member's first claim of the window against the member's last earlier claim, jointly: (its level, same hospital, same code)
    # given the last claim's level and the days since it
    con.execute("""CREATE TABLE f1 AS SELECT * FROM w WHERE i = 1""")
    con.execute("""CREATE TABLE hk AS SELECT peserta_id, tgl_datang, t, kode, kab, kep, jenis, tipe FROM s ORDER BY peserta_id, tgl_datang""")
    P["lanjut_joint"] = {}
    for tl, bk, tb, rs, kd, nn in con.execute(f"""SELECT h.t, CASE WHEN dd <= 3 THEN 0 WHEN dd <= 7 THEN 1 WHEN dd <= 14 THEN 2 WHEN dd <= 30 THEN 3
                       WHEN dd <= 90 THEN 4 WHEN dd <= 180 THEN 5 ELSE 6 END, f.t,
                       (f.kab = h.kab AND f.kep = h.kep AND f.jenis = h.jenis AND coalesce(f.tipe, '') = coalesce(h.tipe, '')), f.kode = h.kode, count(*)
                       FROM (SELECT f1.*, h.tgl_datang hd FROM f1 ASOF JOIN hk h ON f1.peserta_id = h.peserta_id AND f1.tgl_datang > h.tgl_datang) f
                       JOIN hk h ON h.peserta_id = f.peserta_id AND h.tgl_datang = f.hd, LATERAL (SELECT date_diff('day', f.hd, f.tgl_datang) dd)
                       GROUP BY ALL""").fetchall():
        d = P["lanjut_joint"].setdefault((tl, int(bk)), ([], []))
        d[0].append((tb, bool(rs), bool(kd))); d[1].append(int(nn))
    P["lanjut"] = {"p_riwayat": 0.799}  # members with an earlier claim among the first claims of 1–14 Nov
    P["lanjut_bk"] = {k: int(sum(v[1])) for k, v in P["lanjut_joint"].items()}  # (last level, days-since bucket) of those first claims
    P["tinggal"] = {"p_kab": 0.746, "p_prov": 0.962}
    # inpatient share of a member's first claim of 1–14 Nov by the level of the member's last earlier claim (none: new patient),
    # and of a repeat claim in the window by the level of the claim before it (measured 2026-11-12)
    P["p_ritl_awal"] = {"RITL": 0.145, "RJTL": 0.069, None: 0.396}
    P["p_ritl_ulang"] = {"RITL": 0.157, "RJTL": 0.057}
    con.close()
    with PARAM.open("wb") as fh:
        pickle.dump(P, fh)
    say("written", PARAM, {k: len(v) for k, v in P.items() if isinstance(v, dict)})
    return P


def muat() -> dict:
    with PARAM.open("rb") as fh:
        return pickle.load(fh)


# ----------------------------------------------------------------------------------------------------------- members
def anggota_chunk(c: int, kecuali: set[int]) -> tuple[list[dict], list[dict]]:
    """The registry members of chunk c (hash bucket), with and without an earlier reguler FKRTL claim (their last claim before
    the window), training members left out."""
    import duckdb
    import pandas as pd

    con = duckdb.connect()
    con.execute("SET threads = 4")
    a = con.execute(f"""SELECT peserta_id, CASE WHEN jenis_kelamin ILIKE 'laki%' THEN 'L' ELSE 'P' END jk, date_diff('day', tgl_lahir, DATE '2024-12-25') / 365.25 umur,
                        segmen, CASE kelas_rawat WHEN 'KELAS I' THEN 1 WHEN 'KELAS II' THEN 2 WHEN 'KELAS III' THEN 3 END hak,
                        kabkota_fktp_terdaftar_kode kab, tahun_meninggal
                        FROM read_parquet('{PESERTA.as_posix()}') WHERE edisi = 'reguler' AND {"TRUE" if BARU else f"abs(hash(peserta_id::VARCHAR || 'g2')) % {N_CHUNK} = {c}"}
                        AND kabkota_fktp_terdaftar_kode IS NOT NULL AND tgl_lahir IS NOT NULL""").df()
    if BARU:  # the role and its chunk bucket (bersih.py), computed in Python over the registry
        import bersih as BS

        role = PERAN_ENV or "gen2_baru"
        a = a[[BS.peran(p) == role and BS.ember(p, N_CHUNK, role) == c for p in a.peserta_id]]
    a = a[~a.peserta_id.isin(kecuali) & a.tahun_meninggal.isna()]
    con.register("ids", a[["peserta_id"]])
    last = con.execute(f"""SELECT peserta_id, tingkat_pelayanan t, kabkota_fkrtl_kode kab, kepemilikan_fkrtl kep, jenis_fkrtl jenis, tipe_fkrtl tipe, inacbg_kode kode, tgl_datang
                           FROM read_parquet('{SILVER.as_posix()}') WHERE edisi = 'reguler' AND tgl_datang < DATE '{W0}' AND peserta_id IN (SELECT peserta_id FROM ids)
                           QUALIFY row_number() OVER (PARTITION BY peserta_id ORDER BY tgl_datang DESC, tingkat_pelayanan) = 1""").df()
    con.close()
    lk = {int(r.peserta_id): r for r in last.itertuples()}
    hist, baru = [], []
    for r in a.itertuples():
        u = float(r.umur)
        seg = None if pd.isna(r.segmen) else str(r.segmen)
        m = {"pid": int(r.peserta_id), "jk": r.jk, "sel": (0 if r.jk == "L" else NB) + sum(u >= b for b in UMUR), "segmen": seg,
             "pbi": (seg or "").startswith("PBI"), "hak": 3 if pd.isna(r.hak) else int(r.hak), "kab": int(r.kab)}
        x = lk.get(m["pid"])
        if x is not None:
            m.update(rs=kunci(x.kab, x.kep, x.jenis, x.tipe), t=x.t, kode=x.kode, tgl=pd.Timestamp(x.tgl_datang).date())
            hist.append(m)
        else:
            baru.append(m)
    return hist, baru


# --------------------------------------------------------------------------------------------------------- generator
class Gen:
    def __init__(self, P: dict, c: int, hist: list[dict], baru: list[dict], seed: int | None = None) -> None:
        self.P, self.c = P, c
        self.r = random.Random(seed if seed is not None else BENIH + c)
        self.np = np.random.default_rng(seed if seed is not None else BENIH + c)
        self.r.shuffle(hist); self.r.shuffle(baru)
        self.hist, self.baru = hist, baru
        self.dipakai: set[int] = set()
        # members with history by the level and date of their last claim: who shows up in a 14-day window is mostly someone seen
        # recently (controls), so a journey picks the member by the days since the last claim, as the data's first claims do
        import bisect as _b
        self._bisect = _b
        self.hidx: dict[str, tuple[list, list]] = {}
        for m in sorted(hist, key=lambda m: m["tgl"]):
            ix = self.hidx.setdefault(m["t"], ([], []))
            ix[0].append(m["tgl"]); ix[1].append(m)
        self.bk = list(P["lanjut_bk"].items())
        self.out: list[dict] = []
        self.no = 0
        self.bobot_cache: dict = {}
        # hospitals by level, kab/kota and province, weighted by volume
        self.idx: dict = defaultdict(lambda: ([], []))
        for (t, k), h in P["rs"].items():
            if (t, k) not in P["mix"]:
                continue
            for key in ((t, "kab", h["kab"]), (t, "prov", h["kab"] // 100), (t, "all", 0)):
                self.idx[key][0].append(k); self.idx[key][1].append(h["n"])
        self.hari = [W0 + timedelta(days=i) for i in range((W1 - W0).days + 1)]

    # ---- sampling helpers
    def pilih(self, items, w):
        w = np.asarray(w, float)
        return items[int(self.np.choice(len(items), p=w / w.sum()))]

    def nb(self, m: float, v: float) -> int:
        if m <= 0:
            return 0
        if v > m * 1.01:
            return int(self.np.negative_binomial(m * m / (v - m), m / v))
        return int(self.np.poisson(m))

    def anggota(self, punya_riwayat: bool | None = None) -> dict:
        """Any unused member (rings, cloning): with history at the data's share."""
        if punya_riwayat is None:
            punya_riwayat = self.r.random() < self.P["lanjut"]["p_riwayat"]
        pool = self.hist if (punya_riwayat and self.hist) else self.baru
        while pool:
            m = pool.pop()
            if m["pid"] not in self.dipakai:
                self.dipakai.add(m["pid"])
                return m
        return self.anggota(not punya_riwayat) if (self.hist or self.baru) else None

    BATAS_BK = ((0, 3), (4, 7), (8, 14), (15, 30), (31, 90), (91, 180), (181, 100_000))

    def anggota_riwayat(self, d: date) -> dict | None:
        """A member with history whose last claim was (level, days before d) as drawn from the data's first claims."""
        tl, bk = self.pilih([k for k, _ in self.bk], [v for _, v in self.bk])
        urut = sorted(range(len(self.BATAS_BK)), key=lambda i: abs(i - bk))
        for t in (tl, "RJTL" if tl == "RITL" else "RITL"):
            if t not in self.hidx:
                continue
            tgl, ms = self.hidx[t]
            for i in urut:
                lo, hi = self.BATAS_BK[i]
                a = self._bisect.bisect_left(tgl, d - timedelta(days=hi))
                b = self._bisect.bisect_right(tgl, d - timedelta(days=lo))
                for _ in range(min(30, max(0, b - a))):
                    m = ms[self.r.randrange(a, b)]
                    if m["pid"] not in self.dipakai:
                        self.dipakai.add(m["pid"])
                        return m
        return None

    def tanggal(self, t: str, lo: date = W0, hi: date = W1) -> date:
        days = [d for d in self.hari if lo <= d <= hi] or [lo]
        w = [self.P["hari"][t][d.isoweekday() - 1] for d in days]
        return self.pilih(days, w)

    def rs_untuk(self, m: dict, t: str, bukan: str | None = None) -> str:
        """A hospital for the member by residence (same kab/kota, same province, anywhere), by volume; `bukan`: not this one."""
        for _ in range(6):
            rs = self._rs_tinggal(m, t)
            if rs != bukan:
                break
        return rs

    def _rs_tinggal(self, m: dict, t: str) -> str:
        P = self.P
        u = self.r.random()
        for key, p in (((t, "kab", m["kab"]), P["tinggal"]["p_kab"]), ((t, "prov", m["kab"] // 100), P["tinggal"]["p_prov"])):
            if u < p and self.idx.get(key) and self.idx[key][0]:
                return self.pilih(*self.idx[key])
        return self.pilih(*self.idx[(t, "all", 0)])

    def kode_lain(self, t: str, rs: str, m: dict, bukan: str | None) -> str | None:
        for _ in range(6):
            k = self.kode_untuk(t, rs, m)
            if k != bukan:
                return k
        return k

    def kode_untuk(self, t: str, rs: str, m: dict, syarat=None) -> str | None:
        key = (t, rs, m["sel"], syarat)
        if key not in self.bobot_cache:
            codes, n = self.P["mix"][(t, rs)]
            base = self.P["sel_dasar"][t][m["sel"]]
            w = np.array([n[i] * (self.P["sel"].get(k, np.full(2 * NB, 1 / (2 * NB)))[m["sel"]] / base) * (1.0 if syarat is None or syarat(k) else 0.0)
                          for i, k in enumerate(codes)])
            self.bobot_cache[key] = (codes, w)
        codes, w = self.bobot_cache[key]
        return self.pilih(codes, w) if w.sum() > 0 else None

    def tarif(self, kode: str, h: dict, kelas: str) -> int:
        T = self.P["tarif"]
        for k in ((kode, h["regional"], h["tipe"], h["kep"], kelas), (kode, h["regional"], kelas), (kode, kelas)):
            if T.get(k):
                return int(T[k])
        b = T.get((kode, "Kelas 3")) or self.P["kode"].get(kode, {}).get("tarif_med") or 0
        return int(b * self.P["rasio_kelas"].get(kelas, 1.0))

    # ---- one claim
    def klaim(self, m: dict, rs: str, t: str, kode: str, d: date, sk: str = "normal") -> dict:
        P, h, km = self.P, self.P["rs"][(t, rs)], self.P["kode"][kode]
        los = 0 if t == "RJTL" else min(60, 1 + self.nb(km["los_m"], km["los_v"]))
        dxl = P["dx"].get((kode, m["sel"])) or P["dx"].get((kode, m["jk"])) or P["dx"].get((kode, "L")) or P["dx"].get((kode, "P")) or P["dx"].get((kode, "*"))
        dx, dk, dn = self.pilih(dxl[0], dxl[1])
        pros = self.pilih(*km["pros"]) if (km.get("pros") and self.r.random() < km["p_pros"]) else None
        if t == "RJTL":
            kelas = "Kelas 3"
        else:
            kl = P["kelas"].get((m["pbi"], m["hak"])) or (["Kelas 3"], [1])
            kelas = self.pilih(kl[0], kl[1])
        b = {"edisi": "reguler", "peserta_id": m["pid"], "tgl_datang": d, "tgl_pulang": d + timedelta(days=los), "kabkota_fkrtl_kode": h["kab"],
             "kepemilikan_fkrtl": h["kep"], "jenis_fkrtl": h["jenis"], "tipe_fkrtl": h["tipe"], "tingkat_pelayanan": t,
             "poli": self.pilih(*km["poli"]) if (t == "RJTL" and km.get("poli")) else None, "segmen": m["segmen"], "kelas_rawat": kelas,
             "status_pulang": self.pilih(*P["status"][t]), "dx_primer_icd3": dx, "dx_primer_kode": dk, "dx_primer_nama": dn,
             "dx_masuk_kode": dk if t == "RITL" else None, "dx_masuk_nama": dn if t == "RITL" else None,
             "inacbg_kode": kode, "inacbg_deskripsi": km["deskripsi"], "inacbg_cmg": km["cmg"], "inacbg_tipe_kasus": km["tipe_kasus"],
             "inacbg_keparahan": km["keparahan"], "regional_tarif": h["regional"], "prosedur": pros, "los_hari": los,
             "jumlah_dx_sekunder": min(60, self.nb(km["dxs_m"], km["dxs_v"])), "flag_calon_klaim_ganda": False, "flag_los_ekstrem": bool(los > km["los_p99"] > 0),
             "layanan_covid": False, "kabkota_fkrtl": h["kab_nama"], "provinsi_fkrtl": h["prov_nama"]}
        b["tarif_inacbg_rp"] = self.tarif(kode, h, kelas)
        for c in SPECIALS:
            tp = P["topup"].get((kode, c)) or {"p": 0}
            b[c] = 0
            if tp["p"] > 0 and self.r.random() < tp["p"]:
                b[c] = int(round(math.exp(self.np.normal(tp["mu"], tp["sd"])), -3))
                b[f"{SEL[c]}_kode"] = tp.get("kode")
                if SEL[c] != "sa":
                    b[f"{SEL[c]}_deskripsi"] = tp.get("desk")
        self.hitung_biaya(b)
        return self.tambah(b, sk, m, rs)

    @staticmethod
    def hitung_biaya(b: dict) -> None:
        b["biaya_tagih_rp"] = int(b["tarif_inacbg_rp"] or 0) + sum(int(b.get(c) or 0) for c in SPECIALS)

    def tambah(self, b: dict, sk: str, m: dict, rs: str, varian: str = "") -> dict:
        self.no += 1
        b["kunjungan_fkrtl_id"] = f"G2{self.c:02d}{self.no:06d}"
        if b["tgl_datang"] > W1:  # a claim added after another stays inside the window
            sh = b["tgl_datang"] - W1
            b["tgl_datang"] -= sh
            b["tgl_pulang"] = (b["tgl_pulang"] - sh) if b.get("tgl_pulang") else None
        b["_sk"], b["_m"], b["_rs"], b["_varian"], b["_urut"] = sk, m, rs, varian, self.no
        self.out.append(b)
        return b

    def ganti_kode(self, b: dict, kode: str) -> None:
        km = self.P["kode"][kode]
        b.update(inacbg_kode=kode, inacbg_deskripsi=km["deskripsi"], inacbg_cmg=km["cmg"], inacbg_tipe_kasus=km["tipe_kasus"], inacbg_keparahan=km["keparahan"])
        b["tarif_inacbg_rp"] = self.tarif(kode, self.P["rs"][(b["tingkat_pelayanan"], b["_rs"])], b["kelas_rawat"])
        self.hitung_biaya(b)

    # ---- normal journeys
    def perjalanan(self, m: dict, d0: date | None = None) -> None:
        """One member's claims in the window. The first: for a member with history, (level, same hospital, same code as the last
        earlier claim) jointly by the last claim's level and the days since it; for a new patient, the new patients' inpatient share.
        Each repeat: (level, gap, same hospital, same code) jointly by the level of the claim before."""
        P = self.P
        ks, kw = zip(*sorted(P["k_klaim"].items()))
        k = self.pilih(list(ks), list(kw))
        if m.get("rs"):
            d = d0 or self.tanggal("RJTL")
            dd = (d - m["tgl"]).days
            bk = next(i for i, lim in enumerate((3, 7, 14, 30, 90, 180, 10 ** 6)) if dd <= lim)
            opsi = P["lanjut_joint"].get((m["t"], bk)) or P["lanjut_joint"][(m["t"], 6)]
            t, sama_rs, sama_kode = self.pilih(*opsi)
            if t == "RITL":
                d = self.tanggal("RITL", d - timedelta(days=3), d + timedelta(days=3))
        else:
            t = "RITL" if self.r.random() < P["p_ritl_awal"][None] else "RJTL"
            d = self.tanggal(t)
            sama_rs = sama_kode = False
        rs = m["rs"] if (sama_rs and (t, m["rs"]) in P["mix"]) else self.rs_untuk(m, t, m.get("rs"))
        kode = m["kode"] if (sama_kode and rs == m.get("rs") and P["kode"].get(m["kode"], {}).get("t") == t) else self.kode_lain(t, rs, m, m.get("kode"))
        if kode is None:
            return
        b = self.klaim(m, rs, t, kode, d)
        for _ in range(k - 1):
            if b["status_pulang"] == "Meninggal":
                break
            t2, gap, sama_rs, sama_kode = self.pilih(*P["ulang_joint"][b["tingkat_pelayanan"]])
            d = b["tgl_pulang"] + timedelta(days=gap)
            if d > W1:
                break
            rs2 = b["_rs"] if (sama_rs and (t2, b["_rs"]) in P["mix"]) else self.rs_untuk(m, t2, b["_rs"])
            kode2 = b["inacbg_kode"] if (sama_kode and t2 == b["tingkat_pelayanan"] and rs2 == b["_rs"]) else self.kode_lain(t2, rs2, m, b["inacbg_kode"])
            if kode2 is None:
                break
            b = self.klaim(m, rs2, t2, kode2, d)

    def normal(self, target: int) -> None:
        while len(self.out) < target:
            m, d = None, None
            if self.r.random() < self.P["lanjut"]["p_riwayat"]:
                d = self.tanggal("RJTL")
                m = self.anggota_riwayat(d)
            if m is None:
                m, d = self.anggota(False), None
            if m is None:
                break
            self.perjalanan(m, d)

    # ---- fraud
    def calon(self, f, sk="normal") -> list[dict]:
        return [b for b in self.out if b["_sk"] == sk and f(b)]

    def ubah(self, b: dict, sk: str, varian: str = "") -> None:
        b["_sk"], b["_varian"] = sk, varian

    def naik_satu(self, kode: str) -> str | None:
        base, _, sev = kode.rpartition("-")
        nxt = {"I": "II", "II": "III"}.get(sev)
        return f"{base}-{nxt}" if nxt and f"{base}-{nxt}" in self.P["kode"] else None

    def rs_skema(self, t: str, cocok, minimal: int, n: int) -> list[str]:
        cnt = Counter(b["_rs"] for b in self.calon(lambda b: b["tingkat_pelayanan"] == t and cocok(b)))
        rs = [k for k, v in cnt.most_common() if v >= minimal]
        self.r.shuffle(rs)
        return rs[:n]

    def fraud(self) -> None:
        P, r = self.P, self.r
        ritl = lambda b: b["tingkat_pelayanan"] == "RITL"  # noqa: E731
        # hospital level: a share q of one hospital's eligible claims
        for sk, n_rs, t, cocok, aksi in (
                ("upcoding", 4, "RITL", lambda b: self.naik_satu(b["inacbg_kode"]) is not None, "up"),
                ("los_bergeser", 4, "RITL", lambda b: True, "los")):
            for rs in self.rs_skema(t, cocok, 4, n_rs):
                q = r.uniform(0.25, 0.6)
                cs = [b for b in self.calon(lambda b: b["_rs"] == rs and ritl(b) and cocok(b))]
                for b in cs:
                    if r.random() >= q:
                        continue
                    if aksi == "up":
                        self.ganti_kode(b, self.naik_satu(b["inacbg_kode"]))
                        b["jumlah_dx_sekunder"] = min(60, int(b["jumlah_dx_sekunder"] or 0) + r.randint(1, 3))
                    else:
                        b["los_hari"] = int(b["los_hari"]) + r.randint(1, 3)
                        b["tgl_pulang"] = b["tgl_datang"] + timedelta(days=b["los_hari"])
                    self.ubah(b, sk)
        # top-ups inflated: only 0.8 % of the claims carry a top-up, too few per hospital for a hospital-level scheme, so 6 scattered
        # claims of a code whose top-up column is usual for it (>= 1 % of its claims): the top-up raised (or added) to 1.3–2x its median
        lazim = lambda b: [c for c in SPECIALS if (P["topup"].get((b["inacbg_kode"], c)) or {}).get("p", 0) >= 0.01]  # noqa: E731

        def tpi(b):
            c = r.choice([c for c in lazim(b) if b.get(c)] or lazim(b))
            tp = P["topup"][(b["inacbg_kode"], c)]
            varian = "dinaikkan" if b.get(c) else "ditambahkan"
            b[c] = int(round(max(b.get(c) or 0, tp["med"]) * r.uniform(1.3, 2.0), -3)); b[f"{SEL[c]}_kode"] = tp.get("kode")
            self.hitung_biaya(b); self.ubah(b, "topup_inflasi", varian)
        # phantom billing (new): one outpatient hospital bills 8–15 members from other regions who never came
        rs_list = self.idx[("RJTL", "all", 0)]
        big = [k for k, n in zip(*rs_list) if n >= 2000]
        if big and self.baru:
            rs = r.choice(big)
            h = P["rs"][("RJTL", rs)]
            jauh = ([m for m in self.hist if m["kab"] // 100 == h["kab"] // 100 and m["pid"] not in self.dipakai] if HALUS else
                    [m for m in self.baru if m["kab"] // 100 != h["kab"] // 100 and m["pid"] not in self.dipakai])
            for _ in range(r.randint(8, 15)):
                if not jauh:
                    break
                m = jauh.pop(r.randrange(len(jauh)))
                self.dipakai.add(m["pid"])
                kode = self.kode_untuk("RJTL", rs, m)
                if kode:
                    self.klaim(m, rs, "RJTL", kode, self.tanggal("RJTL"), "phantom_billing")
        # scattered single-claim schemes
        def satu(sk, cocok, ubah, n):
            cs = self.calon(cocok)
            r.shuffle(cs)
            k = 0
            for b in cs:
                if k >= n:
                    break
                if ubah(b) is not False:
                    k += 1

        def kelas(b):
            b["kelas_rawat"] = "Kelas 2" if r.random() < 0.75 else "Kelas 1"
            b["tarif_inacbg_rp"] = self.tarif(b["inacbg_kode"], P["rs"][(b["tingkat_pelayanan"], b["_rs"])], b["kelas_rawat"]); self.hitung_biaya(b)
            self.ubah(b, "kelas_naik")
        satu("kelas_naik", lambda b: ritl(b) and b["_m"]["pbi"] and b["kelas_rawat"] == "Kelas 3", kelas, PER_CHUNK["kelas_naik"])

        def dxs(b):
            b["jumlah_dx_sekunder"] = min(60, int(math.ceil(P["kode"][b["inacbg_kode"]]["dxs_p90"])) + r.randint(2, 5)); self.ubah(b, "dx_sekunder")
        satu("dx_sekunder", lambda b: (ritl(b) or r.random() < 0.25) and P["kode"][b["inacbg_kode"]]["n"] >= 200, dxs, PER_CHUNK["dx_sekunder"])

        def pros(b):
            if r.random() < 0.5:
                b["prosedur"] = None; self.ubah(b, "prosedur_fiktif", "dikosongkan")
            else:  # a minor procedure that does not justify the procedural code (the usual list of a medical code)
                med = [k for k, v in P["kode"].items() if v["t"] == b["tingkat_pelayanan"] and k[2] in "45" and v.get("pros")]
                b["prosedur"] = self.pilih(*P["kode"][r.choice(med)]["pros"]) if med else None
                self.ubah(b, "prosedur_fiktif", "tindakan_ringan")
        satu("prosedur_fiktif", lambda b: b["inacbg_kode"][2] in "13" and b["prosedur"], pros, PER_CHUNK["prosedur_fiktif"])

        def kts(b):
            dx = b["dx_primer_icd3"]
            tot = max(1, P["dx_n"].get(dx, 1))
            opsi = [k for k, v in P["kode"].items() if v["t"] == b["tingkat_pelayanan"] and k[0] != b["inacbg_kode"][0] and v["n"] >= 100
                    and P["pasangan"].get((dx, k), 0) / tot < 0.002 and v["tarif_med"] > P["kode"][b["inacbg_kode"]]["tarif_med"] * 1.2]
            if not opsi:
                return False
            self.ganti_kode(b, r.choice(opsi)); self.ubah(b, "kode_tidak_sesuai")
        satu("kode_tidak_sesuai", lambda b: ritl(b) and P["dx_n"].get(b["dx_primer_icd3"], 0) >= 200, kts, PER_CHUNK["kode_tidak_sesuai"])

        def tpf(b):
            cols = [c for c in SPECIALS if (P["topup"].get((b["inacbg_kode"], c)) or {}).get("p", 0) < 0.005 and not b.get(c)]
            if not cols:
                return False
            c = r.choice(cols)
            tk = P["topup_kolom"][c]
            b[c] = int(round(math.exp(tk["mu"]) * r.uniform(0.7, 1.5), -3)); b[f"{SEL[c]}_kode"] = tk["kode"]
            self.hitung_biaya(b); self.ubah(b, "topup_fiktif")
        satu("topup_fiktif", lambda b: (ritl(b) or r.random() < 0.2) and P["kode"][b["inacbg_kode"]]["n"] >= 200, tpf, PER_CHUNK["topup_fiktif"])
        satu("topup_inflasi", lambda b: bool(lazim(b)), tpi, PER_CHUNK["topup_inflasi"])

        def upp(b):  # new: a medical inpatient code moved to a procedural code of the same group letter and severity, procedure listed
            base = b["inacbg_kode"]
            opsi = [k for k, v in P["kode"].items() if k[0] == base[0] and k[2] == "1" and k.rsplit("-", 1)[1] == base.rsplit("-", 1)[1]
                    and v.get("pros") and v["n"] >= 50 and v["tarif_med"] > P["kode"][base]["tarif_med"]]
            if not opsi:
                return False
            k = r.choice(opsi)
            self.ganti_kode(b, k); b["prosedur"] = self.pilih(*P["kode"][k]["pros"]); self.ubah(b, "upcoding_prosedur")
        satu("upcoding_prosedur", lambda b: ritl(b) and b["inacbg_kode"][2] == "4", upp, PER_CHUNK["upcoding_prosedur"])

        # claims added next to a normal claim
        def salin(b: dict) -> dict:
            return {k: v for k, v in b.items() if not k.startswith("_") and k != "kunjungan_fkrtl_id"}

        for b in r.sample(self.calon(lambda b: True), PER_CHUNK["klaim_ganda"]):
            x = salin(b)
            sh = timedelta(days=r.randint(0, 2))
            x["tgl_datang"] += sh; x["tgl_pulang"] += sh
            x["biaya_tagih_rp"] = int(round(x["biaya_tagih_rp"] * r.uniform(0.97, 1.03), -3))
            self.tambah(x, "klaim_ganda", b["_m"], b["_rs"])
        for b in r.sample(self.calon(lambda b: ritl(b) and b["los_hari"] >= 2), PER_CHUNK["kartu_dipinjam"]):
            m, h = b["_m"], P["rs"][("RITL", b["_rs"])]
            if HALUS:  # another hospital of the same kab/kota (else of the same province)
                lain = ([k for k in self.idx[("RITL", "kab", h["kab"])][0] if k != b["_rs"]]
                        or [k for k in self.idx[("RITL", "prov", h["kab"] // 100)][0] if k != b["_rs"]])
            elif r.random() < 0.5:  # another kab/kota of the same province, or another province
                lain = [k for k in self.idx[("RITL", "prov", h["kab"] // 100)][0] if P["rs"][("RITL", k)]["kab"] != h["kab"]]
            else:
                lain = [k for k in self.idx[("RITL", "all", 0)][0] if P["rs"][("RITL", k)]["kab"] // 100 != h["kab"] // 100]
            if not lain:
                continue
            rs = r.choice(lain)
            kode = self.kode_untuk("RITL", rs, m)
            if kode:
                d = b["tgl_datang"] + timedelta(days=r.randint(0, max(0, b["los_hari"] - 1)))
                x = self.klaim(m, rs, "RITL", kode, d, "kartu_dipinjam")
                x["los_hari"] = r.randint(1, 4); x["tgl_pulang"] = d + timedelta(days=x["los_hari"])
        # cloning: one claim on 3–6 other members of the hospital's area
        tpl = r.choice(self.calon(lambda b: (ritl(b) and b["los_hari"] >= 2) or (not ritl(b) and r.random() < 0.3)))
        h = P["rs"][(tpl["tingkat_pelayanan"], tpl["_rs"])]
        dekat = [m for m in self.hist + self.baru if m["kab"] // 100 == h["kab"] // 100 and m["sel"] == tpl["_m"]["sel"] and m["pid"] not in self.dipakai]
        for m in dekat[:r.randint(3, 6)]:
            self.dipakai.add(m["pid"])
            x = salin(tpl)
            sh = timedelta(days=r.randint(0, 3))
            x.update(peserta_id=m["pid"], segmen=m["segmen"], tgl_datang=x["tgl_datang"] + sh, tgl_pulang=x["tgl_pulang"] + sh,
                     biaya_tagih_rp=int(round(x["biaya_tagih_rp"] * r.uniform(0.98, 1.02), -3)))
            self.tambah(x, "kloning", m, tpl["_rs"])
        # episode schemes
        for b in r.sample(self.calon(lambda b: ritl(b) and b["los_hari"] >= 4 and b["tgl_pulang"] <= W1 - timedelta(days=1)), PER_CHUNK["pemecahan_episode"]):
            los0, k = b["los_hari"], r.randint(1, b["los_hari"] - 2)
            x = salin(b)
            b["los_hari"] = k; b["tgl_pulang"] = b["tgl_datang"] + timedelta(days=k)
            x["tgl_datang"] = b["tgl_pulang"] + timedelta(days=r.randint(0, 1)); x["los_hari"] = max(1, (b["tgl_datang"] + timedelta(days=los0) - x["tgl_datang"]).days)
            x["tgl_pulang"] = x["tgl_datang"] + timedelta(days=x["los_hari"])
            self.ubah(b, "pemecahan_episode")
            y = self.tambah(x, "pemecahan_episode", b["_m"], b["_rs"])
            if r.random() < 0.4:
                lain = [k_ for k_ in (b["inacbg_kode"].rsplit("-", 1)[0] + "-" + s for s in ("I", "II", "III")) if k_ in P["kode"] and k_ != b["inacbg_kode"]]
                if lain:
                    self.ganti_kode(y, r.choice(lain))
        for b in r.sample(self.calon(lambda b: ritl(b) and b["status_pulang"] != "Meninggal" and b["tgl_pulang"] <= W1 - timedelta(days=5)), PER_CHUNK["readmisi"]):
            kode = r.choice([k for k in (b["inacbg_kode"].rsplit("-", 1)[0] + "-" + s for s in ("I", "II", "III")) if k in P["kode"]] or [b["inacbg_kode"]])
            x = self.klaim(b["_m"], b["_rs"], "RITL", kode, b["tgl_pulang"] + timedelta(days=r.randint(1, 5)), "readmisi")
            x.update(dx_primer_icd3=b["dx_primer_icd3"], dx_primer_kode=b["dx_primer_kode"], dx_primer_nama=b["dx_primer_nama"],
                     dx_masuk_kode=b["dx_primer_kode"], dx_masuk_nama=b["dx_primer_nama"])
        for b in r.sample(self.calon(ritl), PER_CHUNK["episode_hari_sama"]):
            if ("RJTL", b["_rs"]) not in P["mix"]:
                continue
            kode = self.kode_untuk("RJTL", b["_rs"], b["_m"])
            if kode:
                self.klaim(b["_m"], b["_rs"], "RJTL", kode, b["tgl_datang"], "episode_hari_sama")
        # a collusion ring
        prov = Counter(P["rs"][("RJTL", k)]["kab"] // 100 for k, n in zip(*self.idx[("RJTL", "all", 0)]) if n >= 500)
        nh, nm, span = r.randint(2, 4), r.randint(3, 8), r.randint(1, 10)
        pvs = [p for p, n in prov.items() if n >= nh]
        if pvs:
            pv = r.choice(pvs)
            rss = r.sample([k for k, n in zip(*self.idx[("RJTL", "all", 0)]) if n >= 500 and P["rs"][("RJTL", k)]["kab"] // 100 == pv], nh)
            d0 = W0 + timedelta(days=r.randint(0, max(0, (W1 - W0).days - span)))
            lokal = [m for m in self.hist if m["kab"] // 100 == pv and m["pid"] not in self.dipakai] if HALUS else []
            for _ in range(nm):
                if HALUS and lokal:
                    m = lokal.pop(r.randrange(len(lokal))); self.dipakai.add(m["pid"])
                else:
                    m = self.anggota()
                ikut = [x for x in rss if r.random() < 0.75] or rss[:2]
                if len(ikut) < 2:
                    ikut = r.sample(rss, 2)
                for rs in ikut:
                    t = "RITL" if (r.random() < 0.2 and ("RITL", rs) in P["mix"]) else "RJTL"
                    kode = self.kode_untuk(t, rs, m)
                    if kode:
                        x = self.klaim(m, rs, t, kode, d0 + timedelta(days=r.randint(0, span)), "cincin_kolusi")
                        if t == "RITL":
                            x["los_hari"] = min(x["los_hari"], 3); x["tgl_pulang"] = x["tgl_datang"] + timedelta(days=x["los_hari"])

    def urutan(self) -> list[dict]:
        """Claims arrive in date order (a claim added next to another arrives after it on the same day)."""
        return sorted(self.out, key=lambda b: (b["tgl_datang"], b["_urut"]))


def buat(c: int, kecuali: set[int], P: dict | None = None) -> list[dict]:
    P = P or muat()
    hist, baru = anggota_chunk(c, kecuali)
    say(f"chunk {c}: members with history {len(hist)}, without {len(baru)}")
    g = Gen(P, c, hist, baru)
    g.normal(KLAIM_PER_CHUNK - 50)  # the fraud adds about 50 claims and turns about 80 normal claims into fraud
    g.fraud()
    return g.urutan()


def kecuali_latih() -> set[int]:
    """Members of the training data that do not live in the stream copy: the replay window and data v2."""
    import pandas as pd

    out = set(int(x) for x in pd.read_parquet(REPLAY, columns=["peserta_id"]).peserta_id.unique())
    for f in sorted((ROOT / ".tmp" / "data_v2").glob("fitur_[0-9][0-9].npz")):
        out.update(int(x) for x in np.load(f)["peserta"] if str(x).isdigit())
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "fit"
    if cmd == "fit":
        fit()
    elif cmd == "contoh":
        c = int(sys.argv[2]) if len(sys.argv) > 2 else 0
        out = buat(c, kecuali_latih())
        cnt = Counter(b["_sk"] for b in out)
        say("claims", len(out), "fraud", sum(v for k, v in cnt.items() if k != "normal"), dict(cnt))
        say("RITL share", round(sum(b["tingkat_pelayanan"] == "RITL" for b in out) / len(out), 3),
            "members", len({b["peserta_id"] for b in out}), "with history", round(sum(1 for b in out if b["_m"].get("rs")) / len(out), 3))
