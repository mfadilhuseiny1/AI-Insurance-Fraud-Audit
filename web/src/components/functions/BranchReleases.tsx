"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { functions, type BranchRelease, type FunctionDetail } from "@/lib/actions";
import { om, type BranchRow } from "@/lib/ontologyModel";

/**
 * Global branches: the function's branched pre-releases (used only on their Ontology branch) and publishing the
 * repository's code towards a version target on a branch. Merging the branch publishes the target on main.
 */
export function BranchReleases({ f }: { f: FunctionDetail }) {
  const [rows, setRows] = useState<BranchRelease[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [form, setForm] = useState({ branch_id: "", version_target: "", ref: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => functions.branchReleases(f.repo_id).then((r) => setRows(r.filter((x) => x.functions.includes(f.name))), () => setRows([])), [f.repo_id, f.name]);
  useEffect(() => {
    void load();
    om.branches({ status: "open" }).then(setBranches, () => setBranches([]));
  }, [load]);
  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await functions.publishBranch({ repo_id: f.repo_id, version_target: form.version_target.trim(), branch_id: form.branch_id, ref: form.ref.trim() || undefined });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Global branches" count={rows.length}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          Publish on an{" "}
          <Link href="/ontology?tab=branches" className="text-ocean hover:underline">
            Nexus branch
          </Link>{" "}
          towards a version target: runs on that branch use the newest branched pre-release, other branches and main keep their versions. Merging the branch publishes the target on
          main; closing it drops the branched versions.
        </p>
        <div className="divide-y divide-line rounded-lg border border-line">
          {rows.map((r) => (
            <div key={r.version} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-xs">{r.version}</span>
              <Badge status="paused" label="Branched pre-release" />
              <span className="text-xs text-muted">
                target {r.target} · {r.branch_name ?? r.branch} · {when(r.at)}
                {r.by ? ` · ${r.by}` : ""} · commit <span className="font-mono">{r.commit.slice(0, 8)}</span>
              </span>
            </div>
          ))}
          {rows.length === 0 && <p className="px-3 py-3 text-xs text-muted">No branched pre-releases.</p>}
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <Field label="Branch">
            <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} className={fieldClass}>
              <option value="">Choose…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Version target">
            <input value={form.version_target} onChange={(e) => setForm({ ...form, version_target: e.target.value })} placeholder="1.3.0" className={`${fieldClass} w-24`} />
          </Field>
          <Field label="Code branch or commit (optional)">
            <input value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} placeholder="default branch" className={`${fieldClass} w-40`} />
          </Field>
          <button type="button" disabled={busy || !form.branch_id || !form.version_target.trim()} onClick={publish} className={buttonClass.primary}>
            {busy ? "Publishing…" : "Publish on branch"}
          </button>
        </div>
        <ErrorBox message={error} />
      </div>
    </Card>
  );
}
