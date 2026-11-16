"use client";

/** Workshop's Custom widget: a widget set's widget with its parameters bound to the module (constants, the selected
 *  object, a filter, an object type's filtered objects as an object set) and its events bound back (update those
 *  bindings, open a URL, refresh the module). */
import { useEffect, useMemo, useState } from "react";
import { WidgetFrame } from "@/components/customWidgets/WidgetFrame";
import { widgetSets, type Loaded, type WidgetSetSummary } from "@/lib/customWidgets";
import { sourceKey, type Sources, type Widget, type WidgetConfig } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";

export type ParamBinding =
  | { kind: "constant"; value: unknown }
  | { kind: "selection"; object_type_id: string }
  | { kind: "filter"; source: string; column: string }
  | { kind: "objectSet"; object_type_id: string }
  /** a module variable (scenario parameters: a scenario variable, whose id the widget passes to its OSDK calls) */
  | { kind: "variable"; name: string };
export type EventBinding = { kind: "openUrl"; url: string } | { kind: "refresh" };

export function CustomWidgetHost({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const bindings = useMemo(() => (c.custom_params ?? {}) as Record<string, ParamBinding>, [c.custom_params]);
  const values = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, b] of Object.entries(bindings)) {
      if (b.kind === "constant") out[k] = k in local ? local[k] : b.value;
      else if (b.kind === "selection") out[k] = state.selection[sourceKey({ kind: "object_type", id: b.object_type_id })] ?? null;
      else if (b.kind === "filter") out[k] = state.filters[b.source]?.[b.column] ?? null;
      else if (b.kind === "variable") out[k] = state.variables[b.name] ?? null;
      else if (b.kind === "objectSet") {
        const f = state.filters[sourceKey({ kind: "object_type", id: b.object_type_id })] ?? {};
        out[k] = {
          objectType: b.object_type_id,
          filters: Object.entries(f)
            .filter(([col, v]) => !col.startsWith("__") && v !== undefined && v !== "")
            .map(([column, value]) => ({ column, op: "eq", value })),
          version: state.version,
        };
      }
    }
    return out;
  }, [bindings, local, state.selection, state.filters, state.variables, state.version]);
  if (!c.custom_set_id || !c.custom_widget_id) return <div className="flex h-full items-center justify-center text-xs text-muted">Choose a widget set and a widget in the panel on the right.</div>;
  return (
    <div className={`h-full ${c.custom_auto_height ? "overflow-auto" : ""} ${editing ? "pointer-events-none" : ""}`}>
      <WidgetFrame
        setId={c.custom_set_id}
        widgetId={c.custom_widget_id}
        version={c.custom_version || undefined}
        values={values}
        granted={c.custom_permissions ?? []}
        autoHeight={!!c.custom_auto_height}
        theme={typeof document !== "undefined" && document.documentElement.classList.contains("light") ? "light" : "dark"}
        onEvent={(eventId, updates) => {
          for (const [k, v] of Object.entries(updates)) {
            const b = bindings[k];
            if (!b || b.kind === "constant") setLocal((x) => ({ ...x, [k]: v }));
            else if (b.kind === "filter") state.setFilter(b.source, b.column, v === null ? undefined : v);
            else if (b.kind === "variable") state.setVariable(b.name, v);
            else if (b.kind === "selection") state.select(sourceKey({ kind: "object_type", id: b.object_type_id }), v === null || v === undefined ? undefined : String(v));
          }
          for (const e of ((c.custom_events ?? {}) as Record<string, EventBinding[]>)[eventId] ?? []) {
            if (e.kind === "refresh") state.bump();
            if (e.kind === "openUrl") {
              const url = e.url.replace(/\{(\w+)\}/g, (_, p: string) => encodeURIComponent(String(updates[p] ?? values[p] ?? "")));
              if (/^(https?:|\/)/.test(url) && (url.startsWith("/") || window.confirm(`Open ${url}?`))) window.open(url, url.startsWith("/") ? "_self" : "_blank", "noopener");
            }
          }
        }}
      />
    </div>
  );
}

const field = "w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean";

