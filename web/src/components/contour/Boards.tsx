"use client";

import { Icon } from "@/components/Icon";
import { CipherLicenseSelect } from "@/components/security/CipherLicenseSelect";
import { inputClass } from "@/components/pipeline/Modal";
import { BarChart, LineChart, PieChart } from "@/components/workshop/Charts";
import type { Analysis, Board, BoardConfig, BoardResult, ContourPath, SourceRef } from "@/lib/contour";
import { fmt } from "@/lib/workshop";
import { MapEditor, MapView } from "./MapBoard";
import { ScatterView } from "./ScatterBoard";

const small = `${inputClass} py-1 text-xs`;
const CIPHER_COLUMN_KINDS: ("data_manager" | "admin")[] = ["data_manager", "admin"];
export type Sources = { datasets: { id: string; name: string }[]; object_types: { id: string; name: string }[]; restricted_views?: { id: string; name: string }[] };
const METRICS = ["count", "sum", "avg", "min", "max", "median", "stddev", "distinct"];
const OPS: [string, string][] = [
  ["is", "is"],
  ["is_wild", "is (wildcards * ?)"],
  ["contains", "contains"],
  ["contains_wild", "contains (wildcards)"],
  ["matches", "matches regex"],
  ["eq", "="],
  ["neq", "≠"],
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["between", "between"],
  ["in", "in list"],
  ["is_null", "is empty"],
  ["not_null", "is not empty"],
];

function Col({ value, cols, onChange, empty = "Choose…" }: { value?: string; cols: string[]; onChange: (v: string | undefined) => void; empty?: string }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={small}>
      <option value="">{empty}</option>
      {cols.map((c) => <option key={c}>{c}</option>)}
      {value && !cols.includes(value) && <option>{value}</option>}
    </select>
  );
}

function Cols({ value, cols, onChange }: { value?: string[]; cols: string[]; onChange: (v: string[]) => void }) {
  return (
    <select multiple value={value ?? []} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))} className={`${small} h-24`}>
      {cols.map((c) => <option key={c}>{c}</option>)}
    </select>
  );
}

function Metric({ c, cols, set }: { c: BoardConfig; cols: string[]; set: (p: BoardConfig) => void }) {
  return (
    <div className="flex gap-1">
      <select value={c.metric ?? "count"} onChange={(e) => set({ metric: e.target.value })} className={`${small} w-24`}>
        {METRICS.map((m) => <option key={m}>{m}</option>)}
      </select>
      {(c.metric ?? "count") !== "count" && <Col value={c.metric_column} cols={cols} onChange={(v) => set({ metric_column: v })} empty="of column…" />}
    </div>
  );
}

export function SourcePicker({ value, sources, paths, self, onChange }: { value?: SourceRef; sources: Sources; paths: ContourPath[]; self?: string; onChange: (s: SourceRef) => void }) {
  return (
    <select
      value={value ? `${value.kind}:${value.id}` : ""}
      onChange={(e) => {
        const [kind, ...id] = e.target.value.split(":");
        if (e.target.value) onChange({ kind: kind as SourceRef["kind"], id: id.join(":") });
      }}
      className={small}
    >
      <option value="">Choose a starting point…</option>
      <optgroup label="Datasets">{sources.datasets.map((d) => <option key={d.id} value={`dataset:${d.id}`}>{d.name}</option>)}</optgroup>
      <optgroup label="Object types">{sources.object_types.map((t) => <option key={t.id} value={`object_type:${t.id}`}>{t.name}</option>)}</optgroup>
      {!!sources.restricted_views?.length && (
        <optgroup label="Restricted views (your rows)">{sources.restricted_views.map((v) => <option key={v.id} value={`restricted_view:${v.id}`}>{v.name}</option>)}</optgroup>
      )}
      <optgroup label="Results of paths">{paths.filter((p) => p.id !== self).map((p) => <option key={p.id} value={`path:${p.id}`}>{p.name}</option>)}</optgroup>
    </select>
  );
}

