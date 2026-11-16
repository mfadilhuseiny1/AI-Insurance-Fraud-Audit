"""Grid Intelligence Nexus — semantic knowledge graph over the grid demo's Nexus ontology, served inside Vertex.

Nothing here invents ontology structure: schema nodes are the grid Object Types resolved by display name from the
live ontology, schema edges are the live Nexus link types between them (plus Transmission Line endpoint references,
which exist only as the `gardu_ujung_a/b` properties of the OSM line dataset and are flagged as property references,
not link types), actions come from the live action types, and functions are matched by the same published-function
shape Vertex itself uses. Instance nodes are real objects read as the caller (markings and object policies apply).

Semantic layer honesty: an Object Type's own ontology description is the only VERIFIED definition. The domain
definitions, business context, operational purpose, property meanings and edge-kind classification in this module are
curated interpretations written for this demo — every payload marks them `source: "interpretation"` next to the
verified ontology facts (`source: "ontology"`), and properties without a curated meaning are flagged unverified
instead of being given an invented one.
"""

from __future__ import annotations

import nexus_engine as ne

# the 16 Object Types the Grid Intelligence Nexus covers, by display name without the "(demo)" suffix
TARGETS = [
    "Grid Primary Substation", "Grid Feeder", "Grid Distribution Substation", "Grid Customer",
    "Grid Substation Energy Balance", "Grid Feeder Energy Balance", "Grid Loss Finding",
    "Grid Meter Inspection P2TL", "Grid Feeder Outage", "Titik Ukur SCADA Grid", "Grid Work Order",
    "Transmission Line West Java (OSM)", "Transmission Substation West Java (OSM)",
    "Industrial Estate West Java (OSM)", "Grid P2TL Field Visit", "Grid Field Crew",
]

# every other Grid-system Object Type in the ontology (the user asked for the whole PLN Grid system, not only the
# 16 core types): name patterns of the grid demo / OSM transmission corpus, minus Machinery log types and
# test/manual duplicates. Core TARGETS above always win their curated category.
EXTRA_PREFIXES = ("Grid ", "Titik Ukur SCADA", "AMI Event", "Substation Sensor", "Network Interconnection",
                  "Transmission ", "Substation Java-Bali Combined", "Power Plant ")


def _extra_category(name: str) -> str:
    if any(k in name for k in ("Transmission", "Substation Java-Bali Combined", "Power Plant", "Network Interconnection")):
        return "Transmission (OSM, real)"
    if any(k in name for k in ("AMI", "Sensor", "Titik Ukur SCADA")):
        return "Measurement & reliability"
    if any(k in name for k in ("Alarm", "Risk", "Loading", "Reliability", "N-1", "Hourly Balance")):
        return "Operations analytics"
    return "Distribution assets"


# presentation grouping only (NOT an ontology fact; the payload says so) — node colour by group
CATEGORY = {
    "Transmission Line West Java (OSM)": "Transmission (OSM, real)",
    "Transmission Substation West Java (OSM)": "Transmission (OSM, real)",
    "Industrial Estate West Java (OSM)": "Transmission (OSM, real)",
    "Grid Primary Substation": "Distribution assets",
    "Grid Feeder": "Distribution assets",
    "Grid Distribution Substation": "Distribution assets",
    "Grid Customer": "Distribution assets",
    "Grid Substation Energy Balance": "Energy & loss analytics",
    "Grid Feeder Energy Balance": "Energy & loss analytics",
    "Grid Loss Finding": "Energy & loss analytics",
    "Titik Ukur SCADA Grid": "Measurement & reliability",
    "Grid Feeder Outage": "Measurement & reliability",
    "Grid Meter Inspection P2TL": "Field operations",
    "Grid P2TL Field Visit": "Field operations",
    "Grid Field Crew": "Field operations",
    "Grid Work Order": "Field operations",
}
CATEGORY_COLOR = {
    "Transmission (OSM, real)": "#38bdf8",
    "Distribution assets": "#34d399",
    "Energy & loss analytics": "#f59e0b",
    "Measurement & reliability": "#f472b6",
    "Field operations": "#a78bfa",
    "Operations analytics": "#fb7185",
    "Functions": "#c084fc",
    "ML models": "#facc15",
}

