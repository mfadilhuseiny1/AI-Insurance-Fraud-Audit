import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

/*
 * The launcher of a branch audit (AI Agent Swarm Branch, "Mulai audit"; api/swarm-cabang/proyek): the end-to-end runner
 * (dataset -> rule engine -> ML v7 -> agent swarm -> report) as one process, started with an argv array and no shell, so no text
 * of an audit (its label) ever reaches a shell.
 *
 * PELUNCUR_AUDIT is the one thing to fill in when the runner lands: set `aktif: true`, its script and flags in `argv`, and the
 * status/progress file it writes in `status`. Until then "Mulai audit" only shows the command it would run, and the audit stays
 * "siap" (ready to run).
 *   argv placeholders: {audit} (the run/set name, ^[a-z0-9_]{3,40}$, becomes the runs.json id), {label}, {proyek}, {dataset}
 *   ("gen3" or a folder of "Data Sintetis/"), {kc} (a branch id such as sul-7371), {tema} (tema_klaim codes, comma-separated,
 *   e.g. "I,N"), {batas_usd} (the cost cap), {iot} (an IoT input folder in the documented format, docs/IOT_FORMAT_MASUKAN.md,
 *   already checked to lie under an allowed root by the caller). An argument that is only a placeholder and comes out empty (no
 *   branch = every branch, no theme list = every theme, no IoT folder) is dropped together with the --flag before it.
 *   Switch placeholders stand alone and become their flag or nothing: {iot_sintetis} -> --iot-sintetis (synthetic IoT data
 *   generated for the run, fixed seed). The runner refuses both IoT sources at once; the API offers one or the other.
 *   status: relative to the branch data folder (data/aip/cabang); read while the audit runs. Any JSON object; the fields read
 *   are status ("berjalan" | "selesai" | "gagal" | "dibatalkan", or running/succeeded/failed/cancelled), tahap, persen (0-100),
 *   pesan, run (the runs.json id when it differs from {audit}).
 * The interpreter is CABANG_PYTHON, else the project's .venv; the process runs in the project root with PYTHONHASHSEED=0,
 * PYTHONIOENCODING=utf-8 and CABANG_BASIS = the branch data folder; its output goes to <data>/_jalan/<audit>.log.
 */
// the runner: testing/jalan_kc_tema.py (2026-11-15; theme datasets of "Data Sintetis/", stages fitur → zona → swarm → laporan →
// narasi, resumable, the cost cap covering every model call; status at <data>/<set>/status.json; since 2026-11-15 also the IoT
// stage (device usage against the billed hours) and the rule-evidence routing between ML zones and the swarm)
export const PELUNCUR_AUDIT: { aktif: boolean; argv: string[]; status: string } = {
  aktif: true,
  argv: ["testing/jalan_kc_tema.py", "--set", "{audit}", "--label", "{label}", "--dataset", "{dataset}", "--kc", "{kc}", "--tema", "{tema}",
    "--batas-usd", "{batas_usd}", "--iot", "{iot}", "{iot_sintetis}", "--replika-terakhir", "{replika_terakhir}"],
  status: "{audit}/status.json",
};

