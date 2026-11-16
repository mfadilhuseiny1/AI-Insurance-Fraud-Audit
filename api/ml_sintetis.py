"""Rule 2 of the Healthkathon evaluation kit (github.com/Luche/healthkathon-eval-kit, checklists/rule2_conditions.md):
known fraud types planted in the REAL hospital claims of the BPJS sample, three dials varied one at a time from a
baseline, and one fraud type at a time held out of training. The generator is this file; its specification
(docs/healthkathon/SPESIFIKASI_GENERATOR.md) and this code are committed before any detector output is looked at
(Rule 1's commit step).

Base: every hospital claim of silver kunjungan_fkrtl, without the claims the verifier actually corrected (so the only
positives are planted ones). Legitimate claims stay identical across conditions (same seed); the selected claims are
changed in place, or new claims are added (repeat billing, phantom billing). Every amount is priced the INA-CBG way from
the data itself: an upcoded claim takes the median tariff of its new code in the same regional tariff, class and
hospital type (never a multiplier, so no amount is "too round" only on fraud: the artefact trap of slide 21). The rule
flags (duplicate candidate, LOS above the code's p99) are recomputed on the planted data, as a real pipeline would.

Label = planted (flag_selisih_verifikasi set, so ml_klaim.prepare reads it as y); the legitimate amount goes into
biaya_verifikasi_rp, so excess = billed − legitimate (the kit's excess_rupiah). The modus of each planted claim is kept
in table `modus` (klaim_id, modus).

Dials (baseline: mudah · 2% · tersebar):
  kesulitan   mudah | sulit (per type below)
  frekuensi   0.5% | 2% | 10% of hospital claims (US estimates of 3–10% cited as a comparison by the KPK–Kemenkes–
              BPJS–BPKP team, Bisnis.com 24 Jul 2024; there is no published rate for JKN, so the dial spans it)
  klaster     tersebar: fraud in 30% of hospital profiles | terpusat: in 3%
"""

from __future__ import annotations

import time
from typing import Any, Callable

BERAT = "Berat (rawat inap keparahan 3)"
MODUS: dict[str, dict[str, str]] = {
    "upcoding_keparahan": {"label": "Upcoding keparahan rawat inap", "mudah": "keparahan I → III", "sulit": "keparahan II → III, plus 2 diagnosis sekunder"},
    "upcoding_prosedur": {"label": "Upcoding rawat jalan ke prosedur", "mudah": "kunjungan tanpa prosedur → kode prosedur signifikan di CMG yang sama",
                          "sulit": "hanya pada diagnosis yang lazim berprosedur (≥ 20%)"},
    "los_diperpanjang": {"label": "Lama rawat diperpanjang", "mudah": "+5–8 hari", "sulit": "+1–2 hari"},
    "klaim_berulang": {"label": "Klaim berulang / episode dipecah", "mudah": "klaim kembar di hari yang sama", "sulit": "klaim ulang 3–10 hari kemudian"},
    "phantom_billing": {"label": "Phantom billing (klaim fiktif)", "mudah": "salinan identik satu klaim ke pasien fiktif",
                        "sulit": "salinan klaim-klaim faskes itu sendiri ke pasien fiktif (beragam)"},
    "tarif_tambahan": {"label": "Tarif tambahan (special CMG) tidak wajar", "mudah": "tambahan p95 pada kode yang jarang bertambahan",
                       "sulit": "tambahan median pada kode yang lazim bertambahan"},
    "tagihan_lebih": {"label": "Tagihan melebihi tarif", "mudah": "+30% di atas tarif", "sulit": "+5% di atas tarif"},
}
CONDITIONS: dict[str, dict[str, Any]] = {
    "baseline": {"kesulitan": "mudah", "frekuensi": 0.02, "klaster": "tersebar"},
    "sulit": {"kesulitan": "sulit", "frekuensi": 0.02, "klaster": "tersebar"},
    "jarang": {"kesulitan": "mudah", "frekuensi": 0.005, "klaster": "tersebar"},
    "sering": {"kesulitan": "mudah", "frekuensi": 0.10, "klaster": "tersebar"},
    "terpusat": {"kesulitan": "mudah", "frekuensi": 0.02, "klaster": "terpusat"},
}
CLUSTER = {"tersebar": 0.30, "terpusat": 0.03}
SEED = 2026


