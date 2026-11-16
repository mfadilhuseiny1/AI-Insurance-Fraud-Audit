"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { ApiError, Loading } from "@/components/States";
import { Bars } from "@/components/streaming/StreamingSyncs";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { health, type HealthResources } from "@/lib/health";
import { timeseries, type SeriesSync } from "@/lib/timeseries";
import {
  RULE_LABEL,
  streaming,
  type IngestStream,
  type Monitor,
  type MonitorConfig,
  type MonitoringViewDetail,
  type MonitorResource,
  type MonitorRule,
  type Severity,
  type StreamingSync,
  type NotificationFrequency,
  type Subscription,
  type SubscriptionDelivery,
} from "@/lib/streaming";

type Tab = "monitors" | "subscriptions" | "alerts";
type RuleInfo = { id: MonitorRule; resource_types: MonitorResource[]; unit: string; description: string };
const RESOURCE_LABEL: Record<MonitorResource, string> = {
  sync: "Streaming sync (job)",
  stream: "Ingest stream",
  dataset: "Dataset",
  schedule: "Schedule",
  dc_sync: "Data Connection sync or export",
  timeseries_sync: "Time series sync",
  geotemporal: "Geotemporal observations",
};
/** checks with no threshold: they pass or fail */
const NO_THRESHOLD: MonitorRule[] = ["columns", "schema", "build_status", "up_to_date", "schedule_status", "sync_status"];
const DEFAULT_RULE: Record<MonitorResource, [MonitorRule, string]> = {
  sync: ["records_ingested", "0"],
  stream: ["records_ingested", "0"],
  dataset: ["freshness", "24"],
  schedule: ["schedule_status", "60"],
  dc_sync: ["sync_status", "24"],
  timeseries_sync: ["points_written", "0"],
  geotemporal: ["geotemporal_observations_sent", "0"],
};
/** checks with a minimum (the threshold) and an optional maximum */
const MIN_MAX: MonitorRule[] = ["total_throughput", "row_count", "sync_row_count"];
/** monitors over a 5 or 30 minute window */
const WINDOWED: MonitorResource[] = ["stream", "sync", "timeseries_sync", "geotemporal"];
const COLUMN_TYPES = ["String", "Boolean", "Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal", "Date", "Timestamp", "Binary"];

function resourceHref(m: Pick<Monitor, "resource_type" | "resource_id">) {
  switch (m.resource_type) {
    case "stream":
      return `/streaming/streams/${m.resource_id}`;
    case "sync":
      return `/streaming/syncs/${m.resource_id}`;
    case "dataset":
      return "/lineage";
    case "schedule":
      return `/pipeline/${m.resource_id.split("/")[0]}`;
    case "dc_sync":
      return "/sources";
    case "timeseries_sync":
      return `/time-series/${m.resource_id}`;
    case "geotemporal":
      return `/map?sync=${m.resource_id}`;
  }
}
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const SEVERITY_CLASS: Record<Severity, string> = {
  low: "bg-panel-2 text-soft",
  medium: "bg-warn/15 text-warn",
  high: "bg-bad/15 text-bad",
  critical: "bg-bad/30 text-bad",
};

