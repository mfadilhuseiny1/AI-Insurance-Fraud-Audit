"""The online fraud-scoring service (Layanan skoring fraud): the production pipeline's deployed package, served to
external requests — synchronously for a few claims, as a background batch for many.

    GET  /api/aip/fraud/v1/sehat           health: the deployment (run, model, formats), the feature store, the traffic
    GET  /api/aip/fraud/v1/kontrak         the request contract (JSON Schema) and the model signature
    POST /api/aip/fraud/v1/skor            score up to 500 new claims now
    POST /api/aip/fraud/v1/batch           score up to 50,000 claims in the background → {id}
    GET  /api/aip/fraud/v1/batch/{id}      the batch's status, progress and results (pages)
    POST /api/aip/fraud/v1/verify          one claim through the judges' six-stage inference pipeline (model + LLM review)
    POST /api/aip/fraud/v1/verify/csv      a CSV of claims through /verify in the background → {id}  (templat: GET /verify/csv/templat)
    POST /api/aip/fraud/v1/verify/batch    a JSON list of claims, the same
    GET  /api/aip/fraud/v1/verify/batch/{id}            progress and results; /baris/{no} one claim's answer; /unduh the CSV

A claim comes in the silver claims' own fields (the data contract at the boundary: strict types and ranges, closed sets
where the data has them, unknown fields refused). Its features are computed as the batch pipeline computes them, from
the feature store the pipeline wrote — the reference statistics of its INA-CBG code and diagnosis, its facility's
features, the member's history — at the claim's point in time (the batch counts a member's visits over the whole
edition; online counts those before and in this request: the one documented difference). Then onnxruntime scores it
(the package's ONNX; the .pkl when an ONNX failed its parity check), the probability goes back on the population's scale,
the deployed threshold flags it, TreeSHAP of the native model explains it, and the semantic layer's claim-level rules tag
it. Every request is logged (claims, latency, flagged, unknown categories) for the service's health.

Who may call: whoever can read the claims the model was trained on (session or `Authorization: Bearer bsai_pat_…`).
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import logging
import math
import re
import threading
import time
import uuid
from datetime import date
from pathlib import Path
from typing import Any, Callable, Literal, Optional, Union

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from aip import produksi as P

router = APIRouter(prefix="/api/aip/fraud/v1")
log = logging.getLogger("aip.layanan")

SYNC_MAX, BATCH_MAX = 500, 50_000
STORE = ("ref_kode", "ref_dx", "faskes", "peserta", "kode_inacbg", "dx_nama", "dx_kode_nama")  # the feature store's tables (the last three: reference text)
CHUNK = 500
CONCURRENT = 4  # synchronous requests scored at once; more wait up to WAIT seconds, then 429
WAIT = 5.0
_sem = threading.BoundedSemaphore(CONCURRENT)
_lock = threading.Lock()
_cache: dict[str, Any] = {}
_batches: dict[str, dict] = {}
_pool = None


class KlaimIn(BaseModel):
    """One FKRTL claim, in the fields of the silver claims (kunjungan_fkrtl)."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    kunjungan_fkrtl_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    edisi: str = Field("reguler", min_length=1, max_length=40, pattern=r"^[a-z_]+$")
    peserta_id: int = Field(ge=0)
    tgl_datang: date
    tgl_pulang: Optional[date] = None
    kabkota_fkrtl_kode: int = Field(ge=1100, le=9999)
    kepemilikan_fkrtl: str = Field(min_length=1, max_length=80)
    jenis_fkrtl: Literal["Rumah sakit", "Klinik Utama"]
    tipe_fkrtl: Optional[str] = Field(None, max_length=80)
    tingkat_pelayanan: Literal["RITL", "RJTL"]
    poli: Optional[str] = Field(None, max_length=80)
    segmen: Optional[str] = Field(None, max_length=80)
    kelas_rawat: Optional[str] = Field(None, max_length=40)
    status_pulang: Optional[str] = Field(None, max_length=80)
    dx_primer_icd3: str = Field(pattern=r"^[A-Z][0-9]{2}$")
    inacbg_kode: str = Field(pattern=r"^[A-Z]-[0-9]-[0-9]{2}-[0IV]+$")
    inacbg_cmg: Optional[str] = Field(None, max_length=120)
    inacbg_tipe_kasus: Optional[str] = Field(None, max_length=120)
    inacbg_keparahan: Optional[str] = Field(None, max_length=80)
    regional_tarif: Optional[str] = Field(None, max_length=40)
    prosedur: Optional[str] = Field(None, max_length=8000)  # every procedure of the claim: up to 1,942 characters in the 2025 sample
    tarif_inacbg_rp: Optional[int] = Field(None, ge=0, le=10_000_000_000)
    sa_tarif_rp: int = Field(0, ge=0, le=10_000_000_000)
    sp_tarif_rp: int = Field(0, ge=0, le=10_000_000_000)
    rr_tarif_rp: int = Field(0, ge=0, le=10_000_000_000)
    si_tarif_rp: int = Field(0, ge=0, le=10_000_000_000)
    sd_tarif_rp: int = Field(0, ge=0, le=10_000_000_000)
    biaya_tagih_rp: int = Field(ge=0, le=10_000_000_000)
    los_hari: Optional[int] = Field(None, ge=0, le=400)
    jumlah_dx_sekunder: Optional[int] = Field(None, ge=0, le=60)
    flag_calon_klaim_ganda: bool = False
    flag_los_ekstrem: bool = False
    layanan_covid: bool = False
    # clinical text of the silver claims: not model features, what the clinical review (LLM) reads
    dx_masuk_kode: Optional[str] = Field(None, max_length=16)
    dx_masuk_nama: Optional[str] = Field(None, max_length=300)
    dx_primer_kode: Optional[str] = Field(None, max_length=16)
    dx_primer_nama: Optional[str] = Field(None, max_length=300)
    inacbg_deskripsi: Optional[str] = Field(None, max_length=300)
    sa_kode: Optional[str] = Field(None, max_length=40)
    sp_kode: Optional[str] = Field(None, max_length=40)
    sp_deskripsi: Optional[str] = Field(None, max_length=300)
    rr_kode: Optional[str] = Field(None, max_length=40)
    rr_deskripsi: Optional[str] = Field(None, max_length=300)
    si_kode: Optional[str] = Field(None, max_length=40)
    si_deskripsi: Optional[str] = Field(None, max_length=300)
    sd_kode: Optional[str] = Field(None, max_length=40)
    sd_deskripsi: Optional[str] = Field(None, max_length=300)
    kabkota_fkrtl: Optional[str] = Field(None, max_length=120)
    provinsi_fkrtl: Optional[str] = Field(None, max_length=120)

    @model_validator(mode="after")
    def _dates(self) -> "KlaimIn":
        if self.tgl_pulang and self.tgl_pulang < self.tgl_datang:
            raise ValueError("tgl_pulang sebelum tgl_datang")
        return self


class SkorIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    klaim: list[KlaimIn] = Field(min_length=1, max_length=SYNC_MAX)
    alasan: bool = True  # TreeSHAP reasons (a few ms a claim)
    mesin: Literal["pkl", "onnx"] = "pkl"  # the deployed pickle (default) or its ONNX


class BatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    klaim: list[KlaimIn] = Field(min_length=1, max_length=BATCH_MAX)
    alasan: bool = False


# ------------------------------------------------------------------------------------------------
# the deployed package, loaded once per deployment
# ------------------------------------------------------------------------------------------------


def _package() -> dict:
    dep = P.deployed()
    if not dep:
        raise HTTPException(503, "belum ada paket model yang di-deploy: jalankan pipeline produksi (POST /api/aip/produksi/jalankan)")
    with _lock:
        if _cache.get("run") == dep["run"]:
            return _cache
        import joblib
        import onnxruntime as ort

        paket, fs = Path(dep["paket"]), Path(dep["toko_fitur"])
        bundle = joblib.load(paket / "model.pkl")
        sessions = {}
        for seg, info in (dep.get("signature") or {}).get("segmen", {}).items():
            if info.get("disajikan_dari") == "onnx" and info.get("onnx") and (paket / info["onnx"]).is_file():
                sessions[seg] = ort.InferenceSession(str(paket / info["onnx"]), providers=["CPUExecutionProvider"])
        _cache.clear()
        # the tables this deployment has (a table added to the pipeline arrives with its next run)
        _cache.update(run=dep["run"], dep=dep, bundle=bundle, sessions=sessions,
                      store={n: (fs / f"{n}.parquet").as_posix() for n in STORE if (fs / f"{n}.parquet").is_file()})
        return _cache


def profile_id(c: KlaimIn) -> str:
    """The facility profile key, as the batch computes it: md5 of concat_ws('|', 'FKRTL', kab/kota, ownership, kind, type)
    (concat_ws leaves out what is missing)."""
    parts = ["FKRTL", str(c.kabkota_fkrtl_kode) if c.kabkota_fkrtl_kode else None, c.kepemilikan_fkrtl, c.jenis_fkrtl, c.tipe_fkrtl]
    return hashlib.md5("|".join(p for p in parts if p is not None).encode("utf-8")).hexdigest()


