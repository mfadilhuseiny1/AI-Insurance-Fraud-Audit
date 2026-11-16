import { API_URL } from "@/lib/api";
import type { FnResult, FunctionDetail } from "@/lib/actions";
import type { LogicRun } from "@/lib/ontology";

/**
 * Running on a global Nexus branch (api/ontology_branches.py, api/functions_registry.py): AIP Logic runs on a branch,
 * the function versions they used, and a function's state on a branch (rebase onto main, stale version targets).
 */

/** A function version a run on a branch used: the branch's "Branched pre-release" or a main version it sees. */
export type RanFunction = { function_id: string; function: string; repo_id: string; version: string; branched: boolean; status: string; calls: number };

/** A Logic run's scenario part when it ran on a global branch. */
export type BranchRunScenario = { id: string; name?: string; branch_id?: string; branch_name?: string; functions?: RanFunction[] };

export type BranchFunctionTarget = { target: string; version: string; functions: string[]; at: string; stale: boolean };
export type BranchFunctionRepo = {
  repo_id: string;
  repository: string;
  base: string;
  newer_on_main: string[];
  rebase_available: boolean;
  targets: BranchFunctionTarget[];
  stale_targets: string[];
};
export type BranchFunctionStatus = {
  branch_id: string;
  branch_name: string;
  branch_status: string;
  repos: BranchFunctionRepo[];
  rebase_available: boolean;
  stale_targets: { repo_id: string; repository: string; target: string }[];
};
export type RebaseResult = {
  status: "rebased" | "needs_target";
  rebased_at?: string;
  stale?: { repo_id: string; repository: string; target: string }[];
  repos: BranchFunctionRepo[];
  dependents?: { kind: string; id: string; name: string; version?: string; function: string; old_target: string; new_target: string; on_branch?: boolean }[];
};

/** The branch part of a function run (its result and its row in the run history). */
export type FnRunBranch = { id: string; name?: string | null; branched: boolean };
/** A function as an open branch sees it: what a run there uses, its Branched pre-releases, main versions seen / newer. */
export type FunctionOnBranch = {
  id: string;
  name?: string | null;
  resolves: { version: string | null; branched: boolean; target: string | null };
  base: string;
  visible_versions: string[];
  newer_on_main: string[];
  branched: { version: string; target: string; at: string; by?: string; label: string }[];
};

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText));
  return body as T;
}

const enc = encodeURIComponent;

export const branchRuns = {
  /** AIP Logic on the branch: its objects, applied edits stay on the branch, function-backed actions run its versions */
  runLogic: (branchId: string, logicId: string, inputs: Record<string, unknown>, apply: boolean) =>
    call<LogicRun & { scenario?: BranchRunScenario | null }>(`/api/ontology/branches/${enc(branchId)}/logic/${enc(logicId)}/run`, {
      method: "POST",
      json: { inputs, apply },
    }),
  /** the function as the branch sees it (refused for a branch that merged or closed) */
  functionOn: (branchId: string, functionId: string) => call<FunctionDetail & { branch?: FunctionOnBranch }>(`/api/functions/${enc(functionId)}?branch=${enc(branchId)}`),
  /** run a function on the branch: its Branched pre-release when it has one, the branch's objects for its reads */
  executeFunction: (branchId: string, functionId: string, inputs: Record<string, unknown>, version?: string) =>
    call<FnResult & { branch?: FnRunBranch }>(`/api/functions/${enc(functionId)}/execute`, { method: "POST", json: { inputs, version, branch: branchId } }),
  /** a repository's functions on the branch: newer main versions, version targets (stale when main released them) */
  functionStatus: (branchId: string, repoId: string) => call<BranchFunctionStatus>(`/api/functions/branches/${enc(branchId)}/status?repo_id=${enc(repoId)}`),
  /** rebase the repository's functions on the branch onto main; a stale target needs a new one (retarget: old → new) */
  rebaseFunctions: (branchId: string, repoId: string, retarget: Record<string, string> = {}) =>
    call<RebaseResult>(`/api/functions/branches/${enc(branchId)}/rebase`, { method: "POST", json: { repo_id: repoId, retarget } }),
};
