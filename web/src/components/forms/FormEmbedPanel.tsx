"use client";

import { useState } from "react";
import { FormEmbed } from "@/components/forms/FormEmbed";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { FORM_HEIGHT, FORM_SUBMITTED, formEmbedPath, type FormDefinition, type FormField, type FormSubmittedMessage } from "@/lib/forms";
import type { ObjectType } from "@/lib/ontology";

// filled in by the form, only shown, or a file: no URL parameter
const NOT_PREFILLED = new Set(["callout", "objects_provider", "object_property_display", "calculation", "created_at", "created_by", "primary_key", "template", "user_properties", "attachments"]);

const enc = (v: string) => encodeURIComponent(v).replace(/%7B/g, "{").replace(/%7D/g, "}");

/** The parameter that prefills a field: its own URL parameter, else field.<id>. */
export const prefillParam = (f: FormField) => f.url_param || `field.${f.id}`;

/**
 * The editor's Embed section: display options, the object the form is embedded for and prefilled values give the
 * embed URL, an iframe snippet (with the messages the page posts) and a <FormEmbed> snippet, each to copy; a preview
 * shows the published form embedded, with its submissions.
 */
export function FormEmbedPanel({ id, draft, types, published }: { id: string; draft: FormDefinition; types: ObjectType[]; published: boolean }) {
  const [noHeader, setNoHeader] = useState(false);
  const [progressOnly, setProgressOnly] = useState(false);
  const [dark, setDark] = useState(false);
  const [objectType, setObjectType] = useState("");
  const [pk, setPk] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [events, setEvents] = useState<FormSubmittedMessage[]>([]);
  const multi = new Set(draft.sheets.filter((s, i) => i > 0 && s.multiplicity).flatMap((s) => s.fields.map((f) => f.id)));
  const fields = draft.sheets.flatMap((s) => s.fields).filter((f) => !NOT_PREFILLED.has(f.type) && !multi.has(f.id));
  const object = objectType && pk.trim() ? { objectType, pk: pk.trim() } : null;
  const filled = fields.filter((f) => (values[f.id] ?? "").trim() !== "");

  let path = formEmbedPath(id, { object, noHeader });
  if (progressOnly && !noHeader) path += "&progressOnly=true";
  if (dark) path += "&forceDarkMode=true";
  for (const f of filled) path += `&${enc(prefillParam(f))}=${enc(values[f.id].trim())}`;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}${path}`;
  const iframe = [
    `<iframe id="form-${id}" src="${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" title="${(draft.title || "Form").replace(/"/g, "&quot;")}" style="width:100%;border:0" height="600"></iframe>`,
    `<script>`,
    `  // the form reports its height and each submission (check the origin: ${origin || "this app"})`,
    `  window.addEventListener("message", (e) => {`,
    `    if (e.origin !== ${JSON.stringify(origin)}) return;`,
    `    const frame = document.getElementById(${JSON.stringify(`form-${id}`)});`,
    `    if (e.source !== frame.contentWindow) return;`,
    `    if (e.data.type === "${FORM_HEIGHT}") frame.height = e.data.height;`,
    `    if (e.data.type === "${FORM_SUBMITTED}") console.log("response", e.data.response_id);`,
    `  });`,
    `</script>`,
  ].join("\n");
  const props = [
    `formId=${JSON.stringify(id)}`,
    object ? `object={${JSON.stringify(object)}}` : "",
    filled.length ? `prefill={${JSON.stringify(Object.fromEntries(filled.map((f) => [f.id, values[f.id].trim()])))}}` : "",
    noHeader ? "noHeader" : "",
    progressOnly && !noHeader ? "progressOnly" : "",
    dark ? "forceDarkMode" : "",
    "onSubmitted={(m) => console.log(m.response_id)}",
  ].filter(Boolean);
  const react = `import { FormEmbed } from "@/components/forms/FormEmbed";\n\n<FormEmbed ${props.join(" ")} />`;
  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(what), () => setCopied(null));
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
  };
  const check = (label: string, on: boolean, set: (v: boolean) => void, disabled = false) => (
    <label className={`flex min-h-8 items-center gap-2 text-xs ${disabled ? "opacity-50" : ""}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
  const snippet = (what: string, label: string, text: string) => (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <button type="button" onClick={() => copy(what, text)} className={`${buttonClass.secondary} ml-auto`}>{copied === what ? "Copied" : "Copy"}</button>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-panel-2 p-2 font-mono text-[11px]">{text}</pre>
    </div>
  );

  return (
    <section className="space-y-3 rounded-xl border border-line bg-panel p-4 text-sm md:col-span-2" aria-label="Embed">
      <div>
        <div className="font-semibold">Embed</div>
        <p className="text-xs text-muted">
          The published form in another page (an object view, an app, another site the respondent is signed in from). The embedded page posts its height and each submission to the
          parent window. Prefilled values are checked like submitted ones; the ones that do not fit are left out and listed on the form.
        </p>
      </div>
      {!published && <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">Publish the form first: embedded forms show the published version.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-x-4">
            {check("No header", noHeader, setNoHeader)}
            {check("Progress bar only", progressOnly, setProgressOnly, noHeader)}
            {check("Dark mode", dark, setDark)}
          </div>
          <div className="text-xs font-medium">Object the form is embedded for (optional)</div>
          <div className="flex flex-wrap gap-2">
            <select value={objectType} onChange={(e) => setObjectType(e.target.value)} className={`${inputClass} min-w-0 flex-1 basis-40`} aria-label="Object type">
              <option value="">No object</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
            </select>
            <input value={pk} onChange={(e) => setPk(e.target.value)} disabled={!objectType} placeholder="primary key" aria-label="Primary key" className={`${inputClass} min-w-0 flex-1 basis-32 font-mono`} />
          </div>
          {objectType && (
            <p className="text-[11px] text-muted">
              {draft.destination.kind === "object_type" && draft.destination.object_type_id === objectType
                ? "The form writes this type: it starts with the object's values and submitting edits the object (Edit object form)."
                : "Object dropdowns of this type select the object; values can be {{property}} of the object."}
            </p>
          )}
          <div className="text-xs font-medium">Prefilled values</div>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {fields.map((f) => (
              <label key={f.id} className="flex min-w-0 items-center gap-2 text-xs">
                <span className="w-32 shrink-0 truncate" title={f.label || f.id}>{f.label || f.id}</span>
                <input value={values[f.id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))} placeholder={prefillParam(f)} className={`${inputClass} min-w-0 flex-1 font-mono text-xs`} />
              </label>
            ))}
            {fields.length === 0 && <p className="text-xs text-muted">No field takes a prefilled value.</p>}
          </div>
          <p className="text-[11px] text-muted">Several values: separate them with commas or repeat the parameter. A field&apos;s URL parameter is set in the builder.</p>
        </div>
        <div className="min-w-0 space-y-3">
          {snippet("url", "URL", url)}
          {snippet("iframe", "HTML (iframe)", iframe)}
          {snippet("react", "In this app (FormEmbed)", react)}
        </div>
      </div>
      <div className="space-y-2">
        <button type="button" disabled={!published} onClick={() => { setPreview((p) => !p); setEvents([]); }} className={buttonClass.secondary}>
          {preview ? "Hide preview" : "Preview embedded"}
        </button>
        {preview && published && (
          <div className="space-y-2">
            {/* the key reloads the iframe when the options change */}
            <FormEmbed key={path} formId={id} object={object} prefill={Object.fromEntries(filled.map((f) => [f.id, values[f.id].trim()]))} noHeader={noHeader} progressOnly={progressOnly} forceDarkMode={dark}
              maxHeight={900} title={`${draft.title || "Form"} (embedded)`} onSubmitted={(m) => setEvents((x) => [m, ...x].slice(0, 5))} />
            {events.map((m) => (
              <div key={m.response_id} className="rounded border border-ok/40 bg-ok/10 px-2 py-1 font-mono text-[11px] text-ok">
                {FORM_SUBMITTED}: response {m.response_id}, {m.rows} row{m.rows === 1 ? "" : "s"}{m.edited_object ? ", object edited" : ""}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
