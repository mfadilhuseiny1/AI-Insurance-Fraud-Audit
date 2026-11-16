"""/testing: an insurer-side test bench for the fraud system on the SYNTHETIC stream.

Type or upload one claim (or load an example), and it goes the whole way: patient entity resolution, the realtime engine
(rules, signals, VIME), Model 1 (graph + neighbours), Model 2 (rings), the stacker with calibration and the ring-alert
queue. A claim may carry its electronic medical record (a SATUSEHAT FHIR R4 Bundle, aip/realtime/rme.py): the engine
cross-checks the claim against it, and a strong finding flags the claim through the medical-record rule route even when
ML v7 (trained without medical records) scores it low. A safe claim gets "Klaim aman". A flagged claim gets an explanation by DeepSeek-V4.1-Flash (OpenRouter, providers
that keep no data) built from the graph, the entity resolution and both models: the fraud type, why, the network, and
what the verifier should check or have corrected.

Runs on a COPY of the synthetic data (testing/siapkan_data.py), so test claims never enter the stream the experiments use.
Start: testing/start-testing.ps1, then http://localhost:8320/testing. Synthetic data only: do not type real patients.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import sqlite3
import sys
import threading
import time
import uuid
from datetime import date
from pathlib import Path
from typing import Any, Optional

os.environ["BLUESANDAI_AUTH"] = "off"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
DATA_ROOT = ROOT / ".tmp" / "testing-data"

import numpy as np  # noqa: E402
from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, RedirectResponse  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402

from mailer import env  # noqa: E402
from aip import vertex  # noqa: E402

vertex.configure(DATA_ROOT, env)
import platform_lokal  # noqa: E402

platform_lokal.pasang()
from aip import layanan as L  # noqa: E402
from aip.realtime import mesin as E  # noqa: E402
from aip.realtime import rme as RME  # noqa: E402

import fitur as FT  # noqa: E402
import arsitektur_v2 as A2  # noqa: E402
import penjelas as PJ  # noqa: E402
import ekstrak as EX  # noqa: E402
import jaringan as JR  # noqa: E402
import fitur_v4 as F4  # noqa: E402

log = logging.getLogger("testing")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = FastAPI(title="AI JKN Synthetic · testing")
SUMBER = "uji"
LOCK = threading.Lock()
S: dict[str, Any] = {"tahap": "memulai", "siap": False, "galat": None, "mulai": time.time()}
HASIL: list[dict] = []
HASIL_FILE = HERE / "hasil.jsonl"
SEV3 = "Berat (rawat inap keparahan 3)"
# The screening model (the user, 2026-11-14: "update /testing ke arsitektur ML v7 ... masih ada graph juga kan?"): ML v7, the
# adopted pick in testing/model_ml_v7. X1 = the claim's 124 system features + the mean of its earlier graph neighbours per
# relation (same member, hospital, hospital + INA-CBG, INA-CBG) and their counts; X4 = 22 fraud-mechanism features
# (testing/fitur_v4.py); LightGBM x 3 seeds; two tiers set on its dev normals (PERIKSA at FPR 1 %, TAHAN at FPR 0.1 %).
# TESTING_MODEL=v3 (.env.local) brings back architecture v3.
MODEL_UJI = (env("TESTING_MODEL") or "ml_v7").strip().lower()
BLOK_V7 = (("klaim", 0, 124), ("graph", 124, 624), ("mekanisme", 624, 646))


# ----------------------------------------------------------------------------------------------------------------------
# start-up: model, stream, hospitals, engine (warming takes minutes: the page shows the stage)
# ----------------------------------------------------------------------------------------------------------------------
def _kartu_v7(pilihan: str) -> dict:
    """What the page's header shows for ML v7: its benchmark per generator (each scored once) and its gain split per block."""
    out: dict[str, Any] = {"arsitektur": "ML v7", "pilihan": pilihan}
    try:
        b = json.loads((ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "ml_v7_benchmark.json").read_text("utf-8"))
        out["uji"] = {g: {**{k: v["model"][pilihan].get(k) for k in ("recall", "fpr", "presisi_prev2", "auprc")}, "label": v.get("label")}
                      for g, v in b["set"].items() if pilihan in (v.get("model") or {})}
    except (OSError, ValueError, KeyError):
        log.warning("testing: ml_v7_benchmark.json unreadable")
    try:
        out["porsi_gain_blok"] = json.loads((HERE / "model_ml_v7" / "kartu.json").read_text("utf-8"))["cek_overfit"]["porsi_gain_blok"]
    except (OSError, ValueError, KeyError):
        pass
    return out


