"use client";

import { useEffect, useMemo, useState } from "react";
import { DiffView } from "@/components/code/DiffView";
import { PythonVersionTable } from "@/components/code/PythonPanels";
import { Icon } from "@/components/Icon";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { codeRepos, type Environment, type FileDiff, type Library, type PythonVersion, type Schedule, type SqlResult, type TestResult, type TransformInfo } from "@/lib/codeRepos";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { fmt, workshop, type DatasetSource } from "@/lib/workshop";

// ------------------------------------------------------------------------------------------ SQL scratchpad

export function SqlPanel() {
  const [query, setQuery] = useState(() => {
    try {
      return localStorage.getItem("code-sql") || "SELECT *\nFROM `My Project/Datapipeline/my_dataset.parquet`\nLIMIT 20";
    } catch {
      return "SELECT 1";
    }
  });
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("code-sql-history") || "[]");
    } catch {
      return [];
    }
  });
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await codeRepos.sql(query));
      const h = [query, ...history.filter((x) => x !== query)].slice(0, 20);
      setHistory(h);
      try {
        localStorage.setItem("code-sql", query);
        localStorage.setItem("code-sql-history", JSON.stringify(h));
      } catch {}
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[45%] min-w-80 flex-col border-r border-line">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-ink p-3 font-mono text-xs text-soft outline-none"
        />
        <div className="flex items-center gap-2 border-t border-line px-2 py-1.5 text-xs">
          <button type="button" onClick={run} disabled={busy} className={buttonClass.primary}>
            <Icon name="play" className="h-3 w-3" /> {busy ? "Running…" : "Run"}
          </button>
          <span className="text-muted">Ctrl+Enter · datasets in `backticks` by path · SQLite syntax</span>
          {history.length > 0 && (
            <select value="" onChange={(e) => e.target.value && setQuery(e.target.value)} className="ml-auto max-w-40 rounded border border-line-2 bg-ink px-1 py-0.5">
              <option value="">History…</option>
              {history.map((h, i) => (
                <option key={i} value={h}>
                  {h.replace(/\s+/g, " ").slice(0, 60)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {error && <pre className="whitespace-pre-wrap p-3 text-xs text-bad">{error}</pre>}
        {result && (
          <>
            <div className="px-3 py-1.5 text-xs text-muted">
              {result.rows.length.toLocaleString()} rows{result.truncated ? " (first 1,000)" : ""} · {result.ms} ms
            </div>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-left text-muted">
                <tr className="border-b border-line">
                  {result.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {result.rows.map((r, i) => (
                  <tr key={i} className="border-b border-line">
                    {result.columns.map((c) => (
                      <td key={c} className="max-w-64 truncate whitespace-nowrap px-3 py-0.5 text-soft">
                        {fmt(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {!result && !error && <p className="p-3 text-xs text-muted">Query datasets in Files without writing a transform.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ tests

export function TestsView({ tests, error, onOpen }: { tests: TestResult[] | null; error?: string | null; onOpen: (file: string) => void }) {
  if (!tests) return <p className="p-3 text-xs text-muted">Test runs the test_* functions in test files (test_*.py, *_test.py).</p>;
  const failed = tests.filter((t) => !t.ok).length;
  return (
    <div className="space-y-1 p-3 text-xs">
      {error && <pre className="whitespace-pre-wrap text-bad">{error}</pre>}
      <div className={failed ? "text-bad" : "text-ok"}>
        {tests.length === 0 ? "No tests found." : failed ? `${failed} of ${tests.length} tests failed` : `✓ All ${tests.length} tests passed`}
      </div>
      {tests.map((t) => (
        <div key={`${t.file}${t.name}`}>
          <button type="button" onClick={() => onOpen(t.file)} className="flex items-center gap-2 hover:underline">
            <span className={t.ok ? "text-ok" : "text-bad"}>{t.ok ? "✓" : "✕"}</span>
            <span className="font-mono text-soft">{t.name}</span>
            <span className="text-muted">
              {t.file} · {t.ms ?? 0} ms
            </span>
          </button>
          {t.error && <pre className="ml-5 whitespace-pre-wrap text-bad">{t.error}</pre>}
          {t.output && <pre className="ml-5 whitespace-pre-wrap text-muted">{t.output}</pre>}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ file changes

export function ChangesPanel({ repoId, branch, version, active }: { repoId: string; branch: string; version: number; active: string | null }) {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [onlyActive, setOnlyActive] = useState(true);
  useEffect(() => {
    let stale = false;
    codeRepos
      .changes(repoId, branch)
      .then((d) => !stale && setDiffs(d))
      .catch(() => !stale && setDiffs([]));
    return () => {
      stale = true;
    };
  }, [repoId, branch, version]);
  if (!diffs) return <p className="p-3 text-xs text-muted">Loading…</p>;
  const shown = onlyActive && active ? diffs.filter((d) => d.path === active) : diffs;
  return (
    <div className="p-3">
      <label className="mb-2 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} className="accent-[var(--color-ocean)]" />
        Only the open file ({diffs.length} files changed since the last commit)
      </label>
      <DiffView files={shown} empty="No uncommitted changes." />
    </div>
  );
}

// ------------------------------------------------------------------------------------------ side panels

/** Libraries: the packages transforms can use (this environment, published Python libraries), what meta.yaml
 *  requests, Add (the Task Runner's install) and the Python version support table. */
export function LibrariesPanel({ files, onAddImport, repoId, branch, readOnly, beforeAdd }: {
  files: Record<string, string>;
  onAddImport?: (name: string) => void;
  repoId?: string;
  branch?: string;
  readOnly?: boolean;
  beforeAdd?: () => Promise<void>;
}) {
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [q, setQ] = useState("");
  const [env, setEnv] = useState<{ environment: Environment | null; python: string; support: PythonVersion[]; library: string | null; consumers: { repo_id: string; repo_name: string; requested: string }[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);
  const [pypi, setPypi] = useState("");
  const hasMeta = Object.keys(files).some((f) => f.endsWith("conda_recipe/meta.yaml"));
  useEffect(() => {
    codeRepos.libraries().then(setLibs).catch(() => setLibs([]));
  }, []);
  useEffect(() => {
    if (!repoId) return;
    codeRepos.environment(repoId, branch).then(setEnv).catch(() => setEnv(null));
  }, [repoId, branch]);
  const requested = useMemo(() => new Set((env?.environment?.packages ?? []).map((p) => p.name.toLowerCase().replace(/[-_.]+/g, "-"))), [env]);
  // the spec meta.yaml has for a package ("mylib 1.1.0", or "mylib" when unpinned)
  const specOf = (name: string) =>
    (env?.environment?.packages ?? []).find((p) => p.section === "run" && p.name.toLowerCase().replace(/[-_.]+/g, "-") === name.toLowerCase().replace(/[-_.]+/g, "-"))?.requested;
  const pin = async (name: string, version: string | null) => {
    if (!repoId || !branch) return;
    setNote(null);
    try {
      await beforeAdd?.();
      await codeRepos.pinLibrary(repoId, branch, name, version);
      window.location.reload();
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const add = async (name: string) => {
    if (!repoId || !branch) return;
    setNote(null);
    try {
      await beforeAdd?.();
      const res = await codeRepos.task(repoId, branch, "install", [name]);
      if (!res.ok) setNote(res.error ?? res.logs);
      else window.location.reload();
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const used = useMemo(() => {
    const set = new Set<string>();
    for (const [p, c] of Object.entries(files))
      if (p.endsWith(".py"))
        for (const m of c.matchAll(/^\s*(?:import|from)\s+([A-Za-z_]\w*)/gm)) set.add(m[1].toLowerCase());
    return set;
  }, [files]);
  const shown = (libs ?? []).filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()) || l.summary.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="border-b border-line px-3 py-2.5 text-sm font-semibold">Libraries</div>
      <p className="px-3 pt-2 text-[11px] text-muted">
        {hasMeta
          ? "Packages transforms can use: installed in the platform's environment, published by Python library repositories, or any package from PyPI (installed into the repository's own environment). Add puts one in meta.yaml's run requirements; Checks resolve them."
          : "Packages installed in the runtime. Transforms can import any of them; add a conda_recipe/meta.yaml to install more."}
      </p>
      {env && (
        <div className="space-y-1 px-3 pt-2 text-[11px]">
          {env.environment?.errors.map((e, i) => (
            <p key={i} className="rounded bg-bad/10 p-1 text-bad">{e}</p>
          ))}
          {env.environment?.warnings.map((w, i) => (
            <p key={i} className="rounded bg-warn/10 p-1 text-warn">{w}</p>
          ))}
          {env.library && (
            <p className="text-muted">
              This repository publishes the library <span className="font-mono text-soft">{env.library}</span> ({env.consumers.length} consuming {env.consumers.length === 1 ? "repository" : "repositories"}).
            </p>
          )}
          {env.library && repoId && (
            <p className="break-all text-muted" title="A conda channel: use it with an API token (Account → API tokens) from outside the platform">
              Conda channel:{" "}
              <span className="font-mono text-soft">
                {typeof window !== "undefined" ? window.location.origin : ""}/api/artifacts/repositories/{repoId}/contents/release/conda
              </span>
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-muted">Python {env.python} · version support</summary>
            <div className="mt-1">
              <PythonVersionTable versions={env.support} />
            </div>
          </details>
        </div>
      )}
      {note && <p className="mx-3 mt-2 whitespace-pre-wrap rounded bg-bad/10 p-1 text-[11px] text-bad">{note}</p>}
      <div className="p-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search packages…" className={`${inputClass} text-xs`} />
      </div>
      {hasMeta && repoId && !readOnly && (
        <form
          className="flex gap-1.5 px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pypi.trim()) void add(pypi.trim());
          }}
        >
          <input
            value={pypi}
            onChange={(e) => setPypi(e.target.value)}
            placeholder="Add from PyPI, e.g. humanize or requests 2.32"
            title="Installed into the repository's own environment with uv (checked now, built by the next Checks)"
            className={`${inputClass} text-xs`}
          />
          <button type="submit" disabled={!pypi.trim()} className={`${buttonClass.secondary} shrink-0 px-2 py-1 text-xs`}>
            Add
          </button>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {libs === null && <p className="p-2 text-xs text-muted">Loading…</p>}
        {shown.slice(0, 200).map((l) => {
          const mod = l.name.toLowerCase().replace(/-/g, "_");
          return (
            <div key={l.name} className="group rounded-md px-2 py-1.5 hover:bg-panel-2">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="truncate text-soft">{l.name}</span>
                <span className="text-[11px] text-muted">{l.version}</span>
                {used.has(mod) && <span className="rounded bg-ok/15 px-1 text-[10px] text-ok">used</span>}
                {l.source === "library" && <span className="rounded bg-sand/15 px-1 text-[10px] text-sand">library</span>}
                {requested.has(l.name.toLowerCase().replace(/[-_.]+/g, "-")) && <span className="rounded bg-ocean/15 px-1 text-[10px] text-ocean">in meta.yaml</span>}
                {l.source === "library" && specOf(l.name) && <span className="font-mono text-[10px] text-muted">{specOf(l.name)}</span>}
                <span className="ml-auto flex gap-2 opacity-0 group-hover:opacity-100">
                  {hasMeta && repoId && !readOnly && l.source === "library" && !!l.versions?.length && (
                    <button type="button" title="Pin a version" onClick={() => setPinning(pinning === l.name ? null : l.name)} className="text-muted hover:text-white">
                      <Icon name="sliders" className="h-3 w-3" />
                    </button>
                  )}
                  {hasMeta && repoId && !readOnly && !requested.has(l.name.toLowerCase().replace(/[-_.]+/g, "-")) && (
                    <button type="button" onClick={() => add(l.name)} className="text-[11px] text-ocean hover:underline">
                      Add
                    </button>
                  )}
                  {onAddImport && (
                    <button type="button" onClick={() => onAddImport(mod)} className="text-[11px] text-ocean hover:underline">
                      import
                    </button>
                  )}
                </span>
              </div>
              {l.summary && <div className="truncate text-[11px] text-muted">{l.summary}</div>}
              {pinning === l.name && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                  <span className="text-muted">Version</span>
                  <select
                    defaultValue={specOf(l.name)?.split(/\s+/)[1] ?? ""}
                    onChange={(e) => void pin(l.name, e.target.value || null)}
                    className={`${inputClass} py-0.5 text-[11px]`}
                  >
                    <option value="">Newest (unpinned, locked until meta.yaml changes)</option>
                    {(l.versions ?? []).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {pinning === l.name && <p className="mt-0.5 text-[10px] text-muted">A pinned version blocks library updates: review it from time to time.</p>}
            </div>
          );
        })}
      </div>
    </>
  );
}

type ScheduleForm = { id?: string; transform: string; every: string; cron: string; timezone: string; onInput: boolean; retries: string; delay: string; enabled: boolean; retrigger: boolean };
const formOf = (s: Schedule): ScheduleForm => ({
  id: s.id,
  transform: s.transform,
  every: s.every_minutes ? String(s.every_minutes) : "",
  cron: s.cron ?? "",
  timezone: s.timezone ?? "UTC",
  onInput: s.on_input_update,
  retries: String(s.retries ?? 0),
  delay: String(s.retry_delay_minutes ?? 5),
  enabled: s.enabled,
  retrigger: !!s.retrigger_until_up_to_date,
});
const STATUS_TONE: Record<string, string> = { succeeded: "text-ok", failed: "text-bad", running: "text-ocean", retrying: "text-warn" };

/** Transform schedules: an interval, a cron expression in a time zone and/or input updates; retries; run now. */
export function SchedulesPanel({ repoId, transforms, schedules, onChanged, protectedDefault }: { repoId: string; transforms: TransformInfo[]; schedules: Schedule[]; onChanged: () => void; protectedDefault: string }) {
  const [form, setForm] = useState<ScheduleForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  // live state (status, next runs) refreshed while the panel is open
  const [live, setLive] = useState<Schedule[] | null>(null);
  const [next, setNext] = useState<string[] | string>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => codeRepos.schedules(repoId).then((l) => alive && setLive(l), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [repoId, schedules, tick]);
  const cron = form?.cron.trim() ?? "";
  const tz = form?.timezone ?? "UTC";
  useEffect(() => {
    if (!cron) return;
    let alive = true;
    const t = setTimeout(
      () =>
        codeRepos.cronPreview(cron, tz).then(
          (r) => alive && setNext(r.next),
          (e: Error) => alive && setNext(e.message),
        ),
      300,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [cron, tz]);
  const list = live ?? schedules;
  const save = async () => {
    if (!form) return;
    setError(null);
    const body = {
      transform: form.transform,
      every_minutes: Number(form.every) || null,
      cron: form.cron.trim() || null,
      timezone: form.timezone || "UTC",
      on_input_update: form.onInput,
      enabled: form.enabled,
      retries: Math.max(0, Math.min(10, Number(form.retries) || 0)),
      retry_delay_minutes: Math.max(0, Number(form.delay) || 0),
      retrigger_until_up_to_date: form.retrigger,
    };
    try {
      if (form.id) await codeRepos.updateSchedule(repoId, form.id, body);
      else await codeRepos.addSchedule(repoId, body);
      setForm(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <div className="flex items-center border-b border-line px-3 py-2.5 text-sm font-semibold">
        <span className="flex-1">Schedules</span>
        <button
          type="button"
          disabled={!transforms.length}
          onClick={() => setForm({ transform: transforms[0]?.key ?? "", every: "", cron: "0 6 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, onInput: false, retries: "1", delay: "5", enabled: true, retrigger: false })}
          className={buttonClass.ghost}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      <p className="px-3 pt-2 text-[11px] text-muted">
        Scheduled builds run the last commit on <span className="font-mono">{protectedDefault}</span>. A failed build is retried; Run now builds with the schedule&apos;s settings.
      </p>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <ErrorBox message={error} />
        {list.length === 0 && !form && <p className="p-2 text-xs text-muted">No schedules.</p>}
        {list.map((s) => (
          <div key={s.id} className="rounded-md border border-line bg-panel-2 p-2 text-xs">
            <div className="flex items-center gap-1.5">
              <Icon name="clock" className={`h-3.5 w-3.5 ${s.enabled ? "text-ocean" : "text-muted"}`} />
              <span className="truncate font-mono text-soft">{s.transform.split("::").pop()}</span>
              <label className="ml-auto flex items-center gap-1 text-muted">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={async (e) => {
                    await codeRepos.updateSchedule(repoId, s.id, { enabled: e.target.checked });
                    onChanged();
                  }}
                  className="accent-[var(--color-ocean)]"
                />
                on
              </label>
              <button type="button" title="Edit" onClick={() => setForm(formOf(s))} className="text-muted hover:text-white">
                <Icon name="pencil" className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Delete"
                onClick={async () => {
                  await codeRepos.deleteSchedule(repoId, s.id);
                  onChanged();
                }}
                className="text-muted hover:text-bad"
              >
                <Icon name="trash" className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-0.5 text-muted">
              {[s.cron ? `cron ${s.cron} (${s.timezone ?? "UTC"})` : "", s.every_minutes ? `every ${s.every_minutes} min` : "", s.on_input_update ? "when an input changes" : ""].filter(Boolean).join(" · ")}
              {s.retries ? ` · ${s.retries} ${s.retries === 1 ? "retry" : "retries"} after ${s.retry_delay_minutes ?? 0} min` : ""}
              {s.retrigger_until_up_to_date ? " · re-triggers until up to date" : ""}
              {s.owner_user && (
                <span className={s.owner_user.status === "active" ? "" : "text-bad"} title="Scheduled builds run as the last user to change the schedule">
                  {` · runs as ${s.owner_user.display_name || s.owner_user.username}${s.owner_user.status !== "active" ? ` (${s.owner_user.status})` : ""}`}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-muted">
              {s.last_status && <span className={STATUS_TONE[s.last_status] ?? ""}>{s.running ? (s.last_status === "retrying" ? "retrying" : "running") : s.last_status}{s.attempt && s.attempt > 1 ? ` (attempt ${s.attempt})` : ""}</span>}
              {s.last_run_at && <span>last {when(s.last_run_at)}</span>}
              {s.enabled && s.next_runs?.[0] && <span>next {when(s.next_runs[0])}</span>}
              <button
                type="button"
                disabled={s.running}
                onClick={async () => {
                  setError(null);
                  try {
                    await codeRepos.runSchedule(repoId, s.id);
                    setTick((t) => t + 1);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                className="ml-auto text-ocean hover:underline disabled:opacity-40"
              >
                Run now
              </button>
            </div>
            {s.last_status === "failed" && s.last_error && <div className="mt-0.5 truncate text-bad" title={s.last_error}>{s.last_error}</div>}
          </div>
        ))}
        {form && (
          <div className="space-y-2 rounded-md border border-ocean/50 p-2 text-xs">
            <select value={form.transform} onChange={(e) => setForm({ ...form, transform: e.target.value })} className={`${fieldClass} w-full`}>
              {transforms.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.function} → {t.output.name}
                  {t.language && t.language !== "python" ? ` (${t.language})` : ""}
                </option>
              ))}
            </select>
            <Field label="Cron (minute hour day month weekday)">
              <input value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} placeholder="0 6 * * 1-5" className={`${fieldClass} w-full font-mono`} />
            </Field>
            {form.cron.trim() && (
              <>
                <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="Time zone, e.g. Asia/Jakarta" className={`${fieldClass} w-full`} />
                <p className="text-muted">next: {typeof next === "string" ? <span className="text-bad">{next}</span> : next.slice(0, 3).map((n) => when(n)).join(" · ")}</p>
              </>
            )}
            <label className="flex items-center gap-2">
              every <input type="number" min={0} value={form.every} onChange={(e) => setForm({ ...form, every: e.target.value })} placeholder="off" className={`${fieldClass} w-20`} /> minutes
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.onInput} onChange={(e) => setForm({ ...form, onInput: e.target.checked })} className="accent-[var(--color-ocean)]" /> when an input dataset changes
            </label>
            <label className="flex items-center gap-2">
              retries <input type="number" min={0} max={10} value={form.retries} onChange={(e) => setForm({ ...form, retries: e.target.value })} className={`${fieldClass} w-14`} /> after
              <input type="number" min={0} value={form.delay} onChange={(e) => setForm({ ...form, delay: e.target.value })} className={`${fieldClass} w-14`} /> min
            </label>
            {(Object.keys(transforms.find((t) => t.key === form.transform)?.transaction_limits ?? {}).length > 0 || form.retrigger) && (
              <label className="flex items-center gap-2" title="The transform limits the transactions it reads per job: build again until its output is up to date with its inputs">
                <input type="checkbox" checked={form.retrigger} onChange={(e) => setForm({ ...form, retrigger: e.target.checked })} className="accent-[var(--color-ocean)]" /> re-trigger until the
                output is up to date (transaction limits)
              </label>
            )}
            <div className="flex justify-end gap-1">
              <button type="button" onClick={() => setForm(null)} className={buttonClass.ghost}>
                Cancel
              </button>
              <button type="button" disabled={!form.cron.trim() && !Number(form.every) && !form.onInput} onClick={save} className={buttonClass.primary}>
                {form.id ? "Save" : "Add schedule"}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------ AIP Assist

export type AiRequest = { mode: "explain" | "bugs" | "error" | "ask"; error?: string; question?: string; selection?: string };

export function AiPanel({ code, path, request, onClose }: { code: string; path: string; request: AiRequest | null; onClose: () => void }) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const ask = async (r: AiRequest) => {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer((await codeRepos.ai({ ...r, code, path })).answer);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const key = request ? JSON.stringify(request) : "";
  useEffect(() => {
    // asked after the render that brought the request (not synchronously inside the effect)
    if (request) void Promise.resolve().then(() => ask(request));
    // re-ask only when a new request arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-sm font-semibold">
        <Icon name="sparkle" className="h-4 w-4 text-ocean" />
        <span className="flex-1">AIP Assist</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-line p-2">
        <button type="button" disabled={busy} onClick={() => ask({ mode: "explain" })} className={buttonClass.secondary}>
          Explain file
        </button>
        <button type="button" disabled={busy} onClick={() => ask({ mode: "bugs" })} className={buttonClass.secondary}>
          Find bugs
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
        {busy && <p className="text-xs text-muted">Thinking…</p>}
        {error && <ErrorBox message={error} />}
        {answer && <div className="md-body text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }} />}
        {!busy && !answer && !error && <p className="text-xs text-muted">Explain code, find bugs, or ask about this file. Errors in Problems, Preview and Build have an “Explain error” button.</p>}
      </div>
      <form
        className="border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) ask({ mode: "ask", question });
        }}
      >
        <textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about this file…" className={`${inputClass} text-xs`} />
      </form>
    </aside>
  );
}

// ------------------------------------------------------------------------------------------ new file from template

type Template = "lightweight" | "transform" | "geospatial" | "test";

export function TemplateWizard({ onClose, onCreate, existing }: { onClose: () => void; onCreate: (path: string, content: string) => void; existing: Record<string, string> }) {
  const [template, setTemplate] = useState<Template>("lightweight");
  const [name, setName] = useState("clean_customers");
  const [inputs, setInputs] = useState<{ name: string; path: string }[]>([{ name: "source_df", path: "" }]);
  const [output, setOutput] = useState("clean_customers");
  const [folder, setFolder] = useState("");
  const [datasets, setDatasets] = useState<DatasetSource[]>([]);
  useEffect(() => {
    workshop
      .sources()
      .then((s) => setDatasets(s.datasets))
      .catch(() => {});
  }, []);
  const ident = (s: string) => /^[A-Za-z_]\w*$/.test(s);
  const path = template === "test" ? `src/test/test_${name}.py` : `src/myproject/datasets/${name}.py`;
  const errors = [
    !ident(name) && "the file name must be a Python identifier",
    existing[path] !== undefined && `${path} already exists`,
    template !== "test" && !output.trim() && "the output needs a name",
    template !== "test" && inputs.some((i) => !ident(i.name)) && "input names must be Python identifiers",
    template !== "test" && new Set(inputs.map((i) => i.name)).size !== inputs.length && "input names must be unique",
    template !== "test" && inputs.some((i) => !i.path) && "pick a dataset for every input",
  ].filter(Boolean) as string[];
  const outputArgs = `"${output}"${folder ? `, folder="${folder}"` : ""}`;
  const content =
    template === "test"
      ? `import pandas as pd\n\n\ndef test_${name}():\n    df = pd.DataFrame({"a": [1, 2]})\n    assert len(df) == 2\n`
      : template === "geospatial"
        ? `from transforms.api import transform_df, Input, Output\nfrom geospatial_tools import geospatial\nfrom geospatial_tools.functions import area, centroid, clean_geometry\n\n\n# geospatial-tools is legacy: Pipeline Builder's geospatial transforms are the current way\n@geospatial()\n@transform_df(\n    Output(${outputArgs}),\n${inputs.map((i) => `    ${i.name}=Input("${i.path}"),`).join("\n")}\n)\ndef compute(${inputs.map((i) => i.name).join(", ")}):\n    df = ${inputs[0]?.name ?? "None"}\n    # source geometries in UTM zone 48S (EPSG:32748): valid GeoJSON in EPSG:4326, then measures in meters\n    df = df.withColumn("geometry", clean_geometry("geometry", "EPSG:32748"))\n    return df.withColumn("area_m2", area("geometry")).withColumn("centroid", centroid("geometry"))\n`
        : template === "lightweight"
        ? `from transforms.api import transform_df, Input, Output\n\n\n@transform_df(\n    Output(${outputArgs}),\n${inputs.map((i) => `    ${i.name}=Input("${i.path}"),`).join("\n")}\n)\ndef compute(${inputs.map((i) => i.name).join(", ")}):\n    df = ${inputs[0]?.name ?? "None"}\n    return df\n`
        : `from transforms.api import transform, Input, Output\n\n\n@transform(\n    output=Output(${outputArgs}),\n${inputs.map((i) => `    ${i.name}=Input("${i.path}"),`).join("\n")}\n)\ndef compute(output, ${inputs.map((i) => i.name).join(", ")}):\n    df = ${inputs[0]?.name ?? "None"}.dataframe()\n    output.write_dataframe(df)\n`;
  return (
    <Modal title="New file from template" icon="doc" onClose={onClose} wide>
      <div className="grid gap-4 p-4 md:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["lightweight", "Lightweight transform", "transform_df: return a DataFrame"],
                ["transform", "Transform with outputs", "transform: write_dataframe()"],
                ["geospatial", "Geospatial (legacy)", "geospatial-tools on Spark: clean, measure, join"],
                ["test", "Unit test", "a test_* function"],
              ] as const
            ).map(([k, label, hint]) => (
              <button key={k} type="button" onClick={() => setTemplate(k)} className={`rounded-lg border p-2 text-left text-xs ${template === k ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                <div className="font-medium text-soft">{label}</div>
                <div className="text-muted">{hint}</div>
              </button>
            ))}
          </div>
          <Field label="File name" hint={path}>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} font-mono`} />
          </Field>
          {template !== "test" && (
            <>
              <div>
                <div className="mb-1 text-xs font-medium text-soft">Inputs</div>
                {inputs.map((inp, i) => (
                  <div key={i} className="mb-1.5 flex gap-1.5">
                    <input value={inp.name} onChange={(e) => setInputs(inputs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${fieldClass} w-28 font-mono`} />
                    <select value={inp.path} onChange={(e) => setInputs(inputs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} className={`${fieldClass} min-w-0 flex-1`}>
                      <option value="">Dataset…</option>
                      {datasets.map((d) => {
                        const p = [...d.path, d.name].join("/");
                        return (
                          <option key={d.id} value={p}>
                            {p}
                          </option>
                        );
                      })}
                    </select>
                    <button type="button" disabled={inputs.length === 1} onClick={() => setInputs(inputs.filter((_, j) => j !== i))} className="text-muted hover:text-bad disabled:opacity-30">
                      <Icon name="x" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button type="button" onClick={() => setInputs([...inputs, { name: `input_${inputs.length + 1}`, path: "" }])} className={buttonClass.ghost}>
                  <Icon name="plus" className="h-3.5 w-3.5" /> Input
                </button>
              </div>
              <Field label="Output dataset name">
                <input value={output} onChange={(e) => setOutput(e.target.value)} className={`${inputClass} font-mono`} />
              </Field>
              <Field label="Output folder (optional)" hint="Default: My Project / Code Repositories / <repository>">
                <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="My Project/Output Data" className={inputClass} />
              </Field>
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="mb-1 text-xs font-medium text-soft">Preview</div>
          <pre className="min-h-64 flex-1 overflow-auto rounded-md bg-ink p-3 font-mono text-xs text-soft">{content}</pre>
          {errors.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-warn">
              {errors.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" disabled={errors.length > 0} onClick={() => onCreate(path, content)} className={buttonClass.primary}>
              Generate file
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