def features(claims: list[KlaimIn], store: dict[str, str], con: Any = None, extra_history: Optional[str] = None) -> Any:
    """The model's features of new claims at their point in time, from the feature store (one DuckDB query).

    con: a connection that already holds the feature tables (ref_kode, ref_dx, faskes, peserta) — the realtime engine
    keeps one open (aip/realtime/mesin.py) instead of opening the parquet files per request. extra_history: the name of
    a table/view in that connection with more member history in the peserta table's columns (the realtime stream's own
    claims, scored before this request), counted as history exactly like the store's rows."""
    import duckdb
    import pandas as pd

    import ml_klaim as M

    def num(v: Optional[int]) -> float:  # missing stays missing, as in the batch (a NULL cast to DOUBLE)
        return float(v) if v is not None else float("nan")

    rows = []
    for n, c in enumerate(claims):
        topup = c.sa_tarif_rp + c.sp_tarif_rp + c.rr_tarif_rp + c.si_tarif_rp + c.sd_tarif_rp
        rows.append({"_i": n, "klaim_id": f"{c.edisi}:{c.kunjungan_fkrtl_id}", "faskes_profil_id": profile_id(c), "edisi": c.edisi, "peserta_id": c.peserta_id,
                     "tgl_datang": c.tgl_datang, "biaya_tagih": float(c.biaya_tagih_rp), "tarif_inacbg": num(c.tarif_inacbg_rp), "tarif_tambahan": float(topup),
                     "komponen_tambahan": sum(v > 0 for v in (c.sa_tarif_rp, c.sp_tarif_rp, c.rr_tarif_rp, c.si_tarif_rp, c.sd_tarif_rp)),
                     "los": num(c.los_hari), "dx_sekunder": num(c.jumlah_dx_sekunder), "ada_prosedur": int(c.prosedur is not None),
                     "flag_ganda": int(c.flag_calon_klaim_ganda), "flag_los_ekstrem": int(c.flag_los_ekstrem), "bulan": c.tgl_datang.month,
                     "hari": (c.tgl_datang.weekday() + 1) % 7, "provinsi_kode": (c.kabkota_fkrtl_kode // 100) if c.kabkota_fkrtl_kode else None,
                     "layanan_covid": c.layanan_covid,
                     "dx_primer_icd3": c.dx_primer_icd3, "inacbg_kode": c.inacbg_kode,
                     **{col: (getattr(c, col) if getattr(c, col, None) is not None else "tidak tercatat") for col in M.CAT_ALL if col != "edisi"}})
    req = pd.DataFrame(rows)
    own = con is None
    if own:
        con = duckdb.connect()
        for name in ("ref_kode", "ref_dx", "faskes", "peserta"):  # the feature tables (the store's others are reference text)
            con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{store[name]}')")
    con.register("req", req)
    hist_cols = "edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode, n"
    peserta_src = f"(SELECT {hist_cols} FROM peserta UNION ALL SELECT {hist_cols} FROM {extra_history})" if extra_history else "peserta"
    f_cols = M.FASKES
    df = con.execute(f"""
WITH r AS (SELECT * FROM req),
hist AS (
  SELECT r._i,
         coalesce(sum(p.n), 0) AS h_peserta,
         coalesce(sum(p.n) FILTER (WHERE p.faskes_profil_id = r.faskes_profil_id), 0) AS h_faskes,
         coalesce(sum(p.n) FILTER (WHERE p.faskes_profil_id = r.faskes_profil_id AND p.tgl_datang = r.tgl_datang AND p.inacbg_kode = r.inacbg_kode), 0) AS h_kembar,
         max(p.tgl_datang) FILTER (WHERE p.faskes_profil_id = r.faskes_profil_id AND p.tgl_datang <= r.tgl_datang) AS h_terakhir
  FROM r LEFT JOIN {peserta_src} p ON p.edisi = r.edisi AND p.peserta_id = r.peserta_id
  GROUP BY r._i),
inreq AS (  -- the other claims of the same request count too (they are part of the history at this point); an unknown member has none
  SELECT a._i, count(b._i) AS q_peserta,
         count(b._i) FILTER (WHERE b.faskes_profil_id = a.faskes_profil_id) AS q_faskes,
         count(b._i) FILTER (WHERE b.faskes_profil_id = a.faskes_profil_id AND b.tgl_datang = a.tgl_datang AND b.inacbg_kode = a.inacbg_kode) AS q_kembar,
         max(b.tgl_datang) FILTER (WHERE b.faskes_profil_id = a.faskes_profil_id AND (b.tgl_datang < a.tgl_datang OR (b.tgl_datang = a.tgl_datang AND b._i < a._i))) AS q_terakhir
  FROM r a LEFT JOIN r b ON a.edisi = b.edisi AND a.peserta_id = b.peserta_id AND a._i <> b._i GROUP BY a._i)
SELECT r.* EXCLUDE (_i),
       r.biaya_tagih / nullif(r.tarif_inacbg + r.tarif_tambahan, 0) AS rasio_tagih_tarif,
       r.biaya_tagih - r.tarif_inacbg - r.tarif_tambahan AS selisih_tagih_tarif,
       r.los / nullif(k.med_los, 0) AS idx_los, (r.los > k.p90_los)::INT AS los_di_atas_p90, r.tarif_inacbg / nullif(k.med_tarif, 0) AS idx_tarif_kode,
       coalesce(k.frek_kode, 0) AS frek_kode, k.med_los, k.p90_los, k.med_tarif, d.p_berat_dx, d.p_prosedur_dx, coalesce(d.frek_dx, 0) AS frek_dx,
       h.h_peserta + i.q_peserta + 1 AS kunjungan_peserta, h.h_faskes + i.q_faskes + 1 AS kunjungan_peserta_faskes,
       h.h_kembar + i.q_kembar + 1 AS kembar,
       coalesce(date_diff('day', greatest(h.h_terakhir, i.q_terakhir), r.tgl_datang), 9999) AS hari_sejak_sebelumnya,
       {', '.join(f'f.{c}' for c in f_cols)}, (f.faskes_profil_id IS NULL) AS faskes_baru, (k.inacbg_kode IS NULL) AS kode_baru
FROM r LEFT JOIN ref_kode k USING (inacbg_kode) LEFT JOIN ref_dx d USING (dx_primer_icd3) LEFT JOIN faskes f USING (faskes_profil_id)
JOIN hist h USING (_i) JOIN inreq i USING (_i) ORDER BY r._i""").df()
    if own:
        con.close()
    else:
        con.unregister("req")
    return df


def _tags(row: Any, flagged: bool) -> list[dict]:
    """The semantic layer's claim-level rules on a new claim (aip/semantik.py TAG)."""
    from aip import semantik as S

    out = []

    def tag(code: str, bukti: str) -> None:
        out.append({"tag": code, "label": S.TAG[code]["label"], "modus": S.TAG[code]["modus"], "bukti": bukti})

    if row["flag_ganda"] or row["kembar"] > 1:
        tag("KLAIM_GANDA", f"{int(row['kembar'])} klaim peserta di faskes, tanggal dan kode yang sama" if row["kembar"] > 1 else "ditandai calon klaim ganda")
    if row["tingkat_pelayanan"] == "RITL" and row["p90_los"] == row["p90_los"] and row["p90_los"] and row["los"] > 2 * row["p90_los"]:
        tag("LOS_DIPERPANJANG", f"LOS {row['los']:.0f} hari > 2× p90 kodenya ({row['p90_los']:.0f} hari)")
    base = row["tarif_inacbg"] + row["tarif_tambahan"]
    if base > 0 and row["biaya_tagih"] > 1.2 * base and not row["layanan_covid"]:
        tag("TAGIHAN_MELEBIHI_TARIF", f"tagihan {row['biaya_tagih'] / base:.2f}× tarif INA-CBG + tambahan")
    if row["tingkat_pelayanan"] == "RITL" and row["hari_sejak_sebelumnya"] <= 30:
        tag("READMISI", f"kunjungan sebelumnya di faskes ini {int(row['hari_sejak_sebelumnya'])} hari lalu")
    if flagged:
        tag("RISIKO_ML_TINGGI", "skor model di atas ambang operasional segmennya")
    return out


def infer(df: Any, pk: dict, engine: str = "pkl", reasons: bool = True) -> tuple[list[dict], dict]:
    """The model on computed features: the deployed pickle (joblib model.pkl, the AIP workflow's model) or, on request,
    its ONNX (parity-checked at packaging); the probability on the population's scale, the threshold, reasons, tags."""
    import numpy as np

    import ml_klaim as M

    out: list[Optional[dict]] = [None] * len(df)
    engines = {}
    for seg, s in pk["bundle"]["segments"].items():
        m = (df["jenis_fkrtl"] == "Rumah sakit") == (seg == "rumah_sakit")
        if not m.any():
            continue
        part = df[m]
        sess = pk["sessions"].get(seg) if engine == "onnx" else None
        if sess is not None:
            q = P.onnx_proba(sess, s["enc"].transform(part).to_numpy(np.float32))
            engines[seg] = f"onnxruntime ({Path(pk['dep']['paket']).name}/model_{seg}.onnx)"
        else:
            q = s["model"].predict_proba(M._matrix(s["name"], part, s["enc"]))[:, 1]
            engines[seg] = f"pickle (joblib: {Path(pk['dep']['paket']).name}/model.pkl)"
        p = M.prior_correct(q, s["beta"])
        why = M.reasons(s, part) if reasons else [None] * len(part)
        for (i, row), risk, r in zip(part.iterrows(), p, why):
            unknown = [c for c in s["enc"].maps if str(row[c]) not in s["enc"].maps[c] and str(row[c]) != "tidak tercatat"]
            flagged = bool(risk >= s["threshold"])
            warn = [f"kategori tidak dikenal model (diberi kode −1): {', '.join(unknown)}"] if unknown else []
            if row["faskes_baru"]:
                warn.append("faskes belum ada di penyimpanan fitur: fitur riwayat faskes kosong")
            if row["kode_baru"]:
                warn.append("kode INA-CBG belum ada di penyimpanan fitur: statistik referensi kode kosong")
            out[i] = {"klaim_id": row["klaim_id"], "faskes_profil_id": row["faskes_profil_id"], "segmen_model": seg, "model": s["name"], "mesin": engines[seg],
                      "risiko": float(risk), "risiko_pct": round(100 * float(risk), 4), "ambang": s["threshold"], "ditandai": flagged,
                      "kelipatan_ambang": round(float(risk) / s["threshold"], 3) if s["threshold"] else None,
                      "alasan": (M.reason_text(r) if r else None), "alasan_rinci": r[:5] if r else None, "indikasi": _tags(row, flagged),
                      "peringatan": warn}
    return [x for x in out if x is not None], engines


def score(claims: list[KlaimIn], reasons: bool = True, engine: str = "pkl") -> dict:
    """Features, model, threshold, reasons and tags for new claims (the synchronous path and each batch chunk)."""
    pk = _package()
    t0 = time.time()
    df = features(claims, pk["store"])
    out, engines = infer(df, pk, engine, reasons)
    ms = (time.time() - t0) * 1000
    res = {"model": {"run": pk["run"], "versi": pk["dep"].get("model_versi"), "mesin": engines}, "jumlah": len(out), "latensi_ms": round(ms, 1),
           "ditandai": sum(1 for x in out if x["ditandai"]), "hasil": out}
    _log({"t": P._now(), "n": len(out), "ms": round(ms, 1), "ditandai": res["ditandai"], "mesin": engines, "peringatan": sum(1 for x in out if x["peringatan"])})
    return res


def online_parity(con: Any, store: dict[str, str], work: Path, segments: dict, n: int = 400) -> dict:
    """Training-serving parity (the production pipeline's gate): `n` real claims, one per member, taken out of the
    members' history (as if they were new), sent through the online path from their raw silver rows — the request
    contract, the point-in-time features, the model — and compared with the batch features and scores of the same
    claims. Returns, per feature, the share that matches; the score's largest difference; contract rejections."""
    import numpy as np

    import ml_klaim as M

    hold = con.execute(f"""SELECT klaim_id FROM (SELECT klaim_id, row_number() OVER (PARTITION BY edisi, peserta_id ORDER BY hash(klaim_id)) AS r
                           FROM fitur) WHERE r = 1 ORDER BY hash(klaim_id || 'paritas') LIMIT {int(n)}""").df()["klaim_id"].tolist()
    con.execute("CREATE OR REPLACE TEMP TABLE paritas_id AS SELECT unnest(?::VARCHAR[]) AS klaim_id", [hold])
    peserta = (work / "peserta_tanpa_uji.parquet").as_posix()
    con.execute(f"""COPY (SELECT edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode, count(*) AS n FROM fitur
                    WHERE klaim_id NOT IN (SELECT klaim_id FROM paritas_id) GROUP BY ALL) TO '{peserta}' (FORMAT parquet)""")
    raw = con.execute("SELECT * FROM k WHERE edisi || ':' || kunjungan_fkrtl_id IN (SELECT klaim_id FROM paritas_id)").df()
    fields = set(KlaimIn.model_fields)
    claims, rejected = [], []
    for rec in raw.to_dict("records"):
        body = {k: (None if v is None or (isinstance(v, float) and v != v) else v) for k, v in rec.items() if k in fields}
        body["prosedur"] = rec.get("prosedur") if isinstance(rec.get("prosedur"), str) else None
        body = {k: v for k, v in body.items() if v is not None or k in ("tipe_fkrtl", "prosedur")}
        try:
            claims.append(KlaimIn.model_validate(body))
        except Exception as e:  # noqa: BLE001 - a real claim the contract refuses is reported, not hidden
            rejected.append({"klaim_id": f"{rec.get('edisi')}:{rec.get('kunjungan_fkrtl_id')}", "galat": str(e)[:300]})
    online = features(claims, {**store, "peserta": peserta}).set_index("klaim_id")
    use = M.columns_of(segments)  # the columns the models read (a model trained before a change of FEATURES reads its own)
    cats = {c for s in segments.values() for c in s["enc"].cat_cols}
    batch = con.execute(f"SELECT klaim_id, {', '.join(dict.fromkeys(use + ['jenis_fkrtl']))} FROM fitur WHERE klaim_id IN (SELECT klaim_id FROM paritas_id)").df().set_index("klaim_id")
    ids = [i for i in online.index if i in batch.index]
    match = {}
    for c in use:
        a, b = online.loc[ids, c], batch.loc[ids, c]
        if c in cats:
            same = a.astype(str).to_numpy() == b.astype(str).to_numpy()
        else:
            x, y = a.astype(float).to_numpy(), b.astype(float).to_numpy()
            same = (np.isnan(x) & np.isnan(y)) | np.isclose(x, y, rtol=1e-6, atol=1e-9, equal_nan=True)
        match[c] = float(same.mean()) if len(ids) else 0.0
    worst = sorted(match.items(), key=lambda kv: kv[1])[:8]
    diffs = []
    for seg, s in segments.items():
        m = (batch.loc[ids, "jenis_fkrtl"] == "Rumah sakit") == (seg == "rumah_sakit")
        sel = [i for i, ok in zip(ids, m) if ok]
        if sel:
            p_on = M.predict(s, online.loc[sel].reset_index())
            p_off = M.predict(s, batch.loc[sel].reset_index())
            diffs.append(float(np.max(np.abs(p_on - p_off))))
    return {"klaim": len(hold), "lolos_kontrak": len(claims), "ditolak_kontrak": rejected[:10], "jumlah_ditolak": len(rejected),
            "dibandingkan": len(ids), "fitur_cocok_min": min(match.values()) if match else 0.0, "fitur_terburuk": worst,
            "fitur_cocok_semua": sum(v == 1.0 for v in match.values()), "fitur": len(match), "skor_max_abs": max(diffs) if diffs else None}


LOG_DIR: Optional[Path] = None  # a standalone service logs next to itself


def _log(rec: dict) -> None:
    try:
        with _lock, ((LOG_DIR or P._dir()) / "layanan.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:  # noqa: BLE001 - the answer matters more than its log line
        log.exception("layanan: log")


def _caller() -> dict:
    """The caller must be able to read the claims behind the model (Files permissions)."""
    import auth

    from aip import ml as aip_ml

    aip_ml._source()
    return auth.current() or {}


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


@router.post("/skor")
def skor(req: SkorIn) -> dict:
    _caller()
    if not _sem.acquire(timeout=WAIT):
        raise HTTPException(429, f"layanan sibuk ({CONCURRENT} permintaan sedang dinilai): coba lagi, atau pakai /batch untuk banyak klaim")
    try:
        return score(req.klaim, req.alasan, req.mesin)
    finally:
        _sem.release()


def _run_batch(bid: str, claims: list[KlaimIn], reasons: bool) -> None:
    b = _batches[bid]
    path = P._dir() / "batch" / f"{bid}.jsonl"
    try:
        with path.open("w", encoding="utf-8") as f:
            for i in range(0, len(claims), CHUNK):
                res = score(claims[i: i + CHUNK], reasons)
                for x in res["hasil"]:
                    f.write(json.dumps(x, ensure_ascii=False, default=float) + "\n")
                b["selesai"] += len(res["hasil"])
                b["ditandai"] += res["ditandai"]
        b.update(status="selesai", selesai_pada=P._now())
    except Exception as e:  # noqa: BLE001 - the batch records why it stopped
        log.exception("layanan: batch %s", bid)
        b.update(status="gagal", error=str(getattr(e, "detail", None) or e)[:500], selesai_pada=P._now())
    finally:
        P._write(P._dir() / "batch" / f"{bid}.json", b)


@router.post("/batch")
def batch(req: BatchIn) -> dict:
    """Many claims in the background (an asynchronous job): poll GET /batch/{id}."""
    global _pool
    p = _caller()
    _package()  # refused now (503) rather than in the background when nothing is deployed
    with _lock:
        waiting = sum(1 for b in _batches.values() if b["status"] in ("antre", "berjalan"))
        if waiting >= 10:
            raise HTTPException(429, f"{waiting} batch sedang menunggu: coba lagi nanti")
        if _pool is None:
            from concurrent.futures import ThreadPoolExecutor

            _pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fraud-batch")
    bid = "bt-" + uuid.uuid4().hex[:12]
    (P._dir() / "batch").mkdir(parents=True, exist_ok=True)
    b = {"id": bid, "status": "berjalan", "jumlah": len(req.klaim), "selesai": 0, "ditandai": 0, "dibuat": P._now(), "user_id": p.get("id")}
    _batches[bid] = b
    import contextvars

    _pool.submit(contextvars.copy_context().run, _run_batch, bid, req.klaim, req.alasan)
    return b


@router.get("/batch/{bid}")
def batch_status(bid: str, offset: int = 0, limit: int = 100) -> dict:
    import auth

    _caller()
    if not bid.startswith("bt-") or not bid[3:].isalnum():
        raise HTTPException(400, "id batch tidak sah")
    b = _batches.get(bid) or P._read(P._dir() / "batch" / f"{bid}.json")
    p = auth.current() or {}
    if not b or (auth.enabled() and b.get("user_id") not in (p.get("id"), None) and p.get("role") != "admin"):
        raise HTTPException(404, "batch tidak ada")
    rows = []
    path = P._dir() / "batch" / f"{bid}.jsonl"
    if b["status"] == "selesai" and path.is_file():
        with path.open(encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i >= offset + min(limit, 1000):
                    break
                if i >= offset:
                    rows.append(json.loads(line))
    return {**b, "hasil": rows, "offset": offset}


@router.get("/sehat")
def health() -> dict:
    _caller()
    dep = P.deployed()
    out: dict[str, Any] = {"status": "siap" if dep else "belum di-deploy", "deploy": {k: dep.get(k) for k in ("run", "model_versi", "pada")} if dep else None}
    if dep:
        segs = (dep.get("signature") or {}).get("segmen") or {}
        out["model"] = {s: {"model": i.get("model"), "disajikan_dari": i.get("disajikan_dari"), "paritas_onnx": i.get("paritas_max_abs"), "ambang": i.get("ambang")}
                        for s, i in segs.items()}
        out["format"] = (dep.get("signature") or {}).get("format")
        fs = Path(dep["toko_fitur"])
        out["toko_fitur"] = {f.stem: f.stat().st_size for f in fs.glob("*.parquet")} if fs.is_dir() else None
    # traffic of the last 24 hours
    recs = []
    f = P._dir() / "layanan.jsonl"
    if f.is_file():
        cutoff = time.time() - 86400
        for line in f.read_text("utf-8").splitlines()[-5000:]:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if time.mktime(time.strptime(r["t"][:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone >= cutoff:
                recs.append(r)
    lat = sorted(r["ms"] / max(r["n"], 1) for r in recs)
    out["lalu_lintas_24j"] = {"permintaan": len(recs), "klaim": sum(r["n"] for r in recs), "ditandai": sum(r["ditandai"] for r in recs),
                              "ms_per_klaim_p50": lat[len(lat) // 2] if lat else None, "ms_per_klaim_p95": lat[int(len(lat) * 0.95)] if lat else None,
                              "dengan_peringatan": sum(r["peringatan"] for r in recs)}
    last = next((r for r in P.status()["runs"] if r.get("status") in ("lulus", "gagal")), None) if dep else None
    out["pipeline_terakhir"] = {k: (last or {}).get(k) for k in ("id", "status", "selesai", "pemicu")} if last else None
    return out


@router.get("/kontrak")
def contract() -> dict:
    _caller()
    dep = P.deployed() or {}
    sig = dep.get("signature") or {}
    return {"permintaan": KlaimIn.model_json_schema(), "batas": {"sinkron": SYNC_MAX, "batch": BATCH_MAX, "bersamaan": CONCURRENT},
            "signature": {"fitur": sig.get("fitur"), "rumus": sig.get("rumus"), "format": sig.get("format"),
                          "segmen": {s: {k: v for k, v in i.items() if k != "kode_kategori"} for s, i in (sig.get("segmen") or {}).items()}}}


# ------------------------------------------------------------------------------------------------
# POST /verify: the AI inference pipeline (reference architecture "Arsitektur AI Inference Pipeline")
# ------------------------------------------------------------------------------------------------


class ClaimData(KlaimIn):
    """One claim to verify: the claim's fields (the contract above), optional medical notes and the patient's age for the
    clinical review (not model features: the model was trained without them)."""
    catatan_medis: Optional[str] = Field(None, max_length=8000)
    usia: Optional[int] = Field(None, ge=0, le=120)
    pendapat_kedua: bool = False  # a second clinical opinion from another model family
    mesin: Literal["pkl", "onnx"] = "pkl"


STATUS = {"INDIKASI_KUAT": "Indikasi kuat: telaah klinis menilai mencurigakan, dan model menandai atau aturan menemukan sinyal biaya / klaim ganda / "
                           "lama rawat (dua bukti yang saling lepas)",
          "PERLU_DIPERIKSA": "Perlu diperiksa verifikator: model menandai, aturan menemukan sinyal, atau telaah klinis menemukan hal yang perlu dikonfirmasi",
          "WAJAR": "Wajar: model tidak menandai, tidak ada sinyal aturan, dan telaah klinis menilai konsisten"}
RULE_SIGNALS = {"TAGIHAN_MELEBIHI_TARIF", "KLAIM_GANDA", "LOS_DIPERPANJANG"}


def _status(flagged: bool, conclusion: Optional[str], tags: list[dict]) -> str:
    """The verdict from the model, the semantic layer's rules and the clinical review, deterministically: never "fraud"
    — an indication for a person to check. Strong when the clinical review and an independent line (the model, or a
    rule signal) agree."""
    rule = any(t.get("tag") in RULE_SIGNALS for t in tags)
    if conclusion == "mencurigakan" and (flagged or rule):
        return "INDIKASI_KUAT"
    if flagged or rule or conclusion in ("mencurigakan", "perlu_diperiksa"):
        return "PERLU_DIPERIKSA"
    return "WAJAR"


async def _verify(claim: "ClaimData", pk: dict, extra_aside: Optional[dict] = None, notes: Optional[list[str]] = None, df: Any = None,
                  via: str = "") -> dict:
    """The inference pipeline on one validated claim with a loaded package (the platform's deployment, or a standalone
    service's own): features, the pickle, the clinical review (or its deterministic fallback), the answer. `via`: where a
    claim of a batch came from (a CSV's row)."""
    import anyio

    from aip import medis

    stages = [{"tahap": "01_client_request", "keterangan": via or "JSON diterima di POST /verify (FastAPI)", "ms": 0.0},
              {"tahap": "02_schema_validation", "keterangan": "Pydantic v2: tipe, rentang, himpunan tertutup, field lengkap (ClaimData)"
               + (f"; {notes[0]}" if notes else ""), "ms": 0.0}]
    t = time.perf_counter()
    batch = df is not None
    if not batch:
        df = await anyio.to_thread.run_sync(features, [claim], pk["store"])
    stages.append({"tahap": "03_feature_engineering", "keterangan": ("fitur batch klaim ini (tabel fitur pipeline, definisi pelatihan persis)" if batch else
                   f"{len(df.columns)} kolom → 50 fitur model (rasio biaya, anomali hari rawat, keparahan, statistik kode dan diagnosis, riwayat "
                   "peserta dan faskes) dari penyimpanan fitur, pada titik waktu klaim"), "ms": round((time.perf_counter() - t) * 1000, 1)})
    t = time.perf_counter()
    res, engines = await anyio.to_thread.run_sync(infer, df, pk, claim.mesin, True)
    r = res[0]
    stages.append({"tahap": "04_ml_inference", "keterangan": f"{r['model']} · {r['mesin']}", "ms": round((time.perf_counter() - t) * 1000, 1)})
    feat = df.iloc[0].to_dict()
    ml = {"segmen": r["segmen_model"], "model": r["model"], "risiko_pct": r["risiko_pct"], "ambang_pct": round(100 * r["ambang"], 4),
          "kelipatan_ambang": r["kelipatan_ambang"], "ditandai_model": r["ditandai"], "arti_skor": "peluang klaim dikoreksi verifikator menurut model",
          "alasan_model": [{"fitur": x["label"], "nilai": x["nilai"], "umumnya": x.get("umumnya")} for x in (r["alasan_rinci"] or [])]}
    # a claim of the judges' flat format (from_juri) has no member: its procedures, facility and dates were never sent
    facts = medis.facts_new(claim, feat, ml, r["indikasi"], claim.catatan_medis, claim.usia, flat=claim.peserta_id is None)
    t = time.perf_counter()
    review, error = None, None
    try:
        review = await medis.areview(facts, claim.pendapat_kedua)
    except Exception as e:  # noqa: BLE001 - the model's verdict still stands, said plainly
        error = f"{type(e).__name__}: {str(e)[:300]}"
    tl0 = (review or {}).get("telaah") or {}
    stages.append({"tahap": "05_llm_service", "keterangan": (f"telaah klinis {tl0.get('model')} (httpx.AsyncClient)" if not tl0.get("fallback") else
                                                            f"fallback deterministik: {tl0.get('alasan_fallback')}")
                   + (f", gerbang angka {'lolos' if tl0.get('lolos_gerbang_angka') else 'TIDAK lolos'}" if review else f"gagal: {error}"),
                   "ms": round((time.perf_counter() - t) * 1000, 1)})
    tl = review["telaah"] if review else None
    status = _status(r["ditandai"], tl["kesimpulan"] if tl else None, r["indikasi"])
    reasoning = tl["ringkasan"] if tl else ("Telaah klinis LLM tidak tersedia; alasan model: " + (r["alasan"] or "-"))
    stages.append({"tahap": "06_json_response", "keterangan": "{status, fraud_probability, ai_reasoning} + rincian", "ms": 0.0})
    if notes:
        r["peringatan"] = list(notes) + r["peringatan"]
    out = {"status": status, "fraud_probability": round(r["risiko"], 6), "ai_reasoning": reasoning,
           "status_label": STATUS[status], "arti_probabilitas": "peluang klaim dikoreksi verifikator BPJS menurut model (skala populasi); "
                                                                "indikasi untuk diperiksa, bukan bukti fraud",
           "klaim_id": r["klaim_id"], "ml": {**ml, "mesin": r["mesin"], "alasan_teks": r["alasan"]}, "indikasi": r["indikasi"],
           "analisis_medis": review, "galat_llm": error, "peringatan": r["peringatan"], "pipeline": stages,
           "model": {"run": pk["run"], "versi": pk["dep"].get("model_versi"), "mesin": engines}}
    if extra_aside:
        out["di_luar_prompt"] = extra_aside
    _log({"t": P._now(), "n": 1, "ms": sum(x["ms"] for x in stages), "ditandai": int(r["ditandai"]), "mesin": engines, "peringatan": int(bool(r["peringatan"])),
          "verify": status})
    return out


class ClaimDataJuri(BaseModel):
    """The flat claim format (reference implementation: github.com/saidachmadd/ai-inference-pipeline-demo)."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    claim_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    patient_age: int = Field(ge=0, le=120)
    ina_cbg_code: str = Field(pattern=r"^[A-Z]-[0-9]-[0-9]{2}-[0IV]+$")
    primary_diagnosis: str = Field(pattern=r"^[A-Z][0-9]{2}(\.?[0-9A-Z]{1,2})?$")
    claimed_cost: float = Field(ge=0, le=1e10)
    real_cost: float = Field(ge=0, le=1e10)
    length_of_stay_days: int = Field(ge=0, le=400)
    clinical_notes: str = Field(min_length=1, max_length=8000)
    pendapat_kedua: bool = False
    mesin: Literal["pkl", "onnx"] = "pkl"


def from_juri(j: ClaimDataJuri, store: dict[str, str]) -> tuple[ClaimData, list[str]]:
    """The judges' claim in the claims contract: the INA-CBG code's CMG, case type, severity and description from the
    real reference (the feature store), the diagnosis' name, real_cost as the reference tariff (the judges' cost ratio
    claimed/real is the model's billed/tariff ratio), the notes and age for the clinical review. What the flat format
    lacks (facility, member, dates) stays unknown, and the answer says so."""
    import duckdb

    ref: dict[str, Any] = {}
    con = duckdb.connect()
    try:
        if store.get("kode_inacbg") and Path(store["kode_inacbg"]).is_file():
            row = con.execute(f"SELECT * FROM read_parquet('{store['kode_inacbg']}') WHERE inacbg_kode = ?", [j.ina_cbg_code]).df()
            ref = row.iloc[0].to_dict() if len(row) else {}
        code = j.primary_diagnosis.replace(".", "")
        dx3 = code[:3]
        # the name of the code itself (the data writes I210): the category table holds one subcode's name per category
        # (I21 → "subendocardial"), right only for a 3-character code; else no name rather than a sibling's
        name = None
        if store.get("dx_kode_nama") and Path(store["dx_kode_nama"]).is_file():
            hit = con.execute(f"SELECT dx_primer_nama FROM read_parquet('{store['dx_kode_nama']}') WHERE dx_primer_kode = ?", [code]).fetchone()
            name = hit[0] if hit else None
        if name is None and len(code) == 3 and store.get("dx_nama") and Path(store["dx_nama"]).is_file():
            hit = con.execute(f"SELECT dx_primer_nama FROM read_parquet('{store['dx_nama']}') WHERE dx_primer_icd3 = ?", [dx3]).fetchone()
            name = hit[0] if hit else None
    finally:
        con.close()
    notes = ["format ringkas juri: faskes, peserta dan tanggal tidak dikirim — fitur riwayat dan profil faskes kosong; "
             "real_cost dipakai sebagai tarif acuan (rasio tagihan/tarif)"]
    if not ref:
        notes.append(f"kode INA-CBG {j.ina_cbg_code} tidak ada di referensi data: CMG, tipe kasus dan keparahan dari kode saja")
    sev = j.ina_cbg_code.rsplit("-", 1)[-1]
    severity = {"I": "Ringan (rawat inap keparahan 1)", "II": "Sedang (rawat inap keparahan 2)", "III": "Berat (rawat inap keparahan 3)"}.get(sev, "Rawat Jalan")
    import datetime as _dt

    claim = ClaimData.model_construct(
        kunjungan_fkrtl_id=j.claim_id, edisi="reguler", peserta_id=None, tgl_datang=_dt.date.today(), tgl_pulang=None, kabkota_fkrtl_kode=None,
        kepemilikan_fkrtl=None, jenis_fkrtl="Rumah sakit", tipe_fkrtl=None, tingkat_pelayanan="RITL" if j.length_of_stay_days >= 1 else "RJTL",
        poli=None, segmen=None, kelas_rawat=None, status_pulang=None, dx_primer_icd3=dx3, inacbg_kode=j.ina_cbg_code,
        inacbg_cmg=ref.get("inacbg_cmg"), inacbg_tipe_kasus=ref.get("inacbg_tipe_kasus"), inacbg_keparahan=ref.get("inacbg_keparahan") or severity,
        regional_tarif=None, prosedur=None, tarif_inacbg_rp=int(j.real_cost), sa_tarif_rp=0, sp_tarif_rp=0, rr_tarif_rp=0, si_tarif_rp=0, sd_tarif_rp=0,
        biaya_tagih_rp=int(j.claimed_cost), los_hari=j.length_of_stay_days, jumlah_dx_sekunder=None, flag_calon_klaim_ganda=False, flag_los_ekstrem=False,
        layanan_covid=False, dx_masuk_kode=None, dx_masuk_nama=None, dx_primer_kode=j.primary_diagnosis, dx_primer_nama=name,
        inacbg_deskripsi=ref.get("inacbg_deskripsi"), sa_kode=None, sp_kode=None, sp_deskripsi=None, rr_kode=None, rr_deskripsi=None, si_kode=None,
        si_deskripsi=None, sd_kode=None, sd_deskripsi=None, kabkota_fkrtl=None, provinsi_fkrtl=None, catatan_medis=j.clinical_notes, usia=j.patient_age,
        pendapat_kedua=j.pendapat_kedua, mesin=j.mesin)
    return claim, notes


@router.post("/verify")
async def verify(claim: Union[ClaimData, ClaimDataJuri]) -> dict:
    """One claim through the inference pipeline: validated, featured, scored by the deployed pickle, reviewed clinically
    by an LLM (asynchronously, behind a circuit breaker), answered as {status, fraud_probability, ai_reasoning} with
    the details. Takes the claims contract (ClaimData) or the judges' flat format (ClaimDataJuri)."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    pk = await anyio.to_thread.run_sync(_package)
    if isinstance(claim, ClaimDataJuri):
        claim, notes = await anyio.to_thread.run_sync(from_juri, claim, pk["store"])
        return await _verify(claim, pk, notes=notes)
    return await _verify(claim, pk)


class VerifyClaimIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    klaim_id: str = Field(min_length=3, max_length=120)
    pendapat_kedua: bool = False
    mesin: Literal["pkl", "onnx"] = "pkl"


def _batch_features(klaim_id: str, claim: "ClaimData", pk: dict) -> Any:
    """A claim of the data with its batch features (the pipeline's feature table, the training definition: the claim is
    counted once in its own history), the code's peer statistics from the store, as infer() and the review read them."""
    import duckdb

    import ml_klaim as M
    from aip import ml as aip_ml

    key = pk["dep"].get("sumber")
    f = aip_ml._dir() / "cache" / f"fitur-{key}-v{M.FEATURES_VERSION}.parquet"
    if not key or not f.is_file():
        return None
    con = duckdb.connect()
    try:
        df = con.execute(f"""SELECT f.*, k.med_los, k.p90_los, k.med_tarif FROM read_parquet('{f.as_posix()}') f
                             LEFT JOIN read_parquet('{pk["store"]["ref_kode"]}') k USING (inacbg_kode) WHERE f.klaim_id = ?""", [klaim_id]).df()
    finally:
        con.close()
    if df.empty:
        return None
    return df.assign(faskes_baru=False, kode_baru=False, layanan_covid=bool(claim.layanan_covid)).iloc[:1].reset_index(drop=True)


def _claim_of_data(klaim_id: str) -> tuple[ClaimData, dict]:
    """A claim of the data as a /verify request (its silver fields), and what the review must not see (the outcome)."""
    from aip import medis

    row = medis._silver_row(klaim_id)
    fields = set(ClaimData.model_fields) - {"catatan_medis", "usia", "pendapat_kedua", "mesin"}
    body = {k: (None if v is None or (isinstance(v, float) and v != v) else v) for k, v in row.items() if k in fields}
    body = {k: (v.item() if hasattr(v, "item") else v) for k, v in body.items() if v is not None}
    aside = {"dikoreksi_verifikator": bool(row.get("flag_selisih_verifikasi")), "biaya_verifikasi_rp": row.get("biaya_verifikasi_rp"),
             "selisih_rp": row.get("selisih_rp")}
    try:
        claim = ClaimData.model_validate(body)
    except ValidationError as e:  # a claim of the data short of what /verify needs (covid:* claims carry no primary diagnosis): not a 500
        short = ", ".join(sorted({str(x["loc"][0]) for x in e.errors() if x.get("loc")}))
        raise HTTPException(422, f"klaim {klaim_id} tidak bisa diverifikasi: datanya tidak memuat {short} yang sah"
                                 + (" (klaim COVID-19 tidak mencatat diagnosis primer)" if klaim_id.startswith("covid:") else "")) from None
    return claim, {k: (v.item() if hasattr(v, "item") else v) for k, v in aside.items()}


@router.post("/verify/klaim")
async def verify_claim(req: VerifyClaimIn) -> dict:
    """A claim of the data (by klaim_id) through the same pipeline: what an AIP agent calls for a claim it is reading."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    claim, aside = await anyio.to_thread.run_sync(_claim_of_data, req.klaim_id)
    claim.pendapat_kedua, claim.mesin = req.pendapat_kedua, req.mesin
    pk = await anyio.to_thread.run_sync(_package)
    df = await anyio.to_thread.run_sync(_batch_features, req.klaim_id, claim, pk)
    return await _verify(claim, pk, aside, df=df)


# ------------------------------------------------------------------------------------------------
# many claims through /verify: a CSV or a JSON list, each claim through the same six stages
# ------------------------------------------------------------------------------------------------


MANY_MAX, MANY_BYTES = 2000, 20_000_000  # claims of one batch, bytes of one CSV
MANY_PARALLEL = 4  # claims in the pipeline at once: each is one LLM review, on the quota the agents share
MANY_RUNNING = 2  # batches verified at once on the platform
FORMATS = {"juri": "claim_id", "kontrak": "kunjungan_fkrtl_id", "data": "klaim_id"}  # a batch's format, by its key column
OPTIONS = ("pendapat_kedua", "mesin")  # set once for the batch, not a column of a claim
RESULT = ("klaim_id", "status", "fraud_probability", "ai_reasoning", "kesimpulan_klinis", "keyakinan", "llm", "llm_fallback", "lolos_gerbang_angka",
          "kesimpulan_pendapat_kedua", "sepakat", "ditandai_model", "risiko_pct", "kelipatan_ambang", "model", "tag_aturan", "kejanggalan",
          "dokumen_diperiksa", "peringatan", "ms")
TEMPLATE = [  # the judges' two payloads (mock_payloads.json of their reference repository)
    {"claim_id": "CLM-2026-8801", "patient_age": 58, "ina_cbg_code": "I-4-10-II", "primary_diagnosis": "I21.0", "claimed_cost": 15100000,
     "real_cost": 14200000, "length_of_stay_days": 6, "clinical_notes": "Pasien serangan jantung. Dirawat di ICU 3 hari, observasi 3 hari. Terapi "
     "trombolitik dan insulin berjalan lancar. Kondisi stabil dan diizinkan pulang."},
    {"claim_id": "CLM-2026-9942", "patient_age": 29, "ina_cbg_code": "A-4-13-III", "primary_diagnosis": "A41.9", "claimed_cost": 18450000,
     "real_cost": 3150000, "length_of_stay_days": 2, "clinical_notes": "Pasien datang dengan keluhan demam tifoid dan mual. Diberikan infus RL dan "
     "obat oral. Hari kedua demam turun dan pasien meminta pulang paksa. Tidak ada tindakan pemasangan ventilator atau observasi ICU."},
]
# a batch to try: the judges' two, then constructed claims (not BPJS data) on real INA-CBG codes and tariffs, with the label
# each was written for (kept in the results, never sent): a sound pneumonia and caesarean, a hernia repair kept 9 days and
# billed twice the tariff, a same-day diarrhoea billed as 4 days, a row the contract refuses
EXAMPLES = [{**TEMPLATE[0], "label": "wajar"}, {**TEMPLATE[1], "label": "upcoding"},
            {"claim_id": "CLM-2026-1003", "patient_age": 64, "ina_cbg_code": "J-4-16-I", "primary_diagnosis": "J18.9", "claimed_cost": 3927100,
             "real_cost": 3927100, "length_of_stay_days": 3, "clinical_notes": "Batuk berdahak 5 hari, demam 38,6 C, ronki basah kanan bawah; foto toraks "
             "infiltrat lobus kanan bawah. Antibiotik intravena 3 hari, klinis membaik, pulang dengan antibiotik oral.", "label": "wajar"},
            {"claim_id": "CLM-2026-1004", "patient_age": 41, "ina_cbg_code": "K-1-14-I", "primary_diagnosis": "K40.9", "claimed_cost": 11200000,
             "real_cost": 5588500, "length_of_stay_days": 9, "clinical_notes": "Herniorafi inguinal elektif tanpa penyulit. Mobilisasi hari pertama "
             "pascaoperasi, luka kering, nyeri terkontrol dengan analgetik oral. Pasien tetap dirawat hingga hari ke-9 atas permintaan keluarga.",
             "label": "los_diperpanjang"},
            {"claim_id": "CLM-2026-1005", "patient_age": 31, "ina_cbg_code": "O-6-10-I", "primary_diagnosis": "O32.1", "claimed_cost": 5391400,
             "real_cost": 5391400, "length_of_stay_days": 2, "clinical_notes": "Sectio caesarea elektif atas indikasi presentasi bokong pada kehamilan 38 "
             "minggu. Bayi lahir bugar, perdarahan dalam batas normal, ibu pulang hari kedua.", "label": "wajar"},
            {"claim_id": "CLM-2026-1006", "patient_age": 23, "ina_cbg_code": "K-4-17-I", "primary_diagnosis": "A09", "claimed_cost": 9850000,
             "real_cost": 1808500, "length_of_stay_days": 4, "clinical_notes": "Diare akut tanpa dehidrasi berat. Rehidrasi oral di IGD, observasi 6 jam, "
             "pasien dipulangkan pada hari yang sama dalam kondisi baik.", "label": "phantom_billing"},
            {"claim_id": "CLM-2026-1007", "patient_age": 150, "ina_cbg_code": "A-4-13-III", "primary_diagnosis": "A41.9", "claimed_cost": 18450000,
             "real_cost": 3150000, "length_of_stay_days": 2, "clinical_notes": "Baris uji: usia di luar rentang kontrak.", "label": "tidak_valid"}]
_ID_NUMBER = re.compile(r"-?\d{1,3}(\.\d{3})+(,\d+)?")  # 18.450.000 / 18.450.000,50
_EN_NUMBER = re.compile(r"-?\d{1,3}(,\d{3})+(\.\d+)?")  # 18,450,000
_YES_NO = {"1": True, "true": True, "ya": True, "y": True, "yes": True, "0": False, "false": False, "tidak": False, "n": False, "no": False}
_many: dict[str, dict] = {}  # batch verifications of this process
_many_tasks: set = set()


def _model(fmt: str) -> Any:
    return {"juri": ClaimDataJuri, "kontrak": ClaimData}[fmt]


def _columns(fmt: str) -> tuple[list[str], list[str]]:
    """The columns a format reads, and those it must have."""
    if fmt == "data":
        return ["klaim_id"], ["klaim_id"]
    fields = {k: f for k, f in _model(fmt).model_fields.items() if k not in OPTIONS}
    return list(fields), [k for k, f in fields.items() if f.is_required()]


def _kind(fmt: str, col: str) -> str:
    import typing

    if fmt == "data":
        return "str"
    ann = _model(fmt).model_fields[col].annotation
    a = ([x for x in typing.get_args(ann) if x is not type(None)] or [ann])[0]
    return {int: "int", float: "float", bool: "bool", date: "date"}.get(a, "str") if isinstance(a, type) else "str"


def _col(h: str) -> str:
    """A header as a field name: "Claim ID" → claim_id."""
    return re.sub(r"[^a-z0-9]+", "_", h.strip().lstrip("﻿").lower()).strip("_")


def _value(kind: str, s: str) -> Any:
    """A CSV cell as the contract reads it: numbers in Indonesian or English notation (Rp 18.450.000, 18,450,000, 3,5),
    ya/tidak, dates as dd/mm/yyyy or ISO; an empty cell is missing. What does not read stays text, for the contract to
    refuse with its reason."""
    s = s.strip()
    if not s:
        return None
    if kind in ("int", "float"):
        t = re.sub(r"(?i)^rp\.?|\s", "", s)
        if _ID_NUMBER.fullmatch(t):
            t = t.replace(".", "").replace(",", ".")
        elif _EN_NUMBER.fullmatch(t):
            t = t.replace(",", "")
        elif re.fullmatch(r"-?\d+,\d+", t):
            t = t.replace(",", ".")
        try:
            x = float(t)
        except ValueError:
            return s
        if not math.isfinite(x):
            return s
        return x if kind == "float" else int(x) if x.is_integer() else s
    if kind == "bool":
        return _YES_NO.get(s.lower(), s)
    if kind == "date":
        m = re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})", s)
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else s[:10] if re.match(r"\d{4}-\d{2}-\d{2}", s) else s
    return s


def _why(e: ValidationError) -> str:
    """The contract's refusal, field by field ("claimed_cost: Input should be ...")."""
    return "; ".join(f"{'.'.join(map(str, x['loc'])) or 'klaim'}: {x['msg']}" for x in e.errors()[:6])


def _check(fmt: str, body: dict) -> Optional[str]:
    """Why the contract refuses a claim of a batch (the same contract as one /verify), or None."""
    if fmt == "data":
        extra = sorted(set(body) - {"klaim_id"})
        if extra:
            return f"field tidak dikenal: {', '.join(extra)}"
        return None if re.fullmatch(r"[a-z_]+:[A-Za-z0-9._-]+", str(body.get("klaim_id") or "")) else "klaim_id: harus berbentuk <edisi>:<kunjungan_fkrtl_id>"
    try:
        _model(fmt).model_validate(body)
    except ValidationError as e:
        return _why(e)
    return None


def read_claims_csv(raw: bytes, data_ok: bool = True) -> dict:
    """A CSV of claims as Excel or any tool writes it (UTF-8 or Windows-1252; separated by , ; tab or |; one header row):
    its format from the key column, each row as the contract reads it, the rows it refuses and why, and the columns it
    does not know (kept for the results, never sent to the pipeline). A row's number is its spreadsheet row (header = 1)."""
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    first = text.split("\n", 1)[0]
    sep = max(",;\t|", key=first.count)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=sep)
    header = next(reader, None)
    if not header or not any(h.strip() for h in header):
        raise HTTPException(400, "CSV kosong: baris pertama harus header kolom")
    names = [h.strip().lstrip("﻿") for h in header]
    cols = [_col(h) for h in names]
    twice = sorted({c for c in cols if c and cols.count(c) > 1})
    if twice:
        raise HTTPException(400, f"kolom ganda: {', '.join(twice)}")
    fmt = next((f for f, key in FORMATS.items() if key in cols and (data_ok or f != "data")), None)
    if not fmt:
        raise HTTPException(400, "kolom kunci tidak ada: claim_id (format juri: " + ", ".join(_columns("juri")[0]) + "), kunjungan_fkrtl_id "
                            "(kontrak klaim lengkap)" + (" atau klaim_id (klaim nyata di data, <edisi>:<kunjungan_fkrtl_id>)" if data_ok else ""))
    known, required = _columns(fmt)
    missing = [c for c in required if c not in cols]
    if missing:
        raise HTTPException(400, f"format {fmt}: kolom wajib tidak ada: {', '.join(missing)}")
    kinds = {c: _kind(fmt, c) for c in known}
    rows: list[dict] = []
    seen: dict[str, int] = {}
    for no, rec in enumerate(reader, start=2):
        if not any(x.strip() for x in rec):
            continue
        if len(rows) >= MANY_MAX:
            raise HTTPException(413, f"lebih dari {MANY_MAX} klaim dalam satu berkas: pecah menjadi beberapa berkas")
        cells = rec + [""] * (len(cols) - len(rec))
        body = {c: _value(kinds[c], v) for c, v in zip(cols, cells) if c in kinds}
        body = {k: v for k, v in body.items() if v is not None}
        why = (f"baris berisi {len(rec)} kolom, header {len(cols)}: ada '{sep}' di dalam teks? apit teks itu dengan tanda kutip"
               if any(x.strip() for x in rec[len(cols):]) else _check(fmt, body))
        key = str(body.get(FORMATS[fmt]) or "")
        seen[key] = seen.get(key, 0) + 1
        rows.append({"no": no, "id": key, "format": fmt, "masukan": dict(zip(names, cells)), "body": body, "galat": why, "ditolak": bool(why)})
    if not rows:
        raise HTTPException(400, "CSV tidak berisi klaim (hanya header)")
    dup = {k: n for k, n in seen.items() if k and n > 1}
    notes = [f"{FORMATS[fmt]} muncul lebih dari sekali (tiap baris tetap dinilai): " + ", ".join(f"{k} ×{n}" for k, n in list(dup.items())[:10])] if dup else []
    return {"format": fmt, "kolom": names, "kolom_tambahan": [n for n, c in zip(names, cols) if c not in kinds], "pemisah": sep, "baris": rows,
            "peringatan": notes}


def read_claims_json(items: list, data_ok: bool = True) -> list[dict]:
    """A JSON list of claims, each in the judges' format, the claims contract or a claim of the data by klaim_id (its
    format by its key), checked by the same contract as one /verify."""
    rows = []
    for no, it in enumerate(items, start=1):
        it = it if isinstance(it, dict) else {}
        fmt = next((f for f, key in FORMATS.items() if key in it and (data_ok or f != "data")), None)
        body = {k: v for k, v in it.items() if k not in OPTIONS}
        why = _check(fmt, body) if fmt else ("bukan klaim yang dikenal: butuh claim_id (format juri) atau kunjungan_fkrtl_id (kontrak)"
                                             + (" atau klaim_id (klaim data)" if data_ok else ""))
        rows.append({"no": no, "id": str(body.get(FORMATS[fmt]) or "") if fmt else "", "format": fmt, "masukan": it, "body": body, "galat": why,
                     "ditolak": bool(why)})
    return rows


async def verify_one(fmt: str, body: dict, pk: dict, second: bool = False, engine: str = "pkl", via: str = "") -> dict:
    """One claim of a batch through /verify's stages, as one request goes."""
    import anyio

    opts = {"pendapat_kedua": second, "mesin": engine}
    if fmt == "data":
        claim, aside = await anyio.to_thread.run_sync(_claim_of_data, body["klaim_id"])
        claim.pendapat_kedua, claim.mesin = second, engine
        df = await anyio.to_thread.run_sync(_batch_features, body["klaim_id"], claim, pk)
        return await _verify(claim, pk, aside, df=df, via=via)
    if fmt == "juri":
        claim, notes = await anyio.to_thread.run_sync(from_juri, ClaimDataJuri.model_validate({**body, **opts}), pk["store"])
        return await _verify(claim, pk, notes=notes, via=via)
    return await _verify(ClaimData.model_validate({**body, **opts}), pk, via=via)


def flat(res: dict) -> dict:
    """A /verify answer as one row of a table: the judges' three keys first, then what a verifier reads next."""
    med = res.get("analisis_medis") or {}
    tl, ml = med.get("telaah") or {}, res.get("ml") or {}
    return {"klaim_id": res.get("klaim_id"), "status": res.get("status"), "fraud_probability": res.get("fraud_probability"),
            "ai_reasoning": res.get("ai_reasoning"), "kesimpulan_klinis": tl.get("kesimpulan"), "keyakinan": tl.get("keyakinan"), "llm": tl.get("model"),
            "llm_fallback": bool(tl.get("fallback")), "lolos_gerbang_angka": tl.get("lolos_gerbang_angka"),
            "kesimpulan_pendapat_kedua": (med.get("pendapat_kedua") or {}).get("kesimpulan"), "sepakat": med.get("sepakat"),
            "ditandai_model": ml.get("ditandai_model"), "risiko_pct": ml.get("risiko_pct"), "kelipatan_ambang": ml.get("kelipatan_ambang"),
            "model": ml.get("model"), "tag_aturan": " | ".join(str(t.get("label") or t.get("tag")) for t in res.get("indikasi") or []),
            "kejanggalan": " | ".join(tl.get("kejanggalan") or []), "dokumen_diperiksa": " | ".join(tl.get("dokumen_diperiksa") or []),
            "peringatan": " | ".join(res.get("peringatan") or []), "ms": round(sum(s.get("ms", 0) for s in res.get("pipeline") or []), 1)}


def _fell_back(d: dict) -> bool:
    return bool((((d.get("hasil") or {}).get("analisis_medis") or {}).get("telaah") or {}).get("fallback"))


async def verify_many(rows: list[dict], pk: dict, second: bool = False, engine: str = "pkl", parallel: int = MANY_PARALLEL, via: str = "",
                      on_done: Optional[Callable[[dict], None]] = None, stop: Optional[Callable[[], bool]] = None) -> list[dict]:
    """The rows of a batch through the pipeline, `parallel` at a time in row order; a claim that fails says why and the
    rest go on. A clinical review that fell back to the deterministic one (a quota burst, the circuit open) is asked
    once more after the circuit closes. Each finished claim: {no, id, format, masukan, galat, ditolak, hasil, ringkas}."""
    from aip import medis

    sem = asyncio.Semaphore(parallel)

    async def one(row: dict, again: bool = False) -> Optional[dict]:
        out = {k: row[k] for k in ("no", "id", "format", "masukan", "galat", "ditolak")}
        out["hasil"] = None
        if not row["ditolak"]:
            async with sem:
                if stop and stop():
                    return None
                try:
                    out["hasil"] = await verify_one(row["format"], row["body"], pk, second, engine, f"{via}, baris {row['no']}" if via else "")
                except HTTPException as e:
                    out["galat"] = str(e.detail)[:500]
                except ValidationError as e:
                    out["galat"] = _why(e)
                except Exception as e:  # noqa: BLE001 - one claim's failure is its row's answer, not the batch's end
                    log.exception("layanan: verifikasi baris %s", row["no"])
                    out["galat"] = f"{type(e).__name__}: {str(e)[:300]}"
        out["ringkas"] = flat(out["hasil"]) if out["hasil"] else None
        if again:
            out["dicoba_ulang"] = True
        if on_done:
            on_done(out)
        return out

    done = [d for d in await asyncio.gather(*(one(r) for r in rows)) if d]
    fell = {d["no"] for d in done if _fell_back(d)}
    if fell and medis.PROVIDER.get("kind") != "none" and not (stop and stop()):
        await asyncio.sleep(min(90.0, max(10.0, medis.BREAKER["open_until"] - time.time() + 1)))
        redo = {d["no"]: d for d in await asyncio.gather(*(one(r, True) for r in rows if r["no"] in fell)) if d}
        done = [redo.get(d["no"], d) for d in done]
    return sorted(done, key=lambda d: d["no"])


def _bucket(d: dict) -> str:
    return "DITOLAK" if d.get("ditolak") else "GALAT" if d.get("galat") or not d.get("ringkas") else d["ringkas"]["status"]


def many_summary(done: list[dict]) -> dict:
    per: dict[str, int] = {}
    for d in done:
        per[_bucket(d)] = per.get(_bucket(d), 0) + 1
    return {"selesai": len(done), "per_status": per, "llm_fallback": sum(1 for d in done if (d.get("ringkas") or {}).get("llm_fallback")),
            "dicoba_ulang": sum(1 for d in done if d.get("dicoba_ulang"))}


def many_answer(done: list[dict], parsed: Optional[dict] = None) -> dict:
    """A batch answered at once: the counts, then each claim's /verify answer (or why it has none) in the input's order."""
    head = {"jumlah": len(done), **many_summary(done)}
    if parsed:
        head.update(format=parsed["format"], kolom_tambahan=parsed["kolom_tambahan"], peringatan=parsed["peringatan"])
    return {"ringkasan": head, "hasil": [{"no": d["no"], "galat": d.get("galat"), **(d.get("hasil") or {"masukan": d["masukan"]})} for d in done]}


def _cell(v: Any, dec: str) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "ya" if v else "tidak"
    if isinstance(v, float):
        return f"{v:.6f}".rstrip("0").rstrip(".").replace(".", dec)
    s = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)
    # a cell that a spreadsheet would run as a formula is kept as text
    return "'" + s if s[:1] in ("=", "+", "@", "\t", "\r") or (s[:1] == "-" and len(s) > 1 and not re.fullmatch(r"-[\d.,]+", s)) else s


def results_csv(done: list[dict], columns: list[str], sep: str = ",") -> str:
    """The results as a CSV for a spreadsheet (UTF-8 with BOM): the input's columns as they came, then the answer's
    (hasil_ where the input has the name already), in the input's separator — with decimal commas when it is ';'."""
    dec = "," if sep == ";" else "."
    names = [f"hasil_{k}" if k in columns else k for k in (*RESULT, "galat")]
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=sep, lineterminator="\r\n")
    w.writerow([*columns, *names])
    for d in sorted(done, key=lambda d: d["no"]):
        r = d.get("ringkas") or {}
        w.writerow([_cell((d.get("masukan") or {}).get(c), dec) for c in columns] + [_cell(r.get(k), dec) for k in RESULT] + [_cell(d.get("galat"), dec)])
    return "﻿" + buf.getvalue()


def template_csv(examples: bool = False) -> str:
    """The judges' columns with their two payloads: a CSV to fill. With `examples`, the batch to try (EXAMPLES) as Excel
    on an Indonesian locale writes it: ';' separators, Rupiah with thousand dots, the label column."""
    cols = _columns("juri")[0]
    buf = io.StringIO()
    if not examples:
        w = csv.writer(buf, lineterminator="\r\n")
        w.writerow(cols)
        for r in TEMPLATE:
            w.writerow([r[c] for c in cols])
        return "﻿" + buf.getvalue()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow([*cols, "label"])
    for r in EXAMPLES:
        w.writerow([f"Rp {r[c]:,}".replace(",", ".") if c in ("claimed_cost", "real_cost") else r[c] for c in cols] + [r["label"]])
    return "﻿" + buf.getvalue()


def _csv_response(text: str, name: str) -> Response:
    return Response(text, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


# the platform's batch: in the background on the server's event loop, its claims appended to a JSONL as they finish


def _many_dir() -> Path:
    d = P._dir() / "verify_batch"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _public(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def _many_start(rows: list[dict], meta: dict, pk: dict, second: bool, engine: str, via: str) -> dict:
    import auth

    running = sum(1 for j in _many.values() if j["status"] == "berjalan")
    if running >= MANY_RUNNING:
        raise HTTPException(429, f"{running} batch verifikasi sedang berjalan: tunggu salah satu selesai")
    jid = "vb-" + uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "berjalan", **meta, "jumlah": len(rows), "ditolak": sum(1 for r in rows if r["ditolak"]), "selesai": 0, "per_status": {},
           "llm_fallback": 0, "dicoba_ulang": 0, "pendapat_kedua": second, "mesin": engine, "dibuat": P._now(), "user_id": (auth.current() or {}).get("id"),
           "_rows": {}}
    path = _many_dir() / f"{jid}.jsonl"

    def done(out: dict) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(out, ensure_ascii=False, default=str) + "\n")
        job["_rows"][out["no"]] = {k: v for k, v in out.items() if k not in ("hasil", "masukan")}
        job.update(many_summary(list(job["_rows"].values())))
        if job["selesai"] % 10 == 0:
            P._write(_many_dir() / f"{jid}.json", _public(job))

    async def run() -> None:
        t0 = time.time()
        try:
            await verify_many(rows, pk, second, engine, via=via, on_done=done, stop=lambda: bool(job.get("batal")))
            job["status"] = "dibatalkan" if job.get("batal") else "selesai"
        except Exception as e:  # noqa: BLE001 - the batch records why it stopped
            log.exception("layanan: verifikasi batch %s", jid)
            job.update(status="gagal", error=str(e)[:500])
        finally:
            job.update(selesai_pada=P._now(), detik=round(time.time() - t0, 1))
            P._write(_many_dir() / f"{jid}.json", _public(job))

    _many[jid] = job
    P._write(_many_dir() / f"{jid}.json", _public(job))
    task = asyncio.get_running_loop().create_task(run())  # the request's context goes with it: the caller's permissions
    _many_tasks.add(task)
    task.add_done_callback(_many_tasks.discard)
    return _public(job)


def _many_job(bid: str) -> dict:
    import auth

    if not re.fullmatch(r"vb-[0-9a-f]{12}", bid):
        raise HTTPException(400, "id batch verifikasi tidak sah")
    job = _many.get(bid) or P._read(_many_dir() / f"{bid}.json")
    p = auth.current() or {}
    if not job or (auth.enabled() and job.get("user_id") not in (p.get("id"), None) and p.get("role") != "admin"):
        raise HTTPException(404, "batch verifikasi tidak ada")
    if job["status"] == "berjalan" and bid not in _many:  # its process stopped (an API restart): what finished stays
        job = {**job, "status": "terhenti"}
    return job


def _many_rows(bid: str, full: bool = False) -> list[dict]:
    """The batch's finished claims in row order (a claim asked again counts once: its last answer); without `full`, the
    rows of the table (no input, no answer's details)."""
    if bid in _many and not full:
        return sorted(_many[bid]["_rows"].values(), key=lambda d: d["no"])
    rows: dict[int, dict] = {}
    path = _many_dir() / f"{bid}.jsonl"
    if path.is_file():
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:  # the line being written
                    continue
                rows[d["no"]] = d if full else {k: v for k, v in d.items() if k not in ("hasil", "masukan")}
    return sorted(rows.values(), key=lambda d: d["no"])


class VerifyBatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    klaim: list[dict] = Field(min_length=1, max_length=MANY_MAX)
    pendapat_kedua: bool = False
    mesin: Literal["pkl", "onnx"] = "pkl"


@router.post("/verify/csv")
async def verify_csv(berkas: UploadFile = File(...), pendapat_kedua: bool = Form(False), mesin: str = Form("pkl")) -> dict:
    """A CSV of claims, one per row (the judges' columns, the claims contract's, or klaim_id for claims of the data),
    each through /verify in the background: poll GET /verify/batch/{id}. GET /verify/csv/templat has the columns."""
    import anyio

    if mesin not in ("pkl", "onnx"):
        raise HTTPException(422, "mesin: pkl atau onnx")
    await anyio.to_thread.run_sync(_caller)
    pk = await anyio.to_thread.run_sync(_package)
    raw = await berkas.read(MANY_BYTES + 1)
    if len(raw) > MANY_BYTES:
        raise HTTPException(413, f"berkas lebih dari {MANY_BYTES // 1_000_000} MB")
    c = await anyio.to_thread.run_sync(read_claims_csv, raw)
    name = Path(berkas.filename or "klaim.csv").name[:120]
    meta = {"sumber": "csv", "berkas": name, "format": c["format"], "kolom": c["kolom"], "pemisah": c["pemisah"], "kolom_tambahan": c["kolom_tambahan"],
            "peringatan": c["peringatan"]}
    return _many_start(c["baris"], meta, pk, pendapat_kedua, mesin, f"CSV {name} (POST /verify/csv)")


@router.get("/verify/csv/templat")
def verify_csv_template(contoh: bool = False) -> Response:
    """The columns with the judges' two payloads; ?contoh=true: seven claims to try (constructed, not BPJS data)."""
    return _csv_response(template_csv(contoh), "contoh-klaim.csv" if contoh else "templat-verifikasi-klaim.csv")


@router.post("/verify/batch")
async def verify_batch(req: VerifyBatchIn) -> dict:
    """A JSON list of claims (each in the judges' format, the claims contract or {klaim_id}) through /verify in the
    background: poll GET /verify/batch/{id}."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    pk = await anyio.to_thread.run_sync(_package)
    rows = read_claims_json(req.klaim)
    meta = {"sumber": "json", "format": "+".join(sorted({r["format"] for r in rows if r["format"]})) or "-",
            "kolom": list(dict.fromkeys(k for it in req.klaim if isinstance(it, dict) for k in it)), "pemisah": ",", "kolom_tambahan": [], "peringatan": []}
    return _many_start(rows, meta, pk, req.pendapat_kedua, req.mesin, "POST /verify/batch (JSON)")


@router.get("/verify/batch")
async def verify_batches() -> list[dict]:
    """The caller's batch verifications, newest first."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    out = []
    for f in sorted(_many_dir().glob("vb-*.json"), key=lambda f: f.stat().st_mtime, reverse=True)[:100]:
        try:
            out.append(_public(_many_job(f.stem)))
        except HTTPException:
            continue
        if len(out) >= 20:
            break
    return out


@router.get("/verify/batch/{bid}")
async def verify_batch_status(bid: str, status: Optional[str] = None, offset: int = 0, limit: int = 100) -> dict:
    """The batch's progress and a page of its claims (status: INDIKASI_KUAT, PERLU_DIPERIKSA, WAJAR, DITOLAK, GALAT)."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    job = _many_job(bid)
    rows = _many_rows(bid) if bid in _many else await anyio.to_thread.run_sync(_many_rows, bid)
    if bid not in _many:
        job = {**job, **many_summary(rows)}
    pick = [r for r in rows if not status or _bucket(r) == status]
    offset = max(offset, 0)
    return {**_public(job), "total_baris": len(pick), "offset": offset, "baris": pick[offset: offset + min(max(limit, 0), 1000)]}


@router.get("/verify/batch/{bid}/baris/{no}")
async def verify_batch_row(bid: str, no: int) -> dict:
    """One claim of the batch: its input and its whole /verify answer."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    _many_job(bid)
    row = next((d for d in await anyio.to_thread.run_sync(_many_rows, bid, True) if d["no"] == no), None)
    if not row:
        raise HTTPException(404, f"baris {no} belum selesai atau tidak ada")
    return row


@router.get("/verify/batch/{bid}/unduh")
async def verify_batch_csv(bid: str) -> Response:
    """The results as a CSV: the input's columns, then status, fraud_probability, ai_reasoning and the details."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    job = _many_job(bid)
    rows = await anyio.to_thread.run_sync(_many_rows, bid, True)
    text = await anyio.to_thread.run_sync(results_csv, rows, job.get("kolom") or [], job.get("pemisah") or ",")
    return _csv_response(text, f"hasil-{re.sub(r'[^A-Za-z0-9._-]+', '_', Path(job.get('berkas') or bid).stem)[:80]}.csv")


@router.post("/verify/batch/{bid}/batal")
async def verify_batch_cancel(bid: str) -> dict:
    """Stop a batch: the claims in the pipeline finish, the rest are not sent."""
    import anyio

    await anyio.to_thread.run_sync(_caller)
    job = _many_job(bid)
    if bid in _many and job["status"] == "berjalan":
        _many[bid]["batal"] = True
    return _public(_many.get(bid) or job)

