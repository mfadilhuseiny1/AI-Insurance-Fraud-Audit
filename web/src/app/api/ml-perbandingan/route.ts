import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * The model comparison of ML Studio (the user, 2026-11-08: "di tab ML studio kasih perbandingan semuanya ML DL OpenAI
 * Decision"): who finds the claims the BPJS verifier corrected — Random Forest, an FT-Transformer, OpenAI Decisions,
 * DeepSeek and JEv. Aggregate numbers only (no claim rows), written once by the scripts in api/ml_perbandingan and served
 * as they were written. Read-only, signed-in users only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");
const FILE = path.join(DATA, "aip", "ml", "perbandingan", "perbandingan.json");

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat perbandingan model." }, { status: 401 });
  try {
    const text = await readFile(FILE, "utf-8");
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Belum ada hasil perbandingan. Jalankan skrip di api/ml_perbandingan (lihat README di sana)." }, { status: 404 });
  }
}
