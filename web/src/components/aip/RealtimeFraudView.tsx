"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { Icon } from "@/components/Icon";

/* Realtime Fraud (api/aip/realtime): every claim judged the moment it arrives — entity resolution, the dynamic graph
   of the stream, the deployed model and the rules, minus the mitigating context — then one case per entity, written
   into the indikasi ledger at once so Box Karantina and the AI Agent Swarm read it. The Quantexa pattern for fraud,
   on the synthetic twin of the BPJS data. */

type Keputusan = "LOLOS" | "PERIKSA" | "TAHAN";
type JenisPeristiwa = "fkrtl" | "fktp" | "nonkap" | "faskes";
type Mitigasi = { kode: string; label: string; faktor: number };
type Sinyal = { kode: string; label: string; tag: string | null; s: number; w: number; fokus: [string, string]; bukti: string; terkait: string[];
  mitigasi: Mitigasi[]; kontribusi: number; kontribusi_tanpa_mitigasi: number; modus?: string[] };
type Brief = { seq: number; id: string; jenis?: JenisPeristiwa; klaim: string; kunjungan: string; sumber: string; versi: number; t: number; faskes: string;
  faskes_label: string; kab: string | null; kode: string; tingkat: string; tgl_datang: string; biaya: number; skor: number; skor_tanpa_mitigasi: number;
  keputusan: Keputusan; latensi_ms: number; kasus: string | null; ml_pct: number | null; modus?: string[];
  sinyal: { kode: string; label: string; kontribusi: number; dimitigasi: boolean }[] };
type Anggota = { jk: string | null; tahun_lahir: number | null; hak_kelas: number | null; segmen: string | null; tahun_meninggal: number | null;
  status: string | null; keluarga: boolean };
type ModusRow = { id: string; no: number; nama: string; arti: string; faskes: string; fokus?: boolean; deteksi_batch: string; deteksi: "data" | "proksi" | "kontrak" | null;
  cara: string | null; dokumen: string | null; sinyal: { kode: string; label: string; bobot: number; tag: string | null }[]; alert: number;
  tanam: { instans: number; tertangkap: number; sinyal_tepat: number; skenario: string[] } | null; juga: string | null };
type Ringkasan = { kasus: string; judul?: string; ringkasan: string; modus?: { id: string; nama: string; peristiwa: number }[];
  bukti?: { sinyal: string; kode: string; modus: string[]; jumlah: number; bukti: string; contoh: string; tanggal: string | null; kontribusi: number }[];
  faskes?: { label: string; peristiwa: number }[]; peserta?: number; jaringan?: { faskes: number; peserta: number; klaim: number; pasangan_tidak_wajar: number } | null;
  nilai_rp?: number; ditahan_rp?: number; mitigasi?: { label: string; peristiwa: number }[]; langkah?: { modus: string; nama: string; minta: string | null; cara: string | null }[];
  batas_data?: string[]; catatan?: string };
type BobotRow = { kode: string; label: string; modus: string[]; bobot_bawaan: number; bobot_berlaku: number; bobot_usulan: number; dikonfirmasi: number;
  false_positive: number; presisi_posterior: number; verifikator_alert: number; verifikator_dikoreksi: number; verifikator_presisi: number | null };
type Bobot = { sinyal: BobotRow[]; kasus_diputus: number; dasar_koreksi_verifikator: number | null; aturan: string };
type AlModel = { versi: string; pada: string; label: number; positif: number; negatif: number; sumber: string; cv_auprc_model: number | null;
  cv_auprc_aturan: number | null; lipatan: number; juara: boolean; gerbang: string; fitur_penting: { fitur: string; porsi: number }[] };
type JenisSsl = "fkrtl" | "fktp" | "nonkap";
type SslAlasan = { fitur: string; label: string; nilai: string; pola: string; arah?: string | null; porsi: number };
type SslRec = { versi?: string; err: number; tingkat?: "biasa" | "tidak_lazim" | "anomali"; skala?: number[]; alasan?: SslAlasan[]; basi?: boolean };
type SslDrift = { n: number; di_atas_p99: number; di_atas_p999: number; porsi_p99: number | null; porsi_p999: number | null; p_binomial?: number; status: string };
type SslInfo = { versi: string; pada: string; jenis: JenisSsl; nama: string; klaim: number; latih: number; held_out: number; fitur: number; medan: number;
  fitur_input: number; loss: number[]; galat_held_out: number[]; epoch: number; sebelum: string; sumber: string; detik: number; korupsi: string;
  ambang: { p50: number; p99: number; p999: number }; ambang_dalam_sampel?: { p99: number; p999: number }; drift: SslDrift; juara_cocok: boolean };
type SslEval = { n: number; positif?: number; prevalensi?: number; auprc_galat?: number | null; nyala_normal?: number | null; nyala_tanam?: number | null; cakupan?: number };
type Ablasi = { strategi: string; seed: number; dengan_ssl: number; tanpa_ssl: number; per_seed: Record<string, (number | null)[]>; kurva_tanpa_ssl: KurvaPt[];
  per_jenis: Record<string, { n: number; positif: number; aturan: number | null; dengan: number | null; tanpa: number | null }> };
type Butir = { medan: string; isi: string; dokumen: string; asal?: string };
type PermintaanRow = { id: string; status: string; dibuat: string; pesan: string; butir: Butir[]; balasan: string | null; dibalas: string | null };
type PermintaanView = { bisa: boolean; alasan_tidak: string | null; faskes: { sumber: string; klaim: string; tanda_terima: string } | null; riwayat: PermintaanRow[];
  draf: { pesan: string; butir: Butir[] } };
type AlStatus = { mode: "bayangan" | "aktif" | "mati"; ambang?: { periksa: number; tahan: number }; ssl: Partial<Record<JenisSsl, SslInfo | null>>;
  ssl_latih: { status: string; progres: { jenis?: JenisSsl; epoch: number; dari: number; loss: number | null } | null; galat: string | null; hasil?: Record<string, string> };
  juara: AlModel | null; registri: AlModel[]; label: Record<string, { label: number; positif: number }>;
  simulasi: { status: string; progres: { strategi: string; ronde: number; dari: number; auprc: number | null } | null; galat: string | null;
    ringkas: { pada: string; auprc_skor_aturan: number; terbaik: string; label_untuk_melampaui_aturan: Record<string, number | null> } | null };
  bisa_dipromosikan: boolean };
type KurvaPt = { label: number; positif: number; auprc: number | null };
type AlSim = { pada: string; detik: number; peristiwa: number; pool: number; uji: number; positif_pool: number; positif_uji: number; prevalensi_uji: number;
  auprc_skor_aturan: number; auprc_model_produksi_saja: number | null; kurva: Record<string, KurvaPt[]>; strategi: Record<string, string>; ronde: number;
  per_ronde: number; label_awal: number; terbaik: string; label_untuk_melampaui_aturan: Record<string, number | null>; catatan: string;
  titik_operasi?: { aturan_periksa_atau_tahan: OpPt; aturan_tahan: OpPt; model: (OpPt & { ambang: number })[];
    kalibrasi: { positif_diharapkan: number; positif_teramati: number; bin?: { dari: number; sampai: number; n: number; rata_p: number; teramati: number }[] } };
  ablasi_ssl?: Ablasi; ssl_evaluasi?: Partial<Record<JenisSsl, SslEval>>; ssl_versi?: Record<string, string> };
type OpPt = { alarm: number; laju_alarm: number; presisi: number | null; recall: number; tp: number };
type AntreanRow = Brief & { alasan_pilih: string; p: number | null; sd: number | null };
type Entitas = { entitas: string; aturan: string; kemiripan: number; flag: string[]; nama_samaran: string; kualitas: number;
  kandidat_sama: { entitas: string; kemiripan: number }[] };
type Peristiwa = Omit<Brief, "sinyal"> & { sinyal: Sinyal[]; tgl_pulang: string | null; keparahan: string | null; dx3: string | null; los: number | null; tarif: number | null;
  provinsi: string | null; peserta: number; keputusan_tanpa_mitigasi: Keputusan; proses_ms_per_klaim?: number; peringatan: string[];
  ml: { risiko_pct: number; ambang_pct: number; kelipatan: number | null; ditandai: boolean; model: string; segmen: string;
    alasan: { label: string; nilai: string | number; umumnya?: string | number }[] } | null;
  entitas?: Entitas | null; tanda_terima?: string | null; diterima: number; diputus: number; anggota?: Anggota | null; rujukan?: string | null;
  adaptif?: { p: number; sd: number; versi: string; mode: string } | null; ssl?: SslRec | null; skor_aturan?: number; lapis_faskes?: LapisFaskes | null };
/** Layer 1 (the hospital's own prevention) as declared with the claim, and the pre-checks of its draft. Never scored. */
type LapisFaskes = { sumber: string; kunci_draf: string | null;
  pencegahan: { gerbang: string; keputusan: string; temuan_jaringan: string[]; risiko_pct?: number | null; ditelaah_oleh?: string | null; catatan?: string | null; precheck: number } | null;
  precheck?: { id: string; pada: string; ringkas: Record<string, string | number | boolean | null>; dokumen: string[]; peringatan: string[];
    berubah: { medan: string; dari: string | number | boolean | null; ke: string | number | boolean | null }[] }[] };
type GNode = { id: string; jenis: "faskes" | "peserta"; label: string; kab?: string | null; tipe?: string | null; box?: string | null; burst?: boolean; fokus?: boolean };
type GEdge = { a: string; b: string; jenis: "klaim" | "pasangan_tidak_wajar"; klaim?: string; tanggal?: string; kode?: string; ritl?: boolean; biaya?: number;
  anggota?: number; ekspektasi?: number; p?: number };
type Graf = { nodes: GNode[]; edges: GEdge[]; jendela_hari?: number; jam_peristiwa?: string | null };
type Kasus = { id: string; jenis: "faskes" | "peserta" | "jaringan"; kunci: string; judul: string; status: string; dibuat: string; diperbarui: string;
  klaim_n: number; tahan_n: number; periksa_n: number; nilai_rp: number; skor_maks: number; sinyal: Record<string, number>; faskes: string[];
  sumber: Record<string, number>; prioritas: number; keputusan_tag?: { diputus: number; dibiarkan_sumber_lain: number; status_tag: string };
  modus?: Record<string, number>; jenis_peristiwa?: Record<string, number> };
type KasusRinci = Kasus & { klaim: Peristiwa[]; graf: Graf; riwayat: { t: string; status: string; oleh: string; catatan?: string }[] };
type Sim = { berjalan: boolean; laju: number; otomatis: boolean; terkirim: number;
  replay: { posisi: number; total: number; jendela: string[]; per_jenis?: Record<string, number> };
  skenario_ditanam: Record<string, number>; instans: number; antre_tanam: number; galat: string | null; selesai: boolean; skenario: Record<string, string>;
  modus_skenario?: Record<string, string[]>; unit_ditekan?: number };
type Sumber = { nama: string; kabkota_fkrtl_kode: number; kabkota_fkrtl: string; provinsi_fkrtl: string; kepemilikan_fkrtl: string; jenis_fkrtl: string;
  tipe_fkrtl?: string | null; regional_tarif?: string | null; catatan?: string };
type Status = { aktif: boolean; siap: boolean; galat: string | null; antrean: number; mulai: string | null;
  konfigurasi: { aktif: boolean; ambang_periksa: number; ambang_tahan: number; tulis_tag: boolean; box_otomatis: boolean };
  pemanasan: { detik?: number; model_run?: string; model_versi?: string; riwayat_baris?: number; jendela_replay?: string[]; pasangan_baseline?: number;
    faskes_baseline?: number; keparahan_populasi?: number; dipulihkan?: Record<string, number>;
    referensi?: { anggota?: number; kode?: number; pasangan_dx_kode?: number; fktp_profil?: number; fktp_unit?: number; tindakan_nonkap?: number; riwayat_dari?: string; riwayat_sampai?: string } };
  keputusan: Record<Keputusan, number>; jenis?: Record<JenisPeristiwa, number>; modus_alert?: Record<string, number>; gagal_diproses?: number;
  per_menit: number; per_menit_5: number; tren_20detik: number[];
  latensi_ms: { p50: number | null; p95: number | null; p99: number | null }; proses_ms_per_klaim: { p50: number | null; p95: number | null };
  kasus: { terbuka: number; dikonfirmasi: number; false_positive: number; total: number }; ditahan_rp: number; sinyal_alert: Record<string, number>;
  sumber: Record<string, { klaim: number; terakhir: string | null }>;
  integrasi: { tag_ditulis: number; tag_baru: number; box_terakhir: { pada: string; detik: number; faskes: number; estimasi_kerugian_rp: number } | null;
    box_galat: string | null; box_terjadwal: boolean; tag_galat?: string };
  graf: { klaim_di_jendela: number; peserta: number; faskes: number; pasangan_faskes: number; pasangan_tidak_wajar: number; cincin: number;
    lonjakan_keparahan: number; hari_teramati: number; jam_peristiwa: string | null; kematian_tercatat?: number; los_bergeser?: number;
    fktp_anomali_aktif?: number; unit_kontak_rendah?: number } | null;
  total_diputus: number; simulator: Sim; token_ingest: boolean; registri: Record<string, Sumber> };
type EvalSk = { label: string; modus?: string[]; instans: number; tertangkap: number; sinyal_tepat: number; klaim: number; klaim_alert: number;
  jeda_klaim_median: number | null; jeda_detik_median: number | null; sinyal: Record<string, number> };
type EvalNormal = { klaim: number; alert: number; tahan: number; porsi_alert: number | null;
  dikoreksi_verifikator_dasar: number | null; dikoreksi_di_antara_alert: number | null; lift: number | null; sinyal_alert: Record<string, number>; dicegah_mitigasi: number };
type Evaluasi = { ada: boolean; skenario?: Record<string, EvalSk>; normal?: EvalNormal; normal_per_jenis?: Record<string, EvalNormal>;
  ringkas?: { instans: number; tertangkap: number; sinyal_tepat: number };
  mitigasi?: { alert_normal_dicegah: number; klaim_tanam_lolos_karena_mitigasi: number }; latensi_ms?: { p50: number | null; p95: number | null; p99: number | null; n: number };
  catatan?: string };
type Jaringan = { cincin: { id: string; faskes: { id: string; label?: string; kab_nama?: string; tipe?: string }[]; pasangan: { a: string; b: string; anggota: number; ekspektasi: number; p: number }[]; peserta: number }[];
  lonjakan: { faskes: string; label?: string; n: number; k: number; p0: number; p: number }[] };

