/**
 * Version control for pipelines, kept inside the .pipeline file (`vc`):
 *
 * - main's working copy is the file's top level (as before branches existed); every other branch keeps
 *   its working copy in vc.branches[name].content. Datasets are shared by all branches (top level).
 * - Save records a version of the branch (vc.versions); History lists them, View details opens one
 *   read-only, View changes diffs it with the version before it.
 * - A proposal asks to merge a branch into another; its Changes tab lists what differs, reviewers mark
 *   items reviewed, protected branches can require proposals and an approval; merging is three-way
 *   against the version the branch was created from, with conflicts resolved item by item.
 */
import { uid, type Pipeline } from "./pipeline";

/** What a branch / version holds: the pipeline without its identity, location, shared datasets or vc. */
export type BranchContent = Omit<Pipeline, "id" | "name" | "location" | "datasets" | "createdAt" | "updatedAt"> & { datasets?: Pipeline["datasets"] };

export type Version = {
  id: string;
  branch: string;
  at: string;
  author: string;
  message?: string;
  content: BranchContent;
  parent?: string;
  /** a merged proposal: the source branch's versions it brought in (a squash merge folds them into this one) */
  merged?: { from: string; proposal: string; squash: boolean; versions: { id: string; at: string; author: string; message?: string }[] };
};
export type BranchInfo = {
  name: string;
  kind: "pipeline" | "global";
  createdAt: string;
  author: string;
  /** the branch and version it was created from (the merge base) */
  from: string;
  baseVersion?: string;
  archived?: boolean;
  /** branches read (in order) when an input was not built on this branch */
  fallbacks?: string[];
  content: BranchContent;
};
export type ProposalComment = { id: string; author: string; text: string; at: string; item?: string; resolved?: boolean; editedAt?: string };
export type Proposal = {
  id: string;
  title: string;
  description: string;
  from: string;
  to: string;
  status: "open" | "merged" | "closed";
  author: string;
  createdAt: string;
  updatedAt: string;
  reviewed: string[];
  approvals: { author: string; at: string }[];
  comments: ProposalComment[];
  mergedAt?: string;
  mergedVersion?: string;
};
export type VersionControl = {
  branches?: Record<string, BranchInfo>;
  versions?: Version[];
  proposals?: Proposal[];
  protection?: { branches: string[]; requireProposals: boolean; requireApproval: boolean };
  proposalTemplate?: string;
  /** main's settings when it was created */
  main?: { fallbacks?: string[] };
};

const KEEP_VERSIONS = 150;

export function contentOf(p: Pipeline): BranchContent {
  const { id: _i, name: _n, location: _l, datasets: _d, createdAt: _c, updatedAt: _u, ...rest } = p as Pipeline & { vc?: unknown };
  void _i;
  void _n;
  void _l;
  void _d;
  void _c;
  void _u;
  delete (rest as { vc?: unknown }).vc;
  return rest;
}

/** The pipeline seen on a branch: shared parts (datasets, name, location) with the branch's content. */
export function onBranch(base: Pipeline, vc: VersionControl | undefined, branch: string): Pipeline {
  if (branch === "main" || !vc?.branches?.[branch]) return base;
  return { ...base, ...vc.branches[branch].content, id: base.id, name: base.name, location: base.location, datasets: base.datasets };
}

export function latestVersion(vc: VersionControl | undefined, branch: string): Version | undefined {
  return (vc?.versions ?? []).filter((v) => v.branch === branch).sort((a, b) => b.at.localeCompare(a.at))[0];
}

export function addVersion(
  vc: VersionControl,
  branch: string,
  content: BranchContent,
  author: string,
  message?: string,
  merged?: Version["merged"],
): { vc: VersionControl; version: Version } {
  const parent = latestVersion(vc, branch)?.id;
  const version: Version = { id: uid(), branch, at: new Date().toISOString(), author, message, content: strip(content), parent, ...(merged ? { merged } : {}) };
  // keep the newest versions of each branch (and every version a branch or proposal is based on)
  const all = [...(vc.versions ?? []), version];
  const pinned = new Set([...Object.values(vc.branches ?? {}).map((b) => b.baseVersion), ...(vc.proposals ?? []).map((p) => p.mergedVersion)].filter(Boolean) as string[]);
  const byBranch = new Map<string, Version[]>();
  for (const v of all) (byBranch.get(v.branch) ?? byBranch.set(v.branch, []).get(v.branch)!).push(v);
  const kept = [...byBranch.values()].flatMap((list) => list.sort((a, b) => b.at.localeCompare(a.at)).filter((v, i) => i < KEEP_VERSIONS || pinned.has(v.id)));
  return { vc: { ...vc, versions: kept }, version };
}

/** Content without what does not belong in a version (datasets are shared, runtime-only fields). */
function strip(c: BranchContent): BranchContent {
  const { datasets: _d, ...rest } = c;
  void _d;
  return JSON.parse(JSON.stringify(rest));
}

// ---------------------------------------------------------------- diff

export type ChangeKind = "added" | "removed" | "changed";
export type Change = { key: string; group: "Nodes" | "Outputs" | "Text nodes" | "Settings"; id: string; label: string; change: ChangeKind; before?: unknown; after?: unknown; moved?: boolean };

