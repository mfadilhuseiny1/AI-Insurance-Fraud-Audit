"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { DrivePicker, type PickedFolder } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, API_URL, type DriveItem } from "@/lib/api";
import { codeRepos } from "@/lib/codeRepos";
import { confirmDialog } from "@/lib/dialogs";
import type { RanFunction } from "@/lib/branchRuns";
import { when } from "@/lib/format";
import { ontology } from "@/lib/ontology";
import { om, type BranchRow } from "@/lib/ontologyModel";

type Automation = {
  id: string;
  name: string;
  description: string;
  parameters: { key: string; label: string; kind: "folder" | "code_repository" | "logic" }[];
  configuration: Record<string, unknown>;
  /** runs in the Ontology: a build or the schedule may target a global Nexus branch */
  branchable?: boolean;
};
type Run = {
  id: string;
  at: string;
  trigger: string;
  by: string;
  status: string;
  error?: string;
  logs: string[];
  ms: number;
  result?: Record<string, unknown> & { functions?: RanFunction[]; logic_run?: string; logic_id?: string };
  /** the global branch the run happened on */
  branch?: { id: string; name: string | null };
};
type Flow = {
  id: string;
  name: string;
  path: string[];
  automation: string;
  automation_name: string;
  project_id: string;
  parameters: Record<string, string>;
  parameter_labels: Record<string, string>;
  configuration: Record<string, unknown>;
  created_at: string;
  archived: boolean;
  schedule: { cron: string; timezone: string; enabled: boolean; branch_id?: string | null; branch_name?: string | null; paused_reason?: string } | null;
  runs: Run[];
  can_edit: boolean;
  branchable?: boolean;
};

async function req<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/logic-flows${path}`, {
    method,
    cache: "no-store",
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** Logic Flows [Sunset] (api/logic_flows.py): connected flows — automations run as builds, on demand or on a schedule. */
export default function LogicFlowsPage() {
  return (
    <Suspense fallback={null}>
      <LogicFlows />
    </Suspense>
  );
}

function LogicFlows() {
  const router = useRouter();
  const params = useSearchParams();
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedId = params.get("flow");
  const load = useCallback(() => req<Flow[]>(`?archived=${archived}`).then(setFlows, (e: Error) => setError(e.message)), [archived]);
  useEffect(() => {
    load();
  }, [load]);
  const [selected, setSelected] = useState<Flow | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    req<Flow>(`/by-item/${selectedId}`).then(setSelected, (e: Error) => setError(e.message));
  }, [selectedId, flows]);
  const shown = selectedId && selected?.id === selectedId ? selected : null;
  const groups = new Map<string, Flow[]>();
  for (const f of flows ?? []) groups.set(f.automation_name, [...(groups.get(f.automation_name) ?? []), f]);
  const createDialog = creating && (
    <CreateDialog
      onClose={() => setCreating(false)}
      onCreated={(f) => {
        setCreating(false);
        load();
        router.replace(`/logic-flows?flow=${f.id}`);
      }}
    />
  );
  // the home: every connected flow; one opens in place (/logic-flows?flow=…)
  if (!selectedId)
    return (
      <>
        <AppHome
          app="Logic Flows"
          icon="bolt"
          accent="#ea580c"
          href="/logic-flows"
          tagline="Sunset: connected flows that run automations as builds, on demand or on a schedule."
          description={
            <>
              Automations run as builds. For new work use{" "}
              <Link href="/logic" className="text-ocean hover:underline">
                AIP Logic
              </Link>
              , Actions or{" "}
              <Link href="/automate" className="text-ocean hover:underline">
                Automate
              </Link>
              .
            </>
          }
          noun={["connected flow", "connected flows"]}
          error={error}
          items={
            flows?.map((f) => ({
              id: f.id,
              href: `/logic-flows?flow=${f.id}`,
              title: f.name,
              path: f.path,
              updated_at: f.runs[0]?.at ?? f.created_at,
              badges: [
                { label: f.automation_name, tone: "muted" as const },
                ...(f.runs[0] ? [{ label: `Last ${f.runs[0].status}`, tone: f.runs[0].status === "succeeded" ? ("ok" as const) : ("bad" as const) }] : []),
                ...(f.schedule ? [{ label: f.schedule.enabled ? "Scheduled" : "Schedule paused", tone: f.schedule.enabled ? ("ocean" as const) : ("warn" as const) }] : []),
                ...(f.archived ? [{ label: "Archived", tone: "warn" as const }] : []),
              ],
              meta: `${f.runs.length} run${f.runs.length === 1 ? "" : "s"}`,
            })) ?? null
          }
          toolbar={
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
            </label>
          }
          empty={{ title: archived ? "No archived connected flows" : "No connected flows", hint: "A connected flow runs one automation as a build in a Project, on demand or on a schedule.", steps: ["Choose an automation", "Set its Project and parameters", "Build it or schedule it"] }}
          create={
            <>
              <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">Sunset</span>
              <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
                <Icon name="plus" className="h-3.5 w-3.5" /> Create new
              </button>
            </>
          }
        />
        {createDialog}
      </>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <span className="rounded-md bg-sand/15 p-1.5 text-sand">
          <Icon name="bolt" className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">Logic Flows</span>
        <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">Sunset</span>
        <span className="text-xs text-muted">Automations run as builds. For new work use AIP Logic, Actions or Automate.</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
          </label>
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Create new
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-line bg-panel p-3">
          <button type="button" onClick={() => router.replace("/logic-flows")} className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-strong">
            <Icon name="left" className="h-3 w-3" /> All flows
          </button>
          {error && <p className="text-xs text-bad">{error}</p>}
          {flows?.length === 0 && <p className="text-xs text-muted">No {archived ? "archived " : ""}connected flows.</p>}
          {[...groups.entries()].map(([name, list]) => (
            <div key={name} className="mb-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{name}</div>
              {list.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => router.replace(`/logic-flows?flow=${f.id}`)}
                  className={`mb-1 w-full rounded-md px-3 py-2 text-left text-xs ${f.id === selectedId ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2"}`}
                >
                  <div className="truncate font-medium">{f.name}</div>
                  <div className="truncate text-[11px] text-muted">
                    {f.path.join(" / ")}
                    {f.runs[0] ? ` · last ${f.runs[0].status}` : ""}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </aside>
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          {shown ? <FlowView key={shown.id} flow={shown} onChanged={load} /> : <p className="text-sm text-muted">Select a connected flow, or create one.</p>}
        </main>
      </div>
      {createDialog}
    </div>
  );
}

