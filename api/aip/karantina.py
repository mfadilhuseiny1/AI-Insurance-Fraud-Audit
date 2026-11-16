"""Box Karantina: the facilities with indications, grouped by the loss they may cause, then audited to one of two paths.

The flow (the user's, 2026-10-23): indications (aip/indikasi.py) → the quarantine box → an audit → either the facility
is treated (dibina: a system error or mismanagement without intent: coding and system fixes, the overpayment returned,
administrative sanctions) or acted on (ditindak: fraud that is Terstruktur, Sistematis dan Masif goes on to the legal
track: the JKN anti-fraud team and law enforcement). A facility the audit clears leaves the box (dibebaskan).

- Who is in the box: every facility with at least one tag, on itself or on one of its claims, however weak.
- Groups by estimated loss, Pareto-style (ABC analysis): A = the facilities that together carry the first 50% of the
  estimated loss (the audit priority), B = up to 80%, C = up to 95%, D = up to 99%, Z = the rest (small loss, or only
  non-monetary signals). Within a group: by severity (strength and number of distinct modes).
- Estimated loss per tagged claim that the verifier did NOT correct, the largest of: what was paid above 1.5x the median
  of its peers (same INA-CBG code, hospital type and tariff region, >= 30 peer claims; not for COVID-19 patient claims,
  paid by the COVID per-day scheme, whose INA-CBG peers are no yardstick); half the payment of a candidate duplicate
  (one claim of a pair is the legitimate one); the model's expected correction (probability × billed × the median
  correction ratio of the corrected claims). Corrections already made are reported apart (already recovered). Each
  facility keeps the breakdown and its largest contributing claims: an auditor sees how the figure was reached.
- TSM, each dimension met / partly / not, from the data: Terstruktur (several distinct modes; across inpatient and
  outpatient; many INA-CBG codes; other facilities of the same kab/kota with the same mode), Sistematis (tagged claims
  across many months; corrections that keep coming back; corrected far above what the model expects), Masif (loss
  group A/B; many tagged claims; many patients; a large share of the facility's claims). The suggested path is
  ditindak only when all three are met, else dibina. Investigator agents add their assessment; a person decides.

Markings: the record holds Internal; group A, a ditindak path or decision, or full TSM also Rahasia (the indikasi
markings, same rule on the Nexus type and in this API).

    POST /api/aip/karantina/hitung                 (re)build the box from the tags (admin; the consultancy run does it,
                                                    {run_id}: kept as that engagement's box)
    GET  /api/aip/karantina                         the box: groups, facilities, thresholds (?penugasan=: an engagement's box)
    GET  /api/aip/karantina/penugasan               the boxes per AI Agent Swarm project, and the default one
    POST /api/aip/karantina/estimasi                the estimated loss of any set of claims {filters}, by the same rule
    POST /api/aip/karantina/paket                   the audit pack of a scope for a chat answer (aip/paket.py)
    GET  /api/aip/karantina/{faskes}                one facility with its tags
    POST /api/aip/karantina/{faskes}/rekomendasi    an investigator agent's recommended path with its TSM reading (running run)
    POST /api/aip/karantina/{faskes}/keputusan      a person's decision: diaudit / dibina / ditindak / dibebaskan (admin)
"""

from __future__ import annotations

import json
import logging
import statistics
from typing import Any, Iterable, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from aip import indikasi as I
from aip import semantik as S

router = APIRouter(prefix="/api/aip/karantina")
log = logging.getLogger("aip.karantina")

BANDS = [("A", 0.50), ("B", 0.80), ("C", 0.95), ("D", 0.99), ("Z", 1.01)]
GROUP_TEXT = {"A": "prioritas: bersama-sama menanggung 50% pertama estimasi kerugian", "B": "kerugian besar (50–80% kumulatif)",
              "C": "kerugian menengah (80–95%)", "D": "kerugian kecil (95–99%)", "Z": "kerugian sangat kecil atau hanya sinyal non-uang"}
PATHS = {"dibina": "Diobati / dibina: kesalahan sistem atau salah kelola tanpa unsur kesengajaan (perbaikan koding dan sistem, "
                   "pengembalian kelebihan bayar, sanksi administratif)",
         "ditindak": "Ditindak: fraud Terstruktur, Sistematis dan Masif (TSM): dilanjutkan ke Tim PK-JKN dan aparat penegak hukum",
         "dibebaskan": "Dibebaskan: audit tidak menemukan kelebihan bayar atau kesengajaan; keluar dari karantina"}
STATUSES = ("karantina", "diaudit", "dibina", "ditindak", "dibebaskan")
MONEY_TAGS = {"KLAIM_GANDA", "KLONING_KLAIM", "TAGIHAN_MELEBIHI_TARIF", "UPCODING_KEPARAHAN", "LOLOS_VERIFIKASI_BERISIKO", "RISIKO_ML_TINGGI",
              "KOREKSI_BERULANG", "KELAS_RAWAT", "PEMECAHAN_EPISODE", "KLAIM_FIKTIF",
              # the realtime engine's tags (aip/realtime/modus.py) that put a payment at stake
              "TINDAKAN_TIDAK_DILAKUKAN", "OBAT_ALKES_FIKTIF", "PENGURANGAN_OBAT", "NONKAPITASI_TIDAK_WAJAR"}
MODUS_ONLY = {k for k, t in S.TAG.items() if t["permenkes"]} | {"KOREKSI_BERULANG"}
PEER_BAND = 1.5  # what was paid above 1.5x the peer median counts (the TAGIHAN_MELEBIHI_TARIF band), not above the median
DUPLICATE_SHARE = 0.5  # a candidate duplicate counts half: one claim of a pair is the legitimate one


def _db():
    con = I._db()
    con.execute("CREATE TABLE IF NOT EXISTS karantina (faskes TEXT PRIMARY KEY, rec TEXT NOT NULL, updated TEXT)")
    return con


def _load() -> dict[str, dict]:
    with I._lock:
        return {f: json.loads(r) for f, r in _db().execute("SELECT faskes, rec FROM karantina")}


def _leaving(old: dict[str, dict], new: set[str]) -> list[str]:
    """The facilities a rebuild takes out of the box: no longer qualifying, and no one acted on them (a status, an
    agent's recommendation or a person's decision keeps a facility, with its trail). Until 2026-10-28 every old row
    stayed: 1,400 facilities listed against a summary of 1,379."""
    return [f for f, r in old.items() if f not in new and r.get("status", "karantina") == "karantina" and not r.get("rekomendasi") and not r.get("keputusan")]


def _store(recs: list[dict], drop: Iterable[str] = ()) -> None:
    with I._lock:
        con = _db()
        con.executemany("DELETE FROM karantina WHERE faskes = ?", [(f,) for f in drop])
        con.executemany("INSERT OR REPLACE INTO karantina (faskes, rec, updated) VALUES (?, ?, ?)",
                        [(r["faskes_profil_id"], json.dumps(r, ensure_ascii=False, default=str), r["diperbarui_pada"]) for r in recs])
        con.commit()


# ------------------------------------------------------------------------------------------------
# the box of each engagement (the user, 2026-10-28: choose the box of an AI Agent Swarm project; by default the newest
# project's newest): each engagement rebuilds the one live box above, so its own box is kept apart — the whole box as
# its phase 2 built it, with its investigators' recommendations. Engagements from before 2026-10-28 kept only the
# summary in their trail (the karantina machine event): those boxes are summary-only (lengkap 0).
# ------------------------------------------------------------------------------------------------

