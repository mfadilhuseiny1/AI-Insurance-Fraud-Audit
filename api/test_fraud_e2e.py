"""The fraud system end to end on the running API and the real data (no stubs): the inference pipeline POST /verify with
the judges' payloads and a claim of the data, the clinical review, the evidence ladder, the system map, the tag ledger
and the box, and the orchestrator forming small agents for a question that covers several provinces.

    python -m pytest test_fraud_e2e.py -q -s          # the API on BLUESANDAI_E2E_API (default http://localhost:8000)
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import requests

from test_aip_e2e import API, answer_of, ask, auditor, receipts  # noqa: F401  (the fixture and helpers of the AIP suite)

MOCK = json.loads((Path(__file__).resolve().parent.parent / "healthkathon" / "inference-api" / "mock_payloads.json").read_text("utf-8"))
STAGES = ["01_client_request", "02_schema_validation", "03_feature_engineering", "04_ml_inference", "05_llm_service", "06_json_response"]


def test_verify_answers_the_judges_contract(auditor: requests.Session):  # noqa: F811
    for name in ("legitimate_claim", "fraud_upcoding_claim"):
        r = auditor.post(f"{API}/api/aip/fraud/v1/verify", json=MOCK[name], timeout=300)
        assert r.status_code == 200, r.text
        j = r.json()
        assert {"status", "fraud_probability", "ai_reasoning"} <= set(j)
        assert j["status"] in ("INDIKASI_KUAT", "PERLU_DIPERIKSA", "WAJAR")
        assert 0.0 <= j["fraud_probability"] <= 1.0 and len(j["ai_reasoning"]) > 40
        assert [s["tahap"] for s in j["pipeline"]] == STAGES
        assert "pickle" in j["ml"]["mesin"]  # the AIP workflow's model is the deployed pickle
        tl = j["analisis_medis"]["telaah"]
        assert tl["lolos_gerbang_angka"], tl["angka_tidak_terverifikasi"]  # every number it wrote is a fact it was given
        print(f"\n{name}: {j['status']} p={j['fraud_probability']} · {tl['label']} ({tl['model']}) · {j['ai_reasoning'][:160]}")
    up = auditor.post(f"{API}/api/aip/fraud/v1/verify", json=MOCK["fraud_upcoding_claim"], timeout=300).json()
    assert up["status"] != "WAJAR"  # sepsis billed at 5.86x the tariff on notes of a mild typhoid fever


def test_verify_refuses_a_payload_outside_the_contract(auditor: requests.Session):  # noqa: F811
    r = auditor.post(f"{API}/api/aip/fraud/v1/verify", json={**MOCK["legitimate_claim"], "claimed_cost": -5}, timeout=60)
    assert r.status_code == 422


def test_verify_a_claim_of_the_data_uses_its_batch_features(auditor: requests.Session):  # noqa: F811
    box = auditor.get(f"{API}/api/aip/karantina", params={"kelompok": "A"}, timeout=120).json()
    fac = auditor.get(f"{API}/api/aip/karantina/{box['kelompok']['A']['faskes'][0]['faskes_profil_id']}", timeout=120).json()
    kid = fac["klaim_kontributor"][0]["klaim_id"]
    j = auditor.post(f"{API}/api/aip/fraud/v1/verify/klaim", json={"klaim_id": kid}, timeout=300).json()
    assert j["klaim_id"] == kid and j["pipeline"][2]["keterangan"].startswith("fitur batch")
    assert "dikoreksi_verifikator" in j["di_luar_prompt"]  # the outcome is shown beside the review, never given to it


def test_the_system_map_the_ladder_and_the_box(auditor: requests.Session):  # noqa: F811
    s = auditor.get(f"{API}/api/aip/konsultan/sistem", timeout=120).json()
    assert s["indikasi"]["total"] > 1000 and s["karantina"]["faskes"] > 100 and s["model"]["deploy"]
    t = auditor.get(f"{API}/api/aip/ml/tangga", timeout=120).json()
    names = [r["langkah"] for r in t["tangga"]]
    # the kit's slide-27 order: the steps within reach before a pilot first, the designed audit in the pilot
    assert names[0] == "Benchmark sintetis (aturan 2)" and names.index("Label nyata parsial") < names.index("Audit terancang dalam pilot")
    assert all(r["mendukung"] and r["tidak_menunjukkan"] for r in t["tangga"])
    cat = auditor.get(f"{API}/api/aip/agents", timeout=120).json()
    keys = {a["key"] for a in cat["agents"]}
    assert "konsultan_fraud" not in keys and "rujukan" not in keys  # merged into their partners
    claims = next(a for a in cat["agents"] if a["key"] == "klaim_fraud")
    assert "Indikasi Fraud (AI Agent Swarm)" in [t["name"] for t in claims["object_types"]]
    assert claims["subagents"] and all(x["family"] == "firma" for x in claims["subagents"])


def _idn(n: int) -> str:
    return f"{n:,}".replace(",", ".")


def test_a_question_over_several_provinces_is_answered_scope_by_scope(auditor: requests.Session):  # noqa: F811
    """Several provinces side by side: since the audit route (2026-10-24) one audit pack per province, read by code, else
    one small agent per province. Either way each province's risky claims and its LOS-extreme claims are two figures:
    a pack cut to the LOS-extreme claims once reported them as the province's risky claims ("459 klaim berisiko dan 459
    klaim LOS ekstrem" for Sulawesi Selatan, which has 1,093 risky claims, 2026-10-27)."""
    q = ("Bandingkan jumlah klaim berisiko dan klaim LOS ekstrem di Jawa Barat, Jawa Tengah, Jawa Timur, DKI Jakarta dan Sulawesi Selatan: "
         "provinsi mana yang paling menonjol?")
    run, events = ask(auditor, q, timeout=900)
    assert run["status"] == "succeeded", [e for e in events if e["type"] == "error"]
    plan = next(e for e in events if e["type"] == "plan")
    text = answer_of(events)
    assert sum(bool(re.search(p, text, re.I)) for p in ("jawa barat", "jawa tengah", "jawa timur", "jakarta", "sulawesi selatan")) >= 4, text[:600]
    sulsel = auditor.post(f"{API}/api/aip/karantina/paket", json={"provinsi": "SULAWESI SELATAN"}, timeout=300).json()
    kpi = next(p for p in sulsel["bagian"] if p["kunci"] == "ringkasan")["baris"][0]
    assert _idn(kpi["klaim"]) in text and _idn(kpi["klaim_los_ekstrem"]) in text, (kpi["klaim"], kpi["klaim_los_ekstrem"], text[:900])
    if plan.get("jalur") == "audit":
        scopes = plan["audit"] if isinstance(plan["audit"], list) else [plan["audit"]]
        assert len(scopes) >= 4 and len(plan["tasks"]) <= 2, plan
        print(f"\npaket audit: {[s.get('provinsi') for s in scopes]}")
        return
    formed = [e for e in events if e["type"] == "subagents" and e.get("kind") == "agen_kecil"]
    small = [a for e in formed for a in e["agents"]]
    assert len(small) >= 4, plan
    worked = {r["agent"] for r in receipts(events) if "__" in r["agent"] and r["ok"]}
    assert len(worked) >= 4, sorted(worked)
    print(f"\nagen kecil: {[a['technique'] for a in small]}")
    # the orchestration concept: the contract before the work, a skill per task, a handoff per worker, code before the validator
    assert len(plan.get("kontrak") or []) >= 3, plan
    assert all(t.get("skill") for t in plan["tasks"]), plan["tasks"]
    handed = {e["agent"] for e in events if e["type"] == "handoff"}
    assert {t["kunci"] for t in plan["tasks"]} <= handed, (handed, [t["kunci"] for t in plan["tasks"]])
    assert all(e["handoff"]["procedures_followed"]["cek"] for e in events if e["type"] == "handoff")
    scrut = [e for e in events if e["type"] == "verdict" and e["validator"] == "scrutiny"]
    assert scrut and scrut[0]["total"] >= 3, scrut
    stages = [e["stage"] for e in events if e["type"] == "stage"]
    assert stages.index("scrutiny") < stages.index("validate"), stages
    judged = next(e for e in events if e["type"] == "verdict" and e["validator"] == "validator").get("kontrak") or []
    assert len(judged) == len(plan["kontrak"]) and any(c["ok"] is not None for c in judged), judged
    print(f"kontrak: {sum(c['ok'] is True for c in judged)}/{len(judged)} · scrutiny {scrut[0]['passed']}/{scrut[0]['total']} · "
          f"serah-terima {len(handed)} · pelajaran {[e['skill'] for e in events if e['type'] == 'pelajaran']}")


