"""The production pipeline of the claim-fraud detection (Pipeline Produksi): data in → validated → features → scored →
packaged → published → tagged → quarantined, end to end without a notebook, with a gate after every stage.

The BPJS Kesehatan × BINUS guidance ("Paradigma Eksperimen vs Production Pipeline"): a notebook does not
take asynchronous load or external requests; a production pipeline automates Data Masuk → Proses → Output; and keeps
stable through strict validation that stops performance from degrading. Here:

  1 data_masuk  the silver claims' current version (Files item, size): the run is keyed by it, so a version is processed
                once unless asked again
  2 validasi    the data contract (KONTRAK): columns and types, key uniqueness, missing values, ranges, category domains,
                label consistency, volume against the last good run — a failed blocking check stops the pipeline
  3 fitur       the features (ml_klaim.prepare, cached per source version), their contract (finite, non-negative counts)
                and drift against the deployed model's reference (PSI per feature; >= 0.25 on a top feature blocks)
  4 skor        the deployed (champion) model scores every claim with its deployed thresholds; the flagged share and the
                score distribution against the reference (PSI) are checked
  5 kinerja     out-of-time performance when labelled claims newer than the training data exist (AUPRC and precision
                at the operating point against the model card: a relative drop of 30% blocks); the monthly in-sample
                precision of the flagged claims as a trend
  6 paket       the model packaged in the deployment formats: .pkl (joblib) and .onnx (CatBoost's own exporter,
                onnxmltools for LightGBM / XGBoost, skl2onnx for scikit-learn), with its signature (features, order,
                category codes, prior correction, threshold) and a parity check (onnxruntime against the native model on
                2,000 real claims, max |Δp| <= 1e-4) — a model whose ONNX does not match is served from .pkl; .h5 is the
                Keras weight format and does not apply (no Keras network)
  7 toko_fitur  the feature store the online service reads (reference statistics per INA-CBG code and diagnosis,
                facility features, each member's history)
  then, in the API process, as the user who ran it: the scores published (Files, versions, Nexus), the auto-tagger and
  the quarantine box rebuilt, the deployment switched to this run (the online service: aip/layanan.py)

Runs start by hand (admin), on a schedule, or when a new version of the silver claims appears (the watcher). A run's
record keeps every stage: status, time, counts, each check with its value and threshold, artifacts.

    GET  /api/aip/produksi                  status: deployment, last runs, schedule, contract, thresholds
    POST /api/aip/produksi/jalankan         a run now (admin)
    GET  /api/aip/produksi/runs/{id}        one run with its stages and checks
    PUT  /api/aip/produksi/jadwal           the schedule (admin): on/off, every N hours, on new data
    GET  /api/aip/produksi/artefak/{name}   the deployed model.onnx_<segmen> / model.pkl / signature.json
"""

from __future__ import annotations

import contextvars
import json
import logging
import math
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip/produksi")
log = logging.getLogger("aip.produksi")

PSI_WARN, PSI_BLOCK = 0.10, 0.25
PARITY_TOL = 1e-4
PERF_DROP = 0.30  # relative drop of AUPRC / precision that blocks
SAMPLE = 400_000  # claims sampled for the drift statistics
TOP_FEATURES = 10  # the model's most important features: drift there blocks
WATCH_SECONDS = 600

# the data contract of the silver claims (kunjungan_fkrtl): the columns the pipeline relies on and their types
COLUMNS = {"edisi": "VARCHAR", "peserta_id": "BIGINT", "kunjungan_fkrtl_id": "VARCHAR", "tgl_datang": "DATE", "tgl_pulang": "DATE",
           "kabkota_fkrtl_kode": "INTEGER", "provinsi_fkrtl": "VARCHAR", "kabkota_fkrtl": "VARCHAR", "kepemilikan_fkrtl": "VARCHAR",
           "jenis_fkrtl": "VARCHAR", "tipe_fkrtl": "VARCHAR", "tingkat_pelayanan": "VARCHAR", "poli": "VARCHAR", "segmen": "VARCHAR",
           "kelas_rawat": "VARCHAR", "status_pulang": "VARCHAR", "dx_primer_icd3": "VARCHAR", "inacbg_kode": "VARCHAR", "inacbg_cmg": "VARCHAR",
           "inacbg_tipe_kasus": "VARCHAR", "inacbg_keparahan": "VARCHAR", "regional_tarif": "VARCHAR", "prosedur": "VARCHAR",
           "tarif_inacbg_rp": "BIGINT", "sa_tarif_rp": "BIGINT", "sp_tarif_rp": "BIGINT", "rr_tarif_rp": "BIGINT", "si_tarif_rp": "BIGINT",
           "sd_tarif_rp": "BIGINT", "biaya_tagih_rp": "BIGINT", "biaya_verifikasi_rp": "BIGINT", "los_hari": "BIGINT", "jumlah_dx_sekunder": "BIGINT",
           "flag_calon_klaim_ganda": "BOOLEAN", "flag_selisih_verifikasi": "BOOLEAN", "flag_los_ekstrem": "BOOLEAN", "layanan_covid": "BOOLEAN"}
