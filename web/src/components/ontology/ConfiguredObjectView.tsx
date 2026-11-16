"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { FormEmbed } from "@/components/forms/FormEmbed";
import { Icon } from "@/components/Icon";
import { driveContentUrl } from "@/lib/api";
import { ObjectViewHtml, ObjectViewMap, ObjectViewTimeSeries, type MapFeature, type TabSeries } from "@/components/ontology/ObjectViewWidgets";
import { ErrorBox, ValueCell } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { PublishedDashboardView } from "@/components/quiver/PublishedDashboardView";
import { request, type OntologyObject, type Property } from "@/lib/ontology";

export type RenderedTab = {
  id: string;
  title: string;
  kind: "properties" | "links" | "chart" | "linked_view" | "map" | "timeseries" | "html" | "timeline" | "edit_history" | "comments" | "form" | "workshop" | "quiver_dashboard" | "url";
  dashboard_id?: string | null;
  properties: string[];
  /** map: the object and its linked objects as points / shapes, and the bounds of all of them */
  features?: MapFeature[];
  bounds?: [number, number, number, number] | null;
  skipped?: number;
  /** timeseries: the series with their points over the default range */
  ts_series?: TabSeries[];
  ts_range?: string | null;
  ts_error?: string;
  /** html: the template with the object's values, already sanitized by the API */
  html_rendered?: string;
  html_removed?: string[];
  height?: number;
  /** links: the filters (a property's values among the linked objects) */
  facets?: { property: string; display_name: string; values: { value: string; count: number }[] }[];
  /** chart: the linked objects grouped by a property */
  series?: { label: string; value: number | null; count: number }[];
  chart?: "bar" | "pie";
  metric?: string;
  group_by?: string | null;
  value_property?: string | null;
  /** linked_view: a card per linked object */
  views?: { primary_key: string; title: string; fields: { api_name: string; display_name: string; type: string; value: unknown }[] }[];
  /** form: the form shown for this object (a conditional form already picked), prefilled from it */
  form_id?: string | null;
  form_name?: string | null;
  form_published?: boolean;
  form_error?: string;
  /** the prefilled values (for a Create linked object form already resolved: the foreign key, the last linked object's values) */
  form_prefill?: Record<string, string | number | boolean | (string | number)[] | null>;
  form_no_header?: boolean;
  /** "create_linked": a Create linked object form — submitting creates an object linked to the viewed one */
  form_mode?: "object" | "create_linked";
  /** create_linked: the last linked object the form is prefilled from, and the link */
  form_last?: { primary_key: string; title: string } | null;
  form_link?: { link_type_id: string; direction: "forward" | "reverse"; kind: "foreign_key" | "join_table" | "object_backed"; object_type_id: string; object_type: string; count: number };
  module_id?: string;
  url?: string;
  count?: number;
  object_type_id?: string;
  object_type?: string;
  objects?: OntologyObject[];
  columns?: string[];
  events?: { at: string; label: string; object_type_id: string; primary_key: string; title: string }[];
  history?: { at: string; user: string; op: string; properties: string[] }[];
};
export type Rendered = {
  object: OntologyObject;
  object_type: { id: string; display_name: string; properties: Property[] };
  version: number | null;
  configured: boolean;
  header_properties: string[];
  panel_properties: string[];
  sidebar: { label: string; app: string; url?: string; module_id?: string }[];
  tabs: RenderedTab[];
  urls: { full: string; panel: string };
};
type Comment = { id: string; at: string; user: string; text: string; attachments: string[]; files?: { id: string; name: string }[]; mentions: { username: string; user_id: string | null }[] };

export const objectViews = {
  render: (typeId: string, pk: string, version?: number | null) => request<Rendered>(`/object-views/${typeId}/${encodeURIComponent(pk)}${version ? `?version=${version}` : ""}`),
  comments: (typeId: string, pk: string) => request<Comment[]>(`/object-types/${typeId}/objects/${encodeURIComponent(pk)}/comments`),
  addComment: (typeId: string, pk: string, text: string, attachments: string[] = []) =>
    request<Comment>(`/object-types/${typeId}/objects/${encodeURIComponent(pk)}/comments`, { method: "POST", json: { text, attachments } }),
  deleteComment: (typeId: string, pk: string, id: string) => request<unknown>(`/object-types/${typeId}/objects/${encodeURIComponent(pk)}/comments/${id}`, { method: "DELETE" }),
  /** after a Create linked object form's submission: link what the response created to the object */
  linkCreated: (typeId: string, pk: string, tabId: string, responseId: string, version?: number | null) =>
    request<{ kind: string; object_type_id: string; created: string[]; added: string[]; not_linked: string[] }>(`/object-views/${typeId}/${encodeURIComponent(pk)}/linked-form`, {
      method: "POST",
      json: { tab_id: tabId, response_id: responseId, version: version ?? null },
    }),
};

