"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { tsOntology, type Analysis } from "@/lib/timeseries";

export default function QuiverHome() {
  return (
    <Suspense>
      <Analyses />
    </Suspense>
  );
}

/** Quiver: time series analyses over objects, and their dashboards. */
function Analyses() {
  const router = useRouter();
  const params = useSearchParams();
  const [list, setList] = useState<Analysis[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const create = async (type?: string | null, pk?: string | null) => {
    const root = type && pk ? { object_type_id: type, primary_key: pk } : null;
    let cards: Analysis["logic"]["cards"] = [];
    if (root) {
      const tsps = await tsOntology.objectTsps(root.object_type_id, root.primary_key).catch(() => []);
      const first = tsps.find((t) => t.default) ?? tsps[0];
      if (first) cards = [{ id: "A", type: "tsp", title: first.label, config: { property: first.key } }];
    }
    const a = await tsOntology.createAnalysis({ name: "Untitled analysis", root, logic: { cards }, plots: [{ id: "p1", title: "Plot 1", cards: cards.map((c) => c.id) }], range: { last: "7d" } });
    router.push(`/quiver/${a.id}`);
  };
  useEffect(() => {
    tsOntology.analyses().then(setList, (e: Error) => setError(e.message));
    if (params.get("new") && !started.current) {
      started.current = true;
      create(params.get("type"), params.get("pk")).catch((e: Error) => setError(e.message));
    }
    // create runs once for ?new=1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const newButton = (
    <button type="button" onClick={() => create().catch((e: Error) => setError(e.message))} className={buttonClass.primary}>
      <Icon name="plus" className="h-4 w-4" /> New analysis
    </button>
  );
  return (
    <AppHome
      app="Quiver"
      icon="wave"
      accent="#14b8a6"
      href="/quiver"
      tagline="Time series analysis of objects and their sensors with point-and-click cards, plots and dashboards."
      description={
        <>
          Analyze time series properties of objects and their linked sensors with point-and-click cards — formulas, rolling and periodic aggregates, time series search — overlay them in plots,
          publish a dashboard for Workshop, and save any card as a derived series. Start from a time series object type in the{" "}
          <Link href="/time-series?tab=object-types" className="text-ocean hover:underline">
            Time Series Catalog
          </Link>
          .
        </>
      }
      headerActions={newButton}
      create={
        <>
          <Link href="/time-series?tab=object-types" className={buttonClass.secondary}>
            <Icon name="wave" className="h-3.5 w-3.5" /> From the Time Series Catalog
          </Link>
        </>
      }
      noun={["analysis", "analyses"]}
      items={
        list?.map((a) => ({
          id: a.id,
          href: `/quiver/${a.id}`,
          title: a.name,
          updated_at: a.updated_at,
          detail: a.description || undefined,
          meta: `${a.card_count ?? 0} cards · ${a.plots.length} plots`,
        })) ?? null
      }
      error={error}
      empty={{
        title: "Start your first analysis",
        hint: "Start one here, or from a time series object type in the Time Series Catalog.",
        steps: ["Click New analysis", "Add time series and formula cards", "Overlay them in plots and publish a dashboard"],
      }}
    />
  );
}
