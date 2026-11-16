import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";

/*
 * Uji klaim (/testing) inside the app on 9300 (the user, 2026-11-14: "/testing copy paste juga ke ai-jkn-synthetic port
 * 9300", "sesuaikan ke repo tersebut env nya dan config lain2"). The page is the very file the testing service serves on
 * its own port (testing/static/testing.html), read on every request so the two never drift; its calls to /testing/api/*
 * go through ./api/[...path] to that service. Signed-in users only: a signed-out visitor goes to /login and comes back.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HTML = process.env.TESTING_HTML ?? path.join(process.cwd(), "..", "testing", "static", "testing.html");

export async function GET(request: Request) {
  if (!(await signedIn(request))) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", "/testing");
    return Response.redirect(login, 303);
  }
  try {
    // one known file outside web/: no need to trace the whole project into the build
    return new Response(await readFile(/*turbopackIgnore: true*/ HTML, "utf-8"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  } catch {
    return new Response("Halaman uji klaim tidak ditemukan (testing/static/testing.html).", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