export default function MonitoringViewPage() {
  const { viewId } = useParams<{ viewId: string }>();
  const router = useRouter();
  const [view, setView] = useState<MonitoringViewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("monitors");
  const load = useCallback(() => streaming.view(viewId).then(setView, (e: Error) => setError(e.message)), [viewId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);
  if (error) return <ApiError message={error} />;
  if (!view) return <Loading />;
  const firing = view.alerts.filter((a) => a.state === "firing").length;
  const evaluate = () => streaming.evaluate().then(load, (e: Error) => alertDialog(e.message));
  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete monitoring view", message: `Delete "${view.name}" with its monitors and subscriptions?`, confirmLabel: "Delete", danger: true }))) return;
    streaming.deleteView(view.id).then(() => router.push("/data-health"), (e: Error) => alertDialog(e.message));
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <Link href="/data-health" className="text-muted hover:text-white">
          <Icon name="left" className="h-4 w-4" />
        </Link>
        <Icon name="gauge" className="h-5 w-5 text-ocean" />
        <div className="min-w-0">
          <div className="truncate font-medium">{view.name}</div>
          <div className="text-xs text-muted">Monitoring view{view.description ? ` · ${view.description}` : ""}</div>
        </div>
        <nav className="ml-6 flex gap-1 text-sm">
          {(
            [
              ["monitors", `Manage monitors (${view.monitors.length})`, "gauge"],
              ["subscriptions", `Manage subscriptions (${view.subscriptions.length})`, "bell"],
              ["alerts", `Troubleshoot alerts${firing ? ` (${firing})` : ""}`, "alert"],
            ] as [Tab, string, IconName][]
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
            >
              <Icon name={icon} className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 gap-2 whitespace-nowrap">
          <button type="button" onClick={evaluate} className={buttonClass.secondary}>
            <Icon name="refresh" /> Evaluate now
          </button>
          <button type="button" onClick={remove} className={buttonClass.secondary}>
            <Icon name="trash" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-6">
          {tab === "monitors" && <Monitors view={view} onChange={load} />}
          {tab === "subscriptions" && <Subscriptions view={view} onChange={load} />}
          {tab === "alerts" && <Alerts view={view} onChange={load} />}
        </div>
      </div>
    </div>
  );
}

function Monitors({ view, onChange }: { view: MonitoringViewDetail; onChange: () => void }) {
  // ?add=<resource type>:<resource id> (from Data Connection, Lineage …) opens Add monitoring rules for it
  const [preset] = useState<{ type: MonitorResource; id: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const add = new URLSearchParams(window.location.search).get("add");
    const i = add?.indexOf(":") ?? -1;
    const type = add?.slice(0, i) as MonitorResource;
    return add && i > 0 && type in RESOURCE_LABEL ? { type, id: add.slice(i + 1) } : null;
  });
  const [adding, setAdding] = useState(!!preset);
  const [open, setOpen] = useState<string | null>(null);
  const remove = async (m: Monitor) => {
    if (!(await confirmDialog({ title: "Delete monitor", message: `Delete "${m.name}"?`, confirmLabel: "Delete", danger: true }))) return;
    streaming.deleteMonitor(m.id).then(onChange, (e: Error) => alertDialog(e.message));
  };
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted">Monitoring rules are checked every 30 seconds (stream rules over a 5 or 30 minute window; dataset checks on data refreshed every two minutes). Click a monitor to see its metric.</p>
        <button type="button" onClick={() => setAdding(true)} className={buttonClass.primary}>
          <Icon name="plus" /> Add monitoring rules
        </button>
      </div>
      {view.monitors.length === 0 ? (
        <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">No monitors yet.</p>
      ) : (
        <table className="w-full rounded-xl border border-line bg-panel text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-2">Monitor</th>
              <th className="px-3 py-2">Resource</th>
              <th className="px-3 py-2">Rule</th>
              <th className="px-3 py-2">Threshold</th>
              <th className="px-3 py-2">Severity</th>
              <th className="px-3 py-2">State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {view.monitors.map((m) => (
              <MonitorRow key={m.id} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} onDelete={() => remove(m)} />
            ))}
          </tbody>
        </table>
      )}
      {adding && <AddMonitorDialog viewId={view.id} preset={preset} onClose={() => setAdding(false)} onAdded={() => (setAdding(false), onChange())} />}
    </div>
  );
}

