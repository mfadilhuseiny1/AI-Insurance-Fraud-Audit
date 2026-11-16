# Rule engine × bukti perangkat (IoT) — kontrak integrasi

Versi kontrak `iot-2` (2026-11-15). Kode: `api/aip/realtime/iot.py`. Sinyal: `IOT_*` di `api/aip/realtime/modus.py`.

Sensor clamp pada kabel daya (tanpa membuka alat) mencatat arus listrik alat. Yang terekam hanya **kapan alat menyala, berapa
lama, dan statusnya** (dibaca dari besar arus). Tidak ada tanda vital. Rule engine mencocokkan pemakaian alat yang **ditagih**
di klaim dengan pemakaian alat yang **tercatat sensor**.

| Alat | Status yang dikenali sensor |
|---|---|
| `ventilator` | `jalan` (memberi napas), `siaga` (standby, menyala tanpa memberi napas), `mati` |
| `hemodialisis` | `jalan`, `idle`, `mati` |
| `icu` (bed/monitor ICU) | `nyala`, `mati` |
| `infus` (pompa infus) | `jalan`, `idle`, `mati` |

Sensor clamp hanya tahu apakah ventilator jalan, siaga atau mati, dan berapa lama. Sensor ini tidak dapat membedakan ventilasi
lewat pipa napas dari ventilasi dengan masker, jadi kontrak ini tidak memakai pembedaan itu.

Sinonim diterima, misalnya `running` → `jalan`, `standby` → `siaga`, `on`/`off`, serta `hd`/`dialisis` → `hemodialisis`.
Kompatibilitas `iot-1`: nilai lama ventilator `invasif` / `non_invasif` (juga `NIV`, `CPAP`, `BiPAP`) dibaca `jalan`, dan
`standby` dibaca `siaga`. Validasi memberi peringatan untuk nilai lama itu.

**Mode dari ventilator sendiri (opsional).** Bila ventilator melaporkan mode ventilasinya lewat port datanya (bukan dari sensor
clamp), sesi boleh membawa `"sumber_mode": "ventilator"` dan `"mode_ventilasi": "invasif" | "non_invasif"`. Hanya sesi seperti ini
yang dapat menyalakan `IOT_MODE_NONINVASIF`. Sesi dari sensor clamp tidak pernah menyalakannya.

## 1. Cara mengirim

Field `iot` ikut dikirim bersama klaim di `POST /api/aip/realtime/v1/faskes/klaim` (header `X-Ingest-Token`), di samping
`rekam_medis`. Field ini opsional. RS yang belum tercakup program IoT tidak mengirimnya, dan tidak ada temuan apa pun untuknya.

Field klaim untuk durasi yang ditagih mengikuti E-Klaim:
- `lama_icu_hari`, `jam_ventilator`, `sesi_hemodialisis`;
- `diajukan_pada`: waktu klaim pertama kali diajukan di sistem RS. Bila kosong, dipakai waktu tanda terima.

Kode tindakan dibaca dari `tindakan` (ICD-9-CM):
- `96.70`, `96.71`, `96.72`: ventilasi mekanik (96.72 = ≥ 96 jam berturut-turut);
- `39.95`: hemodialisis.

```json
"iot": {
  "sesi": [{"sesi_id": "S-001", "device_id": "VENT-07", "jenis": "ventilator", "peserta": "<no_rm>", "kunjungan": "<klaim_id>",
            "mulai": "2025-03-10T08:00:00+08:00", "selesai": "2025-03-12T20:00:00+08:00", "mode": "jalan", "jam": 60}],
  "jangkar": {"akar": "<sha256 hex 64>", "waktu": "2025-03-13T00:05:00+08:00", "sesi_ids": ["S-001"], "bukti": {"S-001": [{"posisi": "kanan", "hash": "..."}]}},
  "alat": {"tercakup": true, "cakupan": ["ventilator", "hemodialisis", "icu"],
           "perangkat": {"VENT-07": {"jenis": "ventilator", "kunci": "aktif"}},
           "gateway_offline": [{"mulai": "2025-03-11T02:00:00+08:00", "selesai": "2025-03-11T04:00:00+08:00"}]}
}
```

- **Binding.** Satu sesi menyambungkan alat, pasien dan kunjungan:
  - `kunjungan` = `klaim_id` (atau nomor SEP);
  - `peserta` = nomor rekam medis RS (`no_rm`);
  - sesi tanpa `kunjungan` tetap dipakai bila `peserta` sama dan waktunya jatuh di masa rawat (±12 jam);
  - sesi pasien lain pada alat yang sama boleh ikut dikirim, karena dipakai untuk cek binding tumpang.
