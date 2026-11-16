"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { downloadProduct, InstallProduct } from "@/components/security/MarketplaceProduct";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { useAuth } from "@/components/AuthGate";
import { auth, type Group, type Marking, type Organization, type User } from "@/lib/auth";
import { checkpointsApi, type CheckpointCondition, type CheckpointConfig, type CheckpointRecord, type CheckpointType } from "@/lib/checkpoints";
import { renderMarkdown } from "@/lib/markdown";
import { ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import { fmtTime } from "@/lib/securityGov";

type Tab = "review" | "configurations" | "mine";
type Lookups = { users: User[]; groups: Group[]; markings: Marking[]; orgs: Organization[]; objectTypes: ObjectType[]; actionTypes: ActionType[]; types: CheckpointType[] };
const KIND_LABEL: Record<CheckpointCondition["kind"], string> = {
  location: "Locations", user: "User submitting checkpoint", selected: "Selected user or group", marking: "Markings", action_type: "Action type", object_type: "Object type",
};

/** Checkpoints: purpose justification prompts on sensitive interactions, their configurations and records. */
export default function CheckpointsPage() {
  const { me, enabled } = useAuth();
  const admin = !enabled || me?.role === "admin";
  const [tab, setTab] = useState<Tab>("review");
  const [lk, setLk] = useState<Lookups | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([
      auth.users().catch(() => [] as User[]), auth.groups().catch(() => [] as Group[]), auth.markings().catch(() => [] as Marking[]),
      auth.organizations().catch(() => [] as Organization[]), ontology.objectTypes().catch(() => [] as ObjectType[]), ontology.actionTypes().catch(() => [] as ActionType[]),
      checkpointsApi.types(),
    ]).then(([users, groups, markings, orgs, objectTypes, actionTypes, types]) => setLk({ users, groups, markings, orgs, objectTypes, actionTypes, types }), (e: Error) => setError(e.message));
  }, []);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Checkpoints" icon="lock" href="/checkpoints" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]} />
      <div className="flex shrink-0 gap-1 border-b border-line bg-panel px-4">
        {([["review", "Review", "list"], ["configurations", "Configurations", "sliders"], ["mine", "My records", "history"]] as const).map(([id, label, icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
            <Icon name={icon} className="h-4 w-4" />{label}
          </button>
        ))}
      </div>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
          {error ? <ApiError message={error} /> : !lk ? <Loading /> : (
            <>
              {tab === "review" && <Records lk={lk} mine={false} />}
              {tab === "mine" && <Records lk={lk} mine />}
              {tab === "configurations" && <Configurations lk={lk} admin={admin} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

const nameOf = (lk: Lookups, kind: string, id: string) =>
  kind === "user" ? lk.users.find((u) => u.id === id)?.username
    : kind === "group" ? lk.groups.find((g) => g.id === id)?.name
      : kind === "marking" ? lk.markings.find((m) => m.id === id)?.name ?? lk.orgs.find((o) => `org:${o.id}` === id)?.name
        : kind === "action_type" || kind === "action-type" ? lk.actionTypes.find((a) => a.id === id)?.display_name
          : kind === "object_type" ? lk.objectTypes.find((o) => o.id === id)?.display_name : undefined;

function Records({ lk, mine }: { lk: Lookups; mine: boolean }) {
  const [type, setType] = useState("");
  const [user, setUser] = useState("");
  const [org, setOrg] = useState("");
  const [resource, setResource] = useState("");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ total: number; records: CheckpointRecord[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CheckpointRecord | null>(null);
  useEffect(() => {
    const start = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19);
    checkpointsApi.records({ type, user_id: user, org, resource, start, mine: mine ? "true" : undefined }).then(setData, (e: Error) => setError(e.message));
  }, [type, user, org, resource, days, mine]);
  const typeName = (t: string) => lk.types.find((x) => x.id === t)?.name ?? t;
  const justText = (r: CheckpointRecord) => r.justification.response ?? r.justification.selected?.join(", ") ?? (r.justification.acknowledged ? `✓ ${r.justification.checkbox_text ?? "Acknowledged"}` : r.justification.reauthenticated ? "Reauthenticated" : "—");
  return (
    <>
      <Card title={mine ? "Checkpoints you submitted" : "Checkpoint records you can review"} count={data?.total}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <select className={fieldClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[[1, "Last day"], [7, "Last 7 days"], [30, "Last 30 days"], [365, "Last year"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className={fieldClass} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Any checkpoint type</option>
            {lk.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {!mine && (
            <>
              <select className={fieldClass} value={user} onChange={(e) => setUser(e.target.value)}>
                <option value="">Any user</option>
                {lk.users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
              </select>
              <select className={fieldClass} value={org} onChange={(e) => setOrg(e.target.value)}>
                <option value="">Any organization</option>
                <option value="default">Users without an organization</option>
                {lk.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </>
          )}
          <input className={`${fieldClass} w-56`} placeholder="Checkpointed resource id" value={resource} onChange={(e) => setResource(e.target.value)} />
        </div>
        {error ? <ApiError message={error} /> : !data ? <Loading /> : !data.records.length ? <p className="p-4 text-sm text-muted">No checkpoint records.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="text-muted"><tr className="border-b border-line">{["Created", "User", "Checkpoint type", "Justification", "Checkpointed items"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {data.records.map((r) => (
                  <tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer border-b border-line/60 hover:bg-panel-2">
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtTime(r.created_at)}</td>
                    <td className="px-3 py-2">{r.username}</td>
                    <td className="px-3 py-2">{typeName(r.type)}</td>
                    <td className="max-w-[20rem] truncate px-3 py-2 text-soft">{justText(r)}</td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-muted">{r.items.map((i) => i.name ?? nameOf(lk, i.type ?? "", i.id) ?? i.id).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setOpen(null)}>
          <aside className="h-full w-full max-w-lg space-y-3 overflow-y-auto border-l border-line bg-panel p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2"><h2 className="flex-1 font-semibold">{open.title}</h2><button type="button" className={buttonClass.ghost} onClick={() => setOpen(null)}><Icon name="x" className="h-4 w-4" /></button></div>
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
              {([["User", open.username], ["Created", fmtTime(open.created_at)], ["Checkpoint type", typeName(open.type)], ["Configuration", open.config_name],
                ["Organization", open.org], ["Checkpoint RID", open.rid], ["Configuration RID", open.config_rid]] as [string, string][]).map(([k, v]) => (
                <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="break-all">{v}</dd></Fragment>
              ))}
            </dl>
            <div className="rounded border border-line p-3">
              <div className="text-xs text-muted">Checkpoint language (as shown)</div>
              <div className="mt-1 text-sm text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(open.prompt) }} />
              {open.description && <div className="mt-1 text-xs text-muted" dangerouslySetInnerHTML={{ __html: renderMarkdown(open.description) }} />}
            </div>
            <div><div className="text-xs text-muted">Justification</div><p className="mt-1">{justText(open)}{open.justification.selected && open.justification.response ? ` — ${open.justification.response}` : ""}</p></div>
            <div>
              <div className="text-xs text-muted">Checkpointed items</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {open.items.map((i, n) => <li key={n}><span className="text-muted">{i.type}</span> {i.name ?? nameOf(lk, i.type ?? "", i.id) ?? i.id}</li>)}
                {open.selected.map((s, n) => <li key={`s${n}`}><span className="text-muted">selected {s.type}</span> {nameOf(lk, s.type, s.id) ?? s.id}{s.role ? ` (${s.role})` : ""}</li>)}
                {!open.items.length && !open.selected.length && <li className="text-muted">—</li>}
              </ul>
            </div>
            {!!open.markings.length && <div className="text-xs"><span className="text-muted">Markings </span>{open.markings.map((m) => nameOf(lk, "marking", m) ?? m).join(", ")}</div>}
          </aside>
        </div>
      )}
    </>
  );
}

const EMPTY: Omit<CheckpointConfig, "id" | "rid"> = {
  name: "", description: "", types: [], scope: { kind: "organization", id: "*" }, conditions: [], title: "", prompt: "", description_text: "",
  justification: { kind: "response", checkbox_text: "I acknowledge", validation: "", options: [], multiple: false, free_text: "none", recent: true },
  frequency_minutes: null, enabled: true,
};

function Configurations({ lk, admin }: { lk: Lookups; admin: boolean }) {
  const [rows, setRows] = useState<CheckpointConfig[] | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; c: Omit<CheckpointConfig, "id" | "rid"> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => checkpointsApi.configs().then(setRows, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const typeName = (t: string) => lk.types.find((x) => x.id === t)?.name ?? t;
  const scopeLabel = (s: CheckpointConfig["scope"]) =>
    s.kind === "project" ? `Project ${s.id}` : s.id === "*" ? "Every user" : s.id === "default" ? "Users without an organization" : `Organization ${lk.orgs.find((o) => o.id === s.id)?.name ?? s.id}`;
  if (edit) return <Editor lk={lk} initial={edit.c} id={edit.id} admin={admin} onClose={() => { setEdit(null); void load(); }} />;
  return (
    <Card title="Checkpoint configurations" count={rows?.length} action={
      <span className="flex flex-wrap items-center gap-2">
        <InstallProduct kind="bluesandai.checkpoints.product" label="Install product" install={(p, project) => checkpointsApi.install(p, project).then(load)} />
        <button type="button" className={buttonClass.primary} onClick={() => setEdit({ id: null, c: EMPTY })}><Icon name="plus" className="h-4 w-4" />New configuration</button>
      </span>}>
      {error ? <ApiError message={error} /> : !rows ? <Loading /> : !rows.length ? (
        <p className="p-4 text-sm text-muted">No checkpoints are configured. Administrators (data governance officers) configure organization-wide checkpoints; Project Owners configure checkpoints on their Project&apos;s resources.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className={`h-2 w-2 rounded-full ${c.enabled ? "bg-ok" : "bg-muted"}`} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.name}</span>
                <span className="block text-xs text-muted">{c.types.map(typeName).join(", ")} · {scopeLabel(c.scope)} · {c.justification.kind}{c.conditions.length ? ` · ${c.conditions.length} condition${c.conditions.length > 1 ? "s" : ""}` : ""}</span>
              </span>
              <button type="button" className={buttonClass.secondary} onClick={() => setEdit({ id: c.id, c: { ...EMPTY, ...c } })}><Icon name="edit" className="h-4 w-4" />Edit</button>
              <button type="button" className={buttonClass.ghost} title="Package as a Marketplace product" onClick={() => checkpointsApi.package(c.id).then((p) => downloadProduct(c.name, p), (e: Error) => setError(e.message))}><Icon name="download" className="h-4 w-4" />Package</button>
              <button type="button" className={buttonClass.ghost} onClick={() => checkpointsApi.remove(c.id).then(load, (e: Error) => setError(e.message))}><Icon name="trash" className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Editor({ lk, initial, id, admin, onClose }: { lk: Lookups; initial: Omit<CheckpointConfig, "id" | "rid">; id: string | null; admin: boolean; onClose: () => void }) {
  const [c, setC] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | "scope" | null>(null);
  const [scopeName, setScopeName] = useState<string | null>(null);
  const set = (x: Partial<typeof c>) => setC((o) => ({ ...o, ...x }));
  const j = c.justification;
  const setJ = (x: Partial<typeof j>) => set({ justification: { ...j, ...x } });
  const common = useMemo(() => {
    const sel = lk.types.filter((t) => c.types.includes(t.id));
    return sel.length ? sel.map((t) => t.conditions).reduce((a, b) => a.filter((k) => b.includes(k))) : [];
  }, [lk.types, c.types]);
  const groups = useMemo(() => [...new Set(lk.types.map((t) => t.group))], [lk.types]);
  const setCond = (i: number, x: Partial<CheckpointCondition>) => set({ conditions: c.conditions.map((k, n) => (n === i ? { ...k, ...x } : k)) });
  const save = async () => {
    try {
      if (id) await checkpointsApi.update(id, c);
      else await checkpointsApi.create(c);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const options = (kind: CheckpointCondition["kind"]): { id: string; name: string }[] =>
    kind === "user" || kind === "selected"
      ? [...lk.users.map((u) => ({ id: u.id, name: `User: ${u.display_name || u.username}` })), ...lk.groups.map((g) => ({ id: g.id, name: `Group: ${g.name}` }))]
      : kind === "marking" ? [...lk.markings.map((m) => ({ id: m.id, name: m.name })), ...lk.orgs.map((o) => ({ id: `org:${o.id}`, name: `Organization: ${o.name}` }))]
        : kind === "action_type" ? lk.actionTypes.map((a) => ({ id: a.id, name: a.display_name }))
          : kind === "object_type" ? lk.objectTypes.map((o) => ({ id: o.id, name: o.display_name })) : [];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button type="button" className={buttonClass.ghost} onClick={onClose}><Icon name="left" className="h-4 w-4" />Configurations</button>
        <h1 className="text-lg font-semibold">{id ? "Edit checkpoint configuration" : "New checkpoint configuration"}</h1>
      </div>
      {error && <p className="rounded border border-bad/30 bg-bad/10 p-2 text-sm text-bad">{error}</p>}
      <Card title="1 · Conditions">
        <div className="space-y-4 p-4 text-sm">
          <div>
            <div className="mb-1 text-xs text-muted">Checkpoint types (interactions that show the checkpoint)</div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => (
                <div key={g} className="rounded border border-line p-2">
                  <div className="mb-1 text-xs font-semibold text-soft">{g}</div>
                  {lk.types.filter((t) => t.group === g).map((t) => (
                    <label key={t.id} className="flex items-center gap-2 py-0.5 text-xs" title={t.application}>
                      <input type="checkbox" checked={c.types.includes(t.id)} onChange={(e) => set({ types: e.target.checked ? [...c.types, t.id] : c.types.filter((x) => x !== t.id) })} />
                      {t.name}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Scope</span>
            <select className={fieldClass} value={c.scope.kind === "project" ? "project" : c.scope.id} onChange={(e) => e.target.value === "project" ? setPicking("scope") : set({ scope: { kind: "organization", id: e.target.value } })}>
              {admin && <option value="*">Every user (all organizations)</option>}
              {admin && <option value="default">Users without an organization</option>}
              {admin && lk.orgs.map((o) => <option key={o.id} value={o.id}>Organization: {o.name}</option>)}
              {/* a Project Owner has no organization-wide scope: without this the only option is already selected and never opens the picker */}
              {!admin && c.scope.kind !== "project" && <option value={c.scope.id}>Choose a scope…</option>}
              {/* a Project scope covers resources: types without one (object set export, actions, Cipher …) are organization-wide only */}
              <option value="project" disabled={c.scope.kind !== "project" && c.types.some((t) => !lk.types.find((x) => x.id === t)?.resources)}>
                {c.scope.kind === "project" ? `Project ${scopeName ?? c.scope.id}` : c.types.some((t) => !lk.types.find((x) => x.id === t)?.resources) ? "A Project (not for these checkpoint types)" : "A Project (its resources)…"}
              </option>
            </select>
            {c.scope.kind === "project" && <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => setPicking("scope")}>Change Project…</button>}
            {!admin && c.scope.kind !== "project" && <span className="text-xs text-muted">Project Owners scope a checkpoint to their Project.</span>}
          </div>
          <div className="space-y-2">
            <div className="text-xs text-muted">Additional conditions (AND; NOT makes an exemption)</div>
            {c.conditions.map((k, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-line p-2">
                <select className={`${fieldClass} text-xs`} value={k.negate ? "not" : "and"} onChange={(e) => setCond(i, { negate: e.target.value === "not" })}>
                  <option value="and">AND</option><option value="not">NOT</option>
                </select>
                <span className="text-xs font-medium">{KIND_LABEL[k.kind]}</span>
                {k.ids.map((x) => (
                  <button key={x} type="button" className="rounded-full bg-panel-2 px-2 py-0.5 text-xs ring-1 ring-line-2 hover:text-bad" onClick={() => setCond(i, { ids: k.ids.filter((y) => y !== x) })}>
                    {options(k.kind).find((o) => o.id === x)?.name ?? x} ×
                  </button>
                ))}
                {k.kind === "location" ? (
                  <button type="button" className={`${buttonClass.secondary} text-xs`} onClick={() => setPicking(i)}><Icon name="folder" className="h-3.5 w-3.5" />Add a folder or Project</button>
                ) : (
                  <select className={`${fieldClass} text-xs`} value="" onChange={(e) => e.target.value && setCond(i, { ids: [...new Set([...k.ids, e.target.value])] })}>
                    <option value="">Add…</option>
                    {options(k.kind).filter((o) => !k.ids.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                )}
                <button type="button" className={`${buttonClass.ghost} ml-auto`} onClick={() => set({ conditions: c.conditions.filter((_, n) => n !== i) })}><Icon name="trash" className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <select className={`${fieldClass} text-xs`} value="" disabled={!c.types.length}
              onChange={(e) => e.target.value && set({ conditions: [...c.conditions, { kind: e.target.value as CheckpointCondition["kind"], ids: [], negate: false }] })}>
              <option value="">{c.types.length ? "Add a condition…" : "Choose checkpoint types first"}</option>
              {common.map((k) => <option key={k} value={k}>{KIND_LABEL[k as CheckpointCondition["kind"]]}</option>)}
            </select>
          </div>
        </div>
      </Card>
      <Card title="2 · Prompt">
        <div className="grid gap-3 p-4 text-sm md:grid-cols-2">
          <label className="space-y-1"><span className="text-xs text-muted">Checkpoint title (keep it under 45 characters)</span><input className={inputClass} value={c.title} onChange={(e) => set({ title: e.target.value })} /></label>
          <div />
          <label className="space-y-1"><span className="text-xs text-muted">Checkpoint prompt (Markdown)</span><textarea className={`${inputClass} min-h-24`} value={c.prompt} onChange={(e) => set({ prompt: e.target.value })} /></label>
          <label className="space-y-1"><span className="text-xs text-muted">Checkpoint description (optional, Markdown)</span><textarea className={`${inputClass} min-h-24`} value={c.description_text} onChange={(e) => set({ description_text: e.target.value })} /></label>
        </div>
      </Card>
      <Card title="3 · Justification">
        <div className="space-y-3 p-4 text-sm">
          <div className="flex flex-wrap gap-3">
            {(["acknowledgment", "response", "dropdown", "reauthentication"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5 capitalize"><input type="radio" checked={j.kind === k} onChange={() => setJ({ kind: k })} />{k}</label>
            ))}
          </div>
          {j.kind === "acknowledgment" && <label className="block space-y-1"><span className="text-xs text-muted">Checkbox text</span><input className={inputClass} value={j.checkbox_text} onChange={(e) => setJ({ checkbox_text: e.target.value })} /></label>}
          {j.kind === "response" && <label className="block space-y-1"><span className="text-xs text-muted">Response validation (regular expression; empty accepts any response)</span><input className={`${inputClass} font-mono`} value={j.validation} onChange={(e) => setJ({ validation: e.target.value })} placeholder="^[A-Z]+-\d+ .+" /></label>}
          {j.kind === "dropdown" && (
            <div className="space-y-2">
              <label className="block space-y-1"><span className="text-xs text-muted">Options (one per line)</span>
                <textarea className={`${inputClass} min-h-20`} value={j.options.join("\n")} onChange={(e) => setJ({ options: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} /></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={j.multiple} onChange={(e) => setJ({ multiple: e.target.checked })} />Users can select several</label>
              <label className="flex items-center gap-2">Free text
                <select className={fieldClass} value={j.free_text} onChange={(e) => setJ({ free_text: e.target.value as typeof j.free_text })}>
                  <option value="none">none</option><option value="optional">optional</option><option value="required">required</option>
                </select>
              </label>
            </div>
          )}
          {j.kind === "reauthentication" && <p className="text-xs text-muted">Users confirm with their password (and two-factor code when set up). Not available for Login checkpoints or for API clients.</p>}
          {(j.kind === "response" || j.kind === "dropdown") && <label className="flex items-center gap-2"><input type="checkbox" checked={j.recent} onChange={(e) => setJ({ recent: e.target.checked })} />Display recent justifications (a user&apos;s last 5 from the past month)</label>}
          {c.types.length === 1 && c.types[0] === "login" && (
            <label className="flex items-center gap-2">Show again only after
              <input className={`${fieldClass} w-24`} value={c.frequency_minutes ?? ""} onChange={(e) => set({ frequency_minutes: e.target.value ? Number(e.target.value.replace(/\D/g, "")) : null })} /> minutes (empty: every sign-in)
            </label>
          )}
        </div>
      </Card>
      <Card title="4 · Name">
        <div className="grid gap-3 p-4 text-sm md:grid-cols-2">
          <label className="space-y-1"><span className="text-xs text-muted">Configuration name (not shown to users)</span><input className={inputClass} value={c.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label className="space-y-1"><span className="text-xs text-muted">Description (the policy it enforces)</span><input className={inputClass} value={c.description} onChange={(e) => set({ description: e.target.value })} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
        </div>
      </Card>
      <div className="flex gap-2">
        <button type="button" className={buttonClass.primary} disabled={!c.name || !c.title || !c.prompt || !c.types.length} onClick={save}>{id ? "Save" : "Create"}</button>
        <button type="button" className={buttonClass.ghost} onClick={onClose}>Cancel</button>
      </div>
      {picking !== null && (
        <DrivePicker title={picking === "scope" ? "The Project this checkpoint covers" : "A folder or Project for the location condition"} onClose={() => setPicking(null)}
          folder={{ action: "Use this folder", onPick: (f) => {
            if (f.id) {
              if (picking === "scope") (set({ scope: { kind: "project", id: f.id } }), setScopeName(f.name));
              else setCond(picking, { ids: [...new Set([...c.conditions[picking].ids, f.id])] });
            }
            setPicking(null);
          } }} />
      )}
    </div>
  );
}
