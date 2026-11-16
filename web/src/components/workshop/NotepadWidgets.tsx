"use client";

import { useEffect, useMemo, useState } from "react";
import { DrivePicker, type PickedFolder } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { notepad, notepadItemId, notepadRid, textBlocks, type LinkedDocument, type TemplateListItem } from "@/lib/notepad";
import { ontology, type ObjectType } from "@/lib/ontology";
import { fillVars, resolveVar, sourceKey, type Module, type NotepadTemplateRef, type Widget, type WidgetConfig } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

// Notepad's Workshop widgets (palantir.com/docs/foundry/notepad/workshop-objects, -embed, -templates, -export):
// documents linked to the selected object, a document embedded in the module, a button creating documents from
// templates or a string variable, and a button exporting a document. Documents travel between them as a string
// variable holding the document's rid.

/** The document a widget points at: its variable's value (a rid or a Files item id), else the fixed document. */
function documentId(c: WidgetConfig, state: ModuleState): string | null {
  return notepadItemId(c.np_variable ? state.variables[c.np_variable] : c.np_document);
}

const location = (d: LinkedDocument) => (d.path ?? []).map((p) => p.name).join(" / ");
const title = (d: { name: string }) => d.name.replace(/\.notepad$/i, "");

/** Notepad: Linked documents — the documents whose widgets reference the selected object. Choosing one writes its
 * rid to the Active Notepad variable. */
export function NotepadLinkedWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const typeId = c.np_object_type_id;
  const pk = typeId ? state.selection[sourceKey({ kind: "object_type", id: typeId })] : undefined;
  const key = typeId && pk ? `${typeId}:${pk}:${state.version}` : "";
  const [res, setRes] = useState<{ key: string; docs?: LinkedDocument[]; error?: string } | null>(null);
  useEffect(() => {
    if (!typeId || !pk) return;
    let stale = false;
    notepad.linkedDocuments(typeId, pk).then(
      (docs) => !stale && setRes({ key, docs }),
      (e: Error) => !stale && setRes({ key, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [typeId, pk, key]);
  const fields = c.np_fields ?? ["author", "updated"];
  const sort = c.np_sort ?? "updated";
  const docs = useMemo(() => {
    const list = [...((res?.key === key && res.docs) || [])];
    const by = (d: LinkedDocument) => (sort === "name" ? title(d).toLowerCase() : sort === "author" ? (d.author ?? "").toLowerCase() : d.updated_at);
    list.sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0));
    // newest first unless ascending is chosen; names and authors A to Z unless descending
    const asc = c.np_sort_asc ?? sort !== "updated";
    return asc ? list : list.reverse();
  }, [res, key, sort, c.np_sort_asc]);
  if (!typeId) return <div className="p-3 text-xs text-muted">Choose the object type whose documents are listed</div>;
  if (!pk) return <div className="p-3 text-xs text-muted">Select an object to see the Notepad documents that link to it</div>;
  if (res?.key === key && res.error) return <div className="p-3 text-xs text-bad">{res.error}</div>;
  if (res?.key !== key) return <div className="p-3 text-xs text-muted">Loading…</div>;
  if (!docs.length) return <div className="p-3 text-xs text-muted">No Notepad document links to this object</div>;
  const active = notepadItemId(c.np_variable ? state.variables[c.np_variable] : null);
  const pick = (d: LinkedDocument) => c.np_variable && state.setVariable(c.np_variable, d.rid);
  const meta = (d: LinkedDocument) =>
    [fields.includes("author") && d.author, fields.includes("updated") && when(d.updated_at), fields.includes("location") && location(d)].filter(Boolean) as string[];
  const open = (d: LinkedDocument) => (
    <a href={`/notepad/${d.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-muted hover:text-ocean" aria-label={`Open ${title(d)} in Notepad`}>
      <Icon name="external" className="h-3.5 w-3.5" />
    </a>
  );
  const display = c.np_display ?? "list";
  if (display === "table") {
    return (
      <div className="h-full overflow-auto" data-notepad-linked>
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="px-2 py-1 text-left font-normal">Document</th>
              {fields.map((f) => <th key={f} className="px-2 py-1 text-left font-normal capitalize">{f === "updated" ? "Last updated" : f}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} onClick={() => pick(d)} className={`cursor-pointer border-t border-line ${active === d.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`} data-notepad-doc={d.id}>
                <td className="px-2 py-1.5">{title(d)}{d.template ? " · template" : ""}</td>
                {fields.map((f) => <td key={f} className="px-2 py-1.5 text-muted">{f === "author" ? (d.author ?? "—") : f === "updated" ? when(d.updated_at) : location(d)}</td>)}
                <td className="px-2 py-1.5 text-right">{open(d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className={`h-full overflow-auto p-2 ${display === "cards" ? "grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2" : "space-y-1"}`} data-notepad-linked>
      {docs.map((d) => (
        <div key={d.id} role="button" tabIndex={0} onClick={() => pick(d)} onKeyDown={(e) => e.key === "Enter" && pick(d)} data-notepad-doc={d.id}
          className={`cursor-pointer rounded border text-xs ${display === "cards" ? "p-3" : "flex items-center gap-2 px-2 py-1.5"} ${active === d.id ? "border-ocean bg-ocean/15" : "border-line hover:bg-panel-2"}`}>
          <Icon name="doc" className={`shrink-0 text-ocean ${display === "cards" ? "mb-2 h-5 w-5" : "h-3.5 w-3.5"}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-white">{title(d)}</div>
            {meta(d).length > 0 && <div className="truncate text-[11px] text-muted">{meta(d).join(" · ")}</div>}
          </div>
          {display !== "cards" && open(d)}
        </div>
      ))}
    </div>
  );
}