const appHref = (s: Rendered["sidebar"][number], typeId: string, pk: string) =>
  s.app === "object-explorer" ? `/object-explorer?type=${typeId}&q=${encodeURIComponent(pk)}` : s.app === "vertex" ? "/vertex" : s.app === "map" ? "/map" : s.app === "workshop" ? `/workshop/${s.module_id}` : (s.url ?? "#").replaceAll("{pk}", encodeURIComponent(pk));

/** The configured Object View's tabs for one object (or a given version, for previews), with comments. */
export function ConfiguredObjectView({ typeId, pk, version, initialTab, onObjectChanged }: {
  typeId: string;
  pk: string;
  version?: number | null;
  initialTab?: string | null;
  /** called after a form tab's submission (and its linking), when the view renders again: the page around the view
   * shows the object's title and header properties too, and reloads them */
  onObjectChanged?: () => void;
}) {
  const [data, setData] = useState<Rendered | null>(null);
  const [tab, setTab] = useState<string | null>(initialTab ?? null);
  const [error, setError] = useState<string | null>(null);
  // bumped after a form tab's submission: the view is rendered again (the object, counts, history may have changed)
  const [reload, setReload] = useState(0);
  useEffect(() => {
    objectViews.render(typeId, pk, version).then(
      (d) => (setData(d), setError(null)),
      (e: Error) => setError(e.message),
    );
  }, [typeId, pk, version, reload]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;
  const current = data.tabs.find((x) => x.id === tab) ?? data.tabs[0];
  const prop = (n: string) => data.object_type.properties.find((p) => p.api_name === n);
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2">
        {data.tabs.map((x) => (
          <button key={x.id} type="button" onClick={() => setTab(x.id)} className={`px-3 py-2.5 text-xs ${current?.id === x.id ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
            {x.title}
            {x.count !== undefined && <span className="ml-1 rounded-full bg-panel-2 px-1.5 text-[10px]">{x.count}</span>}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 pr-2 text-[11px] text-muted">
          {data.configured ? `Configured view v${data.version}` : "Default view"}
          {data.sidebar.map((s, i) => (
            <Link key={i} href={appHref(s, typeId, pk)} className="text-ocean hover:underline">
              {s.label}
            </Link>
          ))}
        </span>
      </div>
      <div className="p-4 text-xs">
        {current?.kind === "properties" && (
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {current.properties.map((n) => (
              <div key={n} className="flex gap-2 border-b border-line/60 pb-1.5">
                <span className="w-40 shrink-0 text-muted">{prop(n)?.display_name ?? n}</span>
                <span className="min-w-0 flex-1 break-words">
                  <ValueCell type={prop(n)?.type ?? "string"} value={data.object.properties[n]} prop={prop(n)} object={data.object.properties} />
                </span>
              </div>
            ))}
          </div>
        )}
        {current?.kind === "links" && <LinkedTable key={current.id} tab={current} />}
        {current?.kind === "chart" && <LinkedChart tab={current} />}
        {current?.kind === "map" && (
          <ObjectViewMap key={current.id} features={current.features ?? []} bounds={current.bounds ?? null} skipped={current.skipped ?? 0} count={current.count} objectType={current.object_type} height={current.height ?? 320} />
        )}
        {current?.kind === "timeseries" && <ObjectViewTimeSeries key={current.id} series={current.ts_series ?? []} defaultRange={current.ts_range ?? null} error={current.ts_error} height={current.height ?? 320} />}
        {current?.kind === "html" && <ObjectViewHtml html={current.html_rendered ?? ""} removed={current.html_removed ?? []} title={current.title} height={current.height ?? 320} />}
        {current?.kind === "linked_view" && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(current.views ?? []).map((v) => (
              <div key={v.primary_key} className="rounded-lg border border-line bg-ink/40 p-3">
                <Link href={`/ontology/objects/${current.object_type_id}/${encodeURIComponent(v.primary_key)}`} className="font-medium text-ocean hover:underline">
                  {v.title}
                </Link>
                <div className="mt-2 space-y-1">
                  {v.fields.map((f) => (
                    <div key={f.api_name} className="flex gap-2">
                      <span className="w-28 shrink-0 truncate text-muted">{f.display_name}</span>
                      <span className="min-w-0 flex-1 break-words">
                        <ValueCell type={f.type} value={f.value} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!current.views?.length && <div className="text-muted">No linked objects.</div>}
            {(current.count ?? 0) > (current.views?.length ?? 0) && (
              <div className="text-muted">
                Showing {current.views?.length} of {current.count} {current.object_type}.
              </div>
            )}
          </div>
        )}
        {current?.kind === "timeline" && (
          <div className="space-y-1.5 border-l border-line pl-4">
            {(current.events ?? []).map((e, i) => (
              <div key={i} className="relative">
                <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-ocean" />
                <span className="text-muted">{e.at.slice(0, 16).replace("T", " ")}</span> · {e.label} ·{" "}
                <Link href={`/ontology/objects/${e.object_type_id}/${encodeURIComponent(e.primary_key)}`} className="text-ocean">
                  {e.title}
                </Link>
              </div>
            ))}
            {!current.events?.length && <div className="text-muted">No dated properties on this object or its linked objects.</div>}
          </div>
        )}
        {current?.kind === "edit_history" && (
          <div className="divide-y divide-line">
            {(current.history ?? []).map((h, i) => (
              <div key={i} className="py-1.5">
                <span className="text-muted">{h.at.slice(0, 16).replace("T", " ")}</span> · {h.user} · {h.op} {h.properties.join(", ")}
              </div>
            ))}
            {!current.history?.length && <div className="text-muted">No edits.</div>}
          </div>
        )}
        {current?.kind === "comments" && <Comments typeId={typeId} pk={pk} />}
        {current?.kind === "quiver_dashboard" && current.dashboard_id && <PublishedDashboardView itemId={current.dashboard_id} object={{ object_type_id: typeId, primary_key: data.object.primary_key }} />}
        {current?.kind === "form" && (
          <FormTab
            key={`${current.id}|${current.form_id}`}
            tab={current}
            typeId={typeId}
            pk={data.object.primary_key}
            version={version}
            onSubmitted={() => {
              setReload((n) => n + 1);
              onObjectChanged?.();
            }}
          />
        )}
        {current?.kind === "workshop" && (
          <Link href={`/workshop/${current.module_id}?object=${encodeURIComponent(pk)}`} className="text-ocean">
            Open the Workshop module for this object
          </Link>
        )}
        {current?.kind === "url" && (
          <a href={(current.url ?? "").replaceAll("{pk}", encodeURIComponent(pk))} target="_blank" rel="noreferrer" className="text-ocean">
            {current.url}
          </a>
        )}
      </div>
    </section>
  );
}

/**
 * A form tab: the form embedded for the viewed object (object dropdowns of its type select it, {{property}} values
 * come from it, a form writing this type edits it), with the tab's prefilled values. After a submission the view is
 * rendered again and the form starts over with the object's new values. A Create linked object form (doc "Forms",
 * Object Explorer) creates an object linked to the viewed one, prefilled from the last linked object: after the
 * submission what it created is linked (a join table) or checked (a foreign key the form wrote).
 */
function FormTab({ tab, typeId, pk, version, onSubmitted }: { tab: RenderedTab; typeId: string; pk: string; version?: number | null; onSubmitted: () => void }) {
  const [round, setRound] = useState(0);
  const [done, setDone] = useState<{ rows: number; edited: boolean; linked?: string; warning?: string } | null>(null);
  if (tab.form_error || !tab.form_id) return <p className="text-muted">The form cannot be shown: {tab.form_error ?? "no form is picked"}.</p>;
  if (!tab.form_published) return <p className="text-muted">{tab.form_name ?? "The form"} has no published version yet. Publish it in Forms.</p>;
  const link = tab.form_mode === "create_linked" ? tab.form_link : undefined;
  const otherHref = (key: string) => `/ontology/objects/${link?.object_type_id}/${encodeURIComponent(key)}`;
  return (
    <div className="min-w-0 space-y-2">
      {link && (
        <p className="text-muted">
          Creates a new {link.object_type} linked to this object
          {tab.form_last ? (
            <>
              , prefilled from the last one:{" "}
              <Link href={otherHref(tab.form_last.primary_key)} className="text-ocean hover:underline">
                {tab.form_last.title}
              </Link>
            </>
          ) : link.count ? "" : " (none linked yet)"}
          .
        </p>
      )}
      {done && (
        <p role="status" className={`rounded border px-2 py-1 ${done.warning ? "border-warn/40 bg-warn/10 text-warn" : "border-ok/40 bg-ok/10 text-ok"}`}>
          Submitted
          {done.linked !== undefined ? `: ${done.linked}` : done.edited ? ": the object was updated" : done.rows ? `: ${done.rows} row${done.rows === 1 ? "" : "s"} written` : ""}.
          {done.warning && ` ${done.warning}`}
        </p>
      )}
      <FormEmbed
        key={round}
        formId={tab.form_id}
        object={{ objectType: typeId, pk }}
        prefill={tab.form_prefill}
        noHeader={tab.form_no_header}
        maxHeight={1200}
        title={tab.form_name ?? tab.title}
        onSubmitted={async (m) => {
          setRound((n) => n + 1);
          if (!link) {
            setDone({ rows: m.rows, edited: m.edited_object });
            onSubmitted();
            return;
          }
          // a Create linked object form: link what the response created (a join table), or check the foreign key did
          try {
            const r = await objectViews.linkCreated(typeId, pk, tab.id, m.response_id, version);
            const n = r.created.length;
            setDone({
              rows: m.rows,
              edited: false,
              linked: `${n} ${link.object_type} created and linked to this object`,
              warning: r.not_linked.length ? `${r.not_linked.length} of them did not get this object's key, so ${r.not_linked.length === 1 ? "it is" : "they are"} not linked.` : undefined,
            });
          } catch (e) {
            setDone({ rows: m.rows, edited: false, linked: `${link.object_type} created`, warning: `It could not be linked: ${(e as Error).message}` });
          }
          onSubmitted();
        }}
      />
      {/* on its own page a new object would not be linked (nor prefilled from the last one) */}
      {!link && (
        <Link href={`/forms/${tab.form_id}/fill?object_type=${encodeURIComponent(typeId)}&pk=${encodeURIComponent(pk)}`} className="text-[11px] text-ocean hover:underline">
          Open the form on its own page
        </Link>
      )}
    </div>
  );
}

