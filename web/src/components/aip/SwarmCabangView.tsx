"use client";

// AI Agent Swarm Branch (the user, 2026-11-13): the audit as a BPJS branch office (Kantor Cabang) runs it, because in
// practice the branch verifies the claims, not head office. A branch's batch of hospital claims went through v5 (model v4 +
// the rule engine + the ADK swarm on Vertex AI). The report answers three questions only: what the system found, why each
// claim needs review, and what the verifier should do; it is grouped by clinical theme and drawn in the national AI Agent
// Swarm report's style. Operational measures only (claims analysed, queued, share to review, billed value flagged, the
// verifiers' own results); the model's evaluation against the planted labels is a separate technical appendix.
// Data: /api/swarm-cabang (testing/laporan_cabang.py). Synthetic data; the branch areas are a demo grouping.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/aip/Briefing";
import { ExhibitCard } from "@/components/aip/LaporanLengkap";
import { GROUP_COLOR, JALUR, TSM_COLOR, TSM_DIM, TSM_MARK, type Exhibit, type Tsm } from "@/components/aip/fraudApi";
import { type GrafKasus, type GrafKC, type Penjelasan } from "./GrafKlaim";
import { PenjelasanKlaim } from "./PenjelasanKlaim";
import { IotKlaim, hasilIot, type IotKasus, type IotRingkas } from "./IotKlaim";
import { CABANG_PILIH_RUN, umumkanRunCabang } from "./cabangPilih";
import { SwarmCabangBagan, type BoxBagan, type IndikasiBagan, type PutusanBagan } from "./SwarmCabangBagan";
import { IstilahSingkat, RingkasInti, RingkasanPimpinan, olahRingkas, periodeAwam, pilihContoh } from "./RingkasanPimpinan";
import { SERIES } from "./viz";
import { CabangTabJejak } from "./CabangTabJejak";
import { CabangTabIndikasi, type BarisIndikasi } from "./CabangTabIndikasi";
import { CabangTabBiaya } from "./CabangTabBiaya";
import type { Jejak } from "@/lib/cabangJejak";

type Agen = { p: number; bukti?: string; alasan?: string; famili?: string;
  /** the judge only (prompt p3, 2026-11-15): its stance on each rule finding R1..Rn of the dossier */
  aturan?: { id: string; sikap: string; alasan?: string }[] };
// a rule-engine finding the swarm read (medical record or IoT; testing/jalan_kc_tema.py stage aturan) and the gate's lanes
type TemuanAturan = { id: string; sumber: string; kode: string; pemilik?: string; k?: number; terverifikasi?: boolean; teks?: string };
type JalurGerbang = { jalur: string; f?: number; f_ml?: number; f_aturan?: number; k_aturan?: number; tau?: number; alasan_jalur?: string;
  hakim_terima?: string[]; hakim_tolak?: string[] };
type Shap = { fitur: string; kontribusi: number };
type KeputusanAI = { famili: string; indikator: string[]; alasan: string; keyakinan: string; keyakinan_teks: string; rekomendasi: string; shap: Shap[] };
export type Kasus = { id: string; tema: string; tema_nama: string; keputusan: "TAHAN" | "PERIKSA" | "DIBERSIHKAN"; rs: string; inacbg: string; deskripsi: string;
  faskes?: string; kabkota?: string; dx?: string; dx_nama?: string; tingkat: string; kelas: string; los: number; tgl: string; biaya_rp: number; tarif_rp: number; topup_rp: number; dx_sekunder: number;
  estimasi_kerugian_rp?: number; dasar_kerugian?: string; tag_label?: string | null;
  peserta: string; skor_model: number; rule: string[]; agen: Record<string, Agen> | null; p_hakim: number | null;
  keputusan_ai: KeputusanAI; skor_risiko: number; indeks_prioritas: number; perbedaan_pendapat: number | null; prioritas: "P1" | "P2" | "P3" | null;
  /** the claim's medical-device evidence (testing/iot_cabang.py, runs since 2026-11-15): only claims with a monitored device */
  iot?: IotKasus;
  /** rule findings the swarm read, and the gate's lane (runs with the rule stage) */
  temuan_aturan?: TemuanAturan[] | null; jalur?: JalurGerbang | null };
type Tema = { kode: string; nama: string; klaim: number; tagihan_rp: number; periksa: number; tahan: number; dibersihkan: number; nilai_antrean_rp: number };
type Bab = { id: string; judul: string; tema?: string; exhibit: string[]; bagian: { id: string; judul: string; teks: string }[];
  /** the clinical themes chapter: one section per theme with its own exhibits */
  subbab?: { id: string; tema: string; judul: string; teks: string; exhibit: string[] }[] };
// one hospital's case file (testing/laporan_cabang.py berkas_rs): the national report's "berkas kasus per faskes" for a branch
export type BerkasRS = { faskes_profil_id: string; nama: string; kabkota: string; kab: number; tipe: string; jenis: string; kepemilikan: string; kelompok: string;
  klaim: number; tagihan_rp: number; bertag: number; rekomendasi: number; tahan: number; periksa: number; nilai_terindikasi_rp: number; estimasi_kerugian_rp: number;
  porsi_kerugian: number; saran: string; modus_utama: string; rugi_modus: { label: string; klaim: number; estimasi_kerugian_rp: number }[];
  modus: { modus: string; kuat: number; sedang: number; lemah: number; total: number }[]; kasus: string[]; temuan: string[]; koordinat?: { lon: number; lat: number } | null;
  /** the Permenkes 16/2019 modes its claims' explanations name (testing/graf_cabang.py), most claims first */
  modus_klaim?: { kode: string; nama: string; klaim: number }[];
  /** since 2026-11-14: each TSM dimension's level, points and evidence, and the path that follows (ditindak / dibina / dibebaskan) */
  tsm?: Partial<Tsm>; jalur?: string };
// the branch's Box Karantina (testing/laporan_cabang.py, since 2026-11-14): every hospital with at least one indication tag, by
// group (A = first 50% of the estimated loss, B to 80%, C 95%, D 99%, Z the rest) and by TSM path; kriteria = the thresholds in words
type BoxKC = { rs: number; rs_klaim: number; estimasi_kerugian_rp: number; kelompok: Record<string, { rs: number; estimasi_kerugian_rp: number; rekomendasi: number }>;
  jalur: Partial<Record<"ditindak" | "dibina" | "dibebaskan", number>>; kriteria?: string[] };
type Ukur = { label: string; tp: number; fp: number; fn: number; tn: number; recall: number; presisi_mentah: number; fpr: number; presisi_prev2: number; antrean: number;
  rp: { fraud_ditemukan: number; fraud_lolos: number; normal_di_antrean: number; total_fraud: number } };
type Kinerja = { sistem: Record<string, Ukur>; zona_ragu?: { klaim: number; fraud: number; auroc_model: number };
  ci_selisih_v5?: Record<string, { recall: [number, number]; fpr: [number, number]; presisi_prev2: [number, number] }> };
type Kesalahan = { tema: { kode: string; nama: string; fraud: number; tertangkap: number; tidak_masuk_ragu: number; dibersihkan_swarm: number; normal_di_antrean: number;
  rp_lolos: number; skema_lolos: { skema: string; n: number }[] }[]; skema: { skema: string; fraud: number; tertangkap: number; tidak_masuk_ragu: number; dibersihkan_swarm: number }[] };
type CekRugi = { klaim_antrean: number; klaim_fraud: number; estimasi_rp: number; di_klaim_fraud_rp: number; porsi_di_fraud: number | null;
  nilai_terindikasi_rp: number; nilai_terindikasi_fraud_rp: number };
type HitungRiil = { n: number; zona: Record<string, number>; swarm: { dibaca: number; periksa: number; dibersihkan: number } };
type Riil = { klaim: number; zona: Record<string, number>; swarm: HitungRiil["swarm"]; rule: number; ragu_belum_dibaca: number;
  koreksi_verifikator?: HitungRiil; calon_klaim_ganda?: HitungRiil; selisih_rp?: { total: number; di_antrean: number; di_ragu: number } };
type Lampiran = { riil?: Riil; riil_nasional?: Riil; kerugian?: CekRugi; kinerja: Kinerja; kesalahan: Kesalahan; desain?: { latih: { baris: number; fraud: number }; validasi: { baris: number; fraud: number; untuk: string };
  uji: { set: string; klaim: number; fraud: number | null; untuk: string }; generator: string } };
export type Putusan = { status: "terbukti" | "sesuai" | "investigasi"; catatan: string; oleh: string; pada: string };
export type Laporan = { dibuat: string; periode: string; kc: { id: string; nama: string; provinsi: string; kabkota: string[]; rs: number };
  sampul: { klaim: number; tagihan_rp: number; rs: number; ragu: number; periksa: number; tahan: number; dibersihkan: number; lolos: number; antrean: number;
    nilai_antrean_rp: number; tema_aktif: number; biaya_swarm_usd: number; persen_antrean: number;
    nilai_transaksi_rp?: number; nilai_terindikasi_rp?: number; estimasi_kerugian_rp?: number; model?: string };
  bab: Bab[]; exhibit: Exhibit[]; tema: Tema[]; kasus: Kasus[]; lampiran: Lampiran; catatan: string[]; run?: { id: string; label: string };
  narasi?: Record<string, { makna?: string; implikasi?: string }>; verifikasi?: Record<string, Putusan>; indikasi?: IndikasiBagan; berkas_rs?: BerkasRS[]; box?: BoxKC;
  /** the IoT verification layer's summary (chapter "iot"; runs since 2026-11-15) */
  iot?: IotRingkas };
type Ledger = { tag?: number; status?: Record<string, number>; error?: string };
type Indeks = { id: string; ledger?: Ledger; kc: { id: string; nama: string; provinsi: string; kabkota: string[]; klaim: number; antrean: number; nilai_antrean_rp: number; ragu: number }[]; lampiran?: Lampiran };
type Run = { id: string; label: string; dibuat: string; dijalankan?: string; kc: number; biaya_usd: number; narasi_exhibit: number; metrik?: { riil?: boolean };
  kalimat_dibuang_cek_angka?: number; biaya_swarm?: { usd_perkiraan?: number; panggilan?: number; token_masuk?: number; token_keluar?: number; selesai?: number };
  operasional?: { klaim: number; antrean: number; nilai_ditandai_rp: number; dibaca_swarm: number } };

const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const rp = (v: number) => (v >= 1e9 ? `Rp ${id(v / 1e9, 2)} M` : v >= 1e6 ? `Rp ${id(v / 1e6, 1)} jt` : `Rp ${id(v)}`);
const pct = (v: number, d = 1) => `${id(v * 100, d)}%`;
// the swarm's decisions in plain words; the report's own term (TAHAN, PERIKSA, dibersihkan swarm) in the tooltip
const KEP: Record<string, [string, string, string, string]> = {
  TAHAN: ["Ditahan", "#e5484d", "#ff8a8d", "TAHAN: skor model sangat tinggi; pembayaran ditahan sampai diverifikasi"],
  PERIKSA: ["Perlu diperiksa", "#c98500", "#f0c661", "PERIKSA: tim agen AI menilai buktinya cukup untuk dicek verifikator"],
  DIBERSIHKAN: ["Dibersihkan tim AI", "#5f6b7a", "#c5cbd3", "Dibersihkan swarm: tim agen AI menilai buktinya belum cukup; tidak masuk antrean"] };
const PRIO: Record<string, [string, string]> = { P1: ["P1 · segera", "#ff8a8d"], P2: ["P2", "#f0c661"], P3: ["P3", "#c5cbd3"] };
const PRIO_ARTI = "Urutan pengecekan = skor risiko × nilai tagihan: P1 20% teratas, P2 30% berikutnya, P3 sisanya";
const STATUS: Record<string, [string, string]> = { terbukti: ["Terbukti bermasalah", "#ff8a8d"], sesuai: ["Sesuai", "#7ee2c0"], investigasi: ["Perlu investigasi", "#f0c661"] };
const MODUS: Record<string, string> = { koding: "Indikasi koding & klinis", tagihan: "Indikasi tagihan", episode: "Indikasi episode", identitas: "Indikasi identitas", jaringan: "Indikasi jaringan", normal: "Tanpa indikasi modus spesifik" };
const AGEN: [string, string][] = [["koding", "Spesialis koding & klinis"], ["tagihan", "Spesialis tagihan"], ["episode", "Spesialis episode & jaringan"], ["hakim", "Hakim"]];

