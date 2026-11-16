"use client";

import { useCallback, useEffect, useState } from "react";
import { auth, type Group, type ProjectRole, type ProjectRoleEntry, type ProjectRoles, type RoleDef, type User } from "@/lib/auth";
import { datasetPreview } from "@/lib/datasetPreview";
import { useAuth } from "../AuthGate";

const DEFAULT_ROLES: RoleDef[] = [
  { id: "discoverer", name: "Discoverer", operations: ["discover"] },
  { id: "viewer", name: "Viewer", operations: ["discover", "read", "download"] },
  { id: "editor", name: "Editor", operations: ["discover", "read", "download", "edit"] },
  { id: "owner", name: "Owner", operations: ["discover", "read", "download", "edit", "markings", "manage"] },
];
const OP_LABEL: Record<string, string> = { discover: "sees it exists", read: "reads data", download: "downloads", edit: "changes", markings: "changes markings", manage: "manages roles" };

/**
 * Roles on a Project (Files details): Owner, Editor, Viewer, Discoverer and custom roles for users, groups or
 * everyone, plus the roles its space gives every Project. Owners (and administrators) change them; a Project without
 * roles is closed to everyone but administrators.
 * With `itemId`: the roles granted on a folder or a file inside a Project — they add to the Project's roles for
 * everything below it (never take any away); the Project's Owners grant them.
 */
