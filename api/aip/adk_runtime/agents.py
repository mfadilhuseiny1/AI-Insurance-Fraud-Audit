"""The ADK agents of one run, each on the model of its role (aip/models.py), reached through the platform's gateway.

Instructions are passed as callables, so ADK does not treat the braces of their JSON examples as state variables.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Optional

from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm

from aip import models as aip_models

LANG = "Jawab dalam bahasa Indonesia, ringkas dan tepat. Jangan mengarang angka, nama, kode atau id: ambil fakta dengan tool."


class Models:
    def __init__(self, api: str, token: str, run_id: str):
        self.api, self.token, self.run_id = api.rstrip("/"), token, run_id

    def llm(self, model_id: str, agent: str, max_tokens: int = 3000, temperature: float = 0.1, think: str = "") -> LiteLlm:
        # LiteLLM's OpenAI provider pointed at the platform: the model id is the registry id (vertex/…). By default the
        # models do not deliberate at length (tool steps need decisions, not essays); `think` asks for real reasoning
        # where the answer's quality depends on it — "medium" (gpt-oss: the validator), "deep" (GLM: the briefing).
        fam = aip_models.family(model_id)
        extra: dict = {"reasoning_effort": "medium" if think else "low"} if fam == "openai" else {}
        if fam == "zai-org" and think != "deep":
            # GLM thinks aloud in its answer unless told not to: a plan in 1.7 s and ~110 tokens instead of 700+ (2026-10-22)
            extra["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
        return LiteLlm(model=f"openai/{model_id}", api_base=f"{self.api}/api/aip/openai/v1", api_key=self.token or "local",
                       extra_headers={"X-AIP-Run": self.run_id, "X-AIP-Agent": agent}, max_tokens=max_tokens, temperature=temperature,
                       timeout=aip_models.client_timeout(max_tokens), num_retries=1, **extra)


def _const(text: str) -> Callable[[Any], str]:
    return lambda _ctx: text


def _schema(agent: dict, full: bool = True) -> str:
    """The object types an agent answers for: name, key, title, properties (api_name:type)."""
    lines = []
    for t in agent["object_types"]:
        props = ", ".join(f"{p['api_name']}:{p['type']}" for p in t["properties"][: 60 if full else 16])
        lines.append(f"- {t['name']} (kunci {t['primary_key']}, judul {t['title']}): {t['description'][:200]}\n  properti: {props}")
    return "\n".join(lines)


# The planner's rules: the part of its prompt that aip/optimasi.py tunes per model (GEPA, on the scored question set
# aip/golden/rencana.json). An admin-activated version for the planner's model (aip/skills.py "aturan") takes this text's
# place; the catalogue, the question, the skills and the JSON the code reads stay as planner_text writes them.
PLAN_RULES = """PETA PERTANYAAN — AI Agent Swarm sudah menganalisis seluruh data; pertanyaan yang lazim DIBACA dari laporannya (jalur
audit, paket audit yang disusun kode dalam sekali baca), bukan dianalisis ulang oleh agen. Contoh pertanyaan → rencana:
- "Berapa klaim berisiko di Bali?" → audit {"provinsi": "BALI"}; "Berapa total klaim berisiko nasional, berapa persen sudah
  dikoreksi?" → audit {}; "Provinsi mana paling banyak klaim berisiko dan indikasi utamanya?" → audit {}
- "Bandingkan Aceh, Sumatera Utara dan Riau …" → audit [{"provinsi": "ACEH"}, {"provinsi": "SUMATERA UTARA"}, {"provinsi": "RIAU"}];
  "Bandingkan modus klaim ganda dan kloning" → audit [{"modus": "klaim ganda"}, {"modus": "kloning klaim"}]; "biaya tagih vs
  verifikasi per bulan 2025 Jawa Barat dan Jawa Tengah" → audit [{"provinsi": "JAWA BARAT", "bulan_dari": "2025-01", "bulan_sampai":
  "2025-12"}, {"provinsi": "JAWA TENGAH", "bulan_dari": "2025-01", "bulan_sampai": "2025-12"}]
- "Rasio klaim berisiko per 1.000 klaim antara RS kelas A, B, C, D" → audit {} (bagian per kelas rumah sakit)
- "Kode INA-CBG dengan persentase selisih verifikasi tertinggi dan diagnosisnya" → audit {}; "Diagnosis paling sering di klaim
  berisiko Jawa Timur" → audit {"provinsi": "JAWA TIMUR"}; "Kode paling sering pada klaim LOS ekstrem" → audit {"flag": ["los_ekstrem"]}
- "Tren klaim berisiko per bulan nasional 2024" → audit {"bulan_dari": "2024-01", "bulan_sampai": "2024-12"}
- "10 faskes teratas Box Karantina kelompok A" → audit {"kelompok": "A"}; "Faskes mana yang perlu diaudit dulu di Jawa Tengah" →
  audit {"provinsi": "JAWA TENGAH"}; "Profil RS … Sragen" → audit {"faskes": "Sragen"}
- "Klaim RS Jawa Timur yang berisiko menurut model tetapi lolos verifikasi" → audit {"provinsi": "JAWA TIMUR", "modus": "lolos verifikasi"}
- Bukan dari laporan: asal data dan lineage, skema Nexus, kode transform (Agen Data); rujukan dan peserta; kartu model ML
  (satu tugas Agen ML); membentuk sub-agen, menguji atau melatih model baru — itu analisis baru oleh agen.

