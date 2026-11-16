"use client";

/** The Slate editor's panels: Queries, Functions, Platform (object sets, object context, Foundry functions),
 *  Variables, Events, Styles, Dependency graph and Console. */
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import type { FunctionRow } from "@/lib/actions";
import { freshName, SLATE_WIDGETS, type SlateDocument, type SlateSource } from "@/lib/slate";
import { dependencies, render, type Scope } from "@/lib/slateHandlebars";
import { dependencyGraph, type SlateRuntime } from "@/lib/slateRuntime";
import type { ObjectTypeSource } from "@/lib/workshop";

export type Panel = "queries" | "functions" | "platform" | "variables" | "events" | "styles" | "graph" | "console";
export const PANELS: [Panel, string][] = [
  ["queries", "Queries"],
  ["functions", "Functions"],
  ["platform", "Platform"],
  ["variables", "Variables"],
  ["events", "Events"],
  ["styles", "Styles"],
  ["graph", "Dependencies"],
  ["console", "Console"],
];

type Ctx = {
  doc: SlateDocument;
  update: (fn: (d: SlateDocument) => SlateDocument) => void;
  rt: SlateRuntime;
  scope: Scope;
  sources: SlateSource[];
  objectTypes: ObjectTypeSource[];
  foundryFunctions: FunctionRow[];
  names: string[];
  publicApp: boolean;
};

const input = "w-full rounded border border-line-2 bg-ink px-2 py-1 text-xs outline-none focus:border-ocean";
const code = `${input} font-mono`;
const short = (v: unknown) => {
  try {
    const s = JSON.stringify(v, null, 1);
    return s === undefined ? "undefined" : s.length > 3000 ? s.slice(0, 3000) + "…" : s;
  } catch {
    return String(v);
  }
};

