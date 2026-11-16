"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import type { ObjectType } from "@/lib/ontology";
import { promptDialog } from "@/lib/dialogs";
import { vertex, type EdgeGroup, type Graph, type GroupedEdge, type NodeSeries, type SeriesConfig, type VNode, type VStyle } from "@/lib/vertex";

export type HistFilter = { object_type_id: string; property: string; values: string[]; mode: "to" | "out" };

const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "(empty)" : String(v));

/** Histogram: value counts per property of the visible objects; pick values, then Filter to / Filter out. */
export function HistogramPanel({ nodes, types, filters, setFilters, onSelect }: {
  nodes: VNode[];
  types: ObjectType[];
  filters: HistFilter[];
  setFilters: (f: HistFilter[]) => void;
  onSelect: (ids: string[]) => void;
}) {
  const [picked, setPicked] = useState<{ object_type_id: string; property: string; values: string[] } | null>(null);
  const groups = useMemo(() => {
    const byType = new Map<string, VNode[]>();
    for (const n of nodes) byType.set(n.object_type_id, [...(byType.get(n.object_type_id) ?? []), n]);
    return [...byType.entries()];
  }, [nodes]);
  if (!nodes.length) return <div className="text-muted">Add objects to see their properties&apos; values.</div>;
  return (
    <div className="space-y-3">
      {picked && picked.values.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 rounded border border-ocean/40 bg-panel p-2">
          <span className="flex-1">{picked.values.length} value(s) of {picked.property}</span>
          <button type="button" className={buttonClass.secondary} onClick={() => { setFilters([...filters, { ...picked, mode: "to" }]); setPicked(null); }}>Filter to</button>
          <button type="button" className={buttonClass.ghost} onClick={() => { setFilters([...filters, { ...picked, mode: "out" }]); setPicked(null); }}>Filter out</button>
          <button type="button" className={buttonClass.ghost} onClick={() => onSelect(nodes.filter((n) => n.object_type_id === picked.object_type_id && picked.values.includes(shown(n.properties[picked.property]))).map((n) => n.id))}>Select</button>
        </div>
      )}
      {groups.map(([tid, list]) => {
        const t = types.find((x) => x.id === tid);
        const props = (t?.properties ?? []).filter((p) => !["vector", "media", "attachment", "timeseries", "geoshape"].includes(p.type));
        return (
          <div key={tid} className="space-y-2">
            <div className="font-semibold">{list[0].object_type} <span className="font-normal text-muted">· {list.length}</span></div>
            {props.map((p) => {
              const counts = new Map<string, number>();
              for (const n of list) {
                const k = shown(n.properties[p.api_name]);
                counts.set(k, (counts.get(k) ?? 0) + 1);
              }
              if (counts.size <= 1 && list.length > 1) return null;
              const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
              const max = Math.max(...rows.map((r) => r[1]));
              return (
                <div key={p.api_name}>
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">{p.display_name}{counts.size > 8 ? ` · ${counts.size} values` : ""}</div>
                  {rows.map(([v, c]) => {
                    const on = picked?.object_type_id === tid && picked.property === p.api_name && picked.values.includes(v);
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          const same = picked && picked.object_type_id === tid && picked.property === p.api_name;
                          const vals = same ? (on ? picked.values.filter((x) => x !== v) : [...picked.values, v]) : [v];
                          setPicked({ object_type_id: tid, property: p.api_name, values: vals });
                        }}
                        className={`relative mb-0.5 flex w-full items-center gap-2 overflow-hidden rounded px-1.5 py-0.5 text-left ${on ? "ring-1 ring-ocean" : "hover:bg-panel-2"}`}
                      >
                        <span className="absolute inset-y-0 left-0 bg-ocean/15" style={{ width: `${(c / max) * 100}%` }} />
                        <span className="relative min-w-0 flex-1 truncate">{v}</span>
                        <span className="relative tabular-nums text-muted">{c}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function applyHistFilters(nodes: VNode[], filters: HistFilter[]): VNode[] {
  return nodes.filter((n) =>
    filters.every((f) => {
      if (n.object_type_id !== f.object_type_id) return true;
      const hit = f.values.includes(shown(n.properties[f.property]));
      return f.mode === "to" ? hit : !hit;
    }),
  );
}

/** The series panel: the configured series of the selected objects, one chart per series. */
export function SeriesPanel({ g, nodes, onClose }: { g: Graph; nodes: VNode[]; onClose: () => void }) {
  const [data, setData] = useState<Record<string, NodeSeries[]> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const withSeries = nodes.filter((n) => (g.series?.[n.object_type_id] ?? []).length).slice(0, 6);
  const key = JSON.stringify([withSeries.map((n) => n.id), g.series]);
  useEffect(() => {
    if (!withSeries.length) return;
    let stale = false;
    vertex.series(withSeries.map((n) => ({ object_type_id: n.object_type_id, primary_key: n.primary_key })), g.series ?? {}, g.scenario_id).then(
      (r) => !stale && (setData(r.series), setErr(null)),
      (e: Error) => !stale && setErr(e.message),
    );
    return () => {
      stale = true;
    };
    // key holds the nodes and the configuration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const labels = [...new Set(withSeries.flatMap((n) => (g.series?.[n.object_type_id] ?? []).map((s) => s.label)))];
  return (
    <div className="h-64 shrink-0 border-t border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        <span className="rounded bg-ocean/15 px-2 py-0.5 font-medium text-ocean">Series</span>
        <span className="text-muted">{withSeries.length ? withSeries.map((n) => n.title).join(", ") : "Select objects whose type has series (Flow tab → Series)."}</span>
        {withSeries[0] && (
          <Link href={`/quiver?new=1&type=${encodeURIComponent(withSeries[0].object_type_id)}&pk=${encodeURIComponent(withSeries[0].primary_key)}`} className="ml-auto flex items-center gap-1 rounded border border-line px-2 py-0.5 text-soft hover:text-white">
            <Icon name="wave" className="h-3 w-3" /> Open in Quiver
          </Link>
        )}
        <button type="button" onClick={onClose} className={withSeries[0] ? "text-muted hover:text-white" : "ml-auto text-muted hover:text-white"} aria-label="Close the series panel"><Icon name="down" className="h-4 w-4" /></button>
      </div>
      {err && <p className="p-2 text-xs text-bad">{err}</p>}
      <div className="flex h-[calc(100%-33px)] gap-3 overflow-x-auto p-2">
        {labels.map((label) => (
          <SeriesChart key={label} label={label} lines={withSeries.map((n, i) => ({ name: n.title, color: LINE_COLORS[i % LINE_COLORS.length], points: (data?.[n.id] ?? []).find((s) => s.label === label)?.points ?? [] }))} />
        ))}
      </div>
    </div>
  );
}

const LINE_COLORS = ["#38bdf8", "#f59e0b", "#34d399", "#f472b6", "#a78bfa", "#fb7185"];

function SeriesChart({ label, lines }: { label: string; lines: { name: string; color: string; points: { at: string; value: number }[] }[] }) {
  const all = lines.flatMap((l) => l.points);
  const xs = [...new Set(all.map((p) => p.at))].sort();
  const max = Math.max(1, ...all.map((p) => p.value));
  const W = 520;
  const H = 160;
  const pad = { l: 46, r: 8, t: 8, b: 22 };
  const x = (at: string) => pad.l + (xs.length > 1 ? (xs.indexOf(at) / (xs.length - 1)) * (W - pad.l - pad.r) : (W - pad.l - pad.r) / 2);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const fmt = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}jt` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}rb` : String(Math.round(v * 10) / 10));
  return (
    <div className="min-w-[420px] flex-1 rounded border border-line bg-ink p-2">
      <div className="mb-1 flex items-center gap-3 text-[11px]">
        <span className="font-medium text-soft">{label}</span>
        {lines.map((l) => <span key={l.name} className="flex items-center gap-1 text-muted"><span className="h-0.5 w-3" style={{ background: l.color }} />{l.name}</span>)}
      </div>
      {!all.length ? (
        <p className="py-8 text-center text-xs text-muted">No data for the selection.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[150px] w-full">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} className="stroke-line" strokeDasharray="2 3" />
              <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end" fontSize={9} className="fill-muted">{fmt(max * f)}</text>
            </g>
          ))}
          {xs.length > 0 && [xs[0], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]].map((at, i) => (
            <text key={`${at}-${i}`} x={x(at)} y={H - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize={9} className="fill-muted">{at}</text>
          ))}
          {lines.map((l) => (
            <polyline key={l.name} fill="none" stroke={l.color} strokeWidth={1.8} points={l.points.map((p) => `${x(p.at)},${y(p.value)}`).join(" ")}>
              <title>{l.name}</title>
            </polyline>
          ))}
        </svg>
      )}
    </div>
  );
}

/** A grouped edge's objects (the selection panel for an edge). */
export function EdgeDetails({ edge, nodes }: { edge: GroupedEdge; nodes: VNode[] }) {
  const name = (id: string) => nodes.find((n) => n.id === id)?.title ?? id;
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{edge.name}: {name(edge.source)} → {name(edge.target)}</div>
      <div className="text-muted">{edge.count} object(s) · value {edge.value.toLocaleString()}</div>
      <div className="divide-y divide-line">
        {edge.objects.map((o) => (
          <Link key={o.primary_key} href={`/ontology/objects/${edge.object_type_id}/${encodeURIComponent(o.primary_key)}`} className="block truncate py-1 text-ocean hover:underline">{o.title}</Link>
        ))}
      </div>
    </div>
  );
}

const ICONS = ["cube", "home", "database", "alert", "eye", "bug", "doc", "table", "server", "device", "gauge", "bolt", "folder", "project", "globe", "star", "link", "clock", "bell", "graph"];

/** Flow settings: line type, per type icon / column / node style, grouped edges and series. */
export function FlowPanel({ g, types, allTypes, links, update }: {
  g: Graph;
  types: ObjectType[];
  allTypes: ObjectType[];
  links: { id: string; display_name: string; source: { object_type_id: string }; target: { object_type_id: string } }[];
  update: (c: Partial<Graph>) => void;
}) {
  const groups = g.edge_groups ?? [];
  const setGroup = (i: number, p: Partial<EdgeGroup>) => update({ edge_groups: groups.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const linksOf = (tid: string) => links.filter((l) => l.source.object_type_id === tid || l.target.object_type_id === tid);
  const tname = (tid: string) => allTypes.find((t) => t.id === tid)?.display_name ?? tid;
  const other = (l: (typeof links)[number], tid: string) => (l.source.object_type_id === tid ? l.target.object_type_id : l.source.object_type_id);
  const numeric = (tid: string) => (allTypes.find((t) => t.id === tid)?.properties ?? []).filter((p) => ["integer", "long", "double", "float", "decimal", "short"].includes(p.type));
  const dates = (tid: string) => (allTypes.find((t) => t.id === tid)?.properties ?? []).filter((p) => ["date", "timestamp"].includes(p.type));
  const series = g.series ?? {};
  return (
    <div className="space-y-4">
      <label className="block">Lines
        <select value={g.line_type ?? "straight"} onChange={(e) => update({ line_type: e.target.value as Graph["line_type"] })} className={`${fieldClass} w-full`}>
          <option value="straight">Straight</option>
          <option value="curved">Curved</option>
          <option value="orthogonal">Orthogonal</option>
        </select>
      </label>
      <div className="space-y-1.5">
        <div className="font-semibold uppercase tracking-wide text-muted">Nodes</div>
        {types.map((t) => {
          const l = g.layers[t.id] ?? {};
          return (
            <div key={t.id} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate">{t.display_name}</span>
              <select value={l.node_style === "circle" ? "circle" : l.icon ?? t.icon ?? "cube"} onChange={(e) => update({ layers: { ...g.layers, [t.id]: { ...l, ...(e.target.value === "circle" ? { node_style: "circle" } : { node_style: "icon", icon: e.target.value }) } } })} className={`${fieldClass} w-24`} aria-label="Icon" data-layer-icon={t.id}>
                <option value="circle">circle</option>
                {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
              <input type="number" min={0} value={l.column ?? ""} onChange={(e) => update({ layers: { ...g.layers, [t.id]: { ...l, column: e.target.value === "" ? undefined : Number(e.target.value) } } })} placeholder="col" title="Column in the System flow layout" className={`${fieldClass} w-12`} />
            </div>
          );
        })}
      </div>
      <div className="space-y-1.5">
        <div className="font-semibold uppercase tracking-wide text-muted">Objects on edges</div>
        <p className="text-[11px] text-muted">An object type linked to two node types (claims, findings, audits…) drawn as edges between the nodes it connects, labelled and sized by a count or a sum.</p>
        {groups.map((gr, i) => {
          const ls = linksOf(gr.object_type_id);
          return (
            <div key={gr.id} className="space-y-1 rounded border border-line p-2" data-edge-group={i}>
              <div className="flex gap-1">
                <input value={gr.name} onChange={(e) => setGroup(i, { name: e.target.value })} className={`${fieldClass} flex-1`} aria-label="Edge name" />
                <button type="button" onClick={() => update({ edge_groups: groups.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3 w-3" /></button>
              </div>
              <select value={gr.object_type_id} onChange={(e) => setGroup(i, { object_type_id: e.target.value, links: ["", ""] })} className={`${fieldClass} w-full`}>
                {allTypes.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
              </select>
              {[0, 1].map((k) => (
                <select key={k} value={gr.links[k] ?? ""} onChange={(e) => setGroup(i, { links: (k === 0 ? [e.target.value, gr.links[1]] : [gr.links[0], e.target.value]) as [string, string] })} className={`${fieldClass} w-full`}>
                  <option value="">{k === 0 ? "From (link)…" : "To (link)…"}</option>
                  {ls.map((l) => <option key={l.id} value={l.id}>{l.display_name} → {tname(other(l, gr.object_type_id))}</option>)}
                </select>
              ))}
              <div className="flex gap-1">
                <select value={gr.label} onChange={(e) => setGroup(i, { label: e.target.value, ...(gr.width === gr.label ? { width: e.target.value } : {}) })} className={`${fieldClass} flex-1`} aria-label="Label">
                  <option value="count">Count</option>
                  {numeric(gr.object_type_id).map((p) => <option key={p.api_name} value={`sum:${p.api_name}`}>Sum of {p.display_name}</option>)}
                </select>
                {/* the thickness can follow another measure than the label (count shown, value as width) */}
                <select value={gr.width ?? gr.label} onChange={(e) => setGroup(i, { width: e.target.value })} className={`${fieldClass} flex-1`} aria-label="Width">
                  <option value="count">Width: count</option>
                  {numeric(gr.object_type_id).map((p) => <option key={p.api_name} value={`sum:${p.api_name}`}>Width: sum of {p.display_name}</option>)}
                </select>
                <select value={gr.format ?? "number"} onChange={(e) => setGroup(i, { format: e.target.value as EdgeGroup["format"] })} className={`${fieldClass} w-20`} aria-label="Format">
                  <option value="number">123</option>
                  <option value="juta">jt</option>
                  <option value="rupiah">Rp</option>
                </select>
              </div>
            </div>
          );
        })}
        <button type="button" className={buttonClass.ghost} onClick={() => update({ edge_groups: [...groups, { id: Math.random().toString(36).slice(2, 8), name: "Objects", object_type_id: allTypes[0]?.id ?? "", links: ["", ""], label: "count" }] })}>
          <Icon name="plus" className="h-3 w-3" /> Objects on edges
        </button>
      </div>
      <div className="space-y-1.5">
        <div className="font-semibold uppercase tracking-wide text-muted">Series</div>
        <p className="text-[11px] text-muted">For a node type: linked objects counted (or summed) per day, week or month of a date — shown in the series panel when its nodes are selected.</p>
        {types.map((t) => (series[t.id] ?? []).map((sc, i) => {
          const setS = (p: Partial<SeriesConfig>) => update({ series: { ...series, [t.id]: (series[t.id] ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)) } });
          const lt = links.find((l) => l.id === sc.link_type_id);
          const reached = lt ? (sc.direction === "forward" ? lt.target.object_type_id : lt.source.object_type_id) : "";
          return (
            <div key={`${t.id}-${i}`} className="space-y-1 rounded border border-line p-2">
              <div className="flex gap-1">
                <input value={sc.label} onChange={(e) => setS({ label: e.target.value })} className={`${fieldClass} flex-1`} aria-label="Series name" />
                <button type="button" onClick={() => update({ series: { ...series, [t.id]: (series[t.id] ?? []).filter((_, j) => j !== i) } })} className="text-muted hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3 w-3" /></button>
              </div>
              <div className="text-[10px] text-muted">{t.display_name}</div>
              <select value={`${sc.link_type_id}|${sc.direction}`} onChange={(e) => { const [id, d] = e.target.value.split("|"); setS({ link_type_id: id, direction: d as SeriesConfig["direction"] }); }} className={`${fieldClass} w-full`}>
                <option value="|forward">Linked objects…</option>
                {linksOf(t.id).map((l) => {
                  const d = l.source.object_type_id === t.id ? "forward" : "reverse";
                  return <option key={l.id} value={`${l.id}|${d}`}>{l.display_name} ({tname(other(l, t.id))})</option>;
                })}
              </select>
              <div className="flex gap-1">
                <select value={sc.date_property} onChange={(e) => setS({ date_property: e.target.value })} className={`${fieldClass} flex-1`} aria-label="Date">
                  <option value="">Date…</option>
                  {dates(reached).map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
                </select>
                <select value={sc.bucket} onChange={(e) => setS({ bucket: e.target.value as SeriesConfig["bucket"] })} className={`${fieldClass} w-20`}>
                  <option value="day">day</option>
                  <option value="week">week</option>
                  <option value="month">month</option>
                </select>
              </div>
              <select value={sc.metric} onChange={(e) => setS({ metric: e.target.value })} className={`${fieldClass} w-full`}>
                <option value="count">Count</option>
                {numeric(reached).map((p) => <option key={p.api_name} value={`sum:${p.api_name}`}>Sum of {p.display_name}</option>)}
              </select>
            </div>
          );
        }))}
        <select value="" onChange={(e) => e.target.value && update({ series: { ...series, [e.target.value]: [...(series[e.target.value] ?? []), { label: "Series", link_type_id: "", direction: "forward", date_property: "", metric: "count", bucket: "month" }] } })} className={`${fieldClass} w-full`}>
          <option value="">+ Series for…</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
        </select>
      </div>
    </div>
  );
}

/** Named selections saved with the graph: click one to select its objects again. */
export function SavedSelections({ g, selected, setSelected, update }: { g: Graph; selected: Set<string>; setSelected: (s: Set<string>) => void; update: (c: Partial<Graph>) => void }) {
  const list = g.selections ?? [];
  return (
    <div className="mb-3 space-y-1 border-b border-line pb-2">
      <div className="flex items-center justify-between">
        <span className="font-medium">Saved selections</span>
        {selected.size > 0 && (
          <button
            type="button"
            className="text-ocean hover:underline"
            onClick={async () => {
              const name = await promptDialog("Selection name", `Selection ${list.length + 1}`, { title: `Save ${selected.size} selected objects` });
              if (name) update({ selections: [...list.filter((x) => x.name !== name), { id: `sel-${Date.now().toString(36)}`, name, nodes: [...selected] }] });
            }}
          >
            Save selection
          </button>
        )}
      </div>
      {list.length === 0 && <p className="text-[11px] text-muted">Select objects and save them to come back to them (saved with the graph).</p>}
      {list.map((x) => (
        <div key={x.id} className="flex items-center gap-1">
          <button type="button" onClick={() => setSelected(new Set(x.nodes))} className="flex-1 truncate rounded px-1 py-0.5 text-left text-soft hover:bg-panel-2">
            {x.name} <span className="text-muted">({x.nodes.length})</span>
          </button>
          <button type="button" onClick={() => update({ selections: list.filter((y) => y.id !== x.id) })} className="text-muted hover:text-bad" aria-label="Delete selection">
            <Icon name="x" className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Styles (layers, edge styles, line type) saved by name and applied to any graph. */
export function SavedStyles({ g, update }: { g: Graph; update: (c: Partial<Graph>) => void }) {
  const [styles, setStyles] = useState<VStyle[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    vertex.styles().then(setStyles, () => setStyles([]));
  }, []);
  return (
    <div className="mb-3 space-y-1 border-b border-line pb-2">
      <div className="flex items-center justify-between">
        <span className="font-medium">Saved styles</span>
        <button
          type="button"
          className="text-ocean hover:underline"
          onClick={async () => {
            const name = await promptDialog("Style name", g.name, { title: "Save this graph's style" });
            if (!name) return;
            try {
              const st = await vertex.saveStyle({ name, layers: g.layers, edge_styles: g.edge_styles, line_type: g.line_type ?? null });
              setStyles((xs) => [...xs.filter((x) => x.id !== st.id), st].sort((a, b) => a.name.localeCompare(b.name)));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Save current
        </button>
      </div>
      {error && <p className="text-bad">{error}</p>}
      {styles.length === 0 && <p className="text-[11px] text-muted">Save the layer colors, icons, rules and edge styles to reuse them on other graphs.</p>}
      {styles.map((st) => (
        <div key={st.id} className="flex items-center gap-1">
          <button
            type="button"
            title="Apply: object types in the style take its layers; others keep theirs"
            onClick={() => update({ layers: { ...g.layers, ...st.layers }, edge_styles: { ...g.edge_styles, ...st.edge_styles }, ...(st.line_type ? { line_type: st.line_type } : {}) })}
            className="flex-1 truncate rounded px-1 py-0.5 text-left text-soft hover:bg-panel-2"
          >
            {st.name} <span className="text-muted">({Object.keys(st.layers).length} layers)</span>
          </button>
          <button type="button" onClick={() => vertex.deleteStyle(st.id).then(() => setStyles((xs) => xs.filter((x) => x.id !== st.id)))} className="text-muted hover:text-bad" aria-label="Delete style">
            <Icon name="x" className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