# ------------------------------------------------------------------------------------------------
# curated Semantic Meaning Layer — INTERPRETATION, never presented as ontology fact
# ------------------------------------------------------------------------------------------------

SEMANTIC: dict[str, dict[str, str]] = {
    "Grid Primary Substation": {
        "definition": "A 150/20 kV primary substation (gardu induk): the interface between the transmission network and the 20 kV distribution feeders it supplies.",
        "business_context": "Its firm (N-1) capacity bounds how much load the feeders below it may carry; it aggregates the energy and customer counts of its whole supply area.",
        "operational_purpose": "Anchor for feeder topology, N-1 contingency checks and area-level loss and reliability rollups.",
    },
    "Grid Feeder": {
        "definition": "A 20 kV medium-voltage feeder (penyulang) radiating from a primary substation and supplying distribution substations and MV customers along its route.",
        "business_context": "The main accounting unit for energy balance: SCADA energy sent vs energy billed separates technical losses from non-technical losses per feeder.",
        "operational_purpose": "Thermal loading, outage/reliability (SAIDI/SAIFI) and loss analysis are tracked per feeder; findings and inspections roll up to it.",
    },
    "Grid Distribution Substation": {
        "definition": "A 20 kV/400 V distribution substation (gardu distribusi) with one distribution transformer supplying low-voltage customers in its service pocket.",
        "business_context": "Comparing transformer output (AMR) against billed customer energy exposes local losses; overload, oil temperature and end-voltage indicate asset stress.",
        "operational_purpose": "Primary inspection and remediation target: balancing, transformer uprating and LV reconductoring are simulated and ordered from here.",
    },
    "Grid Customer": {
        "definition": "An electricity customer (pelanggan) connected at low or medium voltage, identified by service ID, tariff class and contracted power.",
        "business_context": "Billed consumption versus peers and metering events drive the non-technical-loss suspicion score; identity fields stay behind PII markings.",
        "operational_purpose": "Subject of loss findings and P2TL inspections; a customer is inspected, never declared a thief by the model alone.",
    },
    "Grid Substation Energy Balance": {
        "definition": "Monthly energy balance of one distribution substation: energy out of the transformer vs energy billed to its customers, split into technical and non-technical loss.",
        "business_context": "This is where non-technical loss is measured as a residual: sent minus billed minus computed technical loss.",
        "operational_purpose": "Ranks substations by loss so field capacity is spent where recoverable energy is largest.",
    },
    "Grid Feeder Energy Balance": {
        "definition": "Monthly energy balance of one feeder: SCADA energy sent vs billed energy, conductor and transformer losses, and the non-technical residual.",
        "business_context": "Feeder-level balances allocate total network loss between feeders and feed the utility's quarterly loss reporting.",
        "operational_purpose": "Hotspot ranking per feeder and per service area (ULP) for loss-reduction programmes.",
    },
    "Grid Loss Finding": {
        "definition": "A loss finding (temuan susut): a scored suspicion — pattern code, rule evidence, estimated lost energy and expected recoverable value — attached to a customer, substation or feeder.",
        "business_context": "A finding is an investigation lead with an expected rupiah value, not proof; only a P2TL field inspection confirms or rejects it.",
        "operational_purpose": "Prioritised into field visits and technical work orders; confirmed findings become labelled training data for the ML scoring.",
    },
    "Grid Meter Inspection P2TL": {
        "definition": "A P2TL meter-inspection report (berita acara): the field verdict on one customer — violation class P-I..P-IV, back-billed energy and amount, or no violation.",
        "business_context": "The ground-truth label of the loss programme: it converts suspicion into billed recovery and measures inspection precision.",
        "operational_purpose": "Closes the loop on findings and visits, and supplies honest labels to evaluate and retrain the targeting model.",
    },
    "Grid Feeder Outage": {
        "definition": "A feeder outage event from SCADA sequence-of-events (trip of breaker/recloser): cause, duration, customers interrupted and energy not supplied.",
        "business_context": "Outages are the raw events behind SAIDI/SAIFI/MAIFI reliability indices reported for each feeder and service area.",
        "operational_purpose": "Reliability analysis, dominant-cause reduction and regulatory reporting.",
    },
    "Titik Ukur SCADA Grid": {
        "definition": "A SCADA measurement point on a feeder: the metering tag where feeder current/power/energy is measured in the control system.",
        "business_context": "These points are the measurement origin of feeder energy and loading figures; without them a feeder balance cannot be computed.",
        "operational_purpose": "Data-lineage anchor showing which physical measurement feeds each feeder's analytics.",
    },
    "Grid Work Order": {
        "definition": "A technical work order (perintah kerja) raised from a loss finding: load balancing, transformer uprating, LV reconductoring or similar corrective work.",
        "business_context": "Converts an analytical finding into funded field work with an estimated cost and target date.",
        "operational_purpose": "Tracked through Nexus actions (open, in progress, postponed, done) so execution is auditable from the finding.",
    },
    "Transmission Line West Java (OSM)": {
        "definition": "A real high-voltage transmission line segment in West Java mapped in OpenStreetMap (ODbL), with voltage class taken from OSM tags.",
        "business_context": "Real geographic context for the transmission network; OSM carries no conductor ratings or SCADA telemetry, so no electrical loading is claimed for it.",
        "operational_purpose": "Structural context and map backdrop. Its endpoint substations are stored as properties (gardu_ujung_a/b), not as Nexus link types.",
    },
    "Transmission Substation West Java (OSM)": {
        "definition": "A real transmission substation (GITET/GI) in West Java mapped in OpenStreetMap (ODbL).",
        "business_context": "The upstream supply point of the demo primary substations is linked to this real network context.",
        "operational_purpose": "Connects the fictional demo distribution network to the real transmission geography above it.",
    },
    "Industrial Estate West Java (OSM)": {
        "definition": "A real industrial estate in West Java mapped in OpenStreetMap (ODbL).",
        "business_context": "Industrial estates concentrate medium-voltage customers; the type is geographic context only — OSM holds no customers or cases for it.",
        "operational_purpose": "Map context for the industrial service area; it has no verified ontology relationship to the demo customer types.",
    },
    "Grid P2TL Field Visit": {
        "definition": "A scheduled P2TL field visit (kunjungan): one crew visiting one customer's meter because of one loss finding, in a planned time window.",
        "business_context": "Field capacity is scarce; visits are scheduled by expected recoverable value so inspections earn more than they cost.",
        "operational_purpose": "The operational bridge between an analytical finding and the inspection report that confirms or rejects it.",
    },
    "Grid Field Crew": {
        "definition": "A P2TL field crew (tim lapangan) of one service area (or the MV team of the UP3), the resource field visits are scheduled against.",
        "business_context": "Crew capacity and service-area assignment constrain how many findings can be inspected per period.",
        "operational_purpose": "Scheduling resource on the field-operations board; visits reference the crew by its code.",
    },
}