Susun rencana sebagai TUGAS SEMPIT untuk agen-agen kecil. Tiap tugas dikerjakan satu agen kecil milik agen domain yang
memegang objeknya (lihat daftar properti), dengan instruksi jelas: objek mana, properti mana, angka apa yang dihitung.
- Pertanyaan sederhana: 1–3 tugas.
- Pertanyaan yang mencakup atau membandingkan banyak hal (beberapa provinsi, kelas rumah sakit, modus, kode INA-CBG,
  periode): SATU tugas per hal — paling banyak 16 — supaya tiap agen kecil fokus pada satu cakupan dan semuanya
  bekerja bersamaan; tambahkan satu tugas pembanding (mis. angka nasional) bila perbandingan butuh patokan.
- Beberapa teknik ML: SATU tugas untuk Agen Machine Learning — ia membentuk sub-agen per teknik sendiri (lipatan yang
  sama, uji berpasangan terkoreksi), jadi jangan dipecah per teknik.
- Jangan membuat tugas yang tidak diperlukan pertanyaan.
- Tiap tugas memakai SATU skill (prosedur kerja agen kecil) dari daftar skill di bawah.
- KONTRAK VALIDASI, ditulis sekarang sebelum agen bekerja: 3–6 pernyataan yang harus benar agar jawaban dianggap benar dan
  lengkap — tentang jawabannya, bukan cara kerja (mis. "kelima provinsi yang ditanyakan dibandingkan dengan ukuran yang sama",
  "provinsi paling menonjol ditentukan dari rasio per 1.000 klaim, bukan jumlah mentah", "setiap angka menyebut hasil_id").
  Validator yang tidak melihat cara kerja agen akan memeriksa jawaban terhadap kontrak ini.
- JALUR LANGSUNG, hanya bila pertanyaan TIDAK butuh data platform: salam atau terima kasih, cara memakai AIP JKN, arti istilah
  umum (mis. "apa itu INA-CBG?"), atau di luar lingkup JKN/BPJS. Maka tanpa tugas dan tanpa kontrak: "jalur": "langsung" dan
  "jawaban" (bahasa Indonesia, sepanjang yang diminta di bawah; di luar lingkup: jangan jawab isinya — katakan AIP JKN menjawab
  pertanyaan tentang data klaim JKN dan beri satu contoh pertanyaan tanpa angka). Jawaban langsung TANPA angka dan tanpa fakta
  dari data. Begitu pertanyaan menyangkut klaim,
  faskes, peserta, wilayah, tag, box karantina atau model — sekecil apa pun — pakai agen.
- JALUR CEPAT ("jalur": "cepat"): jawabannya cukup DIBACA dari data — hasil AI Agent Swarm (Karantina Faskes, Indikasi
  Fraud) atau satu tipe objek: daftar, peringkat, rincian satu entitas, drill-down satu wilayah atau faskes — dengan paling
  banyak 2 tugas, tanpa perbandingan lintas sumber, tanpa model ML. Selebihnya alur lengkap ("jalur": "agen").
- AI AGENT SWARM DULU — JALUR AUDIT ("jalur": "audit"): AI Agent Swarm sudah menganalisis seluruh data; pertanyaan tentang
  SATU cakupan — wilayah, faskes, kode INA-CBG, diagnosis, modus, atau kelompok klaim (LOS ekstrem, dikoreksi, readmisi,
  calon ganda) — misalnya estimasi kerugiannya, faskes yang perlu diaudit, modus yang menonjol, atau audit/analisis lengkap
  cakupan itu, dijawab DULU dari hasilnya, bukan dianalisis ulang. Kode menyusun PAKET AUDIT dari hasil AI Agent Swarm dalam
  sekali baca (angka kunci dan pembanding nasional dan peringkat; sebaran per provinsi atau kab/kota dengan indikasi utamanya;
  komposisi modus; faskes prioritas urutan Box Karantina dengan TSM, jalur, readmisi dan LOS; tren per bulan dengan tagihan dan
  dibayar; kode INA-CBG dan diagnosis dengan rasio koreksi dan pasangannya; per kelas rumah sakit per 1.000 klaim; klaim
  penyumbang kerugian; temuan analis dan rekomendasi penyidik konsultan) — tanpa tugas agen; bila paket kosong, agen klaim
  mencari sendiri. Isi "audit" hanya dengan yang disebut: provinsi, kabkota (HURUF BESAR), faskes (nama atau id), inacbg_kode,
  diagnosis (kode ICD-10 3 karakter atau nama), modus, kelompok (Box Karantina: "A" atau "A,B"), flag (daftar: los_ekstrem,
  koreksi, readmisi, klaim_ganda, rawat_inap), bulan_dari, bulan_sampai (YYYY-MM); {} = nasional. MEMBANDINGKAN beberapa
  cakupan (provinsi, modus, kode; paling banyak 6): "audit" berisi DAFTAR cakupan, satu per hal — paket per cakupan dan tabel
  perbandingannya. Kelas rumah sakit dibandingkan lewat bagian per kelas paket nasional atau wilayah. Tugas agen hanya untuk hal
  di luar paket (rujukan, peserta, model ML, lineage), paling banyak 2.
- PERTANYAAN LANJUTAN tentang objek yang sudah dibahas (provinsi, kab/kota, faskes, kode, kelompok klaim): isi "fokus"
  dengan objek itu (mis. ["SULAWESI SELATAN"]) dan perdalam DI DALAMNYA — setiap tugas difilter ke fokus (mis. faskes di
  provinsi itu dengan estimasi kerugian, klaim bertag dan jenis indikasinya; komposisi jenis indikasi di provinsi itu).
  Kata ganti ("-nya", "itu", "tersebut") merujuk ke HIMPUNAN DATA jawaban sebelumnya ("data yang dibaca"): kerjakan pada tipe
  objek dan filter yang SAMA, ditambah fokusnya. Bila jawaban sebelumnya menunjuk SATU entitas ("mana yang paling …" → satu
  kode, faskes, provinsi, diagnosis), "-nya" adalah entitas itu DI DALAM himpunan yang sama: mis. "Kode INA-CBG mana yang paling
  sering pada klaim LOS ekstrem?" → O-6-10-I, lalu "berapa estimasi kerugiannya?" = jalur audit {"inacbg_kode": "O-6-10-I",
  "flag": ["los_ekstrem"]}, fokus ["O-6-10-I"]. Jangan memperluas ke angka nasional atau objek lain — tanpa tugas dan tanpa
  kontrak "nasional" — dan jangan membandingkan ulang dengan wilayah atau objek lain, kecuali pengguna memintanya.
