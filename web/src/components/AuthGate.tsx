"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { auth, MFA_ENROLLMENT, UNAUTHENTICATED, type AuthStatus, type Me } from "@/lib/auth";
import { EmulationBanner } from "./auth/Emulation";
import { AuthCard, MfaSetup } from "./auth/SignIn";
import { LogoMark } from "./Logo";

/** pages anyone can open: sign-in, its links (reset, invitation), shared links, and the IoT binding demo (/faskes: fictitious
    data in the page itself, no API call; opened on a phone over the LAN for screen recordings) */
const PUBLIC = ["/login", "/forgot-password", "/reset-password", "/accept-invite", "/s/", "/faskes"];
const isPublic = (path: string) => PUBLIC.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));

type AuthContext = { me: Me | null; enabled: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> };
const Ctx = createContext<AuthContext>({ me: null, enabled: false, refresh: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

/**
 * Signs the app in: pages other than sign-in and shared links need a signed-in user (when the API has sign-in on),
 * and any 401 from the API sends the browser to the sign-in page, back here afterwards. A session that must first set
 * up two-factor authentication sees only that. With an idle timeout, page activity is reported to the API (a heartbeat
 * at most once a minute) and a warning shows one minute before the session would end.
 */
export function AuthGate({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const toLogin = useCallback(
    (reason?: string) => {
      if (isPublic(window.location.pathname)) return;
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}${reason ? `&reason=${reason}` : ""}`);
    },
    [router],
  );
  const refresh = useCallback(async () => {
    try {
      const s = await auth.status();
      setStatus(s);
      setOffline(false);
      if (s.enabled && !s.user) toLogin();
    } catch {
      // the API is down: let the pages show their own "cannot reach the API" state
      setOffline(true);
    }
  }, [toLogin]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads who is signed in
    refresh();
    const onLost = (e: Event) => {
      setStatus((s) => (s ? { ...s, user: null } : s));
      toLogin((e as CustomEvent<{ code?: string }>).detail?.code === "idle_timeout" ? "idle" : undefined);
    };
    const onEnroll = () => refresh();
    window.addEventListener(UNAUTHENTICATED, onLost);
    window.addEventListener(MFA_ENROLLMENT, onEnroll);
    return () => {
      window.removeEventListener(UNAUTHENTICATED, onLost);
      window.removeEventListener(MFA_ENROLLMENT, onEnroll);
    };
  }, [refresh, toLogin]);
  const signOut = useCallback(async () => {
    // single logout: a single sign-on session also ends at its identity provider (the browser goes there next)
    const r = await auth.ssoLogout().catch(() => auth.logout().catch(() => null));
    if (r && "redirect" in r && r.redirect) {
      window.location.href = r.redirect;
      return;
    }
    setStatus((s) => (s ? { ...s, user: null } : s));
    router.replace("/login");
  }, [router]);
  const value: AuthContext = { me: status?.user ?? null, enabled: !!status?.enabled, refresh, signOut };

  if (isPublic(path)) return <Ctx.Provider value={value}>{<main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>}</Ctx.Provider>;
  const ready = offline || (status && (!status.enabled || status.user));
  if (!ready)
    return (
      <main className="flex flex-1 items-center justify-center bg-ink">
        <div className="flex items-center gap-2 text-sm text-muted">
          <span className="animate-pulse">
            <LogoMark size={22} />
          </span>{" "}
          Checking your session…
        </div>
      </main>
    );
  if (status?.mfa_enrollment_required)
    return (
      <Ctx.Provider value={value}>
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <AuthCard subtitle="Set up two-factor authentication to continue" wide>
            <p className="mb-3 text-xs text-muted">Your administrator requires two-factor authentication for your account. Set it up once; afterwards sign-in asks for a code.</p>
            <MfaSetup onDone={() => window.location.reload()} onCancel={signOut} />
          </AuthCard>
        </main>
      </Ctx.Provider>
    );
  // Carbon workspaces and the modules they embed (?embed=1) run without the platform's sidebar
  // ... and the mobile app launcher (/m) with its applications
  const chromeless = path.startsWith("/carbon/") || path === "/m" || path.startsWith("/m/") || path.startsWith("/jkn-mobile") || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("embed") === "1");
  return (
    <Ctx.Provider value={value}>
      {!chromeless && sidebar}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {status?.user?.emulation && <EmulationBanner me={status.user} />}
        {children}
      </main>
      {status?.enabled && status.user && !!status.idle_timeout_minutes && <IdleWatch minutes={status.idle_timeout_minutes} onTimeout={() => toLogin("idle")} />}
    </Ctx.Provider>
  );
}

/**
 * Idle timeout on the page: interactions (pointer, keys, scrolling, touch) count as activity and are reported to the API
 * at most once a minute, which keeps the session alive there. One minute before the timeout a warning offers to stay
 * signed in; at the timeout the app signs out.
 */
function IdleWatch({ minutes, onTimeout }: { minutes: number; onTimeout: () => void }) {
  const last = useRef(0);
  const reported = useRef(0);
  const [left, setLeft] = useState<number | null>(null);
  const beat = useCallback(() => {
    reported.current = Date.now();
    auth.heartbeat().catch(() => {});
  }, []);
  useEffect(() => {
    const t0 = Date.now();
    last.current = t0;
    reported.current = t0;
    const onActivity = () => {
      last.current = Date.now();
      if (Date.now() - reported.current > 60_000) beat();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"] as const;
    for (const e of events) window.addEventListener(e, onActivity, { passive: true });
    const timer = setInterval(() => {
      const idle = Date.now() - last.current;
      const remaining = minutes * 60_000 - idle;
      if (remaining <= 0) {
        clearInterval(timer);
        auth.logout().finally(onTimeout);
      } else setLeft(remaining <= 60_000 ? Math.ceil(remaining / 1000) : null);
    }, 1000);
    return () => {
      for (const e of events) window.removeEventListener(e, onActivity);
      clearInterval(timer);
    };
  }, [minutes, beat, onTimeout]);
  if (left === null) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-warn/40 bg-panel px-4 py-3 text-sm shadow-xl">
      <span className="text-warn">You will be signed out in {left} s for inactivity.</span>
      <button
        type="button"
        onClick={() => {
          last.current = Date.now();
          beat();
          setLeft(null);
        }}
        className="rounded-md bg-ocean px-3 py-1 text-xs font-medium text-white"
      >
        Stay signed in
      </button>
    </div>
  );
}