def _u(expr: str, salt: str) -> str:
    """A uniform [0, 1) number from a hash: reproducible, and independent per salt."""
    return f"(hash({expr} || '{salt}|{SEED}') % 1000000) / 1000000.0"


def base(con: Any, table: str = "k") -> int:
    """Table kb: the hospital claims without real corrections, with their key and facility profile, and the price tables."""
    con.execute(f"""CREATE OR REPLACE TEMP TABLE kb AS
SELECT *, edisi || ':' || kunjungan_fkrtl_id AS kkey,
       md5(concat_ws('|', 'FKRTL', kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl)) AS fid
FROM {table} WHERE jenis_fkrtl = 'Rumah sakit' AND NOT coalesce(flag_selisih_verifikasi, false)""")
    con.execute("""CREATE OR REPLACE TEMP TABLE harga AS
SELECT inacbg_kode, regional_tarif, kelas_rawat, tipe_fkrtl, median(tarif_inacbg_rp) AS tarif, any_value(inacbg_deskripsi) AS deskripsi
FROM kb WHERE tarif_inacbg_rp > 0 GROUP BY ALL""")
    con.execute("""CREATE OR REPLACE TEMP TABLE harga_kode AS
SELECT inacbg_kode, median(tarif_inacbg_rp) AS tarif, any_value(inacbg_deskripsi) AS deskripsi, any_value(inacbg_cmg) AS cmg
FROM kb WHERE tarif_inacbg_rp > 0 GROUP BY 1""")
    # per CMG, the commonest outpatient procedure code and its tariff (the target of procedure upcoding)
    con.execute("""CREATE OR REPLACE TEMP TABLE prosedur_cmg AS
SELECT inacbg_cmg, arg_max(inacbg_kode, n) AS kode, arg_max(tarif, n) AS tarif, arg_max(deskripsi, n) AS deskripsi, arg_max(prosedur, n) AS prosedur
FROM (SELECT inacbg_cmg, inacbg_kode, count(*) AS n, median(tarif_inacbg_rp) AS tarif, any_value(inacbg_deskripsi) AS deskripsi,
             mode(prosedur) AS prosedur
      FROM kb WHERE tingkat_pelayanan = 'RJTL' AND inacbg_tipe_kasus = 'Prosedur Signifikan Rawat Jalan' GROUP BY 1, 2) GROUP BY 1""")
    con.execute("""CREATE OR REPLACE TEMP TABLE dx_prosedur AS
SELECT dx_primer_icd3, avg((inacbg_tipe_kasus LIKE 'Prosedur%')::INT) AS p FROM kb WHERE tingkat_pelayanan = 'RJTL' GROUP BY 1""")
    topup = "coalesce(sa_tarif_rp, 0) + coalesce(sp_tarif_rp, 0) + coalesce(rr_tarif_rp, 0) + coalesce(si_tarif_rp, 0) + coalesce(sd_tarif_rp, 0)"
    con.execute(f"""CREATE OR REPLACE TEMP TABLE tambahan AS
SELECT inacbg_kode, avg(({topup} > 0)::INT) AS porsi FROM kb WHERE tingkat_pelayanan = 'RITL' GROUP BY 1""")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE tambahan_nilai AS
SELECT quantile_cont({topup}, 0.5) AS med, quantile_cont({topup}, 0.95) AS p95 FROM kb WHERE {topup} > 0""")
    return int(con.execute("SELECT count(*) FROM kb").fetchone()[0])


def plant(con: Any, condition: str, log: Callable[[str], None] = print) -> dict[str, Any]:
    """Table ki: kb with the fraud of `condition` planted; table modus (klaim_id, modus). Returns the counts."""
    c = CONDITIONS[condition]
    hard = c["kesulitan"] == "sulit"
    t0 = time.time()
    n = int(con.execute("SELECT count(*) FROM kb").fetchone()[0])
    per = int(round(c["frekuensi"] * n / len(MODUS)))
    share = CLUSTER[c["klaster"]]
    con.execute(f"""CREATE OR REPLACE TEMP TABLE pelaku AS
