import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/*
 * AI Agent Swarm Branch: what a run did, step by step, and what it cost (the report's "Jejak kerja" and "Biaya & token" tabs,
 * GET /api/swarm-cabang?run=<id>&jejak=1 and &biaya=1). Server only: it reads the runner's own records and never calls a model.
 *   .tmp/kc_tema/<set>/status.json                 the runner's status (testing/jalan_kc_tema.py Status): cap, spent, gate counts
 *   .tmp/kc_tema/<set>/log_NN.txt                  one feature chunk per replica (fitur)
 *   .tmp/kc_tema/<set>/log_zona|iot|swarm|laporan|laporan_narasi|narasi.txt   every invocation of a stage, "===== <time> <cmd>"
 *   .tmp/kc_tema/<set>/perkiraan.json              the claims picked for the swarm and its estimate (zona, aturan)
 *   .tmp/kc_tema/<set>/swarm_v5/jalur_<set>.json   the rule findings handed to the swarm (aturan)
 *   .tmp/kc_tema/<set>/swarm_v5/gerbang_<set>.json the gate after the swarm (perlu diperiksa / dibersihkan)
 *   .tmp/kc_tema/<set>/swarm_v5/biaya_runner.json  the cost book: one row per smoke, swarm and writer invocation
 *   .tmp/kc_tema/<set>/swarm_v5/cache_adk.jsonl    every finished batch of agent answers with its time (no tokens, no cost)
 *   <data>/_jalan/<set>.log                         the app launcher's log (the runner's own lines), when the app started the run
 *   <data>/runs.json                                the report's own cost (biaya_swarm, biaya_narasi) and counts
 * What is not recorded stays unrecorded: the cost book prices calls per invocation, not per agent, so per-agent cost, cached
 * input tokens and the time of a stage without a log are reported as missing, never estimated. Model and vendor names in the
 * logs are never passed on.
 */

const ROOT = process.env.BLUESANDAI_ROOT ?? path.join(process.cwd(), "..");
const KC_TEMA = path.join(ROOT, ".tmp", "kc_tema");
const SKRIP_SWARM = path.join(ROOT, "testing", "swarm_v5_adk.py");

export type BiayaModel = { usd: number; panggilan: number; token_masuk: number; token_keluar: number; cache?: number; gagal?: number;
  selesai?: number; throttle?: number; berhenti?: string | null };
/** a progress line of the swarm or the writer: minutes since the invocation began, batches done, cost and calls so far */
export type Titik = { menit: number; batch: number; dari: number; usd: number; panggilan: number | null; cache: number; gagal: number };
export type Percobaan = { mulai: string; detik: number | null; jenis: string; ringkas: string; status: "selesai" | "terhenti" | "gagal";
  /** the invocation the current report was built from */
  dipakai: boolean; biaya?: BiayaModel | null;
  /** an invocation stopped before it printed its cost: the last cost and calls its progress lines show */
  usd_log?: number; panggilan_log?: number };
export const TAHAP = ["fitur", "zona", "iot", "aturan", "swarm", "laporan", "narasi"] as const;
export type KodeTahap = (typeof TAHAP)[number];
export type Tahap = { kode: KodeTahap; status: "selesai" | "berjalan" | "gagal" | "dilewati" | "belum" | "tidak_tercatat";
  mulai: string | null; selesai: string | null; detik: number | null; hasil: [string, number | string][]; ai: boolean;
  biaya: BiayaModel | null; catatan: string[]; percobaan: Percobaan[]; progres?: Titik[] };
export type StatusRun = { status?: string; mode?: string; mulai?: string; diperbarui?: string; usd_terpakai?: number | null; usd_batas?: number | null;
  tahap?: string | null; persen?: number; galat?: string | null; iot_sumber?: string | null; tahap_selesai?: string[] };
export type Jejak = { run: string; runner: boolean; sumber: string[]; status: StatusRun | null; tahap: Tahap[]; catatan: string[];
  /** the report's own cost (runs.json), for the step cards */
  laporan_usd: number | null };
export type Kolom = { spesialis: number; hakim: number; penulis: number };
export type BiayaRun = {
  run: string; kc: number | null; sumber: string[];
  laporan: { usd: number | null; swarm: BiayaModel | null; narasi: BiayaModel | null };
  batas: { usd: number | null; terpakai: number | null } | null;
  buku: { langkah: string; waktu: string; biaya: BiayaModel; dipakai: boolean }[] | null;
  terhenti: { langkah: string; mulai: string; usd: number; panggilan: number | null; batch: string }[];
  klaim: { dianalisis: number | null; dibaca: number | null; antrean: number | null };
  batch: { total: number; dari_simpanan: number } | null;
  /** USD per million tokens the cost recorder used, and whether tokens x price give the recorded totals back */
  harga: { masuk: number; keluar: number; cocok: boolean } | null;
  /** the agents' answers per time step from the answer cache: every finished swarm batch = 3 specialists + the judge, every writer batch = 1 */
  aktivitas: { mulai: string; langkah: number; kolom: Kolom[]; dari_simpanan: number; penulis_terpisah: boolean } | null;
  progres: { swarm: Titik[]; narasi: Titik[] };
};

type RunRec = { id: string; kc?: number; dibuat?: string; dijalankan?: string; biaya_usd?: number; narasi_exhibit?: number; kalimat_dibuang_cek_angka?: number;
  biaya_swarm?: Record<string, unknown>; biaya_narasi?: Record<string, unknown>; metrik?: { klaim?: number; ragu?: number; v5?: { ditandai?: number } };
  operasional?: { klaim?: number; antrean?: number; dibaca_swarm?: number } };

// ------------------------------------------------------------------------------------------------ small helpers
async function teks(f: string): Promise<string | null> {
  try { return await readFile(f, "utf-8"); } catch { return null; }
}
async function json<T>(f: string): Promise<T | null> {
  const t = await teks(f);
  if (t == null) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}
