"""The 20 fraud modes of Permenkes 16/2019 (the list the BPJS team works from) as the realtime engine detects them,
Quantexa-style: each mode is read from the entities (member, facility, family, referral source), the network around
them and the history of each, never from one claim alone.

Every signal belongs to one or more modes (SIGNALS), carries the indikasi tag it writes into the ledger, its default
weight (feedback from case decisions can change it: mesin.weights) and the documents an investigator asks for.
Each mode says how it is detected here:
  data       read from the stream's own data (claims, FKTP visits, non-capitation claims, the member registry)
  proksi     a proxy: what the data shows of a mode it cannot see directly (capitation spending is not in any data)
  kontrak    the rule runs, but the data it needs comes only with a hospital's submission (dispensing lines, lab or
             device results): the sample holds none, so the simulator plants them in its scenarios, labelled as such
Modes 7 and 19 are the same mode in the regulation's list (inflated bills); they share the detectors.
"""

from __future__ import annotations

from typing import Any

# ICD-10 categories handled at FKTP (Standar Kompetensi Dokter Indonesia level 4A), the basis of BPJS's ratio of
# non-specialist referrals (RRNS, Kapitasi Berbasis Kinerja). A working subset to be checked against the official
# list of 144 diagnoses before any use beyond this demonstration.
NON_SPESIALISTIK = {
    "A01", "A06", "A09", "A15", "A16", "A90", "B01", "B02", "B05", "B26", "B35", "B36", "B37", "B85", "B86", "D50", "E11", "E66", "E78",
    "F51", "G43", "G44", "H00", "H01", "H10", "H60", "H65", "H66", "I10", "J00", "J01", "J02", "J03", "J04", "J06", "J11", "J20", "J45",
    "K21", "K29", "K30", "K59", "L01", "L02", "L03", "L08", "L20", "L23", "L30", "L50", "L70", "M54", "M79", "N30", "N39", "N76", "R05",
    "R10", "R50", "R51", "S00", "T14",
}
CONTACT_ONLY_POLI = {"KUNJUNGAN ONLINE", "HOME-VISIT"}

