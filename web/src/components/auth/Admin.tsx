"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { AUDIT_LABEL, auth, type AuditEntry, type Group, type GroupContact, type Marking, type MarkingRef, type Organization, type User } from "@/lib/auth";
import { Icon } from "../Icon";
import { buttonClass, fieldClass, inputClass, Modal } from "../pipeline/Modal";
import { Field } from "../pipeline/ui";
import { MarkingCategories, PrincipalList, usePeople } from "./GovernanceAdmin";
import { MarkingChip } from "./parts";

/** Users, groups, organizations and markings, loaded together (each screen needs the others' names). */
function useDirectory() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    auth.users().then(setUsers, (e: Error) => setError(e.message));
    auth.groups().then(setGroups, () => {});
    auth.organizations().then(setOrgs, () => {});
    auth.markings().then(setMarkings, () => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const markingRef = useCallback(
    (id: string): MarkingRef => {
      const o = orgs.find((x) => x.marking === id);
      if (o) return { id, name: o.name, color: o.color, kind: "organization" };
      const m = markings.find((x) => x.id === id);
      return { id, name: m?.name ?? id, color: m?.color, kind: "marking" };
    },
    [orgs, markings],
  );
  return { users, groups, orgs, markings, error, load, markingRef };
}

function Header({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{text}</p>
      </div>
      <div className="shrink-0 whitespace-nowrap">{action}</div>
    </div>
  );
}