- ESTIMASI KERUGIAN sekumpulan klaim (kode INA-CBG, LOS ekstrem, wilayah, diagnosis): jalur audit dengan cakupan himpunan
  itu (di dalam tugas agen: alat estimasi_kerugian_klaim pada filternya) — aturan yang sama dengan Box Karantina; jumlah
  selisih_rp saja adalah yang SUDAH dikoreksi verifikator, bukan kerugian. estimasi_kerugian_rp di Karantina Faskes adalah
  per faskes, untuk pertanyaan tentang faskes.
- Hal yang tidak ada di properti objek mana pun di atas (mis. identitas dokter: daftar properti itu lengkap) TIDAK dijadikan
  tugas untuk dicari: sebut di "ringkasan" bahwa data itu tidak tersedia, supaya jawaban menyatakannya, bukan menebak."""


def plan_rules(catalogue: dict) -> dict:
    """The tuned rules the planner runs on: the active version for the planner's model ({} = PLAN_RULES)."""
    tuned = (catalogue.get("aturan") or {}).get("rencana") or {}
    return tuned if tuned.get("teks") and tuned.get("model") == catalogue["roles"]["planner"] else {}


def planner_text(catalogue: dict, question: str, history: list[dict], voice: bool = False, rules: str = "") -> str:
    """The planner's prompt: the agents and their objects, the question and the conversation, the rules (PLAN_RULES or a
    tuned version), the skills, and the JSON the code reads. aip/optimasi.py scores rules with exactly this text."""
    def objs(a: dict) -> str:
        if not a["object_types"]:
            return "sumber daya platform (dataset, pipeline, lineage, kode)"
        return "; ".join(f"{t['name']} [{', '.join(p['api_name'] for p in t['properties'][:16])}]" for t in a["object_types"])

    def extra(a: dict) -> str:
        if "kartu_model_ml" in (a.get("tools") or []):
            return ("\n  Alat ML: kartu model (akurasi, F1, AUPRC, benchmark teknik + rujukan riset), kartu bukti model (precision@k pada "
                    "kapasitas audit, lift, recall rupiah, ablasi vs aturan, negatif sulit), skor risiko klaim, risiko faskes, penjelasan "
                    "multi-metode, benchmark baru — pilih agen ini untuk pertanyaan tentang model, prediksi, akurasi, teknik ML atau bukti kinerja model")
        if "estimasi_kerugian_klaim" in (a.get("tools") or []):
            return ("\n  Alat estimasi_kerugian_klaim: estimasi kerugian sekumpulan klaim (filter apa pun: kode INA-CBG, LOS ekstrem, "
                    "wilayah, diagnosis, faskes) dengan aturan Box Karantina, dan yang sudah dikoreksi verifikator terpisah")
        return ""

    agents = "\n".join(f"- {a['key']}: {a['name']} — {a['description']}\n  Objek: {objs(a)}{extra(a)}" for a in catalogue["agents"])
    # a follow-up refers to the previous answer's names and numbers ("yang kedua", "faskes itu"): the answer, not a stub of it
    # and the data each answer was read from (runs._scope): a follow-up's "-nya" is that set of data, not the whole of it
    hist = "\n".join(f"{h['role']}: {h['text'][:1800 if h['role'] == 'assistant' else 400]}"
                     + (f"\n  (data yang dibaca untuk jawaban ini: {h['data']})" if h.get("data") else "") for h in history[-6:])
    skills = "\n".join(f"- {s['key']}: {s['nama']} — {s['untuk']}" for s in catalogue.get("skills") or [] if s.get("alur") == "tanya_jawab")
    return f"""Anda Orkestrator AIP JKN (BPJS Kesehatan). Setiap objek Nexus punya agen yang bertanggung jawab atasnya:
{agents}

Pertanyaan pengguna: {question}
{('Percakapan sebelumnya (pertanyaan ini lanjutannya: pahami rujukan seperti "itu", "yang kedua", "faskes tersebut" dari sini):' + chr(10) + hist) if hist else ''}

{(rules or PLAN_RULES).strip()}

Skill (prosedur kerja agen kecil) yang bisa ditetapkan per tugas:
{skills or '- umum: tugas umum'}
Panjang jawaban jalur langsung: {'1–2 kalimat untuk dibacakan' if voice else '2–4 kalimat'}.
Jawab HANYA JSON:
{{"ringkasan": "<rencana satu kalimat>", "jalur": "<agen|cepat|audit>", "fokus": ["<objek yang sedang dibahas, kosong bila tidak ada>"],
 "audit": {{"<hanya untuk jalur audit: provinsi|kabkota|faskes|inacbg_kode|diagnosis|modus|kelompok|bulan_dari|bulan_sampai>": "<nilai>", "flag": []}}
   (membandingkan: [{{...}}, {{...}}]),
 "tugas": [{{"agen": "<key agen>", "skill": "<key skill>", "cakupan": "<hal yang dikerjakan, singkat, mis. JAWA BARAT>", "instruksi": "<tugas sempit>"}}],
 "kontrak": ["<pernyataan>"]}}
atau, untuk jalur langsung: {{"ringkasan": "<satu kalimat>", "jalur": "langsung", "jawaban": "<jawaban>", "tugas": [], "kontrak": []}}"""


