# Spesifikasi generator: benchmark aturan 2 (Healthkathon 2026)

> **AI JKN Synthetic:** dokumen ini disalin dari AI JKN Audit dan menggambarkan pengerjaan di atas Data Sampel BPJS yang asli. Angka agregat data asli sudah dihapus dan diganti `[…]`. Aplikasi ini berjalan di atas data sintetis (lihat `synthetic-gen/METODOLOGI.md` dan `synthetic-gen/laporan/EVALUASI.md`).

Di-commit **sebelum** output detektor pada data ini dilihat (aturan 1 kit: commit spesifikasi generator lebih dulu).
Kode: [`api/ml_sintetis.py`](../../api/ml_sintetis.py). Detektor yang diuji: pipeline supervised `api/ml_klaim.py`
(HistGradientBoosting, kelompok teratas di benchmark label nyata; 3 lipatan dikelompokkan per profil faskes). Uji coba
generator pada sampel 5% hanya memeriksa generatornya (jumlah, tarif, flag), tanpa menjalankan detektor.

## Basis: klaim nyata, bukan sintetis seluruhnya

- Semua klaim **rumah sakit** di silver `kunjungan_fkrtl` Data Sampel BPJS 2025 ([…]), **tanpa** klaim yang
  benar-benar dikoreksi verifikator, sehingga satu-satunya kasus positif adalah yang ditanam.
- Klaim sah tetap sama di semua kondisi (seed tetap 2026); klaim terpilih diubah di tempat, atau klaim baru ditambahkan.
- Negatif sulit (aturan 3) sudah ada di basis: RS kelas A, dialisis/kemoterapi, diagnosis langka berbiaya tinggi,
  faskes kecil, masa wabah COVID: klaim sah sungguhan.

## Tujuh modus (label tersembunyi, hanya untuk evaluasi)

| Modus | Mudah | Sulit | Kelebihan bayar (excess_rupiah) |
|---|---|---|---|
| Upcoding keparahan rawat inap | keparahan I → III | II → III, ditambah 2 diagnosis sekunder | tarif kode baru − tarif lama |
| Upcoding rawat jalan ke prosedur | kunjungan tanpa prosedur → kode prosedur tersering di CMG yang sama | hanya pada diagnosis yang lazim berprosedur (≥ 20%) | selisih tarif |
| Lama rawat diperpanjang | +5–8 hari | +1–2 hari | 0 (INA-CBG membayar per episode) |
| Klaim berulang / episode dipecah | klaim kembar hari yang sama | klaim ulang 3–10 hari kemudian | seluruh tarif klaim tambahan |
| Phantom billing (klaim fiktif) | salinan identik satu klaim ke pasien fiktif | salinan klaim-klaim faskes itu sendiri (beragam) | seluruh tarif |
| Tarif tambahan (special CMG) tidak wajar | tambahan p95 pada kode yang jarang bertambahan | tambahan median pada kode yang lazim bertambahan | nilai tambahan |
| Tagihan melebihi tarif | +30% | +5% | kenaikan tagihan |

Kalibrasi (aturan 5): tarif kode baru = median tarif nyata kode itu pada regional tarif, kelas rawat dan tipe RS yang
sama (bukan pengali, agar tidak ada artefak angka hanya pada kasus fraud); nilai tambahan dari sebaran tambahan nyata;
kode prosedur dari kode nyata tersering per CMG. **Dikarang:** besaran pergeseran tingkat kesulitan, campuran modus
(sama rata), pembagian faskes pelaku. Flag aturan (calon klaim ganda, LOS > p99 kodenya) dihitung ulang setelah
penanaman, seperti pipeline nyata. Sebuah upcode hanya ditanam bila tarif kode barunya ≥ 5% di atas tarif lama.

## Tiga dial, satu per satu dari baseline (aturan 2)

| Kondisi | Kesulitan | Frekuensi (target) | Klaster |
|---|---|---|---|
| baseline | mudah | 2% klaim | tersebar: 30% profil faskes |
| sulit | **sulit** | 2% | tersebar |
| jarang | mudah | **0,5%** | tersebar |
| sering | mudah | **10%** | tersebar |
| terpusat | mudah | 2% | **terpusat: 3% profil faskes** |

Frekuensi: tidak ada angka fraud JKN nasional yang dipublikasikan; tim gabungan KPK–Kemenkes–BPJS–BPKP memakai
estimasi AS 3–10% klaim sebagai pembanding (Bisnis.com, 24 Juli 2024), jadi dial mencakup 0,5% sampai 10%. Frekuensi
yang **tercapai** bisa lebih rendah dari target bila klaim yang memenuhi syarat suatu modus habis (mis. kondisi
terpusat, atau tambahan pada kode yang lazim bertambahan); kartu melaporkan frekuensi yang tercapai, bukan target.

## Modus yang ditahan

Pada kondisi baseline, setiap modus ditahan bergantian: kasusnya **dihapus** dari data latih (tidak dilabel ulang sebagai
sah), lalu detektor diuji pada data uji lengkap (semua modus bersaing untuk slot audit, campuran penuh). Dilaporkan
recall@k modus itu dibanding k/N (acak), dan dibanding recall@k-nya bila ikut dilatih.

## Evaluasi

Kapasitas k = 1% klaim (asumsi). Kartu bukti kit per kondisi (`--lang id`), recall@k per modus dari kolom `modus`,
interval resampling per profil faskes. Satu baris per kondisi; tidak ada angka tanpa kondisinya.
