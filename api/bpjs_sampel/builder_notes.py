"""The notes and the data dictionary of "Pipeline Data Sampel BPJS: Data Mentah → Siap Analisis" (builder_pipeline):
why each node exists, what each output is for and who reads it, and what every column means — the source's own codes
with their labels from the Stata files (bronze/_meta/katalog_*), the names they become in Data Bersih, the Siap
Analisis columns, and how the source anonymized its identifiers. Shown in the Builder (a node's or an output's About
panel, the Data dictionary button); written for the jury and the analysts, in Indonesian.

Anonymization, as the data states it (docs/PIPELINE_DATA_SAMPEL_BPJS.md §1, §6): the sample is de-identified by BPJS —
participant and family numbers are pseudonyms (8–9 digits, not the 13-digit JKN card number), and names, NIK and
facility IDs are not in the data at all; a facility is known only by its region, ownership, type and class.
"""

from __future__ import annotations

from bpjs_sampel.repo.bpjs_spec import REPAIR_COLS, SPEC

# who reads a dataset (Nexus types are api/bpjs_sampel/nexus.py TYPES; an agent group answers for its types)
AGEN = {"faskes": "Agen Faskes & Wilayah", "klaim": "Agen Klaim & Fraud", "rujukan": "Agen Rujukan", "klinis": "Agen Klinis",
        "peserta": "Agen Peserta"}


def _n(apa: str, kenapa: str, dipakai: str = "") -> str:
    """A node's note: one short description, what it does and why (who reads it is the graph's to show)."""
    return f"{apa} {kenapa}"


# ------------------------------------------------------------------------------------------------ node notes (by id)

