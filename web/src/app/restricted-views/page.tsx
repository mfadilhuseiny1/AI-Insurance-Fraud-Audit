"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { PolicyEditor } from "@/components/ontology/SecurityPolicies";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { ApiError, Loading } from "@/components/States";
import { api } from "@/lib/api";
import { datasetPreview } from "@/lib/datasetPreview";
import { confirmDialog } from "@/lib/dialogs";
import { governance, type PolicyNode, type RestrictedView, type ViewBranch } from "@/lib/governanceModel";
import { ontology, type ObjectType } from "@/lib/ontology";

type Col = { api_name: string; display_name: string };

/**
 * Restricted views (Security & Governance): a granular policy over a dataset decides which rows each reader sees. A view
 * sits in a Project (Viewer reads, Editor changes), carries its dataset's markings (unless stopped) and cannot be a
 * pipeline input. Viewers see the rows; editors also see and change the policy.
 */
export default function RestrictedViewsPage() {
  const [project] = useState(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("project")));
  const [list, setList] = useState<RestrictedView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => governance.restrictedViews(project ?? undefined).then(setList, (e: Error) => setError(e.message)), [project]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Restricted views" icon="filter" href="/restricted-views" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]}>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" /> New restricted view
        </button>
      </AppHeader>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          {error && <ApiError message={error} />}
          {open ? (
            <ViewDetail id={open} onBack={() => (setOpen(null), load())} />
          ) : !list ? (
            <Loading />
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-panel">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Backing dataset</th>
                    <th className="px-3 py-2">Markings</th>
                    <th className="px-3 py-2">Your role</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((v) => (
                    <tr key={v.id} onClick={() => setOpen(v.id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-panel-2">
                      <td className="px-3 py-2 font-medium">{v.name}</td>
                      <td className="px-3 py-2 text-muted">{v.backing_name}</td>
                      <td className="px-3 py-2 text-xs">{v.markings.map((m) => m.name).join(", ") || "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted">{v.my_role ?? "—"}</td>
                    </tr>
                  ))}
                  {list.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted">
                        No restricted views{project ? " in this Project" : ""} yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
      {creating && <CreateDialog projectId={project} onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), load(), setOpen(id))} />}
    </div>
  );
}

const DEFAULT_POLICY: PolicyNode = { kind: "and", children: [] };