SELECT fid FROM (SELECT DISTINCT fid FROM kb) WHERE {_u('fid', 'pelaku')} < {share}""")
    # who may carry each in-place type (one type per claim)
    eligible = {
        # an upcode must cost more: the new code's tariff (as priced below) at least 5% above the claim's
        "upcoding_keparahan": ("tingkat_pelayanan = 'RITL' AND inacbg_keparahan LIKE " + ("'Sedang%'" if hard else "'Ringan%'")
                               + " AND kkey IN (SELECT kkey FROM naik WHERE tarif_baru > tarif_lama * 1.05)"),
        "upcoding_prosedur": ("tingkat_pelayanan = 'RJTL' AND inacbg_tipe_kasus = 'Rawat Jalan Bukan Prosedur' "
                              "AND (SELECT tarif FROM prosedur_cmg pc WHERE pc.inacbg_cmg = kb.inacbg_cmg) > tarif_inacbg_rp * 1.05"
                              + (" AND dx_primer_icd3 IN (SELECT dx_primer_icd3 FROM dx_prosedur WHERE p >= 0.2)" if hard else "")),
        "los_diperpanjang": "tingkat_pelayanan = 'RITL'",
        "tarif_tambahan": ("tingkat_pelayanan = 'RITL' AND inacbg_kode IN (SELECT inacbg_kode FROM tambahan WHERE porsi "
                           + (">= 0.1)" if hard else "< 0.02)")),
        "tagihan_lebih": "tarif_inacbg_rp > 0",
    }
    con.execute("""CREATE OR REPLACE TEMP TABLE naik AS
SELECT kb.kkey, kb.tarif_inacbg_rp AS tarif_lama, coalesce(h1.tarif, hk.tarif) AS tarif_baru
FROM kb JOIN harga_kode hk ON hk.inacbg_kode = regexp_replace(kb.inacbg_kode, '-(I|II)$', '-III')
LEFT JOIN harga h1 ON h1.inacbg_kode = hk.inacbg_kode AND h1.regional_tarif IS NOT DISTINCT FROM kb.regional_tarif
     AND h1.kelas_rawat IS NOT DISTINCT FROM kb.kelas_rawat AND h1.tipe_fkrtl IS NOT DISTINCT FROM kb.tipe_fkrtl