async function waktuFile(f: string): Promise<{ mtime: Date; size: number } | null> {
  try { const s = await stat(f); return { mtime: s.mtime, size: s.size }; } catch { return null; }
}
const pad = (n: number) => String(n).padStart(2, "0");
/** local wall-clock time as the runner writes it: "YYYY-MM-DD HH:MM:SS" */
const lokal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const keMs = (s: string) => new Date(s.length === 16 ? `${s.replace(" ", "T")}:00` : s.replace(" ", "T")).getTime();
const tambah = (s: string, detik: number) => lokal(new Date(keMs(s) + detik * 1000));
/** whether a process still runs (signal 0 only checks; a process of another user still counts as running) */
function hidup(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
const angka = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function biayaModel(o: Record<string, unknown> | null | undefined): BiayaModel | null {
  if (!o) return null;
  return { usd: angka(o.usd_perkiraan ?? o.usd), panggilan: angka(o.panggilan), token_masuk: angka(o.token_masuk), token_keluar: angka(o.token_keluar),
    cache: o.cache == null ? undefined : angka(o.cache), gagal: o.gagal == null ? undefined : angka(o.gagal), selesai: o.selesai == null ? undefined : angka(o.selesai),
    throttle: o.throttle == null ? undefined : angka(o.throttle), berhenti: typeof o.berhenti === "string" ? o.berhenti : null };
}
const samaBiaya = (a: BiayaModel | null | undefined, b: BiayaModel | null | undefined) =>
  !!a && !!b && a.panggilan === b.panggilan && Math.abs(a.usd - b.usd) < 1e-4 && a.token_masuk === b.token_masuk;

type Blok = { mulai: string; cmd: string; baris: string[]; terakhir: boolean };
/** a stage log: every invocation starts with "===== <time> <command>" (testing/jalan_kc_tema.py jalankan_proses) */
function blokLog(t: string | null): Blok[] {
  const out: Blok[] = [];
  for (const line of (t ?? "").split(/\r?\n/)) {
    const m = /^===== (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (.*)$/.exec(line);
    if (m) { out.push({ mulai: m[1], cmd: m[2], baris: [], terakhir: false }); continue; }
    out.at(-1)?.baris.push(line);
  }
  if (out.length) out[out.length - 1].terakhir = true;
  return out;
}
const MENIT = /^\[\s*([\d.]+) min\]/;
function menitAkhir(baris: string[]): number | null {
  for (let i = baris.length - 1; i >= 0; i--) { const m = MENIT.exec(baris[i]); if (m) return parseFloat(m[1]); }
  return null;
}
/** the "biaya {...} | ..." line a model invocation ends with (testing/swarm_v5_adk.py) */
function barisBiaya(baris: string[]): { b: BiayaModel; ekor: string } | null {
  for (const s of baris) {
    if (!s.startsWith("biaya {")) continue;
    const i = s.indexOf(" | ");
    try { return { b: biayaModel(JSON.parse(s.slice(6, i < 0 ? undefined : i))) as BiayaModel, ekor: i < 0 ? "" : s.slice(i + 3) }; } catch { /* a cut line */ }
  }
  return null;
}
const PROG_SWARM = /^\[\s*([\d.]+) min\] (\d+)\/(\d+) batch · \$([\d.]+) · (\d+) panggilan · cache (\d+) · gagal (\d+)/;
const PROG_NARASI = /^\[\s*([\d.]+) min\] narasi (\d+)\/(\d+) batch · \$([\d.]+) · cache (\d+) · gagal (\d+)/;
function progres(baris: string[], narasi: boolean): Titik[] {
  const out: Titik[] = [];
  for (const s of baris) {
    const m = (narasi ? PROG_NARASI : PROG_SWARM).exec(s);
    if (!m) continue;
    out.push(narasi
      ? { menit: +m[1], batch: +m[2], dari: +m[3], usd: +m[4], panggilan: null, cache: +m[5], gagal: +m[6] }
      : { menit: +m[1], batch: +m[2], dari: +m[3], usd: +m[4], panggilan: +m[5], cache: +m[6], gagal: +m[7] });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the shared reads
type Bahan = { run: string; dir: string; kerja: string; ada: boolean; status: (StatusRun & Record<string, unknown>) | null; rec: RunRec | null;
  jalan: string | null; sumber: string[] };
async function bahan(DIR: string, run: string): Promise<Bahan> {
  const dir = path.join(KC_TEMA, run), kerja = path.join(dir, "swarm_v5");
  const ada = !!(await waktuFile(dir));
  const status = (await json<StatusRun & Record<string, unknown>>(path.join(dir, "status.json"))) ?? (await json<StatusRun & Record<string, unknown>>(path.join(DIR, run, "status.json")));
  const runs = await json<{ runs: RunRec[] }>(path.join(DIR, "runs.json"));
  const rec = runs?.runs.find((r) => r.id === run) ?? null;
  const jalan = await teks(path.join(DIR, "_jalan", `${run}.log`));
  const sumber = [rec ? "daftar run (runs.json)" : "", status ? "status runner" : "", ada ? "log tahap runner" : "", jalan ? "log peluncur aplikasi" : ""].filter(Boolean);
  return { run, dir, kerja, ada, status, rec, jalan, sumber };
}

// ------------------------------------------------------------------------------------------------ the steps
async function tahapFitur(b: Bahan): Promise<Tahap> {
  const t: Tahap = { kode: "fitur", status: "belum", mulai: null, selesai: null, detik: null, hasil: [], ai: false, biaya: null, catatan: [], percobaan: [] };
  let files: string[] = [];
  try { files = (await readdir(b.dir)).filter((f) => /^log_\d\d\.txt$/.test(f)).sort(); } catch { /* no folder */ }
  let klaim = 0, rekam = 0, rute = 0, awal = Infinity, akhir = -Infinity;
  for (const f of files) {
    const p = path.join(b.dir, f), isi = await teks(p), w = await waktuFile(p);
    if (!isi || !w) continue;
    const baris = isi.split(/\r?\n/);
    const m = baris.map((s) => /chunk (\d+): claims (\d+), fraud \d+, replica (\d+), records (\d+), RME route (\d+)/.exec(s)).find(Boolean);
    const mnt = menitAkhir(baris);
    const detik = mnt != null ? Math.round(mnt * 60) : null;
    const selesai = w.mtime.getTime(), mulai = selesai - (detik ?? 0) * 1000;
    awal = Math.min(awal, mulai); akhir = Math.max(akhir, selesai);
    if (m) { klaim += +m[2]; rekam += +m[4]; rute += +m[5]; }
    t.percobaan.push({ mulai: lokal(new Date(mulai)), detik, jenis: m ? `ulangan ${m[3]}` : `bagian ${f.slice(4, 6)}`, status: m ? "selesai" : "terhenti", dipakai: !!m,
      ringkas: m ? `${(+m[2]).toLocaleString("id-ID")} klaim · ${(+m[4]).toLocaleString("id-ID")} dengan rekam medis` : "belum selesai (sedang berjalan, atau gagal)" });
  }
  if (!t.percobaan.length) return t;
  const ok = t.percobaan.filter((x) => x.dipakai).length;
  t.status = ok === t.percobaan.length ? "selesai" : "gagal";
  t.mulai = lokal(new Date(awal)); t.selesai = lokal(new Date(akhir)); t.detik = Math.round((akhir - awal) / 1000);
  t.hasil = [["Ulangan data setahun (replika)", ok], ["Klaim dibaca mesin aturan", klaim], ["Klaim dengan rekam medis", rekam], ["Klaim dirutekan temuan rekam medis", rute]];
  t.catatan.push("Waktu tiap ulangan dari log bagiannya (selesai = waktu file log, lama = menit terakhir di log).");
  return t;
}

async function tahapZona(b: Bahan): Promise<Tahap> {
  const t: Tahap = { kode: "zona", status: "belum", mulai: null, selesai: null, detik: null, hasil: [], ai: false, biaya: null, catatan: [], percobaan: [] };
  const bl = blokLog(await teks(path.join(b.dir, "log_zona.txt")));
  let pakai: { blok: Blok; d: Record<string, number> } | null = null;
  for (const x of bl) {
    const j = x.baris.find((s) => s.startsWith("{"));
    let d: Record<string, number> | null = null;
    try { d = j ? JSON.parse(j) : null; } catch { d = null; }
    const mnt = menitAkhir(x.baris);
    t.percobaan.push({ mulai: x.mulai, detik: mnt != null ? Math.round(mnt * 60) : null, jenis: "zona model ML", status: d ? "selesai" : "gagal", dipakai: false,
      ringkas: d ? `${angka(d.klaim).toLocaleString("id-ID")} klaim · ${angka(d.tahan).toLocaleString("id-ID")} ditahan · ${angka(d.ragu).toLocaleString("id-ID")} ragu` : "tanpa hasil" });
    if (d) pakai = { blok: x, d };
  }
  if (!pakai) return t;
  const p = t.percobaan[bl.indexOf(pakai.blok)];
  p.dipakai = true;
  t.status = "selesai"; t.mulai = p.mulai; t.detik = p.detik; t.selesai = p.detik != null ? tambah(p.mulai, p.detik) : null;
  t.hasil = [["Klaim dinilai model ML", angka(pakai.d.klaim)], ["Ditahan langsung (skor sangat tinggi)", angka(pakai.d.tahan)], ["Ragu (calon dibaca tim agen AI)", angka(pakai.d.ragu)]];
  const pk = await json<{ pilihan?: Record<string, number> }>(path.join(b.dir, "perkiraan.json"));
  if (pk?.pilihan) t.hasil.push(["Klaim di tema terpilih", angka(pk.pilihan.klaim)], ["Tema terpilih: ditahan", angka(pk.pilihan.tahan)], ["Tema terpilih: ragu", angka(pk.pilihan.ragu)]);
  return t;
}

async function tahapIot(b: Bahan): Promise<Tahap> {
  const t: Tahap = { kode: "iot", status: "belum", mulai: null, selesai: null, detik: null, hasil: [], ai: false, biaya: null, catatan: [], percobaan: [] };
  const bl = blokLog(await teks(path.join(b.dir, "log_iot.txt")));
  type Gen = { blok: Blok; d: Record<string, number> };
  let gen: Gen | null = null, genCek: Gen | null = null, cek: { blok: Blok; m: RegExpExecArray } | null = null;
  for (const x of bl) {
    if (/ generate /.test(x.cmd)) {
      const s = x.baris.find((y) => y.startsWith("iot generate"));
      let d: Record<string, number> | null = null;
      try { d = s ? JSON.parse(s.slice(s.indexOf("{"))) : null; } catch { d = null; }
      t.percobaan.push({ mulai: x.mulai, detik: d ? Math.round(angka(d.detik)) : null, jenis: "buat data alat", status: d ? "selesai" : "gagal", dipakai: false,
        ringkas: d ? `${angka(d.rs)} RS · ${angka(d.alat)} alat · ${angka(d.pembacaan).toLocaleString("id-ID")} pembacaan` : "tanpa hasil" });
      if (d) gen = { blok: x, d };
    } else if (/ periksa /.test(x.cmd)) {
      const s = x.baris.find((y) => y.startsWith("iot periksa")) ?? "";
      const m = /(\d+) klaim beralat · sesuai (\d+) · tidak sesuai (\d+) · tanpa bukti (\d+) · selisih (Rp [^·]+?) · (\d+) peringatan · (\d+) s/.exec(s);
      t.percobaan.push({ mulai: x.mulai, detik: m ? +m[7] : null, jenis: "cocokkan alat dengan klaim", status: m ? "selesai" : "gagal", dipakai: false,
        ringkas: m ? `${(+m[1]).toLocaleString("id-ID")} klaim beralat · ${m[3]} tidak sesuai` : "tanpa hasil" });
      if (m) { cek = { blok: x, m }; genCek = gen; }
    }
  }
  if (!cek) {
    if (!b.status?.iot_sumber && b.ada) { t.status = "dilewati"; t.catatan.push("Run ini tanpa data pemakaian alat (IoT): tahap dilewati."); }
    return t;
  }
  const iCek = bl.indexOf(cek.blok);
  t.percobaan[iCek].dipakai = true;
  if (genCek) t.percobaan[bl.indexOf(genCek.blok)].dipakai = true;
  t.status = "selesai";
  t.mulai = genCek?.blok.mulai ?? cek.blok.mulai;
  t.selesai = tambah(cek.blok.mulai, +cek.m[7]);
  t.detik = Math.round((keMs(t.selesai) - keMs(t.mulai)) / 1000);
  if (genCek) t.hasil.push(["RS dengan alat terpantau", angka(genCek.d.rs)], ["Alat", angka(genCek.d.alat)], ["Sesi pemakaian", angka(genCek.d.sesi)], ["Pembacaan sensor", angka(genCek.d.pembacaan)]);
  t.hasil.push(["Klaim dengan alat", +cek.m[1]], ["Cocok dengan tagihan", +cek.m[2]], ["Tidak cocok", +cek.m[3]], ["Tanpa bukti alat", +cek.m[4]], ["Selisih tagihan", cek.m[5].trim()]);
  if (b.status?.iot_sumber === "sintetis") t.catatan.push("Data pemakaian alat sintetis (benih tetap), sesuai format masukan IoT.");
  return t;
}

/** a stage line in the app launcher's log: the minutes the step took, from the line before it */
function menitJalan(jalan: string | null, awalan: string): number | null {
  if (!jalan) return null;
  const baris = jalan.split(/\r?\n/).filter((s) => MENIT.test(s));
  const milik = (s: string) => s.replace(MENIT, "").trimStart().startsWith(awalan);
  const i = baris.findLastIndex(milik);
  let j = i;
  while (j > 0 && milik(baris[j - 1])) j--;  // the step's first line; the one before it ends the previous step
  if (j <= 0) return null;
  return Math.max(0, parseFloat(MENIT.exec(baris[i])![1]) - parseFloat(MENIT.exec(baris[j - 1])![1]));
}

async function tahapAturan(b: Bahan): Promise<Tahap> {
  const t: Tahap = { kode: "aturan", status: "belum", mulai: null, selesai: null, detik: null, hasil: [], ai: false, biaya: null, catatan: [], percobaan: [] };
  const f = path.join(b.kerja, `jalur_${b.run}.json`);
  const J = await json<{ dibuat?: string; ringkas?: Record<string, unknown> }>(f);
  if (!J?.ringkas) return t;
  const r = J.ringkas as Record<string, number> & { temuan?: Record<string, number> };
  const w = await waktuFile(f);
  t.status = "selesai";
  t.selesai = w ? lokal(w.mtime) : J.dibuat ?? null;
  const mnt = menitJalan(b.jalan, "aturan:");
  if (mnt != null && t.selesai) { t.detik = Math.round(mnt * 60); t.mulai = tambah(t.selesai, -t.detik); }
  else t.catatan.push("Lama tahap ini tidak tercatat: tahap aturan hanya menulis ke log peluncur, yang tidak ada untuk run ini. Waktu = saat berkas temuannya ditulis.");
  t.hasil = [["Klaim tema terpilih", angka(r.klaim_dipilih)], ["Ragu menurut model ML", angka(r.ragu_ml)], ["Ditambahkan temuan aturan (dari lolos)", angka(r.rute_aturan)],
    ["Dikirim ke tim agen AI", angka(r.dibaca_swarm)], ["Jalur bukti aturan (temuan kuat terverifikasi)", angka(r.jalur_bukti_aturan)],
    ["Temuan rekam medis", angka(r.temuan?.rme)], ["Temuan alat (IoT)", angka(r.temuan?.iot)], ["Temuan terverifikasi", angka(r.temuan?.terverifikasi)]];
  t.percobaan.push({ mulai: t.mulai ?? t.selesai ?? "", detik: t.detik, jenis: "temuan aturan ke berkas agen", status: "selesai", dipakai: true,
    ringkas: `${angka(r.dibaca_swarm).toLocaleString("id-ID")} berkas · ${angka(r.temuan?.rme) + angka(r.temuan?.iot)} temuan` });
  return t;
}

type Main = { blok: Blok; biaya: BiayaModel | null; titik: Titik[]; klaim: number | null; batch: number | null; berhenti: string | null; detik: number | null };
function bacaSwarm(bl: Blok[]): { smoke: Blok[]; main: Main[]; ekspor: Blok[]; kering: Blok[] } {
  const out = { smoke: [] as Blok[], main: [] as Main[], ekspor: [] as Blok[], kering: [] as Blok[] };
  for (const x of bl) {
    if (/ ekspor /.test(x.cmd)) out.ekspor.push(x);
    else if (/_swarm_palsu/.test(x.cmd)) out.kering.push(x);
    else if (/ jalankan /.test(x.cmd) && /--maks /.test(x.cmd)) out.smoke.push(x);
    else if (/ jalankan /.test(x.cmd)) {
      const h = x.baris.map((s) => /^(\d+) klaim · (\d+) batch · batas \$/.exec(s)).find(Boolean);
      const titik = progres(x.baris, false), bb = barisBiaya(x.baris);
      const berhenti = x.baris.find((s) => s.startsWith("BERHENTI: "))?.slice(10) ?? bb?.b.berhenti ?? null;
      out.main.push({ blok: x, biaya: bb?.b ?? null, titik, klaim: h ? +h[1] : null, batch: h ? +h[2] : null, berhenti,
        detik: titik.length ? Math.round(titik[titik.length - 1].menit * 60) : null });
    }
  }
  return out;
}

async function tahapSwarm(b: Bahan): Promise<Tahap & { _main?: Main }> {
  const t: Tahap & { _main?: Main } = { kode: "swarm", status: "belum", mulai: null, selesai: null, detik: null, hasil: [], ai: true, biaya: null, catatan: [], percobaan: [] };
  const bl = blokLog(await teks(path.join(b.dir, "log_swarm.txt")));
  const s = bacaSwarm(bl);
  const target = biayaModel(b.rec?.biaya_swarm);
  const pakai = s.main.find((m) => samaBiaya(m.biaya, target)) ?? s.main.filter((m) => m.biaya).at(-1) ?? null;
  for (const x of bl) {
    if (s.smoke.includes(x)) {
      const bb = barisBiaya(x.baris), mnt = menitAkhir(x.baris);
      t.percobaan.push({ mulai: x.mulai, detik: mnt != null ? Math.round(mnt * 60) : null, jenis: "uji coba 1 batch", status: bb ? "selesai" : "gagal", dipakai: false, biaya: bb?.b ?? null,
        ringkas: bb ? `${bb.b.panggilan} panggilan model` : "tanpa hasil" });
    } else if (s.ekspor.includes(x)) {
      const m = x.baris.map((y) => /^ekspor (\d+)\/(\d+) klaim/.exec(y)).find(Boolean);
      t.percobaan.push({ mulai: x.mulai, detik: null, jenis: "ambil jawaban agen", status: m ? "selesai" : "gagal", dipakai: false,
        ringkas: m ? `${(+m[1]).toLocaleString("id-ID")} dari ${(+m[2]).toLocaleString("id-ID")} klaim, dari simpanan jawaban` : "tanpa hasil" });
    } else if (s.kering.includes(x)) {
      t.percobaan.push({ mulai: x.mulai, detik: null, jenis: "uji kering (tanpa model)", status: "selesai", dipakai: false, ringkas: "jawaban palsu, tanpa biaya" });
    } else {
      const m = s.main.find((y) => y.blok === x);
      if (!m) continue;
      const last = m.titik.at(-1);
      const p: Percobaan = { mulai: x.mulai, detik: m.detik, jenis: "baca klaim ragu", status: m.biaya && !m.berhenti ? "selesai" : "terhenti", dipakai: m === pakai, biaya: m.biaya,
        ringkas: `${m.klaim?.toLocaleString("id-ID") ?? "?"} klaim · ${m.biaya?.selesai ?? last?.batch ?? 0}/${m.batch ?? last?.dari ?? "?"} batch${m.biaya?.cache ? ` · ${m.biaya.cache} dari simpanan` : ""}${m.berhenti ? ` · berhenti: ${m.berhenti}` : ""}` };
      if (!m.biaya && last) { p.usd_log = last.usd; p.panggilan_log = last.panggilan ?? undefined; }
      t.percobaan.push(p);
    }
  }
  // the export right after the invocation used is part of it
  const ex = pakai ? s.ekspor.find((x) => keMs(x.mulai) >= keMs(pakai.blok.mulai)) : undefined;
  if (ex) { const p = t.percobaan.find((q) => q.mulai === ex.mulai && q.jenis === "ambil jawaban agen"); if (p) p.dipakai = true; }
  const gb = (b.status?.gerbang as Record<string, number> | undefined) ?? (await json<{ ringkas?: Record<string, number> }>(path.join(b.kerja, `gerbang_${b.run}.json`)))?.ringkas;
  if (!pakai) {
    if (s.kering.length) { t.status = "selesai"; t.ai = false; t.catatan.push("Uji kering: tim agen dijalankan dengan model palsu, tanpa biaya."); }
    return t;
  }
  t._main = pakai;
  const bm = pakai.biaya!;
  t.status = "selesai"; t.mulai = pakai.blok.mulai; t.detik = pakai.detik; t.selesai = pakai.detik != null ? tambah(pakai.blok.mulai, pakai.detik) : null;
  t.biaya = bm; t.progres = pakai.titik;
  t.hasil = [["Klaim dibaca tim agen AI", pakai.klaim ?? 0], ["Batch (8 klaim per batch)", pakai.batch ?? 0], ["Batch dari simpanan (tanpa panggilan baru)", bm.cache ?? 0],
    ["Panggilan model", bm.panggilan], ["Batch gagal lalu diulang", bm.gagal ?? 0], ["Menunggu kuota layanan model", bm.throttle ?? 0]];
  if (gb) t.hasil.push(["Perlu diperiksa verifikator", angka(gb.periksa)], ["Perlu diperiksa · jalur model ML", angka(gb.periksa_jalur_ml)], ["Perlu diperiksa · jalur bukti aturan", angka(gb.periksa_jalur_aturan)],
    ["Dibersihkan (bukti belum cukup)", angka(gb.dibersihkan)], ["Temuan aturan diterima hakim", angka(gb.hakim_terima)], ["Temuan aturan ditolak hakim", angka(gb.hakim_tolak)]);
  if (bm.cache) t.catatan.push(`${bm.cache} batch dijawab dari simpanan jawaban percobaan sebelumnya, tanpa panggilan model baru.`);
  const lain = s.main.filter((m) => m !== pakai).length;
  if (lain) t.catatan.push(`Tahap ini dijalankan ${s.main.length} kali; laporan memakai percobaan ${pakai.blok.mulai.slice(0, 16)}. Riwayat lengkap di bawah.`);
  return t;
}

async function tahapLaporan(b: Bahan): Promise<Tahap> {
  const t: Tahap = { kode: "laporan", status: "belum", mulai: null, selesai: null, detik: null, hasil: [], ai: false, biaya: null, catatan: [], percobaan: [] };
  const semua: { blok: Blok; file: string; jenis: string }[] = [];
  for (const [f, jenis] of [["log_laporan.txt", "tulis laporan"], ["log_laporan_narasi.txt", "tulis ulang dengan narasi"]] as const) {
    for (const x of blokLog(await teks(path.join(b.dir, f)))) semua.push({ blok: x, file: f, jenis });
  }
  semua.sort((x, y) => keMs(x.blok.mulai) - keMs(y.blok.mulai));
  let pakai: { p: Percobaan; m: RegExpExecArray | null; g: RegExpExecArray | null } | null = null;
  for (const { blok: x, file, jenis } of semua) {
    const m = x.baris.map((s) => /^(\d+) KC -> .*?; tugas narasi (\d+); narasi dipakai (\d+), kalimat dibuang (\d+)/.exec(s)).find(Boolean) ?? null;
    const g = x.baris.map((s) => /(\d+) case files, (\d+) not matching; (\d+) s/.exec(s)).find(Boolean) ?? null;
    let detik: number | null = null;
    if (x.terakhir) { const w = await waktuFile(path.join(b.dir, file)); if (w) detik = Math.max(0, Math.round((w.mtime.getTime() - keMs(x.mulai)) / 1000)); }
    const p: Percobaan = { mulai: x.mulai, detik, jenis, status: m ? "selesai" : "gagal", dipakai: false,
      ringkas: m ? `${g ? `${(+g[1]).toLocaleString("id-ID")} berkas klaim · ` : ""}narasi dipakai ${m[3]}, kalimat dibuang ${m[4]}` : "tanpa hasil" };
    t.percobaan.push(p);
    if (m) pakai = { p, m, g };
  }
  if (!pakai) return t;
  pakai.p.dipakai = true;
  t.status = "selesai"; t.mulai = pakai.p.mulai; t.detik = pakai.p.detik; t.selesai = pakai.p.detik != null ? tambah(pakai.p.mulai, pakai.p.detik) : null;
  if (b.rec?.operasional?.antrean != null) t.hasil.push(["Klaim di antrean verifikator", angka(b.rec.operasional.antrean)]);
  if (pakai.g) t.hasil.push(["Berkas klaim dengan jaringan klaim", +pakai.g[1]]);
  t.hasil.push(["Exhibit untuk agen penulis", +pakai.m![2]], ["Narasi dipakai", +pakai.m![3]], ["Kalimat dibuang kode (angka tak cocok)", +pakai.m![4]]);
  if (t.detik == null) t.catatan.push("Lama penulisan tidak tercatat.");
  else t.catatan.push("Lama = dari mulai sampai baris terakhir log ditulis.");
  if (t.percobaan.length > 1) t.catatan.push(`Laporan ditulis ${t.percobaan.length} kali; yang tampil adalah tulisan ${pakai.p.mulai.slice(0, 16)}.`);
  return t;
}

async function tahapNarasi(b: Bahan): Promise<Tahap & { _blok?: Blok }> {
  const t: Tahap & { _blok?: Blok } = { kode: "narasi", status: "belum", mulai: null, selesai: null, detik: null, hasil: [], ai: true, biaya: null, catatan: [], percobaan: [] };
  if (b.status?.mode === "uji_kering") { t.status = "dilewati"; t.ai = false; t.catatan.push("Uji kering: agen penulis tidak dipanggil."); return t; }
  const bl = blokLog(await teks(path.join(b.dir, "log_narasi.txt")));
  const target = biayaModel(b.rec?.biaya_narasi);
  const isi = bl.map((x) => {
    const bb = barisBiaya(x.baris), titik = progres(x.baris, true);
    const n = bb ? /narasi (\d+) exhibit/.exec(bb.ekor) : null;
    return { x, bb, titik, n: n ? +n[1] : null, detik: titik.length ? Math.round(titik[titik.length - 1].menit * 60) : null };
  });
  const pakai = isi.find((y) => samaBiaya(y.bb?.b, target)) ?? isi.filter((y) => y.bb).at(-1) ?? null;
  for (const y of isi) {
    const last = y.titik.at(-1);
    const p: Percobaan = { mulai: y.x.mulai, detik: y.detik, jenis: "tulis narasi exhibit", status: y.bb ? "selesai" : "terhenti", dipakai: y === pakai, biaya: y.bb?.b ?? null,
      ringkas: y.bb ? `${y.n ?? "?"} exhibit · ${y.bb.b.panggilan} panggilan` : "tanpa hasil" };
    if (!y.bb && last) p.usd_log = last.usd;
    t.percobaan.push(p);
  }
  if (!pakai?.bb) return t;
  t._blok = pakai.x;
  t.status = "selesai"; t.mulai = pakai.x.mulai; t.detik = pakai.detik; t.selesai = pakai.detik != null ? tambah(pakai.x.mulai, pakai.detik) : null;
  t.biaya = pakai.bb.b; t.progres = pakai.titik;
  t.hasil = [["Exhibit dinarasikan", pakai.n ?? 0], ["Batch", pakai.titik.at(-1)?.dari ?? 0], ["Panggilan model", pakai.bb.b.panggilan], ["Gagal", pakai.bb.b.gagal ?? 0]];
  return t;
}

/** A run made before the branch runner (batch generator 3: uji_gen2.py + v5.py + laporan_cabang.py): only runs.json is kept. */
function tanpaRunner(b: Bahan): Tahap[] {
  const r = b.rec;
  const kosong = (kode: KodeTahap, ai = false): Tahap => ({ kode, status: "tidak_tercatat", mulai: null, selesai: null, detik: null, hasil: [], ai, biaya: null, catatan: [], percobaan: [] });
  const t = Object.fromEntries(TAHAP.map((k) => [k, kosong(k, k === "swarm" || k === "narasi")])) as Record<KodeTahap, Tahap>;
  if (!r) return TAHAP.map((k) => t[k]);
  if (r.metrik?.klaim != null) t.fitur.hasil.push(["Klaim dianalisis", angka(r.metrik.klaim)]);
  if (r.metrik?.ragu != null) t.zona.hasil.push(["Ragu (dibaca tim agen AI)", angka(r.metrik.ragu)]);
  const sw = biayaModel(r.biaya_swarm);
  if (sw) {
    t.swarm = { ...t.swarm, status: "selesai", selesai: r.dijalankan ?? null, biaya: sw, catatan: ["Waktu = saat hasil tim agen ditulis (runs.json); lama tidak tercatat."],
      hasil: [["Klaim dibaca tim agen AI", angka(r.operasional?.dibaca_swarm ?? r.metrik?.ragu)], ["Batch selesai", sw.selesai ?? 0], ["Panggilan model", sw.panggilan], ["Batch gagal", sw.gagal ?? 0]] };
  }
  t.laporan = { ...t.laporan, status: "selesai", selesai: r.dibuat ?? null, catatan: ["Waktu = saat laporan dibuat (runs.json); lama tidak tercatat."],
    hasil: [...(r.operasional?.antrean != null ? [["Klaim di antrean verifikator", angka(r.operasional.antrean)] as [string, number]] : []),
      ...(r.kalimat_dibuang_cek_angka != null ? [["Kalimat dibuang kode (angka tak cocok)", angka(r.kalimat_dibuang_cek_angka)] as [string, number]] : [])] };
  const na = biayaModel(r.biaya_narasi);
  if (na) t.narasi = { ...t.narasi, status: "selesai", biaya: na, hasil: [["Exhibit dinarasikan", angka(r.narasi_exhibit)], ["Panggilan model", na.panggilan]], catatan: ["Waktu tidak tercatat."] };
  return TAHAP.map((k) => t[k]);
}

/** The run's steps for the "Jejak kerja" tab. */
export async function bangunJejak(DIR: string, run: string): Promise<Jejak> {
  return (await jejakDari(await bahan(DIR, run))).jejak;
}

/** the steps, and (for the cost) the swarm and writer invocations the report used; those never leave the server */
async function jejakDari(b: Bahan): Promise<{ jejak: Jejak; swarm?: Main; narasi?: Blok }> {
  const run = b.run;
  const st: StatusRun | null = b.status ? { status: b.status.status, mode: b.status.mode, mulai: b.status.mulai, diperbarui: b.status.diperbarui,
    usd_terpakai: b.status.usd_terpakai ?? null, usd_batas: b.status.usd_batas ?? null, tahap: b.status.tahap ?? null, persen: b.status.persen,
    galat: b.status.galat ?? null, iot_sumber: b.status.iot_sumber ?? null, tahap_selesai: b.status.tahap_selesai } : null;
  const catatan: string[] = [];
  if (!b.ada) {
    catatan.push(b.rec ? "Run ini dibuat sebelum runner audit KC (alur batch generator-3): jejak per tahap tidak disimpan. Yang tampil hanya yang tercatat di daftar run."
      : "Tidak ada catatan runner untuk run ini.");
    return { jejak: { run, runner: false, sumber: b.sumber, status: st, tahap: tanpaRunner(b), catatan, laporan_usd: b.rec?.biaya_usd ?? null } };
  }
  const [fitur, zona, iot, aturan, swarm, laporan, narasi] = await Promise.all([tahapFitur(b), tahapZona(b), tahapIot(b), tahapAturan(b), tahapSwarm(b), tahapLaporan(b), tahapNarasi(b)]);
  const tahap: Tahap[] = [fitur, zona, iot, aturan, swarm, laporan, narasi];
  // a runner that says "berjalan" but whose process is gone was stopped without writing its status (cancelled, killed)
  if (st?.status === "berjalan" && typeof b.status?.pid === "number" && !hidup(b.status.pid)) {
    st.status = "terhenti";
    catatan.push("Runner tidak lagi berjalan: prosesnya berhenti tanpa memperbarui status (dibatalkan atau dihentikan). Tahap terakhirnya tidak selesai.");
  }
  // the runner's own state: the step it is on, or the one it stopped at
  if (st?.tahap && (TAHAP as readonly string[]).includes(st.tahap)) {
    const x = tahap.find((y) => y.kode === st.tahap)!;
    if (st.status === "berjalan") x.status = "berjalan";
    else if (st.status === "terhenti") { x.status = "gagal"; x.catatan.unshift("Terhenti sebelum tahap ini selesai."); }
    else if (st.galat) { x.status = "gagal"; x.catatan.unshift(`Berhenti: ${String(st.galat).slice(0, 200)}`); }
  }
  const { _main, ...sw } = swarm as Tahap & { _main?: Main };
  const { _blok, ...na } = narasi as Tahap & { _blok?: Blok };
  tahap[4] = sw; tahap[6] = na;
  if (b.status?.mode === "uji_kering") catatan.push("Uji kering: tanpa panggilan model, tanpa biaya.");
  return { jejak: { run, runner: true, sumber: b.sumber, status: st, tahap, catatan, laporan_usd: b.rec?.biaya_usd ?? null }, swarm: _main, narasi: _blok };
}

// ------------------------------------------------------------------------------------------------ the cost
/** the price list the cost recorder used (testing/swarm_v5_adk.py HARGA, USD per million tokens in / out) */
async function hargaTercatat(): Promise<{ masuk: number; keluar: number } | null> {
  const t = await teks(SKRIP_SWARM);
  const m = t ? /^HARGA = \(([\d.]+), ([\d.]+)\)/m.exec(t) : null;
  return m ? { masuk: +m[1], keluar: +m[2] } : null;
}

type IsiCache = { swarm: { waktu: number; spesialis: number; hakim: number }[]; narasi: number[] };
const simpanCache = new Map<string, { kunci: string; isi: IsiCache }>();
/** the answer cache's finished batches with their time (only the set's own swarm batches and the writer's), read once per file version */
async function bacaCache(f: string, run: string): Promise<IsiCache | null> {
  const w = await waktuFile(f);
  if (!w || w.size > 400 * 2 ** 20) return null;
  const kunci = `${w.mtime.getTime()}|${w.size}`;
  const lama = simpanCache.get(f + "|" + run);
  if (lama?.kunci === kunci) return lama.isi;
  const t = await teks(f);
  if (t == null) return null;
  const isi: IsiCache = { swarm: [], narasi: [] };
  for (const line of t.split("\n")) {
    const k = /^\{"kunci": "([^"]*)"/.exec(line), wk = /"waktu": "([^"]+)"\}\s*$/.exec(line);
    if (!k || !wk) continue;
    const ms = keMs(wk[1]);
    if (k[1].startsWith("narasi|")) { isi.narasi.push(ms); continue; }
    if (!k[1].startsWith(`${run}|`)) continue;
    const sp = ["koding", "tagihan", "episode"].filter((a) => line.includes(`"${a}": {"K`)).length;
    isi.swarm.push({ waktu: ms, spesialis: sp, hakim: line.includes(`"hakim": {"K`) ? 1 : 0 });
  }
  simpanCache.set(f + "|" + run, { kunci, isi });
  return isi;
}

export async function bangunBiaya(DIR: string, run: string): Promise<BiayaRun> {
  const b = await bahan(DIR, run);
  const { jejak: j, swarm: pakaiSwarm } = await jejakDari(b);
  const r = b.rec;
  const sw = biayaModel(r?.biaya_swarm), na = biayaModel(r?.biaya_narasi);
  const out: BiayaRun = {
    run, kc: r?.kc ?? null, sumber: [...b.sumber], laporan: { usd: r?.biaya_usd ?? null, swarm: sw, narasi: na },
    batas: b.status ? { usd: b.status.usd_batas ?? null, terpakai: b.status.usd_terpakai ?? null } : null,
    buku: null, terhenti: [],
    klaim: { dianalisis: r?.operasional?.klaim ?? r?.metrik?.klaim ?? null, dibaca: r?.operasional?.dibaca_swarm ?? r?.metrik?.ragu ?? null, antrean: r?.operasional?.antrean ?? null },
    batch: null, harga: null, aktivitas: null,
    progres: { swarm: j.tahap.find((x) => x.kode === "swarm")?.progres ?? [], narasi: j.tahap.find((x) => x.kode === "narasi")?.progres ?? [] },
  };
  const g = (b.status?.gerbang as Record<string, number> | undefined);
  if (g?.dibaca) out.klaim.dibaca = angka(g.dibaca);
  if (pakaiSwarm?.batch) out.batch = { total: pakaiSwarm.batch, dari_simpanan: sw?.cache ?? 0 };
  // the cost book (every smoke, swarm and writer invocation of the set) and the invocations that stopped before booking
  const buku = await json<{ langkah: string; waktu: string; usd: number; biaya: Record<string, unknown> }[]>(path.join(b.kerja, "biaya_runner.json"));
  if (buku) {
    out.sumber.push("buku biaya runner");
    let swDipakai = false, naDipakai = false;
    out.buku = buku.map((x) => {
      const bm = biayaModel(x.biaya) ?? { usd: angka(x.usd), panggilan: 0, token_masuk: 0, token_keluar: 0 };
      let dipakai = false;
      if (x.langkah === "swarm" && !swDipakai && samaBiaya(bm, sw)) dipakai = swDipakai = true;
      if (x.langkah === "narasi" && !naDipakai && samaBiaya(bm, na)) dipakai = naDipakai = true;
      return { langkah: x.langkah, waktu: x.waktu, biaya: bm, dipakai };
    });
  }
  for (const t of j.tahap) {
    for (const p of t.percobaan) {
      if (p.status === "terhenti" && !p.biaya && p.usd_log != null && p.usd_log > 0) {
        out.terhenti.push({ langkah: t.kode, mulai: p.mulai, usd: p.usd_log, panggilan: p.panggilan_log ?? null, batch: p.ringkas });
      }
    }
  }
  // tokens x the recorder's price list must give the recorded totals back before a split by token kind is shown
  const h = await hargaTercatat();
  if (h && (sw || na)) {
    const cocok = [sw, na].filter(Boolean).every((x) => Math.abs((x!.token_masuk * h.masuk + x!.token_keluar * h.keluar) / 1e6 - x!.usd) <= Math.max(5e-4, 0.01 * x!.usd));
    out.harga = { ...h, cocok };
  }
  // the agents at work: the answer cache's batch times inside the swarm invocation used (and the writer's, when it followed soon after)
  if (pakaiSwarm && j.tahap[4].mulai && j.tahap[4].detik != null) {
    const isi = await bacaCache(path.join(b.kerja, "cache_adk.jsonl"), run);
    if (isi) {
      out.sumber.push("simpanan jawaban agen");
      const a0 = keMs(j.tahap[4].mulai), a1 = a0 + (j.tahap[4].detik + 30) * 1000;
      const n = j.tahap[6];
      const n0 = n.mulai ? keMs(n.mulai) : NaN, n1 = n0 + ((n.detik ?? 0) + 30) * 1000;
      const ikut = !Number.isNaN(n0) && n0 >= a0 && n0 - a1 <= 30 * 60000;
      const akhir = ikut ? n1 : a1;
      const step = Math.max(60, Math.ceil((akhir - a0) / 1000 / 72 / 60) * 60);
      const kolom: Kolom[] = Array.from({ length: Math.max(1, Math.ceil((akhir - a0) / 1000 / step)) }, () => ({ spesialis: 0, hakim: 0, penulis: 0 }));
      const ke = (ms: number) => kolom[Math.min(kolom.length - 1, Math.floor((ms - a0) / 1000 / step))];
      for (const x of isi.swarm) if (x.waktu >= a0 && x.waktu <= a1) { const k = ke(x.waktu); k.spesialis += x.spesialis; k.hakim += x.hakim; }
      if (ikut) for (const w of isi.narasi) if (w >= n0 && w <= n1) ke(w).penulis += 1;
      out.aktivitas = { mulai: j.tahap[4].mulai, langkah: step, kolom, dari_simpanan: sw?.cache ?? 0, penulis_terpisah: !ikut && !Number.isNaN(n0) };
    }
  }
  return out;
}
