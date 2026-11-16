"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { wb } from "@/lib/workflowBuilder";

/** Workflow Builder (palantir.com/docs/foundry/workflow-builder): Ontology workflows as graphs of nodes. */
export default function WorkflowBuilderHome() {
  const router = useRouter();
  const [list, setList] = useState<Awaited<ReturnType<typeof wb.list>> | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    wb.list().then(setList, (e: Error) => setErr(e.message));
  }, []);
  return (
    <>
      <AppHome
        app="Workflow Builder"
        icon="play"
        accent="#0d9488"
        href="/workflow-builder"
        tagline="Nexus workflows as graphs of nodes, previewed on real objects and deployed on changes or a schedule."
        description={
          <>
            Build Nexus workflows from triggers, compute, LLM, fork, effect, loop and subgraph nodes. Preview them on real objects in a sandbox, watch each object&apos;s path, then deploy them on
            object changes or a schedule.
          </>
        }
        noun={["graph", "graphs"]}
        error={err}
        items={
          list?.map((g) => ({
            id: g.id,
            href: `/workflow-builder/${g.id}`,
            title: g.name,
            updated_at: g.updated_at,
            badges: [{ label: `v${g.version}`, tone: "muted" as const }, ...(g.deployed ? [{ label: `${g.deployed} deployed`, tone: "ok" as const }] : [])],
            meta: `${g.workflows} workflow${g.workflows === 1 ? "" : "s"}`,
          })) ?? null
        }
        stats={[
          { label: "Graphs", value: (list?.length ?? 0).toLocaleString() },
          { label: "Workflows", value: (list ?? []).reduce((n, g) => n + g.workflows, 0).toLocaleString() },
          { label: "Deployed", value: (list ?? []).reduce((n, g) => n + g.deployed, 0).toLocaleString() },
        ]}
        empty={{ title: "Build your first workflow graph", hint: "Start from a trigger, add compute, LLM and effect nodes, then preview on real objects.", steps: ["Name the graph and pick a Project", "Add a trigger and nodes", "Preview, then deploy"] }}
        create={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New graph
          </button>
        }
      />
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/workflow-builder/${id}`)} />}
    </>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="New Workflow Builder graph" icon="play" onClose={onClose}>
      <form className="space-y-3 p-5 text-sm" onSubmit={async (e) => (e.preventDefault(), setTried(true), missing.length ? undefined : wb.create(name.trim(), folder).then((g) => onCreated(g.id), (x: Error) => setErr(x.message)))}>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Project <span className="text-bad" aria-hidden>*</span></span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={projectInvalid} className={`${inputClass} mt-1 ${projectInvalid ? "border-bad ring-1 ring-bad/40" : ""}`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projectInvalid && <span className="mt-1 block text-[11px] text-bad">{projects.length ? "Choose the Project it is saved in." : "No Project to save it in: create or join one first."}</span>}
        </label>
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
