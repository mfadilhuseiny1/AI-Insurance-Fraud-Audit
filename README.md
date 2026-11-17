# AI Insurance Fraud Audit

Audit klaim asuransi kesehatan (JKN) dengan AI, di atas platform data BluesandAI. Isi repo ini:

| Bagian | Dokumen |
|---|---|
| App **AI JKN Audit**: cara menjalankan, port, perbedaan dari platform asal | [README-AIP-JKN.md](README-AIP-JKN.md) |
| Data BPJS **sintetis** (sequential CART synthesis) dan dasar ilmiahnya | [README-SINTETIS.md](README-SINTETIS.md), [synthetic-gen/METODOLOGI.md](synthetic-gen/METODOLOGI.md) |
| Mesin fraud realtime: aturan, model, pre-check faskes, permintaan dokumen | [docs/REALTIME_FRAUD.md](docs/REALTIME_FRAUD.md) |
| Cek klaim terhadap rekam medis SATUSEHAT (FHIR) | [docs/RME_SATUSEHAT_KONTRAK.md](docs/RME_SATUSEHAT_KONTRAK.md) |
| Bukti pemakaian alat dari IoT (sensor arus di kabel daya alat) | [docs/IOT_KONTRAK.md](docs/IOT_KONTRAK.md) |
| App faskes untuk binding IoT ke pasien (`/faskes`, untuk HP) | [docs/FASKES_APP.md](docs/FASKES_APP.md) |

**Yang tidak ada di repo ini:**
- Data BPJS asli. Semua data uji dan model di `testing/` berasal dari data sintetis.
- Kunci dan kata sandi. Salin [.env.example](.env.example) ke `.env.local` lalu isi sendiri.
- Data kerja (`data/`) dan hasil pembangkitan data sintetis (`Data Sintetis/`). Bangkitkan ulang lewat `synthetic-gen/`.

Bagian di bawah ini adalah dokumentasi platform asalnya (BluesandAI Parse).

---

`D:\Sadai\Power_SCADA\.env` (no other database is touched); re-run it to rotate the role's
password. On API startup, anything on disk that is missing from the database is copied in.
