import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * Hackathon reports in ML Studio (the user, 2026-11-13: "kasih report lengkap di ML Studio"): the same pages as the published
 * artifacts, built by testing/laporan_gen1.py (Generator 1, the hackathon scope: data close to the BPJS sample distribution)
 * and testing/laporan_hackathon.py (all four generators) into docs/. Served as a full document for an iframe in ML Studio.
 *   GET /api/laporan-hackathon?r=gen1|lintas[&tema=dark|light]
 * Signed-in users only. Synthetic data only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCS = path.join(process.cwd(), "..", "docs");
const FILE: Record<string, string> = { gen1: "laporan_gen1.html", lintas: "laporan_hackathon.html" };

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat laporan." }, { status: 401 });
  const url = new URL(request.url);
  const r = url.searchParams.get("r") ?? "gen1";
  const f = FILE[r];
  if (!f) return Response.json({ error: "Laporan tidak dikenal." }, { status: 400 });
  const tema = url.searchParams.get("tema") === "light" ? "light" : "dark";
  let body: string;
  try {
    body = await readFile(path.join(DOCS, f), "utf8");
  } catch {
    return Response.json({ error: "Laporan belum dibuat. Jalankan testing/laporan_gen1.py atau testing/laporan_hackathon.py." }, { status: 404 });
  }
  // the page is written for the artifact wrapper (no doctype/head of its own): give it the same minimal skeleton
  const html = `<!doctype html><html lang="id" data-theme="${tema}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
