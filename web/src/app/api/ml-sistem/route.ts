import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * ML Studio · Sistem ML terbaru (the user, 2026-11-12: "update ML Studio to our latest ML System used + its metric chart
 * and graph, precision@k"): the fraud system the /testing bench runs — Model 1 (graph + neighbours), Model 2 (hospital
 * network), the stacker with isotonic calibration and the network alert — with its out-of-fold evaluation on the
 * synthetic stream. Aggregate numbers only (no claim rows), written by testing/laporan_ml.py and served as written.
 * Read-only, signed-in users only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");
const FILE = path.join(DATA, "aip", "ml", "sistem_terbaru", "sistem.json");
// ML v7's zones (testing/zona_ml_v7.py: set on the pooled dev normals, never a test set) for System Architecture's flow
const ZONA_V7 = process.env.BLUESANDAI_ZONA_V7 ?? path.join(process.cwd(), "..", "testing", "model_ml_v7", "zona_v5.json");

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat sistem ML." }, { status: 401 });
  // ?bagian=v7: only what System Architecture draws (ML v7's card and benchmark, its zones), not the whole report
  if (new URL(request.url).searchParams.get("bagian") === "v7") {
    try {
      const d = JSON.parse(await readFile(FILE, "utf-8"));
      const zona = await readFile(/*turbopackIgnore: true*/ ZONA_V7, "utf-8").then((t) => JSON.parse(t)).catch(() => null);
      return Response.json({ ml_v7: d?.arsitektur_graf?.ml_v7 ?? null, zona }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ error: "Belum ada laporan sistem ML (testing/ml_v7.py)." }, { status: 404 });
    }
  }
  try {
    const text = await readFile(FILE, "utf-8");
    return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Belum ada laporan sistem ML. Jalankan testing/laporan_ml.py (setelah testing/latih_model.py)." }, { status: 404 });
  }
}
