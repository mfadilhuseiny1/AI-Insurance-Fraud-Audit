"""Agent skills of AIP JKN: how a worker does a kind of task, kept as data the orchestrator assigns per task — not as
code (the orchestration concept of 2026-10-22, docs/Agent Orchestration Concept: "worker behavior is driven by skills
that the orchestrator defines per mission"; "when a better model drops, the system just gets smarter").

A skill is a procedure (langkah), the tools it must use (wajib: the deterministic check of "procedures followed" in
every handoff), what it hands off (keluaran), and its lessons (pelajaran): the continuous-learning loop — new task →
execute → observe → learn → encode skill. After a run whose validators found something, the orchestrator writes a
short general lesson for the skill involved; code checks it (length, no links, no orders to change data, no
duplicate, at most PER_SKILL active) and it is active at once when the run was an admin's, a proposal for an admin
otherwise. Every lesson names its run; an admin can switch it off.

    GET  /api/aip/skills                           the skills with their active lessons (the runtime reads them in /api/aip/agents)
    POST /api/aip/skills/pelajaran                 a lesson from a run (or an admin)
    POST /api/aip/skills/pelajaran/{id}/status     aktif | nonaktif (admin)

The orchestrator's own procedure for a chat question — its planning rules (adk_runtime/agents.PLAN_RULES) — is kept per
model as "aturan": versions tuned by aip/optimasi.py (GEPA, scored on aip/golden/rencana.json), each with its scores.
A version always arrives as a proposal, whoever sends it: the rules decide every plan, so an admin switches one on (one
active version per role and model), and every run's plan names the version it ran on.

    GET  /api/aip/skills/aturan                    the versions, their scores and status
    POST /api/aip/skills/aturan                    a tuned version, as a proposal (admin)
    POST /api/aip/skills/aturan/{id}/status        aktif | nonaktif (admin)
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip/skills")

PER_SKILL = 8  # active lessons a skill keeps (the newest)
VERSION = "2026-10-23"

SKILLS: dict[str, dict] = {
    # ---------------------------------------------------------------- question flow: the small agents of a domain agent
    "bandingkan_wilayah": {
        "nama": "Bandingkan wilayah", "alur": "tanya_jawab", "agen": ["faskes_wilayah", "peserta", "klaim_fraud"],
        "untuk": "membandingkan provinsi atau kab/kota pada satu atau beberapa ukuran",
        "langkah": ["Ambil angka cakupan Anda dengan agregasi_objek (jumlah atau rata-rata per wilayah), bukan dengan menjumlah hasil cari_objek.",
                    "Hitung pembanding dengan tool: angka nasional atau wilayah lain, lalu rasio (per 1.000 klaim) atau porsi dari total — jumlah mentah "
                    "saja menyesatkan karena volume klaim tiap wilayah berbeda.",
                    "Sebut posisi cakupan Anda di antara wilayah (peringkat dari N).",
                    "Laporkan setiap angka dengan hasil_id-nya."],
        "wajib": [["agregasi_objek", "cari_objek"]], "keluaran": "angka cakupan, pembanding, rasio dan peringkat, masing-masing dengan hasil_id"},
    "profil_faskes": {
        "nama": "Profil faskes", "alur": "tanya_jawab", "agen": ["faskes_wilayah", "klaim_fraud"],
        "untuk": "memeriksa satu atau beberapa faskes: risiko, klaim, pola, indikasi",
        "langkah": ["Temukan faskes dengan cari_objek (nama atau id), lalu detail_objek.",
                    "Bandingkan ukurannya dengan faskes SEKELAS (tipe yang sama), bukan dengan semua faskes.",
                    "objek_terkait untuk klaim berisiko dan indikasi faskes itu.",
                    "Sebut negatif sulit yang mungkin menjelaskan: RS kelas A/tersier, RS khusus, masa COVID, faskes kecil."],
        "wajib": [["cari_objek", "detail_objek"]], "keluaran": "profil faskes dengan pembanding sekelas, indikasi, dan penjelasan wajar yang mungkin"},
    "telusur_klaim": {
        "nama": "Telusur klaim berisiko", "alur": "tanya_jawab", "agen": ["klaim_fraud", "klinis"],
        "untuk": "klaim tertentu atau daftar klaim berisiko: tagihan, kode, lama rawat, koreksi",
        "langkah": ["cari_objek klaim berisiko dengan filter cakupan Anda, urut menurut risiko atau nilai.",
                    "Untuk 2–3 klaim teratas: detail_objek, dan bandingkan tagihan dengan tarif INA-CBG serta lama rawat dengan p90 kodenya.",
                    "Pisahkan klaim yang sudah dikoreksi verifikator dari yang lolos verifikasi: yang lolos dengan risiko tinggi paling berguna diaudit ulang.",
                    "Sebut klaim dengan id dan nama faskesnya."],
        "wajib": [["cari_objek"]], "keluaran": "daftar klaim dengan alasan risikonya dan pembandingnya"},
    "pola_rujukan": {
        "nama": "Pola rujukan dan peserta", "alur": "tanya_jawab", "agen": ["peserta"],
        "untuk": "alur rujukan FKTP → FKRTL, rujukan lintas wilayah, peserta dengan banyak klaim",
        "langkah": ["agregasi_objek alur rujukan menurut asal dan tujuan wilayah; hitung porsi lintas kab/kota dan lintas provinsi.",
                    "Bandingkan kesesuaian diagnosis rujukan (diagnosis sama) dan hari ke FKRTL dengan rata-rata nasional.",
                    "Untuk peserta dengan banyak klaim, lihat apakah polanya wajar (dialisis, kemoterapi) sebelum menyebutnya indikasi."],
        "wajib": [["agregasi_objek", "cari_objek"]], "keluaran": "pola rujukan dengan porsi dan pembanding nasional"},
    "kode_klinis": {
        "nama": "Kode INA-CBG dan keparahan", "alur": "tanya_jawab", "agen": ["klinis"],
        "untuk": "kode INA-CBG, diagnosis, keparahan, lama rawat dibanding peer kodenya",
        "langkah": ["agregasi_objek per kode: jumlah klaim, porsi keparahan III, lama rawat median dan p90.",
                    "Bandingkan kode dengan kode sekelompok (CMG yang sama) — porsi keparahan berat di atas peer adalah sinyal upcoding.",
                    "Sebut kode dengan deskripsinya, bukan hanya kodenya."],
        "wajib": [["agregasi_objek", "cari_objek"]], "keluaran": "kode dengan porsi keparahan, lama rawat dan pembanding peer"},
    "kartu_model": {
        "nama": "Keandalan model ML", "alur": "tanya_jawab", "agen": ["machine_learning"],
        "untuk": "akurasi, teknik, prediksi, kartu bukti model, skor risiko",
        "langkah": ["Mulai dengan kartu_model_ml; angka keandalan diambil dari sana atau dari benchmark, dengan interval atau simpangan.",
                    "Bandingkan dengan pembanding sederhana (aturan, Isolation Forest): model hanya bernilai bila mengalahkannya.",
                    "Untuk perbandingan teknik pada cakupan tertentu, bentuk sub-agen teknik; sebut teknik yang setara secara statistik."],
        "wajib": [["kartu_model_ml", "kartu_bukti_model", "bentuk_sub_agen_teknik", "skor_risiko_klaim_ml", "risiko_faskes_ml"]],
        "keluaran": "angka keandalan dengan interval dan pembanding, teknik setara, keterbatasan label"},
    "asal_angka": {
        "nama": "Asal sebuah angka", "alur": "tanya_jawab", "agen": ["data"],
        "untuk": "dari mana angka berasal: dataset, pipeline, lineage, kode transform",
        "langkah": ["cari_nexus untuk dataset atau objeknya, lalu telusuri_lineage ke hulu sampai sumber mentah.",
                    "baca_kode transform yang mengubah kolom yang ditanyakan; sebut langkah yang mengubah angkanya."],
        "wajib": [["telusuri_lineage", "cari_nexus"]], "keluaran": "rantai sumber → transform → dataset, dengan nama langkahnya"},
    "umum": {
        "nama": "Tugas umum", "alur": "tanya_jawab", "agen": [],
        "untuk": "tugas yang tidak cocok dengan skill lain",
        "langkah": ["Ambil setiap fakta dengan tool; pakai api_name properti persis seperti di daftar.",
                    "Beri pembanding untuk setiap angka penting (rata-rata, peringkat, porsi)."],
        "wajib": [], "keluaran": "temuan dengan angka, pembanding dan hasil_id"},
    # ---------------------------------------------------------------- the fraud consultancy (adk_runtime/firm.py)
    "rencana_penugasan": {
        "nama": "Rencana penugasan", "alur": "firma", "agen": ["orkestrator"],
        "untuk": "orkestrator sebagai partner: hipotesis, fokus tiap lini, kontrak validasi penugasan",
        "langkah": ["Baca lanskap secukupnya (paling banyak 5 panggilan: ukur, lihat_indikasi, kamus_semantik).",
                    "Tulis 3–6 hipotesis yang bisa diuji dengan data ini, masing-masing dengan ukuran dan tag yang mengujinya.",
                    "Tulis fokus tiap lini: apa yang paling perlu dikejar di sana.",
                    "Tulis KONTRAK VALIDASI sebelum pekerjaan dimulai: 5–8 pernyataan yang harus benar agar penugasan dianggap selesai dengan "
                    "benar — tentang keluaran, bukan cara kerja (mis. setiap faskes kelompok A dan B punya rekomendasi penyidik; ditindak hanya "
                    "bila T, S dan M terpenuhi; angka ringkasan eksekutif dari buku besar dengan hasil_id)."],
        "wajib": [["ukur", "lihat_indikasi", "kamus_semantik"]], "keluaran": "JSON rencana: hipotesis, fokus, kontrak"},
    "analis_wilayah": {
        "nama": "Analis wilayah", "alur": "firma", "agen": ["faskes_wilayah"],
        "untuk": "menelusuri setiap indikasi di satu provinsi atau satu wilayah pulau, lintas modus",
        "langkah": ["ukur 3–5 ukuran kunci per faskes atau kab/kota di cakupan Anda (mis. berisiko_lolos_verifikasi, klaim_calon_ganda, "
                    "klaim_los_ekstrem, readmisi_faskes, rasio_aktual_ekspektasi) dan bandingkan dengan nasional.",
                    "risiko_faskes_ml untuk provinsi Anda (nama provinsi HURUF BESAR).",
                    "lihat_indikasi provinsi Anda: apa yang sudah ditandai penanda otomatis dan agen lain.",
                    "Tandai setiap indikasi (faskes, kab/kota, klaim) dengan bukti dari hasil yang Anda baca sendiri."],
        "wajib": [["ukur"], ["tandai_indikasi", "tandai_hasil", "lihat_indikasi"]], "keluaran": "laporan 14 baris + serah-terima"},
    "analis_peer": {
        "nama": "Analis peer kelas faskes", "alur": "firma", "agen": ["faskes_wilayah"],
        "untuk": "faskes yang menyimpang dari KELASNYA pada beberapa ukuran sekaligus",
        "langkah": ["ukur per tipe_faskes: rasio_aktual_ekspektasi, berisiko_lolos_verifikasi, readmisi_faskes, los_ekstrem_faskes, "
                    "calon_ganda_faskes (pembanding kelas).",
                    "Untuk 3–4 kelas dengan sebaran terlebar, cari_objek faskes kelas itu di Risiko Faskes ML (BPJS) dengan filternya, urut "
                    "menurut ukuran yang menyimpang.",
                    "Penanda otomatis sudah menandai OUTLIER_PEER satu ukuran (risiko_per_1000): jangan ulangi itu. Tandai faskes yang "
                    "menyimpang pada >= 2 ukuran (OUTLIER_PEER, dan tag modus bila sinyalnya jelas) dengan bukti semua ukurannya."],
        "wajib": [["ukur"], ["cari_objek"]], "keluaran": "laporan 14 baris + serah-terima"},
    "spesialis_modus": {
        "nama": "Spesialis modus", "alur": "firma", "agen": ["klaim_fraud", "klinis", "peserta"],
        "untuk": "satu modus fraud Permenkes 16/2019 secara nasional",
        "langkah": ["ukur sinyal modus Anda secara nasional per provinsi, per tipe_faskes dan per faskes.",
                    "Cari konsentrasi (wilayah, kelas, faskes, kode) yang jauh di atas peer.",
                    "Periksa contoh objek dengan cari_objek / detail_objek.",
                    "Tandai setiap indikasi modus Anda dengan tag modusnya (atau tag lain bila sinyalnya modus lain)."],
        "wajib": [["ukur"], ["tandai_indikasi", "tandai_hasil"]], "keluaran": "laporan 14 baris + serah-terima"},
    # Blu 3.0 (aip/blu3.py): one agent per family of Permenkes modes that the v3 fraud model's specialists score
    "spesialis_famili_v3": {
        "nama": "Agen kelompok modus (Blu 3.0)", "alur": "firma", "agen": ["klaim_fraud", "peserta"],
        "untuk": "satu kelompok modus Permenkes 16/2019 secara nasional, mulai dari klaim yang dinilai spesialis v3",
        "langkah": ["baca_hasil tabel 'klaim teratas keluarga Anda menurut v3' dari mesin scoring v3: itu work list, bukan bukti.",
                    "Untuk tiap klaim teratas, detail_objek di Klaim Berisiko (BPJS) / Skor Risiko Klaim ML (BPJS): bandingkan tagihan dengan tarif "
                    "dan median peer, kode dan keparahan, lama rawat dengan p90 peer, kelas rawat, alasan_json (skor lapisan v3).",
                    "Cari konsentrasi: faskes dan provinsi dengan banyak klaim keluarga Anda (cari_objek dengan filter indikasi_utama, ukur per faskes).",
                    "Tandai HANYA yang terbukti dari data yang Anda baca sendiri, dengan tag modus yang paling tepat dari keluarga Anda; "
                    "klaim yang skor v3-nya tinggi tetapi datanya wajar sebut sebagai negatif sulit, jangan ditandai."],
        "wajib": [["baca_hasil", "cari_objek"], ["tandai_indikasi", "tandai_hasil"]], "keluaran": "laporan 14 baris + serah-terima"},
    "sub_agen_teknik": {
        "nama": "Sub-agen teknik ML", "alur": "firma", "agen": ["machine_learning"],
        "untuk": "satu teknik benchmark: validasi silang pada klaim rumah sakit nyata",
        "langkah": ["Panggil jalankan_teknik sekali.",
                    "Laporkan AUPRC ± sd, AUROC, F1, presisi, recall dan lift persis seperti hasilnya, apa kata riset tentang teknik ini, dan "
                    "3 faskes teratas dengan NAMA.",
                    "Jangan menandai sendiri: daftar teratas Anda masuk ke mesin konsensus antarteknik."],
        "wajib": [["jalankan_teknik"]], "keluaran": "laporan 8 baris + serah-terima"},
    "penyidik_kasus": {
        "nama": "Penyidik kasus box karantina", "alur": "firma", "agen": ["klaim_fraud"],
        "untuk": "kertas kerja audit satu faskes di puncak box karantina dan rekomendasi jalurnya",
        "langkah": ["Klaim faskes ini: cari_objek Skor Risiko Klaim ML (BPJS) dan Klaim Berisiko (BPJS) dengan filter faskes_profil_id, urut risiko; "
                    "verifikasi_klaim untuk 2–3 klaim teratas (model terpasang + telaah klinis LLM).",
                    "Pembanding peer: faskes setipe di Risiko Faskes ML (BPJS) atau ukur per tipe_faskes — apakah penyimpangannya nyata?",
                    "Uji tiap dimensi TSM dengan data: Terstruktur (banyak modus, lintas layanan dan kode, jaringan sewilayah), Sistematis "
                    "(berulang lintas bulan, koreksi yang terus berulang), Masif (kerugian, jumlah klaim dan peserta, porsi klaim).",
                    "Tandai indikasi baru yang Anda temukan, lalu panggil rekomendasi_jalur SEKALI, paling lambat setelah 14 langkah baca."],
        "wajib": [["cari_objek"], ["rekomendasi_jalur"]], "keluaran": "kertas kerja 18 baris + rekomendasi_jalur + serah-terima"},
    "sintesis_agen_domain": {
        "nama": "Sintesis agen domain", "alur": "firma", "agen": ["faskes_wilayah", "klaim_fraud", "klinis", "peserta", "machine_learning"],
        "untuk": "menyintesis laporan agen kecil yang dipimpin untuk orkestrator",
        "langkah": ["Cari pola yang berulang di banyak laporan dan objek yang muncul di beberapa laporan.",
                    "Pilih temuan terkuat dengan angka dan hasil_id dari laporan; periksa ulang paling banyak 5 angka dengan tool.",
                    "Sebut hipotesis yang didukung atau dibantah, dan celah yang belum diperiksa."],
        "wajib": [], "keluaran": "sintesis 20 baris"},
    "reviewer_qa": {
        "nama": "Reviewer QA", "alur": "firma", "agen": ["validator"],
        "untuk": "memeriksa ulang satu sintesis ke data, tanpa melihat penalaran timnya",
        "langkah": ["Pilih 4–6 klaim angka terpenting di sintesis.",
                    "Hitung ulang tiap klaim dengan tool sendiri (ukur, cari_objek, agregasi_objek, lihat_indikasi); angka turunan dihitung "
                    "dari dua angka sumbernya."],
        "wajib": [["ukur", "cari_objek", "agregasi_objek", "lihat_indikasi"]], "keluaran": "JSON putusan per klaim"},
    "red_team": {
        "nama": "Red team", "alur": "firma", "agen": ["validator"],
        "untuk": "membela kemungkinan bahwa indikasi terkuat WAJAR, lalu memutus dengan jujur",
        "langkah": ["Cari penjelasan jujur di data: kelas faskes, case-mix, rawat ulang yang sah (dialisis, kemoterapi), diagnosis langka, "
                    "faskes kecil, masa COVID.",
                    "Periksa paling banyak 6 panggilan, lalu panggil putusan_red_team SEKALI: bertahan bila penjelasan wajar tidak cukup, "
                    "melemah bila cukup."],
        "wajib": [["putusan_red_team"]], "keluaran": "laporan 5 baris + putusan"},
    "laporan_akhir": {
        "nama": "Laporan akhir penugasan", "alur": "firma", "agen": ["orkestrator"],
        "untuk": "laporan untuk klien dari sintesis, QA dan fakta buku besar",
        "langkah": ["Ringkasan eksekutif 5 butir dengan angka terpenting dan hasil_id.",
                    "Temuan per agen domain; box karantina dan kasus prioritas hanya ditafsirkan — tabelnya ditambahkan dari data.",
                    "Keandalan: QA, red team, keterbatasan (indikasi bukan fraud terbukti; label = koreksi verifikator; data sampel).",
                    "Keputusan yang dibutuhkan dari manusia."],
        "wajib": [], "keluaran": "laporan Markdown"},
}

_lock = threading.Lock()
_dir_override: Optional[Path] = None


def _dir() -> Path:
    from aip import vertex as aip_vertex

    d = _dir_override or aip_vertex.DIR.parent / "skills"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load() -> list[dict]:
    path = _dir() / "pelajaran.json"
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return []


def _save(rows: list[dict]) -> None:
    path = _dir() / "pelajaran.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)


def lessons(skill: str, status: str = "aktif") -> list[dict]:
    return [x for x in _load() if x["skill"] == skill and x["status"] == status]


def catalogue() -> list[dict]:
    """The skills with their active lessons, as the runtime reads them (aip/domains.py adds them to /api/aip/agents)."""
    rows = _load()
    return [{"key": k, **s, "versi": VERSION, "pelajaran": [x["teks"] for x in rows if x["skill"] == k and x["status"] == "aktif"][-PER_SKILL:]}
            for k, s in SKILLS.items()]


# what a lesson may not be: a link, an order to change data or to ignore rules, a secret, or a person's identity
_BAD = re.compile(r"https?://|www\.|abaikan (aturan|instruksi|kontrak)|ignore (all|previous|the)|lupakan aturan|ubah data|hapus (data|objek)|"
                  r"setujui sendiri|password|kata sandi|api[_ -]?key|\bnik\b", re.I)


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def check(skill: str, teks: str) -> str:
    """Why a lesson cannot be kept, or "" (the deterministic gate before a lesson reaches any prompt)."""
    if skill not in SKILLS:
        return f"skill {skill!r} tidak ada"
    t = (teks or "").strip()
    if not 20 <= len(t) <= 300:
        return "pelajaran harus 20–300 karakter"
    if _BAD.search(t):
        return "pelajaran tidak boleh berisi tautan, perintah mengubah data, atau rahasia"
    if any(_norm(x["teks"]) == _norm(t) for x in _load() if x["skill"] == skill and x["status"] != "nonaktif"):
        return "pelajaran yang sama sudah ada"
    return ""


def add(skill: str, teks: str, run_id: str, sumber: str, admin: bool) -> dict:
    """Keep a lesson: active at once from an admin's run, a proposal otherwise; a skill keeps its PER_SKILL newest."""
    why = check(skill, teks)
    if why:
        raise ValueError(why)
    with _lock:
        rows = _load()
        rec = {"id": "pl-" + hashlib.sha1(f"{skill}|{teks}|{run_id}".encode()).hexdigest()[:10], "skill": skill, "teks": teks.strip(),
               "run_id": run_id, "sumber": sumber[:200], "status": "aktif" if admin else "usulan", "pada": _now()}
        rows.append(rec)
        active = [x for x in rows if x["skill"] == skill and x["status"] == "aktif"]
        for old in active[:-PER_SKILL]:
            old["status"] = "nonaktif"
            old["catatan"] = "digantikan pelajaran yang lebih baru"
        _save(rows)
    return rec