NOTES: dict[str, str] = {
    # 1 · Data Mentah
    "s_kepesertaan": _n("Tabel peserta JKN dari file asli (kolom PSTV*, kode angka).", "Sumber semua data peserta: usia, segmen, wilayah tinggal, FKTP terdaftar.", "node peserta"),
    "s_fktpkapitasi": _n("Kunjungan FKTP kapitasi dari file asli (kolom FKP*).", "Sumber kunjungan puskesmas/klinik/dokter praktik dan asal rujukan.", "node kunjungan_fktp"),
    "s_fkrtl_bagian_1": _n("Klaim FKRTL edisi reguler, covid, DM (kolom FKL*).", "File asli FKRTL dipecah dua karena batas 2 GiB per build Code Repository.", "node fkrtl_gabung (Union)"),
    "s_fkrtl_bagian_2": _n("Klaim FKRTL edisi kesehatan mental, KIA ibu/anak, TB (kolom FKL*).", "Bagian kedua klaim FKRTL; skemanya sedikit berbeda dari bagian 1.", "node fkrtl_gabung (Union)"),
    "s_diagnosissekunder": _n("Diagnosis sekunder klaim FKRTL, satu baris per kode per kunjungan.", "Menghitung jumlah diagnosis penyerta tiap klaim.", "node diagnosis_sekunder"),
    "s_nonkapitasi": _n("Tindakan FKTP nonkapitasi (kolom PNK*), satu baris per tindakan.", "Sumber tindakan di luar kapitasi dan profil faskesnya.", "node tindakan_nonkapitasi"),
    "s_label_nilai_kepesertaan": _n("Buku label: arti tiap kode per kolom per edisi, untuk tabel peserta.", "Kode angka (mis. PSTV05 = 1) harus diterjemahkan jadi teks (Laki-laki).", "node label_kepesertaan, label_semua"),
    "s_label_nilai_fktpkapitasi": _n("Buku label tabel FKTP kapitasi.", "Menerjemahkan kode FKP* (jenis FKTP, poli, status pulang …).", "node label_fktpkapitasi, label_semua"),
    "s_label_nilai_fkrtl_bagian_1": _n("Buku label FKRTL bagian 1.", "Menerjemahkan kode FKL* (tipe RS, kelas rawat, keparahan …).", "node label_fkrtl_gabung, label_semua"),
    "s_label_nilai_fkrtl_bagian_2": _n("Buku label FKRTL bagian 2.", "Edisi bagian 2 punya label sendiri.", "node label_fkrtl_gabung, label_semua"),
    "s_label_nilai_nonkapitasi": _n("Buku label tabel nonkapitasi.", "Menerjemahkan kode PNK*.", "node label_nonkapitasi, label_semua"),
    "s_dim_icd10": _n("Buku kode ICD-10 3 digit resmi (dibaca dari xlsx oleh Code Repository).", "Nama diagnosis harus dari buku kode resmi, bukan teks sumber yang kadang salah ketik.", "dim_icd10_ref → penyakit_teratas; tipe Nexus Diagnosis ICD-10"),
    "s_ibukota_provinsi": _n("Ibu kota dan koordinat 38 provinsi.", "Peta risiko menaruh tiap provinsi di titik ibu kotanya.", "node provinsi (Left join)"),
    # 2 · Data Bersih: label books
    "t_label_seragam": _n("Kolom yang artinya sama di semua edisi: tiap kodenya berlabel sama di minimal dua edisi.",
                          "Hanya kolom seperti ini yang boleh meminjamkan label; FKP14 dsb. (nomor diagnosis per edisi) tidak.", "node label_kandidat"),
    "t_label_edisi": _n("Edisi tiap tabel yang punya buku label.", "Untuk tahu edisi mana yang bisa menerima label pinjaman.", "node label_kandidat"),
    "j_label_kandidat": _n("Label kolom seragam untuk setiap edisi tabelnya.", "Calon label pinjaman, sebelum dicek apakah edisinya sudah punya.", "node label_pinjaman"),
    "j_label_pinjam": _n("Label yang dipinjam: edisi yang sama sekali tidak punya label untuk kolom itu (FKP05_NEW dan FKP16_NEW di edisi covid).",
                         "File covid BPJS tidak menyertakan label kode provinsi 38; tanpa ini kunjungan FKTP covid tak punya nama provinsi.", "node label_lengkap"),
    "u_label_lengkap": _n("Buku label asli ditambah label pinjaman.", "Satu buku untuk semua tabel: tidak ada kunci yang ada di dua buku.", "node label_siap"),
    "lab_siap": _n("Buku label semua tabel sebagai kunci kolom|edisi|kode → teks.", "Mapping join butuh satu kunci per nilai; MISSING / TIDAK TERDEFINISI dijadikan kosong supaya tidak terbaca sebagai kategori.",
                   "Mapping join di peserta, kunjungan_fktp, kunjungan_fkrtl_bersih, tindakan_nonkapitasi"),
    # 2 · Data Bersih: facts
    "t_peserta": _n("Peserta bersih: nama kolom jelas, tipe benar, kode → label, usia akhir 2024, flag tanggal lahir pengganti.", "Semua analisis peserta butuh satu tabel rapi; kode PSTV tidak terbaca manusia.", "output peserta; profil_peserta, peserta_klaim_berisiko, kode_wilayah_peserta"),
    "t_fktp": _n("Kunjungan FKTP bersih, satu baris per kunjungan per edisi, plus bulan kunjungan.", "Dasar semua ringkasan FKTP dan sisi asal rujukan.", "output kunjungan_fktp; rujukan, fktp_wilayah, kode_wilayah_fktp, faskes_fktp"),
    "t_dx": _n("Diagnosis sekunder bersih (kode dirapikan, huruf besar).", "Kode diagnosis sumber kadang berspasi/huruf kecil; harus seragam untuk dihitung.", "output diagnosis_sekunder; dx_per_kunjungan"),
    "t_nonkap": _n("Tindakan nonkapitasi bersih, dengan urutan tindakan_ke per kunjungan (Window: row number).", "Satu kunjungan bisa punya beberapa tindakan; urutannya menjadi kunci baris.", "output tindakan_nonkapitasi; ICD-10 rinci, profil faskes"),
    "fkrtl_u": _n("Union by name klaim FKRTL bagian 1 + 2.", "Analisis klaim harus melihat semua edisi sekaligus; kolom yang tidak ada di satu bagian menjadi kosong.", "node kunjungan_fkrtl_bersih"),
    "t_fkrtl_bersih": _n("Klaim FKRTL bersih: 57 kolom diberi nama, 21 kode → label, nama diagnosis dipulihkan, LOS, selisih tagih − verifikasi, bulan pulang.", "Tahap terberat (jutaan klaim); dijadikan checkpoint supaya dihitung sekali dan dipakai 4 node sesudahnya.", "los_p99_inacbg, fkrtl_dx, icd10 rinci"),
    "t_dx_n": _n("Jumlah diagnosis sekunder per kunjungan (Aggregate: count).", "Banyaknya diagnosis penyerta adalah informasi klinis klaim (kompleksitas kasus).", "Left join fkrtl_dx"),
    "t_p99": _n("Persentil 99 lama rawat (LOS) per kode INA-CBG.", "LOS ekstrem harus dibandingkan dengan kasus sejenis, bukan dengan semua klaim.", "Left join fkrtl_p99 → flag_los_ekstrem"),
    "j_fkrtl_dx": _n("Left join klaim ⨝ jumlah diagnosis sekunder (edisi + kunjungan).", "Klaim tanpa diagnosis sekunder tetap ada (jumlah 0), jadi left join, bukan inner.", "fkrtl_p99"),
    "j_fkrtl_p99": _n("Left join klaim ⨝ p99 LOS kodenya.", "Setiap klaim perlu batas LOS kodenya untuk flag LOS ekstrem.", "node kunjungan_fkrtl"),
    "t_fkrtl": _n("Klaim FKRTL siap: flag calon klaim ganda (Window: count), selisih verifikasi, LOS ekstrem (> p99 dan > 3 hari).", "Flag menandai, tidak membuang: analis dan agen yang menilai klaim mana yang diperiksa.", "output kunjungan_fkrtl; klaim, rujukan, dim_inacbg, profil faskes; model ML, pipeline produksi, jejak data"),
    "t_rj_fkrtl": _n("Klaim FKRTL yang membawa nomor kunjungan FKTP asalnya (Filter).", "Hanya klaim dengan rujukan yang bisa ditelusuri ke FKTP.", "Left join rujukan_fktp"),
    "j_rujukan": _n("Left join klaim ⨝ kunjungan FKTP asal (edisi + nomor kunjungan).", "Menyambungkan dua ujung rujukan: tanggal, wilayah dan diagnosis di FKTP dan di RS.", "node rujukan"),
    "t_rujukan": _n("Rujukan FKTP → FKRTL: jarak hari, asal dan tujuan, diagnosis sama atau tidak.", "Dasar analisis rujukan semu dan rujukan lintas wilayah.", "output rujukan; alur_rujukan"),
    # 2 · Data Bersih: dimensions
    "t_dim_icd10": _n("Referensi ICD-10 3 digit: kode, nama, bab (Select).", "Satu sumber nama diagnosis resmi untuk semua output.", "penyakit_teratas"),
    "t_icd_0": _n("Kode ICD-10 rinci dari diagnosis masuk klaim FKRTL (Select + Rename).", "Kode rinci 4–6 digit tidak ada di buku 3 digit; namanya diambil dari data.", "Union icd10_rinci_gabung"),
    "t_icd_1": _n("Kode ICD-10 rinci dari diagnosis primer klaim FKRTL.", "Sumber kedua kode rinci.", "Union icd10_rinci_gabung"),
    "t_icd_2": _n("Kode ICD-10 rinci dari diagnosis tindakan nonkapitasi.", "Sumber ketiga kode rinci.", "Union icd10_rinci_gabung"),
    "u_icd_rinci": _n("Union tiga sumber kode ICD-10 rinci.", "Satu daftar kode dari semua tempat diagnosis dicatat.", "node dim_icd10_rinci"),
    "t_dim_icd10_rinci": _n("ICD-10 rinci: tiap kode dengan nama dan 3 digit yang paling sering dipakai (Aggregate + Window: first value).", "Kode yang sama kadang tercatat dengan ejaan nama berbeda; yang paling sering dipakai menjadi nama bakunya, seri ke abjad pertama.", "output dim_icd10_rinci"),
    "t_dim_inacbg": _n("Kode INA-CBG dengan deskripsi, CMG, tipe kasus, keparahan yang paling sering tercatat (Aggregate: mode).", "Klaim membawa deskripsi kode berulang-ulang; dimensi ini menyimpannya sekali per kode.", "output dim_inacbg; indikator_inacbg; tipe Nexus Kode INA-CBG"),
    "u_label": _n("Union semua buku label (lima tabel).", "Satu buku label untuk semua tabel, dan kode kab/kota serta provinsi tersebar di buku kelima tabel.",
                  "label_kolom_seragam, label_pinjaman, label_lengkap, label_provinsi_34, label_kabkota"),
    "t_label_prov": _n("Nama provinsi (kode 34) per kode, dari buku label.", "Kab/kota perlu nama provinsi BPS-nya.", "Left join kabkota_provinsi"),
    "t_label_kab": _n("Nama kab/kota per kode; kode provinsi dari 2 digit pertama (Formula: floor(kode / 100)).", "Dimensi wilayah dibangun dari label sumber, bukan tabel luar.", "Left join kabkota_provinsi"),
    "j_dim_wilayah": _n("Left join kab/kota ⨝ nama provinsi.", "Setiap kab/kota mendapat provinsinya.", "node dim_wilayah"),
    "t_dim_wilayah": _n("Wilayah sumber: kab/kota → provinsi (34 provinsi).", "Dasar dimensi wilayah 38 provinsi di tahap Siap Analisis.", "output dim_wilayah; wilayah"),
    "t_pf_fktp": _n("Ciri faskes FKTP tiap kunjungan: kab/kota, kepemilikan, jenis, tipe.", "BPJS menghapus ID faskes; faskes hanya dikenali dari ciri-cirinya.", "Union faskes_gabung"),
    "t_pf_fkrtl": _n("Ciri faskes FKRTL tiap klaim.", "Sama, untuk rumah sakit.", "Union faskes_gabung"),
    "t_pf_nonkapitasi": _n("Ciri faskes tiap tindakan nonkapitasi.", "Sama, untuk faskes nonkapitasi.", "Union faskes_gabung"),
    "u_faskes": _n("Union ciri faskes dari tiga tabel layanan.", "Satu daftar profil faskes untuk semua tingkat layanan.", "node dim_profil_faskes"),
    "t_dim_faskes": _n("Profil faskes: tingkat × kab/kota × kepemilikan × jenis × tipe, dengan id = MD5 ciri-ciri itu.", "Pengganti ID faskes yang tidak ada di data sampel, supaya klaim bisa dikelompokkan per profil faskes.", "output dim_profil_faskes; profil_faskes, kabkota"),
    # 3 · Siap Analisis: wilayah 38
    "t_w_fktp": _n("Pasangan kab/kota → provinsi 38 yang tercatat di kunjungan FKTP.", "Kode provinsi 38 (pemekaran Papua 2022) hanya ada di kolom *_38 data, bukan di kode kab/kota.", "Union kode_wilayah_38"),
    "t_w_peserta": _n("Pasangan kab/kota → provinsi 38 di tempat tinggal peserta.", "Sumber kedua pemetaan provinsi 38.", "Union kode_wilayah_38"),
    "t_w_fkrtl": _n("Pasangan kab/kota → provinsi 38 di klaim FKRTL.", "Sumber ketiga pemetaan provinsi 38.", "Union kode_wilayah_38"),
    "u_wilayah_38": _n("Union pasangan kab/kota → provinsi 38 dari tiga tabel.", "Semakin banyak sumber, semakin pasti provinsi baru tiap kab/kota.", "kabkota_pindah_provinsi, nama_provinsi_38"),
    "t_pindah": _n("Kab/kota yang tercatat di provinsi lain dari kode BPS-nya (26 kab/kota Papua).", "Pemekaran 2022 memindahkan kab/kota ke Papua Barat Daya, Selatan, Tengah, Pegunungan.", "Left join wilayah_pindah"),
    "t_nama38": _n("Nama tiap kode provinsi 38.", "Provinsi baru perlu namanya.", "Left join wilayah_nama_38"),
    "j_w1": _n("Left join dim_wilayah ⨝ kab/kota yang pindah provinsi.", "Kab/kota yang tidak pindah tetap memakai provinsi lamanya.", "wilayah_kode_38"),
    "t_w_kode": _n("Kode provinsi 38 = provinsi baru bila pindah, selain itu kode lama (Coalesce).", "Satu kode provinsi untuk semua output.", "Left join wilayah_nama_38"),
    "j_w2": _n("Left join ⨝ nama provinsi 38.", "Kode provinsi baru mendapat namanya.", "node wilayah"),
    "t_wilayah": _n("Dimensi wilayah: kab/kota → 38 provinsi (kode 34 disimpan).", "Semua ringkasan per provinsi harus memakai pemetaan yang sama; checkpoint karena dipakai 12 node.", "output wilayah; semua Join wilayah; skor ML dan roster analis provinsi"),
    # 3 · klaim
    "j_klaim_w": _n("Left join klaim FKRTL ⨝ wilayah (kab/kota faskes).", "Setiap klaim perlu provinsi 38-nya.", "node klaim"),
    "t_klaim": _n("Klaim + provinsi, rawat inap, profil faskes (Hash MD5), readmisi 30 hari (Window: lead per peserta), top-up special CMG, tagihan di luar tarif "
                  "INA-CBG + top-up, kunci peer setarif (Concatenate).", "Pusat semua ukuran klaim; checkpoint karena dibaca 11 node.", "semua ringkasan klaim, klaim_berisiko, penyakit_fkrtl"),
    # 3 · provinsi
    "t_prov_w": _n("Provinsi dari dimensi wilayah dengan jumlah kab/kotanya (Aggregate).", "Satu baris per provinsi untuk peta dan objek Nexus.", "Left join provinsi_ibukota"),
    "j_prov_ibukota": _n("Left join provinsi ⨝ ibu kota dan koordinat.", "Peta menaruh provinsi di titik ibu kotanya.", "provinsi_klaim"),
    "t_prov_klaim": _n("Ukuran klaim per provinsi: jumlah, biaya, rawat inap, readmisi, klaim berisiko.", "Ringkasan provinsi untuk peta dan agen wilayah.", "Left join provinsi_klaim"),
    "j_prov_klaim": _n("Left join provinsi ⨝ ukuran klaimnya.", "Provinsi tanpa klaim tetap tampil (nilainya 0).", "node provinsi"),
    "t_provinsi": _n("Provinsi siap: klaim, peserta, biaya, % readmisi, klaim berisiko (Formula untuk %).", "Objek Provinsi di Nexus dan titik di peta risiko; juga sumber nama provinsi output lain.", "output provinsi; 6 Join nama provinsi"),
    # 3 · aggregates
    "t_kk_agg": _n("Ukuran klaim per edisi × kab/kota × tipe RS (Aggregate).", "Perbandingan antarwilayah dan antartipe RS.", "Left join klaim_kabkota_wilayah"),
    "j_kk_w": _n("Left join ⨝ nama kab/kota dan provinsi.", "Kode wilayah perlu nama.", "node klaim_kabkota"),
    "t_klaim_kabkota": _n("Rata-rata biaya, LOS, % readmisi, % calon klaim ganda (Formula), kunci objek (Concatenate).", "Objek Klaim per Kab/Kota di Nexus.", "output klaim_kabkota"),
    "t_kb_agg": _n("Ukuran klaim per edisi × bulan × provinsi × CMG × keparahan.", "Tren bulanan per kelompok kasus (deteksi upcoding: porsi keparahan naik).", "Left join klaim_bulanan_provinsi_nama"),
    "j_kb_p": _n("Left join ⨝ nama provinsi.", "Kode provinsi perlu nama.", "node klaim_bulanan"),
    "t_klaim_bulanan": _n("Klaim bulanan lengkap per CMG dan keparahan, dengan kunci baris.", "Tabel analisis lengkap; versi ringkas per provinsi menjadi objek Nexus.", "output klaim_bulanan"),
    "t_ia_agg": _n("Statistik per INA-CBG × tipe RS × regional tarif × edisi: median biaya, median dan p90 LOS rawat inap (Percentile).", "Indikator per kode untuk dashboard dan objek Nexus; untuk klaim berisiko hanya p90 LOS-nya yang dipakai (biaya dibandingkan dengan peer setarif).", "indikator_inacbg, klaim_peer (p90 LOS klaim berisiko)"),
    "j_ia_d": _n("Left join ⨝ deskripsi kode INA-CBG.", "Kode INA-CBG perlu deskripsi yang terbaca.", "node indikator_inacbg"),
    "t_indikator_inacbg": _n("Indikator INA-CBG: biaya, median, % readmisi, % calon ganda, % LOS ekstrem, % selisih verifikasi.", "Tabel analisis lengkap semua kelompok peer.", "output indikator_inacbg; indikator_peer"),
    "j_fktp_w": _n("Left join kunjungan FKTP ⨝ wilayah.", "Kunjungan FKTP perlu provinsi 38-nya.", "ringkasan FKTP, penyakit_fktp"),
    "t_fb_agg": _n("Kunjungan FKTP per bulan × provinsi × jenis FKTP × poli: kunjungan sakit, rujuk lanjut.", "Pola layanan primer dan rujukan per poli.", "Left join nama provinsi"),
    "j_t_fb_p": _n("Left join ⨝ nama provinsi.", "Kode provinsi perlu nama.", "node kunjungan_fktp_bulanan"),
    "t_fb": _n("Kunjungan FKTP bulanan lengkap per poli, % rujuk lanjut (Formula).", "Tabel analisis lengkap FKTP.", "output kunjungan_fktp_bulanan"),
    "t_fp_agg": _n("Kunjungan FKTP per bulan × provinsi × jenis FKTP (tanpa poli).", "Versi ringkas untuk objek Nexus (lebih sedikit baris).", "Left join nama provinsi"),
    "j_t_fp_p": _n("Left join ⨝ nama provinsi.", "Kode provinsi perlu nama.", "node kunjungan_fktp_provinsi"),
    "t_fp": _n("Kunjungan FKTP bulanan per provinsi, % rujuk lanjut.", "Objek Kunjungan FKTP Bulanan di Nexus.", "output kunjungan_fktp_provinsi"),
    "t_py_fktp": _n("Jumlah kunjungan dan peserta per diagnosis FKTP × provinsi.", "Penyakit terbanyak di layanan primer.", "Union penyakit_gabung"),
    "t_py_fkrtl": _n("Jumlah klaim, peserta dan biaya per diagnosis primer FKRTL × provinsi.", "Penyakit terbanyak dan termahal di rumah sakit.", "Union penyakit_gabung"),
    "u_penyakit": _n("Union diagnosis FKTP dan FKRTL.", "Satu tabel peringkat penyakit untuk kedua tingkat layanan.", "penyakit_icd10"),
    "j_py_icd": _n("Left join ⨝ nama dan bab ICD-10 resmi.", "Nama penyakit dari buku kode, bukan teks sumber.", "penyakit_provinsi"),
    "j_py_p": _n("Left join ⨝ nama provinsi.", "Kode provinsi perlu nama.", "node penyakit_teratas"),
    "t_penyakit_teratas": _n("20 penyakit teratas per edisi × provinsi × tingkat (Window: row number, Filter ≤ 20).", "Objek Penyakit Teratas di Nexus (agen klinis).", "output penyakit_teratas"),
    "t_ar_agg": _n("Rujukan per edisi × kab/kota asal × kab/kota tujuan × tipe RS: jumlah, median hari, diagnosis sama.", "Pola alur rujukan antarwilayah.", "alur_asal"),
    "j_ar_asal": _n("Left join ⨝ wilayah asal (prefix asal_).", "Kab/kota asal perlu nama dan provinsinya.", "alur_tujuan"),
    "j_ar_tujuan": _n("Left join ⨝ wilayah tujuan (prefix tujuan_).", "Kab/kota tujuan perlu nama dan provinsinya.", "node alur_rujukan"),
    "t_alur_rujukan": _n("Alur rujukan: % diagnosis sama, lintas kab/kota, lintas provinsi (Conditional column).", "Objek Alur Rujukan di Nexus: sinyal rujukan semu.", "output alur_rujukan"),
    "j_pp_w": _n("Left join peserta ⨝ wilayah tempat tinggal.", "Peserta perlu provinsi 38-nya.", "peserta_per_kelompok"),
    "t_pp_agg": _n("Peserta per edisi × provinsi × segmen × jenis kelamin × kelompok usia (Formula + Pad + Conditional column).", "Profil kepesertaan yang menjadi penyebut analisis layanan.", "peserta_provinsi"),
    "j_pp_p": _n("Left join ⨝ nama provinsi.", "Kode provinsi perlu nama.", "node profil_peserta"),
    "t_profil_peserta": _n("Profil peserta dengan kunci objek.", "Objek Profil Peserta di Nexus.", "output profil_peserta"),
    "t_ko_klaim": _n("Ukuran klaim per kab/kota faskes.", "Ringkasan klaim tiap kab/kota.", "kabkota_klaim"),
    "t_ko_faskes": _n("Jumlah profil faskes per kab/kota.", "Berapa banyak profil faskes di tiap kab/kota.", "kabkota_faskes"),
    "j_ko_klaim": _n("Left join wilayah ⨝ ukuran klaim kab/kota.", "Kab/kota tanpa klaim tetap tampil.", "kabkota_faskes"),
    "j_ko_faskes": _n("Left join ⨝ jumlah profil faskes.", "Melengkapi objek kab/kota.", "node kabkota"),
    "t_kabkota": _n("Kab/kota siap: klaim, readmisi, klaim berisiko, profil faskes.", "Objek Kabupaten/Kota di Nexus.", "output kabkota"),
    "j_pf_w": _n("Left join profil faskes ⨝ wilayah.", "Profil faskes perlu nama kab/kota dan provinsi.", "faskes_klaim"),
    "t_pf_klaim": _n("Ukuran klaim per profil faskes, termasuk rawat inap keparahan III.", "Ringkasan klaim tiap profil faskes (pengganti analisis per faskes); "
                     "upcoding terlihat di porsi keparahan faskes, bukan di satu klaim terhadap kodenya sendiri.", "faskes_klaim"),
    "j_pf_klaim": _n("Left join profil faskes ⨝ ukuran klaimnya.", "Profil tanpa klaim FKRTL (FKTP, nonkapitasi) tetap ada.", "node profil_faskes"),
    "t_profil_faskes": _n("Profil faskes siap, dengan nama profil terbaca (Concatenate) dan % rawat inap keparahan III (Formula).", "Objek Profil Faskes di Nexus; "
                          "% keparahan III dibandingkan dengan faskes setipe untuk sinyal upcoding.", "output profil_faskes"),
    "t_kr_flag": _n("Klaim dengan sedikitnya satu indikasi: calon klaim ganda, selisih verifikasi, LOS ekstrem (Filter).", "Hanya klaim berindikasi yang menjadi objek pemeriksaan.", "klaim_peer"),
    "j_kr_peer": _n("Left join ⨝ p90 LOS rawat inap peer (INA-CBG, tipe RS, regional tarif, edisi), prefix peer_.", "Lama rawat dinilai dibanding kode yang sama; tarif tidak mengubah LOS.", "klaim_peer_tarif"),
    "t_peer_tarif": _n("Peer setarif: klaim dengan INA-CBG, tipe RS, regional, kepemilikan, kelas rawat, tahun tarif dan edisi sama (Aggregate): jumlah, median biaya tagih, "
                       "% klaim ber-top-up obat/prostesis/prosedur/investigasi khusus.",
                       "Grouper INA-CBG memberi tarif paket yang sama dalam satu tabel tarif; tanpa kepemilikan, kelas rawat dan tahun, banyak klaim \"1,5× di atas peer\" "
                       "hanya karena tabel tarif RS-nya berbeda, bukan tagihannya.", "klaim_peer_tarif"),
    "j_kr_tarif": _n("Left join ⨝ statistik peer setarif (kunci peer_tarif_id), prefix peer_.", "Biaya klaim dinilai dibanding klaim yang tarif paketnya sama.", "klaim_peer_wilayah"),
    "j_kr_w": _n("Left join ⨝ nama kab/kota dan provinsi.", "Kode wilayah perlu nama.", "node klaim_berisiko"),
    "t_klaim_berisiko": _n("Klaim berisiko: rasio biaya/peer setarif, top-up dan tagihan di luar tarif, skor 0–100 (Formula), indikasi utama dan alasan dalam kalimat "
                           "(biaya di atas peer dijelaskan penyebabnya: di luar tarif, top-up subakut/kronis, top-up khusus).", "Objek Klaim Berisiko di Nexus: titik masuk agen fraud, Box Karantina dan berkas kasus.", "output klaim_berisiko; indikator_peer, peserta_klaim_berisiko"),
    "j_kf_w": _n("Left join klaim ⨝ nama kab/kota dan provinsi.", "Setiap klaim perlu nama wilayahnya.", "node klaim_fkrtl"),
    "t_kf_edisi": _n("Jumlah edisi tiap kunjungan dan salinan yang dihitung (Aggregate: count, min dari prioritas|edisi).",
                     "Klaim yang sama bisa tercatat identik di 2+ edisi; tanpa penanda ini jumlah dan total nasional terhitung dobel.", "node klaim_fkrtl_edisi"),
    "j_kf_edisi": _n("Left join klaim ⨝ jumlah edisi dan salinan kanoniknya.", "Setiap klaim tahu apakah ia salinan yang dihitung.", "node klaim_fkrtl"),
    "t_klaim_fkrtl": _n("Semua klaim FKRTL, satu baris per klaim dengan kunci klaim_id (Concatenate) dan faktanya: tarif + top-up, tagihan di luar tarif, flag, "
                        "readmisi, kunci peer setarif, bobot sampel, salinan lintas edisi (klaim_kanonik).", "Objek Nexus live Klaim FKRTL (setiap klaim satu objek, dibaca langsung dari dataset ini): aturan dan agen bisa melihat "
                        "setiap klaim, bukan hanya yang lolos saringan.", "output klaim_fkrtl; tipe Nexus Klaim FKRTL (BPJS)"),
    "t_ip_n": _n("Jumlah klaim berisiko per kelompok peer.", "Kelompok peer yang punya klaim berisiko harus ikut ke Nexus walau kecil.", "indikator_peer_berisiko"),
    "j_ip": _n("Left join indikator INA-CBG ⨝ jumlah klaim berisikonya.", "Menandai kelompok peer yang relevan.", "node indikator_peer"),
    "t_indikator_peer": _n("Kelompok peer dengan ≥ 30 klaim atau yang punya klaim berisiko (Filter).", "Batas jumlah objek indeks Nexus: hanya kelompok yang andal atau relevan.", "output indikator_peer"),
    "t_kbp_agg": _n("Ukuran klaim per edisi × bulan × provinsi.", "Tren bulanan per provinsi.", "Left join nama provinsi"),
    "j_kbp_p": _n("Left join ⨝ nama provinsi.", "Kode provinsi perlu nama.", "node klaim_bulanan_provinsi"),
    "t_klaim_bulanan_provinsi": _n("Klaim bulanan per provinsi: rata-rata, % readmisi, kunci objek.", "Objek Klaim Bulanan Provinsi di Nexus (grafik tren).", "output klaim_bulanan_provinsi"),
    "t_pkb_agg": _n("Jumlah klaim berisiko, biayanya dan skor tertinggi per peserta.", "Peserta dengan banyak klaim berisiko adalah sinyal (mis. klaim fiktif, episode dipecah).", "peserta_berisiko (Inner join)"),
    "t_pkb_p": _n("peserta_id sebagai teks (Cast).", "Kunci klaim berisiko menyimpan peserta_id sebagai teks; kedua sisi join harus bertipe sama.", "peserta_berisiko (Inner join)"),
    "j_pkb": _n("Inner join peserta ⨝ ringkasan klaim berisikonya.", "Hanya peserta yang punya klaim berisiko, jadi inner, bukan left join.", "peserta_berisiko_wilayah"),
    "j_pkb_w": _n("Left join ⨝ provinsi tempat tinggal.", "Peserta perlu provinsi 38-nya.", "node peserta_klaim_berisiko"),
    "t_peserta_klaim_berisiko": _n("Peserta klaim berisiko dengan profil kepesertaannya.", "Objek Peserta Klaim Berisiko di Nexus (agen peserta).", "output peserta_klaim_berisiko"),
}

