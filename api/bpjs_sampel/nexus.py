"""Nexus for Data Sampel BPJS: object types on the gold datasets (and the silver code dimensions), their links, the
audit team's actions, functions, and the agent that answers for each group of objects.

Every object type belongs to one object type group, and each group is one AIP domain agent (api/aip): the
orchestrator hands a question about an object to the agent of its group, and that agent's tools work on its
objects only. The groups are therefore the ownership map the agents and the Nexus pages share.

    Agen Faskes & Wilayah   Provinsi, Kabupaten/Kota, Profil Faskes                     (+ the map)
    Agen Klaim & Fraud      Klaim Berisiko, Indikator INA-CBG, Klaim per Kab/Kota, Klaim Bulanan Provinsi
    Agen Rujukan            Alur Rujukan
    Agen Klinis             Diagnosis ICD-10, Kode INA-CBG, Penyakit Teratas
    Agen Peserta            Peserta Klaim Berisiko, Profil Peserta, Kunjungan FKTP Bulanan

build() first brings "Pipeline Data Sampel BPJS: Data Mentah → Siap Analisis" (bpjs_sampel/builder_pipeline: one
Pipeline Builder pipeline of visual nodes, bronze → silver → gold) up to its SPEC_VERSION and waits for the build (the
API that is running executes it), then creates what is missing; re-running is safe. Its outputs write over the silver
and gold datasets of the same name, so every type stays backed by the same Files item. Run in-process as the data's
owner, from PowerShell (Bash hangs on `import server`):

    import os, sys; os.chdir(r"D:\\BluesandAI\\ai-jkn-synthetic\\api"); sys.path.insert(0, ".")
    import server, db, auth
    db.init(server._env("BLUESANDAI_DATABASE_URL")); server._init_storage()
    auth._principal.set(auth.principal_of("u-075eb58af4"))
    from bpjs_sampel import nexus; print(nexus.build())
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import ontology

from bpjs_sampel import builder_pipeline
from bpjs_sampel.platform_upload import PROJECT, layout

# the SQL gold pipeline builder_pipeline replaced (2026-10-26): archived in pipelines/Arsip, no longer built
OLD_GOLD_PIPELINE_ID = "8872d4d1ff5c4231"
STATE_FILE = Path(os.environ.get("BLUESANDAI_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data")) / "bpjs-sampel" / "nexus_state.json"
FUNCTIONS_REPO = "Fungsi Nexus Data Sampel BPJS"
FUNCTIONS_VERSION = "1.0.0"

# group key → (name, what the agent answers for)
GROUPS = {
    "faskes": ("Agen Faskes & Wilayah (BPJS)", "Agen domain AIP untuk provinsi, kabupaten/kota dan profil faskes: volume dan risiko klaim per wilayah, "
               "profil faskes (pengganti ID faskes yang tidak ada di data sampel), peta."),
    "klaim": ("Agen Klaim & Fraud (BPJS)", "Agen domain AIP untuk klaim berisiko dan indikator INA-CBG: skrining, skor dan alasan risiko, perbandingan "
              "dengan peer (INA-CBG, tipe RS, regional tarif), agregat klaim per wilayah dan bulan; mengusulkan tahan klaim atau eskalasi."),
    "rujukan": ("Agen Rujukan (BPJS)", "Agen domain AIP untuk alur rujukan FKTP → FKRTL antarwilayah: rujukan lintas kab/kota dan provinsi, hari ke FKRTL, "
                "kesesuaian diagnosis."),
    "klinis": ("Agen Klinis (BPJS)", "Agen domain AIP untuk kode klinis: diagnosis ICD-10, kode INA-CBG (CMG, tipe kasus, keparahan) dan penyakit "
               "teratas; menilai kewajaran klinis klaim."),
    "peserta": ("Agen Peserta (BPJS)", "Agen domain AIP untuk peserta: peserta di balik klaim berisiko, profil kepesertaan per provinsi dan kunjungan FKTP."),
}

# key → (display name, api name, dataset (gold name, or silver:<name>), primary key (column, type), title, icon, color, group, description,
#        extra typed properties [(api, display, type)])
TYPES: dict[str, tuple] = {
    "provinsi": ("Provinsi (BPJS)", "ProvinsiBpjs", "provinsi", ("provinsi_kode", "integer"), "provinsi", "globe", "#5f6b7c", "faskes",
                 "Provinsi di Data Sampel BPJS Kesehatan 2025 (versi sintetis) dalam kode 38 provinsi data (pemekaran Papua 2022; dimensi gold wilayah: "
                 "kab/kota → provinsi), dengan volume dan risiko klaim FKRTL; titik peta di ibu kota provinsi.",
                 [("lokasi", "Lokasi (ibu kota)", "geopoint")]),
    "kabkota": ("Kabupaten/Kota (BPJS)", "KabupatenKotaBpjs", "kabkota", ("kabkota_kode", "integer"), "kabkota", "home", "#738694", "faskes",
                "Kabupaten/kota (kode BPS) dengan klaim FKRTL, readmisi 30 hari, klaim berisiko dan jumlah profil faskes.", []),
    "profil": ("Profil Faskes (BPJS)", "ProfilFaskesBpjs", "profil_faskes", ("faskes_profil_id", "string"), "nama_profil", "project", "#2d72d2", "faskes",
               "Profil faskes: kombinasi tingkat, kab/kota, kepemilikan, jenis dan tipe — pengganti ID faskes yang dianonimkan di data sampel. "
               "Klaim FKRTL, readmisi dan klaim berisiko per profil.", []),
    "klaim": ("Klaim Berisiko (BPJS)", "KlaimBerisikoBpjs", "klaim_berisiko", ("klaim_id", "string"), "klaim_id", "alert", "#c23030", "klaim",
              "Klaim FKRTL dengan indikasi risiko (calon klaim ganda, selisih tagih vs verifikasi, LOS di atas p99 INA-CBG), dengan statistik "
              "peer (INA-CBG, tipe RS, regional tarif), skor risiko 0–100 dan alasannya. Diputuskan tim verifikasi lewat action.", []),
    "indikator": ("Indikator INA-CBG (BPJS)", "IndikatorInacbgBpjs", "indikator_peer", ("indikator_id", "string"), "inacbg_deskripsi", "gauge", "#d9822b",
                  "klaim", "Statistik per edisi × INA-CBG × tipe RS × regional tarif: biaya median, LOS p50/p90, % readmisi, % calon klaim ganda, "
                  "% LOS ekstrem, % selisih verifikasi — pembanding (peer) skrining klaim. Kelompok peer dengan >= 30 klaim, ditambah setiap kelompok "
                  "yang dirujuk klaim berisiko (tabel lengkap: dataset gold indikator_inacbg).", []),
    "klaim_kabkota": ("Klaim per Kab/Kota (BPJS)", "KlaimKabkotaBpjs", "klaim_kabkota", ("klaim_kabkota_id", "string"), "klaim_kabkota_id", "table",
                      "#a66321", "klaim", "Agregat klaim FKRTL per edisi × kab/kota × tipe RS.", []),
    "klaim_bulanan": ("Klaim Bulanan Provinsi (BPJS)", "KlaimBulananProvinsiBpjs", "klaim_bulanan_provinsi", ("klaim_bulanan_id", "string"), "klaim_bulanan_id",
                      "wave", "#a66321", "klaim", "Agregat klaim FKRTL per edisi × bulan × provinsi: klaim, biaya, LOS, readmisi, indikasi risiko (rincian CMG × keparahan: "
                      "dataset gold klaim_bulanan).", []),
    "alur": ("Alur Rujukan (BPJS)", "AlurRujukanBpjs", "alur_rujukan", ("alur_rujukan_id", "string"), "alur_rujukan_id", "graph", "#238551", "rujukan",
             "Rujukan FKTP → FKRTL per edisi × kab/kota asal × kab/kota tujuan × tipe faskes tujuan: jumlah, median hari ke FKRTL, % diagnosis sama.", []),
    "icd": ("Diagnosis ICD-10 (BPJS)", "DiagnosisIcd10Bpjs", "silver:dim_icd10", ("icd3", "string"), "nama", "doc", "#d1980b", "klinis",
            "Kode ICD-10 3 digit dari buku kode resmi (nama, bab).", []),
    "inacbg": ("Kode INA-CBG (BPJS)", "KodeInacbgBpjs", "silver:dim_inacbg", ("inacbg_kode", "string"), "deskripsi", "info", "#d1980b", "klinis",
               "Kode INA-CBG: deskripsi, CMG, tipe kasus, spesifikasi, tingkat keparahan, jumlah pemakaian.", []),
    "penyakit": ("Penyakit Teratas (BPJS)", "PenyakitTeratasBpjs", "penyakit_teratas", ("penyakit_teratas_id", "string"), "diagnosis", "bug", "#d1980b",
                 "klinis", "20 diagnosis teratas per edisi × provinsi × tingkat (FKTP/FKRTL): kunjungan, peserta, biaya.", []),
    "peserta": ("Peserta Klaim Berisiko (BPJS)", "PesertaKlaimBerisikoBpjs", "peserta_klaim_berisiko", ("peserta_key", "string"), "peserta_key", "device",
                "#7961db", "peserta", "Peserta (nomor sintetis) dengan klaim berisiko: demografi, segmen, wilayah tinggal, FKTP terdaftar, jumlah klaim "
                "berisiko dan skor tertinggi.", []),
    "profil_peserta": ("Profil Peserta (BPJS)", "ProfilPesertaBpjs", "profil_peserta", ("profil_peserta_id", "string"), "profil_peserta_id", "layers",
                       "#7961db", "peserta", "Jumlah peserta per edisi × provinsi × segmen × jenis kelamin × kelompok usia.", []),
    "fktp": ("Kunjungan FKTP Bulanan (BPJS)", "KunjunganFktpBulananBpjs", "kunjungan_fktp_provinsi", ("kunjungan_fktp_bulanan_id", "string"),
             "kunjungan_fktp_bulanan_id", "wave", "#2d72d2", "peserta", "Kunjungan FKTP per edisi × bulan × provinsi × jenis FKTP, "
             "dengan rasio rujuk lanjut (rincian per poli: dataset gold kunjungan_fktp_bulanan).", []),
}

# live types (ontology_live): their objects are read straight from the gold dataset with DuckDB, never indexed — every
# claim is an object the rules and the agents can reach, not only the ones a screening let through.
# key → (display name, api name, gold dataset, primary key (column, type), title, icon, color, group, description)
LIVE_TYPES: dict[str, tuple] = {
    # backed by the second pipeline's output (bpjs_sampel/fakta_pipeline.py): the claims and their facts
    "klaim_fkrtl": ("Klaim FKRTL (BPJS)", "KlaimFkrtlBpjs", "klaim_fkrtl_fakta", ("klaim_id", "string"), "klaim_id", "table", "#a82a2a", "klaim",
                    "Semua klaim FKRTL Data Sampel BPJS 2025 versi sintetis, satu objek per klaim, dibaca langsung dari dataset klaim_fkrtl_fakta (pipeline Fakta "
                    "Klaim) oleh mesin objek live (tidak diindeks): wilayah, profil faskes, INA-CBG, tarif + top-up, bobot sampel, salinan lintas edisi, "
                    "dan fakta awal audit — di luar tarif, kelas di atas hak, rawat inap tumpang tindih, klaim berganda di hari sama, readmisi di RS sama."),
}
LIVE_LINKS = [
    ("Klaim FKRTL di profil faskes (BPJS)", "klaim_fkrtl", "faskes_profil_id", "profil", "Klaim FKRTL", "Profil faskes"),
    ("Klaim FKRTL di kab/kota (BPJS)", "klaim_fkrtl", "kabkota_kode", "kabkota", "Klaim FKRTL", "Kabupaten/kota"),
    ("Klaim FKRTL dengan kode INA-CBG (BPJS)", "klaim_fkrtl", "inacbg_kode", "inacbg", "Klaim FKRTL", "Kode INA-CBG"),
    ("Klaim FKRTL dengan diagnosis primer (BPJS)", "klaim_fkrtl", "dx_primer_icd3", "icd", "Klaim FKRTL", "Diagnosis primer"),
    ("Klaim berisiko sebagai klaim FKRTL (BPJS)", "klaim", "klaim_id", "klaim_fkrtl", "Klaim berisiko", "Klaim FKRTL"),
]

# (link name, source type, foreign key on the source, target type, how the source's objects are named from the target, target's name)
LINKS = [
    ("Kab/kota di provinsi (BPJS)", "kabkota", "provinsi_kode", "provinsi", "Kabupaten/kota", "Provinsi"),
    ("Profil faskes di kab/kota (BPJS)", "profil", "kabkota_kode", "kabkota", "Profil faskes", "Kabupaten/kota"),
    ("Klaim berisiko di profil faskes (BPJS)", "klaim", "faskes_profil_id", "profil", "Klaim berisiko", "Profil faskes"),
    ("Klaim berisiko di kab/kota (BPJS)", "klaim", "kabkota_kode", "kabkota", "Klaim berisiko", "Kabupaten/kota"),
    ("Klaim berisiko milik peserta (BPJS)", "klaim", "peserta_key", "peserta", "Klaim berisiko", "Peserta"),
    ("Klaim berisiko dalam peer indikator (BPJS)", "klaim", "indikator_id", "indikator", "Klaim berisiko", "Indikator peer"),
    ("Klaim berisiko dengan kode INA-CBG (BPJS)", "klaim", "inacbg_kode", "inacbg", "Klaim berisiko", "Kode INA-CBG"),
    ("Klaim berisiko dengan diagnosis primer (BPJS)", "klaim", "dx_primer_icd3", "icd", "Klaim berisiko", "Diagnosis primer"),
    ("Indikator untuk kode INA-CBG (BPJS)", "indikator", "inacbg_kode", "inacbg", "Indikator", "Kode INA-CBG"),
    ("Klaim kab/kota di kab/kota (BPJS)", "klaim_kabkota", "kabkota_kode", "kabkota", "Klaim per kab/kota", "Kabupaten/kota"),
    ("Klaim bulanan di provinsi (BPJS)", "klaim_bulanan", "provinsi_kode", "provinsi", "Klaim bulanan", "Provinsi"),
    ("Rujukan dari kab/kota (BPJS)", "alur", "kabkota_asal_kode", "kabkota", "Rujukan keluar", "Kab/kota asal"),
    ("Rujukan ke kab/kota (BPJS)", "alur", "kabkota_tujuan_kode", "kabkota", "Rujukan masuk", "Kab/kota tujuan"),
    ("Penyakit teratas dengan ICD-10 (BPJS)", "penyakit", "icd3", "icd", "Penyakit teratas", "Diagnosis ICD-10"),
    ("Penyakit teratas di provinsi (BPJS)", "penyakit", "provinsi_kode", "provinsi", "Penyakit teratas", "Provinsi"),
    ("Kunjungan FKTP di provinsi (BPJS)", "fktp", "provinsi_kode", "provinsi", "Kunjungan FKTP bulanan", "Provinsi"),
    ("Profil peserta di provinsi (BPJS)", "profil_peserta", "provinsi_kode", "provinsi", "Profil peserta", "Provinsi"),
    ("Peserta tinggal di kab/kota (BPJS)", "peserta", "kabkota_tinggal_kode", "kabkota", "Peserta klaim berisiko", "Kab/kota tinggal"),
]

# properties only the team's actions write (no column backs them, so re-indexes keep them)
EDIT_PROPS = {
    "klaim": [("status_verifikasi", "Status verifikasi", "string"), ("hasil_verifikasi", "Hasil verifikasi", "string"),
              ("catatan_verifikasi", "Catatan verifikasi", "string"), ("tanggal_keputusan", "Tanggal keputusan", "date")],
    "profil": [("status_audit", "Status audit", "string"), ("prioritas_audit", "Prioritas audit", "string"),
               ("tanggal_audit", "Tanggal audit", "date"), ("catatan_audit", "Catatan audit", "string")],
    "indikator": [("status_pemantauan", "Status pemantauan", "string"), ("catatan_pemantauan", "Catatan pemantauan", "string")],
}

# (action name, type, parameter label for the object, description, [(property, label, required)])
ACTIONS = [
    ("Tahan klaim untuk verifikasi (BPJS)", "klaim", "Klaim",
     "Tahan pembayaran klaim berisiko sampai verifikator memeriksanya; alasan wajib diisi. Agen hanya boleh mengusulkan, manusia yang menjalankan.",
     [("status_verifikasi", "Status verifikasi (Ditahan)", True), ("catatan_verifikasi", "Alasan penahanan", True), ("tanggal_keputusan", "Tanggal", False)]),
    ("Minta berkas tambahan (BPJS)", "klaim", "Klaim",
     "Minta resume medis atau dokumen pendukung lain ke faskes sebelum klaim diputuskan.",
     [("status_verifikasi", "Status verifikasi (Menunggu berkas)", True), ("catatan_verifikasi", "Berkas yang diminta", True)]),
    ("Catat hasil verifikasi (BPJS)", "klaim", "Klaim",
     "Hasil pemeriksaan klaim: Terbukti, Positif palsu (klaim wajar) atau Perlu koreksi — umpan balik bagi aturan dan agen.",
     [("hasil_verifikasi", "Hasil verifikasi", True), ("status_verifikasi", "Status verifikasi (Selesai)", True), ("catatan_verifikasi", "Catatan", False),
      ("tanggal_keputusan", "Tanggal keputusan", False)]),
    ("Eskalasi klaim ke investigasi (BPJS)", "klaim", "Klaim",
     "Naikkan klaim ke tim investigasi kedeputian wilayah, dengan alasan eskalasi.",
     [("status_verifikasi", "Status verifikasi (Eskalasi investigasi)", True), ("catatan_verifikasi", "Alasan eskalasi", True)]),
    ("Jadwalkan audit profil faskes (BPJS)", "profil", "Profil faskes",
     "Jadwalkan audit untuk sebuah profil faskes (tingkat, wilayah, kepemilikan, jenis, tipe) dengan prioritas dan tanggal.",
     [("status_audit", "Status audit", True), ("prioritas_audit", "Prioritas", True), ("tanggal_audit", "Tanggal audit", False),
      ("catatan_audit", "Catatan", False)]),
    ("Pantau indikator INA-CBG (BPJS)", "indikator", "Indikator",
     "Tandai satu indikator INA-CBG (edisi, tipe RS, regional) untuk dipantau, misalnya % readmisi atau % LOS ekstrem yang tinggi.",
     [("status_pemantauan", "Status pemantauan", True), ("catatan_pemantauan", "Catatan", False)]),
]

FUNCTIONS_PY = '''"""Fungsi Nexus Data Sampel BPJS.

