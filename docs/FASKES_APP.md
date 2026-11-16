# App Faskes: Binding IoT Pasien

`/faskes` ([web/src/app/faskes](../web/src/app/faskes)) adalah aplikasi HP untuk perawat di rumah sakit. Perawat mengikat
sensor IoT di alat medis ke pasien, supaya jam pemakaian alat tercatat sebagai bukti klaim. Format data sesinya mengikuti
[IOT_KONTRAK.md](IOT_KONTRAK.md).

Sensornya clamp arus di kabel daya alat (ventilator, NIV, mesin hemodialisis, syringe/infusion pump). Yang dicatat hanya
jam nyala dan mode alat, bukan tanda vital pasien.

## Alur

1. Perawat memindai gelang pasien dan QR sensor IoT ke satu **sesi scan**. Jumlah dan urutannya bebas.
2. Mesin pencocokan memasangkan setiap Device ID ke salah satu Patient ID di sesi itu.
3. Pasangan yang yakin (≥ 80%) langsung diikat. Pasangan 50–79% dan serah terima device menunggu konfirmasi perawat.
4. Setiap binding membuka sesi IoT (`sesi_id`, `device_id`, `peserta`, `kunjungan` = SEP, `mulai`) dan memunculkan
   notifikasi **Binding IoT sukses**.
5. Saat pasien pulang, semua sesinya ditutup sekaligus dan ringkasan pemakaian alat mengisi kolom durasi E-Klaim.

## Aturan pencocokan

Kode: [_lib/match.ts](../web/src/app/faskes/_lib/match.ts). Setiap pasangan membawa poin dan alasannya, dan keduanya
tampil di layar.

Aturan wajib. Pasangan yang melanggar salah satunya tidak pernah diusulkan:

- pasien punya order dokter untuk jenis alat itu;
- satu pasien hanya satu alat per jenis (tidak ada dua ventilator untuk satu pasien);
- satu device hanya untuk satu pasien pada satu waktu. Device yang masih terikat ke pasien lain perlu serah terima, dan
  serah terima selalu dikonfirmasi perawat.

Poin:

| Bukti | Poin |
|---|---|
| Order dokter cocok | 35 |
| Lokasi: bed sama | 55 |
| Lokasi: device cadangan di unit yang sama | 20 |
| Lokasi: bed lain di unit yang sama, bed itu tidak memakainya | 10 |
| Lokasi: bed lain yang pasiennya punya order alat yang sama | 0 |
| Device online, kunci perangkat aktif | 10 |

Device yang belum dapat pasangan diberi alasan. Contohnya "Gelang pasien ICU · Bed 4 belum dipindai di sesi ini".

## Peringatan

Kode: [_lib/peringatan.ts](../web/src/app/faskes/_lib/peringatan.ts). Tab Peringatan berisi hal yang perlu ditindak
sekarang, sebelum menjadi temuan saat klaim diaudit. Setiap peringatan mencerminkan satu pemeriksaan di mesin klaim
([api/aip/realtime/iot.py](../api/aip/realtime/iot.py)):

| Peringatan | Pemeriksaan di mesin |
|---|---|
| Device menyala tanpa pasien terikat | pemakaian tanpa pasien (`IOT_TANPA_PASIEN`) |
| Device terikat tetapi siaga/mati | ventilator ditagih padahal hanya siaga (`IOT_VENTILATOR_STANDBY`) |
| Device terikat tetapi offline | bacaan tertahan sampai gateway tersambung |
| Order alat tanpa device terikat | pemakaian ditagih tanpa jejak sensor (`IOT_TANPA_JEJAK`) |

Ventilator, NIV, dan mesin hemodialisis diurutkan paling atas.

## Pulang dan ringkasan E-Klaim

Kode: [_lib/ringkasan.ts](../web/src/app/faskes/_lib/ringkasan.ts). Tombol **Pulangkan pasien** perlu diketuk dua kali.
Tombol ini menutup semua sesi IoT pasien, lalu menampilkan:

- setiap sesi: device, jam mulai–selesai, durasi, dan mode yang dibaca sensor;
- isian E-Klaim dari data alat: `jam_ventilator`, `jam_niv`, `sesi_hemodialisis`.

Hanya jam saat alat **jalan** yang dihitung. Jam siaga ditampilkan terpisah dan tidak ikut dijumlahkan. Pasien yang sudah
pulang tidak bisa diikat lagi.

## Tab

| Tab | Isi |
|---|---|
| Binding | tombol Scan QR Pasien / Scan QR Device, input manual, binding otomatis, usulan yang perlu konfirmasi, sesi scan |
| Pasien | order alat setiap pasien dan device yang terikat; detail, scan ulang, pulangkan |
| Device | semua sensor (filter terikat/bebas/offline); data sesi IoT untuk klaim; lepas binding |
| Peringatan | daftar di atas |
| Notifikasi | binding sukses, binding dilepas, serah terima, pasien pulang |

## Menjalankan di HP

UI utama berjalan di port 9300. Supaya bisa diperbarui tanpa me-restart UI itu (dan audit cabang yang mungkin sedang
berjalan di bawahnya), app ini bisa dilayani server terpisah di port 9310:

```powershell
cd web
$env:BLUESANDAI_NEXT_DIST = '.next-hp'; npm run build
cmd /c "set BLUESANDAI_NEXT_DIST=.next-hp&& npx next start -p 9310"
```

Buka `http://<IP-PC>:9310/faskes` dari HP yang satu jaringan dengan PC. `/faskes` tidak perlu login: datanya ada di
halaman itu sendiri dan halaman ini tidak memanggil API.

## Batasan saat ini

- **Scan masih simulasi.** Scan memutar rekaman kamera ([web/public/faskes](../web/public/faskes)). Rekaman itu selalu
  menampilkan P-87345 dan IOT-DEV-001; scan berikutnya membaca ID berikutnya. Kamera asli butuh HTTPS atau aplikasi
  Android.
- **Data contoh di dalam kode.** Pasien dan device contoh ada di [_lib/data.ts](../web/src/app/faskes/_lib/data.ts).
- **Belum terhubung ke API.** Binding dan notifikasi tersimpan di `localStorage` HP, belum dikirim ke
  `/api/aip/realtime`.

## Rencana

- Scan nomor seri implan dan alkes mahal (bukti top-up special CMG).
- Bukti mulai dan selesai sesi untuk hemodialisis, kemoterapi, dan fisioterapi.
- Registrasi sensor ke alat: tag aset, lokasi, aktivasi dan pencabutan kunci.
- Segel (hash) bukti saat pasien pulang, lalu kirim sesi ke mesin klaim.