EARLIER = ("awal", "Audit nasional FKRTL 2025")  # the project of the engagements from before projects (KonsultanView EARLIER)
_no_box: set[str] = set()  # finished engagements whose trail holds no box (a cancelled one, a report rewrite)


def _snap_db():
    con = I._db()
    con.execute("CREATE TABLE IF NOT EXISTS karantina_snap (run TEXT NOT NULL, faskes TEXT NOT NULL, rec TEXT NOT NULL, PRIMARY KEY (run, faskes))")
    con.execute("CREATE TABLE IF NOT EXISTS karantina_snap_run (run TEXT PRIMARY KEY, ringkasan TEXT, pada TEXT, lengkap INTEGER NOT NULL, asal TEXT)")
    return con


def _snap_save(run_id: str, recs: list[dict], summary: dict, asal: str) -> None:
    with I._lock:
        con = _snap_db()
        con.execute("DELETE FROM karantina_snap WHERE run = ?", (run_id,))
        con.executemany("INSERT INTO karantina_snap (run, faskes, rec) VALUES (?, ?, ?)",
                        [(run_id, r["faskes_profil_id"], json.dumps(r, ensure_ascii=False, default=str)) for r in recs])
        con.execute("INSERT OR REPLACE INTO karantina_snap_run (run, ringkasan, pada, lengkap, asal) VALUES (?, ?, ?, 1, ?)",
                    (run_id, json.dumps(summary, ensure_ascii=False, default=str), summary.get("pada"), asal))
        con.commit()


def _snap_put(run_id: str, recs: list[dict]) -> None:
    """Records changed during the engagement (an investigator's recommendation) into its box, when it has a whole one."""
    with I._lock:
        con = _snap_db()
        con.executemany("UPDATE karantina_snap SET rec = ? WHERE run = ? AND faskes = ?",
                        [(json.dumps(r, ensure_ascii=False, default=str), run_id, r["faskes_profil_id"]) for r in recs])
        con.commit()


def _snap_runs() -> dict[str, dict]:
    with I._lock:
        return {r: {"ringkasan": json.loads(s) if s else None, "pada": p, "lengkap": bool(full), "asal": a}
                for r, s, p, full, a in _snap_db().execute("SELECT run, ringkasan, pada, lengkap, asal FROM karantina_snap_run")}


def _snap_load(run_id: str) -> dict[str, dict]:
    with I._lock:
        return {f: json.loads(r) for f, r in _snap_db().execute("SELECT faskes, rec FROM karantina_snap WHERE run = ?", (run_id,))}


def box_of(run_id: Optional[str]) -> Optional[list[dict]]:
    """An engagement's own box with today's decisions, when it kept a whole one; None: the caller falls back to the live
    box (an engagement from before 2026-10-28). The Swarm report reads it, so a later engagement no longer changes it."""
    meta = _snap_runs().get(run_id or "")
    return _with_decisions(_snap_load(run_id).values(), _load()) if meta and meta["lengkap"] else None


def _with_decisions(recs: Iterable[dict], live: dict[str, dict]) -> list[dict]:
    """A kept box with the people's decisions made since: a decision is about the facility, whichever box shows it."""
    out = []
    for r in recs:
        cur = live.get(r["faskes_profil_id"]) or {}
        if cur.get("keputusan"):
            r = {**r, "status": cur["status"], "keputusan": cur["keputusan"], "riwayat": cur.get("riwayat") or r.get("riwayat")}
            r["klasifikasi"], r["marking"] = _marks(r)
        out.append(r)
    return out


def _trail_box(run_id: str) -> Optional[dict]:
    """The box summary an engagement's trail holds (its phase 2 machine event), read line by line."""
    from aip import runs

    try:
        lines = (runs._dir() / run_id / "events.jsonl").read_text("utf-8").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if '"karantina"' not in line or '"hasil"' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "machine" and e.get("key") == "karantina" and isinstance(e.get("hasil"), dict) and "faskes" in e["hasil"]:
            return e["hasil"]
    return None


def _engagements() -> list[dict]:
    """Every AI Agent Swarm engagement on the platform (the box is the platform's, as the last engagement is), newest
    first; report rewrites build no box."""
    from aip import runs

    out = []
    for d in runs._dir().iterdir():
        try:
            rec = runs._live[d.name]["rec"] if d.name in runs._live else json.loads((d / "run.json").read_text("utf-8"))
        except (OSError, ValueError, KeyError):
            continue
        if rec.get("kind") == "konsultan" and not rec.get("ulang_laporan"):
            out.append(rec)
    return sorted(out, key=lambda r: r.get("created_at") or "", reverse=True)


def _adopt_live(engagements: list[dict], kept: dict[str, dict]) -> None:
    """The live box built by an engagement that did not name itself (its runtime predates run_id on /hitung): the
    engagement whose trail records the same build time owns it — kept as its box, as the live box is now."""
    st = I._state().get("karantina") or {}
    pada = st.get("pada")
    if not pada or st.get("run") or any(v["lengkap"] and v["pada"] == pada for v in kept.values()):
        return
    for e in engagements:
        if (e.get("created_at") or "") > pada:
            continue
        got = _trail_box(e["id"])
        if got and got.get("pada") == pada:
            _snap_save(e["id"], list(_load().values()), {**st, "run": e["id"]}, "box aktif yang dibangun penugasan ini, disimpan saat dibaca")
            I._put_state(karantina={**st, "run": e["id"]})
            return


def boxes() -> dict:
    """The boxes to choose from, per AI Agent Swarm project (newest project first, its newest engagement first), and
    the one shown by default: the newest box of the newest project that has a whole box."""
    from aip import konsultan

    engagements = _engagements()
    kept = _snap_runs()
    _adopt_live(engagements, kept)
    kept = _snap_runs()
    projects = {p["id"]: {"id": p["id"], "nama": p["nama"], "fokus": p.get("fokus") or "", "dibuat_pada": p.get("dibuat_pada"), "penugasan": []}
                for p in konsultan._projects()}
    earlier = {"id": EARLIER[0], "nama": EARLIER[1], "fokus": "", "dibuat_pada": None, "penugasan": []}
    for e in engagements:
        k = kept.get(e["id"])
        if not k and e.get("status") != "running" and e["id"] not in _no_box:
            got = _trail_box(e["id"])
            if got:  # summary-only: kept, a finished trail does not change
                with I._lock:
                    con = _snap_db()
                    con.execute("INSERT OR IGNORE INTO karantina_snap_run (run, ringkasan, pada, lengkap, asal) VALUES (?, ?, ?, 0, ?)",
                                (e["id"], json.dumps(got, ensure_ascii=False, default=str), got.get("pada"), "ringkasan dari jejak penugasan"))
                    con.commit()
                k = {"ringkasan": got, "pada": got.get("pada"), "lengkap": False, "asal": "ringkasan dari jejak penugasan"}
            else:
                _no_box.add(e["id"])
        pr = projects.get(e.get("proyek") or "") or (earlier if not e.get("proyek") else None)
        if pr is None:
            continue
        s = (k or {}).get("ringkasan") or {}
        pr["penugasan"].append({"run": e["id"], "nama": e.get("nama"), "status": e.get("status"), "mulai": e.get("created_at"), "selesai": e.get("finished_at"),
                                "box": ("lengkap" if k["lengkap"] else "ringkasan") if k else None, "box_pada": (k or {}).get("pada"),
                                "faskes": s.get("faskes"), "kerugian_rp": s.get("total_estimasi_kerugian_rp")})
    if earlier["penugasan"]:
        earlier["dibuat_pada"] = earlier["penugasan"][-1]["mulai"]
        projects[EARLIER[0]] = earlier
    order = sorted(projects.values(), key=lambda p: p.get("dibuat_pada") or "", reverse=True)
    pick = next(((p["id"], e["run"]) for want in ("lengkap", "ringkasan") for p in order for e in p["penugasan"] if e["box"] == want), None)
    st = I._state().get("karantina") or {}
    return {"proyek": order, "bawaan": {"proyek": pick[0], "run": pick[1]} if pick else None,
            "aktif": {"pada": st.get("pada"), "run": st.get("run")}}