Functions on the BPJS Nexus (Klaim Berisiko, Profil Faskes, Kabupaten/Kota). Those returning objects are
function-backed Search Arounds in Vertex and tools for the AIP domain agents; the others are derived values.
"""

from functions.api import Integer, String, function
from ontology_sdk import FoundryClient
from ontology_sdk.ontology.objects import KabupatenKotaBpjs, KlaimBerisikoBpjs, ProfilFaskesBpjs


def _objects():
    return FoundryClient().ontology.objects


def _rp(v) -> str:
    return "Rp " + f"{float(v or 0):,.0f}".replace(",", ".")


def _by_score(claims) -> list:
    return sorted(claims, key=lambda c: (-(c.skor_risiko or 0), c.klaim_id))


@function
def alasan_risiko_klaim(klaim: KlaimBerisikoBpjs) -> String:
    """Penjelasan skor risiko klaim: indikasi, perbandingan dengan peer (INA-CBG, tipe RS, regional tarif), status verifikasi."""
    lines = [f"Skor {klaim.skor_risiko}/100 dari {klaim.jumlah_indikasi} indikasi: {klaim.alasan_risiko}."]
    if klaim.peer_biaya_p50_rp:
        lines.append(f"Biaya tagih {_rp(klaim.biaya_tagih_rp)} = {klaim.rasio_biaya_peer}x median {klaim.peer_klaim} klaim peer "
                     f"({_rp(klaim.peer_biaya_p50_rp)}; {klaim.inacbg_kode}, {klaim.tipe_fkrtl}, regional {klaim.regional_tarif}).")
    if klaim.rawat_inap and klaim.peer_los_inap_p90:
        lines.append(f"LOS {klaim.los_hari} hari; p90 rawat inap peer {klaim.peer_los_inap_p90} hari.")
    if klaim.status_verifikasi:
        lines.append(f"Status verifikasi: {klaim.status_verifikasi}" + (f" ({klaim.hasil_verifikasi})" if klaim.hasil_verifikasi else "")
                     + (f" — {klaim.catatan_verifikasi}" if klaim.catatan_verifikasi else "") + ".")
    return "\\n".join(lines)


@function
def potensi_kelebihan_bayar(klaim: KlaimBerisikoBpjs) -> Integer:
    """Perkiraan kelebihan bayar (Rp): selisih tagih vs verifikasi bila ditandai, ditambah biaya di atas median peer bila >= 2x median."""
    lebih = float(klaim.selisih_rp or 0) if klaim.flag_selisih_verifikasi else 0.0
    if klaim.peer_biaya_p50_rp and float(klaim.rasio_biaya_peer or 0) >= 2:
        lebih += float(klaim.biaya_tagih_rp or 0) - float(klaim.peer_biaya_p50_rp)
    return int(max(0.0, lebih))


@function
def klaim_serupa(klaim: KlaimBerisikoBpjs) -> list[KlaimBerisikoBpjs]:
    """Klaim berisiko lain dari peserta yang sama, atau dari profil faskes yang sama dengan kode INA-CBG yang sama (pola berulang)."""
    k = _objects().KlaimBerisikoBpjs
    out, seen = [], {klaim.klaim_id}
    for c in k.where(KlaimBerisikoBpjs.object_type.peserta_key == klaim.peserta_key).iterate():
        if c.klaim_id not in seen:
            seen.add(c.klaim_id)
            out.append(c)
    for c in k.where(KlaimBerisikoBpjs.object_type.faskes_profil_id == klaim.faskes_profil_id).iterate():
        if c.inacbg_kode == klaim.inacbg_kode and c.klaim_id not in seen:
            seen.add(c.klaim_id)
            out.append(c)
    return _by_score(out)[:25]


@function
def klaim_teratas_profil(profil: ProfilFaskesBpjs) -> list[KlaimBerisikoBpjs]:
    """20 klaim berisiko dengan skor tertinggi di profil faskes ini."""
    k = _objects().KlaimBerisikoBpjs
    return _by_score(k.where(KlaimBerisikoBpjs.object_type.faskes_profil_id == profil.faskes_profil_id).iterate())[:20]


@function
def klaim_teratas_kabkota(kabkota: KabupatenKotaBpjs) -> list[KlaimBerisikoBpjs]:
    """20 klaim berisiko dengan skor tertinggi di kabupaten/kota ini."""
    k = _objects().KlaimBerisikoBpjs
    return _by_score(k.where(KlaimBerisikoBpjs.object_type.kabkota_kode == kabkota.kabkota_kode).iterate())[:20]


@function
def ringkasan_risiko_profil(profil: ProfilFaskesBpjs) -> String:
    """Ringkasan risiko profil faskes: volume klaim, klaim berisiko per indikasi, readmisi 30 hari."""
    n = int(profil.klaim_fkrtl or 0)
    if not n:
        return f"{profil.nama_profil}: tidak ada klaim FKRTL (profil {profil.tingkat})."
    share = 100.0 * int(profil.klaim_berisiko or 0) / n
    return (f"{profil.nama_profil}: {n:,} klaim FKRTL, {_rp(profil.biaya_tagih_rp)} ditagih. ".replace(",", ".")
            + f"{profil.klaim_berisiko} klaim berisiko ({share:.2f}%): {profil.calon_klaim_ganda or 0} calon klaim ganda, "
            + f"{profil.selisih_verifikasi or 0} selisih verifikasi, {profil.los_ekstrem or 0} LOS ekstrem. "
            + f"Readmisi 30 hari {profil.pct_readmisi_30 or 0}% dari rawat inap."
            + (f" Status audit: {profil.status_audit}." if profil.status_audit else ""))


@function
def ringkasan_risiko_kabkota(kabkota: KabupatenKotaBpjs) -> String:
    """Ringkasan risiko kabupaten/kota: klaim, klaim berisiko, readmisi, profil faskes."""
    n = int(kabkota.klaim_fkrtl or 0)
    share = 100.0 * int(kabkota.klaim_berisiko or 0) / n if n else 0.0
    return (f"{kabkota.kabkota} ({kabkota.provinsi}): {n:,} klaim FKRTL di {kabkota.profil_faskes} profil faskes, ".replace(",", ".")
            + f"{kabkota.klaim_berisiko} klaim berisiko ({share:.2f}%), readmisi 30 hari {kabkota.pct_readmisi_30 or 0}%.")
'''

FUNCTIONS_README = """# Fungsi Nexus Data Sampel BPJS

