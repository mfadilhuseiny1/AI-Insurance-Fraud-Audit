import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { authBase, sessionUser, signedIn } from "@/lib/sessionCheck";
import { bangunBiaya, bangunJejak } from "@/lib/cabangJejak";

/*
 * AI Agent Swarm Branch (the user, 2026-11-13: "audit dilakukan kantor cabang BPJS, bukan kantor pusat — yang melakukan
 * verifikasi adalah kantor cabang; hasil audit dikelompokkan per tema"): the branch office's audit reports, one folder per
 * run, written by testing/laporan_cabang.py from v5 (model v4 + rule engine + the ADK swarm on Vertex AI) on synthetic claims,
 * and the verifiers' decisions on the flagged claims (terbukti bermasalah / sesuai / perlu investigasi), kept per run.
 *   GET  /api/swarm-cabang                        the runs (newest first)
 *   GET  /api/swarm-cabang?run=<id>               one run's branches (and its technical appendix)
 *   GET  /api/swarm-cabang?run=<id>&kc=<id>       one branch's report, with the verifiers' decisions so far
 *   GET  /api/swarm-cabang?run=<id>&kc=<id>&graf=1  the index of the case files' networks (graf_<kc>/index.json, testing/graf_cabang.py):
 *                                                 the shared header and, per case, what the list shows before it is opened
 *   GET  /api/swarm-cabang?run=<id>&kc=<id>&graf=1&kasus=<KLM-id>  one case file's network (graf_<kc>/<KLM-id>.json): the earlier
 *                                                 claims the model compared it with, the hospitals its member visited, the explanation
 *                                                 and the lineage. Runs built before 2026-11-15 have one graf_<kc>.json holding every
 *                                                 case: graf=1 sends it whole, &kasus= one case out of it.
 *   GET  /api/swarm-cabang?run=<id>&jejak=1       the run's steps (fitur → zona → iot → aturan → swarm → laporan → narasi): when
 *                                                 each ran, how long, what it produced, its cost, every attempt (src/lib/cabangJejak.ts)
 *   GET  /api/swarm-cabang?run=<id>&biaya=1       the run's cost: the report's own, the cap and the cost book, tokens, the agents'
 *                                                 answers over time; what the runner does not record is left out, never estimated
 *   POST /api/swarm-cabang  {run, kc, klaim, status, catatan}   record (or clear: status "") a verifier's decision; it is also
 *                                                               sent to the indikasi ledger (POST /api/aip/realtime/v1/cabang/putusan)
 *                                                               so Box Karantina reads it, as the caller
 * A run's index carries how much of it sits in the ledger (GET /api/aip/realtime/v1/cabang/tag/<run>).
 * Signed-in users only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");
// CABANG_DIR (2026-11-13): a separate local instance (port 9310) serves the REAL-sample trial from the BPJS project's data folder
// (ai-jkn-audit/data/aip/uji_riil/cabang, testing/uji_riil.py); it never writes to or reads from this app's ledger
const DIR = process.env.CABANG_DIR ?? path.join(DATA, "aip", "cabang");
const TANPA_LEDGER = Boolean(process.env.CABANG_DIR);
// a case id is KLM- + 8 hex of the claim key's md5, 12 hex where 8 would collide inside a report (testing/laporan_cabang.py)
const RUN = /^[a-z0-9_]{3,40}$/, KC = /^[a-z]{3}-\d{1,5}$/, KLAIM = /^KLM-[0-9A-F]{8,12}$/;
const STATUS = new Set(["terbukti", "sesuai", "investigasi", ""]);
type Putusan = { status: string; catatan: string; oleh: string; pada: string };

/** A call to the API as the caller (their cookie or bearer), best effort: the branch decision is kept even when the API is down. */
async function keApi(request: Request, p: string, init?: RequestInit): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const cookie = request.headers.get("cookie"), authorization = request.headers.get("authorization");
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
    const res = await fetch(`${authBase(request)}${p}`, { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => null);
    return res.ok ? { ok: true, data } : { ok: false, error: (data as { detail?: string } | null)?.detail ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

async function bacaVerifikasi(run: string): Promise<Record<string, Record<string, Putusan>>> {
  try { return JSON.parse(await readFile(path.join(DIR, run, "verifikasi.json"), "utf-8")); } catch { return {}; }
}

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat laporan kantor cabang." }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const run = q.get("run"), kc = q.get("kc");
  if (run !== null && !RUN.test(run)) return Response.json({ error: "Run tidak dikenal." }, { status: 400 });
  if (kc !== null && (!run || !KC.test(kc))) return Response.json({ error: "Kantor cabang tidak dikenal." }, { status: 400 });
  // a run's work trail and cost (the report's "Jejak kerja" and "Biaya & token" tabs): read from the runner's own records
  if (q.get("jejak") === "1" || q.get("biaya") === "1") {
    if (!run) return Response.json({ error: "Pilih run." }, { status: 400 });
    try {
      const d = q.get("biaya") === "1" ? await bangunBiaya(DIR, run) : await bangunJejak(DIR, run);
      return Response.json(d, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      return Response.json({ error: `Catatan run tidak terbaca: ${String((e as Error).message || e).slice(0, 200)}` }, { status: 500 });
    }
  }
  if (q.get("graf") === "1") {
    if (!run || !kc) return Response.json({ error: "Pilih run dan kantor cabang." }, { status: 400 });
    const kasus = q.get("kasus");
    if (kasus !== null && !KLAIM.test(kasus)) return Response.json({ error: "Klaim tidak dikenal." }, { status: 400 });
    const json = { "content-type": "application/json", "cache-control": "no-store" };
    const belum = () => Response.json({ error: "Jaringan klaim belum dibuat untuk KC ini. Jalankan testing/graf_cabang.py." }, { status: 404 });
    const tidakAda = () => Response.json({ error: `Jaringan klaim ${kasus} tidak ada di KC ini.` }, { status: 404 });
    // one folder per branch (graf_<kc>/index.json + a file per case), served once its index is written
    const folder = path.join(DIR, run, `graf_${kc}`);
    if (await access(path.join(folder, "index.json")).then(() => true, () => false)) {
      try {
        return new Response(await readFile(path.join(folder, kasus ? `${kasus}.json` : "index.json"), "utf-8"), { headers: json });
      } catch {
        return kasus ? tidakAda() : belum();
      }
    }
    // runs built before 2026-11-15: one graf_<kc>.json with every case
    let text: string;
    try { text = await readFile(path.join(DIR, run, `graf_${kc}.json`), "utf-8"); } catch { return belum(); }
    if (!kasus) return new Response(text, { headers: json });
    const g = (JSON.parse(text) as { kasus?: Record<string, unknown> }).kasus?.[kasus];
    return g ? Response.json(g, { headers: { "cache-control": "no-store" } }) : tidakAda();
  }
  const file =!run ? path.join(DIR, "runs.json") : kc ? path.join(DIR, run, `kc_${kc}.json`) : path.join(DIR, run, "index.json");
  try {
    const text = await readFile(file, "utf-8");
    if (run && kc) {
      const lap = JSON.parse(text);
      lap.verifikasi = (await bacaVerifikasi(run))[kc] ?? {};
      return Response.json(lap, { headers: { "cache-control": "no-store" } });
    }
    if (run) {
      const idx = JSON.parse(text);
      if (!TANPA_LEDGER) {
        const led = await keApi(request, `/api/aip/realtime/v1/cabang/tag/${run}`);
        idx.ledger = led.ok ? led.data : { error: led.error };
      }
      return Response.json(idx, { headers: { "cache-control": "no-store" } });
    }
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Belum ada laporan kantor cabang untuk pilihan ini. Jalankan testing/laporan_cabang.py." }, { status: 404 });
  }
}

export async function POST(request: Request) {
  const oleh = await sessionUser(request);
  if (!oleh) return Response.json({ error: "Masuk dulu untuk mencatat hasil verifikasi." }, { status: 401 });
  let b: { run?: string; kc?: string; klaim?: string; status?: string; catatan?: string };
  try { b = await request.json(); } catch { return Response.json({ error: "Body tidak valid." }, { status: 400 }); }
  const { run = "", kc = "", klaim = "", status = "" } = b;
  const catatan = String(b.catatan ?? "").slice(0, 1000);
  if (!RUN.test(run) || !KC.test(kc) || !KLAIM.test(klaim) || !STATUS.has(status)) return Response.json({ error: "Isian tidak valid." }, { status: 400 });
  try {
    const lap = JSON.parse(await readFile(path.join(DIR, run, `kc_${kc}.json`), "utf-8")) as { kasus: { id: string; keputusan: string }[] };
    if (!lap.kasus.some((k) => k.id === klaim && k.keputusan !== "DIBERSIHKAN")) return Response.json({ error: "Klaim tidak ada di antrean KC ini." }, { status: 404 });
  } catch { return Response.json({ error: "Laporan tidak ditemukan." }, { status: 404 }); }
  const semua = await bacaVerifikasi(run);
  const kcMap = (semua[kc] ??= {});
  if (status === "") delete kcMap[klaim];
  else kcMap[klaim] = { status, catatan, oleh, pada: new Date().toISOString() };
  await mkdir(path.join(DIR, run), { recursive: true });
  const tmp = path.join(DIR, run, `verifikasi.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(semua), "utf-8");
  await rename(tmp, path.join(DIR, run, "verifikasi.json"));
  if (TANPA_LEDGER) return Response.json({ ok: true, verifikasi: kcMap, ledger: { error: "data riil: tidak dihubungkan ke ledger" } });
  const led = await keApi(request, "/api/aip/realtime/v1/cabang/putusan", { method: "POST", body: JSON.stringify({ run, kc, klaim, status, catatan }) });
  return Response.json({ ok: true, verifikasi: kcMap, ledger: led.ok ? led.data : { error: led.error } });
}