function Checklist<T extends { id: string }>({ items, value, label, onChange }: { items: T[]; value: string[]; label: (t: T) => React.ReactNode; onChange: (v: string[]) => void }) {
  if (!items.length) return <p className="text-xs text-muted">None yet.</p>;
  const ids = items.map((t) => t.id);
  const picked = ids.filter((id) => value.includes(id)).length;
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line p-2">
      {/* every item at once (ticked: all; dash: some); ids outside this list are kept */}
      <label className="sticky -top-2 z-10 -mx-2 -mt-2 flex items-center gap-2 border-b border-line bg-panel px-2 py-1 text-xs text-muted">
        <input
          type="checkbox"
          checked={picked === ids.length}
          ref={(e) => {
            if (e) e.indeterminate = picked > 0 && picked < ids.length;
          }}
          onChange={() => onChange(picked === ids.length ? value.filter((x) => !ids.includes(x)) : [...new Set([...value, ...ids])])}
          className="accent-[var(--color-ocean)]"
          data-select-all
        />
        Select all ({picked}/{ids.length})
      </label>
      {items.map((t) => (
        <label key={t.id} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={value.includes(t.id)}
            onChange={() => onChange(value.includes(t.id) ? value.filter((x) => x !== t.id) : [...value, t.id])}
            className="accent-[var(--color-ocean)]"
          />
          {label(t)}
        </label>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- users

export function UsersAdmin() {
  const dir = useDirectory();
  const [q, setQ] = useState("");
  const [org, setOrg] = useState("");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [inviting, setInviting] = useState(false);
  const shown = (dir.users ?? []).filter((u) => {
    const text = `${u.username} ${u.display_name} ${u.first_name} ${u.last_name} ${u.email}`.toLowerCase();
    return (!q || text.includes(q.toLowerCase())) && (!org || u.organization_id === org) && (!group || u.groups.includes(group)) && (!status || u.status === status);
  });
  const orgName = (id: string | null) => dir.orgs.find((o) => o.id === id)?.name ?? "—";
  return (
    <div>
      <Header
        title="Users"
        text="Everyone who can sign in: their organization, groups, role and the markings they hold. Invite people by email to let them choose their own password; deactivating a user signs them out everywhere."
        action={
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing("new")} className={buttonClass.secondary}>
              <Icon name="plus" /> New user
            </button>
            <button type="button" onClick={() => setInviting(true)} className={buttonClass.primary}>
              <Icon name="comment" /> Invite by email
            </button>
          </div>
        }
      />
      {dir.error && <p className="mb-3 text-sm text-bad">{dir.error}</p>}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, username or email" className={`${fieldClass} w-64`} />
        <select value={org} onChange={(e) => setOrg(e.target.value)} className={fieldClass}>
          <option value="">All organizations</option>
          {dir.orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <select value={group} onChange={(e) => setGroup(e.target.value)} className={fieldClass}>
          <option value="">All groups</option>
          {dir.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={fieldClass}>
          <option value="">Active and deactivated</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="deactivated">Deactivated</option>
        </select>
      </div>
      <table className="w-full rounded-xl border border-line bg-panel text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            <th className="px-3 py-2">User</th>
            <th className="px-3 py-2">Organization</th>
            <th className="px-3 py-2">Groups</th>
            <th className="px-3 py-2">Markings</th>
            <th className="px-3 py-2">Role</th>
            <th className="px-3 py-2">Last sign-in</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((u) => (
            <tr key={u.id} onClick={() => setEditing(u)} className={`cursor-pointer border-b border-line last:border-0 hover:bg-panel-2 ${u.disabled ? "opacity-50" : ""}`}>
              <td className="px-3 py-2">
                <div>{u.display_name}</div>
                <div className="text-xs text-muted">
                  {u.username}
                  {u.email ? ` · ${u.email}` : ""}
                  {u.disabled ? " · deactivated" : ""}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {u.status === "invited" && <span className="rounded-full bg-warn/15 px-1.5 text-[10px] text-warn">invited</span>}
                  {u.mfa_enabled && <span className="rounded-full bg-ok/15 px-1.5 text-[10px] text-ok">2FA</span>}
                  {(u.identities ?? []).map((i) => (
                    <span key={i.provider} className="rounded-full bg-panel-2 px-1.5 text-[10px] text-soft">
                      {i.provider}
                    </span>
                  ))}
                  {u.must_change_password && <span className="rounded-full bg-panel-2 px-1.5 text-[10px] text-muted">must change password</span>}
                  {u.inactive && (
                    <span className="rounded-full bg-warn/15 px-1.5 text-[10px] text-warn" title="Not signed in for a while: API and application tokens are off until they sign in">
                      inactive
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 text-xs">{orgName(u.organization_id)}</td>
              <td className="px-3 py-2 text-xs">{u.groups.map((g) => dir.groups.find((x) => x.id === g)?.name ?? g).join(", ") || "—"}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {(u.effective_markings ?? u.markings).map((m) => (
                    <MarkingChip key={m} m={dir.markingRef(m)} title={u.markings.includes(m) ? "Granted to the user" : "Through a group or the organization"} />
                  ))}
                </div>
              </td>
              <td className="px-3 py-2 text-xs">{u.role === "admin" ? "Administrator" : "User"}</td>
              <td className="px-3 py-2 text-xs text-muted">{u.last_login_at ? when(u.last_login_at) : "never"}</td>
            </tr>
          ))}
          {dir.users && shown.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted">
                No users match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {editing && <UserDialog user={editing === "new" ? null : editing} dir={dir} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), dir.load())} />}
      {inviting && <InviteDialog dir={dir} onClose={() => setInviting(false)} onDone={() => dir.load()} />}
    </div>
  );
}

/** A link to pass on when email is not configured (or as a copy). */
async function showLink(title: string, r: { link: string; emailed: boolean }) {
  await alertDialog({
    title,
    message: r.emailed
      ? `Emailed. The link, in case it is needed elsewhere:\n\n${r.link}`
      : `Email is not configured (RESEND_API_KEY and RESEND_FROM), so nothing was sent. Pass this link on yourself:\n\n${r.link}`,
  });
}

function InviteDialog({ dir, onClose, onDone }: { dir: ReturnType<typeof useDirectory>; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ email: "", username: "", display_name: "", role: "user" as "admin" | "user", organization_id: "", groups: [] as string[], markings: [] as string[] });
  const [result, setResult] = useState<{ link: string; emailed: boolean; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = () =>
    auth
      .invite({ ...f, username: f.username.trim() || undefined, organization_id: f.organization_id || null })
      .then((r) => (setResult({ link: r.link, emailed: r.emailed, email: f.email }), onDone()), (e: Error) => setError(e.message));
  return (
    <Modal title="Invite by email" icon="comment" onClose={onClose} wide>
      {result ? (
        <div className="space-y-3 p-4 text-sm">
          <p>
            {result.emailed ? (
              <>An invitation was emailed to <span className="text-white">{result.email}</span>.</>
            ) : (
              <span className="text-warn">Email is not configured (RESEND_API_KEY and RESEND_FROM): send this link to {result.email} yourself.</span>
            )}{" "}
            They choose their password (or sign in with single sign-on) from it.
          </p>
          <code className="block select-all break-all rounded bg-ink px-2 py-1.5 text-xs">{result.link}</code>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => navigator.clipboard?.writeText(result.link)} className={buttonClass.secondary}>
              <Icon name="copy" /> Copy link
            </button>
            <button type="button" onClick={onClose} className={buttonClass.primary}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 p-4 text-sm lg:grid-cols-2">
          <div className="space-y-2">
            <Field label="Email">
              <input type="email" autoFocus value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Username (optional)" hint="Default: the email address.">
              <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Name (optional)">
              <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Role">
                <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as "admin" | "user" })} className={inputClass}>
                  <option value="user">User</option>
                  <option value="admin">Administrator</option>
                </select>
              </Field>
              <Field label="Organization">
                <select value={f.organization_id} onChange={(e) => setF({ ...f, organization_id: e.target.value })} className={inputClass}>
                  <option value="">None</option>
                  {dir.orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <div className="space-y-2">
            <Field label="Groups">
              <Checklist items={dir.groups} value={f.groups} label={(g) => g.name} onChange={(groups) => setF({ ...f, groups })} />
            </Field>
            <Field label="Markings">
              <Checklist items={dir.markings} value={f.markings} label={(m) => <MarkingChip m={{ ...m, kind: "marking" }} />} onChange={(markings) => setF({ ...f, markings })} />
            </Field>
          </div>
          {error && <p className="text-xs text-bad lg:col-span-2">{error}</p>}
          <div className="flex justify-end gap-2 lg:col-span-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())} onClick={send} className={buttonClass.primary}>
              Send invitation
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function UserDialog({ user, dir, onClose, onSaved }: { user: User | null; dir: ReturnType<typeof useDirectory>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    username: user?.username ?? "",
    password: "",
    display_name: user?.display_name ?? "",
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
    email: user?.email ?? "",
    organization_id: user?.organization_id ?? "",
    role: user?.role ?? ("user" as "admin" | "user"),
    markings: user?.markings ?? [],
    groups: user?.groups ?? [],
    must_change_password: true,
    exempt_from_inactivity: user?.exempt_from_inactivity ?? false,
    attributes: Object.entries(user?.attributes ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  });
  const [detail, setDetail] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (user) auth.user(user.id).then(setDetail, () => {});
  }, [user]);
  const attributes = Object.fromEntries(
    f.attributes
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const save = async () => {
    try {
      const body = { ...f, organization_id: f.organization_id || null, attributes };
      if (user) {
        const { username: _u, password, must_change_password, ...rest } = body;
        void _u;
        await auth.updateUser(user.id, { ...rest, ...(password ? { password, must_change_password } : {}) });
      } else await auth.createUser(body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) await alertDialog(done);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={user ? `User · ${user.username}` : "New user"} icon="project" onClose={onClose} wide>
      <div className="grid gap-4 p-4 text-sm lg:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium text-soft">Profile</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Username">
              <input value={f.username} disabled={!!user} onChange={(e) => setF({ ...f, username: e.target.value })} className={inputClass} />
            </Field>
            <Field label={user ? "Reset password (optional)" : "Initial password"}>
              <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className={inputClass} />
            </Field>
            <Field label="First name">
              <input value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Last name">
              <input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} className={inputClass} />
            </Field>
          </div>
          {(!user || f.password) && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={f.must_change_password} onChange={(e) => setF({ ...f, must_change_password: e.target.checked })} className="accent-[var(--color-ocean)]" />
              Must choose their own password at the next sign-in
            </label>
          )}
          {user && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={f.exempt_from_inactivity} onChange={(e) => setF({ ...f, exempt_from_inactivity: e.target.checked })} className="accent-[var(--color-ocean)]" />
              Never inactive (tokens keep working without signing in, e.g. an integration account)
            </label>
          )}
          <Field label="Display name">
            <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Email">
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Attributes" hint="One key=value per line (department, location, cost center …).">
            <textarea rows={3} value={f.attributes} onChange={(e) => setF({ ...f, attributes: e.target.value })} className={`${inputClass} font-mono text-xs`} />
          </Field>
          {detail && (
            <p className="text-xs text-muted">
              Created {when(detail.created_at)} · last sign-in {detail.last_login_at ? `${when(detail.last_login_at)}${detail.last_login_ip ? ` from ${detail.last_login_ip}` : ""}` : "never"} ·{" "}
              {detail.active_sessions ?? 0} active session{detail.active_sessions === 1 ? "" : "s"} · {detail.api_tokens ?? 0} API token{detail.api_tokens === 1 ? "" : "s"} ·
              two-factor {detail.mfa_enabled ? "on" : "off"}
              {detail.status === "invited" ? ` · invited ${detail.invited_at ? when(detail.invited_at) : ""}, not accepted yet` : ""}
              {(detail.identities ?? []).length ? ` · single sign-on: ${(detail.identities ?? []).map((i) => i.provider).join(", ")}` : ""}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-soft">Access</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Organization">
              <select value={f.organization_id} onChange={(e) => setF({ ...f, organization_id: e.target.value })} className={inputClass}>
                <option value="">None</option>
                {dir.orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as "admin" | "user" })} className={inputClass}>
                <option value="user">User</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
          </div>
          <Field label="Groups">
            <Checklist items={dir.groups} value={f.groups} label={(g) => g.name} onChange={(groups) => setF({ ...f, groups })} />
          </Field>
          <Field label="Markings granted to the user" hint="Groups and the organization grant more.">
            <Checklist items={dir.markings} value={f.markings} label={(m) => <MarkingChip m={{ ...m, kind: "marking" }} />} onChange={(markings) => setF({ ...f, markings })} />
          </Field>
        </div>
        {error && <p className="text-xs text-bad lg:col-span-2">{error}</p>}
        <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
          {user && (
            <>
              <button type="button" onClick={() => act(() => auth.updateUser(user.id, { disabled: !user.disabled }))} className={buttonClass.secondary}>
                <Icon name={user.disabled ? "play" : "stop"} /> {user.disabled ? "Reactivate" : "Deactivate"}
              </button>
              <button type="button" onClick={() => act(() => auth.signOutEverywhere(user.id), "Signed out of every session")} className={buttonClass.secondary}>
                <Icon name="refresh" /> Sign out everywhere
              </button>
              {user.status === "invited" ? (
                <button type="button" onClick={() => auth.resendInvite(user.id).then((r) => showLink("Invitation", r), (e: Error) => setError(e.message))} className={buttonClass.secondary}>
                  <Icon name="comment" /> Resend invitation
                </button>
              ) : (
                <button type="button" onClick={() => auth.resetLink(user.id).then((r) => showLink("Password reset link", r), (e: Error) => setError(e.message))} className={buttonClass.secondary}>
                  <Icon name="link" /> Send password reset link
                </button>
              )}
              {user.mfa_enabled && (
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirmDialog({ title: "Reset two-factor", message: `Turn off two-factor for ${user.username} (a lost phone)? They set it up again.`, confirmLabel: "Reset" }))
                      act(() => auth.resetUserMfa(user.id), "Two-factor authentication was turned off for this user");
                  }}
                  className={buttonClass.secondary}
                >
                  <Icon name="alert" /> Reset two-factor
                </button>
              )}
              <button
                type="button"
                onClick={async () => {
                  if (await confirmDialog({ title: "Delete user", message: `Delete ${user.username}? Deactivating keeps their history.`, confirmLabel: "Delete", danger: true }))
                    act(() => auth.deleteUser(user.id));
                }}
                className={buttonClass.secondary}
              >
                <Icon name="trash" />
              </button>
            </>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!f.username.trim() || (!user && f.password.length < 8)} onClick={save} className={buttonClass.primary}>
            {user ? "Save" : "Create user"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ groups

export function GroupsAdmin() {
  const dir = useDirectory();
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  return (
    <div>
      <Header
        title="Groups"
        text="Groups collect users; markings granted to a group are held by all its members."
        action={
          <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
            <Icon name="plus" /> New group
          </button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {dir.groups.map((g) => (
          <button key={g.id} type="button" onClick={() => setEditing(g)} className="rounded-xl border border-line bg-panel p-4 text-left hover:border-ocean/60">
            <div className="flex items-center gap-2 font-medium">
              <Icon name="layers" className="h-4 w-4 text-ocean" /> {g.name}
              <span className="ml-auto text-xs text-muted">
                {g.members.length} member{g.members.length === 1 ? "" : "s"}
              </span>
            </div>
            {g.description && <p className="mt-1 text-xs text-muted">{g.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1">
              {g.markings.map((m) => (
                <MarkingChip key={m} m={dir.markingRef(m)} />
              ))}
            </div>
            <p className="mt-2 truncate text-xs text-soft">{(g.member_names ?? []).join(", ")}</p>
          </button>
        ))}
        {dir.groups.length === 0 && <p className="text-sm text-muted">No groups yet.</p>}
      </div>
      {editing && <GroupDialog group={editing === "new" ? null : editing} dir={dir} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), dir.load())} />}
    </div>
  );
}

function GroupDialog({ group, dir, onClose, onSaved }: { group: Group | null; dir: ReturnType<typeof useDirectory>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: group?.name ?? "",
    description: group?.description ?? "",
    members: group?.members ?? [],
    markings: group?.markings ?? [],
    managers: group?.managers ?? [],
    member_groups: group?.member_groups ?? [],
    member_expiry: group?.member_expiry ?? {},
    realm: group?.realm ?? null,
  });
  const [attrs, setAttrs] = useState<[string, string][]>(Object.entries(group?.attributes ?? {}));
  const [contact, setContact] = useState<GroupContact | null>(group?.contact ?? null);
  const [expiry, setExpiry] = useState({ latest: (group?.expiry_policy?.latest ?? "").slice(0, 10), max_days: group?.expiry_policy?.max_days ? String(group.expiry_policy.max_days) : "" });
  const [policy, setPolicy] = useState(group?.approval_policy ?? null);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const body = {
      ...f,
      realm: f.realm ?? {},
      attributes: Object.fromEntries(attrs.filter(([k]) => k.trim())),
      contact: contact ?? {},
      expiry_policy: expiry.latest || expiry.max_days ? { ...(expiry.latest ? { latest: expiry.latest } : {}), ...(expiry.max_days ? { max_days: Number(expiry.max_days) } : {}) } : {},
      approval_policy: policy ?? {},
    };
    (group ? auth.updateGroup(group.id, body) : auth.createGroup(body)).then(onSaved, (e: Error) => setError(e.message));
  };
  return (
    <Modal title={group ? `Group · ${group.name}` : "New group"} icon="layers" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Description">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Members (an end date makes a membership expire)">
          <Checklist
            items={dir.users ?? []}
            value={f.members}
            label={(u) => (
              <span className="flex w-full items-center gap-2">
                <span className="flex-1">{`${u.display_name} (${u.username})`}</span>
                {f.members.includes(u.id) && (
                  <input
                    type="date"
                    value={(f.member_expiry[u.id] ?? "").slice(0, 10)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setF({ ...f, member_expiry: { ...f.member_expiry, [u.id]: e.target.value } })}
                    className="rounded border border-line-2 bg-ink px-1 text-[11px]"
                    title="Membership ends"
                  />
                )}
              </span>
            )}
            onChange={(members) => setF({ ...f, members })}
          />
        </Field>
        <Field label="Nested groups (their members belong to this group too)">
          <Checklist items={dir.groups.filter((g) => g.id !== group?.id)} value={f.member_groups} label={(g) => g.name} onChange={(member_groups) => setF({ ...f, member_groups })} />
        </Field>
        <Field label="Realm (members follow an identity provider's group at single sign-on)">
          <div className="flex gap-2">
            <select
              value={f.realm?.provider ?? ""}
              onChange={(e) => setF({ ...f, realm: e.target.value ? { provider: e.target.value, name: f.realm?.name ?? "" } : null })}
              className={`${inputClass} w-40`}
            >
              <option value="">Not bound</option>
              <option value="*">Any provider</option>
              <option value="google">Google</option>
              <option value="microsoft">Microsoft Entra ID</option>
              <option value="okta">Okta</option>
              <option value="oidc">OpenID Connect</option>
              <option value="saml">SAML</option>
            </select>
            {f.realm && <input value={f.realm.name} onChange={(e) => setF({ ...f, realm: { ...f.realm!, name: e.target.value } })} placeholder="external group name" className={inputClass} />}
          </div>
        </Field>
        <Field label="Markings granted to the group">
          <Checklist items={dir.markings} value={f.markings} label={(m) => <MarkingChip m={{ ...m, kind: "marking" }} />} onChange={(markings) => setF({ ...f, markings })} />
        </Field>
        <Field label="Managers (review requests to join, in Approvals)">
          <Checklist items={dir.users ?? []} value={f.managers} label={(u) => `${u.display_name} (${u.username})`} onChange={(managers) => setF({ ...f, managers })} />
        </Field>
        <Field label="Temporary memberships (new memberships expire by the earlier of the two)">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Latest expiration</span>
            <input type="date" value={expiry.latest} onChange={(e) => setExpiry({ ...expiry, latest: e.target.value })} className="rounded border border-line-2 bg-ink px-1 py-0.5" />
            <span className="text-muted">Maximum duration</span>
            <input type="number" min={1} max={3650} value={expiry.max_days} onChange={(e) => setExpiry({ ...expiry, max_days: e.target.value })} className="w-20 rounded border border-line-2 bg-ink px-1 py-0.5" />
            <span className="text-muted">days</span>
          </div>
        </Field>
        <Field label="Approval policy for requests to join">
          <div className="space-y-1.5 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!policy} onChange={(e) => setPolicy(e.target.checked ? { min_approvals: 1, reviewers: [] } : null)} />
              Custom policy (otherwise one approval by a manager)
            </label>
            {policy && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-muted">Approvals needed</span>
                  <input type="number" min={1} max={10} value={policy.min_approvals} onChange={(e) => setPolicy({ ...policy, min_approvals: Number(e.target.value) || 1 })} className="w-16 rounded border border-line-2 bg-ink px-1 py-0.5" />
                </div>
                <p className="text-muted">Reviewers (none: the managers)</p>
                <Checklist
                  items={[...(dir.users ?? []).map((u) => ({ id: `user:${u.id}`, label: `${u.display_name} (${u.username})` })), ...dir.groups.map((g) => ({ id: `group:${g.id}`, label: `Group · ${g.name}` }))]}
                  value={policy.reviewers}
                  label={(x) => x.label}
                  onChange={(reviewers) => setPolicy({ ...policy, reviewers })}
                />
              </>
            )}
          </div>
        </Field>
        <Field label="Point of contact">
          <div className="flex gap-2 text-xs">
            <select value={contact?.kind ?? ""} onChange={(e) => setContact(e.target.value ? { kind: e.target.value as GroupContact["kind"], value: contact?.value ?? "" } : null)} className={`${inputClass} w-36`}>
              <option value="">None</option>
              <option value="email">Email</option>
              <option value="issues">Issues</option>
            </select>
            {contact?.kind === "email" && <input value={contact.value} onChange={(e) => setContact({ ...contact, value: e.target.value })} placeholder="team@example.com" className={inputClass} />}
          </div>
        </Field>
        <Field label="Attributes (access-request:<category> = value adds a choice to access request forms)">
          <div className="space-y-1 text-xs">
            {attrs.map(([k, v], i) => (
              <div key={i} className="flex gap-1.5">
                <input value={k} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} placeholder="access-request:Team" className={inputClass} />
                <input value={v} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} placeholder="blue" className={inputClass} />
                <button type="button" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad">
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setAttrs([...attrs, ["access-request:", ""]])} className="text-ocean hover:underline">
              + Attribute
            </button>
          </div>
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex items-center gap-2">
          {group && (
            <button
              type="button"
              onClick={async () => {
                if (await confirmDialog({ title: "Delete group", message: `Delete ${group.name}? Its members lose the markings it granted.`, confirmLabel: "Delete", danger: true }))
                  auth.deleteGroup(group.id).then(onSaved, (e: Error) => setError(e.message));
              }}
              className={buttonClass.secondary}
            >
              <Icon name="trash" />
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!f.name.trim()} onClick={save} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------------- organizations

export function OrganizationsAdmin() {
  const dir = useDirectory();
  const [access, setAccess] = useState<Organization | null>(null);
  const create = async () => {
    const name = await promptDialog("Organization name", "", { title: "New organization" });
    if (name?.trim()) auth.createOrganization({ name: name.trim() }).then(dir.load, (e: Error) => alertDialog(e.message));
  };
  return (
    <div>
      <Header
        title="Organizations"
        text="Every user belongs to at most one organization. An organization is also a marking: restrict a project, folder or dataset to an organization and only its members can open it."
        action={
          <button type="button" onClick={create} className={buttonClass.primary}>
            <Icon name="plus" /> New organization
          </button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {dir.orgs.map((o) => (
          <div key={o.id} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center gap-2">
              <MarkingChip m={{ id: o.marking, name: o.name, color: o.color, kind: "organization" }} />
              <span className="ml-auto text-xs text-muted">
                {o.members} member{o.members === 1 ? "" : "s"}
              </span>
            </div>
            {o.description && <p className="mt-2 text-xs text-muted">{o.description}</p>}
            <div className="mt-3 flex gap-2 text-xs">
              <input
                type="color"
                value={o.color}
                onChange={(e) => auth.updateOrganization(o.id, { name: o.name, description: o.description, color: e.target.value }).then(dir.load)}
                className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
                title="Color"
              />
              <button
                type="button"
                onClick={async () => {
                  const name = await promptDialog("Rename organization", o.name);
                  if (name?.trim()) auth.updateOrganization(o.id, { name: name.trim(), description: o.description, color: o.color }).then(dir.load, (e: Error) => alertDialog(e.message));
                }}
                className="text-ocean hover:underline"
              >
                Rename
              </button>
              <button type="button" onClick={() => setAccess(o)} className="text-ocean hover:underline">
                Guests and permissions
              </button>
              <button type="button" onClick={() => auth.deleteOrganization(o.id).then(dir.load, (e: Error) => alertDialog(e.message))} className="text-bad hover:underline">
                Delete
              </button>
            </div>
            {(o.guests?.length ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted">
                {o.guests!.length} guest{o.guests!.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
        ))}
        {dir.orgs.length === 0 && <p className="text-sm text-muted">No organizations yet.</p>}
      </div>
      {access && <OrgAccessDialog org={access} users={dir.users ?? []} groups={dir.groups} onClose={() => setAccess(null)} onSaved={() => (setAccess(null), dir.load())} />}
    </div>
  );
}

function OrgAccessDialog({ org, users, groups, onClose, onSaved }: { org: Organization; users: User[]; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const [guests, setGuests] = useState<string[]>((org.guests ?? []).map((g) => `user:${g}`));
  const [apply, setApply] = useState<string[]>(org.apply ?? []);
  const [expand, setExpand] = useState<string[]>(org.expand_access ?? []);
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    auth
      .updateOrganization(org.id, { name: org.name, description: org.description, color: org.color, guests: guests.map((g) => g.replace(/^user:/, "")), apply, expand_access: expand })
      .then(onSaved, (e: Error) => setError(e.message));
  return (
    <Modal title={`Organization · ${org.name}`} icon="globe" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Guest members (users of other organizations who may use its resources)">
          <PrincipalList value={guests} onChange={setGuests} users={users.filter((u) => u.organization_id !== org.id)} groups={[]} />
        </Field>
        <Field label="Apply organization (may restrict resources to it; its members may too)">
          <PrincipalList value={apply} onChange={setApply} users={users} groups={groups} />
        </Field>
        <Field label="Expand access (may remove it from resources, opening them to more people)">
          <PrincipalList value={expand} onChange={setExpand} users={users} groups={groups} />
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={save} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------- markings

export function MarkingsAdmin() {
  const dir = useDirectory();
  const people = usePeople();
  const [editing, setEditing] = useState<Marking | "new" | null>(null);
  const holders = useMemo(() => {
    const out: Record<string, { user: User; via: string }[]> = {};
    for (const u of dir.users ?? [])
      for (const m of u.effective_markings ?? u.markings) {
        const via = u.markings.includes(m)
          ? "directly"
          : (dir.groups
              .filter((g) => g.members.includes(u.id) && g.markings.includes(m))
              .map((g) => `group ${g.name}`)
              .join(", ") || "organization");
        (out[m] ??= []).push({ user: u, via });
      }
    return out;
  }, [dir.users, dir.groups]);
  return (
    <div>
      <Header
        title="Markings"
        text="Mandatory access controls: a user must satisfy every marking on a file, dataset, pipeline or folder (and the folders above it) to see it: each marking of a conjunctive category, any one of a disjunctive category, a high enough level of a classification. Outputs inherit the markings of their inputs. Membership is separate from the Manage, Apply and Remove permissions."
        action={
          <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
            <Icon name="plus" /> New marking
          </button>
        }
      />
      <MarkingCategories people={people} />
      <div className="space-y-3">
        {dir.markings.map((m) => (
          <div key={m.id} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center gap-2">
              <MarkingChip m={{ ...m, kind: "marking" }} />
              <span className="text-xs text-muted">
                {m.category ?? "General"}
                {m.category_kind === "hierarchical" ? ` · level ${m.level ?? 0}` : ""} · on {m.items} item{m.items === 1 ? "" : "s"} · held by {m.members} user
                {m.members === 1 ? "" : "s"}
                {m.permissions ? ` · you: ${(["manage", "apply", "remove"] as const).filter((k) => m.permissions![k]).join(", ") || "member only"}` : ""}
              </span>
              {(m.permissions?.manage ?? true) && (
                <button type="button" onClick={() => setEditing(m)} className="ml-auto text-xs text-ocean hover:underline">
                  Edit
                </button>
              )}
            </div>
            {m.description && <p className="mt-1 text-xs text-muted">{m.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {(holders[m.id] ?? []).map(({ user, via }) => (
                <span key={user.id} className="rounded-full bg-panel-2 px-2 py-0.5" title={`Holds it ${via}`}>
                  {user.display_name} <span className="text-muted">· {via}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
        {dir.markings.length === 0 && <p className="text-sm text-muted">No markings yet.</p>}
      </div>
      {editing && (
        <MarkingDialog marking={editing === "new" ? null : editing} dir={dir} people={people} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), dir.load(), people.load())} />
      )}
    </div>
  );
}

function MarkingDialog({
  marking,
  dir,
  people,
  onClose,
  onSaved,
}: {
  marking: Marking | null;
  dir: ReturnType<typeof useDirectory>;
  people: ReturnType<typeof usePeople>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: marking?.name ?? "",
    description: marking?.description ?? "",
    color: marking?.color ?? "#c0392b",
    managers: marking?.managers ?? [],
    category_id: marking?.category_id ?? "cat-general",
    level: marking?.level ?? null,
    manage: marking?.manage ?? [],
    apply: marking?.apply ?? [],
    remove: marking?.remove ?? [],
  });
  const category = people.categories.find((c) => c.id === f.category_id);
  const [error, setError] = useState<string | null>(null);
  const save = () => (marking ? auth.updateMarking(marking.id, f) : auth.createMarking(f)).then(onSaved, (e: Error) => setError(e.message));
  return (
    <Modal title={marking ? `Marking · ${marking.name}` : "New marking"} icon="eye" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <div className="grid grid-cols-[1fr_80px] gap-2">
          <Field label="Name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="PII" className={inputClass} />
          </Field>
          <Field label="Color">
            <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-9 w-full cursor-pointer rounded border border-line bg-transparent" />
          </Field>
        </div>
        <Field label="Description">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputClass} />
        </Field>
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <Field label="Category">
            <select value={f.category_id} disabled={!!marking} onChange={(e) => setF({ ...f, category_id: e.target.value })} className={inputClass}>
              {people.categories
                .filter((c) => c.id !== "cat-organizations" && (c.my_role === "administrator" || c.id === f.category_id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
            </select>
          </Field>
          {category?.kind === "hierarchical" && (
            <Field label="Level">
              <input type="number" min={0} value={f.level ?? 0} onChange={(e) => setF({ ...f, level: Number(e.target.value) })} className={inputClass} />
            </Field>
          )}
        </div>
        <Field label="Managers (review requests for the marking, in Approvals; manage it)">
          <Checklist items={dir.users ?? []} value={f.managers} label={(u) => `${u.display_name} (${u.username})`} onChange={(managers) => setF({ ...f, managers })} />
        </Field>
        <Field label="Manage permissions (also groups)">
          <PrincipalList value={f.manage} onChange={(manage) => setF({ ...f, manage })} users={people.users} groups={people.groups} />
        </Field>
        <Field label="Apply marking (put it on resources; does not grant membership)">
          <PrincipalList value={f.apply} onChange={(apply) => setF({ ...f, apply })} users={people.users} groups={people.groups} />
        </Field>
        <Field label="Remove marking (take it off resources, which expands access; needs Apply too)">
          <PrincipalList value={f.remove} onChange={(remove) => setF({ ...f, remove })} users={people.users} groups={people.groups} />
        </Field>
        {!marking && <p className="text-xs text-muted">You hold and manage a marking you create. Grant membership to users or groups to share access; markings cannot move to another category.</p>}
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex items-center gap-2">
          {marking && (
            <button type="button" onClick={() => auth.deleteMarking(marking.id).then(onSaved, (e: Error) => setError(e.message))} className={buttonClass.secondary}>
              <Icon name="trash" />
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!f.name.trim()} onClick={save} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------- activity

export function ActivityLog() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [event, setEvent] = useState("");
  const [user, setUser] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    auth.users().then(setUsers, () => {});
  }, []);
  useEffect(() => {
    auth.audit({ event, user_id: user, limit: 500 }).then(setRows, () => setRows([]));
  }, [event, user]);
  return (
    <div>
      <Header title="Sign-in activity" text="Sign-ins, failed attempts, sign-outs and changes to users, groups, organizations and markings, newest first." />
      <div className="mb-3 flex gap-2 text-xs">
        <select value={event} onChange={(e) => setEvent(e.target.value)} className={fieldClass}>
          <option value="">All events</option>
          {Object.entries(AUDIT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={user} onChange={(e) => setUser(e.target.value)} className={fieldClass}>
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
      </div>
      <table className="w-full rounded-xl border border-line bg-panel text-xs">
        <thead className="text-left text-muted">
          <tr className="border-b border-line">
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Event</th>
            <th className="px-3 py-2">User</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">IP</th>
            <th className="px-3 py-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-3 py-1.5">{when(r.at)}</td>
              <td className={`px-3 py-1.5 ${r.event === "sign_in_failed" ? "text-bad" : ""}`}>{AUDIT_LABEL[r.event] ?? r.event}</td>
              <td className="px-3 py-1.5">{r.username ?? "—"}</td>
              <td className="px-3 py-1.5 text-muted">{r.actor && r.actor !== r.username ? r.actor : ""}</td>
              <td className="px-3 py-1.5 text-muted">{r.ip ?? ""}</td>
              <td className="px-3 py-1.5 text-muted">{r.detail}</td>
            </tr>
          ))}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-muted">
                No activity.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
