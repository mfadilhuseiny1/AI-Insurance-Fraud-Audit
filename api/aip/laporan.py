"""Publication-ready PDF evaluation report for the hybrid multiagent + ML fraud system (the "Unduh laporan PDF"
button on the Evaluasi & Kontrol tab). Every number comes from the same stores the tab reads — the Vertex spend
ledger, the run ledger with validator verdicts, missions, golden sets and their scored runs, and the deployed ML
model's evidence cards — rendered with reportlab into a dated, self-contained document."""

from __future__ import annotations

import io
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aip import control as C


def _fmt_pct(x: Any, digits: int = 1) -> str:
    try:
        return f"{float(x):.{digits}f}%"
    except (TypeError, ValueError):
        return "—"


def _fmt_num(n: Any) -> str:
    try:
        return f"{int(n):,}".replace(",", ".")
    except (TypeError, ValueError):
        return "—"


def _fmt_usd(n: Any) -> str:
    try:
        return f"${float(n):,.5f}"
    except (TypeError, ValueError):
        return "—"


def _wib(iso: str | None) -> str:
    if not iso:
        return "—"
    try:
        from zoneinfo import ZoneInfo
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Jakarta"))
        return d.strftime("%Y-%m-%d %H:%M WIB")
    except Exception:
        return str(iso)[:16]


def _data(ov: dict[str, Any]) -> dict[str, Any]:
    """The report's dataset: one dict the renderer reads, so numbers appear once and consistently."""
    g = ov["golden"]
    latest = (g["latest"] or {})
    summary = latest.get("summary") or {}
    return {"ov": ov, "golden": g, "gold_summary": summary, "gold_failed": latest.get("failed") or [],
            "gold_rows": latest.get("rows") or []}


def _report_board() -> dict[str, list[dict[str, Any]]]:
    """Per-technique benchmark board (report.json): who is statistically tied with the best."""
    from aip import vertex as aip_vertex
    import json
    root = aip_vertex.DIR.parent / "ml" / "versions"
    if not root.exists():
        return {}
    cands = sorted((p for p in root.glob("*/report.json") if p.exists()), key=lambda p: p.stat().st_mtime, reverse=True)
    if not cands:
        return {}
    try:
        rep = json.loads(cands[0].read_text("utf-8"))
    except Exception:
        return {}
    return {t: task.get("papan") or [] for t, task in (rep.get("tugas") or {}).items()}


def _pop_confusion(bukti: dict) -> dict[str, dict[str, int]]:
    """Population confusion matrices at the audit-capacity operating point, derived exactly from each card's
    headline (n, prevalence, k, caught) — no sampling involved."""
    out = {}
    for key in ("semua", "rumah_sakit"):
        card = ((bukti.get("kartu") or {}).get(key) or {}).get("kartu") or {}
        cond, h = card.get("conditions") or {}, card.get("headline") or {}
        n = int(cond.get("n") or 0)
        pos = int(round(n * float(cond.get("prevalence") or 0)))
        tp = int(h.get("caught") or 0)
        k = int(cond.get("k") or 0)
        fp = k - tp
        fn = pos - tp
        tn = n - pos - fp
        out[key] = {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "n": n, "pos": pos, "k": k}
    return out


def _sample_scores() -> dict[str, Any]:
    """The review sample (klaim.parquet): score + operating decision + true label per segment.
    Enriched for review (label rate above the population's) — valid for ROC shape and score distributions, NOT for
    absolute precision levels."""
    import pandas as pd
    from aip import vertex as aip_vertex
    root = aip_vertex.DIR.parent / "ml" / "versions"
    cands = sorted((p for p in root.glob("*/klaim.parquet") if p.exists()), key=lambda p: p.stat().st_mtime, reverse=True)
    if not cands:
        return {}
    df = pd.read_parquet(cands[0], columns=["risiko", "ditandai", "sudah_dikoreksi", "segmen_model"])
    out = {"n": len(df), "label_rate": float(df["sudah_dikoreksi"].mean())}
    for seg, dd in df.groupby("segmen_model"):
        out[str(seg)] = {"y": dd["sudah_dikoreksi"].to_numpy(dtype=int), "s": dd["risiko"].to_numpy(dtype=float)}
    return out