def planner(m: Models, catalogue: dict, question: str, history: list[dict], voice: bool = False) -> LlmAgent:
    text = planner_text(catalogue, question, history, voice, plan_rules(catalogue).get("teks", ""))
    # a chat question wants its answer in about a minute (user, 2026-10-23): no thinking aloud here (11–56 s with it); the
    # mission planner (main.mission_plan) and the consultancy still deliberate
    return LlmAgent(name="orkestrator", model=m.llm(catalogue["roles"]["planner"], "orkestrator", 3000), instruction=_const(text),
                    output_key="rencana")


def domain_agent(m: Models, agent: dict, task: str, tools: list, model_id: str, skill: str = "", contract: str = "", handoff: str = "") -> LlmAgent:
    text = f"""Anda {agent['name']}: {agent['description']}
Anda bertanggung jawab atas objek Nexus berikut, dan hanya objek ini yang bisa Anda baca:
{_schema(agent) or '- (sumber daya platform: dataset, pipeline, lineage, kode)'}

Tugas dari orkestrator: {task}

Cara kerja: panggil tool untuk setiap fakta (cari_objek, agregasi_objek, detail_objek, objek_terkait, jalankan_fungsi).
Pakai api_name properti persis seperti di daftar. Bacaan yang tidak saling bergantung (mis. angka cakupan dan
pembandingnya, beberapa agregasi) panggil SEKALIGUS: beberapa tool call dalam satu langkah — jawaban lebih cepat. Bekerjalah seperti auditor senior, bukan sekadar menghitung:
- besaran dan peringkat (posisi dari berapa), pangsa (% dari total), dan pembanding (rata-rata nasional/provinsi/peer,
  peringkat berikutnya) — hitung pembanding itu dengan tool, jangan dikira-kira;
- sebut objek dengan NAMA-nya (kolom "nama", nama_profil, kabkota, deskripsi), bukan id/hash; id hanya bila tidak ada nama;
- pola dan indikasi yang menonjol, dan apa yang belum bisa disimpulkan dari data.
Tulis temuan Anda: angka penting dengan konteksnya, objek kunci (nama), dan hasil_id sumber tiap angka (mis. [r3]).
RINGKAS: paling banyak ~350 kata. Jangan merekap langkah kerja atau menyalin daftar objek — tabel lengkapnya tampil di
layar lewat hasil_id (laporan yang terlalu panjang terpotong dan kesimpulannya hilang).
Bila tugas memerlukan objek agen lain, katakan itu. Bila ada objek yang perlu ditahan/diperiksa, Anda boleh memakai
usulkan_action — manusia yang memutuskan. {LANG}"""
    if "kartu_model_ml" in (agent.get("tools") or []):
        text += "\n\n" + ML_RULES
    if skill:
        text += "\n\n" + skill
    if contract:
        text += "\n\nKontrak validasi jawaban (validator akan memeriksa jawaban akhir terhadap ini):\n" + contract
    if handoff:
        text += "\n\n" + handoff
    # room past the ~350 words asked: a report cut at 3,000 tokens lost its conclusion and its handoff line (2026-10-23)
    return LlmAgent(name=f"agen_{agent['key']}", model=m.llm(model_id, f"agen_{agent['key']}", 4500), instruction=_const(text), tools=tools,
                    output_key=f"temuan_{agent['key']}")


# what the Machine Learning agent must say about reliability: the numbers the user asked to be trustworthy
ML_RULES = """Anda juga agen MACHINE LEARNING. Aturan kerja:
- Mulai dengan kartu_model_ml: semua angka keandalan (AUPRC, AUROC, F1, presisi, recall, akurasi) diambil dari sana atau
  dari benchmark_ml, lengkap dengan interval 95% / simpangan antar-lipatan, dan selalu dibandingkan dengan pembanding
  (aturan sederhana, Isolation Forest) — model hanya bernilai bila mengalahkannya.
- Label model = klaim yang DIKOREKSI verifikator BPJS (dibayar kurang dari tagihan), bukan fraud terbukti: sebut "risiko
  koreksi verifikasi" atau "indikasi", jangan "fraud".
- Data sangat timpang: akurasi tinggi tidak bermakna (menandai nol klaim pun ≈ 99,9% akurat). Utamakan AUPRC, F1, presisi
  dan lift di 0,1% klaim teratas, recall di 1% teratas. Bedakan tugas "semua klaim" (92% koreksi = rawat inap klinik
  utama, pola yang sudah ditangkap satu aturan) dan "rumah sakit" (koreksi langka, 0,006%; inilah ujian sebenarnya).
- Teknik dibandingkan lewat validasi silang diulang dan t-test terkoreksi: bila p_vs_terbaik >= 0,05 (setara_dengan_terbaik),
  katakan teknik-teknik itu SETARA secara statistik — jangan menobatkan satu teknik sebagai yang terbaik; sebut juga
  berapa kali tiap teknik menang (menang).
- Klaim berisiko tinggi yang LOLOS verifikasi (hanya_lolos_verifikasi) adalah kandidat audit ulang yang paling berguna.
- Untuk alasan sebuah klaim pakai jelaskan_klaim_ml (beberapa metode) dan sebut apakah metode-metode itu sepakat.
- Untuk membandingkan teknik pada cakupan tertentu (provinsi, tugas), atau bila diminta menjalankan tiap teknik, BENTUK
  SUB-AGEN dengan bentuk_sub_agen_teknik (4–9 teknik; keluarga berbeda: linear, bagging, boosting, jaringan saraf,
  glassbox): tiap sub-agen menjalankan tekniknya sendiri pada lipatan yang sama lalu semuanya diuji berpasangan. Pakai
  laporan sub-agen dan papan perbandingannya; sebut teknik mana yang setara secara statistik. Untuk angka model yang
  dipakai, cukup kartu_model_ml. benchmark_ml (satu job berisi banyak teknik) hanya bila sub-agen tidak diperlukan.
- Untuk pertanyaan kartu bukti / kapasitas audit / bukti kinerja, panggil kartu_bukti_model (kartu "rumah_sakit" dan bila perlu
  "semua"). Kartu bukti model memakai ukuran kit evaluasi eksternal: precision@k
  pada kapasitas audit (asumsi 0,1%), lift, recall rupiah, profil faskes jujur yang ikut diaudit, ablasi vs aturan, uji
  permutasi, kebocoran, negatif sulit. Sebut kapasitas itu asumsi, dan sebut hasil ablasi apa adanya (termasuk bila model
  tidak menambah apa-apa dibanding aturan pada kapasitas itu)."""


