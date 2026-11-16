"""JKN Intelligence Nexus — the semantic knowledge graph of the JKN healthcare-audit demo, inside Vertex
(/vertex/jkn-intelligence-nexus, API /api/jkn-nexus). Same engine and honesty rules as the Grid Intelligence Nexus
(nexus_engine): live object types, link types, actions, functions and registered models are verified facts; the
definitions, property meanings, link terms, edge kinds and search answers below are curated interpretation.
"""

from __future__ import annotations

import nexus_engine as ne

# the core JKN Object Types, by display name without the "(demo)" suffix
TARGETS = [
    "Wilayah JKN", "Kantor Cabang JKN", "Faskes Audit JKN", "RS Jejaring IoT JKN", "Faskes JKN",
    "Dokter Audit JKN", "Klaim JKN", "Tarif INA-CBG", "Tindakan Penunjang Diklaim JKN",
    "Kasus Rujukan Berisiko JKN", "Peringatan Risiko JKN", "Temuan Aturan JKN", "Temuan Risiko JKN", "Kategori Risiko JKN",
    "Alat Medis IoT JKN", "Temuan IoT JKN", "Jadwal Audit Klaim", "Verifikator JKN",
]

CATEGORY = {
    "Wilayah JKN": "Facilities & network", "Kantor Cabang JKN": "Facilities & network", "Faskes Audit JKN": "Facilities & network",
    "RS Jejaring IoT JKN": "Facilities & network", "Faskes JKN": "Facilities & network",
    "Dokter Audit JKN": "Clinicians",
    "Klaim JKN": "Claims & tariffs", "Tarif INA-CBG": "Claims & tariffs", "Tindakan Penunjang Diklaim JKN": "Claims & tariffs",
    "Kasus Rujukan Berisiko JKN": "Risk & findings", "Peringatan Risiko JKN": "Risk & findings", "Temuan Aturan JKN": "Risk & findings",
    "Temuan Risiko JKN": "Risk & findings", "Kategori Risiko JKN": "Risk & findings",
    "Alat Medis IoT JKN": "IoT evidence", "Temuan IoT JKN": "IoT evidence",
    "Jadwal Audit Klaim": "Audit operations", "Verifikator JKN": "Audit operations",
}
CATEGORY_COLOR = {
    "Facilities & network": "#38bdf8", "Clinicians": "#34d399", "Claims & tariffs": "#f59e0b", "Risk & findings": "#fb7185",
    "IoT evidence": "#f472b6", "Audit operations": "#a78bfa", "Other JKN": "#94a3b8", "Functions": "#c084fc", "ML models": "#facc15",
}


def _extra_category(name: str) -> str:
    if "Faskes" in name or "RS " in name:
        return "Facilities & network"
    return "Other JKN"


