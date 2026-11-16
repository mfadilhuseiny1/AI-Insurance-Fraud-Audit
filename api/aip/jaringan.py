"""The network of every agent of AIP JKN, for the page that draws it (the user, 2026-10-23: "network graph yang
nyambungin semua agen ... agen apa, hubungannya apa, fungsinya untuk apa, aksi yang bisa dilakukan apa"), on the
orchestration concept the system follows (docs/Agent Orchestration Concept; adk_runtime/orkestrasi.py).

One node per agent — the orchestrator, the domain agents, the small agents each leads in the fraud consultancy, the ML
agent's technique sub-agents, the validator with its QA reviewers and red team, the small agents formed per question —
and the shared state they coordinate through, the scrutiny validator (code), the machines, the /verify service and the
people the agents hand to. Every relation is an edge with its kind, the multi-agent strategy it is, and the flow it
belongs to. What an agent can do is read from the code: each action is a tool, described by its own docstring
(adk_runtime/tools.py, adk_runtime/firm.py), and each worker's skill comes from aip/skills.py — the page cannot promise
a tool or a procedure the agent does not have.

    GET /api/aip/jaringan

The roster is the one an engagement would form now (aip/konsultan.py), after the merge of the redundant agents of
2026-10-23; GABUNG says what was merged and on what evidence.
"""

from __future__ import annotations

import ast
import re
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/api/aip")

RUNTIME = Path(__file__).resolve().parent / "adk_runtime"

KINDS = {
    "pimpinan": "Orkestrator: merencanakan tugas, milestone dan kontrak validasi; menulis hasil akhir",
    "agen_domain": "Agen domain (pekerja): memegang objek Nexus-nya, menjawab bagiannya, memimpin agen kecilnya",
    "validator": "Validator: keluarga model lain, tidak pernah melihat penalaran pekerja",
    "sub_agen": "Sub-agen teknik ML: satu per teknik benchmark (riset baca-saja, paralel)",
    "agen_kecil": "Agen kecil firma: satu cakupan sempit, konteks segar, satu skill",
    "dinamis": "Agen kecil yang dibentuk per pertanyaan",
    "state": "Shared state: tempat agen berkoordinasi (tidak ada pesan langsung antaragen)",
    "mesin": "Mesin dan validator kode: kode yang memutuskan, bukan model",
    "layanan": "Layanan inferensi (model terpasang + LLM)",
    "manusia": "Manusia: semua keputusan",
    "modus": "Modus fraud Permenkes 16/2019: siapa yang mendeteksinya, atau mengapa data belum bisa",
}
# each relation as the multi-agent strategy it is (the concept's five: delegation, creator-verifier, direct communication,
# negotiation, broadcast — AIP uses delegation, creator-verifier and broadcast through shared state, and no direct talk)
RELATIONS = {
    "memimpin": {"label": "menugaskan dan menerima serah-terima", "strategi": "Delegasi"},
    "membentuk": {"label": "membentuk agen untuk satu pertanyaan", "strategi": "Delegasi"},
    "memeriksa": {"label": "memeriksa ulang ke data, tanpa melihat penalaran pembuatnya", "strategi": "Pembuat–Pemeriksa"},
    "menantang": {"label": "menguji indikasi terkuat: bertahan atau melemah", "strategi": "Pembuat–Pemeriksa"},
    "berbagi_state": {"label": "membaca dan menulis shared state", "strategi": "Broadcast lewat shared state"},
    "mengumpankan": {"label": "menulis hasil deterministik ke shared state", "strategi": "Broadcast lewat shared state"},
    "memakai": {"label": "memanggil model atau layanan", "strategi": "Alat"},
    "menyetel": {"label": "menyetel aturan prompt dari skor kode; versi baru menunggu admin", "strategi": "Optimasi prompt (GEPA)"},
    "menyerahkan": {"label": "usulan ke manusia; manusia yang memutuskan", "strategi": "Gerbang manusia"},
    "mendeteksi": {"label": "mencari dan menandai modus ini di data", "strategi": "Deteksi modus"},
}
FLOWS = {"tanya_jawab": "Tanya-jawab (pertanyaan auditor)", "firma": "Penugasan AI Agent Swarm", "produksi": "Pipeline produksi & POST /verify"}
# the fraud modes as the map names them (aip/semantik.py MODUS_PERMENKES holds the full text)
MODE_SHORT = {"M01": "Dana kapitasi", "M02": "Klaim nonkapitasi", "M03": "Rujukan tidak sesuai", "M04": "Upcoding", "M05": "Cloning", "M06": "Phantom billing",
              "M07": "Inflated bills", "M08": "Pemecahan episode", "M09": "Unbundling", "M10": "Self-referral", "M11": "Repeat billing", "M12": "Prolonged LOS",
              "M13": "Kelas perawatan", "M14": "Tindakan tak dilakukan", "M15": "Tak sesuai indikasi", "M16": "Readmisi", "M17": "Fiktif obat/alkes",
              "M18": "Pengurangan obat", "M20": "Hasil pemeriksaan"}
# who else looks at a mode besides its tag's specialist and the auto-tagger: the model and the clinical review of /verify
MODE_EXTRA = {"M04": ["machine_learning", "layanan_verify", "klinis"], "M15": ["layanan_verify", "klinis"], "M14": ["layanan_verify"]}

