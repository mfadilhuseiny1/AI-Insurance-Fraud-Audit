"""Indications (tags) of possible fraud and their markings: the ledger the AIP fraud consultancy writes into.

Any indication, however small, becomes a tag at once. Two kinds of writer:
- the auto-tagger (penanda otomatis): the semantic layer's rules (aip/semantik.py) applied to every object the caller
  can see: each claim the screening rules or the model flagged, each facility above its peer class, each region, code,
  referral path and member with a signal. Deterministic: the same data gives the same tags.
- the agents of an AIP run (the consultancy's analysts): one object, or every row of a result, but only objects that
  appear in a result that run produced (checked here against the run's stored result): an agent cannot tag what was
  never read.

One tag per (entity, key, tag); every writer that raises it adds a source (who, which model family, how strong, the
evidence). The strength shown is computed, never asserted: the strongest source; one level up when at least three
sources of at least two families (the rules, model families) agree; one level down when the red team weakened it;
strong when a person confirmed it. Tags never change claims or facilities, and agents never decide them: a person
confirms or dismisses each one (admin). That decision is the gate.

Markings: every tag holds "Indikasi Fraud · Internal"; strong or confirmed ones also "Indikasi Fraud · Rahasia". On
the Nexus type they are a mandatory-control property (a viewer needs every marking a tag holds), the backing dataset
carries Internal, and this API applies the same rule to its own listings. POST /siapkan (admin) creates the markings,
held by their creator and the platform administrators.

    GET  /api/aip/semantik                     the semantic layer with type ids for the caller
    POST /api/aip/semantik/cari                {istilah}: what a business term means here
    POST /api/aip/indikasi                     one tag from an agent of a running run (evidence-checked)
    POST /api/aip/indikasi/hasil               every row of one of the run's results tagged
    POST /api/aip/indikasi/red-team            the red team's verdict on a tag (bertahan / melemah)
    POST /api/aip/indikasi/otomatis            the auto-tagger (admin)
    GET  /api/aip/indikasi                     the tags the caller may see (filters)
    GET  /api/aip/indikasi/ringkasan           counts by tag, strength, entity and province; the most-tagged facilities
    GET  /api/aip/indikasi/{id}                one tag with every source
    POST /api/aip/indikasi/{id}/keputusan      a person's decision: dikonfirmasi / ditolak / terbuka (admin)
    POST /api/aip/indikasi/siapkan             markings and Nexus types (admin)
    POST /api/aip/indikasi/sinkron             the tags written to the Nexus now (admin; runs also sync when they end)
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from aip import semantik as S

router = APIRouter(prefix="/api/aip")
log = logging.getLogger("aip.indikasi")

LEVELS = {"lemah": 1, "sedang": 2, "kuat": 3}
NAMES = {v: k for k, v in LEVELS.items()}
MARK_INTERNAL = "Indikasi Fraud · Internal"
MARK_SECRET = "Indikasi Fraud · Rahasia"
GROUP = ("AI Agent Swarm (AIP)",
         "AI Agent Swarm AIP: indikasi (tag) dari penanda otomatis dan agen konsultan (analis wilayah, spesialis modus, analis "
         "peer, sub-agen teknik ML, penyidik kasus, QA dan red team), taksonomi tag Permenkes 16/2019 dan lapisan semantik (ukuran, istilah).")
GROUP_OLD = "Agen Konsultan Fraud (AIP)"  # the group's name until 2026-10-24 (the sync renames it in place)
BRAND = "AI Agent Swarm"  # in the Nexus type names below (the user, 2026-10-24: "change Konsultan Fraud to AI Agent Swarm")
OLD_BRANDS = ("Konsultan Fraud", "Konsultan AI")  # their earlier names, renamed in place by the sync
DS_TAGS = "indikasi_fraud_konsultan.parquet"
DS_TAXONOMY = "tag_indikasi_semantik.parquet"
DS_MEASURES = "ukuran_semantik.parquet"
DS_BOX = "karantina_faskes_konsultan.parquet"
T_TAXONOMY = "Tag Indikasi Fraud (Semantik)"
T_MEASURES = "Ukuran Semantik (AIP)"
T_BOX = "Karantina Faskes (AI Agent Swarm)"
KEEP_SOURCES = 40  # sources kept per tag (the count of distinct agents is kept separately)
INT_KEYS = ("provinsi_kode", "kabkota_kode", "tingkat", "dukungan")
SYNC_DELAY = 45  # seconds a burst of tags waits before the Nexus is rewritten
# result columns that can carry each entity's key
KEY_COLUMNS = {"klaim": ["klaim_id"], "faskes": ["faskes_profil_id"], "provinsi": ["provinsi_kode", "provinsi", "group"],
               "kabkota": ["kabkota_kode", "kabkota", "group"], "inacbg": ["inacbg_kode", "group"], "peserta": ["peserta_key"],
               "rujukan": ["alur_rujukan_id"], "diagnosis": ["icd3", "dx_primer_icd3", "group"]}
CONTEXT = ("faskes_profil_id", "klaim_id", "provinsi", "provinsi_kode", "kabkota", "kabkota_kode", "inacbg_kode", "nama_profil", "biaya_tagih_rp", "bulan")
TITLE_COLUMNS = ("nama_profil", "judul", "_judul", "nama", "deskripsi", "inacbg_deskripsi", "kabkota", "provinsi", "group")

_lock = threading.RLock()
_tags: Optional[dict[str, dict]] = None
_con: Optional[sqlite3.Connection] = None
_sync = {"timer": None, "running": False, "last": None, "error": None}


def _dir() -> Path:
    from aip import vertex as aip_vertex

    d = aip_vertex.DIR.parent / "indikasi"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _db() -> sqlite3.Connection:
    global _con
    if _con is None:
        _con = sqlite3.connect(_dir() / "indikasi.sqlite", timeout=30, check_same_thread=False)
        _con.execute("PRAGMA journal_mode=WAL")
        _con.execute("CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, rec TEXT NOT NULL, updated TEXT)")
        _con.execute("CREATE TABLE IF NOT EXISTS sumber (seq INTEGER PRIMARY KEY AUTOINCREMENT, indikasi_id TEXT, t TEXT, rec TEXT)")
        _con.commit()
    return _con


def _all() -> dict[str, dict]:
    global _tags
    with _lock:
        if _tags is None:
            _tags = {i: json.loads(r) for i, r in _db().execute("SELECT id, rec FROM tags")}
        return _tags


def _save(recs: list[dict], sources: list[tuple[str, dict]]) -> None:
    with _lock:
        con = _db()
        con.executemany("INSERT OR REPLACE INTO tags (id, rec, updated) VALUES (?, ?, ?)",
                        [(r["id"], json.dumps(r, ensure_ascii=False, default=str), r["diperbarui_pada"]) for r in recs])
        if sources:
            con.executemany("INSERT INTO sumber (indikasi_id, t, rec) VALUES (?, ?, ?)",
                            [(i, s.get("t"), json.dumps(s, ensure_ascii=False, default=str)) for i, s in sources])
        con.commit()


_state_memo: dict[str, Any] = {}


def _state() -> dict:
    """markings, nexus, otomatis: read once per process (this module is its only writer)."""
    if "v" not in _state_memo:
        try:
            _state_memo["v"] = json.loads((_dir() / "state.json").read_text("utf-8"))
        except (OSError, ValueError):
            _state_memo["v"] = {}
    return _state_memo["v"]


def _put_state(**kv: Any) -> dict:
    from aip.runs import _write

    with _lock:
        st = {**_state(), **kv}
        _write(_dir() / "state.json", st)
        _state_memo["v"] = st
    return st


# ------------------------------------------------------------------------------------------------
# a tag: its id, its computed strength and markings
# ------------------------------------------------------------------------------------------------


def tag_id(entitas: str, kunci: Any, tag: str) -> str:
    return "ind-" + hashlib.sha1(f"{entitas}|{kunci}|{tag}".encode()).hexdigest()[:14]


def _family(model: str) -> str:
    if not model or model == "aturan":
        return "aturan"
    from aip import models as aip_models

    return aip_models.family(model)


def view(rec: dict) -> dict:
    """The tag as shown: its strength computed from its sources, red team and decision; its markings."""
    srcs = rec.get("sumber") or []
    base = max((LEVELS.get(s.get("kekuatan"), 1) for s in srcs), default=1)
    agents = sorted({s["agen"] for s in srcs})
    fams = sorted({_family(s.get("model", "")) for s in srcs})
    n_agents = max(len(agents), int(rec.get("dukungan_total") or 0))
    level, why = base, [f"sumber terkuat: {NAMES[base]}"]
    if n_agents >= 3 and len(fams) >= 2 and level < 3:
        level += 1
        why.append(f"konsensus {n_agents} sumber dari {len(fams)} keluarga ({', '.join(fams)})")
    rt = rec.get("red_team") or {}
    if rt.get("hasil") == "melemah" and level > 1:
        level -= 1
        why.append("dilemahkan red team")
    if rec.get("status") == "dikonfirmasi":
        level = 3
        why.append("dikonfirmasi manusia")
    secret = level == 3 or rec.get("status") == "dikonfirmasi"
    st = _state().get("markings") or {}
    marks = [m for m in ([st.get("internal")] + ([st.get("rahasia")] if secret else [])) if m]
    best = max(srcs, key=lambda s: (LEVELS.get(s.get("kekuatan"), 1), len(s.get("bukti") or "")), default={})
    t = S.TAG.get(rec["tag"], {})
    return {**{k: v for k, v in rec.items() if k != "sumber"}, "tag_label": t.get("label", rec["tag"]), "modus": t.get("modus", ""),
            "permenkes": bool(t.get("permenkes")), "kekuatan": NAMES[level], "tingkat": level, "alasan_kekuatan": "; ".join(why),
            "dukungan": n_agents, "agen_pendukung": agents[:20], "keluarga_model": fams, "otomatis": any(s["agen"] == "penanda_otomatis" for s in srcs),
            "bukti": best.get("bukti", ""), "klasifikasi": "Rahasia" if secret else "Internal", "marking": marks,
            "sumber_terakhir": srcs[-1] if srcs else None}


REVIEW_AGENT = "telaah_klinis"  # Blu 1.1's clinical review (aip/telaah.py AGENT)


def review_only(v: dict) -> bool:
    """A claim tag (a view) that only Blu 1.1's clinical review raised: a lead, not evidence of loss — the Box counts no
    loss or TSM from it until another source (a rule, an agent, the model) tags the claim too (aip/karantina.py)."""
    return v.get("entitas") == "klaim" and set(v.get("agen_pendukung") or []) == {REVIEW_AGENT}


def standing(rec: dict) -> bool:
    """A tag no person has rejected: what the box, the reports and the audit pack count. A rejected tag stays in the
    trail with its decision (the listing, a claim's data trail, Nexus) but is evidence of nothing — the 13 COVID cloning
    tags rejected on 2026-10-28 still sized the box until this."""
    return rec.get("status") != "ditolak"


def _visible(v: dict, have: Optional[set]) -> bool:
    if have is None:
        return True
    import auth

    return auth.satisfies(set(v.get("marking") or []), have)


def _viewer_markings() -> Optional[set]:
    """The caller's markings, or None when markings do not apply (sign-in off, the platform's own work)."""
    import auth

    p = auth.current()
    if p is None or p.get("service") or not auth.enabled():
        return None
    return set(p.get("markings") or set())


def upsert(entitas: str, kunci: Any, tag: str, source: dict, judul: str = "", konteks: Optional[dict] = None,
           tipe: Optional[str] = None, save: bool = True) -> tuple[dict, bool]:
    """Add one source to a tag (creating the tag); the same agent raising it again replaces its earlier source."""
    if tag not in S.TAG:
        raise HTTPException(400, f"tag '{tag}' tidak dikenal; pilihan: {', '.join(S.TAG)}")
    if entitas not in S.ENTITAS:
        raise HTTPException(400, f"entitas '{entitas}' tidak dikenal; pilihan: {', '.join(S.ENTITAS)}")
    if source.get("kekuatan") not in LEVELS:
        raise HTTPException(400, "kekuatan harus lemah, sedang atau kuat")
    kunci = str(kunci)
    iid = tag_id(entitas, kunci, tag)
    now = _now()
    source = {**source, "t": now}
    with _lock:
        tags = _all()
        rec = tags.get(iid)
        new = rec is None
        if new:
            rec = {"id": iid, "tag": tag, "entitas": entitas, "tipe": tipe or S.ENTITAS[entitas]["tipe"], "kunci": kunci, "judul": judul or kunci,
                   "konteks": {}, "sumber": [], "red_team": None, "status": "terbuka", "keputusan": None, "dibuat_pada": now}
        if judul and rec["judul"] == rec["kunci"]:
            rec["judul"] = judul
        rec["konteks"] = {**rec.get("konteks", {}), **{k: v for k, v in (konteks or {}).items() if v not in (None, "")}}
        same = lambda s: s["agen"] == source["agen"] and (source["agen"] != "penanda_otomatis" or s.get("aturan") == source.get("aturan"))  # noqa: E731
        rec["sumber"] = [s for s in rec["sumber"] if not same(s)] + [source]
        rec["dukungan_total"] = len({s["agen"] for s in rec["sumber"]})
        rec["sumber"] = rec["sumber"][-KEEP_SOURCES:]
        rec["diperbarui_pada"] = now
        if source.get("run_id"):
            rec["run_terakhir"] = source["run_id"]
        tags[iid] = rec
        if save:
            _save([rec], [(iid, source)])
    return rec, new


# ------------------------------------------------------------------------------------------------
# the evidence an agent's tag must point to: a result its own run produced
# ------------------------------------------------------------------------------------------------


def _run_result(run_id: str, rid: str) -> dict:
    from aip import runs

    rec = runs.check_access(run_id)
    if rec.get("status") != "running":
        raise HTTPException(409, "run sudah selesai: tag hanya dari run yang sedang berjalan")
    if not rid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(400, "hasil_id tidak sah")
    f = runs._dir() / run_id / "results" / f"{rid}.json"
    for _ in range(30):  # the run's reader may still be writing it
        if f.is_file():
            try:
                return json.loads(f.read_text("utf-8"))
            except ValueError:
                pass
        time.sleep(0.1)
    raise HTTPException(404, f"hasil {rid} tidak ada di run ini: tag harus menunjuk hasil yang dibaca run ini")


def _names(tipe: str, key: str, title: str) -> dict[str, str]:
    """{name (upper): key} of a type's objects (provinces and kab/kota are often named, not coded, in results)."""
    import ontology

    t = next((x for x in ontology._all("object-types") if x["display_name"] == tipe), None)
    if not t:
        return {}
    out = {}
    for pk, o in ontology._objects(t["id"]).items():
        name = (o.get("properties") or {}).get(title)
        if name:
            out[str(name).upper()] = str((o.get("properties") or {}).get(key, pk))
    return out