def test_the_agent_network_is_whole(auditor: requests.Session):  # noqa: F811
    n = auditor.get(f"{API}/api/aip/jaringan", timeout=300).json()
    ids = {x["id"] for x in n["simpul"]}
    assert len(ids) == len(n["simpul"])
    assert all(e["dari"] in ids and e["ke"] in ids for e in n["hubungan"])
    assert all(x["fungsi"] for x in n["simpul"]), [x["id"] for x in n["simpul"] if not x["fungsi"]]
    assert all(a["arti"] for x in n["simpul"] for a in x.get("aksi") or []), "an action without its description"
    tim = auditor.get(f"{API}/api/aip/konsultan/tim", timeout=300).json()
    agents = [x for x in n["simpul"] if x["jenis"] not in ("mesin", "layanan", "manusia", "dinamis", "state", "modus")]
    assert n["ringkasan"]["agen"] == len(agents) == tim["jumlah_agen"] + 1  # the firm's agents and the data agent, each once
    # every small agent hangs off the agent whose objects it reads; one analyst per province
    leads = {x["id"] for x in n["simpul"] if x["jenis"] in ("agen_domain", "validator")}
    assert all(x["induk"] in leads for x in n["simpul"] if x["jenis"] in ("agen_kecil", "sub_agen"))
    provinces = [x for x in n["simpul"] if x.get("lini") == "wilayah"]  # the data's 38-province coding: every province has FKRTL claims
    assert len(provinces) == 38 and all(len(x["cakupan"].split(",")) == 1 for x in provinces), [x["cakupan"] for x in provinces][:5]
    r = n["ringkasan"]
    assert r["agen"] == r["sebelum"]["total"] - r["dihemat"] + r["jumlah_ditambah"]  # the merged / added accounting adds up
    # the fraud modes: the four focus modes each found by a specialist of its own; no detector promised without data
    modes = {x["id"]: x for x in n["simpul"] if x["jenis"] == "modus"}
    assert len(modes) == 19 and sum(m["fokus"] for m in modes.values()) == 4
    by = {}
    for e in n["hubungan"]:
        if e["jenis"] == "mendeteksi":
            by.setdefault(e["ke"], set()).add(e["dari"])
    for mid, m in modes.items():
        if m["fokus"]:
            assert any(d.startswith("modus_") for d in by.get(mid, ())), (m["pendek"], by.get(mid))
        if m["deteksi"] == "tidak ada data":
            assert not any(d.startswith("modus_") for d in by.get(mid, ())), (m["pendek"], by.get(mid))
    # no agent per hospital: the investigator and the red team are one role each, with a capacity; the investigator's queue
    # is the box as it stands (the facilities change, the agents do not)
    roles = {x["id"]: x for x in n["simpul"] if x.get("dinamis")}
    assert set(roles) == {"penyidik_kasus", "red_team"}, sorted(roles)
    assert not [x["id"] for x in n["simpul"] if x["id"].startswith(("kasus_", "redteam_"))]
    assert roles["penyidik_kasus"]["kapasitas"] >= 6 and roles["penyidik_kasus"]["antrean"], roles["penyidik_kasus"]
    assert any(e["dari"] == "karantina" and e["ke"] == "penyidik_kasus" for e in n["hubungan"])