# the actions that are not tools: steps the code runs for the agent, or answers it gives in a fixed form
STEPS = {
    "susun_rencana": "Memecah pertanyaan menjadi tugas sempit untuk agen pemilik objeknya (satu per provinsi, kelas, modus, kode … yang dicakup), "
                     "dengan skill per tugas.",
    "kontrak_validasi": "Menulis kontrak validasi — pernyataan yang harus benar tentang hasilnya — sebelum agen mana pun bekerja.",
    "bentuk_agen_kecil": "Membentuk agen kecil per tugas (paling banyak 16, 8 bekerja bersamaan), masing-masing dengan tool dan izin agen domain pemiliknya.",
    "tulis_jawaban": "Menulis structuring atau laporan akhir hanya dari temuan agen, dengan rujukan hasil_id; tidak menambah fakta.",
    "jawab_langsung": "Pertanyaan yang tidak butuh data (salam, cara memakai AIP JKN, istilah umum, di luar lingkup JKN) dijawab langsung dari rencana: "
                      "tanpa agen domain dan validator, satu panggilan model. Gerbang kode: jawaban langsung tanpa angka — angka butuh bacaan agen.",
    "revisi": "Merevisi sekali bila validator atau scrutiny menemukan klaim, pernyataan kontrak atau rujukan yang tidak bertahan; laporan "
              "firma: hanya bagian yang dipersoalkan yang ditulis ulang.",
    "aturan_rencana": "Merencana dengan aturan versi model perencananya: aturan kode, atau versi hasil penyetelan GEPA yang dinyalakan admin; "
                      "setiap rencana menyebut versinya.",
    "kerangka_laporan": "Laporan akhir firma, langkah 1: kerangka — poin per bagian dengan sumbernya (hasil_id, sintesis agen domain, QA, fakta "
                        "firma). Kode membuang poin dengan hasil_id yang bukan dari penugasan ini, atau tanpa sumber di ringkasan, temuan dan box.",
    "tulis_bagian": "Laporan akhir firma, langkah 2: tiap bagian ditulis hanya dari bahan yang dirujuk poinnya (tanpa tool, paralel); kode "
                    "menggabungkannya, jadi tidak ada narasi proses di laporan.",
    "executive_summary": "Untuk pimpinan non-teknis: structuring yang sudah divalidasi (dan bagian laporan firma) diceritakan ulang model lain "
                   "(perannya sendiri) tanpa istilah teknis; kode memeriksa setiap angka terhadap sumbernya — porsi \"x dari setiap N\" dan \"n kali lipat\" "
                   "dihitung ulang — dan membuang kalimat dengan angka baru.",
    "rencana_penugasan": "Hipotesis yang bisa diuji, fokus tiap lini dan kontrak validasi penugasan firma.",
    "rencana_misi": "Rencana misi audit bertahap (milestone, tugas berskill, kontrak, anggaran) yang menunggu persetujuan manusia.",
    "encode_pelajaran": "Menutup run: temuan validator menjadi pelajaran skill yang dipakai (lewat gerbang kode).",
    "sintesis": "Menyintesis laporan dan serah-terima agen kecilnya: pola berulang, temuan terkuat dengan angka, celah yang belum diperiksa.",
    "serah_terima": "Menyerahkan: yang dikerjakan, yang belum, panggilan tool dan statusnya, masalah, prosedur skill diikuti (dicek kode).",
    "putusan_validator": "Putusan per klaim angka dan per pernyataan kontrak (lolos / gagal) dengan bukti dari bacaannya sendiri; yang gagal memicu revisi.",
}
# what a tool or step writes (everything else only reads): tags are notes, proposals and verdicts wait for people
WRITES = {"tandai_indikasi": "catatan", "tandai_hasil": "catatan", "rekomendasi_jalur": "usulan", "usulkan_action": "usulan", "putusan_red_team": "putusan",
          "putusan_validator": "putusan", "rencana_misi": "usulan", "kontrak_validasi": "rencana", "serah_terima": "serah-terima",
          "encode_pelajaran": "pelajaran"}

SEM = ["kamus_semantik", "ukur"]
READ = ["cari_objek", "agregasi_objek", "detail_objek", "objek_terkait", "jalankan_fungsi"]
ML_READ = ["skor_risiko_klaim_ml", "risiko_faskes_ml", "jelaskan_klaim_ml", "verifikasi_klaim"]
TAG = ["tandai_indikasi", "tandai_hasil", "lihat_indikasi"]
# the firm's small agents per kind of work (adk_runtime/firm.py: analyst, technique, investigate, phase_5) and their skills
FIRM_ACTIONS = {"wilayah": SEM + READ + ML_READ + TAG, "peer": SEM + READ + ML_READ + TAG, "modus": SEM + READ + ML_READ + TAG,
                "kasus": SEM + READ + ML_READ + ["tandai_indikasi", "lihat_indikasi", "rekomendasi_jalur"], "ml": ["jalankan_teknik"],
                "qa": SEM + READ + ["lihat_indikasi", "putusan_validator"], "red_team": SEM + READ + ML_READ + ["putusan_red_team"]}
FIRM_SKILL = {"wilayah": "analis_wilayah", "peer": "analis_peer", "modus": "spesialis_modus", "ml": "sub_agen_teknik", "kasus": "penyidik_kasus",
              "qa": "reviewer_qa", "red_team": "red_team"}
LEAD_IN_FIRM = SEM + ["lihat_indikasi", "sintesis", "serah_terima"]

