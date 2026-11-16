"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { datasetHref } from "@/lib/datasetPreview";
import { bytes, when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { modelAssets, trainedModels, type ModelAsset, type TrainedVersion } from "@/lib/modelAssets";
import { AttachmentList, CopyLinkButton, MentionTextarea, ReviewMarkdown } from "@/components/models/ObjectiveShare";
import {
  ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, OBJECTIVE_STATUS, objectiveLink, objectives, type ReviewAttachment,
  type ApiField, type ChecksStatus, type EvalResult, type LibraryRow, type MappedTypes, type ModelLibrary, type Objective, type ObjectiveOverview, type ObjectiveStatus,
  type RelevantItem, type RelevantKind, type Release, type ReviewGate, type Submission, type SubmissionMeta, type SubmissionReview,
} from "@/lib/modelingObjectives";
import { TypeIcon } from "@/components/ontology/Datasources";
import { ontology, type ObjectType } from "@/lib/ontology";

// The Model Library and the pages of one modeling objective (palantir.com/docs/foundry/manage-models): the list of
// objectives with filters, the Objective overview (text, the Modeling objective API with its Ontology mapping, latest
// release, linked resources), the Models section (releases, new and reviewed models) and a submission's own page
// (metrics, model details, reviews). api/modeling_objectives.py

const fullDate = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const modelHref = (s: { model_id?: string | null; source?: string }) => (s.model_id ? (s.source === "container" ? `/container-models?id=${s.model_id}` : `/model-assets/${s.model_id}`) : null);

function StatusBadge({ status }: { status: ObjectiveStatus }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${OBJECTIVE_STATUS[status].tone}`}>{OBJECTIVE_STATUS[status].label}</span>;
}

function EnvTags({ envs }: { envs: string[] }) {
  return (
    <>
      {envs.map((e) => (
        <span key={e} className={`rounded px-1.5 py-0.5 text-xs capitalize ${e === "production" ? "bg-ok/15 text-ok" : "bg-panel-2 text-soft"}`}>{e}</span>
      ))}
    </>
  );
}

export function ReviewMark({ status, className = "h-4 w-4" }: { status: SubmissionMeta["review_status"] | undefined; className?: string }) {
  if (status === "accepted") return <span title="Accepted" className="inline-flex rounded-full bg-ok p-0.5 text-ink"><Icon name="check" className={className.replace("h-4 w-4", "h-3 w-3")} /></span>;
  if (status === "rejected") return <span title="Rejected" className="text-bad"><Icon name="x" className={className} /></span>;
  return null;
}

// ------------------------------------------------------------------------------------------------
// Model Library
// ------------------------------------------------------------------------------------------------

function MappedCell({ side, fields }: { side: MappedTypes | null; fields: number }) {
  if (!side) return <span className="text-muted" title={fields ? `${fields} model field(s), none mapped to the Ontology` : undefined}>-</span>;
  return (
    <div>
      <div className="flex items-center gap-1.5 text-soft">
        <span className="flex gap-1">{side.object_types.slice(0, 3).map((t) => <span key={t.id} title={t.name} className="inline-flex" data-mapped-type={t.id}><TypeIcon t={{ icon: t.icon ?? undefined, color: t.color }} className="h-3 w-3" box="inline-flex rounded p-1" /></span>)}</span>
        {side.object_types.length === 1 && <span className="truncate text-sm">{side.object_types[0].name}</span>}
      </div>
      <div className="mt-0.5 text-xs text-muted">{side.properties} propert{side.properties === 1 ? "y" : "ies"}</div>
    </div>
  );
}

/** The Model Library: every modeling objective with its mapped inputs and outputs, production model, last release
 * and status; search by name, filter by project, input / output object type and status; star an objective. */
export function ModelLibraryView({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const [lib, setLib] = useState<ModelLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [statuses, setStatuses] = useState<ObjectiveStatus[]>([]);
  const load = useCallback(() => { objectives.library().then(setLib, (e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  const rows = useMemo(() => (lib?.objectives ?? []).filter((r) =>
    (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()))
    && (!project || r.project === project)
    && (!input || (r.inputs?.object_types ?? []).some((t) => t.id === input))
    && (!output || (r.outputs?.object_types ?? []).some((t) => t.id === output))
    && (!statuses.length || statuses.includes(r.status))), [lib, q, project, input, output, statuses]);
  if (error) return <ApiError message={error} />;
  if (!lib) return <Loading />;
  const star = async (r: LibraryRow) => {
    setLib({ ...lib, objectives: lib.objectives.map((x) => (x.id === r.id ? { ...x, favorite: !r.favorite } : x)) });
    try {
      await objectives.favorite(r.id, !r.favorite);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-model-library>
      <div className="border-b border-line bg-panel px-8 py-8">
        <h1 className="text-2xl font-semibold">Explore your models</h1>
        <p className="mt-2 text-sm text-soft">
          Modeling objectives are a space to <span className="text-ocean">define modeling problems</span>, <span className="text-ocean">manage developed models</span>, and <span className="text-ocean">deploy to operational applications</span>.
        </p>
        <div className="relative mt-4 max-w-xl">
          <Icon name="search" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by Modeling objective name" className={`${inputClass} pl-9`} data-library-search />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <aside className="w-60 shrink-0 space-y-4 text-xs">
          <div>
            <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Projects</div>
            <select value={project} onChange={(e) => setProject(e.target.value)} className={inputClass} data-filter-project>
              <option value="">Select projects</option>
              {lib.projects.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div className="space-y-2 border-t border-line pt-3">
            <div className="font-semibold uppercase tracking-wide text-muted">Filters</div>
            {([["Input", input, setInput], ["Output", output, setOutput]] as [string, string, (v: string) => void][]).map(([label, value, set]) => (
              <label key={label} className="block text-soft">
                {label}
                <select value={value} onChange={(e) => set(e.target.value)} className={`${inputClass} mt-1`}>
                  <option value="">Select object type</option>
                  {lib.object_types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-soft">Status{statuses.length > 0 && <button type="button" onClick={() => setStatuses([])} className="text-ocean hover:underline">Clear</button>}</div>
            {(Object.keys(OBJECTIVE_STATUS) as ObjectiveStatus[]).map((s) => (
              <label key={s} className="flex gap-2">
                <input type="checkbox" className="mt-0.5" checked={statuses.includes(s)} onChange={(e) => setStatuses(e.target.checked ? [...statuses, s] : statuses.filter((x) => x !== s))} data-filter-status={s} />
                <span><StatusBadge status={s} /><span className="mt-1 block text-muted">{OBJECTIVE_STATUS[s].hint}</span></span>
              </label>
            ))}
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2 text-base font-semibold">Modeling objectives <span className="rounded bg-panel-2 px-2 py-0.5 text-xs font-normal text-soft" data-library-count>{rows.length}</span></div>
          {lib.objectives.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-2 p-10 text-center text-sm text-muted">
              No modeling objectives yet. An objective collects the models that try to solve one problem.
              <div className="mt-3"><button type="button" onClick={onNew} className={buttonClass.primary}><Icon name="plus" className="h-3.5 w-3.5" /> New objective</button></div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line bg-panel">
              <table className="w-full min-w-[56rem] text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted">
                  <tr>{["Name", "Inputs", "Outputs", "Production model", "Last updated", "Status"].map((h) => <th key={h} className="px-3 py-2.5 text-left font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => onOpen(r.id)} className="cursor-pointer border-t border-line hover:bg-panel-2" data-library-row={r.id}>
                      <td className="max-w-xs px-3 py-3">
                        <div className="flex items-center gap-1.5 font-medium text-white">
                          {r.object_type && <span title={`Object type: ${r.object_type.name}`} className="inline-flex shrink-0" data-library-type={r.object_type.id}><TypeIcon t={{ icon: r.object_type.icon ?? undefined, color: r.object_type.color }} className="h-3.5 w-3.5" box="inline-flex rounded p-0.5" /></span>}
                          <span className="truncate">{r.name}</span>
                          {r.required_reviews > 0 && <span title={`Releases need ${r.required_reviews} approving review${r.required_reviews === 1 ? "" : "s"} and no requested changes`} className="inline-flex shrink-0 items-center gap-0.5 rounded bg-panel-2 px-1 text-[10px] font-normal text-soft" data-library-reviews><Icon name="lock" className="h-2.5 w-2.5" />{r.required_reviews}</span>}
                          <button type="button" title={r.favorite ? "Remove from favorites" : "Add to favorites"} onClick={(e) => { e.stopPropagation(); void star(r); }} className={r.favorite ? "text-sand" : "text-line-2 hover:text-sand"} data-library-star>
                            <Icon name="star" className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                          <Icon name="project" className="h-3 w-3 shrink-0" />
                          <span className="truncate">{[r.project, r.description].filter(Boolean).join(" · ") || "No models submitted"}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3"><MappedCell side={r.inputs} fields={r.input_fields} /></td>
                      <td className="px-3 py-3"><MappedCell side={r.outputs} fields={r.output_fields} /></td>
                      <td className="max-w-[14rem] px-3 py-3">
                        {r.model ? (
                          <>
                            <div className="flex items-center gap-1.5 text-soft"><Icon name="cube" className="h-3.5 w-3.5 shrink-0 text-ocean" /><span className="truncate">{r.model.name}</span></div>
                            <div className="mt-0.5 text-xs text-muted">{r.model.release ? `Release ${r.model.release}${r.model.environment === "staging" ? " · staging" : ""}` : "Not released"}</div>
                          </>
                        ) : <span className="text-muted">-</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-soft">{r.last_updated.kind === "released" ? "Released" : "Updated"} {when(r.last_updated.at)}</td>
                      <td className="px-3 py-3"><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-muted">No objective matches the search and filters.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Objective overview
// ------------------------------------------------------------------------------------------------

function SideCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-sm font-semibold">{title}{aside}</div>
      <div className="space-y-3 p-4 text-sm">{children}</div>
    </section>
  );
}

export function ReleaseCard({ release, envs, model, deployments, by }: { release: { version: string; at: string }; envs: string[]; model: string | null; deployments?: number; by?: string | null }) {
  const env = envs.includes("production") ? "production" : envs[0];
  return (
    <div data-release-card>
      <div className="flex flex-wrap items-center gap-2"><Icon name="bolt" className="h-4 w-4 text-soft" /><span className="text-base font-semibold">{release.version}</span><EnvTags envs={envs} /></div>
      <p className="mt-1 text-xs text-muted">Tagged {env ?? "release"} on {fullDate(release.at)}{by ? ` by ${by}` : ""}</p>
      <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-soft">
        <Icon name="cube" className="h-3.5 w-3.5 shrink-0 text-ocean" /><span className="min-w-0 flex-1 truncate">{model ?? "—"}</span>
        {deployments !== undefined && <span className="flex items-center gap-1 text-muted" title="Deployments of this objective"><Icon name="upload" className="h-3.5 w-3.5" />{deployments}</span>}
      </div>
    </div>
  );
}

const RELEVANT: { kind: RelevantKind; title: string; icon: IconName; add: string }[] = [
  { kind: "file", title: "Relevant files", icon: "table", add: "Add a file" },
  { kind: "module", title: "Modules", icon: "grid", add: "Add a Workshop module" },
  { kind: "graph", title: "Graphs", icon: "graph", add: "Add a Vertex graph" },
  { kind: "model", title: "Chained Models", icon: "cube", add: "Add a model" },
];
const relevantHref = (r: RelevantItem) =>
  r.kind === "module" ? `/workshop/${r.id}` : r.kind === "graph" ? `/vertex?graph=${r.id}` : r.kind === "model" ? (r.model_kind === "container" ? `/container-models?id=${r.id}` : `/model-assets/${r.id}`)
    : r.item_kind === "file" && r.name.endsWith(".parquet") ? datasetHref(r.id) : r.item_kind && r.item_kind !== "file" ? `/files/${r.id}` : null;

function ApiTable({ title, fields, editing, types, onMap }: { title: string; fields: ApiField[]; editing: boolean; types: ObjectType[]; onMap: (name: string, target: { object_type_id: string; property: string } | null) => void }) {
  return (
    <div className="rounded-lg border border-line bg-panel" data-api-table={title}>
      <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">{title} ({fields.length})</div>
      {fields.length === 0 ? <p className="p-4 text-xs text-muted">The model declares none.</p> : (
        <table className="w-full text-sm">
          <thead className="bg-panel-2 text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2 text-left font-semibold">Model</th><th className="px-4 py-2 text-left font-semibold">Ontology mapping</th></tr></thead>
          <tbody>
            {fields.map((f) => {
              const t = types.find((x) => x.id === f.mapping?.object_type_id);
              return (
                <tr key={f.name} className="border-t border-line">
                  <td className="px-4 py-3"><span className="text-white">{f.name}</span> <span className="text-muted">• {f.type}</span></td>
                  <td className="px-4 py-3">
                    {editing ? (
                      <div className="flex gap-1">
                        <select value={f.mapping?.object_type_id ?? ""} className={`${inputClass} text-xs`} aria-label={`Object type for ${f.name}`}
                          onChange={(e) => { const nt = types.find((x) => x.id === e.target.value); onMap(f.name, nt && nt.properties.length ? { object_type_id: nt.id, property: (nt.properties.find((p) => p.api_name === f.name) ?? nt.properties[0]).api_name } : null); }}>
                          <option value="">Not mapped</option>
                          {types.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}
                        </select>
                        {t && (
                          <select value={f.mapping?.property ?? ""} className={`${inputClass} text-xs`} aria-label={`Property for ${f.name}`} onChange={(e) => onMap(f.name, { object_type_id: t.id, property: e.target.value })}>
                            {t.properties.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}
                          </select>
                        )}
                      </div>
                    ) : f.mapping ? (
                      <span className="flex items-center gap-2 text-soft" title={`${f.mapping.object_type} · ${f.mapping.property_name}`}>
                        <Icon name="right" className="h-3.5 w-3.5 text-muted" /><span className="inline-flex rounded bg-ocean/20 p-1 text-ocean"><Icon name="cube" className="h-3 w-3" /></span>
                        <span className="truncate">{f.mapping.property_name}</span><span className="text-muted">• {f.mapping.type}</span>
                      </span>
                    ) : <span className="text-muted">Not mapped</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The Objective page: description, overview text (Markdown), the Modeling objective API with its Ontology mapping,
 * and the latest release and linked resources beside it. "Edit overview" edits the text, the mapping and the links. */
export function ObjectiveOverviewView({ objective, canEdit = true, onModels }: { objective: Objective; canEdit?: boolean; onModels: () => void }) {
  const [ov, setOv] = useState<ObjectiveOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [fields, setFields] = useState<{ inputs: ApiField[]; outputs: ApiField[] }>({ inputs: [], outputs: [] });
  const [links, setLinks] = useState<RelevantItem[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [adding, setAdding] = useState<RelevantKind | null>(null);
  const [options, setOptions] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stale = false;
    objectives.overview(objective.id).then((o) => !stale && (setOv(o), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => { stale = true; };
  }, [objective.id, objective.updated_at]);
  const start = () => {
    if (!ov) return;
    setText(ov.overview);
    setFields({ inputs: ov.api.inputs, outputs: ov.api.outputs });
    setLinks(ov.relevant.filter((r) => !r.missing));
    setEditing(true);
    if (!types.length) ontology.objectTypes().then(setTypes, () => setTypes([]));
  };
  const choose = (kind: RelevantKind) => {
    setAdding(kind);
    setOptions(null);
    if (kind === "module") import("@/lib/workshop").then((m) => m.workshop.modules()).then((l) => setOptions(l.map((x) => ({ id: x.id, name: x.name }))), () => setOptions([]));
    if (kind === "graph") import("@/lib/vertex").then((m) => m.vertex.graphs()).then((l) => setOptions(l.map((x) => ({ id: x.id, name: x.name }))), () => setOptions([]));
    if (kind === "model") modelAssets.list().then((l: ModelAsset[]) => setOptions(l.map((x) => ({ id: x.id, name: x.name }))), () => setOptions([]));
  };
  const map = (side: "inputs" | "outputs") => (name: string, target: { object_type_id: string; property: string } | null) => {
    const t = target && types.find((x) => x.id === target.object_type_id);
    const p = t?.properties.find((x) => x.api_name === target?.property);
    setFields((cur) => ({ ...cur, [side]: cur[side].map((f) => (f.name !== name ? f : { ...f, mapping: t && p ? { object_type_id: t.id, object_type: t.display_name, property: p.api_name, property_name: p.display_name || p.api_name, type: p.type } : null })) }));
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const mapping = (list: ApiField[]) => Object.fromEntries(list.filter((f) => f.mapping).map((f) => [f.name, { object_type_id: f.mapping!.object_type_id, property: f.mapping!.property }]));
      setOv(await objectives.saveOverview(objective.id, { overview: text, relevant: links.map((l) => ({ kind: l.kind, id: l.id, name: l.name })), api_mapping: { inputs: mapping(fields.inputs), outputs: mapping(fields.outputs) } }));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!ov) return error ? <ApiError message={error} /> : <Loading />;
  const shown = editing ? links : ov.relevant.filter((r) => !r.missing);
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]" data-objective-overview>
      <div className="min-w-0 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{ov.name}</h1>
          {ov.description && <p className="mt-2 text-soft">{ov.description}</p>}
        </div>
        {error && <p className="whitespace-pre-wrap text-xs text-bad">{error}</p>}
        {editing ? (
          <label className="block text-xs text-muted">
            Overview (Markdown: headings, lists, bold, links)
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} maxLength={20000} className={`${inputClass} mt-1 font-mono text-xs`} data-overview-text />
          </label>
        ) : ov.overview.trim() ? (
          <div className="workshop-markdown max-w-none space-y-3 text-sm leading-6 text-soft [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-white [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-white [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_a]:text-ocean"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(ov.overview) }} data-overview-rendered />
        ) : canEdit && <p className="rounded-lg border border-dashed border-line-2 p-6 text-sm text-muted">No overview yet. Use Edit overview to describe the prediction goal, the data sources and how the production model is used.</p>}
        <div>
          <h2 className="mb-3 text-base font-semibold">Modeling objective API</h2>
          {!ov.api.model ? (
            <p className="rounded-lg border border-dashed border-line-2 p-6 text-sm text-muted">The API is the one of the released model. <button type="button" onClick={onModels} className="text-ocean hover:underline">Submit a model</button> to see its inputs and outputs here.</p>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted">From {ov.api.model.name}{ov.api.model.release ? ` · release ${ov.api.model.release} (${ov.api.model.environment})` : " · not released yet"}. Each model field can be mapped to an Ontology property.</p>
              <div className="grid gap-4 xl:grid-cols-2">
                <ApiTable title="Inputs" fields={editing ? fields.inputs : ov.api.inputs} editing={editing} types={types} onMap={map("inputs")} />
                <ApiTable title="Outputs" fields={editing ? fields.outputs : ov.api.outputs} editing={editing} types={types} onMap={map("outputs")} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex justify-end gap-2">
          {editing ? (
            <>
              <button type="button" onClick={() => setEditing(false)} className={buttonClass.ghost}>Cancel</button>
              <button type="button" disabled={busy} onClick={() => void save()} className={buttonClass.primary} data-overview-save><Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Saving…" : "Save overview"}</button>
            </>
          ) : canEdit && <button type="button" onClick={start} className={buttonClass.secondary} data-overview-edit><Icon name="pencil" className="h-3.5 w-3.5" /> Edit overview</button>}
        </div>
        <SideCard title="Latest release">
          {ov.latest_release ? (
            <button type="button" onClick={onModels} className="block w-full text-left">
              <ReleaseCard release={ov.latest_release} envs={ov.latest_release.environments.length ? ov.latest_release.environments : [ov.latest_release.environment]} model={ov.latest_release.model} deployments={ov.latest_release.deployments} by={ov.latest_release.by} />
            </button>
          ) : <p className="text-xs text-muted">No release yet. Release a submitted model from Models.</p>}
        </SideCard>
        {RELEVANT.map((g) => {
          const items = shown.filter((r) => r.kind === g.kind);
          if (!editing && !items.length) return null;
          return (
            <SideCard key={g.kind} title={g.title} aside={editing ? <button type="button" onClick={() => choose(g.kind)} className="text-xs font-normal text-ocean hover:underline" data-relevant-add={g.kind}>+ Add</button> : undefined}>
              {items.length === 0 && <p className="text-xs text-muted">None linked.</p>}
              {items.map((r) => {
                const href = relevantHref(r);
                return (
                  <div key={`${r.kind}:${r.id}`} className="flex items-start gap-2" data-relevant={r.kind}>
                    <Icon name={g.icon} className="mt-0.5 h-4 w-4 shrink-0 text-ocean" />
                    <div className="min-w-0 flex-1">
                      {href ? <Link href={href} className="block truncate text-ocean hover:underline">{r.name.replace(/\.(parquet|notepad)$/i, "")}</Link> : <span className="block truncate text-soft">{r.name}</span>}
                      {r.path && r.path.length > 0 && <span className="block truncate text-xs text-muted">/{r.path.join("/")}</span>}
                    </div>
                    {editing && <button type="button" onClick={() => setLinks(links.filter((x) => !(x.kind === r.kind && x.id === r.id)))} className="text-muted hover:text-bad" aria-label={`Remove ${r.name}`}>✕</button>}
                  </div>
                );
              })}
              {editing && adding === g.kind && g.kind !== "file" && (
                <select autoFocus defaultValue="" className={`${inputClass} text-xs`} data-relevant-select
                  onChange={(e) => {
                    const o = options?.find((x) => x.id === e.target.value);
                    if (o && !links.some((l) => l.kind === g.kind && l.id === o.id)) setLinks([...links, { kind: g.kind, id: o.id, name: o.name }]);
                    setAdding(null);
                  }}>
                  <option value="">{options ? g.add : "Loading…"}</option>
                  {(options ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
            </SideCard>
          );
        })}
      </div>
      {editing && adding === "file" && (
        <DrivePicker title="Add a relevant file" onClose={() => setAdding(null)}
          onPick={(item) => { if (!links.some((l) => l.kind === "file" && l.id === item.id)) setLinks([...links, { kind: "file", id: item.id, name: item.name, item_kind: item.kind }]); setAdding(null); }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Models: releases and new models
// ------------------------------------------------------------------------------------------------

function ModelRows({ rows, meta, onOpen }: { rows: Submission[]; meta: Record<string, SubmissionMeta>; onOpen: (s: Submission) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <table className="w-full text-sm">
        <thead className="bg-panel-2 text-xs uppercase tracking-wide text-muted">
          <tr>{["Model name", "Model owners", "Size", "Reviews"].map((h) => <th key={h} className="px-4 py-2.5 text-left font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const m = meta[s.id];
            return (
              <tr key={s.id} onClick={() => onOpen(s)} className="cursor-pointer border-t border-line hover:bg-panel-2" data-model-row={s.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 text-white"><Icon name="cube" className="h-3.5 w-3.5 text-ocean" />{s.name}<ReviewMark status={m?.review_status} /></div>
                  <div className="mt-0.5 text-xs text-muted">Submitted {s.submitted_at ? fullDate(s.submitted_at) : "—"}{s.version ? ` · version ${s.version}` : ""}</div>
                </td>
                <td className="px-4 py-3 text-soft">{m?.owner ?? (s.submitted_by && s.submitted_by !== "system" ? s.submitted_by : "—")}</td>
                <td className="px-4 py-3 text-soft">{m?.size_bytes != null ? bytes(m.size_bytes) : "—"}</td>
                <td className="px-4 py-3 text-soft"><span className="inline-flex items-center gap-1.5"><Icon name="comment" className="h-3.5 w-3.5" />{m?.reviews ?? 0}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Models → "Releases and new models": the current releases, the models submitted since the last release and the
 * reviewed models. `all` is the full table (the "All models" tab). */
export function ModelsSection({ objective, meta, deployments, all, onOpen, onHistory, onDeployments, onCompare, onSubmit }: {
  objective: Objective; meta: Record<string, SubmissionMeta>; deployments: number; all: ReactNode;
  onOpen: (s: Submission) => void; onHistory: () => void; onDeployments: () => void; onCompare: () => void; onSubmit: () => void;
}) {
  const [tab, setTab] = useState<"releases" | "all">("releases");
  const live = objective.candidates.filter((c) => !c.archived);
  const releases = objective.releases ?? [];
  const current = (["production", "staging"] as const).map((e) => objective.current_releases?.[e]).filter((r): r is Release => !!r);
  const cards = current.filter((r, i) => current.findIndex((x) => x.submission_id === r.submission_id) === i);
  const released = new Set(releases.map((r) => r.submission_id));
  // new: neither released nor decided on yet (comments alone do not decide); everything else has been reviewed
  const fresh = live.filter((c) => !released.has(c.submission_id ?? "") && !meta[c.id]?.review_status);
  const reviewed = live.filter((c) => !fresh.includes(c));
  return (
    <div data-models-section>
      <h1 className="text-xl font-semibold">Models</h1>
      <div className="mt-3 flex gap-5 border-b border-line text-sm">
        {([["releases", "Releases and new models"], ["all", `All models (${live.length})`]] as const).map(([t, label]) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 pb-2 ${tab === t ? "border-ocean text-ocean" : "border-transparent text-soft hover:text-white"}`} data-models-tab={t}>{label}</button>
        ))}
      </div>
      {tab === "all" ? <div className="mt-5">{all}</div> : (
        <div className="mt-6 space-y-8">
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">Releases</h2><span className="text-muted">·</span>
              <button type="button" onClick={onHistory} className="text-sm text-soft hover:text-ocean hover:underline">See release history</button>
              {deployments > 0 && (
                <span className="ml-auto flex items-center gap-2 rounded bg-ocean/15 px-3 py-1.5 text-sm text-soft"><Icon name="upload" className="h-4 w-4 text-ocean" />{deployments} deployment{deployments === 1 ? " is" : "s are"} on this objective
                  <button type="button" onClick={onDeployments} className="text-ocean hover:underline">View</button></span>
              )}
            </div>
            {cards.length === 0 ? <p className="rounded-lg border border-dashed border-line-2 p-6 text-sm text-muted">No release yet. Open a model below and create a release from it.</p> : (
              <div className="flex flex-wrap gap-4">
                {cards.map((r) => (
                  <button key={r.id} type="button" className="w-80 rounded-lg border border-line bg-panel p-4 text-left hover:border-ocean"
                    onClick={() => { const s = objective.candidates.find((c) => c.submission_id === r.submission_id); if (s) onOpen(s); }}>
                    <ReleaseCard release={{ version: r.version, at: r.created_at }} envs={(["staging", "production"] as const).filter((e) => objective.current_releases?.[e]?.submission_id === r.submission_id)} model={r.model} deployments={deployments} />
                  </button>
                ))}
              </div>
            )}
          </section>
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">New models since last release</h2><span className="text-muted">·</span>
              <button type="button" onClick={onCompare} className="flex items-center gap-1.5 text-sm text-ocean hover:underline"><Icon name="split" className="h-3.5 w-3.5" />Compare models with active releases</button>
            </div>
            {fresh.length ? <ModelRows rows={fresh} meta={meta} onOpen={onOpen} /> : (
              <p className="rounded-lg border border-dashed border-line-2 p-6 text-sm text-muted">No new models. <button type="button" onClick={onSubmit} className="text-ocean hover:underline">Submit a model</button> to review, release and deploy it.</p>
            )}
          </section>
          <section>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-base font-semibold">Reviewed models</h2><span className="text-muted">·</span>
              <button type="button" onClick={() => setTab("all")} className="text-sm text-soft hover:text-ocean hover:underline">See all models</button>
            </div>
            {reviewed.length ? <ModelRows rows={reviewed} meta={meta} onOpen={onOpen} /> : <p className="text-sm text-muted">No model has been reviewed or released yet.</p>}
          </section>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// one submission: metrics, model details, reviews
// ------------------------------------------------------------------------------------------------

function Rail({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between border-b border-line pb-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}{aside}</div>
      <div className="mt-2 space-y-2 text-sm">{children}</div>
    </div>
  );
}

/** The objective's review requirement for a submission: approvals so far against the number required, and requested
 * changes that block the release. */
export function ReviewGateLine({ gate }: { gate: ReviewGate }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs ${gate.met ? "text-ok" : "text-warn"}`} title={gate.message ?? "The review requirement is met"} data-review-gate={gate.met ? "met" : "unmet"}>
      <Icon name={gate.met ? "check" : "lock"} className="h-3 w-3 shrink-0" />
      <span>{gate.approvals} of {gate.required} approving review{gate.required === 1 ? "" : "s"}{gate.rejections ? ` · ${gate.rejections} requested changes` : ""}</span>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 py-1.5 text-sm"><span className="text-muted">{label}</span><span className="min-w-0 text-soft">{children}</span></div>;
}

/** A submission's page: Metrics (automatic evaluation and recorded evaluations), Model details (architecture,
 * dependencies, developer metadata) and Reviews (comment, accept, reject), with releases and reviewers beside it. */
export function SubmissionDetail({ objective, submission, meta, checksStatus, checks, onBack, onChange, onRelease, onArchive, focusReview }: {
  objective: Objective; submission: Submission; meta: SubmissionMeta | undefined; checksStatus: ChecksStatus[string] | undefined; checks: ReactNode;
  onBack: () => void; onChange: (o: Objective) => void; onRelease: () => void; onArchive: () => void;
  /** a review opened from its link: the Reviews tab, scrolled to and highlighted */
  focusReview?: string | null;
}) {
  const [tab, setTab] = useState<"metrics" | "details" | "reviews">(focusReview ? "reviews" : "metrics");
  const [notified, setNotified] = useState<string | null>(null);
  useEffect(() => {
    if (!focusReview || tab !== "reviews") return;
    const el = document.querySelector(`[data-review-id="${CSS.escape(focusReview)}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [focusReview, tab]);
  const [results, setResults] = useState<EvalResult[] | null>(null);
  const [version, setVersion] = useState<TrainedVersion | null>(null);
  const [text, setText] = useState("");
  const [action, setAction] = useState<SubmissionReview["action"]>("comment");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [preview, setPreview] = useState(false);
  const [files, setFiles] = useState<ReviewAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const reviews = useMemo(() => submission.reviews ?? [], [submission.reviews]);
  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setErr(null);
    setUploading(true);
    const added: ReviewAttachment[] = [];
    try {
      for (const f of Array.from(list).slice(0, 5 - files.length)) {
        if (f.size > ATTACHMENT_MAX_BYTES) throw new Error(`${f.name} is larger than 10 MB`);
        added.push(await objectives.uploadAttachment(objective.id, f));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setFiles((cur) => [...cur, ...added]);
      setUploading(false);
    }
  };
  const href = modelHref(submission);
  useEffect(() => {
    let stale = false;
    objectives.evaluation(objective.id).then((d) => !stale && setResults(d.results.filter((r) => r.candidate_id === submission.id)), () => !stale && setResults([]));
    if (submission.model_id && submission.source !== "container")
      trainedModels.get(submission.model_id).then((m) => !stale && setVersion(m.versions_detail.find((v) => v.id === submission.model_version_id) ?? null), () => undefined);
    return () => { stale = true; };
  }, [objective.id, submission.id, submission.model_id, submission.model_version_id, submission.source]);
  const releases = (objective.releases ?? []).filter((r) => r.submission_id === submission.submission_id);
  const reviewers = useMemo(() => {
    const latest = new Map<string, SubmissionReview>();
    for (const r of reviews) if (r.action !== "comment" || !latest.has(r.by)) latest.set(r.by, r);
    return [...latest.values()];
  }, [reviews]);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const o = await objectives.review(objective.id, submission.id, action, text, files.map((f) => f.id));
      const mine = o.candidates.find((c) => c.id === submission.id)?.reviews?.at(-1);
      setNotified(mine?.mentions?.length ? `${mine.notified ?? 0} ${mine.notified === 1 ? "person was" : "people were"} notified of the tags` : null);
      onChange(o);
      setText("");
      setFiles([]);
      setPreview(false);
      setAction("comment");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const metricRows = (results ?? []).filter((r) => r.status === "succeeded" && r.subsets?.Overall);
  const gate = submission.review_gate;
  return (
    <div data-submission-detail={submission.id}>
      <div className="flex flex-wrap items-start gap-3">
        <button type="button" onClick={onBack} className="mt-1 text-muted hover:text-white" aria-label="Back to models"><Icon name="left" className="h-4 w-4" /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-base font-semibold"><Icon name="cube" className="h-4 w-4 text-ocean" />{submission.name}<ReviewMark status={meta?.review_status} /></div>
          <p className="mt-0.5 text-xs text-muted">Submitted {submission.submitted_at ? fullDate(submission.submitted_at) : "—"} · Model owner: {meta?.owner ?? "—"}{submission.archived ? " · archived" : ""}</p>
        </div>
        {!submission.archived && submission.model_id && (
          <div className="flex flex-col items-end gap-1">
            <button type="button" onClick={onRelease} disabled={gate ? !gate.met : false} title={gate?.message ?? undefined} className={`${buttonClass.secondary} disabled:cursor-not-allowed disabled:opacity-50`} data-create-release><Icon name="bolt" className="h-3.5 w-3.5 text-ok" /> Create new release</button>
            {gate && gate.required > 0 && <ReviewGateLine gate={gate} />}
          </div>
        )}
        <CopyLinkButton href={objectiveLink({ id: objective.id, model: submission.id })} label="Copy link" />
        <div className="relative">
          <button type="button" onClick={() => setMenu((m) => !m)} className={buttonClass.ghost}>Actions <Icon name="down" className="h-3 w-3" /></button>
          {menu && (
            <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-lg border border-line bg-panel p-1 text-sm shadow-xl" onClick={() => setMenu(false)}>
              {href && <Link href={href} className="block rounded px-3 py-1.5 text-soft hover:bg-panel-2 hover:text-white">Open the model</Link>}
              <button type="button" onClick={onArchive} className="block w-full rounded px-3 py-1.5 text-left text-soft hover:bg-panel-2 hover:text-white">{submission.archived ? "Restore from the archive" : "Archive this model"}</button>
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex gap-5 border-b border-line text-sm">
        {([["metrics", "Metrics"], ["details", "Model details"], ["reviews", "Reviews"]] as const).map(([t, label]) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2 ${tab === t ? "border-ocean text-ocean" : "border-transparent text-soft hover:text-white"}`} data-submission-tab={t}>
            {label}{t === "reviews" && <span className="rounded bg-panel-2 px-1.5 text-xs text-soft">{reviews.length}</span>}
          </button>
        ))}
      </div>
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0 space-y-4">
          {tab === "metrics" && (
            results === null ? <Loading /> : metricRows.length === 0 && !submission.evaluations.length ? (
              <div className="rounded-lg border border-line bg-panel px-6 py-16 text-center">
                <Icon name="graph" className="mx-auto h-12 w-12 text-line-2" />
                <p className="mt-4 font-semibold">Metrics have not been configured for this model</p>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted">View numerical statistics and charts to evaluate the performance of this model. Configure an evaluation dataset and library in Comparisons, then build it.</p>
              </div>
            ) : (
              <>
                {metricRows.map((r) => (
                  <div key={r.id} className="rounded-lg border border-line bg-panel" data-metrics={r.id}>
                    <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">{r.dataset}{r.library ? ` · ${r.library}` : ""} <span className="font-normal text-muted">· built {when(r.built_at)} · {r.subsets!.Overall.rows} rows</span></div>
                    <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
                      {Object.entries(r.subsets!.Overall.metrics).map(([k, v]) => (
                        <div key={k} className="bg-panel px-4 py-3"><div className="text-xs text-muted">{k}</div><div className="mt-0.5 text-base text-white">{v == null ? "—" : Number.isInteger(v) ? v : v.toFixed(4)}</div></div>
                      ))}
                    </div>
                  </div>
                ))}
                {submission.evaluations.length > 0 && (
                  <div className="rounded-lg border border-line bg-panel">
                    <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Recorded evaluations</div>
                    {submission.evaluations.map((e) => <div key={e.id} className="flex justify-between border-t border-line px-4 py-2 text-sm first:border-t-0"><span className="text-soft">{e.metric} <span className="text-muted">{when(e.evaluated_at)}</span></span><span className={e.passed ? "text-ok" : "text-bad"}>{e.value}</span></div>)}
                  </div>
                )}
              </>
            )
          )}
          {tab === "details" && (
            <>
              <div className="rounded-lg border border-line bg-panel">
                <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Architecture</div>
                <div className="px-4 py-2">
                  <Detail label="Model">{href ? <Link href={href} className="text-ocean hover:underline">{submission.name}</Link> : submission.name}</Detail>
                  <Detail label="Model version">{submission.version || "—"}{version ? ` · published ${fullDate(version.created_at)}` : ""}</Detail>
                  <Detail label="Date submitted">{submission.submitted_at ? fullDate(submission.submitted_at) : "—"}</Detail>
                  <Detail label="File size">{meta?.size_bytes != null ? bytes(meta.size_bytes) : "—"}</Detail>
                  <Detail label="Model adapter">{submission.adapter?.class ? `${String(submission.adapter.module ?? "")}.${String(submission.adapter.class)}` : submission.source === "container" ? "Container model" : "—"}</Detail>
                  {version?.serializers && <Detail label="Serialization">{Object.entries(version.serializers).map(([k, v]) => `${k}: ${v}`).join(", ")}</Detail>}
                </div>
              </div>
              <div className="rounded-lg border border-line bg-panel">
                <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Model dependencies</div>
                <div className="px-4 py-3 text-sm text-soft">
                  {version?.training_datasets.length ? version.training_datasets.map((d) => <Link key={d.item_id} href={datasetHref(d.item_id)} className="mr-3 text-ocean hover:underline">{d.name}</Link>) : "No dataset inputs are recorded for this model version."}
                </div>
              </div>
              <div className="rounded-lg border border-line bg-panel">
                <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Developer Metadata</div>
                <div className="px-4 py-2">
                  <Detail label="Repository">{version?.source.repo_id ? <Link href={`/code-repositories/${version.source.repo_id}`} className="text-ocean hover:underline">{version.source.repo}</Link> : version?.source.repo ?? "—"}</Detail>
                  {version?.source.transform && <Detail label="Transform"><span className="break-all font-mono text-xs">{version.source.transform}</span></Detail>}
                  {Object.entries(submission.metadata ?? {}).map(([k, v]) => <Detail key={k} label={(objective.metadata_fields ?? []).find((f) => f.id === k)?.name ?? k}>{String(v)}</Detail>)}
                </div>
              </div>
            </>
          )}
          {tab === "reviews" && (
            <>
              {reviews.map((r) => (
                <div key={r.id} className={`scroll-mt-4 rounded-lg border bg-panel p-4 ${r.id === focusReview ? "border-ocean ring-1 ring-ocean/50" : "border-line"}`} data-review={r.action} data-review-id={r.id}>
                  <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium text-white">{r.by_name}</span><span className="text-xs text-muted">{fullDate(r.at)}</span>
                    {r.action !== "comment" && <span className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${r.action === "accept" ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"}`}><Icon name={r.action === "accept" ? "check" : "x"} className="h-3 w-3" />{r.action === "accept" ? "Accepted" : "Rejected"}</span>}
                    <CopyLinkButton href={objectiveLink({ id: objective.id, model: submission.id, review: r.id })} label="Copy link to this review" compact className="ml-auto text-muted hover:text-white" /></div>
                  {r.text && <div className="mt-2"><ReviewMarkdown text={r.text} mentions={r.mentions} /></div>}
                  <AttachmentList objectiveId={objective.id} items={r.attachments ?? []} />
                </div>
              ))}
              {!submission.archived && (
                <div className="max-w-xl rounded-lg border border-line bg-panel" data-add-review>
                  <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold"><Icon name="comment" className="h-4 w-4 text-muted" />Add a review</div>
                  <div className="space-y-3 p-4">
                    <div className="flex gap-3 text-xs">
                      {([["write", "Write"], ["preview", "Preview"]] as const).map(([m, label]) => (
                        <button key={m} type="button" onClick={() => setPreview(m === "preview")} className={(m === "preview") === preview ? "text-ocean" : "text-muted hover:text-white"} data-review-mode={m}>{label}</button>
                      ))}
                      <span className="ml-auto text-muted">Markdown: **bold**, *italic*, - lists, [links](https://…), @ to tag</span>
                    </div>
                    {preview ? (
                      <div className="min-h-[7.5rem] rounded-md border border-line-2 px-3 py-2" data-review-preview>{text.trim() ? <ReviewMarkdown text={text} /> : <p className="text-xs text-muted">Nothing to preview.</p>}</div>
                    ) : <MentionTextarea objectiveId={objective.id} value={text} onChange={(v) => { setText(v); setNotified(null); }} />}
                    <div className="space-y-1">
                      {files.map((a) => (
                        <div key={a.id} className="flex items-center gap-2 text-xs text-soft" data-pending-attachment={a.id}>
                          <Icon name={a.content_type.startsWith("image/") ? "image" : "doc"} className="h-3.5 w-3.5 text-ocean" />{a.name}<span className="text-muted">{bytes(a.size)}</span>
                          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setFiles(files.filter((x) => x.id !== a.id))} className="text-muted hover:text-bad"><Icon name="x" className="h-3 w-3" /></button>
                        </div>
                      ))}
                      <label className={`${buttonClass.ghost} cursor-pointer text-xs ${files.length >= 5 || uploading ? "pointer-events-none opacity-40" : ""}`} title="Images, PDFs and text files up to 10 MB (5 per review)">
                        <Icon name="plus" className="h-3.5 w-3.5" />{uploading ? "Uploading…" : "Attach files"}
                        <input type="file" multiple accept={ATTACHMENT_ACCEPT} className="hidden" data-review-file onChange={(e) => { void attach(e.target.files); e.target.value = ""; }} />
                      </label>
                    </div>
                    {([["comment", "Leave comment", "Submit general feedback without explicit approval"], ["accept", "Accept", "Approve this model to be tagged as a release"], ["reject", "Reject", "Reject this model"]] as const).map(([a, label, hint]) => (
                      <label key={a} className="flex gap-2 text-sm"><input type="radio" name="review-action" className="mt-1" checked={action === a} onChange={() => setAction(a)} /><span>{label}<span className="block text-xs text-muted">{hint}</span></span></label>
                    ))}
                    {err && <p className="text-xs text-bad">{err}</p>}
                    <div className="flex items-center justify-end gap-3">
                      {notified && <span className="text-xs text-ok" data-review-notified>{notified}</span>}
                      <button type="button" disabled={busy} onClick={() => void submit()} className={buttonClass.primary} data-review-submit>{busy ? "Submitting…" : "Submit"}</button>
                    </div>
                  </div>
                </div>
              )}
              <div>
                <h3 className="mb-2 text-sm font-semibold">Checks{checksStatus ? <span className="ml-2 font-normal text-muted">{checksStatus.overall === "none" ? "none configured" : checksStatus.overall}</span> : null}</h3>
                {checks}
              </div>
            </>
          )}
        </div>
        <div className="space-y-5">
          <Rail title="Releases">
            {releases.length ? releases.slice(-4).reverse().map((r) => <div key={r.id} className="flex items-center gap-2 text-soft"><Icon name="bolt" className="h-3.5 w-3.5" />{r.version}<EnvTags envs={[r.environment]} /></div>) : <p className="text-soft">No releases</p>}
          </Rail>
          <Rail title="Reviews" aside={<ReviewMark status={meta?.review_status} className="h-3.5 w-3.5" />}>
            {gate && gate.required > 0 && <ReviewGateLine gate={gate} />}
            {reviewers.length ? reviewers.map((r) => <div key={r.by} className="flex items-center justify-between text-soft">{r.by_name}{r.action === "accept" ? <Icon name="check" className="h-3.5 w-3.5 text-ok" /> : r.action === "reject" ? <Icon name="x" className="h-3.5 w-3.5 text-bad" /> : <Icon name="comment" className="h-3.5 w-3.5 text-muted" />}</div>) : <p className="text-soft">No reviews</p>}
          </Rail>
          <Rail title="Model details">
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"><span className="text-muted">Submission name</span><span className="break-words text-soft">{submission.name}</span></div>
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"><span className="text-muted">Model</span>{href ? <Link href={href} className="break-words text-ocean hover:underline">{submission.name} {submission.version}</Link> : <span className="text-warn">Record only</span>}</div>
          </Rail>
        </div>
      </div>
    </div>
  );
}
