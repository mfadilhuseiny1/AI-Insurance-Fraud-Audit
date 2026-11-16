"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { useVulcanScene, vulcanApi, type CadRow, type PartStyles, type Point3, type Schema, type Style } from "@/components/vulcan/VulcanScene";
import type { Module, Variable, Widget, WidgetConfig } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

// The Workshop Vulcan widget (palantir.com/docs/foundry/vulcan/widget; Ontology doc 19): the Vulcan viewport and tools
// (components/vulcan/VulcanScene.tsx, the same as the Vulcan page) inside a module.
// - Input: the model object — the first object of a variable (an object set / array / string of primary keys, with the
//   CAD object type chosen) or a fixed CAD object; part coloring from a variable (a list of structs
//   { partInstanceIds, color, opacity }, Vulcan's part coloring return schema).
// - Interaction: the selected part (a string variable, both ways: setting it elsewhere selects the part) and the
//   clicked point as Click X / Y / Z number variables; events on selection change.
// - Output: a measurement saved or chosen in the side panel as Measurement scene distance (number) and Measurement unit
//   distance (a string such as "12.30 mm").
// - Styling (fallback and background colors, the mesh style shown first), Interface (toolbar, sidebar, sidebar
//   expanded) and Tools (annotation, measurement, section, mesh styling, part coloring; all on by default).
// Annotations, measurements and section planes are saved through the Vulcan actions as on the Vulcan page; saving is
// off while the module is edited and in read-only (kiosk) modules. A save bumps the module, so other widgets reload.

/** The first primary key a variable holds (a string, the first of a list, or a struct's primary_key / id). */
function firstKey(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (Array.isArray(v)) return v.length ? firstKey(v[0]) : undefined;
  if (typeof v === "object") {
    const o = v as { primary_key?: unknown; pk?: unknown; id?: unknown };
    const k = o.primary_key ?? o.pk ?? o.id;
    return k === undefined || k === null || k === "" ? undefined : String(k);
  }
  return String(v);
}

/** Part coloring (a list of { partInstanceIds, color, opacity, selectedOpacity }) as a color / opacity per part. */
export function partStylesOf(v: unknown): PartStyles {
  const out: PartStyles = {};
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const e = x as { partInstanceIds?: unknown; part_instance_ids?: unknown; color?: unknown; opacity?: unknown };
    const raw = e.partInstanceIds ?? e.part_instance_ids;
    const ids = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw ? [raw] : [];
    const color = typeof e.color === "string" && e.color ? e.color : undefined;
    const op = typeof e.opacity === "number" ? e.opacity : typeof e.opacity === "string" && e.opacity !== "" ? Number(e.opacity) : undefined;
    const opacity = op !== undefined && Number.isFinite(op) ? Math.max(0, Math.min(1, op)) : undefined;
    // at least one of color or opacity, as Vulcan asks
    if (!ids.length || (color === undefined && opacity === undefined)) continue;
    for (const id of ids) out[id] = { ...out[id], ...(color !== undefined ? { color } : {}), ...(opacity !== undefined ? { opacity } : {}) };
  }
  return out;
}

/** The CAD objects and the Vulcan schema (the CAD object types). */
function useCad() {
  const [rows, setRows] = useState<CadRow[] | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([vulcanApi<CadRow[]>("/cad-objects"), vulcanApi<Schema>("/schema")]).then(
      ([r, s]) => (setRows(r), setSchema(s)),
      (e: Error) => setError(e.message),
    );
  }, []);
  return { rows, schema, error };
}

const Empty = ({ children, bad }: { children: React.ReactNode; bad?: boolean }) => <div className={`flex h-full items-center justify-center p-4 text-center text-xs ${bad ? "text-bad" : "text-muted"}`}>{children}</div>;