MODES: dict[str, dict[str, Any]] = {
    "M01": {"nama": "Penyalahgunaan dana kapitasi/nonkapitasi", "deteksi": "proksi", "tingkat": "FKTP pemerintah",
            "cara": "Penggunaan dana kapitasi tidak ada di data mana pun; proksinya indikator Kapitasi Berbasis Kinerja yang bisa dimainkan: "
                    "kontak semu (lonjakan kunjungan online/home-visit), angka kontak jauh di bawah riwayat unit sementara kapitasi tetap "
                    "dibayar, dan rasio rujukan non-spesialistik yang naik (beban dipindah ke FKTRL).",
            "dokumen": "laporan penggunaan dana kapitasi (SP2D/BKU), daftar hadir tenaga kesehatan, bukti kontak (log P-Care, nomor HP terverifikasi)"},
    "M02": {"nama": "Manipulasi klaim nonkapitasi", "deteksi": "data", "tingkat": "FKTP",
            "cara": "Klaim nonkapitasi realtime: tindakan ganda, frekuensi pemeriksaan Prolanis/PRB di atas ketentuan, tindakan yang tidak cocok "
                    "dengan peserta (KB/ANC/persalinan pada laki-laki atau di luar usia subur), tarif di atas norma tindakannya, tanggal "
                    "tindakan di luar kunjungan, lonjakan volume faskes.",
            "dokumen": "register tindakan (KIA/KB/persalinan, lab Prolanis), buku KIA, hasil lab, SEP/bukti kunjungan"},
    "M03": {"nama": "Rujukan tidak sesuai", "deteksi": "data", "tingkat": "FKTP",
            "cara": "Rujukan diagnosis yang tuntas di FKTP (kompetensi 4A), rujukan melompati jenjang ke RS kelas A, dan lonjakan rasio rujukan "
                    "non-spesialistik FKTP swasta dibanding riwayatnya.",
            "dokumen": "rekam medis kunjungan FKTP, alasan rujukan (keterbatasan sarana/komplikasi), surat rujukan"},
    "M04": {"nama": "Manipulasi diagnosis dan/atau tindakan (upcoding)", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Lonjakan keparahan III faskes (binomial vs riwayatnya), diagnosis sekunder jauh di atas p99 kodenya, skor model; dengan rekam "
                    "medis SATUSEHAT: diagnosis yang ditagih tidak tercatat, atau dibantah hasil ukurnya (gagal napas dengan saturasi normal, "
                    "infark dengan troponin normal), dan rawat inap yang di rekam medis hanya rawat jalan; ventilasi ≥ 96 jam berturut-turut (96.72) yang di rekam medis tercatat kurang dari 96 jam, atau yang ventilatornya menurut sensor clamp pada kabel daya tidak pernah jalan 96 jam tanpa putus.",
            "dokumen": "resume medis, hasil penunjang yang mendasari diagnosis sekunder, lembar coding"},
    "M05": {"nama": "Cloning (penjiplakan klaim)", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Klaim rawat inap identik lintas peserta (faskes, tanggal, kode, diagnosis, lama rawat, prosedur, tagihan bukan tarif paket).",
            "dokumen": "rekam medis tiap peserta (catatan harian, tanda tangan DPJP), bukti kehadiran"},
    "M06": {"nama": "Phantom billing (klaim palsu)", "deteksi": "data", "tingkat": "FKRTL / FKTP",
            "cara": "Entity resolution peserta: rawat inap tumpang tindih di dua faskes, satu kartu di banyak faskes, klaim setelah peserta "
                    "meninggal (registri atau kematian yang tercatat di aliran), klaim yang tidak cocok dengan jenis kelamin/usia pemilik kartu "
                    "padahal ada anggota keluarga yang cocok (kartu keluarga dipakai); rekam medis SATUSEHAT tanpa kunjungan pada tanggal klaim, atau "
                    "pasiennya berjenis kelamin/tanggal lahir lain dari pemegang kartu.",
            "dokumen": "SEP dengan verifikasi sidik jari/face recognition, identitas pasien, rekam medis, bukti kehadiran"},
    "M07": {"nama": "Inflated bills (penggelembungan tagihan)", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Tagihan di atas tarif INA-CBG + top-up; top-up special CMG (obat/prostesis/investigasi/prosedur) jauh di atas p95 kode dan "
                    "jenis top-up itu. Rincian harga obat/alkes tidak ada di data.",
            "dokumen": "rincian tagihan, faktur pembelian obat/alkes, e-katalog"},
    "M08": {"nama": "Pemecahan episode (sesuai indikasi, tidak sesuai ketentuan)", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Rawat jalan dan rawat inap di faskes yang sama pada hari yang sama ditagih terpisah; dua rawat jalan di hari yang sama.",
            "dokumen": "rekam medis rawat jalan dan rawat inap hari itu, jam pelayanan, rujukan internal"},
    "M09": {"nama": "Services unbundling / fragmentation", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Masuk lagi 0–3 hari setelah pulang dengan diagnosis sama di faskes yang sama (satu episode ditagih dua kali).",
            "dokumen": "resume pulang episode pertama, rencana kontrol, rekam medis episode kedua"},
    "M10": {"nama": "Self-referral (rujukan semu)", "deteksi": "data", "tingkat": "FKTP / FKRTL",
            "cara": "Graf rujukan: rujukan FKTP yang memusat ke satu tujuan jauh di atas sebaran riwayatnya; pasangan RS yang berbagi peserta di "
                    "atas ekspektasi Poisson riwayatnya (cincin); rekam medis SATUSEHAT: rujukan dari RS lain tanpa alasan dan tanpa temuan akut, pasien yang berpindah RS mengikuti satu dokter.",
            "dokumen": "kerja sama/kepemilikan FKTP–RS, pola rujukan, ketersediaan layanan di RS terdekat"},
    "M11": {"nama": "Repeat billing (klaim berulang)", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Klaim sama dengan id lain (peserta, faskes, tanggal, kode), dan versi mirip: rawat inap peserta, faskes dan diagnosis sama "
                    "dengan tanggal masuk bergeser satu hari.",
            "dokumen": "bukti pembayaran klaim sebelumnya, SEP kedua klaim"},
    "M12": {"nama": "Prolonged length of stay", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Lama rawat > 2× p90 kodenya; rata-rata indeks lama rawat faskes bergeser jauh di atas riwayatnya; bukti perangkat IoMT "
                    "(bila dikirim faskes) menurunkan bobotnya; lama rawat klaim lebih panjang dari Encounter rekam medis SATUSEHAT; hari ICU di atas periode lokasi ICU rekam medis atau hari bed/monitor ICU menyala (sensor arus).",
            "dokumen": "catatan harian rawat inap, kriteria pulang, observasi tanda vital"},
    "M13": {"nama": "Manipulasi kelas perawatan (room charge)", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Kelas rawat yang ditagih di atas hak kelas peserta di registri; untuk PBI (tidak boleh naik kelas) kuat, untuk peserta lain "
                    "dimitigasi (naik kelas atas permintaan sendiri dengan membayar selisih).",
            "dokumen": "surat pernyataan naik kelas, bukti pembayaran selisih, ketersediaan kamar"},
    "M14": {"nama": "Menagihkan tindakan yang tidak dilakukan", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Kode INA-CBG kelompok prosedur (digit kedua 1–3) tanpa satu pun tindakan tercatat di klaim; tindakan bermakna yang ditagih "
                    "(mis. kateterisasi jantung, PCI, ventilator, transfusi) tetapi tidak ada Procedure-nya di rekam medis SATUSEHAT; pemakaian alat yang ditagih tanpa jejak sensor arus, ventilator yang hanya siaga (tidak pernah jalan), sesi hemodialisis < 3 jam ditagih penuh.",
            "dokumen": "laporan operasi/tindakan, jadwal kamar operasi, BHP yang dipakai"},
    "M15": {"nama": "Tindakan pengobatan tidak sesuai indikasi medis", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Diagnosis/kode yang tidak mungkin untuk jenis kelamin atau usia peserta; pasangan diagnosis–kode INA-CBG yang hampir tak "
                    "pernah muncul di riwayat (≤ 3 dari ≥ 1.000 klaim diagnosis itu); tindakan tanpa indikasi di rekam medis SATUSEHAT (tidak ada "
                    "diagnosis indikasinya, hasil ukur normal).",
            "dokumen": "rekam medis, indikasi tindakan, PNPK/PPK yang berlaku"},
    "M16": {"nama": "Readmisi (admisi berulang)", "deteksi": "data", "tingkat": "FKRTL",
            "cara": "Rawat inap ulang 4–30 hari di faskes yang sama dengan diagnosis sama; readmisi ≤ 30 hari dengan diagnosis lain lebih lemah; rekam medis SATUSEHAT: rawat ulang terencana tanpa kebutuhan klinis, masuk lagi ≤ 7 hari setelah dipulangkan dengan tanda vital belum stabil.",
            "dokumen": "resume pulang, rencana tindak lanjut, alasan admisi ulang"},
    "M17": {"nama": "Klaim fiktif obat/alkes/tindakan", "deteksi": "data", "tingkat": "FKRTL / apotek",
            "cara": "Top-up special CMG yang hampir tak pernah ada untuk kode itu (≤ 2 dari ≥ 200 klaim kode); baris obat kiriman faskes yang "
                    "ditagih tetapi tidak diserahkan (kontrak); obat khusus/implan yang ditagih tanpa catatan obat atau alat di rekam medis SATUSEHAT.",
            "dokumen": "resep, bukti penyerahan obat/alkes, nomor seri implan/prostesis, faktur"},
    "M18": {"nama": "Pengurangan jumlah obat", "deteksi": "kontrak", "tingkat": "apotek / FKRTL",
            "cara": "Baris obat kiriman faskes: jumlah ditagih sesuai resep tetapi jumlah diserahkan lebih sedikit. Data sampel tidak memuat "
                    "penyerahan obat: aturannya berjalan atas kiriman faskes dan skenario simulator.",
            "dokumen": "resep, bukti serah terima obat yang ditandatangani pasien, stok apotek"},
    "M20": {"nama": "Manipulasi hasil pemeriksaan", "deteksi": "kontrak", "tingkat": "FKRTL / laboratorium",
            "cara": "Hasil pemeriksaan yang dilaporkan di klaim dibandingkan dengan nilai dari alat (LIS/IoMT) yang dikirim faskes; selisih di "
                    "luar toleransi menandai. Data sampel tidak memuat hasil lab. Bukti alat IoT yang berubah setelah dijangkarkan (akar Merkle tidak cocok), dijangkarkan setelah klaim diajukan, atau ditandatangani kunci alat yang dicabut.",
            "dokumen": "hasil asli alat/LIS, log alat, sampel, verifikasi analis"},
}