# ------------------------------------------------------------------------------------------------ output notes

def _o(isi: str, kunci: str, dipakai: str) -> str:
    """An output's note: one short description of what it holds."""
    return isi


OUTPUT_NOTES: dict[str, str] = {
    "peserta": _o("Peserta JKN bersih, 1 baris per peserta per edisi.", "edisi + peserta_id", "profil_peserta, peserta_klaim_berisiko, dimensi wilayah; agen AIP"),
    "kunjungan_fktp": _o("Kunjungan FKTP bersih, 1 baris per kunjungan per edisi.", "edisi + kunjungan_fktp_id", "rujukan, ringkasan FKTP, penyakit FKTP, dimensi wilayah"),
    "diagnosis_sekunder": _o("Diagnosis sekunder klaim FKRTL, 1 baris per kode per klaim.", "edisi + kunjungan_fkrtl_id + dx_kode", "jumlah_dx_sekunder di kunjungan_fkrtl"),
    "tindakan_nonkapitasi": _o("Tindakan FKTP nonkapitasi bersih, 1 baris per tindakan.", "edisi + kunjungan_id + tindakan_ke", "ICD-10 rinci, profil faskes"),
    "kunjungan_fkrtl": _o("Klaim FKRTL bersih dengan flag kualitas, 1 baris per klaim per edisi.", "edisi + kunjungan_fkrtl_id", "model ML risiko koreksi (fitur dan label), pipeline produksi AIP (kontrak data), jejak data berkas kasus, semua ringkasan klaim"),
    "rujukan": _o("Rujukan FKTP → FKRTL, 1 baris per klaim rujukan.", "edisi + kunjungan_fkrtl_id", "alur_rujukan; agen rujukan"),
    "dim_icd10_rinci": _o("Kode ICD-10 rinci dengan nama baku.", "kode", "nama diagnosis rinci di aplikasi dan agen"),
    "dim_inacbg": _o("Kode INA-CBG dengan deskripsi, CMG, tipe kasus, keparahan.", "inacbg_kode", f"tipe Nexus Kode INA-CBG (BPJS) — {AGEN['klinis']}; indikator_inacbg"),
    "dim_wilayah": _o("Kab/kota → provinsi (34), dari label sumber (516).", "kabkota_kode", "dimensi wilayah 38 provinsi"),
    "dim_profil_faskes": _o("Profil faskes pengganti ID faskes.", "faskes_profil_id", "profil_faskes, kabkota"),
    "wilayah": _o("Kab/kota → 38 provinsi (516).", "kabkota_kode", "semua kolom provinsi Siap Analisis; skor ML per provinsi dan roster analis provinsi AIP"),
    "provinsi": _o("38 provinsi dengan ibu kota, titik peta dan ringkasan klaim.", "provinsi_kode", f"tipe Nexus Provinsi (BPJS) — {AGEN['faskes']}; Peta risiko klaim BPJS"),
    "klaim_kabkota": _o("Ukuran klaim per edisi × kab/kota × tipe RS.", "klaim_kabkota_id", f"tipe Nexus Klaim per Kab/Kota (BPJS) — {AGEN['klaim']}"),
    "klaim_bulanan": _o("Ukuran klaim per bulan × provinsi × CMG × keparahan.", "klaim_bulanan_id", "analisis tren rinci (tabel lengkap; objek Nexus memakai klaim_bulanan_provinsi)"),
    "indikator_inacbg": _o("Indikator semua kelompok peer INA-CBG.", "indikator_id", "analisis lengkap (objek Nexus memakai indikator_peer)"),
    "kunjungan_fktp_bulanan": _o("Kunjungan FKTP per bulan × provinsi × jenis FKTP × poli.", "kunjungan_fktp_bulanan_id", "analisis layanan primer rinci (objek Nexus memakai kunjungan_fktp_provinsi)"),
    "kunjungan_fktp_provinsi": _o("Kunjungan FKTP per bulan × provinsi × jenis FKTP.", "kunjungan_fktp_bulanan_id", f"tipe Nexus Kunjungan FKTP Bulanan (BPJS) — {AGEN['peserta']}"),
    "penyakit_teratas": _o("20 penyakit teratas per edisi × provinsi × tingkat layanan.", "penyakit_teratas_id", f"tipe Nexus Penyakit Teratas (BPJS) — {AGEN['klinis']}"),
    "alur_rujukan": _o("Alur rujukan kab/kota asal → tujuan.", "alur_rujukan_id", f"tipe Nexus Alur Rujukan (BPJS) — {AGEN['rujukan']}"),
    "profil_peserta": _o("Profil peserta per provinsi × segmen × jenis kelamin × kelompok usia.", "profil_peserta_id", f"tipe Nexus Profil Peserta (BPJS) — {AGEN['peserta']}"),
    "kabkota": _o("516 kab/kota dengan ringkasan klaim dan profil faskes.", "kabkota_kode", f"tipe Nexus Kabupaten/Kota (BPJS) — {AGEN['faskes']}"),
    "profil_faskes": _o("Profil faskes dengan ringkasan klaim dan % rawat inap keparahan III.", "faskes_profil_id", f"tipe Nexus Profil Faskes (BPJS) — {AGEN['faskes']}"),
    "klaim_berisiko": _o("Klaim dengan ≥ 1 indikasi, statistik peer setarif, top-up, tagihan di luar tarif, skor 0–100 dan alasan.", "klaim_id", f"tipe Nexus Klaim Berisiko (BPJS) — {AGEN['klaim']}; Box Karantina (median peer); jejak data berkas kasus"),
    "indikator_peer": _o("Kelompok peer yang andal (≥ 30 klaim) atau relevan (punya klaim berisiko).", "indikator_id", f"tipe Nexus Indikator INA-CBG (BPJS) — {AGEN['klaim']}"),
    "klaim_bulanan_provinsi": _o("Ukuran klaim per edisi × bulan × provinsi.", "klaim_bulanan_id", f"tipe Nexus Klaim Bulanan Provinsi (BPJS) — {AGEN['klaim']} (grafik tren)"),
    "klaim_fkrtl": _o("Semua klaim FKRTL dengan faktanya, satu baris per klaim (kunci klaim_id).", "klaim_id",
                      f"tipe Nexus live Klaim FKRTL (BPJS) — {AGEN['klaim']}: dibaca langsung dari dataset (ontology_live), tidak diindeks"),
    "peserta_klaim_berisiko": _o("Peserta yang punya klaim berisiko.", "peserta_key", f"tipe Nexus Peserta Klaim Berisiko (BPJS) — {AGEN['peserta']}"),
}

