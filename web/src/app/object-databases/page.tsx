"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHeader, Card } from "@/components/ontology/parts";
import { ApiError, Loading } from "@/components/States";
import { ontology, type ObjectType } from "@/lib/ontology";
import { om, type OntologyUsage } from "@/lib/ontologyModel";

const DATASOURCE_LIMIT = 50_000;

/** Object databases: the object store's volume and objects per type, against the limits that apply here. */
export default function ObjectDatabasesPage() {
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [usage, setUsage] = useState<OntologyUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([ontology.objectTypes(), om.usage(30)]).then(
      ([t, u]) => {
        setTypes(t);
        setUsage(u);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  if (error) return <ApiError message={error} />;
  if (!types || !usage) return <Loading />;
  const vol = Object.fromEntries(usage.volume.map((v) => [v.object_type_id, v]));
  const rows = [...types].sort((a, b) => (vol[b.id]?.bytes ?? 0) - (vol[a.id]?.bytes ?? 0));
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Object Databases" icon="database" href="/object-databases" />
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-6">
          <div>
            <h1 className="text-xl font-semibold">Object databases</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              One object database serves every object type, with the behavior of Object Storage v2 (user edits apart from datasources, edit history, data restrictions).
              Object Storage v1 (Phonograph) is not part of this platform, so nothing needs to migrate. Volume is sampled hourly and billed as GB-months in Resource Management.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Volume", `${(usage.volume_bytes / 1e6).toFixed(2)} MB`],
              ["GB-months (30 days)", usage.gb_months.toFixed(4)],
              ["Objects", types.reduce((a, t) => a + (t.object_count ?? 0), 0).toLocaleString()],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-line bg-panel px-4 py-3">
                <div className="text-xs text-muted">{k}</div>
                <div className="text-lg font-semibold">{v}</div>
              </div>
            ))}
          </div>
          <Card title="Object types" count={rows.length}>
            <table className="w-full text-xs">
              <thead className="bg-panel-2 text-left text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Object type</th>
                  <th className="px-4 py-2 font-medium">Objects</th>
                  <th className="px-4 py-2 font-medium">Of the datasource limit</th>
                  <th className="px-4 py-2 font-medium">Volume</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((t) => {
                  const n = t.object_count ?? 0;
                  return (
                    <tr key={t.id} className="hover:bg-panel-2">
                      <td className="px-4 py-2">
                        <Link href={`/ontology/${t.id}`} className="text-ocean hover:underline">
                          {t.display_name}
                        </Link>
                      </td>
                      <td className="px-4 py-2 tabular-nums">{n.toLocaleString()}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-40 rounded bg-panel-2">
                            <div className={`h-2 rounded ${n > DATASOURCE_LIMIT * 0.8 ? "bg-warn" : "bg-ocean"}`} style={{ width: `${Math.min(100, (n / DATASOURCE_LIMIT) * 100)}%` }} />
                          </div>
                          <span className="text-muted">{((n / DATASOURCE_LIMIT) * 100).toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 tabular-nums">{vol[t.id] ? `${(vol[t.id].bytes / 1e3).toFixed(1)} KB` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-muted">A backing dataset can index at most 50,000 rows per object type here; objects created by edits are not limited by it.</p>
        </div>
      </main>
    </div>
  );
}
