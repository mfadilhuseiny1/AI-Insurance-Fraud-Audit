"""AI Agent Swarm Branch -> the indikasi ledger (the ledger the national AI Agent Swarm and Box Karantina read).

The user (2026-11-13): "perbaiki celah": the branch office's findings and its verifiers' decisions were kept apart
(data/aip/cabang/<run>/), so they moved neither a hospital's place in the Box nor its loss estimate.

- tulis(run): every claim of a branch run's queue (TAHAN / PERIKSA, testing/laporan_cabang.py) becomes a tag on the claim,
  source "swarm_cabang", with the claim's facility, code, bill and month as context (the Box groups by facility and prices
  a tag that no screening object holds from its context, aip/karantina.claim_loss). The tag is the Permenkes mode the
  swarm's judge named (or, for a claim the model held without the swarm, the family of its strongest indicators). A TAHAN,
  or a PERIKSA the decision is confident about, is written "sedang"; any other PERIKSA "lemah". A tag a person rejected
  before is not raised again. Raising again replaces this source's earlier entry (indikasi.upsert).
- putuskan(...): a verifier's decision on a branch claim decides its tags as the realtime verdicts do
  (integrasi.decide_tags): terbukti bermasalah -> dikonfirmasi; sesuai -> ditolak where this swarm was the only source
  (another source's tag is left to the ledger's reviewers); perlu investigasi -> left open, the note kept.
Synthetic runs only in this app."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import HTTPException

AGENT = "swarm_cabang"
ROLE = "AI Agent Swarm kantor cabang (model penyaring + rule engine + 4 agen ADK)"
RUN = re.compile(r"^[a-z0-9_]{3,40}$")
KC = re.compile(r"^[a-z]{3}-\d{1,5}$")
KLAIM = re.compile(r"^KLM-[0-9A-F]{8}$")


def _dir() -> Path:
    from aip import vertex as aip_vertex

    return aip_vertex.DIR.parent / "cabang"


def tag_untuk(famili: str, teks: str, rule: list[str]) -> str:
    """The ledger tag (a Permenkes mode, aip/semantik.TAG) for the swarm's indicated mode."""
    t = f"{teks} {' '.join(rule)}".lower()
    if famili == "koding":
        return "UPCODING_KEPARAHAN"
    if famili == "tagihan":
        return "TAGIHAN_MELEBIHI_TARIF"
    if famili == "jaringan":
        return "RUJUKAN_SEMU"
    if famili == "identitas":
        return "KLONING_KLAIM" if "klon" in t else "KLAIM_FIKTIF"
    if famili == "episode":
        if "klon" in t or "mirip" in t:
            return "KLONING_KLAIM"
        if "pecah" in t or "episode_hari_sama" in t or "episode hari sama" in t:
            return "PEMECAHAN_EPISODE"
        if "ganda" in t or "berulang" in t or "kembar" in t:
            return "KLAIM_GANDA"
        return "READMISI"
    return "RISIKO_ML_TINGGI"


def _laporan(run: str) -> list[dict]:
    if not RUN.match(run):
        raise HTTPException(400, "run tidak dikenal")
    d = _dir() / run
    files = sorted(d.glob("kc_*.json"))
    if not files:
        raise HTTPException(404, f"tidak ada laporan kantor cabang untuk run {run}")
    return [json.loads(f.read_text("utf-8")) for f in files]


