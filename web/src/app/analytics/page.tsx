"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SourcePicker, type Sources } from "@/components/contour/Boards";
import { Icon } from "@/components/Icon";
import { AppHome } from "@/components/AppHome";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { contour, type SourceRef } from "@/lib/contour";

type Row = Awaited<ReturnType<typeof contour.list>>[number];

/** Contour: analyses of paths of boards on datasets and Ontology objects, stored in Files. */
export default function ContourHome() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sources, setSources] = useState<Sources>({ datasets: [], object_types: [] });
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled analysis");
  const [source, setSource] = useState<SourceRef | undefined>();
  useEffect(() => {
    contour.list().then(setRows, (e: Error) => setError(e.message));
    contour.sources().then(setSources, () => undefined);
  }, []);
  return (
    <AppHome
      app="Contour"
      icon="filter"
      accent="#3d8bfd"
      href="/analytics"
      tagline="Point-and-click analysis of datasets and Nexus objects: filters, joins, pivots and charts, step by step."
      description={
        <>
          Each path starts from a dataset, an object type or another path and runs boards in order — filters, expressions, joins, pivots and charts — with parameters,
          chart-to-chart filtering, dashboards and results saved as datasets.
        </>
      }
      noun={["analysis", "analyses"]}
      items={rows?.map((r) => ({ id: r.id, href: `/analytics/${r.id}`, title: r.name.replace(/\.contour$/, ""), path: (r.path ?? []).map((p) => p.name), updated_at: r.updated_at })) ?? null}
      error={error}
      empty={{ title: "Start your first analysis", hint: "Pick a dataset or an object type to start from, then add boards one after another.", steps: ["Name the analysis", "Choose a starting point", "Add filter, pivot and chart boards"] }}
      create={
        <>
          <div className="w-64">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} aria-label="Title" />
          </div>
          <div className="w-72">
            <SourcePicker value={source} sources={sources} paths={[]} onChange={setSource} />
          </div>
          <button
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              try {
                const r = await contour.create(title.trim(), source);
                router.push(`/analytics/${r.item.id}`);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> New analysis
          </button>
        </>
      }
    />
  );
}
