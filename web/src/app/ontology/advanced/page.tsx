"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { request } from "@/lib/ontology";
import { om, type Ontology } from "@/lib/ontologyModel";

type Change = { kind: string; id: string; source_id: string; name: string; op: "create" | "update" | "unchanged"; fields: string[] };
type Candidate = {
  object_type_id: string;
  display_name: string;
  status: string;
  objects: number;
  user_edits: boolean;
  can_delete: boolean;
  priority: number;
  flags: { flag: string; priority: number; detail: string }[];
  snoozed_until: string | null;
};
type Flags = Record<string, { on: boolean; priority: number; days?: number; pattern?: string }>;
const FLAG_LABEL: Record<string, string> = {
  past_deprecation: "Past deprecation date",
  trashed_datasource: "Trashed datasource",
  stale_datasource: "Datasource not updated",
  description_missing: "Description missing",
  name_pattern: "Display name matches pattern",
  no_objects: "No objects",
  unused: "Not used by links, actions or automations",
};

const api = {
  export: (ontologyId: string) => request<Record<string, unknown>>(`/export?ontology_id=${ontologyId}`),
  import: (body: { document: unknown; target_ontology_id: string; resource_ids?: string[]; apply: boolean }) =>
    request<{ changes: Change[]; counts?: Record<string, number>; copy: boolean; applied?: number }>("/import", { method: "POST", json: body }),
  cleanup: (ontologyId: string) => request<{ settings: { flags: Flags }; candidates: Candidate[] }>(`/cleanup?ontology_id=${ontologyId}`),
  settings: (flags: Flags) => request<unknown>("/cleanup/settings", { method: "PUT", json: { flags } }),
  snooze: (ids: string[], days: number) => request<unknown>("/cleanup/snooze", { method: "POST", json: { object_type_ids: ids, days } }),
  deprecate: (ids: string[], reason: string, deadline?: string) => request<unknown>("/cleanup/deprecate", { method: "POST", json: { object_type_ids: ids, reason, deadline } }),
  remove: (ids: string[]) => request<unknown>("/cleanup/delete", { method: "POST", json: { object_type_ids: ids } }),
};

/** Ontology Manager's advanced tools: export the ontology as JSON, import an (edited) export with a preview, and cleanup. */
export default function OntologyAdvancedPage() {
  const [onts, setOnts] = useState<Ontology[] | null>(null);
  const [ontologyId, setOntologyId] = useState("default");
  const [tab, setTab] = useState<"transfer" | "cleanup">("transfer");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    om.ontologies().then(setOnts, (e: Error) => setError(e.message));
  }, []);
  if (error && !onts) return <ApiError message={error} />;
  if (!onts) return <Loading />;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology" crumbs={[{ label: "Export, import & cleanup" }]}>
        <select value={ontologyId} onChange={(e) => setOntologyId(e.target.value)} className={fieldClass} aria-label="Nexus">
          {onts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </AppHeader>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-6 text-xs">
          <div className="flex gap-1 border-b border-line">
            {(["transfer", "cleanup"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={`px-3 py-2 ${tab === t ? "border-b-2 border-ocean text-white" : "text-muted"}`}>
                {t === "transfer" ? "Export & import" : "Cleanup"}
              </button>
            ))}
          </div>
          {tab === "transfer" ? <Transfer key={ontologyId} ontologyId={ontologyId} onts={onts} /> : <Cleanup key={ontologyId} ontologyId={ontologyId} />}
        </div>
      </main>
    </div>
  );
}

