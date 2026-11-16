"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard, authButton, authInput } from "@/components/auth/SignIn";
import { auth } from "@/lib/auth";

/** Forgot password: email a reset link to the account with this username or email. */
export default function ForgotPasswordPage() {
  const [login, setLogin] = useState(() => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("login") ?? "")));
  const [sent, setSent] = useState<{ email: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(await auth.forgot(login.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard subtitle="Reset your password">
      {sent ? (
        <div className="space-y-3 text-sm">
          {sent.email ? (
            <p>If an account matches, we emailed it a link to choose a new password. The link works once and for a limited time.</p>
          ) : (
            <p className="text-warn">
              This server cannot send email yet (Resend is not configured). Ask an administrator for a reset link: Control Panel → Users → your account → Send
              password reset link.
            </p>
          )}
          <Link href="/login" className="block text-center text-xs text-ocean hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-muted">Enter your username or email. If the account has an email address, it gets a link to choose a new password.</p>
          <label className="block text-xs">
            <span className="mb-1 block text-muted">Username or email</span>
            <input autoFocus value={login} onChange={(e) => setLogin(e.target.value)} className={authInput} />
          </label>
          <button type="submit" disabled={busy || !login.trim()} className={authButton}>
            {busy ? "…" : "Send reset link"}
          </button>
          <Link href="/login" className="block text-center text-xs text-muted hover:text-white">
            Back to sign in
          </Link>
          {error && <p className="text-xs text-bad">{error}</p>}
        </form>
      )}
    </AuthCard>
  );
}
