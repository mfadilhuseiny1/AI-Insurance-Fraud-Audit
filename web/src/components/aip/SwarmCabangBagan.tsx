"use client";

// AI Agent Swarm Branch: the branch's system chart, in the national "Bagan firma" style (the user, 2026-11-13: "terlalu simpel
// animasinya ... disesuaikan sama arsitektur cabang ... yg jelas keliatan complex system integration ... tambahin blok ML ...
// arsitektur ML"; 2026-11-14: "proses dari raw data ke ML ke output awal masuk juga di visualisasi, makanya harus ada blok
// indikasi berdasarkan tag yang dikasih rule engine sama prediksi model ML v7", "animasi AI swarm branch, bukan animasi AI swarm
// nya aja, tapi ada juga flow dari data mentah kemudian tagging berbasis rule & ML", "ganti antrean verifikator jadi dashboard
// keputusan"; later that day: "box karantina setelah indikasi", AI Agent Swarm + Laporan KC in one card, the dashboard in the
// national style "ditindak / dibina / dibebaskan", and a graph block in the ML architecture "biar user percaya sistem AI ini
// komprehensif"). Every system of the branch flow on one chart:
//   the run's orchestrator and its two code guards (dossier redaction, cost guard);
//   raw data -> validation -> the realtime engine's rule engine (signals per claim) and the feature store (646 features);
//   the ML v7 block with its architecture: the claim graph (each claim linked to the earlier claims with the same member, hospital,
//   hospital + INA-CBG code, or code; 500 of the 646 features are its neighbours' aggregates), review rules, LightGBM x 3 seeds,
//   the mean score s, the zone router RAGU/TAHAN/LOLOS;
//   Indikasi, the first output before any agent: rule tags + the model's tag, their strength = rule x ML score (code);
//   the branch's Box Karantina: every hospital with a tag, grouped A-Z by estimated loss once the report has priced it;
//   the swarm (three specialists -> judge -> the tau gate on (p judge + q(s)) / 2);
//   the branch report (loss estimate in code, the writer agent, the number check) and the decision dashboard: a path per
//   hospital from TSM (ditindak = T+S+M, dibina = at least one, dibebaskan = none) and the verification of every recommended claim;
//   since 2026-11-15, when the report carries the IoT layer (L.iot): the AIoT block top left. Kept simple (the user, same day:
//   "keep 3 node buat Ventilator, Hemodialysis, Monitor ICU + node AIoT Verification system"): three device nodes, each read by
//   a current clamp on its power cable (running / standby / off and for how long; never the patient's vitals) -> one AIoT
//   Verification System node (device sessions bound to the patient, device use against the bill, its verdicts) -> the IoT tag
//   into Tag aturan, in its own phase before Indikasi. No invasive / non-invasive split and no ledger node.
// Packets travel between the systems over the event store and the rails; the log on the right says what moved. The replay is built
// from this run's own outputs (the tags, zones, every agent's opinion and score, the decisions, the narration, the spend); the
// batch order and the durations are reconstructed, not a recording. No motion when the viewer asks for reduced motion.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";

type Agen = { p: number; bukti?: string; alasan?: string; famili?: string };
export type KasusBagan = { id: string; rs: string; inacbg: string; tema_nama?: string; keputusan: string; skor_model: number; rule?: string[];
  agen: Record<string, Agen> | null; p_hakim: number | null; estimasi_kerugian_rp?: number; tag_label?: string | null };
export type SampulBagan = { klaim: number; lolos: number; tahan: number; ragu: number; periksa: number; dibersihkan: number; antrean: number; rs: number;
  tema_aktif: number; nilai_antrean_rp: number; tagihan_rp: number; nilai_transaksi_rp?: number; nilai_terindikasi_rp?: number; estimasi_kerugian_rp?: number; model?: string };
export type RunBagan = { kc?: number; biaya_usd?: number; kalimat_dibuang_cek_angka?: number;
  biaya_swarm?: { usd_perkiraan?: number; panggilan?: number; token_masuk?: number; token_keluar?: number; selesai?: number } };
// the branch's first output (testing/laporan_cabang.indikasi_kc): rule tags + the model's tag, by strength
export type IndikasiBagan = {
  klaim: number; klaim_bertag: number; tag_aturan: number; tag_model: number; kekuatan: { lemah: number; sedang: number; kuat: number };
  per_tag: { tag: string; label: string; sumber: "aturan" | "model"; n: number }[]; ambang: { tahan: number; periksa: number; ragu: number };
  data: { baris: number; kolom: number; peserta: number; rs: number; klaim_bersinyal: number; sinyal: { kode: string; label: string; n: number }[] };
};
export type PutusanBagan = { terbukti: number; sesuai: number; investigasi: number };
// the IoT verification layer (testing/laporan_cabang.py L.iot): devices and hospitals with a sensor, claims with a monitored device,
// the verdicts, the tariff difference and the rules that fired (the older reports carry only the first three counts)
export type IotBagan = { klaim_dengan_alat: number; tidak_sesuai: number; selisih_rp: number; alat?: number; rs_dengan_iot?: number; sesuai?: number;
  tanpa_bukti?: number; aturan?: { aturan: string; judul?: string; klaim: number; selisih_rp?: number }[]; sintetis?: boolean };
// the branch's Box Karantina (testing/laporan_cabang.py): hospitals with a tag, grouped by estimated loss, and the path per hospital
export type BoxBagan = { rs: number; rs_klaim: number; estimasi_kerugian_rp: number;
  kelompok: Record<"A" | "B" | "C" | "D" | "Z", { rs: number; estimasi_kerugian_rp: number; rekomendasi: number }>;
  jalur: { ditindak: number; dibina: number; dibebaskan: number }; kriteria: string[] };
/** A branch audit still running (testing/jalan_kc_tema.py status.json and its log, api/swarm-cabang/proyek?langsung=1): the chart
 *  follows it live (the user, 2026-11-15: "live animation juga buat yg branch tapi arsitektur sistem nya yg branch") */
export type LangsungBagan = { status: string; tahap: string | null; tahap_daftar: string[]; tahap_selesai: string[]; mulai: string | null;
  usd: number; batas: number; pesan: string | null; iot: boolean; replika: number; klaim: number;
  progres: { replika_selesai?: number; replika_total?: number; batch?: number; batch_total?: number } | null;
  zona: { klaim: number; tahan: number; ragu: number } | null; gerbang: { dibaca?: number; periksa?: number; dibersihkan?: number } | null; log: string[];
  /** the device check's counts once its stage is done (status.iot) */ iot_hasil?: IotBagan | null;
  /** the rule engine's signals on the chosen claims (from the zona stage) and the rule-evidence step (status.aturan): the chart showed 0
   *  for both while the run went on (2026-11-16, "kok bisa 16280 rule engine ga nangkep sinyal sama sekali") */
  sinyal?: { klaim: number; klaim_bersinyal: number; teratas: { kode: string; label: string; n: number }[] } | null;
  aturan?: { rute?: number; bukti?: number; temuan_rme?: number; temuan_iot?: number; terverifikasi?: number } | null;
  /** the tag summary as the report gives it: the runner counts it after the aturan stage (laporan_cabang --indikasi-awal) */
  indikasi?: IndikasiBagan | null;
  /** the report's Box, values and exhibits once its stage is done (the /swarm-x demo; a real audit shows its report at that point) */
  laporan?: { box: BoxBagan; antrean: number; nilai_terindikasi_rp: number; estimasi_kerugian_rp: number; exhibit: number; bab: number } | null };
type Props = { kc: string; periode: string; riil: boolean; sampul: SampulBagan; kasus: KasusBagan[]; exhibit: number; bab: number; narasi: number;
  run?: RunBagan; ledger?: { tag?: number; status?: Record<string, number>; error?: string }; putusan: PutusanBagan; indikasi?: IndikasiBagan;
  box?: BoxBagan; iot?: IotBagan; bukaDaftarKerja?: () => void;
  /** live: a running audit; batchLive: its swarm batches by number (no agent opinions yet) */ langsung?: LangsungBagan; batchLive?: number };

// ---------------------------------------------------------------- geometry (viewBox 1430 x 648)
const W = 1430, H = 648;
const C = { orch: "#9d8cff", ingest: "#3987e5", ml: "#2dd4bf", indikasi: "#ec835a", swarm: "#d55181", laporan: "#93c25b", verif: "#e5e8eb", kode: "#b8a9ff",
  tahan: "#e5484d", periksa: "#e0a02b", lolos: "#738091", vertex: "#8fb3ff", selesai: "#29a383", lemah: "#8f99a8", box: "#fab219", iot: "#38bdf8" };
// the Box groups (the national box's colours) and the hospital paths
const KELOMPOK = ["A", "B", "C", "D", "Z"] as const;
const WARNA_KELOMPOK: Record<(typeof KELOMPOK)[number], string> = { A: "#e5484d", B: "#ec835a", C: "#fab219", D: "#3987e5", Z: "#738091" };
const ARTI_KELOMPOK: Record<(typeof KELOMPOK)[number], string> = { A: "bersama-sama menanggung 50% pertama estimasi kerugian", B: "kerugian besar (50–80% kumulatif)",
  C: "kerugian menengah (80–95%)", D: "kerugian kecil (95–99%)", Z: "kerugian sangat kecil atau hanya sinyal non-uang" };
const JALUR = [["ditindak", "#e5484d"], ["dibina", "#e0a02b"], ["dibebaskan", "#29a383"]] as const;
type XY = { x: number; y: number };
const xy = (x: number, y: number): XY => ({ x, y });
const LAJUR = [
  { k: "l-ingest", x: 110, nama: "Data mentah & fitur", sub: "validasi · rule engine · fitur", warna: C.ingest, anak: ["mentah", "validasi", "aturan", "stream", "f4", "toko"] },
  { k: "l-ml", x: 340, nama: "ML v7", sub: "skoring · mesin", warna: C.ml, anak: ["graf", "rule", "lgb0", "lgb1", "lgb2", "rata", "router"] },
  { k: "l-indikasi", x: 590, nama: "Indikasi", sub: "tag aturan + tag ML · kode", warna: C.indikasi, anak: ["tagAturan", "tagModel", "kekuatan", "kuat", "sedang", "lemah"] },
  { k: "l-swarm", x: 840, nama: "AI Agent Swarm", sub: "3 spesialis + hakim", warna: C.swarm, anak: ["koding", "tagihan", "episode", "hakim", "tau"] },
  { k: "l-laporan", x: 1088, nama: "Laporan KC", sub: "kode + agen penulis", warna: C.laporan, anak: ["rugi", "penulis", "cek", "exhibit"] },
  { k: "l-verif", x: 1315, nama: "Verifikator KC", sub: "manusia", warna: C.verif, anak: ["antrean", "dash", "putusan", "ledger"] },
] as const;
const LY = 186;
const OX = 715;  // the orchestrator
const P: Record<string, XY> = {
  orch: xy(OX, 58), redaksi: xy(555, 58), biaya: xy(875, 58), vertex: xy(935, 236),
  ...Object.fromEntries(LAJUR.map((l) => [l.k, xy(l.x, LY)])),
  mentah: xy(65, 278), validasi: xy(155, 278), aturan: xy(65, 322), stream: xy(155, 322), f4: xy(65, 366), toko: xy(155, 366),
  // the ML block: the claim graph -> LightGBM x 3 -> the mean s -> the zone router; the review rules above them
  graf: xy(244, 324), rule: xy(304, 278), lgb0: xy(308, 300), lgb1: xy(308, 320), lgb2: xy(308, 340), rata: xy(357, 320), router: xy(386, 320),
  ragu: xy(436, 300), tahan: xy(436, 320), lolos: xy(436, 340),
  tagAturan: xy(540, 284), tagModel: xy(540, 340), kekuatan: xy(612, 312), kuat: xy(664, 290), sedang: xy(664, 312), lemah: xy(664, 334),
  koding: xy(775, 310), tagihan: xy(840, 310), episode: xy(905, 310), hakim: xy(805, 364), tau: xy(898, 364),
  penulis: xy(1040, 280), cek: xy(1136, 280), rugi: xy(1040, 344), exhibit: xy(1136, 344),
  dash: xy(1265, 280), putusan: xy(1365, 280), antrean: xy(1265, 344), ledger: xy(1365, 344),
  // the AIoT block (top left): the three device nodes and the verification node (centres)
  iotV: xy(87, 46), iotH: xy(87, 70), iotM: xy(87, 94), iotAi: xy(354, 70),
};
// the AIoT block sits above the orchestrator's curves (the leftmost passes y 139 at x 466) and left of the RAGU -> redaction rail
// (x 474 from y 150, then up to the diamond); its output drops at x 458, hops that rail at y 238 and enters Tag aturan from above
const AIOT = { x0: 20, x1: 478, y0: 4, y1: 118 }, AICEK = { x0: 236, x1: 472, y0: 34, y1: 106 };
const IOT_KELUAR = { x: 458, y: 238, masuk: 506 };  // the output rail: down at x, across at y (over x 474), into Tag aturan at x = masuk
const INBOX = { x0: 20, x1: 200, y0: 246, y1: 396 }, MLBOX = { x0: 215, x1: 465, y0: 246, y1: 396 }, IXBOX = { x0: 480, x1: 702, y0: 246, y1: 396 },
  SWBOX = { x0: 712, x1: 970, y0: 246, y1: 396 };
const BUS = { x0: 20, x1: 1410, y0: 404, y1: 432 }, BY = (BUS.y0 + BUS.y1) / 2;
const KARTU = { y: 478, w: 220, h: 162, x: [20, 254, 488, 722, 956, 1190] };
const KELUAR = W - 30;  // where a claim leaves the chart back to normal payment

const garis = (...p: [number, number][]): XY[] => p.map(([x, y]) => xy(x, y));
function kurva(a: XY, b: XY, n = 16): XY[] {
  const m = (a.y + b.y) / 2, out: XY[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(xy(u * u * u * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t * t * t * b.x, u * u * u * a.y + 3 * u * u * t * m + 3 * u * t * t * m + t * t * t * b.y));
  }
  return out;
}
// the rails between systems (drawn; packets travel along them)
const R: Record<string, XY[]> = {
  ...Object.fromEntries(LAJUR.map((l) => [`orch>${l.k}`, kurva(xy(OX, 114), xy(l.x, LY - 17))])),
  "orch>redaksi": garis([OX - 24, 58], [565, 58]), "orch>biaya": garis([OX + 24, 58], [865, 58]),
  // raw data -> validation -> rule engine + features
  "l-ingest>mentah": garis([110, 232], [65, 268]), "l-ingest>validasi": garis([110, 232], [155, 268]),
  "mentah>validasi": garis([75, 278], [145, 278]), "validasi>aturan": garis([148, 286], [72, 314]), "validasi>stream": garis([155, 288], [155, 312]),
  "stream>f4": garis([148, 330], [72, 358]), "stream>toko": garis([155, 332], [155, 356]), "f4>toko": garis([75, 366], [145, 366]),
  "aturan>bus": garis([55, 322], [30, 322], [30, BUS.y0]),
  "toko>rule": garis([165, 366], [205, 366], [205, 278], [270, 278]),
  "toko>graf": garis([165, 366], [205, 366], [205, 324], [226, 324]),
  // the ML block: the claim graph feeds each LightGBM
  "graf>lgb0": garis([255.5, 312], [278, 300]), "graf>lgb1": garis([262.5, 325.5], [278, 320]), "graf>lgb2": garis([251, 338.5], [278, 340]),
  "lgb0>rata": garis([338, 304], [348, 315]), "lgb1>rata": garis([338, 320], [347, 320]), "lgb2>rata": garis([338, 336], [348, 325]),
  "rata>router": garis([367, 320], [377, 320]), "rule>router": garis([338, 283], [386, 283], [386, 311]),
  "router>ragu": garis([395, 320], [408, 300]), "router>tahan": garis([395, 320], [408, 320]), "router>lolos": garis([395, 320], [408, 340]),
  "l-ml>box": garis([340, 232], [340, MLBOX.y0]), "l-indikasi>box": garis([590, 232], [590, IXBOX.y0]), "l-swarm>box": garis([840, 232], [840, SWBOX.y0]),
  // Indikasi: the rule engine's signals (from the event store) and the review rules -> rule tags; the score s -> the model's tag
  "bus>tagAturan": garis([490, BUS.y0], [490, 284], [498, 284]), "rule>tagAturan": garis([338, 274], [486, 274], [486, 278], [498, 278]),
  "rata>tagModel": garis([357, 330], [357, 362], [494, 362], [494, 340], [498, 340]),
  "tagAturan>kekuatan": garis([582, 284], [602, 304]), "tagModel>kekuatan": garis([582, 340], [602, 320]),
  "kekuatan>kuat": garis([620, 312], [630, 312], [638, 290]), "kekuatan>sedang": garis([620, 312], [638, 312]), "kekuatan>lemah": garis([620, 312], [630, 312], [638, 334]),
  "ix>bus": garis([690, 312], [697, 312], [697, BUS.y0]),
  // RAGU -> redaction -> the swarm
  "ragu>redaksi": garis([464, 300], [474, 300], [474, 150], [546, 66]), "redaksi>l-swarm": garis([564, 62], [828, 172]),
  "l-swarm>koding": garis([840, 232], [840, 290], [775, 300]), "l-swarm>tagihan": garis([840, 232], [840, 300]), "l-swarm>episode": garis([840, 232], [840, 290], [905, 300]),
  "koding>hakim": garis([775, 338], [800, 353]), "tagihan>hakim": garis([840, 338], [810, 353]), "episode>hakim": garis([905, 338], [814, 355]),
  "hakim>tau": garis([816, 364], [890, 364]), "tau>bus": garis([898, 372], [898, BUS.y0]),
  "spesialis>vertex": garis([935, 284], [935, 245]), "penulis>vertex": garis([1030, 274], [978, 240]),
  "tahan>bus": garis([464, 320], [470, 320], [470, BUS.y0]), "lolos>bus": garis([436, 348], [436, BUS.y0]),
  // the report and the decision dashboard
  "l-laporan>penulis": garis([1088, 232], [1040, 270]), "l-laporan>cek": garis([1088, 232], [1136, 270]),
  "rugi>exhibit": garis([1050, 344], [1126, 344]), "exhibit>penulis": garis([1128, 337], [1048, 287]), "penulis>cek": garis([1050, 280], [1126, 280]), "cek>exhibit": garis([1136, 290], [1136, 334]),
  "l-verif>dash": garis([1315, 232], [1265, 270]), "l-verif>putusan": garis([1315, 232], [1365, 270]),
  "antrean>dash": garis([1265, 334], [1265, 290]), "dash>putusan": garis([1275, 280], [1355, 280]), "putusan>ledger": garis([1365, 290], [1365, 334]),
  "toko>bus": garis([155, 378], [155, BUS.y0]), "rugi>bus": garis([1040, 378], [1040, BUS.y0]), "exhibit>bus": garis([1136, 378], [1136, BUS.y0]),
  "antrean>bus": garis([1265, 378], [1265, BUS.y0]), "ledger>bus": garis([1365, 378], [1365, BUS.y0]),
  // AIoT: each device (read by the clamp on its power cable) to the verification node, and its IoT tag into Tag aturan
  "iotV>iotAi": garis([140, 46], [188, 46], [188, 70], [AICEK.x0, 70]), "iotH>iotAi": garis([140, 70], [AICEK.x0, 70]),
  "iotM>iotAi": garis([140, 94], [188, 94], [188, 70], [AICEK.x0, 70]),
  "iotAi>tagAturan": garis([IOT_KELUAR.x, AICEK.y1], [IOT_KELUAR.x, IOT_KELUAR.y], [IOT_KELUAR.masuk, IOT_KELUAR.y], [IOT_KELUAR.masuk, 275]),
};
// the claims whose device use matches the bill: into the check and down to its "sesuai" counter (they get no tag)
const IOT_SESUAI = garis([188, 70], [AICEK.x0, 70], [AICEK.x0 + 14, 70], [AICEK.x0 + 14, 78]);
// which systems light a rail
const REL: Record<string, [string, string]> = Object.fromEntries(Object.keys(R).map((k) => {
  const [a, b] = k.split(">");
  return [k, [a === "spesialis" ? "koding" : a === "ix" ? "kekuatan" : a === "bus" ? "toko" : a, b === "box" ? a : b === "bus" ? a : b]];
}));
const balik = (p: XY[]) => [...p].reverse();
const viaBus = (x1: number, x2: number): XY[] => [xy(x1, BUS.y0), xy(x1, BY), xy(x2, BY), xy(x2, BUS.y0)];
const keKartu = (i: number, dari: number): XY[] => [xy(dari, BY), xy(KARTU.x[i] + KARTU.w / 2, BY), xy(KARTU.x[i] + KARTU.w / 2, BUS.y1), xy(KARTU.x[i] + KARTU.w / 2, KARTU.y)];
const ke = (a: string, b: string): XY[] => R[`${a}>${b}`] ?? (R[`${b}>${a}`] ? balik(R[`${b}>${a}`]) : [P[a], P[b]]);