function MonitorRow({ m, open, onToggle, onDelete }: { m: Monitor; open: boolean; onToggle: () => void; onDelete: () => void }) {
  const [points, setPoints] = useState<{ minute: string; value: number | null }[] | null>(null);
  useEffect(() => {
    if (open) streaming.monitorMetrics(m.id).then((r) => setPoints(r.points), () => setPoints([]));
  }, [open, m.id]);
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-b border-line last:border-0 hover:bg-panel-2">
        <td className="px-3 py-2">{m.name}</td>
        <td className="px-3 py-2 text-xs">
          <Link href={resourceHref(m)} onClick={(e) => e.stopPropagation()} className="text-ocean hover:underline">
            {m.resource_name}
          </Link>
          <span className="ml-1 text-muted">({m.resource_type})</span>
        </td>
        <td className="px-3 py-2 text-xs">
          {RULE_LABEL[m.rule]}
          {WINDOWED.includes(m.resource_type) ? ` · ${m.window_minutes} min` : ""}
          {m.config?.ignore_empty ? " · ignores empty transactions" : ""}
          {m.rule === "data_freshness" && m.config?.column ? ` · newest ${m.config.column}` : ""}
          {m.rule === "schema" ? ` · ${m.config?.mode === "exact" ? "exact match" : "additions allowed"}` : ""}
          {m.rule === "sync_row_count" ? ` · ${m.config?.measure === "total" ? "rows in the dataset / export target" : "rows of the last successful run"}` : ""}
          {m.message && <div className={m.state === "firing" ? "text-bad" : "text-muted"}>{m.message}</div>}
        </td>
        <td className="px-3 py-2 text-xs">
          {NO_THRESHOLD.includes(m.rule) ? "—" : m.threshold}
          {m.threshold_max != null ? ` – ${m.threshold_max}` : ""}
          {m.value != null && <span className="ml-1 text-muted">(now {Math.round(m.value * 100) / 100})</span>}
        </td>
        <td className="px-3 py-2">
          <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_CLASS[m.severity]}`}>{m.severity}</span>
        </td>
        <td className="px-3 py-2 text-xs">
          {m.state === "firing" ? m.recovered ? <span className="text-warn">Passing · resolve the alert</span> : <span className="text-bad">Firing</span> : <span className="text-ok">OK</span>}
          {m.auto_resolve === false && <span className="ml-1 text-muted">· manual resolve</span>}
          {m.checked_at && <span className="ml-1 text-muted">· {when(m.checked_at)}</span>}
        </td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted hover:text-bad"
          >
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line">
          <td colSpan={7} className="px-3 py-2">
            {points ? (
              <Bars points={points} label={m.resource_type === "dataset" ? "Rows per transaction" : m.resource_type === "schedule" ? "Minutes per run" : m.resource_type === "dc_sync" ? "Rows per run (failed runs 0)" : `${RULE_LABEL[m.rule]} (last 2 hours)`} />
            ) : (
              <span className="text-xs text-muted">Loading…</span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AddMonitorDialog({
  viewId,
  preset,
  onClose,
  onAdded,
}: {
  viewId: string;
  preset?: { type: MonitorResource; id: string } | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [streams, setStreams] = useState<IngestStream[]>([]);
  const [syncs, setSyncs] = useState<StreamingSync[]>([]);
  const [others, setOthers] = useState<HealthResources>({ datasets: [], schedules: [], syncs: [] });
  const [seriesSyncs, setSeriesSyncs] = useState<SeriesSync[]>([]);
  const [resourceType, setResourceType] = useState<MonitorResource>(preset?.type ?? "sync");
  const [resourceId, setResourceId] = useState(preset?.id ?? "");
  const [rule, setRule] = useState<MonitorRule>(DEFAULT_RULE[preset?.type ?? "sync"][0]);
  const [windowMinutes, setWindowMinutes] = useState<5 | 30>(5);
  const [threshold, setThreshold] = useState(DEFAULT_RULE[preset?.type ?? "sync"][1]);
  const [thresholdMax, setThresholdMax] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<MonitorConfig>({});
  const [schemaText, setSchemaText] = useState("");
  const [autoResolve, setAutoResolve] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    streaming.rules().then((r) => setRules(r.rules), (e: Error) => setError(e.message));
    streaming.streams().then(setStreams, () => {});
    streaming.syncs().then(setSyncs, () => {});
    health.resources().then(setOthers, () => {});
    timeseries.syncs().then(setSeriesSyncs, () => {});
  }, []);
  const listed: { id: string; name: string }[] =
    resourceType === "stream"
      ? streams
      : resourceType === "sync"
        ? syncs
        : resourceType === "dataset"
          ? others.datasets
          : resourceType === "dc_sync"
            ? (others.syncs ?? [])
            : resourceType === "timeseries_sync"
              ? seriesSyncs.filter((s) => s.kind === "timeseries").map((s) => ({ id: s.id, name: `${s.name} · ${s.pipeline_name || "pipeline"} (${s.mode})` }))
              : resourceType === "geotemporal"
                ? seriesSyncs.filter((s) => s.kind === "geotemporal").map((s) => ({ id: s.id, name: `${s.name} · ${s.pipeline_name || "pipeline"} (${s.mode})` }))
                : others.schedules;
  // a resource passed in the link stays selectable while the lists load (or if it is not listed)
  const resources = preset && preset.type === resourceType && !listed.some((r) => r.id === preset.id) ? [{ id: preset.id, name: preset.id }, ...listed] : listed;
  // "name: Type" per line (or comma-separated)
  const schemaColumns = schemaText
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [n, t] = l.split(":").map((x) => x.trim());
      return { name: n, type: COLUMN_TYPES.find((c) => c.toLowerCase() === (t ?? "").toLowerCase()) ?? "" };
    });
  const available = rules.filter((r) => r.resource_types.includes(resourceType));
  const info = rules.find((r) => r.id === rule);
  const target = resourceId || resources[0]?.id || "";
  const add = () =>
    streaming
      .createMonitor(viewId, {
        // a preset resource not listed yet (the lists still loading) is named by the API, not by its id
        name: name.trim() || (listed.some((r) => r.id === target) ? `${RULE_LABEL[rule]} · ${listed.find((r) => r.id === target)?.name ?? ""}` : ""),
        resource_type: resourceType,
        resource_id: target,
        rule,
        window_minutes: windowMinutes,
        threshold: Number(threshold) || 0,
        threshold_max: thresholdMax ? Number(thresholdMax) : null,
        severity,
        enabled: true,
        config: rule === "schema" ? { mode: config.mode ?? "additions", columns: schemaColumns } : config,
        auto_resolve: autoResolve,
      })
      .then(onAdded, (e: Error) => setError(e.message));
  return (
    <Modal title="Add monitoring rules" icon="gauge" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Resource type">
            <select
              value={resourceType}
              onChange={(e) => {
                const t = e.target.value as MonitorResource;
                setResourceType(t);
                setResourceId("");
                setConfig({});
                setRule(DEFAULT_RULE[t][0]);
                setThreshold(DEFAULT_RULE[t][1]);
              }}
              className={inputClass}
            >
              {(Object.keys(RESOURCE_LABEL) as MonitorResource[]).map((k) => (
                <option key={k} value={k}>
                  {RESOURCE_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Resource">
            <select value={target} onChange={(e) => setResourceId(e.target.value)} className={inputClass}>
              {resources.length === 0 && <option value="">None yet</option>}
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Monitoring rule" hint={info?.description}>
          <select
            value={rule}
            onChange={(e) => {
              const r = e.target.value as MonitorRule;
              setRule(r);
              // a Data Connection sync's default (24 hours) is no row count minimum
              if (resourceType === "dc_sync") setThreshold(r === "sync_row_count" ? "1" : DEFAULT_RULE.dc_sync[1]);
            }}
            className={inputClass}
          >
            {available.map((r) => (
              <option key={r.id} value={r.id}>
                {RULE_LABEL[r.id]}
              </option>
            ))}
          </select>
        </Field>
        {rule === "columns" && (
          <Field label="Required columns" hint="Comma separated.">
            <input value={(config.required ?? []).join(", ")} onChange={(e) => setConfig({ ...config, required: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={inputClass} />
          </Field>
        )}
        {rule === "schema" && (
          <>
            <Field label="Mode">
              <select value={config.mode ?? "additions"} onChange={(e) => setConfig({ ...config, mode: e.target.value as "additions" | "exact" })} className={inputClass}>
                <option value="additions">Allow additions: these columns with these types, other columns may be added</option>
                <option value="exact">Exact match: exactly these columns</option>
              </select>
            </Field>
            <Field label="Expected columns" hint={`One per line as name: Type (${COLUMN_TYPES.join(", ")}); leave the type out to check the name only.`}>
              <textarea value={schemaText} onChange={(e) => setSchemaText(e.target.value)} rows={4} placeholder={"id: Long\nname: String\nupdated_at: Timestamp"} className={`${inputClass} font-mono text-xs`} />
            </Field>
          </>
        )}
        {rule === "data_freshness" && (
          <Field label="Timestamp column" hint="The newest value in this column (a Timestamp, Date, ISO text or epoch number) must be newer than the threshold: it checks when the data is from, not when the dataset was written.">
            <input value={config.column ?? ""} onChange={(e) => setConfig({ ...config, column: e.target.value })} placeholder="event_time" className={inputClass} />
          </Field>
        )}
        {rule === "sync_freshness" && (
          <p className="text-xs text-muted">
            A sync is stale when it had no successful run within the threshold. An export is stale when its dataset changed longer than the threshold ago and was not
            exported since.
          </p>
        )}
        {rule === "sync_row_count" && (
          <Field label="Rows counted" hint="Fires when the count is below the minimum or above the maximum.">
            <select value={config.measure ?? "run"} onChange={(e) => setConfig({ ...config, measure: e.target.value as "run" | "total" })} className={inputClass}>
              <option value="run">Rows of the last successful run</option>
              <option value="total">Rows in the synced dataset (an export: rows in the export target)</option>
            </select>
          </Field>
        )}
        {rule === "time_since_updated" && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={!!config.ignore_empty} onChange={(e) => setConfig({ ...config, ignore_empty: e.target.checked })} className="accent-[var(--color-ocean)]" />
            Ignore empty transactions (builds that wrote no rows do not count as an update)
          </label>
        )}
        <div className="grid grid-cols-3 gap-3">
          {WINDOWED.includes(resourceType) && (
            <Field label="Window">
              <select value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value) as 5 | 30)} className={inputClass}>
                <option value={5}>5 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
            </Field>
          )}
          {!NO_THRESHOLD.includes(rule) && (
            <Field label={`${rule === "row_count" || rule === "sync_row_count" ? "Minimum" : "Threshold"}${info?.unit ? ` (${info.unit})` : ""}`}>
              <input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} className={inputClass} />
            </Field>
          )}
          {MIN_MAX.includes(rule) ? (
            <Field label="Maximum (optional)">
              <input type="number" value={thresholdMax} onChange={(e) => setThresholdMax(e.target.value)} className={inputClass} />
            </Field>
          ) : (
            <Field label="Severity">
              <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={inputClass}>
                {SEVERITIES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {MIN_MAX.includes(rule) && (
          <Field label="Severity">
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={inputClass}>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        )}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} className="accent-[var(--color-ocean)]" />
          Auto-resolve: close the alert when the check passes again (off: it stays open until resolved by hand)
        </label>
        <Field label="Name (optional)">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!target || (rule === "schema" && !schemaColumns.length) || (rule === "columns" && !config.required?.length) || (rule === "data_freshness" && !config.column?.trim())} onClick={add} className={buttonClass.primary}>
            Add monitor
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SUB_KIND: Record<Subscription["kind"], { label: string; icon: IconName; target: string; hint: string }> = {
  email: { label: "Email", icon: "comment", target: "Email address", hint: "Sent with Resend (RESEND_API_KEY, RESEND_FROM) or an SMTP server (BLUESANDAI_SMTP_HOST …), as set in .env.local." },
  pagerduty: { label: "PagerDuty", icon: "bell", target: "Integration key", hint: "An Events API v2 integration (routing) key from a PagerDuty service. Alerts trigger and resolve incidents." },
  webhook: { label: "Webhook", icon: "link", target: "URL", hint: "Receives a JSON POST when an alert fires or resolves." },
};

const FREQUENCY_LABEL: Record<NotificationFrequency, string> = { immediate: "Immediately", hourly: "Hourly digest", daily: "Daily digest" };
const DEFAULT_DELIVERY: SubscriptionDelivery = {
  frequency: "immediate",
  digest_hour: 8,
  digest_timezone: (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })(),
  notify_resolved: true,
};

function deliveryText(s: Subscription) {
  const freq =
    s.frequency === "daily" ? `Daily digest at ${String(s.digest_hour).padStart(2, "0")}:00 ${s.digest_timezone}` : s.frequency === "hourly" ? "Hourly digest" : "Immediately";
  return `${freq}${s.notify_resolved ? "" : " · fired alerts only"}`;
}

/** Notification frequency: each alert as it happens, or an hourly / daily digest (email and webhook). */
function DeliveryFields({ kind, value, onChange }: { kind: Subscription["kind"]; value: SubscriptionDelivery; onChange: (v: SubscriptionDelivery) => void }) {
  if (kind === "pagerduty") return <p className="text-xs text-muted">PagerDuty is notified immediately; it groups and escalates incidents itself.</p>;
  return (
    <>
      <Field label="Notification frequency" hint="A digest collects the alerts in between and sends them as one email or webhook call.">
        <select value={value.frequency} onChange={(e) => onChange({ ...value, frequency: e.target.value as NotificationFrequency })} className={inputClass}>
          {(Object.keys(FREQUENCY_LABEL) as NotificationFrequency[]).map((f) => (
            <option key={f} value={f}>
              {FREQUENCY_LABEL[f]}
            </option>
          ))}
        </select>
      </Field>
      {value.frequency === "daily" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Send at">
            <select value={value.digest_hour} onChange={(e) => onChange({ ...value, digest_hour: Number(e.target.value) })} className={inputClass}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </Field>
          <Field label="Time zone">
            <input value={value.digest_timezone} onChange={(e) => onChange({ ...value, digest_timezone: e.target.value })} className={inputClass} />
          </Field>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={value.notify_resolved} onChange={(e) => onChange({ ...value, notify_resolved: e.target.checked })} className="accent-[var(--color-ocean)]" />
        Also notify when an alert resolves
      </label>
    </>
  );
}

function Subscriptions({ view, onChange }: { view: MonitoringViewDetail; onChange: () => void }) {
  const [kind, setKind] = useState<Subscription["kind"]>("email");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [severities, setSeverities] = useState<Severity[]>([...SEVERITIES]);
  const [delivery, setDelivery] = useState<SubscriptionDelivery>(DEFAULT_DELIVERY);
  const [error, setError] = useState<string | null>(null);
  const add = () =>
    streaming.createSubscription(view.id, { kind, name: name.trim() || SUB_KIND[kind].label, target: target.trim(), severities, ...(kind === "pagerduty" ? { ...delivery, frequency: "immediate" } : delivery) }).then(
      () => {
        setTarget("");
        setName("");
        setError(null);
        onChange();
      },
      (e: Error) => setError(e.message),
    );
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div>
        {view.subscriptions.length === 0 ? (
          <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">No subscriptions: alerts only show here.</p>
        ) : (
          <ul className="space-y-2">
            {view.subscriptions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2 text-sm">
                <Icon name={SUB_KIND[s.kind].icon} className="h-4 w-4 text-ocean" />
                <div className="min-w-0 flex-1">
                  <div>{s.name}</div>
                  <div className="truncate text-xs text-muted">
                    {SUB_KIND[s.kind].label} · {s.target} · {s.severities.join(", ")}
                  </div>
                  <div className="text-xs text-muted">
                    {deliveryText(s)}
                    {s.frequency !== "immediate" && (
                      <>
                        {` · ${s.queued ?? 0} waiting`}
                        {s.next_digest_at ? ` · next ${when(s.next_digest_at)}` : ""}
                        {(s.queued ?? 0) > 0 && (
                          <button
                            type="button"
                            onClick={() => streaming.sendDigest(s.id).then((r) => (alertDialog(`Sent ${r.sent} alert${r.sent === 1 ? "" : "s"}`), onChange()), (e: Error) => alertDialog(e.message))}
                            className="ml-2 text-ocean hover:underline"
                          >
                            Send now
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {s.kind !== "pagerduty" && (
                  <select
                    value={s.frequency}
                    title="Notification frequency"
                    onChange={(e) => streaming.updateSubscription(s.id, { frequency: e.target.value as NotificationFrequency }).then(onChange, (err: Error) => alertDialog(err.message))}
                    className={`${fieldClass} w-36 shrink-0 py-1 text-xs`}
                  >
                    {(Object.keys(FREQUENCY_LABEL) as NotificationFrequency[]).map((f) => (
                      <option key={f} value={f}>
                        {FREQUENCY_LABEL[f]}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" onClick={() => streaming.deleteSubscription(s.id).then(onChange, (e: Error) => alertDialog(e.message))} className="text-muted hover:text-bad">
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-3 rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="font-medium">Add subscription</div>
        <div className="flex gap-1">
          {(Object.keys(SUB_KIND) as Subscription["kind"][]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`flex-1 rounded-md px-2 py-1 text-xs ${kind === k ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2"}`}
            >
              {SUB_KIND[k].label}
            </button>
          ))}
        </div>
        <Field label={SUB_KIND[kind].target} hint={SUB_KIND[kind].hint}>
          <input value={target} onChange={(e) => setTarget(e.target.value)} type={kind === "pagerduty" ? "password" : "text"} className={inputClass} />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={SUB_KIND[kind].label} className={inputClass} />
        </Field>
        <Field label="Severities">
          <div className="flex flex-wrap gap-2 text-xs">
            {SEVERITIES.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={severities.includes(s)}
                  onChange={() => setSeverities(severities.includes(s) ? severities.filter((x) => x !== s) : [...severities, s])}
                  className="accent-[var(--color-ocean)]"
                />
                {s}
              </label>
            ))}
          </div>
        </Field>
        <DeliveryFields kind={kind} value={delivery} onChange={setDelivery} />
        {error && <p className="text-xs text-bad">{error}</p>}
        <button type="button" disabled={!target.trim() || severities.length === 0} onClick={add} className={`${buttonClass.primary} w-full justify-center`}>
          Subscribe
        </button>
      </div>
    </div>
  );
}