SEMANTIC: dict[str, dict[str, str]] = {
    "Wilayah JKN": {
        "definition": "A monitoring region of the JKN programme at one level of the hierarchy — national, regional deputy (kedeputian), province or regency/city — with its IoT coverage and monitored-claim totals.",
        "business_context": "Regions roll up hospital coverage and unsupported-claim value so the audit effort can be steered from national to local level.",
        "operational_purpose": "Drill-down path of the national IoT monitoring map: nation → kedeputian → province → regency/city → hospital.",
    },
    "Kantor Cabang JKN": {
        "definition": "A BPJS Kesehatan branch office (kantor cabang) responsible for the facilities and claim verification in its area.",
        "business_context": "Verification capacity and audit accountability are organised per branch office.",
        "operational_purpose": "Groups facilities and verifiers; audit schedules are allocated within a branch.",
    },
    "Faskes Audit JKN": {
        "definition": "A healthcare facility (faskes) under JKN audit: location, type and tier, audit status, risk score, main indication, claim value, potential loss and recovery.",
        "business_context": "The audit's central object: claims, referral cases, doctors, IoT devices and findings all converge on the facility that bills them.",
        "operational_purpose": "Audit status workflow (healthy → monitoring → fraud indication → investigation → audited), escalation and recovery recording through Nexus actions.",
    },
    "RS Jejaring IoT JKN": {
        "definition": "A JKN partner hospital in the national IoT monitoring network: devices installed and metered, data completeness, 14-day claims versus device usage, IoT risk score.",
        "business_context": "Device-usage evidence lets the programme check claimed procedures against physical machine activity at national scale.",
        "operational_purpose": "Monitoring status per hospital and the entry point to its IoT findings; linked to the audited facility record where one exists.",
    },
    "Faskes JKN": {
        "definition": "A healthcare facility (primary FKTP or referral FKRTL) of the claims-verification case, with ownership and branch office.",
        "business_context": "The billing party of a claim; referrals between facilities are the paths along which referral fraud travels.",
        "operational_purpose": "Anchor of claims, rule findings and the referral network between facilities.",
    },
    "Dokter Audit JKN": {
        "definition": "A doctor practising at an audited facility, with their role in risky referral cases and claims (referrer, DPJP) and an ensemble anomaly score.",
        "business_context": "Unusual practice patterns (self-referral, upcoding, phantom procedures) are clinician-level signals; a score is a lead for clarification, never a verdict.",
        "operational_purpose": "Clarification requests through Nexus actions; ranked by the doctor-anomaly model.",
    },
    "Klaim JKN": {
        "definition": "A JKN claim per SEP (eligibility letter): patient, facility, stay, diagnosis and procedure, INA-CBG code and tariff, hospital tariff, verification status and risk category.",
        "business_context": "The unit of payment and of most fraud schemes; INA-CBG grouping and tariff difference determine what is paid.",
        "operational_purpose": "Verification workflow (status changes, tariff correction), alerts and rule findings attach to the claim.",
    },
    "Tarif INA-CBG": {
        "definition": "The base INA-CBG tariff per case group and care class, with case weight and average length of stay.",
        "business_context": "The reference price a claim is paid against; upcoding moves a case to a more expensive group.",
        "operational_purpose": "Reference for tariff correction and upcoding detection.",
    },
    "Tindakan Penunjang Diklaim JKN": {
        "definition": "One supporting procedure line (X-ray, CT, ultrasound, haemodialysis) claimed by a pilot facility, with the requesting doctor and a reconciliation key to device usage.",
        "business_context": "Each claimed procedure should correspond to a machine actually running; lines without matching device activity are unsupported claims.",
        "operational_purpose": "Reconciled per facility × device type × day into IoT findings.",
    },
    "Kasus Rujukan Berisiko JKN": {
        "definition": "A risky referral or claim case between two facilities (inappropriate referral, self-referral, upcoding, phantom billing …) with the referring doctor and the DPJP.",
        "business_context": "Referral fraud spans two facilities and two doctors; the case binds them into one investigable unit.",
        "operational_purpose": "Follow-up workflow through Nexus actions; feeds the facility's audit indication.",
    },
    "Peringatan Risiko JKN": {
        "definition": "A risk alert (event) on one claim indicating one of the 20 facility-risk subcategories, with a severity level.",
        "business_context": "Alerts are the early, automated signal; danger-level alerts mark fictitious or copied claims.",
        "operational_purpose": "Triage queue for verifiers on the claim.",
    },
    "Temuan Aturan JKN": {
        "definition": "A finding raised by a business rule (one alert per rule-output row), linked to the claim it concerns.",
        "business_context": "Deterministic rules encode known fraud patterns; their findings are explainable by the rule itself.",
        "operational_purpose": "Rule evidence on the claim alongside model scores.",
    },
    "Temuan Risiko JKN": {
        "definition": "A risk finding on a facility in one of the 20 risk subcategories, with a risk value, reference and reason.",
        "business_context": "Aggregates evidence per facility and category — the basis of the facility's risk profile.",
        "operational_purpose": "Facility risk profile and audit prioritisation.",
    },
    "Kategori Risiko JKN": {
        "definition": "One of the 20 subcategories of Efisiensi Risiko pada Fasilitas Kesehatan (facility-risk efficiency taxonomy).",
        "business_context": "The shared vocabulary that alerts, findings and audit schedules are classified by.",
        "operational_purpose": "Classification axis for reporting and audit allocation.",
    },
    "Alat Medis IoT JKN": {
        "definition": "A medical device at a pilot facility with an IoT power meter: power time series, standby/active thresholds, estimated procedures from machine cycles, operating status.",
        "business_context": "Physical evidence of how many procedures a machine could have performed, independent of what was claimed.",
        "operational_purpose": "Source of estimated procedure counts; device problems (no data, off) are tracked by a status workflow.",
    },
    "Temuan IoT JKN": {
        "definition": "One facility × device type × day where claimed procedures do not match device usage measured by the IoT meter (exceeds usage, device off, no meter).",
        "business_context": "Quantifies unsupported claims in rupiah with the device evidence attached — strong but still subject to verification.",
        "operational_purpose": "Verification workflow and correction value; rolls up to hospital and region.",
    },
    "Jadwal Audit Klaim": {
        "definition": "A scheduled audit / field verification of one risky claim, allocated to a verifier by dynamic scheduling.",
        "business_context": "Verifier time is scarce; schedules match expertise and facility type to the riskiest claims.",
        "operational_purpose": "Audit calendar per verifier; saved through a Nexus action.",
    },
    "Verifikator JKN": {
        "definition": "A claim verifier of a branch office, with expertise by facility type.",
        "business_context": "The human decision-maker who confirms or rejects a suspicion.",
        "operational_purpose": "Scheduling resource for claim audits.",
    },
    "Faskes JKN – deret waktu": {
        "definition": "A facility with daily claim and tariff-difference time series (illustrative).",
        "business_context": "Trends over time reveal sudden billing changes at a facility.",
        "operational_purpose": "Time-series context for the facility.",
    },
}

