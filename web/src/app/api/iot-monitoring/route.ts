import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * IoT Monitoring (the user, 2026-11-15: "generate some synthetic data for several case and create dashboard of it on IoT
 * Monitoring tabs"): the medical-device layer of a branch office. A current clamp on each device's power cable reports only
 * when the device is on, for how long and in which mode (no vital signs); each use is bound device <-> patient (masked) <->
 * visit/claim, and the readings are anchored before the claim. One folder per run, synthetic data:
 *   data/aip/cabang/iot/<run>/monitoring.json
 *   GET /api/iot-monitoring            the runs (newest first), each with its branch, period and headline numbers
 *   GET /api/iot-monitoring?run=<id>   one run's monitoring.json, as written
 * Read-only, signed-in users only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");
const DIR = path.join(DATA, "aip", "cabang", "iot");
const RUN = /^[a-z0-9_]{3,40}$/;
const FILE = "monitoring.json";
// the list reads each run's header; a file larger than this is listed by its id alone
const BACA_MAKS = 64 * 1024 * 1024;

type RunInfo = { id: string; diubah: string; kc?: unknown; periode?: unknown; sintetis?: unknown; ringkas?: unknown };

async function daftarRun(): Promise<RunInfo[]> {
  let entri: { name: string; isDirectory(): boolean }[];
  try { entri = await readdir(DIR, { withFileTypes: true }); } catch { return []; }
  const out = await Promise.all(entri.filter((e) => e.isDirectory() && RUN.test(e.name)).map(async (e): Promise<RunInfo | null> => {
    const file = path.join(DIR, e.name, FILE);
    try {
      const s = await stat(file);
      const info: RunInfo = { id: e.name, diubah: s.mtime.toISOString() };
      if (s.size <= BACA_MAKS) {
        try {
          const m = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
          Object.assign(info, { kc: m.kc, periode: m.periode, sintetis: m.sintetis, ringkas: m.ringkas });
        } catch { /* still being written: listed by its id */ }
      }
      return info;
    } catch { return null; }
  }));
  return out.filter((r): r is RunInfo => r !== null).sort((a, b) => b.diubah.localeCompare(a.diubah));
}

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat IoT Monitoring." }, { status: 401 });
  const run = new URL(request.url).searchParams.get("run");
  if (run === null) return Response.json({ runs: await daftarRun() }, { headers: { "cache-control": "no-store" } });
  if (!RUN.test(run)) return Response.json({ error: "Run tidak dikenal." }, { status: 400 });
  try {
    const text = await readFile(path.join(DIR, run, FILE), "utf-8");
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: `Belum ada data IoT Monitoring untuk run ${run}.` }, { status: 404 });
  }
}