const BASE = "/api/aip/realtime/v1";
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${BASE}${path}`, { cache: "no-store", ...init });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const d = (body as { detail?: unknown }).detail;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 300) : `${r.status} ${r.statusText}`);
  }
  return r.json() as Promise<T>;
}
const post = <T,>(path: string, body: unknown, method = "POST") =>
  req<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const DEC: Record<Keputusan, { label: string; cls: string; bar: string }> = {
  LOLOS: { label: "LOLOS", cls: "border-[#199e70]/50 bg-[#199e70]/15 text-[#7fe0b8]", bar: "#199e70" },
  PERIKSA: { label: "PERIKSA", cls: "border-[#fab219]/50 bg-[#fab219]/15 text-[#fbd38d]", bar: "#fab219" },
  TAHAN: { label: "TAHAN", cls: "border-[#d03b3b]/60 bg-[#d03b3b]/20 text-[#ffb4b4]", bar: "#d03b3b" },
};
const STATUS_KASUS: Record<string, string> = { baru: "Baru", ditelaah: "Ditelaah", dikonfirmasi: "Dikonfirmasi", false_positive: "False positive" };

function rp(n: number | null | undefined): string {
  if (n == null) return "–";
  const a = Math.abs(n);
  if (a >= 1e12) return `Rp${(n / 1e12).toFixed(2).replace(".", ",")} triliun`;
  if (a >= 1e9) return `Rp${(n / 1e9).toFixed(2).replace(".", ",")} miliar`;
  if (a >= 1e6) return `Rp${(n / 1e6).toFixed(1).replace(".", ",")} juta`;
  return `Rp${Math.round(n).toLocaleString("id-ID")}`;
}
const nf = (n: number | null | undefined, d = 0) => (n == null ? "–" : n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const pctf = (n: number | null | undefined, d = 1) => (n == null ? "–" : `${(n * 100).toLocaleString("id-ID", { maximumFractionDigits: d })}%`);
const jam = (t: number) => new Date(t * 1000).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const wibIso = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "medium" }) : "–");

const JENIS_LABEL: Record<JenisPeristiwa, string> = { fkrtl: "Klaim FKRTL", fktp: "Kunjungan FKTP", nonkap: "Klaim nonkapitasi", faskes: "Pemantauan faskes" };
const JENIS_SHORT: Record<JenisPeristiwa, string> = { fkrtl: "FKRTL", fktp: "FKTP", nonkap: "Nonkap", faskes: "Pantau" };
const MODE_NAME: Record<string, string> = {
  M01: "Penyalahgunaan dana kapitasi", M02: "Manipulasi klaim nonkapitasi", M03: "Rujukan tidak sesuai", M04: "Upcoding", M05: "Cloning",
  M06: "Phantom billing", M07: "Inflated bills (M07/M19)", M08: "Pemecahan episode", M09: "Unbundling / fragmentation", M10: "Self-referral",
  M11: "Repeat billing", M12: "Prolonged LOS", M13: "Manipulasi kelas rawat", M14: "Tindakan tidak dilakukan", M15: "Tidak sesuai indikasi medis",
  M16: "Readmisi", M17: "Klaim fiktif obat/alkes/tindakan", M18: "Pengurangan jumlah obat", M20: "Manipulasi hasil pemeriksaan",
};
function ModeChips({ ids, max = 4 }: { ids: string[]; max?: number }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.slice(0, max).map((m) => <span key={m} title={MODE_NAME[m] ?? m} className="rounded border border-[#9d8cff]/40 bg-[#5b5fd6]/15 px-1 text-[10px] text-[#c9c0ff]">{m}</span>)}
      {ids.length > max && <span className="text-[10px] text-[#8f99a8]">+{ids.length - max}</span>}
    </span>
  );
}

function Badge({ d }: { d: Keputusan }) {
  return <span className={`inline-block rounded border px-1.5 py-px text-[10px] font-semibold tracking-wide ${DEC[d].cls}`}>{DEC[d].label}</span>;
}
function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded border border-white/[.07] bg-[#1c2127] px-3 py-2">
      <div className="truncate text-[10.5px] uppercase tracking-[0.08em] text-[#8f99a8]">{label}</div>
      <div className={`mt-0.5 truncate text-[19px] font-semibold tabular-nums ${tone ?? "text-white"}`}>{value}</div>
      {sub && <div className="truncate text-[10.5px] text-[#abb3bf]">{sub}</div>}
    </div>
  );
}
function Card({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded border border-white/[.07] bg-[#1c2127] ${className}`}>
      <div className="flex items-center gap-2 border-b border-white/[.06] px-3 py-1.5">
        <h3 className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[#e5e8eb]">{title}</h3>{right}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}
function ScoreBar({ skor, raw }: { skor: number; raw?: number }) {
  const c = skor >= 75 ? DEC.TAHAN.bar : skor >= 45 ? DEC.PERIKSA.bar : "#5f6b7c";
  return (
    <div className="flex items-center gap-1.5" title={raw != null && raw !== skor ? `tanpa mitigasi ${raw}` : undefined}>
      <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        {raw != null && raw > skor && <div className="absolute inset-y-0 left-0 rounded-full bg-white/20" style={{ width: `${Math.min(100, raw)}%` }} />}
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, skor)}%`, background: c }} />
      </div>
      <span className="w-7 text-right tabular-nums text-[11px] text-[#e5e8eb]">{Math.round(skor)}</span>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* the network: a small force layout, deterministic from the node order                                                */
/* ---------------------------------------------------------------------------------------------------------------- */
function layout(g: Graf, W: number, H: number): Record<string, { x: number; y: number }> {
  const n = g.nodes.length;
  const pos: Record<string, { x: number; y: number; vx: number; vy: number }> = {};
  // the focus facilities are pinned (one: the centre; several, a ring: on a circle), the rest float around them
  const pinned = g.nodes.filter((v) => v.fokus && v.jenis === "faskes");
  const pin = new Set(pinned.map((v) => v.id));
  pinned.forEach((v, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / pinned.length;
    const r = pinned.length > 1 ? Math.min(W * 0.36, H * 0.34) : 0;
    pos[v.id] = { x: W / 2 + r * Math.cos(a), y: H / 2 + r * Math.sin(a), vx: 0, vy: 0 };
  });
  g.nodes.filter((v) => !pin.has(v.id)).forEach((v, i) => {
    const a = (2 * Math.PI * i) / Math.max(n - pinned.length, 1);
    const r = Math.min(W, H) * (v.fokus ? 0.05 : 0.42);
    pos[v.id] = { x: W / 2 + r * Math.cos(a), y: H / 2 + r * Math.sin(a), vx: 0, vy: 0 };
  });
  const k = Math.sqrt((W * H) / Math.max(n, 1)) * 0.55;
  const ids = g.nodes.map((v) => v.id).filter((x) => !pin.has(x));
  const all = g.nodes.map((v) => v.id);
  for (let it = 0; it < 220; it++) {
    const t = 18 * (1 - it / 220) + 0.5;
    for (const a of all) { pos[a].vx = 0; pos[a].vy = 0; }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const p = pos[all[i]], q = pos[all[j]];
      let dx = p.x - q.x, dy = p.y - q.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (k * k) / d;
      dx /= d; dy /= d;
      p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
    }
    for (const e of g.edges) {
      if (e.jenis === "pasangan_tidak_wajar") continue;
      const p = pos[e.a], q = pos[e.b];
      if (!p || !q) continue;
      let dx = p.x - q.x, dy = p.y - q.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / k;
      dx /= d; dy /= d;
      p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f;
    }
    for (const a of ids) {
      const p = pos[a];
      const d = Math.max(0.01, Math.hypot(p.vx, p.vy));
      p.x += (p.vx / d) * Math.min(d, t); p.y += (p.vy / d) * Math.min(d, t);
      p.x = Math.min(W - 20, Math.max(20, p.x)); p.y = Math.min(H - 30, Math.max(16, p.y));
    }
  }
  return Object.fromEntries(Object.entries(pos).map(([id, p]) => [id, { x: p.x, y: p.y }]));
}
const BOX_FILL: Record<string, string> = { A: "#d03b3b", B: "#ec835a", C: "#fab219" };
function NetGraph({ g, height = 340, onPick }: { g: Graf; height?: number; onPick?: (n: GNode) => void }) {
  const W = 720, H = height;
  const pos = useMemo(() => layout(g, W, H), [g, H]);
  const [hover, setHover] = useState<string | null>(null);
  if (!g.nodes.length) return <p className="text-[11.5px] text-[#8f99a8]">Belum ada jaringan di jendela aliran untuk entitas ini.</p>;
  const near = new Set<string>();
  if (hover) g.edges.forEach((e) => { if (e.a === hover) near.add(e.b); if (e.b === hover) near.add(e.a); });
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" className="block max-w-full rounded bg-[#141920]" role="img" aria-label="Jaringan peserta dan faskes di sekitar entitas">
        {g.edges.map((e, i) => {
          const p = pos[e.a], q = pos[e.b];
          if (!p || !q) return null;
          const dim = hover && e.a !== hover && e.b !== hover;
          return e.jenis === "pasangan_tidak_wajar" ? (
            <g key={i} opacity={dim ? 0.25 : 1}>
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#d03b3b" strokeWidth={3} strokeDasharray="6 4" />
              <rect x={(p.x + q.x) / 2 - 15} y={(p.y + q.y) / 2 - 8} width={30} height={16} rx={8} fill="#2a1416" stroke="#d03b3b" strokeWidth={1} />
              <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 + 3.5} fill="#ffb4b4" fontSize={10} fontWeight={600} textAnchor="middle">{e.anggota}</text>
              <title>{`Pasangan tidak wajar: ${e.anggota} peserta bersama, ekspektasi riwayat ${e.ekspektasi}, Poisson p = ${e.p?.toExponential(1)}`}</title>
            </g>
          ) : (
            <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={e.ritl ? "#8f99a8" : "#4b5563"} strokeWidth={e.ritl ? 1.4 : 1} opacity={dim ? 0.15 : 0.7}>
              <title>{`Klaim ${e.klaim?.split(":").pop()} · ${e.tanggal} · ${e.kode}${e.ritl ? " · rawat inap" : ""} · ${rp(e.biaya)}`}</title>
            </line>
          );
        })}
        {g.nodes.map((v) => {
          const p = pos[v.id];
          if (!p) return null;
          const dim = hover && v.id !== hover && !near.has(v.id);
          const fill = v.jenis === "faskes" ? (v.box ? BOX_FILL[v.box] ?? "#3987e5" : v.burst ? "#c98500" : "#3987e5") : "#9d8cff";
          return (
            <g key={v.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.3 : 1} onMouseEnter={() => setHover(v.id)} onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(v)} className={onPick ? "cursor-pointer" : undefined}>
              {v.jenis === "faskes"
                ? <rect x={-9} y={-9} width={18} height={18} rx={4} fill={fill} stroke={v.fokus ? "#fff" : "#141920"} strokeWidth={v.fokus ? 2.5 : 2} />
                : <circle r={v.fokus ? 8 : 5} fill={fill} stroke={v.fokus ? "#fff" : "#141920"} strokeWidth={2} />}
              {(v.jenis === "faskes" || v.fokus || hover === v.id) && (
                <text y={v.jenis === "faskes" ? 22 : 16} fill="#d3d8de" fontSize={10} textAnchor="middle" paintOrder="stroke" stroke="#141920" strokeWidth={3}>
                  {v.label.length > 30 ? v.label.slice(0, 29) + "…" : v.label}</text>
              )}
              <title>{v.jenis === "faskes" ? `${v.label}${v.box ? ` · Box Karantina ${v.box}` : ""}${v.burst ? " · lonjakan keparahan III" : ""}` : v.label}</title>
            </g>
          );
        })}
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-[#abb3bf]">
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#3987e5]" />Faskes</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#d03b3b]" />Faskes di Box Karantina A (B oranye, C kuning)</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-[#9d8cff]" />Peserta</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-[#8f99a8]" />Klaim (tebal: rawat inap)</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-[#d03b3b]" />Pasangan faskes tidak wajar (angka: peserta bersama; arahkan kursor untuk ekspektasinya)</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* one decision, explained                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */
const TINGKAT: Record<string, { label: string; cls: string; dot: string }> = {
  biasa: { label: "Lazim", cls: "border-white/15 bg-white/[.06] text-[#d3d8de]", dot: "#8f99a8" },
  tidak_lazim: { label: "Tidak lazim", cls: "border-[#fab219]/50 bg-[#fab219]/15 text-[#fbd38d]", dot: "#fab219" },
  anomali: { label: "Anomali", cls: "border-[#d03b3b]/60 bg-[#d03b3b]/20 text-[#ffb4b4]", dot: "#d03b3b" },
};
const SSL_NAMA: Record<string, string> = { fkrtl: "klaim FKRTL", fktp: "kunjungan FKTP", nonkap: "klaim nonkapitasi", faskes: "peristiwa" };

/** Where this record's reconstruction error sits on the held-out scale (three zones, log-spaced inside each), and the fields
 *  the self-supervised network could not reconstruct: what this record has vs what records like it have. */
function SslView({ s, jenis }: { s: SslRec; jenis: JenisPeristiwa }) {
  const t = s.tingkat ? TINGKAT[s.tingkat] : null;
  const [p50, p99, p999] = s.skala ?? [0, 0, 0];
  // zones: lazim 0–62 %, tidak lazim 62–84 %, anomali 84–100 % of the bar
  const pos = (() => {
    if (!p99 || !p999 || !p50) return null;
    const lg = (v: number) => Math.log(Math.max(v, 1e-6));
    const lerp = (v: number, a: number, b: number, x0: number, x1: number) => x0 + ((x1 - x0) * Math.min(1, Math.max(0, (lg(v) - lg(a)) / (lg(b) - lg(a) || 1))));
    if (s.err <= p99) return lerp(s.err, p50 / 4, p99, 0, 62);
    if (s.err <= p999) return lerp(s.err, p99, p999, 62, 84);
    return lerp(s.err, p999, p999 * 4, 84, 99);
  })();
  return (
    <div className="mb-3 rounded border border-white/[.07] bg-[#141920] p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-[#e5e8eb]">Self-supervised: seberapa lazim {SSL_NAMA[jenis]} ini</span>
        {t && <span className={`rounded border px-1.5 py-px text-[10px] font-semibold ${t.cls}`}>{t.label}</span>}
      </div>
      {s.basi ? (
        <p className="text-[11px] text-[#abb3bf]">Dinilai model self-supervised versi lama ({s.versi ?? "tanpa versi"}); skala dan penjelasan versi sekarang tidak berlaku untuk nilai ini.</p>
      ) : pos != null && (
        <div className="mb-2">
          <div className="relative h-2 overflow-visible rounded-full" role="img" aria-label={`posisi galat rekonstruksi: ${t?.label ?? ""}`}>
            <div className="absolute inset-y-0 left-0 w-[62%] rounded-l-full bg-white/[.10]" />
            <div className="absolute inset-y-0 left-[62%] w-[22%] bg-[#fab219]/30" />
            <div className="absolute inset-y-0 left-[84%] w-[16%] rounded-r-full bg-[#d03b3b]/35" />
            <div className="absolute -top-1 h-4 w-1 -translate-x-1/2 rounded-full bg-white shadow ring-2 ring-[#141920]" style={{ left: `${pos}%` }} />
          </div>
          <div className="mt-1 grid grid-cols-[62fr_22fr_16fr] text-[10px] text-[#8f99a8]">
            <span>lazim</span><span>≥ p99</span><span>≥ p99,9</span>
          </div>
          <p className="mt-1 text-[10.5px] text-[#abb3bf]">
            Galat rekonstruksi {dec(s.err, 3)}; ambang data held-out p99 {dec(p99, 3)}, p99,9 {dec(p999, 3)}.
          </p>
        </div>
      )}
      {!!s.alasan?.length && !s.basi ? (<>
        <div className="mb-1 text-[10.5px] text-[#8f99a8]">Bagian yang tidak bisa direkonstruksi jaringan (porsi galat):</div>
        <table className="w-full text-[11px]">
          <thead className="text-left text-[10px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr>
            <th className="py-0.5 pr-2 font-medium">Bagian</th><th className="pr-2 font-medium">Peristiwa ini</th><th className="pr-2 font-medium">Pola serupa</th><th className="w-16 font-medium">Porsi</th></tr></thead>
          <tbody>
            {s.alasan.map((a) => (
              <tr key={a.fitur} className="border-t border-white/[.05] align-top">
                <td className="py-1 pr-2 text-[#d3d8de]">{a.label}</td>
                <td className="pr-2 tabular-nums text-white">{a.nilai}{a.arah ? <span className="ml-1 text-[10px] text-[#8f99a8]">({a.arah})</span> : null}</td>
                <td className="pr-2 tabular-nums text-[#abb3bf]">{a.pola}</td>
                <td className="py-1.5"><div className="h-1.5 rounded-full bg-white/[.06]"><div className="h-full rounded-full bg-[#3987e5]" style={{ width: `${Math.min(100, a.porsi * 100)}%` }} /></div>
                  <div className="text-right text-[10px] tabular-nums text-[#8f99a8]">{pctf(a.porsi, 0)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </>) : !s.basi && s.tingkat === "biasa" ? (
        <p className="text-[11px] text-[#abb3bf]">Sesuai pola yang dipelajari dari ratusan ribu {SSL_NAMA[jenis]} tanpa label.</p>
      ) : null}
    </div>
  );
}

/** Requests for supporting documents to the hospital that sent the claim. The hospital sees the request and the claim's
 *  processing status in its own system; never the score, the decision or the signals. */
function RequestPanel({ id, admin, sumber }: { id: string; admin: boolean; sumber: string }) {
  const [v, setV] = useState<PermintaanView | null>(null);
  const [draft, setDraft] = useState<(Butir & { on: boolean })[] | null>(null);
  const [pesan, setPesan] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { req<PermintaanView>(`/peristiwa/${id}/permintaan`).then(setV).catch((x) => setMsg((x as Error).message)); }, [id]);
  useEffect(() => { load(); }, [load]);
  const start = () => { if (!v) return; setDraft(v.draf.butir.map((b) => ({ ...b, on: true }))); setPesan(v.draf.pesan); setMsg(""); };
  const send = async () => {
    const butir = (draft ?? []).filter((b) => b.on && b.isi.trim() && b.dokumen.trim()).map(({ medan, isi, dokumen }) => ({ medan: medan.trim() || isi.trim().slice(0, 60), isi: isi.trim(), dokumen: dokumen.trim() }));
    if (!butir.length) { setMsg("Pilih atau tulis minimal satu butir."); return; }
    setBusy(true); setMsg("");
    try { await post(`/peristiwa/${id}/permintaan`, { pesan, butir }); setDraft(null); load(); setMsg("Permintaan terkirim ke sistem faskes."); }
    catch (x) { setMsg((x as Error).message); } finally { setBusy(false); }
  };
  const set = (i: number, k: keyof Butir | "on", val: string | boolean) => setDraft((d) => d && d.map((b, j) => (j === i ? { ...b, [k]: val } : b)));
  if (!v) return null;
  const inp = "w-full rounded border border-white/15 bg-[#10151b] px-1.5 py-1 text-[11px] text-white placeholder:text-[#5f6b7c] focus:border-[#3987e5] focus:outline-none";
  return (
    <div className="mt-3 rounded border border-white/[.07] bg-[#141920] p-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-[#e5e8eb]">Permintaan kelengkapan ke faskes</span>
        {v.bisa && admin && !draft && <button onClick={start} className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-white hover:bg-white/10">Siapkan permintaan</button>}
      </div>
      {!v.bisa ? (
        <p className="text-[11px] text-[#8f99a8]">Hanya untuk klaim yang dikirim sistem faskes (ada tanda terima). Peristiwa ini dari {sumber}.</p>
      ) : (<>
        <p className="mb-2 text-[10.5px] leading-snug text-[#8f99a8]">
          Dikirim ke {v.faskes?.sumber} untuk klaim <span className="font-mono">{v.faskes?.klaim.slice(0, 8)}</span>. Faskes melihat status klaim dan permintaan ini,
          tidak melihat skor, keputusan, atau sinyal deteksi.
        </p>
        {v.riwayat.map((r) => (
          <div key={r.id} className="mb-2 rounded border border-white/[.06] p-2">
            <div className="mb-1 flex items-center gap-2 text-[10.5px]">
              <span className={`rounded px-1.5 py-px font-semibold ${r.status === "dibalas" ? "bg-[#199e70]/20 text-[#7fe0b8]" : "bg-white/10 text-[#d3d8de]"}`}>{r.status === "dibalas" ? "Dibalas" : "Menunggu balasan"}</span>
              <span className="text-[#8f99a8]">dikirim {wibIso(r.dibuat)}</span>
            </div>
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-[#d3d8de]">{r.butir.map((b, i) => <li key={i}>{b.isi} → <span className="text-white">{b.dokumen}</span></li>)}</ul>
            {r.balasan && <div className="mt-1.5 rounded bg-[#199e70]/10 p-1.5 text-[11px] text-[#d3d8de]"><span className="text-[10px] text-[#7fe0b8]">Balasan faskes · {wibIso(r.dibalas)}</span><br />{r.balasan}</div>}
          </div>
        ))}
        {!v.riwayat.length && !draft && <p className="text-[11px] text-[#8f99a8]">Belum ada permintaan.{admin ? " Draf disusun dari bagian klaim yang tidak lazim dan sinyal tingkat klaim; sunting sebelum dikirim." : ""}</p>}
        {draft && (
          <div className="space-y-2">
            <label className="block text-[10.5px] text-[#8f99a8]">Pesan pembuka
              <textarea value={pesan} onChange={(x) => setPesan(x.target.value)} rows={2} maxLength={1000} className={`mt-0.5 ${inp}`} />
            </label>
            <div className="text-[10.5px] text-[#8f99a8]">Butir permintaan (centang yang dikirim)</div>
            {draft.map((b, i) => (
              <div key={i} className={`rounded border p-1.5 ${b.on ? "border-white/15" : "border-white/[.05] opacity-60"}`}>
                <div className="flex items-start gap-1.5">
                  <input type="checkbox" checked={b.on} onChange={(x) => set(i, "on", x.target.checked)} className="mt-1 accent-[#3987e5]" aria-label="kirim butir ini" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <input value={b.isi} onChange={(x) => set(i, "isi", x.target.value)} maxLength={400} placeholder="Yang perlu dijelaskan" className={inp} />
                    <input value={b.dokumen} onChange={(x) => set(i, "dokumen", x.target.value)} maxLength={300} placeholder="Dokumen yang diminta" className={inp} />
                    {b.asal && <div className="text-[9.5px] text-[#5f6b7c]">dari {b.asal} (tidak terlihat oleh faskes)</div>}
                  </div>
                </div>
              </div>
            ))}
            <button onClick={() => setDraft((d) => [...(d ?? []), { medan: "", isi: "", dokumen: "", on: true }])} className="text-[11px] text-[#8abbff] hover:underline">+ Tambah butir</button>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setDraft(null)} className="rounded px-2 py-1 text-[11px] text-[#abb3bf] hover:bg-white/5">Batal</button>
              <button disabled={busy} onClick={send} className="rounded border border-[#3987e5]/60 bg-[#3987e5]/20 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#3987e5]/30 disabled:opacity-50">{busy ? "Mengirim…" : "Kirim ke faskes"}</button>
            </div>
          </div>
        )}
      </>)}
      {msg && <p className="mt-1.5 text-[11px] text-[#d3d8de]">{msg}</p>}
    </div>
  );
}

const GERBANG: Record<string, { label: string; cls: string }> = {
  fix: { label: "Fix", cls: "border-[#f57f7f]/50 text-[#ffb3b3]" },
  hold: { label: "Hold", cls: "border-[#fbd38d]/50 text-[#fbd38d]" },
  check: { label: "Check", cls: "border-[#8abbff]/50 text-[#b5d3ff]" },
  pass: { label: "Pass", cls: "border-[#7fe0b8]/50 text-[#7fe0b8]" },
  "tidak-tersedia": { label: "tidak tersedia", cls: "border-white/20 text-[#abb3bf]" },
};
const KEPUTUSAN_FASKES: Record<string, string> = {
  lolos: "lolos tanpa dialog", "diteruskan-dengan-alasan": "diteruskan dengan alasan tertulis", "ditelaah-klinis": "ditelaah klinis", "dicek-ulang": "dicek ulang koder",
};
const TEMUAN_JARINGAN: Record<string, string> = {
  "rawat-tumpang-tindih": "rawat inap tumpang tindih", "episode-dipecah": "episode dipecah", "kartu-dipinjam": "kartu dipakai orang lain",
  jaringan: "jaringan pasien terkait", "pasangan-keparahan": "pola keparahan koder + DPJP", readmisi: "readmisi ≤ 30 hari", "rm-ganda": "no RM ganda",
  "identitas-berbeda": "identitas berbeda dengan registrasi",
};
/** The server writes UTC; the page shows local time like the rest of the feed. */
const jamLokal = (iso: string) => {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? iso.slice(11, 16) : d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
};
const MEDAN_PRECHECK: Record<string, string> = { inacbg: "INA-CBG", dx: "diagnosis utama", dx_sekunder: "dx sekunder", tindakan: "tindakan", los: "lama rawat", biaya: "tagihan", kelas_rawat: "kelas rawat", topup: "top-up" };

/**
 * Layer 1 as the auditor sees it: what the hospital's own gate decided before it submitted (a declaration, not scored)
 * and the pre-checks of the draft, with what changed between them. Context for a person, never a signal.
 */
function FaskesLayer({ l }: { l: LapisFaskes }) {
  const p = l.pencegahan;
  const pcs = l.precheck ?? [];
  const g = GERBANG[p?.gerbang ?? "tidak-tersedia"] ?? GERBANG["tidak-tersedia"];
  return (
    <div className="mb-3 rounded border border-white/[.07] bg-[#141920] p-2.5">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-[#e5e8eb]">
        Lapis 1 · pencegahan di rumah sakit
        <span className="font-normal text-[#8f99a8]">deklarasi faskes, tidak diskor</span>
      </div>
      {p ? (
        <div className="space-y-1 text-[11.5px] text-[#d3d8de]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded border px-1.5 py-px text-[10.5px] ${g.cls}`}>gerbang {g.label}</span>
            <span>{KEPUTUSAN_FASKES[p.keputusan] ?? (p.keputusan || "-")}</span>
            {p.ditelaah_oleh && <span className="text-[#abb3bf]">· penelaah {p.ditelaah_oleh}</span>}
            {p.risiko_pct != null && <span className="text-[#8f99a8]">· model risiko RS {p.risiko_pct}%</span>}
          </div>
          {!!p.temuan_jaringan.length && (
            <div className="text-[11px] text-[#fbd38d]">network check RS: {p.temuan_jaringan.map((t) => TEMUAN_JARINGAN[t] ?? t).join(", ")}</div>
          )}
          {p.catatan && <div className="text-[11px] italic text-[#abb3bf]">“{p.catatan}”</div>}
        </div>
      ) : (
        <div className="text-[11.5px] text-[#8f99a8]">Kiriman ini tidak membawa keputusan gerbang rumah sakit.</div>
      )}
      <div className="mt-2 border-t border-white/[.06] pt-1.5 text-[11px] text-[#abb3bf]">
        {pcs.length ? (
          <>
            <div className="mb-0.5 text-[#d3d8de]">{pcs.length} pre-check sebelum dikirim (dokumen yang akan dicari verifikator; tanpa skor)</div>
            <ol className="space-y-0.5">
              {pcs.map((c, i) => (
                <li key={c.id} className="tabular-nums">
                  <span className="text-[#8f99a8]">{jamLokal(c.pada)}</span>{" "}
                  {i === 0 ? "draf awal" : c.berubah.length ? c.berubah.map((b) => `${MEDAN_PRECHECK[b.medan] ?? b.medan} ${b.dari ?? "–"} → ${b.ke ?? "–"}`).join("; ") : "tanpa perubahan tagihan"}
                  {c.dokumen.length ? <span className="text-[#8f99a8]"> · {c.dokumen.length} dokumen</span> : null}
                  {c.peringatan.length ? <span className="text-[#ffb3b3]"> · {c.peringatan.length} konflik kiriman sendiri</span> : null}
                </li>
              ))}
            </ol>
          </>
        ) : (
          "Tidak ada pre-check untuk draf ini."
        )}
      </div>
    </div>
  );
}

