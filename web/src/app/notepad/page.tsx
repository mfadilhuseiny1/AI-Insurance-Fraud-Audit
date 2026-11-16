"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { GenerateDialog } from "@/components/notepad/Panels";
import { notepad, type GenerationLimits, type LocatedDriveItem, type NotepadBlock, type TemplateListItem } from "@/lib/notepad";

const action = "inline-flex items-center justify-center gap-2 rounded-md border border-line-2 bg-panel px-3 py-2 text-sm font-medium text-soft shadow-sm transition hover:border-sky-400 hover:text-ocean disabled:cursor-not-allowed disabled:opacity-50";
const primary = "inline-flex items-center justify-center gap-2 rounded-md bg-sky-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-ocean-deep disabled:cursor-not-allowed disabled:opacity-50";
const field = "w-full rounded-md border border-line-2 bg-panel px-3 py-2 text-sm text-white outline-none placeholder:text-muted focus:border-sky-500 focus:ring-2 focus:ring-sky-100";
type StarterTemplate = "blank" | "meeting" | "analysis" | "project" | "template";

function starterBlocks(template: StarterTemplate): NotepadBlock[] {
  const heading = (text: string): NotepadBlock => ({ id: crypto.randomUUID(), type: "heading", level: 2, text });
  const paragraph = (): NotepadBlock => ({ id: crypto.randomUUID(), type: "paragraph", text: "" });
  if (template === "meeting") return [heading("Purpose"), paragraph(), heading("Discussion"), paragraph(), heading("Decisions"), paragraph(), heading("Action items"), { id: crypto.randomUUID(), type: "table", rows: [["Action", "Owner", "Due date"], ["", "", ""]] }];
  if (template === "analysis") return [heading("Executive summary"), paragraph(), heading("Key findings"), paragraph(), heading("Recommendations"), paragraph(), heading("Source links"), paragraph()];
  if (template === "project") return [heading("Overview"), paragraph(), heading("Scope"), paragraph(), heading("Milestones"), { id: crypto.randomUUID(), type: "table", rows: [["Milestone", "Owner", "Status"], ["", "", ""]] }];
  return [{ id: crypto.randomUUID(), type: "paragraph", text: "" }];
}

