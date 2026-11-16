"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import {
  KNOWN_TYPE_CLASSES,
  PROPERTY_TYPES,
  request,
  RENDER_HINTS,
  STRUCT_FIELD_TYPES,
  typeLabel,
  type CondRule,
  type Derived,
  type ActionType,
  type ObjectType,
  type Property,
  type PropertyType,
  type ValueFormatting,
} from "@/lib/ontology";
import { INTENT_COLORS, formatProperty } from "@/lib/ontologyFormat";
import { om, type LinkType, type SharedProperty, type ValueType } from "@/lib/ontologyModel";
import { alertDialog } from "@/lib/dialogs";
import { functions } from "@/lib/actions";

const NUMERIC = new Set(["integer", "long", "short", "byte", "double", "float", "decimal"]);
const TABS = ["General", "Formatting", "Interaction", "Source"] as const;
type Tab = (typeof TABS)[number];

export type EditorContext = {
  t: ObjectType;
  /** the object type's modify-capable action types (inline edits) */
  actions?: ActionType[];
  sharedProperties: SharedProperty[];
  valueTypes: ValueType[];
  linkTypes: LinkType[];
  objectTypes: ObjectType[];
  /** geotemporal series syncs (for geotemporal series reference properties) */
  geoSyncs?: { id: string; name: string; series: number }[];
};

/**
 * The property editor (Ontology Manager → Properties → a property): metadata, status with deprecation, visibility,
 * base type (arrays, struct fields with main fields, vector dimension), keys, required / edit-only / mandatory
 * control, shared property and value type, value formatting with a preview, conditional formatting rules, render
 * hints, type classes, reducers and a derived-from-linked-objects source.
 */
