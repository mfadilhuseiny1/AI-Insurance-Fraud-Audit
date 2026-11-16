"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge, Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { functions, type FunctionRow } from "@/lib/actions";
import { confirmDialog } from "@/lib/dialogs";
import { ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import { om, type Exploration } from "@/lib/ontologyModel";
import { API_URL } from "@/lib/api";

type Metric = { metric: "count" | "sum" | "avg" | "min" | "max"; property?: string | null };
type Condition = {
  kind: "objects_added" | "objects_removed" | "metric_increased" | "metric_decreased" | "threshold" | "function";
  metric: Metric;
  threshold?: { metric: Metric; op: string; value: number } | null;
  function_id?: string | null;
};
type Activity = { at: string; trigger: string; kind: string; objects?: string[]; count?: number; status?: boolean; value?: number; from?: number; to?: number; detail?: string; effects?: unknown[] };
type Monitor = {
  id: string;
  rid: string;
  name: string;
  description: string;
  exploration_id: string | null;
  search: { object_type_id: string; filters?: unknown[] } | null;
  condition: Condition;
  subscribers: { user: string; notify: boolean; email: boolean; action: { action_type_id: string; object_parameter?: string; parameters?: Record<string, unknown> } | null }[];
  every_minutes: number;
  expires_at: string;
  enabled: boolean;
  owner: string;
  realtime: boolean;
  expired: boolean;
  status: boolean | null;
  last_evaluated_at: string | null;
  last_value: number | null;
  activity: Activity[];
  migrated_to?: string;
  migration?: Migration;
};
type ConditionFunction = { function_id: string; version?: string | null; objects_input?: string | null; inputs?: Record<string, unknown> };
type Migration = {
  automation_id: string;
  automation_name?: string;
  at?: string;
  by?: string;
  was_enabled: boolean;
  condition_function?: ConditionFunction | null;
  legacy?: boolean;
  automation_exists: boolean;
};
/** The dry run of a migration (POST /{id}/migrate/dry-run): nothing is created. */
type MigrationPlan = {
  monitor: { id: string; name: string; kind: Condition["kind"] };
  translates: boolean;
  automation: Record<string, unknown> | null;
  translated: { monitor: string; automate: string }[];
  untranslatable: { feature: string; reason: string }[];
  notes: string[];
  migrated?: Migration;
};
type BulkStatus = "migrated" | "would_migrate" | "refused" | "already_migrated" | "failed";
type BulkResult = {
  results: { id: string; name: string; kind: Condition["kind"]; status: BulkStatus; automation_id?: string; untranslatable?: { feature: string; reason: string }[]; notes?: string[]; error?: string }[];
  unknown: string[];
  dry_run: boolean;
} & Record<BulkStatus, number>;

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api/object-monitors${path}`, {
    ...init,
    credentials: "include",
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}
const KIND_LABEL: Record<Condition["kind"], string> = {
  objects_added: "Objects added to the input",
  objects_removed: "Objects removed from the input",
  metric_increased: "Metric increased",
  metric_decreased: "Metric decreased",
  threshold: "Threshold",
  function: "Function-backed",
};

/**
 * Object Monitors [Sunset]: watch saved explorations for objects added or removed, metric changes and thresholds;
 * notify subscribers and apply actions; history, expiry and migration to Automate.
 */
export default function ObjectMonitorsPage() {
  const [list, setList] = useState<Monitor[] | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [explorations, setExplorations] = useState<Exploration[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [migrating, setMigrating] = useState<"one" | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => req<Monitor[]>("").then(setList, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
    Promise.all([ontology.objectTypes(), om.explorations()]).then(([t, e]) => (setTypes(t), setExplorations(e)), () => undefined);
  }, [load]);
  if (error && !list) return <ApiError message={error} />;
  if (!list) return <Loading />;
  const m = list.find((x) => x.id === (selected ?? list[0]?.id));
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const inputName = (x: Monitor) =>
    x.exploration_id ? (explorations.find((e) => e.id === x.exploration_id)?.name ?? "Saved exploration") : (types.find((t) => t.id === x.search?.object_type_id)?.display_name ?? "Object search");
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Object Monitors" icon="bell" href="/object-monitors" crumbs={m ? [{ label: m.name }] : []}>
        <Badge status="deprecated" label="Sunset" />
        <button type="button" onClick={() => setMigrating("all")} className={buttonClass.secondary} disabled={!list.length}>
          <Icon name="bolt" className="h-3.5 w-3.5" /> Migrate all to Automate…
        </button>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New monitor
        </button>
      </AppHeader>
      <div className="border-b border-warn/30 bg-warn/10 px-5 py-2 text-xs text-warn">
        Object Monitors are superseded by{" "}
        <Link href="/application-studio?tool=automate" className="underline">
          Automate
        </Link>
        . Existing monitors keep running; &quot;Migrate to Automate&quot; previews the equivalent automation (a dry run), then creates it and pauses the monitor. Monitors
        Automate cannot express exactly are refused with the reason; a migration can be undone.
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          {list.map((x) => (
            <button key={x.id} type="button" onClick={() => setSelected(x.id)} className={`mb-0.5 flex w-full flex-col rounded-md px-2 py-1.5 text-left ${m?.id === x.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${!x.enabled || x.expired ? "bg-muted" : x.status ? "bg-warn" : "bg-ok"}`} />
                <span className="truncate">{x.name}</span>
              </span>
              <span className="pl-4 text-[11px] text-muted">
                {KIND_LABEL[x.condition.kind]} · {x.realtime ? "realtime" : `every ${x.every_minutes} min`}
              </span>
            </button>
          ))}
          {!list.length && <div className="p-2 text-xs text-muted">No monitors.</div>}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
          {m && (
            <div className="mx-auto max-w-5xl space-y-4 p-5 text-xs">
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <h1 className="text-xl font-semibold">{m.name}</h1>
                  <p className="mt-1 text-muted">{m.description}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted">{m.rid}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => act(() => req(`/${m.id}/evaluate`, { method: "POST" }))} className={buttonClass.secondary}>
                    <Icon name="refresh" className="h-3.5 w-3.5" /> Evaluate now
                  </button>
                  {!m.migration && (
                    <>
                      <button type="button" onClick={() => act(() => req(`/${m.id}/extend`, { method: "POST", json: { days: 92 } }))} className={buttonClass.secondary}>
                        Extend 3 months
                      </button>
                      <button type="button" onClick={() => act(() => req(`/${m.id}/subscribe`, { method: "POST", json: { notify: true } }))} className={buttonClass.secondary}>
                        <Icon name="bell" className="h-3.5 w-3.5" /> Subscribe
                      </button>
                      <button type="button" onClick={() => setMigrating("one")} className={buttonClass.secondary}>
                        <Icon name="bolt" className="h-3.5 w-3.5" /> Migrate to Automate…
                      </button>
                    </>
                  )}
                  {m.migration && (
                    <button
                      type="button"
                      onClick={async () => {
                        const message = m.migration?.automation_exists
                          ? `Undo the migration of ${m.name}? The automation "${m.migration.automation_name ?? m.migration.automation_id}" is deleted (refused if it was edited since) and the monitor resumes from the current data.`
                          : `The automation was already deleted. Resume ${m.name} from the current data?`;
                        if (await confirmDialog({ message, confirmLabel: "Undo migration" })) await act(() => req(`/${m.id}/migrate/undo`, { method: "POST" }));
                      }}
                      className={buttonClass.secondary}
                    >
                      Undo migration
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      if (await confirmDialog({ message: `Delete ${m.name}?`, danger: true, confirmLabel: "Delete" })) await act(() => req(`/${m.id}`, { method: "DELETE" }));
                    }}
                    className={buttonClass.ghost}
                    aria-label="Delete monitor"
                  >
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <ErrorBox message={error} />
              {m.migration && (
                <div className="rounded-lg border border-ocean/30 bg-ocean/10 px-3 py-2 text-soft">
                  Migrated to Automate
                  {m.migration.at ? ` on ${new Date(m.migration.at).toLocaleString()}` : ""}
                  {m.migration.by ? ` by ${m.migration.by}` : ""}:{" "}
                  {m.migration.automation_exists ? (
                    <Link href={`/automate/${m.migration.automation_id}`} className="text-ocean underline">
                      {m.migration.automation_name ?? m.migration.automation_id}
                    </Link>
                  ) : (
                    <span className="text-warn">the automation {m.migration.automation_id} was deleted</span>
                  )}
                  . The monitor is paused and no longer evaluated; edit the automation instead, or undo the migration.
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-4">
                {[
                  ["Input", inputName(m)],
                  ["Condition", KIND_LABEL[m.condition.kind]],
                  ["Status", m.migration ? "migrated to Automate" : !m.enabled ? "disabled" : m.expired ? "expired" : m.status === null ? "watching" : m.status ? "condition met" : "condition not met"],
                  ["Expires", new Date(m.expires_at).toLocaleDateString()],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-line bg-panel px-3 py-2">
                    <div className="text-[11px] text-muted">{k}</div>
                    <div className="truncate text-sm font-semibold">{v}</div>
                  </div>
                ))}
              </div>
              <Card title="Details">
                <div className="space-y-1 p-4">
                  <div>Evaluation: {m.realtime ? "realtime (as objects change)" : `scheduled every ${m.every_minutes} minutes`}</div>
                  {m.condition.threshold && (
                    <div>
                      Threshold: {m.condition.threshold.metric.metric}
                      {m.condition.threshold.metric.property ? ` of ${m.condition.threshold.metric.property}` : ""} {m.condition.threshold.op} {m.condition.threshold.value.toLocaleString()}
                    </div>
                  )}
                  <div>
                    Last evaluated {m.last_evaluated_at ? new Date(m.last_evaluated_at).toLocaleString() : "never"} · value {m.last_value?.toLocaleString() ?? "—"}
                  </div>
                  <div>Subscribers: {m.subscribers.map((s) => `${s.user}${s.action ? " (applies an action)" : ""}`).join(", ") || "none"}</div>
                  {m.exploration_id && (
                    <Link href={`/object-explorer`} className="text-ocean">
                      Open the input exploration in Object Explorer
                    </Link>
                  )}
                </div>
              </Card>
              <Card title="History" count={m.activity.length}>
                <div className="divide-y divide-line">
                  {[...m.activity].reverse().map((a, i) => (
                    <div key={i} className="flex gap-3 px-4 py-2">
                      <span className="text-muted">{new Date(a.at).toLocaleString()}</span>
                      <span className="flex-1">
                        {a.kind === "objects_added" || a.kind === "objects_removed"
                          ? `${a.count} object${a.count === 1 ? "" : "s"} ${a.kind === "objects_added" ? "added" : "removed"}: ${(a.objects ?? []).slice(0, 6).join(", ")}`
                          : a.kind === "threshold_crossed"
                            ? `Condition ${a.status ? "met" : "no longer met"} (value ${a.value?.toLocaleString()})`
                            : a.kind === "error"
                              ? a.detail
                              : `Metric ${a.from?.toLocaleString()} → ${a.to?.toLocaleString()}`}
                      </span>
                      <span className="text-muted">{a.trigger}</span>
                    </div>
                  ))}
                  {!m.activity.length && <div className="p-4 text-muted">No activity yet (kept six months).</div>}
                </div>
              </Card>
            </div>
          )}
        </main>
      </div>
      {creating && (
        <NewMonitor
          types={types}
          explorations={explorations}
          onClose={() => setCreating(false)}
          onCreated={async (x) => {
            setCreating(false);
            await load();
            setSelected(x.id);
          }}
        />
      )}
      {migrating === "one" && m && (
        <MigrateMonitor
          monitor={m}
          onClose={() => setMigrating(null)}
          onMigrated={async () => {
            setMigrating(null);
            await load();
          }}
        />
      )}
      {migrating === "all" && (
        <MigrateAll
          onClose={async () => {
            setMigrating(null);
            await load();
          }}
          onOpen={(id) => {
            setMigrating(null);
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}

/** What translated into what, what does not translate (any entry refuses the migration) and the notes. */
function PlanDetails({ plan }: { plan: MigrationPlan }) {
  const [showJson, setShowJson] = useState(false);
  return (
    <div className="space-y-3 text-xs">
      {plan.untranslatable.length > 0 && (
        <div className="rounded-lg border border-bad/30 bg-bad/10 p-3">
          <div className="mb-1 font-semibold text-bad">Does not translate — the migration is refused</div>
          <ul className="space-y-1">
            {plan.untranslatable.map((b, i) => (
              <li key={i}>
                <span className="font-medium">{b.feature}:</span> <span className="text-soft">{b.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.translated.length > 0 && (
        <div>
          <div className="mb-1 font-semibold">{plan.translates ? "Translated" : "Would translate"}</div>
          <table className="w-full">
            <thead>
              <tr className="text-left text-[11px] text-muted">
                <th className="py-1 pr-3 font-normal">Monitor</th>
                <th className="py-1 font-normal">Automate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {plan.translated.map((t, i) => (
                <tr key={i}>
                  <td className="py-1 pr-3 align-top">{t.monitor}</td>
                  <td className="py-1 align-top text-soft">{t.automate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {plan.notes.length > 0 && (
        <div>
          <div className="mb-1 font-semibold">Notes</div>
          <ul className="list-disc space-y-1 pl-4 text-soft">
            {plan.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.automation && (
        <div>
          <button type="button" onClick={() => setShowJson((v) => !v)} className="text-ocean">
            {showJson ? "Hide" : "Show"} the automation that would be created
          </button>
          {showJson && <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-line bg-ink p-2 font-mono text-[10px]">{JSON.stringify(plan.automation, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

/** One monitor: the dry run first (nothing created), then migrate. Threshold and function-backed monitors need a
 * published function (an ObjectSet of the input type → boolean) standing for the condition. */
function MigrateMonitor({ monitor, onClose, onMigrated }: { monitor: Monitor; onClose: () => void; onMigrated: () => void }) {
  const needsFunction = monitor.condition.kind === "threshold" || monitor.condition.kind === "function";
  const [fnId, setFnId] = useState("");
  const [fnVersion, setFnVersion] = useState("");
  const [fnInput, setFnInput] = useState("");
  const [fns, setFns] = useState<FunctionRow[]>([]);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const body = () => (needsFunction && fnId.trim() ? { condition_function: { function_id: fnId.trim(), version: fnVersion.trim() || null, objects_input: fnInput.trim() || null } } : {});
  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await req<MigrationPlan>(`/${monitor.id}/migrate/dry-run`, { method: "POST", json: body() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    // the first dry run, without a condition function; later ones on "Check again"
    req<MigrationPlan>(`/${monitor.id}/migrate/dry-run`, { method: "POST", json: {} })
      .then(setPlan, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [monitor.id]);
  useEffect(() => {
    if (needsFunction) functions.list().then((rows) => setFns(rows.filter((f) => f.output === "boolean" && f.inputs.some((i) => String(i.type).startsWith("object_set:")))), () => undefined);
  }, [needsFunction]);
  const migrate = async () => {
    if (!(await confirmDialog({ message: `Create the automation and pause ${monitor.name}? The monitor stops being evaluated; the migration can be undone.`, confirmLabel: "Migrate" }))) return;
    setBusy(true);
    setError(null);
    try {
      await req(`/${monitor.id}/migrate`, { method: "POST", json: body() });
      onMigrated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Migrate to Automate: ${monitor.name}`} icon="bolt" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-xs">
        <p className="text-muted">
          A dry run: nothing is created until you migrate. Migrating creates the automation through Automate (its own validation applies), links it to this monitor and pauses the
          monitor so the two never both fire.
        </p>
        {needsFunction && (
          <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3">
            <div className="font-semibold">Condition function</div>
            <p className="text-muted">
              Automate has no {monitor.condition.kind === "threshold" ? "aggregate threshold" : "list-of-objects function condition"} of its own: name a published function that takes the
              monitor&apos;s input as an ObjectSet and returns a boolean. It is checked against the monitor&apos;s condition on the current data before anything is created.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block space-y-1 text-[11px] text-muted">
                Function
                <select value={fnId} onChange={(e) => setFnId(e.target.value)} className={inputClass}>
                  <option value="">— none —</option>
                  {fns.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.id})
                    </option>
                  ))}
                  {fnId && !fns.some((f) => f.id === fnId) && <option value={fnId}>{fnId}</option>}
                </select>
              </label>
              <label className="block space-y-1 text-[11px] text-muted">
                Version (latest when empty)
                <input value={fnVersion} onChange={(e) => setFnVersion(e.target.value)} className={inputClass} />
              </label>
              <label className="block space-y-1 text-[11px] text-muted">
                ObjectSet input (when it has several)
                <input value={fnInput} onChange={(e) => setFnInput(e.target.value)} className={inputClass} />
              </label>
            </div>
            <button type="button" onClick={() => void preview()} disabled={busy} className={buttonClass.secondary}>
              Check again
            </button>
          </div>
        )}
        <ErrorBox message={error} />
        {!plan && busy && <Loading />}
        {plan && <PlanDetails plan={plan} />}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" onClick={onClose} className={buttonClass.ghost}>
            Cancel
          </button>
          <button type="button" onClick={() => void migrate()} disabled={busy || !plan?.translates} className={buttonClass.primary}>
            Migrate
          </button>
        </div>
      </div>
    </Modal>
  );
}