def _canonical(entitas: str, kunci: Any) -> str:
    k = str(kunci).strip()
    if entitas in ("provinsi", "kabkota") and not k.isdigit():
        names = _names(S.T_PROV, "provinsi_kode", "provinsi") if entitas == "provinsi" else _names(S.T_KAB, "kabkota_kode", "kabkota")
        return names.get(k.upper(), k)
    return k


def _row_of(res: dict, entitas: str, kunci: str) -> Optional[dict]:
    cols = list(KEY_COLUMNS.get(entitas, []))
    ot = (res.get("object_type") or {}).get("name")
    ent = S.ENTITAS[entitas]
    if ot in [ent["tipe"], *ent.get("juga", [])]:
        cols.append("_kunci")
    want = str(kunci).strip().upper()
    for r in res.get("rows") or []:
        for c in cols:
            v = r.get(c)
            if v is not None and str(v).strip().upper() == want:
                return r
    return None


def _context(row: dict) -> tuple[str, dict]:
    title = next((str(row[c]) for c in TITLE_COLUMNS if row.get(c) not in (None, "")), "")
    return title, {c: row.get(c) for c in CONTEXT if row.get(c) not in (None, "")}


class TagIn(BaseModel):
    run_id: str
    agen: str = Field(min_length=1, max_length=80)
    peran: str = Field("", max_length=160)
    model: str = Field("", max_length=120)
    entitas: str
    kunci: str = Field(min_length=1, max_length=200)
    tag: str
    kekuatan: str = "lemah"
    bukti: str = Field(min_length=10, max_length=2000)
    hasil_id: str = Field(min_length=2, max_length=20)


def _entitas(e: str) -> str:
    """The entity a tag is on: its name, or the name of its key column (an agent wrote entitas="faskes_profil_id"); an
    unknown one is the caller's error, not the server's (it reached S.ENTITAS[...] and answered 500, 2026-10-23)."""
    e = (e or "").strip().lower()
    if e in S.ENTITAS:
        return e
    alias = next((k for k, v in S.ENTITAS.items() if e == v["kunci"] or e in KEY_COLUMNS.get(k, []) and e != "group"), None)
    if alias:
        return alias
    raise HTTPException(400, f"entitas '{e}' tidak dikenal; pilihan: {', '.join(S.ENTITAS)} (tipe faskes, kelas, modus bukan entitas: "
                             "tandai faskes/klaim/wilayahnya satu per satu)")


@router.post("/indikasi")
def tag_one(req: TagIn) -> dict:
    """One tag from an agent of a running run: the object must appear in the run's result `hasil_id`."""
    req.entitas = _entitas(req.entitas)
    res = _run_result(req.run_id, req.hasil_id)
    kunci = _canonical(req.entitas, req.kunci)
    row = _row_of(res, req.entitas, req.kunci) or (_row_of(res, req.entitas, kunci) if kunci != req.kunci else None)
    if row is None and req.entitas in ("provinsi", "kabkota") and kunci.isdigit():
        # a region by its code where the result names it ("3671" in a ranking of KOTA TANGERANG …: 11 tags refused, 2026-10-28)
        names = _names(S.T_PROV, "provinsi_kode", "provinsi") if req.entitas == "provinsi" else _names(S.T_KAB, "kabkota_kode", "kabkota")
        row = next((r for name, code in names.items() if code == kunci for r in [_row_of(res, req.entitas, name)] if r), None)
    if row is None:
        raise HTTPException(422, f"{req.entitas} '{req.kunci}' tidak ada di hasil {req.hasil_id} ({res.get('title')}): "
                                 "tandai hanya objek yang ada di hasil yang Anda baca")
    why = refused(req.entitas, kunci, req.tag)
    if why:
        raise HTTPException(422, f"{req.entitas} '{req.kunci}' tidak ditandai {req.tag}: {why}")
    title, ctx = _context(row)
    src = {"agen": req.agen, "peran": req.peran, "model": req.model, "kekuatan": req.kekuatan, "bukti": req.bukti, "run_id": req.run_id, "rid": req.hasil_id}
    rec, new = upsert(req.entitas, kunci, req.tag, src, title, ctx)
    _schedule_sync()
    v = view(rec)
    return {"id": rec["id"], "baru": new, "kekuatan": v["kekuatan"], "dukungan": v["dukungan"], "keluarga_model": v["keluarga_model"],
            "klasifikasi": v["klasifikasi"], "judul": v["judul"], "alasan_kekuatan": v["alasan_kekuatan"]}


