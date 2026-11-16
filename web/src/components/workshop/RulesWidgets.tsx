"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { confirmDialog } from "@/lib/dialogs";
import { rulesApi, type Block, type Board, type Proposal, type Rule, type Workflow } from "@/lib/foundryRules";
import { ontology, type ObjectType } from "@/lib/ontology";
import { om, type LinkType } from "@/lib/ontologyModel";
import type { Module, Variable, Widget, WidgetConfig } from "@/lib/workshop";
import { BOARD_LABEL, FoundryRuleEditor, blankRule, show } from "./FoundryRuleEditor";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

// Workshop widgets of Foundry Rules (palantir.com/docs/foundry/foundry-rules/workshop-application), bound to a Foundry
// Rules workflow (api/foundry_rules.py):
// - Rule Editor: the workflow's rules (a filter list and a list, as the Rule Editor page lays them out) and the
//   editor of the selected rule — metadata and custom properties, logic boards with previews, the rule output.
//   Create New starts a rule; Submit changes creates a proposal (or saves directly when the workflow does not require
//   proposals); deleting proposes a delete. The logic boards and Contour import are the widget's optional features;
//   read-only is the Rule Viewer.
// - Proposal Reviewer: the workflow's proposals (filtered by status, kind and text) and the selected one as a diff —
//   changed values in yellow, prior values faded — with Approve / Reject and a review comment. Approving applies the
//   proposal (the rule is created, edited or deleted). A stale proposal (its rule changed or was deleted since it
//   was made) is marked "stale" and cannot be approved, only rejected.
// Outputs: the selected rule and the selected / submitted proposal as variables (a string holds the id, an array or
// object set the id in a list, a struct the record's fields: custom properties as their own fields, so variables can
// take a custom property of the selected rule). Changes bump the module, so the other widgets reload.

const STRUCT_KEYS = ["id", "name", "description", "status", "author", "version", "workflow_id"] as const;

/** A rule or proposal into a variable of the type the variable has. */
function writeVar(state: ModuleState, name: string | undefined, id: string | undefined, record?: Record<string, unknown>) {
  if (!name) return;
  const t = state.variableTypes?.[name];
  if (t === "struct") state.setVariable(name, id && record ? record : {});
  else if (t === "array" || t === "object_set") state.setVariable(name, id ? [id] : []);
  else state.setVariable(name, id ?? "");
}

/** The id a variable holds (a string, the first of a list, or a struct's id). */
function readVar(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  if (typeof v === "object") return (v as { id?: string }).id || undefined;
  return String(v);
}

const ruleStruct = (r: Partial<Rule>): Record<string, unknown> => ({ ...Object.fromEntries(STRUCT_KEYS.map((k) => [k, r[k as keyof Rule] ?? null])), ...(r.custom ?? {}) });
const proposalStruct = (p: Proposal): Record<string, unknown> => ({
  id: p.id,
  kind: p.kind,
  status: p.status,
  rule_id: p.rule_id,
  rule_name: p.new?.name ?? p.old?.name ?? null,
  author: p.author,
  created_at: p.created_at,
  reviewer: p.reviewer,
  reviewed_at: p.reviewed_at,
  changed: p.diff.map((d) => d.field).join(", "),
  stale: !!p.stale,
});

type Loaded = { key: string; w?: Workflow; rules?: Rule[]; proposals?: Proposal[]; error?: string };

