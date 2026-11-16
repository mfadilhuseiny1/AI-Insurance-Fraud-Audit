"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfiguredObjectView } from "@/components/ontology/ConfiguredObjectView";
import { AppHeader, Card, ErrorBox, ObjectPicker } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { promptDialog } from "@/lib/dialogs";
import { forms, type FormField } from "@/lib/forms";
import { ontology, request, type ObjectType } from "@/lib/ontology";
import { om, type LinkType } from "@/lib/ontologyModel";
import { tsOntology, type PublishedDashboardRow } from "@/lib/timeseries";

type Tab = {
  id?: string;
  title: string;
  kind: "properties" | "links" | "chart" | "linked_view" | "map" | "timeseries" | "html" | "timeline" | "edit_history" | "comments" | "form" | "workshop" | "quiver_dashboard" | "url";
  dashboard_id?: string | null;
  properties: string[];
  geo_property?: string | null;
  linked_geo_property?: string | null;
  label_property?: string | null;
  ts_source?: "object" | "linked";
  ts_properties?: string[];
  ts_sensors?: boolean;
  ts_range?: string | null;
  html?: string | null;
  height?: number;
  filters?: string[];
  group_by?: string | null;
  metric?: "count" | "sum" | "avg" | "min" | "max";
  value_property?: string | null;
  chart?: "bar" | "pie";
  linked_properties?: string[];
  link_type_id?: string | null;
  direction?: "forward" | "reverse";
  module_id?: string | null;
  form_id?: string | null;
  form_prefill?: Record<string, string>;
  form_conditions?: { property: string; op: "eq" | "neq"; value: string; form_id: string }[];
  form_no_header?: boolean;
  form_mode?: "object" | "create_linked";
  form_copy_last?: boolean;
  form_last_sort?: string | null;
  url?: string | null;
  visibility?: { kind: "property"; property: string; op: "eq" | "neq"; value: string } | { kind: "link"; link_type_id: string } | null;
};
type Config = { tabs: Tab[]; header_properties: string[]; panel_properties: string[]; set_panel_aggregates: { metric: string; property?: string }[]; sidebar: { label: string; app: string; url?: string }[] };
type Views = {
  auto_publish: boolean;
  published: number | null;
  configured: boolean;
  versions: { version: number; at: string; author: string; description: string; is_published: boolean; was_published: boolean }[];
  latest: Config;
  config: Config;
};

const api = {
  get: (typeId: string) => request<Views>(`/object-types/${typeId}/views`),
  save: (typeId: string, config: Config, description: string, auto_publish?: boolean) => request<Views>(`/object-types/${typeId}/views`, { method: "POST", json: { config, description, auto_publish } }),
  publish: (typeId: string, version: number) => request<Views>(`/object-types/${typeId}/views/publish`, { method: "POST", json: { version } }),
  restore: (typeId: string, version: number) => request<Views>(`/object-types/${typeId}/views/restore`, { method: "POST", json: { version } }),
};
const KINDS: [Tab["kind"], string][] = [
  ["properties", "Properties"],
  ["links", "Linked objects"],
  ["chart", "Chart of linked objects"],
  ["linked_view", "Linked object views"],
  ["map", "Map"],
  ["timeseries", "Time series"],
  ["html", "HTML"],
  ["timeline", "Timeline"],
  ["edit_history", "Edit history"],
  ["comments", "Comments"],
  ["form", "Form"],
  ["workshop", "Workshop module"],
  ["quiver_dashboard", "Quiver dashboard"],
  ["url", "Link"],
];

/**
 * Object Views: configure an object type's full and panel views — tabs (order, content, conditional visibility),
 * header and panel properties, object set panel aggregates and the applications sidebar — with versions that are
 * saved, published (automatically or by hand) and restored, previewed on any object.
 */