class TagResultIn(BaseModel):
    run_id: str
    agen: str = Field(min_length=1, max_length=80)
    peran: str = Field("", max_length=160)
    model: str = Field("", max_length=120)
    entitas: str
    tag: str
    kekuatan: str = "lemah"
    bukti: str = Field(min_length=10, max_length=2000)
    hasil_id: str = Field(min_length=2, max_length=20)
    batas: int = Field(500, ge=1, le=500)


@router.post("/indikasi/hasil")
def tag_result(req: TagResultIn) -> dict:
    """Every row of a result of the run tagged (the weak-signal sweep: whatever an agent's read surfaced is kept)."""
    req.entitas = _entitas(req.entitas)
    res = _run_result(req.run_id, req.hasil_id)
    cols = KEY_COLUMNS.get(req.entitas, [])
    rows = (res.get("rows") or [])[: req.batas]
    recs, srcs, new, skipped, gated = [], [], 0, 0, []
    silent = 0
    for r in rows:
        if "value" in r and not (isinstance(r["value"], (int, float)) and not isinstance(r["value"], bool) and r["value"] > 0):
            # a ranking's row with nothing to measure is no indication: Audit Nasional 1.1 swept 756 such rows of 2,302 (KLAIM_GANDA
            # on facilities with 0 candidate duplicates, LOS_DIPERPANJANG "kuat" on 0 extreme stays), 57% of the province lines'
            silent += 1
            continue
        key = next((r.get(c) for c in cols if r.get(c) not in (None, "")), None)
        if key is None and (res.get("object_type") or {}).get("name") in [S.ENTITAS[req.entitas]["tipe"], *S.ENTITAS[req.entitas].get("juga", [])]:
            key = r.get("_kunci")
        if key is None:
            skipped += 1
            continue
        why = refused(req.entitas, _canonical(req.entitas, key), req.tag)
        if why:
            gated.append(str(key))
            continue
        title, ctx = _context(r)
        src = {"agen": req.agen, "peran": req.peran, "model": req.model, "kekuatan": req.kekuatan, "bukti": req.bukti, "run_id": req.run_id,
               "rid": req.hasil_id}
        rec, is_new = upsert(req.entitas, _canonical(req.entitas, key), req.tag, src, title, ctx, save=False)
        recs.append(rec)
        srcs.append((rec["id"], {**src, "t": rec["diperbarui_pada"]}))
        new += is_new
    if not recs:
        if gated:
            raise HTTPException(422, f"tidak ada yang ditandai {req.tag}: {refused(req.entitas, gated[0], req.tag)} ({len(gated)} objek)")
        if silent:
            raise HTTPException(422, f"tidak ada yang ditandai {req.tag}: {silent} baris {req.hasil_id} bernilai 0 (tanpa sinyal)")
        raise HTTPException(422, f"tidak ada kolom kunci {req.entitas} ({', '.join(cols)}) di hasil {req.hasil_id}")
    _save(recs, srcs)
    _schedule_sync()
    out = {"ditandai": len(recs), "baru": new, "dilewati": skipped, "tag": req.tag, "kekuatan": req.kekuatan,
           **({"dilewati_tanpa_sinyal": silent} if silent else {})}
    if gated:
        out["ditolak_gerbang"] = {"jumlah": len(gated), "contoh": gated[:5], "alasan": refused(req.entitas, gated[0], req.tag)}
    return out


class RowTag(BaseModel):
    kunci: str = Field(min_length=1, max_length=200)
    tag: str
    kekuatan: str = "lemah"
    bukti: str = Field(min_length=10, max_length=2000)


class TagRowsIn(BaseModel):
    run_id: str
    agen: str = Field(min_length=1, max_length=80)
    peran: str = Field("", max_length=160)
    model: str = Field("", max_length=120)
    entitas: str
    hasil_id: str = Field(min_length=2, max_length=20)
    baris: list[RowTag] = Field(min_length=1, max_length=500)


@router.post("/indikasi/baris")
def tag_rows(req: TagRowsIn) -> dict:
    """Rows of one result of the run, each with its own tag and evidence (Blu 1.1's clinical review: one verdict per
    claim), written at once; every object must be in the result and pass the code's gates, as for one tag."""
    req.entitas = _entitas(req.entitas)
    res = _run_result(req.run_id, req.hasil_id)
    recs, srcs, new, missing, gated = [], [], 0, [], []
    for b in req.baris:  # (checked before upsert, which changes the in-memory ledger: an exception halfway would leave it unsaved)
        if b.tag.strip().upper() not in S.TAG or b.kekuatan not in LEVELS:
            raise HTTPException(400, f"tag '{b.tag}' atau kekuatan '{b.kekuatan}' tidak dikenal")
    for b in req.baris:
        tag = b.tag.strip().upper()
        kunci = _canonical(req.entitas, b.kunci)
        row = _row_of(res, req.entitas, b.kunci)
        if row is None:
            missing.append(b.kunci)
            continue
        if refused(req.entitas, kunci, tag):
            gated.append(b.kunci)
            continue
        title, ctx = _context(row)
        src = {"agen": req.agen, "peran": req.peran, "model": req.model, "kekuatan": b.kekuatan, "bukti": b.bukti, "run_id": req.run_id, "rid": req.hasil_id}
        rec, is_new = upsert(req.entitas, kunci, tag, src, title, ctx, save=False)
        recs.append(rec)
        srcs.append((rec["id"], {**src, "t": rec["diperbarui_pada"]}))
        new += is_new
    if recs:
        _save(recs, srcs)
        _schedule_sync()
    return {"ditandai": len(recs), "baru": new, "tidak_ada_di_hasil": len(missing), "ditolak_gerbang": len(gated), "contoh_tidak_ada": missing[:5]}


class RedTeamIn(BaseModel):
    run_id: str
    agen: str
    model: str = ""
    indikasi_id: str
    hasil: str = Field(pattern="^(bertahan|melemah)$")
    alasan: str = Field(min_length=10, max_length=2000)


@router.post("/indikasi/red-team")
def red_team(req: RedTeamIn) -> dict:
    """The red team's verdict, after it looked for the honest explanation (class, case-mix, a legitimate repeat)."""
    from aip import runs

    if runs.check_access(req.run_id).get("status") != "running":
        raise HTTPException(409, "run sudah selesai")
    with _lock:
        rec = _all().get(req.indikasi_id)
        if not rec:
            raise HTTPException(404, "indikasi tidak ada")
        rec["red_team"] = {"hasil": req.hasil, "alasan": req.alasan, "agen": req.agen, "model": req.model, "run_id": req.run_id, "t": _now()}
        rec["diperbarui_pada"] = _now()
        _save([rec], [(rec["id"], {"agen": req.agen, "red_team": req.hasil, "bukti": req.alasan, "run_id": req.run_id, "t": _now()})])
    _schedule_sync()
    v = view(rec)
    return {"id": rec["id"], "kekuatan": v["kekuatan"], "alasan_kekuatan": v["alasan_kekuatan"]}


# ------------------------------------------------------------------------------------------------
# the auto-tagger: the semantic layer's rules over every object the caller can see
# ------------------------------------------------------------------------------------------------


def _objects(tipe: str) -> list[dict]:
    import ontology

    t = next((x for x in ontology._all("object-types") if x["display_name"] == tipe), None)
    if not t:
        return []
    return [{"_kunci": pk, **(o.get("properties") or {})} for pk, o in ontology._objects(t["id"]).items() if ontology._can_see(t, o)]


def _pct_rank(values: list[float]) -> list[float]:
    """Each value's percentile within its list (ties share the lower rank)."""
    order = sorted(values)
    import bisect

    n = len(order)
    return [bisect.bisect_left(order, v) / max(n - 1, 1) for v in values]


def _by_class(rows: list[dict], cls: str, metric: Any, min_n: int = 10) -> dict[int, float]:
    """{row index: percentile of metric(row) within its class}, for classes with at least min_n rows."""
    groups: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        m = metric(r)
        if m is not None:
            groups.setdefault(str(r.get(cls) or "—"), []).append(i)
    out: dict[int, float] = {}
    for idx in groups.values():
        if len(idx) < min_n:
            continue
        ranks = _pct_rank([metric(rows[i]) for i in idx])
        out.update(zip(idx, ranks))
    return out


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


COVID_NOTE = ("; klaim pasien COVID-19 (skema klaim COVID, tarif per hari, bukan INA-CBG): pembanding peer tidak setara, "
              "kemungkinan besar wajar (negatif sulit)")