PROP_MEANING: dict[str, str] = {
    "no_sep": "SEP number — the eligibility letter that identifies one claim; joins alerts, rule findings and audits to the claim.",
    "kode_inacbg": "INA-CBG case-group code the claim is paid under.",
    "tarif_inacbg": "Tariff paid for the INA-CBG group.",
    "tarif_rs": "The hospital's own tariff — the difference to INA-CBG is a financial signal.",
    "kategori_risiko": "Code of one of the 20 facility-risk subcategories.",
    "status_verifikasi": "Verification status of the claim (workflow state).",
    "kode_faskes": "Facility code — joins devices, claimed procedures and IoT findings to the facility.",
    "faskes": "Facility code of the claim / finding.",
    "faskes_asal": "Referring (origin) facility of the case.",
    "faskes_tujuan": "Receiving (destination) facility of the case.",
    "dokter_perujuk": "Referring doctor of the case.",
    "dokter_dpjp": "Doctor in charge (DPJP) of the case at the receiving facility.",
    "id_dokter": "Doctor ID — joins claimed procedures and cases to the doctor.",
    "skor_risiko": "Facility risk score (higher = more audit priority).",
    "status_audit": "Audit status of the facility (workflow state).",
    "potensi_kerugian_rp": "Estimated potential loss to the programme, rupiah.",
    "pengembalian_rp": "Amount recovered after audit, rupiah.",
    "skor_anomali": "Doctor anomaly score from the ensemble model — a lead, not proof.",
    "estimasi_tindakan_alat": "Procedures the device could have performed according to its metered cycles.",
    "klaim_tindakan": "Procedures claimed for the device type that day.",
    "tindakan_tak_didukung": "Claimed procedures not supported by device usage.",
    "nilai_tak_didukung_rp": "Value of unsupported claimed procedures, rupiah.",
    "id_kabkota": "Regency/city code — joins hospitals and IoT findings to the region.",
    "induk": "Parent region in the monitoring hierarchy.",
    "kantor_cabang": "Branch office responsible for the facility / verifier / audit.",
    "id_verifikator": "Verifier allocated to the audit.",
    "id_rekon": "Reconciliation key: facility × device type × day, joining claimed procedure lines to the IoT finding.",
    "id_alat_utama": "Main device of the IoT finding.",
    "kode_faskes_audit": "The audited-facility record the network hospital corresponds to.",
}

