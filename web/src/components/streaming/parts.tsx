"use client";

import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon";
import { inputClass } from "../pipeline/Modal";
import type { StreamColumn, StreamKeys } from "@/lib/streaming";

const TYPES = ["String", "Boolean", "Integer", "Long", "Double", "Decimal", "Date", "Timestamp"];

export function SchemaEditor({ value, onChange }: { value: StreamColumn[]; onChange: (v: StreamColumn[]) => void }) {
  return (
    <div className="space-y-1">
      {value.map((c, i) => (
        <div key={i} className="flex gap-1.5">
          <input value={c.name} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${inputClass} py-1 text-xs`} />
          <select value={c.type} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} className={`${inputClass} w-36 py-1 text-xs`}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...value, { name: `field_${value.length + 1}`, type: "String" }])} className="text-xs text-ocean hover:underline">
        + Add field
      </button>
    </div>
  );
}

export function Section({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <Icon name={icon} className="h-4 w-4 text-ocean" /> {title}
      </h2>
      {children}
    </section>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(value).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
      className="text-ocean hover:underline"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}


/**
 * Stream keys: partition key columns keep the order of records with the same values; CDC mode also makes
 * them the primary key (the stream is a changelog read as the latest record per key).
 */
export function KeysEditor({ columns, value, onChange }: { columns: string[]; value: StreamKeys; onChange: (k: StreamKeys) => void }) {
  const cdc = !!value.primary;
  const set = (partition: string[], primary: boolean, deleted: string | null) =>
    onChange({ partition, primary: primary && partition.length ? { columns: partition, deleted } : null });
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-1.5">
        {columns.length === 0 && <span className="text-muted">Add schema columns to key the stream.</span>}
        {columns.map((c) => {
          const on = value.partition.includes(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => set(on ? value.partition.filter((x) => x !== c) : [...value.partition, c], cdc, value.primary?.deleted ?? null)}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${on ? "bg-ocean/20 text-white ring-1 ring-ocean/50" : "bg-panel-2 text-muted hover:text-white"}`}
            >
              {on && <Icon name="link" className="h-3 w-3" />} {c}
            </button>
          );
        })}
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={cdc} disabled={!value.partition.length} onChange={(e) => set(value.partition, e.target.checked, null)} className="accent-[var(--color-ocean)]" />
        CDC mode: also use the key columns as the primary key
      </label>
      {cdc && (
        <label className="flex items-center gap-2">
          <span className="text-muted">Primary key is deleted</span>
          <select value={value.primary?.deleted ?? ""} onChange={(e) => set(value.partition, true, e.target.value || null)} className={`${inputClass} w-48 py-1 text-xs`}>
            <option value="">(none)</option>
            {columns
              .filter((c) => !value.partition.includes(c))
              .map((c) => (
                <option key={c}>{c}</option>
              ))}
          </select>
        </label>
      )}
    </div>
  );
}

export const NO_KEYS: StreamKeys = { partition: [], primary: null };