VOICE = """Jawaban ini DIBACAKAN dalam percakapan suara: paling banyak 3 kalimat pendek, tanpa markdown, judul atau daftar.
Kalimat pertama = jawabannya. Angka tetap ditulis dengan angka. Rujukan [rN] ditaruh di akhir kalimat (tidak dibacakan).
Hindari singkatan yang sulit diucapkan kecuali nama baku (BPJS, JKN, INA-CBG)."""


def writer(m: Models, model_id: str, question: str, findings: dict[str, str], plan: str, fix: str = "", voice: bool = False, contract: str = "",
           previous: str = "", brief: bool = False, focus: list[str] | None = None) -> LlmAgent:
    body = "\n\n".join(f"### {k}\n{v}" for k, v in findings.items())
    # a follow-up answers about the set the conversation is on: a national total only as context (a follow-up's headline
    # once was the national loss of every facility, 2026-10-24)
    focused = (f"Fokus percakapan: {', '.join(focus)}. Judul dan angka kunci tentang himpunan itu; angka nasional atau total seluruh populasi "
               "hanya pembanding di konteks, bukan judul. Bila angka untuk fokus belum bisa dihitung dari temuan, katakan itu di judul — "
               "jangan menggantinya dengan angka nasional.") if previous and focus else ""
    text = f"""Anda Orkestrator AIP JKN. Agen-agen yang Anda tugaskan sudah melapor; sekarang Anda menulis jawaban untuk auditor BPJS Kesehatan.
Pertanyaan: {question}
{('Ini pertanyaan LANJUTAN. Jawaban Anda sebelumnya (pengguna masih melihatnya di layar, tepat di atas jawaban ini):' + chr(10) + previous[:2500] + chr(10) + 'Jangan mengulang isinya: tulis yang BARU untuk pertanyaan ini dan sambungkan dengan yang sebelumnya bila perlu (mis. "provinsi yang sama, Sulawesi Selatan, …"). Angka kunci dan temuan hanya yang baru.') if previous else ''}
{focused}
Rencana Anda: {plan}
{('Kontrak validasi yang Anda tulis sebelum agen bekerja (jawaban harus memenuhinya):' + chr(10) + contract) if contract else ''}
Temuan agen domain (sumber satu-satunya; jangan menambah fakta):
{body}
{('Validator menandai klaim berikut — periksa tiap catatannya terhadap temuan agen di atas. Bila validator benar, perbaiki. Bila validator memakai ukuran lain (tipe objek atau properti berbeda dari yang dirujuk jawaban), pertahankan angka yang didukung temuan dan sebut ukurannya; jangan mengganti angka temuan dengan angka validator yang tidak ada di temuan:' + chr(10) + fix) if fix else ''}
{VOICE_TASK if voice else BRIEFING_TASK}
{'JALUR CEPAT — structuring RINGKAS: angka_kunci 2–3, temuan 2–3, rekomendasi 1–2, kalimat pendek.' if brief and not voice else ''}
Pakai istilah "indikasi" atau "potensi", jangan menyebut fraud sebagai fakta. {LANG}"""
    # chat: the first briefing without thinking aloud (26–108 s with it, plus timeouts on long ones); the findings carry the
    # reasoning. The revision (`fix`, rare now) thinks: it weighs the validator's notes against the findings, where a
    # thoughtless rewrite once returned the prompt's own shape (2026-10-23)
    deep = bool(fix) and not voice
    return LlmAgent(name="orkestrator", model=m.llm(model_id, "orkestrator", 600 if voice else 12000 if deep else 5000, 0.2, think="deep" if deep else ""),
                    instruction=_const(text),
                    output_key="jawaban")


VOICE_TASK = f"""Tulis jawaban akhir: kalimat pertama = jawabannya, lalu poin pendukung dengan angka dan rujukan hasil_id [rN].
Bila data tidak cukup, katakan apa yang kurang.
{VOICE}"""