- **Waktu.** ISO 8601 dengan zona. Waktu tanpa zona dibaca sebagai WIB (+07:00). Lama sesi dihitung dari `mulai` dan
  `selesai`; `jam` hanya pembanding.
- **Jangkar.** Bisa satu objek atau daftar.
  - Daun Merkle satu sesi: SHA-256 dari `sesi_id|device_id|peserta|kunjungan|mulai|selesai|mode|jam`. Nilainya persis
    seperti dikirim, `jam` 3 desimal.
  - Tanpa `bukti`: akar dihitung ulang atas sesi klaim ini (atau atas `sesi_ids`), diurutkan menurut `sesi_id`. Simpul =
    SHA-256(kiri‖kanan); simpul ganjil terakhir dipasangkan dengan dirinya sendiri.
  - Dengan `bukti`: setiap sesi diperiksa lewat bukti inklusinya. Cara ini dipakai bila satu jangkar mencakup banyak pasien.
  - Fungsi acuan: `iot.hash_daun`, `iot.akar_sesi`, `iot.bukti_inklusi`, `iot.cek_inklusi`.
- **Batas.** 5.000 sesi per klaim.

Validasi struktur sebelum mengirim klaim: `POST /api/aip/realtime/v1/faskes/iot/validasi`. Endpoint ini hanya memeriksa
struktur: apa yang terbaca dan apa yang kurang, tanpa skor. Tanda terima klaim juga hanya memuat
`bukti_iot: {terbaca, sesi, masalah}`, tidak pernah hasil pemeriksaan.

Katalog untuk pengguna internal: `GET /api/aip/realtime/v1/iot/skema` (jenis alat, mode, ambang, sinyal).

## 2. Aturan

Setiap temuan menjadi sinyal rule engine. Isinya bukti dalam kalimat biasa beserta angka terukurnya, dan dua penanda:
- `jenis_bukti`: **bukti** = durasi terukur atau hash; **telaah** = status yang dibaca dari pola arus, mode yang dilaporkan
  ventilator sendiri, atau ketiadaan data;
- `aturan`: id aturan pemeriksa luring `testing/iot_cabang.py`.

Sinyal IoT **tidak masuk fitur model** (`aktif.CODES` beku di 45 sinyal). Sinyal ini masuk skor rule, penjelasan, kasus dan
ledger.

| Sinyal | Kapan | Modus | Tag ledger | Bobot | Jenis |
|---|---|---|---|---|---|
| `IOT_VENTILASI_KURANG_96` | 96.72 (≥ 96 jam berturut-turut) ditagih, rangkaian `jalan` terpanjang tanpa putus < 96 jam. Jeda ≤ 60 menit tetap satu rangkaian. Tepat 96 jam tidak ditandai | M04, M14 | DURASI_ALAT_TIDAK_SESUAI | 1,4 | bukti (telaah bila alat menyala ≥ 96 jam tanpa putus dan yang kurang hanya bagian yang terbaca `jalan`) |
| `IOT_VENTILATOR_STANDBY` | ventilasi ditagih, ventilator hanya `siaga` (jalan < 1 jam) | M14 | TINDAKAN_TIDAK_DILAKUKAN | 1,2 | telaah |
| `IOT_MODE_NONINVASIF` | **hanya untuk mode yang dilaporkan ventilator sendiri** (`sumber_mode: "ventilator"`): kode 96.7x ditagih, ventilator melaporkan non-invasif saja (invasif < 1 jam, tidak ada jam `jalan` tanpa mode). Tidak pernah dari data sensor clamp | M04 | DURASI_ALAT_TIDAK_SESUAI | 1,2 | telaah |
| `IOT_HD_SESI_SINGKAT` | sesi hemodialisis ditagih penuh, mesin jalan < 3 jam. Jeda alarm ≤ 30 menit digabung. Tepat 3 jam = penuh | M14 | DURASI_ALAT_TIDAK_SESUAI | 1,0 | bukti |
| `IOT_HD_TANPA_SESI` | sesi ditagih lebih banyak dari sesi mesin. Kunjungan punya sesi alat lain, tetapi sesi HD kurang | M14, M06 | TINDAKAN_TIDAK_DILAKUKAN | 1,2 | telaah |
| `IOT_HARI_ICU_LEBIH` | hari ICU ditagih > hari bed/monitor ICU menyala. Hitungan yang lebih longgar dipakai: hari kalender dengan ≥ 1 jam menyala, atau jam/24 dibulatkan ke atas | M12, M13 | DURASI_ALAT_TIDAK_SESUAI | 1,0 | bukti |
| `IOT_TANPA_JEJAK` | pemakaian alat ditagih, tidak ada satu pun sesi alat itu di RS yang alat jenis itu tercakup | M14, M06 | TINDAKAN_TIDAK_DILAKUKAN | 1,0 | telaah |
| `IOT_BINDING_TUMPANG` | satu alat terikat ke dua pasien dengan irisan ≥ 15 menit. Sesi dari klaim lain diingat engine | M06 | KLAIM_FIKTIF | 1,0 | telaah |
| `IOT_TANPA_PASIEN` | alat jalan ≥ 6 jam tanpa pasien terikat dalam masa rawat. Temuan tingkat faskes: bobot kecil, tanpa tag | – | – | 0,3 | telaah |
| `IOT_JANGKAR_TIDAK_COCOK` | sesi tidak menghasilkan akar Merkle yang dijangkarkan (bukti berubah) | M20 | MANIPULASI_PEMERIKSAAN | 1,2 | bukti |
| `IOT_JANGKAR_TERLAMBAT` | bukti dijangkarkan setelah klaim diajukan. Tepat pada waktunya tidak ditandai | M20 | MANIPULASI_PEMERIKSAAN | 0,8 | telaah |
| `IOT_KUNCI_DICABUT` | sesi ditandatangani kunci alat yang sudah dicabut sebelum sesi selesai. Dicabut sesudahnya hanya dicatat | M20 | MANIPULASI_PEMERIKSAAN | 0,8 | telaah |