// ---------------------------------------------------------------- the phases
const FASE: { k: string; nama: string; warna: string; desk: string }[] = [
  { k: "penugasan", nama: "Penugasan", warna: C.orch, desk: "Orkestrator run KC menetapkan jendela, model dan urutan kerja. Dua penjaga berbasis kode aktif sebelum ada panggilan model: redaksi berkas dan cost guard." },
  { k: "ingest", nama: "Data mentah & fitur", warna: C.ingest, desk: "Baris klaim mentah divalidasi lalu masuk engine realtime urut tanggal. Rule engine memberi sinyal aturan per klaim; engine fitur menghitung riwayat peserta, profil RS dan kode INA-CBG menjadi 646 fitur di penyimpanan fitur." },
  { k: "ml", nama: "Skoring ML v7", warna: C.ml, desk: "Blok ML menilai setiap klaim bersama jaringannya: graph klaim menghubungkan klaim ke klaim sebelumnya (peserta, RS, RS + kode, kode INA-CBG yang sama) → 646 fitur, 500 di antaranya dari graph → LightGBM × 3 seed → rata-rata skor s → ambang zona. Aturan telaah berjalan di samping; klaim dengan aturan menyala ikut masuk RAGU." },
  { k: "aiot", nama: "AIoT", warna: C.iot, desk: "Sensor clamp (tanpa membuka alat) di kabel daya ventilator, mesin hemodialisis dan monitor ICU mencatat kapan alat jalan, siaga atau mati dan berapa lama. AIoT Verification System mengikat setiap sesi alat ke pasien dan kunjungannya, lalu membandingkan pemakaian alat dengan klaim (≥ 96 jam jalan berturut-turut, siaga vs ditagih, binding alat↔pasien, jejak alat utuh); yang tidak sesuai menjadi tag IoT di Tag aturan. Tidak mengukur kondisi pasien." },
  { k: "indikasi", nama: "Indikasi", warna: C.indikasi, desk: "Output awal sebelum agen: setiap klaim diberi tag dari rule engine dan aturan telaah, plus tag model bila skor ML v7 mencapai zona RAGU. Kekuatan tag = aturan × skor ML (lemah, sedang, kuat), dihitung kode." },
  { k: "box", nama: "Box Karantina", warna: C.box, desk: "Setiap RS dengan minimal satu tag masuk Box Karantina KC. Pengelompokan A–Z menurut estimasi kerugian diisi kode setelah laporan menghitung kerugian klaim yang direkomendasikan (A = RS yang bersama-sama menanggung 50% pertama kerugian)." },
  { k: "swarm", nama: "AI Agent Swarm", warna: C.swarm, desk: "Klaim RAGU menjadi berkas fitur tanpa ID, 8 per batch. Tiga spesialis membaca berkas bersamaan, lalu hakim memberi skor akhir dan gerbang τ memutuskan." },
  { k: "keputusan", nama: "Rekomendasi klaim", warna: C.periksa, desk: "TAHAN dari model dan PERIKSA dari swarm menjadi rekomendasi klaim di dashboard keputusan; yang dibersihkan swarm kembali ke jalur bayar normal." },
  { k: "laporan", nama: "Laporan KC", warna: C.laporan, desk: "Kode menghitung estimasi kerugian per modus dan menyusun exhibit per tema klinis; agen penulis menarasikan tiap exhibit dan cek angka membuang kalimat yang angkanya tidak bersumber." },
  { k: "verifikasi", nama: "Dashboard keputusan", warna: C.verif, desk: "Kode merekomendasikan jalur per RS menurut TSM: ditindak bila Terstruktur, Sistematis dan Masif terpenuhi, dibina bila minimal satu, dibebaskan bila tidak ada. Verifikator KC (manusia) memutuskan jalur RS dan memverifikasi setiap klaim yang direkomendasikan: terbukti bermasalah, sesuai, atau perlu investigasi." },
];
const JENIS: [string, string][] = [["semua", "Semua"], ["data", "Data"], ["ml", "ML"], ["iot", "AIoT"], ["indikasi", "Indikasi"], ["agen", "Agen"], ["kode", "Kode"], ["keputusan", "Keputusan"], ["laporan", "Laporan"]];
const SPEEDS = [1, 2, 4, 8];

const NAMA: Record<string, [string, string]> = {
  orch: ["Orkestrator", C.orch], redaksi: ["Redaksi berkas", C.kode], biaya: ["Cost guard", C.kode], vertex: ["Model AI", C.vertex],
  "l-ingest": ["Data mentah & fitur", C.ingest], "l-ml": ["ML v7", C.ml], "l-indikasi": ["Indikasi", C.indikasi], "l-swarm": ["AI Agent Swarm", C.swarm],
  "l-laporan": ["Laporan KC", C.laporan], "l-verif": ["Verifikator KC", C.verif],
  mentah: ["Data mentah", C.ingest], validasi: ["Validasi klaim", C.ingest], aturan: ["Rule engine", C.indikasi], stream: ["fitur.Stream", C.ingest], f4: ["Fitur v4", C.ingest], toko: ["Penyimpanan fitur", C.ingest],
  graf: ["Graph klaim", C.ml], rule: ["Aturan telaah", C.ml], lgb0: ["LightGBM", C.ml], lgb1: ["LightGBM", C.ml], lgb2: ["LightGBM", C.ml], rata: ["Skor s", C.ml], router: ["Router zona", C.ml],
  tagAturan: ["Tag aturan", C.indikasi], tagModel: ["Tag model ML v7", C.indikasi], kekuatan: ["Kekuatan tag", C.kode], kuat: ["Tag kuat", C.tahan], sedang: ["Tag sedang", C.periksa], lemah: ["Tag lemah", C.lemah],
  koding: ["Spesialis koding & klinis", C.swarm], tagihan: ["Spesialis tagihan", C.swarm], episode: ["Spesialis episode & jaringan", C.swarm], hakim: ["Hakim", C.swarm], tau: ["Gerbang τ", C.kode],
  rugi: ["Estimasi kerugian", C.laporan], penulis: ["Agen penulis", C.laporan], cek: ["Cek angka", C.kode], exhibit: ["Laporan KC", C.laporan],
  box: ["Box Karantina", C.box],
  iotSensor: ["Sensor clamp alat", C.iot], iotV: ["Ventilator", C.iot], iotH: ["Hemodialisis", C.iot], iotM: ["Monitor ICU", C.iot],
  iotAi: ["AIoT Verification System", C.iot],
  antrean: ["Rekomendasi klaim", C.verif], dash: ["Dashboard keputusan", C.verif], putusan: ["Putusan verifikator", C.verif], ledger: ["Buku besar indikasi", C.verif],
};
const INFO: Record<string, string> = {
  orch: "Orkestrator run KC: menjalankan pipeline cabang berurutan (data → fitur → graph + ML → indikasi → box karantina → swarm → laporan → dashboard keputusan) dan menetapkan batas biaya.",
  redaksi: "Redaksi berkas (kode, tanpa model): berkas untuk swarm hanya berisi fakta turunan fitur; ID disamarkan K1–K8.",
  biaya: "Cost guard (kode): token setiap panggilan model dihitung; batch baru mulai hanya di bawah batas; 5 batch gagal beruntun menghentikan run.",
  vertex: "Model bahasa (LLM) yang dipakai spesialis, hakim dan agen penulis; hanya menerima berkas tanpa identitas dan fakta agregat.",
  mentah: "Data mentah: baris klaim FKRTL KC apa adanya (kunjungan, peserta, RS, kode INA-CBG, tarif, tindakan, top-up).",
  validasi: "Validasi klaim (kode): setiap baris dicek terhadap skema klaim API sebelum masuk engine realtime urut tanggal.",
  aturan: "Rule engine (kode): aturan klinis, tagihan, episode dan jaringan dijalankan pada setiap klaim saat masuk; sinyalnya disimpan di event store.",
  stream: "fitur.Stream: 624 fitur per klaim = 124 fitur klaim itu sendiri + 500 fitur tetangga dari graph klaim (klaim sebelumnya dengan peserta, RS, RS + kode, atau kode INA-CBG yang sama).",
  f4: "Fitur v4: 22 fitur mekanisme (persentil tarif, biaya, LOS, dx sekunder terhadap kode INA-CBG yang sama).",
  toko: "Penyimpanan fitur: 646 fitur per klaim (124 klaim sendiri + 500 tetangga graph + 22 mekanisme), dibaca ML dan disusun menjadi berkas swarm.",
  graf: "Graph klaim: setiap klaim dihubungkan ke klaim yang masuk lebih dulu dengan peserta yang sama, RS yang sama, RS + kode INA-CBG yang sama, atau kode INA-CBG yang sama (4 relasi; paling banyak 10/10/10/5 klaim terakhir). Untuk tiap relasi, rata-rata fitur klaim tetangga dan jumlah tetangganya menjadi fitur: 500 fitur tetangga, dibaca ML v7 bersama 124 fitur klaim itu sendiri dan 22 fitur mekanisme (total 646). Jadi ML menilai klaim dalam konteks jaringannya, bukan sendirian.",
  rule: "Aturan telaah (kode): ambang pada fitur mekanisme (klon, top-up, dx sekunder, kartu di RS lain, jaringan); klaim yang menyalakannya ikut zona RAGU.",
  lgb0: "LightGBM seed 0: 300 pohon, 15 daun, 646 fitur (500 dari graph klaim).", lgb1: "LightGBM seed 1: 300 pohon, 15 daun, 646 fitur (500 dari graph klaim).",
  lgb2: "LightGBM seed 2: 300 pohon, 15 daun, 646 fitur (500 dari graph klaim).",
  rata: "Skor s = rata-rata probabilitas tiga LightGBM.", router: "Router zona (kode): TAHAN bila s ≥ ambang tahan; RAGU bila s ≥ ambang lebar atau aturan menyala; selain itu LOLOS.",
  tagAturan: "Tag aturan (kode): setiap sinyal rule engine dan aturan telaah dipetakan ke tag modus (Permenkes 16/2019), satu tag per klaim per jenis.",
  tagModel: "Tag model (kode): klaim dengan skor ML v7 di zona RAGU atau lebih diberi tag 'Risiko tinggi menurut model'.",
  kekuatan: "Kekuatan tag (kode): tag aturan kuat bila skor ML ≥ ambang periksa, sedang bila ≥ ambang ragu; tag model kuat bila ≥ ambang tahan, sedang bila ≥ ambang periksa.",
  kuat: "Tag kuat: aturan dan model sepakat kuat, atau skor model di zona tahan.", sedang: "Tag sedang.", lemah: "Tag lemah: aturan menyala tetapi model menilai risiko rendah.",
  koding: "Spesialis koding & klinis (agen AI): kecocokan diagnosis, prosedur, keparahan.", tagihan: "Spesialis tagihan (agen AI): tarif, top-up, biaya terhadap median kode.",
  episode: "Spesialis episode & jaringan (agen AI): klaim ganda, readmisi, pemecahan episode, pola peserta.",
  hakim: "Hakim (agen AI): membaca berkas + tiga pendapat, memeriksa ulang bukti, memberi skor risiko akhir p.",
  tau: "Gerbang τ (kode): f = (p hakim + q(s)) / 2; f ≥ 0,72 → PERIKSA, selain itu dibersihkan. q(s) = persentil skor ML di klaim normal referensi.",
  rugi: "Estimasi kerugian (kode): per modus, dari klaim yang direkomendasikan; batas atas sebelum verifikasi.", penulis: "Agen penulis (agen AI): hanya menerima fakta agregat KC; menulis makna dan implikasi tiap exhibit.",
  cek: "Cek angka (kode): kalimat narasi yang angkanya tidak ada di fakta exhibit dibuang.", exhibit: "Laporan KC: sampul 3 nilai, bab kerugian, bab per tema klinis, berkas kasus per klaim.",
  antrean: "Rekomendasi klaim: klaim TAHAN + PERIKSA, urut prioritas; setiap klaim diverifikasi satu per satu di dashboard keputusan.",
  dash: "Dashboard keputusan: jalur per RS menurut TSM (ditindak bila Terstruktur, Sistematis dan Masif terpenuhi; dibina bila minimal satu; dibebaskan bila tidak ada), dihitung kode; lalu verifikasi setiap klaim yang direkomendasikan dengan berkas kasus dan alasan AI.",
  putusan: "Putusan verifikator (manusia): memutuskan jalur RS (ditindak, dibina, dibebaskan) dan setiap klaim yang direkomendasikan: terbukti bermasalah, sesuai, atau perlu investigasi.",
  ledger: "Buku besar indikasi: tag klaim yang direkomendasikan dan putusannya (hanya aplikasi sintetis).",
  iotV: "Ventilator: sensor clamp di kabel dayanya (tanpa membuka alat) membaca dari pola arus listrik kapan ventilator jalan, siaga atau mati, dan berapa lama. Tidak mengukur kondisi pasien.",
  iotH: "Mesin hemodialisis (HD): sensor clamp di kabel daya membaca kapan mesin menjalankan sesi dan berapa lama. Tidak mengukur kondisi pasien.",
  iotM: "Monitor bed ICU: sensor clamp di kabel daya membaca kapan monitor menyala, dasar hitungan hari ICU. Tidak mengukur kondisi pasien.",
  iotAi: "AIoT Verification System: menyusun sesi alat dari pembacaan sensor (jalan, siaga atau mati dari pola arus), mengikat setiap sesi ke pasien dan kunjungannya (binding alat ↔ pasien) dengan jejak alat dikunci sebelum klaim diajukan, lalu membandingkan pemakaian alat dengan yang ditagih: kode 96.72 hanya sah bila ventilator jalan ≥ 96 jam berturut-turut; alat yang hanya siaga tidak dihitung dipakai; satu alat tidak boleh terikat ke dua pasien pada jam yang sama; hemodialisis < 3 jam bukan sesi penuh; hari ICU tidak melebihi waktu monitor menyala; jejak alat harus utuh. Yang tidak sesuai menjadi tag IoT di Tag aturan.",
};
// the IoT rules (testing/iot_cabang.py) in plain words for the log, by device state only
const ATURAN_IOT: Record<string, string> = {
  vent_run_96: "96.72 tanpa 96 jam jalan berturut-turut", vent_hours: "jam jalan ventilator < jam ditagih", niv_as_invasive: "mode ventilator tidak sesuai tagihan",
  vent_standby: "ventilator hanya siaga", binding_tumpang: "alat terikat ke dua pasien", no_device_trace: "tanpa jejak alat", hd_short: "HD < 3 jam ditagih penuh",
  hd_phantom: "HD tanpa sesi mesin", icu_days: "hari ICU melebihi monitor menyala", anchor_mismatch: "jejak alat diubah", faskes_offline: "gateway offline",
};

// ---------------------------------------------------------------- the replay, built from the run's outputs
type Jenis = "data" | "ml" | "iot" | "indikasi" | "agen" | "kode" | "keputusan" | "laporan";
type Pk = [XY[], string, number?];
type Fitur = { k: KasusBagan; label: string; batch: string } | null;
type St = {
  masuk: number; baris: number; sinyal: number; dinilai: number; zona: { lolos: number; ragu: number; tahan: number } | null;
  tagA: number; tagM: number; kek: boolean; bertag: number;
  box: number;  // 0 not yet, 1 the hospitals are in the box, 2 their groups by estimated loss are filled
  iot: number;  // the AIoT stage reached: 1 devices read, 3 sessions bound, 4 the check runs, 5 its verdicts, 6 the IoT tags sent
  jalur: boolean;  // the path per hospital is on the dashboard
  batch: number; jalan: number; dibaca: number; periksa: number; bersih: number;
  panggilan: number; token: number; usd: number; nilai: number; narasi: number; dibuang: number | null; antrean: number; ledger: string; putusan: boolean;
  kerja: Record<string, number>; pernah: Set<string>; fase: string; fitur: Fitur; log: Baris[]; selesai: boolean;
};
type Baris = { at: number; jenis: Jenis; siapa: string; teks: string; warna?: string };
type Ev = { at: number; fase: string; jenis: Jenis; siapa: string; teks: string; warna?: string; pk?: Pk[]; fx?: (s: St) => void; kerja?: [string, number][] };
type Rencana = { ev: Ev[]; total: number; fase: { k: string; mulai: number; selesai: number }[]; batch: number; v7: boolean };
const baru = (): St => ({ masuk: 0, baris: 0, sinyal: 0, dinilai: 0, zona: null, tagA: 0, tagM: 0, kek: false, bertag: 0, box: 0, iot: 0, jalur: false, batch: 0, jalan: 0, dibaca: 0, periksa: 0, bersih: 0,
  panggilan: 0, token: 0, usd: 0, nilai: 0, narasi: 0, dibuang: null, antrean: 0, ledger: "", putusan: false, kerja: {}, pernah: new Set(), fase: "", fitur: null, log: [], selesai: false });

const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const rp = (v: number) => (v >= 1e9 ? `Rp ${id(v / 1e9, 2)} M` : v >= 1e6 ? `Rp ${id(v / 1e6, 1)} jt` : `Rp ${id(v)}`);
const tok = (v: number) => (v >= 1e6 ? `${id(v / 1e6, 1)} jt` : v >= 1e3 ? `${id(v / 1e3)} rb` : id(v));
const usd = (v: number) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
const pendek = (s: string, n = 130) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
// an approximate text width (the app's sans font, em per character) for laying out labels and pills inside the cards
const lebar = (t: string, px: number) => [...t].reduce((a, ch) => a + (/[0-9]/.test(ch) ? 0.6 : ch === " " ? 0.25 : /[·.,:]/.test(ch) ? 0.2 : /[ijl]/.test(ch) ? 0.26
  : /[frt]/.test(ch) ? 0.39 : /[mw]/.test(ch) ? 0.85 : ch === "—" ? 0.9 : /[A-Z]/.test(ch) ? 0.68 : 0.58), 0) * px;
const sesudah = (v: string, px = 26) => 12 + lebar(v, px) * 1.05 + 7;  // where a label starts after a big (semibold) number
const ringkasKelompok = (b: BoxBagan) => KELOMPOK.map((g) => `${g}·${id(b.kelompok[g]?.rs ?? 0)}`).join(" ");

