"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { fmtTime, lifetime, type LifetimeDataset, type LifetimePolicy } from "@/lib/securityGov";

/** Dataset Preview → Details → Lineage-aware retention policies (Data Lifetime). */
export function LifetimePanel({ datasetId }: { datasetId: string }) {
  const { me, enabled } = useAuth();
  const dgo = !enabled || me?.role === "admin";
  const [v, setV] = useState<LifetimeDataset | null>(null);
  const [policies, setPolicies] = useState<LifetimePolicy[]>([]);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    lifetime.dataset(datasetId).then(setV, (e: Error) => setError(e.message));
    lifetime.policies().then(setPolicies, () => {});
  }, [datasetId]);
  useEffect(load, [load]);
  const act = (p: Promise<LifetimeDataset>) => p.then(setV, (e: Error) => setError(e.message));
  if (!v) return <p className="text-xs text-muted">{error ?? "Loading…"}</p>;
  const app = v.application;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Lineage-aware deletion policies (<Link href="/data-lifetime" className="text-ocean hover:underline">Data Lifetime</Link>) give this dataset&apos;s transactions deletion dates; datasets built from it inherit them. Retention policies are separate and not lineage-aware.</p>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="rounded border border-line p-3 text-xs">
        {app ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>{app.override ? (app.policy ? <>Override with <b>{app.policy_name}</b></> : <b>Override without a superseding policy</b>) : <>Policy <b>{app.policy_name}</b></>}</span>
            <span className="text-muted">· {app.by} · {fmtTime(app.at)}</span>
            {app.override ? dgo && <button type="button" className={`${buttonClass.ghost} ml-auto text-xs`} onClick={() => act(lifetime.removeOverride(datasetId))}>Remove override</button>
              : <button type="button" className={`${buttonClass.ghost} ml-auto text-xs`} onClick={() => app.policy && act(lifetime.unapply(app.policy, datasetId))}>Remove policy from dataset</button>}
          </div>
        ) : v.inherited.length ? <span>Deletion dates inherited from upstream dataset(s) {v.inherited.map((i) => <Link key={i} href={`/datasets/${i}`} className="text-ocean hover:underline">{i}</Link>)}</span>
          : <span className="text-muted">No Data Lifetime policy applies to this dataset.</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className={fieldClass} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose a policy…</option>
          {policies.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type === "fixed" ? `delete ${fmtTime(p.deletion_date)}` : "latest view only"})</option>)}
        </select>
        <button type="button" className={buttonClass.secondary} disabled={!pick || !!app?.override} onClick={() => act(lifetime.apply(pick, datasetId))}>Apply to this dataset</button>
        {dgo && <button type="button" className={buttonClass.secondary} disabled={!pick} onClick={() => act(lifetime.override(datasetId, pick))}>Override inherited policies</button>}
        {dgo && <button type="button" className={buttonClass.secondary} onClick={() => act(lifetime.override(datasetId, null))}>Override without superseding policy</button>}
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-muted"><tr className="border-b border-line">{["Transaction", "Committed", "Deletion date", "From"].map((h) => <th key={h} className="py-1.5 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {v.transactions.map((t) => (
            <tr key={t.id} className="border-b border-line/50">
              <td className="py-1.5 pr-3 font-mono">{t.id}</td>
              <td className="py-1.5 pr-3 text-muted">{fmtTime(t.at)}</td>
              <td className={`py-1.5 pr-3 ${t.deleted_at ? "text-muted line-through" : t.deletion_date ? "text-warn" : "text-muted"}`}>{t.deleted_at ? `deleted ${fmtTime(t.deleted_at)}` : t.deletion_date ? fmtTime(t.deletion_date) : "—"}</td>
              <td className="py-1.5 pr-3 text-muted">{t.policy_name ?? ""}{t.inherited_from ? ` (inherited from ${t.inherited_from})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
