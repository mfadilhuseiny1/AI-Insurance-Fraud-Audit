"use client";

import { useEffect, useState } from "react";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import type { ActionType } from "@/lib/ontology";
import { om, type LinkType } from "@/lib/ontologyModel";
import { workshop, type Column, type FormatRule, type Module, type SectionLayout, type Variable, type Widget, type WidgetConfig, type WsEvent } from "@/lib/workshop";
import { BackgroundField, PaddingField } from "./LayoutTools";
import { ValueFormatFields } from "./TsFormatting";

const EVENT_KINDS: [WsEvent["kind"], string][] = [
  ["set_variable", "Set a variable"],
  ["open_overlay", "Open an overlay"],
  ["close_overlay", "Close the overlay"],
  ["switch_tab", "Switch a tab"],
  ["go_page", "Go to a page"],
  ["open_module", "Open a module"],
  ["open_url", "Open a URL"],
  ["refresh", "Refresh the data"],
  ["reset_variable", "Reset a variable"],
  ["recompute_variable", "Recompute a variable"],
  ["llm_to_variable", "LLM response into a variable"],
  ["open_object", "Open an object"],
  ["section", "Expand / collapse / toggle a section"],
  ["auto_refresh", "Enable / disable auto-refresh updates"],
  ["send_command", "Send a command (an embedded page or the parent window)"],
  ["scenario", "Scenario event (create, save, apply, delete)"],
];