# the written answer as a briefing the page lays out (aip/AipView: headline, key figures, findings, recommendations);
# every number in it comes from the findings above, and the validator checks all of it
BRIEFING_TASK = """Tulis jawaban sebagai STRUCTURING AUDIT (jawaban audit yang terstruktur) untuk pimpinan dan auditor — tajam, berbobot, enak dibaca:
- judul: satu kalimat yang langsung menjawab, dengan angka terpenting dan nama objeknya.
- ringkasan: 2–3 kalimat untuk pimpinan: apa artinya, seberapa besar, mengapa penting.
- angka_kunci: 3–4 angka terpenting, masing-masing dengan konteks pembanding (peringkat "dari N", % dari total,
  selisih terhadap rata-rata/peer) — hanya angka yang ada di temuan. Setiap angka_kunci adalah angka MILIK objek yang
  ditanyakan (faskes, wilayah, peserta yang dijawab), dan labelnya menyebut objek itu. Total nasional atau total
  seluruh populasi BUKAN angka_kunci tersendiri: taruh hanya sebagai pembanding di konteks ("1,66% dari 10.128
  nasional"), kecuali pertanyaannya memang tentang total nasional. Bila angka objek yang ditanyakan (mis. kerugian per
  faskes) belum berhasil ditarik, jangan menggantinya dengan total agregat: tulis di keterbatasan.
- temuan: 3–5 temuan; tiap temuan punya judul pendek, isi 1–3 kalimat dengan angka dan nama objek, tingkat
  (kritis | tinggi | sedang | info) menurut besar risikonya, dan rujukan hasil_id.
- rekomendasi: 2–4 tindakan konkret untuk auditor (siapa/apa yang diperiksa dulu dan mengapa), prioritas
  (segera | minggu ini | rutin). Tindakan pada data tetap keputusan manusia.
- keterbatasan: apa yang belum bisa disimpulkan dari data ini (boleh kosong).
Sebut objek dengan namanya, bukan id/hash. Jangan menambah fakta di luar temuan. Bila data tidak cukup, katakan.
Jawab HANYA JSON dengan bentuk di bawah; setiap <…> diganti isi yang sebenarnya (jangan menyalin bentuknya):
{"judul": "<kalimat jawaban>", "ringkasan": "<2–3 kalimat>",
 "angka_kunci": [{"label": "<angka apa, milik objek apa>", "nilai": "<angka>", "satuan": "<klaim/Rp/…>", "konteks": "<pembanding>", "rujukan": "<rN>"}],
 "temuan": [{"judul": "<judul pendek>", "isi": "<1–3 kalimat>", "tingkat": "<kritis|tinggi|sedang|info>", "rujukan": ["<rN>"]}],
 "rekomendasi": [{"tindakan": "<tindakan>", "alasan": "<mengapa>", "prioritas": "<segera|minggu ini|rutin>"}],
 "keterbatasan": ["<keterbatasan>"]}"""


PLAIN = """Anda penerjemah AIP JKN untuk pimpinan BPJS Kesehatan yang BUKAN orang teknis (direksi, kepala cabang). Structuring audit di bawah
sudah diperiksa validator. Ceritakan ulang isinya dalam bahasa sehari-hari: apa artinya, seberapa besar, apa yang perlu
diputuskan. Anda tidak menambah fakta.
Pertanyaan auditor: {question}

Structuring audit (satu-satunya sumber; setiap angka Anda harus berasal dari sini):
{briefing}

Aturan:
- Tanpa istilah teknis: jangan tulis istilahnya, terangkan maknanya — dan pakai arti yang BENAR (istilah yang berbeda bukan hal
  yang sama; sebuah run menerangkan AUPRC sebagai recall):
  · AUPRC = rata-rata ketepatan model saat menandai klaim dari yang paling berisiko ke bawah; nilainya hanya bermakna dibanding
    nilai acak (= porsi klaim yang memang dikoreksi): "N kali di atas acak". Bukan "berapa yang tertangkap".
  · presisi = dari klaim yang DITANDAI model, berapa yang memang dikoreksi. recall = dari semua klaim yang DIKOREKSI, berapa yang
    tertangkap model. AUROC = seberapa sering klaim yang dikoreksi mendapat skor lebih tinggi daripada yang tidak.
  · lift = berapa kali lebih jitu daripada memilih acak; precision@k = ketepatan pada klaim teratas yang sempat diaudit.
  · prevalensi / porsi positif = berapa banyak klaim yang memang dikoreksi; IK95 = rentang yang wajar untuk angka itu.
- Penulisan angka Indonesia: TITIK pemisah ribuan, KOMA desimal — "1.447×" = seribu empat ratus empat puluh tujuh kali, bukan
  1,447; "0,0861" = nol koma nol delapan enam satu. Salin angka persis seperti di structuring.
- Angka hanya yang ada di structuring, boleh dibulatkan dengan kata "sekitar". Bentuk lain yang boleh, karena dihitung ulang oleh
  kode: porsi sebagai "X dari setiap N klaim" (N = 100, 1.000, 10.000 atau 100.000; mis. 0,071% = "sekitar 7 dari setiap
  10.000 klaim") dan perbandingan sebagai "N kali lipat". Jangan membuat angka lain; kalimat dengan angka baru dibuang kode.
- Bandingkan dengan sesuatu yang dikenal pimpinan bila membantu (mis. "seperti mencari 6 klaim di antara 100.000").
- Indikasi bukan tuduhan: jangan sebut fraud sebagai fakta; label model = klaim yang dikoreksi verifikator.
- "keputusan" hanya meringkas rekomendasi yang ADA di structuring, dalam bahasa pimpinan; jangan membuat rekomendasi baru.
- Ringkas: total paling banyak sekitar 160 kata, bahasa Indonesia yang hangat dan lugas.
Jawab HANYA JSON:
{{"intinya": "<1–2 kalimat: jawabannya untuk pimpinan>",
 "angka": [{{"angka": "<angka persis dari structuring>", "artinya": "<artinya bagi pimpinan, 1–2 kalimat>"}}],
 "keputusan": ["<apa yang perlu diputuskan atau disetujui pimpinan>"],
 "hati_hati": ["<satu hal yang perlu diingat saat membaca angka ini>"]}}
angka: 2–4 butir; keputusan: 1–3; hati_hati: 1–2."""


def plain(m: Models, model_id: str, question: str, briefing: str) -> LlmAgent:
    """The plain-language layer: the validated briefing retold for leaders who are not technical, by a model other than
    the writer's (aip/models.py role "awam"); main._plain checks every number against the briefing."""
    text = PLAIN.format(question=question, briefing=briefing[:7000])
    return LlmAgent(name="penjelas_pimpinan", model=m.llm(model_id, "penjelas_pimpinan", 2000, 0.3), instruction=_const(text), output_key="awam")


