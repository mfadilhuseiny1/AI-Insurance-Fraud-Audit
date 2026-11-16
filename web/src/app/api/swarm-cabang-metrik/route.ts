import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * ML Studio · "Metrik AI Agent Swarm" (the user, 2026-11-15: "precision & recall sistem (rule engine + ml7) [dan] keseluruhan
 * (rule engine + ml7 + AIoT verification + AI Agent Swarm) ... bikin tab baru metrik2 nya kayak di Laporan v7 metrik juri ...
 * bandingkan apakah multi agent swarm bisa nurunin false positive?"): every system of a finished branch run on the same claims and
 * planted labels, with hospital-resampled intervals. Aggregates only (no claim rows), written by testing/swarm_cabang_metrik.py.
 * Read-only, signed-in users only. Synthetic data only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");
const FILE = path.join(DATA, "aip", "ml", "sistem_terbaru", "swarm_cabang_metrik.json");

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat metrik AI Agent Swarm." }, { status: 401 });
  try {
    const text = await readFile(FILE, "utf-8");
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Belum ada metrik AI Agent Swarm cabang. Jalankan testing/swarm_cabang_metrik.py." }, { status: 404 });
  }
}
