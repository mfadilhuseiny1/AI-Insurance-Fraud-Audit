"""The AIP domain agents: one agent answers for each group of Nexus objects.

An agent is an object type group whose name starts with "Agen " (Ontology → groups): its object types are the objects
it is responsible for, its description is what it answers for. The orchestrator hands a question about an object to
the agent of that object's group, and the agent's tools reach only its own object types (aip/adk_runtime/tools.py
refuses others and names the agent that owns them). Adding a group, or moving a type to another group, changes the
agents without a code change. One agent is not an object group: "Agen Data & Lineage" answers for the platform's own
resources (datasets, pipelines, lineage, code).

GET /api/aip/agents → {"agents": [{key, name, description, object_types: [{id, name, api_name, primary_key, title,
                       properties: [{api_name, display_name, type}]}], tools, model, …}], "roles": the model of each role}
"""

from __future__ import annotations

import re
from typing import Any

from aip import models as aip_models

PLATFORM_AGENT = {
    "key": "data", "name": "Agen Data & Lineage", "group_id": None,
    "description": "Agen platform: dataset, pipeline (Arsip Sumber → Data Mentah → Data Bersih → Siap Analisis), Data Lineage, kode transform dan pencarian Nexus. "
                   "Menjawab dari mana sebuah angka berasal.",
    "object_types": [], "tools": ["cari_nexus", "telusuri_lineage", "baca_kode"],
}
OBJECT_TOOLS = ["cari_objek", "agregasi_objek", "detail_objek", "objek_terkait", "jalankan_fungsi", "usulkan_action"]
CLAIMS_TYPE = "Klaim Berisiko (BPJS)"  # its agent also estimates the loss of a set of claims (estimasi_kerugian_klaim)
# the Machine Learning agent's group (aip/ml.py creates it with its two types): its tools run the claim-risk model
ML_GROUP = "Agen Machine Learning (BPJS)"
ML_TOOLS = ["kartu_model_ml", "kartu_bukti_model", "bentuk_sub_agen_teknik", "skor_risiko_klaim_ml", "risiko_faskes_ml", "jelaskan_klaim_ml",
            "verifikasi_klaim", "benchmark_ml"]


def _key(name: str) -> str:
    """"Agen Klaim & Fraud (BPJS)" → "klaim_fraud"."""
    core = re.sub(r"\(.*?\)", "", name.removeprefix("Agen ")).lower()
    return re.sub(r"[^a-z0-9]+", "_", core).strip("_")


# agents that answered overlapping questions, merged (2026-10-23): the second group's objects belong to the first group's
# agent. The Nexus groups stay as they are; only the AIP agents are one.
MERGE = {"AI Agent Swarm (AIP)": "Agen Klaim & Fraud (BPJS)", "Agen Konsultan Fraud (AIP)": "Agen Klaim & Fraud (BPJS)", "Agen Rujukan (BPJS)": "Agen Peserta (BPJS)"}
RENAME = {
    "Agen Klaim & Fraud (BPJS)": ("Agen Klaim & Indikasi Fraud (BPJS)",
                                  "Agen domain AIP untuk klaim berisiko dan indikasinya: skrining aturan, indikator INA-CBG, agregat klaim per wilayah dan "
                                  "bulan, buku besar indikasi fraud (tag dengan kekuatan dan marking) dan box karantina faskes (kelompok kerugian, TSM, "
                                  "rekomendasi jalur); AI Agent Swarm bekerja untuk agen ini. Mengusulkan tahan klaim atau eskalasi."),
    "Agen Peserta (BPJS)": ("Agen Peserta & Rujukan (BPJS)",
                            "Agen domain AIP untuk peserta dan layanan primer: peserta di balik klaim berisiko, profil kepesertaan per provinsi, kunjungan "
                            "FKTP bulanan dan alur rujukan FKTP → FKRTL antarwilayah (lintas kab/kota dan provinsi, hari ke FKRTL, kesesuaian diagnosis)."),
}
# the firm's small agents per line, as the graph names them beside the domain agent that leads them
FIRM_LINE = {"wilayah": "Analis wilayah", "peer": "Analis peer kelas", "modus": "Spesialis modus", "kasus": "Penyidik kasus", "ml": "Sub-agen teknik"}
# what each agent answers, in a phrase, and its place on the map (the graph groups agents by meaning, not by name)
SEMANTIC = {"faskes_wilayah": ("siapa & di mana", "Di mana risikonya? Provinsi, kab/kota, profil faskes"),
            "peserta": ("siapa & di mana", "Siapa pesertanya, dari FKTP mana dirujuk?"),
            "klaim_fraud": ("apa yang diklaim", "Klaim mana berisiko, indikasi apa, faskes mana dikarantina?"),
            "klinis": ("apa yang diklaim", "Apakah diagnosis, kode INA-CBG dan keparahannya wajar?"),
            "machine_learning": ("penilaian risiko", "Seberapa andal model, teknik mana yang setara, klaim mana skornya tinggi?"),
            "data": ("asal data", "Dari mana angka ini berasal? Dataset, pipeline, lineage")}


