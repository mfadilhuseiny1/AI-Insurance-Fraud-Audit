"""Routes of the realtime fraud system (/api/aip/realtime/v1), for the "Realtime Fraud" tab of /aip-jkn and the
hospitals that send claims.

    GET  /status                      the engine, throughput, latency, decisions, cases, sources, integration
    POST /mesin                       on/off and thresholds (admin; the engine then acts as that admin)
    POST /klaim                       claims in the platform's contract (aip/layanan.KlaimIn), session or PAT; ?tunggu=1
                                      waits for the decisions
    POST /faskes/klaim                a hospital's submission (header X-Ingest-Token) → a receipt, never a score; may carry
                                      `rekam_medis`, the episode's SATUSEHAT FHIR Bundle (rme.py)
    POST /faskes/rme/validasi         a hospital checks its SATUSEHAT Bundle against the contract (structure only)
    GET  /rme/skema                   the medical-record contract (JSON Schema) and the clinical knowledge of the cross-check
    POST /faskes/iot/validasi         a hospital checks its device payload (sessions, anchors, registry) (structure only)
    GET  /iot/skema                   the device-evidence contract: device kinds, modes, thresholds, the IOT_* signals
    GET  /umpan?sejak=                the decisions after a sequence number (the live feed)
    GET  /peristiwa/{id}              one decision with every signal, its mitigation and the model's reasons
    GET  /kasus                       the cases, by priority
    GET  /kasus/{id}                  one case: its claims, the entity, the network around it
    POST /kasus/{id}/keputusan        telaah / konfirmasi / false_positive / buka (admin): decides its tags in the ledger
    GET  /graf?jenis=&kunci=          the network around an entity
    GET  /jaringan                    the abnormal facility pairs and the rings
    GET  /entitas/{id}                a resolved patient of a hospital submission
    POST /simulator                   mulai / berhenti / reset the replay (admin)
    POST /simulator/tanam             plant one scenario now (admin)
    GET  /evaluasi                    the decisions against the planted truth and the verifier's labels
    GET  /sumber, PUT /sumber/{id}    the registry of connected hospitals (admin to change)
    POST /token                       a new ingest token, shown once (admin)
    POST /box                         Box Karantina rebuilt from the tags now (admin)
    POST /reset                       the stream's decisions, cases and graph cleared; optionally the detector's tags (admin)
"""

from __future__ import annotations

import time
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from aip.realtime import integrasi as X
from aip.realtime import mesin as E
from aip.realtime import modus as MO
from aip.realtime import precheck as PC
from aip.realtime import simulator as SIM

router = APIRouter(prefix="/api/aip/realtime/v1")
SIMULATOR = SIM.Simulator(E.ENGINE)


def _admin() -> dict:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "butuh admin")
    return p


def _reader() -> dict:
    """Whoever reads the realtime decisions must be able to read the claims behind the model (as aip/layanan.py)."""
    from aip import layanan as L

    return L._caller()


class MesinIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aktif: Optional[bool] = None
    ambang_periksa: Optional[float] = Field(None, ge=1, le=99)
    ambang_tahan: Optional[float] = Field(None, ge=2, le=100)
    tulis_tag: Optional[bool] = None
    box_otomatis: Optional[bool] = None


@router.get("/status")
def status() -> dict:
    _reader()
    out = E.ENGINE.status()
    out["simulator"] = SIMULATOR.status()
    out["token_ingest"] = bool(X.token_hash())
    out["registri"] = X.sources()
    return out


@router.post("/mesin")
def engine(req: MesinIn) -> dict:
    p = _admin()
    kv = {k: v for k, v in req.model_dump().items() if v is not None}
    cfg = E.config()
    lo, hi = kv.get("ambang_periksa", cfg["ambang_periksa"]), kv.get("ambang_tahan", cfg["ambang_tahan"])
    if lo >= hi:
        raise HTTPException(400, "ambang PERIKSA harus di bawah ambang TAHAN")
    if kv.get("aktif") is True:
        from aip import produksi as P

        if not P.deployed():
            raise HTTPException(409, "belum ada model ter-deploy: jalankan pipeline produksi dulu")
        kv["pemilik"] = p.get("id")
        E.set_config(**kv)
        E.ENGINE.start(p.get("id"))
    elif kv.get("aktif") is False:
        SIMULATOR.stop()
        E.set_config(**kv)
        E.ENGINE.stop()
    else:
        E.set_config(**kv)
    return status()


class KlaimBatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    klaim: list[dict] = Field(min_length=1, max_length=500)
    tunggu: bool = False


@router.post("/klaim")
def ingest(req: KlaimBatchIn) -> dict:
    from aip import layanan as L

    p = _reader()
    claims, bad = [], []
    for i, b in enumerate(req.klaim):
        try:
            claims.append(L.KlaimIn.model_validate(b))
        except Exception as e:  # noqa: BLE001 - which claim and why
            bad.append({"baris": i, "galat": str(e)[:300]})
    if bad and not claims:
        raise HTTPException(422, {"ditolak": bad[:20]})
    ids = E.ENGINE.ingest(claims, f"api:{p.get('username') or p.get('id') or 'lokal'}")
    out = {"diterima": len(ids), "ditolak": bad[:20], "id": ids}
    if req.tunggu:
        out["keputusan"] = E.ENGINE.wait(ids)
    return out


class FktpBatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kunjungan: list[dict] = Field(min_length=1, max_length=1000)