/** Notepad: Embedded document — the document in embed mode, read-only or (Allow editing) with a reduced editor. */
export function NotepadEmbedWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const id = documentId(c, state);
  if (!id) return <div className="p-3 text-xs text-muted">{c.np_variable ? "No document selected" : "Choose the variable holding the document's rid"}</div>;
  const edit = !!c.np_allow_edit && !state.readOnly;
  return (
    <iframe key={`${id}:${edit}`} src={`/notepad/${encodeURIComponent(id)}?embed=1${edit ? "&edit=1" : ""}`} title={widget.title || "Notepad document"} data-notepad-embed={id}
      className={`h-full w-full border-0 ${editing ? "pointer-events-none" : ""}`} />
  );
}

/** Notepad: Export button — the document downloaded as PDF or DOCX. */
export function NotepadExportWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const id = documentId(c, state);
  const format = c.np_format ?? "pdf";
  const name = fillVars(c.np_filename ?? "", state.variables).trim();
  return (
    <div className="flex h-full items-center p-2">
      {id && !editing ? (
        <a href={notepad.exportUrl(id, format, name || undefined)} className={buttonClass.secondary} data-notepad-export={format}>
          <Icon name="download" className="h-3.5 w-3.5" /> {c.np_button_text || "Export"}
        </a>
      ) : (
        <button type="button" disabled className={buttonClass.secondary} title={id ? undefined : "No document to export"}>
          <Icon name="download" className="h-3.5 w-3.5" /> {c.np_button_text || "Export"}
        </button>
      )}
    </div>
  );
}

type Created = { id: string; name: string };

/** Notepad: New Notepad button — a document from a template (its inputs from module variables) or from a string
 * variable; then the Created document variable is set, the PDF downloads or the document opens, and the events run. */
