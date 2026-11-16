"use client";

import { useMemo, useState } from "react";
import {
  abstractSteps,
  ARG_MARK,
  mapStrings,
  type Params,
  COL_TYPES,
  customStepDef,
  FALSE_PORT,
  refLabel,
  uid,
  type Column,
  type ColType,
  type CustomExpression,
  type CustomFunction,
  type CustomTransform,
  type Dataset,
  type FunctionArg,
  type NodeResult,
  type Pipeline,
  type PipelineNode,
  type Subgraph,
  type SubgraphInput,
  type SubgraphNode,
} from "@/lib/pipeline";
import { useSqlEngine } from "@/lib/useSqlEngine";
import { Icon } from "../Icon";
import { DataPreview } from "./DataPreview";
import { buttonClass, inputClass, Modal } from "./Modal";
import { TransformEditor } from "./TransformEditor";
import { UdfReusables } from "./Udfs";
import { PyFunctionReusables } from "./PyFunctions";
import { Field, Tabs } from "./ui";
import { confirmDialog } from "@/lib/dialogs";

const ARG_TYPES: (ColType | "Any")[] = ["Any", ...COL_TYPES];

/** Where a custom function or subgraph is used. */
function usages(p: Pipeline, id: string, kind: "fn" | "subgraph"): string[] {
  const all = [...p.nodes, ...(p.subgraphs ?? []).flatMap((s) => s.nodes)];
  if (kind === "subgraph") return all.filter((n) => n.kind === "subgraph" && n.subgraph === id).map((n) => n.name);
  return all.filter((n) => n.kind === "transform" && n.steps.some((s) => s.kind === `fn:${id}`)).map((n) => n.name);
}