Functions on the BPJS Nexus, published to the functions registry. Tools of the AIP domain agents and Search Arounds in Vertex.

| Function | Input | Output |
|---|---|---|
| alasan_risiko_klaim | Klaim Berisiko | String (explainable risk) |
| potensi_kelebihan_bayar | Klaim Berisiko | Integer (Rp) |
| klaim_serupa | Klaim Berisiko | Klaim Berisiko[] |
| klaim_teratas_profil | Profil Faskes | Klaim Berisiko[] |
| klaim_teratas_kabkota | Kabupaten/Kota | Klaim Berisiko[] |
| ringkasan_risiko_profil | Profil Faskes | String |
| ringkasan_risiko_kabkota | Kabupaten/Kota | String |
"""


# ------------------------------------------------------------------------------------------------
# state
# ------------------------------------------------------------------------------------------------


def _state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _save(st: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(st, indent=1, ensure_ascii=False), "utf-8")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------------------------------------
# the pipeline (builder_pipeline: Data Mentah → Siap Analisis, visual nodes) at its SPEC_VERSION, built: it writes the
# silver and gold datasets the Nexus types are backed by
# ------------------------------------------------------------------------------------------------


def _files(folder_id: str) -> dict[str, dict]:
    import db

    return {c["name"].removesuffix(".parquet"): c for c in db.drive_list(folder_id) if not c.get("trashed_at") and c["name"].endswith(".parquet")}


def _sources(ids: dict) -> dict[str, dict]:
    """Each input of the pipeline (the bronze tables, the label books and references in bronze/_meta, the ICD-10 book
    in silver): its Files item, first rows (the editor's sample) and row count."""
    import drive
    import pyarrow.dataset as pads

    from bpjs_sampel.platform_upload import folder

    files = {"bronze": _files(ids["bronze"]), "bronze/_meta": _files(folder(ids["bronze"], "_meta")), "silver": _files(ids["silver"])}
    out = {}
    for key, fold, _, _ in builder_pipeline.SOURCES:
        item = files[fold][key]
        ds = pads.dataset(str(drive.LOCAL_DIR / item["id"]), format="parquet")
        out[key] = {"item_id": item["id"], "table": ds.head(builder_pipeline.SAMPLE), "rows": ds.count_rows(), "folder": fold}
    return out


def _catalog(ids: dict) -> dict[tuple[str, str], tuple[str, str]]:
    """(table, source column code) → (its label in the Stata files, the .dta file it is written in), from
    bronze/_meta/katalog_*: the reguler edition's, else another edition's non-empty one. Per table: a code can mean
    another thing in another table (FKP02)."""
    import drive
    import pyarrow.parquet as pq

    from bpjs_sampel.platform_upload import folder

    out: dict[tuple[str, str], tuple[str, str]] = {}
    for name, item in sorted(_files(folder(ids["bronze"], "_meta")).items()):
        if not name.startswith("katalog_"):
            continue
        rows = pq.read_table(drive.LOCAL_DIR / item["id"], columns=["edisi", "tabel", "kolom", "label", "file"]).to_pylist()
        for r in sorted(rows, key=lambda r: r["edisi"] != "reguler"):
            if r["label"] and (r["tabel"], r["kolom"]) not in out:
                out[(r["tabel"], r["kolom"])] = (r["label"], r["file"])
    return out


def _upstream(ids: dict) -> dict:
    """How the bronze inputs were made from the raw .dta files (builder_upstream.build): the files from the katalog, each
    bronze dataset's latest successful build in the Code Repository and the bronze code at its commit."""
    import code_repos
    import db
    import drive
    import pyarrow.parquet as pq

    from bpjs_sampel import builder_notes, builder_upstream
    from bpjs_sampel.platform_upload import folder

    raw_items = {}
    for name in [k for k in ids if k.startswith("raw_") and k != "raw_icd10"]:
        raw_items.update({(name[4:], c["name"]): c["id"] for c in db.drive_list(ids[name]) if not c.get("trashed_at")})
    files, seen = [], set()
    for name, item in sorted(_files(folder(ids["bronze"], "_meta")).items()):
        if not name.startswith("katalog_"):
            continue
        ds = name[len("katalog_"):].removesuffix(".parquet")
        for r in pq.read_table(drive.LOCAL_DIR / item["id"], columns=["edisi", "tabel", "file", "file_bytes", "file_sha256", "file_rows"]).to_pylist():
            if (ds, r["file"]) in seen:
                continue
            seen.add((ds, r["file"]))
            files.append({"name": r["file"], "edisi": r["edisi"], "tabel": r["tabel"], "dataset": ds, "bytes": r["file_bytes"], "sha256": r["file_sha256"],
                          "rows": r["file_rows"], "item_id": raw_items.get((ds, r["file"]))})
    bronze = {n.removesuffix(".parquet"): pq.ParquetFile(drive.LOCAL_DIR / i["id"]).metadata.num_rows for n, i in _files(ids["bronze"]).items()}
    repo = next((r for r in code_repos.list_repos() if r.get("name") == builder_upstream.REPO_NAME), None) if hasattr(code_repos, "list_repos") else None
    builds, code, messages = {}, {}, {}
    if repo:
        for b in code_repos._builds(repo["id"]):
            t = str(b.get("transform", ""))
            if b.get("status") != "succeeded" or not t.startswith(builder_upstream.BRONZE_PY + "::bronze_"):
                continue
            ds = t.split("::bronze_", 1)[1]
            if ds not in builds or b["at"] > builds[ds]["at"]:
                builds[ds] = {"commit": b.get("commit"), "at": b["at"], "id": b["id"]}
        for c in {b["commit"] for b in builds.values() if b["commit"]}:
            code[c] = code_repos._commit_files(repo["id"], c).get(builder_upstream.BRONZE_PY, "")
            messages[c] = (code_repos._read(repo["id"], f"commits/{c}.json", {}).get("commit") or {}).get("message", "")
        repo = {"id": repo["id"], "name": repo["name"]}
    verified = builder_upstream.rehash(files, lambda f: drive.LOCAL_DIR / f["item_id"] if f["item_id"] else None)
    return builder_upstream.build(files, bronze, builds, code, messages, {"id": ids["raw"], "name": f"{PROJECT} / raw"}, repo, builder_notes.DOC,
                                  verified)


def _seed_outputs(pipeline_id: str, ids: dict) -> list[str]:
    """Point each output at the dataset of its name in silver/ or gold/ (the runner writes over the item an output's
    state names): the Nexus types, AIP and the ML jobs keep reading the same Files items. Outputs already there stay."""
    import pipeline_runtime as rt

    seeded = []
    for layer, names in (("silver", builder_pipeline.SILVER_KEYS), ("gold", builder_pipeline.GOLD_KEYS)):
        files = _files(ids[layer])
        for name in names:
            key = f"output:o_{name}"
            item = files.get(name)
            if not item or (rt.get_state(pipeline_id, key) or {}).get("parentId") == ids[layer]:
                continue
            rt.set_state(pipeline_id, key, {"itemId": item["id"], "parentId": ids[layer], "path": f"{PROJECT}/{layer}/{item['name']}",
                                            "rows": None, "columns": None, "version": 0})
            seeded.append(name)
    return seeded


def gold(wait: float = 1800) -> dict:
    """Bring the pipeline up to SPEC_VERSION and build it: the running API executes the build, and this process waits
    for it (the thread that hands a queued build to the runner lives in the process that queued it)."""
    import pipeline_runtime as rt

    ids = layout()
    st = _state()
    folders = {layer: {"id": ids[layer], "name": f"{PROJECT} / {layer}"} for layer in ("silver", "gold")}
    r = builder_pipeline.ensure(_sources(ids), folders, ids["pipelines"], PROJECT, existing=st.get("builder_pipeline_id"), queue=False,
                                catalog=_catalog(ids), upstream=_upstream(ids))
    pid = r["pipeline_id"]
    if pid != st.get("builder_pipeline_id"):
        _save({**_state(), "builder_pipeline_id": pid})
    if not r.get("outputs"):
        return {"pipeline_id": pid, "version": builder_pipeline.SPEC_VERSION, "rebuilt": False}
    seeded = _seed_outputs(pid, ids)
    build = rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="manual"))["id"]
    t0 = time.time()
    while time.time() - t0 < wait:
        b = rt._build(build)
        if b["status"] in ("succeeded", "failed", "cancelled"):
            return {"pipeline_id": pid, "build": build, "status": b["status"], "secs": round(time.time() - t0), "seeded": seeded,
                    "error": b.get("error") or b.get("message")}
        time.sleep(5)
    return {"pipeline_id": pid, "build": build, "status": "still running", "seeded": seeded}


