"""Bluesand Orbis: the operational knowledge graph of the JKN demo — every table, model and reference it uses, as one graph.

Where the ai-jkn Knowledge Nexus draws a graph of medical literature, Orbis draws the operating picture of the JKN
audit demo (project "JKN Healthcare System Intelligence"):

- the platform resources, from Data Lineage: raw files, pipelines and code transforms, clean and ML datasets, the
  Nexus object types with their actions and functions, the model, time series syncs, Device and Machinery, Vertex
  graphs, maps, the Workshop cockpit and the OSDK application — with how data flows between them;
- every object of the demo's object types (facilities, doctors, cases, claims, medical devices, claimed procedures,
  IoT findings, network hospitals, regions, risk categories, …) and every link between them, read from the Nexus
  link types themselves (foreign keys and join tables), so the graph is the Nexus as it stands;
- shared values as concepts (facility type, branch office, specialty, device type, ICD-9-CM procedure, finding type,
  status), so objects that share one meet in the graph;
- the machine learning: the anomaly model, its experiment (parameters and AUROC), its eight detectors, the methods
  (LSA embeddings, ensemble voting, Shapley values), the claim features and which features make each flagged doctor
  unusual — and the published references each method comes from;
- the regulations and standards the screening rests on, and the decisions the audit team took through actions.

The graph payload follows the explorer's shape (meta, kinds, predicates, nodes, links, layers, stats) and is cached in
data/orbis/graph.json. Every node is also embedded (text: kind, label, description, attributes and its relations)
into the S3 Vectors index "orbis-1" of the vector bucket (AWS_S3_VECTOR_STORE_BUCKET_NAME), which backs semantic
search and the "Tanya Orbis" answers (retrieval, one hop of graph context, an LLM answer citing the nodes).

Mounted by server.py under /api/orbis.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import re
import threading
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

import ontology

log = logging.getLogger("bluesandai.orbis")

router = APIRouter(prefix="/api/orbis")

PROJECT = "JKN Healthcare System Intelligence"
INDEX = "orbis-1"
EMBED_MODEL = "baai/bge-m3"
DIMENSION = 1024
ANSWER_MODEL = "vertex/deepseek-ai/deepseek-v4.1-flash-maas"  # open model on Vertex AI (aip/models.py)
VERSION = "1.0"
TEXT_MAX = 1800

DIR: Path = Path("data") / "orbis"
_lock = threading.Lock()
_index_state: dict[str, Any] = {"state": "idle"}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "orbis"
    DIR.mkdir(parents=True, exist_ok=True)
    st = _read(DIR / "index.json", {})
    if st.get("state") == "running":  # interrupted by a restart
        st["state"] = "interrupted"
    _index_state.update(st or {"state": "idle"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(p: Path, default: Any) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write(p: Path, data: Any) -> None:
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
    tmp.replace(p)


# ------------------------------------------------------------------------------------------------
# curated knowledge: references, regulations, methods
# ------------------------------------------------------------------------------------------------

# (id, short label, citation, year, venue, link, what it is used for in the demo)
JOURNALS = [
    ("demeulemeester2025", "De Meulemeester dkk. (2025) — anomali tanpa label yang dapat dijelaskan",
     "De Meulemeester H. dkk. Explainable unsupervised anomaly detection for healthcare insurance data.", 2025,
     "BMC Medical Informatics and Decision Making 25:14", None,
     "Rancangan model anomali dokter: agregasi klaim per dokter, embedding kategori, ensembel detektor, nilai Shapley."),
    ("liu2008", "Liu, Ting & Zhou (2008) — Isolation Forest", "Liu F.T., Ting K.M., Zhou Z.-H. Isolation Forest.", 2008,
     "IEEE ICDM 2008, 413–422", "https://doi.org/10.1109/ICDM.2008.17", "Detektor Isolation Forest."),
    ("scholkopf2001", "Schölkopf dkk. (2001) — One-class SVM",
     "Schölkopf B., Platt J.C., Shawe-Taylor J., Smola A.J., Williamson R.C. Estimating the support of a high-dimensional distribution.",
     2001, "Neural Computation 13(7):1443–1471", "https://doi.org/10.1162/089976601750264965", "Detektor One-class SVM."),
    ("breunig2000", "Breunig dkk. (2000) — Local Outlier Factor",
     "Breunig M.M., Kriegel H.-P., Ng R.T., Sander J. LOF: identifying density-based local outliers.", 2000,
     "ACM SIGMOD 2000, 93–104", "https://doi.org/10.1145/342009.335388", "Detektor LOF."),
    ("ramaswamy2000", "Ramaswamy, Rastogi & Shim (2000) — outlier k-tetangga terdekat",
     "Ramaswamy S., Rastogi R., Shim K. Efficient algorithms for mining outliers from large data sets.", 2000,
     "ACM SIGMOD 2000, 427–438", "https://doi.org/10.1145/342009.335437", "Detektor KNN (jarak ke tetangga ke-k)."),
    ("li2022", "Li dkk. (2022) — ECOD", "Li Z., Zhao Y., Hu X., Botta N., Ionescu C., Chen G.H. ECOD: Unsupervised outlier detection using empirical cumulative distribution functions.",
     2022, "IEEE Transactions on Knowledge and Data Engineering", "https://doi.org/10.1109/TKDE.2022.3159580", "Detektor ECOD."),
    ("goldstein2012", "Goldstein & Dengel (2012) — HBOS",
     "Goldstein M., Dengel A. Histogram-based Outlier Score (HBOS): a fast unsupervised anomaly detection algorithm.", 2012,
     "KI-2012: Poster and Demo Track, 59–63", None, "Detektor HBOS."),
    ("hinton2006", "Hinton & Salakhutdinov (2006) — autoencoder",
     "Hinton G.E., Salakhutdinov R.R. Reducing the dimensionality of data with neural networks.", 2006,
     "Science 313(5786):504–507", "https://doi.org/10.1126/science.1127647", "Arsitektur autoencoder."),
    ("sakurada2014", "Sakurada & Yairi (2014) — deteksi anomali dengan autoencoder",
     "Sakurada M., Yairi T. Anomaly detection using autoencoders with nonlinear dimensionality reduction.", 2014,
     "MLSDA 2014", "https://doi.org/10.1145/2689746.2689747", "Detektor autoencoder (galat rekonstruksi sebagai skor)."),
    ("goodfellow2014", "Goodfellow dkk. (2014) — Generative Adversarial Nets",
     "Goodfellow I. dkk. Generative adversarial nets.", 2014, "NeurIPS 27", "https://arxiv.org/abs/1406.2661", "Dasar detektor GAN."),
    ("donahue2017", "Donahue, Krähenbühl & Darrell (2017) — BiGAN",
     "Donahue J., Krähenbühl P., Darrell T. Adversarial feature learning.", 2017, "ICLR 2017", "https://arxiv.org/abs/1605.09782",
     "Encoder BiGAN pada detektor GAN."),
    ("zenati2018", "Zenati dkk. (2018) — EGBAD", "Zenati H., Foo C.S., Lecouat B., Manek G., Chandrasekhar V.R. Efficient GAN-based anomaly detection.",
     2018, "arXiv:1802.06222", "https://arxiv.org/abs/1802.06222", "Skor anomali detektor GAN (BiGAN / EGBAD)."),
    ("deerwester1990", "Deerwester dkk. (1990) — Latent Semantic Analysis",
     "Deerwester S., Dumais S.T., Furnas G.W., Landauer T.K., Harshman R. Indexing by latent semantic analysis.", 1990,
     "Journal of the American Society for Information Science 41(6):391–407", None, "Embedding LSA variabel kategori (SVD peringkat 3)."),
    ("lundberg2017", "Lundberg & Lee (2017) — SHAP", "Lundberg S.M., Lee S.-I. A unified approach to interpreting model predictions.",
     2017, "NeurIPS 30", "https://arxiv.org/abs/1705.07874", "Alasan anomali per dokter (nilai Shapley per fitur)."),
    ("shapley1953", "Shapley (1953) — nilai Shapley", "Shapley L.S. A value for n-person games.", 1953,
     "Contributions to the Theory of Games II, 307–317", None, "Teori nilai Shapley di balik penjelasan."),
    ("chandola2009", "Chandola, Banerjee & Kumar (2009) — survei deteksi anomali",
     "Chandola V., Banerjee A., Kumar V. Anomaly detection: a survey.", 2009, "ACM Computing Surveys 41(3)",
     "https://doi.org/10.1145/1541880.1541882", "Kerangka umum deteksi anomali tanpa label dan ensembel."),
    ("hanley1982", "Hanley & McNeil (1982) — AUROC", "Hanley J.A., McNeil B.J. The meaning and use of the area under a receiver operating characteristic (ROC) curve.",
     1982, "Radiology 143(1):29–36", "https://doi.org/10.1148/radiology.143.1.7063747", "Metrik AUROC eksperimen terhadap kasus yang sudah diketahui."),
    ("joudaki2015", "Joudaki dkk. (2015) — data mining untuk fraud layanan kesehatan",
     "Joudaki H. dkk. Using data mining to detect health care fraud and abuse: a review of literature.", 2015,
     "Global Journal of Health Science 7(1):194–202", "https://doi.org/10.5539/gjhs.v7n1p194", "Konteks: pola fraud & metode deteksinya."),
    ("hart1992", "Hart (1992) — pemantauan beban alat non-intrusif",
     "Hart G.W. Nonintrusive appliance load monitoring.", 1992, "Proceedings of the IEEE 80(12):1870–1891",
     "https://doi.org/10.1109/5.192069", "Prinsip membaca pemakaian alat dari beban listrik (siklus, menit menyala, jam-mesin)."),
]

# (id, label, kind, description, link)
REGULATIONS = [
    ("uu40-2004", "UU No. 40 Tahun 2004 tentang SJSN", "Regulasi", "Undang-undang Sistem Jaminan Sosial Nasional, dasar Program JKN.", None),
    ("perpres82-2018", "Perpres No. 82 Tahun 2018 tentang Jaminan Kesehatan", "Regulasi",
     "Penyelenggaraan Jaminan Kesehatan, termasuk pencegahan kecurangan.", None),
    ("pmk16-2019", "Permenkes No. 16 Tahun 2019 — pencegahan & penanganan kecurangan (fraud) JKN", "Regulasi",
     "Pencegahan dan penanganan kecurangan (fraud) serta pengenaan sanksi administrasi dalam pelaksanaan Program JKN.", None),
    ("efisiensi-risiko", "Efisiensi Risiko pada Fasilitas Kesehatan (BPJS Kesehatan)", "Pedoman",
     "Daftar 20 subkategori risiko di fasilitas kesehatan yang menjadi aturan skrining demo.", None),
    ("ina-cbg", "INA-CBG — tarif paket rumah sakit", "Standar", "Pengelompokan kasus dan tarif paket yang dipakai klaim rumah sakit JKN.", None),
    ("icd10", "ICD-10 (WHO) — klasifikasi diagnosis", "Standar", "Kode diagnosis pada klaim.", None),
    ("icd9cm", "ICD-9-CM — klasifikasi tindakan", "Standar", "Kode tindakan / prosedur (mis. 87.44 foto thorax) pada klaim.", None),
    ("aspak", "ASPAK (Kemenkes) — register sarana, prasarana & alat kesehatan", "Sumber data",
     "Register alat kesehatan per faskes; dasar daftar alat yang dipasangi meter IoT.", None),
]

DETECTORS = [
    ("Isolation Forest", "skor_isolation_forest", "ensembel pohon (isolasi)", ["liu2008"]),
    ("One-class SVM", "skor_one_class_svm", "kernel (batas dukungan)", ["scholkopf2001"]),
    ("LOF", "skor_lof", "kepadatan lokal", ["breunig2000"]),
    ("KNN", "skor_knn", "jarak tetangga", ["ramaswamy2000"]),
    ("ECOD", "skor_ecod", "statistik (distribusi kumulatif empiris)", ["li2022"]),
    ("HBOS", "skor_hbos", "statistik (histogram)", ["goldstein2012"]),
    ("Autoencoder", "skor_autoencoder", "jaringan saraf (galat rekonstruksi)", ["hinton2006", "sakurada2014"]),
    ("GAN (BiGAN/EGBAD)", "skor_gan", "generatif adversarial", ["goodfellow2014", "donahue2017", "zenati2018"]),
]
METHODS = [
    ("lsa", "Embedding LSA variabel kategori", "SVD peringkat 3 dari matriks ko-okurensi kategori × klaim, dinormalisasi l2, dirata-rata per dokter.",
     ["deerwester1990"]),
    ("ensembel", "Ensembel & suara detektor", "Skor ensembel dari delapan detektor; suara = berapa detektor menaruh dokter di 10 % teratas.", ["chandola2009"]),
    ("shapley", "Nilai Shapley per fitur", "Kontribusi tiap fitur asli pada skor anomali dokter (permutasi, dijumlahkan kembali ke fitur).",
     ["lundberg2017", "shapley1953"]),
    ("auroc", "Evaluasi AUROC", "AUROC tiap detektor dan ensembel terhadap dokter yang sudah punya kasus aturan.", ["hanley1982"]),
    ("agregasi", "Agregasi klaim per dokter", "Jumlah, rata-rata, median, simpangan baku, minimum, maksimum tiap variabel numerik.", ["demeulemeester2025"]),
    ("beban-listrik", "Estimasi tindakan dari beban listrik alat", "Siklus (Rontgen/CT), menit menyala (USG), jam-mesin (hemodialisis) dari meter IoT.",
     ["hart1992"]),
    ("rekonsiliasi", "Rekonsiliasi klaim vs pemakaian alat", "Per faskes × jenis alat × hari: tindakan diklaim dibandingkan estimasi tindakan alat (+ toleransi).",
     []),
]

# ------------------------------------------------------------------------------------------------
# vocabulary: kinds and predicates
# ------------------------------------------------------------------------------------------------

PLATFORM_KINDS = {
    "raw": ("Berkas mentah", "#94a3b8", "Data & pipeline"),
    "dataset": ("Dataset", "#64748b", "Data & pipeline"),
    "pipeline": ("Pipeline", "#0ea5e9", "Data & pipeline"),
    "transform": ("Code transform", "#38bdf8", "Data & pipeline"),
    "ts_sync": ("Time series sync", "#22d3ee", "Data & pipeline"),
    "object_type": ("Tipe objek Nexus", "#f59e0b", "Nexus"),
    "action": ("Action", "#fbbf24", "Nexus"),
    "function": ("Function", "#facc15", "Nexus"),
    "model": ("Model ML", "#a855f7", "Machine learning"),
    "module": ("Workshop", "#10b981", "Aplikasi"),
    "vertex": ("Vertex graph", "#34d399", "Aplikasi"),
    "map": ("Peta", "#6ee7b7", "Aplikasi"),
    "osdk_app": ("Aplikasi OSDK", "#059669", "Aplikasi"),
    "machinery": ("Device and Machinery", "#2dd4bf", "Aplikasi"),
    "logic": ("AIP Logic", "#84cc16", "Aplikasi"),
    "automation": ("Automation", "#a3e635", "Aplikasi"),
    "page": ("Halaman aplikasi", "#047857", "Aplikasi"),
}
CURATED_KINDS = {
    "experiment": ("Eksperimen ML", "#c084fc", "Machine learning"),
    "detector": ("Detektor anomali", "#d946ef", "Machine learning"),
    "method": ("Metode", "#e879f9", "Machine learning"),
    "feature": ("Fitur ML", "#f0abfc", "Machine learning"),
    "journal": ("Jurnal rujukan", "#f43f5e", "Rujukan"),
    "regulation": ("Regulasi & standar", "#fb7185", "Rujukan"),
    "decision": ("Keputusan tim audit", "#ef4444", "Keputusan"),
}
# shared property values that become concepts: (object type, property, concept kind)
VALUE_PROPS = [
    ("Faskes Audit JKN (demo)", "jenis", "v:jenis_faskes"),
    ("Faskes Audit JKN (demo)", "kantor_cabang", "v:kantor_cabang"),
    ("Faskes Audit JKN (demo)", "status_audit", "v:status_audit"),
    ("Faskes Audit JKN (demo)", "indikasi_utama", "kategori"),
    ("Dokter Audit JKN (demo)", "spesialisasi", "v:spesialisasi"),
    ("Kasus Rujukan Berisiko JKN (demo)", "jenis_kasus", "kategori"),
    ("Kasus Rujukan Berisiko JKN (demo)", "status_kasus", "v:status_audit"),
    ("Alat Medis IoT JKN (demo)", "jenis_alat", "v:jenis_alat"),
    ("Tindakan Penunjang Diklaim JKN (demo)", "kode_icd9", "v:icd9"),
    ("Temuan IoT JKN (demo)", "jenis_temuan", "v:jenis_temuan"),
    ("Temuan IoT JKN (demo)", "jenis_alat", "v:jenis_alat"),
    ("RS Jejaring IoT JKN (demo)", "kantor_cabang", "v:kantor_cabang"),
    ("RS Jejaring IoT JKN (demo)", "status_pemantauan", "v:status_pemantauan"),
    ("Klaim JKN (demo)", "kategori_risiko", "kategori"),
    ("Klaim JKN (demo)", "diag_utama", "v:icd10"),
    ("Peringatan Risiko JKN (demo)", "kategori_risiko", "kategori"),
    ("Jadwal Audit Klaim (demo)", "kategori_risiko", "kategori"),
    ("Temuan Risiko JKN (demo)", "kategori", "kategori"),
    ("Verifikator JKN (demo)", "kantor_cabang", "v:kantor_cabang"),
    ("Faskes JKN (demo)", "kantor_cabang", "v:kantor_cabang"),
]
VALUE_KINDS = {
    "v:jenis_faskes": ("Jenis faskes", "#fde68a"),
    "v:kantor_cabang": ("Kantor cabang", "#fcd34d"),
    "v:status_audit": ("Status audit", "#fca5a5"),
    "v:spesialisasi": ("Spesialisasi dokter", "#bfdbfe"),
    "v:jenis_alat": ("Jenis alat medis", "#5eead4"),
    "v:icd9": ("Kode tindakan ICD-9-CM", "#99f6e4"),
    "v:icd10": ("Diagnosis ICD-10", "#c7d2fe"),
    "v:jenis_temuan": ("Jenis temuan IoT", "#a7f3d0"),
    "v:status_pemantauan": ("Status pemantauan RS", "#fecaca"),
}
TYPE_COLORS = {
    "Faskes Audit JKN (demo)": "#3b82f6", "Dokter Audit JKN (demo)": "#60a5fa", "Kasus Rujukan Berisiko JKN (demo)": "#f97316",
    "Kategori Risiko JKN (demo)": "#fb923c", "Alat Medis IoT JKN (demo)": "#14b8a6", "Tindakan Penunjang Diklaim JKN (demo)": "#5eead4",
    "Temuan IoT JKN (demo)": "#0d9488", "RS Jejaring IoT JKN (demo)": "#06b6d4", "Wilayah JKN (demo)": "#0891b2",
    "Klaim JKN (demo)": "#818cf8", "Faskes JKN (demo)": "#93c5fd", "Peringatan Risiko JKN (demo)": "#f87171", "Temuan Aturan JKN (demo)": "#fb7185",
    "Temuan Risiko JKN (demo)": "#fdba74", "Jadwal Audit Klaim (demo)": "#a5b4fc", "Verifikator JKN (demo)": "#c4b5fd",
    "Kantor Cabang JKN (demo)": "#fcd34d", "Faskes JKN – deret waktu (demo)": "#7dd3fc",
}
INSTANCE_GROUP = {
    "Alat Medis IoT JKN (demo)": "IoT", "Tindakan Penunjang Diklaim JKN (demo)": "IoT", "Temuan IoT JKN (demo)": "IoT",
    "RS Jejaring IoT JKN (demo)": "Jejaring nasional", "Wilayah JKN (demo)": "Jejaring nasional",
}
# many objects that matter when searched for: off when the explorer opens
HIDDEN_TYPES = {"Alat Medis IoT JKN (demo)", "Tindakan Penunjang Diklaim JKN (demo)", "Temuan IoT JKN (demo)", "Klaim JKN (demo)"}

PREDICATES: dict[str, tuple[str, str, str]] = {
    "flowsTo": ("mengalir ke", "#38bdf8", "Aliran data antar sumber daya platform (Data Lineage)."),
    "instanceOf": ("objek dari tipe", "#475569", "Objek Nexus → tipe objeknya."),
    "hasValue": ("bernilai", "#a3a3a3", "Objek → nilai bersama (jenis, status, kantor cabang, kode)."),
    "inCategory": ("termasuk kategori risiko", "#fb923c", "Objek → salah satu dari 20 subkategori risiko."),
    "usesDetector": ("memakai detektor", "#d946ef", "Model → detektor anomali dalam ensembelnya."),
    "usesMethod": ("memakai metode", "#e879f9", "Model / pipeline → metode."),
    "usesFeature": ("memakai fitur", "#f0abfc", "Model → fitur klaim per dokter."),
    "derivedFrom": ("diturunkan dari", "#94a3b8", "Fitur → dataset sumbernya."),
    "unusualOn": ("menyimpang pada", "#ef4444", "Dokter → fitur dengan kontribusi Shapley terbesar pada skor anomalinya."),
    "basedOn": ("berdasarkan rujukan", "#f43f5e", "Detektor / metode / model → publikasi asalnya."),
    "trains": ("melatih", "#c084fc", "Eksperimen → model."),
    "governs": ("mengatur", "#fb7185", "Regulasi / pedoman → konsep atau sumber daya yang diaturnya."),
    "measuredBy": ("diukur dengan", "#2dd4bf", "Jenis alat → metode estimasi pemakaian."),
    "performedWith": ("dikerjakan dengan alat", "#5eead4", "Kode tindakan ICD-9-CM → jenis alat."),
    "decidedOn": ("keputusan atas", "#ef4444", "Keputusan tim audit (lewat action) → objek yang diputuskan."),
    "reads": ("membaca", "#10b981", "Halaman aplikasi → tipe objek yang dipakainya."),
}


def _clean(name: str) -> str:
    return re.sub(r"\s*\((demo)\)\s*$", "", name).replace(" JKN", "").strip()


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:80] or "x"


def _fmt(v: Any) -> Optional[str]:
    if v in (None, "", "None", "nan", "[]", "{}"):
        return None
    if isinstance(v, float):
        return f"{v:,.0f}".replace(",", ".") if abs(v) >= 1000 else f"{v:g}"
    s = str(v)
    return s if len(s) <= 220 else s[:217] + "…"


SKIP_PROP = re.compile(r"(embedding|jalur|lokasi|latitude|longitude|resume)$", re.I)


# ------------------------------------------------------------------------------------------------
# build
# ------------------------------------------------------------------------------------------------


class _G:
    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.links: dict[tuple[str, str, str], dict] = {}
        self.kinds: dict[str, dict] = {}

    def kind(self, key: str, label: str, color: str, group: str) -> str:
        self.kinds.setdefault(key, {"label": label, "color": color, "group": group})
        return key

    def node(self, nid: str, kind: str, raw: str, label: str, **extra: Any) -> str:
        cur = self.nodes.get(nid)
        if cur:
            for k, v in extra.items():
                if v and not cur.get(k):
                    cur[k] = v
        else:
            self.nodes[nid] = {"id": nid, "kind": kind, "rawId": raw, "label": label, **{k: v for k, v in extra.items() if v}}
        return nid

    def link(self, s: str, t: str, p: str, **extra: Any) -> None:
        if s in self.nodes and t in self.nodes and s != t:
            self.links.setdefault((s, t, p), {"source": s, "target": t, "predicate": p, **{k: v for k, v in extra.items() if v}})


def _demo_types() -> list[dict]:
    out = []
    for t in ontology.list_object_types():
        nm = t["display_name"]
        if "(demo)" in nm and " log " not in nm and any(w in nm for w in ("JKN", "Faskes", "Klaim")):
            out.append(t)
    return out


def _platform(g: _G, types: list[dict]) -> dict[str, str]:
    """Lineage resources of the demo; returns object type id → its node id."""
    import lineage

    full = lineage.graph()
    saved = set()
    try:
        saved = set(lineage.get_graph("jknaudit")["nodes"])
    except Exception:  # noqa: BLE001
        pass
    tids = {t["id"] for t in types}
    keep = {}
    for n in full["nodes"]:
        nm = n.get("name") or ""
        if n["kind"] not in PLATFORM_KINDS and n["kind"] != "dataset":
            continue
        if n["kind"] == "object_type" and " log " in nm:  # Device and Machinery changelogs: shown on their process instead
            continue
        ok = n["id"] in saved or n.get("project") == PROJECT or (n["kind"] == "object_type" and n["id"].split(":", 1)[1] in tids) \
            or ("JKN" in nm and "demo" in nm.lower())
        if ok:
            keep[n["id"]] = n
    for nid, n in keep.items():
        kind = n["kind"]
        path = n.get("path") or []
        if kind == "dataset" and any(p.lower() in ("raw", "mentah") or p.lower().startswith("raw") for p in path):
            kind = "raw"
        label, color, group = PLATFORM_KINDS[kind]
        g.kind(f"p:{kind}", label, color, group)
        facts = [["Jenis", n.get("kind_label") or label]]
        if path:
            facts.append(["Lokasi", " / ".join(path)])
        for k, lab in (("subtitle", "Keterangan"), ("updated_at", "Diperbarui"), ("size", "Ukuran (byte)")):
            if n.get(k):
                facts.append([lab, str(n[k])])
        if (n.get("last_build") or {}).get("status"):
            facts.append(["Build terakhir", f"{n['last_build']['status']} · {n['last_build'].get('at') or ''}"])
        for s in n.get("schedules") or []:
            facts.append(["Jadwal", f"{s.get('name')} ({s.get('cron')})"])
        g.node(nid, f"p:{kind}", nid.split(":", 1)[-1][:24], n.get("name") or nid, facts=facts, url=n.get("link"),
               definition=n.get("description"))
    for e in full["edges"]:
        if e["from"] in keep and e["to"] in keep:
            g.link(e["from"], e["to"], "flowsTo", propertyLabel=e.get("label") or None)
    return {nid.split(":", 1)[1]: nid for nid, n in keep.items() if n["kind"] == "object_type"}


def _kategori_index(objs: dict[str, dict]) -> tuple[dict[str, str], list[tuple[str, str]]]:
    by_no: dict[str, str] = {}
    names: list[tuple[str, str]] = []
    for pk, o in objs.items():
        p = o.get("properties") or {}
        if p.get("no") not in (None, ""):
            by_no[str(p["no"]).strip()] = pk
        names.append((str(p.get("nama") or pk).lower(), pk))
    return by_no, names


def _match_kategori(v: str, by_no: dict[str, str], names: list[tuple[str, str]]) -> Optional[str]:
    m = re.match(r"^\s*(\d+)\.", v)
    if m and m.group(1) in by_no:
        return by_no[m.group(1)]
    low = re.sub(r"\s*\(.*?\)", "", v.lower()).strip()
    for nm, pk in names:
        if low and (low in nm or nm in low):
            return pk
    words = set(re.findall(r"[a-z]{4,}", low))
    best = max(names, key=lambda x: len(words & set(re.findall(r"[a-z]{4,}", x[0]))), default=None)
    if best and len(words & set(re.findall(r"[a-z]{4,}", best[0]))) >= 2:
        return best[1]
    return None


def build() -> dict:
    g = _G()
    types = _demo_types()
    by_name = {t["display_name"]: t for t in types}
    type_node = _platform(g, types)
    for k, (label, color, group) in CURATED_KINDS.items():
        g.kind(f"c:{k}", label, color, group)

    # objects of every demo object type
    objects: dict[str, dict[str, dict]] = {}
    for t in types:
        nm = t["display_name"]
        kind = g.kind(f"o:{t['api_name']}", _clean(nm), TYPE_COLORS.get(nm, "#93c5fd"), INSTANCE_GROUP.get(nm, "Operasional"))
        objs = ontology.stored_objects(t["id"])
        objects[t["id"]] = objs
        props = {p["api_name"]: p.get("display_name") or p["api_name"] for p in t.get("properties") or []}
        title = t.get("title_property") or t["primary_key"]
        for pk, o in objs.items():
            p = o.get("properties") or {}
            facts = []
            for k, v in p.items():
                if k == title or SKIP_PROP.search(k):
                    continue
                f = _fmt(v)
                if f is not None:
                    facts.append([props.get(k, k), f])
            nid = g.node(f"o:{t['id']}:{pk}", kind, str(pk), str(p.get(title) or pk), facts=facts[:24],
                         url=f"/object-explorer?type={t['id']}&pk={pk}")
            if t["id"] in type_node:
                g.link(nid, type_node[t["id"]], "instanceOf")
        if t["id"] in type_node:
            n = g.nodes[type_node[t["id"]]]
            n["definition"] = n.get("definition") or t.get("description")
            n.setdefault("facts", []).append(["Objek", str(len(objs))])

    # links between objects, from the Nexus link types
    import ontology_model as om

    tids = {t["id"] for t in types}
    for lt in om._all("link-types"):
        s_t, t_t = lt["source"]["object_type_id"], lt["target"]["object_type_id"]
        if s_t not in tids or t_t not in tids:
            continue
        pred = f"lt:{lt['id']}"
        label = _clean(lt["display_name"])
        PRED_EXTRA[pred] = (label, "#60a5fa", lt.get("description") or f"Link type Nexus: {by_id(types, s_t)} → {by_id(types, t_t)}.")
        try:
            pairs = om._pairs(lt)
        except Exception:  # noqa: BLE001
            log.exception("orbis: link type %s", lt["id"])
            continue
        for s, t in pairs:
            g.link(f"o:{s_t}:{s}", f"o:{t_t}:{t}", pred)

    # shared values as concepts; categories land on the risk category objects
    kat_t = by_name.get("Kategori Risiko JKN (demo)")
    by_no, kat_names = _kategori_index(objects.get(kat_t["id"], {})) if kat_t else ({}, [])
    unmatched: Counter = Counter()
    for tname, prop, vkind in VALUE_PROPS:
        t = by_name.get(tname)
        if not t:
            continue
        for pk, o in objects[t["id"]].items():
            v = (o.get("properties") or {}).get(prop)
            for part in ([x.strip() for x in str(v).split(",")] if vkind == "v:icd10" else [str(v).strip()]):
                if part in ("", "None", "nan", "-"):
                    continue
                src = f"o:{t['id']}:{pk}"
                if vkind == "kategori":
                    k = _match_kategori(part, by_no, kat_names) if kat_t else None
                    if k:
                        g.link(src, f"o:{kat_t['id']}:{k}", "inCategory")
                        continue
                    unmatched[part] += 1
                    vk = "v:indikasi"
                    VALUE_KINDS.setdefault(vk, ("Indikasi / jenis kasus", "#fed7aa"))
                else:
                    vk = vkind
                vlabel, vcolor = VALUE_KINDS[vk]
                g.kind(vk, vlabel, vcolor, "Konsep")
                vid = g.node(f"{vk}:{_slug(part)}", vk, part, part)
                g.link(src, vid, "hasValue", propertyLabel=prop)

    # IoT: device types, procedures and how use is measured
    import demo_jkn_iot as iot

    for jenis, spec in iot.JENIS.items():
        vid = g.node(f"v:jenis_alat:{_slug(jenis)}", g.kind("v:jenis_alat", *VALUE_KINDS["v:jenis_alat"], "Konsep"), jenis, jenis,
                     facts=[["Metode estimasi", spec["metode"]], ["Durasi per tindakan (menit)", str(spec["durasi"])],
                            ["Energi per tindakan (Wh)", str(spec["energi"]) if spec["energi"] else "—"],
                            ["Daya aktif (W)", str(spec["aktif"])], ["Kapasitas maks / hari", str(spec["maks"])],
                            ["Tarif acuan (Rp)", f"{spec['tarif']:,}".replace(",", ".")]])
        for kode, nama in spec["kode"]:
            cid = g.node(f"v:icd9:{_slug(kode)}", g.kind("v:icd9", *VALUE_KINDS["v:icd9"], "Konsep"), kode, f"{kode} {nama}")
            g.nodes[cid]["label"] = f"{kode} {nama}"
            g.link(cid, vid, "performedWith")
        g.node("c:method:beban-listrik", "c:method", "beban-listrik", "")  # placeholder, filled below
        g.link(vid, "c:method:beban-listrik", "measuredBy")

    # machine learning: experiment, model, detectors, methods, features, references
    for jid, short, cite, year, venue, url, use in JOURNALS:
        g.node(f"c:journal:{jid}", "c:journal", jid, short, definition=cite, url=url,
               facts=[["Tahun", str(year)], ["Terbit di", venue], ["Dipakai untuk", use]])
    for rid, label, cat, desc, url in REGULATIONS:
        g.node(f"c:regulation:{rid}", "c:regulation", rid, label, definition=desc, url=url, facts=[["Jenis", cat]])
    for mid, label, desc, refs in METHODS:
        n = g.node(f"c:method:{mid}", "c:method", mid, label, definition=desc)
        g.nodes[n].update(label=label, definition=desc)
        for r in refs:
            g.link(n, f"c:journal:{r}", "basedOn")
    st = _read(DIR.parent / "demo-jkn-e2e" / "state.json", {})
    model_node = next((nid for nid, n in g.nodes.items() if n["kind"] == "p:model"), None)
    if not model_node and (st.get("ml") or {}).get("model_id"):
        model_node = g.node(f"model:{st['ml']['model_id']}", g.kind("p:model", *PLATFORM_KINDS["model"]), st["ml"]["model_id"], "Model anomali dokter JKN")
    exp = st.get("ml_experiment") or {}
    if exp:
        metrics = {k: (v[-1]["value"] if isinstance(v, list) and v else v) for k, v in (exp.get("metrics") or {}).items() if "loss" not in k}
        facts = [[k, str(v)] for k, v in (exp.get("params") or {}).items()] + [[k, str(v)] for k, v in metrics.items()]
        e = g.node(f"c:experiment:{exp.get('id')}", "c:experiment", exp.get("id", ""), f"Eksperimen {exp.get('name', '')}", facts=facts,
                   definition="Pelatihan delapan detektor tanpa label pada profil klaim dokter; AUROC dicatat terhadap dokter yang sudah punya kasus aturan.")
        if model_node:
            g.link(e, model_node, "trains")
        g.link(e, "c:method:auroc", "usesMethod")
    if model_node:
        g.nodes[model_node]["definition"] = ("Ensembel delapan detektor anomali tanpa label atas profil klaim per dokter (statistik numerik + embedding "
                                             "LSA variabel kategori); menghasilkan skor ensembel, suara detektor, dan alasan Shapley.")
        g.link(model_node, "c:journal:demeulemeester2025", "basedOn")
        for mid in ("lsa", "ensembel", "shapley", "agregasi"):
            g.link(model_node, f"c:method:{mid}", "usesMethod")
    for name, col, family, refs in DETECTORS:
        d = g.node(f"c:detector:{col}", "c:detector", col, name, facts=[["Keluarga", family], ["Kolom skor", col]],
                   definition=f"Detektor anomali tanpa label ({family}) dalam ensembel model anomali dokter.")
        if model_node:
            g.link(model_node, d, "usesDetector")
        for r in refs:
            g.link(d, f"c:journal:{r}", "basedOn")
    import demo_jkn_ml_lib as lib

    klaim_ds = next((nid for nid, n in g.nodes.items() if n["kind"] in ("p:dataset",) and n["label"] == "klaim_sep_bersih"), None)
    for var in lib.NUMERIC + lib.CATEGORICAL + ["jumlah_klaim"]:
        how = ("numerik: " + ", ".join(lib.STATS)) if var in lib.NUMERIC else ("kategori: embedding LSA 3 dimensi" if var in lib.CATEGORICAL else "jumlah")
        f = g.node(f"c:feature:{var}", "c:feature", var, lib.LABELS.get(var, var), facts=[["Kolom", var], ["Bentuk fitur", how]])
        if model_node:
            g.link(model_node, f, "usesFeature")
        if klaim_ds:
            g.link(f, klaim_ds, "derivedFrom")
        if var in lib.CATEGORICAL:
            g.link(f, "c:method:lsa", "usesMethod")
    dok = by_name.get("Dokter Audit JKN (demo)")
    if dok:
        bases = sorted(lib.NUMERIC + lib.CATEGORICAL + ["jumlah_klaim"], key=len, reverse=True)
        for pk, o in objects[dok["id"]].items():
            try:
                reasons = json.loads((o.get("properties") or {}).get("alasan_anomali") or "[]")
            except (TypeError, ValueError):
                reasons = []
            for r in reasons[:4]:
                key = str(r.get("fitur") or "")
                base = next((b for b in bases if key == b or key.startswith(b + "_") or key.startswith("emb_" + b)), key)
                g.link(f"o:{dok['id']}:{pk}", f"c:feature:{base}", "unusualOn", propertyLabel=f"+{float(r.get('kontribusi') or 0):.3f}")

    # regulations and standards: what each one governs
    kat_nodes = [nid for nid in g.nodes if kat_t and nid.startswith(f"o:{kat_t['id']}:")]
    for nid in kat_nodes:
        g.link("c:regulation:efisiensi-risiko", nid, "governs")
    if kat_t and kat_t["id"] in type_node:
        g.link("c:regulation:pmk16-2019", type_node[kat_t["id"]], "governs")
    g.link("c:regulation:uu40-2004", "c:regulation:perpres82-2018", "governs")
    g.link("c:regulation:perpres82-2018", "c:regulation:pmk16-2019", "governs")
    g.link("c:regulation:pmk16-2019", "c:regulation:efisiensi-risiko", "governs")
    for nid, n in g.nodes.items():
        if n["kind"] == "v:icd9":
            g.link("c:regulation:icd9cm", nid, "governs")
        elif n["kind"] == "v:icd10":
            g.link("c:regulation:icd10", nid, "governs")
    alat_t = by_name.get("Alat Medis IoT JKN (demo)")
    if alat_t and alat_t["id"] in type_node:
        g.link("c:regulation:aspak", type_node[alat_t["id"]], "governs")
    klaim_t = by_name.get("Klaim JKN (demo)")
    if klaim_t and klaim_t["id"] in type_node:
        g.link("c:regulation:ina-cbg", type_node[klaim_t["id"]], "governs")
    g.link("c:method:rekonsiliasi", "c:method:beban-listrik", "usesMethod")
    for nid, n in g.nodes.items():
        if n["kind"] == "p:pipeline" and "IoT" in n["label"]:
            g.link(nid, "c:method:rekonsiliasi", "usesMethod")
    g.link("c:method:rekonsiliasi", "c:journal:joudaki2015", "basedOn")

    # the audit team's decisions (edits through actions)
    import ontology_edits

    for t in types:
        objs = objects[t["id"]]
        for pk, e in ontology_edits.layer(t["id"]).items():
            props = e.get("properties") or {}
            if not props:
                continue
            title = (objs.get(pk) or {}).get("properties", {}).get(t.get("title_property") or "") or pk
            at = max((v for v in (e.get("prop_at") or {}).values() if isinstance(v, str)), default=e.get("at") or "")
            d = g.node(f"c:decision:{t['id']}:{pk}", "c:decision", str(pk), f"Keputusan · {title}",
                       facts=[[k.replace("_", " "), _fmt(v) or "—"] for k, v in props.items()] + [["Waktu", str(at)]],
                       definition=f"Keputusan tim audit atas {_clean(t['display_name'])} {title}, diambil lewat action dan tercatat di riwayat edit.")
            g.link(d, f"o:{t['id']}:{pk}", "decidedOn")

    # the demo's own pages
    pages = [("audit", "Ruang Kerja Audit Faskes JKN", "/demo-jkn/audit",
              ["Faskes Audit JKN (demo)", "Dokter Audit JKN (demo)", "Kasus Rujukan Berisiko JKN (demo)", "Temuan IoT JKN (demo)",
               "RS Jejaring IoT JKN (demo)", "Wilayah JKN (demo)"]),
             ("ontologi", "Demo JKN — cara kerja (Nexus)", "/demo-jkn/ontologi", list(by_name)),
             ("orbis", "Bluesand Orbis", "/orbis", [])]
    g.kind("p:page", *PLATFORM_KINDS["page"])
    for pid, label, url, reads in pages:
        n = g.node(f"page:{pid}", "p:page", pid, label, url=url)
        for tn in reads:
            t = by_name.get(tn)
            if t and t["id"] in type_node:
                g.link(n, type_node[t["id"]], "reads")

    # drop placeholders that never got a label, count degrees
    for nid in [k for k, n in g.nodes.items() if not n["label"]]:
        g.nodes.pop(nid)
    links = [l for l in g.links.values() if l["source"] in g.nodes and l["target"] in g.nodes]
    deg: Counter = Counter()
    for l in links:
        deg[l["source"]] += 1
        deg[l["target"]] += 1
    nodes = []
    for nid, n in g.nodes.items():
        n["degree"] = deg[nid]
        nodes.append(n)
    preds = {**PREDICATES, **PRED_EXTRA}
    kind_counts = Counter(n["kind"] for n in nodes)
    payload = {
        "meta": {"title": "Bluesand Orbis", "subtitle": f"Graf pengetahuan operasional · {PROJECT}", "version": VERSION, "date": _now(),
                 "project": PROJECT, "index": INDEX, "embedding_model": EMBED_MODEL},
        "kinds": {k: v for k, v in g.kinds.items() if kind_counts.get(k)},
        "predicates": {k: {"label": a, "color": b, "desc": c} for k, (a, b, c) in preds.items()},
        "defaults": {"hiddenPredicates": ["instanceOf"],
                     "hiddenKinds": [f"o:{t['api_name']}" for t in types if t["display_name"] in HIDDEN_TYPES]},
        "nodes": nodes,
        "links": links,
        "layers": _layers(kind_counts, g.kinds),
        "stats": {"nodes": len(nodes), "links": len(links), "kinds": len(kind_counts), "generatedAt": _now(),
                  "unmatched_categories": dict(unmatched.most_common(12))},
    }
    with _lock:
        _write(DIR / "graph.json", payload)
        (DIR / "graph.json.gz").unlink(missing_ok=True)
    return payload["stats"]


PRED_EXTRA: dict[str, tuple[str, str, str]] = {}


def by_id(types: list[dict], tid: str) -> str:
    return next((_clean(t["display_name"]) for t in types if t["id"] == tid), tid)


LAYERS = [
    ("data", "Data mentah & pipeline", ["p:raw", "p:pipeline", "p:transform", "p:dataset", "p:ts_sync"],
     "Berkas mentah (klaim, layanan, keuangan, register ASPAK, meter IoT, ringkasan edge) dibersihkan dan diagregasi pipeline menjadi dataset bersih."),
    ("nexus", "Nexus: tipe objek, action, function", ["p:object_type", "p:action", "p:function"],
     "Dataset bersih mendasari tipe objek; action dan function bekerja di atasnya."),
    ("ops", "Objek operasional", None, "Faskes, dokter, kasus, klaim, alat medis, tindakan, temuan, RS jejaring, wilayah — dan link Nexus antar-objek."),
    ("ml", "Machine learning & rujukan", ["p:model", "c:experiment", "c:detector", "c:method", "c:feature", "c:journal"],
     "Model anomali dokter (8 detektor), eksperimen dan AUROC, fitur dan alasan Shapley, dengan jurnal asal tiap metode."),
    ("rules", "Aturan, regulasi & konsep", ["c:regulation"], "Regulasi, pedoman 20 subkategori risiko, standar kode, dan nilai bersama."),
    ("apps", "Keputusan & aplikasi", ["c:decision", "p:module", "p:vertex", "p:map", "p:osdk_app", "p:machinery", "p:page", "p:logic", "p:automation"],
     "Keputusan tim audit lewat action; Workshop, Vertex, peta, Device and Machinery, aplikasi OSDK, halaman demo."),
]


def _layers(counts: Counter, kinds: dict[str, dict]) -> list[dict]:
    out = []
    used: set[str] = set()
    for i, (key, name, ks, gist) in enumerate(LAYERS):
        if ks is None:
            ks = [k for k in counts if k.startswith("o:")]
        if key == "rules":
            ks = ks + [k for k in counts if k.startswith("v:")]
        used |= set(ks)
        out.append({"n": i + 1, "key": key, "name": name, "gist": gist,
                    "kinds": [{"kind": k, "label": kinds.get(k, {}).get("label", k), "count": counts.get(k, 0)} for k in ks if counts.get(k)]})
    return out


def _graph() -> dict:
    p = DIR / "graph.json"
    if not p.exists():
        build()
    return _read(p, {})


# ------------------------------------------------------------------------------------------------
# vector index orbis-1
# ------------------------------------------------------------------------------------------------


def node_text(n: dict, kinds: dict, nbrs: list[str]) -> str:
    parts = [f"{kinds.get(n['kind'], {}).get('label', n['kind'])}: {n['label']} ({n['rawId']})."]
    if n.get("definition"):
        parts.append(n["definition"])
    if n.get("facts"):
        parts.append("; ".join(f"{a}: {b}" for a, b in n["facts"][:18]))
    if nbrs:
        parts.append("Relasi: " + "; ".join(nbrs[:14]))
    return " ".join(parts)[:TEXT_MAX]


def _texts(data: dict) -> dict[str, str]:
    idx = {n["id"]: n for n in data["nodes"]}
    preds = data["predicates"]
    nb: dict[str, list[str]] = defaultdict(list)
    for l in data["links"]:
        if l["predicate"] == "instanceOf":
            continue
        p = preds.get(l["predicate"], {}).get("label", l["predicate"])
        s, t = idx.get(l["source"]), idx.get(l["target"])
        if s and t:
            nb[l["source"]].append(f"{p} {t['label']}")
            nb[l["target"]].append(f"{s['label']} {p}")
    return {n["id"]: node_text(n, data["kinds"], nb.get(n["id"], [])) for n in data["nodes"]}


def _s3v():
    import storage

    return storage.s3vectors()


def _bucket() -> str:
    import vectors

    return vectors._bucket()


def _ensure_index() -> None:
    import vectors

    s3v = _s3v()
    try:
        s3v.get_index(vectorBucketName=_bucket(), indexName=INDEX)
        return
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") not in ("NotFoundException", "ResourceNotFoundException", "NoSuchIndex"):
            raise
    s3v.create_index(vectorBucketName=_bucket(), indexName=INDEX, dataType="float32", dimension=DIMENSION, distanceMetric="cosine",
                     metadataConfiguration={"nonFilterableMetadataKeys": ["text", "label"]}, tags={vectors.MODEL_TAG: EMBED_MODEL})


def _save_state(**kw: Any) -> None:
    _index_state.update(kw)
    _write(DIR / "index.json", _index_state)


def _run_index(full: bool) -> None:
    import vectors

    try:
        _ensure_index()
        data = _graph()
        texts = _texts(data)
        manifest: dict[str, str] = {} if full else _read(DIR / "vectors.json", {})
        want = {nid: hashlib.sha256(t.encode("utf-8")).hexdigest()[:16] for nid, t in texts.items()}
        todo = [nid for nid, h in want.items() if manifest.get(nid) != h]
        gone = [nid for nid in manifest if nid not in want]
        kinds = {n["id"]: n["kind"] for n in data["nodes"]}
        labels = {n["id"]: n["label"] for n in data["nodes"]}
        _save_state(state="running", started_at=_now(), total=len(want), todo=len(todo), done=0, removed=0, cost_usd=0.0, error=None)
        cost = 0.0
        for i in range(0, len(todo), 256):
            batch = todo[i: i + 256]
            vecs, c = vectors.embed([texts[n] for n in batch], EMBED_MODEL, DIMENSION, "doc")
            cost += c
            vectors._put(INDEX, [{"key": n, "data": {"float32": v},
                                  "metadata": {"kind": kinds[n], "label": labels[n][:300], "text": texts[n]}} for n, v in zip(batch, vecs)])
            for n in batch:
                manifest[n] = want[n]
            _write(DIR / "vectors.json", manifest)
            _save_state(done=min(i + 256, len(todo)), cost_usd=round(cost, 6))
        if gone:
            vectors._delete_keys(INDEX, gone)
            for n in gone:
                manifest.pop(n, None)
            _write(DIR / "vectors.json", manifest)
        _save_state(state="done", finished_at=_now(), removed=len(gone), vectors=len(manifest))
    except Exception as e:  # noqa: BLE001
        log.exception("orbis: indexing failed")
        _save_state(state="failed", error=str(e)[:500], finished_at=_now())


def _embed_query(q: str) -> list[float]:
    import vectors

    vecs, _ = vectors.embed([q], EMBED_MODEL, DIMENSION, "query")
    return vecs[0]


def search_nodes(q: str, k: int = 12, kind: Optional[str] = None) -> list[dict]:
    kwargs: dict[str, Any] = {"vectorBucketName": _bucket(), "indexName": INDEX, "queryVector": {"float32": _embed_query(q)},
                              "topK": max(1, min(k, 50)), "returnDistance": True, "returnMetadata": True}
    if kind:
        kwargs["filter"] = {"kind": {"$eq": kind}}
    try:
        hits = _s3v().query_vectors(**kwargs).get("vectors", [])
    except ClientError as e:
        raise HTTPException(502, f"pencarian vector gagal: {e.response.get('Error', {}).get('Message', e)}")
    return [{"id": h["key"], "score": round(1 - float(h.get("distance") or 0), 4), "label": (h.get("metadata") or {}).get("label"),
             "kind": (h.get("metadata") or {}).get("kind")} for h in hits]


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


@router.get("/graph")
def graph(request: Request) -> Response:
    """The graph payload (several MB of JSON), sent gzip-compressed when the browser accepts it."""
    p = DIR / "graph.json"
    if not p.exists():
        build()
    gz = DIR / "graph.json.gz"
    with _lock:
        if not gz.exists() or gz.stat().st_mtime < p.stat().st_mtime:
            gz.write_bytes(gzip.compress(p.read_bytes(), 6))
    if "gzip" in request.headers.get("accept-encoding", ""):
        return Response(gz.read_bytes(), media_type="application/json", headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"})
    return Response(p.read_bytes(), media_type="application/json", headers={"Cache-Control": "no-store"})


_build_state: dict[str, Any] = {"state": "idle"}


def _run_build() -> None:
    try:
        _build_state.update(state="running", started_at=_now(), error=None)
        _build_state.update(state="done", finished_at=_now(), stats=build())
    except Exception as e:  # noqa: BLE001
        log.exception("orbis: build failed")
        _build_state.update(state="failed", error=str(e)[:500], finished_at=_now())


@router.post("/build")
def rebuild() -> dict:
    """Rebuild the graph from the platform in the background (the lineage scan takes a few minutes); the cached graph is
    served meanwhile."""
    if _build_state.get("state") != "running":
        threading.Thread(target=_run_build, daemon=True, name="orbis-build").start()
        _build_state.update(state="running", started_at=_now())
    return dict(_build_state)


@router.get("/build")
def build_status() -> dict:
    return dict(_build_state)


@router.get("/index")
def index_status() -> dict:
    out = dict(_index_state)
    out.update(index=INDEX, bucket=_bucket(), model=EMBED_MODEL, dimension=DIMENSION, vectors=len(_read(DIR / "vectors.json", {})))
    return out


class IndexIn(BaseModel):
    full: bool = False


@router.post("/index")
def start_index(body: IndexIn) -> dict:
    if _index_state.get("state") == "running":
        raise HTTPException(409, "indeks orbis-1 sedang dibangun")
    _save_state(state="running", started_at=_now(), done=0, todo=None, error=None)
    threading.Thread(target=_run_index, args=(body.full,), daemon=True, name="orbis-index").start()
    return index_status()


class SearchIn(BaseModel):
    q: str
    k: int = Field(12, ge=1, le=50)
    kind: Optional[str] = None


def _visible_to_caller(node_id: str) -> bool:
    """A search hit the caller may know of: a Files item they can access (as Data Lineage hides the others), an object
    their object policies let them read. The index is built once for everyone, so hits are checked per caller."""
    import auth
    import db
    import ontology

    if not auth.enabled():
        return True
    kind, _, ref = node_id.partition(":")
    parts = ref.split(":")
    try:
        if ref and ":" not in ref and db.drive_get(ref):
            return auth.can_access(ref)
        if kind == "o" and len(parts) == 2:
            ontology.get_object(parts[0], parts[1])
        elif kind == "c" and len(parts) == 3:  # a node about one object (a decision, a journal entry)
            ontology.get_object(parts[1], parts[2])
    except HTTPException:
        return False
    return True


@router.post("/search")
def search(body: SearchIn) -> dict:
    q = body.q.strip()[:1000]
    if not q:
        raise HTTPException(400, "isi pertanyaan atau kata kunci")
    t0 = time.time()
    # more than asked, then only what the caller may see (restricted callers still get up to k hits)
    hits = [h for h in search_nodes(q, min(50, body.k * 3), body.kind) if _visible_to_caller(h["id"])][: body.k]
    return {"hits": hits, "ms": int((time.time() - t0) * 1000)}


class AskIn(BaseModel):
    q: str
    # the conversation this question continues (its earlier turns are read from the database); none starts a new one
    conversation_id: Optional[str] = None
    history: list[dict] = []


SYSTEM = """Anda adalah Orbis, asisten graf pengetahuan operasional demo audit JKN (BluesandAI).
Jawab dalam bahasa Indonesia, ringkas dan tepat, HANYA berdasarkan simpul dan relasi graf yang diberikan.
Rujuk setiap fakta dengan nomor simpul dalam kurung siku, mis. [3] atau [3][7]. Jika graf tidak memuat jawabannya, katakan
demikian dan sebutkan simpul terdekat yang relevan. Jangan mengarang angka, nama, atau rujukan. Data demo ini fiktif."""


@router.post("/ask")
def ask(body: AskIn) -> dict:
    import pipeline_ai

    q = body.q.strip()[:1500]
    if not q:
        raise HTTPException(400, "isi pertanyaan")
    t0 = time.time()
    data = _graph()
    idx = {n["id"]: n for n in data["nodes"]}
    conv = _conversation_for(body.conversation_id, q)
    history = _history(conv["id"]) if conv else body.history
    hits = [h for h in search_nodes(q, 10) if h["id"] in idx]
    if history:
        # a follow-up ("that facility", "its doctors") is also searched with the previous turn, so what it refers to is found
        prev = " ".join(str(m.get("content"))[:400] for m in history[-2:])
        seen = {h["id"] for h in hits}
        hits += [h for h in search_nodes(f"{q} {prev}"[:1500], 8) if h["id"] in idx and h["id"] not in seen]
    seeds = [h["id"] for h in hits]
    # one hop of context around the hits, most connected first
    adj: dict[str, list[dict]] = defaultdict(list)
    seedset = set(seeds)
    for l in data["links"]:
        if l["predicate"] == "instanceOf":
            continue
        if l["source"] in seedset or l["target"] in seedset:
            adj[l["source"]].append(l)
            adj[l["target"]].append(l)
    ctx_ids: list[str] = list(seeds)
    edges: list[dict] = []
    for s in seeds:
        for l in sorted(adj.get(s, []), key=lambda l: -(idx.get(l["target"] if l["source"] == s else l["source"], {}).get("degree", 0)))[:8]:
            o = l["target"] if l["source"] == s else l["source"]
            if o not in ctx_ids:
                ctx_ids.append(o)
            edges.append(l)
    ctx_ids = ctx_ids[:40]
    num = {nid: i + 1 for i, nid in enumerate(ctx_ids)}
    lines = []
    for nid in ctx_ids:
        n = idx[nid]
        kl = data["kinds"].get(n["kind"], {}).get("label", n["kind"])
        facts = "; ".join(f"{a}: {b}" for a, b in (n.get("facts") or [])[:10])
        lines.append(f"[{num[nid]}] {kl} — {n['label']}" + (f". {n['definition']}" if n.get("definition") else "") + (f". {facts}" if facts else ""))
    rel = []
    for l in edges:
        if l["source"] in num and l["target"] in num:
            p = data["predicates"].get(l["predicate"], {}).get("label", l["predicate"])
            rel.append(f"[{num[l['source']]}] {p} [{num[l['target']]}]" + (f" ({l['propertyLabel']})" if l.get("propertyLabel") else ""))
    hist = "\n".join(f"{m.get('role')}: {str(m.get('content'))[:600]}" for m in history[-6:])
    user = (f"Percakapan sebelumnya:\n{hist}\n\n" if hist else "") + f"Pertanyaan: {q}\n\nSIMPUL:\n" + "\n".join(lines) + \
        "\n\nRELASI:\n" + "\n".join(rel[:120])
    if conv:
        _add_message(conv["id"], "user", q)
    try:
        answer = pipeline_ai.chat(ANSWER_MODEL, SYSTEM, user, temperature=0.1, max_tokens=1400)
    except Exception as e:  # noqa: BLE001
        msg = f"model jawaban gagal: {str(e)[:300]}"
        if conv:
            _add_message(conv["id"], "assistant", "", error=msg)
        raise HTTPException(502, msg)
    cited = sorted({int(x) for x in re.findall(r"\[(\d+)\]", str(answer)) if 0 < int(x) <= len(ctx_ids)})
    sub_nodes = set(ctx_ids)
    out = {
        "answer": str(answer).strip(),
        "refs": [{"n": num[nid], "id": nid, "label": idx[nid]["label"], "kind": idx[nid]["kind"]} for nid in ctx_ids],
        "cited": [ctx_ids[i - 1] for i in cited],
        "hits": hits,
        "subgraph": {"nodeIds": ctx_ids, "edges": [{"s": l["source"], "p": l["predicate"], "t": l["target"]} for l in edges
                                                   if l["source"] in sub_nodes and l["target"] in sub_nodes]},
        "ms": int((time.time() - t0) * 1000),
    }
    if conv:
        out["message_id"] = _add_message(conv["id"], "assistant", out["answer"], result={k: v for k, v in out.items() if k != "answer"})
        out["conversation_id"] = conv["id"]
        out["title"] = conv["title"]
    return out


# ------------------------------------------------------------------------------------------------
# chat history: conversations and messages in PostgreSQL, per user
# ------------------------------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS orbis_conversations (
    id          text PRIMARY KEY,
    user_id     text NOT NULL,
    title       text NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS orbis_conversations_user ON orbis_conversations (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS orbis_messages (
    id               text PRIMARY KEY,
    conversation_id  text NOT NULL REFERENCES orbis_conversations(id) ON DELETE CASCADE,
    role             text NOT NULL,
    content          text NOT NULL,
    result           jsonb,
    error            text,
    created_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS orbis_messages_conversation ON orbis_messages (conversation_id, created_at);
"""
_schema_ready = False