export function ReusablesDialog({
  tab: initialTab,
  pipeline,
  change,
  onEditSubgraph,
  onClose,
}: {
  tab: "expressions" | "transforms" | "subgraphs" | "udfs";
  pipeline: Pipeline;
  change: (fn: (p: Pipeline) => Pipeline) => void;
  onEditSubgraph: (def: Subgraph) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [edit, setEdit] = useState<CustomFunction | null>(null);
  const fns = pipeline.functions ?? [];
  const saveFn = (fn: CustomFunction) => change((p) => ({ ...p, functions: (p.functions ?? []).some((f) => f.id === fn.id) ? (p.functions ?? []).map((f) => (f.id === fn.id ? fn : f)) : [...(p.functions ?? []), fn] }));
  const removeFn = async (fn: CustomFunction) => {
    const used = usages(pipeline, fn.id, "fn");
    if (used.length && !(await confirmDialog(`"${fn.name}" is used in ${used.join(", ")}. Delete it anyway? Those boards will fail.`))) return;
    change((p) => ({ ...p, functions: (p.functions ?? []).filter((f) => f.id !== fn.id) }));
  };

  if (edit?.kind === "expression")
    return (
      <ExpressionEditor
        fn={edit}
        onSave={(fn) => {
          saveFn(fn);
          setEdit(null);
        }}
        onClose={() => setEdit(null)}
      />
    );
  if (edit?.kind === "transform")
    return (
      <CustomTransformEditor
        fn={edit}
        functions={fns}
        parameters={pipeline.parameters}
        onSave={(fn) => {
          saveFn(fn);
          setEdit(null);
        }}
        onClose={() => setEdit(null)}
      />
    );

  const list = tab === "expressions" ? fns.filter((f) => f.kind === "expression") : fns.filter((f) => f.kind === "transform");
  return (
    <Modal title="Reusables" icon="layers" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "expressions", label: "Custom expressions", badge: fns.filter((f) => f.kind === "expression").length },
            { id: "transforms", label: "Custom transform paths", badge: fns.filter((f) => f.kind === "transform").length },
            { id: "subgraphs", label: "Subgraphs", badge: (pipeline.subgraphs ?? []).length },
            { id: "udfs", label: "User-defined functions", badge: fns.filter((f) => f.kind === "udf" || f.kind === "pyfn").length },
          ]}
        />
        {tab === "udfs" ? (
          <>
            <UdfReusables pipeline={pipeline} usages={(id) => usages(pipeline, id, "fn")} onSave={saveFn} onRemove={removeFn} />
            <PyFunctionReusables pipeline={pipeline} usages={(id) => usages(pipeline, id, "fn")} onSave={saveFn} onRemove={removeFn} />
          </>
        ) : tab === "subgraphs" ? (
          <>
            <p className="text-xs text-muted">
              A subgraph packages one or more transforms into a reusable block with typed inputs and one output. Apply it after any node whose output has the inputs&apos;
              required columns; updating the subgraph updates every instance.
            </p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {(pipeline.subgraphs ?? []).map((s) => {
                const used = usages(pipeline, s.id, "subgraph");
                return (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Icon name="layers" className="h-4 w-4 text-ocean" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{s.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {s.inputs.map((i) => `${i.name} (${i.columns.length} cols)`).join(", ") || "no inputs"} · {s.nodes.length} nodes · used {used.length}×
                      </span>
                    </span>
                    <button type="button" onClick={() => onEditSubgraph(s)} className={buttonClass.secondary}>
                      <Icon name="edit" className="h-3.5 w-3.5" /> Edit
                    </button>
                    <button
                      type="button"
                      title={used.length ? `Used by ${used.join(", ")}` : "Delete"}
                      disabled={used.length > 0}
                      onClick={async () => (await confirmDialog(`Delete the subgraph "${s.name}"?`)) && change((p) => ({ ...p, subgraphs: (p.subgraphs ?? []).filter((x) => x.id !== s.id) }))}
                      className="rounded p-1.5 text-muted hover:text-bad disabled:opacity-30"
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
              {!(pipeline.subgraphs ?? []).length && <li className="px-3 py-6 text-center text-sm text-muted">No subgraphs yet.</li>}
            </ul>
            <div className="flex justify-end">
              <button type="button" onClick={() => onEditSubgraph({ id: uid(), name: "New subgraph", inputs: [], nodes: [], output: "" })} className={buttonClass.primary}>
                <Icon name="plus" className="h-3.5 w-3.5" /> Add custom subgraph
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted">
              {tab === "expressions"
                ? "A custom expression saves one Spark SQL expression with typed arguments. Search for it by name in any transform, like a built-in one."
                : "A custom transform path saves a series of transform boards as one transform with typed column arguments. Create one from boards (select them with Shift+↓, then +) or here."}
            </p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {list.map((f) => {
                const used = usages(pipeline, f.id, "fn");
                return (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Icon name={f.kind === "expression" ? "code" : "transform"} className="h-4 w-4 text-ocean" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {f.name}({f.args.map((a) => `${a.name}: ${a.type === "Any" ? "Expression" : `Expression<${a.type}>`}`).join(", ")})
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {f.description || (f.kind === "expression" ? f.definition : `${f.steps.length} boards`)} · used {used.length}×
                      </span>
                    </span>
                    <button type="button" onClick={() => setEdit(f)} className={buttonClass.secondary}>
                      <Icon name="edit" className="h-3.5 w-3.5" /> Edit
                    </button>
                    <button type="button" onClick={() => removeFn(f)} className="rounded p-1.5 text-muted hover:text-bad">
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
              {!list.length && <li className="px-3 py-6 text-center text-sm text-muted">None yet.</li>}
            </ul>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() =>
                  setEdit(
                    tab === "expressions"
                      ? { id: uid(), kind: "expression", name: "my_expression", args: [{ id: uid(), name: "x", type: "String" }], definition: "upper({x})" }
                      : { id: uid(), kind: "transform", name: "My transform", args: [{ id: uid(), name: "value", type: "String" }], steps: [] },
                  )
                }
                className={buttonClass.primary}
              >
                <Icon name="plus" className="h-3.5 w-3.5" /> {tab === "expressions" ? "Add custom expression" : "Add custom transform"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ArgsEditor({ args, onChange }: { args: FunctionArg[]; onChange: (a: FunctionArg[]) => void }) {
  return (
    <div className="space-y-1.5">
      {args.map((a, i) => (
        <div key={a.id} className="flex items-center gap-1.5">
          <input
            value={a.name}
            onChange={(e) => onChange(args.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^\w]/g, "_") } : x)))}
            className={`${inputClass} w-40 border-sand/50 bg-sand/10 font-mono text-xs`}
            aria-label="Argument name"
          />
          <span className="text-xs text-muted">Expression&lt;</span>
          <select value={a.type} onChange={(e) => onChange(args.map((x, j) => (j === i ? { ...x, type: e.target.value as ColType | "Any" } : x)))} className={`${inputClass} w-32 text-xs`}>
            {ARG_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <span className="text-xs text-muted">&gt;</span>
          <button type="button" onClick={() => onChange(args.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-bad">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...args, { id: uid(), name: `arg${args.length + 1}`, type: "String" }])} className="text-xs text-ocean hover:underline">
        + Add argument
      </button>
    </div>
  );
}

const sampleValue = (t: ColType | "Any") =>
  t === "Integer" || t === "Long" || t === "Short" || t === "Byte" ? "42" : t === "Double" || t === "Float" || t === "Decimal" ? "3.14" : t === "Boolean" ? "true" : t === "Date" ? "2024-01-15" : t === "Timestamp" ? "2024-01-15T10:30:00.000Z" : "Hello World";

function ExpressionEditor({ fn, onSave, onClose }: { fn: CustomExpression; onSave: (fn: CustomExpression) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(fn);
  const [samples, setSamples] = useState<Record<string, string>>(() => Object.fromEntries(fn.args.map((a) => [a.id, sampleValue(a.type)])));
  const sql = useSqlEngine(true);
  const trial = useMemo(() => {
    if (!sql.engine) return { error: sql.error ?? "Loading the SQL engine…" };
    try {
      const columns: Column[] = draft.args.map((a) => ({ name: `__${a.name}`, type: a.type === "Any" ? "String" : a.type }));
      const row = Object.fromEntries(
        draft.args.map((a) => {
          const v = samples[a.id] ?? "";
          const t = a.type;
          return [`__${a.name}`, v === "" ? null : t === "Boolean" ? v === "true" : ["Integer", "Long", "Short", "Byte", "Double", "Float", "Decimal"].includes(t) ? Number(v) : v];
        }),
      );
      const def = customStepDef({ ...draft, args: draft.args });
      const params = Object.fromEntries(draft.args.map((a) => [`arg_${a.id}`, `__${a.name}`]));
      const out = def.run({ columns, rows: [row] }, { ...params, output: "result" }, { names: () => [], table: () => undefined, sql });
      const col = out.columns.find((c) => c.name === "result");
      return { value: out.rows[0]?.result ?? null, type: col?.type };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [draft, samples, sql]);
  const valid = draft.name.trim() && draft.definition.trim() && draft.args.every((a) => a.name);
  return (
    <Modal title="Custom expression" icon="code" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Description">
            <input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={inputClass} />
          </Field>
        </div>
        <Field label="Arguments" hint="Typed arguments: a board using the expression must pass a column of that type (cast it first otherwise).">
          <ArgsEditor args={draft.args} onChange={(args) => setDraft({ ...draft, args })} />
        </Field>
        <Field label="Definition" required hint="A Spark SQL expression; write {argument} where an argument goes, e.g. sha2(concat_ws('-', {first}, {last}), 256).">
          <textarea value={draft.definition} onChange={(e) => setDraft({ ...draft, definition: e.target.value })} rows={4} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
        </Field>
        <div className="rounded-md border border-line-2 p-2.5">
          <div className="mb-1.5 text-xs font-medium text-soft">Try it</div>
          <div className="flex flex-wrap gap-2">
            {draft.args.map((a) => (
              <label key={a.id} className="flex items-center gap-1 text-xs">
                <span className="font-mono text-muted">{a.name}</span>
                <input value={samples[a.id] ?? ""} onChange={(e) => setSamples({ ...samples, [a.id]: e.target.value })} className={`${inputClass} w-36 py-1 text-xs`} />
              </label>
            ))}
          </div>
          <p className={`mt-2 font-mono text-xs ${"error" in trial ? "text-bad" : "text-ok"}`}>
            {"error" in trial ? trial.error : `= ${trial.value === null ? "null" : String(trial.value)}  ·  ${trial.type}`}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!valid} onClick={() => onSave({ ...draft, name: draft.name.trim() })} className={buttonClass.primary}>
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Edits a custom transform's boards against a schema made of its arguments. */
function CustomTransformEditor({
  fn,
  functions,
  parameters,
  onSave,
  onClose,
}: {
  fn: CustomTransform;
  functions: CustomFunction[];
  parameters: Pipeline["parameters"];
  onSave: (fn: CustomTransform) => void;
  onClose: () => void;
}) {
  const [args, setArgs] = useState(fn.args);
  const [name, setName] = useState(fn.name);
  const [description, setDescription] = useState(fn.description ?? "");
  const [stage, setStage] = useState<"args" | "boards">(fn.steps.length ? "boards" : "args");
  // boards shown with argument names as columns
  const steps = useMemo(
    () =>
      fn.steps.map((st) => ({
        ...st,
        params: mapStrings(st.params, (v) => (v.startsWith(ARG_MARK) ? (fn.args.find((a) => a.id === v.slice(ARG_MARK.length))?.name ?? v) : v)) as Params,
      })),
    [fn.steps, fn.args],
  );
  const input = { columns: args.map((a) => ({ name: a.name, type: a.type === "Any" ? ("String" as ColType) : a.type })), rows: [] };
  if (stage === "args")
    return (
      <Modal title="Custom transform — arguments" icon="transform" onClose={onClose} wide>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" required>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Description">
              <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
            </Field>
          </div>
          <Field label="Arguments" hint="Each argument is a column the transform reads; boards see them as columns named after the arguments.">
            <ArgsEditor args={args} onChange={setArgs} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" disabled={!name.trim() || !args.length} onClick={() => setStage("boards")} className={buttonClass.primary}>
              Next: boards
            </button>
          </div>
        </div>
      </Modal>
    );
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <TransformEditor
        node={{ id: fn.id, kind: "transform", name, input: "", steps, x: 0, y: 0 }}
        input={input}
        inputName={`Arguments: ${args.map((a) => a.name).join(", ")}`}
        functions={functions.filter((f) => f.id !== fn.id)}
        parameters={parameters}
        applyLabel="Apply all changes"
        onApply={(n, s) => {
          const abstracted = abstractSteps(s, args.map((a) => ({ column: a.name, arg: a })));
          onSave({ ...fn, name: n.trim() || name, description, args, steps: abstracted });
        }}
        onClose={onClose}
      />
    </div>
  );
}

export function CreateSubgraphDialog({
  replace,
  subgraphs,
  onCreate,
  onReplace,
  onClose,
}: {
  replace: boolean;
  subgraphs: Subgraph[];
  onCreate: () => void;
  onReplace: (s: Subgraph) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState(subgraphs[0]?.id ?? "");
  return (
    <Modal title={replace ? "Replace with subgraph" : "Create subgraph"} icon="layers" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        {replace ? (
          <>
            <p className="text-xs text-muted">The selected nodes are replaced by one instance of an existing subgraph; its inputs are mapped to the nodes feeding the selection, in order.</p>
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} className={inputClass}>
              {subgraphs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.inputs.length} inputs)
                </option>
              ))}
            </select>
          </>
        ) : (
          <p className="text-xs text-muted">
            A subgraph editor opens with the selected nodes, plus Input nodes for what feeds them (their schemas filled in) and the selection&apos;s last node as output. When it
            is valid, select Apply all subgraph changes: the nodes are replaced by the subgraph.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          {replace ? (
            <button type="button" disabled={!chosen} onClick={() => onReplace(subgraphs.find((s) => s.id === chosen)!)} className={buttonClass.primary}>
              Replace
            </button>
          ) : (
            <button type="button" onClick={onCreate} className={buttonClass.primary}>
              Create subgraph
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Subgraph configuration of an instance: Inputs (mapping), Configuration, Outputs (preview); Apply and Close. */
export function SubgraphApplyDialog({
  node,
  def,
  nodes,
  result,
  onChange,
  onEdit,
  onClose,
}: {
  node: SubgraphNode;
  def: Subgraph | undefined;
  nodes: PipelineNode[];
  result: (ref: string) => NodeResult;
  onChange: (patch: Partial<SubgraphNode>) => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"inputs" | "config" | "outputs">("inputs");
  const r = result(node.id);
  const refs = nodes.filter((n) => n.id !== node.id && n.kind !== "input").flatMap((n) => (n.kind === "split" ? [n.id, n.id + FALSE_PORT] : [n.id]));
  if (!def)
    return (
      <Modal title="Subgraph" icon="layers" onClose={onClose}>
        <p className="p-4 text-sm text-bad">This subgraph was deleted.</p>
      </Modal>
    );
  return (
    <Modal title={`Subgraph configuration — ${def.name}`} icon="layers" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "inputs", label: "Inputs" },
            { id: "config", label: "Configuration" },
            { id: "outputs", label: "Outputs", tone: r.error ? "bad" : undefined, badge: r.error ? "!" : undefined },
          ]}
        />
        {tab === "inputs" && (
          <div className="space-y-2">
            <p className="text-xs text-muted">How the graph feeds the subgraph. Each input needs its required columns.</p>
            {def.inputs.map((inp, i) => {
              const t = node.inputs[i] ? result(node.inputs[i]).table : undefined;
              const missing = t ? inp.columns.filter((c) => !t.columns.some((x) => x.name === c.name)) : [];
              return (
                <div key={inp.id} className="rounded-md border border-line-2 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-32 truncate font-medium">{inp.name}</span>
                    <select
                      value={node.inputs[i] ?? ""}
                      onChange={(e) => {
                        const inputs = [...node.inputs];
                        inputs[i] = e.target.value;
                        onChange({ inputs });
                      }}
                      className={`${inputClass} flex-1 py-1 text-xs`}
                    >
                      <option value="">Choose a node…</option>
                      {refs.map((ref) => (
                        <option key={ref} value={ref}>
                          {refLabel(nodes, ref)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {inp.columns.map((c) => {
                      const bad = missing.some((m) => m.name === c.name);
                      return (
                        <span key={c.name} className={`rounded px-1 font-mono text-[10px] ring-1 ${bad ? "text-bad ring-bad/50" : "text-soft ring-line-2"}`}>
                          {c.name}: {c.type}
                        </span>
                      );
                    })}
                    {!inp.columns.length && <span className="text-muted">no required columns</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {tab === "config" && <p className="py-4 text-center text-xs text-muted">This subgraph has no parameters that need configuration.</p>}
        {tab === "outputs" && (
          <div className="flex h-72 flex-col rounded-md border border-line">
            {r.table ? <DataPreview table={r.table} title={`${def.name} output`} /> : <p className="p-4 text-sm text-bad">{r.error}</p>}
          </div>
        )}
        <div className="flex justify-between">
          <button type="button" onClick={onEdit} className={buttonClass.secondary}>
            <Icon name="edit" className="h-3.5 w-3.5" /> Edit subgraph
          </button>
          <button type="button" onClick={onClose} className={buttonClass.primary}>
            Apply and Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Required columns of a subgraph input: added by hand or copied from a dataset's schema. */
export function InputSchemaDialog({
  input,
  datasets,
  onApply,
  onClose,
}: {
  input: SubgraphInput;
  datasets: Dataset[];
  onApply: (i: SubgraphInput) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(input.name);
  const [columns, setColumns] = useState<Column[]>(input.columns);
  const [from, setFrom] = useState("");
  return (
    <Modal title="Subgraph input" icon="download" onClose={onClose}>
      <div className="space-y-3 p-4">
        <Field label="Input name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Required columns</div>
          <ul className="space-y-1">
            {columns.map((c, i) => (
              <li key={i} className="flex gap-1.5">
                <input value={c.name} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${inputClass} py-1 text-xs`} />
                <select value={c.type} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, type: e.target.value as ColType } : x)))} className={`${inputClass} w-32 py-1 text-xs`}>
                  {COL_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <button type="button" onClick={() => setColumns(columns.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-bad">
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={() => setColumns([...columns, { name: `column${columns.length + 1}`, type: "String" }])} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add column
            </button>
            <select value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} flex-1 text-xs`}>
              <option value="">From dataset…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.columns.length} columns)
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!from}
              onClick={() => {
                const d = datasets.find((x) => x.id === from);
                if (d) setColumns(d.columns);
              }}
              className={buttonClass.secondary}
            >
              Select
            </button>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim() || columns.some((c) => !c.name.trim())} onClick={() => onApply({ ...input, name: name.trim(), columns })} className={buttonClass.primary}>
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}

