"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { auth, type Group, type Marking, type User } from "@/lib/auth";
import { approvals, fmtTime, STATUS_LABEL, STATUS_TONE, TASK_LABEL, type ApprovalStatus, type ApprovalSummary } from "@/lib/securityGov";

const FILTERS = [["inbox", "Your inbox"], ["created", "Created by you"], ["all", "All you can see"]] as const;

/** Approvals inbox: requests for changes reviewed by the users who may make them. */
export default function ApprovalsPage() {
  const [filter, setFilter] = useState<"inbox" | "created" | "all">("inbox");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ApprovalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    approvals.list({ filter, status, kind, q }).then(setRows, (e: Error) => setError(e.message));
  }, [filter, status, kind, q]);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Approvals" icon="check" href="/approvals" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]}>
        <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" />New request</button>
      </AppHeader>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 space-y-4 border-b border-line bg-panel p-4 md:w-60 md:border-b-0 md:border-r">
          <div className="space-y-1">
            {FILTERS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setFilter(id)}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${filter === id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
                <Icon name={id === "inbox" ? "bell" : id === "created" ? "edit" : "list"} className="h-4 w-4" />{label}
              </button>
            ))}
          </div>
          <label className="block space-y-1 text-xs"><span className="text-muted">Status</span>
            <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-xs"><span className="text-muted">Type</span>
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Any</option>
              {Object.entries(TASK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <input className={inputClass} placeholder="Search requests" value={q} onChange={(e) => setQ(e.target.value)} />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto bg-ink p-4 md:p-6">
          {error ? <ApiError message={error} /> : !rows ? <Loading /> : (
            <Card title={FILTERS.find((f) => f[0] === filter)?.[1] ?? "Requests"} count={rows.length}>
              {!rows.length ? <p className="p-4 text-sm text-muted">No requests here. Requests are kept after they are completed, as a record of past decisions.</p> : (
                <ul className="divide-y divide-line">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <Link href={r.external ?? `/approvals/${r.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-panel-2">
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{r.title}</span>
                          <span className="block truncate text-xs text-muted">{r.tasks.map((t) => TASK_LABEL[t.kind]).join(" · ")} · by {r.created_by_name} · {fmtTime(r.created_at)}</span>
                        </span>
                        <span className="text-xs text-muted">{r.tasks.filter((t) => t.state === "approved").length}/{r.tasks.length} approved</span>
                        <span className={`text-xs font-medium ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status as ApprovalStatus]}</span>
                        {r.external && <Icon name="external" className="h-3.5 w-3.5 text-muted" />}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </main>
      </div>
      {creating && <NewRequest onClose={() => setCreating(false)} />}
    </div>
  );
}

type Draft = { kind: "project_access" | "group_membership" | "marking_access" | "add_reference"; project?: { id: string; name: string }; item?: { id: string; name: string }; role: string; group: string; marking: string; users: string[] };

function NewRequest({ onClose }: { onClose: () => void }) {
  const { me } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [tasks, setTasks] = useState<Draft[]>([{ kind: "project_access", role: "viewer", group: "", marking: "", users: [] }]);
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [picking, setPicking] = useState<{ i: number; what: "project" | "item" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    auth.users().then(setUsers, () => {});
    auth.groups().then(setGroups, () => {});
    auth.markings().then(setMarkings, () => {});
  }, []);
  const set = (i: number, x: Partial<Draft>) => setTasks((t) => t.map((d, n) => (n === i ? { ...d, ...x } : d)));
  const submit = async () => {
    const meId = me?.id ?? "local";
    try {
      const r = await approvals.create({
        title, description: why,
        tasks: tasks.map((d) =>
          d.kind === "project_access" ? { kind: d.kind, params: { project_id: d.project?.id, principal_type: "user", principal_id: d.users[0] ?? meId, role: d.role } }
            : d.kind === "group_membership" ? { kind: d.kind, params: { group_id: d.group, users: d.users.length ? d.users : [meId] } }
              : d.kind === "marking_access" ? { kind: d.kind, params: { marking_id: d.marking, user_id: d.users[0] ?? meId } }
                : { kind: d.kind, params: { project_id: d.project?.id, item_id: d.item?.id } }),
      });
      router.push(`/approvals/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const forWhom = (i: number, d: Draft, multiple: boolean) => (
    <label className="block space-y-1"><span className="text-xs text-muted">{multiple ? "Users (empty: you)" : "For (empty: you)"}</span>
      <select className={inputClass} value="" onChange={(e) => e.target.value && set(i, { users: multiple ? [...new Set([...d.users, e.target.value])] : [e.target.value] })}>
        <option value="">{d.users.length ? d.users.map((u) => users.find((x) => x.id === u)?.username ?? u).join(", ") : "You"}</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
      </select>
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl space-y-3 overflow-y-auto rounded-xl border border-line bg-panel p-5 text-sm">
        <h2 className="text-base font-semibold">New request</h2>
        <input className={inputClass} placeholder="Title (optional: built from the tasks)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className={`${inputClass} min-h-16`} placeholder="Why is this needed? Reviewers see it." value={why} onChange={(e) => setWhy(e.target.value)} />
        {tasks.map((d, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <select className={fieldClass} value={d.kind} onChange={(e) => set(i, { kind: e.target.value as Draft["kind"] })}>
                {(["project_access", "group_membership", "marking_access", "add_reference"] as const).map((k) => <option key={k} value={k}>{TASK_LABEL[k]}</option>)}
              </select>
              {tasks.length > 1 && <button type="button" className={`${buttonClass.ghost} ml-auto`} onClick={() => setTasks((t) => t.filter((_, n) => n !== i))}><Icon name="trash" className="h-4 w-4" /></button>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(d.kind === "project_access" || d.kind === "add_reference") && (
                <button type="button" className={buttonClass.secondary} onClick={() => setPicking({ i, what: "project" })}><Icon name="project" className="h-4 w-4" />{d.project?.name ?? "Choose the Project…"}</button>
              )}
              {d.kind === "project_access" && (
                <>
                  <select className={inputClass} value={d.role} onChange={(e) => set(i, { role: e.target.value })}>
                    <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option>
                  </select>
                  {forWhom(i, d, false)}
                </>
              )}
              {d.kind === "add_reference" && (
                <button type="button" className={buttonClass.secondary} onClick={() => setPicking({ i, what: "item" })}><Icon name="doc" className="h-4 w-4" />{d.item?.name ?? "Resource to reference…"}</button>
              )}
              {d.kind === "group_membership" && (
                <>
                  <select className={inputClass} value={d.group} onChange={(e) => set(i, { group: e.target.value })}>
                    <option value="">Choose a group…</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  {forWhom(i, d, true)}
                </>
              )}
              {d.kind === "marking_access" && (
                <>
                  <select className={inputClass} value={d.marking} onChange={(e) => set(i, { marking: e.target.value })}>
                    <option value="">Choose a marking…</option>
                    {markings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  {forWhom(i, d, false)}
                </>
              )}
            </div>
          </div>
        ))}
        <button type="button" className={buttonClass.ghost} onClick={() => setTasks((t) => [...t, { kind: "group_membership", role: "viewer", group: "", marking: "", users: [] }])}><Icon name="plus" className="h-4 w-4" />Add a task</button>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={buttonClass.primary} onClick={submit}>Send request</button>
        </div>
      </div>
      {picking && (
        picking.what === "project" ? (
          <DrivePicker title="The Project" onClose={() => setPicking(null)} folder={{ action: "Use this Project", onPick: (f) => { if (f.id) set(picking.i, { project: { id: f.id, name: f.name } }); setPicking(null); } }} />
        ) : (
          <DrivePicker title="The resource to reference" onClose={() => setPicking(null)} onPick={(it) => { set(picking.i, { item: { id: it.id, name: it.name } }); setPicking(null); }} />
        )
      )}
    </div>
  );
}
