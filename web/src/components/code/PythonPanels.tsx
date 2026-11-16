"use client";

/** Python transforms UI pieces: build metrics, data expectation results, the resolved environment (meta.yaml),
 *  Python version support and the Task Runner. */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { codeRepos, type BuildMetrics, type Environment, type ExpectationResult, type JavaTask, type PythonTask, type PythonVersion, type TaskResult, type UpgradePlan } from "@/lib/codeRepos";

// ------------------------------------------------------------------------------------------ metrics

const W = 320;
const H = 96;
const PAD = { l: 34, r: 8, t: 8, b: 18 };

/** One series over time with a dashed requested/limit line. Two of these (memory, CPU) — never one dual-axis chart. */
function MetricChart({ title, unit, points, limit, limitLabel, color, limitColor, duration }: {
  title: string;
  unit: string;
  points: [number, number][];
  limit: number | null;
  limitLabel: string;
  color: string;
  limitColor: string;
  duration: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1e-6, ...points.map((p) => p[1]), limit ?? 0) * 1.1;
  const x = (t: number) => PAD.l + (duration ? (t / duration) * (W - PAD.l - PAD.r) : 0);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const peak = Math.max(0, ...points.map((p) => p[1]));
  const fmtV = (v: number) => (unit === "MB" ? (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v.toFixed(0)} MB`) : `${v.toFixed(2)} cores`);
  const near = hover === null ? null : points.reduce((best, p) => (Math.abs(p[0] - hover) < Math.abs(best[0] - hover) ? p : best), points[0]);
  return (
    <figure className="min-w-0 flex-1">
      <figcaption className="mb-1 flex items-center gap-2 text-[11px]">
        <span className="font-medium text-soft">{title}</span>
        <span className="text-muted">peak {fmtV(peak)}</span>
        {limit !== null && (
          <span className="ml-auto flex items-center gap-1 text-muted">
            <svg width="14" height="4" aria-hidden>
              <line x1="0" y1="2" x2="14" y2="2" stroke={limitColor} strokeWidth="1.5" strokeDasharray="3 2" />
            </svg>
            {limitLabel} {fmtV(limit)}
          </span>
        )}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`${title} over ${duration.toFixed(1)} seconds, peak ${fmtV(peak)}`}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const t = ((e.clientX - r.left) / r.width * W - PAD.l) / (W - PAD.l - PAD.r) * duration;
          setHover(Math.max(0, Math.min(duration, t)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f / 1.1)} y2={y(max * f / 1.1)} stroke="var(--color-line)" strokeWidth="1" />
            <text x={PAD.l - 4} y={y(max * f / 1.1) + 3} textAnchor="end" fontSize="8" fill="var(--color-muted)">
              {unit === "MB" ? (max * f / 1.1 >= 1024 ? `${(max * f / 1.1 / 1024).toFixed(1)}G` : `${(max * f / 1.1).toFixed(0)}`) : (max * f / 1.1).toFixed(1)}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 4} fontSize="8" fill="var(--color-muted)">0 s</text>
        <text x={W - PAD.r} y={H - 4} fontSize="8" textAnchor="end" fill="var(--color-muted)">{duration.toFixed(1)} s</text>
        {limit !== null && <line x1={PAD.l} x2={W - PAD.r} y1={y(limit)} y2={y(limit)} stroke={limitColor} strokeWidth="1.5" strokeDasharray="4 3" />}
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {near && (
          <g>
            <line x1={x(near[0])} x2={x(near[0])} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-line-2)" strokeWidth="1" />
            <circle cx={x(near[0])} cy={y(near[1])} r="3" fill={color} stroke="var(--color-panel)" strokeWidth="2" />
            <text x={Math.min(x(near[0]) + 5, W - 70)} y={PAD.t + 9} fontSize="9" fill="var(--color-soft)">
              {near[0].toFixed(1)} s · {fmtV(near[1])}
            </text>
          </g>
        )}
      </svg>
    </figure>
  );
}

/** The Metrics telemetry of a build: memory against its limit, CPU against the cores requested. */
export function BuildMetricsView({ metrics }: { metrics: BuildMetrics }) {
  const samples = metrics.samples;
  if (samples.length < 2) return null;
  const duration = samples[samples.length - 1][0];
  const memory = samples.map((s) => [s[0], s[1]] as [number, number]);
  const cpu = samples.map((s) => [s[0], s[2]] as [number, number]);
  const hint =
    metrics.memory_mb_limit && metrics.peak_memory_mb > metrics.memory_mb_limit * 0.9
      ? "Memory came close to the limit: raise memory_gb in with_resources."
      : metrics.memory_mb_limit && metrics.peak_memory_mb < metrics.memory_mb_limit * 0.3
        ? "The build used well under its memory request: a smaller memory_gb would do."
        : null;
  return (
    <details className="rounded-md border border-line p-2">
      <summary className="cursor-pointer text-[11px] text-muted">
        Metrics · peak {metrics.peak_memory_mb >= 1024 ? `${(metrics.peak_memory_mb / 1024).toFixed(1)} GB` : `${metrics.peak_memory_mb.toFixed(0)} MB`} memory ·{" "}
        {metrics.peak_cores.toFixed(1)} cores
      </summary>
      <div className="mt-2 flex flex-wrap gap-4">
        <MetricChart title="Memory utilization" unit="MB" points={memory} limit={metrics.memory_mb_limit} limitLabel="limit" color="var(--color-ocean)" limitColor="var(--color-bad)" duration={duration} />
        <MetricChart title="CPU utilization" unit="cores" points={cpu} limit={metrics.cpu_cores} limitLabel="requested" color="var(--color-ocean)" limitColor="var(--color-warn)" duration={duration} />
      </div>
      {hint && <p className="mt-1 text-[11px] text-warn">{hint}</p>}
    </details>
  );
}

// ------------------------------------------------------------------------------------------ expectations

export function ExpectationsList({ items }: { items: ExpectationResult[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium text-soft">Data expectations</div>
      {items.map((e, i) => (
        <div key={`${e.id}${i}`} className="flex items-start gap-1.5 text-[11px]">
          <Icon name={e.ok ? "check" : e.mode === "warn" ? "alert" : "x"} className={`mt-0.5 h-3 w-3 shrink-0 ${e.ok ? "text-ok" : e.mode === "warn" ? "text-warn" : "text-bad"}`} />
          <span className="font-medium text-soft">{e.name ?? e.id}</span>
          <span className="text-muted">
            {e.target_kind === "input" ? "input" : "output"} {e.target} · {e.mode === "warn" ? "WARN" : "FAIL"}
          </span>
          <span className={e.ok ? "text-muted" : e.mode === "warn" ? "text-warn" : "text-bad"}>{e.message}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ environment

export function EnvironmentView({ env }: { env: Environment }) {
  return (
    <div className="space-y-1.5 text-xs">
      <div className="text-xs font-semibold text-soft">
        Environment <span className="font-normal text-muted">{env.file} · Python {env.python}</span>
      </div>
      {env.errors.map((e, i) => (
        <pre key={i} className="whitespace-pre-wrap rounded bg-bad/10 p-1.5 text-bad">{e}</pre>
      ))}
      {env.warnings.map((w, i) => (
        <p key={i} className="rounded bg-warn/10 p-1.5 text-warn">{w}</p>
      ))}
      <ul className="space-y-0.5">
        {env.packages.map((p, i) => (
          <li key={`${p.section}${p.requested}${i}`} className="flex items-center gap-1.5">
            <span className={p.ok ? "text-ok" : "text-bad"}>{p.ok ? "✓" : "✕"}</span>
            <span className="font-mono text-soft">{p.requested}</span>
            <span className="text-muted">{p.section}</span>
            {p.ok && p.version && (
              <span className="text-muted">
                → {p.version}
                {p.source === "library" ? ` (library from ${p.repo_name})` : p.source === "runtime" ? "" : ""}
              </span>
            )}
            {p.ok && p.source === "install" && <span className="text-muted">→ installed in the repository environment ({p.pip})</span>}
          </li>
        ))}
      </ul>
      {env.dedicated && (
        <div className="rounded border border-line-2 p-1.5 text-[11px]">
          <div className="text-soft">
            Repository environment{env.dedicated.python ? ` · Python ${env.dedicated.python}` : " · on top of the platform's packages"}
            <span className="ml-1.5 text-muted">
              {env.dedicated_status?.ready ? "built" : env.dedicated_status?.error ? "failed" : "built by the next check or build"}
            </span>
          </div>
          {env.dedicated_status?.error && <pre className="mt-1 whitespace-pre-wrap text-bad">{env.dedicated_status.error}</pre>}
          {!!env.dedicated_status?.lock?.length && (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted">Locked versions ({env.dedicated_status.lock.length})</summary>
              <pre className="mt-1 max-h-48 overflow-auto font-mono text-muted">{env.dedicated_status.lock.join("\n")}</pre>
            </details>
          )}
        </div>
      )}
      {env.locked && env.libraries.length > 0 && <p className="text-[11px] text-muted">Library versions are locked until meta.yaml changes.</p>}
    </div>
  );
}

const STATUS_TONE: Record<PythonVersion["status"], string> = {
  supported: "text-ok",
  "end of life": "text-warn",
  unsupported: "text-bad",
  "coming soon": "text-muted",
  "in planning": "text-muted",
};

export function PythonVersionTable({ versions }: { versions: PythonVersion[] }) {
  return (
    <table className="w-full text-[11px]">
      <thead className="text-left text-muted">
        <tr>
          <th className="py-0.5 font-normal">Version</th>
          <th className="font-normal">Status</th>
          <th className="font-normal">End of life</th>
          <th className="font-normal">Discontinued</th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.version} className="border-t border-line">
            <td className="py-0.5 font-mono text-soft">
              {v.version}
              {v.runtime && <span className="ml-1 rounded bg-ocean/15 px-1 text-[9px] text-ocean">this runtime</span>}
            </td>
            <td className={STATUS_TONE[v.status]}>{v.status}</td>
            <td className="text-muted">{v.eol_start}</td>
            <td className="text-muted">{v.discontinued}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------------------------------ Task Runner

type TaskDef = { id: JavaTask | PythonTask; usage: string; hint: string; writes?: boolean; packages?: "many" | "one"; args?: string[] };

/** Local preview (Transforms common): Foundry's Gradle tasks, run on the platform. */
const PREVIEW_TASKS: TaskDef[] = [
  { id: "displayTransformsList", usage: "displayTransformsList", hint: "List the transforms and the ids datasetPreview takes." },
  {
    id: "datasetPreview",
    usage: "datasetPreview --transformId=<id> [--printMode=table] [--inputFiles=<alias>:<path>] [--outputFiles=<alias>:<path>]",
    hint: "Preview a transform: a link only you can open for 24 hours, or with --printMode=table the first 10 rows of each dataset.",
    args: ["transformId", "printMode", "inputFiles", "outputFiles"],
  },
];

const PY_TASKS: TaskDef[] = [
  { id: "install", usage: "install --packageSpecs=pandas,scipy <=1.4.0", hint: "Add packages to meta.yaml's run requirements.", writes: true, packages: "many" },
  { id: "uninstall", usage: "uninstall --packageSpecs=numpy", hint: "Remove packages from meta.yaml's run requirements.", writes: true, packages: "many" },
  { id: "whoneeds", usage: "whoneeds --packageSpec=numpy", hint: "Which installed packages require a package.", packages: "one" },
  { id: "formatCode", usage: "formatCode", hint: "Format every Python file with Black (pyproject.toml [tool.black]).", writes: true },
  { id: "test", usage: "test", hint: "Run the tests (pytest)." },
  ...PREVIEW_TASKS,
  { id: "tasks", usage: "tasks", hint: "List the tasks." },
];
const JAVA_TASKS: TaskDef[] = [
  { id: "generateUdfResources", usage: "generateUdfResources", hint: "Generate the UDF classes from the definitions and compile the project." },
  { id: "generateEddieLockfile", usage: "generateEddieLockfile", hint: "Give each UDF its Pipeline Builder id in eddie-lockfile.json (needed to publish).", writes: true },
  { id: "test", usage: "test", hint: "Run the JUnit tests and the UDF examples." },
  ...PREVIEW_TASKS,
];

/** Parse a Task Runner command line: `install --packageSpecs=pandas,scipy <=1.4.0`, `datasetPreview --transformId=x`
 *  (options repeat: `--inputFiles=a:x --inputFiles=b:y`). A leading `./gradlew` is accepted. */
function parseCommand(line: string, tasks: TaskDef[]): { task: TaskDef; packages: string[]; args: Record<string, string> } | string {
  const [name, ...rest] = line.trim().replace(/^(\.\/)?gradlew\s+/, "").split(/\s+/);
  const task = tasks.find((t) => t.id === name);
  if (!task) return `Unknown task "${name}". Run "tasks" to list them.`;
  if (task.args) {
    const args: Record<string, string> = {};
    for (const part of rest) {
      const m = part.match(/^--([A-Za-z]+)=(.*)$/);
      if (!m || !task.args.includes(m[1])) return `Usage: ${task.usage}`;
      args[m[1]] = args[m[1]] ? `${args[m[1]]},${m[2]}` : m[2];
    }
    if (task.id === "datasetPreview" && !args.transformId) return `Usage: ${task.usage}`;
    return { task, packages: [], args };
  }
  const arg = rest.join(" ");
  const m = arg.match(/--packageSpecs?=(.*)$/);
  const packages = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (task.packages && !packages.length) return `Usage: ${task.usage}`;
  return { task, packages, args: {} };
}

/** Task Runner: Python tasks (install, uninstall, whoneeds, formatCode, test) and Java tasks, as buttons or a command line. */
const UPGRADE_ACTION: Record<UpgradePlan["changes"][number]["action"], string> = { add: "added", overwrite: "overwritten", merge: "merged (template keys win)" };

/** … → Upgrade: what upgrading the branch to the current template changes, and the button that opens the upgrade PR. */
export function UpgradeDialog({ repoId, branch, onClose, onOpened }: { repoId: string; branch: string; onClose: () => void; onOpened: (prId: string) => void }) {
  const [plan, setPlan] = useState<UpgradePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    codeRepos.upgradePlan(repoId, branch).then(setPlan, (e: Error) => setError(e.message));
  }, [repoId, branch]);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const pr = await codeRepos.upgrade(repoId, branch);
      onOpened(pr.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Upgrade repository" icon="refresh" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        {!plan && !error && <p className="text-muted">Loading…</p>}
        {error && <p className="whitespace-pre-wrap rounded bg-bad/10 p-2 text-xs text-bad">{error}</p>}
        {plan && !plan.kind && <p className="text-muted">{plan.reason}</p>}
        {plan?.kind && !plan.available && <p className="text-muted">{plan.branch} is up to date (template version {plan.latest}).</p>}
        {plan?.kind && plan.available && (
          <>
            <p className="text-xs text-muted">
              Upgrades <span className="font-mono text-soft">{plan.branch}</span> from template version {plan.current} to {plan.latest} in a pull request. Default files under
              conda_recipe/ and src/ and the build.gradle files are not touched.
            </p>
            <ul className="space-y-1 text-xs">
              {plan.changes.map((c) => (
                <li key={c.path} className="flex items-center gap-2">
                  <span className="font-mono text-soft">{c.path}</span>
                  <span className="text-muted">{UPGRADE_ACTION[c.action]}</span>
                  {c.user_changes && <span className="rounded bg-warn/15 px-1 text-[10px] text-warn">overwrites changes made here</span>}
                </li>
              ))}
            </ul>
            {plan.pull_request ? (
              <p className="text-xs text-muted">
                Pull request #{plan.pull_request.id} is already open{plan.pull_request.upgrade.manual ? ` (${plan.pull_request.upgrade.manual})` : ""}.
              </p>
            ) : (
              <p className="text-xs text-muted">
                {plan.auto_merge ? "Automatic merge of upgrade PRs is on: it merges once its checks pass (unless it overwrites changes made here)." : "Merge it once its checks pass."}
              </p>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Close
          </button>
          {plan?.pull_request && (
            <button type="button" onClick={() => onOpened(plan.pull_request!.id)} className={buttonClass.primary}>
              Open pull request #{plan.pull_request.id}
            </button>
          )}
          {plan?.available && !plan.pull_request && (
            <button type="button" disabled={busy} onClick={open} className={buttonClass.primary}>
              <Icon name={busy ? "refresh" : "transform"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Open upgrade pull request
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function TaskRunnerDialog({ repoId, branch, readOnly, python, java, beforeRun, onClose, onFilesChanged }: {
  repoId: string;
  branch: string;
  readOnly: boolean;
  python: boolean;
  java: boolean;
  beforeRun: () => Promise<void>;
  onClose: () => void;
  onFilesChanged: () => void;
}) {
  const tasks = useMemo(() => {
    const out: TaskDef[] = [];
    if (python) out.push(...PY_TASKS);
    if (java) out.push(...JAVA_TASKS.filter((t) => !(python && (t.id === "test" || PREVIEW_TASKS.some((p) => p.id === t.id)))));
    return out;
  }, [python, java]);
  const [line, setLine] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ command: string; res?: TaskResult; error?: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const run = async (task: TaskDef, packages: string[] = [], args: Record<string, string> = {}) => {
    const command = [task.id, ...(packages.length ? [`--packageSpecs=${packages.join(",")}`] : []), ...Object.entries(args).map(([k, v]) => `--${k}=${v}`)].join(" ");
    setRunning(task.id);
    setResult(null);
    try {
      await beforeRun();
      const res = await codeRepos.task(repoId, branch, task.id, packages, args);
      setResult({ command, res });
      if (res.ok && task.writes && (res.added?.length || res.removed?.length || res.changed?.length || task.id === "generateEddieLockfile")) setChanged(true);
    } catch (e) {
      setResult({ command, error: (e as Error).message });
    } finally {
      setRunning(null);
    }
  };
  const submit = () => {
    const parsed = parseCommand(line, tasks);
    if (typeof parsed === "string") {
      setResult({ command: line, error: parsed });
      return;
    }
    if (parsed.task.writes && readOnly) {
      setResult({ command: line, error: `${parsed.task.id} changes files: this branch is protected (work on another branch).` });
      return;
    }
    run(parsed.task, parsed.packages, parsed.args);
  };
  return (
    <Modal title="Task Runner" icon="keyboard" onClose={() => (changed ? onFilesChanged() : onClose())} wide>
      <div className="space-y-3 p-4 text-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex gap-2"
        >
          <span className="self-center font-mono text-xs text-muted">$</span>
          <input value={line} onChange={(e) => setLine(e.target.value)} placeholder={tasks[0]?.usage ?? "tasks"} className={`${inputClass} font-mono text-xs`} aria-label="Task command" />
          <button type="submit" disabled={!!running || !line.trim()} className={buttonClass.primary}>
            Run
          </button>
        </form>
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs text-soft">{t.usage}</span>
                <span className="block text-[11px] text-muted">{t.hint}</span>
              </span>
              {t.packages || t.args ? (
                <button type="button" onClick={() => setLine(t.args ? `${t.id} --transformId=` : `${t.id} --packageSpec${t.packages === "many" ? "s" : ""}=`)} className={buttonClass.secondary}>
                  Use
                </button>
              ) : (
                <button type="button" disabled={!!running || (t.writes && readOnly)} onClick={() => run(t)} className={buttonClass.secondary}>
                  <Icon name={running === t.id ? "refresh" : "play"} className={`h-3.5 w-3.5 ${running === t.id ? "animate-spin" : ""}`} /> Run
                </button>
              )}
            </li>
          ))}
        </ul>
        {result && (
          <div className="rounded-md border border-line-2 p-2 text-xs">
            <div className={`mb-1 font-mono ${result.error || !result.res?.ok ? "text-bad" : "text-ok"}`}>
              $ {result.command} — {result.error || !result.res?.ok ? "failed" : "succeeded"}
            </div>
            {result.error && <pre className="whitespace-pre-wrap text-bad">{result.error}</pre>}
            {result.res?.error && <pre className="whitespace-pre-wrap text-bad">{result.res.error}</pre>}
            {result.res?.tests && (
              <ul className="space-y-0.5">
                {result.res.tests.map((t, i) => (
                  <li key={i} className={t.ok ? "text-ok" : "text-bad"}>
                    {t.ok ? "✓" : "✗"} {t.file} · {t.name}
                    {t.error && <pre className="ml-4 whitespace-pre-wrap text-muted">{t.error.slice(0, 600)}</pre>}
                  </li>
                ))}
              </ul>
            )}
            {result.res?.uri && (
              <a href={result.res.uri} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-ocean hover:underline">
                <Icon name="external" className="h-3.5 w-3.5" /> Open the dataset preview
              </a>
            )}
            {result.res?.logs && <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-muted">{result.res.logs}</pre>}
            {changed && <p className="mt-1 text-muted">Files changed on {branch}: review and commit them (the editor reloads when you close this).</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
