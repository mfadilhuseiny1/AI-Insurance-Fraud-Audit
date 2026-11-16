"use client";

import { useEffect, useState } from "react";
import { selectOutputs, validate } from "@/lib/deploy";
import { runtime, type BuildRecord } from "@/lib/runtime";
import { incrementalInputs, statefulFingerprint, uid, type BuildSettings, type ComputeProfile, type JobGroup, type Pipeline } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "./Modal";
import { OUTPUT_KIND_LABEL } from "./OutputsPanel";
import { Field, Switch, Tabs } from "./ui";
import { ProfilePicker as StreamingProfilePicker } from "../streaming/ProfilePicker";
import { streaming } from "@/lib/streaming";
import { managedProfile, STREAMING_PROFILES } from "@/lib/compute";

// ---------------------------------------------------------------- compute profiles (Build settings)

type Spec = { id: ComputeProfile; label: string; family: "standard" | "warm" | "native" | "faster"; specs: Record<string, string>; imported?: boolean };
export const PROFILES: Spec[] = [
  { id: "xs", label: "Extra Small", family: "standard", imported: true, specs: { "Driver cores": "1", "Driver memory": "4GB", Executors: "none (local mode)", "Total max cores": "1" } },
  { id: "s", label: "Small", family: "standard", imported: true, specs: { "Driver cores": "1", "Driver memory": "2GB", "Dynamic executors": "1–2", "Executor cores": "1", "Executor memory": "3GB", "Total max cores": "3" } },
  { id: "m", label: "Medium", family: "standard", imported: true, specs: { "Driver cores": "1", "Driver memory": "6GB", "Dynamic executors": "2–16", "Executor cores": "2", "Executor memory": "6GB", "Total max cores": "33" } },
  { id: "l", label: "Large", family: "standard", specs: { "Driver cores": "1", "Driver memory": "13GB", "Dynamic executors": "2–32", "Executor cores": "2", "Executor memory": "6GB", "Total max cores": "65" } },
  { id: "xl", label: "Extra Large", family: "standard", specs: { "Driver cores": "1", "Driver memory": "27GB", "Dynamic executors": "2–128", "Executor cores": "2", "Executor memory": "6GB", "Total max cores": "257" } },
  { id: "warm-xs", label: "Warm Pool Extra Small", family: "warm", imported: true, specs: { "Driver cores": "3", "Driver memory": "13GB", Executors: "none", "Total max cores": "3" } },
  { id: "warm-s", label: "Warm Pool Small", family: "warm", imported: true, specs: { "Driver cores": "3", "Driver memory": "7GB", "Dynamic executors": "1–6", "Executor cores": "1", "Executor memory": "3GB", "Total max cores": "9" } },
  { id: "native-s", label: "Natively Accelerated Small", family: "native", imported: true, specs: { "Driver memory": "2GB", "Dynamic executors": "1–2", "Executor memory": "600MB", "Executor off-heap memory": "2400MB", "Total max cores": "3" } },
  { id: "native-m", label: "Natively Accelerated Medium", family: "native", imported: true, specs: { "Driver memory": "6GB", "Dynamic executors": "2–16", "Executor memory": "1200MB", "Executor off-heap memory": "4800MB", "Total max cores": "33" } },
  { id: "native-l", label: "Natively Accelerated Large", family: "native", specs: { "Driver memory": "13GB", "Dynamic executors": "2–32", "Executor memory": "1200MB", "Executor off-heap memory": "4800MB", "Total max cores": "65" } },
  { id: "native-xl", label: "Natively Accelerated Extra Large", family: "native", specs: { "Driver memory": "27GB", "Dynamic executors": "2–128", "Executor memory": "1200MB", "Executor off-heap memory": "4800MB", "Total max cores": "257" } },
  { id: "native-advanced", label: "Natively Accelerated (advanced)", family: "native", imported: true, specs: { Memory: "you set the on-heap / off-heap split" } },
  { id: "faster-s", label: "Faster Small", family: "faster", specs: { Cores: "1", Memory: "7.5GB" } },
  { id: "faster-m", label: "Faster Medium", family: "faster", specs: { Cores: "2", Memory: "15GB" } },
  { id: "faster-l", label: "Faster Large", family: "faster", specs: { Cores: "4", Memory: "30GB" } },
  { id: "faster-xl", label: "Faster Extra Large", family: "faster", specs: { Cores: "8", Memory: "60GB" } },
  { id: "faster-xxl", label: "Faster Extra Extra Large", family: "faster", specs: { Cores: "16", Memory: "120GB" } },
];
const needsImport = (p: Spec, s: BuildSettings) => p.family !== "faster" && !p.imported && !(s.importedProfiles ?? []).includes(p.id);
export const profileLabel = (id?: string) => PROFILES.find((p) => p.id === id)?.label ?? id ?? "Extra Small";

