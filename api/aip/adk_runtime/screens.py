"""The dynamic screen of an AIP answer, from dashboard templates — no model call, so it is instant, free, and its
insights cannot misstate a number.

Every run is different, and so is its screen: each result the run produced is classified by its shape (a ranking, a
composition of a few groups, a trend over time, regions on the map, objects to look into), scored for this answer
(cited by the briefing, matching the question, read by a domain agent rather than the validator), and the template that
best fits what the run found is filled with the most relevant results. The entities the headline names are
highlighted; titles and insights are written from the rows themselves.
"""

from __future__ import annotations

import math
import re
from typing import Any, Optional

TEMPLATES: dict[str, dict[str, Any]] = {
    "wilayah": {"title": "Sebaran dan peringkat wilayah", "slots": ["geo", "ranking", "composition", "detail"],
                "words": ("provinsi", "wilayah", "kab", "kota", "kabupaten", "sebaran", "peta", "daerah", "regional")},
    "tren": {"title": "Perkembangan dari waktu ke waktu", "slots": ["trend", "ranking", "composition", "detail"],
             "words": ("tren", "bulan", "bulanan", "waktu", "periode", "naik", "turun", "perkembangan", "tahun")},
    "profil": {"title": "Profil dan pembanding", "slots": ["ranking", "composition", "detail", "geo"],
               "words": ("faskes", "profil", "peserta", "rumah sakit", "klinik", "terbanyak", "tertinggi", "peringkat", "dibanding")},
    "investigasi": {"title": "Rincian untuk ditelusuri", "slots": ["detail", "composition", "ranking", "detail"],
                    "words": ("klaim mana", "daftar", "rincian", "siapa", "objek", "kasus", "telusuri", "periksa")},
    "ringkas": {"title": "Data di balik jawaban", "slots": ["ranking", "composition", "trend", "detail"], "words": ()},
    # the cockpit of an answer from the audit pack (aip/paket.py): every part of the pack, the facilities to audit first
    "audit": {"title": "Kokpit audit", "slots": ["geo", "composition", "detail", "ranking", "trend", "detail"],
              "words": ("audit", "kerugian", "fraud", "indikasi", "modus", "karantina", "prioritas")},
    "ml": {"title": "Model machine learning: keandalan dan temuannya", "slots": ["ml_board", "ranking", "contrib", "detail", "explain"],
           "words": ("model", "machine learning", "ml", "akurasi", "f1", "presisi", "recall", "auc", "benchmark", "teknik", "prediksi",
                     "algoritma", "shap", "penjelasan", "andal")},
    "bukti": {"title": "Kartu bukti model", "slots": ["evidence", "ablation", "hard", "strata", "ml_board"],
              "words": ("kartu bukti", "bukti", "kapasitas", "audit", "precision@k", "lift", "rupiah", "ablasi", "negatif sulit")},
}
PANELS = {"ml": 5, "bukti": 5, "audit": 6}  # templates that may show more than MAX_PANELS
METRIC = {"count": "Jumlah", "sum": "Total", "avg": "Rata-rata", "min": "Minimum", "max": "Maksimum"}
TIME_COLS = ("bulan", "tanggal", "periode", "tahun", "minggu", "tgl_datang", "tgl_pulang", "bulan_klaim")
MAX_PANELS = 4


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    try:
        return float(str(v)) if re.fullmatch(r"-?\d+(\.\d+)?", str(v).strip()) else None
    except ValueError:
        return None


def fmt(v: float) -> str:
    """A number as an Indonesian reader writes it: 1.093 · 11,1 · 4,2 jt."""
    a = abs(v)
    if a >= 1e9:
        return f"{v / 1e9:,.1f} M".replace(",", "#").replace(".", ",").replace("#", ".")
    if a >= 1e6:
        return f"{v / 1e6:,.1f} jt".replace(",", "#").replace(".", ",").replace("#", ".")
    s = f"{v:,.0f}" if a >= 100 or float(v).is_integer() else f"{v:,.1f}"
    return s.replace(",", "#").replace(".", ",").replace("#", ".")