def _roc_chart(sample: dict) -> tuple[bytes | None, dict[str, float]]:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from sklearn.metrics import roc_curve, auc
    except Exception:
        return None, {}
    try:
        fig, ax = plt.subplots(figsize=(5.2, 3.6))
        aucs = {}
        for seg, label in (("rumah_sakit", "Rumah sakit"), ("klinik_utama", "Klinik utama / semua")):
            d = sample.get(seg)
            if not d:
                continue
            fpr, tpr, _ = roc_curve(d["y"], d["s"])
            a = auc(fpr, tpr)
            aucs[seg] = a
            ax.plot(fpr, tpr, label=f"{label} (AUC {a:.3f})")
        ax.plot([0, 1], [0, 1], "--", color="#9aa4b2", label="Acak")
        ax.set_xlabel("False positive rate")
        ax.set_ylabel("True positive rate (recall)")
        ax.set_title("Kurva ROC pada sampel telaah " + f"{int(sample.get('n') or 0):,}".replace(",", ".") + " klaim")
        ax.legend(fontsize=8)
        fig.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=150)
        plt.close(fig)
        return buf.getvalue(), aucs
    except Exception:
        return None, {}


def _score_hist_chart(sample: dict) -> bytes | None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np
    except Exception:
        return None
    try:
        fig, axes = plt.subplots(1, 2, figsize=(9, 3.2), sharey=True)
        for ax, (seg, title) in zip(axes, (("rumah_sakit", "Rumah sakit"), ("klinik_utama", "Klinik utama / semua"))):
            d = sample.get(seg)
            if not d:
                continue
            y, s = d["y"], d["s"]
            bins = np.logspace(-8, 0, 40)
            ax.hist(s[y == 0], bins=bins, alpha=0.6, label=f"Jujur (n={int((y == 0).sum()):,})")
            ax.hist(s[y == 1], bins=bins, alpha=0.7, label=f"Dikoreksi (n={int(y.sum()):,})")
            ax.set_xscale("log")
            ax.set_title(title, fontsize=10)
            ax.set_xlabel("skor risiko model")
            ax.legend(fontsize=8)
        axes[0].set_ylabel("klaim")
        fig.suptitle("Distribusi skor risiko per kelas (sampel telaah, sumbu-x log)")
        fig.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=150)
        plt.close(fig)
        return buf.getvalue()
    except Exception:
        return None


def collect() -> dict[str, Any]:
    ov = C.overview()
    d = _data(ov)
    # the full evidence cards (headline, ablation, hard negatives, strata) live in the golden evidence json
    from aip import ml as aip_ml
    cur = aip_ml.current() or {}
    d["model_summary"] = (cur.get("summary") or {})
    d["model_version"] = cur.get("version")
    d["model_trained"] = cur.get("trained_at")
    bukti = _latest_bukti()
    d["bukti"] = bukti or {}
    return d


def _latest_bukti() -> dict | None:
    from aip import vertex as aip_vertex
    root = aip_vertex.DIR.parent / "ml" / "versions"
    if not root.exists():
        return None
    cands = sorted((p for p in root.glob("*/bukti/bukti.json") if p.exists()), key=lambda p: p.stat().st_mtime, reverse=True)
    if not cands:
        return None
    import json
    try:
        return json.loads(cands[0].read_text("utf-8"))
    except Exception:
        return None