def placeholder(raw: str) -> bool:
    """A writer's answer that is the prompt's shape echoed back, not an answer (a revision returned {"judul": "...", …}
    word for word, 2026-10-23): judul or the text left as "..." or "<…>"."""
    s = (raw or "").strip()
    try:
        b = parse_json(s)
        s = str(b.get("judul") or "").strip() if isinstance(b, dict) else s
    except ValueError:
        pass
    return s.strip(" .…") == "" or (s.startswith("<") and s.endswith(">"))


def briefing_of(raw: str) -> Optional[dict]:
    """The writer's briefing, kept to its shape; None when the answer is plain text (voice, or a model that ignored it)."""
    try:
        b = parse_json(raw)
    except ValueError:
        return None
    if not isinstance(b, dict) or not str(b.get("judul") or "").strip():
        return None
    if not (str(b.get("ringkasan") or "").strip() or b.get("angka_kunci") or b.get("temuan")):
        return None  # a fragment (one finding's {judul, isi}) is not the briefing: seen 2026-10-24 when the whole failed to parse
    lst = lambda k: [x for x in b.get(k) or [] if isinstance(x, dict)][:6]  # noqa: E731
    return {"judul": str(b["judul"])[:300], "ringkasan": str(b.get("ringkasan") or "")[:900],
            "angka_kunci": [{k: str(x.get(k) or "")[:160] for k in ("label", "nilai", "satuan", "konteks", "rujukan")} for x in lst("angka_kunci")][:4],
            "temuan": [{"judul": str(x.get("judul") or "")[:160], "isi": str(x.get("isi") or "")[:900],
                        "tingkat": x.get("tingkat") if x.get("tingkat") in ("kritis", "tinggi", "sedang", "info") else "info",
                        "rujukan": [str(r) for r in (x.get("rujukan") or []) if isinstance(r, str)][:4]} for x in lst("temuan")][:5],
            "rekomendasi": [{"tindakan": str(x.get("tindakan") or "")[:300], "alasan": str(x.get("alasan") or "")[:400],
                             "prioritas": str(x.get("prioritas") or "rutin")[:20]} for x in lst("rekomendasi")][:4],
            "keterbatasan": [str(x)[:300] for x in (b.get("keterbatasan") or []) if isinstance(x, str)][:4],
            "jawaban": str(b.get("jawaban") or "")[:6000]}


def briefing_text(b: dict) -> str:
    """The whole briefing as markdown, built here rather than written twice by the model (the structured fields plus a
    full-text copy doubled the writer's output, 2,700–3,600 tokens): what the validator checks, the history keeps and
    "Jawaban lengkap" shows — every number on the page."""
    def ref(r: str) -> str:
        return f" [{r}]" if r else ""
    lines = [f"**{b['judul']}**", "", b["ringkasan"]]
    if b["angka_kunci"]:
        lines += ["", "### Angka kunci"] + [f"- {k['label']}: {k['nilai']} {k['satuan']}" + (f" ({k['konteks']})" if k["konteks"] else "")
                                            + ref(k["rujukan"]) for k in b["angka_kunci"]]
    if b["temuan"]:
        lines += ["", "### Temuan"] + [f"- **{t['judul']}** ({t['tingkat']}): {t['isi']}" + ref(", ".join(t["rujukan"])) for t in b["temuan"]]
    if b["rekomendasi"]:
        lines += ["", "### Rekomendasi"] + [f"- ({r['prioritas']}) {r['tindakan']} — {r['alasan']}" for r in b["rekomendasi"]]
    if b.get("keterbatasan"):
        lines += ["", "### Keterbatasan"] + [f"- {x}" for x in b["keterbatasan"]]
    return "\n".join(lines + (["", b["jawaban"]] if b["jawaban"] else [])).strip()


def validator(m: Models, model_id: str, question: str, answer: str, tools: list, agents: list[dict] | None = None, contract: str = "",
              focus: str = "", sources: str = "") -> LlmAgent:
    schema = "\n".join(_schema(a) for a in agents or [] if a["object_types"])
    text = f"""Anda validator adversarial AIP JKN. Anda tidak melihat cara agen lain bekerja: hanya jawaban dan data.
Objek Nexus yang bisa Anda baca (pakai api_name properti persis seperti ini):
{schema or '-'}
Pertanyaan: {question}
Jawaban yang harus diperiksa:
{answer}

{('Kontrak validasi (ditulis orkestrator sebelum agen bekerja) — nilai SETIAP pernyataan:' + chr(10) + contract) if contract else ''}
{('Validator scrutiny (kode) tidak menemukan angka ini di hasil tool — hitung ulang lebih dulu: ' + focus) if focus else ''}
{('Hasil yang dirujuk jawaban ([rN] → apa yang dibaca):' + chr(10) + sources) if sources else ''}
Hitung ulang UKURAN YANG SAMA dengan yang dirujuk klaim: tipe objek dan properti yang sama dengan hasil [rN]-nya (mis. klaim
"168 klaim bertag" dari properti klaim_bertag di Karantina Faskes diperiksa dengan membaca klaim_bertag objek itu, bukan
dengan menghitung baris tipe lain). Angka dari ukuran lain (jumlah baris tipe lain, pengelompokan per properti lain) BUKAN
bantahan: bila Anda tidak bisa membaca ukuran yang sama, tulis "ukuran berbeda, tidak dapat dibandingkan" dan ok=true
kecuali ada bukti langsung bahwa angkanya salah.

Periksa angka dan fakta terpenting di jawaban (maksimal 4) dengan memanggil tool sendiri (data Nexus yang sama), paling banyak 5 panggilan tool.
Dahulukan angka turunan (rasio, kelipatan "N×", persen, selisih): hitung ulang dari dua angka sumbernya — di sanalah
penulis paling sering keliru.
Lalu jawab HANYA JSON:
{{"checks": [{{"klaim": "<kutipan dari jawaban>", "ok": true, "bukti": "<angka/objek yang Anda temukan>"}}],
 "kontrak": [{{"id": "k1", "ok": true, "bukti": "<mengapa terpenuhi atau tidak>"}}]}}
ok=false bila angka berbeda, tidak didukung data, atau berlebihan (mis. menyebut fraud sebagai fakta), atau bila angka
agregat (total nasional, seluruh populasi) disajikan seolah milik objek yang ditanyakan; untuk kontrak, ok=false
bila jawaban tidak memenuhi pernyataannya."""
    return LlmAgent(name="validator", model=m.llm(model_id, "validator", 4000, think="medium"), instruction=_const(text), tools=tools, output_key="verdict")