# signal -> (modes, ledger tag or None, default weight, label)
SIGNALS: dict[str, tuple[list[str], Any, float, str]] = {
    # FKRTL claims: the network (graf.py)
    "RAWAT_INAP_TUMPANG_TINDIH": (["M06"], "KLAIM_FIKTIF", 1.6, "Rawat inap tumpang tindih di faskes lain"),
    "KARTU_BANYAK_FASKES": (["M06"], "KLAIM_FIKTIF", 1.0, "Satu kartu di banyak faskes"),
    "KLAIM_GANDA_STREAM": (["M11"], "KLAIM_GANDA", 1.6, "Klaim ganda (id berbeda)"),
    "KLAIM_GANDA_RIWAYAT": (["M11"], "KLAIM_GANDA", 1.6, "Klaim ganda (riwayat)"),
    "KLAIM_BERULANG_MIRIP": (["M11"], "KLAIM_GANDA", 1.2, "Klaim berulang (versi mirip)"),
    "PEMECAHAN_EPISODE": (["M09"], "PEMECAHAN_EPISODE", 0.9, "Unbundling: masuk lagi 0–3 hari"),
    "EPISODE_HARI_SAMA": (["M08"], "PEMECAHAN_EPISODE", 0.9, "Episode dipecah di hari yang sama"),
    "READMISI_DX_SAMA": (["M16"], "READMISI", 0.6, "Readmisi 4–30 hari, diagnosis sama"),
    "CINCIN_FASKES": (["M10"], "JARINGAN_FASKES", 1.0, "Jaringan faskes tidak wajar"),
    "KLONING_LINTAS_PESERTA": (["M05"], "KLONING_KLAIM", 1.0, "Kloning lintas peserta"),
    "LONJAKAN_KEPARAHAN": (["M04"], "UPCODING_KEPARAHAN", 0.8, "Lonjakan keparahan III"),
    "LOS_FASKES_BERGESER": (["M12"], "LOS_DIPERPANJANG", 0.8, "Lama rawat faskes bergeser naik"),
    "RISIKO_ASOSIASI": ([], None, 0.25, "Faskes di Box Karantina"),
    # FKRTL claims: the member registry and the references (aturan_rt.py)
    "KLAIM_SETELAH_MENINGGAL": (["M06"], "KLAIM_FIKTIF", 0.9, "Klaim setelah peserta meninggal (registri)"),
    "MENINGGAL_TERCATAT": (["M06"], "KLAIM_FIKTIF", 1.6, "Klaim setelah kematian yang tercatat di aliran"),
    "TIDAK_SESUAI_PESERTA": (["M15"], "TIDAK_SESUAI_INDIKASI", 0.65, "Diagnosis/kode tidak mungkin untuk jenis kelamin/usia"),
    "KARTU_KELUARGA": (["M06"], "KLAIM_FIKTIF", 0.8, "Kartu anggota keluarga dipakai"),
    "PASANGAN_KODE_LANGKA": (["M15"], "TIDAK_SESUAI_INDIKASI", 0.6, "Pasangan diagnosis–kode hampir tak pernah ada"),
    "KODE_PROSEDUR_TANPA_TINDAKAN": (["M14"], "TINDAKAN_TIDAK_DILAKUKAN", 1.0, "Kode prosedur tanpa tindakan tercatat"),
    "DX_SEKUNDER_BERLEBIH": (["M04"], "UPCODING_KEPARAHAN", 0.65, "Diagnosis sekunder jauh di atas kodenya"),
    "KELAS_DI_ATAS_HAK": (["M13"], "KELAS_RAWAT", 1.0, "Kelas rawat di atas hak peserta"),
    "TOPUP_TIDAK_LAZIM": (["M17"], "OBAT_ALKES_FIKTIF", 1.0, "Top-up special CMG tidak lazim untuk kode"),
    "TOPUP_DI_ATAS_PEER": (["M07"], "TAGIHAN_MELEBIHI_TARIF", 0.8, "Top-up special CMG di atas p95 kode"),
    "OBAT_DIKURANGI": (["M18"], "PENGURANGAN_OBAT", 1.2, "Obat diserahkan kurang dari yang ditagih"),
    "OBAT_TIDAK_DISERAHKAN": (["M17"], "OBAT_ALKES_FIKTIF", 1.4, "Obat ditagih tanpa penyerahan"),
    "HASIL_PEMERIKSAAN_TIDAK_COCOK": (["M20"], "MANIPULASI_PEMERIKSAAN", 1.3, "Hasil pemeriksaan klaim ≠ hasil alat"),
    # the model and the semantic layer's claim rules (aip/layanan.py)
    "SKOR_ML": ([], "RISIKO_ML_TINGGI", 1.4, "Skor model ML"),
    # the self-supervised model (ssl.py): a claim the network trained on millions of unlabelled claims cannot explain
    "ANOMALI_SSL": ([], None, 0.4, "Anomali self-supervised (pola tak dikenal)"),
    "TAGIHAN_MELEBIHI_TARIF": (["M07"], "TAGIHAN_MELEBIHI_TARIF", 0.6, "Tagihan di atas tarif INA-CBG"),
    "LOS_DIPERPANJANG": (["M12"], "LOS_DIPERPANJANG", 0.5, "Lama rawat > 2× p90 kodenya"),
    "READMISI": (["M16"], "READMISI", 0.2, "Readmisi ≤ 30 hari di faskes yang sama"),
    # FKTP visits (fktp.py)
    "RUJUKAN_NON_SPESIALISTIK": (["M03"], "RUJUKAN_TIDAK_SESUAI", 0.3, "Rujukan diagnosis kompetensi FKTP"),
    "RUJUKAN_LONCAT_JENJANG": (["M03"], "RUJUKAN_TIDAK_SESUAI", 0.4, "Rujukan melompat ke RS kelas A"),
    "RRNS_FKTP_NAIK": (["M03"], "RUJUKAN_TIDAK_SESUAI", 0.9, "Rasio rujukan non-spesialistik FKTP naik"),
    "RRNS_PUSKESMAS_NAIK": (["M01"], "KAPITASI_TIDAK_WAJAR", 0.9, "Rujukan non-spesialistik FKTP pemerintah naik (beban kapitasi dipindah)"),
    "KONSENTRASI_RUJUKAN": (["M10"], "RUJUKAN_SEMU", 1.0, "Rujukan memusat ke satu tujuan"),
    "KONTAK_SEMU": (["M01"], "KAPITASI_TIDAK_WAJAR", 0.9, "Lonjakan kontak online/home-visit"),
    "KONTAK_RENDAH": (["M01"], "KAPITASI_TIDAK_WAJAR", 1.0, "Angka kontak jauh di bawah riwayat unit"),
    "KUNJUNGAN_SETELAH_MENINGGAL": (["M06"], "KLAIM_FIKTIF", 0.9, "Kunjungan setelah peserta meninggal"),
    # non-capitation claims (fktp.py)
    "NONKAP_GANDA": (["M02"], "NONKAPITASI_TIDAK_WAJAR", 1.4, "Tindakan nonkapitasi ganda"),
    "NONKAP_FREKUENSI": (["M02"], "NONKAPITASI_TIDAK_WAJAR", 0.8, "Pemeriksaan berulang di atas ketentuan"),
    "NONKAP_TIDAK_SESUAI_PESERTA": (["M02", "M15"], "NONKAPITASI_TIDAK_WAJAR", 0.9, "Tindakan tidak cocok dengan peserta"),
    "NONKAP_TARIF": (["M02"], "NONKAPITASI_TIDAK_WAJAR", 0.9, "Tarif tindakan di atas normanya"),
    "NONKAP_TANGGAL": (["M02"], "NONKAPITASI_TIDAK_WAJAR", 0.7, "Tanggal tindakan di luar kunjungan"),
    "NONKAP_LONJAKAN": (["M02"], "NONKAPITASI_TIDAK_WAJAR", 0.7, "Lonjakan volume nonkapitasi faskes"),
    # FKRTL claims against the hospital's electronic medical record (rme.py: SATUSEHAT FHIR R4 sent with the claim). Not model
    # features (aktif.CODES is frozen): they enter the rule score, the explanation and the case
    "RME_KUNJUNGAN_TIDAK_ADA": (["M06"], "KLAIM_FIKTIF", 1.6, "Tidak ada kunjungan di rekam medis pada tanggal klaim"),
    "RME_JENIS_RAWAT_BERBEDA": (["M04", "M06"], "KLAIM_FIKTIF", 1.2, "Ditagih rawat inap, rekam medis rawat jalan/IGD"),
    "RME_LOS_TIDAK_SESUAI": (["M12"], "LOS_DIPERPANJANG", 1.0, "Lama rawat klaim lebih panjang dari rekam medis"),
    "RME_PASIEN_BERBEDA": (["M06"], "KLAIM_FIKTIF", 1.2, "Pasien di rekam medis bukan pemegang kartu"),
    "RME_TINDAKAN_TIDAK_TERCATAT": (["M14"], "TINDAKAN_TIDAK_DILAKUKAN", 1.4, "Tindakan yang ditagih tidak ada di rekam medis"),
    "RME_KLINIS_TIDAK_MENDUKUNG": (["M15"], "TIDAK_SESUAI_INDIKASI", 1.0, "Tindakan tanpa indikasi medis di rekam medis"),
    "RME_DIAGNOSIS_TIDAK_TERCATAT": (["M04"], "UPCODING_KEPARAHAN", 0.8, "Diagnosis yang ditagih tidak ada di rekam medis"),
    "RME_DIAGNOSIS_TIDAK_DIDUKUNG": (["M04"], "UPCODING_KEPARAHAN", 1.0, "Diagnosis dibantah hasil ukur rekam medis"),
    "RME_OBAT_ALKES_TIDAK_TERCATAT": (["M17"], "OBAT_ALKES_FIKTIF", 1.0, "Obat/alat yang ditagih tidak ada di rekam medis"),
    "RME_KELAS_BERBEDA": (["M13"], "KELAS_RAWAT", 1.0, "Kelas rawat klaim di atas kelas layanan rekam medis"),
    "RME_EPISODE_DIPECAH": (["M08", "M09"], "PEMECAHAN_EPISODE", 0.9, "Satu rawat inap di rekam medis ditagih terpisah"),
    "RME_KUNJUNGAN_DIPAKAI_ULANG": (["M11"], "KLAIM_GANDA", 1.2, "Satu kunjungan rekam medis ditagih dua klaim"),
    "RME_RAWAT_INAP_TANPA_INDIKASI": (["M15"], "TIDAK_SESUAI_INDIKASI", 0.7, "Rawat inap dengan semua hasil ukur normal"),
    # added 2026-11-15: the record's own times and quantities, and the stay in the context of the patient's other encounters
    "RME_VENTILASI_TIDAK_SESUAI": (["M04", "M14"], "DURASI_ALAT_TIDAK_SESUAI", 1.2, "Ventilasi ≥ 96 jam ditagih, rekam medis < 96 jam"),
    "RME_HARI_ICU_LEBIH": (["M12", "M13"], "DURASI_ALAT_TIDAK_SESUAI", 1.0, "Hari ICU klaim lebih dari lokasi ICU di rekam medis"),
    "RME_OBAT_JUMLAH_KURANG": (["M18"], "PENGURANGAN_OBAT", 1.0, "Jumlah obat ditagih lebih dari yang tercatat diserahkan/diberikan"),
    "RME_READMISI_TERENCANA": (["M16"], "READMISI", 0.9, "Rawat ulang terencana tanpa kebutuhan klinis di rekam medis"),
    "RME_READMISI_PULANG_DINI": (["M09", "M16"], "READMISI", 1.0, "Masuk lagi setelah dipulangkan belum stabil"),
    "RME_RUJUKAN_TANPA_INDIKASI": (["M10"], "RUJUKAN_SEMU", 0.9, "Rujukan dari RS lain tanpa alasan klinis di rekam medis"),
    "RME_DOKTER_PASIEN_DIPUTAR": (["M10"], "RUJUKAN_SEMU", 0.9, "Pasien berpindah RS mengikuti satu dokter"),
    # the device evidence (iot.py: a current-clamp sensor on each device's power cable, the device never opened: on-time, duration,
    # state jalan / siaga / mati; anchored). Not model features either. Proof (a measured duration or a hash) or review (a state read
    # from the current pattern, a mode the ventilator itself reported, or an absence): iot.JENIS_BUKTI
    "IOT_VENTILASI_KURANG_96": (["M04", "M14"], "DURASI_ALAT_TIDAK_SESUAI", 1.4, "Ventilasi ≥ 96 jam ditagih, ventilator jalan < 96 jam berturut-turut"),
    "IOT_MODE_NONINVASIF": (["M04"], "DURASI_ALAT_TIDAK_SESUAI", 1.2, "Mode ventilasi ditagih berbeda dari mode yang dilaporkan ventilator sendiri"),
    "IOT_VENTILATOR_STANDBY": (["M14"], "TINDAKAN_TIDAK_DILAKUKAN", 1.2, "Ventilasi ditagih, ventilator hanya siaga (tidak pernah jalan)"),
    "IOT_HD_SESI_SINGKAT": (["M14"], "DURASI_ALAT_TIDAK_SESUAI", 1.0, "Sesi hemodialisis < 3 jam ditagih penuh"),
    "IOT_HD_TANPA_SESI": (["M14", "M06"], "TINDAKAN_TIDAK_DILAKUKAN", 1.2, "Sesi hemodialisis ditagih tanpa jejak mesin"),
    "IOT_HARI_ICU_LEBIH": (["M12", "M13"], "DURASI_ALAT_TIDAK_SESUAI", 1.0, "Hari ICU ditagih lebih dari hari bed/monitor ICU menyala"),
    "IOT_TANPA_JEJAK": (["M14", "M06"], "TINDAKAN_TIDAK_DILAKUKAN", 1.0, "Pemakaian alat ditagih tanpa jejak sensor"),
    "IOT_BINDING_TUMPANG": (["M06"], "KLAIM_FIKTIF", 1.0, "Satu alat terikat ke dua pasien pada waktu yang sama"),
    "IOT_TANPA_PASIEN": ([], None, 0.3, "Alat berjalan tanpa pasien terikat (tingkat faskes)"),
    "IOT_JANGKAR_TIDAK_COCOK": (["M20"], "MANIPULASI_PEMERIKSAAN", 1.2, "Bukti alat berubah setelah dijangkarkan"),
    "IOT_JANGKAR_TERLAMBAT": (["M20"], "MANIPULASI_PEMERIKSAAN", 0.8, "Bukti alat dijangkarkan setelah klaim diajukan"),
    "IOT_KUNCI_DICABUT": (["M20"], "MANIPULASI_PEMERIKSAAN", 0.8, "Bukti alat ditandatangani kunci yang sudah dicabut"),
}
RME_SIGNALS = [k for k in SIGNALS if k.startswith("RME_")]
IOT_SIGNALS = [k for k in SIGNALS if k.startswith("IOT_")]


def modes_of(code: str) -> list[str]:
    return list(SIGNALS.get(code, ([], None, 0, ""))[0])


def catalogue(counts: dict[str, int], planted: dict[str, dict]) -> list[dict]:
    """The 20 modes (19 rows: 7 and 19 are one) with their detectors, alert counts in the stream and planted results."""
    from aip import semantik as S

    rows = []
    for m in S.MODUS_PERMENKES:
        mid = m["id"]
        rt = MODES.get(mid, {})
        sigs = [{"kode": k, "label": v[3], "bobot": v[2], "tag": v[1]} for k, v in SIGNALS.items() if mid in v[0]]
        rows.append({"id": mid, "no": m["no"], "nama": m["nama"], "arti": m["arti"], "faskes": m["faskes"], "fokus": m.get("fokus"),
                     "deteksi_batch": m["deteksi"], "deteksi": rt.get("deteksi"), "cara": rt.get("cara"), "dokumen": rt.get("dokumen"),
                     "sinyal": sigs, "alert": sum(counts.get(s["kode"], 0) for s in sigs), "tanam": planted.get(mid),
                     "juga": "M19 (inflated bills) di daftar sama dengan M07" if mid == "M07" else None})
    return rows