export function VulcanWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { rows, error } = useCad();
  const fromVar = c.vc_model_variable ? firstKey(state.variables[c.vc_model_variable]) : undefined;
  const pk = c.vc_model_variable ? fromVar : c.vc_primary_key;
  const type = c.vc_object_type_id;
  // the CAD object: found among the CAD objects (any CAD type when the widget names none)
  const row = useMemo<CadRow | null>(() => {
    if (!pk) return null;
    const found = rows?.find((r) => r.primary_key === pk && (!type || r.object_type_id === type));
    if (found) return found;
    return type ? { object_type_id: type, object_type: "", primary_key: pk, title: pk } : null;
  }, [rows, pk, type]);
  const coloring = c.vc_part_coloring_variable ? state.variables[c.vc_part_coloring_variable] : undefined;
  const partStyles = useMemo(() => partStylesOf(coloring), [coloring]);
  const selVar = c.vc_selected_part_variable;
  const selected = selVar ? ((v) => (v === null || v === undefined || v === "" ? null : String(v)))(state.variables[selVar]) : undefined;
  const [sidebarOpen, setSidebarOpen] = useState(c.vc_sidebar_expanded !== false);
  const unitVar = c.vc_measure_unit_variable;
  const distVar = c.vc_measure_distance_variable;

  const vc = useVulcanScene(row, {
    tools: { annotate: c.vc_annotation_tool !== false, measure: c.vc_measure_tool !== false, section: c.vc_section_tool !== false, styling: c.vc_styling_tool !== false, coloring: c.vc_coloring_tool !== false },
    defaultStyle: c.vc_style,
    background: c.vc_background || undefined,
    fallbackColor: c.vc_fallback_color || undefined,
    partStyles,
    selectedPart: selected,
    highlightSelection: true,
    onSelect: (part: string | null, point: Point3 | null) => {
      if (selVar) state.setVariable(selVar, part ?? "");
      const xyz = [c.vc_click_x_variable, c.vc_click_y_variable, c.vc_click_z_variable];
      xyz.forEach((name, i) => name && state.setVariable(name, point ? point[i] : null));
      void state.runEvents?.(c.vc_events ?? []);
    },
    onMeasurement:
      distVar || unitVar
        ? (d: number, formatted: string) => {
            if (distVar) state.setVariable(distVar, Number(d.toFixed(6)));
            if (unitVar) state.setVariable(unitVar, formatted);
          }
        : undefined,
    saveBlocked: editing ? "Saving is off while the module is edited" : state.readOnly ? "Read-only: this module does not write" : undefined,
    onSaved: state.bump,
    reloadKey: state.version,
    emptyText: c.vc_model_variable ? "The model variable holds no CAD object" : "Choose the CAD object this widget shows",
  });

  if (!c.vc_model_variable && !c.vc_primary_key) return <Empty>Choose the CAD object (or an object set variable holding it) this widget shows</Empty>;
  if (error) return <Empty bad>{error}</Empty>;
  if (pk && !row) return rows ? <Empty bad>{pk} is not a CAD object{type ? "" : " — choose the CAD object type"}</Empty> : <Empty>Loading…</Empty>;
  const showToolbar = c.vc_show_toolbar !== false;
  const showSidebar = c.vc_show_sidebar !== false && !!vc.scene;
  return (
    <div className="flex h-full min-h-0 flex-col" data-vc-widget={row?.primary_key ?? ""}>
      {showToolbar && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1 text-xs">
          <Icon name="cube" className="h-3.5 w-3.5 text-ocean" />
          <span className="min-w-0 flex-1 truncate font-medium">{vc.scene?.object.title ?? row?.title ?? ""}</span>
          {vc.toolbar}
          {c.vc_show_sidebar !== false && vc.scene && (
            <button type="button" onClick={() => setSidebarOpen(!sidebarOpen)} className="rounded border border-line-2 px-1.5 py-0.5 text-muted hover:text-white" title={sidebarOpen ? "Hide the side panel" : "Show the side panel"} data-vc-sidebar-toggle>
              <Icon name="list" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-ink" style={c.vc_background ? { background: c.vc_background } : undefined}>
          {vc.viewport}
        </div>
        {showSidebar && sidebarOpen && <aside className="w-64 shrink-0 space-y-3 overflow-y-auto border-l border-line bg-panel p-2 text-xs">{vc.sidebar}</aside>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

const KEY_TYPES: Variable["type"][] = ["object_set", "array", "string", "object", "struct"];

export function VulcanWidgetConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const on = widget.type === "vulcan_viewer";
  const vars = mod.variables ?? [];
  const [cad, setCad] = useState<{ rows: CadRow[]; schema: Schema } | null>(null);
  useEffect(() => {
    if (on) Promise.all([vulcanApi<CadRow[]>("/cad-objects"), vulcanApi<Schema>("/schema")]).then(([rows, schema]) => setCad({ rows, schema }), () => setCad({ rows: [], schema: { cad_types: [], problems: [] } }));
  }, [on]);
  if (!on) return null;
  const varSel = (value: string | undefined, onChange: (v: string | undefined) => void, kinds: Variable["type"][], none = "None") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{none}</option>
      {vars.filter((v) => kinds.includes(v.type)).map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type.replace(/_/g, " ")})</option>)}
    </select>
  );
  const types = cad?.schema.cad_types ?? [];
  const objects = (cad?.rows ?? []).filter((r) => !c.vc_object_type_id || r.object_type_id === c.vc_object_type_id);
  const color = (label: string, value: string | undefined, onChange: (v: string | undefined) => void, placeholder: string) => (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value ?? "") ? value : placeholder} onChange={(e) => onChange(e.target.value)} />
        <input value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} placeholder={`Default (${placeholder})`} className={inputClass} />
      </div>
    </Field>
  );
  const toggle = (label: string, value: boolean | undefined, onChange: (v: boolean | undefined) => void) => (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={value !== false} onChange={(e) => onChange(e.target.checked ? undefined : false)} /> {label}
    </label>
  );
  return (
    <div className="space-y-3 text-xs" data-vulcan-config>
      <div className="font-semibold uppercase tracking-wide text-muted">Input</div>
      <Field label="CAD object type" hint="An object type with a media property of the vulcan:cad_media_reference type class (made in Vulcan).">
        <select value={c.vc_object_type_id ?? ""} onChange={(e) => set({ vc_object_type_id: e.target.value || undefined, vc_primary_key: undefined })} className={inputClass} data-vc-type>
          <option value="">Any CAD object type</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
        </select>
      </Field>
      <Field label="Model objects (an object set variable)" hint="Vulcan loads the first object in the set. None: the fixed CAD object below.">
        {varSel(c.vc_model_variable, (v) => set({ vc_model_variable: v }), KEY_TYPES, "A fixed CAD object")}
      </Field>
      {!c.vc_model_variable && (
        <Field label="CAD object">
          <select value={c.vc_primary_key ?? ""} onChange={(e) => {
              const r = objects.find((x) => x.primary_key === e.target.value);
              set({ vc_primary_key: e.target.value || undefined, ...(r && !c.vc_object_type_id ? { vc_object_type_id: r.object_type_id } : {}) });
            }} className={inputClass} data-vc-object>
            <option value="">Choose…</option>
            {objects.map((r) => <option key={r.object_type_id + r.primary_key} value={r.primary_key}>{r.title}{c.vc_object_type_id ? "" : ` · ${r.object_type}`}</option>)}
            {c.vc_primary_key && cad && !objects.some((r) => r.primary_key === c.vc_primary_key) && <option value={c.vc_primary_key}>{c.vc_primary_key} (not found)</option>}
          </select>
        </Field>
      )}
      <Field label="Part coloring (a list of structs)" hint="{ partInstanceIds: [...], color: '#0055ff', opacity: 0.5 } per entry, e.g. a function's output; parts are mesh names, DXF layers or LAS classes. A color picked in the side panel wins.">
        {varSel(c.vc_part_coloring_variable, (v) => set({ vc_part_coloring_variable: v }), ["struct_array", "array", "struct", "object"])}
      </Field>
      <div className="font-semibold uppercase tracking-wide text-muted">Interaction</div>
      <Field label="Selected part (a string variable, both ways)" hint="The picked part, layer or class; setting it elsewhere selects it.">
        {varSel(c.vc_selected_part_variable, (v) => set({ vc_selected_part_variable: v }), ["string"])}
      </Field>
      <div className="grid grid-cols-3 gap-1">
        {(["x", "y", "z"] as const).map((k) => {
          const f = `vc_click_${k}_variable` as const;
          return (
            <Field key={k} label={`Click ${k.toUpperCase()}`}>
              {varSel(c[f], (v) => set({ [f]: v }), ["number"])}
            </Field>
          );
        })}
      </div>
      <EventsEditor events={c.vc_events ?? []} mod={mod} onChange={(ev) => set({ vc_events: ev.length ? ev : undefined })} label="On selection change" />
      <div className="font-semibold uppercase tracking-wide text-muted">Output</div>
      <Field label="Measurement scene distance (a number variable)" hint="A measurement saved, or chosen in the side panel's list, in the model's scene units.">
        {varSel(c.vc_measure_distance_variable, (v) => set({ vc_measure_distance_variable: v }), ["number"])}
      </Field>
      <Field label="Measurement unit distance (a string variable)" hint={'The same distance with the model\'s unit, such as "12.30 mm" ("units" when the model has none).'}>
        {varSel(c.vc_measure_unit_variable, (v) => set({ vc_measure_unit_variable: v }), ["string"])}
      </Field>
      <div className="font-semibold uppercase tracking-wide text-muted">Styling</div>
      {color("Fallback color", c.vc_fallback_color, (v) => set({ vc_fallback_color: v }), "#9ca3af")}
      {color("Background color", c.vc_background, (v) => set({ vc_background: v }), "#0b1220")}
      <Field label="Mesh style shown first">
        <select value={c.vc_style ?? "normal"} onChange={(e) => set({ vc_style: e.target.value === "normal" ? undefined : (e.target.value as Style) })} className={inputClass}>
          <option value="normal">Normal</option>
          <option value="xray">X-Ray</option>
          <option value="wireframe">Wireframe</option>
        </select>
      </Field>
      <div className="font-semibold uppercase tracking-wide text-muted">Interface</div>
      {toggle("Show toolbar", c.vc_show_toolbar, (v) => set({ vc_show_toolbar: v }))}
      {toggle("Show sidebar", c.vc_show_sidebar, (v) => set({ vc_show_sidebar: v }))}
      {c.vc_show_sidebar !== false && toggle("Expand sidebar by default", c.vc_sidebar_expanded, (v) => set({ vc_sidebar_expanded: v }))}
      <div className="font-semibold uppercase tracking-wide text-muted">Tools</div>
      {toggle("Enable annotation tool", c.vc_annotation_tool, (v) => set({ vc_annotation_tool: v }))}
      {toggle("Enable measurement tool", c.vc_measure_tool, (v) => set({ vc_measure_tool: v }))}
      {toggle("Enable section view tool", c.vc_section_tool, (v) => set({ vc_section_tool: v }))}
      {toggle("Enable mesh styling tool", c.vc_styling_tool, (v) => set({ vc_styling_tool: v }))}
      {toggle("Enable part coloring tool", c.vc_coloring_tool, (v) => set({ vc_coloring_tool: v }))}
      <p className="text-muted">Annotations, measurements and section planes are saved through the Vulcan actions of the CAD object type (set up in Vulcan). Not here: camera bindings, scene modes (grid / component), the transform tool.</p>
    </div>
  );
}