export default function NotepadHomePage() {
  const router = useRouter();
  const [loadVersion, setLoadVersion] = useState(0);
  const [result, setResult] = useState<{ version: number; documents: LocatedDriveItem[]; folders: LocatedDriveItem[] } | null>(null);
  const [failure, setFailure] = useState<{ version: number; message: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("Untitled Notepad");
  const [parentId, setParentId] = useState("");
  const [template, setTemplate] = useState<StarterTemplate>("blank");
  const [envelope, setEnvelope] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [templates, setTemplates] = useState<TemplateListItem[] | null>(null);
  const [fromTemplate, setFromTemplate] = useState<TemplateListItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    const version = loadVersion;
    Promise.all([notepad.documents(), notepad.folders()]).then(([documents, folders]) => {
      if (!cancelled) setResult({ version, documents, folders });
    }).catch((error: Error) => {
      if (!cancelled) setFailure({ version, message: error.message });
    });
    return () => { cancelled = true; };
  }, [loadVersion]);

  const documents = result?.version === loadVersion ? result.documents : null;
  const folders = result?.version === loadVersion ? result.folders : [];
  const error = failure?.version === loadVersion ? failure.message : null;
  const [showLimits, setShowLimits] = useState(false);

  function openCreate() {
    setName("Untitled Notepad");
    setParentId(folders.find((folder) => folder.kind === "project")?.id ?? folders[0]?.id ?? "");
    setTemplate("blank");
    setCreateError("");
    setCreateOpen(true);
  }

  async function createDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      const created = await notepad.create({
        name: name.trim(),
        parent_id: parentId || null,
        document: { schema_version: 1, blocks: starterBlocks(template), ...(template === "template" ? { template: { inputs: [], published: [] } } : {}), ...(envelope ? { envelope: true } : {}) },
      });
      router.push(`/notepad/${encodeURIComponent(created.item.id)}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create the document");
      setCreating(false);
    }
  }

  return (
    <main className="notepad-shell flex min-h-0 flex-1 flex-col">
      <AppHome
        app="Notepad"
        icon="doc"
        accent="#10b981"
        href="/notepad"
        tagline="Project documents with live Nexus objects, Contour boards and generated sections."
        description={
          <>
            <p>Create and edit project documents. Access follows the selected Drive project and its existing permissions.</p>
            <p className="mt-2">
              Documents embed Nexus objects, Contour boards and function results; templates take inputs and generate documents (section and table row generators); every
              document has version history.
            </p>
          </>
        }
        noun={["document", "documents"]}
        items={
          documents?.map((item) => ({
            id: item.id,
            href: `/notepad/${encodeURIComponent(item.id)}`,
            title: item.name.replace(/\.notepad$/i, ""),
            path: (item.path ?? []).map((part) => part.name),
            updated_at: item.updated_at,
          })) ?? null
        }
        error={error}
        empty={{
          title: "No Notepad documents yet",
          hint: "Create a document in a project folder to begin writing.",
          steps: ["Choose a title and a Project", "Start blank or from meeting notes, a report or a brief", "Embed objects, boards and function results"],
        }}
        headerActions={
          <>
            <button type="button" className={buttonClass.secondary} onClick={() => setLoadVersion((v) => v + 1)} aria-label="Refresh documents">
              <Icon name="refresh" /> <span className="hidden sm:inline">Refresh</span>
            </button>
            <button type="button" className={buttonClass.secondary} onClick={() => setShowLimits((v) => !v)} title="Generation limits" aria-pressed={showLimits}>
              <Icon name="sliders" /> <span className="hidden sm:inline">Settings</span>
            </button>
          </>
        }
        create={
          <>
            <button type="button" className={buttonClass.primary} onClick={openCreate}>
              <Icon name="plus" />
              New document
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                setTemplates(null);
                notepad.templates().then(setTemplates, () => setTemplates([]));
              }}
            >
              <Icon name="copy" />
              New from template
            </button>
            {error && (
              <button type="button" className="text-xs text-bad underline" onClick={() => setLoadVersion((v) => v + 1)}>
                Try again
              </button>
            )}
            {showLimits && (
              <div className="w-full">
                <LimitsPanel />
              </div>
            )}
          </>
        }
      />

      {templates && !fromTemplate && <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplates(null); }}>
        <div className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl" role="dialog" aria-modal="true">
          <div className="flex items-start justify-between"><h2 className="text-lg font-semibold text-white">New from template</h2><button type="button" onClick={() => setTemplates(null)} className="rounded p-1 text-muted hover:bg-panel-2" aria-label="Close"><Icon name="x" /></button></div>
          {templates.length === 0 && <p className="mt-3 text-sm text-muted">No templates yet: create one with “Document template”, or “Save as template” in a document&apos;s Actions.</p>}
          <div className="mt-3 max-h-80 divide-y divide-line overflow-y-auto">
            {templates.map((t) => <button key={t.id} disabled={!t.versions.length} onClick={() => setFromTemplate(t)} className="block w-full px-2 py-2 text-left text-sm hover:bg-panel-2 disabled:opacity-50"><span className="font-medium">{t.name.replace(/\.notepad$/i, "")}</span><span className="block text-xs text-muted">{t.versions.length ? `v${t.versions[t.versions.length - 1].version} · ${t.inputs.length} inputs` : "not published yet"}</span></button>)}
          </div>
        </div>
      </div>}
      {fromTemplate && <GenerateDialog template={fromTemplate} onClose={() => { setFromTemplate(null); setTemplates(null); }} />}

      {createOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
        <form onSubmit={createDocument} className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="notepad-create-title">
          <div className="flex items-start justify-between"><div><h2 id="notepad-create-title" className="text-lg font-semibold text-white">New Notepad document</h2><p className="mt-1 text-sm text-muted">Choose a title and a Drive project or folder.</p></div><button type="button" onClick={() => setCreateOpen(false)} className="rounded p-1 text-muted hover:bg-panel-2" aria-label="Close"><Icon name="x" /></button></div>
          <label className="mt-5 block text-xs font-medium text-soft">Document name<input autoFocus required maxLength={247} value={name} onChange={(event) => setName(event.target.value)} className={`${field} mt-1`} /></label>
          <label className="mt-4 block text-xs font-medium text-soft">Start from<select value={template} onChange={(event) => setTemplate(event.target.value as StarterTemplate)} className={`${field} mt-1`}><option value="blank">Blank document</option><option value="meeting">Meeting notes</option><option value="analysis">Analysis report</option><option value="project">Project brief</option><option value="template">Document template (inputs and generators)</option></select></label>
          <label className="mt-4 flex items-start gap-2 text-xs text-soft">
            <input type="checkbox" checked={envelope} onChange={(event) => setEnvelope(event.target.checked)} className="mt-0.5" />
            <span><span className="font-medium">Enable envelope security</span><span className="block text-muted">The document&apos;s markings (from where it is saved) bound what it shows; only Nexus, LaTeX, link and mention widgets; exports carry its banner. Cannot be changed later.</span></span>
          </label>
          <label className="mt-4 block text-xs font-medium text-soft">Save in<select value={parentId} onChange={(event) => setParentId(event.target.value)} className={`${field} mt-1`}><option value="">Files root</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{(folder.path ?? []).map((part) => part.name).concat(folder.name).join(" / ")}{folder.kind === "project" ? " · Project" : ""}</option>)}</select></label>
          {createError && <p role="alert" className="mt-3 text-sm text-rose-700">{createError}</p>}
          <div className="mt-6 flex justify-end gap-2"><button type="button" className={action} onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" className={primary} disabled={creating || !name.trim()}>{creating ? "Creating…" : "Create document"}</button></div>
        </form>
      </div>}
    </main>
  );
}

/** Generation limits for templates (admins change them): objects per section generator, rows per table generator. */
function LimitsPanel() {
  const [cur, setCur] = useState<GenerationLimits | null>(null);
  const [max, setMax] = useState<GenerationLimits | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    notepad.settings().then((s) => (setCur(s.limits), setMax(s.max)), (e: Error) => setNote(e.message));
  }, []);
  if (!cur || !max) return <p className="mb-5 text-sm text-muted">{note || "Loading…"}</p>;
  const rows: [keyof GenerationLimits, string][] = [["top", "Objects per section generator"], ["nested", "Objects per nested generator"], ["rows", "Rows per table row generator"]];
  return (
    <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel p-4 text-sm">
      {rows.map(([k, label]) => (
        <label key={k} className="block">
          <span className="text-xs text-muted">{label} (max {max[k].toLocaleString()})</span>
          <input type="number" min={1} max={max[k]} value={cur[k]} onChange={(e) => setCur({ ...cur, [k]: Number(e.target.value) })} className="mt-1 block w-40 rounded border border-line-2 bg-panel-2 px-2 py-1" />
        </label>
      ))}
      <button className="rounded bg-sky-600 px-3 py-1.5 text-white" onClick={() => notepad.saveSettings(cur).then((s) => (setCur(s.limits), setNote("Saved")), (e: Error) => setNote(e.message))}>Save</button>
      {note && <span className="text-xs text-muted">{note}</span>}
      <p className="w-full text-xs text-muted">Admins can change these; they apply to every template&apos;s generation.</p>
    </div>
  );
}
