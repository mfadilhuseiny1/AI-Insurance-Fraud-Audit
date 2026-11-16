"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { uc, type Summary } from "@/lib/useCases";

/** Use Cases [Sunset] (palantir.com/docs/foundry/use-cases): workflow Projects seen as use cases. */
export default function UseCasesHome() {
  const router = useRouter();
  const [list, setList] = useState<Summary[] | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    const t = setTimeout(() => uc.list(q).then((l) => !stale && setList(l), (e: Error) => setErr(e.message)), 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <>
      <AppHome
        app="Use Cases"
        icon="layers"
        accent="#eab308"
        href="/use-cases"
        tagline="Workflow Projects seen as use cases: owners, status, documentation and the apps they hold."
        noun={["use case", "use cases"]}
        error={err}
        onSearch={setQ}
        items={
          list?.map((u) => ({
            id: u.id,
            href: `/use-cases/${u.id}`,
            title: u.name,
            path: u.project ? [u.project] : undefined,
            updated_at: u.updated_at,
            detail: u.description || undefined,
            badges: [{ label: u.status, tone: u.status === "active" ? ("ok" as const) : u.status === "experimental" ? ("warn" as const) : ("bad" as const) }],
            meta: u.technical_owners.map((o) => o.name).join(", ") || undefined,
          })) ?? null
        }
        empty={{ title: "Create your first use case", hint: "A use case wraps a workflow Project with owners, a status and documentation.", steps: ["Name the use case", "Migrate a Project or create one", "Add owners and documentation"] }}
        create={
          <>
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Create new
            </button>
            <span className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-1.5 text-xs text-warn">Sunset phase: full support remains; consider Portfolios for organizing Projects.</span>
          </>
        }
      />
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/use-cases/${id}`)} />}
    </>
  );
}


function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [project, setProject] = useState("");
  const [newProject, setNewProject] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setProject((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="Create use case" icon="layers" onClose={onClose}>
      <form className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onCreated((await uc.create({ name: name.trim(), description, ...(mode === "new" ? { new_project: newProject.trim() } : { project_id: project }) })).id);
          } catch (ex) {
            setErr((ex as Error).message);
          }
        }}>
        <label className="block text-xs text-muted">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} autoFocus />
        </label>
        <label className="block text-xs text-muted">
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${inputClass} mt-1`} />
        </label>
        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> Migrate an existing Project
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> Create a new Project
          </label>
        </div>
        {mode === "existing" ? (
          <select value={project} onChange={(e) => setProject(e.target.value)} className={inputClass}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <input value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="Backing Project name" className={inputClass} />
        )}
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || (mode === "existing" ? !project : !newProject.trim())} className={buttonClass.primary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