function FlowView({ flow, onChanged }: { flow: Flow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cron, setCron] = useState(flow.schedule?.cron ?? "");
  const [tz, setTz] = useState(flow.schedule?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"));
  // Ontology automations build (and run on schedule) on main or on an open global Nexus branch
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState(flow.schedule?.branch_id ?? "");
  useEffect(() => {
    if (flow.branchable) om.branches({ status: "open" }).then(setBranches, () => setBranches([]));
  }, [flow.branchable]);
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? (id === flow.schedule?.branch_id ? flow.schedule?.branch_name : null) ?? id;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{flow.name}</h1>
        <span className="rounded bg-panel-2 px-1.5 text-[11px] text-muted">{flow.automation_name}</span>
        {flow.archived && <span className="rounded bg-warn/15 px-1.5 text-[11px] text-warn">Archived</span>}
        <div className="ml-auto flex gap-2">
          {flow.can_edit && !flow.archived && flow.branchable && (
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={`${inputClass} w-48 text-xs`} aria-label="Branch" title="Build (and schedule) on main or on a global Nexus branch">
              <option value="">Main</option>
              {branchId && !branches.some((b) => b.id === branchId) && <option value={branchId}>{branchName(branchId)} (not open)</option>}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  Branch: {b.name}
                </option>
              ))}
            </select>
          )}
          {flow.can_edit && !flow.archived && (
            <button type="button" disabled={busy} onClick={() => act(() => req(`/${flow.id}/run`, "POST", { branch_id: branchId || null }))} className={buttonClass.primary}>
              <Icon name="refresh" className="h-3.5 w-3.5" /> {busy ? "Building…" : branchId ? "Build on branch" : "Build"}
            </button>
          )}
          {flow.can_edit && (
            <button
              type="button"
              onClick={async () => {
                if (!flow.archived && !(await confirmDialog("Archive this connected flow? It stops running; connected flows cannot be edited — create another instead."))) return;
                act(() => req(`/${flow.id}/archive`, "POST", { archived: !flow.archived }));
              }}
              className={buttonClass.secondary}
            >
              {flow.archived ? "Unarchive" : "Archive"}
            </button>
          )}
        </div>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
      <dl className="grid grid-cols-[11rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-muted">Project</dt>
        <dd className="text-soft">{flow.path[0] ?? "—"}</dd>
        {Object.entries(flow.parameters).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k.replace(/_/g, " ")}</dt>
            <dd className="text-soft">
              {k === "output_repository" ? (
                <Link href={`/code-repositories/${v}`} className="text-ocean hover:underline">
                  {flow.parameter_labels[k] ?? v}
                </Link>
              ) : k === "logic_function" ? (
                <Link href={`/logic/${v}`} className="text-ocean hover:underline">
                  {flow.parameter_labels[k] ?? v}
                </Link>
              ) : (
                (flow.parameter_labels[k] ?? v)
              )}
            </dd>
          </div>
        ))}
        <dt className="text-muted">Configuration</dt>
        <dd>
          <pre className="rounded bg-panel p-2 font-mono text-[11px] text-soft">{JSON.stringify(flow.configuration, null, 2)}</pre>
        </dd>
        <dt className="text-muted">Created</dt>
        <dd className="text-soft">{when(flow.created_at)}</dd>
      </dl>
      {!flow.archived && flow.can_edit && (
        <section className="rounded-xl border border-line bg-panel p-4 text-xs">
          <div className="mb-2 font-semibold text-soft">Schedule</div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 6 * * 1 (cron)" className={`${inputClass} w-40 font-mono text-xs`} />
            <input value={tz} onChange={(e) => setTz(e.target.value)} className={`${inputClass} w-40 text-xs`} aria-label="Time zone" />
            <button type="button" onClick={() => act(() => req(`/${flow.id}/schedule`, "PUT", { cron, timezone: tz, enabled: true, branch_id: branchId || null }))} className={buttonClass.secondary}>
              {branchId ? "Save schedule on branch" : "Save schedule"}
            </button>
            {flow.schedule && (
              <button type="button" onClick={() => (setCron(""), act(() => req(`/${flow.id}/schedule`, "PUT", { cron: "", timezone: tz })))} className="text-muted hover:text-bad">
                Remove
              </button>
            )}
          </div>
          <p className="mt-1 text-muted">
            {flow.schedule
              ? `Runs on ${flow.schedule.cron} (${flow.schedule.timezone})${flow.schedule.branch_id ? ` on the branch ${flow.schedule.branch_name ?? flow.schedule.branch_id}` : ""}.`
              : "Not scheduled: Build runs it now."}
          </p>
          {flow.schedule && !flow.schedule.enabled && (
            <p className="mt-1 text-warn" data-testid="schedule-paused">
              Paused{flow.schedule.paused_reason ? `: ${flow.schedule.paused_reason}` : ""}. Save the schedule again (on main or an open branch) to resume.
            </p>
          )}
          {flow.branchable && <p className="mt-1 text-muted">A schedule on a branch stops when the branch merges or closes.</p>}
        </section>
      )}
      <section>
        <div className="mb-2 text-sm font-semibold">Runs</div>
        {!flow.runs.length && <p className="text-xs text-muted">Not run yet.</p>}
        <ul className="space-y-2">
          {flow.runs.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-panel p-3 text-xs">
              <div className="flex items-center gap-2">
                <span className={r.status === "succeeded" ? "text-ok" : "text-bad"}>{r.status}</span>
                <span className="text-muted">
                  {when(r.at)} · {r.trigger} · {(r.ms / 1000).toFixed(1)} s
                </span>
                {r.branch && (
                  <span className="flex items-center gap-1 rounded bg-sand/15 px-1.5 text-[11px] text-sand">
                    <Icon name="split" className="h-3 w-3" /> {r.branch.name ?? r.branch.id}
                  </span>
                )}
                {typeof r.result?.logic_run === "string" && (
                  <Link href={`/logic/${r.result.logic_id}`} className="ml-auto text-ocean hover:underline">
                    Logic run
                  </Link>
                )}
                {typeof r.result?.pull_request === "string" && (
                  <Link href={`/code-repositories/${flow.parameters.output_repository}?tab=pulls&pr=${r.result.pull_request}`} className="ml-auto text-ocean hover:underline">
                    Pull request #{r.result.pull_request}
                    {r.result.merged ? " (merged)" : ""}
                  </Link>
                )}
              </div>
              {r.error && <p className="mt-1 text-bad">{r.error}</p>}
              {!!r.result?.functions?.length && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="run-functions">
                  <span className="text-muted">Function versions:</span>
                  {r.result.functions.map((f) => (
                    <Link key={`${f.function_id}@${f.version}`} href={`/functions/${f.function_id}`} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-soft ring-1 ring-line-2 hover:text-white">
                      {f.function} {f.version}
                      {f.branched ? " · Branched pre-release" : ""}
                    </Link>
                  ))}
                </div>
              )}
              <ul className="mt-1 list-disc pl-5 text-muted">
                {r.logs.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (f: Flow) => void }) {
  const [autos, setAutos] = useState<Automation[]>([]);
  const [automation, setAutomation] = useState("compass-files-lister");
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [project, setProject] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [repos, setRepos] = useState<{ id: string; name: string }[]>([]);
  const [logics, setLogics] = useState<{ id: string; name: string }[]>([]);
  const [config, setConfig] = useState("");
  const [picking, setPicking] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    req<Automation[]>("/automations").then((a) => {
      setAutos(a);
      setConfig(JSON.stringify(a[0]?.configuration ?? {}, null, 2));
    }, () => {});
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setProject((cur) => cur || ps[0]?.id || "");
    }, () => {});
    codeRepos.list().then((r) => setRepos(r.map((x) => ({ id: x.id, name: x.name }))), () => {});
    ontology.logicList().then((l) => setLogics(l.map((x) => ({ id: x.id, name: x.name }))), () => {});
  }, []);
  const pickAutomation = (id: string) => {
    setAutomation(id);
    setValues({});
    setLabels({});
    setProblems(null);
    setConfig(JSON.stringify(autos.find((a) => a.id === id)?.configuration ?? {}, null, 2));
  };
  const auto = autos.find((a) => a.id === automation);
  const body = () => {
    let configuration: Record<string, unknown> = {};
    try {
      configuration = config.trim() ? JSON.parse(config) : {};
    } catch {
      throw new Error("the configuration is not valid JSON");
    }
    return { name: name.trim(), automation, project_id: project, parameters: values, configuration };
  };
  const check = async () => {
    try {
      setProblems((await req<{ problems: string[] }>("/validate", "POST", body())).problems);
    } catch (e) {
      setProblems([(e as Error).message]);
    }
  };
  if (picking)
    return (
      <DrivePicker
        title="Choose the input folder"
        folder={{
          action: "Use this folder",
          onPick: (f: PickedFolder) => {
            if (f.id) {
              setValues({ ...values, [picking]: f.id });
              setLabels({ ...labels, [picking]: f.name });
            }
            setPicking(null);
          },
        }}
        onClose={() => setPicking(null)}
      />
    );
  return (
    <Modal title="New connected flow" icon="bolt" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <label className="block text-xs text-muted">
          Automation
          <select value={automation} onChange={(e) => pickAutomation(e.target.value)} className={`${inputClass} mt-1`}>
            {autos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {auto && <span className="mt-1 block text-[11px]">{auto.description}</span>}
        </label>
        <label className="block text-xs text-muted">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-xs text-muted">
          Project (the flow and its parameters live here)
          <select value={project} onChange={(e) => setProject(e.target.value)} className={`${inputClass} mt-1`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {auto?.parameters.map((p) => (
          <div key={p.key} className="text-xs text-muted">
            {p.label}
            {p.kind === "folder" ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-soft">{labels[p.key] ?? "not set"}</span>
                <button type="button" onClick={() => setPicking(p.key)} className="text-ocean hover:underline">
                  Choose…
                </button>
              </div>
            ) : p.kind === "logic" ? (
              <select value={values[p.key] ?? ""} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} className={`${inputClass} mt-1`} aria-label={p.label}>
                <option value="">Choose a Logic function…</option>
                {logics.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            ) : (
              <select value={values[p.key] ?? ""} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} className={`${inputClass} mt-1`}>
                <option value="">Choose a repository…</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
        <label className="block text-xs text-muted">
          Configuration (JSON)
          <textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={4} className={`${inputClass} mt-1 font-mono text-xs`} />
        </label>
        {problems && (problems.length ? <ul className="list-disc pl-5 text-xs text-bad">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : <p className="text-xs text-ok">Valid.</p>)}
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={check} className={buttonClass.secondary}>
            Validate
          </button>
          <button
            type="button"
            disabled={!name.trim() || !project}
            onClick={async () => {
              setErr(null);
              try {
                onCreated(await req<Flow>("", "POST", body()));
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}