def _marks(rec: dict) -> tuple[str, list[str]]:
    st = I._state().get("markings") or {}
    tsm = rec.get("tsm") or {}
    secret = (rec.get("kelompok") == "A" or rec.get("status") == "ditindak" or rec.get("jalur_awal") == "ditindak"
              or all((tsm.get(d) or {}).get("nilai") == "terpenuhi" for d in ("terstruktur", "sistematis", "masif")))
    return ("Rahasia" if secret else "Internal"), [m for m in ([st.get("internal")] + ([st.get("rahasia")] if secret else [])) if m]


def _level(points: float, full: float, part: float) -> str:
    return "terpenuhi" if points >= full else "sebagian" if points >= part else "tidak"


def _correction_median(klaim: dict[str, dict]) -> tuple[float, int]:
    """The median correction ratio (selisih / billed) of the claims the verifier corrected, and how many there are: what
    the model's expected correction is scaled by."""
    ratios = [(I._f(r.get("selisih_rp")) or 0) / I._f(r["biaya_tagih_rp"]) for r in klaim.values()
              if r.get("flag_selisih_verifikasi") and (I._f(r.get("biaya_tagih_rp")) or 0) > 0]
    return (statistics.median(ratios) if ratios else 0.0), len(ratios)


def claim_loss(cid: str, k: dict, m: dict, ctags: set, r_med: float, tk: Optional[dict] = None) -> dict:
    """One tagged claim's part of the estimated loss (the rule above): a claim the verifier corrected is recovered (its
    selisih); one not corrected counts the largest of its components. k: its Klaim Berisiko properties, m: its ML claim,
    ctags: its tags, tk: the context of a tag that carries the bill of a claim no screening object holds."""
    tk = tk or {}
    if k.get("flag_selisih_verifikasi") or m.get("sudah_dikoreksi"):
        return {"dikoreksi": True, "selisih": I._f(k.get("selisih_rp")) or 0, "dibayar": 0.0, "parts": {}}
    paid = I._f(k.get("biaya_verifikasi_rp")) or I._f(k.get("biaya_tagih_rp")) or I._f(m.get("biaya_tagih")) or I._f(tk.get("biaya_tagih_rp")) or 0
    parts = {"di_atas_tarif": 0.0, "di_atas_peer": 0.0, "klaim_ganda": 0.0, "ekspektasi_model": 0.0, "estimasi_cabang": 0.0}
    # the AI Agent Swarm Branch's estimate (testing/laporan_cabang.taksir_kerugian, 2026-11-13): the mode-priced loss of a claim
    # the branch queued, written on its tag by aip/realtime/cabang_tag.tulis
    if I._f(tk.get("estimasi_kerugian_rp")):
        parts["estimasi_cabang"] = min(paid or I._f(tk["estimasi_kerugian_rp"]), I._f(tk["estimasi_kerugian_rp"]))
    if k and not I.covid_scheme(cid):
        # paid beyond the INA-CBG package + top-ups the grouper set (the COVID scheme pays per day: no such tariff)
        sisa = I._f(k.get("sisa_di_luar_tarif_rp")) or 0
        if sisa > I.SISA_MIN:
            parts["di_atas_tarif"] = min(paid, sisa)
    # the peer is the claim's tariff table (pipeline v8): a dearer tariff table is no loss
    if k and not I.covid_scheme(cid) and (I._f(k.get("peer_klaim")) or 0) >= 30 and I._f(k.get("peer_biaya_p50_rp")):
        parts["di_atas_peer"] = max(0.0, paid - PEER_BAND * I._f(k["peer_biaya_p50_rp"]))
    if ctags & {"KLAIM_GANDA", "KLONING_KLAIM"}:  # a duplicate or a copied claim: half, one of each pair being the real one
        parts["klaim_ganda"] = DUPLICATE_SHARE * paid
    if m and I._f(m.get("risiko")):
        parts["ekspektasi_model"] = I._f(m["risiko"]) * (I._f(m.get("biaya_tagih")) or paid) * r_med
    return {"dikoreksi": False, "selisih": 0.0, "dibayar": paid, "parts": parts}