function Transfer({ ontologyId, onts }: { ontologyId: string; onts: Ontology[] }) {
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<{ changes: Change[]; counts?: Record<string, number>; copy: boolean } | null>(null);
  const [only, setOnly] = useState<Set<string> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = only ? [...only] : [];
  const runPreview = async (d: Record<string, unknown>, sel: string[]) => {
    try {
      setPreview(await api.import({ document: d, target_ontology_id: ontologyId, resource_ids: sel, apply: false }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <Card title="Export">
        <div className="flex items-center gap-3 p-4">
          <p className="flex-1 text-muted">The ontology&apos;s working state as JSON: object types, link types, action types, interfaces, shared properties and value types — no objects. Edit it in a code editor and import it back, or import it into another ontology to copy it. The format may change.</p>
          <button
            type="button"
            onClick={async () => {
              try {
                const d = await api.export(ontologyId);
                const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `ontology-${ontologyId}-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name="download" className="h-3.5 w-3.5" /> Export JSON
          </button>
        </div>
      </Card>
      <Card title={`Import into ${onts.find((o) => o.id === ontologyId)?.name ?? ontologyId}`}>
        <div className="space-y-3 p-4">
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const d = JSON.parse(await f.text()) as Record<string, unknown>;
                setDoc(d);
                setFileName(f.name);
                setOnly(null);
                setMsg(null);
                await runPreview(d, []);
              } catch (err) {
                setError(`Not a JSON file: ${(err as Error).message}`);
              }
            }}
          />
          <ErrorBox message={error} />
          {msg && <div className="rounded bg-ok/10 px-3 py-2 text-ok">{msg}</div>}
          {preview && doc && (
            <>
              <div className="text-muted">
                {fileName}: {preview.counts?.create ?? 0} to create, {preview.counts?.update ?? 0} to update, {preview.counts?.unchanged ?? 0} unchanged
                {preview.copy ? " · copied from another ontology: new IDs, references rewritten" : ""}
              </div>
              <div className="max-h-96 divide-y divide-line overflow-y-auto rounded border border-line">
                {preview.changes.map((c) => (
                  <label key={c.source_id} className="flex items-center gap-2 px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={!only || only.has(c.source_id)}
                      onChange={(e) => {
                        const cur = new Set(only ?? preview.changes.map((x) => x.source_id));
                        if (e.target.checked) cur.add(c.source_id);
                        else cur.delete(c.source_id);
                        setOnly(cur);
                      }}
                    />
                    <span className={`w-16 uppercase ${c.op === "create" ? "text-ok" : c.op === "update" ? "text-ocean" : "text-muted"}`}>{c.op}</span>
                    <span className="w-28 text-muted">{c.kind.replace("_", " ")}</span>
                    <span className="flex-1 truncate">{c.name}</span>
                    {c.fields.length > 0 && <span className="text-muted">{c.fields.join(", ")}</span>}
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                {only && (
                  <button type="button" onClick={() => runPreview(doc, ids)} className={buttonClass.secondary}>
                    Preview selection
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (!(await confirmDialog({ message: "Apply the import? Every changed resource is replaced by its definition in the file.", confirmLabel: "Import" }))) return;
                    try {
                      const r = await api.import({ document: doc, target_ontology_id: ontologyId, resource_ids: ids, apply: true });
                      setMsg(`Imported: ${r.applied} resources written.`);
                      await runPreview(doc, ids);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                  className={buttonClass.primary}
                >
                  Import
                </button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function Cleanup({ ontologyId }: { ontologyId: string }) {
  const [data, setData] = useState<{ settings: { flags: Flags }; candidates: Candidate[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.cleanup(ontologyId).then(
        (d) => (setData(d), setFlags(d.settings.flags), setError(null)),
        (e: Error) => setError(e.message),
      ),
    [ontologyId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setPicked(new Set());
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!data || !flags) return error ? <ErrorBox message={error} /> : <Loading />;
  const rows = data.candidates.filter((c) => !filter || c.flags.some((f) => f.flag === filter));
  const ids = [...picked];
  return (
    <div className="space-y-3">
      <p className="text-muted">Object types that may be ready to go, by the flags they trigger. Snooze hides them from your queue; deprecate tells their users; delete removes them with their objects (types whose objects have user edits can only be deprecated).</p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={fieldClass} aria-label="Flag filter">
          <option value="">All flags</option>
          {Object.keys(FLAG_LABEL).map((k) => (
            <option key={k} value={k}>
              {FLAG_LABEL[k]}
            </option>
          ))}
        </select>
        <span className="text-muted">{picked.size} selected</span>
        <button type="button" disabled={!ids.length} onClick={() => act(() => api.snooze(ids, 30))} className={buttonClass.secondary}>
          Snooze 30 days
        </button>
        <button
          type="button"
          disabled={!ids.length}
          onClick={async () => {
            const reason = await promptDialog("Why are these object types deprecated?", "", { title: "Deprecate" });
            if (!reason) return;
            const deadline = await promptDialog("Deadline (YYYY-MM-DD, optional)", "", { title: "Deprecate" });
            await act(() => api.deprecate(ids, reason, deadline || undefined));
          }}
          className={buttonClass.secondary}
        >
          Deprecate
        </button>
        <button
          type="button"
          disabled={!ids.length || data.candidates.some((c) => picked.has(c.object_type_id) && !c.can_delete)}
          onClick={async () => {
            if (await confirmDialog({ message: `Delete ${ids.length} object types and their objects? This cannot be undone.`, danger: true, confirmLabel: "Delete" })) await act(() => api.remove(ids));
          }}
          className={buttonClass.secondary}
        >
          <Icon name="trash" className="h-3.5 w-3.5" /> Delete
        </button>
        <button type="button" onClick={() => setShowSettings(!showSettings)} className={`${buttonClass.ghost} ml-auto`}>
          <Icon name="sliders" className="h-3.5 w-3.5" /> Flags
        </button>
      </div>
      <ErrorBox message={error} />
      {showSettings && (
        <Card title="Flags (yours only)">
          <div className="space-y-1.5 p-3">
            {Object.entries(flags).map(([k, f]) => (
              <div key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={f.on} onChange={(e) => setFlags({ ...flags, [k]: { ...f, on: e.target.checked } })} />
                <span className="w-64">{FLAG_LABEL[k]}</span>
                <span className="text-muted">priority</span>
                <input type="number" min={1} max={5} value={f.priority} onChange={(e) => setFlags({ ...flags, [k]: { ...f, priority: Number(e.target.value) || 1 } })} className={`${fieldClass} w-14`} />
                {k === "stale_datasource" && <input type="number" value={f.days ?? 90} onChange={(e) => setFlags({ ...flags, [k]: { ...f, days: Number(e.target.value) || 90 } })} className={`${fieldClass} w-20`} />}
                {k === "name_pattern" && <input value={f.pattern ?? ""} onChange={(e) => setFlags({ ...flags, [k]: { ...f, pattern: e.target.value } })} className={`${fieldClass} flex-1 font-mono`} />}
              </div>
            ))}
            <button type="button" onClick={() => act(() => api.settings(flags))} className={buttonClass.primary}>
              Save and recalculate
            </button>
          </div>
        </Card>
      )}
      <Card title="Cleanup queue" count={rows.length}>
        <table className="w-full">
          <thead className="bg-panel-2 text-left text-muted">
            <tr>
              <th className="w-8 px-3 py-1.5" />
              <th className="px-3 py-1.5 font-medium">Object type</th>
              <th className="px-3 py-1.5 font-medium">Flags</th>
              <th className="px-3 py-1.5 font-medium">Objects</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => (
              <tr key={c.object_type_id} className="hover:bg-panel-2">
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={picked.has(c.object_type_id)}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(c.object_type_id);
                      else n.delete(c.object_type_id);
                      setPicked(n);
                    }}
                  />
                </td>
                <td className="px-3 py-1.5">
                  <Link href={`/ontology/${c.object_type_id}`} className="text-ocean hover:underline">
                    {c.display_name}
                  </Link>
                </td>
                <td className="px-3 py-1.5">
                  {c.flags.map((f) => (
                    <span key={f.flag} title={f.detail} className={`mr-1 inline-block rounded px-1.5 py-0.5 ${f.priority <= 1 ? "bg-bad/15 text-bad" : f.priority <= 2 ? "bg-warn/15 text-warn" : "bg-panel-2 text-soft"}`}>
                      {FLAG_LABEL[f.flag] ?? f.flag}
                    </span>
                  ))}
                </td>
                <td className="px-3 py-1.5 tabular-nums">
                  {c.objects}
                  {c.user_edits ? <span className="ml-1 text-warn">edited</span> : null}
                </td>
                <td className="px-3 py-1.5">{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
