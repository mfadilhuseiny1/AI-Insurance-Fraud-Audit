"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { ontology, request, type ObjectType } from "@/lib/ontology";

type Materialization = { mode: "automatic" | "periodic"; dataset_id?: string | null; last_built_at?: string | null; rows?: number; error?: string | null } | null;
type EditsConfig = { enabled: boolean; history: boolean; strategy: "user_edits" | "most_recent"; timestamp_property: string | null; materialization: Materialization };
type Overview = { object_type_id: string; display_name: string; has_datasource: boolean; config: EditsConfig; edited_objects: number; last_edit_at: string | null };
type Summary = {
  config: EditsConfig;
  edited_objects: number;
  created: number;
  deleted: number;
  modified: number;
  by_property: Record<string, number>;
  last_edit_at: string | null;
  has_datasource: boolean;
  recent: { primary_key: string; op: string; at: string; properties: Record<string, unknown> }[];
};
type History = { enabled: boolean; entries: { at: string; user: string; op: string; changes: Record<string, [unknown, unknown]> }[] };

const api = {
  overview: () => request<Overview[]>("/object-edits/overview"),
  summary: (id: string) => request<Summary>(`/object-types/${id}/edits`),
  config: (id: string, body: Record<string, unknown>) => request<EditsConfig>(`/object-types/${id}/edits/config`, { method: "PUT", json: body }),
  migrate: (id: string, body: Record<string, unknown>) => request<{ migrated: number }>(`/object-types/${id}/edits/migrate`, { method: "POST", json: body }),
  history: (id: string, pk: string) => request<History>(`/object-types/${id}/objects/${encodeURIComponent(pk)}/edit-history`),
  materialize: (id: string, mode: string) => request<Materialization>(`/object-types/${id}/materialization`, { method: "PUT", json: { mode } }),
  build: (id: string) => request<Materialization>(`/object-types/${id}/materialization/build`, { method: "POST" }),
  stop: (id: string) => request<EditsConfig>(`/object-types/${id}/materialization`, { method: "DELETE" }),
};
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Object edits and materializations: user edits kept apart from the datasource (user edits win, or the most recent
 * value), the Edits and Track user edit history toggles, schema migrations of edits, and materialized datasets.
 */
