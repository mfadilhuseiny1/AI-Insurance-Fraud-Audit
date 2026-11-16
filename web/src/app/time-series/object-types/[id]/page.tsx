"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { ObjectSeries } from "@/components/timeseries/ObjectSeries";
import { ontology, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { tsOntology, type TsObjectType } from "@/lib/timeseries";

/** A time series object type in the catalog: its objects, and every time series of the selected one. */
export default function TsObjectTypePage() {
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<ObjectType | null>(null);
  const [info, setInfo] = useState<TsObjectType | null>(null);
  const [objects, setObjects] = useState<OntologyObject[] | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ontology.objectType(id).then(setT, (e: Error) => setError(e.message));
    tsOntology.objectTypes().then((ts) => setInfo(ts.find((x) => x.id === id) ?? null), () => {});
    tsOntology.viewed("object_type", id);
  }, [id]);
  useEffect(() => {
    const timer = setTimeout(() => ontology.objects(id, q).then((r) => setObjects(r.objects), (e: Error) => setError(e.message)), 200);
    return () => clearTimeout(timer);
  }, [id, q]);
  if (error) return <ApiError message={error} />;
  if (!t) return <Loading />;
  const current = selected ?? objects?.[0]?.primary_key ?? null;
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <Link href="/time-series?tab=object-types" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-white">
          <Icon name="left" className="h-3 w-3" /> Time Series Catalog
        </Link>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="flex flex-1 items-center gap-2 text-xl font-semibold">
            <Icon name="cube" className="h-5 w-5 text-ocean" /> {t.display_name}
            <span className="rounded bg-panel-2 px-1.5 text-xs font-normal text-muted">{info?.is_sensor ? "Sensor object type" : "Time series object type"}</span>
          </h1>
          <Link href={`/ontology/${t.id}?tab=capabilities`} className={buttonClass.secondary}>
            <Icon name="sliders" className="h-4 w-4" /> Capabilities
          </Link>
          <Link href={`/time-series/derived/new?root=${t.id}`} className={buttonClass.secondary}>
            <Icon name="layers" className="h-4 w-4" /> New derived series
          </Link>
          {current && (
            <Link href={`/quiver?new=1&type=${t.id}&pk=${encodeURIComponent(current)}`} className={buttonClass.primary}>
              <Icon name="wave" className="h-4 w-4" /> Analyze in Quiver
            </Link>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
          <div className="rounded-xl border border-line bg-panel">
            <div className="border-b border-line p-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${t.plural_name}…`} className={inputClass} />
            </div>
            <ul className="max-h-[36rem] overflow-y-auto text-sm">
              {objects?.length === 0 && <li className="p-3 text-center text-xs text-muted">No objects.</li>}
              {objects?.map((o) => (
                <li key={o.primary_key}>
                  <button
                    type="button"
                    onClick={() => setSelected(o.primary_key)}
                    className={`w-full truncate px-3 py-2 text-left ${current === o.primary_key ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}
                  >
                    {o.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-line bg-panel p-4">
            {current ? <ObjectSeries typeId={t.id} pk={current} resource="catalog" /> : <p className="text-sm text-muted">Pick an object.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
