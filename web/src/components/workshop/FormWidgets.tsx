"use client";

import { useEffect, useMemo, useState } from "react";
import { FormEmbed } from "@/components/forms/FormEmbed";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { forms, type FormField, type FormSubmittedMessage } from "@/lib/forms";
import { ontology, type ObjectType } from "@/lib/ontology";
import type { FormEmbedPrefill, Module, Variable, Widget, WidgetConfig } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

/**
 * Form embed (doc "Forms", embedding a form in an application: the fill page in an iframe, prefilled through URL
 * parameters): a published form inside a Workshop module. Values come from module variables or fixed text; an object
 * variable is the object the form opens for (object dropdowns of its type select it, a form writing its type edits
 * it). On submit the response id and the edited / created object go to output variables, the widget's events run and
 * the other widgets reload.
 */

/** Fields that take no prefilled value (shown only, filled in by the form, or files). */
const NOT_PREFILLED = new Set(["callout", "objects_provider", "object_property_display", "calculation", "created_at", "created_by", "template", "user_properties", "attachments"]);

/** A primary key from an object / object set / string variable's value (a key, a list of keys, or { primary_key }). */
export function keysOf(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.flatMap(keysOf);
  if (typeof v === "object") {
    const o = v as { primary_key?: unknown; pk?: unknown; id?: unknown };
    const k = o.primary_key ?? o.pk ?? o.id;
    return k === undefined || k === null || k === "" ? [] : [String(k)];
  }
  return [String(v)];
}

/**
 * A variable's value as a prefilled field value (the server coerces and validates it, listing what it ignores):
 * string / number / boolean as text, a date or timestamp as its ISO text (a date field takes the day), an object or
 * object set as its object (all its objects for a field taking several), an array as its values.
 */
export function prefillValue(value: unknown, varType: Variable["type"] | undefined, entry: Pick<FormEmbedPrefill, "multiple">): string | string[] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (varType === "object" || varType === "object_set") {
    const keys = keysOf(value);
    if (!keys.length) return undefined;
    return entry.multiple ? keys : keys[0];
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (Array.isArray(value)) {
    const items = value.filter((x) => x !== null && x !== undefined && x !== "" && typeof x !== "object").map(String);
    return items.length ? (entry.multiple ? items : items[0]) : undefined;
  }
  if (typeof value === "object") return keysOf(value)[0];
  return String(value);
}

/** An id into a variable of the type the variable has (string; array / object set: a list of one; object: the key). */
function writeVar(state: ModuleState, name: string | undefined, id: string | undefined) {
  if (!name) return;
  const t = state.variableTypes?.[name];
  if (t === "array" || t === "object_set") state.setVariable(name, id ? [id] : []);
  else state.setVariable(name, id ?? "");
}

const Empty = ({ children, bad }: { children: React.ReactNode; bad?: boolean }) => (
  <div className={`flex h-full items-center justify-center p-4 text-center text-xs ${bad ? "text-bad" : "text-muted"}`}>{children}</div>
);

export function FormEmbedWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [round, setRound] = useState(0);
  const [done, setDone] = useState<{ rows: number; edited: boolean } | null>(null);
  const formId = c.fe_form_id ?? "";
  const objectPk = c.fe_object_variable ? keysOf(state.variables[c.fe_object_variable])[0] : undefined;
  const objectType = c.fe_object_type_id || undefined;
  // the prefilled values: a variable's value (converted) or the fixed text; empty ones are left out
  const prefill = useMemo(() => {
    const out: Record<string, string | string[]> = {};
    for (const e of c.fe_prefill ?? []) {
      if (!e.field) continue;
      const v = e.fixed ? e.value : !e.variable ? undefined : prefillValue(state.variables[e.variable], state.variableTypes?.[e.variable] as Variable["type"] | undefined, e);
      if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) out[e.field] = v;
    }
    return out;
  }, [c.fe_prefill, state.variables, state.variableTypes]);
  if (!formId) return <Empty>Choose a form in the widget&apos;s settings.</Empty>;
  if (c.fe_object_variable && objectPk && !objectType) return <Empty bad>Choose the object type of the object variable.</Empty>;
  if (c.fe_object_variable && !objectPk && c.fe_require_object) return <Empty>{state.tr?.(c.fe_empty_message || "Select an object to fill in the form.") ?? (c.fe_empty_message || "Select an object to fill in the form.")}</Empty>;
  if (state.readOnly && !editing) return <Empty>Read-only: this module does not write, so the form is not shown.</Empty>;
  const onSubmitted = async (m: FormSubmittedMessage) => {
    setDone({ rows: m.rows, edited: m.edited_object });
    writeVar(state, c.fe_response_variable, m.response_id);
    if (c.fe_object_output_variable) {
      // the edited object is the one the form was opened for; a created object is found in the response (editors)
      let pk = m.edited_object ? m.object?.pk : undefined;
      if (!pk) {
        try {
          const r = (await forms.responses(formId)).find((x) => x.id === m.response_id);
          pk = (r?.written as unknown as { primary_key?: string }[] | undefined)?.find((w) => w && w.primary_key)?.primary_key;
        } catch {
          // not an editor of the form: the created object's key is not known here
        }
      }
      writeVar(state, c.fe_object_output_variable, pk);
    }
    if (c.fe_reset !== false) setRound((n) => n + 1);
    await state.runEvents?.(c.fe_events ?? []);
    if (c.fe_refresh !== false) state.bump();
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 overflow-auto p-1" data-form-embed>
      {done && (
        <p role="status" className="shrink-0 rounded border border-ok/40 bg-ok/10 px-2 py-1 text-xs text-ok">
          {c.fe_confirmation || `Submitted${done.edited ? ": the object was updated" : done.rows ? `: ${done.rows} row${done.rows === 1 ? "" : "s"} written` : ""}.`}
        </p>
      )}
      {editing && <p className="shrink-0 text-[11px] text-muted">Preview: submitting is off while the module is edited.</p>}
      <div className={editing ? "pointer-events-none min-h-0" : "min-h-0"}>
        <FormEmbed
          key={round}
          formId={formId}
          object={objectPk && objectType ? { objectType, pk: objectPk } : null}
          prefill={prefill}
          noHeader={c.fe_no_header}
          progressOnly={c.fe_progress_only}
          maxHeight={c.fe_max_height || undefined}
          title={widget.title || "Form"}
          onSubmitted={(m) => void onSubmitted(m)}
        />
      </div>
    </div>
  );
}