def pct(part: float, whole: float) -> str:
    return fmt(100 * part / whole) + "%" if whole else "—"


def _short(type_name: Optional[str]) -> str:
    return (type_name or "data").replace(" (BPJS)", "")


def _col(c: Optional[str]) -> str:
    return (c or "").replace("__nama", "").replace("_", " ")


def _label(r: dict, col: str) -> str:
    v = r.get("nama") if col == "group" and r.get("nama") else r.get(col)
    return str(v) if v not in (None, "") else "—"


def _is_time(group: str, rows: list[dict]) -> bool:
    return group in TIME_COLS or all(re.fullmatch(r"\d{4}-\d{2}(-\d{2})?", str(r.get("group") or "")) for r in rows[:12])


# ------------------------------------------------------------------------------------------------ what each result can show


def candidates(entry: dict, rows: list[dict]) -> list[dict]:
    """The visuals a result can make, each with a title and an insight computed from its rows."""
    meta = entry.get("meta") or {}
    kind, rid, typ = meta.get("kind"), entry["rid"], _short(meta.get("type") or entry.get("object_type"))
    out: list[dict] = []
    if kind == "agg" and meta.get("group") and len(rows) >= 2:
        g, metric = meta["group"], meta.get("metric") or "count"
        measure = f"{METRIC.get(metric, 'Nilai')}{' ' + _col(meta.get('prop')) if meta.get('prop') else ''} {typ.lower()}"
        label = "group"
        vals = [(_label(r, label), _num(r.get("value")) or 0.0) for r in rows]
        ranked = sorted(vals, key=lambda x: -x[1])
        total = sum(v for _, v in vals)
        if _is_time(g, rows):
            series = sorted(vals, key=lambda x: x[0])
            first, last = series[0], series[-1]
            peak = max(series, key=lambda x: x[1])
            change = f" ({'+' if last[1] >= first[1] else ''}{pct(last[1] - first[1], first[1])})" if first[1] else ""
            out.append({"kind": "trend", "widget": "line", "rid": rid, "x": "group", "value": "value", "label": None,
                        "title": f"Tren {measure.lower()} per {_col(g)}",
                        "insight": f"Dari {first[0]} ke {last[0]}: {fmt(first[1])} → {fmt(last[1])}{change}; puncak {peak[0]} ({fmt(peak[1])})."})
            return out
        top = ranked[:3]
        share = f", {pct(top[0][1], total)} dari total {fmt(total)}" if metric in ("count", "sum") and total else ""
        rest = "; disusul " + " dan ".join(f"{n} ({fmt(v)})" for n, v in top[1:]) if len(top) > 1 else ""
        rank_insight = f"{top[0][0]} tertinggi ({fmt(top[0][1])}{share}){rest}."
        if any(r.get("lokasi") for r in rows) and len(rows) >= 3:
            out.append({"kind": "geo", "widget": "map", "rid": rid, "label": label, "value": "value",
                        "title": f"Sebaran {measure.lower()} per {_col(g)}",
                        "insight": f"{len(rows)} wilayah; {top[0][0]} terbesar ({fmt(top[0][1])}{share})."})
        if len(rows) <= 6 and metric in ("count", "sum"):
            out.append({"kind": "composition", "widget": "donut", "rid": rid, "label": label, "value": "value",
                        "title": f"Komposisi {typ.lower()} menurut {_col(g)}",
                        "insight": f"{top[0][0]} {pct(top[0][1], total)}" + (f", {top[1][0]} {pct(top[1][1], total)}" if len(top) > 1 else "") + "."})
        out.append({"kind": "ranking", "widget": "bar", "rid": rid, "label": label, "value": "value",
                    "title": f"{measure} per {_col(g)}", "insight": rank_insight})
    elif kind and kind.startswith("ml_") and rows:
        out += _ml_candidates(kind, meta, rid, entry, rows)
    elif kind in ("objects", "function") and rows:
        fields = _table_fields(rows, entry.get("types") or {})
        found = meta.get("total") or len(rows)
        lead = next((str(rows[0].get(c)) for c in fields if c in ("nama_profil", "_judul", "nama", "kabkota", "deskripsi") and rows[0].get(c)), "")
        where = ", ".join(f"{f.get('property')} {f.get('op')} {f.get('value')}" for f in meta.get("filters") or [] if isinstance(f, dict))[:90]
        title = f"Rincian {typ}" + (f" · {where}" if where else "") if kind == "objects" else f"Hasil fungsi {meta.get('name')} · {meta.get('key')}"
        out.append({"kind": "detail", "widget": "table", "rid": rid, "label": None, "value": None, "fields": fields, "title": title,
                    "insight": f"{fmt(found)} objek cocok, {min(len(rows), 500)} diambil" + (f"; teratas: {lead}" if lead else "") + "."})
    return out


