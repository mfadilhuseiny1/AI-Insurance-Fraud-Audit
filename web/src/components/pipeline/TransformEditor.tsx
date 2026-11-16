"use client";

import { CipherLicenseSelect } from "@/components/security/CipherLicenseSelect";
import { useEffect, useMemo, useState } from "react";
import { functions as functionsRegistry } from "@/lib/actions";
import {
  addRegisteredEmbeddingModels,
  applySteps,
  customStepDef,
  stepDefOf,
  type CustomFunction,
  type Parameter,
  FILE_FILTER_COLUMNS,
  readAggs,
  readSortKeys,
  type SortKey,
  type StepContext,
  isLiteral,
  LITERAL,
  literalText,
  newGroup,
  outputName,
  STEPS,
  uid,
  type Column,
  type FieldDef,
  type Operand,
  type Params,
  type Step,
  type StepDef,
  type Table,
  type TransformNode,
} from "@/lib/pipeline";
import { Icon } from "../Icon";
import { DataPreview } from "./DataPreview";
import { FormatsField, TimezoneField } from "./CastFields";
import { FormulaField } from "./FormulaField";
import { ColumnMultiSelect } from "./ColumnMultiSelect";
import { AddButton, CasesField, FilterForm, OperandPicker } from "./FilterForm";
import { AggregationsField, SortKeysField, SqlQueryField } from "./SqlFields";
import { useSqlEngine } from "@/lib/useSqlEngine";
import { ExtractJsonForm, FlattenForm } from "./FlattenForm";
import { buttonClass, inputClass } from "./Modal";
import { AiExplainDialog, CreateFunctionDialog, RegexHelper } from "./AiDialogs";
import { explainSteps } from "@/lib/describe";
import { confirmDialog } from "@/lib/dialogs";

type Stage = { table: Table; error?: string };

