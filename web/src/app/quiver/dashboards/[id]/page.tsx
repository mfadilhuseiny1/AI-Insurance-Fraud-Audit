"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { dashboardTableCards, SelectionsBar } from "@/components/quiver/PublishedDashboardView";
import { TableCardDashboard } from "@/components/quiver/TableCards";
import { useDashboardSelections, type RunWithSelections } from "@/components/quiver/useDashboardSelections";
import { ApiError, Loading } from "@/components/States";
import { QuiverDashboard } from "@/components/timeseries/Quiver";
import { when } from "@/lib/format";
import { quiverTables, type TableResult } from "@/lib/quiverTables";
import { tsOntology, type PublishedDashboard } from "@/lib/timeseries";

/**
 * A published Quiver dashboard at its latest version or an earlier one. The dashboard is read-only; the viewer's
 * selections in its selector cards re-run the dependent cards for this view only (the published defaults stay).
 */
export default function PublishedDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [d, setD] = useState<PublishedDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tsOntology.publishedDashboard(id, version).then(
      (x) => {
        setD(x);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [id, version]);
  const shown = d?.version;
  const run = useMemo<RunWithSelections | null>(() => shown === undefined ? null : (selections) => quiverTables.runDashboard(id, { version: shown, selections }).then((x) => x.tables), [id, shown]);
  const sel = useDashboardSelections(run, `${id}|${shown}`);
  if (error && !d) return <ApiError message={error} />;
  if (!d) return <Loading />;
  const a = d.analysis;
  const tables = dashboardTableCards(a);
  return (
    <div className="flex-1 overflow-y-auto">
      <AppHeader app="Quiver" icon="wave" href="/quiver" crumbs={[{ label: d.item.name.replace(/\.quiver-dashboard$/, "") }]}>
        <select value={d.version} onChange={(e) => setVersion(Number(e.target.value))} className="rounded border border-line-2 bg-panel px-2 py-1 text-xs" aria-label="Version">
          {d.versions.map((v) => (
            <option key={v.version} value={v.version}>
              Version {v.version}{v.version === d.latest ? " (latest)" : ""} · {when(v.at)}{v.note ? ` · ${v.note}` : ""}
            </option>
          ))}
        </select>
        {d.analysis_exists && (
          <Link href={`/quiver/${d.analysis_id}`} className="flex items-center gap-1 rounded border border-line-2 px-2 py-1 text-xs text-ocean hover:border-ocean">
            <Icon name="pencil" className="h-3.5 w-3.5" /> Edit
          </Link>
        )}
      </AppHeader>
      <div className="mx-auto max-w-6xl space-y-3 p-6">
        <ErrorBox message={error} />
        {d.version !== d.latest && <p className="rounded bg-sand/10 px-3 py-1.5 text-xs text-sand">You are viewing version {d.version}; the latest is {d.latest}.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">{a.name}</h1>
          <SelectionsBar sel={sel} />
        </div>
        {a.description && <p className="text-sm text-muted">{a.description}</p>}
        <ErrorBox message={sel.error} />
        <QuiverDashboard key={`${d.version}`} analysis={a} />
        {tables.length > 0 && <div className="grid gap-3 md:grid-cols-2">{tables.map((t) => <TableCardDashboard key={String(t.id)} card={sel.cardFor(t) as never} results={sel.results(d.tables as Record<string, TableResult>)} onSelect={sel.select} />)}</div>}
      </div>
    </div>
  );
}