WHERE kb.tingkat_pelayanan = 'RITL' AND (kb.inacbg_kode LIKE '%-I' OR kb.inacbg_kode LIKE '%-II')""")
    con.execute("CREATE OR REPLACE TEMP TABLE pilih (kkey VARCHAR, modus VARCHAR)")
    for m, cond in eligible.items():
        avail = int(con.execute(f"SELECT count(*) FROM kb WHERE fid IN (SELECT fid FROM pelaku) AND {cond} "
                                "AND kkey NOT IN (SELECT kkey FROM pilih)").fetchone()[0])
        rate = min(1.0, per / max(avail, 1))
        con.execute(f"""INSERT INTO pilih SELECT kkey, '{m}' FROM kb WHERE fid IN (SELECT fid FROM pelaku) AND {cond}
                        AND kkey NOT IN (SELECT kkey FROM pilih) AND {_u('kkey', m)} < {rate}""")
    tp = con.execute("SELECT med, p95 FROM tambahan_nilai").fetchone()
    add = float(tp[0] if hard else tp[1])
    extra_los = "1 + (hash(kb.kkey || 'los') % 2)" if hard else "5 + (hash(kb.kkey || 'los') % 4)"
    inflate = 1.05 if hard else 1.30
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ki AS
WITH j AS (
  SELECT kb.*, p.modus,
         h1.tarif AS t_up, coalesce(h1.deskripsi, hk.deskripsi) AS d_up, coalesce(h1.tarif, hk.tarif) AS t_up_any,
         pc.kode AS k_pr, pc.tarif AS t_pr, pc.deskripsi AS d_pr, pc.prosedur AS pr_pr
  FROM kb LEFT JOIN pilih p USING (kkey)
  LEFT JOIN harga h1 ON p.modus = 'upcoding_keparahan' AND h1.inacbg_kode = regexp_replace(kb.inacbg_kode, '-(I|II)$', '-III')
       AND h1.regional_tarif IS NOT DISTINCT FROM kb.regional_tarif AND h1.kelas_rawat IS NOT DISTINCT FROM kb.kelas_rawat
       AND h1.tipe_fkrtl IS NOT DISTINCT FROM kb.tipe_fkrtl
  LEFT JOIN harga_kode hk ON p.modus = 'upcoding_keparahan' AND hk.inacbg_kode = regexp_replace(kb.inacbg_kode, '-(I|II)$', '-III')
  LEFT JOIN prosedur_cmg pc ON p.modus = 'upcoding_prosedur' AND pc.inacbg_cmg = kb.inacbg_cmg)
SELECT * EXCLUDE (modus, t_up, d_up, t_up_any, k_pr, t_pr, d_pr, pr_pr) REPLACE (
  CASE modus WHEN 'upcoding_keparahan' THEN regexp_replace(inacbg_kode, '-(I|II)$', '-III')
             WHEN 'upcoding_prosedur' THEN k_pr ELSE inacbg_kode END AS inacbg_kode,
  CASE modus WHEN 'upcoding_keparahan' THEN d_up WHEN 'upcoding_prosedur' THEN d_pr ELSE inacbg_deskripsi END AS inacbg_deskripsi,
  CASE modus WHEN 'upcoding_keparahan' THEN '{BERAT}' ELSE inacbg_keparahan END AS inacbg_keparahan,
  CASE modus WHEN 'upcoding_prosedur' THEN 'Prosedur Signifikan Rawat Jalan' ELSE inacbg_tipe_kasus END AS inacbg_tipe_kasus,
  CASE modus WHEN 'upcoding_prosedur' THEN coalesce(prosedur, pr_pr) ELSE prosedur END AS prosedur,
  CASE modus WHEN 'upcoding_keparahan' THEN round(t_up_any)::BIGINT WHEN 'upcoding_prosedur' THEN round(t_pr)::BIGINT ELSE tarif_inacbg_rp END AS tarif_inacbg_rp,
  CASE modus WHEN 'tarif_tambahan' THEN coalesce(sp_tarif_rp, 0) + {round(add)} ELSE sp_tarif_rp END AS sp_tarif_rp,
  CASE modus WHEN 'upcoding_keparahan' THEN biaya_tagih_rp - tarif_inacbg_rp + round(t_up_any)::BIGINT
             WHEN 'upcoding_prosedur' THEN biaya_tagih_rp - tarif_inacbg_rp + round(t_pr)::BIGINT
             WHEN 'tarif_tambahan' THEN biaya_tagih_rp + {round(add)}
             WHEN 'tagihan_lebih' THEN round(biaya_tagih_rp * {inflate})::BIGINT ELSE biaya_tagih_rp END AS biaya_tagih_rp,
  CASE modus WHEN 'los_diperpanjang' THEN los_hari + {extra_los.replace('kb.', '')} ELSE los_hari END AS los_hari,
  CASE modus WHEN 'los_diperpanjang' THEN tgl_pulang + ({extra_los.replace('kb.', '')})::INT ELSE tgl_pulang END AS tgl_pulang,
  CASE WHEN modus = 'upcoding_keparahan' AND {str(hard).lower()} THEN jumlah_dx_sekunder + 2 ELSE jumlah_dx_sekunder END AS jumlah_dx_sekunder,
  biaya_tagih_rp AS biaya_verifikasi_rp,
  modus IS NOT NULL AS flag_selisih_verifikasi)
FROM j""")
    # (the legitimate amount is the original bill: biaya_verifikasi_rp keeps it, so excess = new bill − original;
    #  a longer stay is paid the same INA-CBG tariff, its excess is 0 but it is still fraud)
    con.execute("CREATE OR REPLACE TEMP TABLE modus AS SELECT kkey AS klaim_id, modus FROM pilih")
    # added claims: repeat billing (the same patient again) and phantom billing (copies to fictitious patients)
    rep_pick = f"{_u('kkey', 'ulang')} < {min(1.0, per / max(1, int(con.execute('SELECT count(*) FROM kb WHERE fid IN (SELECT fid FROM pelaku)').fetchone()[0])))}"
    shift = "(3 + hash(kkey || 'geser') % 8)::INT" if hard else "0"
    con.execute(f"""CREATE OR REPLACE TEMP TABLE tambah AS
SELECT * REPLACE (kunjungan_fkrtl_id || '-U' AS kunjungan_fkrtl_id, tgl_datang + {shift} AS tgl_datang, tgl_pulang + {shift} AS tgl_pulang,
                  0 AS biaya_verifikasi_rp, true AS flag_selisih_verifikasi), 'klaim_berulang' AS modus
FROM kb WHERE fid IN (SELECT fid FROM pelaku) AND kkey NOT IN (SELECT kkey FROM pilih) AND {rep_pick}""")
    # phantom: easy = one template claim per facility copied; hard = the facility's own claims resampled
    con.execute("CREATE OR REPLACE TEMP TABLE pelaku_n AS SELECT fid, count(*) AS n FROM kb WHERE fid IN (SELECT fid FROM pelaku) GROUP BY 1")
    total_pel = int(con.execute("SELECT sum(n) FROM pelaku_n").fetchone()[0] or 1)
    if hard:
        con.execute(f"""INSERT INTO tambah
SELECT * REPLACE (kunjungan_fkrtl_id || '-F' AS kunjungan_fkrtl_id, (800000000 + hash(kkey || 'pasien') % 100000000)::BIGINT AS peserta_id,
                  0 AS biaya_verifikasi_rp, true AS flag_selisih_verifikasi), 'phantom_billing' AS modus
FROM kb WHERE fid IN (SELECT fid FROM pelaku) AND {_u('kkey', 'fiktif')} < {min(1.0, per / total_pel)}""")
    else:
        con.execute(f"""INSERT INTO tambah
WITH t AS (SELECT DISTINCT ON (fid) * FROM kb WHERE fid IN (SELECT fid FROM pelaku) AND tarif_inacbg_rp > 0 ORDER BY fid, {_u('kkey', 'templat')}),
     c AS (SELECT t.*, unnest(range(greatest(1, round(pn.n * {per / total_pel})::INT))) AS i FROM t JOIN pelaku_n pn USING (fid))
SELECT * EXCLUDE (i) REPLACE (kunjungan_fkrtl_id || '-F' || i::VARCHAR AS kunjungan_fkrtl_id,
                              (800000000 + hash(kkey || i::VARCHAR) % 100000000)::BIGINT AS peserta_id,
                              0 AS biaya_verifikasi_rp, true AS flag_selisih_verifikasi), 'phantom_billing' AS modus
FROM c""")
    con.execute("INSERT INTO modus SELECT edisi || ':' || kunjungan_fkrtl_id, modus FROM tambah")
    con.execute("INSERT INTO ki SELECT * EXCLUDE (modus) FROM tambah")
    # the rule flags as a real pipeline recomputes them
    con.execute("""CREATE OR REPLACE TEMP TABLE ki AS
WITH p99 AS (SELECT inacbg_kode, quantile_cont(los_hari, 0.99) AS p99 FROM ki WHERE tingkat_pelayanan = 'RITL' GROUP BY 1)
SELECT ki.* REPLACE (
  count(*) OVER (PARTITION BY edisi, peserta_id, fid, tgl_datang, inacbg_kode) > 1 AS flag_calon_klaim_ganda,
  coalesce(ki.tingkat_pelayanan = 'RITL' AND ki.los_hari > p99.p99, false) AS flag_los_ekstrem)
FROM ki LEFT JOIN p99 USING (inacbg_kode)""")
    counts = dict(con.execute("SELECT modus, count(*) FROM modus GROUP BY 1").fetchall())
    total = int(con.execute("SELECT count(*) FROM ki").fetchone()[0])
    log(f"{condition}: {sum(counts.values()):,} klaim fraud ditanam di {int(con.execute('SELECT count(*) FROM pelaku').fetchone()[0])} profil faskes "
        f"({100 * sum(counts.values()) / total:.2f}% dari {total:,}), {time.time() - t0:.0f} s")
    return {"kondisi": condition, **c, "klaim": total, "fraud": sum(counts.values()), "per_modus": counts,
            "profil_pelaku": int(con.execute("SELECT count(*) FROM pelaku").fetchone()[0])}


