"""Property descriptions of the JKN demo's Nexus types, written into the ontology itself (property `description`), so
every application — Nexus Manager, Object Explorer, the JKN Intelligence Nexus in Vertex — shows them as ontology
metadata. Called by the JKN demo builds and runnable on its own (apply()); a description already set by someone is
never overwritten.

Descriptions state what the column holds in this demo (fictitious data); they do not claim more than the data does.
"""

from __future__ import annotations

from typing import Any

# the same column means the same thing on every JKN type
COMMON: dict[str, str] = {
    "no_sep": "Nomor SEP (Surat Eligibilitas Peserta): kunci satu klaim JKN.",
    "kantor_cabang": "Kantor cabang BPJS Kesehatan yang membawahi faskes / verifikator ini.",
    "kode_faskes": "Kode faskes (kunci ke Faskes Audit JKN / RS Jejaring IoT JKN).",
    "nama_faskes": "Nama faskes untuk tampilan (kode ada di kolom kode faskes).",
    "faskes": "Kode faskes yang mengajukan / terkait dengan baris ini.",
    "kategori_risiko": "Kategori risiko: nomor dan nama salah satu dari 20 subkategori Efisiensi Risiko pada Fasilitas Kesehatan.",
    "id_kabkota": "ID kabupaten/kota (kunci ke Wilayah JKN tingkat kabupaten/kota).",
    "kabkota": "Nama kabupaten/kota.",
    "id_provinsi": "ID provinsi dalam hierarki Wilayah JKN.",
    "provinsi": "Nama provinsi.",
    "id_kedeputian": "ID kedeputian wilayah BPJS Kesehatan (pembagian contoh).",
    "kedeputian": "Nama kedeputian wilayah BPJS Kesehatan (pembagian contoh).",
    "tier": "Tingkat data IoT faskes: telemetri penuh, sebagian, atau tanpa meter.",
    "judul": "Judul tampilan objek (dirangkai dari kolom lain, untuk daftar dan pencarian).",
    "lokasi": "Koordinat (lintang, bujur) untuk peta.",
    "kepemilikan": "Kepemilikan faskes (pemerintah pusat/daerah, swasta, TNI/Polri …).",
    "id_dokter": "ID dokter (kunci ke Dokter Audit JKN).",
    "nama_dokter": "Nama dokter untuk tampilan.",
    "tanggal": "Tanggal pelayanan / kejadian.",
    "nilai_tak_didukung_rp": "Nilai rupiah tindakan yang diklaim tetapi tidak didukung pemakaian alat menurut meter IoT.",
    "kelengkapan_pct": "Persentase interval meter IoT yang ada datanya (kelengkapan telemetri).",
    "alat_bermeter": "Jumlah alat yang terpasang meter listrik IoT.",
    "hari_temuan": "Jumlah hari dengan temuan IoT tingkat tinggi dalam jendela pemantauan.",
    "jenis_alat": "Jenis alat medis penunjang (Rontgen, CT, USG, hemodialisis …).",
    "tarif_rs": "Tarif yang ditagihkan rumah sakit (Rp).",
    "kelas_rawat": "Kelas rawat (1, 2, 3).",
}

