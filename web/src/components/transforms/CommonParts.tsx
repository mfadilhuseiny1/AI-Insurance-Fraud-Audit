"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { ENV_LABELS, transformsCommon, type BuildEnvironment, type DebugCandidate, type DebugJob, type PreviewDataset, type PreviewFile } from "@/lib/transformsCommon";

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** Spark Details → Environment: the versions a build ran on. */
export function EnvironmentTable({ env, compare }: { env: BuildEnvironment; compare?: BuildEnvironment | null }) {
  const rows = ENV_LABELS.filter(([k]) => env[k] !== undefined && (env[k] !== null || compare?.[k]));
  return (
    <table className="w-full text-left text-xs">
      <tbody>
        {rows.map(([k, label]) => {
          const changed = compare && compare[k] !== env[k];
          return (
            <tr key={k} className="border-b border-line last:border-0">
              <td className="w-56 py-1.5 pr-3 font-mono text-[11px] text-muted">{label}</td>
              <td className={`py-1.5 font-mono ${changed ? "text-warn" : "text-soft"}`}>
                {show(env[k])}
                {changed && <span className="ml-2 text-muted">(was {show(compare?.[k])})</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The first rows of a previewed dataset. */
export function PreviewTable({ columns, rows }: { columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }) {
  if (!columns.length) return <p className="p-3 text-xs text-muted">No columns.</p>;
  return (
    <div className="result-table max-h-[420px] overflow-auto">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} className="bg-panel-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted" title={c.type}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.name} className={`text-xs ${r[c.name] === null || r[c.name] === undefined ? "italic text-muted" : "text-soft"}`}>
                  {r[c.name] === null || r[c.name] === undefined ? "null" : typeof r[c.name] === "object" ? JSON.stringify(r[c.name]) : String(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DatasetView({ d }: { d: PreviewDataset }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs">
        <Icon name={d.kind === "files" ? "folder" : "table"} className="h-4 w-4 text-ocean" />
        <span className="font-medium">{d.alias}</span>
        <span className="text-muted">{d.name}</span>
        <span className="ml-auto text-muted">
          {d.rows === null ? "" : `${d.rows.toLocaleString()} ${d.kind === "files" ? "files" : "rows"}`}
          {d.rows !== null && d.preview.length < d.rows ? ` · first ${d.preview.length}` : ""}
        </span>
      </div>
      <PreviewTable columns={d.columns} rows={d.preview} />
    </div>
  );
}

export function FileView({ f, direction }: { f: PreviewFile; direction: "input" | "output" }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs">
        <Icon name="doc" className="h-4 w-4 text-ocean" />
        <span className="font-mono">
          {f.alias}:{f.path}
        </span>
        <span className="text-muted">{direction} file</span>
        <span className="ml-auto text-muted">
          {typeof f.size === "number" ? `${f.size.toLocaleString()} bytes` : ""}
          {f.truncated ? " · truncated" : ""}
        </span>
      </div>
      {f.kind === "missing" && <p className="p-3 text-xs text-bad">{f.error}</p>}
      {f.kind === "binary" && <p className="p-3 text-xs text-muted">A binary file: download it from Files.</p>}
      {f.kind === "text" && <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-soft">{f.text}</pre>}
      {f.kind === "table" && <PreviewTable columns={f.columns ?? []} rows={f.preview ?? []} />}
    </div>
  );
}

/** Rerun as debug job: the failed build's code on an earlier successful build's environment, as a preview. */
export function DebugJobDialog({ repoId, buildId, onClose, onDone }: { repoId: string; buildId: string; onClose: () => void; onDone?: (job: DebugJob) => void }) {
  const [candidates, setCandidates] = useState<DebugCandidate[] | null>(null);
  const [failedEnv, setFailedEnv] = useState<BuildEnvironment | null>(null);
  const [failedError, setFailedError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<DebugJob | null>(null);
  useEffect(() => {
    transformsCommon.debugCandidates(repoId, buildId).then(
      (r) => {
        setCandidates(r.candidates);
        setFailedEnv(r.build.environment ?? null);
        setFailedError(r.build.error);
        setBaseline(r.candidates[0]?.id ?? "");
      },
      (e: Error) => setError(e.message),
    );
  }, [repoId, buildId]);
  const picked = candidates?.find((c) => c.id === baseline);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await transformsCommon.debug(repoId, buildId, baseline);
      setJob(j);
      onDone?.(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Rerun as debug job" icon="bug" onClose={onClose} wide>
      <div className="space-y-3 p-5 text-xs">
        <p className="text-soft">
          Reruns the failed build&apos;s code on the environment of a previously successful build of the same transform, to confirm whether a change of transforms version is responsible. It runs as a preview:
          nothing is committed to the outputs.
        </p>
        {failedError && <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-bad/30 bg-bad/10 p-2 font-mono text-[11px] text-bad">{failedError}</pre>}
        {!candidates && !error && <p className="text-muted">Loading…</p>}
        {candidates && !candidates.length && <p className="text-muted">This transform has no earlier successful build to compare with.</p>}
        {candidates && candidates.length > 0 && (
          <>
            <label className="block text-muted">
              Previously successful build
              <select value={baseline} onChange={(e) => setBaseline(e.target.value)} className={`${inputClass} mt-1`}>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {when(c.at)} · transforms {c.environment?.sparkModuleVersion ?? "?"}
                    {c.commit ? ` · ${c.commit}` : ""}
                    {c.changes.length ? ` · ${c.changes.length} change${c.changes.length > 1 ? "s" : ""}` : " · same environment"}
                  </option>
                ))}
              </select>
            </label>
            {picked?.environment && failedEnv && (
              <div className="rounded-lg border border-line bg-panel-2 p-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Failed build&apos;s environment (changes from the earlier build in amber)</div>
                <EnvironmentTable env={failedEnv} compare={picked.environment} />
              </div>
            )}
          </>
        )}
        {error && <p className="whitespace-pre-wrap rounded bg-bad/10 p-2 text-bad">{error}</p>}
        {job && (
          <div className={`space-y-2 rounded-lg border p-3 ${job.ok ? "border-ok/30 bg-ok/10" : "border-warn/30 bg-warn/10"}`}>
            <div className={`flex items-center gap-2 font-medium ${job.ok ? "text-ok" : "text-warn"}`}>
              <Icon name={job.ok ? "check" : "alert"} className="h-4 w-4" />
              {job.ok ? "The debug job succeeded" : "The debug job failed"} · ran on {job.ran_on === "current" ? "the current environment" : `environment ${job.ran_on}`}
            </div>
            <p className="text-soft">{job.verdict}</p>
            {job.notes.map((n) => (
              <p key={n} className="text-muted">
                {n}
              </p>
            ))}
            {job.error && <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-bad">{job.error}</pre>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            {job ? "Close" : "Cancel"}
          </button>
          {!job && (
            <button type="button" disabled={busy || !baseline} onClick={start} className={buttonClass.primary}>
              <Icon name={busy ? "refresh" : "bug"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Running debug job…" : "Start debug job"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