# ------------------------------------------------------------------------------------------------ the data dictionary

SAMARAN = ("Nomor sintetis buatan generator (synthetic-gen): bukan nomor samaran BPJS dan bukan nomor kartu JKN; hanya untuk "
           "menghubungkan baris antar-tabel.")
ANON = {
    "PSTV01": SAMARAN, "peserta_id": SAMARAN,
    "PSTV02": "Nomor keluarga sintetis: menghubungkan anggota satu keluarga sintetis, tidak menunjuk keluarga asli.",
    "keluarga_id": "Nomor keluarga sintetis: menghubungkan anggota satu keluarga sintetis, tidak menunjuk keluarga asli.",
    "PSTV01_A": "Nomor peserta ibu, sintetis; hanya di edisi KIA-Anak.",
    "peserta_ibu_id": "Nomor peserta ibu, sintetis; hanya di edisi KIA-Anak.",
    "peserta_key": "Berisi peserta_id sintetis (edisi:peserta_id).",
    "faskes_profil_id": "Bukan ID faskes: BPJS menghapus ID faskes dari data sampel. Ini MD5 dari tingkat|kab/kota|kepemilikan|jenis|tipe, "
                        "jadi satu profil bisa mewakili beberapa faskes.",
}
TABEL = {"kepesertaan": "Peserta (PSTV)", "fktpkapitasi": "Kunjungan FKTP (FKP)", "fkrtl": "Klaim FKRTL (FKL)", "nonkapitasi": "Tindakan nonkapitasi (PNK)",
         "diagnosissekunder": "Diagnosis sekunder"}