def test_provinces_follow_the_data_s_38_province_coding(auditor: requests.Session):  # noqa: F811
    """Provinsi (BPJS) in the coding of the data's *_38 columns (gold dimension wilayah): Papua is six provinces since the
    2022 split, each FKRTL claim of the sample is in exactly one province, and the ML scores carry the same provinces."""
    types = {t["display_name"]: t["id"] for t in auditor.get(f"{API}/api/ontology/object-types", timeout=60).json()}
    objs = lambda name: [o["properties"] for o in auditor.get(f"{API}/api/ontology/object-types/{types[name]}/objects",  # noqa: E731
                                                              params={"limit": 5000}, timeout=120).json()["objects"]]
    prov = {p["provinsi_kode"]: p for p in objs("Provinsi (BPJS)")}
    with_claims = {k: p for k, p in prov.items() if (p.get("klaim_fkrtl") or 0) > 0}
    assert len(with_claims) == 38, sorted(prov)
    assert sum(p["klaim_fkrtl"] for p in with_claims.values()) == 5_418_503
    papua = {k: prov[k]["provinsi"] for k in (91, 92, 94, 95, 96, 97)}
    assert papua == {91: "PAPUA BARAT", 92: "PAPUA BARAT DAYA", 94: "PAPUA", 95: "PAPUA SELATAN", 96: "PAPUA TENGAH", 97: "PAPUA PEGUNUNGAN"}, papua
    assert all(prov[k].get("lokasi") for k in papua)  # each new province on the map, at its capital
    kab = {k["kabkota"]: k["provinsi_kode"] for k in objs("Kabupaten/Kota (BPJS)") if k.get("kabkota") in ("MERAUKE", "KOTA SORONG", "MIMIKA", "JAYAWIJAYA")}
    assert kab == {"MERAUKE": 95, "KOTA SORONG": 92, "MIMIKA": 96, "JAYAWIJAYA": 97}, kab
    ml = {f.get("provinsi_kode") for f in objs("Risiko Faskes ML (BPJS)")}
    assert {92, 95, 96, 97} <= ml and ml <= set(with_claims), sorted(ml)
    print("\n38 provinsi: " + ", ".join(f"{v.title()} {prov[k]['klaim_fkrtl']:,}" for k, v in papua.items()) + " klaim")


