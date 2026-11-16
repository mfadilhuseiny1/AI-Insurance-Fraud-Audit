"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, Modal } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import type { Automation } from "@/lib/ontology";
import { tsOntology, type AlertJob, type AlertJobConfig } from "@/lib/timeseries";

/** Time series evaluation status of an alerting automation: its job, alerts and recent evaluations. */
export function TsEvaluationStatus({ a, onChanged }: { a: Automation; onChanged: () => void }) {
  const ts = a.time_series;
  const [config, setConfig] = useState(false);
  if (!ts || a.condition.kind !== "time_series") return null;
  const status = ts.job.status ?? "never run";
  return (
    <Card
      title="Time series evaluation status"
      action={
        <button type="button" className={buttonClass.ghost} onClick={() => setConfig(true)}>
          <Icon name="sliders" className="h-3.5 w-3.5" /> View configuration
        </button>
      }
    >
      <div className="space-y-3 p-4 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Job" value={<Badge status={status === "warning" ? "experimental" : status} label={status} />} />
          <Stat label="Alerting" value={`${ts.mode} · version ${ts.version}`} />
          <Stat label="Open alerts" value={ts.alerts_open.toLocaleString()} />
          <Stat label="Alerts" value={<Link href={`/ontology/${a.condition.alert_object_type_id}?tab=objects`} className="text-ocean hover:underline">{ts.alerts_total.toLocaleString()}</Link>} />
        </div>
        <div className="text-xs text-muted">Last evaluation {ts.job.last_run_at ? when(ts.job.last_run_at) : "never"}</div>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Evaluation history</div>
          <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {ts.evaluations.length === 0 && <p className="p-3 text-xs text-muted">No evaluations yet.</p>}
            {ts.evaluations.map((e, i) => (
              <div key={i} className="px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <Badge status={e.status === "warning" ? "experimental" : e.status} label={e.status} />
                  <span className="text-soft">{e.trigger.replace("_", " ")}</span>
                  <span className="ml-auto text-muted">{when(e.at)}</span>
                </div>
                <div className="mt-0.5 text-muted">
                  {e.objects ?? 0} objects · {e.alerts_created ?? 0} new · {e.alerts_closed ?? 0} closed · {(e.points_scanned ?? 0).toLocaleString()} points
                </div>
                {e.errors?.slice(0, 3).map((x, j) => (
                  <div key={j} className="text-bad">
                    {x.primary_key ? `${x.primary_key}: ` : ""}
                    {x.error}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      {config && <JobConfigDialog alertTypeId={a.condition.alert_object_type_id} onClose={() => (setConfig(false), onChanged())} />}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 px-2.5 py-1.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 capitalize">{value}</div>
    </div>
  );
}

/** Job-level configuration: applies to every automation writing to the alert object type. */
export function JobConfigDialog({ alertTypeId, onClose }: { alertTypeId: string; onClose: () => void }) {
  const [job, setJob] = useState<AlertJob | null>(null);
  const [cfg, setCfg] = useState<AlertJobConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    tsOntology.alertJob(alertTypeId).then((j) => (setJob(j), setCfg(j.config)), (e: Error) => setError(e.message));
  }, [alertTypeId]);
  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      await tsOntology.saveAlertJob(alertTypeId, cfg);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      await tsOntology.runAlertJob(alertTypeId);
      setJob(await tsOntology.alertJob(alertTypeId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const b = cfg?.batch;
  const st = cfg?.streaming;
  const setB = (patch: Partial<AlertJobConfig["batch"]>) => cfg && setCfg({ ...cfg, batch: { ...cfg.batch, ...patch } });
  const setS = (patch: Partial<AlertJobConfig["streaming"]>) => cfg && setCfg({ ...cfg, streaming: { ...cfg.streaming, ...patch } });
  return (
    <Modal title="Job configuration" icon="sliders" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        {job && (
          <p className="text-xs text-muted">
            The {job.mode} evaluation job of <span className="text-soft">{job.alert_object_type}</span> runs {job.automations.length} automation
            {job.automations.length === 1 ? "" : "s"} ({job.automations.map((x) => x.name).join(", ")}); these settings apply to all of them. Inputs: {job.input_syncs.join(", ") || "—"}.
          </p>
        )}
        <ErrorBox message={error} />
        {job?.mode === "batch" && b && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Spark profiles" hint="Comma separated">
              <input value={b.spark_profiles.join(", ")} onChange={(e) => setB({ spark_profiles: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={`${fieldClass} w-full`} />
            </Field>
            <Field label="Default lookback window" hint="How far back each incremental run searches: the longest window in the logic">
              <input value={b.default_lookback} onChange={(e) => setB({ default_lookback: e.target.value })} className={`${fieldClass} w-full font-mono`} />
            </Field>
            <Field label="First job run read limit (days)" hint="Empty: the first run checks the entire series">
              <input type="number" min={1} value={b.first_run_read_limit ?? ""} onChange={(e) => setB({ first_run_read_limit: e.target.value ? Number(e.target.value) : null })} className={`${fieldClass} w-full`} />
            </Field>
            <Field label="Job timeout (hours)">
              <input type="number" min={0.1} step={0.1} value={b.timeout_hours} onChange={(e) => setB({ timeout_hours: Number(e.target.value) || 1 })} className={`${fieldClass} w-full`} />
            </Field>
            <Field label="Schedule">
              <select value={b.schedule.kind} onChange={(e) => setB({ schedule: { ...b.schedule, kind: e.target.value as "on_data" | "every" } })} className={`${fieldClass} w-full`}>
                <option value="on_data">When the input syncs get new data</option>
                <option value="every">On a time-based schedule</option>
              </select>
            </Field>
            {b.schedule.kind === "every" && (
              <Field label="Every (minutes)">
                <input type="number" min={1} value={b.schedule.minutes} onChange={(e) => setB({ schedule: { ...b.schedule, minutes: Number(e.target.value) || 60 } })} className={`${fieldClass} w-full`} />
              </Field>
            )}
            <label className="col-span-2 flex items-center gap-2 text-sm text-soft">
              <input type="checkbox" checked={b.fail_on_any} onChange={(e) => setB({ fail_on_any: e.target.checked })} /> Fail job on any failure (we recommend leaving this off so the job keeps making progress)
            </label>
          </div>
        )}
        {job?.mode === "streaming" && st && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Streaming profiles" hint="Comma separated">
              <input value={st.profiles.join(", ")} onChange={(e) => setS({ profiles: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={`${fieldClass} w-full`} />
            </Field>
            <Field label="Allowed lateness override (seconds)" hint="Points are buffered this long before evaluation; the minimum alert latency">
              <input type="number" min={0} value={st.allowed_lateness_s} onChange={(e) => setS({ allowed_lateness_s: Number(e.target.value) || 0 })} className={`${fieldClass} w-full`} />
            </Field>
            <Field label="Nexus polling interval override (seconds)">
              <input type="number" min={5} value={st.polling_interval_s} onChange={(e) => setS({ polling_interval_s: Number(e.target.value) || 60 })} className={`${fieldClass} w-full`} />
            </Field>
            <Field label="Evaluate every (seconds)">
              <input type="number" min={5} value={st.every_s} onChange={(e) => setS({ every_s: Number(e.target.value) || 10 })} className={`${fieldClass} w-full`} />
            </Field>
            <Field label="Default lookback window">
              <input value={st.default_lookback} onChange={(e) => setS({ default_lookback: e.target.value })} className={`${fieldClass} w-full font-mono`} />
            </Field>
            <Field label="Excluded time series syncs" hint="Sync ids, comma separated; changing them restarts the job">
              <input value={st.excluded_syncs.join(", ")} onChange={(e) => setS({ excluded_syncs: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={`${fieldClass} w-full font-mono`} />
            </Field>
            <label className="col-span-2 flex items-center gap-2 text-sm text-soft">
              <input type="checkbox" checked={st.fail_on_any} onChange={(e) => setS({ fail_on_any: e.target.checked })} /> Fail job on any failure
            </label>
          </div>
        )}
        {job && (
          <div>
            <div className="mb-1 text-xs font-medium text-soft">Recent job runs</div>
            <div className="max-h-40 divide-y divide-line overflow-y-auto rounded-md border border-line text-xs">
              {job.runs.slice(0, 20).map((r, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1">
                  <Badge status={r.status === "warning" ? "experimental" : r.status} label={r.status} />
                  <span className="text-soft">{r.trigger}</span>
                  <span className="text-muted">{r.ms} ms</span>
                  {r.error && <span className="truncate text-bad">{r.error}</span>}
                  <span className="ml-auto text-muted">{when(r.at)}</span>
                </div>
              ))}
              {!job.runs.length && <p className="p-3 text-muted">No runs yet.</p>}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={runNow} disabled={busy} className={buttonClass.secondary}>
            <Icon name="play" className="h-3.5 w-3.5" /> Run job now
          </button>
          <button type="button" onClick={save} disabled={busy || !cfg} className={buttonClass.primary}>
            Save configuration
          </button>
        </div>
      </div>
    </Modal>
  );
}