function CreateDialog({ projectId, onClose, onCreated }: { projectId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [f, setF] = useState({ name: "", description: "", project_id: projectId ?? "", branch: "master" });
  const [branches, setBranches] = useState<string[]>(["master"]);
  const [dataset, setDataset] = useState<{ id: string; name: string } | null>(null);
  const [cols, setCols] = useState<Col[]>([]);
  const [policy, setPolicy] = useState<PolicyNode>(DEFAULT_POLICY);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((r) => setProjects(r.items.filter((i) => i.kind === "project").map((i) => ({ id: i.id, name: i.name }))), () => {});
  }, []);
  useEffect(() => {
    if (!dataset) return;
    setCols([]);
    // the columns come from the rows (the summary also reads the lineage, which can take minutes)
    datasetPreview.rows(dataset.id, { limit: 1 }).then((r) => setCols(r.columns.map((c) => ({ api_name: c.name, display_name: c.name }))), (e: Error) => setError(e.message));
    datasetPreview.summary(dataset.id).then(
      (s) => {
        setCols((cur) => (cur.length ? cur : s.columns.map((c) => ({ api_name: c.name, display_name: c.name }))));
        const bs = (s as unknown as { branches?: { branch: string }[] }).branches;
        if (bs?.length) setBranches(bs.map((b) => b.branch));
      },
      () => {},
    );
  }, [dataset]);
  const create = () =>
    governance
      .createRestrictedView({ ...f, name: f.name.trim(), backing_item_id: dataset!.id, policy })
      .then((v) => onCreated(v.id), (e: Error) => setError(e.message));
  return (
    <Modal title="New restricted view" icon="filter" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Save in Project">
            <select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })} className={inputClass}>
              <option value="">Choose…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What the view shows, and to whom" className={inputClass} />
        </Field>
        <Field label="Backing dataset">
          <div className="flex gap-2">
            <button type="button" onClick={() => setPicking(true)} className={buttonClass.secondary}>
              <Icon name="table" /> {dataset ? dataset.name : "Choose a dataset…"}
            </button>
            {branches.length > 1 && (
              <select value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} className={`${inputClass} w-40`} title="Branch">
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Field>
        {dataset && cols.length === 0 && !error && <p className="text-xs text-muted" data-rv-columns="loading">Reading the dataset&apos;s columns…</p>}
        {dataset && cols.length > 0 && (
          <Field label="Policy: which rows a reader sees (compare the user with the row's columns)">
            <PolicyEditor noMarkings policy={{ granular: policy as never }} props={cols} onChange={(p) => setPolicy((p.granular as PolicyNode) ?? DEFAULT_POLICY)} />
          </Field>
        )}
        <p className="text-xs text-muted">Every condition should compare something about the user (NOT conditions are refused). A restricted view cannot be a pipeline or transform input.</p>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!f.name.trim() || !f.project_id || !dataset} onClick={create} className={buttonClass.primary}>
            Create
          </button>
        </div>
      </div>
      {picking && (
        <DrivePicker
          title="Backing dataset"
          canPick={(item) => (item.kind === "file" ? null : "choose a dataset")}
          onClose={() => setPicking(false)}
          onPick={(item) => (setDataset({ id: item.id, name: item.name }), setPicking(false))}
        />
      )}
    </Modal>
  );
}

function ViewDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [v, setV] = useState<RestrictedView | null>(null);
  const [rows, setRows] = useState<{ columns: { name: string }[]; rows: Record<string, unknown>[]; total_rows: number } | null>(null);
  const [policy, setPolicy] = useState<PolicyNode | null>(null);
  const [count, setCount] = useState<string | null>(null);
  const [history, setHistory] = useState<{ at: string; by: string | null }[] | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [applied, setApplied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Global Branching: the branch the view is looked at on ("" = main)
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchId, setBranchId] = useState("");
  const [vb, setVb] = useState<ViewBranch | null>(null);
  const [choices, setChoices] = useState<Record<string, "main" | "branch">>({});
  useEffect(() => {
    governance.globalBranches().then(setBranches, () => {});
  }, []);
  const load = useCallback(() => {
    governance.restrictedView(id).then((r) => (setV(r), branchId || setPolicy(r.policy ?? null)), (e: Error) => setError(e.message));
    if (branchId) {
      governance.viewOnBranch(id, branchId).then((b) => (setVb(b), setPolicy((b.branch ?? b.main).policy)), (e: Error) => setError(e.message));
      governance.viewRowsOnBranch(id, branchId).then((r) => setRows({ columns: r.columns.map((name) => ({ name })), rows: r.rows, total_rows: r.total }), (e: Error) => setError(e.message));
    } else {
      setVb(null);
      governance.restrictedRows(id).then(setRows, (e: Error) => setError(e.message));
    }
  }, [id, branchId]);
  const onBranch = (p: Promise<ViewBranch>) => p.then(() => (load(), setError(null)), (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, [load]);
  if (!v) return error ? <ApiError message={error} /> : <Loading />;
  const editor = v.policy !== undefined;
  const cols: Col[] = (rows?.columns ?? []).map((c) => ({ api_name: c.name, display_name: c.name }));
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-ocean hover:underline">
        ← Restricted views
      </button>
      <div>
        <h2 className="text-lg font-semibold">{v.name}</h2>
        {editor ? (
          <input
            key={v.description ?? ""}
            defaultValue={v.description ?? ""}
            onBlur={(e) => e.target.value !== (v.description ?? "") && governance.updateRestrictedView(id, { description: e.target.value }).then(() => (load(), setError(null)), (er: Error) => setError(er.message))}
            placeholder="Add a description…"
            aria-label="Description"
            className="w-full bg-transparent text-sm text-soft outline-none placeholder:text-muted focus:border-b focus:border-ocean"
          />
        ) : (
          v.description && <p className="text-sm text-soft">{v.description}</p>
        )}
        <p className="text-sm text-muted">
          On{" "}
          <Link href={`/datasets/${v.backing_item_id}`} className="text-ocean hover:underline">
            {v.backing_name}
          </Link>{" "}
          {v.branch && v.branch !== "master" ? ` (branch ${v.branch})` : ""} · <span className="font-mono text-xs">{v.rid}</span> (query it in SQL Studio) · markings:{" "}
          {v.markings.map((m) => m.name).join(", ") || "none"}
          {v.stop_propagating_names.length > 0 && ` · stopped: ${v.stop_propagating_names.join(", ")}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Branch</span>
        <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="rounded border border-line-2 bg-ink px-1.5 py-1 text-xs">
          <option value="">main</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {!branchId && v.my_role === "owner" && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted" title="Policy and marking changes then go through a global branch and its review">
            <input type="checkbox" checked={!!v.protected} onChange={(e) => governance.setRestrictedProtection(id, e.target.checked).then(setV, (er: Error) => setError(er.message))} />
            Protect main
          </label>
        )}
      </div>
      {branchId && vb && (
        <section className="space-y-2 rounded-xl border border-ocean/40 bg-ocean/5 p-3 text-xs">
          {!vb.added ? (
            <p>
              Not on this branch: it reads the view from main.{" "}
              <button type="button" onClick={() => onBranch(governance.addViewToBranch(id, branchId))} className="text-ocean hover:underline">
                Add to branch
              </button>{" "}
              (builds it on the branch; the backing dataset needs a branch named {vb.branch_name}).
            </p>
          ) : (
            <>
              <p>
                On <span className="font-medium">{vb.branch_name}</span> · {vb.status}
                {vb.changed?.length ? ` · changed: ${vb.changed.join(", ").replace(/_/g, " ")}` : " · no changes yet"}
                {vb.built_at && ` · built ${new Date(vb.built_at).toLocaleString()}`}
                {vb.reindexed?.length ? ` · object types re-indexed: ${vb.reindexed.length}` : ""}
                {` · approvals ${vb.approvals ?? 0}`}
              </p>
              {vb.needs_rebase && (
                <div className="rounded border border-warn/40 bg-warn/10 p-2">
                  <p className="text-warn">Main changed since this branch: rebase before review.</p>
                  {(vb.conflicts ?? []).map((u) => (
                    <label key={u} className="mr-3 inline-flex items-center gap-1">
                      {u.replace(/_/g, " ")}:
                      <select value={choices[u] ?? ""} onChange={(e) => setChoices({ ...choices, [u]: e.target.value as "main" | "branch" })} className="rounded border border-line-2 bg-ink px-1">
                        <option value="">choose…</option>
                        <option value="main">Keep main&apos;s version</option>
                        <option value="branch">Keep this branch&apos;s version</option>
                      </select>
                    </label>
                  ))}
                  <button type="button" onClick={() => onBranch(governance.rebaseView(id, branchId, choices))} className="text-ocean hover:underline">
                    Rebase and save
                  </button>
                </div>
              )}
              <div className="grid gap-2 md:grid-cols-2">
                <div>
                  <p className="text-muted">Main</p>
                  <pre className="max-h-40 overflow-auto rounded bg-ink p-2 text-[10px]">{JSON.stringify(vb.main, null, 1)}</pre>
                </div>
                <div>
                  <p className="text-muted">This branch</p>
                  <pre className="max-h-40 overflow-auto rounded bg-ink p-2 text-[10px]">{JSON.stringify(vb.branch, null, 1)}</pre>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                {!vb.needs_rebase && (
                  <>
                    <button type="button" onClick={() => onBranch(governance.reviewView(id, branchId, "approve"))} className="text-ok hover:underline">
                      Approve
                    </button>
                    <button type="button" onClick={() => onBranch(governance.reviewView(id, branchId, "reject"))} className="text-bad hover:underline">
                      Reject
                    </button>
                  </>
                )}
                {vb.can_edit_policy && vb.approved && !vb.needs_rebase && vb.status !== "merged" && (
                  <button type="button" onClick={() => onBranch(governance.mergeView(id, branchId))} className="text-ocean hover:underline">
                    Merge into main
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirmDialog({ title: "Remove from branch", message: "Its branch-only policy and marking changes are discarded. This cannot be undone.", confirmLabel: "Remove", danger: true }))
                      governance.removeViewFromBranch(id, branchId).then(load, (e: Error) => setError(e.message));
                  }}
                  className="ml-auto text-muted hover:text-bad"
                >
                  Remove from branch
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {editor && policy && (
        <section className="rounded-xl border border-line bg-panel p-4">
          <h3 className="mb-2 font-medium">Policy{branchId ? " on this branch" : ""}</h3>
          <PolicyEditor noMarkings policy={{ granular: policy as never }} props={cols} onChange={(p) => setPolicy((p.granular as PolicyNode) ?? { kind: "and", children: [] })} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                branchId
                  ? onBranch(governance.editViewOnBranch(id, branchId, { policy }))
                  : governance.updateRestrictedView(id, { policy }).then(() => (load(), setError(null)), (e: Error) => setError(e.message))
              }
              className={buttonClass.primary}
            >
              {branchId ? "Save on branch" : "Save policy"}
            </button>
            <button
              type="button"
              onClick={() => governance.previewPolicy(id, policy).then((r) => setCount(`${r.visible_rows} of ${r.total_rows} rows visible to you`), (e: Error) => setError(e.message))}
              className={buttonClass.secondary}
            >
              Preview for me
            </button>
            <button type="button" onClick={() => governance.restrictedTransactions(id).then(setHistory, (e: Error) => setError(e.message))} className={buttonClass.secondary}>
              History ({v.transactions})
            </button>
            {count && <span className="text-xs text-muted">{count}</span>}
            <select
              value=""
              onFocus={() => types.length || ontology.objectTypes().then((ts) => setTypes(ts.filter((t) => t.backing_dataset?.dataset_id === v.backing_item_id)), () => {})}
              onChange={(e) =>
                e.target.value &&
                governance.applyToObjectType(id, e.target.value).then(
                  () => setApplied(`Applied as the object security policy of ${types.find((t) => t.id === e.target.value)?.display_name}`),
                  (er: Error) => setError(er.message),
                )
              }
              className="ml-auto rounded border border-line-2 bg-ink px-1.5 py-1 text-xs"
              title="Object types backed by this dataset get the policy as their object security policy"
            >
              <option value="">Back an object type…</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          </div>
          {applied && <p className="mt-1 text-xs text-ok">{applied}</p>}
          {history && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted">
              {history.map((h, i) => (
                <li key={i}>
                  {new Date(h.at).toLocaleString()} · {h.by ?? "system"}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      <section className="overflow-x-auto rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-4 py-2 text-sm">
          Rows you can see: <span className="font-medium">{rows?.total_rows ?? "…"}</span>
        </div>
        {rows && (
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                {rows.columns.map((c) => (
                  <th key={c.name} className="px-3 py-1.5">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.rows.map((r, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {rows.columns.map((c) => (
                    <td key={c.name} className="px-3 py-1">
                      {r[c.name] === null || r[c.name] === undefined ? <span className="text-muted">null</span> : String(r[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
