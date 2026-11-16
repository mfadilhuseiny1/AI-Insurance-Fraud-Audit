"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { inputClass } from "@/components/pipeline/Modal";
import { FIELD_TYPES, type Condition, type FormDefinition, type FormField, type FormSheet, type Transform, type Validator } from "@/lib/forms";
import { ontology, type ObjectType } from "@/lib/ontology";

const small = `${inputClass} py-1 text-xs`;
const uid = () => Math.random().toString(36).slice(2, 8);

/** The form builder: sheets and their fields, and the visual editor of the selected field or sheet. */
export function FormBuilder({ defn, onChange }: { defn: FormDefinition; onChange: (d: FormDefinition) => void }) {
  const [sel, setSel] = useState<{ sheet: string; field?: string }>({ sheet: defn.sheets[0]?.id ?? "main" });
  const [types, setTypes] = useState<ObjectType[]>([]);
  useEffect(() => {
    ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, []);
  const allFields = defn.sheets.flatMap((s) => s.fields);
  const setSheet = (sid: string, patch: Partial<FormSheet>) => onChange({ ...defn, sheets: defn.sheets.map((s) => (s.id === sid ? { ...s, ...patch } : s)) });
  const setField = (sid: string, fid: string, patch: Partial<FormField>) =>
    setSheet(sid, { fields: defn.sheets.find((s) => s.id === sid)!.fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)) });
  const addField = (sid: string, type: FormField["type"]) => {
    const n = allFields.length + 1;
    const id = `${type.replace(/[^a-z]/g, "")}${n}`;
    const label = FIELD_TYPES.find(([t]) => t === type)?.[1] ?? type;
    setSheet(sid, { fields: [...defn.sheets.find((s) => s.id === sid)!.fields, { id, type, label, validators: [], transforms: [] }] });
    setSel({ sheet: sid, field: id });
  };
  const moveField = (sid: string, i: number, d: number) => {
    const fs = [...defn.sheets.find((s) => s.id === sid)!.fields];
    const j = i + d;
    if (j < 0 || j >= fs.length) return;
    [fs[i], fs[j]] = [fs[j], fs[i]];
    setSheet(sid, { fields: fs });
  };
  const sheet = defn.sheets.find((s) => s.id === sel.sheet) ?? defn.sheets[0];
  const field = sel.field ? sheet.fields.find((f) => f.id === sel.field) : undefined;

  return (
    <div className="grid min-h-0 gap-4 md:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        {defn.sheets.map((s, si) => (
          <section key={s.id} className={`rounded-xl border bg-panel ${sel.sheet === s.id && !sel.field ? "border-ocean" : "border-line"}`}>
            <header onClick={() => setSel({ sheet: s.id })} className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-sm">
              <Icon name="layers" className="h-3.5 w-3.5 text-muted" />
              <span className="font-medium">{s.title || (si === 0 ? "Main sheet" : "Sheet")}</span>
              {s.multiplicity && <span className="rounded bg-ocean/15 px-1.5 text-[10px] text-ocean">{s.multiplicity.kind} multiplicity</span>}
              {si > 0 && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onChange({ ...defn, sheets: defn.sheets.filter((x) => x.id !== s.id) }); setSel({ sheet: defn.sheets[0].id }); }}
                  className="ml-auto text-muted hover:text-bad" aria-label="Delete sheet">
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              )}
            </header>
            <ul className="divide-y divide-line">
              {s.fields.map((f, i) => (
                <li key={f.id} onClick={() => setSel({ sheet: s.id, field: f.id })} className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${sel.field === f.id ? "bg-ocean/10" : "hover:bg-panel-2"}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{f.label || f.id}{(f.validators ?? []).some((v) => v.kind === "required") && <span className="text-bad"> *</span>}</span>
                    <span className="text-[11px] text-muted">
                      {FIELD_TYPES.find(([t]) => t === f.type)?.[1]} · {f.id}
                      {(f.transforms ?? []).length ? ` · ${(f.transforms ?? []).length} transforms` : ""}
                    </span>
                  </span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); moveField(s.id, i, -1); }} className="text-muted hover:text-white" aria-label="Move up">
                    <Icon name="left" className="h-3 w-3 rotate-90" />
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); moveField(s.id, i, 1); }} className="text-muted hover:text-white" aria-label="Move down">
                    <Icon name="down" className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setSheet(s.id, { fields: s.fields.filter((x) => x.id !== f.id) }); setSel({ sheet: s.id }); }}
                    className="text-muted hover:text-bad" aria-label="Delete field">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-3 py-2">
              <select value="" onChange={(e) => e.target.value && addField(s.id, e.target.value as FormField["type"])} className={small} aria-label="Add field">
                <option value="">+ Add field…</option>
                {FIELD_TYPES.map(([t, l]) => (
                  <option key={t} value={t}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </section>
        ))}
        <button type="button" onClick={() => { const id = `sheet${uid()}`; onChange({ ...defn, sheets: [...defn.sheets, { id, title: "New sheet", fields: [] }] }); setSel({ sheet: id }); }}
          className="text-xs text-ocean hover:underline">
          + Insert new sheet
        </button>
      </div>
      <aside className="h-fit space-y-3 rounded-xl border border-line bg-panel p-4 text-xs">
        {field ? (
          <FieldEditor field={field} fields={allFields} types={types} onChange={(p) => setField(sheet.id, field.id, p)} onRename={(id) => { setField(sheet.id, field.id, { id }); setSel({ sheet: sheet.id, field: id }); }} />
        ) : (
          <SheetEditor sheet={sheet} main={sheet.id === defn.sheets[0].id} fields={allFields} onChange={(p) => setSheet(sheet.id, p)} />
        )}
      </aside>
    </div>
  );
}

