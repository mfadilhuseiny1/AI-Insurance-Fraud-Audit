import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * ML Studio · "Laporan v7 · metrik juri" (the user, 2026-11-15: "bikin report v7 sesuai metrik2 permintaan juri ... F1 score,
 * FP TP FN TN, confusion matrix, metrik2 ml"): the confusion matrix and standard ML metrics of ML v7 on the four test
 * generators, plus the Healthkathon coaching deck's metrics (precision@k, lift, rupiah recall@k, share of honest hospitals
 * audited, conditions, held-out schemes, hard negatives, intervals by hospital). Aggregates only (no claim rows), written by
 * testing/ml_v7_metrik_juri.py from the frozen models. Read-only, signed-in users only. Synthetic data only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");
const FILE = path.join(DATA, "aip", "ml", "sistem_terbaru", "ml_v7_metrik_juri.json");

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat laporan ML v7." }, { status: 401 });
  try {
    const text = await readFile(FILE, "utf-8");
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Belum ada laporan metrik ML v7. Jalankan testing/ml_v7_metrik_juri.py." }, { status: 404 });
  }
}