const ParamHint = ({ a }: { a: Analysis }) =>
  a.parameters.length ? <p className="text-[11px] text-muted">Parameters: {a.parameters.map((p) => `$${p.name}`).join(", ")}</p> : null;

/** The settings of one board; `cols` are the columns of its input. */
export function BoardEditor({ b, cols, a, sources, path, onChange }: { b: Board; cols: string[]; a: Analysis; sources: Sources; path: ContourPath; onChange: (c: BoardConfig) => void }) {
  const c = b.config;
  const set = (p: BoardConfig) => onChange({ ...c, ...p });
  const label = (t: string, el: React.ReactNode) => <label className="block flex-1">{t}{el}</label>;
  switch (b.type) {
    case "filter": {
      const conds: BoardConfig[] = c.conditions ?? [];
      const setCond = (i: number, p: BoardConfig) => set({ conditions: conds.map((x, j) => (j === i ? { ...x, ...p } : x)) });
      return (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <select value={c.mode ?? "all"} onChange={(e) => set({ mode: e.target.value })} className={`${small} w-40`}>
              <option value="all">Match all conditions</option>
              <option value="any">Match any condition</option>
            </select>
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.remove} onChange={(e) => set({ remove: e.target.checked })} /> Remove matching rows</label>
          </div>
          {conds.map((x, i) => (
            <div key={i} className="flex gap-1">
              <Col value={x.column} cols={cols} onChange={(v) => setCond(i, { column: v })} />
              <select value={x.op ?? "is"} onChange={(e) => setCond(i, { op: e.target.value })} className={`${small} w-32`}>
                {OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {!["is_null", "not_null"].includes(x.op) && (
                <input
                  value={(x.values ?? (x.value !== undefined ? [x.value] : [])).join(", ")}
                  onChange={(e) => setCond(i, { values: e.target.value.split(",").map((s) => s.trim()).filter(Boolean), value: undefined })}
                  placeholder="value, value or $parameter"
                  className={small}
                />
              )}
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!x.negate} onChange={(e) => setCond(i, { negate: e.target.checked })} />not</label>
              <button type="button" onClick={() => set({ conditions: conds.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove condition"><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button type="button" onClick={() => set({ conditions: [...conds, { column: cols[0], op: "is", values: [] }] })} className="text-ocean hover:underline">+ Condition</button>
          {label("Or an expression (SQL, keeps rows where true)", <input value={c.expression ?? ""} onChange={(e) => set({ expression: e.target.value || undefined })} placeholder="tarif > $min_tarif AND faskes LIKE 'RS%'" className={`${small} font-mono`} />)}
          <ParamHint a={a} />
        </div>
      );
    }
    case "expression": {
      const aggs: BoardConfig[] = c.aggregates ?? [];
      return (
        <div className="space-y-1.5">
          <select value={c.mode ?? "column"} onChange={(e) => set({ mode: e.target.value })} className={`${small} w-56`}>
            <option value="column">Add a column</option>
            <option value="filter">Filter rows</option>
            <option value="aggregate">Aggregate (group by)</option>
          </select>
          {(c.mode ?? "column") === "column" && (
            <div className="flex gap-1">
              <input value={c.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder="new column" className={`${small} w-40`} />
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.replace} onChange={(e) => set({ replace: e.target.checked })} />replace existing</label>
            </div>
          )}
          {c.mode !== "aggregate" && (
            <textarea rows={2} value={c.expr ?? ""} onChange={(e) => set({ expr: e.target.value })} placeholder="tarif / 1e6   ·   RANK() OVER (PARTITION BY faskes ORDER BY tarif DESC)" className={`${small} font-mono`} />
          )}
          {c.mode === "aggregate" && (
            <>
              {label("Group by", <Cols value={c.group_by} cols={cols} onChange={(v) => set({ group_by: v })} />)}
              {aggs.map((x, i) => (
                <div key={i} className="flex gap-1">
                  <input value={x.name} onChange={(e) => set({ aggregates: aggs.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) })} placeholder="name" className={`${small} w-32`} />
                  <input value={x.expr} onChange={(e) => set({ aggregates: aggs.map((y, j) => (j === i ? { ...y, expr: e.target.value } : y)) })} placeholder="SUM(tarif)" className={`${small} font-mono`} />
                  <button type="button" onClick={() => set({ aggregates: aggs.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3.5 w-3.5" /></button>
                </div>
              ))}
              <button type="button" onClick={() => set({ aggregates: [...aggs, { name: `value${aggs.length + 1}`, expr: "COUNT(*)" }] })} className="text-ocean hover:underline">+ Aggregate</button>
            </>
          )}
          <p className="text-[11px] text-muted">SQL expressions (DuckDB): functions, CASE, window functions with OVER (…).</p>
          <ParamHint a={a} />
        </div>
      );
    }
    case "edit_columns":
      return (
        <div className="space-y-1.5">
          {label("Keep only (none: all)", <Cols value={c.keep} cols={cols} onChange={(v) => set({ keep: v.length ? v : undefined })} />)}
          {!c.keep && label("Remove", <Cols value={c.remove} cols={cols} onChange={(v) => set({ remove: v })} />)}
          {label("Rename (old=new, one per line)", (
            <textarea
              rows={2}
              value={Object.entries(c.rename ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
              onChange={(e) => set({ rename: Object.fromEntries(e.target.value.split("\n").map((l) => l.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1])) })}
              className={`${small} font-mono`}
            />
          ))}
          {label("Change type (column=VARCHAR|DOUBLE|BIGINT|DATE|TIMESTAMP|BOOLEAN)", (
            <textarea
              rows={2}
              value={Object.entries(c.casts ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
              onChange={(e) => set({ casts: Object.fromEntries(e.target.value.split("\n").map((l) => l.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && /^[A-Z]+$/.test(p[1]))) })}
              className={`${small} font-mono`}
            />
          ))}
        </div>
      );
    case "reorder_columns":
      return label("Columns first, in this order (comma-separated)", (
        <input value={(c.order ?? []).join(", ")} onChange={(e) => set({ order: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder={cols.slice(0, 3).join(", ")} className={small} />
      ));
    case "sort": {
      const by: BoardConfig[] = c.by ?? [];
      return (
        <div className="space-y-1">
          {by.map((x, i) => (
            <div key={i} className="flex gap-1">
              <Col value={x.column} cols={cols} onChange={(v) => set({ by: by.map((y, j) => (j === i ? { ...y, column: v } : y)) })} />
              <select value={x.desc ? "desc" : "asc"} onChange={(e) => set({ by: by.map((y, j) => (j === i ? { ...y, desc: e.target.value === "desc" } : y)) })} className={`${small} w-28`}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
              <button type="button" onClick={() => set({ by: by.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button type="button" onClick={() => set({ by: [...by, { column: cols[0] }] })} className="text-ocean hover:underline">+ Sort column</button>
        </div>
      );
    }
    case "join":
    case "enrich":
    case "set_math": {
      const on: [string, string][] = c.on ?? [];
      return (
        <div className="space-y-1.5">
          {label("With", <SourcePicker value={c.source} sources={sources} paths={a.paths} self={path.id} onChange={(s) => set({ source: s })} />)}
          {b.type === "join" && (
            <select value={c.how ?? "left"} onChange={(e) => set({ how: e.target.value })} className={`${small} w-40`}>
              {["left", "inner", "right", "full", "semi", "anti"].map((h) => <option key={h} value={h}>{h} join</option>)}
            </select>
          )}
          {b.type === "set_math" ? (
            <>
              <select value={c.op ?? "union"} onChange={(e) => set({ op: e.target.value })} className={`${small} w-56`}>
                <option value="union">Union (rows of both)</option>
                <option value="intersect">Intersection (rows also in the other)</option>
                <option value="subtract">Subtract (rows not in the other)</option>
              </select>
              {c.op && c.op !== "union" && label("Key columns", <Cols value={c.keys} cols={cols} onChange={(v) => set({ keys: v })} />)}
            </>
          ) : (
            <>
              {on.map(([l, r], i) => (
                <div key={i} className="flex items-center gap-1">
                  <Col value={l} cols={cols} onChange={(v) => set({ on: on.map((p, j) => (j === i ? [v ?? "", p[1]] : p)) })} />
                  =
                  <input value={r} onChange={(e) => set({ on: on.map((p, j) => (j === i ? [p[0], e.target.value] : p)) })} placeholder="column of the other side" className={small} />
                  <button type="button" onClick={() => set({ on: on.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3.5 w-3.5" /></button>
                </div>
              ))}
              <button type="button" onClick={() => set({ on: [...on, [cols[0] ?? "", ""]] })} className="text-ocean hover:underline">+ Key</button>
              {label("Columns to add (comma-separated; empty: all)", (
                <input value={(c.columns ?? []).join(", ")} onChange={(e) => { const v = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); set({ columns: v.length ? v : undefined }); }} className={small} />
              ))}
              {label("Prefix", <input value={c.prefix ?? ""} onChange={(e) => set({ prefix: e.target.value })} className={`${small} w-40`} />)}
            </>
          )}
        </div>
      );
    }
    case "transform_data":
      return (
        <div className="flex flex-wrap gap-1">
          <Col value={c.column} cols={cols} onChange={(v) => set({ column: v })} />
          <select value={c.op ?? "find_replace"} onChange={(e) => set({ op: e.target.value })} className={`${small} w-40`}>
            {["find_replace", "regex_replace", "upper", "lower", "trim", "obfuscate"].map((o) => <option key={o}>{o}</option>)}
          </select>
          {["find_replace", "regex_replace"].includes(c.op ?? "find_replace") && (
            <>
              <input value={c.find ?? ""} onChange={(e) => set({ find: e.target.value })} placeholder="find" className={`${small} w-32`} />
              <input value={c.replace ?? ""} onChange={(e) => set({ replace: e.target.value })} placeholder="replace with" className={`${small} w-32`} />
            </>
          )}
          {c.op === "obfuscate" && <input value={c.salt ?? ""} onChange={(e) => set({ salt: e.target.value })} placeholder="salt" className={`${small} w-32`} />}
        </div>
      );
    case "unpivot":
      return (
        <div className="space-y-1.5">
          {label("Columns to turn into rows", <Cols value={c.columns} cols={cols} onChange={(v) => set({ columns: v })} />)}
          <div className="flex gap-1">
            <input value={c.name_column ?? "column"} onChange={(e) => set({ name_column: e.target.value })} className={small} aria-label="Name column" />
            <input value={c.value_column ?? "value"} onChange={(e) => set({ value_column: e.target.value })} className={small} aria-label="Value column" />
          </div>
        </div>
      );
    case "dedupe":
      return label("Unique by (none: whole rows)", <Cols value={c.columns} cols={cols} onChange={(v) => set({ columns: v })} />);
    case "cipher":
      // Data Manager or Admin licenses; the values change in place, column names stay (api/contour_engine.py)
      return (
        <div className="space-y-1.5">
          {label("Columns", <Cols value={c.columns} cols={cols} onChange={(v) => set({ columns: v })} />)}
          <div className="flex gap-1">
            <select value={c.operation ?? "encrypt"} onChange={(e) => set({ operation: e.target.value })} className={`${small} w-28`} aria-label="Operation">
              <option value="encrypt">Encrypt</option>
              <option value="decrypt">Decrypt</option>
              <option value="hash">Hash</option>
            </select>
            <CipherLicenseSelect value={c.license} onChange={(v) => set({ license: v })} operation={(c.operation as "encrypt" | "decrypt" | "hash") ?? "encrypt"}
              kinds={CIPHER_COLUMN_KINDS} className={small} />
          </div>
          <p className="text-[10px] text-muted">A path with a Cipher board cannot be saved as a dataset.</p>
        </div>
      );
    case "table":
    case "export":
      return (
        <div className="flex gap-2">
          {label("Columns (none: all)", <Cols value={c.columns} cols={cols} onChange={(v) => set({ columns: v })} />)}
          <div className="w-40 space-y-1">
            <Col value={c.sort} cols={cols} onChange={(v) => set({ sort: v })} empty="Sort by…" />
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.descending} onChange={(e) => set({ descending: e.target.checked })} />descending</label>
          </div>
        </div>
      );
    case "histogram":
    case "distribution":
      return (
        <div className="flex flex-wrap gap-1">
          <Col value={c.column} cols={cols} onChange={(v) => set({ column: v })} />
          {b.type === "histogram" ? <Metric c={c} cols={cols} set={set} /> : <input type="number" value={c.bins ?? 20} onChange={(e) => set({ bins: Number(e.target.value) })} className={`${small} w-20`} aria-label="Bins" />}
          {b.type === "histogram" && (
            <select value={c.sort ?? "value"} onChange={(e) => set({ sort: e.target.value })} className={`${small} w-28`}>
              <option value="value">by value</option>
              <option value="key">by key</option>
            </select>
          )}
        </div>
      );
    case "time_series":
    case "chart":
      return (
        <div className="flex flex-wrap gap-1">
          {b.type === "chart" && (
            <select value={c.kind ?? "bar"} onChange={(e) => set({ kind: e.target.value })} className={`${small} w-24`}>
              {["bar", "line", "pie", "scatter"].map((k) => <option key={k}>{k}</option>)}
            </select>
          )}
          <Col value={b.type === "chart" ? c.x : c.date_column} cols={cols} onChange={(v) => set(b.type === "chart" ? { x: v } : { date_column: v })} empty={b.type === "chart" ? "x axis…" : "date column…"} />
          {c.kind === "scatter" ? (
            <>
              <Col value={c.y} cols={cols} onChange={(v) => set({ y: v })} empty="y axis…" />
              <Col value={c.color} cols={cols} onChange={(v) => set({ color: v })} empty="color by…" />
              <Col value={c.size} cols={cols} onChange={(v) => set({ size: v })} empty="size by…" />
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.log_x} onChange={(e) => set({ log_x: e.target.checked || undefined })} />log x</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.log_y} onChange={(e) => set({ log_y: e.target.checked || undefined })} />log y</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={c.trend === "linear"} onChange={(e) => set({ trend: e.target.checked ? "linear" : undefined })} />trend line</label>
              <label className="flex items-center gap-1" title="Up to this many points are drawn one by one (at most 50,000); above it the board shows density cells">
                points
                <input type="number" min={100} max={50000} step={1000} value={c.point_limit ?? 10000} onChange={(e) => set({ point_limit: Number(e.target.value) || undefined })} className={`${small} w-24`} />
              </label>
              <label className="flex items-center gap-1" title="Density cells per side above the point limit (10 to 200)">
                cells
                <input type="number" min={10} max={200} value={c.bins ?? 80} onChange={(e) => set({ bins: Number(e.target.value) || undefined })} className={`${small} w-16`} />
              </label>
            </>
          ) : (
            <>
              <Metric c={c} cols={cols} set={set} />
              <select value={c.bucket ?? (b.type === "chart" ? "none" : "day")} onChange={(e) => set({ bucket: e.target.value })} className={`${small} w-24`}>
                {["none", "day", "week", "month", "quarter", "year"].map((k) => <option key={k}>{k}</option>)}
              </select>
              <Col value={c.series} cols={cols} onChange={(v) => set({ series: v })} empty="no series" />
            </>
          )}
        </div>
      );
    case "heatmap":
      return (
        <div className="flex flex-wrap gap-1">
          <Col value={c.x} cols={cols} onChange={(v) => set({ x: v })} empty="columns…" />
          <Col value={c.y} cols={cols} onChange={(v) => set({ y: v })} empty="rows…" />
          <Metric c={c} cols={cols} set={set} />
        </div>
      );
    case "pivot": {
      const vals: BoardConfig[] = c.values ?? [{ metric: "count" }];
      return (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            {label("Rows", <Cols value={c.rows} cols={cols} onChange={(v) => set({ rows: v })} />)}
            {label("Columns (optional)", <Col value={c.columns} cols={cols} onChange={(v) => set({ columns: v })} empty="none" />)}
          </div>
          {vals.map((v, i) => (
            <div key={i} className="flex gap-1">
              <Metric c={{ metric: v.metric, metric_column: v.column }} cols={cols} set={(p) => set({ values: vals.map((x, j) => (j === i ? { ...x, ...(p.metric ? { metric: p.metric } : {}), ...("metric_column" in p ? { column: p.metric_column } : {}) } : x)) })} />
              {vals.length > 1 && <button type="button" onClick={() => set({ values: vals.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
          {!c.columns && <button type="button" onClick={() => set({ values: [...vals, { metric: "count" }] })} className="text-ocean hover:underline">+ Value</button>}
        </div>
      );
    }
    case "calculation": {
      const ms: BoardConfig[] = c.metrics ?? [{ name: "rows", expr: "COUNT(*)" }];
      return (
        <div className="space-y-1">
          {ms.map((m, i) => (
            <div key={i} className="flex gap-1">
              <input value={m.name} onChange={(e) => set({ metrics: ms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className={`${small} w-32`} aria-label="Name" />
              <input value={m.expr} onChange={(e) => set({ metrics: ms.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)) })} placeholder="AVG(tarif)" className={`${small} font-mono`} />
              <button type="button" onClick={() => set({ metrics: ms.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button type="button" onClick={() => set({ metrics: [...ms, { name: `m${ms.length + 1}`, expr: "COUNT(*)" }] })} className="text-ocean hover:underline">+ Statistic</button>
        </div>
      );
    }
    case "map":
      return <MapEditor c={c} cols={cols} set={set} boardId={b.id} sourcePicker={(v, on) => <SourcePicker value={v} sources={sources} paths={a.paths} self={path.id} onChange={on} />} />;
  }
}

/** Visualization boards whose aggregated result can replace the working data downstream ("switch"). */
export const SWITCHABLE = ["pivot", "histogram", "chart", "calculation", "time_series", "heatmap"];

function DataTable({ rows, cols, total }: { rows: Record<string, unknown>[]; cols: string[]; total?: number }) {
  return (
    <div className="max-h-80 overflow-auto rounded border border-line">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-panel-2 text-left">
          <tr>{cols.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1 font-medium">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {cols.map((c) => <td key={c} className="whitespace-nowrap px-2 py-1">{r[c] === null || r[c] === undefined ? <span className="text-muted">—</span> : typeof r[c] === "number" ? fmt(r[c] as number) : String(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {total !== undefined && total > rows.length && <p className="border-t border-line px-2 py-1 text-[11px] text-muted">Showing {rows.length} of {fmt(total)} rows.</p>}
    </div>
  );
}

/**
 * A board's visualization; `onSelect` toggles a selected key (chart-to-chart filtering). Scatter and map boards select
 * areas, categories, points and regions: they replace the whole selection through `onSelection`; without it they add
 * and remove one item at a time through `onSelect`.
 */
export function BoardView({ b, r, onSelect, onSelection }: { b: Board; r?: BoardResult; onSelect?: (key: unknown) => void; onSelection?: (s: unknown[] | null) => void }) {
  if (!r) return <p className="text-xs text-muted">Running…</p>;
  if (r.error) return <p className="rounded border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-bad">{r.error}</p>;
  const rows = r.data ?? [];
  const cols = r.data_columns ?? [];
  const c = b.config;
  const datum = rows.map((x) => ({ key: x.key, value: x.value === null ? null : Number(x.value), count: Number(x.value ?? 0) }));
  const metric = `${c.metric ?? "count"}${c.metric_column ? ` of ${c.metric_column}` : ""}`;
  const sel = b.selection?.length ? (
    <p className="mb-1 text-[11px] text-ocean">
      Selected: {b.selection.map(String).join(", ")}
      {onSelect && <button type="button" onClick={() => onSelect(null)} className="ml-2 underline">clear</button>}
    </p>
  ) : null;
  const box = (el: React.ReactNode) => <>{sel}<div className="h-64">{el}</div></>;
  const replace = onSelection ?? (onSelect ? toggles(b.selection ?? [], onSelect) : undefined);
  switch (b.type) {
    case "histogram":
      return box(<BarChart data={datum} metricLabel={metric} onSelect={onSelect} />);
    case "distribution":
      return box(<BarChart data={datum.map((d) => ({ ...d, key: typeof d.key === "number" ? fmt(d.key) : d.key }))} metricLabel="rows" />);
    case "time_series":
      return cols.includes("series") ? <DataTable rows={rows} cols={cols} /> : box(<LineChart data={datum} metricLabel={metric} onSelect={onSelect} />);
    case "chart":
      if (c.kind === "scatter") return <ScatterView rows={rows} meta={r.scatter} config={c} selection={b.selection} onSelection={replace} />;
      if (cols.includes("series")) return <DataTable rows={rows} cols={cols} />;
      return box(c.kind === "pie" ? <PieChart data={datum} metricLabel={metric} onSelect={onSelect} /> : c.kind === "line" ? <LineChart data={datum} metricLabel={metric} onSelect={onSelect} /> : <BarChart data={datum} metricLabel={metric} onSelect={onSelect} />);
    case "heatmap":
      return <Heat rows={rows} onSelect={onSelect} />;
    case "calculation":
      return (
        <div className="flex flex-wrap gap-3">
          {cols.map((k) => (
            <div key={k} className="rounded-lg border border-line bg-panel-2 px-4 py-2">
              <div className="text-[11px] text-muted">{k}</div>
              <div className="text-lg font-semibold">{typeof rows[0]?.[k] === "number" ? fmt(rows[0][k] as number) : String(rows[0]?.[k] ?? "—")}</div>
            </div>
          ))}
        </div>
      );
    case "map":
      return <MapView r={r} config={c} selection={b.selection} onSelection={replace} boardId={b.id} />;
    case "pivot":
      return <>{sel}<DataTable rows={rows} cols={cols} /></>;
    default:
      return <DataTable rows={rows} cols={cols} total={r.total} />;
  }
}

function Heat({ rows, onSelect }: { rows: Record<string, unknown>[]; onSelect?: (key: unknown) => void }) {
  const xs = [...new Set(rows.map((r) => String(r.x)))];
  const ys = [...new Set(rows.map((r) => String(r.y)))];
  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);
  const at = new Map(rows.map((r) => [`${r.x}\u0000${r.y}`, Number(r.value)]));
  return (
    <div className="max-h-80 overflow-auto">
      <table className="text-[11px]">
        <thead><tr><th />{xs.map((x) => <th key={x} className="px-1 font-medium">{x}</th>)}</tr></thead>
        <tbody>
          {ys.map((y) => (
            <tr key={y}>
              <th className="pr-2 text-left font-medium">{y}</th>
              {xs.map((x) => {
                const v = at.get(`${x}\u0000${y}`);
                return (
                  <td key={x} onClick={() => onSelect?.(x)} className="h-7 min-w-12 cursor-pointer px-1 text-center" style={{ background: v === undefined ? undefined : `rgba(56,132,255,${0.12 + 0.8 * (v / max)})` }}>
                    {v === undefined ? "" : fmt(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A whole-selection change as toggles of single items (for parents that only toggle keys): removed items by
 * reference, added items appended; a replacement clears first (parents applying updates in order end up with `next`).
 */
function toggles(cur: unknown[], onSelect: (key: unknown) => void): (next: unknown[] | null) => void {
  return (next) => {
    if (!next?.length) return onSelect(null);
    const removed = cur.filter((x) => !next.includes(x));
    const added = next.filter((x) => !cur.includes(x));
    if (removed.length + added.length === 1) return onSelect(removed[0] ?? added[0]);
    onSelect(null);
    next.forEach((x) => onSelect(x));
  };
}