const BULK_LABEL: Record<BulkStatus, string> = {
  would_migrate: "would migrate",
  migrated: "migrated",
  refused: "does not translate",
  already_migrated: "already migrated",
  failed: "failed",
};

/** Every monitor: a dry run over all of them, then migrate the ones that translate (each refused one keeps running). */
function MigrateAll({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [res, setRes] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    req<BulkResult>("/migrate-all", { method: "POST", json: { dry_run: true } }).then(setRes, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  }, []);
  const ready = (res?.results ?? []).filter((r) => r.status === "would_migrate");
  const migrate = async () => {
    if (!(await confirmDialog({ message: `Migrate ${ready.length} monitor${ready.length === 1 ? "" : "s"} to Automate? Each gets its automation and is paused; each migration can be undone.`, confirmLabel: "Migrate" })))
      return;
    setBusy(true);
    setError(null);
    try {
      setRes(await req<BulkResult>("/migrate-all", { method: "POST", json: { ids: ready.map((r) => r.id) } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Migrate monitors to Automate" icon="bolt" onClose={onClose} xl>
      <div className="space-y-3 p-4 text-xs">
        <p className="text-muted">
          {res?.dry_run === false
            ? `Done: ${res.migrated} migrated, ${res.refused} refused, ${res.failed} failed.`
            : "A dry run over every monitor: nothing is created yet. Threshold and function-backed monitors need a condition function — migrate them one at a time."}
        </p>
        <ErrorBox message={error} />
        {!res && busy && <Loading />}
        {res && (
          <div className="max-h-[60vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {res.results.map((r) => (
              <div key={r.id} className="flex gap-3 px-3 py-2">
                <div className="w-64 shrink-0">
                  <button type="button" onClick={() => onOpen(r.id)} className="text-left text-ocean hover:underline">
                    {r.name}
                  </button>
                  <div className="text-[11px] text-muted">{KIND_LABEL[r.kind]}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <span className={r.status === "refused" || r.status === "failed" ? "text-bad" : r.status === "already_migrated" ? "text-muted" : "text-ok"}>{BULK_LABEL[r.status]}</span>
                  {r.automation_id && (
                    <Link href={`/automate/${r.automation_id}`} className="ml-2 text-ocean underline">
                      automation
                    </Link>
                  )}
                  {r.error && <div className="text-soft">{r.error}</div>}
                  {(r.untranslatable ?? []).map((b, i) => (
                    <div key={i} className="text-soft">
                      <span className="font-medium">{b.feature}:</span> {b.reason}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!res.results.length && <div className="p-3 text-muted">No monitors.</div>}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" onClick={onClose} className={buttonClass.ghost}>
            Close
          </button>
          {res?.dry_run && (
            <button type="button" onClick={() => void migrate()} disabled={busy || !ready.length} className={buttonClass.primary}>
              Migrate {ready.length} that translate{ready.length === 1 ? "s" : ""}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NewMonitor({ types, explorations, onClose, onCreated }: { types: ObjectType[]; explorations: Exploration[]; onClose: () => void; onCreated: (m: Monitor) => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<"exploration" | "type">(explorations.length ? "exploration" : "type");
  const [expId, setExpId] = useState(explorations[0]?.id ?? "");
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [kind, setKind] = useState<Condition["kind"]>("objects_added");
  const [metric, setMetric] = useState<Metric>({ metric: "count" });
  const [op, setOp] = useState("gt");
  const [value, setValue] = useState("0");
  const [every, setEvery] = useState(60);
  const [actionId, setActionId] = useState("");
  const [actions, setActions] = useState<ActionType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const objectTypeId = source === "type" ? typeId : (explorations.find((e) => e.id === expId)?.spec.object_type_id ?? "");
  useEffect(() => {
    if (objectTypeId) ontology.actionTypes(objectTypeId).then((a) => setActions(a.filter((x) => x.kind !== "create")), () => setActions([]));
  }, [objectTypeId]);
  const numeric = (types.find((t) => t.id === objectTypeId)?.properties ?? []).filter((p) => ["integer", "long", "double", "float", "decimal", "short"].includes(p.type));
  const th = { metric, op, value: Number(value) || 0 };
  return (
    <Modal title="New object monitor" icon="bell" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monitor name" className={inputClass} />
        <div className="flex gap-2 text-xs">
          <select value={source} onChange={(e) => setSource(e.target.value as "type")} className={fieldClass}>
            <option value="exploration">Saved exploration</option>
            <option value="type">All objects of a type</option>
          </select>
          {source === "exploration" ? (
            <select value={expId} onChange={(e) => setExpId(e.target.value)} className={`${fieldClass} flex-1`}>
              {explorations.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          ) : (
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={`${fieldClass} flex-1`}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <select value={kind} onChange={(e) => setKind(e.target.value as Condition["kind"])} className={fieldClass}>
            {(Object.keys(KIND_LABEL) as Condition["kind"][])
              .filter((k) => k !== "function")
              .map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
          </select>
          {kind !== "objects_added" && kind !== "objects_removed" && (
            <>
              <select value={metric.metric} onChange={(e) => setMetric({ ...metric, metric: e.target.value as Metric["metric"] })} className={fieldClass}>
                {["count", "sum", "avg", "min", "max"].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              {metric.metric !== "count" && (
                <select value={metric.property ?? ""} onChange={(e) => setMetric({ ...metric, property: e.target.value })} className={fieldClass}>
                  <option value="">property…</option>
                  {numeric.map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          {kind === "threshold" && (
            <>
              <select value={op} onChange={(e) => setOp(e.target.value)} className={fieldClass}>
                {["gt", "gte", "lt", "lte", "eq"].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <input value={value} onChange={(e) => setValue(e.target.value)} className={`${fieldClass} w-32`} />
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span>Evaluate every</span>
          <input type="number" min={5} max={1440} value={every} onChange={(e) => setEvery(Number(e.target.value) || 60)} className={`${fieldClass} w-20`} />
          <span>minutes (realtime when the input and condition allow)</span>
        </div>
        {kind === "objects_added" && (
          <select value={actionId} onChange={(e) => setActionId(e.target.value)} className={inputClass} aria-label="Action on each added object">
            <option value="">Notify only</option>
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                Also apply: {a.display_name}
              </option>
            ))}
          </select>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name}
            onClick={() =>
              req<Monitor>("", {
                method: "POST",
                json: {
                  name,
                  exploration_id: source === "exploration" ? expId : null,
                  search: source === "type" ? { object_type_id: typeId } : null,
                  condition: { kind, metric, threshold: kind === "threshold" ? th : null },
                  every_minutes: every,
                  subscribers: actionId ? [{ user: "me", notify: true, action: { action_type_id: actionId, object_parameter: "object" } }] : [],
                },
              }).then(onCreated, (e: Error) => setError(e.message))
            }
            className={buttonClass.primary}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

