import http from "node:http";
import https from "node:https";
import { signedIn } from "@/lib/sessionCheck";

/*
 * The /testing page's API calls (/testing/api/*), passed to the testing service: testing/app.py under uvicorn, on
 * 127.0.0.1:8320 unless TESTING_API_URL (web/.env.local) says otherwise; start.ps1 starts it. That service runs its own
 * realtime engine on a copy of the synthetic stream (.tmp/testing-data), so it stays a process of its own beside the API
 * on 8300. It listens on 127.0.0.1 and has no sign-in of its own: this route is the gate (signed-in users only).
 * node:http rather than fetch: scoring a batch with the AI explanation can take longer than fetch's 5-minute header wait.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = (process.env.TESTING_API_URL ?? "http://127.0.0.1:8320").replace(/\/$/, "");
const SEGMEN = /^[A-Za-z0-9_.-]{1,80}$/;
const BATAS_MS = 15 * 60_000;

type Jawaban = { status: number; type: string; body: Buffer };

function panggil(url: string, method: string, headers: Record<string, string>, body?: Buffer): Promise<Jawaban> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.request(url, { method, headers: body ? { ...headers, "content-length": String(body.length) } : headers, timeout: BATAS_MS }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, type: String(res.headers["content-type"] ?? "application/json"), body: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function teruskan(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  if (!path.length || path.some((s) => !SEGMEN.test(s) || s === "." || s === "..")) return Response.json({ detail: "alamat tidak dikenal" }, { status: 404 });
  if (!(await signedIn(request))) return Response.json({ detail: "Masuk dulu untuk memakai uji klaim." }, { status: 401 });
  const headers: Record<string, string> = { accept: "application/json" };
  const ct = request.headers.get("content-type");
  if (ct) headers["content-type"] = ct;
  const body = request.method === "GET" ? undefined : Buffer.from(await request.arrayBuffer());
  try {
    const r = await panggil(`${BASE}/testing/api/${path.join("/")}${new URL(request.url).search}`, request.method, headers, body);
    return new Response(new Uint8Array(r.body), { status: r.status, headers: { "content-type": r.type, "cache-control": "no-store" } });
  } catch (e) {
    const habis = (e as Error).name === "TimeoutError";
    return Response.json({ detail: habis ? "Layanan uji klaim tidak menjawab dalam 15 menit."
      : `Layanan uji klaim belum jalan di ${BASE}: jalankan start.ps1 (atau testing\\start-testing.ps1); siap dalam beberapa menit.` }, { status: habis ? 504 : 503 });
  }
}

export const GET = teruskan;
export const POST = teruskan;