function SheetEditor({ sheet, main, fields, onChange }: { sheet: FormSheet; main: boolean; fields: FormField[]; onChange: (p: Partial<FormSheet>) => void }) {
  return (
    <div className="space-y-2">
      <div className="font-semibold">Sheet</div>
      <label className="block">Title<input value={sheet.title} onChange={(e) => onChange({ title: e.target.value })} className={small} /></label>
      <label className="block">Description<textarea rows={2} value={sheet.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} className={small} /></label>
      <label className="block">Columns
        <select value={sheet.columns ?? 1} onChange={(e) => onChange({ columns: Number(e.target.value) })} className={small}>
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
      </label>
      {!main && (
        <>
          <label className="block">Multiplicity
            <select value={sheet.multiplicity?.kind ?? ""} onChange={(e) => onChange({ multiplicity: e.target.value ? { kind: e.target.value as "free" | "parameterized" } : null })} className={small}>
              <option value="">None (fields shared with the main sheet)</option>
              <option value="free">Free: respondents add entries</option>
              <option value="parameterized">Parameterized: one entry per value of a field</option>
            </select>
          </label>
          {sheet.multiplicity?.kind === "parameterized" && (
            <>
              <label className="block">Shared field giving the values
                <select value={sheet.multiplicity.param_field ?? ""} onChange={(e) => onChange({ multiplicity: { ...sheet.multiplicity!, param_field: e.target.value } })} className={small}>
                  <option value="">Choose…</option>
                  {fields.filter((f) => !sheet.fields.includes(f)).map((f) => <option key={f.id} value={f.id}>{f.label || f.id}</option>)}
                </select>
              </label>
              <label className="block">Field of this sheet that receives the value
                <select value={sheet.multiplicity.param_target ?? ""} onChange={(e) => onChange({ multiplicity: { ...sheet.multiplicity!, param_target: e.target.value } })} className={small}>
                  <option value="">Choose…</option>
                  {sheet.fields.map((f) => <option key={f.id} value={f.id}>{f.label || f.id}</option>)}
                </select>
              </label>
            </>
          )}
        </>
      )}
    </div>
  );
}

