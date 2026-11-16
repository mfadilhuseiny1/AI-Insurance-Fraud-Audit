"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { ApiError, Loading } from "@/components/States";
import { ontology, request, type ActionType, type ObjectType } from "@/lib/ontology";
import { om, type LinkType, type OntologyUsage } from "@/lib/ontologyModel";

type IndexStatus = { object_type_id: string; source: string; status: string };

const FLOW: [IconName, string, string, string][] = [
  ["database", "Datasources", "Datasets in Files back object types (one row per object).", "/ontology-indexing"],
  ["pipeline", "Indexing", "Funnel-style pipelines: changelog, merge user edits, indexing, hydration.", "/ontology-indexing"],
  ["cube", "Object storage", "Objects with their user edits, links and history (Object Storage v2 model).", "/object-databases"],
  ["search", "Object Set Service", "Search, filters, Search Arounds, aggregations and derived properties.", "/ontology/search"],
  ["edit", "Actions", "Edits applied at once; user edits kept apart from datasources.", "/object-edits"],
];

/** Ontology architecture with this platform's numbers: object types, objects, links, actions, indexing and usage. */
export default function OntologyOverviewPage() {
  const [data, setData] = useState<{ types: ObjectType[]; links: LinkType[]; actions: ActionType[]; usage: OntologyUsage; indexing: IndexStatus[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([ontology.objectTypes(), om.linkTypes(), ontology.actionTypes(), om.usage(30), request<IndexStatus[]>("/indexing")]).then(
      ([types, links, actions, usage, indexing]) => setData({ types, links, actions, usage, indexing }),
      (e: Error) => setError(e.message),
    );
  }, []);
  if (error) return <ApiError message={error} />;
  if (!data) return <Loading />;
  const objects = data.types.reduce((a, t) => a + (t.object_count ?? 0), 0);
  const top = [...data.types].sort((a, b) => (b.object_count ?? 0) - (a.object_count ?? 0)).slice(0, 10);
  const max = Math.max(1, ...top.map((t) => t.object_count ?? 0));
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Overview" icon="cube" href="/ontology-overview" />
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-5 p-6">
          <div>
            <h1 className="text-xl font-semibold">Nexus architecture</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Datasources are indexed into object storage, served to applications through the object set service, and changed by actions. Here everything runs in one
              service on one storage model (equivalent to Object Storage v2): there is no Object Storage v1 (Phonograph) to migrate from.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Object types", data.types.length],
              ["Objects", objects.toLocaleString()],
              ["Link types", data.links.length],
              ["Action types", data.actions.length],
              ["Dataset-backed", data.indexing.filter((i) => i.source === "dataset").length],
              ["Index failures", data.indexing.filter((i) => i.status === "failed").length],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg border border-line bg-panel px-3 py-2">
                <div className="text-[11px] text-muted">{k}</div>
                <div className="text-lg font-semibold">{v}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-2 md:grid-cols-5">
            {FLOW.map(([icon, title, text, href], i) => (
              <Link key={title} href={href} className="relative rounded-lg border border-line bg-panel p-3 text-xs hover:bg-panel-2">
                <Icon name={icon} className="h-4 w-4 text-ocean" />
                <div className="mt-2 font-medium">{title}</div>
                <div className="mt-1 text-muted">{text}</div>
                {i < FLOW.length - 1 && <span className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-muted md:block">→</span>}
              </Link>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Largest object types">
              <div className="space-y-1.5 p-4 text-xs">
                {top.map((t) => (
                  <Link key={t.id} href={`/ontology/${t.id}`} className="flex items-center gap-2 hover:text-white">
                    <span className="w-48 truncate text-soft">{t.display_name}</span>
                    <div className="h-2 flex-1 rounded bg-panel-2">
                      <div className="h-2 rounded bg-ocean" style={{ width: `${((t.object_count ?? 0) / max) * 100}%` }} />
                    </div>
                    <span className="w-14 text-right tabular-nums">{(t.object_count ?? 0).toLocaleString()}</span>
                  </Link>
                ))}
              </div>
            </Card>
            <Card title="Query compute (30 days)">
              <div className="space-y-1.5 p-4 text-xs">
                <div className="mb-2 text-muted">{data.usage.compute_seconds.toLocaleString()} compute-seconds · volume {(data.usage.volume_bytes / 1e6).toFixed(2)} MB</div>
                {Object.entries(data.usage.by_kind)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-line pb-1">
                      <span className="text-soft">{k}</span>
                      <span className="tabular-nums">{v.toLocaleString()}</span>
                    </div>
                  ))}
              </div>
            </Card>
          </div>
          <Card title="Aggregation considerations">
            <p className="p-4 text-xs text-muted">
              Foundry may return inexact aggregations for high-cardinality data (histograms and pivot tables prefer speed). Here aggregations run in memory over every object
              (Object Explorer, Quiver, Workshop, scenario comparisons), so they are exact up to the in-memory limit of 100,000 objects per query.
            </p>
          </Card>
        </div>
      </main>
    </div>
  );
}