EDGE_TERMS: dict[str, str] = {
    "Klaim di faskes (demo)": "billed by", "Peringatan untuk klaim (demo)": "flags", "Temuan aturan untuk klaim (demo)": "flags",
    "Audit oleh verifikator (demo)": "assigned to", "Rujukan antar faskes (demo)": "refers to", "Faskes di kantor cabang (demo)": "served by",
    "Temuan per kategori (demo)": "classified as", "Audit per kategori (demo)": "classified as", "Temuan di faskes (demo)": "found at",
    "Kasus ke faskes (demo)": "referred to", "DPJP kasus (demo)": "treated by", "Kasus dari faskes (demo)": "referred from",
    "Dokter perujuk kasus (demo)": "referred by", "Dokter praktik di faskes (demo)": "practises at", "Klaim JKN di faskes audit (demo)": "billed by",
    "Tindakan diklaim pada temuan IoT (demo)": "reconciled in", "Temuan IoT pada alat (demo)": "measured on", "Alat medis IoT di faskes (demo)": "installed at",
    "Tindakan penunjang oleh dokter (demo)": "requested by", "Temuan IoT di faskes (demo)": "found at", "Wilayah induk (demo)": "part of",
    "RS di kabupaten/kota (demo)": "located in", "RS jejaring = faskes audit (demo)": "same as", "Temuan IoT di RS jejaring (demo)": "found at",
    "Alat di RS jejaring (demo)": "installed at", "Temuan IoT di kabupaten/kota (demo)": "located in",
    "Klaim dibayar per tarif INA-CBG (demo)": "paid at", "Deret waktu faskes (demo)": "trend of",
}

# five edge kinds shared with the grid; the JKN page labels them (organisation & geography, evidence, …)
EDGE_KIND_RULES = [
    ("Alat medis IoT di faskes", "physical_asset"), ("Alat di RS jejaring", "physical_asset"),
    ("kantor cabang", "electrical_topology"), ("Wilayah induk", "electrical_topology"), ("kabupaten/kota", "electrical_topology"),
    ("RS jejaring = faskes audit", "electrical_topology"), ("Dokter praktik", "electrical_topology"), ("Rujukan antar faskes", "electrical_topology"),
    ("verifikator", "operational_dependency"), ("Audit per kategori", "operational_dependency"), ("Kasus", "operational_dependency"),
    ("DPJP", "operational_dependency"), ("Dokter perujuk", "operational_dependency"),
    ("Tindakan diklaim pada temuan IoT", "data_lineage"), ("Temuan IoT pada alat", "data_lineage"), ("Tindakan penunjang oleh dokter", "data_lineage"),
    ("Klaim di faskes", "data_lineage"), ("Klaim JKN di faskes audit", "data_lineage"),
    ("tarif INA-CBG", "data_lineage"), ("Deret waktu faskes", "data_lineage"),
]

