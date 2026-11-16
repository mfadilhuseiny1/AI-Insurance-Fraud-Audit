"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { auth } from "@/lib/auth";
import { ontology, type OntologyObject } from "@/lib/ontology";
import { om, type ObjectLinks } from "@/lib/ontologyModel";
import { dragObjects } from "./CrossApp";
import { fillVars, fmt, METRIC_LABEL, paddingOf, sourceKey, workshop, type Module, type QueryResult, type SectionLayout, type Widget } from "@/lib/workshop";
import { Canvas } from "./Canvas";
import { pageWidgets, useModuleRuntime, valueOf } from "./ModuleRuntime";
import type { ModuleState } from "./WidgetView";

/** The object selected on an object type (by a table, a list or an object dropdown). */
function selectedOn(state: ModuleState, typeId?: string): string | undefined {
  return typeId ? state.selection[`object_type:${typeId}`] : undefined;
}

export function TabsWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const tabs = widget.config.tabs?.length ? widget.config.tabs : [{ id: "t1", name: "Tab 1" }];
  const cur = state.tabs?.[widget.id] && tabs.some((t) => t.id === state.tabs![widget.id]) ? state.tabs[widget.id] : tabs[0].id;
  // display optimization: tabs holding never-unmount widgets stay mounted (hidden) once visited; eager ones from the start
  const [visited, setVisited] = useState<string[]>([cur]);
  if (!visited.includes(cur)) setVisited([...visited, cur]);
  const kept = tabs.filter((t) => t.id !== cur && (state.keep?.eager.has(`${widget.id}:${t.id}`) || (state.keep?.never.has(`${widget.id}:${t.id}`) && visited.includes(t.id))));
  return (
    <div className="flex h-full flex-col" data-tabs={widget.id}>
      <div className="flex shrink-0 gap-1 border-b border-line px-2">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={(e) => (e.stopPropagation(), state.setTab?.(widget.id, t.id))} className={`border-b-2 px-3 py-1.5 text-xs ${cur === t.id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`} data-tab-id={t.id}>
            {state.tr?.(t.name) ?? t.name}
          </button>
        ))}
      </div>
      <div className={`min-h-0 flex-1 ${editing ? "bg-ink/40" : ""}`}>{state.renderContainer?.(`${widget.id}:${cur}`)}</div>
      {kept.map((t) => (
        <div key={t.id} className="hidden" data-kept-tab={t.id}>
          {state.renderContainer?.(`${widget.id}:${t.id}`)}
        </div>
      ))}
    </div>
  );
}

/** A section: its own container ("<id>:body") laid out as a grid, rows, columns, a toolbar or a scrolling flow; padding. */
export function SectionWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  return (
    <div className={`h-full min-h-0 ${editing ? "bg-ink/30" : ""}`} style={{ padding: paddingOf(widget.config.padding) }} data-section={widget.id}>
      {state.renderContainer?.(`${widget.id}:body`)}
    </div>
  );
}

export function ButtonGroupWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const buttons = widget.config.buttons ?? [];
  return (
    <div className="flex h-full flex-wrap items-center gap-2 px-3">
      {buttons.map((b, i) => (
        <button key={i} type="button" disabled={editing} onClick={() => state.runEvents?.(b.events)}
          className={`rounded-md px-3 py-1.5 text-sm ${b.style === "secondary" ? "border border-line-2 bg-panel-2 text-soft hover:text-white" : "bg-ocean text-white hover:bg-ocean-deep"}`}>
          {fillVars((b.label ? (state.tr?.(b.label) ?? b.label) : "") || `Button ${i + 1}`, state.variables)}
        </button>
      ))}
      {!buttons.length && <span className="text-xs text-muted">Add buttons in the panel</span>}
    </div>
  );
}

