"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { blankCondition, blankRule, ConditionEditor, ParamEditor, RuleEditor, SectionsEditor, type EditorData } from "@/components/ontology/ActionEditor";
import { ActionForm } from "@/components/ontology/ActionForm";
import { saveOrBranch } from "@/components/ontology/ObjectTypeExtras";
import { TypeClasses } from "@/components/ontology/PropertyEditor";
import { AppHeader, Badge, Card, ErrorBox, Field, ParamInput } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { webhooks } from "@/lib/dataConnection";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { actions, FAILURE_LABEL, functions, RULE_INFO, ruleLabel, type ActionParam, type ActionRun, type Condition, type Metrics, type Rule, type TestResult } from "@/lib/actions";
import { ACTION_KIND_LABEL, ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import { om } from "@/lib/ontologyModel";

type Tab = "overview" | "parameters" | "rules" | "form" | "criteria" | "security" | "test" | "log";
const TABS: [Tab, string, IconName][] = [
  ["overview", "Overview", "home"],
  ["parameters", "Parameters", "sliders"],
  ["rules", "Rules", "bolt"],
  ["form", "Form", "list"],
  ["criteria", "Submission criteria", "check"],
  ["security", "Security & capabilities", "eye"],
  ["test", "Test run", "play"],
  ["log", "Action log & runs", "history"],
];

/**
 * The action type editor (Ontology Manager → action type): overview with metrics, parameters, rules, form sections,
 * submission criteria, security and capabilities, a test run and the action log.
 */
export default function ActionTypePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [saved, setSaved] = useState<ActionType | null>(null);
  const [draft, setDraft] = useState<ActionType | null>(null);
  const [data, setData] = useState<EditorData | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    ontology.actionType(id).then(
      (a) => {
        setSaved(a);
        setDraft(JSON.parse(JSON.stringify(a)));
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    Promise.all([
      ontology.objectTypes(),
      om.linkTypes(),
      om.interfaces(),
      om.valueTypes(),
      functions.list().catch(() => []),
      webhooks.list().catch(() => []),
    ]).then(([types, links, interfaces, valueTypes, fns, hooks]) =>
      setData({ types, links, interfaces, valueTypes, functions: fns, webhooks: hooks.map((h) => ({ id: h.id, name: h.name, inputs: (h.inputs ?? []) as { id?: string; name?: string }[] })) }),
    );
  }, []);
  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  if (error && !saved) return <ApiError message={error} />;
  if (!draft || !saved || !data) return <Loading />;
  const t = data.types.find((x) => x.id === draft.object_type_id);
  const params = draft.parameters as unknown as ActionParam[];
  const set = (c: Partial<ActionType>) => setDraft({ ...draft, ...c });
  const setParams = (p: ActionParam[]) => set({ parameters: p as never });
  const save = async () => {
    setBusy(true);
    setError(null);
    const body: Partial<ActionType> = {
      display_name: draft.display_name,
      description: draft.description,
      status: draft.status,
      parameters: draft.parameters,
      type_classes: draft.type_classes,
      sections: draft.sections,
      submission_criteria: draft.submission_criteria,
      capabilities: draft.capabilities,
      permissions: draft.permissions,
      authorizations: draft.authorizations,
      monitors: draft.monitors,
      ...(draft.kind === "rules" ? { rules: draft.rules, kind: "rules" } : {}),
    };
    const rec = { ...draft, id: draft.id, ontology_id: t?.ontology_id };
    if (await saveOrBranch("action_type", rec, body, () => ontology.updateActionType(draft.id, body).then((a) => (setSaved(a), setDraft(JSON.parse(JSON.stringify(a))))), (h) => router.push(h))) {
      // saved
    }
    setBusy(false);
  };
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader
        app="Nexus Manager"
        icon="cube"
        href="/ontology"
        crumbs={[{ label: "Action types", href: "/ontology?tab=action-types" }, ...(t ? [{ label: t.display_name, href: `/ontology/${t.id}?tab=actions` }] : []), { label: draft.display_name }]}
      >
        {dirty && <span className="text-xs text-warn">Unsaved changes</span>}
        <button type="button" disabled={!dirty} onClick={() => setDraft(JSON.parse(JSON.stringify(saved)))} className={buttonClass.ghost}>
          Discard
        </button>
        <button type="button" disabled={!dirty || busy} onClick={save} className={buttonClass.primary}>
          <Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Saving…" : "Save"}
        </button>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 border-r border-line bg-panel p-2 text-sm">
          <div className="mb-2 rounded-lg border border-line bg-panel-2 p-2.5">
            <div className="truncate font-medium">{draft.display_name}</div>
            <div className="text-xs text-muted">
              {ACTION_KIND_LABEL[draft.kind]} · v{saved.version ?? 1}
            </div>
          </div>
          {TABS.map(([k, label, icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${tab === k ? "bg-ocean/15 font-medium text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2 hover:text-white"}`}>
              <Icon name={icon} className="h-4 w-4" />
              <span className="flex-1">{label}</span>
              {k === "parameters" && <span className="text-xs text-muted">{params.length}</span>}
              {k === "rules" && <span className="text-xs text-muted">{draft.rules?.length ?? "—"}</span>}
            </button>
          ))}
        </nav>
        <section className="dot-grid min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl space-y-4 p-8">
            <ErrorBox message={error} />
            {tab === "overview" && <Overview a={draft} saved={saved} t={t} set={set} />}
            {tab === "parameters" && <Parameters params={params} data={data} onChange={setParams} legacy={draft.kind !== "rules"} t={t} />}
            {tab === "rules" && <Rules a={draft} t={t} data={data} set={set} params={params} setParams={setParams} />}
            {tab === "form" && (
              <Card title="Form sections">
                <div className="p-4">
                  <p className="mb-3 text-xs text-muted">Group parameters into sections with one or two columns; parameters outside sections are listed after them.</p>
                  <SectionsEditor sections={draft.sections ?? []} params={params} onChange={(s) => set({ sections: s })} />
                </div>
              </Card>
            )}
            {tab === "criteria" && <Criteria a={draft} data={data} set={set} params={params} />}
            {tab === "security" && <Security a={draft} set={set} />}
            {tab === "test" && <TestRun a={saved} t={t} dirty={dirty} />}
            {tab === "log" && <LogTab a={saved} onChanged={load} />}
          </div>
        </section>
      </div>
    </div>
  );
}

function Overview({ a, saved, t, set }: { a: ActionType; saved: ActionType; t?: ObjectType; set: (c: Partial<ActionType>) => void }) {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    actions.metrics(saved.id).then(setM, () => setM(null));
  }, [saved.id]);
  const max = Math.max(1, ...(m?.by_day ?? []).map((d) => d.succeeded + d.failed));
  return (
    <>
      <Card title="Metadata">
        <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <Field label="Display name">
            <input value={a.display_name} onChange={(e) => set({ display_name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Status">
            <select value={a.status ?? "experimental"} onChange={(e) => set({ status: e.target.value as ActionType["status"] })} className={inputClass}>
              {["experimental", "active", "deprecated", "example"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description">
            <input value={a.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
          </Field>
          <Field label="API name" hint="Fixed while active">
            <input value={a.api_name} disabled className={`${inputClass} font-mono`} />
          </Field>
          <div className="text-xs text-muted sm:col-span-2">
            {a.interface_id ? "Interface action" : `Acts on ${t?.display_name ?? a.object_type_id}`} · {ACTION_KIND_LABEL[a.kind]} · version {saved.version ?? 1} · ID {a.id}
          </div>
          <div className="sm:col-span-2">
            <TypeClasses value={a.type_classes ?? []} onChange={(v) => set({ type_classes: v })} />
          </div>
        </div>
      </Card>
      <Card title="Action metrics (30 days)">
        <div className="grid gap-4 p-4 text-sm md:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted">Succeeded</span>
              <span className="tabular-nums text-ok">{m?.succeeded ?? "…"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Failed</span>
              <span className="tabular-nums text-bad">{m?.failed ?? "…"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">P95 duration</span>
              <span className="tabular-nums">{m?.p95_ms != null ? `${m.p95_ms} ms` : "—"}</span>
            </div>
            {Object.entries(m?.failures_by_category ?? {}).map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-muted">{FAILURE_LABEL[k] ?? k}</span>
                <span className="tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          <div className="flex h-32 items-end gap-1">
            {(m?.by_day ?? []).map((d) => (
              <div key={d.day} className="flex flex-1 flex-col justify-end" title={`${d.day}: ${d.succeeded} succeeded, ${d.failed} failed`}>
                <div className="bg-bad/70" style={{ height: `${(d.failed / max) * 100}%` }} />
                <div className="bg-ok/70" style={{ height: `${(d.succeeded / max) * 100}%` }} />
              </div>
            ))}
            {!m?.by_day.length && <span className="text-xs text-muted">No submissions yet</span>}
          </div>
        </div>
      </Card>
      <Card title="Monitors">
        <div className="space-y-2 p-4 text-sm">
          {(a.monitors ?? []).map((mo, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <select value={mo.kind} onChange={(e) => set({ monitors: (a.monitors ?? []).map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)) })} className={`${fieldClass} py-1 text-xs`}>
                <option value="p95_ms">Action duration p95 (ms) above</option>
                <option value="failures">Failures in window above</option>
              </select>
              <input type="number" value={mo.threshold} onChange={(e) => set({ monitors: (a.monitors ?? []).map((x, j) => (j === i ? { ...x, threshold: Number(e.target.value) } : x)) })} className={`${fieldClass} w-24 py-1 text-xs`} />
              <span className="text-muted">over the last</span>
              <input type="number" value={mo.window_minutes} onChange={(e) => set({ monitors: (a.monitors ?? []).map((x, j) => (j === i ? { ...x, window_minutes: Number(e.target.value) } : x)) })} className={`${fieldClass} w-20 py-1 text-xs`} />
              <span className="text-muted">minutes</span>
              <button type="button" onClick={() => set({ monitors: (a.monitors ?? []).filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => set({ monitors: [...(a.monitors ?? []), { kind: "failures", threshold: 5, window_minutes: 60 }] })} className={buttonClass.ghost}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Monitor
          </button>
          {(m?.alerts ?? []).slice(0, 5).map((al, i) => (
            <div key={i} className={`rounded px-2 py-1 text-xs ${al.resolved_at ? "bg-panel-2 text-muted" : "bg-bad/10 text-bad"}`}>
              {al.monitor} {al.value} &gt; {al.threshold} · {when(al.at)}
              {al.resolved_at ? ` · resolved ${when(al.resolved_at)}` : " · open"}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function Parameters({ params, data, onChange, legacy, t }: { params: ActionParam[]; data: EditorData; onChange: (p: ActionParam[]) => void; legacy: boolean; t?: ObjectType }) {
  const [open, setOpen] = useState(0);
  const p = params[open];
  // a create / modify action writes each parameter into one property: a new parameter needs to be given its property
  const writable = legacy && t ? t.properties.filter((x) => !["byte", "float", "short"].includes(x.type) && !x.derived) : [];
  return (
    <div className="grid gap-4 md:grid-cols-[240px_1fr]">
      <div className="space-y-1">
        {params.map((x, i) => (
          <div key={i} className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${open === i ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
            <button type="button" onClick={() => setOpen(i)} className="min-w-0 flex-1 truncate text-left">
              {x.display_name || x.id}
              {x.required && <span className="text-bad"> *</span>}
              <span className="ml-1 text-xs text-muted">{x.type}</span>
            </button>
            <button type="button" disabled={i === 0} onClick={() => onChange(params.map((y, j) => (j === i - 1 ? params[i] : j === i ? params[i - 1] : y)))} className="text-muted disabled:opacity-30" title="Move up">
              ↑
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(params.filter((_, j) => j !== i));
                setOpen(0);
              }}
              className="text-muted hover:text-bad"
            >
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            onChange([...params, { id: `param${params.length + 1}`, display_name: "New parameter", type: "string" }]);
            setOpen(params.length);
          }}
          className={buttonClass.ghost}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> New parameter
        </button>
        {legacy && <p className="text-[11px] text-muted">This action writes properties through its parameters; convert it to a rule-based action in Rules for more.</p>}
      </div>
      <Card title={p ? p.display_name || p.id : "Parameter"}>
        <div className="p-4">
          {p && legacy && t && p.type !== "object" && (
            <div className="mb-3">
              <Field label="Property it writes" hint="The parameter takes the property's type">
                <select
                  value={p.property ?? ""}
                  onChange={(e) => {
                    const prop = writable.find((x) => x.api_name === e.target.value);
                    onChange(params.map((x, i) => (i === open ? { ...p, property: e.target.value || null, type: prop?.type ?? p.type } : x)));
                  }}
                  className={inputClass}
                  aria-label="Property it writes"
                >
                  <option value="">Pick…</option>
                  {writable.map((x) => (
                    <option key={x.api_name} value={x.api_name}>
                      {x.display_name} ({x.type})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {p ? <ParamEditor p={p} params={params} data={data} onChange={(np) => onChange(params.map((x, i) => (i === open ? np : x)))} /> : <p className="text-sm text-muted">No parameters.</p>}
        </div>
      </Card>
    </div>
  );
}

function Rules({ a, t, data, set, params, setParams }: { a: ActionType; t?: ObjectType; data: EditorData; set: (c: Partial<ActionType>) => void; params: ActionParam[]; setParams: (p: ActionParam[]) => void }) {
  if (a.kind !== "rules")
    return (
      <Card title="Rules">
        <div className="space-y-3 p-4 text-sm">
          <p className="text-muted">
            This is a {ACTION_KIND_LABEL[a.kind].toLowerCase()} action type: each parameter writes its property. Convert it to rules to add links, functions, notifications, webhooks and schedule
            builds.
          </p>
          <button
            type="button"
            onClick={() => {
              const writes = Object.fromEntries(params.filter((p) => p.property).map((p) => [p.property as string, { kind: "parameter" as const, parameter: p.id }]));
              const rule: Rule =
                a.kind === "create"
                  ? { kind: "create_object", object_type_id: a.object_type_id, properties: writes }
                  : a.kind === "modify"
                    ? { kind: "modify_object", object_type_id: a.object_type_id, object_param: "object", properties: writes }
                    : { kind: "delete_object", object_type_id: a.object_type_id, object_param: "object" };
              setParams(params.map((p) => (p.type === "object" ? { ...p, object_type_id: a.object_type_id } : p)));
              set({ kind: "rules", rules: [rule] });
            }}
            className={buttonClass.primary}
          >
            Convert to rule-based (save to apply)
          </button>
        </div>
      </Card>
    );
  const rules = a.rules ?? [];
  return (
    <>
      {rules.map((r, i) => (
        <Card
          key={i}
          title={`${i}. ${ruleLabel(r.kind)}`}
          action={
            <span className="flex gap-1">
              <button type="button" disabled={i === 0} onClick={() => set({ rules: rules.map((x, j) => (j === i - 1 ? rules[i] : j === i ? rules[i - 1] : x)) })} className="text-muted disabled:opacity-30">
                ↑
              </button>
              <button type="button" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
            </span>
          }
        >
          <div className="p-4">
            <RuleEditor rule={r} index={i} params={params} data={data} objectTypeId={t?.id ?? null} onChange={(nr) => set({ rules: rules.map((x, j) => (j === i ? nr : x)) })} onAddParams={(ps) => setParams([...params, ...ps.filter((p) => !params.some((x) => x.id === p.id))])} />
          </div>
        </Card>
      ))}
      <Card title="Add new rule">
        <div className="grid gap-2 p-4 sm:grid-cols-2">
          {RULE_INFO.map((r) => (
            <button key={r.kind} type="button" onClick={() => set({ rules: [...rules, blankRule(r.kind, t?.id ?? null)] })} className="rounded-md border border-line-2 p-2 text-left text-sm hover:border-ocean/50">
              <div className="font-medium">
                {r.label} <span className="text-[10px] uppercase text-muted">{r.group}</span>
              </div>
              <div className="text-xs text-muted">{r.description}</div>
            </button>
          ))}
        </div>
      </Card>
    </>
  );
}

function Criteria({ a, data, set, params }: { a: ActionType; data: EditorData; set: (c: Partial<ActionType>) => void; params: ActionParam[] }) {
  const crit = a.submission_criteria ?? [];
  const setC = (c: Condition[]) => set({ submission_criteria: c });
  return (
    <Card title="Submission criteria">
      <div className="space-y-2 p-4 text-sm">
        <p className="text-xs text-muted">
          Every root condition or group must pass for the action to be submitted; its failure message is shown otherwise. Avoid “is not” on groups, markings or organizations: scoped tokens may lack them.
        </p>
        {crit.map((c, i) => (
          <ConditionEditor key={i} node={c} params={params} data={data} root onChange={(x) => setC(crit.map((y, j) => (j === i ? x : y)))} onRemove={() => setC(crit.filter((_, j) => j !== i))} />
        ))}
        <div className="flex gap-2">
          <button type="button" onClick={() => setC([...crit, { ...blankCondition(), failure_message: "" }])} className={buttonClass.secondary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Condition
          </button>
          <button type="button" onClick={() => setC([...crit, { kind: "or", children: [blankCondition()], failure_message: "" }])} className={buttonClass.secondary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Group
          </button>
        </div>
      </div>
    </Card>
  );
}

function Security({ a, set }: { a: ActionType; set: (c: Partial<ActionType>) => void }) {
  const caps = a.capabilities ?? {};
  const perms = a.permissions ?? {};
  const authz = a.authorizations ?? {};
  const list = (v?: string[]) => (v ?? []).join(", ");
  const parse = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return (
    <>
      <Card title="Who can apply this action">
        <div className="space-y-3 p-4 text-sm">
          <Field label="Allowed principals" hint='"everyone", "user:<id>" or "group:<id>"; empty: anyone with a role on the ontology who passes the submission criteria'>
            <input value={list(perms.apply)} onChange={(e) => set({ permissions: { ...perms, apply: parse(e.target.value) } })} className={inputClass} />
          </Field>
          <Field label="Notification recipients' permissions">
            <select value={perms.notification_permissions ?? "all"} onChange={(e) => set({ permissions: { ...perms, notification_permissions: e.target.value as "all" } })} className={inputClass}>
              <option value="all">Require all recipients to see the data (else the action fails)</option>
              <option value="any">Notify only recipients who can see the data</option>
            </select>
          </Field>
        </div>
      </Card>
      <Card title="Read and write authorizations">
        <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <Field label="Read authorization (marking IDs)" hint="The most an action may read: objects above it are refused">
            <input value={list(authz.read_markings)} onChange={(e) => set({ authorizations: { ...authz, read_markings: parse(e.target.value) } })} className={inputClass} />
          </Field>
          <Field label="Write authorization (marking IDs)" hint="The minimum markings of the object types it writes">
            <input value={list(authz.write_markings)} onChange={(e) => set({ authorizations: { ...authz, write_markings: parse(e.target.value) } })} className={inputClass} />
          </Field>
        </div>
      </Card>
      <Card title="Capabilities">
        <div className="space-y-3 p-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={caps.revertible ?? true} onChange={(e) => set({ capabilities: { ...caps, revertible: e.target.checked } })} /> Allow revert after action submission
          </label>
          <Field label="Isolation">
            <select value={caps.isolation ?? "snapshot"} onChange={(e) => set({ capabilities: { ...caps, isolation: e.target.value } })} className={inputClass}>
              <option value="snapshot">Snapshot isolation (default)</option>
              <option value="read_committed">Read committed</option>
              <option value="legacy">Legacy</option>
            </select>
          </Field>
          <div className="rounded-md border border-line-2 p-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!caps.action_log?.enabled} onChange={(e) => set({ capabilities: { ...caps, action_log: { ...caps.action_log, enabled: e.target.checked } } })} /> Create action log objects
            </label>
            <p className="mt-1 text-xs text-muted">Generate an object every time this action is submitted (Action log & runs → Generate object type).</p>
            <Field label="Summary" hint="Reference parameters with {{{param}}}, the user with {{{currentUser}}}">
              <input value={caps.action_log?.summary ?? ""} onChange={(e) => set({ capabilities: { ...caps, action_log: { ...caps.action_log, summary: e.target.value } } })} className={inputClass} />
            </Field>
            <label className="mt-2 flex items-center gap-2 text-xs text-soft">
              <input type="checkbox" checked={caps.action_log?.log_parameters ?? true} onChange={(e) => set({ capabilities: { ...caps, action_log: { ...caps.action_log, log_parameters: e.target.checked } } })} /> Log parameter values
            </label>
          </div>
        </div>
      </Card>
    </>
  );
}

function TestRun({ a, t, dirty }: { a: ActionType; t?: ObjectType; dirty: boolean }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [res, setRes] = useState<TestResult | null>(null);
  const [trying, setTrying] = useState(false);
  const params = a.parameters as unknown as ActionParam[];
  return (
    <Card title="Test run" action={<span className="text-xs font-normal text-muted">Evaluates permissions, criteria and rules — nothing is written or sent</span>}>
      <div className="space-y-3 p-4 text-sm">
        {dirty && <p className="text-xs text-warn">Save first: the test runs the saved version.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {params.map((p) => (
            <Field key={p.id} label={`${p.display_name || p.id}${p.required ? " *" : ""}`} hint={p.type}>
              {["object", "interface", "object_type", "user", "group"].includes(p.type) ? (
                <input value={String(values[p.id] ?? "")} onChange={(e) => setValues({ ...values, [p.id]: e.target.value })} placeholder={p.type === "object" ? "primary key" : p.type === "interface" ? "objectTypeId:primaryKey" : p.type} className={inputClass} />
              ) : (
                <ParamInput param={{ type: p.type as never, array: p.array }} value={values[p.id]} onChange={(v) => setValues({ ...values, [p.id]: v })} property={t?.properties.find((x) => x.api_name === p.property)} />
              )}
            </Field>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={async () => setRes(await actions.test(a.id, Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== undefined))))} className={buttonClass.primary}>
            <Icon name="play" className="h-3.5 w-3.5" /> Test run
          </button>
          {t && (
            <button type="button" onClick={() => setTrying(true)} className={buttonClass.secondary}>
              Open the action form
            </button>
          )}
        </div>
        {res && (
          <div className={`rounded-md border p-3 text-xs ${res.valid ? "border-ok/40 bg-ok/10" : "border-bad/40 bg-bad/10"}`}>
            {res.valid ? (
              <>
                <div className="mb-1 font-medium text-ok">Valid · {res.ms} ms</div>
                {(res.edits ?? []).map((e) => (
                  <div key={`${e.object_type_id}:${e.primary_key}`}>
                    <span className="capitalize">{e.op}</span> {e.primary_key} {e.properties ? JSON.stringify(e.properties) : ""}
                  </div>
                ))}
                {(res.links ?? []).map((l, i) => (
                  <div key={i}>
                    Link {l.op} {l.source} → {l.target}
                  </div>
                ))}
                {(res.side_effects ?? []).map((s, i) => (
                  <div key={i} className="text-muted">
                    Would run {s.kind}
                    {s.mode ? ` (${s.mode})` : ""}
                  </div>
                ))}
              </>
            ) : (
              <div className="text-bad">
                {res.error}
                {res.category ? ` (${FAILURE_LABEL[res.category] ?? res.category})` : ""}
              </div>
            )}
          </div>
        )}
      </div>
      {trying && t && <ActionForm action={a} objectType={t} onClose={() => setTrying(false)} onDone={() => setTrying(false)} />}
    </Card>
  );
}

function LogTab({ a, onChanged }: { a: ActionType; onChanged: () => void }) {
  const [runs, setRuns] = useState<ActionRun[] | null>(null);
  const [log, setLog] = useState<Awaited<ReturnType<typeof actions.log>> | null>(null);
  const load = useCallback(() => {
    actions.runs(a.id).then(setRuns, () => setRuns([]));
    actions.log(a.id).then(setLog, () => setLog(null));
  }, [a.id]);
  useEffect(load, [load]);
  return (
    <>
      <Card
        title="Action log"
        action={
          <button
            type="button"
            onClick={async () => {
              try {
                await actions.generateLog(a.id);
                onChanged();
                load();
              } catch (e) {
                void alertDialog((e as Error).message);
              }
            }}
            className={buttonClass.ghost}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> Generate object type
          </button>
        }
      >
        <div className="p-4 text-sm">
          <div className="mb-2 text-xs text-muted">
            Status: {log?.status ?? "…"}
            {log?.config && (log.config as { object_type_id?: string }).object_type_id ? (
              <>
                {" "}
                ·{" "}
                <Link href={`/ontology/${(log.config as { object_type_id: string }).object_type_id}?tab=objects`} className="text-ocean">
                  log object type
                </Link>
              </>
            ) : null}
          </div>
          {(log?.objects ?? []).slice(0, 20).map((o) => (
            <div key={o.primary_key} className="border-t border-line py-1.5 text-xs">
              <span className="text-muted">{String(o.properties.timestamp ?? "")}</span> {String(o.properties.summary ?? o.title)}
              {o.properties.reverted ? <Badge status="paused" label="reverted" /> : null}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Run history (7 days)" count={runs?.length}>
        <table className="w-full text-xs">
          <tbody>
            {(runs ?? []).map((r) => (
              <tr key={r.rid} className="border-t border-line">
                <td className="px-3 py-1.5 text-muted">{when(r.at)}</td>
                <td className="px-3 py-1.5">{r.user}</td>
                <td className="px-3 py-1.5">
                  <Badge status={r.reverted_at ? "paused" : r.status} label={r.reverted_at ? "reverted" : r.status} />
                </td>
                <td className="px-3 py-1.5 text-soft">{r.status === "failed" ? `${FAILURE_LABEL[r.category ?? ""] ?? r.category}: ${r.error}` : `${r.edited.length} objects · v${r.version}`}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.ms} ms</td>
                <td className="px-2">
                  {r.status === "succeeded" && !r.reverted_at && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!(await confirmDialog("Revert this action's edits?"))) return;
                        try {
                          await actions.revert(r.rid);
                          load();
                        } catch (e) {
                          void alertDialog((e as Error).message);
                        }
                      }}
                      className="text-ocean hover:underline"
                    >
                      Revert
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