@router.post("/fktp")
def ingest_fktp(req: FktpBatchIn) -> dict:
    """FKTP visits (capitation) in the silver contract (kontrak.FktpIn)."""
    from aip.realtime.kontrak import FktpIn

    p = _reader()
    objs, bad = [], []
    for i, b in enumerate(req.kunjungan):
        try:
            objs.append(FktpIn.model_validate(b))
        except Exception as e:  # noqa: BLE001
            bad.append({"baris": i, "galat": str(e)[:300]})
    if bad and not objs:
        raise HTTPException(422, {"ditolak": bad[:20]})
    ids = E.ENGINE.ingest(objs, f"api:{p.get('username') or p.get('id') or 'lokal'}", jenis="fktp")
    return {"diterima": len(ids), "ditolak": bad[:20], "id": ids}


class NonkapBatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    klaim: list[dict] = Field(min_length=1, max_length=1000)


@router.post("/nonkapitasi")
def ingest_nonkap(req: NonkapBatchIn) -> dict:
    """Non-capitation claims in the silver contract (kontrak.NonkapIn)."""
    from aip.realtime.kontrak import NonkapIn

    p = _reader()
    objs, bad = [], []
    for i, b in enumerate(req.klaim):
        try:
            objs.append(NonkapIn.model_validate(b))
        except Exception as e:  # noqa: BLE001
            bad.append({"baris": i, "galat": str(e)[:300]})
    if bad and not objs:
        raise HTTPException(422, {"ditolak": bad[:20]})
    ids = E.ENGINE.ingest(objs, f"api:{p.get('username') or p.get('id') or 'lokal'}", jenis="nonkap")
    return {"diterima": len(ids), "ditolak": bad[:20], "id": ids}


@router.get("/modus")
def modes() -> dict:
    """The 20 modes of Permenkes 16/2019 (7 and 19 are one) as the engine detects them, with alerts and planted results."""
    from aip.realtime import modus as MO

    _reader()
    ev = SIM.evaluate(E.ENGINE, SIMULATOR)
    planted = {}
    for sk, v in (ev.get("skenario") or {}).items():
        for m in SIM.MODE_OF.get(sk, []):
            cur = planted.setdefault(m, {"instans": 0, "tertangkap": 0, "sinyal_tepat": 0, "skenario": []})
            cur["instans"] += v["instans"]
            cur["tertangkap"] += v["tertangkap"]
            cur["sinyal_tepat"] += v["sinyal_tepat"]
            cur["skenario"].append(sk)
    return {"modus": MO.catalogue(dict(E.ENGINE.signals), planted), "alert_per_modus": dict(E.ENGINE.modes)}


@router.get("/bobot")
def weights() -> dict:
    from aip.realtime import investigasi as INV

    _reader()
    return INV.weights(E.ENGINE.ensure())


@router.post("/bobot/terapkan")
def apply_weights() -> dict:
    from aip.realtime import investigasi as INV

    _admin()
    return INV.apply_weights(E.ENGINE.ensure())


@router.post("/bobot/bawaan")
def default_weights() -> dict:
    _admin()
    E.set_config(bobot={})
    return {"bobot": {}}


@router.get("/label")
def labels() -> Response:
    """The decided cases' events as labelled rows (CSV) for retraining."""
    import csv
    import io

    from aip.realtime import investigasi as INV

    _reader()
    rows = INV.labels(E.ENGINE.ensure())
    buf = io.StringIO()
    cols = ["kasus", "label", "jenis", "klaim", "faskes", "tanggal", "skor", "keputusan", "modus", "sinyal", "ml_risiko_pct"]
    w = csv.DictWriter(buf, fieldnames=cols)
    w.writeheader()
    w.writerows(rows)
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="label_kasus_realtime.csv"'})


# ------------------------------------------------------------------------------------------------
# self-supervised pretraining and active learning (ssl.py, aktif.py): MONAI Label's loop for claims
#   GET /al                      status: the SSL model, the champion, labels by source, the last simulation
#   POST /al/ssl/latih           pretrain the masked autoencoder on unlabelled claims before the window (admin)
#   GET /al/antrean              the next events to label, by strategy, each with why it was picked
#   POST /al/label               a person's label on an event (admin)
#   POST /al/latih               a challenger from the labels; promoted through the gate (admin)
#   POST /al/mode                bayangan / aktif / mati (admin)
#   POST /al/simulasi            learning curves with the simulator's oracle (admin); GET for the result
#   POST /al/simulasi/promosikan the simulation's best committee through the gate, marked as oracle-labelled (admin)
# ------------------------------------------------------------------------------------------------


@router.get("/al")
def al_status() -> dict:
    _reader()
    return E.ENGINE.ensure().al_status()


class SslLatihIn(BaseModel):
    jenis: list[Literal["fkrtl", "fktp", "nonkap"]] = Field(default_factory=lambda: ["fkrtl", "fktp", "nonkap"], min_length=1, max_length=3)


@router.post("/al/ssl/latih")
def al_ssl_train(req: Optional[SslLatihIn] = None) -> dict:
    from aip import ml as aip_ml
    from aip.realtime import ssl as SSL

    _admin()
    req = req or SslLatihIn()
    eng = E.ENGINE
    if not eng.ready():
        raise HTTPException(409, "mesin realtime belum siap")
    src = dict(getattr(eng.ref, "paths", {}) or {})
    if "fkrtl" in req.jenis:
        caches = sorted((aip_ml._dir() / "cache").glob("fitur-*.parquet"), key=lambda p: p.stat().st_mtime)
        if not caches:
            raise HTTPException(409, "tabel fitur ML belum ada: latih model ML dulu (ML Studio)")
        src["fitur"] = caches[-1].as_posix()
    if {"fktp", "nonkap"} & set(req.jenis) and not src.get("peserta"):
        raise HTTPException(409, "referensi silver (peserta, FKTP, nonkapitasi) belum dimuat mesin")

    def done(kind: str, m: object) -> None:
        eng.set_ssl(kind, m)
    SSL.train_async(list(dict.fromkeys(req.jenis)), src, str(eng.window[0]), eng.ref, done)
    return {k: v for k, v in SSL.STATE.items() if k != "hasil"}


