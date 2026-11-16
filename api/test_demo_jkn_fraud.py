"""Focused tests for demo_jkn_fraud (6 fraud pain points). Run: python -m pytest test_demo_jkn_fraud.py -q (from api/)."""
import tempfile
import time
from pathlib import Path

import demo_jkn_fraud as f

f.STORE_DIR = Path(tempfile.mkdtemp(prefix="jkn-fraud-test-"))  # isolasi persistensi test


def _get(path):
    # call endpoint functions directly (no live server needed)
    return {
        "/overview": f.overview, "/cases": f.cases, "/graph": f.graph,
        "/billing-checks": f.get_billing_checks, "/risk-scores": f.get_risk_scores,
        "/prepayment/queue": f.prepayment_queue, "/rules": f.get_rules,
    }[path]()


def test_p1_alert_becomes_case():
    cases = _get("/cases")["cases"]
    assert cases, "alert harus menjadi kasus"
    c = cases[0]
    for k in ("kronologi", "bukti", "relasi_jaringan", "rekomendasi", "estimasi_kerugian_rp", "sla_jam"):
        assert c[k], k
    assert f.case_detail(c["id"])["id"] == c["id"]


def test_p2_graph_finds_collusion_ring():
    g = _get("/graph")
    assert len(g["nodes"]) > 20 and len(g["edges"]) > 20
    assert any("Ring kolusi" in n["pola"] for n in g["networks"])


def test_p3_billing_covers_all_anomaly_types():
    kinds = {i["jenis"] for c in _get("/billing-checks")["checks"] for i in c["issues"]}
    assert {"duplicate_billing", "upcoding", "phantom_billing", "unnecessary_service",
            "unsupported_documentation", "over_tariff"} <= kinds, kinds


def test_p4_score_is_explainable_with_peer_benchmark():
    top = _get("/risk-scores")["scores"][0]
    assert top["skor"] > 50 and top["factors"], top
    assert all("penjelasan" in x for x in top["factors"])
    assert top["peer"]["peer_n"] >= 0


def test_p5_prepayment_lanes_and_screening():
    q = _get("/prepayment/queue")
    assert set(q["lanes"]) == {"otomatis", "review", "hold"}
    clean = f.screen(f.ScreenClaim())
    assert clean["keputusan"] in ("AUTO_APPROVE", "REVIEW")
    bad = f.screen(f.ScreenClaim(dokumen_lengkap=False, diagnosa="O80", prosedur="74.1", tarif_klaim=99_000_000))
    assert bad["keputusan"] == "HOLD" and bad["issues"] and bad["latensi_ms"] < 1000


def test_p6_versioned_rules_and_activation():
    r = _get("/rules")
    assert r["rules"] and all(x["versi_aktif"] for x in r["rules"])
    assert r["connectors"] and r["audit_trail"] and r["lineage"]
    out = f.activate_rule(f.ActivateRule(rule_id="R-04", versi="2.0.0"))
    assert out["ok"] and out["rule"]["versi_aktif"] == "2.0.0"
    f.activate_rule(f.ActivateRule(rule_id="R-04", versi="2.1.0"))  # restore


def test_pagination_and_graph_limit():
    page = f.cases(limit=2, offset=0)
    assert len(page["cases"]) == 2 and page["pagination"]["total"] > 2
    page2 = f.cases(limit=2, offset=2)
    assert page["cases"][0]["id"] != page2["cases"][0]["id"]
    assert len(f.get_billing_checks(limit=3)["checks"]) == 3
    assert len(f.get_risk_scores(limit=9999)["scores"]) <= 200  # limit di-clamp
    g = f.graph(max_edges=5)
    assert len(g["edges"]) == 5 and g["edges_total"] > 5


def test_tahap2_persistence_and_rule_lifecycle():
    cid = f.cases(limit=1)["cases"][0]["id"]
    out = f.case_decision(cid, f.CaseDecision(status="Eskalasi", catatan="uji"))
    assert out["case"]["status"] == "Eskalasi"
    assert (f.STORE_DIR / "store.json").exists(), "keputusan harus persisten ke store"
    f.case_decision(cid, f.CaseDecision(status="Dalam Investigasi"))
    f.rule_draft(f.RuleVersion(rule_id="R-11", versi="9.9.9", perubahan="uji lifecycle"))
    try:
        f.rule_approve(f.ActivateRule(rule_id="R-11", versi="9.9.9"))
        raise AssertionError("approve tanpa review harus ditolak")
    except Exception as e:
        assert "review" in str(e)
    f.rule_submit(f.ActivateRule(rule_id="R-11", versi="9.9.9"))
    assert f.rule_approve(f.ActivateRule(rule_id="R-11", versi="9.9.9"))["rule"]["versi_aktif"] == "9.9.9"
    f.activate_rule(f.ActivateRule(rule_id="R-11", versi="1.2.0"))  # restore


def test_tahap3_async_job_subgraph_benchmark():
    job = f.start_batch_job()
    for _ in range(50):
        if f.get_job(job["id"])["status"] == "selesai":
            break
        time.sleep(0.1)
    assert f.get_job(job["id"])["status"] == "selesai"
    assert f.get_materialized()["status"] == "ada"
    sub = f.subgraph("RS-02", depth=1)
    assert sub["pusat"] == "RS-02" and len(sub["nodes"]) < len(f.graph()["nodes"])
    bench = f.benchmark(iterasi=50)
    assert bench["lolos_target"] and bench["p95_ms"] < 300


def test_tahap4_feedback_metrics_decision_log_and_kc_filter():
    sep = f.get_billing_checks(limit=1)["checks"][0]["no_sep"]
    m = f.post_feedback(f.Feedback(no_sep=sep, verdict="legit"))["metrics"]
    assert m["false_positive"] >= 1
    assert f.get_decisions()["pagination"]["total"] >= 1  # screen() di test sebelumnya tercatat
    kota = f.cases(limit=50, kantor_cabang="KC Contoh Kota")["cases"]
    assert kota and all(c["kantor_cabang"] == "KC Contoh Kota" for c in kota)


def test_overview_covers_six_pain_points():
    ov = _get("/overview")
    assert [p["no"] for p in ov["pain_points"]] == [1, 2, 3, 4, 5, 6]
    assert ov["kpi"]["kasus_investigasi"] > 0
