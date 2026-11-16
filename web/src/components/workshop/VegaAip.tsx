"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { inputClass } from "@/components/pipeline/Modal";
import { resolveVar, workshop, type Column, type Module, type QueryResult, type VegaInput, type VegaInputSchema, type VegaSpecCheck, type Widget, type WidgetConfig } from "@/lib/workshop";
import { vegaInputRows, vegaParamType, vegaSpec } from "./VizWidgets";

/**
 * The Vega chart's AIP spec generator (Foundry's inline editor: "Make me a bar chart of …", then further prompts to
 * iterate). What the model sees is each data input's name and fields with their types — never rows. The answer is
 * checked on the server (JSON, a Vega-Lite mark, fields that exist, no url data / links / external addresses); only a
 * checked spec is previewed (with the widget's data) and can be accepted into the widget. The candidate can be edited
 * and checked again before it is accepted.
 */

/** The inputs as the generator sees them: names, fields and types (no rows). */
export function vegaInputSchemas(inputs: VegaInput[], cols: Column[], variables: Module["variables"]): VegaInputSchema[] {
  const typeOf = (n?: string) => cols.find((x) => x.name === n)?.type ?? "string";
  return inputs.map((i) => {
    if (i.kind === "objects") return { name: i.name, kind: i.kind, fields: [...(i.columns ?? []).map((n) => ({ name: n, type: typeOf(n) })), { name: "__pk", type: "string (primary key)" }] };
    if (i.kind === "aggregation") {
      const g = i.group_by ?? "key";
      const m = i.metric ?? "count";
      const gType = i.bucket ? `string (${i.bucket} bucket of a date: ${i.bucket === "year" ? "yyyy" : i.bucket === "month" ? "yyyy-mm" : "yyyy-mm-dd"})` : typeOf(i.group_by);
      const fields = [{ name: g, type: gType }, { name: m, type: m === "distinct" || m === "count" ? "integer" : "double" }];
      if (m !== "count") fields.push({ name: "count", type: "integer" });
      return { name: i.name, kind: i.kind, fields };
    }
    // a struct array variable: the fields of its default value's first struct
    const v = (variables ?? []).find((x) => x.name === i.variable)?.default;
    const first = Array.isArray(v) ? v.find((x) => x && typeof x === "object") : null;
    const kind = (x: unknown) => (typeof x === "number" ? "double" : typeof x === "boolean" ? "boolean" : "string");
    return { name: i.name, kind: i.kind, fields: first ? Object.entries(first as Record<string, unknown>).map(([n, x]) => ({ name: n, type: kind(x) })) : [] };
  });
}

/** Selection parameters a spec defines (top level, layers, concatenations). */
function specParams(spec: unknown, out: string[] = []): string[] {
  if (!spec || typeof spec !== "object") return out;
  const s = spec as Record<string, unknown>;
  for (const p of Array.isArray(s.params) ? (s.params as Record<string, unknown>[]) : []) if (p?.select && typeof p.name === "string" && !out.includes(p.name)) out.push(p.name);
  for (const k of ["layer", "vconcat", "hconcat", "concat", "spec"]) for (const x of Array.isArray(s[k]) ? (s[k] as unknown[]) : s[k] ? [s[k]] : []) specParams(x, out);
  return out;
}

