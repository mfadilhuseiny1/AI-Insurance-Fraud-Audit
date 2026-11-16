"use client";

// ML Studio · Sistem ML terbaru · the detail drawer of the v3 flow (the user, 2026-11-12: "saya pengen ini clickable buat
// lihat detail: rule apa yg dipakai sehingga bisa menyimpulkan indikasi fraud, logika apa yg dipakai, algoritma machine
// learning yg dipakai gimana, masing2 node ... bisa dipahami orang awam ... UI detailnya visual ga banyak tabel atau
// paragraf", then "jangan ada istilah indo yg ga enak, keep bahasa inggris aja buat term yg ga cocok di translate").
// The content follows the code /testing runs: api/aip/realtime (entitas.py, modus.py, graf.py, mesin.score, ssl.py),
// testing/arsitektur_v2.py (v3 = v2 minus Model 2, ring alert and rule layer, plus the ring rule), testing/latih_v2.py
// (LightGBM settings, 5-fold out-of-fold) and testing/penjelas.py (the AI explanation and its evidence gate). Numbers come
// from arsitektur_v3 in /api/ml-sistem; test numbers are test B, claims no model ever trained on.

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { FITUR_MODEL, FITUR_V3 } from "./fiturV3";
import { SERIES } from "./viz";

export type NodeV3 = "klaim" | "engine" | "koding" | "tagihan" | "episode" | "identitas" | "model1" | "fusi" | "rute" | "jaringan" | "keputusan";

type RV = { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; fpr: number; auprc: number };
/** The part of arsitektur_v3 the drawer reads (the V3 document of MlSistem.tsx fits it). */
export type DataV3 = {
  klaim: number; fraud: number; normal: number;
  mutu_lapisan: Record<string, number>; bobot_fusi: Record<string, number>; ambang_peluang: number;
  rute: { sinyal: string[]; min_contoh: number; maks_normal: number; tambah_fraud: number; tambah_normal: number };
  rule_jaringan: { hari: number; ambang: number; laju_normal_latih: number; tambah_fraud: number; tambah_normal: number; cincin_baru: number };
  famili: { kunci: string; nama: string; modus: string[]; sinyal: number }[];
  skema: { skema: string; label: string; famili: string | null; n: number; baru: boolean; recall_v3: number; lapisan: Record<string, number> }[];
  tak_dikenal: { famili: string; recall_v3: number; recall_v1?: number; recall_v3_dikenal: number; per_skema: { skema: string; recall_v3: number }[] }[];
  ringkas: { v3: RV };
  prevalensi: { tingkat: number[]; uji: number; keputusan: { v3: number[] } };
  dibuang: { nama: string; ikon: string; isi: string }[];
  data_latih: { klaim: number; fraud: number };
};
/** Architecture v2 on an unseen Permenkes family, with and without the rule route (its own test). */
export type RuteV2 = { famili: string; dengan: number; tanpa: number }[];
/** The train/serve skew found by generator 2 (generator2.json → penyebab.skew), shown on every node's results. */
export type SkewV3 = { tanggal: string; ujiB: number; ujiBTanpa: number; gen2Klaim: number; gen2Recall: number; gen2Fpr: number; split: number; gainPct: number };

const ABU = "#8f99a8", SPESIALIS = "#9d7bd8", AMBER = "#c98500", HIJAU = "#199e70", MERAH = "#e5484d", PINK = "#d55181";

export const META: Record<NodeV3, { nama: string; ikon: IconName; warna: string; teknik: string }> = {
  klaim: { nama: "Klaim + entity resolution", ikon: "doc", warna: ABU, teknik: "Rule + Jaro-Winkler (fuzzy name matching)" },
  engine: { nama: "Engine realtime", ikon: "bolt", warna: AMBER, teknik: "Rule engine · 45 rule + feature klaim" },
  koding: { nama: "Spesialis coding", ikon: "code", warna: SPESIALIS, teknik: "LightGBM (GBDT) · monotone · graph feature" },
  tagihan: { nama: "Spesialis tagihan", ikon: "doc", warna: SPESIALIS, teknik: "LightGBM (GBDT) · monotone · graph feature" },
  episode: { nama: "Spesialis episode", ikon: "clock", warna: SPESIALIS, teknik: "LightGBM (GBDT) · monotone · graph feature" },
  identitas: { nama: "Spesialis identitas", ikon: "lock", warna: SPESIALIS, teknik: "LightGBM (GBDT) · monotone · graph feature" },
  model1: { nama: "Model 1 · graph + tetangga", ikon: "graph", warna: SERIES[1], teknik: "LightGBM (GBDT) · neighbour aggregation feature" },
  fusi: { nama: "Monotone fusion + calibration", ikon: "layers", warna: SERIES[0], teknik: "LightGBM stacker (monotone) + isotonic regression" },
  rute: { nama: "Rule route", ikon: "logic", warna: AMBER, teknik: "Rule (tanpa ML)" },
  jaringan: { nama: "Network rule", ikon: "constellation", warna: SERIES[2], teknik: "Graph rule tanpa label" },
  keputusan: { nama: "Keputusan + penjelasan AI", ikon: "sparkle", warna: HIJAU, teknik: "Probability threshold · LLM hanya menjelaskan" },
};

const TAHAP: { nama: string; node: NodeV3[] }[] = [
  { nama: "Klaim", node: ["klaim"] },
  { nama: "Rule engine", node: ["engine"] },
  { nama: "Model", node: ["koding", "tagihan", "episode", "identitas", "model1"] },
  { nama: "Fusion + rule", node: ["fusi", "rute", "jaringan"] },
  { nama: "Keputusan", node: ["keputusan"] },
];
export const URUTAN_V3: NodeV3[] = TAHAP.flatMap((t) => t.node);

const MODUS: Record<string, string> = {
  M01: "Penyalahgunaan dana kapitasi", M02: "Manipulasi klaim nonkapitasi", M03: "Rujukan tidak sesuai", M04: "Upcoding", M05: "Claim cloning",
  M06: "Phantom billing", M07: "Inflated bills", M08: "Pemecahan episode", M09: "Unbundling", M10: "Self-referral · collusion ring",
  M11: "Repeat billing", M12: "Prolonged LOS", M13: "Manipulasi kelas rawat", M14: "Phantom procedure", M15: "Tidak sesuai indikasi medis",
  M16: "Readmisi", M17: "Obat/alkes fiktif", M18: "Pengurangan obat", M20: "Manipulasi hasil pemeriksaan",
};

/** Every rule signal of the engine, in plain words: what it is and when it fires (api/aip/realtime/modus.py, graf.py,
 *  aturan_rt.py). `kontrak`: the rule runs only on lines a hospital sends (dispensing, lab or device results). */
const SINYAL: Record<string, { label: string; kapan: string; modus: string[]; kontrak?: boolean }> = {
  LONJAKAN_KEPARAHAN: { label: "Lonjakan keparahan III di RS", kapan: "40 klaim rawat inap terakhir RS ini jauh lebih sering keparahan III dari riwayatnya sendiri (binomial test, p < 0,0001)", modus: ["M04"] },
  DX_SEKUNDER_BERLEBIH: { label: "Diagnosis sekunder berlebih", kapan: "Jumlah diagnosis sekunder di atas p99 klaim lain dengan kode yang sama", modus: ["M04"] },
  KODE_PROSEDUR_TANPA_TINDAKAN: { label: "Kode prosedur tanpa tindakan", kapan: "Kode INA-CBG kelompok prosedur, tapi tidak ada satu tindakan pun tercatat", modus: ["M14"] },
  PASANGAN_KODE_LANGKA: { label: "Pasangan diagnosis–kode langka", kapan: "Pasangan ini muncul ≤ 3 kali dari ≥ 1.000 klaim diagnosis yang sama", modus: ["M15"] },
  TIDAK_SESUAI_PESERTA: { label: "Tidak cocok dengan pasien", kapan: "Diagnosis/kode mustahil untuk jenis kelamin atau usia peserta (mis. persalinan pada laki-laki)", modus: ["M15"] },
  HASIL_PEMERIKSAAN_TIDAK_COCOK: { label: "Hasil lab ≠ hasil alat", kapan: "Hasil di klaim berbeda dari data alat (LIS/IoMT) yang dikirim RS, di luar toleransi", modus: ["M20"], kontrak: true },
  TOPUP_TIDAK_LAZIM: { label: "Top-up yang hampir tak pernah ada", kapan: "Top-up special CMG muncul ≤ 2 kali dari ≥ 200 klaim kode itu", modus: ["M17"] },
  TOPUP_DI_ATAS_PEER: { label: "Top-up di atas peer", kapan: "Top-up special CMG di atas p95 untuk kode dan jenis top-up yang sama", modus: ["M07"] },
  KELAS_DI_ATAS_HAK: { label: "Kelas rawat di atas hak", kapan: "Kelas yang ditagih di atas hak peserta. Kuat untuk PBI; untuk non-PBI bobotnya diturunkan (boleh naik kelas dengan bayar selisih)", modus: ["M13"] },
  OBAT_DIKURANGI: { label: "Obat dikurangi", kapan: "Jumlah obat yang diserahkan lebih sedikit dari yang ditagih", modus: ["M18"], kontrak: true },
  OBAT_TIDAK_DISERAHKAN: { label: "Obat tidak diserahkan", kapan: "Obat ditagih, tapi tidak ada bukti penyerahan", modus: ["M17"], kontrak: true },
  TAGIHAN_MELEBIHI_TARIF: { label: "Tagihan di atas tarif", kapan: "Tagihan melebihi tarif INA-CBG + top-up", modus: ["M07"] },
  LOS_FASKES_BERGESER: { label: "LOS RS bergeser naik", kapan: "Rata-rata LOS RS ini naik jauh di atas riwayatnya sendiri", modus: ["M12"] },
  LOS_DIPERPANJANG: { label: "LOS terlalu panjang", kapan: "LOS lebih dari 2× p90 kodenya", modus: ["M12"] },
  PEMECAHAN_EPISODE: { label: "Unbundling episode", kapan: "Masuk lagi 0–3 hari setelah pulang, RS dan diagnosis sama", modus: ["M09"] },
  EPISODE_HARI_SAMA: { label: "Episode dipecah di hari yang sama", kapan: "Rawat jalan + rawat inap di RS yang sama pada hari yang sama, ditagih terpisah", modus: ["M08"] },
  READMISI_DX_SAMA: { label: "Readmisi, diagnosis sama", kapan: "Rawat inap lagi 4–30 hari kemudian, RS dan diagnosis sama", modus: ["M16"] },
  READMISI: { label: "Readmisi ≤ 30 hari", kapan: "Rawat inap lagi di RS yang sama dalam 30 hari dengan diagnosis lain (sinyal lemah)", modus: ["M16"] },
  RAWAT_INAP_TUMPANG_TINDIH: { label: "Rawat inap di 2 RS sekaligus", kapan: "Satu peserta rawat inap di dua RS pada malam yang sama: mustahil untuk satu orang", modus: ["M06"] },
  KARTU_BANYAK_FASKES: { label: "Satu kartu di banyak RS", kapan: "Kartu yang sama dipakai di ≥ 3 RS dalam 3 hari", modus: ["M06"] },
  KLAIM_GANDA_STREAM: { label: "Klaim ganda (id lain)", kapan: "Peserta, RS, tanggal masuk dan kode yang sama sudah diklaim dengan id lain", modus: ["M11"] },
  KLAIM_GANDA_RIWAYAT: { label: "Klaim ganda (riwayat)", kapan: "Klaim yang sama sudah ada di riwayat klaim", modus: ["M11"] },
  KLAIM_BERULANG_MIRIP: { label: "Klaim berulang versi mirip", kapan: "Peserta, RS dan diagnosis sama, tanggal masuk bergeser 1 hari", modus: ["M11"] },
  KLONING_LINTAS_PESERTA: { label: "Claim cloning lintas peserta", kapan: "≥ 3 peserta dengan klaim rawat inap identik (RS, tanggal, kode, diagnosis, LOS, prosedur, tagihan bukan tarif paket)", modus: ["M05"] },
  KLAIM_SETELAH_MENINGGAL: { label: "Klaim setelah meninggal (registri)", kapan: "Tanggal klaim setelah tahun kematian di registri peserta", modus: ["M06"] },
  MENINGGAL_TERCATAT: { label: "Klaim setelah kematian tercatat", kapan: "Klaim lain sebelumnya mencatat peserta pulang meninggal", modus: ["M06"] },
  KARTU_KELUARGA: { label: "Kartu anggota keluarga dipakai", kapan: "Diagnosis tidak cocok dengan pemilik kartu, tapi cocok dengan anggota keluarganya", modus: ["M06"] },
  CINCIN_FASKES: { label: "Collusion ring antar-RS", kapan: "Pasangan RS berbagi peserta jauh di atas riwayatnya (Poisson, p < 0,0001, ≥ 4 peserta)", modus: ["M10"] },
  RISIKO_ASOSIASI: { label: "RS sudah di Box Karantina", kapan: "Risk by association: konteks saja, tidak pernah jadi tag", modus: [] },
  KONSENTRASI_RUJUKAN: { label: "Rujukan memusat", kapan: "Rujukan FKTP memusat ke satu tujuan jauh di atas sebaran riwayatnya", modus: ["M10"] },
  RUJUKAN_NON_SPESIALISTIK: { label: "Rujukan diagnosis kompetensi FKTP", kapan: "Diagnosis yang seharusnya tuntas di FKTP (kompetensi 4A) dirujuk", modus: ["M03"] },
  RUJUKAN_LONCAT_JENJANG: { label: "Rujukan melompat jenjang", kapan: "Rujukan langsung ke RS kelas A", modus: ["M03"] },
  RRNS_FKTP_NAIK: { label: "Rasio rujukan non-spesialistik naik", kapan: "FKTP swasta: rasio naik jauh di atas riwayatnya", modus: ["M03"] },
  RRNS_PUSKESMAS_NAIK: { label: "Rujukan FKTP pemerintah naik", kapan: "Beban kapitasi dipindah ke RS", modus: ["M01"] },
  KONTAK_SEMU: { label: "Lonjakan kontak online/home-visit", kapan: "Kontak semu untuk mengejar indikator kapitasi", modus: ["M01"] },
  KONTAK_RENDAH: { label: "Angka kontak jauh di bawah riwayat", kapan: "Kapitasi tetap dibayar, kunjungan turun drastis", modus: ["M01"] },
  KUNJUNGAN_SETELAH_MENINGGAL: { label: "Kunjungan FKTP setelah meninggal", kapan: "Kunjungan setelah tahun kematian di registri", modus: ["M06"] },
  NONKAP_GANDA: { label: "Tindakan nonkapitasi ganda", kapan: "Tindakan yang sama ditagih dua kali", modus: ["M02"] },
  NONKAP_FREKUENSI: { label: "Pemeriksaan di atas ketentuan", kapan: "Frekuensi Prolanis/PRB di atas aturan", modus: ["M02"] },
  NONKAP_TIDAK_SESUAI_PESERTA: { label: "Tindakan tidak cocok dengan peserta", kapan: "Mis. KB/ANC pada laki-laki", modus: ["M02", "M15"] },
  NONKAP_TARIF: { label: "Tarif tindakan di atas norma", kapan: "Di atas norma tarif tindakannya", modus: ["M02"] },
  NONKAP_TANGGAL: { label: "Tanggal di luar kunjungan", kapan: "Tanggal tindakan tidak cocok dengan kunjungan", modus: ["M02"] },
  NONKAP_LONJAKAN: { label: "Lonjakan volume nonkapitasi", kapan: "Volume FKTP melonjak dari riwayatnya", modus: ["M02"] },
  SKOR_ML: { label: "Skor model platform", kapan: "Skor model risiko klaim platform (point-in-time feature)", modus: [] },
  ANOMALI_SSL: { label: "Anomaly self-supervised", kapan: "Klaim yang tidak bisa dijelaskan oleh model VIME (di atas p99,9)", modus: [] },
};

