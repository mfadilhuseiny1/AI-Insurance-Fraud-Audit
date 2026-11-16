"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { LocationField, missingText, type PickedLocation } from "@/components/LocationField";
import { DeploymentPanel } from "@/components/models/DeploymentPanel";
import { ObjectiveEvaluation } from "@/components/models/ObjectiveEvaluation";
import { ModelLibraryView, ModelsSection, ObjectiveOverviewView, ReviewGateLine, SubmissionDetail } from "@/components/models/ObjectivePages";
import { CopyLinkButton, NoAccessPanel, ProjectSelect, ShareObjectiveDialog } from "@/components/models/ObjectiveShare";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { modelAssets, type ModelAsset, type ModelAssetDetail } from "@/lib/modelAssets";
import type { Deployment } from "@/lib/modelDeployments";
import {
  CANDIDATE_STATUS_LABEL, modelingObjectivesApi, objectiveLink, objectives,
  type CheckEvaluation, type ChecksStatus, type CheckState, type EvalDashboard, type Environment, type MetadataField, type Objective, type ObjectiveCheck, type ObjectiveInput, type Submission, type SubmissionMeta,
} from "@/lib/modelingObjectives";

const emptyObjective: ObjectiveInput = { name: "", description: "", success_metric: "Accuracy", metric_direction: "maximize", threshold: null, ontology_object_type_id: null };
const CHECK_TONE: Record<string, string> = { approved: "text-ok", rejected: "text-bad", pending: "text-warn", none: "text-muted" };
const CHECK_LABEL: Record<string, string> = { approved: "Passed", rejected: "Rejected", pending: "Pending", none: "No checks" };

/** Modeling Objectives (palantir.com/docs/foundry/manage-models): submissions of model versions, checks, staging and
 *  production releases, live and batch deployments that run, and the evaluation dashboard.
 *  api/modeling_objectives.py, api/model_deployments.py, api/model_evaluation.py */
export default function ModelingObjectivesPage() {
  return (
    <Suspense fallback={null}>
      <Objectives />
    </Suspense>
  );
}

type View = "objective" | "models" | "comparisons" | "deployments" | "settings" | "releases";
const NAV: { view: View; label: string; icon: "list" | "split" | "upload" | "sliders" | "cube" }[] = [
  { view: "objective", label: "Objective", icon: "list" },
  { view: "models", label: "Models", icon: "cube" },
  { view: "comparisons", label: "Comparisons", icon: "split" },
  { view: "deployments", label: "Deployments", icon: "upload" },
  { view: "settings", label: "Settings", icon: "sliders" },
];