# a bill this far beyond its INA-CBG package + top-ups is an amount the tariff does not explain; below it, rounding (98
# claims of the sample bill 1–100 rupiah over)
SISA_MIN = 1000


def _rp(v: float) -> str:
    return "Rp" + f"{v:,.0f}".replace(",", ".")


def covid_scheme(klaim_id: Any) -> bool:
    """A COVID-19 patient claim (ids with "ICC"): paid by the COVID scheme's per-day tariff, not INA-CBG, so its INA-CBG
    peers are no yardstick (a hard negative of the evaluation kit)."""
    return "ICC" in str(klaim_id or "")


def refused(entitas: str, kunci: Any, tag: str) -> Optional[str]:
    """Why a tag may not be written on this object (a gate in code, the same for the rules and the agents), or None.
    Cloning on a COVID-19 scheme claim: that scheme pays per day, so identical stays of different patients bill
    identically by design — the cloning rule skips them, and an agent's tag would mark a false lead (the agents of
    run-328344d8c6e4 tagged 13 such claims, 2026-10-24)."""
    if tag == "KLONING_KLAIM" and entitas == "klaim" and covid_scheme(kunci):
        return ("klaim skema COVID-19 dibayar per hari (bukan INA-CBG): klaim identik antarpasien wajar di skema itu, "
                "jadi tidak ditandai cloning (aturan penanda otomatis juga mengecualikannya)")
    if tag == "KOREKSI_BERULANG" and entitas == "faskes":
        # a pattern of corrections needs corrections: Audit Nasional 1 (2026-10-28) tagged facilities with 0 or 1, one of
        # them "kuat" on a ratio of 20x that was 1 correction against an expectation of 0.05
        r = _ml_facility(str(kunci))
        n = int(_f((r or {}).get("koreksi_aktual")) or 0)
        if r is not None and n < 2:
            return (f"koreksi aktual faskes ini {n} (ekspektasi model {_f(r.get('ekspektasi_koreksi')) or 0:.2f}): pola koreksi butuh >= 2 klaim dikoreksi; "
                    "rasio aktual/ekspektasi dengan ekspektasi < 1 tidak stabil (lapisan semantik)")
    return None


_mlf_cache: dict[str, Any] = {"t": 0.0, "rows": {}}
_mlf_lock = threading.Lock()


def _ml_facility(fid: str) -> Optional[dict]:
    """A facility's row of Risiko Faskes ML (BPJS), from a table read at most every 10 minutes (the gate runs per tag);
    None when the table cannot be read (no gate then, rather than no tag)."""
    with _mlf_lock:
        if time.time() - _mlf_cache["t"] > 600:
            try:
                _mlf_cache["rows"] = {str(r.get("faskes_profil_id") or r["_kunci"]): r for r in _objects(S.T_ML_FASKES)}
            except Exception:  # noqa: BLE001 - the caller may not see the type
                return None
            _mlf_cache["t"] = time.time()
        return _mlf_cache["rows"].get(fid)


def _clone_clusters() -> list[dict]:
    """Inpatient claims identical across different participants of one facility and year: the diagnosis, the INA-CBG
    code, the procedures, the length of stay (>= 2 days) and the bill, when the bill is not the package tariff. Read as
    the caller from the silver claims, outside the COVID-19 per-day scheme (calibrated on the sample 2026-10-23)."""
    import tempfile

    import duckdb

    import ml_klaim
    from aip import ml as aip_ml

    item = aip_ml._source()
    with tempfile.TemporaryDirectory(prefix="bsai-klon-") as tmp:
        path = aip_ml._local(item, Path(tmp))
        con = duckdb.connect()
        try:
            rows = con.execute(f"""
                SELECT edisi || ':' || kunjungan_fkrtl_id, peserta_id, {ml_klaim.PROFILE_ID}, year(tgl_datang), strftime(tgl_datang, '%Y-%m'),
                       coalesce(dx_primer_icd3, ''), coalesce(inacbg_kode, ''), coalesce(prosedur, ''), los_hari, biaya_tagih_rp,
                       coalesce(jumlah_dx_sekunder, 0), provinsi_fkrtl, kabkota_fkrtl, kabkota_fkrtl_kode, jenis_fkrtl, tipe_fkrtl, kepemilikan_fkrtl
                FROM read_parquet('{Path(path).as_posix()}')
                WHERE tingkat_pelayanan = 'RITL' AND los_hari >= 2 AND biaya_tagih_rp <> tarif_inacbg_rp
                  -- the COVID-19 scheme pays per day, not by INA-CBG: identical stays bill identically there by design
                  AND NOT coalesce(layanan_covid, false) AND edisi <> 'covid' AND kunjungan_fkrtl_id NOT LIKE '%ICC%'""").fetchall()
        finally:
            con.close()
    groups: dict[tuple, list[tuple]] = {}
    for r in rows:
        groups.setdefault((r[2], r[3], r[5], r[6], r[7], r[8], r[9], r[10]), []).append(r)
    out = []
    for (fid, year, dx, code, proc, los, bill, _ndx), rs in groups.items():
        people = {r[1] for r in rs}
        if len(people) < 2:
            continue
        months: dict[str, set] = {}
        for r in rs:
            months.setdefault(r[4], set()).add(r[1])
        f = rs[0]
        name = " · ".join(str(x) for x in ("FKRTL", f[14], f[15], f[16], f[12]) if x)
        out.append({"tahun": year, "dx": dx, "inacbg": code, "prosedur": proc, "los_hari": int(los), "tagih": int(bill), "peserta": len(people),
                    "maks_sebulan": max(len(v) for v in months.values()), "klaim": [(r[0], r[4]) for r in rs],
                    "row": {"faskes_profil_id": fid, "provinsi": f[11], "kabkota": f[12], "kabkota_kode": f[13], "inacbg_kode": code, "nama_profil": name}})
    return out