class LessonIn(BaseModel):
    skill: str = Field(..., max_length=60)
    teks: str = Field(..., max_length=300)
    run_id: str = Field("", max_length=60)
    sumber: str = Field("", max_length=200)


class StatusIn(BaseModel):
    status: str = Field(..., pattern="^(aktif|nonaktif)$")


@router.get("")
def get_skills() -> dict:
    rows = _load()
    return {"versi": VERSION, "skills": catalogue(), "pelajaran": rows[-200:],
            "jumlah": {s: sum(x["status"] == s for x in rows) for s in ("aktif", "usulan", "nonaktif")}}


@router.post("/pelajaran")
def post_lesson(body: LessonIn) -> dict:
    import auth

    p = auth.current() or {}
    try:
        return add(body.skill, body.teks, body.run_id, body.sumber, admin=(not auth.enabled()) or p.get("role") == "admin")
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


@router.post("/pelajaran/{lid}/status")
def set_status(lid: str, body: StatusIn) -> dict:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "hanya admin yang mengaktifkan atau menonaktifkan pelajaran")
    with _lock:
        rows = _load()
        rec = next((x for x in rows if x["id"] == lid), None)
        if not rec:
            raise HTTPException(404, "pelajaran tidak ada")
        rec["status"], rec["diputuskan_oleh"], rec["diputuskan_pada"] = body.status, p.get("username") or p.get("id") or "admin", _now()
        _save(rows)
    return rec


