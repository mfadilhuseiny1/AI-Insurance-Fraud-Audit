# Format masukan IoT alat medis (AI Agent Swarm Branch)

Satu folder per run/KC. Dibaca oleh pemeriksa `testing/iot_cabang.py periksa` (fungsi `periksa(set_name, iot_dir, kc=None)`);
folder sintetis dibuat oleh `generate(set_name, out_dir=None, kc=None, seed=20261115)`. Format: `iot-cabang/1`. Waktu dalam WIB
(UTC+7), `YYYY-MM-DDTHH:MM`.

Sensor = **sensor clamp pada kabel daya (tanpa membuka alat)**. Sensor hanya mencatat kapan alat menyala, berapa lama, dan statusnya
(jalan / siaga / mati) dari besar arus. Sensor ini tidak dapat membedakan ventilasi lewat pipa napas dari ventilasi dengan masker,
jadi format ini tidak memakai pembedaan itu. **Tidak ada data pasien** (tidak ada SpO2, tekanan darah, tanda vital). Kunci jawaban (`kunci_benar.json`) tidak pernah
diletakkan di folder ini dan tidak pernah dibaca pemeriksa.

| berkas | wajib | isi |
|---|---|---|
| `alat.csv` atau `.json` | ya | daftar alat dan gateway |
| `sesi.csv` atau `.json` | ya | ikatan alat ↔ pasien ↔ kunjungan (binding) |
| `pembacaan.parquet` atau `.csv` | ya | pembacaan sensor |
| `jangkar.json` | ya | Merkle root per kunjungan yang dijangkarkan ke ledger |
| `klaim_alat.json` | tidak | isian E-Klaim tentang pemakaian alat yang tidak ada di tabel klaim run |
| `manifest.json` | tidak | run, KC, periode, jendela pengamatan, `sintetis` |

## alat
`device_id, jenis, nama, faskes_profil_id, rs, sensor, kunci_publik, dipasang, dicabut_pada`

`jenis`: `ventilator`, `hemodialisis`, `monitor_icu`, `pompa_infus`, `gateway` (satu per RS; mengirim *heartbeat*).
`dicabut_pada` kosong = kunci aktif; pembacaan setelah waktu itu tidak sah.

```
VNT-7371-02,ventilator,Ventilator ICU,e35c8ceddf47a8406f7b53741a64e42c,RS Swasta Setara Type B · Swasta · Kota Makassar,sensor clamp pada kabel daya (tanpa membuka alat): waktu nyala & status jalan/siaga/mati,ed25519:…,2024-11-18T00:00,
```

## sesi (binding)
`sesi_id, device_id, peserta, kunjungan, replika, mulai, selesai, alasan_selesai`

Satu alat hanya boleh terikat ke satu pasien pada satu waktu. `kunjungan` = nomor kunjungan/SEP klaim (`kunjungan_fkrtl_id`); pada
run gen3 yang tidak punya nomor kunjungan, kunci klaim run `<set>:<chunk>:<baris>`. `alasan_selesai`: `dilepas`, `pulang`, `pindah`
(kosong bila sesi masih berjalan). `replika` opsional (0), untuk dataset tema berulang.

```
S-7371-00016,VNT-7373-01,135053835,gen3_kc2:0:1115,0,2024-12-21T08:46,2024-12-23T10:01,dilepas
```

## pembacaan
`ts, device_id, sesi_id, seq, interval_s, arus_a, mode, replika, reading_hash`

`sesi_id` kosong = alat menyala tanpa pasien terikat. `seq` naik per alat termasuk pembacaan yang hilang, jadi celah `seq` = data
hilang (dihitung menguntungkan klaim). `mode` hasil klasifikasi di gateway dari besar arus: ventilator `jalan|siaga|mati` (jalan = memberi
napas, siaga = menyala tanpa memberi napas), hemodialisis `jalan|idle|mati`, monitor ICU `nyala|mati`, pompa infus `jalan|idle|mati`,
gateway `online`; bila kosong, pemeriksa mengklasifikasi dari `arus_a`. `reading_hash` = sha256 dari
`device_id|sesi_id|ts|seq|interval_s|arus_a(2 desimal)|mode`.

Folder lama (sebelum 2026-11-15) dengan mode ventilator `invasif|noninvasif|standby` tetap dibaca: hash dan jangkar diperiksa atas
nilai aslinya, lalu `invasif`/`noninvasif` dibaca `jalan` dan `standby` dibaca `siaga`.

```
2024-12-23T12:20,HDM-7306-01,S-7371-00027,134,300,0.40,idle,0,d296989f36ee588495e59abcd2f3360d523f435f301f6fee5d11bc2d41a7553b
```

## jangkar
`{"ledger": "sha256-merkle/1", "jangkar": [{episode_id, kunjungan, replika, sesi, merkle_root, skema, sesi_mesin, merkle_root_pembacaan, jumlah_daun,
jumlah_pembacaan, waktu, tx}]}`

Dua akar per kunjungan, keduanya harus cocok:
- `merkle_root` (`skema: "akar_sesi"`): skema mesin realtime (`api/aip/realtime/iot.py` `akar_sesi` / `hash_daun`), 64 heksadesimal.
  Daunnya rekaman sesi mesin: satu rekaman per rentang mode yang dipotong dari pembacaan (`sesi_id#n, device_id, peserta, kunjungan,
  mulai, selesai, mode`; mode `mati` dibuang; ikatan tanpa pembacaan karena alat sedang dipakai pasien lain = satu rekaman sepanjang
  ikatan). Pemeriksa memotong pembacaan dengan cara yang sama (`iot_cabang.potong_segmen` + `rekaman_mesin`) lalu mengirimnya ke
  `periksa_iot` bersama jangkar ini. Jangkar multi-pasien dapat memakai `iot.bukti_inklusi`; jangkar sintetis di sini per kunjungan.
