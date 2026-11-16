"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge } from "@/components/ontology/parts";
import { ApiError } from "@/components/States";
import { when } from "@/lib/format";
import { om, type ProposalRow } from "@/lib/ontologyModel";

const TABS = [
  ["mine", "My proposals"],
  ["assigned", "Assigned to me"],
  ["review", "In review"],
  ["merged", "Merged proposals"],
  ["closed", "Closed proposals"],
] as const;

/** Ontology proposals, like pull requests for ontology branches. */
export default function ProposalsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("review");
  const [state, setState] = useState<{ tab: string; rows: ProposalRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    om.proposals(tab).then((rows) => setState({ tab, rows }), (e: Error) => setError(e.message));
  }, [tab]);
  const rows = state?.tab === tab ? state.rows : null;
  if (error) return <ApiError message={error} />;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology" crumbs={[{ label: "Proposals" }]} />
      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 border-r border-line bg-panel p-2 text-sm">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`flex w-full rounded-md px-3 py-2 text-left ${tab === k ? "bg-ocean/15 font-medium text-white" : "text-soft hover:bg-panel-2"}`}>
              {label}
            </button>
          ))}
        </nav>
        <section className="dot-grid min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl p-8">
            <h1 className="text-xl font-semibold">{TABS.find(([k]) => k === tab)?.[1]}</h1>
            <p className="mt-1 text-sm text-muted">A proposal reviews a branch&apos;s changes, one task per resource, before they merge into main.</p>
            <div className="mt-5 overflow-hidden rounded-xl border border-line bg-panel">
              {rows?.length === 0 && <p className="p-6 text-center text-sm text-muted">No proposals here.</p>}
              {rows?.map((p) => (
                <button key={p.id} type="button" onClick={() => router.push(`/ontology/branches/${p.branch_id}`)} className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm last:border-0 hover:bg-panel-2">
                  <Icon name="split" className="h-4 w-4 text-ocean" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{p.title}</div>
                    <div className="text-xs text-muted">
                      {p.branch} · {p.change_count} changes · {p.reviewers.length} reviewers · {p.comments.length} comments
                    </div>
                  </div>
                  <Badge status={p.status} />
                  <span className="w-28 text-right text-xs text-muted">{when(p.updated_at)}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