function ProfilePicker({ value, settings, family, onChange, onImport }: { value?: ComputeProfile; settings: BuildSettings; family: Spec["family"][]; onChange: (p: ComputeProfile) => void; onImport: (p: ComputeProfile) => void }) {
  const [specs, setSpecs] = useState<ComputeProfile | null>(null);
  return (
    <div className="space-y-1">
      {PROFILES.filter((p) => family.includes(p.family)).map((p) => {
        const locked = needsImport(p, settings);
        return (
          <div key={p.id} className={`rounded-md border ${value === p.id ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
              <label className={`flex flex-1 items-center gap-2 ${locked ? "opacity-50" : "cursor-pointer"}`}>
                <input type="radio" disabled={locked} checked={value === p.id} onChange={() => onChange(p.id)} className="accent-[var(--color-ocean)]" />
                <span className="font-medium text-white">{p.label}</span>
                {locked && <span className="text-muted">not imported to this project</span>}
              </label>
              {locked && (
                <button type="button" onClick={() => onImport(p.id)} title="Needs a project editor or owner role and a Resource Management administrator role" className="text-ocean hover:underline">
                  Import compute profiles
                </button>
              )}
              <button type="button" onClick={() => setSpecs(specs === p.id ? null : p.id)} className="flex items-center gap-0.5 text-muted hover:text-white">
                Specifications <Icon name={specs === p.id ? "down" : "right"} className="h-3 w-3" />
              </button>
            </div>
            {specs === p.id && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 border-t border-line-2 px-3 py-1.5 text-[11px]">
                {Object.entries(p.specs).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="text-muted">{k}</dt>
                    <dd className="text-soft">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function BuildSettingsDialog({ pipeline, builds, onSave, onClose }: { pipeline: Pipeline; builds: BuildRecord[]; onSave: (patch: Partial<Pipeline>) => void; onClose: () => void }) {
  const [s, setS] = useState<BuildSettings>(pipeline.buildSettings ?? {});
  const [groups, setGroups] = useState<JobGroup[]>(pipeline.jobGroups ?? []);
  const [assign, setAssign] = useState<Record<string, string | undefined>>(() => Object.fromEntries(pipeline.outputs.map((o) => [o.id, o.jobGroup])));
  const compute = pipeline.compute ?? "standard";
  // the batch engine: the JavaScript engine (rows in memory) or the DuckDB local engine (SQL over the files on disk)
  const engineChoice = pipeline.type === "batch" && (compute === "standard" || compute === "duckdb");
  const [engine, setEngine] = useState<"standard" | "duckdb">(compute === "duckdb" ? "duckdb" : "standard");
  const [tab, setTab] = useState<"compute" | "jobs" | "stream">(pipeline.type === "streaming" ? "stream" : "compute");
  const set = (patch: Partial<BuildSettings>) => setS({ ...s, ...patch });
  const [saveError, setSaveError] = useState<string | null>(null);
  const usesUdf = (pipeline.functions ?? []).length > 0;
  // what the managed strategy will allocate to the next build, from the last five successful ones
  const recent = builds
    .filter((b) => b.status === "succeeded" && !b.streaming && b.jobs.length)
    .slice(0, 5)
    .map((b) => ({ profile: b.jobs[0].profile, seconds: Math.max(...b.jobs.map((j) => (j.started_at && j.finished_at ? (Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000 : 0))) }));
  const managed = managedProfile(s.profile ?? (compute === "faster" ? "faster-s" : "xs"), recent);
  const managedNote = `${recent.length ? `Last ${recent.length} builds: ${recent.map((b) => `${Math.round(b.seconds)}s on ${b.profile}`).join(", ")}. ` : ""}Next build: ${profileLabel(managed.profile)} — ${managed.reason}.`;
  return (
    <Modal title="Build settings" icon="sliders" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ...(pipeline.type !== "streaming" ? [{ id: "compute" as const, label: "Default compute profile" }] : []),
            ...(pipeline.type === "streaming" ? [{ id: "stream" as const, label: "Streaming" }] : []),
            { id: "jobs", label: "Job groups", badge: groups.length },
          ]}
        />
        {tab === "compute" && compute === "external" && (
          <div className="space-y-2 text-xs">
            <p className="text-muted">
              External pipelines push compute down to {pipeline.external?.kind ?? "the source"} ({pipeline.external?.connectionName}); inputs and outputs are its tables.
            </p>
            {(pipeline.external?.kind ?? "").includes("snowflake") ? (
              <Field label="Compute warehouse" hint="If unspecified, the compute warehouse configured on the source is used.">
                <input value={s.warehouse ?? ""} onChange={(e) => set({ externalProfile: "warehouse", warehouse: e.target.value })} className={inputClass} />
              </Field>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={(s.externalProfile ?? "serverless") === "serverless"} onChange={() => set({ externalProfile: "serverless" })} /> Serverless (Databricks Connect, default)
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={s.externalProfile === "classic"} onChange={() => set({ externalProfile: "classic" })} /> Classic compute
                </label>
                {s.externalProfile === "classic" && (
                  <Field label="Cluster ID" hint="If unspecified, derived from the source; required when the source uses a SQL warehouse.">
                    <input value={s.clusterId ?? ""} onChange={(e) => set({ clusterId: e.target.value })} className={inputClass} />
                  </Field>
                )}
              </>
            )}
          </div>
        )}
        {tab === "compute" && compute !== "external" && (
          <div className="grid grid-cols-[1fr_15rem] gap-4">
            <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
              {engineChoice && (
                <Field label="Engine" hint="Where builds run. Either way the editor previews a sample of each input.">
                  <div className="space-y-1.5 text-xs">
                    <label className="flex items-start gap-2">
                      <input type="radio" className="mt-0.5" checked={engine === "standard"} onChange={() => setEngine("standard")} />
                      <span>
                        <span className="font-medium">JavaScript engine</span>
                        <span className="block text-muted">Every transform, LLM and function step. Inputs are read into memory: up to about a million rows.</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="radio" className="mt-0.5" checked={engine === "duckdb"} onChange={() => setEngine("duckdb")} />
                      <span>
                        <span className="font-medium">DuckDB local</span>
                        <span className="block text-muted">
                          Each output compiles to one SQL statement that DuckDB runs over the Files datasets on this machine&apos;s disk: millions of rows,
                          spilled to disk when memory is short. Files dataset inputs, SQL-compatible transforms and snapshot dataset outputs; SQL steps use DuckDB SQL.
                        </span>
                      </span>
                    </label>
                  </div>
                </Field>
              )}
              {compute === "faster" ? (
                <ProfilePicker value={s.profile ?? "faster-s"} settings={s} family={["faster"]} onChange={(profile) => set({ profile })} onImport={() => {}} />
              ) : (
                <>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Standard</div>
                  <ProfilePicker value={s.profile ?? "xs"} settings={s} family={["standard"]} onChange={(profile) => set({ profile, strategy: s.strategy === "warm" ? "standard" : s.strategy })} onImport={(p) => set({ importedProfiles: [...(s.importedProfiles ?? []), p] })} />
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Warm pool</div>
                  <ProfilePicker value={s.profile} settings={s} family={["warm"]} onChange={(profile) => set({ profile, strategy: "warm" })} onImport={() => {}} />
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Native acceleration (Velox)</div>
                  <ProfilePicker value={s.profile} settings={s} family={["native"]} onChange={(profile) => set({ profile })} onImport={(p) => set({ importedProfiles: [...(s.importedProfiles ?? []), p] })} />
                  {s.profile === "native-advanced" && (
                    <Field label={`Off-heap memory: ${s.offHeapPercent ?? 70}%`} hint="Lower it if builds run out of memory where non-accelerated builds do not.">
                      <input type="range" min={10} max={90} value={s.offHeapPercent ?? 70} onChange={(e) => set({ offHeapPercent: Number(e.target.value) })} className="w-full" />
                    </Field>
                  )}
                </>
              )}
            </div>
            <div className="space-y-3 text-xs">
              <Field label="Profile management strategy">
                <select
                  value={compute === "faster" ? "standard" : (s.strategy ?? "standard")}
                  disabled={compute === "faster"}
                  onChange={(e) => set({ strategy: e.target.value as BuildSettings["strategy"] })}
                  className={inputClass}
                >
                  <option value="standard">Standard</option>
                  <option value="warm">Warm pool</option>
                  <option value="managed">Managed profile</option>
                </select>
              </Field>
              <p className="text-muted">
                {s.strategy === "warm"
                  ? "Continuously running machines start jobs immediately (up to 3 jobs share a machine). For small builds — up to ~30 minutes on Extra Small."
                  : s.strategy === "managed"
                    ? "Each build's allocation follows the last five successful builds: five under a minute scale down one step, a build over ten minutes returns to the selected profile; never above it."
                    : "The selected profile with no further optimization; best for production-scale pipelines with predictable volumes."}
              </p>
              {s.strategy === "managed" && <p className="rounded bg-panel-2 p-2 text-soft">{managedNote}</p>}
              {s.strategy === "warm" && (
                <ul className="list-disc space-y-0.5 pl-4 text-warn">
                  {!["xs", "s", "warm-xs", "warm-s"].includes(s.profile ?? "xs") && <li>Warm pools support the Extra Small and Small profiles only.</li>}
                  {usesUdf && <li>Pipelines with user-defined functions cannot run on warm pool profiles.</li>}
                  <li>Build logs may be incomplete on warm pools.</li>
                </ul>
              )}
              {(s.profile ?? "").startsWith("native") && pipeline.nodes.some((n) => n.kind === "llm" || (n.kind === "transform" && n.steps.some((st) => st.kind === "embed" || st.kind === "chunk"))) && (
                <p className="text-warn">LLM, embedding and chunking work cannot run off-heap; with native acceleration they may run out of memory. Use a standard profile.</p>
              )}
              {compute === "standard" && <p className="text-muted">Large and Extra Large must be imported to the project first. Faster and streaming pipelines need no import.</p>}
            </div>
          </div>
        )}
        {tab === "stream" && (
          <div className="space-y-3 text-xs">
            <table className="w-full">
              <thead className="text-left text-muted">
                <tr>
                  <th />
                  <th className="font-medium">Profile</th>
                  <th className="font-medium">Job manager</th>
                  <th className="font-medium">Parallelism</th>
                  <th className="font-medium">Task managers</th>
                </tr>
              </thead>
              <tbody>
                {STREAMING_PROFILES.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="py-1">
                      <input type="radio" checked={(s.streamingProfile ?? "xs") === p.id} onChange={() => set({ streamingProfile: p.id })} />
                    </td>
                    <td>{p.label}</td>
                    <td>
                      {p.jmCpu} vCPU · {p.jmGiB}GB
                    </td>
                    <td>{p.par}</td>
                    <td>
                      {p.tmCpu} vCPU · {p.tmGiB}GB × {p.par + 1}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-end gap-3">
              <Switch on={s.maxDurationMinutes !== null && s.maxDurationMinutes !== undefined} onChange={(on) => set({ maxDurationMinutes: on ? 1440 : null })} label="Set max job duration" hint="The streaming job stops after this long (1 minute to 7 days). On by default (1 day) for branches other than main." />
              {s.maxDurationMinutes !== null && s.maxDurationMinutes !== undefined && (
                <input type="number" min={1} max={10080} value={s.maxDurationMinutes} onChange={(e) => set({ maxDurationMinutes: Math.max(1, Math.min(10080, Number(e.target.value))) })} className={`${inputClass} w-28`} />
              )}
              <span className="pb-2 text-muted">minutes</span>
            </div>
            <Field
              label="Streaming profiles"
              hint="Size the job's consumers and batches. Profiles combine (each setting takes the largest value); restricted profiles must be imported into the Project in Control Panel."
            >
              <StreamingProfilePicker
                value={s.streamingProfiles ?? ["default"]}
                advanced={s.streamingAdvanced ?? {}}
                onChange={(streamingProfiles, streamingAdvanced) => set({ streamingProfiles, streamingAdvanced })}
              />
            </Field>
            <Field label="State expiry" hint="Outputs behind stateful transforms (aggregations, windows, dedupe) keep input records as state for this long, up to the profile's buffered records.">
              <div className="flex items-center gap-2">
                <input type="number" min={1} max={43200} value={s.stateTtlMinutes ?? 1440} onChange={(e) => set({ stateTtlMinutes: Math.max(1, Math.min(43200, Number(e.target.value) || 1440)) })} className={`${inputClass} w-28`} />
                <span className="text-muted">minutes</span>
              </div>
            </Field>
            <Field label="Stream behavior — consistency guarantee" hint="How messages are delivered; shown in the deploy panel.">
              <select value={s.consistency ?? ""} onChange={(e) => set({ consistency: (e.target.value || undefined) as BuildSettings["consistency"] })} className={`${inputClass} w-64`}>
                <option value="">Not configured</option>
                <option value="at-least-once">At least once</option>
                <option value="exactly-once">Exactly once</option>
              </select>
            </Field>
          </div>
        )}
        {tab === "compute" && pipeline.type !== "streaming" && compute !== "external" && (
          <div className="space-y-2 rounded-md border border-line-2 p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Advanced configuration</div>
            <Switch
              on={!!s.requireIncremental}
              onChange={(on) => set({ requireIncremental: on || undefined })}
              label="Require incremental execution"
              hint="Jobs of incremental outputs fail when they cannot run incrementally (an input was recomputed as a SNAPSHOT) instead of running as a snapshot. Needs at least one incremental input."
            />
            <Switch
              on={!!s.commitEmptyTransactions}
              onChange={(on) => set({ commitEmptyTransactions: on || undefined })}
              label="Commit empty transactions"
              hint="An incremental build that produces no rows still commits, so its input rows are not processed again on the next build."
            />
            <Switch
              on={!!s.regularSnapshot?.enabled}
              onChange={(on) => set({ regularSnapshot: on ? { everyBuilds: 50, ...s.regularSnapshot, enabled: true } : undefined })}
              label="Regular snapshots"
              hint="Every so often an incremental build re-processes its inputs in full and replaces the outputs with one SNAPSHOT, so thousands of small APPEND transactions do not slow reads down. The first limit reached triggers it; snapshots cost a full build."
            />
            {s.regularSnapshot?.enabled && (
              <div className="grid grid-cols-3 gap-2 pl-10 text-xs">
                {(
                  [
                    ["everyBuilds", "Every N incremental builds"],
                    ["everyDays", "Every N days"],
                    ["maxAppends", "After N APPEND transactions"],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="block">
                    <span className="mb-0.5 block text-muted">{label}</span>
                    <input
                      type="number"
                      min={1}
                      value={s.regularSnapshot?.[k] ?? ""}
                      placeholder="off"
                      onChange={(e) => set({ regularSnapshot: { ...s.regularSnapshot!, [k]: e.target.value ? Math.max(1, Number(e.target.value)) : undefined } })}
                      className={`${inputClass} py-1`}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "jobs" && (
          <div className="space-y-3 text-xs">
            <p className="text-muted">Job groups control how outputs are split into jobs and the compute profile of each job. Outputs fed by an LLM node with Skip recomputing rows must share a job group.</p>
            {groups.map((g, i) => (
              <div key={g.id} className="rounded-md border border-line-2 p-2">
                <div className="flex items-center gap-2">
                  <input value={g.name} onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${inputClass} w-48 py-1 text-xs`} />
                  <select value={g.profile ?? ""} onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, profile: e.target.value || undefined } : x)))} className={`${inputClass} w-56 py-1 text-xs`}>
                    <option value="">Pipeline default profile</option>
                    {PROFILES.filter((p) => (compute === "faster" ? p.family === "faster" : p.family !== "faster")).map((p) => (
                      <option key={p.id} value={p.id} disabled={needsImport(p, s)}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setGroups(groups.filter((_, j) => j !== i))} className="ml-auto rounded p-1 text-muted hover:text-bad">
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {pipeline.outputs.map((o) => (
                    <label key={o.id} className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 ring-1 ${assign[o.id] === g.id ? "bg-ocean/15 text-white ring-ocean/50" : "text-muted ring-line-2"}`}>
                      <input type="checkbox" checked={assign[o.id] === g.id} onChange={(e) => setAssign({ ...assign, [o.id]: e.target.checked ? g.id : undefined })} className="hidden" />
                      {o.name}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setGroups([...groups, { id: uid(), name: `Job group ${groups.length + 1}` }])} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New job group
            </button>
            <div>
              <div className="mb-1 font-medium text-soft">Single ungrouped jobs</div>
              <ul className="flex flex-wrap gap-1.5">
                {pipeline.outputs.filter((o) => !assign[o.id] || !groups.some((g) => g.id === assign[o.id])).map((o) => (
                  <li key={o.id} className="rounded bg-panel-2 px-1.5 py-0.5 text-soft ring-1 ring-line-2">
                    {o.name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {saveError && <span className="mr-auto text-xs text-bad">{saveError}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              const ids = new Set(groups.map((g) => g.id));
              let settings = s;
              if (pipeline.type === "streaming" && s.streamingProfiles?.length) {
                try {
                  const r = await streaming.resolveProfiles(s.streamingProfiles, s.streamingAdvanced ?? {});
                  settings = { ...s, streamingSettings: r.settings };
                } catch (e) {
                  setSaveError((e as Error).message);
                  return;
                }
              }
              onSave({
                ...(engineChoice && engine !== compute ? { compute: engine } : {}),
                buildSettings: settings,
                jobGroups: groups,
                outputs: pipeline.outputs.map((o) => ({ ...o, jobGroup: assign[o.id] && ids.has(assign[o.id]!) ? assign[o.id] : undefined })),
              });
              onClose();
            }}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- deploy

export function DeployDialog({
  pipeline,
  branch,
  initial,
  onDeploy,
  onClose,
}: {
  pipeline: Pipeline;
  branch: string;
  /** outputs preselected (all when empty) */
  initial: string[];
  onDeploy: (outputs: string[], opts?: { replay?: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(initial.length ? initial : pipeline.outputs.map((o) => o.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [replay, setReplay] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // what the last deploy of each output recorded, to detect breaking changes
  const [deployed, setDeployed] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let live = true;
    runtime.state(pipeline.id).then(
      (st) => live && setDeployed(st),
      () => live && setDeployed({}),
    );
    return () => {
      live = false;
    };
  }, [pipeline.id]);
  const outputs = selectOutputs(pipeline, chosen, "single");
  const { errors: invalid, warnings } = validate(pipeline, outputs);
  const incremental = pipeline.nodes.some((n) => n.kind === "source" && n.mode === "incremental");
  const breaks = outputs.filter((o) => {
    if (!deployed || !incrementalInputs(pipeline, o.node).length) return false;
    const prev = deployed[branch && branch !== "main" ? `output:${o.id}@${branch}` : `output:${o.id}`] as { fingerprint?: string } | undefined;
    return prev?.fingerprint !== undefined && prev.fingerprint !== statefulFingerprint(pipeline, o.node);
  });
  const errors = [
    ...invalid,
    ...(replay ? [] : breaks.map((o) => `Breaking change in "${o.name}": the stateful transforms feeding it changed since the last deploy — select Replay from start of input data under Advanced settings`)),
  ];
  const consistency = pipeline.buildSettings?.consistency;
  return (
    <Modal title="Deploy pipeline" icon="upload" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          Saves your changes, then builds the outputs on the server from the latest input data (sampling does not apply). Deploys on <b className="text-soft">{branch}</b>.
        </p>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Outputs</div>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {pipeline.outputs.map((o) => (
              <li key={o.id}>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={chosen.includes(o.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))} className="accent-[var(--color-ocean)]" />
                  <span className="text-soft">{o.name}</span>
                  <span className="text-muted">{OUTPUT_KIND_LABEL[o.kind ?? "dataset"]}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-md border border-line-2 p-2 text-xs">
          <div className="mb-1 font-medium text-soft">Deployment validation</div>
          {errors.length === 0 && <p className="text-ok">Ready to deploy.</p>}
          <ul className="space-y-0.5">
            {errors.map((e) => (
              <li key={e} className="flex items-start gap-1.5 text-bad">
                <Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0" /> {e}
              </li>
            ))}
            {warnings.map((w) => (
              <li key={w} className="flex items-start gap-1.5 text-warn">
                <Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0" /> {w}
              </li>
            ))}
          </ul>
          {pipeline.type === "streaming" && <p className="mt-1 text-muted">Consistency guarantee: {consistency ? consistency.replace(/-/g, " ") : "not configured"}</p>}
        </div>
        {incremental && pipeline.type !== "streaming" && (
          <div className="rounded-md border border-line-2 text-xs">
            <button type="button" onClick={() => setAdvanced(!advanced)} className="flex w-full items-center gap-1.5 p-2 font-medium text-soft">
              <Icon name={advanced || breaks.length ? "down" : "right"} className="h-3 w-3" /> Advanced settings
              {breaks.length > 0 && <span className="ml-auto text-bad">replay required</span>}
            </button>
            {(advanced || breaks.length > 0) && (
              <div className="space-y-2 border-t border-line-2 p-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={replay}
                    onChange={(e) => {
                      setReplay(e.target.checked);
                      setConfirmed(false);
                    }}
                    className="mt-0.5 accent-[var(--color-ocean)]"
                  />
                  <span>
                    <span className="block font-medium text-soft">Replay from start of input data</span>
                    <span className="block text-muted">Incremental inputs are read from their first row again and the outputs are reset, so new logic applies to all past data and stateful transforms start over.</span>
                  </span>
                </label>
                {replay && (
                  <div className="rounded bg-warn/10 p-2 text-warn">
                    <p className="font-medium">Replaying discards the outputs&apos; history</p>
                    <p className="mt-0.5">Each output is rebuilt as a SNAPSHOT from all input data: rows added by earlier builds are replaced, and pipelines reading these outputs incrementally will see a snapshot.</p>
                    <label className="mt-1.5 flex items-center gap-2 text-soft">
                      <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="accent-[var(--color-ocean)]" /> I understand — confirm replay strategy
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !chosen.length || errors.length > 0 || (replay && !confirmed)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onDeploy(chosen, { replay });
                onClose();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name={busy ? "refresh" : "upload"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Saving and deploying…" : "Save and deploy"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
