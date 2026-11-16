"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthCard, authButton, NewPassword, passwordReady } from "@/components/auth/SignIn";
import { auth, type PasswordPolicy } from "@/lib/auth";

const query = (k: string) => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get(k) ?? ""));

/** Choose a new password from a reset link, or after signing in with an expired (or administrator-set) password. */
export default function ResetPasswordPage() {
  const [token] = useState(() => query("token"));
  const [info, setInfo] = useState<{ username: string; kind: "reset" | "expired"; policy: PasswordPolicy } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    auth.resetInfo(token).then(setInfo, (e: Error) => setError(e.message));
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await auth.reset(token, password);
      if (r.user) {
        const n = query("next");
        window.location.replace(n && n.startsWith("/") && !n.startsWith("//") ? n : "/");
        return;
      }
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard subtitle={info?.kind === "expired" ? "Choose a new password to continue" : "Choose a new password"}>
      {!token && <p className="text-sm text-bad">This link is incomplete: open the link from the email again.</p>}
      {done ? (
        <div className="space-y-3 text-sm">
          <p>Your password was changed and you were signed out everywhere. Sign in with the new password.</p>
          <Link href="/login" className={`${authButton} block text-center`}>
            Sign in
          </Link>
        </div>
      ) : (
        info && (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-xs text-muted">
              {info.kind === "expired" ? "Your password must be changed before you continue" : "New password"} for <span className="font-mono text-soft">{info.username}</span>.
            </p>
            <NewPassword policy={info.policy} value={password} confirm={confirm} onChange={setPassword} onConfirm={setConfirm} />
            <button type="submit" disabled={busy || !passwordReady(password, confirm, info.policy)} className={authButton}>
              {busy ? "…" : "Change password"}
            </button>
          </form>
        )
      )}
      {error && (
        <div className="mt-3 space-y-2 text-xs">
          <p className="text-bad">{error}</p>
          <Link href="/forgot-password" className="text-ocean hover:underline">
            Ask for a new link
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
