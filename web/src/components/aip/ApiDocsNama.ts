// API Documentation · plain Indonesian names for the national API's endpoints (the running API's spec names them in English:
// "Ingest Faskes", "Al Ssl Train", ...) and the resource each one belongs to in the reference sidebar. Keyed by method and the
// path after /api/aip/. Each line: [nama, keterangan]; the description is read from the handler's docstring and route notes
// (api/aip/realtime/routes.py, konsultan.py, layanan.py, ml.py). An endpoint missing here keeps the spec's own summary.

import type { IconName } from "@/components/Icon";

export const NAMA_NASIONAL: Record<string, [string, string]> = {
  // Integrasi faskes
  "POST realtime/v1/faskes/precheck": ["Pra-cek draf klaim", "Sebelum dikirim: dokumen yang akan dicari verifikator pada draf ini, dan konflik dengan kiriman RS sebelumnya."],
  "POST realtime/v1/faskes/klaim": ["Kirim klaim rumah sakit", "Kiriman SIMRS: pasien dicocokkan, klaim dipetakan ke kontrak lalu diantrekan. RS mendapat tanda terima; skor dan keputusan tetap di BPJS."],
  "POST realtime/v1/faskes/permintaan": ["Status klaim & permintaan dokumen", "Status proses klaim SIMRS (tidak pernah keputusannya) dan permintaan dokumen dari auditor."],
  "POST realtime/v1/faskes/permintaan/{rid}/balas": ["Balas permintaan dokumen", "RS menjawab permintaan dokumen auditor: pesan dan butir yang diminta."],
  "POST realtime/v1/faskes/rme/validasi": ["Validasi rekam medis (RME)", "RS memeriksa Bundle SATUSEHAT terhadap kontrak sebelum mengirim klaim: apa yang terbaca dan apa yang kurang."],
  "POST realtime/v1/faskes/iot/validasi": ["Validasi payload alat (IoT)", "RS memeriksa payload alat ({sesi, jangkar, alat}) terhadap kontrak sebelum mengirim klaim."],
  "POST realtime/v1/klaim": ["Kirim klaim ke engine", "Klaim dalam kontrak platform (KlaimIn), dengan sesi atau token pribadi; ?tunggu=1 menunggu keputusannya."],
  "POST realtime/v1/fktp": ["Kirim kunjungan FKTP", "Kunjungan FKTP (kapitasi) dalam kontrak silver."],
  "POST realtime/v1/nonkapitasi": ["Kirim klaim non-kapitasi", "Klaim non-kapitasi dalam kontrak silver."],
  // Engine realtime
  "GET realtime/v1/status": ["Status engine", "Engine, throughput, latensi, keputusan, kasus, sumber dan integrasi."],
  "POST realtime/v1/mesin": ["Atur engine", "Nyalakan / matikan engine dan ubah ambangnya (admin)."],
  "GET realtime/v1/modus": ["Daftar modus fraud", "20 modus Permenkes 16/2019 seperti yang dideteksi engine, dengan alert dan hasil skenario tanam."],
  "GET realtime/v1/bobot": ["Bobot sinyal", "Bobot tiap sinyal engine dan usulan bobot dari kasus yang sudah diputus."],
  "POST realtime/v1/bobot/terapkan": ["Terapkan bobot usulan", "Bobot usulan dari kasus yang diputus dipakai engine (admin)."],
  "POST realtime/v1/bobot/bawaan": ["Kembalikan bobot bawaan", "Bobot sinyal kembali ke bawaan (admin)."],
  "GET realtime/v1/label": ["Unduh label kasus (CSV)", "Peristiwa dari kasus yang sudah diputus, sebagai baris berlabel (CSV) untuk melatih ulang."],
  "GET realtime/v1/umpan": ["Umpan keputusan", "Keputusan setelah nomor urut tertentu (?sejak=): umpan langsung."],
  "GET realtime/v1/evaluasi": ["Evaluasi engine", "Keputusan engine dibanding kebenaran skenario tanam dan label verifikator."],
  "POST realtime/v1/simulator": ["Atur simulator", "Mulai / berhenti / reset putar ulang klaim (admin)."],
  "POST realtime/v1/simulator/tanam": ["Tanam skenario", "Tanam satu skenario fraud sekarang (admin)."],
  "GET realtime/v1/sumber": ["Daftar sumber terhubung", "Registri rumah sakit yang terhubung."],
  "PUT realtime/v1/sumber/{sid}": ["Ubah sumber", "Ubah satu sumber di registri (admin)."],
  "POST realtime/v1/token": ["Buat token ingest", "Token ingest baru untuk SIMRS, ditampilkan sekali (admin)."],
  "POST realtime/v1/box": ["Bangun ulang Box Karantina", "Box Karantina dibangun ulang dari tag saat ini (admin)."],
  "POST realtime/v1/reset": ["Reset aliran", "Keputusan, kasus dan graf aliran dihapus; tag detektor opsional (admin)."],
  // Kasus & peristiwa
  "GET realtime/v1/peristiwa/{eid}": ["Detail keputusan", "Satu keputusan dengan setiap sinyal, mitigasinya, dan alasan model."],
  "GET realtime/v1/peristiwa/{eid}/permintaan": ["Permintaan dokumen per keputusan", "Tampilan auditor: asal peristiwa (SIMRS atau bukan), permintaan yang terkirim beserta balasannya, dan draf permintaan."],
  "POST realtime/v1/peristiwa/{eid}/permintaan": ["Kirim permintaan dokumen", "Auditor meminta dokumen ke SIMRS rumah sakit untuk satu keputusan (admin)."],
  "GET realtime/v1/kasus": ["Daftar kasus", "Kasus menurut prioritas."],
  "GET realtime/v1/kasus/{cid}": ["Detail kasus", "Satu kasus: klaimnya, entitasnya, dan jaringan di sekitarnya."],
  "GET realtime/v1/kasus/{cid}/ringkasan": ["Ringkasan kasus", "Ringkasan satu kasus untuk auditor."],
  "POST realtime/v1/kasus/{cid}/keputusan": ["Putuskan kasus", "telaah / konfirmasi / false_positive / buka (admin): menentukan tag kasus di buku besar."],
  "GET realtime/v1/graf": ["Graf entitas", "Jaringan di sekitar satu entitas (?jenis=&kunci=)."],
  "GET realtime/v1/jaringan": ["Jaringan abnormal", "Pasangan faskes yang abnormal dan cincin (ring)."],
  "GET realtime/v1/entitas/{eid}": ["Detail entitas", "Pasien yang diresolusi dari kiriman rumah sakit."],
  // Kontrak data
  "GET realtime/v1/rme/skema": ["Kontrak rekam medis", "Kontrak rekam medis: Bundle yang diterima sebagai JSON Schema, dan pengetahuan klinis yang dipakai cek silang."],
  "GET realtime/v1/iot/skema": ["Kontrak bukti alat (IoT)", "Kontrak bukti alat: jenis dan mode alat, ambang, daun Merkle, dan sinyal IOT_*."],
  // Active learning
  "GET realtime/v1/al": ["Status active learning", "Model SSL, model juara, label per sumber, dan simulasi terakhir."],
  "POST realtime/v1/al/ssl/latih": ["Latih awal SSL", "Pretraining autoencoder bertopeng pada klaim tanpa label sebelum jendela (admin)."],
  "GET realtime/v1/al/antrean": ["Antrean label", "Peristiwa berikutnya untuk dilabeli, per strategi, masing-masing dengan alasan terpilih."],
  "POST realtime/v1/al/label": ["Beri label peristiwa", "Label dari manusia untuk satu peristiwa (admin)."],
  "POST realtime/v1/al/latih": ["Latih penantang", "Model penantang dari label; dipromosikan lewat gerbang (admin)."],
  "POST realtime/v1/al/mode": ["Atur mode active learning", "bayangan / aktif / mati (admin)."],
  "POST realtime/v1/al/simulasi": ["Jalankan simulasi AL", "Kurva belajar dengan oracle simulator (admin)."],
  "GET realtime/v1/al/simulasi": ["Hasil simulasi AL", "Hasil simulasi active learning terakhir."],
  "POST realtime/v1/al/simulasi/promosikan": ["Promosikan hasil simulasi", "Komite terbaik simulasi lewat gerbang, ditandai berlabel oracle (admin)."],
  // Buku besar cabang
  "POST realtime/v1/cabang/tag": ["Tulis antrean run ke buku besar", "Antrean satu run cabang menjadi tag di buku besar (admin)."],
  "GET realtime/v1/cabang/tag/{run}": ["Isi run di buku besar", "Ringkasan tag satu run cabang di buku besar."],
  "POST realtime/v1/cabang/putusan": ["Catat putusan verifikator", "Putusan verifikator cabang menjadi tag klaim di buku besar (pengguna yang masuk)."],
  // Rule engine
  "GET realtime/v1/aturan/katalog": ["Katalog aturan", "Aturan bawaan dan aturan pengguna beserta statusnya."],
  "GET realtime/v1/aturan": ["Daftar aturan", "Aturan buatan pengguna."],
  "POST realtime/v1/aturan": ["Buat aturan", "Aturan baru sebagai draf: kondisi, bobot dan modus."],
  "GET realtime/v1/aturan/log": ["Log perubahan aturan", "Riwayat setiap perubahan aturan."],
  "POST realtime/v1/aturan/validasi": ["Validasi kondisi aturan", "Memeriksa kondisi aturan sebelum disimpan."],
  "POST realtime/v1/aturan/ai/draf": ["Draf aturan dengan AI", "Model AI menyusun draf aturan dari uraian bahasa biasa."],
  "POST realtime/v1/aturan/ai/edit": ["Ubah aturan dengan AI", "Model AI mengubah aturan yang ada sesuai instruksi."],
  "POST realtime/v1/aturan/ai/perbaiki": ["Perbaiki aturan dengan AI", "Model AI memperbaiki aturan yang gagal validasi atau uji."],
  "POST realtime/v1/aturan/bawaan/{kode}": ["Ubah aturan bawaan", "Perubahan tertunda pada aturan bawaan (bobot / nyala-mati)."],
  "POST realtime/v1/aturan/bawaan/{kode}/uji": ["Uji aturan bawaan", "Backtest perubahan aturan bawaan."],
  "POST realtime/v1/aturan/bawaan/{kode}/ajukan": ["Ajukan aturan bawaan", "Ajukan perubahan aturan bawaan untuk disetujui."],
  "POST realtime/v1/aturan/bawaan/{kode}/setujui": ["Setujui aturan bawaan", "Setujui perubahan aturan bawaan (admin)."],
  "POST realtime/v1/aturan/bawaan/{kode}/tolak": ["Tolak aturan bawaan", "Tolak perubahan aturan bawaan (admin)."],
  "POST realtime/v1/aturan/bawaan/{kode}/nonaktifkan": ["Nonaktifkan aturan bawaan", "Matikan aturan bawaan (admin)."],
  "POST realtime/v1/aturan/bawaan/{kode}/rollback": ["Kembalikan aturan bawaan", "Kembali ke versi aturan bawaan sebelumnya (admin)."],
  "GET realtime/v1/aturan/{rid}": ["Detail aturan", "Satu aturan pengguna dengan versinya."],
  "PUT realtime/v1/aturan/{rid}": ["Ubah aturan", "Ubah draf aturan pengguna."],
  "POST realtime/v1/aturan/{rid}/uji": ["Uji aturan", "Backtest aturan pada klaim yang ada."],
  "POST realtime/v1/aturan/{rid}/ajukan": ["Ajukan aturan", "Ajukan aturan untuk disetujui."],
  "POST realtime/v1/aturan/{rid}/setujui": ["Setujui aturan", "Setujui aturan; aturan aktif di engine (admin)."],
  "POST realtime/v1/aturan/{rid}/tolak": ["Tolak aturan", "Tolak aturan yang diajukan (admin)."],
  "POST realtime/v1/aturan/{rid}/nonaktifkan": ["Nonaktifkan aturan", "Matikan aturan yang aktif (admin)."],
  "POST realtime/v1/aturan/{rid}/rollback": ["Kembalikan aturan", "Kembali ke versi aturan sebelumnya (admin)."],
  // AI Agent Swarm
  "POST konsultan": ["Mulai penugasan", "Satu penugasan AI Agent Swarm, hingga satu jam (admin: menulis tag dan Box Karantina, dan memakai biaya Model AI setiap agen)."],
  "GET konsultan/runs": ["Daftar penugasan", "Penugasan AI Agent Swarm, terbaru dulu."],
  "GET konsultan/terakhir": ["Penugasan terakhir", "Penugasan terakhir yang selesai di platform: analisis yang dipakai chat."],
  "DELETE konsultan/{run_id}": ["Hapus penugasan", "Penugasan diturunkan dari daftar; jejaknya dipindah dan bisa dipulihkan admin. Tag dan box yang ditulis tetap (admin)."],
  "POST konsultan/{run_id}/laporan": ["Tulis ulang laporan", "Laporan penugasan yang selesai ditulis ulang sebagai penugasan baru; fase 0–5 disalin, tidak dijalankan lagi (admin)."],
  "GET konsultan/tim": ["Tim agen", "Agen-agen AI Agent Swarm dan perannya."],
  "GET konsultan/sistem": ["Peta sistem", "Setiap lapis sistem fraud sekilas: data, pipeline, model, agen, buku besar, box, gerbang manusia, tangga bukti."],
  "GET konsultan/v3": ["Status Blu 3.0", "Profil data di tipe Nexus dan ringkasan skoring v3 yang menjadi titik awal penugasan."],
  "GET konsultan/v3/lingkup": ["Lingkup baca Blu 3.0", "Id klaim Klaim Berisiko dan sampel kontrol klaim lainnya: batas baca para agen."],
  "GET konsultan/sumber": ["Cek sumber data", "Kesiapan sumber data untuk penugasan."],
  "GET konsultan/konfigurasi": ["Konfigurasi proyek", "Pilihan di formulir proyek: sumber data dan kesiapannya, tiap kursi model beserta pilihan model, batas agen."],
  "GET konsultan/simulasi": ["Simulasi penugasan", "Penugasan sebagai animasi saja, tanpa memanggil Model AI."],
  "GET konsultan/proyek": ["Daftar proyek", "Proyek AI Agent Swarm."],
  "POST konsultan/proyek": ["Buat proyek", "Proyek baru dengan pengaturannya (admin)."],
  "PUT konsultan/proyek/{pid}": ["Ubah proyek", "Pengaturan proyek diubah; penugasan berikutnya memakainya (admin)."],
  "DELETE konsultan/proyek/{pid}": ["Hapus proyek", "Proyek diturunkan dari daftar bersama penugasannya; ditolak saat satu sedang berjalan (admin)."],
  "GET konsultan/{run_id}/laporan-lengkap": ["Laporan lengkap", "Bab laporan dengan exhibit bernomor yang dihitung dari hasil penugasan, dan komentarnya."],
  "POST konsultan/{run_id}/laporan-lengkap/narasi": ["Tulis narasi exhibit", "Komentar Model AI untuk tiap exhibit, sekali per penugasan; setiap angka dicek kode (admin: memakai biaya)."],
  "GET konsultan/{run_id}/laporan-lengkap/jejak": ["Jejak data klaim", "Satu klaim dari berkas BPJS sampai angka di berkas kasus: bronze, silver, gold, inferensi ML, indikasi, aturan Box."],
  "GET konsultan/{run_id}/laporan-lengkap/pdf": ["Unduh laporan (PDF)", "Laporan lengkap sebagai PDF A4, setiap berkas kasus terbuka, sesuai hak baca peminta."],
  "POST konsultan/{run_id}/laporan-lengkap/bekukan": ["Bekukan laporan", "Exhibit dan berkas kasus dibekukan seperti saat penugasan selesai."],
  "POST konsultan/{run_id}/laporan-lengkap/narasi-agen": ["Simpan narasi agen", "Komentar analis exhibit selama penugasan berjalan; kalimat yang angkanya tidak didukung fakta dibuang."],
  // Skor & verifikasi
  "POST fraud/v1/skor": ["Skor klaim", "Skor fraud satu klaim dari model yang terpasang."],
  "POST fraud/v1/batch": ["Skor banyak klaim", "Banyak klaim di latar belakang (job asinkron): pantau dengan GET /batch/{id}."],
  "GET fraud/v1/batch/{bid}": ["Status batch skor", "Progres dan hasil satu batch skor."],
  "GET fraud/v1/sehat": ["Kesehatan layanan", "Status layanan skor dan model yang terpasang."],
  "GET fraud/v1/kontrak": ["Kontrak data klaim", "Kontrak isian klaim yang diterima layanan skor."],
  "POST fraud/v1/verify": ["Verifikasi satu klaim", "Satu klaim lewat pipeline inferensi: divalidasi, dihitung fiturnya, diskor model, ditelaah klinis oleh Model AI; dijawab {status, fraud_probability, ai_reasoning}."],
  "POST fraud/v1/verify/klaim": ["Verifikasi klaim tersimpan", "Klaim dari data (berdasarkan klaim_id) lewat pipeline yang sama."],
  "POST fraud/v1/verify/csv": ["Verifikasi berkas CSV", "CSV klaim, satu per baris, masing-masing lewat /verify di latar belakang: pantau GET /verify/batch/{id}."],
  "GET fraud/v1/verify/csv/templat": ["Templat CSV verifikasi", "Kolom CSV untuk verifikasi; ?contoh=true: tujuh klaim contoh (dibangun, bukan data BPJS)."],
  "GET fraud/v1/verify/batch": ["Daftar batch verifikasi", "Batch verifikasi milik pemanggil, terbaru dulu."],
  "POST fraud/v1/verify/batch": ["Verifikasi banyak klaim", "Daftar klaim JSON lewat /verify di latar belakang: pantau GET /verify/batch/{id}."],
  "GET fraud/v1/verify/batch/{bid}": ["Status batch verifikasi", "Progres batch dan satu halaman klaimnya (INDIKASI_KUAT, PERLU_DIPERIKSA, WAJAR, DITOLAK, GALAT)."],
  "GET fraud/v1/verify/batch/{bid}/baris/{no}": ["Satu baris batch", "Satu klaim batch: input dan seluruh jawaban /verify-nya."],
  "GET fraud/v1/verify/batch/{bid}/unduh": ["Unduh hasil batch (CSV)", "Hasil sebagai CSV: kolom input, lalu status, fraud_probability, ai_reasoning dan rinciannya."],
  "POST fraud/v1/verify/batch/{bid}/batal": ["Hentikan batch", "Klaim yang sudah di pipeline selesai, sisanya tidak dikirim."],
  // ML Studio
  "GET ml": ["Kartu model", "Kartu model yang terpasang (butuh akses baca klaim silver)."],
  "POST ml/train": ["Latih model", "Latih ulang model ML (admin)."],
  "POST ml/benchmark": ["Jalankan benchmark", "Benchmark teknik ML sebagai job."],
  "POST ml/bandingkan": ["Bandingkan teknik", "Teknik dari job terpisah dibandingkan sebagai satu papan peringkat."],
  "POST ml/bukti": ["Buat kartu bukti", "Kartu bukti (kit evaluasi eksternal) untuk model saat ini (admin)."],
  "GET ml/bukti/{name}": ["Ambil berkas bukti", "Satu berkas bukti versi saat ini; kunci review hanya untuk admin."],
  "POST ml/aturan2": ["Jalankan benchmark aturan 2", "Benchmark aturan 2 kit evaluasi: fraud ditanam, tiga dial, tipe ditahan (admin, sekitar satu jam)."],
  "GET ml/aturan2/{name}": ["Ambil berkas aturan 2", "Ringkasan, atau kartu bukti satu kondisi."],
  "GET ml/tangga": ["Tangga bukti", "Setiap jenis bukti yang dimiliki atau direncanakan tim, apa yang didukung dan apa yang tidak ditunjukkannya."],
  "GET ml/jobs/{jid}": ["Status job ML", "Progres dan hasil satu job ML."],
  "POST ml/klaim": ["Klaim berisiko", "Klaim dalam cakupan diurutkan menurut risiko model, dengan ambang per segmen."],
  "POST ml/faskes": ["Faskes berisiko", "Faskes dalam cakupan diurutkan menurut ekspektasi koreksi atau risiko."],
  "POST ml/jelaskan": ["Jelaskan klaim", "Satu klaim dijelaskan oleh tiap metode, dengan risiko model dan nilai di balik fitur teratas."],
};

