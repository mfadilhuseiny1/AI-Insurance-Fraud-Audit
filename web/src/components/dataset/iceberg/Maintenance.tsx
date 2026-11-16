"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { iceberg, PROCEDURE_LABEL, PROCEDURES, type IcebergTable, type Maintenance, type MaintenanceJob, type MaintenanceTask, type Procedure } from "@/lib/iceberg";

type Draft = { id?: string; name: string; procedure: Procedure; params: Record<string, unknown>; schedule: { enabled: boolean; cron: string; timezone: string } };

const DEFAULT_PARAMS: Record<Procedure, Record<string, unknown>> = {
  rewrite_data_files: { min_input_files: 5, target_file_size_bytes: 536870912, branch: "main" },
  rewrite_manifests: { branch: "main" },
  expire_snapshots: { older_than_days: 5, retain_last: 1 },
  remove_orphan_files: { older_than_days: 3, dry_run: false },
  custom_sql: { sql: "CALL system.rewrite_data_files(table => 'this')" },
};
const blank = (procedure: Procedure = "rewrite_data_files"): Draft => ({ name: "", procedure, params: { ...DEFAULT_PARAMS[procedure] }, schedule: { enabled: false, cron: "0 3 * * *", timezone: "UTC" } });
const STATUS_TONE: Record<MaintenanceJob["status"], string> = { running: "text-ocean", succeeded: "text-ok", failed: "text-bad" };

/** The Maintenance tab: jobs (runs of maintenance tasks), tasks, and the configuration panel for a task. */
export function MaintenanceTab({ t, onChanged }: { t: IcebergTable; onChanged: () => void }) {
  const [m, setM] = useState<Maintenance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const load = useCallback(() => {
    iceberg.maintenance(t.id).then(setM, (e: Error) => setError(e.message));
  }, [t.id]);
  useEffect(load, [load]);
  // running jobs: poll until they finish
  const running = m?.jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => {
      load();
      onChanged();
    }, 1500);
    return () => clearInterval(h);
  }, [running, load, onChanged]);
  if (error && !m) return <p className="m-4 text-sm text-bad">{error}</p>;
  if (!m) return <Loading />;
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: draft.name, procedure: draft.procedure, params: draft.params, schedule: draft.schedule.enabled ? draft.schedule : null };
      if (draft.id) await iceberg.editTask(t.id, draft.id, body);
      else await iceberg.addTask(t.id, body);
      setDraft(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!draft?.id || !(await confirmDialog({ title: "Delete task", message: `Delete "${draft.name || PROCEDURE_LABEL[draft.procedure]}" and its schedule?`, confirmLabel: "Delete", danger: true }))) return;
    await iceberg.deleteTask(t.id, draft.id);
    setDraft(null);
    load();
  };
  const run = async (task: MaintenanceTask) => {
    if (task.procedure === "expire_snapshots" && !(await confirmDialog({ title: "Expire snapshots", message: "Expired snapshots cannot be restored: rollback and time travel to them stop working, and incremental consumers that still need them are affected.", confirmLabel: "Run" })))
      return;
    try {
      await iceberg.runTask(t.id, task.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const tasks = m.tasks;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto p-4 text-sm">
        {m.protected && (
          <p className="mb-3 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
            Main branch protection is on: maintenance tasks need the Owner role (iceberg:bypass-branch-protection) besides the maintenance operations.
          </p>
        )}
        {!m.can_write && <p className="mb-3 text-xs text-muted">You can read this table&apos;s maintenance tasks; writing them needs the Editor role (iceberg:write-maintenance-tasks).</p>}
        {error && <p className="mb-3 text-xs text-bad">{error}</p>}
        <section className="mb-4 rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="font-medium">Tasks</span>
            <span className="text-xs text-muted">{tasks.length}</span>
            <button type="button" disabled={!m.can_write} onClick={() => setDraft(blank())} className={`${buttonClass.primary} ml-auto py-1 text-xs`}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add task
            </button>
          </div>
          {tasks.length === 0 && <p className="px-3 py-4 text-xs text-muted">No maintenance tasks yet. Add compaction, snapshot expiration, orphan file cleanup or Custom SQL.</p>}
          {tasks.map((task) => (
            <div key={task.id} className={`flex items-center gap-3 border-b border-line px-3 py-2 text-xs last:border-0 ${draft?.id === task.id ? "bg-ocean/10" : ""}`}>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() =>
                  setDraft({ id: task.id, name: task.name, procedure: task.procedure, params: { ...task.params }, schedule: task.schedule ?? { enabled: false, cron: "0 3 * * *", timezone: "UTC" } })
                }
              >
                <span className="block font-medium text-soft">{task.name}</span>
                <span className="block text-muted">
                  {PROCEDURE_LABEL[task.procedure]}
                  {task.category !== "form" && ` · ${task.category === "data-altering" ? "data-altering SQL" : "SQL"}`}
                  {task.schedule?.enabled ? ` · scheduled ${task.schedule.cron} (${task.schedule.timezone})` : " · no schedule"}
                </span>
              </button>
              <button type="button" disabled={!m.can_write} onClick={() => run(task)} className={`${buttonClass.secondary} py-1 text-xs`}>
                <Icon name="play" className="h-3 w-3" /> Run now
              </button>
            </div>
          ))}
        </section>
        <section className="rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="font-medium">Jobs</span>
            <button type="button" onClick={load} className="ml-auto text-muted hover:text-white" title="Refresh">
              <Icon name="refresh" className="h-3.5 w-3.5" />
            </button>
          </div>
          {m.jobs.length === 0 && <p className="px-3 py-4 text-xs text-muted">No maintenance runs yet.</p>}
          {m.jobs.map((j) => {
            const task = tasks.find((x) => x.id === j.task_id);
            return (
              <div key={j.id} className="border-b border-line px-3 py-2 text-xs last:border-0">
                <button type="button" onClick={() => setOpenJob(openJob === j.id ? null : j.id)} className="flex w-full items-center gap-3 text-left">
                  <span className={`w-20 font-medium capitalize ${STATUS_TONE[j.status]}`}>{j.status}</span>
                  <span className="min-w-0 flex-1 truncate text-soft">{task?.name ?? PROCEDURE_LABEL[j.procedure]}</span>
                  <span className="text-muted">{j.trigger === "schedule" ? "scheduled" : j.user}</span>
                  <span className="w-28 text-right text-muted">{when(j.started_at)}</span>
                  <span className="w-14 text-right text-muted">{j.seconds !== undefined ? `${j.seconds}s` : ""}</span>
                  <Icon name={openJob === j.id ? "down" : "right"} className="h-3 w-3 text-muted" />
                </button>
                {openJob === j.id && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-ink p-2 font-mono text-[11px] text-soft">{j.error ?? JSON.stringify(j.result, null, 2)}</pre>
                )}
              </div>
            );
          })}
        </section>
      </div>
      {draft && (
        <TaskPanel
          draft={draft}
          setDraft={setDraft}
          drDays={m.dr_lookback_days}
          busy={busy}
          canWrite={m.can_write}
          onSave={save}
          onDelete={draft.id ? remove : undefined}
          onClose={() => setDraft(null)}
          branches={t.branches.filter((b) => b.type === "branch").map((b) => b.name)}
        />
      )}
    </div>
  );
}

