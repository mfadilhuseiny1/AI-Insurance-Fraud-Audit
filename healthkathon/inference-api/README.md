# AI Inference Pipeline — BluesandAI · Healthkathon 2026

> **AI JKN Synthetic:** dokumen ini disalin dari AI JKN Audit dan menggambarkan pengerjaan di atas Data Sampel BPJS yang asli. Angka agregat data asli sudah dihapus dan diganti `[…]`. Aplikasi ini berjalan di atas data sintetis (lihat `synthetic-gen/METODOLOGI.md` dan `synthetic-gen/laporan/EVALUASI.md`).

Pipeline inferensi deteksi indikasi fraud klaim JKN, mengikuti arsitektur rujukan juri
([saidachmadd/ai-inference-pipeline-demo](https://github.com/saidachmadd/ai-inference-pipeline-demo)):
**Client Request → Schema Validation → Feature Engineering → ML Inference → LLM Service → JSON Response**,
`POST /verify` → `{status, fraud_probability, ai_reasoning}`.

Bedanya: model di sini dilatih dan diuji pada **klaim nyata** Data Sampel BPJS Kesehatan 2025 (bukan 500 baris
sintetis), dipilih lewat benchmark 9 teknik ML, dan dipasang oleh pipeline produksi yang menjaga kontrak data, drift,
paritas ONNX dan paritas fitur online/batch sebelum paket ini boleh dipakai.

## Menjalankan (tiga langkah juri)

**1. Clone repositori dan buka di VS Code**

```bash
git clone <repositori ini> && cd bluesandai-parse/healthkathon/inference-api
pip install -r requirements.txt          # Python 3.10+
```

**2. Konfigurasi environment (`.env`)**

```bash
cp .env.example .env          # isi LLM_API_KEY (Gemini, seperti rujukan juri; atau API kompatibel OpenAI)
python export_paket.py        # paket model dari platform: model.pkl, model_*.onnx, signature.json, toko fitur
```

Tanpa `LLM_API_KEY` server tetap jalan: telaah klinis memakai *fallback* deterministik (circuit breaker).

**3. Jalankan FastAPI dengan Uvicorn**

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

Swagger UI: `http://localhost:8000/docs` · kesehatan: `GET /health`.

## Uji

Payload juri apa adanya (`mock_payloads.json`):

```bash
curl -X POST http://localhost:8000/verify -H "Content-Type: application/json" -d '{
  "claim_id": "CLM-2026-9942", "patient_age": 29, "ina_cbg_code": "A-4-13-III", "primary_diagnosis": "A41.9",
  "claimed_cost": 18450000.0, "real_cost": 3150000.0, "length_of_stay_days": 2,
  "clinical_notes": "Pasien datang dengan keluhan demam tifoid dan mual. Diberikan infus RL dan obat oral. Hari kedua demam turun dan pasien meminta pulang paksa. Tidak ada tindakan pemasangan ventilator atau observasi ICU."
}'
```

Klaim nyata dalam kontrak lengkap (field silver kunjungan FKRTL): `paket/contoh_klaim_nyata.json` (dibuat oleh
`export_paket.py`, tidak di-commit; klaim contoh dikeluarkan dari riwayat peserta sehingga datang sebagai klaim baru).

### Banyak klaim sekaligus (CSV atau JSON)

Satu klaim per baris, kolom sama dengan payload juri. Setiap klaim melewati enam tahap yang sama, 8 klaim paralel
(`BATCH_PARALLEL`), maksimal 200 klaim per permintaan (`BATCH_MAX`):

```bash
curl -o templat.csv http://localhost:8000/verify/csv/templat                     # kolom juri + dua payload juri
curl -o contoh.csv "http://localhost:8000/verify/csv/templat?contoh=true"        # tujuh klaim untuk dicoba
curl -F berkas=@contoh.csv http://localhost:8000/verify/csv -o hasil.csv
curl -F berkas=@contoh.csv "http://localhost:8000/verify/csv?keluaran=json"
curl -X POST http://localhost:8000/verify/batch -H "Content-Type: application/json" -d '{"klaim": [ {...}, {...} ]}'
```

`hasil.csv` = kolom masukan apa adanya, lalu `status`, `fraud_probability`, `ai_reasoning`, kesimpulan klinis, tag
aturan, kejanggalan, dokumen yang perlu diperiksa dan `galat`. CSV dari Excel berlocale Indonesia juga dibaca:
pemisah `;`, angka `Rp 18.450.000`, catatan berbaris banyak dalam tanda kutip. Kolom yang tidak dikenal (misalnya label
Anda sendiri) ikut ke hasil tetapi tidak pernah dikirim ke model atau LLM. Baris yang ditolak kontrak menyebut alasannya;
baris lain tetap dinilai.

`contoh.csv` berisi dua payload juri dan lima klaim **buatan** (bukan data BPJS) pada kode INA-CBG dan tarif nyata, masing-
masing dengan label maksud penulisannya. Hasil nyata (23 Oktober 2026, `gemini-3.5-flash`, 7 baris dalam 23 detik):

| Klaim | label | status | Telaah klinis (ringkas) |
|---|---|---|---|
| `CLM-2026-8801` IMA, 6 hari | wajar | `WAJAR` | ICU 3 hari + observasi 3 hari konsisten; lama rawat di bawah p90 kode |
| `CLM-2026-9942` sepsis A41.9, 2 hari | upcoding | `INDIKASI_KUAT` | catatan hanya demam tifoid tanpa ICU; tagihan 5,86× tarif |
| `CLM-2026-1003` pneumonia, 3 hari | wajar | `WAJAR` | gejala, ronki dan infiltrat mendukung J18.9; lama rawat = median kode |
| `CLM-2026-1004` herniorafi, 9 hari | los_diperpanjang | `INDIKASI_KUAT` atau `PERLU_DIPERIKSA` (berganti antar-run; selalu ditandai) | 9 hari = 2,25× p90 tanpa penyulit, atas permintaan keluarga; tagihan 2× tarif |
| `CLM-2026-1005` sectio caesarea, 2 hari | wajar | `WAJAR` | presentasi bokong (O32.1) konsisten dengan SC elektif dan O-6-10-I |
| `CLM-2026-1006` diare, "4 hari" | phantom_billing | `INDIKASI_KUAT` | catatan: observasi IGD 6 jam, pulang hari itu; diklaim rawat inap 4 hari, tagihan 5,45× tarif |
| `CLM-2026-1007` | tidak_valid | — | ditolak kontrak: `patient_age` > 120 |

Format juri tidak membawa prosedur, faskes, tanggal maupun riwayat peserta: telaah klinis diberi tahu bahwa data itu *tidak
dikirim* (bukan kosong), dan `fraud_probability` model — yang belajar dari riwayat faskes dan peserta pada klaim nyata —
rendah untuk klaim datar seperti ini; status bertumpu pada telaah klinis dan sinyal aturan (dua lini bukti yang lepas).

Hasil nyata (23 Oktober 2026, `gemini-3.5-flash`, paket `mlj-99db23d997`):

| Klaim | status | fraud_probability | Telaah klinis (ringkas) |
|---|---|---:|---|
| Juri: `CLM-2026-8801` IMA, 6 hari | `WAJAR` | 0,000004 | IMA (I21.0) 6 hari konsisten dengan ICU dan trombolitik; lama rawat di bawah p90 kode (7 hari) |
| Juri: `CLM-2026-9942` sepsis A41.9, 2 hari | `INDIKASI_KUAT` | 0,000007 | Sepsis berat tidak didukung catatan (demam tifoid ringan, tanpa ICU); tagihan 5,86× tarif |
| Nyata: gegar otak + kraniotomi | `INDIKASI_KUAT` | 0,843 | Kraniotomi tidak lazim untuk gegar otak (S060) tanpa perdarahan intrakranial atau fraktur |
| Nyata: perdarahan epidural, ventilator ≥ 96 jam | `PERLU_DIPERIKSA` | 0,808 | Diagnosis dan kraniotomi konsisten; konfirmasi ventilator ≥ 96 jam pada rawat 4 hari |
| Nyata: dikoreksi verifikator | `PERLU_DIPERIKSA` | 0,912 | Diagnosis masuk non-trauma (I619) vs diagnosis utama trauma (S0620) |
| Nyata: kontrol ortopedi | `WAJAR` | 0,0002 | Kontrol pasca-terapi sesuai tarif Q-5-44-0 |

`fraud_probability` = peluang klaim **dikoreksi verifikator BPJS** menurut model (label nyata; skala populasi) — indikasi
untuk diperiksa, bukan bukti fraud. Model tidak melihat catatan medis; telaah klinis LLM yang membacanya, sehingga keduanya
bisa berbeda pendapat (baris kedua) — itulah gunanya dua lini bukti.

## Enam tahap

| Tahap juri | Di sini |
|---|---|
| 01 Client Request (JSON) | `POST /verify`: format datar juri (`ClaimDataJuri`) atau kontrak klaim lengkap (`ClaimData`, field silver) |
| 02 Schema Validation (Pydantic) | Pydantic v2: tipe, rentang, pola kode (ICD-10, INA-CBG), himpunan tertutup, field asing ditolak (422) |
| 03 Feature Engineering (NumPy) | 50 fitur: rasio biaya, anomali hari rawat (vs median dan p90 kode), keparahan, statistik kode dan diagnosis, riwayat peserta dan faskes — dari toko fitur, dengan definisi pelatihan yang sama (paritas diuji pada klaim nyata: 400/400 cocok) |
| 04 ML Inference (Scikit-Learn) | `model.pkl` (joblib): CatBoost (rumah sakit), LightGBM (klinik utama), hasil benchmark 9 teknik — Random Forest, Extra Trees, HistGradientBoosting, XGBoost, LightGBM, CatBoost, regresi logistik dan MLP (dengan `StandardScaler`), EBM — dengan validasi silang per faskes; koreksi prior ke skala populasi; alasan per klaim (TreeSHAP). `.onnx` setara (paritas max \|Δp\| < 1e-7) untuk klien non-Python |
| 05 LLM Service (httpx AsyncClient) | satu `httpx.AsyncClient` dibuka di *lifespan*; telaah klinis (diagnosis, prosedur, keparahan, lama rawat vs peer, catatan); setiap angka di jawaban dicek ke fakta; timeout, circuit breaker (3 gagal → jeda 60 detik), fallback deterministik |
| 06 JSON Response | `{status, fraud_probability, ai_reasoning}` + model, telaah klinis, tag indikasi, peringatan, waktu tiap tahap |

`status`: `INDIKASI_KUAT` (telaah klinis "mencurigakan" + model menandai atau aturan menemukan sinyal tagihan/klaim ganda/
lama rawat), `PERLU_DIPERIKSA`, `WAJAR` — tidak pernah "fraud": verifikator yang memutuskan.

Kode bersama dengan platform: `api/aip/layanan.py` (kontrak, fitur, inferensi, `/verify`), `api/aip/medis.py` (telaah
klinis, gerbang angka, circuit breaker), `api/aip/produksi.py` (pipeline produksi yang membuat paket), `api/ml_klaim.py`
(model).