export type ResNasional = { key: string; nama: string; ket: string; ikon: IconName };

/** the national API's resources, in sidebar order */
export const RES_NASIONAL: ResNasional[] = [
  { key: "faskes", nama: "Integrasi faskes", ket: "SIMRS rumah sakit mengirim klaim dengan token faskes, pra-cek draf, dan menjawab permintaan dokumen", ikon: "server" },
  { key: "engine", nama: "Engine realtime", ket: "status, ambang, bobot sinyal, simulator, registri sumber dan token ingest", ikon: "bolt" },
  { key: "kasus", nama: "Kasus & peristiwa", ket: "keputusan per klaim, kasus menurut prioritas, graf dan jaringan entitas", ikon: "eye" },
  { key: "kontrak", nama: "Kontrak data", ket: "skema rekam medis (SATUSEHAT) dan bukti alat (IoT)", ikon: "doc" },
  { key: "al", nama: "Active learning", ket: "antrean label, pelatihan penantang, simulasi dan promosi lewat gerbang", ikon: "refresh" },
  { key: "aturan", nama: "Rule engine", ket: "aturan pengguna: buat, uji, ajukan, setujui, nonaktifkan, rollback", ikon: "logic" },
  { key: "bawaan", nama: "Aturan bawaan", ket: "perubahan bobot / nyala-mati aturan bawaan dengan backtest dan persetujuan", ikon: "sliders" },
  { key: "aturan-ai", nama: "Asisten aturan AI", ket: "draf, ubah dan perbaiki aturan dengan Model AI", ikon: "sparkle" },
  { key: "swarm", nama: "AI Agent Swarm", ket: "penugasan, tim agen, peta sistem dan lingkup baca", ikon: "graph" },
  { key: "proyek", nama: "Proyek swarm", ket: "proyek dan pengaturan kursi model", ikon: "folder" },
  { key: "laporan", nama: "Laporan lengkap", ket: "bab dan exhibit, narasi, jejak data, PDF dan pembekuan", ikon: "doc" },
  { key: "verifikasi", nama: "Skor & verifikasi", ket: "skor satu klaim atau batch, verifikasi klaim dengan telaah klinis Model AI", ikon: "check" },
  { key: "ml", nama: "ML Studio", ket: "kartu model, pelatihan, benchmark, bukti evaluasi dan penjelasan klaim", ikon: "cpu" },
  { key: "cabang", nama: "Buku besar cabang", ket: "antrean run cabang dan putusan verifikator ke buku besar indikasi", ikon: "database" },
];

/** the resource of a national endpoint, from its spec group and path */
export function resNasional(grup: string, path: string): string {
  const p = path.replace(/^\/api\/aip\//, "");
  if (grup === "faskes") return "faskes";
  if (grup === "rule") return p.includes("/aturan/bawaan/") ? "bawaan" : p.includes("/aturan/ai/") ? "aturan-ai" : "aturan";
  if (grup === "konsultan") return p.includes("/proyek") ? "proyek" : p.includes("/laporan-lengkap") ? "laporan" : "swarm";
  if (grup === "fraud") return p.startsWith("ml") ? "ml" : "verifikasi";
  if (/^realtime\/v1\/(peristiwa|kasus|graf|jaringan|entitas)/.test(p)) return "kasus";
  if (/^realtime\/v1\/(rme|iot)\/skema/.test(p)) return "kontrak";
  if (/^realtime\/v1\/al(\/|$)/.test(p)) return "al";
  if (/^realtime\/v1\/cabang\//.test(p)) return "cabang";
  return "engine";
}