def catalogue() -> dict[str, Any]:
    import ontology
    import ontology_model as om

    # the agents' groups, and the merged ones whatever their name: "AI Agent Swarm (AIP)" (the indication ledger and the
    # box) lost its "Agen " prefix in a rename and with it its place under the claims agent (2026-10-27)
    groups = {g["id"]: g for g in om._groups() if g["name"].startswith("Agen ") or g["name"] in MERGE}
    by_name = {g["name"]: gid for gid, g in groups.items()}
    agents: dict[str, dict] = {}
    for t in ontology._all("object-types"):
        for gid in t.get("groups") or []:
            g = groups.get(gid)
            if not g:
                continue
            if g["name"] in MERGE and MERGE[g["name"]] in by_name:  # a merged group: its objects go to its partner's agent
                gid = by_name[MERGE[g["name"]]]
                g = groups[gid]
            name, desc = RENAME.get(g["name"], (g["name"], g.get("description", "")))
            a = agents.setdefault(gid, {"key": _key(g["name"]), "name": name, "group_id": gid, "description": desc,
                                        "object_types": [], "tools": OBJECT_TOOLS + (ML_TOOLS if g["name"] == ML_GROUP else [])})
            if any(x["id"] == t["id"] for x in a["object_types"]):
                continue
            a["object_types"].append({
                "id": t["id"], "name": t["display_name"], "api_name": t.get("api_name"), "primary_key": t.get("primary_key"),
                "title": t.get("title_property"), "description": (t.get("description") or "")[:300],
                "properties": [{"api_name": p["api_name"], "display_name": p.get("display_name"), "type": p.get("type")} for p in t.get("properties") or []],
            })
    out = sorted(agents.values(), key=lambda a: a["name"]) + [PLATFORM_AGENT]
    for a in out:
        a["peta"], a["menjawab"] = SEMANTIC.get(a["key"], ("lainnya", ""))
        if any(t["name"] == CLAIMS_TYPE for t in a["object_types"]):  # the loss of a set of claims (adk_runtime/tools.py)
            a["tools"] = a["tools"] + ["estimasi_kerugian_klaim"]
    # the small agents each domain agent led at the last engagement of the fraud consultancy (aip/konsultan.py): the firm
    # is these agents at work, so its analysts hang off the agent whose objects they read
    from aip import indikasi, konsultan

    firm = indikasi._state().get("firma") or {}
    led: dict[str, dict[str, list[str]]] = {}
    for x in firm.get("tim") or []:
        if x.get("jenjang") in ("analis", "peran"):  # a role (the investigator, the red team) is one agent, whatever its instances
            led.setdefault(konsultan.lead_of(x), {}).setdefault(x["lini"], []).append(x["name"])
    for a in out:
        if "kartu_model_ml" in a["tools"]:
            # the ML agent's branch: one sub-agent per technique, for a question (adk_runtime/tools.py bentuk_sub_agen_teknik) and in the firm
            import ml_klaim

            a["subagents"] = [{"key": "sub_" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_"), "name": f"Sub-agen {name}", "technique": name,
                               "family": fam, "research": [f"{r['penulis']} {r['tahun']}" for r in ml_klaim.RESEARCH.get(name, [])][:3]}
                              for name, (fam, _ref) in ml_klaim.MODELS.items()]
        elif led.get(a["key"]):
            a["subagents"] = [{"key": f"firma_{a['key']}_{lini}", "name": f"{FIRM_LINE.get(lini, lini)} ({len(names)} agen)", "technique": FIRM_LINE.get(lini, lini),
                               "family": "firma", "research": names[:4] + ([f"… {len(names) - 4} lainnya"] if len(names) > 4 else [])}
                              for lini, names in led[a["key"]].items()]
        if led.get(a["key"]) or "kartu_model_ml" in a["tools"]:
            a["firma"] = {"agen": firm.get("agen"), "run": firm.get("run"), "pada": firm.get("pada"),
                          "memimpin": sum(len(v) for v in led.get(a["key"], {}).values())}
    # the domain agents read the data and judge what matters: the strongest model while answers count more than cost
    # (the user, 2026-10-23: "effective > efficiency"); the fast tools model when it is not ready
    model = aip_models.GLM if aip_models.ready(aip_models.GLM) else aip_models.pick("tools")
    for a in out:
        a["model"] = model
    roles = {r: aip_models.pick(r) for r in ("planner", "tools")}
    roles["tools"] = model  # what the domain agents run on (adk_runtime/main.py)
    # the briefing and its screen are what the auditor reads: the strongest model writes and lays them out (about
    # $0.02 more a question); the validator stays of another family than the writer
    roles["writer"] = aip_models.pick("writer", strong=True)
    roles["validator"] = aip_models.pick("auditor_sim", checks=roles["writer"])
    roles["ui"] = "templat dasbor"  # adk_runtime/screens.py: templates filled from the run's results, no model
    roles["awam"] = aip_models.pick("awam")  # the validated briefing in plain words for leaders (adk_runtime/main.py _plain)
    # the Nexus relations between the agents' objects: the network the architecture view draws
    ids = {t["id"] for a in out for t in a["object_types"]}
    links = [{"id": lt["id"], "name": lt.get("display_name") or lt["id"], "source": lt["source"]["object_type_id"], "target": lt["target"]["object_type_id"]}
             for lt in om._all("link-types") if lt["source"]["object_type_id"] in ids and lt["target"]["object_type_id"] in ids]
    # the skills the orchestrator assigns per task, with what earlier runs taught them (aip/skills.py)
    from aip import skills

    # and the orchestrator's rules, when an admin switched on a tuned version for the planner's model (aip/optimasi.py)
    return {"agents": out, "roles": roles, "apps": apps(), "links": links, "skills": skills.catalogue(), "aturan": skills.rules_for(roles)}


