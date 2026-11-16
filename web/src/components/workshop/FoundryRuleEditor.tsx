"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import type { ObjectType } from "@/lib/ontology";
import type { LinkType } from "@/lib/ontologyModel";
import { contour } from "@/lib/contour";
import { rulesApi, type Block, type Board, type Mapping, type Proposal, type Rule, type Workflow } from "@/lib/foundryRules";

// The Foundry Rules rule form, used by the Foundry Rules page (app/foundry-rules/page.tsx) and the Workshop Rule
// Editor widget (RulesWidgets.tsx): metadata and custom properties, the input, logic blocks with previews, the rule
// output with the workflow's permitted values, and Contour import. The widget passes the logic boards and Contour
// import its configuration enables ("Enable optional features" in the Foundry Rules docs) and a read-only mode (the
// Rule Viewer); the page passes its own button labels and allows submitting an unchanged rule. Submitting an edit
// sends the version the form opened: the API refuses it when the rule changed since.

export const BOARD_LABEL: Record<Board, string> = {
  filter: "Filter",
  expression: "Expression",
  aggregation: "Aggregation",
  join: "Join",
  window: "Window",
  select: "Select columns",
  union: "Union",
  link: "Linked objects",
};
const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null"];
export const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function columnsOf(input: { kind: string; id: string }, types: ObjectType[]): string[] {
  const t = types.find((x) => x.id === input.id);
  return t ? t.properties.map((p) => p.api_name) : [];
}

/** A new rule of the workflow: its first input, one empty filter, its first output. */
export const blankRule = (w: Workflow): Rule => ({
  workflow_id: w.id,
  name: "",
  description: "",
  status: "active",
  custom: {},
  logic: { input: w.inputs[0], blocks: [{ kind: "filter", combine: "all", conditions: [] }], output: { output_id: w.outputs[0].id, mapping: {} } },
});

