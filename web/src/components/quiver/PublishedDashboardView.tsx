"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ErrorBox } from "@/components/ontology/parts";
import { TableCardDashboard } from "@/components/quiver/TableCards";
import { useDashboardSelections, type RunWithSelections } from "@/components/quiver/useDashboardSelections";
import { quiverTables, SINGLE_CARD_KINDS, type TableResult } from "@/lib/quiverTables";
import { QuiverDashboard } from "@/components/timeseries/Quiver";
import { tsOntology, type Analysis as QuiverAnalysis, type ObjRef, type PublishedDashboard } from "@/lib/timeseries";

/**
 * A published Quiver dashboard inside another page (an Object View tab). With an object, the dashboard is opened for
 * it: its root object is that object and its object set cards of the object's type hold only it. The viewer changes
 * the selector cards' selections for their view only (the published defaults stay).
 */
export function PublishedDashboardView({ itemId, object }: { itemId: string; object?: ObjRef }) {
  const [d, setD] = useState<PublishedDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const type = object?.object_type_id;
  const pk = object?.primary_key;
  useEffect(() => {
    tsOntology.publishedDashboard(itemId, undefined, type && pk !== undefined ? { object_type_id: type, primary_key: pk } : undefined).then(
      (x) => {
        setD(x);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [itemId, type, pk]);
  const version = d?.version;
  const run = useMemo<RunWithSelections | null>(
    () => version === undefined ? null : (selections) => quiverTables.runDashboard(itemId, { version, ...(type && pk !== undefined ? { object_type_id: type, primary_key: pk } : {}), selections }).then((x) => x.tables),
    [itemId, version, type, pk],
  );
  const sel = useDashboardSelections(run, JSON.stringify([itemId, version, type, pk]));
  if (error) return <ErrorBox message={error} />;
  if (!d) return <div className="text-muted">Loading the dashboard…</div>;
  const a = d.analysis;
  const tables = dashboardTableCards(a);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-muted">
        <span className="font-medium text-soft">{a.name}</span>
        <span>version {d.version}</span>
        {object && d.bound && !d.bound.root && !d.bound.object_sets && <span className="text-warn">This dashboard has no input of this object type: it shows the same for every object.</span>}
        <SelectionsBar sel={sel} />
        <Link href={`/quiver/dashboards/${itemId}`} className="ml-auto text-ocean hover:underline">
          Open in Quiver
        </Link>
      </div>
      {sel.error && <ErrorBox message={sel.error} />}
      <QuiverDashboard key={`${d.version}|${pk ?? ""}`} analysis={a} editableInputs={!d.bound?.root} />
      {tables.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {tables.map((t) => <TableCardDashboard key={String(t.id)} card={sel.cardFor(t) as never} results={sel.results(d.tables as Record<string, TableResult>)} onSelect={sel.select} />)}
        </div>
      )}
    </div>
  );
}

/** The table-side cards (tables, charts, values, Vega plots, single cards) shown on an analysis's dashboard. */
export function dashboardTableCards(a: QuiverAnalysis) {
  return (a.object_sets ?? []).filter((x) => ["table", "chart", "value", "vega", "cross_filter", "grouped_plot", ...SINGLE_CARD_KINDS].includes(String((x as { kind?: string }).kind)) && a.dashboard.cards.includes(String(x.id)));
}

/** "Reset selections" (shown while the viewer has selections) and a note while the dashboard re-runs. */
export function SelectionsBar({ sel }: { sel: Pick<ReturnType<typeof useDashboardSelections>, "active" | "pending" | "reset"> }) {
  if (!sel.active) return null;
  return (
    <>
      {sel.pending && <span className="text-xs text-muted">Updating…</span>}
      <button type="button" onClick={sel.reset} className="text-xs text-ocean hover:underline" title="Back to the dashboard's saved selections">
        Reset selections
      </button>
    </>
  );
}