def _ml_candidates(kind: str, meta: dict, rid: str, entry: dict, rows: list[dict]) -> list[dict]:
    """The Machine Learning agent's results: the leaderboard, risk rankings, a claim's contributions, explainers."""
    out: list[dict] = []
    if kind == "ml_board":
        models = [r for r in rows if not r.get("pembanding")]
        refs = [r for r in rows if r.get("pembanding")]
        best = max(models, key=lambda r: _num(r.get("auprc")) or 0, default=None)
        if best:
            ci = best.get("auprc_ci95")
            ref = max(refs, key=lambda r: _num(r.get("auprc")) or 0, default=None)
            lift = _num(best.get("lift_top_0_1pct"))
            tied = [r["model"] for r in models if r is not best and r.get("setara_dengan_terbaik")]
            insight = (f"{best['model']} teratas: AUPRC {fmt3(best.get('auprc'))}" + (f" (95%: {fmt3(ci[0])}–{fmt3(ci[1])})" if ci else "")
                       + f", F1 {fmt3(best.get('f1'))}, presisi {fmt3(best.get('presisi'))}, recall {fmt3(best.get('recall'))}"
                       + (f"; lift {fmt(lift)}× di 0,1% teratas" if lift else "")
                       + (f". Pembanding terbaik {ref['model']}: AUPRC {fmt3(ref.get('auprc'))}." if ref else ".")
                       + (f" Setara secara statistik (p ≥ 0,05): {', '.join(tied)}." if tied else ""))
            out.append({"kind": "ml_board", "widget": "leaderboard", "rid": rid, "label": "model", "value": "auprc", "x": None,
                        "fields": ["auprc_ci95", "pembanding", "auroc", "f1", "presisi", "recall", "akurasi", "lift_top_0_1pct", "detik_latih"],
                        "title": entry.get("title") or "Benchmark teknik ML", "insight": insight, "highlight": [best["model"]]})
    elif kind == "ml_shap":
        up = [r for r in rows if (_num(r.get("kontribusi")) or 0) > 0][:3]
        out.append({"kind": "contrib", "widget": "contrib", "rid": rid, "label": "label", "value": "kontribusi", "x": None, "fields": ["nilai"],
                    "title": entry.get("title") or "Pendorong risiko",
                    "insight": "Menaikkan risiko: " + "; ".join(f"{r['label']} = {r.get('nilai')}" for r in up) + "." if up else "Tidak ada fitur yang menaikkan risiko."})
    elif kind == "ml_explainers":
        best = min(rows, key=lambda r: _num(r.get("deletion_auc")) or 9)
        rnd = next((r for r in rows if r.get("metode") == "acak"), None)
        out.append({"kind": "explain", "widget": "bar", "rid": rid, "label": "metode", "value": "deletion_auc", "x": None,
                    "title": "Kesetiaan metode penjelasan (deletion AUC, makin kecil makin setia)",
                    "insight": f"{best['metode']} paling setia ({fmt3(best.get('deletion_auc'))})" + (f"; urutan acak {fmt3(rnd.get('deletion_auc'))}." if rnd else "."),
                    "highlight": [best["metode"]]})
    elif kind == "ml_evidence_head":
        get = {r.get("ukuran"): r for r in rows}
        p, lift = get.get("precision@k") or {}, get.get("lift vs acak") or {}
        caught, rnd = get.get("klaim terkoreksi di daftar audit") or {}, get.get("harapan bila acak") or {}
        out.append({"kind": "evidence", "widget": "table", "rid": rid, "label": None, "value": None, "fields": ["ukuran", "nilai", "ik95"],
                    "title": entry.get("title") or "Kartu bukti model",
                    "insight": f"{fmt(_num(caught.get('nilai')) or 0)} klaim terkoreksi di daftar audit (IK 95% {caught.get('ik95')}), acak hanya "
                               f"{fmt(_num(rnd.get('nilai')) or 0)}: precision@k {fmt3(p.get('nilai'))}, lift {fmt(_num(lift.get('nilai')) or 0)}×."})
    elif kind == "ml_evidence_ablation":
        last = rows[-1]
        out.append({"kind": "ablation", "widget": "bar", "rid": rid, "label": "varian", "value": "precision_at_k", "x": None,
                    "title": entry.get("title") or "Ablasi vs aturan",
                    "insight": f"{last['varian']}: precision@k {fmt3(last.get('precision_at_k'))}"
                               + (f", perubahan {fmt3(last.get('perubahan'))} dari varian sebelumnya (p = {fmt3(last.get('p'))})." if last.get("p") is not None else "."),
                    "highlight": [last["varian"]]})
    elif kind == "ml_evidence_hard":
        worst = max(rows, key=lambda r: _num(r.get("rasio_vs_rata")) or 0)
        out.append({"kind": "hard", "widget": "bar", "rid": rid, "label": "kelompok", "value": "porsi_jujur_ditandai", "x": None,
                    "title": entry.get("title") or "Negatif sulit",
                    "insight": f"{worst['kelompok']} paling sering ikut ditandai: {fmt3(worst.get('rasio_vs_rata'))}× rata-rata ({worst.get('jujur_ditandai')} klaim jujur)."})
    elif kind == "ml_evidence_strata":
        top = rows[0]
        out.append({"kind": "strata", "widget": "bar", "rid": rid, "label": "kelas", "value": "porsi_diaudit", "x": None,
                    "title": entry.get("title") or "Faskes jujur yang ikut diaudit per kelas",
                    "insight": f"Beban audit terbesar pada {top['kelas']}: {top.get('diaudit')} dari {top.get('faskes_jujur')} faskes jujur ikut diaudit."})
    elif kind in ("ml_explain_compare",):
        out.append({"kind": "explain", "widget": "table", "rid": rid, "label": None, "value": None, "fields": list(rows[0])[:4],
                    "title": entry.get("title") or "Penjelasan per metode", "insight": f"{len(rows)} metode menjelaskan klaim yang sama."})
    elif kind == "ml_importance":
        out.append({"kind": "ranking", "widget": "bar", "rid": rid, "label": "fitur", "value": "penurunan_auprc", "x": None,
                    "title": entry.get("title") or "Fitur terpenting", "insight": f"{rows[0]['fitur']} paling menentukan: AUPRC turun {fmt3(rows[0].get('penurunan_auprc'))} bila diacak."})
    elif kind == "ml_faskes":
        metric = meta.get("metric") or "ekspektasi_koreksi"
        top = rows[0]
        out.append({"kind": "ranking", "widget": "bar", "rid": rid, "label": "nama_profil", "value": metric, "x": None,
                    "title": f"Faskes menurut model ML · {_col(metric)}",
                    "insight": f"{top.get('nama_profil')} tertinggi ({fmt(_num(top.get(metric)) or 0)}); koreksi aktual {fmt(_num(top.get('koreksi_aktual')) or 0)}, "
                               f"berisiko tinggi lolos verifikasi {fmt(_num(top.get('berisiko_lolos_verifikasi')) or 0)}."})
        out.append({"kind": "detail", "widget": "table", "rid": rid, "label": None, "value": None,
                    "fields": ["nama_profil", "provinsi", "klaim", "ekspektasi_koreksi", "koreksi_aktual", "klaim_ditandai", "berisiko_lolos_verifikasi"],
                    "title": "Rincian faskes (model ML)", "insight": f"{len(rows)} profil faskes."})
    elif kind == "ml_klaim":
        n_pass = sum(1 for r in rows if r.get("lolos_verifikasi_berisiko"))
        out.append({"kind": "detail", "widget": "table", "rid": rid, "label": None, "value": None,
                    "fields": ["klaim_id", "nama_profil", "risiko_pct", "tingkat_risiko", "sudah_dikoreksi", "inacbg_kode", "alasan_utama"],
                    "title": entry.get("title") or "Klaim berisiko (model ML)",
                    "insight": f"{len(rows)} klaim teratas; risiko tertinggi {fmt3(rows[0].get('risiko_pct'))}%" + (f"; {n_pass} lolos verifikasi." if n_pass else ".")})
        out.append({"kind": "ranking", "widget": "bar", "rid": rid, "label": "klaim_id", "value": "risiko_pct", "x": None,
                    "title": "Peluang koreksi verifikasi per klaim (%)", "insight": f"Klaim {rows[0].get('klaim_id')} paling berisiko ({fmt3(rows[0].get('risiko_pct'))}%)."})
    return out