SEMANTIC.update({
    "Grid AMI Meter": {
        "definition": "A pilot AMI/AMR smart meter installed at a customer, reporting interval consumption to the head-end system.",
        "business_context": "Interval meter data is the evidence behind streaming non-technical-loss detection (bypass, magnet, CT shunt patterns).",
        "operational_purpose": "Links a customer to the streaming readings and tamper events analysed per hour.",
    },
    "AMI Event": {
        "definition": "A suspected bypass event raised by streaming AMI detection (hourly NTL score plus CUSUM change detection) on one meter.",
        "business_context": "A streaming suspicion is fast but weaker than an inspection; it prioritises which meters get visited first.",
        "operational_purpose": "Feeds the cockpit alarm centre through a Nexus action workflow (acknowledge, assign, resolve).",
    },
    "Grid AMI Meter Health": {
        "definition": "Per-meter health derived from the cleaned AMI stream: reporting status, power factor, tamper events and last reading.",
        "business_context": "Silent or tampered meters create unmeasured energy that lands in the non-technical-loss residual.",
        "operational_purpose": "Triage list for meter inspection and replacement.",
    },
    "Grid Substation Hourly Balance": {
        "definition": "Pilot meters' energy aggregated per distribution substation and hour, with the share of very-low-reading meters.",
        "business_context": "An hourly substation anomaly is the earliest streaming signal of a bypass cluster below that substation.",
        "operational_purpose": "Streaming anomaly watch per substation in the cockpit.",
    },
    "Substation Sensor": {
        "definition": "A sensor measuring a distribution substation's load (kVA) over time, streamed from the substation.",
        "business_context": "Measured transformer loading validates the computed technical-loss and overload picture.",
        "operational_purpose": "Streaming load monitoring and overload risk per substation.",
    },
    "Grid Operations Alarm": {
        "definition": "A unified operations alarm computed by the operations-analytics pipeline (load, voltage quality, N-1, technical/non-technical loss) on a grid asset.",
        "business_context": "Alarms turn analytics into dispatcher work with severity, threshold evidence and a recommendation.",
        "operational_purpose": "The cockpit alarm centre: acknowledge, assign and resolve through Nexus actions with full edit history.",
    },
    "Grid Operational Asset Risk": {
        "definition": "A deterministic rule-based risk score per distribution substation or feeder (load, oil temperature, age, end voltage, reliability, loss) with evidence and a recommended action.",
        "business_context": "Risk ranking decides which assets get inspected or reinforced before they fail or overload.",
        "operational_purpose": "Asset-risk register behind the cockpit risk page.",
    },
    "Grid Feeder Loading": {
        "definition": "Thermal loading of a feeder: peak current from hourly SCADA power against the conductor/breaker thermal limit, with I²R loss at peak.",
        "business_context": "Thermal headroom bounds load growth and transfer options between feeders.",
        "operational_purpose": "Loading watch and uprating/reconductoring planning per feeder.",
    },
    "Grid Monthly Feeder Reliability": {
        "definition": "Monthly IEEE 1366 reliability indices per feeder (SAIDI, SAIFI, MAIFI, CAIDI, ENS) aggregated from outage events.",
        "business_context": "These are the reliability figures the utility reports and is penalised or rewarded on.",
        "operational_purpose": "Reliability trend and dominant-cause analysis per feeder.",
    },
    "Grid Primary Substation N-1 Contingency": {
        "definition": "N-1 contingency assessment of a primary substation: coincident peak load versus firm capacity with one transformer out.",
        "business_context": "Firm capacity is the security limit for the whole supply area below the substation.",
        "operational_purpose": "Contingency watch: hours in violation, margin in MVA, and the recommended reinforcement.",
    },
    "Transmission Line Java-Bali Combined": {
        "definition": "All real OpenStreetMap transmission lines of Java-Bali merged without duplicates, with their endpoint substations as properties.",
        "business_context": "The full real transmission geography behind the structural (graph) N-1 analysis; no electrical ratings exist in OSM.",
        "operational_purpose": "Structural corridor and articulation analysis on the combined map.",
    },
    "Substation Java-Bali Combined": {
        "definition": "All real OpenStreetMap substations of Java-Bali merged without duplicates.",
        "business_context": "Endpoint nodes of the combined transmission lines and buses of the structural analysis.",
        "operational_purpose": "Structural topology analysis and map context.",
    },
    "Transmission Branch N-1": {
        "definition": "A structural corridor (branch) between two transmission buses derived from the OSM topology, flagged when its removal isolates buses (graph bridge).",
        "business_context": "A critical corridor is a single point of structural failure; the megawatts behind it quantify exposure, not a power-flow result.",
        "operational_purpose": "Structural N-1 screening of the real transmission network.",
    },
    "Transmission Bus": {
        "definition": "A structural node (substation or power plant) of the OSM transmission graph: corridor count, neighbours, critical corridors, articulation flag.",
        "business_context": "Articulation buses are where the real network splits if one corridor is lost.",
        "operational_purpose": "Structural vulnerability ranking of transmission nodes.",
    },
    "Network Interconnection": {
        "definition": "An interconnection tapped onto a combined transmission line, derived from the OSM topology.",
        "business_context": "Shows where networks interconnect along a corridor; geographic context only.",
        "operational_purpose": "Map and topology context for the combined transmission network.",
    },
    "Power Plant West Java (OSM)": {
        "definition": "A real power plant in West Java mapped in OpenStreetMap (ODbL).",
        "business_context": "Generation context for the transmission network; OSM records nameplate data only where mappers entered it.",
        "operational_purpose": "Map context; isolated megawatts in the structural N-1 analysis are counted at these plants.",
    },
})

