/*
 * "Is the caller signed in?" for route handlers that read files themselves (IoMT Audit Report, Verifier Desk, ML Studio
 * Perbandingan): the API decides, from the session cookie or the bearer token the request carries.
 *
 * The API must be asked at its public host. It ignores its session cookie on the hosting origin, which by default is its
 * own address with localhost and 127.0.0.1 swapped (api/auth.py hosting_url, _cookieless): BLUESANDAI_API_URL is
 * 127.0.0.1, so a check sent there reads every signed-in browser as signed out (found 2026-11-08: a real admin session
 * got 401 while a bearer token got 200). So the check goes where the browser itself sends API calls (lib/api.ts API_URL):
 * NEXT_PUBLIC_API_URL, or localhost on NEXT_PUBLIC_API_PORT; same origin when the public build leaves it empty.
 */

/** The API's public base for server-side calls that carry the caller's own session (see above). */
export function authBase(request: Request): string {
  const pub = process.env.NEXT_PUBLIC_API_URL;
  if (pub) return pub.replace(/\/$/, "");
  if (pub === "") return new URL(request.url).origin;
  return `http://localhost:${process.env.NEXT_PUBLIC_API_PORT ?? "8000"}`;
}

/** Who is calling (a display name), for records a route writes itself (the branch verifier's decisions); null when signed out. */
export async function sessionUser(request: Request): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    const cookie = request.headers.get("cookie");
    const authorization = request.headers.get("authorization");
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
    const res = await fetch(`${authBase(request)}/api/auth/status`, { headers, cache: "no-store", signal: AbortSignal.timeout(5000) });
    const s = (await res.json()) as { enabled?: boolean; user?: { name?: string; username?: string; email?: string } | string | null };
    if (s.enabled === false) return "lokal";
    if (!s.user) return null;
    return typeof s.user === "string" ? s.user : s.user.name || s.user.username || "pengguna";
  } catch {
    return null;
  }
}

export async function signedIn(request: Request): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    const cookie = request.headers.get("cookie");
    const authorization = request.headers.get("authorization");
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
    const res = await fetch(`${authBase(request)}/api/auth/status`, { headers, cache: "no-store", signal: AbortSignal.timeout(5000) });
    const s = (await res.json()) as { enabled?: boolean; user?: unknown };
    return s.enabled === false || Boolean(s.user);
  } catch {
    return false;
  }
}