/** The workflow with its rules and proposals, reloaded when the module bumps. */
function useWorkflow(wid: string | undefined, version: number, refresh: number) {
  const [res, setRes] = useState<Loaded | null>(null);
  const key = `${wid}|${version}|${refresh}`;
  useEffect(() => {
    if (!wid) return;
    let stale = false;
    Promise.all([rulesApi.workflow(wid), rulesApi.rules(wid), rulesApi.proposals(wid)]).then(
      ([w, rules, proposals]) => !stale && setRes({ key, w, rules, proposals }),
      (e: Error) => !stale && setRes({ key, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [wid, key]);
  // a reload keeps what is drawn until the new data arrives
  return res && res.key.startsWith(`${wid}|`) ? res : null;
}

/** Object types and link types: the rule editor's columns and linked-object boards. */
function useTypes() {
  const [t, setT] = useState<{ types: ObjectType[]; links: LinkType[] }>({ types: [], links: [] });
  useEffect(() => {
    Promise.all([ontology.objectTypes(), om.linkTypes()]).then(([types, links]) => setT({ types, links }), () => undefined);
  }, []);
  return t;
}

const Empty = ({ children, bad }: { children: React.ReactNode; bad?: boolean }) => <div className={`flex h-full items-center justify-center p-4 text-center text-xs ${bad ? "text-bad" : "text-muted"}`}>{children}</div>;
const ago = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// ------------------------------------------------------------------------------------------------
// Rule Editor
// ------------------------------------------------------------------------------------------------

export function RuleEditorWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [refresh, setRefresh] = useState(0);
  const data = useWorkflow(c.fr_workflow_id, state.version, refresh);
  const { types, links } = useTypes();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "active" | "disabled">("");
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  // bumped on submit: the form starts again from the saved rule (an open proposal does not change it)
  const [round, setRound] = useState(0);
  const fromVar = c.fr_rule_variable ? readVar(state.variables[c.fr_rule_variable]) : undefined;
  const [own, setOwn] = useState<string | undefined>(undefined);
  const selectedId = c.fr_rule_variable ? fromVar : own;
  const readOnly = !!c.fr_read_only;
  const blocked = editing ? "Submitting is off while the module is edited" : state.readOnly ? "Read-only: this module does not write" : undefined;

  const pick = useCallback(
    (r: Rule | undefined) => {
      setCreating(false);
      setOwn(r?.id);
      writeVar(state, c.fr_rule_variable, r?.id, r ? ruleStruct(r) : undefined);
      void state.runEvents?.(c.fr_events ?? []);
    },
    [state, c.fr_rule_variable, c.fr_events],
  );

  if (!c.fr_workflow_id) return <Empty>Choose the Foundry Rules workflow whose rules this widget edits</Empty>;
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error || !data.w || !data.rules || !data.proposals) return <Empty bad>{data.error ?? "The workflow did not load"}</Empty>;
  const w = data.w;
  const openOn = new Map<string, number>();
  for (const p of data.proposals) if (p.status === "open" && p.rule_id) openOn.set(p.rule_id, (openOn.get(p.rule_id) ?? 0) + 1);
  const needle = q.trim().toLowerCase();
  const shown = data.rules.filter(
    (r) => (!status || r.status === status) && (!needle || `${r.name} ${r.description} ${Object.values(r.custom).join(" ")}`.toLowerCase().includes(needle)),
  );
  const selected = data.rules.find((r) => r.id === selectedId);
  const showList = c.fr_show_list !== false;
  const allowCreate = !readOnly && c.fr_allow_create !== false;

  const submitted = (p: Proposal) => {
    writeVar(state, c.fr_proposal_variable, p.id, proposalStruct(p));
    setNote({ text: p.status === "open" ? `Proposal submitted (${p.kind}): a reviewer approves it in the Proposal Reviewer.` : `Saved: ${p.new?.name ?? p.old?.name ?? ""}` });
    setCreating(false);
    setRound((x) => x + 1);
    if (p.status === "approved" && p.kind === "create" && p.rule_id) {
      setOwn(p.rule_id);
      writeVar(state, c.fr_rule_variable, p.rule_id, p.new ? ruleStruct({ ...p.new, id: p.rule_id }) : undefined);
    } else if (p.status === "approved" && p.kind === "delete") pick(undefined);
    setRefresh((x) => x + 1);
    state.bump();
    void state.runEvents?.(c.fr_submit_events ?? []);
  };

  const list = showList && (
    <div className="flex min-h-0 w-56 shrink-0 grow flex-col gap-1.5 border-line md:grow-0" data-fr-rule-list>
      <div className="flex gap-1">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules" className={`${fieldClass} min-w-0 flex-1`} aria-label="Search rules" />
        <select value={status} onChange={(e) => setStatus(e.target.value as "")} className={fieldClass} aria-label="Status filter">
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>
      {allowCreate && (
        <button type="button" onClick={() => (pick(undefined), setCreating(true), setNote(null))} className={buttonClass.primary} data-fr-create>
          <Icon name="plus" className="h-3.5 w-3.5" /> Create New
        </button>
      )}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {shown.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => (pick(r.id === selectedId ? undefined : r), setNote(null))}
            className={`flex w-full flex-col rounded-md border px-2 py-1.5 text-left text-xs ${r.id === selectedId && !creating ? "border-ocean bg-ocean/10" : "border-line hover:bg-panel-2"}`}
          >
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              {openOn.get(r.id!) ? <span className="rounded bg-warn/15 px-1 text-[10px] text-warn">{openOn.get(r.id!)} open</span> : null}
            </span>
            <span className="truncate text-[11px] text-muted">
              {r.status} · v{r.version} · {r.logic.blocks.map((b) => BOARD_LABEL[b.kind]).join(" → ")}
            </span>
          </button>
        ))}
        {!shown.length && <div className="p-2 text-xs text-muted">{data.rules.length ? "No rule matches." : "No rules yet."}</div>}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (creating && allowCreate)
    body = (
      <FoundryRuleEditor key={`new|${w.id}`} w={w} rule={blankRule(w)} types={types} links={links} boards={c.fr_boards} contourImport={c.fr_contour_import !== false} submitBlocked={blocked} onCancel={() => setCreating(false)} onSubmitted={submitted} />
    );
  else if (selected)
    body = (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge status={selected.status === "active" ? "active" : "deprecated"} label={selected.status} />
          <span>
            v{selected.version} · by {selected.author ?? "—"}
            {Object.entries(selected.custom).map(([k, v]) => ` · ${k}: ${show(v)}`)}
          </span>
          {openOn.get(selected.id!) ? <span className="text-warn">{openOn.get(selected.id!)} open proposal(s) on this rule</span> : null}
          {!readOnly && c.fr_allow_delete !== false && (
            <button
              type="button"
              disabled={!!blocked}
              title={blocked}
              onClick={async () => {
                if (!(await confirmDialog({ message: `Propose deleting ${selected.name}?`, danger: true, confirmLabel: w.require_proposals ? "Propose delete" : "Delete" }))) return;
                rulesApi.proposeDelete(selected.id!).then(submitted, (e: Error) => setNote({ text: e.message, bad: true }));
              }}
              className={`${buttonClass.ghost} ml-auto text-bad`}
              data-fr-delete
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> {w.require_proposals ? "Propose delete" : "Delete"}
            </button>
          )}
        </div>
        <FoundryRuleEditor
          key={`${selected.id}|${selected.version}|${round}`}
          w={w}
          rule={JSON.parse(JSON.stringify(selected)) as Rule}
          types={types}
          links={links}
          boards={c.fr_boards}
          contourImport={false}
          readOnly={readOnly}
          submitBlocked={blocked}
          onCancel={c.fr_rule_variable || showList ? () => pick(undefined) : undefined}
          onSubmitted={submitted}
        />
      </div>
    );
  else if (selectedId) body = <Empty>The selected rule ({selectedId}) is not a rule of {w.name}.</Empty>;
  else body = <Empty>{readOnly ? "Select a rule to view its logic." : allowCreate ? "Select a rule to edit it, or Create New." : "Select a rule to edit it."}</Empty>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-fr-widget="rule_editor">
      <div className="flex items-center gap-2 text-xs">
        <Icon name="sliders" className="h-3.5 w-3.5 text-muted" />
        <span className="truncate font-medium">{w.name}</span>
        <span className="text-muted">
          {data.rules.length} rules{w.require_proposals ? "" : " · saved directly (proposals off)"}
        </span>
        {readOnly && <span className="ml-auto rounded bg-panel-2 px-1.5 text-muted">Rule Viewer</span>}
      </div>
      {note && <div className={`rounded-md px-2 py-1.5 text-xs ${note.bad ? "bg-bad/10 text-bad" : "bg-ok/10 text-ok"}`}>{note.text}</div>}
      <div className="flex min-h-0 flex-1 flex-wrap gap-3 overflow-hidden">
        {list}
        <div className="h-full min-w-[18rem] flex-[3] overflow-y-auto">{body}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Proposal Reviewer
// ------------------------------------------------------------------------------------------------

type Row = { field: string; old: unknown; new: unknown };

/** One line for a logic block. */
function blockText(b: Block | undefined): string | null {
  if (!b) return null;
  const { kind, ...rest } = b;
  if (kind === "filter") {
    const conds = (rest.conditions as { column: string; op: string; value?: unknown }[]) ?? [];
    return `Filter, ${rest.combine === "any" ? "any" : "all"} of: ${conds.map((x) => `${x.column} ${x.op}${x.op === "is_null" || x.op === "not_null" ? "" : ` ${show(x.value)}`}`).join("; ") || "nothing"}`;
  }
  if (kind === "expression") return `Expression: ${rest.as ? `${String(rest.as)} = ` : "keep rows where "}${String(rest.expression ?? "")}`;
  if (kind === "aggregation")
    return `Aggregation by ${((rest.group_by as string[]) ?? []).join(", ") || "all rows"}: ${((rest.aggregations as { fn: string; column?: string; as?: string }[]) ?? []).map((a) => `${a.fn}(${a.column ?? ""}) as ${a.as ?? ""}`).join(", ")}`;
  return `${BOARD_LABEL[kind] ?? kind}: ${JSON.stringify(rest)}`;
}

/** The proposal's changes field by field: custom properties, logic blocks and output fields as their own rows. */
export function proposalRows(p: Pick<Proposal, "old" | "new">): Row[] {
  const o: Partial<Rule> = p.old ?? {};
  const n: Partial<Rule> = p.new ?? {};
  const rows: Row[] = [];
  const add = (field: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) rows.push({ field, old: a ?? null, new: b ?? null });
  };
  add("name", o.name, n.name);
  add("description", o.description, n.description);
  add("status", o.status, n.status);
  for (const k of new Set([...Object.keys(o.custom ?? {}), ...Object.keys(n.custom ?? {})])) add(k, o.custom?.[k], n.custom?.[k]);
  const lo = o.logic;
  const ln = n.logic;
  add("input", lo ? `${lo.input.kind} ${lo.input.id}` : null, ln ? `${ln.input.kind} ${ln.input.id}` : null);
  const blocks = Math.max(lo?.blocks.length ?? 0, ln?.blocks.length ?? 0);
  for (let i = 0; i < blocks; i++) {
    const a = lo?.blocks[i];
    const b = ln?.blocks[i];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) rows.push({ field: `logic block ${i + 1}`, old: blockText(a), new: blockText(b) });
  }
  add("output", lo?.output.output_id, ln?.output.output_id);
  const mo = lo?.output.mapping ?? {};
  const mn = ln?.output.mapping ?? {};
  const mapText = (m: (typeof mo)[string] | undefined) => (!m ? null : m.kind === "column" ? `column ${m.column}` : m.kind === "template" ? `template "${m.value}"` : `value ${show(m.value)}`);
  for (const k of new Set([...Object.keys(mo), ...Object.keys(mn)])) add(`output ${k}`, mapText(mo[k]), mapText(mn[k]));
  return rows;
}

