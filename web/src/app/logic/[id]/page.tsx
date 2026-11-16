"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge, ErrorBox, Field, OutputView, ParamInput } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import { branchRuns, type BranchRunScenario } from "@/lib/branchRuns";
import { om, type BranchRow } from "@/lib/ontologyModel";
import { scenarios as scenarioApi, type Scenario } from "@/lib/scenarios";
import {
  BLOCKS,
  blockInfo,
  ontology,
  typeLabel,
  type ActionType,
  type Block,
  type BlockType,
  type Expr,
  type InputType,
  type LlmModel,
  type LogicFunction,
  type LogicInput,
  type LogicRun,
  type ObjectType,
} from "@/lib/ontology";

type Var = { path: string; label: string; type: string };

/** Everything a block can read: inputs (and object properties) and the blocks above it. */
function variablesBefore(fn: LogicFunction, index: number, types: ObjectType[]): Var[] {
  const vars: Var[] = [];
  for (const i of fn.inputs) {
    if (i.type === "object") {
      const t = types.find((x) => x.id === i.object_type_id);
      vars.push({ path: i.name, label: `${i.name} (${t?.display_name ?? "object"})`, type: "object" });
      for (const p of t?.properties ?? []) vars.push({ path: `${i.name}.${p.api_name}`, label: `${i.name}.${p.api_name}`, type: p.type });
    } else vars.push({ path: i.name, label: i.name, type: i.type });
  }
  for (const b of fn.blocks.slice(0, index)) {
    vars.push({
      path: b.name,
      label: b.name,
      type: b.type === "use_llm" ? String(b.config.output ?? "string") : b.type === "semantic_search" && b.config.text_property ? "String" : blockInfo(b.type).output,
    });
  }
  return vars;
}

const camel = (s: string) => {
  const words = s.match(/[A-Za-z0-9]+/g) ?? ["block"];
  const out = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join("");
  return /^[A-Za-z]/.test(out) ? out : `b${out}`;
};

function freeName(fn: LogicFunction, base: string) {
  const taken = new Set([...fn.inputs.map((i) => i.name), ...fn.blocks.map((b) => b.name)]);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  return name;
}

