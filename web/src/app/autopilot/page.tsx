"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHome } from "@/components/AppHome";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { autopilot } from "@/lib/autopilot";
import { ontology, type Automation } from "@/lib/ontology";
import { workshop, type ObjectTypeSource } from "@/lib/workshop";

/** Autopilot (palantir.com/docs/foundry/autopilot): a control center for Automate workflows. */
export default function AutopilotPage() {
  const router = useRouter();
  const [list, setList] = useState<Awaited<ReturnType<typeof autopilot.list>> | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    autopilot.list().then(setList, (e: Error) => setErr(e.message));
  }, []);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return (
    <>
      <AppHome
        app="Autopilot"
        icon="grid"
        accent="#0ea5e9"
        href="/autopilot"
        tagline="A control center for your automation workflows, seen as a state machine."
        description={
          <>
            See your automation workflows as a state machine: objects as cards in their state, the automations, actions and people that move them, the events of every run, and each object&apos;s history.
          </>
        }
        noun={["workbench", "workbenches"]}
        items={
          list?.map((w) => ({
            id: w.id,
            href: `/autopilot/${w.id}`,
            title: w.name,
            updated_at: w.updated_at,
            detail: `${plural(w.object_type_ids.length, "object type")} · ${plural(w.automation_ids.length, "automation")}`,
            meta: plural(w.states, "state"),
          })) ?? null
        }
        stats={
          list
            ? [
                { label: "Workbenches", value: list.length.toLocaleString() },
                { label: "Automations", value: new Set(list.flatMap((w) => w.automation_ids)).size.toLocaleString() },
                { label: "Object types", value: new Set(list.flatMap((w) => w.object_type_ids)).size.toLocaleString() },
              ]
            : undefined
        }
        error={err}
        empty={{
          title: "Build your first workbench",
          hint: "A workbench maps object types and the automations that move them into one state machine.",
          steps: ["Name the workbench", "Pick object types or automations", "Watch objects move between states"],
        }}
        create={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New workbench
          </button>
        }
      />
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/autopilot/${id}`)} />}
    </>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [types, setTypes] = useState<ObjectTypeSource[]>([]);
  const [autos, setAutos] = useState<Automation[]>([]);
  const [pickTypes, setPickTypes] = useState<string[]>([]);
  const [pickAutos, setPickAutos] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(pickTypes.length || pickAutos.length ? [] : ["pick an object type or automation to start from"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  const startInvalid = tried && !pickTypes.length && !pickAutos.length;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
    workshop.sources().then((s) => setTypes(s.object_types), () => {});
    ontology.automations().then(setAutos, () => {});
  }, []);
  return (
    <Modal title="New Autopilot workbench" icon="grid" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          setBusy(true);
          try {
            onCreated((await autopilot.create({ name: name.trim(), folder_id: folder, object_type_ids: pickTypes, automation_ids: pickAutos })).id);
          } catch (ex) {
            setErr((ex as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="mb-1 text-muted">Start from object types <span className="text-bad" aria-hidden>*</span></div>
            <div className={`max-h-48 overflow-auto rounded border p-2 ${startInvalid ? "border-bad ring-1 ring-bad/40" : "border-line"}`}>
              {types.map((t) => (
                <label key={t.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={pickTypes.includes(t.id)} onChange={(e) => setPickTypes(e.target.checked ? [...pickTypes, t.id] : pickTypes.filter((x) => x !== t.id))} /> {t.name}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted">…or from automations</div>
            <div className={`max-h-48 overflow-auto rounded border p-2 ${startInvalid ? "border-bad ring-1 ring-bad/40" : "border-line"}`}>
              {autos.map((a) => (
                <label key={a.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={pickAutos.includes(a.id)} onChange={(e) => setPickAutos(e.target.checked ? [...pickAutos, a.id] : pickAutos.filter((x) => x !== a.id))} /> {a.name}
                </label>
              ))}
              {!autos.length && <span className="text-muted">No automations</span>}
            </div>
          </div>
        </div>
        {startInvalid && <p className="text-[11px] text-bad">Pick at least one object type or automation to start from.</p>}
        <p className="text-[11px] text-muted">Related automations come along; states are inferred from the objects&apos; status properties and what automations write.</p>
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