SILVER_OF = {"kepesertaan": "peserta", "fktpkapitasi": "kunjungan_fktp", "fkrtl": "kunjungan_fkrtl", "nonkapitasi": "tindakan_nonkapitasi",
             "diagnosissekunder": "diagnosis_sekunder"}
KIND = {"id": "nomor (ID)", "key": "kode/ID teks", "date": "tanggal", "label": "kode berlabel", "float": "angka desimal", "int": "angka", "money": "rupiah",
        "icd3": "ICD-10 3 karakter", "text": "teks", "flag": "penanda ya/tidak"}

# Data Bersih and Siap Analisis columns that are computed, not copied from a source code
DERIVED: dict[str, tuple[str, str, str]] = {
    # name: (label, note, group)
    "edisi": ("Edisi data sampel", "reguler, covid, dm, kesehatan_mental, kia_ibu, kia_anak, tb. Peserta yang sama di dua edisi = dua baris.", "Semua tahap"),
    "sumber_file": ("File .dta asal baris", "Hanya di Data Mentah, untuk menelusuri baris ke file sumbernya.", "Data Mentah"),
    "usia_akhir_2024": ("Usia peserta pada 31 Desember 2024 (tahun penuh)", "Dihitung dari tgl_lahir (Date difference, tahun); kosong bila tanggal lahir sesudah 2024. Tanggal lahir yang sangat tua dibiarkan apa adanya.", "Data Bersih · peserta"),
    "flag_tgl_lahir_pengganti": ("Tanggal lahir diduga nilai pengganti", "Benar bila tgl_lahir < 1901 (sumber memakai 1900-07-01 bila tidak diketahui).", "Data Bersih · peserta"),
    "bulan": ("Bulan layanan", "Data Bersih: tanggal awal bulan (FKTP: bulan datang, FKRTL: bulan pulang). Siap Analisis: teks yyyy-MM.", "Semua tahap"),
    "tindakan_ke": ("Urutan tindakan dalam satu kunjungan nonkapitasi", "Window: row number per kunjungan, urut tanggal tindakan dan nama tindakan.", "Data Bersih · tindakan_nonkapitasi"),
    "los_hari": ("Lama rawat (hari)", "tgl_pulang − tgl_datang.", "Data Bersih · kunjungan_fkrtl"),
    "selisih_rp": ("Selisih tagih − verifikasi (rupiah)", "≠ 0 berarti klaim dikoreksi verifikator.", "Data Bersih · kunjungan_fkrtl"),
    "jumlah_dx_sekunder": ("Jumlah diagnosis sekunder klaim", "Dari diagnosis_sekunder (Aggregate + Left join, 0 bila tidak ada).", "Data Bersih · kunjungan_fkrtl"),
    "flag_calon_klaim_ganda": ("Calon klaim ganda", "Ada klaim lain dengan peserta, tanggal datang/pulang, INA-CBG dan biaya tagih yang sama persis. Calon: perlu cek rekam medis.", "Data Bersih · kunjungan_fkrtl"),
    "flag_selisih_verifikasi": ("Klaim dikoreksi verifikator", "selisih_rp ≠ 0.", "Data Bersih · kunjungan_fkrtl"),
    "flag_los_ekstrem": ("LOS ekstrem", "LOS di atas persentil 99 kode INA-CBG-nya dan lebih dari 3 hari.", "Data Bersih · kunjungan_fkrtl"),
    "hari_ke_fkrtl": ("Hari dari kunjungan FKTP ke kunjungan RS", "tgl_fkrtl − tgl_fktp pada rujukan.", "Data Bersih · rujukan"),
    "dx_sama": ("Diagnosis FKTP sama dengan diagnosis primer RS", "Kosong bila salah satu diagnosis tidak tercatat.", "Data Bersih · rujukan"),
    "flag_rujukan_tanpa_fktp": ("Nomor rujukan tidak ditemukan di kunjungan FKTP", "Selalu salah (0) di data ini: semua rujukan tersambung.", "Data Bersih · rujukan"),
    "tgl_fktp": ("Tanggal kunjungan FKTP asal rujukan", "", "Data Bersih · rujukan"),
    "tgl_fkrtl": ("Tanggal datang ke RS", "", "Data Bersih · rujukan"),
    "dipakai": ("Berapa kali kode tercatat di data", "", "Data Bersih · dimensi"),
    "kode": ("Kode ICD-10 rinci", "", "Data Bersih · dim_icd10_rinci"),
    "icd3": ("Kode ICD-10 3 karakter", "Bab diagnosis, mis. I21 = infark miokard akut.", "Semua tahap"),
    "nama": ("Nama diagnosis", "Dari buku kode resmi (dim_icd10) atau yang paling sering tercatat (dim_icd10_rinci).", "Data Bersih · dimensi"),
    "bab": ("Bab ICD-10", "", "Data Bersih · dim_icd10"),
    "deskripsi": ("Deskripsi kode INA-CBG", "Yang paling sering tercatat di klaim (Mode).", "Data Bersih · dim_inacbg"),
    "cmg": ("Case Mix Group INA-CBG", "Kelompok kasus utama (huruf pertama kode).", "Data Bersih · dim_inacbg"),
    "tipe_kasus": ("Tipe kasus INA-CBG", "", "Data Bersih · dim_inacbg"),
    "spesifikasi": ("Spesifikasi INA-CBG", "", "Data Bersih · dim_inacbg"),
    "keparahan": ("Keparahan INA-CBG", "Rawat jalan, I (ringan), II (sedang), III (berat).", "Data Bersih · dim_inacbg"),
    "kabkota_kode": ("Kode kab/kota (BPS 4 digit)", "", "Semua tahap"),
    "kabkota": ("Nama kab/kota", "", "Semua tahap"),
    "kabkota_nama": ("Nama kab/kota", "", "Siap Analisis · wilayah"),
    "provinsi_kode": ("Kode provinsi (38 provinsi)", "Di Data Bersih dim_wilayah: kode 34 (2 digit pertama kab/kota). Di Siap Analisis: kode 38 setelah pemekaran Papua 2022.", "Semua tahap"),
    "provinsi": ("Nama provinsi", "", "Semua tahap"),
    "provinsi_nama": ("Nama provinsi (38)", "", "Siap Analisis · wilayah"),
    "provinsi_34_kode": ("Kode provinsi lama (34 provinsi)", "2 digit pertama kode kab/kota (BPS); hanya disimpan sebagai pembanding.", "Siap Analisis · wilayah"),
    "provinsi_34_nama": ("Nama provinsi lama (34)", "", "Siap Analisis · wilayah"),
    "ibukota": ("Ibu kota provinsi", "", "Siap Analisis · provinsi"),
    "lokasi": ("Titik peta ibu kota (lintang,bujur)", "", "Siap Analisis · provinsi"),
    "tingkat": ("Tingkat layanan", "FKTP, FKRTL atau NONKAPITASI.", "Profil faskes & penyakit"),
    "kepemilikan": ("Kepemilikan faskes", "", "Profil faskes"),
    "jenis": ("Jenis faskes", "", "Profil faskes"),
    "tipe": ("Tipe/kelas faskes", "", "Profil faskes"),
    "nama_profil": ("Nama profil faskes yang terbaca", "tingkat · jenis · tipe · kepemilikan · kab/kota.", "Siap Analisis · profil_faskes"),
    "kunjungan": ("Jumlah kunjungan", "Di kunjungan_fktp_*: kunjungan FKTP. Di penyakit_teratas: kunjungan dengan diagnosis itu di tingkat layanannya. Di profil_faskes: semua layanan di profil itu — kunjungan FKTP + klaim FKRTL + tindakan nonkapitasi.", "Siap Analisis"),
    "rawat_inap": ("Klaim rawat inap", "Keparahan INA-CBG bukan 'Rawat Jalan'.", "Siap Analisis · klaim"),
    "readmisi_30": ("Rawat inap ulang ≤ 30 hari", "Di klaim: benar bila rawat inap berikutnya peserta yang sama ≤ 30 hari setelah pulang (Window: lead). Di ringkasan: jumlahnya.", "Siap Analisis"),
    "klaim": ("Jumlah klaim FKRTL", "", "Siap Analisis"),
    "klaim_inap": ("Jumlah klaim rawat inap", "", "Siap Analisis"),
    "klaim_fkrtl": ("Jumlah klaim FKRTL", "", "Siap Analisis"),
    "peserta": ("Jumlah peserta berbeda", "Di Data Bersih nama ini adalah dataset peserta; di ringkasan: hitungan peserta unik.", "Siap Analisis"),
    "peserta_fkrtl": ("Jumlah peserta berbeda yang punya klaim FKRTL", "", "Siap Analisis"),
    "los_hari_inap": ("Total hari rawat inap", "Bahan rata_los_inap_hari.", "Siap Analisis"),
    "rata_biaya_tagih_rp": ("Rata-rata biaya tagih per klaim (rupiah)", "biaya_tagih_rp / klaim, dibulatkan.", "Siap Analisis"),
    "rata_los_inap_hari": ("Rata-rata lama rawat inap (hari)", "los_hari_inap / klaim_inap.", "Siap Analisis"),
    "pct_readmisi_30": ("% rawat inap yang diikuti readmisi ≤ 30 hari", "100 × readmisi_30 / klaim_inap.", "Siap Analisis"),
    "calon_klaim_ganda": ("Jumlah calon klaim ganda", "", "Siap Analisis"),
    "pct_calon_klaim_ganda": ("% calon klaim ganda", "100 × calon_klaim_ganda / klaim.", "Siap Analisis"),
    "selisih_verifikasi": ("Jumlah klaim dikoreksi verifikator", "", "Siap Analisis"),
    "pct_selisih_verifikasi": ("% klaim dikoreksi verifikator", "", "Siap Analisis"),
    "los_ekstrem": ("Jumlah klaim LOS ekstrem", "", "Siap Analisis"),
    "pct_los_ekstrem": ("% klaim LOS ekstrem", "", "Siap Analisis"),
    "klaim_berisiko": ("Jumlah klaim dengan ≥ 1 indikasi", "Calon klaim ganda, selisih verifikasi atau LOS ekstrem.", "Siap Analisis"),
    "profil_faskes": ("Jumlah profil faskes di kab/kota", "", "Siap Analisis · kabkota"),
    "biaya_tagih_p50_rp": ("Median biaya tagih kelompok peer (rupiah)", "", "Siap Analisis · indikator"),
    "los_inap_p50": ("Median lama rawat inap kelompok peer", "", "Siap Analisis · indikator"),
    "los_inap_p90": ("Persentil 90 lama rawat inap kelompok peer", "", "Siap Analisis · indikator"),
    "indikator_id": ("Kunci kelompok peer", "edisi|INA-CBG|tipe RS|regional tarif.", "Siap Analisis · indikator"),
    "inacbg_deskripsi": ("Deskripsi kode INA-CBG", "", "Semua tahap"),
    "jenis_fktp": ("Jenis FKTP", "", "Semua tahap"),
    "poli": ("Poli layanan", "Kosong di sumber menjadi 'tidak tercatat' di Siap Analisis (baris tidak dibuang).", "Semua tahap"),
    "kunjungan_sakit": ("Jumlah kunjungan sakit", "", "Siap Analisis · FKTP"),
    "rujuk_lanjut": ("Jumlah kunjungan dirujuk lanjut ke FKRTL", "", "Siap Analisis · FKTP"),
    "pct_rujuk_lanjut": ("% kunjungan dirujuk lanjut", "", "Siap Analisis · FKTP"),
    "diagnosis": ("Nama diagnosis (ICD-10 resmi)", "", "Siap Analisis · penyakit_teratas"),
    "peringkat": ("Peringkat penyakit (1 = terbanyak)", "Window: row number per edisi × provinsi × tingkat.", "Siap Analisis · penyakit_teratas"),
    "rujukan": ("Jumlah rujukan", "Di Data Bersih nama ini adalah dataset rujukan.", "Siap Analisis · alur_rujukan"),
    "median_hari_ke_fkrtl": ("Median hari dari FKTP ke RS", "", "Siap Analisis · alur_rujukan"),
    "pct_dx_sama": ("% rujukan dengan diagnosis sama di kedua ujung", "Rendah bisa berarti rujukan semu.", "Siap Analisis · alur_rujukan"),
    "lintas_kabkota": ("Rujukan keluar kab/kota (1) atau tidak (0)", "", "Siap Analisis · alur_rujukan"),
    "lintas_provinsi": ("Rujukan keluar provinsi (1) atau tidak (0)", "", "Siap Analisis · alur_rujukan"),
    "kelompok_usia": ("Kelompok usia 10 tahunan", "00-09 … 60-69, 70+, 'tidak diketahui' bila tanggal lahir kosong atau pengganti.", "Siap Analisis · profil_peserta"),
    "peserta_aktif": ("Jumlah peserta berstatus AKTIF", "", "Siap Analisis · profil_peserta"),
    "peserta_meninggal": ("Jumlah peserta berstatus MENINGGAL", "", "Siap Analisis · profil_peserta"),
    "klaim_id": ("Kunci klaim", "edisi:kunjungan_fkrtl_id.", "Siap Analisis · klaim_berisiko"),
    "indikasi_utama": ("Indikasi terkuat klaim", "Calon klaim ganda > Selisih verifikasi > LOS ekstrem.", "Siap Analisis · klaim_berisiko"),
    "peer_klaim": ("Jumlah klaim di kelompok peer setarif", "INA-CBG, tipe RS, regional, kepemilikan, kelas rawat, tahun tarif dan edisi sama. Peer < 30 klaim kurang andal.",
                   "Siap Analisis · klaim_berisiko"),
    "peer_biaya_p50_rp": ("Median biaya tagih peer setarif (rupiah)", "", "Siap Analisis · klaim_berisiko"),
    "peer_pct_topup_khusus": ("% klaim peer setarif yang ber-top-up khusus", "Top-up obat, prostesis, prosedur atau investigasi khusus (special CMG).", "Siap Analisis · klaim_berisiko"),
    "peer_los_inap_p90": ("Persentil 90 LOS rawat inap peer", "Peer INA-CBG × tipe RS × regional × edisi (tarif tidak mengubah lama rawat).", "Siap Analisis · klaim_berisiko"),
    "rasio_biaya_peer": ("Biaya tagih ÷ median peer setarif", "> 1,5 jauh di atas klaim yang tarif paketnya sama: lihat top-up dan tagihan di luar tarif untuk penyebabnya.",
                         "Siap Analisis · klaim_berisiko"),
    "topup_subakut_rp": ("Top-up subakut/kronis (rupiah)", "FKL34 special CMG sub-acute/chronic; dibayar di luar paket untuk rawat panjang (mis. rawat jiwa kronis). Kosong = 0.",
                         "Siap Analisis · klaim"),
    "topup_khusus_rp": ("Top-up khusus: prosedur, prostesis, investigasi, obat (rupiah)", "FKL37 + FKL40 + FKL43 + FKL46 special CMG; dibayar di luar paket. Kosong = 0.",
                        "Siap Analisis · klaim"),
    "sisa_di_luar_tarif_rp": ("Tagihan di luar tarif INA-CBG + top-up (rupiah)", "biaya_tagih − tarif_inacbg − top-up. 0 pada hampir semua klaim; > 0 berarti tagihan melebihi tarif "
                              "yang ditetapkan grouper (sebagian besar klaim skema COVID per hari); < 0 pada prosedur signifikan rawat jalan.", "Siap Analisis · klaim"),
    "tahun_tarif": ("Tahun tarif (tahun pulang)", "Tarif INA-CBG berubah antartahun (mis. Permenkes 3/2023); bagian dari kunci peer setarif.", "Siap Analisis · klaim"),
    "peer_tarif_id": ("Kunci peer setarif", "edisi|INA-CBG|tipe RS|regional tarif|kepemilikan|kelas rawat|tahun tarif.", "Siap Analisis · klaim"),
    "jumlah_edisi": ("Di berapa edisi klaim ini tercatat", "1 untuk hampir semua klaim; lebih dari 1 bila klaim yang sama tercatat identik di 2+ edisi (mis. pasien DM juga tersampel di "
                     "reguler).", "Siap Analisis · klaim_fkrtl"),
    "klaim_kanonik": ("Salinan yang dihitung", "Benar untuk satu salinan per klaim (reguler dulu, lalu edisi pertama menurut abjad): jumlah dan total nasional "
                      "memakai klaim_kanonik = true supaya tidak dobel.", "Siap Analisis · klaim_fkrtl"),
    "klaim_inap_berat": ("Jumlah rawat inap keparahan III", "INA-CBG keparahan Berat (III).", "Siap Analisis · profil_faskes"),
    "pct_keparahan_berat": ("% rawat inap keparahan III", "100 × klaim_inap_berat / klaim_inap; jauh di atas faskes setipe = sinyal upcoding.", "Siap Analisis · profil_faskes"),
    "jumlah_indikasi": ("Jumlah indikasi (0–4)", "Calon ganda + selisih verifikasi + LOS ekstrem + readmisi 30.", "Siap Analisis · klaim_berisiko"),
    "skor_risiko": ("Skor skrining aturan 0–100", "Calon ganda 35, selisih verifikasi 25, LOS ekstrem 25, readmisi 10, + rasio biaya peer (maks. 15). Bukan peluang fraud.", "Siap Analisis · klaim_berisiko"),
    "alasan_risiko": ("Alasan skor dalam kalimat", "Satu kalimat per indikasi, dipisah titik koma.", "Siap Analisis · klaim_berisiko"),
    "biaya_klaim_berisiko_rp": ("Total biaya tagih klaim berisiko peserta (rupiah)", "", "Siap Analisis · peserta_klaim_berisiko"),
    "skor_risiko_maks": ("Skor risiko tertinggi di antara klaim peserta", "", "Siap Analisis · peserta_klaim_berisiko"),
    "provinsi_tinggal": ("Provinsi tempat tinggal peserta", "Di Siap Analisis: provinsi 38 dari dimensi wilayah.", "Semua tahap"),
}
KEYS = {"klaim_kabkota_id": "edisi:kab/kota:tipe RS", "klaim_bulanan_id": "edisi:bulan:provinsi[:CMG:keparahan]",
        "kunjungan_fktp_bulanan_id": "edisi:bulan:provinsi:jenis FKTP[:poli]", "penyakit_teratas_id": "edisi:provinsi:tingkat:peringkat",
        "alur_rujukan_id": "edisi:kab/kota asal:kab/kota tujuan:tipe RS", "profil_peserta_id": "edisi:provinsi:segmen:jenis kelamin:kelompok usia"}