function TaskPanel({
  draft,
  setDraft,
  drDays,
  busy,
  canWrite,
  onSave,
  onDelete,
  onClose,
  branches,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  drDays: number;
  busy: boolean;
  canWrite: boolean;
  onSave: () => void;
  onDelete?: () => void;
  onClose: () => void;
  branches: string[];
}) {
  const p = draft.params;
  const set = (k: string, v: unknown) => setDraft({ ...draft, params: { ...p, [k]: v } });
  const num = (k: string, label: string, hint?: string) => (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input type="number" value={p[k] === undefined || p[k] === null ? "" : String(p[k])} onChange={(e) => set(k, e.target.value === "" ? null : Number(e.target.value))} className={`${inputClass} py-1 text-xs`} />
      {hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
  const spec = PROCEDURES.find((x) => x.id === draft.procedure)!;
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel text-sm">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 font-medium">
        {draft.id ? "Edit task" : "Add task"}
        <button type="button" onClick={onClose} className="ml-auto text-muted hover:text-white">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <label className="block">
          <span className="text-xs text-muted">Procedure</span>
          <select value={draft.procedure} onChange={(e) => setDraft({ ...blank(e.target.value as Procedure), id: draft.id, name: draft.name, schedule: draft.schedule })} className={`${inputClass} py-1 text-xs`}>
            {PROCEDURES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-muted">{spec.hint}</span>
        </label>
        <label className="block">
          <span className="text-xs text-muted">Name</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={spec.label} className={`${inputClass} py-1 text-xs`} />
        </label>
        {(draft.procedure === "rewrite_data_files" || draft.procedure === "rewrite_manifests") && (
          <label className="block">
            <span className="text-xs text-muted">Branch</span>
            <select value={String(p.branch ?? "main")} onChange={(e) => set("branch", e.target.value)} className={`${inputClass} py-1 text-xs`}>
              {(branches.length ? branches : ["main"]).map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
        )}
        {draft.procedure === "rewrite_data_files" && (
          <>
            {num("target_file_size_bytes", "Target file size (bytes)", "write.target-file-size-bytes: 512 MiB by default")}
            {num("min_input_files", "Minimum input files", "Skip the rewrite when the branch has fewer data and delete files")}
          </>
        )}
        {draft.procedure === "expire_snapshots" && (
          <>
            {num("retain_last", "Minimum snapshots to retain", "Kept on every branch regardless of age (history.expire.min-snapshots-to-keep when empty)")}
            {num("older_than_days", "Minimum age to retain (days)", "Snapshots newer than this are kept regardless of count (history.expire.max-snapshot-age-ms when empty)")}
            <p className="rounded-md border border-bad/40 bg-bad/5 p-2 text-[11px] text-bad">
              Expired snapshots cannot be restored. Their files are not deleted at once: physical deletion is deferred to orphan file removal outside the {drDays}-day
              disaster recovery window.
            </p>
          </>
        )}
        {draft.procedure === "remove_orphan_files" && (
          <>
            {num("older_than_days", "Older than (days)", `Files are deleted only when older than this and the ${drDays}-day disaster recovery lookback window`)}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!p.dry_run} onChange={(e) => set("dry_run", e.target.checked)} /> Dry run (list orphan files only)
            </label>
          </>
        )}
        {draft.procedure === "custom_sql" && (
          <label className="block">
            <span className="text-xs text-muted">SQL (the table is named this, by its RID or by any identifier)</span>
            <textarea value={String(p.sql ?? "")} onChange={(e) => set("sql", e.target.value)} rows={8} className={`${inputClass} font-mono text-[11px]`} spellCheck={false} />
            <span className="mt-1 block text-[11px] text-muted">
              CALL system.rewrite_data_files / rewrite_manifests / expire_snapshots(older_than =&gt; TIMESTAMP &apos;…&apos;, retain_last =&gt; n) / remove_orphan_files /
              rollback_to_snapshot(snapshot_id =&gt; n); ALTER TABLE this SET TBLPROPERTIES (&apos;k&apos; = &apos;v&apos;), ADD / RENAME / DROP COLUMN, CREATE / DROP BRANCH or TAG;
              INSERT INTO this VALUES (…); UPDATE this SET c = expr WHERE …; DELETE FROM this WHERE …;
              MERGE INTO this t USING `/path/source` s ON t.id = s.id WHEN MATCHED THEN UPDATE SET … WHEN NOT MATCHED THEN INSERT *. Statements that change rows need
              iceberg:write-data-altering-maintenance-tasks.
            </span>
          </label>
        )}
        <div className="rounded-md border border-line p-2">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={draft.schedule.enabled} onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, enabled: e.target.checked } })} /> Schedule information
          </label>
          {draft.schedule.enabled && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] text-muted">Cron</span>
                <input value={draft.schedule.cron} onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, cron: e.target.value } })} className={`${fieldClass} w-full py-1 font-mono text-xs`} />
              </label>
              <label className="block">
                <span className="text-[11px] text-muted">Time zone</span>
                <input value={draft.schedule.timezone} onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, timezone: e.target.value } })} className={`${fieldClass} w-full py-1 text-xs`} />
              </label>
              <span className="col-span-2 text-[11px] text-muted">Five fields: minute hour day-of-month month day-of-week. Needs iceberg:schedule-maintenance-tasks.</span>
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line p-3">
        {onDelete && (
          <button type="button" disabled={!canWrite} onClick={onDelete} className={`${buttonClass.ghost} text-bad`}>
            <Icon name="trash" className="h-3.5 w-3.5" /> Delete task
          </button>
        )}
        <button type="button" disabled={busy || !canWrite} onClick={onSave} className={`${buttonClass.primary} ml-auto`}>
          {draft.id ? "Save task" : "Add task"}
        </button>
      </div>
    </aside>
  );
}