export function PropertyEditor({
  prop,
  saved,
  all,
  ctx,
  onChange,
  onClose,
}: {
  prop: Property;
  /** the property as saved (null when new): its API name is fixed once active */
  saved: Property | null;
  all: Property[];
  ctx: EditorContext;
  onChange: (p: Property) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("General");
  const set = (c: Partial<Property>) => onChange({ ...prop, ...c });
  const isPk = prop.api_name === ctx.t.primary_key;
  const shared = ctx.sharedProperties.find((s) => s.id === prop.shared_property_id) ?? null;
  const lockedApi = !!saved && (saved.status === "active" || ["active", "promoted"].includes(ctx.t.status));
  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Icon name="list" className="h-4 w-4 text-ocean" />
        <span className="min-w-0 flex-1 truncate font-semibold">{prop.display_name || "New property"}</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white" aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="flex gap-1 border-b border-line px-3 py-1.5 text-xs">
        {TABS.map((k) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`rounded-md px-2 py-1 ${tab === k ? "bg-ocean/15 text-white" : "text-muted hover:text-white"}`}>
            {k}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {tab === "General" && (
          <>
            {shared && (
              <p className="rounded-md border border-ocean/30 bg-ocean/10 px-3 py-2 text-xs text-soft">
                Uses the shared property <b>{shared.display_name}</b>: its base type, value type, formatting, render hints and visibility come from it.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Display name">
                <input value={prop.display_name} onChange={(e) => set({ display_name: e.target.value })} className={inputClass} />
              </Field>
              <Field label="API name" hint={lockedApi ? "Fixed: the property is active" : saved ? "Fixed once saved" : undefined}>
                <input value={prop.api_name} disabled={!!saved} onChange={(e) => set({ api_name: e.target.value })} className={`${inputClass} font-mono`} />
              </Field>
            </div>
            <Field label="Description">
              <textarea rows={2} value={prop.description ?? ""} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status">
                <select
                  value={prop.status ?? "experimental"}
                  onChange={(e) => set({ status: e.target.value as Property["status"], deprecation: e.target.value === "deprecated" ? (prop.deprecation ?? { reason: "" }) : undefined })}
                  className={inputClass}
                >
                  {["experimental", "active", "deprecated", "example"].map((s) => (
                    <option key={s} value={s}>
                      {s[0].toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Visibility" hint="Prominent first; hidden left out of applications">
                <select value={prop.visibility ?? "normal"} disabled={!!shared} onChange={(e) => set({ visibility: e.target.value as Property["visibility"] })} className={inputClass}>
                  <option value="prominent">Prominent</option>
                  <option value="normal">Normal</option>
                  <option value="hidden">Hidden</option>
                </select>
              </Field>
            </div>
            {prop.status === "deprecated" && (
              <div className="space-y-2 rounded-md border border-bad/30 p-3">
                <Field label="Why is it deprecated?">
                  <input value={prop.deprecation?.reason ?? ""} onChange={(e) => set({ deprecation: { ...prop.deprecation, reason: e.target.value } })} className={inputClass} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Deletion deadline">
                    <input type="date" value={prop.deprecation?.deadline ?? ""} onChange={(e) => set({ deprecation: { reason: prop.deprecation?.reason ?? "", ...prop.deprecation, deadline: e.target.value } })} className={inputClass} />
                  </Field>
                  <Field label="Replaced by">
                    <select value={prop.deprecation?.replaced_by ?? ""} onChange={(e) => set({ deprecation: { reason: prop.deprecation?.reason ?? "", ...prop.deprecation, replaced_by: e.target.value || null } })} className={inputClass}>
                      <option value="">—</option>
                      {all
                        .filter((x) => x.api_name !== prop.api_name)
                        .map((x) => (
                          <option key={x.api_name} value={x.api_name}>
                            {x.display_name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
              </div>
            )}
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Base type" hint={PROPERTY_TYPES.find((x) => x.id === prop.type)?.limited}>
                <select value={prop.type} disabled={isPk || !!shared} onChange={(e) => set({ type: e.target.value as PropertyType, struct_fields: e.target.value === "struct" ? (prop.struct_fields ?? [{ api_name: "value", type: "string", main: true }]) : undefined })} className={inputClass}>
                  {PROPERTY_TYPES.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.label}
                      {pt.limited ? " (limited support)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-1.5 pb-2 text-xs text-soft">
                <input type="checkbox" disabled={isPk || !!shared || ["string_array", "timeseries", "vector"].includes(prop.type)} checked={!!prop.array} onChange={(e) => set({ array: e.target.checked || undefined, reducers: e.target.checked ? prop.reducers : undefined, allow_empty_array: undefined })} />
                Array
              </label>
            </div>
            {prop.type === "geotemporal_series_reference" && (
              <Field label="Geotemporal series sync" hint="The sync whose series the values name (at most one such property per object type)">
                <select value={prop.sync_id ?? ""} onChange={(e) => set({ sync_id: e.target.value || null })} className={inputClass}>
                  <option value="">Choose a geotemporal series sync…</option>
                  {(ctx.geoSyncs ?? []).map((sy) => (
                    <option key={sy.id} value={sy.id}>
                      {sy.name} ({sy.series} series)
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {prop.type === "vector" && (
              <Field label="Dimension" hint="At most 2,048">
                <input type="number" min={1} max={2048} value={prop.vector_dimension ?? ""} onChange={(e) => set({ vector_dimension: e.target.value ? Number(e.target.value) : null })} className={inputClass} />
              </Field>
            )}
            {prop.type === "vector" && <VectorSettings prop={prop} all={all} set={set} />}
            {prop.type === "struct" && <StructFields prop={prop} onChange={set} disabled={!!shared} />}
            <div className="space-y-1.5 rounded-md border border-line-2 p-3">
              {isPk && <div className="text-xs text-ocean">Primary key{["active", "promoted"].includes(ctx.t.status) ? " (fixed: the object type is active)" : ""}</div>}
              {prop.api_name === ctx.t.title_property && <div className="text-xs text-sand">Title key</div>}
              {(
                [
                  ["required", "Required", "Every object must have a value (actions enforce it)"],
                  ["edit_only", "Edit-only", "Not backed by a dataset column: only edits write it, and re-imports keep it"],
                  ["mandatory_control", "Mandatory control", "A marking property: users need its markings to see the object"],
                ] as const
              ).map(([k, label, hint]) => (
                <label key={k} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={!!prop[k]}
                    disabled={(k === "mandatory_control" && prop.type !== "marking") || (k === "edit_only" && !!prop.derived)}
                    onChange={(e) => set({ [k]: e.target.checked || undefined, ...(k === "mandatory_control" && e.target.checked ? { required: true, visibility: prop.visibility ?? "hidden" } : {}) })}
                  />
                  <span>
                    <span className="block">{label}</span>
                    <span className="block text-xs text-muted">{hint}</span>
                  </span>
                </label>
              ))}
              {prop.type === "media" && (
                <div className="space-y-1 text-xs">
                  <span className="block">Media sources</span>
                  <input
                    defaultValue={(prop.media_sources ?? []).join(", ")}
                    onBlur={(e) => {
                      const sources = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
                      set({ media_sources: sources.length ? sources : undefined, upload_destination: sources.includes(prop.upload_destination ?? "") ? prop.upload_destination : sources[0] });
                    }}
                    placeholder="Media set ids, comma separated"
                    className={inputClass}
                  />
                  {(prop.media_sources ?? []).length > 1 && (
                    <select value={prop.upload_destination ?? ""} onChange={(e) => set({ upload_destination: e.target.value })} className={inputClass} aria-label="Upload destination">
                      {(prop.media_sources ?? []).map((m) => (
                        <option key={m} value={m}>
                          Upload destination: {m}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="block text-muted">Media items must come from these media sets; uploads through edits go to the upload destination.</span>
                </div>
              )}
              {prop.mandatory_control && (
                <div className="space-y-1 pl-6 text-xs">
                  <input
                    defaultValue={(prop.allowed_markings ?? []).join(", ")}
                    onBlur={(e) => set({ allowed_markings: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                    placeholder="Allowed markings (ids, comma separated)"
                    className={inputClass}
                  />
                  <input
                    defaultValue={(prop.allowed_organizations ?? []).join(", ")}
                    onBlur={(e) => set({ allowed_organizations: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                    placeholder="Allowed organizations (ids, comma separated)"
                    className={inputClass}
                  />
                  <span className="block text-muted">Values must be among these; a user needs every marking and one of the organizations. Mandatory controls are required and hidden by default.</span>
                </div>
              )}
              {prop.required && prop.array && (
                <label className="flex items-center gap-2 pl-6 text-xs text-soft">
                  <input type="checkbox" checked={!!prop.allow_empty_array} onChange={(e) => set({ allow_empty_array: e.target.checked || undefined })} /> Allow empty arrays
                </label>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Shared property" hint="Reuse the property's definition across object types">
                <select value={prop.shared_property_id ?? ""} onChange={(e) => attachShared(e.target.value)} className={inputClass}>
                  <option value="">None</option>
                  {ctx.sharedProperties.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name} ({typeLabel(s.type, s.array)})
                    </option>
                  ))}
                  {prop.shared_property_id && !shared && <option value={prop.shared_property_id}>New shared property</option>}
                </select>
                {!prop.shared_property_id && saved && !prop.derived && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const sp = await om.createSharedProperty({
                          api_name: prop.api_name,
                          display_name: prop.display_name,
                          description: prop.description,
                          type: prop.type,
                          array: prop.array,
                          struct_fields: prop.struct_fields,
                          value_type_id: prop.value_type_id ?? null,
                          value_formatting: prop.value_formatting ?? null,
                          render_hints: prop.render_hints,
                          type_classes: prop.type_classes,
                          visibility: prop.visibility,
                          ontology_id: ctx.t.ontology_id,
                        } as never);
                        set({ shared_property_id: sp.id });
                      } catch (e) {
                        void alertDialog((e as Error).message);
                      }
                    }}
                    className="mt-1 text-xs text-ocean hover:underline"
                  >
                    Convert to a shared property
                  </button>
                )}
              </Field>
              <Field label="Value type" hint="Semantic type with validation">
                <select value={prop.value_type_id ?? ""} disabled={!!shared} onChange={(e) => set({ value_type_id: e.target.value || null })} className={inputClass}>
                  <option value="">None</option>
                  {ctx.valueTypes.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.display_name} ({v.base_type})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}
        {tab === "Formatting" && (
          <>
            <ValueFormattingEditor prop={prop} onChange={(f) => set({ value_formatting: f })} disabled={!!shared} />
            <ConditionalFormattingEditor prop={prop} all={all} onChange={(rules) => set({ conditional_formatting: rules.length ? rules : null })} />
          </>
        )}
        {tab === "Interaction" && (
          <>
            {prop.type === "string" && (
              <label className="block text-xs">
                <span className="mb-1 block font-medium text-soft">Analyzer (keyword search)</span>
                <select value={prop.analyzer ?? ""} onChange={(e) => set({ analyzer: e.target.value || undefined })} className={inputClass}>
                  <option value="">Default (substring match)</option>
                  <option value="standard">Standard (word prefixes)</option>
                  <option value="simple">Simple (letters and digits)</option>
                  <option value="whitespace">Whitespace (exact tokens)</option>
                  <option value="english">English (stemmed words)</option>
                  <option value="indonesian">Indonesian (stemmed words: rawat matches dirawat, perawatan)</option>
                  {[["french", "French"], ["german", "German"], ["spanish", "Spanish"], ["portuguese", "Portuguese"], ["italian", "Italian"], ["dutch", "Dutch"], ["russian", "Russian"], ["arabic", "Arabic"],
                    ["combined_arabic_english", "Arabic + English"], ["japanese", "Japanese (bigrams)"], ["korean", "Korean (bigrams)"], ["chinese", "Chinese (bigrams)"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  <option value="not_analyzed">Not analyzed (whole value, for identifiers)</option>
                  <option value="not_indexed">Not indexed (not searchable)</option>
                </select>
              </label>
            )}
            <div>
              <div className="mb-1.5 text-xs font-medium text-soft">Render hints</div>
              <div className="space-y-1">
                {RENDER_HINTS.map((h) => (
                  <label key={h.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!!shared}
                      checked={prop.render_hints?.includes(h.id) ?? false}
                      onChange={(e) => {
                        const cur = new Set(prop.render_hints ?? []);
                        if (e.target.checked) {
                          cur.add(h.id);
                          if (["low_cardinality", "leading_wildcards", "regex_queries"].includes(h.id)) cur.add("searchable");
                        } else cur.delete(h.id);
                        set({ render_hints: [...cur] });
                      }}
                    />
                    <span>
                      <span className="block">{h.label}</span>
                      <span className="block text-xs text-muted">{h.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <TypeClasses value={prop.type_classes ?? []} onChange={(v) => set({ type_classes: v.length ? v : undefined })} />
            <Field label="Inline edit" hint="An action type that modifies one object of this type and writes this property: users then edit values in place in object tables and Object Views">
              <select value={prop.inline_edit_action_id ?? ""} onChange={(e) => set({ inline_edit_action_id: e.target.value || null })} className={inputClass}>
                <option value="">No inline edits</option>
                {(ctx.actions ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {tab === "Source" && (
          <>
            {prop.array && ["string", "integer", "long", "short", "byte", "double", "float", "decimal", "boolean", "date", "timestamp", "struct"].includes(prop.type) && (
              <Reducers prop={prop} onChange={(r) => set({ reducers: r.length ? r : undefined })} />
            )}
            <DerivedEditor prop={prop} ctx={ctx} onChange={(d) => set({ derived: d, edit_only: d ? undefined : prop.edit_only })} />
          </>
        )}
      </div>
    </aside>
  );

  function attachShared(id: string) {
    const sp = ctx.sharedProperties.find((s) => s.id === id);
    if (!sp) return set({ shared_property_id: null });
    onChange({
      ...prop,
      shared_property_id: sp.id,
      type: sp.type,
      array: sp.array,
      struct_fields: sp.struct_fields,
      value_type_id: sp.value_type_id ?? null,
      value_formatting: sp.value_formatting ?? null,
      render_hints: sp.render_hints,
      visibility: sp.visibility,
      display_name: prop.display_name || sp.display_name,
      api_name: prop.api_name || sp.api_name,
    });
  }
}

function StructFields({ prop, onChange, disabled }: { prop: Property; onChange: (c: Partial<Property>) => void; disabled: boolean }) {
  const fields = prop.struct_fields ?? [];
  const setF = (i: number, c: Partial<(typeof fields)[number]>) => onChange({ struct_fields: fields.map((f, j) => (j === i ? { ...f, ...c } : f)) });
  return (
    <div className="rounded-md border border-line-2 p-3">
      <div className="mb-2 flex items-center text-xs font-medium text-soft">
        Struct fields <span className="ml-1 font-normal text-muted">(no nesting or arrays; main fields stand for the struct)</span>
      </div>
      {fields.map((f, i) => (
        <div key={i} className="mb-1.5 flex items-center gap-1.5">
          <input value={f.api_name} disabled={disabled} placeholder="apiName" onChange={(e) => setF(i, { api_name: e.target.value })} className={`${fieldClass} w-28 font-mono text-xs`} />
          <input value={f.display_name ?? ""} disabled={disabled} placeholder="Display name" onChange={(e) => setF(i, { display_name: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
          <select value={f.type} disabled={disabled} onChange={(e) => setF(i, { type: e.target.value as PropertyType })} className={`${fieldClass} w-24 text-xs`}>
            {STRUCT_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[11px] text-muted" title="Main field">
            <input type="checkbox" disabled={disabled} checked={!!f.main} onChange={(e) => setF(i, { main: e.target.checked })} /> main
          </label>
          <button type="button" disabled={disabled || fields.length === 1} onClick={() => onChange({ struct_fields: fields.filter((_, j) => j !== i) })} className="text-muted hover:text-bad disabled:opacity-30">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange({ struct_fields: [...fields, { api_name: "", type: "string" }] })} className={buttonClass.ghost}>
        <Icon name="plus" className="h-3.5 w-3.5" /> Field
      </button>
    </div>
  );
}

function ValueFormattingEditor({ prop, onChange, disabled }: { prop: Property; onChange: (f: ValueFormatting | null) => void; disabled: boolean }) {
  const f = prop.value_formatting;
  const kind = NUMERIC.has(prop.type) ? "number" : prop.type === "date" || prop.type === "timestamp" ? "date" : prop.type === "string" ? "string" : null;
  const [sample, setSample] = useState(kind === "number" ? "123456.789" : kind === "date" ? new Date().toISOString() : "");
  if (!kind) return <p className="text-xs text-muted">No value formatting for {typeLabel(prop.type)} properties.</p>;
  const on = !!f;
  return (
    <div className="space-y-2 rounded-md border border-line-2 p-3">
      <label className="flex items-center gap-2 text-xs font-medium text-soft">
        <input
          type="checkbox"
          disabled={disabled}
          checked={on}
          onChange={(e) =>
            onChange(e.target.checked ? (kind === "number" ? { kind: "number", style: "standard", grouping: true } : kind === "date" ? { kind: "date", format: "datetime_short" } : { kind: "user" }) : null)
          }
        />
        Value formatting
      </label>
      {f?.kind === "number" && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <select value={f.style ?? "standard"} onChange={(e) => onChange({ ...f, style: e.target.value as typeof f.style })} className={fieldClass}>
            <option value="standard">Standard</option>
            <option value="currency">Currency</option>
            <option value="unit">Standard unit</option>
            <option value="percent">Percentage</option>
            <option value="affix">Prefix / suffix</option>
          </select>
          <select value={f.notation ?? "standard"} onChange={(e) => onChange({ ...f, notation: e.target.value as typeof f.notation })} className={fieldClass}>
            <option value="standard">Standard notation</option>
            <option value="compact">Compact (123K)</option>
            <option value="scientific">Scientific</option>
            <option value="engineering">Engineering</option>
          </select>
          {f.style === "currency" && <input value={f.currency ?? "USD"} onChange={(e) => onChange({ ...f, currency: e.target.value.toUpperCase() })} placeholder="USD" className={fieldClass} />}
          {f.style === "unit" && <input value={f.unit ?? ""} onChange={(e) => onChange({ ...f, unit: e.target.value })} placeholder="kg" className={fieldClass} />}
          {f.style === "affix" && (
            <>
              <input value={f.prefix ?? ""} onChange={(e) => onChange({ ...f, prefix: e.target.value })} placeholder="prefix" className={fieldClass} />
              <input value={f.suffix ?? ""} onChange={(e) => onChange({ ...f, suffix: e.target.value })} placeholder="suffix" className={fieldClass} />
            </>
          )}
          <label className="col-span-2 flex items-center gap-1.5 text-soft">
            <input type="checkbox" checked={f.grouping ?? true} onChange={(e) => onChange({ ...f, grouping: e.target.checked })} /> Use grouping (123,456)
          </label>
          {(
            [
              ["max_fraction", "Max fraction digits"],
              ["min_fraction", "Min fraction digits"],
              ["max_significant", "Max significant digits"],
              ["min_integer", "Min integer digits"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="text-muted">
              {label}
              <input type="number" min={0} max={20} value={f[k] ?? ""} onChange={(e) => onChange({ ...f, [k]: e.target.value === "" ? null : Number(e.target.value) })} className={`${fieldClass} mt-0.5 w-full`} />
            </label>
          ))}
        </div>
      )}
      {f?.kind === "date" && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <select value={f.format} onChange={(e) => onChange({ ...f, format: e.target.value as typeof f.format })} className={fieldClass}>
            <option value="date">Date</option>
            <option value="datetime">Date and time</option>
            <option value="datetime_short">Date and time, short</option>
            <option value="iso">ISO instant</option>
            <option value="relative">Relative to now</option>
            <option value="time">Time</option>
          </select>
          {prop.type === "timestamp" && (
            <input value={f.time_zone ?? ""} onChange={(e) => onChange({ ...f, time_zone: e.target.value || null })} placeholder="Time zone (yours if empty)" className={fieldClass} />
          )}
        </div>
      )}
      {(f?.kind === "user" || f?.kind === "resource") && (
        <select value={f.kind} onChange={(e) => onChange({ kind: e.target.value as "user" | "resource" })} className={`${fieldClass} text-xs`}>
          <option value="user">User or group name (from an ID)</option>
          <option value="resource">Resource RID (icon, name and link)</option>
        </select>
      )}
      {on && f?.kind !== "user" && f?.kind !== "resource" && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">Preview</span>
          <input value={sample} onChange={(e) => setSample(e.target.value)} className={`${fieldClass} w-36 text-xs`} />
          <span className="text-muted">→</span>
          <span className="font-medium">{formatProperty({ ...prop, array: false }, kind === "number" ? Number(sample) : sample)}</span>
        </div>
      )}
    </div>
  );
}

function ConditionalFormattingEditor({ prop, all, onChange }: { prop: Property; all: Property[]; onChange: (rules: CondRule[]) => void }) {
  const rules = prop.conditional_formatting ?? [];
  const setR = (i: number, r: CondRule) => onChange(rules.map((x, j) => (j === i ? r : x)));
  return (
    <div className="space-y-2 rounded-md border border-line-2 p-3">
      <div className="flex items-center text-xs font-medium text-soft">
        Conditional formatting
        <span className="ml-1 font-normal text-muted">(the first matching rule applies)</span>
      </div>
      {rules.map((r, i) => (
        <div key={i} className="space-y-1.5 rounded-md bg-panel-2 p-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={r.when.kind} onChange={(e) => setR(i, { ...r, when: { ...r.when, kind: e.target.value as CondRule["when"]["kind"] } })} className={`${fieldClass} py-1 text-xs`}>
              <option value="standard">Standard</option>
              <option value="always">Always true</option>
              <option value="math">Math</option>
            </select>
            {r.when.kind === "standard" && (
              <>
                <select value={r.when.property ?? prop.api_name} onChange={(e) => setR(i, { ...r, when: { ...r.when, property: e.target.value } })} className={`${fieldClass} w-28 py-1 text-xs`}>
                  {all.map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
                <select value={r.when.op ?? "eq"} onChange={(e) => setR(i, { ...r, when: { ...r.when, op: e.target.value as CondRule["when"]["op"] } })} className={`${fieldClass} py-1 text-xs`}>
                  {(["eq", "contains", "starts_with", "ends_with", "is_null", "gt", "gte", "lt", "lte", "between"] as const).map((o) => (
                    <option key={o} value={o}>
                      {o.replace("_", " ")}
                    </option>
                  ))}
                </select>
                {r.when.op !== "is_null" && (
                  <input value={String(r.when.value ?? "")} onChange={(e) => setR(i, { ...r, when: { ...r.when, value: e.target.value } })} placeholder="value" className={`${fieldClass} w-20 py-1 text-xs`} />
                )}
                {r.when.op === "between" && (
                  <input value={String(r.when.value2 ?? "")} onChange={(e) => setR(i, { ...r, when: { ...r.when, value2: e.target.value } })} placeholder="and" className={`${fieldClass} w-16 py-1 text-xs`} />
                )}
                <label className="flex items-center gap-1 text-muted">
                  <input type="checkbox" checked={!!r.when.negate} onChange={(e) => setR(i, { ...r, when: { ...r.when, negate: e.target.checked } })} /> false
                </label>
              </>
            )}
            {r.when.kind === "math" && (
              <input value={r.when.expression ?? ""} onChange={(e) => setR(i, { ...r, when: { ...r.when, expression: e.target.value } })} placeholder="{salary} / {budget} > 0.1" className={`${fieldClass} min-w-40 flex-1 py-1 font-mono text-xs`} />
            )}
            <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {INTENT_COLORS.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => setR(i, { ...r, style: { ...r.style, color: c.color, background: c.background } })}
                className={`rounded px-1.5 py-0.5 ${r.style.color === c.color ? "ring-1 ring-white/60" : ""}`}
                style={{ color: c.color, background: c.background }}
              >
                {c.label}
              </button>
            ))}
            <input type="color" value={r.style.color ?? "#ffffff"} onChange={(e) => setR(i, { ...r, style: { ...r.style, color: e.target.value, background: `${e.target.value}26` } })} className="h-5 w-6 bg-transparent" />
            <select value={r.style.align ?? "left"} onChange={(e) => setR(i, { ...r, style: { ...r.style, align: e.target.value as "left" | "right" } })} className={`${fieldClass} py-0.5 text-xs`}>
              <option value="left">Align left</option>
              <option value="right">Align right</option>
            </select>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" onClick={() => onChange([...rules, { when: { kind: "standard", property: prop.api_name, op: "eq", value: "" }, style: { color: INTENT_COLORS[0].color, background: INTENT_COLORS[0].background } }])} className={buttonClass.ghost}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Add a rule
        </button>
      </div>
    </div>
  );
}

export function TypeClasses({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (tc: string) => {
    const t = tc.trim();
    if (!t.includes(":") || value.includes(t)) return;
    onChange([...value, t]);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-soft">Type classes</div>
      <div className="flex flex-wrap gap-1.5">
        {value.map((tc) => (
          <span key={tc} className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-line-2">
            {tc}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== tc))} className="text-muted hover:text-bad">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          list="known-type-classes"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="kind:name"
          className={`${fieldClass} flex-1 font-mono text-xs`}
        />
        <datalist id="known-type-classes">
          {KNOWN_TYPE_CLASSES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <button type="button" onClick={() => add(draft)} className={buttonClass.secondary}>
          Add
        </button>
      </div>
    </div>
  );
}

function Reducers({ prop, onChange }: { prop: Property; onChange: (r: NonNullable<Property["reducers"]>) => void }) {
  const rs = prop.reducers ?? [];
  return (
    <div className="space-y-2 rounded-md border border-line-2 p-3">
      <div className="text-xs font-medium text-soft">
        Reducers <span className="font-normal text-muted">— where one value is expected (titles, cards, interfaces), show the element that sorts first</span>
      </div>
      {rs.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs">
          <span className="w-12 text-muted">{i === 0 ? "Sort by" : "then"}</span>
          {prop.type === "struct" && (
            <select value={r.field ?? ""} onChange={(e) => onChange(rs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} className={`${fieldClass} flex-1 py-1 text-xs`}>
              <option value="">Field…</option>
              {(prop.struct_fields ?? []).map((f) => (
                <option key={f.api_name} value={f.api_name}>
                  {f.display_name || f.api_name}
                </option>
              ))}
            </select>
          )}
          <select value={r.order} onChange={(e) => onChange(rs.map((x, j) => (j === i ? { ...x, order: e.target.value as "asc" | "desc" } : x)))} className={`${fieldClass} py-1 text-xs`}>
            <option value="desc">Descending (latest / largest)</option>
            <option value="asc">Ascending (earliest / smallest)</option>
          </select>
          <button type="button" onClick={() => onChange(rs.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rs, { order: "desc", field: prop.type === "struct" ? prop.struct_fields?.[0]?.api_name : undefined }])} className={buttonClass.ghost}>
        <Icon name="plus" className="h-3.5 w-3.5" /> Reducer
      </button>
    </div>
  );
}

function DerivedEditor({ prop, ctx, onChange }: { prop: Property; ctx: EditorContext; onChange: (d: Derived | null) => void }) {
  const d = prop.derived;
  const typeName = (id: string) => ctx.objectTypes.find((t) => t.id === id)?.display_name ?? id;
  // the object type reached after each hop
  const reached: string[] = [];
  let cur = ctx.t.id;
  for (const h of d?.links ?? []) {
    const lt = ctx.linkTypes.find((l) => l.id === h.link_type_id);
    if (!lt) break;
    cur = h.direction === "forward" ? lt.target.object_type_id : lt.source.object_type_id;
    reached.push(cur);
  }
  const options = (from: string) =>
    ctx.linkTypes.flatMap((lt) => [
      ...(lt.source.object_type_id === from ? [{ lt, direction: "forward" as const, to: lt.target }] : []),
      ...(lt.target.object_type_id === from ? [{ lt, direction: "reverse" as const, to: lt.source }] : []),
    ]);
  const target = ctx.objectTypes.find((t) => t.id === (reached.at(-1) ?? ""));
  return (
    <div className="space-y-2 rounded-md border border-line-2 p-3">
      <label className="flex items-center gap-2 text-xs font-medium text-soft">
        <input
          type="checkbox"
          checked={!!d}
          disabled={ctx.t.primary_key === prop.api_name}
          onChange={(e) => {
            const first = options(ctx.t.id)[0];
            onChange(e.target.checked && first ? { links: [{ link_type_id: first.lt.id, direction: first.direction }], aggregation: "count" } : null);
          }}
        />
        Derived from linked objects
      </label>
      {!d && options(ctx.t.id).length === 0 && <p className="text-xs text-muted">{ctx.t.display_name} has no link types yet.</p>}
      {d && (
        <>
          {d.links.map((h, i) => {
            const from = i === 0 ? ctx.t.id : reached[i - 1];
            return (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <span className="w-14 text-muted">{i === 0 ? "Follow" : "then"}</span>
                <select
                  value={`${h.link_type_id}|${h.direction}`}
                  onChange={(e) => {
                    const [id, dir] = e.target.value.split("|");
                    onChange({ ...d, links: [...d.links.slice(0, i), { link_type_id: id, direction: dir as "forward" | "reverse" }] });
                  }}
                  className={`${fieldClass} flex-1 py-1 text-xs`}
                >
                  {options(from ?? "").map((o) => (
                    <option key={`${o.lt.id}|${o.direction}`} value={`${o.lt.id}|${o.direction}`}>
                      {o.to.display_name} ({typeName(o.to.object_type_id)})
                    </option>
                  ))}
                </select>
                {i === d.links.length - 1 && i > 0 && (
                  <button type="button" onClick={() => onChange({ ...d, links: d.links.slice(0, -1) })} className="text-muted hover:text-bad">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          {d.links.length < 3 && options(reached.at(-1) ?? "").length > 0 && (
            <button
              type="button"
              onClick={() => {
                const o = options(reached.at(-1) ?? "")[0];
                onChange({ ...d, links: [...d.links, { link_type_id: o.lt.id, direction: o.direction }] });
              }}
              className={buttonClass.ghost}
            >
              <Icon name="plus" className="h-3.5 w-3.5" /> Another hop (at most 3)
            </button>
          )}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <select value={d.aggregation} onChange={(e) => onChange({ ...d, aggregation: e.target.value as Derived["aggregation"] })} className={fieldClass}>
              {["none", "count", "sum", "avg", "min", "max", "collect_list", "collect_set", "approximate_cardinality"].map((a) => (
                <option key={a} value={a}>
                  {a === "none" ? "No aggregation (one object)" : a.replace("_", " ")}
                </option>
              ))}
            </select>
            {d.aggregation !== "count" && (
              <select value={d.property ?? ""} onChange={(e) => onChange({ ...d, property: e.target.value })} className={fieldClass}>
                <option value="">Property of {target?.display_name ?? "…"}</option>
                {target?.properties.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            )}
            {(d.aggregation === "collect_list" || d.aggregation === "collect_set") && (
              <input type="number" min={1} max={1000} value={d.limit ?? 100} onChange={(e) => onChange({ ...d, limit: Number(e.target.value) })} className={fieldClass} title="Collection limit" />
            )}
          </div>
          <p className="text-[11px] text-muted">Computed when objects are read: read-only, metered as derived property queries.</p>
        </>
      )}
    </div>
  );
}

type EmbeddingModel = { id: string; label: string; dimension: number; dimensions?: number[] | null; note?: string | null };

/** A vector property's embedding model (queries are embedded with it) and the text property it embeds. */
function VectorSettings({ prop, all, set }: { prop: Property; all: Property[]; set: (c: Partial<Property>) => void }) {
  const [models, setModels] = useState<EmbeddingModel[]>([]);
  useEffect(() => {
    // provider models, then registered ones (functions implementing the Embedding function interface)
    Promise.all([
      request<{ models: EmbeddingModel[] }>("/semantic/config").then((c) => c.models, () => [] as EmbeddingModel[]),
      functions.registeredModels().then((r) => r.embedding, () => []),
    ]).then(([provider, registered]) => {
      const seen = new Set(provider.map((m) => m.id));
      setModels([...provider, ...registered.filter((m) => !seen.has(m.id)).map((m) => ({ id: m.id, label: m.label, dimension: m.dimension ?? 0, dimensions: m.dimension ? [m.dimension] : [], note: m.note }))]);
    });
  }, []);
  const texts = all.filter((p) => p.type === "string" && p.api_name !== prop.api_name);
  const model = models.find((m) => m.id === prop.embedding_model);
  const dimOk = !model || !model.dimension || !prop.vector_dimension || prop.vector_dimension === model.dimension || (model.dimensions ?? []).includes(prop.vector_dimension);
  return (
    <>
      <Field label="Embedding model" hint="Semantic search embeds queries with the same model">
        <select
          value={prop.embedding_model ?? ""}
          onChange={(e) => {
            const m = models.find((x) => x.id === e.target.value);
            set({ embedding_model: e.target.value || null, ...(m && m.dimension && !prop.vector_dimension ? { vector_dimension: m.dimension } : {}) });
          }}
          className={inputClass}
        >
          <option value="">The platform default</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.dimension || "dimension known after its first call"})
            </option>
          ))}
        </select>
        {!dimOk && model && <p className="mt-1 text-xs text-warn">{model.label} makes {model.dimension}-dimension vectors; this property has {prop.vector_dimension}.</p>}
      </Field>
      <Field label="Source text property" hint="The property whose text the vectors embed (Embed objects fills them)">
        <select value={prop.embedding_source ?? ""} onChange={(e) => set({ embedding_source: e.target.value || null })} className={inputClass}>
          <option value="">Not set</option>
          {texts.map((p) => (
            <option key={p.api_name} value={p.api_name}>
              {p.display_name || p.api_name}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