# per type: what a column means there (wins over COMMON)
BY_TYPE: dict[str, dict[str, str]] = {
    "Alat Medis IoT JKN (demo)": {
        "id_alat": "ID alat medis (kunci objek).", "nama_alat": "Nama alat seperti di register ASPAK faskes.",
        "merek_model": "Merek / model alat (contoh).", "id_meter": "ID meter listrik IoT yang mengukur alat ini.",
        "id_gateway": "Gateway IoT faskes yang meneruskan bacaan meter.",
        "seri_daya": "Referensi time series daya listrik alat (W, tiap 2 menit) dari gateway faskes.",
        "nama_sensor": "Nama sensor daya di sistem time series.", "satuan": "Satuan bacaan sensor (W).",
        "metode_estimasi": "Cara tindakan diestimasi dari daya: per siklus menyala, per waktu menyala, atau per menit-mesin (hemodialisis).",
        "daya_standby_w": "Daya beban dasar / siaga alat (W).", "daya_aktif_w": "Daya saat melakukan tindakan, per mesin (W).",
        "ambang_aktif_w": "Ambang daya (W) di atas mana alat dihitung sedang melakukan tindakan.",
        "jumlah_mesin": "Jumlah mesin di balik satu meter (mis. ruang hemodialisis).",
        "kapasitas_maks_harian": "Kapasitas maksimum tindakan per hari menurut spesifikasi alat.",
        "hari_data": "Hari dengan data meter dalam 14 hari terakhir.", "siklus_total": "Siklus menyala alat dalam 14 hari.",
        "estimasi_tindakan_total": "Tindakan yang mungkin dilakukan alat dalam 14 hari menurut pemakaian dayanya.",
        "kwh_total": "Energi yang dipakai alat dalam 14 hari (kWh).", "klaim_total": "Tindakan jenis ini yang diklaim faskes dalam 14 hari.",
        "tak_didukung_total": "Tindakan diklaim dalam 14 hari yang melebihi estimasi pemakaian alat.",
        "status_iot": "Ringkasan status IoT alat (normal, ada temuan, data kurang).",
        "status_operasi": "Status operasi terakhir dari daya: Mati, Siaga, atau Tindakan (dilacak proses Machinery).",
        "status_sejak": "Waktu status operasi terakhir dimulai.",
    },
    "Dokter Audit JKN (demo)": {
        "id_dokter": "ID dokter (kunci objek).", "nama": "Nama dokter (fiktif).", "spesialisasi": "Spesialisasi dokter.",
        "faskes_utama": "Kode faskes utama tempat dokter berpraktik (kunci ke Faskes Audit JKN).", "nama_faskes": "Nama faskes utama.",
        "praktik_lain": "Faskes lain tempat dokter juga berpraktik.", "jumlah_kasus": "Jumlah kasus rujukan / klaim berisiko yang melibatkan dokter.",
        "peran_dalam_kasus": "Peran dokter dalam kasus: perujuk, DPJP, atau keduanya.",
        "skor_anomali": "Skor anomali ensembel model (0–1): makin tinggi makin tidak biasa pola klaimnya — petunjuk klarifikasi, bukan vonis.",
        "suara_model": "Jumlah detektor ensembel yang menandai dokter ini sebagai anomali.",
        "peringkat_anomali": "Peringkat dokter menurut skor anomali (1 = paling tidak biasa).",
        "status_anomali": "Kesimpulan status anomali beserta konteks kasus audit.",
        "alasan_anomali": "Fitur yang paling mendorong skor anomali (penjelasan model).",
        "skor_gan": "Skor anomali dari detektor GAN.", "skor_isolation_forest": "Skor anomali dari Isolation Forest.",
        "skor_autoencoder": "Skor anomali dari autoencoder (galat rekonstruksi).",
    },
    "Faskes Audit JKN (demo)": {
        "kode": "Kode faskes (kunci objek).", "nama": "Nama faskes (fiktif).", "lokasi": "Koordinat faskes untuk peta audit.",
        "jenis": "Jenis faskes (puskesmas, klinik, dokter praktik, rumah sakit …).", "tingkat": "Tingkat layanan: FKTP (pertama) atau FKRTL (rujukan).",
        "wilayah": "Kabupaten/kota tempat faskes berada.", "status_audit": "Status audit: Sehat, Perlu Pemantauan, Ada Indikasi Fraud, Dalam Investigasi, Selesai Diaudit.",
        "skor_risiko": "Skor risiko faskes 0–100 dari temuan, kasus dan model.", "prioritas": "Prioritas audit (P1 tertinggi; - bila tidak diprioritaskan).",
        "indikasi_utama": "Indikasi kecurangan utama yang ditemukan.", "klaim_3_bulan": "Jumlah klaim faskes dalam 3 bulan terakhir.",
        "klaim_berisiko": "Klaim yang terindikasi salah satu kategori risiko.", "nilai_klaim_rp": "Nilai klaim faskes dalam 3 bulan (Rp).",
        "potensi_kerugian_rp": "Perkiraan kerugian program bila indikasi terbukti (Rp).", "pengembalian_rp": "Dana yang dikembalikan setelah audit (Rp).",
        "tim_audit": "Tim audit yang ditugaskan.", "tanggal_audit": "Tanggal audit (rencana, mulai, atau selesai sesuai status).",
        "dokter_terkait": "Dokter yang terkait dengan kasus faskes.", "jumlah_kasus": "Jumlah kasus rujukan / klaim berisiko faskes.",
        "skor_anomali_maks": "Skor anomali tertinggi di antara dokter faskes.", "dokter_anomali": "Jumlah dokter faskes yang ditandai anomali.",
        "dokter_pola_baru": "Jumlah dokter dengan pola klaim baru yang muncul.",
        "iot_alat_terpasang": "Alat penunjang terdaftar (ASPAK) di faskes.", "iot_alat_bermeter": "Alat faskes yang bermeter IoT.",
        "iot_hari_temuan": "Hari dengan temuan IoT tinggi (14 hari).", "iot_tindakan_tak_didukung": "Tindakan diklaim yang tidak didukung pemakaian alat (14 hari).",
        "iot_nilai_tak_didukung_rp": "Nilai tindakan tak didukung pemakaian alat (Rp, 14 hari).", "iot_status": "Status pemantauan IoT faskes.",
        "iot_alat_bermasalah": "Jenis alat dengan temuan IoT.",
    },
    "Faskes JKN (demo)": {
        "kode": "Kode faskes (kunci objek).", "nama": "Nama faskes (fiktif).", "jenis": "Jenis faskes: FKTP (pertama) atau FKRTL (rujukan).",
    },
    "Faskes JKN – deret waktu (demo)": {
        "kode": "Kode faskes (kunci ke Faskes JKN).", "nama": "Nama faskes.", "jenis": "Jenis faskes: FKTP atau FKRTL.",
        "klaim_harian": "Time series jumlah klaim harian faskes (ilustratif).", "selisih_harian": "Time series selisih tarif RS dan INA-CBG harian (ilustratif).",
    },
    "Jadwal Audit Klaim (demo)": {
        "id_audit": "ID jadwal audit (kunci objek).", "jenis_faskes": "Jenis faskes yang diaudit (untuk mencocokkan keahlian verifikator).",
        "id_verifikator": "Verifikator yang dialokasikan (kunci ke Verifikator JKN).", "mulai": "Waktu mulai audit.", "selesai": "Waktu selesai audit.",
        "durasi_tetap": "Durasi audit tidak boleh diubah oleh penjadwalan ulang.", "faskes": "Kode faskes klaim yang diaudit.",
    },
    "Kantor Cabang JKN (demo)": {"nama": "Nama kantor cabang (kunci objek).", "wilayah": "Wilayah layanan kantor cabang."},
    "Kasus Rujukan Berisiko JKN (demo)": {
        "id_kasus": "ID kasus (kunci objek).", "jenis_kasus": "Jenis kasus menurut 20 subkategori risiko (mis. self-referral, upcoding).",
        "alur": "Alur rujukan: faskes asal → faskes tujuan.", "faskes_asal": "Kode faskes perujuk.", "nama_faskes_asal": "Nama faskes perujuk.",
        "faskes_tujuan": "Kode faskes penerima rujukan.", "nama_faskes_tujuan": "Nama faskes penerima rujukan.",
        "dokter_perujuk": "ID dokter perujuk.", "nama_dokter_perujuk": "Nama dokter perujuk.", "dokter_dpjp": "ID DPJP di faskes tujuan.",
        "nama_dokter_dpjp": "Nama DPJP (dokter penanggung jawab pelayanan).", "diagnosa": "Diagnosis (ICD-10) kasus.",
        "jumlah_klaim": "Jumlah klaim dalam kasus.", "nilai_klaim_rp": "Nilai klaim kasus (Rp).", "periode": "Periode klaim kasus.",
        "status_kasus": "Status penanganan kasus.", "temuan": "Uraian temuan / pola yang mencurigakan.", "noRujukan": "Nomor surat rujukan.",
    },
    "Kategori Risiko JKN (demo)": {
        "kode": "Nomor dan nama subkategori (kunci objek).", "no": "Nomor urut subkategori (1–20).", "nama": "Nama subkategori Efisiensi Risiko pada Fasilitas Kesehatan.",
    },
    "Klaim JKN (demo)": {
        "nama_peserta": "Nama peserta JKN (fiktif; data pribadi dilindungi kebijakan properti).", "no_kartu": "Nomor kartu JKN peserta.",
        "jenis": "Jenis rawat: RI (rawat inap) atau RJ (rawat jalan).", "tgl_masuk": "Tanggal masuk / pelayanan.", "tgl_pulang": "Tanggal pulang (rawat inap).",
        "lama_rawat": "Lama rawat dalam hari.", "diag_utama": "Diagnosis utama (ICD-10).", "prosedur": "Prosedur (ICD-9-CM), dipisah koma.",
        "kode_inacbg": "Kode INA-CBG lengkap dengan tingkat keparahan (I/II/III, 0 untuk rawat jalan).", "tarif_inacbg": "Tarif INA-CBG yang dibayar (Rp).",
        "status_verifikasi": "Status verifikasi klaim (diajukan, layak bayar, pending, tidak layak …).", "akses_terbatas": "Penanda klaim berakses terbatas (mis. dalam investigasi).",
        "catatan_verifikasi": "Catatan verifikator.", "resume": "Resume medis (teks; juga di-embed untuk pencarian semantik).",
        "kode_dasar_inacbg": "Kode dasar INA-CBG tanpa tingkat keparahan (kunci ke Tarif INA-CBG).", "faskes": "Kode faskes yang mengajukan klaim.",
    },
    "Peringatan Risiko JKN (demo)": {
        "id_peringatan": "ID peringatan (kunci objek).", "tingkat": "Tingkat peringatan: info, warning, atau danger (klaim fiktif / jiplakan).",
        "waktu": "Waktu peringatan dibuat.", "judul": "Judul peringatan (nama kategori risiko).",
    },
    "RS Jejaring IoT JKN (demo)": {
        "kode": "Kode RS (kunci objek).", "nama": "Nama RS / faskes mitra.", "kelas": "Kelas RS / jenis faskes.",
        "kode_faskes_audit": "Kode faskes yang sama di Faskes Audit JKN (bila diaudit).", "terhubung_sejak": "Tanggal faskes mulai terhubung ke pemantauan IoT.",
        "alat_terpasang": "Alat penunjang terdaftar di ASPAK.", "klaim_tindakan_14h": "Tindakan penunjang yang diklaim (14 hari).",
        "klaim_terpantau_14h": "Tindakan diklaim yang alatnya bermeter (bisa dicocokkan, 14 hari).",
        "estimasi_alat_14h": "Tindakan yang mungkin menurut pemakaian alat (14 hari).", "tak_didukung_14h": "Tindakan diklaim yang melebihi estimasi alat (14 hari).",
        "nilai_klaim_rp": "Nilai klaim tindakan penunjang (Rp, 14 hari).", "rasio_tak_didukung_pct": "Persentase tindakan terpantau yang tidak didukung alat.",
        "rasio_jenis_maks_pct": "Rasio tak didukung pada jenis alat terburuk (%).", "hari_verifikasi": "Hari dengan temuan yang perlu verifikasi.",
        "hari_data_kurang": "Hari dengan data meter kurang lengkap.", "alat_bermasalah": "Jenis alat dengan temuan.",
        "skor_risiko_iot": "Skor risiko IoT 0–100 dari rasio tak didukung, hari temuan dan kelengkapan data.",
        "status_pemantauan": "Status pemantauan RS: Normal, Perhatian, Prioritas audit, Data kurang (dilacak proses Machinery).",
    },
    "Tarif INA-CBG (demo)": {
        "kode_dasar": "Kode dasar kelompok INA-CBG (kunci objek).", "deskripsi": "Nama kelompok kasus.", "tarif_i": "Tarif kelas rawat I (Rp).",
        "tarif_ii": "Tarif kelas rawat II (Rp).", "tarif_iii": "Tarif kelas rawat III (Rp).", "bobot_kasus": "Bobot kasus kelompok (sumber data kedua, multi-datasource).",
        "rata_rata_los": "Rata-rata lama rawat kelompok dalam hari (0 untuk rawat jalan).",
    },
    "Temuan Aturan JKN (demo)": {
        "id_temuan": "ID temuan (kunci objek).", "rule_id": "ID aturan (Foundry Rules) yang menghasilkan temuan.", "rule_name": "Nama aturan.",
        "tingkat": "Tingkat temuan: info, warning, danger.", "nilai": "Nilai klaim yang terkena aturan (Rp).", "alasan": "Alasan aturan terpicu.",
    },
    "Temuan IoT JKN (demo)": {
        "id_temuan": "ID temuan: faskes × jenis alat × tanggal (kunci objek).", "jenis_temuan": "Jenis ketidakcocokan: melebihi pemakaian alat, alat mati, klaim tanpa alat terdaftar …",
        "tingkat": "Tingkat temuan: Rendah, Sedang, Tinggi.", "klaim_tindakan": "Tindakan jenis ini yang diklaim hari itu.",
        "estimasi_tindakan_alat": "Tindakan yang mungkin menurut pemakaian alat hari itu.", "batas_toleransi": "Batas toleransi klaim: estimasi × 1,1 + 1.",
        "siklus": "Siklus menyala alat hari itu.", "menit_menyala": "Menit alat menyala di atas ambang.", "mesin_menit": "Menit-mesin (hemodialisis).",
        "energi_aktif_kwh": "Energi saat aktif hari itu (kWh).", "kelengkapan": "Kelengkapan data meter hari itu (0–1).",
        "tanpa_meter": "Alat sejenis di faskes yang tidak bermeter (mengurangi kepastian).", "alat_terkait": "Alat sejenis di faskes.",
        "id_alat_utama": "Alat utama temuan (kunci ke Alat Medis IoT JKN).", "kapasitas_maks": "Kapasitas maksimum alat (tindakan/hari).",
        "tindakan_tak_didukung": "Tindakan diklaim melebihi batas toleransi.", "nilai_klaim_rp": "Nilai klaim jenis ini hari itu (Rp).",
        "dokter_terbanyak": "Dokter yang paling banyak mengajukan tindakan hari itu.", "status_temuan": "Status verifikasi temuan (Baru, Diverifikasi, Dikoreksi …).",
        "penjelasan": "Penjelasan temuan dalam bahasa biasa.", "label_singkat": "Label pendek untuk grafik / peta.",
        "lokasi": "Koordinat faskes untuk peta.",
    },
    "Temuan Risiko JKN (demo)": {
        "id": "ID temuan (kunci objek).", "kategori": "Kategori risiko (salah satu dari 20 subkategori).", "nilai_risiko": "Nilai rupiah yang berisiko (Rp).",
        "referensi": "Referensi dokumen / transaksi sumber temuan.", "alasan": "Alasan temuan.",
    },
    "Tindakan Penunjang Diklaim JKN (demo)": {
        "id_baris": "ID baris: SEP + kode tindakan (kunci objek).", "kode_icd9": "Kode tindakan ICD-9-CM.", "nama_tindakan": "Nama tindakan.",
        "jenis_rawat": "Jenis rawat klaim.", "id_rekon": "Kunci rekonsiliasi faskes × jenis alat × tanggal (kunci ke Temuan IoT JKN).",
        "id_dokter": "Dokter pengaju tindakan (kunci ke Dokter Audit JKN).",
    },
    "Verifikator JKN (demo)": {
        "id_verifikator": "ID verifikator (kunci objek).", "nama": "Nama verifikator (fiktif).", "keahlian": "Jenis faskes yang menjadi keahlian verifikator.",
    },
    "Wilayah JKN (demo)": {
        "id_wilayah": "ID wilayah (kunci objek).", "nama": "Nama wilayah.", "tingkat": "Tingkat wilayah: Nasional, Kedeputian, Provinsi, Kabupaten/Kota.",
        "urutan_tingkat": "Urutan tingkat (0 nasional … 3 kabupaten/kota).", "induk": "Wilayah induk satu tingkat di atasnya (kunci ke Wilayah JKN).",
        "lokasi": "Titik tengah wilayah untuk peta.", "rs_total": "RS mitra JKN di wilayah.", "rs_terhubung": "RS yang terhubung pemantauan IoT.",
        "cakupan_pct": "Persentase RS mitra yang terhubung IoT.", "klaim_14h": "Tindakan penunjang diklaim di wilayah (14 hari).",
        "klaim_terpantau_14h": "Tindakan diklaim yang alatnya bermeter (14 hari).", "tak_didukung_14h": "Tindakan tak didukung pemakaian alat (14 hari).",
        "rasio_tak_didukung_pct": "Persentase tindakan terpantau yang tidak didukung alat.", "rs_prioritas": "RS berstatus prioritas audit.",
        "rs_perhatian": "RS berstatus perhatian.", "rs_data_kurang": "RS dengan data meter kurang.", "status_wilayah": "Ringkasan status wilayah.",
    },
}


def describe(type_name: str, api_name: str) -> str | None:
    return BY_TYPE.get(type_name, {}).get(api_name) or COMMON.get(api_name)


def apply() -> dict[str, Any]:
    """Set the missing property descriptions on every JKN type that has some (existing descriptions are kept)."""
    import ontology

    out: dict[str, Any] = {}
    for t in ontology._all("object-types"):
        name = t["display_name"]
        if name not in BY_TYPE:
            continue
        with ontology._lock:
            rec = ontology._object_type(t["id"])
            props, n = [], 0
            for p in rec["properties"]:
                if not p.get("description"):
                    d = describe(name, p["api_name"])
                    if d:
                        p = {**p, "description": d}
                        n += 1
                props.append(p)
            if n:
                ontology.update_object_type(t["id"], ontology.ObjectTypeIn(properties=[ontology.Property(**p) for p in props]))
        if n:
            out[name] = n
    return out