function EventDetail({ id, admin, onClose }: { id: string; admin: boolean; onClose: () => void }) {
  const [e, setE] = useState<Peristiwa | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { req<Peristiwa>(`/peristiwa/${id}`).then(setE).catch((x) => setErr((x as Error).message)); }, [id]);
  const max = Math.max(0.01, ...(e?.sinyal ?? []).map((s) => s.kontribusi_tanpa_mitigasi));
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="h-full w-[min(560px,100vw)] overflow-y-auto border-l border-white/10 bg-[#1b2128] p-4 text-[12px] shadow-2xl" onClick={(x) => x.stopPropagation()}>
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-[#8f99a8]">Keputusan realtime</div>
            <div className="truncate text-[14px] font-semibold text-white">{e?.kunjungan ?? id}</div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-[#abb3bf] hover:bg-white/10" aria-label="Tutup"><Icon name="x" className="h-4 w-4" /></button>
        </div>
        {err && <p className="text-red-300">{err}</p>}
        {e && (<>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Badge d={e.keputusan} /><ScoreBar skor={e.skor} raw={e.skor_tanpa_mitigasi} />
            {e.keputusan_tanpa_mitigasi !== e.keputusan && <span className="text-[11px] text-[#7fe0b8]">tanpa konteks mitigasi: {e.keputusan_tanpa_mitigasi}</span>}
            <span className="text-[11px] text-[#abb3bf]">latensi {nf(e.latensi_ms)} ms · {e.sumber}{e.versi > 1 ? ` · versi ${e.versi}` : ""}</span>
          </div>
          <dl className="mb-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[11.5px]">
            <dt className="text-[#8f99a8]">Jenis</dt><dd className="text-[#e5e8eb]">{JENIS_LABEL[e.jenis ?? "fkrtl"]}</dd>
            <dt className="text-[#8f99a8]">Faskes</dt><dd className="text-[#e5e8eb]">{e.faskes_label}</dd>
            <dt className="text-[#8f99a8]">Layanan</dt><dd>{e.tingkat ?? "-"} · {e.tgl_datang}{e.tgl_pulang && e.tgl_pulang !== e.tgl_datang ? ` s.d. ${e.tgl_pulang}` : ""}{e.los != null ? ` · ${e.los} hari` : ""}</dd>
            <dt className="text-[#8f99a8]">{e.jenis === "fktp" ? "Poli" : e.jenis === "nonkap" ? "Tindakan" : "Kode"}</dt><dd>{e.kode}{e.keparahan ? ` · ${e.keparahan}` : ""} · dx {e.dx3 ?? "-"}{e.rujukan ? ` · dirujuk ke ${e.rujukan}` : ""}</dd>
            {!!e.biaya && <><dt className="text-[#8f99a8]">Tagihan</dt><dd className="tabular-nums">{rp(e.biaya)}{e.tarif ? ` (tarif INA-CBG ${rp(e.tarif)})` : ""}</dd></>}
            {!!e.peserta && <><dt className="text-[#8f99a8]">Peserta</dt><dd className="tabular-nums">…{String(e.peserta).slice(-4)}{e.anggota ? ` · ${e.anggota.jk === "L" ? "laki-laki" : e.anggota.jk === "P" ? "perempuan" : "-"}, lahir ${e.anggota.tahun_lahir ?? "-"}, hak kelas ${e.anggota.hak_kelas ?? "-"}, ${e.anggota.segmen ?? "-"}${e.anggota.tahun_meninggal ? `, registri: meninggal ${e.anggota.tahun_meninggal}` : ""}` : ""}</dd></>}
            {e.ml && <><dt className="text-[#8f99a8]">Model ML</dt><dd>{e.ml.risiko_pct.toFixed(3)}% peluang dikoreksi · {e.ml.kelipatan?.toFixed(2) ?? "–"}× ambang ({e.ml.model}, {e.ml.segmen})</dd></>}
            {!!e.modus?.length && <><dt className="text-[#8f99a8]">Modus</dt><dd><ModeChips ids={e.modus} /></dd></>}
            {e.adaptif && <><dt className="text-[#8f99a8]">Model adaptif</dt><dd>peluang perlu tindakan {pctf(e.adaptif.p, 1)} ± {pctf(e.adaptif.sd, 1)} (ketidaksepakatan komite) · {e.adaptif.mode === "aktif" ? `memutus; skor aturan ${e.skor_aturan ?? "-"}` : "bayangan"} · {e.adaptif.versi}</dd></>}
          </dl>
          {e.ssl && <SslView s={e.ssl} jenis={e.jenis ?? "fkrtl"} />}
          {e.entitas && (
            <div className="mb-3 rounded border border-white/[.07] bg-[#141920] p-2.5">
              <div className="mb-1 text-[11px] font-semibold text-[#e5e8eb]">Entity resolution pasien (kiriman faskes)</div>
              <div className="text-[11.5px] text-[#d3d8de]">{e.entitas.nama_samaran} → entitas <span className="font-mono">{e.entitas.entitas}</span> · aturan {e.entitas.aturan.replace(/_/g, " ")} · kualitas {pctf(e.entitas.kualitas, 0)}</div>
              {e.entitas.flag.map((f) => <div key={f} className="mt-1 text-[11px] text-[#fbd38d]">⚠ {f}</div>)}
            </div>
          )}
          {e.lapis_faskes && <FaskesLayer l={e.lapis_faskes} />}
          <h4 className="mb-1.5 text-[11.5px] font-semibold text-[#e5e8eb]">Sinyal dan kontribusinya ke skor</h4>
          {!e.sinyal.length && <p className="text-[11.5px] text-[#8f99a8]">Tidak ada sinyal: klaim lolos.</p>}
          <div className="space-y-2.5">
            {e.sinyal.map((s) => (
              <div key={s.kode} className="rounded border border-white/[.06] bg-[#141920] p-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-[#e5e8eb]">{s.label}</span>
                  {s.tag && <span className="rounded bg-white/10 px-1 py-px text-[9.5px] text-[#abb3bf]">tag {s.tag}</span>}
                  <span className="tabular-nums text-[11px] text-[#d3d8de]">{s.kontribusi.toFixed(2)}</span>
                </div>
                <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-white/[.06]">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-white/20" style={{ width: `${(100 * s.kontribusi_tanpa_mitigasi) / max}%` }} />
                  <div className="absolute inset-y-0 left-0 rounded-full bg-[#ec835a]" style={{ width: `${(100 * s.kontribusi) / max}%` }} />
                </div>
                <p className="mt-1 text-[11px] leading-snug text-[#abb3bf]">{s.bukti}</p>
                <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">kekuatan {s.s} × bobot {s.w}{s.mitigasi.length ? ` × (1 − mitigasi)` : ""} · fokus {s.fokus[0]}{s.modus?.length ? ` · ${s.modus.join(", ")}` : ""}</p>
                {s.mitigasi.map((m) => <p key={m.kode} className="mt-0.5 text-[10.5px] text-[#7fe0b8]">↓ mitigasi {Math.round(m.faktor * 100)}%: {m.label}</p>)}
              </div>
            ))}
          </div>
          {!!e.ml?.alasan?.length && (<>
            <h4 className="mb-1 mt-3 text-[11.5px] font-semibold text-[#e5e8eb]">Alasan model (TreeSHAP)</h4>
            <ul className="space-y-0.5 text-[11px] text-[#d3d8de]">
              {e.ml?.alasan.map((a) => <li key={a.label}>{a.label}: <span className="tabular-nums">{String(a.nilai)}</span>{a.umumnya != null ? <span className="text-[#8f99a8]"> (umumnya {String(a.umumnya)})</span> : null}</li>)}
            </ul>
          </>)}
          {!!e.peringatan?.length && <div className="mt-3 text-[11px] text-[#fbd38d]">{e.peringatan.map((p) => <div key={p}>⚠ {p}</div>)}</div>}
          <RequestPanel id={e.id} admin={admin} sumber={e.sumber} />
          <p className="mt-4 text-[10.5px] leading-snug text-[#8f99a8]">
            Skor = 100 × (1 − e<sup>−Σ kontribusi</sup>); kontribusi = kekuatan × bobot × (1 − mitigasi). Bar abu-abu = tanpa mitigasi. Keputusan adalah
            indikasi untuk diperiksa manusia, bukan bukti fraud. Data sintetis.
          </p>
        </>)}
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Live                                                                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */
function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-28 items-end gap-[2px]" role="img" aria-label="Klaim diputus per 20 detik, 10 menit terakhir">
      {values.map((v, i) => (
        <div key={i} className="group relative flex-1 rounded-t-[2px] bg-[#3987e5]" style={{ height: `${Math.max(2, (100 * v) / max)}%`, opacity: v ? 1 : 0.25 }}>
          <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1 text-[10px] text-white group-hover:block">{v} klaim</span>
        </div>
      ))}
    </div>
  );
}