# ------------------------------------------------------------------------------------------------
# the run: every condition, and the hold-outs at baseline (detector: ml_klaim's supervised pipeline)
# ------------------------------------------------------------------------------------------------

DETECTOR = "HistGradientBoosting"  # in the top tier of the real-label benchmark (statistically equal to the best), the fastest of it
FOLDS = 3
CAPACITY = 0.01


def _oof(con: Any, holdout: str | None = None, log: Callable[[str], None] = print, models: list | None = None) -> Any:
    """Out-of-fold scores of every planted-data claim: facilities in FOLDS folds, the detector trained on the other
    facilities' sample (all planted + 1 in 10 legitimate). With `holdout`, that type's claims are REMOVED from training
    (not relabelled as legitimate) and stay in the test folds. `models` collects each fold's model (fold order)."""
    import numpy as np

    import ml_klaim as M

    data = M.evaluation_set(con, "semua")
    mod = dict(con.execute("SELECT klaim_id, modus FROM modus").fetchall())
    data["modus"] = data["klaim_id"].map(mod)
    fold_of = M.facility_folds(con, FOLDS, SEED)
    data["lipatan"] = data["faskes_profil_id"].map(fold_of)
    values = ", ".join(f"('{k}', {v})" for k, v in fold_of.items())
    con.execute(f"CREATE OR REPLACE TEMP TABLE lipatan AS SELECT * FROM (VALUES {values}) t(faskes_profil_id, lipatan)")
    keep = ["klaim_id", "faskes_profil_id", "y", "excess_rp", "jenis_fkrtl", "tipe_fkrtl", "provinsi_nama", "inacbg_kode", "frek_dx", "biaya_tagih",
            "f_jumlah_klaim", "edisi", "flag_ganda", "flag_los_ekstrem"]
    cols = list(dict.fromkeys(keep + M.FEATURES))
    parts = []
    for f in range(FOLDS):
        train = data[(data["lipatan"] != f) & ((data["modus"] != holdout) | data["modus"].isna())] if holdout else data[data["lipatan"] != f]
        train = M._train_part(train, np.random.default_rng(SEED + f))
        enc = M.Encoder().fit(train)
        model, _, sec = M.fit_predict(DETECTOR, train, [], enc, SEED)
        seg = {"model": model, "enc": enc, "name": DETECTOR, "beta": M.TRAIN_NEG / M.NEG_SAMPLE}
        if models is not None:
            models.append(seg)
        for batch in con.execute(f"SELECT {', '.join(cols)} FROM fitur JOIN lipatan USING (faskes_profil_id) WHERE lipatan = {f}").to_arrow_reader(500_000):
            df = batch.to_pandas()
            df["score"] = M.predict(seg, df)
            parts.append(df[keep + ["score"]])
        log(f"  lipatan {f + 1}/{FOLDS}{' (tanpa ' + holdout + ')' if holdout else ''}: {len(train):,} baris latih, {sec:.0f} s")
    import pandas as pd

    out = pd.concat(parts, ignore_index=True)
    out["modus"] = out["klaim_id"].map(mod)
    return out