export default function ObjectViewsPage() {
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [links, setLinks] = useState<LinkType[]>([]);
  const [dashboards, setDashboards] = useState<PublishedDashboardRow[]>([]);
  const [formList, setFormList] = useState<{ id: string; name: string }[]>([]);
  const [typeId, setTypeId] = useState("");
  const [views, setViews] = useState<Views | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [pk, setPk] = useState("");
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tsOntology.publishedDashboards().then(setDashboards, () => undefined);
    forms.list().then((l) => setFormList(l.map((f) => ({ id: f.id, name: f.name.replace(/\.form$/, "") }))), () => undefined);
    Promise.all([ontology.objectTypes(), om.linkTypes()]).then(
      ([t, l]) => {
        setTypes(t);
        setLinks(l);
        setTypeId(t[0]?.id ?? "");
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  const load = useCallback(() => {
    if (!typeId) return;
    api.get(typeId).then(
      (v) => {
        setViews(v);
        setCfg(v.latest);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [typeId]);
  useEffect(load, [load]);
  // the time series properties of this type and of the types its time series tabs chart (fetched once per type)
  const [tsps, setTsps] = useState<Record<string, string[]>>({});
  const tsTypes = [
    ...new Set(
      cfg?.tabs.flatMap((x) => {
        if (x.kind !== "timeseries") return [];
        if (x.ts_source !== "linked") return [typeId];
        const lt = links.find((l) => l.id === x.link_type_id);
        return lt ? [(x.direction === "reverse" ? lt.source : lt.target).object_type_id] : [];
      }) ?? [],
    ),
  ].filter((id) => id && !(id in tsps));
  const tsKey = tsTypes.join(",");
  useEffect(() => {
    for (const id of tsKey ? tsKey.split(",") : [])
      tsOntology.config(id).then(
        (c) => setTsps((m) => ({ ...m, [id]: Object.keys(c.properties ?? {}) })),
        () => setTsps((m) => ({ ...m, [id]: [] })),
      );
  }, [tsKey]);
  if (error && !types) return <ApiError message={error} />;
  if (!types) return <Loading />;
  const t = types.find((x) => x.id === typeId);
  const props = t?.properties ?? [];
  const outLinks = links.flatMap((l) => [
    ...(l.source.object_type_id === typeId ? [{ l, direction: "forward" as const, label: `${l.display_name} →` }] : []),
    ...(l.target.object_type_id === typeId ? [{ l, direction: "reverse" as const, label: `← ${l.display_name}` }] : []),
  ]);
  const setTab = (i: number, c: Partial<Tab>) => cfg && setCfg({ ...cfg, tabs: cfg.tabs.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const run = async (fn: () => Promise<Views>) => {
    try {
      const v = await fn();
      setViews(v);
      setCfg(v.latest);
      setTick((x) => x + 1);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Object Views" icon="layers" href="/object-views" crumbs={t ? [{ label: t.display_name }] : []}>
        {views && cfg && (
          <>
            <label className="flex items-center gap-1 text-xs" title="Automatically publish">
              <input type="checkbox" checked={views.auto_publish} onChange={(e) => run(() => api.save(typeId, cfg, "Changed publishing", e.target.checked))} />
              <span className="hidden sm:inline">Automatically publish</span>
              <span className="sm:hidden">Auto</span>
            </label>
            <button
              type="button"
              onClick={async () => {
                const d = await promptDialog("Describe this version", "", { title: "Save Object View" });
                if (d !== null) await run(() => api.save(typeId, cfg, d));
              }}
              className={buttonClass.primary}
            >
              <Icon name="save" className="h-3.5 w-3.5" /> Save
              {views.auto_publish && <span className="hidden sm:inline"> and publish</span>}
            </button>
          </>
        )}
      </AppHeader>
      {/* below 768 px the settings and the preview stack and scroll together */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <aside className="min-w-0 space-y-3 border-b border-line bg-panel p-3 text-xs md:w-[420px] md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">
          <select value={typeId} onChange={(e) => (setTypeId(e.target.value), setPk(""), setPreviewVersion(null))} className={inputClass} aria-label="Object type">
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.display_name}
              </option>
            ))}
          </select>
          <ErrorBox message={error} />
          {views && cfg && (
            <>
              <Card title="Versions" count={views.versions.length}>
                <div className="max-h-48 divide-y divide-line overflow-y-auto">
                  {!views.versions.length && <div className="p-3 text-muted">Default view (not configured). Save to create version 1.</div>}
                  {views.versions.map((v) => (
                    <div key={v.version} className="flex items-center gap-2 px-3 py-1.5">
                      <span className={v.is_published ? "text-ok" : v.was_published ? "text-muted" : "text-transparent"}>✓</span>
                      <span className="font-medium">v{v.version}</span>
                      <span className="min-w-0 flex-1 truncate text-muted" title={`${v.description} · ${v.author} · ${v.at}`}>
                        {v.description}
                      </span>
                      <button type="button" onClick={() => setPreviewVersion(v.version)} className="text-ocean">
                        Preview
                      </button>
                      {!v.is_published && (
                        <button type="button" onClick={() => run(() => api.publish(typeId, v.version))} className="text-ocean">
                          Publish
                        </button>
                      )}
                      <button type="button" onClick={() => run(() => api.restore(typeId, v.version))} className="text-muted hover:text-white">
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="Tabs" count={cfg.tabs.length}>
                <div className="space-y-2 p-3">
                  {cfg.tabs.map((tab, i) => (
                    <div key={tab.id ?? i} className="space-y-1.5 rounded border border-line p-2">
                      <div className="flex items-center gap-1">
                        <input value={tab.title} onChange={(e) => setTab(i, { title: e.target.value })} className={`${fieldClass} min-w-0 flex-1`} aria-label="Tab title" />
                        <select value={tab.kind} onChange={(e) => setTab(i, { kind: e.target.value as Tab["kind"] })} className={`${fieldClass} w-32 min-w-0 shrink sm:w-40`} aria-label="Tab kind">
                          {KINDS.map(([k, l]) => (
                            <option key={k} value={k}>
                              {l}
                            </option>
                          ))}
                        </select>
                        <button type="button" disabled={i === 0} onClick={() => setCfg({ ...cfg, tabs: cfg.tabs.map((x, j) => (j === i - 1 ? cfg.tabs[i] : j === i ? cfg.tabs[i - 1] : x)) })} className="text-muted" aria-label="Move up">
                          ↑
                        </button>
                        <button type="button" disabled={i === cfg.tabs.length - 1} onClick={() => setCfg({ ...cfg, tabs: cfg.tabs.map((x, j) => (j === i + 1 ? cfg.tabs[i] : j === i ? cfg.tabs[i + 1] : x)) })} className="text-muted" aria-label="Move down">
                          ↓
                        </button>
                        <button type="button" onClick={() => setCfg({ ...cfg, tabs: cfg.tabs.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Delete tab">
                          <Icon name="x" className="h-3 w-3" />
                        </button>
                      </div>
                      {tab.kind === "properties" && (
                        <select multiple value={tab.properties} onChange={(e) => setTab(i, { properties: [...e.target.selectedOptions].map((o) => o.value) })} className={`${inputClass} h-24`}>
                          {props.map((p) => (
                            <option key={p.api_name} value={p.api_name}>
                              {p.display_name}
                            </option>
                          ))}
                        </select>
                      )}
                      {(tab.kind === "links" || tab.kind === "chart" || tab.kind === "linked_view") && (
                        <select
                          value={`${tab.link_type_id}|${tab.direction}`}
                          onChange={(e) => {
                            const [id, d] = e.target.value.split("|");
                            setTab(i, { link_type_id: id, direction: d as "forward", filters: [], group_by: null, value_property: null, linked_properties: [] });
                          }}
                          className={inputClass}
                        >
                          <option value="">Link type…</option>
                          {outLinks.map((o) => (
                            <option key={`${o.l.id}|${o.direction}`} value={`${o.l.id}|${o.direction}`}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                      {(tab.kind === "links" || tab.kind === "chart" || tab.kind === "linked_view") &&
                        (() => {
                          const lt = links.find((l) => l.id === tab.link_type_id);
                          const theirs = lt ? (types.find((x) => x.id === (tab.direction === "reverse" ? lt.source : lt.target).object_type_id)?.properties ?? []) : [];
                          if (!theirs.length) return null;
                          const many = (value: string[], set: (v: string[]) => void, label: string) => (
                            <label className="block">
                              <span className="text-muted">{label}</span>
                              <select multiple value={value} onChange={(e) => set([...e.target.selectedOptions].map((o) => o.value))} className={`${inputClass} h-20`}>
                                {theirs.map((p) => (
                                  <option key={p.api_name} value={p.api_name}>
                                    {p.display_name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          );
                          if (tab.kind === "links") return many(tab.filters ?? [], (filters) => setTab(i, { filters: filters.slice(0, 6) }), "Filters (properties of the linked objects; none: a plain table)");
                          if (tab.kind === "linked_view") return many(tab.linked_properties ?? [], (linked_properties) => setTab(i, { linked_properties }), "Properties on each card (none: the prominent ones)");
                          const numeric = theirs.filter((p) => p.type === "integer" || p.type === "double");
                          return (
                            <div className="flex flex-wrap items-center gap-1">
                              <select value={tab.group_by ?? ""} onChange={(e) => setTab(i, { group_by: e.target.value || null })} className={fieldClass} aria-label="Group by">
                                <option value="">Group by…</option>
                                {theirs.map((p) => (
                                  <option key={p.api_name} value={p.api_name}>
                                    {p.display_name}
                                  </option>
                                ))}
                              </select>
                              <select value={tab.metric ?? "count"} onChange={(e) => setTab(i, { metric: e.target.value as "count", value_property: e.target.value === "count" ? null : (tab.value_property ?? numeric[0]?.api_name ?? null) })} className={fieldClass} aria-label="Metric">
                                {["count", "sum", "avg", "min", "max"].map((m) => (
                                  <option key={m} value={m} disabled={m !== "count" && !numeric.length}>
                                    {m}
                                  </option>
                                ))}
                              </select>
                              {(tab.metric ?? "count") !== "count" && (
                                <select value={tab.value_property ?? ""} onChange={(e) => setTab(i, { value_property: e.target.value })} className={fieldClass} aria-label="Value property">
                                  {numeric.map((p) => (
                                    <option key={p.api_name} value={p.api_name}>
                                      {p.display_name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <select value={tab.chart ?? "bar"} onChange={(e) => setTab(i, { chart: e.target.value as "bar" })} className={fieldClass} aria-label="Chart type">
                                <option value="bar">Bars</option>
                                <option value="pie">Pie</option>
                              </select>
                            </div>
                          );
                        })()}
                      {tab.kind === "quiver_dashboard" && (
                        <>
                          <select value={tab.dashboard_id ?? ""} onChange={(e) => setTab(i, { dashboard_id: e.target.value || null })} className={inputClass} aria-label="Published Quiver dashboard">
                            <option value="">Published dashboard…</option>
                            {dashboards.map((d) => (
                              <option key={d.item_id} value={d.item_id}>
                                {d.name}
                                {d.root_object_type_id === typeId ? " · takes this object" : ""}
                              </option>
                            ))}
                          </select>
                          <p className="text-muted">The dashboard opens for the viewed object: its root object and its object set cards of this type become that object. Publish dashboards in Quiver.</p>
                        </>
                      )}
                      {tab.kind === "form" && <FormTabFields tab={tab} set={(c) => setTab(i, c)} props={props} formList={formList} typeId={typeId} types={types} outLinks={outLinks} />}
                      {tab.kind === "workshop" && <input value={tab.module_id ?? ""} onChange={(e) => setTab(i, { module_id: e.target.value })} placeholder="Workshop module ID" className={inputClass} />}
                      {tab.kind === "url" && <input value={tab.url ?? ""} onChange={(e) => setTab(i, { url: e.target.value })} placeholder="https://… ({pk} is the object)" className={inputClass} />}
                      {(tab.kind === "map" || tab.kind === "timeseries" || tab.kind === "html") && (
                        <WidgetTabFields tab={tab} set={(c) => setTab(i, c)} typeId={typeId} types={types} links={links} outLinks={outLinks} tsps={tsps} />
                      )}
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted">Visible</span>
                        <select
                          value={tab.visibility?.kind ?? ""}
                          onChange={(e) =>
                            setTab(i, {
                              visibility: e.target.value === "property" ? { kind: "property", property: props[0]?.api_name ?? "", op: "eq", value: "" } : e.target.value === "link" ? { kind: "link", link_type_id: outLinks[0]?.l.id ?? "" } : null,
                            })
                          }
                          className={fieldClass}
                        >
                          <option value="">always</option>
                          <option value="property">when a property…</option>
                          <option value="link">when the viewer can see a link</option>
                        </select>
                        {tab.visibility?.kind === "property" && (
                          <>
                            <select value={tab.visibility.property} onChange={(e) => setTab(i, { visibility: { ...(tab.visibility as { kind: "property"; property: string; op: "eq"; value: string }), property: e.target.value } })} className={fieldClass}>
                              {props.map((p) => (
                                <option key={p.api_name} value={p.api_name}>
                                  {p.display_name}
                                </option>
                              ))}
                            </select>
                            <select value={tab.visibility.op} onChange={(e) => setTab(i, { visibility: { ...(tab.visibility as { kind: "property"; property: string; op: "eq"; value: string }), op: e.target.value as "eq" } })} className={fieldClass}>
                              <option value="eq">equals</option>
                              <option value="neq">does not equal</option>
                            </select>
                            <input value={tab.visibility.value} onChange={(e) => setTab(i, { visibility: { ...(tab.visibility as { kind: "property"; property: string; op: "eq"; value: string }), value: e.target.value } })} className={`${fieldClass} w-28`} />
                          </>
                        )}
                        {tab.visibility?.kind === "link" && (
                          <select value={tab.visibility.link_type_id} onChange={(e) => setTab(i, { visibility: { kind: "link", link_type_id: e.target.value } })} className={fieldClass}>
                            {outLinks.map((o) => (
                              <option key={o.l.id} value={o.l.id}>
                                {o.l.display_name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={() => setCfg({ ...cfg, tabs: [...cfg.tabs, { title: "New tab", kind: "properties", properties: [] }] })} className={buttonClass.ghost}>
                    <Icon name="plus" className="h-3.5 w-3.5" /> Add tab
                  </button>
                </div>
              </Card>
              <Card title="Header, panel and sidebar">
                <div className="space-y-2 p-3">
                  {(["header_properties", "panel_properties"] as const).map((k) => (
                    <div key={k}>
                      <div className="mb-1 text-muted">{k === "header_properties" ? "Header properties" : "Panel properties"}</div>
                      <select multiple value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: [...e.target.selectedOptions].map((o) => o.value) })} className={`${inputClass} h-20`}>
                        {props.map((p) => (
                          <option key={p.api_name} value={p.api_name}>
                            {p.display_name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  <div className="text-muted">Object set panel aggregates</div>
                  {cfg.set_panel_aggregates.map((a, i) => (
                    <div key={i} className="flex gap-1">
                      <select value={a.metric} onChange={(e) => setCfg({ ...cfg, set_panel_aggregates: cfg.set_panel_aggregates.map((x, j) => (j === i ? { ...x, metric: e.target.value } : x)) })} className={fieldClass}>
                        {["count", "sum", "avg", "min", "max"].map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                      {a.metric !== "count" && (
                        <select value={a.property ?? ""} onChange={(e) => setCfg({ ...cfg, set_panel_aggregates: cfg.set_panel_aggregates.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)) })} className={`${fieldClass} flex-1`}>
                          {props.map((p) => (
                            <option key={p.api_name} value={p.api_name}>
                              {p.display_name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button type="button" onClick={() => setCfg({ ...cfg, set_panel_aggregates: cfg.set_panel_aggregates.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                        <Icon name="x" className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setCfg({ ...cfg, set_panel_aggregates: [...cfg.set_panel_aggregates, { metric: "count" }] })} className={buttonClass.ghost}>
                    + Aggregate
                  </button>
                  <div className="text-muted">Applications sidebar</div>
                  {cfg.sidebar.map((s, i) => (
                    <div key={i} className="flex flex-wrap gap-1">
                      <input value={s.label} onChange={(e) => setCfg({ ...cfg, sidebar: cfg.sidebar.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} className={`${fieldClass} w-28`} />
                      <select value={s.app} onChange={(e) => setCfg({ ...cfg, sidebar: cfg.sidebar.map((x, j) => (j === i ? { ...x, app: e.target.value } : x)) })} className={fieldClass}>
                        {["object-explorer", "vertex", "map", "url"].map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                      {s.app === "url" && <input value={s.url ?? ""} onChange={(e) => setCfg({ ...cfg, sidebar: cfg.sidebar.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} className={`${fieldClass} min-w-0 flex-1`} />}
                      <button type="button" onClick={() => setCfg({ ...cfg, sidebar: cfg.sidebar.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                        <Icon name="x" className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setCfg({ ...cfg, sidebar: [...cfg.sidebar, { label: "Object Explorer", app: "object-explorer" }] })} className={buttonClass.ghost}>
                    + Application
                  </button>
                </div>
              </Card>
            </>
          )}
        </aside>
        <main className="min-w-0 flex-1 space-y-3 bg-ink p-3 text-xs md:overflow-y-auto md:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Preview on</span>
            <div className="w-full min-w-0 sm:w-72">{typeId && <ObjectPicker key={typeId} objectTypeId={typeId} value={pk} onChange={(x) => setPk(x)} />}</div>
            <span className="text-muted">{previewVersion ? `version ${previewVersion}` : "published version"}</span>
            {previewVersion && (
              <button type="button" onClick={() => setPreviewVersion(null)} className="text-ocean">
                Show published
              </button>
            )}
          </div>
          {pk ? (
            <>
              <ConfiguredObjectView key={`${pk}|${previewVersion}|${tick}`} typeId={typeId} pk={pk} version={previewVersion} />
              <div className="break-all text-muted">
                URLs: full <code>/ontology/objects/{typeId}/{pk}</code> · a tab <code>?tab=&lt;tab id&gt;</code>
              </div>
            </>
          ) : (
            <div className="text-muted">Pick an object to preview the view. Unsaved changes on the left show after saving (unpublished versions can be previewed).</div>
          )}
        </main>
      </div>
    </div>
  );
}

const GEO = ["geopoint", "geoshape"];
const HTML_EXAMPLE = `<div class="card">
  <h2>{{title}}</h2>
  <p>Key: <b>{{primary_key}}</b></p>
</div>
<style>.card{border:1px solid #334155;border-radius:8px;padding:12px}</style>`;

/** The settings of a map, time series or HTML tab. */
function WidgetTabFields({
  tab,
  set,
  typeId,
  types,
  links,
  outLinks,
  tsps,
}: {
  tab: Tab;
  set: (c: Partial<Tab>) => void;
  typeId: string;
  types: ObjectType[];
  links: LinkType[];
  outLinks: { l: LinkType; direction: "forward" | "reverse"; label: string }[];
  tsps: Record<string, string[]>;
}) {
  const props = types.find((x) => x.id === typeId)?.properties ?? [];
  const lt = links.find((l) => l.id === tab.link_type_id);
  const other = lt ? types.find((x) => x.id === (tab.direction === "reverse" ? lt.source : lt.target).object_type_id) : undefined;
  const theirs = other?.properties ?? [];
  const nameOf = (list: { api_name: string; display_name: string }[], n: string) => list.find((p) => p.api_name === n)?.display_name ?? n;
  const linkPicker = (optional: boolean) => (
    <select
      value={tab.link_type_id ? `${tab.link_type_id}|${tab.direction}` : ""}
      onChange={(e) => {
        const [id, d] = e.target.value.split("|");
        set({ link_type_id: id || null, direction: (d as "forward") || "forward", linked_geo_property: null, label_property: null, ...(tab.kind === "timeseries" ? { ts_properties: [] } : {}) });
      }}
      className={inputClass}
      aria-label="Link type"
    >
      <option value="">{optional ? "No linked objects" : "Link type…"}</option>
      {outLinks.map((o) => (
        <option key={`${o.l.id}|${o.direction}`} value={`${o.l.id}|${o.direction}`}>
          {o.label}
        </option>
      ))}
    </select>
  );
  const height = (
    <label className="flex items-center gap-1">
      <span className="text-muted">Height</span>
      <input type="number" min={120} max={1200} step={20} value={tab.height ?? 320} onChange={(e) => set({ height: Math.max(120, Math.min(1200, Number(e.target.value) || 320)) })} className={`${fieldClass} w-20`} />
      <span className="text-muted">px</span>
    </label>
  );
  if (tab.kind === "map") {
    const geoMine = props.filter((p) => GEO.includes(p.type));
    const geoTheirs = theirs.filter((p) => GEO.includes(p.type));
    return (
      <div className="space-y-1.5">
        <label className="block">
          <span className="text-muted">This object&apos;s location</span>
          <select value={tab.geo_property ?? ""} onChange={(e) => set({ geo_property: e.target.value || null })} className={inputClass} aria-label="Geo property">
            <option value="">{geoMine.length ? "None (only linked objects)" : "This type has no geopoint or geoshape property"}</option>
            {geoMine.map((p) => (
              <option key={p.api_name} value={p.api_name}>
                {p.display_name} ({p.type})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-muted">Linked objects on the map</span>
          {linkPicker(true)}
        </label>
        {lt && (
          <div className="flex flex-wrap items-center gap-1">
            <select value={tab.linked_geo_property ?? ""} onChange={(e) => set({ linked_geo_property: e.target.value || null })} className={fieldClass} aria-label="Linked geo property">
              <option value="">{geoTheirs.length ? "Their location…" : `${other?.display_name ?? "They"} have no geo property`}</option>
              {geoTheirs.map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  {p.display_name}
                </option>
              ))}
            </select>
            <select value={tab.label_property ?? ""} onChange={(e) => set({ label_property: e.target.value || null })} className={fieldClass} aria-label="Label property">
              <option value="">Label: their title</option>
              {theirs.map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  Label: {p.display_name}
                </option>
              ))}
            </select>
          </div>
        )}
        {height}
      </div>
    );
  }
  if (tab.kind === "timeseries") {
    const linked = tab.ts_source === "linked";
    const srcId = linked ? other?.id : typeId;
    const avail = srcId ? tsps[srcId] : undefined;
    const srcProps = linked ? theirs : props;
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {(["object", "linked"] as const).map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="radio" checked={(tab.ts_source ?? "object") === s} onChange={() => set({ ts_source: s, ts_properties: [], ...(s === "object" ? { link_type_id: null } : {}) })} />
              {s === "object" ? "This object's series" : "Series of linked objects"}
            </label>
          ))}
        </div>
        {linked && linkPicker(false)}
        {(!linked || lt) &&
          (avail === undefined ? (
            <div className="text-muted">Loading time series properties…</div>
          ) : avail.length ? (
            <label className="block">
              <span className="text-muted">{linked ? `Time series properties of ${other?.display_name ?? "the linked objects"} (up to 12 objects are charted)` : "Time series properties (none: all of them)"}</span>
              <select multiple value={tab.ts_properties ?? []} onChange={(e) => set({ ts_properties: [...e.target.selectedOptions].map((o) => o.value).slice(0, 12) })} className={`${inputClass} h-20`}>
                {avail.map((p) => (
                  <option key={p} value={p}>
                    {nameOf(srcProps, p)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="text-muted">{linked ? other?.display_name : "This type"} has no time series properties (set them up in Time series → object types).</div>
          ))}
        <div className="flex flex-wrap items-center gap-2">
          {!linked && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={!!tab.ts_sensors} onChange={(e) => set({ ts_sensors: e.target.checked })} /> with its linked sensors&apos; series
            </label>
          )}
          <label className="flex items-center gap-1">
            <span className="text-muted">Default range: last</span>
            <input value={tab.ts_range ?? ""} onChange={(e) => set({ ts_range: e.target.value.trim() || null })} placeholder="everything" className={`${fieldClass} w-24`} aria-label="Default range" title="A number and h, d, w, mo or y, e.g. 7d; empty for everything" />
          </label>
          {height}
        </div>
      </div>
    );
  }
  const placeholders = ["title", "primary_key", ...props.map((p) => p.api_name)];
  return (
    <div className="space-y-1.5">
      <textarea
        value={tab.html ?? ""}
        onChange={(e) => set({ html: e.target.value })}
        placeholder={HTML_EXAMPLE}
        spellCheck={false}
        className={`${inputClass} h-40 font-mono text-[11px]`}
        aria-label="HTML"
      />
      {!tab.html && (
        <button type="button" onClick={() => set({ html: HTML_EXAMPLE })} className="text-ocean">
          Start from an example
        </button>
      )}
      <div className="text-muted">
        Insert:{" "}
        {placeholders.map((p) => (
          <button key={p} type="button" onClick={() => set({ html: `${tab.html ?? ""}{{${p}}}` })} className="mr-1 font-mono text-ocean hover:underline">
            {`{{${p}}}`}
          </button>
        ))}
      </div>
      <p className="text-muted">
        Values are escaped. Scripts, event handlers, frames, forms and javascript: links are removed when the tab is shown; CSS may not load anything (no url(), @import). Links open in a new tab.
      </p>
      {height}
    </div>
  );
}

/** Fields that take a prefilled value (shown only, filled in by the form, or files do not). */
const NOT_PREFILLED = new Set(["callout", "objects_provider", "object_property_display", "calculation", "created_at", "created_by", "template", "user_properties", "attachments"]);

/** Why a link type cannot link a new object made by a form (null: it can): the key must be held by the new object. */
function linkBlocker(o: { l: LinkType; direction: "forward" | "reverse" }, typeName: string): string | null {
  if (o.l.kind === "object_backed") return "object backed";
  if (o.l.kind === "foreign_key" && o.direction === "forward") return `key held by ${typeName}`;
  return null;
}

/**
 * A form tab's settings (doc "Forms", Object Explorer: Edit object form and Create linked object form): the form,
 * prefilled values (static text or {{property}} of the viewed object; for a linked object also {{last.property}} of
 * the last linked object), conditional forms (the first condition that holds picks another form) and whether the
 * form's title shows. A Create linked object form also picks the link, what "last" means and whether every field
 * starts from the last linked object.
 */
function FormTabFields({ tab, set, props, formList, typeId, types, outLinks }: {
  tab: Tab;
  set: (c: Partial<Tab>) => void;
  props: { api_name: string; display_name: string }[];
  formList: { id: string; name: string }[];
  typeId: string;
  types: ObjectType[];
  outLinks: { l: LinkType; direction: "forward" | "reverse"; label: string }[];
}) {
  const linked = tab.form_mode === "create_linked";
  const typeName = types.find((x) => x.id === typeId)?.display_name ?? "this type";
  const chosenLink = outLinks.find((o) => o.l.id === tab.link_type_id && o.direction === (tab.direction ?? "forward"));
  const otherType = chosenLink ? types.find((x) => x.id === (chosenLink.direction === "reverse" ? chosenLink.l.source : chosenLink.l.target).object_type_id) : undefined;
  const theirs = otherType?.properties ?? [];
  const [info, setInfo] = useState<{ id: string; fields: FormField[]; writes: string | null } | null>(null);
  const formId = tab.form_id ?? "";
  useEffect(() => {
    if (!formId) return;
    let stale = false;
    forms.get(formId).then(
      (v) => {
        if (stale) return;
        setInfo({
          id: formId,
          fields: v.form.sheets.flatMap((sh) => sh.fields).filter((f) => !NOT_PREFILLED.has(f.type)),
          writes: v.form.destination.kind === "object_type" ? (v.form.destination.object_type_id ?? null) : null,
        });
      },
      () => !stale && setInfo({ id: formId, fields: [], writes: null }),
    );
    return () => {
      stale = true;
    };
  }, [formId]);
  const fields = info?.id === formId ? info.fields : [];
  const writes = info?.id === formId ? info.writes : null;
  const prefill = Object.entries(tab.form_prefill ?? {});
  const conditions = tab.form_conditions ?? [];
  const unused = fields.filter((f) => !(f.id in (tab.form_prefill ?? {})));
  const setPrefill = (rows: [string, string][]) => set({ form_prefill: Object.fromEntries(rows) });
  const formSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} min-w-0 flex-1`} aria-label={label}>
      <option value="">Form…</option>
      {formList.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
      {value && !formList.some((f) => f.id === value) && <option value={value}>{value}</option>}
    </select>
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {(["object", "create_linked"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="radio" checked={(tab.form_mode ?? "object") === m} onChange={() => set({ form_mode: m, form_prefill: {}, ...(m === "object" ? { link_type_id: null, form_copy_last: false, form_last_sort: null } : {}) })} />
            {m === "object" ? "For this object (Edit object form)" : "Create linked object form"}
          </label>
        ))}
      </div>
      {linked && (
        <div className="space-y-1.5">
          <select
            value={chosenLink ? `${chosenLink.l.id}|${chosenLink.direction}` : ""}
            onChange={(e) => {
              const [id, d] = e.target.value.split("|");
              set({ link_type_id: id || null, direction: (d as "forward") || "forward", form_last_sort: null, form_prefill: {} });
            }}
            className={inputClass}
            aria-label="Link to the new object"
          >
            <option value="">Link the new object by…</option>
            {outLinks.map((o) => {
              const why = linkBlocker(o, typeName);
              return (
                <option key={`${o.l.id}|${o.direction}`} value={`${o.l.id}|${o.direction}`} disabled={!!why}>
                  {o.label}
                  {why ? ` (${why})` : ""}
                </option>
              );
            })}
          </select>
          {otherType && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-muted">Last linked {otherType.display_name}:</span>
              <select value={tab.form_last_sort ?? ""} onChange={(e) => set({ form_last_sort: e.target.value || null })} className={`${fieldClass} min-w-0 max-w-full`} aria-label="Last linked object by">
                <option value="">the most recently created</option>
                {theirs.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    the greatest {p.display_name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {otherType && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={!!tab.form_copy_last} onChange={(e) => set({ form_copy_last: e.target.checked })} /> Prefill every field from the last linked {otherType.display_name}
            </label>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {formSelect(formId, (v) => set({ form_id: v || null, form_prefill: {} }), "Form")}
        <label className="flex items-center gap-1 text-muted">
          <input type="checkbox" checked={!!tab.form_no_header} onChange={(e) => set({ form_no_header: e.target.checked })} /> Hide the form&apos;s title
        </label>
      </div>
      {formId && (
        <p className="text-muted">
          {linked
            ? otherType && writes && writes !== otherType.id
              ? `This form does not write ${otherType.display_name} objects: pick a form that does.`
              : `Submitting creates a ${otherType?.display_name ?? "linked object"} linked to the viewed object${
                  chosenLink?.l.kind === "foreign_key" ? ` (the form's ${chosenLink.l.foreign_key} field gets this object's key)` : chosenLink?.l.kind === "join_table" ? " (linked after the submission)" : ""
                }.`
            : writes === typeId
              ? "The form writes this object type: it opens with the viewed object's values and submitting edits that object (Edit object form)."
              : "The form opens for the viewed object: object dropdowns of this type select it. Submitting refreshes the view."}
        </p>
      )}
      {formId && (
        <div className="space-y-1">
          <div className="text-muted">Prefilled values (text, or {"{{property}}"} of the object{linked ? ", {{last.property}} of the last linked object" : ""})</div>
          {prefill.map(([fid, value], j) => (
            <div key={fid} className="flex flex-wrap items-center gap-1">
              <span className="w-32 shrink-0 truncate" title={fid}>
                {fields.find((f) => f.id === fid)?.label || fid}
              </span>
              <input value={value} onChange={(e) => setPrefill(prefill.map((r, k) => (k === j ? [fid, e.target.value] : r)))} className={`${fieldClass} min-w-0 flex-1 font-mono`} aria-label={`Value of ${fid}`} />
              <select value="" onChange={(e) => e.target.value && setPrefill(prefill.map((r, k) => (k === j ? [fid, `{{${e.target.value}}}`] : r)))} className={`${fieldClass} min-w-0 max-w-full`} aria-label="Insert a property">
                <option value="">Property…</option>
                {linked && theirs.length > 0 ? (
                  <>
                    <optgroup label="This object">
                      {props.map((p) => (
                        <option key={p.api_name} value={p.api_name}>
                          {p.display_name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={`The last linked ${otherType?.display_name ?? "object"}`}>
                      {theirs.map((p) => (
                        <option key={p.api_name} value={`last.${p.api_name}`}>
                          {p.display_name}
                        </option>
                      ))}
                    </optgroup>
                  </>
                ) : (
                  props.map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name}
                    </option>
                  ))
                )}
              </select>
              <button type="button" onClick={() => setPrefill(prefill.filter((_, k) => k !== j))} className="text-muted hover:text-bad" aria-label="Remove prefilled value">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
          ))}
          {unused.length > 0 && (
            <select value="" onChange={(e) => e.target.value && setPrefill([...prefill, [e.target.value, ""]])} className={fieldClass} aria-label="Prefill a field">
              <option value="">+ Prefill a field…</option>
              {unused.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label || f.id}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="space-y-1">
        <div className="text-muted">Conditional forms (the first that holds replaces the form)</div>
        {conditions.map((c, j) => {
          const put = (patch: Partial<typeof c>) => set({ form_conditions: conditions.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
          return (
            <div key={j} className="flex flex-wrap items-center gap-1">
              <span className="text-muted">when</span>
              <select value={c.property} onChange={(e) => put({ property: e.target.value })} className={`${fieldClass} min-w-0 max-w-full`} aria-label="Property">
                {props.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.display_name}
                  </option>
                ))}
              </select>
              <select value={c.op} onChange={(e) => put({ op: e.target.value as "eq" })} className={fieldClass} aria-label="Condition">
                <option value="eq">is</option>
                <option value="neq">is not</option>
              </select>
              <input value={c.value} onChange={(e) => put({ value: e.target.value })} placeholder="value" className={`${fieldClass} w-24`} aria-label="Value" />
              {formSelect(c.form_id, (v) => put({ form_id: v }), "Conditional form")}
              <button type="button" onClick={() => set({ form_conditions: conditions.filter((_, k) => k !== j) })} className="text-muted hover:text-bad" aria-label="Remove condition">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          disabled={!props.length}
          onClick={() => set({ form_conditions: [...conditions, { property: props[0]?.api_name ?? "", op: "eq", value: "", form_id: "" }] })}
          className="text-ocean hover:underline"
        >
          + Condition
        </button>
      </div>
    </div>
  );
}
