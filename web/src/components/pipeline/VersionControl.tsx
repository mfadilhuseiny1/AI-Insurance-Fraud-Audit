"use client";

import { useMemo, useState } from "react";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { evaluator, type Pipeline, uid } from "@/lib/pipeline";
import { runUnitTest } from "@/lib/unitTests";
import { useSqlEngine } from "@/lib/useSqlEngine";
import {
  contentOf,
  diff,
  isProtected,
  latestVersion,
  merge,
  type BranchContent,
  type Change,
  type Conflict,
  type MergeChoice,
  type Proposal,
  type Version,
  type VersionControl,
} from "@/lib/versioning";
import { Icon } from "../Icon";
import { DataPreview } from "./DataPreview";
import { Graph, NODE_W, OUT, type OutputNodeView } from "./Graph";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field, Switch, Tabs } from "./ui";
import { promptDialog } from "@/lib/dialogs";

export const branchesOf = (vc: VersionControl) => ["main", ...Object.values(vc.branches ?? {}).filter((b) => !b.archived).map((b) => b.name)];

// ---------------------------------------------------------------- branch menu

export function BranchMenu({ vc, branch, onSwitch, onCreate, onManage }: { vc: VersionControl; branch: string; onSwitch: (b: string) => void; onCreate: () => void; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = branchesOf(vc).filter((b) => b.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(!open)} title="Branch" className="inline-flex items-center gap-1.5 rounded-md border border-line-2 bg-panel-2 px-2 py-1 text-xs text-soft hover:text-white">
        <Icon name="split" className="h-3.5 w-3.5 text-ocean" />
        <span className="max-w-32 truncate">{branch}</span>
        {isProtected(vc, branch) && <Icon name="stop" className="h-3 w-3 text-warn" aria-label="Protected" />}
        <Icon name="down" className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-line-2 bg-panel-2 p-2 shadow-xl">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a branch…" className={`${inputClass} mb-1.5 py-1 text-xs`} />
          <ul className="max-h-64 overflow-y-auto">
            {list.map((b) => {
              const info = vc.branches?.[b];
              return (
                <li key={b}>
                  <button
                    type="button"
                    onClick={() => {
                      onSwitch(b);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${b === branch ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel"}`}
                  >
                    <Icon name="split" className="h-3.5 w-3.5 text-ocean" />
                    <span className="min-w-0 flex-1 truncate">{b}</span>
                    {info?.kind === "global" && <span className="rounded bg-violet-400/15 px-1 text-[10px] text-violet-300">global</span>}
                    {isProtected(vc, b) && <span className="text-[10px] text-warn">protected</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1.5 flex gap-1.5 border-t border-line pt-1.5">
            <button type="button" onClick={() => (setOpen(false), onCreate())} className={`${buttonClass.secondary} flex-1 justify-center py-1 text-xs`}>
              <Icon name="plus" className="h-3 w-3" /> Create new branch
            </button>
            <button type="button" onClick={() => (setOpen(false), onManage())} className={`${buttonClass.ghost} py-1 text-xs`}>
              Manage
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CreateBranchDialog({ vc, from, version, onCreate, onClose }: { vc: VersionControl; from: string; version?: Version; onCreate: (name: string, kind: "pipeline" | "global") => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"pipeline" | "global">("pipeline");
  const taken = branchesOf(vc).includes(name.trim()) || !!vc.branches?.[name.trim()];
  const bad = !/^[\w./-]+$/.test(name.trim());
  return (
    <Modal title="Create new branch" icon="split" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          A copy of <b className="text-soft">{from}</b>
          {version ? ` as saved ${when(version.at)}` : ""} you can change, preview and build without affecting it; propose to merge it back when ready.
        </p>
        <Field label="Branch name" hint="Name it like a Code Repositories branch to iterate on both together.">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/clean-dates" className={inputClass} />
        </Field>
        <div className="space-y-1 text-xs">
          <label className="flex items-start gap-2">
            <input type="radio" checked={kind === "pipeline"} onChange={() => setKind("pipeline")} className="mt-0.5" />
            <span>
              <span className="block text-soft">Pipeline Builder branch</span>
              <span className="block text-muted">Scoped to this pipeline.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={kind === "global"} onChange={() => setKind("global")} className="mt-0.5" />
            <span>
              <span className="block text-soft">Global branch</span>
              <span className="block text-muted">One branch name across applications: inputs built on a branch of the same name are read from it.</span>
            </span>
          </label>
        </div>
        {name && (taken || bad) && <p className="text-xs text-bad">{taken ? "That branch exists." : "Use letters, digits, and . / _ -"}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim() || taken || bad} onClick={() => onCreate(name.trim(), kind)} className={buttonClass.primary}>
            Create branch
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- manage branches

export function ManageBranchesDialog({ vc, onSave, onClose }: { vc: VersionControl; onSave: (vc: VersionControl) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<VersionControl>(vc);
  const [tab, setTab] = useState<"active" | "protection" | "template" | "fallbacks">("active");
  const [archived, setArchived] = useState(false);
  const [preview, setPreview] = useState(false);
  const branches = Object.values(draft.branches ?? {});
  const protection = draft.protection ?? { branches: ["main"], requireProposals: false, requireApproval: false };
  const setBranch = (name: string, patch: Partial<(typeof branches)[number]>) => setDraft({ ...draft, branches: { ...draft.branches, [name]: { ...draft.branches![name], ...patch } } });
  return (
    <Modal title="Manage branches" icon="split" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "active", label: "Active branches" },
            { id: "protection", label: "Branch protection" },
            { id: "template", label: "Proposal template" },
            { id: "fallbacks", label: "Fallback branches" },
          ]}
        />
        {tab === "active" && (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Archived branches are hidden from the branch menu and cannot be edited until restored.</span>
              <button type="button" onClick={() => setArchived(!archived)} className="text-ocean hover:underline">
                {archived ? "View active branches" : "View archived branches"}
              </button>
            </div>
            <ul className="divide-y divide-line rounded-lg border border-line text-xs">
              {!archived && (
                <li className="flex items-center gap-2 px-3 py-2">
                  <Icon name="split" className="h-3.5 w-3.5 text-ocean" /> <span className="flex-1">main</span>
                  <span className="text-muted">default branch</span>
                </li>
              )}
              {branches
                .filter((b) => !!b.archived === archived)
                .map((b) => (
                  <li key={b.name} className="flex items-center gap-2 px-3 py-2">
                    <Icon name="split" className="h-3.5 w-3.5 text-ocean" />
                    <span className="flex-1">
                      {b.name} <span className="text-muted">· {b.kind} · from {b.from} · {b.author} · {when(b.createdAt)}</span>
                    </span>
                    {archived ? (
                      <button type="button" onClick={() => setBranch(b.name, { archived: false })} className="flex items-center gap-1 text-ocean hover:underline">
                        <Icon name="restore" className="h-3.5 w-3.5" /> Restore branch
                      </button>
                    ) : (
                      <button type="button" onClick={() => setBranch(b.name, { archived: true })} className="text-muted hover:text-white">
                        Archive
                      </button>
                    )}
                  </li>
                ))}
              {!branches.filter((b) => !!b.archived === archived).length && archived && <li className="px-3 py-4 text-center text-muted">No archived branches.</li>}
            </ul>
          </>
        )}
        {tab === "protection" && (
          <div className="space-y-3 text-xs">
            <div>
              <div className="mb-1 font-medium text-soft">Protected branches</div>
              <div className="flex flex-wrap gap-1.5">
                {["main", ...branches.filter((b) => !b.archived).map((b) => b.name)].map((b) => (
                  <label key={b} className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1 ring-1 ${protection.branches.includes(b) ? "bg-ocean/15 text-white ring-ocean/50" : "text-muted ring-line-2"}`}>
                    <input
                      type="checkbox"
                      className="hidden"
                      checked={protection.branches.includes(b)}
                      onChange={(e) => setDraft({ ...draft, protection: { ...protection, branches: e.target.checked ? [...protection.branches, b] : protection.branches.filter((x) => x !== b) } })}
                    />
                    {b}
                  </label>
                ))}
              </div>
            </div>
            <div className="font-medium text-soft">General settings</div>
            <Switch
              on={protection.requireProposals}
              onChange={(v) => setDraft({ ...draft, protection: { ...protection, requireProposals: v } })}
              label="Require proposals to update protected branches"
              hint="Direct changes are blocked: change a separate branch, then propose merging it."
            />
            <Switch
              on={protection.requireApproval}
              onChange={(v) => setDraft({ ...draft, protection: { ...protection, requireApproval: v } })}
              label="Require at least one approval before merging into protected branches"
              hint="Valid approvers have edit permission and did not contribute to the proposal."
            />
          </div>
        )}
        {tab === "template" && (
          <div className="space-y-2">
            <Tabs value={preview ? "preview" : "edit"} onChange={(v) => setPreview(v === "preview")} tabs={[{ id: "edit", label: "Write" }, { id: "preview", label: "Preview" }]} />
            {preview ? (
              <div className="md-body min-h-40 rounded-md border border-line p-3 text-sm text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.proposalTemplate ?? "") }} />
            ) : (
              <textarea
                value={draft.proposalTemplate ?? ""}
                onChange={(e) => setDraft({ ...draft, proposalTemplate: e.target.value })}
                rows={10}
                placeholder={"## What changed\n\n## Why\n\n## How it was tested\n- [ ] Unit tests pass"}
                className={`${inputClass} font-mono text-xs`}
              />
            )}
            <p className="text-xs text-muted">Included in the body of every new proposal of this pipeline.</p>
          </div>
        )}
        {tab === "fallbacks" && (
          <div className="space-y-2 text-xs">
            <p className="text-muted">When an input has not been built on the current branch, builds read it from the first fallback branch that has it, then from main — as authoring fallbacks in Code Repositories.</p>
            {branches
              .filter((b) => !b.archived)
              .map((b) => (
                <label key={b.name} className="flex items-center gap-2">
                  <span className="w-40 truncate text-soft">{b.name}</span>
                  <input
                    value={(b.fallbacks ?? []).join(", ")}
                    placeholder="develop, main"
                    onChange={(e) => setBranch(b.name, { fallbacks: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                    className={`${inputClass} py-1 text-xs`}
                  />
                </label>
              ))}
            {!branches.length && <p className="text-muted">Create a branch first.</p>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSave({ ...draft, protection });
              onClose();
            }}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- viewing pipelines read-only, with differences

const asPipeline = (base: Pipeline, c: BranchContent): Pipeline => ({ ...base, ...c, id: base.id, name: base.name, datasets: base.datasets });

function outputViews(p: Pipeline): OutputNodeView[] {
  return p.outputs.map((o) => {
    const src = p.nodes.find((n) => n.id === o.node.split("#")[0]);
    return { id: o.id, name: o.name, node: o.node, kind: o.kind ?? "dataset", x: o.x ?? (src ? src.x + NODE_W + 90 : 80), y: o.y ?? src?.y ?? 80, status: "pending", detail: o.kind ?? "dataset" };
  });
}

/** A pipeline drawn read-only, with nodes ringed by their change, and a preview of the selected node. */
export function PipelineViewer({ pipeline, changes, reviewed, onMark }: { pipeline: Pipeline; changes?: Change[]; reviewed?: string[]; onMark?: (key: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [zoom, setZoom] = useState(0.8);
  const sql = useSqlEngine(pipeline.nodes.some((n) => n.kind === "transform" && n.steps.some((s) => s.kind === "sql")));
  const result = useMemo(() => evaluator(pipeline, sql, { preview: true }), [pipeline, sql]);
  const diffMap = useMemo(() => {
    const m = new Map<string, "added" | "removed" | "changed">();
    for (const c of changes ?? []) {
      if (c.moved) continue;
      if (c.group === "Nodes") m.set(c.id, c.change);
      if (c.group === "Outputs") m.set(OUT + c.id, c.change);
    }
    return m;
  }, [changes]);
  const badges = useMemo(() => {
    const m = new Map<string, { icon: "check"; title: string; tone: "ok" }[]>();
    for (const k of reviewed ?? []) {
      const [group, id] = k.split(":");
      if (group === "Nodes") m.set(id, [{ icon: "check", title: "Reviewed", tone: "ok" }]);
    }
    return m;
  }, [reviewed]);
  const single = selected.length === 1 ? pipeline.nodes.find((n) => n.id === selected[0]) : undefined;
  const r = single ? result(single.id) : null;
  const change = single ? changes?.find((c) => c.group === "Nodes" && c.id === single.id) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1">
        <Graph
          nodes={pipeline.nodes}
          outputs={outputViews(pipeline)}
          textNodes={pipeline.textNodes ?? []}
          legend={pipeline.legend}
          result={result}
          selected={selected}
          zoom={zoom}
          setZoom={setZoom}
          readOnly
          diff={diffMap}
          badges={badges}
          toolbar={null}
          onSelect={(id) => setSelected([id])}
          onClear={() => setSelected([])}
          onMoveStart={() => {}}
          onMove={() => {}}
          onOpen={() => {}}
          onContextMenu={() => {}}
          onPort={() => {}}
        />
        <div className="pointer-events-none absolute left-3 top-3 flex gap-2 text-[11px]">
          <span className="rounded bg-ok/15 px-1.5 py-0.5 text-ok ring-1 ring-ok/40">added</span>
          <span className="rounded bg-warn/15 px-1.5 py-0.5 text-warn ring-1 ring-warn/40">changed</span>
          <span className="rounded bg-bad/15 px-1.5 py-0.5 text-bad ring-1 ring-bad/40">removed</span>
        </div>
      </div>
      {single && (
        <div className="flex h-56 shrink-0 border-t border-line bg-ink">
          <div className="w-56 shrink-0 space-y-1 border-r border-line p-2 text-xs">
            <div className="font-medium">{single.name}</div>
            {change && <div className="text-warn">{change.change}</div>}
            {change && onMark && (
              <button type="button" onClick={() => onMark(change.key)} className={`${buttonClass.secondary} py-0.5 text-xs`}>
                <Icon name="check" className="h-3 w-3" /> {reviewed?.includes(change.key) ? "Reviewed" : "Mark reviewed"}
              </button>
            )}
          </div>
          {r?.table ? <DataPreview table={r.table} title={single.name} /> : <p className="p-3 text-xs text-bad">{r?.error}</p>}
        </div>
      )}
    </div>
  );
}

function ChangeList({ changes, reviewed, onToggle, onPick, picked }: { changes: Change[]; reviewed?: string[]; onToggle?: (key: string) => void; onPick?: (c: Change) => void; picked?: string }) {
  const groups = [...new Set(changes.map((c) => c.group))];
  if (!changes.length) return <p className="p-3 text-xs text-muted">No changes.</p>;
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">{g}</div>
          <ul className="space-y-0.5">
            {changes
              .filter((c) => c.group === g)
              .map((c) => (
                <li key={c.key} className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-xs ${picked === c.key ? "bg-ocean/15" : "hover:bg-panel-2"} ${reviewed?.includes(c.key) ? "opacity-60" : ""}`}>
                  {onToggle && <input type="checkbox" checked={!!reviewed?.includes(c.key)} onChange={() => onToggle(c.key)} title="Mark as reviewed" className="accent-[var(--color-ok)]" />}
                  <span className={`w-14 shrink-0 text-[10px] ${c.change === "added" ? "text-ok" : c.change === "removed" ? "text-bad" : "text-warn"}`}>{c.moved ? "moved" : c.change}</span>
                  <button type="button" onClick={() => onPick?.(c)} className="min-w-0 flex-1 truncate text-left text-soft">
                    {c.label}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ChangeDetail({ change }: { change?: Change }) {
  if (!change) return <p className="p-3 text-xs text-muted">Select a change to see it before and after.</p>;
  const show = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v, null, 1));
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-hidden p-2">
      {(["before", "after"] as const).map((side) => (
        <div key={side} className="flex min-h-0 flex-col rounded-md border border-line">
          <div className="border-b border-line px-2 py-1 text-[11px] uppercase tracking-wide text-muted">{side}</div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-2 font-mono text-[10.5px] text-soft">{show(change[side])}</pre>
        </div>
      ))}
    </div>
  );
}

/** View changes: what differs between two versions (or unsaved changes), as a list and as two graphs. */
export function ChangesDialog({ title, base, before, after, beforeLabel, afterLabel, onClose }: { title: string; base: Pipeline; before?: BranchContent; after: BranchContent; beforeLabel: string; afterLabel: string; onClose: () => void }) {
  const changes = useMemo(() => diff(before, after), [before, after]);
  const [picked, setPicked] = useState<Change | undefined>(changes[0]);
  const [mode, setMode] = useState<"list" | "graphs">("list");
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4 text-sm">
        <Icon name="layers" className="h-4 w-4 text-ocean" />
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted">
          {changes.filter((c) => !c.moved).length} changes · {beforeLabel} → {afterLabel}
        </span>
        <Tabs value={mode} onChange={setMode} className="ml-4" tabs={[{ id: "list", label: "Changes" }, { id: "graphs", label: "Split view" }]} />
        <button type="button" onClick={onClose} className={`${buttonClass.secondary} ml-auto`}>
          Close
        </button>
      </div>
      {mode === "list" ? (
        <div className="flex min-h-0 flex-1">
          <div className="w-80 shrink-0 overflow-y-auto border-r border-line p-3">
            <ChangeList changes={changes} onPick={setPicked} picked={picked?.key} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <ChangeDetail change={picked} />
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2">
          <div className="flex min-h-0 flex-col border-r border-line">
            <div className="border-b border-line px-3 py-1 text-xs text-muted">{beforeLabel}</div>
            {before ? <PipelineViewer pipeline={asPipeline(base, before)} /> : <p className="p-4 text-xs text-muted">Nothing before.</p>}
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="border-b border-line px-3 py-1 text-xs text-muted">{afterLabel}</div>
            <PipelineViewer pipeline={asPipeline(base, after)} changes={changes} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- history

export function HistoryView({
  vc,
  base,
  branch,
  onBranch,
  onCreateBranch,
}: {
  vc: VersionControl;
  base: Pipeline;
  branch: string;
  onBranch: (b: string) => void;
  onCreateBranch: (from: string, version: Version) => void;
}) {
  const [view, setView] = useState<{ kind: "details" | "changes"; version: Version } | null>(null);
  const versions = (vc.versions ?? []).filter((v) => v.branch === branch).sort((a, b) => b.at.localeCompare(a.at));
  const previous = (v: Version) => versions[versions.indexOf(v) + 1];
  if (view?.kind === "details")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-xs">
          <Icon name="eye" className="h-3.5 w-3.5 text-ocean" /> Read-only: <b>{branch}</b> as saved {when(view.version.at)} by {view.version.author}
          <button type="button" onClick={() => setView(null)} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
            Back to history
          </button>
        </div>
        <PipelineViewer pipeline={asPipeline(base, view.version.content)} />
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl p-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">History</h2>
          <select value={branch} onChange={(e) => onBranch(e.target.value)} className={`${inputClass} w-56`}>
            {[...new Set([...branchesOf(vc), ...(vc.versions ?? []).map((v) => v.branch)])].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
          <span className="text-xs text-muted">{versions.length} saved versions</span>
        </div>
        <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
          {versions.map((v) => {
            const prev = previous(v);
            const n = diff(prev?.content, v.content).filter((c) => !c.moved).length;
            return (
              <li key={v.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Icon name="save" className="h-4 w-4 text-ocean" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{v.message || "Saved"}</span>
                  <span className="block text-xs text-muted">
                    {v.author} · {when(v.at)} · {n} change{n === 1 ? "" : "s"}
                    {v.merged && ` · ${v.merged.squash ? "squashed" : "merged"} ${v.merged.versions.length} version${v.merged.versions.length === 1 ? "" : "s"} from ${v.merged.from}`}
                  </span>
                  {v.merged && !v.merged.squash && v.merged.versions.length > 0 && (
                    <span className="mt-0.5 block border-l border-line-2 pl-2 text-xs text-muted">
                      {v.merged.versions.map((m) => (
                        <span key={m.id} className="block truncate">
                          {m.message || "Saved"} — {m.author}, {when(m.at)}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <VersionActions
                  onCreateBranch={() => onCreateBranch(branch, v)}
                  onDetails={() => setView({ kind: "details", version: v })}
                  onChanges={() => setView({ kind: "changes", version: v })}
                />
              </li>
            );
          })}
          {!versions.length && <li className="px-4 py-8 text-center text-sm text-muted">No saved versions on this branch yet. Save in the Edit view to record one.</li>}
        </ul>
      </div>
      {view?.kind === "changes" && (
        <ChangesDialog
          title="View changes"
          base={base}
          before={previous(view.version)?.content}
          after={view.version.content}
          beforeLabel={previous(view.version) ? `saved ${when(previous(view.version)!.at)}` : "empty"}
          afterLabel={`saved ${when(view.version.at)}`}
          onClose={() => setView(null)}
        />
      )}
    </div>
  );
}

function VersionActions({ onCreateBranch, onDetails, onChanges }: { onCreateBranch: () => void; onDetails: () => void; onChanges: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className={`${buttonClass.secondary} py-1 text-xs`}>
        Actions <Icon name="down" className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-line-2 bg-panel-2 py-1 text-xs shadow-xl" onMouseLeave={() => setOpen(false)}>
          {[
            ["Create branch", onCreateBranch],
            ["View details", onDetails],
            ["View changes", onChanges],
          ].map(([label, run]) => (
            <button
              key={label as string}
              type="button"
              onClick={() => {
                setOpen(false);
                (run as () => void)();
              }}
              className="block w-full px-3 py-1.5 text-left text-soft hover:bg-panel hover:text-white"
            >
              {label as string}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- proposals

export function CreateProposalDialog({ vc, from, onCreate, onClose }: { vc: VersionControl; from: string; onCreate: (p: { title: string; description: string; to: string }) => void; onClose: () => void }) {
  const targets = branchesOf(vc).filter((b) => b !== from);
  const [to, setTo] = useState(targets.includes("main") ? "main" : (targets[0] ?? ""));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(vc.proposalTemplate ?? "");
  return (
    <Modal title="Create a new proposal" icon="comment" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        {from === "main" ? (
          <p className="text-xs text-bad">Merges from the main branch are not supported — create a branch, change it, then propose it.</p>
        ) : (
          <p className="text-xs text-muted">
            Requests a merge of <b className="text-soft">{from}</b> into the branch below. Its saved changes are reviewed in the proposal.
          </p>
        )}
        <div className="grid grid-cols-[1fr_12rem] gap-3">
          <Field label="Title" required>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Merge into">
            <select value={to} onChange={(e) => setTo(e.target.value)} className={inputClass}>
              {targets.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description (Markdown)">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={8} className={`${inputClass} font-mono text-xs`} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={from === "main" || !title.trim() || !to} onClick={() => onCreate({ title: title.trim(), description, to })} className={buttonClass.primary}>
            Create proposal
          </button>
        </div>
      </div>
    </Modal>
  );
}

const PROPOSAL_ICON = { open: "comment", merged: "check", closed: "x" } as const;

export function ProposalsView({
  vc,
  base,
  user,
  onChange,
  onMerge,
}: {
  vc: VersionControl;
  base: Pipeline;
  user: string;
  onChange: (vc: VersionControl) => void;
  /** writes the merged content into the target branch and records the version (squash: one version, the branch's history folded in) */
  onMerge: (proposal: Proposal, merged: BranchContent, squash: boolean) => void;
}) {
  const [filter, setFilter] = useState<"open" | "merged" | "closed" | "all">("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const proposals = (vc.proposals ?? []).filter((p) => filter === "all" || p.status === filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = (vc.proposals ?? []).find((p) => p.id === openId);
  if (current) return <ProposalView vc={vc} base={base} proposal={current} user={user} onChange={onChange} onMerge={onMerge} onBack={() => setOpenId(null)} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl p-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Proposals</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className={`${inputClass} w-40`}>
            <option value="open">Open</option>
            <option value="merged">Merged</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </div>
        <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
          {proposals.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => setOpenId(p.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-panel/60">
                <Icon name={PROPOSAL_ICON[p.status]} className={`h-4 w-4 ${p.status === "open" ? "text-ocean" : p.status === "merged" ? "text-ok" : "text-muted"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.title}</span>
                  <span className="block text-xs text-muted">
                    {p.from} → {p.to} · {p.author} · {when(p.createdAt)} · {p.status}
                  </span>
                </span>
                <span className="text-xs text-muted">{p.comments.length} comments</span>
              </button>
            </li>
          ))}
          {!proposals.length && <li className="px-4 py-8 text-center text-sm text-muted">No {filter === "all" ? "" : filter} proposals.</li>}
        </ul>
      </div>
    </div>
  );
}

function ProposalView({
  vc,
  base,
  proposal: p,
  user,
  onChange,
  onMerge,
  onBack,
}: {
  vc: VersionControl;
  base: Pipeline;
  proposal: Proposal;
  user: string;
  onChange: (vc: VersionControl) => void;
  onMerge: (proposal: Proposal, merged: BranchContent, squash: boolean) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "changes" | "tests" | "comments" | "resolve">("overview");
  const [picked, setPicked] = useState<Change | undefined>();
  const [comment, setComment] = useState("");
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const sql = useSqlEngine(true);
  const source = latestVersion(vc, p.from)?.content ?? vc.branches?.[p.from]?.content;
  const target = p.to === "main" ? contentOf(base) : vc.branches?.[p.to]?.content;
  const baseVersion = (vc.versions ?? []).find((v) => v.id === vc.branches?.[p.from]?.baseVersion)?.content;
  const changes = useMemo(() => (source ? diff(baseVersion ?? target, source).filter((c) => !c.moved) : []), [source, baseVersion, target]);
  const mergeResult = useMemo(() => (source && target ? merge(baseVersion, source, target, choices) : null), [source, target, baseVersion, choices]);
  const tests = useMemo(() => {
    if (!source) return [];
    const pl = asPipeline(base, source);
    return (pl.unitTests ?? []).map((t) => ({ test: t, run: runUnitTest(pl, t, sql) }));
  }, [source, base, sql]);
  const contributors = new Set([p.author, ...(vc.versions ?? []).filter((v) => v.branch === p.from).map((v) => v.author)]);
  const needsApproval = (vc.protection?.branches ?? []).includes(p.to) && !!vc.protection?.requireApproval;
  const approved = p.approvals.some((a) => !contributors.has(a.author));
  const testsOk = tests.every((t) => t.run.ok);
  const conflicts: Conflict[] = mergeResult?.conflicts ?? [];
  const canMerge = p.status === "open" && !!mergeResult && !conflicts.length && testsOk && (!needsApproval || approved);
  const update = (patch: Partial<Proposal>) => onChange({ ...vc, proposals: (vc.proposals ?? []).map((x) => (x.id === p.id ? { ...x, ...patch, updatedAt: new Date().toISOString() } : x)) });
  const reviewedCount = changes.filter((c) => p.reviewed.includes(c.key)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2 text-sm">
        <button type="button" onClick={onBack} className="text-muted hover:text-white">
          <Icon name="left" className="h-4 w-4" />
        </button>
        <Icon name={PROPOSAL_ICON[p.status]} className="h-4 w-4 text-ocean" />
        <span className="font-medium">{p.title}</span>
        <span className="text-xs text-muted">
          {p.from} → {p.to} · {p.status}
        </span>
        <div className="ml-4 flex min-w-40 items-center gap-2 text-xs text-muted" title="Review progress">
          <div className="h-1.5 w-28 overflow-hidden rounded bg-line-2">
            <div className="h-full bg-ok" style={{ width: `${changes.length ? (reviewedCount / changes.length) * 100 : 100}%` }} />
          </div>
          {reviewedCount}/{changes.length} reviewed
        </div>
        <div className="ml-auto flex gap-2">
          {p.status === "open" && needsApproval && (
            <button
              type="button"
              disabled={contributors.has(user) || p.approvals.some((a) => a.author === user)}
              title={contributors.has(user) ? "Contributors to the proposal cannot approve it" : "Approve"}
              onClick={() => update({ approvals: [...p.approvals, { author: user, at: new Date().toISOString() }] })}
              className={buttonClass.secondary}
            >
              <Icon name="check" className="h-3.5 w-3.5" /> Approve
            </button>
          )}
          {p.status === "open" && (
            <button type="button" onClick={() => update({ status: "closed" })} className={buttonClass.secondary}>
              Close
            </button>
          )}
          {p.status === "closed" && (
            <button type="button" onClick={() => update({ status: "open" })} className={buttonClass.secondary}>
              Reopen
            </button>
          )}
          {p.status === "open" && (
            <>
              <button
                type="button"
                disabled={!canMerge}
                title="One version on the target with a summary of the branch's versions; the branch's own versions since it was created are folded into it"
                onClick={() => mergeResult && onMerge(p, mergeResult.merged, true)}
                className={buttonClass.secondary}
              >
                Squash and merge
              </button>
              <button type="button" disabled={!canMerge} title="The target records the merge and links each version of the branch" onClick={() => mergeResult && onMerge(p, mergeResult.merged, false)} className={buttonClass.primary}>
                Merge proposal
              </button>
            </>
          )}
        </div>
      </div>
      <div className="border-b border-line px-4 py-1.5">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "changes", label: "Changes", badge: changes.length },
            { id: "tests", label: "Unit tests", badge: tests.length, tone: testsOk ? undefined : "bad" },
            { id: "comments", label: "Comments", badge: p.comments.filter((c) => !c.resolved).length },
            ...(conflicts.length || Object.keys(choices).length ? [{ id: "resolve" as const, label: "Resolve changes", badge: conflicts.length, tone: "bad" as const }] : []),
          ]}
        />
      </div>
      {tab === "overview" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-4 p-6">
            <div className="md-body rounded-md border border-line p-4 text-sm text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.description || "_No description._") }} />
            <div className="rounded-md border border-line p-3 text-sm">
              <div className="mb-2 font-medium">Merge checks</div>
              <Check ok={!conflicts.length} text={conflicts.length ? `${conflicts.length} conflicting change${conflicts.length > 1 ? "s" : ""} — resolve them` : "No merge conflicts"} />
              <Check ok={testsOk} text={tests.length ? (testsOk ? "Unit tests succeeded" : "Unit tests failed") : "No unit tests"} />
              {needsApproval && <Check ok={approved} text={approved ? `Approved by ${p.approvals.map((a) => a.author).join(", ")}` : "At least one approval from someone who did not contribute is required"} />}
              <Check ok={reviewedCount === changes.length} warnOnly text={`${reviewedCount} of ${changes.length} changes reviewed`} />
            </div>
            <p className="text-xs text-muted">
              Opened by {p.author} {when(p.createdAt)}
              {p.mergedAt ? ` · merged ${when(p.mergedAt)}` : ""}
            </p>
          </div>
        </div>
      )}
      {tab === "changes" && source && (
        <div className="flex min-h-0 flex-1">
          <div className="w-80 shrink-0 space-y-2 overflow-y-auto border-r border-line p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">
                Unreviewed {changes.length - reviewedCount} · Reviewed {reviewedCount}
              </span>
              <button type="button" onClick={() => update({ reviewed: changes.map((c) => c.key) })} className="text-ocean hover:underline">
                Mark all reviewed
              </button>
            </div>
            <ChangeList
              changes={[...changes].sort((a, b) => Number(p.reviewed.includes(a.key)) - Number(p.reviewed.includes(b.key)))}
              reviewed={p.reviewed}
              picked={picked?.key}
              onPick={setPicked}
              onToggle={(key) => update({ reviewed: p.reviewed.includes(key) ? p.reviewed.filter((x) => x !== key) : [...p.reviewed, key] })}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {picked && picked.group !== "Nodes" ? (
              <ChangeDetail change={picked} />
            ) : (
              <PipelineViewer
                pipeline={asPipeline(base, source)}
                changes={changes}
                reviewed={p.reviewed}
                onMark={(key) => update({ reviewed: p.reviewed.includes(key) ? p.reviewed.filter((x) => x !== key) : [...p.reviewed, key] })}
              />
            )}
          </div>
        </div>
      )}
      {tab === "tests" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <ul className="mx-auto max-w-3xl space-y-2">
            {tests.map(({ test, run }) => (
              <li key={test.id} className="rounded-md border border-line p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Icon name={run.ok ? "check" : "alert"} className={`h-4 w-4 ${run.ok ? "text-ok" : "text-bad"}`} />
                  <span className="font-medium">{test.name}</span>
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-soft">
                  {run.results.map((r, i) => (
                    <li key={i} className={r.ok ? "" : "text-bad"}>
                      {r.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {!tests.length && <li className="text-center text-sm text-muted">This branch has no unit tests.</li>}
          </ul>
        </div>
      )}
      {tab === "comments" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl space-y-3">
            {p.comments.map((c) => (
              <div key={c.id} className={`rounded-md border p-3 text-sm ${c.resolved ? "border-line opacity-60" : "border-line-2"}`}>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <b className="text-soft">{c.author}</b> {when(c.at)}
                  {c.item && <span className="rounded bg-panel-2 px-1">on {changes.find((x) => x.key === c.item)?.label ?? c.item}</span>}
                  {c.editedAt && <span>(edited)</span>}
                  <button type="button" onClick={() => update({ comments: p.comments.map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved } : x)) })} className="ml-auto text-ocean hover:underline">
                    {c.resolved ? "Reopen" : "Resolve"}
                  </button>
                  {c.author === user && (
                    <button
                      type="button"
                      onClick={async () => {
                        const t = (await promptDialog("Edit comment", c.text));
                        if (t !== null && t.trim()) update({ comments: p.comments.map((x) => (x.id === c.id ? { ...x, text: t.trim(), editedAt: new Date().toISOString() } : x)) });
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
            <div className="space-y-2">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Comment (Markdown)…" className={`${inputClass} text-sm`} />
              <div className="flex items-center justify-end gap-2">
                {picked && <span className="text-xs text-muted">on {picked.label}</span>}
                <button
                  type="button"
                  disabled={!comment.trim()}
                  onClick={() => {
                    update({ comments: [...p.comments, { id: uid(), author: user, text: comment.trim(), at: new Date().toISOString(), item: picked?.key }] });
                    setComment("");
                  }}
                  className={buttonClass.primary}
                >
                  Comment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {tab === "resolve" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-4xl space-y-3">
            <p className="text-sm text-muted">Both branches changed these items since the branch was created. Choose which version to keep.</p>
            {[...conflicts, ...Object.keys(choices).filter((k) => !conflicts.some((c) => c.key === k)).map((k) => ({ key: k, label: k }) as Conflict)].map((c) => (
              <div key={c.key} className="rounded-md border border-line p-3">
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{c.label}</span>
                  <label className="ml-auto flex items-center gap-1 text-xs">
                    <input type="radio" checked={choices[c.key] === "source"} onChange={() => setChoices({ ...choices, [c.key]: "source" })} /> Keep {p.from}
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="radio" checked={choices[c.key] === "target"} onChange={() => setChoices({ ...choices, [c.key]: "target" })} /> Keep {p.to}
                  </label>
                </div>
                {(c.source !== undefined || c.target !== undefined) && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <pre className="max-h-48 overflow-auto rounded bg-ink p-2 font-mono text-[10.5px] text-soft">{JSON.stringify(c.source ?? null, null, 1)}</pre>
                    <pre className="max-h-48 overflow-auto rounded bg-ink p-2 font-mono text-[10.5px] text-soft">{JSON.stringify(c.target ?? null, null, 1)}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Check({ ok, text, warnOnly }: { ok: boolean; text: string; warnOnly?: boolean }) {
  return (
    <p className={`flex items-center gap-2 text-xs ${ok ? "text-ok" : warnOnly ? "text-warn" : "text-bad"}`}>
      <Icon name={ok ? "check" : "alert"} className="h-3.5 w-3.5" /> {text}
    </p>
  );
}

