"""Property descriptions of the grid demo's Nexus types, written into the ontology itself (property `description`), so
every application — Nexus Manager, Object Explorer, the Grid Intelligence Nexus in Vertex — shows them as ontology
metadata. Called as the last step of the grid demo build (demo_grid_e2e) and runnable on its own (apply()).

A description someone wrote is never overwritten; only empty ones and the generic placeholder text ("… tercatat dari
dataset sumber sistem grid (demo) …") are replaced. Descriptions state what the column holds in this demo (fictitious
data for the PLN distribution part, OpenStreetMap for the transmission maps); they do not claim more than the data does.
"""

from __future__ import annotations

import re
from typing import Any

# the same column means the same thing on every grid type
COMMON: dict[str, str] = {
    # identity and display
    "judul": "Judul tampilan objek (dirangkai dari kolom lain, untuk daftar dan pencarian).",
    "nama": "Nama objek untuk tampilan.",
    "deskripsi": "Uraian bebas objek dari sumber datanya.",
    "uraian": "Uraian pekerjaan / kejadian dalam kalimat.",
    "detail": "Rincian kejadian: nilai yang terukur dibanding batasnya.",
    "kategori": "Kategori kejadian (mis. beban trafo, tegangan, susut).",
    "satuan": "Satuan nilai pengukuran (kW, kWh, A, V, °C …).",
    "sumber": "Asal data baris ini (sistem / aliran data / sumber peta).",
    "sumber_data": "Dataset tempat kejadian ini dideteksi.",
    "cakupan": "Cakupan wilayah data (Jawa Barat atau regional Jawa-Bali).",
    "bukti": "Bukti yang mendasari temuan, dalam kalimat (angka meter / tagihan yang dibandingkan).",
    "rekomendasi": "Tindakan yang disarankan sistem untuk objek ini.",
    # location
    "lokasi": "Koordinat (lintang, bujur) untuk peta.",
    "latitude": "Lintang (derajat desimal, WGS84).",
    "longitude": "Bujur (derajat desimal, WGS84).",
    "lat": "Lintang (derajat desimal, WGS84).",
    "lon": "Bujur (derajat desimal, WGS84).",
    "geometri": "Geometri GeoJSON (garis / poligon) untuk peta.",
    "kabkota": "Kabupaten/kota tempat objek berada.",
    "area": "Area / unit wilayah operasi titik ukur.",
    # time
    "bulan": "Bulan periode data (YYYY-MM).",
    "tanggal": "Tanggal kejadian / pemeriksaan.",
    "tanggal_target": "Tanggal target pekerjaan selesai.",
    "mulai": "Waktu mulai kegiatan.",
    "selesai": "Waktu selesai kegiatan.",
    "waktu": "Waktu kejadian alarm.",
    "waktu_puncak": "Waktu beban puncak tercapai (WIB).",
    "waktu_trip": "Waktu pemutus (PMT) trip.",
    "jam_wib": "Jam periode neraca (WIB, awal jam).",
    "jam_deteksi": "Jam peristiwa terdeteksi dari aliran AMI (WIB).",
    "jam_data": "Jumlah jam data beban yang tersedia dalam periode analisis.",
    "bacaan_terakhir_wib": "Waktu bacaan meter terakhir yang diterima (WIB).",
    "jam_sejak_bacaan": "Jam sejak bacaan meter terakhir diterima (makin besar, makin mungkin meter putus komunikasi).",
    "durasi_jam": "Lama kegiatan (jam).",
    "durasi_menit": "Lama padam (menit).",
    "interval_menit": "Interval pengiriman data meter / sensor (menit).",
    # network structure
    "nama_gi": "Nama gardu induk (GI) yang memasok.",
    "nama_ulp": "Nama Unit Layanan Pelanggan (ULP) yang membawahi.",
    "nama_gardu": "Nama gardu yang dihubungkan.",
    "jumlah_penyulang": "Jumlah penyulang (feeder) 20 kV yang keluar dari GI ini.",
    "penyulang": "Jumlah penyulang 20 kV yang dipasok GI ini.",
    "jumlah_gardu_distribusi": "Jumlah gardu distribusi yang dipasok.",
    "jumlah_pelanggan_tm": "Jumlah pelanggan tegangan menengah (TM) yang tersambung langsung ke penyulang.",
    "pelanggan": "Jumlah pelanggan yang dipasok gardu ini.",
    "pelanggan_ami": "Jumlah pelanggan gardu ini yang memakai meter AMI.",
    "trafo": "Konfigurasi trafo daya GI (jumlah × MVA, rasio tegangan).",
    "n_trafo": "Jumlah trafo daya di GI.",
    "kva": "Kapasitas trafo distribusi (kVA).",
    "kva_rating": "Kapasitas trafo distribusi yang dipantau sensor (kVA).",
    "tahun_pasang": "Tahun trafo dipasang.",
    "umur_tahun": "Umur aset (tahun).",
    "panjang_km": "Panjang saluran (km).",
    "panjang_jtr_km": "Panjang jaringan tegangan rendah (JTR) gardu (km).",
    "r_jtr_ohm_km": "Resistansi penghantar JTR per km (Ω/km), dipakai menghitung rugi saluran.",
    "karakter_beban": "Karakter beban penyulang (perkotaan, industri, perdesaan …).",
    "gitet_hulu_osm": "GITET hulu terdekat menurut OpenStreetMap.",
    "jarak_gitet_km": "Jarak GI ke GITET hulunya (km).",
    "rtu": "Remote Terminal Unit (RTU) SCADA di GI.",
    "sistem_scada": "Sistem SCADA dan protokol komunikasinya.",
    "lbs_scada": "Jumlah load-break switch (LBS) yang terpantau SCADA.",
    "recloser_scada": "Jumlah recloser yang terpantau SCADA.",
    "tag_scada": "Tag SCADA titik ukur pelanggan (kosong bila tidak dipantau SCADA).",
    "tag_scada_kwh": "Tag SCADA energi kWh penyulang di GI.",
    "tag_trip": "Tag SCADA sinyal trip relai.",
    "rugi_besi_kw_per_trafo": "Rugi besi (inti) per trafo daya (kW), tetap selama trafo bertegangan.",
    "rugi_tembaga_kw_per_trafo": "Rugi tembaga per trafo daya pada beban penuh (kW).",
    "rugi_besi_w": "Rugi besi trafo distribusi (W).",
    "rugi_tembaga_w": "Rugi tembaga trafo distribusi pada beban penuh (W).",
    # meters and customers
    "no_meter": "Nomor meter (kunci ke Grid AMI Meter).",
    "head_end": "Head-end system (HES) yang mengumpulkan data meter / sensor.",
    "protokol": "Protokol komunikasi data meter / sensor.",
    "fase": "Jumlah fasa meter (1 atau 3).",
    "jenis_meter": "Jenis meter (pascabayar / prabayar).",
    "tegangan": "Tingkat tegangan: TR (tegangan rendah) atau TM (tegangan menengah).",
    "tarif": "Golongan tarif PLN (mis. R1/1300).",
    "golongan": "Golongan tarif dan daya, dengan keterangan segmennya.",
    "segmen": "Segmen pelanggan (rumah tangga, bisnis, industri …).",
    "daya_va": "Daya kontrak pelanggan (VA).",
    "daya_kontrak_kva": "Daya kontrak pelanggan (kVA).",
    "tarif_rp_kwh": "Tarif per kWh golongan pelanggan (Rp/kWh).",
    "ami": "Apakah pelanggan memakai meter AMI (Ya / Tidak).",
    "petugas_baca": "Kode petugas baca meter.",
    "nama_sensor": "Nama sensor / titik ukur yang mengirim deret waktu beban.",
    "seri_beban": "Deret waktu beban objek ini (kunci sensor).",
    "seri_ami": "Deret waktu beban dari meter AMI ini.",
    "seri_sensor": "Deret waktu sensor gardu distribusi.",
    "kwh_bulan_q2": "Rata-rata kWh per bulan pada kuartal II.",
    "kwh_bulan_q3": "Rata-rata kWh per bulan pada kuartal III.",
    "perubahan_pct": "Perubahan kWh kuartal III terhadap kuartal II (%).",
    "rasio_vs_peer": "Rasio konsumsi pelanggan terhadap pelanggan sejenis (golongan & daya sama).",
    "rasio_tagih_vs_amr": "Rasio kWh tertagih terhadap kWh terbaca AMR (jauh di bawah 1 = dugaan kWh tidak tertagih).",
    "porsi_malam": "Porsi energi yang dipakai malam hari (0–1).",
    "porsi_wbp": "Porsi energi pada waktu beban puncak (WBP, 17.00–22.00), 0–1.",
    "hari_melebihi_kontrak": "Jumlah hari beban melebihi daya kontrak.",
    "event_tamper": "Jumlah kejadian tamper (buka tutup meter, magnet, bypass) yang dilaporkan meter.",
    "event_terakhir": "Kejadian terakhir yang dilaporkan meter.",
    "rasio_arus_fasa_min": "Rasio arus fasa terkecil terhadap terbesar (rendah = arus fasa tidak seimbang, indikasi bypass).",
    "rasio_arus_netral": "Rasio arus netral terhadap arus fasa (tinggi = beban tidak seimbang / kebocoran).",
    "pola_dugaan": "Pola pencurian / kelainan yang diduga (kosong bila tidak ada).",
    "pola_gardu": "Pola kelainan pada tingkat gardu (kosong bila tidak ada).",
    "p2tl_terakhir": "Tanggal pemeriksaan P2TL terakhir.",
    "jumlah_p2tl": "Jumlah pemeriksaan P2TL yang pernah dilakukan.",
    "golongan_pelanggaran_lalu": "Golongan pelanggaran P2TL sebelumnya (P1–P4; kosong bila belum pernah).",
    # ML and rules
    "skor_ntl": "Skor model ML kemungkinan susut non-teknis (NTL) pelanggan, 0–1.",
    "skor_ntl_jam": "Skor NTL per jam dari aliran AMI, 0–1.",
    "skor_ntl_maks": "Skor NTL tertinggi di antara pelanggan gardu ini.",
    "skor_anomali": "Skor anomali pola beban (model tanpa label), 0–1.",
    "skor_aturan": "Jumlah aturan deteksi yang terpenuhi (skor berbasis aturan).",
    "prob_temuan": "Peluang pemeriksaan P2TL menemukan pelanggaran (model ML terkalibrasi).",
    "nilai_harapan_ml_rp": "Nilai harapan temuan = peluang temuan × kWh tagihan susulan × tarif (Rp).",
    "peringkat_nilai_ml": "Peringkat pelanggan menurut nilai harapan (1 = paling layak diperiksa).",
    "status_ml": "Kesimpulan model ML untuk pelanggan (Wajar, Pantau, Prioritas …).",
    "alasan_ml": "Faktor yang paling mendorong skor ML pelanggan ini.",
    "pelanggan_ntl_tinggi": "Jumlah pelanggan gardu ini dengan skor NTL tinggi.",
    "pelanggan_pola_baru": "Jumlah pelanggan gardu ini yang pola bebannya berubah.",
    "cusum": "Statistik CUSUM penurunan kWh (makin besar, makin pasti terjadi penurunan berkelanjutan).",
    "rasio_baseline": "Rasio kWh jam ini terhadap baseline meter.",
    "jumlah_aturan": "Jumlah aturan deteksi yang memicu temuan.",
    "semua_aturan": "Kode aturan deteksi yang memicu temuan.",
    # energy balance and losses
    "kwh_total": "Total energi terbaca meter dalam jendela pemantauan (kWh).",
    "kwh_jam": "Energi gardu pada jam ini (kWh).",
    "kwh_keluar_q3": "Energi keluar trafo gardu pada kuartal III (kWh).",
    "kwh_gardu_distribusi": "Energi terukur di gardu distribusi sepanjang penyulang (kWh).",
    "kwh_tagih_tm": "kWh tertagih pelanggan TM di penyulang.",
    "mwh_kirim_q3": "Energi yang dikirim penyulang pada kuartal III (MWh).",
    "rp_tagihan": "Nilai tagihan pelanggan (Rp).",
    "susut_kwh": "Susut energi = energi masuk − energi tertagih (kWh).",
    "susut_teknis_kwh": "Susut teknis: rugi trafo + rugi saluran, dihitung dari beban (kWh).",
    "susut_non_teknis_kwh": "Susut non-teknis (NTL) = susut total − susut teknis (kWh).",
    "rugi_trafo_kwh": "Rugi trafo (besi + tembaga) dalam periode (kWh).",
    "rugi_saluran_kwh": "Rugi saluran I²R dalam periode (kWh).",
    "rugi_i2r_puncak_kw": "Rugi I²R saluran saat beban puncak (kW).",
    "nilai_susut_rp_bulan": "Nilai rupiah susut per bulan (Rp).",
    "tingkat_susut": "Tingkat susut (Normal, Tinggi, Kritis).",
    "hari_data_meragukan": "Jumlah hari dengan data meter yang meragukan (hilang / lompat).",
    "menit_padam": "Menit padam penyulang dalam periode.",
    "thd_i_pct": "Distorsi harmonik total arus (THD-I, %).",
    "pf_rata": "Faktor daya rata-rata.",
    "faktor_beban": "Faktor beban = beban rata-rata / beban puncak.",
    "faktor_diversitas": "Faktor diversitas = jumlah puncak penyulang / puncak GI.",
    "meter_aktif": "Jumlah meter yang mengirim data pada jam ini.",
    "meter_kwh_sangat_rendah": "Jumlah meter dengan kWh sangat rendah pada jam ini.",
    "porsi_meter_rendah_pct": "Porsi meter ber-kWh sangat rendah pada jam ini (%).",
    "porsi_normal_gardu_pct": "Porsi meter ber-kWh sangat rendah yang biasa terjadi di gardu ini pada jam yang sama (%).",
    "status_jam": "Status neraca jam ini (Normal / Anomali).",
    # loading and thermal
    "kw_puncak": "Beban puncak (kW).",
    "puncak_kw": "Beban puncak penyulang (kW).",
    "kw_rata": "Beban rata-rata (kW).",
    "rata_kw": "Beban rata-rata penyulang (kW).",
    "puncak_mw": "Beban puncak GI (MW).",
    "puncak_mva": "Beban puncak GI (MVA).",
    "rata_mva": "Beban rata-rata GI (MVA).",
    "mw_puncak_penyulang": "Jumlah beban puncak seluruh penyulang GI (MW).",
    "arus_puncak_a": "Arus puncak penyulang (A).",
    "batas_termal_a": "Batas arus termal penyulang = yang terkecil dari KHA penghantar dan rating PMT (A).",
    "kha_a": "Kuat hantar arus (KHA) penghantar (A).",
    "rating_pmt_a": "Rating arus pemutus tenaga (PMT) penyulang (A).",
    "beban_termal_pct": "Arus puncak terhadap batas termal (%).",
    "jam_di_atas_80pct": "Jumlah jam beban di atas 80% batas termal.",
    "ruang_tambah_kw": "Sisa kapasitas sampai batas termal (kW).",
    "status_termal": "Status termal penyulang (Normal, Waspada, Overload).",
    "beban_pct": "Beban puncak aset terhadap kapasitasnya (%).",
    "jam_overload": "Jumlah jam aset melebihi kapasitasnya.",
    "hari_overload": "Jumlah hari trafo gardu overload.",
    "suhu_minyak_maks_c": "Suhu minyak trafo tertinggi yang terukur (°C).",
    "tegangan_ujung_min_v": "Tegangan terendah di ujung jaringan TR (V).",
    "v_maks": "Tegangan tertinggi yang terbaca meter (V).",
    "v_min": "Tegangan terendah yang terbaca meter (V).",
    # N-1
    "kapasitas_firm_mva": "Kapasitas firm GI: kapasitas bila trafo terbesar lepas (MVA).",
    "beban_firm_puncak_pct": "Beban puncak terhadap kapasitas firm (%).",
    "margin_n1_mva": "Sisa kapasitas firm saat beban puncak (MVA); negatif = tidak aman N-1.",
    "jam_melanggar_n1": "Jumlah jam beban melebihi kapasitas firm.",
    "jam_waspada_n1": "Jumlah jam beban di atas 90% kapasitas firm.",
    "status_n1": "Status keandalan N-1 GI (Aman N-1, Waspada, Tidak aman).",
    # reliability and outages
    "gangguan": "Jumlah gangguan penyulang dalam periode.",
    "gangguan_permanen": "Jumlah gangguan permanen (padam lebih dari 5 menit).",
    "gangguan_temporer": "Jumlah gangguan temporer (pulih otomatis oleh recloser).",
    "saidi_menit": "SAIDI: rata-rata menit padam per pelanggan.",
    "saifi_kali": "SAIFI: rata-rata kali padam per pelanggan.",
    "caidi_menit": "CAIDI = SAIDI / SAIFI: rata-rata lama satu kali padam (menit).",
    "maifi_kali": "MAIFI: rata-rata kali padam sesaat per pelanggan.",
    "saidi_6bln_menit": "SAIDI enam bulan terakhir (menit per pelanggan).",
    "ens_kwh": "Energi tidak tersalurkan akibat padam (kWh).",
    "kwh_tidak_tersalur": "Energi tidak tersalurkan selama gangguan ini (kWh).",
    "pelanggan_padam": "Jumlah pelanggan padam.",
    "pelanggan_jam_padam": "Pelanggan × jam padam.",
    "penyebab": "Penyebab gangguan.",
    "penyebab_dominan": "Penyebab gangguan terbanyak dalam bulan ini.",
    "peralatan_trip": "Peralatan proteksi yang trip.",
    # inspections, findings and work
    "no_ba": "Nomor berita acara (BA) pemeriksaan P2TL.",
    "tim": "Tim pelaksana pemeriksaan.",
    "dasar_pemilihan": "Alasan pelanggan dipilih untuk diperiksa.",
    "temuan": "Hasil pemeriksaan di lapangan.",
    "ditemukan_pelanggaran": "1 bila pemeriksaan menemukan pelanggaran, 0 bila tidak (label untuk melatih model).",
    "kwh_tagihan_susulan": "kWh yang ditagihkan susulan akibat pelanggaran.",
    "rp_tagihan_susulan": "Nilai tagihan susulan (Rp).",
    "jumlah_temuan": "Jumlah temuan susut yang terkait objek ini.",
    "temuan_p1": "Jumlah temuan prioritas 1.",
    "jenis_objek": "Jenis objek yang menjadi sasaran temuan (pelanggan, gardu, penyulang).",
    "kelompok_susut": "Kelompok susut: teknis atau non-teknis (NTL).",
    "kwh_hilang_bulan": "Perkiraan kWh hilang per bulan.",
    "nilai_rp_bulan": "Perkiraan nilai kWh hilang per bulan (Rp).",
    "status_temuan": "Status tindak lanjut temuan.",
    "tindak_lanjut_usulan": "Tindak lanjut yang diusulkan (target P2TL, perbaikan jaringan …).",
    "jenis_pekerjaan": "Jenis pekerjaan perbaikan.",
    "status_pekerjaan": "Status perintah kerja.",
    "pelaksana": "Regu / pihak pelaksana pekerjaan.",
    "estimasi_biaya_rp": "Perkiraan biaya pekerjaan (Rp).",
    "estimasi_penghematan_kwh_bulan": "Perkiraan susut yang turun setelah pekerjaan (kWh per bulan).",
    "anggota": "Komposisi anggota regu.",
    "keahlian": "Keahlian regu: TR (tegangan rendah) atau TM (tegangan menengah).",
    "kendaraan": "Kendaraan regu.",
    "status_kunjungan": "Status kunjungan lapangan.",
    # alarms and asset risk
    "severity": "Tingkat keparahan alarm (info, warning, critical).",
    "status_alarm": "Status penanganan alarm.",
    "ambang": "Ambang batas yang dilampaui.",
    "nilai": "Nilai terukur yang memicu alarm.",
    "ditugaskan_ke": "Petugas / regu yang ditugaskan menangani alarm.",
    "catatan_operator": "Catatan operator saat menangani alarm.",
    "jenis_aset": "Jenis aset (gardu distribusi, penyulang, GI).",
    "kelas_risiko": "Kelas risiko aset (Rendah, Sedang, Tinggi).",
    "status_aset": "Status operasi aset.",
    "faktor_utama": "Faktor yang paling menaikkan risiko aset.",
    "kejadian_terakhir": "Kejadian terakhir yang tercatat pada aset.",
    "status_gardu": "Status gardu distribusi menurut beban, tegangan dan susut.",
    # AMI meter health / events
    "bacaan": "Jumlah bacaan meter yang diterima dalam jendela pemantauan.",
    "kualitas_baik_pct": "Porsi bacaan berkualitas baik (%).",
    "status_kesehatan": "Kesehatan meter (OK, Check, Fault).",
    "alasan": "Alasan status kesehatan meter.",
    "status_peristiwa": "Status penanganan peristiwa.",
    # SCADA measurement points
    "bay": "Kode bay di gardu.",
    "nama_bay": "Nama bay di gardu.",
    "historian": "Historian tempat tag diarsipkan.",
    "jenis_titik": "Jenis titik ukur (analog, status, energi).",
    "nama_peralatan": "Nama peralatan yang diukur.",
    "tipe_peralatan": "Tipe peralatan yang diukur (trafo, penyulang, PMT …).",
    "tag": "Tag SCADA titik ukur.",
    "tag_tanpa_site": "Tag SCADA tanpa awalan site.",
    # OpenStreetMap transmission network
    "osm_id": "ID objek OpenStreetMap (node/way/relation).",
    "operator": "Operator menurut tag OpenStreetMap (kosong bila tidak diisi).",
    "kapasitas_mw": "Kapasitas terpasang (MW) menurut OpenStreetMap.",
    "kapasitas_teks": "Kapasitas seperti tertulis di tag OpenStreetMap.",
    "sumber_label": "Sumber energi pembangkit (air, batubara, gas, surya …) menurut OpenStreetMap.",
    "jenis_gardu_osm": "Jenis gardu menurut tag OpenStreetMap (transmission, distribution, generation …).",
    "kelas": "Kelas tegangan (mis. SUTT 150 kV, SUTET 500 kV).",
    "kelas_kv_sumber": "Asal kelas tegangan: tag OSM atau perkiraan.",
    "voltage": "Tegangan seperti tertulis di tag OpenStreetMap (V).",
    "ruas_terhubung": "Jumlah ruas saluran yang tersambung ke gardu.",
    "panjang_dalam_jabar_km": "Panjang saluran yang berada di Jawa Barat (km).",
    "nama_ujung_a": "Gardu di ujung awal saluran.",
    "nama_ujung_b": "Gardu di ujung akhir saluran (kosong bila ujungnya tanpa gardu).",
    "gardu_osm_id": "ID OpenStreetMap gardu.",
    "saluran_osm_id": "ID OpenStreetMap saluran.",
    "jarak_km": "Jarak gardu ke saluran (km).",
    "simpul_a": "Simpul (bus) awal ruas dalam graf jaringan.",
    "simpul_b": "Simpul (bus) akhir ruas dalam graf jaringan.",
    "nama_simpul_a": "Nama gardu di simpul awal.",
    "nama_simpul_b": "Nama gardu di simpul akhir.",
    "ruas_osm": "Way OpenStreetMap ruas ini.",
    "jumlah_ruas": "Jumlah way OSM yang digabung menjadi ruas ini.",
    "kritis_n1": "Ruas kritis N-1 secara struktur: bila lepas, jaringan terpisah.",
    "komponen_utama": "Berada di komponen jaringan terbesar.",
    "simpul_terisolasi": "Jumlah simpul yang terputus bila ruas lepas.",
    "gardu_terisolasi": "Jumlah gardu yang terputus bila ruas lepas.",
    "pembangkit_terisolasi": "Jumlah pembangkit yang terputus bila ruas lepas.",
    "mw_terisolasi": "Kapasitas pembangkit yang terputus bila ruas lepas (MW).",
    "contoh_terisolasi": "Contoh gardu yang terputus bila ruas lepas.",
    "dampak": "Ringkasan dampak bila ruas lepas.",
    "tetangga": "Jumlah simpul tetangga.",
    "koridor": "Jumlah ruas yang tersambung ke simpul.",
    "koridor_kritis": "Jumlah ruas kritis N-1 yang tersambung ke simpul.",
    "titik_artikulasi": "Titik artikulasi: bila simpul lepas, jaringan terpisah.",
    "redundansi": "Redundansi pasokan simpul (radial atau lebih dari satu jalur).",
}