def autotag(log_fn: Any = None, hanya: Optional[set] = None) -> dict:
    """Apply every rule; returns counts per rule. Each rule's tag is one source "penanda_otomatis" per (rule, object);
    a rule that no longer holds for an object loses its source (and a tag left with no source and no decision goes).
    `hanya`: only these sections (A klaim, B ml, C ml_faskes, D profil, E wilayah, F kode, G rujukan, H peserta, I kloning) — Blu 3.0
    passes the four its v3 data profile holds, so the baseline tables (a whole year) put no facility in its box."""
    say = log_fn or (lambda m: None)
    ok = (lambda sec: True) if not hanya else (lambda sec: sec in hanya)  # noqa: E731
    recs: dict[str, dict] = {}
    srcs: list[tuple[str, dict]] = []
    counts: dict[str, int] = {}
    asserted: set[tuple[str, str]] = set()

    def add(rule: str, entitas: str, key: Any, tag: str, level: str, bukti: str, row: dict, title: str = "") -> None:
        if key in (None, ""):
            return
        t, ctx = _context(row)
        src = {"agen": "penanda_otomatis", "peran": "Penanda otomatis (aturan lapisan semantik)", "model": "aturan", "aturan": rule,
               "kekuatan": level, "bukti": bukti}
        rec, _ = upsert(entitas, _canonical(entitas, key) if entitas in ("provinsi", "kabkota") else key, tag, src, title or t, ctx, save=False)
        recs[rec["id"]] = rec
        srcs.append((rec["id"], {**src, "t": rec["diperbarui_pada"]}))
        counts[rule] = counts.get(rule, 0) + 1
        asserted.add((rec["id"], rule))

    # A. the claims the screening rules flagged
    klaim = _objects(S.T_KLAIM) if ok("klaim") else []
    say(f"klaim berisiko: {len(klaim)}")
    for r in klaim:
        k, multi = r.get("klaim_id") or r["_kunci"], (r.get("jumlah_indikasi") or 0) >= 2
        lvl = "sedang" if multi else "lemah"
        name = f"{r.get('klaim_id')} · {r.get('inacbg_kode') or ''} · {r.get('kabkota') or ''}"
        if r.get("flag_calon_klaim_ganda"):
            add("klaim_calon_ganda", "klaim", k, "KLAIM_GANDA", lvl, "aturan skrining: calon klaim ganda (peserta, faskes, tanggal sama)" +
                (f"; {r['jumlah_indikasi']} indikasi pada klaim ini" if multi else ""), r, name)
        if r.get("flag_los_ekstrem"):
            los, p90 = _f(r.get("los_hari")), _f(r.get("peer_los_inap_p90"))
            strong = los and p90 and los > 2 * p90
            add("klaim_los_ekstrem", "klaim", k, "LOS_DIPERPANJANG", "sedang" if (strong or multi) else "lemah",
                f"LOS {los:.0f} hari di atas p99 kodenya" + (f" (p90 peer {p90:.0f} hari)" if p90 else "") if los else "aturan: LOS ekstrem", r, name)
        if r.get("flag_selisih_verifikasi"):
            add("klaim_dikoreksi", "klaim", k, "KOREKSI_BERULANG", lvl,
                f"dikoreksi verifikator: selisih Rp{(_f(r.get('selisih_rp')) or 0):,.0f}".replace(",", "."), r, name)
        if r.get("readmisi_30"):
            add("klaim_readmisi", "klaim", k, "READMISI", "lemah", "rawat ulang <= 30 hari setelah pulang", r, name)
        # The grouper prices a claim: its INA-CBG package + the special CMG top-ups, alike within a tariff table (the peer
        # since pipeline v8: code, RS type, region, ownership, care class, tariff year). So a bill is inflated by an amount
        # beyond that tariff, or by a special drug/prosthesis/procedure top-up; a bill above its peers through a
        # sub-acute/chronic top-up is a long stay. Upcoding moves a claim to another code or severity, so a claim against
        # its own code cannot show it (facility case mix, rule D).
        ratio, peers = _f(r.get("rasio_biaya_peer")), _f(r.get("peer_klaim")) or 0
        covid = covid_scheme(k)
        tagih, sisa = _f(r.get("biaya_tagih_rp")) or 0, _f(r.get("sisa_di_luar_tarif_rp")) or 0
        khusus, subakut = _f(r.get("topup_khusus_rp")) or 0, _f(r.get("topup_subakut_rp")) or 0
        if sisa > SISA_MIN and tagih:
            add("klaim_di_atas_tarif", "klaim", k, "TAGIHAN_MELEBIHI_TARIF", "sedang" if sisa >= 0.2 * tagih and not covid else "lemah",
                f"tagihan {_rp(sisa)} di luar tarif INA-CBG + top-up special CMG ({sisa / tagih:.0%} dari tagihan {_rp(tagih)})"
                + (COVID_NOTE if covid else ""), r, name)
        if ratio and ratio >= 1.5 and peers >= 30:
            if khusus > 0:
                add("klaim_topup_khusus", "klaim", k, "TAGIHAN_MELEBIHI_TARIF", "lemah" if covid or ratio < 3 else "sedang",
                    f"tagihan {ratio:.1f}x median peer setarif ({int(peers)} klaim): top-up obat/prostesis/prosedur/investigasi khusus {_rp(khusus)}, "
                    f"ada di {(_f(r.get('peer_pct_topup_khusus')) or 0):.1f}% klaim peer" + (COVID_NOTE if covid else ""), r, name)
            elif subakut > 0:
                add("klaim_topup_subakut", "klaim", k, "LOS_DIPERPANJANG", "lemah",
                    f"tagihan {ratio:.1f}x median peer setarif karena top-up subakut/kronis {_rp(subakut)} (lama rawat {(_f(r.get('los_hari')) or 0):.0f} hari)"
                    + (COVID_NOTE if covid else ""), r, name)

    # B. the claims the model flagged
    ml = _objects(S.T_ML_KLAIM) if ok("ml") else []
    say(f"klaim skor ML: {len(ml)}")
    for r in ml:
        k = r.get("klaim_id") or r["_kunci"]
        v3 = r.get("segmen_model") == "arsitektur_v3"  # Blu 3.0's data profile: a fraud probability, not a verifier-correction probability
        if r.get("lolos_verifikasi_berisiko"):
            add("ml_lolos_verifikasi", "klaim", k, "LOLOS_VERIFIKASI_BERISIKO", "sedang",
                (f"model v3: peluang fraud {(_f(r.get('risiko_pct')) or 0):.1f}% tetapi pemeriksaan otomatis meloloskan; {r.get('alasan_utama') or ''}" if v3 else
                 f"model: peluang koreksi {(_f(r.get('risiko_pct')) or 0):.1f}% (0,1% teratas segmen) tetapi tidak dikoreksi; {r.get('alasan_utama') or ''}"), r)
        elif r.get("ditandai"):
            top = (r.get("peringkat_segmen") or 10**9) <= 100
            add("ml_ditandai", "klaim", k, "RISIKO_ML_TINGGI", "sedang" if top else "lemah",
                (f"model v3: peluang fraud {(_f(r.get('risiko_pct')) or 0):.1f}%, peringkat {r.get('peringkat_segmen')}; {r.get('alasan_utama') or ''}" if v3 else
                 f"model: peluang koreksi {(_f(r.get('risiko_pct')) or 0):.1f}%, peringkat {r.get('peringkat_segmen')} di segmennya; {r.get('alasan_utama') or ''}"), r)

    # C. facilities by the model, against their peer class
    mf = _objects(S.T_ML_FASKES) if ok("ml_faskes") else []
    say(f"faskes ML: {len(mf)}")
    pr = _by_class(mf, "tipe_fkrtl", lambda r: _f(r.get("risiko_per_1000_klaim")) if (r.get("klaim") or 0) >= 200 else None)
    for i, r in enumerate(mf):
        k = r.get("faskes_profil_id") or r["_kunci"]
        ratio, exp = _f(r.get("rasio_aktual_ekspektasi")), _f(r.get("ekspektasi_koreksi")) or 0
        if ratio and ratio >= 2 and exp >= 1:
            add("faskes_koreksi_vs_ekspektasi", "faskes", k, "KOREKSI_BERULANG", "kuat" if (ratio >= 4 and exp >= 2) else "sedang",
                f"koreksi aktual {r.get('koreksi_aktual')} vs ekspektasi model {exp:.1f} ({ratio:.1f}x)", r)
        lolos = _f(r.get("berisiko_lolos_verifikasi")) or 0
        if lolos >= 1:
            add("faskes_lolos_verifikasi", "faskes", k, "LOLOS_VERIFIKASI_BERISIKO", "kuat" if lolos >= 10 else "sedang" if lolos >= 3 else "lemah",
                f"{lolos:.0f} klaim berisiko tinggi menurut model lolos verifikasi", r)
        if i in pr and pr[i] >= 0.90:
            q = pr[i]
            add("faskes_outlier_peer", "faskes", k, "OUTLIER_PEER", "kuat" if q >= 0.99 else "sedang" if q >= 0.97 else "lemah",
                f"risiko per 1.000 klaim {(_f(r.get('risiko_per_1000_klaim')) or 0):.2f}, persentil {q * 100:.0f} di antara {r.get('tipe_fkrtl')}", r)

    # D. facilities by the screening counts, against their peer class
    pf = [r for r in (_objects(S.T_FASKES) if ok("profil") else []) if r.get("tingkat") == "FKRTL"]
    say(f"profil faskes FKRTL: {len(pf)}")
    rules = [("faskes_readmisi", "READMISI", lambda r: _f(r.get("pct_readmisi_30")) if (r.get("klaim_inap") or 0) >= 50 else None, "readmisi 30 hari {v:.1f}%"),
             ("faskes_los_ekstrem", "LOS_DIPERPANJANG", lambda r: (r.get("los_ekstrem") or 0) / r["klaim_inap"] if (r.get("klaim_inap") or 0) >= 50 else None,
              "porsi LOS ekstrem {v:.2%} dari rawat inap"),
             ("faskes_calon_ganda", "KLAIM_GANDA", lambda r: (r.get("calon_klaim_ganda") or 0) / r["klaim_fkrtl"] if (r.get("klaim_fkrtl") or 0) >= 200 else None,
              "porsi calon klaim ganda {v:.2%}"),
             # upcoding: a case mix heavier than facilities of the same type (severity III comes from the coded diagnoses)
             ("faskes_keparahan_berat", "UPCODING_KEPARAHAN", lambda r: _f(r.get("pct_keparahan_berat")) if (r.get("klaim_inap") or 0) >= 50 else None,
              "rawat inap keparahan III {v:.1f}%")]
    for rule, tag, metric, text in rules:
        ranks = _by_class(pf, "tipe", metric)
        for i, q in ranks.items():
            if q >= 0.95 and (metric(pf[i]) or 0) > 0:
                r = pf[i]
                add(rule, "faskes", r.get("faskes_profil_id") or r["_kunci"], tag, "sedang" if q >= 0.99 else "lemah",
                    text.format(v=metric(r)) + f", persentil {q * 100:.0f} di antara {r.get('tipe')}", r)

    # E. regions
    kab = _objects(S.T_KAB) if ok("wilayah") else []
    for rule, metric, text in (("kabkota_calon_ganda", lambda r: (r.get("calon_klaim_ganda") or 0) / r["klaim_fkrtl"] if (r.get("klaim_fkrtl") or 0) >= 1000 else None,
                                "porsi calon klaim ganda {v:.2%}"),
                               ("kabkota_los_ekstrem", lambda r: (r.get("los_ekstrem") or 0) / r["klaim_inap"] if (r.get("klaim_inap") or 0) >= 500 else None,
                                "porsi LOS ekstrem {v:.2%}")):
        vals = [(i, metric(r)) for i, r in enumerate(kab) if metric(r) is not None]
        ranks = dict(zip([i for i, _ in vals], _pct_rank([v for _, v in vals])))
        for i, q in ranks.items():
            if q >= 0.95:
                r = kab[i]
                add(rule, "kabkota", r.get("kabkota_kode") or r["_kunci"], "KONSENTRASI_WILAYAH", "lemah",
                    text.format(v=metric(r)) + f", persentil {q * 100:.0f} dari {len(vals)} kab/kota", r, str(r.get("kabkota")))

    # F. INA-CBG codes: LOS extremes and corrections far above the other codes (volume >= 100 claims)
    ind = [r for r in (_objects(S.T_INDIKATOR) if ok("kode") else []) if (r.get("klaim") or 0) >= 100]
    for rule, prop, tag, text in (("kode_los_ekstrem", "pct_los_ekstrem", "LOS_DIPERPANJANG", "LOS ekstrem {v:.1f}% klaim kode ini ({tipe}, {reg})"),
                                  ("kode_koreksi", "pct_selisih_verifikasi", "KOREKSI_BERULANG", "{v:.1f}% klaim kode ini dikoreksi ({tipe}, {reg})")):
        vals = [(i, _f(r.get(prop))) for i, r in enumerate(ind) if _f(r.get(prop))]
        ranks = dict(zip([i for i, _ in vals], _pct_rank([v for _, v in vals])))
        for i, q in ranks.items():
            if q >= 0.99:
                r = ind[i]
                add(rule, "inacbg", r.get("inacbg_kode"), tag, "lemah", text.format(v=_f(r.get(prop)), tipe=r.get("tipe_fkrtl"), reg=r.get("regional_tarif")),
                    r, f"{r.get('inacbg_kode')} · {r.get('inacbg_deskripsi') or ''}")

    # G. referral paths with a diagnosis rarely the same at both ends
    ruj = [r for r in (_objects(S.T_RUJUKAN) if ok("rujukan") else []) if (r.get("rujukan") or 0) >= 30 and _f(r.get("pct_dx_sama")) is not None]
    if ruj:
        ranks = dict(zip(range(len(ruj)), _pct_rank([_f(r["pct_dx_sama"]) for r in ruj])))
        for i, q in ranks.items():
            if q <= 0.05:
                r = ruj[i]
                add("rujukan_dx_beda", "rujukan", r.get("alur_rujukan_id") or r["_kunci"], "RUJUKAN_SEMU", "lemah",
                    f"{r.get('rujukan')} rujukan {r.get('kabkota_asal')} → {r.get('kabkota_tujuan')}, diagnosis sama hanya {_f(r['pct_dx_sama']):.1f}%",
                    r, f"{r.get('kabkota_asal')} → {r.get('kabkota_tujuan')}")

    # H. members: many risky claims; a care class above the member's entitlement
    peserta = _objects(S.T_PESERTA) if ok("peserta") else []
    hak = {}
    for r in peserta:
        k = r.get("peserta_key") or r["_kunci"]
        hak[k] = r.get("kelas_rawat")
        n = r.get("klaim_berisiko") or 0
        if n >= 3:
            add("peserta_klaim_berulang", "peserta", k, "PEMECAHAN_EPISODE", "sedang" if n >= 6 else "lemah", f"{n} klaim berisiko pada satu peserta", r,
                f"peserta {r.get('peserta_id') or k}")
        if r.get("flag_tgl_lahir_pengganti") and n >= 2:
            add("peserta_tgl_lahir_pengganti", "peserta", k, "KLAIM_FIKTIF", "lemah", f"tanggal lahir pengganti dan {n} klaim berisiko", r,
                f"peserta {r.get('peserta_id') or k}")
    # the claim writes "Kelas 1", the participant's entitlement "KELAS I" (until 2026-10-27 only the first was read, so the
    # rule never matched)
    rank = {"Kelas 1": 1, "Kelas 2": 2, "Kelas 3": 3, "KELAS I": 1, "KELAS II": 2, "KELAS III": 3}
    for r in klaim:
        own, used = rank.get(str(hak.get(r.get("peserta_key")))), rank.get(str(r.get("kelas_rawat")))
        if own and used and used < own:
            add("klaim_kelas_di_atas_hak", "klaim", r.get("klaim_id") or r["_kunci"], "KELAS_RAWAT", "lemah",
                f"dirawat di {r.get('kelas_rawat')} sedangkan hak peserta {hak.get(r.get('peserta_key'))}", r)

    # I. cloning: inpatient claims copied across participants (aip/semantik.py KLONING_KLAIM), from the silver claims
    try:
        clones = _clone_clusters() if ok("kloning") else []
    except Exception as e:  # noqa: BLE001 - the other rules stand without it; said in the counts
        clones = []
        say(f"aturan klaim kembar dilewati: {type(e).__name__}: {str(e)[:200]}")
        counts["klaim_kembar_lintas_peserta (dilewati)"] = 0
    say(f"klaster klaim kembar lintas peserta: {len(clones)}")
    per_fac: dict[str, list[dict]] = {}
    for c in clones:
        strong = (not c["prosedur"] and c["los_hari"] >= 7) or c["maks_sebulan"] >= 4
        bukti = (f"{c['peserta']} peserta berbeda dengan klaim identik di faskes ini ({c['tahun']}): diagnosis {c['dx'] or '-'}, INA-CBG {c['inacbg']}, "
                 f"prosedur {c['prosedur'][:80] or '-'}, lama rawat {c['los_hari']} hari, tagihan Rp{c['tagih']:,} (bukan tarif paket)").replace(",", ".")
        for kid, bulan in c["klaim"]:
            add("klaim_kembar_lintas_peserta", "klaim", kid, "KLONING_KLAIM", "sedang" if strong else "lemah", bukti,
                {**c["row"], "klaim_id": kid, "bulan": bulan, "biaya_tagih_rp": c["tagih"]}, f"{kid} · {c['inacbg']} · {c['row'].get('kabkota') or ''}")
        per_fac.setdefault(c["row"]["faskes_profil_id"], []).append({**c, "strong": strong})
    for fid, cs in per_fac.items():
        n = sum(len(c["klaim"]) for c in cs)
        add("faskes_klaim_kembar", "faskes", fid, "KLONING_KLAIM", "sedang" if any(c["strong"] for c in cs) or len(cs) >= 3 else "lemah",
            f"{len(cs)} klaster klaim kembar lintas peserta ({n} klaim) — rekam medisnya perlu dibandingkan", cs[0]["row"])

    # what the rules no longer say: their sources go; a tag left without sources (and undecided) goes with them
    stale, gone = [], []
    with _lock:
        tags = _all()
        for iid, rec in list(tags.items()):
            keep = [s for s in rec.get("sumber") or [] if s["agen"] != "penanda_otomatis" or (iid, s.get("aturan")) in asserted]
            if len(keep) == len(rec.get("sumber") or []):
                continue
            rec["sumber"] = keep
            rec["dukungan_total"] = len({s["agen"] for s in keep})
            if not keep and not rec.get("keputusan"):
                gone.append(iid)
                tags.pop(iid)
                recs.pop(iid, None)
            else:
                rec["diperbarui_pada"] = _now()
                stale.append(rec)
        if gone:
            _db().executemany("DELETE FROM tags WHERE id = ?", [(i,) for i in gone])
            _db().commit()
    _save(list(recs.values()) + [r for r in stale if r["id"] not in recs], srcs)
    _put_state(otomatis={"pada": _now(), "aturan": counts, "tag": len(recs), "dicabut": len(gone), "sumber_dicabut": len(stale)})
    _schedule_sync()
    return {"aturan": counts, "tag_tersentuh": len(recs), "tag_dicabut": len(gone), "total_tag": len(_all())}


