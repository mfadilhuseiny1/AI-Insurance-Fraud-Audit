"use client";

import Link from "next/link";
import { ItemMarkingsPanel } from "../auth/ItemMarkings";
import { useEffect, useMemo, useState } from "react";
import { CodeEditor } from "@/components/code/CodeEditor";
import { Icon } from "@/components/Icon";
import { Badge, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { codeRepos } from "@/lib/codeRepos";
import { bytes, when } from "@/lib/format";
import { familyOf, KIND_ICON, lineage, ROOT_APP, type BuildJob, type BuildStep, type CodeView, type HealthRule, type LineageDetail, type LineageNode, type TimelineEntry, type Transaction, type DatasetDiff } from "@/lib/lineage";
import { fmt } from "@/lib/workshop";
import { CUSTOM_SWATCHES } from "./coloring";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

const row = (label: string, value: React.ReactNode) =>
  value === undefined || value === null || value === "" ? null : (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-soft">{value}</span>
    </div>
  );

function NodeLink({ n, onSelect, via }: { n: LineageNode; onSelect: (id: string) => void; via?: string }) {
  return (
    <button type="button" onClick={() => onSelect(n.id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-panel-2">
      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: familyOf(n.kind).color }} />
      <Icon name={KIND_ICON[n.kind]} className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="truncate text-sm text-soft">{n.name}</span>
      {via && <span className="ml-auto shrink-0 text-[11px] text-muted">{via}</span>}
    </button>
  );
}

// ------------------------------------------------------------------------------------------ properties

export function PropertiesPanel({
  id,
  onSelect,
  onFocus,
  customColor,
  onCustomColor,
}: {
  id: string;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  customColor?: string;
  onCustomColor?: (c: string | null) => void;
}) {
  const [d, setD] = useState<LineageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"about" | "columns" | "access">("about");
  useEffect(() => {
    let stale = false;
    lineage
      .node(id)
      .then((x) => {
        if (!stale) {
          setD(x);
          setError(null);
        }
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [id]);
  const cols = (d?.columns ?? []).map((c) => (typeof c === "string" ? { name: c, type: "" } : c));
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        {d && <Icon name={KIND_ICON[d.kind]} className="h-4 w-4" />}
        <span className="min-w-0 flex-1 truncate font-semibold">{d?.name ?? "…"}</span>
        {d?.console && d.console !== d.link && (
          <Link href={d.console} className={buttonClass.ghost} title="Open in Developer Console">
            <Icon name="code" className="h-3.5 w-3.5" />
          </Link>
        )}
        {d?.link && (
          <Link href={d.link} className={buttonClass.ghost} title={d.console && d.console !== d.link ? "Open the application" : "Open in its app"}>
            <Icon name="external" className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <div className="flex border-b border-line px-2 text-xs">
        {(["about", "columns", "access"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-2.5 py-2 capitalize ${tab === t ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <div className="text-xs text-bad">{error}</div>}
        {!d && !error && <div className="text-xs text-muted">Loading…</div>}
        {d && tab === "about" && (
          <div>
            <div className="mb-3 flex flex-wrap gap-2">
              {/* the node's root app first: a model's is the repository that trains it */}
              {d.training && (
                <Link href={d.training.link} className={buttonClass.primary} title={d.training.app ? `${d.training.app}: ${d.training.repo ?? ""}` : `${d.training.repo ?? "Code repository"} · ${d.training.path} · ${d.training.function}()`}>
                  <Icon name={d.training.app === "Jupyter" ? "doc" : d.training.app === "Model Studio" ? "cpu" : "code"} className="h-3.5 w-3.5" />{" "}
                  {d.training.app === "Jupyter" ? "Notebook training · Jupyter" : d.training.app === "Model Studio" ? "Run training · Model Studio" : "Kode training · Code Repositories"}
                </Link>
              )}
              {d.link && (
                <Link
                  href={d.link}
                  target={d.link.startsWith("http") ? "_blank" : undefined}
                  className={d.training ? buttonClass.secondary : buttonClass.primary}
                  title={d.link}
                >
                  <Icon name={ROOT_APP[d.kind]?.icon ?? "external"} className="h-3.5 w-3.5" /> Buka di {ROOT_APP[d.kind]?.app ?? "app"}
                </Link>
              )}
              <button type="button" onClick={() => onFocus(d.id)} className={buttonClass.secondary}>
                <Icon name="split" className="h-3.5 w-3.5" /> Focus lineage
              </button>
            </div>
            {d.stale && (
              <div className="mb-2 flex items-start gap-2 rounded-md bg-warn/10 p-2 text-xs text-warn">
                <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Out of date: {d.stale}
              </div>
            )}
            {d.missing && <div className="mb-2 rounded-md bg-bad/10 p-2 text-xs text-bad">Deleted or in the trash, but still referenced.</div>}
            {row("Type", d.kind_label)}
            {row(
              "Root app",
              d.link ? (
                <Link href={d.link} target={d.link.startsWith("http") ? "_blank" : undefined} className="text-ocean hover:underline">
                  {ROOT_APP[d.kind]?.app ?? "Open"}
                </Link>
              ) : undefined,
            )}
            {row(
              "Training code",
              d.training ? (
                <Link href={d.training.link} className="text-ocean hover:underline">
                  {d.training.app
                    ? `${d.training.app} · ${d.training.repo ?? ""}`
                    : `${d.training.repo ?? "repository"} · ${d.training.path.split("/").pop()} · ${d.training.function}()`}
                  {d.training.version ? ` → v${d.training.version}` : ""}
                </Link>
              ) : undefined,
            )}
            {d.kind === "reference" && (
              <>
                {row("Title", d.title)}
                {row("Authors", d.authors)}
                {row("DOI", d.doi ? <a href={`https://doi.org/${d.doi}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">{d.doi}</a> : undefined)}
                {row("How it is used", d.note)}
                {row("Licence", d.license)}
                {row("PDF", d.item_id ? <a href={`${API_URL}/api/drive/items/${d.item_id}/content?disposition=inline`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">open the PDF</a> : undefined)}
              </>
            )}
            {row("Location", d.path?.length ? ["Files & Projects", ...d.path].join(" / ") : undefined)}
            {row("Updated", d.updated_at ? when(d.updated_at) : undefined)}
            {row("Created", d.created_at ? when(d.created_at) : undefined)}
            {row("Size", [cols.length ? `${cols.length} columns` : "", d.rows !== undefined ? `${d.rows.toLocaleString()} rows` : "", d.size ? bytes(d.size) : ""].filter(Boolean).join(" · "))}
            {row(
              "Updated via",
              d.updated_via ? (
                <button type="button" onClick={() => onSelect(d.updated_via!.id)} className="text-ocean hover:underline">
                  {d.updated_via.kind === "pipeline" ? "Pipeline" : "Code transform"} · {d.updated_via.name}
                </button>
              ) : undefined,
            )}
            {row("Backs Nexus object type", d.defines_object_types?.length ? d.defines_object_types.join(", ") : undefined)}
            {row("Details", d.subtitle && d.kind !== "dataset" ? d.subtitle : undefined)}
            {row("Last build", d.last_build ? <span>{d.last_build.status} {d.last_build.at ? `· ${when(d.last_build.at)}` : ""}</span> : undefined)}
            {row("Transactions", d.transactions ? `${d.transactions} kept (History tab)` : undefined)}
            {row("Status", d.status)}
            {row("Branch", d.branch)}
            {row("ID", <span className="font-mono text-xs">{d.item_id ?? d.id}</span>)}
            {onCustomColor && (
              <div className="mt-3">
                <div className="mb-1 text-xs text-muted">Custom color</div>
                <div className="flex gap-1.5">
                  {CUSTOM_SWATCHES.map((c) => (
                    <button key={c} type="button" onClick={() => onCustomColor(c)} className={`h-5 w-5 rounded ${customColor === c ? "ring-2 ring-white" : ""}`} style={{ background: c }} aria-label={c} />
                  ))}
                  <button type="button" onClick={() => onCustomColor(null)} className="text-xs text-muted hover:text-white">
                    clear
                  </button>
                </div>
              </div>
            )}
            {d.inputs.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-xs font-semibold text-soft">Inputs ({d.inputs.length})</div>
                {d.inputs.map((n) => (
                  <NodeLink key={n.id} n={n} via={n.via} onSelect={onSelect} />
                ))}
              </div>
            )}
            {d.outputs.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-xs font-semibold text-soft">Used by ({d.outputs.length})</div>
                {d.outputs.map((n) => (
                  <NodeLink key={n.id} n={n} via={n.via} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>
        )}
        {d && tab === "columns" &&
          (cols.length ? (
            <table className="w-full text-xs">
              <tbody>
                {cols.map((c) => (
                  <tr key={c.name} className="border-b border-line">
                    <td className="py-1.5 font-mono text-soft">{c.name}</td>
                    <td className="py-1.5 text-right text-muted">{c.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted">{d.read_error ?? "No schema for this kind of node."}</p>
          ))}
        {d && tab === "access" && (
          <div className="space-y-3 text-xs text-soft">
            <div className="flex items-start gap-2 rounded-md border border-line bg-panel-2 p-2.5">
              <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
              <span>Only signed-in users holding every marking below can open this. Outputs built from it inherit its markings.</span>
            </div>
            {d.item_id ? <ItemMarkingsPanel key={d.item_id} itemId={d.item_id} /> : <p className="text-muted">No Files item: markings do not apply.</p>}
            {d.kind === "dataset" &&
              (d.shares?.length ? (
                <div>
                  <div className="mb-1 font-medium">Share links ({d.shares.length})</div>
                  {d.shares.map((s, i) => (
                    <div key={i} className="py-0.5 text-muted">
                      Created {s.created_at ? when(s.created_at) : "?"} · {s.expires_at ? `expires ${when(s.expires_at)}` : "never expires"}
                    </div>
                  ))}
                  <p className="mt-1 text-muted">Anyone with one of these links can view and download this dataset.</p>
                </div>
              ) : (
                <p className="text-muted">No share links: the dataset is not visible outside the app.</p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Several nodes selected: their common properties, each value clickable to narrow the selection. */
export function HistogramPanel({ nodes, onSelectIds }: { nodes: LineageNode[]; onSelectIds: (ids: string[]) => void }) {
  const groups = useMemo(() => {
    const count = (key: (n: LineageNode) => string[] | string | undefined) => {
      const m = new Map<string, string[]>();
      for (const n of nodes) {
        const v = key(n);
        for (const x of Array.isArray(v) ? v : v ? [v] : []) m.set(x, [...(m.get(x) ?? []), n.id]);
      }
      return [...m.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12);
    };
    return [
      { title: "Resource type", items: count((n) => n.kind_label) },
      { title: "Frequent columns", items: count((n) => n.columns) },
      { title: "Frequent folder paths", items: count((n) => n.folder) },
      { title: "Last build", items: count((n) => n.last_build?.status) },
      { title: "Out of date", items: count((n) => (n.stale ? "out of date" : n.producers?.length ? "up to date" : undefined)) },
    ].filter((g) => g.items.length);
  }, [nodes]);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex-1 font-semibold">{nodes.length} nodes selected</span>
        <button type="button" onClick={() => navigator.clipboard.writeText(nodes.map((n) => [...(n.path ?? []), n.name].join("/")).join(", "))} className={buttonClass.ghost}>
          <Icon name="copy" className="h-3.5 w-3.5" /> Copy names
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="mb-1 text-xs font-semibold text-soft">{g.title}</div>
            {g.items.map(([label, ids]) => (
              <button key={label} type="button" onClick={() => onSelectIds(ids)} title="Select only these" className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-panel-2">
                <span className="truncate font-mono text-soft">{label}</span>
                <span className="ml-auto h-1.5 rounded-full bg-ocean/70" style={{ width: `${(ids.length / nodes.length) * 60}px` }} />
                <span className="w-6 text-right tabular-nums text-muted">{ids.length}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ builds

export function BuildsPanel({ selected, onBuilt }: { selected: string[]; onBuilt: () => void }) {
  const [strategy, setStrategy] = useState<"selected" | "ancestors" | "between">("ancestors");
  const [force, setForce] = useState(false);
  const [plan, setPlan] = useState<{ steps: BuildStep[]; skipped: string[] } | null>(null);
  const [job, setJob] = useState<BuildJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      try {
        const j = await lineage.buildJob(job.id);
        setJob(j);
        if (j.status !== "running") onBuilt();
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [job, onBuilt]);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="border-b border-line px-4 py-3 font-semibold">Build</div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {!selected.length ? (
          <p className="text-xs text-muted">Select datasets or transforms on the graph to build them.</p>
        ) : (
          <>
            <div className="space-y-1.5 text-xs">
              {(
                [
                  ["selected", "Selected datasets only", "Rebuild just what is selected"],
                  ["ancestors", "Selected and out-of-date ancestors", "Bring the selection fully up to date"],
                  ["between", "All transforms in between", "Everything on paths between the selected nodes"],
                ] as const
              ).map(([k, label, hint]) => (
                <label key={k} className={`flex cursor-pointer gap-2 rounded-md border p-2 ${strategy === k ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                  <input
                    type="radio"
                    checked={strategy === k}
                    onChange={() => {
                      setStrategy(k);
                      setPlan(null);
                    }}
                    className="mt-0.5 accent-[var(--color-ocean)]"
                  />
                  <span>
                    <span className="block text-soft">{label}</span>
                    <span className="text-muted">{hint}</span>
                  </span>
                </label>
              ))}
              {strategy === "ancestors" && (
                <label className="flex items-center gap-2 text-muted">
                  <input type="checkbox" checked={force} onChange={(e) => (setForce(e.target.checked), setPlan(null))} className="accent-[var(--color-ocean)]" /> Force build of up-to-date ancestors
                </label>
              )}
            </div>
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  setPlan(await lineage.buildPlan(selected, strategy, force));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={buttonClass.secondary}
            >
              Next: preview the build
            </button>
            {plan && plan.steps.length === 0 && <p className="text-xs text-muted">Nothing to build: the selection has no pipelines or code transforms behind it{plan.skipped.length ? ` (${plan.skipped.join(", ")})` : ""}.</p>}
            {plan && plan.steps.length > 0 && !job && (
              <div className="space-y-2">
                <div className="text-xs text-soft">Builds run in this order:</div>
                {plan.steps.map((s, i) => (
                  <div key={s.producer} className="rounded-md border border-line bg-panel-2 p-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted">{i + 1}.</span>
                      <Icon name={s.kind === "pipeline" ? "pipeline" : "code"} className="h-3.5 w-3.5 text-warn" />
                      <span className="text-soft">{s.name}</span>
                      {s.reason && <span className="ml-auto text-warn">{s.reason}</span>}
                    </div>
                    {s.datasets.length > 0 && <div className="mt-0.5 pl-5 text-muted">→ {s.datasets.join(", ")}</div>}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      setJob(await lineage.buildRun(selected, strategy, force));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                  className={buttonClass.primary}
                >
                  <Icon name="play" className="h-3.5 w-3.5" /> Run build
                </button>
              </div>
            )}
            {job && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Badge status={job.status === "running" ? "enabled" : job.status} label={job.status} />
                  <button type="button" onClick={() => (setJob(null), setPlan(null))} className="ml-auto text-muted hover:text-white">
                    New build
                  </button>
                </div>
                {job.steps.map((s) => (
                  <div key={s.producer} className="rounded-md border border-line bg-panel-2 p-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <Icon name={s.status === "running" ? "refresh" : s.status === "succeeded" ? "check" : s.status === "failed" ? "x" : "clock"} className={`h-3.5 w-3.5 ${s.status === "running" ? "animate-spin text-ocean" : s.status === "succeeded" ? "text-ok" : s.status === "failed" ? "text-bad" : "text-muted"}`} />
                      <span className="text-soft">{s.name}</span>
                      <span className="ml-auto text-muted">{s.status}</span>
                    </div>
                    {s.error && <pre className="mt-1 whitespace-pre-wrap text-bad">{s.error}</pre>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <ErrorBox message={error} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ schedules

export function SchedulesPanel({ nodes, onChanged }: { nodes: LineageNode[]; onChanged: () => void }) {
  const [every, setEvery] = useState("60");
  const [onInput, setOnInput] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const withSchedules = nodes.filter((n) => n.schedules?.length || n.schedule);
  const transforms = nodes.filter((n) => n.kind === "transform" && n.buildable && !n.schedules?.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="border-b border-line px-4 py-3 font-semibold">Schedules</div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
        {!nodes.length && <p className="text-muted">Select nodes to see their schedules.</p>}
        {nodes.length > 0 && !withSchedules.length && <p className="text-muted">No schedules on the selection.</p>}
        {withSchedules.map((n) => (
          <div key={n.id} className="rounded-md border border-line bg-panel-2 p-2">
            <div className="flex items-center gap-1.5 text-soft">
              <Icon name={KIND_ICON[n.kind]} className="h-3.5 w-3.5" /> {n.name}
              {n.link && (
                <Link href={n.link} className="ml-auto text-ocean hover:underline">
                  Edit
                </Link>
              )}
            </div>
            {(n.schedules ?? []).map((s, i) => (
              <div key={i} className="mt-1 flex items-center gap-2 pl-5 text-muted">
                <Icon name="clock" className="h-3 w-3" /> {s.name}
                <span>{[s.cron, s.on_data_update ? "when inputs update" : ""].filter(Boolean).join(" · ")}</span>
                <Badge status={s.enabled ? "enabled" : "paused"} label={s.enabled ? "on" : "paused"} />
              </div>
            ))}
            {n.schedule && (
              <div className="mt-1 pl-5 text-muted">
                {n.schedule}
                {n.next_run_at ? ` · next ${when(n.next_run_at)}` : ""}
              </div>
            )}
          </div>
        ))}
        {transforms.length > 0 && (
          <div className="space-y-2 rounded-md border border-ocean/40 p-2">
            <div className="text-soft">Schedule {transforms.length === 1 ? transforms[0].name : `${transforms.length} code transforms`}</div>
            <label className="flex items-center gap-2">
              every <input type="number" min={0} value={every} onChange={(e) => setEvery(e.target.value)} className={`${fieldClass} w-20`} /> minutes (0 = off)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={onInput} onChange={(e) => setOnInput(e.target.checked)} className="accent-[var(--color-ocean)]" /> when an input dataset updates
            </label>
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  for (const t of transforms)
                    await codeRepos.addSchedule(t.repo_id!, { transform: t.transform!, every_minutes: Number(every) || null, on_input_update: onInput, enabled: true });
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              Add schedule
            </button>
            <p className="text-muted">Pipelines are scheduled in Pipeline Builder; data sources in Data Connection.</p>
          </div>
        )}
        <ErrorBox message={error} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ related

export function RelatedPanel({ nodes, all, edges, onSelect }: { nodes: LineageNode[]; all: Map<string, LineageNode>; edges: { from: string; to: string; label: string }[]; onSelect: (id: string) => void }) {
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const related = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const out = new Map<string, { n: LineageNode; via: string }>();
    for (const e of edges) {
      if (ids.has(e.from) && !ids.has(e.to)) {
        const n = all.get(e.to);
        if (n && n.kind !== "dataset") out.set(n.id, { n, via: e.label });
      }
    }
    return [...out.values()];
  }, [nodes, all, edges]);
  const kindList = [...new Set(related.map((r) => r.n.kind_label))];
  const shown = related.filter((r) => !kinds.size || kinds.has(r.n.kind_label));
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="border-b border-line px-4 py-3 font-semibold">Related items</div>
      <div className="flex flex-wrap gap-1 border-b border-line p-2 text-[11px]">
        {kindList.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              const s = new Set(kinds);
              if (s.has(k)) s.delete(k);
              else s.add(k);
              setKinds(s);
            }}
            className={`rounded-full px-2 py-0.5 ring-1 ${kinds.has(k) ? "bg-ocean/15 text-white ring-ocean/40" : "text-muted ring-line-2"}`}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!nodes.length && <p className="p-2 text-xs text-muted">Select a dataset to see the pipelines, transforms, object types and apps that use it.</p>}
        {nodes.length > 0 && !shown.length && <p className="p-2 text-xs text-muted">Nothing outside the selection uses it.</p>}
        {shown.map(({ n, via }) => (
          <div key={n.id} className="flex items-center">
            <div className="min-w-0 flex-1">
              <NodeLink n={n} via={via} onSelect={onSelect} />
            </div>
            {n.link && (
              <Link href={n.link} target="_blank" className="p-1 text-muted hover:text-white" title="Open">
                <Icon name="external" className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ bottom panel

export function PreviewTab({ id }: { id: string }) {
  const [data, setData] = useState<{ key: string; columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total_rows: number } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let stale = false;
    lineage
      .preview(id)
      .then((r) => !stale && setData({ key: id, ...r }))
      .catch((e: Error) => !stale && setError({ key: id, message: e.message }));
    return () => {
      stale = true;
    };
  }, [id]);
  if (error?.key === id) return <p className="p-3 text-xs text-muted">{error.message}</p>;
  const cur = data?.key === id ? data : null;
  if (!cur) return <p className="p-3 text-xs text-muted">Loading…</p>;
  const cols = cur.columns.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted">
        First {cur.rows.length.toLocaleString()} of {cur.total_rows.toLocaleString()} rows
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search columns…" className={`${fieldClass} ml-auto w-48 py-0.5 text-xs`} />
      </div>
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-panel text-left text-muted">
          <tr className="border-b border-line">
            {cols.map((c) => (
              <th key={c.name} className="whitespace-nowrap px-3 py-1.5 font-medium">
                {c.name} <span className="font-normal text-muted/70">{c.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {cur.rows.map((r, i) => (
            <tr key={i} className="border-b border-line">
              {cols.map((c) => (
                <td key={c.name} className="max-w-64 truncate whitespace-nowrap px-3 py-1 text-soft">
                  {fmt(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryTab({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<LineageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comparing, setComparing] = useState<[string, string] | null>(null);
  const load = () =>
    lineage
      .node(id)
      .then(setD)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    let stale = false;
    lineage
      .node(id)
      .then((x) => !stale && setD(x))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [id]);
  if (error) return <p className="p-3 text-xs text-bad">{error}</p>;
  if (!d) return <p className="p-3 text-xs text-muted">Loading…</p>;
  const txs = d.transactions_list ?? [];
  const committed = txs.filter((t) => !t.aborted);
  return (
    <div className="grid gap-4 p-3 text-xs lg:grid-cols-2">
      {comparing && <DiffDialog id={id} a={comparing[0]} b={comparing[1]} onClose={() => setComparing(null)} />}
      {d.kind === "dataset" && (
        <div>
          <div className="mb-1.5 font-semibold text-soft">Transactions</div>
          {txs.length === 0 && <p className="text-muted">No transactions recorded yet: they are kept from the next pipeline deploy or code build on.</p>}
          {txs.map((t: Transaction) => {
            const ci = committed.indexOf(t);
            const before = ci >= 0 ? committed[ci + 1] : undefined;
            return (
            <div
              key={t.id}
              title={t.aborted ? "Aborted: the job succeeded but committed nothing to this dataset" : undefined}
              className={`mb-1 flex items-center gap-2 rounded-md border border-line px-2 py-1.5 ${t.rolled_back || t.aborted ? "opacity-50" : ""}`}
            >
              <span className={`rounded px-1.5 text-[10px] uppercase ${t.aborted ? "bg-line-2 text-muted" : t.kind === "rollback" ? "bg-warn/15 text-warn" : "bg-ocean/15 text-ocean"}`}>{t.kind}</span>
              <span className={`min-w-0 flex-1 truncate ${t.rolled_back ? "line-through" : t.aborted ? "text-muted" : "text-soft"}`}>
                {t.kind === "rollback" ? `rolled back to ${t.source.to_at ? when(t.source.to_at) : t.source.to}` : `${t.source.name ?? t.source.kind}${t.source.commit ? ` @ ${t.source.commit.slice(0, 7)}` : ""}`}
                {t.aborted && ` · nothing committed${t.source.reason === "empty" ? " (empty write)" : t.source.reason === "abort_job" ? " (abort_job)" : ""}`}
                {t.rows !== null && ` · ${t.rows.toLocaleString()} rows`}
              </span>
              <span className="shrink-0 text-muted">{when(t.at)}</span>
              {t.kept && before?.kept && (
                <button type="button" onClick={() => setComparing([before.id, t.id])} className="shrink-0 text-ocean hover:underline" title="Compare with the previous transaction">
                  Compare
                </button>
              )}
              {ci > 0 && t.kept && !t.rolled_back && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={async () => {
                    if (!(await confirmDialog(`Roll the dataset back to this transaction (${when(t.at)})? Later transactions are marked as rolled back. The logic is unchanged: the next build writes from the current code again.`))) return;
                    setBusy(t.id);
                    try {
                      await lineage.rollback(id, t.id);
                      await load();
                      onChanged();
                    } catch (e) {
                      void alertDialog((e as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                  className="shrink-0 text-ocean hover:underline"
                >
                  {busy === t.id ? "Rolling back…" : "Roll back"}
                </button>
              )}
            </div>
            );
          })}
        </div>
      )}
      <div>
        <div className="mb-1.5 font-semibold text-soft">Builds and runs</div>
        {d.events.length === 0 && <p className="text-muted">No builds, syncs or runs recorded.</p>}
        <ol className="space-y-1.5 border-l border-line pl-3">
          {d.events.map((e, i) => (
            <li key={i} className="relative">
              <span className={`absolute -left-[17px] top-1 h-2 w-2 rounded-full ${e.status === "failed" ? "bg-bad" : e.status === "succeeded" || e.status === "completed" ? "bg-ok" : "bg-line-2"}`} />
              <div className="text-soft">{e.text}</div>
              <div className="text-muted">{e.at ? when(e.at) : ""}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function CodeTab({ id }: { id: string }) {
  const [code, setCode] = useState<{ key: string; v: CodeView } | null>(null);
  useEffect(() => {
    let stale = false;
    lineage
      .code(id)
      .then((v) => !stale && setCode({ key: id, v }))
      .catch((e: Error) => !stale && setCode({ key: id, v: { kind: "none", message: e.message } }));
    return () => {
      stale = true;
    };
  }, [id]);
  const v = code?.key === id ? code.v : null;
  if (!v) return <p className="p-3 text-xs text-muted">Loading…</p>;
  if (v.kind === "none") return <p className="p-3 text-xs text-muted">{v.message}</p>;
  if (v.kind === "pipeline")
    return (
      <div className="p-3 text-xs">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="pipeline" className="h-3.5 w-3.5 text-warn" /> <span className="text-soft">Pipeline {v.name}</span>
          <Link href={v.link} className="ml-auto text-ocean hover:underline">
            View in Pipeline Builder
          </Link>
        </div>
        <ol className="space-y-0.5">
          {v.steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-6 text-right text-muted">{i + 1}.</span>
              <span className="rounded bg-panel-2 px-1.5 text-muted">{s.kind}</span>
              <span className="text-soft">{s.name}</span>
              {s.description && <span className="text-muted">— {s.description}</span>}
            </li>
          ))}
        </ol>
        <div className="mt-2 text-muted">Outputs: {v.outputs.join(", ")}</div>
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
        <span className="font-mono text-soft">
          {v.repo} / {v.path}
        </span>
        {v.commit && <span>at commit {v.commit.slice(0, 7)}</span>}
        <Link href={v.link} className="ml-auto text-ocean hover:underline">
          View in repository
        </Link>
      </div>
      <CodeEditor path={v.path} value={v.content} onChange={() => {}} readOnly highlightLine={v.line ?? undefined} />
    </div>
  );
}

export function TimelineTab({ highlight, onSelect }: { highlight: Set<string>; onSelect: (id: string) => void }) {
  const [hours, setHours] = useState(24);
  const [entries, setEntries] = useState<{ key: number; v: TimelineEntry[] } | null>(null);
  const [onlySelected, setOnlySelected] = useState(false);
  useEffect(() => {
    let stale = false;
    lineage
      .timeline(hours)
      .then((v) => !stale && setEntries({ key: hours, v }))
      .catch(() => !stale && setEntries({ key: hours, v: [] }));
    return () => {
      stale = true;
    };
  }, [hours]);
  const [now] = useState(() => Date.now());
  const all = entries?.key === hours ? entries.v : null;
  const shown = (all ?? []).filter((e) => !onlySelected || highlight.has(e.node));
  const lanes = [...new Set(shown.map((e) => e.label))];
  const start = now - hours * 3_600_000;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - start) / (now - start)) * 100));
  const color = (s: string) => (s === "succeeded" ? "#0ca30c" : s === "failed" ? "#d03b3b" : s === "running" || s === "queued" ? "#3d8bfd" : "#6b7586");
  return (
    <div className="p-3 text-xs">
      <div className="mb-2 flex items-center gap-2 text-muted">
        Builds from the past
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="rounded border border-line-2 bg-ink px-1 py-0.5">
          {[1, 6, 24, 72, 168, 240].map((h) => (
            <option key={h} value={h}>
              {h < 24 ? `${h} hours` : `${h / 24} days`}
            </option>
          ))}
        </select>
        <label className="ml-3 flex items-center gap-1">
          <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} className="accent-[var(--color-ocean)]" /> only selected nodes
        </label>
        <span className="ml-auto flex items-center gap-3">
          {[
            ["succeeded", "check"],
            ["failed", "x"],
            ["running", "refresh"],
          ].map(([s, icon]) => (
            <span key={s} className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm" style={{ background: color(s) }} />
              <Icon name={icon as "check"} className="h-3 w-3" /> {s}
            </span>
          ))}
        </span>
      </div>
      {!all && <p className="text-muted">Loading…</p>}
      {all && lanes.length === 0 && <p className="text-muted">No builds or runs in this period.</p>}
      <div className="space-y-1">
        {lanes.map((lane) => (
          <div key={lane} className="flex items-center gap-2">
            <span className="w-48 shrink-0 truncate text-soft" title={lane}>
              {lane}
            </span>
            <div className="relative h-4 flex-1 rounded bg-panel-2">
              {shown
                .filter((e) => e.label === lane)
                .map((e, i) => {
                  const s = new Date(e.start).getTime();
                  const en = e.end ? new Date(e.end).getTime() : now;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onSelect(e.node)}
                      title={`${e.label}\n${e.status}${e.trigger ? ` · ${e.trigger}` : ""}\n${when(e.start)} · ${((en - s) / 1000).toFixed(1)} s`}
                      className="absolute top-0.5 h-3 rounded-sm"
                      style={{ left: `${pct(s)}%`, width: `max(4px, ${pct(en) - pct(s)}%)`, background: color(e.status) }}
                    />
                  );
                })}
            </div>
          </div>
        ))}
      </div>
      {lanes.length > 0 && (
        <div className="mt-1 flex justify-between pl-[200px] text-[10px] text-muted">
          <span>{new Date(start).toLocaleString()}</span>
          <span>now</span>
        </div>
      )}
    </div>
  );
}

const RULE_LABEL: Record<HealthRule["kind"], string> = {
  freshness: "Freshness: updated within N hours",
  time_since_updated: "Time since last updated (transactions)",
  data_freshness: "Data freshness: newest timestamp within N hours",
  row_count: "Row count within a range",
  schema: "Schema check",
  columns: "Required columns present",
  build_status: "Last build succeeded",
  up_to_date: "Up to date with its inputs",
};

export function HealthTab({ node, onChanged }: { node: LineageNode; onChanged: () => void }) {
  const [rules, setRules] = useState<HealthRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!node.item_id) return;
    let stale = false;
    lineage
      .healthRules(node.item_id)
      .then((r) => !stale && setRules(r))
      .catch(() => !stale && setRules([]));
    return () => {
      stale = true;
    };
  }, [node.item_id]);
  if (node.kind !== "dataset" || !node.item_id) return <p className="p-3 text-xs text-muted">Health checks apply to datasets.</p>;
  if (!rules) return <p className="p-3 text-xs text-muted">Loading…</p>;
  const set = (i: number, c: Partial<HealthRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...c } : r)));
  return (
    <div className="grid gap-4 p-3 text-xs lg:grid-cols-[1fr_1fr]">
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-semibold text-soft">Monitoring rules</span>
          <Link
            href={`/data-health?add=${encodeURIComponent(`dataset:${node.item_id}`)}&name=${encodeURIComponent(node.name)}`}
            title="Add this dataset's checks to a monitoring view, with alerts to email, PagerDuty or a webhook"
            className="text-ocean hover:underline"
          >
            Alerts in Data Health
          </Link>
          <select
            value=""
            onChange={(e) => {
              const kind = e.target.value as HealthRule["kind"];
              if (kind)
                setRules([
                  ...rules,
                  {
                    kind,
                    enabled: true,
                    ...(kind === "freshness" || kind === "time_since_updated"
                      ? { hours: 24 }
                      : kind === "data_freshness"
                        ? { hours: 24, column: (node.columns ?? []).find((c) => /time|date|_at$/i.test(c)) ?? node.columns?.[0] ?? "" }
                      : kind === "row_count"
                        ? { min: 1 }
                        : kind === "columns"
                          ? { required: [] }
                          : kind === "schema"
                            ? { mode: "additions" as const, columns: (node.columns ?? []).map((c) => ({ name: c, type: "" })) }
                            : {}),
                  },
                ]);
            }}
            className="ml-auto rounded border border-line-2 bg-ink px-1 py-0.5"
          >
            <option value="">+ Add rule…</option>
            {(Object.keys(RULE_LABEL) as HealthRule["kind"][]).map((k) => (
              <option key={k} value={k}>
                {RULE_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {rules.length === 0 && <p className="text-muted">No monitoring rules. Add one to watch this dataset&apos;s freshness, size, schema or builds.</p>}
        {rules.map((r, i) => (
          <div key={i} className="mb-1.5 flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel-2 p-2">
            <input type="checkbox" checked={r.enabled !== false} onChange={(e) => set(i, { enabled: e.target.checked })} className="accent-[var(--color-ocean)]" />
            <span className="text-soft">{RULE_LABEL[r.kind]}</span>
            {r.kind === "data_freshness" && (
              <>
                <select value={r.column ?? ""} onChange={(e) => set(i, { column: e.target.value })} className={`${fieldClass} py-0.5`} title="Timestamp column">
                  {!(node.columns ?? []).includes(r.column ?? "") && <option value={r.column ?? ""}>{r.column || "column…"}</option>}
                  {(node.columns ?? []).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                newest value within
              </>
            )}
            {(r.kind === "freshness" || r.kind === "time_since_updated" || r.kind === "data_freshness") && (
              <>
                <input type="number" min={1} value={r.hours ?? 24} onChange={(e) => set(i, { hours: Number(e.target.value) })} className={`${fieldClass} w-16 py-0.5`} /> hours
              </>
            )}
            {r.kind === "time_since_updated" && (
              <label className="flex items-center gap-1 text-muted">
                <input type="checkbox" checked={!!r.ignore_empty} onChange={(e) => set(i, { ignore_empty: e.target.checked })} className="accent-[var(--color-ocean)]" /> ignore empty transactions
              </label>
            )}
            {r.kind === "schema" && (
              <div className="w-full space-y-1">
                <select value={r.mode ?? "additions"} onChange={(e) => set(i, { mode: e.target.value as "additions" | "exact" })} className={`${fieldClass} py-0.5`}>
                  <option value="additions">Allow additions</option>
                  <option value="exact">Exact match</option>
                </select>
                <textarea
                  rows={3}
                  value={(r.columns ?? []).map((c) => (c.type ? `${c.name}: ${c.type}` : c.name)).join("\n")}
                  onChange={(e) =>
                    set(i, {
                      columns: e.target.value
                        .split("\n")
                        .map((x) => x.trim())
                        .filter(Boolean)
                        .map((x) => {
                          const [name, type] = x.split(":").map((y) => y.trim());
                          return { name, type: type ?? "" };
                        }),
                    })
                  }
                  placeholder={"id: Long\nname: String"}
                  title="One column per line: name: Type (the type is optional)"
                  className={`${inputClass} py-0.5 font-mono`}
                />
              </div>
            )}
            {r.kind === "row_count" && (
              <>
                <input type="number" placeholder="min" value={r.min ?? ""} onChange={(e) => set(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${fieldClass} w-20 py-0.5`} />
                <input type="number" placeholder="max" value={r.max ?? ""} onChange={(e) => set(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${fieldClass} w-20 py-0.5`} />
              </>
            )}
            {r.kind === "columns" && (
              <input
                value={(r.required ?? []).join(", ")}
                placeholder={node.columns?.slice(0, 3).join(", ")}
                onChange={(e) => set(i, { required: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                className={`${inputClass} py-0.5`}
              />
            )}
            <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
              <Icon name="trash" className="h-3 w-3" />
            </button>
          </div>
        ))}
        <ErrorBox message={error} />
        <button
          type="button"
          onClick={async () => {
            setError(null);
            try {
              setRules(await lineage.saveHealthRules(node.item_id!, rules));
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
              onChanged();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className={buttonClass.primary}
        >
          {saved ? "Saved" : "Save rules"}
        </button>
      </div>
      <div>
        <div className="mb-1.5 font-semibold text-soft">Health checks</div>
        {!node.health ? (
          <p className="text-muted">Status: not available (no rules saved).</p>
        ) : (
          node.health.results.map((r, i) => (
            <div key={i} className="mb-1 flex items-start gap-2">
              <Icon name={r.ok ? "check" : "alert"} className={`mt-0.5 h-3.5 w-3.5 ${r.ok ? "text-ok" : "text-bad"}`} />
              <span>
                <span className="text-soft">{RULE_LABEL[r.kind as HealthRule["kind"]]}</span> <span className="text-muted">— {r.message}</span>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Two transactions of a dataset side by side: schema changes, row counts, rows added and removed. */
function DiffDialog({ id, a, b, onClose }: { id: string; a: string; b: string; onClose: () => void }) {
  const [diff, setDiff] = useState<DatasetDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    lineage.diff(id, a, b).then(setDiff, (e: Error) => setError(e.message));
  }, [id, a, b]);
  const table = (rows: Record<string, unknown>[], cls: string) =>
    rows.length ? (
      <div className="max-h-56 overflow-auto rounded border border-line">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-panel text-left text-muted">
            <tr>
              {Object.keys(rows[0]).map((c) => (
                <th key={c} className="px-2 py-1">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`border-t border-line ${cls}`}>
                {Object.values(r).map((v, j) => (
                  <td key={j} className="px-2 py-0.5">
                    {v === null ? "∅" : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p className="text-muted">None.</p>
    );
  return (
    <Modal title="Compare transactions" icon="split" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-xs">
        {error && <p className="text-bad">{error}</p>}
        {!diff && !error && <p className="text-muted">Comparing…</p>}
        {diff && (
          <>
            <p className="text-soft">
              {diff.rows_a.toLocaleString()} → {diff.rows_b.toLocaleString()} rows · <span className="text-ok">+{diff.added.toLocaleString()} added</span> ·{" "}
              <span className="text-bad">−{diff.removed.toLocaleString()} removed</span> (rows compared on {diff.compared_columns.length} shared columns)
            </p>
            <div>
              <div className="mb-1 font-medium text-soft">Schema</div>
              {diff.schema.length ? (
                <ul className="space-y-0.5">
                  {diff.schema.map((c) => (
                    <li key={c.column} className={c.change === "added" ? "text-ok" : c.change === "removed" ? "text-bad" : "text-warn"}>
                      {c.change === "type" ? `~ ${c.column}: ${c.from} → ${c.to}` : `${c.change === "added" ? "+" : "−"} ${c.column} (${c.type})`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">Unchanged.</p>
              )}
            </div>
            <div>
              <div className="mb-1 font-medium text-ok">Added rows{diff.added > diff.added_rows.length ? ` (first ${diff.added_rows.length})` : ""}</div>
              {table(diff.added_rows, "bg-ok/5")}
            </div>
            <div>
              <div className="mb-1 font-medium text-bad">Removed rows{diff.removed > diff.removed_rows.length ? ` (first ${diff.removed_rows.length})` : ""}</div>
              {table(diff.removed_rows, "bg-bad/5")}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