# the connected apps of the BPJS data, found by name (as the caller sees them): the studio opens them beside the agents
APP_NAMES = {"map": "Peta risiko klaim BPJS (Data Sampel 2025)", "lineage_graph": "Data Sampel BPJS: Arsip Sumber → Data Mentah → Data Bersih → Siap Analisis",
             "pipeline": "Pipeline Data Sampel BPJS: Data Mentah → Siap Analisis",
             # the second pipeline: the facts on every claim (bpjs_sampel/fakta_pipeline.py)
             "pipeline_fakta": "Fakta Klaim BPJS: Siap Analisis → Fakta Klaim"}


def apps() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        import geospatial

        m = next((m for m in geospatial.list_maps() if m.get("name") == APP_NAMES["map"]), None)
        if m:
            out["map"] = f"/map/{m['id']}"
    except Exception:  # noqa: BLE001 - an app the caller cannot see is left out
        pass
    try:
        import lineage

        g = next((g for g in lineage.list_graphs() if g.get("name") == APP_NAMES["lineage_graph"]), None)
        if g:
            out["lineage"] = f"/lineage?graph={g['id']}"
    except Exception:  # noqa: BLE001
        pass
    try:
        import pipeline_datasets

        pipes = pipeline_datasets.list_pipelines(tests=False)
        for key in ("pipeline", "pipeline_fakta"):
            name = APP_NAMES[key] + pipeline_datasets.PIPELINE_EXT  # a pipeline is a file in Files, named with its extension
            p = next((p for p in pipes if p.get("name") == name), None)
            if p:
                out[key] = f"/pipeline/{p['id']}"
    except Exception:  # noqa: BLE001
        pass
    return out