def _placebo(con: Any, models: list, threshold: float, spill: Any, HS: Any, log: Callable[[str], None] = print) -> dict[str, Any]:
    """The kit's placebo (stress.placebo): the baseline's fold models score the claims with the fraud switched off (kb,
    the real hospital claims before planting; each facility by the model of its fold, table lipatan) against the planted
    data's cut-off at capacity, so every claim flagged is a false alarm. Leaves `fitur` on the clean claims: the next
    condition's prepare() rebuilds it."""
    from pathlib import Path

    import pandas as pd

    import ml_klaim as M

    Path(spill).mkdir(parents=True, exist_ok=True)
    M.prepare(con, "kb", log=lambda m: None, spill=str(spill))
    cols = list(dict.fromkeys(["klaim_id", "faskes_profil_id"] + M.FEATURES))
    parts = []
    for f, seg in enumerate(models):
        for batch in con.execute(f"SELECT {', '.join(cols)} FROM fitur JOIN lipatan USING (faskes_profil_id) WHERE lipatan = {f}").to_arrow_reader(500_000):
            df = batch.to_pandas()
            parts.append(pd.DataFrame({"entity_id": df["klaim_id"], "group_id": df["faskes_profil_id"], "score": M.predict(seg, df)}))
    res = HS.placebo(pd.concat(parts, ignore_index=True), threshold)
    log(f"plasebo: {res['flagged']:,} dari {res['n']:,} klaim tanpa fraud melewati ambang kapasitas ({res['flagged_groups']} dari {res['groups']} profil faskes)")
    return {**res, "porsi": res["flagged"] / max(res["n"], 1)}