/** Default weight of each rule (modus.SIGNALS; case decisions can recalibrate it, mesin.weights). */
const BOBOT: Record<string, number> = {
  RAWAT_INAP_TUMPANG_TINDIH: 1.6, KARTU_BANYAK_FASKES: 1.0, KLAIM_GANDA_STREAM: 1.6, KLAIM_GANDA_RIWAYAT: 1.6, KLAIM_BERULANG_MIRIP: 1.2, PEMECAHAN_EPISODE: 0.9,
  EPISODE_HARI_SAMA: 0.9, READMISI_DX_SAMA: 0.6, CINCIN_FASKES: 1.0, KLONING_LINTAS_PESERTA: 1.0, LONJAKAN_KEPARAHAN: 0.8, LOS_FASKES_BERGESER: 0.8,
  RISIKO_ASOSIASI: 0.25, KLAIM_SETELAH_MENINGGAL: 0.9, MENINGGAL_TERCATAT: 1.6, TIDAK_SESUAI_PESERTA: 0.65, KARTU_KELUARGA: 0.8, PASANGAN_KODE_LANGKA: 0.6,
  KODE_PROSEDUR_TANPA_TINDAKAN: 1.0, DX_SEKUNDER_BERLEBIH: 0.65, KELAS_DI_ATAS_HAK: 1.0, TOPUP_TIDAK_LAZIM: 1.0, TOPUP_DI_ATAS_PEER: 0.8, OBAT_DIKURANGI: 1.2,
  OBAT_TIDAK_DISERAHKAN: 1.4, HASIL_PEMERIKSAAN_TIDAK_COCOK: 1.3, SKOR_ML: 1.4, ANOMALI_SSL: 0.4, TAGIHAN_MELEBIHI_TARIF: 0.6, LOS_DIPERPANJANG: 0.5, READMISI: 0.2,
  RUJUKAN_NON_SPESIALISTIK: 0.3, RUJUKAN_LONCAT_JENJANG: 0.4, RRNS_FKTP_NAIK: 0.9, RRNS_PUSKESMAS_NAIK: 0.9, KONSENTRASI_RUJUKAN: 1.0, KONTAK_SEMU: 0.9,
  KONTAK_RENDAH: 1.0, KUNJUNGAN_SETELAH_MENINGGAL: 0.9, NONKAP_GANDA: 1.4, NONKAP_FREKUENSI: 0.8, NONKAP_TIDAK_SESUAI_PESERTA: 0.9, NONKAP_TARIF: 0.9,
  NONKAP_TANGGAL: 0.7, NONKAP_LONJAKAN: 0.7,
};

/** Where a rule reads its evidence (graf.py: the graph and the stream's history; aturan_rt.py: the member registry and the
 *  code references; the hospital's own lines; fktp.py; the models). */
type Sumber = "graph" | "registri" | "referensi" | "klaim" | "rs" | "fktp" | "model";
const SUMBER: Record<Sumber, { label: string; ikon: IconName }> = {
  graph: { label: "graph & riwayat", ikon: "graph" }, registri: { label: "registri peserta", ikon: "database" }, referensi: { label: "referensi kode & tarif", ikon: "table" },
  klaim: { label: "isi klaim", ikon: "doc" }, rs: { label: "kiriman RS", ikon: "upload" }, fktp: { label: "data FKTP", ikon: "home" }, model: { label: "model", ikon: "cpu" },
};
const SUMBER_RULE: Record<string, Sumber> = {
  RAWAT_INAP_TUMPANG_TINDIH: "graph", KARTU_BANYAK_FASKES: "graph", KLAIM_GANDA_STREAM: "graph", KLAIM_GANDA_RIWAYAT: "graph", KLAIM_BERULANG_MIRIP: "graph",
  PEMECAHAN_EPISODE: "graph", EPISODE_HARI_SAMA: "graph", READMISI_DX_SAMA: "graph", CINCIN_FASKES: "graph", KLONING_LINTAS_PESERTA: "graph",
  LONJAKAN_KEPARAHAN: "graph", LOS_FASKES_BERGESER: "graph", RISIKO_ASOSIASI: "graph", MENINGGAL_TERCATAT: "graph", READMISI: "graph",
  KLAIM_SETELAH_MENINGGAL: "registri", TIDAK_SESUAI_PESERTA: "registri", KARTU_KELUARGA: "registri", KELAS_DI_ATAS_HAK: "registri", KUNJUNGAN_SETELAH_MENINGGAL: "registri",
  PASANGAN_KODE_LANGKA: "referensi", DX_SEKUNDER_BERLEBIH: "referensi", TOPUP_TIDAK_LAZIM: "referensi", TOPUP_DI_ATAS_PEER: "referensi", TAGIHAN_MELEBIHI_TARIF: "referensi",
  LOS_DIPERPANJANG: "referensi", KODE_PROSEDUR_TANPA_TINDAKAN: "klaim",
  OBAT_DIKURANGI: "rs", OBAT_TIDAK_DISERAHKAN: "rs", HASIL_PEMERIKSAAN_TIDAK_COCOK: "rs",
  RUJUKAN_NON_SPESIALISTIK: "fktp", RUJUKAN_LONCAT_JENJANG: "fktp", RRNS_FKTP_NAIK: "fktp", RRNS_PUSKESMAS_NAIK: "fktp", KONSENTRASI_RUJUKAN: "fktp", KONTAK_SEMU: "fktp",
  KONTAK_RENDAH: "fktp", NONKAP_GANDA: "fktp", NONKAP_FREKUENSI: "fktp", NONKAP_TIDAK_SESUAI_PESERTA: "fktp", NONKAP_TARIF: "fktp", NONKAP_TANGGAL: "fktp", NONKAP_LONJAKAN: "fktp",
  SKOR_ML: "model", ANOMALI_SSL: "model",
};

/** The 45 signals by group, for the rule list in the engine view; `ket` says who reads them. */
const GRUP_SINYAL: { nama: string; node?: NodeV3; warna: string; kode: string[]; ket?: string }[] = [
  { nama: "Coding", node: "koding", warna: SPESIALIS, kode: ["LONJAKAN_KEPARAHAN", "DX_SEKUNDER_BERLEBIH", "KODE_PROSEDUR_TANPA_TINDAKAN", "PASANGAN_KODE_LANGKA", "TIDAK_SESUAI_PESERTA", "HASIL_PEMERIKSAAN_TIDAK_COCOK"], ket: "Dibaca Model 1 dan Spesialis coding." },
  { nama: "Tagihan", node: "tagihan", warna: SPESIALIS, kode: ["TOPUP_TIDAK_LAZIM", "TOPUP_DI_ATAS_PEER", "KELAS_DI_ATAS_HAK", "OBAT_DIKURANGI", "OBAT_TIDAK_DISERAHKAN", "TAGIHAN_MELEBIHI_TARIF"], ket: "Dibaca Model 1 dan Spesialis tagihan." },
  { nama: "Episode", node: "episode", warna: SPESIALIS, kode: ["LOS_FASKES_BERGESER", "LOS_DIPERPANJANG", "PEMECAHAN_EPISODE", "EPISODE_HARI_SAMA", "READMISI_DX_SAMA", "READMISI"], ket: "Dibaca Model 1 dan Spesialis episode." },
  { nama: "Identitas", node: "identitas", warna: SPESIALIS, kode: ["RAWAT_INAP_TUMPANG_TINDIH", "KARTU_BANYAK_FASKES", "KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP", "KLONING_LINTAS_PESERTA", "KLAIM_SETELAH_MENINGGAL", "MENINGGAL_TERCATAT", "KARTU_KELUARGA"], ket: "Dibaca Model 1 dan Spesialis identitas." },
  { nama: "Jaringan", node: "jaringan", warna: SERIES[2], kode: ["CINCIN_FASKES", "RISIKO_ASOSIASI", "KONSENTRASI_RUJUKAN"], ket: "Dibaca Model 1. Network rule (±3 hari, tanpa label) adalah rule terpisah di langkah Fusion + rule." },
  { nama: "FKTP & rujukan", warna: ABU, kode: ["RUJUKAN_NON_SPESIALISTIK", "RUJUKAN_LONCAT_JENJANG", "RRNS_FKTP_NAIK", "RRNS_PUSKESMAS_NAIK", "KONTAK_SEMU", "KONTAK_RENDAH", "KUNJUNGAN_SETELAH_MENINGGAL"], ket: "Menilai kunjungan FKTP dan rujukannya, bukan klaim RS." },
  { nama: "Nonkapitasi", warna: ABU, kode: ["NONKAP_GANDA", "NONKAP_FREKUENSI", "NONKAP_TIDAK_SESUAI_PESERTA", "NONKAP_TARIF", "NONKAP_TANGGAL", "NONKAP_LONJAKAN"], ket: "Menilai klaim nonkapitasi FKTP, bukan klaim RS." },
  { nama: "Model & anomaly", node: "engine", warna: AMBER, kode: ["SKOR_ML", "ANOMALI_SSL"], ket: "Skor model risiko platform dibaca Model 1 sebagai feature. Anomaly VIME tidak dibaca langsung: hanya menambah skor rule kalau menyala (sekitar 0,1% klaim)." },
];

const RELASI: Record<string, { nama: string; maks: number; warna: string }> = {
  peserta: { nama: "Peserta sama", maks: 10, warna: "#8abbff" },
  faskes: { nama: "RS sama", maks: 10, warna: AMBER },
  faskes_kode: { nama: "RS + kode INA-CBG sama", maks: 10, warna: PINK },
  kode: { nama: "Kode INA-CBG sama", maks: 5, warna: HIJAU },
};

/** Each specialist: its rule signals, the claim data it reads and its graph relations (testing/arsitektur_v2.FAMILI). */
const SPES: Record<"koding" | "tagihan" | "episode" | "identitas", { kalimat: string; sinyal: string[]; data: string[]; relasi: string[] }> = {
  koding: {
    kalimat: "Mencari diagnosis dan tindakan yang dikode lebih berat, lebih banyak, atau tidak masuk akal untuk pasiennya.",
    sinyal: GRUP_SINYAL[0].kode,
    data: ["biaya ditagih", "tarif INA-CBG", "seberapa umum kode & diagnosis", "peluang keparahan berat untuk diagnosis ini", "jumlah diagnosis sekunder",
      "ada tindakan atau tidak", "tagihan ÷ tarif", "profil RS: % keparahan berat, % prosedur", "keparahan & tipe kasus INA-CBG", "jenis RS"],
    relasi: ["faskes", "faskes_kode", "kode"],
  },
  tagihan: {
    kalimat: "Mencari tagihan yang digelembungkan: top-up obat/alkes, kelas rawat di atas hak, dan obat yang ditagih tapi tidak diberikan.",
    sinyal: GRUP_SINYAL[1].kode,
    data: ["biaya ditagih", "tarif INA-CBG", "tarif tambahan (top-up)", "tagihan ÷ tarif", "profil RS: % klaim dengan top-up", "kelas rawat", "tingkat pelayanan",
      "keparahan INA-CBG"],
    relasi: ["faskes", "faskes_kode", "kode"],
  },
  episode: {
    kalimat: "Mencari perawatan yang dipecah, diulang, atau diperpanjang supaya bisa ditagih lebih dari sekali.",
    sinyal: GRUP_SINYAL[2].kode,
    data: ["LOS", "LOS dibanding kodenya", "profil RS: LOS, % rawat inap", "hari sejak klaim sebelumnya", "kunjungan peserta ke RS ini", "tingkat pelayanan",
      "keparahan & tipe kasus"],
    relasi: ["peserta", "faskes", "faskes_kode"],
  },
  identitas: {
    kalimat: "Mencari klaim untuk orang yang tidak benar-benar dirawat: kartu dipinjam, klaim ganda, claim cloning, atau peserta yang sudah meninggal.",
    sinyal: GRUP_SINYAL[3].kode,
    data: ["jumlah kunjungan peserta", "kunjungan ke RS ini", "klaim kembar", "hari sejak klaim sebelumnya", "profil RS: % klaim kembar, jumlah klaim", "LOS",
      "biaya ditagih"],
    relasi: ["peserta", "faskes_kode", "kode"],
  },
};

