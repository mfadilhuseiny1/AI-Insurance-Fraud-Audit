"use client";

import Link from "next/link";
import { API_URL } from "@/lib/api";
import { ResourceMarkings } from "@/components/auth/ItemMarkings";
import { ArtifactSettingsSection } from "@/components/code/ArtifactSettings";
import { ExternalSystemsSection } from "@/components/code/ExternalSystems";
import { useCallback, useEffect, useState } from "react";
import { DiffView } from "@/components/code/DiffView";
import { EnvironmentView } from "@/components/code/PythonPanels";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { Badge, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { codeRepos, MERGE_LABEL, type Check, type Impact, type MergeMode, type PullRequest, type Repo, type Tag } from "@/lib/codeRepos";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { confirmDialog } from "@/lib/dialogs";

const section = "mx-auto max-w-5xl p-8";

function CheckBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-xs text-muted">—</span>;
  return <Badge status={status === "passed" ? "succeeded" : "failed"} label={status} />;
}

// ------------------------------------------------------------------------------------------ branches

export function BranchesTab({ repo, onChanged, onOpenBranch, onPropose }: { repo: Repo; onChanged: () => void; onOpenBranch: (b: string) => void; onPropose: (b: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={section}>
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">Branches</h1>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="split" className="h-3.5 w-3.5" /> New branch
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">
        Work on a sandbox branch, then propose changes to merge them into <span className="font-mono">{repo.default_branch}</span>. Protected branches change only through pull requests.
      </p>
      <ErrorBox message={error} />
      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Branch</th>
              <th className="px-4 py-2.5 font-medium">Last commit</th>
              <th className="px-4 py-2.5 font-medium">Checks</th>
              <th className="px-4 py-2.5 font-medium">Pull request</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {repo.branches.map((b) => (
              <tr key={b.name} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Icon name="split" className="h-3.5 w-3.5 text-muted" />
                    <span className="font-mono">{b.name}</span>
                    {b.default && <span className="rounded bg-ocean/15 px-1.5 text-[10px] text-ocean">default</span>}
                    {b.protected && <span className="rounded bg-sand/15 px-1.5 text-[10px] text-sand">protected</span>}
                    {b.dirty && <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">uncommitted</span>}
                  </div>
                  {b.created_from && <div className="ml-5 text-[11px] text-muted">from {b.created_from}</div>}
                </td>
                <td className="px-4 py-2.5 text-xs text-soft">{b.head ? `${b.head.message} · ${when(b.head.at)}` : "—"}</td>
                <td className="px-4 py-2.5">
                  <CheckBadge status={b.check?.status} />
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {b.pull_request ? (
                    <span className="text-soft">
                      #{b.pull_request.id} {b.pull_request.title}
                    </span>
                  ) : !b.default ? (
                    <button type="button" onClick={() => onPropose(b.name)} className="text-ocean hover:underline">
                      Propose changes
                    </button>
                  ) : null}
                </td>
                <td className="px-3 text-right">
                  <button type="button" onClick={() => onOpenBranch(b.name)} className={buttonClass.ghost}>
                    View code
                  </button>
                  {!b.default && !b.protected && (
                    <button
                      type="button"
                      title="Delete branch"
                      onClick={async () => {
                        if (!(await confirmDialog(`Delete the branch "${b.name}"? Its uncommitted changes are lost; its commits stay reachable from merged branches only.`))) return;
                        try {
                          await codeRepos.deleteBranch(repo.id, b.name);
                          onChanged();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                      className="rounded p-1.5 text-muted hover:text-bad"
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && (
        <NewBranchDialog
          repo={repo}
          onClose={() => setCreating(false)}
          onDone={(name) => {
            setCreating(false);
            onChanged();
            onOpenBranch(name);
          }}
        />
      )}
    </div>
  );
}

export function NewBranchDialog({ repo, from, onClose, onDone }: { repo: Repo; from?: string; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState(from ?? repo.default_branch);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New branch" icon="split" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await codeRepos.createBranch(repo.id, name.trim(), source);
            onDone(name.trim());
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Branch name" hint="For example feature/clean-customers">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} font-mono`} />
        </Field>
        <Field label="Create from">
          <select value={source} onChange={(e) => setSource(e.target.value)} className={inputClass}>
            {repo.branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted">The branch starts from the last commit of the source branch (uncommitted changes are not copied).</p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={!name.trim()} className={buttonClass.primary}>
            Create branch
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ tags

export function TagsTab({ repo }: { repo: Repo }) {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [ref, setRef] = useState(repo.default_branch);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    codeRepos.tags(repo.id).then(setTags).catch(() => setTags([]));
  }, [repo.id]);
  useEffect(load, [load]);
  return (
    <div className={section}>
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">Tags</h1>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New tag
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">
        Tags are immutable names for a version of the code. Naming rules come from <span className="font-mono">repoSettings.json</span> (tagNameValidation).
      </p>
      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-panel">
        {tags === null ? (
          <Loading />
        ) : tags.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">No tags yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {tags.map((t) => (
                <tr key={t.name} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2 font-mono">
                      <Icon name="link" className="h-3.5 w-3.5 text-sand" /> {t.name}
                    </span>
                    {t.message && <div className="ml-5 text-xs text-muted">{t.message}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-soft">
                    <span className="font-mono">{t.commit.slice(0, 7)}</span> {t.commit_meta?.message}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">{when(t.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <Modal title="New tag" icon="link" onClose={() => setCreating(false)}>
          <form
            className="space-y-4 p-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await codeRepos.createTag(repo.id, name.trim(), ref, message);
                setCreating(false);
                setName("");
                setMessage("");
                load();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <Field label="Tag name">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="1.0.0" className={`${inputClass} font-mono`} />
            </Field>
            <Field label="Tag the last commit of">
              <select value={ref} onChange={(e) => setRef(e.target.value)} className={inputClass}>
                {repo.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Message (optional)">
              <input value={message} onChange={(e) => setMessage(e.target.value)} className={inputClass} />
            </Field>
            <ErrorBox message={error} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className={buttonClass.secondary}>
                Cancel
              </button>
              <button type="submit" disabled={!name.trim()} className={buttonClass.primary}>
                Create tag
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ pull requests

export function ProposeDialog({ repo, source, onClose, onDone }: { repo: Repo; source: string; onClose: () => void; onDone: (pr: PullRequest) => void }) {
  const template = (() => {
    try {
      return (JSON.parse(repo.files["repoSettings.json"] ?? "{}").prDescriptionTemplate as string) ?? "";
    } catch {
      return "";
    }
  })();
  const [target, setTarget] = useState(repo.default_branch === source ? (repo.branches.find((b) => b.name !== source)?.name ?? "") : repo.default_branch);
  const [title, setTitle] = useState(repo.branches.find((b) => b.name === source)?.head?.message ?? "");
  const [description, setDescription] = useState(template);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(target ? [] : ["choose a target branch"]), ...(title.trim() ? [] : ["enter a title"])];
  const titleInvalid = tried && !title.trim();
  return (
    <Modal title="Propose changes" icon="split" onClose={onClose} wide>
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          setBusy(true);
          setError(null);
          try {
            onDone(await codeRepos.createPull(repo.id, { source, target, title: title.trim(), description }));
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded bg-panel-2 px-2 py-1 font-mono">{source}</span>
          <Icon name="right" className="h-3.5 w-3.5 text-muted" />
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-invalid={tried && !target} className={`rounded-md border bg-ink px-2 py-1 font-mono text-sm ${tried && !target ? "border-bad ring-1 ring-bad/40" : "border-line-2"}`}>
            {repo.branches
              .filter((b) => b.name !== source)
              .map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
          </select>
          {tried && !target && <span className="text-[11px] text-bad">{repo.branches.length > 1 ? "Choose the branch to merge into." : "No other branch to merge into: create one first."}</span>}
        </div>
        <label className="block">
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Title <span className="text-bad" aria-hidden>*</span></span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={titleInvalid} className={`${inputClass} ${titleInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} />
          {titleInvalid && <span className="mt-1 block text-[11px] text-bad">Give the pull request a title.</span>}
        </label>
        <Field label="Description (Markdown)">
          <textarea rows={7} value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} font-mono text-xs`} />
        </Field>
        <p className="text-xs text-muted">Only committed changes are part of the pull request.</p>
        <ErrorBox message={error} />
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? "Creating…" : "Create pull request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PullsTab({ repo, openId, onOpen, onChanged }: { repo: Repo; openId: string | null; onOpen: (id: string | null) => void; onChanged: () => void }) {
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [filter, setFilter] = useState<"open" | "closed">("open");
  const [q, setQ] = useState("");
  const [proposing, setProposing] = useState(false);
  const load = useCallback(() => {
    codeRepos.pulls(repo.id).then(setPrs).catch(() => setPrs([]));
  }, [repo.id]);
  useEffect(load, [load]);
  if (openId) return <PullDetail repo={repo} id={openId} onBack={() => (onOpen(null), load())} onChanged={onChanged} />;
  const shown = (prs ?? []).filter((p) => (filter === "open" ? p.status === "open" : p.status !== "open") && `${p.title} ${p.source}`.toLowerCase().includes(q.toLowerCase()));
  const sandbox = repo.branches.find((b) => !b.default);
  return (
    <div className={section}>
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">Pull requests</h1>
        <button type="button" onClick={() => setProposing(true)} disabled={!sandbox} className={buttonClass.primary} title={sandbox ? undefined : "Create a branch first"}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New pull request
        </button>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <div className="flex rounded-md border border-line-2 bg-ink p-0.5 text-xs">
          {(["open", "closed"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded px-2.5 py-1 capitalize ${filter === f ? "bg-panel-2 text-white" : "text-muted"}`}>
              {f} ({(prs ?? []).filter((p) => (f === "open" ? p.status === "open" : p.status !== "open")).length})
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title or branch…" className={`${inputClass} max-w-xs`} />
      </div>
      <div className="mt-4 space-y-2">
        {prs === null && <Loading />}
        {prs && shown.length === 0 && <p className="rounded-xl border border-line bg-panel p-6 text-center text-sm text-muted">No {filter} pull requests.</p>}
        {shown.map((p) => (
          <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel p-4 text-left hover:border-ocean/50">
            <Icon name="split" className={`h-4 w-4 ${p.status === "merged" ? "text-violet-400" : p.status === "open" ? "text-ok" : "text-muted"}`} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {p.title} <span className="text-muted">#{p.id}</span>
              </div>
              <div className="text-xs text-muted">
                <span className="font-mono">{p.source}</span> → <span className="font-mono">{p.target}</span> · opened {when(p.created_at)}
              </div>
            </div>
            <span className="text-xs text-muted">
              {p.state.approvals} ✓ {p.state.rejections ? `· ${p.state.rejections} ✕` : ""}
            </span>
            <Badge status={p.status === "merged" ? "succeeded" : p.status === "open" ? "enabled" : "paused"} label={p.status} />
          </button>
        ))}
      </div>
      {proposing && sandbox && (
        <ProposeDialog
          repo={repo}
          source={sandbox.name}
          onClose={() => setProposing(false)}
          onDone={(pr) => {
            setProposing(false);
            onOpen(pr.id);
          }}
        />
      )}
    </div>
  );
}

function PullDetail({ repo, id, onBack, onChanged }: { repo: Repo; id: string; onBack: () => void; onChanged: () => void }) {
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [tab, setTab] = useState<"overview" | "files" | "impact" | "commits">("overview");
  const [comment, setComment] = useState("");
  const [lineComment, setLineComment] = useState<{ path: string; line: number } | null>(null);
  const [mode, setMode] = useState<MergeMode>(repo.settings.merge_modes[0] ?? "squash");
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    codeRepos
      .pull(repo.id, id)
      .then(setPr)
      .catch((e: Error) => setError(e.message));
  }, [repo.id, id]);
  useEffect(load, [load]);
  if (!pr) return error ? <div className="p-8"><ErrorBox message={error} /></div> : <Loading />;

  const act = async (fn: () => Promise<PullRequest>) => {
    setBusy(true);
    setError(null);
    try {
      setPr(await fn());
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const review = (verdict: "approve" | "reject" | "comment", extra: { path?: string; line?: number } = {}) =>
    act(async () => {
      const r = await codeRepos.review(repo.id, pr.id, { verdict, comment, ...extra });
      setComment("");
      setLineComment(null);
      return r;
    });

  return (
    <div className={section}>
      <button type="button" onClick={onBack} className="mb-3 flex items-center gap-1 text-sm text-muted hover:text-white">
        <Icon name="left" className="h-3.5 w-3.5" /> Pull requests
      </button>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">
            {pr.title} <span className="font-normal text-muted">#{pr.id}</span>
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted">
            <Badge status={pr.status === "merged" ? "succeeded" : pr.status === "open" ? "enabled" : "paused"} label={pr.status} />
            <span className="font-mono">{pr.source}</span> → <span className="font-mono">{pr.target}</span>
            {pr.merged_at && <span>· merged {when(pr.merged_at)} ({pr.merge_mode && MERGE_LABEL[pr.merge_mode]})</span>}
          </div>
        </div>
        {pr.status !== "merged" && (
          <button type="button" onClick={() => act(() => codeRepos.setPullState(repo.id, pr.id, pr.status === "open" ? "closed" : "open"))} className={buttonClass.secondary}>
            {pr.status === "open" ? "Close" : "Reopen"}
          </button>
        )}
      </div>

      <div className="mt-4 flex border-b border-line text-sm">
        {(
          [
            ["overview", "Overview"],
            ["files", `Files changed (${pr.changes?.length ?? 0})`],
            ["impact", "Impact analysis"],
            ["commits", `Commits (${pr.commits?.length ?? 0})`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        <ErrorBox message={error} />
      </div>

      {tab === "overview" && (
        <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            <div className="md-body rounded-xl border border-line bg-panel p-4 text-sm text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(pr.description || "_No description._") }} />
            {pr.comments.map((c, i) => (
              <div key={i} className="rounded-xl border border-line bg-panel p-3 text-sm">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                  {c.verdict === "approve" ? <span className="text-ok">approved</span> : c.verdict === "reject" ? <span className="text-bad">rejected</span> : "commented"}
                  {c.path && (
                    <span className="font-mono">
                      on {c.path}:{c.line}
                    </span>
                  )}
                  <span className="ml-auto">{when(c.at)}</span>
                </div>
                <div className="whitespace-pre-wrap text-soft">{c.comment}</div>
              </div>
            ))}
            {pr.status === "open" && (
              <div className="rounded-xl border border-line bg-panel p-3">
                <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a review comment…" className={inputClass} />
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" disabled={busy || !comment.trim()} onClick={() => review("comment")} className={buttonClass.ghost}>
                    Comment
                  </button>
                  <button type="button" disabled={busy} onClick={() => review("reject")} className={`${buttonClass.secondary} text-bad`}>
                    Reject
                  </button>
                  <button type="button" disabled={busy} onClick={() => review("approve")} className={buttonClass.primary}>
                    <Icon name="check" className="h-3.5 w-3.5" /> Approve
                  </button>
                </div>
              </div>
            )}
          </div>
          <aside className="space-y-3">
            <div className="rounded-xl border border-line bg-panel p-4 text-sm">
              <div className="mb-2 font-semibold">Merge</div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted">Approvals</span> {pr.state.approvals}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Rejections</span> {pr.state.rejections}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Checks</span> <CheckBadge status={pr.state.check?.status} />
                </div>
              </div>
              {pr.state.blockers.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-warn">
                  {pr.state.blockers.map((b) => (
                    <li key={b} className="flex gap-1.5">
                      <Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0" /> {b}
                    </li>
                  ))}
                </ul>
              )}
              {pr.status === "open" && (
                <div className="mt-3 space-y-2">
                  <select value={mode} onChange={(e) => setMode(e.target.value as MergeMode)} className={inputClass}>
                    {repo.settings.merge_modes.map((m) => (
                      <option key={m} value={m} disabled={m === "fast_forward" && !pr.state.fast_forward}>
                        {MERGE_LABEL[m]}
                        {m === "fast_forward" && !pr.state.fast_forward ? " (not possible)" : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={busy || !pr.state.can_merge} onClick={() => act(() => codeRepos.mergePull(repo.id, pr.id, mode))} className={`${buttonClass.primary} w-full justify-center`}>
                    {busy ? "Merging…" : MERGE_LABEL[mode]}
                  </button>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
      {tab === "files" && (
        <div className="mt-4">
          <DiffView files={pr.changes ?? []} onComment={pr.status === "open" ? (path, line) => setLineComment({ path, line }) : undefined} />
          {lineComment && (
            <Modal title={`Comment on ${lineComment.path}:${lineComment.line}`} icon="comment" onClose={() => setLineComment(null)}>
              <div className="space-y-3 p-4">
                <textarea autoFocus rows={4} value={comment} onChange={(e) => setComment(e.target.value)} className={inputClass} />
                <div className="flex justify-end">
                  <button type="button" disabled={!comment.trim()} onClick={() => review("comment", lineComment)} className={buttonClass.primary}>
                    Comment
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </div>
      )}
      {tab === "impact" && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted">
            Datasets built by transforms in the changed files. Each is previewed on <span className="font-mono">{pr.source}</span> and its schema compared with the dataset last built on{" "}
            <span className="font-mono">{pr.target}</span>.
          </p>
          {!impact ? (
            <button
              type="button"
              disabled={impactLoading}
              onClick={async () => {
                setImpactLoading(true);
                try {
                  setImpact(await codeRepos.impact(repo.id, pr.id));
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setImpactLoading(false);
                }
              }}
              className={buttonClass.primary}
            >
              <Icon name="play" className="h-3.5 w-3.5" /> {impactLoading ? "Analyzing…" : "Analyze impact"}
            </button>
          ) : impact.affected.length === 0 ? (
            <p className="rounded-xl border border-line bg-panel p-4 text-sm text-muted">No transform outputs are affected ({impact.changed_files.length} files changed).</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-panel">
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Dataset</th>
                    <th className="px-4 py-2 font-medium">Code</th>
                    <th className="px-4 py-2 font-medium">Schema</th>
                    <th className="px-4 py-2 font-medium">Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.affected.map((a) => (
                    <tr key={a.transform} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{a.output}</div>
                        <div className="text-xs text-muted">
                          {a.dataset ? [...a.dataset.path, a.dataset.name].join(" / ") : "new dataset"}
                          {a.stale && <span className="ml-1 text-warn">· stale on target</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-soft">{a.file}</td>
                      <td className="px-4 py-2 text-xs">
                        {!a.schema ? (
                          <span className="text-muted">—</span>
                        ) : !a.schema.added.length && !a.schema.removed.length && !a.schema.changed.length ? (
                          <span className="text-ok">unchanged</span>
                        ) : (
                          <div className="space-y-0.5">
                            {a.schema.added.map((c) => (
                              <div key={c} className="text-ok">+ {c}</div>
                            ))}
                            {a.schema.removed.map((c) => (
                              <div key={c} className="text-bad">− {c}</div>
                            ))}
                            {a.schema.changed.map((c) => (
                              <div key={c} className="text-warn">~ {c} (type)</div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">{a.ok ? <span className="text-ok">{a.rows?.toLocaleString()} rows</span> : <span className="text-bad">{(a.error ?? "failed").split("\n").slice(-2).join(" ")}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {tab === "commits" && (
        <div className="mt-4 space-y-1">
          {(pr.commits ?? []).length === 0 && <p className="text-sm text-muted">No commits to merge.</p>}
          {(pr.commits ?? []).map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
              <span className="font-mono text-xs text-muted">{c.id.slice(0, 7)}</span>
              <span className="flex-1">{c.message}</span>
              <span className="text-xs text-muted">{when(c.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ checks

export function ChecksTab({ repo }: { repo: Repo }) {
  const [branch, setBranch] = useState(repo.branch.name);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [open, setOpen] = useState<Check | null>(null);
  useEffect(() => {
    let stale = false;
    codeRepos
      .checks(repo.id, branch)
      .then((c) => !stale && setChecks(c))
      .catch(() => !stale && setChecks([]));
    return () => {
      stale = true;
    };
  }, [repo.id, branch]);
  return (
    <div className={section}>
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">Checks</h1>
        <select value={branch} onChange={(e) => setBranch(e.target.value)} className="rounded-md border border-line-2 bg-ink px-2 py-1 font-mono text-sm">
          {repo.branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-sm text-muted">Every commit runs checks: the environment in meta.yaml resolves, files compile, transforms load, unit tests pass (with the pytest-defaults plugin), and the PEP8 / Pylint style checks and the Spark anti-pattern linter run when build.gradle applies them.</p>
      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-1.5">
          {checks === null && <Loading />}
          {checks?.length === 0 && <p className="rounded-xl border border-line bg-panel p-6 text-center text-sm text-muted">No checks on this branch yet.</p>}
          {checks?.map((c) => (
            <button key={c.id} type="button" onClick={() => setOpen(c)} className={`flex w-full items-center gap-3 rounded-lg border bg-panel px-3 py-2 text-left text-sm ${open?.id === c.id ? "border-ocean" : "border-line hover:border-ocean/50"}`}>
              <CheckBadge status={c.status} />
              <span className="font-mono text-xs text-muted">{c.commit?.slice(0, 7)}</span>
              <span className="flex-1 truncate text-xs text-soft">
                {c.transforms.length} transforms · {c.tests.filter((t) => t.ok).length}/{c.tests.length} tests
              </span>
              <span className="text-xs text-muted">{when(c.at)}</span>
            </button>
          ))}
        </div>
        {open && (
          <div className="space-y-3 rounded-xl border border-line bg-panel p-4 text-sm">
            <div className="flex items-center gap-2">
              <CheckBadge status={open.status} /> <span className="text-xs text-muted">{(open.ms / 1000).toFixed(1)} s</span>
            </div>
            {open.error && <pre className="whitespace-pre-wrap rounded bg-bad/10 p-2 text-xs text-bad">{open.error}</pre>}
            {open.errors.map((e, i) => (
              <div key={i} className="rounded border border-bad/30 bg-bad/5 p-2 text-xs">
                <div className="font-mono text-bad">{e.file}</div>
                <pre className="whitespace-pre-wrap text-soft">{e.error}</pre>
              </div>
            ))}
            {!!open.tasks?.length && (
              <div>
                <div className="mb-1 text-xs font-semibold text-soft">Tasks</div>
                {open.tasks.map((t) => (
                  <div key={t.name} className="py-0.5 text-xs">
                    <span className={t.status === "failed" ? "text-bad" : t.status === "warnings" || t.status === "warning" ? "text-warn" : t.status === "skipped" ? "text-muted" : "text-ok"}>
                      {t.status === "failed" ? "✕" : t.status === "skipped" ? "–" : t.status === "warnings" || t.status === "warning" ? "!" : "✓"}
                    </span>{" "}
                    <span className="font-mono text-soft">{t.name}</span> <span className="text-muted">{(t.ms / 1000).toFixed(1)} s</span>
                    {t.detail && <span className="text-muted"> · {t.detail}</span>}
                    {!!t.problems && <span className="text-muted"> · {t.problems} message{t.problems === 1 ? "" : "s"}</span>}
                    {!!t.stages?.length && (
                      <ol className="ml-5 list-decimal text-[11px] text-muted">
                        {t.stages.map((s) => (
                          <li key={s.name}>
                            {s.name} · {(s.ms / 1000).toFixed(1)} s
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}
            {open.code_scan && (
              <div data-code-scan>
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-soft">
                  Code scan
                  <span className="font-normal text-muted">{open.code_scan.rules} rules · {open.code_scan.mode} mode · {open.code_scan.coverage}</span>
                  {open.commit && (
                    <a href={`${API_URL}/api/code-scanning/reports/${repo.id}/${open.id}`} className="ml-auto font-normal text-ocean hover:underline">Download scan report</a>
                  )}
                </div>
                {!open.code_scan.findings.length ? <p className="text-xs text-muted">No findings.</p> : (
                  <div className="max-h-72 overflow-y-auto">
                    {open.code_scan.findings.map((f, i) => (
                      <div key={i} className="border-b border-line/50 py-1 text-[11px]">
                        <span className={f.severity === "ERROR" ? "text-bad" : f.severity === "WARNING" ? "text-warn" : "text-muted"}>{f.severity}</span>{" "}
                        <span className="font-mono text-soft">{f.file}:{f.line}:{f.column}</span> <span className="font-mono text-muted">{f.rule}</span>
                        <div className="text-soft">{f.message}</div>
                        {f.snippet && <code className="block truncate text-muted">{f.snippet}</code>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!!open.lint?.length && (
              <div>
                <div className="mb-1 text-xs font-semibold text-soft">Style checks and linters</div>
                <div className="max-h-64 overflow-y-auto">
                  {open.lint.map((p, i) => (
                    <div key={i} className="py-0.5 font-mono text-[11px]">
                      <span className={p.severity === "error" ? "text-bad" : "text-warn"}>{p.tool}</span>{" "}
                      <span className="text-soft">
                        {p.file}:{p.line}:{p.column}
                      </span>{" "}
                      <span className="text-muted">{p.code}</span> <span className="font-sans text-soft">{p.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {open.environment && <EnvironmentView env={open.environment} />}
            <div>
              <div className="mb-1 text-xs font-semibold text-soft">Unit tests</div>
              {open.tests.length === 0 && (
                <p className="text-xs text-muted">{open.tests_disabled ? "Tests are off: apply plugin 'bluesandai.pytest' in build.gradle." : "No tests."}</p>
              )}
              {open.tests.map((t) => (
                <div key={`${t.file}${t.name}`} className="py-0.5 text-xs">
                  <span className={t.ok ? "text-ok" : "text-bad"}>{t.ok ? "✓" : "✕"}</span> <span className="font-mono text-soft">{t.name}</span>{" "}
                  <span className="text-muted">{t.file}</span>
                  {t.error && <pre className="ml-4 whitespace-pre-wrap text-bad">{t.error}</pre>}
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold text-soft">Transforms</div>
              {open.transforms.map((t) => (
                <div key={t.key} className="font-mono text-xs text-muted">
                  {t.key} → {t.output.name}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ settings

export function SettingsTab({ repo, onChanged }: { repo: Repo; onChanged: () => void }) {
  const [s, setS] = useState(repo.settings);
  const [def, setDef] = useState(repo.default_branch);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const toggle = (k: keyof typeof s) => setS({ ...s, [k]: !s[k] });
  // moving and deleting are for Owners of its Project; the settings below (branches, artifacts, external systems) also
  // for the owners recorded on the repository (Foundry: repository owners). Others see them read-only.
  const projectOwner = repo.my_role === "owner";
  const owner = repo.can_manage ?? projectOwner;
  return (
    <div className={section}>
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="mt-5 space-y-5">
        <ProjectSection repo={repo} owner={projectOwner} onChanged={onChanged} />
        <ResourceMarkings kind="code_repo" id={repo.id} />
        {!owner && (
          <p className="rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-xs text-muted" data-testid="settings-read-only">
            Read-only: only the repository&apos;s owners
            {repo.owners?.length ? ` (${repo.owners.map((o) => o.name).join(", ")})` : ""} and the Owners of its Project change these settings (you are{" "}
            {repo.my_role ? `a ${repo.my_role}` : "not a member"}).
          </p>
        )}
        <fieldset disabled={!owner} className="m-0 min-w-0 space-y-5 border-0 p-0 disabled:opacity-80">
        <section className="rounded-xl border border-line bg-panel p-5 text-sm">
          <div className="mb-3 font-semibold">Branches</div>
          <Field label="Default branch">
            <select value={def} onChange={(e) => setDef(e.target.value)} className={`${inputClass} max-w-xs`}>
              {repo.branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="mt-4 mb-1 text-xs font-medium text-soft">Protected branches (changed only through pull requests)</div>
          {repo.branches.map((b) => (
            <label key={b.name} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={s.protected_branches.includes(b.name)}
                onChange={(e) => setS({ ...s, protected_branches: e.target.checked ? [...s.protected_branches, b.name] : s.protected_branches.filter((x) => x !== b.name) })}
                className="accent-[var(--color-ocean)]"
              />
              <span className="font-mono">{b.name}</span>
            </label>
          ))}
        </section>
        <section className="rounded-xl border border-line bg-panel p-5 text-sm">
          <div className="mb-3 font-semibold">Pull requests into protected branches</div>
          {(
            [
              ["require_approval", "Require at least one approval before merging"],
              ["require_no_rejections", "Require no rejections before merging"],
              ["require_checks", "Require checks to pass on the latest commit"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 py-0.5">
              <input type="checkbox" checked={s[k]} onChange={() => toggle(k)} className="accent-[var(--color-ocean)]" /> {label}
            </label>
          ))}
          <label className="mt-3 flex items-center gap-2 py-0.5" title="Upgrade pull requests bring the repository to the latest template; merged once their checks pass, unless they overwrite changes made in the repository">
            <input type="checkbox" checked={!!s.auto_merge_upgrades} onChange={() => setS({ ...s, auto_merge_upgrades: !s.auto_merge_upgrades })} className="accent-[var(--color-ocean)]" />{" "}
            Automatic merge of upgrade PRs (opens them as new template versions come)
          </label>
          <div className="mt-4 mb-1 text-xs font-medium text-soft">Merge modes</div>
          {(Object.keys(MERGE_LABEL) as MergeMode[]).map((m) => (
            <label key={m} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={s.merge_modes.includes(m)}
                onChange={(e) => setS({ ...s, merge_modes: e.target.checked ? [...s.merge_modes, m] : s.merge_modes.filter((x) => x !== m) })}
                className="accent-[var(--color-ocean)]"
              />
              {MERGE_LABEL[m]}
            </label>
          ))}
        </section>
        <section className="rounded-xl border border-line bg-panel p-5 text-sm">
          <div className="mb-3 font-semibold">Commits</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.require_commit_message} onChange={() => toggle("require_commit_message")} className="accent-[var(--color-ocean)]" />
            Require a commit message (otherwise one is generated from the changed files)
          </label>
          <p className="mt-3 text-xs text-muted">
            Tag naming rules and the pull request description template live in <span className="font-mono">repoSettings.json</span> at the repository root.
          </p>
        </section>
        </fieldset>
        <ArtifactSettingsSection repoId={repo.id} readOnly={!owner} />
        <ExternalSystemsSection repoId={repo.id} readOnly={!owner} />
        <ErrorBox message={error} />
        {owner && (
          <button
            type="button"
            onClick={async () => {
              setError(null);
              try {
                await codeRepos.saveSettings(repo.id, { ...s, default_branch: def });
                setSaved(true);
                setTimeout(() => setSaved(false), 1500);
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name="save" className="h-3.5 w-3.5" /> {saved ? "Saved" : "Save settings"}
          </button>
        )}
      </div>
    </div>
  );
}

/** The Project the repository is in: its roles decide who reads (Viewer), changes and builds (Editor), and manages
 * settings or deletes it (Owner). Owners move it to another Project they edit. */
function ProjectSection({ repo, owner, onChanged }: { repo: Repo; owner: boolean; onChanged: () => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!owner) return;
    codeRepos
      .projects()
      .then((r) => setProjects(r.projects.filter((p) => p.id !== repo.project_id)))
      .catch(() => setProjects([]));
  }, [owner, repo.project_id]);
  return (
    <section className="rounded-xl border border-line bg-panel p-5 text-sm">
      <div className="mb-3 font-semibold">Project</div>
      <p>
        {repo.project_id ? (
          <Link href={`/files/${repo.project_id}`} className="text-ocean hover:underline">
            {repo.project_name ?? repo.project_id}
          </Link>
        ) : (
          "—"
        )}{" "}
        <span className="text-muted">· your role: {repo.my_role ?? "none"}</span>
      </p>
      {!!repo.owners?.length && (
        <p className="mt-1 text-xs text-soft" data-testid="repo-owners">
          Repository owners: {repo.owners.map((o) => o.name).join(", ")} <span className="text-muted">(manage the settings below, like the Project&apos;s Owners)</span>
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        The Project&apos;s roles apply to the repository: Viewers read and clone it, Editors commit, branch, build and publish, Owners manage these settings and
        delete it. Roles are managed on the Project in Files.
      </p>
      {owner && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!projects?.length} className={`${inputClass} max-w-xs`} aria-label="Move to Project">
            <option value="">{projects === null ? "Loading Projects…" : projects.length ? "Move to another Project…" : "No other Project you edit"}</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!target || busy}
            onClick={async () => {
              const name = projects?.find((p) => p.id === target)?.name ?? target;
              if (!(await confirmDialog(`Move "${repo.name}" to ${name}? That Project's roles will decide who can read and change it.`))) return;
              setBusy(true);
              setError(null);
              try {
                await codeRepos.move(repo.id, target);
                setTarget("");
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className={buttonClass.secondary}
          >
            Move
          </button>
        </div>
      )}
      <ErrorBox message={error} />
    </section>
  );
}
