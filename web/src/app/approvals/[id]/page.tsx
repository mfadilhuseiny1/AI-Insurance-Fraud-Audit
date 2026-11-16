"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { API_URL } from "@/lib/api";
import { auth, type User } from "@/lib/auth";
import { checkpointsApi, type CheckpointPrompt } from "@/lib/checkpoints";
import { approvals, fmtTime, STATUS_LABEL, STATUS_TONE, TASK_LABEL, type ApprovalRequest, type ApprovalTask } from "@/lib/securityGov";

const TASK_TONE: Record<string, string> = { review: "text-ocean", approved: "text-ok", rejected: "text-bad" };

/** One approval request: its tasks with reviews and required checkpoints, comments, reviewers and history. */
export default function ApprovalRequestPage() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [comment, setComment] = useState("");
  const [commentTask, setCommentTask] = useState<string>("");
  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState("");
  const load = useCallback(() => approvals.get(id).then(setR, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
    auth.users().then(setUsers, () => {});
  }, [load]);
  const act = async (p: Promise<ApprovalRequest | unknown>, msg?: string) => {
    try {
      const out = await p;
      if (out && typeof out === "object" && "tasks" in (out as object)) setR(out as ApprovalRequest);
      setError(null);
      if (msg) setNotice(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!r) return error ? <ApiError message={error} /> : <Loading />;
  const reviewable = r.tasks.filter((t) => t.can_review);
  const open = ["pending", "changes_requested", "action_required"].includes(r.status);
  const shown = r.comments.filter((c) => !commentTask || c.task_id === commentTask);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Approvals" icon="check" href="/approvals" crumbs={[{ label: r.title }]} />
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto grid max-w-7xl gap-4 p-4 md:p-6 lg:grid-cols-[1fr_22rem]">
          <div className="min-w-0 space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold">{r.title}</h1>
                <span className={`text-sm font-medium ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </div>
              <p className="mt-1 text-xs text-muted">Requested by {r.created_by_name} · {fmtTime(r.created_at)} · <span className="font-mono">{r.rid}</span></p>
              {editing ? (
                <div className="mt-2 space-y-2">
                  <textarea className={`${inputClass} min-h-20`} value={desc} onChange={(e) => setDesc(e.target.value)} />
                  <div className="flex gap-2">
                    <button type="button" className={buttonClass.primary} onClick={() => act(approvals.edit(r.id, { description: desc })).then(() => setEditing(false))}>Save</button>
                    <button type="button" className={buttonClass.ghost} onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                </div>
              ) : r.description && <p className="mt-2 whitespace-pre-wrap text-sm text-soft">{r.description}</p>}
              {r.error && <p className="mt-2 text-sm text-bad">{r.error}</p>}
            </div>
            {error && <p className="rounded border border-bad/30 bg-bad/10 p-2 text-sm text-bad">{error}</p>}
            {notice && <p className="rounded border border-ok/30 bg-ok/10 p-2 text-sm text-ok">{notice}</p>}
            <div className="flex flex-wrap gap-2">
              {open && reviewable.length > 0 && (
                <>
                  <button type="button" className={buttonClass.primary} onClick={() => act(approvals.review(r.id, { decision: "approve" }))}><Icon name="check" className="h-4 w-4" />Approve all{reviewable.length < r.tasks.length ? " I can review" : ""}</button>
                  <button type="button" className={buttonClass.secondary} onClick={() => act(approvals.review(r.id, { decision: "request_changes", comment }))}>Request changes</button>
                  <button type="button" className={buttonClass.secondary} onClick={() => act(approvals.review(r.id, { decision: "reject" }))}>Reject all</button>
                  <button type="button" className={buttonClass.secondary} onClick={() => act(approvals.review(r.id, { decision: "reject_and_close", comment }))}>Reject and close</button>
                </>
              )}
              {open && r.can_edit && <button type="button" className={buttonClass.ghost} onClick={() => { setDesc(r.description); setEditing(true); }}><Icon name="edit" className="h-4 w-4" />Edit</button>}
              {open && r.can_edit && <button type="button" className={buttonClass.ghost} onClick={() => act(approvals.close(r.id))}><Icon name="x" className="h-4 w-4" />Close request</button>}
              {r.kind === "ontology_proposal" && r.mergeable && (
                <button type="button" className={buttonClass.primary} onClick={() => act(approvals.merge(r.id), "Merged into main")}>
                  <Icon name="check" className="h-4 w-4" />Merge into main
                </button>
              )}
              {r.external_link && <a href={r.external_link} className={buttonClass.ghost}><Icon name="external" className="h-4 w-4" />Open in Nexus Manager</a>}
              {open && r.kind !== "ontology_proposal" && <button type="button" className={buttonClass.ghost} onClick={() => act(approvals.nudge(r.id).then((x) => { setNotice(`Reminded ${x.nudged} reviewer${x.nudged === 1 ? "" : "s"}`); return null; }))}><Icon name="bell" className="h-4 w-4" />Nudge reviewers</button>}
            </div>
            {r.tasks.map((t) => <Task key={t.id} r={r} t={t} open={open} onChanged={setR} onError={setError} onComment={() => setCommentTask(t.id)} />)}
          </div>
          <div className="space-y-4">
            <Card title="Comments" count={r.comments.length} action={
              <select className={`${fieldClass} py-0.5 text-xs`} value={commentTask} onChange={(e) => setCommentTask(e.target.value)}>
                <option value="">All</option>
                {r.tasks.map((t) => <option key={t.id} value={t.id}>{TASK_LABEL[t.kind]}</option>)}
              </select>}>
              <ul className="max-h-96 divide-y divide-line overflow-y-auto">
                {shown.map((c) => (
                  <li key={c.id} className="px-3 py-2 text-xs">
                    <div className="text-muted">{c.by_name} · {fmtTime(c.at)}{c.task_id ? ` · ${TASK_LABEL[r.tasks.find((t) => t.id === c.task_id)?.kind ?? "group_membership"]}` : ""}</div>
                    <p className="mt-0.5 whitespace-pre-wrap text-soft">{c.text}</p>
                    {c.attachments.map((a) => <a key={a.id} href={`${API_URL}/api/drive/items/${a.id}/content`} className="mt-0.5 flex items-center gap-1 text-ocean hover:underline"><Icon name="doc" className="h-3 w-3" />{a.name}</a>)}
                  </li>
                ))}
                {!shown.length && <li className="px-3 py-2 text-xs text-muted">No comments.</li>}
              </ul>
              <div className="space-y-2 border-t border-line p-3">
                <textarea className={`${inputClass} min-h-14 text-xs`} placeholder={commentTask ? "Comment on this task…" : "Comment on the request…"} value={comment} onChange={(e) => setComment(e.target.value)} />
                <div className="flex flex-wrap items-center gap-1">
                  {attachments.map((a) => <span key={a.id} className="rounded bg-panel-2 px-1.5 text-[11px]">{a.name}</span>)}
                  <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => setPicking(true)}><Icon name="upload" className="h-3.5 w-3.5" />Attach</button>
                  <button type="button" className={`${buttonClass.primary} ml-auto text-xs`} disabled={!comment.trim()}
                    onClick={() => act(approvals.comment(r.id, { text: comment, task_id: commentTask || null, attachments: attachments.map((a) => a.id) })).then(() => { setComment(""); setAttachments([]); })}>Comment</button>
                </div>
              </div>
            </Card>
            <Card title="Reviewers">
              <div className="space-y-2 p-3 text-xs">
                {r.tasks.map((t) => <p key={t.id}><span className="text-muted">{TASK_LABEL[t.kind]}:</span> {t.reviewer_names.join(", ") || "—"}</p>)}
                {r.invited_names.length > 0 && <p><span className="text-muted">Invited:</span> {r.invited_names.join(", ")}</p>}
                <select className={`${fieldClass} w-full text-xs`} value="" onChange={(e) => e.target.value && act(approvals.invite(r.id, [e.target.value]), "Reviewer invited")}>
                  <option value="">Invite a reviewer…</option>
                  {users.filter((u) => !r.invited.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
                </select>
                <p className="text-muted">Inviting someone asks for their review; it does not give them the right to approve.</p>
              </div>
            </Card>
            <Card title="History">
              <ul className="space-y-1 p-3 text-xs">
                {r.history.map((h, i) => <li key={i}><span className="text-muted">{fmtTime(h.at)}</span> {h.by} {h.what.replace("_", " ")}{h.task ? ` (${TASK_LABEL[r.tasks.find((t) => t.id === h.task)?.kind ?? "group_membership"]})` : ""}</li>)}
              </ul>
            </Card>
            <Link href="/approvals" className="inline-flex items-center gap-1 text-xs text-ocean hover:underline"><Icon name="left" className="h-3 w-3" />Approvals inbox</Link>
          </div>
        </div>
      </main>
      {picking && <DrivePicker title="Attach a file from Files" onClose={() => setPicking(false)} onPick={(it) => { setAttachments((a) => [...a, { id: it.id, name: it.name }]); setPicking(false); }} />}
    </div>
  );
}

function Task({ r, t, open, onChanged, onError, onComment }: { r: ApprovalRequest; t: ApprovalTask; open: boolean; onChanged: (r: ApprovalRequest) => void; onError: (e: string) => void; onComment: () => void }) {
  const [answering, setAnswering] = useState(false);
  const [prompts, setPrompts] = useState<CheckpointPrompt[]>([]);
  const [answers, setAnswers] = useState<Record<string, { response?: string; acknowledged?: boolean; selected?: string[]; password?: string }>>({});
  const missing = t.checkpoints.filter((c) => !c.record);
  const startAnswering = async () => {
    try {
      // the prompts as the requester sees them
      const all = await checkpointsApi.evaluate({ type: missing[0].type, user_id: r.created_by, items: [], selected: [String(t.params.principal_id ?? t.params.user_id ?? (t.params.users as string[] | undefined)?.[0] ?? "")] });
      setPrompts(all.checkpoints.filter((p) => missing.some((m) => m.config_id === p.config_id)));
    } catch {
      setPrompts(missing.map((m) => ({ config_id: m.config_id, config_rid: "", title: m.title, prompt: "", description: "", type: m.type, type_name: m.type,
        justification: { kind: "response", checkbox_text: "", validation: "", options: [], multiple: false, free_text: "none", recent: false } })));
    }
    setAnswering(true);
  };
  const review = (decision: "approve" | "reject" | "request_changes") => approvals.review(r.id, { decision, task_ids: [t.id] }).then(onChanged, (e: Error) => onError(e.message));
  return (
    <Card title={TASK_LABEL[t.kind]} action={<span className={`text-xs font-medium capitalize ${TASK_TONE[t.state]}`}>{t.state === "review" ? "In review" : t.state}</span>}>
      <div className="space-y-2 p-4 text-sm">
        <p>{t.label}</p>
        {t.policy?.text && (
          <p className="text-xs text-muted">
            Group policy: {t.policy.text}
            {t.policy.min_approvals > 1 && ` (${t.approvals ?? 0} of ${t.policy.min_approvals} so far)`}
          </p>
        )}
        {t.invoked_at && <p className="text-xs text-ok">Applied {fmtTime(t.invoked_at)}</p>}
        {t.error && <p className="text-xs text-bad">{t.error}</p>}
        {t.reviews.map((rv, i) => <p key={i} className="text-xs text-muted">{rv.by_name} — {rv.decision.replace(/_/g, " ")} · {fmtTime(rv.at)}{rv.comment ? `: ${rv.comment}` : ""}</p>)}
        {t.checkpoints.length > 0 && (
          <div className="rounded border border-line p-2 text-xs">
            <div className="font-medium text-soft">Required checkpoints</div>
            {t.checkpoints.map((c) => (
              <div key={c.config_id} className="mt-1 flex items-center gap-2">
                <Icon name={c.record ? "check" : "alert"} className={`h-3.5 w-3.5 ${c.record ? "text-ok" : "text-warn"}`} />
                {c.title} <span className="text-muted">{c.record ? "completed" : "not completed"}</span>
              </div>
            ))}
            {missing.length > 0 && open && (r.is_creator || t.can_review) && !answering && (
              <button type="button" className={`${buttonClass.secondary} mt-2 text-xs`} onClick={startAnswering}>{r.is_creator ? "Complete checkpoints" : "Complete on the requester's behalf"}</button>
            )}
            {answering && (
              <div className="mt-2 space-y-2">
                {prompts.map((p) => (
                  <div key={p.config_id} className="space-y-1">
                    <div className="font-medium">{p.title}</div>
                    {p.prompt && <div className="text-muted">{p.prompt}</div>}
                    {p.justification.kind === "acknowledgment" ? (
                      <label className="flex items-center gap-2"><input type="checkbox" onChange={(e) => setAnswers((a) => ({ ...a, [p.config_id]: { acknowledged: e.target.checked } }))} />{p.justification.checkbox_text}</label>
                    ) : p.justification.kind === "dropdown" ? (
                      <select className={`${fieldClass} w-full text-xs`} onChange={(e) => setAnswers((a) => ({ ...a, [p.config_id]: { ...a[p.config_id], selected: [e.target.value] } }))}>
                        <option value="">Choose…</option>{p.justification.options.map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : p.justification.kind === "reauthentication" ? (
                      <input type="password" className={`${fieldClass} w-full text-xs`} placeholder="Your password" onChange={(e) => setAnswers((a) => ({ ...a, [p.config_id]: { password: e.target.value } }))} />
                    ) : null}
                    {(p.justification.kind === "response" || (p.justification.kind === "dropdown" && p.justification.free_text !== "none")) && (
                      <textarea className={`${fieldClass} w-full text-xs`} placeholder="Justification" onChange={(e) => setAnswers((a) => ({ ...a, [p.config_id]: { ...a[p.config_id], response: e.target.value } }))} />
                    )}
                  </div>
                ))}
                <button type="button" className={`${buttonClass.primary} text-xs`}
                  onClick={() => approvals.answerCheckpoints(r.id, t.id, answers).then((x) => { onChanged(x); setAnswering(false); }, (e: Error) => onError(e.message))}>Submit checkpoints</button>
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {open && t.can_review && t.state !== "approved" && <button type="button" className={`${buttonClass.secondary} text-xs`} onClick={() => review("approve")}><Icon name="check" className="h-3.5 w-3.5" />Approve</button>}
          {open && t.can_review && t.state !== "rejected" && <button type="button" className={`${buttonClass.secondary} text-xs`} onClick={() => review("reject")}>Reject</button>}
          <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={onComment}><Icon name="comment" className="h-3.5 w-3.5" />Comments</button>
          {t.kind === "project_access" && <Link href={`/files/${t.params.project_id}`} className={`${buttonClass.ghost} text-xs`}><Icon name="project" className="h-3.5 w-3.5" />Open Project</Link>}
        </div>
      </div>
    </Card>
  );
}