/** Scheme labels with their English fraud terms (the user's rule: no awkward Indonesian coinages). */
const SKEMA_EN: Record<string, string> = {
  cincin_kolusi: "Collusion ring antar-RS", cincin_bentuk_baru: "Collusion ring bentuk baru (tidak ada di training data)",
  dx_sekunder: "Upcoding diagnosis sekunder", upcoding: "Upcoding keparahan III", prosedur_fiktif: "Phantom procedure (kode prosedur tanpa tindakan)",
  kode_tidak_sesuai: "Kode INA-CBG tidak lazim untuk diagnosis", kelas_naik: "Peserta PBI ditagih Kelas 1", topup_fiktif: "Top-up fiktif (special CMG)",
  topup_inflasi: "Inflated bills (top-up obat/alkes)", los_bergeser: "Prolonged LOS di satu RS", kloning: "Claim cloning lintas peserta",
  kartu_dipinjam: "Kartu dipinjam (rawat inap di 2 RS)", klaim_ganda: "Repeat billing (id lain)",
};

const FAM: Record<string, string> = { koding: "coding", tagihan: "tagihan", episode: "episode", identitas: "identitas" };
const putusan = (skor: number): [string, string] => (skor >= 75 ? ["TAHAN", MERAH] : skor >= 45 ? ["PERIKSA", AMBER] : ["LOLOS", HIJAU]);
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number, d = 0) => `${id(v * 100, d)}%`;

// ------------------------------------------------------------------------------------------------------------ building blocks

function Bagian({ ikon, judul, sub, children }: { ikon: IconName; judul: string; sub?: string; children: ReactNode }) {
  return (
    <section className="border-t border-white/[.07] px-4 py-4 sm:px-5">
      <h3 className="mb-2.5 flex items-center gap-2 text-[12.5px] font-semibold text-white"><Icon name={ikon} className="h-4 w-4 text-[#8abbff]" />{judul}
        {sub && <span className="font-normal text-[#8f99a8]">· {sub}</span>}</h3>
      {children}
    </section>
  );
}

function ModusChip({ k }: { k: string }) {
  return <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: `${PINK}26`, color: "#f29ab9" }} title={MODUS[k]}>
    {k}{MODUS[k] ? ` · ${MODUS[k]}` : ""}</span>;
}

/** The node's work in three or four steps, left to right (top to bottom on a phone). */
function Langkah({ isi, warna }: { isi: { ikon: IconName; teks: string }[]; warna: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-stretch">
      {isi.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="flex items-center justify-center text-[#5f6b7a]"><Icon name="right" className="h-4 w-4 rotate-90 sm:rotate-0" /></div>}
          <div className="flex flex-1 items-center gap-2.5 rounded-lg border border-white/[.07] bg-white/[.03] p-2.5 sm:flex-col sm:items-start">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: `${warna}26`, color: warna }}><Icon name={l.ikon} className="h-4 w-4" /></span>
            <p className="text-[11.5px] leading-snug text-[#dfe3e8]"><span className="mr-1 text-[10px] tabular-nums text-[#8f99a8]">{i + 1}</span>{l.teks}</p>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** What one rule alone does to the engine score at full strength: 100 × (1 − e^−weight), on the 45/75 thresholds. */
function Sendirian({ w }: { w?: number }) {
  if (w === undefined) return null;
  const skor = 100 * (1 - Math.exp(-w)), [p, c] = putusan(skor);
  return (
    <div className="mt-2" title={`Bobot default ${id(w, 2)}. Skor bila rule ini menyala sendirian dengan kekuatan penuh, tanpa mitigasi.`}>
      <div className="flex items-center justify-between gap-2 text-[10px]"><span className="text-[#8f99a8]">kalau menyala sendirian · bobot {id(w, 2)}</span>
        <span className="shrink-0 rounded px-1 font-semibold tabular-nums" style={{ background: `${c}26`, color: c }}>{id(skor)} · {p}</span></div>
      <div className="relative mt-1 h-1.5 rounded-full bg-white/[.06]">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${skor}%`, background: c }} />
        {[45, 75].map((t) => <span key={t} className="absolute -bottom-0.5 -top-0.5 w-px bg-white/60" style={{ left: `${t}%` }} />)}
      </div>
    </div>
  );
}

/** Rule signals as cards: what it is, when it fires, which Permenkes 16/2019 mode it points to, where its evidence comes
 *  from, whether it is in the rule route, and its score when it fires alone. */
function KartuSinyal({ kode, warna, rute }: { kode: string[]; warna: string; rute?: string[] }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {kode.map((k) => {
        const s = SINYAL[k], src = SUMBER[SUMBER_RULE[k]];
        if (!s) return null;
        return (
          <div key={k} className="relative overflow-hidden rounded-lg border border-white/[.07] bg-white/[.025] py-2 pl-3.5 pr-2.5">
            <span className="absolute inset-y-0 left-0 w-1" style={{ background: warna }} />
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-semibold leading-snug text-white">{s.label}</p>
              {rute?.includes(k) && <span className="flex shrink-0 items-center gap-0.5 rounded bg-[#c98500]/20 px-1.5 py-0.5 text-[10px] text-[#f5c46b]"
                title="Rule route: kalau menyala, klaim langsung PERIKSA karena model belum punya cukup contoh"><Icon name="logic" className="h-3 w-3" />rule route</span>}
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">{s.kapan}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {s.modus.map((m) => <ModusChip key={m} k={m} />)}
              {src && <span className="flex items-center gap-1 rounded bg-white/[.06] px-1.5 py-0.5 text-[10px] text-[#c5cbd3]" title="Sumber bukti rule ini"><Icon name={src.ikon} className="h-3 w-3 text-[#8f99a8]" />{src.label}</span>}
              {s.kontrak && <span className="rounded bg-[#c98500]/20 px-1.5 py-0.5 text-[10px] text-[#f5c46b]" title="Data sampel tidak memuat baris ini; rule berjalan bila RS mengirimnya">butuh data dari RS</span>}
            </div>
            <Sendirian w={BOBOT[k]} />
          </div>
        );
      })}
    </div>
  );
}

/** A plain IF → THEN rule. */
function JikaMaka({ isi }: { isi: { jika: string; maka: string; nada?: "baik" | "buruk" | "netral" }[] }) {
  const w = { baik: HIJAU, buruk: MERAH, netral: AMBER };
  return (
    <div className="space-y-1.5">
      {isi.map((r, i) => (
        <div key={i} className="grid items-stretch gap-1 sm:grid-cols-[1fr_20px_1fr]">
          <div className="rounded-lg border border-white/[.07] bg-white/[.03] px-2.5 py-2 text-[11.5px] leading-snug text-[#dfe3e8]"><b className="mr-1 text-[10px] tracking-wide text-[#8f99a8]">JIKA</b>{r.jika}</div>
          <div className="hidden items-center justify-center text-[#5f6b7a] sm:flex"><Icon name="right" className="h-4 w-4" /></div>
          <div className="rounded-lg border px-2.5 py-2 text-[11.5px] leading-snug text-white" style={{ borderColor: `${w[r.nada ?? "netral"]}55`, background: `${w[r.nada ?? "netral"]}14` }}>
            <b className="mr-1 text-[10px] tracking-wide" style={{ color: w[r.nada ?? "netral"] }}>MAKA</b>{r.maka}</div>
        </div>
      ))}
    </div>
  );
}

function Chips({ isi, warna = ABU }: { isi: string[]; warna?: string }) {
  return <div className="flex flex-wrap gap-1">{isi.map((c) => <span key={c} className="rounded-full border px-2 py-0.5 text-[10.5px] text-[#dfe3e8]" style={{ borderColor: `${warna}55`, background: `${warna}12` }}>{c}</span>)}</div>;
}

function Angka({ nilai, label, ket, warna = "#fff" }: { nilai: string; label: string; ket?: string; warna?: string }) {
  return (
    <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
      <p className="text-[20px] font-semibold leading-none tabular-nums" style={{ color: warna }}>{nilai}</p>
      <p className="mt-1 text-[11px] leading-snug text-[#dfe3e8]">{label}</p>
      {ket && <p className="mt-0.5 text-[10px] leading-snug text-[#8f99a8]">{ket}</p>}
    </div>
  );
}

function Batasan({ isi }: { isi: string[] }) {
  return (
    <div className="mt-3 space-y-1">
      {isi.map((t) => (
        <p key={t} className="flex items-start gap-2 rounded-md bg-[#c98500]/10 px-2.5 py-1.5 text-[11px] leading-snug text-[#f2d49b]">
          <Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0 text-[#f5c46b]" />{t}</p>
      ))}
    </div>
  );
}

/** The generator 2 finding (2026-11-12): test B numbers are inflated by a float-rounding train/serve skew. On every node's
 *  results, because they all quote test B. */
function CatatanSkew({ s, onLihat }: { s: SkewV3; onLihat: () => void }) {
  return (
    <div className="mb-3 rounded-lg border border-[#e5484d]/30 bg-[#e5484d]/[.07] p-3">
      <p className="flex items-start gap-2 text-[12px] font-semibold leading-snug text-[#ffc9c7]">
        <Icon name="bug" className="mt-px h-4 w-4 shrink-0" />Catatan {s.tanggal}: angka test B di bawah terlalu tinggi karena bug train/serve skew</p>
      <p className="mt-1 text-[11px] leading-snug text-[#dfe3e8]">
        Model 1 bisa membedakan baris training dari klaim yang dihitung satu per satu lewat selisih pembulatan angka ({id(s.split)} split, {id(s.gainPct, 1)}% gain).
        Selain itu, test B tidak punya klaim normal kunjungan pertama. Hasilnya, pasien yang baru pertama ke sebuah RS mudah ditandai fraud.</p>
      <div className="mt-2.5 space-y-1.5">
        <Bar v={s.ujiB} warna={ABU} label="Recall · test B" />
        <Bar v={s.ujiBTanpa} warna={AMBER} label="Recall · test B tanpa bug" />
        <Bar v={s.gen2Recall} warna={MERAH} label="Recall · generator 2" />
        <Bar v={s.gen2Fpr} warna={MERAH} label="Normal ditandai · gen 2" />
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-[#8f99a8]">Test B = angka yang dipublikasikan. Generator 2 = {id(s.gen2Klaim)} klaim baru dari generator sintetis kedua, dihitung per klaim seperti di /testing.</p>
      <button type="button" onClick={onLihat} className="mt-2.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[#8abbff] hover:bg-white/[.06]">
        Lihat bagian Generator 2<Icon name="right" className="h-3.5 w-3.5" /></button>
    </div>
  );
}

/** One horizontal bar on a 0–100% scale. */
function Bar({ v, warna, label, kanan }: { v: number; warna: string; label: string; kanan?: string }) {
  return (
    <div className="grid items-center gap-2 text-[11px]" style={{ gridTemplateColumns: "minmax(0,1.15fr) minmax(0,1fr) 44px" }}>
      <span className="truncate text-[#dfe3e8]" title={label}>{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-white/[.06]"><span className="block h-full rounded-full" style={{ width: `${Math.max(0.8, v * 100)}%`, background: warna }} /></span>
      <span className="text-right tabular-nums text-white">{kanan ?? pct(v)}</span>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------ algorithms

/** Gradient boosting in one picture: small trees added one after another, each fixing the previous ones' mistakes. */
function PohonLGBM({ pohon, daun, warna, mono, acak = true }: { pohon: number; daun: number; warna: string; mono?: string; acak?: boolean }) {
  const tree = (x: number, label: string, redup = false) => (
    <g opacity={redup ? 0.55 : 1}>
      {[[x, 14, x - 20, 42], [x, 14, x + 20, 42], [x - 20, 42, x - 30, 70], [x - 20, 42, x - 10, 70], [x + 20, 42, x + 10, 70], [x + 20, 42, x + 30, 70]].map(([a, b, c, d], i) =>
        <line key={i} x1={a} y1={b} x2={c} y2={d} stroke="#5f6b7a" strokeWidth="1.2" />)}
      {[[x, 14], [x - 20, 42], [x + 20, 42]].map(([a, b], i) => <circle key={i} cx={a} cy={b} r="5.5" fill={warna} />)}
      {[x - 30, x - 10, x + 10, x + 30].map((a, i) => <rect key={i} x={a - 4} y={66} width="8" height="8" rx="2" fill="#dfe3e8" opacity={0.25 + 0.18 * i} />)}
      <text x={x} y={92} textAnchor="middle" fontSize="10" fill="#abb3bf">{label}</text>
    </g>
  );
  return (
    <div>
      <svg viewBox="0 0 400 100" className="mx-auto w-full max-w-[500px]" role="img" aria-label="Gradient boosting: pohon-pohon kecil dijumlahkan">
        {tree(40, "pohon 1")}
        <text x={88} y={48} textAnchor="middle" fontSize="16" fill="#8f99a8">+</text>
        {tree(136, "pohon 2")}
        <text x={184} y={48} textAnchor="middle" fontSize="16" fill="#8f99a8">+ … +</text>
        {tree(236, `pohon ${pohon}`, true)}
        <text x={286} y={48} textAnchor="middle" fontSize="16" fill="#8f99a8">=</text>
        <rect x={304} y={26} width={88} height={34} rx="8" fill={`${warna}33`} stroke={warna} />
        <text x={348} y={47} textAnchor="middle" fontSize="11" fontWeight="600" fill="#fff">peluang fraud</text>
      </svg>
      <p className="mt-1 text-[11px] leading-snug text-[#abb3bf]">Setiap pohon menanyakan beberapa pertanyaan ya/tidak (mis. &quot;tagihan ÷ tarif &gt; 1,4?&quot;). Pohon berikutnya fokus pada klaim yang masih salah ditebak pohon sebelumnya (gradient boosting). Hasil semua pohon dijumlahkan.</p>
      <div className="mt-2"><Chips warna={warna} isi={[`${id(pohon)} pohon`, `maks ${daun} daun per pohon`, "learning rate 0,05", ...(acak ? ["tiap pohon melihat 80% klaim acak"] : []), ...(mono ? [mono] : [])]} /></div>
    </div>
  );
}

/** Monotone: a rule finding can only raise the probability, never lower it. */
function Monoton({ warna }: { warna: string }) {
  const pts: [number, number][] = [[20, 74], [80, 74], [80, 50], [140, 50], [140, 22], [200, 22]];
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
      <svg viewBox="0 0 220 96" className="w-[46%] max-w-[220px] shrink-0" role="img" aria-label="Monotone: makin banyak sinyal, peluang tidak pernah turun">
        <line x1="20" y1="84" x2="210" y2="84" stroke="#5f6b7a" />
        <line x1="20" y1="10" x2="20" y2="84" stroke="#5f6b7a" />
        <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={warna} strokeWidth="2.5" />
        {[[50, 74, "0"], [110, 50, "1"], [170, 22, "2"]].map(([x, y, t]) => <g key={t}><circle cx={x} cy={y} r="3.5" fill={warna} /><text x={x} y={Number(y) - 7} textAnchor="middle" fontSize="9.5" fill="#dfe3e8">{t} sinyal</text></g>)}
        <text x="115" y="95" textAnchor="middle" fontSize="9" fill="#8f99a8">sinyal rule yang menyala</text>
        <text x="12" y="47" textAnchor="middle" fontSize="9" fill="#8f99a8" transform="rotate(-90 12 47)">peluang</text>
      </svg>
      <p className="text-[11.5px] leading-snug text-[#dfe3e8]"><b className="text-white">Monotone constraint:</b> kalau sinyal rule menyala, peluang fraud <b>hanya boleh naik</b>, tidak pernah turun. Model tidak bisa &quot;belajar&quot; mengabaikan temuan rule hanya karena pola kebetulan di training data.</p>
    </div>
  );
}

function TanpaML({ teks }: { teks: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-white/[.07] bg-white/[.03] p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#c98500]/20 text-[#f5c46b]"><Icon name="logic" className="h-5 w-5" /></span>
      <div><p className="text-[12px] font-semibold text-white">Tanpa machine learning</p><p className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{teks}</p></div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------ node visuals

/** Entity resolution: real Jaro-Winkler similarities from entitas.similarity, against the 93% line. */
function MeterNama() {
  const pasangan = [
    { a: "Tn. Budi Santoso", b: "BUDI SANTOSO", s: 1, hasil: "Sama persis setelah gelar & huruf besar dirapikan", w: AMBER },
    { a: "Siti Aminah", b: "Siti Amina", s: 0.982, hasil: "≥ 93%: dicatat \"mungkin identitas ganda\", tidak digabung", w: AMBER },
    { a: "Budi Santoso", b: "Budi Susanto", s: 0.921, hasil: "Di bawah 93%: dianggap orang berbeda", w: ABU },
    { a: "Budi Santoso", b: "Siti Aminah", s: 0.571, hasil: "Blocking key beda: tidak pernah dibandingkan", w: ABU },
  ];
  return (
    <div className="space-y-2">
      {pasangan.map((p) => (
        <div key={p.a + p.b} className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="rounded bg-white/[.07] px-1.5 py-0.5 font-mono text-white">{p.a}</span><span className="text-[#8f99a8]">vs</span>
            <span className="rounded bg-white/[.07] px-1.5 py-0.5 font-mono text-white">{p.b}</span>
          </div>
          <div className="relative mt-2 h-3 rounded-full bg-white/[.06]">
            <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${p.s * 100}%`, background: p.w }} />
            <span className="absolute -top-1 bottom-[-4px] w-[2px] bg-white" style={{ left: "93%" }} title="threshold 93%" />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px]"><span className="text-[#abb3bf]">{p.hasil}</span><b className="tabular-nums text-white">{pct(p.s)}</b></div>
        </div>
      ))}
      <p className="text-[10.5px] text-[#8f99a8]">Garis putih = threshold 93%. Nama di layar selalu disamarkan (B**** S*******).</p>
    </div>
  );
}

