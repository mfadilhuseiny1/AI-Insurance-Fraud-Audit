"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { MarkingChip } from "@/components/auth/parts";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { MfaSetup, RecoveryCodes } from "@/components/auth/SignIn";
import { devConsole, type MyGrant } from "@/lib/developerConsole";
import { auth, policyHint, policyProblems, type ApiToken, type Me, type PasswordPolicy, type Session } from "@/lib/auth";

/** Account settings: profile, password, two-factor authentication, where you are signed in, API tokens, and your groups and markings. */
export default function AccountPage() {
  const { refresh } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    auth.me().then(setMe, (e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="p-8 text-sm text-bad">{error}</p>;
  if (!me) return <p className="p-8 text-sm text-muted">Loading…</p>;
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-8">
        <h1 className="text-xl font-semibold">Account settings</h1>
        <div className="grid gap-4 lg:grid-cols-2">
          <Profile me={me} onSaved={(m) => (setMe(m), refresh())} />
          <Access me={me} />
          <Password me={me} />
          <TwoFactor me={me} onChange={() => auth.me().then(setMe)} />
          <Sessions />
          <NotificationSettings />
        </div>
        <div id="api-tokens" className="scroll-mt-6"><Tokens /></div>
        <div id="applications" className="scroll-mt-6"><ConnectedApps /></div>
      </div>
    </div>
  );
}

/** The applications (Developer Console) you granted access to: what each reaches, and revoking your grant. */
function ConnectedApps() {
  const [apps, setApps] = useState<MyGrant[] | null>(null);
  const load = useCallback(() => {
    devConsole.myGrants().then(setApps, () => setApps([]));
  }, []);
  useEffect(load, [load]);
  const revoke = async (a: MyGrant) => {
    if (!(await confirmDialog({ title: "Revoke access", message: `"${a.name}" is signed out of your account: it has to ask for your consent again.`, confirmLabel: "Revoke", danger: true }))) return;
    devConsole.revokeMyGrant(a.app_id).then(load, (e: Error) => alertDialog(e.message));
  };
  return (
    <Card title="Applications with access to your account" icon="plug">
      <p className="mb-3 text-xs text-muted">Applications you signed in to and granted. Each acts as you, within the resources listed and your own permissions.</p>
      {!apps ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : !apps.length ? (
        <p className="text-xs text-muted" data-no-grants>No application has access to your account.</p>
      ) : (
        <div className="space-y-2" data-my-grants>
          {apps.map((a) => (
            <div key={a.app_id} className="flex items-start gap-3 rounded-lg border border-line p-3 text-xs" data-grant={a.app_id}>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-soft">
                  {a.name} <span className="font-normal text-muted">· {a.kind === "backend" ? "backend application" : "client application"}</span>
                </div>
                {a.description && <div className="text-muted">{a.description}</div>}
                <div className="mt-1 text-muted">
                  Reads: {a.object_types.join(", ") || "no object types"} · actions: {a.action_types.join(", ") || "none"} · {a.functions} function{a.functions === 1 ? "" : "s"}
                </div>
                <div className="text-muted">
                  {a.last_issued ? `Last token ${when(a.last_issued)}` : "Granted"} · access until {when(a.expires)}
                </div>
              </div>
              <button type="button" onClick={() => revoke(a)} className={buttonClass.secondary} data-revoke-grant>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Per source: notifications in the app and by email (a source left on "default" follows what the sender asks). */
function NotificationSettings() {
  const [data, setData] = useState<{ sources: { id: string; label: string }[]; settings: Record<string, { web?: boolean; email?: boolean }> } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    auth.notificationSettings().then(setData, (e: Error) => setMsg(e.message));
  }, []);
  if (!data) return null;
  const set = (id: string, k: "web" | "email", v: string) => {
    const cur = { ...(data.settings[id] ?? {}) };
    if (v === "default") delete cur[k];
    else cur[k] = v === "on";
    const next = { ...data.settings, [id]: cur };
    if (!Object.keys(cur).length) delete next[id];
    auth.setNotificationSettings(next).then((r) => (setData(r), setMsg("Saved")), (e: Error) => setMsg(e.message));
  };
  const val = (id: string, k: "web" | "email") => (data.settings[id]?.[k] === undefined ? "default" : data.settings[id]![k] ? "on" : "off");
  return (
    <Card title="Notifications" icon="bell">
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr>
            <th className="pb-1">From</th>
            <th className="pb-1">In the app</th>
            <th className="pb-1">Email</th>
          </tr>
        </thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.id}>
              <td className="py-0.5 pr-2">{s.label}</td>
              {(["web", "email"] as const).map((k) => (
                <td key={k} className="py-0.5">
                  <select value={val(s.id, k)} onChange={(e) => set(s.id, k, e.target.value)} className="rounded border border-line-2 bg-ink px-1 py-0.5">
                    <option value="default">Default</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </Card>
  );
}

function Card({ title, icon, children }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4 text-sm">
      <h2 className="mb-3 flex items-center gap-1.5 font-medium">
        <Icon name={icon} className="h-4 w-4 text-ocean" /> {title}
      </h2>
      {children}
    </section>
  );
}

function Profile({ me, onSaved }: { me: Me; onSaved: (m: Me) => void }) {
  const [form, setForm] = useState({ display_name: me.display_name ?? "", first_name: me.first_name ?? "", last_name: me.last_name ?? "", email: me.email ?? "" });
  const [msg, setMsg] = useState<string | null>(null);
  const save = () => auth.updateMe(form).then((m) => (onSaved(m), setMsg("Saved")), (e: Error) => setMsg(e.message));
  return (
    <Card title="Profile" icon="info">
      <div className="space-y-2">
        <div className="text-xs text-muted">
          Username <span className="font-mono text-soft">{me.username}</span> · {me.role === "admin" ? "Administrator" : "User"}
        </div>
        <Field label="Display name">
          <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="First name">
            <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Last name">
            <input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} className={inputClass} />
          </Field>
        </div>
        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} />
        </Field>
        <div className="flex items-center gap-2">
          <button type="button" onClick={save} className={buttonClass.primary}>
            Save
          </button>
          {msg && <span className="text-xs text-muted">{msg}</span>}
        </div>
      </div>
    </Card>
  );
}

function Access({ me }: { me: Me }) {
  return (
    <Card title="Organization, groups and markings" icon="project">
      <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-xs">
        <dt className="text-muted">Organization</dt>
        <dd>{me.organization ?? "—"}</dd>
        <dt className="text-muted">Groups</dt>
        <dd>{me.groups.length ? me.groups.map((g) => g.name).join(", ") : "—"}</dd>
        <dt className="text-muted">Markings</dt>
        <dd className="flex flex-wrap gap-1">{me.markings.length ? me.markings.map((m) => <MarkingChip key={m.id} m={m} />) : "—"}</dd>
      </dl>
      <p className="mt-3 text-xs text-muted">
        You can open data only if you hold every marking on it. Markings come from your account, your groups and your organization; an administrator grants them in
        Control Panel.
      </p>
    </Card>
  );
}

function Password({ me }: { me: Me }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PasswordPolicy | undefined>();
  useEffect(() => {
    auth.policy().then((p) => setPolicy(p.password), () => {});
  }, []);
  const missing = policyProblems(next, policy);
  if (me.has_password === false)
    return (
      <Card title="Password" icon="eye">
        <p className="text-xs text-muted">
          You sign in with {(me.identities ?? []).map((i) => i.provider).join(", ") || "single sign-on"}: your account has no password here. Your identity provider
          manages your password and two-step verification.
        </p>
      </Card>
    );
  const save = () => {
    if (next !== confirm) return setMsg("The new passwords do not match");
    auth.changePassword(cur, next).then(
      () => {
        setCur("");
        setNext("");
        setConfirm("");
        setMsg("Password changed; your other sessions were signed out");
      },
      (e: Error) => setMsg(e.message),
    );
  };
  return (
    <Card title="Password" icon="eye">
      <div className="space-y-2">
        <Field label="Current password">
          <input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} className={inputClass} />
        </Field>
        <Field label="New password" hint={policy ? `Needs ${policyHint(policy)}` : undefined}>
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} />
        </Field>
        {next && missing.length > 0 && <p className="text-[11px] text-warn">Still needs {missing.join(", ")}</p>}
        <Field label="Confirm new password">
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} />
        </Field>
        <div className="flex items-center gap-2">
          <button type="button" disabled={!cur || !next || missing.length > 0} onClick={save} className={buttonClass.primary}>
            Change password
          </button>
          {msg && <span className="text-xs text-muted">{msg}</span>}
        </div>
        {me.password_changed_at && <p className="text-[11px] text-muted">Last changed {when(me.password_changed_at)}.</p>}
        {(me.identities ?? []).length > 0 && (
          <p className="text-[11px] text-muted">Also linked to single sign-on: {(me.identities ?? []).map((i) => `${i.provider}${i.email ? ` (${i.email})` : ""}`).join(", ")}.</p>
        )}
      </div>
    </Card>
  );
}

/** Two-factor authentication with an authenticator app: set up, new recovery codes, turn off (unless required). */
function TwoFactor({ me, onChange }: { me: Me; onChange: () => void }) {
  const [state, setState] = useState<{ enabled: boolean; required: boolean; recovery_codes_left: number } | null>(null);
  const [mode, setMode] = useState<"idle" | "setup" | "disable" | "codes">("idle");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => auth.mfa().then(setState, () => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  const finish = () => (setMode("idle"), setCode(""), load(), onChange());
  if (me.has_password === false && !state?.enabled)
    return (
      <Card title="Two-factor authentication" icon="alert">
        <p className="text-xs text-muted">Your identity provider (single sign-on) asks for your second factor.</p>
      </Card>
    );
  return (
    <Card title="Two-factor authentication" icon="alert">
      {!state ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : mode === "setup" ? (
        <MfaSetup onDone={finish} onCancel={() => setMode("idle")} />
      ) : (
        <div className="space-y-2 text-xs">
          <p>
            {state.enabled ? (
              <span className="text-ok">On</span>
            ) : (
              <span className={state.required ? "text-warn" : "text-muted"}>Off{state.required ? " — required for your account" : ""}</span>
            )}
            {state.enabled && ` · ${state.recovery_codes_left} recovery code${state.recovery_codes_left === 1 ? "" : "s"} left`}
          </p>
          <p className="text-muted">Sign-in asks for a code from an authenticator app on your phone, so a stolen password alone is not enough.</p>
          {codes && <RecoveryCodes codes={codes} />}
          {(mode === "disable" || mode === "codes") && (
            <div className="flex items-end gap-2">
              <Field label="Current code from your app">
                <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} className={`${inputClass} w-32`} />
              </Field>
              <button
                type="button"
                disabled={code.replace(/\D/g, "").length !== 6}
                onClick={() =>
                  (mode === "disable" ? auth.mfaDisable(code).then(() => (setCodes(null), finish())) : auth.mfaRecovery(code).then((r) => (setCodes(r.recovery_codes), finish()))).catch(
                    (e: Error) => setMsg(e.message),
                  )
                }
                className={`${buttonClass.primary} mb-0.5`}
              >
                {mode === "disable" ? "Turn off" : "New codes"}
              </button>
              <button type="button" onClick={() => (setMode("idle"), setCode(""))} className={`${buttonClass.secondary} mb-0.5`}>
                Cancel
              </button>
            </div>
          )}
          {mode === "idle" && (
            <div className="flex gap-2">
              {!state.enabled ? (
                <button type="button" onClick={() => (setCodes(null), setMode("setup"))} className={buttonClass.primary}>
                  Set up authenticator app
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => setMode("codes")} className={buttonClass.secondary}>
                    New recovery codes
                  </button>
                  {!state.required && (
                    <button type="button" onClick={() => setMode("disable")} className={buttonClass.secondary}>
                      Turn off
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {msg && <p className="text-bad">{msg}</p>}
        </div>
      )}
    </Card>
  );
}

function Sessions() {
  const [list, setList] = useState<Session[] | null>(null);
  const load = useCallback(() => auth.sessions().then(setList, () => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Card title="Where you are signed in" icon="device">
      {!list ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{browserName(s.agent)}</span>
                <span className="text-muted">
                  since {when(s.created_at)} · until {when(s.expires_at)}
                </span>
              </span>
              {s.current ? (
                <span className="rounded-full bg-ok/15 px-2 py-0.5 text-ok">This browser</span>
              ) : (
                <button type="button" onClick={() => auth.revokeSession(s.id).then(load, (e: Error) => alertDialog(e.message))} className="text-bad hover:underline">
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const browserName = (agent: string) => {
  const b = /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const os = /Windows/.test(agent) ? "Windows" : /Mac OS/.test(agent) ? "macOS" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Linux/.test(agent) ? "Linux" : "";
  return `${b}${os ? ` on ${os}` : ""}`;
};

function Tokens() {
  const [list, setList] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<ApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => auth.tokens().then(setList, () => setList([])), []);
  // the clipboard API exists only on secure origins (https, localhost): elsewhere the token is selected for Ctrl+C
  const copy = (code: HTMLElement | null, token: string) => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(token).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
    } else if (code) {
      window.getSelection()?.selectAllChildren(code);
    }
  };
  useEffect(() => {
    load();
  }, [load]);
  const create = () =>
    auth.createToken(name.trim(), Number(days) || undefined, description.trim()).then(
      (t) => {
        setCreated(t);
        setName("");
        setDescription("");
        load();
      },
      (e: Error) => alertDialog(e.message),
    );
  const remove = async (t: ApiToken) => {
    if (!(await confirmDialog({ title: "Delete API token", message: `Scripts using "${t.name}" stop working.`, confirmLabel: "Delete", danger: true }))) return;
    auth.deleteToken(t.id).then(load, (e: Error) => alertDialog(e.message));
  };
  return (
    <Card title="API tokens" icon="code">
      <p className="mb-3 text-xs text-muted">
        For scripts and tools calling the API as you: send <code className="text-soft">Authorization: Bearer &lt;token&gt;</code>. A token has your access, markings
        included.
      </p>
      {created?.token && (
        <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs">
          <div className="mb-1 text-warn">Copy the token now: it is not shown again.</div>
          <div className="flex items-start gap-2 rounded bg-ink px-2 py-1">
            <code className="min-w-0 flex-1 break-all">{created.token}</code>
            <button
              type="button"
              title={copied ? "Copied" : "Copy token"}
              aria-label="Copy token"
              onClick={(e) => copy(e.currentTarget.previousElementSibling as HTMLElement | null, created.token!)}
              className={`shrink-0 ${copied ? "text-ok" : "text-muted hover:text-white"}`}
            >
              <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      <div className="mb-3 flex items-end gap-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly export script" className={inputClass} />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What uses it" className={inputClass} />
        </Field>
        <Field label="Expires after (days)">
          <input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className={`${inputClass} w-28`} />
        </Field>
        <button type="button" disabled={!name.trim()} onClick={create} className={`${buttonClass.primary} mb-0.5`}>
          Create token
        </button>
      </div>
      <table className="w-full text-xs">
        <tbody>
          {(list ?? []).map((t) => (
            <tr key={t.id} className="border-t border-line">
              <td className="py-1.5">
                <span className={t.disabled ? "text-muted line-through" : ""}>{t.name}</span>
                {t.description && <span className="block text-[11px] text-muted">{t.description}</span>}
              </td>
              <td className="font-mono text-muted">{t.prefix}…</td>
              <td className="text-muted">created {when(t.created_at)}</td>
              <td className="text-muted">{t.last_used_at ? `used ${when(t.last_used_at)}` : "never used"}</td>
              <td className="text-muted">{t.expires_at ? `expires ${when(t.expires_at)}` : "no expiry"}</td>
              <td className="text-right">
                <button type="button" onClick={() => auth.updateToken(t.id, { disabled: !t.disabled }).then(load, (e: Error) => alertDialog(e.message))} className="mr-2 text-ocean hover:underline">
                  {t.disabled ? "Enable" : "Disable"}
                </button>
                <button type="button" onClick={() => remove(t)} className="text-muted hover:text-bad" title="Revoke for good">
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
          {list?.length === 0 && (
            <tr>
              <td className="py-2 text-muted">No tokens.</td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