# ------------------------------------------------------------------------------------------------
# the Nexus
# ------------------------------------------------------------------------------------------------


def _type(display: str) -> Optional[dict]:
    return next((t for t in ontology._all("object-types") if t["display_name"] == display), None)


def ensure_groups() -> dict[str, str]:
    import ontology_model as om

    have = {g["name"]: g["id"] for g in om._groups()}
    out = {}
    for key, (name, desc) in GROUPS.items():
        out[key] = have.get(name) or om.create_group(om.GroupIn(name=name, description=desc))["id"]
    return out


def ensure_types(groups: dict[str, str]) -> dict[str, str]:
    out = {}
    for key, (display, api, _ds, (pk, pk_type), title, icon, color, group, desc, extra) in TYPES.items():
        t = _type(display)
        if not t:
            props = [ontology.Property(api_name=pk, display_name=pk.replace("_", " ").capitalize(), type=pk_type, render_hints=["searchable", "identifier"])]
            if title != pk:
                props.append(ontology.Property(api_name=title, display_name=title.replace("_", " ").capitalize(), type="string", render_hints=["searchable"]))
            props += [ontology.Property(api_name=a, display_name=d, type=ty) for a, d, ty in extra]
            t = ontology.create_object_type(ontology.ObjectTypeIn(
                display_name=display, plural_name=display, api_name=api, primary_key=pk, title_property=title, icon=icon, color=color,
                description=desc, properties=props, groups=[groups[group]], status="active"))
        elif groups[group] not in (t.get("groups") or []) or t.get("description") != desc or t.get("icon") != icon:
            with ontology._lock:
                rec = ontology._object_type(t["id"])
                rec["groups"] = list(dict.fromkeys([*(rec.get("groups") or []), groups[group]]))
                rec["description"] = desc
                rec["icon"] = icon
                ontology._put("object-types", rec)
        out[key] = t["id"]
    return out


