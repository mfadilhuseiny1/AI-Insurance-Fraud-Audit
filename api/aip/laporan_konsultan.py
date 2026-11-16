"""The long report of a fraud-consultancy engagement, written the way a consultancy hands one over: an executive summary,
chapters that each answer one question, and numbered exhibits under each — an action title that says the finding, the
chart, what it shows, why it matters, and where every number comes from (the user, 2026-10-24: "McKinsey style long
report + its graph rich explanation from Konsultan Fraud analysis").

- The prose of each chapter is the firm's own report (its sections, written from their sources and checked by the
  report's validator, adk_runtime/firm.py); this module adds no claim to it.
- The exhibits are computed here from the engagement's results: the Karantina box (the loss figures, so they agree with
  the report's Rp total), the indication ledger, the screened claims through the audit pack (aip/paket.py: classes,
  codes, trend), the validators' verdicts and the investigators' recommendations in the run's trail, the ML card, and
  the gateway's cost book. Their titles and "what it shows" lines are written by code from the same rows.
- A case file per facility the investigators audited (case_files): profile, loss and its parts, the investigator's
  judgement in full, facility findings and the claims behind the loss (the Box's own top contributors) with each tag's
  evidence, care units, repeat patients. The sample holds no doctor identity (DPJP_NOTE): visit ids lead to the claim file.
- A commentary per exhibit ("why it matters", "implication") is written once per engagement by the writer model and
  kept; every sentence whose numbers the exhibit's facts do not give is dropped by code (orkestrasi.plain_check) and
  named, as the executive summary is.

    GET  /api/aip/konsultan/{run}/laporan-lengkap          the report: chapters, exhibits, the commentary when written
    POST /api/aip/konsultan/{run}/laporan-lengkap/narasi   write the commentary (admin; a background job, once)
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Optional

from aip import indikasi as I
from aip import karantina as K
from aip import semantik as S

log = logging.getLogger("aip.laporan_konsultan")

LINI = {"pimpinan": "Pimpinan", "wilayah": "Wilayah", "modus": "Modus", "peer": "Peer kelas", "ml": "Teknik ML", "kasus": "Kasus & karantina", "qa": "QA & red team"}
COMPONENT = {"klaim_ganda": "Calon klaim ganda (separuh pembayaran)", "di_atas_tarif": "Tagihan di luar tarif INA-CBG + top-up",
             "di_atas_peer": "Dibayar di atas 1,5× median peer setarif", "ekspektasi_model": "Ekspektasi koreksi model ML", "estimasi_cabang": "Estimasi AI Agent Swarm kantor cabang (per modus)"}
_writing: dict[str, float] = {}  # run → when its commentary started being written
_failed: dict[str, str] = {}  # run → why its last commentary could not be written
_lock = threading.Lock()


# ------------------------------------------------------------------------------------------------ formats


def _id(n: float, d: int = 0) -> str:
    """A number in Indonesian notation: 1.234; 3,7."""
    s = f"{n:,.{d}f}"
    return s.replace(",", "_").replace(".", ",").replace("_", ".")


def rp(n: float) -> str:
    a = abs(n)
    if a >= 1e12:
        return f"Rp {_id(n / 1e12, 2)} triliun"
    if a >= 1e9:
        return f"Rp {_id(n / 1e9, 2)} miliar"
    if a >= 1e6:
        return f"Rp {_id(n / 1e6, 1)} juta"
    return f"Rp {_id(n)}"


def pct(part: float, whole: float, d: int = 1) -> str:
    return f"{_id(100 * part / whole, d)}%" if whole else "0%"


def _prov(name: str) -> str:
    """A province as it is written: Jawa Barat, DKI Jakarta (the data holds them in capitals)."""
    return re.sub(r"\bDki\b", "DKI", name.title())


def _f(v: Any) -> float:
    return I._f(v) or 0.0


# ------------------------------------------------------------------------------------------------ the engagement


def _sections(ev: list[dict]) -> dict[str, dict]:
    """The report's sections as last written (a revision replaces the first draft)."""
    out: dict[str, dict] = {}
    for e in ev:
        if e.get("type") == "bagian" and e.get("status") == "selesai" and e.get("teks"):
            title = e.get("judul") or e["id"]
            out[e["id"]] = {"judul": title, "teks": _untitled(_clean(str(e["teks"])), title)}
    return out


def _untitled(text: str, title: str) -> str:
    """A section's text without a first line that only repeats its title ("**Ringkasan eksekutif**"): the chapter says it."""
    lines = text.splitlines()
    while lines and (not lines[0].strip() or re.sub(r"[*#_:\s]", "", lines[0]).lower() == re.sub(r"[*#_:\s]", "", title).lower()):
        lines.pop(0)
    return "\n".join(lines).strip()


def _clean(text: str) -> str:
    """The firm's text as a reader reads it: its result ids point into the engagement's trail, kept as plain marks."""
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _peta(box: list[dict], est: float, only: Optional[dict[str, dict]] = None) -> list[dict]:
    """Every province for the report's map (the user, 2026-10-28: "geospatial mapping … tiap provinsi sebarannya"): the
    Box's estimated loss and facilities, and the risky claims per 1.000 FKRTL claims from Provinsi (BPJS), which needs
    no Box. `only`: these provinces' rows alone (a frozen report whose Box has changed since: its own top rows)."""
    loss: dict[str, float] = defaultdict(float)
    fac: Counter = Counter()
    for r in box:
        name = str(r.get("provinsi") or "-").upper()
        loss[name] += _f(r.get("estimasi_kerugian_rp"))
        fac[name] += 1
    out = []
    for p in I._objects(S.T_PROV):
        name = str(p.get("provinsi") or "").upper()
        if not name or name == "TIDAK TERDEFINISI":
            continue
        fk, kb = _f(p.get("klaim_fkrtl")), _f(p.get("klaim_berisiko"))
        if only is not None:
            v, share = _f((only.get(name) or {}).get("estimasi_kerugian_rp")) or None, (only.get(name) or {}).get("porsi_pct")
        else:
            v = loss.get(name, 0.0)
            share = round(100 * v / est, 2) if est else 0
        out.append({"provinsi": name, "kode": p.get("provinsi_kode"), "estimasi_kerugian_rp": round(v) if v is not None else None, "porsi_pct": share,
                    "faskes_box": None if only is not None else fac.get(name, 0), "klaim_fkrtl": round(fk), "klaim_berisiko": round(kb),
                    "klaim_berisiko_per_1000": round(1000 * kb / fk, 2) if fk else None})
    return out


def _exhibit(eid: str, bab: str, judul: str, ukuran: str, jenis: str, baris: list[dict], fakta: list[str], sumber: str, **extra: Any) -> dict:
    return {"id": eid, "bab": bab, "judul": judul, "ukuran": ukuran, "jenis": jenis, "baris": baris, "fakta": fakta, "sumber": sumber, **extra}


AUDIT_REFS = ("presisi di k teratas: Dal Pozzolo dkk., IEEE TNNLS 2018; lift: Shekhar, Leder-Luis & Akoglu, JPAM 2026; bobot 1/peluang terpilih: "
              "Kossen dkk., ICML 2021 dan Marchant & Rubinstein, KDD 2021; no-change rate dan hasil rupiah: Black dkk., FAccT 2022")