class LabelIn(BaseModel):
    peristiwa: str = Field(min_length=3, max_length=40)
    label: Literal[0, 1]
    catatan: str = Field("", max_length=500)


@router.post("/al/label")
def al_label(req: LabelIn) -> dict:
    p = _admin()
    st = E.ENGINE.ensure().store
    if not st.event(req.peristiwa):
        raise HTTPException(404, "peristiwa tidak ada")
    st.add_labels([(req.peristiwa, req.label, "manusia", p.get("username") or p.get("id") or "admin", E._now(), req.catatan)])
    n = st.rows("SELECT count(*) FROM label")[0][0]
    return {"peristiwa": req.peristiwa, "label": req.label, "total_label": n}


@router.get("/al/antrean")
def al_queue(n: int = 20, strategi: str = "hibrida") -> dict:
    import json as _json

    import numpy as np

    from aip.realtime import aktif as AL

    _reader()
    if strategi not in AL.STRATEGIES:
        raise HTTPException(400, f"strategi: {', '.join(AL.STRATEGIES)}")
    eng = E.ENGINE.ensure()
    rows = eng.store.rows("""SELECT p.rec FROM peristiwa p LEFT JOIN label l ON l.peristiwa = p.id WHERE l.peristiwa IS NULL ORDER BY p.seq DESC LIMIT 20000""")
    evs = [_json.loads(r[0]) for r in rows]
    if not evs:
        return {"antrean": [], "pool": 0, "strategi": strategi}
    # the champion's own SSL versions (another version's embeddings are left out); without a champion, the current ones
    vers = (eng.al.meta or {}).get("ssl_versi", {}) if eng.al is not None else AL.ssl_versions(eng.ssl)
    AL.refresh(evs, eng.ssl)
    X = AL.matrix(evs, vers)
    lab = eng.store.labels()
    levs = [_json.loads(r[5]) for r in lab]
    AL.refresh(levs, eng.ssl)
    Xl = AL.matrix(levs, vers) if lab else None
    idx, why = AL.query(strategi, eng.al, X, min(max(n, 1), 100), np.random.default_rng(), Xl)
    p, sd = eng.al.predict(X[idx]) if eng.al is not None and idx else ([None] * len(idx), [None] * len(idx))
    out = []
    for i, w, pi, si in zip(idx, why, p, sd):
        b = E.Engine.brief(evs[i])
        out.append({**b, "seq": evs[i].get("seq"), "alasan_pilih": w, "p": None if pi is None else round(float(pi), 3), "sd": None if si is None else round(float(si), 3)})
    return {"antrean": out, "pool": len(evs), "strategi": strategi, "juara": (eng.al.meta or {}).get("versi") if eng.al else None}


@router.post("/al/latih")
def al_train() -> dict:
    import json as _json

    import numpy as np

    from aip.realtime import aktif as AL

    _admin()
    eng = E.ENGINE.ensure()
    lab = eng.store.labels()
    if not lab:
        raise HTTPException(409, "belum ada label: label antrean telaah atau putuskan kasus dulu")
    # the labelled events re-embedded by the current SSL models (from their raw inputs), so the champion and the stream
    # share one embedding space
    levs = [_json.loads(r[5]) for r in lab]
    AL.refresh(levs, eng.ssl)
    vers = AL.ssl_versions(eng.ssl)
    X = AL.matrix(levs, vers)
    y = np.array([int(r[1]) for r in lab])
    if y.min() == y.max():
        raise HTTPException(409, "label baru satu kelas: perlu contoh 'perlu tindakan' dan 'wajar'")
    srcs = sorted({r[2] for r in lab})
    row = AL.train_champion(X, y, " + ".join(srcs), vers)
    eng.al = AL.load_champion()
    return row


class ModeIn(BaseModel):
    mode: Literal["bayangan", "aktif", "mati"]


@router.post("/al/mode")
def al_mode(req: ModeIn) -> dict:
    _admin()
    if req.mode == "aktif" and E.ENGINE.al is None:
        raise HTTPException(409, "belum ada model juara yang lolos gerbang")
    E.set_config(al_mode=req.mode)
    return E.ENGINE.al_status()


class SimAlIn(BaseModel):
    strategi: list[str] = Field(default_factory=lambda: ["acak", "entropi", "hibrida"], min_length=1, max_length=4)
    ronde: int = Field(30, ge=2, le=60)
    per_ronde: int = Field(25, ge=5, le=200)


@router.post("/al/simulasi")
def al_simulate(req: SimAlIn) -> dict:
    from aip.realtime import aktif as AL

    _admin()
    bad = [s for s in req.strategi if s not in AL.STRATEGIES]
    if bad:
        raise HTTPException(400, f"strategi tidak dikenal: {bad}")
    eng = E.ENGINE.ensure()

    def done(res: dict, model: object) -> None:
        eng.sim_model = model
    AL.simulate_async(eng.store, req.strategi, req.ronde, req.per_ronde, done, dict(eng.ssl))
    return {"status": AL.SIM["status"]}


