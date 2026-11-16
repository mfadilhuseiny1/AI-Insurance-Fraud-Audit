"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ConfiguredObjectView, objectViews, type Rendered } from "@/components/ontology/ConfiguredObjectView";
import { Field, ValueCell } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { actions } from "@/lib/actions";
import { DrivePicker } from "@/components/DrivePicker";
import { api, API_URL, driveContentUrl, type DriveItem } from "@/lib/api";
import { mediaSets, type MediaSet } from "@/lib/mediaSets";
import { ontology, request, type ActionType, type ObjectType, type OntologyObject, type Property } from "@/lib/ontology";
import { fillVars, fmt, sourceKey, workshop, type Column, type EditChange, type FileTag, type InterfaceObject, type MdAnnotation, type Module, type ResourceItem, type ResourceMeta, type Sources, type Widget, type WidgetConfig } from "@/lib/workshop";
import { mdRefs, renderWorkshopMarkdown, WS_MARKDOWN_CSS } from "@/lib/workshopMarkdown";
import { valueOf } from "./ModuleRuntime";
import { dragObjects } from "./CrossApp";
import { EmbeddedBody } from "./WorkshopWidgets";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

const Msg = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted">{children}</div>;
const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The object a widget shows: object_pk ($var:, {{…}}) or the selected object of its object type source. On an
 *  interface source the object's key reads "<implementing type id>:<primary key>" (as the interface's rows do): the
 *  widget shows that object of its implementing type (ifaceId names the interface). */
function target(widget: Widget, state: ModuleState): { typeId?: string; pk?: string; ifaceId?: string } {
  const c = widget.config;
  const v = c.object_pk ? valueOf(c.object_pk, state.variables) : undefined;
  if (c.source?.kind === "interface") {
    const key = v !== undefined && v !== null && v !== "" ? String(v) : state.selection[sourceKey(c.source)];
    const at = key ? key.indexOf(":") : -1;
    return at > 0 ? { typeId: key!.slice(0, at), pk: key!.slice(at + 1), ifaceId: c.source.id } : { ifaceId: c.source.id };
  }
  const typeId = c.source?.kind === "object_type" ? c.source.id : undefined;
  return { typeId, pk: v !== undefined && v !== null && v !== "" ? String(v) : typeId ? state.selection[sourceKey(c.source)] : undefined };
}