# ------------------------------------------------------------------------------------------------ the orchestrator's rules

RULE_ROLES = {"rencana": "aturan rencana orkestrator tanya-jawab (adk_runtime/agents.PLAN_RULES)"}
RULES_CHARS = (400, 12000)  # PLAN_RULES is about 7,900 with its question map; a tuned version that grows past this slows every plan


def _load_rules() -> list[dict]:
    path = _dir() / "aturan.json"
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return []


def _save_rules(rows: list[dict]) -> None:
    path = _dir() / "aturan.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)


def check_rules(peran: str, teks: str) -> str:
    """Why a rules version cannot be kept, or "" (the gate before a version reaches the planner): its role, its length,
    no link, no order to change data or ignore rules, no secret, and no JSON shape of its own (the code writes that)."""
    if peran not in RULE_ROLES:
        return f"peran {peran!r} tidak ada"
    t = (teks or "").strip()
    if not RULES_CHARS[0] <= len(t) <= RULES_CHARS[1]:
        return f"aturan harus {RULES_CHARS[0]}–{RULES_CHARS[1]} karakter (ini {len(t)})"
    if _BAD.search(t) or "```" in t:
        return "aturan tidak boleh berisi tautan, blok kode, perintah mengubah data, atau rahasia"
    if re.search(r'\{\s*"ringkasan"', t):
        return "aturan tidak menulis bentuk JSON jawaban: kode yang menambahkannya"
    return ""