function Objectives() {
  const router = useRouter();
  const params = useSearchParams();
  const [items, setItems] = useState<Objective[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?new=1 (Files & Projects → New): open the creation dialog
  const [creating, setCreating] = useState(() => params.get("new") === "1");
  const [checks, setChecks] = useState<ChecksStatus>({});
  const [meta, setMeta] = useState<Record<string, SubmissionMeta>>({});
  const [deployments, setDeployments] = useState(0);
  const [favorite, setFavorite] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [releasing, setReleasing] = useState<Submission | null>(null);
  // a link from an access-request notification opens the Share dialog (?share=1)
  const [sharing, setSharing] = useState(() => params.get("share") === "1");
  const load = useCallback(() => { objectives.list().then(setItems, (e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  const id = params.get("id");
  const view = (NAV.some((n) => n.view === params.get("view")) || params.get("view") === "releases" ? params.get("view") : "objective") as View;
  const objective = items?.find((o) => o.id === id) ?? null;
  const submission = objective?.candidates.find((c) => c.id === params.get("model")) ?? null;
  const go = (next: { view?: View; model?: string | null }) => {
    const q = new URLSearchParams({ id: id ?? "", view: next.view ?? view });
    if (next.model) q.set("model", next.model);
    router.replace(`/modeling-objectives?${q}`);
  };
  // checks, per-model meta, deployments and the star reload with the objective and after every change (tick)
  const [tick, setTick] = useState(0);
  const loadChecks = () => setTick((t) => t + 1);
  useEffect(() => {
    if (!id) return;
    let stale = false;
    objectives.checksStatus(id).then((v) => !stale && setChecks(v), () => !stale && setChecks({}));
    objectives.modelsMeta(id).then((v) => !stale && setMeta(v), () => !stale && setMeta({}));
    objectives.deployments(id).then((d) => !stale && setDeployments(d.length), () => !stale && setDeployments(0));
    objectives.overview(id).then((o) => !stale && setFavorite((f) => ({ ...f, [o.id]: o.favorite })), () => undefined);
    return () => { stale = true; };
  }, [id, items, tick]);
  const replace = (o: Objective) => setItems((list) => (list ?? []).map((x) => (x.id === o.id ? o : x)));
  if (error) return <ApiError message={error} />;
  if (!items) return <Loading />;
  if (!id || !objective) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AppHeader app="Model Library" icon="layers" href="/modeling-objectives">
          <Link href="/model-assets" className={buttonClass.ghost}><Icon name="cube" className="h-3.5 w-3.5" /> Models</Link>
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary} data-new-objective><Icon name="plus" className="h-3.5 w-3.5" /> New objective</button>
        </AppHeader>
        {id && !objective ? <NoAccessPanel objectiveId={id} />
          : <ModelLibraryView onOpen={(oid) => router.push(`/modeling-objectives?id=${oid}`)} onNew={() => setCreating(true)} />}
        {creating && <CreateObjective onClose={() => setCreating(false)} onCreated={(o) => { setCreating(false); load(); router.push(`/modeling-objectives?id=${o.id}`); }} />}
      </div>
    );
  }
  const starred = favorite[objective.id] ?? false;
  // viewers open and review; editors also submit, edit, release and deploy; owners also share, move and delete
  const canEdit = !objective.my_role || objective.my_role !== "viewer";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Model Library" icon="layers" href="/modeling-objectives" crumbs={[{ label: objective.name }]}>
        <button type="button" title={starred ? "Remove from favorites" : "Add to favorites"} className={starred ? "text-sand" : "text-muted hover:text-sand"} data-objective-star
          onClick={() => { setFavorite({ ...favorite, [objective.id]: !starred }); objectives.favorite(objective.id, !starred).catch(() => setFavorite({ ...favorite, [objective.id]: starred })); }}>
          <Icon name="star" className="h-4 w-4" />
        </button>
        <CopyLinkButton href={objectiveLink({ id: objective.id })} />
        <button type="button" onClick={() => setSharing(true)} className={buttonClass.secondary} data-share-objective title={objective.project?.name ? `In the Project ${objective.project.name}` : undefined}><Icon name="lock" className="h-3.5 w-3.5" /> Share</button>
        {canEdit && <button type="button" onClick={() => setSubmitting(true)} className={buttonClass.primary} data-submit-model><Icon name="upload" className="h-3.5 w-3.5" /> Submit model</button>}
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-line bg-panel p-3">
          {NAV.map((n) => {
            const on = n.view === view || (n.view === "models" && view === "releases");
            return (
              <button key={n.view} type="button" onClick={() => go({ view: n.view })} data-objective-nav={n.view}
                className={`flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm ${on ? "bg-ocean/20 text-ocean" : "text-soft hover:bg-panel-2 hover:text-white"}`}>
                <Icon name={n.icon} className="h-4 w-4" />{n.label}
              </button>
            );
          })}
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl p-6">
            {view === "objective" && <ObjectiveOverviewView objective={objective} canEdit={canEdit} onModels={() => go({ view: "models" })} />}
            {view === "models" && (submission ? (
              <SubmissionDetail key={submission.id} objective={objective} submission={submission} meta={meta[submission.id]} checksStatus={checks[submission.id]} focusReview={params.get("review")}
                checks={<ChecksPanel objective={objective} submission={submission} states={checks[submission.id]?.checks ?? {}} onChange={(o) => { replace(o); loadChecks(); }} />}
                onBack={() => go({ view: "models" })} onChange={(o) => { replace(o); loadChecks(); }} onRelease={() => setReleasing(submission)}
                onArchive={() => { objectives.archive(objective.id, submission.id, !!submission.archived).then((o) => { replace(o); go({ view: "models" }); }, (e: Error) => setError(e.message)); }} />
            ) : (
              <>
              {params.get("model") && <p className="mb-4 rounded-md border border-line bg-panel px-4 py-2 text-sm text-muted" data-model-missing>The model this link points to is not in this objective (any more).</p>}
              <ModelsSection objective={objective} meta={meta} deployments={deployments} onOpen={(s) => go({ view: "models", model: s.id })} onHistory={() => go({ view: "releases" })}
                onDeployments={() => go({ view: "deployments" })} onCompare={() => go({ view: "comparisons" })} onSubmit={() => setSubmitting(true)}
                all={<ModelsTab objective={objective} checks={checks} onChange={(o) => { replace(o); loadChecks(); }} />} />
              </>
            ))}
            {view === "releases" && (
              <div className="space-y-4">
                <button type="button" onClick={() => go({ view: "models" })} className="flex items-center gap-1.5 text-sm text-soft hover:text-white"><Icon name="left" className="h-3.5 w-3.5" /> Models</button>
                <h1 className="text-xl font-semibold">Release history</h1>
                <ReleasesTab objective={objective} onChange={replace} />
              </div>
            )}
            {view === "comparisons" && <ObjectiveEvaluation objectiveId={objective.id} objective={objective} meta={meta} onChanged={() => { load(); loadChecks(); }} />}
            {view === "deployments" && <DeploymentsTab objective={objective} />}
            {view === "settings" && <SettingsTab objective={objective} onChange={replace} onDeleted={() => { router.replace("/modeling-objectives"); load(); }} />}
          </div>
        </main>
      </div>
      {submitting && <SubmitModel objective={objective} onClose={() => setSubmitting(false)} onSubmitted={(o) => { setSubmitting(false); replace(o); loadChecks(); go({ view: "models" }); }} />}
      {releasing && <ReleaseModal objective={objective} submission={releasing} onClose={() => setReleasing(null)} onReleased={(o) => { setReleasing(null); replace(o); loadChecks(); }} />}
      {creating && <CreateObjective onClose={() => setCreating(false)} onCreated={(o) => { setCreating(false); load(); router.push(`/modeling-objectives?id=${o.id}`); }} />}
      {sharing && <ShareObjectiveDialog objectiveId={objective.id} onClose={() => setSharing(false)} onSaved={load} />}
    </div>
  );
}

function CreateObjective({ onClose, onCreated }: { onClose: () => void; onCreated: (o: { id: string }) => void }) {
  const [draft, setDraft] = useState<ObjectiveInput>(emptyObjective);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="New modeling objective" icon="layers" onClose={onClose}>
      <form className="space-y-3 p-5 text-sm" onSubmit={async (e) => { e.preventDefault(); try { onCreated(await modelingObjectivesApi.create(draft)); } catch (x) { setErr((x as Error).message); } }}>
        <label className="block text-xs text-muted">Name<input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${inputClass} mt-1`} /></label>
        <label className="block text-xs text-muted">The problem this objective solves<textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={3} className={`${inputClass} mt-1`} /></label>
        <label className="block text-xs text-muted">Headline metric<input value={draft.success_metric} onChange={(e) => setDraft({ ...draft, success_metric: e.target.value })} className={`${inputClass} mt-1`} /></label>
        <label className="block text-xs text-muted">Save in Project
          <ProjectSelect value={draft.project_id ?? ""} onChange={(v) => setDraft({ ...draft, project_id: v || null })} />
          <span className="mt-1 block">The Project&apos;s roles apply to the objective, and review attachments are stored there. Share it with more people from the objective.</span>
        </label>
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button><button type="submit" disabled={!draft.name.trim() || !draft.success_metric.trim()} className={buttonClass.primary}>Create</button></div>
      </form>
    </Modal>
  );
}

// -- models -------------------------------------------------------------------------------------------------------

function ModelsTab({ objective, checks, onChange }: { objective: Objective; checks: ChecksStatus; onChange: (o: Objective) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [archive, setArchive] = useState(false);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<Submission | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const active = (objective.checks ?? []).filter((c) => !c.archived);
  const rows = objective.candidates.filter((c) => !!c.archived === archive).filter((c) => !filter || (checks[c.id]?.overall ?? "none") === filter);
  const run = async (fn: () => Promise<Objective>) => { setErr(null); try { onChange(await fn()); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-line text-xs">
          <button type="button" onClick={() => setArchive(false)} className={`px-3 py-1.5 ${!archive ? "bg-panel-2 text-white" : "text-muted"}`}>All models</button>
          <button type="button" onClick={() => setArchive(true)} className={`px-3 py-1.5 ${archive ? "bg-panel-2 text-white" : "text-muted"}`}>Archive ({objective.candidates.filter((c) => c.archived).length})</button>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={`${inputClass} w-auto text-xs`}>
          <option value="">Any check status</option><option value="approved">Checks passed</option><option value="pending">Checks pending</option><option value="rejected">Checks rejected</option>
        </select>
        <button type="button" onClick={() => setSubmitting(true)} className={`${buttonClass.primary} ml-auto`}><Icon name="upload" className="h-3.5 w-3.5" /> Submit model</button>
      </div>
      {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
      {rows.length === 0 ? <p className="rounded-xl border border-dashed border-line-2 p-8 text-center text-sm text-muted">{archive ? "No archived models." : "No models submitted. Submit a version of a model resource to evaluate, review, release and deploy it."}</p> : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-xs text-muted"><tr>{["Model", "Version", "Submitted", "Status", "Checks", ""].map((h) => <th key={h} className="px-3 py-2 text-left font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((c) => {
                const st = checks[c.id]?.overall ?? "none";
                return (
                  <Fragment key={c.id}>
                    <tr className="border-t border-line bg-panel">
                      <td className="px-3 py-2">
                        <div className="text-white">{c.name}</div>
                        {c.model_id ? <Link href={c.source === "container" ? `/container-models?id=${c.model_id}` : `/model-assets/${c.model_id}`} className="text-xs text-ocean hover:underline">Open model</Link>
                          : <span className="text-xs text-warn" title="An older record that names no model version: it cannot be evaluated automatically or deployed">Record only</span>}
                      </td>
                      <td className="px-3 py-2 text-soft">{c.version}</td>
                      <td className="px-3 py-2 text-xs text-muted">{c.submitted_at ? when(c.submitted_at) : "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        {(c.released_in ?? []).length ? (c.released_in ?? []).map((e) => <span key={e} className={`mr-1 rounded px-1.5 py-0.5 ${e === "production" ? "bg-ok/15 text-ok" : "bg-ocean/15 text-ocean"}`}>{e}</span>) : <span className="text-muted">{CANDIDATE_STATUS_LABEL[c.status] ?? c.status}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs"><button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} className={`${CHECK_TONE[st]} hover:underline`}>{CHECK_LABEL[st]}{active.length ? ` (${active.length})` : ""}</button></td>
                      <td className="px-3 py-2 text-right">
                        {!c.archived && c.model_id && <button type="button" onClick={() => setReleasing(c)} disabled={c.review_gate ? !c.review_gate.met : false} title={c.review_gate?.message ?? undefined} className={`${buttonClass.secondary} disabled:cursor-not-allowed disabled:opacity-50`}>Release to staging</button>}
                        <button type="button" className={`${buttonClass.ghost} ml-1`} title={c.archived ? "Restore from the archive" : "Archive"} onClick={() => run(() => objectives.archive(objective.id, c.id, !!c.archived))}>
                          <Icon name={c.archived ? "restore" : "folder"} className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                    {open === c.id && (
                      <tr className="border-t border-line bg-panel-2"><td colSpan={6} className="px-4 py-3">
                        <ChecksPanel objective={objective} submission={c} states={checks[c.id]?.checks ?? {}} onChange={onChange} />
                        {Object.keys(c.metadata ?? {}).length > 0 && (
                          <div className="mt-3 text-xs text-muted">Model details: {Object.entries(c.metadata ?? {}).map(([k, v]) => `${(objective.metadata_fields ?? []).find((f) => f.id === k)?.name ?? k}: ${String(v)}`).join(" · ")}</div>
                        )}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {submitting && <SubmitModel objective={objective} onClose={() => setSubmitting(false)} onSubmitted={(o) => { setSubmitting(false); onChange(o); }} />}
      {releasing && <ReleaseModal objective={objective} submission={releasing} onClose={() => setReleasing(null)} onReleased={(o) => { setReleasing(null); onChange(o); }} />}
    </div>
  );
}

function ChecksPanel({ objective, submission, states, onChange }: { objective: Objective; submission: Submission; states: Record<string, CheckState>; onChange: (o: Objective) => void }) {
  const [text, setText] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const list = (objective.checks ?? []).filter((c) => !c.archived);
  if (!list.length) return <p className="text-xs text-muted">No checks are configured for this objective (Settings → Checks).</p>;
  const act = async (check: ObjectiveCheck, action: "approve" | "reject" | "comment") => {
    setErr(null);
    try {
      onChange(await objectives.actOnCheck(objective.id, submission.id, check.id, action, text[check.id] ?? ""));
      setText({ ...text, [check.id]: "" });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      {err && <p className="text-xs text-bad">{err}</p>}
      {list.map((chk) => {
        const st = states[chk.id]?.status ?? "pending";
        const events = submission.checks?.[chk.id]?.events ?? [];
        return (
          <div key={chk.id} className="rounded border border-line bg-panel p-3 text-xs">
            <div className="flex items-center gap-2"><span className="font-medium text-white">{chk.name}</span><span className={CHECK_TONE[st]}>{CHECK_LABEL[st]}</span>
              {chk.evaluation && <span className="text-muted">follows {chk.evaluation.metric} {chk.evaluation.op} {chk.evaluation.value} on {chk.evaluation.subset ?? "Overall"}</span>}</div>
            {chk.description && <p className="mt-1 text-muted">{chk.description}</p>}
            {states[chk.id]?.message && <p className="mt-1 text-soft">{states[chk.id].message}</p>}
            {events.map((e, i) => <div key={i} className="mt-1 text-soft"><span className="text-muted">{when(e.at)} · {e.by} · </span><span className={e.action === "approve" ? "text-ok" : e.action === "reject" ? "text-bad" : ""}>{e.action}</span>{e.text && `: ${e.text}`}</div>)}
            <div className="mt-2 flex gap-2">
              <input value={text[chk.id] ?? ""} onChange={(e) => setText({ ...text, [chk.id]: e.target.value })} placeholder="Comment" className={`${inputClass} text-xs`} />
              <button type="button" disabled={!(text[chk.id] ?? "").trim()} onClick={() => act(chk, "comment")} className={buttonClass.ghost}>Comment</button>
              {!chk.evaluation && <><button type="button" onClick={() => act(chk, "approve")} className={buttonClass.secondary}>Approve</button><button type="button" onClick={() => act(chk, "reject")} className={buttonClass.ghost}>Reject</button></>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SubmitModel({ objective, onClose, onSubmitted }: { objective: Objective; onClose: () => void; onSubmitted: (o: Objective) => void }) {
  const [models, setModels] = useState<ModelAsset[]>([]);
  const [modelId, setModelId] = useState("");
  const [detail, setDetail] = useState<ModelAssetDetail | null>(null);
  const [version, setVersion] = useState("");
  const [name, setName] = useState("");
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { modelAssets.list().then((m) => { const usable = m.filter((x) => x.versions > 0); setModels(usable); setModelId((c) => c || usable[0]?.id || ""); }, (e: Error) => setErr(e.message)); }, []);
  useEffect(() => { if (modelId) modelAssets.get(modelId).then((d) => { setDetail(d); setVersion(d.versions_detail[0]?.id ?? ""); }, () => setDetail(null)); }, [modelId]);
  return (
    <Modal title="Submit model" icon="upload" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        {models.length === 0 && <p className="text-xs text-muted">No model resource with a version yet. Train one in a Code Repository (ModelOutput), in Model Studio, or import a container. <Link href="/model-assets" className="text-ocean hover:underline">Models</Link></p>}
        <label className="block text-xs text-muted">Model<select value={modelId} onChange={(e) => setModelId(e.target.value)} className={`${inputClass} mt-1`}>{models.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.path.join(" / ")}</option>)}</select></label>
        <label className="block text-xs text-muted">Version<select value={version} onChange={(e) => setVersion(e.target.value)} className={`${inputClass} mt-1`}>{(detail?.versions_detail ?? []).map((v) => <option key={v.id} value={v.id}>{v.version} · {when(v.created_at)}</option>)}</select></label>
        <label className="block text-xs text-muted">Submission name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={detail?.name ?? ""} className={`${inputClass} mt-1`} /></label>
        {(objective.metadata_fields ?? []).map((f) => (
          <label key={f.id} className="block text-xs text-muted">{f.name}{f.required && " *"}
            {f.type === "select" ? <select value={meta[f.id] ?? ""} onChange={(e) => setMeta({ ...meta, [f.id]: e.target.value })} className={`${inputClass} mt-1`}><option value="" />{f.options.map((o) => <option key={o}>{o}</option>)}</select>
              : f.type === "boolean" ? <select value={meta[f.id] ?? ""} onChange={(e) => setMeta({ ...meta, [f.id]: e.target.value })} className={`${inputClass} mt-1`}><option value="" /><option value="true">Yes</option><option value="false">No</option></select>
              : <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={meta[f.id] ?? ""} onChange={(e) => setMeta({ ...meta, [f.id]: e.target.value })} className={`${inputClass} mt-1`} />}
          </label>
        ))}
        {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
          <button type="button" disabled={!modelId || !version} className={buttonClass.primary}
            onClick={async () => {
              setErr(null);
              try {
                const values = Object.fromEntries((objective.metadata_fields ?? []).filter((f) => (meta[f.id] ?? "") !== "").map((f) => [f.id, f.type === "number" ? Number(meta[f.id]) : f.type === "boolean" ? meta[f.id] === "true" : meta[f.id]]));
                onSubmitted(await objectives.submit(objective.id, { model_id: modelId, version, name: name.trim() || undefined, metadata: values }));
              } catch (e) {
                setErr((e as Error).message);
              }
            }}>
            Submit
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ReleaseModal({ objective, submission, onClose, onReleased }: { objective: Objective; submission: Submission; onClose: () => void; onReleased: (o: Objective) => void }) {
  const [version, setVersion] = useState(`${(objective.releases ?? []).filter((r) => r.environment === "staging").length + 1}.0`);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const current = objective.current_releases?.staging;
  const prev = objective.candidates.find((c) => c.submission_id === current?.submission_id);
  const apiChanged = !!prev?.api && !!submission.api && JSON.stringify(prev.api) !== JSON.stringify(submission.api);
  return (
    <Modal title="Create new release" icon="upload" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <p className="text-xs text-muted">Releases <span className="text-white">{submission.name}</span> ({submission.version}) to staging{current ? `, replacing release ${current.version}` : ""}. Staging deployments upgrade to it.</p>
        {submission.review_gate && submission.review_gate.required > 0 && <ReviewGateLine gate={submission.review_gate} />}
        {submission.review_gate && !submission.review_gate.met && <p className="rounded bg-warn/10 px-3 py-2 text-xs text-warn" data-release-blocked>{submission.review_gate.message}</p>}
        {apiChanged && <p className="rounded bg-warn/10 px-3 py-2 text-xs text-warn">This model&apos;s API differs from the current staging release. Functions published on staging deployments keep the old API: publish a new function version on each deployment after releasing.</p>}
        <label className="block text-xs text-muted">Release number<input value={version} onChange={(e) => setVersion(e.target.value)} className={`${inputClass} mt-1`} /></label>
        <label className="block text-xs text-muted">Release note<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={`${inputClass} mt-1`} /></label>
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
          <button type="button" disabled={!version.trim() || (submission.review_gate ? !submission.review_gate.met : false)} className={buttonClass.primary} onClick={async () => { try { onReleased(await objectives.release(objective.id, { candidate_id: submission.id, version, release_note: note })); } catch (e) { setErr((e as Error).message); } }}>Create release</button></div>
      </div>
    </Modal>
  );
}

// -- releases -----------------------------------------------------------------------------------------------------

function ReleasesTab({ objective, onChange }: { objective: Objective; onChange: (o: Objective) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const cur = objective.current_releases;
  return (
    <div className="space-y-4">
      {err && <p className="text-xs text-bad">{err}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {(["staging", "production"] as Environment[]).map((env) => {
          const r = cur?.[env];
          return (
            <section key={env} className="rounded-xl border border-line bg-panel p-4">
              <div className="text-xs uppercase tracking-wide text-muted">{env} release</div>
              {r ? (
                <>
                  <div className="mt-2 text-lg font-semibold">{r.version}</div>
                  <div className="text-sm text-soft">{r.model}{r.model_version ? ` · model version ${r.model_version}` : ""}</div>
                  <div className="mt-1 text-xs text-muted">{when(r.created_at)} by {r.created_by}</div>
                  {r.release_note && <p className="mt-2 text-xs text-soft">{r.release_note}</p>}
                  {env === "staging" && cur?.production?.promoted_from !== r.id && (() => {
                    const gate = objective.candidates.find((c) => c.submission_id === r.submission_id)?.review_gate;
                    return (
                      <>
                        {gate && gate.required > 0 && <div className="mt-2"><ReviewGateLine gate={gate} /></div>}
                        <button type="button" disabled={gate ? !gate.met : false} title={gate?.message ?? undefined} className={`${buttonClass.primary} mt-3 disabled:cursor-not-allowed disabled:opacity-50`} onClick={async () => { setErr(null); try { onChange(await objectives.promote(objective.id, r.id)); } catch (e) { setErr((e as Error).message); } }}>Mark as production</button>
                      </>
                    );
                  })()}
                </>
              ) : <p className="mt-2 text-sm text-muted">{env === "staging" ? "No release yet. Release a model from the Models tab." : "Nothing in production. Mark a staging release as production once it is tested."}</p>}
            </section>
          );
        })}
      </div>
      <section className="rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-4 py-2.5 text-sm font-medium">Release history</div>
        {(objective.releases ?? []).length === 0 ? <p className="p-4 text-xs text-muted">No releases.</p> : (
          <table className="w-full text-xs">
            <thead className="text-muted"><tr>{["Release", "Environment", "Model", "Released", "Note"].map((h) => <th key={h} className="px-3 py-2 text-left font-normal">{h}</th>)}</tr></thead>
            <tbody>{[...(objective.releases ?? [])].reverse().map((r) => (
              <tr key={r.id} className="border-t border-line"><td className="px-3 py-2 text-white">{r.version}</td><td className="px-3 py-2 text-soft">{r.environment}{r.promoted_from ? " (from staging)" : ""}</td>
                <td className="px-3 py-2 text-soft">{r.model} {r.model_version}</td><td className="px-3 py-2 text-muted">{when(r.created_at)} · {r.created_by}</td><td className="px-3 py-2 text-soft">{r.release_note}{r.api_changed && <span className="ml-2 text-warn">model API changed</span>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// -- deployments --------------------------------------------------------------------------------------------------

function DeploymentsTab({ objective }: { objective: Objective }) {
  const [deps, setDeps] = useState<Deployment[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { objectives.deployments(objective.id).then(setDeps, (e: Error) => setErr(e.message)); }, [objective.id]);
  useEffect(load, [load]);
  const hasRelease = !!(objective.current_releases?.staging || objective.current_releases?.production);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="max-w-3xl text-sm text-muted">A deployment runs the staging or production release: a live deployment serves it over a REST endpoint, a batch deployment writes a dataset. Both upgrade when a new release is made in their environment.</p>
        <button type="button" disabled={!hasRelease} title={hasRelease ? "" : "Release a model first"} onClick={() => setCreating(true)} className={buttonClass.primary}><Icon name="plus" className="h-3.5 w-3.5" /> Create deployment</button>
      </div>
      {err && <p className="text-xs text-bad">{err}</p>}
      {deps && deps.length === 0 && <p className="rounded-xl border border-dashed border-line-2 p-8 text-center text-sm text-muted">{hasRelease ? "No deployments." : "Release a model to staging before creating a deployment."}</p>}
      {(deps ?? []).map((d) => <DeploymentPanel key={d.id} id={d.id} onDeleted={load} />)}
      {creating && <CreateDeployment objective={objective} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function CreateDeployment({ objective, onClose, onCreated }: { objective: Objective; onClose: () => void; onCreated: () => void }) {
  const envs = (["staging", "production"] as Environment[]).filter((e) => objective.current_releases?.[e]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"live" | "batch">("live");
  const [environment, setEnvironment] = useState<Environment>(envs[0] ?? "staging");
  const [input, setInput] = useState<{ id: string; name: string } | null>(null);
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [outName, setOutName] = useState("");
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const batch = type === "batch";
  const missing = [
    ...(name.trim() ? [] : ["enter a name"]),
    ...(batch && !input ? ["choose an input dataset"] : []),
    ...(batch && !folder ? ["choose an output location"] : []),
    ...(batch && !outName.trim() ? ["enter an output dataset name"] : []),
  ];
  const bad = (on: boolean) => (tried && on ? "border-bad ring-1 ring-bad/40" : "");
  return (
    <Modal title="Create deployment" icon="signal" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !name.trim()} className={`${inputClass} mt-1 ${bad(!name.trim())}`} />
          {tried && !name.trim() && <span className="mt-1 block text-[11px] text-bad">Give the deployment a name.</span>}
        </label>
        <label className="block text-xs text-muted">Description<input value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} mt-1`} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-muted">Deployment type<select value={type} onChange={(e) => setType(e.target.value as "live" | "batch")} className={`${inputClass} mt-1`}><option value="live">Live (REST endpoint)</option><option value="batch">Batch (output dataset)</option></select></label>
          <label className="block text-xs text-muted">Environment<select value={environment} onChange={(e) => setEnvironment(e.target.value as Environment)} className={`${inputClass} mt-1`}>{envs.map((e) => <option key={e} value={e}>{e} · release {objective.current_releases?.[e]?.version}</option>)}</select></label>
        </div>
        {type === "batch" && (
          <div className="space-y-2 rounded border border-line bg-panel-2 p-3 text-xs">
            <p className="text-muted">The model must take a single tabular input. Models with several inputs run in a Python transform instead.</p>
            <div className="flex items-center gap-2"><span className="w-28 text-muted">Input dataset <span className="text-bad" aria-hidden>*</span></span><button type="button" className={`hover:underline ${tried && !input ? "text-bad" : "text-ocean"}`} onClick={() => setPick(true)}>{input?.name ?? "Choose…"}</button></div>
            <LocationField value={folder} onChange={setFolder} invalid={tried} label="Output folder" hint="The folder of the output dataset." />
            <label className="flex items-center gap-2"><span className="w-28 text-muted">Output dataset <span className="text-bad" aria-hidden>*</span></span><input value={outName} onChange={(e) => setOutName(e.target.value)} placeholder="predictions" aria-invalid={tried && !outName.trim()} className={`${inputClass} text-xs ${bad(!outName.trim())}`} /></label>
          </div>
        )}
        {err && <p className="whitespace-pre-wrap rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
          <button type="button" disabled={busy} className={buttonClass.primary}
            onClick={async () => {
              setTried(true);
              if (missing.length) return;
              setBusy(true);
              setErr(null);
              try {
                await objectives.createDeployment(objective.id, { name, description, type, environment, input_dataset_id: input?.id, output_folder_id: folder?.id, output_name: outName });
                onCreated();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}>
            {busy ? "Creating…" : "Create deployment"}
          </button></div>
      </div>
      {pick && <DrivePicker title="Input dataset" onClose={() => setPick(false)} canPick={(it) => (it.name.endsWith(".parquet") ? null : "Not a dataset")} onPick={(it) => { setInput({ id: it.id, name: it.name.replace(/\.parquet$/, "") }); setPick(false); }} />}
    </Modal>
  );
}

// -- settings -----------------------------------------------------------------------------------------------------

function SettingsTab({ objective, onChange, onDeleted }: { objective: Objective; onChange: (o: Objective) => void; onDeleted: () => void }) {
  const [description, setDescription] = useState(objective.description);
  const [requiredReviews, setRequiredReviews] = useState(String(objective.required_reviews ?? 0));
  const [project, setProject] = useState(objective.project_id ?? "");
  const [fields, setFields] = useState<(Omit<MetadataField, "options"> & { options: string })[]>((objective.metadata_fields ?? []).map((f) => ({ ...f, options: f.options.join(", ") })));
  const [check, setCheck] = useState<{ name: string; description: string; approvers: string; evaluation: boolean; ev: Partial<CheckEvaluation> }>({ name: "", description: "", approvers: "", evaluation: false, ev: { op: ">=" } });
  const [dash, setDash] = useState<EvalDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { objectives.evaluation(objective.id).then(setDash, () => setDash(null)); }, [objective.id]);
  const run = async (fn: () => Promise<Objective>) => { setErr(null); try { onChange(await fn()); setSaved(true); } catch (e) { setErr((e as Error).message); } };
  const libMetrics = [...new Set((dash?.results ?? []).flatMap((r) => Object.keys(r.subsets?.Overall?.metrics ?? {})))];
  return (
    <div className="max-w-3xl space-y-6 text-sm">
      {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
      <section className="rounded-xl border border-line bg-panel p-4">
        <div className="font-medium">Description</div>
        <textarea value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} rows={3} className={`${inputClass} mt-2`} />
        <button type="button" className={`${buttonClass.secondary} mt-2`} onClick={() => run(() => objectives.update(objective.id, { description }))}>Save</button>{saved && <span className="ml-2 text-xs text-ok">Saved</span>}
      </section>
      <section className="rounded-xl border border-line bg-panel p-4" data-settings-project>
        <div className="font-medium">Project</div>
        <p className="mt-1 text-xs text-muted">
          {objective.project ? (objective.project.missing ? "The Project this objective was saved in is gone or hidden from you." : <>Saved in <span className="text-soft">{objective.project.name}</span>: the Project&apos;s roles apply on top of the objective&apos;s own grants (Share), and review attachments are stored there.</>)
            : "In no Project: only the users and groups it is shared with can open it."}
        </p>
        {objective.my_role === "owner" || !objective.my_role ? (
          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1"><ProjectSelect value={project} onChange={(v) => { setProject(v); setSaved(false); }} /></div>
            <button type="button" className={`${buttonClass.secondary} mt-1`} disabled={project === (objective.project_id ?? "")} onClick={() => run(() => objectives.setProject(objective.id, project || null))} data-save-project>Move</button>
          </div>
        ) : <p className="mt-2 text-xs text-muted">Only owners of the objective can move it.</p>}
      </section>
      <section className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center justify-between"><span className="font-medium">Custom model metadata</span>
          <button type="button" className={buttonClass.ghost} onClick={() => setFields([...fields, { id: `field_${fields.length + 1}`, name: "", type: "string", required: false, options: "" }])}><Icon name="plus" className="h-3.5 w-3.5" /> Add field</button></div>
        <p className="mt-1 text-xs text-muted">Asked for whenever a model is submitted: ticket numbers, compliance codes, vendor ids.</p>
        {fields.map((f, i) => {
          const upd = (patch: Partial<(typeof fields)[number]>) => setFields(fields.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={i} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <input value={f.id} onChange={(e) => upd({ id: e.target.value })} placeholder="id" className={`${inputClass} w-28 font-mono text-xs`} />
              <input value={f.name} onChange={(e) => upd({ name: e.target.value })} placeholder="Label" className={`${inputClass} w-44 text-xs`} />
              <select value={f.type} onChange={(e) => upd({ type: e.target.value as MetadataField["type"] })} className={`${inputClass} w-28 text-xs`}>{["string", "number", "boolean", "date", "select"].map((t) => <option key={t}>{t}</option>)}</select>
              {f.type === "select" && <input value={f.options} onChange={(e) => upd({ options: e.target.value })} placeholder="Options, comma separated" className={`${inputClass} w-48 text-xs`} />}
              <label className="flex items-center gap-1 text-soft"><input type="checkbox" checked={f.required} onChange={(e) => upd({ required: e.target.checked })} /> Required</label>
              <button type="button" className="text-muted hover:text-bad" aria-label="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          );
        })}
        <button type="button" className={`${buttonClass.secondary} mt-3`} onClick={() => run(() => objectives.update(objective.id, { metadata_fields: fields.filter((f) => f.id && f.name).map((f) => ({ ...f, options: f.options.split(",").map((o) => o.trim()).filter(Boolean) })) }))}>Save metadata fields</button>
      </section>
      <section className="rounded-xl border border-line bg-panel p-4" data-review-requirement>
        <div className="font-medium">Review requirement</div>
        <p className="mt-1 text-xs text-muted">Approving reviews a model needs before it can be released to staging, marked as production or deployed. A reviewer whose latest review rejects the model (changes requested) blocks the release until they accept it. 0 turns the requirement off.</p>
        <div className="mt-2 flex items-center gap-2">
          <input type="number" min={0} max={20} value={requiredReviews} onChange={(e) => { setRequiredReviews(e.target.value); setSaved(false); }} className={`${inputClass} w-24`} aria-label="Approving reviews required" data-required-reviews />
          <span className="text-xs text-soft">approving review{requiredReviews === "1" ? "" : "s"} required</span>
          <button type="button" className={buttonClass.secondary} disabled={!/^\d+$/.test(requiredReviews) || Number(requiredReviews) > 20} onClick={() => run(() => objectives.update(objective.id, { required_reviews: Number(requiredReviews) }))}>Save</button>
        </div>
      </section>
      <section className="rounded-xl border border-line bg-panel p-4">
        <div className="font-medium">Checks</div>
        <p className="mt-1 text-xs text-muted">Quality gates every submission is reviewed against, each with its own discussion thread. A check can also follow a metric of the evaluation dashboard. Check approval is not required to release (the review requirement above is).</p>
        {(objective.checks ?? []).map((c) => (
          <div key={c.id} className={`mt-2 flex items-center gap-2 rounded border border-line bg-panel-2 px-3 py-2 text-xs ${c.archived ? "opacity-50" : ""}`}>
            <span className="text-white">{c.name}</span>
            <span className="flex-1 truncate text-muted">{c.evaluation ? `${c.evaluation.metric} ${c.evaluation.op} ${c.evaluation.value} (${c.evaluation.subset ?? "Overall"})` : c.approvers.length ? `Approvers: ${c.approvers.join(", ")}` : "Anyone may approve"}</span>
            <button type="button" className="text-muted hover:text-white" onClick={() => run(() => objectives.updateCheck(objective.id, c, !c.archived))}>{c.archived ? "Restore" : "Archive"}</button>
          </div>
        ))}
        <div className="mt-3 space-y-2 rounded border border-dashed border-line-2 p-3 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={check.name} onChange={(e) => setCheck({ ...check, name: e.target.value })} placeholder="Check name" className={`${inputClass} text-xs`} />
            <input value={check.description} onChange={(e) => setCheck({ ...check, description: e.target.value })} placeholder="Description" className={`${inputClass} text-xs`} />
          </div>
          <label className="flex items-center gap-1.5 text-soft"><input type="checkbox" checked={check.evaluation} onChange={(e) => setCheck({ ...check, evaluation: e.target.checked })} /> Automatic, based on an evaluation metric</label>
          {check.evaluation ? (
            !dash?.config.datasets.length || !dash.config.libraries.length ? <p className="text-warn">Configure an evaluation dataset and library on the Evaluation dashboard first.</p> : (
              <div className="flex flex-wrap gap-2">
                <select value={check.ev.dataset_id ?? ""} onChange={(e) => setCheck({ ...check, ev: { ...check.ev, dataset_id: e.target.value } })} className={`${inputClass} w-44 text-xs`}><option value="">Dataset…</option>{dash.config.datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
                <select value={check.ev.library_id ?? ""} onChange={(e) => setCheck({ ...check, ev: { ...check.ev, library_id: e.target.value } })} className={`${inputClass} w-44 text-xs`}><option value="">Library…</option>{dash.config.libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
                <input list="check-metrics" value={check.ev.metric ?? ""} onChange={(e) => setCheck({ ...check, ev: { ...check.ev, metric: e.target.value } })} placeholder="Metric" className={`${inputClass} w-44 text-xs`} />
                <datalist id="check-metrics">{libMetrics.map((m) => <option key={m} value={m} />)}</datalist>
                <select value={check.ev.op} onChange={(e) => setCheck({ ...check, ev: { ...check.ev, op: e.target.value as CheckEvaluation["op"] } })} className={`${inputClass} w-16 text-xs`}>{[">=", ">", "<=", "<", "=="].map((o) => <option key={o}>{o}</option>)}</select>
                <input type="number" value={check.ev.value ?? ""} onChange={(e) => setCheck({ ...check, ev: { ...check.ev, value: Number(e.target.value) } })} placeholder="value" className={`${inputClass} w-24 text-xs`} />
              </div>
            )
          ) : <input value={check.approvers} onChange={(e) => setCheck({ ...check, approvers: e.target.value })} placeholder="Approvers: user or group ids, comma separated (empty: anyone)" className={`${inputClass} text-xs`} />}
          <button type="button" disabled={!check.name.trim() || (check.evaluation && !(check.ev.dataset_id && check.ev.library_id && check.ev.metric && check.ev.value !== undefined))} className={buttonClass.secondary}
            onClick={() => run(async () => {
              const o = await objectives.addCheck(objective.id, { name: check.name, description: check.description, approvers: check.approvers.split(",").map((a) => a.trim()).filter(Boolean), evaluation: check.evaluation ? (check.ev as CheckEvaluation) : null });
              setCheck({ name: "", description: "", approvers: "", evaluation: false, ev: { op: ">=" } });
              return o;
            })}>Add check</button>
        </div>
      </section>
      <section className="rounded-xl border border-bad/30 bg-panel p-4">
        <div className="font-medium">Delete objective</div>
        <p className="mt-1 text-xs text-muted">Removes the objective&apos;s record. Its models stay; delete its deployments first.</p>
        <button type="button" className={`${buttonClass.ghost} mt-2 text-bad`} onClick={async () => {
          if (!(await confirmDialog({ title: `Delete ${objective.name}?`, message: "Its submissions, releases and checks are removed. This cannot be undone.", danger: true, confirmLabel: "Delete" }))) return;
          try { await modelingObjectivesApi.remove(objective.id); onDeleted(); } catch (e) { setErr((e as Error).message); }
        }}>Delete objective</button>
      </section>
    </div>
  );
}
