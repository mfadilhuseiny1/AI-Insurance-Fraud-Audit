"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import {
  describeTrigger,
  SCHEDULE_TARGETS,
  scheduleTrigger,
  triggerLeaves,
  uid,
  type Output,
  type Pipeline,
  type Schedule,
  type ScheduleTarget,
  type ScheduleTrigger,
} from "@/lib/pipeline";
import { runtime, type BuildRecord, type ScheduleRun, type ScheduleSummary, type ScheduleVersion } from "@/lib/runtime";
import { Icon } from "../Icon";
import { StatusBadge } from "./Builds";
import { TimezoneField } from "./CastFields";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field, Panel, Switch, Tabs } from "./ui";

/**
 * Schedules (Palantir's "Scheduling"): a trigger tree of AND / OR conditions over time, data, logic, job and
 * schedule events; which outputs to build; retries, auto-pause, up-to-date skipping and parameterized run
 * setups. The API evaluates them (api/pipeline_schedules.py) and keeps their run and edit history.
 */

const PRESETS: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 06:00", cron: "0 6 * * *" },
  { label: "Weekdays at 08:30", cron: "30 8 * * 1-5" },
  { label: "Every Monday at 07:00", cron: "0 7 * * 1" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "First of the month at 00:00", cron: "0 0 1 * *" },
];
export const TARGET_LABEL: Record<ScheduleTarget, string> = {
  single: "The selected outputs only",
  withUpstream: "The selected outputs and all their dependencies",
  downstream: "All outputs that depend on the selected outputs",
  between: "All outputs that connect the selected outputs",
};
const LEAF_LABEL: Record<Exclude<ScheduleTrigger["kind"], "and" | "or">, { label: string; hint: string }> = {
  time: { label: "At certain times", hint: "A cron expression in a time zone." },
  data: { label: "When data has been updated", hint: "An input dataset, data source, media set or stream changed." },
  logic: { label: "When logic has been updated", hint: "The pipeline's transforms or outputs changed (and stayed unchanged for 2 minutes)." },
  job: { label: "When a job succeeded", hint: "A build of a pipeline succeeded — optionally one that built a given output." },
  schedule: { label: "When a schedule ran", hint: "Another schedule's builds finished." },
};

const newLeaf = (kind: Exclude<ScheduleTrigger["kind"], "and" | "or">): ScheduleTrigger => {
  const id = uid();
  switch (kind) {
    case "time":
      return { id, kind, cron: "0 6 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    case "data":
    case "logic":
      return { id, kind };
    case "job":
      return { id, kind, pipelineId: "" };
    case "schedule":
      return { id, kind, pipelineId: "", scheduleId: "", status: "succeeded" };
  }
};

/** Pipelines (with their outputs) and schedules the job / schedule triggers can point at, loaded once. */
function useTargets() {
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [outputs, setOutputs] = useState<Record<string, Output[]>>({});
  useEffect(() => {
    let live = true;
    api.pipelineData.files().then((f) => live && setPipelines(f.map((i) => ({ id: i.id, name: i.name.replace(/\.pipeline$/i, "") }))), () => {});
    runtime.schedules().then((s) => live && setSchedules(s), () => {});
    return () => {
      live = false;
    };
  }, []);
  const loadOutputs = useCallback(
    (pipelineId: string) => {
      if (!pipelineId || outputs[pipelineId]) return;
      api.pipelineData.readFile(pipelineId).then(
        (f) => setOutputs((o) => ({ ...o, [pipelineId]: ((f.content as { outputs?: Output[] }).outputs ?? []) as Output[] })),
        () => setOutputs((o) => ({ ...o, [pipelineId]: [] })),
      );
    },
    [outputs],
  );
  return { pipelines, schedules, outputs, loadOutputs };
}
type Targets = ReturnType<typeof useTargets>;

function CronLeaf({ t, onChange }: { t: Extract<ScheduleTrigger, { kind: "time" }>; onChange: (t: ScheduleTrigger) => void }) {
  const [next, setNext] = useState<string[] | string>([]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        runtime.nextRuns(t.cron, t.timezone || "UTC").then(
          (r) => live && setNext(r.next),
          (e: Error) => live && setNext(e.message),
        ),
      300,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [t.cron, t.timezone]);
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button key={p.cron} type="button" onClick={() => onChange({ ...t, cron: p.cron })} className={`rounded px-1.5 py-0.5 ring-1 ${t.cron === p.cron ? "bg-ocean/15 text-white ring-ocean/50" : "text-muted ring-line-2"}`}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input value={t.cron} onChange={(e) => onChange({ ...t, cron: e.target.value })} className={`${inputClass} w-48 font-mono text-xs`} aria-label="Cron expression" />
        <span className="w-56">
          <TimezoneField value={t.timezone ?? ""} onChange={(timezone) => onChange({ ...t, timezone })} />
        </span>
      </div>
      <p className="text-muted">
        minute hour day-of-month month day-of-week · next: {typeof next === "string" ? <span className="text-bad">{next}</span> : next.slice(0, 3).map((n) => new Date(n).toLocaleString()).join(" · ")}
      </p>
    </div>
  );
}