# ------------------------------------------------------------------------------------------------
# the Nexus: markings, types, the datasets
# ------------------------------------------------------------------------------------------------


def setup() -> dict:
    """The two markings (held by their creator and the administrators) and the Nexus types. Idempotent."""
    import auth

    have = {m["name"]: m["id"] for m in auth._markings()}
    ids = {}
    for key, name, color, desc in (("internal", MARK_INTERNAL, "#b7791f", "Indikasi fraud dari penanda otomatis dan agen konsultan AIP (belum diputuskan)"),
                                   ("rahasia", MARK_SECRET, "#c0392b", "Indikasi fraud kuat atau dikonfirmasi: kandidat investigasi")):
        ids[key] = have.get(name) or auth.create_marking(auth.MarkingIn(name=name, color=color, description=desc))["id"]
    granted = []
    for u in auth._users():
        if u.get("role") == "admin" and not set(ids.values()) <= set(u.get("markings") or []):
            u["markings"] = sorted(set(u.get("markings") or []) | set(ids.values()))
            auth._save_user(u)
            granted.append(u.get("username"))
    _put_state(markings=ids)
    nexus = sync(force=True)
    return {"markings": ids, "diberikan_ke_admin": granted, "nexus": nexus}


def _frames() -> tuple[Any, Any, Any]:
    import pandas as pd

    rows = []
    for rec in _all().values():
        v = view(rec)
        c = v.get("konteks") or {}

        def num(x: Any) -> Optional[int]:
            try:
                return int(x)
            except (TypeError, ValueError):
                return None
        rows.append({"indikasi_id": v["id"], "judul": f"{v['tag_label']} · {v['judul']}"[:300], "tag": v["tag"], "tag_label": v["tag_label"], "modus": v["modus"],
                     "entitas": v["entitas"], "tipe_objek": v["tipe"], "kunci": v["kunci"], "nama_objek": v["judul"],
                     "faskes_profil_id": c.get("faskes_profil_id") or (v["kunci"] if v["entitas"] == "faskes" else None),
                     "klaim_id": c.get("klaim_id") or (v["kunci"] if v["entitas"] == "klaim" else None),
                     "provinsi": c.get("provinsi"), "provinsi_kode": num(c.get("provinsi_kode") or (v["kunci"] if v["entitas"] == "provinsi" else None)),
                     "kabkota_kode": num(c.get("kabkota_kode") or (v["kunci"] if v["entitas"] == "kabkota" else None)),
                     "inacbg_kode": c.get("inacbg_kode") or (v["kunci"] if v["entitas"] == "inacbg" else None),
                     "kekuatan": v["kekuatan"], "tingkat": v["tingkat"], "alasan_kekuatan": v["alasan_kekuatan"], "dukungan": v["dukungan"],
                     "agen_pendukung": v["agen_pendukung"] or None, "keluarga_model": v["keluarga_model"] or None, "otomatis": v["otomatis"],
                     "bukti": v["bukti"][:2000], "red_team": (v.get("red_team") or {}).get("hasil") or "belum", "status": v["status"],
                     "klasifikasi": v["klasifikasi"], "marking": v["marking"] or None, "run_terakhir": v.get("run_terakhir"),
                     "dibuat_pada": v["dibuat_pada"], "diperbarui_pada": v["diperbarui_pada"]})
    tags = pd.DataFrame(rows)
    for c in INT_KEYS:  # integer keys stay integers with gaps (a float key fails the Nexus links)
        if c in tags:
            tags[c] = tags[c].astype("Int64")
    tax = pd.DataFrame([{"tag": k, "label": t["label"], "modus": t["modus"], "permenkes": t["permenkes"], "entitas": ", ".join(t["entitas"]),
                         "sinyal": t["sinyal"], "ukuran": ", ".join(t["ukuran"])} for k, t in S.TAG.items()])
    meas = pd.DataFrame([{"ukuran": k, "label": u["label"], "tipe_objek": u["tipe"], "metrik": u["metrik"], "properti": u["properti"] or "",
                          "filter": json.dumps(u["filter"], ensure_ascii=False), "satuan": u["satuan"], "arti": u["arti"], "catatan": u["catatan"],
                          "tag": ", ".join(u["tag"])} for k, u in S.UKURAN.items()])
    return tags, tax, meas


