"""Evaluasi Swarm (the tab "Evaluasi Swarm" in /aip-jkn, "Evaluasi & Kontrol" until 2026-10-28): every AI Agent Swarm
engagement scored from its own trail — what it found, how its orchestration ran, and whether its report holds.

The user, 2026-10-28: the tab stays only if it evaluates the results and the orchestration of the AI Agent Swarm. The
tab before scored the question copilot on golden sets and showed Mission Control's missions; neither is the swarm.
Nothing here calls a model: every number is read from what the engagement wrote —

    events.jsonl    phases, the code scrutiny of each milestone, QA of each line's synthesis, the final validator and the
                    contract it judged, red team, tags, the investigators' recommendations, handoffs, tool calls, turn
                    errors, resumes, lessons
    usage.jsonl     model calls, tokens and cost per model and per line
    runtime.log     tracebacks
    laporan_konsultan/<run>.beku.json, <run>.json   the frozen report (exhibits, case files) and the exhibit commentary

    GET /api/aip/evaluasi-swarm            the engagements the caller may open, newest first, each with its scorecard
    GET /api/aip/evaluasi-swarm/{run_id}   one engagement's whole evaluation

The acceptance criteria are those docs/healthkathon/UJI_KESIAPAN_SWARM.md measured the 24 October engagement with, plus
the code scrutiny. A criterion the trail cannot show (exhibits of a report that was never frozen) is unmeasured, never a
pass. Where the model validator and a code gate judge the same rule, both are shown: the reader sees when they disagree.
"""

from __future__ import annotations

import json
import threading
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/aip/evaluasi-swarm")

QA_MIN = 0.75  # the readiness test's bar for the QA of the lines' syntheses
EXHIBIT_MIN, BERKAS_MIN = 13, 25
STATUS = {"succeeded": "berhasil", "failed": "gagal", "cancelled": "dibatalkan", "running": "berjalan", "interrupted": "terputus"}
LINI_NAMA = {"pimpinan": "Pimpinan", "wilayah": "Faskes & Wilayah", "modus": "Spesialis modus", "kasus": "Penyidik kasus", "ml": "Machine Learning",
             "qa": "QA & red team", "laporan": "Meja laporan", "peer": "Analis sejawat", "telaah": "Telaah klinis (Blu 1.1)"}

_cache: dict[str, tuple[tuple, dict]] = {}
_lock = threading.Lock()


def _t(s: Any) -> Optional[datetime]:
    try:
        d = datetime.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)  # the trail writes UTC without its zone


def _secs(a: Any, b: Any) -> Optional[int]:
    x, y = _t(a), _t(b)
    return int((y - x).total_seconds()) if x and y else None


def _jsonl(p: Path) -> list[dict]:
    out = []
    try:
        lines = p.read_text("utf-8", errors="replace").splitlines()
    except OSError:
        return out
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out


def _mtime(p: Path) -> tuple:
    try:
        st = p.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)


def _checks(cs: list[dict]) -> list[dict]:
    return [{"klaim": str(c.get("klaim") or c.get("teks") or "")[:300], "ok": c.get("ok"), "blok": bool(c.get("blok")), "bukti": str(c.get("bukti") or "")[:300]}
            for c in cs or []]


def _visible() -> list[dict]:
    """The engagements the caller may open: their own, or all for an administrator (runs.check_access)."""
    import auth

    from aip import runs

    p = runs._principal()
    every = p.get("role") == "admin" or not auth.enabled()
    out = []
    for d in runs._dir().iterdir():
        try:
            rec = runs._live[d.name]["rec"] if d.name in runs._live else runs._settle(json.loads((d / "run.json").read_text("utf-8")))
        except (OSError, ValueError, KeyError):
            continue
        if rec.get("kind") == "konsultan" and (every or rec.get("user_id") == p.get("id")):
            out.append(rec)
    return sorted(out, key=lambda r: r.get("created_at") or "", reverse=True)