function LeafEditor({ t, pipeline, targets, onChange }: { t: ScheduleTrigger; pipeline: Pipeline; targets: Targets; onChange: (t: ScheduleTrigger) => void }) {
  const { loadOutputs } = targets;
  const jobPipeline = t.kind === "job" ? t.pipelineId : "";
  useEffect(() => {
    if (jobPipeline) loadOutputs(jobPipeline);
  }, [jobPipeline, loadOutputs]);
  if (t.kind === "time") return <CronLeaf t={t} onChange={onChange} />;
  if (t.kind === "data")
    return (
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {Object.values(pipeline.datasets).map((d) => {
          const on = t.inputs?.includes(d.id) ?? false;
          return (
            <label key={d.id} className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 ring-1 ${on ? "bg-ocean/15 text-white ring-ocean/50" : "text-muted ring-line-2"}`}>
              <input type="checkbox" className="hidden" checked={on} onChange={(e) => onChange({ ...t, inputs: e.target.checked ? [...(t.inputs ?? []), d.id] : (t.inputs ?? []).filter((x) => x !== d.id) })} />
              {d.name}
            </label>
          );
        })}
        <span className="self-center text-muted">{t.inputs?.length ? "only these inputs" : "any input (or choose some)"}</span>
      </div>
    );
  if (t.kind === "job")
    return (
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <select value={t.pipelineId} onChange={(e) => onChange({ ...t, pipelineId: e.target.value, pipelineName: targets.pipelines.find((p) => p.id === e.target.value)?.name, outputId: undefined, outputName: undefined })} className={`${inputClass} py-1 text-xs`}>
          <option value="">Choose a pipeline…</option>
          {targets.pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === pipeline.id ? " (this pipeline)" : ""}
            </option>
          ))}
        </select>
        <select
          value={t.outputId ?? ""}
          disabled={!t.pipelineId}
          onChange={(e) => onChange({ ...t, outputId: e.target.value || undefined, outputName: targets.outputs[t.pipelineId]?.find((o) => o.id === e.target.value)?.name })}
          className={`${inputClass} py-1 text-xs`}
        >
          <option value="">Any output</option>
          {(targets.outputs[t.pipelineId] ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
    );
  if (t.kind === "schedule")
    return (
      <div className="mt-1.5 grid grid-cols-[1fr_12rem] gap-2">
        <select
          value={t.scheduleId ? `${t.pipelineId}/${t.scheduleId}` : ""}
          onChange={(e) => {
            const s = targets.schedules.find((x) => `${x.pipeline_id}/${x.schedule.id}` === e.target.value);
            onChange({ ...t, pipelineId: s?.pipeline_id ?? "", scheduleId: s?.schedule.id ?? "", scheduleName: s ? `${s.pipeline_name} · ${s.schedule.name}` : undefined });
          }}
          className={`${inputClass} py-1 text-xs`}
        >
          <option value="">Choose a schedule…</option>
          {targets.schedules.map((s) => (
            <option key={`${s.pipeline_id}/${s.schedule.id}`} value={`${s.pipeline_id}/${s.schedule.id}`}>
              {s.pipeline_name} · {s.schedule.name}
            </option>
          ))}
        </select>
        <select value={t.status ?? "succeeded"} onChange={(e) => onChange({ ...t, status: e.target.value as "succeeded" | "any" })} className={`${inputClass} py-1 text-xs`}>
          <option value="succeeded">and succeeded</option>
          <option value="any">with any result</option>
        </select>
      </div>
    );
  return null;
}

function TriggerEditor({ t, pipeline, targets, onChange, onRemove, depth = 0 }: { t: ScheduleTrigger; pipeline: Pipeline; targets: Targets; onChange: (t: ScheduleTrigger) => void; onRemove?: () => void; depth?: number }) {
  const [adding, setAdding] = useState(false);
  if (t.kind !== "and" && t.kind !== "or")
    return (
      <div className="rounded-md border border-line-2 bg-panel-2 p-2 text-xs">
        <div className="flex items-start gap-2">
          <span className="flex-1">
            <span className="block text-soft">{LEAF_LABEL[t.kind].label}</span>
            <span className="block text-muted">{LEAF_LABEL[t.kind].hint}</span>
          </span>
          {onRemove && (
            <button type="button" onClick={onRemove} title="Remove condition" className="rounded p-0.5 text-muted hover:text-bad">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <LeafEditor t={t} pipeline={pipeline} targets={targets} onChange={onChange} />
      </div>
    );
  const set = (items: ScheduleTrigger[]) => onChange({ ...t, items });
  return (
    <div className={`space-y-1.5 rounded-md border p-2 text-xs ${depth ? "border-ocean/30" : "border-line-2"}`}>
      <div className="flex items-center gap-2">
        <span className="text-muted">Run when</span>
        <select value={t.kind} onChange={(e) => onChange({ ...t, kind: e.target.value as "and" | "or" })} className={`${inputClass} w-56 py-1 text-xs`}>
          <option value="or">any of these hold (OR)</option>
          <option value="and">all of these hold (AND)</option>
        </select>
        {onRemove && (
          <button type="button" onClick={onRemove} title="Remove group" className="ml-auto rounded p-0.5 text-muted hover:text-bad">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {t.kind === "and" && t.items.length > 1 && <p className="text-muted">Each condition counts once it happened since the last run; the schedule runs when all of them have.</p>}
      {t.items.map((it, i) => (
        <TriggerEditor key={it.id} t={it} pipeline={pipeline} targets={targets} depth={depth + 1} onChange={(x) => set(t.items.map((y, j) => (j === i ? x : y)))} onRemove={() => set(t.items.filter((_, j) => j !== i))} />
      ))}
      {!t.items.length && <p className="text-bad">Add at least one condition.</p>}
      <div className="relative">
        <button type="button" onClick={() => setAdding(!adding)} className="inline-flex items-center gap-1 text-ocean hover:underline">
          <Icon name="plus" className="h-3 w-3" /> Add condition
        </button>
        {adding && (
          <div className="absolute z-10 mt-1 w-64 rounded-md border border-line-2 bg-panel p-1 shadow-xl">
            {(Object.keys(LEAF_LABEL) as (keyof typeof LEAF_LABEL)[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  set([...t.items, newLeaf(k)]);
                  setAdding(false);
                }}
                className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2"
              >
                {LEAF_LABEL[k].label}
              </button>
            ))}
            {depth < 2 && (
              <button
                type="button"
                onClick={() => {
                  set([...t.items, { id: uid(), kind: t.kind === "or" ? "and" : "or", items: [] }]);
                  setAdding(false);
                }}
                className="block w-full rounded border-t border-line px-2 py-1 text-left hover:bg-panel-2"
              >
                Group of conditions ({t.kind === "or" ? "AND" : "OR"})
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const triggerValid = (t: ScheduleTrigger): boolean => {
  switch (t.kind) {
    case "and":
    case "or":
      return t.items.length > 0 && t.items.every(triggerValid);
    case "time":
      return t.cron.trim().split(/\s+/).length === 5;
    case "job":
      return !!t.pipelineId;
    case "schedule":
      return !!t.scheduleId;
    default:
      return true;
  }
};

export function ScheduleEditor({ initial, pipeline, onSave, onClose }: { initial: Schedule; pipeline: Pipeline; onSave: (s: Schedule) => void; onClose: () => void }) {
  const [s, setS] = useState<Schedule>(() => ({ ...initial, trigger: scheduleTrigger(initial) }));
  const [tab, setTab] = useState<"trigger" | "build" | "runs">("trigger");
  const targets = useTargets();
  const set = (patch: Partial<Schedule>) => setS({ ...s, ...patch });
  const outputs = pipeline.outputs;
  const params = pipeline.parameters ?? [];
  const trigger = s.trigger!;
  const valid = !!s.name.trim() && triggerValid(trigger);
  return (
    <Modal title={initial.name ? `Schedule — ${initial.name}` : "New schedule"} icon="clock" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input value={s.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} />
          </Field>
          <div className="pt-5">
            <Switch on={s.enabled} onChange={(enabled) => set({ enabled, enabledAt: new Date().toISOString() })} label="Enabled" />
          </div>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "trigger", label: "Trigger" },
            { id: "build", label: "Build", badge: s.excluded?.length || undefined },
            { id: "runs", label: "Runs & parameters", badge: s.runSetups?.length || undefined },
          ]}
        />
        {tab === "trigger" && (
          <>
            <TriggerEditor t={trigger} pipeline={pipeline} targets={targets} onChange={(t) => set({ trigger: t })} />
            <p className="text-xs text-muted">Runs: {describeTrigger(trigger, pipeline.datasets) || "—"}</p>
          </>
        )}
        {tab === "build" && (
          <div className="space-y-3 text-xs">
            <div className="rounded-md border border-line-2 p-3">
              <div className="mb-2 font-medium text-soft">Outputs to build</div>
              <select value={s.target} onChange={(e) => set({ target: e.target.value as ScheduleTarget })} className={`${inputClass} mb-2`}>
                {SCHEDULE_TARGETS.map((t) => (
                  <option key={t} value={t}>
                    {TARGET_LABEL[t]}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-1.5">
                {outputs.map((o) => (
                  <label key={o.id} className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 ring-1 ${s.outputs.includes(o.id) ? "bg-ocean/15 text-white ring-ocean/50" : "text-muted ring-line-2"}`}>
                    <input type="checkbox" className="hidden" checked={s.outputs.includes(o.id)} onChange={(e) => set({ outputs: e.target.checked ? [...s.outputs, o.id] : s.outputs.filter((x) => x !== o.id) })} />
                    {o.name}
                  </label>
                ))}
              </div>
              {!s.outputs.length && <p className="mt-1 text-muted">No output chosen: every output is built.</p>}
            </div>
            <div className="rounded-md border border-line-2 p-3">
              <div className="mb-1 font-medium text-soft">Excluded outputs</div>
              <p className="mb-2 text-muted">Never built by this schedule, even when the target reaches them.</p>
              <div className="flex flex-wrap gap-1.5">
                {outputs.map((o) => {
                  const on = s.excluded?.includes(o.id) ?? false;
                  return (
                    <label key={o.id} className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 ring-1 ${on ? "bg-bad/15 text-white ring-bad/50" : "text-muted ring-line-2"}`}>
                      <input type="checkbox" className="hidden" checked={on} onChange={(e) => set({ excluded: e.target.checked ? [...(s.excluded ?? []), o.id] : (s.excluded ?? []).filter((x) => x !== o.id) })} />
                      {on && <Icon name="minus" className="h-3 w-3" />}
                      {o.name}
                    </label>
                  );
                })}
              </div>
            </div>
            <BuildScope s={s} set={set} />
            <Switch
              on={!!s.force}
              onChange={(force) => set({ force: force || undefined })}
              label="Force build"
              hint="Build every output on each run. Off: outputs with no input or logic change since their last successful build are skipped (and a run where all are up to date is recorded as skipped)."
            />
            <Switch on={!!s.allowOverlap} onChange={(allowOverlap) => set({ allowOverlap })} label="Allow overlapping runs" hint="Start a run even while the previous run of this schedule is still in progress (otherwise the trigger is ignored and recorded in the run history)." />
            <div className="grid grid-cols-3 gap-3">
              <Field label="Retries" hint="Failed builds are built again (not validation failures).">
                <input type="number" min={0} max={10} value={s.retries?.count ?? 0} onChange={(e) => set({ retries: { count: Math.max(0, Math.min(10, Number(e.target.value) || 0)), delayMinutes: s.retries?.delayMinutes ?? 5 } })} className={inputClass} />
              </Field>
              <Field label="Retry delay (minutes)">
                <input type="number" min={0} max={1440} disabled={!s.retries?.count} value={s.retries?.delayMinutes ?? 5} onChange={(e) => set({ retries: { count: s.retries?.count ?? 0, delayMinutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) } })} className={inputClass} />
              </Field>
              <Field label="Auto-pause after" hint="Failed runs in a row (0 = never).">
                <input type="number" min={0} max={100} value={s.autoPauseAfter ?? 0} onChange={(e) => set({ autoPauseAfter: Math.max(0, Math.min(100, Number(e.target.value) || 0)) || undefined })} className={inputClass} />
              </Field>
            </div>
          </div>
        )}
        {tab === "runs" && (
          <div className="space-y-3 text-xs">
            {!params.length && <p className="text-muted">The pipeline has no parameters. Add them in the pipeline (Parameters) to run this schedule with other values or in parallel setups.</p>}
            {params.length > 0 && (
              <>
                <div className="rounded-md border border-line-2 p-3">
                  <div className="mb-2 font-medium text-soft">Parameter values</div>
                  <div className="grid grid-cols-2 gap-2">
                    {params.map((p) => (
                      <Field key={p.id} label={`${p.name} (${p.type})`}>
                        <input value={s.parameters?.[p.name] ?? ""} placeholder={`default: ${p.value}`} onChange={(e) => set({ parameters: { ...(s.parameters ?? {}), [p.name]: e.target.value } })} className={`${inputClass} py-1 text-xs`} />
                      </Field>
                    ))}
                  </div>
                </div>
                <div className="rounded-md border border-line-2 p-3">
                  <div className="mb-1 font-medium text-soft">Parallel run setups</div>
                  <p className="mb-2 text-muted">Each run builds once per setup, side by side, with the setup&apos;s values over the ones above. A setup writes its own outputs (&quot;name [setup]&quot;) and keeps its own incremental state.</p>
                  {(s.runSetups ?? []).map((r, i) => (
                    <div key={r.id} className="mb-1.5 flex flex-wrap items-center gap-2 rounded bg-panel-2 p-2">
                      <input value={r.name} onChange={(e) => set({ runSetups: (s.runSetups ?? []).map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className={`${inputClass} w-36 py-1 text-xs`} aria-label="Setup name" />
                      {params.map((p) => (
                        <input
                          key={p.id}
                          value={r.parameters[p.name] ?? ""}
                          placeholder={p.name}
                          title={p.name}
                          onChange={(e) => set({ runSetups: (s.runSetups ?? []).map((x, j) => (j === i ? { ...x, parameters: { ...x.parameters, [p.name]: e.target.value } } : x)) })}
                          className={`${inputClass} w-28 py-1 text-xs`}
                        />
                      ))}
                      <button type="button" onClick={() => set({ runSetups: (s.runSetups ?? []).filter((_, j) => j !== i) })} className="ml-auto rounded p-1 text-muted hover:text-bad">
                        <Icon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={() => set({ runSetups: [...(s.runSetups ?? []), { id: uid(), name: `Setup ${(s.runSetups ?? []).length + 1}`, parameters: {} }] })} className={buttonClass.secondary}>
                    <Icon name="plus" className="h-3.5 w-3.5" /> Add run setup
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => {
              // saved as a trigger tree; the flat fields of older schedules are dropped
              const { cron: _c, timezone: _t, onDataUpdate: _d, onLogicUpdate: _l, combine: _m, ...rest } = s;
              void _c;
              void _t;
              void _d;
              void _l;
              void _m;
              onSave({ ...rest, name: s.name.trim(), runSetups: s.runSetups?.filter((r) => r.name.trim()) });
            }}
            className={buttonClass.primary}
          >
            Save schedule
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- run history and versions

const OUTCOME: Record<ScheduleRun["outcome"], { tone: string; label: string }> = {
  started: { tone: "text-ocean", label: "Started" },
  skipped: { tone: "text-muted", label: "Skipped" },
  ignored: { tone: "text-warn", label: "Ignored" },
  failed: { tone: "text-bad", label: "Did not start" },
};

/** Who a schedule runs as: its Projects, or its owner (warned when deactivated). */
export function ScopeLine({ st }: { st: ScheduleSummary }) {
  const o = st.owner;
  const name = o ? o.display_name || o.username : null;
  return (
    <p className="text-muted">
      {st.scope === "project" ? `scope: ${st.scope_projects.map((p) => p.name).join(", ") || "top level"}` : "scope: user account"}
      {name && (
        <>
          {" · owner "}
          <span className={o!.status === "active" ? "text-soft" : "text-bad"} title={o!.status === "active" ? undefined : `The owner is ${o!.status}`}>
            {name}
            {o!.status !== "active" ? ` (${o!.status})` : ""}
          </span>
        </>
      )}
    </p>
  );
}

/** Build scope (doc "Create a schedule" → Build scope): Projects, or the account of the schedule's owner. */
function BuildScope({ s, set }: { s: Schedule; set: (patch: Partial<Schedule>) => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.drive.folder(null).then(
      (f) => alive && setProjects(f.items.filter((i) => i.kind === "project").map((i) => ({ id: i.id, name: i.name }))),
      () => alive && setProjects([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  const scope = s.scope ?? "project";
  const chosen = s.scopeProjects ?? [];
  return (
    <div className="rounded-md border border-line-2 p-3">
      <div className="mb-1 font-medium text-soft">Build scope</div>
      <div className="mb-2 flex gap-4">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="radio" checked={scope === "project"} onChange={() => set({ scope: "project" })} className="accent-[var(--color-ocean)]" /> Projects
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="radio" checked={scope === "user"} onChange={() => set({ scope: "user" })} className="accent-[var(--color-ocean)]" /> User account
        </label>
      </div>
      {scope === "project" ? (
        <>
          <p className="mb-2 text-muted">
            Builds only outputs written inside these Projects, unaffected by changing user permissions. None chosen: the pipeline&apos;s own Project. Saving needs the Editor
            role on each.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(projects ?? []).map((p) => {
              const on = chosen.includes(p.id);
              return (
                <label key={p.id} className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 ring-1 ${on ? "bg-ocean/15 text-white ring-ocean/50" : "text-muted ring-line-2"}`}>
                  <input type="checkbox" className="hidden" checked={on} onChange={(e) => set({ scopeProjects: e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id) })} />
                  <Icon name="folder" className="h-3 w-3" />
                  {p.name}
                </label>
              );
            })}
            {projects?.length === 0 && <span className="text-muted">No Projects you can see.</span>}
          </div>
        </>
      ) : (
        <p className="text-muted">
          Builds run as the schedule&apos;s owner — the last user to change it (saving makes you the owner) — and include only outputs they may build. A run does not start if the
          owner is deactivated or loses access to the pipeline; another Editor then saves the schedule to take it over.
        </p>
      )}
    </div>
  );
}