/** Text, numeric, date and toggle inputs write their module variable. */
export function InputWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const name = c.variable ?? "";
  const val = name ? state.variables[name] : undefined;
  if (!name) return <div className="p-3 text-xs text-muted">Choose the variable it writes</div>;
  if (widget.type === "toggle")
    return (
      <label className="flex h-full items-center gap-2 px-3 text-sm">
        <input type="checkbox" checked={!!val} onChange={(e) => state.setVariable(name, e.target.checked)} /> {c.label || name}
      </label>
    );
  const type = widget.type === "number_input" ? "number" : widget.type === "date_picker" ? "date" : "text";
  return (
    <div className="flex h-full items-center px-3">
      <input type={type} value={val === undefined || val === null ? "" : String(val)} placeholder={c.placeholder || c.label || name}
        onChange={(e) => state.setVariable(name, type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)}
        className="w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean" data-variable={name} />
    </div>
  );
}

export function StringSelectorWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const name = c.variable ?? "";
  const [opts, setOpts] = useState<string[]>([]);
  const spec = JSON.stringify([c.source, c.options_column]);
  useEffect(() => {
    if (!c.source || !c.options_column) return;
    let stale = false;
    workshop.query({ source: c.source, group_by: c.options_column, metric: "count", sort: "key", limit: 500 }).then((r) => !stale && setOpts((r.groups ?? []).map((g) => String(g.key ?? "")).filter(Boolean)), () => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  const options = c.options_column ? opts : (c.options ?? []);
  if (!name) return <div className="p-3 text-xs text-muted">Choose the variable it writes</div>;
  const val = state.variables[name];
  return (
    <div className="flex h-full items-center px-3">
      {c.multiple ? (
        <select multiple value={Array.isArray(val) ? (val as string[]) : []} onChange={(e) => state.setVariable(name, [...e.target.selectedOptions].map((o) => o.value))} className="h-full w-full rounded-md border border-line-2 bg-ink px-2 text-sm">
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <select value={val === undefined ? "" : String(val)} onChange={(e) => state.setVariable(name, e.target.value || undefined)} className="w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm" data-variable={name}>
          <option value="">{c.placeholder || "All"}</option>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export function ObjectDropdownWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const tid = c.source?.kind === "object_type" ? c.source.id : undefined;
  const [objs, setObjs] = useState<OntologyObject[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!tid) return;
    let stale = false;
    const t = setTimeout(() => ontology.objects(tid, q).then((r) => !stale && setObjs(r.objects.slice(0, 100)), () => {}), 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [tid, q]);
  if (!tid) return <div className="p-3 text-xs text-muted">Choose an object type</div>;
  const key = sourceKey(c.source);
  const cur = state.selection[key];
  return (
    <div className="flex h-full items-center gap-1 px-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="w-28 rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs" />
      <select value={cur ?? ""} onChange={(e) => {
        const pk = e.target.value || undefined;
        state.select(key, pk);
        if (c.variable) state.setVariable(c.variable, pk);
      }} className="min-w-0 flex-1 rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm">
        <option value="">{c.placeholder || "Select an object"}</option>
        {objs.map((o) => (
          <option key={o.primary_key} value={o.primary_key}>
            {o.title}
          </option>
        ))}
      </select>
    </div>
  );
}

export function UserSelectWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const name = widget.config.variable ?? "";
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    auth.users().then((us) => setUsers(us.map((u) => ({ id: u.id, name: u.display_name || u.username }))), () => auth.me().then((m) => m && setUsers([{ id: m.id, name: m.display_name || m.username }]), () => {}));
  }, []);
  if (!name) return <div className="p-3 text-xs text-muted">Choose the variable it writes</div>;
  return (
    <div className="flex h-full items-center px-3">
      <select value={String(state.variables[name] ?? "")} onChange={(e) => state.setVariable(name, e.target.value || undefined)} className="w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm">
        <option value="">{widget.config.placeholder || "Select a user"}</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Object list: cards with the title and a property; selecting one selects it (and runs its events). */
/**
 * Property security markings (informational): a gray pill with the markings a property's security policy requires.
 * Responsive: full when it fits, truncated otherwise; full: always whole (wraps); icon: the shield only. Selecting
 * it shows every marking.
 */
export function SecurityMarkings({ marks, mode }: { marks?: { id: string; name: string }[]; mode?: Widget["config"]["security_markings"] }) {
  const [open, setOpen] = useState(false);
  if (!mode || !marks?.length) return null;
  const text = marks.map((m) => m.name).join(" · ");
  return (
    <span className="relative inline-flex shrink-0 align-middle" data-security-marking>
      <span
        role="button"
        tabIndex={0}
        title={text}
        onClick={(e) => (e.stopPropagation(), setOpen(!open))}
        onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}
        className={`inline-flex items-center gap-1 rounded-full bg-panel-2 px-1.5 text-[10px] text-soft ${mode === "responsive" ? "max-w-32" : ""} ${mode === "full" ? "whitespace-normal" : "whitespace-nowrap"}`}
      >
        <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 shrink-0" fill="currentColor" aria-hidden><path d="M8 1l6 2.5V8c0 3.3-2.6 6-6 7-3.4-1-6-3.7-6-7V3.5z" /></svg>
        {mode !== "icon" && <span className={mode === "responsive" ? "truncate" : ""}>{text}</span>}
      </span>
      {open && (
        <span className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-line bg-panel p-2 text-[11px] shadow-xl">
          <span className="block font-medium text-soft">Security markings</span>
          {marks.map((m) => (
            <span key={m.id} className="mt-0.5 block text-muted">{m.name}</span>
          ))}
        </span>
      )}
    </span>
  );
}

export function ObjectListWidget({ widget, state, result }: { widget: Widget; state: ModuleState; result: QueryResult }) {
  const c = widget.config;
  const key = sourceKey(c.source);
  const title = c.columns?.[0];
  // reordering: the user's order (primary keys) over the result, written to the order variable
  const [order, setOrder] = useState<string[] | null>(null);
  // the card being dragged (a ref: the drop can come before a re-render)
  const dragPk = useRef<string | null>(null);
  const rows = (result.rows ?? []).slice(0, c.reorderable ? 500 : undefined);
  const byPk = new Map(rows.map((r, i) => [String(r.__pk ?? i), r]));
  const ordered = order ? [...order.filter((pk) => byPk.has(pk)), ...[...byPk.keys()].filter((pk) => !order.includes(pk))].map((pk) => byPk.get(pk)!) : rows;
  const move = (from: string, to: string) => {
    const keys = ordered.map((r, i) => String(r.__pk ?? i));
    const next = keys.filter((k) => k !== from);
    next.splice(next.indexOf(to), 0, from);
    setOrder(next);
    if (c.order_variable) state.setVariable(c.order_variable, next);
  };
  return (
    <div className="h-full space-y-1 overflow-auto p-2">
      {ordered.map((r, i) => {
        const pk = r.__pk ?? String(i);
        const on = state.selection[key] === pk;
        return (
          <button key={pk} type="button"
            draggable={!!c.reorderable || !!c.enable_drag}
            onDragStart={(e) => {
              dragPk.current = String(pk);
              if (c.source?.kind === "object_type") dragObjects(e, c.source.id, [String(pk)]);
            }}
            onDragOver={(e) => c.reorderable && dragPk.current && e.preventDefault()}
            onDrop={(e) => {
              if (!c.reorderable || !dragPk.current || dragPk.current === String(pk)) return;
              e.preventDefault();
              move(dragPk.current, String(pk));
              dragPk.current = null;
            }}
            onClick={() => {
            state.select(key, on ? undefined : pk);
            if (!on && c.on_select?.length) void state.runEvents?.(c.on_select);
          }} className={`block w-full rounded-md border px-3 py-2 text-left text-sm ${on ? "border-ocean bg-ocean/10" : "border-line hover:border-ocean/50"}`} data-row={pk}>
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{fmt(title ? r[title] : pk)}</span>
              {title && <SecurityMarkings marks={r.__markings?.[title]} mode={c.security_markings} />}
            </div>
            {c.subtitle_property && (
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <span className="truncate">{fmt(r[c.subtitle_property])}</span>
                <SecurityMarkings marks={r.__markings?.[c.subtitle_property]} mode={c.security_markings} />
              </div>
            )}
          </button>
        );
      })}
      {!result.rows?.length && <p className="p-2 text-xs text-muted">No objects</p>}
    </div>
  );
}

export function PropertyListWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const tid = c.source?.kind === "object_type" ? c.source.id : undefined;
  const pk = (c.object_pk ? String(valueOf(c.object_pk, state.variables) ?? "") : "") || selectedOn(state, tid);
  const [obj, setObj] = useState<OntologyObject | null>(null);
  useEffect(() => {
    if (!tid || !pk) return;
    let stale = false;
    ontology.object(tid, pk).then((o) => !stale && setObj(o), () => !stale && setObj(null));
    return () => {
      stale = true;
    };
  }, [tid, pk, state.version]);
  if (!tid) return <div className="p-3 text-xs text-muted">Choose an object type</div>;
  if (!pk) return <div className="p-3 text-xs text-muted">Select an object</div>;
  if (!obj) return <div className="p-3 text-xs text-muted">Loading…</div>;
  const props = c.properties?.length ? c.properties : Object.keys(obj.properties);
  return (
    <div className="h-full overflow-auto p-3 text-sm">
      <div className="mb-2 font-semibold">{obj.title}</div>
      {props.map((p) => (
        <div key={p} className="flex gap-3 border-t border-line py-1">
          <span className="w-40 shrink-0 truncate text-xs text-muted">{p}</span>
          <span className="min-w-0 flex-1 truncate">{fmt(obj.properties[p])}</span>
          <SecurityMarkings marks={obj.property_markings?.[p]} mode={c.security_markings} />
        </div>
      ))}
    </div>
  );
}

export function LinkedObjectsWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const tid = c.source?.kind === "object_type" ? c.source.id : undefined;
  const pk = selectedOn(state, tid);
  const [links, setLinks] = useState<ObjectLinks[] | null>(null);
  useEffect(() => {
    if (!tid || !pk) return;
    let stale = false;
    om.objectLinks(tid, pk).then((l) => !stale && setLinks(l), () => !stale && setLinks([]));
    return () => {
      stale = true;
    };
  }, [tid, pk, state.version]);
  if (!tid) return <div className="p-3 text-xs text-muted">Choose an object type</div>;
  if (!pk) return <div className="p-3 text-xs text-muted">Select an object</div>;
  const shown = (links ?? []).filter((l) => !c.link_type_id || l.link_type_id === c.link_type_id);
  return (
    <div className="h-full space-y-2 overflow-auto p-3 text-sm">
      {shown.map((l) => (
        <div key={`${l.link_type_id}:${l.direction}`}>
          <div className="text-xs font-medium text-soft">
            {l.name} <span className="text-muted">({l.count})</span>
          </div>
          {l.objects.slice(0, 50).map((o) => (
            <button key={o.primary_key} type="button" onClick={() => state.select(`object_type:${l.object_type_id}`, o.primary_key)} className="block w-full truncate rounded px-1 py-0.5 text-left text-xs hover:bg-panel-2">
              {o.title}
            </button>
          ))}
        </div>
      ))}
      {links && !shown.length && <p className="text-xs text-muted">No linked objects</p>}
    </div>
  );
}

/** Pivot table: a measure over rows × columns, from up to 5,000 rows. */
export function PivotWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const [rows, setRows] = useState<QueryResult["rows"] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // scenarios [Legacy]: "Load data from scenario"
  const scenarioId = c.scenario_variable ? String(state.variables[c.scenario_variable] ?? "") || undefined : undefined;
  const spec = JSON.stringify([c.source, c.pivot_rows, c.pivot_columns, c.metric_column, state.filters[sourceKey(c.source)], state.version, scenarioId]);
  useEffect(() => {
    if (!c.source || !c.pivot_rows || !c.pivot_columns) return;
    let stale = false;
    const extra = Object.entries(state.filters[sourceKey(c.source)] ?? {}).filter(([k, v]) => !k.startsWith("__") && v !== undefined && v !== "").map(([column, value]) => ({ column, op: "eq" as const, value }));
    workshop
      .query({ source: c.source, columns: [c.pivot_rows, c.pivot_columns, ...(c.metric_column ? [c.metric_column] : [])], additional_filters: extra, limit: 5000, scenario_id: scenarioId })
      .then((r) => !stale && (setRows(r.rows ?? []), setErr(null)), (e: Error) => !stale && setErr(e.message));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  const table = useMemo(() => {
    if (!rows || !c.pivot_rows || !c.pivot_columns) return null;
    const metric = c.metric ?? "count";
    const cells: Record<string, Record<string, number[]>> = {};
    const cols = new Set<string>();
    for (const r of rows) {
      const a = fmt(r[c.pivot_rows]);
      const b = fmt(r[c.pivot_columns]);
      cols.add(b);
      ((cells[a] ??= {})[b] ??= []).push(Number(c.metric_column ? r[c.metric_column] : 1) || 0);
    }
    const agg = (xs?: number[]) => {
      if (!xs?.length) return null;
      if (metric === "count") return xs.length;
      if (metric === "sum") return xs.reduce((s, x) => s + x, 0);
      if (metric === "avg") return xs.reduce((s, x) => s + x, 0) / xs.length;
      if (metric === "min") return Math.min(...xs);
      if (metric === "max") return Math.max(...xs);
      return new Set(xs).size;
    };
    const colList = [...cols].sort().slice(0, 30);
    return { colList, rowList: Object.keys(cells).sort().slice(0, 200).map((k) => ({ key: k, values: colList.map((col) => agg(cells[k][col])) })) };
  }, [rows, c.pivot_rows, c.pivot_columns, c.metric, c.metric_column]);
  if (!c.source || !c.pivot_rows || !c.pivot_columns) return <div className="p-3 text-xs text-muted">Choose a source, row and column</div>;
  if (err) return <div className="p-3 text-xs text-bad">{err}</div>;
  if (!table) return <div className="p-3 text-xs text-muted">Loading…</div>;
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-panel">
          <tr>
            <th className="px-2 py-1 text-left font-medium text-muted">
              {c.pivot_rows} \ {c.pivot_columns} · {METRIC_LABEL[c.metric ?? "count"]}
            </th>
            {table.colList.map((col) => (
              <th key={col} className="px-2 py-1 text-right font-medium">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rowList.map((r) => (
            <tr key={r.key} className="border-t border-line">
              <td className="px-2 py-1">{r.key}</td>
              {r.values.map((v, i) => (
                <td key={i} className="px-2 py-1 text-right tabular-nums">
                  {v === null ? "" : fmt(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IframeWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const url = fillVars(widget.config.url ?? "", state.variables);
  if (!url) return <div className="p-3 text-xs text-muted">Set the URL</div>;
  return <iframe src={url} title={widget.title || "Embedded page"} className={`h-full w-full border-0 ${editing ? "pointer-events-none" : ""}`} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" data-iframe-widget={widget.id} />;
}

/** Another module inside this one: its published version, its variables set from this module's. */
export function EmbeddedModuleWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const [mod, setMod] = useState<Module | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const self = !!c.module_id && c.module_id === state.moduleId;
  useEffect(() => {
    if (!c.module_id || self) return;
    let stale = false;
    workshop.moduleAt(c.module_id, { published: true }).then((m) => !stale && setMod(m), (e: Error) => !stale && setErr(e.message));
    return () => {
      stale = true;
    };
  }, [c.module_id, self]);
  const params = useMemo(() => Object.fromEntries(Object.entries(c.module_params ?? {}).map(([k, v]) => [k, valueOf(v, state.variables)])), [c.module_params, state.variables]);
  if (!c.module_id) return <div className="p-3 text-xs text-muted">Choose the module to embed</div>;
  if (self) return <div className="p-3 text-xs text-bad">A module cannot embed itself</div>;
  if (err) return <div className="p-3 text-xs text-bad">{err}</div>;
  if (!mod) return <div className="p-3 text-xs text-muted">Loading…</div>;
  return <EmbeddedBody key={JSON.stringify(params)} mod={mod} params={params} />;
}

/** A module running inside another widget (embedded module, loop, an object view's Workshop tab), its variables from params. */
export function EmbeddedBody({ mod, params }: { mod: Module; params: Record<string, unknown> }) {
  const renderCanvas = (key: string, ws: Widget[], layout?: SectionLayout) => <Canvas nested layout={layout} minRows={4} widgets={ws} editing={false} selected={null} onSelect={() => {}} onChange={() => {}} onDrop={() => {}} state={rt.state} key={key} />;
  const rt = useModuleRuntime(mod, { initial: params, renderCanvas });
  return (
    <div className="h-full" data-embedded={mod.id}>
      <Canvas nested minRows={4} widgets={pageWidgets(mod, rt.page)} editing={false} selected={null} onSelect={() => {}} onChange={() => {}} onDrop={() => {}} state={rt.state} />
    </div>
  );
}

/** Loop layout: one instance of a module per entry of an array variable, or per object of an object set (its own variable scope each). */
export function LoopWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const [mod, setMod] = useState<Module | null>(null);
  const [rows, setRows] = useState<string[] | null>(null);
  const [pageNo, setPageNo] = useState(0);
  const self = !!c.module_id && c.module_id === state.moduleId;
  useEffect(() => {
    if (!c.module_id || self) return;
    let stale = false;
    workshop.moduleAt(c.module_id, { published: true }).then((m) => !stale && setMod(m), () => {});
    return () => {
      stale = true;
    };
  }, [c.module_id, self]);
  const objects = c.loop_mode === "objects";
  const filters = useMemo(() => (c.filters ?? []).map((f) => ({ ...f, value: valueOf(f.value, state.variables) })), [c.filters, state.variables]);
  const spec = JSON.stringify([objects, c.source, filters, c.sort, c.descending, state.version]);
  useEffect(() => {
    if (!objects || !c.source) return;
    let stale = false;
    workshop.query({ source: c.source, filters, sort: c.sort, descending: c.descending, columns: [], limit: 5000 }).then((r) => !stale && setRows((r.rows ?? []).map((x) => String(x.__pk ?? ""))), () => !stale && setRows([]));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  const shared = useMemo(() => Object.fromEntries(Object.entries(c.module_params ?? {}).map(([k, v]) => [k, valueOf(v, state.variables)])), [c.module_params, state.variables]);
  if (!c.module_id) return <div className="p-3 text-xs text-muted">Choose the module to repeat</div>;
  if (self) return <div className="p-3 text-xs text-bad">A module cannot loop over itself</div>;
  if (!c.loop_interface) return <div className="p-3 text-xs text-muted">Choose the module variable each entry goes to</div>;
  const items: unknown[] = objects ? (rows ?? []) : ((): unknown[] => {
    const v = c.loop_variable ? state.variables[c.loop_variable] : undefined;
    return Array.isArray(v) ? v : [];
  })();
  const size = Math.max(1, c.per_page ?? 10);
  const paged = c.paging === "paged";
  const shown = paged ? items.slice(pageNo * size, pageNo * size + size) : items.slice(0, size);
  const pages = Math.ceil(items.length / size);
  if (!mod) return <div className="p-3 text-xs text-muted">Loading…</div>;
  return (
    <div className="flex h-full flex-col" data-loop={widget.id}>
      <div className={`min-h-0 flex-1 overflow-auto p-2 ${c.display === "grid" ? "grid gap-2" : "space-y-2"}`} style={c.display === "grid" ? { gridTemplateColumns: `repeat(${Math.max(1, c.grid_columns ?? 3)}, minmax(0, 1fr))` } : undefined}>
        {shown.map((item, i) => (
          <div key={`${pageNo}:${i}:${typeof item === "object" ? JSON.stringify(item) : String(item)}`} className="h-56 overflow-hidden rounded-lg border border-line" data-loop-item={i}>
            <EmbeddedBody mod={mod} params={{ ...shared, [c.loop_interface!]: item }} />
          </div>
        ))}
        {!shown.length && <p className="p-2 text-xs text-muted">{objects && rows === null ? "Loading…" : "Nothing to loop over"}</p>}
      </div>
      {paged && pages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-line py-1 text-xs">
          <button type="button" disabled={pageNo === 0} onClick={() => setPageNo(pageNo - 1)} className="disabled:opacity-30">
            ‹
          </button>
          {pageNo + 1} / {pages}
          <button type="button" disabled={pageNo >= pages - 1} onClick={() => setPageNo(pageNo + 1)} className="disabled:opacity-30">
            ›
          </button>
        </div>
      )}
    </div>
  );
}
