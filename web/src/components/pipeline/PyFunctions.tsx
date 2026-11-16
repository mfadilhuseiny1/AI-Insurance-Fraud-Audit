"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { functions, type FunctionRow } from "@/lib/actions";
import { uid, type CustomFunction, type CustomPyFunction, type Pipeline } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "./Modal";

const versionOf = (f: FunctionRow): CustomPyFunction["fn"] => ({
  functionId: f.id,
  name: f.name,
  version: f.version,
  inputs: f.inputs.map((i) => ({ name: i.name, type: i.type, required: i.required })),
  output: f.output,
});

/**
 * Reusables → User-defined functions: Python functions from the functions registry, imported as UDFs that run once
 * per row (functions taking or returning Ontology types are not offered, like in Foundry).
 */
export function PyFunctionReusables({ pipeline, usages, onSave, onRemove }: { pipeline: Pipeline; usages: (id: string) => string[]; onSave: (fn: CustomFunction) => void; onRemove: (fn: CustomFunction) => void }) {
  const imported = (pipeline.functions ?? []).filter((f): f is CustomPyFunction => f.kind === "pyfn");
  const [available, setAvailable] = useState<FunctionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    functions.pipelineUdfs().then(setAvailable, (e: Error) => setError(e.message));
  }, []);
  const q = query.trim().toLowerCase();
  const shown = (available ?? []).filter((f) => !q || `${f.name} ${f.doc}`.toLowerCase().includes(q));
  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs text-muted">
        Python functions published from{" "}
        <Link href="/code-repositories" className="text-ocean hover:underline">
          Code Repositories
        </Link>{" "}
        (functions registry): map columns to the function&apos;s inputs; it runs once per row on the server and its return value becomes a new column (a struct as JSON text). UDFs
        cannot read the Nexus.
      </p>
      {error && <p className="text-xs text-bad">{error}</p>}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {imported.map((f) => {
          const newest = available?.find((x) => x.id === f.fn.functionId);
          return (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Icon name="code" className="h-4 w-4 text-ocean" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {f.name} <span className="font-normal text-muted">· Python function</span>
                </span>
                <span className="block truncate text-xs text-muted">
                  {f.fn.inputs.map((i) => `${i.name} ${i.type}`).join(", ") || "no inputs"} → {f.fn.output} · {f.fn.version}
                  {newest && newest.version !== f.fn.version ? ` · ${newest.version} available` : ""} · used {usages(f.id).length}×
                </span>
              </span>
              {newest && newest.version !== f.fn.version && (
                <button type="button" onClick={() => onSave({ ...f, fn: versionOf(newest) })} className={`${buttonClass.secondary} py-1 text-xs`}>
                  Use {newest.version}
                </button>
              )}
              <button type="button" onClick={() => onRemove(f)} className="rounded p-1.5 text-muted hover:text-bad" aria-label="Remove">
                <Icon name="trash" className="h-4 w-4" />
              </button>
            </li>
          );
        })}
        {!imported.length && <li className="px-3 py-4 text-center text-sm text-muted">No Python functions imported.</li>}
      </ul>
      <div className="space-y-1 rounded-lg border border-line p-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-soft">Import a Python function</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className={`${inputClass} ml-auto w-56 py-1 text-xs`} />
        </div>
        {available?.length === 0 && <p className="text-xs text-muted">No published functions without Nexus types.</p>}
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {shown.map((f) => {
            const has = imported.some((x) => x.fn.functionId === f.id);
            return (
              <li key={f.id} className="flex items-center gap-3 rounded-md border border-line px-2.5 py-1.5 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-soft">
                    {f.name} <span className="font-normal text-muted">· {f.version}</span>
                  </span>
                  <span className="block truncate text-muted">
                    {f.inputs.map((i) => `${i.name} ${i.type}`).join(", ")} → {f.output}
                    {f.doc ? ` · ${f.doc}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={has}
                  onClick={() => onSave({ id: uid(), kind: "pyfn", name: f.name, description: f.doc || undefined, args: [], fn: versionOf(f) })}
                  className={`${buttonClass.secondary} py-1 text-xs`}
                >
                  {has ? "Imported" : "Add"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
