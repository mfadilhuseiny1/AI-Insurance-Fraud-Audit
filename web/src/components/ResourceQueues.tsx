"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, API_URL, type DriveItem } from "@/lib/api";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";

type Lease = { id: string; vcpus: number; label: string; kind: string; asked_at: string; granted_at: string | null; user: string | null; project_id: string | null };
// the kinds of job that take leases (api/resource_queues.py)
const KIND: Record<string, string> = {
  pipeline: "Pipeline build",
  transform: "Code build",
  sql: "SQL rebuild",
  logic_flow: "Connected flow",
  stream: "Streaming job",
  stream_sync: "Streaming sync",
  sync: "Data Connection sync",
  export: "Data Connection export",
};
export type ResourceQueue = {
  id: string;
  name: string;
  description: string;
  vcpu_limit: number;
  project_ids: string[];
  projects: { id: string; name: string }[];
  in_use: number;
  running: Lease[];
  waiting: Lease[];
};

async function call<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/resource-queues${path}`, {
    method,
    cache: "no-store",
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** Resource queues (api/resource_queues.py): Projects bundled under a vCPU limit; jobs wait for room. */
export function ResourceQueues() {
  const [queues, setQueues] = useState<ResourceQueue[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<ResourceQueue | "new" | null>(null);
  const load = useCallback(() => call<ResourceQueue[]>("").then(setQueues, (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <p className="max-w-3xl text-sm text-muted">
          A queue bundles Projects and caps the vCPUs their jobs use at once (Pipeline Builder batch jobs, Code Repositories builds, SQL rebuilds). A job starts when its
          Project&apos;s queue has room for its compute profile and the jobs ahead of it have started; otherwise it waits. Projects in no queue use the Default queue.
        </p>
        <button type="button" onClick={() => setEditing("new")} className={`${buttonClass.primary} ml-auto shrink-0`}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New queue
        </button>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
      {!queues && !err && <p className="text-sm text-muted">Loading…</p>}
      {queues?.map((q) => {
        const pct = Math.min(100, Math.round((q.in_use / q.vcpu_limit) * 100));
        return (
          <section key={q.id} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{q.name}</h3>
              <span className="text-xs text-muted">{q.description}</span>
              <span className="ml-auto text-xs text-soft">
                {q.in_use} / {q.vcpu_limit} vCPUs in use{q.waiting.length ? ` · ${q.waiting.length} waiting` : ""}
              </span>
              <button type="button" onClick={() => setEditing(q)} className="text-xs text-ocean hover:underline">
                Edit
              </button>
              {q.id !== "default" && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!(await confirmDialog(`Delete the queue ${q.name}? Its Projects move to the Default queue.`))) return;
                    call(`/${q.id}`, "DELETE").then(load, (e: Error) => setErr(e.message));
                  }}
                  className="text-xs text-muted hover:text-bad"
                >
                  Delete
                </button>
              )}
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink" role="meter" aria-valuenow={q.in_use} aria-valuemax={q.vcpu_limit} aria-label={`${q.name} vCPUs in use`}>
              <div className={`h-full rounded-full ${pct >= 100 ? "bg-warn" : "bg-ocean"}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted">
              Projects: {q.id === "default" ? "every Project in no other queue" : q.projects.map((p) => p.name).join(", ") || "none yet"}
            </p>
            {(q.running.length > 0 || q.waiting.length > 0) && (
              <table className="mt-3 w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 font-normal">Job</th>
                    <th className="py-1 font-normal">Kind</th>
                    <th className="py-1 font-normal">vCPUs</th>
                    <th className="py-1 font-normal">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...q.running, ...q.waiting].map((l) => (
                    <tr key={l.id} className="border-t border-line">
                      <td className="py-1.5 text-soft">{l.label}</td>
                      <td className="py-1.5 text-muted">{KIND[l.kind] ?? l.kind}</td>
                      <td className="py-1.5 text-muted">{l.vcpus}</td>
                      <td className="py-1.5">
                        {l.granted_at ? <span className="text-ok">running since {when(l.granted_at)}</span> : <span className="text-warn">waiting since {when(l.asked_at)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
      {editing && (
        <QueueDialog
          queue={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function QueueDialog({ queue, onClose, onSaved }: { queue: ResourceQueue | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(queue?.name ?? "");
  const [description, setDescription] = useState(queue?.description ?? "");
  const [limit, setLimit] = useState(String(queue?.vcpu_limit ?? 16));
  const [projects, setProjects] = useState<string[]>(queue?.project_ids ?? []);
  const [all, setAll] = useState<DriveItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((f) => setAll(f.items.filter((i) => i.kind === "project")), () => {});
  }, []);
  const isDefault = queue?.id === "default";
  return (
    <Modal title={queue ? `Edit ${queue.name}` : "New resource queue"} icon="gauge" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const body = { name: name.trim(), description, vcpu_limit: Number(limit), project_ids: projects };
          try {
            if (queue) await call(`/${queue.id}`, "PUT", body);
            else await call("", "POST", body);
            onSaved();
          } catch (ex) {
            setErr((ex as Error).message);
          }
        }}
      >
        <label className="block text-xs text-muted">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} autoFocus />
        </label>
        <label className="block text-xs text-muted">
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-xs text-muted">
          vCPU limit (the most vCPUs its jobs use at once)
          <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} className={`${inputClass} mt-1 w-32`} />
        </label>
        {!isDefault && (
          <fieldset className="text-xs text-muted">
            <legend>Projects (a Project belongs to one queue; adding it here moves it)</legend>
            <div className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded border border-line p-2">
              {all.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-soft">
                  <input
                    type="checkbox"
                    checked={projects.includes(p.id)}
                    onChange={(e) => setProjects(e.target.checked ? [...projects, p.id] : projects.filter((x) => x !== p.id))}
                  />
                  {p.name}
                </label>
              ))}
              {!all.length && <p>No Projects.</p>}
            </div>
          </fieldset>
        )}
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || !(Number(limit) >= 1)} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
