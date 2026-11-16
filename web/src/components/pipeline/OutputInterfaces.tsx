"use client";

import { useEffect, useState } from "react";
import { om, type Interface } from "@/lib/ontologyModel";
import type { ObjectTypeConfig } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { inputClass } from "./Modal";

type Impl = NonNullable<ObjectTypeConfig["interfaces"]>[number];
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * The Ontology interfaces an object type output implements: pick an interface and map each of its properties to a
 * property of the output. Applied when the output registers its object type in the Ontology on deploy.
 */
export function OutputInterfaces({ value, properties, onChange }: { value: Impl[]; properties: { apiName: string; type?: string }[]; onChange: (v: Impl[]) => void }) {
  const [ifaces, setIfaces] = useState<Interface[]>([]);
  useEffect(() => {
    om.interfaces().then(setIfaces, () => setIfaces([]));
  }, []);
  const setAt = (i: number, patch: Partial<Impl>) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-1.5">
      {value.map((itf, i) => {
        const iface = ifaces.find((x) => x.id === itf.interfaceId);
        return (
          <div key={itf.id} className="space-y-1 rounded border border-line-2 p-1.5">
            <div className="flex gap-1">
              <select
                value={itf.interfaceId ?? ""}
                onChange={(e) => {
                  const next = ifaces.find((x) => x.id === e.target.value);
                  // properties with the same API name map themselves
                  const auto = Object.fromEntries((next?.all_properties ?? []).filter((p) => properties.some((q) => q.apiName === p.api_name)).map((p) => [p.api_name, p.api_name]));
                  setAt(i, { interfaceId: e.target.value || undefined, name: next?.display_name ?? "", mapping: auto });
                }}
                className={`${inputClass} py-0.5 text-xs`}
              >
                <option value="">{itf.name && !itf.interfaceId ? `${itf.name} (not an Nexus interface)` : "Choose an interface…"}</option>
                {ifaces.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="rounded p-0.5 text-muted hover:text-bad" aria-label="Remove interface">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
            {(iface?.all_properties ?? []).map((p) => (
              <div key={p.api_name} className="flex items-center gap-1 text-[11px]">
                <span className="w-24 truncate font-mono text-soft" title={p.api_name}>
                  {p.api_name}
                  {p.required ? "*" : ""}
                </span>
                <Icon name="left" className="h-3 w-3 shrink-0 text-muted" />
                <select value={itf.mapping[p.api_name] ?? ""} onChange={(e) => setAt(i, { mapping: { ...itf.mapping, [p.api_name]: e.target.value } })} className={`${inputClass} min-w-0 py-0.5 text-[11px]`}>
                  <option value="">Not mapped</option>
                  {properties.map((q) => (
                    <option key={q.apiName} value={q.apiName}>
                      {q.apiName}
                      {q.type ? ` (${q.type})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...value, { id: uid(), name: "", mapping: {} }])} className="text-ocean hover:underline">
        + Implement interface
      </button>
    </div>
  );
}