export default function ObjectEditsPage() {
  const [rows, setRows] = useState<Overview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => api.overview().then(setRows, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error && !rows) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  const current = selected ?? rows[0]?.object_type_id ?? null;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Object Edits & Materializations" icon="edit" href="/object-edits" crumbs={current ? [{ label: rows.find((r) => r.object_type_id === current)?.display_name ?? "" }] : []} />
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Object types</div>
          {rows.map((r) => (
            <button
              key={r.object_type_id}
              type="button"
              onClick={() => setSelected(r.object_type_id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${current === r.object_type_id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
            >
              <Icon name={r.has_datasource ? "database" : "cube"} className="h-3.5 w-3.5 shrink-0 text-ocean" />
              <span className="min-w-0 flex-1 truncate">{r.display_name}</span>
              {!r.config.enabled && <span className="text-[10px] text-warn">off</span>}
              {r.config.materialization?.dataset_id && <Icon name="table" className="h-3 w-3 text-sand" />}
              <span className="text-[11px] tabular-nums text-muted">{r.edited_objects}</span>
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto bg-ink">{current && <TypeEdits key={current} typeId={current} onChanged={load} />}</main>
      </div>
    </div>
  );
}

function TypeEdits({ typeId, onChanged }: { typeId: string; onChanged: () => void }) {
  const [t, setT] = useState<ObjectType | null>(null);
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pk, setPk] = useState("");
  const [hist, setHist] = useState<History | null>(null);
  const [mig, setMig] = useState({ kind: "drop_property", property: "", to: "" });
  const reload = useCallback(() => {
    api.summary(typeId).then(setS, (e: Error) => setError(e.message));
    onChanged();
  }, [typeId, onChanged]);
  useEffect(() => {
    ontology.objectType(typeId).then(setT, (e: Error) => setError(e.message));
    api.summary(typeId).then(setS, (e: Error) => setError(e.message));
  }, [typeId]);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      setError(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!t || !s) return <div className="p-6">{error ? <ErrorBox message={error} /> : <Loading />}</div>;
  const c = s.config;
  const props = t.properties.filter((p) => p.api_name !== t.primary_key);
  const tsProps = t.properties.filter((p) => p.type === "timestamp" || p.type === "date");
  const mat = c.materialization;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{t.display_name}</h1>
          <p className="mt-1 text-xs text-muted">
            {s.has_datasource ? "Backed by a dataset: edits are kept apart from the rows and resolved at every re-index." : "No backing dataset: every object comes from user edits."}{" "}
            Edits recorded since this feature was turned on.
          </p>
        </div>
        <Link href={`/ontology/${t.id}?tab=datasources`} className={buttonClass.secondary}>
          <Icon name="cube" className="h-3.5 w-3.5" /> Nexus Manager
        </Link>
      </div>
      <ErrorBox message={error} />
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Edited objects", s.edited_objects],
          ["Created by users", s.created],
          ["Modified", s.modified],
          ["Deleted by users", s.deleted],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-lg border border-line bg-panel px-3 py-2">
            <div className="text-[11px] text-muted">{k}</div>
            <div className="text-lg font-semibold">{v}</div>
          </div>
        ))}
      </div>

      <Card title="Edits">
        <div className="space-y-3 p-4 text-xs">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={c.enabled} onChange={(e) => run("enabled", () => api.config(typeId, { enabled: e.target.checked }))} className="mt-0.5" />
            <span>
              <span className="font-medium">Allow user edits</span>
              <span className="block text-muted">Off: actions, Logic and automations cannot edit {t.display_name}.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={c.history}
              disabled={!c.enabled}
              onChange={async (e) => {
                const on = e.target.checked;
                if (!on && !(await confirmDialog({ message: "Turning off Track user edit history permanently deletes the existing history of this object type.", danger: true, confirmLabel: "Delete history" }))) return;
                await run("history", () => api.config(typeId, { history: on, confirm_delete_history: !on }));
              }}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Track user edit history</span>
              <span className="block text-muted">Every edit with each property&apos;s value before and after, from now on.</span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Conflict resolution</span>
            <select
              value={c.strategy}
              onChange={(e) => run("strategy", () => api.config(typeId, { strategy: e.target.value, timestamp_property: c.timestamp_property ?? tsProps[0]?.api_name ?? "" }))}
              className={fieldClass}
              aria-label="Conflict resolution"
            >
              <option value="user_edits">Apply user edits (default)</option>
              <option value="most_recent">Apply most recent value</option>
            </select>
            {c.strategy === "most_recent" && (
              <select value={c.timestamp_property ?? ""} onChange={(e) => run("ts", () => api.config(typeId, { timestamp_property: e.target.value }))} className={fieldClass} aria-label="Timestamp property">
                {tsProps.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            )}
            <span className="text-muted">
              {c.strategy === "user_edits" ? "An edited property keeps the user's value whatever the datasource says later." : "An edit applies only if newer than the row's timestamp; edit-only properties always."}
            </span>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Edits by property" count={Object.keys(s.by_property).length}>
          <div className="divide-y divide-line text-xs">
            {Object.entries(s.by_property).length === 0 && <div className="p-4 text-muted">No user edits yet.</div>}
            {Object.entries(s.by_property)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => (
                <div key={k} className="flex items-center gap-2 px-4 py-1.5">
                  <span className="flex-1 font-mono">{k}</span>
                  <span className="tabular-nums">{n}</span>
                </div>
              ))}
          </div>
        </Card>
        <Card title="Schema migrations of edits">
          <div className="space-y-2 p-4 text-xs">
            <p className="text-muted">Deleting or retyping a property that has user edits needs one of these first. Dropping edits resets objects to the datasource.</p>
            <div className="flex flex-wrap items-center gap-2">
              <select value={mig.kind} onChange={(e) => setMig({ ...mig, kind: e.target.value })} className={fieldClass} aria-label="Migration">
                <option value="drop_property">Drop property edits</option>
                <option value="move_property">Move property edits</option>
                <option value="cast_property">Cast property edits</option>
              </select>
              <select value={mig.property} onChange={(e) => setMig({ ...mig, property: e.target.value })} className={fieldClass} aria-label="Property">
                <option value="">property…</option>
                {props.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.display_name}
                  </option>
                ))}
              </select>
              {mig.kind === "move_property" && (
                <select value={mig.to} onChange={(e) => setMig({ ...mig, to: e.target.value })} className={fieldClass} aria-label="Move to">
                  <option value="">to…</option>
                  {props.map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              )}
              {mig.kind === "cast_property" && <input value={mig.to} onChange={(e) => setMig({ ...mig, to: e.target.value })} placeholder="old type, e.g. string" className={`${fieldClass} w-36`} />}
              <button type="button" disabled={!mig.property || !!busy} onClick={() => run("migrate", () => api.migrate(typeId, mig))} className={buttonClass.secondary}>
                Run
              </button>
            </div>
            <button
              type="button"
              disabled={!!busy || s.edited_objects === 0}
              onClick={async () => {
                if (await confirmDialog({ message: `Drop all ${s.edited_objects} user edits of ${t.display_name}? Objects reset to the datasource.`, danger: true, confirmLabel: "Drop all edits" }))
                  await run("drop", () => api.migrate(typeId, { kind: "drop_all" }));
              }}
              className={buttonClass.ghost}
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> Drop all edits
            </button>
          </div>
        </Card>
      </div>

      <Card
        title="Materialization"
        action={
          mat?.dataset_id ? (
            <div className="flex gap-2">
              <button type="button" disabled={!!busy} onClick={() => run("build", () => api.build(typeId))} className={buttonClass.secondary}>
                <Icon name="refresh" className="h-3.5 w-3.5" /> {busy === "build" ? "Building…" : "Build now"}
              </button>
              <button type="button" onClick={() => run("stop", () => api.stop(typeId))} className={buttonClass.ghost}>
                Stop
              </button>
            </div>
          ) : (
            <button type="button" disabled={!!busy || !c.enabled} onClick={() => run("materialize", () => api.materialize(typeId, "automatic"))} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> {busy === "materialize" ? "Creating…" : "Create materialized dataset"}
            </button>
          )
        }
      >
        <div className="space-y-2 p-4 text-xs">
          <p className="text-muted">The latest state of every object (datasource and user edits), with columns from the Nexus&apos;s properties, for downstream pipelines and downloads.</p>
          {mat?.dataset_id && (
            <div className="flex flex-wrap items-center gap-3">
              <Link href={`/datasets/${mat.dataset_id}`} className="text-ocean hover:underline">
                Open dataset
              </Link>
              <select value={mat.mode} onChange={(e) => run("mode", () => api.materialize(typeId, e.target.value))} className={fieldClass} aria-label="Build mode">
                <option value="automatic">Automatic (after every edit)</option>
                <option value="periodic">Periodic (re-index or every 6 hours)</option>
              </select>
              <span className="text-muted">
                {mat.rows ?? 0} rows · built {mat.last_built_at ? new Date(mat.last_built_at).toLocaleString() : "never"}
              </span>
              {mat.error && <span className="text-bad">{mat.error}</span>}
            </div>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent user edits" count={s.recent.length}>
          <div className="max-h-80 divide-y divide-line overflow-y-auto text-xs">
            {s.recent.map((r) => (
              <button
                key={r.primary_key}
                type="button"
                onClick={() => {
                  setPk(r.primary_key);
                  api.history(typeId, r.primary_key).then(setHist, (e: Error) => setError(e.message));
                }}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-panel-2"
              >
                <span className={`rounded px-1.5 text-[10px] uppercase ${r.op === "delete" ? "bg-bad/15 text-bad" : r.op === "create" ? "bg-ok/15 text-ok" : "bg-ocean/15 text-ocean"}`}>{r.op}</span>
                <span className="flex-1 truncate font-mono">{r.primary_key}</span>
                <span className="text-muted">{Object.keys(r.properties ?? {}).join(", ")}</span>
              </button>
            ))}
          </div>
        </Card>
        <Card title="Edit history">
          <div className="space-y-2 p-4 text-xs">
            <div className="flex gap-2">
              <input value={pk} onChange={(e) => setPk(e.target.value)} placeholder="Primary key" className={`${fieldClass} flex-1`} />
              <button type="button" disabled={!pk} onClick={() => api.history(typeId, pk).then(setHist, (e: Error) => setError(e.message))} className={buttonClass.secondary}>
                Show
              </button>
            </div>
            {hist && !hist.enabled && <div className="text-muted">Track user edit history is off for this object type.</div>}
            {hist?.entries.map((e, i) => (
              <div key={i} className="rounded-md border border-line p-2">
                <div className="mb-1 flex gap-2 text-muted">
                  <span className="uppercase">{e.op}</span> · {e.user} · {new Date(e.at).toLocaleString()}
                </div>
                {Object.entries(e.changes).map(([k, [a, b]]) => (
                  <div key={k} className="flex items-center gap-2 font-mono">
                    <span className="w-36 truncate text-muted">{k}</span>
                    <span className="truncate text-bad line-through">{show(a)}</span>
                    <Icon name="right" className="h-3 w-3 shrink-0 text-muted" />
                    <span className="truncate text-ok">{show(b)}</span>
                  </div>
                ))}
              </div>
            ))}
            {hist?.enabled && hist.entries.length === 0 && <div className="text-muted">No edits recorded for {pk}.</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}