# (id, what, SQL of the measured value over view k, the rule as a lambda on the value, the threshold text, blocking)
CHECKS = [
    ("kunci_unik", "kunci klaim (edisi + kunjungan) unik", "count(*) - count(DISTINCT edisi || ':' || kunjungan_fkrtl_id)", lambda v: v == 0, "= 0", True),
    ("kunci_terisi", "kunjungan_fkrtl_id terisi", "count(*) FILTER (WHERE kunjungan_fkrtl_id IS NULL OR edisi IS NULL)", lambda v: v == 0, "= 0", True),
    ("tanggal_terisi", "tgl_datang terisi", "count(*) FILTER (WHERE tgl_datang IS NULL)", lambda v: v == 0, "= 0", True),
    ("tanggal_urut", "tgl_pulang >= tgl_datang", "avg((tgl_pulang < tgl_datang)::INT)", lambda v: v <= 0.001, "<= 0,1%", True),
    ("biaya_terisi", "biaya_tagih_rp terisi", "avg((biaya_tagih_rp IS NULL)::INT)", lambda v: v <= 0.001, "<= 0,1%", True),
    ("biaya_non_negatif", "biaya tagih / verifikasi / tarif tidak negatif",
     "count(*) FILTER (WHERE biaya_tagih_rp < 0 OR biaya_verifikasi_rp < 0 OR tarif_inacbg_rp < 0)", lambda v: v == 0, "= 0", True),
    ("los_wajar", "lama rawat 0–400 hari", "avg((los_hari < 0 OR los_hari > 400)::INT)", lambda v: v <= 0.001, "<= 0,1%", True),
    ("jenis_domain", "jenis_fkrtl ∈ {Rumah sakit, Klinik Utama}", "avg((jenis_fkrtl NOT IN ('Rumah sakit', 'Klinik Utama') OR jenis_fkrtl IS NULL)::INT)",
     lambda v: v <= 0.001, "<= 0,1%", True),
    ("tingkat_domain", "tingkat_pelayanan ∈ {RITL, RJTL}", "avg((tingkat_pelayanan NOT IN ('RITL', 'RJTL') OR tingkat_pelayanan IS NULL)::INT)",
     lambda v: v <= 0.001, "<= 0,1%", True),
    ("inacbg_terisi", "kode INA-CBG terisi", "avg((inacbg_kode IS NULL)::INT)", lambda v: v <= 0.02, "<= 2%", True),
    ("faskes_terisi", "profil faskes inti terisi (kab/kota, kepemilikan, jenis)",
     "avg((kabkota_fkrtl_kode IS NULL OR kepemilikan_fkrtl IS NULL OR jenis_fkrtl IS NULL)::INT)", lambda v: v <= 0.001, "<= 0,1%", True),
    # tipe_fkrtl is missing for 1.54% of the 2025 sample (Klinik Utama without a recorded type, 2026-10-23): expected, watched
    ("tipe_tercatat", "tipe faskes tercatat", "avg((tipe_fkrtl IS NULL)::INT)", lambda v: v <= 0.02, "<= 2%", False),
    ("tipe_tercatat_batas", "tipe faskes tercatat (batas)", "avg((tipe_fkrtl IS NULL)::INT)", lambda v: v <= 0.05, "<= 5%", True),
    ("label_konsisten", "flag_selisih_verifikasi = (verifikasi < tagihan)",
     "avg((coalesce(flag_selisih_verifikasi, false) = (coalesce(biaya_verifikasi_rp, 0) < coalesce(biaya_tagih_rp, 0)))::INT)",
     lambda v: v >= 0.99, ">= 99%", False),
    ("verifikasi_le_tagih", "biaya verifikasi <= tagihan", "avg((biaya_verifikasi_rp > biaya_tagih_rp)::INT)", lambda v: v <= 0.01, "<= 1%", False),
]


def _dir() -> Path:
    from aip import vertex as aip_vertex

    d = aip_vertex.DIR.parent / "produksi"
    (d / "runs").mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    from aip.ml import _now as now

    return now()