@router.get("/al/simulasi")
def al_simulation() -> dict:
    from aip.realtime import aktif as AL

    _reader()
    return {"status": AL.SIM["status"], "progres": AL.SIM["progres"], "galat": AL.SIM["galat"], "hasil": AL.last_simulation()}


@router.post("/al/simulasi/promosikan")
def al_promote() -> dict:
    from aip.realtime import aktif as AL

    _admin()
    eng = E.ENGINE
    if eng.sim_model is None:
        raise HTTPException(409, "jalankan simulasi dulu")
    _, X, y = eng.sim_model
    row = AL.train_champion(X, y, "simulasi (label oracle dari skenario tanam)", (AL.last_simulation() or {}).get("ssl_versi") or {})
    eng.al = AL.load_champion()
    return row


class ButirIn(BaseModel):
    medan: str = Field(min_length=1, max_length=120)
    isi: str = Field(min_length=1, max_length=400)
    dokumen: str = Field(min_length=1, max_length=300)


class PermintaanIn(BaseModel):
    pesan: str = Field("", max_length=1000)
    butir: list[ButirIn] = Field(min_length=1, max_length=10)


@router.get("/peristiwa/{eid}/permintaan")
def event_requests(eid: str) -> dict:
    """The auditor's view: whether the event came from a hospital system (only then can documents be requested), the
    requests sent and their replies, and a draft for a new one."""
    from aip.realtime import permintaan as PM

    _reader()
    eng = E.ENGINE.ensure()
    e = eng.store.event(eid)
    if not e:
        raise HTTPException(404, "peristiwa tidak ada")
    rc = PM.receipt_of_event(eng.store, e)
    return {"bisa": rc is not None, "alasan_tidak": None if rc else "hanya untuk klaim yang dikirim sistem faskes (ada tanda terima)",
            "faskes": {"sumber": rc["sumber"], "klaim": rc["klaim"], "tanda_terima": rc["id"]} if rc else None,
            "riwayat": eng.store.requests(peristiwa=eid), "draf": PM.draft(e)}


@router.post("/peristiwa/{eid}/permintaan")
def event_request_send(eid: str, req: PermintaanIn) -> dict:
    from aip.realtime import permintaan as PM

    p = _admin()
    eng = E.ENGINE.ensure()
    e = eng.store.event(eid)
    if not e:
        raise HTTPException(404, "peristiwa tidak ada")
    rc = PM.receipt_of_event(eng.store, e)
    if not rc:
        raise HTTPException(409, "peristiwa ini bukan kiriman sistem faskes: tidak ada tujuan permintaan")
    r = {"id": "pd-" + uuid.uuid4().hex[:12], "peristiwa": eid, "tanda_terima": rc["id"], "sumber": rc["sumber"], "klaim": rc["klaim"],
         "butir": [b.model_dump() for b in req.butir], "pesan": req.pesan.strip() or PM.PESAN, "status": "terkirim", "oleh": p.get("id"), "dibuat": E._now()}
    eng.store.add_request(r)
    return r


class StatusFaskesIn(BaseModel):
    sumber: str = Field(min_length=1, max_length=60)
    klaim: list[str] = Field(min_length=1, max_length=500)


@router.post("/faskes/permintaan")
def hospital_status(req: StatusFaskesIn, x_ingest_token: Optional[str] = Header(None)) -> dict:
    """A hospital system's claims: processing status (never the decision) and the auditor's requests for documents."""
    from aip.realtime import permintaan as PM

    X.check_token(x_ingest_token)
    eng = E.ENGINE.ensure()
    rcs = eng.store.receipts_of(req.sumber, req.klaim)
    evs = {e["id"]: e for e in eng.store.events_of([r["peristiwa"] for r in rcs.values() if r.get("peristiwa")])}
    reqs: dict[str, list] = {}
    for r in eng.store.requests(sumber=req.sumber, klaim=req.klaim):
        reqs.setdefault(r["klaim"], []).append(PM.for_hospital(r))
    out = {}
    for k in req.klaim:
        rc = rcs.get(k)
        out[k] = {"status": PM.status_for_hospital(rc, evs.get((rc or {}).get("peristiwa") or "")), "tanda_terima": (rc or {}).get("tanda_terima"),
                  "pada": (rc or {}).get("pada"), "alasan": (rc or {}).get("alasan") if rc and rc["status"] == "ditolak" else None,
                  "permintaan": reqs.get(k, [])}
    return {"klaim": out}


class BalasIn(BaseModel):
    sumber: str = Field(min_length=1, max_length=60)
    balasan: str = Field(min_length=1, max_length=4000)


@router.post("/faskes/permintaan/{rid}/balas")
def hospital_reply(rid: str, req: BalasIn, x_ingest_token: Optional[str] = Header(None)) -> dict:
    from aip.realtime import permintaan as PM

    X.check_token(x_ingest_token)
    r = E.ENGINE.ensure().store.reply_request(rid, req.sumber, req.balasan.strip(), E._now())
    if not r:
        raise HTTPException(404, "permintaan tidak ada untuk sistem ini")
    return PM.for_hospital(r)


