"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { sd, type Graph } from "@/lib/solutionDesigner";

/** Solution Designer (palantir.com/docs/foundry/solution-designer): architecture diagrams of solutions on the platform. */
export default function SolutionDesignerHome() {
  const router = useRouter();
  const [list, setList] = useState<Awaited<ReturnType<typeof sd.list>> | null>(null);
  const [refs, setRefs] = useState<Awaited<ReturnType<typeof sd.references>>>([]);
  const [creating, setCreating] = useState<null | { reference?: string; name?: string; plan?: boolean; graph?: Graph }>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    sd.list().then(setList, (e: Error) => setErr(e.message));
    sd.references().then(setRefs, () => {});
  }, []);
  return (
    <>
      <AppHome
        app="Solution Designer"
        icon="pencil"
        accent="#d946ef"
        href="/solution-designer"
        tagline="Architecture diagrams of solutions: platform components, linked resources and external systems."
        description={
          <>
            Draw the architecture of a solution: platform components, linked resources (datasets, object types, actions), external systems, groups and notes. Plan a workflow from requirements with AIP Architect and
            review the design with AIP Critic.
          </>
        }
        headerActions={
          <>
            <label className={`${buttonClass.secondary} cursor-pointer`}>
              <Icon name="upload" className="h-3.5 w-3.5" /> Import JSON
              <input type="file" accept="application/json,.json" className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    const j = JSON.parse(await f.text());
                    setCreating({ name: j.name ?? f.name.replace(/\.json$/, ""), graph: j.graph ?? j });
                  } catch {
                    setErr("That file is not a diagram JSON.");
                  }
                }} />
            </label>
            <button type="button" onClick={() => setCreating({})} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New diagram
            </button>
          </>
        }
        noun={["diagram", "diagrams"]}
        error={err}
        items={
          list?.map((x) => ({
            id: x.id,
            href: `/solution-designer/${x.id}`,
            title: x.name,
            updated_at: x.updated_at,
            badges: [{ label: `v${x.version}`, tone: "muted" as const }, ...(x.can_edit === false ? [{ label: "view only", tone: "warn" as const }] : [])],
            meta: `${x.nodes} nodes · ${x.edges} connections`,
          })) ?? null
        }
        stats={[
          { label: "Diagrams", value: (list?.length ?? 0).toLocaleString() },
          { label: "Components", value: (list ?? []).reduce((n, x) => n + x.nodes, 0).toLocaleString() },
          { label: "References", value: refs.length.toLocaleString() },
        ]}
        empty={{ title: "Design your first solution", hint: "Plan from requirements with AIP Architect, start from a reference architecture below, or draw on a blank canvas.", steps: ["Start planning or pick a reference", "Add components and connections", "Review it with AIP Critic"] }}
        create={
          <>
            <button type="button" onClick={() => setCreating({ plan: true })} className={buttonClass.primary}>
              <Icon name="sparkle" className="h-3.5 w-3.5" /> Start planning
            </button>
            <button type="button" onClick={() => setCreating({})} className={buttonClass.secondary}>
              Blank diagram
            </button>
          </>
        }
      >
        {refs.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Reference architectures</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
              {refs.map((r) => (
                <button key={r.id} type="button" onClick={() => setCreating({ reference: r.id, name: r.name })} className="rounded-xl border border-line bg-panel p-4 text-left transition hover:-translate-y-0.5 hover:border-[color:var(--app-accent)]">
                  <div className="text-[10px] uppercase tracking-wider text-muted">{r.category}</div>
                  <div className="font-medium text-strong">{r.name}</div>
                  <p className="mt-1 text-xs text-muted">{r.description}</p>
                </button>
              ))}
            </div>
          </section>
        )}
      </AppHome>
      {creating && <CreateDialog init={creating} onClose={() => setCreating(null)} onCreated={(id, plan) => router.push(`/solution-designer/${id}${plan ? "?wizard=1" : ""}`)} />}
    </>
  );
}

function CreateDialog({ init, onClose, onCreated }: { init: { reference?: string; name?: string; plan?: boolean; graph?: Graph }; onClose: () => void; onCreated: (id: string, plan: boolean) => void }) {
  const [name, setName] = useState(init.name ?? "");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title={init.plan ? "Plan with AIP Architect" : init.reference ? "New diagram from a reference" : "New diagram"} icon="pencil" onClose={onClose}>
      <form className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          setBusy(true);
          try {
            const d = await sd.create({ name: name.trim(), folder_id: folder, reference_id: init.reference, graph: init.graph });
            onCreated(d.id, !!init.plan);
          } catch (ex) {
            setErr((ex as Error).message);
            setBusy(false);
          }
        }}>
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
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