export function RunOutcome({ run }: { run: ScheduleRun }) {
  if (run.outcome === "started" && run.status) return <StatusBadge status={run.status} />;
  return <span className={`text-xs ${OUTCOME[run.outcome].tone}`}>{OUTCOME[run.outcome].label}</span>;
}

/** Run history (with skipped and ignored runs and why) and edit history of one schedule. */
export function ScheduleHistoryDialog({ pipelineId, schedule, onClose }: { pipelineId: string; schedule: Schedule; onClose: () => void }) {
  const [tab, setTab] = useState<"runs" | "versions">("runs");
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [versions, setVersions] = useState<ScheduleVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | ScheduleRun["outcome"]>("all");
  useEffect(() => {
    let live = true;
    Promise.all([runtime.scheduleRuns(pipelineId, schedule.id), runtime.scheduleVersions(pipelineId, schedule.id)]).then(
      ([r, v]) => {
        if (!live) return;
        setRuns(r);
        setVersions(v);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [pipelineId, schedule.id]);
  const shown = (runs ?? []).filter((r) => filter === "all" || r.outcome === filter);
  return (
    <Modal title={`History — ${schedule.name}`} icon="history" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-xs">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "runs", label: "Run history", badge: runs?.length },
            { id: "versions", label: "Versions", badge: versions?.length },
          ]}
        />
        {error && <p className="text-bad">{error}</p>}
        {tab === "runs" && (
          <>
            <div className="flex gap-1">
              {(["all", "started", "skipped", "ignored"] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded px-2 py-0.5 capitalize ${filter === f ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"}`}>
                  {f}
                </button>
              ))}
            </div>
            <ul className="max-h-[55vh] space-y-1.5 overflow-y-auto">
              {runs === null && !error && <li className="text-muted">Loading…</li>}
              {runs !== null && !shown.length && <li className="py-4 text-center text-muted">No runs.</li>}
              {shown.map((r) => (
                <li key={r.id} className="rounded-md border border-line bg-panel-2 p-2">
                  <div className="flex items-center gap-2">
                    <RunOutcome run={r} />
                    <span className="text-soft">{r.trigger || "—"}</span>
                    <span className="ml-auto text-muted">{when(r.at)}</span>
                  </div>
                  {r.reason && <p className="mt-0.5 text-muted">{r.reason}</p>}
                  {r.warnings.map((w) => (
                    <p key={w} className="mt-0.5 flex items-center gap-1 text-warn">
                      <Icon name="alert" className="h-3 w-3" /> {w}
                    </p>
                  ))}
                  {(r.build_status ?? []).map((b) => (
                    <Link key={b.id} href={`/pipeline/${r.pipeline_id}/builds/${b.id}`} className="mt-0.5 flex items-center gap-2 text-ocean hover:underline">
                      <StatusBadge status={b.status} spin={false} /> build {b.id.slice(6)}
                      {b.run_setup && <span className="text-muted">· {b.run_setup.name}</span>}
                      {b.trigger?.startsWith("retry") && <span className="text-muted">· {b.trigger.split(" · ")[0]}</span>}
                    </Link>
                  ))}
                  {r.skipped_outputs.length > 0 && (
                    <p className="mt-0.5 text-muted">
                      Not built: {r.skipped_outputs.map((o) => `${o.name}${o.setup ? ` [${o.setup}]` : ""}`).join(", ")} — {r.skipped_outputs[0].reason}
                    </p>
                  )}
                  {!!r.excluded_outputs?.length && <p className="mt-0.5 text-muted">Excluded: {r.excluded_outputs.map((o) => o.name).join(", ")}</p>}
                  {!!r.out_of_scope?.length && (
                    <p className="mt-0.5 text-warn">Outside the build scope: {r.out_of_scope.map((o) => `${o.name} (${o.reason})`).join("; ")}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === "versions" && (
          <ul className="max-h-[55vh] space-y-1.5 overflow-y-auto">
            {versions?.length === 0 && <li className="py-4 text-center text-muted">No versions recorded yet: the API records each saved change within a minute.</li>}
            {versions?.map((v, i) => (
              <li key={v.at + i} className="rounded-md border border-line bg-panel-2 p-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-soft">{i === 0 ? "Current" : `Version ${versions.length - i}`}</span>
                  <span className="text-muted">{v.schedule.enabled ? "enabled" : "disabled"}</span>
                  <span className="ml-auto text-muted">{when(v.at)}</span>
                </div>
                <p className="mt-0.5 text-soft">{v.trigger || "no trigger"}</p>
                <p className="text-muted">{i === versions.length - 1 ? "Created" : v.changed.length ? `Changed: ${v.changed.join(", ")}` : "No change"}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the Schedules panel of the pipeline editor

export function SchedulesPanel({ pipeline, builds, change, onClose }: { pipeline: Pipeline; builds: BuildRecord[] | null; change: (fn: (p: Pipeline) => Pipeline) => void; onClose: () => void }) {
  const [edit, setEdit] = useState<Schedule | null>(null);
  const [history, setHistory] = useState<Schedule | null>(null);
  const [state, setState] = useState<Record<string, ScheduleSummary>>({});
  const [message, setMessage] = useState<{ id: string; text: string; tone: string } | null>(null);
  const [tick, setTick] = useState(0);
  const schedules = useMemo(() => pipeline.schedules ?? [], [pipeline.schedules]);
  const save = (s: Schedule) => change((p) => ({ ...p, schedules: (p.schedules ?? []).some((x) => x.id === s.id) ? (p.schedules ?? []).map((x) => (x.id === s.id ? s : x)) : [...(p.schedules ?? []), s] }));
  useEffect(() => {
    let live = true;
    runtime.schedules(pipeline.id).then((list) => live && setState(Object.fromEntries(list.map((x) => [x.schedule.id, x]))), () => {});
    return () => {
      live = false;
    };
  }, [pipeline.id, tick, builds]);
  const lastRun = useMemo(() => {
    const m = new Map<string, BuildRecord>();
    for (const b of builds ?? []) if (b.schedule_id && !m.has(b.schedule_id)) m.set(b.schedule_id, b);
    return m;
  }, [builds]);
  const runNow = async (s: Schedule) => {
    setMessage({ id: s.id, text: "Starting…", tone: "text-muted" });
    try {
      const r = await runtime.runSchedule(pipeline.id, s.id);
      setMessage({ id: s.id, text: r.outcome === "started" ? `Started ${r.builds.length} build${r.builds.length === 1 ? "" : "s"}` : `${OUTCOME[r.outcome].label}: ${r.reason}`, tone: r.outcome === "started" ? "text-ok" : "text-warn" });
      setTick((t) => t + 1);
    } catch (e) {
      setMessage({ id: s.id, text: (e as Error).message, tone: "text-bad" });
    }
  };
  return (
    <Panel
      title="Schedules"
      icon="clock"
      onClose={onClose}
      width="w-[24rem]"
      actions={
        <button
          type="button"
          onClick={() =>
            setEdit({
              id: uid(),
              name: "Daily build",
              enabled: true,
              trigger: { id: uid(), kind: "or", items: [{ id: uid(), kind: "time", cron: "0 6 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }] },
              target: "single",
              outputs: [],
              createdAt: new Date().toISOString(),
            })
          }
          className={`${buttonClass.primary} px-2 py-1 text-xs`}
        >
          <Icon name="plus" className="h-3 w-3" /> New
        </button>
      }
    >
      <p className="border-b border-line px-3 py-2 text-[11px] text-muted">
        Schedules build outputs on a recurring basis — at times, when data or logic is updated, when a job succeeded or another schedule ran, in AND / OR combinations. They run on the server, with the browser closed.{" "}
        <Link href="/schedules" className="text-ocean hover:underline">
          All schedules
        </Link>
      </p>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {!schedules.length && <li className="py-6 text-center text-xs text-muted">No schedules yet.</li>}
        {schedules.map((s) => {
          const b = lastRun.get(s.id);
          const st = state[s.id];
          return (
            <li key={s.id} className="rounded-md border border-line bg-panel-2 p-2.5 text-xs">
              <div className="flex items-center gap-2">
                <Icon name="clock" className={`h-3.5 w-3.5 ${s.enabled && !st?.paused ? "text-ocean" : "text-muted"}`} />
                <span className="min-w-0 flex-1 truncate font-medium text-white">{s.name}</span>
                <Switch on={s.enabled} onChange={(enabled) => save({ ...s, enabled, enabledAt: new Date().toISOString() })} />
              </div>
              <p className="mt-1 text-muted">{describeTrigger(scheduleTrigger(s), pipeline.datasets)}</p>
              <p className="text-muted">
                builds {s.outputs.length ? s.outputs.map((id) => pipeline.outputs.find((o) => o.id === id)?.name ?? "?").join(", ") : "every output"}
                {s.outputs.length && s.target !== "single" ? ` · ${TARGET_LABEL[s.target].toLowerCase()}` : ""}
                {s.excluded?.length ? ` · excludes ${s.excluded.map((id) => pipeline.outputs.find((o) => o.id === id)?.name ?? "?").join(", ")}` : ""}
                {s.runSetups?.length ? ` · ${s.runSetups.length} run setups` : ""}
                {s.force ? " · force build" : ""}
              </p>
              {st && <ScopeLine st={st} />}
              {st?.paused && (
                <p className="mt-1 flex items-center gap-1.5 rounded bg-warn/10 px-1.5 py-1 text-warn">
                  <Icon name="pause" className="h-3 w-3" /> Paused: {st.paused.reason}
                  <button type="button" onClick={() => runtime.resumeSchedule(pipeline.id, s.id).then(() => setTick((t) => t + 1))} className="ml-auto text-ocean hover:underline">
                    Resume
                  </button>
                </p>
              )}
              {st?.warnings.map((w) => (
                <p key={w} className="mt-0.5 flex items-center gap-1 text-warn">
                  <Icon name="alert" className="h-3 w-3" /> {w}
                </p>
              ))}
              {st?.next_runs[0] && <p className="text-muted">next {new Date(st.next_runs[0]).toLocaleString()}</p>}
              <div className="mt-1.5 flex items-center gap-2">
                {st?.last_run && st.last_run.outcome !== "started" ? (
                  <span className="truncate" title={st.last_run.reason ?? ""}>
                    <RunOutcome run={st.last_run} /> <span className="text-muted">{when(st.last_run.at)}</span>
                  </span>
                ) : b ? (
                  <>
                    <StatusBadge status={b.status} /> <span className="text-muted">{when(b.created_at)}</span>
                  </>
                ) : (
                  <span className="text-muted">Not run yet</span>
                )}
                <button type="button" onClick={() => runNow(s)} className="ml-auto text-ocean hover:underline">
                  Run now
                </button>
                <button type="button" onClick={() => setHistory(s)} className="text-ocean hover:underline">
                  History
                </button>
                <button type="button" onClick={() => setEdit(s)} className="text-ocean hover:underline">
                  Edit
                </button>
                <button type="button" onClick={async () => (await confirmDialog(`Remove the schedule "${s.name}"?`)) && change((p) => ({ ...p, schedules: (p.schedules ?? []).filter((x) => x.id !== s.id) }))} className="text-muted hover:text-bad">
                  Remove
                </button>
              </div>
              {message?.id === s.id && <p className={`mt-1 ${message.tone}`}>{message.text}</p>}
            </li>
          );
        })}
      </ul>
      {edit && (
        <ScheduleEditor
          initial={edit}
          pipeline={pipeline}
          onSave={(s) => {
            save(s);
            setEdit(null);
          }}
          onClose={() => setEdit(null)}
        />
      )}
      {history && <ScheduleHistoryDialog pipelineId={pipeline.id} schedule={history} onClose={() => setHistory(null)} />}
    </Panel>
  );
}

/** Leaf conditions a schedule waits on that already happened (an AND group's progress). */
export const latchedLabel = (s: Schedule, latched: Record<string, { reason: string }>) =>
  triggerLeaves(scheduleTrigger(s))
    .filter((l) => latched[l.id])
    .map((l) => latched[l.id].reason);
