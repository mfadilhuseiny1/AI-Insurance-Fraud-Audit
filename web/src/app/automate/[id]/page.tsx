"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { usePolling } from "@/components/kg/parts";
import { AutomationForm } from "@/components/ontology/AutomationForm";
import { AppHeader, Badge, Card, ErrorBox, ObjectPicker } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { TsEvaluationStatus } from "@/components/timeseries/TsEvaluation";
import { API_URL } from "@/lib/api";
import { auth } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { conditionType, describeCondition, describeEffect, OBJECT_CONDITIONS, ontology, type Automation, type AutomationRun, type LogicFunction, type ObjectType } from "@/lib/ontology";

type History = { at: string; kind: string; detail: string; by?: string; run_id?: string };
async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/automate${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ detail: res.statusText }))).detail);
  return res.json();
}

export default function AutomationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [a, setA] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [tab, setTab] = useState<"runs" | "history">("runs");
  const [types, setTypes] = useState<Record<string, ObjectType>>({});
  const [fns, setFns] = useState<Record<string, LogicFunction>>({});
  const [me, setMe] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [pks, setPks] = useState<string[]>([]);
  const [pk, setPk] = useState("");
  const [count, setCount] = useState<{ count: number | null; total?: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [batchSize, setBatchSize] = useState(0);
  const [parallelism, setParallelism] = useState(1);
  const [evaluated, setEvaluated] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([ontology.automation(id), ontology.automationRuns(id), call<History[]>(`/automations/${id}/history`).catch(() => [])])
      .then(([x, r, h]) => {
        setA(x);
        setRuns(r);
        setHistory(h);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    ontology.objectTypes().then((t) => setTypes(Object.fromEntries(t.map((x) => [x.id, x]))), () => {});
    ontology.logicList().then((f) => setFns(Object.fromEntries(f.map((x) => [x.id, x]))), () => {});
    auth.me().then((m) => setMe(m?.id ?? ""), () => {});
  }, []);
  const isObj = !!a && (OBJECT_CONDITIONS as readonly string[]).includes(a.condition.kind);
  useEffect(() => {
    if (!isObj) return;
    let stale = false;
    call<{ count: number | null; total?: number }>(`/automations/${id}/count`, {}).then((c) => !stale && setCount(c), () => {});
    return () => {
      stale = true;
    };
  }, [id, isObj, a?.updated_at]);
  usePolling(load, !!a?.enabled, 5000);

  if (error) return <ApiError message={error} />;
  if (!a) return <Loading />;
  const effects = a.effects?.length ? a.effects : [a.effect];
  const muted = (a.muted_by ?? []).includes(me);

  const execute = async (all: boolean) => {
    setRunning(true);
    setRunError(null);
    try {
      if (a.condition.kind === "time_series") await ontology.runAutomation(a.id);
      else await call(`/automations/${a.id}/execute`, isObj ? { ...(all ? { all_objects: true } : { primary_keys: pks }), ...(batchSize > 0 ? { batch_size: batchSize, parallelism } : {}) } : {});
      load();
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="dot-grid flex-1 overflow-y-auto">
      <AppHeader app="Automate" icon="bolt" href="/automate" crumbs={[{ label: a.name }]}>
        <button type="button" onClick={async () => (await call(`/automations/${a.id}/mute`, { muted: !muted }), load())} className={buttonClass.ghost} title="Mute this automation's notifications for you">
          <Icon name="bell" className="h-3.5 w-3.5" /> {muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" onClick={async () => (await call(`/automations/${a.id}/mute-all`, { muted: !a.muted }), load())} className={buttonClass.ghost} title="Mute every effect for everyone (the condition still evaluates)" data-mute-all>
          <Icon name="pause" className="h-3.5 w-3.5" /> {a.muted ? "Unmute for everyone" : "Mute for everyone"}
        </button>
        <button type="button" onClick={async () => setA(await ontology.saveAutomation(a.id, { enabled: !a.enabled }))} className={a.enabled ? buttonClass.secondary : buttonClass.primary}>
          <Icon name={a.enabled ? "pause" : "play"} className="h-3.5 w-3.5" /> {a.enabled ? "Pause" : "Enable"}
        </button>
        <button type="button"
          onClick={async () => {
            if (!(await confirmDialog(`Delete the automation "${a.name}"?`))) return;
            await ontology.deleteAutomation(a.id);
            router.push("/automate");
          }}
          className={buttonClass.ghost}>
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
      </AppHeader>

      <div className="mx-auto grid max-w-6xl gap-5 p-8 lg:grid-cols-[1fr_400px]">
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-sand/15 p-2.5 text-sand">
              <Icon name="bolt" className="h-6 w-6" />
            </span>
            <div className="flex-1">
              <h1 className="text-xl font-semibold">{a.name}</h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge status={a.enabled ? "enabled" : "paused"} label={a.enabled ? "Enabled" : a.expired ? "Expired" : "Paused"} /> Updated {when(a.updated_at)}
                {a.settings?.expires_at && <span>· expires {when(a.settings.expires_at)}</span>}
                {muted && <span className="text-warn">· muted for you</span>}
              </div>
            </div>
            {!editing && (
              <button type="button" onClick={() => setEditing(true)} className={buttonClass.secondary}>
                <Icon name="pencil" className="h-3.5 w-3.5" /> Edit
              </button>
            )}
          </div>
          {a.description && <p className="text-sm text-soft">{a.description}</p>}
          {a.muted && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" data-muted-banner>
              Muted for everyone {a.muted.by === "system" ? "by auto-mute" : ""} {when(a.muted.at)}
              {a.muted.until ? ` until ${when(a.muted.until)}` : ""}
              {a.muted.reason ? `: ${a.muted.reason}` : ""}. Conditions still evaluate; no effect runs (manual executions still do).
            </div>
          )}
          {editing ? (
            <div className="rounded-xl border border-line bg-panel p-4">
              <AutomationForm automation={a} onCancel={() => setEditing(false)} onSaved={(x) => (setA(x), setEditing(false), load())} />
            </div>
          ) : (
            <div className="space-y-3" data-summary>
              <div className="rounded-xl border border-line bg-panel p-4 text-sm">
                <div className="mb-2 text-xs font-semibold">
                  <span className="rounded bg-sand/15 px-1.5 text-sand">WHEN</span>
                </div>
                {describeCondition(a.condition, types)}
                {"filters" in a.condition && (a.condition.filters?.length ?? 0) > 0 && (
                  <div className="mt-1 text-xs text-muted">where {a.condition.filters!.map((f) => `${f.property} ${f.op} ${String(f.value ?? "")}`).join(" and ")}</div>
                )}
                {count && count.count !== null && <div className="mt-1 text-xs text-muted">{count.count} of {count.total} objects are in the set now</div>}
                {"batch" in a.condition && a.condition.batch?.mode === "scheduled" && <div className="mt-1 text-xs text-muted">Scheduled evaluation every {a.condition.batch.every_minutes} min</div>}
                {(() => {
                  const c = a.condition as { object_source?: { kind?: string; function_id?: string }; threshold?: { function?: { function_id?: string } }; poll_minutes?: number };
                  const fnId = c.object_source?.kind === "function" ? c.object_source.function_id : c.threshold?.function?.function_id;
                  if (!fnId) return null;
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted" data-polled>
                      {c.object_source?.kind === "function" ? "Function-generated object set" : "Function-backed logic"} ({fnId}), evaluated every {c.poll_minutes ?? 5} min
                      <button type="button"
                        onClick={async () => {
                          try {
                            const r = await call<Record<string, unknown>>(`/automations/${a.id}/evaluate`, {});
                            setEvaluated(r.error ? `Error: ${String(r.error)}` : r.baseline ? "Recorded the first evaluation" : "value" in r ? `Value: ${String(r.value)}${r.changed ? " (changed)" : ""}` : `${String(r.members)} in the set, ${String(r.hits ?? 0)} triggered`);
                            load();
                          } catch (e) {
                            setEvaluated((e as Error).message);
                          }
                        }}
                        className="rounded border border-line-2 px-2 py-0.5 text-soft hover:border-ocean" data-evaluate>
                        Evaluate now
                      </button>
                      {evaluated && <span className="text-soft">{evaluated}</span>}
                    </div>
                  );
                })()}
              </div>
              <div className="mx-auto h-4 w-px bg-line-2" />
              <div className="rounded-xl border border-line bg-panel p-4 text-sm">
                <div className="mb-2 text-xs font-semibold">
                  <span className="rounded bg-ocean/15 px-1.5 text-ocean">THEN</span>
                </div>
                <ol className="list-decimal space-y-1 pl-5">
                  {effects.map((e, i) => (
                    <li key={i}>
                      {describeEffect(e, fns)}
                      {e.kind === "logic" && (
                        <Link href={`/logic/${e.logic_id}`} className="ml-1 text-ocean hover:underline">
                          {fns[e.logic_id]?.name}
                        </Link>
                      )}
                      {e.kind === "notification" && <span className="text-muted"> · {e.subject} ({e.grouping ?? "per_object"})</span>}
                      {(e.retries?.max ?? 0) > 0 && <span className="text-xs text-muted"> · {e.retries!.max} retries</span>}
                      {e.fallback && <span className="text-xs text-warn"> · fallback: {e.fallback.kind}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-5">
          {a.condition.kind === "time_series" && <TsEvaluationStatus a={a} onChanged={load} />}
          <Card title="Manual execution">
            <div className="space-y-3 p-4 text-sm">
              {isObj && (
                <>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <ObjectPicker objectTypeId={conditionType(a.condition) ?? ""} value={pk} onChange={setPk} />
                    </div>
                    <button type="button" disabled={!pk} onClick={() => (setPks([...new Set([...pks, pk])]), setPk(""))} className={buttonClass.secondary}>
                      Add
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {pks.map((x) => (
                      <span key={x} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px]">
                        {x}
                        <button type="button" onClick={() => setPks(pks.filter((y) => y !== x))} className="ml-1 text-muted">
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                </>
              )}
              {isObj && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted" data-manual-batches>
                  Batch size
                  <input type="number" min={0} value={batchSize} onChange={(e) => setBatchSize(Math.max(0, Number(e.target.value) || 0))} className="w-20 rounded border border-line-2 bg-ink px-2 py-1 text-soft" title="0: one execution" />
                  parallelism
                  <input type="number" min={1} max={8} value={parallelism} onChange={(e) => setParallelism(Math.min(8, Math.max(1, Number(e.target.value) || 1)))} className="w-14 rounded border border-line-2 bg-ink px-2 py-1 text-soft" />
                  <span>(0: one execution for all chosen objects)</span>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => execute(false)} disabled={running || (isObj && !pks.length)} className={buttonClass.primary}>
                  <Icon name="play" className="h-3.5 w-3.5" /> {running ? "Running…" : a.condition.kind === "time_series" ? "Evaluate now" : isObj ? `Run on ${pks.length} object${pks.length === 1 ? "" : "s"}` : "Run effects now"}
                </button>
                {isObj && (
                  <button type="button" disabled={running} onClick={async () => (await confirmDialog(`Run the effects on all ${count?.count ?? ""} objects of the set?`)) && execute(true)} className={buttonClass.secondary}>
                    Run on all objects
                  </button>
                )}
              </div>
              <ErrorBox message={runError} />
            </div>
          </Card>
          <Card title={tab === "runs" ? "Run history" : "Automation history"} count={tab === "runs" ? runs.length : history.length}
            action={
              <span className="flex gap-1">
                <button type="button" className={`rounded px-2 py-0.5 text-xs ${tab === "runs" ? "text-ocean" : "text-muted"}`} onClick={() => setTab("runs")}>
                  Runs
                </button>
                <button type="button" className={`rounded px-2 py-0.5 text-xs ${tab === "history" ? "text-ocean" : "text-muted"}`} onClick={() => setTab("history")}>
                  Events
                </button>
                <button className={buttonClass.ghost} onClick={load} title="Refresh">
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                </button>
              </span>
            }>
            <div className="max-h-[60vh] divide-y divide-line overflow-y-auto" data-history={tab}>
              {tab === "runs" ? (
                <>
                  {runs.length === 0 && <p className="p-4 text-sm text-muted">No runs yet.</p>}
                  {runs.map((r) => (
                    <div key={r.id} className="space-y-1 px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-2">
                        <Badge status={r.status} />
                        <span className="text-xs text-soft">{r.trigger}</span>
                        <span className="ml-auto text-xs text-muted">{when(r.at)}</span>
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs text-muted">
                        {r.primary_keys && r.primary_keys.length > 1 ? <span>{r.primary_keys.length} objects</span> : r.primary_key && <span className="truncate font-mono">{r.primary_key}</span>}
                        <span>{r.edits} edits</span>
                        {!!r.dropped && <span className="text-warn">{r.dropped} dropped</span>}
                        {r.alerts_created !== undefined && <span>{r.alerts_created} new · {r.alerts_closed ?? 0} closed alerts</span>}
                        <span>{((r.ms ?? 0) / 1000).toFixed(1)} s</span>
                      </div>
                      {r.effects?.map((e, i) => (
                        <div key={i} className="text-xs">
                          <span className={e.status === "failed" ? "text-bad" : e.status === "skipped" ? "text-muted" : "text-ok"}>●</span> {e.kind}
                          {e.attempts > 1 && <span className="text-muted"> · {e.attempts} attempts</span>}
                          {e.notified !== undefined && <span className="text-muted"> · {e.notified} notified</span>}
                          {e.error && <span className="text-bad"> · {e.error}</span>}
                          {e.fallback && <span className={e.fallback.status === "failed" ? "text-bad" : "text-warn"}> · fallback {e.fallback.kind} {e.fallback.status}</span>}
                        </div>
                      ))}
                      {r.error && !r.effects && <div className="text-xs text-bad">{r.error}</div>}
                      {r.status === "failed" && a.condition.kind !== "time_series" && (
                        <button type="button" onClick={async () => (await call(`/automations/${a.id}/runs/${r.id}/retry`, {}), load())} className="text-xs text-ocean">
                          Retry
                        </button>
                      )}
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {history.length === 0 && <p className="p-4 text-sm text-muted">No events yet.</p>}
                  {history.map((h, i) => (
                    <div key={i} className="px-4 py-2 text-xs">
                      <div className="flex">
                        <span className="font-medium text-soft">{h.kind.replace(/_/g, " ")}</span>
                        <span className="ml-auto text-muted">{when(h.at)}</span>
                      </div>
                      {h.detail && <div className="text-muted">{h.detail}</div>}
                    </div>
                  ))}
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
