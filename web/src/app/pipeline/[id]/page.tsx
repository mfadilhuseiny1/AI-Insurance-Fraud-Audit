"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeviceStream } from "@/components/flow/DeviceStream";
import { Icon } from "@/components/Icon";
import { Builder } from "@/components/pipeline/Builder";
import { buttonClass } from "@/components/pipeline/Modal";
import { Tabs } from "@/components/pipeline/ui";
import {
  BranchMenu,
  branchesOf,
  ChangesDialog,
  CreateBranchDialog,
  CreateProposalDialog,
  HistoryView,
  ManageBranchesDialog,
  ProposalsView,
} from "@/components/pipeline/VersionControl";
import { when } from "@/lib/format";
import type { Pipeline } from "@/lib/pipeline";
import { loadPipelineWithVc, savePipelineWithVc } from "@/lib/pipelineFiles";
import { usePrefs } from "@/lib/prefs";
import { addVersion, contentOf, diff, isProtected, latestVersion, onBranch, type Version, type VersionControl } from "@/lib/versioning";

type View = "edit" | "proposals" | "history";
type FileState = { base: Pipeline; vc: VersionControl };

export default function PipelineBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ id: string; file?: FileState; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    loadPipelineWithVc(id)
      .then(({ pipeline, vc }) => live && setState({ id, file: { base: pipeline, vc } }))
      .catch((e: Error) => live && setState({ id, error: e.message }));
    return () => {
      live = false;
    };
  }, [id]);

  if (!state || state.id !== id) return <div className="flex flex-1 items-center justify-center text-sm text-muted">Opening pipeline…</div>;
  if (!state.file)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
        <span className="flex items-center gap-2 text-bad">
          <Icon name="alert" /> Could not open this pipeline: {state.error}
        </span>
        <Link href="/pipeline" className="text-ocean hover:underline">
          Back to Pipeline Builder
        </Link>
      </div>
    );
  if (state.file.base.type === "device") return <DeviceStream key={state.file.base.id} initial={state.file.base} />;
  return <Workspace key={state.file.base.id} initial={state.file} />;
}