def _labels_of_faskes(recs: list[dict]) -> dict[str, str]:
    return {e.get("faskes"): PJ.label_rs(e.get("faskes_label")) or e.get("faskes") for e in recs}


def startup() -> None:
    import joblib
    import pandas as pd

    try:
        S["tahap"] = "memuat model"
        # architecture v2 (rule-aware, testing/latih_v2.py) when it is there; the first architecture stays in testing/model
        # the newest architecture there is: v3 (rule-aware, no Model 2), else v2, else the first one (testing/model)
        S["model"] = joblib.load(HERE / next(d for d in ("model_v3", "model_v2", "model") if (HERE / d / "model.joblib").exists()) / "model.joblib")
        # ML v7 scores the claims; the v3 bundle stays loaded for the stream's standardisation (the same mu/sd ML v7 was trained
        # with) and its feature names, and scores only when TESTING_MODEL=v3
        if MODEL_UJI == "ml_v7":
            b7 = joblib.load(HERE / "model_ml_v7" / "model.joblib")
            c7 = b7["kandidat"][b7["pilihan"]]
            S["ml7"] = {"models": c7["models"], "periksa": float(c7["ambang_periksa"]), "tahan": float(c7["ambang_tahan"]),
                        "names": list(S["model"]["agg_names"]) + list(F4.NAMES), "kartu": _kartu_v7(b7["pilihan"])}
        S["ssl"] = FT.load_ssl(DATA_ROOT / "aip" / "realtime" / "al")
        S["tahap"] = "memuat aliran klaim"
        con = sqlite3.connect(f"file:{DATA_ROOT / 'aip' / 'realtime' / 'realtime.sqlite'}?mode=ro", uri=True)
        recs = []
        for rec, in con.execute("""SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                                   WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE ? OR p.sumber LIKE 'aug:%')
                                   ORDER BY p.seq""", (f"{SUMBER}:%",)):
            recs.append(json.loads(rec))
        S["idx_event"] = {e.get("id"): n for n, e in enumerate(recs)}
        con.close()
        m = S["model"]
        sys_mat = FT.sys_features(recs, S["ssl"])
        S["stream"] = FT.Stream(sys_mat, [FT.claim_fields(e) for e in recs], m["mu"], m["sd"])
        S["ringkas"] = [PJ.ringkas(e) for e in recs]
        S["label_rs"] = _labels_of_faskes(recs)
        S["jar"] = JR.Jaringan(S["stream"], S["ringkas"], S["label_rs"])
        if "ml7" in S:
            S["tahap"] = "menyiapkan fitur mekanisme ML v7"
            S["f4"] = F4.Fitur4(F4.referensi(), F4.domisili([e.get("peserta") for e in recs]))
            for e in recs:  # the stream in arrival order, so a new claim is measured against every claim before it
                S["f4"].tambah(e)
            S["x4"], S["dom_dicari"] = {}, set()
        S["tahap"] = "memuat daftar RS"
        rp = pd.read_parquet(ROOT / "data" / "aip" / "realtime" / "replay_fkrtl_2024-12-18_2024-12-31.parquet")
        S["replay"] = rp
        S["rs"] = PJ.daftar_rs(rp)
        S["tahap"] = "menyiapkan engine realtime (sekali saat mulai, beberapa menit)"
        E.ENGINE.start(None)
        while not E.ENGINE.ready():
            if E.ENGINE.error and not E.ENGINE.warming and E.ENGINE.graf is None:
                raise RuntimeError(E.ENGINE.error)
            time.sleep(2)
        from aip.realtime.entitas import Resolver

        if E.ENGINE.resolver is None:
            E.ENGINE.resolver = Resolver(E.ENGINE.store)
        if HASIL_FILE.exists():
            terakhir: dict[str, dict] = {}
            for line in HASIL_FILE.read_text("utf-8").splitlines()[-4000:]:
                try:
                    h = json.loads(line)
                except ValueError:
                    continue
                terakhir.pop(h.get("id"), None)
                terakhir[h.get("id")] = h
            HASIL.extend(list(terakhir.values())[-1000:])
        S["tahap"] = "siap"
        S["siap"] = True
        log.info("testing: ready in %.0fs, stream %d claims", time.time() - S["mulai"], len(S["stream"]))
    except Exception as e:  # noqa: BLE001 - the page shows why
        log.exception("testing: start-up failed")
        S["galat"] = f"{type(e).__name__}: {e}"
        S["tahap"] = "gagal"