const STATUS_BADGE: Record<Proposal["status"], string> = { open: "in_review", approved: "active", rejected: "deprecated" };

export function ProposalReviewerWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [refresh, setRefresh] = useState(0);
  const data = useWorkflow(c.fr_workflow_id, state.version, refresh);
  const [status, setStatus] = useState<"" | Proposal["status"]>(c.fr_status === "all" ? "" : (c.fr_status ?? "open"));
  const [kind, setKind] = useState<"" | Proposal["kind"]>("");
  const [q, setQ] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [own, setOwn] = useState<string | undefined>(undefined);
  const selectedId = c.fr_proposal_variable ? readVar(state.variables[c.fr_proposal_variable]) : own;
  const blocked = editing ? "Reviewing is off while the module is edited" : state.readOnly ? "Read-only: this module does not write" : undefined;
  const pick = (p: Proposal | undefined) => {
    setOwn(p?.id);
    setComment("");
    setNote(null);
    writeVar(state, c.fr_proposal_variable, p?.id, p ? proposalStruct(p) : undefined);
    if (c.fr_rule_variable) writeVar(state, c.fr_rule_variable, p?.rule_id ?? undefined, p?.rule_id ? ruleStruct({ ...(p.new ?? p.old ?? {}), id: p.rule_id }) : undefined);
    void state.runEvents?.(c.fr_events ?? []);
  };
  const rows = useMemo(() => {
    const p = data?.proposals?.find((x) => x.id === selectedId);
    return p ? proposalRows(p) : [];
  }, [data, selectedId]);

  if (!c.fr_workflow_id) return <Empty>Choose the Foundry Rules workflow whose proposals this widget reviews</Empty>;
  if (!data) return <Empty>Loading…</Empty>;
  if (data.error || !data.w || !data.proposals) return <Empty bad>{data.error ?? "The workflow did not load"}</Empty>;
  const w = data.w;
  const name = (p: Proposal) => p.new?.name ?? p.old?.name ?? p.rule_id ?? "";
  const needle = q.trim().toLowerCase();
  const shown = data.proposals.filter((p) => (!status || p.status === status) && (!kind || p.kind === kind) && (!needle || `${name(p)} ${p.author}`.toLowerCase().includes(needle)));
  const p = data.proposals.find((x) => x.id === selectedId);
  const decide = (decision: "approve" | "reject") => {
    if (!p) return;
    setBusy(true);
    rulesApi
      .review(p.id, decision, comment)
      .then(
        (r) => {
          setNote({ text: decision === "approve" ? `Approved: the rule was ${p.kind === "create" ? "created" : p.kind === "edit" ? "changed" : "deleted"}.` : "Rejected." });
          setComment("");
          writeVar(state, c.fr_proposal_variable, r.id, proposalStruct(r));
          if (c.fr_rule_variable && r.rule_id && r.kind !== "delete" && decision === "approve") writeVar(state, c.fr_rule_variable, r.rule_id, ruleStruct({ ...(r.new ?? {}), id: r.rule_id }));
          setRefresh((x) => x + 1);
          state.bump();
          void state.runEvents?.(c.fr_review_events ?? []);
        },
        (e: Error) => setNote({ text: e.message, bad: true }),
      )
      .finally(() => setBusy(false));
  };
  const val = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "string" ? v : JSON.stringify(v));
  const showList = c.fr_show_list !== false;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-fr-widget="proposal_reviewer">
      <div className="flex items-center gap-2 text-xs">
        <Icon name="check" className="h-3.5 w-3.5 text-muted" />
        <span className="truncate font-medium">{w.name}</span>
        <span className="text-muted">{data.proposals.filter((x) => x.status === "open").length} open proposals</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-wrap gap-3 overflow-hidden">
        {showList && (
          <div className="flex min-h-0 w-56 shrink-0 grow flex-col gap-1.5 md:grow-0" data-fr-proposal-list>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rule, author" className={fieldClass} aria-label="Search proposals" />
            <div className="flex gap-1">
              <select value={status} onChange={(e) => setStatus(e.target.value as "")} className={`${fieldClass} flex-1`} aria-label="Status filter">
                <option value="">Any status</option>
                <option value="open">Open</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
              <select value={kind} onChange={(e) => setKind(e.target.value as "")} className={`${fieldClass} flex-1`} aria-label="Kind filter">
                <option value="">Any change</option>
                <option value="create">Create</option>
                <option value="edit">Edit</option>
                <option value="delete">Delete</option>
              </select>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {shown.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => pick(x.id === selectedId ? undefined : x)}
                  className={`flex w-full flex-col rounded-md border px-2 py-1.5 text-left text-xs ${x.id === selectedId ? "border-ocean bg-ocean/10" : "border-line hover:bg-panel-2"}`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="rounded bg-panel-2 px-1 text-[10px] uppercase text-soft">{x.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{name(x)}</span>
                  </span>
                  <span className="truncate text-[11px] text-muted">
                    {x.status} · {x.author} · {ago(x.created_at)}
                  </span>
                  {x.stale && (
                    <span className="mt-0.5 self-start rounded bg-bad/15 px-1 text-[10px] text-bad" title={x.stale_reason ?? undefined} data-fr-stale>
                      stale — rule changed since
                    </span>
                  )}
                </button>
              ))}
              {!shown.length && <div className="p-2 text-xs text-muted">{data.proposals.length ? "No proposal matches." : "No proposals yet."}</div>}
            </div>
          </div>
        )}
        <div className="h-full min-w-[18rem] flex-[3] overflow-y-auto" data-fr-proposal={p?.id ?? ""}>
          {!p ? (
            <Empty>{selectedId ? `The selected proposal (${selectedId}) is not a proposal of ${w.name}.` : "Select a proposal to review it."}</Empty>
          ) : (
            <div className="space-y-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">
                  {p.kind === "create" ? "Create" : p.kind === "edit" ? "Edit" : "Delete"} rule: {name(p)}
                </span>
                <Badge status={STATUS_BADGE[p.status]} label={p.status} />
              </div>
              <div className="text-muted">
                Proposed by {p.author} · {ago(p.created_at)}
                {p.reviewer ? ` · ${p.status} by ${p.reviewer}${p.reviewed_at ? ` (${ago(p.reviewed_at)})` : ""}` : ""}
                {p.review_comment ? ` — “${p.review_comment}”` : ""}
              </div>
              {p.stale && (
                <div className="rounded-md border border-bad/40 bg-bad/5 px-2 py-1.5 text-bad" data-fr-stale-note>
                  Stale{p.stale_reason ? ` — ${p.stale_reason}` : " — the rule changed since this proposal was made"}. Approving would overwrite the newer version: reject it and propose the change again from the current rule.
                </div>
              )}
              <div className="overflow-hidden rounded-lg border border-line">
                <div className="grid grid-cols-[8rem_1fr] gap-x-3 border-b border-line bg-panel-2 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted">
                  <span>Property</span>
                  <span>{p.kind === "create" ? "Value" : p.kind === "delete" ? "Removed" : "Change"}</span>
                </div>
                {rows.map((r) => (
                  <div key={r.field} className="grid grid-cols-[8rem_1fr] gap-x-3 border-b border-line px-3 py-1.5 last:border-b-0" data-fr-diff={r.field}>
                    <span className="font-mono text-muted">{r.field}</span>
                    <div className="min-w-0 space-y-0.5">
                      {p.kind !== "create" && r.old !== null && <div className="whitespace-pre-wrap break-words text-muted line-through opacity-60">{val(r.old)}</div>}
                      {p.kind !== "delete" && <div className="whitespace-pre-wrap break-words rounded bg-warn/10 px-1 text-warn">{val(r.new)}</div>}
                    </div>
                  </div>
                ))}
                {!rows.length && <div className="px-3 py-2 text-muted">No changes.</div>}
              </div>
              {p.status === "open" && (
                <div className="space-y-1.5">
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Review comment (optional)" className={`${inputClass} w-full`} aria-label="Review comment" />
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" disabled={busy || !!blocked || !!p.stale} title={blocked ?? (p.stale ? "Stale: the rule changed since this proposal was made" : undefined)} onClick={() => decide("approve")} className={buttonClass.primary} data-fr-approve>
                      <Icon name="check" className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button type="button" disabled={busy || !!blocked} title={blocked} onClick={() => decide("reject")} className={buttonClass.secondary} data-fr-reject>
                      <Icon name="x" className="h-3.5 w-3.5" /> Reject
                    </button>
                    {blocked && <span className="text-muted">{blocked}</span>}
                  </div>
                </div>
              )}
              {note && <div className={`rounded-md px-2 py-1.5 ${note.bad ? "bg-bad/10 text-bad" : "bg-ok/10 text-ok"}`}>{note.text}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

const RULES_TYPES = new Set(["rule_editor", "proposal_reviewer"]);
const ID_TYPES: Variable["type"][] = ["string", "array", "object_set", "struct"];
const ALL_BOARDS: Board[] = ["filter", "expression", "aggregation", "join", "window", "select", "union", "link"];

export function RulesWidgetConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const on = RULES_TYPES.has(widget.type);
  const vars = mod.variables ?? [];
  const [flows, setFlows] = useState<Workflow[] | null>(null);
  useEffect(() => {
    if (on) rulesApi.workflows().then(setFlows, () => setFlows([]));
  }, [on]);
  if (!on) return null;
  const editor = widget.type === "rule_editor";
  const flow = (flows ?? []).find((x) => x.id === c.fr_workflow_id);
  const varSel = (value: string | undefined, onChange: (v: string | undefined) => void) => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">None</option>
      {vars.filter((v) => ID_TYPES.includes(v.type)).map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type.replace(/_/g, " ")})</option>)}
    </select>
  );
  const boards = c.fr_boards ?? flow?.boards ?? ALL_BOARDS;
  return (
    <div className="space-y-3 text-xs" data-rules-config>
      <Field
        label="Foundry Rules workflow"
        hint={flow ? `${flow.rules ?? 0} rules · ${flow.open_proposals ?? 0} open proposals · ${flow.require_proposals ? "changes go through proposals" : "proposals off: changes are saved directly"}` : "Workflows are made in Foundry Rules."}
      >
        <select value={c.fr_workflow_id ?? ""} onChange={(e) => set({ fr_workflow_id: e.target.value || undefined })} className={inputClass} data-fr-workflow>
          <option value="">Choose…</option>
          {(flows ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          {c.fr_workflow_id && flows && !flow && <option value={c.fr_workflow_id}>{c.fr_workflow_id} (not found)</option>}
        </select>
      </Field>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={c.fr_show_list !== false} onChange={(e) => set({ fr_show_list: e.target.checked ? undefined : false })} />
        {editor ? "Show the rule list with its filters (off: the rule comes from the variable)" : "Show the proposal list with its filters (off: the proposal comes from the variable)"}
      </label>
      {editor ? (
        <>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.fr_read_only} onChange={(e) => set({ fr_read_only: e.target.checked || undefined })} /> Read-only (Rule Viewer): show the rule&apos;s logic, no changes
          </label>
          {!c.fr_read_only && (
            <>
              <div className="font-semibold uppercase tracking-wide text-muted">Optional features</div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={c.fr_allow_create !== false} onChange={(e) => set({ fr_allow_create: e.target.checked ? undefined : false })} /> Create New
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={c.fr_allow_delete !== false} onChange={(e) => set({ fr_allow_delete: e.target.checked ? undefined : false })} /> Propose deleting a rule
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={c.fr_contour_import !== false} onChange={(e) => set({ fr_contour_import: e.target.checked ? undefined : false })} /> Contour import
              </label>
              <Field label="Logic boards" hint="Only boards the workflow allows are offered; existing blocks of a rule always show.">
                <div className="grid grid-cols-2 gap-1">
                  {ALL_BOARDS.map((b) => (
                    <label key={b} className={`flex items-center gap-1.5 ${flow && !flow.boards.includes(b) ? "opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={boards.includes(b)}
                        disabled={!!flow && !flow.boards.includes(b)}
                        onChange={(e) => {
                          const next = e.target.checked ? [...boards, b] : boards.filter((x) => x !== b);
                          const all = flow ? flow.boards : ALL_BOARDS;
                          set({ fr_boards: all.every((x) => next.includes(x)) ? undefined : ALL_BOARDS.filter((x) => next.includes(x)) });
                        }}
                      />
                      {BOARD_LABEL[b]}
                    </label>
                  ))}
                </div>
              </Field>
            </>
          )}
          <div className="font-semibold uppercase tracking-wide text-muted">Variables</div>
          <Field label="Selected rule (input and output)" hint="A string holds the rule id; an array or object set the id in a list; a struct the rule's fields with its custom properties. Setting it elsewhere opens that rule.">
            {varSel(c.fr_rule_variable, (v) => set({ fr_rule_variable: v }))}
          </Field>
          {!c.fr_read_only && (
            <Field label="Submitted proposal (output)" hint="The proposal Submit changes or a delete creates.">
              {varSel(c.fr_proposal_variable, (v) => set({ fr_proposal_variable: v }))}
            </Field>
          )}
          <EventsEditor events={c.fr_events ?? []} mod={mod} onChange={(ev) => set({ fr_events: ev.length ? ev : undefined })} label="On selection change" />
          {!c.fr_read_only && <EventsEditor events={c.fr_submit_events ?? []} mod={mod} onChange={(ev) => set({ fr_submit_events: ev.length ? ev : undefined })} label="On submit" />}
        </>
      ) : (
        <>
          <Field label="Proposals shown first">
            <select value={c.fr_status ?? "open"} onChange={(e) => set({ fr_status: e.target.value === "open" ? undefined : (e.target.value as "all") })} className={inputClass}>
              <option value="open">Open</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="all">All</option>
            </select>
          </Field>
          <p className="text-muted">Approving applies the proposal: the rule is created, edited or deleted. With sign-in on, the author cannot review their own proposal unless the workflow names reviewers.</p>
          <div className="font-semibold uppercase tracking-wide text-muted">Variables</div>
          <Field label="Selected proposal (input and output)" hint="A string holds the proposal id; an array or object set the id in a list; a struct its kind, status, rule, author and changed fields.">
            {varSel(c.fr_proposal_variable, (v) => set({ fr_proposal_variable: v }))}
          </Field>
          <Field label="The proposal's rule (output)" hint="The rule the selected proposal creates, edits or deletes (after approving a create: the new rule).">
            {varSel(c.fr_rule_variable, (v) => set({ fr_rule_variable: v }))}
          </Field>
          <EventsEditor events={c.fr_events ?? []} mod={mod} onChange={(ev) => set({ fr_events: ev.length ? ev : undefined })} label="On selection change" />
          <EventsEditor events={c.fr_review_events ?? []} mod={mod} onChange={(ev) => set({ fr_review_events: ev.length ? ev : undefined })} label="On approve or reject" />
        </>
      )}
    </div>
  );
}