KONSEP = [
    {"konsep": "Arsitektur tiga peran", "di_aip": "Orkestrator merencanakan tugas, milestone dan kontrak validasi; pekerja = agen domain dan agen kecilnya, "
                                                   "konteks segar per tugas; validator = keluarga model lain, reviewer QA dan red team, tidak pernah melihat penalaran pekerja."},
    {"konsep": "Kontrak validasi sebelum kerja", "di_aip": "Ditulis orkestrator di rencana tanya-jawab, misi dan penugasan firma sebelum agen mana pun "
                                                            "bekerja (firma: 4 pernyataan dasar dari kode + pernyataan orkestrator); validator menilai setiap pernyataan."},
    {"konsep": "Loop validasi tiap milestone", "di_aip": "Validator scrutiny (kode): rujukan ada, tiap tugas berbukti, cakupan terjawab, angka bersumber, "
                                                          "rekomendasi TSM, serah-terima, kerangka laporan bersumber; lalu validator adversarial yang membaca "
                                                          "ulang data seperti pengguna."},
    {"konsep": "Serah-terima terstruktur", "di_aip": "Setiap pekerja: yang dikerjakan, yang belum, panggilan tool dan statusnya, masalah, dan apakah prosedur "
                                                      "skill diikuti — yang terakhir dicek kode, bukan diakui agen."},
    {"konsep": "Serial, paralel hanya yang tak bisa konflik", "di_aip": "Fase dan milestone berurutan; paralel hanya untuk baca-riset dan review validasi; "
                                                                         "tulisan pekerja hanya catatan ke buku besar idempoten atau usulan untuk manusia."},
    {"konsep": "Model yang tepat per peran", "di_aip": ""},
    {"konsep": "Logika di prompt dan skill", "di_aip": "Prosedur kerja ada di pustaka skill (aip/skills.py), dipilih orkestrator per tugas; model yang lebih "
                                                        "baik membuat sistem lebih pintar tanpa mengubah kode. Aturan rencana orkestrator disetel per model "
                                                        "dengan GEPA pada 47 pertanyaan berlabel (aip/optimasi.py), dinilai kode dan diuji pada pertanyaan "
                                                        "yang tidak dilihat penyetelan; versi baru hanya usulan sampai admin menyalakannya."},
    {"konsep": "Belajar terus (encode skill)", "di_aip": "Temuan validator menjadi pelajaran skill yang dipakai: tugas baru → kerjakan → amati → pelajari → "
                                                          "encode skill; gerbang kode, aktif untuk run admin, usulan untuk lainnya."},
    {"konsep": "Tanpa komunikasi langsung antaragen", "di_aip": "Agen tidak saling mengirim pesan; mereka berkoordinasi lewat shared state supaya state "
                                                                 "tidak terpecah."},
]

MACHINES = [
    {"id": "validator_scrutiny", "nama": "Validator scrutiny (kode)", "alur": ["tanya_jawab", "firma"],
     "fungsi": "Pemeriksa deterministik sebelum validator adversarial: rujukan [rN] ada, setiap tugas berbukti tool, setiap cakupan rencana dijawab, angka "
               "bersumber dari hasil; di firma tiap fase: serah-terima, prosedur skill, rekomendasi TSM, sintesis berhasil_id, kerangka laporan "
               "(poin dengan hasil_id penugasan ini dan bersumber)."},
    {"id": "penyetel_aturan", "nama": "Penyetel aturan (GEPA)", "alur": ["tanya_jawab"],
     "fungsi": "Luring, bukan bagian sebuah run: menyetel aturan rencana orkestrator per model (aip/optimasi.py). Model yang diuji menyusun rencana "
               "untuk 47 pertanyaan berlabel dengan prompt runtime yang sama; kode menilai tiap rencana (jalur, agen, jumlah tugas, cakupan, fokus, "
               "kontrak, gerbang angka) dan umpan baliknya dibaca GLM-5.2 untuk menulis versi baru; kode memilih versi yang skornya naik. Hasilnya "
               "diuji pada pertanyaan yang tidak dilihat penyetelan dan hanya diusulkan bila naik melampaui kebetulan (IK95 di atas 0)."},
    {"id": "penanda_otomatis", "nama": "Penanda otomatis", "alur": ["firma", "produksi"],
     "fungsi": "Aturan lapisan semantik atas semua objek: setiap sinyal (LOS ekstrem, calon klaim ganda, koreksi verifikator, OUTLIER_PEER …) jadi tag lemah–kuat."},
    {"id": "konsensus_ml", "nama": "Konsensus teknik ML", "alur": ["firma"],
     "fungsi": "Faskes yang ditaruh banyak teknik di 25 teratasnya: ditandai KONSENSUS_TEKNIK_ML (kuat >= 75% teknik, sedang >= 50%, lemah >= 33%)."},
    {"id": "karantina", "nama": "Box karantina", "alur": ["firma", "produksi"],
     "fungsi": "Faskes bertag per kelompok estimasi kerugian (A menanggung 50% pertama … Z), dengan sinyal Terstruktur, Sistematis, Masif."},
    {"id": "sinkron_nexus", "nama": "Sinkron Nexus", "alur": ["firma", "produksi"],
     "fungsi": "Buku besar indikasi dan box karantina menjadi objek Nexus, dengan marking Internal / Rahasia per baris."},
    {"id": "penyusun_layar", "nama": "Penyusun layar", "alur": ["tanya_jawab"],
     "fungsi": "Templat dasbor yang diisi hasil run (grafik, tabel, peta) — tanpa model."},
    {"id": "pipeline_produksi", "nama": "Pipeline produksi", "alur": ["produksi"],
     "fungsi": "Kontrak data, fitur & drift, skor, kinerja out-of-time, paket model.pkl + .onnx (paritas), penyimpanan fitur, publikasi, tag, deploy — bergerbang."},
]
SERVICE = {"id": "layanan_verify", "nama": "Layanan POST /verify", "alur": ["produksi", "firma", "tanya_jawab"],
           "fungsi": "Klaim → validasi skema → fitur dari penyimpanan fitur → model.pkl → telaah klinis LLM (gerbang angka, circuit breaker) → "
                     "{status, fraud_probability, ai_reasoning} untuk verifikator."}
PEOPLE = {"id": "manusia", "nama": "Auditor & verifikator BPJS", "alur": ["tanya_jawab", "firma", "produksi"],
          "fungsi": "Satu-satunya yang memutuskan: agen hanya membaca data dan menulis catatan atau usulan.",
          "aksi": [{"nama": "konfirmasi_tag", "arti": "Mengonfirmasi atau menolak tag indikasi (yang dikonfirmasi bermarking Rahasia).", "menulis": "keputusan"},
                   {"nama": "putuskan_jalur", "arti": "Menetapkan jalur faskes di box karantina: dibina, ditindak (hanya bila TSM) atau dibebaskan.", "menulis": "keputusan"},
                   {"nama": "setujui_usulan", "arti": "Menyetujui atau menolak usulan action Nexus dan misi beserta anggarannya.", "menulis": "keputusan"},
                   {"nama": "setujui_pelajaran", "arti": "Mengaktifkan atau menonaktifkan pelajaran skill (admin).", "menulis": "keputusan"},
                   {"nama": "setujui_aturan", "arti": "Menyalakan atau mematikan versi aturan rencana orkestrator hasil penyetelan GEPA, satu per model, "
                                                      "setelah melihat skornya pada pertanyaan uji (admin).", "menulis": "keputusan"},
                   {"nama": "catat_hasil_audit", "arti": "Mencatat hasil audit pilot terancang: presisi dan recall nyata.", "menulis": "keputusan"},
                   {"nama": "mulai_penugasan", "arti": "Memulai penugasan AI Agent Swarm (admin).", "menulis": "keputusan"}]}