def build(log_fn: Any = None, run_id: Optional[str] = None) -> dict:
    """The box from the tags and the claims behind them (as the caller). Decisions and recommendations already made are
    kept; everything computed is recomputed. run_id: the engagement building it, which keeps it as its own box."""
    say = log_fn or (lambda m: None)
    tags = [I.view(r) for r in I._all().values() if I.standing(r)]
    per: dict[str, list[dict]] = {}
    for v in tags:
        c = v.get("konteks") or {}
        fid = v["kunci"] if v["entitas"] == "faskes" else c.get("faskes_profil_id")
        if fid:
            per.setdefault(str(fid), []).append(v)
    say(f"{len(tags)} tag, {len(per)} faskes bertag")
    klaim = {str(r.get("klaim_id") or r["_kunci"]): r for r in I._objects(S.T_KLAIM)}
    ml = {str(r.get("klaim_id") or r["_kunci"]): r for r in I._objects(S.T_ML_KLAIM)}
    mlf = {str(r.get("faskes_profil_id") or r["_kunci"]): r for r in I._objects(S.T_ML_FASKES)}
    prof = {str(r.get("faskes_profil_id") or r["_kunci"]): r for r in I._objects(S.T_FASKES)}
    r_med, n_ratios = _correction_median(klaim)
    say(f"rasio koreksi median {r_med:.3f} dari {n_ratios} klaim terkoreksi")
    # facilities per kab/kota and mode, for the "network" signal of Terstruktur
    by_kab_mode: dict[tuple, set] = {}
    for fid, vs in per.items():
        kab = (prof.get(fid) or {}).get("kabkota_kode") or (mlf.get(fid) or {}).get("kabkota")
        for v in vs:
            if v["tingkat"] >= 2 and v["tag"] in MODUS_ONLY and not I.review_only(v):
                by_kab_mode.setdefault((kab, v["tag"]), set()).add(fid)
    old = _load()
    recs = []
    for fid, every in per.items():
        # a claim only Blu 1.1's clinical review tagged is a lead: the facility is in the box (group Z unless other tags
        # carry a loss), but the claim adds no loss, mode or TSM point until another source tags it too (aip/telaah.py)
        vs = [v for v in every if not I.review_only(v)]
        p, f = prof.get(fid) or {}, mlf.get(fid) or {}
        claims = {v["kunci"]: v for v in vs if v["entitas"] == "klaim"}
        loss = recovered = exposed = 0.0
        parts_sum = {"di_atas_tarif": 0.0, "di_atas_peer": 0.0, "klaim_ganda": 0.0, "ekspektasi_model": 0.0, "estimasi_cabang": 0.0}
        top_claims: list[dict] = []
        months, kinds, codes, members, corrected_months = set(), set(), set(), set(), set()
        n_corrected = 0
        for cid in {v["kunci"] for v in vs if v["entitas"] == "klaim"}:
            k, m = klaim.get(cid) or {}, ml.get(cid) or {}
            ctags = {v["tag"] for v in vs if v["entitas"] == "klaim" and v["kunci"] == cid}
            # a claim no screening object holds (a cloned one, found in the silver claims): its bill and month ride on its tag
            tk = next((v.get("konteks") or {} for v in vs if v["entitas"] == "klaim" and v["kunci"] == cid and (v.get("konteks") or {}).get("biaya_tagih_rp")), {})
            month = str(k.get("bulan") or str(m.get("tgl_datang") or "")[:7] or tk.get("bulan") or "")
            if month:
                months.add(month)
            inpatient = k.get("rawat_inap") if k else (m.get("tingkat_pelayanan") == "RITL")
            kinds.add("inap" if inpatient else "jalan")
            if k.get("inacbg_kode") or m.get("inacbg_kode"):
                codes.add(k.get("inacbg_kode") or m.get("inacbg_kode"))
            if k.get("peserta_key"):
                members.add(k["peserta_key"])
            c = claim_loss(cid, k, m, ctags, r_med, tk)
            if c["dikoreksi"]:
                n_corrected += 1
                recovered += c["selisih"]
                if month:
                    corrected_months.add(month)
                continue
            paid, parts = c["dibayar"], c["parts"]
            if ctags & MONEY_TAGS:
                exposed += paid
            which = max(parts, key=lambda x: parts[x])
            if parts[which] > 0:
                loss += parts[which]
                parts_sum[which] += parts[which]
                top_claims.append({"klaim_id": cid, "komponen": which, "nilai_rp": round(parts[which]), "dibayar_rp": round(paid),
                                   "peer_p50_rp": round(I._f(k.get("peer_biaya_p50_rp")) or 0), "inacbg_kode": k.get("inacbg_kode") or m.get("inacbg_kode"),
                                   "los_hari": k.get("los_hari") or m.get("los"), "tag": sorted(ctags)})
        modes = {v["tag"] for v in vs if v["tag"] in MODUS_ONLY}
        kab = p.get("kabkota_kode") or f.get("kabkota")
        network = sorted({o for mode in modes for o in by_kab_mode.get((kab, mode), set()) if o != fid})
        total_claims = I._f(f.get("klaim")) or I._f(p.get("klaim_fkrtl")) or 0
        share = len(claims) / total_claims if total_claims else 0.0
        ratio = I._f(f.get("rasio_aktual_ekspektasi")) or 0
        ts_points = (len(modes) >= 3) + (len(kinds) == 2) + (len(codes) >= 5) + (len(network) >= 2)
        sy_points = (1 if len(months) >= 6 else 0.5 if len(months) >= 3 else 0) + (n_corrected >= 3 and len(corrected_months) >= 3) + \
            (ratio >= 2 and (I._f(f.get("ekspektasi_koreksi")) or 0) >= 1)
        tsm = {"terstruktur": {"nilai": _level(ts_points, 3, 2), "poin": ts_points,
                               "bukti": f"{len(modes)} modus berbeda ({', '.join(sorted(modes)) or '-'}); layanan: {', '.join(sorted(kinds)) or '-'}; "
                                        f"{len(codes)} kode INA-CBG; {len(network)} faskes lain di kab/kota yang sama dengan modus yang sama"},
               "sistematis": {"nilai": _level(sy_points, 2, 1), "poin": sy_points,
                              "bukti": f"klaim bertag di {len(months)} bulan; {n_corrected} klaim dikoreksi di {len(corrected_months)} bulan; "
                                       f"koreksi aktual/ekspektasi model {ratio:.1f}x"},
               "masif": {"nilai": "tidak", "poin": 0, "bukti": ""}}
        recs.append({"faskes_profil_id": fid, "nama": p.get("nama_profil") or f.get("nama_profil") or fid, "provinsi": p.get("provinsi") or f.get("provinsi"),
                     "kabkota": p.get("kabkota") or f.get("kabkota"), "kabkota_kode": kab, "provinsi_kode": p.get("provinsi_kode") or f.get("provinsi_kode"),
                     "jenis": p.get("jenis") or f.get("jenis_fkrtl"), "tipe": p.get("tipe") or f.get("tipe_fkrtl"),
                     "estimasi_kerugian_rp": round(loss), "sudah_dikoreksi_rp": round(recovered), "nilai_terpapar_rp": round(exposed),
                     "rincian_kerugian": {k2: round(v2) for k2, v2 in parts_sum.items()},
                     "klaim_kontributor": sorted(top_claims, key=lambda x: -x["nilai_rp"])[:8],
                     "klaim_bertag": len(claims), "klaim_faskes": int(total_claims), "porsi_klaim_bertag": share, "peserta_terdampak": len(members),
                     "bulan_aktif": len(months), "kode_inacbg": len(codes), "jaringan": network[:10],
                     "modus": {t: sum(1 for v in vs if v["tag"] == t) for t in sorted({v["tag"] for v in vs})},
                     "tag": len(every), "kuat": sum(v["tingkat"] == 3 for v in every), "sedang": sum(v["tingkat"] == 2 for v in every),
                     "lemah": sum(v["tingkat"] == 1 for v in every), "telaah_klinis_saja": len(every) - len(vs),
                     "keparahan": sum(v["tingkat"] for v in vs if v["entitas"] == "faskes") + len(modes) * 2 + sum(v["tingkat"] == 3 for v in vs),
                     "tsm": tsm})
    # groups: Pareto over the estimated loss
    recs.sort(key=lambda r: -r["estimasi_kerugian_rp"])
    total = sum(r["estimasi_kerugian_rp"] for r in recs) or 1.0
    cum, thresholds = 0.0, {}
    for r in recs:
        share_before = cum / total
        cum += r["estimasi_kerugian_rp"]
        r["kelompok"] = "Z" if r["estimasi_kerugian_rp"] <= 0 else next(g for g, upto in BANDS if share_before < upto)
        thresholds[r["kelompok"]] = min(thresholds.get(r["kelompok"], r["estimasi_kerugian_rp"]), r["estimasi_kerugian_rp"])  # each group's smallest loss
    now = I._now()
    for r in recs:
        ms = (r["kelompok"] in ("A", "B")) + (r["klaim_bertag"] >= 50) + (r["peserta_terdampak"] >= 30) + (r["porsi_klaim_bertag"] >= 0.05)
        r["tsm"]["masif"] = {"nilai": _level(ms, 3, 2), "poin": ms,
                             "bukti": f"kelompok {r['kelompok']}, estimasi kerugian Rp{r['estimasi_kerugian_rp']:,.0f}; {r['klaim_bertag']} klaim bertag "
                                      f"({r['porsi_klaim_bertag']:.1%} klaim faskes); {r['peserta_terdampak']} peserta".replace(",", ".")}
        full = all(r["tsm"][d]["nilai"] == "terpenuhi" for d in ("terstruktur", "sistematis", "masif"))
        r["indikasi_tsm"] = full
        r["jalur_awal"] = "ditindak" if full else "dibina"
        prev = old.get(r["faskes_profil_id"]) or {}
        r.update(status=prev.get("status", "karantina"), rekomendasi=prev.get("rekomendasi") or [], keputusan=prev.get("keputusan"),
                 riwayat=prev.get("riwayat") or [{"t": now, "status": "karantina", "oleh": "sistem"}], masuk_pada=prev.get("masuk_pada", now),
                 diperbarui_pada=now)
        r["klasifikasi"], r["marking"] = _marks(r)
        r["keparahan_label"] = "tinggi" if r["kuat"] or r["keparahan"] >= 12 else "sedang" if r["sedang"] or r["keparahan"] >= 6 else "rendah"
    rank = {g: i for i, (g, _) in enumerate(BANDS)}
    recs.sort(key=lambda r: (rank[r["kelompok"]], -r["keparahan"], -r["estimasi_kerugian_rp"]))
    _store(recs, drop=_leaving(old, {r["faskes_profil_id"] for r in recs}))
    summary = {"pada": now, "faskes": len(recs), "total_estimasi_kerugian_rp": round(sum(r["estimasi_kerugian_rp"] for r in recs)),
               "sudah_dikoreksi_rp": round(sum(r["sudah_dikoreksi_rp"] for r in recs)), "rasio_koreksi_median": r_med,
               "kelompok": {g: {"faskes": sum(r["kelompok"] == g for r in recs), "kerugian_rp": round(sum(r["estimasi_kerugian_rp"] for r in recs if r["kelompok"] == g)),
                                "batas_bawah_rp": thresholds.get(g), "arti": GROUP_TEXT[g]} for g, _ in BANDS},
               "indikasi_tsm": sum(r["indikasi_tsm"] for r in recs), "run": run_id}
    if run_id:
        _snap_save(run_id, recs, summary, "dibangun penugasan ini (fase karantina)")
    I._put_state(karantina=summary)
    I._schedule_sync()
    return summary