export default function LogicEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [saved, setSaved] = useState<LogicFunction | null>(null);
  const [fn, setFn] = useState<LogicFunction | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingName, setEditingName] = useState(false);

  useEffect(() => {
    Promise.all([ontology.logic(id), ontology.objectTypes(), ontology.actionTypes(), ontology.models().catch(() => [])])
      .then(([f, t, a, m]) => {
        setSaved(f);
        setFn(f);
        setTypes(t);
        setActions(a);
        setModels(m);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const dirty = !!fn && !!saved && JSON.stringify([fn.name, fn.description, fn.inputs, fn.blocks, fn.output]) !== JSON.stringify([saved.name, saved.description, saved.inputs, saved.blocks, saved.output]);

  const save = useCallback(async () => {
    if (!fn) return null;
    setSaving(true);
    setSaveError(null);
    try {
      const s = await ontology.saveLogic(fn.id, { name: fn.name, description: fn.description, inputs: fn.inputs, blocks: fn.blocks, output: fn.output });
      setSaved(s);
      setFn((cur) => (cur ? { ...cur, run_count: s.run_count, last_run: s.last_run, updated_at: s.updated_at } : s));
      return s;
    } catch (e) {
      setSaveError((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [fn]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [save]);

  if (error) return <ApiError message={error} />;
  if (!fn) return <Loading />;

  const update = (changes: Partial<LogicFunction>) => setFn({ ...fn, ...changes });
  const setBlock = (i: number, b: Block) => update({ blocks: fn.blocks.map((x, j) => (j === i ? b : x)) });
  const addBlock = (type: BlockType) => {
    const name = freeName(fn, camel(blockInfo(type).label));
    const config: Record<string, unknown> =
      type === "join_array"
        ? { separator: "\\n" }
        : type === "use_llm"
          ? { model: models.find((m) => m.default)?.id ?? "vertex/openai/gpt-oss-120b-maas", output: "string", prompt: "" }
          : type === "extract_pdf_text"
            ? { method: "raw", on_error: "fail" }
            : type === "semantic_search"
              ? { k: 5, mode: "semantic" }
              : {};
    // point the new block at the obvious variable: the last block, or the first media property
    const vars = variablesBefore(fn, fn.blocks.length, types);
    if (type === "join_array") {
      const arr = [...vars].reverse().find((v) => v.type === "Array<String>" || v.type === "string_array");
      if (arr) config.array = { var: arr.path };
    }
    if (type === "extract_pdf_text") {
      const media = vars.find((v) => v.type === "media");
      if (media) config.media = { var: media.path };
    }
    const next = 1 + Math.max(0, ...fn.blocks.map((b) => Number(b.id.replace(/\D/g, "")) || 0));
    update({ blocks: [...fn.blocks, { id: `b${next}`, name, type, config }] });
  };
  const move = (i: number, d: -1 | 1) => {
    const blocks = [...fn.blocks];
    [blocks[i], blocks[i + d]] = [blocks[i + d], blocks[i]];
    update({ blocks });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="AIP Logic" icon="logic" href="/logic" crumbs={[{ label: fn.name }]}>
        {saveError && <span className="max-w-md truncate text-xs text-bad" title={saveError}>{saveError}</span>}
        <span className="text-xs text-muted">{dirty ? "Unsaved changes" : `Saved ${when(saved!.updated_at)}`}</span>
        <button type="button" onClick={save} disabled={!dirty || saving} className={buttonClass.primary}>
          <Icon name="save" className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save"}
        </button>
      </AppHeader>

      <div className="flex min-h-0 flex-1">
        <section className="dot-grid min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-4 p-8">
            <div>
              {editingName ? (
                <input
                  autoFocus
                  value={fn.name}
                  onChange={(e) => update({ name: e.target.value })}
                  onBlur={() => setEditingName(false)}
                  onKeyDown={(e) => e.key === "Enter" && setEditingName(false)}
                  className={`${inputClass} text-lg font-semibold`}
                />
              ) : (
                <button type="button" onClick={() => setEditingName(true)} className="group flex items-center gap-2 text-xl font-semibold">
                  {fn.name} <Icon name="pencil" className="h-3.5 w-3.5 text-muted opacity-0 group-hover:opacity-100" />
                </button>
              )}
              <input value={fn.description} onChange={(e) => update({ description: e.target.value })} placeholder="Add description…" className="mt-1 w-full bg-transparent text-sm text-soft outline-none placeholder:text-muted" />
            </div>

            <InputsCard fn={fn} types={types} onChange={(inputs) => update({ inputs })} />

            {fn.blocks.map((b, i) => (
              <div key={b.id}>
                <div className="mx-auto h-4 w-px bg-line-2" />
                <BlockCard
                  block={b}
                  index={i}
                  count={fn.blocks.length}
                  isOutput={(fn.output ?? fn.blocks[fn.blocks.length - 1]?.name) === b.name}
                  vars={variablesBefore(fn, i, types)}
                  types={types}
                  actions={actions}
                  models={models}
                  onChange={(nb) => {
                    // a rename keeps the output pointing at the block
                    if (nb.name !== b.name && fn.output === b.name) update({ output: nb.name, blocks: fn.blocks.map((x, j) => (j === i ? nb : x)) });
                    else setBlock(i, nb);
                  }}
                  onMove={(d) => move(i, d)}
                  onDelete={() => update({ blocks: fn.blocks.filter((_, j) => j !== i), output: fn.output === b.name ? null : fn.output })}
                  onOutput={() => update({ output: b.name })}
                />
              </div>
            ))}

            <div className="mx-auto h-4 w-px bg-line-2" />
            <div className="rounded-xl border border-dashed border-line-2 bg-panel/70 p-3">
              <div className="mb-2 text-center text-xs text-muted">Add a block</div>
              <div className="flex flex-wrap justify-center gap-2">
                {BLOCKS.map((b) => (
                  <button key={b.type} type="button" onClick={() => addBlock(b.type)} title={b.description} className={buttonClass.secondary}>
                    <Icon name={b.icon} className="h-3.5 w-3.5" /> {b.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <RunPanel fn={fn} dirty={dirty} types={types} onSave={save} />
      </div>
    </div>
  );
}

function InputsCard({ fn, types, onChange }: { fn: LogicFunction; types: ObjectType[]; onChange: (inputs: LogicInput[]) => void }) {
  const set = (i: number, c: Partial<LogicInput>) => onChange(fn.inputs.map((x, j) => (j === i ? { ...x, ...c } : x)));
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold">
        <Icon name="right" className="h-4 w-4 text-ocean" /> Inputs
      </div>
      <div className="space-y-2 p-3">
        {fn.inputs.length === 0 && <p className="px-1 text-sm text-muted">No inputs. Add an object input to work on one object at a time.</p>}
        {fn.inputs.map((inp, i) => (
          <div key={i} className="flex items-center gap-2">
            <input value={inp.name} onChange={(e) => set(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} placeholder="variableName" className={`${fieldClass} w-44 font-mono`} />
            <select
              value={inp.type === "object" ? `object:${inp.object_type_id ?? ""}` : inp.type}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith("object:")) set(i, { type: "object", object_type_id: v.slice(7) });
                else set(i, { type: v as InputType, object_type_id: undefined });
              }}
              className={`${fieldClass} flex-1`}
            >
              <optgroup label="Objects">
                {types.map((t) => (
                  <option key={t.id} value={`object:${t.id}`}>
                    {t.display_name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Values">
                {(["string", "integer", "double", "boolean", "media"] as const).map((t) => (
                  <option key={t} value={t}>
                    {typeLabel(t)}
                  </option>
                ))}
              </optgroup>
            </select>
            <select value={inp.required === false ? "optional" : "required"} onChange={(e) => set(i, { required: e.target.value === "required" })} className={fieldClass}>
              <option value="required">Required</option>
              <option value="optional">Optional</option>
            </select>
            <button type="button" onClick={() => onChange(fn.inputs.filter((_, j) => j !== i))} className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-bad" aria-label="Remove input">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange([
              ...fn.inputs,
              types[0]
                ? { name: freeName(fn, camel(`input ${types[0].display_name}`)), type: "object", object_type_id: types[0].id, required: true }
                : { name: freeName(fn, "input"), type: "string", required: true },
            ])
          }
          className={buttonClass.ghost}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> Add
        </button>
      </div>
    </section>
  );
}

/** A variable from above, or a fixed value. */
function ExprInput({ value, vars, onChange, placeholder, filter }: { value: unknown; vars: Var[]; onChange: (e: Expr | undefined) => void; placeholder?: string; filter?: (v: Var) => boolean }) {
  const isVar = !!value && typeof value === "object" && "var" in (value as object);
  const fixed = !!value && typeof value === "object" && "value" in (value as object);
  const shown = filter ? vars.filter(filter) : vars;
  const sel = isVar ? `var:${(value as { var: string }).var}` : fixed ? "__fixed" : "";
  return (
    <div className="flex gap-2">
      <select
        value={sel}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) onChange(undefined);
          else if (v === "__fixed") onChange({ value: "" });
          else onChange({ var: v.slice(4) });
        }}
        className={`${fieldClass} ${fixed ? "w-48" : "w-full"}`}
      >
        <option value="">{placeholder ?? "Select a variable or enter a value"}</option>
        {shown.map((v) => (
          <option key={v.path} value={`var:${v.path}`}>
            (x) {v.label} · {typeLabel(v.type)}
          </option>
        ))}
        <option value="__fixed">Fixed value…</option>
      </select>
      {fixed && <input value={String((value as { value: unknown }).value ?? "")} onChange={(e) => onChange({ value: e.target.value })} className={`${fieldClass} flex-1`} />}
    </div>
  );
}

/** A prompt or template with {{variable}} chips to insert. */
function TemplateInput({ value, vars, onChange, rows = 5, placeholder }: { value: string; vars: Var[]; onChange: (s: string) => void; rows?: number; placeholder?: string }) {
  return (
    <div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} className={`${inputClass} font-mono text-xs`} />
      {vars.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {vars.map((v) => (
            <button key={v.path} type="button" onClick={() => onChange(`${value}{{${v.path}}}`)} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-soft ring-1 ring-line-2 hover:text-white">
              {`{{${v.path}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BlockCard({
  block,
  index,
  count,
  isOutput,
  vars,
  types,
  actions,
  models,
  onChange,
  onMove,
  onDelete,
  onOutput,
}: {
  block: Block;
  index: number;
  count: number;
  isOutput: boolean;
  vars: Var[];
  types: ObjectType[];
  actions: ActionType[];
  models: LlmModel[];
  onChange: (b: Block) => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
  onOutput: () => void;
}) {
  const info = blockInfo(block.type);
  const cfg = block.config;
  const set = (c: Record<string, unknown>) => onChange({ ...block, config: { ...cfg, ...c } });
  const outType = block.type === "use_llm" ? typeLabel(String(cfg.output ?? "string")) : info.output;
  const action = actions.find((a) => a.id === cfg.action_type_id);
  const actionType = types.find((t) => t.id === action?.object_type_id);
  const params = (cfg.parameters as Record<string, Expr> | undefined) ?? {};

  return (
    <section className={`rounded-xl border bg-panel ${isOutput ? "border-ocean/60" : "border-line"}`}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm">
        <Icon name={info.icon} className="h-4 w-4 text-ocean" />
        <span className="font-semibold">{info.label}</span>
        <span className="text-muted">:</span>
        <input
          value={block.name}
          onChange={(e) => onChange({ ...block, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })}
          className="w-40 rounded bg-transparent px-1 font-mono text-xs text-soft outline-none ring-line-2 hover:ring-1 focus:ring-1 focus:ring-ocean"
          title="Variable name"
        />
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-line-2">{outType}</span>
        <div className="ml-auto flex items-center">
          {isOutput ? (
            <span className="mr-1 rounded bg-ocean/15 px-1.5 py-0.5 text-[11px] text-ocean">Output</span>
          ) : (
            <button type="button" onClick={onOutput} className="mr-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-white" title="Return this block's value">
              Set as output
            </button>
          )}
          <button type="button" disabled={index === 0} onClick={() => onMove(-1)} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white disabled:opacity-30" aria-label="Move up">
            <Icon name="down" className="h-3.5 w-3.5 rotate-180" />
          </button>
          <button type="button" disabled={index === count - 1} onClick={() => onMove(1)} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white disabled:opacity-30" aria-label="Move down">
            <Icon name="down" className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onDelete} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-bad" aria-label="Delete block">
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="space-y-3 p-4">
        {block.type === "semantic_search" && <SemanticBlock cfg={cfg} vars={vars} types={types} set={set} />}
        {block.type === "extract_pdf_text" && (
          <>
            <Field label="Starting media *">
              <ExprInput value={cfg.media} vars={vars} onChange={(media) => set({ media })} filter={(v) => v.type === "media" || v.type === "string"} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start page">
                <ExprInput value={cfg.start_page} vars={vars} onChange={(start_page) => set({ start_page })} placeholder="First page" />
              </Field>
              <Field label="End page">
                <ExprInput value={cfg.end_page} vars={vars} onChange={(end_page) => set({ end_page })} placeholder="Last page" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Extraction" hint="OCR reads up to 50 pages with a vision model">
                <select value={String(cfg.method ?? "raw")} onChange={(e) => set({ method: e.target.value })} className={inputClass}>
                  <option value="raw">Text layer</option>
                  <option value="ocr">OCR (scanned PDFs)</option>
                </select>
              </Field>
              <Field label="Error handling" hint="What happens when a PDF fails to process">
                <select value={String(cfg.on_error ?? "fail")} onChange={(e) => set({ on_error: e.target.value })} className={inputClass}>
                  <option value="fail">FAIL</option>
                  <option value="null">Return null</option>
                </select>
              </Field>
            </div>
          </>
        )}
        {block.type === "join_array" && (
          <>
            <Field label="Array to join *">
              <ExprInput value={cfg.array} vars={vars} onChange={(array) => set({ array })} />
            </Field>
            <Field label="Separator *" hint="\n is a new line, \t a tab">
              <input value={String(cfg.separator ?? "").replace(/\n/g, "\\n").replace(/\t/g, "\\t")} onChange={(e) => set({ separator: e.target.value })} className={`${inputClass} font-mono`} />
            </Field>
          </>
        )}
        {block.type === "text_template" && (
          <Field label="Template">
            <TemplateInput value={String(cfg.template ?? "")} vars={vars} onChange={(template) => set({ template })} placeholder="Summary of {{inputPdf.title}}: …" />
          </Field>
        )}
        {block.type === "use_llm" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model">
                <select value={String(cfg.model ?? "")} onChange={(e) => set({ model: e.target.value })} className={inputClass}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.available}>
                      {m.label} · {m.vendor}
                      {m.available ? "" : " (no API key)"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Output type">
                <select value={String(cfg.output ?? "string")} onChange={(e) => set({ output: e.target.value })} className={inputClass}>
                  {(["string", "string_array", "integer", "double", "boolean"] as const).map((t) => (
                    <option key={t} value={t}>
                      {typeLabel(t)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="System prompt (optional)">
              <TemplateInput value={String(cfg.system ?? "")} vars={[]} onChange={(system) => set({ system })} rows={2} placeholder="You are a careful analyst…" />
            </Field>
            <Field label="Prompt *">
              <TemplateInput value={String(cfg.prompt ?? "")} vars={vars} onChange={(prompt) => set({ prompt })} placeholder="Summarise this document in 3 bullet points: {{joinArray}}" />
            </Field>
          </>
        )}
        {block.type === "apply_action" && (
          <>
            <Field label="Action">
              <select value={String(cfg.action_type_id ?? "")} onChange={(e) => set({ action_type_id: e.target.value, parameters: {} })} className={inputClass}>
                <option value="">Select an action…</option>
                {types.map((t) => (
                  <optgroup key={t.id} label={t.display_name}>
                    {actions
                      .filter((a) => a.object_type_id === t.id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.display_name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            {action?.parameters.map((p) => (
              <Field key={p.id} label={`${p.display_name}${p.required ? " *" : ""}`} hint={p.type === "object" ? `The ${actionType?.display_name ?? ""} to change` : typeLabel(p.type)}>
                <ExprInput
                  value={params[p.id]}
                  vars={vars}
                  filter={p.type === "object" ? (v) => v.type === "object" : undefined}
                  onChange={(e) => {
                    const next = { ...params };
                    if (e) next[p.id] = e;
                    else delete next[p.id];
                    set({ parameters: next });
                  }}
                />
              </Field>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function RunPanel({ fn, dirty, types, onSave }: { fn: LogicFunction; dirty: boolean; types: ObjectType[]; onSave: () => Promise<LogicFunction | null> }) {
  const [tab, setTab] = useState<"preview" | "runs">("preview");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [run, setRun] = useState<LogicRun | null>(null);
  const [running, setRunning] = useState<false | "preview" | "apply">(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<LogicRun[] | null>(null);
  // run in an Ontology scenario (what-if): reads see it, applied edits go to it instead of main
  const [scList, setScList] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  // or on a global Nexus branch: its objects, edits kept on the branch, its function versions (Branched pre-releases)
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState("");
  useEffect(() => {
    scenarioApi.list().then((l) => setScList(l.filter((s) => !s.merged)), () => setScList([]));
    om.branches({ status: "open" }).then(setBranches, () => setBranches([]));
  }, []);

  const loadRuns = useCallback(() => {
    ontology.logicRuns(fn.id).then(setRuns).catch(() => setRuns([]));
  }, [fn.id]);
  useEffect(() => {
    if (tab === "runs") loadRuns();
  }, [tab, loadRuns]);

  const go = async (apply: boolean) => {
    setRunning(apply ? "apply" : "preview");
    setError(null);
    try {
      if (dirty && !(await onSave())) throw new Error("Fix the errors before running");
      setRun(branchId ? await branchRuns.runLogic(branchId, fn.id, values, apply) : await ontology.runLogic(fn.id, values, apply, scenarioId || null));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const hasEdits = fn.blocks.some((b) => b.type === "apply_action");
  const typeOf = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-11 shrink-0 items-end gap-1 border-b border-line px-3">
        {(
          [
            ["preview", "Preview", "play"],
            ["runs", "Runs", "history"],
          ] as const
        ).map(([k, label, icon]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}
          >
            <Icon name={icon} className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "preview" ? (
          <div className="space-y-3 p-4">
            {fn.inputs.map((i) => (
              <Field key={i.name} label={`${i.name}${i.required === false ? "" : " *"}`} hint={i.type === "object" ? typeOf[i.object_type_id ?? ""]?.display_name : typeLabel(i.type)}>
                <ParamInput param={{ type: i.type }} objectTypeId={i.object_type_id} value={values[i.name]} onChange={(v) => setValues({ ...values, [i.name]: v })} />
              </Field>
            ))}
            {branches.length > 0 && (
              <Field label="Branch" hint="run on a global branch: its objects and function versions; applied edits stay on the branch">
                <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClass} aria-label="Branch">
                  <option value="">Main</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {scList.length > 0 && !branchId && (
              <Field label="Scenario" hint="reads see it; applied edits go to it, not to main">
                <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className={inputClass} aria-label="Scenario">
                  <option value="">Main (no scenario)</option>
                  {scList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => go(false)} disabled={!!running || !fn.blocks.length} className={buttonClass.primary}>
                <Icon name="play" className="h-3.5 w-3.5" /> {running === "preview" ? "Running…" : "Run"}
              </button>
              {hasEdits && (
                <button type="button" onClick={() => go(true)} disabled={!!running} className={buttonClass.secondary} title="Run and write the ontology edits">
                  <Icon name="check" className="h-3.5 w-3.5" /> {running === "apply" ? "Applying…" : "Run and apply edits"}
                </button>
              )}
            </div>
            {hasEdits && <p className="text-[11px] text-muted">Run previews the edits without writing them.</p>}
            <ErrorBox message={error} />
            {run && <RunView run={run} types={typeOf} />}
          </div>
        ) : (
          <div className="p-3">
            {runs === null ? (
              <Loading />
            ) : runs.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted">No runs yet.</p>
            ) : (
              <div className="space-y-2">
                {runs.map((r) => (
                  <details key={r.id} className="rounded-lg border border-line bg-panel-2">
                    <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                      <Badge status={r.status} />
                      <span className="text-xs text-soft">{when(r.at)}</span>
                      <span className="ml-auto truncate text-xs text-muted">{r.trigger ? ((r.trigger as { kind?: string }).kind === "logic_flow" ? r.trigger.automation : `Automate · ${r.trigger.automation}`) : r.apply ? "Applied" : "Preview"}
                        {r.scenario ? ((r.scenario as BranchRunScenario).branch_id ? ` · on branch ${(r.scenario as BranchRunScenario).branch_name ?? r.scenario.name}` : ` · in ${r.scenario.name ?? r.scenario.id}`) : ""}</span>
                    </summary>
                    <div className="border-t border-line p-3">
                      <RunView run={r} types={typeOf} />
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function RunView({ run, types }: { run: LogicRun; types: Record<string, ObjectType> }) {
  const sc = run.scenario as BranchRunScenario | null | undefined;
  const where = sc?.branch_id ? `the branch ${sc.branch_name ?? sc.name ?? sc.branch_id}` : sc ? `the scenario ${sc.name ?? sc.id}` : "";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge status={run.status} />
        <span className="text-xs text-muted">{(run.ms / 1000).toFixed(1)} s</span>
        {run.apply && run.status === "succeeded" && <span className="text-xs text-ok">{run.applied?.length ?? 0} edits applied{where ? ` to ${where}` : ""}</span>}
        {!run.apply && where && <span className="text-xs text-muted">in {where}</span>}
      </div>
      {sc?.branch_id && <RanFunctions sc={sc} />}
      {run.error && <ErrorBox message={run.error} />}
      {run.steps.map((s) => (
        <details key={s.block_id} open={!!s.error} className="rounded-lg border border-line">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs">
            <Icon name={blockInfo(s.type).icon} className="h-3.5 w-3.5 text-ocean" />
            <span className="font-mono">{s.name}</span>
            {s.error ? <span className="text-bad">failed</span> : <span className="text-ok">ok</span>}
            <span className="ml-auto text-muted">{s.ms} ms</span>
          </summary>
          <div className="border-t border-line p-2">
            {s.error ? <div className="text-xs text-bad">{s.error}</div> : <OutputView value={s.output} />}
            {s.truncated ? <div className="mt-1 text-[11px] text-muted">First 5 of {s.truncated} items</div> : null}
          </div>
        </details>
      ))}
      {run.status === "succeeded" && (
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Output</div>
          <OutputView value={run.output} />
        </div>
      )}
      {run.edits.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Nexus edits {run.apply ? "" : "(not applied)"}</div>
          {run.edits.map((e, i) => (
            <div key={i} className="mb-1 rounded-md bg-ink p-2 text-xs">
              <span className="font-medium capitalize text-sand">{e.op}</span> {types[e.object_type_id]?.display_name ?? e.object_type_id}{" "}
              <span className="font-mono text-muted">{e.primary_key}</span>
              {e.properties && (
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(e.properties).map(([k, v]) => (
                    <li key={k} className="truncate text-soft">
                      <span className="font-mono text-muted">{k}</span> = {typeof v === "string" ? v.slice(0, 160) : JSON.stringify(v)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** On a branch: the function versions the run used (the branch's Branched pre-releases, or main versions it sees). */
function RanFunctions({ sc }: { sc: BranchRunScenario }) {
  const ran = sc.functions ?? [];
  return (
    <div className="rounded-lg border border-line p-2 text-xs" data-testid="ran-functions">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-soft">
        <Icon name="split" className="h-3.5 w-3.5 text-sand" /> Function versions on {sc.branch_name ?? "the branch"}
      </div>
      {ran.length === 0 ? (
        <p className="text-muted">No functions ran.</p>
      ) : (
        <ul className="space-y-1">
          {ran.map((f) => (
            <li key={`${f.function_id}@${f.version}`} className="flex items-center gap-2">
              <Link href={`/functions/${f.function_id}`} className="font-mono text-ocean hover:underline">
                {f.function}
              </Link>
              <span className="font-mono text-soft">{f.version}</span>
              {f.branched ? <Badge status="paused" label="Branched pre-release" /> : <Badge status="example" label="Main version" />}
              <span className="ml-auto text-muted">
                {f.calls} call{f.calls === 1 ? "" : "s"}
                {f.status === "failed" ? " · failed" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The semantic search block: object type with an embedding, the query, k, the search mode and what it returns. */
function SemanticBlock({ cfg, vars, types, set }: { cfg: Record<string, unknown>; vars: Var[]; types: ObjectType[]; set: (c: Record<string, unknown>) => void }) {
  const withVectors = types.filter((t) => t.properties.some((p) => p.type === "vector"));
  const t = types.find((x) => x.id === cfg.object_type_id);
  return (
    <>
      <Field label="Object type *" hint={withVectors.length ? "Object types with an embedding (vector) property" : "No object type has an embedding yet: see the Semantic Search app"}>
        <select value={String(cfg.object_type_id ?? "")} onChange={(e) => set({ object_type_id: e.target.value || undefined, vector_property: undefined, text_property: undefined })} className={inputClass}>
          <option value="">Choose…</option>
          {withVectors.map((x) => (
            <option key={x.id} value={x.id}>
              {x.display_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Query *">
        <ExprInput value={cfg.query} vars={vars} onChange={(query) => set({ query })} filter={(v) => v.type === "string" || v.type === "String"} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Results (k)">
          <input type="number" min={1} max={50} value={Number(cfg.k ?? 5)} onChange={(e) => set({ k: Number(e.target.value) || 5 })} className={inputClass} />
        </Field>
        <Field label="Search">
          <select value={String(cfg.mode ?? "semantic")} onChange={(e) => set({ mode: e.target.value })} className={inputClass}>
            <option value="semantic">Semantic (KNN)</option>
            <option value="keyword">Ranked keywords</option>
            <option value="hybrid">Hybrid (RRF)</option>
          </select>
        </Field>
        <Field label="Embedding">
          <select value={String(cfg.vector_property ?? "")} onChange={(e) => set({ vector_property: e.target.value || undefined })} className={inputClass}>
            <option value="">First vector property</option>
            {t?.properties
              .filter((p) => p.type === "vector")
              .map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  {p.display_name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <Field label="Return" hint="Objects, or one text of the chosen property per result (context for a Use LLM block)">
        <select value={String(cfg.text_property ?? "")} onChange={(e) => set({ text_property: e.target.value || undefined })} className={inputClass}>
          <option value="">The objects</option>
          {t?.properties
            .filter((p) => p.type === "string")
            .map((p) => (
              <option key={p.api_name} value={p.api_name}>
                Text of {p.display_name}
              </option>
            ))}
        </select>
      </Field>
    </>
  );
}