def _designed_audit(pil: dict) -> dict:
    """The pilot's measures, from the outcomes recorded so far (karantina.estimates: precision and the random slice's rate
    with Wilson intervals, the facilities the list misses and recall), plus what the kit's references ask beside them: lift
    over the random slice, the no-change rate (audits that found nothing), the rupiah found per audit, and the rupiah
    outside the list from the random slice weighted by 1 / its chance of selection (Horvitz–Thompson)."""
    est = K.estimates(pil)
    pf, pr = est["presisi"], est["acak"]
    pop = int(pil.get("populasi_lain") or 0)
    nr = int(pil.get("acak") or pr["sampel"] or 0)
    weight = est["bobot_acak"] or 0.0
    found = est["temuan_rp"]
    facts = [f"Rancangan {pil['id']}: {_id(pf['sampel'])} faskes teratas Box (pasti diaudit) dan {_id(pr['sampel'])} faskes acak sederhana dari "
             f"{_id(pop)} faskes lain (peluang terpilih {pct(nr, pop)}, bobot {_id(weight, 1)}), diacak dengan kode audit sehingga auditor tidak tahu "
             f"lengannya (seed {pil.get('seed')}).",
             f"Hasil tercatat: {_id(pf['diaudit'])} dari {_id(pf['sampel'])} faskes teratas dan {_id(pr['diaudit'])} dari {_id(pr['sampel'])} faskes acak."]
    if pf["diaudit"]:
        facts.append(f"Presisi daftar teratas: {_id(pf['terbukti'])} dari {_id(pf['diaudit'])} terbukti ({_id(100 * pf['porsi'], 1)}%, IK 95% "
                     f"{_id(100 * pf['ik95'][0], 1)}–{_id(100 * pf['ik95'][1], 1)}%); no-change rate {_id(100 * (1 - pf['porsi']), 1)}% (audit yang tidak "
                     f"menemukan apa pun); temuan {rp(found['ditandai'])}, {rp(found['ditandai'] / pf['diaudit'])} per faskes yang diaudit.")
    if pr["diaudit"]:
        facts.append(f"Sampel acak: {_id(pr['terbukti'])} dari {_id(pr['diaudit'])} terbukti ({_id(100 * pr['porsi'], 1)}%, IK 95% "
                     f"{_id(100 * pr['ik95'][0], 1)}–{_id(100 * pr['ik95'][1], 1)}%); perkiraan {_id(est['terlewat_diperkirakan'] or 0)} faskes terbukti di luar "
                     f"daftar (IK 95% {_id(est['terlewat_ik95'][0] or 0)}–{_id(est['terlewat_ik95'][1] or 0)}) dan {rp(est['temuan_di_luar_rp'] or 0)} temuan di luar daftar.")
        if pf["diaudit"]:
            lift, caught = est["lift"], est["recall_rp"]
            facts.append(("Lift daftar teratas atas sampel acak: " + (f"{_id(lift, 1)}×" if lift is not None else "tak terhingga (sampel acak tanpa temuan)")
                          + f"; recall faskes {_id(100 * (est['recall'] or 0), 1)}%" + (f"; recall rupiah {_id(100 * caught, 1)}%." if caught is not None else ".")))
    facts.append(f"Metode: interval Wilson; total dan recall dengan bobot 1/peluang terpilih (Horvitz–Thompson). Rujukan: {AUDIT_REFS}.")
    done = pf["diaudit"] + pr["diaudit"]
    lead = _for_leaders(est, pf, pr)
    title = (f"Audit terancang: {_id(pf['terbukti'])} dari {_id(pf['diaudit'])} faskes teratas terbukti, {_id(pr['terbukti'])} dari {_id(pr['diaudit'])} di sampel acak"
             if done else f"Audit terancang menunggu hasil auditor: {_id(pf['sampel'])} faskes teratas Box dan {_id(pr['sampel'])} faskes acak dari {_id(pop)} faskes lain")
    # before any outcome the chart shows how far the audit has come ("0 dari 0 terbukti" read as a result, 2026-10-28)
    arms = [("Daftar teratas Box (pasti diaudit)", pf), (f"Sampel acak faskes lain (kontrol, bobot {_id(weight, 1)})", pr)]
    rows = ([{"uji": f"{name}: terbukti", "lolos": a["terbukti"], "total": a["diaudit"]} for name, a in arms] if done else
            [{"uji": f"{name}: sudah diaudit", "lolos": a["diaudit"], "total": a["sampel"]} for name, a in arms])
    return _exhibit("audit_terancang", "keandalan", title, "Faskes terbukti per lengan audit" if done else "Kemajuan audit per lengan", "checks", rows, facts,
                    "Pilot audit terancang Box Karantina (POST /api/aip/karantina/pilot; hasil auditor per kode audit)", pimpinan=lead)


def _for_leaders(est: dict, pf: dict, pr: dict) -> list[dict]:
    """Each measure of the designed audit as an executive reads it: a plain name, its value, and what it means in a
    sentence with the measured numbers (written by code: no number here that the measures do not hold)."""
    wait = "menunggu hasil audit"

    def share(v: Optional[float]) -> str:
        return f"{_id(100 * v, 0)}%" if v is not None else "—"

    out = [{"metrik": "Ketepatan daftar prioritas", "nilai": share(pf["porsi"]),
            "arti": (f"Dari setiap 10 faskes yang diaudit dari daftar prioritas, sekitar {_id(10 * pf['porsi'], 0)} memang ditemukan bermasalah "
                     f"(kelebihan bayar atau kesengajaan). Dengan {_id(pf['diaudit'])} audit, angka sebenarnya kemungkinan besar di antara "
                     f"{share(pf['ik95'][0])} dan {share(pf['ik95'][1])}; makin banyak audit, makin sempit rentangnya.") if pf["diaudit"] else
            "Dari setiap 10 faskes yang diaudit dari daftar prioritas, berapa yang memang bermasalah — " + wait + "."},
           {"metrik": "Pembanding: faskes dipilih acak", "nilai": share(pr["porsi"]),
            "arti": "Seberapa sering masalah ditemukan bila faskes dipilih tanpa sistem. Bila angka ini sama tinggi dengan ketepatan daftar "
                    "prioritas, sistem belum membantu" + ("." if pr["diaudit"] else f" — {wait}.")},
           {"metrik": "Berapa kali lebih efektif", "nilai": f"{_id(est['lift'], 1)}×" if est.get("lift") is not None else "—",
            "arti": (f"Satu audit dari daftar prioritas setara hasilnya dengan sekitar {_id(est['lift'], 1)} audit yang dipilih acak."
                     if est.get("lift") is not None else "Satu audit dari daftar prioritas setara dengan berapa audit acak — " + wait + ".")},
           {"metrik": "Audit tanpa temuan", "nilai": share(est.get("no_change")),
            "arti": (f"Sekitar {_id(10 * est['no_change'], 0)} dari 10 audit di daftar prioritas tidak menemukan apa pun: waktu auditor yang "
                     "terpakai tanpa hasil. Makin kecil makin hemat." if est.get("no_change") is not None else
                     "Porsi audit yang tidak menemukan apa pun — " + wait + ".")},
           {"metrik": "Faskes bermasalah di luar daftar", "nilai": f"±{_id(est['terlewat_diperkirakan'])}" if est.get("terlewat_diperkirakan") is not None else "—",
            "arti": "Perkiraan faskes bermasalah yang tidak masuk daftar prioritas, dihitung dari hasil audit faskes acak: bagian yang belum "
                    "tersentuh" + ("." if est.get("terlewat_diperkirakan") is not None else f" — {wait}.")},
           {"metrik": "Porsi faskes bermasalah yang tertangkap", "nilai": share(est.get("recall")),
            "arti": "Dari semua faskes bermasalah, di dalam maupun di luar daftar, berapa persen yang masuk daftar prioritas"
                    + ("." if est.get("recall") is not None else f" — {wait}.")},
           {"metrik": "Uang yang ditemukan per audit", "nilai": rp(est["temuan_per_audit_rp"]) if est.get("temuan_per_audit_rp") is not None else "—",
            "arti": "Rata-rata kelebihan bayar yang ditemukan setiap kali satu faskes dari daftar diaudit. Bandingkan dengan biaya satu audit "
                    "untuk melihat apakah audit sepadan" + ("." if est.get("temuan_per_audit_rp") is not None else f" — {wait}.")},
           {"metrik": "Porsi uang bermasalah yang tertangkap", "nilai": share(est.get("recall_rp")),
            "arti": ("Dari semua kelebihan bayar, termasuk perkiraan di faskes luar daftar "
                     f"({rp(est['temuan_di_luar_rp'] or 0)}), berapa persen berada di faskes yang diaudit dari daftar.")
            if est.get("recall_rp") is not None else "Dari semua kelebihan bayar, berapa persen berada di faskes yang diaudit dari daftar — " + wait + "."}]
    return out