def frame() -> Any:
    """The box as a dataset for the Nexus type "Karantina Faskes (AI Agent Swarm)"."""
    import pandas as pd

    rows = []
    for r in _load().values():
        rows.append({"faskes_profil_id": r["faskes_profil_id"], "nama": f"[{r['kelompok']}] {r['nama']}"[:300], "kelompok": r["kelompok"],
                     "provinsi": r.get("provinsi"), "kabkota": r.get("kabkota"), "tipe": r.get("tipe"), "status": r["status"], "jalur_awal": r["jalur_awal"],
                     "indikasi_tsm": r["indikasi_tsm"], "terstruktur": r["tsm"]["terstruktur"]["nilai"], "sistematis": r["tsm"]["sistematis"]["nilai"],
                     "masif": r["tsm"]["masif"]["nilai"], "estimasi_kerugian_rp": float(r["estimasi_kerugian_rp"]), "sudah_dikoreksi_rp": float(r["sudah_dikoreksi_rp"]),
                     "klaim_bertag": r["klaim_bertag"], "peserta_terdampak": r["peserta_terdampak"], "tag": r["tag"], "kuat": r["kuat"],
                     # what kind of indication, not only how many: a province's drill-down lists the faskes with it (2026-10-23)
                     "jenis_indikasi": ", ".join(f"{(S.TAG.get(t) or {}).get('label', t)} ({n})"
                                                 for t, n in sorted((r.get("modus") or {}).items(), key=lambda x: -x[1])[:3]) or None,
                     "keparahan": r["keparahan_label"], "rekomendasi_agen": (r["rekomendasi"][-1]["jalur"] if r.get("rekomendasi") else None),
                     "keputusan": (r.get("keputusan") or {}).get("status"), "klasifikasi": r["klasifikasi"], "marking": r["marking"] or None,
                     "diperbarui_pada": r["diperbarui_pada"]})
    return pd.DataFrame(rows)


def _visible(rec: dict, have: Optional[set]) -> bool:
    if have is None:
        return True
    import auth

    return auth.satisfies(set(rec.get("marking") or []), have)


class RebuildIn(BaseModel):
    run_id: Optional[str] = Field(None, pattern=r"^run-[0-9a-f]{12}$")  # the engagement rebuilding it (firm phase 2)


@router.post("/hitung")
def rebuild(req: Optional[RebuildIn] = None) -> dict:
    I._admin()
    run_id = req.run_id if req else None
    if run_id:
        from aip import runs

        if runs.check_access(run_id).get("kind") != "konsultan":
            raise HTTPException(409, "hanya penugasan AI Agent Swarm yang menyimpan box-nya")
    return build(log.info, run_id)


def _engagement_box(run_id: str) -> tuple[dict, Optional[list[dict]]]:
    """(what is kept of an engagement's box, its facilities with today's decisions; None when only the summary is kept)."""
    meta = _snap_runs().get(run_id)
    if not meta:
        raise HTTPException(404, "penugasan ini tidak menyimpan box karantina")
    return meta, (_with_decisions(_snap_load(run_id).values(), _load()) if meta["lengkap"] else None)


LIST_KEYS = ("faskes_profil_id", "nama", "provinsi", "kabkota", "tipe", "kelompok", "estimasi_kerugian_rp", "sudah_dikoreksi_rp", "klaim_bertag",
             "peserta_terdampak", "tag", "kuat", "sedang", "lemah", "modus", "tsm", "indikasi_tsm", "jalur_awal", "status", "keputusan", "klasifikasi",
             "keparahan", "keparahan_label")


def _slim(r: dict) -> dict:
    """A facility as a list row shows it (?ringkas=1): no contributing claims, the last recommendation without its text."""
    return {**{k: r.get(k) for k in LIST_KEYS},
            "rekomendasi": [{k: x.get(k) for k in ("agen", "jalur", "run_id", "t")} for x in (r.get("rekomendasi") or [])[-1:]]}


@router.get("")
def box(kelompok: Optional[str] = None, status: Optional[str] = None, provinsi: Optional[str] = None, limit: int = 300,
        penugasan: Optional[str] = None, ringkas: bool = False) -> dict:
    """The live box, or with `penugasan` the box an AI Agent Swarm engagement built (GET /penugasan lists them)."""
    have = I._viewer_markings()
    meta, src = _engagement_box(penugasan) if penugasan else (None, list(_load().values()))
    recs = [r for r in src or [] if _visible(r, have) and (not kelompok or r["kelompok"] == kelompok)
            and (not status or r["status"] == status) and (not provinsi or str(r.get("provinsi") or "").upper() == provinsi.upper())]
    rank = {g: i for i, (g, _) in enumerate(BANDS)}
    # ties (most of Z: no loss, same severity) by id, so a kept box lists in the same order as the live one
    recs.sort(key=lambda r: (rank[r["kelompok"]], -r["keparahan"], -r["estimasi_kerugian_rp"], r["faskes_profil_id"]))
    per_group = {g: [r for r in recs if r["kelompok"] == g] for g, _ in BANDS}
    lim = max(1, min(limit, 2000))
    out = {"ringkasan": meta["ringkasan"] if meta else I._state().get("karantina"), "jalur": PATHS, "kelompok_arti": GROUP_TEXT, "total": len(recs),
           "per_status": {s: sum(r["status"] == s for r in recs) for s in STATUSES},
           "kelompok": {g: {"total": len(v), "faskes": [_slim(r) for r in v[:lim]] if ringkas else v[:lim]} for g, v in per_group.items()}}
    if meta:
        out["penugasan"] = {"run": penugasan, "lengkap": meta["lengkap"], "asal": meta["asal"], "pada": meta["pada"]}
        if not meta["lengkap"]:
            # only the summary is kept: the facilities this engagement's investigators audited, as the live box holds them
            audited = []
            for r in _load().values():
                mine = [x for x in r.get("rekomendasi") or [] if x.get("run_id") == penugasan]
                if mine and _visible(r, have):
                    audited.append({k: r.get(k) for k in ("faskes_profil_id", "nama", "provinsi", "kabkota", "tipe", "kelompok", "estimasi_kerugian_rp",
                                                          "status", "klasifikasi", "tsm")} | {"rekomendasi": mine})
            out["diaudit_penugasan"] = sorted(audited, key=lambda r: (rank.get(r["kelompok"], 9), -(r["estimasi_kerugian_rp"] or 0)))
    return out


@router.get("/penugasan")  # before GET /{fid}, which would take it
def engagement_boxes() -> dict:
    return boxes()