@router.post("/faskes/precheck")
def hospital_precheck(req: PC.PrecheckIn, x_ingest_token: Optional[str] = Header(None)) -> dict:
    """Before submission: the documents a verifier will look for on this draft and conflicts with the hospital's own
    earlier submissions. Never a score or a decision (aip/realtime/precheck.py); every call is logged."""
    X.check_token(x_ingest_token)
    eng = E.ENGINE
    if not eng.running() or not eng.ready():
        raise HTTPException(503, "sistem audit realtime sedang tidak aktif: pre-check belum tersedia")
    if req.sumber not in X.sources():
        raise HTTPException(422, f"sumber '{req.sumber}' belum terdaftar di registri faskes sistem audit")
    if eng.resolver is None:
        from aip.realtime.entitas import Resolver

        eng.resolver = Resolver(eng.store)
    try:
        return PC.run(req, eng.store, eng.resolver, eng.los_ref, E._now())
    except ValueError as e:
        raise HTTPException(429, str(e)) from e


@router.post("/faskes/klaim")
def ingest_faskes(req: X.FaskesKlaimIn, x_ingest_token: Optional[str] = Header(None)) -> dict:
    """A hospital's submission: the patient resolved, the claim mapped to the contract and queued. The hospital gets
    a receipt; the score and decision stay with the insurer."""
    X.check_token(x_ingest_token)
    rid = "tt-" + uuid.uuid4().hex[:12]
    now = E._now()
    rec = {"id": rid, "sumber": req.sumber, "klaim": req.klaim_id, "versi": req.versi, "pada": now}
    eng = E.ENGINE
    if not eng.running() or not eng.ready():
        rec.update(status="ditolak", alasan="sistem audit realtime sedang tidak aktif: kirim ulang nanti")
        eng.store.add_receipt(rec)
        return {"tanda_terima": rid, "diterima_pada": now, "status": "ditolak", "alasan": rec["alasan"]}
    if eng.resolver is None:
        from aip.realtime.entitas import Resolver

        eng.resolver = Resolver(eng.store)
    try:
        k, meta = X.map_faskes(req, eng.resolver, eng.code_ref, eng.tarif_ref)
    except HTTPException as e:
        rec.update(status="ditolak", alasan=str(e.detail))
        eng.store.add_receipt(rec)
        return {"tanda_terima": rid, "diterima_pada": now, "status": "ditolak", "alasan": rec["alasan"]}
    meta["tanda_terima"] = rid
    ids = eng.ingest([k], f"faskes:{req.sumber}", [meta])
    # seen by the hospital's next pre-check at once, before the engine has decided it
    PC.ACCEPTED.add(req.sumber, meta["entitas"]["entitas"], req.klaim_id, req.tanggal_masuk, req.tanggal_pulang, rid)
    rec.update(status="diterima", peristiwa=ids[0])
    eng.store.add_receipt(rec)
    out = {"tanda_terima": rid, "diterima_pada": now, "status": "diterima", "versi": req.versi}
    if "rme" in meta:  # whether the medical record was readable (structure only: never what the cross-check found)
        r = meta["rme"]
        out["rekam_medis"] = {"terbaca": r["ok"], "masalah": r["masalah"][:5], "peringatan": r["peringatan"][:5]}
    if "iot_validasi" in meta:  # whether the device payload was readable (structure only: never what the device check found)
        v = meta["iot_validasi"]
        out["bukti_iot"] = {"terbaca": v["diterima"], "sesi": v["terbaca"]["sesi"], "masalah": v["masalah"][:5], "peringatan": v["peringatan"][:5]}
    return out


@router.post("/faskes/rme/validasi")
def hospital_rme_validate(req: dict, x_ingest_token: Optional[str] = Header(None)) -> dict:
    """A hospital checks its SATUSEHAT Bundle against the contract before sending claims: what was read and what is missing.
    Structure only: no cross-check against any claim, no score (aip/realtime/rme.py validasi)."""
    from aip.realtime import rme as RME

    X.check_token(x_ingest_token)
    return RME.validasi(req.get("rekam_medis", req))


@router.post("/faskes/iot/validasi")
def hospital_iot_validate(req: dict, x_ingest_token: Optional[str] = Header(None)) -> dict:
    """A hospital checks its device payload ({sesi, jangkar, alat}) against the contract before sending claims: what was read
    and what is missing. Structure only: no check against any claim, no score (aip/realtime/iot.py validasi)."""
    from aip.realtime import iot as IOT

    X.check_token(x_ingest_token)
    return IOT.validasi(req.get("iot", req))


@router.get("/iot/skema")
def iot_schema() -> dict:
    """The device-evidence contract: device kinds and modes, the thresholds, the Merkle leaf, and the IOT_* signals."""
    from aip.realtime import iot as IOT

    _reader()
    return {**IOT.katalog(), "sinyal": [{"kode": k, "label": MO.SIGNALS[k][3], "modus": MO.SIGNALS[k][0], "tag": MO.SIGNALS[k][1], "bobot": MO.SIGNALS[k][2],
                                         "jenis_bukti": IOT.JENIS_BUKTI.get(k), "aturan": IOT.ATURAN_ID.get(k)} for k in MO.IOT_SIGNALS]}


@router.get("/rme/skema")
def rme_schema() -> dict:
    """The medical-record contract: the accepted Bundle as JSON Schema, and the clinical knowledge the cross-check uses."""
    from aip.realtime import rme as RME

    _reader()
    return {"versi": RME.VERSI, "ig": RME.IG, "json_schema": RME.json_schema(), "katalog_klinis": RME.katalog_klinis(),
            "sinyal": [{"kode": k, "label": MO.SIGNALS[k][3], "modus": MO.SIGNALS[k][0], "bobot": MO.SIGNALS[k][2]} for k in MO.RME_SIGNALS]}