def attach(type_ids: dict[str, str]) -> dict[str, Any]:
    """Back each type with its dataset (columns mapped by name; the others become properties)."""
    import ontology_datasources as ods

    ids = layout()
    gold_files, silver_files = _files(ids["gold"]), _files(ids["silver"])
    out = {}
    for key, spec in TYPES.items():
        ds = spec[2]
        item = silver_files[ds.split(":", 1)[1]] if ds.startswith("silver:") else gold_files[ds]
        rec = ontology._object_type(type_ids[key])
        if (rec.get("backing_dataset") or {}).get("dataset_id") == item["id"]:
            import drive
            import pyarrow.dataset as pads

            have = {p["api_name"] for p in rec["properties"]}
            new_cols = [c for c in pads.dataset(str(drive.LOCAL_DIR / item["id"]), format="parquet").schema.names if c not in have]
            if not new_cols:
                out[key] = "attached"
                continue
            # columns the dataset gained since the type was backed (a newer gold spec): mapped as new properties
        r = ods.put_datasource(type_ids[key], ods.DatasourceIn(dataset_id=item["id"], columns=None, map_unmapped=True))
        out[key] = {"imported": r.get("imported"), "dataset": item["name"]}
    order_properties(type_ids)
    return out


def order_properties(type_ids: dict[str, str]) -> list[str]:
    """Each type's properties in its dataset's column order (columns added by a later gold spec otherwise come last),
    the properties only actions write at the end: what the Nexus pages and the agents read first comes first."""
    import drive
    import pyarrow.dataset as pads

    ids = layout()
    gold_files, silver_files = _files(ids["gold"]), _files(ids["silver"])
    changed = []
    with ontology._lock:
        for key, spec in TYPES.items():
            ds = spec[2]
            item = silver_files[ds.split(":", 1)[1]] if ds.startswith("silver:") else gold_files[ds]
            cols = pads.dataset(str(drive.LOCAL_DIR / item["id"]), format="parquet").schema.names
            rank = {c: i for i, c in enumerate(cols)}
            rec = ontology._object_type(type_ids[key])
            ordered = sorted(rec["properties"], key=lambda p: rank.get(p["api_name"], len(cols)))
            if [p["api_name"] for p in ordered] != [p["api_name"] for p in rec["properties"]]:
                rec["properties"] = ordered
                ontology._put("object-types", rec)
                changed.append(key)
    return changed