def tulis(run: str) -> dict:
    from aip import indikasi as I

    recs: dict[str, dict] = {}
    sources: list[tuple[str, dict]] = []
    new = refused = 0
    per_tag: dict[str, int] = {}
    for L in _laporan(run):
        kc = L["kc"]
        for k in L["kasus"]:
            if k["keputusan"] not in ("TAHAN", "PERIKSA") or not k.get("faskes"):
                continue
            ka = k.get("keputusan_ai") or {}
            hakim = (k.get("agen") or {}).get("hakim") or {}
            tag = tag_untuk(ka.get("famili") or "normal", f"{hakim.get('alasan', '')} {hakim.get('bukti', '')} {ka.get('alasan', '')}", k.get("rule") or [])
            if I.refused("klaim", k["id"], tag):
                refused += 1
                continue
            level = "sedang" if k["keputusan"] == "TAHAN" or ka.get("keyakinan") == "Tinggi" else "lemah"
            src = {"agen": AGENT, "peran": ROLE, "model": "swarm", "kekuatan": level,
                   "bukti": (f"[{kc['nama']} · {k['keputusan']} · skor risiko {k.get('skor_risiko', 0):.2f} · prioritas {k.get('prioritas') or '-'}] "
                             f"{ka.get('alasan') or ''} Indikator: {', '.join(ka.get('indikator') or [])}. Tindakan: {ka.get('rekomendasi') or ''}")[:1990],
                   "cabang": {"run": run, "kc": kc["id"], "klaim": k["id"], "keputusan": k["keputusan"], "prioritas": k.get("prioritas"),
                              "skor_risiko": k.get("skor_risiko"), "famili": ka.get("famili"), "estimasi_kerugian_rp": k.get("estimasi_kerugian_rp")}}
            ctx = {"faskes_profil_id": k["faskes"], "provinsi": k.get("provinsi") or kc.get("provinsi"), "kabkota": k.get("kabkota"),
                   "nama_profil": k.get("rs"), "bulan": (k.get("tgl") or "")[:7], "klaim_id": k["id"], "inacbg_kode": k.get("inacbg"),
                   "biaya_tagih_rp": k.get("biaya_rp"), "kantor_cabang": kc["nama"],
                   # the branch report's estimated loss for this claim (testing/laporan_cabang.taksir_kerugian); Box Karantina prices it
                   "estimasi_kerugian_rp": k.get("estimasi_kerugian_rp"), "dasar_kerugian": k.get("dasar_kerugian"),
                   "model_penyaring": (L.get("sampul") or {}).get("model")}
            rec, is_new = I.upsert("klaim", k["id"], tag, src, f"{k.get('rs')} · {k.get('inacbg')} · {k.get('tgl')}", ctx, save=False)
            new += is_new
            recs[rec["id"]] = rec
            sources.append((rec["id"], rec["sumber"][-1]))
            per_tag[tag] = per_tag.get(tag, 0) + 1
    if recs:
        I._save(list(recs.values()), sources)
        I._schedule_sync()
    return {"run": run, "tag_ditulis": len(recs), "baru": new, "dilewati_pernah_ditolak": refused, "per_tag": per_tag}


def putuskan(run: str, kc: str, klaim: str, status: str, catatan: str, oleh: str) -> dict:
    """A branch verifier's decision on one claim -> its tags raised by this swarm."""
    from aip import indikasi as I

    if not (RUN.match(run) and KC.match(kc) and KLAIM.match(klaim)) or status not in ("terbukti", "sesuai", "investigasi", ""):
        raise HTTPException(400, "isian tidak valid")
    changed, kept = [], 0
    with I._lock:
        for iid, rec in I._all().items():
            mine = [s for s in rec.get("sumber") or [] if s.get("agen") == AGENT and (s.get("cabang") or {}).get("klaim") == klaim
                    and (s.get("cabang") or {}).get("run") == run]
            if not mine:
                continue
            if status in ("", "investigasi"):
                if rec.get("status") in ("dikonfirmasi", "ditolak") and (rec.get("keputusan") or {}).get("oleh", "").startswith("cabang:"):
                    rec["status"] = "terbuka"  # a branch decision taken back: the tag is open again
                rec["catatan_cabang"] = f"{'perlu investigasi' if status else 'dibatalkan'} oleh {oleh}: {catatan}".strip()[:500]
            elif status == "sesuai" and any(s.get("agen") != AGENT for s in rec["sumber"]):
                kept += 1  # another source raised it too: the ledger's reviewers decide it
                continue
            else:
                rec["status"] = "dikonfirmasi" if status == "terbukti" else "ditolak"
                rec["keputusan"] = {"oleh": f"cabang:{oleh}", "pada": I._now(), "catatan": f"verifikasi kantor cabang ({kc}, {klaim}): {catatan}".strip()[:500]}
            rec["diperbarui_pada"] = I._now()
            changed.append(rec)
        if changed:
            I._save(changed, [(r["id"], {"agen": f"manusia:cabang:{oleh}", "keputusan": status or "batal", "bukti": f"verifikasi kantor cabang {kc} {klaim}",
                                         "t": I._now()}) for r in changed])
    if changed:
        I._schedule_sync()
    return {"diputus": len(changed), "dibiarkan_sumber_lain": kept, "status": status}


def ringkas(run: str) -> dict[str, Any]:
    """How much of a run sits in the ledger, for the branch tab."""
    from aip import indikasi as I

    n, st = 0, {}
    for rec in I._all().values():
        if any(s.get("agen") == AGENT and (s.get("cabang") or {}).get("run") == run for s in rec.get("sumber") or []):
            n += 1
            st[rec.get("status") or "terbuka"] = st.get(rec.get("status") or "terbuka", 0) + 1
    return {"run": run, "tag": n, "status": st}