/** The 124 claim features the models read (the user, 2026-11-12: "bisa ga ada tombol buat view 124 fitur itu apa aja
 *  namanya, soalnya kan banyak fitur tambahan diluar kolom raw klaim"): the names in model order with their meaning, where
 *  the number comes from, and Model 1's gain share (fiturV3.ts, from testing/ekspor_fitur_ui.py). */
type GrupFitur = "sinyal" | "engine" | "angka" | "kosong" | "kategori";
const GRUP_FITUR: { k: GrupFitur; nama: string; ket: string; warna: string }[] = [
  { k: "sinyal", nama: "Sinyal rule", ket: "Hasil 44 rule engine: 0 kalau tidak menyala, sampai 1 (45 rule dikurangi anomaly VIME).", warna: AMBER },
  { k: "engine", nama: "Angka dari engine", ket: "Skor rule, skor model risiko platform, dan penanda jenis event.", warna: "#e8b04b" },
  { k: "angka", nama: "Angka klaim", ket: "6 diambil langsung dari klaim; sisanya dihitung dari riwayat peserta, referensi kode, dan profil RS.", warna: SERIES[0] },
  { k: "kosong", nama: "Penanda kosong", ket: "Satu per angka klaim: apakah nilainya kosong.", warna: ABU },
  { k: "kategori", nama: "Kategori 0/1", ket: "5 kolom kategori dipecah menjadi kolom ya/tidak (one-hot).", warna: SPESIALIS },
];
type Asal = { label: string; ikon: IconName };
const ASAL: Record<"klaim" | "riwayat" | "referensi" | "profil" | "engine" | "model", Asal> = {
  klaim: { label: "isi klaim", ikon: "doc" }, riwayat: { label: "riwayat peserta", ikon: "clock" }, referensi: { label: "referensi kode & tarif", ikon: "table" },
  profil: { label: "profil RS", ikon: "home" }, engine: { label: "engine", ikon: "bolt" }, model: { label: "model platform", ikon: "cpu" },
};
const ANGKA_KLAIM: Record<string, [string, keyof typeof ASAL]> = {
  biaya_tagih: ["Biaya yang ditagih RS", "klaim"], tarif_inacbg: ["Tarif INA-CBG", "klaim"], tarif_tambahan: ["Tarif tambahan (top-up special CMG)", "klaim"],
  los: ["LOS (lama rawat)", "klaim"], dx_sekunder: ["Jumlah diagnosis sekunder", "klaim"], ada_prosedur: ["Ada tindakan atau tidak", "klaim"],
  rasio_tagih_tarif: ["Tagihan ÷ tarif INA-CBG", "klaim"],
  frek_kode: ["Seberapa umum kode INA-CBG ini", "referensi"], frek_dx: ["Seberapa umum diagnosis utama ini", "referensi"],
  idx_los: ["LOS dibanding LOS normal kodenya", "referensi"], idx_tarif_kode: ["Tarif dibanding tarif normal kodenya", "referensi"],
  p_berat_dx: ["Peluang keparahan berat untuk diagnosis ini", "referensi"], p_prosedur_dx: ["Peluang ada tindakan untuk diagnosis ini", "referensi"],
  kunjungan_peserta: ["Jumlah kunjungan peserta sebelumnya", "riwayat"], kunjungan_peserta_faskes: ["Kunjungan peserta ke RS ini sebelumnya", "riwayat"],
  kembar: ["Jumlah klaim kembar (identik)", "riwayat"], hari_sejak_sebelumnya: ["Hari sejak klaim peserta sebelumnya", "riwayat"],
  f_jumlah_klaim: ["Volume klaim RS", "profil"], f_pct_rawat_inap: ["% rawat inap di RS", "profil"], f_pct_keparahan_berat: ["% keparahan berat di RS", "profil"],
  f_idx_los: ["Rata-rata indeks LOS RS", "profil"], f_pct_prosedur_rj: ["% rawat jalan dengan tindakan di RS", "profil"],
  f_pct_tarif_tambahan: ["% klaim dengan top-up di RS", "profil"], f_pct_kembar: ["% klaim kembar di RS", "profil"],
  f_rata_dx_sekunder: ["Rata-rata diagnosis sekunder RS", "profil"], f_idx_tarif_kode: ["Rata-rata indeks tarif RS", "profil"],
};
const KATEGORI: Record<string, string> = { tingkat_pelayanan: "Tingkat pelayanan", inacbg_keparahan: "Keparahan INA-CBG", inacbg_tipe_kasus: "Tipe kasus INA-CBG",
  jenis_fkrtl: "Jenis RS", kelas_rawat: "Kelas rawat" };
const LAIN: Record<string, [string, keyof typeof ASAL]> = {
  "jenis:fkrtl": ["Jenis event: klaim RS (FKRTL)", "engine"], "jenis:fktp": ["Jenis event: kunjungan FKTP", "engine"],
  "jenis:nonkap": ["Jenis event: klaim nonkapitasi", "engine"], "jenis:faskes": ["Jenis event: event RS", "engine"],
  ml_log_risiko: ["Skor model risiko platform (log)", "model"], ml_kelipatan: ["Skor model platform ÷ threshold segmennya", "model"],
  log_biaya: ["Biaya ditagih (log)", "klaim"], skor_aturan: ["Skor rule (setelah mitigasi)", "engine"],
  skor_tanpa_mitigasi: ["Skor rule tanpa mitigasi", "engine"], mitigasi_n: ["Jumlah mitigasi yang berlaku", "engine"],
};

function infoFitur(nama: string): { grup: GrupFitur; label: string; asal: Asal } {
  if (nama.startsWith("s:")) {
    const k = nama.slice(2), src = SUMBER[SUMBER_RULE[k]];
    return { grup: "sinyal", label: SINYAL[k]?.label ?? k, asal: src ?? ASAL.engine };
  }
  if (LAIN[nama]) return { grup: "engine", label: LAIN[nama][0], asal: ASAL[LAIN[nama][1]] };
  const k = nama.replace(/^klaim: /, "");
  if (k.includes("=")) {
    const [a, b] = k.split("=");
    return { grup: "kategori", label: `${KATEGORI[a] ?? a}: ${b}`, asal: ASAL.klaim };
  }
  if (k.startsWith("na_")) {
    const x = ANGKA_KLAIM[k.slice(3)];
    return { grup: "kosong", label: `${x?.[0] ?? k.slice(3)} kosong?`, asal: ASAL[x?.[1] ?? "klaim"] };
  }
  const x = ANGKA_KLAIM[k];
  return { grup: "angka", label: x?.[0] ?? k, asal: ASAL[x?.[1] ?? "klaim"] };
}

