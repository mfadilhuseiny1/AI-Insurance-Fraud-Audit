"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthCard, authButton, authInput, Divider, NewPassword, passwordReady, SsoButtons } from "@/components/auth/SignIn";
import { auth, type LoginResult, type PublicPolicy } from "@/lib/auth";

type Mode = "loading" | "login" | "setup" | "off" | "mfa";

const query = (k: string) => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get(k) ?? ""));

/**
 * Sign in: single sign-on buttons, then username (or email) and password; a second step asks for the authenticator
 * code when two-factor is on, and an expired (or administrator-set) password goes to choosing a new one. On the very
 * first start (no users yet) it creates the first administrator instead.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [policy, setPolicy] = useState<PublicPolicy | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [adminPassword, setAdminPassword] = useState(false);
  const [error, setError] = useState<string | null>(() => query("sso_error") || null);
  const [notice] = useState<string | null>(() => (query("reason") === "idle" ? "You were signed out after a while without activity. Sign in again." : null));
  const [busy, setBusy] = useState(false);
  const next = () => {
    const n = query("next");
    return n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/";
  };
  useEffect(() => {
    auth.policy().then(setPolicy, () => {});
    auth.status().then(
      (s) => {
        if (!s.enabled) return setMode("off");
        if (s.user) return router.replace(next());
        setMode(s.setup_needed ? "setup" : "login");
      },
      () => setError("Cannot reach the BluesandAI API. Start it, then reload this page."),
    );
  }, [router]);
  // a full load, so every page starts with the new session
  const done = () => window.location.replace(next());
  const handle = (r: LoginResult) => {
    if (r.mfa_required && r.mfa_token) {
      setMfaToken(r.mfa_token);
      setMode("mfa");
      setBusy(false);
      return;
    }
    if (r.password_expired && r.reset_token) {
      window.location.replace(`/reset-password?token=${encodeURIComponent(r.reset_token)}&next=${encodeURIComponent(next())}`);
      return;
    }
    done();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "setup") {
        if (password !== confirm) throw new Error("The passwords do not match");
        handle(await auth.setup({ username, password, display_name: displayName }));
      } else if (mode === "mfa") handle(await auth.loginMfa(mfaToken, useRecovery ? "" : code, useRecovery ? code : ""));
      else handle(await auth.login(username, password));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const ssoOnly = policy && !policy.password_login && !adminPassword;
  return (
    <AuthCard subtitle={mode === "setup" ? "Set up the platform: create the first administrator" : mode === "mfa" ? "Two-factor authentication" : "Sign in to continue"}>
      {mode === "loading" && !error && <p className="text-sm text-muted">Loading…</p>}
      {mode === "off" && (
        <p className="text-sm text-muted">
          Sign-in is turned off on this server (BLUESANDAI_AUTH=off).{" "}
          <Link href="/" className="text-ocean hover:underline">
            Open the app
          </Link>
        </p>
      )}
      {notice && mode === "login" && <p className="mb-3 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">{notice}</p>}
      {mode === "login" && policy && policy.sso.length > 0 && (
        <>
          <SsoButtons providers={policy.sso} next={next()} />
          {!ssoOnly && <Divider text="or with a password" />}
        </>
      )}
      {mode === "mfa" ? (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs">
            <span className="mb-1 block text-muted">{useRecovery ? "A recovery code" : "The 6-digit code from your authenticator app"}</span>
            <input
              autoFocus
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={useRecovery ? "abcde-fghij" : "123 456"}
              className={`${authInput} text-center tracking-[0.25em]`}
            />
          </label>
          <button type="submit" disabled={busy || !code.trim()} className={authButton}>
            {busy ? "…" : "Verify"}
          </button>
          <div className="flex justify-between text-xs">
            <button type="button" onClick={() => (setUseRecovery(!useRecovery), setCode(""), setError(null))} className="text-ocean hover:underline">
              {useRecovery ? "Use the authenticator app" : "Use a recovery code"}
            </button>
            <button type="button" onClick={() => (setMode("login"), setCode(""), setPassword(""))} className="text-muted hover:text-white">
              Back
            </button>
          </div>
        </form>
      ) : (
        (mode === "login" || mode === "setup") &&
        !ssoOnly && (
          <form onSubmit={submit} className="space-y-3">
            {mode === "setup" && (
              <label className="block text-xs">
                <span className="mb-1 block text-muted">Your name</span>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={authInput} />
              </label>
            )}
            <label className="block text-xs">
              <span className="mb-1 block text-muted">{mode === "setup" ? "Username" : "Username or email"}</span>
              <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={authInput} />
            </label>
            {mode === "setup" ? (
              <NewPassword policy={policy?.password} value={password} confirm={confirm} onChange={setPassword} onConfirm={setConfirm} label="Password" />
            ) : (
              <label className="block text-xs">
                <span className="mb-1 flex justify-between text-muted">
                  Password
                  <Link href={`/forgot-password${username ? `?login=${encodeURIComponent(username)}` : ""}`} className="text-ocean hover:underline">
                    Forgot password?
                  </Link>
                </span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={authInput} />
              </label>
            )}
            <button
              type="submit"
              disabled={busy || !username.trim() || !password || (mode === "setup" && !passwordReady(password, confirm, policy?.password))}
              className={authButton}
            >
              {busy ? "…" : mode === "setup" ? "Create administrator and sign in" : "Sign in"}
            </button>
          </form>
        )
      )}
      {mode === "login" && policy && !policy.password_login && (
        <button type="button" onClick={() => setAdminPassword(!adminPassword)} className="mt-3 w-full text-center text-xs text-muted hover:text-white">
          {adminPassword ? "Back to single sign-on" : "Administrator sign-in with a password"}
        </button>
      )}
      {error && <p className="mt-3 text-xs text-bad">{error}</p>}
    </AuthCard>
  );
}
