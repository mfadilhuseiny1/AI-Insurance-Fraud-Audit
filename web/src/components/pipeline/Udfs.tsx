"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { codeRepos, type PublishedUdf } from "@/lib/codeRepos";
import { udfTypeLabel, uid, type CustomUdf, type Pipeline, type UdfExample, type UdfVersion } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "./Modal";

/** A published UDF (API shape) as the version a pipeline keeps. */
export const versionOf = (u: PublishedUdf): UdfVersion => ({
  id: u.id,
  name: u.name,
  description: u.description,
  type: u.type,
  repoId: u.repo_id,
  repoName: u.repo_name,
  tag: u.tag,
  input: { name: u.input.name, fields: u.input.fields },
  output: { name: u.output.name, fields: u.output.fields },
  arguments: u.arguments,
  examples: u.examples,
  ...(u.type === "keyed_process" ? { keyColumns: u.key_columns ?? [], eventTimeColumn: u.event_time_column ?? null, state: u.state } : {}),
});

const sameUdf = (a: Pick<UdfVersion, "repoId" | "name" | "id">, b: PublishedUdf) => a.repoId === b.repo_id && (a.id ? a.id === b.id : a.name === b.name);

function Rows({ rows, title }: { rows: Record<string, unknown>[]; title: string }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-0.5 text-[11px] text-muted">{title}</div>
      <table className="w-full rounded border border-line text-[11px]">
        <thead className="text-left text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c} className="px-1.5 py-0.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {cols.map((c) => (
                <td key={c} className="px-1.5 py-0.5 font-mono text-soft">
                  {r[c] === null || r[c] === undefined ? <span className="text-muted">null</span> : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A UDF's examples: arguments, input rows and the rows it outputs for them. */
export function UdfExamples({ examples }: { examples: UdfExample[] }) {
  if (!examples.length) return <p className="text-xs text-muted">No examples: add an Examples class in the repository&apos;s examples.registry package.</p>;
  return (
    <div className="space-y-2">
      {[...examples]
        .sort((a, b) => Number(b.visibility === "PROMINENT") - Number(a.visibility === "PROMINENT"))
        .map((e) => (
          <div key={e.id} className="rounded-md border border-line-2 p-2 text-xs">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-medium text-soft">{e.id}</span>
              {e.category && <span className="rounded bg-panel-2 px-1 text-[10px] text-muted">{e.category.toLowerCase()} case</span>}
              <span className="text-muted">{e.description}</span>
              {Object.keys(e.configuration ?? {}).length > 0 && (
                <span className="ml-auto font-mono text-muted">
                  {Object.entries(e.configuration)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(", ")}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Rows rows={e.input} title="Input" />
              <Rows rows={e.expected} title="Output" />
            </div>
          </div>
        ))}
    </div>
  );
}

/** Reusables → User-defined functions: the pipeline's Java UDFs, importing published ones and switching versions. */
export function UdfReusables({
  pipeline,
  usages,
  onSave,
  onRemove,
}: {
  pipeline: Pipeline;
  usages: (id: string) => string[];
  onSave: (fn: CustomUdf) => void;
  onRemove: (fn: CustomUdf) => void;
}) {
  const imported = (pipeline.functions ?? []).filter((f) => f.kind === "udf");
  const [published, setPublished] = useState<PublishedUdf[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    codeRepos.udfs().then(setPublished, (e: Error) => setError(e.message));
  }, []);
  // one entry per UDF (repository + lockfile id), newest version first
  const catalog = useMemo(() => {
    const m = new Map<string, PublishedUdf[]>();
    for (const u of published ?? []) {
      const k = `${u.repo_id}:${u.id ?? u.name}`;
      (m.get(k) ?? m.set(k, []).get(k)!).push(u);
    }
    for (const list of m.values()) list.sort((a, b) => (b.tagged_at ?? "").localeCompare(a.tagged_at ?? ""));
    const q = query.trim().toLowerCase();
    return [...m.values()].filter((l) => !q || `${l[0].name} ${l[0].repo_name} ${l[0].description}`.toLowerCase().includes(q));
  }, [published, query]);
  return (
    <>
      <p className="text-xs text-muted">
        Java user-defined functions from{" "}
        <Link href="/code-repositories" className="text-ocean hover:underline">
          Code Repositories
        </Link>
        : a definition (input and output schema, arguments) with a Java implementation, published by tagging a version whose checks pass. Use one in any transform like a built-in step; it
        runs on the server, in previews and builds.
      </p>
      {error && <p className="text-xs text-bad">{error}</p>}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {imported.map((f) => {
          const used = usages(f.id);
          const versions = (published ?? []).filter((u) => sameUdf(f.udf, u));
          const newest = versions.sort((a, b) => (b.tagged_at ?? "").localeCompare(a.tagged_at ?? ""))[0];
          return (
            <li key={f.id} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <Icon name="code" className="h-4 w-4 text-ocean" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {f.name} <span className="font-normal text-muted">· {udfTypeLabel(f.udf).toLowerCase()}</span>
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {f.udf.repoName} {f.udf.tag}
                    {newest && newest.tag !== f.udf.tag ? ` · ${newest.tag} available` : ""} · used {used.length}×
                  </span>
                </span>
                <select
                  value={f.udf.tag}
                  onChange={(e) => {
                    const v = versions.find((u) => u.tag === e.target.value);
                    if (v) onSave({ ...f, udf: versionOf(v), description: v.description });
                  }}
                  title="Edit version"
                  className={`${inputClass} w-32 py-1 text-xs`}
                >
                  {!versions.some((v) => v.tag === f.udf.tag) && <option value={f.udf.tag}>{f.udf.tag} (not published)</option>}
                  {versions.map((v) => (
                    <option key={v.tag} value={v.tag}>
                      {v.tag}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setOpen(open === f.id ? null : f.id)} className={buttonClass.secondary}>
                  <Icon name="info" className="h-3.5 w-3.5" /> Examples
                </button>
                <button type="button" onClick={() => onRemove(f)} className="rounded p-1.5 text-muted hover:text-bad">
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
              {open === f.id && (
                <div className="mt-2 space-y-2 pl-7">
                  <p className="text-xs text-muted">
                    Input {f.udf.input.name}: {f.udf.input.fields.map((x) => `${x.name} ${x.type}${x.nullable ? "" : " (required)"}`).join(", ")} → output {f.udf.output.name}:{" "}
                    {f.udf.output.fields.map((x) => `${x.name} ${x.type}`).join(", ")}
                    {f.udf.type === "keyed_process" &&
                      ` · keyed by ${(f.udf.keyColumns ?? []).join(", ")}${f.udf.eventTimeColumn ? ` · event time ${f.udf.eventTimeColumn}` : ""} · state ${f.udf.state?.name ?? ""} (${(f.udf.state?.fields ?? []).map((x) => x.name).join(", ")}): kept between micro-batches in streaming pipelines; a batch build starts empty and fires every event-time timer at the end`}
                  </p>
                  <UdfExamples examples={f.udf.examples} />
                </div>
              )}
            </li>
          );
        })}
        {!imported.length && <li className="px-3 py-6 text-center text-sm text-muted">No UDFs imported.</li>}
      </ul>
      {!importing ? (
        <div className="flex justify-end">
          <button type="button" onClick={() => setImporting(true)} className={buttonClass.primary}>
            <Icon name="download" className="h-3.5 w-3.5" /> Import UDF
          </button>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-ocean/40 p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Import UDF</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className={`${inputClass} ml-auto w-56 py-1 text-xs`} />
            <button type="button" onClick={() => setImporting(false)} className="rounded p-1 text-muted hover:text-white">
              <Icon name="x" className="h-4 w-4" />
            </button>
          </div>
          {published === null && !error && <p className="text-xs text-muted">Loading…</p>}
          {published?.length === 0 && <p className="text-xs text-muted">No published UDFs. In a UDF repository: generateEddieLockfile, commit, tag a version, and let the checks pass.</p>}
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {catalog.map((list) => {
              const u = list[0];
              const has = imported.some((f) => sameUdf(f.udf, u));
              return (
                <li key={`${u.repo_id}:${u.id ?? u.name}`} className="flex items-center gap-3 rounded-md border border-line px-2.5 py-1.5 text-xs">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-soft">
                      {u.name} <span className="font-normal text-muted">· {udfTypeLabel(u).toLowerCase()} · {u.repo_name} · versions {list.map((v) => v.tag).join(", ")}</span>
                    </span>
                    <span className="block truncate text-muted">{u.description || `${u.input.fields.map((f) => f.name).join(", ")} → ${u.output.fields.map((f) => f.name).join(", ")}`}</span>
                  </span>
                  <button
                    type="button"
                    disabled={has}
                    onClick={() => onSave({ id: uid(), kind: "udf", name: u.name, description: u.description, args: [], udf: versionOf(u) })}
                    className={`${buttonClass.secondary} py-1 text-xs`}
                  >
                    {has ? "Imported" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