/** A linked objects tab: the table, narrowed by the tab's filters (values of chosen properties). */
function LinkedTable({ tab }: { tab: RenderedTab }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const rows = useMemo(
    () =>
      (tab.objects ?? []).filter((o) =>
        Object.entries(picked).every(([prop, vals]) => {
          if (!vals.length) return true;
          const v = o.properties[prop];
          return (Array.isArray(v) ? v : [v]).some((x) => vals.includes(x === null || x === undefined ? "" : String(x)));
        }),
      ),
    [tab.objects, picked],
  );
  const cols = (tab.columns ?? []).slice(0, 5);
  return (
    <div className="flex gap-4">
      {(tab.facets ?? []).length > 0 && (
        <div className="w-44 shrink-0 space-y-3">
          {tab.facets!.map((f) => (
            <div key={f.property}>
              <div className="mb-1 font-medium text-muted">{f.display_name}</div>
              {f.values.map((v) => {
                const on = (picked[f.property] ?? []).includes(v.value);
                return (
                  <label key={v.value} className="flex items-center gap-1.5 py-0.5">
                    <input type="checkbox" checked={on} onChange={() => setPicked({ ...picked, [f.property]: on ? picked[f.property].filter((x) => x !== v.value) : [...(picked[f.property] ?? []), v.value] })} />
                    <span className="min-w-0 flex-1 truncate">{v.value || "—"}</span>
                    <span className="text-muted">{v.count}</span>
                  </label>
                );
              })}
            </div>
          ))}
          {Object.values(picked).some((v) => v.length) && (
            <button type="button" onClick={() => setPicked({})} className="text-ocean hover:underline">
              Clear filters ({rows.length} of {tab.objects?.length ?? 0})
            </button>
          )}
        </div>
      )}
      <div className="min-w-0 flex-1 overflow-x-auto">
        <table className="w-full">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">{tab.object_type}</th>
              {cols.map((c) => (
                <th key={c} className="py-1 pr-3 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((o) => (
              <tr key={o.primary_key}>
                <td className="py-1.5 pr-3">
                  <Link href={`/ontology/objects/${tab.object_type_id}/${encodeURIComponent(o.primary_key)}`} className="text-ocean hover:underline">
                    {o.title}
                  </Link>
                </td>
                {cols.map((c) => (
                  <td key={c} className="max-w-48 truncate py-1.5 pr-3">
                    {String(o.properties[c] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="text-muted">{tab.objects?.length ? "No linked objects match the filters." : "No linked objects."}</div>}
      </div>
    </div>
  );
}

const CHART_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#60a5fa", "#fb7185", "#2dd4bf"];

/** A chart tab: the linked objects grouped by a property, as bars or a pie. */
function LinkedChart({ tab }: { tab: RenderedTab }) {
  const series = (tab.series ?? []).filter((g) => g.value !== null) as { label: string; value: number; count: number }[];
  const what = tab.metric && tab.metric !== "count" ? `${tab.metric} of ${tab.value_property}` : "count";
  if (!series.length) return <div className="text-muted">No linked objects to chart.</div>;
  const max = Math.max(...series.map((g) => Math.abs(g.value)), 1e-9);
  const total = series.reduce((a, g) => a + Math.max(0, g.value), 0);
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  // pie slices as arcs from the top, clockwise
  const slices = series.reduce<{ label: string; value: number; from: number; to: number }[]>((acc, g) => {
    const from = acc.length ? acc[acc.length - 1].to : 0;
    return [...acc, { label: g.label, value: g.value, from, to: from + (total ? Math.max(0, g.value) / total : 0) }];
  }, []);
  const pt = (f: number) => `${50 + 46 * Math.sin(2 * Math.PI * f)},${50 - 46 * Math.cos(2 * Math.PI * f)}`;
  return (
    <div className="space-y-2">
      <div className="text-muted">
        {tab.count} {tab.object_type} by {tab.group_by} · {what}
      </div>
      {tab.chart === "pie" && total > 0 ? (
        <div className="flex flex-wrap items-center gap-6">
          <svg viewBox="0 0 100 100" className="h-44 w-44" role="img" aria-label={`${tab.title} pie chart`}>
            {slices.map((s, i) =>
              s.to - s.from >= 0.9999 ? (
                <circle key={s.label} cx={50} cy={50} r={46} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ) : (
                <path key={s.label} d={`M50,50 L${pt(s.from)} A46,46 0 ${s.to - s.from > 0.5 ? 1 : 0} 1 ${pt(s.to)} Z`} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ),
            )}
          </svg>
          <div className="space-y-1">
            {slices.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                <span>{s.label}</span>
                <span className="text-muted">
                  {fmt(s.value)} · {Math.round((s.to - s.from) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {series.map((g, i) => (
            <div key={g.label} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate text-right text-muted" title={g.label}>
                {g.label}
              </span>
              <div className="h-4 min-w-0 flex-1 rounded-sm bg-panel-2">
                <div className="h-full rounded-sm" style={{ width: `${(Math.abs(g.value) / max) * 100}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
              </div>
              <span className="w-16 shrink-0 tabular-nums">{fmt(g.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Comments({ typeId, pk }: { typeId: string; pk: string }) {
  const [list, setList] = useState<Comment[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => objectViews.comments(typeId, pk).then(setList, (e: Error) => setError(e.message)), [typeId, pk]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="space-y-2">
      {list.map((c) => (
        <div key={c.id} className="rounded-md border border-line p-2">
          <div className="flex text-muted">
            <span className="font-medium text-soft">{c.user}</span>
            <span className="ml-2">{c.at.slice(0, 16).replace("T", " ")}</span>
            <button type="button" onClick={() => objectViews.deleteComment(typeId, pk, c.id).then(load, (e: Error) => setError(e.message))} className="ml-auto hover:text-bad" aria-label="Delete comment">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-1 whitespace-pre-wrap">{c.text}</div>
          {(c.files ?? []).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2">
              {c.files!.map((f) => (
                <a key={f.id} href={driveContentUrl(f.id)} className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-ocean hover:underline">
                  <Icon name="doc" className="h-3 w-3" /> {f.name}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Comment… mention someone with @username" className={inputClass} />
      <div className="flex flex-wrap items-center gap-2">
        {files.map((f) => (
          <span key={f.id} className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5">
            {f.name}
            <button type="button" onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label="Remove attachment"><Icon name="x" className="h-3 w-3" /></button>
          </span>
        ))}
        {files.length < 10 && <button type="button" onClick={() => setPicking(true)} className="text-ocean hover:underline">Attach a file</button>}
      </div>
      {picking && (
        <DrivePicker
          title="Attach a file from Files"
          onPick={(it) => {
            setPicking(false);
            if (!files.some((x) => x.id === it.id)) setFiles([...files, { id: it.id, name: it.name }]);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!text.trim()}
        onClick={() =>
          objectViews.addComment(typeId, pk, text, files.map((f) => f.id)).then(
            () => (setText(""), setFiles([]), load()),
            (e: Error) => setError(e.message),
          )
        }
        className={buttonClass.primary}
      >
        Comment
      </button>
    </div>
  );
}