function Chip({ children, warna = "#8f99a8", garis = false }: { children: React.ReactNode; warna?: string; garis?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
    style={{ background: garis ? "transparent" : `${warna}22`, color: warna, borderColor: garis ? `${warna}88` : undefined }}>{children}</span>;
}
const Judul = ({ children, title }: { children: React.ReactNode; title?: string }) => <p title={title} className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8f99a8]">{children}</p>;
// the claim networks of the branch (testing/graf_cabang.py): the index (graf_<kc>/index.json: the shared header and, per case file,
// the mode its explanation names, for the summary row) is loaded once per branch, beside the report; a case's full network is
// fetched when its file is opened (&kasus=<id>) and kept per run|kc|build|case for the session. A run built before 2026-11-15
// sends every case's full network with the index (one graf_<kc>.json): those go straight into that cache.
type RingkasGraf = { modus: Penjelasan["modus"]; bukti?: string; keyakinan?: string; lain?: { kode: string; nama: string }[] };
type GrafIndeks = Omit<GrafKC, "kasus"> & { kasus: Record<string, RingkasGraf> };
type GrafIndeksDikirim = Omit<GrafKC, "kasus"> & { kasus: Record<string, RingkasGraf | GrafKasus> };  // as the API sends it (either layout)
type Jaringan = { data: GrafIndeks | null; status: string; run?: string; kc?: string };
const grafKasus = new Map<string, { data?: GrafKasus; status?: string }>();
const grafDiminta = new Set<string>();
const grafPendengar = new Set<() => void>();
const kunciGraf = (run: string, kc: string, dibuat: string, x: string) => `${run}|${kc}|${dibuat}|${x}`;
const kabarGraf = () => grafPendengar.forEach((f) => f());
const langganGraf = (f: () => void) => { grafPendengar.add(f); return () => { grafPendengar.delete(f); }; };
/** The index as the view keeps it: per case only its summary; full networks (an older run's single file) seed the case cache. */
function indeksGraf(d: GrafIndeksDikirim, run: string, kc: string): GrafIndeks {
  const kasus: Record<string, RingkasGraf> = {};
  for (const [x, g] of Object.entries(d.kasus)) {
    if (!("penjelasan" in g)) { kasus[x] = g; continue; }
    const kunci = kunciGraf(run, kc, d.dibuat, x);
    if (!grafKasus.get(kunci)?.data) grafKasus.set(kunci, { data: g });  // the same build read again: keep the case already drawn
    const jf = g.penjelasan.jenis_fraud ?? [], u = jf.find((j) => j.kode === g.penjelasan.modus.kode) ?? jf[0];
    kasus[x] = { modus: g.penjelasan.modus, bukti: u?.bukti, keyakinan: u?.keyakinan, lain: jf.filter((j) => j !== u).map((j) => ({ kode: j.kode, nama: j.nama })) };
  }
  kabarGraf();
  return { ...d, kasus };
}
/** One case file's full network: fetched the first time the file is opened (again after a failed try), then from the cache. */
function useGrafKasus(jar: Jaringan, x: string, buka: boolean): { g?: GrafKasus; memuat: boolean; status: string } {
  const { data, run, kc } = jar;
  const kunci = data && run && kc && data.kasus[x] ? kunciGraf(run, kc, data.dibuat, x) : "";
  const url = kunci && run && kc ? `/api/swarm-cabang?run=${encodeURIComponent(run)}&kc=${encodeURIComponent(kc)}&graf=1&kasus=${encodeURIComponent(x)}` : "";
  const v = useSyncExternalStore(langganGraf, () => (kunci ? grafKasus.get(kunci) : undefined), () => undefined);
  useEffect(() => {
    if (!buka || !url || grafKasus.get(kunci)?.data || grafDiminta.has(kunci)) return;
    grafDiminta.add(kunci);
    if (grafKasus.delete(kunci)) kabarGraf();  // a failed try: loading again
    ambil<GrafKasus>(url)
      .then((g) => grafKasus.set(kunci, { data: g }), (e) => grafKasus.set(kunci, { status: String(e.message || e) }))
      .finally(() => { grafDiminta.delete(kunci); kabarGraf(); });
  }, [buka, url, kunci]);
  if (v?.data) return { g: v.data, memuat: false, status: "" };
  if (kunci) return { memuat: !v?.status, status: v?.status ?? "Memuat jaringan klaim…" };
  return { memuat: false, status: jar.status || "Penjelasan dan graph klaim ini belum dibuat (testing/graf_cabang.py)." };
}
/** Opens every folded section around an element (a chapter of the full report, a hospital's file) so it can be shown. */
function bukaLeluhur(el: Element) {
  for (let p = el.parentElement?.closest("details"); p; p = p.parentElement?.closest("details")) if (!p.open) p.open = true;
}
// open a case file and scroll to it; one not rendered yet (past the first 8 of a theme, or cleared by the swarm) is shown first
const BUKA_BERKAS = "cabang-buka-berkas";
function bukaBerkas(x: string) {
  const el = document.getElementById(`klaim-${x}`) as HTMLDetailsElement | null;
  if (el) { bukaLeluhur(el); el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  window.dispatchEvent(new CustomEvent<string>(BUKA_BERKAS, { detail: x }));
}
const skorBar = (v: number, w = "w-14") => (
  <span className={`h-1.5 ${w} rounded-full bg-[#2c333b]`}><span className="block h-1.5 rounded-full" style={{ width: `${Math.max(3, v * 100)}%`, background: v >= 0.75 ? "#e0a02b" : "#8f99a8" }} /></span>
);

// ---------------------------------------------------------------- the claim and hospital lists, the national audit's way
// (the user, 2026-11-15: the hospital list and each hospital's claim list read "pusing"; "bikin gini kayak di ai-jkn-audit ... biar
// jelas kasus ini kena jenis fraud yg mana"): one line per claim or hospital in fixed columns; a hospital's fraud types (Permenkes
// 16/2019 modes) counted above its claims as chips that filter them; the evidence grouped per fraud type below
type ModusKlaim = { kode: string; nama: string };
const SINGKAT_MODUS: [RegExp, string][] = [[/upcoding|manipulasi diagnosis/i, "Upcoding"], [/readmisi/i, "Readmisi"], [/pemecahan episode/i, "Pecah episode"],
  [/phantom|klaim palsu/i, "Klaim palsu"], [/tidak sesuai indikasi/i, "Tidak sesuai indikasi"], [/inflated|penggelembungan/i, "Tagihan digelembungkan"],
  [/tidak dilakukan/i, "Tindakan tak dilakukan"], [/prolonged|lama rawat/i, "Rawat diperpanjang"], [/fiktif/i, "Obat/alkes fiktif"],
  [/kelas perawatan|room charge/i, "Manipulasi kelas rawat"], [/repeat billing|klaim berulang/i, "Klaim berulang"], [/self.?referral|rujukan semu/i, "Rujukan semu"],
  [/unbundling|fragmentation/i, "Unbundling"], [/cloning|penjiplakan/i, "Cloning"]];
const singkatModus = (nama: string) => SINGKAT_MODUS.find(([re]) => re.test(nama))?.[1] ?? nama.split(" (")[0].split(" / ")[0];
const WARNA_MODUS = ["#ff8a8d", "#f0c661", "#7ea3ff", "#c9a7ff", "#7ee2c0", "#ffb59a", "#5fd0e8", "#e7a6d8", "#b8d97a"];
const warnaModus = (m: ModusKlaim) => WARNA_MODUS[(parseInt(m.kode.replace(/\D/g, ""), 10) || m.nama.length) % WARNA_MODUS.length];
/** The claim's fraud type: the Permenkes mode its explanation names (the graph index), else its swarm family. */
function modusKlaim(k: Kasus, jar: Jaringan): ModusKlaim {
  const m = jar.data?.kasus[k.id]?.modus;
  return m?.nama ? { kode: m.kode && m.kode !== "-" ? m.kode : "", nama: m.nama } : { kode: "", nama: MODUS[k.keputusan_ai.famili] ?? k.keputusan_ai.famili };
}
const kunciModus = (m: ModusKlaim) => `${m.kode}|${m.nama}`;
function ChipModus({ m, n }: { m: ModusKlaim; n?: number }) {
  return (
    <span title={`${m.kode ? `${m.kode} · ` : ""}${m.nama} (Permenkes 16/2019)`}
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-[#e5e8eb]">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: warnaModus(m) }} />
      {m.kode && <span className="font-mono text-[10px] text-[#abb3bf]">{m.kode}</span>}
      <span className="truncate">{singkatModus(m.nama)}</span>
      {n != null && <span className="tabular-nums text-[#8f99a8]">· {n} klaim</span>}
    </span>
  );
}
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const tglPendek = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return y && m && d ? `${d} ${BULAN[m - 1]} ${y}` : s; };
// the columns of a claim row and of a hospital row from md up (below, a row wraps)
const KOLOM_KLAIM = "md:grid md:grid-cols-[104px_136px_112px_minmax(0,1fr)_84px_92px_88px_14px]";
const KOLOM_RS = "md:grid md:grid-cols-[24px_minmax(0,1fr)_92px_76px_92px_92px_104px_14px]";
const KEPALA = "hidden items-end gap-x-3 px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8f99a8]";
function KepalaKlaim({ rs = false }: { rs?: boolean }) {
  return (
    <div className={`${KEPALA} ${KOLOM_KLAIM}`}>
      <span>ID klaim</span><span>Status</span><span>Rawat</span><span>Jenis fraud{rs ? " · RS" : ""}</span><span className="text-right">Tagihan</span>
      <span className="text-right">Estimasi rugi</span><span>Verifikasi</span><span />
    </div>
  );
}

// ---------------------------------------------------------------- head office vs branch
function PusatCabang() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-lg border border-white/[.07] bg-[#1c2127] p-3 opacity-80">
        <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Kantor pusat · tab AI Agent Swarm</p>
        <p className="mt-0.5 text-[12.5px] font-semibold text-white">Audit nasional: pola, provinsi, Box Karantina RS</p>
        <p className="mt-1 text-[11px] text-[#abb3bf]">56 agen, analis per provinsi, keluaran: temuan dan prioritas RS untuk investigasi.</p>
      </div>
      <div className="rounded-lg border p-3" style={{ borderColor: `${SERIES[2]}66`, background: `${SERIES[2]}0d` }}>
        <p className="text-[10.5px] uppercase tracking-wide text-[#7ee2c0]">Kantor cabang · tab ini</p>
        <p className="mt-0.5 text-[12.5px] font-semibold text-white">Verifikasi klaim RS di wilayah KC, per batch</p>
        <p className="mt-1 text-[11px] text-[#d3d8de]">Apa yang ditemukan, mengapa klaim perlu diperiksa, dan tindakan verifikator: per tema klinis, dengan pendapat tiap agen.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one flagged claim
function Tindakan({ k, put, simpan }: { k: Kasus; put?: Putusan; simpan: (klaim: string, status: string, catatan: string) => Promise<void> }) {
  const [catatan, setCatatan] = useState(put?.catatan ?? "");
  const [busy, setBusy] = useState(false);
  const pilih = async (s: string) => { setBusy(true); try { await simpan(k.id, s, catatan); } finally { setBusy(false); } };
  return (
    <div className="lp-no-print space-y-2 rounded-md border border-white/[.08] bg-[#151a1f] p-3">
      <Judul>Tindakan verifikator</Judul>
      <p className="text-[12px] leading-snug text-white">{k.keputusan_ai.rekomendasi}</p>
      <textarea value={catatan} onChange={(e) => setCatatan(e.target.value)} placeholder="Catatan verifikasi (dokumen yang diminta, temuan, dsb.)" rows={2}
        className="w-full rounded border border-white/10 bg-[#1c2127] px-2 py-1.5 text-[11.5px] text-white placeholder:text-[#5f6b7a]" />
      <div className="flex flex-wrap items-center gap-1.5">
        {Object.entries(STATUS).map(([s, [nama, w]]) => (
          <button key={s} disabled={busy} onClick={() => pilih(s)} className="rounded border px-2 py-1 text-[11px] disabled:opacity-50"
            style={put?.status === s ? { background: `${w}26`, borderColor: w, color: w } : { borderColor: "rgba(255,255,255,.12)", color: "#d3d8de" }}>{nama}</button>
        ))}
        {put && <button disabled={busy} onClick={() => pilih("")} className="rounded px-2 py-1 text-[11px] text-[#8f99a8] hover:text-white">batalkan</button>}
        {put && <span className="ml-auto text-[10.5px] text-[#8f99a8]">dicatat {put.oleh} · {new Date(put.pada).toLocaleString("id-ID")}</span>}
      </div>
    </div>
  );
}

// the technical side of a case file: the model's indicators and drivers, the claim's figures, each agent's opinion
function IsiTeknis({ k }: { k: Kasus }) {
  const a = k.keputusan_ai;
  const beda = k.perbedaan_pendapat;
  return (
    <div className="grid gap-3 xl:grid-cols-[1.1fr_1fr]">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Judul>Indikator model dan rule</Judul>
          <p className="text-[12px] text-white"><span className="text-[#f0c661]">{MODUS[a.famili] ?? a.famili}.</span> {a.alasan}</p>
          <div className="flex flex-wrap gap-1.5">{a.indikator.map((x) => <Chip key={x} warna="#c5cbd3" garis>{x}</Chip>)}</div>
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#abb3bf]"><Chip warna={a.keyakinan === "Tinggi" ? "#f0c661" : "#c5cbd3"}>keyakinan {a.keyakinan.toLowerCase()}</Chip>{a.keyakinan_teks}</p>
        </div>
        <div className="space-y-1.5">
          <Judul>Data klaim</Judul>
          <p className="text-[11.5px] text-[#e5e8eb]">{k.inacbg} · {k.deskripsi}{k.dx ? <span className="text-[#abb3bf]"> · dx {k.dx}{k.dx_nama ? ` ${k.dx_nama}` : ""}</span> : null}</p>
          <div className="flex flex-wrap gap-1.5">
            <Chip>{k.tgl}</Chip><Chip>{k.tingkat}</Chip><Chip>{k.kelas}</Chip><Chip>LOS {k.los} hari</Chip><Chip>tagihan {rp(k.biaya_rp)}</Chip>
            {k.estimasi_kerugian_rp !== undefined && k.keputusan !== "DIBERSIHKAN" && <Chip warna="#ffb59a">estimasi kerugian {rp(k.estimasi_kerugian_rp)}{k.tag_label ? ` · ${k.tag_label}` : ""}{k.dasar_kerugian ? ` · ${k.dasar_kerugian}` : ""}</Chip>}
            <Chip>tarif INA-CBG {rp(k.tarif_rp)}</Chip><Chip>top-up {rp(k.topup_rp)}</Chip><Chip>dx sekunder {k.dx_sekunder}</Chip><Chip>peserta {k.peserta}</Chip>
          </div>
          {a.shap.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-[10.5px] text-[#8f99a8]">Yang paling menaikkan skor model (kontribusi SHAP)</p>
              {a.shap.slice(0, 5).map((s) => (
                <div key={s.fitur} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 90px" }}>
                  <span className="truncate text-[11px] text-[#d3d8de]" title={s.fitur}>{s.fitur}</span>
                  <span className="h-1.5 rounded-full bg-[#2c333b]"><span className="block h-1.5 rounded-full" style={{ width: `${Math.min(100, (s.kontribusi / Math.max(...a.shap.map((x) => x.kontribusi))) * 100)}%`, background: SERIES[0] }} /></span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        {k.agen ? (
          <>
            <div className="flex flex-wrap items-center gap-2"><Judul>Pendapat AI Agent Swarm</Judul>
              {beda !== null && <Chip warna={beda >= 0.4 ? "#ff8a8d" : beda >= 0.2 ? "#f0c661" : "#7ee2c0"}>perbedaan pendapat {beda >= 0.4 ? "tinggi" : beda >= 0.2 ? "sedang" : "rendah"} · selisih {id(beda, 2)}</Chip>}</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {AGEN.map(([key, n]) => {
                const g = k.agen?.[key];
                if (!g) return null;
                return (
                  <div key={key} className={`rounded border px-2.5 py-2 ${key === "hakim" ? "border-white/25 bg-white/[.04] sm:col-span-2" : "border-white/[.07]"}`}>
                    <div className="flex items-center justify-between gap-2"><span className={`text-[11px] font-semibold ${key === "hakim" ? "text-white" : "text-[#7ee2c0]"}`}>{n}{key === "hakim" ? " · keputusan akhir" : ""}</span>
                      <span className="flex items-center gap-1 text-[10.5px] tabular-nums text-white">{skorBar(g.p, "w-10")}skor {id(g.p, 2)}</span></div>
                    {g.bukti && <p className="mt-1 text-[11px] leading-snug text-[#d3d8de]"><span className="text-[#8f99a8]">Bukti: </span>{g.bukti}</p>}
                    {g.alasan && <p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">{g.alasan}</p>}
                  </div>
                );
              })}
            </div>
          </>
        ) : <p className="rounded border border-white/[.07] px-2.5 py-2 text-[11px] text-[#abb3bf]">Ditahan langsung oleh skor model yang sangat tinggi; tim agen AI tidak dipanggil.</p>}
        <TemuanDanSikap k={k} />
      </div>
    </div>
  );
}

// the rule-engine findings the swarm read (medical record, IoT) with the judge's stance on each, and the lane that decided
function TemuanDanSikap({ k }: { k: Kasus }) {
  const t = k.temuan_aturan ?? [];
  const sikap = new Map((k.agen?.hakim?.aturan ?? []).map((s) => [s.id, s]));
  const j = k.jalur;
  if (!t.length && !j) return null;
  const SUMBER: Record<string, [string, string]> = { rme: ["rekam medis", "#7ea3ff"], iot: ["IoT alat", "#2dd4bf"] };
  return (
    <div className="mt-2 space-y-1.5 rounded border border-white/[.08] bg-black/20 px-2.5 py-2">
      <Judul>Temuan aturan dan sikap hakim</Judul>
      {t.map((x) => {
        const s = sikap.get(x.id), [nm, w] = SUMBER[x.sumber] ?? [x.sumber, "#c5cbd3"];
        return (
          <div key={x.id} className="text-[11px] leading-snug">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10.5px] text-white">{x.id}</span>
              <Chip warna={w}>{nm}</Chip>
              {x.pemilik && <Chip>spesialis {x.pemilik}</Chip>}
              {x.k != null && <Chip>kekuatan {id(x.k, 2)}</Chip>}
              {x.terverifikasi && <Chip warna="#7ee2c0">terverifikasi</Chip>}
              {s ? <Chip warna={s.sikap === "terima" ? "#ff8a8d" : "#7ee2c0"}>hakim {s.sikap}</Chip> : <Chip garis>tidak dinilai</Chip>}
            </p>
            {x.teks && <p className="mt-0.5 text-[#d3d8de]">{x.teks.length > 260 ? `${x.teks.slice(0, 259)}…` : x.teks}</p>}
            {s?.alasan && <p className="text-[#abb3bf]"><span className="text-[#8f99a8]">Alasan hakim: </span>{s.alasan}</p>}
          </div>
        );
      })}
      {j && (
        <p className="border-t border-white/[.06] pt-1.5 text-[11px] text-[#d3d8de]">
          <span className="text-[#8f99a8]">Gerbang: </span>{j.jalur === "bukti_aturan" ? "jalur bukti aturan" : "jalur ML"}
          {j.alasan_jalur ? ` · ${j.alasan_jalur}` : ""}{j.tau != null ? ` · τ ${id(j.tau, 2)}` : ""}
        </p>
      )}
    </div>
  );
}

// the report's IoT block is used in the case file only when it is the full block (a graph built before the IoT layer)
const iotLengkap = (x?: IotKasus) => (x?.terukur || x?.rawat ? x : undefined);

function BerkasKlaim({ k, put, simpan, jar, model, kc, awal = false, rs = false, sorot = false }: { k: Kasus; put?: Putusan; simpan: (klaim: string, status: string, catatan: string) => Promise<void>;
  jar: Jaringan; model: string; kc: string; awal?: boolean;
  /** the hospital in the row (a list across hospitals); lit by a line of evidence about this claim */
  rs?: boolean; sorot?: boolean }) {
  const [nama, w, t, arti] = KEP[k.keputusan];
  const [buka, setBuka] = useState(false);
  // a hospital's first claim opens with the hospital's file, so its explanation and claim network are in view at once
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (awal && ref.current) ref.current.open = true; }, [awal]);
  // the row reads the index (the fraud type); the opened file its full network, fetched on opening
  const m = modusKlaim(k, jar), lain = jar.data?.kasus[k.id]?.lain ?? [];
  const rme = (k.temuan_aturan ?? []).filter((x) => x.sumber === "rme").length;
  const { g: graf, memuat, status } = useGrafKasus(jar, k.id, buka);
  const tindakan = k.keputusan !== "DIBERSIHKAN" ? <Tindakan k={k} put={put} simpan={simpan} />
    : <p className="text-[11px] text-[#abb3bf]">Dibersihkan tim agen AI: tidak masuk antrean. Ditampilkan agar verifikator bisa melihat alasannya.</p>;
  return (
    <details ref={ref} id={`klaim-${k.id}`} onToggle={(e) => setBuka(e.currentTarget.open)} className="lp-berkas group/klaim scroll-mt-4 rounded-lg border border-white/[.08] bg-[#1c2127]">
      <summary className={`flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-2 md:gap-x-3 ${KOLOM_KLAIM} ${sorot ? "bg-[#9d8cff]/10" : "hover:bg-white/[.03]"}`}>
        <span className="font-mono text-[11.5px] font-medium text-white">{k.id}</span>
        <span className="flex items-center gap-1">
          {k.prioritas && <span title={`${PRIO[k.prioritas][0]} · ${PRIO_ARTI}`} className="rounded px-1 py-0.5 text-[10px] font-semibold" style={{ background: `${PRIO[k.prioritas][1]}22`, color: PRIO[k.prioritas][1] }}>{k.prioritas}</span>}
          <span title={arti} className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ background: `${w}26`, color: t }}>{nama}</span>
        </span>
        <span className="whitespace-nowrap text-[11px] tabular-nums text-[#d3d8de]" title={`${k.inacbg}${k.dx ? ` · ${k.dx} ${k.dx_nama ?? ""}` : ""}`}>
          {tglPendek(k.tgl)}{k.los ? <span className="text-[#8f99a8]"> · {k.los} hr</span> : null}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <ChipModus m={m} />
          {lain.length > 0 && <span className="shrink-0 rounded bg-white/[.06] px-1 text-[10px] text-[#c5cbd3]" title={`juga: ${lain.map((x) => `${x.kode} ${x.nama}`).join("; ")}`}>+{lain.length}</span>}
          {k.iot && <span title={k.iot.judul} className="shrink-0 text-[10.5px] font-semibold" style={{ color: hasilIot(k.iot.hasil).warna }}>{hasilIot(k.iot.hasil).tanda} IoT</span>}
          {rme > 0 && <span title={`${rme} temuan rekam medis (RM) tidak cocok dengan tagihan`} className="shrink-0 rounded bg-[#7ea3ff]/15 px-1 text-[10px] font-semibold text-[#9fbaff]">RM</span>}
          {rs && <span className="min-w-0 truncate text-[11px] text-[#8f99a8]" title={k.rs}>{k.rs}</span>}
        </span>
        <span className="text-right text-[11.5px] tabular-nums text-white">{rp(k.biaya_rp)}</span>
        <span className="text-right text-[11.5px] tabular-nums text-[#ffb59a]" title={k.dasar_kerugian}>{k.estimasi_kerugian_rp ? rp(k.estimasi_kerugian_rp) : "—"}</span>
        <span className="whitespace-nowrap text-[10.5px]">{put ? <span style={{ color: STATUS[put.status][1] }}>{STATUS[put.status][0]}</span>
          : <span className="text-[#8f99a8]">{k.keputusan !== "DIBERSIHKAN" ? "belum dicek" : "—"}</span>}</span>
        <Icon name="down" className="h-3.5 w-3.5 text-[#8f99a8] transition group-open/klaim:rotate-180" />
      </summary>
      {buka && (graf
        ? <PenjelasanKlaim g={graf} model={model} kc={kc} keputusan={k.keputusan} meta={{ id: k.id, rs: k.rs, kode: k.inacbg, tgl: k.tgl }} onBuka={bukaBerkas}
            teknis={<IsiTeknis k={k} />} tindakan={tindakan} iotLaporan={iotLengkap(k.iot)} />
        : memuat ? <p className="border-t border-white/[.06] px-3 py-3 text-[11px] text-[#8f99a8]">{status}</p>
        : (
          <div className="space-y-3 border-t border-white/[.06] px-3 py-3">
            <p className="text-[11px] text-[#8f99a8]">{status}</p>
            {iotLengkap(k.iot) && <IotKlaim iot={k.iot!} klaim={{ id: k.id, peserta: k.peserta }} />}
            <IsiTeknis k={k} />
            {tindakan}
          </div>
        ))}
    </details>
  );
}

function DaftarKasus({ kasus, ver, simpan, jar, model, kc }: { kasus: Kasus[]; ver: Record<string, Putusan>; simpan: (klaim: string, status: string, catatan: string) => Promise<void>;
  jar: Jaringan; model: string; kc: string }) {
  const [semua, setSemua] = useState(false);
  const [tuju, setTuju] = useState("");
  const antre = kasus.filter((k) => k.keputusan !== "DIBERSIHKAN"), bersih = kasus.filter((k) => k.keputusan === "DIBERSIHKAN");
  const tampil = semua ? [...antre, ...bersih] : antre.slice(0, 8);
  useEffect(() => {
    const h = (e: Event) => { const x = (e as CustomEvent<string>).detail; if (kasus.some((k) => k.id === x)) { setSemua(true); setTuju(x); } };
    window.addEventListener(BUKA_BERKAS, h);
    return () => window.removeEventListener(BUKA_BERKAS, h);
  }, [kasus]);
  useEffect(() => {
    if (!tuju) return;
    const el = document.getElementById(`klaim-${tuju}`) as HTMLDetailsElement | null;
    if (el) { bukaLeluhur(el); el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }, [tuju, semua]);
  return (
    <div className="mt-4 space-y-2">
      <Judul>Berkas klaim · {antre.length} perlu dicek (urut prioritas){bersih.length ? ` · ${bersih.length} dibersihkan tim AI` : ""}</Judul>
      <KepalaKlaim rs />
      {tampil.map((k) => <BerkasKlaim key={k.id} k={k} put={ver[k.id]} simpan={simpan} jar={jar} model={model} kc={kc} rs />)}
      {(antre.length > 8 || bersih.length > 0) && (
        <button onClick={() => setSemua((s) => !s)} className="lp-no-print rounded border border-white/10 px-2 py-1 text-[11px] text-[#d3d8de] hover:bg-white/5">
          {semua ? "Ringkas" : `Tampilkan semua (${antre.length + bersih.length}), termasuk yang dibersihkan tim AI`}</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the verifier's worklist (priority = risk x bill)
function DaftarKerja({ L, ver }: { L: Laporan; ver: Record<string, Putusan> }) {
  const antre = L.kasus.filter((k) => k.keputusan !== "DIBERSIHKAN");
  const buka = bukaBerkas;
  const n = { P1: 0, P2: 0, P3: 0 } as Record<string, number>;
  antre.forEach((k) => { if (k.prioritas) n[k.prioritas] += 1; });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">{Object.entries(n).map(([p, c]) => <Chip key={p} warna={PRIO[p][1]}>{PRIO[p][0]}: {c} klaim</Chip>)}
        <span title={PRIO_ARTI}><Chip garis>urutan: risiko × nilai tagihan</Chip></span></div>
      <div className="overflow-hidden rounded-lg border border-white/[.08]">
        {antre.slice(0, 15).map((k, i) => (
          // a phone: priority, claim, bill and status on one line, the hospital under it; wider: one row of seven columns
          <button key={k.id} onClick={() => buka(k.id)} className={`flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left hover:bg-white/[.03] md:grid md:grid-cols-[70px_96px_minmax(0,1fr)_minmax(0,1fr)_90px_70px_120px] ${i ? "border-t border-white/[.05]" : ""}`}>
            <span className="text-[10.5px] font-semibold" style={{ color: PRIO[k.prioritas ?? "P3"][1] }}>{PRIO[k.prioritas ?? "P3"][0]}</span>
            <span className="text-[11.5px] font-medium text-white">{k.id}</span>
            <span className="truncate text-[11px] text-[#d3d8de] max-md:hidden">{k.tema_nama} · {MODUS[k.keputusan_ai.famili] ?? ""}</span>
            <span className="truncate text-[11px] text-[#abb3bf] max-md:order-last max-md:basis-full">{k.rs}</span>
            <span className="text-right text-[11.5px] tabular-nums text-white max-md:ml-auto">{rp(k.biaya_rp)}</span>
            <span className="flex items-center gap-1 text-[10.5px] tabular-nums text-[#abb3bf] max-md:hidden" title="skor risiko (bukan peluang terkalibrasi)">{id(k.skor_risiko, 2)}</span>
            <span className="text-right">{ver[k.id] ? <Chip warna={STATUS[ver[k.id].status][1]}>{STATUS[ver[k.id].status][0]}</Chip> : <Chip garis>belum diverifikasi</Chip>}</span>
          </button>
        ))}
      </div>
      {antre.length > 15 && <p className="text-[10.5px] text-[#8f99a8]">15 dari {antre.length} klaim teratas; sisanya ada di berkas kasus.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- technical appendix (internal model evaluation)
function Matriks({ u }: { u: Ukur }) {
  const sel = (n: number, lbl: string, w: string) => <div className="rounded border px-2 py-1.5" style={{ borderColor: `${w}55`, background: `${w}12` }}><p className="text-[16px] font-semibold tabular-nums text-white">{id(n)}</p><p className="text-[10px] text-[#abb3bf]">{lbl}</p></div>;
  return (
    <div className="grid max-w-[340px] grid-cols-[auto_1fr_1fr] items-center gap-1.5 text-[10.5px] text-[#8f99a8]">
      <span /><span className="text-center">label: fraud</span><span className="text-center">label: normal</span>
      <span>diantrekan</span>{sel(u.tp, "TP", SERIES[2])}{sel(u.fp, "FP", "#e0a02b")}
      <span>tidak</span>{sel(u.fn, "FN", "#e5484d")}{sel(u.tn, "TN", "#5f6b7a")}
    </div>
  );
}

const URUT_SISTEM = ["v4", "v4_rule", "model_antrean_sama", "v5"];
function Bandingan({ k }: { k: Kinerja }) {
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      {URUT_SISTEM.filter((x) => k.sistem[x]).map((x) => { const u = k.sistem[x]; return (
        <div key={x} className={`rounded-md border p-2.5 ${x === "v5" ? "border-[#199e70]/50" : "border-white/[.08]"} bg-[#151a1f]`}>
          <p className="text-[11px] font-semibold text-white">{u.label}</p>
          <p className="mt-1 text-[11px] text-[#d3d8de]">recall {pct(u.recall)} · precision {pct(u.presisi_mentah)} · FPR {pct(u.fpr, 2)}</p>
          <p className="text-[10.5px] text-[#abb3bf]">TP {u.tp} · FP {u.fp} · FN {u.fn} · antrean {u.antrean}</p>
          <p className="mt-1 text-[10.5px] text-[#abb3bf]">tagihan fraud ditemukan {rp(u.rp.fraud_ditemukan)} · lolos {rp(u.rp.fraud_lolos)} · normal di antrean {rp(u.rp.normal_di_antrean)}</p>
        </div>); })}
    </div>
  );
}

function Kesal({ k }: { k: Kesalahan }) {
    const mx = Math.max(1, ...k.tema.map((t) => t.fraud));
    return (
      <div className="space-y-1.5">
        {k.tema.slice(0, 10).map((t) => (
          <div key={t.kode} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 200px) minmax(0, 1fr) minmax(0, 260px)" }}>
            <span className="truncate text-[11px] text-[#d3d8de]">{t.nama}</span>
            <div className="flex h-3.5 gap-px" style={{ width: `${(100 * t.fraud) / mx}%` }} title={`${t.tertangkap} tertangkap · ${t.tidak_masuk_ragu} tidak masuk zona ragu · ${t.dibersihkan_swarm} dibersihkan swarm`}>
              {t.tertangkap > 0 && <span className="rounded-l" style={{ flex: t.tertangkap, background: SERIES[2] }} />}
              {t.tidak_masuk_ragu > 0 && <span style={{ flex: t.tidak_masuk_ragu, background: "#e5484d" }} />}
              {t.dibersihkan_swarm > 0 && <span className="rounded-r" style={{ flex: t.dibersihkan_swarm, background: "#e0a02b" }} />}
            </div>
            <span className="truncate text-[10.5px] text-[#abb3bf]">lolos terbanyak: {t.skema_lolos.slice(0, 3).map((s) => `${s.skema.replace(/_/g, " ")} (${s.n})`).join(", ") || "—"}</span>
          </div>
        ))}
        <p className="flex flex-wrap gap-3 pt-1 text-[10px] text-[#8f99a8]">
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: SERIES[2] }} />masuk antrean</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#e5484d]" />tidak masuk zona ragu (model & rule tidak curiga)</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#e0a02b]" />dibersihkan swarm</span></p>
      </div>
    );
  }

const ZONA_RIIL = ["TAHAN", "RAGU", "LOLOS"] as const;

function LampiranRiil({ kc, batch }: { kc: Riil; batch?: Lampiran }) {
  const nas = batch?.riil_nasional, d = batch?.desain;
  const pct = (a: number, b: number) => `${id((100 * a) / Math.max(1, b), a && (100 * a) / Math.max(1, b) < 1 ? 2 : 1)}%`;
  const zona = (r: Riil, judul: string) => (
    <div className="space-y-1">
      <p className="text-[11px] text-[#abb3bf]">{judul} · {id(r.klaim)} klaim · rule menyala di {id(r.rule)}</p>
      <div className="flex flex-wrap gap-1.5">
        {ZONA_RIIL.map((z) => <Chip key={z}>{z} {id(r.zona[z] ?? 0)} ({pct(r.zona[z] ?? 0, r.klaim)})</Chip>)}
        {r.swarm.dibaca > 0 && <Chip warna="#7ee2c0">swarm membaca {id(r.swarm.dibaca)}: PERIKSA {id(r.swarm.periksa)} · dibersihkan {id(r.swarm.dibersihkan)}</Chip>}
        {r.ragu_belum_dibaca > 0 && <Chip garis>RAGU belum dibaca swarm {id(r.ragu_belum_dibaca)} (di luar KC ini)</Chip>}
      </div>
    </div>);
  const proksi = (p: HitungRiil | undefined, judul: string, basis?: Riil) => p && (
    <div className="space-y-1">
      <p className="text-[11px] text-[#abb3bf]">{judul}: {id(p.n)} klaim</p>
      {p.n > 0 && <div className="flex flex-wrap gap-1.5">
        {ZONA_RIIL.map((z) => <Chip key={z} warna={z !== "LOLOS" && (p.zona[z] ?? 0) > 0 ? "#f0c661" : undefined}>{z} {id(p.zona[z] ?? 0)} ({pct(p.zona[z] ?? 0, p.n)})</Chip>)}
        {p.swarm.dibaca > 0 && <Chip>swarm: PERIKSA {id(p.swarm.periksa)} · dibersihkan {id(p.swarm.dibersihkan)}</Chip>}
        {basis && <Chip garis>pembanding: semua klaim RAGU {pct(basis.zona.RAGU ?? 0, basis.klaim)}</Chip>}
      </div>}
    </div>);
  return (
    <details className="rounded-lg border border-dashed border-white/20 bg-[#151a1f]">
      <summary className="cursor-pointer list-none px-4 py-3">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#8f99a8]">Lampiran A · bukan bagian laporan audit</p>
        <p className="mt-0.5 text-[14px] font-semibold text-white">Pemeriksaan teknis di data riil (tanpa label fraud)</p>
        <p className="text-[11px] text-[#abb3bf]">Sebaran zona model di KC ini dan nasional, dan ke mana klaim yang dikoreksi verifikator BPJS jatuh (proksi lemah). Klik untuk membuka.</p>
      </summary>
      <div className="space-y-6 border-t border-white/[.06] px-4 py-4">
        <section className="space-y-2">
          <p className="text-[12.5px] font-semibold text-white">A.1 Sebaran zona (model + rule)</p>
          {zona(kc, "KC ini")}
          {nas && zona(nas, "Nasional, jendela yang sama")}
          <p className="text-[10.5px] text-[#8f99a8]">Ambang ML v7 ditetapkan di data dev sintetis (TAHAN pada FPR 0,1%, zona ragu 3%). Di data riil porsinya jauh lebih kecil: skor model di data riil bergeser ke bawah, jadi ambang ini perlu dikalibrasi ulang sebelum dipakai sungguhan.</p>
        </section>
        <section className="space-y-2">
          <p className="text-[12.5px] font-semibold text-white">A.2 Proksi lemah: koreksi verifikator BPJS</p>
          {proksi(kc.koreksi_verifikator, "KC ini · klaim yang biayanya dikoreksi verifikator (flag_selisih_verifikasi)")}
          {proksi(nas?.koreksi_verifikator, "Nasional · klaim yang dikoreksi verifikator", nas)}
          {proksi(kc.calon_klaim_ganda, "KC ini · klaim yang ditandai calon klaim ganda oleh dataset")}
          {proksi(nas?.calon_klaim_ganda, "Nasional · calon klaim ganda", nas)}
          {kc.selisih_rp && kc.selisih_rp.total > 0 && <p className="text-[11px] text-[#abb3bf]">Nilai koreksi verifikator di KC ini {rp(kc.selisih_rp.total)}; yang ada di antrean {rp(kc.selisih_rp.di_antrean)}.</p>}
          <p className="text-[10.5px] text-[#8f99a8]">Koreksi verifikator bukan fraud, dan sebagian besar fraud tidak pernah dikoreksi. Jumlahnya juga sangat kecil (sekitar 0,07% klaim), jadi angka ini bukan recall atau precision.</p>
        </section>
        {d && (
          <section className="space-y-2">
            <p className="text-[12.5px] font-semibold text-white">A.3 Desain</p>
            <div className="grid gap-2 md:grid-cols-3">
              {[["Latih", `${id(d.latih.baris)} klaim · ${id(d.latih.fraud)} fraud`, "data sintetis (generator 1 + 2 + 2-halus): melatih ML v7"],
                ["Ambang", `${id(d.validasi.baris)} klaim · ${id(d.validasi.fraud)} fraud`, d.validasi.untuk],
                ["Uji (batch ini)", `${id(d.uji.klaim)} klaim · tanpa label`, `${d.generator}; ${d.uji.untuk}`]].map(([a, x, c]) => (
                <div key={a} className="rounded-md border border-white/[.08] bg-black/20 px-3 py-2">
                  <p className="text-[11px] font-semibold text-white">{a}</p><p className="text-[12px] tabular-nums text-[#d3d8de]">{x}</p><p className="text-[10.5px] text-[#abb3bf]">{c}</p>
                </div>))}
            </div>
          </section>
        )}
      </div>
    </details>
  );
}

function LampiranTeknis({ kc, batch }: { kc: Lampiran; batch?: Lampiran }) {
  if (kc.riil) return <LampiranRiil kc={kc.riil} batch={batch} />;
  const b = batch?.kinerja, ci = b?.ci_selisih_v5, d = batch?.desain;
  const ciT = (x?: [number, number]) => (x ? `${id(x[0] * 100, 1)} s/d ${id(x[1] * 100, 1)} poin` : "—");
  return (
    <details className="rounded-lg border border-dashed border-white/20 bg-[#151a1f]">
      <summary className="cursor-pointer list-none px-4 py-3">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#8f99a8]">Lampiran A · bukan bagian laporan audit</p>
        <p className="mt-0.5 text-[14px] font-semibold text-white">Evaluasi teknis model (internal, terhadap label fraud sintetis)</p>
        <p className="text-[11px] text-[#abb3bf]">Confusion matrix, perbandingan LightGBM / + rule / + AI Agent Swarm, nilai tagihan, analisis kesalahan per tema, desain validasi. Klik untuk membuka.</p>
      </summary>
      <div className="space-y-6 border-t border-white/[.06] px-4 py-4">
        {kc.kerugian && kc.kerugian.estimasi_rp > 0 && (
          <section className="space-y-2">
            <h4 className="text-[12.5px] font-semibold text-white">Estimasi kerugian terhadap label sintetis</h4>
            <div className="flex flex-wrap gap-1.5">
              <Chip warna="#ffb59a">{id(kc.kerugian.klaim_fraud)} dari {id(kc.kerugian.klaim_antrean)} klaim antrean benar fraud</Chip>
              <Chip warna="#ffb59a">{rp(kc.kerugian.di_klaim_fraud_rp)} dari estimasi {rp(kc.kerugian.estimasi_rp)} ada di klaim fraud ({id(100 * (kc.kerugian.porsi_di_fraud ?? 0), 0)}%)</Chip>
              <Chip>nilai terindikasi di klaim fraud {rp(kc.kerugian.nilai_terindikasi_fraud_rp)} dari {rp(kc.kerugian.nilai_terindikasi_rp)}</Chip>
            </div>
            <p className="text-[11px] text-[#abb3bf]">Angka kerugian di sampul adalah batas atas sebelum verifikasi: sebagian ada di klaim normal yang tagihan atau top-up-nya memang tinggi. Verifikasi kantor cabang yang memisahkannya.</p>
          </section>
        )}
        {d && (
          <section className="space-y-2">
            <p className="text-[12.5px] font-semibold text-white">A.1 Desain validasi</p>
            <div className="grid gap-2 md:grid-cols-3">
              {[["Latih", `${id(d.latih.baris)} klaim · ${id(d.latih.fraud)} fraud`, "generator 1 + data_v4: melatih LightGBM"],
                ["Validasi", `${id(d.validasi.baris)} klaim · ${id(d.validasi.fraud)} fraud`, d.validasi.untuk],
                ["Uji (batch ini)", `${id(d.uji.klaim)} klaim · ${d.uji.fraud === null ? "tanpa label" : `${id(d.uji.fraud)} fraud`}`, `${d.generator}; ${d.uji.untuk}`]].map(([a, x, c]) => (
                <div key={a} className="rounded-md border border-white/[.08] bg-[#1c2127] p-2.5"><p className="text-[11px] font-semibold text-white">{a}</p><p className="text-[11.5px] tabular-nums text-[#d3d8de]">{x}</p><p className="mt-0.5 text-[10.5px] text-[#abb3bf]">{c}</p></div>))}
            </div>
            <p className="text-[11px] text-[#abb3bf]">Batas: semua data sintetis dengan modus yang ditanam; agen membaca fakta dari fitur, bukan dokumen klinis. Kinerja pada klaim BPJS nyata belum terbukti: butuh klaim nyata dengan hasil verifikasi/audit sebagai label.</p>
          </section>
        )}
        {b && (
          <section className="space-y-2">
            <p className="text-[12.5px] font-semibold text-white">A.2 Kontribusi AI Agent Swarm · seluruh batch</p>
            <Bandingan k={b} />
            {ci && (
              <div className="rounded-md border border-[#199e70]/40 bg-[#199e70]/[.06] px-3 py-2 text-[11.5px] text-[#d3d8de]">
                <p className="font-medium text-white">Uji adil: swarm vs filter model dengan antrean sama besar</p>
                <p>Selisih recall v5 − filter model: {ciT(ci.model_antrean_sama?.recall)} (95% CI, bootstrap per peserta). v5 − LightGBM saja: {ciT(ci.v4?.recall)}; precision (fraud 2%) v5 − LightGBM saja: {ciT(ci.v4?.presisi_prev2)}.</p>
                {b.zona_ragu && <p className="text-[#abb3bf]">Zona ragu: {id(b.zona_ragu.klaim)} klaim, {id(b.zona_ragu.fraud)} fraud; AUROC model di zona ini {id(b.zona_ragu.auroc_model, 3)}.</p>}
              </div>
            )}
            <div className="flex flex-wrap items-start gap-6"><div><p className="mb-1 text-[11px] text-[#abb3bf]">Confusion matrix v5 · seluruh batch</p><Matriks u={b.sistem.v5} /></div></div>
          </section>
        )}
        <section className="space-y-2">
          <p className="text-[12.5px] font-semibold text-white">A.3 KC ini</p>
          <div className="flex flex-wrap items-start gap-6"><div><p className="mb-1 text-[11px] text-[#abb3bf]">Confusion matrix v5 · KC ini</p><Matriks u={kc.kinerja.sistem.v5} /></div></div>
          <Bandingan k={kc.kinerja} />
          <p className="text-[10.5px] text-[#8f99a8]">Sampel per KC kecil: angka KC berfluktuasi; gunakan angka seluruh batch (A.2) untuk menilai model.</p>
        </section>
        {batch && (
          <section className="space-y-2">
            <p className="text-[12.5px] font-semibold text-white">A.4 Di mana fraud lolos · per tema (seluruh batch)</p>
            <Kesal k={batch.kesalahan} />
            <p className="text-[11px] text-[#abb3bf]">Merah = model dan rule tidak curiga, klaim tidak pernah sampai ke swarm: perbaikan di model/rule (fitur, ambang zona ragu). Kuning = swarm keliru membersihkan: perbaikan di prompt/berkas agen.</p>
          </section>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- the case files per hospital (the national report's "Berkas kasus per faskes")
// LaporanLengkap's openFile (the hospital table, the map) opens `berkas-<id>`; one not in the page (the theme view) is asked for with this event
const BUKA_RS = "buka-berkas-faskes";
const BUKA_TEMA = "cabang-buka-tema";
const STRENGTH_W: Record<string, string> = { kuat: "#e5484d", sedang: "#fab219", lemah: "#8f99a8" };

// ---------------------------------------------------------------- TSM and the hospital's path (Box Karantina KC)
type DimTsm = (typeof TSM_DIM)[number][0];
const ATURAN_JALUR = "Jalur RS: ditindak bila Terstruktur, Sistematis dan Masif ketiganya terpenuhi; dibina bila minimal satu terpenuhi; dibebaskan bila tidak ada yang terpenuhi.";
/** A TSM dimension as the national case file shows it: "✓ Terstruktur", "◐ Masif", "– Sistematis", coloured by its level. */
function TsmPill({ label, nilai, title }: { label: string; nilai?: string; title?: string }) {
  const c = TSM_COLOR[nilai ?? ""] ?? "#4b5563";
  return (
    <span title={title} className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-medium text-[#e5e8eb]"
      style={{ background: `${c}26`, boxShadow: `inset 0 0 0 1px ${c}66` }}>{TSM_MARK[nilai ?? ""] ?? "·"} {label}</span>
  );
}
const JalurLabel = ({ jalur }: { jalur?: string }) => { const j = JALUR[jalur ?? ""]; return j ? <span style={{ color: j.color }}>{j.label}</span> : null; };
// each dimension's points scale and thresholds, read from the report's own criteria ("Terstruktur (poin 0–4; terpenuhi bila ≥ 3, sebagian bila ≥ 2): …")
type Ambang = { maks?: string; penuh?: string; sebagian?: string; teks: string };
function ambangTsm(kriteria: string[] = []): Partial<Record<DimTsm, Ambang>> {
  return Object.fromEntries(TSM_DIM.flatMap(([d, n]) => {
    const teks = kriteria.find((k) => k.startsWith(`${n} `) || k.startsWith(`${n}:`));
    if (!teks) return [];
    const m = /poin 0\s*[–-]\s*([\d.,]+);\s*terpenuhi bila ≥\s*([\d.,]+),\s*sebagian bila ≥\s*([\d.,]+)/.exec(teks);
    return [[d, { maks: m?.[1], penuh: m?.[2], sebagian: m?.[3], teks }]];
  }));
}
// an evidence sentence split at its top-level semicolons (a list in brackets stays whole), one fact per line
function pecahBukti(s: string): string[] {
  const out: string[] = [];
  let dalam = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") dalam += 1;
    if (ch === ")") dalam = Math.max(0, dalam - 1);
    if (ch === ";" && dalam === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** The hospital's TSM assessment: each dimension's level, points and evidence, and the path rule applied to it. */
function PenilaianTsm({ tsm, jalur, kriteria }: { tsm: Partial<Tsm>; jalur?: string; kriteria?: string[] }) {
  const ambang = ambangTsm(kriteria);
  const aturan = kriteria?.find((k) => k.startsWith("Jalur RS")) ?? ATURAN_JALUR;
  const dims = TSM_DIM.filter(([d]) => tsm[d]);
  const penuh = dims.filter(([d]) => tsm[d]?.nilai === "terpenuhi").map(([, n]) => n);
  const j = JALUR[jalur ?? ""];
  return (
    <div>
      <Judul title="Penilaian TSM">Pola di RS ini · terstruktur, sistematis, masif (TSM)</Judul>
      <div className="mt-1.5 grid gap-2 lg:grid-cols-3">
        {dims.map(([d, n]) => {
          const t = tsm[d]!, a = ambang[d], c = TSM_COLOR[t.nilai] ?? "#4b5563";
          return (
            <div key={d} className="rounded-md border border-white/[.08] bg-black/20 px-3 py-2" style={{ borderLeft: `3px solid ${c}` }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold text-white" title={a?.teks}>{n}</span>
                <TsmPill label={t.nilai} nilai={t.nilai} />
                <span className="ml-auto text-[11px] tabular-nums text-[#d3d8de]" title={a?.teks}>
                  poin {id(t.poin, t.poin % 1 ? 1 : 0)}{a?.maks ? ` dari ${a.maks}` : ""}
                </span>
              </div>
              {a?.penuh && <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">terpenuhi bila poin ≥ {a.penuh}, sebagian bila ≥ {a.sebagian}</p>}
              <ul className="mt-1.5 space-y-0.5">
                {pecahBukti(t.bukti).map((x) => <li key={x} className="flex gap-1.5 text-[11.5px] leading-snug text-[#d3d8de]"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#8f99a8]" />{x}</li>)}
              </ul>
            </div>
          );
        })}
      </div>
      {j && (
        <p className="mt-2 text-[11.5px] leading-snug text-[#d3d8de]">
          RS ini: {penuh.length} dari {dims.length} dimensi terpenuhi{penuh.length ? ` (${penuh.join(", ")})` : ""} → jalur <b style={{ color: j.color }}>{j.label.toLowerCase()}</b>.
          <span className="text-[#8f99a8]"> {aturan}</span>
        </p>
      )}
    </div>
  );
}

function Ubin({ judul, nilai, sub, warna }: { judul: string; nilai: React.ReactNode; sub?: React.ReactNode; warna?: string }) {
  return (
    <div className="rounded-md border border-white/[.08] bg-black/20 px-3 py-2.5" style={warna ? { borderTop: `2px solid ${warna}` } : undefined}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8f99a8]">{judul}</p>
      <p className="mt-0.5 text-[15px] font-semibold leading-snug text-white">{nilai}</p>
      {sub && <p className="mt-0.5 text-[10.5px] leading-snug text-[#abb3bf]">{sub}</p>}
    </div>
  );
}

function BerkasRSCard({ b, kasus, ver, simpan, jar, model, kc, buka, setBuka, tuju, kriteria, artiKelompok }: { b: BerkasRS; kasus: Kasus[]; ver: Record<string, Putusan>;
  simpan: (klaim: string, status: string, catatan: string) => Promise<void>; jar: Jaringan; model: string; kc: string; buka: boolean; setBuka: (v: boolean) => void;
  /** the element asked for (a claim file opened from elsewhere, e.g. a twin in a claim network) */
  tuju?: string;
  /** the Box Karantina KC's thresholds in words (L.box.kriteria) and what each group means (the "box" exhibit) */
  kriteria?: string[]; artiKelompok?: Record<string, string> }) {
  const [bersihTampil, setBersihTampil] = useState(false);
  const antre = kasus.filter((k) => k.keputusan !== "DIBERSIHKAN"), bersih = kasus.filter((k) => k.keputusan === "DIBERSIHKAN");
  // a cleared claim asked for by name is shown without the toggle
  const tampilBersih = bersihTampil || bersih.some((k) => tuju === `klaim-${k.id}`);
  const sudah = antre.filter((k) => ver[k.id]).length;
  const terbukti = antre.filter((k) => ver[k.id]?.status === "terbukti").length;
  // the hospital's claims whose device record does not match the bill (the IoT layer, runs since 2026-11-15)
  const iotTs = kasus.filter((k) => k.iot?.hasil === "tidak_sesuai");
  const iotSelisih = iotTs.reduce((t, k) => t + (k.iot?.tarif?.selisih_rp ?? 0), 0);
  const w = GROUP_COLOR[b.kelompok] ?? "#738091";
  const maxModus = Math.max(1, ...b.modus.map((m) => m.total));
  // the main indication as the claims' own explanations name it; the loss basis (ledger tag) has its own table
  const mk = b.modus_klaim ?? [];
  const nmMk = (m: { kode: string; nama: string }) => `${m.kode && m.kode !== "-" ? `${m.kode} · ` : ""}${m.nama}`;
  const utama = mk[0] ? nmMk(mk[0]) : b.modus_utama.replace(/\s*\(\d+ klaim\)$/, "");
  // the path (reports since 2026-11-14): its colour, and its advice without the path's name repeated in front ("Dibina: …")
  const jl = JALUR[b.jalur ?? ""];
  const saran = jl ? b.saran.replace(new RegExp(`^${jl.label}\\s*:\\s*`, "i"), "").replace(/^./, (c) => c.toUpperCase()) : b.saran;
  const adaTsm = !!b.tsm && TSM_DIM.some(([d]) => b.tsm?.[d]);
  // T, S, M as three small boxes in the row (filled: met; half: partly; grey: not), the levels in words in the tooltip
  const tsmKotak = (
    <span className="flex gap-0.5" title={adaTsm ? `TSM: ${TSM_DIM.map(([d, n]) => `${n} ${b.tsm?.[d]?.nilai ?? "—"}`).join(" · ")} (✓ terpenuhi · ◐ sebagian · – tidak)` : "TSM belum dinilai"}>
      {TSM_DIM.map(([d, n]) => {
        const v = b.tsm?.[d]?.nilai, c = TSM_COLOR[v ?? ""] ?? "#4b5563";
        return <span key={d} className="grid h-5 w-5 place-items-center rounded text-[10px] font-bold"
          style={{ background: v === "terpenuhi" ? c : `${c}2e`, color: v === "terpenuhi" ? "#fff" : v === "sebagian" ? c : "#8f99a8", boxShadow: `inset 0 0 0 1px ${c}88` }}>{n[0]}</span>;
      })}
    </span>
  );
  const utamaSingkat = mk[0] ? `${mk[0].kode && mk[0].kode !== "-" ? `${mk[0].kode} ` : ""}${singkatModus(mk[0].nama)}` : singkatModus(utama);
  return (
    <details id={`berkas-${b.faskes_profil_id}`} open={buka} onToggle={(e) => setBuka(e.currentTarget.open)} className="lp-berkas group scroll-mt-4 rounded-lg border border-white/[.08] bg-[#1c2127]">
      <summary className={`flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2.5 hover:bg-white/[.03] ${KOLOM_RS}`}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[12px] font-bold text-[#111418]" style={{ background: w }}
          title={`kelompok ${b.kelompok} Box Karantina${artiKelompok?.[b.kelompok] ? `: ${artiKelompok[b.kelompok]}` : ""}`}>{b.kelompok}</span>
        <span className="min-w-0 flex-[1_1_14rem]">
          <span className="block truncate text-[13px] font-semibold text-white" title={`${b.nama} · ${b.kabkota} · ${b.tipe} · ${b.kepemilikan || b.jenis}`}>{b.nama}</span>
          <span className="block truncate text-[11px] text-[#8f99a8]">jenis fraud utama: <span className="text-[#d3d8de]">{utamaSingkat}</span>
            {iotTs.length > 0 && <span className="text-[#ff9db3]" title="IoT: sensor arus pada kabel daya alat medis"> · ✕ IoT {iotTs.length} tidak cocok</span>}</span>
        </span>
        <span className="text-[12px] tabular-nums text-[#f0c661]" title="klaim perlu dicek · di antaranya ditahan">{b.rekomendasi} klaim
          <span className="block text-[10.5px] text-[#8f99a8]">{b.tahan} ditahan</span></span>
        {tsmKotak}
        <span>{jl ? <span title={`${saran} (${ATURAN_JALUR})`}><Chip warna={jl.color}>{jl.label.toLowerCase()}</Chip></span> : <span className="text-[11px] text-[#8f99a8]">—</span>}</span>
        <span className="text-[11px] tabular-nums">{sudah ? <span style={{ color: terbukti ? "#ff8a8d" : "#7ee2c0" }}>{sudah}/{antre.length} dicek{terbukti ? ` · ${terbukti} terbukti` : ""}</span>
          : <span className="text-[#8f99a8]">belum dicek</span>}</span>
        <span className="text-right text-[13px] font-semibold tabular-nums text-white" title="estimasi kerugian">{rp(b.estimasi_kerugian_rp)}</span>
        <Icon name="down" className="h-3.5 w-3.5 text-[#8f99a8] transition group-open:rotate-180" />
      </summary>
      {buka && (
        <div className="space-y-5 border-t border-white/[.06] px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Ubin judul="Estimasi kerugian" nilai={rp(b.estimasi_kerugian_rp)} sub={`${id(100 * b.porsi_kerugian, 1)}% dari estimasi KC · tagihan RS ${rp(b.tagihan_rp)}`} warna="#ffb59a" />
            <Ubin judul="Klaim perlu dicek" nilai={`${b.rekomendasi} dari ${id(b.klaim)}`} sub={`${id((1000 * b.rekomendasi) / Math.max(1, b.klaim), 1)} per 1.000 klaim · ${b.bertag} klaim bertag`} warna="#f0c661" />
            <Ubin judul="Indikasi utama" nilai={utama} warna="#e5484d"
              sub={mk[0] ? `${mk[0].klaim} dari ${b.rekomendasi} klaim menurut penjelasan klaim${mk.length > 1 ? ` · ${mk.length - 1} modus lain` : ""}`
                : b.rugi_modus[0] ? `${b.rugi_modus[0].klaim} klaim · ${rp(b.rugi_modus[0].estimasi_kerugian_rp)}` : undefined} />
            {jl
              ? <Ubin judul="Jalur RS" nilai={<JalurLabel jalur={b.jalur} />} sub={saran} warna={jl.color} />
              : <Ubin judul="Rekomendasi" nilai={b.saran} sub={`nilai terindikasi ${rp(b.nilai_terindikasi_rp)}`} warna={w} />}
          </div>
          {iotTs.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 rounded-md border border-[#ff7d9c]/30 bg-[#ff7d9c]/[.06] px-3 py-2 text-[12px]">
              <b className="text-[#ff9db3]">✕ Bukti IoT: {iotTs.length} klaim tidak sesuai</b>
              <span className="text-[#d3d8de]">· pemakaian alat (sensor arus) tidak cocok dengan yang ditagih{iotSelisih ? ` · selisih tarif ${rp(iotSelisih)}` : ""}</span>
              {iotTs.slice(0, 6).map((k) => (
                <button key={k.id} onClick={() => bukaBerkas(k.id)} title={k.iot?.judul} className="lp-no-print rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10.5px] text-white hover:bg-white/5">{k.id}</button>))}
              {iotTs.length > 6 && <span className="text-[10.5px] text-[#8f99a8]">+{iotTs.length - 6} lagi</span>}
            </p>
          )}
          {adaTsm && b.tsm && <PenilaianTsm tsm={b.tsm} jalur={b.jalur} kriteria={kriteria} />}
          <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
            <div className="space-y-4">
              <div>
                <Judul>Temuan tingkat RS</Judul>
                <ul className="mt-1.5 space-y-1">{[...(mk.length ? [`Indikasi menurut penjelasan tiap klaim: ${mk.map((m) => `${nmMk(m)} (${m.klaim} klaim)`).join(", ")}.`] : []), ...b.temuan].map((t) => (
                  <li key={t} className="flex gap-2 text-[12px] leading-snug text-[#d3d8de]"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#fab219]" />{t}</li>))}</ul>
              </div>
              <div>
                <Judul title="per dasar taksiran (tag buku besar)">Estimasi kerugian per modus</Judul>
                <table className="mt-1.5 w-full text-[11.5px]">
                  <tbody>
                    {b.rugi_modus.map((m) => (
                      <tr key={m.label} className="border-t border-white/[.05]">
                        <td className="py-1 text-[#d3d8de]">{m.label}</td><td className="py-1 text-right tabular-nums text-[#abb3bf]">{m.klaim} klaim</td>
                        <td className="py-1 text-right tabular-nums text-white">{rp(m.estimasi_kerugian_rp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <Judul>Profil RS</Judul>
                <dl className="mt-1.5 text-[11.5px]">
                  {([["Kelas · jenis", `${b.tipe} · ${b.jenis}`], ["Kepemilikan", b.kepemilikan || "—"], ["Kab/kota", b.kabkota], ["Klaim dianalisis", id(b.klaim)],
                    ["Klaim bertag · direkomendasikan", `${b.bertag} · ${b.rekomendasi}`], ["Ditahan · diperiksa", `${b.tahan} · ${b.periksa}`], ["Total tagihan", rp(b.tagihan_rp)], ["Nilai klaim terindikasi", rp(b.nilai_terindikasi_rp)],
                    ["Koordinat (sintetis)", b.koordinat ? `${id(b.koordinat.lat, 3)}, ${id(b.koordinat.lon, 3)}` : "—"]] as const).map(([a, v]) => (
                    <div key={a} className="flex justify-between gap-3 border-t border-white/[.05] py-1"><dt className="text-[#abb3bf]">{a}</dt><dd className="text-right tabular-nums text-white">{v}</dd></div>
                  ))}
                </dl>
              </div>
              <div>
                <Judul title="Modus indikasi · tag aturan dan model, menurut kekuatan">Tanda yang ditemukan · dari aturan dan model</Judul>
                <div className="mt-1.5 space-y-1">
                  {b.modus.slice(0, 8).map((m) => (
                    <div key={m.modus} className="grid items-center gap-2 text-[11.5px]" style={{ gridTemplateColumns: "minmax(0,1fr) 110px 44px" }}
                      title={`${m.kuat} kuat · ${m.sedang} sedang · ${m.lemah} lemah`}>
                      <span className="truncate text-[#d3d8de]">{m.modus}</span>
                      <span className="flex h-[8px] gap-px overflow-hidden rounded-sm bg-[#2c333b]">
                        {(["kuat", "sedang", "lemah"] as const).filter((x) => m[x] > 0).map((x) => <span key={x} style={{ width: `${(100 * m[x]) / maxModus}%`, background: STRENGTH_W[x] }} />)}
                      </span>
                      <span className="text-right tabular-nums text-[#abb3bf]">{m.total} tag</span>
                    </div>
                  ))}
                  <p className="flex gap-3 pt-0.5 text-[10px] text-[#8f99a8]">{(["kuat", "sedang", "lemah"] as const).map((x) => <span key={x} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: STRENGTH_W[x] }} />{x}</span>)}</p>
                </div>
              </div>
            </div>
          </div>
          <KlaimRS antre={antre} ver={ver} simpan={simpan} jar={jar} model={model} kc={kc} tuju={tuju}>
            {bersih.length > 0 && (tampilBersih
              ? bersih.map((k) => <BerkasKlaim key={k.id} k={k} put={ver[k.id]} simpan={simpan} jar={jar} model={model} kc={kc} />)
              : <button onClick={() => setBersihTampil(true)} className="lp-no-print rounded border border-white/10 px-2 py-1 text-[11px] text-[#d3d8de] hover:bg-white/5">Tampilkan {bersih.length} klaim RS ini yang dibersihkan tim AI</button>)}
          </KlaimRS>
        </div>
      )}
    </details>
  );
}

type GrupModus = { m: ModusKlaim; kasus: Kasus[]; rp: number };
/** A hospital's claims to check, the national audit's way: what they share and their fraud types (chips that filter the list) said
 *  once above; one line per claim; the evidence below, grouped per fraud type, each text once with the claims it is about (a line
 *  lights up its claims). */
function KlaimRS({ antre, ver, simpan, jar, model, kc, tuju, children }: { antre: Kasus[]; ver: Record<string, Putusan>;
  simpan: (klaim: string, status: string, catatan: string) => Promise<void>; jar: Jaringan; model: string; kc: string; tuju?: string; children?: React.ReactNode }) {
  const [pilih, setPilih] = useState<string | null>(null);
  const [sorot, setSorot] = useState<string[]>([]);
  const grup = new Map<string, GrupModus>();
  for (const k of antre) {
    const m = modusKlaim(k, jar), g = grup.get(kunciModus(m)) ?? { m, kasus: [], rp: 0 };
    g.kasus.push(k); g.rp += k.estimasi_kerugian_rp ?? 0; grup.set(kunciModus(m), g);
  }
  const urut = [...grup.entries()].sort((a, b) => b[1].rp - a[1].rp || b[1].kasus.length - a[1].kasus.length);
  // a claim asked for by name is shown whatever the chip chosen
  const aktif = pilih && !(tuju && antre.some((k) => tuju === `klaim-${k.id}` && kunciModus(modusKlaim(k, jar)) !== pilih)) ? pilih : null;
  const tampil = aktif ? antre.filter((k) => kunciModus(modusKlaim(k, jar)) === aktif) : antre;
  const sama1 = <T,>(f: (k: Kasus) => T) => (antre.length > 1 && antre.every((k) => f(k) === f(antre[0])) ? f(antre[0]) : undefined);
  const tingkat = sama1((k) => k.tingkat);
  const sama = [tingkat === "RITL" ? "rawat inap" : tingkat === "RJTL" ? "rawat jalan" : null, sama1((k) => k.tema_nama), sama1((k) => k.inacbg)].filter(Boolean);
  const rmeN = antre.filter((k) => (k.temuan_aturan ?? []).some((x) => x.sumber === "rme")).length;
  const iotN = antre.filter((k) => k.iot?.hasil === "tidak_sesuai").length;
  const total = antre.reduce((t, k) => t + (k.estimasi_kerugian_rp ?? 0), 0), tagih = antre.reduce((t, k) => t + k.biaya_rp, 0);
  return (
    <div className="space-y-2.5">
      <Judul>Klaim perlu dicek · {antre.length} · klik satu klaim untuk penjelasan, bukti dan jaringan klaimnya</Judul>
      {antre.length > 0 && (
        <div className="space-y-1.5 rounded border border-white/5 bg-black/20 px-3 py-2 text-[11.5px]">
          {sama.length > 0 && <p className="text-[#c5cbd3]"><span className="text-[#8f99a8]">Sama di {antre.length} klaim:</span> {sama.join(" · ")}</p>}
          <p className="text-[#c5cbd3]"><span className="text-[#8f99a8]">Estimasi kerugian:</span> <b className="tabular-nums text-white">{rp(total)}</b> dari tagihan {rp(tagih)}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[#8f99a8]">Jenis fraud:</span>
            {urut.map(([key, g]) => (
              <button key={key} onClick={() => setPilih((x) => (x === key ? null : key))} aria-pressed={aktif === key} title="klik untuk menampilkan klaim jenis ini saja"
                className={`rounded ${aktif === key ? "bg-[#9d8cff]/15 ring-1 ring-[#9d8cff]" : aktif ? "opacity-50 hover:opacity-100" : "hover:bg-white/5"}`}><ChipModus m={g.m} n={g.kasus.length} /></button>
            ))}
            {aktif && <button onClick={() => setPilih(null)} className="lp-no-print text-[11px] text-[#9d8cff] hover:text-white">tampilkan semua</button>}
          </div>
          {(rmeN > 0 || iotN > 0) && (
            <p className="flex flex-wrap gap-x-3 text-[#c5cbd3]"><span className="text-[#8f99a8]">Bukti tambahan:</span>
              {rmeN > 0 && <span><b className="text-[#9fbaff]">RM</b> rekam medis tidak cocok · {rmeN} klaim</span>}
              {iotN > 0 && <span><b className="text-[#ff9db3]">✕ IoT</b> pemakaian alat medis tidak cocok · {iotN} klaim</span>}</p>
          )}
        </div>
      )}
      <div className="space-y-1">
        <KepalaKlaim />
        {tampil.map((k) => <BerkasKlaim key={k.id} k={k} put={ver[k.id]} simpan={simpan} jar={jar} model={model} kc={kc} sorot={sorot.includes(k.id)} />)}
        {children}
      </div>
      <BuktiPerJenis grup={aktif ? urut.filter(([key]) => key === aktif) : urut} setSorot={setSorot} jar={jar} />
    </div>
  );
}

// a line's confidence (the explanation's "keyakinan") as its dot, as the national audit's strength dots
const WARNA_YAKIN: Record<string, string> = { tinggi: "#e5484d", sedang: "#fab219", rendah: "#8f99a8" };
/** The evidence per fraud type, as the national audit's "Bukti per indikasi": every claim's own sentence of evidence for its type
 *  (from its explanation; a claim without one: its device verdict, medical-record finding or loss basis), each text once with the
 *  claims it is about and its confidence; hovering a line lights its claims in the list, clicking an ID opens that claim. */
function BuktiPerJenis({ grup, setSorot, jar }: { grup: [string, GrupModus][]; setSorot: (x: string[]) => void; jar: Jaringan }) {
  const [semua, setSemua] = useState<Record<string, boolean>>({});
  if (!grup.length) return null;
  return (
    <div className="space-y-3 pt-1">
      <Judul>Bukti per jenis fraud</Judul>
      {grup.map(([key, g]) => {
        const baris = new Map<string, { teks: string; yakin: string; klaim: string[] }>();
        for (const k of g.kasus) {
          const r = jar.data?.kasus[k.id], rmeT = (k.temuan_aturan ?? []).find((f) => f.sumber === "rme")?.teks;
          const teks = (r?.bukti || (k.iot?.hasil === "tidak_sesuai" ? k.iot.judul : "") || rmeT || (k.dasar_kerugian ? `dasar estimasi: ${k.dasar_kerugian}` : "")).trim();
          if (!teks) continue;
          const yakin = r?.keyakinan ?? "", b = baris.get(`${yakin}|${teks}`) ?? { teks, yakin, klaim: [] };
          b.klaim.push(k.id);
          baris.set(`${yakin}|${teks}`, b);
        }
        const nilai: Record<string, number> = { tinggi: 3, sedang: 2, rendah: 1 };
        const ls = [...baris.values()].sort((a, b) => (nilai[b.yakin] ?? 0) - (nilai[a.yakin] ?? 0) || b.klaim.length - a.klaim.length);
        const n = semua[key] ? ls.length : 5;
        return (
          <div key={key}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]"><ChipModus m={g.m} />
              <span className="text-[#8f99a8]">{g.m.nama} · {g.kasus.length} klaim · estimasi {rp(g.rp)}</span></p>
            <ul className="mt-1 space-y-0.5">
              {ls.slice(0, n).map((l, j) => (
                <li key={j} onMouseEnter={() => setSorot(l.klaim)} onMouseLeave={() => setSorot([])}
                  className="grid grid-cols-[auto_1fr] gap-x-2 rounded px-1.5 py-1 text-[11.5px] leading-snug hover:bg-[#9d8cff]/10">
                  <span className="mt-[5px] h-2 w-2 rounded-full" title={l.yakin ? `keyakinan ${l.yakin}` : undefined} style={{ background: WARNA_YAKIN[l.yakin] ?? "#8f99a8" }} />
                  <span className="min-w-0">
                    {l.klaim.slice(0, 4).map((x) => <button key={x} onClick={() => bukaBerkas(x)} className="mr-1.5 font-mono text-[10.5px] text-[#c9c0ff] hover:text-white">{x}</button>)}
                    {l.klaim.length > 4 && <span className="mr-1.5 text-[10.5px] text-[#8f99a8]">+{l.klaim.length - 4} klaim</span>}
                    <span className="text-[#c5cbd3]">{l.teks}</span>
                    {l.yakin && <span className="ml-1.5 whitespace-nowrap text-[10.5px] text-[#8f99a8]">keyakinan {l.yakin}</span>}
                  </span>
                </li>
              ))}
              {ls.length > 5 && (
                <li><button onClick={() => setSemua((x) => ({ ...x, [key]: !x[key] }))} className="lp-no-print px-1.5 text-[10.5px] text-[#9d8cff] hover:text-white">
                  {semua[key] ? "ringkas" : `tampilkan ${ls.length - 5} bukti lain`}</button></li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

type Saring = "semua" | "ditindak" | "dibina" | "dibebaskan";
const PER_HALAMAN = 10;

function BerkasPerRS({ L, ver, simpan, jar, model }: { L: Laporan; ver: Record<string, Putusan>; simpan: (klaim: string, status: string, catatan: string) => Promise<void>; jar: Jaringan; model: string }) {
  const [mode, setMode] = useState<"rs" | "tema">("rs");
  const [saring, setSaring] = useState<Saring>("semua");
  const [cari, setCari] = useState("");
  const [n, setN] = useState(PER_HALAMAN);
  const [buka, setBuka] = useState<Record<string, boolean>>({});
  const [tuju, setTuju] = useState<{ el: string; n: number } | null>(null);
  const berkas = useMemo(() => L.berkas_rs ?? [], [L]);
  const kasusRS = useMemo(() => {
    const byId = Object.fromEntries(L.kasus.map((k) => [k.id, k]));
    return Object.fromEntries(berkas.map((b) => [b.faskes_profil_id, b.kasus.map((x) => byId[x]).filter(Boolean)]));
  }, [L, berkas]);
  const rsOf = useMemo(() => Object.fromEntries(berkas.flatMap((b) => b.kasus.map((x) => [x, b.faskes_profil_id]))), [berkas]);
  const kasusTema = useMemo(() => {
    const m: Record<string, Kasus[]> = {};
    for (const k of L.kasus) (m[k.tema] ??= []).push(k);
    return m;
  }, [L]);
  useEffect(() => {
    // a hospital asked for (the map, an exhibit, a claim of it) is shown whatever the filter and page
    const tampilkan = (f: string) => { const i = berkas.findIndex((b) => b.faskes_profil_id === f); setSaring("semua"); setCari(""); if (i >= 0) setN((x) => Math.max(x, i + 1)); };
    const hRs = (e: Event) => { const f = (e as CustomEvent<string>).detail; setMode("rs"); tampilkan(f); setBuka((b) => ({ ...b, [f]: true })); setTuju({ el: `berkas-${f}`, n: Date.now() }); };
    const hKlaim = (e: Event) => {
      if (mode === "tema") return;  // the theme view's own lists answer it
      const x = (e as CustomEvent<string>).detail, f = rsOf[x];
      if (f) { tampilkan(f); setBuka((b) => ({ ...b, [f]: true })); setTuju({ el: `klaim-${x}`, n: Date.now() }); return; }
      // a claim of a hospital without recommendations (cleared by the swarm): only in the theme view
      setMode("tema");
      setTimeout(() => window.dispatchEvent(new CustomEvent<string>(BUKA_BERKAS, { detail: x })), 80);
    };
    const hTema = (e: Event) => { setMode("tema"); setTuju({ el: `kasus-tema-${(e as CustomEvent<string>).detail}`, n: Date.now() }); };
    window.addEventListener(BUKA_RS, hRs); window.addEventListener(BUKA_BERKAS, hKlaim); window.addEventListener(BUKA_TEMA, hTema);
    return () => { window.removeEventListener(BUKA_RS, hRs); window.removeEventListener(BUKA_BERKAS, hKlaim); window.removeEventListener(BUKA_TEMA, hTema); };
  }, [rsOf, mode, berkas]);
  useEffect(() => {
    if (!tuju) return;
    const t = setTimeout(() => {  // after the hospital's file has drawn its claims
      const el = document.getElementById(tuju.el);
      if (el) bukaLeluhur(el);
      if (el instanceof HTMLDetailsElement) el.open = true;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => clearTimeout(t);
  }, [tuju]);
  const temaAktif = L.tema.filter((t) => kasusTema[t.kode]?.length);
  // what each Box group means, in the "box" exhibit's own words (reports since 2026-11-14)
  const artiKelompok = useMemo(() => Object.fromEntries((L.exhibit.find((e) => e.id === "box")?.baris ?? []).map((r) => [String(r.kelompok), String(r.arti ?? "")])), [L]);
  const adaJalur = berkas.some((b) => b.jalur);
  const hitung: Record<Saring, number> = { semua: berkas.length, ditindak: 0, dibina: 0, dibebaskan: 0 };
  for (const b of berkas) if (b.jalur && b.jalur in hitung) hitung[b.jalur as Saring] += 1;
  const q = cari.trim().toLowerCase();
  const lolos = berkas.filter((b) => (saring === "semua" || b.jalur === saring) && (!q || `${b.nama} ${b.kabkota}`.toLowerCase().includes(q)));
  const tampilRs = lolos.slice(0, n);
  return (
    <div className="mt-4 space-y-3">
      <div className="lp-no-print flex flex-wrap items-center gap-2">
        <div className="flex rounded border border-white/10 p-0.5 text-[11px]">
          {([["rs", `Per RS (${berkas.length})`, undefined], ["tema", `Per kelompok penyakit (${temaAktif.length})`, "tema klinis: bab ICD-10 diagnosis utama"]] as const).map(([m, t, title]) => (
            <button key={m} title={title} onClick={() => setMode(m)} className={`rounded-sm px-2.5 py-1 ${mode === m ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>{t}</button>
          ))}
        </div>
        <span className="text-[10.5px] text-[#8f99a8]">{mode === "rs" ? "Satu baris per RS, urut estimasi kerugian; klik RS untuk ringkasan dan daftar klaimnya." : "Klaim dikelompokkan per kelompok penyakit (tema klinis), urut prioritas."}</span>
      </div>
      {mode === "rs" ? (
        <>
          <div className="lp-no-print flex flex-wrap items-center gap-2">
            {adaJalur && (
              <div className="flex flex-wrap rounded border border-white/10 p-0.5 text-[11px]" role="group" aria-label="Saring RS menurut jalur">
                {(["semua", "ditindak", "dibina", "dibebaskan"] as const).filter((x) => x === "semua" || hitung[x] > 0).map((x) => (
                  <button key={x} onClick={() => { setSaring(x); setN(PER_HALAMAN); }} aria-pressed={saring === x}
                    className={`rounded-sm px-2.5 py-1 ${saring === x ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
                    {x === "semua" ? "Semua" : JALUR[x]?.label ?? x} <span className="tabular-nums text-[#8f99a8]">{hitung[x]}</span></button>
                ))}
              </div>
            )}
            <input value={cari} onChange={(e) => { setCari(e.target.value); setN(PER_HALAMAN); }} placeholder="Cari RS atau kab/kota" aria-label="Cari RS"
              className="w-56 rounded border border-white/10 bg-black/20 px-2 py-1 text-[11.5px] text-white placeholder:text-[#6f7a87] focus:border-[#9d8cff]/60 focus:outline-none" />
          </div>
          <div className={`${KEPALA} ${KOLOM_RS}`} title="TSM: T = terstruktur, S = sistematis, M = masif">
            <span>Kel.</span><span>Rumah sakit</span><span>Perlu dicek</span><span>TSM</span><span>Jalur</span><span>Verifikasi</span><span className="text-right">Estimasi rugi</span><span />
          </div>
          <div className="space-y-1.5">
            {tampilRs.map((b) => <BerkasRSCard key={b.faskes_profil_id} b={b} kasus={kasusRS[b.faskes_profil_id] ?? []} ver={ver} simpan={simpan} jar={jar} model={model} kc={L.kc.id}
              buka={!!buka[b.faskes_profil_id]} setBuka={(v) => setBuka((x) => (x[b.faskes_profil_id] === v ? x : { ...x, [b.faskes_profil_id]: v }))} tuju={tuju?.el}
              kriteria={L.box?.kriteria} artiKelompok={artiKelompok} />)}
          </div>
          {!lolos.length && <p className="text-[11.5px] text-[#8f99a8]">Tidak ada RS yang cocok dengan saringan ini.</p>}
          {lolos.length > tampilRs.length && (
            <div className="lp-no-print flex flex-wrap items-center gap-2 text-[11px]">
              <button onClick={() => setN((x) => x + PER_HALAMAN)} className="rounded border border-white/10 px-2.5 py-1 text-[#d3d8de] hover:bg-white/5">
                Tampilkan {Math.min(PER_HALAMAN, lolos.length - tampilRs.length)} RS lagi</button>
              <button onClick={() => setN(lolos.length)} className="rounded px-2 py-1 text-[#9d8cff] hover:text-white">Tampilkan semua ({lolos.length})</button>
              <span className="text-[#8f99a8]">{tampilRs.length} dari {lolos.length} RS</span>
            </div>
          )}
        </>
      ) : temaAktif.map((t) => (
          <section key={t.kode} id={`kasus-tema-${t.kode}`} className="scroll-mt-4 rounded-lg border border-white/[.06] bg-black/10 p-3">
            <p className="text-[13px] font-semibold text-white">{t.nama}</p>
            <p className="text-[11px] text-[#abb3bf]">{t.tahan + t.periksa} klaim perlu dicek ({t.tahan} ditahan, {t.periksa} diperiksa) dari {id(t.klaim)} klaim · {rp(t.nilai_antrean_rp)} · {t.dibersihkan} dibersihkan tim AI</p>
            <DaftarKasus kasus={kasusTema[t.kode]} ver={ver} simpan={simpan} jar={jar} model={model} kc={L.kc.id} />
          </section>
        ))}
    </div>
  );
}

function Metode({ L }: { L: Laporan }) {
  const s = L.sampul;
  return (
    <ul className="mt-3 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-[#d3d8de]">
      <li>{s.model ?? "Model v4"} (LightGBM × 3 seed, fitur graph + mekanisme) dan rule engine menilai setiap klaim. Skor sangat tinggi langsung TAHAN; skor menengah atau rule yang menyala = RAGU.</li>
      <li>Fitur graph: tiap klaim dibandingkan dengan klaim yang diterima lebih dulu dengan peserta, RS, RS + kode INA-CBG, atau kode yang sama; jaringan itu tampil di tiap berkas klaim.</li>
      <li>Klaim RAGU dibaca AI Agent Swarm: spesialis koding & klinis, tagihan, serta episode & jaringan bekerja paralel; hakim menimbang bukti mereka dan memberi skor risiko. Ambang dipilih di data validasi, lalu dibekukan.</li>
      <li>Agen hanya membaca fakta yang diturunkan dari fitur klaim (tanpa skor model). Narasi exhibit ditulis agen penulis; kalimat yang angkanya tidak ada di fakta exhibit dibuang kode.</li>
      {L.box
        ? <li>Box Karantina KC: setiap RS dengan minimal satu tag indikasi ({id(L.box.rs)} dari {id(L.box.rs_klaim)} RS, estimasi kerugian {rp(L.box.estimasi_kerugian_rp)}). Kelompok mengikuti pita Box Karantina nasional atas porsi kumulatif estimasi kerugian: A = 50% pertama, B sampai 80%, C sampai 95%, D sampai 99%, Z sisanya atau tanpa kerugian. Koordinat RS di peta sintetis (titik di dalam kab/kota-nya), karena data klaim tidak memuat alamat.</li>
        : <li>Kelompok RS (A, B, C) mengikuti Box Karantina nasional: porsi kumulatif estimasi kerugian sampai 50% dan 80%. Koordinat RS di peta sintetis (titik di dalam kab/kota-nya), karena data klaim tidak memuat alamat.</li>}
      {(L.box?.kriteria ?? []).map((c) => <li key={c}>{c}</li>)}
      <li>Sistem menandai klaim untuk diperiksa; keputusan (terbukti bermasalah / sesuai / perlu investigasi) tetap di tangan verifikator kantor cabang.</li>
      {L.catatan.map((c) => <li key={c}>{c}</li>)}
    </ul>
  );
}

// ---------------------------------------------------------------- the IoT chapter's summary strip (L.iot, above its exhibits)
function RingkasIot({ r, kasus }: { r: IotRingkas; kasus: Kasus[] }) {
  const ts = kasus.filter((k) => k.iot?.hasil === "tidak_sesuai");
  return (
    <div className="mt-4 space-y-2 rounded-md border border-[#38bdf8]/25 bg-[#38bdf8]/[.05] px-3 py-2.5">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8f99a8]">Verifikasi IoT alat medis · sensor arus pada kabel daya</p>
      <div className="flex flex-wrap gap-1.5">
        <Chip warna="#c5cbd3">RS dengan IoT: {id(r.rs_dengan_iot)}</Chip>
        <Chip warna="#c5cbd3">alat: {id(r.alat)}</Chip>
        <Chip warna="#c5cbd3">klaim dengan alat: {id(r.klaim_dengan_alat)}</Chip>
        <Chip warna="#7ee2c0">✓ sesuai: {id(r.sesuai)}</Chip>
        <Chip warna="#ff8a8d">✕ tidak sesuai: {id(r.tidak_sesuai)}</Chip>
        {r.tanpa_bukti > 0 && <Chip garis>– tanpa bukti: {id(r.tanpa_bukti)}</Chip>}
        <Chip warna="#ffb59a">selisih tarif {rp(r.selisih_rp)}</Chip>
      </div>
      {(r.aturan ?? []).length > 0 && (
        <ul className="space-y-0.5">
          {r.aturan!.map((a) => (
            <li key={a.aturan} className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
              <span className="text-[#d3d8de]">{a.judul}</span>
              <span className="tabular-nums text-[#abb3bf]">{id(a.klaim)} klaim{a.selisih_rp ? ` · selisih ${rp(a.selisih_rp)}` : ""}</span>
            </li>))}
        </ul>
      )}
      {ts.length > 0 && (
        <div className="lp-no-print flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-[#abb3bf]">Klaim tidak sesuai (buka berkas, tab IoT alat medis):</span>
          {ts.slice(0, 12).map((k) => (
            <button key={k.id} onClick={() => bukaBerkas(k.id)} title={k.iot?.judul} className="rounded border border-[#ff8a8d]/40 px-1.5 py-0.5 font-mono text-[10.5px] text-[#ffc2cf] hover:bg-white/5">{k.id}</button>))}
          {ts.length > 12 && <span className="text-[#8f99a8]">+{ts.length - 12} lagi</span>}
        </div>
      )}
      <p className="text-[10.5px] leading-snug text-[#8f99a8]">
        {r.sintetis !== false ? "Data IoT sintetis: belum ada sensor terpasang di RS. " : ""}Sensor hanya mencatat waktu nyala, lama dan mode alat dari arus listrik; tidak mengukur kondisi pasien.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- the report: a page for a leader ("Ringkas") and the full report ("Lengkap")
// The user, 2026-11-15: the full report reads as "sangat kompleks" to a layperson. It now opens on one page in plain words
// (RingkasanPimpinan); the full report keeps every chapter, exhibit and case file, each chapter led by its point in one
// sentence and folded after the summary, the contents under four headings, and a chapter's method text behind its own toggle.
type Mode = "ringkas" | "lengkap";
/** where a link (or an event) leads once the full report is drawn: an element, or the event sent again to the case files */
type Tujuan = { el: string } | { ulang: { jenis: string; detail: string } };
const KELOMPOK_BAB: [string, string[]][] = [["Ringkasan", ["ringkasan"]], ["Temuan", ["skala", "wilayah", "modus", "iot", "tema"]],
  ["RS & kasus", ["rs", "kasus"]], ["Tindak lanjut & teknis", ["keputusan", "kerja", "andal", "lampiran", "metode"]]];
const grupBab = (x: string) => KELOMPOK_BAB.find(([, ids]) => ids.includes(x))?.[0] ?? "Temuan";  // an older report's theme chapters are findings
// chapter titles in plain words; the report's own title stays in the heading's tooltip
const JUDUL_AWAM: Record<string, string> = { skala: "Berapa besar kerugian dan di mana menumpuk", iot: "Cek sensor alat medis (IoT)",
  tema: "Temuan per kelompok penyakit", rs: "RS yang diaudit lebih dulu", kasus: "Berkas bukti per RS dan per klaim", lampiran: "Lampiran teknis: lingkup, metode dan biaya" };
const judulBab = (b: Bab) => JUDUL_AWAM[b.id] ?? b.judul;
const BAB_TERLIPAT = new Set(["andal", "lampiran", "metode"]);  // folded at first; the summary never folds
// a chapter whose text is the method rather than the finding: the text behind its own toggle
const TEKS_METODE: Record<string, string> = { skala: "Cara estimasi kerugian dihitung", modus: "Cara sistem memberi tanda (tag) pada klaim" };
/** Scrolls to a part of the full report, unfolding its chapter (and anything else folded around it) first. */
function keBagian(x: string) {
  const el = document.getElementById(x);
  if (!el) return;
  const bab = el instanceof HTMLDetailsElement ? el : el.querySelector<HTMLDetailsElement>(":scope > details[data-bab]");
  if (bab) bab.open = true;
  bukaLeluhur(el);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
/** The cover back in view when the reading mode changes far down the page. */
function keSampul() {
  const h = document.getElementById("cab-laporan");
  if (h && h.getBoundingClientRect().top < 0) h.scrollIntoView({ block: "start" });
}

function PilihMode({ mode, pilih }: { mode: Mode; pilih: (m: Mode) => void }) {
  return (
    <div role="tablist" aria-label="Cara membaca laporan" className="lp-no-print flex w-full shrink-0 rounded-lg border border-white/15 bg-black/30 p-1 sm:w-auto">
      {([["lengkap", "Lengkap", "semua bab"], ["ringkas", "Ringkas", "untuk pimpinan"]] as const).map(([m, a, b]) => (
        <button key={m} role="tab" aria-selected={mode === m} onClick={() => pilih(m)}
          className={`flex-1 rounded-md px-3.5 py-1.5 text-left leading-tight transition sm:flex-none ${mode === m ? "bg-[#9d8cff] text-[#14111f]" : "text-[#d3d8de] hover:bg-white/[.06]"}`}>
          <span className="block text-[13px] font-semibold">{a}</span>
          <span className={`block text-[11px] ${mode === m ? "text-[#2b2547]" : "text-[#8f99a8]"}`}>{b}</span>
        </button>
      ))}
    </div>
  );
}

function Laporannya({ L, batch, simpan, jar }: { L: Laporan; batch?: Lampiran; simpan: (klaim: string, status: string, catatan: string) => Promise<void>; jar: Jaringan }) {
  const ver = L.verifikasi ?? {};
  const byId = useMemo(() => Object.fromEntries(L.exhibit.map((e) => [e.id, e])), [L]);
  const kasusTema = useMemo(() => {
    const m: Record<string, Kasus[]> = {};
    for (const k of L.kasus) (m[k.tema] ??= []).push(k);
    return m;
  }, [L]);
  // since 2026-11-14 the national report's chapters (testing/laporan_cabang.py); older reports: summary, worklist, one chapter per theme
  const baru = !!L.berkas_rs;
  const [r0, ...rest] = L.bab;
  const bab = baru ? L.bab : [r0, { id: "kerja", judul: "Daftar kerja verifikator (prioritas)", exhibit: [], bagian: [] } as Bab, ...rest, { id: "metode", judul: "Metodologi & batas", exhibit: [], bagian: [] } as Bab];
  const s = L.sampul;
  const model = s.model ?? "model v4";
  const riil = !!L.lampiran.riil;
  const antre = L.kasus.filter((k) => k.keputusan !== "DIBERSIHKAN");
  const hit = { terbukti: 0, sesuai: 0, investigasi: 0 } as Record<string, number>;
  antre.forEach((k) => { const v = ver[k.id]; if (v) hit[v.status] += 1; });
  const belum = antre.length - hit.terbukti - hit.sesuai - hit.investigasi;
  const exhibitBab = (b: Bab) => [...b.exhibit, ...(b.subbab ?? []).flatMap((x) => x.exhibit)];

  // the user, 2026-11-15: the full report is the default; the page for a leader stays one click away
  const [mode, setMode] = useState<Mode>("lengkap");
  const [tunda, setTunda] = useState<Tujuan | null>(null);
  const [lipat, setLipat] = useState<Record<string, boolean>>({});
  const terbuka = (x: string) => lipat[x] ?? !BAB_TERLIPAT.has(x);
  // the page for a leader: its numbers, and its two example claims with their explanations (fetched as an opened case file is)
  const R = useMemo(() => olahRingkas(L, riil), [L, riil]);
  const contoh = useMemo(() => pilihContoh(L), [L]);
  const g0 = useGrafKasus(jar, contoh[0]?.k.id ?? "", mode === "ringkas");
  const g1 = useGrafKasus(jar, contoh[1]?.k.id ?? "", mode === "ringkas");
  const pergi = (t: Tujuan) => { setTunda(t); setMode("lengkap"); };
  const pilihMode = (m: Mode) => { keSampul(); setMode(m); };
  // a link into the full report goes there once it is drawn
  useEffect(() => {
    if (mode !== "lengkap" || !tunda) return;
    const h = setTimeout(() => {
      setTunda(null);
      if ("el" in tunda) keBagian(tunda.el);
      else window.dispatchEvent(new CustomEvent<string>(tunda.ulang.jenis, { detail: tunda.ulang.detail }));
    }, 80);
    return () => clearTimeout(h);
  }, [mode, tunda]);
  // a case file asked for (a claim, a hospital, a theme's list: BUKA_BERKAS / BUKA_RS / BUKA_TEMA) lives in the full report's
  // "kasus" chapter: from the page for a leader the full report is drawn first and the request sent again; in the full report
  // that chapter unfolds
  useEffect(() => {
    const h = (e: Event) => {
      if (mode === "ringkas") { setTunda({ ulang: { jenis: e.type, detail: (e as CustomEvent<string>).detail } }); setMode("lengkap"); }
      else setLipat((x) => (x.kasus === false ? { ...x, kasus: true } : x));
    };
    const jenis = [BUKA_BERKAS, BUKA_RS, BUKA_TEMA];
    jenis.forEach((j) => window.addEventListener(j, h));
    return () => jenis.forEach((j) => window.removeEventListener(j, h));
  }, [mode]);
  // a file opened inside a folded chapter (an exhibit's hospital table or map opens `berkas-<id>` itself): unfold, then show it
  const isi = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = isi.current;
    if (!el) return;
    const h = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLDetailsElement) || !t.open || t.dataset.bab) return;
      const b = t.parentElement?.closest<HTMLDetailsElement>("details[data-bab]");
      if (!b || b.open) return;
      b.open = true;
      requestAnimationFrame(() => t.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    el.addEventListener("toggle", h, true);
    return () => el.removeEventListener("toggle", h, true);
  }, [mode]);
  // the chart's "buka dashboard keputusan" scrolls `cab-kerja` into view itself (SwarmCabangBagan's bukaDaftarKerja): on the
  // page for a leader that id is a hidden stand-in that draws the full report and goes there; in the full report it unfolds
  // its chapter first
  const kerjaRingkas = (el: HTMLDivElement | null) => { if (el) el.scrollIntoView = () => pergi({ el: "cab-kerja" }); };
  const kerjaLengkap = (el: HTMLDivElement | null) => {
    if (el) el.scrollIntoView = (o?: boolean | ScrollIntoViewOptions) => { bukaLeluhur(el); HTMLElement.prototype.scrollIntoView.call(el, o); };
  };
  const semuaBab = (v: boolean) => setLipat(Object.fromEntries(bab.slice(1).map((b) => [b.id, v])));

  const hasilVerifikasi = (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px]">
      {Object.entries(STATUS).map(([k, [n, w]]) => <Chip key={k} warna={w}>{n}: {hit[k]}</Chip>)}<Chip garis>belum diverifikasi: {belum}</Chip>
      <span className="text-[10.5px] text-[#8f99a8]">Status diisi verifikator di tiap berkas klaim; sistem hanya menandai klaim yang perlu diperiksa, bukan memutuskan fraud.</span>
    </div>
  );
  // the contents under four headings; drawn in the side column (wide screens) and as a folded list above the chapters
  const daftarIsi = (
    <div className="space-y-3">
      {KELOMPOK_BAB.map(([g]) => {
        const daftar = bab.map((b, i) => ({ b, i })).filter((x) => grupBab(x.b.id) === g);
        if (!daftar.length) return null;
        return (
          <div key={g}>
            <p className="mb-1 px-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#8f99a8]">{g}</p>
            {daftar.map(({ b, i }) => {
              const n = exhibitBab(b).map((e) => byId[e]?.nomor).filter(Boolean) as number[];
              return (
                <div key={b.id}>
                  <button onClick={() => keBagian(`cab-${b.id}`)} title={n.length ? `${b.judul} · exhibit ${n.length > 3 ? `${n[0]}–${n[n.length - 1]}` : n.join(", ")}` : b.judul}
                    className="flex w-full gap-1.5 rounded px-1.5 py-1 text-left text-[12px] leading-snug text-[#d3d8de] hover:bg-white/5 hover:text-white">
                    <span className="w-4 shrink-0 tabular-nums text-[#8f99a8]">{i + 1}</span><span>{judulBab(b)}</span>
                  </button>
                  {b.tema && kasusTema[b.tema] && <p className="pl-7 text-[10.5px] text-[#8f99a8]">{kasusTema[b.tema].filter((k) => k.keputusan !== "DIBERSIHKAN").length} berkas klaim</p>}
                  {baru && b.id === "kasus" && <p className="pl-7 text-[10.5px] text-[#8f99a8]">{L.berkas_rs?.length ?? 0} berkas RS · {antre.length} berkas klaim</p>}
                  {b.id === "iot" && L.iot && <p className="pl-7 text-[10.5px] text-[#8f99a8]">{id(L.iot.tidak_sesuai)} dari {id(L.iot.klaim_dengan_alat)} klaim tidak cocok</p>}
                </div>
              );
            })}
          </div>
        );
      })}
      {!baru && <button onClick={() => keBagian("cab-lampiran")} className="w-full rounded px-1.5 py-1 text-left text-[12px] text-[#8f99a8] hover:bg-white/5 hover:text-white">Lampiran A · evaluasi teknis</button>}
      <div className="lp-no-print flex flex-wrap gap-x-3 gap-y-1 border-t border-white/[.06] px-1.5 pt-2 text-[11.5px]">
        <button onClick={() => semuaBab(true)} className="text-[#b8a9ff] hover:text-white">Buka semua bab</button>
        <button onClick={() => semuaBab(false)} className="text-[#b8a9ff] hover:text-white">Lipat semua</button>
      </div>
    </div>
  );
  const prosa = (teks: string, key: string) => (
    <div key={key} className="mt-3 text-justify [text-justify:inter-word] text-[13.5px] leading-[1.7] text-[#d3d8de]"><Markdown text={teks} /></div>
  );
  const isiBab = (b: Bab) => (
    <>
      {TEKS_METODE[b.id] && b.bagian.length ? (
        <details className="mt-3 rounded-lg border border-white/[.08] bg-black/20">
          <summary className="cursor-pointer list-none px-3 py-2 text-[12.5px] text-[#d3d8de] hover:text-white">
            {TEKS_METODE[b.id]} <span className="text-[#8f99a8]">· penjelasan teknis, klik untuk membuka</span></summary>
          <div className="border-t border-white/[.06] px-3 pb-3">{b.bagian.map((g) => prosa(g.teks, g.id))}</div>
        </details>
      ) : b.bagian.map((g) => prosa(g.teks, g.id))}
      {b.id === "iot" && L.iot && <RingkasIot r={L.iot} kasus={L.kasus} />}
      <div className="mt-4 space-y-4">{b.exhibit.map((e) => byId[e] && <ExhibitCard key={e} x={byId[e]} note={L.narasi?.[e]} />)}</div>
      {b.subbab?.map((sb) => (
        <div key={sb.id} id={`cab-${sb.id}`} className="mt-7 scroll-mt-4">
          <div className="flex flex-wrap items-baseline gap-2 border-b border-white/[.06] pb-1.5">
            <h3 className="text-[15px] font-semibold text-white">{sb.judul}</h3>
            {kasusTema[sb.tema]?.length ? (
              <button onClick={() => window.dispatchEvent(new CustomEvent<string>(BUKA_TEMA, { detail: sb.tema }))} className="lp-no-print ml-auto text-[11px] text-[#9d8cff] hover:text-[#c9c0ff]">
                lihat {kasusTema[sb.tema].filter((k) => k.keputusan !== "DIBERSIHKAN").length} berkas klaim kelompok ini →</button>
            ) : null}
          </div>
          {prosa(sb.teks, `${sb.id}-teks`)}
          <div className="mt-3 grid gap-4 2xl:grid-cols-2">{sb.exhibit.map((e) => byId[e] && <ExhibitCard key={e} x={byId[e]} note={L.narasi?.[e]} />)}</div>
        </div>
      ))}
      {b.id === "kerja" && <div className="mt-3"><DaftarKerja L={L} ver={ver} /></div>}
      {b.tema && kasusTema[b.tema] && <DaftarKasus kasus={kasusTema[b.tema]} ver={ver} simpan={simpan} jar={jar} model={model} kc={L.kc.id} />}
      {baru && b.id === "kasus" && <BerkasPerRS L={L} ver={ver} simpan={simpan} jar={jar} model={model} />}
      {baru && b.id === "keputusan" && (
        <div className="mt-4 space-y-4">
          <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2">
            <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Dashboard keputusan · hasil verifikasi sejauh ini</p>
            {L.box?.jalur && (
              <>
                <p className="mt-1.5 text-[11px] text-[#abb3bf]">Jalur RS menurut pola TSM · {id(L.box.rs)} RS di Box Karantina</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px]">
                  {(["ditindak", "dibina", "dibebaskan"] as const).map((j) => <Chip key={j} warna={JALUR[j].color}>{JALUR[j].label}: {id(L.box?.jalur[j] ?? 0)} RS</Chip>)}
                  <span className="text-[10.5px] text-[#8f99a8]">Ditindak = Terstruktur, Sistematis dan Masif terpenuhi; dibina = minimal satu terpenuhi; dibebaskan = tidak ada. Klaim yang ditandai tetap diverifikasi satu per satu.</span>
                </div>
                <p className="mt-2 text-[11px] text-[#abb3bf]">Verifikasi klaim yang perlu dicek · {id(antre.length)} klaim</p>
              </>
            )}
            {hasilVerifikasi}
          </div>
          <div id="cab-kerja" ref={kerjaLengkap} className="scroll-mt-4"><Judul>Daftar kerja verifikator (prioritas)</Judul><div className="mt-2"><DaftarKerja L={L} ver={ver} /></div></div>
        </div>
      )}
      {(b.id === "metode" || (baru && b.id === "lampiran")) && <Metode L={L} />}
      {baru && b.id === "lampiran" && <div className="mt-5"><LampiranTeknis kc={L.lampiran} batch={batch} /></div>}
    </>
  );

  return (
    <div>
      <header id="cab-laporan" className="lp-sampul @container scroll-mt-4 rounded-xl border border-[#9d8cff]/25 bg-[#9d8cff]/[.06] p-4 sm:p-5">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          {/* the title takes the whole row on a phone; the reading-mode switch then sits under it */}
          <div className="min-w-0 flex-[1_1_20rem]">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#c9c0ff]">Laporan audit klaim · AI Agent Swarm Branch</p>
            <h1 className="mt-1 text-[22px] font-semibold leading-tight text-white">{L.kc.nama} · {L.kc.provinsi}</h1>
            <p className="mt-1 text-[12.5px] text-[#abb3bf]">{L.kc.rs} RS di {L.kc.kabkota.length} kab/kota · periode klaim {periodeAwam(L.periode)} · {riil ? "data riil sampel BPJS (internal)" : "data sintetis"}</p>
          </div>
          <PilihMode mode={mode} pilih={pilihMode} />
        </div>
        {mode === "ringkas" ? <RingkasInti R={R} /> : (
          <>
            <details className="mt-2 text-[12px] text-[#abb3bf]">
              <summary className="cursor-pointer list-none hover:text-white">Wilayah: {L.kc.kabkota.length} kab/kota <span className="text-[#b8a9ff]">(lihat daftar)</span></summary>
              <p className="mt-1 leading-relaxed">{L.kc.kabkota.join(", ")}</p>
            </details>
            {s.estimasi_kerugian_rp !== undefined && (
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {([["Nilai transaksi yang dianalisis", s.nilai_transaksi_rp ?? s.tagihan_rp, `${id(s.klaim)} klaim dari ${s.rs} RS`, "#c5cbd3"],
                  ["Nilai klaim terindikasi fraud", s.nilai_terindikasi_rp ?? s.nilai_antrean_rp, `${id(s.antrean)} klaim · ${id(100 * (s.nilai_terindikasi_rp ?? s.nilai_antrean_rp) / Math.max(1, s.nilai_transaksi_rp ?? s.tagihan_rp), 1)}% dari nilai transaksi`, "#f0c661"],
                  ["Estimasi nilai kerugian fraud", s.estimasi_kerugian_rp, `${id(100 * s.estimasi_kerugian_rp / Math.max(1, s.nilai_transaksi_rp ?? s.tagihan_rp), 2)}% dari nilai transaksi · potensi kelebihan bayar, menunggu verifikasi`, "#ffb59a"]] as const).map(([a, v, c, w]) => (
                  <div key={a} className="rounded-md border border-white/[.08] bg-black/20 px-3 py-2.5" style={{ borderTop: `2px solid ${w}` }}>
                    <p className="text-[24px] font-semibold tabular-nums text-white">{rp(v)}</p>
                    <p className="text-[11.5px] font-medium text-[#d3d8de]">{a}</p>
                    <p className="text-[10.5px] text-[#abb3bf]">{c}</p>
                  </div>))}
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[["Klaim dianalisis", id(s.klaim), `tagihan ${rp(s.tagihan_rp)}`, undefined],
                ["Perlu dicek verifikator", id(s.antrean), `${id(s.persen_antrean, 1)}% dari klaim · ${s.tahan} ditahan · ${s.periksa} diperiksa`, "direkomendasikan: TAHAN + PERIKSA"],
                [baru ? "RS dengan klaim perlu dicek" : "Nilai tagihan ditandai", baru ? id(L.berkas_rs?.length ?? 0) : rp(s.nilai_antrean_rp), baru ? `dari ${s.rs} RS · ${s.tema_aktif} tema klinis` : `${s.tema_aktif} tema klinis`, undefined],
                ["Dibaca tim agen AI", id(s.ragu), `klaim ragu · ${s.dibersihkan} dibersihkan (bukti belum cukup)`, "zona RAGU: skor model menengah atau ada aturan yang menyala; dibaca AI Agent Swarm"]].map(([a, b, c, t]) => (
                <div key={a} title={t}><p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{a}</p><p className="text-[22px] font-semibold tabular-nums text-white">{b}</p><p className="text-[10.5px] text-[#abb3bf]">{c}</p></div>))}
            </div>
            <div className="mt-4 rounded-md border border-white/10 bg-black/20 px-3 py-2">
              <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Hasil verifikasi kantor cabang</p>
              {hasilVerifikasi}
            </div>
            <div className="lp-no-print mt-3 flex flex-wrap items-center gap-2">
              <span title={`v5 · ${model} + rule engine + AI Agent Swarm`}><Chip warna="#7ee2c0">sistem: model {model} + aturan + tim agen AI</Chip></span>
              {riil ? <Chip warna="#f0c661" garis>data riil sampel BPJS · internal · wilayah KC demo</Chip> : <Chip warna="#c5cbd3" garis>data sintetis · wilayah KC demo · koordinat RS sintetis</Chip>}
            </div>
            <details className="lp-no-print mt-3">
              <summary className="cursor-pointer list-none text-[12px] text-[#b8a9ff] hover:text-white">Istilah singkat: TAHAN, PERIKSA, Box Karantina, TSM, jalur RS, IoT alat medis…</summary>
              <div className="mt-2"><IstilahSingkat /></div>
            </details>
          </>
        )}
      </header>
      {mode === "ringkas" ? (
        <>
          <div id="cab-kerja" hidden ref={kerjaRingkas} />
          <RingkasanPimpinan R={R} contoh={contoh.map((c, i) => ({ ...c, paragraf: (i ? g1 : g0).g?.penjelasan.paragraf }))}
            aksi={{ bukaBab: (x) => pergi({ el: `cab-${x}` }), bukaRS: (f) => pergi({ ulang: { jenis: BUKA_RS, detail: f } }),
              bukaKlaim: (x) => pergi({ ulang: { jenis: BUKA_BERKAS, detail: x } }), bukaKerja: () => pergi({ el: "cab-kerja" }), keLengkap: () => pilihMode("lengkap") }} />
        </>
      ) : (
        <div className="mt-5 grid gap-6 xl:grid-cols-[230px_1fr]">
          <nav className="max-xl:hidden">
            <div className="sticky top-3 space-y-3">
              <button onClick={() => pilihMode("ringkas")} className="lp-no-print flex w-full items-center gap-1.5 rounded-md border border-[#9d8cff]/30 bg-[#9d8cff]/[.07] px-2 py-1.5 text-left text-[12px] text-[#c9c0ff] hover:text-white">
                <Icon name="left" className="h-3.5 w-3.5" />Ringkasan untuk pimpinan</button>
              {daftarIsi}
            </div>
          </nav>
          <div ref={isi} className="min-w-0 space-y-8">
            <details className="lp-no-print rounded-lg border border-white/[.08] bg-[#1c2127] xl:hidden">
              <summary className="cursor-pointer list-none px-3 py-2.5 text-[13px] font-medium text-white">Daftar isi · {bab.length} bab <span className="font-normal text-[#8f99a8]">(klik untuk membuka)</span></summary>
              <div className="border-t border-white/[.06] px-1.5 py-2">{daftarIsi}</div>
            </details>
            {bab.map((b, i) => {
              const jd = judulBab(b);
              const kepala = (
                <>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#8f99a8]">Bab {i + 1} · {grupBab(b.id)}</p>
                  <h2 title={jd !== b.judul ? b.judul : undefined} className="mt-1 text-[19px] font-semibold leading-snug text-white">{jd}</h2>
                </>
              );
              return (
                <section key={b.id} id={`cab-${b.id}`} className="lp-bab scroll-mt-4">
                  {i === 0 ? (
                    <><div className="border-b border-white/10 pb-3">{kepala}</div>{isiBab(b)}</>
                  ) : (
                    <details data-bab={b.id} open={terbuka(b.id)} className="group/bab"
                      onToggle={(e) => { const o = e.currentTarget.open; setLipat((x) => ((x[b.id] ?? !BAB_TERLIPAT.has(b.id)) === o ? x : { ...x, [b.id]: o })); }}>
                      <summary className="flex cursor-pointer list-none items-start gap-3 border-b border-white/10 pb-3">
                        <div className="min-w-0 flex-1">{kepala}</div>
                        <span className="lp-no-print mt-1 flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-[#abb3bf] group-hover/bab:text-white">
                          <span className="group-open/bab:hidden">Buka</span><span className="hidden group-open/bab:inline">Lipat</span>
                          <Icon name="down" className="h-3.5 w-3.5 transition group-open/bab:rotate-180" />
                        </span>
                      </summary>
                      {isiBab(b)}
                    </details>
                  )}
                </section>
              );
            })}
            {!baru && <section id="cab-lampiran" className="scroll-mt-4"><LampiranTeknis kc={L.lampiran} batch={batch} /></section>}
            <div className="lp-no-print flex justify-center">
              <button onClick={() => pilihMode("ringkas")} className="inline-flex items-center gap-1.5 rounded-md border border-[#9d8cff]/30 bg-[#9d8cff]/[.07] px-3 py-2 text-[12.5px] text-[#c9c0ff] hover:text-white">
                <Icon name="left" className="h-3.5 w-3.5" />Kembali ke ringkasan untuk pimpinan</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

async function ambil<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d as T;
}

function RingkasRun({ r, led }: { r: Run; led?: Ledger }) {
  const o = r.operasional;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-white/[.07] bg-[#1c2127] px-3 py-2 text-[11px] text-[#abb3bf]">
      <span className="font-medium text-white">{r.label}</span>
      <span>dijalankan {r.dijalankan ?? r.dibuat}</span>
      {o && <span>{id(o.klaim)} klaim dianalisis · {id(o.antrean)} masuk antrean ({id((100 * o.antrean) / Math.max(1, o.klaim), 1)}%) · nilai ditandai {rp(o.nilai_ditandai_rp)} · {id(o.dibaca_swarm)} dibaca swarm</span>}
      <span>{r.kc} KC · biaya AI ${id(r.biaya_usd, 2)}</span>
      {led && (led.error ? <Chip warna="#c5cbd3" garis>Box Karantina: belum tersambung ({led.error.slice(0, 40)})</Chip>
        : led.tag ? <Chip warna="#7ee2c0">Box Karantina: {id(led.tag)} tag di ledger{led.status ? ` · ${Object.entries(led.status).map(([k, v]) => `${k} ${v}`).join(" · ")}` : ""}</Chip>
          : <Chip warna="#c5cbd3" garis>Box Karantina: run ini belum dikirim ke ledger</Chip>)}
    </div>
  );
}

// the tabs under the chart, as the national AI Agent Swarm's (KonsultanView SUBTABS): the report, the run's steps, the claims it
// recommends, its cost. The report stays mounted while another tab shows (its reading mode, folds and opened files are kept); a
// link into it (a claim, a hospital, a theme, the worklist) shows the Laporan tab first and is then sent again.
const TAB_CABANG = [["laporan", "Laporan"], ["jejak", "Jejak kerja"], ["indikasi", "Indikasi & rekomendasi"], ["biaya", "Biaya & token"]] as const;
type TabCabang = (typeof TAB_CABANG)[number][0];
type TujuanTab = { jenis: string; detail: string } | { el: string };

export function SwarmCabangView() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState("");
  const [idx, setIdx] = useState<Indeks | null>(null);
  const [kc, setKc] = useState<string>("");
  const [L, setL] = useState<Laporan | null>(null);
  const [graf, setGraf] = useState<Jaringan & { kunci: string }>({ kunci: "", data: null, status: "" });
  const [err, setErr] = useState("");
  useEffect(() => {
    ambil<{ runs: Run[] }>("/api/swarm-cabang").then((d) => { setRuns(d.runs); setRun((r) => r || (d.runs[0]?.id ?? "")); }).catch((e) => setErr(String(e.message || e)));
  }, []);
  // the project sidebar (ProyekCabang) picks an audit's run: "cabang-pilih-run" with the run id (cabangPilih.ts)
  useEffect(() => {
    const h = (e: Event) => {
      const x = (e as CustomEvent<string>).detail;
      if (!x) return;
      setRun(x);
      // a run made after the list was read (a new audit): read the list again
      ambil<{ runs: Run[] }>("/api/swarm-cabang").then((d) => setRuns(d.runs)).catch(() => {});
    };
    window.addEventListener(CABANG_PILIH_RUN, h);
    return () => window.removeEventListener(CABANG_PILIH_RUN, h);
  }, []);
  useEffect(() => {
    if (!run) return;
    ambil<Indeks>(`/api/swarm-cabang?run=${encodeURIComponent(run)}`).then((d) => {
      setIdx(d);
      let simpanKc = "";
      try { simpanKc = localStorage.getItem("swarm-cabang-kc") ?? ""; } catch { /* storage blocked */ }
      const awal = d.kc.find((x) => x.id === simpanKc) ?? [...d.kc].sort((a, b) => b.antrean - a.antrean)[0];
      setKc(awal?.id ?? "");
    }).catch((e) => setErr(String(e.message || e)));
  }, [run]);
  useEffect(() => {
    if (!kc || !run || idx?.id !== run) return;
    try { localStorage.setItem("swarm-cabang-kc", kc); } catch { /* storage blocked */ }
    ambil<Laporan>(`/api/swarm-cabang?run=${encodeURIComponent(run)}&kc=${encodeURIComponent(kc)}`).then(setL).catch((e) => setErr(String(e.message || e)));
    const kunci = `${run}|${kc}`;
    ambil<GrafIndeksDikirim>(`/api/swarm-cabang?run=${encodeURIComponent(run)}&kc=${encodeURIComponent(kc)}&graf=1`)
      .then((d) => setGraf({ kunci, run, kc, data: indeksGraf(d, run, kc), status: "" }))
      .catch((e) => setGraf({ kunci, data: null, status: String(e.message || e) }));
  }, [kc, run, idx]);
  // a branch whose networks are still loading (or belong to the previous branch) shows the loading line
  const jar: Jaringan = graf.kunci === `${run}|${kc}` ? graf : { data: null, status: "Memuat jaringan klaim…" };
  const simpan = async (klaim: string, status: string, catatan: string) => {
    const r = await fetch("/api/swarm-cabang", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run, kc, klaim, status, catatan }) });
    const d = await r.json();
    if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); return; }
    setL((x) => (x ? { ...x, verifikasi: d.verifikasi } : x));
  };
  const prov = useMemo(() => {
    const m: Record<string, Indeks["kc"]> = {};
    for (const x of idx?.kc ?? []) (m[x.provinsi] ??= []).push(x);
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  }, [idx]);
  const runIni = runs.find((r) => r.id === run);

  // ------------------------------------------------ the tabs under the chart
  const [tab, setTab] = useState<TabCabang>("laporan");
  const tabRef = useRef<TabCabang>("laporan");
  useEffect(() => { tabRef.current = tab; }, [tab]);
  const [tujuanTab, setTujuanTab] = useState<TujuanTab | null>(null);
  /** show the report, then go where a link pointed (after it is drawn, as Laporannya's own links do) */
  const keLaporan = (t: TujuanTab) => { setTujuanTab(t); setTab("laporan"); };
  // a link into the report sent while another tab shows: held here (capture, before the report's own listeners), the Laporan tab
  // shown, then the same event sent again below
  useEffect(() => {
    const h = (e: Event) => {
      if (tabRef.current === "laporan") return;
      e.stopImmediatePropagation();
      setTujuanTab({ jenis: e.type, detail: (e as CustomEvent<string>).detail });
      setTab("laporan");
    };
    const jenis = [BUKA_BERKAS, BUKA_RS, BUKA_TEMA];
    jenis.forEach((j) => window.addEventListener(j, h, true));
    return () => jenis.forEach((j) => window.removeEventListener(j, h, true));
  }, []);
  useEffect(() => {
    if (tab !== "laporan" || !tujuanTab) return;
    const t = setTimeout(() => {
      setTujuanTab(null);
      if ("el" in tujuanTab) document.getElementById(tujuanTab.el)?.scrollIntoView({ behavior: "smooth", block: "start" });
      else window.dispatchEvent(new CustomEvent<string>(tujuanTab.jenis, { detail: tujuanTab.detail }));
    }, 80);
    return () => clearTimeout(t);
  }, [tab, tujuanTab]);
  // the run's steps (for the Jejak kerja tab and its count, and the time per step of the Biaya & token tab)
  const [jejak, setJejak] = useState<{ run: string; data?: Jejak; err?: string } | null>(null);
  useEffect(() => {
    if (!run) return;
    let batal = false;
    ambil<Jejak>(`/api/swarm-cabang?run=${encodeURIComponent(run)}&jejak=1`)
      .then((d) => { if (!batal) setJejak({ run, data: d }); }, (e) => { if (!batal) setJejak({ run, err: String(e.message || e) }); });
    return () => { batal = true; };
  }, [run]);
  const jejakIni = jejak?.run === run ? jejak : null;
  // the claims the run recommends to this branch's verifiers, with their fraud type (the graph index), for the Indikasi tab
  const grafData = jar.data;
  const barisIndikasi = useMemo<BarisIndikasi[]>(() => {
    if (!L) return [];
    const ver = L.verifikasi ?? {};
    const j: Jaringan = { data: grafData, status: "" };
    return L.kasus.filter((k) => k.keputusan !== "DIBERSIHKAN").map((k) => {
      const m = modusKlaim(k, j);
      return { id: k.id, tgl: k.tgl, rs: k.rs, kabkota: k.kabkota, tema: k.tema_nama, modus: { ...m, singkat: singkatModus(m.nama), warna: warnaModus(m) },
        keputusan: k.keputusan as "TAHAN" | "PERIKSA", rugi: k.estimasi_kerugian_rp ?? null, dasar: k.dasar_kerugian, tagihan: k.biaya_rp, prioritas: k.prioritas, indeks: k.indeks_prioritas,
        status: ver[k.id]?.status ?? null };
    });
  }, [L, grafData]);
  const nJejak = jejakIni?.data?.tahap.filter((t) => t.status === "selesai" || t.status === "berjalan" || t.status === "gagal").length ?? 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#12161b]">
      <div className="mx-auto max-w-[1400px] space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#199e70]/20 text-[#7ee2c0]"><Icon name="constellation" className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[16px] font-semibold text-white">AI Agent Swarm Branch</h1>
            <p className="text-[11.5px] text-[#abb3bf]">Audit dan verifikasi klaim oleh Kantor Cabang BPJS Kesehatan, per batch, dikelompokkan per tema klinis.</p>
          </div>
          <label className="flex items-center gap-2 text-[11.5px] text-[#d3d8de]">Run
            <select value={run} onChange={(e) => { setRun(e.target.value); umumkanRunCabang(e.target.value); }} className="max-w-[260px] rounded border border-white/15 bg-[#1c2127] px-2 py-1 text-[12px] text-white">
              {runs.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[11.5px] text-[#d3d8de]">Kantor cabang
            <select value={kc} onChange={(e) => setKc(e.target.value)} className="rounded border border-white/15 bg-[#1c2127] px-2 py-1 text-[12px] text-white">
              {prov.map(([p, xs]) => <optgroup key={p} label={p}>{xs.map((x) => <option key={x.id} value={x.id}>{x.nama} · {id(x.antrean)} antrean</option>)}</optgroup>)}
            </select>
          </label>
          {runIni?.metrik?.riil
            ? <span title="Sampel data BPJS asli: terikat pakta integritas, hanya untuk internal" className="rounded border border-dashed border-amber-300/50 px-2 py-1 text-[11px] text-amber-200">Data riil BPJS · internal</span>
            : <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>}
        </div>
        {err && <p className="rounded border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{err}</p>}
        <PusatCabang />
        {runIni && <RingkasRun r={runIni} led={idx?.id === run ? idx?.ledger : undefined} />}
        {L && L.kc.id === kc && L.run?.id === run ? (
          <>
            <SwarmCabangBagan key={`${run}-${L.kc.id}`} kc={L.kc.nama} periode={L.periode} riil={!!runIni?.metrik?.riil} sampul={L.sampul} kasus={L.kasus}
              exhibit={L.exhibit.length} bab={L.bab.length} narasi={Object.keys(L.narasi ?? {}).length} run={runIni} ledger={idx?.id === run ? idx?.ledger : undefined}
              indikasi={L.indikasi} box={L.box as BoxBagan | undefined} iot={L.iot}
              bukaDaftarKerja={() => (tabRef.current === "laporan" ? document.getElementById("cab-kerja")?.scrollIntoView({ behavior: "smooth", block: "start" }) : keLaporan({ el: "cab-kerja" }))}
              putusan={Object.values(L.verifikasi ?? {}).reduce((a, v) => ({ ...a, [v.status]: (a[v.status] ?? 0) + 1 }), { terbukti: 0, sesuai: 0, investigasi: 0 } as PutusanBagan)} />
            <div className="lp-no-print flex flex-wrap items-end gap-1 border-b border-white/10" role="tablist" aria-label="Isi run">
              {TAB_CABANG.map(([k, label]) => {
                const n = k === "indikasi" ? barisIndikasi.length : k === "jejak" ? nJejak : 0;
                return (
                  <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                    className={`-mb-px rounded-t border-x border-t px-3 py-1.5 text-[12px] ${tab === k ? "border-white/10 bg-[#1c2127] font-medium text-white" : "border-transparent text-[#abb3bf] hover:text-white"}`}>
                    {label}{n ? <span className="ml-1.5 rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums text-[#c5cbd3]">{n.toLocaleString("id-ID")}</span> : null}
                  </button>
                );
              })}
            </div>
            <div hidden={tab !== "laporan"}><Laporannya L={L} batch={idx?.lampiran} simpan={simpan} jar={jar} /></div>
            {tab === "jejak" && <CabangTabJejak jejak={jejakIni?.data ?? null} err={jejakIni?.err} />}
            {tab === "indikasi" && <CabangTabIndikasi baris={barisIndikasi} jenisMemuat={!jar.data && /^Memuat/.test(jar.status)}
              onBuka={(x) => keLaporan({ jenis: BUKA_BERKAS, detail: x })} />}
            {tab === "biaya" && <CabangTabBiaya run={run} jejak={jejakIni?.data ?? null} />}
          </>
        ) : !err && <p className="text-[12px] text-[#8f99a8]">Memuat laporan kantor cabang…</p>}
      </div>
    </div>
  );
}
