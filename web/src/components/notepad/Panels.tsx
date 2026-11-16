"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { notepad, type NotepadDocument, type TemplateInput, type TemplateListItem, type Version } from "@/lib/notepad";
import { ontology, type ObjectType } from "@/lib/ontology";

const field = "w-full rounded border border-line-2 bg-panel px-2 py-1 text-xs text-soft outline-none focus:border-sky-500";
const small = "rounded border border-line px-2 py-1 text-xs hover:bg-panel-2 disabled:opacity-40";

/** Version history: user-created versions (or all, with autosaves), save a version, show changes, restore. */
export function VersionsPanel({ id, canEdit, onRestored }: { id: string; canEdit: boolean; onRestored: () => void }) {
  const [all, setAll] = useState(false);
  const [list, setList] = useState<Version[] | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<(Version & { changes: { op: string; text: string }[] }) | null>(null);
  const [name, setName] = useState("");
  const [endorsed, setEndorsed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    notepad.versions(id, all).then(setList, (e: Error) => setErr(e.message));
  }, [id, all, tick]);
  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wide text-muted">Version history</span>
        <select value={all ? "all" : "user"} onChange={(e) => setAll(e.target.value === "all")} className="rounded border border-line bg-panel px-1 py-0.5">
          <option value="user">Saved versions</option>
          <option value="all">All versions</option>
        </select>
      </div>
      {canEdit && (
        <div className="space-y-1 rounded border border-line p-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Version name" className={field} />
          <label className="flex items-center gap-1"><input type="checkbox" checked={endorsed} onChange={(e) => setEndorsed(e.target.checked)} />Endorsed</label>
          <button type="button" className={small} onClick={() => notepad.saveVersion(id, name, endorsed).then(() => { setName(""); setEndorsed(false); setTick((t) => t + 1); }, (e: Error) => setErr(e.message))}>
            + Save a new version
          </button>
          <p className="text-[11px] text-muted">Saves the last saved state of the document.</p>
        </div>
      )}
      {err && <p className="text-bad">{err}</p>}
      {list?.length === 0 && <p className="text-muted">{all ? "No versions yet: autosaves are made every 5 minutes while editing." : "No saved versions yet."}</p>}
      {list?.map((v) => (
        <button key={v.id} type="button" onClick={() => notepad.version(id, v.id).then(setOpen, (e: Error) => setErr(e.message))} className={`block w-full rounded border px-2 py-1.5 text-left hover:bg-panel-2 ${open?.id === v.id ? "border-ocean" : "border-line"}`}>
          <span className="flex items-center gap-1 font-medium">
            {v.endorsed && <Icon name="star" className="h-3 w-3 text-sand" />}
            {v.name || (v.auto ? "Autosave" : "Version")}
          </span>
          <span className="text-[11px] text-muted">{new Date(v.at).toLocaleString()} · {v.by?.name}</span>
        </button>
      ))}
      {open && (
        <div className="space-y-1 rounded border border-ocean/40 p-2">
          <p className="font-medium">Changes from this version to the current document</p>
          {open.changes.length === 0 && <p className="text-muted">No content changes.</p>}
          <ul className="max-h-64 space-y-0.5 overflow-y-auto">
            {open.changes.map((c, i) => (
              <li key={i} className={`truncate rounded px-1 ${c.op === "added" ? "bg-good/10 text-good" : "bg-bad/10 text-bad line-through"}`} title={c.text}>{c.op === "added" ? "+ " : "− "}{c.text}</li>
            ))}
          </ul>
          {canEdit && (
            <button type="button" className={small} onClick={() => notepad.restore(id, open.id).then(() => { setOpen(null); setTick((t) => t + 1); onRestored(); }, (e: Error) => setErr(e.message))}>
              <Icon name="restore" className="h-3 w-3" /> Restore this version
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Template inputs (with preview values) and published versions. */
export function TemplatePanel({ doc, canEdit, onChange, onPublish }: { doc: NotepadDocument; canEdit: boolean; onChange: (inputs: TemplateInput[]) => void; onPublish: (name: string) => void }) {
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [pubName, setPubName] = useState("");
  useEffect(() => {
    ontology.objectTypes().then(setTypes, () => undefined);
  }, []);
  const inputs = doc.template?.inputs ?? [];
  const set = (i: number, p: Partial<TemplateInput>) => onChange(inputs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const used = JSON.stringify(doc.blocks);
  return (
    <div className="space-y-2 p-3 text-xs">
      <span className="font-semibold uppercase tracking-wide text-muted">Template inputs</span>
      <p className="text-[11px] text-muted">Preview values are used while configuring the template only. Text can use {"{{input}}"}; widgets connect to inputs in their properties.</p>
      {inputs.map((inp, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-2">
          <div className="flex gap-1">
            <input value={inp.name} disabled={!canEdit} onChange={(e) => /^[A-Za-z0-9_]*$/.test(e.target.value) && set(i, { name: e.target.value })} className={`${field} font-mono`} aria-label="Input name" />
            {canEdit && (
              <button type="button" disabled={used.includes(`"${inp.name}"`) || used.includes(`{{${inp.name}}}`)} title="Inputs used by widgets cannot be deleted" onClick={() => onChange(inputs.filter((_, j) => j !== i))} className="text-muted hover:text-bad disabled:opacity-30" aria-label="Delete input">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <select value={inp.type} disabled={!canEdit} onChange={(e) => set(i, { type: e.target.value as TemplateInput["type"], preview: undefined })} className={field}>
            {["string", "number", "date", "timestamp", "object", "object_set"].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </select>
          {(inp.type === "object" || inp.type === "object_set") && (
            <select value={inp.object_type_id ?? ""} disabled={!canEdit} onChange={(e) => set(i, { object_type_id: e.target.value })} className={field}>
              <option value="">Object type…</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
            </select>
          )}
          <InputValue input={inp} value={inp.preview} onChange={(v) => set(i, { preview: v })} placeholder="Preview value" disabled={!canEdit} />
          <label className="flex items-center gap-1"><input type="checkbox" checked={inp.required !== false} disabled={!canEdit} onChange={(e) => set(i, { required: e.target.checked })} />Required when generating</label>
        </div>
      ))}
      {canEdit && <button type="button" className={small} onClick={() => onChange([...inputs, { name: `input${inputs.length + 1}`, type: "string" }])}>+ Add template input</button>}
      <div className="border-t border-line pt-2">
        <span className="font-semibold uppercase tracking-wide text-muted">Published versions</span>
        {(doc.template?.published ?? []).slice().reverse().map((p) => (
          <p key={p.version} className="mt-1"><b>v{p.version}</b> {p.name} <span className="text-muted">· {new Date(p.at).toLocaleString()} · {p.by?.name}</span></p>
        ))}
        {!doc.template?.published.length && <p className="mt-1 text-muted">Not published yet: generation uses published versions.</p>}
        {canEdit && (
          <div className="mt-2 flex gap-1">
            <input value={pubName} onChange={(e) => setPubName(e.target.value)} placeholder="Version name (optional)" className={field} />
            <button type="button" className={small} onClick={() => { onPublish(pubName); setPubName(""); }}>Publish</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A value for a template input: text, number, date, an object's key, or keys / "*" for an object set. */
export function InputValue({ input, value, onChange, placeholder, disabled }: { input: TemplateInput; value: unknown; onChange: (v: unknown) => void; placeholder?: string; disabled?: boolean }) {
  const [objects, setObjects] = useState<{ primary_key: string; title: string }[]>([]);
  useEffect(() => {
    if ((input.type === "object" || input.type === "object_set") && input.object_type_id) ontology.objects(input.object_type_id).then((r) => setObjects(r.objects.slice(0, 500)), () => undefined);
  }, [input.type, input.object_type_id]);
  if (input.type === "object")
    return (
      <select value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} className={field}>
        <option value="">{placeholder ?? "Object"}…</option>
        {objects.map((o) => <option key={o.primary_key} value={o.primary_key}>{o.title}</option>)}
      </select>
    );
  if (input.type === "object_set") {
    const all = value === "*";
    const sel = Array.isArray(value) ? value.map(String) : [];
    return (
      <div className="space-y-1">
        <label className="flex items-center gap-1"><input type="checkbox" checked={all} disabled={disabled} onChange={(e) => onChange(e.target.checked ? "*" : [])} />All objects of the type</label>
        {!all && (
          <select multiple value={sel} disabled={disabled} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))} className={`${field} h-20`}>
            {objects.map((o) => <option key={o.primary_key} value={o.primary_key}>{o.title}</option>)}
          </select>
        )}
      </div>
    );
  }
  return (
    <input
      type={input.type === "number" ? "number" : input.type === "date" ? "date" : input.type === "timestamp" ? "datetime-local" : "text"}
      value={String(value ?? "")}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      placeholder={placeholder}
      className={field}
    />
  );
}

/** View document links: objects and resources referenced by widgets. */
export function LinksPanel({ id, tick }: { id: string; tick: number }) {
  const [links, setLinks] = useState<Awaited<ReturnType<typeof notepad.links>> | null>(null);
  useEffect(() => {
    notepad.links(id).then(setLinks, () => setLinks(null));
  }, [id, tick]);
  return (
    <div className="space-y-2 p-3 text-xs">
      <span className="font-semibold uppercase tracking-wide text-muted">Document links</span>
      <p className="text-[11px] text-muted">Objects and resources the saved document&apos;s widgets reference. Objects list this document under linked documents.</p>
      {links?.objects.map((o) => (
        <Link key={`${o.object_type_id}:${o.pk}`} href={`/ontology/objects/${o.object_type_id}/${encodeURIComponent(o.pk)}`} className="flex items-center gap-1 text-ocean hover:underline">
          <Icon name="cube" className="h-3 w-3" />{o.title ?? `${o.pk} (no access)`}
        </Link>
      ))}
      {links?.resources.map((r) => (
        <p key={r.id} className="flex items-center gap-1"><Icon name="link" className="h-3 w-3 text-muted" />{r.kind}: {r.name ?? r.id}</p>
      ))}
      {links && !links.objects.length && !links.resources.length && <p className="text-muted">No links yet.</p>}
    </div>
  );
}

/** Generate a document from a template: inputs, version, name. */
export function GenerateDialog({ template, onClose }: { template: Pick<TemplateListItem, "id" | "name" | "versions" | "inputs">; onClose: () => void }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [name, setName] = useState(`${template.name.replace(/\.notepad$/i, "")} - ${new Date().toISOString().slice(0, 10)}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const latest = template.versions[template.versions.length - 1];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-md space-y-3 rounded-xl border border-line bg-panel p-5 text-sm shadow-2xl" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between">
          <div><h2 className="text-lg font-semibold">New from template</h2><p className="text-xs text-muted">{template.name.replace(/\.notepad$/i, "")}</p></div>
          <button type="button" onClick={onClose} className="text-muted" aria-label="Close"><Icon name="x" /></button>
        </div>
        {!latest ? (
          <p className="text-sand">This template has no published version yet.</p>
        ) : (
          <>
            <label className="block text-xs">Version
              <select value={version ?? ""} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : undefined)} className={field}>
                <option value="">Latest (v{latest.version})</option>
                {template.versions.map((v) => <option key={v.version} value={v.version}>v{v.version} {v.name}</option>)}
              </select>
            </label>
            {template.inputs.map((i) => (
              <label key={i.name} className="block text-xs">{i.name}{i.required !== false && " *"} <span className="text-muted">{i.type.replace("_", " ")}</span>
                <InputValue input={i} value={values[i.name]} onChange={(v) => setValues({ ...values, [i.name]: v })} />
              </label>
            ))}
            <label className="block text-xs">Document name<input value={name} onChange={(e) => setName(e.target.value)} className={field} /></label>
          </>
        )}
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={small}>Cancel</button>
          <button
            type="button"
            disabled={!latest || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await notepad.generate(template.id, { inputs: values, version, name });
                router.push(`/notepad/${r.item.id}`);
              } catch (e) {
                setErr((e as Error).message);
                setBusy(false);
              }
            }}
            className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Generating…" : "Generate document"}
          </button>
        </div>
      </div>
    </div>
  );
}