def _db(required: bool = True):
    """The platform database with Orbis' tables (created on first use); None without one unless required."""
    global _schema_ready
    import db

    if not db.enabled():
        if required:
            raise HTTPException(503, "riwayat chat memerlukan database PostgreSQL (BLUESANDAI_DATABASE_URL)")
        return None
    if not _schema_ready:
        with db._connect() as conn:
            conn.execute(SCHEMA)
        _schema_ready = True
    return db


def _user() -> str:
    import auth

    return str((auth.current() or {}).get("id") or "system")


def _iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, datetime) else v


def _new_id(prefix: str, *parts: str) -> str:
    return prefix + hashlib.sha1("|".join([*parts, str(time.time_ns())]).encode()).hexdigest()[:16]


def _conversation_for(cid: Optional[str], q: str) -> Optional[dict]:
    """The caller's conversation, or a new one titled after its first question; None without a database."""
    db = _db(required=False)
    if db is None:
        return None
    now = datetime.now(timezone.utc)
    with db._connect() as conn:
        if cid:
            row = conn.execute("SELECT id, title FROM orbis_conversations WHERE id = %s AND user_id = %s", (cid, _user())).fetchone()
            if not row:
                raise HTTPException(404, "percakapan tidak ditemukan")
            return {"id": row[0], "title": row[1]}
        new = {"id": _new_id("oc-", _user(), q), "title": re.sub(r"\s+", " ", q).strip()[:90]}
        conn.execute("INSERT INTO orbis_conversations (id, user_id, title, created_at, updated_at) VALUES (%s, %s, %s, %s, %s)",
                     (new["id"], _user(), new["title"], now, now))
        return new


