"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { datasetHref } from "@/lib/datasetPreview";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { exampleInputs } from "@/lib/modelAssets";
import { modelDeployments, STATE_LABEL, STATE_TONE, type Deployment, type DeploymentConfig, type DeploymentLog, type DeploymentRun, type DeploymentTrace, type ObjectBinding, type QueryResult } from "@/lib/modelDeployments";
import { ontology, type ObjectType } from "@/lib/ontology";
import { SpanWaterfall } from "./SpanWaterfall";

/** One deployment that runs: status and health, the endpoint, a query box, its model function, logs, run history
 *  and (objective live deployments) the model inference history; batch deployments show their runs. */
export function DeploymentPanel({ id, canEdit: canEditHere = true, onChanged, onDeleted }: { id: string; canEdit?: boolean; onChanged?: () => void; onDeleted?: () => void }) {
  const [dep, setDep] = useState<Deployment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"query" | "function" | "logs" | "traces" | "runs" | "config">("query");
  const load = useCallback(() => {
    modelDeployments.get(id).then((d) => { setDep(d); setErr(null); }, (e: Error) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);
  // a batch run or a starting worker finishes in the background
  useEffect(() => {
    if (!dep) return;
    const batchRunning = dep.state_batch === "running" || (dep.kind === "batch" && dep.runs?.[0]?.status === "running");
    // the health monitor checks containers every few seconds and restarts failed workers: keep their state current
    const delay = batchRunning ? 2000 : dep.state === "restarting" ? 3000 : dep.containers?.length || (dep.scaling_now?.max ?? 1) > 1 ? 15000 : 0;
    if (!delay) return;
    const t = setTimeout(load, delay);
    return () => clearTimeout(t);
  }, [dep, load]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      load();
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!dep) return <div className="p-4 text-xs text-muted">{err ?? "Loading…"}</div>;
  // the caller's role on the deployment (its model / objective): editors configure, enable and disable, owners delete
  // and set up the inference history
  const canEdit = canEditHere && dep.my_role !== "viewer";
  const canOwn = canEdit && (!dep.my_role || dep.my_role === "owner");
  const batch = dep.kind === "batch";
  const tabs = batch ? (["runs", "logs", "config"] as const) : (["query", "function", "logs", "traces", "runs", "config"] as const);
  const shown = (tabs as readonly string[]).includes(tab) ? tab : tabs[0];
  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Icon name={batch ? "table" : "signal"} className="h-4 w-4 text-ocean" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{dep.name}</div>
          <div className="text-xs text-muted">
            {batch ? "Batch deployment" : dep.kind === "direct" ? `Direct model deployment · branch ${dep.branch}` : "Live deployment"}
            {dep.environment && ` · ${dep.environment}`}
            {dep.target ? ` · ${dep.target.model} ${dep.target.version}` : dep.target_error ? ` · ${dep.target_error}` : ""}
          </div>
        </div>
        <span className={`text-xs font-medium ${batch ? (dep.runs?.[0]?.status === "failed" ? "text-bad" : dep.runs?.[0]?.status === "running" ? "text-warn" : "text-ok") : STATE_TONE[dep.state]}`}>
          {batch ? (dep.status !== "running" ? "Disabled" : dep.runs?.[0] ? `Last run ${dep.runs[0].status}` : "No runs yet") : STATE_LABEL[dep.state]}
          {!batch && dep.loaded_version && ` · serving ${dep.loaded_version}`}
        </span>
        {canEdit && (
          <div className="flex items-center gap-1">
            {batch && dep.status === "running" && <button type="button" disabled={busy} onClick={() => act(() => modelDeployments.build(id))} className={buttonClass.secondary}><Icon name="play" className="h-3.5 w-3.5" /> Build now</button>}
            {dep.status === "running" ? (
              <button type="button" disabled={busy} onClick={() => act(() => modelDeployments.stop(id))} className={buttonClass.ghost}><Icon name="pause" className="h-3.5 w-3.5" /> Disable</button>
            ) : (
              <button type="button" disabled={busy} onClick={() => act(() => modelDeployments.start(id))} className={buttonClass.secondary}><Icon name="play" className="h-3.5 w-3.5" /> Enable</button>
            )}
            {canOwn && (
              <button type="button" disabled={busy} className={buttonClass.ghost} aria-label="Delete deployment"
                onClick={async () => {
                  if (!(await confirmDialog({ title: `Delete ${dep.name}?`, message: "Its endpoint stops answering and its run history is removed.", danger: true, confirmLabel: "Delete" }))) return;
                  await act(() => modelDeployments.remove(id));
                  onDeleted?.();
                }}>
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
      {(err || dep.error) && <pre className="whitespace-pre-wrap border-b border-line px-4 py-2 text-xs text-bad">{err ?? dep.error}</pre>}
      {!batch && (
        <div className="grid grid-cols-2 gap-px border-b border-line bg-line text-xs sm:grid-cols-4">
          {[["Requests (24 h)", dep.metrics.requests_24h], ["Errors (24 h)", dep.metrics.errors_24h], ["p50", dep.metrics.p50_ms == null ? "—" : `${dep.metrics.p50_ms} ms`], ["p95", dep.metrics.p95_ms == null ? "—" : `${dep.metrics.p95_ms} ms`]].map(([k, v]) => (
            <div key={String(k)} className="bg-panel px-4 py-2"><div className="text-muted">{k}</div><div className="mt-0.5 text-sm text-white">{v}</div></div>
          ))}
        </div>
      )}
      {!batch && <ContainerHealth dep={dep} />}
      {batch && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 text-xs text-soft">
          <span>
            Input <span className="text-white">{dep.input_name}</span> → output{" "}
            {dep.output_item_id ? <Link href={datasetHref(dep.output_item_id)} className="text-ocean hover:underline">{dep.output_name}</Link> : <span className="text-white">{dep.output_name}</span>}.
            Rebuilt when a new {dep.environment} release is made{dep.rebuild_on_input !== false ? " and when the input dataset updates" : ""}.
          </span>
          {canEdit && (
            <label className="flex items-center gap-1 text-muted">
              <input type="checkbox" checked={dep.rebuild_on_input !== false} disabled={busy} onChange={(e) => act(() => modelDeployments.triggers(id, e.target.checked))} />
              Rebuild on input updates
            </label>
          )}
        </div>
      )}
      <div className="flex gap-1 border-b border-line px-3 pt-2 text-xs">
        {tabs.map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-t px-3 py-1.5 capitalize ${shown === t ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}>
            {t === "runs" ? (batch ? "Runs" : "Run history") : t === "config" ? "Configuration" : t}
          </button>
        ))}
      </div>
      <div className="p-4">
        {shown === "query" && <QueryBox dep={dep} onRan={load} />}
        {shown === "function" && <FunctionCard dep={dep} canEdit={canEdit} act={act} busy={busy} />}
        {shown === "logs" && <Logs id={id} />}
        {shown === "traces" && <Traces id={id} />}
        {shown === "runs" && (batch ? <BatchRuns dep={dep} /> : <Runs id={id} />)}
        {shown === "config" && <Config dep={dep} canEdit={canEdit} canOwn={canOwn} act={act} busy={busy} />}
      </div>
    </div>
  );
}

/** A live deployment's replicas (scale and autoscaling), their containers (container-backed models) and the
 *  automatic restarts. */
function ContainerHealth({ dep }: { dep: Deployment }) {
  const rows = dep.containers ?? [];
  const reps = dep.replicas ?? [];
  const sc = dep.scaling_now;
  const multi = reps.length > 1 || (sc?.max ?? 1) > 1;
  if (!rows.length && !dep.restart && !dep.restarts && !dep.containers_error && !multi && !dep.scaling?.length) return null;
  return (
    <div className="space-y-1 border-b border-line px-4 py-2 text-xs">
      {dep.restart && (
        <div className="text-warn">
          Restarting (attempt {dep.restart.attempts}{dep.restart.next_in_s ? `, next in ${dep.restart.next_in_s} s` : ""}){dep.restart.reason ? `: ${dep.restart.reason}` : ""}
        </div>
      )}
      {sc && multi && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-soft">
          <Icon name="layers" className="h-3.5 w-3.5 text-muted" />
          <span className="text-white">{reps.filter((r) => r.alive).length} of {sc.desired} replica{sc.desired === 1 ? "" : "s"}</span>
          <span className="text-muted">range {sc.min}–{sc.max}{sc.autoscaling ? ` · autoscaling on ${sc.metric === "p95_latency" ? "p95 latency" : "requests in flight"}` : ""}</span>
          {sc.autoscaling && <span className="text-muted">load {sc.load.toFixed(2)} in flight{sc.p95_ms != null ? ` · p95 ${sc.p95_ms} ms` : ""}</span>}
        </div>
      )}
      {multi && reps.map((r) => (
        <div key={r.index} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-5 text-soft">
          <span className="text-white">Replica {r.index}</span>
          {r.state === "starting" || r.state === "stopping" ? (
            <>
              <span className="text-warn">{r.state === "starting" ? "Starting" : "Stopping"}</span>
              <span className="text-muted">takes no requests · since {when(r.started_at)}</span>
            </>
          ) : (
            <>
              <span className={r.healthy ? "text-ok" : r.alive ? "text-warn" : "text-bad"}>{r.healthy ? "Healthy" : r.alive ? `${r.failed_checks} failed check(s)` : "Stopped"}</span>
              <span>{r.requests} request(s){r.errors ? `, ${r.errors} failed` : ""}{r.in_flight ? ` · ${r.in_flight} in flight` : ""}</span>
              <span className="text-muted">process {r.pid} · started {when(r.started_at)}</span>
            </>
          )}
        </div>
      ))}
      {rows.map((c) => (
        <div key={c.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-soft">
          <Icon name="cube" className="h-3.5 w-3.5 text-muted" />
          {multi && c.replica != null && <span className="text-muted">replica {c.replica}</span>}
          <span className="text-white">{c.image}</span>
          {c.cpus != null && <span className="text-muted">{c.cpus} vCPU</span>}
          {c.memory_bytes != null && <span className="text-muted">{c.memory_bytes >= 2 ** 30 ? `${+(c.memory_bytes / 2 ** 30).toFixed(2)} GB` : `${Math.round(c.memory_bytes / 2 ** 20)} MB`}</span>}
          <span className={c.ready ? "text-ok" : c.running ? "text-warn" : "text-bad"}>
            {c.ready ? "Ready" : c.running ? "Not answering" : `${c.state}${c.exit_code != null ? ` (exit ${c.exit_code})` : ""}`}
          </span>
          {Object.entries(c.ports).map(([p, hp]) => <span key={p} className={c.answering[p] ? "" : "text-warn"}>port {p} → {hp}</span>)}
          {c.restarts > 0 && <span className="text-warn">{c.restarts} container restart(s)</span>}
          {c.started_at && <span className="text-muted">started {when(c.started_at)}</span>}
          <code className="text-muted">{c.name}</code>
        </div>
      ))}
      {dep.containers_error && <div className="text-warn">The container runtime did not answer: {dep.containers_error}</div>}
      <div className="text-muted">
        {dep.containers_checked_at && `Checked ${when(dep.containers_checked_at)}`}
        {dep.restarts ? `${dep.containers_checked_at ? " · " : ""}restarted ${dep.restarts} time(s), last ${dep.last_restart_at ? when(dep.last_restart_at) : ""}${dep.last_restart_reason ? `: ${dep.last_restart_reason}` : ""}` : ""}
        {rows.length > 0 && dep.telemetry === false && " · container logs are collected when the model version has telemetry on"}
        {dep.replica_replacements ? ` · ${dep.replica_replacements} replica(s) replaced, last ${dep.last_replacement_at ? when(dep.last_replacement_at) : ""}` : ""}
      </div>
      {!!dep.scaling?.length && (
        <details className="text-muted">
          <summary className="cursor-pointer hover:text-white">Scaling events ({dep.scaling.length})</summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {dep.scaling.slice(0, 10).map((e, i) => <li key={i}>{when(e.at)} · {e.from} → {e.to}: {e.reason}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function QueryBox({ dep, onRan }: { dep: Deployment; onRan: () => void }) {
  const [text, setText] = useState("");
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const example = JSON.stringify(exampleInputs(dep.target?.api), null, 2);
  const body = text || example;
  const url = `${API_URL}${dep.endpoint}`;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <div className="mb-1 text-xs text-muted">Request: a field per model input (rows for tabular inputs)</div>
        <textarea value={body} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={busy || dep.status !== "running"} className={buttonClass.primary}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              setRes(null);
              try {
                setRes(await modelDeployments.query(dep.id, JSON.parse(body)));
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
                onRan();
              }
            }}>
            <Icon name="play" className="h-3.5 w-3.5" /> {busy ? "Running…" : "Run"}
          </button>
          {dep.kind === "direct" && <span className="text-[11px] text-muted">Inputs are cast to the model API&apos;s types.</span>}
        </div>
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted hover:text-white">REST endpoint (multi I/O, /v2)</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-ink p-2 text-[11px] text-soft">{`curl -X POST '${url}' \\\n  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(exampleInputs(dep.target?.api))}'`}</pre>
          {dep.kind === "objective" && <p className="mt-1 text-muted">Single I/O (sunset): the same URL without /v2, with {`{"requestData": [rows], "requestParams": {}}`}.</p>}
        </details>
      </div>
      <div>
        <div className="mb-1 text-xs text-muted">Response{res ? ` · ${res.ms} ms · version ${res.version}` : ""}</div>
        {err ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-bad/10 p-2 text-xs text-bad">{err}</pre>
          : <pre className="max-h-72 overflow-auto rounded bg-ink p-2 text-xs text-soft">{res ? JSON.stringify(res.outputs, null, 2) : "Run a request to see the model's answer."}</pre>}
        {res?.logs && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-[11px] text-muted">{res.logs}</pre>}
      </div>
    </div>
  );
}

function FunctionCard({ dep, canEdit, act, busy }: { dep: Deployment; canEdit: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const f = dep.function;
  const [name, setName] = useState(f?.name ?? dep.name);
  const [apiName, setApiName] = useState(f?.api_name ?? "");
  const api = dep.target?.api;
  const rowWiseOk = !!api && api.inputs.length === 1 && api.outputs.length === 1 && api.inputs[0].type === "tabular" && api.outputs[0].type === "tabular";
  const [rowWise, setRowWise] = useState(f?.row_wise ?? rowWiseOk);
  const columns = rowWiseOk ? (api!.inputs[0].columns ?? []).map((c) => c.name) : [];
  const [bind, setBind] = useState<ObjectBinding | null>(f?.object_binding ?? null);
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  useEffect(() => {
    if (bind && !types) ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, [bind, types]);
  const boundType = types?.find((t) => t.api_name === bind?.object_type || t.id === bind?.object_type);
  const chooseType = (apiName: string) => {
    const t = types?.find((x) => x.api_name === apiName);
    const props = new Set((t?.properties ?? []).map((p) => p.api_name));
    // columns named like a property are mapped to it
    setBind({ object_type: apiName, input_name: bind?.input_name ?? "object", properties: Object.fromEntries(columns.filter((c) => props.has(c)).map((c) => [c, c])) });
  };
  const binding = rowWise && rowWiseOk && bind && bind.object_type && Object.keys(bind.properties).length ? bind : null;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted">
        A model function wraps this live deployment with the model&apos;s API, for Workshop, actions and other functions. Python functions call it with{" "}
        <code className="text-soft">FoundryClient().ontology.queries.{snake(apiName || "model_function")}(…)</code>; over HTTP: POST /api/functions/queries/{apiName || "<apiName>"}/execute.
      </p>
      {f && (
        <div className="rounded border border-line bg-panel-2 p-3 text-xs">
          <div className="flex items-center gap-2"><Icon name="bolt" className="h-3.5 w-3.5 text-ocean" /><span className="font-medium text-white">{f.name}</span><code className="text-soft">{f.api_name}</code>
            <span className="text-muted">version {f.version} · published for model version {f.model_version}{f.row_wise ? " · row-wise" : ""}</span></div>
          {f.object_binding && (
            <p className="mt-1 text-soft">
              Takes a <code>{f.object_binding.object_type}</code> object ({f.object_binding.input_name ?? "object"}):{" "}
              {Object.entries(f.object_binding.properties).map(([c, p]) => (c === p ? c : `${c} ← ${p}`)).join(", ")}
            </p>
          )}
          <pre className="mt-2 overflow-x-auto text-[11px] text-soft">{JSON.stringify(f.signature, null, 2)}</pre>
          {dep.target && dep.target.version !== f.model_version && <p className="mt-1 text-warn">The deployment now serves {dep.target.version}. If the model API changed, publish a new function version.</p>}
        </div>
      )}
      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <label className="text-xs text-muted">Function name<input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} /></label>
          <label className="text-xs text-muted">API name<input value={apiName} onChange={(e) => setApiName(e.target.value)} placeholder="riskScore" className={`${inputClass} mt-1 font-mono`} /></label>
          <label className={`flex items-center gap-2 pb-2 text-xs ${rowWiseOk ? "text-soft" : "text-muted"}`} title={rowWiseOk ? "" : "Needs exactly one tabular input and one tabular output"}>
            <input type="checkbox" disabled={!rowWiseOk} checked={rowWise && rowWiseOk} onChange={(e) => setRowWise(e.target.checked)} /> Row-wise processing
          </label>
          <div className="flex gap-1">
            <button type="button" disabled={busy || !name.trim() || !/^[A-Za-z][A-Za-z0-9_]*$/.test(apiName)} className={buttonClass.primary}
              onClick={() => act(() => modelDeployments.publishFunction(dep.id, { name, api_name: apiName, row_wise: rowWise && rowWiseOk, object_binding: binding }))}>
              {f ? "Publish new version" : "Create function"}
            </button>
            {f && <button type="button" disabled={busy} className={buttonClass.ghost} onClick={() => act(() => modelDeployments.removeFunction(dep.id))}>Remove</button>}
          </div>
        </div>
      )}
      {canEdit && rowWise && rowWiseOk && (
        <div className="rounded border border-line p-3 text-xs">
          <label className="flex items-center gap-2 text-soft">
            <input type="checkbox" checked={!!bind} onChange={(e) => setBind(e.target.checked ? { object_type: "", input_name: "object", properties: {} } : null)} />
            Take an Nexus object: its properties fill model columns (Workshop and actions pass the object)
          </label>
          {bind && (
            <div className="mt-2 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-muted">Object type
                  <select value={boundType?.api_name ?? ""} onChange={(e) => chooseType(e.target.value)} className={`${inputClass} mt-1`}>
                    <option value="">{types ? "Choose…" : "Loading…"}</option>
                    {(types ?? []).map((t) => <option key={t.id} value={t.api_name}>{t.display_name} ({t.api_name})</option>)}
                  </select>
                </label>
                <label className="text-muted">Object input name
                  <input value={bind.input_name ?? "object"} onChange={(e) => setBind({ ...bind, input_name: e.target.value })} className={`${inputClass} mt-1 font-mono`} />
                </label>
              </div>
              {boundType && (
                <div className="max-h-64 overflow-auto rounded border border-line">
                  <table className="w-full">
                    <thead className="text-muted"><tr><th className="px-2 py-1 text-left font-normal">Model column</th><th className="px-2 py-1 text-left font-normal">Property (empty: a function input)</th></tr></thead>
                    <tbody>
                      {columns.map((c) => (
                        <tr key={c} className="border-t border-line">
                          <td className="px-2 py-1 font-mono text-soft">{c}</td>
                          <td className="px-2 py-1">
                            <select value={bind.properties[c] ?? ""} className={`${inputClass} py-0.5 text-xs`}
                              onChange={(e) => {
                                const properties = { ...bind.properties };
                                if (e.target.value) properties[c] = e.target.value;
                                else delete properties[c];
                                setBind({ ...bind, properties });
                              }}>
                              <option value="">—</option>
                              {boundType.properties.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name} ({p.api_name})</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {boundType && !Object.keys(bind.properties).length && <p className="text-warn">Map at least one column to a property.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function Logs({ id }: { id: string }) {
  const [rows, setRows] = useState<DeploymentLog[] | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => { modelDeployments.logs(id, q).then(setRows, () => setRows([])); }, [id, q]);
  useEffect(load, [load]);
  return (
    <div>
      <div className="mb-2 flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter logs" className={`${inputClass} max-w-xs text-xs`} />
        <button type="button" onClick={load} className={buttonClass.ghost}><Icon name="refresh" className="h-3.5 w-3.5" /></button>
        <a className={buttonClass.ghost} download={`deployment-${id}.log`} href={`data:text/plain;charset=utf-8,${encodeURIComponent((rows ?? []).map((r) => `${r.at} ${r.level} ${r.message}${r.traceback ? `\n${r.traceback}` : ""}`).join("\n"))}`}>
          <Icon name="download" className="h-3.5 w-3.5" /> Download
        </a>
      </div>
      <div className="max-h-80 overflow-auto rounded bg-ink p-2 font-mono text-[11px]">
        {(rows ?? []).length === 0 && <div className="text-muted">No logs (kept 7 days).</div>}
        {(rows ?? []).map((r, i) => (
          <div key={i} className="whitespace-pre-wrap">
            <span className="text-muted">{r.at.slice(11, 23)} </span>
            <span className={r.level === "ERROR" ? "text-bad" : r.level === "MODEL" ? "text-ocean" : "text-soft"}>{r.level.padEnd(6)}</span> <span className="text-soft">{r.message}</span>
            {r.traceback && <div className="pl-4 text-bad/80">{r.traceback}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Runs({ id }: { id: string }) {
  const [rows, setRows] = useState<DeploymentRun[] | null>(null);
  useEffect(() => { modelDeployments.runs(id).then(setRows, () => setRows([])); }, [id]);
  if (!rows?.length) return <div className="text-xs text-muted">No inference requests yet.</div>;
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-muted"><tr>{["Time", "Source", "Rows", "Version", "Replica", "Duration", "Result"].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.request_uuid} className="border-t border-line">
              <td className="px-2 py-1 text-soft">{when(r.at)}</td><td className="px-2 py-1 text-soft">{r.source}</td><td className="px-2 py-1 text-soft">{r.rows_in}</td>
              <td className="px-2 py-1 text-soft">{r.version}</td>
              <td className="px-2 py-1 text-soft" title={r.retried ? `retried on another replica ${r.retried} time(s)` : ""}>{r.replica ?? "—"}{r.retried ? " ↻" : ""}</td>
              <td className="px-2 py-1 text-soft">{r.ms} ms</td>
              <td className={`px-2 py-1 ${r.ok ? "text-ok" : "text-bad"}`} title={r.error ?? ""}>{r.ok ? "OK" : (r.error ?? "failed").slice(0, 80)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Telemetry: a trace per inference call (the span over the call and the adapter's custom spans) with its log lines. */
function Traces({ id }: { id: string }) {
  const [rows, setRows] = useState<DeploymentTrace[] | null>(null);
  const [open, setOpen] = useState<DeploymentTrace | null>(null);
  useEffect(() => { modelDeployments.traces(id).then(setRows, () => setRows([])); }, [id]);
  if (!rows?.length) {
    return (
      <div className="text-xs text-muted">
        No traces yet. Every inference call records a span over the whole call; spans the adapter creates with{" "}
        <code className="text-soft">opentelemetry.trace.get_tracer(__name__)</code> and lines it writes with <code className="text-soft">logging</code> appear with it.
      </div>
    );
  }
  return (
    <div className="max-h-96 space-y-1 overflow-auto">
      {rows.map((r) => {
        const shown = open?.request_uuid === r.request_uuid;
        return (
          <div key={r.request_uuid} className="rounded border border-line">
            <button type="button" className="flex w-full items-center gap-3 px-2 py-1.5 text-left text-xs hover:bg-panel-2"
              onClick={() => (shown ? setOpen(null) : modelDeployments.trace(id, r.request_uuid).then((t) => setOpen(t[0] ?? r), () => setOpen(r)))}>
              <Icon name={shown ? "down" : "right"} className="h-3 w-3 text-muted" />
              <span className="text-soft">{when(r.at)}</span><span className="text-muted">{r.source}</span><span className="text-muted">version {r.version}</span>
              <span className="text-muted">{r.spans.length} span{r.spans.length === 1 ? "" : "s"}</span>
              <span className="ml-auto tabular-nums text-soft">{r.ms} ms</span><span className={r.ok ? "text-ok" : "text-bad"}>{r.ok ? "OK" : "Error"}</span>
            </button>
            {shown && open && (
              <div className="space-y-2 border-t border-line p-3">
                <SpanWaterfall spans={open.spans} />
                {(open.logs ?? []).map((l, i) => (
                  <pre key={i} className={`whitespace-pre-wrap rounded bg-ink p-2 text-[11px] ${l.level === "ERROR" ? "text-bad" : "text-muted"}`}>{l.level} {l.message}{l.traceback ? `\n${l.traceback}` : ""}</pre>
                ))}
                <div className="break-all text-[11px] text-muted">trace {open.trace_id} · request {open.request_uuid}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BatchRuns({ dep }: { dep: Deployment }) {
  if (!dep.runs?.length) return <div className="text-xs text-muted">No runs yet.</div>;
  return (
    <table className="w-full text-xs">
      <thead className="text-muted"><tr>{["Started", "Trigger", "Model version", "Rows", "Duration", "Result"].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr></thead>
      <tbody>
        {dep.runs.map((r) => (
          <tr key={r.id} className="border-t border-line">
            <td className="px-2 py-1 text-soft">{when(r.at)}</td><td className="px-2 py-1 text-soft">{r.trigger}</td><td className="px-2 py-1 text-soft">{r.version ?? "—"}</td>
            <td className="px-2 py-1 text-soft">{r.rows_out ?? "—"}</td><td className="px-2 py-1 text-soft">{r.ms == null ? "—" : `${(r.ms / 1000).toFixed(1)} s`}</td>
            <td className={`px-2 py-1 ${r.status === "succeeded" ? "text-ok" : r.status === "failed" ? "text-bad" : "text-warn"}`}>{r.status}{r.error ? `: ${r.error.slice(0, 160)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Config({ dep, canEdit, canOwn, act, busy }: { dep: Deployment; canEdit: boolean; canOwn: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const [cfg, setCfg] = useState(dep.config);
  const [picking, setPicking] = useState(false);
  const [historyName, setHistoryName] = useState(`${dep.name} inference history`);
  type NumKey = "min_replicas" | "max_replicas" | "cpu" | "memory_gb" | "target_in_flight" | "target_p95_ms" | "scale_window_s" | "cooldown_s" | "idle_s";
  const DEFAULTS: Record<NumKey, number> = { min_replicas: 1, max_replicas: 1, cpu: 1, memory_gb: 2, target_in_flight: 1, target_p95_ms: 1000, scale_window_s: 60, cooldown_s: 120, idle_s: 1800 };
  const num = (k: NumKey, label: string, title?: string) => (
    <label className="text-xs text-muted" title={title}>{label}
      <input type="number" min={0} step={k === "cpu" || k === "memory_gb" || k === "target_in_flight" ? 0.5 : 1} value={cfg[k] ?? DEFAULTS[k]} disabled={!canEdit}
        onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} className={`${inputClass} mt-1`} />
    </label>
  );
  const autoscaling = cfg.max_replicas > Math.max(1, cfg.min_replicas);
  const container = !!dep.containers?.length;
  const h = dep.inference_history;
  return (
    <div className="space-y-4 text-sm">
      {dep.kind !== "batch" ? (
        <div>
          <div className="grid gap-2 sm:grid-cols-4">
            {num("min_replicas", "Minimum replicas", "0: the deployment stops when idle and starts again on the next request")}
            {num("max_replicas", "Maximum replicas", "Above the minimum: the replica count follows the load")}
            {num("cpu", "vCPUs per replica", "Applied to a container model's containers (docker --cpus)")}
            {num("memory_gb", "Memory per replica (GB)", "Applied to a container model's containers (docker --memory), unless an image of the version sets a lower limit")}
          </div>
          {autoscaling && (
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              <label className="text-xs text-muted">Scale on
                <select value={cfg.scale_metric ?? "in_flight"} disabled={!canEdit} onChange={(e) => setCfg({ ...cfg, scale_metric: e.target.value as DeploymentConfig["scale_metric"] })} className={`${inputClass} mt-1`}>
                  <option value="in_flight">Requests in flight</option>
                  <option value="p95_latency">p95 latency</option>
                </select>
              </label>
              {(cfg.scale_metric ?? "in_flight") === "in_flight"
                ? num("target_in_flight", "Target in flight per replica", "One more replica at 75% of it, one fewer when the load fits under 50% on one replica less")
                : num("target_p95_ms", "Target p95 (ms)", "One more replica above it, one fewer under half of it")}
              {num("scale_window_s", "Window (s)", "The load is measured over this window (since the last change)")}
              {num("cooldown_s", "Cool-down (s)", "No scaling within this time of the last change")}
            </div>
          )}
          {cfg.min_replicas === 0 && <div className="mt-2 grid gap-2 sm:grid-cols-4">{num("idle_s", "Stop when idle for (s)")}</div>}
          <p className="mt-2 text-[11px] text-muted">
            Each replica is its own model process{container ? " with its own containers (limited to the vCPUs and memory above)" : ""}; requests are spread round-robin over the running replicas, and a failed replica is replaced while the others serve.
            {" "}vCPUs and memory limit the containers of a container model (a version&apos;s own lower memory limit applies); for models trained here they are kept for the record. Changing resources or environment restarts the deployment; changing the scaling does not.
          </p>
          {canEdit && <button type="button" disabled={busy} className={`${buttonClass.secondary} mt-2`} onClick={() => act(() => modelDeployments.config(dep.id, cfg))}>Update</button>}
        </div>
      ) : (
        <div>
          <div className="grid gap-2 sm:grid-cols-4">{num("cpu", "vCPUs")}{num("memory_gb", "Memory (GB)")}</div>
          <p className="mt-2 text-[11px] text-muted">Kept for the record: a batch run is one model process on this machine.</p>
          {canEdit && <button type="button" disabled={busy} className={`${buttonClass.secondary} mt-2`} onClick={() => act(() => modelDeployments.config(dep.id, cfg))}>Update</button>}
        </div>
      )}
      <div className="text-xs text-muted">Target RID <code className="text-soft">{dep.rid}</code></div>
      {dep.history.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted">Upgrades</div>
          <ul className="space-y-0.5 text-xs text-soft">{[...dep.history].reverse().slice(0, 8).map((x, i) => <li key={i}>{when(x.at)} · {x.from ? `${x.from} → ` : "started on "}{x.version}</li>)}</ul>
        </div>
      )}
      {dep.kind === "objective" && (
        <div className="rounded border border-line bg-panel-2 p-3">
          <div className="text-xs font-medium text-white">Model inference history</div>
          {h ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-soft">
              <Link href={datasetHref(h.item_id)} className="text-ocean hover:underline">{h.name}</Link>
              <span>{h.rows} request(s) written</span>
              {h.error && <span className="basis-full text-bad">The history was {h.error}</span>}
              <label className="flex items-center gap-1"><input type="checkbox" checked={h.enabled} disabled={!canOwn} onChange={(e) => act(() => modelDeployments.toggleHistory(dep.id, e.target.checked))} /> Enable recording</label>
              {canEdit && <button type="button" className={buttonClass.ghost} onClick={() => act(() => modelDeployments.syncHistory(dep.id))}>Sync now</button>}
              {canOwn && <button type="button" className={buttonClass.ghost} onClick={() => act(() => modelDeployments.removeHistory(dep.id))}>Remove</button>}
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
              <p className="basis-full text-muted">Record every request, result and error of this deployment into a dataset (inputs may be sensitive: put it in a restricted folder).</p>
              <input value={historyName} onChange={(e) => setHistoryName(e.target.value)} className={`${inputClass} max-w-xs`} />
              {canOwn && <button type="button" disabled={!historyName.trim()} className={buttonClass.secondary} onClick={() => setPicking(true)}>Create dataset…</button>}
            </div>
          )}
        </div>
      )}
      {picking && (
        <DrivePicker title="Folder for the model inference history" onClose={() => setPicking(false)}
          folder={{ action: "Create here", onPick: (f) => { setPicking(false); if (f.id) void act(() => modelDeployments.createHistory(dep.id, f.id as string, historyName.trim())); } }} />
      )}
    </div>
  );
}