class EstimateIn(BaseModel):
    filters: list[dict] = Field(default_factory=list, max_length=20)  # Object Explorer filters on Klaim Berisiko


@router.post("/estimasi")
def estimate(req: EstimateIn, request: Request) -> dict:
    """The estimated loss of any set of claims (a filter on Klaim Berisiko), by the box's rule on each tagged claim of the
    set, as the caller sees the claims and the tags. The box holds the loss per facility only: "berapa estimasi
    kerugiannya" about claims of one INA-CBG code with an extreme LOS was answered with the loss of every facility, and
    the sum of selisih_rp is what was already corrected, not the loss (2026-10-24)."""
    import ontology
    import ontology_explorer as OE

    t = next((x for x in ontology._all("object-types") if x["display_name"] == S.T_KLAIM), None)
    if not t:
        raise HTTPException(404, f"tipe objek {S.T_KLAIM} tidak ada")
    try:
        filters = [OE.Filter(**f) for f in req.filters]
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"filter tidak valid: {e}") from None
    token = OE.om.RESOURCE.set("aip")
    try:
        with OE._for_build(request, t["id"]), OE._lock:
            found = OE.run_search(OE.SearchIn(object_type_id=t["id"], filters=filters, limit=1, histograms=False))
        OE.om.record_query("base", found["type_ids"][:1], len(found["rows"]))
    finally:
        OE.om.RESOURCE.reset(token)
    klaim = {str(r["properties"].get("klaim_id") or r["primary_key"]): r["properties"] for r in found["rows"]}
    have = I._viewer_markings()
    tagged: dict[str, set] = {}
    for v in (I.view(x) for x in I._all().values() if I.standing(x)):
        # (the box's rule: a claim only Blu 1.1's clinical review tagged carries no loss)
        if v["entitas"] == "klaim" and str(v["kunci"]) in klaim and I._visible(v, have) and not I.review_only(v):
            tagged.setdefault(str(v["kunci"]), set()).add(v["tag"])
    ml = {str(r.get("klaim_id") or r["_kunci"]): r for r in I._objects(S.T_ML_KLAIM)}
    r_med, _ = _correction_median({str(r.get("klaim_id") or r["_kunci"]): r for r in I._objects(S.T_KLAIM)})
    loss = recovered = billed = paid_total = 0.0
    parts_sum = {"di_atas_tarif": 0.0, "di_atas_peer": 0.0, "klaim_ganda": 0.0, "ekspektasi_model": 0.0, "estimasi_cabang": 0.0}
    n_corrected, top = 0, []
    for cid, k in klaim.items():
        billed += I._f(k.get("biaya_tagih_rp")) or 0
        paid_total += I._f(k.get("biaya_verifikasi_rp")) or 0
        if cid not in tagged:
            continue
        c = claim_loss(cid, k, ml.get(cid) or {}, tagged[cid], r_med)
        if c["dikoreksi"]:
            n_corrected += 1
            recovered += c["selisih"]
            continue
        which = max(c["parts"], key=lambda x: c["parts"][x])
        if c["parts"][which] > 0:
            loss += c["parts"][which]
            parts_sum[which] += c["parts"][which]
            top.append({"klaim_id": cid, "komponen": which, "nilai_rp": round(c["parts"][which]), "dibayar_rp": round(c["dibayar"]),
                        "peer_p50_rp": round(I._f(k.get("peer_biaya_p50_rp")) or 0), "faskes_profil_id": k.get("faskes_profil_id"),
                        "inacbg_kode": k.get("inacbg_kode"), "los_hari": k.get("los_hari"), "tag": sorted(tagged[cid])})
    return {"klaim": len(klaim), "klaim_bertag": len(tagged), "klaim_dikoreksi": n_corrected,
            "estimasi_kerugian_rp": round(loss), "sudah_dikoreksi_rp": round(recovered),
            "biaya_tagih_rp": round(billed), "biaya_verifikasi_rp": round(paid_total),
            "rincian_kerugian": {k2: round(v2) for k2, v2 in parts_sum.items()},
            "klaim_kontributor": sorted(top, key=lambda x: -x["nilai_rp"])[:10],
            "cara_hitung": (f"aturan Box Karantina per klaim bertag yang belum dikoreksi verifikator: komponen terbesar dari tagihan di luar tarif "
                            f"INA-CBG + top-up special CMG, dibayar di atas {PEER_BAND}× median peer setarif (kode INA-CBG, tipe dan kepemilikan RS, "
                            f"regional, kelas rawat, tahun tarif yang sama, ≥ 30 klaim peer; bukan skema COVID-19), "
                            f"{DUPLICATE_SHARE:.0%} pembayaran calon klaim ganda, atau ekspektasi koreksi model (probabilitas × tagihan × "
                            f"rasio koreksi median {r_med:.3f}); klaim yang sudah dikoreksi masuk sudah_dikoreksi_rp (selisih_rp), bukan kerugian; "
                            "klaim tanpa tag indikasi tidak dihitung")}


class PackIn(BaseModel):
    """A scope of the audit pack (aip/paket.py): any mix, empty = national."""
    provinsi: str = Field("", max_length=80)
    kabkota: str = Field("", max_length=80)
    faskes: str = Field("", max_length=160)  # an id or part of a name
    inacbg_kode: str = Field("", max_length=20)
    diagnosis: str = Field("", max_length=120)  # an ICD-10 category (J18) or part of a name
    modus: str = Field("", max_length=80)  # an indication tag or its label
    flag: list[str] = Field(default_factory=list, max_length=5)  # los_ekstrem, koreksi, readmisi, klaim_ganda, rawat_inap
    tipe_fkrtl: str = Field("", max_length=80)
    kelas_rawat: str = Field("", max_length=40)
    bulan_dari: str = Field("", max_length=10)
    bulan_sampai: str = Field("", max_length=10)
    kelompok: str = Field("", max_length=12)  # Karantina groups: "A" or "A,B"


@router.post("/paket")
def pack(req: PackIn, request: Request) -> dict:
    """The audit pack of a scope: its figures, spread, modes, facilities, trend, codes, diagnoses and loss-carrying claims
    by the box's rules, and what the consultancy's last engagement concluded about it — one read for a chat answer."""
    from aip import paket

    return paket.build({k: v for k, v in req.model_dump().items() if v}, request)


@router.get("/{fid}")
def facility(fid: str, penugasan: Optional[str] = None) -> dict:
    """One facility of the live box, or as an engagement's box holds it (`penugasan`); its tags are today's."""
    if penugasan:
        _, src = _engagement_box(penugasan)
        rec = next((r for r in src or [] if r["faskes_profil_id"] == fid), None)
    else:
        rec = _load().get(fid)
    if not rec or not _visible(rec, I._viewer_markings()):
        raise HTTPException(404, "faskes tidak ada di karantina")
    tags = I._filtered(None, None, None, None, fid, None, None, None, None)
    tags.sort(key=lambda v: (-v["tingkat"], -v["dukungan"]))
    return {**rec, "indikasi": tags[:300], "jalur": PATHS}


class RecommendIn(BaseModel):
    run_id: str
    agen: str = Field(min_length=1, max_length=80)
    model: str = ""
    jalur: str = Field(pattern="^(dibina|ditindak|dibebaskan)$")
    terstruktur: str = Field(pattern="^(terpenuhi|sebagian|tidak)$")
    sistematis: str = Field(pattern="^(terpenuhi|sebagian|tidak)$")
    masif: str = Field(pattern="^(terpenuhi|sebagian|tidak)$")
    alasan: str = Field(min_length=20, max_length=4000)