# what was merged on 2026-10-23 (the user: "merge agent yang redundan"), measured on the two engagements of that day
# (run-29d28cc78c5b, 100 agents; run-187b14b8bfb5, 93 agents) and the tag ledger
GABUNG = [
    {"dari": ["Orkestrator (perencana)", "Penulis structuring", "Partner Pengelola (firma)"], "jadi": "Orkestrator", "dihemat": 2,
     "alasan": "Satu peran pimpinan: merencanakan, membagi tugas, menulis hasil akhir — di tanya-jawab dan di penugasan firma."},
    {"dari": ["Manajer Wilayah", "Manajer Peer", "Manajer Modus", "Manajer Kasus & Karantina", "Manajer ML"],
     "jadi": "agen domain pemilik objeknya", "dihemat": 5,
     "alasan": "Manajer menyintesis kerja di objek yang sudah dipegang agen domain: pekerjaan yang sama dua kali. Kini agen domain memimpin agen kecilnya."},
    {"dari": ["Manajer QA & Red Team", "Validator laporan (firma)", "Validator (tanya-jawab)"], "jadi": "Validator", "dihemat": 1,
     "alasan": "Satu pemeriksa dari keluarga model lain; ringkasan QA dan red team kini dihitung kode, bukan model (validator laporan firma "
               "bekerja di akhir penugasan dan tidak terhitung di angka 113)."},
    {"dari": ["9 sub-agen teknik ML firma", "9 sub-agen teknik Agen Machine Learning"], "jadi": "9 sub-agen teknik (satu set)", "dihemat": 9,
     "alasan": "Tugas sama (validasi silang per teknik). Sebagian besar tag per teknik sudah ditandai teknik lain (terutama Random Forest–Extra Trees "
               "dan XGBoost–HistGradientBoosting), jadi kini hanya mesin konsensus yang menandai."},
    {"dari": ["2 analis lensa per provinsi besar (biaya & koding, layanan & rujukan)"], "jadi": "1 analis per provinsi", "dihemat": 3,
     "alasan": "Modus kedua lensa sudah dicakup spesialis modus secara nasional; 6 analis lensa menghasilkan 4 tag ($0,43) di penugasan kedua."},
    {"dari": ["9 analis peer per kelas faskes"], "jadi": "1 analis peer lintas kelas", "dihemat": 8,
     "alasan": "Penanda otomatis sudah menandai OUTLIER_PEER tiap faskes dan spesialis modus membandingkan per tipe faskes; sembilan analis "
               "menghasilkan 1 tag (penugasan 1) dan 3 tag (penugasan 2), $0,43–0,57."},
    {"dari": ["17 Penyidik Kasus (satu agen per faskes)"], "jadi": "1 peran Penyidik kasus", "dihemat": 16,
     "alasan": "Faskes di box karantina berubah setiap penugasan dan bisa ratusan: tidak ada agen per rumah sakit. Satu peran dengan skill "
               "penyidik_kasus; saat penugasan, satu instans berkonteks segar per faskes di antrean box, sebanyak kapasitas audit."},
    {"dari": ["12 Red Team (satu agen per indikasi)"], "jadi": "1 peran Red team", "dihemat": 11,
     "alasan": "Indikasi terkuat berubah setiap penugasan: satu peran, satu instans per indikasi saat penugasan."},
    {"dari": ["Agen Konsultan Fraud (AIP)", "Agen Rujukan (BPJS)"], "jadi": "Agen Klaim & Indikasi Fraud; Agen Peserta & Rujukan", "dihemat": 2,
     "alasan": "Dua pasang agen menjawab pertanyaan yang sama; objeknya kini milik satu agen."},
]
BEFORE = {"total": 113, "rincian": "93 agen firma + 8 agen domain + 9 sub-agen teknik ML + 3 peran orkestrator (perencana, penulis, validator)"}
# what was added after the merge, on the same day: a worker per narrow scope, and a detector for a focus mode that had none
DITAMBAH = [
    {"apa": "13 analis provinsi", "jumlah": 13,
     "alasan": "Provinsi kecil tidak lagi digabung per wilayah pulau (satu analis untuk 2–5 provinsi berbagi 16 langkah): satu analis per provinsi, "
               "jatah langkah yang lebih kecil untuk provinsi < 2% klaim."},
    {"apa": "Spesialis Cloning", "jumlah": 1,
     "alasan": "Cloning (penjiplakan klaim) adalah modus fokus yang belum punya pendeteksi: kini ada tag KLONING_KLAIM, aturan klaim rawat inap "
               "kembar lintas peserta, dan spesialisnya di bawah Agen Klaim & Indikasi Fraud."},
    {"apa": "4 analis provinsi Papua hasil pemekaran", "jumlah": 4,
     "alasan": "Data memakai 38 provinsi (kolom *_38_kode), bukan 34: sejak pemekaran 2022, 26 kab/kota pindah ke Papua Barat Daya, Papua Selatan, "
               "Papua Tengah dan Papua Pegunungan. Provinsi kini dari dimensi wilayah tahap Siap Analisis (kab/kota → 38 provinsi): satu analis per provinsi."},
    {"apa": "Redaksi laporan: meja redaksi (kode), editor laporan, analis exhibit", "jumlah": 3,
     "alasan": "Setiap penugasan selesai dengan laporan lengkap (2026-10-24): editor bahasa dari keluarga lain dari penulis dan analis exhibit, di bawah "
               "meja redaksi yang menjaga angka dengan kode dan membekukan exhibit serta berkas kasus."},
]
# the mode specialists when this accounting was written (one per mode with a signal or a measure in the data,
# konsultan.roster): the roster follows the data, so the accounting adds the difference (it read 78 against 74, 2026-10-28)
MODUS_BASE = 11