def _box(run: dict) -> list[dict]:
    """The Box a report reads, as the viewer may see it: the engagement's own (a report rewrite: its source's), kept
    since 2026-10-28 (karantina.box_of), so a later engagement no longer changes this report; else the live Box."""
    from aip import runs

    have = I._viewer_markings()
    own = K.box_of(runs.engagement_of(run["id"]))
    return [r for r in (own if own is not None else K._load().values()) if K._visible(r, have)]


def exhibits(run: dict, ev: list[dict], request: Any = None) -> list[dict]:
    from aip import ml as aip_ml
    from aip import paket

    have = I._viewer_markings()
    box = _box(run)
    tags = [v for v in (I.view(x) for x in I._all().values() if I.standing(x)) if I._visible(v, have)]
    pack = paket.build({}, request)
    parts = {p["kunci"]: p for p in pack["bagian"]}
    kpi = parts["ringkasan"]["baris"][0]
    when = (run.get("finished_at") or run.get("created_at") or "")[:16].replace("T", " ")
    src_box = f"Box Karantina dan buku besar indikasi AI Agent Swarm (penugasan {run['id']}, selesai {when} UTC)"
    out: list[dict] = []

    # 1. the scale
    est, corr, exposed = (sum(_f(r.get(k)) for r in box) for k in ("estimasi_kerugian_rp", "sudah_dikoreksi_rp", "nilai_terpapar_rp"))
    out.append(_exhibit(
        "skala", "ringkasan", f"Estimasi kerugian {rp(est)} belum tertangani, di atas {rp(corr)} yang sudah dikoreksi verifikator",
        "Rupiah", "bar",
        [{"label": "Nilai terpapar (dibayar pada klaim bertag bernilai uang)", "nilai": round(exposed)},
         {"label": "Estimasi kerugian belum dikoreksi", "nilai": round(est)}, {"label": "Sudah dikoreksi verifikator", "nilai": round(corr)}],
        [f"Nilai terpapar {rp(exposed)}; estimasi kerugian belum dikoreksi {rp(est)} ({pct(est, exposed)} dari nilai terpapar); sudah dikoreksi "
         f"verifikator {rp(corr)}.",
         f"{_id(len(box))} faskes masuk Box Karantina; {_id(len(tags))} indikasi di buku besar; {_id(kpi['klaim_nasional'])} klaim berisiko diskrining."],
        src_box, satuan="rp"))

    # 2. the concentration: a Pareto curve over the facilities
    ranked = sorted((_f(r.get("estimasi_kerugian_rp")) for r in box), reverse=True)
    total = sum(ranked) or 1.0
    cum, points = 0.0, []
    for i, v in enumerate(ranked, 1):
        cum += v
        points.append({"faskes": i, "kumulatif_pct": round(100 * cum / total, 2)})
    groups = Counter(r.get("kelompok") for r in box)
    top10 = 100 * sum(ranked[:10]) / total
    n_ab = groups.get("A", 0) + groups.get("B", 0)
    p_ab = 100 * sum(ranked[:n_ab]) / total
    n90 = next((p["faskes"] for p in points if p["kumulatif_pct"] >= 90), len(points))
    step = max(1, len(points) // 240)  # a sample of the curve, with the ranks its marks name (so the chart reads the facts' numbers)
    curve = [p for i, p in enumerate(points) if i % step == 0 or i < 40 or p["faskes"] in (10, n_ab, n90)] + points[-1:]
    out.append(_exhibit(
        "konsentrasi", "skala", f"Sepuluh faskes menanggung {_id(top10, 1)}% estimasi kerugian; {_id(n90)} faskes sudah mencapai 90%", "Kumulatif % estimasi kerugian",
        "pareto", curve,
        [f"10 faskes teratas: {_id(top10, 1)}% dari {rp(total)}.", f"Kelompok A dan B ({_id(n_ab)} faskes): {_id(p_ab, 1)}%.",
         f"{_id(n90)} dari {_id(len(ranked))} faskes ({pct(n90, len(ranked))}) menanggung 90% estimasi kerugian."],
        src_box, tanda=[{"faskes": 10, "label": "10 faskes"}, {"faskes": n_ab, "label": "kelompok A–B"}, {"faskes": n90, "label": "90%"}]))

    # 3. the box's groups
    grp = []
    for g, _ in K.BANDS:
        rs = [r for r in box if r.get("kelompok") == g]
        grp.append({"kelompok": g, "faskes": len(rs), "estimasi_kerugian_rp": round(sum(_f(r.get("estimasi_kerugian_rp")) for r in rs)),
                    "diaudit": sum(r.get("status") == "diaudit" for r in rs), "ditindak": sum(r.get("jalur_awal") == "ditindak" for r in rs),
                    "arti": K.GROUP_TEXT.get(g, "")})
    a, b = grp[0], grp[1]
    out.append(_exhibit(
        "kelompok", "skala", f"Kelompok A dan B — {_id(a['faskes'] + b['faskes'])} faskes — menanggung {pct(a['estimasi_kerugian_rp'] + b['estimasi_kerugian_rp'], est, 0)} kerugian",
        "Faskes dan estimasi kerugian per kelompok Box Karantina", "groups", grp,
        [f"Kelompok {x['kelompok']}: {_id(x['faskes'])} faskes, {rp(x['estimasi_kerugian_rp'])} ({pct(x['estimasi_kerugian_rp'], est)}); {_id(x['diaudit'])} sedang diaudit."
         for x in grp], src_box))

    # 4. what the loss is made of
    comp = Counter()
    for r in box:
        for k, v in (r.get("rincian_kerugian") or {}).items():
            comp[k] += _f(v)
    comp_rows = [{"komponen": COMPONENT.get(k, k), "kunci": k, "nilai": round(v)} for k, v in comp.most_common()]
    lead = comp_rows[0] if comp_rows else {"komponen": "-", "nilai": 0}
    out.append(_exhibit(
        "komponen", "skala", f"{lead['komponen']} menyumbang {pct(lead['nilai'], est, 0)} estimasi kerugian", "Rupiah per komponen estimasi",
        "stacked", comp_rows, [f"{x['komponen']}: {rp(x['nilai'])} ({pct(x['nilai'], est)})." for x in comp_rows],
        src_box + "; aturan per klaim: aip/karantina.py claim_loss", satuan="rp"))

    # 5. where: the provinces' loss, and their risky claims per 1.000 FKRTL claims
    prov = {str(r.get("provinsi") or "").upper(): r for r in I._objects(S.T_PROV)}
    by_prov: dict[str, float] = defaultdict(float)
    for r in box:
        by_prov[str(r.get("provinsi") or "-").upper()] += _f(r.get("estimasi_kerugian_rp"))
    prov_rows = []
    for name, v in sorted(by_prov.items(), key=lambda x: -x[1])[:12]:
        p = prov.get(name) or {}
        rate = 1000 * _f(p.get("klaim_berisiko")) / _f(p.get("klaim_fkrtl")) if _f(p.get("klaim_fkrtl")) else None
        prov_rows.append({"provinsi": name, "estimasi_kerugian_rp": round(v), "porsi_pct": round(100 * v / est, 1) if est else 0,
                          "klaim_berisiko_per_1000": round(rate, 2) if rate is not None else None})
    top3 = prov_rows[:3]
    out.append(_exhibit(
        "wilayah", "wilayah", f"{', '.join(_prov(x['provinsi']) for x in top3)} menanggung {pct(sum(x['estimasi_kerugian_rp'] for x in top3), est, 0)} estimasi kerugian",
        "Estimasi kerugian per provinsi (12 teratas) dan klaim berisiko per 1.000 klaim FKRTL", "bar_rate", prov_rows,
        [f"{_prov(x['provinsi'])}: {rp(x['estimasi_kerugian_rp'])} ({_id(x['porsi_pct'], 1)}%)"
         + (f", {_id(x['klaim_berisiko_per_1000'], 2)} klaim berisiko per 1.000 klaim FKRTL." if x["klaim_berisiko_per_1000"] is not None else ".")
         for x in prov_rows[:6]], src_box + "; Provinsi (BPJS): klaim_fkrtl, klaim_berisiko", satuan="rp", peta=_peta(box, est), peta_basis="box"))

    # 6. the hospital classes, by rate
    kelas = [x for x in (parts.get("kelas") or {}).get("baris") or [] if x.get("per_1000_klaim")]
    if kelas:
        hi, lo = kelas[0], kelas[-1]
        out.append(_exhibit(
            "kelas", "wilayah", f"{hi['group']} mencatat {_id(hi['per_1000_klaim'], 2)} klaim berisiko per 1.000 klaim, "
            f"{_id(hi['per_1000_klaim'] / lo['per_1000_klaim'], 1) if lo['per_1000_klaim'] else '-'}× kelas terendah",
            "Klaim berisiko per 1.000 klaim FKRTL, per kelompok peer kelas rumah sakit", "bar",
            [{"label": x["group"], "nilai": x["per_1000_klaim"], "klaim": x["value"], "klaim_fkrtl": x["klaim_fkrtl"]} for x in kelas],
            [f"{x['group']}: {_id(x['per_1000_klaim'], 2)} per 1.000 ({_id(x['value'])} klaim berisiko dari {_id(x['klaim_fkrtl'])} klaim FKRTL)." for x in kelas],
            "Klaim Berisiko (BPJS) dan Profil Faskes (BPJS) klaim_fkrtl; kelompok peer AI Agent Swarm", satuan="angka"))

    # 7. how: the modes of indication and their strength
    mode = defaultdict(Counter)
    for v in tags:
        mode[v["tag_label"]][v["kekuatan"]] += 1
    mode_rows = sorted(({"modus": k, "kuat": c.get("kuat", 0), "sedang": c.get("sedang", 0), "lemah": c.get("lemah", 0), "total": sum(c.values())}
                        for k, c in mode.items()), key=lambda x: -x["total"])[:12]
    strong = max(mode_rows, key=lambda x: x["kuat"]) if mode_rows else None
    if mode_rows:
        out.append(_exhibit(
            "modus", "modus", f"{mode_rows[0]['modus']} adalah indikasi terbanyak ({_id(mode_rows[0]['total'])} tag); "
            f"{strong['modus']} paling banyak berkekuatan kuat ({_id(strong['kuat'])})", "Tag indikasi per modus, menurut kekuatan", "strength", mode_rows,
            [f"{x['modus']}: {_id(x['total'])} tag (kuat {_id(x['kuat'])}, sedang {_id(x['sedang'])}, lemah {_id(x['lemah'])})." for x in mode_rows[:8]],
            "Buku besar indikasi AI Agent Swarm (kekuatan dihitung dari sumbernya, red team dan keputusan manusia)"))

    # 8. the INA-CBG codes that carry the risky claims, and how much the verifier corrected
    kode = sorted((parts.get("kode") or {}).get("baris") or [], key=lambda x: -x["value"])[:10]
    if kode:
        corr_hi = max(kode, key=lambda x: x.get("rasio_koreksi_pct") or 0)
        out.append(_exhibit(
            "kode", "modus", f"Kode {kode[0]['group']} paling sering muncul ({_id(kode[0]['value'])} klaim berisiko); koreksi tertinggi pada "
            f"{corr_hi['group']} ({_id(corr_hi['rasio_koreksi_pct'], 1)}% tagihan)", "Klaim berisiko per kode INA-CBG (10 teratas), rasio koreksi verifikator",
            "bar_rate", [{"label": x["group"], "nilai": x["value"], "rasio_koreksi_pct": x.get("rasio_koreksi_pct"), "diagnosis": x.get("dx_primer_nama_teratas")}
                         for x in kode],
            [f"{x['group']}: {_id(x['value'])} klaim berisiko, koreksi {_id(x.get('rasio_koreksi_pct') or 0, 1)}% tagihan; diagnosis tersering "
             f"{x.get('dx_primer_nama_teratas') or '-'}." for x in kode[:6]], "Klaim Berisiko (BPJS), lewat paket audit nasional"))

    # 9. when: risky claims per month
    tren = [x for x in (parts.get("tren") or {}).get("baris") or [] if re.fullmatch(r"\d{4}-\d{2}", str(x.get("group") or ""))]
    tren = sorted(tren, key=lambda x: x["group"])
    if len(tren) > 1:
        peak = max(tren, key=lambda x: x["value"])
        out.append(_exhibit(
            "tren", "modus", f"Klaim berisiko memuncak pada {peak['group']} ({_id(peak['value'])} klaim)", "Klaim berisiko per bulan", "line",
            [{"bulan": x["group"], "nilai": x["value"]} for x in tren],
            [f"{len(tren)} bulan, {tren[0]['group']} sampai {tren[-1]['group']}; puncak {peak['group']} dengan {_id(peak['value'])} klaim."],
            "Klaim Berisiko (BPJS), lewat paket audit nasional"))

    # 10. who: the facilities to audit first
    rank = {g: i for i, (g, _) in enumerate(K.BANDS)}
    recs = {str(e.get("faskes")): e for e in ev if e.get("type") == "rekomendasi"}
    fac = sorted(box, key=lambda r: (rank.get(r.get("kelompok"), 9), -_f(r.get("estimasi_kerugian_rp"))))[:12]
    fac_rows = []
    for r in fac:
        tsm = r.get("tsm") or {}
        e = recs.get(str(r.get("faskes_profil_id"))) or {}
        fac_rows.append({"faskes_profil_id": r.get("faskes_profil_id"), "faskes": r.get("nama"), "provinsi": _prov(str(r.get("provinsi") or "")), "kelompok": r.get("kelompok"),
                         "estimasi_kerugian_rp": round(_f(r.get("estimasi_kerugian_rp"))), "sudah_dikoreksi_rp": round(_f(r.get("sudah_dikoreksi_rp"))),
                         "tsm": " · ".join(f"{d[0].upper()}:{(tsm.get(d) or {}).get('nilai', '-')}" for d in ("terstruktur", "sistematis", "masif")),
                         "rekomendasi": e.get("jalur") or (r.get("rekomendasi") or [{}])[-1].get("jalur") or "-", "status": r.get("status")})
    a_sum = sum(_f(r.get("estimasi_kerugian_rp")) for r in box if r.get("kelompok") == "A")
    out.append(_exhibit(
        "faskes", "faskes", f"Sepuluh faskes kelompok A menanggung {rp(a_sum)} ({pct(a_sum, est, 0)}) — merekalah antrean audit pertama",
        "Faskes prioritas menurut urutan Box Karantina", "table", fac_rows,
        [f"{x['faskes']} ({x['provinsi']}): kelompok {x['kelompok']}, {rp(x['estimasi_kerugian_rp'])}, TSM {x['tsm']}, rekomendasi {x['rekomendasi']}."
         for x in fac_rows[:6]], src_box + "; rekomendasi penyidik di jejak penugasan"))

    # 11. how reliable: the validators and the model
    # the last verdict of each line: a line run again (rewrite ?ulang_lini=…) supersedes the verdict copied from the source,
    # which counted beside it before (2026-10-29: "QA Agen Faskes & Wilayah" listed 1/4 and 3/3, the title 28 of 32)
    last: dict[str, dict] = {}
    for e in ev:
        if e.get("type") == "verdict" and e.get("lini"):
            last[e["lini"]] = e
    qa = list(last.values())
    reds = Counter(str(e.get("hasil")) for e in ev if e.get("type") == "red_team")
    final = next((e for e in reversed(ev) if e.get("type") == "verdict" and e.get("validator") in ("validator", "validator_laporan")), None)
    card = ((aip_ml.current() or {}).get("summary") or {})
    rel = [{"uji": f"QA {e.get('sintesis') or LINI.get(e['lini'], e['lini'])}", "lolos": e.get("passed", 0), "total": e.get("total", 0)} for e in qa]
    if final:
        rel.append({"uji": "Validator laporan akhir", "lolos": final.get("passed", 0), "total": final.get("total", 0)})
    if reds:
        rel.append({"uji": "Red team: indikasi bertahan", "lolos": reds.get("bertahan", 0), "total": sum(reds.values())})
    qa_pass, qa_tot = sum(x["lolos"] for x in rel[:len(qa)]), sum(x["total"] for x in rel[:len(qa)])
    model_lines = [f"Model ML segmen {k.replace('_', ' ')}: {v.get('terbaik')} — AUPRC {_id(_f(v.get('auprc')), 3)}, presisi {_id(100 * _f(v.get('presisi')), 1)}%, "
                   f"recall {_id(100 * _f(v.get('recall')), 1)}%." for k, v in card.items() if isinstance(v, dict)]
    out.append(_exhibit(
        "keandalan", "keandalan", f"QA mempertahankan {_id(qa_pass)} dari {_id(qa_tot)} klaim sintesis; red team melemahkan {_id(reds.get('melemah', 0))} "
        f"dari {_id(sum(reds.values()))} indikasi terkuat", "Pemeriksaan yang lolos per uji", "checks", rel,
        [f"{x['uji']}: {_id(x['lolos'])} dari {_id(x['total'])}." for x in rel] + model_lines,
        "Putusan QA, red team dan validator laporan di jejak penugasan; kartu model ML (aip/ml.py)", model=card))

    # 12. the designed audit (the evaluation kit's slide 15): the box's top facilities, audited for certain, and a simple
    # random sample of the others as the control, under audit codes that hide the arm; what the auditors found
    pil = K._pilot_load()
    if pil:
        out.append(_designed_audit(pil))

    # 13. what to decide: the investigators' recommendations
    jal = Counter(str(e.get("jalur")) for e in recs.values())
    full = sum(all(v == "terpenuhi" for v in (e.get("tsm") or {}).values()) and bool(e.get("tsm")) for e in recs.values())
    out.append(_exhibit(
        "rekomendasi", "keputusan", f"Penyidik merekomendasikan {_id(jal.get('dibina', 0))} faskes dibina dan {_id(jal.get('ditindak', 0))} ditindak; "
        f"{_id(full)} memenuhi ketiga unsur TSM", "Rekomendasi jalur penyidik per faskes yang diaudit", "stacked",
        [{"komponen": k, "kunci": k, "nilai": jal.get(k, 0)} for k in ("dibina", "ditindak", "dibebaskan")],
        [f"{_id(len(recs))} faskes diaudit penyidik: {_id(jal.get('dibina', 0))} dibina, {_id(jal.get('ditindak', 0))} ditindak, "
         f"{_id(jal.get('dibebaskan', 0))} dibebaskan; {_id(full)} dengan TSM terpenuhi penuh."],
        "Rekomendasi penyidik di jejak penugasan; keputusan akhir di tangan manusia (Box Karantina)", satuan="angka"))

    # 14. what the engagement cost
    by_model: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    for u in (run.get("agents_usage") or {}).values():
        m = str(u.get("model") or "?").split("/")[-1].replace("-maas", "")
        by_model[m][0] += _f(u.get("usd"))
        by_model[m][1] += _f(u.get("prompt")) + _f(u.get("output"))
        by_model[m][2] += 1
    usd = sum(v[0] for v in by_model.values())
    cost_rows = [{"komponen": m, "kunci": m, "nilai": round(v[0], 4), "token": int(v[1]), "agen": int(v[2])} for m, v in sorted(by_model.items(), key=lambda x: -x[1][0])]
    if cost_rows:
        out.append(_exhibit(
            "biaya", "lampiran", f"Penugasan berbiaya ${_id(usd, 2)}; {cost_rows[0]['komponen']} menanggung {pct(cost_rows[0]['nilai'], usd, 0)}",
            "Biaya model per model (USD)", "stacked", cost_rows,
            [f"{x['komponen']}: ${_id(x['nilai'], 2)} ({pct(x['nilai'], usd)}), {_id(x['token'] / 1e6, 2)} juta token, {_id(x['agen'])} agen." for x in cost_rows],
            "Buku biaya gateway per agen (run.agents_usage)", satuan="usd"))
    for i, x in enumerate(out, 1):
        x["nomor"] = i
    return out


# ------------------------------------------------------------------------------------------------ the case files

DPJP_NOTE = ("Data Sampel BPJS Kesehatan tidak memuat identitas dokter (DPJP), tenaga kesehatan atau ID faskes asli. Rincian terdekat "
             "di tiap berkas: unit layanan (poli), peserta dan klaimnya; ID kunjungan di tabel klaim dipakai untuk menarik berkas klaim "
             "dari faskes saat audit lapangan, termasuk DPJP-nya.")


_files: dict[tuple, tuple[float, list[dict]]] = {}  # (run, viewer, their markings) -> (when, its case files): ~4 s to build


def case_files_cached(run: dict, ev: list[dict], request: Any = None) -> list[dict]:
    """The case files for five minutes: the Box changes at an engagement's end or a human decision, not per page view."""
    import auth

    key = (run["id"], (auth.current() or {}).get("id"), tuple(sorted(I._viewer_markings() or ())))  # what each viewer may see
    hit = _files.get(key)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    files = case_files(run, ev, request)
    _files[key] = (time.time(), files)
    return files


def case_files(run: dict, ev: list[dict], request: Any = None, limit: int = 30) -> list[dict]:
    """The case file of each facility the engagement's investigators audited (the user, 2026-10-24: the report should
    "cover detailed information like which doctor involved"): its profile, the loss and what it is made of, the
    investigator's judgement in full, the modes of indication, the care units (poli) the loss sits in, the patients behind
    its claims, and the claims themselves — every figure computed here from the same objects and the Box's rule per
    claim (karantina.claim_loss), so the files add up to the Box. The sample holds no doctor identity (DPJP_NOTE)."""
    from aip import paket

    have = I._viewer_markings()
    box = {str(r.get("faskes_profil_id")): r for r in _box(run)}
    audited = [str(e.get("faskes")) for e in ev if e.get("type") == "rekomendasi"]
    rank = {g: i for i, (g, _) in enumerate(K.BANDS)}
    fids = [f for f in dict.fromkeys(audited) if f in box] or [f for f, r in box.items() if r.get("kelompok") == "A"]
    fids = sorted(fids, key=lambda f: (rank.get(box[f].get("kelompok"), 9), -_f(box[f].get("estimasi_kerugian_rp"))))[:limit]
    want = set(fids)
    cid = lambda r: str(r.get("klaim_id") or r["_kunci"])  # noqa: E731
    national = paket._national(request)
    claims: dict[str, list[dict]] = defaultdict(list)
    for r in national:
        if str(r.get("faskes_profil_id")) in want:
            claims[str(r.get("faskes_profil_id"))].append(r)
    tags = [v for v in (I.view(x) for x in I._all().values() if I.standing(x)) if I._visible(v, have)]
    by_claim: dict[str, set] = defaultdict(set)
    mode: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    claim_tags: dict[str, list[dict]] = defaultdict(list)  # a claim of these facilities -> its tags (their evidence)
    fac_tags: dict[str, list[dict]] = defaultdict(list)  # a facility -> the tags on the facility itself
    for v in tags:
        fid = str(v["kunci"]) if v["entitas"] == "faskes" else str((v.get("konteks") or {}).get("faskes_profil_id") or "")
        if v["entitas"] == "klaim":
            by_claim[str(v["kunci"])].add(v["tag"])
        if fid in want:
            mode[fid][v["tag_label"]][v["kekuatan"]] += 1
            (claim_tags[str(v["kunci"])] if v["entitas"] == "klaim" else fac_tags[fid]).append(v)
    screened = {cid(r): r for r in national}

    def evidence(vs: list[dict], n: int) -> list[dict]:
        """What each tag says, strongest first: the rule or the agent, and its own words with their numbers."""
        return [{"indikasi": v["tag_label"], "kekuatan": v["kekuatan"], "oleh": "penanda otomatis" if v.get("otomatis") else ", ".join(v.get("agen_pendukung") or [])[:80],
                 "teks": str(v.get("bukti") or "")[:600]} for v in sorted(vs, key=lambda v: -v["tingkat"]) if v.get("bukti")][:n]
    ml = {cid(r): r for r in I._objects(S.T_ML_KLAIM)}
    r_med, _ = K._correction_median({cid(r): r for r in national})
    people = {str(r.get("peserta_key") or r["_kunci"]): r for r in I._objects(S.T_PESERTA)}
    profiles = {str(r.get("faskes_profil_id") or r["_kunci"]): r for r in I._objects(S.T_FASKES)}
    out = []
    for fid in fids:
        b, prof, rows = box[fid], profiles.get(fid) or {}, claims.get(fid, [])
        lost = {cid(r): K.claim_loss(cid(r), r, ml.get(cid(r)) or {}, by_claim[cid(r)], r_med) for r in rows if cid(r) in by_claim}
        val = {c: (0.0 if x["dikoreksi"] else max(x["parts"].values(), default=0.0)) for c, x in lost.items()}
        units: dict[str, list[float]] = defaultdict(lambda: [0, 0, 0.0, 0.0])
        for r in rows:
            u = units[str(r.get("poli") or "tidak tercatat")]
            u[0] += 1
            u[1] += cid(r) in by_claim
            u[2] += _f(r.get("biaya_tagih_rp"))
            u[3] += val.get(cid(r), 0.0)
        pts: dict[str, list[dict]] = defaultdict(list)
        for r in rows:
            pts[str(r.get("peserta_key") or r.get("peserta_id") or "")].append(r)
        repeat = sorted(((k, rs) for k, rs in pts.items() if k and len(rs) > 1), key=lambda x: (-len(x[1]), -sum(_f(r.get("biaya_tagih_rp")) for r in x[1])))[:6]
        contributors = []
        for c in b.get("klaim_kontributor") or []:  # the Box's own top claims (its rule, tag-only claims included): they add up to it
            key = str(c.get("klaim_id"))
            k, m = screened.get(key) or {}, ml.get(key) or {}
            tk = next(((v.get("konteks") or {}) for v in claim_tags.get(key, []) if (v.get("konteks") or {}).get("biaya_tagih_rp")), {})
            contributors.append({
                "kunjungan_id": k.get("kunjungan_fkrtl_id") or key.split(":", 1)[-1], "edisi": key.split(":", 1)[0] if ":" in key else k.get("edisi"),
                "tgl_datang": k.get("tgl_datang") or m.get("tgl_datang"), "tgl_pulang": k.get("tgl_pulang"), "bulan": k.get("bulan") or tk.get("bulan"),
                "los_hari": k.get("los_hari") or m.get("los") or c.get("los_hari"), "poli": k.get("poli"), "kelas_rawat": k.get("kelas_rawat"),
                "inacbg_kode": k.get("inacbg_kode") or m.get("inacbg_kode") or tk.get("inacbg_kode") or c.get("inacbg_kode"),
                "keparahan": k.get("inacbg_keparahan") or m.get("inacbg_keparahan"), "dx_primer": k.get("dx_primer_nama") or m.get("dx_primer_icd3"),
                "peserta_id": k.get("peserta_id"), "biaya_tagih_rp": k.get("biaya_tagih_rp") or m.get("biaya_tagih") or tk.get("biaya_tagih_rp") or c.get("dibayar_rp"),
                "biaya_verifikasi_rp": k.get("biaya_verifikasi_rp"), "peer_biaya_p50_rp": k.get("peer_biaya_p50_rp") or c.get("peer_p50_rp") or None,
                "rasio_biaya_peer": k.get("rasio_biaya_peer"), "estimasi_kerugian_rp": c.get("nilai_rp"), "komponen": COMPONENT.get(str(c.get("komponen")), c.get("komponen")),
                "indikasi": sorted(S.TAG.get(t, {}).get("label", t) for t in c.get("tag") or []), "bukti": evidence(claim_tags.get(key, []), 3),
                "di_skrining": bool(k)})
        recorded = [p for p in units if p != "tidak tercatat"]
        rec = next((x for x in reversed(b.get("rekomendasi") or []) if x.get("run_id") == run["id"]), None) or ((b.get("rekomendasi") or [None])[-1])
        tsm = b.get("tsm") or {}
        out.append({
            "faskes_profil_id": fid, "nama": b.get("nama"), "provinsi": _prov(str(b.get("provinsi") or "")), "kabkota": str(prof.get("kabkota") or "").title(),
            "kelompok": b.get("kelompok"), "status": b.get("status"),
            "profil": {k: prof.get(k) for k in ("tipe", "jenis", "kepemilikan", "tingkat", "klaim_fkrtl", "klaim_inap", "pct_readmisi_30", "klaim_berisiko",
                                                 "biaya_tagih_rp", "biaya_verifikasi_rp")},
            "kerugian": {"estimasi_rp": round(_f(b.get("estimasi_kerugian_rp"))), "sudah_dikoreksi_rp": round(_f(b.get("sudah_dikoreksi_rp"))),
                         "terpapar_rp": round(_f(b.get("nilai_terpapar_rp"))), "rincian": {COMPONENT.get(k, k): v for k, v in (b.get("rincian_kerugian") or {}).items()}},
            "tsm": {d: (tsm.get(d) or {}).get("nilai") for d in ("terstruktur", "sistematis", "masif")},
            "penyidik": {"jalur": rec.get("jalur"), "alasan": rec.get("alasan"), "agen": rec.get("agen"), "model": rec.get("model"), "tsm": rec.get("tsm"),
                         "pada": rec.get("t")} if rec else None,
            "modus": sorted(({"modus": k, "kuat": c.get("kuat", 0), "sedang": c.get("sedang", 0), "lemah": c.get("lemah", 0), "total": sum(c.values())}
                             for k, c in mode[fid].items()), key=lambda x: (-x["kuat"], -x["total"]))[:8],
            # the care units, only where the data records them (inpatient claims of the sample mostly do not)
            "poli": sorted(({"poli": k, "klaim_berisiko": int(v[0]), "klaim_bertag": int(v[1]), "biaya_tagih_rp": round(v[2]), "estimasi_kerugian_rp": round(v[3])}
                            for k, v in units.items()), key=lambda x: (-x["estimasi_kerugian_rp"], -x["klaim_berisiko"]))[:6] if recorded else [],
            "poli_tercatat": f"{_id(sum(units[p][0] for p in recorded))} dari {_id(len(rows))} klaim berisiko" if rows else "-",
            "temuan_faskes": evidence(fac_tags.get(fid, []), 6),
            "peserta": {"jumlah": len([k for k in pts if k]), "klaim_berisiko": len(rows), "berulang": [
                {"peserta_id": (people.get(k) or {}).get("peserta_id") or rs[0].get("peserta_id"), "jenis_kelamin": (people.get(k) or {}).get("jenis_kelamin"),
                 "usia": (people.get(k) or {}).get("usia_akhir_2024"), "segmen": (people.get(k) or {}).get("segmen"), "klaim": len(rs),
                 "biaya_tagih_rp": round(sum(_f(r.get("biaya_tagih_rp")) for r in rs)), "readmisi_30": sum(bool(r.get("readmisi_30")) for r in rs),
                 "calon_klaim_ganda": sum(bool(r.get("flag_calon_klaim_ganda")) for r in rs)} for k, rs in repeat]},
            "klaim": contributors,
            "porsi_klaim_pct": round(100 * sum(_f(c["estimasi_kerugian_rp"]) for c in contributors) / _f(b.get("estimasi_kerugian_rp")), 1)
            if _f(b.get("estimasi_kerugian_rp")) else None,
            "klaim_bertag": b.get("klaim_bertag"),
        })
    return out


CHAPTERS = [
    ("ringkasan", "Ringkasan eksekutif", ["ringkasan", "awam"]),
    ("skala", "Skala dan konsentrasi kerugian", ["temuan"]),
    ("wilayah", "Di mana risikonya berada", ["wilayah"]),  # written by the firm since 2026-10-24 (adk_runtime/firm.py SECTIONS)
    ("modus", "Bagaimana indikasi fraud terjadi", ["modus"]),
    ("faskes", "Faskes prioritas dan Box Karantina", ["box"]),
    ("kasus", "Berkas kasus per faskes", []),
    ("keandalan", "Seberapa andal temuan ini", ["keandalan"]),
    ("keputusan", "Keputusan yang dibutuhkan", ["keputusan"]),
    ("lampiran", "Lampiran: lingkup, metode dan biaya", ["lingkup"]),
]


# ------------------------------------------------------------------------------------------------ the commentary


def _path(run_id: str):
    from aip import vertex as aip_vertex

    d = aip_vertex.DIR.parent / "laporan_konsultan"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{run_id}.json"


def commentary(run_id: str) -> Optional[dict]:
    try:
        return json.loads(_path(run_id).read_text("utf-8"))
    except (OSError, ValueError):
        return None


PROMPT = """Anda partner firma konsultan audit kesehatan yang menulis penjelasan exhibit untuk laporan audit indikasi fraud
klaim FKRTL JKN kepada direksi BPJS Kesehatan. Untuk SETIAP exhibit di bawah, tulis:
- "makna": 2–3 kalimat — apa artinya bagi BPJS, mengapa penting, apa yang tidak terlihat dari angka saja;
- "implikasi": 1 kalimat — tindakan yang disarankan.
Aturan: pakai HANYA angka yang tertulis di fakta exhibit itu, ditulis sama persis (format Indonesia: 1.234; 3,7%; Rp 5,18 miliar);
jangan menghitung angka baru; indikasi bukan fraud terbukti — keputusan di tangan manusia; bahasa Indonesia baku, ringkas, tanpa
istilah teknis yang tidak perlu. Jawab HANYA JSON dengan kunci id exhibit yang tertulis dalam kurung siku (mis. "skala"),
bukan nomornya: {"<id exhibit>": {"makna": "…", "implikasi": "…"}, …}

Exhibit:
"""


# a sentence that opens on a link to the one before it reads wrong first (its predecessor dropped by code, or never there)
_LINK = re.compile(r"^(Sebaliknya|Namun|Selain itu|Sementara itu|Di sisi lain)\s*,?\s+", re.I)


def _tidy(note: dict) -> dict:
    return {eid: {k: (lambda t: t[:1].upper() + t[1:])(_LINK.sub("", str(v))) for k, v in part.items()} for eid, part in note.items()}


def _parse(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    i, j = text.find("{"), text.rfind("}")
    return json.loads(text[i:j + 1]) if i >= 0 < j else {}


def write_commentary(run_id: str, ex: list[dict]) -> dict:
    """The writer model's commentary on every exhibit, each sentence kept only when code finds its numbers in the
    exhibit's facts; saved for the engagement."""
    from aip import models as aip_models
    from aip import vertex as aip_vertex

    model = aip_models.pick("writer", strong=True)
    body: dict[str, Any] = {"model": aip_models.publisher_model(model), "temperature": 0.2, "max_tokens": 6000,
                            "messages": [{"role": "system", "content": "Anda menulis JSON yang diminta, tanpa teks lain."},
                                         {"role": "user", "content": PROMPT + _facts(ex)}]}
    if aip_models.family(model) == "zai-org":
        body["chat_template_kwargs"] = {"enable_thinking": False}
    elif aip_models.family(model) == "openai":
        body["reasoning_effort"] = "medium"
    got: dict = {}
    problem = ""
    for attempt in range(3):
        r = aip_vertex.post(model, body, aip_models.attempt_timeout(6000))
        if r.status_code == 200:
            msg = (r.json().get("choices") or [{}])[0]
            text = (msg.get("message") or {}).get("content") or ""
            try:
                got = _parse(text)
                if got:
                    break
                problem = f"jawaban tanpa JSON (selesai: {msg.get('finish_reason')}): {text[:240]}"
            except (ValueError, KeyError) as e:
                problem = f"JSON tidak terbaca ({e}; selesai: {msg.get('finish_reason')}): {text[:240]}"
        else:
            problem = f"HTTP {r.status_code}: {r.text[:240]}"
        time.sleep(4 * (attempt + 1))
    if not got:  # nothing to keep: an error to show, never an empty commentary marked as written
        raise RuntimeError(problem or "model tidak menjawab")
    return gate_commentary(run_id, ex, got, model, "penulis")


def _facts(ex: list[dict]) -> str:
    return "\n".join(f"[{x['id']}] Exhibit {x['nomor']}: {x['judul']}\n  ukuran: {x['ukuran']}\n  fakta: " + " ".join(x["fakta"]) for x in ex)


def gate_commentary(run_id: str, ex: list[dict], got: dict, model: str, by: str) -> dict:
    """A commentary as code keeps it — every sentence whose numbers the exhibit's own facts do not give is dropped and
    named — saved for the engagement. Whoever wrote it (the writer model on an administrator's click, or the
    engagement's exhibit analyst), the same gate: the runtime's own check is not trusted, it is done again here."""
    from aip.adk_runtime.orkestrasi import plain_check

    by_id = {x["id"]: x for x in ex}
    by_no = {str(x["nomor"]): x["id"] for x in ex}
    kept: dict[str, dict] = {}
    dropped: list[dict] = []
    for key, v in (got or {}).items():
        # keyed by the id as asked, or as "[id]", "Exhibit 3", "3" (models number them as the list reads)
        k = str(key).strip().strip("[]").strip()
        eid = k if k in by_id else by_no.get(re.sub(r"(?i)^exhibit\s*", "", k))
        if not eid or not isinstance(v, dict):
            continue
        source = by_id[eid]["judul"] + "\n" + "\n".join(by_id[eid]["fakta"])
        part: dict[str, str] = {}
        for k in ("makna", "implikasi"):
            sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", str(v.get(k) or "")) if s.strip()]
            ok = []
            for sent in sents:
                why = plain_check(sent, source)
                (dropped.append({"exhibit": eid, "teks": sent, "alasan": why}) if why else ok.append(sent))
            if ok:
                part[k] = " ".join(ok)
        if part:
            kept[eid] = part
    if not kept and not dropped:
        raise RuntimeError(f"bentuk JSON tidak dikenali: kunci {list(got)[:6]}; {json.dumps(got, ensure_ascii=False)[:300]}")
    out = {"run": run_id, "model": model, "oleh": by, "pada": datetime.now(timezone.utc).isoformat(timespec="seconds"), "narasi": kept, "dibuang": dropped}
    _write(_path(run_id), out)
    _failed.pop(run_id, None)
    return out


def _write(p: Any, doc: dict) -> None:
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(p)


# ------------------------------------------------------------------------------------------------ the frozen report


def _frozen_path(run_id: str):
    return _path(run_id).with_name(f"{run_id}.beku.json")


def frozen(run_id: str) -> Optional[dict]:
    try:
        return json.loads(_frozen_path(run_id).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def freeze(run_id: str, request: Any = None) -> dict:
    """The exhibits and the case files as the engagement leaves them, kept with it (the report desk calls this at the
    engagement's end): a later engagement changes the Box and the ledger, not this report. Returns what the exhibit
    analyst writes from — the exhibits' facts in the commentary's prompt."""
    import auth

    from aip import runs

    run = runs.check_access(run_id)
    ev = runs._events(run_id)
    ex = exhibits(run, ev, request)
    files = case_files(run, ev, request)
    have = I._viewer_markings()
    doc = {"run": run_id, "pada": datetime.now(timezone.utc).isoformat(timespec="seconds"), "oleh": (auth.current() or {}).get("username"),
           "markings": sorted(have) if have is not None else None, "exhibit": ex, "berkas": files}
    _write(_frozen_path(run_id), doc)
    _files.clear()
    return {"exhibit": [{"id": x["id"], "nomor": x["nomor"], "judul": x["judul"]} for x in ex], "berkas": len(files), "prompt": PROMPT + _facts(ex)}


def _may_see(doc: dict) -> bool:
    """A frozen report is served as it was frozen only to an administrator who holds every marking it was frozen with
    (or where sign-in is off); anyone else gets the report computed for what they may see."""
    import auth

    have = I._viewer_markings()
    if have is None:
        return True
    p = auth.current() or {}
    return p.get("role") == "admin" and set(doc.get("markings") or []) <= have


def save_agent_commentary(run_id: str, model: str, got: dict) -> dict:
    """The exhibit analyst's commentary, gated against the frozen exhibits it was written from."""
    doc = frozen(run_id)
    if not doc:
        raise ValueError("exhibit belum dibekukan")
    if not isinstance(got, dict) or not got:
        _failed[run_id] = "analis exhibit tidak menghasilkan JSON penjelasan"
        return {"disimpan": 0, "dibuang": 0, "alasan": _failed[run_id]}
    try:
        out = gate_commentary(run_id, doc["exhibit"], got, model, "analis_exhibit")
    except RuntimeError as e:
        _failed[run_id] = str(e)[:400]
        return {"disimpan": 0, "dibuang": 0, "alasan": _failed[run_id]}
    return {"disimpan": len(out["narasi"]), "dibuang": len(out["dibuang"]), "contoh_dibuang": out["dibuang"][:3]}


def start_commentary(run_id: str, ex: list[dict]) -> str:
    """The commentary in a background thread, once at a time per engagement."""
    with _lock:
        if run_id in _writing and time.time() - _writing[run_id] < 600:
            return "menulis"
        _writing[run_id] = time.time()

    def go() -> None:
        try:
            write_commentary(run_id, ex)
            _failed.pop(run_id, None)
        except Exception as e:  # noqa: BLE001 - the report stands without it; the page shows why and offers it again
            log.exception("komentar exhibit %s", run_id)
            _failed[run_id] = str(e)[:400]
        finally:
            with _lock:
                _writing.pop(run_id, None)

    threading.Thread(target=go, daemon=True).start()
    return "menulis"


def _warm_lineage(files: list[dict], request: Any = None, run: Optional[dict] = None) -> None:
    """The data lineage the page opens by default — the first claim of the case file with the largest loss — traced in
    the background as this viewer (aip/jejak_data.py caches it), so it is there when the reader reaches it."""
    import contextvars

    from aip import jejak_data as J

    top = max(files or [], key=lambda f: (f.get("kerugian") or {}).get("estimasi_rp") or 0, default=None)
    if not top or not top.get("klaim"):
        return
    c = top["klaim"][0]
    cid = f"{c.get('edisi')}:{c.get('kunjungan_id')}"

    def go() -> None:
        try:
            J.trace(cid, str(top["faskes_profil_id"]), request, run)
        except Exception:  # noqa: BLE001 - only a warm-up: the page asks again and shows why
            log.debug("jejak data %s", cid, exc_info=True)

    threading.Thread(target=contextvars.copy_context().run, args=(go,), daemon=True).start()


def _map_for_frozen(ex: list[dict], run: dict) -> None:
    """A report frozen before the map: its province exhibit gets every province's rate, and the loss of every province
    when the Box still holds what it was frozen from (its top provinces' loss unchanged), else of its own top rows."""
    w = next((x for x in ex if x.get("id") == "wilayah"), None)
    if not w or w.get("peta"):
        return
    box = _box(run)
    est = sum(_f(r.get("estimasi_kerugian_rp")) for r in box)
    now: dict[str, float] = defaultdict(float)
    for r in box:
        now[str(r.get("provinsi") or "-").upper()] += _f(r.get("estimasi_kerugian_rp"))
    frozen_rows = {str(r.get("provinsi") or "").upper(): _f(r.get("estimasi_kerugian_rp")) for r in w.get("baris") or []}
    same = bool(frozen_rows) and all(round(now.get(k, 0)) == round(v) for k, v in frozen_rows.items())         and sorted(now, key=lambda k: -now[k])[:len(frozen_rows)] == list(frozen_rows)
    if same:
        w["peta"], w["peta_basis"] = _peta(box, est), "box"
    else:
        w["peta"], w["peta_basis"] = _peta([], est, only={str(r.get("provinsi") or "").upper(): r for r in w.get("baris") or []}), "teratas"


def build(run_id: str, request: Any = None) -> dict:
    from aip import runs

    run = runs.check_access(run_id)
    ev = runs._events(run_id)
    sec = _sections(ev)
    report = next((e for e in reversed(ev) if e.get("type") == "engagement"), {})
    # as the engagement left them (frozen by its report desk), or — an engagement from before, or a viewer who may not
    # see all it holds — computed now from the engagement's own Box when it kept one (else the current Box) and the ledger
    doc = frozen(run_id)
    doc = doc if doc and _may_see(doc) else None
    ex = doc["exhibit"] if doc else exhibits(run, ev, request)
    if doc:
        _map_for_frozen(ex, run)
    firm = next((e for e in ev if e.get("type") == "firm"), {})
    note = commentary(run_id)
    note = note if note and note.get("narasi") else None  # an empty one (written before failures were raised) is none
    from aip import paket

    own = runs.engagement_of(run_id)  # a report rewrite reads the Box of the engagement it rewrites (through a rewrite of one)
    latest = run_id if doc else own if (K._snap_runs().get(own) or {}).get("lengkap") else (paket._last_engagement()[0] or {}).get("id")
    berkas = doc["berkas"] if doc else case_files_cached(run, ev, request)
    _warm_lineage(berkas, request, run)
    # the IoMT chapter kept with this engagement (aip/laporan_iomt.py, Blu 2.0: a synthetic world, said so in it): after
    # the case files, its exhibits numbered with the others in chapter order (no chapter's text names an exhibit number)
    from aip import laporan_iomt

    chapters, iomt = CHAPTERS, laporan_iomt.part(run_id)
    if iomt:
        at = next(i for i, c in enumerate(CHAPTERS) if c[0] == iomt["setelah"]) + 1
        chapters = [*CHAPTERS[:at], (*iomt["bab"], []), *CHAPTERS[at:]]
        order = [c[0] for c in chapters]
        ex = sorted([*ex, *iomt["exhibit"]], key=lambda x: (order.index(x["bab"]) if x["bab"] in order else len(order), x.get("nomor") or 0))
        for i, x in enumerate(ex, 1):
            x["nomor"] = i
    return {
        # the box behind the exhibits: this engagement's when frozen or kept (a rewrite: its source's), else the last engagement's
        "basis": latest, "beku_pada": (doc or {}).get("pada"),
        "run": run_id, "status": run.get("status"), "mulai": run.get("created_at"), "selesai": run.get("finished_at"), "biaya_usd": run.get("spent_usd"),
        "agen": len(firm.get("tim") or []) + sum(len(e.get("agents") or []) for e in ev if e.get("type") == "instances"),
        "judul": next((ln.lstrip("# ").strip() for ln in str(report.get("laporan") or "").splitlines() if ln.startswith("# ")), "Audit indikasi fraud klaim FKRTL JKN"),
        "bab": [{"id": cid, "judul": title, "bagian": iomt["bagian"] if iomt and cid == iomt["bab"][0] else [{"id": s, **sec[s]} for s in parts if s in sec],
                 "exhibit": [x["id"] for x in ex if x["bab"] == cid]}
                for cid, title, parts in chapters],
        # a copy of another engagement's results (Blu 2.0 from Blu 1.0), and the IoMT chapter it carries
        "salinan_dari": run.get("salinan_dari"), "iomt": {"bab": iomt["bab"][0], "pada": iomt["pada"], "seed": iomt["seed"]} if iomt else None,
        "exhibit": ex, "berkas": berkas, "catatan_dpjp": DPJP_NOTE, "narasi": _tidy(note["narasi"]) if note else None, "narasi_model": (note or {}).get("model"), "narasi_oleh": (note or {}).get("oleh"), "narasi_pada": (note or {}).get("pada"),
        "narasi_dibuang": len((note or {}).get("dibuang") or []),
        "narasi_status": "menulis" if run_id in _writing else "ada" if note else "gagal" if run_id in _failed else "belum",
        "narasi_galat": _failed.get(run_id),
    }