def run(con: Any, kit_dir: str, out_dir: Any, log: Callable[[str], None] = print, n_boot: int = 300) -> dict[str, Any]:
    """Every condition's evidence card (kit, Bahasa Indonesia) and per-type recall@k; at baseline, each type held out
    and the placebo (the same claims with no fraud planted)."""
    import json
    import sys
    from pathlib import Path

    import numpy as np
    import pandas as pd

    import ml_klaim as M

    sys.path.insert(0, kit_dir)
    from hkeval import metrics as HM, report as HR, stress as HS

    out = Path(out_dir)
    (out / "work").mkdir(parents=True, exist_ok=True)  # prepare() spills the feature table here
    n = base(con)
    log(f"basis: {n:,} klaim rumah sakit nyata (tanpa klaim yang benar-benar dikoreksi)")
    results: dict[str, Any] = {"spesifikasi": {"modus": MODUS, "kondisi": CONDITIONS, "klaster": CLUSTER, "seed": SEED, "detektor": DETECTOR,
                                               "lipatan": FOLDS, "kapasitas": CAPACITY}, "kondisi": {}, "tahan": {}}
    for name in CONDITIONS:
        info = plant(con, name, log)
        M.prepare(con, "ki", log=lambda m: None, spill=str(out / "work"))
        models: list = []
        df = _oof(con, log=log, models=models)
        df["kelas"] = df["jenis_fkrtl"].astype(str) + " · " + df["tipe_fkrtl"].astype(str)
        scores = df[["klaim_id", "faskes_profil_id", "score", "kelas"]].rename(columns={"klaim_id": "entity_id", "faskes_profil_id": "group_id"})
        truth = pd.DataFrame({"entity_id": df["klaim_id"], "label": df["y"].astype(int), "modus": df["modus"], "excess_rupiah": df["excess_rp"]})
        conditions = {"data_source": "klaim rumah sakit nyata (Data Sampel BPJS 2025) dengan fraud yang ditanam",
                      "benchmark": f"benchmark aturan 2, kondisi '{name}': {info['kesulitan']}, frekuensi {info['frekuensi']:.1%}, {info['klaster']}",
                      "generator_author": "generator ml_sintetis.py, spesifikasi di-commit sebelum output detektor dilihat",
                      "calibration_sources": "tarif INA-CBG, LOS dan tambahan dari data nyata; besaran pergeseran (kesulitan) dikarang",
                      "seed": str(SEED)}
        card = HR.build_card(scores, truth, capacity=CAPACITY, strata=["kelas"], conditions=conditions, entity_noun="klaim",
                             group_noun="profil faskes", n_boot=n_boot)
        (out / f"aturan2_{name}.html").write_text(HR.render_html(card, "id"), "utf-8")
        (out / f"aturan2_{name}.md").write_text(HR.render_markdown(card, "id"), "utf-8")
        y, s = truth["label"].to_numpy(), scores["score"].to_numpy()
        per = HM.per_modus_recall_at_k(y, s, truth["modus"].fillna("").to_numpy(), CAPACITY)
        k = HM.n_top(len(s), CAPACITY)
        results["kondisi"][name] = {**info, "k": k, "acak_k_per_n": k / len(s), "kartu": HR.card_to_json(card),
                                    "recall_per_modus": json.loads(per.to_json(orient="records")),
                                    "pr_auc": HM.pr_auc(y, s), "roc_auc": HM.roc_auc(y, s)}
        log(f"{name}: precision@k {card['headline']['precision']:.3f}, lift {card['headline']['lift']:.1f}x, PR-AUC {results['kondisi'][name]['pr_auc']:.3f}")
        if name == "baseline":
            for m in MODUS:
                d = _oof(con, holdout=m, log=log)
                ys, ss = d["y"].to_numpy(), d["score"].to_numpy()
                kk = HM.n_top(len(ss), CAPACITY)
                top = np.zeros(len(ss), bool)
                top[HM.top_k(ss, CAPACITY)] = True
                is_m = (d["modus"] == m).to_numpy()
                full = next((r for r in results["kondisi"]["baseline"]["recall_per_modus"] if r["modus"] == m), {})
                results["tahan"][m] = {"label": MODUS[m]["label"], "kasus": int(is_m.sum()), "tertangkap": int((top & is_m).sum()),
                                       "recall_at_k": float((top & is_m).sum() / max(is_m.sum(), 1)), "acak_k_per_n": kk / len(ss),
                                       "recall_bila_dilatih": full.get("recall"), "precision_at_k": float(ys[top].mean())}
                log(f"tahan {m}: recall@k {results['tahan'][m]['recall_at_k']:.3f} (acak {kk / len(ss):.3f}; bila dilatih {full.get('recall')})")
            # (inside work/: the job copies its outputs without that folder)
            results["plasebo"] = {**_placebo(con, models, HS.threshold_at_capacity(s, CAPACITY), out / "work" / "bersih", HS, log), "k_tanam": k}
        (out / "aturan2.json").write_text(json.dumps(results, default=float, ensure_ascii=False), "utf-8")
    return results
