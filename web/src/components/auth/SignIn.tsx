"use client";

import { useEffect, useState } from "react";
import { LogoFull } from "@/components/Logo";
import { Icon } from "@/components/Icon";
import { auth, policyHint, policyProblems, type PasswordPolicy, type SsoProvider } from "@/lib/auth";

export const authInput = "w-full rounded-md border border-line-2 bg-ink px-3 py-2 text-sm outline-none focus:border-ocean";
export const authButton = "w-full rounded-md bg-ocean px-3 py-2 text-sm font-medium text-white hover:bg-ocean/90 disabled:opacity-50";

/** The centered card of the sign-in pages (sign in, forgot password, reset, invitation, two-factor setup). */
export function AuthCard({ subtitle, children, wide = false }: { subtitle: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-ink p-6">
      <div className={`w-full ${wide ? "max-w-lg" : "max-w-sm"} rounded-2xl border border-line bg-panel p-6 shadow-xl`}>
        <div className="mb-5">
          <LogoFull height={32} />
          <div className="mt-1.5 text-xs text-muted">{subtitle}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A new password with its confirmation, the policy as a hint, and what is still missing as you type. */
export function NewPassword({
  policy,
  value,
  confirm,
  onChange,
  onConfirm,
  label = "New password",
}: {
  policy?: PasswordPolicy;
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirm: (v: string) => void;
  label?: string;
}) {
  const missing = policyProblems(value, policy);
  return (
    <>
      <label className="block text-xs">
        <span className="mb-1 block text-muted">{label}</span>
        <input type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} className={authInput} />
        {policy && <span className="mt-1 block text-[11px] text-muted">Needs {policyHint(policy)}</span>}
        {value && missing.length > 0 && <span className="mt-0.5 block text-[11px] text-warn">Still needs {missing.join(", ")}</span>}
      </label>
      <label className="block text-xs">
        <span className="mb-1 block text-muted">Confirm password</span>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => onConfirm(e.target.value)} className={authInput} />
        {confirm && confirm !== value && <span className="mt-0.5 block text-[11px] text-warn">The passwords do not match</span>}
      </label>
    </>
  );
}

export const passwordReady = (pw: string, confirm: string, policy?: PasswordPolicy) => !!pw && pw === confirm && policyProblems(pw, policy).length === 0;

const SSO_ICON: Record<string, string> = { google: "G", microsoft: "⊞", okta: "◯" };

/** One button per configured single sign-on provider (they sign in through the API and come back to `next`). */
export function SsoButtons({ providers, next = "/" }: { providers: SsoProvider[]; next?: string }) {
  if (!providers.length) return null;
  return (
    <div className="space-y-2">
      {providers.map((p) => (
        <a
          key={p.id}
          href={`${p.start}?next=${encodeURIComponent(next)}`}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-sm hover:border-ocean hover:text-white"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded bg-ink text-xs font-bold text-soft">{SSO_ICON[p.id] ?? "↪"}</span>
          Continue with {p.name}
        </a>
      ))}
    </div>
  );
}

export function Divider({ text }: { text: string }) {
  return (
    <div className="my-4 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
      <span className="h-px flex-1 bg-line" /> {text} <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Recovery codes shown once, with copy and download. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs">
      <p className="mb-2 text-warn">Save these recovery codes now: each signs you in once if you lose your phone. They are not shown again.</p>
      <div className="grid grid-cols-2 gap-1 font-mono text-sm text-white">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => navigator.clipboard?.writeText(text)} className="rounded border border-line-2 px-2 py-0.5 hover:text-white">
          Copy
        </button>
        <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(`BluesandAI recovery codes\n\n${text}\n`)}`} download="bluesandai-recovery-codes.txt" className="rounded border border-line-2 px-2 py-0.5 hover:text-white">
          Download
        </a>
      </div>
    </div>
  );
}

/**
 * Set up an authenticator app: scan the QR code (or type the key), confirm with a code, then save the recovery codes.
 * `onDone` runs after the recovery codes were acknowledged.
 */
export function MfaSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string; qr_svg: string | null } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    auth.mfaSetup().then(setSetup, (e: Error) => setError(e.message));
  }, []);
  if (codes)
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-1.5 text-sm text-ok">
          <Icon name="check" className="h-4 w-4" /> Two-factor authentication is on.
        </p>
        <RecoveryCodes codes={codes} />
        <button type="button" onClick={onDone} className={authButton}>
          I saved my recovery codes
        </button>
      </div>
    );
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCodes((await auth.mfaEnable(code)).recovery_codes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={confirm} className="space-y-3 text-sm">
      <p className="text-xs text-muted">
        1. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy …) and scan this code, or enter the key by hand.
      </p>
      {!setup && !error && <p className="text-xs text-muted">Loading…</p>}
      {setup && (
        <div className="flex flex-col items-center gap-2">
          {setup.qr_svg ? (
            // the API renders the QR code as SVG (no external service sees the secret)
            <div className="rounded-lg bg-white p-2 [&_svg]:h-44 [&_svg]:w-44" dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
          ) : (
            <a href={setup.otpauth_uri} className="text-xs text-ocean hover:underline">
              Open in an authenticator app on this device
            </a>
          )}
          <code className="select-all rounded bg-ink px-2 py-1 text-xs tracking-wider text-soft">{setup.secret}</code>
        </div>
      )}
      <label className="block text-xs">
        <span className="mb-1 block text-muted">2. Enter the 6-digit code the app shows</span>
        <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" className={`${authInput} text-center tracking-[0.3em]`} />
      </label>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="flex gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="flex-1 rounded-md border border-line-2 px-3 py-2 text-sm hover:text-white">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6 || !setup} className={`${authButton} flex-1`}>
          {busy ? "…" : "Turn on two-factor"}
        </button>
      </div>
    </form>
  );
}