type Keyed = { id: string; name?: string };
const SETTINGS: (keyof BranchContent)[] = ["parameters", "functions", "subgraphs", "schedules", "buildSettings", "jobGroups", "unitTests", "evalSuites", "legend", "folders", "compute", "external", "type", "showConversionChecks"];
const noPos = (x: unknown) => {
  if (!x || typeof x !== "object") return x;
  const { x: _x, y: _y, ...rest } = x as Record<string, unknown>;
  void _x;
  void _y;
  return rest;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffKeyed<T extends Keyed>(group: Change["group"], before: T[] = [], after: T[] = [], label: (t: T) => string): Change[] {
  const out: Change[] = [];
  const b = new Map(before.map((x) => [x.id, x]));
  const a = new Map(after.map((x) => [x.id, x]));
  for (const [id, x] of a) {
    const old = b.get(id);
    if (!old) out.push({ key: `${group}:${id}`, group, id, label: label(x), change: "added", after: x });
    else if (!same(noPos(old), noPos(x))) out.push({ key: `${group}:${id}`, group, id, label: label(x), change: "changed", before: old, after: x });
    else if (!same(old, x)) out.push({ key: `${group}:${id}`, group, id, label: label(x), change: "changed", before: old, after: x, moved: true });
  }
  for (const [id, x] of b) if (!a.has(id)) out.push({ key: `${group}:${id}`, group, id, label: label(x), change: "removed", before: x });
  return out;
}

/** What changed from `before` to `after` (moves of nodes are changes flagged `moved`). */
export function diff(before: BranchContent | undefined, after: BranchContent): Change[] {
  const b = before ?? ({ nodes: [], outputs: [], legend: [], type: after.type } as unknown as BranchContent);
  return [
    ...diffKeyed("Nodes", b.nodes, after.nodes, (n) => n.name),
    ...diffKeyed("Outputs", b.outputs, after.outputs, (o) => o.name),
    ...diffKeyed("Text nodes", b.textNodes ?? [], after.textNodes ?? [], (t) => t.text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 40) || "Text node"),
    ...SETTINGS.flatMap((k): Change[] => {
      const x = (b as Record<string, unknown>)[k];
      const y = (after as Record<string, unknown>)[k];
      if (same(x ?? null, y ?? null)) return [];
      return [{ key: `Settings:${k}`, group: "Settings", id: String(k), label: SETTING_LABEL[k] ?? String(k), change: x === undefined ? "added" : y === undefined ? "removed" : "changed", before: x, after: y }];
    }),
  ];
}
const SETTING_LABEL: Record<string, string> = {
  parameters: "Parameters",
  functions: "Custom functions",
  subgraphs: "Subgraphs",
  schedules: "Schedules",
  buildSettings: "Build settings",
  jobGroups: "Job groups",
  unitTests: "Unit tests",
  evalSuites: "Evaluation suites",
  legend: "Color legend",
  folders: "Folders",
  compute: "Pipeline type",
  external: "External source",
  type: "Pipeline type",
  showConversionChecks: "Conversion checks",
};

// ---------------------------------------------------------------- three-way merge

export type Conflict = { key: string; label: string; base?: unknown; source?: unknown; target?: unknown };
export type MergeChoice = "source" | "target";

function mergeKeyed<T extends Keyed>(group: string, base: T[] = [], source: T[] = [], target: T[] = [], choose: (key: string) => MergeChoice | undefined, conflicts: Conflict[], label: (t: T) => string): T[] {
  const ids = [...new Set([...target.map((x) => x.id), ...source.map((x) => x.id), ...base.map((x) => x.id)])];
  const by = (list: T[]) => new Map(list.map((x) => [x.id, x]));
  const B = by(base);
  const S = by(source);
  const T = by(target);
  const out: T[] = [];
  for (const id of ids) {
    const b = B.get(id);
    const s = S.get(id);
    const t = T.get(id);
    const sChanged = !same(b, s);
    const tChanged = !same(b, t);
    let pick: T | undefined;
    if (!sChanged) pick = t;
    else if (!tChanged) pick = s;
    else if (same(noPos(s), noPos(t))) pick = t;
    else {
      const key = `${group}:${id}`;
      const c = choose(key);
      if (!c) conflicts.push({ key, label: label((s ?? t ?? b)!), base: b, source: s, target: t });
      pick = c === "source" ? s : t;
    }
    if (pick) out.push(pick);
  }
  return out;
}

/** Merges `source` into `target` given their common `base`; conflicting items need a choice. */
export function merge(base: BranchContent | undefined, source: BranchContent, target: BranchContent, choices: Record<string, MergeChoice> = {}): { merged: BranchContent; conflicts: Conflict[] } {
  const b = base ?? target;
  const conflicts: Conflict[] = [];
  const choose = (key: string) => choices[key];
  const merged: BranchContent = {
    ...target,
    nodes: mergeKeyed("Nodes", b.nodes, source.nodes, target.nodes, choose, conflicts, (n) => n.name),
    outputs: mergeKeyed("Outputs", b.outputs, source.outputs, target.outputs, choose, conflicts, (o) => o.name),
    textNodes: mergeKeyed("Text nodes", b.textNodes ?? [], source.textNodes ?? [], target.textNodes ?? [], choose, conflicts, () => "Text node"),
  };
  for (const k of SETTINGS) {
    const x = (b as Record<string, unknown>)[k];
    const s = (source as Record<string, unknown>)[k];
    const t = (target as Record<string, unknown>)[k];
    let v = t;
    if (!same(x, s) && same(x, t)) v = s;
    else if (!same(x, s) && !same(x, t) && !same(s, t)) {
      const key = `Settings:${k}`;
      const c = choose(key);
      if (!c) conflicts.push({ key, label: SETTING_LABEL[k] ?? String(k), base: x, source: s, target: t });
      v = c === "source" ? s : t;
    }
    (merged as Record<string, unknown>)[k] = v;
  }
  return { merged, conflicts };
}

export const isProtected = (vc: VersionControl | undefined, branch: string) => (vc?.protection?.branches ?? []).includes(branch) && !!vc?.protection?.requireProposals;
