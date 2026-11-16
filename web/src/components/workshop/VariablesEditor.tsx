"use client";

import { useEffect, useMemo, useState } from "react";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { functions as fnRegistry, type FunctionRow } from "@/lib/actions";
import { workshop, type Metric, type Module, type ObjectTypeSource, type TArg, type TStep, type Variable, type VariableDefinition } from "@/lib/workshop";
import { OPS } from "@/lib/workshopTransforms";
import { definitionInputs, shapeSql } from "./ModuleRuntime";
import { FilterDefaultEditor } from "./FilterWidgets";

const TYPES: Variable["type"][] = ["string", "number", "boolean", "date", "timestamp", "array", "struct", "struct_array", "object", "object_set", "object_set_filter", "scenario", "scenario_array"];
const KINDS: [VariableDefinition["kind"], string][] = [
  ["static", "Static"],
  ["transform", "Variable transformation"],
  ["function", "Function"],
  ["aggregation", "Object set aggregation"],
  ["property", "Object property"],
  ["sql", "SQL query"],
  ["scenario_objects", "Scenarios loaded from an object set"],
  ["knn", "K-nearest neighbors (semantic search)"],
];
const KNN_TYPES: Variable["type"][] = ["object_set", "object_set_filter", "array"];
const lab = "block text-[11px] text-muted";

/** Where each variable is used: other variables' definitions, widgets (filters, inputs, text, events) and layouts. */
export function variableUses(mod: Module): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (name: string, by: string) => ((out[name] ??= []).includes(by) ? null : out[name].push(by));
  for (const v of mod.variables ?? []) for (const n of definitionInputs(v)) add(n, `variable ${v.name}`);
  for (const w of mod.widgets) {
    const s = JSON.stringify(w.config);
    for (const m of s.matchAll(/\$var:([\w-]+)|\{\{\s*([\w-]+)\s*\}\}|"(?:variable|tab_variable|loop_variable)":"([\w-]+)"/g)) add(m[1] || m[2] || m[3], `widget ${w.title || w.type} (${w.id})`);
    if (w.type === "text") for (const m of (w.config.text ?? "").matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) add(m[1], `widget text (${w.id})`);
  }
  for (const o of mod.overlays ?? []) if (o.open_variable) add(o.open_variable, `overlay ${o.name}`);
  if (mod.settings?.page_variable) add(mod.settings.page_variable, "page selection");
  return out;
}