INTENTS = [
    {"q": "fraud indication", "terms": ["fraud", "kecurangan", "indikasi", "upcoding", "phantom", "fiktif", "risk"],
     "types": ["Faskes Audit JKN", "Klaim JKN", "Kasus Rujukan Berisiko JKN", "Peringatan Risiko JKN", "Temuan Risiko JKN", "Kategori Risiko JKN"],
     "answer": "Fraud indication converges on Faskes Audit JKN: claims (Klaim JKN) carry risk alerts and rule findings, risky referral cases (Kasus Rujukan Berisiko JKN) bind two facilities and two doctors, and Temuan Risiko JKN classify evidence into the 20 Kategori Risiko JKN subcategories."},
    {"q": "referral", "terms": ["referral", "rujukan", "refer", "self-referral", "dpjp", "perujuk"],
     "types": ["Kasus Rujukan Berisiko JKN", "Faskes Audit JKN", "Dokter Audit JKN", "Faskes JKN"],
     "answer": "A Kasus Rujukan Berisiko JKN is referred from one Faskes Audit JKN to another, by a referring Dokter Audit JKN and treated by a DPJP; Faskes JKN carries the referral network between facilities (many-to-many)."},
    {"q": "iot evidence", "terms": ["iot", "device", "alat", "meter", "usage", "pemakaian", "unsupported", "tak didukung"],
     "types": ["Alat Medis IoT JKN", "Temuan IoT JKN", "Tindakan Penunjang Diklaim JKN", "RS Jejaring IoT JKN", "Faskes Audit JKN"],
     "answer": "Claimed supporting procedures (Tindakan Penunjang Diklaim JKN) are reconciled per facility × device type × day against IoT-metered device usage (Alat Medis IoT JKN); mismatches become Temuan IoT JKN at the hospital (RS Jejaring IoT JKN) and its audited facility."},
    {"q": "doctor anomaly", "terms": ["doctor", "dokter", "anomaly", "anomali", "clinician"],
     "types": ["Dokter Audit JKN", "Kasus Rujukan Berisiko JKN", "Tindakan Penunjang Diklaim JKN", "Faskes Audit JKN"],
     "answer": "Dokter Audit JKN practise at a Faskes Audit JKN, appear as referrer or DPJP in risky cases and request claimed procedures; the doctor-anomaly ensemble model scores them for clarification, never as a verdict."},
    {"q": "audit scheduling", "terms": ["audit", "schedule", "jadwal", "verifier", "verifikator", "verification"],
     "types": ["Jadwal Audit Klaim", "Verifikator JKN", "Kategori Risiko JKN", "Klaim JKN"],
     "answer": "Jadwal Audit Klaim assigns a risky claim, classified by Kategori Risiko JKN, to a Verifikator JKN of the branch office by dynamic scheduling."},
    {"q": "region", "terms": ["region", "wilayah", "province", "provinsi", "kabupaten", "national", "nasional", "kedeputian"],
     "types": ["Wilayah JKN", "RS Jejaring IoT JKN", "Temuan IoT JKN"],
     "answer": "Wilayah JKN forms the monitoring hierarchy (nation → kedeputian → province → regency/city); RS Jejaring IoT JKN and Temuan IoT JKN are located in a regency/city, so coverage and unsupported-claim value roll up the hierarchy."},
    {"q": "tariff", "terms": ["tariff", "tarif", "ina-cbg", "inacbg", "payment", "price"],
     "types": ["Klaim JKN", "Tarif INA-CBG"],
     "answer": "Klaim JKN is paid at a Tarif INA-CBG (link Klaim dibayar per tarif INA-CBG, foreign key kode_dasar_inacbg = the INA-CBG code without its severity suffix); the tariff holds the base price per care class, so upcoding shows as a claim moved to a more expensive group or severity."},
]

DOMAIN = ne.Domain(
    key="jkn-nexus", name="JKN Intelligence Nexus", targets=TARGETS, contains=(" JKN",), category=CATEGORY,
    extra_category=_extra_category, category_color=CATEGORY_COLOR, semantic=SEMANTIC, prop_meaning=PROP_MEANING,
    edge_terms=EDGE_TERMS, edge_kind_rules=EDGE_KIND_RULES, intents=INTENTS, hierarchy_start="Wilayah JKN",
    models=[
        ne.ModelSpec(project="JKN Healthcare System Intelligence", target="Dokter Audit JKN", main_prefix="model_anomali_dokter",
                     state_file="demo-jkn-e2e/state.json",
                     note="Registered under JKN Healthcare System Intelligence/ml and associated with Dokter Audit JKN by the demo's doctor-anomaly "
                          "ensemble experiment (Isolation Forest, OC-SVM, LOF, KNN, ECOD, HBOS, autoencoder); its scores land on the doctors."),
        ne.ModelSpec(project="Audit Risiko Faskes JKN (demo)", target="Faskes Audit JKN", main_prefix="model_risiko_faskes (",
                     other_term="alternative for",
                     note="Registered under Audit Risiko Faskes JKN (demo)/models and associated with Faskes Audit JKN by the facility-risk "
                          "modeling objective; the repository, notebook and Model Studio versions are alternatives for the same task."),
    ],
)


def configure(data_dir) -> None:  # noqa: ANN001 - kept for server.py; no state of its own
    return None


router = ne.make_router(DOMAIN, "/api/jkn-nexus")
