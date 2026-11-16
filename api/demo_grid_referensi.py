"""Demo Grid: the papers the grid's NTL methods follow, as nodes of the Data Lineage (step "referensi").

Each paper is a PDF in Files (PLN Grid Project / referensi — the Project's roles decide who sees the node) and a lineage
reference ("Reference / paper") with edges to the pipelines, models and Nexus types whose method it informs, each edge
saying how: the main reference of a process, or a method comparison that is NOT implemented. Also added to the saved
lineage graphs of the grid demo.

  - Taruna dkk. 2025, IEEE Access 13 (PLN case study, Target Operasi): the reference of the NTL target list.
  - Haq dkk. 2023, Energy Reports 9:634–643 (deep CNN on smart meter data): the method comparison for hourly detection
    from AMI — the demo keeps Isolation Forest + gradient boosting + hourly CUSUM; the CNN is not trained here.

The PDFs come from paper_reference/ in the checkout (the user's copies, not committed); a missing PDF leaves the
reference without its file, still citable by DOI.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

FOLDER = "referensi"
ROOT = Path(__file__).resolve().parent.parent / "paper_reference"

PAPERS = [
    {
        "id": "taruna2025",
        "short": "Taruna dkk. 2025 — Target Operasi PLN",
        "title": "Electricity Theft Detection Using Machine Learning in Traditional Meter Postpaid Residential Customers: "
                 "A Case Study on State Electricity Company (PLN) Indonesia",
        "authors": "Taruna, Arisona, Irwanto, Bestari, Juniawan",
        "venue": "IEEE Access 13", "year": 2025, "doi": "10.1109/ACCESS.2025.3526764", "license": "CC BY 4.0 (IEEE Access, open access)",
        "pdf": "Electricity_Theft_Detection_Using_Machine_Learning_in_Traditional_Meter_Postpaid_Residential_Customers_A_Case_Study_on_State_Electricity_Company_PLN_Indonesia.pdf",
        "note": "Rujukan utama proses Target Operasi (TO): daftar target P2TL dari pemakaian bulanan pelanggan pascabayar 450 VA bermeter tradisional "
                "(Random Forest terbaik; penyaringan sekuensial RF+KNN: akurasi 0,89, AUC 0,89). Di demo: antrean target P2TL berprioritas nilai, "
                "termasuk pelanggan tanpa AMI.",
        "informs": [("model", "metode Target Operasi (rujukan utama)"), ("scoring", "proses daftar Target Operasi"),
                    ("feedback", "label hasil P2TL → latih ulang"), ("type:pelanggan", "skor NTL & prioritas pemeriksaan")],
    },
    {
        "id": "haq2023",
        "short": "Haq dkk. 2023 — deep CNN smart meter",
        "title": "Electricity-theft detection for smart grid security using smart meter data: A deep-CNN based approach",
        "authors": "Ejaz Ul Haq, Can Pei, Ruihong Zhang, Huang Jianjun, Fiaz Ahmad",
        "venue": "Energy Reports 9:634–643 (CPESE 2022)", "year": 2023, "doi": "10.1016/j.egyr.2022.11.072", "license": "CC BY-NC-ND 4.0",
        "pdf": "Haq2023_Electricity-theft_detection_deep-CNN_Energy_Reports.pdf",
        "note": "Deep CNN (5 blok konvolusi 3×3 32→512 filter + max-pooling 2×2, LReLU, dropout, softmax 2 kelas) atas profil konsumsi smart meter 2-D; "
                "kelas pencuri diaugmentasi (17% dari 45.970 pelanggan, data 10 menit → 30 menit, Mei 2018–Apr 2020); uji 25%: TN 9.384, FP 155, "
                "FN 97, TP 1.856. Di demo grid: pembanding metode & acuan desain fitur profil harian untuk deteksi dari AMI — TIDAK dipakai melatih; "
                "model demo tetap Isolation Forest + gradient boosting + CUSUM per jam.",
        "informs": [("ami", "data smart meter (AMI) yang dianalisis metode ini"), ("ntl_stream", "pembanding metode: deep CNN atas profil konsumsi"),
                    ("model", "pembanding (benchmark), tidak dipakai melatih"), ("type:peristiwa", "dugaan bypass dari pola smart meter")],
    },
]


def _e():
    import demo_grid_e2e as e

    return e


def _pdf(folder: str, name: str) -> Optional[str]:
    """The paper's PDF in Files (uploaded once from paper_reference/)."""
    import drive

    have = next((f for f in drive.list_files(folder) if f["name"] == name and not f.get("trashed_at")), None)
    if have:
        return have["id"]
    src = ROOT / name
    if not src.exists():
        return None
    return drive.save_bytes(folder, name, src.read_bytes(), "application/pdf")["id"]