# property meanings for the fields a grid operator actually reads — interpretation; anything else stays unverified
PROP_MEANING: dict[str, str] = {
    "kode_gi": "Primary substation code — the key every feeder, balance and contingency row joins on.",
    "kode_penyulang": "Feeder code — joins substations, customers, balances, outages and findings to their feeder.",
    "kode_dt": "Distribution substation code — joins customers, balances, sensors and findings to their substation.",
    "kode_ulp": "Service-area (ULP) code — the organisational unit that owns the asset and its loss figures.",
    "id_pelanggan": "Customer service ID — joins findings, inspections, visits and meters to one customer.",
    "id_temuan": "Loss-finding ID — joins visits and work orders back to the finding that caused them.",
    "kode_tim": "Field-crew code — joins a visit to the crew performing it.",
    "susut_pct": "Total loss as % of energy sent: (sent − billed) / sent.",
    "susut_teknis_pct": "Technical loss %: conductor I²R plus transformer iron/copper losses, computed from engineering parameters.",
    "susut_non_teknis_pct": "Non-technical loss %: the balance residual after technical loss — theft, metering and billing errors live here, unproven.",
    "kwh_kirim": "Energy sent into the feeder (SCADA), kWh.",
    "kwh_keluar": "Energy out of the distribution transformer (AMR), kWh.",
    "kwh_tagih": "Energy billed to customers, kWh.",
    "nilai_harapan_rp": "Expected recoverable value if the suspicion is confirmed: probability-weighted rupiah per month.",
    "skor": "Rule/ML suspicion score of the finding (higher = stronger evidence, still not proof).",
    "prioritas": "Investigation priority (P1 highest) from score and expected value.",
    "beban_puncak_pct": "Peak loading as % of transformer/feeder rating; above 100% is overload.",
    "jumlah_pelanggan": "Number of customers supplied.",
    "kapasitas_mva": "Installed transformer capacity of the primary substation, MVA.",
    "kelas_kv": "Voltage class in kV, from OSM tags for transmission assets.",
    "gardu_ujung_a": "OSM id of the substation at the line's from-end (a property reference, not a Nexus link type).",
    "gardu_ujung_b": "OSM id of the substation at the line's to-end (a property reference, not a Nexus link type).",
    "gitet_hulu_osm_id": "OSM id of the upstream EHV substation supplying this primary substation.",
}

