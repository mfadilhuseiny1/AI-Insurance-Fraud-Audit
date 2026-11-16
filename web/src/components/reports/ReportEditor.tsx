"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { inputClass } from "@/components/pipeline/Modal";
import type { Report, ReportFilter, ReportParameter, ReportWidget, WidgetKind } from "@/lib/reports";
import { contour, type Analysis as ContourAnalysis } from "@/lib/contour";
import { tsOntology, type Analysis as QuiverAnalysis } from "@/lib/timeseries";
import { embeddableCards } from "@/lib/quiverTables";
import { workshop, type Sources } from "@/lib/workshop";

const small = `${inputClass} py-1 text-xs`;
const KINDS: [WidgetKind, string][] = [
  ["text", "Text"],
  ["table", "Table"],
  ["chart", "Chart"],
  ["metric", "Metric"],
  ["object_table", "Object table"],
  ["contour_board", "Contour board"],
  ["quiver_card", "Quiver card"],
  ["image", "Image"],
  ["divider", "Divider"],
  ["page_break", "Page break"],
];
const DATA_KINDS: WidgetKind[] = ["table", "chart", "metric", "object_table"];
const uid = () => Math.random().toString(36).slice(2, 10);

export function useSources() {
  const [sources, setSources] = useState<Sources>({ datasets: [], object_types: [] });
  useEffect(() => {
    workshop.sources().then(setSources, () => undefined);
  }, []);
  return sources;
}

/** The columns of a widget's source (object type properties; a dataset's schema from a one-row query). */
function useColumns(source: ReportWidget["source"], sources: Sources): string[] {
  const [cols, setCols] = useState<{ key: string; cols: string[] }>({ key: "", cols: [] });
  const key = source ? `${source.kind}:${source.id}` : "";
  useEffect(() => {
    if (!source || source.kind !== "dataset") return;
    let stale = false;
    workshop.query({ source, limit: 1 }).then((r) => !stale && setCols({ key, cols: r.columns.map((c) => c.name) }), () => undefined);
    return () => {
      stale = true;
    };
  }, [source, key]);
  if (source?.kind === "object_type") return (sources.object_types.find((t) => t.id === source.id)?.properties ?? []).map((p) => p.name);
  return cols.key === key ? cols.cols : [];
}

export function newWidget(kind: WidgetKind): ReportWidget {
  return { id: uid(), kind, title: KINDS.find(([k]) => k === kind)?.[1] ?? "", width: "full", ...(kind === "text" ? { text: "Text with {{parameter}} values." } : {}), ...(kind === "chart" ? { chart: "bar", metric: "count" } : {}) };
}