@router.get("/umpan")
def feed(sejak: int = 0, limit: int = 100) -> dict:
    _reader()
    rows = E.ENGINE.feed_since(sejak, min(limit, 300))
    if not rows and sejak == 0:
        rows = [E.Engine.brief(e) | {"seq": e.get("seq")} for e in reversed(E.ENGINE.store.recent(60))]
    return {"baris": rows, "seq": E.ENGINE.seq, "t": time.time()}


@router.get("/peristiwa/{eid}")
def event(eid: str) -> dict:
    _reader()
    e = E.ENGINE.store.event(eid)
    if not e:
        raise HTTPException(404, "peristiwa tidak ada")
    if e.get("entitas") and E.ENGINE.resolver:
        e["entitas_rinci"] = E.ENGINE.resolver.view(e["entitas"]["entitas"])
    lf = e.get("lapis_faskes")
    if lf:
        lf["precheck"] = PC.history(E.ENGINE.store, lf.get("sumber") or "", lf.get("kunci_draf"))
    ss = e.get("ssl")
    if ss:
        ss.pop("x", None)  # raw inputs: for re-embedding, not for the page
        m = E.ENGINE.ssl.get(e.get("jenis", "fkrtl"))
        if m is None or ss.get("versi") != m.versi:
            ss["basi"] = True  # scored by an SSL model that is no longer current
        elif "tingkat" not in ss:
            a = m.meta["ambang"]
            ss["tingkat"] = "anomali" if ss["err"] > a["p999"] else "tidak_lazim" if ss["err"] > a["p99"] else "biasa"
            ss["skala"] = [a["p50"], a["p99"], a["p999"]]
    return e


@router.get("/kasus")
def cases(status: Optional[str] = None, limit: int = 100) -> dict:
    _reader()
    xs = list(E.ENGINE.ensure().cases.values())
    if status == "terbuka":
        xs = [c for c in xs if c["status"] in ("baru", "ditelaah")]
    elif status:
        xs = [c for c in xs if c["status"] == status]
    xs.sort(key=lambda c: (c["status"] not in ("baru", "ditelaah"), -c["prioritas"]))
    slim = [{k: v for k, v in c.items() if k not in ("peristiwa", "peserta", "riwayat")} | {"klaim_terakhir": c["peristiwa"][-1:]} for c in xs[:min(limit, 500)]]
    return {"kasus": slim, "total": len(xs)}


@router.get("/kasus/{cid}")
def case(cid: str) -> dict:
    _reader()
    c = E.ENGINE.ensure().cases.get(cid)
    if not c:
        raise HTTPException(404, "kasus tidak ada")
    evs = E.ENGINE.store.events_of(c["peristiwa"][-80:])
    evs.sort(key=lambda e: e["diputus"], reverse=True)
    g = E.ENGINE.graf.ego(c["jenis"], c["kunci"]) if E.ENGINE.graf else {"nodes": [], "edges": []}
    return {**c, "klaim": evs, "graf": g}


@router.get("/kasus/{cid}/ringkasan")
def case_brief(cid: str) -> dict:
    from aip.realtime import investigasi as INV

    _reader()
    c = E.ENGINE.ensure().cases.get(cid)
    if not c:
        raise HTTPException(404, "kasus tidak ada")
    return INV.brief(E.ENGINE, c)


class KeputusanIn(BaseModel):
    keputusan: Literal["telaah", "konfirmasi", "false_positive", "buka"]
    catatan: str = Field("", max_length=2000)


@router.post("/kasus/{cid}/keputusan")
def decide(cid: str, req: KeputusanIn) -> dict:
    p = _admin()
    return E.ENGINE.decide(cid, req.keputusan, p.get("username") or p.get("id") or "admin", req.catatan)


@router.get("/graf")
def graph(jenis: Literal["faskes", "peserta", "jaringan"], kunci: str) -> dict:
    _reader()
    if not E.ENGINE.graf:
        raise HTTPException(409, "mesin belum siap")
    return E.ENGINE.graf.ego(jenis, kunci)


@router.get("/jaringan")
def network() -> dict:
    _reader()
    g = E.ENGINE.graf
    if not g:
        return {"cincin": [], "lonjakan": [], "ringkasan": None}
    bursts = [{"faskes": f, **(g.meta.get(f) or {}), **b} for f, b in g.burst.items()]
    return {"cincin": g.rings()[:30], "lonjakan": bursts[:30], "ringkasan": g.summary()}


@router.get("/entitas/{eid}")
def entity(eid: str) -> dict:
    _reader()
    if not E.ENGINE.resolver:
        raise HTTPException(404, "belum ada entitas pasien")
    v = E.ENGINE.resolver.view(eid)
    if not v:
        raise HTTPException(404, "entitas tidak ada")
    return v


class SimIn(BaseModel):
    aksi: Literal["mulai", "berhenti", "reset"]
    laju: float = Field(100.0, ge=0.5, le=500)
    otomatis: bool = True


@router.post("/simulator")
def simulator(req: SimIn) -> dict:
    _admin()
    if req.aksi == "mulai":
        if not E.ENGINE.running():
            raise HTTPException(409, "nyalakan mesin realtime dulu")
        if not E.ENGINE.ready():
            raise HTTPException(409, "mesin realtime masih memuat model dan toko fitur: tunggu sebentar")
        return SIMULATOR.start(req.laju, req.otomatis)
    if req.aksi == "berhenti":
        SIMULATOR.stop()
    else:
        SIMULATOR.reset()
    return SIMULATOR.status()


class TanamIn(BaseModel):
    skenario: str