export function VariablesEditor({ mod, setMod, values, computed, objectTypes }: {
  mod: Module; setMod: (m: Module) => void; values: Record<string, unknown>; computed: Record<string, { value?: unknown; error?: string; at?: string }>; objectTypes: ObjectTypeSource[];
}) {
  const vars = mod.variables ?? [];
  const [sel, setSel] = useState<number | null>(vars.length ? 0 : null);
  const [q, setQ] = useState("");
  const [lineage, setLineage] = useState(false);
  const uses = useMemo(() => variableUses(mod), [mod]);
  const set = (i: number, v: Partial<Variable>) => setMod({ ...mod, variables: vars.map((x, j) => (j === i ? { ...x, ...v } : x)) });
  const cur = sel !== null ? vars[sel] : undefined;
  return (
    <div className="space-y-2 text-xs" data-variables>
      <div className="flex gap-1">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search variables" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
        <button type="button" onClick={() => setLineage(!lineage)} className={`rounded px-2 ${lineage ? "bg-ocean/15 text-ocean" : "text-muted"}`} title="Variable lineage">
          Lineage
        </button>
      </div>
      {lineage ? (
        <div className="space-y-2" data-lineage>
          {vars.map((v) => (
            <div key={v.name} className="rounded border border-line p-2">
              <div className="font-mono font-medium">{v.name}</div>
              <div className="text-muted">← {definitionInputs(v).join(", ") || (v.definition?.kind ?? "static")}</div>
              <div className="text-muted">→ {(uses[v.name] ?? []).join(", ") || "not used"}</div>
              {computed[v.name]?.at && <div className="text-[10px] text-muted">computed {new Date(computed[v.name].at!).toLocaleTimeString()}</div>}
            </div>
          ))}
        </div>
      ) : (
        <>
          {vars.map((v, i) =>
            q && !v.name.toLowerCase().includes(q.toLowerCase()) ? null : (
              <button key={i} type="button" onClick={() => setSel(i)} className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left ${sel === i ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`} data-var={v.name}>
                <span className="flex-1 truncate font-mono">{v.name}</span>
                <span className="text-[10px] text-muted">{v.definition?.kind && v.definition.kind !== "static" ? v.definition.kind : v.type}</span>
              </button>
            ),
          )}
          <button type="button" onClick={() => (setMod({ ...mod, variables: [...vars, { name: `var${vars.length + 1}`, type: "string" }] }), setSel(vars.length))} className="text-ocean">
            + Variable
          </button>
        </>
      )}
      {cur && sel !== null && !lineage && (
        <div className="space-y-2 border-t border-line pt-2" data-var-editor={cur.name}>
          <div className="flex gap-1">
            <input value={cur.name} onChange={(e) => set(sel, { name: e.target.value })} className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} />
            <select value={cur.type} onChange={(e) => set(sel, { type: e.target.value as Variable["type"] })} className={`${fieldClass} text-xs`}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <select value={cur.definition?.kind ?? "static"} onChange={(e) => set(sel, { definition: blankDef(e.target.value as VariableDefinition["kind"], objectTypes) })} className={`${inputClass} text-xs`} data-definition>
            {KINDS.filter(([k]) => !(k === "sql" && (cur.type === "object" || cur.type === "object_set")) && (k !== "knn" || KNN_TYPES.includes(cur.type) || cur.definition?.kind === "knn")).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <DefinitionEditor v={cur} vars={vars} values={values} objectTypes={objectTypes} onChange={(d) => set(sel, { definition: d })} onDefault={(x) => set(sel, { default: x })} onExtract={(on) => set(sel, { extract: on || undefined })} />
          {cur.definition && cur.definition.kind !== "static" && cur.definition.kind !== "transform" && (
            <label className={lab}>
              Recompute
              <select value={cur.recompute ?? "auto"} onChange={(e) => set(sel, { recompute: e.target.value as Variable["recompute"] })} className={`${inputClass} text-xs`}>
                <option value="auto">Automatic (when its inputs change)</option>
                <option value="event">Only when triggered by an event</option>
                <option value="load_event">On module load, and when triggered by an event</option>
              </select>
            </label>
          )}
          <details className="rounded border border-line p-2">
            <summary className="cursor-pointer text-soft">Settings</summary>
            <div className="mt-1 space-y-1">
              <input value={cur.external_id ?? ""} onChange={(e) => set(sel, { external_id: e.target.value || undefined })} placeholder="External ID (module interface)" className={`${fieldClass} w-full text-xs`} />
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!!cur.interface} onChange={(e) => set(sel, { interface: e.target.checked })} /> Module interface (embedding, Open module, URL)
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!!cur.url_param} onChange={(e) => set(sel, { url_param: e.target.checked })} /> Routing: initialize from the URL
              </label>
              <input value={cur.description ?? ""} onChange={(e) => set(sel, { description: e.target.value })} placeholder="Description" className={`${fieldClass} w-full text-xs`} />
            </div>
          </details>
          <div className="rounded bg-ink p-2">
            <div className="text-muted">Current value</div>
            {computed[cur.name]?.error ? <div className="text-bad">{computed[cur.name].error}</div> : <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px]">{JSON.stringify(values[cur.name] ?? null, null, 1)}</pre>}
          </div>
          <div className="text-muted">Used by: {(uses[cur.name] ?? []).join(", ") || "nothing"}</div>
          <button type="button" disabled={!!uses[cur.name]?.length} title={uses[cur.name]?.length ? "Variables in use cannot be deleted" : undefined} onClick={() => (setMod({ ...mod, variables: vars.filter((_, j) => j !== sel) }), setSel(null))} className="text-bad disabled:opacity-40">
            Delete variable
          </button>
        </div>
      )}
    </div>
  );
}

function blankDef(kind: VariableDefinition["kind"], types: ObjectTypeSource[]): VariableDefinition {
  switch (kind) {
    case "transform":
      return { kind, steps: [{ op: "concat", args: [{ value: "" }] }] };
    case "function":
      return { kind, function_id: "", inputs: {} };
    case "aggregation":
      return { kind, source: types[0] ? { kind: "object_type", id: types[0].id } : undefined, metric: "count", filters: [] };
    case "property":
      return { kind, object_type_id: types[0]?.id ?? "", property: "" };
    case "sql":
      return { kind, query: "SELECT COUNT(*) AS n FROM @t", tables: types[0] ? [{ alias: "t", object_type_id: types[0].id }] : [], params: [] };
    case "scenario_objects":
      return { kind, object_type_id: types[0]?.id ?? "", id_property: "" };
    case "knn": {
      const t = types.find((x) => x.properties.some((p) => p.type.toLowerCase() === "vector")) ?? types[0];
      return { kind, object_type_id: t?.id ?? "", query: "", k: 10, mode: "semantic" };
    }
    default:
      return { kind: "static" };
  }
}

function ArgInput({ a, vars, steps, onChange }: { a: TArg; vars: Variable[]; steps: number; onChange: (a: TArg) => void }) {
  const mode = a.var !== undefined ? "var" : a.step !== undefined ? "step" : "value";
  return (
    <div className="flex gap-1">
      <select value={mode} onChange={(e) => onChange(e.target.value === "var" ? { var: vars[0]?.name ?? "" } : e.target.value === "step" ? { step: 0 } : { value: "" })} className={`${fieldClass} w-20 text-[11px]`}>
        <option value="value">Value</option>
        <option value="var">Variable</option>
        {steps > 0 && <option value="step">Step</option>}
      </select>
      {mode === "var" ? (
        <select value={a.var} onChange={(e) => onChange({ var: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`}>
          {vars.map((v) => (
            <option key={v.name}>{v.name}</option>
          ))}
        </select>
      ) : mode === "step" ? (
        <select value={a.step} onChange={(e) => onChange({ step: Number(e.target.value) })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`}>
          {Array.from({ length: steps }, (_, i) => (
            <option key={i} value={i}>
              Step {i + 1}
            </option>
          ))}
        </select>
      ) : (
        <input value={a.value === undefined || a.value === null ? "" : String(a.value)} onChange={(e) => onChange({ value: e.target.value === "" ? "" : !Number.isNaN(Number(e.target.value)) && e.target.value.trim() !== "" ? Number(e.target.value) : e.target.value === "true" ? true : e.target.value === "false" ? false : e.target.value })}
          className={`${fieldClass} min-w-0 flex-1 text-[11px]`} />
      )}
    </div>
  );
}

function DefinitionEditor({ v, vars, values, objectTypes, onChange, onDefault, onExtract }: { v: Variable; vars: Variable[]; values: Record<string, unknown>; objectTypes: ObjectTypeSource[]; onChange: (d: VariableDefinition) => void; onDefault: (x: unknown) => void; onExtract: (on: boolean) => void }) {
  const d = v.definition ?? { kind: "static" };
  const others = vars.filter((x) => x.name !== v.name);
  const [fns, setFns] = useState<FunctionRow[]>([]);
  const [preview, setPreview] = useState<{ columns: { name: string }[]; rows: unknown[][]; error?: string; shaped?: string } | null>(null);
  useEffect(() => {
    if (d.kind === "function") fnRegistry.list().then(setFns, () => {});
  }, [d.kind]);
  if (d.kind === "static" && v.type === "object_set_filter") return <FilterDefaultEditor v={v} vars={vars} onDefault={onDefault} onExtract={onExtract} />;
  if (d.kind === "static")
    return (
      <label className={lab}>
        Default value {v.type === "struct" || v.type === "struct_array" || v.type === "array" ? "(JSON or comma-separated)" : ""}
        <input value={v.default === undefined ? "" : typeof v.default === "object" ? JSON.stringify(v.default) : String(v.default)} onChange={(e) => onDefault(e.target.value)} className={`${inputClass} text-xs`} />
      </label>
    );
  if (d.kind === "transform") {
    const groups = [...new Set(Object.values(OPS).map((o) => o.group))];
    return (
      <div className="space-y-2" data-transform>
        {d.steps.map((s, i) => {
          const op = OPS[s.op];
          const variadic = op?.args.some((x) => x.endsWith("…"));
          const setStep = (n: TStep) => onChange({ ...d, steps: d.steps.map((x, j) => (j === i ? n : x)) });
          return (
            <div key={i} className="space-y-1 rounded border border-line p-2">
              <div className="flex gap-1">
                <span className="pt-1 text-muted">{i + 1}.</span>
                <select value={s.op} onChange={(e) => setStep({ op: e.target.value, args: (OPS[e.target.value]?.args ?? []).map(() => ({ value: "" })) })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`}>
                  {groups.map((g) => (
                    <optgroup key={g} label={g}>
                      {Object.entries(OPS)
                        .filter(([, o]) => o.group === g)
                        .map(([k, o]) => (
                          <option key={k} value={k}>
                            {o.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
                <button type="button" onClick={() => onChange({ ...d, steps: d.steps.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
              {s.args.map((a, j) => (
                <div key={j}>
                  <span className="text-[10px] text-muted">{op?.args[Math.min(j, op.args.length - 1)]?.replace("…", ` ${j + 1}`)}</span>
                  <ArgInput a={a} vars={others} steps={i} onChange={(x) => setStep({ ...s, args: s.args.map((y, k) => (k === j ? x : y)) })} />
                </div>
              ))}
              {variadic && (
                <button type="button" onClick={() => setStep({ ...s, args: [...s.args, { value: "" }] })} className="text-[11px] text-ocean">
                  + Input
                </button>
              )}
              {op?.opts?.map((o) => (
                <label key={o.key} className="flex items-center gap-1 text-[11px] text-muted">
                  {o.label}
                  {o.choices ? (
                    <select value={String(s.opts?.[o.key] ?? o.choices[0])} onChange={(e) => setStep({ ...s, opts: { ...s.opts, [o.key]: e.target.value } })} className={`${fieldClass} text-[11px]`}>
                      {o.choices.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={String(s.opts?.[o.key] ?? "")} onChange={(e) => setStep({ ...s, opts: { ...s.opts, [o.key]: e.target.value } })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`} />
                  )}
                </label>
              ))}
            </div>
          );
        })}
        <button type="button" onClick={() => onChange({ ...d, steps: [...d.steps, { op: "concat", args: [{ step: d.steps.length - 1 }] }] })} className="text-ocean">
          + Step (uses the previous ones)
        </button>
      </div>
    );
  }
  if (d.kind === "function") {
    const f = fns.find((x) => x.id === d.function_id);
    return (
      <div className="space-y-1">
        <select value={d.function_id} onChange={(e) => onChange({ ...d, function_id: e.target.value, inputs: {} })} className={`${inputClass} text-xs`}>
          <option value="">Choose a function…</option>
          {fns.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · {x.version}
            </option>
          ))}
        </select>
        {f?.inputs.map((i) => (
          <label key={i.name} className={lab}>
            {i.name} ({i.type})
            <input value={String(d.inputs?.[i.name] ?? "")} onChange={(e) => onChange({ ...d, inputs: { ...d.inputs, [i.name]: e.target.value } })} placeholder="value, {{var}} or $var:name" className={`${inputClass} text-xs`} />
          </label>
        ))}
      </div>
    );
  }
  if (d.kind === "aggregation") {
    const t = objectTypes.find((x) => x.id === d.source?.id);
    return (
      <div className="space-y-1">
        <select value={d.source?.id ?? ""} onChange={(e) => onChange({ ...d, source: { kind: "object_type", id: e.target.value }, column: undefined, filters: [] })} className={`${inputClass} text-xs`}>
          {objectTypes.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          <select value={d.metric} onChange={(e) => onChange({ ...d, metric: e.target.value as Metric })} className={`${fieldClass} text-xs`}>
            {["count", "sum", "avg", "min", "max", "distinct"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          {d.metric !== "count" && (
            <select value={d.column ?? ""} onChange={(e) => onChange({ ...d, column: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
              <option value="">Property…</option>
              {t?.properties.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {(d.filters ?? []).map((f, i) => (
          <div key={i} className="flex gap-1">
            <select value={f.column} onChange={(e) => onChange({ ...d, filters: d.filters!.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })} className={`${fieldClass} w-24 text-[11px]`}>
              {t?.properties.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <select value={f.op} onChange={(e) => onChange({ ...d, filters: d.filters!.map((x, j) => (j === i ? { ...x, op: e.target.value as typeof f.op } : x)) })} className={`${fieldClass} text-[11px]`}>
              {["eq", "neq", "gt", "gte", "lt", "lte", "contains"].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <input value={String(f.value ?? "")} onChange={(e) => onChange({ ...d, filters: d.filters!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder="$var:name" className={`${fieldClass} min-w-0 flex-1 text-[11px]`} />
          </div>
        ))}
        <button type="button" onClick={() => onChange({ ...d, filters: [...(d.filters ?? []), { column: t?.properties[0]?.name ?? "", op: "eq", value: "" }] })} className="text-ocean">
          + Filter
        </button>
      </div>
    );
  }
  if (d.kind === "scenario_objects") {
    const t = objectTypes.find((x) => x.id === d.object_type_id);
    return (
      <div className="space-y-1" data-scenario-objects>
        <select value={d.object_type_id} onChange={(e) => onChange({ ...d, object_type_id: e.target.value, id_property: "" })} className={`${inputClass} text-xs`}>
          {objectTypes.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <select value={d.id_property} onChange={(e) => onChange({ ...d, id_property: e.target.value })} className={`${inputClass} text-xs`}>
          <option value="">The property holding the scenario id…</option>
          {t?.properties.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (d.kind === "knn") {
    const withVectors = objectTypes.filter((x) => x.properties.some((p) => p.type === "vector"));
    const t = objectTypes.find((x) => x.id === d.object_type_id);
    const vecs = t?.properties.filter((p) => p.type === "vector") ?? [];
    const qVar = d.query.match(/^\$var:([\w-]+)$/)?.[1] ?? d.query.match(/^\{\{\s*([\w-]+)\s*\}\}$/)?.[1];
    return (
      <div className="space-y-1" data-knn>
        <select value={d.object_type_id} onChange={(e) => onChange({ ...d, object_type_id: e.target.value, property: undefined })} className={`${inputClass} text-xs`}>
          {(withVectors.length ? withVectors : objectTypes).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <label className={lab}>
          Embedding property
          <select value={d.property ?? ""} onChange={(e) => onChange({ ...d, property: e.target.value || undefined })} className={`${inputClass} text-xs`}>
            <option value="">{vecs[0] ? `${vecs[0].label} (the first)` : "No vector property"}</option>
            {vecs.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className={lab}>
          Query: a string variable (text, embedded with the property&apos;s model) or a numeric array variable (a vector)
          <select value={qVar ?? (d.query ? "__text" : "")} onChange={(e) => onChange({ ...d, query: e.target.value === "__text" ? "" : e.target.value ? `$var:${e.target.value}` : "" })} className={`${inputClass} text-xs`} data-knn-query>
            <option value="">Choose a variable…</option>
            {others.filter((x) => x.type === "string" || x.type === "array").map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} ({x.type})
              </option>
            ))}
            <option value="__text">Fixed text…</option>
          </select>
        </label>
        {!qVar && (
          <input value={d.query} onChange={(e) => onChange({ ...d, query: e.target.value })} placeholder="Query text ({{variables}} allowed)" className={`${inputClass} text-xs`} />
        )}
        <div className="flex gap-1">
          <label className={`${lab} w-20`}>
            K (1–500)
            <input type="number" min={1} max={500} value={d.k ?? 10} onChange={(e) => onChange({ ...d, k: Math.max(1, Math.min(500, Number(e.target.value) || 10)) })} className={`${inputClass} text-xs`} />
          </label>
          <label className={`${lab} flex-1`}>
            Ranking (text queries)
            <select value={d.mode ?? "semantic"} onChange={(e) => onChange({ ...d, mode: e.target.value as "semantic" })} className={`${inputClass} text-xs`}>
              <option value="semantic">By meaning (KNN)</option>
              <option value="hybrid">Hybrid (KNN + keywords, RRF)</option>
              <option value="keyword">Keywords (BM25)</option>
            </select>
          </label>
        </div>
        <p className="text-[10px] text-muted">
          The k nearest objects, most relevant first. Apply the variable to a widget on {t?.name ?? "the object type"} (its object set filter variables): tables and lists keep the rank order
          {v.type === "object_set_filter" ? " and get a relevance column" : ""}. With no query, or no results, the variable is an empty object set and widgets on it show no objects.
        </p>
      </div>
    );
  }
  if (d.kind === "property") {
    const t = objectTypes.find((x) => x.id === d.object_type_id);
    return (
      <div className="space-y-1">
        <select value={d.object_type_id} onChange={(e) => onChange({ ...d, object_type_id: e.target.value, property: "" })} className={`${inputClass} text-xs`}>
          {objectTypes.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <input value={d.object ?? ""} onChange={(e) => onChange({ ...d, object: e.target.value || undefined })} placeholder="The object: $var:name (empty: the selected one)" className={`${inputClass} text-xs`} />
        <select value={d.property} onChange={(e) => onChange({ ...d, property: e.target.value })} className={`${inputClass} text-xs`}>
          <option value="">Property…</option>
          {t?.properties.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  // SQL query
  const run = async () => {
    try {
      const r = await workshop.sql({
        query: d.query,
        tables: Object.fromEntries(d.tables.map((t) => [t.alias, t.object_type_id])),
        params: Object.fromEntries(d.params.map((p) => [p.alias, values[p.variable] ?? null])),
        limit: 50,
      });
      let shaped = "";
      try {
        shaped = JSON.stringify(shapeSql(v, r)).slice(0, 300);
      } catch (e) {
        shaped = `⚠ ${(e as Error).message}`;
      }
      setPreview({ columns: r.columns, rows: r.rows, shaped });
    } catch (e) {
      setPreview({ columns: [], rows: [], error: (e as Error).message });
    }
  };
  return (
    <div className="space-y-1" data-sql>
      <div className="text-[11px] text-muted">Tables (@alias → object type)</div>
      {d.tables.map((t, i) => (
        <div key={i} className="flex gap-1">
          <input value={t.alias} onChange={(e) => onChange({ ...d, tables: d.tables.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)) })} className={`${fieldClass} w-16 font-mono text-[11px]`} />
          <select value={t.object_type_id} onChange={(e) => onChange({ ...d, tables: d.tables.map((x, j) => (j === i ? { ...x, object_type_id: e.target.value } : x)) })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`}>
            {objectTypes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => onChange({ ...d, tables: d.tables.filter((_, j) => j !== i) })} className="px-1 text-muted">
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange({ ...d, tables: [...d.tables, { alias: `t${d.tables.length + 1}`, object_type_id: objectTypes[0]?.id ?? "" }] })} className="text-[11px] text-ocean">
        + Table
      </button>
      <div className="text-[11px] text-muted">Parameters (@alias → variable)</div>
      {d.params.map((p, i) => (
        <div key={i} className="flex gap-1">
          <input value={p.alias} onChange={(e) => onChange({ ...d, params: d.params.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)) })} className={`${fieldClass} w-16 font-mono text-[11px]`} />
          <select value={p.variable} onChange={(e) => onChange({ ...d, params: d.params.map((x, j) => (j === i ? { ...x, variable: e.target.value } : x)) })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`}>
            <option value="">Variable…</option>
            {others.map((x) => (
              <option key={x.name}>{x.name}</option>
            ))}
          </select>
          <button type="button" onClick={() => onChange({ ...d, params: d.params.filter((_, j) => j !== i) })} className="px-1 text-muted">
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange({ ...d, params: [...d.params, { alias: `p${d.params.length + 1}`, variable: others[0]?.name ?? "" }] })} className="text-[11px] text-ocean">
        + Parameter
      </button>
      <textarea value={d.query} onChange={(e) => onChange({ ...d, query: e.target.value })} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && void run()} rows={5} className={`${inputClass} font-mono text-[11px]`} spellCheck={false} />
      <button type="button" onClick={run} className="text-ocean" title="Ctrl+Enter">
        Run preview (50 rows; parameters at their current values)
      </button>
      {preview && (
        <div className="max-h-40 overflow-auto rounded bg-ink p-1 font-mono text-[10px]">
          {preview.error ? (
            <div className="text-bad">{preview.error}</div>
          ) : (
            <>
              <div className="text-muted">{preview.columns.map((c) => c.name).join(" | ")}</div>
              {preview.rows.slice(0, 20).map((r, i) => (
                <div key={i}>{r.map((x) => String(x)).join(" | ")}</div>
              ))}
              <div className={preview.shaped?.startsWith("⚠") ? "text-warn" : "text-ok"}>→ {preview.shaped}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