# where a column means something specific on one type
BY_TYPE: dict[str, dict[str, str]] = {
    "Grid Feeder": {"jenis": "Jenis penyulang: SUTM (saluran udara) atau SKTM (kabel tanah)."},
    "Grid Feeder Loading": {"jenis": "Jenis penyulang: SUTM (saluran udara) atau SKTM (kabel tanah)."},
    "Grid Feeder Outage": {"jenis": "Jenis gangguan (temporer / permanen)."},
    "Transmission Bus (OSM, analysis)": {"jenis": "Jenis simpul (gardu, pembangkit, sambungan tanpa gardu).",
                                         "kapasitas_mw": "Kapasitas pembangkit di simpul ini (MW)."},
    "Grid Meter Inspection P2TL": {"segmen": "Segmen pelanggan yang diperiksa."},
    "Grid Operations Alarm": {"rekomendasi": "Tindakan yang disarankan untuk menangani alarm."},
    "Grid Primary Substation N-1 Contingency": {"rekomendasi": "Tindakan yang disarankan untuk menjaga keandalan N-1."},
    "Grid Operational Asset Risk": {"rekomendasi": "Tindakan pemeliharaan yang disarankan untuk aset."},
    "Grid Customer": {"satuan": "Satuan deret waktu beban pelanggan."},
}

_PLACEHOLDER = re.compile(r"tercatat dari dataset sumber")


def describe(type_name: str, api_name: str) -> str | None:
    return BY_TYPE.get(type_name, {}).get(api_name) or COMMON.get(api_name)


def _replaceable(desc: str | None) -> bool:
    return not desc or bool(_PLACEHOLDER.search(desc))


def apply() -> dict[str, Any]:
    """Describe every grid type's properties that have no description or only the generic placeholder."""
    import ontology

    import grid_nexus
    import nexus_engine

    out: dict[str, Any] = {}
    for name, t in nexus_engine.types(grid_nexus.DOMAIN).items():  # curated name → type, as the Nexus shows it
        with ontology._lock:
            rec = ontology._object_type(t["id"])
            props, n = [], 0
            for p in rec["properties"]:
                if _replaceable(p.get("description")):
                    d = describe(name, p["api_name"])
                    if d and d != p.get("description"):
                        p = {**p, "description": d}
                        n += 1
                props.append(p)
            if n:
                ontology.update_object_type(t["id"], ontology.ObjectTypeIn(properties=[ontology.Property(**p) for p in props]))
        if n:
            out[name] = n
    return out