def add_rules(peran: str, model: str, teks: str, label: str, skor: dict, sumber: str, oleh: str) -> dict:
    why = check_rules(peran, teks)
    if why:
        raise ValueError(why)
    with _lock:
        rows = _load_rules()
        rec = {"id": "at-" + hashlib.sha1(f"{peran}|{model}|{teks}".encode()).hexdigest()[:10], "peran": peran, "model": model, "teks": teks.strip(),
               "label": label[:160], "skor": skor, "sumber": sumber[:300], "status": "usulan", "oleh": oleh, "pada": _now()}
        if any(x["id"] == rec["id"] for x in rows):
            raise ValueError("versi aturan yang sama sudah ada")
        rows.append(rec)
        _save_rules(rows)
    return rec


def rules_for(roles: dict) -> dict:
    """The active rules of each role for the model it runs on (aip/domains.py adds them to /api/aip/agents)."""
    rows = _load_rules()
    out = {}
    for peran, model in (("rencana", roles.get("planner")),):
        rec = next((x for x in reversed(rows) if x["peran"] == peran and x["model"] == model and x["status"] == "aktif"), None)
        if rec:
            out[peran] = {k: rec[k] for k in ("id", "model", "teks", "label")}
    return out


class RulesIn(BaseModel):
    peran: str = Field("rencana", max_length=40)
    model: str = Field(..., max_length=120)
    teks: str = Field(..., max_length=RULES_CHARS[1] + 2000)
    label: str = Field("", max_length=160)
    skor: dict = {}
    sumber: str = Field("", max_length=300)