# edge-kind classification rules — the ontology proves the link exists; the KIND is a presentation interpretation
EDGE_KINDS = ("physical_asset", "electrical_topology", "operational_dependency", "data_lineage", "logical")
_EDGE_KIND_BY_NAME = [
    ("Work order", "operational_dependency"), ("Field visit", "operational_dependency"),
    ("meter inspection", "operational_dependency"), ("Loss finding", "logical"), ("Feeder outage", "operational_dependency"),
    ("Operations alarm", "operational_dependency"), ("AMI event", "logical"), ("asset risk", "logical"),
    ("energy balance", "data_lineage"), ("SCADA measurement point", "data_lineage"), ("Hourly balance", "data_lineage"),
    ("thermal loading", "data_lineage"), ("monthly reliability", "data_lineage"), ("N-1 contingency", "data_lineage"),
    ("from primary substation", "electrical_topology"), ("on feeder", "electrical_topology"),
    ("on distribution substation", "electrical_topology"), ("supplied by", "electrical_topology"),
    ("Customer AMI meter", "physical_asset"), ("Substation sensor", "physical_asset"), ("at substation", "physical_asset"),
    ("from-end", "electrical_topology"), ("to-end", "electrical_topology"), ("from-bus", "electrical_topology"), ("to-bus", "electrical_topology"),
    ("connected bus", "electrical_topology"), ("tapped onto", "electrical_topology"), ("Bus of OSM", "physical_asset"),
    ("AMI meter health", "data_lineage"), ("AMI meter event", "logical"),
]


def _edge_kind(link_name: str) -> str:
    for needle, kind in _EDGE_KIND_BY_NAME:
        if needle.lower() in (link_name or "").lower():
            return kind
    return "logical"