def _parquet(df: Any) -> bytes:
    import io

    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    return buf.getvalue()


def sync(force: bool = False) -> dict:
    """The tags, the taxonomy and the measures written to their datasets and re-imported into the Nexus."""
    import auth
    import ontology
    import ontology_datasources as ods
    import ontology_model as om

    from aip import ml as aip_ml

    st = _state()
    marks = st.get("markings") or {}
    if not marks.get("internal"):
        return {"status": "belum disiapkan (POST /api/aip/indikasi/siapkan)"}
    with _lock:
        if _sync["running"] and not force:
            return {"status": "sedang berjalan"}
        _sync["running"] = True
    try:
        tags, tax, meas = _frames()
        if tags.empty:
            return {"status": "belum ada tag"}
        src = aip_ml._source()
        folder = aip_ml._out_folder()
        from aip import karantina

        items = {"tags": aip_ml._put_dataset(folder, DS_TAGS, _parquet(tags), src), "tax": aip_ml._put_dataset(folder, DS_TAXONOMY, _parquet(tax), src),
                 "meas": aip_ml._put_dataset(folder, DS_MEASURES, _parquet(meas), src)}
        box = karantina.frame()
        if not box.empty:
            items["box"] = aip_ml._put_dataset(folder, DS_BOX, _parquet(box), src)
        for key in ("tags", "box"):
            if key in items:
                own, _inh = auth._item_row(items[key])
                if marks["internal"] not in own:
                    auth._set_item(items[key], own=sorted(set(own) | {marks["internal"]}))
        groups = {g["name"]: g["id"] for g in om._groups()}
        if GROUP[0] not in groups and GROUP_OLD in groups:  # named "Agen Konsultan Fraud (AIP)" until 2026-10-24: renamed in place (same id)
            with ontology._lock:
                om._write(ontology.DIR / "groups.json", [{**g, "name": GROUP[0], "description": GROUP[1]} if g["name"] == GROUP_OLD else g for g in om._groups()])
            groups = {g["name"]: g["id"] for g in om._groups()}
        gid = groups.get(GROUP[0]) or om.create_group(om.GroupIn(name=GROUP[0], description=GROUP[1]))["id"]
        allowed = [m for m in (marks.get("internal"), marks.get("rahasia")) if m]
        specs = {
            "tags": (S.T_INDIKASI, "IndikasiFraudKonsultanAi", "indikasi_id", "judul", "flag", "#c0392b",
                     "Indikasi fraud (tag) dari penanda otomatis dan agen konsultan AIP: satu per objek × tag, dengan kekuatan terhitung, dukungan "
                     "agen, bukti, red team dan keputusan manusia. Marking per baris (kontrol wajib): Internal; Rahasia untuk yang kuat/dikonfirmasi.",
                     [ontology.Property(api_name="marking", display_name="Marking", type="marking", array=True, mandatory_control=True,
                                        allowed_markings=allowed, visibility="normal")]),
            "tax": (T_TAXONOMY, "TagIndikasiFraudSemantik", "tag", "label", "tag", "#b7791f",
                    "Taksonomi tag indikasi lapisan semantik AIP: modus kecurangan Permenkes 16/2019 yang sinyalnya terlihat di data, dan sinyal model.", []),
            "meas": (T_MEASURES, "UkuranSemantikAip", "ukuran", "label", "calculator", "#2b6cb0",
                     "Ukuran lapisan semantik AIP: definisi tunggal tiap angka (tipe objek, agregasi, properti, filter) yang dipakai semua agen.", []),
            "box": (T_BOX, "KarantinaFaskesKonsultanAi", "faskes_profil_id", "nama", "lock", "#8e44ad",
                    "Box karantina: faskes berindikasi, dikelompokkan menurut estimasi kerugian (A prioritas … Z kecil), dengan penilaian TSM "
                    "(terstruktur, sistematis, masif), rekomendasi agen penyidik dan keputusan audit (dibina / ditindak / dibebaskan).",
                    [ontology.Property(api_name="marking", display_name="Marking", type="marking", array=True, mandatory_control=True,
                                       allowed_markings=allowed, visibility="normal")]),
        }
        types = {}
        for key, (display, api, pk, title, icon, color, desc, extra) in specs.items():
            if key not in items:
                continue
            t = next((x for x in ontology._all("object-types") if x["display_name"] == display), None)
            olds = {display.replace(f"({BRAND})", f"({b})") for b in OLD_BRANDS} - {display}
            legacy = None if t else next((x for x in ontology._all("object-types") if x["display_name"] in olds), None)
            if legacy:  # named "(Konsultan AI)" until 2026-10-23, "(Konsultan Fraud)" until 2026-10-24: renamed in place, the api_name (and every link to it) stays
                t = ontology.update_object_type(legacy["id"], ontology.ObjectTypeIn.model_construct(display_name=display, plural_name=display))
            wrong = {p["api_name"] for p in (t or {}).get("properties") or [] if p["api_name"] in INT_KEYS and p.get("type") == "double"}
            if t and wrong:  # integer keys imported as doubles (before 2026-10-23): retyped, so the links to Provinsi and Kab/Kota hold
                props = [ontology.Property(**{k: v for k, v in {**p, **({"type": "integer"} if p["api_name"] in wrong else {})}.items()
                                              if k in ontology.Property.model_fields}) for p in t["properties"]]
                ontology.update_object_type(t["id"], ontology.ObjectTypeIn.model_construct(properties=props))
                t = ontology._object_type(t["id"])
            if not t:
                props = [ontology.Property(api_name=pk, display_name=pk.replace("_", " ").capitalize(), type="string", render_hints=["searchable", "identifier"]),
                         ontology.Property(api_name=title, display_name=title.replace("_", " ").capitalize(), type="string", render_hints=["searchable"]), *extra]
                t = ontology.create_object_type(ontology.ObjectTypeIn(display_name=display, plural_name=display, api_name=api, primary_key=pk, title_property=title,
                                                                       icon=icon, color=color, description=desc, properties=props, groups=[gid], status="active"))
            types[key] = t["id"]
            ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=items[key], columns=None, map_unmapped=True))
        names = {x.get("display_name") for x in ontology._all("link-types")}
        links = [("Indikasi pada profil faskes", "faskes_profil_id", S.T_FASKES, "Indikasi fraud", "Profil faskes"),
                 ("Indikasi pada klaim berisiko", "klaim_id", S.T_KLAIM, "Indikasi fraud", "Klaim berisiko"),
                 ("Indikasi di provinsi", "provinsi_kode", S.T_PROV, "Indikasi fraud", "Provinsi"),
                 ("Indikasi di kabupaten/kota", "kabkota_kode", S.T_KAB, "Indikasi fraud", "Kabupaten/kota"),
                 ("Indikasi bertag", "tag", T_TAXONOMY, "Indikasi fraud", "Tag indikasi"),
                 ("Karantina profil faskes", "faskes_profil_id", S.T_FASKES, "Karantina faskes", "Profil faskes", "box"),
                 ("Indikasi faskes di karantina", "faskes_profil_id", T_BOX, "Indikasi fraud", "Karantina faskes")]
        made = []
        for name, fk, target, src_label, tgt_label, *source in links:
            tgt = next((x for x in ontology._all("object-types") if x["display_name"] == target), None)
            src_type = types.get(source[0] if source else "tags")
            if name in names or not tgt or not src_type:
                continue
            om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key=fk, status="active",
                                              source=om.LinkSide(object_type_id=src_type, display_name=src_label, plural_display_name=src_label),
                                              target=om.LinkSide(object_type_id=tgt["id"], display_name=tgt_label)))
            made.append(name)
        out = {"status": "tersinkron", "pada": _now(), "tag": len(tags), "datasets": items, "types": types, "group_id": gid, "link_baru": made}
        _sync.update(last=out["pada"], error=None)
        _put_state(nexus=out)
        return out
    except Exception as e:  # noqa: BLE001 - the ledger stands; the Nexus view is retried at the next sync
        log.exception("indikasi: Nexus sync failed")
        _sync["error"] = str(getattr(e, "detail", None) or e)[:500]
        return {"status": "gagal", "error": _sync["error"]}
    finally:
        _sync["running"] = False