/** Edit, Proposals and History of one pipeline, on a branch. */
function Workspace({ initial }: { initial: FileState }) {
  const router = useRouter();
  const search = useSearchParams();
  const [file, setFile] = useState<FileState>(initial);
  const fileRef = useRef(file);
  const [branch, setBranchState] = useState(() => {
    const b = search.get("branch") ?? "main";
    return branchesOf(initial.vc).includes(b) ? b : "main";
  });
  const [view, setView] = useState<View>((search.get("view") as View) ?? "edit");
  const [dialog, setDialog] = useState<
    | { kind: "branch"; from: string; version?: Version }
    | { kind: "manage" }
    | { kind: "proposal" }
    | { kind: "changes"; pipeline: Pipeline }
    | null
  >(null);
  const [prefs] = usePrefs();
  const user = prefs.userName?.trim() || "You";
  // every write goes through one queue, so concurrent saves never overtake each other
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const live = useRef<Pipeline | null>(null);

  const write = useCallback((next: FileState) => {
    fileRef.current = next;
    setFile(next);
    const job = chain.current.then(() => savePipelineWithVc(next.base, next.vc));
    chain.current = job.catch(() => {});
    return job;
  }, []);

  /** The branch's working copy into the file (datasets are shared by every branch). */
  const merged = useCallback(
    (p: Pipeline, b: string): FileState => {
      const cur = fileRef.current;
      if (b === "main") return { base: { ...p }, vc: cur.vc };
      const info = cur.vc.branches?.[b];
      if (!info) return cur;
      return {
        base: { ...cur.base, datasets: p.datasets, name: p.name },
        vc: { ...cur.vc, branches: { ...cur.vc.branches, [b]: { ...info, content: contentOf(p) } } },
      };
    },
    [],
  );

  const persist = useCallback(async (p: Pipeline) => {
    await write(merged(p, branch));
  }, [write, merged, branch]);

  const saveVersion = useCallback(
    async (p: Pipeline) => {
      const next = merged(p, branch);
      const { vc } = addVersion(next.vc, branch, contentOf(p), user);
      await write({ ...next, vc });
    },
    [merged, write, branch, user],
  );

  const onLive = useCallback((p: Pipeline) => {
    live.current = p;
  }, []);

  const switchBranch = async (b: string) => {
    if (live.current) await write(merged(live.current, branch));
    live.current = null;
    setBranchState(b);
    setView((v) => v);
    const q = new URLSearchParams(search.toString());
    if (b === "main") q.delete("branch");
    else q.set("branch", b);
    router.replace(`?${q.toString()}`, { scroll: false });
  };

  const createBranch = async (name: string, kind: "pipeline" | "global", from: string, version?: Version) => {
    if (live.current) await write(merged(live.current, branch));
    const cur = fileRef.current;
    const source = version?.content ?? contentOf(onBranch(cur.base, cur.vc, from));
    // the branch starts from a saved version of its source (the merge base); save one if there is none
    let vc = cur.vc;
    let base = version ?? latestVersion(vc, from);
    if (!base) {
      const r = addVersion(vc, from, source, user, "Saved when a branch was created");
      vc = r.vc;
      base = r.version;
    }
    vc = {
      ...vc,
      branches: { ...vc.branches, [name]: { name, kind, from, baseVersion: base.id, createdAt: new Date().toISOString(), author: user, content: JSON.parse(JSON.stringify(source)) } },
    };
    await write({ ...cur, vc });
    setDialog(null);
    await switchBranch(name);
    setView("edit");
  };

  const pipeline = useMemo(() => onBranch(file.base, file.vc, branch), [file, branch]);
  const protectedBranch = isProtected(file.vc, branch);

  const viewTabs = (
    <Tabs
      value={view}
      onChange={setView}
      className="ml-2"
      tabs={[
        { id: "edit", label: "Edit" },
        { id: "proposals", label: "Proposals", badge: (file.vc.proposals ?? []).filter((p) => p.status === "open").length },
        { id: "history", label: "History" },
      ]}
    />
  );

  const header = ({ pipeline: p }: { pipeline: Pipeline }) => {
    const saved = latestVersion(fileRef.current.vc, branch);
    const changes = saved ? diff(saved.content, contentOf(p)).filter((c) => !c.moved).length : contentOf(p).nodes.length ? 1 : 0;
    const open = (file.vc.proposals ?? []).filter((x) => x.from === branch && x.status === "open");
    return (
      <>
        <BranchMenu vc={file.vc} branch={branch} onSwitch={switchBranch} onCreate={() => setDialog({ kind: "branch", from: branch })} onManage={() => setDialog({ kind: "manage" })} />
        {viewTabs}
        <button
          type="button"
          disabled={protectedBranch}
          onClick={() => saveVersion(p)}
          title={saved ? `Last saved ${when(saved.at)} by ${saved.author}` : "Not saved yet"}
          className={`ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs ${changes ? "bg-ocean text-white hover:bg-ocean-deep" : "text-ok ring-1 ring-ok/40"}`}
        >
          <Icon name={changes ? "save" : "check"} className="h-3.5 w-3.5" /> {changes ? "Save" : "Saved"}
        </button>
        {changes > 0 && (
          <button
            type="button"
            title="View changes: what differs from the last save"
            onClick={() => setDialog({ kind: "changes", pipeline: p })}
            className="shrink-0 whitespace-nowrap text-xs text-warn hover:underline"
          >
            {saved ? `${changes} unsaved` : "Never saved"}
          </button>
        )}
        <ProposalsMenu
          open={open.length}
          onView={() => setView("proposals")}
          onCreate={() => setDialog({ kind: "proposal" })}
          disabled={branch === "main"}
        />
      </>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {view === "edit" ? (
        <Builder
          key={branch}
          initial={pipeline}
          persist={persist}
          branch={branch}
          readOnly={protectedBranch}
          onSaveVersion={saveVersion}
          onLive={onLive}
          header={header}
          banner={
            protectedBranch ? (
              <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-warn">
                <Icon name="stop" className="h-3.5 w-3.5" /> {branch} is protected: changes need a proposal.
                <button type="button" onClick={() => setDialog({ kind: "branch", from: branch })} className="underline">
                  Create a branch to make changes
                </button>
              </div>
            ) : null
          }
        />
      ) : (
        <>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-4 text-sm">
            <Link href="/pipeline" className="text-muted hover:text-white">
              Pipeline Builder
            </Link>
            <Icon name="right" className="h-3.5 w-3.5 text-muted" />
            <span className="font-medium">{file.base.name}</span>
            <BranchMenu vc={file.vc} branch={branch} onSwitch={switchBranch} onCreate={() => setDialog({ kind: "branch", from: branch })} onManage={() => setDialog({ kind: "manage" })} />
            {viewTabs}
          </header>
          {view === "history" ? (
            <HistoryView vc={file.vc} base={file.base} branch={branch} onBranch={switchBranch} onCreateBranch={(from, version) => setDialog({ kind: "branch", from, version })} />
          ) : (
            <ProposalsView
              vc={file.vc}
              base={file.base}
              user={user}
              onChange={(vc) => write({ ...fileRef.current, vc })}
              onMerge={async (proposal, mergedContent, squash) => {
                const cur = fileRef.current;
                // the source branch's versions since it was created (or since its last merge)
                const fromBase = cur.vc.branches?.[proposal.from]?.baseVersion;
                const baseAt = (cur.vc.versions ?? []).find((v) => v.id === fromBase)?.at ?? "";
                const brought = (cur.vc.versions ?? []).filter((v) => v.branch === proposal.from && v.at > baseAt).sort((a, b) => a.at.localeCompare(b.at));
                const summary = brought.map((v) => ({ id: v.id, at: v.at, author: v.author, message: v.message }));
                const message = squash
                  ? `Squash-merged proposal "${proposal.title}" from ${proposal.from}${brought.length ? `: ${brought.map((v) => v.message || "Saved").join("; ")}` : ""}`
                  : `Merged proposal "${proposal.title}" from ${proposal.from}`;
                let next: FileState =
                  proposal.to === "main"
                    ? { base: { ...cur.base, ...mergedContent, id: cur.base.id, name: cur.base.name, location: cur.base.location, datasets: cur.base.datasets }, vc: cur.vc }
                    : { ...cur, vc: { ...cur.vc, branches: { ...cur.vc.branches, [proposal.to]: { ...cur.vc.branches![proposal.to], content: mergedContent } } } };
                const r = addVersion(next.vc, proposal.to, mergedContent, user, message, { from: proposal.from, proposal: proposal.id, squash, versions: summary });
                // the source branch now starts from the merged version
                const src = r.vc.branches?.[proposal.from];
                // a squash folds the branch's versions into the merge: they leave its history
                const based = new Set(Object.values(cur.vc.branches ?? {}).map((b) => b.baseVersion));
                const folded = new Set(squash ? brought.filter((v) => !based.has(v.id)).map((v) => v.id) : []);
                next = {
                  ...next,
                  vc: {
                    ...r.vc,
                    versions: (r.vc.versions ?? []).filter((v) => !folded.has(v.id)),
                    branches: src ? { ...r.vc.branches, [proposal.from]: { ...src, baseVersion: r.version.id } } : r.vc.branches,
                    proposals: (r.vc.proposals ?? []).map((x) => (x.id === proposal.id ? { ...x, status: "merged", mergedAt: new Date().toISOString(), mergedVersion: r.version.id } : x)),
                  },
                };
                await write(next);
              }}
            />
          )}
        </>
      )}

      {dialog?.kind === "branch" && (
        <CreateBranchDialog vc={file.vc} from={dialog.from} version={dialog.version} onClose={() => setDialog(null)} onCreate={(name, kind) => createBranch(name, kind, dialog.from, dialog.version)} />
      )}
      {dialog?.kind === "manage" && <ManageBranchesDialog vc={file.vc} onSave={(vc) => write({ ...fileRef.current, vc })} onClose={() => setDialog(null)} />}
      {dialog?.kind === "proposal" && (
        <CreateProposalDialog
          vc={file.vc}
          from={branch}
          onClose={() => setDialog(null)}
          onCreate={async ({ title, description, to }) => {
            // the proposal reviews the branch as saved
            if (live.current) await saveVersion(live.current);
            const cur = fileRef.current;
            const now = new Date().toISOString();
            await write({
              ...cur,
              vc: {
                ...cur.vc,
                proposals: [
                  ...(cur.vc.proposals ?? []),
                  { id: crypto.randomUUID().slice(0, 8), title, description, from: branch, to, status: "open", author: user, createdAt: now, updatedAt: now, reviewed: [], approvals: [], comments: [] },
                ],
              },
            });
            setDialog(null);
            setView("proposals");
          }}
        />
      )}
      {dialog?.kind === "changes" && (
        <ChangesDialog
          title={`View changes — ${branch}`}
          base={file.base}
          before={latestVersion(file.vc, branch)?.content}
          after={contentOf(dialog.pipeline)}
          beforeLabel={latestVersion(file.vc, branch) ? `saved ${when(latestVersion(file.vc, branch)!.at)}` : "never saved"}
          afterLabel="unsaved changes"
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function ProposalsMenu({ open, onView, onCreate, disabled }: { open: number; onView: () => void; onCreate: () => void; disabled: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setShow(false)}>
      <button type="button" onClick={() => setShow(!show)} className={`${buttonClass.ghost} py-1 text-xs`}>
        <Icon name="comment" className="h-3.5 w-3.5" /> Proposals{open ? ` (${open})` : ""} <Icon name="down" className="h-3 w-3" />
      </button>
      {show && (
        <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-lg border border-line-2 bg-panel-2 py-1 text-xs shadow-xl">
          <button type="button" onClick={onView} className="block w-full px-3 py-1.5 text-left text-soft hover:bg-panel hover:text-white">
            View proposals
          </button>
          <button
            type="button"
            disabled={disabled}
            title={disabled ? "Merges from the main branch are not supported" : undefined}
            onClick={onCreate}
            className="block w-full px-3 py-1.5 text-left text-soft hover:bg-panel hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create a new proposal
          </button>
        </div>
      )}
    </div>
  );
}