@router.post("/simulator/tanam")
def plant(req: TanamIn) -> dict:
    _admin()
    return SIMULATOR.plant(req.skenario)


@router.get("/evaluasi")
def evaluation() -> dict:
    _reader()
    return SIM.evaluate(E.ENGINE, SIMULATOR)


@router.get("/sumber")
def registry() -> dict:
    _reader()
    return {"sumber": X.sources(), "token_ingest": bool(X.token_hash())}


class SumberIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nama: str = Field(min_length=2, max_length=200)
    kabkota_fkrtl_kode: int = Field(ge=1100, le=9999)
    kabkota_fkrtl: str = Field(max_length=120)
    provinsi_fkrtl: str = Field(max_length=120)
    kepemilikan_fkrtl: str = Field(max_length=80)
    jenis_fkrtl: Literal["Rumah sakit", "Klinik Utama"]
    tipe_fkrtl: Optional[str] = Field(None, max_length=80)
    regional_tarif: Optional[str] = Field(None, max_length=40)
    catatan: str = Field("", max_length=500)


@router.put("/sumber/{sid}")
def put_registry(sid: str, req: SumberIn) -> dict:
    _admin()
    if not sid.replace("-", "").isalnum() or len(sid) > 40:
        raise HTTPException(400, "id sumber tidak sah")
    return X.put_source(sid, {**req.model_dump(), "diperbarui": E._now()})


@router.post("/token")
def token() -> dict:
    _admin()
    return {"token": X.new_token(), "catatan": "ditampilkan sekali; simpan di AUDIT_REALTIME_TOKEN sistem faskes"}


@router.post("/box")
def box() -> dict:
    _admin()
    return E.ENGINE.rebuild_box()


class ResetIn(BaseModel):
    hapus_tag: bool = False


@router.post("/reset")
def reset(req: ResetIn) -> dict:
    _admin()
    SIMULATOR.reset()
    E.ENGINE.reset()
    out = {"reset": True}
    if req.hapus_tag:
        out.update(X.remove_tags())
    return out


# ------------------------------------------------------------------------------------------------
# user-defined rules with AI assistance (aturan_kustom.py; contract docs/RULE_ENGINE_KONTRAK.md): read = _reader(), write =
# a signed-in user, approve / reject / switch off / roll back = _admin()
#   GET  /aturan/katalog, GET /aturan, GET /aturan/log, GET /aturan/{id}
#   POST /aturan/validasi, /aturan/ai/draf, /aturan/ai/edit, /aturan/ai/perbaiki
#   POST /aturan, PUT /aturan/{id}, POST /aturan/bawaan/{kode}
#   POST /aturan/{id}/{uji|ajukan|setujui|tolak|nonaktifkan|rollback}, the same under /aturan/bawaan/{kode}/
# ------------------------------------------------------------------------------------------------


def _penulis() -> dict:
    import auth

    _reader()
    return auth.require_user()


def _oleh(p: Optional[dict], admin: bool = False) -> str:
    p = p or {}
    return str(p.get("username") or p.get("id") or ("admin" if admin else "lokal"))


class KondisiIn(BaseModel):
    kondisi: str = Field(max_length=4000)


class AiDrafIn(BaseModel):
    teks: str = Field(min_length=3, max_length=2000)


class AiEditIn(BaseModel):
    id: Optional[str] = Field(None, max_length=40)
    kode_bawaan: Optional[str] = Field(None, max_length=60)
    teks: str = Field(min_length=3, max_length=2000)


class AiPerbaikiIn(BaseModel):
    id: str = Field(min_length=3, max_length=40)


class AturanIn(BaseModel):
    model_config = ConfigDict(extra="ignore")  # a Draf from the AI can be sent as is
    kode: str = Field(min_length=3, max_length=40)
    label: str = Field(min_length=3, max_length=80)
    deskripsi: str = Field("", max_length=1000)
    kondisi: str = Field(min_length=1, max_length=4000)
    modus: list[str] = Field(default_factory=list, max_length=5)
    bobot: float
    menggantikan: Optional[str] = Field(None, max_length=60)


class BawaanUbahIn(BaseModel):
    aktif: Optional[bool] = None
    bobot: Optional[float] = None
    catatan: str = Field("", max_length=1000)


class CatatanIn(BaseModel):
    catatan: str = Field("", max_length=1000)


class TolakIn(BaseModel):
    catatan: str = Field(min_length=1, max_length=1000)


class RollbackIn(BaseModel):
    versi: int = Field(ge=1)
    catatan: str = Field("", max_length=1000)


@router.get("/aturan/katalog")
def rules_catalogue() -> dict:
    from aip.realtime import aturan_kustom as AK

    _reader()
    return AK.katalog()


@router.get("/aturan")
def rules() -> dict:
    from aip.realtime import aturan_kustom as AK

    _reader()
    return AK.daftar()


@router.get("/aturan/log")
def rules_log(limit: int = 300) -> list[dict]:
    from aip.realtime import aturan_kustom as AK

    _reader()
    return AK.log_baca(limit)