def test_cloning_is_tagged_on_real_claims_outside_the_covid_scheme(auditor: requests.Session):  # noqa: F811
    r = auditor.get(f"{API}/api/aip/indikasi", params={"tag": "KLONING_KLAIM", "limit": 500}, timeout=300).json()
    assert r["total"] > 0
    # the tags that stand: the 13 the cloning rule put on COVID claims before it excluded the scheme stay in the ledger,
    # rejected by a person (2026-10-28), and count for nothing (indikasi.standing)
    claims = [t for t in r["tags"] if t["entitas"] == "klaim" and t.get("status") != "ditolak"]
    assert claims and not [t["kunci"] for t in claims if t["kunci"].startswith("covid:") or "ICC" in t["kunci"]]
    # the rule's own evidence says the bill is no package tariff; a tag an investigator also wrote shows that agent's
    # stronger evidence instead ("3 peserta berbeda … tanggal datang identik", engagement 24 Oct)
    rule_only = [t for t in claims if t["agen_pendukung"] == ["penanda_otomatis"]]
    assert rule_only and all("bukan tarif paket" in t["bukti"] for t in rule_only)
    print(f"\nKLONING_KLAIM: {r['total']} tag; contoh: {claims[0]['judul']} — {claims[0]['bukti'][:140]}")