export function CustomWidgetConfig({ widget, set, sources, variables = [] }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; sources: Sources; variables?: { name: string; type: string }[] }) {
  const c = widget.config;
  const [sets, setSets] = useState<WidgetSetSummary[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    widgetSets.list().then(setSets, (e: Error) => setErr(e.message));
  }, []);
  const current = sets.find((s) => s.id === c.custom_set_id);
  useEffect(() => {
    if (!c.custom_set_id || !c.custom_widget_id) return;
    let stale = false;
    widgetSets.load(c.custom_set_id, c.custom_widget_id, c.custom_version || undefined).then(
      (l) => !stale && setLoaded(l),
      (e: Error) => !stale && setErr(e.message),
    );
    return () => {
      stale = true;
    };
  }, [c.custom_set_id, c.custom_widget_id, c.custom_version]);
  const params = (c.custom_params ?? {}) as Record<string, ParamBinding>;
  const events = (c.custom_events ?? {}) as Record<string, EventBinding[]>;
  const objectSources = sources.object_types;
  const w = loaded && loaded.widget.id === c.custom_widget_id ? loaded.widget : null;
  return (
    <div className="space-y-3 text-xs">
      {err && <p className="text-bad">{err}</p>}
      <label className="block text-muted">
        Widget set
        <select value={c.custom_set_id ?? ""} onChange={(e) => set({ custom_set_id: e.target.value || undefined, custom_widget_id: undefined, custom_version: undefined, custom_params: {}, custom_events: {} })} className={`${field} mt-1`}>
          <option value="">Choose…</option>
          {sets.filter((s) => s.latest).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-muted">
            Version
            <select value={c.custom_version ?? ""} onChange={(e) => set({ custom_version: e.target.value || undefined })} className={`${field} mt-1`}>
              <option value="">Latest ({current.latest})</option>
              {current.versions.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="block text-muted">
            Widget
            <select value={c.custom_widget_id ?? ""} onChange={(e) => set({ custom_widget_id: e.target.value || undefined, custom_params: {}, custom_events: {} })} className={`${field} mt-1`}>
              <option value="">Choose…</option>
              {current.widgets.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {w && (
        <>
          <div className="font-medium text-soft">Parameters</div>
          {Object.entries(w.parameters).map(([k, p]) => {
            const b = params[k] ?? { kind: "constant", value: null };
            const put = (nb: ParamBinding) => set({ custom_params: { ...params, [k]: nb } });
            return (
              <div key={k} className="space-y-1 rounded border border-line p-2">
                <div className="text-muted">
                  {p.displayName ?? k} <span className="font-mono text-[10px]">{p.type}</span>
                </div>
                <select
                  value={b.kind}
                  onChange={(e) => {
                    const kind = e.target.value as ParamBinding["kind"];
                    put(kind === "constant" ? { kind, value: null } : kind === "filter" ? { kind, source: "", column: "" } : kind === "variable" ? { kind, name: "" } : { kind, object_type_id: objectSources[0]?.id ?? "" });
                  }}
                  className={field}
                >
                  <option value="constant">A value</option>
                  {p.type !== "objectSet" && <option value="selection">The object selected in a table (primary key)</option>}
                  {p.type !== "objectSet" && <option value="filter">A filter value of a source</option>}
                  {p.type === "objectSet" && <option value="objectSet">An object type, with the module&apos;s filters</option>}
                  {p.type !== "objectSet" && <option value="variable">A module variable{p.type === "scenario" ? " (a scenario)" : ""}</option>}
                </select>
                {b.kind === "variable" && (
                  <select value={b.name} onChange={(e) => put({ kind: "variable", name: e.target.value })} className={field} data-param-variable={k}>
                    <option value="">Variable…</option>
                    {variables.filter((v) => (p.type === "scenario" ? v.type === "scenario" : p.type === "array" ? v.type.includes("array") : !v.type.startsWith("object_set"))).map((v) => (
                      <option key={v.name}>{v.name}</option>
                    ))}
                  </select>
                )}
                {b.kind === "constant" && (
                  <input
                    defaultValue={b.value === null || b.value === undefined ? "" : typeof b.value === "string" ? b.value : JSON.stringify(b.value)}
                    onBlur={(e) => {
                      let v: unknown = e.target.value;
                      if (p.type === "number") v = Number(e.target.value);
                      else if (p.type === "boolean") v = e.target.value === "true";
                      else if (p.type === "array")
                        try {
                          v = JSON.parse(e.target.value || "[]");
                        } catch {
                          v = [];
                        }
                      put({ kind: "constant", value: v });
                    }}
                    placeholder={p.type === "array" ? '["a","b"]' : p.type}
                    className={`${field} font-mono`}
                  />
                )}
                {(b.kind === "selection" || b.kind === "objectSet") && (
                  <select value={b.object_type_id} onChange={(e) => put({ ...b, object_type_id: e.target.value })} className={field}>
                    {objectSources.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
                {b.kind === "filter" && (
                  <div className="grid grid-cols-2 gap-1">
                    <select value={b.source} onChange={(e) => put({ ...b, source: e.target.value, column: "" })} className={field}>
                      <option value="">Source…</option>
                      {objectSources.map((t) => (
                        <option key={t.id} value={`object_type:${t.id}`}>
                          {t.name}
                        </option>
                      ))}
                      {sources.datasets.map((d) => (
                        <option key={d.id} value={`dataset:${d.id}`}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <select value={b.column} onChange={(e) => put({ ...b, column: e.target.value })} className={field}>
                      <option value="">Column…</option>
                      {(objectSources.find((t) => `object_type:${t.id}` === b.source)?.properties ?? []).map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            );
          })}
          <div className="font-medium text-soft">Events</div>
          {Object.entries(w.events).map(([k, e]) => (
            <div key={k} className="space-y-1 rounded border border-line p-2">
              <div className="text-muted">
                {e.displayName ?? k}: updates {(e.parameterUpdateIds ?? []).join(", ") || "nothing"} (through the bindings above)
              </div>
              {(events[k] ?? []).map((x, i) => (
                <div key={i} className="flex gap-1">
                  {x.kind === "openUrl" ? (
                    <input value={x.url} onChange={(ev) => set({ custom_events: { ...events, [k]: (events[k] ?? []).map((y, j) => (j === i ? { kind: "openUrl", url: ev.target.value } : y)) } })} placeholder="https://… or /object-explorer?…{parameterId}" className={`${field} font-mono`} />
                  ) : (
                    <span className="flex-1 py-1">Refresh the module&apos;s data</span>
                  )}
                  <button type="button" onClick={() => set({ custom_events: { ...events, [k]: (events[k] ?? []).filter((_, j) => j !== i) } })} className="text-muted hover:text-bad">
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <button type="button" onClick={() => set({ custom_events: { ...events, [k]: [...(events[k] ?? []), { kind: "openUrl", url: "" }] } })} className="text-ocean">
                  + Open URL
                </button>
                <button type="button" onClick={() => set({ custom_events: { ...events, [k]: [...(events[k] ?? []), { kind: "refresh" }] } })} className="text-ocean">
                  + Refresh data
                </button>
              </div>
            </div>
          ))}
          {w.permissions.length > 0 && (
            <>
              <div className="font-medium text-soft">Permissions</div>
              {w.permissions.map((p) => (
                <label key={p} className="flex items-center gap-2 text-muted">
                  <input
                    type="checkbox"
                    checked={(c.custom_permissions ?? []).includes(p)}
                    onChange={(e) => {
                      if (e.target.checked && !window.confirm(`Allow this widget ${p}? It is custom code from the widget set ${current?.name}.`)) return;
                      set({ custom_permissions: e.target.checked ? [...(c.custom_permissions ?? []), p] : (c.custom_permissions ?? []).filter((x) => x !== p) });
                    }}
                  />
                  {p}
                </label>
              ))}
            </>
          )}
          <label className="flex items-center gap-2 text-muted">
            <input type="checkbox" checked={!!c.custom_auto_height} onChange={(e) => set({ custom_auto_height: e.target.checked })} /> Size to the widget&apos;s content (auto height)
          </label>
        </>
      )}
    </div>
  );
}
