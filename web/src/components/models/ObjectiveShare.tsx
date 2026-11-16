"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { api, type DriveItem } from "@/lib/api";
import { bytes, when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import {
  MENTION_RE, objectiveLink, objectives, type Mentionable, type ObjectiveSharing, type ReviewAttachment, type ReviewMention, type ShareRole,
} from "@/lib/modelingObjectives";

// Sharing a modeling objective (viewer / editor / owner grants to users, groups or everyone, with the roles of its
// Project on top), choosing its Project, and the Markdown and attachments of reviews. api/modeling_objectives.py

export const SHARE_ROLES: { id: ShareRole; label: string; hint: string }[] = [
  { id: "viewer", label: "Viewer", hint: "Opens the objective, its models and metrics, and reviews models" },
  { id: "editor", label: "Editor", hint: "Also submits models, edits the overview and settings, releases and deploys" },
  { id: "owner", label: "Owner", hint: "Also shares, moves to another Project and deletes the objective" },
];

type Draft = { principal: string; role: ShareRole; kind: "user" | "group" | "everyone"; name: string };

/** Share → Manage roles: the grants on the objective, "Add a user or group…" for owners, and the Project's roles
 * that apply on top. Everyone else sees who has access. */
export function ShareObjectiveDialog({ objectiveId, onClose, onSaved }: { objectiveId: string; onClose: () => void; onSaved?: () => void }) {
  const [data, setData] = useState<ObjectiveSharing | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let stale = false;
    objectives.sharing(objectiveId).then((s) => { if (!stale) { setData(s); setDraft(s.roles); } }, (e: Error) => !stale && setErr(e.message));
    return () => { stale = true; };
  }, [objectiveId]);
  const matches = useMemo(() => {
    if (!data?.directory || !q.trim()) return [];
    const t = q.trim().toLowerCase();
    const taken = new Set(draft.map((d) => d.principal));
    const all: Draft[] = [
      { principal: "everyone", role: "viewer", kind: "everyone", name: "Everyone" },
      ...data.directory.groups.map((g) => ({ principal: `group:${g.id}`, role: "viewer" as const, kind: "group" as const, name: g.label })),
      ...data.directory.users.map((u) => ({ principal: `user:${u.id}`, role: "viewer" as const, kind: "user" as const, name: u.label })),
    ];
    return all.filter((x) => !taken.has(x.principal) && x.name.toLowerCase().includes(t)).slice(0, 8);
  }, [data, draft, q]);
  const can = !!data?.can_share;
  const changed = !!data && JSON.stringify(draft.map((d) => [d.principal, d.role])) !== JSON.stringify(data.roles.map((d) => [d.principal, d.role]));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await objectives.saveSharing(objectiveId, draft.map((d) => ({ principal: d.principal, role: d.role })));
      setData(s);
      setDraft(s.roles);
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (requestId: string, grant: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const s = await objectives.decideAccess(objectiveId, requestId, grant);
      setData(s);
      // unsaved edits stay; a granted requester joins them
      setDraft(changed ? [...draft, ...s.roles.filter((r) => !draft.some((d) => d.principal === r.principal))] : s.roles);
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Share “${data?.name ?? "objective"}”`} icon="lock" onClose={onClose}>
      <div className="space-y-4 p-5 text-sm" data-share-dialog>
        {!data ? (err ? <p className="text-xs text-bad">{err}</p> : <Loading />) : (
          <>
            <div className="flex items-center justify-between">
              <div className="font-medium">Manage roles</div>
              <span className="text-xs text-muted">Your role: <span className="capitalize text-soft" data-share-my-role>{data.my_role ?? "none"}</span></span>
            </div>
            {can && (
              <div className="relative">
                <Icon name="search" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a user or group…" className={`${inputClass} pl-9`} data-share-search />
                {matches.length > 0 && (
                  <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-xl">
                    {matches.map((m) => (
                      <li key={m.principal}>
                        <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-2" data-share-add={m.principal}
                          onClick={() => { setDraft([...draft, m]); setQ(""); setSaved(false); }}>
                          <Icon name={m.kind === "user" ? "eye" : m.kind === "group" ? "grid" : "globe"} className="h-3.5 w-3.5 text-muted" />
                          <span className="flex-1 truncate">{m.name}</span><span className="text-xs text-muted">{m.kind}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="rounded-lg border border-line" data-share-grants>
              {draft.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted">
                  {data.project ? "No roles have been granted on this objective: the roles of its Project apply." : "No roles have been granted: this objective is open to everyone who can sign in. Add yourself as owner and the people who should see it."}
                </p>
              ) : draft.map((d, i) => (
                <div key={d.principal} className="flex items-center gap-2 border-t border-line px-3 py-2 first:border-t-0" data-share-grant={d.principal}>
                  <Icon name={d.kind === "user" ? "eye" : d.kind === "group" ? "grid" : "globe"} className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{d.name}<span className="ml-2 text-xs text-muted">{d.kind}</span></span>
                  {can ? (
                    <>
                      <select value={d.role} aria-label={`Role of ${d.name}`} className={`${inputClass} w-28 text-xs`} data-share-role={d.principal}
                        onChange={(e) => { setDraft(draft.map((x, j) => (j === i ? { ...x, role: e.target.value as ShareRole } : x))); setSaved(false); }}>
                        {SHARE_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                      <button type="button" aria-label={`Remove ${d.name}`} className="text-muted hover:text-bad" onClick={() => { setDraft(draft.filter((_, j) => j !== i)); setSaved(false); }}><Icon name="x" className="h-3.5 w-3.5" /></button>
                    </>
                  ) : <span className="text-xs capitalize text-soft">{d.role}</span>}
                </div>
              ))}
            </div>
            <ul className="space-y-0.5 text-xs text-muted">{SHARE_ROLES.map((r) => <li key={r.id}><span className="text-soft">{r.label}</span> · {r.hint}</li>)}</ul>
            {can && !!data.requests?.length && (
              <div className="rounded-lg border border-warn/40" data-access-requests>
                <div className="border-b border-line px-3 py-2 text-xs font-medium text-warn">Access requests</div>
                {data.requests.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 border-t border-line px-3 py-2 first:border-t-0" data-access-request={r.by}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{r.by_name} <span className="text-xs text-muted">asks for {r.role} · {when(r.at)}</span></div>
                      {r.reason && <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-soft">{r.reason}</div>}
                    </div>
                    <button type="button" disabled={busy} onClick={() => void decide(r.id, true)} className={`${buttonClass.secondary} text-xs`} data-access-grant={r.by}>Grant {r.role}</button>
                    <button type="button" disabled={busy} onClick={() => void decide(r.id, false)} className={`${buttonClass.ghost} text-xs`} data-access-decline={r.by}>Decline</button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2" data-share-link>
              <Icon name="link" className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 text-xs text-muted">Link sharing: anyone with a role above opens the objective from its link; others see that they have no access and can request it.</span>
              <CopyLinkButton href={objectiveLink({ id: objectiveId })} className={`${buttonClass.secondary} shrink-0 text-xs`} />
            </div>
            {data.project && (
              <p className="flex items-center gap-1.5 text-xs text-muted" data-share-project>
                <Icon name="project" className="h-3.5 w-3.5" />
                {data.project.missing ? "Its Project is gone or hidden from you." : <>Saved in the Project <span className="text-soft">{data.project.name}</span>: its roles apply on top{data.project_role ? ` (you are ${data.project_role} there)` : ""}.</>}
              </p>
            )}
            {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
            <div className="flex items-center justify-end gap-2">
              {saved && !changed && <span className="text-xs text-ok">Saved</span>}
              <button type="button" onClick={onClose} className={buttonClass.ghost}>{can ? "Cancel" : "Close"}</button>
              {can && <button type="button" disabled={busy || !changed} onClick={() => void save()} className={buttonClass.primary} data-share-save>{busy ? "Saving…" : "Save"}</button>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The top-level Files Projects (to save an objective in). */
export function useProjects(): DriveItem[] | null {
  const [list, setList] = useState<DriveItem[] | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((f) => setList(f.items.filter((i) => i.kind === "project")), () => setList([]));
  }, []);
  return list;
}

export function ProjectSelect({ value, onChange, allowNone = true }: { value: string; onChange: (id: string) => void; allowNone?: boolean }) {
  const projects = useProjects();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} mt-1`} data-objective-project>
      {allowNone && <option value="">No Project (only those it is shared with)</option>}
      {projects === null && <option disabled>Loading…</option>}
      {value && projects && !projects.some((p) => p.id === value) && <option value={value}>(current Project)</option>}
      {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

const MD_CLASS = "space-y-2 text-sm leading-6 text-soft [&_a]:text-ocean [&_a]:underline [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_strong]:text-white [&_blockquote]:border-l-2 [&_blockquote]:border-line-2 [&_blockquote]:pl-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-panel-2 [&_pre]:p-2";

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const MENTION_CLASS = "rounded bg-ocean/15 px-1 font-medium text-ocean";

/** A review's Markdown as HTML: tags ("@[Name](user:<id>)") are taken out first and replaced by placeholders, the rest
 * goes through renderMarkdown (all HTML escaped, then bold, italic, lists, quotes, code and http(s) / mailto links),
 * and each placeholder becomes an escaped "@Name" chip — the name the server resolved when it has one. */
export function reviewMarkdownHtml(text: string, mentions?: ReviewMention[]): string {
  const known = new Map((mentions ?? []).map((m) => [m.principal, m.name]));
  const tags: { name: string; principal: string }[] = [];
  const src = text.replace(/\u0001/g, "").replace(MENTION_RE, (_, name: string, principal: string) => {
    tags.push({ name: known.get(principal) ?? name, principal });
    return `\u0001${tags.length - 1}\u0001`;
  });
  return renderMarkdown(src).replace(/\u0001(\d+)\u0001/g, (_, i: string) => {
    const t = tags[Number(i)];
    if (!t) return "";
    const kind = t.principal.startsWith("group:") ? "group" : "user";
    return `<span class="${MENTION_CLASS}" data-mention="${escHtml(t.principal)}" title="${kind === "group" ? "Group" : "User"}">@${escHtml(t.name)}</span>`;
  });
}

/** A review's Markdown: raw HTML, scripts and javascript: links stay text; tagged users and groups show as chips. */
export function ReviewMarkdown({ text, mentions }: { text: string; mentions?: ReviewMention[] }) {
  return <div className={MD_CLASS} dangerouslySetInnerHTML={{ __html: reviewMarkdownHtml(text, mentions) }} data-review-markdown />;
}

/** Copies a link (to an objective, a submission or a review) and says so. */
export function CopyLinkButton({ href, label = "Copy link", className, compact = false }: { href: string; label?: string; className?: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2000);
  };
  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <button type="button" onClick={() => void copy()} title={state === "failed" ? href : `${label}: those with a role on the objective can open it`} aria-label={label}
      className={className ?? buttonClass.ghost} data-copy-link={href}>
      <Icon name={state === "copied" ? "check" : "link"} className="h-3.5 w-3.5" />{!compact && text}
    </button>
  );
}