const ROOT = process.env.BLUESANDAI_ROOT ?? path.join(process.cwd(), "..");
const PYTHON = process.env.CABANG_PYTHON ?? path.join(ROOT, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

export type AuditPeluncur = { audit: string; label: string; proyek: string; dataset: string; kc: string | null; tema: string[] | null; batas_usd: number;
  /** an IoT input folder (absolute, validated by the caller) */ iot?: string | null; /** synthetic IoT data for the run */ iot_sintetis?: boolean;
  /** the data size: only the last N replicas of a theme dataset (null = every replica) */ replika_terakhir?: number | null };

/** Switch placeholders: the flag when on, nothing when off (never takes the argument before it along). */
const SAKLAR: Record<string, string> = { iot_sintetis: "--iot-sintetis" };

/** The runner's arguments for one audit (the interpreter not included). */
export function argvAudit(a: AuditPeluncur): string[] {
  if (a.iot && a.iot_sintetis) throw new Error("Pilih satu sumber data IoT: folder atau sintetis.");
  const nilai: Record<string, string> = {
    audit: a.audit, label: a.label, proyek: a.proyek, dataset: a.dataset, kc: a.kc ?? "", tema: (a.tema ?? []).join(","), batas_usd: String(a.batas_usd),
    iot: a.iot ?? "", replika_terakhir: a.replika_terakhir && a.replika_terakhir > 0 ? String(Math.floor(a.replika_terakhir)) : "",
  };
  const saklar: Record<string, boolean> = { iot_sintetis: !!a.iot_sintetis };
  const out: string[] = [];
  for (const arg of PELUNCUR_AUDIT.argv) {
    const satu = /^\{(\w+)\}$/.exec(arg);
    if (satu && satu[1] in SAKLAR) {
      if (saklar[satu[1]]) out.push(SAKLAR[satu[1]]);
      continue;
    }
    if (satu && satu[1] in nilai && nilai[satu[1]] === "") {
      if (out.length && out[out.length - 1].startsWith("--")) out.pop();
      continue;
    }
    out.push(arg.replace(/\{(\w+)\}/g, (m, k: string) => (k in nilai ? nilai[k] : m)));
  }
  return out;
}

/** The command as a person would type it in the project root (display only: the launcher never runs a string). */
export function tampilPerintah(argv: string[]): string {
  const kutip = (s: string) => (/^[A-Za-z0-9_./:=,@+<>-]+$/.test(s) ? s : JSON.stringify(s));
  const py = process.env.CABANG_PYTHON ? kutip(PYTHON) : ".venv/Scripts/python.exe";
  return ["PYTHONHASHSEED=0", "PYTHONIOENCODING=utf-8", py, ...argv.map(kutip)].join(" ");
}

/** Start the runner, detached; resolves once the process exists (rejects when it cannot start, e.g. no interpreter). */
export async function jalankanAudit(a: AuditPeluncur, dir: string): Promise<{ pid: number; log: string }> {
  const argv = argvAudit(a);
  await mkdir(path.join(dir, "_jalan"), { recursive: true });
  const log = path.join(dir, "_jalan", `${a.audit}.log`);
  const fh = await open(log, "a");
  try {
    const child = spawn(PYTHON, argv, {
      cwd: ROOT, shell: false, detached: true, windowsHide: true, stdio: ["ignore", fh.fd, fh.fd],
      env: { ...process.env, PYTHONHASHSEED: "0", PYTHONIOENCODING: "utf-8", CABANG_BASIS: dir },
    });
    await new Promise<void>((ok, gagal) => { child.once("spawn", () => ok()); child.once("error", gagal); });
    child.unref();
    return { pid: child.pid ?? 0, log };
  } finally {
    await fh.close();
  }
}

/** hidup: false when the status says it runs but its process is gone (killed with the UI, the machine restarted) */
export type StatusPeluncur = { status?: string; tahap?: string; persen?: number; pesan?: string; run?: string; hidup?: boolean;
  progres?: { batch?: number; batch_total?: number } | null };

/** Whether a process exists (signal 0 tests it and sends nothing; EPERM means it exists under another user). */
function prosesAda(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A running audit as the live chart draws it (SwarmCabangBagan `langsung`): the runner's stage, stages done, progress, spend, the
 *  zones and the gate once known, and the newest lines of its log (<dir>/_jalan/<audit>.log, the launcher's output). */
export type LangsungPeluncur = { status: string; tahap: string | null; tahap_daftar: string[]; tahap_selesai: string[]; mulai: string | null;
  usd: number; batas: number; pesan: string | null; iot: boolean; replika: number;
  progres: { replika_selesai?: number; replika_total?: number; batch?: number; batch_total?: number } | null;
  zona: { klaim: number; tahan: number; ragu: number } | null; gerbang: { dibaca?: number; periksa?: number; dibersihkan?: number } | null; log: string[];
  /** what the stages found so far (2026-11-16: the live chart showed 0 signals and 0 IoT mismatches while the runner had them):
   *  the rule engine's signals on the chosen claims (status.sinyal from the zona stage, or _jalan/<audit>.sinyal.json for a run
   *  started before the runner wrote it), the device check (status.iot) and the rule-evidence step (status.aturan) */
  sinyal: { klaim: number; klaim_bersinyal: number; teratas: { kode: string; label: string; n: number }[] } | null;
  iot_hasil: { klaim_dengan_alat: number; sesuai?: number; tidak_sesuai: number; selisih_rp: number; alat?: number; rs_dengan_iot?: number; tanpa_bukti?: number;
    sintetis?: boolean } | null;
  aturan: { rute?: number; bukti?: number; temuan_rme?: number; temuan_iot?: number; terverifikasi?: number } | null;
  /** the report's Indikasi block counted after the aturan stage (laporan_cabang --indikasi-awal), as the report gives it */
  indikasi: Record<string, unknown> | null };

export async function bacaLangsung(dir: string, audit: string): Promise<LangsungPeluncur | null> {
  const basis = path.resolve(dir);
  const f = path.resolve(basis, PELUNCUR_AUDIT.status.replace(/\{audit\}/g, audit));
  if (!f.startsWith(basis + path.sep)) return null;
  let s: Record<string, unknown>;
  try { s = JSON.parse(await readFile(f, "utf-8")) as Record<string, unknown>; } catch { return null; }
  if (!s || typeof s !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const t = (v: unknown, m = 300) => (typeof v === "string" ? v.slice(0, m) : null);
  const daftar = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : []);
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const pr = obj(s.progres), pil = obj(obj(s.perkiraan)?.pilihan), g = obj(s.gerbang);
  let log: string[] = [];
  const lf = path.resolve(basis, "_jalan", `${audit}.log`);
  if (lf.startsWith(basis + path.sep)) {
    try {
      const fh = await open(lf, "r");
      try {
        const size = (await fh.stat()).size, m = Math.min(size, 24576), buf = Buffer.alloc(m);
        await fh.read(buf, 0, m, size - m);
        log = buf.toString("utf-8").split(/\r?\n/).filter((l) => l.trim()).slice(-60).map((l) => l.slice(0, 260));
      } finally { await fh.close(); }
    } catch { /* no log yet */ }
  }
  return {
    status: t(s.status, 30) ?? "berjalan", tahap: t(s.tahap, 30), tahap_daftar: daftar(s.tahap_daftar), tahap_selesai: daftar(s.tahap_selesai), mulai: t(s.mulai, 30),
    usd: usdBerjalan(s) ?? 0, batas: n(s.usd_batas) ?? 0, pesan: pesanBerjalan(s) ?? null, iot: typeof s.iot_sumber === "string" && !!s.iot_sumber,
    replika: Array.isArray(s.replika) ? s.replika.length : 0,
    progres: pr ? { replika_selesai: n(pr.replika_selesai), replika_total: n(pr.replika_total), batch: n(pr.batch), batch_total: n(pr.batch_total) } : null,
    zona: pil && n(pil.klaim) != null ? { klaim: n(pil.klaim) ?? 0, tahan: n(pil.tahan) ?? 0, ragu: n(pil.ragu) ?? 0 } : null,
    gerbang: g ? { dibaca: n(g.dibaca), periksa: n(g.periksa), dibersihkan: n(g.dibersihkan) } : null, log,
    sinyal: await sinyalAudit(basis, audit, obj(s.sinyal)), aturan: aturanHasil(obj(s.aturan)),
    ...(await (async () => {
      const ind = await indikasiAudit(basis, audit, obj(s.indikasi));
      // the IoT stage checks every claim at the IoT hospitals (status.iot); the chart counts the audit's claims, as its report will
      return { indikasi: ind, iot_hasil: iotHasil(obj(ind?.iot), s.iot_sumber) };
    })()),
  };
}

const angkaAman = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
async function sinyalAudit(basis: string, audit: string, dariStatus: Record<string, unknown> | null): Promise<LangsungPeluncur["sinyal"]> {
  let x = dariStatus;
  if (!x) {
    const f = path.resolve(basis, "_jalan", `${audit}.sinyal.json`);
    if (!f.startsWith(basis + path.sep)) return null;
    try { x = JSON.parse(await readFile(f, "utf-8")) as Record<string, unknown>; } catch { return null; }
  }
  const klaim = angkaAman(x?.klaim), b = angkaAman(x?.klaim_bersinyal);
  if (klaim == null || b == null) return null;
  const teratas = (Array.isArray(x?.teratas) ? x.teratas : []).slice(0, 8).flatMap((r) => {
    const o = r as Record<string, unknown>;
    return typeof o?.kode === "string" && typeof o.label === "string" && angkaAman(o.n) != null ? [{ kode: o.kode.slice(0, 60), label: o.label.slice(0, 120), n: o.n as number }] : [];
  });
  return { klaim, klaim_bersinyal: b, teratas };
}
async function indikasiAudit(basis: string, audit: string, dariStatus: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  let x = dariStatus;
  if (!x) {
    const f = path.resolve(basis, "_jalan", `${audit}.indikasi.json`);
    if (!f.startsWith(basis + path.sep)) return null;
    try { x = JSON.parse(await readFile(f, "utf-8")) as Record<string, unknown>; } catch { return null; }
  }
  // the chart reads its counts, strengths, tags and data block: only a block with all of them is passed on
  const ok = !!x && angkaAman(x.klaim_bertag) != null && angkaAman(x.tag_aturan) != null && angkaAman(x.tag_model) != null
    && !!x.kekuatan && typeof x.kekuatan === "object" && Array.isArray(x.per_tag) && !!x.data && typeof x.data === "object";
  return ok ? x : null;
}
function iotHasil(x: Record<string, unknown> | null, sumber?: unknown): LangsungPeluncur["iot_hasil"] {
  const k = angkaAman(x?.klaim_dengan_alat), t = angkaAman(x?.tidak_sesuai);
  if (!x || k == null || t == null) return null;
  return { klaim_dengan_alat: k, tidak_sesuai: t, selisih_rp: angkaAman(x.selisih_rp) ?? 0, sesuai: angkaAman(x.sesuai), alat: angkaAman(x.alat),
    rs_dengan_iot: angkaAman(x.rs_dengan_iot), tanpa_bukti: angkaAman(x.tanpa_bukti), sintetis: typeof x.sintetis === "boolean" ? x.sintetis : sumber === "sintetis" };
}
function aturanHasil(x: Record<string, unknown> | null): LangsungPeluncur["aturan"] {
  if (!x) return null;
  const tem = (x.temuan && typeof x.temuan === "object" ? x.temuan : {}) as Record<string, unknown>;
  return { rute: angkaAman(x.rute_aturan), bukti: angkaAman(x.jalur_bukti_aturan), temuan_rme: angkaAman(tem.rme), temuan_iot: angkaAman(tem.iot),
    terverifikasi: angkaAman(tem.terverifikasi) };
}

/** The audit's spend so far: usd_berjalan as the runner writes it since 2026-11-16, else (a runner started before) the finished steps
 *  plus the swarm stage's own counter while it reads. The progress line and the live chart show this one number. */
function usdBerjalan(s: Record<string, unknown>): number | undefined {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (n(s.usd_berjalan) != null) return n(s.usd_berjalan);
  const pr = s.progres && typeof s.progres === "object" ? (s.progres as Record<string, unknown>) : {};
  const t = n(s.usd_terpakai);
  return t == null ? undefined : t + (s.tahap === "swarm" ? n(pr.usd_tahap_ini) ?? 0 : 0);
}
/** The runner's progress line; an older runner wrote the swarm stage's own spend at its end ("batch 80/332 · $1.029"): the total there. */
function pesanBerjalan(s: Record<string, unknown>): string | undefined {
  const p = typeof s.pesan === "string" ? s.pesan.slice(0, 300) : undefined;
  if (!p || s.usd_berjalan != null || s.tahap !== "swarm") return p;
  const u = usdBerjalan(s);
  return u == null ? p : p.replace(/· \$[\d.]+$/, `· $${u.toFixed(3)}`);
}

/** The runner's status file for an audit, when it has written one (null otherwise, or when the path leaves the data folder). */
export async function bacaStatusAudit(dir: string, audit: string): Promise<StatusPeluncur | null> {
  const basis = path.resolve(dir);
  const f = path.resolve(basis, PELUNCUR_AUDIT.status.replace(/\{audit\}/g, audit));
  if (!f.startsWith(basis + path.sep)) return null;
  try {
    const s = JSON.parse(await readFile(f, "utf-8")) as Record<string, unknown>;
    if (!s || typeof s !== "object") return null;
    const teks = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : undefined);
    const persen = typeof s.persen === "number" && Number.isFinite(s.persen) ? Math.max(0, Math.min(100, Math.round(s.persen))) : undefined;
    const pid = typeof s.pid === "number" && s.pid > 0 ? s.pid : null;
    const pr = s.progres && typeof s.progres === "object" ? (s.progres as Record<string, unknown>) : null;
    const angka = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return { status: teks(s.status), tahap: teks(s.tahap), persen, pesan: pesanBerjalan(s), run: teks(s.run),
      hidup: s.status === "berjalan" && s.selesai !== true && pid != null ? prosesAda(pid) : undefined,
      progres: pr ? { batch: angka(pr.batch), batch_total: angka(pr.batch_total) } : null };
  } catch {
    return null;
  }
}