# human semantic term per link, read in the link's direction (source —term→ target): a short verb phrase a grid
# operator would say out loud. The link itself is verified ontology structure; the wording is interpretation.
EDGE_TERMS: dict[str, str] = {
    "Feeder from primary substation (grid demo)": "powered by",
    "Customer on distribution substation (grid demo)": "belongs to",
    "Customer on feeder (grid demo)": "supplied by",
    "Distribution substation on feeder (grid demo)": "fed by",
    "Feeder energy balance (grid demo)": "measures loss of",
    "Substation energy balance (grid demo)": "measures loss of",
    "Loss finding at substation (grid demo)": "flagged at",
    "Loss finding for customer (grid demo)": "suspects",
    "Loss finding on feeder (grid demo)": "flagged on",
    "Feeder outage (grid demo)": "interrupts",
    "P2TL meter inspection of customer (grid demo)": "inspects",
    "Feeder SCADA measurement point (grid demo)": "measures",
    "Work order from loss finding (grid demo)": "raised from",
    "Work order at substation (grid demo)": "executed at",
    "Primary substation supplied by EHV substation (grid demo)": "powered by",
    "Field visit by crew (grid demo)": "performed by",
    "Field visit for loss finding (grid demo)": "follows up",
    "Field visit to customer (grid demo)": "visits",
    "Line endpoints at substation (West Java, grid demo)": "ends at",
    "Customer AMI meter (grid demo)": "meters", "Customer AMI event (grid demo)": "raised on", "AMI meter event (grid demo)": "detected by",
    "Substation sensor (grid demo)": "monitors", "Line from-end at substation (OSM combined)": "starts at",
    "Line to-end at substation (OSM combined)": "ends at", "Interconnection tapped onto line (OSM combined)": "taps",
    "Branch from-bus (OSM, analysis)": "from bus", "Branch to-bus (OSM, analysis)": "to bus", "Bus of OSM substation": "models",
    "Operations alarm on feeder (grid demo)": "alarms on", "Feeder thermal loading (grid demo)": "loads",
    "Operations alarm at substation (grid demo)": "alarms on", "Substation asset risk (grid demo)": "rates risk of",
    "Feeder monthly reliability (grid demo)": "measures reliability of", "Feeder asset risk (grid demo)": "rates risk of",
    "Primary substation N-1 contingency (grid demo)": "secures", "Branch ↔ connected bus (OSM, analysis)": "connects",
    "AMI meter health of customer (grid demo)": "serves", "Hourly balance of substation (grid demo)": "measures",
    "AMI meter health of meter (grid demo)": "health of",
}


def _edge_term(link_name: str) -> str:
    return EDGE_TERMS.get(link_name or "", "related to")