def _history(cid: str) -> list[dict]:
    """The conversation's last turns, oldest first, for the model's context."""
    db = _db()
    with db._connect() as conn:
        rows = conn.execute("SELECT role, content FROM orbis_messages WHERE conversation_id = %s AND error IS NULL ORDER BY created_at DESC LIMIT 6",
                            (cid,)).fetchall()
    return [{"role": r[0], "content": r[1]} for r in reversed(rows)]


def _add_message(cid: str, role: str, content: str, result: Optional[dict] = None, error: Optional[str] = None) -> str:
    from psycopg.types.json import Jsonb

    db = _db()
    now = datetime.now(timezone.utc)
    mid = _new_id("om-", cid, role)
    with db._connect() as conn:
        conn.execute("INSERT INTO orbis_messages (id, conversation_id, role, content, result, error, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                     (mid, cid, role, content, Jsonb(result) if result is not None else None, error, now))
        conn.execute("UPDATE orbis_conversations SET updated_at = %s WHERE id = %s", (now, cid))
    return mid


@router.get("/conversations")
def conversations(q: str = "", limit: int = 100, grid: bool = False) -> list[dict]:
    """The caller's conversations, latest first; q searches titles and messages."""
    db = _db()
    where, params = "c.user_id = %s", [_user()]
    if not grid:
        where += " AND c.title NOT LIKE '[Grid] %%'"  # the grid graph's conversations (orbis_grid.py)
    if q.strip():
        where += " AND (c.title ILIKE %s OR EXISTS (SELECT 1 FROM orbis_messages m2 WHERE m2.conversation_id = c.id AND m2.content ILIKE %s))"
        params += [f"%{q.strip()}%"] * 2
    with db._connect() as conn:
        rows = conn.execute(
            "SELECT c.id, c.title, c.created_at, c.updated_at, (SELECT count(*) FROM orbis_messages m WHERE m.conversation_id = c.id) "
            f"FROM orbis_conversations c WHERE {where} ORDER BY c.updated_at DESC LIMIT %s", (*params, max(1, min(limit, 500)))).fetchall()
    return [{"id": r[0], "title": r[1], "created_at": _iso(r[2]), "updated_at": _iso(r[3]), "messages": r[4]} for r in rows]


@router.get("/conversations/{cid}")
def conversation(cid: str) -> dict:
    db = _db()
    with db._connect() as conn:
        c = conn.execute("SELECT id, title, created_at, updated_at FROM orbis_conversations WHERE id = %s AND user_id = %s", (cid, _user())).fetchone()
        if not c:
            raise HTTPException(404, "percakapan tidak ditemukan")
        rows = conn.execute("SELECT id, role, content, result, error, created_at FROM orbis_messages WHERE conversation_id = %s ORDER BY created_at",
                            (cid,)).fetchall()
    return {"id": c[0], "title": c[1], "created_at": _iso(c[2]), "updated_at": _iso(c[3]),
            "messages": [{"id": r[0], "role": r[1], "content": r[2], "result": ({**r[3], "answer": r[2]} if r[3] else None), "error": r[4],
                          "created_at": _iso(r[5])} for r in rows]}


class ConversationIn(BaseModel):
    title: str


@router.patch("/conversations/{cid}")
def rename_conversation(cid: str, body: ConversationIn) -> dict:
    db = _db()
    title = re.sub(r"\s+", " ", body.title).strip()[:120]
    if not title:
        raise HTTPException(400, "beri judul percakapan")
    with db._connect() as conn:
        n = conn.execute("UPDATE orbis_conversations SET title = %s WHERE id = %s AND user_id = %s", (title, cid, _user())).rowcount
    if not n:
        raise HTTPException(404, "percakapan tidak ditemukan")
    return {"id": cid, "title": title}


@router.delete("/conversations/{cid}")
def delete_conversation(cid: str) -> dict:
    db = _db()
    with db._connect() as conn:
        n = conn.execute("DELETE FROM orbis_conversations WHERE id = %s AND user_id = %s", (cid, _user())).rowcount
    if not n:
        raise HTTPException(404, "percakapan tidak ditemukan")
    return {"deleted": cid}