NOT_IN_DATA = ("(tidak ada di data sampel)", "Nama, NIK, nomor kartu JKN asli, alamat dan ID faskes",
               "Tidak termuat di data sampel yang diberikan BPJS. Peserta hanya dikenali lewat nomor samaran (peserta_id), faskes lewat "
               "profilnya (provinsi, kab/kota, kepemilikan, jenis, tipe).")


# where an entry's meaning comes from, as a document the jury can check (who says so?)
DOC = "Data Sampel BPJS Kesehatan Edisi 2025 (versi sintetis)"


# codes the data uses that no edition's label book names (checked over every row, 2026-10-27): their text stays empty
UNLABELLED: dict[tuple[str, str], str] = {
    ("kepesertaan", "PSTV17"): "99 (edisi reguler)",
    ("kepesertaan", "PSTV04"): "9 (edisi tb)",
    ("fktpkapitasi", "FKP20"): "56 (semua edisi)",
    ("fkrtl", "FKL14"): "9 (edisi covid)",
    ("nonkapitasi", "PNK10"): "99",
}

# source columns the pipeline does not carry: each repeats the 3-character ICD-10 code of a column it keeps, as a
# labelled number or as "code name" text (checked over every row, 2026-10-26); the name comes from dim_icd10
NOT_CARRIED: dict[tuple[str, str], tuple[str, str]] = {
    ("fktpkapitasi", "FKP14"): ("FKP14A", "Angka berlabel (label = kode + nama diagnosis 3 karakter, mis. 780 = K40)."),
    ("fktpkapitasi", "FKP15"): ("FKP14A", "Di data isinya kode 3 karakter + nama, mis. \"K40 Inguinal hernia\", selalu diawali kode FKP14A."),
    ("fkrtl", "FKL15"): ("FKL15A", "Angka berlabel (label = kode + nama diagnosis masuk 3 karakter)."),
    ("fkrtl", "FKL17"): ("FKL17A", "Angka berlabel (label = kode + nama diagnosis primer 3 karakter)."),
    ("nonkapitasi", "PNK13"): ("PNK13A", "Angka berlabel (label = kode + nama diagnosis 3 karakter)."),
    ("diagnosissekunder", "FKL24B"): ("FKL24A", "Kode 3 karakter + nama, mis. \"Z37 Outcome of delivery\". Di edisi dm, kia_ibu dan kia_anak "
                                                "isinya tertukar dengan FKL24A: FKL24B berisi kodenya, FKL24A kode-nama."),
}