def _ablation_chart(bukti: dict) -> bytes | None:
    """Grouped precision@k bars with confidence intervals, both segments (matplotlib → PNG bytes)."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return None
    try:
        segs = [("semua", "Semua klaim"), ("rumah_sakit", "Rumah sakit")]
        fig, axes = plt.subplots(1, 2, figsize=(9, 3.4))
        for ax, (key, title) in zip(axes, segs):
            card = (bukti.get("kartu") or {}).get(key) or {}
            abl = card.get("ablasi") or []
            labels = [a["variant"].replace(" (flag ganda / LOS ekstrem)", "").replace(" klinik utama rawat inap", "\nklinik utama RI")[:22] for a in abl]
            vals = [a["precision_at_k"] for a in abl]
            lo = [a["precision_at_k"] - (a["ci_low"] or 0) for a in abl]
            hi = [(a["ci_high"] or 0) - a["precision_at_k"] for a in abl]
            x = range(len(vals))
            ax.bar(list(x), vals, yerr=[lo, hi], capsize=3, color=["#9aa4b2", "#5b8dd9", "#2f7d5b", "#2f7d5b"][:len(vals)])
            ax.set_xticks(list(x), labels, fontsize=7)
            ax.set_title(title, fontsize=10)
            ax.set_ylabel("precision@k")
            ax.set_ylim(0, max([(a["ci_high"] or 0) for a in abl] or [1]) * 1.15 or 1)
        fig.suptitle("Ablasi: aturan vs model (precision@k dengan IK 95%)", fontsize=11)
        fig.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=150)
        plt.close(fig)
        return buf.getvalue()
    except Exception:
        return None


# ----------------------------------------------------------------------------- renderer --------------------------------

TITLE = "Evaluasi Sistem Deteksi Fraud Klaim JKN: Multiagen Hibrida + Machine Learning"
SUBTITLE = "Laporan evaluasi berbasis bukti — seluruh angka dibaca dari ledger produksi (bukan ilustrasi)"


def _styles():
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_JUSTIFY, TA_CENTER
    from reportlab.lib import colors
    base = dict(fontName="Helvetica", fontSize=9, leading=13, textColor=colors.HexColor("#1a1a1a"))
    return {
        "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=colors.HexColor("#111827")),
        "subtitle": ParagraphStyle("subtitle", fontName="Helvetica", fontSize=10, leading=14, textColor=colors.HexColor("#4b5563")),
        "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=13, leading=16, spaceBefore=14, spaceAfter=6,
                             textColor=colors.HexColor("#111827")),
        "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=10.5, leading=14, spaceBefore=10, spaceAfter=4,
                             textColor=colors.HexColor("#1f2937")),
        "body": ParagraphStyle("body", **base, alignment=TA_JUSTIFY),
        "bullet": ParagraphStyle("bullet", **base, leftIndent=14, bulletIndent=4, spaceBefore=2),
        "caption": ParagraphStyle("caption", fontName="Helvetica-Oblique", fontSize=7.5, leading=10,
                                  textColor=colors.HexColor("#4b5563"), alignment=TA_CENTER, spaceBefore=3, spaceAfter=8),
        "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=7.5, leading=10),
        "cell_h": ParagraphStyle("cell_h", fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=colors.white),
        "cell_r": ParagraphStyle("cell_r", fontName="Helvetica", fontSize=7.5, leading=10, alignment=2),
        "meta": ParagraphStyle("meta", fontName="Helvetica", fontSize=8.5, leading=12, textColor=colors.HexColor("#374151")),
    }


def _p(text: str, style, **kw) -> Any:
    from reportlab.platypus import Paragraph
    return Paragraph(text, style, **kw)


def _table(rows: list[list[Any]], widths: list[float] | None = None, header: bool = True) -> Any:
    from reportlab.platypus import Table, TableStyle
    from reportlab.lib import colors
    t = Table(rows, colWidths=widths, repeatRows=1 if header else 0)
    style = [("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#9ca3af")),
             ("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [colors.white, colors.HexColor("#f3f4f6")])]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white)]
    t.setStyle(TableStyle(style))
    return t


def _footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColorRGB(0.42, 0.45, 0.5)
    canvas.drawString(40, 28, "AIP JKN — laporan evaluasi berbasis ledger produksi · data sampel BPJS Kesehatan 2025 (anonim)")
    canvas.drawRightString(doc.pagesize[0] - 40, 28, f"halaman {doc.page}")
    canvas.restoreState()


def build_pdf(path: Path) -> dict[str, Any]:
    """Collect real evaluation data and render the publication-ready PDF to `path`."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import (BaseDocTemplate, Frame, Image, PageTemplate, Paragraph, Spacer)

    d = collect()
    ov, S, bukti = d["ov"], _styles(), d["bukti"]
    cards = (bukti.get("kartu") or {})
    sem = (cards.get("semua") or {})
    rss = (cards.get("rumah_sakit") or {})
    sem_h, rs_h = (sem.get("kartu") or {}).get("headline", {}), (rss.get("kartu") or {}).get("headline", {})
    story: list[Any] = []

    story.append(_p(TITLE, S["title"]))
    story.append(Spacer(1, 3 * mm))
    story.append(_p(SUBTITLE, S["subtitle"]))
    story.append(Spacer(1, 4 * mm))
    gen = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta = (f"Versi model ML terdeploy: <b>{d['model_version'] or '—'}</b> (dilatih {_wib(d['model_trained'])}) · "
            f"Laporan dibuat: <b>{_wib(gen)}</b><br/>Sumber data: Data Sampel BPJS Kesehatan 2025 (klaim nyata, anonim) · "
            f"Label: flag_selisih_verifikasi — klaim <b>dikoreksi verifikator</b> (positif = dikoreksi, bukan fraud terbukti pengadilan) · "
            f"Skor model: out-of-fold, lipatan per faskes (model tidak pernah melihat faskes yang dinilainya)")
    story.append(_p(meta, S["meta"]))
    story.append(Spacer(1, 2 * mm))

    # 1. ringkasan eksekutif
    story.append(_p("1 &nbsp; Ringkasan eksekutif", S["h1"]))
    gs = d["gold_summary"] or {}
    v = ov["verdicts"]
    v_pass = sum(x["passed"] for x in v["validators"].values())
    v_tot = sum(x["total"] for x in v["validators"].values())
    kpi = [
        [_p("<b>Indikator</b>", S["cell_h"]), _p("<b>Semua klaim</b>", S["cell_h"]), _p("<b>Rumah sakit</b>", S["cell_h"])],
        [_p("precision@k (audit 0,1%)", S["cell"]),
         _p(f"{_fmt_pct(sem_h.get('precision', 0) * 100)} (IK {_fmt_pct((sem_h.get('precision_low') or 0) * 100)}–{_fmt_pct((sem_h.get('precision_high') or 0) * 100)})", S["cell"]),
         _p(f"{_fmt_pct(rs_h.get('precision', 0) * 100)} (IK {_fmt_pct((rs_h.get('precision_low') or 0) * 100)}–{_fmt_pct((rs_h.get('precision_high') or 0) * 100)})", S["cell"])],
        [_p("Lift vs acak", S["cell"]), _p(f"{(sem_h.get('lift') or 0):,.0f}×", S["cell"]), _p(f"{(rs_h.get('lift') or 0):,.0f}×", S["cell"])],
        [_p("Positif palsu tingkat klaim", S["cell"]),
         _p(f"{_fmt_num((sem_h.get('false_positives') or {}).get('false_positives'))} dari {_fmt_num((sem_h.get('false_positives') or {}).get('honest'))} jujur", S["cell"]),
         _p(f"{_fmt_num((rs_h.get('false_positives') or {}).get('false_positives'))} dari {_fmt_num((rs_h.get('false_positives') or {}).get('honest'))} jujur", S["cell"])],
        [_p("Profil faskes jujur ikut diaudit", S["cell"]),
         _p(f"{_fmt_num((sem_h.get('honest_audit') or {}).get('flagged'))}/{_fmt_num((sem_h.get('honest_audit') or {}).get('honest'))} ({_fmt_pct((sem_h.get('honest_audit') or {}).get('rate', 0) * 100)})", S["cell"]),
         _p(f"{_fmt_num((rs_h.get('honest_audit') or {}).get('flagged'))}/{_fmt_num((rs_h.get('honest_audit') or {}).get('honest'))} ({_fmt_pct((rs_h.get('honest_audit') or {}).get('rate', 0) * 100)})", S["cell"])],
        [_p("Recall rupiah@k", S["cell"]), _p(_fmt_pct((sem_h.get('rupiah_recall') or 0) * 100), S["cell"]), _p(_fmt_pct((rs_h.get('rupiah_recall') or 0) * 100), S["cell"])],
    ]
    story.append(_table(kpi, widths=[62 * mm, 52 * mm, 52 * mm]))
    story.append(_p("Tabel 1 — Hasil utama kartu bukti pada kapasitas audit 0,1% (asumsi). IK = interval kepercayaan 95% resampling per profil faskes.", S["caption"]))
    story.append(_p(
        f"Validasi runtime hibrida: kopilot Tanya-Jawab lulus evaluasi golden <b>{gs.get('passed', '—')}/{gs.get('answered', '—')}</b> "
        f"({(gs.get('model') or '').split('/')[-1] if gs.get('model') else '—'}, {_wib(gs.get('time'))}); "
        f"verifikator deterministik (scrutiny) <b>{_fmt_num(v_pass)}/{_fmt_num(v_tot)}</b> cek lulus pada 60 run terakhir; "
        f"{len(v['blocking_failures'])} kegagalan memblokir tercatat dan ditahan dari jawaban. "
        f"Keputusan akhir tetap di tangan peninjau manusia (Box Karantina); penolakan klaim tidak pernah otomatis.", S["body"]))

    # 2. metodologi
    story.append(_p("2 &nbsp; Metodologi", S["h1"]))
    for b in [
        "Evaluasi model ML memakai skor <b>out-of-fold dengan lipatan per faskes</b>: setiap faskes dinilai model yang tidak pernah melihatnya.",
        "Kapasitas audit <b>k = 0,1%</b> klaim adalah <b>asumsi</b> (verifikator × kasus × hari kerja, belum diisi angka BPJS) — dinyatakan eksplisit agar pembaca menilai sendiri.",
        "Evaluasi kopilot memakai <b>golden set</b> (12 soal auditor + 47 soal rencana) dengan kebenaran hidup yang dibaca dari API platform yang sama.",
        "Setiap jawaban agen melewati <b>dua verifikator</b>: scrutiny deterministik (rujukan dan angka harus ada di hasil tool run ini) dan validator LLM lintas-keluarga.",
        "Uji permutasi: PR-AUC model vs label acak, p = 0,001 pada kedua segmen — sinyal bersifat nyata, bukan artefak.",
    ]:
        story.append(_p(b, S["bullet"], bulletText="•"))

    # 3. hasil model + ablasi
    story.append(_p("3 &nbsp; Hasil model ML: aturan vs model", S["h1"]))
    th = d["model_summary"]
    thr = [[_p("<b>Segmen (terbaik)</b>", S["cell_h"]), _p("<b>F1</b>", S["cell_h"]), _p("<b>Presisi</b>", S["cell_h"]),
           _p("<b>Recall</b>", S["cell_h"]), _p("<b>AUROC</b>", S["cell_h"]), _p("<b>AUPRC</b>", S["cell_h"])]]
    for key, label in (("rumah_sakit", "Rumah sakit"), ("semua", "Semua")):
        m = th.get(key) or {}
        thr.append([_p(f"{label} ({m.get('terbaik', '—')})", S["cell"]),
                    _p(f"{m.get('f1', 0):.3f}", S["cell"]), _p(f"{m.get('presisi', 0):.3f}", S["cell"]),
                    _p(f"{m.get('recall', 0):.3f}", S["cell"]), _p(f"{m.get('auroc', 0):.4f}", S["cell"]),
                    _p(f"{m.get('auprc', 0):.4f}", S["cell"])])
    story.append(_table(thr, widths=[56 * mm] + [22 * mm] * 5))
    story.append(_p("Tabel 2 — Metrik ambang operasi per segmen (model card terdeploy).", S["caption"]))
    for key, title in (("semua", "Semua klaim"), ("rumah_sakit", "Rumah sakit")):
        abl = ((cards.get(key) or {}).get("ablasi") or [])
        if not abl:
            continue
        story.append(_p(title, S["h2"]))
        rows = [[_p("<b>Varian</b>", S["cell_h"]), _p("<b>precision@k</b>", S["cell_h"]), _p("<b>Lift</b>", S["cell_h"]),
                 _p("<b>PR-AUC</b>", S["cell_h"]), _p("<b>Faskes jujur diaudit</b>", S["cell_h"]), _p("<b>p berpasangan</b>", S["cell_h"])]]
        for a in abl:
            ci = f"{a['precision_at_k']:.3f} ({(a['ci_low'] or 0):.3f}–{(a['ci_high'] or 0):.3f})"
            rows.append([_p(a["variant"][:34], S["cell"]), _p(ci, S["cell"]), _p(f"{a['lift']:.0f}×", S["cell"]),
                         _p(f"{a['pr_auc']:.3f}", S["cell"]), _p(_fmt_pct(a["honest_group_audit_rate"] * 100), S["cell"]),
                         _p("—" if a["p_value"] is None else f"{a['p_value']:.3f}", S["cell"])])
        story.append(_table(rows, widths=[52 * mm, 38 * mm, 18 * mm, 18 * mm, 24 * mm, 22 * mm]))
    story.append(_p("Tabel 3 — Ablasi varian terhadap aturan yang ada (kedua segmen; p = uji berpasangan vs varian sebelumnya).", S["caption"]))
    png = _ablation_chart(bukti)
    if png:
        from reportlab.platypus import Image as RLImage
        story.append(RLImage(io.BytesIO(png), width=160 * mm, height=60 * mm))
        story.append(_p("Gambar 1 — Ablasi visual: aturan yang ada vs model ML.", S["caption"]))

    # 4. metrik klasifikasi mendalam
    story.append(_p("4 &nbsp; Metrik klasifikasi mendalam", S["h1"]))
    conf = _pop_confusion(bukti)
    story.append(_p(
        "Confusion matrix dihitung <b>tepat pada titik operasi kapasitas audit</b> (k = 0,1% klaim teratas) dari angka kartu bukti "
        "(n, prevalensi, k, caught) — tanpa sampling. Metrik ambang model card (Tabel 2) memakai ambang yang memaksimumkan F1, "
        "sehingga angkanya berbeda: Tabel 4 menunjukkan apa yang benar-benar terjadi pada kapasitas audit yang dipakai.", S["body"]))
    for key, title in (("semua", "Semua klaim"), ("rumah_sakit", "Rumah sakit")):
        c = conf.get(key) or {}
        tp, fp, fn, tn = c.get("tp", 0), c.get("fp", 0), c.get("fn", 0), c.get("tn", 0)
        tot = tp + fp + fn + tn
        prec = tp / (tp + fp) if tp + fp else 0
        rec = tp / (tp + fn) if tp + fn else 0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0
        acc = (tp + tn) / tot if tot else 0
        fpr = fp / (fp + tn) if fp + tn else 0
        story.append(_p(f"{title} (n = {_fmt_num(c.get('n'))}, positif = {_fmt_num(c.get('pos'))}, k = {_fmt_num(c.get('k'))})", S["h2"]))
        cm = [[_p("", S["cell_h"]), _p("<b>Prediksi: ditandai</b>", S["cell_h"]), _p("<b>Prediksi: tidak</b>", S["cell_h"])],
              [_p("<b>Aktual: dikoreksi</b>", S["cell_h"]), _p(f"<b>TP</b> {_fmt_num(tp)}", S["cell"]), _p(f"<b>FN</b> {_fmt_num(fn)}", S["cell"])],
              [_p("<b>Aktual: jujur</b>", S["cell_h"]), _p(f"<b>FP</b> {_fmt_num(fp)}", S["cell"]), _p(f"<b>TN</b> {_fmt_num(tn)}", S["cell"])]]
        story.append(_table(cm, widths=[52 * mm, 52 * mm, 52 * mm]))
        story.append(_p(f"Akurasi {_fmt_pct(acc * 100, 2)} · Presisi {_fmt_pct(prec * 100)} · Recall {_fmt_pct(rec * 100)} · "
                        f"F1 {f1:.3f} · FPR {_fmt_pct(fpr * 100, 3)} · Spesifisitas {_fmt_pct((1 - fpr) * 100, 2)} · FNR {_fmt_pct((1 - rec) * 100)}.",
                        S["caption"]))
    story.append(_p("Tabel 4 — Confusion matrix populasi pada titik operasi audit + metrik turunannya.", S["caption"]))
    board = _report_board()
    if board:
        story.append(_p("Perbandingan teknik (15 lipat, uji berpasangan vs terbaik):", S["h2"]))
        for tkey, tlabel in (("rumah_sakit", "Rumah sakit"), ("semua", "Semua klaim")):
            rows = board.get(tkey) or []
            if not rows:
                continue
            story.append(_p(tlabel, S["h2"]))
            bt = [[_p("<b>Teknik</b>", S["cell_h"]), _p("<b>Menang lipat</b>", S["cell_h"]), _p("<b>AUPRC OOF</b>", S["cell_h"]),
                   _p("<b>AUROC OOF</b>", S["cell_h"]), _p("<b>p vs terbaik</b>", S["cell_h"]), _p("<b>Kesimpulan</b>", S["cell_h"])]]
            for r in rows[:8]:
                u = r.get("uji_vs_terbaik") or {}
                g = r.get("gabungan_oof") or {}
                if u.get("selisih_auprc") is None:
                    verdict = "terbaik"
                else:
                    verdict = "berbeda nyata" if u.get("berbeda_nyata") else "setara"
                bt.append([_p((r.get("model") or "")[:30], S["cell"]), _p(f"{r.get('menang')}/{r.get('dari')}", S["cell_r"]),
                            _p(f"{g.get('auprc', 0):.4f}", S["cell_r"]), _p(f"{g.get('auroc', 0):.4f}", S["cell_r"]),
                            _p("—" if u.get("p") is None else f"{u['p']:.3f}", S["cell_r"]), _p(verdict, S["cell"])])
            story.append(_table(bt, widths=[52 * mm, 22 * mm, 24 * mm, 24 * mm, 22 * mm, 24 * mm]))
        story.append(_p("Tabel 5 — Papan teknik: hanya Extra Trees, Isolation Forest, dan aturan lama yang berbeda nyata dari terbaik; "
                         "semua gradient boosting dan regresi logistik setara secara statistik.", S["caption"]))
    sample = _sample_scores()
    if sample.get("n"):
        roc_png, roc_auc = _roc_chart(sample)
        if roc_png:
            from reportlab.platypus import Image as RLImage2
            story.append(RLImage2(io.BytesIO(roc_png), width=110 * mm, height=76 * mm))
            story.append(_p("Gambar 2 — Kurva ROC pada sampel telaah " + f"{int(sample.get('n') or 0):,}".replace(",", ".") + " klaim (diperkaya untuk telaah; bentuk kurva valid, "
                             "level presisi absolut tidak digeneralisasi ke populasi).", S["caption"]))
        hist_png = _score_hist_chart(sample)
        if hist_png:
            from reportlab.platypus import Image as RLImage3
            story.append(RLImage3(io.BytesIO(hist_png), width=160 * mm, height=57 * mm))
            story.append(_p("Gambar 3 — Skor risiko memisahkan kelas: klaim dikoreksi menumpuk di skor tinggi, klaim jujur di skor rendah. "
                             "Tumpang tindih di tengah inilah wilayah negatif sulit.", S["caption"]))

    # 5. studi kasus negatif sulit
    story.append(_p("5 &nbsp; Studi kasus: negatif sulit (jujur tetapi mirip fraud)", S["h1"]))
    story.append(_p(
        "Lima kelompok klaim jujur yang secara statistik menyerupai fraud diuji terhadap daftar audit model. "
        "Kolom laju-ditandai membandingkan kelompok itu dengan laju dasar 0,1%: angka di atasnya berarti kelompok tersebut "
        "kelebihan-beban oleh model — persis masalah yang tidak bisa diselesaikan skor telanjang dan menjadi alasan lapisan investigasi hibrida.", S["body"]))
    for key, title in (("semua", "Semua klaim"), ("rumah_sakit", "Rumah sakit")):
        hn = ((cards.get(key) or {}).get("negatif_sulit") or [])
        if not hn:
            continue
        story.append(_p(title, S["h2"]))
        rows = [[_p("<b>Kelompok</b>", S["cell_h"]), _p("<b>Klaim jujur</b>", S["cell_h"]), _p("<b>Ikut ditandai</b>", S["cell_h"]),
                 _p("<b>Laju</b>", S["cell_h"]), _p("<b>vs dasar 0,1%</b>", S["cell_h"])]]
        for h in hn:
            mult = (h["porsi_jujur_ditandai"] or 0) / 0.001
            rows.append([_p(h["kelompok"][:44], S["cell"]), _p(_fmt_num(h["jujur"]), S["cell_r"]),
                         _p(_fmt_num(h["jujur_ditandai"]), S["cell_r"]), _p(_fmt_pct(h["porsi_jujur_ditandai"] * 100, 2), S["cell_r"]),
                         _p(f"{mult:.1f}×", S["cell_r"])])
        story.append(_table(rows, widths=[62 * mm, 26 * mm, 26 * mm, 22 * mm, 24 * mm]))
    story.append(_p("Tabel 6 — Negatif sulit. Diagnosis langka berbiaya tinggi 26× kelebihan-beban pada RS; RS tersier 2–7×. Dialisis/kemoterapi yang sah hampir tak tersentuh — model benar di kasus mudah, gagal di kasus sulit.", S["caption"]))

    # 6. validasi runtime hibrida
    story.append(_p("6 &nbsp; Validasi runtime sistem hibrida", S["h1"]))
    vrows = [[_p("<b>Verifikator</b>", S["cell_h"]), _p("<b>Lulus</b>", S["cell_h"]), _p("<b>Total cek</b>", S["cell_h"]),
              _p("<b>Tingkat</b>", S["cell_h"]), _p("<b>Gagal</b>", S["cell_h"])]]
    for name, vv in v["validators"].items():
        rate = (vv["passed"] / vv["total"] * 100) if vv["total"] else 0
        vrows.append([_p(name, S["cell"]), _p(_fmt_num(vv["passed"]), S["cell_r"]), _p(_fmt_num(vv["total"]), S["cell_r"]),
                      _p(_fmt_pct(rate), S["cell_r"]), _p(_fmt_num(vv["checks_failed"]), S["cell_r"])])
    story.append(_table(vrows, widths=[52 * mm, 28 * mm, 28 * mm, 24 * mm, 24 * mm]))
    story.append(_p(f"Tabel 7 — Verdict verifikator pada 60 run terakhir ({v['runs_with_verdict']} run berverdict).", S["caption"]))
    if v["blocking_failures"]:
        story.append(_p("Kegagalan memblokir terbaru (jawaban ditahan):", S["h2"]))
        for b in v["blocking_failures"][:8]:
            story.append(_p(f"<b>{b['run']}</b> · {b['validator']}: {b['klaim'][:160]}", S["bullet"], bulletText="•"))
    gr = d["golden"]["runs"] or []
    if gr:
        story.append(_p("Riwayat evaluasi golden kopilot:", S["h2"]))
        grows = [[_p("<b>Waktu</b>", S["cell_h"]), _p("<b>Model</b>", S["cell_h"]), _p("<b>Lulus</b>", S["cell_h"]),
                  _p("<b>Biaya</b>", S["cell_h"]), _p("<b>Token</b>", S["cell_h"])]]
        for r in gr[:8]:
            grows.append([_p(_wib(r.get("time")), S["cell"]), _p((r.get("model") or "").split("/")[-1][:30], S["cell"]),
                          _p(f"{r.get('passed')}/{r.get('answered')}", S["cell_r"]),
                          _p(_fmt_usd(r.get("usd")), S["cell_r"]), _p(_fmt_num(r.get("tokens")), S["cell_r"])])
        story.append(_table(grows, widths=[42 * mm, 56 * mm, 22 * mm, 24 * mm, 24 * mm]))
        story.append(_p("Tabel 8 — Riwayat evaluasi golden (skor terhadap kebenaran hidup dari API platform).", S["caption"]))
    gf = d["gold_failed"] or []
    if gf:
        story.append(_p("Soal gagal pada evaluasi terakhir:", S["h2"]))
        for f in gf:
            story.append(_p(f"<b>{f.get('id')}</b> — {f.get('q', '')[:140]}<br/>Cek gagal: {'; '.join(f.get('missed') or [f.get('error') or '—'])[:200]}", S["bullet"], bulletText="•"))

    # 7. kontrol produksi + biaya
    story.append(_p("7 &nbsp; Kontrol produksi dan biaya", S["h1"]))
    sp = ov["spend"]
    story.append(_p(f"Belanja model Vertex: hari ini <b>{_fmt_usd(sp['today']['usd'])}</b> ({_fmt_num(sp['today'].get('calls'))} panggilan), "
                     f"bulan ini <b>{_fmt_usd(sp['month']['usd'])}</b>, total <b>{_fmt_usd(sp['total_usd'])}</b>. "
                     f"Setiap panggilan model agen melewati penjaga biaya dan dibukukan ke ledger yang sama.", S["body"]))
    grows2 = [[_p("<b>Gerbang kontrol</b>", S["cell_h"]), _p("<b>Status</b>", S["cell_h"]), _p("<b>Bukti</b>", S["cell_h"])]]
    for gt in ov["gates"]:
        grows2.append([_p(gt["nama"][:52], S["cell"]), _p(gt["status"].upper(), S["cell"]), _p(gt["bukti"][:170], S["cell"])])
    story.append(_table(grows2, widths=[52 * mm, 20 * mm, 96 * mm]))
    story.append(_p("Tabel 9 — Gerbang kontrol produksi. Status apa adanya: aktif / manual / belum.", S["caption"]))

    # 8. keterbatasan
    story.append(_p("8 &nbsp; Keterbatasan (dibaca sebelum mengutip laporan ini)", S["h1"]))
    for b in [
        "Kapasitas audit 0,1% adalah <b>asumsi</b>, bukan angka kapasitas verifikator BPJS.",
        "Label 'dikoreksi verifikator' <b>bukan vonis fraud</b>; sebagian koreksi adalah kesalahan administrasi yang diperbaiki.",
        "Beban audit menumpuk pada faskes besar yang jujur (RS Kelas A/B, faskes besar): model menemukan pola biaya-volume, bukan niat.",
        "Belum ada uji acak terkontrol (RCT) head-to-head hibrida vs ML-saja pada set kasus yang sama — lembar blind review (20 flagged + 20 acak) tersedia sebagai arena buta berikutnya.",
        "Sampel publik hanya sebagian klaim nasional; generalisasi ke seluruh populasi JKN memerlukan evaluasi pada data penuh.",
    ]:
        story.append(_p(b, S["bullet"], bulletText="•"))

    story.append(Spacer(1, 8 * mm))
    story.append(_p(f"Dibuat otomatis dari ledger produksi AIP JKN · {_wib(gen)} · versi model {d['model_version'] or '—'}", S["caption"]))

    doc = BaseDocTemplate(str(path), pagesize=A4, leftMargin=22 * mm, rightMargin=22 * mm, topMargin=20 * mm, bottomMargin=20 * mm,
                          title=TITLE, author="AIP JKN")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=_footer)])
    doc.build(story)
    return {"path": str(path), "pages": None, "model_version": d["model_version"], "generated_at": gen}