/** The widget's data for the preview: its source with its own filters ($var: from the variables' defaults), 500 rows. */
function usePreviewData(c: WidgetConfig, mod: Module, on: boolean) {
  const [data, setData] = useState<Record<string, unknown[]> | null>(null);
  const defaults = useMemo(() => Object.fromEntries((mod.variables ?? []).map((v) => [v.name, v.default])), [mod.variables]);
  const key = JSON.stringify([on, c.source, c.filters, c.vega_inputs]);
  useEffect(() => {
    if (!on) return;
    let stale = false;
    const inputs = c.vega_inputs ?? [];
    const filters = (c.filters ?? []).map((f) => ({ ...f, value: resolveVar(f.value, defaults) }));
    Promise.all(
      inputs.map((i): Promise<QueryResult | null> => {
        if (!c.source || i.kind === "variable") return Promise.resolve(null);
        if (i.kind === "objects") return workshop.query({ source: c.source, filters, columns: i.columns ?? [], limit: 500 });
        return workshop.query({ source: c.source, filters, group_by: i.group_by, bucket: i.bucket, metric: i.metric ?? "count", metric_column: i.metric_column, limit: 500 });
      }),
    )
      .then((rs) => !stale && setData(Object.fromEntries(inputs.map((i, k) => [i.name, vegaInputRows(i, rs[k], defaults)]))))
      .catch(() => !stale && setData({}));
    return () => {
      stale = true;
    };
    // key holds the source, filters and inputs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, defaults]);
  return data;
}

type Result = VegaSpecCheck & { attempts?: number; model?: string };

export function VegaAipGenerator({ widget, set, mod, cols }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[] }) {
  const c = widget.config;
  const mode = c.vega_mode ?? "vega-lite";
  const inputs = useMemo(() => c.vega_inputs ?? [], [c.vega_inputs]);
  const schemas = useMemo(() => vegaInputSchemas(inputs, cols, mod.variables), [inputs, cols, mod.variables]);
  const params = useMemo(() => (c.vega_params ?? []).map((p) => p.name).filter(Boolean), [c.vega_params]);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [iterate, setIterate] = useState(true);
  const [busy, setBusy] = useState<"" | "generate" | "check">("");
  const [error, setError] = useState<string | null>(null);
  // the candidate: its text (editable), the last check of that text, whether the text changed since
  const [text, setText] = useState<string | null>(null);
  const [check, setCheck] = useState<Result | null>(null);
  const [dirty, setDirty] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const current = (text ?? c.spec ?? "").trim();
  const data = usePreviewData(c, mod, open && !!check?.ok);
  const ref = useRef<HTMLDivElement>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // the preview renders only a spec the server checked (no url data, no links), never unchecked text
  const shown = check?.ok && !dirty ? check.spec : null;
  const previewKey = JSON.stringify([shown, data, mode, c.vega_theme]);
  useEffect(() => {
    if (!shown || !data || !ref.current) return;
    let cancelled = false;
    let view: { finalize: () => void } | null = null;
    (async () => {
      try {
        const spec = vegaSpec(c, JSON.stringify(shown), data);
        const { default: embed } = await import("vega-embed");
        if (cancelled || !ref.current) return;
        const r = await embed(ref.current, spec as never, { actions: false, renderer: "svg", mode: mode === "vega" ? "vega" : "vega-lite" });
        view = r.view;
        setPreviewErr(null);
      } catch (e) {
        if (!cancelled) setPreviewErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      view?.finalize();
    };
    // previewKey holds the checked spec, the data and the settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const generate = async () => {
    if (!prompt.trim()) return;
    setBusy("generate");
    setError(null);
    setAccepted(false);
    try {
      const r = await workshop.vegaGenerate({ prompt: prompt.trim(), mode, inputs: schemas, params, current_spec: iterate && current ? current : undefined });
      setText(r.text);
      setCheck(r);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const recheck = async (): Promise<Result | null> => {
    if (text === null) return null;
    setBusy("check");
    setError(null);
    try {
      const r = await workshop.vegaValidate({ spec: text, mode, inputs: schemas, params });
      setCheck(r);
      setDirty(false);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  };
  const accept = async () => {
    const r = dirty ? await recheck() : check;
    if (!r?.ok || !r.spec) return;
    set({ spec: JSON.stringify(r.spec, null, 2), spec_variable: undefined });
    setText(null);
    setCheck(null);
    setAccepted(true);
  };
  const discard = () => {
    setText(null);
    setCheck(null);
    setDirty(false);
    setError(null);
  };
  const defined = shown ? specParams(shown) : [];
  const unconfigured = defined.filter((p) => !params.includes(p));

  return (
    <div className="rounded border border-line" data-vega-aip>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs" data-vega-aip-toggle>
        <Icon name="sparkle" className="h-3.5 w-3.5 text-ocean" />
        <span className="flex-1 font-medium">Generate the spec with AIP</span>
        <span className="text-muted">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line p-2 text-xs">
          {!inputs.length ? (
            <p className="text-muted">Add a data input first: AIP writes the spec for the widget&apos;s inputs.</p>
          ) : (
            <>
              <details className="text-[11px] text-muted" data-vega-aip-context>
                <summary className="cursor-pointer">Sent to the model: the prompt and each input&apos;s fields with their types (no rows)</summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {schemas.map((s) => (
                    <li key={s.name}>
                      {s.name} ({s.kind}): {s.fields.map((f) => `${f.name} · ${f.type}`).join(", ") || "fields unknown"}
                    </li>
                  ))}
                </ul>
              </details>
              <textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void generate();
                }}
                placeholder={current ? "Remove the gridlines and only show categories with more than 10 claims" : "Make me a bar chart of claims per risk category, sorted by count"}
                className={`${inputClass} text-xs`}
                data-vega-aip-prompt
              />
              <div className="flex items-center gap-2">
                {current && (
                  <label className="flex flex-1 items-center gap-1 text-[11px] text-muted">
                    <input type="checkbox" checked={iterate} onChange={(e) => setIterate(e.target.checked)} data-vega-aip-iterate /> Change the {text !== null ? "candidate" : "current spec"}
                  </label>
                )}
                <button type="button" disabled={!prompt.trim() || !!busy} onClick={() => void generate()} className="ml-auto rounded bg-ocean px-2 py-1 text-white disabled:opacity-50" data-vega-aip-generate>
                  {busy === "generate" ? "Generating…" : "Generate"}
                </button>
              </div>
            </>
          )}
          {error && <p className="rounded bg-bad/10 p-1.5 text-bad" data-vega-aip-error>{error}</p>}
          {accepted && <p className="text-ok" data-vega-aip-accepted>Accepted into the widget&apos;s spec.</p>}
          {text !== null && (
            <div className="space-y-2" data-vega-aip-result>
              {!!check?.errors.length && (
                <ul className="space-y-0.5 rounded bg-bad/10 p-1.5 text-bad" data-vega-aip-errors>
                  {check.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              {!!check?.warnings.length && (
                <ul className="space-y-0.5 rounded bg-warn/10 p-1.5 text-warn" data-vega-aip-warnings>
                  {check.warnings.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              <textarea
                rows={10}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                }}
                spellCheck={false}
                className={`${inputClass} font-mono text-[11px]`}
                data-vega-aip-candidate
              />
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[11px] text-muted" data-vega-aip-status>
                  {dirty ? "Edited: check it to preview" : check?.ok ? `Checked${check.attempts && check.attempts > 1 ? " (corrected once)" : ""}` : "Not acceptable as it is: edit it or prompt again"}
                </span>
                <button type="button" disabled={!!busy || !dirty} onClick={() => void recheck()} className="rounded border border-line-2 px-2 py-1 disabled:opacity-50" data-vega-aip-check>
                  {busy === "check" ? "Checking…" : "Check"}
                </button>
                <button type="button" onClick={discard} className="rounded border border-line-2 px-2 py-1" data-vega-aip-discard>
                  Discard
                </button>
                <button type="button" disabled={!!busy || (!dirty && !check?.ok)} onClick={() => void accept()} className="rounded bg-ocean px-2 py-1 text-white disabled:opacity-50" data-vega-aip-accept>
                  Accept
                </button>
              </div>
              {shown && (
                <div className="rounded border border-line" data-vega-aip-preview-box>
                  <p className="border-b border-line px-2 py-1 text-[11px] text-muted">Preview with the widget&apos;s data (its own filters; 500 rows per input)</p>
                  {previewErr && <p className="m-1 rounded bg-bad/10 p-1 text-bad">{previewErr}</p>}
                  {!data && <p className="p-2 text-muted">Loading data…</p>}
                  <div ref={ref} className="max-h-72 overflow-auto p-1" data-vega-aip-preview />
                </div>
              )}
              {shown && unconfigured.length > 0 && (
                <div className="text-[11px] text-muted" data-vega-aip-params>
                  Selections in the spec not yet linked to a variable:{" "}
                  {unconfigured.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => set({ vega_params: [...(c.vega_params ?? []), { name: p, variable: "" }] })}
                      className="mr-1 rounded border border-line-2 px-1 font-mono text-ocean"
                      title={`Add "${p}" (${vegaParamType(shown, p) ?? "point"}) under Selection parameters, then choose its variable`}
                    >
                      + {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