function susun(p: Props): Rencana {
  const s = p.sampul, v7 = /v7/i.test(s.model ?? ""), ev: Ev[] = [], fase: Rencana["fase"] = [];
  let t = 0, f = "";
  const mulai = (k: string) => { if (fase.length) fase[fase.length - 1].selesai = t; fase.push({ k, mulai: t, selesai: t }); f = k; };
  const add = (dt: number, e: Omit<Ev, "at" | "fase">) => { t += dt; ev.push({ at: t, fase: f, ...e }); };
  const dibaca = p.kasus.filter((k) => k.agen).sort((a, b) => hash(a.id) - hash(b.id));
  const tahanL = p.kasus.filter((k) => k.keputusan === "TAHAN");
  const batches: KasusBagan[][] = [];
  for (let i = 0; i < dibaca.length; i += 8) batches.push(dibaca.slice(i, i + 8));
  const B = batches.length || Math.max(0, Math.round(p.batchLive ?? 0)), bs = p.run?.biaya_swarm, nb = Math.max(1, bs?.selesai ?? 0);
  const perBatch = { panggilan: bs?.panggilan ? bs.panggilan / nb : 4, token: bs ? ((bs.token_masuk ?? 0) + (bs.token_keluar ?? 0)) / nb : 0, usd: bs?.usd_perkiraan ? bs.usd_perkiraan / nb : 0 };
  const satuKc = (p.run?.kc ?? 1) === 1;
  const modelNama = v7 ? "ML v7" : (s.model ?? "Model v4");
  const ix = p.indikasi, d = ix?.data;

  // 1. assignment
  mulai("penugasan");
  add(300, { jenis: "kode", siapa: "orch", teks: `Run dimulai · ${p.kc} · ${id(s.klaim)} klaim FKRTL · ${p.periode} · ${p.riil ? "data riil sampel BPJS" : "data sintetis"}`, kerja: [["orch", 5200]] });
  add(1100, { jenis: "kode", siapa: "orch", teks: `Rencana: data mentah → rule engine + fitur → ${modelNama} → indikasi (tag aturan + tag model) → zona RAGU dibaca AI Agent Swarm → laporan KC → dashboard keputusan`,
    pk: LAJUR.map((l) => [R[`orch>${l.k}`], C.orch, 1] as Pk) });
  add(1100, { jenis: "kode", siapa: "redaksi", teks: p.riil ? "Aktif: hanya fakta turunan fitur; tanpa ID peserta/klaim/RS, tanggal, atau nominal rupiah; ID disamarkan K1–K8"
    : "Aktif: hanya fakta turunan fitur; tanpa skor model, label, atau nama skema; ID disamarkan K1–K8", pk: [[R["orch>redaksi"], C.kode, 2]] });
  add(1100, { jenis: "kode", siapa: "biaya", teks: "Aktif: token setiap panggilan model dihitung; batch baru mulai hanya di bawah batas biaya; 5 batch gagal beruntun menghentikan run",
    pk: [[R["orch>biaya"], C.kode, 2]] });
  if (p.riil) add(1000, { jenis: "kode", siapa: "l-ingest", teks: "Engine berjalan lokal: semua koneksi keluar selain localhost diblokir (pakta integritas)" });

  // 2. raw data -> validation -> the rule engine and the feature store
  mulai("ingest");
  add(900, { jenis: "data", siapa: "mentah", teks: `Data mentah: ${id(d?.baris ?? s.klaim)} baris klaim FKRTL${d ? ` · ${d.kolom} kolom` : ""} (kunjungan, peserta, RS, kode INA-CBG, tarif, tindakan, top-up) · ${p.periode}`,
    fx: (x) => { x.baris = d?.baris ?? s.klaim; }, kerja: [["mentah", 1800], ["l-ingest", 1800]], pk: [[R["l-ingest>mentah"], C.ingest, 2]] });
  add(1000, { jenis: "data", siapa: "validasi", teks: `Validasi skema klaim: ${id(d?.baris ?? s.klaim)} baris valid · 0 ditolak${d ? ` · ${id(d.peserta)} peserta · ${id(d.rs)} profil RS` : ""}`,
    kerja: [["validasi", 1600]], pk: [[ke("mentah", "validasi"), C.ingest, 3]] });
  const N = 6;
  for (let i = 1; i <= N; i++) {
    const n = Math.round((s.klaim * i) / N);
    add(i === 1 ? 900 : 950, { jenis: "data", siapa: "validasi", teks: `Klaim masuk ${id(n)}/${id(s.klaim)} (urut tanggal) → engine realtime: rule engine + engine fitur`,
      fx: (x) => { x.masuk = n; }, kerja: [["validasi", 1300], ["aturan", 1300], ["stream", 1300], ["l-ingest", 1300]],
      pk: [[ke("validasi", "aturan"), C.indikasi, 2], [ke("validasi", "stream"), C.ingest, 3], [ke("stream", "toko"), C.ingest, 2], [ke("stream", "f4"), C.ingest, 1]] });
    if (i === 3 && d) {
      const top = d.sinyal.slice(0, 3).map((x) => `${x.label} ×${x.n}`).join(", ");
      add(500, { jenis: "indikasi", siapa: "aturan", teks: `Rule engine: ${id(d.klaim_bersinyal)} klaim memicu sinyal aturan${top ? ` · terbanyak: ${top}` : ""}; sinyal disimpan di event store`,
        fx: (x) => { x.sinyal = d.klaim_bersinyal; }, kerja: [["aturan", 2000]], pk: [[R["aturan>bus"], C.indikasi, 3]] });
    }
    if (i === 2) add(450, { jenis: "data", siapa: "stream", teks: "624 fitur per klaim: 124 fitur klaim itu sendiri + 500 fitur tetangga dari klaim sebelumnya dengan peserta, RS, RS + kode atau kode INA-CBG yang sama", kerja: [["stream", 1500]] });
    if (i === 4) add(450, { jenis: "data", siapa: "f4", teks: "22 fitur mekanisme per klaim (persentil tarif, biaya, LOS dan dx sekunder terhadap kode INA-CBG yang sama)",
      kerja: [["f4", 1500]], pk: [[ke("f4", "toko"), C.ingest, 2]] });
  }
  add(900, { jenis: "data", siapa: "toko", teks: `Siap: ${id(s.klaim)} klaim × 646 fitur · ${id(s.rs)} profil RS`, kerja: [["toko", 1800]],
    pk: [[R["toko>bus"], C.ingest, 3], [keKartu(0, 155), C.ingest, 2]] });

  // 3. the ML block
  mulai("ml");
  add(900, { jenis: "ml", siapa: "l-ml", teks: v7
    ? "Pilihan A1: LightGBM × 3 seed (300 pohon, 15 daun) pada 646 fitur; dilatih di data sintetis G1 + G2 + G2-halus, dipilih lewat leave-one-generator-out dari 4 kandidat"
    : `${modelNama}: LightGBM × 3 seed (300 pohon, 15 daun) pada 646 fitur; dilatih di data sintetis`, kerja: [["l-ml", 1600]],
    pk: [[R["l-ml>box"], C.ml, 2]] });
  // the claim graph: the model reads every claim with its neighbours, not alone (testing/fitur.py, the X1 neighbour blocks)
  add(1000, { jenis: "ml", siapa: "graf", teks: `Graph klaim: setiap klaim dihubungkan ke klaim sebelumnya lewat peserta, RS, RS + kode dan kode INA-CBG yang sama → 500 fitur tetangga dibaca ${modelNama}`,
    kerja: [["graf", 2400], ["toko", 1200]], pk: [[R["toko>graf"], C.ml, 3], [R["graf>lgb0"], C.ml, 1], [R["graf>lgb1"], C.ml, 1], [R["graf>lgb2"], C.ml, 1]] });
  add(1100, { jenis: "ml", siapa: "graf", teks: "646 fitur per klaim = 124 fitur klaim itu sendiri + 500 fitur tetangga (untuk tiap relasi: rata-rata fitur tetangga + jumlah tetangga; paling banyak 10/10/10/5 klaim terakhir) + 22 fitur mekanisme",
    kerja: [["graf", 1600], ["lgb0", 1000], ["lgb1", 1000], ["lgb2", 1000]], pk: [[R["graf>lgb0"], C.ml, 2], [R["graf>lgb1"], C.ml, 2], [R["graf>lgb2"], C.ml, 2]] });
  const M = 5;
  for (let i = 1; i <= M; i++) {
    const n = Math.round((s.klaim * i) / M);
    add(1000, { jenis: "ml", siapa: "lgb" + ((i - 1) % 3), teks: `LightGBM seed 0 · 1 · 2 menilai blok ${i}/${M}: ${id(n)}/${id(s.klaim)} klaim beserta tetangga graph-nya → skor s = rata-rata 3 probabilitas`,
      fx: (x) => { x.dinilai = n; }, kerja: [["graf", 1200], ["lgb0", 1200], ["lgb1", 1200], ["lgb2", 1200], ["rata", 1200]],
      pk: [[ke("toko", "graf"), C.ml, 1], [ke("graf", "lgb0"), C.ml, 1], [ke("graf", "lgb1"), C.ml, 1], [ke("graf", "lgb2"), C.ml, 1], [ke("lgb0", "rata"), C.ml, 1], [ke("lgb1", "rata"), C.ml, 1],
        [ke("lgb2", "rata"), C.ml, 1], [ke("rata", "router"), C.ml, 2]] });
    if (i === 2) {
      const hit: Record<string, number> = {};
      for (const k of [...tahanL, ...dibaca]) for (const r of k.rule ?? []) hit[r] = (hit[r] ?? 0) + 1;
      const top = Object.entries(hit).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const nRule = [...tahanL, ...dibaca].filter((k) => (k.rule ?? []).length).length;
      add(500, { jenis: "kode", siapa: "rule", teks: `Aturan telaah: ${id(nRule)} klaim TAHAN/RAGU menyalakan aturan${top.length ? ` · terbanyak ${top.map(([r, n]) => `${r} ×${n}`).join(", ")}` : ""}`,
        kerja: [["rule", 1800]], pk: [[ke("toko", "rule"), C.ml, 2], [ke("rule", "router"), C.kode, 2]] });
    }
  }
  add(900, { jenis: "ml", siapa: "router", teks: v7 ? "Ambang zona (dev sintetis): TAHAN bila s ≥ 0,78 (FPR 0,1%) · RAGU bila s ≥ 0,12 (FPR 3%) atau aturan menyala · selain itu LOLOS"
    : "Ambang zona (set validasi sintetis): TAHAN bila s ≥ ambang tahan · RAGU bila s ≥ ambang lebar atau aturan menyala · selain itu LOLOS", kerja: [["router", 1500]] });
  add(1000, { jenis: "keputusan", siapa: "router", teks: `TAHAN ${id(s.tahan)} · RAGU ${id(s.ragu)} · LOLOS ${id(s.lolos)}`,
    fx: (x) => { x.zona = { lolos: s.lolos, ragu: s.ragu, tahan: s.tahan }; }, kerja: [["router", 1600]],
    pk: [[ke("router", "ragu"), C.swarm, 2], [ke("router", "lolos"), C.lolos, 3], ...(s.tahan ? [[ke("router", "tahan"), C.tahan, 2] as Pk] : []), [[...R["lolos>bus"], ...keKartu(1, 436)], C.ml, 3]] });
  if (p.riil && v7) add(900, { jenis: "ml", siapa: "router", teks: "Catatan data riil: porsi TAHAN dan RAGU jauh di bawah target dev sintetis; ambang perlu dikalibrasi ulang di data riil (Lampiran A)", warna: C.periksa });

  // 4. AIoT (runs with the IoT layer): device use read by a clamp on each power cable -> the AIoT Verification System (sessions
  // bound to the patient, device use against the bill) -> the IoT tag into Tag aturan
  const io = p.iot;
  if (io) {
    mulai("aiot");
    const alat = ["iotV", "iotH", "iotM"] as const;
    const ts = io.tidak_sesuai, ses = io.sesuai, tb = io.tanpa_bukti;
    add(900, { jenis: "iot", siapa: "iotSensor", teks: `Sensor clamp (tanpa membuka alat) di kabel daya ${io.alat != null ? `${id(io.alat)} alat` : "alat medis"}${io.rs_dengan_iot != null ? ` di ${id(io.rs_dengan_iot)} RS` : ""}: ventilator, hemodialisis, monitor ICU → kapan jalan, siaga atau mati dan berapa lama, dibaca dari pola arus listrik; bukan tanda vital pasien`,
      fx: (x) => { x.iot = 1; }, kerja: [["iotV", 1900], ["iotH", 2200], ["iotM", 2500]], pk: alat.map((a) => [R[`${a}>iotAi`], C.iot, 2] as Pk) });
    add(1100, { jenis: "iot", siapa: "iotAi", teks: `Sesi alat disusun dari pola arus (jalan · siaga · mati) dan diikat ke pasien + kunjungan (binding) → ${id(io.klaim_dengan_alat)} klaim punya bukti alat; jejak alat dikunci sebelum klaim diajukan`,
      fx: (x) => { x.iot = 3; }, kerja: [["iotAi", 2300], ["iotV", 900], ["iotH", 900], ["iotM", 900]], pk: alat.map((a) => [R[`${a}>iotAi`], C.iot, 1] as Pk) });
    add(1000, { jenis: "iot", siapa: "iotAi", teks: "Membandingkan pemakaian alat dengan klaim, dengan aturan yang dapat dijelaskan: 96.72 butuh ≥ 96 jam jalan berturut-turut · alat siaga tidak dihitung dipakai · satu alat tidak terikat ke dua pasien sekaligus · jejak alat utuh",
      fx: (x) => { x.iot = 4; }, kerja: [["iotAi", 2900]] });
    add(1800, { jenis: "iot", siapa: "iotAi", warna: ts ? C.tahan : undefined,
      teks: `${id(io.klaim_dengan_alat)} klaim dengan bukti alat:${ses != null ? ` ✓ ${id(ses)} sesuai ·` : ""} ✕ ${id(ts)} tidak sesuai${tb != null ? ` · – ${id(tb)} tanpa bukti` : ""}${io.selisih_rp ? ` · selisih tarif ${rp(io.selisih_rp)}` : ""}`,
      fx: (x) => { x.iot = 5; }, kerja: [["iotAi", 1500]], pk: ses ? [[IOT_SESUAI, C.selesai, Math.min(4, ses)]] : [] });
    const top = [...(io.aturan ?? [])].sort((a, b) => b.klaim - a.klaim).slice(0, 3).map((a) => `${ATURAN_IOT[a.aturan] ?? a.aturan} ×${id(a.klaim)}`).join(", ");
    add(1100, { jenis: "iot", siapa: "iotAi", warna: ts ? C.tahan : undefined,
      teks: ts ? `${id(ts)} tag IoT → Tag aturan di Indikasi${top ? ` · ${top}` : ""}` : "Tidak ada klaim yang tidak sesuai: tidak ada tag IoT",
      fx: (x) => { x.iot = 6; }, kerja: [["iotAi", 1300], ["tagAturan", 1900]], pk: ts ? [[R["iotAi>tagAturan"], C.tahan, Math.min(5, ts)]] : [] });
  }

  // 5. Indikasi: the first output, before any agent
  mulai("indikasi");
  if (ix) {
    const topA = ix.per_tag.filter((x) => x.sumber === "aturan").slice(0, 3).map((x) => `${x.label} ×${x.n}`).join(", ");
    add(1000, { jenis: "indikasi", siapa: "tagAturan", teks: `Tag aturan: ${id(ix.tag_aturan)} tag dari sinyal rule engine dan aturan telaah${topA ? ` · terbanyak: ${topA}` : ""}`,
      fx: (x) => { x.tagA = ix.tag_aturan; }, kerja: [["tagAturan", 2000], ["l-indikasi", 2000]],
      pk: [[R["l-indikasi>box"], C.indikasi, 1], [R["bus>tagAturan"], C.indikasi, 3], [R["rule>tagAturan"], C.ml, 2]] });
    add(1100, { jenis: "indikasi", siapa: "tagModel", teks: `Tag model ${modelNama}: ${id(ix.tag_model)} klaim dengan skor s ≥ ${id(ix.ambang.ragu, 2)} → tag "Risiko tinggi menurut model"`,
      fx: (x) => { x.tagM = ix.tag_model; }, kerja: [["tagModel", 2000]], pk: [[R["rata>tagModel"], C.ml, 3]] });
    add(1100, { jenis: "kode", siapa: "kekuatan", teks: `Kekuatan = aturan × skor ML: kuat ${id(ix.kekuatan.kuat)} · sedang ${id(ix.kekuatan.sedang)} · lemah ${id(ix.kekuatan.lemah)}`,
      fx: (x) => { x.kek = true; }, kerja: [["kekuatan", 1800], ["kuat", 1600], ["sedang", 1600], ["lemah", 1600]],
      pk: [[R["tagAturan>kekuatan"], C.indikasi, 2], [R["tagModel>kekuatan"], C.indikasi, 2], [R["kekuatan>kuat"], C.tahan, Math.min(3, 1 + Math.floor(ix.kekuatan.kuat / 20))],
        [R["kekuatan>sedang"], C.periksa, Math.min(3, 1 + Math.floor(ix.kekuatan.sedang / 20))], [R["kekuatan>lemah"], C.lemah, Math.min(3, 1 + Math.floor(ix.kekuatan.lemah / 20))]] });
    add(1100, { jenis: "keputusan", siapa: "l-indikasi", teks: `${id(ix.klaim_bertag)} dari ${id(ix.klaim)} klaim bertag (${id((100 * ix.klaim_bertag) / Math.max(1, ix.klaim), 1)}%); klaim tanpa tag dan di bawah ambang lolos tanpa telaah`,
      fx: (x) => { x.bertag = ix.klaim_bertag; }, kerja: [["l-indikasi", 1500]], pk: [[R["ix>bus"], C.indikasi, 3], [keKartu(2, 697), C.indikasi, 3]] });
    add(900, { jenis: "kode", siapa: "l-indikasi", teks: "Tag tampil di laporan KC; buku besar indikasi hanya menerima tag klaim yang direkomendasikan (TAHAN/PERIKSA)" });
  } else {
    add(1000, { jenis: "indikasi", siapa: "l-indikasi", teks: "Ringkasan tag belum ada di laporan run ini (buat ulang laporan dengan testing/laporan_cabang.py)" });
  }
  for (const k of tahanL.slice(0, 5)) {
    add(650, { jenis: "keputusan", siapa: "router", warna: C.tahan, teks: `TAHAN ${k.id} · ${k.rs} · ${k.inacbg} · skor s ${id(Number(k.skor_model), 2)}${(k.rule ?? []).length ? ` · aturan ${(k.rule ?? []).join(", ")}` : ""}`,
      pk: [[[...ke("router", "tahan"), ...R["tahan>bus"], ...viaBus(470, 1265).slice(1), ...balik(R["antrean>bus"]), P.antrean], C.tahan, 1]], kerja: [["tahan", 900]] });
  }
  if (tahanL.length > 5) add(500, { jenis: "keputusan", siapa: "router", warna: C.tahan, teks: `… dan ${id(tahanL.length - 5)} klaim TAHAN lain` });
  add(800, { jenis: "keputusan", siapa: "router", teks: `LOLOS ${id(s.lolos)} klaim kembali ke jalur bayar normal; RAGU ${id(s.ragu)} klaim ke AI Agent Swarm`,
    pk: [[[...R["lolos>bus"], ...viaBus(436, KELUAR).slice(1, 3)], C.lolos, 4]] });

  // 6. the branch's Box Karantina: every hospital with a tag; its groups by estimated loss come with the report
  mulai("box");
  const bx = p.box;
  if (bx) {
    add(1100, { jenis: "kode", siapa: "box", teks: `Box Karantina: ${id(bx.rs)} RS dengan minimal satu tag masuk karantina (dari ${id(bx.rs_klaim)} RS yang punya klaim di KC)`,
      fx: (x) => { x.box = 1; }, kerja: [["box", 2200], ["l-indikasi", 1400]], pk: [[[...R["ix>bus"], ...keKartu(3, 697)], C.box, 4]] });
    add(1000, { jenis: "kode", siapa: "box", teks: "Kelompok A–Z menurut estimasi kerugian per RS diisi setelah laporan menghitung kerugian klaim yang direkomendasikan" });
  } else {
    add(1000, { jenis: "kode", siapa: "box", teks: "Box Karantina belum ada di laporan run ini (buat ulang laporan dengan testing/laporan_cabang.py)" });
  }

  // 7. the swarm
  mulai("swarm");
  add(1100, { jenis: "kode", siapa: "redaksi", teks: `${id(dibaca.length)} berkas fitur disusun dari penyimpanan fitur, diacak (seed tetap), dibagi ${id(B)} batch × 8 klaim (K1–K8)`,
    kerja: [["redaksi", 2200], ["ragu", 2200]], pk: [[R["ragu>redaksi"], C.swarm, 4], [R["redaksi>l-swarm"], C.swarm, 3]] });
  if (!batches.length && B) {
    // a running audit: its batches known by number only (the runner's progress), read by the specialists, the judge and the gate
    const g2 = Math.ceil(B / Math.min(B, 12)), per2 = 4200;
    for (let b0 = 1; b0 <= B; b0 += g2) {
      const b1 = Math.min(B, b0 + g2 - 1), lbl = b0 === b1 ? `${b0}/${B}` : `${b0}–${b1}/${B}`, T = t;
      add(0, { jenis: "agen", siapa: "l-swarm", teks: `Batch ${lbl} → AI Agent Swarm (spesialis → hakim → gerbang τ)`, fx: (x) => { x.jalan = b1; },
        kerja: [["l-swarm", per2 * 0.95], ["redaksi", per2 * 0.3]], pk: [[R["ragu>redaksi"], C.swarm, 2], [R["redaksi>l-swarm"], C.swarm, 2], [R["orch>l-swarm"], C.orch, 1]] });
      t = T + per2 * 0.14;
      add(0, { jenis: "agen", siapa: "l-swarm", teks: "Tiga spesialis membaca berkas yang sama bersamaan",
        kerja: [["koding", per2 * 0.5], ["tagihan", per2 * 0.5], ["episode", per2 * 0.5], ["vertex", per2 * 0.55]],
        pk: (["koding", "tagihan", "episode"] as const).flatMap((a) => [[R[`l-swarm>${a}`], C.swarm, 2] as Pk, [[P[a], xy(935, 284), P.vertex], C.vertex, 2] as Pk]) });
      t = T + per2 * 0.55;
      add(0, { jenis: "agen", siapa: "hakim", teks: "Hakim membaca berkas dan tiga pendapat", kerja: [["hakim", per2 * 0.3], ["vertex", per2 * 0.2]],
        pk: (["koding", "tagihan", "episode"] as const).map((a) => [ke(a, "hakim"), C.swarm, 2] as Pk) });
      t = T + per2 * 0.8;
      add(0, { jenis: "keputusan", siapa: "tau", teks: `Gerbang τ 0,72 · batch ${lbl}`, fx: (x) => { x.batch = b1; }, kerja: [["tau", per2 * 0.3]],
        pk: [[[...R["tau>bus"], ...viaBus(898, 1265).slice(1), ...balik(R["antrean>bus"]), P.antrean], C.periksa, 2], [[...R["tau>bus"], ...viaBus(898, KELUAR).slice(1, 3)], C.lolos, 2]] });
      t = T + per2;
    }
  } else {
  const langkah = Math.min(B, 22), g = Math.ceil(B / Math.max(1, langkah));
  const per = Math.max(3000, Math.min(6500, 52000 / Math.max(1, Math.ceil(B / g))));
  let bi = 0;
  while (bi < B) {
    const grup = batches.slice(bi, bi + g), b0 = bi + 1, b1 = bi + grup.length;
    const isi = grup.flat(), lbl = b0 === b1 ? `${b0}/${B}` : `${b0}–${b1}/${B}`;
    const kLabel = (k: KasusBagan) => { for (const bt of grup) { const j = bt.indexOf(k); if (j >= 0) return `K${j + 1}`; } return "K?"; };
    const nP = isi.filter((k) => k.keputusan === "PERIKSA" || k.keputusan === "TAHAN").length, nB = isi.length - nP;
    const fitur = [...isi].sort((a, b) => (b.p_hakim ?? b.agen?.hakim?.p ?? 0) - (a.p_hakim ?? a.agen?.hakim?.p ?? 0))[0];
    const T = t;
    add(0, { jenis: "agen", siapa: "l-swarm", teks: `Batch ${lbl}: ${isi.length} berkas (K1–K${Math.min(8, isi.length)}) → AI Agent Swarm (spesialis → hakim → gerbang τ)`,
      fx: (x) => { x.jalan = b1; }, kerja: [["l-swarm", per * 0.95]], pk: [[R["orch>l-swarm"], C.orch, 1], [R["redaksi>l-swarm"], C.swarm, 2]] });
    t = T + per * 0.12;
    add(0, { jenis: "agen", siapa: "l-swarm", teks: "Tiga spesialis (koding & klinis, tagihan, episode & jaringan) membaca berkas yang sama bersamaan",
      kerja: [["koding", per * 0.5], ["tagihan", per * 0.5], ["episode", per * 0.5], ["vertex", per * 0.55]],
      pk: (["koding", "tagihan", "episode"] as const).flatMap((a) => [[R[`l-swarm>${a}`], C.swarm, 2] as Pk, [[P[a], xy(935, 284), P.vertex], C.vertex, 2] as Pk]) });
    (["koding", "tagihan", "episode"] as const).forEach((a, j) => {
      const top = [...isi].filter((k) => k.agen?.[a]).sort((x, y) => (y.agen?.[a]?.p ?? 0) - (x.agen?.[a]?.p ?? 0))[0];
      t = T + per * (0.4 + j * 0.07);
      const o = top?.agen?.[a];
      add(0, { jenis: "agen", siapa: a, teks: o ? `${kLabel(top)} skor ${id(o.p, 2)} · ${pendek(o.alasan || o.bukti || "", 120)}` : "tidak ada pendapat",
        pk: [[[P.vertex, xy(935, 284), P[a]], C.vertex, 1], [ke(a, "hakim"), C.swarm, 2]] });
    });
    t = T + per * 0.66;
    const oh = fitur?.agen?.hakim, ph = fitur ? (fitur.p_hakim ?? oh?.p ?? 0) : 0;
    add(0, { jenis: "agen", siapa: "hakim", teks: fitur ? `Membaca berkas + 3 pendapat · ${kLabel(fitur)} p ${id(ph, 2)}${oh ? ` · ${pendek(oh.alasan || oh.bukti || "", 110)}` : ""}` : "Membaca berkas + 3 pendapat",
      fx: (x) => { x.fitur = fitur ? { k: fitur, label: kLabel(fitur), batch: lbl } : x.fitur; },
      kerja: [["hakim", per * 0.26], ["vertex", per * 0.2]], pk: [[[P.vertex, xy(935, 284), xy(840, 290), P.hakim], C.vertex, 1], [ke("hakim", "tau"), C.swarm, 2]] });
    t = T + per * 0.84;
    add(0, { jenis: "keputusan", siapa: "tau", warna: nP ? C.periksa : undefined, teks: `ambang 0,72 · batch ${lbl}: PERIKSA ${nP} · dibersihkan ${nB}`,
      fx: (x) => { x.dibaca += isi.length; x.periksa += nP; x.bersih += nB; x.batch = b1; }, kerja: [["tau", per * 0.3]],
      pk: [...(nP ? [[[...R["tau>bus"], ...viaBus(898, 1265).slice(1), ...balik(R["antrean>bus"]), P.antrean], C.periksa, Math.min(4, nP)] as Pk] : []),
        ...(nB ? [[[...R["tau>bus"], ...viaBus(898, KELUAR).slice(1, 3)], C.lolos, Math.min(4, nB)] as Pk] : []), [keKartu(4, 898), C.swarm, 2]] });
    t = T + per * 0.93;
    const pg = perBatch.panggilan * grup.length, tk = perBatch.token * grup.length, us = perBatch.usd * grup.length;
    add(0, { jenis: "kode", siapa: "biaya", teks: `Batch ${lbl}: ${id(Math.round(pg))} panggilan model${tk ? ` · ≈${tok(tk)} token` : ""}${us ? ` · ≈${usd(us)}` : ""} · di bawah batas`,
      fx: (x) => { x.panggilan += pg; x.token += tk; x.usd += us; }, kerja: [["biaya", per * 0.25]], pk: [[[xy(930, SWBOX.y0), xy(900, 140), P.biaya], C.kode, 2]] });
    t = T + per;
    bi += grup.length;
  }
  }

  // 8. the recommended claims
  mulai("keputusan");
  add(1000, { jenis: "keputusan", siapa: "antrean", warna: s.antrean ? C.periksa : undefined, teks: `TAHAN ${id(s.tahan)} + PERIKSA ${id(s.periksa)} = ${id(s.antrean)} klaim direkomendasikan · nilai ${rp(s.nilai_antrean_rp)} → dashboard keputusan`,
    fx: (x) => { x.antrean = s.antrean; }, kerja: [["antrean", 2000]], pk: [[[...R["antrean>bus"].slice().reverse(), P.antrean], C.periksa, 2], [keKartu(5, 1265), C.verif, 3]] });
  add(1100, { jenis: "keputusan", siapa: "tau", teks: `Dibersihkan: ${id(s.dibersihkan)} klaim RAGU kembali ke jalur bayar normal` });

  // 9. the branch report
  mulai("laporan");
  const mode: Record<string, number> = {};
  for (const k of p.kasus) if ((k.keputusan === "PERIKSA" || k.keputusan === "TAHAN") && k.tag_label) mode[k.tag_label] = (mode[k.tag_label] ?? 0) + Number(k.estimasi_kerugian_rp ?? 0);
  const topM = Object.entries(mode).sort((a, b) => b[1] - a[1])[0];
  const est = s.estimasi_kerugian_rp ?? 0;
  add(1100, { jenis: "laporan", siapa: "rugi", teks: `Per modus (kode): ${rp(est)} dari ${id(s.antrean)} klaim rekomendasi${topM && topM[1] > 0 ? ` · terbesar: ${topM[0]} ${rp(topM[1])}` : ""} · batas atas sebelum verifikasi`,
    fx: (x) => { x.nilai = 1; }, kerja: [["rugi", 2000]], pk: [[[xy(1265, BY), xy(1040, BY), ...balik(R["rugi>bus"]), P.rugi], C.laporan, 3], [ke("rugi", "exhibit"), C.laporan, 2]] });
  if (bx) add(1100, { jenis: "kode", siapa: "box", teks: `Box Karantina diperbarui: estimasi kerugian per RS dari klaim yang direkomendasikan → ${ringkasKelompok(bx)} (A = RS yang bersama-sama menanggung 50% pertama kerugian) · total ${rp(bx.estimasi_kerugian_rp)}`,
    fx: (x) => { x.box = 2; }, kerja: [["box", 2000], ["rugi", 1200]], pk: [[[...R["rugi>bus"], ...keKartu(3, 1040)], C.box, 4]] });
  add(1000, { jenis: "laporan", siapa: "rugi", teks: `Nilai transaksi ${rp(s.nilai_transaksi_rp ?? s.tagihan_rp)} · nilai klaim terindikasi ${rp(s.nilai_terindikasi_rp ?? s.nilai_antrean_rp)}`,
    fx: (x) => { x.nilai = 2; } });
  add(1000, { jenis: "laporan", siapa: "exhibit", teks: `${id(p.exhibit)} exhibit dan ${id(p.bab)} bab disusun per tema klinis (${id(s.tema_aktif)} tema aktif)`, kerja: [["exhibit", 1600]] });
  add(1000, { jenis: "agen", siapa: "penulis", teks: "Hanya menerima fakta agregat KC; menulis makna dan implikasi tiap exhibit",
    kerja: [["penulis", 3600], ["vertex", 3400]], pk: [[ke("exhibit", "penulis"), C.laporan, 3], [ke("penulis", "vertex"), C.vertex, 3]] });
  for (const fr of [0.5, 1]) {
    const n = Math.round(p.narasi * fr);
    add(1100, { jenis: "agen", siapa: "penulis", teks: `Narasi ${id(n)}/${id(p.exhibit)} exhibit`, fx: (x) => { x.narasi = n; },
      pk: [[ke("vertex", "penulis"), C.vertex, 2], [ke("penulis", "cek"), C.laporan, 2]] });
  }
  const dib = satuKc ? p.run?.kalimat_dibuang_cek_angka : undefined;
  add(1000, { jenis: "kode", siapa: "cek", teks: `Kode: setiap angka di narasi dicocokkan dengan fakta exhibit${dib != null ? `; ${id(dib)} kalimat dibuang` : "; kalimat tanpa sumber dibuang"}`,
    fx: (x) => { x.dibuang = dib ?? null; }, kerja: [["cek", 1600]], pk: [[ke("cek", "exhibit"), C.kode, 2]] });
  add(1000, { jenis: "laporan", siapa: "exhibit", teks: "Siap: tiga nilai di sampul, bab estimasi kerugian, bab per tema klinis, berkas kasus per klaim",
    fx: (x) => { x.nilai = 3; }, kerja: [["exhibit", 1800]], pk: [[[...R["exhibit>bus"], ...keKartu(4, 1136)], C.laporan, 3]] });

  // 10. the decision dashboard: a path per hospital (TSM, code), then people decide the paths and verify every recommended claim
  mulai("verifikasi");
  const pu = p.putusan, nPutus = pu.terbukti + pu.sesuai + pu.investigasi;
  add(1100, { jenis: "keputusan", siapa: "dash", teks: `${id(s.antrean)} klaim yang direkomendasikan tampil di dashboard keputusan KC, urut prioritas (P1 dulu), dengan berkas kasus dan penjelasan`,
    kerja: [["dash", 2000], ["antrean", 1200]], pk: [[ke("antrean", "dash"), C.verif, 3]] });
  const keDash: XY[] = [P.dash, ...ke("dash", "antrean"), ...R["antrean>bus"], ...keKartu(5, 1265)];
  if (bx) {
    for (const kr of (bx.kriteria ?? []).slice(0, 3)) add(800, { jenis: "kode", siapa: "dash", teks: `TSM per RS (kode, dari data batch ini) · ${kr}`, kerja: [["dash", 1000]] });
    const j = bx.jalur;
    add(1100, { jenis: "keputusan", siapa: "dash", warna: j.ditindak ? C.tahan : undefined,
      teks: `Jalur RS menurut TSM (kode): ditindak ${id(j.ditindak)} · dibina ${id(j.dibina)} · dibebaskan ${id(j.dibebaskan)} (ditindak = Terstruktur + Sistematis + Masif terpenuhi · dibina = minimal satu · dibebaskan = tidak ada)`,
      fx: (x) => { x.jalur = true; }, kerja: [["dash", 2000]],
      pk: JALUR.filter(([k]) => j[k] > 0).map(([k, w]) => [keDash, w, Math.min(3, j[k])] as Pk) });
  } else {
    add(1000, { jenis: "keputusan", siapa: "dash", teks: "Jalur RS (ditindak, dibina, dibebaskan) belum ada: Box Karantina belum dihitung di laporan run ini" });
  }
  add(1000, { jenis: "keputusan", siapa: "putusan", teks: nPutus
    ? `Verifikasi klaim (manusia): ${id(nPutus)} diputuskan (terbukti ${id(pu.terbukti)} · sesuai ${id(pu.sesuai)} · investigasi ${id(pu.investigasi)}) · ${id(Math.max(0, s.antrean - nPutus))} menunggu`
    : `Verifikasi klaim (manusia): 0 diputuskan · ${id(s.antrean)} menunggu; setiap klaim yang direkomendasikan diputuskan terbukti bermasalah, sesuai, atau perlu investigasi`,
    fx: (x) => { x.putusan = true; }, kerja: [["putusan", 1800]], pk: [[ke("dash", "putusan"), C.verif, 2], [keDash, C.verif, 2]] });
  const led = p.riil ? "tidak dihubungkan (data riil)" : p.ledger?.tag ? `${id(p.ledger.tag)} tag tercatat` : p.ledger?.error ? "belum tersambung" : "belum dikirim";
  add(1000, { jenis: "kode", siapa: "ledger", teks: p.riil ? "Tidak dihubungkan: data riil tidak boleh masuk buku besar aplikasi sintetis" : `Buku besar indikasi: ${led}`,
    fx: (x) => { x.ledger = led; }, kerja: p.riil ? [] : [["ledger", 1600]], pk: p.riil ? [] : [[ke("putusan", "ledger"), C.verif, 2]] });
  add(1000, { jenis: "kode", siapa: "orch", teks: `Run selesai${p.run?.biaya_usd != null ? ` · biaya AI run ${usd(p.run.biaya_usd)}` : ""}`, fx: (x) => { x.selesai = true; }, kerja: [["orch", 1200]] });
  fase[fase.length - 1].selesai = t + 1200;
  return { ev, total: t + 1200, fase, batch: B, v7 };
}