def evaluate(rec: dict) -> dict:
    """One engagement's evaluation, from its trail alone."""
    from aip import laporan_konsultan as L
    from aip import runs

    run_id = rec["id"]
    d = runs._dir() / run_id
    ev = runs._events(run_id)
    by: dict[str, list[dict]] = defaultdict(list)
    for e in ev:
        by[e.get("type") or ""].append(e)

    # the team: the standing agents and the instances the engagement formed (investigators, red team)
    tim = (by["firm"] or [{}])[0].get("tim") or []
    inst = [a for e in by["instances"] for a in e.get("agents") or []]
    lini_of = {a.get("key"): a.get("lini") for a in [*tim, *inst]}
    lini_of.setdefault("orkestrator", "pimpinan")
    for k in ("telaah_saring", "telaah_periksa", "telaah_klinis"):  # Blu 1.1's clinical review (adk_runtime/telaah.py): its own line
        lini_of.setdefault(k, "telaah")
    name_of = {a.get("key"): a.get("name") for a in tim}

    # phases, in the order they ran; a phase started again is one the engagement resumed after a restart
    fase: dict[str, dict] = {}
    for e in by["phase"]:
        f = fase.setdefault(e.get("phase") or "?", {"fase": e.get("phase"), "label": e.get("label") or e.get("phase"), "mulai": None, "selesai": None, "kali": 0, "hasil": {}})
        if e.get("status") == "mulai":
            f["kali"] += 1
            f["mulai"] = f["mulai"] or e.get("t")
        elif e.get("status") == "selesai":
            f["selesai"] = e.get("t")
            f["hasil"] = {k: v for k, v in e.items() if k not in ("t", "type", "phase", "status", "label", "seq")}
    for f in fase.values():
        f["detik"] = _secs(f["mulai"], f["selesai"])

    # the verdicts: code scrutiny per milestone, QA per line (the last one of each line), the report's final validator
    verdicts = by["verdict"]
    scrutiny = [{"milestone": v.get("milestone"), "passed": v.get("passed") or 0, "total": v.get("total") or 0, "cek": _checks(v.get("checks"))}
                for v in verdicts if v.get("validator") == "scrutiny"]
    qa_last: dict[str, dict] = {}
    for v in verdicts:
        if v.get("validator") != "scrutiny" and v.get("lini"):
            qa_last[v["lini"]] = v
    qa = [{"lini": k, "nama": name_of.get(k) or str(v.get("sintesis") or k), "model": v.get("model"),
           "passed": v.get("passed") or 0, "total": v.get("total") or 0, "cek": _checks(v.get("checks"))} for k, v in qa_last.items()]
    final = next((v for v in reversed(verdicts) if v.get("validator") in ("validator", "validator_laporan")), None)
    plan_kontrak = {c.get("id"): c.get("teks") for e in by["kontrak"] for c in e.get("kontrak") or []}
    kontrak = [{"id": c.get("id"), "teks": str(c.get("teks") or plan_kontrak.get(c.get("id")) or "")[:300], "ok": c.get("ok"), "bukti": str(c.get("bukti") or "")[:300]}
               for c in (final or {}).get("kontrak") or []]

    # what it found: tags (the last word on each), the box, the investigators' recommendations, the red team
    tags: dict[str, dict] = {}
    for e in by["tag"]:
        if e.get("id") and not e.get("bulk"):
            tags[e["id"]] = e
    kekuatan = Counter(str(t.get("kekuatan") or "—") for t in tags.values())
    rek: dict[str, dict] = {}
    for e in by["rekomendasi"]:
        rek[e.get("faskes") or e.get("nama") or str(len(rek))] = e
    # the engagement's own box (karantina.box_of): the data's TSM reading, and a code gate's recommendation laid on top of
    # an investigator's afterwards (POST /api/aip/karantina/gerbang-tsm)
    from aip import karantina as K

    worked = runs.engagement_of(run_id)  # a rewrite reports the box of the engagement it copied (through a rewrite of one)
    snap = {r["faskes_profil_id"]: r for r in (K.box_of(worked) or [])}
    gated = []
    for fid, e in list(rek.items()):
        mine = [r for r in (snap.get(fid) or {}).get("rekomendasi") or [] if r.get("run_id") == worked]
        if mine and mine[-1].get("agen") == "gerbang_tsm" and e.get("jalur") != mine[-1].get("jalur"):
            rek[fid] = {**e, "jalur": mine[-1]["jalur"]}
            gated.append(e.get("nama"))
    data_short = lambda fid: any(((snap.get(fid) or {}).get("tsm") or {}).get(d, {}).get("nilai") not in (None, "terpenuhi")  # noqa: E731
                                 for d in ("terstruktur", "sistematis", "masif"))
    jalur = Counter(r.get("jalur") or "—" for r in rek.values())
    tsm_langgar = [r.get("nama") for fid, r in rek.items() if r.get("jalur") == "ditindak"
                   and (any(v != "terpenuhi" for v in (r.get("tsm") or {"_": None}).values()) or data_short(fid))]
    red = Counter(e.get("hasil") or "—" for e in by["red_team"])
    hasil = {
        "tag_tersimpan": (fase.get("lapangan") or {}).get("hasil", {}).get("tag"),
        "tag_agen": len(tags), "kekuatan": dict(kekuatan),
        "lintas_keluarga": sum(1 for t in tags.values() if len(t.get("keluarga_model") or []) >= 2),
        "tag_baru": sum(1 for t in tags.values() if t.get("baru") is True),
        "faskes_box": (fase.get("karantina") or {}).get("hasil", {}).get("faskes"),
        "kasus": (fase.get("investigasi") or {}).get("hasil", {}).get("kasus") or len({(e.get("target") or {}).get("faskes_profil_id") for e in by["assign"]} - {None}) or None,
        "rekomendasi": len(rek), "jalur": dict(jalur), "ditindak_tanpa_tsm": tsm_langgar, "diturunkan_gerbang_tsm": gated,
        "red_team": dict(red),
    }
    # Blu 1.1: the clinical review's outcome, as its machine reported it (None in a Blu 1.0 engagement)
    review = next((e.get("hasil") or {} for e in reversed(by["machine"]) if e.get("key") == "telaah_klinis" and e.get("status") == "selesai"), None)
    hasil["telaah_klinis"] = None if review is None else {
        "status": review.get("status"), "ditelaah": review.get("ditelaah"), "diperiksa_ulang": review.get("diperiksa_ulang"),
        "layak_tag": review.get("layak_tag"), "tag": review.get("tag"), "usd": review.get("usd"), "alasan": review.get("alasan") or [],
        "kappa": ((review.get("kalibrasi") or {}).get("hasil") or {}).get("kappa_berbobot")}
    # the agents' sweeps (a whole ranking tagged at once): how many of the swept rows measured anything. Audit Nasional 1.1
    # swept rows of which about a third were worth 0 — KLAIM_GANDA on facilities without a candidate duplicate (indikasi.tag_result
    # skips such rows since 2026-10-29). A ranking is sorted, so the rows a sweep tagged are its first `jumlah`.
    sweep_rows = sweep_zero = 0
    for e in by["tag"]:
        if not e.get("bulk") or not e.get("rid") or e.get("agent") == "konsensus_ml":
            continue
        try:
            rows = (json.loads((d / "results" / f"{e['rid']}.json").read_text("utf-8")).get("rows") or [])[: int(e.get("jumlah") or 0)]
        except (OSError, ValueError):
            continue
        valued = [r for r in rows if "value" in r]
        sweep_rows += len(valued)
        sweep_zero += sum(1 for r in valued if not (isinstance(r["value"], (int, float)) and r["value"] > 0))
    hasil.update(sapuan_baris=sweep_rows, sapuan_tanpa_sinyal=sweep_zero)

    # how the orchestration ran: handoffs, tools, rejected turns, resumes, tracebacks, lessons
    hand = [e.get("handoff") or {} for e in by["handoff"]]
    tools = by["tool"]
    gagal_tool = Counter(e.get("tool") or "?" for e in tools if e.get("ok") is False)
    contoh_tool = {}
    for e in tools:
        if e.get("ok") is False and e.get("tool") not in contoh_tool:
            contoh_tool[e.get("tool")] = str(e.get("summary") or "")[:200]
    galat = [{"agen": e.get("agent"), "pesan": str(e.get("message") or "")[:240], "t": e.get("t")} for e in by["error"]]
    try:
        traceback = (d / "runtime.log").read_text("utf-8", errors="replace").count("Traceback (most recent call last)")
    except OSError:
        traceback = None
    orkestrasi = {
        "fase": list(fase.values()),
        "agen": len(tim), "instans": len(inst),
        "serah_terima": len(hand),
        "prosedur_diikuti": sum(1 for h in hand if (h.get("procedures_followed") or {}).get("ok")),
        "diisi_agen": sum(1 for h in hand if h.get("dinyatakan_agen")),
        "masalah_dilaporkan": sum(len(h.get("issues_found") or []) for h in hand),
        "tool": len(tools), "tool_gagal": sum(gagal_tool.values()),
        "tool_gagal_teratas": [{"tool": k, "gagal": n, "contoh": contoh_tool.get(k, "")} for k, n in gagal_tool.most_common(5)],
        "galat": galat[:30], "galat_total": len(galat),
        "giliran_diulang": sum(1 for g in galat if "diulang" in g["pesan"]),
        "dilanjutkan": len(by["lanjut"]), "traceback": traceback,
        "pelajaran": [{"skill": e.get("skill"), "teks": str(e.get("teks") or "")[:300]} for e in by["pelajaran"]],
    }

    # cost: per model and per line, from the usage ledger the gateway books
    per_model: dict[str, dict] = {}
    per_lini: dict[str, float] = defaultdict(float)
    for u in _jsonl(d / "usage.jsonl"):
        m = per_model.setdefault(u.get("model") or "?", {"model": u.get("model") or "?", "panggilan": 0, "token_masuk": 0, "token_keluar": 0, "usd": 0.0})
        m["panggilan"] += 1
        m["token_masuk"] += int(u.get("prompt") or 0)
        m["token_keluar"] += int(u.get("output") or 0)
        m["usd"] += float(u.get("usd") or 0)
        per_lini[LINI_NAMA.get(lini_of.get(u.get("agent")) or "", "Lain")] += float(u.get("usd") or 0)
    biaya = {"model": sorted(({**m, "usd": round(m["usd"], 4)} for m in per_model.values()), key=lambda m: -m["usd"]),
             "lini": [{"lini": k, "usd": round(v, 4)} for k, v in sorted(per_lini.items(), key=lambda kv: -kv[1])]}

    # the report: chapters with the firm's text, and — when frozen with the engagement — its exhibits and case files
    beku = L.frozen(run_id)
    sec = L._sections(ev)
    ex = (beku or {}).get("exhibit")
    berkas = (beku or {}).get("berkas")
    bab = []
    for cid, title, parts in L.CHAPTERS:
        teks = any(s in sec for s in parts)
        n_ex = sum(1 for x in ex if x.get("bab") == cid) if ex is not None else None
        isi = teks or bool(n_ex) or (cid == "kasus" and bool(berkas))
        bab.append({"id": cid, "judul": title, "teks_firma": teks, "exhibit": n_ex, "berisi": isi if (beku or teks) else None})
    note = L.commentary(run_id) or {}
    laporan = {"bab": bab, "bab_berisi": sum(1 for b in bab if b["berisi"]), "bab_firma": sum(1 for b in bab if b["teks_firma"]),
               "bab_firma_maks": sum(1 for _, _, parts in L.CHAPTERS if parts), "bab_total": len(bab),
               "exhibit": len(ex) if ex is not None else None, "berkas": len(berkas) if berkas is not None else None,
               "beku": bool(beku), "beku_pada": (beku or {}).get("pada"),
               "narasi": len(note.get("narasi") or {}), "narasi_dibuang": len(note.get("dibuang") or [])}

    sc_pass, sc_total = sum(s["passed"] for s in scrutiny), sum(s["total"] for s in scrutiny)
    qa_pass, qa_total = sum(q["passed"] for q in qa), sum(q["total"] for q in qa)
    running = rec.get("status") == "running"

    def crit(cid: str, nama: str, nilai: str, syarat: str, lulus: Optional[bool]) -> dict:
        return {"id": cid, "nama": nama, "nilai": nilai, "syarat": syarat, "lulus": None if running else lulus}

    kriteria = [
        crit("status", "Penugasan selesai", STATUS.get(rec.get("status") or "", rec.get("status") or "—"), "berhasil", rec.get("status") == "succeeded"),
        crit("scrutiny", "Gerbang kode di setiap milestone", f"{sc_pass}/{sc_total} cek", "semua lolos", (sc_pass == sc_total) if sc_total else None),
        crit("validator", "Validator laporan akhir", f"{final.get('passed') or 0}/{final.get('total') or 0}" if final else "tidak ada", "semua lolos",
             (final.get("passed") == final.get("total")) if final and final.get("total") else None),
        crit("qa", "QA sintesis tiap lini", f"{qa_pass}/{qa_total}" + (f" ({round(100 * qa_pass / qa_total)}%)" if qa_total else ""), f"≥ {round(QA_MIN * 100)}%",
             (qa_pass / qa_total >= QA_MIN) if qa_total else None),
        crit("bab", "Bab laporan berisi", f"{laporan['bab_berisi']}/{laporan['bab_total']} · teks firma {laporan['bab_firma']}",
             f"{laporan['bab_total']}/{laporan['bab_total']} · teks firma {laporan['bab_firma_maks']}",
             (laporan["bab_berisi"] == laporan["bab_total"] and laporan["bab_firma"] >= laporan["bab_firma_maks"]) if beku else None),
        crit("exhibit", "Exhibit", "—" if laporan["exhibit"] is None else str(laporan["exhibit"]), f"≥ {EXHIBIT_MIN}",
             None if laporan["exhibit"] is None else laporan["exhibit"] >= EXHIBIT_MIN),
        crit("berkas", "Berkas kasus", "—" if laporan["berkas"] is None else str(laporan["berkas"]), f"≥ {BERKAS_MIN}",
             None if laporan["berkas"] is None else laporan["berkas"] >= BERKAS_MIN),
        crit("narasi", "Narasi exhibit", f"{laporan['narasi']} exhibit" + (f" · {laporan['narasi_dibuang']} kalimat dibuang kode" if laporan["narasi_dibuang"] else ""),
             "ada", laporan["narasi"] > 0),
        crit("beku", "Laporan dibekukan bersama penugasan", "ya" if beku else "tidak", "ya", bool(beku)),
    ]
    # (the swept rows worth 0 stay in `hasil` as information, not a criterion — the user, 2026-10-29: "gausah >95% … yang penting
    # ada indikasi … asal jangan data 0 dianggap true aja"; indikasi.tag_result keeps 0 from becoming a tag)
    return {
        "id": run_id, "nama": rec.get("nama"), "proyek": rec.get("proyek"), "oleh": rec.get("username"), "status": rec.get("status"),
        "mulai": rec.get("created_at"), "selesai": rec.get("finished_at"), "detik": _secs(rec.get("created_at"), rec.get("finished_at")),
        "biaya_usd": rec.get("spent_usd"), "tulis_ulang_dari": rec.get("ulang_laporan"), "versi": rec.get("versi") or "1.0",
        "kriteria": kriteria, "lulus": sum(1 for k in kriteria if k["lulus"] is True), "terukur": sum(1 for k in kriteria if k["lulus"] is not None),
        "skor": {"scrutiny": [sc_pass, sc_total], "qa": [qa_pass, qa_total], "validator": [(final or {}).get("passed") or 0, (final or {}).get("total") or 0],
                 "kontrak": [sum(1 for c in kontrak if c["ok"] is True), sum(1 for c in kontrak if c["ok"] is not None), len(kontrak)]},
        "scrutiny": scrutiny, "qa": qa, "validator": {"model": (final or {}).get("model"), "cek": _checks((final or {}).get("checks"))} if final else None,
        "kontrak": kontrak, "hasil": hasil, "orkestrasi": orkestrasi, "biaya": biaya, "laporan": laporan,
    }