# natural-language search intents — deterministic keyword scoring over the curated semantic layer (interpretation)
INTENTS = [
    {"q": "non-technical loss", "terms": ["non-technical", "non technical", "ntl", "susut non-teknis", "susut non teknis", "theft", "pencurian"],
     "types": ["Grid Substation Energy Balance", "Grid Feeder Energy Balance", "Grid Loss Finding", "Grid Customer", "Grid Meter Inspection P2TL"],
     "answer": "Non-technical loss is the residual of the energy balances (sent − billed − technical loss). It is measured on Grid Substation Energy Balance and Grid Feeder Energy Balance, scored into Grid Loss Finding objects on customers/substations/feeders, and only proven by a Grid Meter Inspection P2TL."},
    {"q": "feeder and customer", "terms": ["feeder and customer", "feeder and a customer", "relationship between a feeder", "customer on a feeder", "hubungan penyulang dan pelanggan", "feeder customer"],
     "types": ["Grid Feeder", "Grid Customer", "Grid Distribution Substation"],
     "answer": "A Grid Customer hangs on a feeder two ways in the ontology: directly (Customer on feeder, foreign key kode_penyulang) and through its distribution substation (Customer on distribution substation via kode_dt, substation on feeder via kode_penyulang)."},
    {"q": "technical loss", "terms": ["technical loss", "susut teknis", "i2r", "conductor loss"],
     "types": ["Grid Feeder Energy Balance", "Grid Substation Energy Balance", "Grid Distribution Substation"],
     "answer": "Technical loss is computed, not measured: conductor I²R and transformer iron/copper losses inside the feeder and substation energy balances, simulated per substation by simulasi_perbaikan_teknis."},
    {"q": "inspection", "terms": ["inspection", "p2tl", "field visit", "inspect", "inspeksi", "kunjungan"],
     "types": ["Grid Meter Inspection P2TL", "Grid P2TL Field Visit", "Grid Field Crew", "Grid Loss Finding", "Grid Customer"],
     "answer": "A Grid Loss Finding becomes a Grid P2TL Field Visit performed by a Grid Field Crew at a Grid Customer; the visit results in a Grid Meter Inspection P2TL report, the programme's ground-truth label."},
    {"q": "outage reliability", "terms": ["outage", "reliability", "saidi", "saifi", "gangguan", "padam"],
     "types": ["Grid Feeder Outage", "Grid Feeder"],
     "answer": "Grid Feeder Outage events (SCADA trips) belong to a Grid Feeder and are the raw events behind its SAIDI/SAIFI reliability figures."},
    {"q": "transmission", "terms": ["transmission", "osm", "150 kv", "500 kv", "gardu induk supplied", "upstream"],
     "types": ["Transmission Line West Java (OSM)", "Transmission Substation West Java (OSM)", "Grid Primary Substation"],
     "answer": "The demo primary substation links upstream to a real Transmission Substation West Java (OSM). Transmission lines reference their endpoint substations only as properties (gardu_ujung_a/b) — the ontology defines no link type for them among these types."},
    {"q": "work order", "terms": ["work order", "perintah kerja", "remediation", "uprating", "balancing"],
     "types": ["Grid Work Order", "Grid Loss Finding", "Grid Distribution Substation"],
     "answer": "A Grid Work Order is raised from a Grid Loss Finding and executed at a Grid Distribution Substation (balancing, uprating, reconductoring), tracked by Nexus actions."},
    {"q": "measurement", "terms": ["scada", "measurement", "titik ukur", "metering point", "sensor"],
     "types": ["Titik Ukur SCADA Grid", "Grid Feeder"],
     "answer": "Titik Ukur SCADA Grid points measure a Grid Feeder (foreign key kode_penyulang); they are the data-lineage origin of feeder energy and loading analytics."},
]


def configure(data_dir) -> None:  # noqa: ANN001 - kept for server.py; no state of its own
    return None


def _line_endpoints(types: dict[str, dict], edges: list[dict]) -> list[dict]:
    """Transmission Line endpoints: real references in the data, but properties — not Nexus link types. Once a real
    link type joins the two types it replaces this reference."""
    line, subst = types.get("Transmission Line West Java (OSM)"), types.get("Transmission Substation West Java (OSM)")
    if not line or not subst or any({e["source"], e["target"]} == {line["id"], subst["id"]} for e in edges):
        return []
    return [{"id": "propref:gardu_ujung", "name": "Line endpoints at substation (property reference)", "term": "ends at", "term_source": "interpretation",
             "kind": "property_reference", "edge_kind": "electrical_topology", "edge_kind_source": "interpretation",
             "link_kind": "property", "cardinality": "many_to_one", "foreign_key": "gardu_ujung_a / gardu_ujung_b",
             "source": line["id"], "target": subst["id"], "source_name": "Transmission Line West Java (OSM)",
             "target_name": "Transmission Substation West Java (OSM)", "source_api": "saluranTransmisiJabar",
             "target_api": "garduTransmisiJabar", "ontology_description": "", "verified": False}]


DOMAIN = ne.Domain(
    key="grid-nexus", name="Grid Intelligence Nexus", targets=TARGETS, extra_prefixes=EXTRA_PREFIXES,
    category=CATEGORY, extra_category=_extra_category, category_color=CATEGORY_COLOR, semantic=SEMANTIC,
    prop_meaning=PROP_MEANING, edge_terms=EDGE_TERMS, edge_kind_rules=_EDGE_KIND_BY_NAME, intents=INTENTS,
    models=[ne.ModelSpec(project="PLN Grid Project", target="Grid Customer", main_prefix="model_ntl_pelanggan",
                         state_file="demo-grid-e2e/state.json",
                         note="Registered under PLN Grid Project/ml and associated with Grid Customer by the demo's NTL scoring experiment and "
                              "benchmark contract; the deployed model scores customers, the benchmark models were evaluated as candidates for the same task.")],
    hierarchy_start="Grid Primary Substation", extra_edges=_line_endpoints,
)
router = ne.make_router(DOMAIN, "/api/grid-nexus")
