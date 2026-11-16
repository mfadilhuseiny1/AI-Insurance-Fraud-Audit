import { runBuild, setServiceToken } from "@/lib/server/runner";

/*
 * The build runner: the API queues a build and posts its id here; the build runs in this server
 * process (the same pipeline engine as the browser) and reports progress back to the API.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const running = new Set<string>();
const API = process.env.BLUESANDAI_API_URL ?? "http://127.0.0.1:8000";

/** The API's service token? The API says so (a forged token would otherwise replace the runner's). */
async function isServiceToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(`${API}/api/auth/status`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    const s = (await res.json()) as { enabled?: boolean; service?: boolean };
    return s.enabled === false || s.service === true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const { buildId, token } = (await request.json()) as { buildId?: string; token?: string };
  if (!(await isServiceToken(token))) return Response.json({ error: "the API's service token is required" }, { status: 401 });
  if (!buildId || !/^build-[0-9a-f]{12}$/.test(buildId)) return Response.json({ error: "buildId required" }, { status: 400 });
  if (running.has(buildId)) return Response.json({ started: false, reason: "already running" }, { status: 409 });
  running.add(buildId);
  setServiceToken(token);
  // runs after the response: the API does not wait for the build
  void runBuild(buildId).finally(() => running.delete(buildId));
  return Response.json({ started: true }, { status: 202 });
}

export async function GET(request: Request) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
  if (!(await isServiceToken(token))) return Response.json({ error: "the API's service token is required" }, { status: 401 });
  return Response.json({ running: [...running] });
}