export function NotepadNewWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const mode = c.np_mode ?? "template";
  const refs = (c.np_templates ?? []).filter((r) => r.item_id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Created | null>(null);
  const [menu, setMenu] = useState(false);
  // "Allow users to choose save location": the name and folder asked before generating
  const [ask, setAsk] = useState<{ ref: NotepadTemplateRef | null; name: string; folder: PickedFolder | null; picking: boolean } | null>(null);
  const label = c.np_button_text || widget.title || "New Notepad";
  const defaultName = () => fillVars(c.np_save_name ?? "", state.variables).trim();

  const create = async (ref: NotepadTemplateRef | null, name: string, folder: string | null) => {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      let item: { id: string; name: string };
      if (ref) {
        const inputs: Record<string, unknown> = {};
        for (const [input, variable] of Object.entries(ref.inputs ?? {})) {
          if (!variable) continue;
          const v = state.variables[variable];
          // a single-object input linked to an object set variable takes its one object
          inputs[input] = ref.input_types?.[input] === "object" && Array.isArray(v) ? v[0] : v;
        }
        item = (await notepad.generate(ref.item_id, { inputs, version: ref.version, name: name || undefined, parent_id: folder })).item;
      } else {
        const text = String((c.np_string_variable ? state.variables[c.np_string_variable] : "") ?? "");
        if (!text.trim()) throw new Error("the string variable is empty: there is nothing to write into the document");
        const blocks = textBlocks(text, c.np_string_format ?? "markdown");
        item = (await notepad.create({ name: name || `Notepad ${new Date().toISOString().slice(0, 10)}`, parent_id: folder, document: { schema_version: 1, blocks } })).item;
      }
      if (c.np_created_variable) state.setVariable(c.np_created_variable, notepadRid(item.id));
      setDone({ id: item.id, name: item.name.replace(/\.notepad$/i, "") });
      if (c.np_export_pdf) {
        const a = document.createElement("a");
        a.href = notepad.exportUrl(item.id, "pdf", name || undefined);
        a.click();
      }
      if (c.np_open_new_tab) window.open(`/notepad/${item.id}`, "_blank", "noopener");
      await state.runEvents?.(c.np_events ?? []);
      state.bump();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = (ref: NotepadTemplateRef | null) => {
    setMenu(false);
    if (c.np_choose_location) return setAsk({ ref, name: defaultName(), folder: null, picking: false });
    const folder = resolveVar(c.np_save_folder, state.variables);
    void create(ref, defaultName(), typeof folder === "string" && folder ? folder : null);
  };
  const ready = mode === "string" ? !!c.np_string_variable : refs.length > 0;
  return (
    <div className="relative flex h-full flex-wrap items-center gap-2 p-2" data-notepad-new>
      <button type="button" disabled={busy || editing || !ready || !!state.readOnly} className={buttonClass.primary}
        title={!ready ? (mode === "string" ? "Choose the string variable" : "Add a document template") : state.readOnly ? "This module is read-only" : undefined}
        onClick={() => (mode === "string" ? start(null) : refs.length === 1 ? start(refs[0]) : setMenu((m) => !m))}>
        <Icon name="plus" className="h-3.5 w-3.5" /> {busy ? "Creating…" : label}
      </button>
      {menu && (
        <div className="absolute left-2 top-full z-30 mt-1 min-w-48 rounded-lg border border-line bg-panel p-1 shadow-xl">
          {refs.map((r, i) => (
            <button key={`${r.item_id}:${i}`} type="button" onClick={() => start(r)} className="block w-full rounded px-3 py-1.5 text-left text-xs text-soft hover:bg-panel-2 hover:text-white">
              {r.label || r.name || label}
            </button>
          ))}
        </div>
      )}
      {done && !err && (
        <a href={`/notepad/${done.id}`} target="_blank" rel="noreferrer" className="truncate text-xs text-ocean hover:underline" data-notepad-created={done.id}>
          {done.name}
        </a>
      )}
      {err && <span className="text-xs text-bad" title={err}>{err.slice(0, 160)}</span>}
      {ask && !ask.picking && (
        <Modal title={label} icon="doc" onClose={() => setAsk(null)}>
          <div className="space-y-3 text-sm">
            <Field label="Document name">
              <input value={ask.name} onChange={(e) => setAsk({ ...ask, name: e.target.value })} className={inputClass} maxLength={240} autoFocus />
            </Field>
            <Field label="Save location">
              <button type="button" onClick={() => setAsk({ ...ask, picking: true })} className={buttonClass.secondary}>
                <Icon name="folder" className="h-3.5 w-3.5" /> {ask.folder ? ask.folder.name : ask.ref ? "The template's folder" : "The default folder"}
              </button>
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAsk(null)} className={buttonClass.ghost}>Cancel</button>
              <button type="button" className={buttonClass.primary}
                onClick={() => {
                  const a = ask;
                  setAsk(null);
                  void create(a.ref, a.name.trim(), a.folder?.id ?? null);
                }}>
                Create
              </button>
            </div>
          </div>
        </Modal>
      )}
      {ask?.picking && (
        <DrivePicker title="Save the document in" folder={{ action: "Save here", onPick: (f) => setAsk({ ...ask, folder: f, picking: false }) }} onClose={() => setAsk({ ...ask, picking: false })} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

const NOTEPAD_TYPES = new Set(["notepad_linked", "notepad_embed", "notepad_new", "notepad_export"]);
const INPUT_VARIABLE_TYPES: Record<string, string[]> = {
  string: ["string"], number: ["number"], date: ["date", "string"], timestamp: ["timestamp", "string"], object: ["object", "object_set", "string"], object_set: ["object_set", "array"],
};

export function NotepadWidgetConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const t = widget.type;
  const on = NOTEPAD_TYPES.has(t);
  const vars = mod.variables ?? [];
  const strings = vars.filter((v) => v.type === "string");
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [templates, setTemplates] = useState<TemplateListItem[] | null>(null);
  const [pickFolder, setPickFolder] = useState(false);
  useEffect(() => {
    if (t === "notepad_linked") ontology.objectTypes().then(setTypes, () => setTypes([]));
    if (t === "notepad_new") notepad.templates().then(setTemplates, () => setTemplates([]));
  }, [t]);
  if (!on) return null;
  const documentSource = (
    <>
      <Field label="Document (a string variable holding its rid)">
        <select value={c.np_variable ?? ""} onChange={(e) => set({ np_variable: e.target.value || undefined })} className={inputClass} data-np-variable>
          <option value="">A fixed document</option>
          {strings.map((v) => <option key={v.name}>{v.name}</option>)}
        </select>
      </Field>
      {!c.np_variable && (
        <Field label="Document rid or Files item id">
          <input value={c.np_document ?? ""} onChange={(e) => set({ np_document: e.target.value.trim() || undefined })} placeholder="ri.notepad.main.notepad.…" className={`${inputClass} font-mono text-xs`} />
        </Field>
      )}
    </>
  );
  const refs = c.np_templates ?? [];
  const setRef = (i: number, patch: Partial<NotepadTemplateRef>) => set({ np_templates: refs.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const fields = c.np_fields ?? ["author", "updated"];
  return (
    <div className="space-y-3 text-xs" data-notepad-config>
      {t === "notepad_linked" && (
        <>
          <Field label="Object type (documents linking to its selected object)">
            <select value={c.np_object_type_id ?? ""} onChange={(e) => set({ np_object_type_id: e.target.value || undefined })} className={inputClass}>
              <option value="">Choose…</option>
              {(types ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name || o.api_name}</option>)}
            </select>
          </Field>
          <Field label="Display">
            <select value={c.np_display ?? "list"} onChange={(e) => set({ np_display: e.target.value as "list" })} className={inputClass}>
              <option value="list">List</option>
              <option value="cards">Cards</option>
              <option value="table">Table</option>
            </select>
          </Field>
          <Field label="Fields shown">
            <div className="flex flex-wrap gap-3">
              {(["author", "updated", "location"] as const).map((f) => (
                <label key={f} className="flex items-center gap-1.5 capitalize">
                  <input type="checkbox" checked={fields.includes(f)} onChange={(e) => set({ np_fields: (["author", "updated", "location"] as const).filter((x) => (x === f ? e.target.checked : fields.includes(x))) })} />
                  {f === "updated" ? "Last updated" : f}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Default sort">
            <div className="flex gap-1">
              <select value={c.np_sort ?? "updated"} onChange={(e) => set({ np_sort: e.target.value as "updated", np_sort_asc: undefined })} className={inputClass}>
                <option value="updated">Last updated</option>
                <option value="name">Name</option>
                <option value="author">Author</option>
              </select>
              <select value={String(c.np_sort_asc ?? (c.np_sort ?? "updated") !== "updated")} onChange={(e) => set({ np_sort_asc: e.target.value === "true" })} className={inputClass}>
                <option value="true">Ascending</option>
                <option value="false">Descending</option>
              </select>
            </div>
          </Field>
          <Field label="Active Notepad (output: the selected document's rid)">
            <select value={c.np_variable ?? ""} onChange={(e) => set({ np_variable: e.target.value || undefined })} className={inputClass} data-np-variable>
              <option value="">None</option>
              {strings.map((v) => <option key={v.name}>{v.name}</option>)}
            </select>
          </Field>
        </>
      )}
      {t === "notepad_embed" && (
        <>
          {documentSource}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.np_allow_edit} onChange={(e) => set({ np_allow_edit: e.target.checked || undefined })} /> Allow editing (a reduced editor; Notepad has every operation)
          </label>
        </>
      )}
      {t === "notepad_export" && (
        <>
          {documentSource}
          <Field label="Output file name" hint="Empty: the document's name. {{variables}} allowed.">
            <input value={c.np_filename ?? ""} onChange={(e) => set({ np_filename: e.target.value || undefined })} className={inputClass} />
          </Field>
          <Field label="Export format">
            <select value={c.np_format ?? "pdf"} onChange={(e) => set({ np_format: e.target.value as "pdf" })} className={inputClass}>
              <option value="pdf">PDF</option>
              <option value="docx">DOCX</option>
            </select>
          </Field>
          <Field label="Button text">
            <input value={c.np_button_text ?? ""} onChange={(e) => set({ np_button_text: e.target.value || undefined })} placeholder="Export" className={inputClass} />
          </Field>
        </>
      )}
      {t === "notepad_new" && (
        <>
          <Field label="Button text">
            <input value={c.np_button_text ?? ""} onChange={(e) => set({ np_button_text: e.target.value || undefined })} placeholder="New Notepad" className={inputClass} />
          </Field>
          <Field label="Create from">
            <select value={c.np_mode ?? "template"} onChange={(e) => set({ np_mode: e.target.value as "template" })} className={inputClass}>
              <option value="template">Template(s)</option>
              <option value="string">String</option>
            </select>
          </Field>
          {(c.np_mode ?? "template") === "template" ? (
            <div className="space-y-2">
              <div className="font-semibold uppercase tracking-wide text-muted">Document templates</div>
              {refs.map((r, i) => {
                const tpl = (templates ?? []).find((x) => x.id === r.item_id);
                return (
                  <div key={i} className="space-y-1.5 rounded border border-line p-2" data-np-template={r.item_id}>
                    <div className="flex gap-1">
                      <select value={r.item_id} className={inputClass}
                        onChange={(e) => {
                          const next = (templates ?? []).find((x) => x.id === e.target.value);
                          setRef(i, { item_id: e.target.value, name: next ? title(next) : undefined, version: next?.versions.at(-1)?.version, inputs: {}, input_types: Object.fromEntries((next?.inputs ?? []).map((x) => [x.name, x.type])) });
                        }}>
                        <option value="">Choose a template…</option>
                        {(templates ?? []).map((x) => <option key={x.id} value={x.id}>{title(x)}</option>)}
                        {r.item_id && !tpl && <option value={r.item_id}>{r.name ?? r.item_id}</option>}
                      </select>
                      <button type="button" onClick={() => set({ np_templates: refs.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad" aria-label="Remove the template">✕</button>
                    </div>
                    {tpl && (
                      <>
                        {tpl.versions.length ? (
                          <Field label="Template version">
                            <select value={r.version ?? ""} onChange={(e) => setRef(i, { version: e.target.value ? Number(e.target.value) : undefined })} className={inputClass}>
                              <option value="">Latest published</option>
                              {tpl.versions.map((v) => <option key={v.version} value={v.version}>{v.version}{v.name ? ` · ${v.name}` : ""}</option>)}
                            </select>
                          </Field>
                        ) : (
                          <p className="text-warn">No published version: <a href={`/notepad/${tpl.id}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">open the template</a> and publish one.</p>
                        )}
                        <Field label="Menu display name">
                          <input value={r.label ?? ""} onChange={(e) => setRef(i, { label: e.target.value || undefined })} placeholder={title(tpl)} className={inputClass} />
                        </Field>
                        {tpl.inputs.length > 0 && <div className="text-muted">Template inputs</div>}
                        {tpl.inputs.map((inp) => (
                          <label key={inp.name} className="flex items-center gap-2">
                            <span className="w-28 shrink-0 truncate text-soft" title={`${inp.name} (${inp.type})`}>{inp.name} <span className="text-muted">{inp.type.replace("_", " ")}</span></span>
                            <select value={r.inputs?.[inp.name] ?? ""} className={inputClass}
                              onChange={(e) => setRef(i, { inputs: { ...(r.inputs ?? {}), [inp.name]: e.target.value }, input_types: { ...(r.input_types ?? {}), [inp.name]: inp.type } })}>
                              <option value="">{inp.required === false ? "Not set" : "Choose a variable…"}</option>
                              {vars.filter((v) => (INPUT_VARIABLE_TYPES[inp.type] ?? []).includes(v.type)).map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type.replace("_", " ")})</option>)}
                            </select>
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
              <button type="button" onClick={() => set({ np_templates: [...refs, { item_id: "" }] })} className="text-ocean">+ Select a template</button>
            </div>
          ) : (
            <>
              <Field label="String variable">
                <select value={c.np_string_variable ?? ""} onChange={(e) => set({ np_string_variable: e.target.value || undefined })} className={inputClass}>
                  <option value="">Choose…</option>
                  {strings.map((v) => <option key={v.name}>{v.name}</option>)}
                </select>
              </Field>
              <Field label="Parse the value as">
                <select value={c.np_string_format ?? "markdown"} onChange={(e) => set({ np_string_format: e.target.value as "markdown" })} className={inputClass}>
                  <option value="markdown">Markdown</option>
                  <option value="plain">Plain text</option>
                </select>
              </Field>
            </>
          )}
          <div className="font-semibold uppercase tracking-wide text-muted">Save options</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.np_choose_location} onChange={(e) => set({ np_choose_location: e.target.checked || undefined })} /> Allow users to choose save location
          </label>
          <Field label="Default save name" hint="{{variables}} allowed; also the PDF's file name.">
            <input value={c.np_save_name ?? ""} onChange={(e) => set({ np_save_name: e.target.value || undefined })} className={inputClass} />
          </Field>
          {!c.np_choose_location && (
            <Field label="Default save location" hint="A folder, or a string variable holding a folder id. Empty: the template's folder (the default folder for a string).">
              <div className="flex gap-1">
                <select value={c.np_save_folder?.startsWith("$var:") ? c.np_save_folder : c.np_save_folder ? "__folder" : ""} className={inputClass}
                  onChange={(e) => (e.target.value === "__folder" ? setPickFolder(true) : set({ np_save_folder: e.target.value || undefined }))}>
                  <option value="">Not set</option>
                  <option value="__folder">{c.np_save_folder && !c.np_save_folder.startsWith("$var:") ? `Folder ${c.np_save_folder}` : "Choose a folder…"}</option>
                  {strings.map((v) => <option key={v.name} value={`$var:${v.name}`}>Variable {v.name}</option>)}
                </select>
              </div>
            </Field>
          )}
          <div className="font-semibold uppercase tracking-wide text-muted">On click</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.np_export_pdf} onChange={(e) => set({ np_export_pdf: e.target.checked || undefined })} /> Export generated Notepad as PDF (the document is saved too)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.np_open_new_tab} onChange={(e) => set({ np_open_new_tab: e.target.checked || undefined })} /> Open generated Notepad in new tab
          </label>
          <Field label="Created document (output: its rid)">
            <select value={c.np_created_variable ?? ""} onChange={(e) => set({ np_created_variable: e.target.value || undefined })} className={inputClass}>
              <option value="">None</option>
              {strings.map((v) => <option key={v.name}>{v.name}</option>)}
            </select>
          </Field>
          <EventsEditor events={c.np_events ?? []} mod={mod} onChange={(ev) => set({ np_events: ev.length ? ev : undefined })} label="After the document is created" />
        </>
      )}
      {pickFolder && (
        <DrivePicker title="Default save location" onClose={() => setPickFolder(false)}
          folder={{ action: "Save documents here", onPick: (f) => { set({ np_save_folder: f.id ?? undefined }); setPickFolder(false); } }} />
      )}
    </div>
  );
}