def fmt3(v: Any) -> str:
    """A metric between 0 and 1 (or a small percentage) with three significant decimals, Indonesian style."""
    x = _num(v)
    if x is None:
        return "—"
    return (f"{x:.3f}" if abs(x) < 10 else f"{x:.1f}").replace(".", ",")


def _table_fields(rows: list[dict], types: dict[str, str]) -> list[str]:
    """Up to 7 columns an auditor reads first: names, then the measures that matter, then the categories."""
    cols = list(dict.fromkeys(c for r in rows[:20] for c in r))
    if len(rows) > 1:  # a column with one value in every row (provinsi, in a province's drill-down) says nothing per row
        cols = [c for c in cols if len({str(r.get(c)) for r in rows[:50]}) > 1]
    if "nama" in cols and "nama_profil" in cols:
        cols.remove("nama_profil")
    names = [c for c in cols if c in ("nama_profil", "nama", "deskripsi", "kabkota", "provinsi") or c.endswith("__nama")]
    # what kind of indication a row carries, however long the text (the Karantina box's jenis_indikasi)
    names += [c for c in cols if c not in names and re.search(r"jenis_indikasi|tag_label|^modus$", c)]
    key = re.compile(r"kerugian|koreksi|skor|biaya|tarif|los|readmisi|selisih|klaim|jumlah|total|rasio|pct|nilai|count|value")
    measures = [c for c in cols if c not in names and key.search(c) and any(_num(r.get(c)) is not None for r in rows[:20])]
    cats = [c for c in cols if c not in names and c not in measures and not c.startswith("_") and not re.search(r"(^|_)(id|key|kode)$", c)
            and types.get(c) in ("string", None) and all(len(str(r.get(c) or "")) < 40 for r in rows[:20])]
    ident = ["_judul"] if not names and "_judul" in cols else []
    return (ident + names + measures + cats)[:7] or cols[:7]