def _schedule_sync() -> None:
    """A burst of tags is written to the Nexus once, SYNC_DELAY seconds after it began, as the caller."""
    if not (_state().get("markings") or {}).get("internal"):
        return
    with _lock:
        if _sync["timer"] is not None:
            return
        ctx = contextvars.copy_context()

        def fire() -> None:
            _sync["timer"] = None
            ctx.run(sync)
        _sync["timer"] = threading.Timer(SYNC_DELAY, fire)
        _sync["timer"].daemon = True
        _sync["timer"].start()


# ------------------------------------------------------------------------------------------------
# routes for people (and the agents' reads)
# ------------------------------------------------------------------------------------------------


def _admin() -> None:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "butuh admin")


@router.get("/semantik")
def semantic_layer() -> dict:
    import ontology

    ids = {}
    for t in ontology._all("object-types"):
        ids[t["display_name"]] = t["id"]
    return S.catalogue(ids)


class TermIn(BaseModel):
    istilah: str = Field(min_length=1, max_length=200)


@router.post("/semantik/cari")
def semantic_term(req: TermIn) -> dict:
    return {"istilah": req.istilah, "hasil": S.resolve(req.istilah)}


@router.get("/aturan")
def rules_catalogue() -> dict:
    """Every rule and fact behind the fraud indications, explained, with its latest count (aip/aturan.py)."""
    from aip import aturan

    return aturan.catalogue()


class AutotagIn(BaseModel):
    hanya: Optional[list[str]] = None  # Blu 3.0: only the sections its data profile holds (autotag)


@router.post("/indikasi/otomatis")
def run_autotag(req: Optional[AutotagIn] = None) -> dict:
    _admin()
    return autotag(log.info, set(req.hanya) if req and req.hanya else None)


@router.post("/indikasi/siapkan")
def prepare() -> dict:
    _admin()
    return setup()


@router.post("/indikasi/sinkron")
def sync_now() -> dict:
    _admin()
    return sync(force=True)


def _filtered(tag: Optional[str], entitas: Optional[str], kekuatan: Optional[str], status: Optional[str], faskes: Optional[str],
              provinsi: Optional[str], q: Optional[str], run_id: Optional[str], sumber: Optional[str]) -> list[dict]:
    have = _viewer_markings()
    min_level = LEVELS.get(kekuatan or "", 0)
    out = []
    for rec in list(_all().values()):
        if tag and rec["tag"] != tag or entitas and rec["entitas"] != entitas or status and rec.get("status") != status:
            continue
        c = rec.get("konteks") or {}
        if faskes and faskes not in (c.get("faskes_profil_id"), rec["kunci"]):
            continue
        if provinsi and str(provinsi).upper() not in (str(c.get("provinsi") or "").upper(), str(c.get("provinsi_kode") or "")):
            continue
        if run_id and not any(s.get("run_id") == run_id for s in rec.get("sumber") or []):
            continue
        v = view(rec)
        if v["tingkat"] < min_level or not _visible(v, have):
            continue
        if sumber == "agen" and not any(s["agen"] != "penanda_otomatis" for s in rec.get("sumber") or []):
            continue
        if sumber == "otomatis" and not v["otomatis"]:
            continue
        if q and q.lower() not in f"{v['judul']} {v['bukti']} {v['kunci']}".lower():
            continue
        out.append(v)
    return out


@router.get("/indikasi")
def list_tags(tag: Optional[str] = None, entitas: Optional[str] = None, kekuatan: Optional[str] = None, status: Optional[str] = None,
              faskes: Optional[str] = None, provinsi: Optional[str] = None, q: Optional[str] = None, run_id: Optional[str] = None,
              sumber: Optional[str] = None, limit: int = 100, offset: int = 0) -> dict:
    rows = _filtered(tag, entitas, kekuatan, status, faskes, provinsi, q, run_id, sumber)
    rows.sort(key=lambda v: (-v["tingkat"], -v["dukungan"], v["diperbarui_pada"]), reverse=False)
    limit = max(1, min(limit, 1000))
    return {"total": len(rows), "tags": rows[offset: offset + limit], "markings": _state().get("markings"), "nexus": _state().get("nexus"),
            "otomatis": _state().get("otomatis")}


@router.get("/indikasi/ringkasan")
def summary(run_id: Optional[str] = None) -> dict:
    rows = _filtered(None, None, None, None, None, None, None, run_id, None)
    rejected = sum(not standing(v) for v in rows)  # counted apart: the summary is of the tags that stand
    rows = [v for v in rows if standing(v)]
    by_tag: dict[str, dict[str, int]] = {}
    by_ent: dict[str, int] = {}
    by_prov: dict[str, int] = {}
    fac: dict[str, dict] = {}
    agents: dict[str, int] = {}
    for v in rows:
        by_tag.setdefault(v["tag"], {"lemah": 0, "sedang": 0, "kuat": 0})[v["kekuatan"]] += 1
        by_ent[v["entitas"]] = by_ent.get(v["entitas"], 0) + 1
        c = v.get("konteks") or {}
        if c.get("provinsi"):
            by_prov[c["provinsi"]] = by_prov.get(c["provinsi"], 0) + 1
        fid = c.get("faskes_profil_id") or (v["kunci"] if v["entitas"] == "faskes" else None)
        if fid:
            f = fac.setdefault(fid, {"faskes_profil_id": fid, "nama": c.get("nama_profil") or (v["judul"] if v["entitas"] == "faskes" else ""),
                                     "provinsi": c.get("provinsi"), "tag": 0, "bobot": 0, "kuat": 0, "jenis_tag": set()})
            f["tag"] += 1
            f["bobot"] += v["tingkat"]
            f["kuat"] += v["tingkat"] == 3
            f["jenis_tag"].add(v["tag"])
            if not f["nama"] and v["entitas"] == "faskes":
                f["nama"] = v["judul"]
        for a in v["agen_pendukung"]:
            agents[a] = agents.get(a, 0) + 1
    top = sorted(fac.values(), key=lambda f: (-f["kuat"], -len(f["jenis_tag"]), -f["bobot"]))[:30]
    for f in top:
        f["jenis_tag"] = sorted(f["jenis_tag"])
    return {"total": len(rows), "per_tag": [{"tag": k, "label": S.TAG[k]["label"], **c, "total": sum(c.values())} for k, c in
                                           sorted(by_tag.items(), key=lambda x: -sum(x[1].values()))],
            "per_entitas": by_ent, "per_provinsi": sorted(([{"provinsi": k, "tag": n} for k, n in by_prov.items()]), key=lambda x: -x["tag"])[:40],
            "faskes_teratas": top, "per_agen": sorted(([{"agen": k, "tag": n} for k, n in agents.items()]), key=lambda x: -x["tag"])[:120],
            "kuat": sum(1 for v in rows if v["tingkat"] == 3), "sedang": sum(1 for v in rows if v["tingkat"] == 2), "lemah": sum(1 for v in rows if v["tingkat"] == 1),
            "ditolak": rejected, "markings": _state().get("markings"), "nexus": _state().get("nexus"), "otomatis": _state().get("otomatis"),
            "sinkron": {"terakhir": _sync["last"], "error": _sync["error"], "berjalan": _sync["running"]}}


@router.get("/indikasi/{iid}")
def get_tag(iid: str) -> dict:
    rec = _all().get(iid)
    if not rec:
        raise HTTPException(404, "indikasi tidak ada")
    v = view(rec)
    if not _visible(v, _viewer_markings()):
        raise HTTPException(404, "indikasi tidak ada")
    return {**v, "sumber": rec.get("sumber") or []}


class DecisionIn(BaseModel):
    status: str = Field(pattern="^(dikonfirmasi|ditolak|terbuka)$")
    catatan: str = Field("", max_length=2000)


@router.post("/indikasi/{iid}/keputusan")
def decide(iid: str, req: DecisionIn) -> dict:
    """A person's decision on a tag (the gate the agents never pass): admin."""
    import auth

    _admin()
    p = auth.current() or {}
    with _lock:
        rec = _all().get(iid)
        if not rec or not _visible(view(rec), _viewer_markings()):
            raise HTTPException(404, "indikasi tidak ada")
        rec["status"] = req.status
        rec["keputusan"] = {"oleh": p.get("username") or p.get("id"), "pada": _now(), "catatan": req.catatan}
        rec["diperbarui_pada"] = _now()
        _save([rec], [(iid, {"agen": f"manusia:{p.get('username')}", "keputusan": req.status, "bukti": req.catatan, "t": _now()})])
    _schedule_sync()
    return view(rec)