export function WidgetEditor({ w, report, sources, onChange }: { w: ReportWidget; report: Report; sources: Sources; onChange: (p: Partial<ReportWidget>) => void }) {
  const cols = useColumns(w.source, sources);
  const setFilter = (i: number, p: Partial<ReportFilter>) => onChange({ filters: (w.filters ?? []).map((f, j) => (j === i ? { ...f, ...p } : f)) });
  return (
    <div className="space-y-2 text-xs">
      <div className="flex gap-2">
        <label className="block flex-1">Kind
          <select value={w.kind} onChange={(e) => onChange({ kind: e.target.value as WidgetKind })} className={small}>
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="block w-24">Width
          <select value={w.width ?? "full"} onChange={(e) => onChange({ width: e.target.value as "full" | "half" })} className={small}>
            <option value="full">Full</option>
            <option value="half">Half</option>
          </select>
        </label>
        <label className="block w-20">Height<input type="number" value={w.height ?? ""} onChange={(e) => onChange({ height: e.target.value ? Number(e.target.value) : undefined })} className={small} /></label>
      </div>
      {w.kind !== "divider" && w.kind !== "page_break" && (
        <div className="flex gap-2">
          <label className="block flex-1">Title<input value={w.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} className={small} /></label>
          <label className="block w-32">Title prefix
            <select value={w.title_prefix_param ?? ""} onChange={(e) => onChange({ title_prefix_param: e.target.value || undefined })} className={small}>
              <option value="">None</option>
              {report.parameters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
      )}
      {w.kind === "text" && <label className="block">Markdown ({"{{parameter id}}"} inserts a value)<textarea rows={5} value={w.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} className={small} /></label>}
      {w.kind === "contour_board" && <ContourPicker w={w} report={report} onChange={onChange} />}
      {w.kind === "quiver_card" && <QuiverPicker w={w} onChange={onChange} />}
      {w.kind === "image" && <label className="block">Image URL<input value={w.src ?? ""} onChange={(e) => onChange({ src: e.target.value })} className={small} /></label>}
      {DATA_KINDS.includes(w.kind) && (
        <>
          <label className="block">Source
            <select value={w.source ? `${w.source.kind}:${w.source.id}` : ""} onChange={(e) => { const [kind, ...id] = e.target.value.split(":"); onChange({ source: e.target.value ? { kind: kind as "dataset" | "object_type", id: id.join(":") } : undefined, columns: [], group_by: undefined, metric_column: undefined }); }} className={small}>
              <option value="">Choose…</option>
              <optgroup label="Datasets">{sources.datasets.map((d) => <option key={d.id} value={`dataset:${d.id}`}>{d.name}</option>)}</optgroup>
              <optgroup label="Object types">{sources.object_types.map((t) => <option key={t.id} value={`object_type:${t.id}`}>{t.name}</option>)}</optgroup>
            </select>
          </label>
          {(w.kind === "table" || w.kind === "object_table") && (
            <label className="block">Columns (none: all)
              <select multiple value={w.columns ?? []} onChange={(e) => onChange({ columns: [...e.target.selectedOptions].map((o) => o.value) })} className={`${small} h-24`}>
                {cols.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          )}
          {(w.kind === "chart" || w.kind === "metric") && (
            <div className="flex gap-2">
              {w.kind === "chart" && (
                <label className="block flex-1">Group by
                  <select value={w.group_by ?? ""} onChange={(e) => onChange({ group_by: e.target.value || undefined })} className={small}>
                    <option value="">Choose…</option>
                    {cols.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
              )}
              <label className="block w-24">Metric
                <select value={w.metric ?? "count"} onChange={(e) => onChange({ metric: e.target.value as ReportWidget["metric"] })} className={small}>
                  {["count", "sum", "avg", "min", "max", "distinct"].map((m) => <option key={m}>{m}</option>)}
                </select>
              </label>
              {w.metric && w.metric !== "count" && (
                <label className="block flex-1">Of column
                  <select value={w.metric_column ?? ""} onChange={(e) => onChange({ metric_column: e.target.value || undefined })} className={small}>
                    <option value="">Choose…</option>
                    {cols.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
              )}
              {w.kind === "chart" && (
                <label className="block w-20">Chart
                  <select value={w.chart ?? "bar"} onChange={(e) => onChange({ chart: e.target.value as "bar" | "line" | "pie" })} className={small}>
                    <option value="bar">Bar</option>
                    <option value="line">Line</option>
                    <option value="pie">Pie</option>
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="font-medium">Filters</div>
          {(w.filters ?? []).map((f, i) => (
            <div key={i} className="flex gap-1">
              <select value={f.column} onChange={(e) => setFilter(i, { column: e.target.value })} className={small}>
                {cols.map((c) => <option key={c}>{c}</option>)}
              </select>
              <select value={f.op ?? "eq"} onChange={(e) => setFilter(i, { op: e.target.value as ReportFilter["op"] })} className={`${small} w-20`}>
                {["eq", "neq", "gt", "gte", "lt", "lte", "contains", "is_null", "not_null"].map((o) => <option key={o}>{o}</option>)}
              </select>
              <select value={typeof f.value === "string" && f.value.startsWith("$param:") ? f.value : ""} onChange={(e) => setFilter(i, { value: e.target.value || "" })} className={`${small} w-28`}>
                <option value="">Value…</option>
                {report.parameters.map((p) => <option key={p.id} value={`$param:${p.id}`}>Parameter {p.name}</option>)}
              </select>
              {!(typeof f.value === "string" && f.value.startsWith("$param:")) && <input value={String(f.value ?? "")} onChange={(e) => setFilter(i, { value: e.target.value })} className={small} />}
              <button type="button" onClick={() => onChange({ filters: (w.filters ?? []).filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove filter"><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button type="button" onClick={() => onChange({ filters: [...(w.filters ?? []), { column: cols[0] ?? "", op: "eq", value: "" }] })} className="text-ocean hover:underline">+ Add filter</button>
        </>
      )}
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!w.hidden} onChange={(e) => onChange({ hidden: e.target.checked })} /> Hide this widget</label>
    </div>
  );
}

function ContourPicker({ w, report, onChange }: { w: ReportWidget; report: Report; onChange: (p: Partial<ReportWidget>) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [a, setA] = useState<ContourAnalysis | null>(null);
  const c = w.contour ?? {};
  useEffect(() => {
    contour.list().then(setList, () => undefined);
  }, []);
  useEffect(() => {
    if (c.analysis_id) contour.get(c.analysis_id).then((v) => setA(v.analysis), () => setA(null));
  }, [c.analysis_id]);
  const path = a?.paths.find((p) => p.id === c.path_id);
  const set = (p: Partial<NonNullable<ReportWidget["contour"]>>) => onChange({ contour: { ...c, ...p } });
  return (
    <div className="space-y-1">
      <select value={c.analysis_id ?? ""} onChange={(e) => set({ analysis_id: e.target.value, path_id: undefined, board_id: undefined, params: {} })} className={small}>
        <option value="">Contour analysis…</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name.replace(/\.contour$/, "")}</option>)}
      </select>
      {a && (
        <select value={c.path_id ?? ""} onChange={(e) => set({ path_id: e.target.value, board_id: undefined })} className={small}>
          <option value="">Path…</option>
          {a.paths.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {path && (
        <select value={c.board_id ?? ""} onChange={(e) => set({ board_id: e.target.value })} className={small}>
          <option value="">Board…</option>
          {path.boards.map((b) => <option key={b.id} value={b.id}>{b.title || b.type}</option>)}
        </select>
      )}
      {a?.parameters.map((p) => (
        <label key={p.name} className="flex items-center gap-1">${p.name}
          <select value={c.params?.[p.name]?.startsWith("$param:") ? c.params[p.name] : ""} onChange={(e) => set({ params: { ...c.params, [p.name]: e.target.value } })} className={`${small} w-32`}>
            <option value="">Value…</option>
            {report.parameters.map((rp) => <option key={rp.id} value={`$param:${rp.id}`}>Parameter {rp.name}</option>)}
          </select>
          {!c.params?.[p.name]?.startsWith("$param:") && <input value={c.params?.[p.name] ?? ""} onChange={(e) => set({ params: { ...c.params, [p.name]: e.target.value } })} placeholder="(analysis default)" className={small} />}
        </label>
      ))}
    </div>
  );
}

function QuiverPicker({ w, onChange }: { w: ReportWidget; onChange: (p: Partial<ReportWidget>) => void }) {
  const [list, setList] = useState<QuiverAnalysis[]>([]);
  const q = w.quiver ?? {};
  useEffect(() => {
    tsOntology.analyses().then(setList, () => undefined);
  }, []);
  const [a, setA] = useState<QuiverAnalysis | null>(null);
  useEffect(() => {
    if (q.analysis_id) tsOntology.analysis(q.analysis_id).then(setA, () => setA(null));
  }, [q.analysis_id]);
  const cards: [string, string][] = a
    ? [
        ...embeddableCards(a.object_sets as { id: string; kind?: string; title?: string }[]),
        ...a.plots.map((p) => [p.id, `Time series plot · ${p.title}`] as [string, string]),
        ...a.logic.cards.map((x) => [x.id, `$${x.id} ${x.title || x.type}`] as [string, string]),
      ]
    : [];
  return (
    <div className="space-y-1">
      <select value={q.analysis_id ?? ""} onChange={(e) => onChange({ quiver: { analysis_id: e.target.value } })} className={small}>
        <option value="">Quiver analysis…</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      {a && (
        <select value={q.card_id ?? ""} onChange={(e) => onChange({ quiver: { ...q, card_id: e.target.value } })} className={small}>
          <option value="">Card…</option>
          {cards.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      )}
      <p className="text-[10px] text-muted">Transform tables, charts, values, cross filters, Vega plots and single cards (aggregations, formulas, time series values, distributions, scatter plots …), and time series plots (drawn in the browser: in PDF, not in CSV or slides).</p>
    </div>
  );
}

export function ParametersEditor({ report, sources, onChange }: { report: Report; sources: Sources; onChange: (p: ReportParameter[]) => void }) {
  const set = (i: number, p: Partial<ReportParameter>) => onChange(report.parameters.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted">A parameter filters every widget that uses it (one parameter can drive many widgets); text widgets show it with {"{{id}}"}.</p>
      {report.parameters.map((p, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-2">
          <div className="flex gap-1">
            <input value={p.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Name" className={small} />
            <input value={p.id} onChange={(e) => /^[A-Za-z0-9_]*$/.test(e.target.value) && set(i, { id: e.target.value })} placeholder="id" className={`${small} w-24 font-mono`} />
            <select value={p.type} onChange={(e) => set(i, { type: e.target.value as ReportParameter["type"] })} className={`${small} w-24`}>
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
            </select>
            <button type="button" onClick={() => onChange(report.parameters.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove parameter"><Icon name="x" className="h-3.5 w-3.5" /></button>
          </div>
          <input value={String(p.default ?? "")} onChange={(e) => set(i, { default: e.target.value || undefined })} placeholder="Default value" className={small} />
          <div className="flex gap-1">
            <select value={p.suggest ? `${p.suggest.source.kind}:${p.suggest.source.id}` : ""} onChange={(e) => { const [kind, ...id] = e.target.value.split(":"); set(i, { suggest: e.target.value ? { source: { kind: kind as "dataset" | "object_type", id: id.join(":") }, column: p.suggest?.column ?? "" } : undefined }); }} className={small}>
              <option value="">Suggested values from…</option>
              {sources.datasets.map((d) => <option key={d.id} value={`dataset:${d.id}`}>{d.name}</option>)}
              {sources.object_types.map((t) => <option key={t.id} value={`object_type:${t.id}`}>{t.name}</option>)}
            </select>
            {p.suggest && <input value={p.suggest.column} onChange={(e) => set(i, { suggest: { ...p.suggest!, column: e.target.value } })} placeholder="column" className={`${small} w-28`} />}
          </div>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...report.parameters, { id: `p${report.parameters.length + 1}`, name: "Parameter", type: "string" }])} className="text-ocean hover:underline">+ Add parameter</button>
    </div>
  );
}
