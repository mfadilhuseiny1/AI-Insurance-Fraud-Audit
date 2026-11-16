"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { functions, type FunctionDetail } from "@/lib/actions";
import { branchRuns, type BranchFunctionRepo, type FunctionOnBranch, type RebaseResult } from "@/lib/branchRuns";
import { when } from "@/lib/format";
import { om, type BranchRow } from "@/lib/ontologyModel";

/**
 * The function on a global Nexus branch: its "Branched pre-release" versions there, the main versions the branch sees
 * (published before its base) and the newer ones it does not, and rebasing the repository's functions on the branch
 * onto main — a version target main released meanwhile needs a new target first (it blocks the branch's merge).
 */
export function FunctionBranch({ f }: { f: FunctionDetail }) {
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState("");
  const [repo, setRepo] = useState<BranchFunctionRepo | null>(null);
  // the function as the branch sees it: the version a run there uses
  const [seenAs, setSeenAs] = useState<FunctionOnBranch | null>(null);
  const [retarget, setRetarget] = useState<Record<string, string>>({});
  const [asked, setAsked] = useState(false);
  const [result, setResult] = useState<RebaseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([om.branches({ status: "open" }), functions.branchReleases(f.repo_id).catch(() => [])]).then(
      ([open, rels]) => {
        setBranches(open);
        // start on an open branch that has a pre-release of this function
        const mine = rels.filter((r) => r.functions.includes(f.name)).map((r) => r.branch);
        setBranchId((cur) => cur || open.find((b) => mine.includes(b.id))?.id || "");
      },
      () => setBranches([]),
    );
  }, [f.repo_id, f.name]);

  const load = useCallback(
    () =>
      (branchId ? Promise.all([branchRuns.functionStatus(branchId, f.repo_id), branchRuns.functionOn(branchId, f.id)]) : Promise.resolve([null, null] as const)).then(
        ([st, on]) => {
          setRepo(st?.repos[0] ?? null);
          setSeenAs(on?.branch ?? null);
          setError(null);
        },
        (e) => {
          setRepo(null);
          setSeenAs(null);
          setError((e as Error).message);
        },
      ),
    [branchId, f.repo_id, f.id],
  );
  useEffect(() => {
    load();
  }, [load]);
  const pick = (id: string) => {
    setResult(null);
    setAsked(false);
    setRetarget({});
    setBranchId(id);
  };

  const rebase = async () => {
    setBusy(true);
    setError(null);
    try {
      const wanted = Object.fromEntries(Object.entries(retarget).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      const r = await branchRuns.rebaseFunctions(branchId, f.repo_id, wanted);
      setResult(r);
      if (r.status === "needs_target") setAsked(true);
      else {
        setAsked(false);
        setRetarget({});
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const targets = (repo?.targets ?? []).filter((t) => t.functions.includes(f.name));
  const base = repo?.base ?? "";
  const seen = base ? f.versions.filter((v) => v.at <= base) : [];
  const visible = seen.length ? seen : f.versions;
  const newer = repo?.newer_on_main ?? [];
  const stale = repo?.stale_targets ?? [];
  const staleAll = [...new Set([...stale, ...(result?.stale ?? []).map((s) => s.target)])];
  const needTargets = asked || stale.length > 0;

  return (
    <Card title="On a branch" action={<Icon name="split" className="h-4 w-4 text-sand" />}>
      <div className="space-y-3 p-4 text-sm" data-testid="function-branch">
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <Field label="Branch">
            <select value={branchId} onChange={(e) => pick(e.target.value)} className={fieldClass} aria-label="Branch">
              <option value="">Choose an open branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          {branchId && (
            <button
              type="button"
              disabled={busy || !repo || (!repo.rebase_available && !stale.length)}
              onClick={rebase}
              className={buttonClass.primary}
              title="Main versions published since the branch's base become visible on the branch"
            >
              <Icon name="refresh" className="h-3.5 w-3.5" /> {busy ? "Rebasing…" : "Rebase onto main"}
            </button>
          )}
          {branches.length === 0 && <span className="text-muted">No open Nexus branches.</span>}
        </div>
        <ErrorBox message={error} />
        {branchId && seenAs && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="branch-uses">
            <span className="text-muted">Runs on {seenAs.name ?? "this branch"} use</span>
            <span className="font-mono">{seenAs.resolves.version ?? "no version"}</span>
            {seenAs.resolves.branched ? <Badge status="paused" label="Branched pre-release" /> : <Badge status="example" label="Main version" />}
            {seenAs.resolves.target && <span className="text-muted">towards {seenAs.resolves.target}</span>}
          </p>
        )}
        {branchId && repo && (
          <>
            <div>
              <div className="mb-1 text-xs font-medium text-soft">Branched pre-releases of {f.name}</div>
              {targets.length === 0 ? (
                <p className="text-xs text-muted">None on this branch: runs there use the main versions below.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {targets.map((t) => (
                    <li key={t.target} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="font-mono">{t.version}</span>
                      <Badge status="paused" label="Branched pre-release" />
                      <span className="text-muted">
                        target {t.target} · {when(t.at)}
                      </span>
                      {t.stale && <Badge status="failed" label="Target released on main" />}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="mb-1 font-medium text-soft">Main versions the branch sees</div>
                <div className="flex flex-wrap gap-1">
                  {visible.map((v) => (
                    <span key={v.version} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-soft ring-1 ring-line-2">
                      {v.version}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-muted">Base {base ? when(base) : "—"}</p>
              </div>
              <div>
                <div className="mb-1 font-medium text-soft">Newer on main</div>
                {newer.length ? (
                  <div className="flex flex-wrap gap-1" data-testid="newer-on-main">
                    {newer.map((v) => (
                      <span key={v} className="rounded bg-ocean/15 px-1.5 py-0.5 font-mono text-ocean ring-1 ring-ocean/30">
                        {v}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted">Up to date with main.</p>
                )}
                {newer.length > 0 && <p className="mt-1 text-muted">Off the branch until it rebases.</p>}
              </div>
            </div>
            {needTargets && staleAll.length > 0 && (
              <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs" data-testid="retarget">
                <p className="mb-2 text-warn">
                  Main released {staleAll.join(", ")} while the branch was open: choose a new version target (it blocks
                  the merge until then).
                </p>
                {staleAll.map((old) => (
                  <label key={old} className="mr-3 inline-flex items-center gap-2">
                    <span className="font-mono">{old} →</span>
                    <input
                      value={retarget[old] ?? ""}
                      onChange={(e) => setRetarget({ ...retarget, [old]: e.target.value })}
                      placeholder="1.3.0"
                      className={`${fieldClass} w-24 font-mono`}
                      aria-label={`New target for ${old}`}
                    />
                  </label>
                ))}
              </div>
            )}
            {result?.status === "rebased" && (
              <div className="rounded-lg border border-ok/40 bg-ok/10 p-3 text-xs" data-testid="rebased">
                <p className="text-ok">Rebased {result.rebased_at ? when(result.rebased_at) : ""}: the branch now sees main&apos;s newer versions.</p>
                {!!result.dependents?.length && (
                  <ul className="mt-1 list-disc pl-5 text-soft">
                    {result.dependents.map((d) => (
                      <li key={`${d.kind}:${d.id}:${d.function}`}>
                        {d.kind === "workshop" ? (
                          <Link href={`/workshop/${d.id}${d.on_branch ? `?branch=${branchId}` : ""}`} className="text-ocean hover:underline">
                            {d.name}
                          </Link>
                        ) : (
                          d.name
                        )}{" "}
                        pins {d.function} {d.version}: update it to {d.new_target}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