function LiveView({ st, admin, onOpen, refresh }: { st: Status; admin: boolean; onOpen: (id: string) => void; refresh: () => void }) {
  const [rows, setRows] = useState<Brief[]>([]);
  const [alertOnly, setAlertOnly] = useState(false);
  const [laju, setLaju] = useState(st.simulator.laju || 20);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await req<{ baris: Brief[]; seq: number }>(`/umpan?sejak=${seq.current}&limit=150`);
        if (!live) return;
        if (r.seq < seq.current) { seq.current = 0; setRows([]); return; }
        if (r.baris.length) {
          seq.current = Math.max(seq.current, ...r.baris.map((b) => b.seq || 0));
          setRows((old) => [...r.baris.slice().reverse(), ...old].slice(0, 400));
        }
      } catch { /* the next tick tries again */ }
    };
    tick();
    const t = setInterval(() => { if (document.visibilityState === "visible") tick(); }, 1000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const act = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what); setErr("");
    try { await f(); refresh(); } catch (x) { setErr((x as Error).message); } finally { setBusy(""); }
  };
  const total = st.keputusan.LOLOS + st.keputusan.PERIKSA + st.keputusan.TAHAN;
  const shown = (alertOnly ? rows.filter((r) => r.keputusan !== "LOLOS") : rows).slice(0, 60);
  const sim = st.simulator;
  const sig = Object.entries(st.sinyal_alert).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const sigMax = Math.max(1, ...sig.map((x) => x[1]));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Peristiwa / menit" value={nf(st.per_menit)} sub={`rata-rata 5 menit ${nf(st.per_menit_5, 1)} · ${pctf(total ? (st.keputusan.PERIKSA + st.keputusan.TAHAN) / total : null, 2)} alert`} />
        <Tile label="Latensi p50 · p95" value={`${nf(st.latensi_ms.p50)} · ${nf(st.latensi_ms.p95)} ms`} sub={`terima → putus; proses ${nf(st.proses_ms_per_klaim.p50, 1)} ms/klaim`} />
        <Tile label="Diputus" value={nf(st.total_diputus)} sub={st.jenis ? `${nf(st.jenis.fkrtl)} FKRTL · ${nf(st.jenis.fktp)} FKTP · ${nf(st.jenis.nonkap)} nonkap` : `${pctf(total ? st.keputusan.PERIKSA / total : null, 2)} periksa · ${pctf(total ? st.keputusan.TAHAN / total : null, 2)} tahan`} />
        <Tile label="Kasus terbuka" value={nf(st.kasus.terbuka)} sub={`${nf(st.kasus.dikonfirmasi)} dikonfirmasi · ${nf(st.kasus.false_positive)} false positive`} tone={st.kasus.terbuka ? "text-[#fbd38d]" : undefined} />
        <Tile label="Nilai di kasus TAHAN" value={rp(st.ditahan_rp)} sub="tagihan klaim kasus terbuka yang ditahan" />
        <Tile label="Tag ke ledger indikasi" value={nf(st.integrasi.tag_ditulis)} sub={`${nf(st.integrasi.tag_baru)} tag baru · Box ${st.integrasi.box_terjadwal ? "dijadwalkan" : st.integrasi.box_terakhir ? "terbarui" : "–"}`} />
      </div>
      <div className="grid items-start gap-3 xl:grid-cols-[1fr_380px]">
        <Card title="Klaim diputus per 20 detik (10 menit terakhir)" right={<span className="text-[10.5px] text-[#8f99a8]">antrean {nf(st.antrean)}</span>}>
          <Spark values={st.tren_20detik} />
          <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-white/[.06]" role="img" aria-label="Komposisi keputusan">
            {(["LOLOS", "PERIKSA", "TAHAN"] as Keputusan[]).map((k) => total ? <div key={k} style={{ width: `${Math.max(st.keputusan[k] ? 0.6 : 0, (100 * st.keputusan[k]) / total)}%`, background: DEC[k].bar }} title={`${k}: ${st.keputusan[k]}`} /> : null)}
          </div>
          <div className="mt-1 flex gap-4 text-[10.5px] text-[#abb3bf]">
            {(["LOLOS", "PERIKSA", "TAHAN"] as Keputusan[]).map((k) => <span key={k} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: DEC[k].bar }} />{k} {nf(st.keputusan[k])}</span>)}
          </div>
        </Card>
        <Card title="Sumber klaim" right={sim.berjalan ? <span className="flex items-center gap-1 text-[10.5px] text-[#7fe0b8]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#7fe0b8]" />simulator berjalan</span> : null}>
          <div className="space-y-2 text-[11.5px]">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-[#e5e8eb]">Simulator (replay sintetis)</span>
                <span className="ml-auto tabular-nums text-[#abb3bf]">{nf(sim.replay.posisi)} / {nf(sim.replay.total)}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full bg-[#3987e5]" style={{ width: `${sim.replay.total ? (100 * sim.replay.posisi) / sim.replay.total : 0}%` }} /></div>
              <p className="mt-1 text-[10.5px] text-[#8f99a8]">
                {sim.replay.jendela.join(" s.d. ")} (edisi reguler): {sim.replay.per_jenis ? `${nf(sim.replay.per_jenis.fkrtl)} klaim FKRTL, ${nf(sim.replay.per_jenis.fktp)} kunjungan FKTP, ${nf(sim.replay.per_jenis.nonkap)} klaim nonkapitasi` : "klaim"} diputar
                berselang urut tanggal layanan; {sim.instans} skenario fraud ditanam{sim.unit_ditekan ? `, ${sim.unit_ditekan} unit Puskesmas ditekan kunjungannya` : ""}{sim.selesai ? " · replay selesai" : ""}.</p>
              {admin && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {sim.berjalan
                    ? <button disabled={!!busy} onClick={() => act("stop", () => post("/simulator", { aksi: "berhenti" }))} className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 hover:bg-white/10"><Icon name="pause" className="h-3 w-3" />Jeda</button>
                    : <button disabled={!!busy || !st.aktif} onClick={() => act("start", () => post("/simulator", { aksi: "mulai", laju, otomatis: sim.otomatis }))} className="flex items-center gap-1 rounded border border-[#3987e5]/60 bg-[#3987e5]/20 px-2 py-0.5 text-white hover:bg-[#3987e5]/30 disabled:opacity-40"><Icon name="play" className="h-3 w-3" />Mulai</button>}
                  <label className="flex items-center gap-1 text-[10.5px] text-[#abb3bf]">laju
                    <select value={laju} onChange={(x) => { const v = Number(x.target.value); setLaju(v); if (sim.berjalan) act("rate", () => post("/simulator", { aksi: "mulai", laju: v, otomatis: sim.otomatis })); }}
                      className="rounded border border-white/15 bg-[#141920] px-1 py-0.5 text-[11px] text-white">
                      {[5, 10, 20, 40, 80, 150].map((v) => <option key={v} value={v}>{v}/detik</option>)}
                    </select>
                  </label>
                  <button disabled={!!busy} onClick={() => act("reset", () => post("/simulator", { aksi: "reset" }))} className="rounded border border-white/15 px-2 py-0.5 text-[#abb3bf] hover:bg-white/10" title="Replay mulai lagi dari awal (keputusan yang sudah ada tetap)">Ulang replay</button>
                </div>
              )}
            </div>
            {admin && (
              <div>
                <div className="mb-1 text-[10.5px] text-[#8f99a8]">Tanam skenario sekarang (kebenaran disimpan terpisah, bukan input mesin):</div>
                <div className="flex max-h-[150px] flex-wrap gap-1 overflow-y-auto">
                  {Object.entries(sim.skenario).map(([k, label]) => (
                    <button key={k} disabled={!!busy || !sim.berjalan} onClick={() => act(k, () => post("/simulator/tanam", { skenario: k }))} title={label}
                      className="rounded border border-white/10 bg-white/[.04] px-1.5 py-0.5 text-[10.5px] text-[#d3d8de] hover:bg-white/10 disabled:opacity-40">
                      <span className="text-[#c9c0ff]">{(sim.modus_skenario?.[k] ?? []).join("/")}</span> {label.split(" (")[0]}
                      {sim.skenario_ditanam[k] ? <span className="text-[#8f99a8]"> ·{sim.skenario_ditanam[k]}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="border-t border-white/[.06] pt-2">
              {Object.entries(st.sumber).filter(([k]) => k !== "simulator").length ? Object.entries(st.sumber).filter(([k]) => k !== "simulator").map(([k, v]) => (
                <div key={k} className="flex items-center gap-2"><Icon name="plug" className="h-3.5 w-3.5 text-[#7fe0b8]" /><span className="text-[#e5e8eb]">{k}</span>
                  <span className="ml-auto text-[10.5px] tabular-nums text-[#abb3bf]">{nf(v.klaim)} klaim · {wibIso(v.terakhir)}</span></div>
              )) : <p className="text-[10.5px] text-[#8f99a8]">Belum ada kiriman dari sistem faskes. Submit klaim di ai-jkn (Kodifikasi) mengirim ke sini.</p>}
            </div>
            {(err || sim.galat) && <p className="text-[11px] text-red-300">{err || sim.galat}</p>}
          </div>
        </Card>
      </div>
      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        <Card title="Aliran keputusan" right={
          <label className="flex items-center gap-1.5 text-[10.5px] text-[#abb3bf]"><input type="checkbox" checked={alertOnly} onChange={(x) => setAlertOnly(x.target.checked)} />alert saja</label>}>
          <div className="-mx-3 -my-3 overflow-x-auto">
            <table className="w-full min-w-[900px] text-[11.5px]">
              <thead className="text-left text-[10.5px] uppercase tracking-[0.06em] text-[#8f99a8]">
                <tr className="border-b border-white/[.06]"><th className="px-3 py-1.5 font-medium">Waktu</th><th className="px-2 font-medium">Jenis</th><th className="px-2 font-medium">Faskes</th>
                  <th className="px-2 font-medium">Kode / poli / tindakan</th><th className="px-2 text-right font-medium">Tagihan</th><th className="px-2 font-medium">Skor</th><th className="px-2 font-medium">Keputusan</th>
                  <th className="px-2 font-medium">Modus</th><th className="px-2 font-medium">Sinyal utama</th><th className="px-3 text-right font-medium">ms</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} onClick={() => onOpen(r.id)} className={`cursor-pointer border-b border-white/[.04] hover:bg-white/[.04] ${r.keputusan === "TAHAN" ? "bg-[#d03b3b]/[.07]" : r.keputusan === "PERIKSA" ? "bg-[#fab219]/[.05]" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-1 tabular-nums text-[#abb3bf]">{jam(r.t)}</td>
                    <td className="whitespace-nowrap px-2 text-[#abb3bf]" title={r.sumber}>{JENIS_SHORT[r.jenis ?? "fkrtl"]}{r.sumber.startsWith("faskes:") ? " ▸" : ""}</td>
                    <td className="max-w-[240px] truncate px-2 text-[#e5e8eb]" title={r.faskes_label}>{r.faskes_label}</td>
                    <td className="max-w-[160px] truncate whitespace-nowrap px-2 font-mono text-[10.5px] text-[#d3d8de]" title={r.kode}>{r.kode}</td>
                    <td className="whitespace-nowrap px-2 text-right tabular-nums">{r.biaya ? rp(r.biaya) : "–"}</td>
                    <td className="px-2"><ScoreBar skor={r.skor} raw={r.skor_tanpa_mitigasi} /></td>
                    <td className="px-2"><Badge d={r.keputusan} /></td>
                    <td className="px-2">{r.modus?.length ? <ModeChips ids={r.modus} max={2} /> : <span className="text-[#5f6b7c]">–</span>}</td>
                    <td className="max-w-[240px] truncate px-2 text-[#d3d8de]">{r.sinyal.filter((s) => s.kontribusi > 0).slice(0, 2).map((s) => s.label + (s.dimitigasi ? " ↓" : "")).join(" · ") || <span className="text-[#5f6b7c]">–</span>}</td>
                    <td className="whitespace-nowrap px-3 text-right tabular-nums text-[#abb3bf]">{nf(r.latensi_ms)}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={10} className="px-3 py-6 text-center text-[#8f99a8]">{st.aktif ? "Menunggu peristiwa…" : "Mesin realtime belum aktif."}</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Sinyal yang memicu alert">
          {!sig.length && <p className="text-[11.5px] text-[#8f99a8]">Belum ada alert.</p>}
          <div className="space-y-1.5">
            {sig.map(([k, v]) => (
              <div key={k}>
                <div className="flex justify-between text-[11px]"><span className="truncate text-[#d3d8de]">{SIGNAL_LABEL[k] ?? k}</span><span className="tabular-nums text-[#abb3bf]">{nf(v)}</span></div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full rounded-full bg-[#ec835a]" style={{ width: `${(100 * v) / sigMax}%` }} /></div>
              </div>
            ))}
          </div>
          {st.graf && (
            <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-0.5 border-t border-white/[.06] pt-2 text-[10.5px]">
              <dt className="text-[#8f99a8]">Graf: klaim di jendela</dt><dd className="text-right tabular-nums">{nf(st.graf.klaim_di_jendela)}</dd>
              <dt className="text-[#8f99a8]">Peserta · faskes</dt><dd className="text-right tabular-nums">{nf(st.graf.peserta)} · {nf(st.graf.faskes)}</dd>
              <dt className="text-[#8f99a8]">Pasangan tidak wajar</dt><dd className="text-right tabular-nums">{nf(st.graf.pasangan_tidak_wajar)} ({nf(st.graf.cincin)} cincin)</dd>
              <dt className="text-[#8f99a8]">Lonjakan keparahan</dt><dd className="text-right tabular-nums">{nf(st.graf.lonjakan_keparahan)} faskes</dd>
              <dt className="text-[#8f99a8]">Jam peristiwa</dt><dd className="text-right tabular-nums">{st.graf.jam_peristiwa ?? "–"} (hari ke-{st.graf.hari_teramati})</dd>
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}

const SIGNAL_LABEL: Record<string, string> = {
  ANOMALI_SSL: "Anomali self-supervised",
  RAWAT_INAP_TUMPANG_TINDIH: "Rawat inap tumpang tindih", KARTU_BANYAK_FASKES: "Satu kartu di banyak faskes", KLAIM_GANDA_STREAM: "Klaim ganda (id berbeda)",
  KLAIM_GANDA_RIWAYAT: "Klaim ganda (riwayat)", KLAIM_BERULANG_MIRIP: "Klaim berulang (versi mirip)", PEMECAHAN_EPISODE: "Unbundling 0–3 hari",
  EPISODE_HARI_SAMA: "Episode dipecah hari sama", READMISI_DX_SAMA: "Readmisi diagnosis sama", CINCIN_FASKES: "Jaringan faskes tidak wajar",
  KLONING_LINTAS_PESERTA: "Kloning lintas peserta", LONJAKAN_KEPARAHAN: "Lonjakan keparahan III", LOS_FASKES_BERGESER: "Lama rawat faskes bergeser",
  RISIKO_ASOSIASI: "Faskes di Box Karantina", KLAIM_SETELAH_MENINGGAL: "Klaim setelah meninggal (registri)", MENINGGAL_TERCATAT: "Klaim setelah kematian di aliran",
  TIDAK_SESUAI_PESERTA: "Tidak cocok jenis kelamin/usia", KARTU_KELUARGA: "Kartu keluarga dipakai", PASANGAN_KODE_LANGKA: "Pasangan dx–kode langka",
  KODE_PROSEDUR_TANPA_TINDAKAN: "Kode prosedur tanpa tindakan", DX_SEKUNDER_BERLEBIH: "Diagnosis sekunder berlebih", KELAS_DI_ATAS_HAK: "Kelas di atas hak",
  TOPUP_TIDAK_LAZIM: "Top-up tidak lazim", TOPUP_DI_ATAS_PEER: "Top-up di atas p95", OBAT_DIKURANGI: "Obat diserahkan kurang", OBAT_TIDAK_DISERAHKAN: "Obat tidak diserahkan",
  HASIL_PEMERIKSAAN_TIDAK_COCOK: "Hasil pemeriksaan ≠ alat", SKOR_ML: "Skor model ML", TAGIHAN_MELEBIHI_TARIF: "Tagihan di atas tarif",
  LOS_DIPERPANJANG: "Lama rawat diperpanjang", READMISI: "Readmisi ≤ 30 hari", RUJUKAN_NON_SPESIALISTIK: "Rujukan non-spesialistik",
  RUJUKAN_LONCAT_JENJANG: "Rujukan loncat jenjang", RRNS_FKTP_NAIK: "RRNS FKTP naik", RRNS_PUSKESMAS_NAIK: "RRNS Puskesmas naik (kapitasi)",
  KONSENTRASI_RUJUKAN: "Rujukan memusat", KONTAK_SEMU: "Kontak semu (online/home-visit)", KONTAK_RENDAH: "Angka kontak anjlok",
  KUNJUNGAN_SETELAH_MENINGGAL: "Kunjungan setelah meninggal", NONKAP_GANDA: "Nonkapitasi ganda", NONKAP_FREKUENSI: "Pemeriksaan berulang",
  NONKAP_TIDAK_SESUAI_PESERTA: "Tindakan tidak cocok peserta", NONKAP_TARIF: "Tarif nonkapitasi di atas norma", NONKAP_TANGGAL: "Tanggal tindakan di luar kunjungan",
  NONKAP_LONJAKAN: "Lonjakan nonkapitasi",
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* Cases                                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */
function CasesView({ admin, onOpen, onBox, focus }: { admin: boolean; onOpen: (id: string) => void; onBox?: (faskes?: string) => void; focus?: string | null }) {
  const [list, setList] = useState<Kasus[]>([]);
  const [filter, setFilter] = useState("terbuka");
  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [c, setC] = useState<KasusRinci | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    req<{ kasus: Kasus[] }>(`/kasus?status=${filter}&limit=200`).then((r) => setList(r.kasus)).catch((x) => setErr((x as Error).message));
  }, [filter]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 4000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!sel) return;
    req<KasusRinci>(`/kasus/${sel}`).then(setC).catch((x) => setErr((x as Error).message));
  }, [sel]);
  const decide = async (k: string) => {
    if (!c) return;
    setBusy(true); setErr("");
    try {
      await post(`/kasus/${c.id}/keputusan`, { keputusan: k, catatan: note });
      setNote("");
      setC(await req<KasusRinci>(`/kasus/${c.id}`));
      load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const label = (j: string) => (j === "faskes" ? "Faskes" : j === "peserta" ? "Peserta" : "Cincin");
  return (
    <div className="grid min-h-0 gap-3 lg:grid-cols-[340px_1fr]">
      <div className="min-w-0">
        <div className="mb-2 flex gap-1 text-[11px]">
          {([["terbuka", "Terbuka"], ["dikonfirmasi", "Dikonfirmasi"], ["false_positive", "False positive"], ["", "Semua"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded px-2 py-0.5 ${filter === k ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{l}</button>
          ))}
        </div>
        <div className="space-y-1.5">
          {list.map((k) => (
            <button key={k.id} onClick={() => setSel(k.id)} className={`block w-full rounded border p-2 text-left text-[11.5px] transition ${sel === k.id ? "border-[#9d8cff]/60 bg-[#5b5fd6]/15" : "border-white/[.07] bg-[#1c2127] hover:bg-white/[.04]"}`}>
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-white/10 px-1 text-[9.5px] uppercase tracking-wide text-[#abb3bf]">{label(k.jenis)}</span>
                {k.tahan_n ? <Badge d="TAHAN" /> : <Badge d="PERIKSA" />}
                <span className="ml-auto tabular-nums text-[10.5px] text-[#8f99a8]">prioritas {nf(k.prioritas, 0)}</span>
              </div>
              <div className="mt-1 truncate font-medium text-[#e5e8eb]">{k.judul}</div>
              <div className="mt-0.5 truncate text-[10.5px] text-[#abb3bf]">{nf(k.klaim_n)} peristiwa · {k.nilai_rp ? `${rp(k.nilai_rp)} · ` : ""}skor maks {Math.round(k.skor_maks)} · {Object.keys(k.sinyal).map((s) => SIGNAL_LABEL[s] ?? s).slice(0, 2).join(", ")}</div>
              {!!k.modus && Object.keys(k.modus).length > 0 && <div className="mt-1"><ModeChips ids={Object.entries(k.modus).sort((a, b) => b[1] - a[1]).map(([m]) => m)} /></div>}
              {k.status !== "baru" && <div className="mt-0.5 text-[10.5px] text-[#7fe0b8]">{STATUS_KASUS[k.status] ?? k.status}</div>}
            </button>
          ))}
          {!list.length && <p className="px-1 py-4 text-[11.5px] text-[#8f99a8]">Tidak ada kasus {filter ? STATUS_KASUS[filter]?.toLowerCase() ?? filter : ""}.</p>}
        </div>
      </div>
      <div className="min-w-0">
        {!c ? <p className="py-10 text-center text-[12px] text-[#8f99a8]">Pilih kasus untuk melihat klaim, jaringan dan sinyalnya.</p> : (
          <div className="space-y-3">
            <Card title={`${label(c.jenis)} · ${c.judul}`} right={<span className="text-[10.5px] text-[#abb3bf]">{STATUS_KASUS[c.status] ?? c.status} · {c.id}</span>}>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Tile label="Klaim alert" value={nf(c.klaim_n)} sub={`${nf(c.tahan_n)} tahan · ${nf(c.periksa_n)} periksa`} />
                <Tile label="Nilai tagihan" value={rp(c.nilai_rp)} />
                <Tile label="Skor maks" value={nf(c.skor_maks, 0)} />
                <Tile label="Sumber" value={Object.keys(c.sumber).join(", ").replace(/faskes:/g, "")} sub={`dibuat ${wibIso(c.dibuat)}`} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(c.sinyal).sort((a, b) => b[1] - a[1]).map(([k, v]) => <span key={k} className="rounded border border-white/10 bg-white/[.04] px-1.5 py-0.5 text-[10.5px] text-[#d3d8de]">{SIGNAL_LABEL[k] ?? k} · {v}</span>)}
                {!!c.modus && <ModeChips ids={Object.entries(c.modus).sort((a, b) => b[1] - a[1]).map(([m]) => m)} max={6} />}
              </div>
              {admin && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/[.06] pt-2">
                  <input value={note} onChange={(x) => setNote(x.target.value)} placeholder="Catatan keputusan (masuk ke jejak tag indikasi)" className="min-w-[220px] flex-1 rounded border border-white/15 bg-[#141920] px-2 py-1 text-[11.5px] text-white placeholder:text-[#5f6b7c]" />
                  <button disabled={busy} onClick={() => decide("telaah")} className="rounded border border-white/15 px-2 py-1 text-[11px] hover:bg-white/10">Telaah</button>
                  <button disabled={busy} onClick={() => decide("konfirmasi")} className="rounded border border-[#d03b3b]/60 bg-[#d03b3b]/20 px-2 py-1 text-[11px] text-white hover:bg-[#d03b3b]/30">Konfirmasi indikasi</button>
                  <button disabled={busy} onClick={() => decide("false_positive")} className="rounded border border-[#199e70]/60 bg-[#199e70]/15 px-2 py-1 text-[11px] text-white hover:bg-[#199e70]/25">False positive</button>
                  {(c.status === "dikonfirmasi" || c.status === "false_positive") && <button disabled={busy} onClick={() => decide("buka")} className="rounded border border-white/15 px-2 py-1 text-[11px] text-[#abb3bf] hover:bg-white/10">Buka lagi</button>}
                  {onBox && c.jenis === "faskes" && <button onClick={() => onBox(c.kunci)} className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[#8abbff] hover:bg-white/5"><Icon name="lock" className="h-3 w-3" />Lihat di Box Karantina</button>}
                </div>
              )}
              {c.keputusan_tag && <p className="mt-1.5 text-[10.5px] text-[#abb3bf]">Ledger indikasi: {c.keputusan_tag.diputus} tag {c.keputusan_tag.status_tag}{c.keputusan_tag.dibiarkan_sumber_lain ? `, ${c.keputusan_tag.dibiarkan_sumber_lain} dibiarkan (ada sumber lain, diputus reviewer ledger)` : ""}.</p>}
              {err && <p className="mt-1 text-[11px] text-red-300">{err}</p>}
            </Card>
            <CaseBrief id={c.id} stamp={c.diperbarui} />
            <Card title="Jaringan di sekitar entitas (jendela 30 hari aliran)">
              <NetGraph g={c.graf} />
            </Card>
            <Card title={`Klaim di kasus ini (${nf(c.klaim.length)} terbaru)`}>
              <div className="-mx-3 -my-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-[11.5px]">
                  <thead className="text-left text-[10.5px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
                    <th className="px-3 py-1.5 font-medium">Klaim</th><th className="px-2 font-medium">Layanan</th><th className="px-2 font-medium">Faskes</th><th className="px-2 text-right font-medium">Tagihan</th>
                    <th className="px-2 font-medium">Skor</th><th className="px-3 font-medium">Sinyal</th></tr></thead>
                  <tbody>
                    {c.klaim.map((e) => (
                      <tr key={e.id} onClick={() => onOpen(e.id)} className="cursor-pointer border-b border-white/[.04] hover:bg-white/[.04]">
                        <td className="whitespace-nowrap px-3 py-1 font-mono text-[10.5px]">{e.kunjungan}</td>
                        <td className="whitespace-nowrap px-2">{e.tingkat} {e.tgl_datang} · {e.kode}</td>
                        <td className="max-w-[220px] truncate px-2" title={e.faskes_label}>{e.faskes_label}</td>
                        <td className="whitespace-nowrap px-2 text-right tabular-nums">{rp(e.biaya)}</td>
                        <td className="px-2"><ScoreBar skor={e.skor} raw={e.skor_tanpa_mitigasi} /></td>
                        <td className="max-w-[260px] truncate px-3">{e.sinyal.filter((s) => s.kontribusi > 0).map((s) => s.label).join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Riwayat kasus">
              <ul className="space-y-0.5 text-[11px]">
                {c.riwayat.map((h, i) => <li key={i} className="text-[#d3d8de]"><span className="tabular-nums text-[#8f99a8]">{wibIso(h.t)}</span> · {STATUS_KASUS[h.status] ?? h.status} · {h.oleh}{h.catatan ? ` · ${h.catatan}` : ""}</li>)}
              </ul>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

/** The investigation brief of a case (api/aip/realtime/investigasi.py): written from the case's events with templates. */
function CaseBrief({ id, stamp }: { id: string; stamp: string }) {
  const [b, setB] = useState<Ringkasan | null>(null);
  useEffect(() => { req<Ringkasan>(`/kasus/${id}/ringkasan`).then(setB).catch(() => setB(null)); }, [id, stamp]);
  if (!b) return null;
  return (
    <Card title="Ringkasan investigasi" right={<span className="text-[10.5px] text-[#8f99a8]">templat, tanpa model bahasa</span>}>
      <p className="text-[12px] leading-relaxed text-[#e5e8eb]">{b.ringkasan}</p>
      {!!b.modus?.length && (
        <div className="mt-2 flex flex-wrap gap-1">
          {b.modus.map((m) => <span key={m.id} className="rounded border border-[#9d8cff]/40 bg-[#5b5fd6]/15 px-1.5 py-0.5 text-[10.5px] text-[#c9c0ff]">{m.id} {m.nama} · {m.peristiwa}</span>)}
        </div>
      )}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8f99a8]">Bukti terkuat</h4>
          <ul className="space-y-1.5 text-[11.5px]">
            {b.bukti?.map((x) => (
              <li key={x.kode} className="rounded border border-white/[.06] bg-[#141920] p-1.5">
                <div className="flex gap-2"><span className="flex-1 font-medium text-[#e5e8eb]">{x.sinyal}</span><span className="tabular-nums text-[#abb3bf]">{x.jumlah}×</span></div>
                <div className="text-[10.5px] leading-snug text-[#abb3bf]">{x.bukti}</div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8f99a8]">Langkah berikutnya</h4>
          <ul className="space-y-1.5 text-[11.5px]">
            {b.langkah?.map((x, i) => (
              <li key={i} className="rounded border border-white/[.06] bg-[#141920] p-1.5">
                <div className="font-medium text-[#e5e8eb]">{x.modus} {x.nama}</div>
                {x.minta && <div className="text-[10.5px] text-[#d3d8de]">Minta: {x.minta}</div>}
              </li>
            ))}
          </ul>
          {!!b.mitigasi?.length && <p className="mt-2 text-[10.5px] text-[#7fe0b8]">Konteks yang melemahkan: {b.mitigasi.map((m) => `${m.label} (${m.peristiwa})`).join("; ")}</p>}
          {b.jaringan && <p className="mt-1 text-[10.5px] text-[#abb3bf]">Jaringan: {b.jaringan.faskes} faskes, {b.jaringan.peserta} peserta, {b.jaringan.klaim} klaim, {b.jaringan.pasangan_tidak_wajar} pasangan tidak wajar.</p>}
          {!!b.batas_data?.length && <ul className="mt-2 list-disc pl-4 text-[10.5px] text-[#fbd38d]">{b.batas_data.map((x) => <li key={x}>{x}</li>)}</ul>}
        </div>
      </div>
      <p className="mt-2 text-[10.5px] text-[#8f99a8]">{b.catatan}</p>
    </Card>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Network                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */
function NetworkView() {
  const [j, setJ] = useState<Jaringan | null>(null);
  const [sel, setSel] = useState<{ jenis: string; kunci: string; judul: string } | null>(null);
  const [g, setG] = useState<Graf | null>(null);
  useEffect(() => {
    const load = () => req<Jaringan>("/jaringan").then(setJ).catch(() => {});
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 6000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!sel) return;
    req<Graf>(`/graf?jenis=${sel.jenis}&kunci=${encodeURIComponent(sel.kunci)}`).then(setG).catch(() => setG(null));
  }, [sel]);
  return (
    <div className="grid gap-3 lg:grid-cols-[360px_1fr]">
      <div className="space-y-3">
        <Card title="Cincin faskes (pasangan berbagi peserta di atas riwayatnya)">
          {!j?.cincin.length && <p className="text-[11.5px] text-[#8f99a8]">Belum ada pasangan faskes yang menyimpang dari riwayatnya.</p>}
          <div className="space-y-1.5">
            {j?.cincin.map((r) => (
              <button key={r.id} onClick={() => setSel({ jenis: "jaringan", kunci: r.id, judul: `Cincin ${r.faskes.length} faskes` })}
                className={`block w-full rounded border p-2 text-left text-[11.5px] ${sel?.kunci === r.id ? "border-[#9d8cff]/60 bg-[#5b5fd6]/15" : "border-white/[.07] hover:bg-white/[.04]"}`}>
                <div className="font-medium text-[#e5e8eb]">{r.faskes.length} faskes · {r.peserta} peserta bersama</div>
                {r.faskes.map((f) => <div key={f.id} className="truncate text-[10.5px] text-[#abb3bf]">{f.label ?? f.id}</div>)}
                <div className="mt-0.5 text-[10.5px] text-[#ffb4b4]">{r.pasangan.map((p) => `${p.anggota} vs eksp ${p.ekspektasi.toFixed(2)}`).join(" · ")}</div>
              </button>
            ))}
          </div>
        </Card>
        <Card title="Lonjakan keparahan III (upcoding)">
          {!j?.lonjakan.length && <p className="text-[11.5px] text-[#8f99a8]">Tidak ada faskes dengan lonjakan aktif.</p>}
          {j?.lonjakan.map((b) => (
            <button key={b.faskes} onClick={() => setSel({ jenis: "faskes", kunci: b.faskes, judul: b.label ?? b.faskes })} className="block w-full rounded p-1.5 text-left text-[11.5px] hover:bg-white/[.04]">
              <div className="truncate text-[#e5e8eb]">{b.label ?? b.faskes}</div>
              <div className="text-[10.5px] text-[#abb3bf]">{b.k} dari {b.n} rawat inap terakhir keparahan III · riwayat {pctf(b.p0)} · p = {b.p.toExponential(1)}</div>
            </button>
          ))}
        </Card>
      </div>
      <Card title={sel ? sel.judul : "Pilih cincin atau faskes"}>
        {g ? <NetGraph g={g} height={420} onPick={(n) => n.jenis === "faskes" && setSel({ jenis: "faskes", kunci: n.id.slice(2), judul: n.label })} />
          : <p className="py-10 text-center text-[11.5px] text-[#8f99a8]">Graf aliran: peserta ↔ faskes dari klaim 30 hari terakhir (waktu layanan), dan pasangan faskes yang berbagi peserta jauh di atas ekspektasi Poisson riwayat pasangan itu.</p>}
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The 20 modes of Permenkes 16/2019                                                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */
const DETEKSI: Record<string, [string, string, string]> = {
  data: ["dari data", "bg-[#199e70]/20 text-[#7fe0b8]", "dibaca langsung dari aliran klaim, kunjungan dan registri peserta"],
  proksi: ["proksi", "bg-[#fab219]/15 text-[#fbd38d]", "yang dilihat data hanyalah jejak tidak langsung dari modus ini"],
  kontrak: ["butuh data faskes", "bg-[#3987e5]/20 text-[#a9cdff]", "aturannya berjalan atas baris yang dikirim faskes (obat, hasil alat); data sampel tidak memuatnya"],
};
function ModesView() {
  const [rows, setRows] = useState<ModusRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const load = () => req<{ modus: ModusRow[] }>("/modus").then((r) => setRows(r.modus)).catch(() => {});
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 8000);
    return () => clearInterval(t);
  }, []);
  if (!rows) return <p className="text-[12px] text-[#8f99a8]">Memuat…</p>;
  const covered = rows.filter((r) => r.tanam && r.tanam.instans > 0);
  const caught = covered.filter((r) => r.tanam!.tertangkap > 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Modus Permenkes 16/2019" value="20" sub="M07 dan M19 sama (inflated bills): 19 baris" />
        <Tile label="Dideteksi dari data" value={nf(rows.filter((r) => r.deteksi === "data").length)} sub={`${rows.filter((r) => r.deteksi === "proksi").length} proksi · ${rows.filter((r) => r.deteksi === "kontrak").length} butuh data faskes`} />
        <Tile label="Modus dengan alert di aliran" value={nf(rows.filter((r) => r.alert > 0).length)} sub={`${nf(rows.reduce((s, r) => s + r.alert, 0))} sinyal alert`} />
        <Tile label="Modus ditanam · tertangkap" value={`${caught.length} / ${covered.length}`} sub="skenario simulator, lihat Evaluasi" />
      </div>
      <Card title="Cara setiap modus dideteksi (gaya Quantexa: entitas, jaringan, riwayat, konteks)">
        <div className="-mx-3 -my-3 overflow-x-auto">
          <table className="w-full min-w-[920px] text-[11.5px]">
            <thead className="text-left text-[10.5px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
              <th className="px-3 py-1.5 font-medium">Modus</th><th className="px-2 font-medium">Tingkat</th><th className="px-2 font-medium">Deteksi</th>
              <th className="px-2 font-medium">Sinyal</th><th className="px-2 text-right font-medium">Alert</th><th className="px-3 text-right font-medium">Tanam · tangkap</th></tr></thead>
            <tbody>
              {rows.map((r) => (<Fragment key={r.id}>
                <tr onClick={() => setOpen(open === r.id ? null : r.id)} className="cursor-pointer border-b border-white/[.04] align-top hover:bg-white/[.03]">
                  <td className="px-3 py-1.5"><span className="font-mono text-[10.5px] text-[#c9c0ff]">{r.id}</span> <span className="text-[#e5e8eb]">{r.nama}</span>{r.fokus ? <span className="ml-1 rounded bg-white/10 px-1 text-[9.5px] text-[#abb3bf]">fokus BPJS</span> : null}</td>
                  <td className="whitespace-nowrap px-2 text-[#abb3bf]">{r.faskes}</td>
                  <td className="whitespace-nowrap px-2">{r.deteksi && <span title={DETEKSI[r.deteksi][2]} className={`rounded px-1.5 py-px text-[10px] ${DETEKSI[r.deteksi][1]}`}>{DETEKSI[r.deteksi][0]}</span>}</td>
                  <td className="max-w-[320px] truncate px-2 text-[#d3d8de]">{r.sinyal.map((s) => s.label).join(" · ")}</td>
                  <td className="px-2 text-right tabular-nums">{nf(r.alert)}</td>
                  <td className="whitespace-nowrap px-3 text-right tabular-nums">{r.tanam ? `${r.tanam.instans} · ${r.tanam.tertangkap}` : "–"}</td>
                </tr>
                {open === r.id && (
                  <tr className="border-b border-white/[.04] bg-[#141920]">
                    <td colSpan={6} className="px-3 py-2 text-[11.5px]">
                      <p className="text-[#d3d8de]"><span className="text-[#8f99a8]">Permenkes:</span> {r.arti}</p>
                      <p className="mt-1 text-[#e5e8eb]"><span className="text-[#8f99a8]">Realtime:</span> {r.cara}</p>
                      <p className="mt-1 text-[#d3d8de]"><span className="text-[#8f99a8]">Dokumen yang diminta:</span> {r.dokumen}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">{r.sinyal.map((s) => <span key={s.kode} className="rounded border border-white/10 bg-white/[.04] px-1.5 py-0.5 text-[10.5px]">{s.label} · bobot {s.bobot}{s.tag ? ` · tag ${s.tag}` : ""}</span>)}</div>
                      {r.juga && <p className="mt-1 text-[10.5px] text-[#8f99a8]">{r.juga}</p>}
                    </td>
                  </tr>
                )}
              </Fragment>))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function FeedbackCard({ admin }: { admin: boolean }) {
  const [b, setB] = useState<Bobot | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { req<Bobot>("/bobot").then(setB).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  if (!b) return null;
  const rows = b.sinyal.filter((r) => r.dikonfirmasi + r.false_positive > 0 || r.verifikator_alert > 0).slice(0, 25);
  return (
    <Card title={`Umpan balik: bobot sinyal dari keputusan kasus (${b.kasus_diputus} kasus diputus)`} right={admin ? (
      <span className="flex gap-1.5 text-[11px]">
        <button onClick={() => post("/bobot/terapkan", {}).then(() => { setMsg("Bobot usulan diterapkan untuk peristiwa berikutnya."); load(); }).catch((x) => setMsg((x as Error).message))} className="rounded border border-white/15 px-2 py-0.5 hover:bg-white/10">Terapkan usulan</button>
        <button onClick={() => post("/bobot/bawaan", {}).then(() => { setMsg("Kembali ke bobot bawaan."); load(); }).catch((x) => setMsg((x as Error).message))} className="rounded border border-white/15 px-2 py-0.5 text-[#abb3bf] hover:bg-white/10">Bawaan</button>
        <a href={`${API_URL}${BASE}/label`} className="rounded border border-white/15 px-2 py-0.5 text-[#8abbff] hover:bg-white/10">Label CSV</a>
      </span>) : null}>
      <div className="-mx-3 -my-3 overflow-x-auto">
        <table className="w-full min-w-[760px] text-[11.5px]">
          <thead className="text-left text-[10.5px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
            <th className="px-3 py-1.5 font-medium">Sinyal</th><th className="px-2 font-medium">Modus</th><th className="px-2 text-right font-medium">Konfirmasi · FP</th>
            <th className="px-2 text-right font-medium">Presisi posterior</th><th className="px-2 text-right font-medium">Bobot bawaan → usulan</th><th className="px-2 text-right font-medium">Berlaku</th>
            <th className="px-3 text-right font-medium">Dikoreksi verifikator (alert)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kode} className="border-b border-white/[.04]">
                <td className="px-3 py-1">{r.label}</td>
                <td className="px-2">{r.modus.length ? <ModeChips ids={r.modus} /> : <span className="text-[#5f6b7c]">–</span>}</td>
                <td className="px-2 text-right tabular-nums">{r.dikonfirmasi} · {r.false_positive}</td>
                <td className="px-2 text-right tabular-nums">{r.dikonfirmasi + r.false_positive ? pctf(r.presisi_posterior, 0) : "–"}</td>
                <td className="px-2 text-right tabular-nums">{r.bobot_bawaan} → <span className={r.bobot_usulan > r.bobot_bawaan ? "text-[#ffb4b4]" : r.bobot_usulan < r.bobot_bawaan ? "text-[#7fe0b8]" : ""}>{r.bobot_usulan}</span></td>
                <td className="px-2 text-right tabular-nums">{r.bobot_berlaku}</td>
                <td className="px-3 text-right tabular-nums">{r.verifikator_alert ? `${pctf(r.verifikator_presisi, 0)} dari ${r.verifikator_alert}` : "–"}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="px-3 py-4 text-center text-[#8f99a8]">Belum ada kasus yang diputus.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-[10.5px] leading-snug text-[#8f99a8]">{b.aturan}. Label verifikator (dasar {pctf(b.dasar_koreksi_verifikator, 2)}) hanya informasi: mengukur koreksi koding, bukan fraud. {msg}</p>
    </Card>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Evaluation                                                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */
function EvalView({ admin }: { admin: boolean }) {
  const [ev, setEv] = useState<Evaluasi | null>(null);
  useEffect(() => {
    const load = () => req<Evaluasi>("/evaluasi").then(setEv).catch(() => {});
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 8000);
    return () => clearInterval(t);
  }, []);
  if (!ev) return <p className="text-[12px] text-[#8f99a8]">Memuat…</p>;
  if (!ev.ada) return <p className="text-[12px] text-[#8f99a8]">Belum ada data evaluasi: jalankan simulator.</p>;
  const n: EvalNormal = ev.normal && "klaim" in ev.normal ? ev.normal : { klaim: 0, alert: 0, tahan: 0, porsi_alert: null, dikoreksi_verifikator_dasar: null,
    dikoreksi_di_antara_alert: null, lift: null, sinyal_alert: {}, dicegah_mitigasi: 0 };
  const r = ev.ringkas;
  return (
    <div className="space-y-3">
      {r && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Tile label="Instans fraud ditanam" value={nf(r.instans)} sub={`${Object.values(ev.skenario ?? {}).filter((s) => s.instans).length} dari ${Object.keys(ev.skenario ?? {}).length} skenario`} />
          <Tile label="Tertangkap" value={`${nf(r.tertangkap)} (${pctf(r.instans ? r.tertangkap / r.instans : null, 0)})`} sub={`${nf(r.sinyal_tepat)} oleh sinyal modusnya sendiri`} />
          <Tile label="Alert klaim FKRTL normal" value={pctf(n.porsi_alert, 2)} sub={`${nf(n.alert)} dari ${nf(n.klaim)} · lift verifikator ${n.lift ? nf(n.lift, 0) + "×" : "–"}`} />
          <Tile label="Alert kunjungan FKTP normal" value={pctf(ev.normal_per_jenis?.fktp?.porsi_alert, 2)} sub={`nonkapitasi ${pctf(ev.normal_per_jenis?.nonkap?.porsi_alert, 2)}`} />
        </div>
      )}
      <Card title="Skenario fraud tertanam: tertangkap dan seberapa cepat">
        <div className="-mx-3 -my-3 overflow-x-auto">
          <table className="w-full min-w-[820px] text-[11.5px]">
            <thead className="text-left text-[10.5px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
              <th className="px-3 py-1.5 font-medium">Skenario</th><th className="px-2 font-medium">Modus</th><th className="px-2 text-right font-medium">Instans</th><th className="px-2 text-right font-medium">Tertangkap</th>
              <th className="px-2 text-right font-medium">Sinyal tepat</th><th className="px-2 text-right font-medium">Klaim alert</th><th className="px-2 text-right font-medium">Jeda (klaim)</th>
              <th className="px-2 text-right font-medium">Jeda (detik)</th><th className="px-3 font-medium">Sinyal</th></tr></thead>
            <tbody>
              {Object.entries(ev.skenario!).map(([k, s]) => (
                <tr key={k} className="border-b border-white/[.04]">
                  <td className="px-3 py-1.5 text-[#e5e8eb]">{s.label}</td>
                  <td className="px-2">{s.modus?.length ? <ModeChips ids={s.modus} /> : null}</td>
                  <td className="px-2 text-right tabular-nums">{s.instans}</td>
                  <td className="px-2 text-right tabular-nums">{s.instans ? `${s.tertangkap} (${pctf(s.tertangkap / s.instans, 0)})` : "–"}</td>
                  <td className="px-2 text-right tabular-nums">{s.instans ? s.sinyal_tepat : "–"}</td>
                  <td className="px-2 text-right tabular-nums">{s.klaim ? `${s.klaim_alert} / ${s.klaim}` : "–"}</td>
                  <td className="px-2 text-right tabular-nums">{s.jeda_klaim_median ?? "–"}</td>
                  <td className="px-2 text-right tabular-nums">{s.jeda_detik_median ?? "–"}</td>
                  <td className="max-w-[240px] truncate px-3 text-[#abb3bf]">{Object.entries(s.sinyal).map(([x, v]) => `${SIGNAL_LABEL[x] ?? x} ${v}`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-[10.5px] leading-snug text-[#8f99a8]">Jeda = dari klaim pertama instans masuk sampai alert pertama (median antar-instans). Cincin dan lonjakan butuh beberapa klaim sebelum menyimpang dari riwayat, itulah jedanya.</p>
      </Card>
      <div className="grid gap-3 md:grid-cols-3">
        <Card title="Klaim normal (replay)">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-[11.5px]">
            <dt className="text-[#abb3bf]">Klaim</dt><dd className="text-right tabular-nums">{nf(n.klaim)}</dd>
            <dt className="text-[#abb3bf]">Alert (periksa + tahan)</dt><dd className="text-right tabular-nums">{nf(n.alert)} ({pctf(n.porsi_alert, 2)})</dd>
            <dt className="text-[#abb3bf]">Tahan</dt><dd className="text-right tabular-nums">{nf(n.tahan)}</dd>
            <dt className="text-[#abb3bf]">Dikoreksi verifikator: semua</dt><dd className="text-right tabular-nums">{pctf(n.dikoreksi_verifikator_dasar, 2)}</dd>
            <dt className="text-[#abb3bf]">Dikoreksi verifikator: di antara alert</dt><dd className="text-right tabular-nums">{pctf(n.dikoreksi_di_antara_alert, 1)}</dd>
            <dt className="text-[#abb3bf]">Lift</dt><dd className="text-right font-semibold tabular-nums text-white">{n.lift ? `${nf(n.lift, 1)}×` : "–"}</dd>
          </dl>
        </Card>
        <Card title="Efek konteks mitigasi">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-[11.5px]">
            <dt className="text-[#abb3bf]">Alert normal yang dicegah mitigasi</dt><dd className="text-right tabular-nums text-[#7fe0b8]">{nf(ev.mitigasi!.alert_normal_dicegah)}</dd>
            <dt className="text-[#abb3bf]">Klaim tanam yang lolos karena mitigasi</dt><dd className="text-right tabular-nums">{nf(ev.mitigasi!.klaim_tanam_lolos_karena_mitigasi)}</dd>
          </dl>
          <p className="mt-2 text-[10.5px] leading-snug text-[#8f99a8]">Setiap keputusan menyimpan skor tanpa mitigasi, jadi pengurangan false positive dihitung dari data, bukan diklaim.</p>
        </Card>
        <Card title="Latensi (terima → putus)">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-[11.5px]">
            <dt className="text-[#abb3bf]">p50</dt><dd className="text-right tabular-nums">{nf(ev.latensi_ms?.p50)} ms</dd>
            <dt className="text-[#abb3bf]">p95</dt><dd className="text-right tabular-nums">{nf(ev.latensi_ms?.p95)} ms</dd>
            <dt className="text-[#abb3bf]">p99</dt><dd className="text-right tabular-nums">{nf(ev.latensi_ms?.p99)} ms</dd>
            <dt className="text-[#abb3bf]">Klaim</dt><dd className="text-right tabular-nums">{nf(ev.latensi_ms?.n)}</dd>
          </dl>
        </Card>
      </div>
      <Card title="Alert pada peristiwa normal, per jenis (sinyal di baliknya)">
        <div className="space-y-2">
          {Object.entries(ev.normal_per_jenis ?? { fkrtl: n }).map(([j, x]) => (
            <div key={j} className="text-[11.5px]">
              <div className="mb-1 text-[#e5e8eb]">{JENIS_LABEL[j as JenisPeristiwa] ?? j}: {nf(x.alert)} alert dari {nf(x.klaim)} ({pctf(x.porsi_alert, 2)}), {nf(x.tahan)} tahan</div>
              <div className="flex flex-wrap gap-1">{Object.entries(x.sinyal_alert).map(([k, v]) => <span key={k} className="rounded border border-white/10 bg-white/[.04] px-1.5 py-0.5 text-[10.5px]">{SIGNAL_LABEL[k] ?? k} · {v}</span>)}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10.5px] leading-snug text-[#8f99a8]">{ev.catatan}</p>
      </Card>
      <FeedbackCard admin={admin} />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Active learning + self-supervised (MONAI Label's loop for claims)                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */
const STRAT_COLOR: Record<string, string> = { acak: "#8f99a8", entropi: "#3987e5", epistemik: "#c98500", hibrida: "#d95926" };
const STRAT_LABEL: Record<string, string> = { acak: "Acak", entropi: "Entropi", epistemik: "Epistemik", hibrida: "Hibrida" };
const dec = (n: number, d: number) => n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const FITUR_LABEL: Record<string, string> = {
  ml_log_risiko: "Risiko model ML produksi", ml_kelipatan: "Kelipatan risiko ML vs rata-rata", log_biaya: "Biaya klaim (log)", skor_aturan: "Skor aturan",
  skor_tanpa_mitigasi: "Skor aturan sebelum mitigasi", mitigasi_n: "Jumlah faktor mitigasi", ssl_log_err: "Galat rekonstruksi self-supervised",
};
/** A readable name for one of the adaptive model's features (signal strengths, event kind, scores, SSL embedding dimensions). */
const fiturLabel = (f: string) => f.startsWith("s:") ? SIGNAL_LABEL[f.slice(2)] ?? f.slice(2) : f.startsWith("jenis:") ? `Jenis peristiwa: ${f.slice(6)}`
  : /^emb\d+$/.test(f) ? `Embedding self-supervised, dimensi ${Number(f.slice(3)) + 1}` : FITUR_LABEL[f] ?? f;

/** AUPRC on the held-out events against the number of labels, one line per strategy, the rule score as a dashed line. */
function LearningCurve({ sim }: { sim: AlSim }) {
  const W = 720, H = 280, L = 44, R = 104, T = 14, B = 34;
  const [hover, setHover] = useState<{ s: string; p: KurvaPt } | null>(null);
  const series = Object.entries(sim.kurva);
  const maxX = Math.max(...series.flatMap(([, pts]) => pts.map((p) => p.label)), 1);
  const base = sim.auprc_skor_aturan;
  // the y range follows the data (a line chart need not start at zero), on 0.1 steps
  const vals = [base, ...series.flatMap(([, pts]) => pts.flatMap((p) => (p.auprc == null ? [] : [p.auprc])))];
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 0.04) * 10) / 10), hi = Math.min(1, Math.ceil((Math.max(...vals) + 0.04) * 10) / 10);
  const ticksY = Array.from({ length: Math.round((hi - lo) * 10) + 1 }, (_, i) => Math.round((lo + i / 10) * 10) / 10);
  const x = (v: number) => L + ((W - L - R) * v) / maxX;
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const ticksX = [0, Math.round(maxX / 4), Math.round(maxX / 2), Math.round((3 * maxX) / 4), maxX];
  // end labels, pushed apart so that close lines stay readable (12 px apart, inside the plot)
  const ends = [...series.flatMap(([s, pts]) => { const ok = pts.filter((p) => p.auprc != null); const l = ok[ok.length - 1]; return l ? [{ key: s, text: `${STRAT_LABEL[s] ?? s} ${dec(l.auprc!, 2)}`, y0: y(l.auprc!) }] : []; }),
    { key: "_aturan", text: `aturan ${dec(base, 2)}`, y0: y(base) }].sort((a, b) => a.y0 - b.y0).map((e) => ({ ...e, y: e.y0 }));
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 12);
  const over = ends.length ? ends[ends.length - 1].y - (H - B) : 0;
  if (over > 0) for (let i = ends.length - 1; i >= 0; i--) ends[i].y = Math.min(ends[i].y - over, i < ends.length - 1 ? ends[i + 1].y - 12 : Infinity);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-[#abb3bf]">
        {series.map(([s]) => <span key={s} className="flex items-center gap-1"><span className="inline-block h-0.5 w-4" style={{ background: STRAT_COLOR[s] ?? "#fff" }} />{STRAT_LABEL[s] ?? s}</span>)}
        <span className="flex items-center gap-1"><span className="inline-block w-4 border-t-2 border-dashed border-[#e5e8eb]" />Skor aturan (tanpa belajar)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" className="block max-w-full" role="img"
        aria-label="Kurva belajar: AUPRC pada peristiwa uji terhadap jumlah label">
        {ticksY.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#2c333b" strokeWidth={1} />
            <text x={L - 6} y={y(t) + 3.5} fill="#8f99a8" fontSize={10} textAnchor="end">{dec(t, 1)}</text>
          </g>
        ))}
        {ticksX.map((t) => <text key={t} x={x(t)} y={H - B + 16} fill="#8f99a8" fontSize={10} textAnchor="middle">{t}</text>)}
        <text x={(L + W - R) / 2} y={H - 4} fill="#8f99a8" fontSize={10} textAnchor="middle">jumlah label</text>
        <text x={12} y={T + (H - T - B) / 2} fill="#8f99a8" fontSize={10} textAnchor="middle" transform={`rotate(-90 12 ${T + (H - T - B) / 2})`}>AUPRC uji</text>
        <line x1={L} x2={W - R} y1={y(base)} y2={y(base)} stroke="#e5e8eb" strokeWidth={1.5} strokeDasharray="5 4" />
        {series.map(([s, pts]) => {
          const ok = pts.filter((p) => p.auprc != null);
          const d = ok.map((p, i) => `${i ? "L" : "M"}${x(p.label)},${y(p.auprc!)}`).join(" ");
          return (
            <g key={s}>
              <path d={d} fill="none" stroke={STRAT_COLOR[s] ?? "#fff"} strokeWidth={2} />
              {ok.map((p) => (
                <g key={p.label} onMouseEnter={() => setHover({ s, p })} onMouseLeave={() => setHover(null)}>
                  <circle cx={x(p.label)} cy={y(p.auprc!)} r={8} fill="transparent" />
                  <circle cx={x(p.label)} cy={y(p.auprc!)} r={hover?.s === s && hover.p.label === p.label ? 5 : 2.5} fill={STRAT_COLOR[s] ?? "#fff"} stroke="#1c2127" strokeWidth={1.5} pointerEvents="none" />
                </g>
              ))}
            </g>
          );
        })}
        {ends.map((e) => (
          <g key={e.key}>
            {Math.abs(e.y - e.y0) > 2 && <line x1={W - R + 2} x2={W - R + 8} y1={e.y0} y2={e.y} stroke="#5f6b7c" strokeWidth={1} />}
            <text x={W - R + 10} y={e.y + 3.5} fill={e.key === "_aturan" ? "#e5e8eb" : "#d3d8de"} fontSize={10}>{e.text}</text>
          </g>
        ))}
        {hover && hover.p.auprc != null && (
          <g transform={`translate(${Math.min(x(hover.p.label) + 8, W - R - 150)},${Math.max(y(hover.p.auprc) - 44, T)})`} pointerEvents="none">
            <rect width={150} height={40} rx={4} fill="#111418" stroke="#2c333b" />
            <text x={8} y={16} fill="#e5e8eb" fontSize={10.5}>{STRAT_LABEL[hover.s]}: AUPRC {dec(hover.p.auprc, 3)}</text>
            <text x={8} y={31} fill="#abb3bf" fontSize={10}>{hover.p.label} label · {hover.p.positif} positif</text>
          </g>
        )}
      </svg>
    </div>
  );
}

/** Decision-level check on the simulation's test events: the rules' own decisions vs the best committee's population-scale
 *  probability at a few thresholds. Rows at the configured active-mode thresholds are marked. */
function OperatingPoints({ op, uji, best, ambang }: { op: NonNullable<AlSim["titik_operasi"]>; uji: number; best: string; ambang?: { periksa: number; tahan: number } }) {
  const row = (name: string, p: OpPt, mark = "") => (
    <tr key={name} className="border-b border-white/[.04]">
      <td className="px-2 py-0.5 text-[#d3d8de]">{name}{mark && <span className="ml-1.5 rounded bg-white/10 px-1 text-[9.5px] text-[#d3d8de]">{mark}</span>}</td>
      <td className="px-2 text-right tabular-nums">{nf(p.alarm)}</td>
      <td className="px-2 text-right tabular-nums">{pctf(p.laju_alarm, 1)}</td>
      <td className="px-2 text-right tabular-nums">{pctf(p.presisi, 0)}</td>
      <td className="px-2 text-right tabular-nums">{pctf(p.recall, 0)}</td>
    </tr>
  );
  return (
    <div className="mt-3">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8f99a8]">Titik operasi pada {nf(uji)} peristiwa uji</h4>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] text-[11px]">
          <thead className="text-left text-[10px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
            <th className="px-2 py-1 font-medium">Keputusan</th><th className="px-2 text-right font-medium">Alarm</th><th className="px-2 text-right font-medium">Laju alarm</th>
            <th className="px-2 text-right font-medium">Presisi</th><th className="px-2 text-right font-medium">Recall</th></tr></thead>
          <tbody>
            {row("Aturan: PERIKSA atau TAHAN", op.aturan_periksa_atau_tahan)}
            {row("Aturan: TAHAN", op.aturan_tahan)}
            {op.model.map((m) => row(`Model ${best}: peluang ≥ ${pctf(m.ambang, 0)}`, m,
              m.ambang === ambang?.periksa ? "ambang PERIKSA" : m.ambang === ambang?.tahan ? "ambang TAHAN" : ""))}
          </tbody>
        </table>
      </div>
      {!!op.kalibrasi.bin?.length && (
        <p className="mt-1.5 text-[10.5px] leading-snug text-[#abb3bf]">
          <span className="text-[#8f99a8]">Kalibrasi (peluang model → yang teramati): </span>
          {op.kalibrasi.bin.map((b) => `${pctf(b.rata_p, 0)} → ${pctf(b.teramati, 0)} (${nf(b.n)})`).join(" · ")}
        </p>
      )}
      <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">
        Total: model memperkirakan {op.kalibrasi.positif_diharapkan.toLocaleString("id-ID")} peristiwa positif, teramati {nf(op.kalibrasi.positif_teramati)}.
        Tanpa koreksi prior: label dipilih menurut fitur klaim, bukan menurut kelasnya, jadi peluang hasil belajar dari sampel label tetap berlaku untuk aliran.
      </p>
    </div>
  );
}

const SSL_KINDS: JenisSsl[] = ["fkrtl", "fktp", "nonkap"];
const rekaman = (n: number) => (n >= 1e6 ? `${dec(n / 1e6, 2)} juta` : n >= 1e3 ? `${nf(Math.round(n / 1e3))} ribu` : nf(n));
const DRIFT: Record<string, { label: string; cls: string }> = {
  stabil: { label: "Stabil", cls: "bg-[#199e70]/15 text-[#7fe0b8]" },
  drift: { label: "Drift", cls: "bg-[#fab219]/20 text-[#fbd38d]" },
  "terlalu sedikit data": { label: "Data sedikit", cls: "bg-white/10 text-[#abb3bf]" },
};

function Notice({ tone, title, children }: { tone: "warn" | "bad"; title: string; children?: React.ReactNode }) {
  const c = tone === "bad" ? "border-[#d03b3b]/50 bg-[#d03b3b]/10" : "border-[#fab219]/40 bg-[#fab219]/[.08]";
  return (
    <div role="status" className={`flex gap-2 rounded border px-3 py-2 text-[11.5px] ${c}`}>
      <span aria-hidden className={tone === "bad" ? "text-[#ffb4b4]" : "text-[#fbd38d]"}>⚠</span>
      <div className="min-w-0"><div className="font-semibold text-[#e5e8eb]">{title}</div>{children && <div className="mt-0.5 leading-snug text-[#d3d8de]">{children}</div>}</div>
    </div>
  );
}

/** Held-out reconstruction error per epoch: does pretraining still improve? (one series, no legend; the title names it) */
function LossSpark({ v }: { v: number[] }) {
  if (v.length < 2) return null;
  const W = 64, H = 18, lo = Math.min(...v), hi = Math.max(...v);
  const pts = v.map((x, i) => `${(i * W) / (v.length - 1)},${H - 2 - ((H - 4) * (x - lo)) / (hi - lo || 1)}`).join(" ");
  return <svg width={W} height={H} className="inline-block align-middle" role="img" aria-label={`galat held-out ${v.map((x) => dec(x, 3)).join(", ")}`}>
    <polyline points={pts} fill="none" stroke="#3987e5" strokeWidth={1.5} /><circle cx={W} cy={H - 2 - ((H - 4) * (v[v.length - 1] - lo)) / (hi - lo || 1)} r={2} fill="#3987e5" /></svg>;
}

/** Step 1 of the loop: the three self-supervised models (data, held-out error, the stream against the held-out thresholds,
 *  whether the champion uses them, the anomaly score's own evaluation) and what they add to the adaptive model (ablation). */
function SslSection({ st, sim }: { st: AlStatus; sim: AlSim | null }) {
  const ev = sim?.ssl_evaluasi ?? {};
  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_420px]">
      <Card title="Langkah 1 · Self-supervised: belajar pola dari rekaman tanpa label">
        <div className="-mx-3 -my-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-[11.5px]">
            <thead className="text-left text-[10px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
              <th className="px-3 py-1.5 font-medium">Model</th><th className="px-2 font-medium">Data latih</th><th className="px-2 font-medium" title="galat rekonstruksi pada 10% data yang tidak ikut dilatih, per epoch">Galat held-out</th>
              <th className="px-2 font-medium" title="porsi rekaman aliran di atas ambang p99 data held-out; harapannya 1%">Aliran vs p99</th>
              <th className="px-2 font-medium" title="AUPRC galat rekonstruksi saja terhadap skenario tanam, pada peristiwa uji simulasi">Deteksi sendiri</th>
              <th className="px-3 font-medium">Dipakai juara</th></tr></thead>
            <tbody>
              {SSL_KINDS.map((k) => {
                const m = st.ssl?.[k];
                const e = ev[k];
                if (!m) return (
                  <tr key={k} className="border-b border-white/[.04]"><td className="px-3 py-2 text-[#e5e8eb]">{JENIS_LABEL[k]}</td>
                    <td colSpan={5} className="px-2 text-[#8f99a8]">Belum dilatih: peristiwa jenis ini tanpa embedding dan tanpa sinyal anomali.</td></tr>
                );
                const d = DRIFT[m.drift.status] ?? DRIFT["terlalu sedikit data"];
                return (
                  <tr key={k} className="border-b border-white/[.04] align-top">
                    <td className="px-3 py-1.5"><div className="text-[#e5e8eb]">{JENIS_LABEL[k]}</div>
                      <div className="font-mono text-[10px] text-[#8f99a8]" title={m.sumber}>{m.versi.replace(/^ssl-[a-z]+-/, "")} · {m.medan} medan</div></td>
                    <td className="px-2 py-1.5 tabular-nums"><div>{rekaman(m.klaim)}</div><div className="text-[10px] text-[#8f99a8]">sebelum {m.sebelum}</div></td>
                    <td className="px-2 py-1.5"><LossSpark v={m.galat_held_out} /> <span className="tabular-nums text-[#d3d8de]">{dec(m.galat_held_out[m.galat_held_out.length - 1], 3)}</span></td>
                    <td className="px-2 py-1.5"><span className={`rounded px-1.5 py-px text-[10px] font-semibold ${d.cls}`}>{d.label}</span>
                      <div className="mt-0.5 text-[10px] tabular-nums text-[#abb3bf]">{m.drift.n ? `${pctf(m.drift.porsi_p99, 2)} dari ${nf(m.drift.n)}` : "belum ada aliran"}</div></td>
                    <td className="px-2 py-1.5 tabular-nums">{e?.auprc_galat != null ? (<>
                      <div>{dec(e.auprc_galat, 2)} <span className="text-[10px] text-[#8f99a8]">vs acak {dec(e.prevalensi ?? 0, 2)}</span></div>
                      <div className="text-[10px] text-[#8f99a8]">sinyal: normal {pctf(e.nyala_normal, 2)} · tanam {pctf(e.nyala_tanam, 0)}</div></>)
                      : <span className="text-[#8f99a8]">{e && e.n === 0 ? "tak ada di uji" : "jalankan simulasi"}</span>}</td>
                    <td className="px-3 py-1.5">{st.juara ? (m.juara_cocok ? <span className="text-[#7fe0b8]">✓ versi ini</span> : <span className="text-[#fbd38d]">versi lain: latih ulang</span>) : <span className="text-[#8f99a8]">belum ada juara</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-5 text-[10.5px] leading-snug text-[#8f99a8]">
          Masked autoencoder (VIME): 30% medan tiap rekaman ditukar dengan medan rekaman lain, jaringan belajar mengembalikannya dan menebak medan mana yang ditukar.
          Tanpa label. Hasilnya embedding 16 dimensi (fitur model adaptif dan dasar keragaman antrean) dan galat rekonstruksi (sinyal ANOMALI_SSL di atas p99,9 data held-out,
          dengan bagian yang tidak bisa direkonstruksi sebagai penjelasan). FKTP dan nonkapitasi juga belajar kecocokan diagnosis/tindakan dengan jenis kelamin, usia, poli, dan jenis faskes.
        </p>
      </Card>
      <Card title="Nilai self-supervised bagi model adaptif">
        {sim?.ablasi_ssl ? <SslValue a={sim.ablasi_ssl} /> : <p className="text-[11.5px] text-[#8f99a8]">Jalankan simulasi kurva belajar: strategi terbaik diulang tanpa fitur self-supervised untuk mengukur sumbangannya.</p>}
      </Card>
    </div>
  );
}

/** AUPRC with vs without the SSL features, per event kind (grouped bars on one axis), the rule score as a tick. */
function SslValue({ a }: { a: Ablasi }) {
  const [hover, setHover] = useState<string | null>(null);
  const rows = [
    ...SSL_KINDS.filter((k) => a.per_jenis[k]).map((k) => ({ key: k, label: JENIS_SHORT[k], ...a.per_jenis[k] })),
    { key: "semua", label: "Semua", n: 0, positif: 0, aturan: null as number | null, dengan: a.dengan_ssl, tanpa: a.tanpa_ssl },
  ];
  const max = Math.min(1, Math.max(0.2, ...rows.flatMap((r) => [r.dengan ?? 0, r.tanpa ?? 0, r.aturan ?? 0])) + 0.08);
  const W = 380, L = 56, R = 40, rowH = 34, bar = 9, T = 6;
  const x = (v: number) => L + ((W - L - R) * v) / max;
  const H = T + rows.length * rowH + 18;
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= max);
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[#abb3bf]">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-[#3987e5]" />Dengan self-supervised</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-[#8f99a8]" />Tanpa</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-0 border-l-2 border-dashed border-[#e5e8eb]" />Skor aturan</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block max-w-full" role="img" aria-label="AUPRC model adaptif dengan dan tanpa fitur self-supervised per jenis peristiwa">
        {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={T} y2={H - 16} stroke="#2c333b" /><text x={x(t)} y={H - 4} fill="#8f99a8" fontSize={9.5} textAnchor="middle">{dec(t, 2)}</text></g>)}
        {rows.map((r, i) => {
          const y0 = T + i * rowH + 6;
          const delta = r.dengan != null && r.tanpa != null ? r.dengan - r.tanpa : null;
          return (
            <g key={r.key} onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)}>
              <rect x={0} y={y0 - 4} width={W} height={rowH - 4} fill={hover === r.key ? "rgba(255,255,255,.04)" : "transparent"} />
              <text x={L - 8} y={y0 + bar + 2} fill={r.key === "semua" ? "#fff" : "#d3d8de"} fontSize={10.5} fontWeight={r.key === "semua" ? 600 : 400} textAnchor="end">{r.label}</text>
              {r.dengan != null && <><rect x={L} y={y0} width={Math.max(2, x(r.dengan) - L)} height={bar} rx={2} fill="#3987e5" />
                <text x={x(r.dengan) + 4} y={y0 + bar - 1} fill="#e5e8eb" fontSize={9.5}>{dec(r.dengan, 2)}</text></>}
              {r.tanpa != null && <><rect x={L} y={y0 + bar + 2} width={Math.max(2, x(r.tanpa) - L)} height={bar} rx={2} fill="#8f99a8" />
                <text x={x(r.tanpa) + 4} y={y0 + 2 * bar + 1} fill="#abb3bf" fontSize={9.5}>{dec(r.tanpa, 2)}</text></>}
              {r.aturan != null && <line x1={x(r.aturan)} x2={x(r.aturan)} y1={y0 - 3} y2={y0 + 2 * bar + 5} stroke="#e5e8eb" strokeWidth={1.5} strokeDasharray="3 2" />}
              {hover === r.key && delta != null && (
                <text x={W - 2} y={y0 - 5 < T ? y0 + 2 * bar + 12 : y0 - 5} fill={delta >= 0 ? "#7fe0b8" : "#ffb4b4"} fontSize={9.5} textAnchor="end">
                  {delta >= 0 ? "+" : "−"}{dec(Math.abs(delta), 3)}{r.n ? ` · ${nf(r.n)} peristiwa uji, ${nf(r.positif)} positif` : ""}{r.aturan != null ? ` · aturan ${dec(r.aturan, 2)}` : ""}</text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">
        AUPRC pada peristiwa uji; strategi {STRAT_LABEL[a.strategi] ?? a.strategi}, rata-rata {a.seed} seed, label dan ronde sama. Selisih kecil antar seed itu wajar:
        per seed dengan {a.per_seed.dengan?.map((v) => (v == null ? "–" : dec(v, 3))).join(" / ")}, tanpa {a.per_seed.tanpa?.map((v) => (v == null ? "–" : dec(v, 3))).join(" / ")}.
      </p>
    </div>
  );
}

function ActiveLearningView({ admin, onOpen }: { admin: boolean; onOpen: (id: string) => void }) {
  const [st, setSt] = useState<AlStatus | null>(null);
  const [sim, setSim] = useState<AlSim | null>(null);
  const [queue, setQueue] = useState<AntreanRow[]>([]);
  const [strat, setStrat] = useState("hibrida");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const load = useCallback(() => {
    req<AlStatus>("/al").then(setSt).catch(() => {});
    req<{ hasil: AlSim | null }>("/al/simulasi").then((r) => setSim(r.hasil)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 4000);
    return () => clearInterval(t);
  }, [load]);
  const fetchQueue = useCallback((s: string) => {
    setBusy("q");
    req<{ antrean: AntreanRow[] }>(`/al/antrean?n=12&strategi=${s}`).then((r) => setQueue(r.antrean)).catch((x) => setMsg((x as Error).message)).finally(() => setBusy(""));
  }, []);
  useEffect(() => { fetchQueue(strat); }, [strat, fetchQueue]);
  const act = async (what: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(what); setMsg("");
    try { const r = await f(); if (ok) setMsg(ok); load(); return r; } catch (x) { setMsg((x as Error).message); } finally { setBusy(""); }
  };
  const label = (id: string, v: 0 | 1) => act("lab" + id, async () => {
    await post("/al/label", { peristiwa: id, label: v });
    setQueue((q) => q.filter((r) => r.id !== id));
  });
  if (!st) return <p className="text-[12px] text-[#8f99a8]">Memuat…</p>;
  const labels = Object.values(st.label).reduce((a, b) => ({ label: a.label + b.label, positif: a.positif + b.positif }), { label: 0, positif: 0 });
  const j = st.juara;
  const sslAll = SSL_KINDS.map((k) => st.ssl?.[k]).filter((m): m is SslInfo => !!m);
  const sslN = sslAll.length;
  const sslDrift = sslAll.filter((m) => m.drift.status === "drift");
  const sslStale = j ? sslAll.filter((m) => !m.juara_cocok) : [];
  const sslRun = st.ssl_latih.status === "berjalan";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Self-supervised (tanpa label)" value={sslN ? `${sslN} dari 3 model` : "belum dilatih"}
          sub={sslN ? `${rekaman(sslAll.reduce((a, m) => a + m.klaim, 0))} rekaman · ${sslDrift.length ? `drift: ${sslDrift.map((m) => JENIS_SHORT[m.jenis]).join(", ")}` : "aliran stabil"}` : "latih untuk FKRTL, FKTP, dan nonkapitasi"}
          tone={sslDrift.length ? "text-[#fbd38d]" : undefined} />
        <Tile label="Model juara (adaptif)" value={j ? j.versi : "belum ada"} sub={j ? `${j.label} label · AUPRC CV ${j.cv_auprc_model != null ? dec(j.cv_auprc_model, 2) : "–"} vs aturan ${j.cv_auprc_aturan != null ? dec(j.cv_auprc_aturan, 2) : "–"}` : "latih dari label atau promosikan hasil simulasi"} />
        <Tile label="Label terkumpul" value={nf(labels.label)} sub={Object.entries(st.label).map(([k, v]) => `${k} ${v.label} (${v.positif}+)`).join(" · ") || "belum ada"} />
        <Tile label="Mode model adaptif" value={st.mode === "aktif" ? "Aktif" : st.mode === "bayangan" ? "Bayangan" : "Mati"}
          sub={st.mode === "aktif" ? `keputusan dari model adaptif: PERIKSA bila peluang ≥ ${pctf(st.ambang?.periksa ?? 0.3, 0)}, TAHAN ≥ ${pctf(st.ambang?.tahan ?? 0.7, 0)}` : st.mode === "bayangan" ? "dicatat di tiap peristiwa, keputusan dari aturan" : "tidak dihitung"} />
      </div>
      {admin && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <button disabled={!!busy || sslRun} onClick={() => act("ssl", () => post("/al/ssl/latih", { jenis: ["fkrtl", "fktp", "nonkap"] }), "Pretraining self-supervised dimulai: FKRTL, FKTP, lalu nonkapitasi (±1 menit).")} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10 disabled:opacity-40">
            {sslRun ? `Melatih SSL ${st.ssl_latih.progres?.jenis ? JENIS_SHORT[st.ssl_latih.progres.jenis] : ""}… ${st.ssl_latih.progres?.epoch ? `epoch ${st.ssl_latih.progres.epoch}/${st.ssl_latih.progres.dari}` : "memuat data"}` : "Latih ulang self-supervised"}</button>
          <button disabled={!!busy} onClick={() => act("train", () => post("/al/latih", {}), "Challenger dilatih dari label; lihat gerbang di registri.")} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10">Latih ulang dari label</button>
          <button disabled={!!busy || st.simulasi.status === "berjalan"} onClick={() => act("sim", () => post("/al/simulasi", { strategi: ["acak", "entropi", "epistemik", "hibrida"], ronde: 30, per_ronde: 25 }), "Simulasi kurva belajar dimulai.")} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10 disabled:opacity-40">
            {st.simulasi.status === "berjalan" ? `Simulasi… ${st.simulasi.progres ? `${st.simulasi.progres.strategi} ronde ${st.simulasi.progres.ronde}/${st.simulasi.progres.dari}` : ""}` : "Jalankan simulasi kurva belajar"}</button>
          {st.bisa_dipromosikan && <button disabled={!!busy} onClick={() => act("promo", () => post("/al/simulasi/promosikan", {}), "Model terbaik simulasi diuji gerbang.")} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10">Promosikan model terbaik simulasi</button>}
          <span className="ml-auto flex items-center gap-1 text-[#abb3bf]">mode
            {(["bayangan", "aktif", "mati"] as const).map((m) => (
              <button key={m} disabled={!!busy} onClick={() => act("mode", () => post("/al/mode", { mode: m }))} className={`rounded px-2 py-0.5 ${st.mode === m ? "bg-white/10 text-white" : "hover:bg-white/5"}`}>{m}</button>
            ))}
          </span>
        </div>
      )}
      {msg && <p className="text-[11px] text-[#d3d8de]">{msg}</p>}
      {st.ssl_latih.status === "gagal" && <Notice tone="bad" title="Pretraining self-supervised gagal">{st.ssl_latih.galat}</Notice>}
      {!!sslStale.length && (
        <Notice tone="warn" title={`Model juara memakai self-supervised versi lain untuk ${sslStale.map((m) => JENIS_SHORT[m.jenis]).join(", ")}`}>
          Fitur self-supervised jenis itu diabaikan juara (aman: tidak dicampur dengan ruang embedding baru), jadi manfaatnya hilang sampai juara dilatih ulang.
          {admin ? " Jalankan simulasi lalu promosikan, atau latih ulang dari label." : ""}
        </Notice>
      )}
      {sslDrift.map((m) => (
        <Notice key={m.jenis} tone="warn" title={`Pola ${m.nama} di aliran bergeser dari data pelatihan`}>
          {pctf(m.drift.porsi_p99, 1)} dari {nf(m.drift.n)} {m.nama} di atas ambang p99 (harapan 1%, binomial p = {m.drift.p_binomial?.toExponential(1) ?? "–"}).
          Model menilai banyak rekaman wajar sebagai tidak lazim; latih ulang self-supervised dengan data terbaru.
        </Notice>
      ))}
      <SslSection st={st} sim={sim} />
      <div className="grid gap-3 xl:grid-cols-[1fr_420px]">
        <Card title="Langkah 2 · Makin baik dari waktu ke waktu: kurva belajar (simulasi dengan oracle)">
          {sim ? (<>
            <LearningCurve sim={sim} />
            <div className="mt-2 grid gap-x-4 gap-y-0.5 text-[11px] text-[#abb3bf] md:grid-cols-2">
              <span>Pool {nf(sim.pool)} peristiwa ({nf(sim.positif_pool)} positif) · uji {nf(sim.uji)} ({pctf(sim.prevalensi_uji, 1)} positif)</span>
              <span>Label awal {sim.label_awal} acak, lalu {sim.per_ronde} per ronde × {sim.ronde} ronde</span>
              <span>AUPRC skor aturan {dec(sim.auprc_skor_aturan, 3)} · model ML produksi saja {sim.auprc_model_produksi_saja != null ? dec(sim.auprc_model_produksi_saja, 3) : "–"}</span>
              <span>Label untuk melampaui aturan: {Object.entries(sim.label_untuk_melampaui_aturan).map(([s, v]) => `${STRAT_LABEL[s] ?? s} ${v ?? "tidak"}`).join(" · ")}</span>
            </div>
            {sim.titik_operasi && <OperatingPoints op={sim.titik_operasi} uji={sim.uji} best={STRAT_LABEL[sim.terbaik] ?? sim.terbaik} ambang={st.ambang} />}
            <p className="mt-2 text-[10.5px] leading-snug text-[#8f99a8]">{sim.catatan}</p>
          </>) : <p className="text-[11.5px] text-[#8f99a8]">Belum ada simulasi. Jalankan setelah aliran berisi peristiwa dengan skenario tanam.</p>}
        </Card>
        <Card title="Cara kerjanya (MONAI Label untuk klaim)">
          <ol className="list-decimal space-y-1.5 pl-4 text-[11.5px] leading-snug text-[#d3d8de]">
            <li><b>Pretraining self-supervised</b> tanpa label, satu model per jenis (klaim FKRTL, kunjungan FKTP, klaim nonkapitasi): masked autoencoder (VIME) merekonstruksi medan yang ditukar. Hasilnya embedding tiap peristiwa dan skor anomali dengan penjelasannya (sinyal ANOMALI_SSL untuk pola yang tak dikenal aturan).</li>
            <li><b>Strategi aktif</b> memilih peristiwa yang paling informatif untuk ditelaah: ketidakpastian, ketidaksepakatan komite (setara Epistemic di MONAI), keragaman di ruang embedding, nilai rupiah.</li>
            <li><b>Label</b> dari antrean telaah dan dari keputusan kasus (konfirmasi = 1, false positive = 0).</li>
            <li><b>Latih ulang</b> komite LightGBM; <b>gerbang</b>: AUPRC validasi silang ≥ skor aturan, ≥ 10 label tiap kelas. Juara berjalan <b>bayangan</b> dulu, lalu <b>aktif</b> atas keputusan admin.</li>
          </ol>
          {j && !!j.fitur_penting.length && (<>
            <h4 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8f99a8]">Yang paling dipakai model juara</h4>
            {j.fitur_penting.slice(0, 8).map((f) => (
              <div key={f.fitur} className="mb-1">
                <div className="flex justify-between text-[10.5px]"><span className="truncate text-[#d3d8de]" title={f.fitur}>{fiturLabel(f.fitur)}</span><span className="tabular-nums text-[#abb3bf]">{pctf(f.porsi, 0)}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full rounded-full bg-[#3987e5]" style={{ width: `${100 * f.porsi / j.fitur_penting[0].porsi}%` }} /></div>
              </div>
            ))}
          </>)}
        </Card>
      </div>
      <Card title="Langkah 3 · Antrean telaah: peristiwa yang paling banyak mengajari model" right={
        <span className="flex items-center gap-1 text-[10.5px] text-[#abb3bf]">strategi
          <select value={strat} onChange={(x) => setStrat(x.target.value)} className="rounded border border-white/15 bg-[#141920] px-1 py-0.5 text-[11px] text-white">
            {Object.entries(STRAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={() => fetchQueue(strat)} className="rounded px-1.5 py-0.5 hover:bg-white/10" title="Muat ulang"><Icon name="refresh" className="h-3 w-3" /></button>
        </span>}>
        <div className="-mx-3 -my-3 overflow-x-auto">
          <table className="w-full min-w-[860px] text-[11.5px]">
            <thead className="text-left text-[10.5px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
              <th className="px-3 py-1.5 font-medium">Jenis</th><th className="px-2 font-medium">Faskes</th><th className="px-2 font-medium">Kode</th><th className="px-2 font-medium">Skor aturan</th>
              <th className="px-2 text-right font-medium" title="peluang perlu tindakan menurut komite, ± ketidaksepakatan antar anggota komite">p komite</th><th className="px-2 font-medium">Mengapa dipilih</th><th className="px-3 text-right font-medium">Label</th></tr></thead>
            <tbody>
              {queue.map((r) => (
                <tr key={r.id} className="border-b border-white/[.04]">
                  <td className="whitespace-nowrap px-3 py-1 text-[#abb3bf]">{JENIS_SHORT[r.jenis ?? "fkrtl"]}</td>
                  <td className="max-w-[220px] cursor-pointer truncate px-2 text-[#e5e8eb] hover:underline" title={r.faskes_label} onClick={() => onOpen(r.id)}>{r.faskes_label}</td>
                  <td className="max-w-[140px] truncate px-2 font-mono text-[10.5px]">{r.kode}</td>
                  <td className="px-2"><ScoreBar skor={r.skor} /></td>
                  <td className="px-2 text-right tabular-nums">{r.p != null ? `${dec(r.p, 2)} ± ${dec(r.sd ?? 0, 2)}` : "–"}</td>
                  <td className="max-w-[260px] truncate px-2 text-[#d3d8de]" title={r.alasan_pilih}>{r.alasan_pilih}</td>
                  <td className="whitespace-nowrap px-3 text-right">
                    {admin ? (<span className="inline-flex gap-1">
                      <button disabled={!!busy} onClick={() => label(r.id, 1)} className="rounded border border-[#d03b3b]/60 bg-[#d03b3b]/15 px-1.5 py-0.5 text-[10.5px] text-white hover:bg-[#d03b3b]/25">Perlu tindakan</button>
                      <button disabled={!!busy} onClick={() => label(r.id, 0)} className="rounded border border-[#199e70]/60 bg-[#199e70]/15 px-1.5 py-0.5 text-[10.5px] text-white hover:bg-[#199e70]/25">Wajar</button>
                    </span>) : <span className="text-[#5f6b7c]">–</span>}
                  </td>
                </tr>
              ))}
              {!queue.length && <tr><td colSpan={7} className="px-3 py-5 text-center text-[#8f99a8]">{busy === "q" ? "Memilih…" : "Antrean kosong."}</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Langkah 4 · Registri model adaptif (challenger, gerbang, juara)">
        <div className="-mx-3 -my-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-[11.5px]">
            <thead className="text-left text-[10.5px] uppercase tracking-[0.06em] text-[#8f99a8]"><tr className="border-b border-white/[.06]">
              <th className="px-3 py-1.5 font-medium">Versi</th><th className="px-2 font-medium">Sumber label</th><th className="px-2 text-right font-medium">Label (+/−)</th>
              <th className="px-2 text-right font-medium">AUPRC CV model</th><th className="px-2 text-right font-medium">AUPRC CV aturan</th><th className="px-3 font-medium">Gerbang</th></tr></thead>
            <tbody>
              {[...st.registri].reverse().map((m) => (
                <tr key={m.versi} className="border-b border-white/[.04]">
                  <td className="whitespace-nowrap px-3 py-1 font-mono text-[10.5px]">{m.versi}{m.juara ? <span className="ml-1 rounded bg-[#199e70]/20 px-1 font-sans text-[9.5px] text-[#7fe0b8]">juara</span> : null}</td>
                  <td className="max-w-[220px] truncate px-2 text-[#abb3bf]" title={m.sumber}>{m.sumber}</td>
                  <td className="px-2 text-right tabular-nums">{m.label} ({m.positif}/{m.negatif})</td>
                  <td className="px-2 text-right tabular-nums">{m.cv_auprc_model != null ? dec(m.cv_auprc_model, 3) : "–"}</td>
                  <td className="px-2 text-right tabular-nums">{m.cv_auprc_aturan != null ? dec(m.cv_auprc_aturan, 3) : "–"}</td>
                  <td className="max-w-[280px] truncate px-3 text-[#d3d8de]" title={m.gerbang}>{m.gerbang}</td>
                </tr>
              ))}
              {!st.registri.length && <tr><td colSpan={6} className="px-3 py-4 text-center text-[#8f99a8]">Belum ada model.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Integration                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */
const QUANTEXA: [string, string, string][] = [
  ["Data ingestion (batch + real-time)", "Klaim FKRTL, kunjungan FKTP (+rujukan), klaim nonkapitasi: POST /klaim, /fktp, /nonkapitasi (sesi/PAT) dan /faskes/klaim (SIMRS faskes, token ingest); simulator replay tiga jenis", "ada"],
  ["Entity resolution + kualitas entitas", "Peserta: registri (jenis kelamin, usia, hak kelas, keluarga, tahun meninggal) untuk tiap kartu; kematian yang tercatat di aliran; kartu kerabat (keluarga). Pasien kiriman faskes: no RM + nama (Jaro-Winkler), identitas ganda tidak digabung otomatis, skor kualitas", "ada"],
  ["Graph generation dinamis", "Graf jendela 30 hari waktu layanan: peserta–faskes, faskes–faskes, FKTP → tujuan rujukan; dipulihkan dari peristiwa tersimpan saat mesin dinyalakan ulang", "ada"],
  ["Graph analytics & scoring", "Cincin (Poisson vs riwayat pasangan), rujukan memusat (binomial vs sebaran riwayat FKTP), tumpang tindih, kartu banyak faskes, kloning, lonjakan keparahan, LOS faskes bergeser, kontak semu/rendah", "ada"],
  ["Contextual ML scoring", "Model produksi ter-deploy + fitur point-in-time termasuk riwayat aliran; TreeSHAP untuk klaim yang di-alert", "ada"],
  ["Mitigating factors (kurangi false positive)", "Rujukan berjenjang, pindah rawat satu provinsi, IGD, pulang paksa, naik kelas atas permintaan sendiri, tanggal lahir pengganti, registri tahun saja, tarif referensi, bukti perangkat IoMT; skor tanpa mitigasi disimpan", "ada"],
  ["Alert triage & konsolidasi per entitas", "Satu kasus per faskes / peserta / cincin, prioritas skor × nilai rupiah, modus Permenkes per kasus", "ada"],
  ["Case management + feedback", "Telaah / konfirmasi / false positive → status tag di ledger indikasi; jejak keputusan", "ada"],
  ["Network visualisation", "Graf ego kasus, cincin, lonjakan", "ada"],
  ["Send signals to other tools", "Ledger indikasi (tag deteksi_realtime, tag baru untuk M01/M02/M03/M14/M15/M17/M18/M20) → Box Karantina → AI Agent Swarm; Nexus lewat ledger", "ada"],
  ["Investigations copilot (Q Assist)", "Ringkasan investigasi per kasus dari templat: temuan, modus, bukti terkuat, jaringan, dokumen yang diminta, batas data. Tanpa model bahasa (tidak ada data dikirim keluar); AIP Operator tetap bisa ditanya", "ada"],
  ["Model retraining dari umpan balik", "Bobot sinyal dikalibrasi dari keputusan kasus (Beta posterior) dan diterapkan admin; label kasus diekspor (CSV) untuk melatih ulang model ML", "ada"],
];

function IntegrationView({ st, admin, refresh }: { st: Status; admin: boolean; refresh: () => void }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [token, setToken] = useState("");
  const [cfg, setCfg] = useState({ ambang_periksa: st.konfigurasi.ambang_periksa, ambang_tahan: st.konfigurasi.ambang_tahan });
  const [hapusTag, setHapusTag] = useState(false);
  const act = async (what: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(what); setMsg("");
    try { await f(); if (ok) setMsg(ok); refresh(); } catch (x) { setMsg((x as Error).message); } finally { setBusy(""); }
  };
  const flow: [string, string][] = [
    ["Faskes (ai-jkn) · Simulator", `${Object.entries(st.sumber).map(([k, v]) => `${k} ${nf(v.klaim)}`).join(" · ") || "–"}`],
    ["Ingest + kontrak", `antrean ${nf(st.antrean)}`],
    ["Entity resolution", "peserta · pasien · faskes"],
    ["Graf dinamis", st.graf ? `${nf(st.graf.klaim_di_jendela)} klaim · ${nf(st.graf.pasangan_tidak_wajar)} pasangan tidak wajar` : "–"],
    ["Skor: model + aturan + graf − mitigasi", `p50 ${nf(st.latensi_ms.p50)} ms`],
    ["Keputusan", `${nf(st.keputusan.PERIKSA)} periksa · ${nf(st.keputusan.TAHAN)} tahan`],
    ["Kasus per entitas", `${nf(st.kasus.terbuka)} terbuka`],
    ["Ledger indikasi", `${nf(st.integrasi.tag_ditulis)} tag`],
    ["Box Karantina", st.integrasi.box_terakhir ? `${nf(st.integrasi.box_terakhir.faskes)} faskes · ${wibIso(st.integrasi.box_terakhir.pada)}` : st.integrasi.box_terjadwal ? "rebuild dijadwalkan" : "–"],
    ["AI Agent Swarm", "membaca ledger + box"],
  ];
  const reg = Object.entries(st.registri);
  return (
    <div className="space-y-3">
      <Card title="Alur: dari klaim masuk sampai sistem audit">
        <div className="flex flex-wrap items-stretch gap-1.5">
          {flow.map(([a, b], i) => (
            <div key={a} className="flex items-center gap-1.5">
              <div className="w-[150px] rounded border border-white/[.08] bg-[#141920] px-2 py-1.5">
                <div className="text-[11px] font-medium text-[#e5e8eb]">{a}</div>
                <div className="mt-0.5 text-[10px] leading-snug text-[#abb3bf]">{b}</div>
              </div>
              {i < flow.length - 1 && <Icon name="right" className="h-3 w-3 shrink-0 text-[#5f6b7c]" />}
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card title="Kemampuan fraud ala Quantexa → di sistem ini">
          <table className="w-full text-[11px]">
            <tbody>
              {QUANTEXA.map(([q, here, s]) => (
                <tr key={q} className="border-b border-white/[.04] align-top">
                  <td className="w-[34%] py-1 pr-2 font-medium text-[#e5e8eb]">{q}</td>
                  <td className="py-1 pr-2 text-[#abb3bf]">{here}</td>
                  <td className="py-1 text-right"><span className={`rounded px-1.5 py-px text-[10px] ${s === "ada" ? "bg-[#199e70]/20 text-[#7fe0b8]" : s === "sebagian" ? "bg-[#fab219]/15 text-[#fbd38d]" : "bg-white/10 text-[#abb3bf]"}`}>{s}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="space-y-3">
          <Card title="Faskes terhubung (registri sistem audit)">
            {!reg.length && <p className="text-[11.5px] text-[#8f99a8]">Belum ada faskes terdaftar.</p>}
            {reg.map(([k, s]) => (
              <div key={k} className="mb-2 text-[11.5px]">
                <div className="flex items-center gap-2"><Icon name="plug" className="h-3.5 w-3.5 text-[#7fe0b8]" /><span className="font-medium text-[#e5e8eb]">{s.nama}</span><span className="text-[10.5px] text-[#8f99a8]">({k})</span></div>
                <div className="ml-5 text-[10.5px] text-[#abb3bf]">{s.tipe_fkrtl ?? s.jenis_fkrtl} · {s.kepemilikan_fkrtl} · {s.kabkota_fkrtl} ({s.kabkota_fkrtl_kode}), {s.provinsi_fkrtl} · {s.regional_tarif ?? "-"}</div>
                {s.catatan && <div className="ml-5 text-[10.5px] text-[#8f99a8]">{s.catatan}</div>}
              </div>
            ))}
            <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">Profil faskes diambil dari registri ini, bukan dari deklarasi faskes. Faskes hanya menerima tanda terima, tidak pernah skor atau keputusan (tidak ada tipping-off).</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/[.06] pt-2 text-[11px]">
              <span className={st.token_ingest ? "text-[#7fe0b8]" : "text-[#fbd38d]"}>Token ingest {st.token_ingest ? "aktif (hanya hash SHA-256 disimpan)" : "belum dibuat"}</span>
              {admin && <button disabled={!!busy} onClick={() => act("token", async () => setToken((await post<{ token: string }>("/token", {})).token))} className="ml-auto rounded border border-white/15 px-2 py-0.5 hover:bg-white/10">Buat token baru</button>}
            </div>
            {token && <div className="mt-1.5 rounded border border-[#fab219]/40 bg-[#fab219]/10 p-2 text-[10.5px] text-[#fbd38d]">Ditampilkan sekali. Simpan sebagai AUDIT_REALTIME_TOKEN di sistem faskes; token lama tidak berlaku lagi.<div className="mt-1 select-all break-all font-mono text-white">{token}</div></div>}
          </Card>
          <Card title="Mesin dan ambang">
            <div className="flex flex-wrap items-end gap-2 text-[11px]">
              <label className="flex flex-col gap-0.5 text-[#abb3bf]">Ambang PERIKSA<input type="number" min={1} max={99} value={cfg.ambang_periksa} disabled={!admin} onChange={(x) => setCfg({ ...cfg, ambang_periksa: Number(x.target.value) })} className="w-20 rounded border border-white/15 bg-[#141920] px-1.5 py-0.5 text-white" /></label>
              <label className="flex flex-col gap-0.5 text-[#abb3bf]">Ambang TAHAN<input type="number" min={2} max={100} value={cfg.ambang_tahan} disabled={!admin} onChange={(x) => setCfg({ ...cfg, ambang_tahan: Number(x.target.value) })} className="w-20 rounded border border-white/15 bg-[#141920] px-1.5 py-0.5 text-white" /></label>
              {admin && <button disabled={!!busy} onClick={() => act("cfg", () => post("/mesin", cfg), "Ambang disimpan: berlaku untuk klaim berikutnya.")} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10">Simpan ambang</button>}
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[#d3d8de]">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={st.konfigurasi.tulis_tag} disabled={!admin || !!busy} onChange={(x) => act("tag", () => post("/mesin", { tulis_tag: x.target.checked }))} />Tulis alert ke ledger indikasi</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={st.konfigurasi.box_otomatis} disabled={!admin || !!busy} onChange={(x) => act("box", () => post("/mesin", { box_otomatis: x.target.checked }))} />Rebuild Box Karantina otomatis</label>
            </div>
            {admin && (
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/[.06] pt-2 text-[11px]">
                <button disabled={!!busy} onClick={() => act("boxnow", () => post("/box", {}), "Box Karantina dibangun ulang dari tag.")} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10">Rebuild Box Karantina sekarang</button>
                <label className="ml-auto flex items-center gap-1 text-[#abb3bf]"><input type="checkbox" checked={hapusTag} onChange={(x) => setHapusTag(x.target.checked)} />hapus juga tag realtime</label>
                <button disabled={!!busy} onClick={() => { if (window.confirm("Hapus semua keputusan, kasus dan graf aliran realtime?")) act("reset", () => post("/reset", { hapus_tag: hapusTag }), "Aliran direset."); }}
                  className="rounded border border-[#d03b3b]/50 px-2 py-1 text-[#ffb4b4] hover:bg-[#d03b3b]/15">Reset aliran</button>
              </div>
            )}
            {st.pemanasan.model_run && <p className="mt-2 text-[10.5px] leading-snug text-[#8f99a8]">Model {st.pemanasan.model_versi} (run {st.pemanasan.model_run}); riwayat peserta {nf(st.pemanasan.riwayat_baris)} baris (jendela replay {st.pemanasan.jendela_replay?.join(" s.d. ")} dikeluarkan); {nf(st.pemanasan.pasangan_baseline)} baseline pasangan faskes; dimuat {st.pemanasan.detik} detik.</p>}
            {st.integrasi.box_galat && <p className="mt-1 text-[11px] text-red-300">Box: {st.integrasi.box_galat}</p>}
            {msg && <p className="mt-1 text-[11px] text-[#d3d8de]">{msg}</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
type Sub = "live" | "kasus" | "modus" | "al" | "jaringan" | "evaluasi" | "integrasi";
export function RealtimeFraudView({ onBox }: { onBox?: (faskes?: string) => void }) {
  const [sub, setSub] = useState<Sub>("live");
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    req<Status>("/status").then((s) => { setSt(s); setErr(""); }).catch((x) => setErr((x as Error).message));
  }, []);
  useEffect(() => {
    refresh();
    fetch(`${API_URL}/api/auth/me`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((m) => setAdmin(!m || m.role === "admin" || m.user?.role === "admin")).catch(() => setAdmin(false));
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  const toggle = async () => {
    if (!st) return;
    setBusy(true);
    try { setSt(await post<Status>("/mesin", { aktif: !st.aktif })); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const tabs: [Sub, string][] = [["live", "Live"], ["kasus", `Kasus${st?.kasus.terbuka ? ` (${st.kasus.terbuka})` : ""}`], ["modus", "Modus (20)"],
    ["al", "Active Learning"], ["jaringan", "Jaringan"], ["evaluasi", "Evaluasi"], ["integrasi", "Integrasi"]];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/5 bg-[#1c2127] px-3 py-1.5 text-[11.5px]">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setSub(k)} className={`rounded px-2 py-0.5 ${sub === k ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{l}</button>)}
        <span className="ml-auto flex items-center gap-2">
          {st && (st.aktif
            ? <span className="flex items-center gap-1 text-[10.5px] text-[#7fe0b8]"><span className={`h-1.5 w-1.5 rounded-full bg-[#7fe0b8] ${st.siap ? "animate-pulse" : ""}`} />{st.siap ? "mesin aktif" : "memuat model…"}</span>
            : <span className="text-[10.5px] text-[#8f99a8]">mesin mati</span>)}
          {admin && st && <button disabled={busy} onClick={toggle} className={`rounded border px-2 py-0.5 text-[11px] ${st.aktif ? "border-white/15 text-[#abb3bf] hover:bg-white/10" : "border-[#199e70]/60 bg-[#199e70]/20 text-white hover:bg-[#199e70]/30"}`}>{st.aktif ? "Matikan mesin" : "Nyalakan mesin"}</button>}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {err && <p className="mb-2 rounded border border-red-400/30 bg-red-400/10 px-2 py-1 text-[11.5px] text-red-200">{err}</p>}
        {st?.galat && <p className="mb-2 rounded border border-[#fab219]/30 bg-[#fab219]/10 px-2 py-1 text-[11.5px] text-[#fbd38d]">Mesin: {st.galat}</p>}
        {!st ? <p className="text-[12px] text-[#8f99a8]">Memuat…</p> : (<>
          {sub === "live" && <LiveView st={st} admin={admin} onOpen={setOpen} refresh={refresh} />}
          {sub === "kasus" && <CasesView admin={admin} onOpen={setOpen} onBox={onBox} />}
          {sub === "modus" && <ModesView />}
          {sub === "al" && <ActiveLearningView admin={admin} onOpen={setOpen} />}
          {sub === "jaringan" && <NetworkView />}
          {sub === "evaluasi" && <EvalView admin={admin} />}
          {sub === "integrasi" && <IntegrationView st={st} admin={admin} refresh={refresh} />}
        </>)}
        <p className="mt-4 text-[10.5px] leading-snug text-[#5f6b7c]">
          Realtime Fraud: entity resolution → graf dinamis → model + aturan + graf − konteks mitigasi → kasus per entitas → ledger indikasi → Box Karantina → AI Agent Swarm.
          Semua klaim di sini sintetis (replay data sintetis dan kiriman faskes demo). Keputusan adalah indikasi untuk diperiksa manusia, bukan bukti fraud.
        </p>
      </div>
      {open && <EventDetail id={open} admin={admin} onClose={() => setOpen(null)} />}
    </div>
  );
}