def _src_bpjs(file: str | None) -> str:
    return f"{DOC} · label variabel di file {file}" if file else f"{DOC} · label variabel file .dta"


SRC_ANON = ("Pernyataan BPJS saat merilis data sampel: data \"disusun dengan berpedoman pada perlindungan dan kerahasiaan data "
            "peserta/pasien\" (CNBC Indonesia & detikNews, 23 Des 2021). Pemeriksaan tim atas 34 file .dta: nomor peserta dan "
            "keluarga 2–9 digit, sedangkan nomor kartu JKN 13 digit. Akses data lewat PPID BPJS dengan pakta integritas. AI JKN Synthetic: semua baris "
            "dibangkitkan ulang oleh synthetic-gen; nomor peserta dan keluarga diganti nomor baru di luar nomor samaran BPJS "
            "(synthetic-gen/METODOLOGI.md).")
SRC_ABSENT = f"Pemeriksaan tim atas label variabel ke-34 file .dta {DOC}: tidak ada kolom nama, NIK, alamat, telepon atau ID/kode faskes"


def _src_pipeline(group: str) -> str:
    where = group.split("·", 1)[1].strip() if "·" in group else ""
    return f"Dihitung oleh pipeline (node {where})" if where and where not in ("kunci",) else "Dihitung oleh pipeline (tahap " + group.split("·")[0].strip() + ")"


