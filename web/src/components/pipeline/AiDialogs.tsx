"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import {
  abstractSteps,
  AGG_FNS,
  applySteps,
  FILTER_OPS,
  columnsUsed,
  STEPS,
  uid,
  type Column,
  type ColType,
  type CustomFunction,
  type CustomTransform,
  type FunctionArg,
  type NodeResult,
  type Step,
} from "@/lib/pipeline";
import { aiText } from "@/lib/services";
import { Icon } from "../Icon";
import { DataPreview } from "./DataPreview";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field } from "./ui";

/** Explain: a written summary of nodes' logic, from an LLM when one is configured, else from the pipeline itself. */
export function AiExplainDialog({ title, fallback, onClose }: { title: string; fallback: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    aiText<string>(
      `Explain this data pipeline logic to a business user in a short paragraph followed by bullet points. Mention what the data looks like at the end.\n\n${fallback}`,
      { system: "You explain data pipelines built in a visual pipeline builder. Be concise and concrete. Use Markdown." },
    ).then(
      (t) => live && setText(t),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [fallback]);
  return (
    <Modal title={`Explain — ${title}`} icon="bolt" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        {text ? (
          <div className="md-body text-sm text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        ) : error ? (
          <>
            <p className="text-xs text-muted">The AI explanation is unavailable ({error.slice(0, 160)}). Summary from the pipeline:</p>
            <div className="md-body text-sm text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(fallback) }} />
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Icon name="refresh" className="h-4 w-4 animate-spin text-ocean" /> Writing a summary…
          </p>
        )}
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Logic as configured</summary>
          <div className="md-body mt-2" dangerouslySetInnerHTML={{ __html: renderMarkdown(fallback) }} />
        </details>
      </div>
    </Modal>
  );
}

/** The transforms an LLM may use, described compactly. */
export const CATALOG = STEPS.filter((s) => s.kind !== "sql")
  .map((s) => `${s.kind}: ${s.label} — fields ${s.fields.map((f) => `${f.key}(${f.kind}${f.options ? `: ${f.options.slice(0, 8).join("|")}` : ""})`).join(", ")}${s.output ? ", output(text)" : ""}`)
  .join("\n");

/** How params are written for the catalog's boards (shared by Generate and AIP Assist). */
export const PARAMS_HINT =
  'column fields hold a column name, columns/expressions fields hold arrays of column names, select fields one of the listed options, boolean fields "true" or "". ' +
  `filter: {"mode":"Keep rows"|"Remove rows","filter":{"id":"root","match":"all"|"any","items":[{"id":"c1","left":{"kind":"column","column":"<col>"},"op":"<op>","right":{"kind":"value","type":"Double"|"Integer"|"String"|"Date"|"Boolean","value":"<text>"}}]}} with op one of ${FILTER_OPS.map((o) => `"${o}"`).join(", ")}. ` +
  'sort: {"sort":[{"column":"<col>","direction":"asc"|"desc"}]}. ' +
  `aggregate: {"groupBy":["<col>"],"grouping":"Group by","aggs":[{"id":"a1","fn":${AGG_FNS.map((f) => `"${f}"`).join("|")},"column":"<col>","output":"<name>"}]}.`;

/** LLM-proposed boards → steps: nested objects in params are stored as JSON strings, as the boards keep them. */
export function toSteps(raw: { kind: string; params?: unknown; params_json?: string }[]): Step[] {
  return raw.map((s) => {
    let params: Record<string, string | string[]> = {};
    try {
      params = (s.params_json !== undefined ? JSON.parse(s.params_json) : (s.params ?? {})) as Record<string, string | string[]>;
      for (const [k, v] of Object.entries(params)) {
        // objects, and lists of objects (sort keys, aggregations), are stored as JSON text; lists of names stay lists
        if (v !== null && typeof v === "object" && (!Array.isArray(v) || v.some((x) => x !== null && typeof x === "object"))) params[k] = JSON.stringify(v);
        else if (typeof v === "number" || typeof v === "boolean") params[k] = v === true ? "true" : v === false ? "" : String(v);
      }
    } catch {}
    return { id: uid(), kind: s.kind, params };
  });
}

/** Generate: describe a node, an LLM proposes transform boards; they are checked against the input before you add them. */
export function AiGenerateDialog({
  input,
  inputName,
  functions,
  onCreate,
  onClose,
}: {
  input: NodeResult;
  inputName: string;
  functions?: CustomFunction[];
  onCreate: (name: string, steps: Step[]) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; steps: Step[] } | null>(null);
  const t = input.table;
  const outcome = useMemo(() => (draft && t ? applySteps(t, draft.steps, { names: () => [], table: () => undefined, functions }) : null), [draft, t, functions]);

  const generate = async () => {
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const schema = t.columns.map((c) => `${c.name}: ${c.type}`).join(", ");
      const sample = JSON.stringify(t.rows.slice(0, 5));
      const res = await aiText<{ name: string; steps: { kind: string; params_json: string }[] }>(
        `Input table "${inputName}" with columns: ${schema}\nSample rows: ${sample}\n\nTask: ${prompt}\n\nAvailable transforms (kind: label — fields):\n${CATALOG}\n\nReturn the transforms to apply in order. params_json is a JSON object of the fields: ${PARAMS_HINT}`,
        {
          system: "You build data pipelines from transform boards. Use only the transforms listed, with exact field keys.",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              steps: { type: "array", items: { type: "object", properties: { kind: { type: "string" }, params_json: { type: "string" } }, required: ["kind", "params_json"] } },
            },
            required: ["name", "steps"],
          },
          temperature: 0,
        },
      );
      const steps = toSteps(res.steps ?? []);
      setDraft({ name: res.name || "Generated transform", steps });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Generate a node after "${inputName}"`} icon="bolt" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <Field label="Describe the transform" hint="e.g. keep orders over 1000, add a column with the year of order_date, and sort by amount descending">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className={inputClass} autoFocus />
        </Field>
        <div className="flex justify-end">
          <button type="button" disabled={!prompt.trim() || busy || !t} onClick={generate} className={buttonClass.primary}>
            <Icon name={busy ? "refresh" : "bolt"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Generating…" : "Generate"}
          </button>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {draft && (
          <div className="space-y-2">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} aria-label="Node name" />
            <ol className="space-y-1 text-xs">
              {draft.steps.map((s, i) => {
                const def = STEPS.find((d) => d.kind === s.kind);
                return (
                  <li key={s.id} className={`rounded border px-2 py-1 ${outcome?.error !== undefined && outcome.step === i ? "border-bad/60 text-bad" : "border-line-2 text-soft"}`}>
                    {i + 1}. {def?.label ?? `Unknown "${s.kind}"`} — <span className="font-mono">{def?.summary(s.params) ?? JSON.stringify(s.params)}</span>
                  </li>
                );
              })}
            </ol>
            {outcome?.error !== undefined && <p className="text-xs text-bad">Board {outcome.step + 1}: {outcome.error}. Edit it after adding, or generate again.</p>}
            {outcome && (
              <div className="flex h-56 flex-col rounded-md border border-line">
                <DataPreview table={outcome.table} title="Preview" />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={buttonClass.secondary}>
                Cancel
              </button>
              <button type="button" disabled={!draft.steps.length} onClick={() => onCreate(draft.name.trim() || "Generated transform", draft.steps)} className={buttonClass.primary}>
                Add node
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The AIP regex helper: describe a pattern, get a regular expression tested on the column's values. */
export function RegexHelper({ samples, onPattern }: { samples: string[]; onPattern: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ pattern: string; explanation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  let re: RegExp | null = null;
  try {
    re = res ? new RegExp(res.pattern) : null;
  } catch {}
  return (
    <div className="relative shrink-0" ref={box}>
      <button type="button" title="Generate the regex with AI" onClick={() => setOpen(!open)} className="rounded-md border border-violet-400/40 bg-violet-400/10 p-1.5 text-violet-300 hover:bg-violet-400/20">
        <Icon name="star" className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-96 space-y-2 rounded-lg border border-line-2 bg-panel-2 p-3 text-xs shadow-xl">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="e.g. the 5-digit postal code at the end" className={`${inputClass} text-xs`} autoFocus />
          <button
            type="button"
            disabled={!prompt.trim() || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setRes(
                  await aiText(`Write a JavaScript-compatible regular expression (no slashes, no flags) for: ${prompt}\nExample values:\n${samples.join("\n")}`, {
                    system: "You write precise regular expressions. Use a capturing group for the part to extract when extracting.",
                    schema: { type: "object", properties: { pattern: { type: "string" }, explanation: { type: "string" } }, required: ["pattern", "explanation"] },
                    temperature: 0,
                  }),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className={buttonClass.primary}
          >
            {busy ? "Generating…" : "Generate"}
          </button>
          {error && <p className="text-bad">{error}</p>}
          {res && (
            <>
              <code className="block break-all rounded bg-ink px-2 py-1 font-mono text-ocean">{res.pattern}</code>
              <p className="text-muted">{res.explanation}</p>
              {re && samples.length > 0 && (
                <ul className="max-h-32 space-y-0.5 overflow-y-auto">
                  {samples.map((s, i) => {
                    const m = re!.exec(s);
                    return (
                      <li key={i} className="flex gap-2">
                        <span className="min-w-0 flex-1 truncate text-soft">{s}</span>
                        <span className={m ? "text-ok" : "text-muted"}>{m ? (m[1] ?? m[0]) : "no match"}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <button
                type="button"
                onClick={() => {
                  onPattern(res.pattern);
                  setOpen(false);
                }}
                className={buttonClass.secondary}
              >
                Apply
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Turns selected boards into a custom transform: the columns they read become typed arguments. */
export function CreateFunctionDialog({
  steps,
  columns,
  onCreate,
  onClose,
}: {
  steps: Step[];
  /** the input columns of the first selected board */
  columns: Column[];
  onCreate: (fn: CustomTransform, binding: Record<string, string>) => void;
  onClose: () => void;
}) {
  const used = useMemo(() => columnsUsed(steps, columns), [steps, columns]);
  const [args, setArgs] = useState<{ column: string; arg: FunctionArg }[]>(() => used.map((c) => ({ column: c.name, arg: { id: uid(), name: c.name, type: c.type } })));
  const [name, setName] = useState("Custom transform");
  const [description, setDescription] = useState("");
  return (
    <Modal title="New custom function" icon="transform" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted">
          {steps.length} board{steps.length === 1 ? "" : "s"} become one reusable transform. The columns they read are crossed out below: the function works on any columns of
          the right types, passed as arguments.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Arguments</div>
          <ul className="space-y-1">
            {args.map((a, i) => (
              <li key={a.arg.id} className="flex items-center gap-2 text-xs">
                <span className="w-36 truncate font-mono text-muted line-through" title={`Column ${a.column}`}>
                  {a.column}
                </span>
                <Icon name="right" className="h-3 w-3 text-muted" />
                <input
                  value={a.arg.name}
                  onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, arg: { ...x.arg, name: e.target.value } } : x)))}
                  className={`${inputClass} w-40 border-sand/50 bg-sand/10 py-1 font-mono text-xs`}
                />
                <span className="text-muted">Expression&lt;</span>
                <select
                  value={a.arg.type}
                  onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, arg: { ...x.arg, type: e.target.value as ColType | "Any" } } : x)))}
                  className={`${inputClass} w-28 py-1 text-xs`}
                >
                  {["Any", ...new Set(columns.map((c) => c.type)), "String", "Integer", "Long", "Double", "Date", "Timestamp", "Boolean"]
                    .filter((v, k, arr) => arr.indexOf(v) === k)
                    .map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                </select>
                <span className="text-muted">&gt;</span>
                <button type="button" title="Keep this column fixed (not an argument)" onClick={() => setArgs(args.filter((_, j) => j !== i))} className="rounded p-0.5 text-muted hover:text-bad">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </li>
            ))}
            {!args.length && <li className="text-xs text-muted">The boards read no columns; the function takes no arguments.</li>}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || args.some((a) => !a.arg.name.trim())}
            onClick={() =>
              onCreate(
                { id: uid(), kind: "transform", name: name.trim(), description: description.trim() || undefined, args: args.map((a) => a.arg), steps: abstractSteps(steps, args) },
                Object.fromEntries(args.map((a) => [a.arg.id, a.column])),
              )
            }
            className={buttonClass.primary}
          >
            Apply all changes
          </button>
        </div>
      </div>
    </Modal>
  );
}
