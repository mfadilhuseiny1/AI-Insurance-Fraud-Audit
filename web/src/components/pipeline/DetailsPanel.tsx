"use client";

import { ItemMarkingsPanel } from "../auth/ItemMarkings";
import Link from "next/link";
import { useEffect, useState } from "react";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { uid, type Pipeline, type PipelineMeta } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "./Modal";
import { Panel, Switch, Tabs } from "./ui";
import { promptDialog } from "@/lib/dialogs";

const ROLES = ["Owner", "Editor", "Viewer", "Discoverer"] as const;

/**
 * The details sidebar: description, views in the last 30 days, followers, comments, collaborators,
 * access (organizations, markings, roles, link sharing, check access) and file metadata.
 */
export function DetailsPanel({
  pipeline,
  user,
  change,
  onGoNode,
  onClose,
}: {
  pipeline: Pipeline;
  user: string;
  change: (fn: (p: Pipeline) => Pipeline, record?: boolean) => void;
  onGoNode: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"details" | "comments" | "access">("details");
  const meta: PipelineMeta = pipeline.meta ?? {};
  const setMeta = (patch: Partial<PipelineMeta>, record = false) => change((p) => ({ ...p, meta: { ...(p.meta ?? {}), ...patch } }), record);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [onNode, setOnNode] = useState("");
  const [check, setCheck] = useState("");
  const [newPrincipal, setNewPrincipal] = useState("");

  // count a view of this pipeline (once per opening of the panel's pipeline)
  useEffect(() => {
    const cutoff = Date.now() - 30 * 86400_000;
    change((p) => ({ ...p, meta: { ...(p.meta ?? {}), views: [...(p.meta?.views ?? []).filter((v) => Date.parse(v.at) > cutoff), { at: new Date().toISOString() }].slice(-1000) } }), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.id]);

  const comments = pipeline.comments ?? [];
  const followers = meta.followers ?? [];
  const following = followers.includes(user);
  const roles = meta.roles ?? [{ principal: user, role: "Owner" as const }];
  const collaborators = [
    ...new Map(
      [...(meta.collaborators ?? []), ...comments.map((c) => ({ name: c.author, addedAt: c.at, role: "Commenter" })), ...roles.map((r) => ({ name: r.principal, addedAt: pipeline.createdAt, role: r.role }))].map((c) => [c.name, c]),
    ).values(),
  ];
  const myRole = roles.find((r) => r.principal === user)?.role ?? "Owner";
  const checkResult = check.trim()
    ? (() => {
        const r = roles.find((x) => x.principal.toLowerCase() === check.trim().toLowerCase());
        return r ? `${r.principal} has the ${r.role} role${(meta.markings ?? []).length ? ` and needs the markings ${(meta.markings ?? []).join(", ")}` : ""}.` : `${check.trim()} has no role on this pipeline${meta.linkSharing?.enabled ? ` (anyone with the link is a ${meta.linkSharing.role})` : ""}.`;
      })()
    : "";

  return (
    <Panel title="Details" icon="info" onClose={onClose} width="w-[22rem]">
      <div className="border-b border-line p-2">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "details", label: "Details" }, { id: "comments", label: "Comments", badge: comments.filter((c) => !c.resolved).length }, { id: "access", label: "Access" }]} />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-xs">
        {tab === "details" && (
          <>
            <section>
              <div className="mb-1 flex items-center justify-between font-medium text-soft">
                Description
                <button type="button" onClick={() => setEditing(!editing)} className="text-ocean hover:underline">
                  {editing ? "Done" : "Edit"}
                </button>
              </div>
              {editing ? (
                <textarea autoFocus value={meta.description ?? ""} onChange={(e) => setMeta({ description: e.target.value })} rows={5} className={`${inputClass} text-xs`} />
              ) : meta.description ? (
                <div className="md-body text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(meta.description) }} />
              ) : (
                <p className="italic text-muted">No description.</p>
              )}
            </section>
            <section className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-panel-2 p-2">
                <div className="text-lg font-semibold text-white">{(meta.views ?? []).length}</div>
                <div className="text-muted">views in the last 30 days</div>
              </div>
              <div className="rounded-md bg-panel-2 p-2">
                <div className="text-lg font-semibold text-white">{followers.length}</div>
                <div className="text-muted">followers</div>
                <button
                  type="button"
                  onClick={() => setMeta({ followers: following ? followers.filter((f) => f !== user) : [...followers, user] }, true)}
                  className="mt-1 text-ocean hover:underline"
                >
                  {following ? "Unfollow" : "Follow"}
                </button>
              </div>
            </section>
            <section>
              <div className="mb-1 font-medium text-soft">Collaborators</div>
              <ul className="space-y-0.5">
                {collaborators.map((c) => (
                  <li key={c.name} className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ocean/20 text-[10px] text-ocean">{c.name.slice(0, 1).toUpperCase()}</span>
                    <span className="flex-1 text-soft">{c.name}</span>
                    <span className="text-muted">
                      {c.role} · added {when(c.addedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <div className="mb-1 font-medium text-soft">Misc</div>
              <dl className="space-y-1">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Location</dt>
                  <dd className="truncate text-right">
                    <Link href={pipeline.location?.id ? `/files/${pipeline.location.id}` : "/files"} className="text-ocean hover:underline">
                      {pipeline.location?.name ?? "Files & Projects"}
                    </Link>
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Modified</dt>
                  <dd>{when(pipeline.updatedAt)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Created</dt>
                  <dd>{when(pipeline.createdAt)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Nodes · outputs</dt>
                  <dd>
                    {pipeline.nodes.length} · {pipeline.outputs.length}
                  </dd>
                </div>
              </dl>
            </section>
          </>
        )}

        {tab === "comments" && (
          <>
            {comments.map((c) => (
              <div key={c.id} className={`rounded-md border p-2 ${c.resolved ? "border-line opacity-60" : "border-line-2"}`}>
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <b className="text-soft">{c.author}</b> {when(c.at)}
                  {c.editedAt && "(edited)"}
                  {c.node && (
                    <button type="button" onClick={() => onGoNode(c.node!)} className="truncate rounded bg-panel-2 px-1 text-ocean hover:underline">
                      {pipeline.nodes.find((n) => n.id === c.node)?.name ?? "node"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => change((p) => ({ ...p, comments: (p.comments ?? []).map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved } : x)) }))}
                    className="ml-auto text-ocean hover:underline"
                  >
                    {c.resolved ? "Reopen" : "Resolve"}
                  </button>
                  {c.author === user && (
                    <button
                      type="button"
                      onClick={async () => {
                        const t = (await promptDialog("Edit comment", c.text));
                        if (t !== null && t.trim()) change((p) => ({ ...p, comments: (p.comments ?? []).map((x) => (x.id === c.id ? { ...x, text: t.trim(), editedAt: new Date().toISOString() } : x)) }));
                      }}
                      className="text-muted hover:text-white"
                    >
                      Edit
                    </button>
                  )}
                </div>
                <div className="md-body mt-1 text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.text) }} />
              </div>
            ))}
            {!comments.length && <p className="text-muted">No comments yet.</p>}
            <div className="space-y-1.5">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Comment (Markdown)…" className={`${inputClass} text-xs`} />
              <div className="flex gap-1.5">
                <select value={onNode} onChange={(e) => setOnNode(e.target.value)} className={`${inputClass} flex-1 py-1 text-xs`}>
                  <option value="">On the pipeline</option>
                  {pipeline.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      On {n.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!comment.trim()}
                  onClick={() => {
                    change((p) => ({ ...p, comments: [...(p.comments ?? []), { id: uid(), author: user, text: comment.trim(), at: new Date().toISOString(), node: onNode || undefined }] }));
                    setComment("");
                  }}
                  className={`${buttonClass.primary} py-1 text-xs`}
                >
                  Post
                </button>
              </div>
            </div>
          </>
        )}

        {tab === "access" && (
          <>
            <p className="text-muted">
              Your role: <b className="text-soft">{myRole}</b>. Markings and organizations are enforced: only users holding all of them can open this pipeline, and the
              datasets it builds inherit them.
            </p>
            <section>
              <div className="mb-1 font-medium text-soft">Markings and organizations</div>
              {pipeline.id ? <ItemMarkingsPanel itemId={pipeline.id} compact /> : <p className="text-muted">Save the pipeline to Files to mark it.</p>}
            </section>
            <section>
              <div className="mb-1 font-medium text-soft">Roles</div>
              <ul className="space-y-1">
                {roles.map((r, i) => (
                  <li key={r.principal} className="flex items-center gap-1.5">
                    <span className="flex-1 text-soft">{r.principal}</span>
                    <select
                      value={r.role}
                      onChange={(e) => setMeta({ roles: roles.map((x, j) => (j === i ? { ...x, role: e.target.value as (typeof ROLES)[number] } : x)) }, true)}
                      className="rounded border border-line-2 bg-ink px-1 py-0.5 text-xs"
                    >
                      {ROLES.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                    {r.principal !== user && (
                      <button type="button" onClick={() => setMeta({ roles: roles.filter((_, j) => j !== i) }, true)} className="text-muted hover:text-bad">
                        <Icon name="x" className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex gap-1.5">
                <input value={newPrincipal} onChange={(e) => setNewPrincipal(e.target.value)} placeholder="Add a user or group" className={`${inputClass} py-1 text-xs`} />
                <button
                  type="button"
                  disabled={!newPrincipal.trim() || roles.some((r) => r.principal === newPrincipal.trim())}
                  onClick={() => {
                    setMeta({ roles: [...roles, { principal: newPrincipal.trim(), role: "Viewer" }], collaborators: [...(meta.collaborators ?? []), { name: newPrincipal.trim(), addedAt: new Date().toISOString(), role: "Viewer" }] }, true);
                    setNewPrincipal("");
                  }}
                  className={`${buttonClass.secondary} py-1 text-xs`}
                >
                  Add
                </button>
              </div>
            </section>
            <section className="space-y-1.5">
              <Switch
                on={!!meta.linkSharing?.enabled}
                onChange={(enabled) => setMeta({ linkSharing: { role: meta.linkSharing?.role ?? "Viewer", enabled } }, true)}
                label="Link sharing"
                hint="Anyone who opens the pipeline's link gets this role."
              />
              {meta.linkSharing?.enabled && (
                <div className="flex items-center gap-2">
                  <select value={meta.linkSharing.role} onChange={(e) => setMeta({ linkSharing: { enabled: true, role: e.target.value as "Viewer" | "Editor" } }, true)} className="rounded border border-line-2 bg-ink px-1 py-0.5">
                    <option>Viewer</option>
                    <option>Editor</option>
                  </select>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(window.location.href.split("?")[0])} className="text-ocean hover:underline">
                    Copy link
                  </button>
                </div>
              )}
            </section>
            <section>
              <div className="mb-1 font-medium text-soft">Check access</div>
              <input value={check} onChange={(e) => setCheck(e.target.value)} placeholder="Search a user or group" className={`${inputClass} py-1 text-xs`} />
              {checkResult && <p className="mt-1 text-soft">{checkResult}</p>}
            </section>
          </>
        )}
      </div>
    </Panel>
  );
}
