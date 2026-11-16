import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * The IoMT Audit Report: the result of one run of synthetic-iomt/audit.py, served as it was written (report.json).
 * A separate workflow from the AI Agent Swarm and its BPJS data: this reads only the synthetic world's audit output,
 * so nothing from BPJS claims is in it. Read-only, signed-in users only. Run the audit again to refresh it:
 *   .venv\Scripts\python.exe -I synthetic-iomt\audit.py
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");
const FILE = path.join(DATA, "synthetic-iomt", "audit_out", "report.json");

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Sign in to see the IoMT Audit Report." }, { status: 401 });
  try {
    const text = await readFile(FILE, "utf-8");
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "No audit result yet. Generate the synthetic data and run the audit: synthetic-iomt\\generate.py, then synthetic-iomt\\audit.py." }, { status: 404 });
  }
}