async function upload(file: File, folder?: string | null): Promise<{ id: string; name: string }> {
  const fd = new FormData();
  fd.append("file", file);
  if (folder) fd.append("parent_id", folder);
  const res = await fetch(`${API_URL}/api/drive/files`, { method: "POST", credentials: "include", body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.statusText);
  return body as { id: string; name: string };
}

// ------------------------------------------------------------------------------------------------
// Object View
// ------------------------------------------------------------------------------------------------

export function ObjectViewWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const { typeId, pk, ifaceId } = target(widget, state);
  const [obj, setObj] = useState<OntologyObject | null>(null);
  const [typeState, setType] = useState<ObjectType | null>(null);
  // the shown object's type (on an interface source it changes with the selected object)
  const type = typeState && typeState.id === typeId ? typeState : null;
  const [set, setSet] = useState<{ objects: number; aggregates: { label: string; value: unknown }[] } | null>(null);
  // an interface source: the selected object read through its type's interface mapping
  const [ifaceObj, setIfaceObj] = useState<{ key: string; o: InterfaceObject | null; error?: string } | null>(null);
  const [ifaceName, setIfaceName] = useState<string | null>(null);
  const panel = c.form_factor === "panel";
  const behavior = c.panel_behavior ?? "adaptive";
  const showSet = panel && (behavior === "set" || (behavior === "adaptive" && !pk));
  useEffect(() => {
    if (!typeId) return;
    ontology.objectType(typeId).then(setType, () => setType(null));
  }, [typeId]);
  useEffect(() => {
    if (!ifaceId) return;
    let stale = false;
    workshop.sources().then((s) => !stale && setIfaceName(s.interfaces?.find((x) => x.id === ifaceId)?.name ?? null), () => {});
    return () => {
      stale = true;
    };
  }, [ifaceId]);
  useEffect(() => {
    if (!panel || showSet || !typeId || !pk) return;
    let stale = false;
    ontology.object(typeId, pk).then((o) => !stale && setObj(o), () => !stale && setObj(null));
    return () => {
      stale = true;
    };
  }, [panel, showSet, typeId, pk, state.version]);
  const ifaceKey = ifaceId && typeId && pk ? `${ifaceId}|${typeId}|${pk}` : "";
  useEffect(() => {
    if (!panel || showSet || !ifaceKey) return;
    let stale = false;
    workshop.interfaceObject(ifaceId!, typeId!, pk!).then((o) => !stale && setIfaceObj({ key: ifaceKey, o }), (e: Error) => !stale && setIfaceObj({ key: ifaceKey, o: null, error: e.message }));
    return () => {
      stale = true;
    };
  }, [panel, showSet, ifaceKey, ifaceId, typeId, pk, state.version]);
  useEffect(() => {
    if (!showSet || !c.source || (!typeId && !ifaceId)) return;
    let stale = false;
    const filters = (c.filters ?? []).map((f) => ({ ...f, value: valueOf(f.value, state.variables) }));
    // an interface's set: its objects, and how many come from each implementing type
    const run = ifaceId
      ? workshop.query({ source: c.source, filters, columns: ["object_type"], limit: 5000 }).then((r) => {
          const by = new Map<string, number>();
          for (const x of r.rows ?? []) by.set(String(x.object_type ?? ""), (by.get(String(x.object_type ?? "")) ?? 0) + 1);
          const n = (r.rows ?? []).length;
          return { objects: n, aggregates: [{ label: "Objects", value: n }, ...[...by].sort((p, q) => q[1] - p[1]).map(([label, value]) => ({ label, value }))] };
        })
      : // the set's objects through the widget's filters, then the object view's set panel aggregates
        workshop
          .query({ source: c.source, filters, columns: [], limit: 2000 })
          .then((r) =>
            fetch(`${API_URL}/api/ontology/object-views/${typeId}/set-panel`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ primary_keys: (r.rows ?? []).map((x) => x.__pk) }) }).then((x) => x.json()),
          );
    run.then((x) => !stale && setSet(x), () => !stale && setSet(null));
    return () => {
      stale = true;
    };
  }, [showSet, typeId, ifaceId, c.source, c.filters, state.variables, state.version]);
  // the object view mode (standard / configured; viewers may switch when the builder allows it), and the configured panel
  const baseMode = c.view_mode ?? "standard";
  const [picked, setPicked] = useState<{ base: string; mode: "standard" | "configured" } | null>(null);
  if (picked && picked.base !== baseMode) setPicked(null); // a viewer's switch lasts until the builder changes the mode
  const mode = picked && picked.base === baseMode ? picked.mode : baseMode;
  const setMode = (m: "standard" | "configured") => setPicked({ base: baseMode, mode: m });
  // the published layout of the shown object's type (on an interface source, the implementing type of each object)
  const [layoutOf, setLayoutOf] = useState<{ typeId: string; l: PanelLayout | null } | null>(null);
  const layout = layoutOf && layoutOf.typeId === typeId ? layoutOf.l : undefined;
  const configured = panel && !showSet && mode === "configured";
  useEffect(() => {
    if (!configured || !typeId) return;
    let stale = false;
    panelLayout(typeId).then((l) => !stale && setLayoutOf({ typeId, l }), () => !stale && setLayoutOf({ typeId, l: null }));
    return () => {
      stale = true;
    };
  }, [configured, typeId]);
  if (!typeId && !ifaceId) return <Msg>Choose the object type or interface (source) in the panel</Msg>;
  if (!pk && !showSet) return <Msg>{c.empty_message || "Select an object to see its object view"}</Msg>;
  if (!typeId && !showSet) return <Msg>Select an object to see its object view</Msg>;
  // an interface source: the standard panel lists the interface's properties through the type's mapping
  const viaIface = !!ifaceId && !showSet && !!ifaceKey;
  const iobj = viaIface && ifaceObj?.key === ifaceKey ? ifaceObj : null;
  const shown = obj && typeId && obj.object_type_id === typeId && obj.primary_key === pk ? obj : null;
  if (!panel) {
    // the new options (hidden header / tabs, the initial tab on each object, modules in Workshop tabs) need the view
    // drawn here; otherwise the object's own page, embedded
    // (an interface source: the implementing type's object view)
    if (c.hide_header || c.hide_tabs || c.reset_tab || Object.keys(c.tab_interfaces ?? {}).length) return <FullObjectView widget={widget} state={state} typeId={typeId!} pk={pk!} />;
    const src = `/ontology/objects/${typeId}/${encodeURIComponent(pk!)}?embed=1${c.initial_tab ? `&tab=${encodeURIComponent(c.initial_tab)}` : ""}`;
    return <iframe key={src} src={src} title={`Object view ${pk}`} className="h-full w-full border-0" data-object-view={pk} />;
  }
  const toggle = c.view_mode_toggle && !showSet && (
    <span className="ml-auto flex shrink-0 overflow-hidden rounded border border-line-2 text-[10px]" data-ov-mode-toggle>
      {(["standard", "configured"] as const).map((m) => (
        <button key={m} type="button" onClick={() => setMode(m)} className={`px-1.5 py-0.5 ${mode === m ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`} aria-pressed={mode === m} data-ov-mode={m}>
          {m === "standard" ? "Standard" : "Configured"}
        </button>
      ))}
    </span>
  );
  // configured mode: the type's published panel properties (none published: the standard panel)
  const shownProps: { api_name: string; display_name: string; type: string }[] | null =
    configured && layout ? layout.panel.map((n) => type?.properties.find((p) => p.api_name === n)).filter((p): p is NonNullable<typeof p> => !!p) : null;
  if (showSet)
    return (
      <div className="h-full overflow-y-auto p-3 text-xs" data-object-view-set {...(ifaceId ? { "data-ov-interface": ifaceId } : {})}>
        <div className="mb-2 font-semibold">{ifaceId ? (ifaceName ?? "Objects") : (type?.display_name ?? "Objects")}</div>
        {(set?.aggregates ?? []).map((a) => (
          <div key={a.label} className="flex justify-between border-b border-line py-1">
            <span className="text-muted">{a.label}</span>
            <span className="font-semibold">{fmt(a.value)}</span>
          </div>
        ))}
        {!set && <p className="text-muted">Loading…</p>}
      </div>
    );
  return (
    <div
      className="h-full overflow-y-auto p-3 text-xs"
      data-object-view-panel={pk}
      {...(c.view_mode || c.view_mode_toggle ? { "data-ov-panel-mode": shownProps ? "configured" : "standard" } : {})}
      {...(viaIface ? { "data-ov-interface": ifaceId, "data-ov-type": typeId } : {})}
    >
      {!c.hide_header ? (
        <div className="mb-2 flex items-center gap-2">
          <span draggable={!!c.enable_drag} onDragStart={(e) => dragObjects(e, typeId!, [pk!])} className={c.enable_drag ? "cursor-grab" : ""} title={c.enable_drag ? "Drag this object" : undefined} data-object-drag>
            <Icon name="cube" className="h-4 w-4 text-ocean" />
          </span>
          <span className="min-w-0 truncate">
            <span className="block truncate text-sm font-semibold">{shown?.title ?? pk}</span>
            {viaIface && (
              <span className="block truncate text-[10px] text-muted" data-ov-via>
                {type?.display_name ?? typeId} · via {ifaceName ?? iobj?.o?.interface.name ?? "the interface"}
              </span>
            )}
          </span>
          {toggle}
          <a href={`/ontology/objects/${typeId}/${encodeURIComponent(pk!)}`} target="_blank" rel="noreferrer" className={`${toggle ? "" : "ml-auto "}text-muted hover:text-white`} title="Open the full object view">
            <Icon name="external" className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : (
        toggle && <div className="mb-2 flex">{toggle}</div>
      )}
      {configured && layout === undefined ? (
        <p className="text-muted">Loading…</p>
      ) : !shown ? (
        <p className="text-muted">Loading…</p>
      ) : shownProps ? (
        <>
          {shownProps.map((p) => (
            <div key={p.api_name} className="flex gap-2 border-b border-line py-0.5" data-ov-panel-prop={p.api_name}>
              <span className="w-32 shrink-0 truncate text-muted">{p.display_name}</span>
              <span className="min-w-0 flex-1 truncate">
                <ValueCell type={p.type} value={shown.properties[p.api_name]} prop={p as Property} object={shown.properties} />
              </span>
            </div>
          ))}
          {!shownProps.length && <p className="text-muted">The configured panel shows no properties.</p>}
        </>
      ) : viaIface ? (
        <>
          {configured && layout === null && (
            <p className="mb-1 text-[10px] text-muted" data-ov-no-configured>
              No configured Object View is published for {type?.display_name ?? "this type"}: the interface&apos;s properties.
            </p>
          )}
          {!iobj ? (
            <p className="text-muted">Loading…</p>
          ) : iobj.error ? (
            <p className="text-bad">{iobj.error}</p>
          ) : (
            iobj.o?.properties.map((p) => (
              <div key={p.name} className="flex gap-2 border-b border-line py-0.5" data-ov-iface-prop={p.name} data-ov-local={p.local ?? ""} title={p.local ? `${p.label} ← ${p.local}` : `${p.label}: not mapped by ${type?.display_name ?? "this type"}`}>
                <span className="w-32 shrink-0 truncate text-muted">{p.label}</span>
                <span className={`min-w-0 flex-1 truncate ${p.local ? "" : "text-muted"}`}>{p.local ? fmt(p.value) : "—"}</span>
              </div>
            ))
          )}
        </>
      ) : (
        <>
          {configured && layout === null && (
            <p className="mb-1 text-[10px] text-muted" data-ov-no-configured>
              No configured Object View is published for this type: the standard panel.
            </p>
          )}
          {(type?.properties ?? [])
            .filter((p) => p.type !== "vector" && p.visibility !== "hidden")
            .slice(0, 24)
            .map((p) => (
              <div key={p.api_name} className="flex gap-2 border-b border-line py-0.5">
                <span className="w-32 shrink-0 truncate text-muted">{p.display_name}</span>
                <span className="min-w-0 flex-1 truncate">{fmt(shown.properties[p.api_name])}</span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

/** The published configured Object View's panel layout of a type; null when none is published. */
type PanelLayout = { version: number; panel: string[] };
function panelLayout(typeId: string): Promise<PanelLayout | null> {
  return request<{ published: number | null; config: { panel_properties?: string[] } }>(`/object-types/${typeId}/views`).then((v) =>
    v.published ? { version: v.published, panel: v.config.panel_properties ?? [] } : null,
  );
}

/**
 * The full object view drawn in the widget (when the builder hides its header or tabs, goes back to the initial tab on
 * each object, or maps module interfaces): the object's header (title, type, header properties), the configured view's
 * tabs (their visibility rules applied), each tab's content from the configured Object View, and Workshop tabs running
 * their module here with the mapped variables.
 */
function FullObjectView({ widget, state, typeId, pk }: { widget: Widget; state: ModuleState; typeId: string; pk: string }) {
  const c = widget.config;
  const [data, setData] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabSel, setTabSel] = useState<{ pk: string; id: string | null }>({ pk, id: c.initial_tab ?? null });
  useEffect(() => {
    let stale = false;
    objectViews.render(typeId, pk).then((d) => !stale && (setData(d), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [typeId, pk, state.version]);
  // "Go to initial tab on object switch": the tab chosen on the previous object is dropped when the object changes
  const initial = c.initial_tab ?? null;
  if (tabSel.pk !== pk) setTabSel({ pk, id: c.reset_tab ? initial : tabSel.id });
  const tab = tabSel.id;
  const setTab = (id: string) => setTabSel({ pk, id });
  if (error) return <Msg>{error}</Msg>;
  if (!data || data.object.primary_key !== pk) return <Msg>Loading…</Msg>;
  const tabs = data.tabs;
  const current = tabs.find((x) => x.id === tab) ?? tabs.find((x) => x.id === initial) ?? tabs[0];
  const prop = (n: string) => data.object_type.properties.find((p) => p.api_name === n);
  const mapping = current ? c.tab_interfaces?.[current.id] : undefined;
  return (
    <div className="flex h-full flex-col overflow-hidden text-xs" data-object-view-full={pk} data-ov-tab={current?.id ?? ""}>
      {!c.hide_header && (
        <div className="shrink-0 border-b border-line px-3 py-2" data-ov-header>
          <div className="flex items-center gap-2">
            <span draggable={!!c.enable_drag} onDragStart={(e) => dragObjects(e, typeId, [pk])} className={c.enable_drag ? "cursor-grab" : ""}>
              <Icon name="cube" className="h-4 w-4 text-ocean" />
            </span>
            <span className="truncate text-sm font-semibold">{data.object.title}</span>
            <span className="truncate text-muted">{data.object_type.display_name}</span>
            <a href={data.urls.full} target="_blank" rel="noreferrer" className="ml-auto text-muted hover:text-white" title="Open the full object view">
              <Icon name="external" className="h-3.5 w-3.5" />
            </a>
          </div>
          {data.header_properties.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              {data.header_properties.map((n) => (
                <span key={n} className="min-w-0" data-ov-header-prop={n}>
                  <span className="text-muted">{prop(n)?.display_name ?? n}: </span>
                  <ValueCell type={prop(n)?.type ?? "string"} value={data.object.properties[n]} prop={prop(n)} object={data.object.properties} />
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {!c.hide_tabs && tabs.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-line px-2" role="tablist" data-ov-tabs>
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={current?.id === x.id} onClick={() => setTab(x.id)} className={`px-3 py-2 ${current?.id === x.id ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`} data-ov-tab-button={x.id}>
              {x.title}
              {x.count !== undefined && <span className="ml-1 rounded-full bg-panel-2 px-1.5 text-[10px]">{x.count}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" data-ov-body={widget.id}>
        {!current ? (
          <Msg>This object view has no tabs.</Msg>
        ) : current.kind === "workshop" && current.module_id ? (
          <TabModule key={`${pk}|${current.id}`} moduleId={current.module_id} mapping={mapping ?? {}} pk={pk} state={state} />
        ) : (
          <>
            {/* the configured view's own tab bar is replaced by the one above */}
            <style>{`[data-ov-body="${widget.id}"] > section > div:first-child{display:none}[data-ov-body="${widget.id}"] > section{border:0;border-radius:0}`}</style>
            <ConfiguredObjectView key={`${pk}|${current.id}`} typeId={typeId} pk={pk} initialTab={current.id} />
          </>
        )}
      </div>
    </div>
  );
}

/** A configured Object View's Workshop tab: its module (published) runs here, the interface variables from the mapping. */
function TabModule({ moduleId, mapping, pk, state }: { moduleId: string; mapping: Record<string, unknown>; pk: string; state: ModuleState }) {
  const [mod, setMod] = useState<Module | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const self = moduleId === state.moduleId;
  useEffect(() => {
    if (self) return;
    let stale = false;
    workshop.moduleAt(moduleId, { published: true }).then((m) => !stale && setMod(m), (e: Error) => !stale && setErr(e.message));
    return () => {
      stale = true;
    };
  }, [moduleId, self]);
  // "object" gets the object's key unless mapped (as the tab's link to the module does with ?object=)
  const params = useMemo(() => ({ object: pk, ...Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v === "$object" ? pk : valueOf(v, state.variables)]).filter(([, v]) => v !== undefined)) }), [mapping, pk, state.variables]);
  if (self) return <Msg>A module cannot embed itself</Msg>;
  if (err) return <Msg>{err}</Msg>;
  if (!mod) return <Msg>Loading…</Msg>;
  return (
    <div className="h-full" data-ov-module={moduleId}>
      <EmbeddedBody key={JSON.stringify(params)} mod={mod} params={params} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Edit History
// ------------------------------------------------------------------------------------------------

export function EditHistoryWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { typeId, pk, ifaceId } = target(widget, state);
  const [h, setH] = useState<{ enabled: boolean; since?: string; changes: EditChange[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!typeId || !pk) return;
    let stale = false;
    workshop.editHistory(typeId, pk, c.history_order ?? "newest").then((x) => !stale && (setH(x), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [typeId, pk, c.history_order, state.version, nonce]);
  if (!typeId && !ifaceId) return <Msg>Choose the object type (source) in the panel</Msg>;
  if (!pk || !typeId) return <Msg>Select an object to see its edit history</Msg>;
  if (error) return <Msg>{error}</Msg>;
  if (!h) return <Msg>Loading…</Msg>;
  if (!h.enabled && !h.changes.length)
    return (
      <Msg>
        <span>
          Edit history is not tracked for this object type.
          {editing && (
            <button type="button" onClick={() => workshop.setTracking(typeId, true).then(() => setNonce((n) => n + 1))} className="ml-1 text-ocean underline" data-enable-tracking>
              Track user edit history
            </button>
          )}
        </span>
      </Msg>
    );
  const shown = h.changes.filter((x) => !c.history_props?.length || (x.property && c.history_props.includes(x.property)) || !x.property);
  return (
    <div className="h-full overflow-y-auto p-2 text-xs" data-edit-history>
      {!shown.length && <p className="text-muted">No edits since {h.since ? when(h.since) : "tracking started"}.</p>}
      {shown.map((x, i) => (
        <div key={i} className="border-b border-line py-1" data-edit>
          <div className="text-[10px] text-muted">
            {when(x.at)} · <b className="text-soft">{x.user}</b>
          </div>
          {x.property ? (
            <div>
              <span className="font-semibold">{x.property}</span>: <span className="text-bad line-through">{fmt(x.before)}</span> → <span className="text-ok">{fmt(x.after)}</span>
            </div>
          ) : (
            <div className="text-bad">Deleted</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Action Log Timeline
// ------------------------------------------------------------------------------------------------

type LogEntry = { action_type_id: string; action_type: string; rid: string; at: string; user: string; reverted: boolean; logged: boolean };

export function ActionLogWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const { typeId, pk, ifaceId } = target(widget, state);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  useEffect(() => {
    if (!typeId || !pk) return;
    let stale = false;
    fetch(`${API_URL}/api/ontology/actions/log-for/${typeId}/${encodeURIComponent(pk)}`, { credentials: "include" })
      .then((r) => r.json())
      .then((x) => !stale && setLog(Array.isArray(x) ? x : []), () => !stale && setLog([]));
    return () => {
      stale = true;
    };
  }, [typeId, pk, state.version]);
  if (!typeId && !ifaceId) return <Msg>Choose the object type (source) in the panel</Msg>;
  if (!pk || !typeId) return <Msg>Select an object to see its action log</Msg>;
  if (!log) return <Msg>Loading…</Msg>;
  const shown = log.filter((x) => !c.log_actions?.length || c.log_actions.includes(x.action_type_id));
  return (
    <div className="h-full overflow-y-auto p-3 text-xs" data-action-log>
      {!shown.length && <p className="text-muted">No actions on this object.</p>}
      {shown.map((x) => (
        <div key={x.rid} className="flex gap-3" data-log-entry>
          <div className="flex flex-col items-center">
            <span className={`mt-1 h-2.5 w-2.5 rounded-full ${x.reverted ? "bg-muted" : "bg-ocean"}`} />
            <span className="w-px flex-1 bg-line" />
          </div>
          <div className="pb-3">
            <div className="font-semibold">
              {x.action_type}
              {x.reverted && <span className="ml-1 text-muted">(reverted)</span>}
            </div>
            <div className="text-[10px] text-muted">
              {when(x.at)} · {x.user}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Linked resources (Linked Compass Resources)
// ------------------------------------------------------------------------------------------------

export function LinkedResourcesWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { typeId, pk, ifaceId } = target(widget, state);
  const [items, setItems] = useState<ResourceMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState<string | null>(null);
  const [found, setFound] = useState<DriveItem[]>([]);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!typeId || !pk) return;
    let stale = false;
    workshop.resourceLinks(typeId, pk).then((x) => !stale && (setItems(x), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [typeId, pk, state.version]);
  useEffect(() => {
    if (q === null || q.trim().length < 2) return;
    const t = setTimeout(() => api.drive.search(q.trim()).then((x) => setFound(x.filter((i) => i.kind === "file").slice(0, 8)), () => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  if (!typeId && !ifaceId) return <Msg>Choose the object type (source) in the panel</Msg>;
  if (!pk || !typeId) return <Msg>Select an object to see its linked files</Msg>;
  const ro = editing || !!state.readOnly;
  const folder = c.upload_folder_variable ? String(state.variables[c.upload_folder_variable] ?? "") || null : c.upload_folder || null;
  return (
    <div className="flex h-full flex-col text-xs" data-linked-resources={pk}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="font-semibold">{c.content_title || "Linked files"}</span>
        {!c.hide_upload && (
          <button type="button" disabled={ro || busy} onClick={() => file.current?.click()} className="ml-auto text-ocean disabled:opacity-40" data-resource-upload>
            <Icon name="upload" className="inline h-3 w-3" /> Upload
          </button>
        )}
        {!c.hide_link && (
          <button type="button" disabled={ro} onClick={() => setQ(q === null ? "" : null)} className={`${c.hide_upload ? "ml-auto" : ""} text-ocean disabled:opacity-40`} data-resource-link>
            <Icon name="link" className="inline h-3 w-3" /> Link
          </button>
        )}
        <input
          ref={file}
          type="file"
          multiple
          className="hidden"
          onChange={async (e) => {
            const fs = [...(e.target.files ?? [])];
            e.target.value = "";
            setBusy(true);
            try {
              let cur = items;
              for (const f of fs) cur = await workshop.linkResource(typeId, pk, (await upload(f, folder)).id);
              setItems(cur);
            } catch (x) {
              setError((x as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
      {q !== null && (
        <div className="shrink-0 border-b border-line p-2">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Files…" className={`${fieldClass} w-full text-xs`} />
          {found.map((f) => (
            <button key={f.id} type="button" onClick={() => workshop.linkResource(typeId, pk, f.id).then((x) => (setItems(x), setQ(null)), (x: Error) => setError(x.message))} className="block w-full truncate rounded px-2 py-1 text-left hover:bg-panel-2">
              {f.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="px-3 py-1 text-bad">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {(items ?? []).map((m) => (
          <div key={m.id} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-panel-2" data-resource={m.id}>
            <Icon name="doc" className="h-3.5 w-3.5 shrink-0 text-muted" />
            <a href={`${API_URL}/api/drive/items/${m.id}/content`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-soft hover:text-white">
              {m.name}
            </a>
            {!ro && (
              <button type="button" onClick={() => workshop.unlinkResource(typeId, pk, m.id).then(setItems, (x: Error) => setError(x.message))} className="hidden text-muted hover:text-bad group-hover:block" title="Unlink">
                ✕
              </button>
            )}
          </div>
        ))}
        {items && !items.length && <p className="text-muted">No linked files.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Media Uploader
// ------------------------------------------------------------------------------------------------

/** The extensions a media set takes: its primary and additional formats with their spellings (jpg / jpeg, tiff / tif);
 *  none for a multimodal set (any file). */
const EXT_ALIASES: Record<string, string[]> = { jpg: ["jpeg"], tiff: ["tif"], jp2: ["jp2k"], nitf: ["ntf"], dcm: ["dicom"] };
const mediaSetExtensions =(s: Pick<MediaSet, "schema" | "primary_format" | "additional_formats">) =>
  s.schema === "multimodal" ? [] : [s.primary_format, ...s.additional_formats].filter((x): x is string => !!x).flatMap((x) => [x, ...(EXT_ALIASES[x] ?? [])]);

const INTENT: Record<string, string> = {
  none: "border border-line-2 bg-panel-2 text-soft hover:text-white",
  primary: "bg-ocean text-white hover:bg-ocean-deep",
  success: "bg-ok text-white",
  warning: "bg-warn text-white",
  danger: "bg-bad text-white",
};

export function MediaUploaderWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folder = c.upload_folder_variable ? String(state.variables[c.upload_folder_variable] ?? "") || null : c.upload_folder || null;
  // a media set target: the configured media set, or the ID a string variable holds
  const toSet = c.upload_target === "media_set";
  const setId = toSet ? (c.media_set_variable ? String(state.variables[c.media_set_variable] ?? "") || null : c.media_set || null) : null;
  const [msLoaded, setMsLoaded] = useState<{ id: string; set?: MediaSet; error?: string } | null>(null);
  useEffect(() => {
    if (!setId) return;
    let stale = false;
    mediaSets.get(setId).then((s) => !stale && setMsLoaded({ id: setId, set: s }), (e: Error) => !stale && setMsLoaded({ id: setId, error: e.message }));
    return () => {
      stale = true;
    };
  }, [setId]);
  const ms = msLoaded?.id === setId ? (msLoaded.set ?? null) : null;
  const msError = msLoaded?.id === setId ? (msLoaded.error ?? null) : null;
  // allowed extensions: the configured ones, else (a media set) its primary and additional formats
  const exts = (c.extensions ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const accept = (exts.length ? exts : ms ? mediaSetExtensions(ms) : []).map((x) => (x.startsWith(".") ? x : `.${x}`)).join(",");
  const run = async (files: File[]) => {
    const max = c.multi ? Math.max(1, c.max_files ?? 10) : 1;
    const allowed = accept.split(",").filter(Boolean);
    const list = files.slice(0, max).filter((f) => !allowed.length || allowed.some((ext) => f.name.toLowerCase().endsWith(ext.toLowerCase())));
    if (!list.length) return setNote("No file with an allowed extension");
    if (toSet && !setId) return setNote("No media set chosen");
    setBusy(true);
    setNote(null);
    let done = 0;
    try {
      // each uploaded file: its ID (a Files item, or the media item — its media reference) and its name / path
      const uploaded: { id: string; name: string }[] = [];
      const after = async (it: { id: string; name: string }) => {
        if (c.rid_variable) state.setVariable(c.rid_variable, it.id);
        if (c.filename_variable) state.setVariable(c.filename_variable, it.name);
        if (c.upload_action && !state.readOnly) {
          // the file's ID goes into the chosen parameter ("File identifier"), the others from their defaults
          const params = Object.fromEntries(Object.entries(c.action_defaults ?? {}).map(([k, v]) => [k, valueOf(v, state.variables)]).filter(([, v]) => v !== undefined && v !== ""));
          if (c.upload_param) params[c.upload_param] = it.id;
          await actions.apply(c.upload_action, params);
        }
      };
      if (toSet && setId) {
        const s = ms ?? (await mediaSets.get(setId));
        if (s.virtual) throw new Error("this media set is virtual: its items come from its source");
        if (s.transaction_policy === "transactional") {
          // one transaction for the whole click: every file staged, then committed at once (aborted on a failure)
          const tx = await mediaSets.openTransaction(setId);
          const staged: string[] = [];
          try {
            for (const f of list) staged.push((await mediaSets.upload(setId, f, tx.id)).path);
            await mediaSets.commit(setId, tx.id);
          } catch (e) {
            await mediaSets.abort(setId, tx.id).catch(() => {});
            throw e;
          }
          // the committed items: the newest at each staged path (a path's "/" is stored as "_")
          const now = (await mediaSets.items(setId)).items;
          for (const p of staged) {
            const it = now.find((x) => x.path === p.replace(/\//g, "_").trim());
            if (it) uploaded.push({ id: it.id, name: it.path });
          }
          done = staged.length;
          for (const it of uploaded) await after(it);
        } else {
          for (const f of list) {
            const it = await mediaSets.upload(setId, f);
            await after({ id: it.id, name: it.path });
            done++;
          }
        }
      } else {
        for (const f of list) {
          await after(await upload(f, folder));
          done++;
        }
      }
      setNote(`Uploaded ${done} file${done === 1 ? "" : "s"}${toSet ? ` to ${ms?.name ?? "the media set"}` : ""}${c.upload_action ? " and ran the action" : ""}`);
      state.bump();
      if (c.events?.length) void state.runEvents?.(c.events);
    } catch (e) {
      setNote(`${done ? `${done} uploaded, then: ` : ""}${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-2" data-media-uploader={toSet ? "media_set" : "folder"}>
      <button type="button" disabled={editing || busy || !!state.readOnly || (toSet && (!setId || !!msError))} title={toSet && ms ? `Uploads to the media set ${ms.name}` : undefined} onClick={() => input.current?.click()} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${INTENT[c.intent ?? "primary"]}`}>
        {c.left_icon !== "" && <Icon name={(c.left_icon || "upload") as IconName} className="h-3.5 w-3.5" />}
        {busy ? "Uploading…" : fillVars(c.button_text || "Upload files", state.variables)}
        {c.right_icon && <Icon name={c.right_icon as IconName} className="h-3.5 w-3.5" />}
      </button>
      <input ref={input} type="file" accept={accept || undefined} multiple={!!c.multi} className="hidden" onChange={(e) => (void run([...(e.target.files ?? [])]), (e.target.value = ""))} data-uploader-input />
      {toSet && !setId && !editing && <span className="text-center text-[11px] text-muted" data-uploader-no-set>No media set chosen</span>}
      {toSet && msError && <span className="text-center text-[11px] text-bad" data-uploader-set-error>Media set: {msError}</span>}
      {note && <span className="text-center text-[11px] text-muted" data-uploader-note>{note}</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Resource List
// ------------------------------------------------------------------------------------------------

type Entry = {
  key: string; title: string; description?: string; icon: IconName; href?: string; item?: ResourceItem; typeId?: string;
  /** a Files item: whether the viewer starred it, and (an image file) its own content as the card's thumbnail */
  fileId?: string; starred?: boolean; image?: string;
  /** an object type's own colour (the icon's colour unless overridden) */
  color?: string | null;
  /** a Files item's tags, when the list came with them ("Tags" content) */
  tags?: FileTag[];
};

const TagChip = ({ t, on, onClick }: { t: FileTag; on?: boolean; onClick?: () => void }) =>
  onClick ? (
    <button type="button" onClick={onClick} aria-pressed={!!on} title={`${t.category}: ${t.name}`} className={`rounded-full border px-2 py-0.5 text-[10px] ${on ? "border-ocean bg-ocean/20 text-white" : "border-line-2 text-muted hover:text-white"}`} data-resource-tag-filter={t.id}>
      {t.name}
    </button>
  ) : (
    <span title={`${t.category}: ${t.name}`} className="rounded-full bg-panel-2 px-1.5 text-[9px] text-soft" data-resource-tag={t.id}>
      {t.name}
    </span>
  );

export function ResourceListWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const kind = c.list_type ?? "files";
  const content = c.list_content ?? "static";
  const [entries, setEntries] = useState<Entry[] | null>(null);
  // the viewer's favorite object types (null: not loaded), and the Files stars changed here
  const [favTypes, setFavTypes] = useState<string[] | null>(null);
  const [stars, setStars] = useState<Record<string, boolean>>({});
  const [starError, setStarError] = useState<string | null>(null);
  const needFavs = kind === "object_types" && (content === "favorite" || !!c.favorite_toggle);
  const statics = useMemo(() => (c.resource_items ?? []).filter((it) => !it.visible_variable || state.variables[it.visible_variable] !== false), [c.resource_items, state.variables]);
  const tagIds = (c.resource_tags ?? []).join(",");
  useEffect(() => {
    let stale = false;
    const done = (e: Entry[]) => !stale && setEntries(e);
    const fileEntry = (d: DriveItem, it?: ResourceItem): Entry => ({
      key: d.id, title: it?.title ? fillVars(it.title, state.variables) : d.name, description: it?.description ? fillVars(it.description, state.variables) : d.kind === "file" ? d.content_type ?? "file" : d.kind,
      icon: (it?.icon as IconName) || (d.kind === "file" ? "doc" : d.kind === "project" ? "project" : "folder"), href: d.kind === "file" ? `${API_URL}/api/drive/items/${d.id}/content` : `/files/${d.id}`, item: it,
      fileId: d.id, starred: !!d.starred, image: d.kind === "file" && (d.content_type ?? "").startsWith("image/") ? d.id : undefined,
    });
    if (kind === "files") {
      if (content === "recent") api.drive.recent().then((x) => done(x.slice(0, 30).map((d) => fileEntry(d))), () => done([]));
      else if (content === "favorite") api.drive.starred().then((x) => done(x.map((d) => fileEntry(d))), () => done([]));
      else if (content === "tags")
        // resources having one of the chosen tags, with their tags
        (tagIds ? workshop.taggedResources(tagIds.split(",")) : Promise.resolve([])).then((x) => done(x.map((d) => ({ ...fileEntry(d), tags: d.tags }))), () => done([]));
      else if (content === "folder")
        Promise.all(statics.map((it) => (it.id ? api.drive.folder(it.id).then((f) => f.items) : Promise.resolve([] as DriveItem[]))))
          .then((ls) => done(ls.flat().map((d) => fileEntry(d))), () => done([]));
      else Promise.all(statics.map((it) => (it.id ? api.drive.item(it.id).then((d) => fileEntry(d, it), () => null) : Promise.resolve(null)))).then((x) => done(x.filter((e): e is Entry => !!e)));
    } else if (kind === "object_types") {
      workshop.sources().then((s) => {
        // dynamic content: every visible type, those marked prominent, or (filtered below) the viewer's favorites
        const types =
          content === "all" || content === "prominent" || content === "favorite"
            ? s.object_types.filter((t) => content !== "prominent" || t.prominent).map((t) => ({ t, it: undefined as ResourceItem | undefined }))
            : statics.map((it) => ({ t: s.object_types.find((x) => x.id === it.id), it })).filter((x) => x.t);
        done(types.map(({ t, it }) => ({ key: t!.id, typeId: t!.id, title: it?.title ? fillVars(it.title, state.variables) : t!.name, description: it?.description ? fillVars(it.description, state.variables) : `${t!.count.toLocaleString()} objects`, icon: (it?.icon as IconName) || "cube", color: t!.color, href:`/ontology/object-explorer?type=${t!.id}`, item: it })));
      }, () => done([]));
    } else {
      done(statics.map((it, i) => ({ key: `${i}`, title: it.title ? fillVars(it.title, state.variables) : it.variable ?? `Object set ${i + 1}`, description: it.description, icon: (it.icon as IconName) || "layers", item: it })));
    }
    return () => {
      stale = true;
    };
  }, [kind, content, statics, state.variables, tagIds]);
  // Files tags: each listed resource's tags (the "Tags" content brings its own), for the chips and the tag filter
  const needTags = kind === "files" && content !== "tags" && (!!c.show_tags || !!c.tag_filter);
  const fileIds = useMemo(() => (entries ?? []).map((e) => e.fileId).filter((x): x is string => !!x).join(","), [entries]);
  const [tagMap, setTagMap] = useState<{ key: string; map: Record<string, FileTag[]> } | null>(null);
  useEffect(() => {
    if (!needTags || !fileIds) return;
    let stale = false;
    workshop.resourceTagsOf(fileIds.split(",")).then((m) => !stale && setTagMap({ key: fileIds, map: m }), () => !stale && setTagMap({ key: fileIds, map: {} }));
    return () => {
      stale = true;
    };
  }, [needTags, fileIds, state.version]);
  const tagsOf = (e: Entry): FileTag[] => e.tags ?? (e.fileId && tagMap?.key === fileIds ? (tagMap.map[e.fileId] ?? []) : []);
  // the viewer's tag filter: items having one of the picked tags (none picked: every item)
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  useEffect(() => {
    if (!needFavs) return;
    let stale = false;
    workshop.favoriteTypes().then((f) => !stale && setFavTypes(f), () => !stale && setFavTypes([]));
    return () => {
      stale = true;
    };
  }, [needFavs, state.version]);
  const open = (e: Entry) => {
    if (e.typeId && c.selected_type_variable) state.setVariable(c.selected_type_variable, e.typeId);
    if (e.item?.events?.length) return void state.runEvents?.(e.item.events);
    if (e.href) window.open(e.href, "_blank", "noopener");
  };
  const isFav = (e: Entry) => (e.typeId ? !!favTypes?.includes(e.typeId) : (stars[e.key] ?? !!e.starred));
  // the star: an object type's is the viewer's favorite object type, a Files item's is its star in Files
  const toggleFav = (e: Entry) => {
    const next = !isFav(e);
    setStarError(null);
    if (e.typeId) workshop.setFavoriteType(e.typeId, next).then(setFavTypes, (x: Error) => setStarError(x.message));
    else if (e.fileId) api.drive.star(e.fileId, next).then(() => setStars((s) => ({ ...s, [e.key]: next })), (x: Error) => setStarError(x.message));
  };
  if (!entries || (needFavs && !favTypes)) return <Msg>Loading…</Msg>;
  // "Favorite" content: only the favorites (object types in the order they were starred); an item leaves when its star is removed here
  const shown =
    content !== "favorite" ? entries : kind === "object_types" ? (favTypes ?? []).map((id) => entries.find((e) => e.typeId === id)).filter((e): e is Entry => !!e) : kind === "files" ? entries.filter((e) => stars[e.key] !== false) : entries;
  if (!shown.length)
    return <Msg>{content === "favorite" ? (kind === "object_types" ? "No favorite object types" : "No favorite resources") : content === "tags" && kind === "files" ? (tagIds ? "No resources with these tags" : "Choose the tags in the panel") : "No resources"}</Msg>;
  const cards = c.item_format === "cards";
  const canStar = !!c.favorite_toggle && kind !== "object_sets" && !state.readOnly;
  // the tag bar: every tag of the listed resources (by category, then name); a picked tag no item has any more is dropped
  const filterTags = kind === "files" && c.tag_filter ? [...new Map(shown.flatMap(tagsOf).map((t) => [t.id, t])).values()].sort((p, q) => p.category.localeCompare(q.category) || p.name.localeCompare(q.name)) : [];
  const picked = pickedTags.filter((id) => filterTags.some((t) => t.id === id));
  const listed = picked.length ? shown.filter((e) => tagsOf(e).some((t) => picked.includes(t.id))) : shown;
  const showTags = kind === "files" && !!c.show_tags;
  return (
    <div className={`h-full overflow-y-auto p-2 text-xs ${cards ? "grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] content-start gap-2" : "space-y-1"}`} data-resource-list={kind}>
      {filterTags.length > 0 && (
        <div className="col-span-full flex flex-wrap items-center gap-1 pb-1" data-resource-tag-bar>
          {filterTags.map((t) => (
            <TagChip key={t.id} t={t} on={picked.includes(t.id)} onClick={() => setPickedTags(picked.includes(t.id) ? picked.filter((x) => x !== t.id) : [...picked, t.id])} />
          ))}
          {picked.length > 0 && (
            <button type="button" onClick={() => setPickedTags([])} className="px-1 text-[10px] text-muted hover:text-white" data-resource-tag-clear>
              Clear
            </button>
          )}
        </div>
      )}
      {starError && (
        <p className="col-span-full text-bad" data-resource-star-error>
          {starError}
        </p>
      )}
      {listed.map((e) => {
        const style = e.item?.style ?? c.item_style ?? "classic";
        // image cards: the item's thumbnail (a Files image), else an image file shows itself
        const thumb = cards ? e.item?.thumbnail || (c.image_thumbnails !== false ? e.image : undefined) : undefined;
        const pos = e.item?.thumbnail_position ?? "top";
        const side = pos === "left" || pos === "right";
        const fav = isFav(e);
        // the icon colour: the item's override, the list's, else an object type's own colour (none: the theme's)
        const iconColor = e.item?.icon_color || c.icon_color || e.color || undefined;
        return (
          <div key={e.key} className={`relative ${cards ? "" : "flex items-center gap-1"}`} data-resource-item={e.key} {...(c.favorite_toggle || content === "favorite" ? { "data-resource-favorite": fav ? "1" : "0" } : {})}>
            <button
              type="button"
              onClick={() => open(e)}
              className={`flex w-full min-w-0 gap-2 overflow-hidden rounded-md text-left hover:bg-panel-2 ${
                cards
                  ? `h-full border border-line ${thumb ? (pos === "bottom" ? "flex-col-reverse" : pos === "left" ? "flex-row" : pos === "right" ? "flex-row-reverse" : "flex-col") : "flex-col items-start p-3"}`
                  : `items-center ${style === "minimal" ? "px-1 py-0.5" : "border border-line px-2 py-1.5"}`
              }`}
              data-resource-entry={e.key}
              data-resource-style={style}
              {...(thumb ? { "data-resource-thumb-position": pos } : {})}
            >
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element -- a Files image, served by the API with the viewer's session
                <img src={driveContentUrl(encodeURIComponent(thumb), true)} alt="" loading="lazy" className={`shrink-0 bg-panel-2 object-cover ${side ? "min-h-16 w-16 self-stretch" : style === "minimal" ? "h-16 w-full" : "h-24 w-full"}`} data-resource-thumb={thumb} />
              ) : (
                <span className="contents" style={iconColor ? { color: iconColor } : undefined} data-resource-icon-color={iconColor ?? ""}>
                  <Icon name={e.icon} className={`${style === "prominent" || cards ? "h-5 w-5" : "h-3.5 w-3.5"} shrink-0 ${iconColor ? "" : "text-ocean"}`} />
                </span>
              )}
              <span className={`min-w-0 flex-1 ${thumb ? "p-2" : ""} ${canStar && cards ? "pr-5" : ""}`}>
                <span className={`block truncate ${style === "prominent" ? "text-sm font-semibold" : ""}`}>{e.title}</span>
                {style !== "minimal" && e.description && <span className="block truncate text-[10px] text-muted">{e.description}</span>}
                {showTags && tagsOf(e).length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-0.5" data-resource-tags={e.key}>
                    {tagsOf(e).map((t) => (
                      <TagChip key={t.id} t={t} />
                    ))}
                  </span>
                )}
              </span>
            </button>
            {canStar && (
              <button
                type="button"
                onClick={() => toggleFav(e)}
                aria-pressed={fav}
                aria-label={`${fav ? "Remove from favorites" : "Add to favorites"}: ${e.title}`}
                title={fav ? "Remove from favorites" : "Add to favorites"}
                className={`shrink-0 rounded px-1 leading-none ${fav ? "text-amber-400" : "text-muted hover:text-white"} ${cards ? "absolute right-1 top-1 bg-panel/80" : ""}`}
                data-resource-star={e.key}
              >
                {fav ? "★" : "☆"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Markdown: object references and annotations
// ------------------------------------------------------------------------------------------------

type Annot = { pk: string; start: number; end: number; label: string };

export function MarkdownWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const raw = c.text ? (state.tr?.(c.text) ?? c.text) : editing ? "_Write text in the panel on the right…_" : "";
  const text = fillVars(raw, state.variables);
  const [last, setLast] = useState<{ type: string; pk: string } | null>(null);
  const refs = useMemo(() => mdRefs(text), [text]);
  // highlight: the last selected reference, or the module's selection of that object type
  const selected = c.md_select === "none" ? null : c.md_select === "selected" ? (refs.find((r) => state.selection[sourceKey({ kind: "object_type", id: r.type })] === r.pk) ?? null) : last;
  const a = c.md_annotation;
  if (a?.object_type_id) return <AnnotatedText state={state} editing={editing} text={text} a={a} />;
  return (
    <>
      <style>{WS_MARKDOWN_CSS}</style>
      <div
        className="md-body h-full overflow-auto px-4 py-2 text-sm text-soft"
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest("[data-ref-type]") as HTMLElement | null;
          if (!el || editing) return;
          const type = el.dataset.refType!;
          const pk = el.dataset.refPk!;
          setLast({ type, pk });
          state.select(sourceKey({ kind: "object_type", id: type }), pk);
          if (c.md_ref_events?.length) void state.runEvents?.(c.md_ref_events);
        }}
        dangerouslySetInnerHTML={{ __html: renderWorkshopMarkdown(text, c.md_ref_colors, selected) }}
      />
    </>
  );
}

/** Plain text with annotation objects highlighted by character range; selecting text offers creating one. */
function AnnotatedText({ state, editing, text, a }: { state: ModuleState; editing: boolean; text: string; a: MdAnnotation }) {
  const [annots, setAnnots] = useState<Annot[]>([]);
  const [sel, setSel] = useState<{ start: number; end: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const linkValue = a.link_value ? valueOf(a.link_value, state.variables) : undefined;
  useEffect(() => {
    let stale = false;
    workshop
      .query({ source: { kind: "object_type", id: a.object_type_id }, filters: a.link_prop && linkValue !== undefined ? [{ column: a.link_prop, op: "eq", value: linkValue }] : [], columns: [a.start, a.end, ...(a.label ? [a.label] : [])], limit: 500 })
      .then((r) => !stale && setAnnots((r.rows ?? []).map((x) => ({ pk: String(x.__pk), start: Number(x[a.start]), end: Number(x[a.end]), label: a.label ? fmt(x[a.label]) : "" })).filter((x) => Number.isFinite(x.start) && x.end > x.start)), () => !stale && setAnnots([]));
    return () => {
      stale = true;
    };
  }, [a.object_type_id, a.start, a.end, a.label, a.link_prop, linkValue, state.version]);
  // split the text at every boundary: each piece knows its start offset and the annotations covering it
  const pieces = useMemo(() => {
    const cuts = new Set([0, text.length]);
    for (const x of annots) {
      cuts.add(Math.max(0, Math.min(text.length, x.start)));
      cuts.add(Math.max(0, Math.min(text.length, x.end)));
    }
    const sorted = [...cuts].sort((p, q) => p - q);
    return sorted.slice(0, -1).map((s, i) => ({ start: s, text: text.slice(s, sorted[i + 1]), on: annots.filter((x) => x.start <= s && x.end >= sorted[i + 1]) }));
  }, [text, annots]);
  const color = a.color ?? "#e3b341";
  const onUp = () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !box.current) return setSel(null);
    const off = (node: Node, o: number) => {
      const el = (node.nodeType === 3 ? node.parentElement : (node as HTMLElement))?.closest("[data-off]") as HTMLElement | null;
      return el ? Number(el.dataset.off) + o : null;
    };
    const p = off(s.anchorNode!, s.anchorOffset);
    const q = off(s.focusNode!, s.focusOffset);
    if (p === null || q === null) return setSel(null);
    const [start, end] = p < q ? [p, q] : [q, p];
    setSel({ start, end, text: text.slice(start, end) });
  };
  const create = async () => {
    if (!sel || !a.create_action) return;
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {};
      if (a.start_param) params[a.start_param] = sel.start;
      if (a.end_param) params[a.end_param] = sel.end;
      if (a.text_param) params[a.text_param] = sel.text;
      if (a.link_param && linkValue !== undefined) params[a.link_param] = linkValue;
      await actions.apply(a.create_action, params);
      setSel(null);
      state.bump();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative h-full overflow-auto px-4 py-2 text-sm leading-relaxed text-soft" data-annotated>
      <div ref={box} onMouseUp={onUp} className="whitespace-pre-wrap">
        {pieces.map((p) =>
          p.on.length ? (
            <span
              key={p.start}
              data-off={p.start}
              className="ws-annot"
              style={{ background: `color-mix(in srgb, ${color} ${Math.min(70, 30 + p.on.length * 15)}%, transparent)` }}
              title={p.on.map((x) => x.label || x.pk).join(", ")}
              onClick={() => {
                state.select(sourceKey({ kind: "object_type", id: a.object_type_id }), p.on[0].pk);
                if (a.on_select?.length) void state.runEvents?.(a.on_select);
              }}
              data-annotation={p.on.map((x) => x.pk).join(",")}
            >
              {p.text}
            </span>
          ) : (
            <span key={p.start} data-off={p.start}>
              {p.text}
            </span>
          ),
        )}
      </div>
      {sel && a.create_action && !editing && !state.readOnly && (
        <div className="sticky bottom-0 mt-2 flex items-center gap-2 rounded border border-line-2 bg-panel p-1.5 text-xs shadow-lg" data-annotate-bar>
          <span className="min-w-0 flex-1 truncate text-muted">“{sel.text.slice(0, 60)}” ({sel.start}–{sel.end})</span>
          <button type="button" onClick={create} disabled={busy} className="rounded bg-ocean px-2 py-0.5 text-white disabled:opacity-40" data-annotate>
            {busy ? "…" : "Annotate"}
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

export const OBJECT_TYPES = new Set(["object_view", "edit_history", "action_log", "linked_resources", "media_uploader", "resource_list"]);

export function ObjectWidgetConfig({ widget, set, mod, cols, sources }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[]; sources: Sources }) {
  const c = widget.config;
  const t = widget.type;
  const vars = mod.variables ?? [];
  const [actionTypes, setActionTypes] = useState<ActionType[]>([]);
  const [action, setAction] = useState<ActionType | null>(null);
  // the Resource List's Files picker: an item's thumbnail (an image) or its Files item
  const [picking, setPicking] = useState<{ i: number; what: "thumbnail" | "item" } | null>(null);
  const [thumbNames, setThumbNames] = useState<Record<string, string>>({});
  // the Files tags the builder can choose (Resource List "Tags" content), loaded once for a Files list
  const [allTags, setAllTags] = useState<FileTag[] | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const filesList = t === "resource_list" && (c.list_type ?? "files") === "files";
  useEffect(() => {
    if (!filesList || allTags) return;
    workshop.resourceTags().then(setAllTags, (e: Error) => (setTagsError(e.message), setAllTags([])));
  }, [filesList, allTags]);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (t !== "resource_list") return;
    // each thumbnail's Files name, asked once ("" when it is gone or not visible)
    for (const x of new Set((c.resource_items ?? []).map((it) => it.thumbnail))) {
      if (!x || asked.current.has(x)) continue;
      asked.current.add(x);
      api.drive.item(x).then((d) => setThumbNames((m) => ({ ...m, [x]: d.name })), () => setThumbNames((m) => ({ ...m, [x]: "" })));
    }
  }, [t, c.resource_items]);
  useEffect(() => {
    if (t === "action_log" || t === "media_uploader" || t === "text") ontology.actionTypes().then(setActionTypes, () => {});
  }, [t]);
  useEffect(() => {
    if (t === "media_uploader" && c.upload_action) ontology.actionType(c.upload_action).then(setAction, () => setAction(null));
  }, [t, c.upload_action]);
  const strVar = (value: string | undefined, onChange: (v: string | undefined) => void, empty = "None") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{empty}</option>
      {vars.filter((v) => v.type === "string").map((v) => (
        <option key={v.name}>{v.name}</option>
      ))}
    </select>
  );
  const objectField = (
    <Field label="Object (otherwise the selected object of the source)">
      <input value={String(c.object_pk ?? "")} onChange={(e) => set({ object_pk: e.target.value || undefined })} placeholder="$var:name or a primary key" className={inputClass} />
    </Field>
  );
  const folderField = (
    <>
      <Field label="Upload folder (a Files folder ID; empty: My Project)">
        <input value={c.upload_folder ?? ""} onChange={(e) => set({ upload_folder: e.target.value || undefined })} className={inputClass} />
      </Field>
      <Field label="…or from a string variable (dynamic)">{strVar(c.upload_folder_variable, (v) => set({ upload_folder_variable: v }))}</Field>
    </>
  );
  if (t === "object_view")
    return (
      <div className="space-y-3">
        {objectField}
        {c.source?.kind === "interface" && (
          <p className="text-[11px] text-muted" data-ov-config-interface>
            An interface source: each object shows its implementing type&apos;s Object View (configured: that type&apos;s published view); the standard panel lists the interface&apos;s properties read through the type&apos;s mapping. A fixed object reads &quot;type id:primary key&quot;.
          </p>
        )}
        <Field label="Form factor">
          <select value={c.form_factor ?? "full"} onChange={(e) => set({ form_factor: e.target.value as "full" })} className={inputClass}>
            <option value="full">Full object view</option>
            <option value="panel">Panel</option>
          </select>
        </Field>
        {c.form_factor === "panel" ? (
          <>
            <Field label="Panel behavior">
              <select value={c.panel_behavior ?? "adaptive"} onChange={(e) => set({ panel_behavior: e.target.value as "adaptive" })} className={inputClass}>
                <option value="instance">Object instance</option>
                <option value="adaptive">Adaptive (one object, else the set)</option>
                <option value="set">Object set (aggregates)</option>
              </select>
            </Field>
            <Field label="Object view mode" hint="Configured: the panel properties of the type's published Object View">
              <select value={c.view_mode ?? "standard"} onChange={(e) => set({ view_mode: e.target.value === "configured" ? "configured" : undefined })} className={inputClass} data-ov-config="view_mode">
                <option value="standard">Standard (the visible properties)</option>
                <option value="configured">Configured (the type&apos;s Object View)</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!c.view_mode_toggle} onChange={(e) => set({ view_mode_toggle: e.target.checked || undefined })} data-ov-config="view_mode_toggle" /> Viewers can switch between standard and configured
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!c.hide_header} onChange={(e) => set({ hide_header: e.target.checked })} data-ov-config="hide_header" /> Hide header
            </label>
          </>
        ) : (
          <ObjectViewFullConfig c={c} set={set} typeId={c.source?.kind === "object_type" ? c.source.id : undefined} />
        )}
        <Field label="Empty state message">
          <input value={c.empty_message ?? ""} onChange={(e) => set({ empty_message: e.target.value || undefined })} className={inputClass} />
        </Field>
      </div>
    );
  if (t === "edit_history")
    return (
      <div className="space-y-3">
        {objectField}
        <Field label="Order">
          <select value={c.history_order ?? "newest"} onChange={(e) => set({ history_order: e.target.value as "newest" })} className={inputClass}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </Field>
        <Field label="Properties shown (none chosen: all)">
          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {cols.map((x) => {
              const on = (c.history_props ?? []).includes(x.name);
              return (
                <button key={x.name} type="button" onClick={() => set({ history_props: on ? (c.history_props ?? []).filter((y) => y !== x.name) : [...(c.history_props ?? []), x.name] })} className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
                  {x.name}
                </button>
              );
            })}
          </div>
        </Field>
        {c.source?.kind === "object_type" && (
          <div className="flex gap-2 text-xs">
            <button type="button" onClick={() => workshop.setTracking(c.source!.id, true)} className="text-ocean" data-tracking-on>
              Track user edit history for this object type
            </button>
            <button type="button" onClick={() => workshop.setTracking(c.source!.id, false)} className="text-muted hover:text-white">
              Stop
            </button>
          </div>
        )}
      </div>
    );
  if (t === "action_log")
    return (
      <div className="space-y-3">
        {objectField}
        <Field label="Action types shown (none chosen: all)">
          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {actionTypes.filter((a) => !c.source || a.object_type_id === c.source.id).map((a) => {
              const on = (c.log_actions ?? []).includes(a.id);
              return (
                <button key={a.id} type="button" onClick={() => set({ log_actions: on ? (c.log_actions ?? []).filter((y) => y !== a.id) : [...(c.log_actions ?? []), a.id] })} className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
                  {a.display_name}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    );
  if (t === "linked_resources")
    return (
      <div className="space-y-3">
        {objectField}
        <Field label="Heading">
          <input value={c.content_title ?? ""} onChange={(e) => set({ content_title: e.target.value || undefined })} placeholder="Linked files" className={inputClass} />
        </Field>
        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!c.hide_upload} onChange={(e) => set({ hide_upload: e.target.checked })} /> Hide upload
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!c.hide_link} onChange={(e) => set({ hide_link: e.target.checked })} /> Hide link
          </label>
        </div>
        {!c.hide_upload && folderField}
      </div>
    );
  if (t === "media_uploader") {
    const params = (action?.parameters ?? []) as unknown as { id: string; display_name?: string; name?: string }[];
    const defaults = c.action_defaults ?? {};
    return (
      <div className="space-y-3">
        <Field label="Button text">
          <input value={c.button_text ?? ""} onChange={(e) => set({ button_text: e.target.value || undefined })} placeholder="Upload files" className={inputClass} />
        </Field>
        <div className="grid grid-cols-3 gap-1">
          <select value={c.intent ?? "primary"} onChange={(e) => set({ intent: e.target.value as "primary" })} className={inputClass}>
            {["none", "primary", "success", "warning", "danger"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <input value={c.left_icon ?? ""} onChange={(e) => set({ left_icon: e.target.value })} placeholder="left icon" className={inputClass} />
          <input value={c.right_icon ?? ""} onChange={(e) => set({ right_icon: e.target.value || undefined })} placeholder="right icon" className={inputClass} />
        </div>
        <Field label="Upload to">
          <select value={c.upload_target ?? "folder"} onChange={(e) => set({ upload_target: e.target.value === "media_set" ? "media_set" : undefined })} className={inputClass} data-mu-config="upload_target">
            <option value="folder">A Files folder</option>
            <option value="media_set">A media set</option>
          </select>
        </Field>
        {c.upload_target === "media_set" ? <MediaSetTarget c={c} set={set} strVar={strVar} /> : folderField}
        <Field label={`Allowed file extensions (comma-separated; empty: ${c.upload_target === "media_set" ? "the media set's formats" : "any"})`}>
          <input value={c.extensions ?? ""} onChange={(e) => set({ extensions: e.target.value || undefined })} placeholder="pdf, png, jpg" className={inputClass} />
        </Field>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!c.multi} onChange={(e) => set({ multi: e.target.checked })} /> Several files
          </label>
          {c.multi && <input type="number" min={1} max={50} value={c.max_files ?? 10} onChange={(e) => set({ max_files: Number(e.target.value) || 10 })} className={`${fieldClass} w-16 text-xs`} title="At most" />}
        </div>
        <Field label={c.upload_target === "media_set" ? "Uploaded media reference (media item ID) into" : "Uploaded file ID into"}>{strVar(c.rid_variable, (v) => set({ rid_variable: v }))}</Field>
        <Field label={c.upload_target === "media_set" ? "Uploaded item path into" : "Uploaded file name into"}>{strVar(c.filename_variable, (v) => set({ filename_variable: v }))}</Field>
        <Field label="Action run on each uploaded file">
          <select value={c.upload_action ?? ""} onChange={(e) => set({ upload_action: e.target.value || undefined, upload_param: undefined })} className={inputClass}>
            <option value="">No action</option>
            {actionTypes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>
        </Field>
        {c.upload_action && params.length > 0 && (
          <div className="space-y-1 text-xs">
            <div className="text-muted">Parameters: the file identifier into one, the others from values or $var:</div>
            {params.map((p) => (
              <div key={p.id} className="flex items-center gap-1">
                <label className="flex w-28 items-center gap-1 truncate" title={p.id}>
                  <input type="radio" checked={c.upload_param === p.id} onChange={() => set({ upload_param: p.id })} /> {p.display_name ?? p.name ?? p.id}
                </label>
                {c.upload_param !== p.id && <input value={String(defaults[p.id] ?? "")} onChange={(e) => set({ action_defaults: { ...defaults, [p.id]: e.target.value || undefined } })} className={`${fieldClass} min-w-0 flex-1 text-xs`} />}
                {c.upload_param === p.id && <span className="text-muted">File identifier</span>}
              </div>
            ))}
          </div>
        )}
        <EventsEditor events={c.events ?? []} mod={mod} onChange={(ev) => set({ events: ev })} label="After uploading" />
      </div>
    );
  }
  if (t === "resource_list") {
    const items = c.resource_items ?? [];
    const kind = c.list_type ?? "files";
    const contents = kind === "files" ? ["static", "recent", "favorite", "folder", "tags"] : kind === "object_types" ? ["static", "all", "prominent", "favorite"] : ["static"];
    const cardFormat = c.item_format === "cards";
    const setIt = (i: number, x: Partial<ResourceItem>) => set({ resource_items: items.map((y, j) => (j === i ? { ...y, ...x } : y)) });
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-1">
          <select value={kind} onChange={(e) => set({ list_type: e.target.value as "files", list_content: "static", resource_items: [] })} className={inputClass}>
            <option value="files">Files and Projects</option>
            <option value="object_types">Object types</option>
            <option value="object_sets">Object sets</option>
          </select>
          <select value={c.list_content ?? "static"} onChange={(e) => set({ list_content: e.target.value as "static" })} className={inputClass} data-rl-config="list_content">
            {contents.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <select value={c.item_format ?? "list"} onChange={(e) => set({ item_format: e.target.value as "list" })} className={inputClass} data-rl-config="item_format">
            <option value="list">List</option>
            <option value="cards">Image cards</option>
          </select>
          <select value={c.item_style ?? "classic"} onChange={(e) => set({ item_style: e.target.value as "classic" })} className={inputClass}>
            <option value="minimal">Minimal</option>
            <option value="classic">Classic</option>
            <option value="prominent">Prominent</option>
          </select>
        </div>
        {kind !== "object_sets" && (
          <label className="flex items-center gap-2 text-xs" title={kind === "object_types" ? "Each viewer's own favorite object types (the Favorite content shows them)" : "The item's star in Files"}>
            <input type="checkbox" checked={!!c.favorite_toggle} onChange={(e) => set({ favorite_toggle: e.target.checked || undefined })} data-rl-config="favorite_toggle" /> A star on each item (viewers favorite it)
          </label>
        )}
        <div className="flex items-center gap-2 text-xs" title={kind === "object_types" ? "Empty: each object type's own colour" : "Empty: the theme's colour"}>
          <span>Icon colour</span>
          <input type="color" value={c.icon_color || "#1f6feb"} onChange={(e) => set({ icon_color: e.target.value })} className="h-5 w-6 bg-transparent" data-rl-config="icon_color" />
          {c.icon_color ? (
            <button type="button" onClick={() => set({ icon_color: undefined })} className="text-muted hover:text-white" data-rl-config="icon_color_reset">
              Reset
            </button>
          ) : (
            <span className="text-muted">{kind === "object_types" ? "the type's own" : "default"}</span>
          )}
        </div>
        {cardFormat && kind === "files" && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={c.image_thumbnails !== false} onChange={(e) => set({ image_thumbnails: e.target.checked ? undefined : false })} data-rl-config="image_thumbnails" /> Image files show themselves as the thumbnail
          </label>
        )}
        {kind === "files" && c.list_content === "tags" && (
          <Field label="Tags (resources having one of them)">
            <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto" data-rl-config="resource_tags">
              {(allTags ?? []).map((x) => {
                const on = (c.resource_tags ?? []).includes(x.id);
                return (
                  <button key={x.id} type="button" onClick={() => set({ resource_tags: on ? (c.resource_tags ?? []).filter((y) => y !== x.id) : [...(c.resource_tags ?? []), x.id] })} aria-pressed={on} title={x.category} className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`} data-rl-tag={x.id}>
                    {x.name}
                  </button>
                );
              })}
              {(c.resource_tags ?? []).filter((id) => allTags && !allTags.some((x) => x.id === id)).map((id) => (
                <button key={id} type="button" onClick={() => set({ resource_tags: (c.resource_tags ?? []).filter((y) => y !== id) })} className="rounded border border-bad px-1.5 py-0.5 text-[11px] text-bad" title="This tag no longer exists (or is not visible to you): remove it" data-rl-tag-gone={id}>
                  {id} ✕
                </button>
              ))}
              {allTags && !allTags.length && <span className="text-xs text-muted">{tagsError ?? "No tags yet: an administrator creates them in Files settings (Compass)"}</span>}
              {!allTags && <span className="text-xs text-muted">Loading…</span>}
            </div>
          </Field>
        )}
        {kind === "files" && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={!!c.show_tags} onChange={(e) => set({ show_tags: e.target.checked || undefined })} data-rl-config="show_tags" /> Show each item&apos;s tags
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={!!c.tag_filter} onChange={(e) => set({ tag_filter: e.target.checked || undefined })} data-rl-config="tag_filter" /> Viewers filter by tag
            </label>
          </div>
        )}
        {(c.list_content ?? "static") === "static" || c.list_content === "folder" ? (
          <Field label={c.list_content === "folder" ? "Folders and Projects (their contents)" : "Items (with display overrides and events)"}>
            <div className="space-y-1">
              {items.map((it, i) => (
                <div key={i} className="space-y-1 rounded border border-line p-1.5 text-xs">
                  <div className="flex gap-1">
                    {kind === "object_types" ? (
                      <select value={it.id ?? ""} onChange={(e) => setIt(i, { id: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
                        <option value="">Object type…</option>
                        {sources.object_types.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    ) : kind === "object_sets" ? (
                      <select value={it.variable ?? ""} onChange={(e) => setIt(i, { variable: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
                        <option value="">Object set variable…</option>
                        {vars.filter((v) => v.type === "object_set" || v.type === "object_set_filter").map((v) => (
                          <option key={v.name}>{v.name}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input value={it.id ?? ""} onChange={(e) => setIt(i, { id: e.target.value })} placeholder="Files item ID" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                        <button type="button" onClick={() => setPicking({ i, what: "item" })} className="px-1 text-ocean" title="Choose in Files" data-rl-item-pick={i}>
                          Choose…
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => set({ resource_items: items.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                      ✕
                    </button>
                  </div>
                  {c.list_content !== "folder" && (
                    <>
                      <div className="flex gap-1">
                        <input value={it.title ?? ""} onChange={(e) => setIt(i, { title: e.target.value || undefined })} placeholder="title ({{variables}})" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                        <input value={it.icon ?? ""} onChange={(e) => setIt(i, { icon: e.target.value || undefined })} placeholder="icon" className={`${fieldClass} w-14 text-xs`} />
                        <input type="color" value={it.icon_color || c.icon_color || "#1f6feb"} onChange={(e) => setIt(i, { icon_color: e.target.value })} className={`h-6 w-6 shrink-0 bg-transparent ${it.icon_color ? "" : "opacity-50"}`} title={it.icon_color ? "Icon colour (this item)" : "Icon colour: as the list"} data-rl-item-icon-color={i} />
                        {it.icon_color && (
                          <button type="button" onClick={() => setIt(i, { icon_color: undefined })} className="px-0.5 text-muted hover:text-white" title="Icon colour as the list" data-rl-item-icon-color-reset={i}>
                            ↺
                          </button>
                        )}
                      </div>
                      <input value={it.description ?? ""} onChange={(e) => setIt(i, { description: e.target.value || undefined })} placeholder="description" className={`${fieldClass} w-full text-xs`} />
                      <select value={it.style ?? ""} onChange={(e) => setIt(i, { style: (e.target.value || undefined) as ResourceItem["style"] })} className={`${fieldClass} w-full text-xs`} data-rl-item-style={i}>
                        <option value="">Style: as the list</option>
                        <option value="minimal">Minimal</option>
                        <option value="classic">Classic</option>
                        <option value="prominent">Prominent</option>
                      </select>
                      {cardFormat && (
                        <div className="flex items-center gap-1">
                          {it.thumbnail ? (
                            <>
                              {/* eslint-disable-next-line @next/next/no-img-element -- a Files image, served by the API with the viewer's session */}
                              <img src={driveContentUrl(encodeURIComponent(it.thumbnail), true)} alt="" className="h-6 w-6 shrink-0 rounded bg-panel-2 object-cover" data-rl-item-thumbnail-preview={i} />
                              <span className={`min-w-0 flex-1 truncate ${thumbNames[it.thumbnail] === "" ? "text-bad" : ""}`} title={it.thumbnail} data-rl-item-thumbnail-name={i}>
                                {thumbNames[it.thumbnail] === "" ? "not found" : thumbNames[it.thumbnail] || "…"}
                              </span>
                              <button type="button" onClick={() => setIt(i, { thumbnail: undefined })} className="px-0.5 text-muted hover:text-bad" title="No thumbnail" data-rl-item-thumbnail-clear={i}>
                                ✕
                              </button>
                            </>
                          ) : (
                            <span className="min-w-0 flex-1 text-muted">No thumbnail</span>
                          )}
                          <button type="button" onClick={() => setPicking({ i, what: "thumbnail" })} className="shrink-0 text-ocean" data-rl-item-thumbnail-pick={i}>
                            {it.thumbnail ? "Change…" : "Thumbnail…"}
                          </button>
                        </div>
                      )}
                      {cardFormat && (
                        <div className="flex gap-1">
                          <input value={it.thumbnail ?? ""} onChange={(e) => setIt(i, { thumbnail: e.target.value.trim() || undefined })} placeholder="…or paste a Files image ID" className={`${fieldClass} min-w-0 flex-1 text-xs`} data-rl-item-thumbnail={i} />
                          <select value={it.thumbnail_position ?? "top"} onChange={(e) => setIt(i, { thumbnail_position: e.target.value === "top" ? undefined : (e.target.value as ResourceItem["thumbnail_position"]) })} className={`${fieldClass} w-20 text-xs`} title="Thumbnail position" data-rl-item-thumbnail-position={i}>
                            <option value="top">Top</option>
                            <option value="right">Right</option>
                            <option value="bottom">Bottom</option>
                            <option value="left">Left</option>
                          </select>
                        </div>
                      )}
                      <select value={it.visible_variable ?? ""} onChange={(e) => setIt(i, { visible_variable: e.target.value || undefined })} className={`${fieldClass} w-full text-xs`}>
                        <option value="">Always visible</option>
                        {vars.filter((v) => v.type === "boolean").map((v) => (
                          <option key={v.name}>{v.name}</option>
                        ))}
                      </select>
                      <EventsEditor events={it.events ?? []} mod={mod} onChange={(ev) => setIt(i, { events: ev })} label="On select (instead of opening)" />
                    </>
                  )}
                </div>
              ))}
              <button type="button" onClick={() => set({ resource_items: [...items, {}] })} className="text-xs text-ocean">
                + Item
              </button>
            </div>
          </Field>
        ) : null}
        {kind === "object_types" && <Field label="Selected object type into">{strVar(c.selected_type_variable, (v) => set({ selected_type_variable: v }))}</Field>}
        {picking && items[picking.i] && (
          <DrivePicker
            title={picking.what === "thumbnail" ? "The item's thumbnail (an image in Files)" : c.list_content === "folder" ? "A folder or Project whose contents are listed" : "A Files resource"}
            canPick={(d) => (picking.what === "thumbnail" ? (d.kind === "file" && (d.content_type ?? "").startsWith("image/") ? null : "choose an image file") : null)}
            folder={picking.what === "item" && c.list_content === "folder" ? { action: "Use this folder", onPick: (f) => (f.id && setIt(picking.i, { id: f.id }), setPicking(null)) } : undefined}
            onPick={(d) => {
              if (picking.what === "thumbnail") {
                setThumbNames((m) => ({ ...m, [d.id]: d.name }));
                setIt(picking.i, { thumbnail: d.id });
              } else setIt(picking.i, { id: d.id });
              setPicking(null);
            }}
            onClose={() => setPicking(null)}
          />
        )}
      </div>
    );
  }
  return null;
}

/** The Media Uploader's media set: one of the media sets the user can see (not virtual ones), or a string variable. */
function MediaSetTarget({ c, set, strVar }: { c: WidgetConfig; set: (x: Partial<WidgetConfig>) => void; strVar: (value: string | undefined, onChange: (v: string | undefined) => void, empty?: string) => React.ReactNode }) {
  const [sets, setSets] = useState<MediaSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    mediaSets.list().then((x) => !stale && setSets(x.filter((s) => !s.virtual)), (e: Error) => !stale && (setError(e.message), setSets([])));
    return () => {
      stale = true;
    };
  }, []);
  const cur = sets?.find((s) => s.id === c.media_set);
  return (
    <>
      <Field label="Media set">
        <select value={c.media_set ?? ""} onChange={(e) => set({ media_set: e.target.value || undefined })} className={inputClass} data-mu-config="media_set">
          <option value="">{sets ? "Choose a media set…" : "Loading…"}</option>
          {c.media_set && sets && !cur && <option value={c.media_set}>{c.media_set} (not available)</option>}
          {(sets ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.schema}
              {s.transaction_policy === "transactional" ? ", transactional" : ""}
            </option>
          ))}
        </select>
      </Field>
      {error && <p className="text-xs text-bad">{error}</p>}
      {cur && (
        <p className="text-[11px] text-muted" data-mu-set-info>
          {cur.schema === "multimodal" ? "Any file format" : `Takes .${mediaSetExtensions(cur).join(", .")}`}
          {cur.transaction_policy === "transactional" ? "; each click's files are committed in one transaction" : ""}
          {cur.built_by ? `; written by a ${cur.built_by} build too` : ""}
        </p>
      )}
      <Field label="…or from a string variable holding its ID (dynamic)">{strVar(c.media_set_variable, (v) => set({ media_set_variable: v }))}</Field>
    </>
  );
}

type ViewTab = { id: string; title: string; kind: string; module_id?: string | null };

/** The full object view's options: header and tabs hidden, the initial tab, and the interface of each Workshop tab. */
function ObjectViewFullConfig({ c, set, typeId }: { c: WidgetConfig; set: (x: Partial<WidgetConfig>) => void; typeId?: string }) {
  // the tabs of the type's published Object View (none published: the default tabs)
  const [tabs, setTabs] = useState<ViewTab[]>([]);
  useEffect(() => {
    if (!typeId) return;
    let stale = false;
    request<{ config: { tabs?: ViewTab[] } }>(`/object-types/${typeId}/views`).then((v) => !stale && setTabs(v.config.tabs ?? []), () => !stale && setTabs([]));
    return () => {
      stale = true;
    };
  }, [typeId]);
  const known = typeId ? tabs : [];
  const moduleTabs = known.filter((x) => x.kind === "workshop" && x.module_id);
  const maps = c.tab_interfaces ?? {};
  const setMap = (tab: string, m: Record<string, unknown> | undefined) => {
    const next = Object.fromEntries(Object.entries({ ...maps, [tab]: m }).filter(([, v]) => v !== undefined)) as Record<string, Record<string, unknown>>;
    set({ tab_interfaces: Object.keys(next).length ? next : undefined });
  };
  return (
    <div className="space-y-3" data-ov-full-config>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!c.hide_header} onChange={(e) => set({ hide_header: e.target.checked })} data-ov-config="hide_header" /> Hide header
      </label>
      <label className="flex items-center gap-2 text-xs" title="Viewers cannot go to the other tabs; a view with one tab never shows its tab bar">
        <input type="checkbox" checked={!!c.hide_tabs} onChange={(e) => set({ hide_tabs: e.target.checked || undefined })} data-ov-config="hide_tabs" /> Hide tabs
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!c.reset_tab} onChange={(e) => set({ reset_tab: e.target.checked || undefined })} data-ov-config="reset_tab" /> Go to the initial tab when the object changes
      </label>
      <Field label="Initial tab (empty: the first tab)">
        {known.length ? (
          <select value={c.initial_tab ?? ""} onChange={(e) => set({ initial_tab: e.target.value || undefined })} className={inputClass} data-ov-config="initial_tab">
            <option value="">The first tab</option>
            {c.initial_tab && !known.some((x) => x.id === c.initial_tab) && <option value={c.initial_tab}>{c.initial_tab} (not in the published view)</option>}
            {known.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
        ) : (
          <input value={c.initial_tab ?? ""} onChange={(e) => set({ initial_tab: e.target.value || undefined })} placeholder="tab-…" className={inputClass} data-ov-config="initial_tab" />
        )}
      </Field>
      <Field label="Interface configuration" hint="A Workshop tab of the type's Object View runs its module inside the tab, its interface variables set from this module">
        {moduleTabs.length ? (
          <div className="space-y-2">
            {moduleTabs.map((x) => (
              <TabInterface key={x.id} tab={x} mapping={maps[x.id]} onChange={(m) => setMap(x.id, m)} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted" data-ov-no-module-tabs>
            {typeId ? "The type's published Object View has no Workshop tab (add one in Object Views)." : "Choose the object type (source) first."}
          </p>
        )}
      </Field>
    </div>
  );
}

/** One Workshop tab's interface mapping: off (the tab links to its module), or the module in the tab with these values. */
function TabInterface({ tab, mapping, onChange }: { tab: ViewTab; mapping?: Record<string, unknown>; onChange: (m: Record<string, unknown> | undefined) => void }) {
  const [mod, setMod] = useState<Module | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    workshop.moduleAt(tab.module_id!, { published: true }).then((m) => !stale && (setMod(m), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [tab.module_id]);
  // the module's interface: variables marked as interface (or with an external ID); none marked: every variable
  const all = mod?.variables ?? [];
  const marked = all.filter((v) => v.interface || v.external_id);
  const iface = (marked.length ? marked : all).map((v) => ({ key: v.external_id || v.name, label: v.name, type: v.type }));
  const extra = Object.keys(mapping ?? {}).filter((k) => !iface.some((v) => v.key === k));
  const setValue = (k: string, v: string) => onChange(Object.fromEntries(Object.entries({ ...(mapping ?? {}), [k]: v === "" ? undefined : v }).filter(([, x]) => x !== undefined)));
  return (
    <div className="space-y-1 rounded border border-line p-1.5 text-xs" data-ov-tab-interface={tab.id}>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!mapping} onChange={(e) => onChange(e.target.checked ? {} : undefined)} data-ov-tab-interface-on={tab.id} />
        <span className="min-w-0 flex-1 truncate">
          {tab.title} <span className="text-muted">— {mod?.name ?? (error ? "module not available" : "…")}</span>
        </span>
      </label>
      {mapping && error && <p className="text-bad">{error} (the module must be published)</p>}
      {mapping && (
        <>
          {[...iface, ...extra.map((k) => ({ key: k, label: k, type: "not in the module" }))].map((v) => (
            <div key={v.key} className="flex items-center gap-1">
              <span className="w-28 shrink-0 truncate" title={`${v.label} (${v.type})`}>
                {v.label}
              </span>
              <input value={String(mapping[v.key] ?? "")} onChange={(e) => setValue(v.key, e.target.value)} placeholder="$object, $var:name, {{var}} or a value" className={`${fieldClass} min-w-0 flex-1 text-xs`} data-ov-tab-interface-value={`${tab.id}|${v.key}`} />
            </div>
          ))}
          {!iface.length && !error && mod && <p className="text-muted">The module has no variables.</p>}
          <p className="text-[10px] text-muted">$object: the shown object&apos;s primary key.</p>
        </>
      )}
    </div>
  );
}

/** The Markdown widget's object references and annotations (under the text field). */
export function MarkdownConfig({ widget, set, mod, sources }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; sources: Sources }) {
  const c = widget.config;
  const refTypes = [...new Set(mdRefs(c.text ?? "").map((r) => r.type))];
  const colors = c.md_ref_colors ?? {};
  const a = c.md_annotation;
  const setA = (x: Partial<MdAnnotation>) => set({ md_annotation: { ...(a ?? { object_type_id: "", start: "", end: "" }), ...x } });
  const aType = sources.object_types.find((x) => x.id === a?.object_type_id);
  const [actionTypes, setActionTypes] = useState<ActionType[]>([]);
  useEffect(() => {
    if (a?.object_type_id) ontology.actionTypes(a.object_type_id).then(setActionTypes, () => {});
  }, [a?.object_type_id]);
  return (
    <div className="space-y-3 text-xs" data-md-config>
      <p className="text-muted">
        Object references: <code>{":objectreference[text]{objectType=\"…\" primaryKey=\"…\"}"}</code>; also <code>==highlight==</code>, tables and task lists.
      </p>
      {refTypes.length > 0 && (
        <>
          <Field label="Highlight color per referenced object type">
            <div className="space-y-1">
              {refTypes.map((t) => (
                <div key={t} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{sources.object_types.find((x) => x.id === t)?.name ?? t}</span>
                  <input type="color" value={colors[t] ?? "#1f6feb"} onChange={(e) => set({ md_ref_colors: { ...colors, [t]: e.target.value } })} className="h-5 w-6 bg-transparent" />
                </div>
              ))}
            </div>
          </Field>
          <Field label="Selection behavior">
            <select value={c.md_select ?? "last"} onChange={(e) => set({ md_select: e.target.value as "last" })} className={inputClass}>
              <option value="none">No highlight</option>
              <option value="last">Highlight last selected</option>
              <option value="selected">Highlight selected reference (the module&apos;s selection)</option>
            </select>
          </Field>
          <EventsEditor events={c.md_ref_events ?? []} mod={mod} onChange={(ev) => set({ md_ref_events: ev })} label="Event on selection" />
        </>
      )}
      <details className="rounded border border-line p-2" open={!!a?.object_type_id}>
        <summary className="cursor-pointer text-soft">Annotations (the text shown plain, with annotation objects)</summary>
        <div className="mt-2 space-y-1">
          <select value={a?.object_type_id ?? ""} onChange={(e) => (e.target.value ? setA({ object_type_id: e.target.value }) : set({ md_annotation: undefined }))} className={`${fieldClass} w-full text-xs`}>
            <option value="">No annotations</option>
            {sources.object_types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          {a?.object_type_id && (
            <>
              <div className="grid grid-cols-2 gap-1">
                {(["start", "end", "label", "link_prop"] as const).map((k) => (
                  <select key={k} value={(a[k] as string | undefined) ?? ""} onChange={(e) => setA({ [k]: e.target.value || undefined })} className={`${fieldClass} text-xs`}>
                    <option value="">{k === "start" ? "Start index…" : k === "end" ? "End index…" : k === "label" ? "Tooltip property…" : "Link property…"}</option>
                    {(aType?.properties ?? []).map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
              {a.link_prop && <input value={a.link_value ?? ""} onChange={(e) => setA({ link_value: e.target.value || undefined })} placeholder="link value ($var:name)" className={`${fieldClass} w-full text-xs`} />}
              <input type="color" value={a.color ?? "#e3b341"} onChange={(e) => setA({ color: e.target.value })} className="h-5 w-6 bg-transparent" title="Highlight color" />
              <select value={a.create_action ?? ""} onChange={(e) => setA({ create_action: e.target.value || undefined })} className={`${fieldClass} w-full text-xs`}>
                <option value="">No create action</option>
                {actionTypes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
              </select>
              {a.create_action && (
                <div className="grid grid-cols-2 gap-1">
                  {(["start_param", "end_param", "text_param", "link_param"] as const).map((k) => (
                    <input key={k} value={(a[k] as string | undefined) ?? ""} onChange={(e) => setA({ [k]: e.target.value || undefined })} placeholder={`${k.replace("_param", "")} parameter id`} className={`${fieldClass} text-xs`} />
                  ))}
                </div>
              )}
              <EventsEditor events={a.on_select ?? []} mod={mod} onChange={(ev) => setA({ on_select: ev })} label="On annotation select" />
            </>
          )}
        </div>
      </details>
    </div>
  );
}