@app.on_event("startup")
def _start() -> None:
    threading.Thread(target=startup, daemon=True, name="testing-startup").start()


# ----------------------------------------------------------------------------------------------------------------------
# the claim form
# ----------------------------------------------------------------------------------------------------------------------
class KlaimForm(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    pasien_mode: str = Field("baru", pattern=r"^(baru|terdaftar)$")
    peserta_id: Optional[int] = Field(None, ge=0)
    nama_pasien: str = Field("", max_length=200)
    no_rm: str = Field("", max_length=64)
    no_sep: str = Field("", max_length=64)
    segmen: Optional[str] = Field(None, max_length=80)
    rs_id: str = Field(min_length=4, max_length=64)
    jenis_episode: str = Field(pattern=r"^(ri|rj|igd)$")
    tanggal_masuk: date
    tanggal_pulang: Optional[date] = None
    kelas_rawat: Optional[int] = Field(None, ge=1, le=3)
    hak_kelas: Optional[int] = Field(None, ge=1, le=3)
    status_pulang: Optional[str] = Field(None, max_length=80)
    diagnosis_utama: str = Field(min_length=3, max_length=16)
    diagnosis_sekunder: list[str] = Field(default_factory=list, max_length=60)
    tindakan: list[str] = Field(default_factory=list, max_length=80)
    inacbg_kode: str = Field(min_length=6, max_length=20)
    tarif_inacbg_rp: Optional[int] = Field(None, ge=0, le=10_000_000_000)
    topup_jenis: Optional[str] = Field(None, pattern=r"^(|sa|sp|rr|si|sd)$")
    topup_rp: int = Field(0, ge=0, le=10_000_000_000)
    biaya_tagih_rp: int = Field(ge=0, le=10_000_000_000)
    # the episode's electronic medical record: one SATUSEHAT FHIR R4 Bundle (aip/realtime/rme.py), optional
    rekam_medis: Optional[dict] = None


class NilaiIn(BaseModel):
    klaim: list[KlaimForm] = Field(min_length=1, max_length=30)
    llm: bool = True


def _galat(field: str, msg: str) -> HTTPException:
    return HTTPException(422, {"field": field, "pesan": msg})


def build_klaim(f: KlaimForm) -> tuple[Any, dict]:
    eng = E.ENGINE
    rs = next((r for r in S["rs"] if r["id"] == f.rs_id), None)
    if rs is None:
        raise _galat("rs_id", "Rumah sakit tidak ada di daftar.")
    dx = re.sub(r"[^A-Z0-9]", "", f.diagnosis_utama.upper())
    if not re.match(r"^[A-Z][0-9]{2}", dx):
        raise _galat("diagnosis_utama", "Diagnosis utama harus kode ICD-10, mis. J18.9.")
    code = f.inacbg_kode.strip().upper()
    if not re.match(r"^[A-Z]-[0-9]-[0-9]{2}-[0IV]+$", code):
        raise _galat("inacbg_kode", "Kode INA-CBG harus format grouper, mis. J-4-16-I.")
    if code not in eng.known_codes:
        raise _galat("inacbg_kode", f"Kode INA-CBG {code} tidak ada di referensi.")
    ri = f.jenis_episode == "ri"
    pulang = f.tanggal_pulang if (f.tanggal_pulang and f.tanggal_pulang >= f.tanggal_masuk) else None
    if ri and not pulang:
        raise _galat("tanggal_pulang", "Rawat inap butuh tanggal pulang yang tidak sebelum tanggal masuk.")
    if f.pasien_mode == "terdaftar":
        if f.peserta_id is None:
            raise _galat("peserta_id", "Isi ID peserta, atau pilih pasien baru.")
        ent = {"peserta_id": int(f.peserta_id), "aturan": "peserta_terdaftar", "skor": 1.0, "catatan": []}
    else:
        if not (f.nama_pasien or f.no_rm):
            raise _galat("nama_pasien", "Isi nama pasien atau no RM untuk entity resolution.")
        ent = eng.resolver.resolve(SUMBER, f.no_rm, f.nama_pasien, f.no_sep)
    ref = eng.code_ref.get(code) or {}
    tarif = f.tarif_inacbg_rp if f.tarif_inacbg_rp is not None else eng.tarif_ref.get(code)
    # a registered member is the registry's (edition "reguler": registry checks and history apply, as for the stream's own
    # claims); a new patient is resolved into the hospital-sent edition "faskes", as the ai-jkn Submit sends them
    edisi = E.REPLAY_EDISI if f.pasien_mode == "terdaftar" else "faskes"
    body = {"kunjungan_fkrtl_id": f"UJI-{uuid.uuid4().hex[:12].upper()}", "edisi": edisi, "peserta_id": int(ent["peserta_id"]),
            "tgl_datang": f.tanggal_masuk, "tgl_pulang": pulang if ri else f.tanggal_masuk, "kabkota_fkrtl_kode": rs["kabkota_kode"],
            "kepemilikan_fkrtl": rs["kepemilikan"], "jenis_fkrtl": rs["jenis"], "tipe_fkrtl": rs["tipe"], "tingkat_pelayanan": "RITL" if ri else "RJTL",
            "poli": "IGD" if f.jenis_episode == "igd" else None, "segmen": f.segmen, "kelas_rawat": f"Kelas {f.kelas_rawat}" if f.kelas_rawat else None,
            "status_pulang": f.status_pulang or None, "dx_primer_icd3": dx[:3], "dx_primer_kode": dx[:5], "inacbg_kode": code,
            "inacbg_cmg": ref.get("inacbg_cmg"), "inacbg_tipe_kasus": ref.get("inacbg_tipe_kasus"), "inacbg_keparahan": ref.get("inacbg_keparahan"),
            "inacbg_deskripsi": ref.get("inacbg_deskripsi"), "regional_tarif": rs.get("regional"), "prosedur": ";".join(f.tindakan)[:8000] or None,
            "tarif_inacbg_rp": tarif, "biaya_tagih_rp": f.biaya_tagih_rp, "los_hari": (pulang - f.tanggal_masuk).days if ri else 0,
            "jumlah_dx_sekunder": len(f.diagnosis_sekunder), "kabkota_fkrtl": rs.get("kabkota"), "provinsi_fkrtl": rs.get("provinsi")}
    if f.topup_jenis and f.topup_rp:
        body[f"{f.topup_jenis}_tarif_rp"] = f.topup_rp
    try:
        k = L.KlaimIn.model_validate(body)
    except Exception as e:  # noqa: BLE001
        raise _galat("klaim", f"Klaim tidak lolos kontrak: {str(e)[:300]}") from e
    meta = {"entitas": ent, "tarif_dari_referensi": f.tarif_inacbg_rp is None,  # the hospital shows as its profile label
            # the codes the claim contract keeps only as a count and a text: the medical-record cross-check needs them
            "klaim_kode": {"dx_utama": f.diagnosis_utama, "dx_sekunder": list(f.diagnosis_sekunder), "tindakan": list(f.tindakan)}}
    if f.hak_kelas:
        meta["hak_kelas"] = int(f.hak_kelas)
    if f.rekam_medis is not None:
        r = RME.baca(f.rekam_medis)
        if not r["ok"]:
            raise _galat("rekam_medis", "Rekam medis tidak dapat dicocokkan: " + "; ".join(r["masalah"][:3]))
        meta["rme"] = r
    return k, meta


def rute_rme(rec: dict) -> dict:
    """The medical-record rule route: the RME_* findings alone, scored as the engine scores (100 x (1 - e^-sum)), against the
    engine's thresholds. White box: which findings, their weights, and the tier they reach on their own."""
    cfg = E.config()
    th_p, th_t = float(cfg["ambang_periksa"]), float(cfg["ambang_tahan"])
    temuan = [s for s in rec.get("sinyal") or [] if str(s.get("kode", "")).startswith("RME_") and float(s.get("kontribusi") or 0) > 0]
    tot = sum(float(s["kontribusi"]) for s in temuan)
    skor = round(100 * (1 - float(np.exp(-tot))), 1)
    tingkat = "TAHAN" if skor >= th_t else "PERIKSA" if skor >= th_p else None
    return {"ada_rme": "rme" in rec, "temuan": len(temuan), "skor": skor, "ambang_periksa": th_p, "ambang_tahan": th_t,
            "tingkat": tingkat, "aktif": tingkat is not None}


# ----------------------------------------------------------------------------------------------------------------------
# scoring
# ----------------------------------------------------------------------------------------------------------------------
def _lg(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def masukkan(f: KlaimForm, sumber: str) -> tuple:
    """Build the claim, run it through the realtime engine and append it to the stream (call under LOCK)."""
    st: FT.Stream = S["stream"]
    k, meta = build_klaim(f)
    ids = E.ENGINE.ingest([k], sumber, [meta])
    b = E.ENGINE.wait(ids, 90)[0]
    if not b or b.get("keputusan") in ("GAGAL", "DIGANTIKAN"):
        raise HTTPException(502, f"engine realtime tidak memutuskan klaim ini ({(b or {}).get('keputusan', 'waktu habis')})")
    rec = E.ENGINE.store.event(ids[0])
    sys_row = FT.sys_features([rec], S["ssl"])[0]
    i = st.append(sys_row, FT.claim_fields(rec))
    if "f4" in S:  # ML v7's mechanism features: this claim against the ones before it, then indexed for the ones after it
        f4, pid = S["f4"], rec.get("peserta")
        if str(pid).isdigit() and int(pid) not in f4.dom and int(pid) not in S["dom_dicari"]:  # a member the stream had not seen
            S["dom_dicari"].add(int(pid))
            f4.dom.update(F4.domisili([pid]))
        S["x4"][i] = f4.tambah(rec)
    S["ringkas"].append(PJ.ringkas(rec))
    S["label_rs"][rec.get("faskes")] = PJ.label_rs(rec.get("faskes_label"))
    S.setdefault("idx_event", {})[ids[0]] = i
    S["jar"].baru(i)
    return k, meta, ids, rec, i


def nilai_satu(f: KlaimForm, pakai_llm: bool) -> dict:
    t0 = time.time()
    m = S["model"]
    st: FT.Stream = S["stream"]
    with LOCK:
        k, meta, ids, rec, i = masukkan(f, f"{SUMBER}:testing")
        x1, x2, xr = st.agg_row(i)[None], st.s2_row(i)[None], st.r2_row(i)[None]
        blok = tier = tahan = None
        if "ml7" in S:  # ML v7: one LightGBM ensemble over X1 (the claim + its graph neighbours) and X4 (mechanisms), two tiers
            b7 = S["ml7"]
            X = np.hstack([x1, S["x4"][i][None]]).astype(np.float32)
            peluang = float(np.mean([mm.predict_proba(X)[:, 1] for mm in b7["models"]]))
            contrib = np.mean([mm.booster_.predict(X, pred_contrib=True)[0] for mm in b7["models"]], axis=0)
            ambang, tahan = b7["periksa"], b7["tahan"]
            tier = "TAHAN" if peluang >= tahan else "PERIKSA" if peluang >= ambang else "LOLOS"
            terdeteksi = peluang >= ambang
            rr = rute_rme(rec)  # ML v7 never saw a medical record: a strong record finding flags the claim on its own
            if rr["aktif"]:
                terdeteksi = True
                tier = "TAHAN" if (rr["tingkat"] == "TAHAN" or tier == "TAHAN") else "PERIKSA"
            alasan_m1 = PJ.alasan_model1(contrib, X[0], b7["names"])
            naik = np.clip(contrib[:-1], 0, None)  # what pushed the score up, per block
            blok = {n: round(float(naik[a:b].sum() / max(float(naik.sum()), 1e-9)), 4) for n, a, b in BLOK_V7}
            p1 = p2 = pm = thr = lapisan = None
            rute = jar = alert = False
        else:
            if "komponen" in m:  # architecture v2: rule layer, Permenkes-family specialists, graph, ring, monotone fusion, rule route
                sc = A2.skor(m, x1, x2, xr)
                p1, p2 = sc["model1"], sc.get("model2")  # v3 has no Model 2 and no ring alert
                peluang, pm = float(sc["cal"][0]), float(sc["pm"][0])
                thr, ambang = m["ambang_alert_ring"], m["ambang_peluang"]
                rute = bool(sc["rute"][0])
                jar = bool(sc["jaringan_rule"][0])
                lapisan = {k: round(float(sc[k][0]), 4) for k in m["urutan"]}
                m1 = m["komponen"]["model1"]["model"]
            else:
                p1 = m["m1"].predict_proba(x1)[:, 1]; p2 = m["m2"].predict_proba(x2)[:, 1]
                ps = m["stacker"].predict_proba(np.column_stack([_lg(p1), _lg(p2)]))[:, 1]
                peluang = float(m["iso"].predict(ps)[0])
                pm = float(m["mono"].predict_proba(xr)[:, 1][0])
                thr, ambang = m["kartu"]["ambang_alert_ring"], m["kartu"]["ambang_peluang"]
                rute, lapisan, m1, jar = False, None, m["m1"], False
            alert = (thr is not None and pm > thr) or jar  # v3: the label-free ring rule stands where the ring alert was
            rr = rute_rme(rec)
            terdeteksi = peluang >= ambang or alert or rute or rr["aktif"]
            contrib = m1.booster_.predict(x1, pred_contrib=True)[0]
            alasan_m1 = PJ.alasan_model1(contrib, x1[0], m["agg_names"])
        ring = PJ.ring_info(st, i, S["label_rs"])
        graf = S["jar"].fokus(i, ring)
        tetangga = S["jar"].tetangga(i)
    hasil = {"id": ids[0], "klaim_id": k.kunjungan_fkrtl_id, "pada": time.strftime("%Y-%m-%d %H:%M:%S"), "terdeteksi": bool(terdeteksi),
             "peluang": round(peluang, 4), "model1": None if p1 is None else round(float(p1[0]), 4), "model2": None if p2 is None else round(float(p2[0]), 4),
             "alert_ring": bool(alert), "skor_alert_ring": None if thr is None else round(pm, 4), "ambang_alert_ring": None if thr is None else round(thr, 4),
             "ambang_peluang": ambang, "lapisan": lapisan, "rute_rule": rute, "rule_jaringan": None if "ml7" in S else (jar if "komponen" in m else None),
             "arsitektur": "ml_v7" if "ml7" in S else m.get("arsitektur", "v3"), "tier": tier, "ambang_tahan": tahan, "blok": blok,
             "engine": PJ.engine_info(rec), "entitas": PJ.entitas_info(meta["entitas"], f), "klaim": PJ.klaim_info(rec, k),
             "alasan_model1": alasan_m1, "ring": ring, "graf": graf, "tetangga": tetangga, "idx": i, "hari": st.f[i]["day"],
             "rme": ({**rec["rme"], "rute": rr} if rec.get("rme") else {"rute": rr})}
    if terdeteksi:
        hasil["penjelasan"] = PJ.jelaskan(hasil, pakai_llm) if pakai_llm else {**PJ.jelaskan(hasil, False), "menunggu_ai": True}
    else:
        hasil["penjelasan"] = {"status": "aman", "teks": "Klaim aman.", "sumber": "aturan"}
    hasil["detik"] = round(time.time() - t0, 1)
    HASIL.append(hasil)
    _simpan(hasil)
    return hasil


# ----------------------------------------------------------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------------------------------------------------------
@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse("/testing")


@app.get("/testing")
def page() -> FileResponse:
    return FileResponse(HERE / "static" / "testing.html", media_type="text/html")


@app.get("/testing/api/status")
def status() -> dict:
    k = S["ml7"]["kartu"] if "ml7" in S else (S.get("model") or {}).get("kartu", {})
    if "oof" in k:  # architecture v2: the fields the page shows
        k = {**k, "oof_auprc": k["oof"]["auprc"], "oof_ditandai_precision": k["oof"]["precision"], "oof_ditandai_recall": k["oof"]["recall"]}
    return {"siap": S["siap"], "tahap": S["tahap"], "galat": S["galat"], "detik": round(time.time() - S["mulai"]),
            "klaim_aliran": len(S["stream"]) if "stream" in S else None, "kartu_model": k, "llm": PJ.llm_siap(), "rs": len(S.get("rs") or []),
            "uji": len(HASIL)}


@app.get("/testing/api/rs")
def rs_list(q: str = "") -> list[dict]:
    if "rs" not in S:
        raise HTTPException(503, "daftar RS belum dimuat")
    q = q.strip().lower()
    out = [r for r in S["rs"] if not q or q in r["label"].lower()]
    return out


@app.get("/testing/api/contoh")
def contoh(jenis: str = "normal") -> dict:
    if not S["siap"]:
        raise HTTPException(503, "layanan belum siap")
    try:
        # members with an ordinary journey, as the clean training plants: a patient of the template's hospital with no
        # claim in the stream (a recently seen member would add the simulator's fingerprint: a claim at another
        # hospital the same day, at a hospital the member never visited)
        return PJ.contoh(jenis, S["replay"], S["rs"], E.ENGINE, list(S["stream"].by_mem.keys()))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/testing/api/nilai")
def nilai(req: NilaiIn) -> dict:
    if not S["siap"]:
        raise HTTPException(503, f"layanan belum siap: {S['tahap']}")
    out = []
    for i, f in enumerate(req.klaim):
        try:
            out.append(nilai_satu(f, i == len(req.klaim) - 1))
        except HTTPException as e:
            if len(req.klaim) == 1:
                raise
            out.append({"galat": e.detail, "urutan": i})
    # a batch (e.g. a ring built claim by claim): every flagged claim keeps its model evidence; the LLM explains the last
    return {"hasil": out}


@app.post("/testing/api/ekstrak")
async def ekstrak(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    try:
        return EX.ekstrak(file.filename or "dokumen", file.content_type or "", data, S.get("rs") or [])
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class RmeBuatIn(BaseModel):
    klaim: KlaimForm
    varian: str = Field("sesuai", pattern=r"^[a-z_]+$")


@app.post("/testing/api/rme/buat")
def rme_buat(req: RmeBuatIn) -> dict:
    """A synthetic SATUSEHAT Bundle for the claim in the form: consistent with it ("sesuai") or one of the fraud variants, so a
    tester can start from a record and edit it. Synthetic data only."""
    import random

    from aip.realtime import rme_sintetis as RS

    if req.varian not in RS.VARIAN:
        raise HTTPException(400, f"varian tidak dikenal: {', '.join(RS.VARIAN)}")
    f = req.klaim
    return {"rekam_medis": RS.bundel(PJ.klaim_rme(f.model_dump()), req.varian, random.Random(), PJ.pasien_rme(E.ENGINE, f.model_dump()))}


@app.post("/testing/api/rme/validasi")
def rme_validasi(req: dict) -> dict:
    """What the contract reads from a Bundle (structure only, as a hospital would see it)."""
    return RME.validasi(req.get("rekam_medis", req))


class AugIn(BaseModel):
    skenario: str = Field(pattern=r"^[a-z_]+$")
    n: int = Field(ge=1, le=400)


@app.post("/testing/api/augmentasi")
def augmentasi(req: AugIn) -> dict:
    """Training data without the simulator's member fingerprint: the scheme's claims (built as the simulator plants them)
    on members with an ordinary journey, through the realtime engine, stored with source aug:<scheme> (labelled fraud by
    latih_model.py). Not scored by the models, no LLM. Local development use."""
    if not S["siap"]:
        raise HTTPException(503, "layanan belum siap")
    done, gagal, t0 = 0, [], time.time()
    while done < req.n and len(gagal) < 20:
        try:
            c = PJ.contoh(req.skenario, S["replay"], S["rs"], E.ENGINE, list(S["stream"].by_mem.keys()))
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        for kf in c["klaim"]:
            try:
                with LOCK:
                    masukkan(KlaimForm.model_validate(kf), f"aug:{req.skenario}")
                done += 1
            except Exception as e:  # noqa: BLE001
                gagal.append(str(getattr(e, "detail", e))[:200])
            if done >= req.n:
                break
    return {"skenario": req.skenario, "dimasukkan": done, "gagal": gagal[:5], "detik": round(time.time() - t0, 1)}


@app.get("/testing/api/ekspansi")
def ekspansi(node: str, hari: Optional[int] = None) -> dict:
    """The neighbours of one node of the network (a claim, a member, a hospital or a code)."""
    if not S["siap"]:
        raise HTTPException(503, "layanan belum siap")
    try:
        return S["jar"].ekspansi(node, hari)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, f"simpul {node} tidak dikenal") from e


@app.get("/testing/api/jaringan")
def jaringan(idx: int) -> dict:
    """The network of any claim of the stream with it as the focal document (its neighbours and its +-14-day ring)."""
    if not S["siap"]:
        raise HTTPException(503, "layanan belum siap")
    st: FT.Stream = S["stream"]
    if not 0 <= idx < len(st):
        raise HTTPException(404, "klaim tidak ada di aliran")
    with LOCK:
        ring = PJ.ring_info(st, idx, S["label_rs"])
        return {"graf": S["jar"].fokus(idx, ring), "ring": ring, "hari": st.f[idx]["day"], "klaim": S["ringkas"][idx]}


@app.get("/testing/api/lini_masa")
def lini_masa(node: str) -> list[dict]:
    if not S["siap"]:
        raise HTTPException(503, "layanan belum siap")
    return S["jar"].lini_masa(node)


def _simpan(h: dict) -> None:
    try:
        with HASIL_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(h, ensure_ascii=False, default=str) + "\n")
    except OSError:
        log.warning("testing: could not write hasil.jsonl")


@app.post("/testing/api/jelaskan/{hid}")
def jelaskan_ulang(hid: str) -> dict:
    """The AI explanation of a flagged claim that has only the automatic summary (the earlier claims of a batch)."""
    h = next((x for x in reversed(HASIL) if x.get("id") == hid), None)
    if not h:
        raise HTTPException(404, "hasil tidak ada")
    p = h.get("penjelasan") or {}
    if h.get("terdeteksi") and p.get("sumber") == "aturan":
        h["penjelasan"] = PJ.jelaskan(h, True)
        _simpan(h)
    return h


@app.get("/testing/api/riwayat")
def riwayat(n: int = 1000) -> list[dict]:
    out = []
    for h in reversed(HASIL[-max(1, min(n, 1000)):]):
        p, k = h.get("penjelasan") or {}, h.get("klaim") or {}
        jenis = p.get("jenis_fraud") if isinstance(p.get("jenis_fraud"), list) else ([{"kode": "-", "nama": p["jenis_fraud"]}] if p.get("jenis_fraud") else [])
        out.append({key: h.get(key) for key in ("id", "klaim_id", "pada", "terdeteksi", "peluang", "alert_ring")} | {
            "jenis": PJ.nama_jenis(p), "jenis_daftar": [{"kode": j.get("kode"), "nama": j.get("nama")} for j in jenis] if h.get("terdeteksi") else [],
            "rs": PJ.label_rs(k.get("rs")), "kode": k.get("kode"), "tgl": k.get("tgl_datang"), "pasien": (h.get("entitas") or {}).get("mode")})
    return out


@app.get("/testing/api/hasil/{hid}")
def hasil(hid: str) -> dict:
    h = next((x for x in reversed(HASIL) if x.get("id") == hid), None)
    if not h:
        raise HTTPException(404, "hasil tidak ada")
    return _lengkapi_graf(h)


def _lengkapi_graf(h: dict) -> dict:
    """Results saved before the claim nodes carried their rule reasons get them from the stream, only where the stream
    claim at that position still has the same date and code."""
    rk = S.get("ringkas") or []
    for n in (h.get("graf") or {}).get("nodes") or []:
        j = n.get("idx")
        if n.get("tipe") == "klaim" and "alasan" not in n and isinstance(j, int) and 0 <= j < len(rk) \
                and rk[j].get("tgl") == n.get("tgl") and rk[j].get("kode") == n.get("kode"):
            n["modus"], n["alasan"] = rk[j].get("modus") or [], rk[j].get("alasan") or []
    return h
