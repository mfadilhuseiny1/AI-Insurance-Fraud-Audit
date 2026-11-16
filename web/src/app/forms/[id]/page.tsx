"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { FormBuilder } from "@/components/forms/FormBuilder";
import { FormEmbedPanel } from "@/components/forms/FormEmbedPanel";
import { FormFill } from "@/components/forms/FormFill";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { forms, type Collaborator, type FormDefinition, type FormResponse, type FormView, type RespondentLink } from "@/lib/forms";
import { fusion, type LocatedItem } from "@/lib/fusion";
import { ontology, type ObjectType } from "@/lib/ontology";

type Tab = "builder" | "code" | "preview" | "responses" | "settings";

export default function FormEditorPage() {
  return (
    <Suspense>
      <Editor />
    </Suspense>
  );
}

function Editor() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const [view, setView] = useState<FormView | null>(null);
  const [draft, setDraft] = useState<FormDefinition | null>(null);
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "builder");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const load = useCallback(() => forms.get(id).then((v) => (setView(v), setDraft(v.form), setSaved(true)), (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error && !view) return <ApiError message={error} />;
  if (!view || !draft) return <Loading />;
  const save = async () => {
    setError(null);
    try {
      const v = await forms.save(id, { title: draft.title, description: draft.description, sheets: draft.sheets, destination: draft.destination, settings: draft.settings });
      setView(v);
      setSaved(true);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const change = (d: FormDefinition) => {
    setDraft(d);
    setSaved(false);
  };
  return (
    <div className="flex-1 overflow-y-auto">
      <AppHeader app="Forms (Sunset)" icon="doc" href="/forms" crumbs={[{ label: view.form.title }]}>
        <Link href={`/forms/${id}/fill`} className={buttonClass.ghost}>
          <Icon name="external" className="h-3.5 w-3.5" /> Fill
        </Link>
        <span className="hidden text-xs text-muted sm:inline">{view.form.published ? `Published version ${view.form.published}` : "Not published"}</span>
        {view.can_edit && (
          <>
            <button type="button" disabled={saved} onClick={save} className={buttonClass.secondary}>
              {saved ? "Saved" : "Save draft"}
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!saved && !(await save())) return;
                const name = await promptDialog("Name of the version", `Version ${view.form.versions.length + 1}`);
                if (name === null) return;
                try {
                  setView(await forms.publish(id, name));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              Publish
            </button>
          </>
        )}
      </AppHeader>
      <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-6">
        {/* phones: the tabs scroll sideways instead of widening the page */}
        <div className="-mx-3 flex gap-1 overflow-x-auto border-b border-line px-3 text-sm sm:mx-0 sm:px-0">
          {(["builder", "code", "preview", "responses", "settings"] as Tab[]).map((t) => (
            <button key={t} type="button" onClick={async () => { if (t === "preview" && !saved) await save(); setTab(t); }}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 capitalize ${tab === t ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
              {t === "responses" ? `Responses (${view.responses})` : t === "code" ? "Code editor" : t}
            </button>
          ))}
        </div>
        <ErrorBox message={error} />
        {tab === "builder" && (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={draft.title} onChange={(e) => change({ ...draft, title: e.target.value })} className={inputClass} aria-label="Title" />
              <input value={draft.description} onChange={(e) => change({ ...draft, description: e.target.value })} placeholder="Description" className={inputClass} />
            </div>
            <FormBuilder defn={draft} onChange={change} />
          </>
        )}
        {tab === "preview" && (
          <div className="mx-auto max-w-2xl rounded-xl border border-line bg-panel p-3 sm:p-6">
            <p className="mb-4 text-xs text-muted">Preview of the saved draft (submitting needs a published version).</p>
            <FormFill formId={id} draft />
          </div>
        )}
        {tab === "code" && <CodeEditorTab id={id} dirty={!saved} save={save} onSaved={() => void load()} />}
        {tab === "responses" && <Responses id={id} view={view} />}
        {tab === "settings" && <Settings id={id} view={view} draft={draft} onChange={change} />}
      </div>
    </div>
  );
}

function Responses({ id, view }: { id: string; view: FormView }) {
  const [rows, setRows] = useState<FormResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ r: FormResponse; row: number; text: string } | null>(null);
  useEffect(() => {
    forms.responses(id).then(setRows, (e: Error) => setError(e.message));
  }, [id]);
  const cols = [...new Set((rows ?? []).flatMap((r) => r.rows.flatMap((x) => Object.keys(x))))];
  return (
    <div className="space-y-3">
      <ErrorBox message={error} />
      <p className="text-xs text-muted">
        Every submission ({view.responses}); editing one writes the change to the destination too
        {view.form.destination.kind === "fusion" && view.form.destination.document_id && (
          <> — or open the <Link href={`/fusion/${view.form.destination.document_id}`} className="text-ocean hover:underline">results spreadsheet</Link></>
        )}
        .
      </p>
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-xs">
          <thead className="border-b border-line text-left text-muted">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">By</th>
              {cols.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(rows ?? []).flatMap((r) =>
              r.rows.map((x, i) => (
                <tr key={`${r.id}-${i}`}>
                  <td className="px-3 py-1.5 text-muted">{when(r.at)}</td>
                  <td className="px-3 py-1.5">{r.by}</td>
                  {cols.map((c) => <td key={c} className="max-w-[200px] truncate px-3 py-1.5">{typeof x[c] === "object" && x[c] !== null ? JSON.stringify(x[c]) : String(x[c] ?? "")}</td>)}
                  <td className="px-3 py-1.5">
                    {view.can_edit && (
                      <button type="button" onClick={() => setEditing({ r, row: i, text: JSON.stringify(x, null, 1) })} className="text-ocean hover:underline">Open row</button>
                    )}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
        {rows?.length === 0 && <p className="p-6 text-center text-sm text-muted">No responses yet.</p>}
      </div>
      {editing && (
        <div className="space-y-2 rounded-xl border border-ocean/40 bg-panel p-4 text-xs">
          <div className="font-medium">Edit response {editing.r.id} · entry {editing.row + 1}</div>
          <textarea rows={10} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} className={`${inputClass} font-mono text-xs`} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  await forms.editResponse(id, editing.r.id, editing.row, JSON.parse(editing.text) as Record<string, unknown>);
                  setEditing(null);
                  setRows(await forms.responses(id));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              Save changes
            </button>
            <button type="button" onClick={() => setEditing(null)} className={buttonClass.ghost}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Settings({ id, view, draft, onChange }: { id: string; view: FormView; draft: FormDefinition; onChange: (d: FormDefinition) => void }) {
  const [sheets, setSheets] = useState<LocatedItem[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [subscribed, setSubscribed] = useState(false);
  const d = draft.destination;
  useEffect(() => {
    fusion.list().then(setSheets, () => setSheets([]));
    ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, []);
  useEffect(() => {
    if (d.kind === "fusion" && d.document_id) fusion.get(d.document_id).then((v) => setTables(v.document.sheets.flatMap((s) => s.tables.map((t) => t.name))), () => setTables([]));
  }, [d.kind, d.document_id]);
  const setDest = (p: Partial<FormDefinition["destination"]>) => onChange({ ...draft, destination: { ...d, ...p } });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-2 rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="font-semibold">Response destination</div>
        <select value={d.kind} onChange={(e) => setDest({ kind: e.target.value as typeof d.kind })} className={inputClass}>
          <option value="none">None (responses log only)</option>
          <option value="fusion">A Fusion table region</option>
          <option value="object_type">An Nexus object type</option>
        </select>
        {d.kind === "fusion" && (
          <>
            <select value={d.document_id ?? ""} onChange={(e) => setDest({ document_id: e.target.value, table: undefined })} className={inputClass}>
              <option value="">Spreadsheet…</option>
              {sheets.map((s) => <option key={s.id} value={s.id}>{s.name.replace(/\.fusion$/, "")}</option>)}
            </select>
            <select value={d.table ?? ""} onChange={(e) => setDest({ table: e.target.value })} className={inputClass}>
              <option value="">Table region…</option>
              {tables.map((t) => <option key={t}>{t}</option>)}
            </select>
            <p className="text-xs text-muted">Columns are matched to the table&apos;s header by each field&apos;s column name.</p>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!d.key_first_column} onChange={(e) => setDest({ key_first_column: e.target.checked })} /> Update the row whose first column matches (else append)</label>
          </>
        )}
        {d.kind === "object_type" && (
          <>
            <select value={d.object_type_id ?? ""} onChange={(e) => setDest({ object_type_id: e.target.value })} className={inputClass}>
              <option value="">Object type…</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
            </select>
            <p className="text-xs text-muted">Fields write the properties named by their column (or ID); a generated primary key field gives each object its key.</p>
          </>
        )}
      </section>
      <section className="space-y-2 rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="font-semibold">Settings</div>
        <label className="block text-xs">Submit button label<input value={draft.settings.submit_label ?? "Submit"} onChange={(e) => onChange({ ...draft, settings: { ...draft.settings, submit_label: e.target.value } })} className={inputClass} /></label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={subscribed} onChange={async (e) => { await forms.subscribe(id, e.target.checked); setSubscribed(e.target.checked); }} /> Notify me of new responses
        </label>
        <label className="block text-xs">Confirmation message (after a submission)
          <textarea rows={2} value={draft.settings.confirmation ?? ""} placeholder="Submitted." onChange={(e) => onChange({ ...draft, settings: { ...draft.settings, confirmation: e.target.value || undefined } })} className={inputClass} />
        </label>
        {view.can_edit && <RespondentLinks id={id} />}
        {view.can_edit && <Sharing id={id} />}
        <div className="pt-2 font-semibold">Versions</div>
        <ul className="space-y-1 text-xs">
          {[...view.form.versions].reverse().map((v) => (
            <li key={v.n} className="flex items-center gap-2">
              <span className="font-medium">{v.name}</span>
              {v.n === view.form.published && <span className="rounded bg-ok/15 px-1.5 text-ok">published</span>}
              <span className="text-muted">{v.by} · {when(v.at)}</span>
            </li>
          ))}
          {view.form.versions.length === 0 && <li className="text-muted">Not published yet.</li>}
        </ul>
      </section>
      <FormEmbedPanel id={id} draft={draft} types={types} published={view.form.published !== null} />
    </div>
  );
}


/** Respondent links: signed-in users who have one can fill the published form without access to its Project. */
function RespondentLinks({ id }: { id: string }) {
  const [links, setLinks] = useState<RespondentLink[]>([]);
  const [days, setDays] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    forms.links(id).then(setLinks, (e: Error) => setErr(e.message));
  }, [id]);
  const url = (t: string) => `${window.location.origin}/forms/${id}/fill?link=${t}`;
  return (
    <div className="space-y-1 pt-2 text-xs">
      <div className="font-semibold text-sm">Respondent links</div>
      <p className="text-muted">Anyone signed in who has a link can fill the published form, even without access to its Project (responses are written as them). Links do not open marked forms.</p>
      {links.map((l) => (
        <div key={l.token} className="flex items-center gap-2">
          <button type="button" onClick={() => void navigator.clipboard?.writeText(url(l.token))} className="truncate text-left font-mono text-ocean hover:underline" title="Copy the link">
            …/fill?link={l.token.slice(0, 8)}…
          </button>
          <span className="text-muted">{l.label || l.by} · {l.expires_at ? `expires ${when(l.expires_at)}` : "no expiry"}</span>
          <button type="button" onClick={() => forms.deleteLink(id, l.token).then(() => setLinks((x) => x.filter((y) => y.token !== l.token)), (e: Error) => setErr(e.message))} className="ml-auto text-muted hover:text-bad">
            Turn off
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <select value={days} onChange={(e) => setDays(e.target.value)} className={`${inputClass} w-36`} aria-label="Expiry">
          <option value="">No expiry</option>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}
        </select>
        <button
          type="button"
          onClick={() => forms.createLink(id, { expires_days: days ? Number(days) : null }).then((l) => (setLinks((x) => [...x, l]), void navigator.clipboard?.writeText(url(l.token))), (e: Error) => setErr(e.message))}
          className={buttonClass.secondary}
        >
          New link (copied)
        </button>
      </div>
      {err && <p className="text-bad">{err}</p>}
    </div>
  );
}

/** Code Editor: the draft form as YAML (every option, including those the visual editor does not show). */
function CodeEditorTab({ id, dirty, save, onSaved }: { id: string; dirty: boolean; save: () => Promise<unknown>; onSaved: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (dirty ? save() : Promise.resolve()).then(() => forms.code(id)).then((r) => setText(r.yaml), (e: Error) => setErr(e.message));
    // load once when the tab opens (after saving the visual editor's changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (text === null) return err ? <ErrorBox message={err} /> : <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">The form&apos;s draft as YAML. Saving checks it like the visual editor does; publish to make it live.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={28} className={`${inputClass} w-full font-mono text-xs`} />
      <ErrorBox message={err} />
      <button
        type="button"
        disabled={busy}
        className={buttonClass.primary}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await forms.saveCode(id, text);
            onSaved();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save YAML
      </button>
    </div>
  );
}

/** Per-user sharing: people outside the form's Project fill it (respondent), open it (viewer) or edit it (editor). */
function Sharing({ id }: { id: string }) {
  const [list, setList] = useState<Collaborator[] | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Collaborator["role"]>("respondent");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    forms.collaborators(id).then(setList, (e: Error) => setErr(e.message));
  }, [id]);
  const put = (next: { user_id?: string; username?: string; role: Collaborator["role"] }[]) =>
    forms.setCollaborators(id, next).then((l) => (setList(l), setErr(null), setName("")), (e: Error) => setErr(e.message));
  const current = (list ?? []).map((c) => ({ user_id: c.user_id, role: c.role }));
  return (
    <div className="space-y-1 pt-2 text-xs">
      <div className="text-sm font-semibold">Shared with</div>
      <p className="text-muted">People outside the form&apos;s Project: respondents fill it, viewers also open it, editors edit and publish it. Only the Project&apos;s editors change this list; the form&apos;s markings still apply.</p>
      {(list ?? []).map((c) => (
        <div key={c.user_id} className="flex items-center gap-2">
          <span className="flex-1 truncate">{c.user?.display_name || c.user?.username || c.user_id}</span>
          <select value={c.role} onChange={(e) => put(current.map((x) => (x.user_id === c.user_id ? { ...x, role: e.target.value as Collaborator["role"] } : x)))} className={`${inputClass} w-32`} aria-label="Role">
            <option value="respondent">Respondent</option>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button type="button" onClick={() => put(current.filter((x) => x.user_id !== c.user_id))} className="text-muted hover:text-bad">Remove</button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Username" className={`${inputClass} flex-1`} aria-label="Username" />
        <select value={role} onChange={(e) => setRole(e.target.value as Collaborator["role"])} className={`${inputClass} w-32`} aria-label="New role">
          <option value="respondent">Respondent</option>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button type="button" disabled={!name.trim()} onClick={() => put([...current, { username: name.trim(), role }])} className={buttonClass.secondary}>Share</button>
      </div>
      {err && <p className="text-bad">{err}</p>}
    </div>
  );
}
