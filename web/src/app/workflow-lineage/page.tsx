"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { wl } from "@/lib/workflowLineage";

/** Workflow Lineage (palantir.com/docs/foundry/workflow-lineage): saved graphs and a new one. */
export default function WorkflowLineageHome() {
  const [graphs, setGraphs] = useState<Awaited<ReturnType<typeof wl.graphs>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    wl.graphs().then(setGraphs, (e: Error) => setErr(e.message));
  }, []);
  return (
    <div className="flex h-full flex-col">
      <AppHeader app="Workflow Lineage" icon="split" href="/workflow-lineage">
        <Link href="/workflow-lineage/new" className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New graph
        </Link>
      </AppHeader>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <div className="rounded-xl border border-line bg-panel p-5 text-sm text-soft">
            <h1 className="text-lg font-semibold text-white">Workflow Lineage</h1>
            <p className="mt-1 max-w-3xl">
              The objects, actions, functions, AIP Logic, automations, models and applications behind a workflow, and how they depend on each other. Color the graph by health, usage, status or a user&apos;s
              permissions; trace where each property is used; upgrade functions, copy submission criteria and replace models in bulk.
            </p>
          </div>
          {err && <p className="text-sm text-bad">{err}</p>}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
            {graphs?.map((g) => (
              <Link key={g.id} href={`/workflow-lineage/${g.id}`} className="rounded-xl border border-line bg-panel p-4 hover:border-ocean">
                <div className="font-medium">{g.name}</div>
                <div className="mt-1 text-xs text-muted">
                  {g.nodes} nodes · {g.frames} frames
                </div>
                <div className="mt-1 text-[11px] text-muted">{when(g.updated_at)}</div>
              </Link>
            ))}
            {graphs?.length === 0 && <p className="text-sm text-muted">No saved graphs yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