export function TransformEditor({
  node,
  input,
  inputName,
  inputError,
  context,
  functions,
  parameters,
  autoName,
  applyLabel,
  onApply,
  onCreateFunction,
  onClose,
}: {
  node: TransformNode;
  input: Table | null;
  inputName: string;
  inputError?: string;
  /** other pipeline nodes, for SQL steps */
  context?: StepContext;
  /** the pipeline's custom expressions and transforms */
  functions?: CustomFunction[];
  parameters?: Parameter[];
  /** name the node after its boards while it keeps an automatic name */
  autoName?: boolean;
  applyLabel?: string;
  onApply: (name: string, steps: Step[]) => void;
  /** boards turned into a custom transform (the + in the top bar) */
  onCreateFunction?: (fn: CustomFunction) => void;
  onClose: () => void;
}) {
  const [typedName, setName] = useState(node.name);
  const [steps, setSteps] = useState<Step[]>(node.steps);
  // a new SQL transform (one SQL board) opens on its query
  const [open, setOpen] = useState<string | null>(node.steps.length ? (node.steps.length === 1 && node.steps[0].kind === "sql" ? node.steps[0].id : null) : "picker");
  const [preview, setPreview] = useState<number | null>(null);
  // boards selected with Shift+Up / Shift+Down (or their checkboxes), for "+ Custom function"
  const [marked, setMarked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [explain, setExplain] = useState(false);
  // a board whose value the next picked transform reuses
  const [reuseFrom, setReuseFrom] = useState<string | null>(null);
  const [localFns, setLocalFns] = useState<CustomFunction[]>(functions ?? []);
  const defOf = (kind: string) => stepDefOf(kind, localFns);
  const named = (list: Step[]) => {
    const labels = list.slice(0, 2).map((x) => defOf(x.kind)?.label ?? x.kind);
    return list.length ? labels.join(", ") + (list.length > 2 ? "…" : "") : "Transform";
  };
  // automatic naming: the name follows the boards until it is edited by hand
  const [auto, setAuto] = useState(() => !!autoName && (node.name === "Transform" || node.name === named(node.steps)));
  const name = auto ? named(steps) : typedName;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      e.preventDefault();
      setMarked((m) => {
        const idx = m.length ? steps.findIndex((x) => x.id === m[m.length - 1]) : e.key === "ArrowDown" ? -1 : steps.length;
        const next = Math.max(0, Math.min(steps.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
        const id = steps[next]?.id;
        if (!id) return m;
        return m.includes(id) ? m.slice(0, -1) : [...m, id];
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps]);

  const dirty = name !== node.name || JSON.stringify(steps) !== JSON.stringify(node.steps);
  // SQL steps added here may need the engine before the pipeline does
  const sql = useSqlEngine(steps.some((s) => s.kind === "sql"));
  const ctx = useMemo<StepContext>(
    () => ({ names: context?.names ?? (() => []), table: context?.table ?? (() => undefined), sql, functions: localFns }),
    [context, sql, localFns],
  );
  const tables = useMemo(() => ["input", ...ctx.names()], [ctx]);

  // columns available to each step = output of the steps before it
  const stages = useMemo(() => {
    const out: Stage[] = [];
    if (!input) return out;
    let table = input;
    let failed = false;
    for (const step of steps) {
      out.push({ table });
      if (failed) continue;
      const r = applySteps(table, [step], ctx);
      if (r.error !== undefined) {
        out[out.length - 1].error = r.error;
        failed = true;
      } else table = r.table;
    }
    out.push({ table });
    return out;
  }, [input, steps, ctx]);

  const previewAt = preview === null || preview >= steps.length ? steps.length : preview + 1;
  const previewResult = useMemo(
    () => (input ? applySteps(input, steps.slice(0, previewAt), ctx) : null),
    [input, steps, previewAt, ctx],
  );

  const update = (id: string, params: Params) => setSteps(steps.map((s) => (s.id === id ? { ...s, params } : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setSteps(next);
  };

  const add = (def: StepDef) => {
    const params: Params = {};
    for (const f of def.fields) if (f.kind === "select" && f.options) params[f.key] = f.options[0];
    Object.assign(params, def.defaults);
    // a Python / model function's inputs start mapped to the columns of the same name (a model can take dozens)
    const cols = new Set((stages[stages.length - 1]?.table.columns ?? []).map((c) => c.name));
    for (const f of def.fields) if (f.kind === "column" && f.key.startsWith("pyarg_") && cols.has(f.key.slice(6))) params[f.key] = f.key.slice(6);
    if (def.kind === "filter" || def.kind === "filter_files") params.filter = JSON.stringify(newGroup());
    const step = { id: uid(), kind: def.kind, params };
    // Reuse value: the new board reads the reused board's output column and replaces it
    const from = reuseFrom ? steps.find((x) => x.id === reuseFrom) : undefined;
    if (from) {
      const fromDef = defOf(from.kind);
      const fallback = typeof fromDef?.outputDefault === "function" ? fromDef.outputDefault(from.params) : fromDef?.outputDefault;
      const col = outputName(from.params, fallback || (typeof from.params.column === "string" ? from.params.column : ""));
      const first = def.fields.find((f) => f.kind === "column" || f.kind === "columns" || f.kind === "expressions");
      if (first && col) {
        params[first.key] = first.kind === "column" ? col : [col];
        if (def.output) params.output = col;
      }
      const at = steps.findIndex((x) => x.id === from.id);
      setSteps([...steps.slice(0, at + 1), step, ...steps.slice(at + 1)]);
      setReuseFrom(null);
    } else setSteps([...steps, step]);
    setOpen(step.id);
    setPreview(null);
  };

  const close = async () => {
    if (dirty && !(await confirmDialog("Discard the changes you have not applied?"))) return;
    onClose();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Icon name="transform" className="h-4 w-4 text-ocean" />
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setAuto(false);
          }}
          aria-label="Transform node name"
          className="w-56 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none hover:border-line-2 focus:border-ocean"
        />
        <span className="text-xs text-muted">{steps.length} transforms</span>
        {marked.length > 0 && <span className="rounded bg-sand/15 px-1.5 py-0.5 text-xs text-sand">{marked.length} boards selected</span>}
        <div className="ml-auto flex gap-2">
          {onCreateFunction && (
            <button
              type="button"
              disabled={!marked.length || !input}
              onClick={() => setCreating(true)}
              title={marked.length ? "Turn the selected boards into a custom function" : "Select boards with Shift+↓ (or their checkboxes) to make a custom function"}
              className={buttonClass.secondary}
            >
              <Icon name="plus" /> Custom function
            </button>
          )}
          <button type="button" title="Explain these boards" onClick={() => setExplain(true)} disabled={!steps.length} className={buttonClass.secondary}>
            <Icon name="bolt" className="h-4 w-4 text-violet-300" />
          </button>
          <button
            type="button"
            disabled={!dirty || !name.trim()}
            onClick={() => onApply(name.trim(), steps)}
            className={buttonClass.primary}
          >
            <Icon name="check" /> {dirty ? (applyLabel ?? "Apply") : "Applied"}
          </button>
          <button type="button" onClick={close} className={buttonClass.secondary}>
            <Icon name="x" /> Close
          </button>
        </div>
      </div>

      <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-2 p-5">
          <div className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-sm">
            <Icon name="table" className="h-4 w-4 text-ocean" />
            <span className="font-medium">{inputName}</span>
            <span className="text-xs text-muted">{!input ? "unavailable" : input.files ? "Files" : `${input.columns.length} columns`}</span>
          </div>
          {inputError && (
            <p className="flex items-center gap-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              <Icon name="alert" /> {inputError}
            </p>
          )}

          {steps.map((step, i) => {
            const def = defOf(step.kind);
            const stage = stages[i];
            const isOpen = open === step.id;
            return (
              <div
                key={step.id}
                className={`rounded-md border bg-panel ${stage?.error ? "border-bad/60" : isOpen ? "border-ocean" : "border-line"}`}
              >
                <div className={`flex items-center gap-2 px-3 py-2 text-sm ${marked.includes(step.id) ? "bg-sand/10" : ""}`}>
                  <input
                    type="checkbox"
                    title="Select this board (Shift+↓ / Shift+↑)"
                    checked={marked.includes(step.id)}
                    onChange={(e) => setMarked(e.target.checked ? [...marked, step.id] : marked.filter((m) => m !== step.id))}
                    className="accent-[var(--color-sand)]"
                  />
                  <span className="w-5 text-xs tabular-nums text-muted">{i + 1}</span>
                  <button type="button" onClick={() => setOpen(isOpen ? null : step.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="font-medium">{def?.label ?? step.kind}</span>
                    {!isOpen && def && (
                      <span className="truncate rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-soft ring-1 ring-line-2">
                        {def.summary(step.params) || "…"}
                      </span>
                    )}
                  </button>
                  <StepButton title={preview === i ? "Previewing" : "Preview up to here"} icon="play" active={preview === i} onClick={() => setPreview(preview === i ? null : i)} />
                  {(def?.output || def?.fields.some((f) => f.key === "column")) && (
                    <StepButton
                      title="Reuse value: keep this board's values and make them the first input of a new transform"
                      icon="copy"
                      active={reuseFrom === step.id}
                      sand
                      onClick={() => {
                        setReuseFrom(reuseFrom === step.id ? null : step.id);
                        setOpen("picker");
                      }}
                    />
                  )}
                  <StepButton title="Move up" icon="left" disabled={i === 0} onClick={() => move(i, -1)} rotate />
                  <StepButton title="Move down" icon="right" disabled={i === steps.length - 1} onClick={() => move(i, 1)} rotate />
                  <StepButton
                    title="Duplicate"
                    icon="copy"
                    onClick={() => setSteps([...steps.slice(0, i + 1), { ...step, id: uid() }, ...steps.slice(i + 1)])}
                  />
                  <StepButton
                    title="Delete"
                    icon="trash"
                    danger
                    onClick={() => {
                      setSteps(steps.filter((s) => s.id !== step.id));
                      setPreview(null);
                    }}
                  />
                </div>
                {isOpen && def && stage && (
                  <StepForm def={def} params={step.params} table={stage.table} tables={tables} parameters={parameters} onChange={(p) => update(step.id, p)} />
                )}
                {stage?.error && (
                  <p className="flex items-center gap-2 border-t border-bad/30 px-3 py-1.5 text-xs text-bad">
                    <Icon name="alert" className="h-3.5 w-3.5" /> {stage.error}
                  </p>
                )}
              </div>
            );
          })}

          {reuseFrom && open === "picker" && (
            <p className="rounded-md bg-sand/10 px-3 py-1.5 text-xs text-sand">
              Reusing the value of board {steps.findIndex((x) => x.id === reuseFrom) + 1}: pick the transform to apply to it.
            </p>
          )}
          {open === "picker" ? (
            <StepPicker
              onPick={add}
              onClose={() => {
                setOpen(null);
                setReuseFrom(null);
              }}
              functions={localFns}
            />
          ) : (
            <button
              type="button"
              onClick={() => setOpen("picker")}
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-line-2 px-3 py-2 text-sm text-muted hover:border-ocean hover:text-white"
            >
              <Icon name="search" className="h-4 w-4" /> Search transforms…
            </button>
          )}
        </div>
      </div>

      {creating && input && (
        <CreateFunctionDialog
          steps={steps.filter((x) => marked.includes(x.id))}
          columns={stages[steps.findIndex((x) => marked.includes(x.id))]?.table.columns ?? input.columns}
          onClose={() => setCreating(false)}
          onCreate={(fn, binding) => {
            onCreateFunction?.(fn);
            setLocalFns([...localFns, fn]);
            // the boards become one board of the new function, bound to the original columns
            const first = steps.findIndex((x) => marked.includes(x.id));
            const params: Params = Object.fromEntries(Object.entries(binding).map(([argId, col]) => [`arg_${argId}`, col]));
            const board: Step = { id: uid(), kind: `fn:${fn.id}`, params };
            const rest = steps.filter((x) => !marked.includes(x.id));
            rest.splice(first, 0, board);
            setSteps(rest);
            setMarked([]);
            setCreating(false);
          }}
        />
      )}
      {explain && <AiExplainDialog title={name} fallback={explainSteps(name, steps, localFns)} onClose={() => setExplain(false)} />}

      <div className="flex h-72 shrink-0 flex-col border-t border-line bg-ink">
        {previewResult ? (
          <DataPreview
            table={previewResult.table}
            title={previewAt === steps.length ? `${name} (output)` : `After step ${previewAt}`}
          />
        ) : (
          <p className="p-6 text-center text-sm text-muted">The input is unavailable.</p>
        )}
      </div>
    </div>
  );
}

function StepButton({
  title,
  icon,
  onClick,
  disabled,
  danger,
  active,
  rotate,
  sand,
}: {
  title: string;
  icon: "play" | "left" | "right" | "copy" | "trash";
  sand?: boolean;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  rotate?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1 disabled:opacity-25 ${active ? "text-ocean" : "text-muted"} ${
        danger ? "hover:bg-bad/10 hover:text-bad" : "hover:bg-panel-2 hover:text-white"
      }`}
    >
      <Icon name={icon} className={`h-3.5 w-3.5 ${rotate ? "rotate-90" : ""} ${sand ? "text-sand" : ""}`} />
    </button>
  );
}

function StepForm({
  def,
  params,
  table,
  tables,
  parameters,
  onChange,
}: {
  def: StepDef;
  params: Params;
  /** the step's input */
  table: Table;
  /** SQL table names available to the step */
  tables: string[];
  parameters?: Parameter[];
  onChange: (p: Params) => void;
}) {
  const columns = table.columns;
  const set = (key: string, value: string | string[]) => onChange({ ...params, [key]: value });
  // Text to embeddings: registered embedding models (functions implementing Embedding) join the model choices
  const [, setModelsLoaded] = useState(0);
  useEffect(() => {
    if (def.kind !== "embed") return;
    functionsRegistry.registeredModels().then(
      (r) => addRegisteredEmbeddingModels(r.embedding) && setModelsLoaded((n) => n + 1),
      () => {},
    );
  }, [def.kind]);
  const fallback = typeof def.outputDefault === "function" ? def.outputDefault(params) : def.outputDefault;
  const output = fallback ? outputName(params, fallback) : outputName(params);
  if (def.kind === "filter") return <FilterForm params={params} columns={columns} onChange={onChange} />;
  if (def.kind === "filter_files") return <FilterForm params={params} columns={FILE_FILTER_COLUMNS} onChange={onChange} />;
  if (def.kind === "flatten") return <FlattenForm params={params} table={table} onChange={onChange} />;
  if (def.kind === "extract_json") return <ExtractJsonForm params={params} table={table} onChange={onChange} />;

  const replaces = columns.some((c) => c.name === output);

  return (
    <div className="space-y-2.5 border-t border-line px-3 py-3">
      <p className="text-xs text-muted">{def.description}</p>
      {def.fields
        .filter((f) => !f.showIf || f.showIf(params))
        .map((f) => (
          <div key={f.key} className="grid grid-cols-[9rem_1fr] items-start gap-3">
            <span className="pt-1.5 text-xs text-soft">
              {f.label}
              {!f.optional && <span className="text-bad"> *</span>}
            </span>
            <div className="min-w-0">
              <Field
                field={f}
                value={params[f.key]}
                columns={columns}
                onChange={(v) => set(f.key, v)}
                context={{ params, table, tables, update: (patch) => onChange({ ...params, ...patch }), parameters, regex: isRegexField(def, f.key, params) }}
              />
              {f.help && <p className="mt-1 text-xs text-muted">{f.help}</p>}
            </div>
          </div>
        ))}
      {def.output && (
        <div className="grid grid-cols-[9rem_1fr] items-center gap-3">
          <span className="text-xs text-soft">Output column</span>
          <div className="flex items-center gap-2">
            <Icon name="right" className="h-4 w-4 text-muted" />
            <input
              value={typeof params.output === "string" ? params.output : ""}
              onChange={(e) => set("output", e.target.value)}
              placeholder={fallback ?? (typeof params.column === "string" && params.column ? params.column : "same as input")}
              className={inputClass}
            />
            {output && (
              <span
                title={replaces ? "The existing column will be replaced." : "A new column will be added."}
                className={`rounded px-1.5 py-0.5 text-[11px] ${replaces ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok"}`}
              >
                {replaces ? "Replace" : "New"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type FieldContext = { params: Params; table: Table; tables: string[]; update: (patch: Params) => void; parameters?: Parameter[]; regex?: boolean };

/** Fields that hold a regular expression get the AIP regex helper. */
const isRegexField = (def: StepDef, key: string, p: Params) =>
  (def.kind === "regex_extract" && key === "pattern") || (def.kind === "replace" && key === "find" && p.mode === "Regex") || (key === "pattern" && /regex/i.test(def.label));

/** Up to 50 distinct non-empty text values of a column, for format detection. */
function sampleValues(table: Table, column: string): string[] {
  const out = new Set<string>();
  for (const r of table.rows) {
    const v = r[column];
    if (typeof v === "string" && v.trim()) out.add(v);
    if (out.size >= 50) break;
  }
  return [...out];
}

function Field({
  field,
  value,
  columns,
  onChange,
  context,
}: {
  field: FieldDef;
  value: string | string[] | undefined;
  columns: Column[];
  onChange: (v: string | string[]) => void;
  context: FieldContext;
}) {
  const text = typeof value === "string" ? value : "";
  const list = Array.isArray(value) ? value : [];

  if (field.kind === "timezone") return <TimezoneField value={text} onChange={onChange} />;

  if (field.kind === "cases") return <CasesField value={text} columns={columns} onChange={onChange} />;

  if (field.kind === "sql") return <SqlQueryField value={text} columns={columns} tables={context.tables} onChange={onChange} />;

  if (field.kind === "aggregations")
    return <AggregationsField value={readAggs(context.params)} columns={columns} onChange={(v) => onChange(JSON.stringify(v))} />;

  if (field.kind === "sortkeys") {
    // parse directly so rows without a column yet stay visible while editing
    let keys: SortKey[] = readSortKeys(context.params, field.key);
    try {
      const raw = JSON.parse(text);
      if (Array.isArray(raw)) keys = raw;
    } catch {}
    return <SortKeysField value={keys} columns={columns} onChange={(v) => onChange(JSON.stringify(v))} />;
  }

  if (field.kind === "formula")
    return <FormulaField value={text} columns={columns} placeholder={field.placeholder} onChange={onChange} />;

  if (field.kind === "formats") {
    const { params, table, update } = context;
    const column = typeof params.column === "string" ? params.column : "";
    return (
      <FormatsField
        value={list}
        samples={column ? sampleValues(table, column) : []}
        type={params.type === "Date" ? "Date" : "Timestamp"}
        onChange={onChange}
        onSuggest={(formats, zone) => update(zone && !params.timezone ? { formats, timezone: zone } : { formats })}
      />
    );
  }

  if (field.kind === "text") {
    const column = typeof context.params.column === "string" ? context.params.column : "";
    const samples = column ? sampleValues(context.table, column).slice(0, 8) : [];
    return (
      <div className="flex items-center gap-1">
        <input value={text} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className={inputClass} />
        {context.regex && <RegexHelper samples={samples} onPattern={(v) => onChange(v)} />}
        {!!context.parameters?.length && (
          <select
            value=""
            title="Insert a parameter"
            onChange={(e) => e.target.value && onChange(`${text}{{${e.target.value}}}`)}
            className="w-10 shrink-0 rounded-md border border-line-2 bg-panel-2 px-1 py-1.5 text-xs text-muted"
          >
            <option value="">{"{ }"}</option>
            {context.parameters.map((prm) => (
              <option key={prm.id} value={prm.name}>
                {prm.name} = {prm.value}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  if (field.kind === "cipherLicense")
    return (
      <div className="space-y-1">
        <CipherLicenseSelect value={text} onChange={onChange} operation={field.cipherOperation ?? "encrypt"} kinds={["data_manager", "admin"]} className={inputClass} />
        <input value={text} onChange={(e) => onChange(e.target.value)} placeholder="or a license RID / path" className={`${inputClass} text-xs`} />
      </div>
    );

  if (field.kind === "select")
    return (
      <select value={text} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        {field.options?.map((o) => (
          <option key={o} value={o}>
            {field.optionLabel ? field.optionLabel(o) : o}
          </option>
        ))}
      </select>
    );

  if (field.kind === "boolean")
    return (
      <button
        type="button"
        role="switch"
        aria-checked={text === "true"}
        onClick={() => onChange(text === "true" ? "" : "true")}
        className="flex items-center gap-2 pt-1 text-xs text-soft"
      >
        <span className={`relative h-4 w-7 rounded-full transition-colors ${text === "true" ? "bg-ocean" : "bg-line-2"}`}>
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${text === "true" ? "left-3.5" : "left-0.5"}`}
          />
        </span>
        {text === "true" ? "Yes" : "No"}
      </button>
    );

  if (field.kind === "expressions") return <ExpressionsField value={list} columns={columns} onChange={onChange} />;

  if (field.kind === "column")
    return (
      <select value={text} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{field.optional ? "— none —" : "Choose a column…"}</option>
        {text && !columns.some((c) => c.name === text) && <option value={text}>{text} (missing)</option>}
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {c.type}
          </option>
        ))}
      </select>
    );

  return <ColumnMultiSelect value={list} columns={columns} onChange={onChange} placeholder={field.placeholder} />;
}

/** Ordered rows of "Column, expression, or value"; drag the handle to reorder. */
function ExpressionsField({
  value,
  columns,
  onChange,
}: {
  value: string[];
  columns: Column[];
  onChange: (v: string[]) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const toOperand = (e: string): Operand =>
    !e ? null : isLiteral(e) ? { kind: "value", type: "String", value: literalText(e) } : { kind: "column", column: e };
  const fromOperand = (o: Operand) => (!o ? "" : o.kind === "column" ? o.column : LITERAL + o.value);

  return (
    <div className="space-y-1.5">
      {value.map((e, i) => (
        <div
          key={i}
          onDragOver={(ev) => dragging !== null && ev.preventDefault()}
          onDrop={() => {
            if (dragging === null || dragging === i) return;
            const next = [...value];
            const [moved] = next.splice(dragging, 1);
            next.splice(i, 0, moved);
            onChange(next);
            setDragging(null);
          }}
          className={`flex items-center gap-1.5 ${dragging === i ? "opacity-40" : ""}`}
        >
          <OperandPicker
            value={toOperand(e)}
            columns={columns}
            defaultTab="columns"
            className="min-w-0 flex-1"
            onChange={(o) => onChange(value.map((x, j) => (j === i ? fromOperand(o) : x)))}
          />
          <span
            draggable
            onDragStart={() => setDragging(i)}
            onDragEnd={() => setDragging(null)}
            title="Drag to reorder"
            className="cursor-grab select-none px-0.5 font-mono text-xs leading-none text-muted hover:text-white"
          >
            ⋮⋮
          </span>
          <button
            type="button"
            title="Remove"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="rounded p-1 text-muted hover:bg-bad/10 hover:text-bad"
          >
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex justify-center border-t border-line pt-1.5">
        <AddButton label="Add item" onClick={() => onChange([...value, ""])} />
      </div>
    </div>
  );
}

function StepPicker({ onPick, onClose, functions = [] }: { onPick: (def: StepDef) => void; onClose: () => void; functions?: CustomFunction[] }) {
  const all = useMemo(() => [...functions.map(customStepDef), ...STEPS], [functions]);
  const categories = useMemo(() => [...new Set(all.map((x) => x.category))], [all]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [hover, setHover] = useState<StepDef | null>(null);

  const q = query.toLowerCase();
  // name matches first (prefix before substring), then description-only matches
  const rank = (s: StepDef) => {
    const label = s.label.toLowerCase();
    return !q ? 0 : label.startsWith(q) ? 0 : label.includes(q) ? 1 : s.description.toLowerCase().includes(q) ? 2 : -1;
  };
  const matches = all.filter((s) => (!category || s.category === category) && rank(s) >= 0).sort(
    (a, b) => rank(a) - rank(b),
  );
  const shown = hover && matches.includes(hover) ? hover : matches[0];

  return (
    <div className="overflow-hidden rounded-md border border-ocean bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="search" className="h-4 w-4 text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown) onPick(shown);
            if (e.key === "Escape") onClose();
          }}
          placeholder="Search transforms…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        />
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:text-white">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid h-64 grid-cols-[9rem_1fr_15rem] text-sm">
        <ul className="overflow-y-auto border-r border-line py-1">
          {[null, ...categories].map((c) => (
            <li key={c ?? "all"}>
              <button
                type="button"
                onClick={() => setCategory(c)}
                className={`w-full px-3 py-1 text-left text-xs ${category === c ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
              >
                {c ?? "All"}
              </button>
            </li>
          ))}
        </ul>
        <ul className="overflow-y-auto border-r border-line py-1">
          {matches.length === 0 && <li className="px-3 py-2 text-xs text-muted">No transforms match.</li>}
          {matches.map((s) => (
            <li key={s.kind}>
              <button
                type="button"
                onMouseEnter={() => setHover(s)}
                onClick={() => onPick(s)}
                className={`w-full px-3 py-1 text-left ${shown === s ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="overflow-y-auto p-3">
          {shown && (
            <>
              <div className="font-medium">{shown.label}</div>
              <p className="mt-1 text-xs text-muted">{shown.description}</p>
              <div className="mt-3 text-xs font-medium text-soft">Parameters</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
                {shown.fields.map((f) => (
                  <li key={f.key}>
                    {f.label}
                    {f.optional ? " (optional)" : ""}
                  </li>
                ))}
                {shown.output && <li>Output column (optional)</li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
