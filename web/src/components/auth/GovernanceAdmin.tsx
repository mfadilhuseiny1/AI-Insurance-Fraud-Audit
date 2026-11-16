"use client";

import { useCallback, useEffect, useState } from "react";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { auth, type Group, type Marking, type MarkingCategory, type Organization, type RoleDef, type User } from "@/lib/auth";
import { governance, principalLabel, type RoleGrant, type Space, type SpaceBody, type SpaceRole, type Template, type TemplateBody } from "@/lib/governanceModel";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field } from "../pipeline/ui";

/** Users, groups, organizations, markings and roles, loaded together. */
export function usePeople() {
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [categories, setCategories] = useState<MarkingCategory[]>([]);
  const load = useCallback(() => {
    auth.users().then(setUsers, () => {});
    auth.groups().then(setGroups, () => {});
    auth.organizations().then(setOrgs, () => {});
    auth.markings().then(setMarkings, () => {});
    auth.roles().then((r) => setRoles(r.roles), () => {});
    auth.markingCategories().then(setCategories, () => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { users, groups, orgs, markings, roles, categories, load };
}
type People = ReturnType<typeof usePeople>;

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

/** A list of "user:<id>" / "group:<id>" (/ "everyone") keys: chips and an add picker. */
export function PrincipalList({ value, onChange, users, groups, everyone = false }: { value: string[]; onChange: (v: string[]) => void; users: User[]; groups: Group[]; everyone?: boolean }) {
  const choices = [
    ...(everyone ? [{ key: "everyone", label: "Everyone" }] : []),
    ...groups.map((g) => ({ key: `group:${g.id}`, label: `Group · ${g.name}` })),
    ...users.map((u) => ({ key: `user:${u.id}`, label: `${u.display_name || u.username} (${u.username})` })),
  ].filter((c) => !value.includes(c.key));
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line p-1.5 text-xs">
      {value.map((k) => (
        <span key={k} className="flex items-center gap-1 rounded-full bg-panel-2 px-2 py-0.5">
          {principalLabel(k, users, groups)}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== k))} className="text-muted hover:text-bad" aria-label="Remove">
            ×
          </button>
        </span>
      ))}
      {choices.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className="rounded border border-line-2 bg-ink px-1 py-0.5">
          <option value="">+ Add…</option>
          {choices.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ roles

const OPS = [
  ["discover", "Discover", "See that a resource exists and its metadata"],
  ["read", "Read", "Read its data (previews, queries, inputs)"],
  ["download", "Download", "Download or export its data"],
  ["edit", "Edit", "Change files, pipelines, schedules and builds"],
  ["markings", "Markings", "Change its markings"],
  ["manage", "Manage", "Manage the Project's roles"],
] as const;

/** Control Panel → Roles: the default roles and custom ones (a set of operations, e.g. a Viewer without Download). */
export function RolesAdmin() {
  const [roles, setRoles] = useState<RoleDef[] | null>(null);
  const [editing, setEditing] = useState<RoleDef | "new" | null>(null);
  const load = useCallback(() => auth.roles().then((r) => setRoles(r.roles), (e: Error) => alertDialog(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div>
      <Header
        title="Roles"
        text="What each Project role allows. Custom roles combine operations — for example a Viewer without Download, so data can be read in the platform but not exported. Discoverers only see that resources exist."
        action={
          <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
            <Icon name="plus" /> New role
          </button>
        }
      />
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-2">Role</th>
              {OPS.map(([id, label, hint]) => (
                <th key={id} className="px-2 py-2 text-center" title={hint}>
                  {label}
                </th>
              ))}
              <th className="px-3 py-2">Grants</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(roles ?? []).map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{r.name}</span>
                  {r.default ? <span className="ml-1.5 text-xs text-muted">default</span> : null}
                  {r.description && <p className="text-xs text-muted">{r.description}</p>}
                </td>
                {OPS.map(([id]) => (
                  <td key={id} className="px-2 py-2 text-center">
                    {r.operations.includes(id) ? <Icon name="check" className="mx-auto h-4 w-4 text-ok" /> : <span className="text-muted">–</span>}
                  </td>
                ))}
                <td className="px-3 py-2 text-xs text-muted">{r.grants ?? 0}</td>
                <td className="px-3 py-2 text-right">
                  {!r.default && (
                    <button type="button" onClick={() => setEditing(r)} className="text-xs text-ocean hover:underline">
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <RoleDialog role={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
    </div>
  );
}

function RoleDialog({ role, onClose, onSaved }: { role: RoleDef | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: role?.name ?? "", description: role?.description ?? "", operations: role?.operations ?? ["discover", "read"] });
  const [error, setError] = useState<string | null>(null);
  const save = () => (role ? auth.updateRole(role.id, f) : auth.createRole(f)).then(onSaved, (e: Error) => setError(e.message));
  return (
    <Modal title={role ? `Role · ${role.name}` : "New role"} icon="project" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Analyst (no download)" className={inputClass} />
        </Field>
        <Field label="Description">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Operations">
          <div className="space-y-1">
            {OPS.map(([id, label, hint]) => (
              <label key={id} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={f.operations.includes(id)}
                  onChange={() => setF({ ...f, operations: f.operations.includes(id) ? f.operations.filter((x) => x !== id) : [...f.operations, id] })}
                  className="mt-0.5 accent-[var(--color-ocean)]"
                />
                <span>
                  <span className="font-medium">{label}</span> <span className="text-muted">— {hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <p className="text-xs text-muted">Every role can discover; downloading or editing also needs reading. Custom roles do not change when default roles do.</p>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex items-center gap-2">
          {role && (
            <button
              type="button"
              onClick={async () => {
                if (await confirmDialog(`Delete the role ${role.name}?`)) auth.deleteRole(role.id).then(onSaved, (e: Error) => setError(e.message));
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

// ------------------------------------------------------------------------------------ marking categories

const KIND_TEXT: Record<MarkingCategory["kind"], string> = {
  conjunctive: "a user needs every marking of the category on a resource",
  disjunctive: "a user needs any one of the category's markings on a resource (e.g. RELEASE TO)",
  hierarchical: "classifications: holding a level satisfies it and every lower level",
};

/** The marking categories (shown above the markings in Control Panel → Markings). */
export function MarkingCategories({ people }: { people: People }) {
  const [editing, setEditing] = useState<MarkingCategory | "new" | null>(null);
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Categories</h2>
        <button type="button" onClick={() => setEditing("new")} className={buttonClass.secondary}>
          <Icon name="plus" /> New category
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {people.categories.map((c) => (
          <div key={c.id} className="rounded-lg border border-line bg-panel p-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{c.name}</span>
              <span className="rounded bg-panel-2 px-1.5 py-0.5">{c.kind}</span>
              {c.visibility === "hidden" && <span className="rounded bg-panel-2 px-1.5 py-0.5">hidden</span>}
              {!c.builtin && c.my_role === "administrator" && (
                <button type="button" onClick={() => setEditing(c)} className="ml-auto text-ocean hover:underline">
                  Edit
                </button>
              )}
            </div>
            <p className="mt-1 text-muted">{c.description || KIND_TEXT[c.kind]}</p>
            <p className="mt-1 text-muted">{people.markings.filter((m) => (m.category_id ?? "cat-general") === c.id).length} markings</p>
          </div>
        ))}
      </div>
      {editing && <CategoryDialog cat={editing === "new" ? null : editing} people={people} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), people.load())} />}
    </div>
  );
}

function CategoryDialog({ cat, people, onClose, onSaved }: { cat: MarkingCategory | null; people: People; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: cat?.name ?? "",
    description: cat?.description ?? "",
    kind: cat?.kind ?? ("conjunctive" as MarkingCategory["kind"]),
    visibility: cat?.visibility ?? ("visible" as MarkingCategory["visibility"]),
    administrators: cat?.administrators ?? [],
    viewers: cat?.viewers ?? [],
    organization_id: cat?.organization_id ?? null,
  });
  const [error, setError] = useState<string | null>(null);
  const save = () => (cat ? auth.updateMarkingCategory(cat.id, f) : auth.createMarkingCategory(f)).then(onSaved, (e: Error) => setError(e.message));
  return (
    <Modal title={cat ? `Category · ${cat.name}` : "New marking category"} icon="eye" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Release to" className={inputClass} />
        </Field>
        <Field label="Description">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputClass} />
        </Field>
        <Field label="How its markings combine">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as MarkingCategory["kind"] })} className={inputClass}>
            <option value="conjunctive">Conjunctive (all)</option>
            <option value="disjunctive">Disjunctive (any one)</option>
            <option value="hierarchical">Hierarchical (classification levels)</option>
          </select>
          <p className="mt-1 text-xs text-muted">{KIND_TEXT[f.kind]}</p>
        </Field>
        <Field label="Visibility">
          <select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as MarkingCategory["visibility"] })} className={inputClass}>
            <option value="visible">Visible to everyone</option>
            <option value="hidden">Hidden (only its viewers, administrators and holders know it exists)</option>
          </select>
        </Field>
        <Field label="Restricted to an organization">
          <select value={f.organization_id ?? ""} onChange={(e) => setF({ ...f, organization_id: e.target.value || null })} className={inputClass}>
            <option value="">No</option>
            {people.orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category administrators (create markings in it, change it)">
          <PrincipalList value={f.administrators} onChange={(administrators) => setF({ ...f, administrators })} users={people.users} groups={people.groups} />
        </Field>
        <Field label="Category viewers (see a hidden category)">
          <PrincipalList value={f.viewers} onChange={(viewers) => setF({ ...f, viewers })} users={people.users} groups={people.groups} />
        </Field>
        <p className="text-xs text-muted">Categories cannot be deleted.</p>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
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

// ------------------------------------------------------------------------------------------------ spaces

const EMPTY_SPACE: SpaceBody = {
  name: "",
  description: "",
  organizations: [],
  owners: [],
  editors: [],
  viewers: [],
  inherited_roles: [],
  marketplace_inherited_roles: [],
  role_set: [],
  max_classification: null,
  storage: "default",
  resource_queue: null,
  usage_account: "",
  maven_group: "",
  deletion_organizations: [],
};

/** Control Panel → Spaces and their Project templates. */
export function SpacesAdmin() {
  const people = usePeople();
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Space | "new" | null>(null);
  const [tpl, setTpl] = useState<{ space: Space; template: Template | null } | null>(null);
  const [perms, setPerms] = useState<Space | null>(null);
  const load = useCallback(() => {
    governance.spaces().then(setSpaces, (e: Error) => alertDialog(e.message));
    governance.templates().then(setTemplates, () => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div>
      <Header
        title="Spaces"
        text="Every Project is in a space. A space's organizations are its access requirements (a user needs one of them); its inherited roles apply to all its Projects; its role set limits the roles Projects can grant. Space owners write Project templates; editors create Projects."
        action={
          <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
            <Icon name="plus" /> New space
          </button>
        }
      />
      <div className="space-y-3">
        {(spaces ?? []).map((s) => (
          <div key={s.id} className="rounded-xl border border-line bg-panel p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              {s.project_count !== null && <span className="text-xs text-muted">{s.project_count} projects</span>}
              <span className="text-xs text-muted">· you: {s.my_role ?? "no access"}</span>
              {s.deletion_pending && (
                <button
                  type="button"
                  onClick={() => governance.deleteSpace(s.id).then(load, (e: Error) => alertDialog(e.message))}
                  className="rounded bg-bad/15 px-1.5 text-xs text-bad"
                  title="Every organization of its deletion policy is gone"
                >
                  Marked for deletion · delete
                </button>
              )}
              <span className="ml-auto flex gap-3 text-xs">
                {s.my_workflows?.includes("manage_templates") && (
                  <button type="button" onClick={() => setTpl({ space: s, template: null })} className="text-ocean hover:underline">
                    New template
                  </button>
                )}
                {s.my_workflows?.includes("manage_space") && (
                  <>
                    <button type="button" onClick={() => setPerms(s)} className="text-ocean hover:underline">
                      Space permissions
                    </button>
                    <button type="button" onClick={() => setEditing(s)} className="text-ocean hover:underline">
                      Edit
                    </button>
                  </>
                )}
              </span>
            </div>
            {s.description && <p className="mt-1 text-xs text-muted">{s.description}</p>}
            <div className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
              <span>Organizations: {s.organizations.length ? s.organizations.map((o) => people.orgs.find((x) => x.id === o)?.name ?? o).join(", ") : "any user"}</span>
              <span>Role set: {s.role_set.length ? s.role_set.map((r) => people.roles.find((x) => x.id === r)?.name ?? r).join(", ") : "every role"}</span>
              <span>Inherited roles: {s.inherited_roles.length ? s.inherited_roles.map((r) => `${r.principal_type === "everyone" ? "Everyone" : principalLabel(`${r.principal_type}:${r.principal_id}`, people.users, people.groups)} · ${people.roles.find((x) => x.id === r.role)?.name ?? r.role}`).join(", ") : "none"}</span>
              <span>Editors: {s.editors.map((k) => principalLabel(k, people.users, people.groups)).join(", ") || "owners only"}</span>
              {(s.marketplace_inherited_roles ?? []).length > 0 && (
                <span>
                  Inherited by locked Marketplace Projects:{" "}
                  {(s.marketplace_inherited_roles ?? [])
                    .map((r) => `${r.principal_type === "everyone" ? "Everyone" : principalLabel(`${r.principal_type}:${r.principal_id}`, people.users, people.groups)} · ${people.roles.find((x) => x.id === r.role)?.name ?? r.role}`)
                    .join(", ")}
                </span>
              )}
              {(s.custom_roles ?? []).length > 0 && <span>Custom space roles: {(s.custom_roles ?? []).map((r) => r.name).join(", ")}</span>}
            </div>
            {templates.filter((t) => t.space_id === s.id).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                <span className="text-muted">Templates:</span>
                {templates
                  .filter((t) => t.space_id === s.id)
                  .map((t) => (
                    <button key={t.id} type="button" disabled={!s.my_workflows?.includes("manage_templates")} onClick={() => setTpl({ space: s, template: t })} className="rounded-full bg-panel-2 px-2 py-0.5 hover:text-white">
                      {t.name}
                    </button>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {editing && <SpaceDialog space={editing === "new" ? null : editing} people={people} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
      {tpl && <TemplateDialog space={tpl.space} template={tpl.template} people={people} onClose={() => setTpl(null)} onSaved={() => (setTpl(null), load())} />}
      {perms && <SpacePermissions space={perms} people={people} onClose={() => (setPerms(null), load())} />}
    </div>
  );
}

/** Space permissions: what the default roles allow, and the space's custom roles (workflows and who holds them). */
function SpacePermissions({ space, people, onClose }: { space: Space; people: People; onClose: () => void }) {
  const [s, setS] = useState(space);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof governance.spaceWorkflows>> | null>(null);
  const [edit, setEdit] = useState<SpaceRole | "new" | null>(null);
  const [draft, setDraft] = useState<Omit<SpaceRole, "id">>({ name: "", workflows: [], grants: [] });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    governance.spaceWorkflows().then(setInfo, (e: Error) => setError(e.message));
  }, []);
  const open = (r: SpaceRole | "new") => {
    setEdit(r);
    setDraft(r === "new" ? { name: "", workflows: [], grants: [] } : { name: r.name, workflows: r.workflows, grants: r.grants });
    setError(null);
  };
  const done = (p: Promise<Space>) => p.then((x) => (setS(x), setEdit(null)), (e: Error) => setError(e.message));
  return (
    <Modal title={`Space permissions · ${s.name}`} icon="lock" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <div className="grid gap-2 text-xs md:grid-cols-3">
          {(["viewer", "editor", "owner"] as const).map((r) => (
            <div key={r} className="rounded-lg border border-line p-2">
              <p className="font-medium capitalize">{r}</p>
              <p className="text-muted">{r === "viewer" ? "Everyone with access to the space" : principalsText(r === "owner" ? s.owners : s.editors, people) || (r === "owner" ? "administrators only" : "owners only")}</p>
              <ul className="mt-1 list-disc pl-4 text-muted">
                {(info?.workflows ?? [])
                  .filter((w) => info?.defaults[r].includes(w.id))
                  .map((w) => (
                    <li key={w.id}>{w.label}</li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center">
          <p className="font-medium">Custom roles</p>
          <button type="button" onClick={() => open("new")} className={`ml-auto ${buttonClass.secondary}`}>
            <Icon name="plus" /> New role
          </button>
        </div>
        {(s.custom_roles ?? []).length === 0 && <p className="text-xs text-muted">None. A custom role allows the workflows you pick; later workflows are not added to it.</p>}
        {(s.custom_roles ?? []).map((r) => (
          <div key={r.id} className="rounded-lg border border-line p-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted">{principalsText(r.grants, people) || "granted to nobody"}</span>
              <button type="button" onClick={() => open(r)} className="ml-auto text-ocean hover:underline">
                Edit
              </button>
              <button type="button" onClick={() => done(governance.deleteSpaceRole(s.id, r.id))} className="text-muted hover:text-bad">
                Delete
              </button>
            </div>
            <p className="mt-1 text-muted">{(info?.workflows ?? []).filter((w) => r.workflows.includes(w.id)).map((w) => w.label).join(" · ")}</p>
          </div>
        ))}
        {edit && (
          <div className="space-y-2 rounded-lg border border-line-2 p-3">
            <Field label="Name">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Workflows">
              <div className="grid gap-1 text-xs md:grid-cols-2">
                {(info?.workflows ?? []).map((w) => (
                  <label key={w.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draft.workflows.includes(w.id)}
                      onChange={() => setDraft({ ...draft, workflows: draft.workflows.includes(w.id) ? draft.workflows.filter((x) => x !== w.id) : [...draft.workflows, w.id] })}
                    />
                    {w.label}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Granted to">
              <PrincipalList value={draft.grants} onChange={(grants) => setDraft({ ...draft, grants })} users={people.users} groups={people.groups} everyone />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEdit(null)} className={buttonClass.secondary}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!draft.name.trim() || !draft.workflows.length}
                onClick={() => done(edit === "new" ? governance.createSpaceRole(s.id, draft) : governance.updateSpaceRole(s.id, edit.id, draft))}
                className={buttonClass.primary}
              >
                Save role
              </button>
            </div>
          </div>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
      </div>
    </Modal>
  );
}

const principalsText = (keys: string[], people: People) => keys.map((k) => (k === "everyone" ? "Everyone" : principalLabel(k, people.users, people.groups))).join(", ");

/** Role grants inherited by a space's Projects (regular, or locked Marketplace ones). */
function InheritedRoles({ value, onChange, people }: { value: RoleGrant[]; onChange: (v: RoleGrant[]) => void; people: People }) {
  const [inh, setInh] = useState({ who: "everyone", role: "viewer" });
  return (
    <div className="space-y-1 text-xs">
      {value.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="flex-1">{r.principal_type === "everyone" ? "Everyone" : principalLabel(`${r.principal_type}:${r.principal_id}`, people.users, people.groups)}</span>
          <span className="text-muted">{people.roles.find((x) => x.id === r.role)?.name ?? r.role}</span>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <select value={inh.who} onChange={(e) => setInh({ ...inh, who: e.target.value })} className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-1 py-0.5">
          <option value="everyone">Everyone</option>
          {people.groups.map((g) => (
            <option key={g.id} value={`group:${g.id}`}>
              Group · {g.name}
            </option>
          ))}
          {people.users.map((u) => (
            <option key={u.id} value={`user:${u.id}`}>
              {u.display_name || u.username}
            </option>
          ))}
        </select>
        <select value={inh.role} onChange={(e) => setInh({ ...inh, role: e.target.value })} className="rounded border border-line-2 bg-ink px-1 py-0.5">
          {people.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            const [t, id] = inh.who === "everyone" ? ["everyone", "*"] : inh.who.split(":");
            onChange([...value, { principal_type: t as RoleGrant["principal_type"], principal_id: id, role: inh.role }]);
          }}
          className="rounded border border-line-2 px-1.5 py-0.5"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function SpaceDialog({ space, people, onClose, onSaved }: { space: Space | null; people: People; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<SpaceBody>(space ? { ...EMPTY_SPACE, ...space } : EMPTY_SPACE);
  const [error, setError] = useState<string | null>(null);
  const save = () => (space ? governance.updateSpace(space.id, f) : governance.createSpace(f)).then(onSaved, (e: Error) => setError(e.message));
  return (
    <Modal title={space ? `Space · ${space.name}` : "New space"} icon="layers" onClose={onClose} wide>
      <div className="grid gap-3 p-4 text-sm md:grid-cols-2">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputClass} disabled={space?.builtin} />
        </Field>
        <Field label="Description">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Access requirements (organizations; any one grants access)">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {people.orgs.map((o) => (
              <label key={o.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={f.organizations.includes(o.id)}
                  onChange={() => setF({ ...f, organizations: f.organizations.includes(o.id) ? f.organizations.filter((x) => x !== o.id) : [...f.organizations, o.id] })}
                />
                {o.name}
              </label>
            ))}
            {people.orgs.length === 0 && <span className="text-muted">No organizations yet.</span>}
          </div>
        </Field>
        <Field label="Role set (roles its Projects may grant; none checked: all)">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {people.roles.map((r) => (
              <label key={r.id} className="flex items-center gap-1">
                <input type="checkbox" checked={f.role_set.includes(r.id)} onChange={() => setF({ ...f, role_set: f.role_set.includes(r.id) ? f.role_set.filter((x) => x !== r.id) : [...f.role_set, r.id] })} />
                {r.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Maximum classification (no file in its Projects may be classified higher)">
          <select value={f.max_classification ?? ""} onChange={(e) => setF({ ...f, max_classification: e.target.value || null })} className={inputClass}>
            <option value="">No maximum</option>
            {people.markings
              .filter((m) => m.category_kind === "hierarchical")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.category}, level {m.level ?? 0})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Storage of new files in its Projects">
          <select value={f.storage ?? "default"} onChange={(e) => setF({ ...f, storage: e.target.value as SpaceBody["storage"] })} className={inputClass}>
            <option value="default">The platform&apos;s storage</option>
            <option value="local">This machine&apos;s disk</option>
            <option value="s3">S3</option>
          </select>
        </Field>
        <Field label="Resource queue (unless a queue lists the Project)">
          <input value={f.resource_queue ?? ""} onChange={(e) => setF({ ...f, resource_queue: e.target.value || null })} placeholder="queue id (Resource Management → Queues)" className={inputClass} />
        </Field>
        <Field label="Usage account">
          <input value={f.usage_account ?? ""} onChange={(e) => setF({ ...f, usage_account: e.target.value })} placeholder="e.g. cost center" className={inputClass} />
        </Field>
        <Field label="Maven group (what its Projects publish)">
          <input value={f.maven_group ?? ""} onChange={(e) => setF({ ...f, maven_group: e.target.value })} placeholder="com.example.team" className={inputClass} />
        </Field>
        <Field label="Deletion policy (marked for deletion once all these organizations are deleted)">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {people.orgs.map((o) => (
              <label key={o.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={(f.deletion_organizations ?? []).includes(o.id)}
                  onChange={() =>
                    setF({ ...f, deletion_organizations: (f.deletion_organizations ?? []).includes(o.id) ? (f.deletion_organizations ?? []).filter((x) => x !== o.id) : [...(f.deletion_organizations ?? []), o.id] })
                  }
                />
                {o.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Owners (manage the space and its templates)">
          <PrincipalList value={f.owners} onChange={(owners) => setF({ ...f, owners })} users={people.users} groups={people.groups} everyone />
        </Field>
        <Field label="Editors (create Projects and portfolios)">
          <PrincipalList value={f.editors} onChange={(editors) => setF({ ...f, editors })} users={people.users} groups={people.groups} everyone />
        </Field>
        <div className="md:col-span-2">
          <Field label="Inherited roles (granted on every Project in the space)">
            <InheritedRoles value={f.inherited_roles} onChange={(inherited_roles) => setF({ ...f, inherited_roles })} people={people} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Inherited roles of locked Marketplace Projects (instead of the above; nobody edits them)">
            <InheritedRoles value={f.marketplace_inherited_roles ?? []} onChange={(marketplace_inherited_roles) => setF({ ...f, marketplace_inherited_roles })} people={people} />
          </Field>
        </div>
        {error && <p className="text-xs text-bad md:col-span-2">{error}</p>}
        <div className="flex justify-end gap-2 md:col-span-2">
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

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function TemplateDialog({ space, template, people, onClose, onSaved }: { space: Space; template: Template | null; people: People; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<TemplateBody>(
    template ?? {
      space_id: space.id,
      name: "",
      description: "",
      variables: [],
      creator_role: "owner",
      roles: [],
      default_role: null,
      new_groups: [],
      new_markings: [],
      markings: [],
      constraints: { mode: "none", markings: [] },
      folders: [],
    },
  );
  const [text, setText] = useState({
    variables: f.variables.join("\n"),
    groups: f.new_groups.map((g) => g.name).join("\n"),
    markings: f.new_markings.map((m) => m.name).join("\n"),
    folders: f.folders.join("\n"),
  });
  const [error, setError] = useState<string | null>(null);
  const body = (): TemplateBody => ({
    ...f,
    variables: lines(text.variables),
    new_groups: lines(text.groups).map((name) => ({ name })),
    new_markings: lines(text.markings).map((name) => ({ name })),
    folders: lines(text.folders),
  });
  const save = () => (template ? governance.updateTemplate(template.id, body()) : governance.createTemplate(body())).then(onSaved, (e: Error) => setError(e.message));
  const roleWho = [
    { key: "everyone", label: "Everyone" },
    ...lines(text.groups).map((g, i) => ({ key: `newgroup:${i}`, label: `New group · ${g}` })),
    ...people.groups.map((g) => ({ key: `group:${g.id}`, label: `Group · ${g.name}` })),
    ...people.users.map((u) => ({ key: `user:${u.id}`, label: u.display_name || u.username })),
  ];
  return (
    <Modal title={template ? `Template · ${template.name}` : `New Project template in ${space.name}`} icon="layers" onClose={onClose} wide>
      <div className="grid gap-3 p-4 text-sm md:grid-cols-2">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Case investigation" className={inputClass} />
        </Field>
        <Field label="Description">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Variables (one per line; use {{name}} in groups, markings and folders)">
          <textarea value={text.variables} onChange={(e) => setText({ ...text, variables: e.target.value })} rows={3} className={inputClass} placeholder="case" />
        </Field>
        <Field label="Folders (one path per line)">
          <textarea value={text.folders} onChange={(e) => setText({ ...text, folders: e.target.value })} rows={3} className={inputClass} placeholder={"raw\nclean/{{case}}"} />
        </Field>
        <Field label="New groups (one per line)">
          <textarea value={text.groups} onChange={(e) => setText({ ...text, groups: e.target.value })} rows={3} className={inputClass} placeholder="{{case}} editors" />
        </Field>
        <Field label="Manager group (its members manage the other new groups)">
          <select
            value={f.manager_group ?? ""}
            onChange={(e) => setF({ ...f, manager_group: e.target.value === "" ? null : Number(e.target.value) })}
            className={inputClass}
          >
            <option value="">None (the creator manages them)</option>
            {lines(text.groups).map((g, i) => (
              <option key={i} value={i}>
                {g}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New markings (one per line; granted to everyone given a role)">
          <textarea value={text.markings} onChange={(e) => setText({ ...text, markings: e.target.value })} rows={3} className={inputClass} placeholder="{{case}} sensitive" />
        </Field>
        <Field label="The creator's role">
          <select value={f.creator_role ?? ""} onChange={(e) => setF({ ...f, creator_role: e.target.value || null })} className={inputClass}>
            <option value="">None</option>
            {people.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default role for everyone">
          <select value={f.default_role ?? ""} onChange={(e) => setF({ ...f, default_role: e.target.value || null })} className={inputClass}>
            <option value="">None</option>
            <option value="discoverer">Discoverer</option>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label="Role grants">
            <div className="space-y-1 text-xs">
              {f.roles.map((r, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <select value={r.principal} onChange={(e) => setF({ ...f, roles: f.roles.map((x, j) => (j === i ? { ...x, principal: e.target.value } : x)) })} className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-1 py-0.5">
                    {roleWho.map((w) => (
                      <option key={w.key} value={w.key}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                  <select value={r.role} onChange={(e) => setF({ ...f, roles: f.roles.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} className="rounded border border-line-2 bg-ink px-1 py-0.5">
                    {people.roles.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setF({ ...f, roles: f.roles.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                    ×
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => setF({ ...f, roles: [...f.roles, { principal: roleWho[0].key, role: "viewer" }] })} className="text-ocean hover:underline">
                + Add a grant
              </button>
            </div>
          </Field>
        </div>
        <Field label="Existing markings on the Project">
          <div className="flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-y-auto text-xs">
            {people.markings.map((m) => (
              <label key={m.id} className="flex items-center gap-1">
                <input type="checkbox" checked={f.markings.includes(m.id)} onChange={() => setF({ ...f, markings: f.markings.includes(m.id) ? f.markings.filter((x) => x !== m.id) : [...f.markings, m.id] })} />
                {m.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Project constraint">
          <select value={f.constraints.mode} onChange={(e) => setF({ ...f, constraints: { ...f.constraints, mode: e.target.value as TemplateBody["constraints"]["mode"] } })} className={inputClass}>
            <option value="none">No constraint</option>
            <option value="allowed">Only allowed markings (new markings are allowed)</option>
            <option value="prohibited">Prohibited markings</option>
          </select>
          {f.constraints.mode !== "none" && (
            <div className="mt-1 flex max-h-24 flex-wrap gap-x-3 gap-y-1 overflow-y-auto text-xs">
              {people.markings.map((m) => (
                <label key={m.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={f.constraints.markings.includes(m.id)}
                    onChange={() =>
                      setF({ ...f, constraints: { ...f.constraints, markings: f.constraints.markings.includes(m.id) ? f.constraints.markings.filter((x) => x !== m.id) : [...f.constraints.markings, m.id] } })
                    }
                  />
                  {m.name}
                </label>
              ))}
            </div>
          )}
        </Field>
        <p className="text-xs text-muted md:col-span-2">Templates that create groups or markings are deployed by administrators.</p>
        {error && <p className="text-xs text-bad md:col-span-2">{error}</p>}
        <div className="flex items-center gap-2 md:col-span-2">
          {template && (
            <button
              type="button"
              onClick={async () => {
                if (await confirmDialog(`Delete the template ${template.name}?`)) governance.deleteTemplate(template.id).then(onSaved, (e: Error) => setError(e.message));
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