@router.post("/aturan/validasi")
def rules_validate(req: KondisiIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    _reader()
    return AK.validasi(req.kondisi)


@router.post("/aturan/ai/draf")
def rules_ai_draft(req: AiDrafIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    _penulis()
    return AK.ai_draf(req.teks)


@router.post("/aturan/ai/edit")
def rules_ai_edit(req: AiEditIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    _penulis()
    return AK.ai_edit(req.teks, req.id, req.kode_bawaan)


@router.post("/aturan/ai/perbaiki")
def rules_ai_improve(req: AiPerbaikiIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    _penulis()
    return AK.ai_perbaiki(req.id)


@router.post("/aturan")
def rules_create(req: AturanIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    return AK.buat(req.model_dump(), _oleh(p))


# built-in rules: a pending change (weight / on-off), its backtest and approval (declared before /aturan/{rid})
@router.post("/aturan/bawaan/{kode}")
def rules_builtin_change(kode: str, req: BawaanUbahIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    return AK.ubah_bawaan(kode.upper(), req.aktif, req.bobot, req.catatan, _oleh(p))


@router.post("/aturan/bawaan/{kode}/uji")
def rules_builtin_test(kode: str) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    return AK.uji("bawaan", kode.upper(), _oleh(p))


@router.post("/aturan/bawaan/{kode}/ajukan")
def rules_builtin_submit(kode: str, req: Optional[CatatanIn] = None) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    return AK.ajukan("bawaan", kode.upper(), _oleh(p), (req or CatatanIn()).catatan)


@router.post("/aturan/bawaan/{kode}/setujui")
def rules_builtin_approve(kode: str, req: Optional[CatatanIn] = None) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.setujui("bawaan", kode.upper(), _oleh(p, True), (req or CatatanIn()).catatan)


@router.post("/aturan/bawaan/{kode}/tolak")
def rules_builtin_reject(kode: str, req: TolakIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.tolak("bawaan", kode.upper(), _oleh(p, True), req.catatan)


@router.post("/aturan/bawaan/{kode}/nonaktifkan")
def rules_builtin_off(kode: str, req: Optional[CatatanIn] = None) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.nonaktifkan("bawaan", kode.upper(), _oleh(p, True), (req or CatatanIn()).catatan)


@router.post("/aturan/bawaan/{kode}/rollback")
def rules_builtin_rollback(kode: str, req: RollbackIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.rollback("bawaan", kode.upper(), req.versi, _oleh(p, True), req.catatan)


# custom rules
@router.get("/aturan/{rid}")
def rules_get(rid: str) -> dict:
    from aip.realtime import aturan_kustom as AK

    _reader()
    return AK.ambil(rid)


@router.put("/aturan/{rid}")
def rules_update(rid: str, req: AturanIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    return AK.ubah(rid, req.model_dump(), _oleh(p))


@router.delete("/aturan/{rid}")
def rules_delete(rid: str) -> dict:
    """A custom rule deleted (archived + logged); a running one by an admin only. Built-in rules are switched off instead."""
    import auth
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    admin = not auth.enabled() or (p or {}).get("role") == "admin"
    return AK.hapus(rid, _oleh(p, admin), admin)


@router.post("/aturan/{rid}/uji")
def rules_test(rid: str) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    return AK.uji("kustom", rid, _oleh(p))


@router.post("/aturan/{rid}/ajukan")
def rules_submit(rid: str, req: Optional[CatatanIn] = None) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _penulis()
    return AK.ajukan("kustom", rid, _oleh(p), (req or CatatanIn()).catatan)


@router.post("/aturan/{rid}/setujui")
def rules_approve(rid: str, req: Optional[CatatanIn] = None) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.setujui("kustom", rid, _oleh(p, True), (req or CatatanIn()).catatan)


@router.post("/aturan/{rid}/tolak")
def rules_reject(rid: str, req: TolakIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.tolak("kustom", rid, _oleh(p, True), req.catatan)


@router.post("/aturan/{rid}/nonaktifkan")
def rules_off(rid: str, req: Optional[CatatanIn] = None) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.nonaktifkan("kustom", rid, _oleh(p, True), (req or CatatanIn()).catatan)


@router.post("/aturan/{rid}/rollback")
def rules_rollback(rid: str, req: RollbackIn) -> dict:
    from aip.realtime import aturan_kustom as AK

    p = _admin()
    return AK.rollback("kustom", rid, req.versi, _oleh(p, True), req.catatan)


# ---------------------------------------------------------------------------------------------------------------------
# AI Agent Swarm Branch -> the indikasi ledger -> Box Karantina (cabang_tag.py, 2026-11-13: "perbaiki celah")
# ---------------------------------------------------------------------------------------------------------------------
class CabangTulisIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run: str = Field(pattern=r"^[a-z0-9_]{3,40}$")


class CabangPutusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run: str = Field(pattern=r"^[a-z0-9_]{3,40}$")
    kc: str = Field(pattern=r"^[a-z]{3}-\d{1,5}$")
    klaim: str = Field(pattern=r"^KLM-[0-9A-F]{8}$")
    status: Literal["terbukti", "sesuai", "investigasi", ""]
    catatan: str = Field("", max_length=1000)


@router.post("/cabang/tag")
def cabang_tag(req: CabangTulisIn) -> dict:
    """A branch run's queue as tags in the ledger (admin)."""
    from aip.realtime import cabang_tag as CT

    _admin()
    return CT.tulis(req.run)


@router.get("/cabang/tag/{run}")
def cabang_tag_ringkas(run: str) -> dict:
    from aip.realtime import cabang_tag as CT

    _reader()
    if not CT.RUN.match(run):
        raise HTTPException(400, "run tidak dikenal")
    return CT.ringkas(run)


@router.post("/cabang/putusan")
def cabang_putusan(req: CabangPutusIn) -> dict:
    """A branch verifier's decision -> the claim's tags in the ledger (signed-in user)."""
    from aip.realtime import cabang_tag as CT

    p = _penulis()
    return CT.putuskan(req.run, req.kc, req.klaim, req.status, req.catatan, _oleh(p))