@router.post("/{fid}/rekomendasi")
def recommend(fid: str, req: RecommendIn) -> dict:
    """An investigator agent's recommended path (never a decision). Ditindak needs all of T, S and M met."""
    from aip import runs

    if runs.check_access(req.run_id).get("status") != "running":
        raise HTTPException(409, "run sudah selesai")
    if req.jalur == "ditindak" and not (req.terstruktur == req.sistematis == req.masif == "terpenuhi"):
        raise HTTPException(422, "jalur 'ditindak' hanya untuk fraud Terstruktur, Sistematis dan Masif: ketiganya harus terpenuhi; "
                                 "selain itu rekomendasikan 'dibina'")
    with I._lock:
        recs = _load()
        rec = recs.get(fid)
        if not rec:
            raise HTTPException(404, "faskes tidak ada di karantina")
        short = _tsm_short(rec)
        if req.jalur == "ditindak" and short:
            # the box's own reading of the data must be full too: Audit Nasional 1's investigator read RS Jiwa Singkawang's
            # T and S "sebagian" up to "terpenuhi" (S on 0 corrections) and recommended the legal track (2026-10-28)
            raise HTTPException(422, f"jalur 'ditindak' butuh T, S dan M terpenuhi juga menurut data box karantina; data faskes ini: {short}. "
                                     "Rekomendasikan 'dibina' dengan bukti Anda di alasan — manusia dapat menaikkannya ke ditindak di Box")
        rec.setdefault("rekomendasi", []).append({"agen": req.agen, "model": req.model, "jalur": req.jalur, "run_id": req.run_id, "t": I._now(), "alasan": req.alasan,
                                                  "tsm": {"terstruktur": req.terstruktur, "sistematis": req.sistematis, "masif": req.masif}})
        rec["rekomendasi"] = rec["rekomendasi"][-10:]
        if rec["status"] == "karantina":
            rec["status"] = "diaudit"
            rec.setdefault("riwayat", []).append({"t": I._now(), "status": "diaudit", "oleh": req.agen, "catatan": "kertas kerja audit oleh agen penyidik"})
        rec["diperbarui_pada"] = I._now()
        rec["klasifikasi"], rec["marking"] = _marks(rec)
        _store([rec])
        _snap_put(req.run_id, [rec])
    I._schedule_sync()
    return {"faskes": fid, "status": rec["status"], "rekomendasi": req.jalur, "kelompok": rec["kelompok"]}


def _tsm_short(rec: dict) -> str:
    """The TSM dimensions the box's reading of the data does not find met ("terstruktur sebagian, sistematis sebagian"), or ""."""
    tsm = rec.get("tsm") or {}
    return ", ".join(f"{d} {(tsm.get(d) or {}).get('nilai') or '-'}" for d in ("terstruktur", "sistematis", "masif")
                     if (tsm.get(d) or {}).get("nilai") != "terpenuhi")


@router.post("/gerbang-tsm/{run_id}")
def tsm_gate(run_id: str) -> dict:
    """The TSM gate applied to an engagement that finished before it (admin): each 'ditindak' its investigators recommended
    where the box's reading of the data is not full gets the gate's recommendation 'dibina' on top, the investigator's
    kept beneath it with its reading — in the live box and the engagement's own box. No decision changes: people decide."""
    I._admin()
    now, changed = I._now(), []
    snap = _snap_load(run_id)
    with I._lock:
        recs = _load()
        for fid, rec in recs.items():
            mine = [r for r in rec.get("rekomendasi") or [] if r.get("run_id") == run_id]
            short = _tsm_short(snap.get(fid) or rec)
            if not mine or mine[-1].get("jalur") != "ditindak" or not short:
                continue
            gate = {"agen": "gerbang_tsm", "model": "kode", "jalur": "dibina", "run_id": run_id, "t": now,
                    "tsm": {d: ((snap.get(fid) or rec).get("tsm") or {}).get(d, {}).get("nilai") for d in ("terstruktur", "sistematis", "masif")},
                    "alasan": f"Gerbang TSM (kode): 'ditindak' hanya bila T, S dan M terpenuhi menurut penyidik DAN data box; data faskes ini: {short}. "
                              f"Rekomendasi penyidik ({mine[-1].get('agen')}: ditindak) tetap tercatat di bawahnya; manusia dapat menaikkannya ke ditindak."}
            rec["rekomendasi"] = (rec.get("rekomendasi") or [])[-9:] + [gate]
            rec["diperbarui_pada"] = now
            rec["klasifikasi"], rec["marking"] = _marks(rec)
            changed.append(rec)
        if changed:
            _store(changed)
    for rec in changed:
        if rec["faskes_profil_id"] in snap:
            s = snap[rec["faskes_profil_id"]]
            s["rekomendasi"] = (s.get("rekomendasi") or [])[-9:] + [rec["rekomendasi"][-1]]
            s["diperbarui_pada"] = now
            _snap_put(run_id, [s])
    if changed:
        I._schedule_sync()
    return {"run": run_id, "diturunkan": [{"faskes_profil_id": r["faskes_profil_id"], "nama": r.get("nama"), "data_tsm": _tsm_short(snap.get(r["faskes_profil_id"]) or r)}
                                         for r in changed]}


class DecideIn(BaseModel):
    status: str = Field(pattern="^(karantina|diaudit|dibina|ditindak|dibebaskan)$")
    catatan: str = Field("", max_length=4000)


@router.post("/{fid}/keputusan")
def decide(fid: str, req: DecideIn) -> dict:
    """A person's decision: the gate. Ditindak sends the case on to the legal track (TSM), dibina to remediation."""
    import auth

    I._admin()
    p = auth.current() or {}
    with I._lock:
        recs = _load()
        rec = recs.get(fid)
        if not rec or not _visible(rec, I._viewer_markings()):
            raise HTTPException(404, "faskes tidak ada di karantina")
        rec["status"] = req.status
        rec["keputusan"] = {"status": req.status, "oleh": p.get("username") or p.get("id"), "pada": I._now(), "catatan": req.catatan}
        rec.setdefault("riwayat", []).append({"t": I._now(), "status": req.status, "oleh": p.get("username") or p.get("id"), "catatan": req.catatan})
        rec["diperbarui_pada"] = I._now()
        rec["klasifikasi"], rec["marking"] = _marks(rec)
        _store([rec])
    I._schedule_sync()
    return rec


# ------------------------------------------------------------------------------------------------
# a designed audit (the pilot): the box's top facilities and a random slice of all others, blinded; real precision,
# and recall through the random slice (evaluation kit slide 15: auditing only flagged cases labels only flagged cases)
# ------------------------------------------------------------------------------------------------


def _pilot_db():
    con = I._db()
    con.execute("CREATE TABLE IF NOT EXISTS pilot (id TEXT PRIMARY KEY, rec TEXT NOT NULL, updated TEXT)")
    return con


def _pilot_load() -> Optional[dict]:
    with I._lock:
        row = _pilot_db().execute("SELECT rec FROM pilot ORDER BY updated DESC LIMIT 1").fetchone()
    return json.loads(row[0]) if row else None


def _pilot_save(p: dict) -> None:
    p["diperbarui"] = I._now()
    with I._lock:
        con = _pilot_db()
        con.execute("INSERT OR REPLACE INTO pilot (id, rec, updated) VALUES (?, ?, ?)", (p["id"], json.dumps(p, ensure_ascii=False, default=str), p["diperbarui"]))
        con.commit()