/** Opening a link to an objective without a role on it (or one that does not exist: the answer is the same): no
 * content, a request for access to its owners. */
export function NoAccessPanel({ objectiveId }: { objectiveId: string }) {
  const [reason, setReason] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      setDone((await objectives.requestAccess(objectiveId, reason.trim(), role)).message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto mt-16 w-full max-w-md rounded-lg border border-line bg-panel p-6 text-sm" data-no-access>
      <div className="flex items-center gap-2 text-base font-semibold"><Icon name="lock" className="h-4 w-4 text-muted" />You don&apos;t have access</div>
      <p className="mt-2 text-muted">This modeling objective does not exist, or you have no role on it. Its owners can give you one.</p>
      {done ? <p className="mt-4 text-ok" data-access-requested>{done}</p> : (
        <div className="mt-4 space-y-3">
          <label className="block text-xs text-muted">Why do you need access? (optional)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} className={`${inputClass} mt-1`} data-access-reason />
          </label>
          <label className="block text-xs text-muted">Role
            <select value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")} className={`${inputClass} mt-1`} data-access-role>
              <option value="viewer">Viewer: open it and review models</option>
              <option value="editor">Editor: also submit, release and deploy</option>
            </select>
          </label>
          {err && <p className="text-xs text-bad">{err}</p>}
          <div className="flex justify-end"><button type="button" disabled={busy} onClick={() => void send()} className={buttonClass.primary} data-request-access>{busy ? "Sending…" : "Request access"}</button></div>
        </div>
      )}
      <Link href="/modeling-objectives" className="mt-4 inline-block text-xs text-ocean hover:underline">Back to the Model Library</Link>
    </div>
  );
}