// a running audit's stages (testing/jalan_kc_tema.py) in words, and the chart phase each one plays
const TAHAP_LIVE: Record<string, [string, string]> = { fitur: ["Data & fitur", "ingest"], zona: ["Skoring ML v7", "ml"], iot: ["AIoT", "aiot"],
  aturan: ["Indikasi + rekam medis", "indikasi"], swarm: ["AI Agent Swarm", "swarm"], laporan: ["Laporan KC", "laporan"], narasi: ["Narasi laporan", "laporan"] };
// a line of the runner's log, coloured by the system it speaks of
const warnaLog = (l: string) => (/swarm|batch|hakim|agen|gerbang/i.test(l) ? C.swarm : /\biot\b|alat|sensor/i.test(l) ? C.iot : /zona|ml v7|skor|ragu|tahan/i.test(l) ? C.ml
  : /aturan|rme|rekam|temuan/i.test(l) ? C.indikasi : /laporan|narasi|graf|exhibit/i.test(l) ? C.laporan : /chunk|replika|fitur|engine|data/i.test(l) ? C.ingest : "#8f99a8");
/** The frame's numbers from the running audit (the plan's own are placeholders): claims in so far, zones and gate once known, spend. */
function stLangsung(s0: St, L: LangsungBagan, klaim: number): St {
  const s = { ...s0 }, sel = (t: string) => L.tahap_selesai.includes(t), kini = (t: string) => L.tahap === t, pr = L.progres;
  if (kini("fitur")) { s.masuk = pr?.replika_total ? Math.round((klaim * (pr.replika_selesai ?? 0)) / pr.replika_total) : 0; s.baris = s.masuk; }
  else if (sel("fitur")) { s.masuk = klaim; s.baris = klaim; }
  if (L.sinyal && klaim) s.sinyal = Math.round((L.sinyal.klaim_bersinyal * s.masuk) / klaim);
  if (L.iot_hasil && sel("iot")) s.iot = Math.max(s.iot, 6);
  if (sel("zona") && L.zona) {
    s.dinilai = klaim; s.zona = { tahan: L.zona.tahan, ragu: L.zona.ragu, lolos: Math.max(0, klaim - L.zona.tahan - L.zona.ragu) };
    s.tagM = L.zona.tahan + L.zona.ragu;  // a model tag: score at or above the RAGU threshold (laporan_cabang.indikasi_kc)
  } else { s.zona = null; if (!kini("zona")) s.dinilai = 0; }
  // the report's tag summary, when the audit already has it (the /swarm-x demo): its own counts replace the zone-based model tags
  if (L.indikasi && sel("aturan")) { s.tagA = L.indikasi.tag_aturan; s.tagM = L.indikasi.tag_model; s.bertag = L.indikasi.klaim_bertag; s.kek = true; }
  if (L.laporan && sel("laporan")) {
    s.box = 2; s.jalur = true; s.antrean = L.laporan.antrean; s.nilai = 2;
    s.narasi = sel("narasi") || L.status === "selesai" ? L.laporan.exhibit : kini("narasi") ? Math.floor(L.laporan.exhibit / 2) : 0;
  }
  if (kini("swarm") && pr?.batch != null) { s.batch = pr.batch; s.jalan = Math.max(s.jalan, pr.batch); s.dibaca = Math.min(L.zona?.ragu ?? pr.batch * 8, pr.batch * 8); }
  if (L.gerbang?.dibaca != null) { s.dibaca = L.gerbang.dibaca; s.periksa = L.gerbang.periksa ?? s.periksa; s.bersih = L.gerbang.dibersihkan ?? s.bersih; }
  s.usd = L.usd;
  return s;
}
const lamaJalan = (ms: number) => { const m = Math.floor(ms / 60000), j = Math.floor(m / 60); return j ? `${j} j ${String(m % 60).padStart(2, "0")} m` : `${m} m ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")} d`; };