def dictionary(catalog: dict | None = None) -> dict[str, dict]:
    """The data dictionary by column name. catalog: (tabel, code) → its label in the Stata files (katalog_*), or code →
    label. A code labelled differently in two tables (FKP02: the FKTP visit's own ID, the referral it came from in an
    FKRTL claim) is described in its own table, the other tables' labels in its note."""
    catalog = catalog or {}

    def entry(tabel: str, src: str):
        v = catalog.get((tabel, src)) or catalog.get(src)
        return v if isinstance(v, tuple) else (v, None)

    def lab(tabel: str, src: str) -> str | None:
        return entry(tabel, src)[0]

    def file_of(tabel: str, src: str) -> str | None:
        return entry(tabel, src)[1]

    out: dict[str, dict] = {}

    def put(name: str, label: str, note: str = "", group: str = "", source: str = "") -> None:
        if name in out:
            return
        e = {"label": label, "group": group}
        if note:
            e["note"] = note
        if source:
            e["source"] = source
        if name in ANON:
            e["anonymized"] = ANON[name]
        out[name] = e

    # the source codes: the label of the first table (SPEC order) that has one, every table's silver name
    seen: dict[str, list[tuple[str, str, str]]] = {}
    for tabel, rows in SPEC.items():
        for src, name, kind in rows:
            seen.setdefault(src, []).append((tabel, name, kind))
    for src, uses in seen.items():
        labelled = [(t, lab(t, src)) for t, _, _ in uses if lab(t, src)]
        tabel0 = labelled[0][0] if labelled else uses[0][0]
        label = labelled[0][1] if labelled else uses[0][1].replace("_", " ")
        kind = next(k for t, _, k in uses if t == tabel0)
        names = "; ".join(f"{SILVER_OF[t]}.{n}_kode + {SILVER_OF[t]}.{n}" if k == "label" else f"{SILVER_OF[t]}.{n}" for t, n, k in uses)
        others = [f"di {TABEL[t]}: \"{lb}\"" for t, lb in labelled[1:] if lb != label]
        note = f"Kode kolom asli ({KIND[kind]}). Di Data Bersih: {names}." + (f" Label berbeda {'; '.join(others)}." if others else "")
        put(src, label, note, f"Data Mentah · {TABEL[tabel0]}", _src_bpjs(file_of(tabel0, src)) if labelled else f"{DOC} · kolom tanpa label di file sumber")
    if "FKL24A" in out:  # checked over every row, 2026-10-27
        out["FKL24A"]["note"] += (" Di edisi dm, kia_ibu dan kia_anak isinya kode-nama (mis. \"I69-Sequelae of stroke…\", tertukar dengan FKL24B)"
                                  "; di semua edisi tiga karakter pertamanya adalah kode ICD-10-nya.")
    for (tabel, src), (kept, what) in NOT_CARRIED.items():
        name = next(n for s, n, _ in SPEC[tabel] if s == kept)
        put(src, lab(tabel, src) or src, f"{what} Tidak dibawa ke Data Bersih (dibuang board Select columns): kodenya sudah ada di {kept} "
            f"({SILVER_OF[tabel]}.{name}) dan nama diagnosisnya diambil dari dim_icd10.", f"Data Mentah · {TABEL[tabel]}", _src_bpjs(file_of(tabel, src)))
    # their Data Bersih names
    for tabel, rows in SPEC.items():
        g = f"Data Bersih · {SILVER_OF[tabel]}"
        for src, name, kind in rows:
            label = lab(tabel, src) or name.replace("_", " ")
            source = f"{_src_bpjs(file_of(tabel, src))} (kolom {src})"
            if kind == "label":
                put(f"{name}_kode", f"{label} — kode", f"Kode angka asli kolom {src}; teksnya di kolom {name} (dari buku label).", g, source)
                note = f"Teks dari label nilai kolom {src} di file BPJS (MISSING / TIDAK TERDEFINISI menjadi kosong)."
                if src in ("FKP05_NEW", "FKP16_NEW"):
                    note += " Edisi covid tidak punya label kolom ini: labelnya dipinjam dari edisi lain, yang sepakat untuk setiap kode (kode provinsi 38)."
                if (tabel, src) in UNLABELLED:
                    note += f" Kode tanpa label di file BPJS mana pun, jadi teksnya kosong: {UNLABELLED[(tabel, src)]}."
                put(name, label, note, g, source)
            else:
                note = f"Dari kolom asli {src} ({KIND[kind]})."
                if kind == "text" and src in REPAIR_COLS:
                    note += " Kata yang hilang 'go' di sumber dipulihkan (narthrosis → gonarthrosis …)."
                    put(f"flag_{name}_diperbaiki", f"{label}: nama dipulihkan", "Benar bila teks diagnosis diperbaiki dari sumber.", g,
                        "Dihitung oleh pipeline (node kunjungan_fkrtl_bersih, Find and replace)")
                if kind == "date" and src == "PSTV03":
                    note += " Sebagian bernilai pengganti 1900-07-01 (lihat flag_tgl_lahir_pengganti)."
                if kind == "icd3":
                    note += (" Tiga karakter pertamanya, dipakai bila berbentuk kategori ICD-10 (huruf, angka, angka/huruf); selain itu kosong "
                             "(mis. pengganti 9999). Diagnosis sekunder: di edisi dm, kia_ibu dan kia_anak kolom FKL24A berisi kode-nama "
                             "(tertukar dengan FKL24B), jadi kodenya diambil dari awal teks."
                             " Baris dengan kategori ICD-10 yang tidak ada di referensi dim_icd10 tetap disimpan (tanpa nama).")
                put(name, label, note, g, source)
    for name, (label, note, group) in DERIVED.items():
        put(name, label, note, group, _src_pipeline(group))
    for name, parts in KEYS.items():
        put(name, "Kunci baris objek Nexus", f"Gabungan {parts} (Concatenate).", "Siap Analisis · kunci", "Dihitung oleh pipeline (Concatenate di node outputnya)")
    put("faskes_profil_id", "ID profil faskes", "MD5 dari tingkat|kab/kota|kepemilikan|jenis|tipe.", "Profil faskes", "Dihitung oleh pipeline (Hash MD5 di node dim_profil_faskes dan klaim)")
    put("peserta_key", "Kunci peserta", "edisi:peserta_id.", "Siap Analisis · peserta_klaim_berisiko", "Dihitung oleh pipeline (node klaim_berisiko)")
    put(*NOT_IN_DATA[:2], NOT_IN_DATA[2], "Anonimisasi data sampel", SRC_ABSENT)
    out[NOT_IN_DATA[0]]["anonymized"] = "Tidak ada di data sama sekali."
    for name in ANON:
        if name in out and name not in ("faskes_profil_id", "peserta_key"):
            out[name]["anonymizedSource"] = SRC_ANON
    return out
