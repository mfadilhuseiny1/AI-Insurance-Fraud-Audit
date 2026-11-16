"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { request, type ObjectType } from "@/lib/ontology";
import { workshop } from "@/lib/workshop";

type Extra = { dataset_id: string; name: string; pk_column: string; columns: Record<string, string> };

/**
 * Multi-datasource object types (column-wise): more datasets keyed by the primary key, each backing other properties
 * (a property comes from one datasource only). Keys missing from a dataset leave its properties null.
 */
export function AdditionalDatasources({ t, onChanged }: { t: ObjectType; onChanged: () => void }) {
  const [list, setList] = useState<{ primary: { name: string } | null; additional: Extra[]; limit: number } | null>(null);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ dataset_id: "", pk_column: "", columns: "" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => request<NonNullable<typeof list>>(`/object-types/${t.id}/datasources`).then(setList, (e: Error) => setError(e.message)), [t.id]);
  useEffect(() => {
    void load();
    workshop.sources().then((s) => setDatasets(s.datasets), () => setDatasets([]));
  }, [load]);
  if (!list?.primary) return null;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Additional datasources (multi-datasource object type)" count={list.additional.length} className="mt-4">
      <div className="space-y-3 p-4 text-xs">
        <p className="text-muted">
          Add datasets keyed by {t.primary_key} that back other properties of {t.display_name}. A property comes from one datasource only; objects are every key found in any
          datasource; users who cannot view a dataset see its properties as null. At most {list.limit} datasources.
        </p>
        {list.additional.map((d) => (
          <div key={d.dataset_id} className="flex items-center gap-2 rounded border border-line px-3 py-2">
            <Icon name="database" className="h-3.5 w-3.5 text-ocean" />
            <Link href={`/datasets/${d.dataset_id}`} className="text-ocean">
              {d.name}
            </Link>
            <span className="text-muted">
              key <span className="font-mono">{d.pk_column}</span> · {Object.entries(d.columns).map(([c, p]) => `${c} → ${p}`).join(", ")}
            </span>
            <button type="button" onClick={() => run(() => request(`/object-types/${t.id}/datasources/${d.dataset_id}`, { method: "DELETE" }))} className="ml-auto text-muted hover:text-bad" aria-label="Remove datasource">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <select value={form.dataset_id} onChange={(e) => setForm({ ...form, dataset_id: e.target.value })} className={fieldClass} aria-label="Dataset">
            <option value="">Dataset…</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <input value={form.pk_column} onChange={(e) => setForm({ ...form, pk_column: e.target.value })} placeholder="Primary key column" className={`${fieldClass} w-40`} />
          <input value={form.columns} onChange={(e) => setForm({ ...form, columns: e.target.value })} placeholder="column:property, column:property" className={`${fieldClass} w-72`} />
          <button
            type="button"
            disabled={!form.dataset_id || !form.pk_column || !form.columns}
            onClick={() =>
              run(() =>
                request(`/object-types/${t.id}/datasources`, {
                  method: "POST",
                  json: {
                    dataset_id: form.dataset_id,
                    pk_column: form.pk_column,
                    columns: Object.fromEntries(
                      form.columns
                        .split(",")
                        .map((x) => x.split(":").map((y) => y.trim()))
                        .filter((x) => x[0])
                        .map(([c, p]) => [c, p || c]),
                    ),
                  },
                }),
              )
            }
            className={buttonClass.secondary}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> Add datasource
          </button>
        </div>
        <ErrorBox message={error} />
      </div>
    </Card>
  );
}