export function FoundryRuleEditor({
  w,
  rule,
  types,
  links,
  boards,
  contourImport = true,
  readOnly = false,
  submitBlocked,
  submitLabel,
  cancelLabel,
  allowUnchanged = false,
  onCancel,
  onSubmitted,
}: {
  w: Workflow;
  rule: Rule;
  types: ObjectType[];
  links: LinkType[];
  /** the logic boards offered when adding a block (unset: the workflow's) */
  boards?: Board[];
  contourImport?: boolean;
  /** the Rule Viewer: nothing can be changed; previews still run */
  readOnly?: boolean;
  /** why Submit is off (the module is edited, or does not write) */
  submitBlocked?: string;
  /** the submit button's label (unset: "Submit changes", or "Save rule" when proposals are off) */
  submitLabel?: string;
  /** the cancel button's label (unset: "Discard changes" / "Close") */
  cancelLabel?: string;
  /** an existing rule can be submitted unchanged (unset: Submit waits for a change) */
  allowUnchanged?: boolean;
  onCancel?: () => void;
  onSubmitted: (p: Proposal) => void;
}) {
  const [r, setR] = useState<Rule>(rule);
  const [preview, setPreview] = useState<{ at: number | null; data: Awaited<ReturnType<typeof rulesApi.preview>> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const out = w.outputs.find((o) => o.id === r.logic.output.output_id) ?? w.outputs[0];
  const setLogic = (c: Partial<Rule["logic"]>) => setR({ ...r, logic: { ...r.logic, ...c } });
  const setBlock = (i: number, c: Record<string, unknown>) => setLogic({ blocks: r.logic.blocks.map((b, j) => (j === i ? ({ ...b, ...c } as Block) : b)) });
  const cols = [...columnsOf(r.logic.input, types), ...r.logic.blocks.flatMap((b) => [b.as, ...((b.aggregations as { as?: string }[]) ?? []).map((a) => a.as)].filter(Boolean) as string[])];
  const run = (upto: number | null) =>
    rulesApi.preview(r, upto).then(
      (d) => (setPreview({ at: upto, data: d }), setError(null)),
      (e: Error) => setError(e.message),
    );
  const typeLinks = links.filter((l) => l.source.object_type_id === r.logic.input.id || l.target.object_type_id === r.logic.input.id);
  const offered = (boards ?? w.boards).filter((b) => w.boards.includes(b));
  const [importing, setImporting] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const dirty = JSON.stringify(r) !== JSON.stringify(rule);
  return (
    <div className="space-y-3" data-fr-editor={rule.id ?? "new"}>
      {!rule.id && contourImport && !readOnly && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={() => setImporting(!importing)} className={buttonClass.secondary}>
            <Icon name="download" className="h-3.5 w-3.5" /> Import from Contour
          </button>
          {importing && (
            <ContourPicker
              onPick={(aid, pid) =>
                rulesApi.importContour(w.id, aid, pid).then(
                  (d) => {
                    setR({ ...r, name: r.name || d.name, description: r.description || d.description, logic: { ...r.logic, input: d.logic.input, blocks: d.logic.blocks } });
                    setNotes(d.notes);
                    setImporting(false);
                    setError(null);
                  },
                  (e: Error) => setError(e.message),
                )
              }
            />
          )}
        </div>
      )}
      {notes.length > 0 && (
        <div className="rounded border border-warn/40 bg-warn/5 p-2 text-xs text-warn">
          <div className="font-medium">Imported from Contour; left out:</div>
          {notes.map((n, i) => (
            <div key={i}>· {n}</div>
          ))}
        </div>
      )}
      <fieldset disabled={readOnly} className="min-w-0 space-y-3">
        <Card title={readOnly ? r.name : rule.id ? `Edit ${rule.name}` : "New rule"}>
          <div className="grid gap-2 p-3 text-xs md:grid-cols-2">
            <input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Rule name" className={inputClass} aria-label="Rule name" />
            <select value={r.status} onChange={(e) => setR({ ...r, status: e.target.value as "active" })} className={inputClass} aria-label="Status">
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
            <textarea value={r.description} onChange={(e) => setR({ ...r, description: e.target.value })} placeholder="Description" rows={2} className={`${inputClass} md:col-span-2`} aria-label="Description" />
            {w.custom_properties.map((cp) => (
              <label key={cp.name} className="flex flex-col gap-0.5">
                <span className="text-muted">{cp.name}</span>
                <input value={show(r.custom[cp.name]).replace("—", "")} onChange={(e) => setR({ ...r, custom: { ...r.custom, [cp.name]: e.target.value } })} placeholder={cp.name} className={inputClass} />
              </label>
            ))}
          </div>
        </Card>
        <Card title="Logic">
          <div className="space-y-2 p-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-16 text-muted">Input</span>
              <select
                value={`${r.logic.input.kind}|${r.logic.input.id}`}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split("|");
                  setLogic({ input: { kind: kind as "object_type", id } });
                }}
                className={fieldClass}
                aria-label="Input"
              >
                {w.inputs.map((i) => (
                  <option key={i.id} value={`${i.kind}|${i.id}`}>
                    {i.kind === "object_type" ? (types.find((t) => t.id === i.id)?.display_name ?? i.id) : `Dataset ${i.id}`}
                  </option>
                ))}
              </select>
            </div>
            {r.logic.blocks.map((b, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-line bg-panel p-3">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-ocean/15 px-1.5 py-0.5 text-ocean">{i + 1}</span>
                  <span className="font-medium">{BOARD_LABEL[b.kind]}</span>
                  {!readOnly && (
                    <>
                      <button type="button" onClick={() => run(i)} className={`${buttonClass.ghost} ml-auto`}>
                        Preview
                      </button>
                      <button type="button" onClick={() => setLogic({ blocks: r.logic.blocks.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove block">
                        <Icon name="x" className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
                <BlockEditor b={b} cols={cols} types={types} links={typeLinks} w={w} set={(c) => setBlock(i, c)} />
              </div>
            ))}
            {!readOnly && offered.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  const kind = e.target.value as Board;
                  if (!kind) return;
                  const init: Record<Board, Block> = {
                    filter: { kind: "filter", combine: "all", conditions: [] },
                    expression: { kind: "expression", expression: "", as: "" },
                    aggregation: { kind: "aggregation", group_by: [], aggregations: [{ fn: "count", as: "count" }] },
                    join: { kind: "join", input: w.inputs[0], left_on: "", right_on: "", how: "inner", prefix: "j_" },
                    window: { kind: "window", partition_by: [], order_by: "", fn: "row_number", column: "", as: "row_number" },
                    select: { kind: "select", columns: [] },
                    union: { kind: "union", input: w.inputs[0] },
                    link: { kind: "link", link_type_id: typeLinks[0]?.id ?? "", direction: "forward", prefix: "linked_" },
                  };
                  setLogic({ blocks: [...r.logic.blocks, init[kind]] });
                }}
                className={fieldClass}
                aria-label="Add a logic block"
              >
                <option value="">+ Add logic block…</option>
                {offered.map((b) => (
                  <option key={b} value={b}>
                    {BOARD_LABEL[b]}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Card>
        <Card title="Rule output">
          <div className="space-y-2 p-3 text-xs">
            <select value={out.id} onChange={(e) => setLogic({ output: { output_id: e.target.value, mapping: {} } })} className={fieldClass} aria-label="Output">
              {w.outputs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            {out.fields.map((f) => {
              const m: Mapping | undefined = r.logic.output.mapping[f.name] ?? f.default ?? undefined;
              const setM = (x: Mapping | null) => {
                const mapping = { ...r.logic.output.mapping };
                if (x) mapping[f.name] = x;
                else delete mapping[f.name];
                setLogic({ output: { ...r.logic.output, mapping } });
              };
              const kinds = [...(f.column_values !== "none" ? ["column"] : []), ...(f.static_values !== "none" ? ["static"] : []), ...(f.template ? ["template"] : [])];
              return (
                <div key={f.name} className="flex flex-wrap items-center gap-2">
                  <span className="w-28 font-mono">
                    {f.name}
                    {f.required ? " *" : ""}
                  </span>
                  <select value={m?.kind ?? ""} onChange={(e) => setM(e.target.value ? ({ kind: e.target.value, ...(e.target.value === "column" ? { column: "" } : { value: "" }) } as Mapping) : null)} className={fieldClass} aria-label={`${f.name}: how it is filled`}>
                    <option value="">—</option>
                    {kinds.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  {m?.kind === "column" && (
                    <select value={m.column} onChange={(e) => setM({ kind: "column", column: e.target.value })} className={fieldClass}>
                      <option value="">column…</option>
                      {(f.column_values === "selection" ? f.columns : cols).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                  {m?.kind === "static" &&
                    (f.static_values === "selection" ? (
                      <select value={String(m.value ?? "")} onChange={(e) => setM({ kind: "static", value: e.target.value })} className={fieldClass}>
                        {f.values.map((v) => (
                          <option key={String(v)} value={String(v)}>
                            {String(v)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input value={String(m.value ?? "")} onChange={(e) => setM({ kind: "static", value: e.target.value })} className={`${fieldClass} w-40`} placeholder={f.static_values === "range" ? `${f.min ?? ""}–${f.max ?? ""}` : "value"} />
                    ))}
                  {m?.kind === "template" && <input value={m.value} onChange={(e) => setM({ kind: "template", value: e.target.value })} className={`${fieldClass} flex-1`} placeholder="{column} text" />}
                  <span className="text-muted">{f.type}</span>
                </div>
              );
            })}
          </div>
        </Card>
      </fieldset>
      <ErrorBox message={error} />
      {preview && (
        <Card title={preview.at === null ? "Output preview" : `After block ${preview.at + 1}`} count={preview.data.count}>
          <PreviewTable rows={preview.data.rows.map((x) => ("row" in x ? (x.row as Record<string, unknown>) : (x as Record<string, unknown>)))} />
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => run(null)} className={buttonClass.secondary}>
          <Icon name="play" className="h-3.5 w-3.5" /> Preview output
        </button>
        {!readOnly && (
          <>
            {onCancel && (
              <button type="button" onClick={onCancel} className={buttonClass.secondary}>
                {cancelLabel ?? (dirty ? "Discard changes" : "Close")}
              </button>
            )}
            <button
              type="button"
              disabled={!r.name || busy || !!submitBlocked || (!!rule.id && !dirty && !allowUnchanged)}
              title={submitBlocked}
              onClick={() => {
                setBusy(true);
                rulesApi
                  .propose(r)
                  .then(onSubmitted, (e: Error) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
              className={buttonClass.primary}
              data-fr-submit
            >
              {submitLabel ?? (w.require_proposals ? "Submit changes" : "Save rule")}
            </button>
            {submitBlocked && <span className="text-xs text-muted">{submitBlocked}</span>}
            {!submitBlocked && w.require_proposals && <span className="text-xs text-muted">Creates a proposal a reviewer approves.</span>}
          </>
        )}
      </div>
    </div>
  );
}

function BlockEditor({ b, cols, types, links, w, set }: { b: Block; cols: string[]; types: ObjectType[]; links: LinkType[]; w: Workflow; set: (c: Record<string, unknown>) => void }) {
  const colSelect = (value: string, onChange: (v: string) => void, label = "column…") => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
      <option value="">{label}</option>
      {cols.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
  const multi = (key: string) => (
    <input value={((b[key] as string[]) ?? []).join(", ")} onChange={(e) => set({ [key]: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="columns, comma separated" className={`${fieldClass} w-64`} />
  );
  const inputSelect = (
    <select
      value={`${(b.input as { kind: string; id: string })?.kind}|${(b.input as { id: string })?.id}`}
      onChange={(e) => {
        const [kind, id] = e.target.value.split("|");
        set({ input: { kind, id } });
      }}
      className={fieldClass}
    >
      {w.inputs.map((i) => (
        <option key={i.id} value={`${i.kind}|${i.id}`}>
          {i.kind === "object_type" ? (types.find((t) => t.id === i.id)?.display_name ?? i.id) : `Dataset ${i.id}`}
        </option>
      ))}
    </select>
  );
  if (b.kind === "filter") {
    const conds = (b.conditions as { column: string; op: string; value?: unknown }[]) ?? [];
    return (
      <div className="space-y-1">
        <select value={String(b.combine ?? "all")} onChange={(e) => set({ combine: e.target.value })} className={fieldClass}>
          <option value="all">All of</option>
          <option value="any">Any of</option>
        </select>
        {conds.map((c, i) => (
          <div key={i} className="flex flex-wrap gap-1">
            {colSelect(c.column, (v) => set({ conditions: conds.map((x, j) => (j === i ? { ...x, column: v } : x)) }))}
            <select value={c.op} onChange={(e) => set({ conditions: conds.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })} className={fieldClass}>
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {c.op !== "is_null" && c.op !== "not_null" && <input value={show(c.value).replace("—", "")} onChange={(e) => set({ conditions: conds.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className={`${fieldClass} w-32`} />}
            <button type="button" onClick={() => set({ conditions: conds.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove condition">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => set({ conditions: [...conds, { column: cols[0] ?? "", op: "eq", value: "" }] })} className={buttonClass.ghost}>
          + Condition
        </button>
      </div>
    );
  }
  if (b.kind === "expression")
    return (
      <div className="flex flex-wrap items-center gap-1">
        <input value={String(b.as ?? "")} onChange={(e) => set({ as: e.target.value })} placeholder="new column (empty: keep rows where true)" className={`${fieldClass} w-56`} />
        <span>=</span>
        <input value={String(b.expression ?? "")} onChange={(e) => set({ expression: e.target.value })} placeholder="e.g. (tarif_rs - tarif_inacbg) / tarif_inacbg * 100" className={`${fieldClass} flex-1 font-mono`} />
        <div className="w-full text-muted">Columns, numbers, &quot;text&quot;, + − × ÷, comparisons, and / or / not, round, abs, coalesce, concat, contains, days_between, if_else, lower, upper, number.</div>
      </div>
    );
  if (b.kind === "aggregation") {
    const aggs = (b.aggregations as { fn: string; column?: string; as?: string }[]) ?? [];
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <span className="text-muted">Group by</span>
          {multi("group_by")}
        </div>
        {aggs.map((a, i) => (
          <div key={i} className="flex gap-1">
            <select value={a.fn} onChange={(e) => set({ aggregations: aggs.map((x, j) => (j === i ? { ...x, fn: e.target.value } : x)) })} className={fieldClass}>
              {["count", "distinct", "sum", "avg", "min", "max"].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            {a.fn !== "count" && colSelect(a.column ?? "", (v) => set({ aggregations: aggs.map((x, j) => (j === i ? { ...x, column: v } : x)) }))}
            <input value={a.as ?? ""} onChange={(e) => set({ aggregations: aggs.map((x, j) => (j === i ? { ...x, as: e.target.value } : x)) })} placeholder="as" className={`${fieldClass} w-28`} />
          </div>
        ))}
        <button type="button" onClick={() => set({ aggregations: [...aggs, { fn: "count", as: `agg${aggs.length + 1}` }] })} className={buttonClass.ghost}>
          + Aggregation
        </button>
      </div>
    );
  }
  if (b.kind === "join")
    return (
      <div className="flex flex-wrap items-center gap-1">
        {inputSelect}
        <span>on</span>
        {colSelect(String(b.left_on ?? ""), (v) => set({ left_on: v }), "left column")}
        <span>=</span>
        <input value={String(b.right_on ?? "")} onChange={(e) => set({ right_on: e.target.value })} placeholder="right column" className={`${fieldClass} w-32`} />
        <select value={String(b.how ?? "inner")} onChange={(e) => set({ how: e.target.value })} className={fieldClass}>
          <option value="inner">inner</option>
          <option value="left">left</option>
        </select>
        <input value={String(b.prefix ?? "")} onChange={(e) => set({ prefix: e.target.value })} placeholder="prefix" className={`${fieldClass} w-20`} />
      </div>
    );
  if (b.kind === "union") return <div className="flex items-center gap-1">Add the rows of {inputSelect}</div>;
  if (b.kind === "link")
    return (
      <div className="flex flex-wrap items-center gap-1">
        <select
          value={`${b.link_type_id}|${b.direction}`}
          onChange={(e) => {
            const [id, direction] = e.target.value.split("|");
            set({ link_type_id: id, direction });
          }}
          className={fieldClass}
        >
          {links.flatMap((l) => [
            <option key={`${l.id}f`} value={`${l.id}|forward`}>
              {l.display_name} →
            </option>,
            <option key={`${l.id}r`} value={`${l.id}|reverse`}>
              ← {l.display_name}
            </option>,
          ])}
        </select>
        <input value={String(b.prefix ?? "")} onChange={(e) => set({ prefix: e.target.value })} placeholder="prefix" className={`${fieldClass} w-24`} />
        <select value={String(b.how ?? "inner")} onChange={(e) => set({ how: e.target.value })} className={fieldClass}>
          <option value="inner">only rows with links</option>
          <option value="left">keep rows without links</option>
        </select>
      </div>
    );
  if (b.kind === "window")
    return (
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-muted">Partition</span>
        {multi("partition_by")}
        <span className="text-muted">order by</span>
        {colSelect(String(b.order_by ?? ""), (v) => set({ order_by: v }))}
        <select value={String(b.fn ?? "row_number")} onChange={(e) => set({ fn: e.target.value })} className={fieldClass}>
          {["row_number", "rank", "lag", "lead", "running_sum", "count"].map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {["lag", "lead", "running_sum"].includes(String(b.fn)) && colSelect(String(b.column ?? ""), (v) => set({ column: v }))}
        <input value={String(b.as ?? "")} onChange={(e) => set({ as: e.target.value })} placeholder="as" className={`${fieldClass} w-28`} />
      </div>
    );
  return <div className="flex items-center gap-1">Keep {multi("columns")}</div>;
}

export function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))].filter((c) => c !== "__pk" && c !== "resume" && c !== "resumeEmbedding").slice(0, 12);
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-panel-2 text-left text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap px-3 py-1.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="max-w-48 truncate px-3 py-1.5">
                  {show(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Pick a Contour analysis and one of its paths. */
function ContourPicker({ onPick }: { onPick: (analysisId: string, pathId: string) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [aid, setAid] = useState("");
  const [paths, setPaths] = useState<{ id: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  useEffect(() => {
    contour.list().then((l) => setList(l.map((x) => ({ id: x.id, name: x.name }))), () => setList([]));
  }, []);
  useEffect(() => {
    if (!aid) return;
    contour.get(aid).then(
      (v) => {
        const ps = v.analysis.paths.map((p) => ({ id: p.id, name: p.name || p.id }));
        setPaths(ps);
        setPid(ps[0]?.id ?? "");
      },
      () => setPaths([]),
    );
  }, [aid]);
  return (
    <>
      <select value={aid} onChange={(e) => setAid(e.target.value)} className={fieldClass} aria-label="Contour analysis">
        <option value="">Analysis…</option>
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {aid && (
        <select value={pid} onChange={(e) => setPid(e.target.value)} className={fieldClass} aria-label="Path">
          {paths.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <button type="button" disabled={!aid || !pid} onClick={() => onPick(aid, pid)} className={buttonClass.primary}>
        Import
      </button>
    </>
  );
}
