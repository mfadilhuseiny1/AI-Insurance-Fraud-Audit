"use client";

import { useEffect, useState } from "react";
import { AuthCard, authButton, authInput, Divider, NewPassword, passwordReady, SsoButtons } from "@/components/auth/SignIn";
import { auth, type PasswordPolicy, type SsoProvider } from "@/lib/auth";

/** Accept an invitation: choose your name and password (or sign in with your company account) and you are in. */
export default function AcceptInvitePage() {
  const [token] = useState(() => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("token") ?? "")));
  const [info, setInfo] = useState<{ username: string; email: string; display_name?: string; policy: PasswordPolicy; sso: SsoProvider[] } | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    auth.inviteInfo(token).then(
      (i) => (setInfo(i), setName(i.display_name && i.display_name !== i.username ? i.display_name : "")),
      (e: Error) => setError(e.message),
    );
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.acceptInvite(token, password, name);
      window.location.replace("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <AuthCard subtitle="You are invited to BluesandAI">
      {!token && <p className="text-sm text-bad">This link is incomplete: open the link from the invitation email again.</p>}
      {info && (
        <>
          <p className="mb-3 text-xs text-muted">
            Your account: <span className="font-mono text-soft">{info.username}</span>
            {info.email !== info.username ? ` (${info.email})` : ""}
          </p>
          {info.sso.length > 0 && (
            <>
              <SsoButtons providers={info.sso} />
              <p className="mt-2 text-[11px] text-muted">Sign in with the company account of {info.email} to accept without a password.</p>
              <Divider text="or choose a password" />
            </>
          )}
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-xs">
              <span className="mb-1 block text-muted">Your name</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={authInput} />
            </label>
            <NewPassword policy={info.policy} value={password} confirm={confirm} onChange={setPassword} onConfirm={setConfirm} label="Password" />
            <button type="submit" disabled={busy || !passwordReady(password, confirm, info.policy)} className={authButton}>
              {busy ? "…" : "Create my account"}
            </button>
          </form>
        </>
      )}
      {error && <p className="mt-3 text-xs text-bad">{error}</p>}
    </AuthCard>
  );
}