def validator_verdict(m: Models, model_id: str, question: str, answer: str, evidence: str, contract: str = "", claims: bool = False,
                      agents_read: bool = False, unsourced: str = "") -> LlmAgent:
    """The validator's verdict from the checks it already ran, when its own turn ended without one (a model glitch):
    no tools, no new reads, only what its reads returned. With a mission's contract, one check per contract id; with
    `claims` too, the answer's key numbers first (ids c1, c2, …), then the contract."""
    if contract and claims:
        shape = ('{"checks": [{"id": "c1", "klaim": "<kutipan angka dari yang diperiksa>", "ok": true, "bukti": "<angka/objek dari hasil di atas>"}, '
                 '{"id": "<id kontrak, mis. k1>", "klaim": "<pernyataan kontrak>", "ok": true, "bukti": "<mengapa terpenuhi atau tidak>"}]}')
    else:
        shape = ('{"checks": [{"id": "a1", "klaim": "<pernyataan kontrak>", "ok": true, "bukti": "<angka/objek dari hasil di atas>"}]}' if contract
                 else '{"checks": [{"klaim": "<kutipan dari jawaban>", "ok": true, "bukti": "<angka/objek dari hasil di atas>"}]}')
    # agents_read: a chat answer judged from what the domain agents' tools returned (one call, no new reads) instead of a
    # re-reading tool loop — when the scrutiny code traced every number to those results, or on the fast route, where the
    # numbers it could not trace (`unsourced`) are judged here
    whose = ("Hasil bacaan agen domain ke data (tool dan jawabannya" + ("" if unsourced else "; kode scrutiny sudah memastikan setiap angka jawaban ada di sini")
             + ")") if agents_read else "Hasil pemeriksaan Anda sendiri ke data (tool dan jawabannya)"
    text = f"""Anda validator adversarial AIP JKN. {'Periksa jawaban terhadap hasil bacaan di bawah' if agents_read else 'Anda sudah memeriksa data'}; tulis putusannya sekarang.
Pertanyaan: {question}
{('Kontrak validasi:' + chr(10) + contract) if contract else ''}
Yang diperiksa:
{answer}

{whose}:
{evidence}
{('Kode scrutiny tidak menemukan angka ini di hasil: ' + unsourced + ' — nilai apakah masing-masing turunan sah dari hasil di atas (jumlah, selisih, persen, pembulatan) atau keliru.') if unsourced else ''}

Jawab HANYA JSON{(': paling banyak 6 cek angka (id c1, c2, …), lalu SATU cek per pernyataan kontrak dengan id kontraknya' if contract and claims
                  else '' if contract else ', maksimal 4 cek')}, hanya yang bisa dinilai dari hasil di atas:
{shape}
ok=false bila angka berbeda dari hasil, tidak didukung hasil, salah ukuran (angka satu tipe/properti disajikan sebagai ukuran lain, atau total agregat
sebagai milik objek yang ditanyakan), atau berlebihan (mis. menyebut fraud sebagai fakta)."""
    return LlmAgent(name="validator", model=m.llm(model_id, "validator", 3000, 0.0, think="medium"), instruction=_const(text), output_key="verdict")


def parse_json(text: str) -> Any:
    """The JSON object in a model's answer (a reasoning block, fences, prose around it and a trailing comma tolerated)."""
    s = (text or "").strip()
    if "</think>" in s:  # a model that reasons in its answer (GLM, seen 2026-10-23: a plan lost behind it): the answer follows
        s = s.rsplit("</think>", 1)[1].strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = s[s.find("\n") + 1:] if "\n" in s else s
    start, end = s.find("{"), s.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the answer")
    whole = s[start:end + 1].replace(",}", "}").replace(",]", "]")
    try:
        return json.loads(whole)
    except ValueError:
        pass
    # a key written without its colon ("satuan "persen"): GLM's briefing of 2026-10-24 lost everything to one, the
    # fallback below then took a finding's small object for the whole answer
    try:
        return json.loads(re.sub(r'([{,]\s*)"([A-Za-z_]\w*) "', r'\1"\2": "', whole))
    except ValueError:
        pass
    # prose with braces of its own around the object: the longest object that decodes whole
    dec, found, after = json.JSONDecoder(), None, -1
    for i in (i for i, ch in enumerate(s) if ch == "{"):
        if i < after:
            continue
        try:
            obj, end = dec.raw_decode(s, i)
        except ValueError:
            continue
        after = end
        if isinstance(obj, dict) and (found is None or end - i > found[0]):
            found = (end - i, obj)
    if found is None:
        raise ValueError("no JSON object in the answer")
    return found[1]


def pick(role: str, checks: str | None = None) -> str:
    return aip_models.pick(role, checks=checks)