def _first(doc: str, limit: int = 260) -> str:
    text = re.sub(r"\s+", " ", doc or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("; "))
    return (cut[:end + 1] if end > 80 else cut.rstrip() + " …").strip()


@lru_cache(maxsize=1)
def tool_docs() -> dict[str, str]:
    """Every tool the agents may call, by name, with the first lines of its docstring (the model reads the same text)."""
    docs: dict[str, str] = {}
    for f in ("tools.py", "firm.py"):
        tree = ast.parse((RUNTIME / f).read_text("utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
                doc = ast.get_docstring(node)
                if doc and node.name not in docs:
                    docs[node.name] = _first(doc)
    return docs


def actions(names: list[str]) -> list[dict]:
    docs = tool_docs()
    return [{"nama": n, "arti": STEPS.get(n) or docs.get(n) or "", "alat": n not in STEPS, **({"menulis": WRITES[n]} if n in WRITES else {})}
            for n in dict.fromkeys(names)]


def _scope(a: dict) -> str:
    t = a.get("target") or {}
    if a["lini"] == "wilayah":
        return ", ".join(str(p).title() for p in t.get("provinsi") or []) + (f" ({t['porsi_klaim']:.1%} klaim)" if t.get("porsi_klaim") is not None else "")
    if a["lini"] == "peer":
        return f"{len(t.get('kelas') or [])} kelas faskes"
    if a["lini"] == "modus":
        return t.get("tag", "")
    if a["lini"] == "ml":
        return f"{t.get('teknik')} ({t.get('keluarga')})"
    if a["lini"] == "kasus":
        return "instans per faskes di antrean box karantina"
    if a.get("peran_kode") == "qa":
        return f"sintesis {t.get('lead')}"
    return "indikasi terkuat di buku besar"


def _short_facility(f: dict) -> str:
    """ "Khusus Jiwa", "KOTA SINGKAWANG" → "RS Jiwa Singkawang": a facility in a few words, for a label."""
    tipe = str(f.get("tipe") or f.get("jenis") or "Faskes")
    for a, b in (("Khusus ", "RS "), ("RS Swasta Setara Type ", "RS Swasta "), ("RS TNI Polri Kelas ", "RS TNI/Polri "), ("RS Kelas ", "RS ")):
        tipe = tipe.replace(a, b)
    place = str(f.get("kabkota") or "").title().replace("Kabupaten ", "Kab. ").replace("Kota ", "")
    return f"{tipe} {place}".strip()


def _case_queue() -> list[dict]:
    """The facilities the investigators would audit now: the box's top in the order the firm assigns them (groups A … Z,
    still in quarantine or under audit) — adk_runtime/firm.py phase_3."""
    from aip import karantina as K

    try:
        r = K.box(limit=60)
    except Exception:  # noqa: BLE001 - no box yet: the investigators keep their general description
        return []
    return [f for g in ("A", "B", "C", "D", "Z") for f in r["kelompok"][g]["faskes"] if f["status"] in ("karantina", "diaudit")]


def build() -> dict:
    from aip import domains, konsultan
    from aip import models as aip_models
    from aip import skills as aip_skills

    cat = domains.catalogue()
    roles = cat["roles"]
    team, why = konsultan.roster()
    leads = {a["key"]: a for a in team if a["jenjang"] == "manajer"}
    members = [a for a in team if a["jenjang"] in ("analis", "peran")]  # a role (investigator, red team) is one agent
    skills = {s["key"]: s for s in cat.get("skills") or aip_skills.catalogue()}
    nodes: list[dict] = []
    edges: list[dict] = []

    def edge(src: str, dst: str, kind: str, label: str, flows: list[str]) -> None:
        edges.append({"dari": src, "ke": dst, "jenis": kind, "label": label, "alur": flows})

    def fam(model: str | None) -> str | None:
        return aip_models.family(model) if model else None

    def qa_skills(key: str) -> list[str]:
        return [k for k, s in skills.items() if s.get("alur") == "tanya_jawab" and key in (s.get("agen") or [])]

    # the planner's rules: a tuned version an admin switched on for the planner's model, or the code's own
    tuned = (cat.get("aturan") or {}).get("rencana") or {}
    rules_label = tuned.get("label") or f"bawaan (kode, agents.PLAN_RULES) untuk {aip_models.MODELS.get(roles.get('planner') or '', {}).get('label', roles.get('planner'))}"

    nodes.append({"id": "orkestrator", "nama": "Orkestrator", "jenis": "pimpinan", "induk": None, "alur": ["tanya_jawab", "firma"],
                  "alias": ["Partner (penugasan firma)", "Penulis structuring"], "model": roles.get("planner"), "keluarga": fam(roles.get("planner")),
                  "skill": ["rencana_penugasan", "laporan_akhir"],
                  "fungsi": "Peran perencana dalam arsitektur tiga peran. Merencanakan tugas sempit (skill per tugas), milestone dan KONTRAK VALIDASI sebelum "
                            "pekerja mulai; hanya agen yang relevan yang dipanggil, dan pertanyaan yang tidak butuh data dijawabnya langsung (tanpa "
                            "agen domain dan validator); membentuk agen kecil; menulis structuring dari serah-terima mereka, dan laporan akhir firma "
                            "kerangka dulu (poin bersumber, tiap bagian dari sumbernya, digabung kode); merevisi bila validator menemukan yang tidak "
                            f"bertahan; menutup run dengan pelajaran skill. Aturan rencana tanya-jawab yang dipakai: {rules_label}.",
                  "aturan": rules_label,
                  "aksi": actions(["susun_rencana", "aturan_rencana", "jawab_langsung", "kontrak_validasi", "bentuk_agen_kecil", "tulis_jawaban", "kerangka_laporan",
                                   "tulis_bagian", "executive_summary", "revisi", "rencana_penugasan", "rencana_misi", "encode_pelajaran", *SEM, "lihat_indikasi", "lihat_karantina"])})
    nodes.append({"id": "validator", "nama": "Validator", "jenis": "validator", "induk": None, "alur": ["tanya_jawab", "firma"],
                  "alias": ["Validator laporan (firma)", "Manajer QA & Red Team"], "model": roles.get("validator"), "keluarga": fam(roles.get("validator")),
                  "skill": ["reviewer_qa", "red_team"],
                  "fungsi": "Peran validator dalam arsitektur tiga peran, dari keluarga model lain dari penulis: tidak pernah melihat penalaran pekerja, "
                            "membaca data sendiri seperti pengguna, menilai setiap klaim angka dan setiap pernyataan kontrak. Memimpin reviewer QA (satu "
                            "per sintesis) dan red team. Tidak menulis data.",
                  "aksi": actions([*SEM, *READ, "lihat_indikasi", "lihat_karantina", "telusuri_lineage", "kartu_model_ml", "putusan_validator"])})
    edge("validator", "orkestrator", "memeriksa", "angka dan kontrak di jawaban dan laporan akhir", ["tanya_jawab", "firma"])

    n_lessons = sum(len(s.get("pelajaran") or []) for s in skills.values())
    nodes.append({"id": "shared_state", "nama": "Shared state", "jenis": "state", "induk": None, "alur": ["tanya_jawab", "firma", "produksi"],
                  "isi": ["rencana & tugas (skill per tugas)", "kontrak validasi", "serah-terima tiap pekerja", f"skill + {n_lessons} pelajaran aktif",
                          "buku besar indikasi (tag)", "box karantina", "hasil tool (hasil_id)"],
                  "fungsi": "Tempat agen berkoordinasi dalam satu run, penugasan atau misi: orkestrator menulis rencana, kontrak dan skill; pekerja membaca "
                            "kontrak dan skill lalu menulis serah-terima dan tag; validator membaca kontrak dan serah-terima. Juga aturan rencana yang "
                            "aktif per model dan, di penugasan firma, kerangka laporan (poin + sumber) yang dibaca penulis tiap bagian. Tidak ada pesan "
                            "langsung antaragen, jadi state tidak terpecah.",
                  "aksi": []})
    edge("orkestrator", "shared_state", "berbagi_state", "menulis rencana, kontrak validasi, skill per tugas", ["tanya_jawab", "firma"])
    edge("validator", "shared_state", "berbagi_state", "membaca kontrak dan serah-terima; menulis putusan", ["tanya_jawab", "firma"])

    ml_key = next((a["key"] for a in cat["agents"] if "kartu_model_ml" in a["tools"]), "machine_learning")
    for a in cat["agents"]:
        key = a["key"]
        firm_tools = LEAD_IN_FIRM + (["lihat_karantina"] if key == "klaim_fraud" else []) if key in leads else []
        nodes.append({"id": key, "nama": a["name"].replace(" (BPJS)", ""), "jenis": "agen_domain", "induk": "orkestrator",
                      "alur": ["tanya_jawab"] + (["firma"] if key in leads else []), "peta": a.get("peta"), "menjawab": a.get("menjawab"),
                      "model": a.get("model"), "keluarga": fam(a.get("model")), "objek": [t["name"] for t in a["object_types"]],
                      "skill": qa_skills(key) + (["sintesis_agen_domain"] if key in leads else []),
                      "fungsi": a.get("description") or "", "memimpin": sum(1 for m in members if m["induk"] == key),
                      "aksi": actions(list(a["tools"]) + ["serah_terima"] + firm_tools)})
        edge("orkestrator", key, "memimpin", "tugas sempit berskill · serah-terima" + (" · fokus lini · sintesis" if key in leads else ""),
             ["tanya_jawab"] + (["firma"] if key in leads else []))
        edge(key, "shared_state", "berbagi_state", "membaca kontrak dan skill; menulis serah-terima" + (" dan tag" if key in leads else ""),
             ["tanya_jawab"] + (["firma"] if key in leads else []))
        if "usulkan_action" in a["tools"]:
            edge(key, "manusia", "menyerahkan", "usulan action Nexus (persetujuan)", ["tanya_jawab"])
    domain_keys = [a["key"] for a in cat["agents"]]
    # a lead of the firm that is no domain agent (the report desk: code that runs its editor and exhibit analyst) gets its
    # own node under the orchestrator, so its members hang off it (they floated without a lead, 2026-10-27)
    for key, a in leads.items():
        if key in domain_keys or key in ("validator", "partner"):
            continue
        nodes.append({"id": key, "nama": a["name"], "jenis": "agen_domain", "induk": "orkestrator", "alur": ["firma"], "model": a.get("model"),
                      "keluarga": None if a.get("model") == "kode" else fam(a.get("model")), "objek": [], "skill": [],
                      "fungsi": a.get("peran") or a["name"], "memimpin": sum(1 for m in members if m["induk"] == key),
                      "aksi": actions(["serah_terima"])})
        edge("orkestrator", key, "memimpin", f"lini {a.get('lini') or key}", ["firma"])

    nodes.append({"id": "agen_kecil_pertanyaan", "nama": "Agen kecil per pertanyaan", "jenis": "dinamis", "induk": "orkestrator", "alur": ["tanya_jawab"],
                  "skill": [k for k, s in skills.items() if s.get("alur") == "tanya_jawab"],
                  "fungsi": "Pekerja dengan konteks segar untuk satu tugas sempit sebuah pertanyaan: satu per hal yang dicakup (provinsi, kelas, modus, kode, "
                            "teknik), paling banyak 16, 8 bekerja bersamaan (baca-saja, tidak bisa konflik); memakai tool, izin dan skill yang ditetapkan "
                            "orkestrator, menyerahkan serah-terima, lalu hilang setelah jawaban.",
                  "aksi": actions(READ + ["usulkan_action", "serah_terima"])})
    edge("orkestrator", "agen_kecil_pertanyaan", "membentuk", "satu per cakupan pertanyaan, dengan skill", ["tanya_jawab"])
    for key in domain_keys:
        edge(key, "agen_kecil_pertanyaan", "memimpin", "tool dan izinnya dipinjamkan", ["tanya_jawab"])

    ml_agent = next((a for a in cat["agents"] if a["key"] == ml_key), {})
    subs = {s["key"]: s for s in ml_agent.get("subagents") or []}
    for s in subs.values():
        model = next((m["model"] for m in members if m["key"] == s["key"]), roles.get("tools"))
        nodes.append({"id": s["key"], "nama": s["name"], "jenis": "sub_agen", "induk": ml_key, "lini": "ml", "alur": ["tanya_jawab", "firma"],
                      "model": model, "keluarga": fam(model), "cakupan": f"{s['technique']} ({s['family']})", "skill": ["sub_agen_teknik"],
                      "fungsi": f"Menjalankan validasi silang {s['technique']} ({s['family']}) pada klaim rumah sakit nyata, lipatan sama untuk semua teknik; "
                                f"melaporkan metrik dan 25 faskes teratasnya ke konsensus. Riset: {'; '.join(s.get('research') or []) or '-'}.",
                      "aksi": actions(["jalankan_teknik", "serah_terima"])})
        edge(ml_key, s["key"], "memimpin", "dibentuk per pertanyaan dan di penugasan · metrik", ["tanya_jawab", "firma"])
        edge(s["key"], "konsensus_ml", "mengumpankan", "25 faskes teratas", ["firma"])

    queue = _case_queue()
    for m in members:
        if m["key"] in subs:
            continue
        work = "red_team" if m.get("peran_kode") == "red_team" else m["lini"]
        role = m["jenjang"] == "peran"
        cap = int((m.get("target") or {}).get("kapasitas") or 0)
        extra: dict = {}
        if role:
            # a role, not an agent per case: its skill and capacity, and what it would take from its queue now
            extra = {"dinamis": True, "kapasitas": cap, "pendek": f"{m['name']} ×{cap}"}
            if m["key"] == "penyidik_kasus":
                extra["antrean"] = [{"faskes_profil_id": f["faskes_profil_id"], "nama": f["nama"], "pendek": _short_facility(f), "kelompok": f["kelompok"],
                                     "estimasi_kerugian_rp": f["estimasi_kerugian_rp"]} for f in queue[:cap]]
                extra["antrean_total"] = len(queue)
        nodes.append({"id": m["key"], "nama": m["name"] + (" (peran dinamis)" if role else ""), "jenis": "agen_kecil", "induk": m["induk"], "lini": m["lini"],
                      "alur": ["firma"], "model": m.get("model"), "keluarga": fam(m.get("model")),
                      "cakupan": (f"dinamis: sampai {cap} instans per penugasan, dari {(m.get('target') or {}).get('antrean')}" if role else _scope(m)),
                      "fungsi": m.get("peran", ""), **extra,
                      "skill": [FIRM_SKILL[work]] if work in FIRM_SKILL else [],
                      "aksi": actions(FIRM_ACTIONS.get(work, SEM + READ) + ["serah_terima"])})
        if m["key"] == "penyidik_kasus":
            edge("karantina", m["key"], "mengumpankan", "antrean faskes: kelompok A → Z", ["firma"])
        edge(m["induk"], m["key"], "memimpin", _scope(m), ["firma"])
        if m.get("peran_kode") == "qa" and (m.get("target") or {}).get("lead"):
            edge(m["key"], m["target"]["lead"], "memeriksa", "memeriksa sintesisnya ke data", ["firma"])
        if m.get("peran_kode") == "red_team":
            edge(m["key"], "shared_state", "menantang", "indikasi terkuat di buku besar", ["firma"])

    # the small agents read the ML scores and call /verify with their tools: one edge per lead, not one per agent
    for lead in leads:
        works = {"red_team" if m.get("peran_kode") == "red_team" else m["lini"] for m in members if m["induk"] == lead and m["key"] not in subs}
        if any("verifikasi_klaim" in FIRM_ACTIONS.get(w, []) for w in works):
            edge(lead, ml_key, "memakai", "agen kecilnya membaca skor risiko model", ["firma"])
            edge(lead, "layanan_verify", "memakai", "agen kecilnya memanggil verifikasi_klaim", ["firma"])

    for mc in MACHINES:
        nodes.append({**mc, "jenis": "mesin", "induk": None, "aksi": []})
    edge("validator_scrutiny", "orkestrator", "memeriksa", "rujukan, cakupan, angka bersumber — sebelum validator", ["tanya_jawab", "firma"])
    for lead in leads:
        if lead != "validator":
            edge("validator_scrutiny", lead, "memeriksa", "milestone: serah-terima, prosedur skill, aturan TSM", ["firma"])
    edge("penanda_otomatis", "shared_state", "mengumpankan", "tag tiap sinyal ke buku besar", ["firma", "produksi"])
    edge("konsensus_ml", "shared_state", "mengumpankan", "tag KONSENSUS_TEKNIK_ML", ["firma"])
    edge("karantina", "shared_state", "mengumpankan", "faskes per kelompok A … Z, sinyal TSM", ["firma", "produksi"])
    edge("shared_state", "sinkron_nexus", "mengumpankan", "buku besar → objek Nexus bermarking", ["firma"])
    edge("orkestrator", "penyusun_layar", "mengumpankan", "jawaban → layar dari templat", ["tanya_jawab"])
    edge("penyetel_aturan", "orkestrator", "menyetel", "aturan rencana tanya-jawab per model, dari skor kode pada 47 pertanyaan berlabel", ["tanya_jawab"])
    edge("penyetel_aturan", "manusia", "menyerahkan", "versi aturan baru sebagai usulan; admin yang menyalakan", ["tanya_jawab"])
    edge("pipeline_produksi", "layanan_verify", "mengumpankan", "deploy model.pkl + penyimpanan fitur", ["produksi"])
    edge("pipeline_produksi", "penanda_otomatis", "mengumpankan", "tahap tag & karantina", ["produksi"])
    edge(ml_key, "pipeline_produksi", "memakai", "model terlatih dikemas dan dipantau", ["produksi"])
    nodes.append({**SERVICE, "jenis": "layanan", "induk": None, "model": None,
                  "aksi": [{"nama": "POST /verify", "arti": "Skor model.pkl, alasan SHAP, tag aturan semantik, telaah klinis LLM; status INDIKASI_KUAT / "
                                                            "PERLU_DIPERIKSA / WAJAR.", "alat": False}]})
    edge(ml_key, "layanan_verify", "memakai", "verifikasi_klaim", ["tanya_jawab"])
    edge("layanan_verify", "manusia", "menyerahkan", "status, fraud_probability, ai_reasoning", ["produksi"])
    nodes.append({**PEOPLE, "jenis": "manusia", "induk": None})
    edge("orkestrator", "manusia", "menyerahkan", "structuring dan laporan akhir", ["tanya_jawab", "firma"])
    edge("klaim_fraud", "manusia", "menyerahkan", "tag untuk dikonfirmasi · rekomendasi jalur box karantina", ["firma"])
    edge("shared_state", "manusia", "menyerahkan", "pelajaran skill dari run non-admin (usulan)", ["tanya_jawab"])

    # the fraud modes of Permenkes 16/2019: one node each, and who detects it in this data
    from aip import semantik as S

    for mode in S.MODUS_PERMENKES:
        mid = f"modus_{mode['id']}"
        nodes.append({"id": mid, "nama": (f"{mode['fokus_nama']} — " if mode["fokus"] else "") + mode["nama"], "pendek": MODE_SHORT.get(mode["id"], mode["nama"]),
                      "jenis": "modus", "induk": None, "alur": ["tanya_jawab", "firma", "produksi"], "fokus": mode["fokus"], "no": mode["no"],
                      "deteksi": mode["deteksi"], "faskes": mode["faskes"], "tag": mode["tag"], "dasar": mode["dasar"],
                      "fungsi": f"{mode['arti']} Di data ini: {mode['deteksi']} — {mode['dasar']}", "aksi": []})
        found = False
        for tag in mode["tag"]:
            for m_ in members:
                if (m_.get("target") or {}).get("tag") == tag:
                    edge(m_["key"], mid, "mendeteksi", f"tag {tag}", ["firma"])
                    found = True
            if tag in S.TAG:
                edge("penanda_otomatis", mid, "mendeteksi", f"aturan → tag {tag}", ["firma", "produksi"])
                found = True
        for other in MODE_EXTRA.get(mode["id"], []):
            edge(other, mid, "mendeteksi", "skor model" if other == ml_key else "telaah klinis LLM" if other == "layanan_verify" else "objek klinisnya",
                 ["tanya_jawab", "produksi"])
            found = True
        nodes[-1]["terdeteksi_oleh"] = found

    agents = [n for n in nodes if n["jenis"] not in ("mesin", "layanan", "manusia", "dinamis", "state", "modus")]
    ids = {n["id"] for n in nodes}
    edges = [e for e in edges if e["dari"] in ids and e["ke"] in ids]
    added = list(DITAMBAH)
    n_modus = next((w["agen"] for w in why if w["lini"] == "modus"), MODUS_BASE)
    if n_modus != MODUS_BASE:
        d = n_modus - MODUS_BASE
        added.append({"apa": f"{d} spesialis modus yang kini bersinyal di data" if d > 0 else f"{-d} spesialis modus yang kini tanpa sinyal (dikurangi)", "jumlah": d,
                      "alasan": f"Spesialis modus mengikuti data: satu per modus Permenkes yang punya sinyal atau ukuran di buku besar — kini {n_modus}, "
                                f"saat hitungan ini ditulis {MODUS_BASE}."})
    konsep = [dict(k) for k in KONSEP]
    for k in konsep:
        if k["konsep"] == "Model yang tepat per peran":
            k["di_aip"] = (f"Perencanaan: {roles.get('planner')} (berpikir mendalam); implementasi: agen domain {roles.get('tools')}, agen kecil firma "
                           f"bergilir GLM / DeepSeek / gpt-oss; validasi: {roles.get('validator')} — keluarga lain dari penulis.")
    return {
        "simpul": nodes, "hubungan": edges, "jenis_simpul": KINDS, "jenis_hubungan": RELATIONS, "alur": FLOWS, "konsep": konsep,
        "ringkasan": {"agen": len(agents), "per_jenis": {k: sum(n["jenis"] == k for n in agents) for k in KINDS if any(n["jenis"] == k for n in agents)},
                      "sebelum": BEFORE, "gabung": GABUNG, "dihemat": sum(g["dihemat"] for g in GABUNG), "ditambah": added,
                      "jumlah_ditambah": sum(d["jumlah"] for d in added), "ukuran_firma": why,
                      "skill": len(skills), "pelajaran_aktif": n_lessons,
                      "model_per_peran": {"perencanaan": roles.get("planner"), "implementasi": roles.get("tools"), "validasi": roles.get("validator")},
                      "aturan_rencana": rules_label,
                      "modus": {"total": len(S.MODUS_PERMENKES), "fokus": [m["fokus_nama"] for m in S.MODUS_PERMENKES if m["fokus"]],
                                "per_deteksi": {d: sum(m["deteksi"] == d for m in S.MODUS_PERMENKES) for d in ("terdeteksi", "sinyal", "aturan", "tidak ada data")}},
                      "catatan": "Agen kecil per pertanyaan tidak dihitung: dibentuk dan hilang bersama satu pertanyaan."},
    }


@router.get("/jaringan")
def network() -> dict:
    """Every agent, its function, skills and actions, and every relation between them (and to the shared state, the
    machines and people)."""
    return build()