def ensure_edit_props(type_ids: dict[str, str]) -> list[str]:
    import ontology_edits

    added = []
    with ontology._lock:
        for key, props in EDIT_PROPS.items():
            rec = ontology._object_type(type_ids[key])
            new = [(a, d, ty) for a, d, ty in props if not any(p["api_name"] == a for p in rec["properties"])]
            if new:
                rec["properties"] += [{"api_name": a, "display_name": d, "type": ty, "description": "Diisi lewat action tim verifikasi/audit."} for a, d, ty in new]
                ontology._put("object-types", rec)
                added += [f"{key}.{a}" for a, _, _ in new]
    for key in EDIT_PROPS:
        if not ontology_edits.config(ontology._object_type(type_ids[key]))["history"]:
            ontology_edits.set_config(type_ids[key], ontology_edits.EditsConfigIn(history=True))
    return added


def ensure_links(type_ids: dict[str, str]) -> list[str]:
    import ontology_model as om

    have = {x.get("display_name") for x in ontology._all("link-types")}
    made = []
    for name, src, fk, tgt, src_label, tgt_label in LINKS:
        if name in have:
            continue
        om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key=fk, status="active",
                                          source=om.LinkSide(object_type_id=type_ids[src], display_name=src_label, plural_display_name=src_label),
                                          target=om.LinkSide(object_type_id=type_ids[tgt], display_name=tgt_label)))
        made.append(name)
    return made


