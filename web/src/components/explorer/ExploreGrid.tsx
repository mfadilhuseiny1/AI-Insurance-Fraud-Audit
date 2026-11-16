"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { buttonClass, fieldClass, Modal } from "@/components/pipeline/Modal";
import type { ObjectType, Property } from "@/lib/ontology";
import { om, type Histogram, type LinkType, type SearchResult, type SearchSpec } from "@/lib/ontologyModel";

/* The Explore view of an exploration: a chart for every property of the result set (top values for text, a histogram
   for numbers, months for dates), each configurable (property, chart, sort) and clickable to filter; the results and
   the linked object types beside them. The layout (which charts, in which order, how sorted) is kept per object type
   in this browser. */

type ChartConf = { property: string; chart: "bars" | "columns"; sort: "count_desc" | "count_asc" | "value_asc" | "value_desc" };
const LAYOUT_KEY = (typeId: string) => `bluesandai:oe-layout:${typeId}`;

function readLayout(typeId: string): ChartConf[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY(typeId)) ?? "null");
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function writeLayout(typeId: string, l: ChartConf[] | null) {
  try {
    if (l) localStorage.setItem(LAYOUT_KEY(typeId), JSON.stringify(l));
    else localStorage.removeItem(LAYOUT_KEY(typeId));
  } catch {
    /* not remembered */
  }
}

type Row = { label: string; count: number; key: unknown };
function rowsOf(h: Histogram, sort: ChartConf["sort"]): Row[] {
  const rows: Row[] =
    h.kind === "numeric"
      ? h.buckets.map((b) => ({ label: `${fmt(b.from)} – ${fmt(b.to)}`, count: b.count, key: [b.from, b.to] }))
      : h.buckets.map((b) => ({ label: b.value, count: b.count, key: b.value }));
  if (h.kind === "numeric" || h.kind === "month") return sort === "value_desc" ? [...rows].reverse() : rows;
  const s = [...rows];
  if (sort === "count_desc") s.sort((a, b) => b.count - a.count);
  if (sort === "count_asc") s.sort((a, b) => a.count - b.count);
  if (sort === "value_asc") s.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (sort === "value_desc") s.sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
  return s;
}
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 });