function terapkan(s: St, e: Ev) {
  s.fase = e.fase;
  e.fx?.(s);
  for (const [k, d] of e.kerja ?? [[e.siapa, 1400] as [string, number]]) { s.kerja[k] = Math.max(s.kerja[k] ?? 0, e.at + d); s.pernah.add(k); }
  s.log.push({ at: e.at, jenis: e.jenis, siapa: e.siapa, teks: e.teks, warna: e.warna });
}

// ---------------------------------------------------------------- packets
type Paket = { pts: XY[]; cum: number[]; warna: string; t0: number; dur: number };
function paket(pts: XY[], warna: string, t0: number, dur: number): Paket {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, warna, t0, dur: dur * Math.max(0.7, Math.min(1.8, cum[cum.length - 1] / 260)) };
}
function posisi(q: Paket, now: number): (XY & { o: number }) | null {
  const t = (now - q.t0) / q.dur;
  if (t < 0 || t > 1) return null;
  const u = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2, L = q.cum[q.cum.length - 1], d = u * L;
  let i = 1;
  while (i < q.cum.length - 1 && q.cum[i] < d) i++;
  const a = q.pts[i - 1], b = q.pts[i], seg = q.cum[i] - q.cum[i - 1] || 1, f = (d - q.cum[i - 1]) / seg;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, o: t < 0.85 ? 1 : (1 - t) / 0.15 };
}

const MQ = "(prefers-reduced-motion: reduce)";
function useReduce() {
  return useSyncExternalStore(
    (cb) => { try { const m = window.matchMedia(MQ); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); } catch { return () => {}; } },
    () => { try { return window.matchMedia(MQ).matches; } catch { return false; } },
    () => false,
  );
}

type Snap = { clock: number; cursor: number; now: number; st: St; pk: Paket[] };

// ---------------------------------------------------------------- drawing helpers
// the frame's state, read by the drawing helpers
const Hidup = createContext<{ kerja: (k: string) => boolean; pernah: (k: string) => boolean }>({ kerja: () => false, pernah: () => false });

function Rail({ k, w = C.lolos, dash }: { k: string; w?: string; dash?: string }) {
    const { kerja } = useContext(Hidup);
    const pts = R[k];
    const [a, b] = REL[k] ?? ["", ""];
    const hot = kerja(a) || kerja(b);
    return <polyline points={pts.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={w} strokeOpacity={hot ? 0.75 : 0.2} strokeWidth={hot ? 1.6 : 1} strokeDasharray={dash} strokeLinejoin="round" />;
}
/** rapat: the label and its count close under the node (the data block's rows are 44 px apart: its counts must not reach the next node) */
function Bulat({ k, r = 10, warna, nama, sub, nilai, putus, rapat }: { k: string; r?: number; warna: string; nama?: string; sub?: string; nilai?: string; putus?: boolean; rapat?: boolean }) {
    const { kerja, pernah } = useContext(Hidup);
    const q = P[k], on2 = kerja(k), done = !on2 && pernah(k);
    return (
      <g transform={`translate(${q.x},${q.y})`}>
        <title>{INFO[k] ?? NAMA[k]?.[0]}</title>
        {on2 && <circle r={r + 5} fill={warna} opacity={0.4} filter="url(#sb-glow)" />}
        {on2 && <circle r={r + 3} fill="none" stroke={warna} strokeOpacity={0.7}><animate attributeName="r" values={`${r + 1};${r + 8};${r + 1}`} dur="1.3s" repeatCount="indefinite" /><animate attributeName="stroke-opacity" values="0.8;0;0.8" dur="1.3s" repeatCount="indefinite" /></circle>}
        <circle r={r} fill={warna} fillOpacity={on2 ? 1 : done ? 0.42 : 0.14} stroke={on2 ? "#ffffff" : done ? C.selesai : warna} strokeOpacity={on2 || done ? 1 : 0.5} strokeWidth={1.5} strokeDasharray={putus ? "3 2" : undefined} />
        {nilai && <text y={3.5} textAnchor="middle" className="pointer-events-none fill-white text-[8.5px] font-semibold tabular-nums">{nilai}</text>}
        {nama && <text y={r + (rapat ? 11 : 14)} textAnchor="middle" className="pointer-events-none fill-[#e5e8eb] text-[10px] font-medium">{nama}</text>}
        {sub && <text y={r + (rapat ? 20 : 25)} textAnchor="middle" className="pointer-events-none fill-[#8f99a8] text-[9px] tabular-nums">{sub}</text>}
      </g>
    );
}
function Kotak({ k, w, h = 18, warna, teks, kecil, putus }: { k: string; w: number; h?: number; warna: string; teks: string; kecil?: string; putus?: boolean }) {
    const { kerja, pernah } = useContext(Hidup);
    const q = P[k], on2 = kerja(k), done = !on2 && pernah(k);
    return (
      <g>
        <title>{INFO[k] ?? `${teks}${kecil ?? ""}`}</title>
        {on2 && <rect x={q.x - w / 2 - 3} y={q.y - h / 2 - 3} width={w + 6} height={h + 6} rx={7} fill={warna} opacity={0.35} filter="url(#sb-glow)" />}
        <rect x={q.x - w / 2} y={q.y - h / 2} width={w} height={h} rx={5} fill={warna} fillOpacity={on2 ? 0.85 : done ? 0.26 : 0.08}
          stroke={on2 ? "#ffffff" : done ? C.selesai : warna} strokeOpacity={on2 || done ? 1 : 0.55} strokeWidth={1.3} strokeDasharray={putus ? "3 2" : undefined} />
        <text x={q.x} y={q.y + 3.5} textAnchor="middle" className={`pointer-events-none text-[9px] font-medium ${on2 ? "fill-[#0b0f14]" : "fill-[#e5e8eb]"}`}>
          {teks}{kecil && <tspan className="text-[7.5px] font-normal" fillOpacity={0.85}>{kecil}</tspan>}</text>
      </g>
    );
}
// the claim graph in the ML block: the claim (centre) and its earlier neighbours by member, hospital, hospital + code, code
const GRAF_TITIK: [number, number, number][] = [[0, 0, 3.6], [-15, 0, 2.4], [-7, -12, 2.4], [9, -11, 2.4], [16, 2, 2.4], [5, 13, 2.4]];
const GRAF_GARIS: [number, number][] = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [2, 3], [4, 5]];
function Graf() {
    const { kerja, pernah } = useContext(Hidup);
    const q = P.graf, on2 = kerja("graf"), done = !on2 && pernah("graf");
    return (
      <g transform={`translate(${q.x},${q.y})`}>
        <title>{INFO.graf}</title>
        <circle r={19} fill="#000000" fillOpacity={0} />
        {on2 && <circle r={18} fill={C.ml} opacity={0.3} filter="url(#sb-glow)" />}
        {on2 && <circle r={17} fill="none" stroke={C.ml} strokeOpacity={0.7}><animate attributeName="r" values="15;21;15" dur="1.3s" repeatCount="indefinite" /><animate attributeName="stroke-opacity" values="0.8;0;0.8" dur="1.3s" repeatCount="indefinite" /></circle>}
        {GRAF_GARIS.map(([a, b], j) => (
          <line key={j} x1={GRAF_TITIK[a][0]} y1={GRAF_TITIK[a][1]} x2={GRAF_TITIK[b][0]} y2={GRAF_TITIK[b][1]} stroke={on2 ? "#ffffff" : C.ml}
            strokeOpacity={on2 ? 0.9 : done ? 0.7 : 0.4} strokeWidth={on2 ? 1.3 : 1} />))}
        {GRAF_TITIK.map(([x, y, r], j) => (
          <circle key={j} cx={x} cy={y} r={r} fill={j === 0 && on2 ? "#ffffff" : C.ml} fillOpacity={on2 ? 1 : done ? 0.6 : 0.22}
            stroke={on2 ? "#ffffff" : done ? C.selesai : C.ml} strokeOpacity={on2 || done ? 1 : 0.65} strokeWidth={j === 0 ? 1.3 : 0.9} />))}
      </g>
    );
}
function Berlian({ k, warna = C.kode, nama, atas }: { k: string; warna?: string; nama: string; atas?: string }) {
    const { kerja, pernah } = useContext(Hidup);
    const q = P[k], on2 = kerja(k), done = !on2 && pernah(k);
    return (
      <g transform={`translate(${q.x},${q.y})`}>
        <title>{INFO[k]}</title>
        {on2 && <circle r={14} fill={warna} opacity={0.4} filter="url(#sb-glow)" />}
        <rect x={-7} y={-7} width={14} height={14} transform="rotate(45)" fill="#232a33" fillOpacity={1} stroke={on2 ? "#ffffff" : done ? C.selesai : warna} strokeWidth={2} />
        {on2 && <rect x={-4} y={-4} width={8} height={8} transform="rotate(45)" fill={warna} />}
        <text y={22} textAnchor="middle" className="pointer-events-none fill-[#c5cbd3] text-[9.5px]">{nama}</text>
        {atas && <text y={-14} textAnchor="middle" className="pointer-events-none fill-[#b8a9ff] text-[9px] tabular-nums">{atas}</text>}
      </g>
    );
}
function Kartu({ i, judul, hint, lit, hintKecil, children }: { i: number; judul: string; hint: string; lit: boolean; hintKecil?: boolean; children: React.ReactNode }) {
  return (
    <g transform={`translate(${KARTU.x[i]},${KARTU.y})`}>
      <rect width={KARTU.w} height={KARTU.h} rx={8} fill="#1c2127" stroke={lit ? "#4b5563" : "#2a3038"} />
      <text x={12} y={21} className="fill-white text-[13px] font-semibold">{judul}</text>
      <text x={12} y={35} className={`fill-[#8f99a8] ${hintKecil ? "text-[9px]" : "text-[9.5px]"}`}>{hint}</text>
      {children}
    </g>
  );
}
function Batang({ y, seg, w = KARTU.w - 24 }: { y: number; seg: [number, string][]; w?: number }) {
    const tot = Math.max(1, seg.reduce((a, [v]) => a + v, 0));
    const ws = seg.map(([v]) => (v ? Math.max(3, (w * v) / tot) : 0));
    const xs = ws.map((_, j) => 12 + ws.slice(0, j).reduce((a, b) => a + b, 0));
    return (
      <g>
        <rect x={12} y={y} width={w} height={8} rx={4} fill="#2c333b" />
        {seg.map(([v, c], j) => (v ? <rect key={j} x={xs[j]} y={y} width={Math.max(1, ws[j] - 2)} height={8} rx={2} fill={c} /> : null))}
      </g>
    );
}
const PIL_PX = 8.5;
function Pil({ x, y, w, warna, teks }: { x: number; y: number; w: number; warna: string; teks: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect y={-9} width={w} height={17} rx={8.5} fill={`${warna}22`} stroke={warna} strokeOpacity={0.8} />
      <text x={w / 2} y={3} textAnchor="middle" className="fill-[#e5e8eb] text-[8.5px] tabular-nums">{teks}</text>
    </g>
  );
}