- `merkle_root_pembacaan`: `reading_hash` semua pembacaan sesi-sesinya (urut `ts, device_id, seq`) lalu sha256 tiap peristiwa ikatan
  per sesi (urut `sesi_id`): `BIND|sesi_id|device_id|peserta|kunjungan|mulai` dan `UNBIND|sesi_id|selesai|alasan_selesai`; Merkle
  sha256 berpasangan terurut (skema synthetic-iomt). Mengunci setiap pembacaan, bukan hanya rentang mode.

`waktu` harus sebelum klaim diajukan; `tx` = id transaksi ledger.

```json
{"episode_id": "EP-62EBED9538", "kunjungan": "gen3_kc2:0:1115", "replika": 0, "sesi": ["S-7371-00014", "S-7371-00015", "S-7371-00016"],
 "merkle_root": "395c4606…", "skema": "akar_sesi", "sesi_mesin": 16, "merkle_root_pembacaan": "0x6b0f11df…", "jumlah_daun": 957, "jumlah_pembacaan": 951,
 "waktu": "2024-12-23T11:26", "tx": "0xa8226ef8…", "ledger": "sha256-merkle/1"}
```

## klaim_alat (opsional)
`{"klaim": [{kunci, kunjungan, replika, peserta, faskes_profil_id, masuk, pulang, diajukan, prosedur, jam_ventilator, hari_icu, sesi_hd,
inacbg?, tarif_rp?, biaya_rp?, inacbg_tanpa_ventilasi?, tarif_tanpa_ventilasi_rp?, klaim_asli?, sumber}]}`

Yang ditagih klaim untuk pemakaian alat (prosedur ICD-9-CM 96.70/96.71/96.72/93.90/39.95, jam ventilator, hari ICU, sesi HD) dan waktu
masuk/pulang/pengajuan. Tanpa berkas ini pemeriksa memakai kode klaim (J-1-02 → 96.72, N-3-15-0 → 1 sesi HD) dan prosedur dataset
tema bila ada. `inacbg`/`tarif_rp`/`klaim_asli` hanya untuk klaim yang **ditagih ulang oleh lapisan sintetis** (run gen3: ventilasi
ditambahkan); `klaim_asli` menyimpan kode dan tarif asli run.

```json
{"kunci": "gen3_kc2:0:1115", "kunjungan": "gen3_kc2:0:1115", "peserta": "135053835", "masuk": "2024-12-21T06:00", "pulang": "2024-12-23T14:30",
 "diajukan": "2024-12-26", "prosedur": ["96.71"], "jam_ventilator": 48.0, "hari_icu": 3, "inacbg": "J-1-20-II", "tarif_rp": 19689800,
 "inacbg_tanpa_ventilasi": "A-4-13-I", "tarif_tanpa_ventilasi_rp": 2055500, "klaim_asli": {"inacbg": "A-4-13-I", "tarif_rp": 2055500}, "sumber": "tambahan_sintetis"}
```

## Keluaran pemeriksa (`data/aip/cabang/iot/<set>/`)
`bukti.json` (per klaim: hasil `sesuai|tidak_sesuai|tanpa_bukti`, aturan, ditagih vs terukur, `harian`, `sesi`, tarif dan selisih,
rantai jangkar; `terukur.mode_jam` ventilator = `{jalan, siaga}`, `terukur.jam_berturut_maks` = rangkaian `jalan` terpanjang tanpa putus), `alat.json`, `ringkasan.json` (termasuk tabel tarif ventilasi ≥ 96 jam vs < 96 jam per RS) dan `monitoring.json`
(dasbor IoT Monitoring). `testing/laporan_cabang.py` membaca `bukti.json` bila ada.

Aturan: `vent_run_96` (96.72 ditagih, ventilator tidak pernah jalan 96 jam tanpa putus), `vent_standby` (ventilasi ditagih, ventilator
hanya siaga), `vent_hours`, `binding_tumpang`, `no_device_trace`, `hd_short`, `hd_phantom`, `icu_days`, `anchor_mismatch`,
`faskes_offline`; peringatan saja: `jangkar_terlambat`, `kunci_dicabut`, `tanpa_pasien`, `offline`. Gateway offline tidak pernah menjadi
tuduhan: hasilnya `tanpa_bukti` (perlu klarifikasi). 12 pasien fraud tanam dunia sintetis, semuanya dengan alat yang benar-benar
dinyalakan tetapi jamnya tidak sesuai tagihan (tidak ada kasus tanam dengan 0 jam): 6 `vent_run_96` (38, 52, 63, 71, 88, 94 jam),
2 `vent_sebagian` (ventilator jalan 5 jam lalu siaga, ditagih 96.72 → aturan `vent_run_96`; jalan 8 jam lalu siaga, ditagih ~45 jam
96.71 → `vent_hours`), 1 `binding_tumpang` (ventilator pasien sendiri jalan 5–8 jam, sisanya ditagih memakai alat yang sedang terikat
ke pasien lain), 1 `icu_days`, 2 `hd_short` (95 dan 70 menit). Aturan `vent_standby` dan `no_device_trace` tetap ada di pemeriksa untuk
data nyata, tanpa kasus tanam. `binding_tumpang` menyala pada irisan sesi apa pun dengan pasien lain (sama dengan engine realtime).

```
.venv/Scripts/python.exe testing/iot_cabang.py generate --set gen3_kc2 --kc sul-7371      # folder sintetis + kunci jawaban
.venv/Scripts/python.exe testing/iot_cabang.py periksa --set gen3_kc2 --kc sul-7371 [--iot FOLDER]
```
