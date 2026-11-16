"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { promptDialog } from "@/lib/dialogs";
import type { ObjectType, TimeSeriesCondition } from "@/lib/ontology";
import { ALERTING_CARDS, tsOntology, type Logic, type ObjRef, type TsObjectType } from "@/lib/timeseries";
import { LogicEditor, type Range } from "./LogicEditor";

/**
 * Automate's time series condition (time series alerting): the alert output type, the alert object type new
 * events are written to, the root object type, the templated logic ending in a time series search, the scope
 * of root objects and how often effects run.
 */
export function TsConditionEditor({
  condition,
  onChange,
  types,
  locked,
  onTypesChanged,
}: {
  condition: TimeSeriesCondition;
  onChange: (c: TimeSeriesCondition) => void;
  types: ObjectType[];
  locked: boolean;
  onTypesChanged: () => void;
}) {
  const [alertTypes, setAlertTypes] = useState<{ id: string; display_name: string; streaming: boolean }[]>([]);
  const [tsTypes, setTsTypes] = useState<TsObjectType[]>([]);
  const [root, setRoot] = useState<ObjRef | null>(null);
  const [range, setRange] = useState<Range>({ last: "7d" });
  const set = (patch: Partial<TimeSeriesCondition>) => onChange({ ...condition, ...patch });
  const loadAlertTypes = () => tsOntology.alertObjectTypes().then(setAlertTypes, () => setAlertTypes([]));
  useEffect(() => {
    loadAlertTypes();
    tsOntology.objectTypes().then(setTsTypes, () => setTsTypes([]));
  }, []);
  const rootType = types.find((t) => t.id === condition.object_type_id);
  const roots = tsTypes.filter((t) => !t.is_sensor || t.sensor_types.length);
  const createAlertType = async () => {
    const name = await promptDialog("Name of the new alert object type", "Time series alert", { title: "Create alert object type" });
    if (!name) return;
    const t = await tsOntology.createAlertObjectType(name, true);
    await loadAlertTypes();
    onTypesChanged();
    set({ alert_object_type_id: t.id });
  };
  const chooseRoot = (id: string) => {
    const tsp = tsTypes.find((t) => t.id === id)?.default_property ?? "";
    set({
      object_type_id: id,
      logic: { cards: [{ id: "A", type: "tsp", config: { property: tsp } }, { id: "B", type: "search", config: { condition: "$A > 0" } }], output: "B" },
    });
    setRoot(null);
  };
  const scope = condition.scope ?? { kind: "all" };
  const allowed = ALERTING_CARDS.filter((c) => !(condition.mode === "streaming" && c === "segment_stats"));
  return (
    <div className="space-y-4">
      <Field label="Alert output type" hint="Cannot change after the automation is created">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["batch", "Batch alerting", "Evaluated when the input syncs get new data (or on a schedule); alerts are sent periodically"],
              ["streaming", "Streaming alerting", "Evaluated continuously as points arrive; low-latency alerts, custom recovery conditions"],
            ] as const
          ).map(([k, label, hint]) => (
            <button
              key={k}
              type="button"
              disabled={locked}
              onClick={() => set({ mode: k })}
              className={`rounded-lg border p-2.5 text-left text-sm disabled:cursor-not-allowed ${condition.mode === k ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50 disabled:opacity-50"}`}
            >
              <div className="font-medium">{label}</div>
              <div className="text-xs text-muted">{hint}</div>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Time series alert object type" hint="Each alert is an object of this type (it needs the timeseries:* type classes). One evaluation job serves every automation writing to it.">
        <div className="flex gap-2">
          <select value={condition.alert_object_type_id} onChange={(e) => set({ alert_object_type_id: e.target.value })} className={inputClass}>
            <option value="">Select an alert object type…</option>
            {alertTypes
              .filter((t) => condition.mode !== "streaming" || t.streaming)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
          </select>
          <button type="button" onClick={createAlertType} className={buttonClass.secondary}>
            <Icon name="plus" className="h-4 w-4" /> Create new object type
          </button>
        </div>
      </Field>
      <Field label="Root object type" hint="The logic is templated: it runs for every root object in scope, on its time series properties and linked sensors">
        <select value={condition.object_type_id} onChange={(e) => chooseRoot(e.target.value)} className={inputClass} disabled={locked && !!condition.object_type_id}>
          <option value="">Select a time series object type…</option>
          {roots.map((t) => (
            <option key={t.id} value={t.id}>
              {t.display_name}
              {t.is_sensor ? " (sensor)" : ""}
            </option>
          ))}
        </select>
      </Field>
      {condition.object_type_id && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-soft">
            Time series logic
            <span className="font-normal text-muted">
              — ends in a time series search card. Batch alerting ignores the search&apos;s minimum and maximum durations; streaming honours minimum durations and custom recovery conditions.
            </span>
          </div>
          <LogicEditor
            logic={condition.logic as Logic}
            onChange={(l) => set({ logic: l })}
            mode="alerting"
            rootTypeId={condition.object_type_id}
            root={root}
            onRoot={setRoot}
            range={range}
            onRange={setRange}
            resource="automate:preview"
            allowed={allowed}
          />
        </div>
      )}
      {rootType && (
        <Field label="Automation scope" hint="Which root objects the logic runs for">
          <div className="flex flex-wrap items-center gap-2">
            <select value={scope.kind} onChange={(e) => set({ scope: { kind: e.target.value as "all" | "filter" | "objects", primary_keys: [] } })} className={`${fieldClass} w-48`}>
              <option value="all">All {rootType.plural_name}</option>
              <option value="filter">Where a property equals…</option>
              <option value="objects">Chosen objects</option>
            </select>
            {scope.kind === "filter" && (
              <>
                <select value={scope.property ?? ""} onChange={(e) => set({ scope: { ...scope, property: e.target.value } })} className={`${fieldClass} w-48`}>
                  <option value="">Property…</option>
                  {rootType.properties
                    .filter((p) => p.type !== "timeseries")
                    .map((p) => (
                      <option key={p.api_name} value={p.api_name}>
                        {p.display_name}
                      </option>
                    ))}
                </select>
                <input value={String(scope.value ?? "")} onChange={(e) => set({ scope: { ...scope, value: e.target.value } })} placeholder="value" className={`${fieldClass} w-40`} />
              </>
            )}
            {scope.kind === "objects" && (
              <input
                value={(scope.primary_keys ?? []).join(", ")}
                onChange={(e) => set({ scope: { ...scope, primary_keys: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
                placeholder="primary keys, comma separated"
                className={`${fieldClass} min-w-64 flex-1`}
              />
            )}
          </div>
        </Field>
      )}
      <Field label="Evaluation frequency (minutes)" hint="How often effects run on new alerts; 0 runs them after every evaluation. The evaluation job's own schedule is in its configuration.">
        <input type="number" min={0} value={condition.evaluation_minutes ?? 0} onChange={(e) => set({ evaluation_minutes: Math.max(0, Number(e.target.value) || 0) })} className={`${fieldClass} w-32`} />
      </Field>
    </div>
  );
}