def wilson(k: int, n: int, z: float = 1.96) -> tuple[Optional[float], Optional[float], Optional[float]]:
    """A proportion and its Wilson 95% interval (sound at small n and at 0 or n)."""
    if n <= 0:
        return None, None, None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / d
    return p, max(0.0, c - h), min(1.0, c + h)


def estimates(p: dict) -> dict:
    """Precision of the flagged list, the rate in the random slice, the facilities the list misses, recall — each with
    its interval, from the outcomes recorded so far (a facility of the flagged arm decided in the box counts too)."""
    box = _load()
    def outcome(it: dict) -> Optional[bool]:
        if it.get("terbukti") is not None:
            return bool(it["terbukti"])
        st = (box.get(it["faskes_profil_id"]) or {}).get("status")
        return {"dibina": True, "ditindak": True, "dibebaskan": False}.get(st or "")
    arms = {}
    for arm in ("ditandai", "acak"):
        items = [it for it in p["sampel"] if it["lengan"] == arm]
        done = [outcome(it) for it in items]
        done = [x for x in done if x is not None]
        rate, lo, hi = wilson(sum(done), len(done))
        arms[arm] = {"sampel": len(items), "diaudit": len(done), "terbukti": sum(done), "porsi": rate, "ik95": [lo, hi]}
    n_rest = p["populasi_lain"]
    r = arms["acak"]
    missed = (r["porsi"] * n_rest) if r["porsi"] is not None else None
    missed_ci = [r["ik95"][0] * n_rest, r["ik95"][1] * n_rest] if r["porsi"] is not None else [None, None]
    tp = arms["ditandai"]["porsi"] * arms["ditandai"]["sampel"] if arms["ditandai"]["porsi"] is not None else None

    def recall(m: Optional[float]) -> Optional[float]:
        return tp / (tp + m) if tp is not None and m is not None and (tp + m) > 0 else None
    # what the evaluation kit's references report beside precision (Black et al., FAccT 2022; Shekhar et al., JPAM 2026):
    # lift over the random slice, the no-change rate (audits that found nothing), the rupiah found, and the rupiah
    # outside the list from the random slice weighted by 1 / its chance of selection (Horvitz–Thompson)
    f, a = arms["ditandai"], arms["acak"]
    found = {arm: sum(float(it.get("nilai_rp") or 0) for it in p["sampel"] if it["lengan"] == arm and it.get("terbukti")) for arm in arms}
    outside = found["acak"] / a["diaudit"] * n_rest if a["diaudit"] else None
    return {"presisi": f, "acak": a, "terlewat_diperkirakan": missed, "terlewat_ik95": missed_ci,
            "recall": recall(missed), "recall_ik95": [recall(missed_ci[1]), recall(missed_ci[0])],
            "lift": f["porsi"] / a["porsi"] if f["porsi"] is not None and a["porsi"] else None,
            "no_change": 1 - f["porsi"] if f["porsi"] is not None else None,
            "bobot_acak": n_rest / a["sampel"] if a["sampel"] else None,
            "temuan_rp": found, "temuan_per_audit_rp": found["ditandai"] / f["diaudit"] if f["diaudit"] else None,
            "temuan_di_luar_rp": outside, "recall_rp": found["ditandai"] / (found["ditandai"] + outside) if outside is not None and found["ditandai"] + outside > 0 else None,
            "catatan": "presisi = porsi terbukti di daftar teratas; recall = terbukti di daftar / (itu + perkiraan terbukti di populasi lain dari porsi "
                       "sampel acak); interval Wilson 95%; lift = presisi / porsi sampel acak; no-change rate = audit daftar teratas yang tidak "
                       "menemukan apa pun; rupiah di luar daftar = temuan sampel acak per faskes × faskes lain (bobot 1/peluang terpilih). "
                       "Terbukti = kelebihan bayar atau kesengajaan ditemukan auditor (dibina atau ditindak)."}


class PilotIn(BaseModel):
    ditandai: int = Field(30, ge=5, le=500)
    acak: int = Field(30, ge=5, le=500)
    seed: int = 2026


@router.post("/pilot")
def design_pilot(req: PilotIn) -> dict:
    """A pilot's audit list (admin): the top `ditandai` facilities of the box by group and loss, and a simple random sample
    of `acak` of all other FKRTL facilities (the control slice), shuffled together under audit codes so auditors do not
    know which arm a facility is in; the key stays with the pilot (admin)."""
    import random

    I._admin()
    rank = {g: i for i, (g, _) in enumerate(BANDS)}
    box = sorted(_load().values(), key=lambda r: (rank[r["kelompok"]], -r["estimasi_kerugian_rp"]))
    flagged = [r["faskes_profil_id"] for r in box[: req.ditandai]]
    others = sorted(str(r.get("faskes_profil_id") or r["_kunci"]) for r in I._objects(S.T_ML_FASKES) if str(r.get("faskes_profil_id") or r["_kunci"]) not in set(flagged))
    rng = random.Random(req.seed)
    control = rng.sample(others, min(req.acak, len(others)))
    names = {str(r.get("faskes_profil_id") or r["_kunci"]): r for r in I._objects(S.T_ML_FASKES)}
    items = [{"faskes_profil_id": f, "lengan": "ditandai"} for f in flagged] + [{"faskes_profil_id": f, "lengan": "acak"} for f in control]
    rng.shuffle(items)
    for i, it in enumerate(items, 1):
        n = names.get(it["faskes_profil_id"]) or {}
        it.update(kode=f"AUD-{i:03d}", nama=n.get("nama_profil") or it["faskes_profil_id"], provinsi=n.get("provinsi"), tipe=n.get("tipe_fkrtl"),
                  terbukti=None, nilai_rp=None, catatan=None, oleh=None, pada=None)
    p = {"id": f"pilot-{I._now()[:10]}-{req.seed}", "dibuat": I._now(), "ditandai": len(flagged), "acak": len(control), "seed": req.seed,
         "populasi_lain": len(others), "sampel": items,
         "rancangan": "daftar teratas box karantina (pasti diaudit) + sampel acak sederhana faskes lain (kontrol), diacak bersama dengan kode audit; "
                      "auditor tidak tahu lengannya"}
    _pilot_save(p)
    return pilot()


@router.get("/pilot/aktif")  # (two segments: GET /{fid} would take "/pilot")
def pilot() -> dict:
    """The current pilot: the blinded audit list (the arm only for an admin), progress, estimates."""
    import auth

    p = _pilot_load()
    if not p:
        return {"status": "belum dirancang"}
    admin = not auth.enabled() or (auth.current() or {}).get("role") == "admin"
    items = [it if admin else {k: v for k, v in it.items() if k != "lengan"} for it in p["sampel"]]
    return {**{k: v for k, v in p.items() if k != "sampel"}, "sampel": items, "estimasi": estimates(p) if admin else None}


class OutcomeIn(BaseModel):
    terbukti: bool
    nilai_rp: Optional[float] = Field(None, ge=0)
    catatan: str = Field("", max_length=2000)


@router.post("/pilot/{kode}/hasil")
def record_outcome(kode: str, req: OutcomeIn) -> dict:
    """An auditor's finding for one facility of the pilot (admin): overpayment or intent found (terbukti) or not."""
    import auth

    I._admin()
    p = _pilot_load()
    if not p:
        raise HTTPException(404, "belum ada pilot")
    it = next((x for x in p["sampel"] if x["kode"] == kode), None)
    if not it:
        raise HTTPException(404, "kode audit tidak ada")
    who = (auth.current() or {}).get("username")
    it.update(terbukti=req.terbukti, nilai_rp=req.nilai_rp, catatan=req.catatan, oleh=who, pada=I._now())
    _pilot_save(p)
    return pilot()