function FieldEditor({ field: f, fields, types, onChange, onRename }: { field: FormField; fields: FormField[]; types: ObjectType[]; onChange: (p: Partial<FormField>) => void; onRename: (id: string) => void }) {
  const [tab, setTab] = useState<"properties" | "validators" | "transforms">("properties");
  const ot = types.find((t) => t.id === f.object_type_id);
  const others = fields.filter((x) => x.id !== f.id);
  return (
    <div className="space-y-2">
      <div className="flex border-b border-line">
        {(["properties", "validators", "transforms"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-2 py-1 capitalize ${tab === t ? "border-ocean text-ocean" : "border-transparent text-muted"}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === "properties" && (
        <div className="space-y-2">
          <label className="block">Label<input value={f.label ?? ""} onChange={(e) => onChange({ label: e.target.value })} className={small} /></label>
          <div className="flex gap-2">
            <label className="block flex-1">ID (URI)<input value={f.id} onChange={(e) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.target.value) && onRename(e.target.value)} className={small} /></label>
            <label className="block flex-1">Column / property<input value={f.column ?? ""} placeholder={f.id} onChange={(e) => onChange({ column: e.target.value || undefined })} className={small} /></label>
          </div>
          <label className="block">Type
            <select value={f.type} onChange={(e) => onChange({ type: e.target.value as FormField["type"] })} className={small}>
              {FIELD_TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
            </select>
          </label>
          <label className="block">Description<input value={f.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} className={small} /></label>
          {!["callout", "objects_provider", "object_property_display", "calculation", "created_at", "created_by", "primary_key", "template", "user_properties", "attachments"].includes(f.type) && (
            <label className="block">URL parameter (prefills an embedded form; field.{f.id} always works)
              <input value={f.url_param ?? ""} placeholder={`e.g. ${f.id}`} onChange={(e) => onChange({ url_param: e.target.value.trim() || undefined })} className={`${small} font-mono`} />
            </label>
          )}
          {["text", "textarea", "numeric", "url", "dropdown"].includes(f.type) && <label className="block">Placeholder<input value={f.placeholder ?? ""} onChange={(e) => onChange({ placeholder: e.target.value })} className={small} /></label>}
          {["dropdown", "radio", "checkboxes"].includes(f.type) && (
            <label className="block">Options (value|label per line)
              <textarea rows={4} value={(f.options ?? []).map((o) => `${o.value}${o.label && o.label !== o.value ? `|${o.label}` : ""}`).join("\n")}
                onChange={(e) => onChange({ options: e.target.value.split("\n").filter((l) => l.trim()).map((l) => { const [v, lab] = l.split("|"); return { value: v.trim(), label: (lab ?? v).trim() }; }) })}
                className={`${small} font-mono`} />
            </label>
          )}
          {["dropdown", "user_dropdown", "object_dropdown", "object_property_dropdown", "dataset_value_dropdown"].includes(f.type) && (
            <div className="flex gap-3">
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.multiple} onChange={(e) => onChange({ multiple: e.target.checked })} /> Multiple</label>
              {f.type !== "user_dropdown" && f.type !== "object_dropdown" && <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.allow_other} onChange={(e) => onChange({ allow_other: e.target.checked })} /> Other values</label>}
            </div>
          )}
          {(f.type === "numeric" || f.type === "slider") && (
            <div className="flex gap-2">
              <label className="block">Min<input type="number" value={f.min ?? ""} onChange={(e) => onChange({ min: e.target.value === "" ? undefined : Number(e.target.value) })} className={small} /></label>
              <label className="block">Max<input type="number" value={f.max ?? ""} onChange={(e) => onChange({ max: e.target.value === "" ? undefined : Number(e.target.value) })} className={small} /></label>
              <label className="block">Unit<input value={f.unit ?? ""} onChange={(e) => onChange({ unit: e.target.value })} className={small} /></label>
            </div>
          )}
          {f.type === "date" && (
            <div className="space-y-1">
              <div className="flex gap-2">
                <label className="block">Min<input type="date" value={String(f.min ?? "")} onChange={(e) => onChange({ min: e.target.value || undefined })} className={small} /></label>
                <label className="block">Max<input type="date" value={String(f.max ?? "")} onChange={(e) => onChange({ max: e.target.value || undefined })} className={small} /></label>
              </div>
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.no_past} onChange={(e) => onChange({ no_past: e.target.checked })} /> Disable past dates</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.no_future} onChange={(e) => onChange({ no_future: e.target.checked })} /> Disable future dates</label>
            </div>
          )}
          {f.type === "calculation" && (
            <>
              <label className="block">Formula ({"{field}"} references; Fusion functions)<input value={f.formula ?? ""} onChange={(e) => onChange({ formula: e.target.value })} placeholder="{jumlah} * {tarif}" className={`${small} font-mono`} /></label>
              <label className="block">Precision<input type="number" value={f.precision ?? ""} onChange={(e) => onChange({ precision: e.target.value === "" ? undefined : Number(e.target.value) })} className={small} /></label>
            </>
          )}
          {(f.type === "template" || f.type === "callout") && (
            <label className="block">{f.type === "callout" ? "Markdown" : "Text"} ({"{{field}}"} references)<textarea rows={3} value={f.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} className={small} /></label>
          )}
          {f.type === "dataset_value_dropdown" && (
            <>
              <label className="block">Dataset (name or Files ID)<input value={f.dataset ?? ""} onChange={(e) => onChange({ dataset: e.target.value })} className={small} /></label>
              <label className="block">Column<input value={f.dataset_column ?? ""} onChange={(e) => onChange({ dataset_column: e.target.value })} className={small} /></label>
              <div className="flex gap-2">
                <label className="block flex-1">Filter column<input value={f.filter_column ?? ""} onChange={(e) => onChange({ filter_column: e.target.value || undefined })} className={small} /></label>
                <FieldPick label="equals field" value={f.filter_field} fields={others} onChange={(v) => onChange({ filter_field: v })} />
              </div>
            </>
          )}
          {f.type === "user_properties" && (
            <div className="flex gap-2">
              <FieldPick label="User from field" value={f.source_field} fields={others} onChange={(v) => onChange({ source_field: v })} />
              <label className="block flex-1">Property
                <select value={f.property ?? "display_name"} onChange={(e) => onChange({ property: e.target.value })} className={small}>
                  {[["display_name", "Display name"], ["last_first", "Last name, first name"], ["username", "Username"], ["email", "Email"], ["first_name", "First name"], ["last_name", "Last name"], ["organization", "Organization"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="block flex-1">When no user is selected<input value={f.none_message ?? ""} onChange={(e) => onChange({ none_message: e.target.value || undefined })} className={small} /></label>
            </div>
          )}
          {f.type === "map_picker" && (
            <div className="flex gap-2">
              <label className="block flex-1">Start at (lat, lon)<input value={f.location ? f.location.join(", ") : ""} onChange={(e) => { const [a, b] = e.target.value.split(",").map((x) => Number(x.trim())); onChange({ location: Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined }); }} placeholder="-6.2, 106.8" className={small} /></label>
              <label className="block w-24">Zoom<input type="number" value={f.initial_zoom ?? ""} onChange={(e) => onChange({ initial_zoom: e.target.value ? Number(e.target.value) : undefined })} className={small} /></label>
            </div>
          )}
          {f.type === "resource_picker" && (
            <label className="block">Respondents may pick
              <select value={f.allow ?? "any"} onChange={(e) => onChange({ allow: e.target.value as FormField["allow"] })} className={small}>
                <option value="any">Any resource</option>
                <option value="folders">Folders</option>
                <option value="datasets">Datasets</option>
              </select>
            </label>
          )}
          {["object_dropdown", "object_property_dropdown", "objects_provider", "object_property_display"].includes(f.type) && (
            <>
              <label className="block">Object type
                <select value={f.object_type_id ?? ""} onChange={(e) => onChange({ object_type_id: e.target.value })} className={small}>
                  <option value="">Choose…</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                </select>
              </label>
              {(f.type === "object_property_dropdown" || f.type === "object_property_display") && (
                <label className="block">Property
                  <select value={f.property ?? ""} onChange={(e) => onChange({ property: e.target.value })} className={small}>
                    <option value="">Choose…</option>
                    {(ot?.properties ?? []).map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
                  </select>
                </label>
              )}
              {f.type === "object_property_display" ? (
                <FieldPick label="Object from field" value={f.source_field} fields={others} onChange={(v) => onChange({ source_field: v })} />
              ) : (
                <div className="flex gap-2">
                  <label className="block flex-1">Filter property
                    <select value={f.filter_property ?? ""} onChange={(e) => onChange({ filter_property: e.target.value || undefined })} className={small}>
                      <option value="">None</option>
                      {(ot?.properties ?? []).map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
                    </select>
                  </label>
                  <FieldPick label="equals field" value={f.filter_field} fields={others} onChange={(v) => onChange({ filter_field: v })} />
                </div>
              )}
            </>
          )}
          {f.type === "attachments" && <label className="block">Upload folder (Files ID; default: next to the form)<input value={f.folder_id ?? ""} onChange={(e) => onChange({ folder_id: e.target.value || undefined })} className={small} /></label>}
          <div className="flex gap-3">
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.readonly} onChange={(e) => onChange({ readonly: e.target.checked })} /> Read only</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.hidden} onChange={(e) => onChange({ hidden: e.target.checked })} /> Hidden</label>
          </div>
        </div>
      )}
      {tab === "validators" && <Validators list={f.validators ?? []} onChange={(validators) => onChange({ validators })} />}
      {tab === "transforms" && <Transforms list={f.transforms ?? []} fields={others} onChange={(transforms) => onChange({ transforms })} />}
    </div>
  );
}

function FieldPick({ label, value, fields, onChange }: { label: string; value?: string; fields: FormField[]; onChange: (v: string | undefined) => void }) {
  return (
    <label className="block flex-1">{label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={small}>
        <option value="">None</option>
        {fields.map((x) => <option key={x.id} value={x.id}>{x.label || x.id}</option>)}
      </select>
    </label>
  );
}

function Validators({ list, onChange }: { list: Validator[]; onChange: (v: Validator[]) => void }) {
  const get = (k: Validator["kind"]) => list.find((v) => v.kind === k);
  const toggle = (k: Validator["kind"], on: boolean) => onChange(on ? [...list, { kind: k }] : list.filter((v) => v.kind !== k));
  const patch = (k: Validator["kind"], p: Partial<Validator>) => onChange(list.map((v) => (v.kind === k ? { ...v, ...p } : v)));
  return (
    <div className="space-y-3">
      {(["required", "regex", "range", "length"] as const).map((k) => {
        const v = get(k);
        return (
          <div key={k} className="space-y-1 rounded border border-line p-2">
            <label className="flex items-center gap-1.5 font-medium capitalize"><input type="checkbox" checked={!!v} onChange={(e) => toggle(k, e.target.checked)} /> {k}</label>
            {v && k === "regex" && <input value={v.pattern ?? ""} onChange={(e) => patch(k, { pattern: e.target.value })} placeholder="^[0-9]{5}$" className={`${small} font-mono`} />}
            {v && (k === "range" || k === "length") && (
              <div className="flex gap-2">
                <input type="number" value={v.min ?? ""} onChange={(e) => patch(k, { min: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="min" className={small} />
                <input type="number" value={v.max ?? ""} onChange={(e) => patch(k, { max: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="max" className={small} />
              </div>
            )}
            {v && <input value={v.message ?? ""} onChange={(e) => patch(k, { message: e.target.value || undefined })} placeholder="Custom message (optional)" className={small} />}
          </div>
        );
      })}
    </div>
  );
}

function Transforms({ list, fields, onChange }: { list: Transform[]; fields: FormField[]; onChange: (v: Transform[]) => void }) {
  const set = (i: number, p: Partial<Transform>) => onChange(list.map((t, j) => (j === i ? { ...t, ...p } : t)));
  return (
    <div className="space-y-2">
      <p className="text-muted">Applied in order; the last one wins on conflicts.</p>
      {list.map((t, i) => {
        const c: Condition = t.condition ?? {};
        return (
          <div key={i} className="space-y-1 rounded border border-line p-2">
            <div className="flex items-center gap-1">
              <select value={t.kind} onChange={(e) => set(i, { kind: e.target.value as Transform["kind"] })} className={small}>
                <option value="hide">Hide field</option>
                <option value="show">Show field</option>
                <option value="disable">Disable field</option>
                <option value="update">Update configuration</option>
                <option value="change_type">Change field type</option>
              </select>
              <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove transform"><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
            <div className="flex gap-1">
              <span className="pt-1 text-muted">if</span>
              <select value={c.field ?? ""} onChange={(e) => set(i, { condition: { ...c, field: e.target.value } })} className={small}>
                <option value="">field…</option>
                {fields.map((x) => <option key={x.id} value={x.id}>{x.label || x.id}</option>)}
              </select>
              <select value={c.op ?? "is"} onChange={(e) => set(i, { condition: { ...c, op: e.target.value as Condition["op"] } })} className={small}>
                <option value="is">is</option>
                <option value="is_not">is not</option>
                <option value="has_value">has a value</option>
                <option value="no_value">has no value</option>
                <option value="contains">contains</option>
              </select>
              {!["has_value", "no_value"].includes(c.op ?? "is") && <input value={String(c.value ?? "")} onChange={(e) => set(i, { condition: { ...c, value: e.target.value } })} placeholder="value" className={small} />}
            </div>
            {t.kind === "change_type" && (
              <select value={t.type ?? ""} onChange={(e) => set(i, { type: e.target.value as FormField["type"] })} className={small}>
                <option value="">to type…</option>
                {FIELD_TYPES.map(([ft, l]) => <option key={ft} value={ft}>{l}</option>)}
              </select>
            )}
            {t.kind === "update" && (
              <textarea rows={3} defaultValue={JSON.stringify(t.patch ?? { validators: [{ kind: "required" }] }, null, 1)}
                onBlur={(e) => { try { set(i, { patch: JSON.parse(e.target.value) as Record<string, unknown> }); } catch {} }}
                className={`${small} font-mono`} title="The configuration to apply, e.g. a label or validators" />
            )}
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...list, { kind: "show", condition: {} }])} className="text-ocean hover:underline">+ Add new transform</button>
    </div>
  );
}