// ---------------------------------------------------------------- the AIoT block
const ALAT_IOT = [["iotV", "Ventilator"], ["iotH", "Hemodialisis"], ["iotM", "Monitor ICU"]] as const;
const HASIL_WARNA = { sesuai: "#7ee2c0", tidak: "#ff8a8d", tanpa: "#8e9cad" };
// the device glyphs (about 14 x 12, stroked, centred): a ventilator with its breathing trace and hose, a dialysis machine with its
// pump rotor and blood line, an ICU monitor with its ECG
function GlifAlat({ k, x, y, w }: { k: string; x: number; y: number; w: string }) {
  return (
    <g transform={`translate(${x},${y})`} fill="none" stroke={w} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round">
      {k === "iotV" && <><rect x={-6} y={-5} width={9.5} height={8.5} rx={1.6} /><path d="M-4.4,0 q1,-2.6 2,0 t2,0 t2,0" /><path d="M3.5,-1.8 c3.4,0 3.4,4.8 0.4,5.8" /><path d="M-4.4,3.5 v2 M1.9,3.5 v2" /></>}
      {k === "iotH" && <><rect x={-5.5} y={-6} width={8} height={12} rx={1.6} /><circle cx={-1.5} cy={-1.9} r={1.9} /><path d="M-3.5,2.7 h4" /><path d="M2.5,-3.6 c3.6,0 3.6,5.2 0,6.2" /></>}
      {k === "iotM" && <><rect x={-6.5} y={-5.5} width={13} height={8.6} rx={1.6} /><path d="M-5,-1.2 h2.6 l1,-2.2 l1.5,4.2 l1.1,-2 h3.8" /><path d="M0,3.1 v2.4 M-3,5.5 h6" /></>}
    </g>
  );
}
// the block (the user, 2026-11-15: "keep 3 node buat Ventilator, Hemodialysis, Monitor ICU + node AIoT Verification system"): three
// device nodes, each read by a clamp on its power cable, -> one AIoT Verification System node (sessions bound to the patient, device
// use against the bill, its verdicts and the tariff difference) -> the IoT tag down into Tag aturan. tahap = the replay's AIoT stage
function BlokAiot({ io, tahap }: { io: IotBagan; tahap: number }) {
  const { kerja, pernah } = useContext(Hidup);
  const st = (k: string) => { const on = kerja(k), done = !on && pernah(k); return { on, done, w: on ? "#ffffff" : done ? C.selesai : C.iot, so: on || done ? 0.95 : 0.5 }; };
  const ts = io.tidak_sesuai, { x0, x1, y0, y1 } = AIOT, A = AICEK;
  const kanan = `${io.sintetis !== false ? "data sintetis · " : ""}sensor clamp (tanpa membuka alat)`;
  const hidup = ALAT_IOT.some(([k]) => kerja(k)) || kerja("iotAi");
  const ai = st("iotAi"), hasil = tahap >= 5;
  const keluarHot = kerja("iotAi") || kerja("tagAturan"), merah = tahap >= 6 && ts > 0;
  const pil = tahap >= 6 ? `tag IoT · ${id(ts)}` : "tag IoT", pilW = lebar(pil, 8.5) + 14;
  const sudut = (x: number, y: number, sx: number, sy: number) => `M${x},${y + sy * 16} V${y + sy * 10} Q${x},${y} ${x + sx * 10},${y} H${x + sx * 16}`;
  const { x: kx, y: ky, masuk } = IOT_KELUAR;
  // the verdicts: matching, not matching, and (when there are any) claims without device evidence
  const angka: [string, number | undefined, string, string, number][] = [["✓", io.sesuai, "sesuai", HASIL_WARNA.sesuai, 0], ["✕", ts, "tidak sesuai", HASIL_WARNA.tidak, 48],
    ...(io.tanpa_bukti ? [["–", io.tanpa_bukti, "tanpa bukti", HASIL_WARNA.tanpa, 112] as [string, number, string, string, number]] : [])];
  return (
    <g>
      {/* the frame: a faint grid, corner marks, the title and the sensor's line */}
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={10} fill={`${C.iot}0a`} />
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={10} fill="url(#sb-kisi)" stroke={`${C.iot}44`} />
      {[sudut(x0, y0, 1, 1), sudut(x1, y0, -1, 1), sudut(x0, y1, 1, -1), sudut(x1, y1, -1, -1)].map((d, i) => <path key={i} d={d} fill="none" stroke={C.iot} strokeOpacity={0.85} strokeWidth={1.6} />)}
      <text x={x0 + 10} y={y0 + 14} className="fill-[#7dd3fc] text-[10px] font-semibold tracking-wider">AIoT SYSTEM<tspan className="fill-[#9fb4c4] text-[9px] font-normal tracking-normal"> · verifikasi pemakaian alat medis</tspan></text>
      <circle cx={x1 - 10 - lebar(kanan, 7.5) - 7} cy={y0 + 11.5} r={2.3} fill={hidup ? C.iot : "#5f6b7a"}>
        {hidup && <animate attributeName="opacity" values="1;0.25;1" dur="1.1s" repeatCount="indefinite" />}</circle>
      <text x={x1 - 10} y={y0 + 14} textAnchor="end" className="fill-[#8f99a8] text-[7.5px]">{kanan}</text>
      <line x1={x0 + 8} x2={x1 - 8} y1={y0 + 20} y2={y0 + 20} stroke={C.iot} strokeOpacity={0.16} />

      {/* the three devices, each to the verification node */}
      {ALAT_IOT.map(([k]) => <Rail key={k} k={`${k}>iotAi`} w={C.iot} />)}
      {ALAT_IOT.map(([k, nama]) => {
        const y = P[k].y, s = st(k);
        return (
          <g key={k}>
            <title>{INFO[k]}</title>
            {s.on && <rect x={31} y={y - 12.5} width={112} height={25} rx={8} fill={C.iot} opacity={0.3} filter="url(#sb-glow)" />}
            <rect x={34} y={y - 9.5} width={106} height={19} rx={5} fill="#12161b" />
            <rect x={34} y={y - 9.5} width={106} height={19} rx={5} fill={C.iot} fillOpacity={s.on ? 0.24 : s.done ? 0.1 : 0.05} stroke={s.w} strokeOpacity={s.so} />
            <GlifAlat k={k} x={46} y={y} w={s.on ? "#ffffff" : "#7dd3fc"} />
            <text x={57} y={y + 3.2} className="pointer-events-none fill-[#e5e8eb] text-[9px] font-medium">{nama}</text>
          </g>
        );
      })}

      {/* the AIoT Verification System: device use against the bill, its verdicts and the tariff difference */}
      <g>
        <title>{INFO.iotAi}</title>
        {ai.on && <rect x={A.x0 - 4} y={A.y0 - 4} width={A.x1 - A.x0 + 8} height={A.y1 - A.y0 + 8} rx={10} fill={C.iot} opacity={0.25} filter="url(#sb-glow)" />}
        <rect x={A.x0} y={A.y0} width={A.x1 - A.x0} height={A.y1 - A.y0} rx={7} fill="#12161b" />
        <rect x={A.x0} y={A.y0} width={A.x1 - A.x0} height={A.y1 - A.y0} rx={7} fill={C.iot} fillOpacity={ai.on ? 0.14 : ai.done ? 0.07 : 0.04} stroke={ai.w} strokeOpacity={ai.so} strokeWidth={1.3} />
        <text x={A.x0 + 10} y={A.y0 + 16} className="pointer-events-none fill-white text-[10.5px] font-semibold">AIoT Verification System</text>
        <path d={`M${A.x1 - 13},${A.y0 + 6} q0.6,3.4 4,4 q-3.4,0.6 -4,4 q-0.6,-3.4 -4,-4 q3.4,-0.6 4,-4 Z`} fill={ai.on ? "#ffffff" : "#7dd3fc"} fillOpacity={ai.on ? 1 : 0.8} />
        <text x={A.x0 + 10} y={A.y0 + 28} className="pointer-events-none fill-[#9fb4c4] text-[8px]">pemakaian alat (jalan · siaga · mati) dibandingkan dengan klaim</text>
        <line x1={A.x0 + 10} x2={A.x1 - 10} y1={A.y0 + 35} y2={A.y0 + 35} stroke={C.iot} strokeOpacity={0.16} />
        {angka.map(([m, v, n, w, dx]) => (
          <g key={n} transform={`translate(${A.x0 + 10 + dx},${A.y0 + 52})`}>
            <text className="text-[11px] font-semibold tabular-nums" fill={hasil && v != null ? w : "#5f6b7a"}>{m}{hasil && v != null ? ` ${id(v)}` : ""}</text>
            <text y={10} className="fill-[#8f99a8] text-[7.5px]">{n}</text>
          </g>))}
        <text x={A.x1 - 10} y={A.y0 + 52} textAnchor="end" className={`text-[11px] font-semibold tabular-nums ${hasil ? "fill-[#ffb59a]" : "fill-[#5f6b7a]"}`}>{hasil ? rp(io.selisih_rp) : "—"}</text>
        <text x={A.x1 - 10} y={A.y0 + 62} textAnchor="end" className="fill-[#8f99a8] text-[7.5px]">selisih tarif</text>
      </g>

      {/* the IoT tag: down, over the RAGU -> redaction rail, into Tag aturan from above */}
      <line x1={474} x2={474} y1={ky - 6} y2={ky + 6} stroke="#12161b" strokeWidth={5} />
      <path d={`M${kx},${A.y1} V${ky - 5} Q${kx},${ky} ${kx + 5},${ky} H469 A5,5 0 0 1 479,${ky} H${masuk - 5} Q${masuk},${ky} ${masuk},${ky + 5} V274`}
        fill="none" stroke={merah ? C.tahan : C.iot} strokeOpacity={keluarHot ? 0.9 : 0.6} strokeWidth={keluarHot ? 1.6 : 1.3} strokeDasharray="4 3" strokeLinejoin="round" />
      <path d={`M${masuk - 4},${268.5} L${masuk},${274.5} L${masuk + 4},${268.5}`} fill="none" stroke={merah ? C.tahan : C.iot} strokeOpacity={0.9} strokeWidth={1.3} strokeLinejoin="round" />
      <g>
        <title>Klaim yang pemakaian alatnya tidak sesuai dengan tagihan menjadi tag IoT di Tag aturan (Indikasi)</title>
        <line x1={kx - 6} x2={kx} y1={196.5} y2={196.5} stroke={merah ? "#ff8a8d" : C.iot} strokeOpacity={0.85} />
        <rect x={kx - 6 - pilW} y={189} width={pilW} height={15} rx={7.5} fill={merah ? `${C.tahan}26` : `${C.iot}14`} stroke={merah ? "#ff8a8d" : C.iot} strokeOpacity={0.85} />
        <text x={kx - 6 - pilW / 2} y={199.5} textAnchor="middle" className={`pointer-events-none text-[8.5px] font-medium tabular-nums ${merah ? "fill-[#ffc2c4]" : "fill-[#bae6fd]"}`}>{pil}</text>
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- the component
export function SwarmCabangBagan(p: Props) {
  const reduce = useReduce();
  const { kc, periode, riil, sampul, kasus, exhibit, bab, narasi, run, ledger, putusan, indikasi, box: boxProp, iot, bukaDaftarKerja, batchLive } = p;
  const box = boxProp ?? p.langsung?.laporan?.box;
  const live = p.langsung ?? null, tahapLive = live?.tahap ?? null, adaLive = !!live, nLogLive = live?.log.length ?? 0;
  // the decisions by value (the parent builds the object on every render; a new plan would restart the replay)
  const { terbukti: pT, sesuai: pS, investigasi: pI } = putusan;
  const plan = useMemo(() => susun({ kc, periode, riil, sampul, kasus, exhibit, bab, narasi, run, ledger, putusan: { terbukti: pT, sesuai: pS, investigasi: pI }, indikasi, box, iot, batchLive }),
    [kc, periode, riil, sampul, kasus, exhibit, bab, narasi, run, ledger, pT, pS, pI, indikasi, box, iot, batchLive]);
  // live: the chart phase of the runner's stage, played again and again (the stages before it stay done)
  const segLive = useMemo<[number, number] | null>(() => {
    if (!adaLive) return null;
    const k = tahapLive ? TAHAP_LIVE[tahapLive]?.[1] : "penugasan";
    const f = plan.fase.find((x) => x.k === k) ?? (tahapLive === "iot" ? plan.fase.find((x) => x.k === "indikasi") : undefined) ?? plan.fase[plan.fase.length - 1];
    return [f.mulai, Math.max(f.selesai, f.mulai + 1500)];
  }, [adaLive, tahapLive, plan]);
  const segRef = useRef<[number, number] | null>(null);
  useEffect(() => { segRef.current = segLive; }, [segLive]);
  const clock = useRef(0), cursor = useRef(0), st = useRef<St>(baru()), pk = useRef<Paket[]>([]), speedRef = useRef(2);
  const [snap, setSnap] = useState<Snap>(() => ({ clock: 0, cursor: 0, now: 0, st: baru(), pk: [] }));
  const [on, setOn] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [jenis, setJenis] = useState("semua");
  const root = useRef<HTMLDivElement>(null), logRef = useRef<HTMLDivElement>(null), ikut = useRef(true);
  const paint = useCallback((now: number) => setSnap({ clock: clock.current, cursor: cursor.current, now, st: st.current, pk: pk.current.slice() }), []);
  const seek = useCallback((ms: number) => {
    const s = baru();
    let i = 0;
    while (i < plan.ev.length && plan.ev[i].at <= ms) terapkan(s, plan.ev[i++]);
    st.current = s; cursor.current = i; clock.current = Math.max(0, Math.min(ms, plan.total)); pk.current = [];
    paint(performance.now());
  }, [plan, paint]);

  // a new plan (another branch, a verifier's decision): rebuilt at the same moment
  useEffect(() => { const r = requestAnimationFrame(() => seek(reduce ? (segRef.current ? segRef.current[1] : plan.total) : clock.current)); return () => cancelAnimationFrame(r); }, [plan, seek, reduce]);
  // live: a new stage starts its loop at once
  const seekRef = useRef(seek);
  useEffect(() => { seekRef.current = seek; }, [seek]);
  const s0 = segLive?.[0] ?? -1, s1 = segLive?.[1] ?? -1;
  useEffect(() => {
    if (s0 < 0) return;
    const r = requestAnimationFrame(() => { seekRef.current(reduce ? s1 : s0); if (!reduce) setOn(true); });
    return () => cancelAnimationFrame(r);
  }, [s0, s1, reduce]);
  // play once when the chart scrolls into view
  useEffect(() => {
    if (reduce || !root.current) return;
    let done = false;
    const io = new IntersectionObserver((xs) => { if (!done && xs.some((x) => x.isIntersecting)) { done = true; setOn(true); } }, { threshold: 0.25 });
    io.observe(root.current);
    return () => io.disconnect();
  }, [reduce]);
  useEffect(() => {
    if (!on) return;
    let raf = 0, last = performance.now(), painted = 0;
    const step = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      clock.current = Math.min(plan.total, clock.current + dt * speedRef.current);
      const sg = segRef.current;
      if (sg && clock.current >= sg[1]) {  // live: the running stage again from its start; its packets keep flowing
        const s = baru();
        let i = 0;
        while (i < plan.ev.length && plan.ev[i].at <= sg[0]) terapkan(s, plan.ev[i++]);
        st.current = s; cursor.current = i; clock.current = sg[0];
      }
      let n = 0;
      while (cursor.current < plan.ev.length && plan.ev[cursor.current].at <= clock.current) {
        const e = plan.ev[cursor.current++];
        terapkan(st.current, e);
        if (n++ < 30) for (const [pts, w, k = 1] of e.pk ?? []) for (let i = 0; i < k; i++) pk.current.push(paket(pts, w, now + i * 120, 950 / Math.sqrt(speedRef.current)));
      }
      if (pk.current.length > 320) pk.current.splice(0, pk.current.length - 320);
      pk.current = pk.current.filter((q) => now - q.t0 < q.dur);
      const habis = !segRef.current && clock.current >= plan.total && !pk.current.length;
      if (now - painted > 33 || habis) { painted = now; paint(now); }
      if (habis) { setOn(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, plan, paint]);
  // the log follows the newest line unless the reader scrolled up
  useEffect(() => { const el = logRef.current; if (el && ikut.current) el.scrollTop = el.scrollHeight; }, [snap.st.log.length, jenis, nLogLive]);

  const S = live ? stLangsung(snap.st, live, sampul.klaim) : snap.st, now = snap.now, jam = snap.clock;
  const lamaLive = live?.mulai ? Math.max(0, performance.timeOrigin + now - Date.parse(`${live.mulai.replace(" ", "T")}+07:00`)) : 0;
  const kerja = (k: string) => (S.kerja[k] ?? 0) > jam;
  const pernah = (k: string) => S.pernah.has(k);
  const lajurOn = (l: (typeof LAJUR)[number]) => kerja(l.k) || l.anak.some((a) => kerja(a));
  const nKerja = Object.keys(NAMA).filter((k) => kerja(k)).length;
  const faseNow = FASE.find((x) => x.k === S.fase) ?? FASE[0];
  const putar = () => { if (on) { setOn(false); return; } if (clock.current >= plan.total) seek(0); setOn(true); };
  const ulang = () => { seek(0); if (!reduce) setOn(true); };
  const log = jenis === "semua" ? S.log : S.log.filter((b) => b.jenis === jenis);
  const sp = sampul;
  const zonaTot = Math.max(1, sp.klaim);
  const kotakBatch = Math.min(plan.batch, 21);
  const ix = indikasi ?? live?.indikasi ?? undefined, d = ix?.data;
  const kek = ix && S.kek ? ix.kekuatan : null;
  const nPutus = putusan.terbukti + putusan.sesuai + putusan.investigasi;
  // the Box card: membership from the box phase, the groups once the report has priced the hospitals
  const boxRs = box ? (S.box ? id(box.rs) : "0") : "—";
  const boxIsi = !!box && S.box >= 2;
  const boxMaks = box ? Math.max(1, ...KELOMPOK.map((g) => box.kelompok[g]?.rs ?? 0)) : 1;
  // the dashboard: a path per hospital (TSM), then the verification of every recommended claim
  const jTot = box ? box.jalur.ditindak + box.jalur.dibina + box.jalur.dibebaskan : 0;
  const jBesar = box ? (S.jalur ? id(jTot) : "0") : "—";
  const pil = JALUR.map(([k, w]) => ({ k, w, teks: `${k} · ${box ? (S.jalur ? id(box.jalur[k]) : "0") : "—"}` }));
  // widths from the final counts, so the pills do not move when the counts arrive
  const pilW = JALUR.map(([k]) => lebar(`${k} · ${box ? id(box.jalur[k]) : "—"}`, PIL_PX) + 12), pilGap = Math.max(3, Math.min(6, (KARTU.w - 24 - pilW.reduce((a, b) => a + b, 0)) / 2));
  const xDiputus = S.putusan ? nPutus : 0;
  const verTeks = `verifikasi klaim: ${id(xDiputus)} diputuskan · ${id(Math.max(0, S.antrean - xDiputus))} menunggu`;

  return (
    <section ref={root} className="overflow-hidden rounded-lg border border-white/[.07] bg-[#12161b] text-[12px] text-[#e5e8eb]">
      {/* transport */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-[#1c2127] px-3 py-2">
        <p className="mr-1 flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="play" className="h-3.5 w-3.5 text-[#9d8cff]" />Bagan sistem · {kc}</p>
        <span className="rounded border border-dashed border-white/20 px-1.5 py-0.5 text-[10.5px] text-[#c5cbd3]">integrasi: data mentah · rule engine · fitur · graph klaim · ML v7 · {iot ? "AIoT alat medis · " : ""}indikasi · box karantina · AI Agent Swarm · laporan · dashboard keputusan</span>
        {live ? (
          <>
            <span className="flex items-center gap-1.5 rounded bg-[#e5484d]/15 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-[#ff8a8d]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#ff6b6b]" />LIVE</span>
            <span className="text-[11px] text-[#c5cbd3]">audit berjalan · tahap {Math.max(1, live.tahap_daftar.indexOf(live.tahap ?? "") + 1)}/{live.tahap_daftar.length || 7}:{" "}
              <b className="font-semibold text-white">{TAHAP_LIVE[live.tahap ?? ""]?.[0] ?? live.tahap ?? "persiapan"}</b></span>
            <span className="ml-auto text-[11px] tabular-nums text-[#8f99a8]">berjalan {lamaJalan(lamaLive)} · {id(live.klaim)} klaim · {id(live.replika)} ulangan · biaya AI ${live.usd.toFixed(3)} / {usd(live.batas)}</span>
          </>
        ) : (<>
        <button onClick={putar} className="ml-1 flex items-center gap-1 rounded bg-[#5b5bd6] px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-[#6e6ade]">
          <Icon name={on ? "pause" : "play"} className="h-3 w-3" />{on ? "Jeda" : "Putar"}</button>
        <button onClick={ulang} title="putar dari awal" className="rounded border border-white/15 p-1 text-[#d3d8de] hover:bg-white/10"><Icon name="refresh" className="h-3 w-3" /></button>
        <div className="flex overflow-hidden rounded border border-white/15">
          {SPEEDS.map((v) => <button key={v} onClick={() => { speedRef.current = v; setSpeed(v); }} className={`px-1.5 py-0.5 text-[11px] tabular-nums ${speed === v ? "bg-white/15 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>{v}×</button>)}
        </div>
        <button onClick={() => { setOn(false); seek(plan.total); }} className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10">lompat ke akhir</button>
        {reduce && <span className="text-[10.5px] text-[#8f99a8]">animasi dimatikan (preferensi perangkat)</span>}
        <span className="ml-auto text-[11px] tabular-nums text-[#8f99a8]">replay {mmss(jam)} / {mmss(plan.total)} · {id(snap.cursor)}/{id(plan.ev.length)} event</span>
        </>)}
      </div>
      {/* timeline */}
      {live ? (
        <div className="border-b border-white/5 px-3 pb-2 pt-1.5">
          <div className="flex gap-1">
            {(live.tahap_daftar.length ? live.tahap_daftar : Object.keys(TAHAP_LIVE)).map((t) => {
              const done = live.tahap_selesai.includes(t), act = live.tahap === t, pr = live.progres;
              const f = act && pr ? (pr.replika_total ? (pr.replika_selesai ?? 0) / pr.replika_total : pr.batch_total ? (pr.batch ?? 0) / pr.batch_total : null) : null;
              const [nm, fk] = TAHAP_LIVE[t] ?? [t, ""], w = FASE.find((x) => x.k === fk)?.warna ?? "#8f99a8";
              return (
                <div key={t} title={nm} className={`relative h-6 min-w-0 flex-1 overflow-hidden rounded ${act ? "ring-1 ring-white/60" : ""}`}
                  style={{ background: done ? `${w}50` : act ? `${w}22` : "#1c2127" }}>
                  {act && f != null && <div className="absolute inset-y-0 left-0 transition-[width] duration-700" style={{ width: `${Math.max(2, f * 100)}%`, background: `${w}70` }} />}
                  {act && f == null && <div className="absolute inset-0 animate-pulse" style={{ background: `${w}30` }} />}
                  <span className={`relative flex h-full items-center truncate px-1.5 text-[10.5px] ${done || act ? "text-white" : "text-[#6b7480]"}`}>
                    {done ? "✓ " : act ? "● " : ""}{nm}{act && f != null ? ` · ${Math.round(f * 100)}%` : ""}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded px-1.5 py-0.5 font-medium text-[#0b0f14]" style={{ background: faseNow.warna }}>{faseNow.nama}</span>
            <span className="min-w-0 flex-1 text-[#c5cbd3]">{live.pesan ?? faseNow.desk}</span>
            <span className="tabular-nums text-[#8f99a8]">{nKerja} sistem bekerja · titik bergerak = data yang mengalir antarsistem</span>
          </div>
        </div>
      ) : (
      <div className="border-b border-white/5 px-3 pb-2 pt-1.5">
        <div className="relative h-5 cursor-pointer select-none overflow-hidden rounded bg-[#1c2127]"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * plan.total); }}>
          {plan.fase.map((x) => {
            const dd = FASE.find((y) => y.k === x.k)!;
            return <div key={x.k} title={dd.nama} className="absolute inset-y-0 flex items-center overflow-hidden border-r border-black/40 px-1.5 text-[10px] text-white/85"
              style={{ left: `${(100 * x.mulai) / plan.total}%`, width: `${(100 * (x.selesai - x.mulai)) / plan.total}%`, background: `${dd.warna}26` }}><span className="truncate">{dd.nama}</span></div>;
          })}
          <div className="pointer-events-none absolute inset-y-0 left-0 bg-[#3987e5]/35" style={{ width: `${(100 * jam) / plan.total}%` }} />
          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: `${(100 * jam) / plan.total}%` }} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded px-1.5 py-0.5 font-medium text-[#0b0f14]" style={{ background: faseNow.warna }}>{faseNow.nama}</span>
          <span className="min-w-0 flex-1 text-[#c5cbd3]">{faseNow.desk}</span>
          <span className="tabular-nums text-[#8f99a8]">{nKerja} sistem bekerja · {id(S.tagA + S.tagM)} tag · batch {S.batch}/{plan.batch} · {id(S.dibaca)} berkas · {id(Math.round(S.panggilan))} panggilan model</span>
        </div>
      </div>
      )}

      <div className="flex min-h-0 flex-col min-[1900px]:flex-row">
        <div className="min-w-0 flex-1 overflow-x-auto p-2">
          <Hidup.Provider value={{ kerja, pernah }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[1000px]" role="img" aria-label={`Bagan sistem cabang ${kc}: data mentah, rule engine dan penyimpanan fitur, blok ML v7 berbasis graph klaim, ${iot ? "AIoT alat medis (ventilator, hemodialisis dan monitor ICU dibaca sensor clamp di kabel daya, lalu AIoT Verification System membandingkan pemakaian alat dengan klaim), " : ""}indikasi, box karantina, AI Agent Swarm, laporan KC dan dashboard keputusan (jalur RS dan verifikasi klaim)`}>
            <defs>
              <filter id="sb-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" /></filter>
              <filter id="sb-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4" /></filter>
              {/* the AIoT block's grid and the clip of its platform's scope */}
              <pattern id="sb-kisi" width={10} height={10} patternUnits="userSpaceOnUse"><path d="M10,0 H0 V10" fill="none" stroke={C.iot} strokeOpacity={0.07} strokeWidth={0.6} /></pattern>
              <linearGradient id="sb-bus" x1="0" x2="1"><stop offset="0" stopColor="#1e2a36" /><stop offset="0.5" stopColor="#24384a" /><stop offset="1" stopColor="#1e2a36" /></linearGradient>
            </defs>

            {/* the orchestrator to the lanes, the lanes to their systems */}
            {LAJUR.map((l) => <polyline key={l.k} points={R[`orch>${l.k}`].map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={l.warna} strokeOpacity={lajurOn(l) ? 0.8 : 0.25} strokeWidth={lajurOn(l) ? 2 : 1.2} />)}
            {["l-ingest>mentah", "l-ingest>validasi", "l-laporan>penulis", "l-laporan>cek", "l-verif>dash", "l-verif>putusan"].map((k) => <Rail key={k} k={k} w={NAMA[k.split(">")[0]][1]} />)}
            <Rail k="l-ml>box" w={C.ml} /><Rail k="l-indikasi>box" w={C.indikasi} /><Rail k="l-swarm>box" w={C.swarm} />
            <Rail k="orch>redaksi" w={C.kode} dash="3 3" /><Rail k="orch>biaya" w={C.kode} dash="3 3" />

            {/* the boxes: raw data -> features, the ML architecture, Indikasi, the swarm tree */}
            <rect x={INBOX.x0} y={INBOX.y0} width={INBOX.x1 - INBOX.x0} height={INBOX.y1 - INBOX.y0} rx={10} fill={`${C.ingest}0a`} stroke={`${C.ingest}77`} strokeDasharray="5 4" />
            <text x={INBOX.x0 + 8} y={INBOX.y0 + 13} className="fill-[#7fb3ef] text-[9.5px] font-semibold tracking-wide">DATA MENTAH → FITUR</text>
            <rect x={MLBOX.x0} y={MLBOX.y0} width={MLBOX.x1 - MLBOX.x0} height={MLBOX.y1 - MLBOX.y0} rx={10} fill={`${C.ml}0a`} stroke={`${C.ml}77`} strokeDasharray="5 4" />
            <text x={MLBOX.x0 + 8} y={MLBOX.y0 + 13} className="fill-[#2dd4bf] text-[9.5px] font-semibold tracking-wide">ARSITEKTUR {plan.v7 ? "ML V7 · A1" : "MODEL v4 · B"}</text>
            <text x={MLBOX.x1 - 8} y={MLBOX.y0 + 13} textAnchor="end" className="fill-[#8f99a8] text-[9px]">{plan.v7 ? "646 fitur · 500 dari graph" : "646 fitur · 500 graph"}</text>
            <rect x={IXBOX.x0} y={IXBOX.y0} width={IXBOX.x1 - IXBOX.x0} height={IXBOX.y1 - IXBOX.y0} rx={10} fill={`${C.indikasi}0d`} stroke={`${C.indikasi}88`} strokeDasharray="5 4" />
            {/* with the AIoT block its tag enters near the left edge, so the title starts right of that rail */}
            <text x={iot ? IOT_KELUAR.masuk + 10 : IXBOX.x0 + 8} y={IXBOX.y0 + 13} className="fill-[#f4a37f] text-[9.5px] font-semibold tracking-wide">
              {iot ? "INDIKASI · tag aturan + ML + IoT" : "INDIKASI · tag aturan + tag ML"}</text>
            <rect x={SWBOX.x0} y={SWBOX.y0} width={SWBOX.x1 - SWBOX.x0} height={SWBOX.y1 - SWBOX.y0} rx={10} fill={`${C.swarm}0a`} stroke={`${C.swarm}77`} strokeDasharray="5 4" />
            <text x={SWBOX.x0 + 8} y={SWBOX.y0 + 13} className="fill-[#f19ac0] text-[9.5px] font-semibold tracking-wide">AI AGENT SWARM · spesialis → hakim → gerbang τ</text>
            <rect x={728} y={286} width={224} height={54} rx={7} fill="none" stroke={`${C.swarm}55`} strokeDasharray="3 3" />
            <text x={734} y={296} className="fill-[#c5cbd3] text-[8.5px]">Spesialis paralel</text>
            {/* batches */}
            {[...Array(kotakBatch).keys()].map((j) => {
              const b = j + 1, done = S.batch >= b, jalan = !done && S.jalan >= b && kerja("l-swarm");
              return <rect key={j} x={SWBOX.x0 + 8 + j * 11} y={SWBOX.y0 + 20} width={8} height={8} rx={1.5} fill={done ? C.swarm : jalan ? "#ffffff" : "#2c333b"} fillOpacity={done ? 0.85 : 1} />;
            })}
            {plan.batch > kotakBatch && <text x={SWBOX.x0 + 12 + kotakBatch * 11} y={SWBOX.y0 + 27} className="fill-[#8f99a8] text-[8.5px]">+{plan.batch - kotakBatch}</text>}

            {/* rails inside and between the systems */}
            {["mentah>validasi", "validasi>stream", "stream>f4", "stream>toko", "f4>toko"].map((k) => <Rail key={k} k={k} w={C.ingest} />)}
            <Rail k="validasi>aturan" w={C.indikasi} /><Rail k="aturan>bus" w={C.indikasi} dash="2 3" />
            {["toko>rule", "toko>graf", "graf>lgb0", "graf>lgb1", "graf>lgb2", "lgb0>rata", "lgb1>rata", "lgb2>rata", "rata>router"].map((k) => <Rail key={k} k={k} w={C.ml} />)}
            <Rail k="rule>router" w={C.kode} dash="3 2" />
            <Rail k="router>ragu" w={C.swarm} /><Rail k="router>tahan" w={C.tahan} /><Rail k="router>lolos" w={C.lolos} />
            <Rail k="bus>tagAturan" w={C.indikasi} /><Rail k="rule>tagAturan" w={C.ml} dash="3 2" /><Rail k="rata>tagModel" w={C.ml} dash="3 2" />
            {["tagAturan>kekuatan", "tagModel>kekuatan"].map((k) => <Rail key={k} k={k} w={C.indikasi} />)}
            <Rail k="kekuatan>kuat" w={C.tahan} /><Rail k="kekuatan>sedang" w={C.periksa} /><Rail k="kekuatan>lemah" w={C.lemah} />
            <Rail k="ix>bus" w={C.indikasi} dash="2 3" />
            <Rail k="ragu>redaksi" w={C.swarm} /><Rail k="redaksi>l-swarm" w={C.swarm} dash="4 3" />
            {["l-swarm>koding", "l-swarm>tagihan", "l-swarm>episode", "koding>hakim", "tagihan>hakim", "episode>hakim", "hakim>tau"].map((k) => <Rail key={k} k={k} w={C.swarm} />)}
            <Rail k="spesialis>vertex" w={C.vertex} dash="3 3" /><Rail k="penulis>vertex" w={C.vertex} dash="3 3" />
            <Rail k="tahan>bus" w={C.tahan} /><Rail k="lolos>bus" w={C.lolos} /><Rail k="tau>bus" w={C.periksa} />
            {["rugi>exhibit", "exhibit>penulis", "penulis>cek", "cek>exhibit"].map((k) => <Rail key={k} k={k} w={C.laporan} />)}
            {["antrean>dash", "dash>putusan"].map((k) => <Rail key={k} k={k} w={C.verif} />)}
            <Rail k="putusan>ledger" w={C.verif} dash={riil ? "2 4" : undefined} />
            {["toko>bus", "rugi>bus", "exhibit>bus", "antrean>bus", "ledger>bus"].map((k) => <Rail key={k} k={k} w="#3987e5" dash="2 3" />)}

            {/* the event store (the engine's events and signals + the feature store) */}
            <rect x={BUS.x0} y={BUS.y0} width={BUS.x1 - BUS.x0} height={BUS.y1 - BUS.y0} rx={14} fill="url(#sb-bus)" stroke="#3987e5"
              strokeOpacity={0.35 + Math.min(0.6, snap.pk.length * 0.01)} strokeWidth={1.5} />
            <text x={W / 2} y={BY + 4} textAnchor="middle" className="fill-[#c5d8ef] text-[11.5px] font-semibold">
              {`Event store KC · sinyal rule engine · penyimpanan fitur · ${id(sp.klaim)} klaim × 646 fitur (${riil ? "data riil sampel BPJS" : "data sintetis"})`}</text>
            <text x={W / 2} y={BUS.y1 + 16} textAnchor="middle" className="fill-[#b4bcc7] text-[10.5px] tabular-nums">
              {S.bertag ? `${id(S.bertag)} dari ${id(sp.klaim)} klaim bertag; ${S.zona ? `${id(S.zona.ragu)} klaim RAGU dibaca swarm, ${id(S.zona.tahan)} langsung TAHAN.` : ""}`
                : S.zona ? `ML v7 sudah menilai ${id(S.dinilai)} klaim; ${id(S.zona.ragu)} masuk zona RAGU, ${id(S.zona.tahan)} langsung TAHAN.`
                : S.dinilai ? `ML v7 menilai ${id(S.dinilai)} dari ${id(sp.klaim)} klaim…` : S.masuk ? `Klaim masuk ${id(S.masuk)} dari ${id(sp.klaim)}; rule engine ${id(S.sinyal)} klaim bersinyal.` : `Data mentah ${id(S.baris)} baris.`}</text>
            <text x={W / 2} y={BUS.y1 + 30} textAnchor="middle" className="fill-[#8f99a8] text-[10px] tabular-nums">
              {live ? `Swarm sejauh ini membaca ${id(S.dibaca)} berkas dalam ${id(S.batch)} batch.`
                : `Swarm sejauh ini membaca ${id(S.dibaca)} berkas dalam ${id(S.batch)} batch · ${id(Math.round(S.panggilan))} panggilan model${S.token ? ` · ≈${tok(S.token)} token` : ""}${S.usd ? ` · ≈${usd(S.usd)}` : ""}.`}</text>

            {/* the flow under the bus: data -> ML -> Indikasi -> Box -> swarm + report -> dashboard */}
            {[0, 1, 2, 3, 4].map((i) => {
              const x1 = KARTU.x[i] + KARTU.w, x2 = KARTU.x[i + 1], y = KARTU.y + KARTU.h / 2;
              const lit = [S.masuk >= sp.klaim, !!S.zona, S.bertag > 0, box ? S.box > 0 : S.batch > 0, S.nilai >= 3][i];
              return <g key={i}><line x1={x1 + 2} y1={y} x2={x2 - 6} y2={y} stroke={lit ? "#c5cbd3" : "#3a424d"} strokeWidth={1.5} strokeDasharray="4 3" />
                <path d={`M${x2 - 7},${y - 4} L${x2 - 2},${y} L${x2 - 7},${y + 4}`} fill="none" stroke={lit ? "#c5cbd3" : "#3a424d"} strokeWidth={1.5} /></g>;
            })}
            <Kartu i={0} judul="Data mentah" hint="klaim FKRTL → validasi → rule engine → fitur" lit={S.baris > 0}>
              <text x={12} y={68} className="fill-white text-[26px] font-semibold tabular-nums">{id(S.masuk)}</text>
              <text x={20 + id(S.masuk).length * 15} y={68} className="fill-[#abb3bf] text-[11px]">klaim masuk</text>
              <text x={12} y={84} className="fill-[#8f99a8] text-[9.5px]">{d ? `dari ${id(d.baris)} baris · ${d.kolom} kolom · 0 ditolak` : `dari ${id(sp.klaim)} baris`}</text>
              <Batang y={94} seg={[[S.sinyal, C.indikasi], [Math.max(0, S.masuk - S.sinyal), C.ingest], [Math.max(0, sp.klaim - S.masuk), "#2c333b"]]} />
              <g className="text-[10px] tabular-nums">
                <g transform="translate(12,122)"><rect y={-7} width={7} height={7} rx={1.5} fill={C.indikasi} /><text x={10} className="fill-[#d3d8de]">bersinyal {live && !live.sinyal ? "—" : id(S.sinyal)}</text></g>
                <g transform="translate(112,122)"><rect y={-7} width={7} height={7} rx={1.5} fill={C.ingest} /><text x={10} className="fill-[#d3d8de]">tanpa sinyal</text></g>
              </g>
              <text x={12} y={140} className="fill-[#8f99a8] text-[9.5px]">{d ? `${id(d.peserta)} peserta · ${id(d.rs)} profil RS`
                : live ? (live.sinyal?.teratas[0] ? `terbanyak: ${pendek(live.sinyal.teratas[0].label.toLowerCase(), 24)} · ${id(live.sinyal.teratas[0].n)}` : "sinyal dihitung sesudah tahap zona")
                : `${id(sp.rs)} profil RS`}</text>
              <text x={12} y={153} className="fill-[#8f99a8] text-[9.5px]">penyimpanan fitur: 646 fitur per klaim</text>
            </Kartu>
            <Kartu i={1} judul={`Skoring ${plan.v7 ? "ML v7" : "model"}`} hint="graph klaim + LightGBM × 3 seed · mesin" lit={S.dinilai > 0}>
              <text x={12} y={68} className="fill-white text-[26px] font-semibold tabular-nums">{id(S.dinilai)}</text>
              <text x={20 + id(S.dinilai).length * 15} y={68} className="fill-[#abb3bf] text-[11px]">klaim dinilai</text>
              <text x={12} y={84} className="fill-[#8f99a8] text-[9.5px]">dari {id(sp.klaim)} klaim · 646 fitur (500 dari graph)</text>
              <Batang y={94} seg={S.zona ? [[S.zona.lolos, C.lolos], [S.zona.ragu, C.swarm], [S.zona.tahan, C.tahan]] : [[S.dinilai, "#3a424d"]]} />
              <g className="text-[10px] tabular-nums">
                {([["LOLOS", S.zona?.lolos, C.lolos], ["RAGU", S.zona?.ragu, C.swarm], ["TAHAN", S.zona?.tahan, C.tahan]] as const).map(([n, v, c], j) => (
                  <g key={n} transform={`translate(${12 + j * 70},122)`}><rect y={-7} width={7} height={7} rx={1.5} fill={c} /><text x={10} className="fill-[#d3d8de]">{n} {v == null ? "–" : id(v)}</text></g>))}
              </g>
              <text x={12} y={140} className="fill-[#8f99a8] text-[9.5px]">{plan.v7 ? "ambang: TAHAN ≥0,78 · RAGU ≥0,12/aturan" : "ambang dari set validasi sintetis"}</text>
              <text x={12} y={153} className="fill-[#8f99a8] text-[9.5px]">{riil ? `porsi RAGU ${id((100 * (sp.ragu)) / zonaTot, 1)}% · perlu kalibrasi ulang` : `porsi rekomendasi ${id((100 * sp.antrean) / zonaTot, 1)}% klaim`}</text>
            </Kartu>
            <Kartu i={2} judul="Indikasi" hint="tag rule engine + prediksi ML v7 · kode" lit={S.tagA + S.tagM > 0 || !!live?.aturan}>
              {live && !ix ? (<>
                <text x={12} y={68} className="fill-white text-[26px] font-semibold tabular-nums">{id(S.tagM)}</text>
                <text x={20 + id(S.tagM).length * 15} y={68} className="fill-[#abb3bf] text-[11px]">tag model</text>
                <text x={12} y={84} className="fill-[#8f99a8] text-[9.5px] tabular-nums">{S.zona ? `skor ML ≥ RAGU: ${id(S.zona.tahan)} TAHAN + ${id(S.zona.ragu)} RAGU` : "menunggu zona ML v7"}</text>
                <Batang y={94} seg={S.zona ? [[S.zona.ragu, C.periksa], [S.zona.tahan, C.tahan]] : [[1, "#3a424d"]]} />
                <text x={12} y={122} className="fill-[#d3d8de] text-[10px] tabular-nums">{live.aturan
                  ? `temuan aturan: rekam medis ${id(live.aturan.temuan_rme ?? 0)}${live.iot ? ` · IoT ${id(live.aturan.temuan_iot ?? 0)}` : ""}`
                  : live.tahap_selesai.includes("aturan") ? "temuan aturan: dirangkum di laporan" : "temuan aturan: menunggu tahap aturan"}</text>
                <text x={12} y={140} className="fill-[#8f99a8] text-[9.5px] tabular-nums">{live.aturan
                  ? `${id(live.aturan.bukti ?? 0)} klaim jalur bukti aturan · ${id(live.aturan.rute ?? 0)} dirutekan` : "ringkasan tag aturan ditulis bersama laporan"}</text>
              </>) : (<>
                <text x={12} y={68} className="fill-white text-[26px] font-semibold tabular-nums">{id(S.tagA + S.tagM)}</text>
                <text x={20 + id(S.tagA + S.tagM).length * 15} y={68} className="fill-[#abb3bf] text-[11px]">tag</text>
                <text x={12} y={84} className="fill-[#8f99a8] text-[9.5px] tabular-nums">{id(S.tagA)} tag aturan + {id(S.tagM)} tag model</text>
                <Batang y={94} seg={kek ? [[kek.lemah, C.lemah], [kek.sedang, C.periksa], [kek.kuat, C.tahan]] : [[S.tagA + S.tagM, "#3a424d"]]} />
                <text x={12} y={122} className="fill-[#d3d8de] text-[10px] tabular-nums">{kek ? `lemah ${id(kek.lemah)} · sedang ${id(kek.sedang)} · kuat ${id(kek.kuat)}` : "kekuatan: menunggu"}</text>
                {(ix && S.kek ? ix.per_tag.filter((x) => x.sumber === "aturan").slice(0, 2) : []).map((x, j) => (
                  <text key={x.tag} x={12} y={138 + j * 13} className="fill-[#d3d8de] text-[9.5px] tabular-nums">{pendek(x.label.toLowerCase(), 30)} · {id(x.n)}</text>))}
                {!(ix && S.kek) && <text x={12} y={140} className="fill-[#8f99a8] text-[9.5px]">{ix ? "kekuatan = aturan × skor ML" : "ringkasan tag belum ada di run ini"}</text>}
              </>)}
            </Kartu>
            <Kartu i={3} judul="Box karantina" hint="RS dikelompokkan menurut estimasi kerugian" hintKecil lit={S.box > 0}>
              <text x={12} y={66} className="fill-white text-[26px] font-semibold tabular-nums">{boxRs}</text>
              <text x={sesudah(boxRs)} y={66} className="fill-[#abb3bf] text-[11px]">RS di karantina</text>
              <text x={12} y={82} className="fill-[#8f99a8] text-[9.5px] tabular-nums">{!box ? (p.langsung ? "menunggu putusan AI Agent Swarm" : "belum ada Box di run ini") : boxIsi ? `estimasi kerugian ${rp(box.estimasi_kerugian_rp)} · dari ${id(box.rs_klaim)} RS`
                : S.box ? `estimasi kerugian: menunggu · dari ${id(box.rs_klaim)} RS` : "RS dengan minimal satu tag indikasi"}</text>
              <line x1={12} x2={KARTU.w - 12} y1={138} y2={138} stroke="#2c333b" />
              {KELOMPOK.map((g, j) => {
                const v = box?.kelompok[g], n = v?.rs ?? 0, cx = 12 + ((KARTU.w - 24) / KELOMPOK.length) * (j + 0.5);
                // a log scale, so a long tail of small hospitals (Z) does not dwarf the few that carry most of the loss (A)
                const h = boxIsi ? (n ? Math.max(3, (42 * Math.log1p(n)) / Math.log1p(boxMaks)) : 0) : 9;
                return (
                  <g key={g}>
                    <title>{`Kelompok ${g}: ${ARTI_KELOMPOK[g]}${boxIsi && v ? ` · ${id(n)} RS · estimasi kerugian ${rp(v.estimasi_kerugian_rp)} · ${id(v.rekomendasi)} RS dengan klaim direkomendasikan` : ""}`}</title>
                    {h > 0 && <rect x={cx - 12} y={138 - h} width={24} height={h} rx={2} fill={boxIsi ? WARNA_KELOMPOK[g] : "#2c333b"} fillOpacity={boxIsi ? 0.9 : 1} />}
                    <text x={cx} y={151} textAnchor="middle" className={`text-[9.5px] font-semibold tabular-nums ${boxIsi ? "fill-[#d3d8de]" : "fill-[#5f6b7a]"}`}>{boxIsi ? `${g} · ${id(n)}` : g}</text>
                  </g>
                );
              })}
              {!boxIsi && <text x={KARTU.w / 2} y={116} textAnchor="middle" className="fill-[#8f99a8] text-[9.5px]">{!box ? "kelompok A–Z: —" : S.box ? "menunggu estimasi" : "kelompok A–Z menurut kerugian"}</text>}
            </Kartu>
            <Kartu i={4} judul="AI Agent Swarm + Laporan KC" hint="3 spesialis → hakim → τ → laporan KC" lit={S.dibaca > 0 || S.nilai > 0}>
              <text x={12} y={60} className="fill-white text-[22px] font-semibold tabular-nums">{id(S.dibaca)}</text>
              <text x={sesudah(id(S.dibaca), 22)} y={60} className="fill-[#abb3bf] text-[10.5px]">berkas dibaca</text>
              <text x={12} y={73} className="fill-[#8f99a8] text-[9px] tabular-nums">dari {id(sp.ragu)} klaim RAGU · batch {S.batch}/{plan.batch}</text>
              <Batang y={78} seg={[[S.periksa, C.periksa], [S.bersih, C.lolos], [Math.max(0, sp.ragu - S.dibaca), "#2c333b"]]} />
              <g className="text-[10px] tabular-nums">
                <g transform="translate(12,98)"><rect y={-7} width={7} height={7} rx={1.5} fill={C.periksa} /><text x={10} className="fill-[#d3d8de]">PERIKSA {live && !live.gerbang ? "—" : id(S.periksa)}</text></g>
                <g transform="translate(100,98)"><rect y={-7} width={7} height={7} rx={1.5} fill={C.lolos} /><text x={10} className="fill-[#d3d8de]">dibersihkan {live && !live.gerbang ? "— (setelah batch terakhir)" : id(S.bersih)}</text></g>
              </g>
              <line x1={12} x2={KARTU.w - 12} y1={105} y2={105} stroke="#2c333b" />
              {([["Nilai terindikasi", sp.nilai_terindikasi_rp ?? sp.nilai_antrean_rp, 2], ["Estimasi kerugian", sp.estimasi_kerugian_rp ?? 0, 1]] as const).map(([n, v, min], j) => (
                <g key={n} transform={`translate(12,${118 + j * 14})`}>
                  <text className="fill-[#abb3bf] text-[10px]">{n}</text>
                  <text x={KARTU.w - 24} textAnchor="end" className="fill-white text-[11.5px] font-semibold tabular-nums">{S.nilai >= min ? rp(v) : "—"}</text>
                </g>))}
              <text x={12} y={146} className="fill-[#8f99a8] text-[9px] tabular-nums">{id(S.narasi)}/{id(exhibit)} exhibit dinarasikan · {id(bab)} bab</text>
              <text x={12} y={157} className="fill-[#8f99a8] text-[9px] tabular-nums">{S.dibuang == null ? "cek angka: menunggu narasi" : `cek angka: ${id(S.dibuang)} kalimat dibuang`}</text>
            </Kartu>
            <Kartu i={5} judul="Dashboard keputusan" hint="rekomendasi jalur → keputusan manusia" lit={S.antrean > 0 || S.jalur}>
              <text x={12} y={66} className="fill-white text-[26px] font-semibold tabular-nums">{jBesar}</text>
              <text x={sesudah(jBesar)} y={66} className="fill-[#abb3bf] text-[11px]">rekomendasi jalur RS</text>
              {pil.map((x, j) => <Pil key={x.k} x={12 + pilW.slice(0, j).reduce((a, b) => a + b, 0) + j * pilGap} y={88} w={pilW[j]} warna={x.w} teks={x.teks} />)}
              <text x={12} y={111} className="fill-[#8f99a8] text-[8.5px]">
                <title>T = Terstruktur, S = Sistematis, M = Masif: kriteria TSM per RS, dihitung kode dari data batch ini</title>ditindak = T+S+M · dibina = ≥1 · dibebaskan = 0</text>
              <text x={12} y={123} className="fill-[#8f99a8] text-[8.5px]">{box ? "T, S, M = Terstruktur, Sistematis, Masif (kode)" : p.langsung ? "menunggu laporan KC" : "belum ada Box di run ini"}</text>
              <text x={12} y={139} className={`fill-[#c5cbd3] tabular-nums ${lebar(verTeks, 9) > KARTU.w - 26 ? "text-[8px]" : "text-[9px]"}`}>{verTeks}</text>
              <text x={12} y={155} className="cursor-pointer fill-[#7ea3ff] text-[9.5px] underline" role="link" tabIndex={0}
                onClick={() => bukaDaftarKerja?.()} onKeyDown={(e) => { if (e.key === "Enter") bukaDaftarKerja?.(); }}>buka dashboard keputusan →</text>
            </Kartu>

            {/* the AIoT block (top left): three devices -> the AIoT Verification System -> the IoT tag into Tag aturan */}
            {iot && <BlokAiot io={iot} tahap={S.iot} />}

            {/* the orchestrator and its guards */}
            <g transform={`translate(${P.orch.x},${P.orch.y})`}>
              <title>{INFO.orch}</title>
              {kerja("orch") && <circle r={30} fill={C.orch} opacity={0.45} filter="url(#sb-glow)" />}
              <circle r={24} fill={C.orch} fillOpacity={kerja("orch") ? 1 : 0.5} stroke={kerja("orch") ? "#ffffff" : C.orch} strokeWidth={1.6} />
              <text y={40} textAnchor="middle" className="fill-[#e5e8eb] text-[11.5px] font-semibold">Orkestrator run KC</text>
              <text y={52} textAnchor="middle" className="fill-[#8f99a8] text-[9.5px]">rencana · urutan · batas biaya</text>
            </g>
            <Berlian k="redaksi" nama="Redaksi berkas · kode" atas={S.dibaca ? `${id(S.dibaca)} berkas` : undefined} />
            <Berlian k="biaya" nama="Cost guard · kode" atas={S.usd ? `≈${usd(S.usd)}` : S.panggilan ? `${id(Math.round(S.panggilan))} panggilan` : undefined} />

            {/* the lanes */}
            {LAJUR.map((l) => {
              const hot = lajurOn(l), done = !hot && l.anak.some((a) => pernah(a));
              return (
                <g key={l.k} transform={`translate(${l.x},${LY})`}>
                  {hot && <circle r={23} fill={l.warna} opacity={0.4} filter="url(#sb-glow)" />}
                  <circle r={17} fill={l.warna} fillOpacity={hot ? 1 : done ? 0.42 : 0.16} stroke={hot ? "#ffffff" : done ? C.selesai : l.warna} strokeWidth={1.8} />
                  <text y={31} textAnchor="middle" className="fill-[#e5e8eb] text-[12px] font-semibold">{l.nama}</text>
                  <text y={43} textAnchor="middle" className="fill-[#8f99a8] text-[9.5px]">{l.sub}</text>
                </g>
              );
            })}
            {/* the external model endpoint */}
            <g>
              <title>{INFO.vertex}</title>
              <rect x={P.vertex.x - 43} y={P.vertex.y - 9} width={86} height={18} rx={9} fill={C.vertex} fillOpacity={kerja("vertex") ? 0.3 : 0.1} stroke={C.vertex} strokeOpacity={kerja("vertex") ? 1 : 0.5} />
              <text x={P.vertex.x} y={P.vertex.y + 3.5} textAnchor="middle" className="fill-[#dbe6ff] text-[9.5px] font-medium">Model AI (LLM)</text>
            </g>

            {/* raw data -> features */}
            <Bulat k="mentah" r={8} rapat warna={C.ingest} nama="Data mentah" sub={S.baris ? `${id(S.baris)} baris` : "—"} />
            <Bulat k="validasi" r={8} rapat warna={C.ingest} nama="Validasi" sub={S.masuk ? `${id(S.masuk)} masuk` : "skema klaim"} />
            <Bulat k="aturan" r={8} rapat warna={C.indikasi} nama="Rule engine" sub={S.sinyal ? `${id(S.sinyal)} bersinyal` : "kode"} putus />
            <Bulat k="stream" r={8} rapat warna={C.ingest} nama="fitur.Stream" sub="624 fitur" />
            <Bulat k="f4" r={8} rapat warna={C.ingest} nama="Fitur v4" sub="22 fitur" />
            <Bulat k="toko" r={8} rapat warna={C.ingest} nama="Penyimpanan fitur" sub="646 fitur" />
            {/* the ML architecture: the claim graph -> LightGBM x 3 -> the mean s -> the zone router; the review rules above */}
            <text x={P.graf.x} y={298} textAnchor="middle" className="pointer-events-none fill-[#e5e8eb] text-[9px] font-medium">Graph klaim</text>
            <Graf />
            <text x={MLBOX.x0 + 8} y={358} className="pointer-events-none fill-[#7cc9bc] text-[8.5px] tabular-nums">4 relasi · 500 fitur tetangga</text>
            <Kotak k="rule" w={68} warna={C.kode} teks="Aturan telaah" putus />
            <Kotak k="lgb0" w={60} h={16} warna={C.ml} teks="LightGBM s0" />
            <Kotak k="lgb1" w={60} h={16} warna={C.ml} teks="LightGBM s1" />
            <Kotak k="lgb2" w={60} h={16} warna={C.ml} teks="LightGBM s2" />
            <Bulat k="rata" warna={C.ml} r={10} nilai="μ" />
            <text x={P.rata.x} y={P.rata.y - 15} textAnchor="middle" className="pointer-events-none fill-[#8f99a8] text-[9px]">skor s</text>
            <Berlian k="router" warna={C.ml} nama="" />
            <text x={P.router.x - 2} y={P.router.y + 24} textAnchor="middle" className="pointer-events-none fill-[#8f99a8] text-[9px]">ambang</text>
            <Kotak k="ragu" w={56} h={16} warna={C.swarm} teks="RAGU" kecil={plan.v7 ? " ≥0,12" : undefined} />
            <Kotak k="tahan" w={56} h={16} warna={C.tahan} teks="TAHAN" kecil={plan.v7 ? " ≥0,78" : undefined} />
            <Kotak k="lolos" w={56} h={16} warna={C.lolos} teks="LOLOS" />
            <text x={MLBOX.x0 + 8} y={MLBOX.y1 - 22} className="fill-[#8f99a8] text-[8.5px]">latih: sintetis G1 + G2{plan.v7 ? " + G2-halus" : ""}</text>
            <text x={MLBOX.x0 + 8} y={MLBOX.y1 - 10} className="fill-[#8f99a8] text-[8.5px]">{plan.v7 ? "seleksi: leave-one-generator-out" : "varian B, dibekukan"}</text>
            {/* Indikasi */}
            <Kotak k="tagAturan" w={84} warna={C.indikasi} teks={S.tagA ? `Tag aturan ${id(S.tagA)}` : "Tag aturan"} />
            <Kotak k="tagModel" w={84} warna={C.indikasi} teks={S.tagM ? `Tag ML v7 ${id(S.tagM)}` : "Tag model ML v7"} />
            <Berlian k="kekuatan" warna={C.kode} nama="" />
            <text x={P.kekuatan.x} y={P.kekuatan.y + 48} textAnchor="middle" className="fill-[#8f99a8] text-[9px]">kekuatan = aturan × skor ML</text>
            <Kotak k="kuat" w={52} h={16} warna={C.tahan} teks={kek ? `kuat ${id(kek.kuat)}` : "kuat"} />
            <Kotak k="sedang" w={52} h={16} warna={C.periksa} teks={kek ? `sedang ${id(kek.sedang)}` : "sedang"} />
            <Kotak k="lemah" w={52} h={16} warna={C.lemah} teks={kek ? `lemah ${id(kek.lemah)}` : "lemah"} />
            <text x={IXBOX.x0 + 8} y={IXBOX.y1 - 22} className="fill-[#8f99a8] text-[8.5px]">aturan: sinyal rule engine + aturan telaah</text>
            <text x={IXBOX.x0 + 8} y={IXBOX.y1 - 10} className="fill-[#8f99a8] text-[8.5px]">{ix ? `model: skor s ≥ ${id(ix.ambang.ragu, 2)} · tanpa agen` : "model: skor s di zona RAGU · tanpa agen"}</text>
            {/* the swarm */}
            <Bulat k="koding" warna={C.swarm} nama="Koding & klinis" />
            <Bulat k="tagihan" warna={C.swarm} nama="Tagihan" />
            <Bulat k="episode" warna={C.swarm} nama="Episode & jaringan" />
            <Bulat k="hakim" r={11} warna={C.swarm} />
            <text x={P.hakim.x - 16} y={P.hakim.y + 4} textAnchor="end" className="fill-[#e5e8eb] text-[10px] font-medium">Hakim</text>
            <Berlian k="tau" nama="" />
            <text x={P.tau.x + 14} y={P.tau.y + 4} className="fill-[#c5cbd3] text-[9.5px]">τ 0,72</text>
            {/* the report */}
            <Bulat k="penulis" warna={C.laporan} nama="Agen penulis" sub="agen AI" />
            <Bulat k="cek" warna={C.kode} nama="Cek angka" sub="kode" putus />
            <Bulat k="rugi" warna={C.laporan} nama="Estimasi kerugian" sub="kode" putus />
            <Bulat k="exhibit" warna={C.laporan} nama="Exhibit & bab" sub={`${id(exhibit)} exhibit`} />
            {/* the decision dashboard */}
            <Bulat k="dash" warna={C.verif} nama="Dashboard" sub="keputusan" />
            <Bulat k="putusan" warna={C.verif} nama="Putusan" sub="manusia" />
            <Bulat k="antrean" warna={C.verif} nama="Rekomendasi" sub={S.antrean ? `${id(S.antrean)} klaim` : "—"} />
            <Bulat k="ledger" warna={riil ? "#5f6b7a" : C.verif} nama="Buku besar" sub={riil ? "tidak terhubung" : "indikasi"} putus={riil} />

            {/* the interactions in flight */}
            {snap.pk.map((q, i) => {
              const z = posisi(q, now);
              return z ? <circle key={i} cx={z.x} cy={z.y} r={2.8} fill={q.warna} opacity={z.o} filter="url(#sb-soft)" /> : null;
            })}
          </svg>
          </Hidup.Provider>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[10.5px] text-[#8f99a8]">
            {LAJUR.map((l) => <span key={l.k} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: l.warna }} />{l.nama}</span>)}
            {iot && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: C.iot }} />AIoT alat medis</span>}
            <span className="flex items-center gap-1"><span className="h-2 w-2 rotate-45 border border-[#b8a9ff]" />kode (tanpa model)</span>
            <span>· berdenyut = sedang bekerja · redup bercincin hijau = selesai · titik bergerak = klaim, sinyal, tag, berkas, skor dan keputusan yang berpindah antarsistem</span>
          </div>
        </div>

        {/* the interaction log */}
        <aside className="flex h-[340px] w-full shrink-0 flex-col border-t border-black/30 bg-[#1c2127] min-[1900px]:h-auto min-[1900px]:max-h-[720px] min-[1900px]:w-[360px] min-[1900px]:border-l min-[1900px]:border-t-0">
          <div className="flex flex-wrap items-center gap-1 border-b border-white/5 px-3 py-2">
            <p className="mr-1 text-[11px] font-semibold text-white">{live ? "Log proses · langsung" : "Log interaksi"}</p>
            {live && <span className="flex items-center gap-1 text-[10.5px] text-[#ff8a8d]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff6b6b]" />diperbarui tiap beberapa detik</span>}
            {!live && JENIS.filter(([k]) => k !== "iot" || iot).map(([k, n]) => <button key={k} onClick={() => setJenis(k)} className={`rounded px-1.5 py-0.5 text-[10.5px] ${jenis === k ? "bg-white/15 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>{n}</button>)}
          </div>
          <div ref={logRef} onScroll={(e) => { const el = e.currentTarget; ikut.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
            className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-snug">
            {live && live.log.map((l, i) => {
              const m = /^\[\s*([\d.]+) min\]\s*(?:\[\s*[\d.]+ min\]\s*)?(.*)$/.exec(l), teks = m ? m[2] : l, w = warnaLog(teks);
              return (
                <p key={`l-${i}`} className="flex gap-2">
                  <span className="w-[42px] shrink-0 tabular-nums text-[#6b7480]">{m ? mmss(Number(m[1]) * 60000) : ""}</span>
                  <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: w }} />
                  <span className="min-w-0 break-words text-[#c5cbd3]">{teks}</span>
                </p>
              );
            })}
            {live && !live.log.length && <p className="p-3 text-center font-sans text-[#8f99a8]">Menunggu baris pertama dari proses audit…</p>}
            {!live && log.slice(-400).map((b, i) => {
              const [nm, w] = NAMA[b.siapa] ?? [b.siapa, "#8f99a8"];
              return (
                <p key={`${b.at}-${i}`} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-[#6b7480]">{mmss(b.at)}</span>
                  <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: w }} />
                  <span className="min-w-0 text-[#c5cbd3]"><span className="font-semibold" style={{ color: w }}>{nm}</span>{" "}
                    <span style={b.warna ? { color: b.warna === C.tahan ? "#ff8a8d" : "#f0c661" } : undefined}>{b.teks}</span></span>
                </p>
              );
            })}
            {!live && !log.length && <p className="p-3 text-center font-sans text-[#8f99a8]">Tekan Putar: setiap interaksi antarsistem muncul di sini.</p>}
          </div>
        </aside>
      </div>

      {/* what the judge is reading now */}
      {S.fitur && S.fitur.k.agen && (
        <div className="border-t border-white/5 p-3">
          <p className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[#8f99a8]">
            <span className="font-semibold text-white">Berkas yang dibaca hakim</span>
            <span className="tabular-nums">batch {S.fitur.batch} · {S.fitur.label}</span>
            <span className="text-white">{S.fitur.k.id}</span><span>{S.fitur.k.rs}</span><span className="tabular-nums">{S.fitur.k.inacbg}</span>
            {(() => {
              const kp = S.fitur.k.keputusan, c = kp === "DIBERSIHKAN" ? [C.lolos, "#c5cbd3"] : kp === "TAHAN" ? [C.tahan, "#ff8a8d"] : [C.periksa, "#f0c661"];
              return <span className="rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: `${c[0]}22`, color: c[1] }}>{kp === "DIBERSIHKAN" ? "dibersihkan swarm" : kp.toLowerCase()}</span>;
            })()}
          </p>
          <div className="grid gap-2 md:grid-cols-4">
            {([["koding", "Spesialis koding & klinis"], ["tagihan", "Spesialis tagihan"], ["episode", "Spesialis episode & jaringan"], ["hakim", "Hakim"]] as const).map(([k, n]) => {
              const a = S.fitur?.k.agen?.[k];
              if (!a) return null;
              return (
                <div key={k} className={`rounded border px-2.5 py-2 ${k === "hakim" ? "border-white/25 bg-white/[.04]" : "border-white/[.07]"}`}>
                  <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-semibold" style={{ color: k === "hakim" ? "#fff" : "#f19ac0" }}>{n}</span>
                    <span className="text-[11px] tabular-nums text-white">skor {id(a.p, 2)}</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-[#2c333b]"><div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, a.p * 100)}%`, background: a.p >= 0.6 ? C.periksa : a.p >= 0.35 ? "#8f99a8" : "#5f6b7a" }} /></div>
                  <p className="mt-1.5 text-[10.5px] leading-snug text-[#d3d8de]">{a.bukti || a.alasan}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="border-t border-white/5 px-3 py-2 text-[10.5px] text-[#8f99a8]">
        Replay disusun dari keluaran run ini: tag, angka, zona, pendapat dan skor setiap agen, keputusan, narasi dan biaya. Urutan batch dan durasi direkonstruksi, bukan rekaman waktu nyata.
      </p>
    </section>
  );
}