function List<T extends { name: string }>({ items, selected, onSelect, onAdd, onDelete, label }: { items: T[]; selected: string | null; onSelect: (n: string) => void; onAdd: () => void; onDelete: (n: string) => void; label: string }) {
  return (
    <div className="w-44 shrink-0 overflow-auto border-r border-line pr-2">
      <button type="button" onClick={onAdd} className="mb-1 flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs text-ocean hover:bg-panel-2">
        <Icon name="plus" className="h-3 w-3" /> New {label}
      </button>
      {items.map((x) => (
        <div key={x.name} className={`group flex items-center rounded px-2 py-1 text-xs ${selected === x.name ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
          <button type="button" onClick={() => onSelect(x.name)} className="flex-1 truncate text-left font-mono">
            {x.name}
          </button>
          <button type="button" onClick={() => onDelete(x.name)} className="hidden text-muted hover:text-bad group-hover:block" aria-label={`Delete ${x.name}`}>
            <Icon name="trash" className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Status({ ctx, name }: { ctx: Ctx; name: string }) {
  const st = ctx.rt.status[name];
  if (!st) return <span className="text-muted">not run</span>;
  if (st.running) return <span className="text-ocean">running…</span>;
  return st.success ? <span className="text-ok">ran in {st.ms} ms</span> : <span className="text-bad">{st.message}</span>;
}

function Rename({ ctx, name, onRename }: { ctx: Ctx; name: string; onRename: (n: string) => void }) {
  const [v, setV] = useState(name);
  const bad = v !== name && (ctx.names.includes(v) || !/^[A-Za-z_$][\w$]*$/.test(v));
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => (!bad && v !== name ? onRename(v) : setV(name))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`${code} w-56 ${bad ? "border-bad" : ""}`}
      title={bad ? "Names are unique identifiers across the application" : undefined}
    />
  );
}

export function SlatePanel({ panel, ctx }: { panel: Panel; ctx: Ctx }) {
  switch (panel) {
    case "queries":
      return <Queries ctx={ctx} />;
    case "functions":
      return <Functions ctx={ctx} />;
    case "platform":
      return <Platform ctx={ctx} />;
    case "variables":
      return <Variables ctx={ctx} />;
    case "events":
      return <Events ctx={ctx} />;
    case "styles":
      return (
        <div className="flex h-full flex-col gap-1">
          <span className="text-[11px] text-muted">The global stylesheet: applies to the whole application (widgets carry their classes and inline CSS in their Layout tab).</span>
          <textarea value={ctx.doc.styles.css} onChange={(e) => ctx.update((d) => ({ ...d, styles: { ...d.styles, css: e.target.value } }))} className={`${code} flex-1`} spellCheck={false} placeholder=".slate-app .big { font-size: 20px; }" />
        </div>
      );
    case "graph":
      return <Graph ctx={ctx} />;
    case "console":
      return <Console ctx={ctx} />;
  }
}

const DEFAULT_SQL = "SELECT * FROM `/path/to/dataset` LIMIT 100";

function Queries({ ctx }: { ctx: Ctx }) {
  const [sel, setSel] = useState<string | null>(ctx.doc.queries[0]?.name ?? null);
  const q = ctx.doc.queries.find((x) => x.name === sel);
  const set = (patch: Partial<SlateDocument["queries"][number]>) => ctx.update((d) => ({ ...d, queries: d.queries.map((x) => (x.name === sel ? { ...x, ...patch } : x)) }));
  const kind = q ? (q.source === "foundry" ? "sql" : q.source === "api-gateway" ? "api" : q.source === "secure-upload" ? "upload" : "http") : "sql";
  const sources = ctx.publicApp ? [{ id: "secure-upload", name: "secure-upload (public uploads)", kind: "http_json" as const }] : [...ctx.sources];
  let preview = "";
  try {
    preview = q ? String(render(q.template, ctx.scope, kind === "sql" ? "sql" : "text")) : "";
  } catch (e) {
    preview = `⚠ ${(e as Error).message}`;
  }
  return (
    <div className="flex h-full gap-3">
      <List
        label="query"
        items={ctx.doc.queries}
        selected={sel}
        onSelect={setSel}
        onAdd={() => {
          const name = freshName("q_query", ctx.names);
          ctx.update((d) => ({ ...d, queries: [...d.queries, { name, source: ctx.publicApp ? "secure-upload" : "foundry", template: ctx.publicApp ? '{\n  "token": "slup_…",\n  "data": {{jsonStringify w_input1}}\n}' : DEFAULT_SQL, run: ctx.publicApp ? "manual" : "auto" }] }));
          setSel(name);
        }}
        onDelete={(n) => ctx.update((d) => ({ ...d, queries: d.queries.filter((x) => x.name !== n) }))}
      />
      {q ? (
        <div className="flex min-w-0 flex-1 gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Rename ctx={ctx} name={q.name} onRename={(n) => (ctx.update((d) => ({ ...d, queries: d.queries.map((x) => (x.name === q.name ? { ...x, name: n } : x)) })), setSel(n))} />
              <select value={q.source} onChange={(e) => set({ source: e.target.value, template: e.target.value === "foundry" ? DEFAULT_SQL : e.target.value === "api-gateway" ? '{\n  "method": "GET",\n  "path": "/api/ontology/object-types"\n}' : '{\n  "path": "/",\n  "method": "GET",\n  "queryParams": {},\n  "extractors": { "result": "$" }\n}' })} className={`${input} w-56`}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-muted">
                <input type="checkbox" checked={q.run === "manual"} onChange={(e) => set({ run: e.target.checked ? "manual" : "auto" })} /> Run manually only
              </label>
              <button type="button" onClick={() => (ctx.rt.invalidate(q.name), void ctx.rt.runQuery(q.name))} className="ml-auto rounded bg-ocean px-2.5 py-1 font-medium text-white">
                Test
              </button>
            </div>
            <textarea value={q.template} onChange={(e) => set({ template: e.target.value })} className={`${code} min-h-0 flex-1`} spellCheck={false} />
            <p className="text-[11px] text-muted">
              {kind === "sql" && "Read-only SQL over datasets you can read (backticked paths or dataset ids). Template values with {{param x}}, names with {{column x}} / {{table x 'allowed'}}."}
              {kind === "http" && "HTTP JSON: {path, method, queryParams, bodyJson, headers, extractors}. Every {{…}} must be wrapped in {{jsonStringify …}}; the source applies its credentials and egress policy."}
              {kind === "api" && "API Gateway: {method, path: \"/api/…\", body}, with your permissions."}
              {kind === "upload" && "Secure upload: {token, data} — tokens come from Settings → Secure upload."}
            </p>
          </div>
          <div className="flex w-[40%] min-w-0 flex-col gap-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-muted">Result</span>
              <Status ctx={ctx} name={q.name} />
            </div>
            <pre className="min-h-0 flex-1 overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{short(ctx.rt.results[q.name])}</pre>
            <details>
              <summary className="cursor-pointer text-muted">Preview rendered query</summary>
              <pre className="max-h-32 overflow-auto rounded bg-ink p-2 font-mono text-[10px]">{preview}</pre>
            </details>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">Queries read from data sources: Foundry datasets (SQL), this platform&apos;s API, and Data Connection REST API sources added in Settings.</p>
      )}
    </div>
  );
}

function Functions({ ctx }: { ctx: Ctx }) {
  const [sel, setSel] = useState<string | null>(ctx.doc.functions[0]?.name ?? "__library");
  const f = ctx.doc.functions.find((x) => x.name === sel);
  const set = (patch: Partial<SlateDocument["functions"][number]>) => ctx.update((d) => ({ ...d, functions: d.functions.map((x) => (x.name === sel ? { ...x, ...patch } : x)) }));
  return (
    <div className="flex h-full gap-3">
      <div className="flex flex-col">
        <button type="button" onClick={() => setSel("__library")} className={`mb-1 rounded px-2 py-1 text-left text-xs ${sel === "__library" ? "bg-ocean/15 text-white" : "text-muted hover:bg-panel-2"}`}>
          Function library
        </button>
        <List
          label="function"
          items={ctx.doc.functions}
          selected={sel}
          onSelect={setSel}
          onAdd={() => {
            const name = freshName("f_function", ctx.names);
            ctx.update((d) => ({ ...d, functions: [...d.functions, { name, code: "// {{handlebars}} become JSON values\nreturn 1 + 1;", run: "auto" }] }));
            setSel(name);
          }}
          onDelete={(n) => ctx.update((d) => ({ ...d, functions: d.functions.filter((x) => x.name !== n) }))}
        />
      </div>
      {sel === "__library" ? (
        <div className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] text-muted">Reusable JavaScript (functions with parameters) available to every function and event. lodash (_), moment, numeral and math.js are loaded when used.</span>
          <textarea value={ctx.doc.library} onChange={(e) => ctx.update((d) => ({ ...d, library: e.target.value }))} className={`${code} flex-1`} spellCheck={false} placeholder={"function formatName(name, id) {\n  return name + ' (' + id + ')';\n}"} />
        </div>
      ) : f ? (
        <div className="flex min-w-0 flex-1 gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Rename ctx={ctx} name={f.name} onRename={(n) => (ctx.update((d) => ({ ...d, functions: d.functions.map((x) => (x.name === f.name ? { ...x, name: n } : x)) })), setSel(n))} />
              <label className="flex items-center gap-1 text-muted">
                <input type="checkbox" checked={f.run === "manual"} onChange={(e) => set({ run: e.target.checked ? "manual" : "auto" })} /> Run manually only
              </label>
              <span className="text-muted">reads {dependencies(f.code).join(", ") || "nothing"}</span>
              <button type="button" onClick={() => void ctx.rt.runFunction(f.name)} className="ml-auto rounded bg-ocean px-2.5 py-1 font-medium text-white">
                Run
              </button>
            </div>
            <textarea value={f.code} onChange={(e) => set({ code: e.target.value })} className={`${code} min-h-0 flex-1`} spellCheck={false} />
          </div>
          <div className="flex w-[35%] min-w-0 flex-col gap-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-muted">Return value</span>
              <Status ctx={ctx} name={f.name} />
            </div>
            <pre className="min-h-0 flex-1 overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{short(ctx.rt.results[f.name])}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null"] as const;

function Platform({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<"sets" | "contexts" | "functions">("sets");
  const [sel, setSel] = useState<string | null>(null);
  if (ctx.publicApp) return <p className="text-xs text-muted">Public applications cannot read objects, datasets, functions or actions.</p>;
  const tabs = (
    <div className="mb-2 flex gap-2 text-xs">
      {(
        [
          ["sets", "Object sets"],
          ["contexts", "Object context"],
          ["functions", "Foundry Functions"],
        ] as const
      ).map(([k, l]) => (
        <button key={k} type="button" onClick={() => (setTab(k), setSel(null))} className={`rounded px-2 py-0.5 ${tab === k ? "bg-ocean/15 text-white" : "text-muted"}`}>
          {l}
        </button>
      ))}
    </div>
  );
  if (tab === "sets") {
    const o = ctx.doc.objectSets.find((x) => x.name === sel);
    const props = ctx.objectTypes.find((t) => t.id === o?.object_type_id)?.properties ?? [];
    const set = (patch: Partial<SlateDocument["objectSets"][number]>) => ctx.update((d) => ({ ...d, objectSets: d.objectSets.map((x) => (x.name === sel ? { ...x, ...patch } : x)) }));
    return (
      <div className="flex h-full flex-col">
        {tabs}
        <div className="flex min-h-0 flex-1 gap-3">
          <List
            label="object set"
            items={ctx.doc.objectSets}
            selected={sel}
            onSelect={setSel}
            onAdd={() => {
              const name = freshName("s_object_set", ctx.names);
              ctx.update((d) => ({ ...d, objectSets: [...d.objectSets, { name, object_type_id: ctx.objectTypes[0]?.id ?? "", filters: [], filter_mode: "all", limit: 100, aggregations: [] }] }));
              setSel(name);
            }}
            onDelete={(n) => ctx.update((d) => ({ ...d, objectSets: d.objectSets.filter((x) => x.name !== n) }))}
          />
          {o ? (
            <div className="flex min-w-0 flex-1 gap-3 text-xs">
              <div className="min-w-0 flex-1 space-y-1.5 overflow-auto">
                <div className="flex items-center gap-2">
                  <Rename ctx={ctx} name={o.name} onRename={(n) => (ctx.update((d) => ({ ...d, objectSets: d.objectSets.map((x) => (x.name === o.name ? { ...x, name: n } : x)) })), setSel(n))} />
                  <select value={o.object_type_id} onChange={(e) => set({ object_type_id: e.target.value, filters: [], aggregations: [] })} className={`${input} w-52`}>
                    {ctx.objectTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <label className="text-muted">limit</label>
                  <input type="number" value={o.limit} onChange={(e) => set({ limit: Number(e.target.value) || 100 })} className={`${input} w-20`} />
                </div>
                <div className="flex items-center gap-2 text-muted">
                  Filters
                  <select value={o.filter_mode} onChange={(e) => set({ filter_mode: e.target.value as "all" | "any" })} className={`${input} w-28`}>
                    <option value="all">AND (all)</option>
                    <option value="any">OR (any)</option>
                  </select>
                  <button type="button" onClick={() => set({ filters: [...o.filters, { property: props[0]?.name ?? "", op: "eq", value: "" }] })} className="text-ocean">
                    + filter
                  </button>
                </div>
                {o.filters.map((f, i) => (
                  <div key={i} className="flex gap-1">
                    <select value={f.property} onChange={(e) => set({ filters: o.filters.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)) })} className={`${input} w-40`}>
                      {props.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <select value={f.op} onChange={(e) => set({ filters: o.filters.map((x, j) => (j === i ? { ...x, op: e.target.value as (typeof OPS)[number] } : x)) })} className={`${input} w-24`}>
                      {OPS.map((op) => (
                        <option key={op}>{op}</option>
                      ))}
                    </select>
                    <input value={f.value} onChange={(e) => set({ filters: o.filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder="value or {{w_dropdown.selectedValue}}" className={`${code} flex-1`} />
                    <button type="button" onClick={() => set({ filters: o.filters.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove filter">
                      <Icon name="x" className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2 text-muted">
                  Sort
                  <select value={o.sort?.property ?? ""} onChange={(e) => set({ sort: e.target.value ? { property: e.target.value, descending: o.sort?.descending ?? false } : undefined })} className={`${input} w-40`}>
                    <option value="">none</option>
                    {props.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {o.sort && (
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={o.sort.descending} onChange={(e) => set({ sort: { ...o.sort!, descending: e.target.checked } })} /> descending
                    </label>
                  )}
                </div>
                <div className="flex items-center gap-2 text-muted">
                  Aggregations
                  <button type="button" onClick={() => set({ aggregations: [...o.aggregations, { name: `agg${o.aggregations.length + 1}`, metric: "count" }] })} className="text-ocean">
                    + aggregation
                  </button>
                </div>
                {o.aggregations.map((a, i) => (
                  <div key={i} className="flex gap-1">
                    <input value={a.name} onChange={(e) => set({ aggregations: o.aggregations.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className={`${code} w-28`} />
                    <select value={a.metric} onChange={(e) => set({ aggregations: o.aggregations.map((x, j) => (j === i ? { ...x, metric: e.target.value as typeof a.metric } : x)) })} className={`${input} w-28`}>
                      {(["count", "avg", "sum", "max", "min", "distinct"] as const).map((m) => (
                        <option key={m} value={m}>
                          {m === "distinct" ? "cardinality" : m}
                        </option>
                      ))}
                    </select>
                    {a.metric !== "count" && (
                      <select value={a.property ?? ""} onChange={(e) => set({ aggregations: o.aggregations.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)) })} className={`${input} w-40`}>
                        <option value="">property…</option>
                        {props.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <button type="button" onClick={() => set({ aggregations: o.aggregations.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove aggregation">
                      <Icon name="x" className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <p className="text-[11px] text-muted">
                  Use as {`{{${o.name}.data.<property>}}`}, {`{{${o.name}.objectRids}}`}, {`{{${o.name}.aggregations.<name>}}`}; {`${o.name}.run`} re-runs it from an event.
                </p>
              </div>
              <div className="flex w-[38%] min-w-0 flex-col gap-1">
                <Status ctx={ctx} name={o.name} />
                <pre className="min-h-0 flex-1 overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{short(ctx.rt.results[o.name])}</pre>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">Object sets read an object type&apos;s objects with filters (Handlebars allowed), a sort, a limit and aggregations.</p>
          )}
        </div>
      </div>
    );
  }
  if (tab === "contexts") {
    const o = ctx.doc.objectContexts.find((x) => x.name === sel);
    const set = (patch: Partial<SlateDocument["objectContexts"][number]>) => ctx.update((d) => ({ ...d, objectContexts: d.objectContexts.map((x) => (x.name === sel ? { ...x, ...patch } : x)) }));
    return (
      <div className="flex h-full flex-col">
        {tabs}
        <div className="flex min-h-0 flex-1 gap-3">
          <List
            label="object context"
            items={ctx.doc.objectContexts}
            selected={sel}
            onSelect={setSel}
            onAdd={() => {
              const name = freshName("o_object_context", ctx.names);
              ctx.update((d) => ({ ...d, objectContexts: [...d.objectContexts, { name, object_type_id: ctx.objectTypes[0]?.id ?? "", pk: "" }] }));
              setSel(name);
            }}
            onDelete={(n) => ctx.update((d) => ({ ...d, objectContexts: d.objectContexts.filter((x) => x.name !== n) }))}
          />
          {o && (
            <div className="flex min-w-0 flex-1 gap-3 text-xs">
              <div className="flex-1 space-y-1.5">
                <Rename ctx={ctx} name={o.name} onRename={(n) => (ctx.update((d) => ({ ...d, objectContexts: d.objectContexts.map((x) => (x.name === o.name ? { ...x, name: n } : x)) })), setSel(n))} />
                <select value={o.object_type_id} onChange={(e) => set({ object_type_id: e.target.value })} className={input}>
                  {ctx.objectTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <input value={o.pk} onChange={(e) => set({ pk: e.target.value })} placeholder="primary key, or {{w_table.selectedRows.id.[0]}}" className={code} />
                <p className="text-[11px] text-muted">Then {`{{${o.name}.<property>}}`}, {`{{${o.name}.$title}}`}.</p>
              </div>
              <pre className="w-[40%] overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{short(ctx.rt.results[o.name])}</pre>
            </div>
          )}
        </div>
      </div>
    );
  }
  const f = ctx.doc.foundryFunctions.find((x) => x.name === sel);
  const fn = ctx.foundryFunctions.find((x) => x.id === f?.function_id);
  const set = (patch: Partial<SlateDocument["foundryFunctions"][number]>) => ctx.update((d) => ({ ...d, foundryFunctions: d.foundryFunctions.map((x) => (x.name === sel ? { ...x, ...patch } : x)) }));
  return (
    <div className="flex h-full flex-col">
      {tabs}
      <div className="flex min-h-0 flex-1 gap-3">
        <List
          label="Foundry function"
          items={ctx.doc.foundryFunctions}
          selected={sel}
          onSelect={setSel}
          onAdd={() => {
            const name = freshName("ff_function", ctx.names);
            ctx.update((d) => ({ ...d, foundryFunctions: [...d.foundryFunctions, { name, function_id: ctx.foundryFunctions[0]?.id ?? "", inputs: {}, run: "auto" }] }));
            setSel(name);
          }}
          onDelete={(n) => ctx.update((d) => ({ ...d, foundryFunctions: d.foundryFunctions.filter((x) => x.name !== n) }))}
        />
        {f && (
          <div className="flex min-w-0 flex-1 gap-3 text-xs">
            <div className="flex-1 space-y-1.5 overflow-auto">
              <div className="flex items-center gap-2">
                <Rename ctx={ctx} name={f.name} onRename={(n) => (ctx.update((d) => ({ ...d, foundryFunctions: d.foundryFunctions.map((x) => (x.name === f.name ? { ...x, name: n } : x)) })), setSel(n))} />
                <label className="flex items-center gap-1 text-muted">
                  <input type="checkbox" checked={f.run === "manual"} onChange={(e) => set({ run: e.target.checked ? "manual" : "auto" })} /> manual
                </label>
                <button type="button" onClick={() => void ctx.rt.runFoundryFunction(f.name)} className="ml-auto rounded bg-ocean px-2.5 py-1 font-medium text-white">
                  Run
                </button>
              </div>
              <select value={f.function_id} onChange={(e) => set({ function_id: e.target.value, inputs: {} })} className={input}>
                {ctx.foundryFunctions.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} {x.version ? `(${x.version})` : ""}
                  </option>
                ))}
              </select>
              {(fn?.inputs ?? []).map((inp) => (
                <label key={inp.name} className="block text-muted">
                  {inp.name} <span className="text-[10px]">{inp.type}</span>
                  <input value={f.inputs[inp.name] ?? ""} onChange={(e) => set({ inputs: { ...f.inputs, [inp.name]: e.target.value } })} className={`${code} mt-0.5`} />
                </label>
              ))}
            </div>
            <div className="flex w-[38%] flex-col gap-1">
              <Status ctx={ctx} name={f.name} />
              <pre className="min-h-0 flex-1 overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{short(ctx.rt.results[f.name])}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Variables({ ctx }: { ctx: Ctx }) {
  return (
    <div className="h-full overflow-auto text-xs">
      <table className="w-full">
        <thead className="text-left text-muted">
          <tr>
            <th className="px-2 py-1 font-normal">Scope</th>
            <th className="px-2 py-1 font-normal">Name</th>
            <th className="px-2 py-1 font-normal">Default value (JSON)</th>
            <th className="px-2 py-1 font-normal">Current value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ctx.doc.variables.map((v, i) => (
            <tr key={v.name} className="border-t border-line align-top">
              <td className="px-2 py-1">
                <select value={v.scope} onChange={(e) => ctx.update((d) => ({ ...d, variables: d.variables.map((x, j) => (j === i ? { ...x, scope: e.target.value } : x)) }))} className={`${input} w-28`}>
                  <option value="shared">shared</option>
                  {ctx.doc.pages.map((p) => (
                    <option key={p.id} value={p.name}>
                      local · {p.name}
                    </option>
                  ))}
                </select>
                {v.scope !== "shared" && (
                  <select
                    value={v.marketplace?.type ?? ""}
                    onChange={(e) => ctx.update((d) => ({ ...d, variables: d.variables.map((x, j) => (j === i ? { ...x, marketplace: e.target.value ? { type: e.target.value as "string" | "boolean" } : undefined } : x)) }))}
                    className={`${input} mt-1 w-28 ${v.marketplace ? "border-sand text-sand" : ""}`}
                    title="Marketplace parameter: asked when the packaged application is installed"
                    data-marketplace-param={v.name}
                  >
                    <option value="">not a parameter</option>
                    <option value="string">parameter: string</option>
                    <option value="boolean">parameter: boolean</option>
                  </select>
                )}
              </td>
              <td className="px-2 py-1">
                <Rename ctx={ctx} name={v.name} onRename={(n) => ctx.update((d) => ({ ...d, variables: d.variables.map((x, j) => (j === i ? { ...x, name: n } : x)) }))} />
              </td>
              <td className="px-2 py-1">
                <textarea rows={1} value={v.default} onChange={(e) => ctx.update((d) => ({ ...d, variables: d.variables.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)) }))} className={code} spellCheck={false} />
              </td>
              <td className="max-w-64 px-2 py-1">
                <pre className="max-h-16 overflow-auto font-mono text-[10px] text-soft">{short(ctx.rt.variables[v.name])}</pre>
              </td>
              <td className="px-2 py-1">
                <button type="button" onClick={() => ctx.rt.setVariable(v.name, (() => { try { return JSON.parse(v.default); } catch { return v.default; } })())} className="mr-2 text-ocean" title="Reset to the default">
                  reset
                </button>
                <button type="button" onClick={() => ctx.update((d) => ({ ...d, variables: d.variables.filter((_, j) => j !== i) }))} className="text-muted hover:text-bad" aria-label={`Delete ${v.name}`}>
                  <Icon name="trash" className="h-3 w-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => ctx.update((d) => ({ ...d, variables: [...d.variables, { name: freshName("v_variable", ctx.names), scope: "shared", default: '""' }] }))} className="mt-2 text-ocean">
        + Add new variable
      </button>
      <p className="mt-1 text-[11px] text-muted">Variables reset on reload; set them with VARIABLE.set from events or from the URL (?name=value). sl_user_storage persists per user (slate.setUserStorage).</p>
    </div>
  );
}

export function EventsEditor({ ctx, onlyFor }: { ctx: Ctx; onlyFor?: string }) {
  const cat = useMemo(() => ctx.rt.catalog((t) => SLATE_WIDGETS.find((w) => w.type === t) ?? { events: [], actions: [] }), [ctx.rt, ctx.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const events = ctx.doc.events.filter((e) => !onlyFor || e.trigger.startsWith(`${onlyFor}.`));
  return (
    <div className="h-full space-y-2 overflow-auto text-xs">
      {events.map((e) => (
        <div key={e.id} className="rounded border border-line p-2">
          <div className="flex items-center gap-2">
            <select value={e.trigger} onChange={(x) => ctx.update((d) => ({ ...d, events: d.events.map((y) => (y.id === e.id ? { ...y, trigger: x.target.value } : y)) }))} className={`${code} w-64`}>
              {[...new Set([e.trigger, ...cat.triggers])].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <span className="text-muted">→</span>
            <select value={e.action} onChange={(x) => ctx.update((d) => ({ ...d, events: d.events.map((y) => (y.id === e.id ? { ...y, action: x.target.value } : y)) }))} className={`${code} w-64`}>
              {[...new Set([e.action, ...cat.actions])].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <button type="button" onClick={() => ctx.update((d) => ({ ...d, events: d.events.filter((y) => y.id !== e.id) }))} className="ml-auto text-muted hover:text-bad" aria-label="Delete event">
              <Icon name="trash" className="h-3 w-3" />
            </button>
          </div>
          <textarea
            value={e.code}
            onChange={(x) => ctx.update((d) => ({ ...d, events: d.events.map((y) => (y.id === e.id ? { ...y, code: x.target.value } : y)) }))}
            rows={3}
            placeholder={"// optional: the value for the action; {{slEventValue}} is the event's value\n// return {{slDisableAction}} to skip the action"}
            className={`${code} mt-1.5`}
            spellCheck={false}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          ctx.update((d) => ({
            ...d,
            events: [...d.events, { id: `ev${Date.now().toString(36)}`, trigger: onlyFor ? cat.triggers.find((t) => t.startsWith(`${onlyFor}.`)) ?? `${onlyFor}.click` : "slate.ready", action: cat.actions[0] ?? "slate.print", code: "" }],
          }))
        }
        className="text-ocean"
      >
        + Add event
      </button>
    </div>
  );
}

function Events({ ctx }: { ctx: Ctx }) {
  return <EventsEditor ctx={ctx} />;
}

function Graph({ ctx }: { ctx: Ctx }) {
  const g = useMemo(() => dependencyGraph(ctx.doc), [ctx.doc]);
  const kinds = ["variable", "query", "object set", "object context", "Foundry function", "function", "widget"];
  const cols = kinds.map((k) => g.nodes.filter((n) => n.kind === k));
  const pos: Record<string, { x: number; y: number }> = {};
  cols.forEach((c, i) => c.forEach((n, j) => (pos[n.id] = { x: 20 + i * 150, y: 30 + j * 30 })));
  const h = Math.max(120, ...Object.values(pos).map((p) => p.y + 30));
  const [hover, setHover] = useState<string | null>(null);
  const related = (id: string) => g.edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id)) || id === hover;
  return (
    <div className="h-full overflow-auto">
      <svg width={kinds.length * 150 + 40} height={h} className="text-xs">
        {kinds.map((k, i) => (
          <text key={k} x={20 + i * 150} y={14} className="fill-current text-[10px] text-muted">
            {k}
          </text>
        ))}
        {g.edges.map((e, i) => {
          const a = pos[e.from];
          const b = pos[e.to];
          if (!a || !b) return null;
          return <line key={i} x1={a.x + 120} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" className={hover && (e.from === hover || e.to === hover) ? "text-ocean" : "text-line-2"} strokeWidth={hover && (e.from === hover || e.to === hover) ? 2 : 1} />;
        })}
        {g.nodes.map((n) => (
          <g key={n.id} transform={`translate(${pos[n.id].x},${pos[n.id].y - 10})`} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
            <rect width={120} height={20} rx={4} className={`${hover && related(n.id) ? "fill-ocean/30" : "fill-panel-2"} stroke-line-2`} />
            <text x={6} y={14} className="fill-current font-mono text-[10px]">
              {n.id.length > 17 ? n.id.slice(0, 16) + "…" : n.id}
            </text>
          </g>
        ))}
      </svg>
      {!g.nodes.length && <p className="text-xs text-muted">Nothing yet.</p>}
    </div>
  );
}

function Console({ ctx }: { ctx: Ctx }) {
  const [expr, setExpr] = useState("{{$global}}");
  let value: unknown;
  try {
    value = render(expr, ctx.scope, "value");
  } catch (e) {
    value = `⚠ ${(e as Error).message}`;
  }
  return (
    <div className="flex h-full gap-3 text-xs">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input value={expr} onChange={(e) => setExpr(e.target.value)} className={code} placeholder="{{any.handlebars}}" />
        <pre className="min-h-0 flex-1 overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{short(value)}</pre>
      </div>
      <div className="w-[45%] overflow-auto">
        {ctx.rt.log.map((l, i) => (
          <div key={i} className="flex gap-2 border-b border-line py-0.5 font-mono text-[10px]">
            <span className="text-muted">{new Date(l.at).toLocaleTimeString()}</span>
            <span className={l.kind === "error" ? "text-bad" : "text-ocean"}>{l.name}</span>
            <span className="truncate text-soft">{l.message}</span>
          </div>
        ))}
        {!ctx.rt.log.length && <p className="text-muted">Queries, functions and events log here.</p>}
      </div>
    </div>
  );
}