function DaftarFitur() {
  const [buka, setBuka] = useState<Set<GrupFitur>>(() => new Set());
  const [cari, setCari] = useState("");
  const rows = FITUR_V3.map((f, i) => ({ ...f, no: i + 1, ...infoFitur(f.nama) }));
  const q = cari.trim().toLowerCase();
  const tampil = (r: (typeof rows)[number]) => !q || r.nama.toLowerCase().includes(q) || r.label.toLowerCase().includes(q);
  const dipakai = rows.filter((r) => r.gain > 0).length;
  const semua = buka.size === GRUP_FITUR.length;
  const ganti = (k: GrupFitur) => setBuka((b) => { const x = new Set(b); if (x.has(k)) x.delete(k); else x.add(k); return x; });
  const persen = (v: number) => (v === 0 ? "0%" : v < 0.001 ? "<0,1%" : pct(v, 1));
  return (
    <div className="space-y-2">
      <div className="flex h-8 overflow-hidden rounded-md">
        {GRUP_FITUR.map((g) => {
          const n = rows.filter((r) => r.grup === g.k).length;
          return <button key={g.k} type="button" onClick={() => ganti(g.k)} title={`${g.nama}: ${n} feature`} style={{ flexGrow: n, background: `${g.warna}cc` }}
            className="flex min-w-0 items-center justify-center border-r border-[#1b2128] text-[11px] font-semibold text-white hover:brightness-110">{n}</button>;
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[#abb3bf]">
        {GRUP_FITUR.map((g) => <span key={g.k} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: g.warna }} />{g.nama}</span>)}
        <b className="text-white">= {rows.length} feature</b>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 rounded-full bg-[#199e70]/20 px-2 py-0.5 text-[10.5px] text-[#7ee2c0]"><Icon name="check" className="h-3 w-3" />{dipakai} dipakai Model 1</span>
        <span className="flex items-center gap-1 rounded-full bg-white/[.07] px-2 py-0.5 text-[10.5px] text-[#c5cbd3]"><Icon name="minus" className="h-3 w-3" />{rows.length - dipakai} tidak pernah dipakai</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setBuka(semua ? new Set() : new Set(GRUP_FITUR.map((g) => g.k)))}
          className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[.04] px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:bg-white/[.08]">
          <Icon name={semua ? "minus" : "list"} className="h-3.5 w-3.5" />{semua ? "Tutup daftar" : `Lihat semua ${rows.length} feature`}</button>
        <label className="flex min-w-[160px] flex-1 items-center gap-1.5 rounded-md border border-white/10 bg-white/[.03] px-2 py-1.5">
          <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-[#8f99a8]" />
          <input value={cari} onChange={(e) => setCari(e.target.value)} placeholder="Cari feature, mis. LOS atau tarif" aria-label="Cari feature"
            className="w-full bg-transparent text-[11.5px] text-white placeholder:text-[#6b7480] focus:outline-none" />
        </label>
      </div>
      {GRUP_FITUR.map((g) => {
        const isi = rows.filter((r) => r.grup === g.k && tampil(r));
        if (q && !isi.length) return null;
        const on = buka.has(g.k) || !!q;
        const maks = Math.max(...rows.filter((r) => r.grup === g.k).map((r) => r.gain), 1e-9);
        const total = rows.filter((r) => r.grup === g.k).reduce((a, r) => a + r.gain, 0);
        return (
          <div key={g.k} className="overflow-hidden rounded-lg border border-white/[.07]" style={{ background: on ? `${g.warna}10` : "rgba(255,255,255,.02)" }}>
            <button type="button" onClick={() => ganti(g.k)} aria-expanded={on} className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[.03]">
              <Icon name={on ? "down" : "right"} className="h-3.5 w-3.5 shrink-0 text-[#8f99a8]" />
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: g.warna }} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white">{g.nama} <span className="font-normal tabular-nums text-[#8f99a8]">{rows.filter((r) => r.grup === g.k).length}</span></span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-[#abb3bf]">{persen(total)} gain Model 1</span>
            </button>
            {on && (
              <div className="border-t border-white/[.06] px-2.5 pb-2 pt-1.5">
                <p className="mb-1.5 text-[10.5px] text-[#8f99a8]">{g.ket}</p>
                <div className="space-y-1">
                  {isi.map((r) => (
                    <div key={r.nama} className="grid items-center gap-2 rounded-md bg-white/[.025] px-2 py-1.5" style={{ gridTemplateColumns: "22px minmax(0,1.6fr) minmax(0,1fr)" }}>
                      <span className="text-right text-[10px] tabular-nums text-[#6b7480]">{r.no}</span>
                      <div className="min-w-0">
                        <p className="truncate text-[11.5px] text-white" title={r.label}>{r.label}</p>
                        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10px] text-[#8f99a8]"><span className="min-w-0 break-all font-mono">{r.nama}</span>
                          <span className="flex shrink-0 items-center gap-0.5"><Icon name={r.asal.ikon} className="h-3 w-3" />{r.asal.label}</span></p>
                      </div>
                      {r.gain > 0 ? (
                        <div className="flex items-center gap-1.5" title={`Porsi gain Model 1: ${persen(r.gain)}`}>
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/[.06]"><span className="block h-full rounded-full" style={{ width: `${Math.max(3, (r.gain / maks) * 100)}%`, background: g.warna }} /></span>
                          <span className="w-11 shrink-0 text-right text-[10.5px] tabular-nums text-white">{persen(r.gain)}</span>
                        </div>
                      ) : <span className="justify-self-end rounded bg-white/[.06] px-1.5 py-0.5 text-[10px] text-[#8f99a8]">tidak dipakai</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <p className="pt-1 text-[10.5px] leading-snug text-[#8f99a8]">Gain = porsi yang dipakai Model 1 (kolom feature itu sendiri ditambah rata-ratanya di 4 kelompok neighbour), dari {FITUR_MODEL}. Panjang bar dibandingkan dalam kelompok yang sama. Feature dengan gain 0 tidak pernah dipakai Model 1; sinyal rule-nya tetap ikut lewat skor rule, spesialis, dan rule route.</p>
    </div>
  );
}

/** All 45 rules, one dropdown per group (the user, 2026-11-12: "saya mau dropdown juga list semua rule, jadi jelas, bikin
 *  UI nya visual"); a group with its own node links to it. */
function DaftarRule({ rute, pilih }: { rute: string[]; pilih: (n: NodeV3) => void }) {
  const [buka, setBuka] = useState<Set<string>>(() => new Set());
  const semua = buka.size === GRUP_SINYAL.length;
  const ganti = (n: string) => setBuka((b) => { const x = new Set(b); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-[#abb3bf]">Klik kelompok untuk melihat rule-nya.</p>
        <button type="button" onClick={() => setBuka(semua ? new Set() : new Set(GRUP_SINYAL.map((g) => g.nama)))}
          className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white hover:bg-white/[.06]">
          <Icon name={semua ? "minus" : "list"} className="h-3.5 w-3.5" />{semua ? "Tutup semua" : "Buka semua 45 rule"}</button>
      </div>
      {GRUP_SINYAL.map((g) => {
        const on = buka.has(g.nama);
        return (
          <div key={g.nama} className="overflow-hidden rounded-lg border border-white/[.07]" style={{ background: on ? `${g.warna}10` : "rgba(255,255,255,.02)" }}>
            <div className="flex items-center gap-1 pr-1.5">
              <button type="button" onClick={() => ganti(g.nama)} aria-expanded={on} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[.03]">
                <Icon name={on ? "down" : "right"} className="h-3.5 w-3.5 shrink-0 text-[#8f99a8]" />
                <span className="w-[100px] shrink-0 truncate text-[12px] font-semibold text-white">{g.nama}</span>
                <span className="flex min-w-0 flex-1 flex-wrap gap-1">{g.kode.map((k) => <span key={k} className="h-3 w-3 rounded-full" style={{ background: g.warna }} />)}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-[#8f99a8]">{g.kode.length} rule</span>
              </button>
              {g.node && g.node !== "engine" && (
                <button type="button" onClick={() => pilih(g.node!)} title={`Buka ${META[g.node].nama}`}
                  className="hidden shrink-0 items-center gap-0.5 rounded px-1.5 py-1 text-[10.5px] text-[#8abbff] hover:bg-white/[.06] sm:flex">{META[g.node].nama}<Icon name="right" className="h-3 w-3" /></button>
              )}
            </div>
            {on && (
              <div className="border-t border-white/[.06] p-2">
                {g.ket && <p className="mb-1.5 text-[10.5px] text-[#8f99a8]">{g.ket}</p>}
                <KartuSinyal kode={g.kode} warna={g.warna} rute={rute} />
              </div>
            )}
          </div>
        );
      })}
      <p className="pt-1 text-[10.5px] leading-snug text-[#8f99a8]">Bar di tiap rule = skor kalau rule itu menyala sendirian dengan kekuatan penuh (garis = threshold 45 PERIKSA dan 75 TAHAN). Bobot ini default dan bisa dikalibrasi ulang dari keputusan kasus.</p>
    </div>
  );
}

/** How the engine turns fired rules into one score: 100 × (1 − e^(−Σ weight × strength × mitigation)), real weights. */
function SkorAturan() {
  const contoh: { judul: string; bagian: { label: string; v: number; w: string }[]; ket: string }[] = [
    { judul: "Pasien dirawat inap lagi 2 hari setelah pulang, di RS yang sama, diagnosis sama", bagian: [{ label: "Unbundling episode · bobot 0,9", v: 0.9, w: AMBER }], ket: "" },
    { judul: "Kasus yang sama, tapi rawat inap kedua masuk lewat IGD (darurat)", bagian: [{ label: "Unbundling 0,9 × 50%", v: 0.45, w: AMBER }], ket: "darurat = alasan sah, bobot rule dipotong 50%" },
    { judul: "Kasus pertama, ditambah peserta PBI ditagih kelas di atas haknya", bagian: [{ label: "Unbundling 0,9", v: 0.9, w: AMBER }, { label: "Kelas di atas hak 1,0", v: 1.0, w: PINK }], ket: "" },
  ];
  const skor = (t: number) => 100 * (1 - Math.exp(-t));
  return (
    <div className="space-y-2.5">
      {contoh.map((c) => {
        const total = c.bagian.reduce((s, b) => s + b.v, 0), s = skor(total), [p, w] = putusan(s);
        let kiri = 0;
        return (
          <div key={c.judul} className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
            <div className="flex items-start justify-between gap-2"><p className="text-[11.5px] text-white">{c.judul}</p>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ background: `${w}26`, color: w }}>{id(s)} · {p}</span></div>
            <div className="relative mt-2 h-4 rounded bg-white/[.06]">
              {c.bagian.map((b) => {
                const a = skor(kiri), z = skor(kiri + b.v);
                kiri += b.v;
                return <span key={b.label} className="absolute inset-y-0" style={{ left: `${a}%`, width: `${z - a}%`, background: b.w, opacity: 0.85 }} title={b.label} />;
              })}
              {[45, 75].map((t) => <span key={t} className="absolute -top-1 bottom-[-4px] w-px bg-white/70" style={{ left: `${t}%` }} />)}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[#abb3bf]">{c.bagian.map((b) => <span key={b.label} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: b.w }} />{b.label}</span>)}
              {c.ket && <span className="text-[#8f99a8]">({c.ket})</span>}</div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-[#8f99a8]">
        <span>garis = threshold 45 (PERIKSA) dan 75 (TAHAN)</span>
        <span className="font-mono text-[#c5cbd3]">skor = 100 × (1 − e^−Σ bobot×kekuatan×mitigasi)</span>
      </div>
      <p className="text-[11px] leading-snug text-[#abb3bf]">Makin banyak bukti, skor makin dekat ke 100 tapi tidak pernah lewat. Di v3, skor ini <b className="text-white">tidak memutuskan sendiri</b>: skor dan setiap sinyal menjadi feature untuk model di langkah berikutnya.</p>
      <div><p className="mb-1 text-[11px] text-[#dfe3e8]">Mitigasi (alasan sah yang menurunkan bobot):</p>
        <Chips warna={HIJAU} isi={["Masuk lewat IGD", "Pulang paksa di episode sebelumnya", "Rujukan berjenjang (naik kelas RS)", "Pindah rawat satu provinsi", "Bukti alat IoMT terverifikasi", "Jejaring rujukan satu kab/kota"]} /></div>
    </div>
  );
}

/** Where Model 1 (v3) gets its gain, by feature group: booster gain of testing/model_v3 (trained 2026-11-12), own claim and
 *  neighbour blocks together. VIME's embedding and anomaly are not among the features (fitur.engine_cols drops them). */
const GAIN_M1 = [
  { k: "Skor rule dari engine", v: 0.5655, w: AMBER },
  { k: "Field klaim (biaya, LOS, tarif, …), sendiri + neighbour", v: 0.3468, w: SERIES[0] },
  { k: "45 sinyal rule satu per satu", v: 0.0751, w: AMBER },
  { k: "Skor model risiko platform", v: 0.0121, w: ABU },
  { k: "Embedding & anomaly VIME", v: 0, w: MERAH },
];

function GainModel1() {
  return (
    <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
      <p className="mb-2 text-[11.5px] text-white">Dari mana Model 1 belajar <span className="text-[#8f99a8]">· porsi gain, model v3</span></p>
      <div className="space-y-1.5">{GAIN_M1.map((g) => <Bar key={g.k} v={g.v} warna={g.w} label={g.k} kanan={pct(g.v, 1)} />)}</div>
      <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Kuning = output engine: sekitar 64% dari semua yang dipelajari Model 1.</p>
    </div>
  );
}

/** What is left of VIME in v3 (the user, 2026-11-12: "kenapa masih ada engine realtime + SSL, padahal udh ada lightgbm"). */
function StatusVime() {
  const baris: { ikon: IconName; w: string; judul: string; isi: string }[] = [
    { ikon: "x", w: MERAH, judul: "Embedding 16 angka", isi: "Tidak dipakai v3: dikeluarkan dari feature saat training." },
    { ikon: "minus", w: AMBER, judul: "Anomaly score", isi: "Tidak dibaca langsung. Hanya menambah skor rule kalau menyala (di atas p99,9, sekitar 0,1% klaim, bobot 0,4)." },
    { ikon: "check", w: HIJAU, judul: "Penskalaan 70 field klaim", isi: "Dipakai, tapi ini cuma median/IQR scaling, bukan self-supervised learning." },
  ];
  return (
    <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
      <p className="mb-2 text-[11.5px] font-semibold text-white">Bagaimana dengan VIME (self-supervised)?</p>
      <div className="space-y-1.5">{baris.map((b) => (
        <div key={b.judul} className="flex items-start gap-2">
          <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ background: `${b.w}2e`, color: b.w }}><Icon name={b.ikon} className="h-3 w-3" /></span>
          <p className="text-[11px] leading-snug text-[#dfe3e8]"><b className="text-white">{b.judul}:</b> {b.isi}</p>
        </div>))}</div>
      <p className="mt-2 text-[10.5px] leading-snug text-[#8f99a8]">VIME masih terpasang di engine karena dipakai Realtime Fraud dan Active Learning, tapi hampir tidak menyumbang ke keputusan v3.</p>
    </div>
  );
}

/** Model 1's graph: the claim and its earlier neighbours over four relations, each block averaged. */
function GrafTetangga() {
  const pos: Record<string, [number, number]> = { peserta: [96, 92], faskes: [424, 92], faskes_kode: [96, 222], kode: [424, 222] };
  const c: [number, number] = [260, 157];
  return (
    <svg viewBox="0 0 520 304" className="mx-auto w-full max-w-[560px]" role="img" aria-label="Klaim ini dan neighbour-nya di empat relasi graph">
      <defs><marker id="atv3-panah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8f99a8" /></marker></defs>
      {Object.entries(pos).map(([k, [x, y]]) => {
        const r = RELASI[k], n = r.maks === 5 ? 4 : 6, atas = y < c[1];
        const dx = c[0] - x, dy = c[1] - y, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
        return (
          <g key={k}>
            <line x1={x + ux * 34} y1={y + uy * 34} x2={c[0] - ux * 36} y2={c[1] - uy * 36} stroke="#8f99a8" strokeWidth="1.4" markerEnd="url(#atv3-panah)" />
            <text x={(x + c[0]) / 2} y={(y + c[1]) / 2 + 4} textAnchor="middle" fontSize="11.5" fill="#c5cbd3" stroke="#1b2128" strokeWidth="5" paintOrder="stroke">rata-rata</text>
            {Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return <circle key={i} cx={x + Math.cos(a) * 18} cy={y + Math.sin(a) * 18} r="7" fill={r.warna} opacity="0.85" />; })}
            <text x={x} y={atas ? y - 50 : y + 46} textAnchor="middle" fontSize="13" fontWeight="600" fill="#fff">{r.nama}</text>
            <text x={x} y={atas ? y - 34 : y + 62} textAnchor="middle" fontSize="11.5" fill="#8f99a8">maks {r.maks} klaim sebelumnya</text>
          </g>
        );
      })}
      <circle cx={c[0]} cy={c[1]} r="30" fill={SERIES[1]} />
      <text x={c[0]} y={c[1] - 2} textAnchor="middle" fontSize="13" fontWeight="600" fill="#fff">klaim</text>
      <text x={c[0]} y={c[1] + 13} textAnchor="middle" fontSize="13" fontWeight="600" fill="#fff">ini</text>
    </svg>
  );
}

/** 124 own features + 4 × 124 neighbour means + 4 neighbour counts = 624. */
function BlokFitur() {
  const blok = [{ n: "klaim sendiri", w: SERIES[1] }, ...Object.values(RELASI).map((r) => ({ n: r.nama.replace(" sama", ""), w: r.warna }))];
  return (
    <div>
      <div className="flex h-7 overflow-hidden rounded-md">
        {blok.map((b) => <span key={b.n} className="flex flex-1 items-center justify-center border-r border-[#1b2128] text-[9.5px] font-medium text-white" style={{ background: `${b.w}bb` }} title={`${b.n}: 124 feature`}>124</span>)}
        <span className="flex w-6 items-center justify-center bg-white/20 text-[9.5px] text-white" title="jumlah neighbour per relasi">4</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[#abb3bf]">{blok.map((b) => <span key={b.n} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: b.w }} />{b.n}</span>)}
        <span>+ jumlah neighbour</span><b className="text-white">= 624 feature</b></div>
    </div>
  );
}

/** Isotonic calibration: an illustrative staircase that never goes down. */
function Kalibrasi() {
  const tangga: [number, number][] = [[0, 0.01], [0.25, 0.01], [0.25, 0.04], [0.42, 0.04], [0.42, 0.16], [0.55, 0.16], [0.55, 0.42], [0.66, 0.42], [0.66, 0.71], [0.8, 0.71], [0.8, 0.93], [1, 0.93], [1, 0.99]];
  const X = (v: number) => 30 + v * 170, Y = (v: number) => 112 - v * 100;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
      <svg viewBox="0 0 210 132" className="w-[46%] max-w-[230px] shrink-0" role="img" aria-label="Ilustrasi isotonic regression">
        <line x1="30" y1="112" x2="200" y2="112" stroke="#5f6b7a" /><line x1="30" y1="12" x2="30" y2="112" stroke="#5f6b7a" />
        <line x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} stroke="#5f6b7a" strokeDasharray="3 3" />
        <polyline points={tangga.map(([a, b]) => `${X(a)},${Y(b)}`).join(" ")} fill="none" stroke={SERIES[0]} strokeWidth="2.5" />
        <text x="115" y="127" textAnchor="middle" fontSize="9" fill="#8f99a8">skor gabungan</text>
        <text x="14" y="62" textAnchor="middle" fontSize="9" fill="#8f99a8" transform="rotate(-90 14 62)">peluang fraud</text>
        <text x="36" y="20" fontSize="8.5" fill="#8f99a8">ilustrasi bentuk</text>
      </svg>
      <p className="text-[11.5px] leading-snug text-[#dfe3e8]"><b className="text-white">Isotonic regression</b> mengubah skor mentah menjadi peluang yang bisa dipercaya: kalau sistem bilang <b>70%</b>, kira-kira 70 dari 100 klaim seperti itu memang fraud. Kurvanya berbentuk tangga yang tidak pernah turun, dan dicocokkan pada skor out-of-fold (klaim yang tidak dipakai melatih).</p>
    </div>
  );
}

/** The rule route's three questions. */
function CekRute({ a }: { a: DataV3 }) {
  const cek = [
    { t: "Ada sinyal rule yang menyala?", s: "dari 45 rule engine" },
    { t: `Rule itu spesifik?`, s: `menyala di ≤ ${pct(a.rute.maks_normal, 1)} klaim normal training data` },
    { t: "Model belum cukup pengalaman?", s: `< ${a.rute.min_contoh} contoh fraud berlabel untuk rule itu` },
  ];
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-stretch">
      {cek.map((c, i) => (
        <Fragment key={c.t}>
          {i > 0 && <div className="flex items-center justify-center gap-1 text-[10px] text-[#7ee2c0]"><span className="sm:hidden">ya</span><Icon name="right" className="h-4 w-4 rotate-90 sm:rotate-0" /></div>}
          <div className="flex-1 rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#c98500]/25 text-[11px] font-semibold text-[#f5c46b]">?</span>
            <p className="mt-1.5 text-[11.5px] font-semibold leading-snug text-white">{c.t}</p><p className="mt-0.5 text-[10.5px] leading-snug text-[#abb3bf]">{c.s}</p>
          </div>
        </Fragment>
      ))}
      <div className="flex items-center justify-center text-[#7ee2c0]"><Icon name="right" className="h-4 w-4 rotate-90 sm:rotate-0" /></div>
      <div className="flex flex-col items-center justify-center rounded-lg border border-[#c98500]/50 bg-[#c98500]/15 p-2.5 text-center sm:w-24">
        <Icon name="eye" className="h-5 w-5 text-[#f5c46b]" /><p className="mt-1 text-[12px] font-semibold text-white">PERIKSA</p><p className="text-[10px] text-[#f2d49b]">ya, ketiganya</p>
      </div>
    </div>
  );
}

/** The label-free ring rule: this member and others sharing the same hospitals within ±3 days. */
function Ring({ a }: { a: DataV3 }) {
  const rs: [number, number][] = [[70, 96], [290, 96]];
  const org: { x: number; y: number; n: string; ini?: boolean }[] = [{ x: 180, y: 30, n: "P · klaim ini", ini: true }, { x: 180, y: 96, n: "Q" }, { x: 180, y: 162, n: "R" }];
  return (
    <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
      <svg viewBox="0 0 360 196" className="mx-auto w-full max-w-[440px]" role="img" aria-label="Peserta lain berbagi RS yang sama dalam ±3 hari">
        {org.map((o) => rs.map(([x, y], j) => <line key={o.n + j} x1={o.x} y1={o.y} x2={x} y2={y} stroke={o.ini ? SERIES[2] : "#7e8a99"} strokeWidth={o.ini ? 2.2 : 1.4} />))}
        {rs.map(([x, y], j) => <g key={j}><rect x={x - 30} y={y - 16} width="60" height="32" rx="6" fill="#2a3138" stroke={AMBER} /><text x={x} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="#fff">RS {j ? "B" : "A"}</text></g>)}
        {org.map((o) => <g key={o.n}><circle cx={o.x} cy={o.y} r={o.ini ? 13 : 11} fill={o.ini ? SERIES[2] : "#5f6b7a"} />
          <text x={o.x} y={o.y + 4} textAnchor="middle" fontSize="10" fontWeight="600" fill="#fff">{o.n[0]}</text>
          {o.ini && <text x={o.x} y={o.y - 18} textAnchor="middle" fontSize="10" fill="#7ee2c0">klaim ini</text>}</g>)}
        <text x="180" y="192" textAnchor="middle" fontSize="10" fill="#abb3bf">semua kunjungan dalam ±{a.rule_jaringan.hari} hari</text>
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[#dfe3e8]">
        <span className="rounded bg-white/[.07] px-1.5 py-0.5">Q dan R juga ke RS A dan RS B</span><span className="text-[#8f99a8]">→</span>
        <span className="rounded bg-white/[.07] px-1.5 py-0.5"><b>2</b> peserta lain</span><span className="text-[#8f99a8]">≥</span>
        <span className="rounded bg-white/[.07] px-1.5 py-0.5">threshold <b>{a.rule_jaringan.ambang}</b></span><span className="text-[#8f99a8]">→</span>
        <span className="rounded px-1.5 py-0.5 font-semibold text-white" style={{ background: `${SERIES[2]}40` }}>tandai</span><ModusChip k="M10" />
      </div>
    </div>
  );
}

/** The final gate: probability or one of the two rules; then the AI only explains. */
function Gerbang({ a }: { a: DataV3 }) {
  const masuk = [{ t: `Peluang ≥ ${pct(a.ambang_peluang)}`, w: SERIES[0], i: "layers" as IconName }, { t: "Rule route menyala", w: AMBER, i: "logic" as IconName },
    { t: "Network rule menyala", w: SERIES[2], i: "constellation" as IconName }];
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[1fr_44px_1.25fr]">
      <div className="space-y-1.5">{masuk.map((m) => (
        <div key={m.t} className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] text-white" style={{ borderColor: `${m.w}55`, background: `${m.w}14` }}>
          <Icon name={m.i} className="h-4 w-4" />{m.t}</div>))}</div>
      <div className="flex items-center justify-center"><span className="rounded-full bg-white/10 px-2 py-1 text-[10.5px] font-semibold text-white">ATAU</span></div>
      <div className="space-y-1.5">
        <div className="rounded-lg border border-[#e5484d]/50 bg-[#e5484d]/12 p-2.5">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-white"><Icon name="alert" className="h-4 w-4 text-[#ff8e93]" />Terdeteksi → AI menjelaskan</p>
          <div className="mt-1.5"><Chips warna={MERAH} isi={["jenis fraud (1–4 modus Permenkes)", "alasan", "graph di sekitar klaim", "yang perlu diperbaiki"]} /></div>
        </div>
        <div className="rounded-lg border border-[#199e70]/50 bg-[#199e70]/12 p-2.5">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-white"><Icon name="check" className="h-4 w-4 text-[#7ee2c0]" />Tidak satu pun → &quot;Klaim aman&quot;</p>
        </div>
      </div>
    </div>
  );
}

/** 100 dots: how many of 100 flagged claims are fraud, and how many of 100 fraud claims are caught. */
function SeratusTitik({ nilai, warna, judul, ya, tidak }: { nilai: number; warna: string; judul: string; ya: string; tidak: string }) {
  const n = Math.round(nilai * 100);
  return (
    <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
      <p className="text-[11.5px] text-white">{judul}</p>
      <div className="mt-2 grid w-full max-w-[170px] grid-cols-10 gap-[3px]">{Array.from({ length: 100 }, (_, i) => <span key={i} className="aspect-square rounded-full" style={{ background: i < n ? warna : "rgba(255,255,255,.14)" }} />)}</div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10.5px] text-[#abb3bf]"><span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: warna }} /><b className="text-white">{n}</b> {ya}</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-white/20" /><b className="text-white">{100 - n}</b> {tidak}</span></div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------ node contents

type Isi = { kalimat: string; ibarat: string; langkah: { ikon: IconName; teks: string }[]; tambahan?: { judul: string; sub?: string; isi: ReactNode }; rule: ReactNode; ruleJudul?: string; logika: ReactNode; algoritma: ReactNode; hasil: ReactNode };

function sumberUji(a: DataV3) {
  return `test B · ${id(a.klaim)} klaim yang tidak pernah dilihat model`;
}

function isiSpesialis(k: "koding" | "tagihan" | "episode" | "identitas", a: DataV3, w: string): Isi {
  const s = SPES[k], td = a.tak_dikenal.find((t) => t.famili === k);
  const skema = a.skema.filter((x) => x.famili === k).sort((x, y) => x.recall_v3 - y.recall_v3);
  const bobot = a.bobot_fusi[k] ?? 0;
  const lemah = skema.filter((x) => x.recall_v3 < 0.8);
  return {
    kalimat: s.kalimat,
    ibarat: "Seperti dokter spesialis: hanya memeriksa bagian yang menjadi keahliannya, jadi tidak terganggu oleh jenis fraud lain.",
    langkah: [
      { ikon: "logic", teks: `Ambil ${s.sinyal.length} sinyal rule keluarga ${FAM[k]}` },
      { ikon: "doc", teks: `Tambah ${s.data.length} data klaim yang relevan` },
      { ikon: "graph", teks: `Tambah rata-rata neighbour (${s.relasi.map((r) => RELASI[r].nama.replace(" sama", "")).join(", ")})` },
      { ikon: "gauge", teks: `Keluarkan peluang fraud keluarga ${FAM[k]}` },
    ],
    rule: (
      <>
        <KartuSinyal kode={s.sinyal} warna={w} rute={a.rute.sinyal} />
        <p className="mb-1 mt-3 text-[11px] text-[#dfe3e8]">Data klaim yang juga dilihat:</p><Chips isi={s.data} />
        <p className="mb-1 mt-2.5 text-[11px] text-[#dfe3e8]">Neighbour di graph:</p><Chips isi={s.relasi.map((r) => RELASI[r].nama)} warna={SERIES[1]} />
      </>
    ),
    logika: (
      <div className="space-y-2.5">
        <Monoton warna={w} />
        <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
          <p className="mb-2 text-[11.5px] text-white">Dilatih dengan apa?</p>
          <div className="grid grid-cols-3 gap-1.5 text-center">
            {[{ t: `Fraud keluarga ${FAM[k]}`, w, ok: true }, { t: "Klaim normal", w: ABU, ok: true }, { t: "Fraud keluarga lain", w: "#5f6b7a", ok: false }].map((g) => (
              <div key={g.t} className={`rounded-md p-2 ${g.ok ? "" : "opacity-60"}`} style={{ background: `${g.w}22` }}>
                <div className="mx-auto grid w-fit grid-cols-4 gap-[3px]">{Array.from({ length: 8 }, (_, i) => <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: g.w }} />)}</div>
                <p className="mt-1.5 text-[10.5px] leading-tight text-[#dfe3e8]">{g.t}</p>
                <p className={`mt-0.5 flex items-center justify-center gap-0.5 text-[10px] ${g.ok ? "text-[#7ee2c0]" : "text-[#ff8e93]"}`}><Icon name={g.ok ? "check" : "x"} className="h-3 w-3" />{g.ok ? "dipakai" : "tidak dipakai"}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10.5px] leading-snug text-[#abb3bf]">Jadi jenis fraud yang jarang tidak tenggelam oleh jenis yang sering, dan riwayat peserta tidak bisa &quot;menggantikan&quot; bukti skemanya.</p>
        </div>
      </div>
    ),
    algoritma: <PohonLGBM pohon={300} daun={15} warna={w} mono={`monotone pada ${s.sinyal.length} sinyal rule-nya`} />,
    hasil: (
      <>
        <div className="grid grid-cols-2 gap-1.5">
          <Angka nilai={id(a.mutu_lapisan[k] ?? 0, 3)} label="AUPRC out-of-fold" ket={`fraud keluarga ${FAM[k]} vs klaim normal`} />
          <Angka nilai={pct(bobot, bobot < 0.1 ? 1 : 0)} label="bobot di fusion" ket="bagian gain stacker" warna={bobot < 0.05 ? "#f5c46b" : "#fff"} />
        </div>
        <p className="mb-1.5 mt-3 text-[11px] text-[#dfe3e8]">Skema keluarga ini di {sumberUji(a)}:</p>
        <div className="space-y-1.5">{skema.map((x) => <Bar key={x.skema} v={x.recall_v3} warna={x.recall_v3 < 0.8 ? MERAH : HIJAU} label={`${SKEMA_EN[x.skema] ?? x.label} · n ${id(x.n)}`} />)}</div>
        <p className="mt-1 text-[10.5px] text-[#8f99a8]">Bar = bagian fraud yang tertangkap oleh seluruh sistem v3 (bukan spesialis ini saja).</p>
        {td && (
          <>
            <p className="mb-1.5 mt-3 text-[11px] text-[#dfe3e8]">Kalau keluarga ini <b>tidak pernah ada</b> di training data (jenis fraud baru):</p>
            <div className="space-y-1.5">
              <Bar v={td.recall_v3_dikenal} warna={HIJAU} label="v3, keluarga sudah dikenal" />
              <Bar v={td.recall_v3} warna={td.recall_v3 < 0.5 ? MERAH : AMBER} label="v3, keluarga belum pernah dilihat" />
              {td.recall_v1 !== undefined && <Bar v={td.recall_v1} warna={ABU} label="v1, keluarga belum pernah dilihat" />}
            </div>
          </>
        )}
        <Batasan isi={[
          ...(bobot < 0.05 ? [`Fusion hanya memberi spesialis ini ${pct(bobot, 1)} bobot: Model 1 sudah membaca sinyal yang sama. Spesialis lebih berguna sebagai penjelas per modus dan cadangan untuk jenis fraud baru.`] : []),
          ...lemah.map((x) => `${SKEMA_EN[x.skema] ?? x.label}: hanya ${pct(x.recall_v3)} tertangkap di test B.`),
          "AUPRC spesialis dihitung pada keluarganya sendiri vs normal: tugas yang lebih mudah dari tugas sistem.",
        ]} />
      </>
    ),
  };
}

function isiNode(n: NodeV3, a: DataV3, ruteV2: RuteV2 | undefined, pilih: (n: NodeV3) => void): Isi {
  const w = META[n].warna, v = a.ringkas.v3;
  switch (n) {
    case "klaim":
      return {
        kalimat: "Sebelum dinilai, sistem memastikan dulu klaim ini milik pasien siapa dan dari RS mana.",
        ibarat: "Seperti petugas pendaftaran yang mencocokkan pasien dengan kartunya sebelum berkas diteruskan.",
        langkah: [{ ikon: "doc", teks: "Klaim masuk: no RM, nama, SEP, kode, tagihan" }, { ikon: "search", teks: "Cari pasien yang cocok (blocking key + kemiripan nama)" },
          { ikon: "link", teks: "Klaim ditempel ke satu entitas pasien & RS" }, { ikon: "bolt", teks: "Diteruskan ke engine realtime" }],
        ruleJudul: "Rule entity resolution",
        rule: <JikaMaka isi={[
          { jika: "No RM sama dari RS yang sama", maka: "Pasien yang sama", nada: "baik" },
          { jika: "Satu no RM membawa dua nama yang kemiripannya < 80%", maka: "Tanda kualitas data (over-linking: satu no RM untuk dua orang)" },
          { jika: "No RM beda, tapi nama mirip ≥ 93%", maka: "Dicatat \"mungkin identitas ganda\" untuk dicek orang. Tidak digabung, karena bisa orang lain bernama sama" },
          { jika: "Tidak ada yang cocok", maka: "Entitas pasien baru", nada: "baik" },
          { jika: "RS mengaku kelas atau kepemilikan tertentu", maka: "Tetap pakai registri RS milik BPJS, bukan pengakuan RS" },
        ]} />,
        logika: <MeterNama />,
        algoritma: (
          <div className="space-y-2">
            <TanpaML teks="Aturan pasti yang bisa diaudit. Satu-satunya hitungan adalah kemiripan nama." />
            <div className="grid gap-1.5 sm:grid-cols-2">
              <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5"><p className="text-[12px] font-semibold text-white">Jaro-Winkler</p>
                <p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">Menghitung berapa huruf yang sama dan urutannya; nama yang awalnya sama dapat bonus. Urutan kata juga dicoba dibalik (&quot;Aminah Siti&quot; = &quot;Siti Aminah&quot;).</p></div>
              <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5"><p className="text-[12px] font-semibold text-white">Blocking key</p>
                <p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">Huruf depan tiap kata + kelas panjang nama (&quot;budi santoso&quot; → <span className="font-mono">bs2</span>). Hanya nama dengan key sama yang dibandingkan, jadi tetap cepat.</p></div>
            </div>
          </div>
        ),
        hasil: <Batasan isi={["Data sampel (sintetis) hanya punya nomor peserta pseudonim, tanpa nama atau tanggal lahir: di data itu peserta dicocokkan dengan nomor persis. Fuzzy name matching berlaku untuk kiriman RS (no RM, nama, SEP).",
          "Threshold 93% adalah trade-off: \"Budi Santoso\" vs \"Budi Susanto\" (92%) dianggap orang berbeda."]} />,
      };
    case "engine":
      return {
        kalimat: "Memeriksa setiap klaim dengan 45 rule. Setiap rule terhubung ke modus fraud Permenkes 16/2019. Hasilnya 124 feature per klaim untuk model.",
        ibarat: "Seperti checklist auditor berpengalaman yang dijalankan otomatis dalam sepersekian detik, dengan melihat riwayat 30 hari peserta dan RS.",
        langkah: [{ ikon: "graph", teks: "Klaim + graph 30 hari terakhir (peserta–RS)" }, { ikon: "logic", teks: "45 rule dicek, mitigasi diterapkan" },
          { ikon: "transform", teks: "Field klaim dirapikan & diskalakan (biaya, LOS, tarif, …)" }, { ikon: "layers", teks: "Skor rule + 124 feature dikirim ke model" }],
        tambahan: { judul: "124 feature per klaim", sub: "yang dikirim ke model", isi: <DaftarFitur /> },
        ruleJudul: "45 rule, per kelompok",
        rule: <DaftarRule rute={a.rute.sinyal} pilih={pilih} />,
        logika: <SkorAturan />,
        algoritma: (
          <div className="space-y-2.5">
            <TanpaML teks="Ke-45 rule adalah aturan pasti. Sebagian memakai statistik sederhana: persentil (p90, p95, p99), binomial test untuk lonjakan keparahan, dan Poisson test untuk pasangan RS yang berbagi terlalu banyak peserta." />
            <StatusVime />
          </div>
        ),
        hasil: <>
          <GainModel1 />
          <Batasan isi={["Model 1 sangat bergantung pada skor rule (57% gain): kalau rule-nya keliru, model ikut keliru.",
          "Pada data sintetis, rule \"klaim setelah kematian tercatat\" menyala di 75 klaim normal vs 25 fraud (tahun kematian di registri tidak konsisten), jadi model memberinya bobot kecil.",
          "Rule obat dan hasil lab (obat dikurangi, obat tidak diserahkan, hasil lab ≠ alat) hanya bisa berjalan bila RS mengirim baris obat atau hasil alat; data sampel tidak memuatnya.",
          "Skor rule sendiri tidak memutuskan; keputusan ada di langkah terakhir."]} />
        </>,
      };
    case "koding": case "tagihan": case "episode": case "identitas":
      return isiSpesialis(n, a, w);
    case "model1": {
      const td = a.tak_dikenal.find((t) => t.famili === "jaringan"), baru = a.skema.find((x) => x.skema === "cincin_bentuk_baru");
      const tanpaRing = td?.per_skema.find((p) => p.skema === "cincin_bentuk_baru");
      return {
        kalimat: "Model utama. Menilai klaim bersama neighbour-nya: klaim lain dari peserta yang sama, RS yang sama, RS + kode yang sama, dan kode yang sama.",
        ibarat: "Seperti petugas bank yang menilai satu transfer dengan melihat pola rekening dan transaksi di sekitarnya, bukan transfer itu saja.",
        langkah: [{ ikon: "doc", teks: "124 feature klaim ini (termasuk semua sinyal rule)" }, { ikon: "graph", teks: "Ambil klaim yang datang lebih dulu di 4 relasi" },
          { ikon: "layers", teks: "Rata-ratakan feature neighbour per relasi" }, { ikon: "gauge", teks: "624 feature → peluang fraud" }],
        ruleJudul: "Rule yang dibaca",
        rule: (
          <div className="space-y-2">
            <div className="flex items-start gap-3 rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
              <span className="text-[22px] font-semibold leading-none text-white">45</span>
              <p className="text-[11.5px] leading-snug text-[#dfe3e8]">Semua sinyal rule + skor rule + field klaim dibaca sebagai feature biasa (tidak monotone). Model belajar sendiri seberapa bisa dipercaya tiap rule.</p>
            </div>
            <button type="button" onClick={() => pilih("engine")} className="flex items-center gap-1 text-[11px] text-[#8abbff] hover:underline">lihat 45 rule dan 124 feature di Engine realtime<Icon name="right" className="h-3 w-3" /></button>
          </div>
        ),
        logika: (
          <div className="space-y-2.5">
            <GrafTetangga />
            <BlokFitur />
            <p className="flex items-start gap-2 text-[11px] leading-snug text-[#abb3bf]"><Icon name="clock" className="mt-px h-3.5 w-3.5 shrink-0 text-[#8abbff]" /><span>Hanya klaim yang datang <b className="text-white">sebelumnya</b> yang dipakai, jadi model tidak pernah &quot;mengintip masa depan&quot;.</span></p>
          </div>
        ),
        algoritma: (
          <div className="space-y-2">
            <PohonLGBM pohon={300} daun={15} warna={w} />
            <p className="rounded-lg bg-white/[.04] p-2.5 text-[11px] leading-snug text-[#abb3bf]"><b className="text-white">Graph di sini = neighbour aggregation feature, bukan graph neural network (GNN).</b> Dalam uji sebelumnya, LightGBM + rata-rata neighbour sedikit lebih baik dari RGCN dan GraphSAGE, dan jauh lebih sederhana.</p>
          </div>
        ),
        hasil: (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <Angka nilai={id(a.mutu_lapisan.model1 ?? 0, 3)} label="AUPRC out-of-fold" ket="semua fraud vs normal" />
              <Angka nilai={pct(a.bobot_fusi.model1 ?? 0)} label="bobot di fusion" ket="hampir seluruh keputusan" warna={SERIES[1]} />
            </div>
            <div className="mt-3"><GainModel1 /></div>
            {baru && <div className="mt-3 space-y-1.5">
              <p className="text-[11px] text-[#dfe3e8]">Collusion ring bentuk baru:</p>
              <Bar v={baru.recall_v3} warna={HIJAU} label="ring bentuk lain ada di training data" />
              {tanpaRing && <Bar v={tanpaRing.recall_v3} warna={MERAH} label="tidak ada ring sama sekali di training data" />}
            </div>}
            <Batasan isi={["Sebagian kekuatannya datang dari pola simulator: fraud ditanam berkelompok di satu RS, sehingga neighbour fraud cenderung fraud juga (homophily). Di data nyata efeknya bisa lebih kecil.",
              "Karena memegang hampir semua bobot, kelemahan Model 1 menjadi kelemahan sistem."]} />
          </>
        ),
      };
    }
    case "fusi": {
      const urut = ["model1", "koding", "episode", "identitas", "tagihan"].map((k) => ({ k, v: a.bobot_fusi[k] ?? 0 }));
      const nama: Record<string, string> = { model1: "Model 1 · graph", koding: "Spesialis coding", tagihan: "Spesialis tagihan", episode: "Spesialis episode", identitas: "Spesialis identitas" };
      return {
        kalimat: "Menggabungkan 5 penilaian (Model 1 + 4 spesialis) menjadi satu peluang fraud yang jujur.",
        ibarat: "Seperti juri yang mendengar 5 penilai lalu memberi satu nilai akhir; tidak ada penilai yang bisa membatalkan temuan penilai lain.",
        langkah: [{ ikon: "layers", teks: "5 peluang dari Model 1 dan 4 spesialis" }, { ikon: "transform", teks: "Diubah ke skala logit" },
          { ikon: "graph", teks: "LightGBM stacker (monotone)" }, { ikon: "gauge", teks: "Isotonic regression → peluang terkalibrasi" }],
        ruleJudul: "Rule penggabungan",
        rule: <JikaMaka isi={[
          { jika: "Satu lapisan memberi peluang lebih tinggi", maka: "Hasil gabungan tidak boleh turun (monotone)", nada: "baik" },
          { jika: "Lapisan lain diam", maka: "Tidak bisa menurunkan temuan lapisan yang menyala" },
          { jika: "Peluang terkalibrasi ≥ 50%", maka: "Klaim ditandai", nada: "buruk" },
        ]} />,
        logika: (
          <div className="space-y-2.5">
            <div className="rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
              <p className="mb-2 text-[11.5px] text-white">Seberapa besar suara tiap lapisan (bobot fusion)</p>
              <div className="space-y-1.5">{urut.map((x) => <Bar key={x.k} v={x.v} warna={x.k === "model1" ? SERIES[1] : SPESIALIS} label={nama[x.k]} kanan={pct(x.v, x.v < 0.1 ? 1 : 0)} />)}</div>
            </div>
            <Kalibrasi />
          </div>
        ),
        algoritma: <PohonLGBM pohon={150} daun={7} warna={w} mono="monotone pada semua 5 input" acak={false} />,
        hasil: (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <Angka nilai={id(a.mutu_lapisan.fusi ?? 0, 3)} label="AUPRC fusion (out-of-fold)" />
              <Angka nilai={id(a.mutu_lapisan.model1 ?? 0, 3)} label="AUPRC Model 1 saja" ket="hampir sama" warna="#f5c46b" />
            </div>
            <p className="mb-1.5 mt-3 text-[11px] text-[#dfe3e8]">Dibuang di v3 karena tidak menambah apa-apa:</p>
            <div className="space-y-1">{a.dibuang.map((d) => (
              <div key={d.nama} className="flex items-start gap-2 rounded-md bg-white/[.03] px-2.5 py-1.5 text-[11px]"><Icon name="x" className="mt-px h-3.5 w-3.5 shrink-0 text-[#ff8e93]" />
                <span><b className="text-white">{d.nama}</b> <span className="text-[#abb3bf]">· {d.isi}</span></span></div>))}</div>
            <Batasan isi={["Secara rata-rata fusion hampir tidak menambah dari Model 1; nilainya ada di monotone guardrail dan calibration, bukan di akurasi."]} />
          </>
        ),
      };
    }
    case "rute": {
      const rata = ruteV2?.length ? { dengan: ruteV2.reduce((s, r) => s + r.dengan, 0) / ruteV2.length, tanpa: ruteV2.reduce((s, r) => s + r.tanpa, 0) / ruteV2.length } : null;
      return {
        kalimat: "Safety net untuk jenis fraud yang belum atau jarang dipelajari model: kalau rule yang spesifik menyala, klaim langsung diperiksa.",
        ibarat: "Seperti alarm khusus yang tetap berbunyi walaupun sistem belum punya pengalaman (data berlabel) dengan kasus itu.",
        langkah: [{ ikon: "logic", teks: "Lihat sinyal rule yang menyala" }, { ikon: "filter", teks: "Cek: spesifik dan model belum berpengalaman?" }, { ikon: "eye", teks: "Ya → PERIKSA, apa pun kata model" }],
        ruleJudul: `${a.rute.sinyal.length} rule yang saat ini masuk rule route`,
        rule: (
          <>
            <KartuSinyal kode={a.rute.sinyal} warna={w} />
            <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Daftar ini dipilih otomatis dari training data saja; akan berubah ketika contoh berlabel bertambah.</p>
          </>
        ),
        logika: <CekRute a={a} />,
        algoritma: <TanpaML teks="Supervised model tidak bisa melihat jenis fraud yang tidak pernah ada di training data-nya. Di situ rule pakar yang memutuskan; di mana model punya bukti, model yang memutuskan." />,
        hasil: (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <Angka nilai={`+${id(a.rute.tambah_fraud)}`} label="fraud yang hanya tertangkap rule route" ket="test B: semua jenis fraud sudah dikenal" />
              <Angka nilai={`+${id(a.rute.tambah_normal)}`} label="klaim normal ikut ditandai" ket="biaya safety net ini" warna="#f5c46b" />
            </div>
            {rata && (
              <div className="mt-3 space-y-1.5">
                <p className="text-[11px] text-[#dfe3e8]">Nilai sebenarnya: jenis fraud yang tidak pernah dilatih (uji arsitektur v2, rata-rata 5 keluarga):</p>
                <Bar v={rata.dengan} warna={HIJAU} label="dengan rule route" />
                <Bar v={rata.tanpa} warna={MERAH} label="tanpa rule route" />
              </div>
            )}
            <Batasan isi={["Pada jenis fraud yang sudah dikenal, rule route hanya menambah false positive.", "Hanya menangkap jenis fraud baru yang memang punya rule; jenis tanpa rule tetap tidak terlihat."]} />
          </>
        ),
      };
    }
    case "jaringan": {
      const td = a.tak_dikenal.find((t) => t.famili === "jaringan");
      return {
        kalimat: "Menangkap collusion ring (sekelompok peserta yang berpindah bersama antar-RS) tanpa butuh contoh berlabel.",
        ibarat: "Kalau orang-orang yang sama selalu muncul bersama di RS-RS yang sama dalam beberapa hari, itu pola rombongan, bukan kebetulan.",
        langkah: [{ ikon: "graph", teks: `Lihat RS yang dikunjungi peserta ini dalam ±${a.rule_jaringan.hari} hari` }, { ikon: "search", teks: "Hitung peserta lain yang ke RS yang sama juga" },
          { ikon: "constellation", teks: `≥ ${a.rule_jaringan.ambang} peserta lain → tandai collusion ring (M10)` }],
        ruleJudul: "Rule",
        rule: <JikaMaka isi={[
          { jika: `Ada ≥ ${a.rule_jaringan.ambang} peserta lain yang berbagi RS dengan peserta ini dalam ±${a.rule_jaringan.hari} hari`, maka: "Tandai M10 · collusion ring", nada: "buruk" },
          { jika: "Threshold dipilih", maka: `Angka terkecil ≥ 2 yang menyala di ≤ 0,2% klaim normal training data → ${a.rule_jaringan.ambang} (menyala di ${pct(a.rule_jaringan.laju_normal_latih, 2)})` },
        ]} />,
        logika: <Ring a={a} />,
        algoritma: <TanpaML teks="Graph rule: hanya menghitung peserta yang berbagi RS di jendela waktu. Tidak butuh label fraud, jadi bisa menangkap bentuk ring yang belum pernah dilihat model." />,
        hasil: (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <Angka nilai={`+${id(a.rule_jaringan.tambah_fraud)}`} label="fraud yang hanya tertangkap rule ini" ket="test B" />
              <Angka nilai={`+${id(a.rule_jaringan.tambah_normal)}`} label="klaim normal ikut ditandai" ket="test B" />
            </div>
            <div className="mt-3 space-y-1.5">
              <Bar v={a.rule_jaringan.cincin_baru} warna={MERAH} label="ring bentuk baru di test B: rule menyala" />
              {td && <Bar v={td.recall_v3} warna={td.recall_v3 < 0.5 ? MERAH : AMBER} label="sistem, bila tak ada ring di training data" />}
            </div>
            <Batasan isi={["Di test B rule ini hampir tidak menambah: ring bentuk baru ditangkap Model 1, bukan rule ini.",
              "Ring kecil, ring yang menyebar lebih dari ±3 hari, dan ring berbentuk rantai tidak memenuhi syaratnya."]} />
          </>
        ),
      };
    }
    case "keputusan": {
      const i1 = a.prevalensi.tingkat.indexOf(0.01), i01 = a.prevalensi.tingkat.indexOf(0.001);
      return {
        kalimat: "Klaim ditandai bila peluang ≥ 50%, atau salah satu dari dua rule menyala. AI tidak memutuskan: AI hanya menjelaskan.",
        ibarat: "Hakimnya model + rule; AI adalah juru bicara yang menjelaskan putusan dengan bahasa sederhana.",
        langkah: [{ ikon: "filter", teks: "Cek: peluang ≥ 50% atau rule menyala?" }, { ikon: "sparkle", teks: "Terdeteksi → AI membaca bukti" },
          { ikon: "comment", teks: "AI menulis jenis fraud, alasan, graph, perbaikan" }, { ikon: "check", teks: "Lolos → \"Klaim aman\"" }],
        ruleJudul: "Guardrail untuk AI",
        rule: <JikaMaka isi={[
          { jika: "AI ingin menyebut M05, M06, M10, M11, M13, M14, M16, M17, M18 atau M20", maka: "Harus ada temuan rule yang mendukung (evidence gate). M10 butuh peserta lain yang berbagi RS", nada: "buruk" },
          { jika: "AI menulis penjelasan", maka: "1–4 modus Permenkes, satu paragraf awam ± 80 kata yang merujuk ke graph" },
          { jika: "AI gagal atau jawabannya tidak valid", maka: "Penjelasan cadangan dari template; keputusan tidak berubah", nada: "baik" },
          { jika: "Data dikirim ke AI", maka: "Tanpa kunci jawaban simulator; provider diminta tidak menyimpan data (data_collection: deny)", nada: "baik" },
        ]} />,
        logika: <Gerbang a={a} />,
        algoritma: (
          <div className="space-y-2">
            <TanpaML teks="Keputusan memakai threshold pada peluang terkalibrasi (50%) plus dua rule. Tidak ada model baru di sini." />
            <div className="flex items-start gap-3 rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#199e70]/20 text-[#7ee2c0]"><Icon name="sparkle" className="h-5 w-5" /></span>
              <p className="text-[11.5px] leading-snug text-[#dfe3e8]"><b className="text-white">LLM (AI)</b> menerima klaim, hasil entity resolution, sinyal rule, alasan Model 1 dan graph di sekitar klaim, lalu menulis penjelasan. Uji sebelumnya menunjukkan LLM sebagai pemutus tidak lebih baik dari model, jadi LLM tidak diberi hak memutuskan.</p>
            </div>
          </div>
        ),
        hasil: (
          <>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <SeratusTitik nilai={v.precision} warna={MERAH} judul="Dari 100 klaim yang ditandai" ya="memang fraud" tidak="klaim normal" />
              <SeratusTitik nilai={v.recall} warna={HIJAU} judul="Dari 100 klaim fraud" ya="tertangkap" tidak="lolos" />
            </div>
            <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">{sumberUji(a)} · {id(v.tp)} dari {id(v.tp + v.fn)} fraud tertangkap · {id(v.fp)} dari {id(v.fp + v.tn)} klaim normal ikut ditandai (false positive rate {pct(v.fpr, 2)}).</p>
            {i1 >= 0 && i01 >= 0 && (
              <div className="mt-3 rounded-lg border border-white/[.07] bg-white/[.03] p-2.5">
                <p className="mb-2 text-[11.5px] text-white">Precision turun kalau fraud makin jarang</p>
                <div className="space-y-1.5">
                  <Bar v={v.precision} warna={HIJAU} label={`fraud ${pct(a.prevalensi.uji, 1)} klaim (test B)`} />
                  <Bar v={a.prevalensi.keputusan.v3[i1]} warna={AMBER} label="fraud 1% klaim" />
                  <Bar v={a.prevalensi.keputusan.v3[i01]} warna={MERAH} label="fraud 0,1% klaim" />
                </div>
                <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Dihitung dari recall dan false positive rate yang sama; berapa persen fraud di data nyata belum diketahui.</p>
              </div>
            )}
            <Batasan isi={["Semua angka dari data sintetis; fraud di training dan test dibuat oleh generator yang sama.", "Lemah di Prolonged LOS dan Upcoding keparahan III."]} />
          </>
        ),
      };
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ the drawer

export function AlurV3Detail({ a, node, onClose, onPilih, ruteV2, skew }: { a: DataV3; node: NodeV3; onClose: () => void; onPilih: (n: NodeV3) => void; ruteV2?: RuteV2; skew?: SkewV3 }) {
  const keGen2 = () => { onClose(); requestAnimationFrame(() => document.getElementById("generator-2")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const m = META[node], isi = isiNode(node, a, ruteV2, onPilih);
  const i = URUTAN_V3.indexOf(node), prev = URUTAN_V3[i - 1], next = URUTAN_V3[i + 1];
  const tutup = useRef<HTMLButtonElement>(null), badan = useRef<HTMLDivElement>(null);
  useEffect(() => { tutup.current?.focus(); badan.current?.scrollTo({ top: 0 }); }, [node]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && next) onPilih(next);
      else if (e.key === "ArrowLeft" && prev) onPilih(prev);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, onPilih, next, prev]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={`Detail ${m.nama}`} className="flex h-full w-[min(680px,100vw)] flex-col border-l border-white/10 bg-[#1b2128] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-white/[.07] px-4 pb-3 pt-3 sm:px-5">
          <div className="flex items-start gap-3">
            {/* where this node sits in the flow; every dot opens its node */}
            <nav className="flex min-w-0 flex-1 flex-wrap items-end gap-x-1.5 gap-y-1" aria-label="Posisi di alur">
              {TAHAP.map((t, ti) => (
                <Fragment key={t.nama}>
                  {ti > 0 && <Icon name="right" className="mb-[3px] h-3 w-3 text-[#5f6b7a]" />}
                  <div className="flex flex-col items-center gap-0.5">
                    <div className="flex gap-1">{t.node.map((k) => (
                      <button key={k} type="button" onClick={() => onPilih(k)} title={META[k].nama} aria-current={k === node}
                        className="h-2.5 rounded-full transition-all hover:opacity-100" style={{ width: k === node ? 20 : 10, background: META[k].warna, opacity: k === node ? 1 : 0.4 }} />))}</div>
                    <span className={`text-[9.5px] ${t.node.includes(node) ? "text-white" : "text-[#8f99a8]"}`}>{t.nama}</span>
                  </div>
                </Fragment>
              ))}
            </nav>
            <button ref={tutup} type="button" onClick={onClose} className="rounded p-1 text-[#abb3bf] hover:bg-white/10 hover:text-white" aria-label="Tutup"><Icon name="x" className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 flex items-center gap-2.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${m.warna}26`, color: m.warna }}><Icon name={m.ikon} className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 className="truncate text-[16px] font-semibold text-white">{m.nama}</h2>
              <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-white/[.07] px-1.5 py-0.5 text-[10.5px] text-[#d3d8de]"><Icon name="cpu" className="h-3 w-3 text-[#8f99a8]" />{m.teknik}</span>
            </div>
          </div>
        </div>

        <div ref={badan} className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-4 py-4 sm:px-5">
            <p className="text-[14px] leading-snug text-white">{isi.kalimat}</p>
            <div className="mt-2.5 flex items-start gap-2 rounded-lg px-3 py-2" style={{ background: `${m.warna}14`, border: `1px solid ${m.warna}40` }}>
              <span className="mt-px shrink-0" style={{ color: m.warna }}><Icon name="info" className="h-4 w-4" /></span>
              <p className="text-[12px] leading-snug text-[#dfe3e8]"><b className="text-white">Ibaratnya:</b> {isi.ibarat}</p>
            </div>
          </div>
          <Bagian ikon="pipeline" judul="Cara kerja"><Langkah isi={isi.langkah} warna={m.warna} /></Bagian>
          {isi.tambahan && <Bagian ikon="table" judul={isi.tambahan.judul} sub={isi.tambahan.sub}>{isi.tambahan.isi}</Bagian>}
          <Bagian ikon="logic" judul={isi.ruleJudul ?? "Rule yang dipakai"} sub="dasar menyimpulkan indikasi fraud">{isi.rule}</Bagian>
          <Bagian ikon="split" judul="Logika">{isi.logika}</Bagian>
          <Bagian ikon="cpu" judul="Algoritma">{isi.algoritma}</Bagian>
          <Bagian ikon="gauge" judul="Hasil dan batasan" sub="angka jujur, termasuk yang buruk">{skew && <CatatanSkew s={skew} onLihat={keGen2} />}{isi.hasil}</Bagian>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-white/[.07] px-4 py-2.5 sm:px-5">
          {prev ? <button type="button" onClick={() => onPilih(prev)} className="flex min-w-0 items-center gap-1 rounded px-2 py-1 text-[11.5px] text-[#c5cbd3] hover:bg-white/[.06]">
            <Icon name="left" className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{META[prev].nama}</span></button> : <span />}
          <span className="shrink-0 text-[10.5px] tabular-nums text-[#8f99a8]">{i + 1} / {URUTAN_V3.length}</span>
          {next ? <button type="button" onClick={() => onPilih(next)} className="flex min-w-0 items-center gap-1 rounded px-2 py-1 text-[11.5px] text-[#c5cbd3] hover:bg-white/[.06]">
            <span className="truncate">{META[next].nama}</span><Icon name="right" className="h-3.5 w-3.5 shrink-0" /></button> : <span />}
        </div>
      </aside>
    </div>
  );
}
