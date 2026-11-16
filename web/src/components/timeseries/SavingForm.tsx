"use client";

import { useEffect, useState } from "react";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import type { DerivedSaving, TsObjectType } from "@/lib/timeseries";

/**
 * Ontology saving options of a derived series: manual (put its template RID in a time series property yourself)
 * or automatic (sensor object types only: a sensor name, a root object scope, a property mapping and the Create /
 * Modify / Delete action types that write the sensor objects).
 */
export function SavingForm({
  saving,
  onChange,
  bound,
  rootTypeId,
  type,
}: {
  saving: DerivedSaving;
  onChange: (s: DerivedSaving) => void;
  bound: TsObjectType | null;
  rootTypeId: string | null;
  type: "templated" | "single";
}) {
  const [actions, setActions] = useState<ActionType[]>([]);
  const [boundType, setBoundType] = useState<ObjectType | null>(null);
  const [rootTypeState, setRootType] = useState<ObjectType | null>(null);
  const rootType = rootTypeId && rootTypeState?.id === rootTypeId ? rootTypeState : null;
  useEffect(() => {
    if (!bound) return;
    ontology.actionTypes(bound.id).then(setActions, () => setActions([]));
    ontology.objectType(bound.id).then(setBoundType, () => setBoundType(null));
  }, [bound]);
  useEffect(() => {
    if (!rootTypeId) return;
    ontology.objectType(rootTypeId).then(setRootType, () => setRootType(null));
  }, [rootTypeId]);
  const set = (patch: Partial<DerivedSaving>) => onChange({ ...saving, ...patch });
  const canAuto = !!bound?.is_sensor;
  const auto = saving.mode === "automatic";
  const mapped = new Set([boundType?.primary_key, bound?.default_property]);
  const mappable = boundType?.properties.filter((p) => !mapped.has(p.api_name) && (p.type === "string" || p.type === "boolean")) ?? [];
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["manual", "Manual", "Add the derived series' template RID to a time series property yourself"],
            ["automatic", "Automatic", canAuto ? "Create, modify and delete sensor objects through action types" : "Only for derived series bound to a sensor object type"],
          ] as const
        ).map(([k, label, hint]) => (
          <button
            key={k}
            type="button"
            disabled={k === "automatic" && !canAuto}
            onClick={() => set({ mode: k })}
            className={`rounded-lg border p-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${saving.mode === k ? "border-ocean bg-ocean/10" : "border-line-2"}`}
          >
            <div className="font-medium">{label}</div>
            <div className="text-xs text-muted">{hint}</div>
          </button>
        ))}
      </div>
      {auto && (
        <>
          <Field label="Sensor name" hint="Identifies the derived series among a root object's sensors">
            <input value={saving.sensor_name} onChange={(e) => set({ sensor_name: e.target.value })} className={inputClass} />
          </Field>
          {type === "templated" && rootType && (
            <Field label="Root object scope" hint="One sensor object per root object in scope (at most 5,000)">
              <div className="flex flex-wrap gap-2">
                <select value={saving.scope.kind} onChange={(e) => set({ scope: { kind: e.target.value as "all" | "filter" | "objects", primary_keys: [] } })} className={`${fieldClass} w-48`}>
                  <option value="all">All {rootType.plural_name}</option>
                  <option value="filter">Where a property equals…</option>
                  <option value="objects">Chosen objects</option>
                </select>
                {saving.scope.kind === "filter" && (
                  <>
                    <select value={saving.scope.property ?? ""} onChange={(e) => set({ scope: { ...saving.scope, property: e.target.value } })} className={`${fieldClass} w-44`}>
                      <option value="">Property…</option>
                      {rootType.properties
                        .filter((p) => p.type !== "timeseries")
                        .map((p) => (
                          <option key={p.api_name} value={p.api_name}>
                            {p.display_name}
                          </option>
                        ))}
                    </select>
                    <input value={String(saving.scope.value ?? "")} onChange={(e) => set({ scope: { ...saving.scope, value: e.target.value } })} className={`${fieldClass} w-36`} placeholder="value" />
                  </>
                )}
                {saving.scope.kind === "objects" && (
                  <input
                    value={saving.scope.primary_keys.join(", ")}
                    onChange={(e) => set({ scope: { ...saving.scope, primary_keys: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
                    placeholder="primary keys, comma separated"
                    className={`${fieldClass} min-w-56 flex-1`}
                  />
                )}
              </div>
            </Field>
          )}
          {mappable.length > 0 && (
            <Field label="Property mapping" hint="Values for the other properties of the sensor objects (strings or Booleans); the primary key, series, sensor name and link are mapped for you">
              <div className="grid grid-cols-2 gap-2">
                {mappable.map((p) => (
                  <label key={p.api_name} className="flex items-center gap-2 text-xs">
                    <span className="w-28 truncate text-muted">{p.display_name}</span>
                    {p.type === "boolean" ? (
                      <input type="checkbox" checked={!!saving.property_mapping[p.api_name]} onChange={(e) => set({ property_mapping: { ...saving.property_mapping, [p.api_name]: e.target.checked } })} />
                    ) : (
                      <input
                        value={String(saving.property_mapping[p.api_name] ?? "")}
                        onChange={(e) => set({ property_mapping: { ...saving.property_mapping, [p.api_name]: e.target.value } })}
                        className={`${fieldClass} flex-1 py-1 text-xs`}
                      />
                    )}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <div className="grid grid-cols-3 gap-2">
            {(["create", "modify", "delete"] as const).map((k) => (
              <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} object action type`}>
                <select value={saving.actions[k] ?? ""} onChange={(e) => set({ actions: { ...saving.actions, [k]: e.target.value || null } })} className={inputClass}>
                  <option value="">—</option>
                  {actions
                    .filter((a) => a.kind === k)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.display_name}
                      </option>
                    ))}
                </select>
              </Field>
            ))}
          </div>
          {actions.length === 0 && <p className="text-xs text-warn">{bound?.display_name} has no action types: add Create, Modify and Delete object action types in Nexus Manager.</p>}
        </>
      )}
    </div>
  );
}