export function ProjectRolesPanel({ projectId, itemId }: { projectId?: string; itemId?: string }) {
  const id = itemId ?? projectId ?? "";
  const { enabled, me } = useAuth();
  const [info, setInfo] = useState<ProjectRoles | null>(null);
  const [draft, setDraft] = useState<ProjectRoleEntry[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [add, setAdd] = useState({ who: "everyone:*", role: "viewer" as ProjectRole });
  const available = info?.available_roles?.length ? info.available_roles : DEFAULT_ROLES;
  const allowed = info?.space?.role_set?.length ? available.filter((r) => info.space?.role_set?.includes(r.id)) : available;
  const label = (id: string | null | undefined) => (id ? (available.find((r) => r.id === id)?.name ?? id) : "no role");
  const hint = (id: string) => (available.find((r) => r.id === id)?.operations ?? []).map((o) => OP_LABEL[o] ?? o).join(", ");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () => (itemId ? auth.itemRoles(itemId) : auth.projectRoles(id)).then((r) => (setInfo(r), setError(null)), (e: Error) => setError(e.message)),
    [id, itemId],
  );
  useEffect(() => {
    if (!enabled) return;
    load();
  }, [load, enabled]);
  useEffect(() => {
    if (!draft) return;
    auth.groups().then(setGroups, () => {});
    // administrators list users; other Owners pick people from the names-only directory
    if (me?.role === "admin") auth.users().then(setUsers, () => {});
    else datasetPreview.people().then((ps) => setUsers(ps.map((x) => ({ id: x.id, display_name: x.label, username: "" }) as User)), () => {});
  }, [draft, me?.role]);
  if (!enabled) return null;
  if (!info) return error ? <p className="text-xs text-bad">{error}</p> : <p className="text-xs text-muted">…</p>;
  // a folder or a file outside any Project has no roles of its own (its creator and administrators open it)
  if (itemId && !info.project_id) return <p className="text-xs text-muted">Outside any Project: no roles.</p>;
  const save = () =>
    (itemId ? auth.setItemRoles(itemId, draft ?? []) : auth.setProjectRoles(id, draft ?? [])).then(
      (r) => (setInfo(r), setDraft(null), setError(null)),
      (e: Error) => setError(e.message),
    );
  if (!draft)
    return (
      <div className="text-xs">
        {itemId && !info.roles.length ? (
          <p className="text-muted">None of its own: the roles of {info.project ?? "its Project"} apply{(info.from_folders ?? []).length ? ", and those granted on the folders above" : ""}.</p>
        ) : info.open ? (
          <p className="text-muted">No roles: only administrators can open this Project. Add an Owner.</p>
        ) : (
          <ul className="space-y-0.5">
            {info.roles.map((r) => (
              <li key={`${r.principal_type}:${r.principal_id}`}>
                <span className="text-soft">{r.name}</span> <span className="text-muted" title={hint(r.role)}>· {r.role_label ?? label(r.role)}</span>
              </li>
            ))}
          </ul>
        )}
        {(info.inherited ?? []).length > 0 && (
          <div className="mt-1.5">
            <p className="text-[11px] uppercase tracking-wide text-muted">From the space {info.space?.name}</p>
            <ul className="space-y-0.5">
              {info.inherited!.map((r) => (
                <li key={`i:${r.principal_type}:${r.principal_id}`}>
                  <span className="text-soft">{r.name}</span> <span className="text-muted">· {r.role_label ?? label(r.role)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(info.from_folders ?? []).length > 0 && (
          <div className="mt-1.5">
            <p className="text-[11px] uppercase tracking-wide text-muted">Granted on folders above</p>
            <ul className="space-y-0.5">
              {info.from_folders!.map((r) => (
                <li key={`f:${r.item_id}:${r.principal_type}:${r.principal_id}`}>
                  <span className="text-soft">{r.name}</span> <span className="text-muted">· {r.role_label ?? label(r.role)} on {r.item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-1 text-muted">
          You: {label(info.my_role)}
          {info.can_manage && (
            <>
              {" · "}
              <button type="button" onClick={() => setDraft(info.roles)} className="text-ocean hover:underline">
                {itemId ? "Grant roles here" : "Manage roles"}
              </button>
            </>
          )}
        </p>
        {error && <p className="mt-1 text-bad">{error}</p>}
      </div>
    );
  const keyOf = (r: Pick<ProjectRoleEntry, "principal_type" | "principal_id">) => `${r.principal_type}:${r.principal_id}`;
  const taken = new Set(draft.map(keyOf));
  const choices = [
    { key: "everyone:*", label: "Everyone signed in" },
    ...groups.map((g) => ({ key: `group:${g.id}`, label: `Group · ${g.name}` })),
    ...users.map((u) => ({ key: `user:${u.id}`, label: u.username ? `${u.display_name} (${u.username})` : u.display_name })),
  ].filter((c) => !taken.has(c.key));
  const nameOf = (key: string) => choices.find((c) => c.key === key)?.label.replace(/^Group · /, "") ?? key;
  return (
    <div className="space-y-1.5 text-xs">
      {draft.length === 0 && <p className="text-muted">{itemId ? "No roles of its own: the Project's roles apply." : "No roles: only administrators can open the Project."}</p>}
      {draft.map((r, i) => (
        <div key={keyOf(r)} className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-soft">{r.name ?? keyOf(r)}</span>
          <select
            value={r.role}
            onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, role: e.target.value as ProjectRole } : x)))}
            className="rounded border border-line-2 bg-ink px-1 py-0.5"
            title={hint(r.role)}
          >
            {allowed
              .filter((x) => r.principal_type !== "everyone" || !x.operations.includes("manage"))
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <button type="button" onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove">
            ×
          </button>
        </div>
      ))}
      {choices.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-line pt-1.5">
          <select value={choices.some((c) => c.key === add.who) ? add.who : choices[0].key} onChange={(e) => setAdd({ ...add, who: e.target.value })} className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-1 py-0.5">
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value as ProjectRole })} className="rounded border border-line-2 bg-ink px-1 py-0.5">
            {allowed.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const who = choices.some((c) => c.key === add.who) ? add.who : choices[0].key;
              const [t, ...rest] = who.split(":");
              const manages = available.find((x) => x.id === add.role)?.operations.includes("manage");
              const role = t === "everyone" && manages ? "editor" : add.role;
              setDraft([...draft, { principal_type: t as ProjectRoleEntry["principal_type"], principal_id: rest.join(":"), role, name: nameOf(who) }]);
            }}
            className="rounded border border-line-2 px-1.5 py-0.5 hover:text-white"
          >
            Add
          </button>
        </div>
      )}
      <p className="text-[11px] text-muted">
        {allowed.map((x) => `${x.name}: ${hint(x.id)}`).join(" · ")}. Administrators are Owners of every Project.
        {itemId && " A role here adds to the Project's roles for everything inside; it never takes access away."}
      </p>
      <div className="flex gap-1.5">
        <button type="button" onClick={save} className="rounded bg-ocean px-2 py-0.5 text-white">
          Save roles
        </button>
        <button type="button" onClick={() => (setDraft(null), setError(null))} className="rounded border border-line-2 px-2 py-0.5">
          Cancel
        </button>
      </div>
      {error && <p className="text-bad">{error}</p>}
    </div>
  );
}
