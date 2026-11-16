"""Bluesand Orbis — Grid: the operational knowledge graph of the grid demo (project "Grid Management System Intelligence").

The same explorer as Orbis (api/orbis.py), on the distribution network demo instead of the JKN audit:

- the platform resources from Data Lineage (raw SCADA / AMR / billing / P2TL files, the loss, hourly load, scoring and
  access pipelines, clean datasets, Nexus object types, actions and functions, the NTL model, time series syncs, Device
  and Machinery, map, Vertex graphs, Workshop modules) and how data flows between them;
- every object of the grid object types (substations, feeders, distribution transformers, customers, energy balances,
  loss findings, P2TL inspections, outages, SCADA points, work orders, P2TL teams and visits, AMI meters/events, DT
  sensors, and the real Java-Bali transmission estate from OpenStreetMap) and the Nexus links between them;
- transmission operations as first-class knowledge: voltage-class hubs (500/150/70 kV), named corridors, regency
  location, same-asset equivalence across the Jabar/regional/combined representations, plant endpoints, and an
  aggregate Java-Bali transmission node whose counts are computed from the combined OSM objects;
- shared values as concepts (ULP, tariff, segment, voltage level, transformer status, priority) and the loss patterns
  (NTL-01..14, TL-01..05 and the confounders X-01..05) every finding points to;
- the machine learning: the NTL model, its experiment (CV AUROC, value per inspection), its 22 features, the methods
  (Isolation Forest, gradient boosting, value ranking, the physics of technical losses) and the journals behind them,
  and which features make each scored customer unusual;
- the regulations (P2TL rules, reliability indices, CIM), the team's decisions taken through actions, the what-if
  scenarios and the analytics apps.

Embedded into its own S3 Vectors index "orbis-grid-1" (same model and bucket as Orbis) for semantic search and
"Tanya Orbis" answers. Mounted by server.py under /api/orbis-grid; the UI is /orbis/grid.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
import re
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Optional

from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Request, Response

import ontology
import orbis as O

log = logging.getLogger("bluesandai.orbis_grid")

router = APIRouter(prefix="/api/orbis-grid")

PROJECT = "PLN Grid Project"
INDEX = "orbis-grid-1"
VERSION = "1.0"

DIR: Path = Path("data") / "orbis-grid"
_lock = threading.Lock()
_index_state: dict[str, Any] = {"state": "idle"}
_build_state: dict[str, Any] = {"state": "idle"}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "orbis-grid"
    DIR.mkdir(parents=True, exist_ok=True)
    st = O._read(DIR / "index.json", {})
    if st.get("state") == "running":
        st["state"] = "interrupted"
    _index_state.update(st or {"state": "idle"})


# ------------------------------------------------------------------------------------------------
# curated knowledge (from docs/BENCHMARK_GRID_TL_NTL.md: DOIs checked against Crossref)
# ------------------------------------------------------------------------------------------------

# (id, short label, citation, year, venue, link, what it is used for in the demo)
JOURNALS = [
    ("glauner2017", "Glauner dkk. 2017", "Glauner, Meira, Valtchev & State. The challenge of non-technical loss detection using artificial intelligence: a survey.",
     2017, "Int. J. Computational Intelligence Systems 10:760", "https://doi.org/10.2991/ijcis.2017.10.1.51", "taksonomi penyebab NTL (pencurian, meter rusak, salah tagih)"),
    ("viegas2017", "Viegas dkk. 2017", "Viegas, Esteves, Melício & Mendes. Solutions for detection of non-technical losses in the electricity grid: a review.",
     2017, "Renewable & Sustainable Energy Reviews 80:1256–1268", "https://doi.org/10.1016/j.rser.2017.05.193", "gabungkan aturan, ML dan bukti lapangan"),
    ("messinis2018", "Messinis & Hatziargyriou 2018", "Messinis & Hatziargyriou. Review of non-technical loss detection methods.",
     2018, "Electric Power Systems Research 158:250–266", "https://doi.org/10.1016/j.epsr.2018.01.005", "arsitektur hybrid: data + jaringan (neraca energi)"),
    ("jokar2016", "Jokar dkk. 2016", "Jokar, Arianpoo & Leung. Electricity theft detection in AMI using customers' consumption patterns.",
     2016, "IEEE Trans. Smart Grid 7:216–226", "https://doi.org/10.1109/TSG.2015.2425222", "resep pola pencurian sintetis yang disuntikkan ke data demo"),
    ("punmiya2019", "Punmiya & Choe 2019", "Punmiya & Choe. Energy theft detection using gradient boosting theft detector with feature engineering-based preprocessing.",
     2019, "IEEE Trans. Smart Grid 10:2326–2329", "https://doi.org/10.1109/TSG.2019.2892595", "gradient boosting dengan rekayasa fitur"),
    ("buzau2019", "Buzau dkk. 2019", "Buzau, Tejedor-Aguilera, Cruz-Romero & Gómez-Expósito. Detection of non-technical losses using smart meter data and supervised learning.",
     2019, "IEEE Trans. Smart Grid 10:2661–2670", "https://doi.org/10.1109/TSG.2018.2807925", "model berlabel atas konsumsi, event meter dan data induk"),
    ("calvo2020", "Calvo dkk. 2020", "Calvo, Coma-Puig, Carmona & Arias. Knowledge-based segmentation to improve accuracy and explainability in NTL detection.",
     2020, "Energies 13:5674", "https://doi.org/10.3390/en13215674", "segmen rumah tangga / bisnis / industri / lembaga"),
    ("massaferro2020", "Massaferro dkk. 2020", "Massaferro, Di Martino & Fernández. Fraud detection in electric power distribution: an approach that maximizes the economic return.",
     2020, "IEEE Trans. Power Systems 35:703–710", "https://doi.org/10.1109/TPWRS.2019.2928276", "prioritas inspeksi berbasis nilai (pendapatan dipulihkan vs biaya)"),
    ("pengwah2023", "Pengwah dkk. 2023", "Pengwah, Razzaghi & Andrew. Model-less non-technical loss detection using smart meter voltage sensitivity.",
     2023, "IEEE Trans. Power Delivery 38:3469–3479", "https://doi.org/10.1109/TPWRD.2023.3280551", "fitur fisika: tegangan tidak cocok dengan kWh"),
    ("bai2024", "Bai dkk. 2024", "Bai dkk. Three-phase electricity theft detection (Catch22 + Conv-Transformer) on State Grid data.",
     2024, "Sensors 24:6057", "https://doi.org/10.3390/s24186057", "fitur tiga fasa untuk manipulasi CT/PT pelanggan TM"),
    ("velasco2020", "Velasco dkk. 2020", "Velasco, Amaris & Alonso. Deep learning loss model for large-scale low voltage smart grids.",
     2020, "Int. J. Electrical Power & Energy Systems 121:106054", "https://doi.org/10.1016/j.ijepes.2020.106054", "susut teknis per gardu distribusi"),
    ("telford2021", "Telford dkk. 2021", "Telford, Stephen, Browell & Haben. Dirichlet sampled capacity and loss estimation for LV distribution networks with partial observability.",
     2021, "IEEE Trans. Power Delivery 36:2676–2686", "https://doi.org/10.1109/TPWRD.2020.3025125", "susut JTR saat hanya sebagian pelanggan bermeter pintar"),
    ("taruna2025", "Taruna dkk. 2025 (PLN)", "Taruna, Arisona, Irwanto, Bestari & Juniawan. Electricity theft detection using machine learning in traditional meter "
     "postpaid residential customers: a case study on State Electricity Company (PLN) Indonesia.",
     2025, "IEEE Access 13", "https://doi.org/10.1109/ACCESS.2025.3526764", "pembentukan Target Operasi (TO) PLN dari pemakaian bulanan pelanggan pascabayar "
     "450 VA bermeter tradisional: Random Forest terbaik, penyaringan sekuensial RF+KNN (akurasi 0,89, AUC 0,89) — padanan nyata antrean target P2TL demo, "
     "termasuk untuk pelanggan tanpa AMI; PDF di paper_reference/ (properti pengguna, tidak di-commit)"),
    ("haq2023", "Haq dkk. 2023 (deep CNN)", "Haq, Pei, Zhang, Jianjun & Ahmad. Electricity-theft detection for smart grid security using smart meter "
     "data: a deep-CNN based approach.",
     2023, "Energy Reports 9:634–643 (CPESE 2022)", "https://doi.org/10.1016/j.egyr.2022.11.072", "deep CNN (5 blok konvolusi 3×3 + max-pooling, LReLU, "
     "softmax) atas profil konsumsi smart meter 2-D, augmentasi kelas pencuri untuk ketidakseimbangan (17%); 45.970 pelanggan, uji 25%: TP 1.856, FP 155, "
     "FN 97 — pembanding metode untuk deteksi per jam dari AMI di demo (tidak dipakai melatih); PDF di Files PLN Grid Project/referensi (CC BY-NC-ND)"),
]
REGULATIONS = [
    ("p2tl-2023", "Perdir PLN 0028.P/DIR/2023 tentang P2TL", "Peraturan",
     "Penertiban Pemakaian Tenaga Listrik; disahkan Ditjen Ketenagalistrikan lewat Kepdirjen 539.K/TL.04/DJL.3/2023, menggantikan 088-Z.P/DIR/2016. "
     "Golongan pelanggaran: P-I memengaruhi batas daya, P-II memengaruhi pengukuran energi, P-III keduanya, P-IV dilakukan bukan pelanggan.",
     "https://esdm.go.id/id/berita-unit/direktorat-jenderal-ketenagalistrikan/tingkatkan-kesadaran-pemakaian-listrik-pemerintah-dan-pln-sosialisasikan-aturan-p2tl"),
    ("susut-nasional", "Sasaran susut jaringan PLN", "Kebijakan",
     "Susut jaringan PLN turun dari 10,58% (2014) ke 8,63% (2023); 2024 8,55% vs sasaran 8,51% — acuan KPI susut per ULP dan UP3.",
     "https://www.esdm.go.id/id/berita-unit/direktorat-jenderal-ketenagalistrikan/turunkan-susut-ditjen-gatrik-titipkan-tiga-pesan-ini-ke-pln"),
    ("ieee1366", "IEEE Std 1366 (SAIDI / SAIFI)", "Standar",
     "Definisi indeks keandalan distribusi: SAIDI (menit padam per pelanggan) dan SAIFI (kali padam per pelanggan), dihitung dari gangguan penyulang.",
     "https://standards.ieee.org/ieee/1366/7243/"),
    ("iec-cim", "IEC 61968 / 61970 (CIM)", "Standar",
     "Common Information Model untuk aset dan topologi jaringan (GI, penyulang, trafo, titik ukur) — padanan model aset NUSAGRID SCADA di Nexus.",
     "https://webstore.iec.ch/en/publication/61263"),
    ("osm-odbl", "OpenStreetMap (ODbL)", "Lisensi data",
     "Saluran dan gardu transmisi Jawa Barat di peta berasal dari OpenStreetMap; atribusi wajib, tegangan sebagian disimpulkan.",
     "https://www.openstreetmap.org/copyright"),
]
METHODS = [
    ("neraca", "Neraca energi GI → penyulang → gardu → pelanggan",
     "kWh kirim (SCADA) dikurangi kWh ditagih per penyulang dan per gardu; selisihnya susut, dipecah menjadi teknis (fisika) dan non-teknis (residu).",
     ["messinis2018"]),
    ("susut-teknis", "Susut teknis fisika (I²R, rugi trafo)",
     "JTR: 3·I²·R dengan faktor ketidakseimbangan 1 + 1,6·(In/I)² dan loss load factor 0,3·LF + 0,7·LF²; trafo: rugi besi + rugi tembaga × pembebanan²; "
     "saluran TM dari daya kirim.", ["velasco2020", "telford2021"]),
    ("aturan", "Aturan skrining (20 aturan)", "13 aturan pelanggan dan 7 aturan jaringan; skor, bukti dan nilai harapan per temuan.", ["viegas2017", "glauner2017"]),
    ("isolation-forest", "Isolation Forest", "Deteksi anomali tanpa label atas 22 fitur pelanggan (300 pohon).", ["messinis2018"]),
    ("gradient-boosting", "Gradient boosting berbobot kelas", "Model berlabel atas hasil P2TL (bias: target lama dipilih dari aturan, bukan acak).",
     ["punmiya2019", "buzau2019"]),
    ("prioritas-nilai", "Prioritas berbasis nilai", "Skor gabungan × potensi Rp per bulan: memilih target yang memulihkan pendapatan terbanyak per inspeksi.",
     ["massaferro2020"]),
    ("segmentasi", "Segmentasi pelanggan", "Fitur dan pola dibedakan rumah tangga, bisnis, industri, sosial dan pemerintah (industri & lembaga: nilai terbesar).",
     ["calvo2020"]),
    ("tiga-fasa", "Fitur tiga fasa", "Rasio arus / tegangan fasa terkecil terhadap terbesar untuk manipulasi CT/PT pelanggan TM.", ["bai2024", "pengwah2023"]),
    ("validasi-silang", "Validasi silang 5 lipat & kunci evaluasi", "AUROC CV5 atas label P2TL; kunci jawaban sintetis hanya untuk evaluasi, tidak dipakai melatih.",
     ["jokar2016"]),
    ("streaming-ami-grid", "Streaming AMI 15 menit (MQTT)",
     "Fase 5: meter pilot (semua pelanggan TM + pelanggan AMI 3 gardu) menerbitkan bacaan 15 menit ke MQTT Broker platform (namespace Sparkplug B); "
     "streaming sync dan pipeline streaming menulis seri kW per meter, bacaan bersih dan peristiwa meter. Dari hitungan hari (file harian) menjadi "
     "hitungan detik, tanpa mengubah jalur batch.",
     ["jokar2016", "glauner2017"]),
    ("skor-jam-cusum", "Skor NTL per jam & deteksi CUSUM",
     "Agregasi per jam dari stream bersih dinilai model NTL lewat adaptor per jam (fitur siklus tagihan diisi netral — peringatan dini, bukan pengganti "
     "skor bulanan), lalu CUSUM penurunan mendadak + event tamper/arus fasa menulis Peristiwa AMI ke Nexus: bypass terdeteksi 0,5–1,5 jam data "
     "(target < 3 jam) dengan false positive ±6% meter.",
     ["jokar2016", "massaferro2020", "haq2023"]),
    ("sensor-gardu-termal", "Sensor gardu & model termal IEC 60076-7",
     "Meter trafo per fasa + suhu minyak semua gardu mengalir streaming; TL per jam (trafo + I²R JTR) dan risiko overload dari hotspot serta laju "
     "penuaan relatif 2^((hotspot-98)/6); gardu overload menjadi Perintah Kerja usulan (rekomendasi L2, tanpa kendali SCADA).",
     ["bai2024"]),
    ("feedback-p2tl-grid", "Feedback P2TL & retrain terjadwal",
     "Hasil pemeriksaan menjadi label latih berversi (pipeline label terjadwal saat data berubah); transform repo dilatih ulang Senin 03:00 WIB + saat "
     "label berubah, experiment tercatat; hit-rate agregat per ULP/basis tanpa PII mengawasi mutu target (rujukan proses Target Operasi PLN).",
     ["taruna2025"]),
    ("operasi-transmisi", "Operasi transmisi: aliran daya, batas termal & kontingensi",
     "Jaringan 500 kV adalah backbone Jawa-Bali; 150/70 kV subtransmisi regional. Operasi menjaga aliran daya dalam batas "
     "termal konduktor, tegangan bus, dan keamanan kontingensi (kehilangan satu elemen tidak memicu kegagalan berantai). "
     "Di Orbis, kelas tegangan, koridor bernama, gardu ujung, dan komponen jaringan dihitung dari aset OSM gabungan.", []),
    ("proteksi-scada-transmisi", "Proteksi, SCADA/EMS & telemetri transmisi",
     "Proteksi jarak/diferensial, pemutus, CT/VT, dan telemetri gardu memberi operator visibilitas aliran, status switching, "
     "dan alarm. Demo tetap read-only: data OSM/SCADA demo menjadi bukti dan konteks keputusan, bukan jalur kendali.", []),
    ("pemeliharaan-transmisi", "Pemeliharaan & inspeksi aset transmisi",
     "Inspeksi koridor dan right-of-way, kondisi menara/isolator/konduktor, termografi, serta kesehatan trafo dan pemutus "
     "menentukan prioritas pemeliharaan. Di demo, aset OSM terhubung ke wilayah, koridor, tegangan, dan operatornya.", []),
    ("konektivitas-jaringan", "Konektivitas jaringan dari geometri OSM",
     "Ujung ruas ditempelkan ke gardu/pembangkit terdekat (<=1,5 km), gardu menjadi simpul interkoneksi antar kelas, dan "
     "penghubung turunan menempelkan titik yang belum menyentuh garis. Komponen terbesar dan pulau jaringan dilaporkan apa adanya.", []),
    ("target-operasi-pln", "Target Operasi (TO) PLN: RF + KNN berlapis",
     "Studi kasus PLN (Taruna dkk. 2025): pembentukan daftar Target Operasi dari pemakaian bulanan pelanggan pascabayar 450 VA bermeter tradisional — "
     "Random Forest terbaik di antara 6 model, lalu penyaringan sekuensial model 3-pola → 2-pola → 1-pola (RF+KNN: akurasi 0,89, presisi 0,83, recall 0,98, "
     "F1 0,90, AUC 0,89). Di demo: padanan antrean target P2TL berprioritas nilai untuk pelanggan tanpa AMI, dan alasan skor per jam (sesi 5.2) menjadi "
     "peringatan dini yang memberi makan antrean yang sama, bukan menggantikannya.",
     ["taruna2025"]),
]

PRED = {
    "flowsTo": ("mengalir ke", "#38bdf8", "Aliran data antar sumber daya platform (Data Lineage)."),
    "instanceOf": ("objek dari tipe", "#475569", "Objek Nexus → tipe objeknya."),
    "hasValue": ("bernilai", "#a3a3a3", "Objek → nilai bersama (ULP, golongan, segmen, status)."),
    "suspects": ("diduga pola", "#ef4444", "Temuan → pola susut (NTL-xx / TL-xx) yang didugakan aturan."),
    "violates": ("golongan pelanggaran", "#f97316", "Pola susut → golongan pelanggaran P2TL."),
    "usesMethod": ("memakai metode", "#e879f9", "Model / pipeline → metode."),
    "usesFeature": ("memakai fitur", "#f0abfc", "Model → fitur pelanggan."),
    "derivedFrom": ("diturunkan dari", "#94a3b8", "Fitur → dataset sumbernya."),
    "unusualOn": ("menyimpang pada", "#ef4444", "Pelanggan → fitur dengan kontribusi terbesar pada skor NTL-nya."),
    "basedOn": ("berdasarkan rujukan", "#f43f5e", "Metode / model → publikasi asalnya."),
    "trains": ("melatih", "#c084fc", "Eksperimen → model."),
    "governs": ("mengatur", "#fb7185", "Regulasi / standar → konsep atau sumber daya yang diaturnya."),
    "decidedOn": ("keputusan atas", "#ef4444", "Keputusan tim susut (lewat action) → objek yang diputuskan."),
    "simulates": ("menyimulasikan", "#22d3ee", "Skenario what-if → gardu yang diubahnya."),
    "reads": ("membaca", "#10b981", "Halaman aplikasi → tipe objek yang dipakainya."),
    "connectsTo": ("terhubung ke", "#0ea5e9", "Penghubung/saluran → gardu, pembangkit, atau saluran yang ditempelinya dalam jaringan."),
    "sameAsset": ("aset yang sama", "#94a3b8", "Representasi OSM berbeda dari aset fisik yang sama (detail Jabar, regional, gabungan)."),
    "partOfCorridor": ("bagian koridor", "#b4123a", "Ruas saluran → koridor transmisi bernama yang dibentuknya."),
    "atVoltage": ("pada kelas tegangan", "#f59e0b", "Saluran/gardu transmisi → kelas tegangan operasinya."),
    "locatedIn": ("berada di wilayah", "#64748b", "Aset transmisi → kabupaten/kota tempatnya berada."),
    "summarizes": ("meringkas aset", "#0f766e", "Agregat operasional → tipe objek yang diringkasnya."),
}
CURATED = {
    "pola": ("Pola susut", "#f87171", "Aturan & pola"),
    "golongan_p2tl": ("Golongan pelanggaran P2TL", "#fdba74", "Aturan & pola"),
    "experiment": ("Eksperimen ML", "#c084fc", "Machine learning"),
    "method": ("Metode", "#e879f9", "Machine learning"),
    "feature": ("Fitur ML", "#f0abfc", "Machine learning"),
    "journal": ("Jurnal rujukan", "#f43f5e", "Rujukan"),
    "regulation": ("Regulasi & standar", "#fb7185", "Rujukan"),
    "decision": ("Keputusan tim susut", "#ef4444", "Keputusan"),
    "scenario": ("Skenario what-if", "#22d3ee", "Keputusan"),
    "agregat_transmisi": ("Agregat operasional transmisi", "#0f766e", "Operasional transmisi"),
    "koridor": ("Koridor transmisi", "#b4123a", "Operasional transmisi"),
    "tegangan": ("Kelas tegangan", "#f59e0b", "Operasional transmisi"),
}
# (type key in demo_grid_e2e.T, property, concept kind)
VALUE_PROPS = [
    ("penyulang", "kode_ulp", "v:ulp"), ("gardu", "kode_ulp", "v:ulp"), ("pelanggan", "kode_ulp", "v:ulp"), ("temuan", "kode_ulp", "v:ulp"),
    ("penyulang", "jenis", "v:jenis_penyulang"), ("gardu", "status_gardu", "v:status_gardu"), ("penyulang", "tingkat_susut", "v:tingkat_susut"),
    ("pelanggan", "segmen", "v:segmen"), ("pelanggan", "tarif", "v:tarif"), ("pelanggan", "tegangan", "v:tegangan"),
    ("temuan", "prioritas", "v:prioritas"), ("temuan", "status_temuan", "v:status_temuan"), ("inspeksi", "dasar_pemilihan", "v:dasar_pemilihan"),
    ("gangguan", "penyebab", "v:penyebab_gangguan"), ("sensor_gardu", "kode_ulp", "v:ulp"), ("meter_ami", "kode_ulp", "v:ulp"),
    ("peristiwa_ami", "kode_ulp", "v:ulp"), ("pembangkit_jabar", "sumber_label", "v:bahan_bakar"),
    ("pembangkit_jb", "sumber_label", "v:bahan_bakar"), ("pembangkit_gab", "sumber_label", "v:bahan_bakar"),
    ("saluran_gab", "cakupan", "v:cakupan_data"), ("gardu_gab", "cakupan", "v:cakupan_data"),
    ("pembangkit_gab", "cakupan", "v:cakupan_data"), ("gardu_gab", "jenis_gardu_osm", "v:jenis_gardu"),
    ("gardu_jb", "jenis_gardu_osm", "v:jenis_gardu"), ("gardu_detail_jabodetabek", "jenis_gardu_osm", "v:jenis_gardu"),
]
VALUE_KINDS = {
    "v:ulp": ("ULP", "#fcd34d"), "v:jenis_penyulang": ("Jenis penyulang", "#bfdbfe"), "v:status_gardu": ("Status gardu", "#fca5a5"),
    "v:tingkat_susut": ("Tingkat susut", "#fecaca"), "v:segmen": ("Segmen pelanggan", "#c7d2fe"), "v:tarif": ("Tarif", "#ddd6fe"),
    "v:tegangan": ("Tegangan layanan", "#a5f3fc"), "v:prioritas": ("Prioritas temuan", "#fda4af"), "v:status_temuan": ("Status temuan", "#fbcfe8"),
    "v:dasar_pemilihan": ("Dasar pemilihan P2TL", "#fde68a"), "v:penyebab_gangguan": ("Penyebab gangguan", "#fed7aa"),
    "v:bahan_bakar": ("Bahan bakar pembangkit", "#93c5fd"), "v:cakupan_data": ("Cakupan data OSM", "#a7f3d0"),
    "v:jenis_gardu": ("Jenis gardu (OSM)", "#cbd5e1"),
}
TYPE_COLORS = {"gi": "#2563eb", "penyulang": "#0ea5e9", "gardu": "#0f766e", "pelanggan": "#805ad5", "neraca_gardu": "#2f855a",
               "neraca_penyulang": "#2c9c9c", "temuan": "#c53030", "inspeksi": "#b7791f", "gangguan": "#e53e3e", "titik": "#c05621",
               "perintah": "#6b46c1", "saluran_tx": "#475569", "gardu_tx": "#334155", "kawasan": "#64748b",
               "meter_ami": "#2c9c9c", "peristiwa_ami": "#dc2626", "sensor_gardu": "#d97706",
               "pembangkit_jabar": "#2563eb", "batas_jabar": "#64748b", "saluran_jb": "#991b1b", "gardu_jb": "#1e293b",
               "pembangkit_jb": "#1d4ed8", "saluran_gab": "#b4123a", "gardu_gab": "#111827", "pembangkit_gab": "#2563eb",
               "penghubung": "#475569", "gardu_detail_jabodetabek": "#0e7490"}
GROUP = {"saluran_tx": "Transmisi Jabar (OSM)", "gardu_tx": "Transmisi Jabar (OSM)", "kawasan": "Transmisi Jabar (OSM)",
         "pembangkit_jabar": "Transmisi Jabar (OSM)", "batas_jabar": "Transmisi Jabar (OSM)",
         "saluran_jb": "Transmisi Jawa-Bali (OSM)", "gardu_jb": "Transmisi Jawa-Bali (OSM)", "pembangkit_jb": "Transmisi Jawa-Bali (OSM)",
         "saluran_gab": "Jaringan gabungan Jawa-Bali (OSM)", "gardu_gab": "Jaringan gabungan Jawa-Bali (OSM)",
         "pembangkit_gab": "Jaringan gabungan Jawa-Bali (OSM)", "penghubung": "Jaringan gabungan Jawa-Bali (OSM)",
         "gardu_detail_jabodetabek": "Detail Jabodetabek (OSM)", "meter_ami": "Streaming AMI & sensor",
         "peristiwa_ami": "Streaming AMI & sensor", "sensor_gardu": "Streaming AMI & sensor",
         "neraca_gardu": "Neraca energi", "neraca_penyulang": "Neraca energi"}
# many objects: off when the explorer opens
HIDDEN = {"pelanggan", "neraca_gardu", "neraca_penyulang", "titik", "saluran_jb", "gardu_jb", "pembangkit_jb",
          "gardu_detail_jabodetabek"}

LAYERS = [
    ("data", "Data mentah & pipeline", ["p:raw", "p:pipeline", "p:transform", "p:dataset", "p:ts_sync"],
     "SCADA (telemetri, SOE), AMR/AMI, tagihan AP2T, hasil P2TL dan aset → pipeline aset, susut, beban per jam, skor NTL dan akses per ULP."),
    ("nexus", "Nexus: tipe objek, action, function", ["p:object_type", "p:action", "p:function"],
     "Dataset bersih mendasari tipe objek; action (status temuan, target P2TL, perintah kerja, jadwal) dan function bekerja di atasnya."),
    ("ops", "Objek jaringan & operasi", None, "GI, penyulang, gardu distribusi, pelanggan, neraca energi, temuan, inspeksi P2TL, gangguan, transmisi Jabar."),
    ("transmisi", "Operasional transmisi Jawa–Bali", ["o:SaluranGabunganJawaBaliOsm", "o:GarduGabunganJawaBaliOsm",
     "o:PembangkitGabunganJawaBaliOsm", "o:PenghubungJaringanOsm", "o:SaluranTransmisiJawaBaliOsm", "o:GarduTransmisiJawaBaliOsm",
     "o:PembangkitJawaBaliOsm", "o:GarduDetailJabodetabekOsm", "c:agregat_transmisi", "c:koridor", "c:tegangan"],
     "Seluruh aset transmisi OSM Jawa-Bali: saluran per kelas tegangan, gardu, pembangkit, koridor bernama, penghubung jaringan, agregat operasional, dan detail Jabodetabek/Jabar."),
    ("ml", "Machine learning & rujukan", ["p:model", "c:experiment", "c:method", "c:feature", "c:journal"],
     "Model NTL (Isolation Forest + gradient boosting, prioritas nilai), eksperimen, 22 fitur, dan jurnal asal tiap metode."),
    ("rules", "Pola, regulasi & konsep", ["c:pola", "c:golongan_p2tl", "c:regulation"], "19 pola susut + 5 pengecoh, golongan P2TL, regulasi dan standar."),
    ("apps", "Keputusan & aplikasi", ["c:decision", "c:scenario", "p:module", "p:vertex", "p:map", "p:machinery", "p:page", "p:automation", "p:logic"],
     "Keputusan tim susut lewat action, skenario what-if; Workshop, Vertex, peta, Device and Machinery, halaman demo."),
]


def _clean(name: str) -> str:
    return re.sub(r"\s*\((demo|OSM)\)\s*$", "", name).replace(" Grid", "").strip()


EXTRA_TYPES = {
    "tim": "Grid Field Crew (demo)", "kunjungan": "Grid P2TL Field Visit (demo)",
    "meter_ami": "Grid AMI Meter (demo)", "peristiwa_ami": "AMI Event (demo)", "sensor_gardu": "Substation Sensor (demo)",
    "pembangkit_jabar": "Power Plant West Java (OSM)", "batas_jabar": "Regency/City Boundary West Java (OSM)",
    "saluran_jb": "Transmission Line Java-Bali (OSM)", "gardu_jb": "Transmission Substation Java-Bali (OSM)",
    "pembangkit_jb": "Power Plant Java-Bali (OSM)", "saluran_gab": "Transmission Line Java-Bali Combined (OSM)",
    "gardu_gab": "Substation Java-Bali Combined (OSM)", "pembangkit_gab": "Power Plant Java-Bali Combined (OSM)",
    "penghubung": "Network Interconnection (OSM-derived)", "gardu_detail_jabodetabek": "Substation Detail Jabodetabek (OSM)",
}


def _types() -> dict[str, dict]:
    import demo_grid_e2e as e

    names = {key: spec[0] for key, spec in e.T.items()} | EXTRA_TYPES
    by_name = {t["display_name"]: t for t in ontology._all("object-types")}
    return {key: ontology._object_type(by_name[nm]["id"]) for key, nm in names.items() if nm in by_name}


def _platform(g: O._G, types: dict[str, dict]) -> dict[str, str]:
    import lineage

    full = lineage.graph()
    saved: set[str] = set()
    for gid in ("gridsusut", "gridakses"):
        try:
            saved |= set(lineage.get_graph(gid)["nodes"])
        except Exception:  # noqa: BLE001
            pass
    tids = {t["id"] for t in types.values()}
    keep = {}
    for n in full["nodes"]:
        nm = n.get("name") or ""
        if n["kind"] not in O.PLATFORM_KINDS and n["kind"] != "dataset":
            continue
        ok = n["id"] in saved or n.get("project") == PROJECT or (n["kind"] == "object_type" and n["id"].split(":", 1)[1] in tids) \
            or (("grid" in nm.lower() or "Grid" in nm) and "demo" in nm.lower())
        if ok:
            keep[n["id"]] = n
    for nid, n in keep.items():
        kind = n["kind"]
        path = n.get("path") or []
        if kind == "dataset" and any(p.lower() == "raw" or p.lower().startswith("raw") for p in path):
            kind = "raw"
        label, color, group = O.PLATFORM_KINDS[kind]
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
        g.node(nid, f"p:{kind}", nid.split(":", 1)[-1][:24], n.get("name") or nid, facts=facts, url=n.get("link"), definition=n.get("description"))
    for ed in full["edges"]:
        if ed["from"] in keep and ed["to"] in keep:
            g.link(ed["from"], ed["to"], "flowsTo", propertyLabel=ed.get("label") or None)
    return {nid.split(":", 1)[1]: nid for nid, n in keep.items() if n["kind"] == "object_type"}


def _transmisi_ops(g: O._G, types: dict[str, dict], objects: dict[str, dict[str, dict]], type_node: dict[str, str]) -> dict:
    """Operasional transmisi dari aset OSM gabungan: kelas tegangan, koridor, wilayah, ekuivalensi aset, dan agregat.

    Semua angka dihitung dari objek Nexus yang sudah ada (bukan angka karangan): panjang ruas, jumlah gardu,
    kapasitas pembangkit, ujung bernama, dan statistik konektivitas dari STATE peta gabungan.
    """
    import demo_grid_e2e as e

    def nid(key: str, pk: str) -> str:
        return f"o:{types[key]['id']}:{pk}"

    def props(key: str, pk: str) -> dict:
        return (objects.get(key) or {}).get(pk, {}).get("properties") or {}

    saluran = objects.get("saluran_gab") or {}
    gardu = objects.get("gardu_gab") or {}
    pembangkit = objects.get("pembangkit_gab") or {}
    # kelas tegangan sebagai simpul operasional
    kelas_stats: dict[int, dict] = {}
    for key in ("saluran_gab", "gardu_gab"):
        for pk in (objects.get(key) or {}):
            p = props(key, pk)
            kv = int(p.get("kelas_kv") or 0)
            s = kelas_stats.setdefault(kv, {"ruas": 0, "km": 0.0, "gardu": 0})
            if key == "saluran_gab":
                s["ruas"] += 1
                s["km"] += float(p.get("panjang_km") or 0)
            else:
                s["gardu"] += 1
    peran = {500: "Backbone antarwilayah Jawa-Bali", 150: "Subtransmisi regional utama", 70: "Subtransmisi regional",
             20: "Distribusi tegangan menengah", 0: "Tegangan belum terpetakan di OSM"}
    for kv, s in sorted(kelas_stats.items()):
        label = f"{kv} kV" if kv else "Tegangan tak diketahui"
        n = g.node(f"c:tegangan:{kv}", "c:tegangan", str(kv), label,
                   facts=[["Ruas saluran gabungan", str(s["ruas"])], ["Panjang ruas (km)", f"{s['km']:,.0f}".replace(",", ".")],
                          ["Gardu gabungan", str(s["gardu"])], ["Peran jaringan", peran.get(kv, "Kelas tegangan lain")]],
                   definition=f"Kelas tegangan {label}: {peran.get(kv, 'kelas tegangan lain dalam pemetaan OSM')}.")
        for key in ("saluran_gab", "gardu_gab"):
            for pk in (objects.get(key) or {}):
                if int(props(key, pk).get("kelas_kv") or 0) == kv:
                    g.link(nid(key, pk), n, "atVoltage")
    # aset yang sama antarrepresentasi (detail Jabar / regional / gabungan)
    for grup in (("saluran_tx", "saluran_jb", "saluran_gab"), ("gardu_tx", "gardu_jb", "gardu_gab"),
                 ("pembangkit_jabar", "pembangkit_jb", "pembangkit_gab")):
        gab = grup[-1]
        if gab not in types:
            continue
        for lain in grup[:-1]:
            if lain not in types:
                continue
            for pk in (objects.get(lain) or {}):
                if pk in (objects.get(gab) or {}):
                    g.link(nid(lain, pk), nid(gab, pk), "sameAsset")
    # wilayah kabupaten/kota untuk aset yang memuat kabkota
    batas = objects.get("batas_jabar") or {}
    if "batas_jabar" in types:
        for key in ("gardu_tx", "gardu_gab", "pembangkit_jabar", "pembangkit_gab", "kawasan"):
            if key not in types:
                continue
            for pk in (objects.get(key) or {}):
                kab = props(key, pk).get("kabkota")
                if kab and kab in batas:
                    g.link(nid(key, pk), nid("batas_jabar", kab), "locatedIn")
    # koridor transmisi bernama (difokuskan ke backbone 500 kV dan koridor 150 kV besar)
    koridor: dict[str, list[str]] = {}
    for pk in saluran:
        p = props("saluran_gab", pk)
        if p.get("kelas_kv") in (500, 150) and p.get("nama"):
            koridor.setdefault(str(p["nama"]), []).append(pk)
    n_koridor = 0
    for nama, pks in sorted(koridor.items()):
        km = sum(float(props("saluran_gab", pk).get("panjang_km") or 0) for pk in pks)
        kv = int(props("saluran_gab", pks[0]).get("kelas_kv") or 0)
        if len(pks) < 3 and km < 25:
            continue
        n_koridor += 1
        n = g.node(f"c:koridor:{O._slug(nama)}", "c:koridor", nama, nama,
                   facts=[["Kelas (kV)", str(kv)], ["Ruas", str(len(pks))], ["Panjang (km)", f"{km:,.1f}".replace(",", ".")]],
                   definition="Koridor transmisi bernama dari ruas-ruas saluran OSM gabungan dengan nama yang sama.")
        for pk in pks:
            g.link(nid("saluran_gab", pk), n, "partOfCorridor")
    # penghubung dan ujung pembangkit yang belum menjadi link type Nexus gardu
    for pk in (objects.get("penghubung") or {}):
        p = props("penghubung", pk)
        for target_key, field in (("saluran_gab", "saluran_osm_id"), ("gardu_gab", "gardu_osm_id"), ("pembangkit_gab", "gardu_osm_id")):
            tgt = p.get(field)
            if tgt and tgt in (objects.get(target_key) or {}):
                g.link(nid("penghubung", pk), nid(target_key, tgt), "connectsTo")
    for pk in saluran:
        p = props("saluran_gab", pk)
        for field in ("gardu_ujung_a", "gardu_ujung_b"):
            tgt = p.get(field)
            if tgt and tgt in pembangkit:
                g.link(nid("saluran_gab", pk), nid("pembangkit_gab", tgt), "connectsTo")
    # agregat operasional
    koneksi = ((e.STATE.get("peta_gabungan") or {}).get("konektivitas") or {})
    total_km = sum(float(p.get("panjang_km") or 0) for p in (props("saluran_gab", pk) for pk in saluran))
    mw = sum(float(p.get("kapasitas_mw") or 0) for p in (props("pembangkit_gab", pk) for pk in pembangkit))
    agg = g.node("c:agregat_transmisi:jawa-bali", "c:agregat_transmisi", "jawa-bali", "Jaringan transmisi Jawa–Bali (agregat OSM)",
                 facts=[["Ruas saluran gabungan", str(len(saluran))], ["Panjang total ruas (km)", f"{total_km:,.0f}".replace(",", ".")],
                        ["Gardu transmisi gabungan", str(len(gardu))], ["Pembangkit gabungan", str(len(pembangkit))],
                        ["Kapasitas tercatat (MW)", f"{mw:,.0f}".replace(",", ".")], ["Koridor bernama", str(n_koridor)],
                        ["Ruas berujung gardu/pembangkit", str(koneksi.get("ruas_berujung_gardu", "-"))],
                        ["Ruas di komponen terbesar", f"{koneksi.get('pct_ruas_terhubung', '-')}%"]],
                 definition="Agregat operasional jaringan transmisi Jawa-Bali dari objek OSM gabungan di Nexus: saluran, gardu, "
                            "pembangkit, koridor, dan konektivitasnya. Aset OSM nyata tanpa angka demo.")
    for key in ("saluran_gab", "gardu_gab", "pembangkit_gab", "penghubung"):
        if key in types and types[key]["id"] in type_node:
            g.link(agg, type_node[types[key]["id"]], "summarizes")
    for mid in ("operasi-transmisi", "proteksi-scada-transmisi", "pemeliharaan-transmisi", "konektivitas-jaringan"):
        g.link(agg, f"c:method:{mid}", "usesMethod")
    return {"saluran": len(saluran), "gardu": len(gardu), "pembangkit": len(pembangkit), "koridor": n_koridor,
            "kelas": {str(k): {"ruas": v["ruas"], "km": round(v["km"]), "gardu": v["gardu"]} for k, v in kelas_stats.items()}}


def build() -> dict:
    import demo_grid_data as gd
    import demo_grid_e2e as e

    g = O._G()
    types = _types()
    type_node = _platform(g, types)
    for k, (label, color, group) in CURATED.items():
        g.kind(f"c:{k}", label, color, group)
    pred_extra: dict[str, tuple[str, str, str]] = {}

    # objects
    objects: dict[str, dict[str, dict]] = {}
    for key, t in types.items():
        kind = g.kind(f"o:{t['api_name']}", _clean(t["display_name"]), TYPE_COLORS.get(key, "#93c5fd"), GROUP.get(key, "Jaringan & operasi"))
        objs = ontology.stored_objects(t["id"])
        objects[key] = objs
        props = {p["api_name"]: p.get("display_name") or p["api_name"] for p in t.get("properties") or []}
        title = t.get("title_property") or t["primary_key"]
        for pk, o in objs.items():
            p = o.get("properties") or {}
            facts = [[props.get(k, k), f] for k, v in p.items() if k != title and not O.SKIP_PROP.search(k) and k != "geometri" and (f := O._fmt(v)) is not None]
            nid = g.node(f"o:{t['id']}:{pk}", kind, str(pk), str(p.get(title) or pk), facts=facts[:24], url=f"/object-explorer?type={t['id']}&pk={pk}")
            if t["id"] in type_node:
                g.link(nid, type_node[t["id"]], "instanceOf")
        if t["id"] in type_node:
            n = g.nodes[type_node[t["id"]]]
            n["definition"] = n.get("definition") or t.get("description")
            n.setdefault("facts", []).append(["Objek", str(len(objs))])

    # links from the Nexus link types
    import ontology_model as om

    tids = {t["id"]: k for k, t in types.items()}
    for lt in om._all("link-types"):
        s_t, t_t = lt["source"]["object_type_id"], lt["target"]["object_type_id"]
        if s_t not in tids or t_t not in tids:
            continue
        pred = f"lt:{lt['id']}"
        pred_extra[pred] = (_clean(lt["display_name"]), "#60a5fa", lt.get("description") or
                            f"Link type Nexus: {_clean(types[tids[s_t]]['display_name'])} → {_clean(types[tids[t_t]]['display_name'])}.")
        try:
            pairs = om._pairs(lt)
        except Exception:  # noqa: BLE001
            log.exception("orbis-grid: link type %s", lt["id"])
            continue
        for s, t in pairs:
            g.link(f"o:{s_t}:{s}", f"o:{t_t}:{t}", pred)

    transmisi_stats = _transmisi_ops(g, types, objects, type_node)

    # loss patterns and P2TL violation classes
    golongan = {"P-I": "memengaruhi batas daya", "P-II": "memengaruhi pengukuran energi", "P-III": "memengaruhi batas daya dan pengukuran energi",
                "P-IV": "dilakukan bukan pelanggan"}
    for code, desc in golongan.items():
        g.node(f"c:golongan_p2tl:{code}", "c:golongan_p2tl", code, f"Golongan {code}", definition=f"Pelanggaran P2TL {code}: {desc}.")
        g.link("c:regulation:p2tl-2023", f"c:golongan_p2tl:{code}", "governs")
    for code, (kelompok, judul, gol) in gd.PATTERNS.items():
        n = g.node(f"c:pola:{code}", "c:pola", code, f"{code} {judul}", facts=[["Kelompok", kelompok], ["Golongan / sifat", gol]],
                   definition={"NTL": "Pola susut non-teknis", "TL": "Pola susut teknis", "Pengecoh": "Pengecoh: tampak seperti susut, bukan pelanggaran"}
                   .get(kelompok, kelompok) + f": {judul}.")
        if gol in golongan:
            g.link(n, f"c:golongan_p2tl:{gol}", "violates")
        g.link(n, "c:method:aturan" if kelompok != "TL" else "c:method:susut-teknis", "usesMethod")
    tm = types.get("temuan")
    if tm:
        for pk, o in objects["temuan"].items():
            p = o.get("properties") or {}
            for code in {p.get("kode_pola_dugaan")} | set(re.findall(r"(?:NTL|TL)-\d\d", str(p.get("semua_aturan") or ""))):
                if code:
                    g.link(f"o:{tm['id']}:{pk}", f"c:pola:{code}", "suspects")

    # shared values as concepts
    for key, prop, vk in VALUE_PROPS:
        t = types.get(key)
        if not t:
            continue
        vlabel, vcolor = VALUE_KINDS[vk]
        for pk, o in objects[key].items():
            v = str((o.get("properties") or {}).get(prop) or "").strip()
            if v in ("", "None", "nan", "-"):
                continue
            g.kind(vk, vlabel, vcolor, "Konsep")
            vid = g.node(f"{vk}:{O._slug(v)}", vk, v, v)
            g.link(f"o:{t['id']}:{pk}", vid, "hasValue", propertyLabel=prop)

    # references, regulations, methods
    for jid, short, cite, year, venue, url, use in JOURNALS:
        g.node(f"c:journal:{jid}", "c:journal", jid, short, definition=cite, url=url, facts=[["Tahun", str(year)], ["Terbit di", venue], ["Dipakai untuk", use]])
    for rid, label, cat, desc, url in REGULATIONS:
        g.node(f"c:regulation:{rid}", "c:regulation", rid, label, definition=desc, url=url, facts=[["Jenis", cat]])
    for mid, label, desc, refs in METHODS:
        n = g.node(f"c:method:{mid}", "c:method", mid, label, definition=desc)
        for r in refs:
            g.link(n, f"c:journal:{r}", "basedOn")
    if "c:agregat_transmisi:jawa-bali" in g.nodes:
        for mid in ("operasi-transmisi", "proteksi-scada-transmisi", "pemeliharaan-transmisi", "konektivitas-jaringan"):
            g.link("c:agregat_transmisi:jawa-bali", f"c:method:{mid}", "usesMethod")
        g.link("c:method:proteksi-scada-transmisi", "c:regulation:iec-cim", "basedOn")
        g.link("c:method:operasi-transmisi", "c:regulation:iec-cim", "basedOn")

    # machine learning
    st = e.STATE
    model_node = next((nid for nid, n in g.nodes.items() if n["kind"] == "p:model"), None)
    exp = st.get("ml_experiment") or {}
    if exp:
        metrics = {k: (v[-1]["value"] if isinstance(v, list) and v else v) for k, v in (exp.get("metrics") or {}).items()}
        facts = [[k, str(v)] for k, v in (exp.get("params") or {}).items()] + [[k, f"{v:,.3f}" if isinstance(v, float) and v < 10 else f"{v:,.0f}"]
                                                                              for k, v in metrics.items() if isinstance(v, (int, float))]
        x = g.node(f"c:experiment:{exp.get('id')}", "c:experiment", exp.get("id", ""), f"Eksperimen {exp.get('name', '')}", facts=facts,
                   definition="Pelatihan model NTL: Isolation Forest + gradient boosting atas label P2TL; AUROC CV5, AUROC terhadap kunci evaluasi, "
                              "dan Rp dipulihkan per inspeksi untuk tiap strategi pemilihan target.")
        if model_node:
            g.link(x, model_node, "trains")
        g.link(x, "c:method:validasi-silang", "usesMethod")
    import demo_grid_ml as ml

    if model_node:
        g.nodes[model_node]["definition"] = ("Model NTL pelanggan: skor anomali (Isolation Forest) + probabilitas temuan (gradient boosting berbobot kelas), "
                                             "digabung 0,5/0,5; prioritas = skor gabungan × potensi Rp per bulan. Disajikan lewat live deployment.")
        for mid in ("isolation-forest", "gradient-boosting", "prioritas-nilai", "segmentasi", "tiga-fasa"):
            g.link(model_node, f"c:method:{mid}", "usesMethod")
    fitur_ds = next((nid for nid, n in g.nodes.items() if n["kind"] == "p:dataset" and n["label"].startswith("fitur_pelanggan")), None)
    by_label = {}
    for var in ml.FEATURES:
        lab = ml.LABELS.get(var, var)
        by_label[lab] = var
        f = g.node(f"c:feature:{var}", "c:feature", var, lab, facts=[["Kolom", var]])
        if model_node:
            g.link(model_node, f, "usesFeature")
        if fitur_ds:
            g.link(f, fitur_ds, "derivedFrom")
        if var.startswith("rasio_arus") or var.startswith("rasio_tegangan"):
            g.link(f, "c:method:tiga-fasa", "usesMethod")
    pl = types.get("pelanggan")
    if pl:
        # the 300 customers the model ranks highest: what makes each unusual (the rest would only add noise)
        top = sorted(objects["pelanggan"].items(), key=lambda kv: -float((kv[1].get("properties") or {}).get("skor_ntl") or 0))[:300]
        for pk, o in top:
            for part in str((o.get("properties") or {}).get("alasan_ml") or "").split(";")[:3]:
                lab = part.split("=")[0].strip()
                if lab in by_label:
                    g.link(f"o:{pl['id']}:{pk}", f"c:feature:{by_label[lab]}", "unusualOn", propertyLabel=part.split("=")[-1].strip())

    # pipelines and methods, regulations and what they govern
    for nid, n in g.nodes.items():
        if n["kind"] == "p:pipeline":
            if "susut" in n["label"].lower():
                for mid in ("neraca", "susut-teknis", "aturan"):
                    g.link(nid, f"c:method:{mid}", "usesMethod")
            elif "skor" in n["label"].lower():
                g.link(nid, "c:method:prioritas-nilai", "usesMethod")
    for key, reg in (("inspeksi", "p2tl-2023"), ("gangguan", "ieee1366"), ("titik", "iec-cim"), ("gi", "iec-cim"), ("saluran_tx", "osm-odbl"),
                     ("gardu_tx", "osm-odbl"), ("kawasan", "osm-odbl"), ("neraca_penyulang", "susut-nasional"),
                     ("saluran_jb", "osm-odbl"), ("gardu_jb", "osm-odbl"), ("pembangkit_jb", "osm-odbl"),
                     ("saluran_gab", "osm-odbl"), ("gardu_gab", "osm-odbl"), ("pembangkit_gab", "osm-odbl"),
                     ("pembangkit_jabar", "osm-odbl"), ("batas_jabar", "osm-odbl"), ("penghubung", "osm-odbl"),
                     ("saluran_gab", "iec-cim"), ("gardu_gab", "iec-cim"), ("gardu_detail_jabodetabek", "osm-odbl")):
        t = types.get(key)
        if t and t["id"] in type_node:
            g.link(f"c:regulation:{reg}", type_node[t["id"]], "governs")

    # the loss team's decisions (edits through actions)
    import ontology_edits

    for key, t in types.items():
        objs = objects[key]
        for pk, ed in ontology_edits.layer(t["id"]).items():
            props = ed.get("properties") or {}
            if not props:
                continue
            title = (objs.get(pk) or {}).get("properties", {}).get(t.get("title_property") or "") or pk
            at = max((v for v in (ed.get("prop_at") or {}).values() if isinstance(v, str)), default=ed.get("at") or "")
            d = g.node(f"c:decision:{t['id']}:{pk}", "c:decision", str(pk), f"Keputusan · {title}",
                       facts=[[k.replace("_", " "), O._fmt(v) or "—"] for k, v in props.items()] + [["Waktu", str(at)]],
                       definition=f"Keputusan tim atas {_clean(t['display_name'])} {title}, diambil lewat action dan tercatat di riwayat edit.")
            g.link(d, f"o:{t['id']}:{pk}", "decidedOn")

    # what-if scenarios (Nexus Scenarios, from the analytics step)
    an = st.get("analitik") or {}
    gdt = types.get("gardu")
    if an.get("scenarios") and gdt:
        try:
            import ontology_scenarios as osc

            for sc in osc.list_scenarios():
                if sc["id"] not in set(an["scenarios"].values()):
                    continue
                full = osc._read(osc._path(sc["id"])) or {}
                total = next((c.get("nilai_susut_rp_bulan") for c in an.get("scenario_compare") or [] if c.get("scenario_id") == sc["id"]), None)
                s = g.node(f"c:scenario:{sc['id']}", "c:scenario", sc["id"], sc["name"], definition=full.get("description"),
                           facts=[["Nilai susut gardu (Rp/bln)", O._fmt(float(total)) or "—"]] if total is not None else None,
                           url="/ontology/scenarios")
                for pk in ((full.get("objects") or {}).get(gdt["id"]) or {}):
                    g.link(s, f"o:{gdt['id']}:{pk}", "simulates")
                g.link(s, "c:method:susut-teknis", "usesMethod")
        except Exception:  # noqa: BLE001
            log.exception("orbis-grid: scenarios")

    # the demo's pages
    g.kind("p:page", *O.PLATFORM_KINDS["page"])
    for pid, label, url, reads in (("demo-grid", "Grid Management System Intelligence (demo)", "/demo-grid", ["penyulang", "gardu", "temuan", "inspeksi"]),
                                   ("arsitektur", "Demo Grid — arsitektur", "/demo-grid/arsitektur", list(types)),
                                   ("orbis-grid", "Bluesand Orbis — Grid", "/orbis/grid", [])):
        n = g.node(f"page:{pid}", "p:page", pid, label, url=url)
        for key in reads:
            t = types.get(key)
            if t and t["id"] in type_node:
                g.link(n, type_node[t["id"]], "reads")

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
    kind_counts = Counter(n["kind"] for n in nodes)
    payload = {
        "meta": {"title": "Bluesand Orbis — Grid", "subtitle": f"Graf pengetahuan operasional · {PROJECT}", "version": VERSION, "date": O._now(),
                 "project": PROJECT, "index": INDEX, "embedding_model": O.EMBED_MODEL},
        "kinds": {k: v for k, v in g.kinds.items() if kind_counts.get(k)},
        "predicates": {k: {"label": a, "color": b, "desc": c} for k, (a, b, c) in {**PRED, **pred_extra}.items()},
        "defaults": {"hiddenPredicates": ["instanceOf", "hasValue"], "hiddenKinds": [f"o:{types[k]['api_name']}" for k in HIDDEN if k in types]},
        "nodes": nodes,
        "links": links,
        "layers": _layers(kind_counts, g.kinds),
        "stats": {"nodes": len(nodes), "links": len(links), "kinds": len(kind_counts), "generatedAt": O._now(),
                  "transmisi": transmisi_stats},
    }
    with _lock:
        O._write(DIR / "graph.json", payload)
        (DIR / "graph.json.gz").unlink(missing_ok=True)
    return payload["stats"]


def _layers(counts: Counter, kinds: dict[str, dict]) -> list[dict]:
    out = []
    for i, (key, name, ks, gist) in enumerate(LAYERS):
        if ks is None:
            ks = [k for k in counts if k.startswith("o:")]
        if key == "rules":
            ks = ks + [k for k in counts if k.startswith("v:")]
        out.append({"n": i + 1, "key": key, "name": name, "gist": gist,
                    "kinds": [{"kind": k, "label": kinds.get(k, {}).get("label", k), "count": counts.get(k, 0)} for k in ks if counts.get(k)]})
    return out


def _graph() -> dict:
    p = DIR / "graph.json"
    if not p.exists():
        build()
    return O._read(p, {})


# ------------------------------------------------------------------------------------------------
# vector index orbis-grid-1 (same bucket, model and text form as Orbis)
# ------------------------------------------------------------------------------------------------


def _ensure_index() -> None:
    import vectors

    s3v = O._s3v()
    try:
        s3v.get_index(vectorBucketName=O._bucket(), indexName=INDEX)
        return
    except ClientError as ex:
        if ex.response.get("Error", {}).get("Code") not in ("NotFoundException", "ResourceNotFoundException", "NoSuchIndex"):
            raise
    s3v.create_index(vectorBucketName=O._bucket(), indexName=INDEX, dataType="float32", dimension=O.DIMENSION, distanceMetric="cosine",
                     metadataConfiguration={"nonFilterableMetadataKeys": ["text", "label"]}, tags={vectors.MODEL_TAG: O.EMBED_MODEL})


def _save_state(**kw: Any) -> None:
    _index_state.update(kw)
    O._write(DIR / "index.json", _index_state)


def _run_index(full: bool) -> None:
    import vectors

    try:
        _ensure_index()
        data = _graph()
        texts = O._texts(data)
        manifest: dict[str, str] = {} if full else O._read(DIR / "vectors.json", {})
        want = {nid: hashlib.sha256(t.encode("utf-8")).hexdigest()[:16] for nid, t in texts.items()}
        todo = [nid for nid, h in want.items() if manifest.get(nid) != h]
        gone = [nid for nid in manifest if nid not in want]
        kinds = {n["id"]: n["kind"] for n in data["nodes"]}
        labels = {n["id"]: n["label"] for n in data["nodes"]}
        _save_state(state="running", started_at=O._now(), total=len(want), todo=len(todo), done=0, removed=0, cost_usd=0.0, error=None)
        cost = 0.0
        for i in range(0, len(todo), 256):
            batch = todo[i: i + 256]
            vecs, c = vectors.embed([texts[n] for n in batch], O.EMBED_MODEL, O.DIMENSION, "doc")
            cost += c
            vectors._put(INDEX, [{"key": n, "data": {"float32": v}, "metadata": {"kind": kinds[n], "label": labels[n][:300], "text": texts[n]}}
                                 for n, v in zip(batch, vecs)])
            for n in batch:
                manifest[n] = want[n]
            O._write(DIR / "vectors.json", manifest)
            _save_state(done=min(i + 256, len(todo)), cost_usd=round(cost, 6))
        if gone:
            vectors._delete_keys(INDEX, gone)
            for n in gone:
                manifest.pop(n, None)
            O._write(DIR / "vectors.json", manifest)
        _save_state(state="done", finished_at=O._now(), removed=len(gone), vectors=len(manifest))
    except Exception as ex:  # noqa: BLE001
        log.exception("orbis-grid: indexing failed")
        _save_state(state="failed", error=str(ex)[:500], finished_at=O._now())


def search_nodes(q: str, k: int = 12, kind: Optional[str] = None) -> list[dict]:
    kwargs: dict[str, Any] = {"vectorBucketName": O._bucket(), "indexName": INDEX, "queryVector": {"float32": O._embed_query(q)},
                              "topK": max(1, min(k, 50)), "returnDistance": True, "returnMetadata": True}
    if kind:
        kwargs["filter"] = {"kind": {"$eq": kind}}
    try:
        hits = O._s3v().query_vectors(**kwargs).get("vectors", [])
    except ClientError as ex:
        raise HTTPException(502, f"pencarian vector gagal: {ex.response.get('Error', {}).get('Message', ex)}")
    return [{"id": h["key"], "score": round(1 - float(h.get("distance") or 0), 4), "label": (h.get("metadata") or {}).get("label"),
             "kind": (h.get("metadata") or {}).get("kind")} for h in hits]


# ------------------------------------------------------------------------------------------------
# routes (the shapes of /api/orbis, so the explorer is the same)
# ------------------------------------------------------------------------------------------------


@router.get("/graph")
def graph(request: Request) -> Response:
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


def _run_build() -> None:
    try:
        _build_state.update(state="running", started_at=O._now(), error=None)
        _build_state.update(state="done", finished_at=O._now(), stats=build())
    except Exception as ex:  # noqa: BLE001
        log.exception("orbis-grid: build failed")
        _build_state.update(state="failed", error=str(ex)[:500], finished_at=O._now())


@router.post("/build")
def rebuild() -> dict:
    if _build_state.get("state") != "running":
        threading.Thread(target=_run_build, daemon=True, name="orbis-grid-build").start()
        _build_state.update(state="running", started_at=O._now())
    return dict(_build_state)


@router.get("/build")
def build_status() -> dict:
    return dict(_build_state)


@router.get("/index")
def index_status() -> dict:
    out = dict(_index_state)
    out.update(index=INDEX, bucket=O._bucket(), model=O.EMBED_MODEL, dimension=O.DIMENSION, vectors=len(O._read(DIR / "vectors.json", {})))
    return out


@router.post("/index")
def start_index(body: O.IndexIn) -> dict:
    if _index_state.get("state") == "running":
        raise HTTPException(409, f"indeks {INDEX} sedang dibangun")
    _save_state(state="running", started_at=O._now(), done=0, todo=None, error=None)
    threading.Thread(target=_run_index, args=(body.full,), daemon=True, name="orbis-grid-index").start()
    return index_status()


@router.post("/search")
def search(body: O.SearchIn) -> dict:
    q = body.q.strip()[:1000]
    if not q:
        raise HTTPException(400, "isi pertanyaan atau kata kunci")
    t0 = time.time()
    return {"hits": search_nodes(q, body.k, body.kind), "ms": int((time.time() - t0) * 1000)}


SYSTEM = """Anda adalah Orbis, asisten graf pengetahuan operasional demo Grid Management System Intelligence (BluesandAI):
jaringan distribusi dan transmisi Jawa-Bali, neraca energi, susut teknis (TL) dan non-teknis (NTL), temuan, P2TL, model NTL,
aset transmisi OpenStreetMap (saluran 500/150/70 kV, gardu, pembangkit, koridor, kelas tegangan, konektivitas), regulasi dan aplikasinya.
Jawab dalam bahasa Indonesia, ringkas dan tepat, HANYA berdasarkan simpul dan relasi graf yang diberikan.
Rujuk setiap fakta dengan nomor simpul dalam kurung siku, mis. [3] atau [3][7]. Jika graf tidak memuat jawabannya, katakan
demikian dan sebutkan simpul terdekat yang relevan. Jangan mengarang angka, nama, atau rujukan. Data demo ini fiktif
(kecuali aset transmisi dari OpenStreetMap, tanpa angka demo)."""

# conversations of this graph are titled with this prefix, so the JKN Orbis and this one keep separate histories
TITLE_PREFIX = "[Grid] "


@router.post("/ask")
def ask(body: O.AskIn) -> dict:
    import pipeline_ai

    q = body.q.strip()[:1500]
    if not q:
        raise HTTPException(400, "isi pertanyaan")
    t0 = time.time()
    data = _graph()
    idx = {n["id"]: n for n in data["nodes"]}
    conv = O._conversation_for(body.conversation_id, TITLE_PREFIX + q)
    history = O._history(conv["id"]) if conv else body.history
    hits = [h for h in search_nodes(q, 10) if h["id"] in idx]
    if history:
        prev = " ".join(str(m.get("content"))[:400] for m in history[-2:])
        seen = {h["id"] for h in hits}
        hits += [h for h in search_nodes(f"{q} {prev}"[:1500], 8) if h["id"] in idx and h["id"] not in seen]
    seeds = [h["id"] for h in hits]
    seedset = set(seeds)
    adj: dict[str, list[dict]] = defaultdict(list)
    for l in data["links"]:
        if l["predicate"] in ("instanceOf",):
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
    user = (f"Percakapan sebelumnya:\n{hist}\n\n" if hist else "") + f"Pertanyaan: {q}\n\nSIMPUL:\n" + "\n".join(lines) + "\n\nRELASI:\n" + "\n".join(rel[:120])
    if conv:
        O._add_message(conv["id"], "user", q)
    try:
        answer = pipeline_ai.chat(O.ANSWER_MODEL, SYSTEM, user, temperature=0.1, max_tokens=1400)
    except Exception as ex:  # noqa: BLE001
        msg = f"model jawaban gagal: {str(ex)[:300]}"
        if conv:
            O._add_message(conv["id"], "assistant", "", error=msg)
        raise HTTPException(502, msg)
    cited = sorted({int(x) for x in re.findall(r"\[(\d+)\]", str(answer)) if 0 < int(x) <= len(ctx_ids)})
    sub = set(ctx_ids)
    out = {
        "answer": str(answer).strip(),
        "refs": [{"n": num[nid], "id": nid, "label": idx[nid]["label"], "kind": idx[nid]["kind"]} for nid in ctx_ids],
        "cited": [ctx_ids[i - 1] for i in cited],
        "hits": hits,
        "subgraph": {"nodeIds": ctx_ids, "edges": [{"s": l["source"], "p": l["predicate"], "t": l["target"]} for l in edges if l["source"] in sub and l["target"] in sub]},
        "ms": int((time.time() - t0) * 1000),
    }
    if conv:
        out["message_id"] = O._add_message(conv["id"], "assistant", out["answer"], result={k: v for k, v in out.items() if k != "answer"})
        out["conversation_id"] = conv["id"]
        out["title"] = conv["title"]
    return out


@router.get("/conversations")
def conversations(q: str = "", limit: int = 100) -> list[dict]:
    return [c for c in O.conversations(q, 500, grid=True) if c["title"].startswith(TITLE_PREFIX)][: max(1, min(limit, 500))]


@router.get("/conversations/{cid}")
def conversation(cid: str) -> dict:
    return O.conversation(cid)


@router.patch("/conversations/{cid}")
def rename_conversation(cid: str, body: O.ConversationIn) -> dict:
    title = body.title.strip()
    return O.rename_conversation(cid, O.ConversationIn(title=title if title.startswith(TITLE_PREFIX) else TITLE_PREFIX + title))


@router.delete("/conversations/{cid}")
def delete_conversation(cid: str) -> dict:
    return O.delete_conversation(cid)