def ensure_actions(type_ids: dict[str, str]) -> list[str]:
    have = {a["display_name"] for a in ontology._all("action-types")}
    made = []
    for name, key, label, desc, params in ACTIONS:
        if name in have:
            continue
        props = {p["api_name"]: p for p in ontology._object_type(type_ids[key])["properties"]}
        ontology.create_action_type(ontology.ActionTypeIn(
            display_name=name, object_type_id=type_ids[key], kind="modify", status="active", description=desc,
            parameters=[ontology.Parameter(id="object", display_name=label, type="object", required=True)]
            + [ontology.Parameter(id=pid, display_name=plabel, type=props[pid]["type"], property=pid, required=req) for pid, plabel, req in params]))
        made.append(name)
    return made


def ensure_functions() -> dict:
    import code_repos as cr
    import functions_registry as fr

    repo = next((r for r in cr.list_repos() if r["name"] == FUNCTIONS_REPO), None)
    if not repo:
        repo = cr.create_repo(cr.RepoIn(name=FUNCTIONS_REPO, description="Functions on the Data Sampel BPJS Nexus: explainable claim risk, similar claims, "
                                                                          "overpayment estimate, risk summaries per facility profile and kab/kota."))
    d = fr._repo_data(repo["id"])
    if any(r["version"] == FUNCTIONS_VERSION for r in d["releases"]):
        return {"repo_id": repo["id"], "published": False}
    with cr._lock:
        rec = cr._repo(repo["id"])
        branch = rec["default_branch"]
        files = dict(rec["branches"][branch]["files"])
        files["README.md"] = FUNCTIONS_README
        files["python-functions/src/bpjs_nexus/__init__.py"] = ""
        files["python-functions/src/bpjs_nexus/risiko.py"] = FUNCTIONS_PY
        commit = cr._commit(rec, branch, "Fungsi Nexus Data Sampel BPJS", files=files)
    release = fr.publish(repo["id"], FUNCTIONS_VERSION, commit["id"])
    return {"repo_id": repo["id"], "published": True, "functions": [f["name"] for f in release["functions"]]}


MAP = "Peta risiko klaim BPJS (Data Sampel 2025)"
# risky-claim classes of a province: one layer each (object layers have no size-by), the map's legend
MAP_CLASSES = [("≥ 500 klaim berisiko", "#c23030", [{"property": "klaim_berisiko", "op": "gte", "value": 500}]),
               ("200–499", "#d9822b", [{"property": "klaim_berisiko", "op": "gte", "value": 200}, {"property": "klaim_berisiko", "op": "lt", "value": 500}]),
               ("50–199", "#d1980b", [{"property": "klaim_berisiko", "op": "gte", "value": 50}, {"property": "klaim_berisiko", "op": "lt", "value": 200}]),
               ("< 50", "#238551", [{"property": "klaim_berisiko", "op": "lt", "value": 50}])]


def ensure_map(type_ids: dict[str, str]) -> dict:
    """The provinces on the platform's Map app, one layer per risky-claim class (points at the provincial capital)."""
    import geospatial

    m = next((m for m in geospatial.list_maps() if m.get("name") == MAP), None)
    if not m:
        layers = [geospatial.Layer(name=f"Provinsi · {label}", kind="objects", color=color, opacity=1.0,
                                   config={"object_type_id": type_ids["provinsi"], "property": "lokasi", "filters": filters})
                  for label, color, filters in MAP_CLASSES]
        m = geospatial.create_map(geospatial.MapIn(
            name=MAP, basemap="streets", view={"lat": -2.5, "lon": 118.0, "zoom": 5}, layers=layers,
            description="Data Sampel BPJS Kesehatan 2025 (versi sintetis): provinsi (titik di ibu kota) menurut jumlah klaim FKRTL berisiko — calon klaim "
                        "ganda, selisih tagih vs verifikasi, LOS di atas p99 INA-CBG. Klik provinsi untuk klaim, readmisi dan klaim berisiko."))
    return {"map_id": m["id"]}