def _targets(state: dict) -> dict[str, list[str]]:
    """Lineage node ids by role: the NTL model (its training transform and the model nodes it trains), the scoring,
    feedback, AMI and hourly NTL pipelines, and the Nexus types."""
    import lineage
    import ontology

    import demo_grid_ml as ml

    g = lineage.cached_graph(False)
    trans = [nid for nid, n in g.nodes.items() if n["kind"] == "transform" and str(n.get("subtitle") or "").startswith(ml.REPO)]
    models = sorted({e["to"] for e in g.edges.values() if e["from"] in trans and g.nodes.get(e["to"], {}).get("kind") == "model"})
    pipe = lambda pid: [f"pipeline:{pid}"] if pid and f"pipeline:{pid}" in g.nodes else []  # noqa: E731
    types = {t["display_name"]: f"object_type:{t['id']}" for t in ontology._all("object-types")}
    e = _e()
    return {
        "model": models or trans,  # the model nodes; the training transforms only when no model node exists
        "scoring": pipe(state.get("scoring_pipeline_id")),
        "feedback": pipe((state.get("feedback") or {}).get("pipeline_id")),
        "ami": pipe((state.get("ami") or {}).get("pipeline_id")),
        "ntl_stream": pipe((state.get("ntl_stream") or {}).get("pipeline_id")),
        "type:pelanggan": [types[e.T["pelanggan"][0]]] if e.T["pelanggan"][0] in types else [],
        "type:peristiwa": [types["AMI Event (demo)"]] if "AMI Event (demo)" in types else [],
    }


STOP_KINDS = {"object_type", "module", "map", "vertex", "osdk_app", "automation", "agent", "logic"}


def downstream_to_nexus(node_ids: list[str], depth: int = 6) -> set[str]:
    """What the given nodes produce, followed down to the Nexus: their output datasets and streams, the pipelines,
    transforms and models reading those, and the object types at the end (not beyond them), so a saved graph never
    shows a pipeline or a model whose outputs stop nowhere."""
    import lineage

    g = lineage.cached_graph(False)
    out: dict[str, list[str]] = {}
    for e in g.edges.values():
        out.setdefault(e["from"], []).append(e["to"])
    seen: set[str] = set()
    frontier = [n for n in node_ids if n in g.nodes]
    for _ in range(depth):
        nxt = []
        for nid in frontier:
            if g.nodes.get(nid, {}).get("kind") in STOP_KINDS and nid not in node_ids:
                continue
            for t in out.get(nid, []):
                if t not in seen and g.nodes.get(t, {}).get("kind") not in ("module", "map", "vertex", "osdk_app", "automation", "agent", "logic"):
                    seen.add(t)
                    nxt.append(t)
        frontier = nxt
    return seen


def complete_graph(gid: str) -> int:
    """A saved lineage graph with every producer in it (pipeline, transform, model) followed down to the Nexus."""
    import lineage

    rec = next((x for x in lineage.list_graphs() if x.get("id") == gid), None)
    if not rec:
        return 0
    producers = [n for n in rec.get("nodes") or [] if n.split(":", 1)[0] in ("pipeline", "transform", "model", "notebook", "studio")]
    extra = downstream_to_nexus(producers) - set(rec["nodes"])
    if extra:
        body = {k: rec[k] for k in ("name", "colors", "color_by", "permissions", "positions") if rec.get(k) is not None}
        lineage.save_graph(lineage.SavedGraph(**body, nodes=sorted(set(rec["nodes"]) | extra)), id=gid)
    return len(extra)


def build(state: dict, save) -> dict:
    import lineage

    e = _e()
    st = state.setdefault("referensi", {})
    project = e._folder(None, e.PROJECT, "project")
    folder = e._folder(project, FOLDER)
    targets = _targets(state)
    out: dict[str, Any] = {"targets": {k: len(v) for k, v in targets.items()}}
    ids: list[str] = []
    for p in PAPERS:
        item = _pdf(folder, p["pdf"])
        informs = [{"node": nid, "relation": rel} for role, rel in p["informs"] for nid in targets.get(role, [])]
        lineage.save_reference({k: v for k, v in p.items() if k not in ("pdf", "informs")} | {"item_id": item, "informs": informs})
        ids += [f"reference:{p['id']}", *(x["node"] for x in informs)]
        out[p["id"]] = {"pdf": bool(item), "edges": len(informs)}
    # the grid demo's saved lineage graphs carry the papers together with what they inform (else they float alone)
    for gid in ("gridsusut", "gridoperasi"):
        rec = next((x for x in lineage.list_graphs() if x.get("id") == gid), None)
        if rec and not set(ids) <= set(rec.get("nodes") or []):
            body = {k: rec[k] for k in ("name", "colors", "color_by", "permissions", "positions") if rec.get(k) is not None}
            lineage.save_graph(lineage.SavedGraph(**body, nodes=sorted(set(rec["nodes"]) | set(ids))), id=gid)
            out.setdefault("graphs", []).append(gid)
        # and what those pipelines and models produce, down to the Nexus (else they end in nothing on the canvas)
        out.setdefault("completed", {})[gid] = complete_graph(gid)
    st.update(folder_id=folder, references=[p["id"] for p in PAPERS])
    save()
    return out