# ------------------------------------------------------------------------------------------------ the screen


def _about(meta: dict, focus: list[str]) -> bool:
    """Whether a result was read inside the follow-up's focus: one of its filters names it (provinsi eq SULAWESI SELATAN)."""
    vals = [str(v).upper() for f in meta.get("filters") or [] if isinstance(f, dict)
            for v in (f.get("value") if isinstance(f.get("value"), list) else [f.get("value")])]
    return any(x.upper() in v or v in x.upper() for x in focus for v in vals if v and len(v) > 2)


def compose(question: str, answer: str, cited: set[str], index: list[dict], rows: dict[str, list[dict]], focus: Optional[list[str]] = None,
            prefer: Optional[str] = None) -> dict:
    """The screen for this answer: the template that fits what the run found, filled with its most relevant results. A
    follow-up with a focus (the province or faskes the conversation is about) leads with what was read inside it; a
    ranking of every province again sinks (user, 2026-10-23: drill down, do not benchmark the other provinces again).
    prefer: the template the route asks for (the audit pack's cockpit), when it fills at least three panels."""
    q = (question or "").lower()
    said = (answer or "").lower()
    cands: list[dict] = []
    for entry in index:
        rs = rows.get(entry["rid"]) or []
        for c in candidates(entry, rs):
            meta = entry.get("meta") or {}
            c["type"] = meta.get("type") or entry.get("object_type")
            # a table's columns count too ("kerugian" in the question, estimasi_kerugian_rp in the faskes list)
            words = {w for w in re.findall(r"[a-z]{4,}", f"{c['title']} {meta.get('group') or ''} {meta.get('type') or ''} {' '.join(c.get('fields') or [])}".lower())}
            c["score"] = (4 if entry["rid"] in cited else 0) + sum(1 for w in words if w in q) + min(2.0, math.log10(1 + len(rs))) \
                - (3 if meta.get("agent") == "validator" else 0)
            if c["widget"] == "table" and meta.get("total") and len(rs) >= meta["total"]:
                c["score"] += 1.5  # the whole list (17 of 17 faskes) over a sample of a larger set (500 of 1.397 tags)
            if focus:
                inside = _about(meta, focus)
                # a ranking across every province or faskes again, outside the focus: not shown at all
                c["off"] = not inside and meta.get("kind") == "agg" and bool(meta.get("group")) and len(rs) > 3
                c["score"] += 5 if inside else 0
            # the entities the answer names stand out on the ranking and the map
            if c["widget"] in ("bar", "map"):
                labels = {_label(r, "group") for r in rs[:60]}
                c["highlight"] = sorted(l for l in labels if len(l) > 3 and l.lower() in said)[:5]
            cands.append(c)
    if not cands:
        return {"title": "", "template": None, "panels": []}
    if all(c.get("off") for c in cands):  # nothing was read inside the focus: the rankings rather than an empty screen
        for c in cands:
            c["off"] = False

    def fill(name: str) -> list[dict]:
        used: set[tuple[str, str]] = set()
        panels: list[dict] = []
        for slot in TEMPLATES[name]["slots"]:
            best = max((c for c in cands if c["kind"] == slot and not c.get("off") and (c["rid"], c["widget"]) not in used
                        # a second table shows another object type (the tags beside the faskes), not the same list again
                        and not (slot == "detail" and any(p["kind"] == "detail" and p.get("type") == c.get("type") for p in panels))
                        and not any(p["rid"] == c["rid"] and p["kind"] == c["kind"] for p in panels)), key=lambda c: c["score"], default=None)
            if best:
                used.add((best["rid"], best["widget"]))
                panels.append(best)
            if len(panels) >= PANELS.get(name, MAX_PANELS):
                break
        return panels

    def fit(name: str) -> float:
        panels = fill(name)
        words = sum(2 for w in TEMPLATES[name]["words"] if w in q)
        lead = 3 if panels and panels[0]["kind"] == TEMPLATES[name]["slots"][0] else 0  # the template's main visual exists
        return sum(p["score"] for p in panels) + words + lead - (0.5 if name == "ringkas" else 0)  # a fitting template beats the generic one

    name = prefer if prefer in TEMPLATES and len(fill(prefer)) >= 3 else max(TEMPLATES, key=fit)
    panels = fill(name)
    return {"title": TEMPLATES[name]["title"], "template": name,
            "panels": [{k: p.get(k) for k in ("widget", "title", "insight", "rid", "label", "value", "x")} |
                       {"series": None, "highlight": p.get("highlight") or p.get("_highlight") or [], "fields": p.get("fields") or []} for p in panels]}