type MentionOption = { principal: string; kind: "user" | "group"; label: string; hint: string };

/** The review text box with tagging: "@" followed by a name lists the users and groups that can read the objective;
 * choosing one writes "@[Name](user:<id>)" into the Markdown (shown as a chip, its people notified on submit). */
export function MentionTextarea({ objectiveId, value, onChange }: { objectiveId: string; value: string; onChange: (v: string) => void }) {
  const [box, setBox] = useState<HTMLTextAreaElement | null>(null);
  const [who, setWho] = useState<Mentionable | null>(null);
  const [query, setQuery] = useState<{ start: number; q: string } | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let stale = false;
    objectives.mentionable(objectiveId).then((m) => !stale && setWho(m), () => !stale && setWho({ users: [], groups: [] }));
    return () => { stale = true; };
  }, [objectiveId]);
  const options = useMemo<MentionOption[]>(() => {
    if (!query || !who) return [];
    const t = query.q.toLowerCase();
    const all: MentionOption[] = [
      ...who.users.map((u) => ({ principal: `user:${u.id}`, kind: "user" as const, label: u.label, hint: u.username })),
      ...who.groups.map((g) => ({ principal: `group:${g.id}`, kind: "group" as const, label: g.label, hint: "group" })),
    ];
    return all.filter((o) => o.label.toLowerCase().includes(t) || o.hint.toLowerCase().includes(t)).slice(0, 8);
  }, [query, who]);
  const track = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = /(^|\s)@([^\s@[\]()]{0,40})$/.exec(before);
    setQuery(m ? { start: before.length - m[2].length - 1, q: m[2] } : null);
    setActive(0);
  };
  const pick = (o: MentionOption) => {
    const el = box;
    if (!el || !query) return;
    const caret = el.selectionStart ?? value.length;
    const token = `@[${o.label.replace(/[\]\n]/g, " ")}](${o.principal}) `;
    const next = value.slice(0, query.start) + token + value.slice(caret);
    onChange(next.slice(0, 5000));
    setQuery(null);
    const at = query.start + token.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at, at); });
  };
  const insertAt = () => {
    const el = box;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const lead = caret > 0 && !/\s/.test(value[caret - 1]) ? " @" : "@";
    const next = value.slice(0, caret) + lead + value.slice(caret);
    onChange(next);
    const at = caret + lead.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at, at); setQuery({ start: at - 1, q: "" }); setActive(0); });
  };
  return (
    <div className="relative">
      <textarea ref={setBox} value={value} rows={5} maxLength={5000} placeholder="Start typing here... (@ to tag a user or group)" className={inputClass} data-review-text
        onChange={(e) => { onChange(e.target.value); track(e.target); }}
        onClick={(e) => track(e.currentTarget)}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        onKeyDown={(e) => {
          if (!query || !options.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            pick(options[active]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setQuery(null);
          }
        }} />
      <button type="button" onClick={insertAt} className="absolute bottom-2 right-2 rounded px-1.5 text-xs text-muted hover:bg-panel-2 hover:text-white" title="Tag a user or group who can read this objective" data-mention-button>@ Tag</button>
      {query && (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-panel py-1 text-sm shadow-xl" data-mention-menu>
          {!who ? <li className="px-3 py-1.5 text-xs text-muted">Loading…</li> : options.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-muted">No user or group who can read this objective matches “{query.q}”.</li>
          ) : options.map((o, i) => (
            <li key={o.principal}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(o); }} data-mention-option={o.principal}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? "bg-panel-2 text-white" : "text-soft hover:bg-panel-2"}`}>
                <Icon name={o.kind === "user" ? "eye" : "grid"} className="h-3.5 w-3.5 text-muted" />
                <span className="flex-1 truncate">{o.label}</span><span className="text-xs text-muted">{o.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A review's attachments: images as thumbnails (open in a new tab), other files as download links. */
export function AttachmentList({ objectiveId, items }: { objectiveId: string; items: ReviewAttachment[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-review-attachments>
      {items.map((a) => {
        const image = a.content_type.startsWith("image/");
        const href = objectives.attachmentUrl(objectiveId, a.id, !image);
        return image ? (
          <a key={a.id} href={href} target="_blank" rel="noopener noreferrer" title={`${a.name} · ${bytes(a.size)}`} className="block overflow-hidden rounded border border-line hover:border-ocean" data-attachment={a.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={href} alt={a.name} className="h-20 max-w-[10rem] object-cover" />
          </a>
        ) : (
          <a key={a.id} href={href} className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-xs text-soft hover:border-ocean hover:text-white" data-attachment={a.id}>
            <Icon name="doc" className="h-3.5 w-3.5 text-ocean" />{a.name}<span className="text-muted">{bytes(a.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
