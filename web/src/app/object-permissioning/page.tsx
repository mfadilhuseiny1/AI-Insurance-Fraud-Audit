"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { ApiError, Loading } from "@/components/States";
import { ontology, request, type ObjectType } from "@/lib/ontology";

type Row = { t: ObjectType; object: boolean; properties: { name: string; properties: string[] }[]; controls: string[] };

/**
 * Object permissioning: which object types have object (row-level) and property (column-level) security policies or
 * mandatory control properties. Policies are edited in each object type's Security tab.
 */
export default function ObjectPermissioningPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ontology.objectTypes().then(
      async (types) => {
        const out = await Promise.all(
          types.map(async (t) => {
            const sec = await request<{ object_policy: unknown; property_policies: { name: string; properties: string[] }[] }>(`/object-types/${t.id}/security`).catch(() => null);
            return { t, object: !!sec?.object_policy, properties: sec?.property_policies ?? [], controls: t.properties.filter((p) => p.mandatory_control).map((p) => p.display_name) };
          }),
        );
        setRows(out);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  if (error) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  const secured = rows.filter((r) => r.object || r.controls.length);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Object Permissioning" icon="eye" href="/object-permissioning" />
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-6">
          <div>
            <h1 className="text-xl font-semibold">Object and property security</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Viewing an object needs Viewer access to its object type, the object type&apos;s markings, every marking held by its mandatory control properties, and a passing
              object security policy. Property security policies hide individual values. Policies filter reads only; pair them with markings to protect data downstream.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Object types", rows.length],
              ["With an object security policy", rows.filter((r) => r.object).length],
              ["With property security policies", rows.filter((r) => r.properties.length).length],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg border border-line bg-panel px-4 py-3">
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
                  <th className="px-4 py-2 font-medium">Object policy</th>
                  <th className="px-4 py-2 font-medium">Property policies</th>
                  <th className="px-4 py-2 font-medium">Mandatory controls</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[...secured, ...rows.filter((r) => !secured.includes(r))].map((r) => (
                  <tr key={r.t.id} className="hover:bg-panel-2">
                    <td className="px-4 py-2 font-medium">{r.t.display_name}</td>
                    <td className="px-4 py-2">{r.object ? <span className="text-ok">Configured</span> : <span className="text-muted">None</span>}</td>
                    <td className="px-4 py-2">{r.properties.length ? r.properties.map((p) => `${p.name} (${p.properties.length})`).join(", ") : <span className="text-muted">—</span>}</td>
                    <td className="px-4 py-2">{r.controls.join(", ") || <span className="text-muted">—</span>}</td>
                    <td className="px-4 py-2 text-right">
                      <Link href={`/ontology/${r.t.id}?tab=security`} className="inline-flex items-center gap-1 text-ocean hover:underline">
                        <Icon name="eye" className="h-3.5 w-3.5" /> Security
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </main>
    </div>
  );
}