def _read(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _write(path: Path, data: Any) -> None:
    from aip.runs import _write as atomic

    atomic(path, data)


class Gate(RuntimeError):
    """A blocking check failed: the pipeline stops at this stage."""


# ------------------------------------------------------------------------------------------------
# the checks (pure: run on any DuckDB connection with view k / fitur)
# ------------------------------------------------------------------------------------------------


def check(id_: str, what: str, value: Any, ok: bool, threshold: str, blocking: bool) -> dict:
    return {"id": id_, "cek": what, "nilai": value, "ambang": threshold, "status": "lulus" if ok else ("gagal" if blocking else "peringatan"),
            "blok": blocking}


def validate_source(con: Any, previous_rows: Optional[int] = None) -> list[dict]:
    """The data contract on view k: types, then every check; the volume against the last good run."""
    have = {r[0]: r[1] for r in con.execute("DESCRIBE SELECT * FROM k").fetchall()}
    missing = [c for c in COLUMNS if c not in have]
    wrong = [f"{c} ({have[c]}, harus {t})" for c, t in COLUMNS.items() if c in have and have[c] != t]
    out = [check("kolom_ada", "kolom kontrak ada", len(missing), not missing, "semua ada" + (f"; hilang: {', '.join(missing)}" if missing else ""), True),
           check("tipe_kolom", "tipe kolom sesuai kontrak", len(wrong), not wrong, "semua sesuai" + (f"; beda: {', '.join(wrong[:6])}" if wrong else ""), True)]
    if missing:
        return out
    rows = con.execute("SELECT count(*) FROM k").fetchone()[0]
    out.append(check("volume", "jumlah klaim", rows, rows > 0, "> 0", True))
    if previous_rows:
        change = rows / previous_rows - 1
        out.append(check("volume_vs_sebelumnya", "perubahan volume vs run baik terakhir", round(change, 4), abs(change) <= 0.5, "|Δ| <= 50%", False))
        out.append(check("volume_anjlok", "volume tidak anjlok", round(change, 4), change > -0.9, "> -90%", True))
    values = con.execute("SELECT " + ", ".join(f"{sql} AS {i}" for i, _w, sql, _r, _t, _b in CHECKS) + " FROM k").fetchone()
    for (i, what, _sql, rule, thr, blocking), v in zip(CHECKS, values):
        v = float(v) if v is not None else 0.0
        out.append(check(i, what, round(v, 6), bool(rule(v)), thr, blocking))
    return out


def _bins(con: Any, col: str, table: str = "s") -> list[float]:
    qs = con.execute(f"SELECT quantile_cont({col}, [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9]) FROM {table} WHERE {col} IS NOT NULL AND isfinite({col}::DOUBLE)").fetchone()[0]
    return sorted(set(float(x) for x in qs or []))


def _hist(con: Any, col: str, edges: list[float], table: str = "s") -> list[float]:
    """Shares of the values in the bins (-inf, e1], (e1, e2], …, (ek, inf), plus missing."""
    if not edges:
        rows = con.execute(f"SELECT avg(({col} IS NULL)::INT) FROM {table}").fetchone()
        return [1 - (rows[0] or 0), rows[0] or 0]
    cases = " ".join(f"WHEN {col} <= {e!r} THEN {i}" for i, e in enumerate(edges))
    got = dict(con.execute(f"SELECT CASE WHEN {col} IS NULL OR NOT isfinite({col}::DOUBLE) THEN -1 {cases} ELSE {len(edges)} END AS b, count(*) FROM {table} GROUP BY 1").fetchall())
    n = sum(got.values()) or 1
    return [got.get(i, 0) / n for i in range(len(edges) + 1)] + [got.get(-1, 0) / n]


def _cats(con: Any, col: str, table: str = "s", top: int = 30) -> dict[str, float]:
    rows = con.execute(f"SELECT coalesce({col}::VARCHAR, '∅'), count(*) FROM {table} GROUP BY 1 ORDER BY 2 DESC").fetchall()
    n = sum(c for _, c in rows) or 1
    out = {str(v): c / n for v, c in rows[:top]}
    out["(lainnya)"] = sum(c for _, c in rows[top:]) / n
    return out


def psi(ref: list[float], cur: list[float], eps: float = 1e-4) -> float:
    """Population stability index: sum over bins of (cur − ref) · ln(cur / ref)."""
    return float(sum((c - r) * math.log((c + eps) / (r + eps)) for r, c in zip(ref, cur)))


def psi_cats(ref: dict[str, float], cur: dict[str, float], eps: float = 1e-4) -> float:
    keys = set(ref) | set(cur)
    return float(sum((cur.get(k, 0) - ref.get(k, 0)) * math.log((cur.get(k, 0) + eps) / (ref.get(k, 0) + eps)) for k in keys))


def reference(con: Any, numeric: list[str], categorical: list[str], table: str = "fitur") -> dict:
    """The distribution a model is deployed against: deciles per numeric feature, shares per category (a sample)."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE s AS SELECT {', '.join(numeric + categorical)} FROM {table} USING SAMPLE {SAMPLE} ROWS (reservoir, 42)")
    ref = {"numerik": {}, "kategori": {}}
    for c in numeric:
        edges = _bins(con, c)
        ref["numerik"][c] = {"tepi": edges, "porsi": _hist(con, c, edges)}
    for c in categorical:
        ref["kategori"][c] = _cats(con, c)
    return ref


def drift(con: Any, ref: dict, table: str = "fitur") -> list[dict]:
    """PSI of each feature of the current data against the reference."""
    cols = list(ref["numerik"]) + list(ref["kategori"])
    con.execute(f"CREATE OR REPLACE TEMP TABLE s AS SELECT {', '.join(cols)} FROM {table} USING SAMPLE {SAMPLE} ROWS (reservoir, 42)")
    out = []
    for c, r in ref["numerik"].items():
        out.append({"fitur": c, "jenis": "numerik", "psi": round(psi(r["porsi"], _hist(con, c, r["tepi"])), 5)})
    for c, r in ref["kategori"].items():
        out.append({"fitur": c, "jenis": "kategori", "psi": round(psi_cats(r, _cats(con, c)), 5)})
    return sorted(out, key=lambda x: -x["psi"])


def drift_checks(rows: list[dict], top: set[str], prefix: str = "drift") -> list[dict]:
    out = []
    for r in rows:
        blocking = r["fitur"] in top
        ok = r["psi"] < (PSI_BLOCK if blocking else PSI_WARN)
        level = "lulus" if r["psi"] < PSI_WARN else ("gagal" if blocking and r["psi"] >= PSI_BLOCK else "peringatan")
        out.append({"id": f"{prefix}_{r['fitur']}", "cek": f"PSI {r['fitur']}" + (" (fitur teratas model)" if blocking else ""), "nilai": r["psi"],
                    "ambang": f"< {PSI_WARN} lulus; >= {PSI_BLOCK} {'gagal' if blocking else 'peringatan'}", "status": level, "blok": blocking and not ok})
    return out


# ------------------------------------------------------------------------------------------------
# the deployment formats: .pkl and .onnx with a parity check
# ------------------------------------------------------------------------------------------------


def to_onnx(model: Any, name: str, n_features: int, path: Path) -> str:
    """The model as ONNX (raw probability of class 1 in the output). Returns the converter used; raises when the model
    type has none (the .pkl stays the format then)."""
    if name == "CatBoost":
        model.save_model(str(path), format="onnx", export_parameters={"onnx_domain": "ai.catboost", "onnx_model_version": 1,
                                                                      "onnx_doc_string": "risiko koreksi klaim BPJS", "onnx_graph_name": "RisikoKlaim"})
        return "catboost (save_model format=onnx)"
    if name in ("LightGBM", "XGBoost"):
        import onnxmltools
        from onnxmltools.convert.common.data_types import FloatTensorType as MlFloat  # (onnxmltools wants its own type class)

        types = [("input", MlFloat([None, n_features]))]
        if name == "LightGBM":
            onx = onnxmltools.convert_lightgbm(model, initial_types=types, target_opset=15, zipmap=False)
            conv = "onnxmltools.convert_lightgbm"
        else:
            onx = onnxmltools.convert_xgboost(model, initial_types=types, target_opset=15)
            conv = "onnxmltools.convert_xgboost"
    elif name in ("HistGradientBoosting", "Random Forest", "Extra Trees"):
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType

        onx = convert_sklearn(model, initial_types=[("input", FloatTensorType([None, n_features]))], target_opset=15,
                              options={id(model): {"zipmap": False}})
        conv = "skl2onnx.convert_sklearn"
    else:
        raise NotImplementedError(f"tidak ada konverter ONNX untuk {name} (pipeline dengan transformasi kustom / glassbox): disajikan dari .pkl")
    path.write_bytes(onx.SerializeToString())
    return conv


def onnx_proba(session: Any, X: Any) -> Any:
    """P(class 1) from an ONNX classifier's outputs (a [n, 2] tensor, or a list of {class: p} maps)."""
    import numpy as np

    name = session.get_inputs()[0].name
    outs = session.run(None, {name: np.asarray(X, dtype=np.float32)})
    for o in outs:
        if isinstance(o, np.ndarray) and o.ndim == 2 and o.shape[1] == 2 and o.dtype.kind == "f":
            return o[:, 1].astype(float)
        if isinstance(o, list) and o and isinstance(o[0], dict):
            return np.array([float(d.get(1, d.get("1", 0.0))) for d in o])
    raise ValueError("keluaran ONNX tidak memuat probabilitas kelas")


def package(segments: dict, frames: dict[str, Any], out: Path, say: Any) -> dict:
    """model.pkl (joblib), model_<segment>.onnx, signature.json; parity of each ONNX against the native model."""
    import joblib
    import numpy as np
    import onnxruntime as ort

    import ml_klaim as M

    out.mkdir(parents=True, exist_ok=True)
    cols = M.columns_of(segments)  # the models' own columns (a model trained before a change of FEATURES keeps its own)
    bundle = {"segments": segments, "labels": M.LABELS, "features": cols}
    joblib.dump(bundle, out / "model.pkl", compress=3)
    sig: dict[str, Any] = {"format": {"pkl": "joblib (scikit-learn / CatBoost / LightGBM native)", "onnx": "onnxruntime, opset 15 / CatBoost domain",
                                      "h5": "tidak berlaku: format bobot Keras/TensorFlow; model ini bukan jaringan Keras"},
                           "fitur": cols, "numerik": [c for c in cols if not any(c in s["enc"].maps for s in segments.values())],
                           "kategori": [c for c in cols if any(c in s["enc"].maps for s in segments.values())],
                           "rumus": "p_populasi = beta·q / (beta·q + 1 − q), q = probabilitas kelas 1 dari model; ditandai bila p_populasi >= ambang",
                           "kategori_tak_dikenal": -1, "segmen": {}}
    checks = []
    for seg, s in segments.items():
        info: dict[str, Any] = {"model": s["name"], "tugas": s["task"], "beta": s["beta"], "ambang": s["threshold"],
                                "kode_kategori": {c: s["enc"].maps[c] for c in s["enc"].cat_cols}, "segmen_sql": M.SEGMENTS[seg][1],
                                "fitur": s["enc"].columns}
        path = out / f"model_{seg}.onnx"
        try:
            info["onnx_konverter"] = to_onnx(s["model"], s["name"], len(s["enc"].columns), path)
            sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            df = frames[seg]
            X = s["enc"].transform(df)
            native = s["model"].predict_proba(X)[:, 1]
            onx = onnx_proba(sess, X.to_numpy(np.float32))
            diff = float(np.max(np.abs(native - onx))) if len(df) else 0.0
            info.update(onnx=path.name, onnx_bytes=path.stat().st_size, paritas_max_abs=diff, paritas_n=len(df), onnx_input=sess.get_inputs()[0].name)
            ok = diff <= PARITY_TOL
            checks.append(check(f"paritas_onnx_{seg}", f"ONNX = model asli ({s['name']}, {len(df):,} klaim nyata)", diff, ok, f"max |Δp| <= {PARITY_TOL}", False))
            info["disajikan_dari"] = "onnx" if ok else "pkl"
            say(f"paket {seg}: {s['name']} → ONNX ({info['onnx_konverter']}), paritas max |Δp| = {diff:.2e} pada {len(df):,} klaim")
        except Exception as e:  # noqa: BLE001 - served from the pickle; the stage says why
            path.unlink(missing_ok=True)
            info.update(onnx=None, onnx_error=f"{type(e).__name__}: {str(e)[:300]}", disajikan_dari="pkl")
            checks.append(check(f"paritas_onnx_{seg}", f"ekspor ONNX ({s['name']})", info["onnx_error"], False, "konverter tersedia", False))
            say(f"paket {seg}: ONNX tidak dibuat ({info['onnx_error'][:160]}): disajikan dari .pkl")
        sig["segmen"][seg] = info
    (out / "signature.json").write_text(json.dumps(sig, ensure_ascii=False, default=float), "utf-8")
    checks.append(check("pkl", "model.pkl (joblib) tersimpan dan dapat dimuat", (out / "model.pkl").stat().st_size,
                        bool(joblib.load(out / "model.pkl")["segments"]), "dapat dimuat", True))
    return {"signature": sig, "checks": checks}


# ------------------------------------------------------------------------------------------------
# the job (python -m aip.ml job.json, kind "produksi")
# ------------------------------------------------------------------------------------------------


def run_job(spec: dict, out: Path, say: Any) -> dict:
    """Stages 1–7 in the job's process; the report says where it stopped. A blocking failure raises Gate after the
    report is written (the record keeps every stage up to it)."""
    import numpy as np
    import pandas as pd

    import ml_klaim as M
    from aip import ml as aip_ml

    stages: list[dict] = []
    report: dict[str, Any] = {"tahap": stages, "mulai": _now(), "sumber": spec.get("source_key"), "model_versi": spec.get("model_version")}

    def finish(status: str) -> dict:
        report.update(status=status, selesai=_now())
        (out / "laporan.json").write_text(json.dumps(report, default=float, ensure_ascii=False), "utf-8")
        return report

    def stage(sid: str, label: str) -> dict:
        st = {"id": sid, "label": label, "mulai": _now(), "status": "berjalan", "cek": [], "t0": time.time()}
        stages.append(st)
        say(f"tahap {sid}: {label}")
        return st

    def close(st: dict, **extra: Any) -> None:
        bad = [c for c in st["cek"] if c["status"] == "gagal"]
        warn = [c for c in st["cek"] if c["status"] == "peringatan"]
        st.update(status="gagal" if bad else "peringatan" if warn else "lulus", detik=round(time.time() - st.pop("t0"), 1), selesai=_now(), **extra)
        say(f"tahap {st['id']}: {st['status']} ({len(st['cek'])} cek, {len(bad)} gagal, {len(warn)} peringatan, {st['detik']} s)")
        if bad:
            finish("gagal")
            raise Gate(f"tahap {st['id']} gagal: " + "; ".join(f"{c['cek']} = {c['nilai']} (ambang {c['ambang']})" for c in bad[:5]))

    ref_dir = Path(spec["reference_dir"])
    work = Path(spec["out"]).parent / "work"
    # 1 data in
    st = stage("data_masuk", "Data masuk: versi klaim Data Bersih")
    con = aip_ml._con(spec["source"], work, spec.get("wilayah"))
    rows, dmin, dmax, editions = con.execute("SELECT count(*), min(tgl_datang), max(tgl_datang), count(DISTINCT edisi) FROM k").fetchone()
    st["cek"].append(check("sumber_terbaca", "dataset Data Bersih terbaca", rows, rows > 0, "> 0 baris", True))
    close(st, baris=rows, tanggal=[str(dmin), str(dmax)], edisi=editions, versi_sumber=spec.get("source_key"))
    # 2 the data contract
    st = stage("validasi", "Validasi data (kontrak)")
    st["cek"] = validate_source(con, spec.get("previous_rows"))
    close(st, baris=rows)
    # 3 features + their contract + drift
    st = stage("fitur", "Rekayasa fitur dan drift")
    con = aip_ml._features(spec, say)
    nfit = con.execute("SELECT count(*) FROM fitur").fetchone()[0]
    st["cek"].append(check("fitur_lengkap", "setiap klaim punya fitur", nfit, nfit == rows, f"= {rows:,} baris data", True))
    cols = {r[0] for r in con.execute("DESCRIBE SELECT * FROM fitur").fetchall()}
    lacking = [c for c in M.FEATURES if c not in cols]
    st["cek"].append(check("fitur_kontrak", f"{len(M.FEATURES)} fitur model ada", len(lacking), not lacking, "semua ada" + (f"; hilang {lacking}" if lacking else ""), True))
    inf = con.execute("SELECT " + " + ".join(f"count(*) FILTER (WHERE NOT isfinite({c}::DOUBLE))" for c in M.NUM) + " FROM fitur").fetchone()[0]
    st["cek"].append(check("fitur_hingga", "nilai fitur numerik hingga (bukan inf)", int(inf or 0), not inf, "= 0", True))
    neg = con.execute("SELECT count(*) FROM fitur WHERE " + " OR ".join(f"{c} < 0" for c in ("frek_kode", "frek_dx", "kunjungan_peserta", "kembar", "f_jumlah_klaim")))\
        .fetchone()[0]
    st["cek"].append(check("fitur_cacah", "fitur cacah tidak negatif", int(neg), not neg, "= 0", True))
    ref_file = ref_dir / "referensi.json"
    ref = _read(ref_file)
    numeric = [c for c in M.NUM if c not in ("bulan", "hari", "provinsi_kode")]
    baseline = ref is None
    if baseline:
        ref = reference(con, numeric, [c for c in M.CAT_LOW if c != "edisi"])
        ref.update(dibuat=_now(), sumber=spec.get("source_key"), tgl_maks=str(dmax))
        say("referensi drift dibuat dari data ini (run pertama untuk versi model ini)")
    rows_drift = drift(con, ref)
    top = set(spec.get("top_features") or [])
    st["cek"] += drift_checks(rows_drift, top)
    close(st, fitur=len(M.FEATURES), drift=rows_drift[:60], baseline_baru=baseline)
    # 4 scoring with the deployed model
    st = stage("skor", "Skoring model terpasang")
    import pickle

    bundle = pickle.loads(Path(spec["model_pkl"]).read_bytes())
    segments = bundle["segments"]
    dist: dict[str, Any] = {}
    klaim, fas, fitur_top = aip_ml.score_all(con, segments, say, fixed=True, dist=dist)
    score_ref = ref.get("skor")
    for seg, s in segments.items():
        p = dist.get(seg)
        if p is None or not len(p):
            continue
        share = float((p >= s["threshold"]).mean())
        ratio = share / max(s["share"], 1e-9)
        st["cek"].append(check(f"porsi_ditandai_{seg}", f"porsi klaim ditandai {seg} vs saat dipasang ({s['share']:.4%})", round(ratio, 3),
                               0.5 <= ratio <= 2.0, "0,5–2× porsi validasi", False))
        st["cek"].append(check(f"porsi_ditandai_ekstrem_{seg}", f"porsi ditandai {seg} tidak ekstrem", round(ratio, 3), 0.1 <= ratio <= 5.0, "0,1–5×", True))
        edges = np.unique(np.quantile(p, np.linspace(0.1, 0.9, 9))).tolist()
        hist = np.histogram(p, bins=[-np.inf, *edges, np.inf])[0] / len(p)
        if baseline or not score_ref or seg not in score_ref:
            ref.setdefault("skor", {})[seg] = {"tepi": edges, "porsi": hist.tolist()}
        else:
            r = score_ref[seg]
            cur = np.histogram(p, bins=[-np.inf, *r["tepi"], np.inf])[0] / len(p)
            v = psi(r["porsi"], cur.tolist())
            st["cek"].append(check(f"psi_skor_{seg}", f"PSI distribusi skor {seg}", round(v, 5), v < PSI_BLOCK, f"< {PSI_BLOCK}", True))
    if baseline:
        ref_dir.mkdir(parents=True, exist_ok=True)
        (out / "referensi.json").write_text(json.dumps(ref, default=float, ensure_ascii=False), "utf-8")
    flagged = int(klaim["ditandai"].sum())
    close(st, klaim_disimpan=len(klaim), ditandai=flagged, lolos_verifikasi=int(klaim["lolos_verifikasi_berisiko"].sum()), faskes=len(fas))
    # 5 performance: out-of-time when there are newer labelled claims, else the in-sample monthly trend
    st = stage("kinerja", "Kinerja model (degradasi)")
    cutoff = ref.get("tgl_maks") or str(dmax)
    card = spec.get("card") or {}
    newer = con.execute(f"SELECT count(*), coalesce(sum(y), 0) FROM fitur WHERE tgl_datang > DATE '{cutoff}'").fetchone()
    perf: dict[str, Any] = {"batas_latih": cutoff, "klaim_baru": int(newer[0]), "positif_baru": int(newer[1])}
    if newer[0] >= 1000 and newer[1] >= 20:
        from sklearn.metrics import average_precision_score

        cols_needed = list(dict.fromkeys(M.ID_COLS + M.columns_of(segments) + ["jenis_fkrtl"]))
        new = con.execute(f"SELECT {', '.join(cols_needed)} FROM fitur WHERE tgl_datang > DATE '{cutoff}'").df()
        for seg, (task, sql) in M.SEGMENTS.items():
            part = new.query("jenis_fkrtl == 'Rumah sakit'") if seg == "rumah_sakit" else new.query("jenis_fkrtl != 'Rumah sakit'")
            if part["y"].sum() < 10:
                continue
            p = M.predict(segments[seg], part)
            ap = float(average_precision_score(part["y"], p))
            base = (card.get(task) or {}).get("auprc")
            perf[seg] = {"auprc": ap, "auprc_kartu": base, "n": len(part), "positif": int(part["y"].sum())}
            if base:
                drop = 1 - ap / base
                st["cek"].append(check(f"auprc_{seg}", f"AUPRC out-of-time {seg} vs kartu model ({base:.3f})", round(ap, 4), drop <= PERF_DROP,
                                       f"turun <= {PERF_DROP:.0%}", True))
    else:
        st["cek"].append(check("data_baru_berlabel", "klaim berlabel setelah data latih (uji out-of-time)", int(newer[0]), True,
                               "belum ada: kinerja out-of-time dinilai saat data baru masuk", False))
    trend = con.execute("""SELECT strftime(tgl_datang, '%Y-%m') AS bulan, count(*) AS klaim FROM fitur GROUP BY 1 ORDER BY 1""").df()
    flagged_m = klaim[klaim["ditandai"]].assign(bulan=lambda d: pd.to_datetime(d["tgl_datang"]).dt.strftime("%Y-%m")).groupby("bulan").agg(
        ditandai=("klaim_id", "size"), dikoreksi=("sudah_dikoreksi", "sum")).reset_index()
    trend = trend.merge(flagged_m, on="bulan", how="left").fillna(0)
    trend["presisi_ditandai"] = (trend["dikoreksi"] / trend["ditandai"].where(trend["ditandai"] > 0)).round(4)
    perf["tren_bulanan"] = json.loads(trend.tail(36).to_json(orient="records"))
    perf["catatan"] = "tren bulanan in-sample (model dilatih dengan data ini): pemantauan, bukan bukti kinerja"
    close(st, kinerja=perf)
    # 6 packaging
    st = stage("paket", "Paket model: .pkl dan .onnx (+ paritas)")
    frames = {}
    for seg, (task, sql) in M.SEGMENTS.items():
        # (the sample is drawn from the segment: a sample clause beside WHERE samples the table first)
        frames[seg] = con.execute(f"SELECT * FROM (SELECT {', '.join(M.columns_of(segments))} FROM fitur WHERE {sql}) USING SAMPLE 2000 ROWS (reservoir, 7)").df()
    pk = package(segments, frames, out / "paket", say)
    st["cek"] += pk["checks"]
    close(st, paket={seg: {k: v for k, v in i.items() if k != "kode_kategori"} for seg, i in pk["signature"]["segmen"].items()},
          format=pk["signature"]["format"])
    # 7 the feature store for the online service
    st = stage("toko_fitur", "Penyimpanan fitur untuk layanan online")
    fs = out / "toko_fitur"
    fs.mkdir(parents=True, exist_ok=True)
    sqls = {
        "ref_kode": "SELECT inacbg_kode, median(los) AS med_los, quantile_cont(los, 0.9) AS p90_los, median(tarif_inacbg) AS med_tarif, count(*) AS frek_kode "
                    "FROM fitur GROUP BY 1",
        "ref_dx": "SELECT dx_primer_icd3, avg((inacbg_keparahan LIKE 'Berat%')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL') AS p_berat_dx, "
                  "avg((inacbg_tipe_kasus LIKE 'Prosedur%')::INT) AS p_prosedur_dx, count(*) AS frek_dx FROM fitur GROUP BY 1",
        "faskes": "SELECT faskes_profil_id, " + ", ".join(f"any_value({c}) AS {c}" for c in M.FASKES) + " FROM fitur GROUP BY 1",
        "peserta": "SELECT edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode, count(*) AS n FROM fitur GROUP BY ALL",
        # reference text (not features): the INA-CBG code's group and the diagnosis' name, for requests that send only codes
        "kode_inacbg": "SELECT inacbg_kode, mode(inacbg_cmg) AS inacbg_cmg, mode(inacbg_tipe_kasus) AS inacbg_tipe_kasus, mode(inacbg_keparahan) AS inacbg_keparahan, "
                       "mode(inacbg_deskripsi) AS inacbg_deskripsi FROM k WHERE inacbg_kode IS NOT NULL GROUP BY 1",
        "dx_nama": "SELECT dx_primer_icd3, mode(dx_primer_nama) AS dx_primer_nama FROM k WHERE dx_primer_icd3 IS NOT NULL GROUP BY 1",
        # by the full code (I210): the category's name above is one subcode's (I21 → subendocardial), wrong for I21.0
        "dx_kode_nama": "SELECT dx_primer_kode, mode(dx_primer_nama) AS dx_primer_nama FROM k WHERE dx_primer_kode IS NOT NULL GROUP BY 1",
    }
    sizes = {}
    for name, sql in sqls.items():
        con.execute(f"COPY ({sql}) TO '{(fs / (name + '.parquet')).as_posix()}' (FORMAT parquet)")
        sizes[name] = con.execute(f"SELECT count(*) FROM read_parquet('{(fs / (name + '.parquet')).as_posix()}')").fetchone()[0]
    st["cek"].append(check("toko_fitur", "tabel penyimpanan fitur terisi", sizes, all(v > 0 for v in sizes.values()), "> 0 baris tiap tabel", True))
    # training-serving parity: real claims through the online path (contract, point-in-time features) against the batch
    from aip import layanan

    par = layanan.online_parity(con, {n: (fs / f"{n}.parquet").as_posix() for n in ("ref_kode", "ref_dx", "faskes")}, work, segments)
    st["cek"].append(check("paritas_fitur_online", f"fitur online = fitur batch ({par['dibandingkan']} klaim nyata, fitur terburuk {par['fitur_terburuk'][0][0]})",
                           round(par["fitur_cocok_min"], 4), par["fitur_cocok_min"] >= 0.98, ">= 98% klaim cocok untuk setiap fitur", True))
    if par["skor_max_abs"] is not None:
        st["cek"].append(check("paritas_skor_online", "skor online = skor batch", par["skor_max_abs"], par["skor_max_abs"] <= 1e-3, "max |Δp| <= 0,001", False))
    st["cek"].append(check("kontrak_permintaan", "klaim nyata lolos kontrak permintaan API", par["lolos_kontrak"], par["jumlah_ditolak"] <= 0.02 * max(par["klaim"], 1),
                           "ditolak <= 2%", False))
    close(st, tabel=sizes, paritas=par)
    # outputs for the registration in the API process
    klaim.to_parquet(out / "klaim.parquet", index=False)
    fas.to_parquet(out / "faskes.parquet", index=False)
    fitur_top.to_parquet(out / "fitur_klaim.parquet", index=False)
    finish("lulus_tahap_job")
    return {"laporan": report}


# ------------------------------------------------------------------------------------------------
# in the API process: start, register, publish, deploy
# ------------------------------------------------------------------------------------------------


def _last_good() -> Optional[dict]:
    for f in sorted((_dir() / "runs").glob("*/run.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        r = _read(f, {})
        if r.get("status") == "lulus":
            return r
    return None


def deployed() -> Optional[dict]:
    return _read(_dir() / "deployed.json")


def start(trigger: str = "manual") -> dict:
    """A pipeline run as a job (aip/ml.py runs it in a subprocess, registers it here)."""
    from aip import ml as aip_ml

    cur = aip_ml.current()
    if not cur:
        raise HTTPException(409, "belum ada model terlatih: latih model ML dulu (tab ML Studio)")
    vdir = aip_ml._dir() / "versions" / cur["version"]
    rep = _read(vdir / "report.json", {})
    top = []
    for t in (rep.get("tugas") or {}).values():
        top += [g["fitur"] for g in t.get("kepentingan_global") or []][:TOP_FEATURES]
    card = {task: {"auprc": next((x["rata"]["auprc"]["mean"] for x in t["papan"] if x["model"] == t["terbaik"]), None)} for task, t in (rep.get("tugas") or {}).items()}
    prev = _last_good()
    extra = {"reference_dir": str(_dir() / "referensi" / cur["version"]), "model_pkl": str(vdir / "model.pkl"), "model_version": cur["version"],
             "top_features": sorted(set(top)), "card": card, "previous_rows": ((prev or {}).get("ringkasan") or {}).get("baris"), "trigger": trigger}
    job = aip_ml._start("produksi", {"pemicu": trigger}, extra)
    run = {"id": job["id"], "job": job["id"], "status": "berjalan", "pemicu": trigger, "mulai": job["created_at"], "model_versi": cur["version"],
           "user_id": job.get("user_id")}
    d = _dir() / "runs" / job["id"]
    d.mkdir(parents=True, exist_ok=True)
    _write(d / "run.json", run)
    return run


def register(job: dict, src: dict, out: Path, res: dict) -> dict:
    """The job passed its gates: publish the scores, rebuild tags and the box, switch the deployment to this run."""
    from aip import indikasi, karantina
    from aip import ml as aip_ml

    d = _dir() / "runs" / job["id"]
    d.mkdir(parents=True, exist_ok=True)
    rep = res["laporan"]
    for name in ("paket", "toko_fitur"):
        if (out / name).exists():
            shutil.copytree(out / name, d / name, dirs_exist_ok=True)
    if (out / "referensi.json").exists():
        ref_dir = Path(job["extra"]["reference_dir"])
        ref_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out / "referensi.json", ref_dir / "referensi.json")
    t0 = time.time()
    st = {"id": "publikasi", "label": "Publikasi skor (Files, versi, Nexus)", "mulai": _now(), "cek": []}
    folder = aip_ml._out_folder()
    items = {"klaim": aip_ml._put_dataset(folder, aip_ml.DS_KLAIM, (out / "klaim.parquet").read_bytes(), src),
             "faskes": aip_ml._put_dataset(folder, aip_ml.DS_FASKES, (out / "faskes.parquet").read_bytes(), src)}
    try:
        nexus = aip_ml.ensure_nexus(items)
        st["cek"].append(check("nexus", "objek Nexus diimpor ulang", len(nexus.get("types") or {}), True, "tipe skor ML", False))
    except Exception as e:  # noqa: BLE001 - the datasets are written; the Nexus view is retried at the next run
        st["cek"].append(check("nexus", "objek Nexus diimpor ulang", str(getattr(e, "detail", None) or e)[:200], False, "berhasil", False))
    st.update(status="lulus" if all(c["status"] == "lulus" for c in st["cek"]) else "peringatan", detik=round(time.time() - t0, 1), selesai=_now(),
              datasets=items)
    rep["tahap"].append(st)
    t0 = time.time()
    st = {"id": "indikasi", "label": "Penandaan indikasi dan box karantina", "mulai": _now(), "cek": []}
    tags = indikasi.autotag(log.info)
    box = karantina.build(log.info)
    st["cek"].append(check("tag", "penanda otomatis berjalan", tags["total_tag"], tags["total_tag"] > 0, "> 0 tag", False))
    st.update(status="lulus", detik=round(time.time() - t0, 1), selesai=_now(), tag=tags, karantina={k: box[k] for k in ("faskes", "total_estimasi_kerugian_rp")})
    rep["tahap"].append(st)
    dep = {"run": job["id"], "pada": _now(), "model_versi": job["extra"]["model_version"], "paket": str(d / "paket"), "toko_fitur": str(d / "toko_fitur"),
           "signature": _read(d / "paket" / "signature.json"), "sumber": rep.get("sumber")}
    _write(_dir() / "deployed.json", dep)
    rep["tahap"].append({"id": "deploy", "label": "Deploy ke layanan online", "status": "lulus", "mulai": _now(), "selesai": _now(), "detik": 0,
                         "cek": [check("deploy", "layanan online memakai paket run ini", job["id"], True, "-", False)]})
    rep.update(status="lulus", selesai=_now())
    _write(d / "laporan.json", rep)
    return {"laporan": rep, "deploy": {k: dep[k] for k in ("run", "model_versi", "pada")}}


def _summary(rep: dict) -> dict:
    st = {s["id"]: s for s in rep.get("tahap") or []}
    return {"status": rep.get("status"), "tahap": [{"id": s["id"], "status": s["status"], "detik": s.get("detik")} for s in rep.get("tahap") or []],
            "baris": (st.get("data_masuk") or {}).get("baris"), "ditandai": (st.get("skor") or {}).get("ditandai"),
            "gagal": [c for s in rep.get("tahap") or [] for c in s.get("cek") or [] if c["status"] == "gagal"][:10],
            "peringatan": sum(c["status"] == "peringatan" for s in rep.get("tahap") or [] for c in s.get("cek") or [])}


def on_job_end(job: dict, out: Optional[Path], res: Optional[dict], error: Optional[str]) -> None:
    """The run record from its job (called by aip/ml.py's runner whatever happened)."""
    d = _dir() / "runs" / job["id"]
    d.mkdir(parents=True, exist_ok=True)
    run = _read(d / "run.json", {"id": job["id"], "job": job["id"], "mulai": job.get("created_at")})
    rep = (res or {}).get("laporan") if res else None
    if rep is None and out is not None:
        rep = _read(out / "laporan.json")
    if rep is not None and not (d / "laporan.json").exists():
        _write(d / "laporan.json", rep)
    run.update(status="lulus" if not error and rep and rep.get("status") == "lulus" else "gagal", selesai=_now(), error=error,
               ringkasan=_summary(rep or {}))
    _write(d / "run.json", run)


# ------------------------------------------------------------------------------------------------
# Data Lineage (lineage.py calls this after the Nexus types are in the graph)
# ------------------------------------------------------------------------------------------------


def lineage(g: Any) -> None:
    """The fraud system in Data Lineage: the silver claims and the deployed model feed the production pipeline, which
    writes the score datasets, the model package (.pkl / .onnx) and the feature store the online scoring service reads;
    the Nexus objects feed the auto-tagger and the 100-agent consultancy, which write the tag and quarantine datasets
    (and their Nexus types, through their backing datasets). Only what exists is drawn."""
    from aip import indikasi as I
    from aip import ml as aip_ml
    from aip import semantik as S

    cur = aip_ml.current()
    if not cur:
        return
    try:
        aip_ml._source()  # drawn only for a caller who can read the claims behind it
    except HTTPException:
        return
    runs = [r for r in (_read(f, {}) for f in sorted((_dir() / "runs").glob("*/run.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:1])]
    last = runs[0] if runs else None
    dep = deployed()
    pid = g.node("aip:produksi", "pipeline", "Pipeline Produksi Deteksi Fraud (AIP)",
                 subtitle=f"run terakhir: {last['status']}" if last else "belum dijalankan", updated_at=(last or {}).get("selesai"),
                 stages=["data_masuk", "validasi", "fitur", "skor", "kinerja", "paket", "toko_fitur", "publikasi", "indikasi", "deploy"])
    if cur.get("source_item"):
        g.edge(g.dataset(cur["source_item"]), pid, "input")
    wil = aip_ml._wilayah()
    if wil:  # the provinces of the scores (38-province coding)
        g.edge(g.dataset(wil["id"]), pid, "input")
    mid = f"model:{(cur.get('model') or {}).get('model_id')}"
    if mid in g.nodes:
        g.edge(mid, pid, "deploys")
    for item in (cur.get("datasets") or {}).values():
        g.edge(pid, g.dataset(item), "scores")
    if dep:
        segs = (dep.get("signature") or {}).get("segmen") or {}
        served = ", ".join(f"{s}: {i.get('model')} ({i.get('disajikan_dari')})" for s, i in segs.items())
        pk = g.node("aip:paket", "model", "Paket model fraud (.pkl + .onnx)", link="/aip-jkn?tab=ml", subtitle=served or None, updated_at=dep.get("pada"))
        fs = g.node("aip:toko_fitur", "virtual", "Penyimpanan fitur fraud (feature store)",
                    subtitle="referensi kode & diagnosis, fitur faskes, riwayat peserta", updated_at=dep.get("pada"))
        sv = g.node("aip:layanan", "function", "Layanan skoring fraud (API /api/aip/fraud/v1)",
                    subtitle="sinkron + batch asinkron, onnxruntime")
        g.edge(pid, pk, "packages")
        g.edge(pid, fs, "builds")
        g.edge(pk, sv, "serves")
        g.edge(fs, sv, "input")
    types = {t["display_name"]: f"object_type:{t['id']}" for t in __import__("ontology")._all("object-types")}
    auto = g.node("aip:penanda", "automation", "Penanda otomatis (lapisan semantik)", link="/aip-jkn?tab=konsultan",
                  subtitle="aturan Permenkes 16/2019 + sinyal model", updated_at=((I._state().get("otomatis")) or {}).get("pada"))
    firm = g.node("aip:konsultan", "agent", "AI Agent Swarm (100 agen)", link="/aip-jkn?tab=konsultan",
                  subtitle="partner, manajer, analis, penyidik, QA, red team")
    for name in (S.T_KLAIM, S.T_ML_KLAIM, S.T_ML_FASKES, S.T_FASKES, S.T_KAB, S.T_INDIKATOR, S.T_RUJUKAN, S.T_PESERTA):
        if types.get(name) in g.nodes:
            g.edge(types[name], auto, "reads")
            g.edge(types[name], firm, "reads")
    ds = ((I._state().get("nexus")) or {}).get("datasets") or {}
    for key, label in (("tags", "tags"), ("box", "quarantines")):
        if ds.get(key):
            out = g.dataset(ds[key])
            g.edge(auto, out, label)
            g.edge(firm, out, label)
    for key in ("tax", "meas"):
        if ds.get(key):
            g.edge(g.node("aip:semantik", "reference", "Lapisan semantik AIP (ukuran, tag, istilah)", link="/aip-jkn?tab=konsultan",
                          subtitle=f"versi {S.VERSION}"), g.dataset(ds[key]), "defines")
    if "aip:semantik" in g.nodes:
        g.edge("aip:semantik", auto, "informs")
        g.edge("aip:semantik", firm, "informs")


# ------------------------------------------------------------------------------------------------
# the schedule and the watcher (new data → a run)
# ------------------------------------------------------------------------------------------------


def _schedule() -> dict:
    return _read(_dir() / "jadwal.json", {"aktif": False, "jam": 24, "saat_data_baru": True})


def _watch() -> None:
    """Every WATCH_SECONDS: when the schedule is on and the silver claims have a new version (or the interval passed),
    a run as the schedule's owner."""
    import auth

    from aip import ml as aip_ml

    while True:
        time.sleep(WATCH_SECONDS)
        try:
            sch = _schedule()
            if not sch.get("aktif") or not sch.get("pemilik"):
                continue
            token = auth._principal.set(auth.principal_of(sch["pemilik"]) if auth.enabled() else None)
            try:
                src = aip_ml._source()
                key = f"{src['id']}-{src.get('size_bytes') or 0}"
                last = _last_good() or {}
                due = sch.get("jam") and (time.time() - (sch.get("terakhir_ts") or 0)) > sch["jam"] * 3600
                new_data = sch.get("saat_data_baru") and (last.get("sumber") not in (None, key))
                running = any(j["status"] == "running" for j in aip_ml._jobs.values())
                if (due or new_data) and not running:
                    run = start("data_baru" if new_data else "jadwal")
                    _write(_dir() / "jadwal.json", {**sch, "terakhir_ts": time.time(), "terakhir_run": run["id"]})
            finally:
                auth._principal.reset(token)
        except Exception:  # noqa: BLE001 - the watcher keeps watching
            log.exception("produksi: watcher")


_watcher: dict[str, Any] = {}


def ensure_watcher() -> None:
    if not _watcher.get("t"):
        t = threading.Thread(target=contextvars.Context().run, args=(_watch,), daemon=True, name="produksi-watcher")
        _watcher["t"] = t
        t.start()


router.add_event_handler("startup", ensure_watcher)


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


def _admin() -> dict:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "pipeline produksi butuh admin")
    return p


@router.get("")
def status() -> dict:
    from aip import ml as aip_ml

    aip_ml._source()
    runs = []
    for f in sorted((_dir() / "runs").glob("*/run.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
        r = _read(f, {})
        job = aip_ml._jobs.get(r.get("id")) or {}
        if r.get("status") == "berjalan" and job:
            r["log"] = job.get("log", [])[-6:]
        runs.append(r)
    dep = deployed()
    return {"deploy": {k: v for k, v in (dep or {}).items() if k != "signature"} if dep else None,
            "signature": {s: {k: v for k, v in i.items() if k != "kode_kategori"} for s, i in ((dep or {}).get("signature") or {}).get("segmen", {}).items()},
            "format": ((dep or {}).get("signature") or {}).get("format"), "runs": runs, "jadwal": {k: v for k, v in _schedule().items() if k != "pemilik"},
            "kontrak": {"kolom": COLUMNS, "cek": [{"id": i, "cek": w, "ambang": t, "blok": b} for i, w, _s, _r, t, b in CHECKS]},
            "ambang": {"psi_peringatan": PSI_WARN, "psi_blok": PSI_BLOCK, "paritas_onnx": PARITY_TOL, "penurunan_kinerja": PERF_DROP}}


@router.post("/jalankan")
def run_now() -> dict:
    _admin()
    return start("manual")


@router.get("/runs/{rid}")
def get_run(rid: str) -> dict:
    from aip import ml as aip_ml

    aip_ml._job_path(rid)  # the id's shape
    d = _dir() / "runs" / rid
    run = _read(d / "run.json")
    if not run:
        raise HTTPException(404, "run tidak ada")
    rep = _read(d / "laporan.json")
    job = aip_ml._jobs.get(rid) or {}
    return {**run, "laporan": rep, "log": (job.get("log") or [])[-40:]}


class ScheduleIn(BaseModel):
    aktif: bool
    jam: int = Field(24, ge=1, le=24 * 30)
    saat_data_baru: bool = True


@router.put("/jadwal")
def set_schedule(req: ScheduleIn) -> dict:
    p = _admin()
    sch = {**_schedule(), **req.model_dump(), "pemilik": p.get("id"), "diubah": _now()}
    _write(_dir() / "jadwal.json", sch)
    return {k: v for k, v in sch.items() if k != "pemilik"}


ARTIFACTS = {"model.pkl": "application/octet-stream", "signature.json": "application/json"}


@router.get("/artefak/{name}")
def artifact(name: str):
    """The deployed package's files (model.pkl, model_<segmen>.onnx, signature.json): admin."""
    from fastapi.responses import FileResponse

    _admin()
    dep = deployed()
    if not dep:
        raise HTTPException(404, "belum ada deploy")
    allowed = dict(ARTIFACTS, **{f"model_{s}.onnx": "application/octet-stream" for s in (dep.get("signature") or {}).get("segmen", {})})
    if name not in allowed:
        raise HTTPException(404, "artefak tidak dikenal")
    f = Path(dep["paket"]) / name
    if not f.is_file():
        raise HTTPException(404, "artefak tidak ada di paket ini")
    return FileResponse(f, media_type=allowed[name], filename=name)