function Alerts({ view, onChange }: { view: MonitoringViewDetail; onChange: () => void }) {
  if (view.alerts.length === 0) return <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">No alerts.</p>;
  const sorted = [...view.alerts].sort((a, b) => (a.state === b.state ? b.fired_at.localeCompare(a.fired_at) : a.state === "firing" ? -1 : 1));
  return (
    <table className="w-full rounded-xl border border-line bg-panel text-sm">
      <thead className="text-left text-xs text-muted">
        <tr className="border-b border-line">
          <th className="px-3 py-2">State</th>
          <th className="px-3 py-2">Monitor</th>
          <th className="px-3 py-2">Resource</th>
          <th className="px-3 py-2">Value / threshold</th>
          <th className="px-3 py-2">Severity</th>
          <th className="px-3 py-2">Fired</th>
          <th className="px-3 py-2">Resolved</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {sorted.map((a) => (
          <tr key={a.id} className="border-b border-line last:border-0">
            <td className="px-3 py-2 text-xs">{a.state === "firing" ? <span className="text-bad">Firing</span> : <span className="text-ok">Resolved</span>}</td>
            <td className="px-3 py-2">
              {a.monitor}
              <div className="text-xs text-muted">{RULE_LABEL[a.rule]}</div>
              {a.message && <div className="text-xs text-soft">{a.message}</div>}
            </td>
            <td className="px-3 py-2 text-xs">{a.resource}</td>
            <td className="px-3 py-2 text-xs">
              {a.value ?? "—"} / {a.threshold}
            </td>
            <td className="px-3 py-2">
              <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_CLASS[a.severity]}`}>{a.severity}</span>
            </td>
            <td className="px-3 py-2 text-xs">{when(a.fired_at)}</td>
            <td className="px-3 py-2 text-xs">
              {a.resolved_at ? when(a.resolved_at) : "—"}
              {a.resolved_by === "hand" && <span className="text-muted"> · by hand</span>}
            </td>
            <td className="px-3 py-2 text-right">
              {a.state === "firing" && (
                <button type="button" onClick={() => streaming.resolveAlert(a.id).then(onChange, (e: Error) => alertDialog(e.message))} className="text-xs text-ocean hover:underline">
                  Resolve
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
