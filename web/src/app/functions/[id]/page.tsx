"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { KIND_LABEL, ResultView, signature, TelemetryView } from "@/components/functions/parts";
import { BranchReleases } from "@/components/functions/BranchReleases";
import { FunctionBranch } from "@/components/functions/FunctionBranch";
import { AppHeader, Badge, Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import { branchRuns, type FnRunBranch, type FunctionOnBranch } from "@/lib/branchRuns";
import { om, type BranchRow } from "@/lib/ontologyModel";
import { FAILURE_LABEL, functions, type FnResult, type FnRun, type FunctionDetail, type Telemetry } from "@/lib/actions";

/** a run that happened on a global Nexus branch names it */
type BranchFnRun = FnRun & { branch?: FnRunBranch };
type Tab = "overview" | "run" | "versions" | "monitoring" | "sources" | "aliases";
const TABS: [Tab, string, IconName][] = [
  ["overview", "Overview", "home"],
  ["run", "Run", "play"],
  ["versions", "Versions & configuration", "history"],
  ["monitoring", "Metrics, runs & performance", "gauge"],
  ["sources", "Sources", "plug"],
  ["aliases", "Aliases", "link"],
];
// a model function has no repository: no repository versions, sources or aliases
const MODEL_TABS: Tab[] = ["overview", "run", "monitoring"];
const USAGE_HREF: Record<string, (id: string) => string> = {
  action_type: (id) => `/ontology/action-types/${id}`,
  automation: (id) => `/automate/${id}`,
  workshop: (id) => `/workshop/${id}`,
};
const USAGE_LABEL: Record<string, string> = { action_type: "Action type", automation: "Automation", workshop: "Workshop module" };

/** A published function: signature and usage, a run console, versions with per-version configuration, metrics, monitors and the repository's aliases. */
export default function FunctionPage() {
  const { id } = useParams<{ id: string }>();
  const [f, setF] = useState<FunctionDetail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    functions.get(id).then(setF, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  if (error && !f) return <ApiError message={error} />;
  if (!f) return <Loading />;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Functions" icon="code" href="/functions" crumbs={[{ label: f.name }]} />
      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          {TABS.filter(([k]) => f.source !== "model" || MODEL_TABS.includes(k)).map(([k, label, icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left ${tab === k ? "bg-panel-2 text-white" : "text-soft hover:bg-panel-2"}`}>
              <Icon name={icon} className="h-4 w-4" /> {label}
            </button>
          ))}
        </nav>
        <section className="min-w-0 flex-1 space-y-4 overflow-y-auto p-6">
          <div>
            <h1 className="text-xl font-semibold">{f.name}</h1>
            <p className="mt-1 font-mono text-xs text-soft">{signature(f)}</p>
          </div>
          {tab === "overview" && <Overview f={f} />}
          {tab === "run" && <Run f={f} />}
          {tab === "versions" && <Versions f={f} reload={load} />}
          {tab === "versions" && <BranchReleases f={f} />}
          {tab === "versions" && f.repo_id && <FunctionBranch f={f} />}
          {tab === "monitoring" && <Monitoring f={f} reload={load} />}
          {tab === "sources" && <Sources f={f} />}
          {tab === "aliases" && <Aliases repoId={f.repo_id} />}
        </section>
      </div>
    </div>
  );
}

function Overview({ f }: { f: FunctionDetail }) {
  return (
    <>
      <Card title="Details">
        <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-[160px_1fr]">
          <dt className="text-muted">Kind</dt>
          <dd>{KIND_LABEL[f.kind]}</dd>
          {f.api_name && (
            <>
              <dt className="text-muted">API name</dt>
              <dd className="font-mono">{f.api_name}</dd>
            </>
          )}
          <dt className="text-muted">Latest version</dt>
          <dd className="font-mono">
            {f.version} <span className="font-sans text-xs text-muted">· {when(f.released_at)}</span>
          </dd>
          <dt className="text-muted">{f.source === "model" ? "Model deployment" : "Repository"}</dt>
          <dd>
            {f.source === "model" ? (
              f.deployment_href ? <Link href={f.deployment_href} className="text-ocean hover:underline">{f.deployment}</Link> : f.deployment
            ) : (
              <>
                <Link href={f.source === "sql" ? `/sql-studio?worksheet=${f.worksheet_id}` : `/code-repositories/${f.repo_id}`} className="text-ocean hover:underline">
                  {f.repository}
                </Link>{" "}
                <span className="text-xs text-muted">
                  {f.file}:{f.line}
                </span>
              </>
            )}
          </dd>
          {f.edits && (
            <>
              <dt className="text-muted">Edits object types</dt>
              <dd>{f.edits.join(", ") || "—"}</dd>
            </>
          )}
          {!!f.sources?.length && (
            <>
              <dt className="text-muted">Sources</dt>
              <dd>{f.sources.join(", ")}</dd>
            </>
          )}
          {!!f.errors?.length && (
            <>
              <dt className="text-muted">Declared errors</dt>
              <dd>
                {f.errors.map((e) => (
                  <div key={e.name}>
                    <span className="font-mono">{e.name}</span>
                    {e.doc && <span className="text-xs text-muted"> — {e.doc}</span>}
                  </div>
                ))}
              </dd>
            </>
          )}
          {f.output.startsWith("stream<") && (
            <>
              <dt className="text-muted">Output</dt>
              <dd>Streamed: chunks arrive as the function yields them</dd>
            </>
          )}
          <dt className="text-muted">RID</dt>
          <dd className="break-all font-mono text-xs">{f.rid}</dd>
        </dl>
        {f.doc && <p className="whitespace-pre-wrap border-t border-line px-4 py-3 text-sm text-soft">{f.doc}</p>}
      </Card>
      <Card title="Inputs and output">
        <table className="w-full text-sm">
          <tbody>
            {f.inputs.map((i) => (
              <tr key={i.name} className="border-b border-line">
                <td className="px-4 py-2 font-mono">{i.name}</td>
                <td className="px-4 py-2 font-mono text-xs text-soft">{i.type}</td>
                <td className="px-4 py-2 text-xs text-muted">{i.required ? "Required" : `Optional${i.default !== undefined ? ` · default ${JSON.stringify(i.default)}` : ""}`}</td>
              </tr>
            ))}
            <tr>
              <td className="px-4 py-2 text-muted">Output</td>
              <td className="px-4 py-2 font-mono text-xs text-soft" colSpan={2}>
                {f.output}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
      <Card title="Used by" count={f.usage.length}>
        <div className="divide-y divide-line text-sm">
          {f.usage.map((u) => (
            <Link key={`${u.kind}:${u.id}`} href={USAGE_HREF[u.kind]?.(u.id) ?? "#"} className="flex items-center gap-3 px-4 py-2 hover:bg-panel-2">
              <span className="w-32 text-xs text-muted">{USAGE_LABEL[u.kind] ?? u.kind}</span>
              {u.name}
              <span className="ml-auto font-mono text-xs text-muted">{u.version || "latest"}</span>
            </Link>
          ))}
          {f.usage.length === 0 && <p className="px-4 py-3 text-xs text-muted">Not used by any action type, automation or Workshop module yet.</p>}
        </div>
      </Card>
    </>
  );
}

function Run({ f }: { f: FunctionDetail }) {
  const [version, setVersion] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(f.inputs.map((i) => [i.name, i.default !== undefined ? JSON.stringify(i.default) : ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<(FnResult & { branch?: FnRunBranch }) | null>(null);
  const [chunks, setChunks] = useState<unknown[]>([]);
  const streaming = f.output.startsWith("stream<");
  // run on a global Nexus branch: its Branched pre-release (else the main versions it sees) and its objects
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState("");
  const [onBranch, setOnBranch] = useState<FunctionOnBranch | null>(null);
  useEffect(() => {
    if (f.repo_id) om.branches({ status: "open" }).then(setBranches, () => setBranches([]));
  }, [f.repo_id]);
  const pickBranch = (id: string) => {
    setBranchId(id);
    setVersion("");
    setOnBranch(null);
    setError(null);
    if (id) branchRuns.functionOn(id, f.id).then((d) => setOnBranch(d.branch ?? null), (e) => setError((e as Error).message));
  };
  const parse = (s: string) => {
    if (s.trim() === "") return null;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const inputs = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, parse(v)]));
      setRes(null);
      setChunks([]);
      if (branchId) setRes(await branchRuns.executeFunction(branchId, f.id, inputs, version || undefined));
      else setRes(streaming ? await functions.stream(f.id, inputs, version || undefined, (c) => setChunks((cur) => [...cur, c])) : await functions.execute(f.id, inputs, version || undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Run console">
      <form
        className="space-y-3 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <p className="text-xs text-muted">Values are JSON (strings may be typed bare). Object inputs take the primary key. Nexus edits are returned, not applied: apply them through a function-backed action type.</p>
        {f.inputs.map((i) => (
          <Field key={i.name} label={`${i.name}${i.required ? " *" : ""}`} hint={i.type}>
            <input value={values[i.name] ?? ""} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} className={`${inputClass} font-mono`} />
          </Field>
        ))}
        {branches.length > 0 && (
          <Field label="Branch" hint="run on a global Nexus branch: its Branched pre-release of this function (else the main versions it sees) and the branch's objects">
            <select value={branchId} onChange={(e) => pickBranch(e.target.value)} className={inputClass} aria-label="Branch">
              <option value="">Main</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {branchId && onBranch && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="branch-resolves">
            <Icon name="split" className="h-3.5 w-3.5 text-sand" /> On {onBranch.name ?? "this branch"} the function runs
            <span className="font-mono text-soft">{onBranch.resolves.version ?? "no version"}</span>
            {onBranch.resolves.branched ? <Badge status="paused" label="Branched pre-release" /> : <Badge status="example" label="Main version" />}
            {onBranch.newer_on_main.length > 0 && <span>· newer on main: {onBranch.newer_on_main.join(", ")} (rebase the branch to use them)</span>}
          </p>
        )}
        <Field label="Version" hint="Exact version or range such as ^1.0.0; empty runs the latest stable release (on a branch: its Branched pre-release)">
          <select value={version} onChange={(e) => setVersion(e.target.value)} className={inputClass} aria-label="Version">
            <option value="">Latest</option>
            {(branchId && onBranch ? f.versions.filter((v) => onBranch.visible_versions.includes(v.version)) : f.versions).map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" disabled={busy} className={buttonClass.primary}>
          <Icon name="play" className="h-3.5 w-3.5" /> {busy ? "Running…" : branchId ? "Run on branch" : "Run"}
        </button>
        <ErrorBox message={error} />
        {res?.branch && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="ran-on-branch">
            <Icon name="split" className="h-3.5 w-3.5 text-sand" /> Ran on the branch {res.branch.name ?? res.branch.id}:
            <span className="font-mono text-soft">{res.version}</span>
            {res.branch.branched ? <Badge status="paused" label="Branched pre-release" /> : <Badge status="example" label="Main version" />}
          </p>
        )}
        {streaming && chunks.length > 0 && !res && (
          <pre className="whitespace-pre-wrap rounded-md bg-panel-2 p-2 text-xs">{chunks.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("")}</pre>
        )}
        {res && (
          <ResultView ok={res.ok} value={res.value} edits={res.edits} error={res.error} logs={res.logs} ms={res.ms} version={res.version} errorName={res.error_name} telemetry={res.telemetry} />
        )}
      </form>
    </Card>
  );
}

function Versions({ f, reload }: { f: FunctionDetail; reload: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [cfg, setCfg] = useState<{ timeout_s?: number; memory_mb?: number; snapshots?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const save = async (version: string) => {
    setError(null);
    try {
      await functions.config(f.id, version, { timeout_s: cfg.timeout_s ?? null, memory_mb: cfg.memory_mb ?? null, snapshots: cfg.snapshots ?? null });
      setEditing(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Versions" count={f.versions.length}>
      <ErrorBox message={error} />
      <div className="divide-y divide-line text-sm">
        {f.versions.map((v) => {
          const c = f.config[v.version] ?? {};
          return (
            <div key={v.version} className="space-y-1 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="font-mono font-medium">{v.version}</span>
                {v.version.includes("-") && <Badge status="paused" label="Pre-release" />}
                <span className="text-xs text-muted">
                  {when(v.at)}
                  {v.by ? ` · ${v.by}` : ""} · commit <span className="font-mono">{v.commit.slice(0, 8)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(v.version);
                    setCfg(c);
                  }}
                  className="ml-auto text-xs text-ocean hover:underline"
                >
                  Configure
                </button>
              </div>
              <div className="font-mono text-xs text-soft">{signature(v.signature)}</div>
              <div className="text-xs text-muted">
                Timeout {c.timeout_s ?? "default"} s · memory {c.memory_mb ?? "default"} MB · snapshots {c.snapshots ?? "default"}
              </div>
              {v.breaking.map((b) => (
                <div key={b.change} className="text-xs text-warn">
                  Breaking: {b.change}
                </div>
              ))}
              {editing === v.version && (
                <div className="flex flex-wrap items-end gap-2 pt-2 text-xs">
                  <Field label="Timeout (s)">
                    <input type="number" value={cfg.timeout_s ?? ""} onChange={(e) => setCfg({ ...cfg, timeout_s: e.target.value ? Number(e.target.value) : undefined })} className={`${fieldClass} w-24`} />
                  </Field>
                  <Field label="Memory (MB)">
                    <input type="number" step={512} value={cfg.memory_mb ?? ""} onChange={(e) => setCfg({ ...cfg, memory_mb: e.target.value ? Number(e.target.value) : undefined })} className={`${fieldClass} w-28`} />
                  </Field>
                  <Field label="Snapshots">
                    <select value={cfg.snapshots ?? ""} onChange={(e) => setCfg({ ...cfg, snapshots: e.target.value || undefined })} className={fieldClass}>
                      <option value="">Default</option>
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </Field>
                  <button type="button" onClick={() => save(v.version)} className={buttonClass.primary}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className={buttonClass.secondary}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Monitoring({ f, reload }: { f: FunctionDetail; reload: () => void }) {
  const m = f.metrics;
  const [mons, setMons] = useState(f.monitors);
  const [runs, setRuns] = useState<FnRun[]>([]);
  const [detail, setDetail] = useState<(FnRun & { telemetry: Telemetry | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    functions.runs(f.id).then(setRuns, () => setRuns([]));
  }, [f.id]);
  const max = Math.max(1, ...m.by_day.map((d) => d.succeeded + d.failed));
  const save = async () => {
    setError(null);
    try {
      await functions.monitors(f.id, mons);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <Card title="Metrics (30 days)">
        <div className="grid gap-4 p-4 text-sm md:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted">Succeeded</span>
              <span className="tabular-nums text-ok">{m.succeeded}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Failed</span>
              <span className="tabular-nums text-bad">{m.failed}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">P95 duration</span>
              <span className="tabular-nums">{m.p95_ms != null ? `${m.p95_ms} ms` : "—"}</span>
            </div>
            {Object.entries(m.failures_by_category).map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-muted">{FAILURE_LABEL[k] ?? k}</span>
                <span className="tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          <div className="flex h-32 items-end gap-1">
            {m.by_day.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col justify-end" title={`${d.day}: ${d.succeeded} succeeded, ${d.failed} failed`}>
                <div className="bg-bad/70" style={{ height: `${(d.failed / max) * 100}%` }} />
                <div className="bg-ok/70" style={{ height: `${(d.succeeded / max) * 100}%` }} />
              </div>
            ))}
            {!m.by_day.length && <span className="text-xs text-muted">No runs yet</span>}
          </div>
        </div>
      </Card>
      <Card
        title="Monitors"
        action={
          <button type="button" onClick={save} className={buttonClass.secondary}>
            Save monitors
          </button>
        }
      >
        <div className="space-y-2 p-4 text-sm">
          {mons.map((mo, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <select value={mo.kind} onChange={(e) => setMons(mons.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))} className={`${fieldClass} py-1 text-xs`}>
                <option value="p95_ms">Duration p95 (ms) above</option>
                <option value="failures">Failures above</option>
                <option value="user_facing_failures">User-facing failures above</option>
                <option value="other_failures">Other failures above</option>
              </select>
              <input type="number" value={mo.threshold} onChange={(e) => setMons(mons.map((x, j) => (j === i ? { ...x, threshold: Number(e.target.value) } : x)))} className={`${fieldClass} w-24 py-1 text-xs`} />
              <span className="text-muted">over the last</span>
              <input type="number" value={mo.window_minutes} onChange={(e) => setMons(mons.map((x, j) => (j === i ? { ...x, window_minutes: Number(e.target.value) } : x)))} className={`${fieldClass} w-20 py-1 text-xs`} />
              <span className="text-muted">minutes</span>
              <button type="button" onClick={() => setMons(mons.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setMons([...mons, { kind: "failures", threshold: 5, window_minutes: 60 }])} className="text-xs text-ocean hover:underline">
            + Add monitor
          </button>
          <ErrorBox message={error} />
          {m.alerts.length > 0 && (
            <div className="space-y-1 border-t border-line pt-2 text-xs">
              {m.alerts.map((a, i) => (
                <div key={i} className={a.resolved_at ? "text-muted" : "text-warn"}>
                  {a.monitor}: {a.value ?? "—"} (threshold {a.threshold}) · {when(a.at)}
                  {a.resolved_at ? ` · resolved ${when(a.resolved_at)}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
      <Card title="Recent runs (7 days)" count={runs.length}>
        <table className="w-full text-xs">
          <tbody>
            {runs.slice(0, 100).map((r, i) => (
              <tr
                key={i}
                onClick={() => r.id && functions.runDetail(f.id, r.id).then(setDetail, () => setDetail(null))}
                className={`border-b border-line last:border-0 ${r.id ? "cursor-pointer hover:bg-panel-2" : ""} ${detail?.id && detail.id === r.id ? "bg-panel-2" : ""}`}
              >
                <td className="px-4 py-1.5">
                  <Badge status={r.status} />
                </td>
                <td className="px-4 py-1.5 text-muted">{when(r.at)}</td>
                <td className="px-4 py-1.5 font-mono">
                  {r.version}
                  {(r as BranchFnRun).branch && (
                    <span className="ml-2 rounded bg-sand/15 px-1.5 font-sans text-[11px] text-sand" data-testid="run-branch">
                      {(r as BranchFnRun).branch?.name ?? (r as BranchFnRun).branch?.id}
                    </span>
                  )}
                </td>
                <td className="px-4 py-1.5 tabular-nums">{r.ms} ms</td>
                <td className="px-4 py-1.5 text-muted">{r.resource ?? "console"}</td>
                <td className="px-4 py-1.5 tabular-nums text-muted">{r.calls !== undefined ? `${r.calls} calls · ${r.call_ms} ms` : ""}</td>
                <td className="px-4 py-1.5 text-bad">
                  {r.category ? `${r.error_name ? `${r.error_name} · ` : ""}${FAILURE_LABEL[r.category] ?? r.category}: ${r.error ?? ""}` : r.warnings ? <span className="text-warn">{r.warnings} warnings</span> : ""}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-muted">No runs in the last 7 days.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {detail && (
        <Card title={`Run ${detail.id} · ${when(detail.at)}`} action={<button type="button" onClick={() => setDetail(null)} className="text-xs text-muted hover:text-white">Close</button>}>
          <div className="p-4">
            {detail.telemetry ? <TelemetryView t={detail.telemetry} ms={detail.ms} /> : <p className="text-xs text-muted">Telemetry is kept for the last 50 runs.</p>}
            {detail.telemetry?.logs && <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-panel-2 p-2 text-[11px] text-muted">{detail.telemetry.logs}</pre>}
          </div>
        </Card>
      )}
    </>
  );
}

function Sources({ f }: { f: FunctionDetail }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof functions.repoSources>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    functions.repoSources(f.repo_id).then(setData, (e: Error) => setError(e.message));
  }, [f.repo_id]);
  const toggle = async (name: string, on: boolean) => {
    if (!data) return;
    const next = on ? [...data.imported, name] : data.imported.filter((x) => x !== name);
    try {
      await functions.setRepoSources(f.repo_id, next);
      setData({ ...data, imported: next });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="REST API sources imported into the repository">
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          Functions call external systems through Data Connection sources: declare <code>@function(sources=[&quot;Weather&quot;])</code>, then{" "}
          <code>get_source(&quot;Weather&quot;).get_https_connection().get_client().get(&quot;/forecast&quot;)</code> or <code>functions.webhooks.execute(&quot;Weather&quot;, &quot;getForecast&quot;, city=…)</code>. Requests stay on the source&apos;s domains, pass the egress policy and get
          the credentials added by the platform. The source must allow imports into code.
        </p>
        <ErrorBox message={error} />
        {data?.available.map((s) => {
          const key = s.api_name || s.name;
          const on = data.imported.includes(key) || data.imported.includes(s.id);
          return (
            <label key={s.id} className="flex items-center gap-3 rounded-md border border-line-2 px-3 py-2">
              <input type="checkbox" checked={on} disabled={!s.code_imports && !on} onChange={(e) => toggle(key, e.target.checked)} />
              <span className="font-medium">{s.name}</span>
              <span className="font-mono text-xs text-muted">{s.api_name}</span>
              <span className="truncate text-xs text-muted">{s.domains.join(", ")}</span>
              {!s.code_imports && <span className="ml-auto text-xs text-warn">Imports into code are off</span>}
            </label>
          );
        })}
        {data && data.available.length === 0 && <p className="text-xs text-muted">No REST API sources yet (Data Connection → REST API sources).</p>}
        {!!f.sources?.length && <p className="text-xs text-muted">This function declares: {f.sources.join(", ")}</p>}
      </div>
    </Card>
  );
}

function Aliases({ repoId }: { repoId: string }) {
  const [rows, setRows] = useState<{ kind: "custom" | "model"; name: string; value: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    functions.aliases(repoId).then(
      (a) =>
        setRows([
          ...Object.entries(a.custom).map(([name, value]) => ({ kind: "custom" as const, name, value })),
          ...Object.entries(a.model).map(([name, value]) => ({ kind: "model" as const, name, value })),
        ]),
      (e: Error) => setError(e.message),
    );
  }, [repoId]);
  const save = async () => {
    if (!rows) return;
    setError(null);
    setSaved(false);
    const pick = (k: string) => Object.fromEntries(rows.filter((r) => r.kind === k && r.name).map((r) => [r.name, r.value]));
    try {
      await functions.saveAliases(repoId, { custom: pick("custom"), model: pick("model") });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card
      title="Repository aliases"
      action={
        <button type="button" onClick={save} className={buttonClass.secondary}>
          {saved ? "Saved" : "Save aliases"}
        </button>
      }
    >
      <div className="space-y-2 p-4 text-sm">
        <p className="text-xs text-muted">
          Read in code with <code>functions.aliases.get(&quot;name&quot;)</code> (custom values such as URLs or thresholds) and{" "}
          <code>functions.language_models.get(&quot;alias&quot;)</code> (a model ID from the Model Catalog), so values change without republishing.
        </p>
        {rows?.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <select value={r.kind} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, kind: e.target.value as "custom" | "model" } : x)))} className={`${fieldClass} w-32`}>
              <option value="custom">Custom</option>
              <option value="model">Language model</option>
            </select>
            <input value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="alias" className={`${fieldClass} w-48 font-mono`} />
            <input value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="value" className={`${fieldClass} flex-1`} />
            <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setRows([...(rows ?? []), { kind: "custom", name: "", value: "" }])} className="text-xs text-ocean hover:underline">
          + Add alias
        </button>
        <ErrorBox message={error} />
      </div>
    </Card>
  );
}