export function FormEmbedConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const on = widget.type === "form_embed";
  const vars = mod.variables ?? [];
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [info, setInfo] = useState<{ id: string; fields: FormField[]; writes: string | null; published: boolean } | null>(null);
  const formId = c.fe_form_id ?? "";
  useEffect(() => {
    if (!on) return;
    forms.list().then((l) => setList(l.map((f) => ({ id: f.id, name: f.name.replace(/\.form$/, "") }))), () => undefined);
    ontology.objectTypes().then(setTypes, () => undefined);
  }, [on]);
  useEffect(() => {
    if (!on || !formId) return;
    let stale = false;
    forms.get(formId).then(
      (v) => {
        if (stale) return;
        setInfo({
          id: formId,
          fields: v.form.sheets.filter((sh) => !sh.multiplicity).flatMap((sh) => sh.fields).filter((f) => !NOT_PREFILLED.has(f.type)),
          writes: v.form.destination.kind === "object_type" ? (v.form.destination.object_type_id ?? null) : null,
          published: !!v.form.published,
        });
      },
      () => !stale && setInfo({ id: formId, fields: [], writes: null, published: true }),
    );
    return () => {
      stale = true;
    };
  }, [on, formId]);
  if (!on) return null;
  const fields = info?.id === formId ? info.fields : [];
  const writes = info?.id === formId ? info.writes : null;
  const prefill = c.fe_prefill ?? [];
  const setPrefill = (rows: FormEmbedPrefill[]) => set({ fe_prefill: rows.length ? rows : undefined });
  const unused = fields.filter((f) => !prefill.some((e) => e.field === f.id));
  const varSel = (value: string | undefined, onChange: (v: string | undefined) => void, kinds: Variable["type"][], none = "None", label?: string) => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass} aria-label={label}>
      <option value="">{none}</option>
      {vars.filter((v) => kinds.includes(v.type)).map((v) => (
        <option key={v.name} value={v.name}>
          {v.name} ({v.type.replace(/_/g, " ")})
        </option>
      ))}
    </select>
  );
  const toggle = (label: string, value: boolean | undefined, onChange: (v: boolean | undefined) => void, dflt = true) => (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={dflt ? value !== false : !!value} onChange={(e) => onChange(dflt ? (e.target.checked ? undefined : false) : e.target.checked || undefined)} /> {label}
    </label>
  );
  return (
    <div className="space-y-3 text-xs" data-form-embed-config>
      <div className="font-semibold uppercase tracking-wide text-muted">Form</div>
      <Field label="Form" hint="A published form (Forms). Respondents fill its published version.">
        <select
          value={formId}
          onChange={(e) => set({ fe_form_id: e.target.value || undefined, fe_prefill: undefined })}
          className={inputClass}
          aria-label="Form"
        >
          <option value="">Choose…</option>
          {list.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          {formId && !list.some((f) => f.id === formId) && <option value={formId}>{formId}</option>}
        </select>
      </Field>
      {info?.id === formId && formId && !info.published && <p className="text-bad">This form has no published version yet: publish it in Forms.</p>}
      <div className="font-semibold uppercase tracking-wide text-muted">Object</div>
      <Field label="Object (an object variable)" hint="The form opens for this object: object dropdowns of its type select it; a form writing its type starts with its values and submitting edits it. An object set gives its first object.">
        {varSel(c.fe_object_variable, (v) => set({ fe_object_variable: v, ...(v && !c.fe_object_type_id && writes ? { fe_object_type_id: writes } : {}) }), ["object", "object_set", "string", "array"], "None", "Object variable")}
      </Field>
      {c.fe_object_variable && (
        <>
          <Field label="Object type">
            <select value={c.fe_object_type_id ?? ""} onChange={(e) => set({ fe_object_type_id: e.target.value || undefined })} className={inputClass} aria-label="Object type">
              <option value="">Choose…</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          </Field>
          {writes && c.fe_object_type_id === writes && <p className="text-muted">The form writes this object type: it is an Edit object form for the variable&apos;s object.</p>}
          {toggle("Show the form only when an object is selected", c.fe_require_object, (v) => set({ fe_require_object: v }), false)}
          {c.fe_require_object && <input value={c.fe_empty_message ?? ""} onChange={(e) => set({ fe_empty_message: e.target.value || undefined })} placeholder="Select an object to fill in the form." className={inputClass} aria-label="Message without an object" />}
        </>
      )}
      <div className="font-semibold uppercase tracking-wide text-muted">Prefilled values</div>
      {!formId && <p className="text-muted">Choose a form first.</p>}
      {prefill.map((e, j) => {
        const put = (patch: Partial<FormEmbedPrefill>) => setPrefill(prefill.map((x, k) => (k === j ? { ...x, ...patch } : x)));
        return (
          <div key={e.field} className="space-y-1 rounded border border-line p-1.5" data-prefill-row={e.field}>
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-medium" title={e.field}>
                {fields.find((f) => f.id === e.field)?.label || e.label || e.field}
              </span>
              <button type="button" onClick={() => setPrefill(prefill.filter((_, k) => k !== j))} className="text-muted hover:text-bad" aria-label={`Remove prefilled ${e.field}`}>
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <select value={e.fixed ? "fixed" : "var"} onChange={(ev) => put(ev.target.value === "var" ? { fixed: undefined, value: undefined } : { fixed: true, variable: undefined })} className={fieldClass} aria-label={`Source of ${e.field}`}>
                <option value="var">Variable</option>
                <option value="fixed">Fixed value</option>
              </select>
              {!e.fixed ? (
                <select value={e.variable ?? ""} onChange={(ev) => put({ variable: ev.target.value || undefined })} className={`${fieldClass} min-w-0 flex-1`} aria-label={`Variable of ${e.field}`}>
                  <option value="">Variable…</option>
                  {vars
                    .filter((v) => ["string", "number", "boolean", "date", "timestamp", "object", "object_set", "array"].includes(v.type))
                    .map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name} ({v.type.replace(/_/g, " ")})
                      </option>
                    ))}
                </select>
              ) : (
                <input value={e.value ?? ""} onChange={(ev) => put({ value: ev.target.value })} className={`${fieldClass} min-w-0 flex-1`} aria-label={`Value of ${e.field}`} />
              )}
            </div>
          </div>
        );
      })}
      {unused.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const f = fields.find((x) => x.id === e.target.value);
            if (f) setPrefill([...prefill, { field: f.id, label: f.label, multiple: !!f.multiple || f.type === "checkboxes" || undefined }]);
          }}
          className={inputClass}
          aria-label="Prefill a field"
        >
          <option value="">+ Prefill a field…</option>
          {unused.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label || f.id}
            </option>
          ))}
        </select>
      )}
      <p className="text-[11px] text-muted">A date or timestamp gives its day to a date field; an object set gives its first object (all of them to a field taking several). Values a field cannot take are left out.</p>
      <div className="font-semibold uppercase tracking-wide text-muted">On submit</div>
      <Field label="Response id (output: a string variable)">{varSel(c.fe_response_variable, (v) => set({ fe_response_variable: v }), ["string", "array"], "None", "Response variable")}</Field>
      <Field label="Edited or created object (output)" hint="The object an Edit object form updated; a created object's key is read from the response (editors of the form).">
        {varSel(c.fe_object_output_variable, (v) => set({ fe_object_output_variable: v }), ["object", "object_set", "string", "array"], "None", "Object output variable")}
      </Field>
      <EventsEditor events={c.fe_events ?? []} mod={mod} onChange={(ev) => set({ fe_events: ev.length ? ev : undefined })} label="On submit" />
      {toggle("Refresh the other widgets", c.fe_refresh, (v) => set({ fe_refresh: v }))}
      {toggle("Start a new response after submitting", c.fe_reset, (v) => set({ fe_reset: v }))}
      <input value={c.fe_confirmation ?? ""} onChange={(e) => set({ fe_confirmation: e.target.value || undefined })} placeholder="Message after submitting (default: Submitted.)" className={inputClass} aria-label="Confirmation message" />
      <div className="font-semibold uppercase tracking-wide text-muted">Display</div>
      {toggle("Hide the form's title", c.fe_no_header, (v) => set({ fe_no_header: v }), false)}
      {!c.fe_no_header && toggle("Only the progress bar as the header", c.fe_progress_only, (v) => set({ fe_progress_only: v }), false)}
      <Field label="Maximum height (px)" hint="A taller form scrolls inside the widget. Empty: the form's own height.">
        <input type="number" min={120} value={c.fe_max_height ?? ""} onChange={(e) => set({ fe_max_height: e.target.value ? Math.max(120, Number(e.target.value)) : undefined })} className={inputClass} aria-label="Maximum height" />
      </Field>
    </div>
  );
}