export function ExploreGrid({
  data,
  spec,
  update,
  typeId,
  links,
  types,
  onResults,
  onAround,
}: {
  data: SearchResult;
  spec: SearchSpec;
  update: (c: Partial<SearchSpec>) => void;
  typeId: string;
  links: { lt: LinkType; direction: "forward" | "reverse"; name: string; to: string }[];
  types: ObjectType[];
  onResults: () => void;
  onAround: (linkTypeId: string, direction: "forward" | "reverse") => void;
}) {
  const props: Property[] = data.result_type.properties;
  const byProp = useMemo(() => new Map(data.histograms.map((h) => [h.property, h])), [data.histograms]);
  const [layout, setLayoutState] = useState<ChartConf[] | null>(() => (typeof window === "undefined" ? null : readLayout(typeId)));
  const [editing, setEditing] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [linkFind, setLinkFind] = useState("");
  const confs: ChartConf[] = (layout ?? data.histograms.map((h) => ({ property: h.property, chart: h.kind === "numeric" ? "columns" : "bars", sort: "count_desc" }) as ChartConf)).filter((c) =>
    byProp.has(c.property),
  );
  const setLayout = (l: ChartConf[] | null) => {
    setLayoutState(l);
    writeLayout(typeId, l);
  };
  const drillable = !spec.search_around?.length;
  const drill = (h: Histogram, k: unknown) => {
    if (!drillable) return;
    if (h.kind === "numeric") {
      const [lo, hi] = k as [number, number];
      update({ filters: [...(spec.filters ?? []), { property: h.property, op: "between", value: [lo, hi] }] });
    } else update({ filters: [...(spec.filters ?? []), k === "—" ? { property: h.property, op: "is_null" } : { property: h.property, op: "eq", value: k }] });
  };
  const label = (p: string) => props.find((x) => x.api_name === p)?.display_name ?? p;
  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid content-start gap-4 md:grid-cols-2">
        {confs.map((c, i) => {
          const h = byProp.get(c.property)!;
          const all = rowsOf(h, c.sort);
          const open = expanded.has(c.property);
          const rows = open ? all : all.slice(0, 5);
          const max = Math.max(1, ...all.map((r) => r.count));
          return (
            <div key={`${c.property}:${i}`} className="group rounded-xl border border-line bg-panel p-4" data-oe-chart={c.property}>
              <div className="mb-3 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{h.display_name}</span>
                <span className="text-[11px] text-muted">
                  {h.kind === "numeric" ? `${fmt(h.min)} – ${fmt(h.max)}` : `${h.distinct.toLocaleString()} values`}
                </span>
                <button type="button" onClick={() => setEditing(i)} className="rounded p-1 text-muted opacity-0 hover:bg-panel-2 hover:text-white group-hover:opacity-100" title="Configure chart">
                  <Icon name="sliders" className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => setLayout(confs.filter((_, j) => j !== i))} className="rounded p-1 text-muted opacity-0 hover:bg-panel-2 hover:text-white group-hover:opacity-100" title="Remove chart">
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </div>
              {c.chart === "columns" ? (
                <div className="flex h-36 items-end gap-1">
                  {all.map((r, j) => (
                    <button
                      key={j}
                      type="button"
                      disabled={!drillable}
                      onClick={() => drill(h, r.key)}
                      title={`${r.label}: ${r.count.toLocaleString()}`}
                      className="group/bar relative flex h-full flex-1 flex-col justify-end"
                    >
                      <span className="w-full rounded-t-[4px] bg-ocean/70 transition group-hover/bar:bg-ocean" style={{ height: `${Math.max(2, (r.count / max) * 100)}%` }} />
                      <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[10px] text-white ring-1 ring-line-2 group-hover/bar:block">
                        {r.label}: {r.count.toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {rows.map((r, j) => (
                    <button key={j} type="button" disabled={!drillable} onClick={() => drill(h, r.key)} className="group/bar flex w-full items-center gap-2 text-left text-xs" title={drillable ? "Filter to this value" : undefined}>
                      <span className="w-[42%] shrink-0 truncate text-soft group-hover/bar:text-white" title={r.label}>
                        {r.label}
                      </span>
                      <span className="w-12 shrink-0 text-right tabular-nums text-muted">{r.count.toLocaleString()}</span>
                      <span className="relative h-3 flex-1">
                        <span className="absolute inset-y-0 left-0 rounded-r-[4px] bg-ocean/70 group-hover/bar:bg-ocean" style={{ width: `${Math.max(1, (r.count / max) * 100)}%` }} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {c.chart === "columns" && (
                <div className="mt-1 flex justify-between text-[10px] text-muted">
                  <span>{all[0]?.label.split(" – ")[0]}</span>
                  <span>{all.at(-1)?.label.split(" – ").at(-1)}</span>
                </div>
              )}
              {c.chart === "bars" && all.length > 5 && (
                <button
                  type="button"
                  onClick={() => {
                    const n = new Set(expanded);
                    if (open) n.delete(c.property);
                    else n.add(c.property);
                    setExpanded(n);
                  }}
                  className="mx-auto mt-2 flex items-center gap-1 text-[11px] text-muted hover:text-white"
                >
                  {open ? "Show less" : "Show more"} <Icon name="down" className={`h-3 w-3 ${open ? "rotate-180" : ""}`} />
                </button>
              )}
            </div>
          );
        })}
        {confs.length === 0 && <p className="text-sm text-muted md:col-span-2">No property to chart. Add one from “Search properties to add a chart or filter”.</p>}
        {layout && (
          <button type="button" onClick={() => setLayout(null)} className="text-left text-xs text-muted hover:text-white md:col-span-2">
            Reset the layout to every property
          </button>
        )}
      </div>
      <aside className="space-y-4">
        {spec.object_type_id && !spec.interface_id && <Totals data={data} spec={spec} typeId={typeId} />}
        <div className="rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
            <span className="font-medium text-white">Results</span>
            <span className="rounded bg-panel-2 px-1.5 text-[11px] text-soft">{data.total.toLocaleString()}</span>
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {data.objects.slice(0, 12).map((o) => (
              <li key={`${o.object_type_id}:${o.primary_key}`}>
                <Link href={`/ontology/objects/${o.object_type_id}/${encodeURIComponent(o.primary_key)}`} className="flex items-center gap-2 px-4 py-1.5 text-xs text-soft hover:bg-panel-2 hover:text-ocean">
                  <TypeIcon t={types.find((t) => t.id === o.object_type_id) ?? {}} className="h-3.5 w-3.5" box="rounded p-0.5" />
                  <span className="truncate">{o.title}</span>
                </Link>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onResults} className="flex w-full items-center justify-center gap-1 border-t border-line py-2 text-xs text-ocean hover:bg-panel-2">
            View all results <Icon name="right" className="h-3 w-3" />
          </button>
        </div>
        <div className="rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-white">Linked objects</div>
          <div className="p-2">
            <input value={linkFind} onChange={(e) => setLinkFind(e.target.value)} placeholder="Filter…" className="w-full rounded-md bg-panel-2 px-2 py-1.5 text-xs outline-none" />
          </div>
          <ul className="max-h-64 overflow-y-auto pb-2">
            {links
              .filter((l) => !linkFind || l.name.toLowerCase().includes(linkFind.toLowerCase()))
              .map((l) => (
                <li key={`${l.lt.id}:${l.direction}`}>
                  <button type="button" onClick={() => onAround(l.lt.id, l.direction)} className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs text-soft hover:bg-panel-2 hover:text-ocean" title="Search around to these linked objects">
                    <TypeIcon t={types.find((t) => t.id === l.to) ?? {}} className="h-3.5 w-3.5" box="rounded p-0.5" />
                    <span className="truncate">{types.find((t) => t.id === l.to)?.display_name ?? l.name}</span>
                    <span className="ml-auto truncate text-[10px] text-muted">{l.name}</span>
                  </button>
                </li>
              ))}
            {!links.length && <li className="px-4 py-2 text-xs text-muted">No link types.</li>}
          </ul>
        </div>
      </aside>
      {editing !== null && confs[editing] && (
        <ConfigureChart
          conf={confs[editing]}
          histograms={data.histograms}
          label={label}
          resultName={data.result_type.display_name}
          onClose={() => setEditing(null)}
          onSave={(c) => {
            setLayout(confs.map((x, j) => (j === editing ? c : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const NUMERIC = new Set(["integer", "long", "short", "byte", "double", "float", "decimal"]);
const TOTALS_KEY = (typeId: string) => `bluesandai:oe-totals:${typeId}`;
const money = (p: string) => /_(rp|idr)$/i.test(p);
/** a total's value: rupiah in full and in short (4.550.096.075.546 → ≈ Rp 4,55 T), other numbers as they are */
function totalText(p: string, v: number): { full: string; short?: string } {
  if (!money(p)) return { full: v.toLocaleString(undefined, { maximumFractionDigits: 2 }) };
  const full = `Rp ${v.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
  const a = Math.abs(v);
  const [d, u] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "M"] : a >= 1e6 ? [1e6, "jt"] : [0, ""];
  return { full, short: d ? `≈ Rp ${(v / d).toLocaleString("id-ID", { maximumFractionDigits: 2 })} ${u}` : undefined };
}

/**
 * Totals of the whole result set (every row, also of a live type's millions): the sum of each chosen numeric property,
 * computed by the server's aggregation with the exploration's filters. By default the money columns named like a cost
 * or a value (biaya…_rp, nilai…_rp); kept per object type in this browser.
 */
function Totals({ data, spec, typeId }: { data: SearchResult; spec: SearchSpec; typeId: string }) {
  const numeric = data.result_type.properties.filter((p) => NUMERIC.has(p.type) && !p.array && p.api_name !== data.result_type.primary_key && p.visibility !== "hidden");
  const [chosen, setChosenState] = useState<string[] | null>(() => {
    try {
      const v = typeof window === "undefined" ? null : JSON.parse(localStorage.getItem(TOTALS_KEY(typeId)) ?? "null");
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  });
  const picks = (chosen ?? numeric.filter((p) => money(p.api_name) && /biaya|nilai|tagih|bayar|klaim/i.test(p.api_name)).slice(0, 3).map((p) => p.api_name)).filter((a) => numeric.some((p) => p.api_name === a));
  const setChosen = (l: string[]) => {
    setChosenState(l);
    try {
      localStorage.setItem(TOTALS_KEY(typeId), JSON.stringify(l));
    } catch {
      /* not remembered */
    }
  };
  // the set summed: the exploration without its paging, sorting or charts
  const base = JSON.stringify({ object_type_id: spec.object_type_id, q: spec.q, filters: spec.filters, search_around: spec.search_around, semantic: spec.semantic });
  const [sums, setSums] = useState<Record<string, { value: number | null; error?: string }>>({});
  useEffect(() => {
    const s = JSON.parse(base) as SearchSpec;
    let live = true;
    for (const p of picks) {
      const k = `${base}|${p}`;
      if (sums[k]) continue;
      om.search({ ...s, aggregate: { metric: "sum", property: p, group_by: null }, limit: 1, histograms: false, resource: "object-explorer" }).then(
        (r) => live && setSums((cur) => ({ ...cur, [k]: { value: Number(r.aggregation?.groups[0]?.value ?? 0) } })),
        (e: Error) => live && setSums((cur) => ({ ...cur, [k]: { value: null, error: e.message } })),
      );
    }
    return () => {
      live = false;
    };
    // sums: read for what is already known, not a reason to ask again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, picks.join(",")]);
  const rest = numeric.filter((p) => !picks.includes(p.api_name));
  if (!picks.length && !rest.length) return null;
  return (
    <div className="rounded-xl border border-line bg-panel" data-oe-totals>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
        <span className="font-medium text-white">Total</span>
        <span className="text-[11px] text-muted">of all {data.total.toLocaleString()} results</span>
      </div>
      <ul className="divide-y divide-line/60">
        {picks.map((p) => {
          const r = sums[`${base}|${p}`];
          const t = r && r.value !== null ? totalText(p, r.value) : null;
          return (
            <li key={p} className="group px-4 py-2" data-oe-total={p}>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="min-w-0 flex-1 truncate">Σ {numeric.find((x) => x.api_name === p)?.display_name ?? p}</span>
                <button type="button" onClick={() => setChosen(picks.filter((x) => x !== p))} className="opacity-0 hover:text-white group-hover:opacity-100" aria-label="Remove total">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </div>
              {t ? (
                <div className="mt-0.5">
                  <div className="text-base font-semibold tabular-nums text-white">{t.full}</div>
                  {t.short && <div className="text-[11px] tabular-nums text-soft">{t.short}</div>}
                </div>
              ) : r?.error ? (
                <div className="mt-0.5 text-xs text-red-300">{r.error}</div>
              ) : (
                <div className="mt-1 h-5 w-40 animate-pulse rounded bg-panel-2" />
              )}
            </li>
          );
        })}
      </ul>
      {rest.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <select value="" onChange={(e) => e.target.value && setChosen([...picks, e.target.value])} className={`${fieldClass} w-full text-xs`} aria-label="Add a total">
            <option value="">+ Add a total…</option>
            {rest.map((p) => (
              <option key={p.api_name} value={p.api_name}>
                {p.display_name || p.api_name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function ConfigureChart({
  conf,
  histograms,
  label,
  resultName,
  onClose,
  onSave,
}: {
  conf: ChartConf;
  histograms: Histogram[];
  label: (p: string) => string;
  resultName: string;
  onClose: () => void;
  onSave: (c: ChartConf) => void;
}) {
  const [c, setC] = useState(conf);
  const h = histograms.find((x) => x.property === c.property);
  const ordered = h?.kind === "numeric" || h?.kind === "month";
  return (
    <Modal title="Configure chart" icon="sliders" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <label className="block text-xs text-muted">
          Select a property to chart
          <select value={c.property} onChange={(e) => setC({ ...c, property: e.target.value })} className={`${fieldClass} mt-1 w-full`}>
            {histograms.map((x) => (
              <option key={x.property} value={x.property}>
                {label(x.property)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Select a chart type
          <select value={c.chart} onChange={(e) => setC({ ...c, chart: e.target.value as ChartConf["chart"] })} className={`${fieldClass} mt-1 w-full`}>
            <option value="bars">Histogram (bars, top values)</option>
            <option value="columns">Columns (every bucket)</option>
          </select>
        </label>
        <div className="text-xs text-muted">
          Display as <span className="rounded bg-panel-2 px-1.5 py-0.5 text-soft">Count of {resultName}</span>
        </div>
        <label className="block text-xs text-muted">
          Sort by
          <select value={c.sort} onChange={(e) => setC({ ...c, sort: e.target.value as ChartConf["sort"] })} className={`${fieldClass} mt-1 w-full`}>
            {!ordered && <option value="count_desc">Count, descending</option>}
            {!ordered && <option value="count_asc">Count, ascending</option>}
            <option value="value_asc">Value, ascending</option>
            <option value="value_desc">Value, descending</option>
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={() => onSave(c)} className={buttonClass.primary}>
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** "Search properties to add a chart or filter…": a property adds its chart (when hidden) or a filter. */
export function PropertySearch({ props, onFilter, onChart }: { props: Property[]; onFilter: (p: Property) => void; onChart: (p: Property) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const hits = props.filter((p) => p.visibility !== "hidden" && (!q || (p.display_name || p.api_name).toLowerCase().includes(q.toLowerCase()))).slice(0, 12);
  return (
    <div className="relative min-w-[16rem] flex-1">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search properties to add a chart or filter…"
        className="w-full bg-transparent py-1.5 text-sm outline-none placeholder:text-muted"
        data-oe-propsearch
      />
      {open && hits.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-xl border border-line-2 bg-panel py-1 shadow-2xl">
          {hits.map((p) => (
            <div key={p.api_name} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-panel-2">
              <span className="min-w-0 flex-1 truncate text-soft">{p.display_name || p.api_name}</span>
              <button type="button" onMouseDown={() => (onChart(p), setQ(""))} className="rounded px-1.5 py-0.5 text-ocean hover:bg-ocean/15">
                + chart
              </button>
              <button type="button" onMouseDown={() => (onFilter(p), setQ(""))} className="rounded px-1.5 py-0.5 text-ocean hover:bg-ocean/15">
                + filter
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { LAYOUT_KEY, readLayout, writeLayout };
export type { ChartConf };