def _key(rec: dict) -> tuple:
    from aip import laporan_konsultan as L
    from aip import runs

    run_id = rec["id"]
    live = runs._live.get(run_id)
    n = len(live["events"]) if live else _mtime(runs._dir() / run_id / "events.jsonl")
    return (rec.get("status"), rec.get("finished_at"), n, _mtime(L._frozen_path(run_id)), _mtime(L._path(run_id)))


def _cached(rec: dict) -> dict:
    k = _key(rec)
    with _lock:
        hit = _cache.get(rec["id"])
    if hit and hit[0] == k:
        return hit[1]
    out = evaluate(rec)
    with _lock:
        _cache[rec["id"]] = (k, out)
    return out


def _project_names() -> dict[str, str]:
    from aip import konsultan

    try:
        return {p["id"]: p.get("nama") or p["id"] for p in konsultan._projects()}
    except HTTPException:
        return {}


@router.get("")
def engagements() -> dict:
    names = _project_names()
    out = []
    for rec in _visible():
        e = _cached(rec)
        o = e["orkestrasi"]
        out.append({k: e[k] for k in ("id", "nama", "proyek", "oleh", "status", "mulai", "selesai", "detik", "biaya_usd", "tulis_ulang_dari", "lulus", "terukur", "skor")}
                   | {"proyek_nama": names.get(e["proyek"] or ""), "versi": e.get("versi") or "1.0", "agen": o["agen"], "instans": o["instans"],
                      "tag": e["hasil"]["tag_tersimpan"], "kasus": e["hasil"]["kasus"], "galat": o["galat_total"], "traceback": o["traceback"],
                      "dilanjutkan": o["dilanjutkan"], "tool": o["tool"], "tool_gagal": o["tool_gagal"],
                      "exhibit": e["laporan"]["exhibit"], "berkas": e["laporan"]["berkas"], "kriteria": e["kriteria"]})
    return {"dibuat_pada": datetime.now(timezone.utc).isoformat(timespec="seconds"), "penugasan": out}


@router.get("/{run_id}")
def engagement(run_id: str) -> dict:
    from aip import runs

    rec = runs.check_access(run_id)
    if rec.get("kind") != "konsultan":
        raise HTTPException(404, "bukan penugasan AI Agent Swarm")
    return {**_cached(rec), "proyek_nama": _project_names().get(rec.get("proyek") or "")}
