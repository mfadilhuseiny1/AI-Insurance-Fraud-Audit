"use client";

import { useState } from "react";
import { API_URL } from "@/lib/api";
import {
  DEFAULT_LLM_MODEL,
  effectiveOutputType,
  llmProblems,
  LLM_MODELS,
  newLlmConfig,
  promptColumns,
  rowCall,
  templatePrompt,
  TEMPLATE_INFO,
  coerceAnswer,
} from "@/lib/llm";
import { LLM_OUTPUT_TYPES, LLM_TEMPLATES, uid, type LlmConfig, type LlmEntity, type LlmNode, type LlmOutputType, type NodeResult, type Row } from "@/lib/pipeline";
import { forgetAnswers } from "@/lib/services";
import { Icon } from "../Icon";
import { DataPreview, formatCell } from "./DataPreview";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field, Switch, Tabs } from "./ui";
import { confirmDialog } from "@/lib/dialogs";

type TrialResult = { value?: unknown; error?: string; trace?: { initial_prompt: string; attempts: string[]; corrections: string[]; final: string } };

const ENTITY_TYPES: LlmEntity["type"][] = ["String", "Integer", "Double", "Boolean", "Array<String>", "Array<Integer>"];

/** The Use LLM board. */
export function LlmEditor({
  node,
  input,
  output,
  inputName,
  onApply,
  onClose,
}: {
  node: LlmNode;
  input: NodeResult;
  output: NodeResult;
  inputName: string;
  onApply: (name: string, config: LlmConfig) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(node.name);
  const [c, setC] = useState<LlmConfig>(node.config);
  const [view, setView] = useState<"configure" | "preview">("configure");
  const [bottom, setBottom] = useState<"trial" | "input" | "output">("trial");
  const [advanced, setAdvanced] = useState(false);
  const [modelTab, setModelTab] = useState<"provided" | "registered">(LLM_MODELS.some((m) => m.id === node.config.model) ? "provided" : "registered");
  const [banner, setBanner] = useState<{ text: string; undo?: LlmConfig } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<Record<string, TrialResult>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [raw, setRaw] = useState<string | null>(null);
  const t = input.table;
  const columns = t?.columns ?? [];
  const textColumns = columns;
  const set = (patch: Partial<LlmConfig>) => setC((prev) => ({ ...prev, ...patch }));
  const dirty = name !== node.name || JSON.stringify(c) !== JSON.stringify(node.config);
  const problems = t ? llmProblems(c, t) : [input.error ?? "The input is unavailable"];
  const model = LLM_MODELS.find((m) => m.id === c.model);
  const template = c.created ? null : c.template;
  const { system, prompt } = templatePrompt(c);
  const used = t ? promptColumns(`${system}\n${prompt}`, columns.map((x) => x.name)) : [];
  const trialColumns = [...new Set([...used, ...(c.imageColumn ? [c.imageColumn] : [])])];
  const trials = c.trials ?? [];

  // prompt changes that make earlier answers wrong: offer to clear the cache
  const changeOutputType = (outputType: LlmOutputType) => {
    if (outputType === c.outputType) return;
    const before = c;
    setC({ ...c, outputType, cacheEpoch: (c.cacheEpoch ?? 0) + 1 });
    setBanner({ text: "The cache was cleared because the output type changed.", undo: before });
  };

  const runTrial = async (id: string, values: Record<string, string>) => {
    setRunning((r) => new Set([...r, id]));
    try {
      const row: Row = Object.fromEntries(columns.map((col) => [col.name, values[col.name] ?? null]));
      const { call } = rowCall(c, row, columns.map((x) => x.name), node.id);
      const res = await fetch(`${API_URL}/api/pipeline/ai/llm/trial`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...call, key: `trial:${id}` }) });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText));
      let value: unknown = body.value;
      let error: string | undefined = body.error ?? undefined;
      if (!error) {
        try {
          value = coerceAnswer(c, value);
        } catch (e) {
          error = (e as Error).message;
        }
      }
      setResults((r) => ({ ...r, [id]: { value, error, trace: body.trace } }));
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { error: (e as Error).message } }));
    } finally {
      setRunning((r) => new Set([...r].filter((x) => x !== id)));
    }
  };

  const addTrial = (values: Record<string, string> = {}) => set({ trials: [...trials, { id: uid(), values }] });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Icon name="sparkle" className="h-4 w-4 text-ocean" />
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Node name" className="w-56 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none hover:border-line-2 focus:border-ocean" />
        <span className="text-xs text-muted">Use LLM · input {inputName}</span>
        <div className="ml-auto flex gap-2">
          <button type="button" disabled={!dirty || !name.trim()} onClick={() => onApply(name.trim(), c)} className={buttonClass.primary}>
            <Icon name="check" /> {dirty ? "Apply" : "Applied"}
          </button>
          <button type="button" onClick={async () => (!dirty || (await confirmDialog("Discard the changes you have not applied?"))) && onClose()} className={buttonClass.secondary}>
            <Icon name="x" /> Back to graph
          </button>
        </div>
      </div>

      {banner && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-warn">
          <Icon name="alert" className="h-3.5 w-3.5" /> {banner.text}
          {banner.undo && (
            <button
              type="button"
              onClick={() => {
                setC(banner.undo!);
                setBanner(null);
              }}
              className="underline"
            >
              Undo change
            </button>
          )}
          <button type="button" onClick={() => setBanner(null)} className="ml-auto">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-3 p-5">
          {/* model */}
          <div className="rounded-md border border-line bg-panel p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              Model
              <Tabs
                value={modelTab}
                onChange={setModelTab}
                className="ml-2"
                tabs={[
                  { id: "provided", label: "Provided" },
                  { id: "registered", label: "Registered" },
                ]}
              />
            </div>
            {modelTab === "provided" ? (
              <div className="grid grid-cols-3 gap-1.5">
                {LLM_MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => set({ model: m.id })}
                    className={`rounded-md border p-2 text-left text-xs ${c.model === m.id ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}
                  >
                    <span className="flex items-center gap-1.5 font-medium text-white">
                      {m.label}
                      {m.vision && <span className="rounded bg-violet-400/15 px-1 text-[10px] text-violet-300">Vision</span>}
                    </span>
                    <span className="block text-muted">
                      {m.vendor} · {m.description}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <Field label="Registered model" hint="An OpenRouter model id (vendor/model) or a model behind your own provider key — called like the provided ones.">
                <input value={LLM_MODELS.some((m) => m.id === c.model) ? "" : c.model} placeholder="e.g. mistralai/mixtral-8x7b-instruct" onChange={(e) => set({ model: e.target.value || DEFAULT_LLM_MODEL })} className={inputClass} />
              </Field>
            )}
          </div>

          {/* prompt */}
          {!c.created && (
            <div className="rounded-md border border-line bg-panel p-3">
              <div className="mb-2 text-sm font-medium">Prompt</div>
              <div className="grid grid-cols-3 gap-1.5">
                {LLM_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl}
                    type="button"
                    onClick={() => setC({ ...newLlmConfig(tpl, c.column ?? ""), model: c.model, temperature: c.temperature, maxTokens: c.maxTokens, stop: c.stop, trials: c.trials, cacheEpoch: c.cacheEpoch, skipRecompute: c.skipRecompute })}
                    className={`rounded-md border p-2 text-left text-xs ${c.template === tpl ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}
                  >
                    <span className="block font-medium text-white">{TEMPLATE_INFO[tpl].label}</span>
                    <span className="block text-muted">{TEMPLATE_INFO[tpl].hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-md border border-ocean bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="text-sm font-medium">{c.created ? "Prompt" : TEMPLATE_INFO[c.template].label}</span>
              {template && template !== "empty" && (
                <Tabs
                  value={view}
                  onChange={setView}
                  className="ml-2"
                  tabs={[
                    { id: "configure", label: "Configure" },
                    { id: "preview", label: "Preview" },
                  ]}
                />
              )}
              {template && template !== "empty" && (
                <button
                  type="button"
                  title="Turn the template into an editable prompt (you cannot go back to the template)"
                  onClick={async () => (await confirmDialog("Create the prompt? You will not be able to go back to the template for this board.")) && setC({ ...c, created: true, system, prompt, outputType: effectiveOutputType(c) })}
                  className={`${buttonClass.secondary} ml-auto py-1 text-xs`}
                >
                  Create prompt
                </button>
              )}
            </div>
            <div className="space-y-3 p-3">
              {view === "preview" && template && template !== "empty" ? (
                <div className="space-y-2 text-xs">
                  <p className="text-muted">The instructions the template sends (read-only — select Configure to change them, or Create prompt to edit them freely).</p>
                  <pre className="whitespace-pre-wrap rounded bg-ink p-2 font-mono text-soft">{system}</pre>
                  <pre className="whitespace-pre-wrap rounded bg-ink p-2 font-mono text-soft">{prompt}</pre>
                </div>
              ) : (
                <>
                  {template === "classification" && (
                    <>
                      <Field label="Multiplicity">
                        <div className="flex items-center gap-2">
                          <select value={c.multiplicity} onChange={(e) => set({ multiplicity: e.target.value as LlmConfig["multiplicity"] })} className={`${inputClass} w-56`}>
                            <option value="exactly one">One category</option>
                            <option value="one or more">One or more categories</option>
                            <option value="exact number">An exact number of categories</option>
                          </select>
                          {c.multiplicity === "exact number" && (
                            <input type="number" min={1} value={c.count ?? 2} onChange={(e) => set({ count: Math.max(1, Number(e.target.value)) })} className={`${inputClass} w-20`} />
                          )}
                        </div>
                      </Field>
                      <Field label="Context" hint="A description of your data, e.g. Restaurant review">
                        <input value={c.context ?? ""} onChange={(e) => set({ context: e.target.value })} className={inputClass} />
                      </Field>
                      <Field label="Categories" hint="Comma separated, e.g. Food, Service, Atmosphere">
                        <input value={(c.categories ?? []).join(", ")} onChange={(e) => set({ categories: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={inputClass} />
                      </Field>
                    </>
                  )}
                  {template === "summarization" && (
                    <Field label="Summarization size">
                      <div className="flex gap-2">
                        <input type="number" min={1} value={c.size ?? 1} onChange={(e) => set({ size: Math.max(1, Number(e.target.value)) })} className={`${inputClass} w-24`} />
                        <select value={c.unit} onChange={(e) => set({ unit: e.target.value as LlmConfig["unit"] })} className={`${inputClass} w-40`}>
                          <option value="words">Words</option>
                          <option value="sentences">Sentences</option>
                          <option value="paragraphs">Paragraphs</option>
                        </select>
                      </div>
                    </Field>
                  )}
                  {template === "translation" && (
                    <Field label="Language">
                      <input value={c.language ?? ""} onChange={(e) => set({ language: e.target.value })} className={inputClass} />
                    </Field>
                  )}
                  {template === "sentiment" && (
                    <Field label="Scale" hint="The lowest score is the most negative, the highest the most positive.">
                      <div className="flex items-center gap-2 text-xs">
                        from
                        <input type="number" value={c.scaleMin ?? 0} onChange={(e) => set({ scaleMin: Number(e.target.value) })} className={`${inputClass} w-20`} />
                        to
                        <input type="number" value={c.scaleMax ?? 5} onChange={(e) => set({ scaleMax: Number(e.target.value) })} className={`${inputClass} w-20`} />
                      </div>
                    </Field>
                  )}
                  {template === "entities" && (
                    <Field label="Entities to extract">
                      <div className="space-y-1">
                        {(c.entities ?? []).map((e, i) => (
                          <div key={e.id} className="flex gap-1.5">
                            <input
                              value={e.name}
                              placeholder="Entity name"
                              onChange={(ev) => set({ entities: (c.entities ?? []).map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) })}
                              className={`${inputClass} py-1 text-xs`}
                            />
                            <select
                              value={e.type}
                              onChange={(ev) => set({ entities: (c.entities ?? []).map((x, j) => (j === i ? { ...x, type: ev.target.value as LlmEntity["type"] } : x)) })}
                              className={`${inputClass} w-40 py-1 text-xs`}
                            >
                              {ENTITY_TYPES.map((tp) => (
                                <option key={tp}>{tp}</option>
                              ))}
                            </select>
                            <button type="button" onClick={() => set({ entities: (c.entities ?? []).filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:text-bad">
                              <Icon name="x" className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        <button type="button" onClick={() => set({ entities: [...(c.entities ?? []), { id: uid(), name: "", type: "String" }] })} className="text-xs text-ocean hover:underline">
                          + Add entity
                        </button>
                      </div>
                    </Field>
                  )}
                  {template && template !== "empty" && (
                    <Field label={template === "classification" ? "Column to classify" : "Column"} required>
                      <select value={c.column ?? ""} onChange={(e) => set({ column: e.target.value })} className={inputClass}>
                        <option value="">Choose a column…</option>
                        {textColumns.map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.name} · {col.type}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {(c.created || template === "empty") && (
                    <>
                      <Field label="System instructions" hint="Optional: how the model should behave.">
                        <textarea value={c.system ?? ""} onChange={(e) => set({ system: e.target.value })} rows={3} className={`${inputClass} text-xs`} />
                      </Field>
                      <Field label="Provide input data — the prompt" hint="Write {column} to insert a row's value; click a column to insert it.">
                        <textarea value={c.prompt ?? ""} onChange={(e) => set({ prompt: e.target.value })} rows={5} className={`${inputClass} font-mono text-xs`} />
                        <span className="mt-1 flex flex-wrap gap-1">
                          {columns.map((col) => (
                            <button key={col.name} type="button" onClick={() => set({ prompt: `${c.prompt ?? ""}{${col.name}}` })} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-soft ring-1 ring-line-2 hover:text-white">
                              {col.name}
                            </button>
                          ))}
                        </span>
                      </Field>
                      <Field label="Image (vision)" hint="A media reference column (Files item id), image URL or data URL; choose a model with the Vision label.">
                        <select value={c.imageColumn ?? ""} onChange={(e) => set({ imageColumn: e.target.value || undefined })} className={inputClass}>
                          <option value="">No image</option>
                          {columns.map((col) => (
                            <option key={col.name} value={col.name}>
                              {col.name}
                            </option>
                          ))}
                        </select>
                        {c.imageColumn && model && !model.vision && <span className="mt-1 block text-xs text-warn">{model.label} has no vision capability.</span>}
                      </Field>
                    </>
                  )}
                </>
              )}

              <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
                <Field label="Output column">
                  <input value={c.outputColumn} onChange={(e) => set({ outputColumn: e.target.value })} className={inputClass} />
                </Field>
                <Field label="Output type" hint={!c.created && template !== "empty" ? "Set by the template" : "Struct output is parsed strictly; use JSON string to parse it yourself later."}>
                  <select
                    value={effectiveOutputType(c)}
                    disabled={!c.created && template !== "empty"}
                    onChange={(e) => changeOutputType(e.target.value as LlmOutputType)}
                    className={inputClass}
                  >
                    {LLM_OUTPUT_TYPES.map((tp) => (
                      <option key={tp}>{tp}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="flex flex-wrap gap-6">
                <Switch on={!!c.includeErrors} onChange={(v) => set({ includeErrors: v })} label="Include errors" hint="Output a struct of the value and the LLM error string." />
                <div className="flex items-start gap-2">
                  <Switch
                    on={!!c.skipRecompute}
                    onChange={(v) => set({ skipRecompute: v })}
                    label="Skip recomputing rows"
                    hint="Rows whose prompt columns and parameters are unchanged reuse earlier answers (errors and nulls are recomputed)."
                  />
                  <button
                    type="button"
                    title="Clear the cache: every row is recomputed in the next deployment"
                    onClick={async () => {
                      if (!(await confirmDialog("Clear the cache? All rows are reprocessed in the next deployment."))) return;
                      forgetAnswers(`llm:${node.id}:`);
                      set({ cacheEpoch: (c.cacheEpoch ?? 0) + 1 });
                      setBanner({ text: "Cache cleared — all rows will be reprocessed in the next deployment." });
                    }}
                    className="rounded p-1 text-bad hover:bg-bad/10"
                  >
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <button type="button" onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1 text-xs text-ocean">
                <Icon name={advanced ? "down" : "right"} className="h-3 w-3" /> [Advanced] Show configurations for model
              </button>
              {advanced && (
                <div className="grid grid-cols-3 gap-3 rounded-md border border-line-2 p-2.5">
                  <Field label="Temperature" hint="Higher is more random, lower more focused.">
                    <input type="number" min={0} max={2} step={0.1} value={c.temperature ?? 0} onChange={(e) => set({ temperature: Number(e.target.value) })} className={inputClass} />
                  </Field>
                  <Field label="Max tokens" hint="Limits the length of the answer.">
                    <input type="number" min={16} max={16000} value={c.maxTokens ?? 1024} onChange={(e) => set({ maxTokens: Number(e.target.value) })} className={inputClass} />
                  </Field>
                  <Field label="Stop sequences" hint="Up to four, comma separated.">
                    <input value={(c.stop ?? []).join(", ")} onChange={(e) => set({ stop: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4) })} className={inputClass} />
                  </Field>
                </div>
              )}
              {problems.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-warn">
                  <Icon name="alert" className="mt-0.5 h-3.5 w-3.5" /> {problems.join(" · ")}
                </p>
              )}
            </div>
          </div>
          <p className="text-xs text-muted">
            The node sends many requests at once and retries rate limits. Previews compute the first 50 rows; deploys compute every row. LLM calls are billed per row — turn on Skip
            recomputing rows for large inputs.
          </p>
        </div>
      </div>

      <div className="flex h-72 shrink-0 flex-col border-t border-line bg-ink">
        <div className="flex items-center border-b border-line px-2 py-1.5">
          <Tabs
            value={bottom}
            onChange={setBottom}
            tabs={[
              { id: "trial", label: "Trial run", badge: trials.length },
              { id: "input", label: "Input table" },
              { id: "output", label: "Output table", badge: output.pending ? `${output.pending} computing` : undefined },
            ]}
          />
          {bottom === "input" && (
            <button
              type="button"
              disabled={!picked.size}
              onClick={() => {
                const rows = [...picked].map((i) => t!.rows[i]);
                set({ trials: [...trials, ...rows.map((r) => ({ id: uid(), values: Object.fromEntries(trialColumns.map((col) => [col, r[col] === null || r[col] === undefined ? "" : String(r[col])])) }))] });
                setPicked(new Set());
                setBottom("trial");
              }}
              className={`${buttonClass.secondary} ml-auto py-1 text-xs`}
            >
              Use rows for trial run ({picked.size})
            </button>
          )}
          {bottom === "trial" && (
            <button type="button" onClick={() => addTrial()} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
              <Icon name="plus" className="h-3 w-3" /> Add trial run
            </button>
          )}
        </div>
        {bottom === "trial" && (
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {!trials.length && <p className="p-4 text-center text-xs text-muted">Add a trial run, or pick rows in the Input table, to test the prompt on examples.</p>}
            <ul className="space-y-1.5">
              {trials.map((tr) => {
                const res = results[tr.id];
                return (
                  <li key={tr.id} className="flex items-start gap-2 rounded-md border border-line-2 bg-panel p-2 text-xs">
                    <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
                      {(trialColumns.length ? trialColumns : [c.column ?? ""]).filter(Boolean).map((col) => (
                        <label key={col} className="flex items-center gap-1">
                          <span className="w-24 shrink-0 truncate font-mono text-muted">{col}</span>
                          <input
                            value={tr.values[col] ?? ""}
                            onChange={(e) => set({ trials: trials.map((x) => (x.id === tr.id ? { ...x, values: { ...x.values, [col]: e.target.value } } : x)) })}
                            className={`${inputClass} py-0.5 text-xs`}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="w-64 shrink-0">
                      {running.has(tr.id) ? (
                        <span className="flex items-center gap-1 text-muted">
                          <Icon name="refresh" className="h-3 w-3 animate-spin" /> Running…
                        </span>
                      ) : res ? (
                        res.error ? (
                          <span className="text-bad">{res.error}</span>
                        ) : (
                          <span className="break-words text-ok">{typeof res.value === "string" ? res.value : JSON.stringify(res.value)}</span>
                        )
                      ) : (
                        <span className="text-muted">Not run</span>
                      )}
                    </div>
                    <button type="button" disabled={running.has(tr.id) || problems.length > 0} onClick={() => runTrial(tr.id, tr.values)} className={`${buttonClass.primary} py-0.5 text-xs`}>
                      Run
                    </button>
                    <button type="button" title="Raw prompt and outputs" disabled={!res?.trace} onClick={() => setRaw(tr.id)} className="rounded p-1 font-mono text-muted hover:text-white disabled:opacity-30">
                      &lt;/&gt;
                    </button>
                    <button type="button" onClick={() => set({ trials: trials.filter((x) => x.id !== tr.id) })} className="rounded p-1 text-muted hover:text-bad">
                      <Icon name="x" className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {bottom === "input" &&
          (t ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-panel">
                  <tr>
                    <th className="w-8 border-b border-line px-2 py-1" />
                    {columns.map((col) => (
                      <th key={col.name} className="border-b border-line px-2 py-1 text-left font-medium">
                        {col.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.slice(0, 200).map((r, i) => (
                    <tr key={i} className={picked.has(i) ? "bg-ocean/10" : "hover:bg-panel-2/60"}>
                      <td className="border-b border-line px-2">
                        <input type="checkbox" checked={picked.has(i)} onChange={(e) => setPicked(new Set(e.target.checked ? [...picked, i] : [...picked].filter((x) => x !== i)))} />
                      </td>
                      {columns.map((col) => (
                        <td key={col.name} className="max-w-xs truncate border-b border-line px-2 py-1">
                          {formatCell(r[col.name] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-4 text-sm text-bad">{input.error}</p>
          ))}
        {bottom === "output" &&
          (output.table ? (
            <DataPreview table={output.table} title={`${name} — first 50 rows (applied)`} />
          ) : (
            <p className="p-4 text-center text-sm text-muted">{dirty ? "Apply the board to compute the output table." : output.error}</p>
          ))}
      </div>

      {raw && results[raw]?.trace && (
        <RawDialog trace={results[raw]!.trace!} onClose={() => setRaw(null)} />
      )}
    </div>
  );
}

function RawDialog({ trace, onClose }: { trace: NonNullable<TrialResult["trace"]>; onClose: () => void }) {
  const parts = [
    { id: "prompt", label: "Initial prompt", text: trace.initial_prompt },
    { id: "outputs", label: "Intermediate LLM outputs", text: trace.attempts.map((a, i) => `--- attempt ${i + 1} ---\n${a}`).join("\n\n") || "(none)" },
    { id: "corrections", label: "Corrections", text: trace.corrections.join("\n") || "No corrections were needed." },
    { id: "final", label: "Final output", text: trace.final },
  ];
  const [sel, setSel] = useState(parts[0].id);
  const shown = parts.find((p) => p.id === sel)!;
  return (
    <Modal title="Trial run details" icon="code" onClose={onClose} wide>
      <div className="flex h-[60vh]">
        <ul className="w-56 shrink-0 border-r border-line p-2 text-sm">
          {parts.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => setSel(p.id)} className={`w-full rounded px-2 py-1.5 text-left ${sel === p.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
                {p.label}
              </button>
            </li>
          ))}
        </ul>
        <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-soft">{shown.text}</pre>
      </div>
    </Modal>
  );
}