**Mitigasi: perlu klarifikasi, bukan fraud.**
- RS tidak tercakup, jenis alat tidak tercakup, atau tidak ada data alat sama sekali: aturan "tanpa jejak" tidak
  dijalankan; tabel auditor mencatat "tidak dicek".
- Gateway offline dalam masa rawat (×0,6). Bila jeda run tertutup masa offline dan run-nya jadi ≥ 96 jam: ×0,7.
- Gateway offline dan bukti terkirim tertunda ("simpan lalu kirim", ×0,6).
- Status jalan/siaga dibaca dari pola arus (`STATUS_DARI_POLA_ARUS`): dicatat agar dicocokkan dengan lembar observasi
  ventilator. Bila ventilator menyala ≥ 96 jam tanpa putus dan hanya bagian yang terbaca `jalan` yang kurang: ×0,4.
- Irisan binding < 30 menit dianggap serah terima alat (×0,7).
- Mesin hemodialisis yang tidak tercatat bersensor semua (×0,5).

Tag ledger baru **`DURASI_ALAT_TIDAK_SESUAI`** (`aip/semantik.py`), label "Durasi/mode pemakaian alat tidak sesuai
tagihan". Tag ini terdaftar pada modus M04, M12 dan M14.

## 3. Di mana berjalan

- **Engine realtime** (`mesin._fkrtl`): setelah cek rekam medis, `iot.dari_meta` menjalankan semua aturan. Hasilnya disimpan
  di event (`iot`: tabel butir, angka terukur, nilai). Engine mengingat sesi setiap alat dari klaim sebelumnya untuk cek
  binding tumpang lintas klaim.
- **Pemeriksa luring** `testing/iot_cabang.py` memanggil `iot.periksa_iot(klaim, sesi, jangkar, alat)` sebagai satu-satunya
  sumber aturan. Fungsinya murni: tanpa I/O, tanpa status. `iot.ATURAN_ID` memetakan kode sinyal ke id aturan:

  | Kode sinyal | Id aturan |
  |---|---|
  | `IOT_VENTILASI_KURANG_96` | `vent_run_96` |
  | `IOT_MODE_NONINVASIF` | `niv_as_invasive` (tidak ada di pemeriksa luring: pemeriksa membaca data sensor clamp) |
  | `IOT_VENTILATOR_STANDBY` | `vent_standby` |
  | `IOT_HD_SESI_SINGKAT` | `hd_short` |
  | `IOT_HD_TANPA_SESI` | `hd_phantom` |
  | `IOT_HARI_ICU_LEBIH` | `icu_days` |
  | `IOT_TANPA_JEJAK` | `no_device_trace` |
  | `IOT_BINDING_TUMPANG` | `binding_tumpang` |
  | `IOT_JANGKAR_TIDAK_COCOK` | `anchor_mismatch` |
  | `IOT_JANGKAR_TERLAMBAT` | `late_anchor` |
  | `IOT_TANPA_PASIEN` | `unbound_readings` |
  | `IOT_KUNCI_DICABUT` | `key_revoked` |

  Hasil `aturan` memuat untuk setiap id apakah aturannya menyala.

## 4. Menjalankan

```powershell
cd api; ..\.venv\Scripts\python.exe -I -m pytest -q test_iot.py
```

Kode baru aktif setelah API (8300) di-restart. Data uji di sini sintetis; ambang (96 jam, 3 jam, celah 60/30 menit, irisan
15 menit) perlu disepakati dengan tim medis BPJS dan RS mitra sebelum dipakai pada klaim riil.