/** A list of events (what a click or a selection does), in order. */
export function EventsEditor({ events, onChange, mod, label = "On click" }: { events: WsEvent[]; onChange: (e: WsEvent[]) => void; mod: Module; label?: string }) {
  const tabsWidgets = mod.widgets.filter((w) => w.type === "tabs");
  const [modules, setModules] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    workshop.modules().then((m) => setModules(m.filter((x) => x.id !== mod.id).map((x) => ({ id: x.id, name: x.name }))), () => {});
  }, [mod.id]);
  const set = (i: number, e: WsEvent) => onChange(events.map((x, j) => (j === i ? e : x)));
  return (
    <div className="space-y-2" data-events>
      <div className="text-xs font-medium text-soft">{label}</div>
      {events.map((e, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-2">
          <div className="flex gap-1">
            <select value={e.kind} onChange={(x) => set(i, blank(x.target.value as WsEvent["kind"]))} className={`${fieldClass} flex-1 text-xs`}>
              {EVENT_KINDS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => onChange(events.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad" aria-label="Remove event">
              ✕
            </button>
          </div>
          {e.kind === "set_variable" && (
            <div className="flex gap-1">
              <VariableSelect value={e.variable} vars={mod.variables} onChange={(v) => set(i, { ...e, variable: v })} />
              <input value={String(e.value ?? "")} onChange={(x) => set(i, { ...e, value: x.target.value })} placeholder="value, {{var}} or $var:name" className={`${fieldClass} flex-1 text-xs`} />
            </div>
          )}
          {(e.kind === "reset_variable" || e.kind === "recompute_variable") && <VariableSelect value={e.variable} vars={mod.variables} onChange={(v) => set(i, { ...e, variable: v })} />}
          {e.kind === "llm_to_variable" && (
            <>
              <VariableSelect value={e.variable} vars={mod.variables?.filter((v) => v.type === "string")} onChange={(v) => set(i, { ...e, variable: v })} />
              <textarea value={e.prompt} onChange={(x) => set(i, { ...e, prompt: x.target.value })} rows={3} placeholder="Prompt with {{variables}}" className={`${inputClass} text-xs`} />
            </>
          )}
          {e.kind === "scenario" && (
            <div className="space-y-1">
              <div className="flex gap-1">
                <select value={e.op} onChange={(x) => set(i, { ...e, op: x.target.value as "create" })} className={`${fieldClass} text-xs`}>
                  <option value="create">Create</option>
                  <option value="save">Save</option>
                  <option value="duplicate">Duplicate</option>
                  <option value="apply">Apply to the Nexus</option>
                  <option value="delete">Delete</option>
                </select>
                <VariableSelect value={e.variable} vars={mod.variables?.filter((v) => v.type === "scenario")} onChange={(v) => set(i, { ...e, variable: v })} />
              </div>
              {e.op === "save" && (
                <input value={e.object_type_id ?? ""} onChange={(x) => set(i, { ...e, object_type_id: x.target.value || undefined })} placeholder="scenario object type id (type classes fill the parameters; optional)" className={`${fieldClass} w-full text-xs`} />
              )}
              {e.op === "save" && e.object_type_id && (
                <input value={e.update_action_type_id ?? ""} onChange={(x) => set(i, { ...e, update_action_type_id: x.target.value || undefined })} placeholder="update scenario object action (optional)" className={`${fieldClass} w-full text-xs`} />
              )}
              {(e.op === "create" || e.op === "delete" || e.op === "duplicate") && <VariableSelect value={e.list_variable ?? ""} vars={mod.variables?.filter((v) => v.type === "scenario_array")} onChange={(v) => set(i, { ...e, list_variable: v || undefined })} />}
              {(e.op === "apply" || e.op === "save") && (
                <input value={e.action_type_id ?? ""} onChange={(x) => set(i, { ...e, action_type_id: x.target.value || undefined })} placeholder={e.op === "apply" ? "action type with an Apply scenario rule" : "create scenario object action (optional)"} className={`${fieldClass} w-full text-xs`} />
              )}
              {e.op === "save" && e.action_type_id && !e.object_type_id && (
                <div className="flex gap-1">
                  <input value={e.id_param ?? ""} onChange={(x) => set(i, { ...e, id_param: x.target.value || undefined })} placeholder="scenario id parameter" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                  <input value={e.name_param ?? ""} onChange={(x) => set(i, { ...e, name_param: x.target.value || undefined })} placeholder="name parameter" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                </div>
              )}
            </div>
          )}
          {e.kind === "send_command" && (
            <div className="space-y-1">
              <select value={e.target} onChange={(x) => set(i, { ...e, target: x.target.value })} className={`${fieldClass} w-full text-xs`}>
                <option value="parent">The parent window</option>
                {mod.widgets.filter((w) => w.type === "iframe").map((w) => (
                  <option key={w.id} value={w.id}>
                    Iframe · {w.title || w.id}
                  </option>
                ))}
              </select>
              <div className="flex gap-1">
                <input value={e.command} onChange={(x) => set(i, { ...e, command: x.target.value })} placeholder="command" className={`${fieldClass} w-28 font-mono text-xs`} />
                <input value={String(e.payload ?? "")} onChange={(x) => set(i, { ...e, payload: x.target.value || undefined })} placeholder="payload ($var:name)" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
              </div>
            </div>
          )}
          {e.kind === "auto_refresh" && (
            <select value={String(e.enabled)} onChange={(x) => set(i, { ...e, enabled: x.target.value === "true" })} className={`${fieldClass} text-xs`}>
              <option value="true">Enable auto-refresh updates</option>
              <option value="false">Disable auto-refresh updates</option>
            </select>
          )}
          {e.kind === "section" && (
            <div className="flex gap-1">
              <select value={e.widget} onChange={(x) => set(i, { ...e, widget: x.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
                <option value="">Section…</option>
                {mod.widgets.filter((w) => w.config.collapsible).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title || w.id}
                  </option>
                ))}
              </select>
              <select value={e.action} onChange={(x) => set(i, { ...e, action: x.target.value as "toggle" })} className={`${fieldClass} text-xs`}>
                <option value="expand">Expand</option>
                <option value="collapse">Collapse</option>
                <option value="toggle">Toggle</option>
              </select>
            </div>
          )}
          {e.kind === "open_object" && (
            <div className="flex gap-1">
              <input value={e.object_type_id} onChange={(x) => set(i, { ...e, object_type_id: x.target.value })} placeholder="object type id" className={`${fieldClass} w-28 text-xs`} />
              <input value={e.primary_key} onChange={(x) => set(i, { ...e, primary_key: x.target.value })} placeholder="$var:name" className={`${fieldClass} flex-1 text-xs`} />
            </div>
          )}
          {e.kind === "open_overlay" && (
            <select value={e.overlay} onChange={(x) => set(i, { ...e, overlay: x.target.value })} className={`${inputClass} text-xs`}>
              <option value="">Choose an overlay…</option>
              {(mod.overlays ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          {e.kind === "switch_tab" && (
            <div className="flex gap-1">
              <select value={e.widget} onChange={(x) => set(i, { ...e, widget: x.target.value, tab: "" })} className={`${fieldClass} flex-1 text-xs`}>
                <option value="">Tabs widget…</option>
                {tabsWidgets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title || w.id}
                  </option>
                ))}
              </select>
              <select value={e.tab} onChange={(x) => set(i, { ...e, tab: x.target.value })} className={`${fieldClass} flex-1 text-xs`}>
                <option value="">Tab…</option>
                {(tabsWidgets.find((w) => w.id === e.widget)?.config.tabs ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {e.kind === "go_page" && (
            <select value={e.page} onChange={(x) => set(i, { ...e, page: x.target.value })} className={`${inputClass} text-xs`}>
              <option value="">Choose a page…</option>
              {(mod.pages ?? [{ id: "main", name: "Page 1" }]).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {e.kind === "open_module" && (
            <>
              <select value={e.module_id} onChange={(x) => set(i, { ...e, module_id: x.target.value })} className={`${inputClass} text-xs`}>
                <option value="">Choose a module…</option>
                {modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ParamsEditor params={e.params ?? {}} onChange={(p) => set(i, { ...e, params: p })} />
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={!!e.new_tab} onChange={(x) => set(i, { ...e, new_tab: x.target.checked })} /> in a new tab
              </label>
            </>
          )}
          {e.kind === "open_url" && (
            <>
              <input value={e.url} onChange={(x) => set(i, { ...e, url: x.target.value })} placeholder="https://… or /path?x={{var}}" className={`${inputClass} text-xs`} />
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={!!e.new_tab} onChange={(x) => set(i, { ...e, new_tab: x.target.checked })} /> in a new tab
              </label>
            </>
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...events, blank("set_variable")])} className="text-xs text-ocean">
        + Event
      </button>
    </div>
  );
}

function blank(kind: WsEvent["kind"]): WsEvent {
  switch (kind) {
    case "set_variable":
      return { kind, variable: "", value: "" };
    case "open_overlay":
      return { kind, overlay: "" };
    case "switch_tab":
      return { kind, widget: "", tab: "" };
    case "go_page":
      return { kind, page: "" };
    case "open_module":
      return { kind, module_id: "", params: {} };
    case "open_url":
      return { kind, url: "", new_tab: true };
    case "apply_action":
      return { kind, action_type_id: "" };
    case "reset_variable":
    case "recompute_variable":
      return { kind, variable: "" };
    case "llm_to_variable":
      return { kind, variable: "", prompt: "" };
    case "open_object":
      return { kind, object_type_id: "", primary_key: "" };
    case "section":
      return { kind, widget: "", action: "toggle" };
    case "auto_refresh":
      return { kind, enabled: false };
    case "send_command":
      return { kind, target: "parent", command: "" };
    case "scenario":
      return { kind, op: "create", variable: "" };
    default:
      return { kind } as WsEvent;
  }
}

function ParamsEditor({ params, onChange }: { params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const rows = Object.entries(params);
  return (
    <div className="space-y-1">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1">
          <input value={k} onChange={(e) => onChange(Object.fromEntries(rows.map(([a, b], j) => (j === i ? [e.target.value, b] : [a, b]))))} placeholder="its variable" className={`${fieldClass} w-28 text-xs`} />
          <input value={String(v ?? "")} onChange={(e) => onChange({ ...params, [k]: e.target.value })} placeholder="value, {{var}} or $var:name" className={`${fieldClass} flex-1 text-xs`} />
          <button type="button" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))} className="px-1 text-muted hover:text-bad">
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange({ ...params, [`var${rows.length + 1}`]: "" })} className="text-xs text-ocean">
        + Variable value
      </button>
    </div>
  );
}

function VariableSelect({ value, vars, onChange }: { value?: string; vars?: Variable[]; onChange: (v: string) => void }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
      <option value="">Variable…</option>
      {(vars ?? []).map((v) => (
        <option key={v.name} value={v.name}>
          {v.name} · {v.type}
        </option>
      ))}
    </select>
  );
}

/** The panel sections of the layout, input, display and embedding widgets. */
export function NewWidgetConfig({ widget, set, mod, cols }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[]; actions: ActionType[] }) {
  const c = widget.config;
  const t = widget.type;
  const [links, setLinks] = useState<LinkType[]>([]);
  const [modules, setModules] = useState<{ id: string; name: string }[]>([]);
  const tid = c.source?.kind === "object_type" ? c.source.id : undefined;
  useEffect(() => {
    if (t !== "linked_objects" || !tid) return;
    om.linkTypes({ object_type_id: tid }).then(setLinks, () => {});
  }, [t, tid]);
  useEffect(() => {
    if (t !== "embedded_module" && t !== "loop") return;
    workshop.modules().then((m) => setModules(m.filter((x) => x.id !== mod.id).map((x) => ({ id: x.id, name: x.name }))), () => {});
  }, [t, mod.id]);
  const colPick = (value: string | undefined, onPick: (v: string | undefined) => void, empty = "Choose a column…") => (
    <select value={value ?? ""} onChange={(e) => onPick(e.target.value || undefined)} className={inputClass}>
      <option value="">{empty}</option>
      {cols.map((col) => (
        <option key={col.name} value={col.name}>
          {col.name}
        </option>
      ))}
    </select>
  );
  const variableField = (types?: Variable["type"][]) => (
    <Field label="Writes the variable" hint={mod.variables?.length ? undefined : "Add variables in the left panel (Variables)"}>
      <select value={c.variable ?? ""} onChange={(e) => set({ variable: e.target.value || undefined })} className={inputClass}>
        <option value="">Choose a variable…</option>
        {(mod.variables ?? []).filter((v) => !types || types.includes(v.type)).map((v) => (
          <option key={v.name} value={v.name}>
            {v.name} · {v.type}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="space-y-4">
      {t === "tabs" && (
        <Field label="Variable-backed tab selection (a string variable holding a tab ID; both ways)">
          <select value={c.tab_variable ?? ""} onChange={(e) => set({ tab_variable: e.target.value || undefined })} className={inputClass}>
            <option value="">None</option>
            {(mod.variables ?? []).filter((v) => v.type === "string").map((v) => (
              <option key={v.name}>{v.name}</option>
            ))}
          </select>
        </Field>
      )}
      {t === "tabs" && (
        <Field label="Tabs" hint="Select a tab, then drop widgets into it">
          <div className="space-y-1">
            {(c.tabs ?? [{ id: "t1", name: "Tab 1" }]).map((tab, i, all) => (
              <div key={tab.id} className="flex gap-1">
                <span className="w-12 truncate pt-1.5 font-mono text-[10px] text-muted" title="Tab ID">{tab.id}</span>
                <input value={tab.name} onChange={(e) => set({ tabs: all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className={`${fieldClass} flex-1 text-xs`} />
                {all.length > 1 && (
                  <button type="button" onClick={() => set({ tabs: all.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad" title="Remove the tab (its widgets stay in the module, hidden)">
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => set({ tabs: [...(c.tabs ?? [{ id: "t1", name: "Tab 1" }]), { id: `t${Date.now().toString(36)}`, name: `Tab ${(c.tabs?.length ?? 1) + 1}` }] })} className="text-xs text-ocean">
              + Tab
            </button>
          </div>
        </Field>
      )}
      {t === "button_group" && (
        <div className="space-y-3">
          {(c.buttons ?? []).map((b, i, all) => (
            <div key={i} className="space-y-2 rounded-lg border border-line p-2">
              <div className="flex gap-1">
                <input value={b.label} onChange={(e) => set({ buttons: all.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="Label ({{var}} allowed)" className={`${fieldClass} flex-1 text-xs`} />
                <select value={b.style ?? "primary"} onChange={(e) => set({ buttons: all.map((x, j) => (j === i ? { ...x, style: e.target.value as "primary" } : x)) })} className={`${fieldClass} text-xs`}>
                  <option value="primary">Primary</option>
                  <option value="secondary">Secondary</option>
                </select>
                <button type="button" onClick={() => set({ buttons: all.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
              <EventsEditor events={b.events} mod={mod} onChange={(ev) => set({ buttons: all.map((x, j) => (j === i ? { ...x, events: ev } : x)) })} />
            </div>
          ))}
          <button type="button" onClick={() => set({ buttons: [...(c.buttons ?? []), { label: `Button ${(c.buttons?.length ?? 0) + 1}`, events: [] }] })} className="text-xs text-ocean">
            + Button
          </button>
        </div>
      )}
      {(t === "text_input" || t === "number_input" || t === "date_picker" || t === "toggle") && (
        <>
          {variableField(t === "number_input" ? ["number"] : t === "toggle" ? ["boolean"] : t === "date_picker" ? ["date", "string"] : ["string"])}
          <Field label={t === "toggle" ? "Label" : "Placeholder"}>
            <input value={(t === "toggle" ? c.label : c.placeholder) ?? ""} onChange={(e) => set(t === "toggle" ? { label: e.target.value } : { placeholder: e.target.value })} className={inputClass} />
          </Field>
        </>
      )}
      {t === "string_selector" && (
        <>
          {variableField(["string", "array"])}
          <Field label="Options from a column of the source (else the fixed options)">{colPick(c.options_column, (v) => set({ options_column: v }), "Fixed options")}</Field>
          {!c.options_column && (
            <Field label="Fixed options (comma-separated)">
              <input value={(c.options ?? []).join(", ")} onChange={(e) => set({ options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={inputClass} />
            </Field>
          )}
          <label className="flex items-center gap-2 text-xs text-soft">
            <input type="checkbox" checked={!!c.multiple} onChange={(e) => set({ multiple: e.target.checked })} /> Several values (an array variable)
          </label>
        </>
      )}
      {t === "object_dropdown" && (
        <Field label="Also write the primary key to (optional)">
          <select value={c.variable ?? ""} onChange={(e) => set({ variable: e.target.value || undefined })} className={inputClass}>
            <option value="">Only select it</option>
            {(mod.variables ?? []).map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {t === "user_select" && variableField(["string"])}
      {(t === "object_list" || t === "property_list" || (t === "table" && (c.source?.kind === "object_type" || c.source?.kind === "interface"))) && (
        <Field label="Show security markings">
          <select value={c.security_markings ?? ""} onChange={(e) => set({ security_markings: (e.target.value || undefined) as typeof c.security_markings })} className={inputClass}>
            <option value="">Off</option>
            {t !== "table" && <option value="responsive">Responsive</option>}
            <option value="full">Full tag</option>
            <option value="icon">Icon only</option>
          </select>
        </Field>
      )}
      {t === "object_list" && (
        <>
          <Field label="Title property">{colPick(c.columns?.[0], (v) => set({ columns: v ? [v] : [] }))}</Field>
          <Field label="Subtitle property">{colPick(c.subtitle_property, (v) => set({ subtitle_property: v }), "None")}</Field>
        </>
      )}
      {t === "property_list" && (
        <Field label="Properties (empty: all)">
          <select multiple value={c.properties ?? []} onChange={(e) => set({ properties: [...e.target.selectedOptions].map((o) => o.value) })} className={`${inputClass} h-28`}>
            {cols.map((col) => (
              <option key={col.name} value={col.name}>
                {col.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {t === "linked_objects" && (
        <Field label="Link type (empty: all)">
          <select value={c.link_type_id ?? ""} onChange={(e) => set({ link_type_id: e.target.value || undefined })} className={inputClass}>
            <option value="">All links</option>
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {l.display_name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {t === "pivot" && (
        <>
          <Field label="Rows">{colPick(c.pivot_rows, (v) => set({ pivot_rows: v }))}</Field>
          <Field label="Columns">{colPick(c.pivot_columns, (v) => set({ pivot_columns: v }))}</Field>
          <Field label="Measure">
            <div className="flex gap-1">
              <select value={c.metric ?? "count"} onChange={(e) => set({ metric: e.target.value as WidgetConfig["metric"] })} className={`${fieldClass} text-xs`}>
                {["count", "sum", "avg", "min", "max", "distinct"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              {c.metric && c.metric !== "count" && colPick(c.metric_column, (v) => set({ metric_column: v }))}
            </div>
          </Field>
        </>
      )}
      {t === "embedded_module" && (
        <>
          <Field label="Module" hint="Its published version runs inside this one">
            <select value={c.module_id ?? ""} onChange={(e) => set({ module_id: e.target.value || undefined })} className={inputClass}>
              <option value="">Choose a module…</option>
              {modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Its variables (module interface)">
            <ParamsEditor params={c.module_params ?? {}} onChange={(p) => set({ module_params: p })} />
          </Field>
        </>
      )}
      {t === "loop" && (
        <>
          <Field label="Loop over">
            <select value={c.loop_mode ?? "array"} onChange={(e) => set({ loop_mode: e.target.value as "array" | "objects" })} className={inputClass}>
              <option value="array">An array variable</option>
              <option value="objects">The objects of the data source (with its filters)</option>
            </select>
          </Field>
          {(c.loop_mode ?? "array") === "array" && (
            <Field label="Array to loop through">
              <select value={c.loop_variable ?? ""} onChange={(e) => set({ loop_variable: e.target.value || undefined })} className={inputClass}>
                <option value="">Choose…</option>
                {(mod.variables ?? []).filter((v) => v.type === "array" || v.type === "struct_array").map((v) => (
                  <option key={v.name}>{v.name}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Module for each entry" hint="Its published version">
            <select value={c.module_id ?? ""} onChange={(e) => set({ module_id: e.target.value || undefined })} className={inputClass}>
              <option value="">Choose a module…</option>
              {modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Its variable that receives the entry (object: the primary key)">
            <input value={c.loop_interface ?? ""} onChange={(e) => set({ loop_interface: e.target.value || undefined })} placeholder="variable name or external ID" className={inputClass} />
          </Field>
          <Field label="Other variables of the module (shared by every entry)">
            <ParamsEditor params={c.module_params ?? {}} onChange={(p) => set({ module_params: p })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Paging">
              <select value={c.paging ?? "limit"} onChange={(e) => set({ paging: e.target.value as "limit" | "paged" })} className={inputClass}>
                <option value="limit">Limit</option>
                <option value="paged">Paged</option>
              </select>
            </Field>
            <Field label={c.paging === "paged" ? "Items per page" : "Max items"}>
              <input type="number" min={1} value={c.per_page ?? 10} onChange={(e) => set({ per_page: Number(e.target.value) || 10 })} className={inputClass} />
            </Field>
            <Field label="Display">
              <select value={c.display ?? "list"} onChange={(e) => set({ display: e.target.value as "list" | "grid" })} className={inputClass}>
                <option value="list">List</option>
                <option value="grid">Grid</option>
              </select>
            </Field>
            {c.display === "grid" && (
              <Field label="Columns">
                <input type="number" min={1} max={8} value={c.grid_columns ?? 3} onChange={(e) => set({ grid_columns: Number(e.target.value) || 3 })} className={inputClass} />
              </Field>
            )}
          </div>
        </>
      )}
      {t === "iframe" && (
        <Field label="URL" hint="{{variables}} are filled in">
          <input value={c.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="/slate/… or https://…" className={inputClass} />
        </Field>
      )}
    </div>
  );
}

/** The types that need no data source. */
export const NO_SOURCE = new Set(["qr_reader", "tabs", "section", "stepper", "scenario_manager", "scenario_selector", "scenario_summary", "observability", "media_uploader", "resource_list", "inline_action", "aip_chatbot", "aip_content", "button_group", "text_input", "number_input", "date_picker", "toggle", "user_select", "embedded_module", "iframe", "notepad_linked", "notepad_embed", "notepad_new", "notepad_export", "vertex_graph", "machinery", "scheduling_gantt", "scheduling_calendar", "program_scheduling", "rule_editor", "proposal_reviewer", "vulcan_viewer", "form_embed"]);

/** Settings every widget has: conditional visibility; tables and metric cards also value and conditional formatting. */
export function CommonWidgetConfig({ widget, set, mod, cols }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[] }) {
  const c = widget.config;
  const formatted = widget.type === "table" || widget.type === "metric" || widget.type === "gantt" || widget.type === "timeline";
  const keys = widget.type === "metric" ? [""] : (c.columns?.length ? c.columns : cols.map((x) => x.name)).slice(0, 30);
  const rules = c.rules ?? [];
  return (
    <div className="space-y-3">
      {widget.type === "section" && (
        <Field label="Section layout">
          <select value={c.section_layout ?? "grid"} onChange={(e) => set({ section_layout: e.target.value as SectionLayout })} className={inputClass} data-section-layout>
            <option value="grid">Grid (place and size freely)</option>
            <option value="rows">Rows (split horizontally, fill the height)</option>
            <option value="columns">Columns (split vertically by width)</option>
            <option value="toolbar">Toolbar (a row of small widgets)</option>
            <option value="flow">Flow (a vertically scrolling list)</option>
          </select>
        </Field>
      )}
      <div className="flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!c.collapsible} onChange={(e) => set({ collapsible: e.target.checked || undefined })} /> Collapsible
        </label>
        {c.collapsible && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!c.collapsed} onChange={(e) => set({ collapsed: e.target.checked || undefined })} /> Collapsed by default
          </label>
        )}
      </div>
      <details className="rounded border border-line p-2 text-xs" data-style>
        <summary className="cursor-pointer text-soft">Style</summary>
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted">Header</span>
            <select value={c.header_style ?? "block"} onChange={(e) => set({ header_style: e.target.value as "block" })} className={`${fieldClass} flex-1 text-xs`}>
              <option value="block">Block</option>
              <option value="contained">Contained</option>
              <option value="floating">Floating</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted">Border</span>
            <select value={c.border ?? "bordered"} onChange={(e) => set({ border: e.target.value as "bordered" })} className={`${fieldClass} flex-1 text-xs`}>
              <option value="bordered">Bordered</option>
              <option value="shadow">Outer drop shadow</option>
              <option value="inner">Inner shadow</option>
              <option value="none">Borderless</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 text-muted">Background</span>
            <BackgroundField value={c.background} onChange={(b) => set({ background: b })} saved={mod.settings?.colors} />
          </div>
          {widget.type === "section" && (
            <div className="flex items-center gap-2">
              <span className="w-16 text-muted">Padding</span>
              <div className="flex-1">
                <PaddingField value={c.padding} onChange={(p) => set({ padding: p })} />
              </div>
            </div>
          )}
        </div>
      </details>
      {widget.config.source && (mod.variables ?? []).some((v) => v.type === "object_set_filter" || v.type === "object_set") && (
        <Field label="Object set (filter) variables applied">
          <div className="flex flex-wrap gap-1" data-filter-vars>
            {(mod.variables ?? [])
              .filter((v) => v.type === "object_set_filter" || v.type === "object_set")
              .map((v) => {
                const on = (c.filter_variables ?? []).includes(v.name);
                return (
                  <button key={v.name} type="button" onClick={() => set({ filter_variables: on ? (c.filter_variables ?? []).filter((x) => x !== v.name) : [...(c.filter_variables ?? []), v.name] })} className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
                    {v.name}
                  </button>
                );
              })}
          </div>
        </Field>
      )}
      <Field label="Conditional visibility: hide if">
        <div className="flex gap-1">
          <select value={c.hide_if?.variable ?? ""} onChange={(e) => set({ hide_if: e.target.value ? { variable: e.target.value, when: c.hide_if?.when ?? true } : undefined })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
            <option value="">Always shown</option>
            {(mod.variables ?? []).filter((v) => v.type === "boolean").map((v) => (
              <option key={v.name}>{v.name}</option>
            ))}
          </select>
          {c.hide_if && (
            <select value={String(c.hide_if.when ?? true)} onChange={(e) => set({ hide_if: { ...c.hide_if!, when: e.target.value === "true" } })} className={`${fieldClass} text-xs`}>
              <option value="true">is true</option>
              <option value="false">is false</option>
            </select>
          )}
        </div>
      </Field>
      {formatted && (
        <details className="rounded border border-line p-2 text-xs" data-formatting>
          <summary className="cursor-pointer text-soft">Formatting</summary>
          <div className="mt-2 space-y-2">
            <div className="text-muted">Value formatting</div>
            {keys.map((k) => {
              const f = c.formats?.[k] ?? {};
              const setF = (x: Partial<typeof f>) => set({ formats: { ...c.formats, [k]: { ...f, ...x } } });
              return (
                <details key={k || "value"} className="group" data-format-key={k || "value"}>
                <summary className="flex cursor-pointer list-none items-center gap-1">
                  <span className="w-20 truncate text-muted" title="Expand for fraction, integer and significant digits, grouping and notation">{k || "value"} ▸</span>
                  <input type="number" min={0} max={8} value={f.decimals ?? ""} onChange={(e) => setF({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="dec." className={`${fieldClass} w-12 text-[11px]`} />
                  <input value={f.prefix ?? ""} onChange={(e) => setF({ prefix: e.target.value || undefined })} placeholder="prefix" className={`${fieldClass} w-14 text-[11px]`} />
                  <input value={f.suffix ?? ""} onChange={(e) => setF({ suffix: e.target.value || undefined })} placeholder="suffix" className={`${fieldClass} w-14 text-[11px]`} />
                  <select value={f.notation ?? "standard"} onChange={(e) => setF({ notation: e.target.value as "standard" })} className={`${fieldClass} text-[11px]`}>
                    <option value="standard">123</option>
                    <option value="compact">1.2K</option>
                    <option value="percent">%</option>
                    <option value="scientific">1.2E3</option>
                    <option value="engineering">1.2E3 (eng.)</option>
                  </select>
                </summary>
                <div className="mt-1 pl-2">
                  <ValueFormatFields f={f} set={setF} />
                </div>
                </details>
              );
            })}
            <div className="text-muted">Conditional formatting (the first matching rule wins)</div>
            {rules.map((r, i) => {
              const setR = (x: Partial<FormatRule>) => set({ rules: rules.map((y, j) => (j === i ? { ...y, ...x } : y)) });
              return (
                <div key={i} className="flex items-center gap-1">
                  {widget.type === "table" && (
                    <select value={r.column ?? ""} onChange={(e) => setR({ column: e.target.value || undefined })} className={`${fieldClass} w-20 text-[11px]`}>
                      <option value="">any</option>
                      {keys.map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  )}
                  <select value={r.op} onChange={(e) => setR({ op: e.target.value as FormatRule["op"] })} className={`${fieldClass} text-[11px]`}>
                    {["gt", "gte", "lt", "lte", "eq", "neq", "contains", "between"].map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                  <input value={String(r.value ?? "")} onChange={(e) => setR({ value: e.target.value })} className={`${fieldClass} w-16 text-[11px]`} />
                  {r.op === "between" && <input value={String(r.value2 ?? "")} onChange={(e) => setR({ value2: e.target.value })} placeholder="and" className={`${fieldClass} w-14 text-[11px]`} />}
                  <input type="color" value={r.color} onChange={(e) => setR({ color: e.target.value })} className="h-6 w-7 bg-transparent" />
                  <select value={r.target ?? "text"} onChange={(e) => setR({ target: e.target.value as "text" })} className={`${fieldClass} text-[11px]`}>
                    <option value="text">text</option>
                    <option value="background">fill</option>
                  </select>
                  <button type="button" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                    ✕
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={() => set({ rules: [...rules, { op: "gt", value: 0, color: "#ef4444", target: "text" }] })} className="text-ocean">
              + Rule
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
