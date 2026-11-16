"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge, Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { KIND_LABEL, om, type Branch, type Conflict, type ResourceKind } from "@/lib/ontologyModel";
import { design, type Review } from "@/lib/design";

type Tab = "changes" | "updates" | "proposal" | "changelog";

/**
 * An ontology branch: its changes (edit any resource's branch version, delete it on the branch or discard the
 * change), main's updates since the branch's base, rebasing with conflict resolution, and the proposal — reviewers,
 * a task per changed resource to approve or reject, comments, merge checks, merge and close.
 */
export default function BranchPage() {
  const { id } = useParams<{ id: string }>();
  const [b, setB] = useState<Branch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("changes");
  const [editing, setEditing] = useState<{ kind: ResourceKind; id: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const load = useCallback(() => {
    om.branch(id).then(setB, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  if (error) return <ApiError message={error} />;
  if (!b) return <Loading />;
  const open = b.status === "open";
  const act = async (fn: () => Promise<Branch | unknown>) => {
    try {
      const r = await fn();
      if (r && typeof r === "object" && "change_list" in r) setB(r as Branch);
      else load();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };
  const rebase = async () => {
    const r = await om.rebase(b.id);
    setB(r.branch);
    if (r.status === "conflicts") {
      setConflicts(r.conflicts ?? []);
    } else if (r.status === "errors") void alertDialog(`Rebased, with errors to fix: ${(r.errors ?? []).map((e) => e.error).join("; ")}`);
  };
  const tabs: [Tab, string, number | null][] = [
    ["changes", "All changes", b.change_list.length],
    ["updates", "Main branch updates", b.main_updates.length],
    ["proposal", "Proposal", b.proposal ? b.tasks.length : null],
    ["changelog", "Changelog", b.changelog.length],
  ];
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology" crumbs={[{ label: "Branches", href: "/ontology?tab=branches" }, { label: b.name }]}>
        {open && (
          <>
            <button type="button" onClick={() => act(rebase)} className={buttonClass.secondary}>
              <Icon name="refresh" className="h-3.5 w-3.5" /> Rebase
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await confirmDialog({ message: `Close "${b.name}" without merging?`, danger: true, confirmLabel: "Close branch" })) act(() => om.closeBranch(b.id));
              }}
              className={buttonClass.ghost}
            >
              Close
            </button>
            {b.proposal && (
              <button type="button" disabled={!b.checks?.mergeable} onClick={() => act(() => om.merge(b.id))} className={buttonClass.primary} title={b.checks?.mergeable ? "Merge into main" : "Merge checks have not passed"}>
                <Icon name="check" className="h-3.5 w-3.5" /> Merge proposal
              </button>
            )}
          </>
        )}
      </AppHeader>
      <div className="flex items-center gap-3 border-b border-line bg-panel px-5 py-2 text-xs">
        <Icon name="split" className="h-4 w-4 text-ocean" />
        <span className="font-medium">{b.name}</span>
        <Badge status={b.status} />
        {b.proposal && <Badge status={b.proposal.status} />}
        <span className="text-muted">
          from main · by {b.author?.display_name || b.author?.username || b.created_by} · {when(b.created_at)}
          {b.rebased_at ? ` · rebased ${when(b.rebased_at)}` : ""}
        </span>
        {b.conflicts.length > 0 && <span className="text-bad">{b.conflicts.length} conflicts — rebase to resolve</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 border-r border-line bg-panel p-2 text-sm">
          {tabs.map(([k, label, n]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`flex w-full items-center rounded-md px-3 py-2 text-left ${tab === k ? "bg-ocean/15 font-medium text-white" : "text-soft hover:bg-panel-2"}`}>
              <span className="flex-1">{label}</span>
              {n !== null && <span className="text-xs text-muted">{n}</span>}
            </button>
          ))}
        </nav>
        <section className="dot-grid min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl space-y-4 p-8">
            {b.description && <p className="text-sm text-soft">{b.description}</p>}
            {tab === "changes" && (
              <>
                <div className="flex items-center">
                  <h2 className="flex-1 text-lg font-semibold">Changes on this branch</h2>
                  {open && (
                    <button type="button" onClick={() => setAdding(true)} className={buttonClass.primary}>
                      <Icon name="plus" /> Change a resource
                    </button>
                  )}
                </div>
                <div className="overflow-hidden rounded-xl border border-line bg-panel">
                  {b.change_list.length === 0 && <p className="p-6 text-center text-sm text-muted">No changes yet.</p>}
                  {b.change_list.map((c) => (
                    <div key={c.key} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
                      <Icon name={c.op === "delete" ? "trash" : c.op === "create" ? "plus" : "edit"} className={`h-4 w-4 ${c.op === "delete" ? "text-bad" : "text-ok"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {c.name} <span className="text-xs font-normal text-muted">{KIND_LABEL[c.kind]}</span>
                        </div>
                        <div className="text-xs text-muted">
                          {c.op === "modify" ? (c.fields.length ? `Changed: ${c.fields.join(", ")}` : "Modified") : c.op === "create" ? "Created on this branch" : "Deleted on this branch"}
                        </div>
                      </div>
                      {c.conflict && <Badge status="rejected" label="Conflict" />}
                      {!c.conflict && c.main_changed && <span className="text-xs text-warn">main changed too</span>}
                      {open && c.op !== "delete" && (
                        <button type="button" onClick={() => setEditing({ kind: c.kind, id: c.id })} className={buttonClass.ghost}>
                          Edit
                        </button>
                      )}
                      {open && (
                        <button type="button" onClick={() => act(() => om.deleteBranchResource(b.id, c.kind, c.id, true))} className={`${buttonClass.ghost} text-muted`} title="Remove the change from the branch">
                          Discard
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {b.checks && b.checks.errors.length > 0 && (
                  <ErrorBox message={`Errors: ${b.checks.errors.map((e) => `${e.key}: ${e.error}`).join("; ")}`} />
                )}
              </>
            )}
            {tab === "updates" && (
              <>
                <div className="flex items-center">
                  <h2 className="flex-1 text-lg font-semibold">Main branch updates</h2>
                  {open && (
                    <button type="button" onClick={() => act(rebase)} className={buttonClass.primary}>
                      <Icon name="refresh" /> Rebase branch
                    </button>
                  )}
                </div>
                <p className="text-sm text-muted">Resources changed on main since this branch&apos;s base. Untouched resources already read through; changed ones need a rebase.</p>
                <div className="overflow-hidden rounded-xl border border-line bg-panel">
                  {b.main_updates.length === 0 && <p className="p-6 text-center text-sm text-muted">Main has not changed.</p>}
                  {b.main_updates.map((u) => (
                    <div key={u.key} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0">
                      <span className="flex-1">
                        {u.name} <span className="text-xs text-muted">{KIND_LABEL[u.key.split(":")[0] as ResourceKind]}</span>
                      </span>
                      {u.deleted_on_main && <span className="text-xs text-bad">deleted on main</span>}
                      {u.on_branch && <span className="text-xs text-warn">also changed here</span>}
                      <span className="text-xs text-muted">{u.updated_at ? when(u.updated_at) : ""}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {tab === "proposal" && <ProposalPanel b={b} open={open} act={act} />}
            {tab === "proposal" && <DesignDiff b={b} />}
            {tab === "changelog" && (
              <div className="overflow-hidden rounded-xl border border-line bg-panel">
                {[...b.changelog].reverse().map((e, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm last:border-0">
                    <span className="w-32 text-xs text-muted">{when(e.at)}</span>
                    <span className="font-medium capitalize">{e.op}</span>
                    <span className="text-soft">{e.key}</span>
                    <span className="ml-auto text-xs text-muted">
                      {e.user}
                      {e.fields.length ? ` · ${e.fields.join(", ")}` : ""}
                    </span>
                  </div>
                ))}
                {b.changelog.length === 0 && <p className="p-6 text-center text-sm text-muted">No changes yet.</p>}
              </div>
            )}
          </div>
        </section>
      </div>
      {editing && <ResourceEditor branch={b} kind={editing.kind} rid={editing.id} onClose={() => setEditing(null)} onSaved={(nb) => (setEditing(null), setB(nb))} />}
      {adding && <PickResource onClose={() => setAdding(false)} onPick={(kind, rid) => (setAdding(false), setEditing({ kind, id: rid }))} branch={b} act={act} />}
      {conflicts && <ConflictsDialog b={b} conflicts={conflicts} onClose={() => setConflicts(null)} onDone={(nb) => (setConflicts(null), setB(nb))} />}
    </div>
  );
}

/** The design review of the branch's version of the ontology: findings it introduces and resolves vs main. */
function DesignDiff({ b }: { b: Branch }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stamp = b.changelog.length;
  useEffect(() => {
    design.review(undefined, b.id).then(setReview, (e: Error) => setError(e.message));
  }, [b.id, stamp]);
  const fresh = (review?.findings ?? []).filter((f) => f.new_on_branch && !f.dismissed);
  return (
    <Card
      title="Design review"
      action={
        <Link href={`/ontology/design?branch=${b.id}`} className="text-xs text-ocean hover:underline">
          Full review
        </Link>
      }
    >
      <div className="space-y-2 p-4 text-sm">
        <ErrorBox message={error} />
        {review?.vs_main && (
          <p className="text-muted">
            Compared with main: <span className="text-bad">+{review.vs_main.new.length} new findings</span>, <span className="text-ok">{review.vs_main.resolved.length} resolved</span> · score {review.score}
          </p>
        )}
        {fresh.slice(0, 8).map((f) => (
          <div key={f.id} className="text-xs">
            <span className="font-medium">{f.anti_pattern}</span> · {f.resource_name}: <span className="text-soft">{f.message}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ProposalPanel({ b, open, act }: { b: Branch; open: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const [title, setTitle] = useState(b.proposal?.title ?? b.name);
  const [description, setDescription] = useState(b.proposal?.description ?? b.description);
  const [reviewers, setReviewers] = useState((b.proposal?.reviewers ?? []).join(", "));
  const [comment, setComment] = useState("");
  const p = b.proposal;
  if (!p)
    return (
      <Card title="Create proposal">
        <div className="space-y-3 p-4 text-sm">
          <p className="text-muted">A proposal asks reviewers to approve each changed resource before the branch merges into main.</p>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Reviewers" hint="User IDs, comma separated">
            <input value={reviewers} onChange={(e) => setReviewers(e.target.value)} className={inputClass} />
          </Field>
          <button type="button" disabled={!open || !b.change_list.length} onClick={() => act(() => om.propose(b.id, { title, description, reviewers: reviewers.split(",").map((x) => x.trim()).filter(Boolean) }))} className={buttonClass.primary}>
            Create proposal
          </button>
        </div>
      </Card>
    );
  const checks = b.checks;
  return (
    <>
      <Card title={p.title} action={<Badge status={p.status} />}>
        <div className="space-y-3 p-4 text-sm">
          {p.description && <p className="whitespace-pre-wrap text-soft">{p.description}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Reviewers</span>
            {p.reviewers.length === 0 && <span className="text-muted">none yet (anyone with approval rights can approve)</span>}
            {p.reviewers.map((r) => (
              <span key={r} className="rounded bg-panel-2 px-1.5 py-0.5 ring-1 ring-line-2">
                {r}
              </span>
            ))}
            {open && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  act(() => om.propose(b.id, { reviewers: [...p.reviewers, ...reviewers.split(",").map((x) => x.trim()).filter(Boolean)] }));
                  setReviewers("");
                }}
              >
                <input value={reviewers} onChange={(e) => setReviewers(e.target.value)} placeholder="Invite reviewers (user IDs)" className={`${fieldClass} w-56 py-0.5 text-xs`} />
              </form>
            )}
          </div>
          {checks && (
            <div className={`grid gap-2 text-xs ${checks.design_findings?.length ? "grid-cols-4" : "grid-cols-3"}`}>
              {[
                ["No conflicts with main", !checks.conflicts.length, checks.conflicts.length ? `${checks.conflicts.length} — rebase` : ""],
                ["Valid resources", !checks.errors.length, checks.errors.map((e) => e.error).join("; ")],
                ["Every task approved", !checks.unapproved.length, checks.unapproved.length ? `${checks.unapproved.length} waiting` : ""],
                ...(checks.design_findings?.length
                  ? [["No new high-severity design findings", false, `${checks.design_findings.map((f) => f.label).join("; ")} — fix or dismiss in the design review`]]
                  : []),
              ].map(([label, ok, detail]) => (
                <div key={label as string} className={`rounded-md p-2 ring-1 ${ok ? "bg-ok/10 text-ok ring-ok/30" : "bg-bad/10 text-bad ring-bad/30"}`}>
                  <Icon name={ok ? "check" : "x"} className="mr-1 inline h-3 w-3" />
                  {label as string}
                  {detail ? <div className="mt-0.5 text-[11px] opacity-80">{detail as string}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
      <Card
        title="Review changes"
        count={b.tasks.length}
        action={
          open ? (
            <span className="flex gap-1.5">
              <button type="button" onClick={() => act(() => om.review(b.id, "approve"))} className={buttonClass.secondary}>
                Approve all
              </button>
              <button type="button" onClick={() => act(() => om.review(b.id, "reject"))} className={buttonClass.ghost}>
                Reject all
              </button>
            </span>
          ) : null
        }
      >
        <div className="divide-y divide-line">
          {b.tasks.map((t) => (
            <div key={t.key} className="px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-muted">
                  {KIND_LABEL[t.kind]} · {t.op}
                  {t.needs === "owner" ? " · needs an ontology owner (promotion)" : ""}
                </span>
                <span className="ml-auto">
                  <Badge status={t.status} />
                </span>
                {open && (
                  <>
                    <button type="button" onClick={() => act(() => om.review(b.id, "approve", [t.key]))} className="text-ok hover:underline">
                      Approve
                    </button>
                    <button type="button" onClick={() => act(() => om.review(b.id, "reject", [t.key]))} className="text-bad hover:underline">
                      Reject
                    </button>
                  </>
                )}
              </div>
              {t.fields.length > 0 && <div className="text-xs text-muted">{t.fields.join(", ")}</div>}
              {t.reviews.map((r) => (
                <div key={r.user} className="text-xs text-soft">
                  {r.user} {r.decision === "approve" ? "approved" : "rejected"} {when(r.at)}
                  {!r.counts_as && <span className="text-muted"> (not counted: needs editor or owner)</span>}
                </div>
              ))}
              {p.comments
                .filter((c) => c.key === t.key)
                .map((c) => (
                  <div key={c.id} className="mt-1 rounded bg-panel-2 px-2 py-1 text-xs">
                    <span className="text-muted">{c.user}:</span> {c.text}
                  </div>
                ))}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Comments" count={p.comments.length}>
        <div className="space-y-2 p-4 text-sm">
          {p.comments.map((c) => (
            <div key={c.id} className="rounded-md bg-panel-2 px-3 py-2">
              <div className="text-xs text-muted">
                {c.user} · {when(c.at)}
                {c.key ? ` · on ${c.key}` : ""}
              </div>
              <div className="whitespace-pre-wrap text-soft">{c.text}</div>
            </div>
          ))}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (comment.trim()) act(() => om.comment(b.id, comment));
              setComment("");
            }}
          >
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a comment" className={`${inputClass} flex-1`} />
            <button className={buttonClass.secondary}>Comment</button>
          </form>
        </div>
      </Card>
    </>
  );
}

/** The branch version of a resource as JSON (any kind), with main's version for reference. */
function ResourceEditor({ branch, kind, rid, onClose, onSaved }: { branch: Branch; kind: ResourceKind; rid: string; onClose: () => void; onSaved: (b: Branch) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [main, setMain] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rid === "new") {
      const blank: Record<ResourceKind, Record<string, unknown>> = {
        object_type: { display_name: "", properties: [{ api_name: "id", display_name: "ID", type: "string" }], primary_key: "id", title_property: "id" },
        action_type: { display_name: "", object_type_id: "", kind: "create", parameters: [] },
        link_type: { kind: "join_table", cardinality: "many_to_many", source: { object_type_id: "" }, target: { object_type_id: "" } },
        interface: { display_name: "", api_name: "", properties: [], extends: [], link_constraints: [] },
        shared_property: { display_name: "", api_name: "", type: "string" },
      };
      Promise.resolve().then(() => setText(JSON.stringify(blank[kind], null, 2)));
      return;
    }
    om.branchResource(branch.id, kind, rid).then(
      (r) => {
        setText(JSON.stringify(r.record, null, 2));
        setMain(r.main);
      },
      (e: Error) => setError(e.message),
    );
  }, [branch.id, kind, rid]);
  return (
    <Modal title={`${KIND_LABEL[kind]} on ${branch.name}`} icon="edit" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        {text === null ? (
          <Loading />
        ) : (
          <div className={`grid gap-3 ${main ? "grid-cols-2" : ""}`}>
            <Field label="Branch version">
              <textarea rows={22} value={text} onChange={(e) => setText(e.target.value)} className={`${inputClass} font-mono text-xs`} spellCheck={false} />
            </Field>
            {main && (
              <Field label="Main">
                <pre className="h-[440px] overflow-auto rounded-md bg-ink p-2 text-xs text-muted">{JSON.stringify(main, null, 2)}</pre>
              </Field>
            )}
          </div>
        )}
        <ErrorBox message={error} />
        <div className="flex items-center justify-end gap-2">
          {rid !== "new" && (
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog({ message: `Delete this ${KIND_LABEL[kind].toLowerCase()} on the branch?`, danger: true }))) return;
                try {
                  onSaved(await om.deleteBranchResource(branch.id, kind, rid));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={`${buttonClass.ghost} mr-auto text-bad`}
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> Delete on branch
            </button>
          )}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              setError(null);
              try {
                const rec = JSON.parse(text ?? "{}");
                const r = await om.saveBranchResource(branch.id, kind, rid, rec);
                onSaved(r.branch);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Save to branch
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PickResource({ branch, onClose, onPick }: { branch: Branch; onClose: () => void; onPick: (kind: ResourceKind, id: string) => void; act: (fn: () => Promise<unknown>) => void }) {
  const [kind, setKind] = useState<ResourceKind>("object_type");
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    om.branchResources(branch.id, kind).then(setRows, () => setRows([]));
  }, [branch.id, kind]);
  return (
    <Modal title="Change a resource on the branch" icon="split" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <select value={kind} onChange={(e) => (setRows(null), setKind(e.target.value as ResourceKind))} className={inputClass}>
          {(Object.keys(KIND_LABEL) as ResourceKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}s
            </option>
          ))}
        </select>
        <div className="max-h-80 overflow-y-auto rounded-md border border-line-2">
          <button type="button" onClick={() => onPick(kind, "new")} className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-ocean hover:bg-panel-2">
            <Icon name="plus" className="h-3.5 w-3.5" /> New {KIND_LABEL[kind].toLowerCase()}
          </button>
          {rows?.map((r) => (
            <button key={String(r.id)} type="button" onClick={() => onPick(kind, String(r.id))} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-panel-2">
              {String(r.display_name ?? r.api_name ?? r.id)}
              <span className="ml-auto font-mono text-xs text-muted">{String(r.id)}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">
          Or edit resources in place: saving a protected resource in{" "}
          <Link href="/ontology" className="text-ocean">
            Nexus Manager
          </Link>{" "}
          offers to save it to a new branch.
        </p>
      </div>
    </Modal>
  );
}

function ConflictsDialog({ b, conflicts, onClose, onDone }: { b: Branch; conflicts: Conflict[]; onClose: () => void; onDone: (b: Branch) => void }) {
  const [choice, setChoice] = useState<Record<string, "main" | "branch" | "custom">>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Resolve conflicts" icon="split" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-muted">Main and this branch both changed these resources. Use main&apos;s changes, keep the branch&apos;s, or write a custom version.</p>
        {conflicts.map((c) => (
          <div key={c.key} className="rounded-md border border-line-2 p-3">
            <div className="font-medium">{c.name}</div>
            <div className="mb-2 text-xs text-muted">
              Main changed {c.fields_main.join(", ") || "it"} · the branch changed {c.fields_branch.join(", ") || "it"}
            </div>
            <div className="flex gap-3 text-xs">
              {(["main", "branch", "custom"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={choice[c.key] === k}
                    onChange={() => {
                      setChoice({ ...choice, [c.key]: k });
                      if (k === "custom" && !custom[c.key]) setCustom({ ...custom, [c.key]: JSON.stringify(c.branch, null, 2) });
                    }}
                  />
                  {k === "main" ? "Use main branch changes" : k === "branch" ? "Keep current branch changes" : "Custom change"}
                </label>
              ))}
            </div>
            {choice[c.key] === "custom" && <textarea rows={10} value={custom[c.key] ?? ""} onChange={(e) => setCustom({ ...custom, [c.key]: e.target.value })} className={`${inputClass} mt-2 font-mono text-xs`} />}
          </div>
        ))}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Later
          </button>
          <button
            type="button"
            disabled={conflicts.some((c) => !choice[c.key])}
            onClick={async () => {
              setError(null);
              try {
                const res: Record<string, "main" | "branch" | { custom: Record<string, unknown> }> = {};
                for (const c of conflicts) res[c.key] = choice[c.key] === "custom" ? { custom: JSON.parse(custom[c.key] ?? "{}") } : choice[c.key] === "main" ? "main" : "branch";
                const r = await om.rebase(b.id, res);
                if (r.status === "conflicts") setError("New conflicts appeared: rebase again");
                else onDone(r.branch);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Finish rebase and save
          </button>
        </div>
      </div>
    </Modal>
  );
}