@router.get("/aturan")
def get_rules() -> dict:
    return {"peran": RULE_ROLES, "versi": _load_rules()}


@router.post("/aturan")
def post_rules(body: RulesIn) -> dict:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "hanya admin yang mengusulkan aturan orkestrator")
    try:
        return add_rules(body.peran, body.model, body.teks, body.label, body.skor, body.sumber, p.get("username") or p.get("id") or "lokal")
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


@router.post("/aturan/{rid}/status")
def set_rules_status(rid: str, body: StatusIn) -> dict:
    """Switch a version on (the one active version of its role and model: the one before it goes off) or off."""
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "hanya admin yang mengaktifkan atau menonaktifkan aturan orkestrator")
    who = p.get("username") or p.get("id") or "admin"
    with _lock:
        rows = _load_rules()
        rec = next((x for x in rows if x["id"] == rid), None)
        if not rec:
            raise HTTPException(404, "versi aturan tidak ada")
        if body.status == "aktif":
            for x in rows:
                if x is not rec and x["peran"] == rec["peran"] and x["model"] == rec["model"] and x["status"] == "aktif":
                    x["status"], x["catatan"] = "nonaktif", f"digantikan {rec['id']}"
        rec["status"], rec["diputuskan_oleh"], rec["diputuskan_pada"] = body.status, who, _now()
        _save_rules(rows)
    return rec