def ensure_live(groups: dict[str, str], type_ids: dict[str, str]) -> dict[str, Any]:
    """The live types (LIVE_TYPES) backed by their gold dataset through ontology_live, and their links."""
    import ontology_live
    import ontology_model as om

    ids = layout()
    gold_files = _files(ids["gold"])
    out: dict[str, Any] = {}
    for key, (display, api, ds, (pk, pk_type), title, icon, color, group, desc) in LIVE_TYPES.items():
        t = _type(display)
        if not t:
            props = [ontology.Property(api_name=pk, display_name=pk.replace("_", " ").capitalize(), type=pk_type, render_hints=["searchable", "identifier"])]
            t = ontology.create_object_type(ontology.ObjectTypeIn(
                display_name=display, plural_name=display, api_name=api, primary_key=pk, title_property=title, icon=icon, color=color,
                description=desc, properties=props, groups=[groups[group]], status="active"))
        type_ids[key] = t["id"]
        m = ontology_live.meta(t["id"])
        item = gold_files.get(ds)
        out[key] = "live" if m and item and m["dataset_id"] == item["id"] else ontology_live.back(t["id"], item["id"], None, True) if item else "no dataset yet"
    have = {x.get("display_name") for x in ontology._all("link-types")}
    for name, src, fk, tgt, src_label, tgt_label in LIVE_LINKS:
        if name not in have and src in type_ids and tgt in type_ids:
            om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key=fk, status="active",
                                              source=om.LinkSide(object_type_id=type_ids[src], display_name=src_label, plural_display_name=src_label),
                                              target=om.LinkSide(object_type_id=type_ids[tgt], display_name=tgt_label)))
            out.setdefault("links", []).append(name)
    return out


def build(rebuild_gold: bool = True) -> dict:
    st = _state()
    out: dict[str, Any] = {}
    if rebuild_gold:
        out["gold"] = gold()
        if out["gold"].get("status") not in (None, "succeeded"):
            return out
    groups = ensure_groups()
    type_ids = ensure_types(groups)
    out["groups"], out["types"] = groups, type_ids
    out["attach"] = attach(type_ids)
    out["live"] = ensure_live(groups, type_ids)
    out["edit_props"] = ensure_edit_props(type_ids)
    out["links"] = ensure_links(type_ids)
    out["actions"] = ensure_actions(type_ids)
    out["functions"] = ensure_functions()
    out["map"] = ensure_map(type_ids)
    out["lineage"] = ensure_lineage_graph()
    st.update({"groups": groups, "types": type_ids, "map_id": out["map"]["map_id"], "built_at": _now(), "pipeline_spec": builder_pipeline.SPEC_VERSION})
    _save(st)
    return out


# aip/domains.py finds it by this name (until 2026-10-26: "Data Sampel BPJS: raw → bronze → silver → gold")
LINEAGE_GRAPH = "Data Sampel BPJS: Arsip Sumber → Data Mentah → Data Bersih → Siap Analisis"


def ensure_lineage_graph() -> dict:
    """The saved lineage graph of the BPJS data, whole: every node the chain reaches in the live lineage (raw files,
    bronze transforms, the pipelines and their outputs, the Nexus types backed by them, their functions and the map)
    and the actions on those types. What someone placed by hand stays; a job that no longer writes anything current
    leaves (the silver transforms of the Code Repository and the SQL gold pipeline, both replaced by the Pipeline
    Builder pipeline on 2026-10-26: the lineage keeps only a dataset's current producer)."""
    import collections

    import lineage

    old = next((g for g in lineage.list_graphs() if g.get("name") == LINEAGE_GRAPH), None)
    if not old:
        return {"skipped": f"no saved graph named {LINEAGE_GRAPH!r}"}
    old = lineage.get_graph(old["id"])
    g = lineage.graph()
    gone = {n["id"] for n in g["nodes"] if n.get("replaced") and n.get("buildable") is False}
    down, up = collections.defaultdict(set), collections.defaultdict(set)
    for e in g["edges"]:
        if e["from"] in gone or e["to"] in gone:
            continue
        down[e["from"]].add(e["to"])
        up[e["to"]].add(e["from"])

    def closure(start: list[str], adj: dict[str, set[str]]) -> set[str]:
        seen, todo = set(start), list(start)
        while todo:
            for m in adj[todo.pop()] - seen:
                seen.add(m)
                todo.append(m)
        return seen

    dropped = [n for n in old["nodes"] if n in gone]
    saved = [n for n in old["nodes"] if n not in gone]
    reach = closure(saved, down) | closure(saved, up)
    types = {n for n in reach if n.startswith("object_type:")}
    reach |= {e["from"] for e in g["edges"] if e["to"] in types and e["from"].startswith("action:")}
    new = sorted(reach - set(saved) - gone)
    if new or dropped:
        lineage.save_graph(lineage.SavedGraph(name=old["name"], nodes=saved + new, colors=old.get("colors") or {}, color_by=old.get("color_by") or "type",
                                              permissions=old.get("permissions") or {},
                                              positions={k: v for k, v in (old.get("positions") or {}).items() if k not in gone}), id=old["id"])
    return {"graph": old["id"], "nodes": len(saved) + len(new), "added": len(new), "dropped": len(dropped)}


def ownership() -> dict:
    """The agent of each object type, from the ontology's groups (what api/aip reads)."""
    import ontology_model as om

    groups = {g["id"]: g for g in om._groups()}
    agents: dict[str, dict] = {}
    for t in ontology._all("object-types"):
        for gid in t.get("groups") or []:
            g = groups.get(gid)
            if g and g["name"].startswith("Agen "):
                a = agents.setdefault(g["name"], {"group_id": gid, "description": g.get("description", ""), "object_types": []})
                a["object_types"].append({"id": t["id"], "name": t["display_name"], "api_name": t.get("api_name")})
    return agents
