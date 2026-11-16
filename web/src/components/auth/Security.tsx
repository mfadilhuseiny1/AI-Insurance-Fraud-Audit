"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { auth, type SecuritySettings, type SsoProvider } from "@/lib/auth";
import { API_URL } from "@/lib/api";

/** SCIM 2.0 provisioning: the endpoint and its bearer token for the identity provider (api/scim.py). */
function ScimPanel() {
  const [info, setInfo] = useState<{ base_url: string; token: { created_at: string; prefix: string } | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const call = (method = "GET", path = "") =>
    fetch(`${API_URL}/api/auth/scim${path}`, { method, credentials: "include" }).then(async (r) => {
      const b = await r.json();
      if (!r.ok) throw new Error(b.detail ?? r.statusText);
      return b;
    });
  useEffect(() => {
    call().then(setInfo, (e: Error) => setErr(e.message));
  }, []);
  if (!info) return err ? <p className="mt-4 text-xs text-bad">{err}</p> : null;
  return (
    <section className="mt-4 rounded-xl border border-line bg-panel p-4 text-sm">
      <h2 className="mb-2 font-medium">SCIM provisioning</h2>
      <p className="text-xs text-muted">
        Let the identity provider create, update and deactivate users and groups. Base URL: <code className="text-soft">{info.base_url}</code>
      </p>
      <p className="mt-1 text-xs text-muted">{info.token ? `Token ${info.token.prefix}… created ${info.token.created_at.slice(0, 10)}` : "No token yet."}</p>
      {token && <code className="mt-2 block break-all rounded bg-ink px-2 py-1 text-xs">{token}</code>}
      {token && <p className="text-xs text-warn">Copy it now: it is not shown again.</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" className={buttonClass.secondary} onClick={() => call("POST", "/token").then((r) => (setToken(r.secret), setInfo(r)), (e: Error) => setErr(e.message))}>
          {info.token ? "Replace token" : "Generate token"}
        </button>
        {info.token && (
          <button type="button" className={buttonClass.secondary} onClick={() => call("DELETE", "/token").then((r) => (setToken(null), setInfo(r)), (e: Error) => setErr(e.message))}>
            Revoke
          </button>
        )}
      </div>
      {err && <p className="mt-1 text-xs text-bad">{err}</p>}
    </section>
  );
}

type Info = {
  settings: SecuritySettings;
  defaults: SecuritySettings;
  store: string;
  email: boolean;
  email_provider?: "resend" | "smtp" | null;
  email_from?: string;
  sso: SsoProvider[];
  web_url: string;
};

/**
 * Control Panel → Security: password policy, sessions and idle timeout, two-factor requirement, sign-in attempt limits,
 * invitation and reset links, single sign-on, and the role everyone gets on new Projects.
 */
export function SecurityAdmin() {
  const [info, setInfo] = useState<Info | null>(null);
  const [form, setForm] = useState<SecuritySettings | null>(null);
  const [domains, setDomains] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    auth.groups().then(setGroups, () => setGroups([]));
    auth.settings().then(
      (i) => (setInfo(i), setForm(i.settings), setDomains(i.settings.sso_allowed_domains.join(", "))),
      (e: Error) => setMsg({ ok: false, text: e.message }),
    );
  }, []);
  if (!info || !form) return msg ? <p className="text-sm text-bad">{msg.text}</p> : <p className="text-sm text-muted">Loading…</p>;
  const set = <K extends keyof SecuritySettings>(k: K, v: SecuritySettings[K]) => setForm({ ...form, [k]: v });
  const num = (k: keyof SecuritySettings, label: string, hint?: string, suffix?: string) => (
    <Field label={label} hint={hint}>
      <span className="flex items-center gap-1.5">
        <input type="number" value={form[k] as number} onChange={(e) => set(k, Number(e.target.value) as never)} className={`${inputClass} w-28`} />
        {suffix && <span className="text-xs text-muted">{suffix}</span>}
      </span>
    </Field>
  );
  const check = (k: keyof SecuritySettings, label: string) => (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={form[k] as boolean} onChange={(e) => set(k, e.target.checked as never)} className="accent-[var(--color-ocean)]" /> {label}
    </label>
  );
  const save = () =>
    auth
      .saveSettings({ ...form, sso_allowed_domains: domains.split(/[\s,]+/).filter(Boolean) })
      .then((i) => (setInfo(i), setForm(i.settings), setMsg({ ok: true, text: "Saved" })), (e: Error) => setMsg({ ok: false, text: e.message }));
  const section = "rounded-xl border border-line bg-panel p-4";
  return (
    <div>
      <h1 className="text-xl font-semibold">Security</h1>
      <p className="mb-5 mt-1 text-sm text-muted">
        How people sign in and how long they stay signed in. Sign-in data is stored in {info.store === "postgres" ? "PostgreSQL (schema bsai_auth)" : "SQLite (data/auth/auth.sqlite)"}; email
        is{" "}
        {info.email_provider === "resend" ? (
          <>sent with Resend (from {info.email_from})</>
        ) : info.email_provider === "smtp" ? (
          <>sent over SMTP (from {info.email_from})</>
        ) : (
          <span className="text-warn">not configured (RESEND_API_KEY and RESEND_FROM in .env.local): reset and invitation links are shown to administrators instead</span>
        )}
        .
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={section}>
          <h2 className="mb-3 font-medium">Password policy</h2>
          <div className="space-y-3">
            {num("password_min_length", "Minimum length", undefined, "characters")}
            <div className="grid grid-cols-2 gap-1.5">
              {check("password_require_upper", "An upper-case letter")}
              {check("password_require_lower", "A lower-case letter")}
              {check("password_require_digit", "A digit")}
              {check("password_require_symbol", "A symbol")}
            </div>
            {check("password_block_common", "Refuse common passwords and ones containing the username")}
            {num("password_history", "No reuse of the last", "0 allows reuse.", "passwords")}
            {num("password_max_age_days", "Passwords expire after", "0: never. An expired password must be changed at the next sign-in.", "days")}
          </div>
        </section>
        <section className={section}>
          <h2 className="mb-3 font-medium">Sessions</h2>
          <div className="space-y-3">
            {num("idle_timeout_minutes", "Sign out after inactivity", "0: never. Page interaction or changes count as activity; a warning shows a minute before.", "minutes")}
            {num("session_days", "Sessions last at most", "Renewed while used, up to this long since the last activity.", "days")}
            {num("inactive_days", "Users are inactive after", "Days without signing in; inactive users' API and application tokens stop working until they sign in again (schedules keep running). 0: never.", "days")}
          </div>
          <h2 className="mb-3 mt-5 font-medium">Two-factor authentication</h2>
          <div className="space-y-1.5">
            {check("mfa_required_admins", "Required for administrators")}
            {check("mfa_required_all", "Required for everyone")}
            <p className="text-[11px] text-muted">
              People without it are asked to set up an authenticator app at their next sign-in. Single sign-on users get their second factor from the identity provider.
            </p>
          </div>
        </section>
        <section className={section}>
          <h2 className="mb-3 font-medium">Sign-in attempts</h2>
          <div className="grid grid-cols-2 gap-3">
            {num("login_max_per_user", "Failures per username")}
            {num("login_max_per_ip", "Failures per IP address")}
            {num("login_window_minutes", "Within", undefined, "minutes")}
          </div>
          <p className="mt-2 text-[11px] text-muted">More failures than this block further attempts until the window passes (also for reset links, invitations and two-factor codes).</p>
          <h2 className="mb-3 mt-5 font-medium">Links</h2>
          <div className="grid grid-cols-2 gap-3">
            {num("invite_days", "Invitations work for", undefined, "days")}
            {num("reset_minutes", "Reset links work for", undefined, "minutes")}
          </div>
          <p className="mt-2 text-[11px] text-muted">Links point to {info.web_url} (BLUESANDAI_WEB_URL).</p>
        </section>
        <section className={section}>
          <h2 className="mb-3 font-medium">Single sign-on</h2>
          <p className="mb-2 text-xs text-muted">
            Providers come from .env.local (see .env.example):{" "}
            {info.sso.length ? <span className="text-soft">{info.sso.map((p) => p.name).join(", ")}</span> : <span className="text-warn">none configured</span>}.
          </p>
          <div className="space-y-3">
            {check("sso_auto_create", "Create accounts on first sign-in")}
            <Field label="Only for these email domains" hint="Comma separated; empty: any domain. Without automatic accounts, invite people first (their email links the account).">
              <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, example.co.id" className={inputClass} />
            </Field>
            <Field label="Role of new accounts">
              <select value={form.sso_default_role} onChange={(e) => set("sso_default_role", e.target.value as "user" | "admin")} className={`${inputClass} w-40`}>
                <option value="user">User</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
            <Field label="Identity provider attributes copied to users" hint="Claims or SAML attributes (comma separated), refreshed at each single sign-on; row policies compare them as user attributes.">
              <input
                value={(form.sso_attribute_claims ?? []).join(", ")}
                onChange={(e) => set("sso_attribute_claims", e.target.value.split(/[\s,]+/).filter(Boolean))}
                placeholder="department, region, clearance"
                className={inputClass}
              />
            </Field>
            {check("password_login", "Allow password sign-in (off: single sign-on only; administrators can still use a password)")}
          </div>
          <h2 className="mb-3 mt-5 font-medium">Projects</h2>
          <Field label="Everyone's role on a new Project" hint="Its creator is always an Owner. Owners change roles in Files → the Project → Roles.">
            <select value={form.project_default_role} onChange={(e) => set("project_default_role", e.target.value as SecuritySettings["project_default_role"])} className={`${inputClass} w-40`}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="discoverer">Discoverer (sees it exists)</option>
              <option value="none">None (private)</option>
            </select>
          </Field>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.require_project_classification} onChange={(e) => set("require_project_classification", e.target.checked)} />
            Require a classification on every new Project (classification-based access controls: a marking of a hierarchical category)
          </label>
          <Field label="Files outside any Project" hint="Items at the top level of Files, not in a Project. Items whose creator is unknown are administrators' only.">
            <select value={form.files_outside_projects} onChange={(e) => set("files_outside_projects", e.target.value as SecuritySettings["files_outside_projects"])} className={`${inputClass} w-72`}>
              <option value="creator">Private to their creator (and administrators)</option>
              <option value="everyone">Open to every signed-in user</option>
            </select>
          </Field>
          <h2 className="mb-3 mt-5 font-medium">Code execution</h2>
          <Field
            label="Who may author or run code on this machine"
            hint="Code Repositories, Code Workbooks, Code Workspaces (terminals and local kernels), function previews and packages run on the API host, outside any container: whoever runs code there can read everything the platform stores."
          >
            <select value={form.code_execution} onChange={(e) => set("code_execution", e.target.value as SecuritySettings["code_execution"])} className={`${inputClass} w-64`}>
              <option value="admins">Administrators only</option>
              <option value="groups">Administrators and these groups</option>
              <option value="everyone">Everyone (trusted users only)</option>
            </select>
          </Field>
          {form.code_execution === "groups" && (
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {groups.length === 0 && <span className="text-muted">No groups yet (Control Panel → Groups).</span>}
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={form.code_execution_groups.includes(g.id)}
                    onChange={(e) =>
                      set("code_execution_groups", e.target.checked ? [...form.code_execution_groups, g.id] : form.code_execution_groups.filter((x) => x !== g.id))
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
          )}
        </section>
      </div>
      <ScimPanel />
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={save} className={buttonClass.primary}>
          <Icon name="save" /> Save security settings
        </button>
        <button type="button" onClick={() => (setForm(info.defaults), setDomains(info.defaults.sso_allowed_domains.join(", ")))} className={buttonClass.secondary}>
          Defaults
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
