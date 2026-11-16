"""The IoMT chapter of an engagement's long report (the user, 2026-11-08: "copy paste hasil run blu 1.0 ke project baru terus
tambahin IoMT ke laporan audit", the project "Blu 2.0"): claims checked against the medical devices that observed them.

The source is one run of synthetic-iomt/audit.py (its report.json), kept beside the engagement's frozen report as
laporan_konsultan/<run>.iomt.json, so a later audit run does not change this report. The world is SYNTHETIC: fictional
hospitals, claims and device readings, none of the BPJS sample. The chapter says so first, its exhibits say so in their
titles' measure line and sources, and none of its rupiah is added to the swarm's loss figures. Everything here is written
by code from the kept numbers (the audit's English strings are rewritten in Indonesian from their rule ids); nothing is a
model's text.

    attach(run_id, report_json_path)   keep an audit result with an engagement (a one-off, from a script)
    part(run_id)                       the chapter for laporan_konsultan.build, or None when none is kept
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

BAB = ("iomt", "Bukti perangkat medis (IoMT)")
AFTER = "kasus"  # the chapter follows the case files, before "how reliable"

MODE = {
    "upcoding": ("Upcoding dan unbundling", "Tarif, tingkat keparahan atau kode lebih tinggi daripada perawatan yang tercatat perangkat."),
    "phantom": ("Klaim fiktif dan klaim berulang", "Layanan ditagih padahal tidak ada perangkat yang mencatatnya, atau ditagih dua kali."),
    "inflated": ("Tagihan digelembungkan", "Hari, jam, dosis atau implan yang ditagih melebihi yang dipakai."),
    "stay": ("Lama rawat diperpanjang dan readmisi", "Rawat inap ditagih lebih lama daripada tempat tidur terisi, atau satu rawat inap dipecah dua."),
    "integrity": ("Kloning dan integritas data", "Bukti disalin, diubah setelah dijangkarkan, atau dibuat kunci perangkat yang sudah dicabut."),
    "explain": ("Perlu klarifikasi", "Bukan tuduhan: bukti tidak lengkap, terlambat, atau faskes sedang offline."),
}
RULE = {
    "severity_vs_acuity": "Tingkat keparahan III ditagih; intensitas perawatan terukur rendah",
    "hd_short_isolated": "Sesi dialisis di bawah 3 jam, berdiri sendiri: bisa jadi alasan klinis",
    "vent_run_96": "Kode 96.72 ditagih, tetapi ventilator tidak pernah menyala 96 jam berturut-turut",
    "hd_short": "Sesi dialisis di bawah 3 jam ditagih penuh (pola di faskes ini)",
    "niv_as_invasive": "Ventilasi non-invasif ditagih sebagai invasif",
    "imaging_unbundled": "Setiap akuisisi CT ditagih sebagai pemeriksaan tersendiri",
    "no_device_trace": "Layanan ditagih tanpa satu pun pembacaan perangkat",
    "visit_no_checkin": "Kunjungan ditagih tanpa catatan check-in",
    "imaging_count": "Pemeriksaan pencitraan ditagih lebih banyak daripada yang dicatat alat",
    "hd_phantom": "Dialisis ditagih; mesin tidak menjalankan sesi apa pun",
    "hd_duplicate": "Sesi dialisis yang sama ditagih dua kali",
    "vent_standby": "Ventilasi ditagih; ventilator dalam mode standby",
    "icu_phantom": "Hari ICU ditagih; pasien hanya di tempat tidur bangsal",
    "drug_units": "Vial obat ditagih lebih banyak daripada yang diberikan pompa infus",
    "icu_days": "Hari ICU ditagih lebih banyak daripada tempat tidur terisi",
    "implant_unscanned": "Nomor seri implan ditagih tetapi tidak pernah dipindai keluar",
    "implant_serial_reuse": "Nomor seri implan yang sama muncul di lebih dari satu klaim",
    "los_padding": "Tanggal pulang ditagih lebih lambat daripada tempat tidur dikosongkan",
    "split_stay": "Satu rawat inap tanpa jeda ditagih sebagai dua klaim",
    "impossible_travel": "Satu peserta check-in di dua faskes pada saat yang sama",
    "anchor_mismatch": "Pembacaan tidak cocok dengan jangkar bukti di ledger",
    "cloned_vitals": "Tanda vital identik dengan episode pasien lain",
    "revoked_device": "Pembacaan dari kunci perangkat yang sudah dicabut",
    "late_anchor": "Bukti dijangkarkan setelah klaim diajukan",
    "faskes_offline": "Tidak ada pembacaan: gateway faskes sedang offline",
    "evidence_incomplete": "Sebagian pembacaan hilang: angka terukur adalah batas bawah",
}
MEASURE = {"Length of stay": "Lama rawat", "Imaging exams": "Pemeriksaan pencitraan", "ICU days": "Hari ICU", "Invasive ventilation": "Ventilasi invasif",
           "High-cost drug vials": "Vial obat mahal", "Dialysis session": "Sesi dialisis", "Implants": "Implan"}
UNIT = {"days": "hari", "exams": "pemeriksaan", "h": "jam", "vials": "vial", "min": "menit", "units": "unit"}
SERIES = {"icu_bed_occupied": "Tempat tidur ICU terisi", "bed_occupied": "Tempat tidur bangsal terisi", "ventilation_active": "Ventilator menyala",
          "dialysis_active": "Mesin dialisis berjalan"}
COVERAGE = {"full": "IoMT lengkap", "icu_hd": "IoMT di ICU dan HD", "ward": "IoMT di bangsal", "none": "tanpa IoMT"}
TYPE = {"Inpatient": "Rawat inap", "Outpatient": "Rawat jalan"}
NEXT = {"dispute": "Minta catatan perangkat dan tahan pembayaran item yang disanggah sampai dijelaskan.",
        "verify": "Minta penjelasan atau catatan klinis dari faskes sebelum memutuskan. Bukan tuduhan."}
FLAG = {"dispute": "disanggah", "verify": "perlu klarifikasi"}
STEP = {  # the audit's workflow steps: title, unit, and the detail rewritten from its numbers
    "ingest": ("Baca data perangkat", "pembacaan", r"([\d,]+) devices at (\d+)", "{0} perangkat di {1} faskes ber-IoMT"),
    "integrity": ("Periksa integritas bukti", "episode berjangkar", r"(\d+) do not match.*?(\d+) anchored after.*?(\d+) on a revoked",
                  "{0} tidak cocok dengan jangkarnya, {1} dijangkarkan setelah klaim, {2} dari kunci yang dicabut"),
    "reconcile": ("Cocokkan klaim dengan perangkat", "klaim berbukti perangkat", r"([\d,]+) claims", "{0} klaim tanpa perangkat yang mengamati: di luar jangkauan"),
    "guardrails": ("Terapkan pagar pengaman", "ditahan untuk klarifikasi", r"(\d+) faskes offline, (\d+) late anchors, (\d+) isolated",
                   "{0} faskes offline, {1} jangkar terlambat, {2} sesi pendek yang berdiri sendiri"),
    "decide": ("Putuskan", "disanggah", r"(\d+) to verify", "{0} perlu klarifikasi; setiap sanggahan membawa buktinya"),
}
LIMITS = [
    "Klaim hanya bisa diperiksa bila ada perangkat yang mengamatinya: bangsal tanpa monitor dan faskes tanpa IoMT berada di luar jangkauan.",
    "Perangkat mengukur apa yang berjalan dan berapa lama, bukan diagnosis: temuan tingkat keparahan adalah permintaan telaah, bukan sanggahan.",
    "Perangkat tetap bisa keliru atau dipalsukan; jangkar bukti dan nomor urut pembacaan membuat perubahan terlihat, bukan mustahil.",
    "Pembacaan yang hilang selalu dihitung menguntungkan klaim, sehingga gangguan jaringan tidak pernah dibaca sebagai fraud.",
]


def _lc(s: str) -> str:
    """A title inside a sentence: only its first letter lowered (III, ICU, CT and IoMT stay as they are)."""
    return s[:1].lower() + s[1:]


def _dir() -> Path:
    from aip import vertex as aip_vertex

    return aip_vertex.DIR.parent / "laporan_konsultan"


def _file(run_id: str) -> Path:
    return _dir() / f"{run_id}.iomt.json"


def attach(run_id: str, source: Path) -> dict:
    """An audit result kept with an engagement: the parts the chapter reads, as they are today."""
    rep = json.loads(Path(source).read_text("utf-8"))
    claims = [c for c in rep.get("claims") or [] if c.get("flag") == "dispute"]
    featured, seen = [], set()
    for c in sorted(claims, key=lambda c: -(c.get("estRp") or 0)):  # the largest dispute of each kind, for the example exhibit
        rule = (c.get("findings") or [{}])[0].get("rule")
        if rule not in seen and c.get("timeline"):
            featured.append(c)
            seen.add(rule)
        if len(featured) == 3:
            break
    keep = {k: rep.get(k) for k in ("world", "seed", "headline", "workflow", "modes", "faskes", "guardrails", "score", "limits")}
    doc = {"run": run_id, "pada": datetime.now(timezone.utc).isoformat(timespec="seconds"), "sumber": "synthetic-iomt/audit.py (audit_out/report.json)",
           "laporan": {**keep, "contoh": featured}}
    p = _file(run_id)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(p)
    return {"run": run_id, "contoh": [c["id"] for c in featured], "file": str(p)}


def _kept(run_id: str) -> Optional[dict]:
    try:
        return json.loads(_file(run_id).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _claim(c: dict) -> dict:
    """One claim as the example exhibit draws it, in Indonesian."""
    tl = c.get("timeline") or None
    if tl:
        tl = {**tl, "series": [{**s, "label": SERIES.get(s.get("metric"), s.get("label"))} for s in tl.get("series") or []]}
    return {"id": c["id"], "faskes": c.get("faskes"), "jenis": TYPE.get(c.get("type"), c.get("type")), "dx": c.get("dx"), "masuk": c.get("admitted"),
            "pulang": c.get("discharged"), "keparahan": c.get("severity"), "tarif_rp": c.get("tariffRp"), "hasil": FLAG.get(c.get("flag"), c.get("flag")),
            "estimasi_rp": c.get("estRp"), "judul": RULE.get((c.get("findings") or [{}])[0].get("rule"), c.get("headline")),
            "ukuran": [{"label": MEASURE.get(m["label"], m["label"]), "satuan": UNIT.get(m["unit"], m["unit"]), "ditagih": m["claimed"], "terukur": m["measured"]}
                       for m in c.get("measures") or []],
            "temuan": [{"hasil": FLAG.get(f.get("flag"), f.get("flag")), "judul": RULE.get(f.get("rule"), f.get("title"))} for f in c.get("findings") or []],
            "langkah": NEXT.get(c.get("flag"), c.get("next")), "garis_waktu": tl}


def part(run_id: str) -> Optional[dict]:
    """The chapter kept with this engagement: its text and exhibits (numbered by the report), or None."""
    from aip.laporan_konsultan import _exhibit, _id, pct, rp

    kept = _kept(run_id)
    if not kept:
        return None
    r = kept["laporan"]
    h, sc = r["headline"], r.get("score") or {}
    src = f"Dunia IoMT sintetis (synthetic-iomt, seed {r.get('seed')}), audit {kept['pada'][:10]}: bukan Data Sampel BPJS"
    world = f"dunia sintetis: {h['faskes']} RS fiktif, {_id(h['claims'])} klaim, {_id(h['readings'])} pembacaan perangkat"
    ex: list[dict] = []

    steps = []
    for w in r.get("workflow") or []:
        title, unit, pat, out = STEP.get(w["id"], (w["title"], w["unit"], "", ""))
        m = re.search(pat, w.get("detail") or "") if pat else None
        steps.append({"tahap": title, "nilai": w["value"], "satuan": unit, "rincian": out.format(*m.groups()) if m else ""})
    ex.append(_exhibit("iomt_alur", BAB[0], f"Dari {_id(h['readings'])} pembacaan perangkat ke {_id(h['dispute'])} klaim yang disanggah, masing-masing dengan buktinya",
                       f"Tahap audit klaim terhadap perangkat ({world})", "alur", steps, [
                           f"{_id(h['instrumented'])} dari {_id(h['claims'])} klaim ({pct(h['instrumented'], h['claims'])}) diamati setidaknya satu perangkat; sisanya di luar jangkauan IoMT dan tetap diperiksa dengan cara lain.",
                           f"{_id(h['dispute'])} klaim disanggah dan {_id(h['verify'])} perlu klarifikasi, di {h['faskesWithFindings']} dari {h['instrumentedFaskes']} faskes ber-IoMT.",
                           "Setiap pembacaan membawa hash dan setiap episode punya jangkar bukti di ledger, sehingga bukti yang diubah sesudahnya terlihat.",
                       ], src))

    modes = [m for m in r.get("modes") or [] if m.get("dispute") or m.get("verify")]
    rows = [{"label": MODE.get(m["id"], (m["name"],))[0], "disanggah": m["dispute"], "klarifikasi": m["verify"], "estimasi_rp": m["estRp"]} for m in modes]
    big = max(modes, key=lambda m: m["estRp"], default=None)
    many = max(modes, key=lambda m: m["dispute"], default=None)
    facts = []
    for m in modes:
        top = max(m.get("rules") or [], key=lambda x: x["claims"], default=None)
        counts = ", ".join(s for s in (f"{_id(m['dispute'])} disanggah" if m["dispute"] else "", f"{_id(m['verify'])} perlu klarifikasi" if m["verify"] else "") if s)
        facts.append(f"{MODE.get(m['id'], (m['name'],))[0]}: {counts}"
                     + (f", estimasi kelebihan tagihan {rp(m['estRp'])}" if m["estRp"] else "")
                     + (f"; terbanyak: {_lc(RULE.get(top['rule'], top['title']))} ({_id(top['claims'])} klaim)." if top else "."))
    if big and many:
        ex.append(_exhibit("iomt_modus", BAB[0], f"{MODE.get(big['id'], (big['name'],))[0]} membawa {rp(big['estRp'])} dari {rp(h['pricedRp'])} yang disanggah; "
                           f"{_lc(MODE.get(many['id'], (many['name'],))[0])} paling sering disanggah ({_id(many['dispute'])} klaim)",
                           "Klaim per modus Permenkes 16/2019: disanggah dan perlu klarifikasi (dunia sintetis, RS fiktif)", "hasil", rows, facts, src))

    shown = [_claim(c) for c in r.get("contoh") or []]
    if shown:
        c0 = shown[0]
        vent = next((u for u in c0["ukuran"] if u["ditagih"] > u["terukur"] * 1.15 + 1), None)
        title = (f"{vent['label']} ditagih {_id(vent['ditagih'])} {vent['satuan']}, perangkat mencatat {_id(vent['terukur'])} {vent['satuan']}: {_lc(c0['judul'])}"
                 if vent else c0["judul"])
        flat = [{"klaim": c["id"], "faskes": c["faskes"], "ukuran": u["label"], "ditagih": u["ditagih"], "terukur": u["terukur"], "satuan": u["satuan"]}
                for c in shown for u in c["ukuran"]]
        ex.append(_exhibit("iomt_contoh", BAB[0], title, "Tiga sanggahan terbesar, masing-masing jenis berbeda: tagihan terhadap catatan perangkat (dunia sintetis, RS fiktif)",
                           "iomt_klaim", flat, [
                               f"{c['id']} ({c['faskes']}, {_lc(c['jenis'])}, {c['dx']}): {_lc(c['judul'])}; estimasi kelebihan tagihan {rp(c['estimasi_rp'] or 0)}." for c in shown
                           ] + ["Garis waktu menunjukkan kapan perangkat menyala; kotak kuning adalah masa rawat seperti ditagih."], src, klaim=shown))

    fk = sorted([f for f in r.get("faskes") or [] if f.get("dispute") or f.get("verify")], key=lambda f: (-f["dispute"], -f["estRp"]))[:8]
    if fk:
        f0 = fk[0]
        none = sum(1 for f in r.get("faskes") or [] if f.get("coverage") == "none")
        ex.append(_exhibit("iomt_faskes", BAB[0], f"{f0['name']} memikul {_id(f0['dispute'])} sanggahan dari {_id(f0['instrumented'])} klaim berperangkat: sinyal tingkat faskes",
                           "Faskes fiktif dengan sanggahan terbanyak (dunia sintetis)", "hasil",
                           [{"label": f"{f['name']} · {f['province']}", "disanggah": f["dispute"], "klarifikasi": f["verify"], "estimasi_rp": f["estRp"],
                             "cakupan": COVERAGE.get(f["coverage"], f["coverage"]), "klaim_berperangkat": f["instrumented"]} for f in fk], [
                               f"{f['name']} ({COVERAGE.get(f['coverage'], f['coverage'])}): {_id(f['dispute'])} disanggah dan {_id(f['verify'])} perlu klarifikasi dari {_id(f['instrumented'])} klaim berperangkat, estimasi {rp(f['estRp'])}."
                               for f in fk[:3]] + [f"{none} faskes tanpa IoMT tidak bisa diperiksa dengan cara ini; temuan di sana tetap dari analisis klaim."], src))

    if sc:
        guard = [f"{_lc(RULE.get(g['rule'], g['title']))} ({_id(g['claims'])})" for g in r.get("guardrails") or []]
        rows = [{"uji": "Fraud yang terlihat perangkat, tertangkap", "lolos": sc["caught"], "total": sc["fraud_assessable"]},
                {"uji": "Sanggahan yang mengenai fraud", "lolos": sc["true_disputes"], "total": sc["disputed"]},
                {"uji": "Upcoding tingkat keparahan dikirim untuk ditelaah", "lolos": sc["review_flagged"], "total": sc["review_fraud"]}]
        facts = [f"Diukur terhadap kunci jawaban dunia sintetis, yang tidak pernah dibaca auditor: {_id(sc['caught'])} dari {_id(sc['fraud_assessable'])} fraud yang terlihat perangkat tertangkap ({pct(sc['caught'], sc['fraud_assessable'])}).",
                 f"Dari {_id(sc['disputed'])} sanggahan, {_id(sc['true_disputes'])} mengenai fraud, {_id(sc['partner_disputes'])} adalah pasangan jujur dari klaim yang dipecah, dan {_id(sc['false_disputes'])} keliru; klaim jujur yang disanggah: {_id(sc['honest_accused'])}.",
                 "Pagar pengaman menahan klaim sebagai klarifikasi, bukan sanggahan: " + "; ".join(guard) + "." if guard else "",
                 f"{_id(sc['out_of_scope_fraud'])} tagihan yang digelembungkan tidak terlihat perangkat mana pun: itu tetap tugas analisis klaim swarm."]
        if sc.get("upcodingEstimatedRp") and sc.get("upcodingTrueRp"):
            facts.append(f"Upcoding dihargai terhadap median rawat tingkat II yang sejenis: estimasi {rp(sc['upcodingEstimatedRp'])} terhadap kelebihan tagihan sebenarnya {rp(sc['upcodingTrueRp'])}.")
        facts += ["Dunia sintetis lebih bersih daripada data nyata: angka ini peragaan mekanisme, bukan prakiraan kinerja pada data BPJS.", *LIMITS]
        honest = "tanpa satu pun klaim jujur disanggah" if not sc["honest_accused"] else f"{_id(sc['honest_accused'])} klaim jujur disanggah"
        ex.append(_exhibit("iomt_keandalan", BAB[0], f"Di dunia sintetis, {_id(sc['caught'])} dari {_id(sc['fraud_assessable'])} fraud yang terlihat perangkat tertangkap, {honest}",
                           "Hasil audit perangkat terhadap kunci jawaban dunia sintetis", "checks", rows, [f for f in facts if f], src))

    text = (f"**Bab ini ditambahkan pada Blu 2.0 dan bukan tulisan swarm.** Swarm memeriksa data klaim. Bab ini menambahkan sumber bukti kedua: perangkat medis "
            f"yang terhubung (IoMT), yaitu ventilator, mesin hemodialisis, tempat tidur ICU dan bangsal, monitor, pompa infus, lemari implan, alat pencitraan "
            f"dan pembaca check-in, yang mencatat apa yang benar-benar berjalan dan berapa lama.\n\n"
            f"**Datanya sintetis.** {h['faskes']} rumah sakit fiktif, {_id(h['claims'])} klaim dan {_id(h['readings'])} pembacaan perangkat dibuat dari nol "
            f"(synthetic-iomt, seed {r.get('seed')}). Tidak ada faskes, peserta atau klaim Data Sampel BPJS di bab ini, dan rupiahnya tidak masuk estimasi "
            f"kerugian bab lain. Bab ini memperlihatkan cara kerjanya: apa yang dapat dibuktikan perangkat dan tidak terlihat dari data klaim saja.\n\n"
            f"Setiap klaim berperangkat berakhir pada salah satu dari dua hasil: **disanggah**, bila catatan perangkat bertentangan dengan tagihan (pembayaran item itu "
            f"ditahan sampai dijelaskan), atau **perlu klarifikasi**, bila bukti kurang, terlambat atau faskes sedang offline (bukan tuduhan). Pembacaan "
            f"yang hilang selalu dihitung menguntungkan klaim.")
    return {"bab": BAB, "setelah": AFTER, "bagian": [{"id": "iomt", "judul": BAB[1], "teks": text}], "exhibit": ex,
            "pada": kept["pada"], "seed": r.get("seed")}
