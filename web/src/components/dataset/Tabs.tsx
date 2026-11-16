"use client";

import { LifetimePanel } from "@/components/security/LifetimePanel";
import { SqlDefinitions } from "@/components/sql/SqlDefinitions";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { driveContentUrl } from "@/lib/api";
import { promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { cellText, datasetHref, datasetPreview, formatBytes, type DatasetListing, type DatasetSummary, type Diff, type Transaction } from "@/lib/datasetPreview";

const txLabel = (t: Transaction) => `${t.at.slice(0, 19).replace("T", " ")} · ${t.kind}${t.rows !== null ? ` · ${t.rows.toLocaleString()} rows` : ""}`;

// ------------------------------------------------------------------------------------------------ History

export function HistoryTab({ ds, onBranch }: { ds: DatasetSummary; onBranch: (itemId: string) => void }) {
  const [h, setH] = useState<Awaited<ReturnType<typeof datasetPreview.history>> | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    datasetPreview.history(ds.id).then((r) => {
      setH(r);
      setSel(r.transactions[0]?.id ?? null);
    }, (e: Error) => setError(e.message));
  }, [ds.id]);
  if (error) return <p className="p-4 text-sm text-bad">{error}</p>;
  if (!h) return <Loading />;
  const t = h.transactions.find((x) => x.id === sel);
  return (
    <div className="flex min-h-0 flex-1">
      <ul className="w-96 shrink-0 overflow-y-auto border-r border-line">
        {!h.transactions.length && <li className="p-4 text-xs text-muted">No transactions yet: builds, deploys, uploads and schema changes record one.</li>}
        {h.transactions.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              onClick={() => setSel(x.id)}
              title={x.aborted ? "Aborted: the job succeeded but committed nothing" : undefined}
              className={`w-full border-b border-line px-3 py-2 text-left text-xs ${sel === x.id ? "bg-ocean/10" : "hover:bg-panel-2"} ${x.aborted ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${x.aborted ? "bg-line-2 text-muted" : x.kind === "rollback" ? "bg-warn/20 text-warn" : "bg-ok/15 text-ok"}`}>{x.kind}</span>
                <span className="font-mono text-soft">{x.id}</span>
                {!x.kept && !x.aborted && <span className="text-[10px] text-muted">data removed by retention</span>}
                {x.rolled_back && <span className="text-[10px] text-warn">rolled back</span>}
              </div>
              <div className="mt-0.5 text-muted">
                {x.aborted ? `${when(x.at)} · nothing committed` : `${when(x.at)} · ${x.rows?.toLocaleString() ?? "?"} rows · ${formatBytes(x.size)}`}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 text-sm">
        <section className="mb-5 rounded-xl border border-line bg-panel p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Summary</h3>
          <div className="flex flex-wrap gap-6 text-xs">
            <div>
              <div className="text-lg font-semibold">{h.summary.transactions}</div>transactions ({h.summary.kept} with data kept)
            </div>
            {!!h.summary.aborted && (
              <div title="Jobs that succeeded without committing a transaction">
                <div className="text-lg font-semibold text-muted">{h.summary.aborted}</div>aborted
              </div>
            )}
            {Object.entries(h.summary.by_kind).map(([k, n]) => (
              <div key={k}>
                <div className="text-lg font-semibold">{n}</div>
                {k}
              </div>
            ))}
            {Object.entries(h.summary.job_statuses).map(([k, n]) => (
              <div key={k}>
                <div className={`text-lg font-semibold ${k === "failed" ? "text-bad" : ""}`}>{n}</div>
                {k} jobs
              </div>
            ))}
          </div>
        </section>
        {t && (
          <section className="mb-5 rounded-xl border border-line bg-panel p-4 text-xs">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="font-semibold">Transaction {t.id}</h3>
              {(ds.kind === "parquet" || ds.kind === "raw") && t.kept && (
                <button
                  type="button"
                  className={`${buttonClass.secondary} ml-auto py-1 text-xs`}
                  onClick={async () => {
                    const name = await promptDialog("Name of the new branch", "", { title: "Create branch from this transaction" });
                    if (!name) return;
                    try {
                      const r = await datasetPreview.createBranch(ds.id, name, t.id);
                      onBranch(r.item_id);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Icon name="split" className="h-3.5 w-3.5" /> Create branch
                </button>
              )}
            </div>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
              <dt className="text-muted">When</dt>
              <dd>{new Date(t.at).toLocaleString()}</dd>
              <dt className="text-muted">Kind</dt>
              <dd>{t.kind}</dd>
              <dt className="text-muted">Rows · size</dt>
              <dd>
                {t.rows?.toLocaleString() ?? "?"} · {formatBytes(t.size)}
              </dd>
              <dt className="text-muted">Schema</dt>
              <dd className="font-mono">{t.columns.join(", ")}</dd>
              <dt className="text-muted">Source</dt>
              <dd className="font-mono break-all">{JSON.stringify(t.source)}</dd>
            </dl>
          </section>
        )}
        <section className="rounded-xl border border-line bg-panel p-4 text-xs">
          <h3 className="mb-2 font-semibold">Jobs</h3>
          {!h.jobs.length && <p className="text-muted">No builds recorded in Data Lineage (uploaded or ingested data).</p>}
          <ul className="space-y-1">
            {h.jobs.map((j, i) => (
              <li key={i} className="flex gap-2">
                <span className={j.status === "failed" ? "text-bad" : "text-ok"}>●</span>
                <span className="text-muted">{j.at ? when(j.at) : ""}</span>
                <span>{j.text}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Details

export function DetailsTab({ ds, onEditSchema, onChanged }: { ds: DatasetSummary; onEditSchema: () => void; onChanged: () => void }) {
  const [section, setSection] = useState<"schema" | "files" | "job" | "syncs" | "metadata" | "usage" | "lifetime">("schema");
  return (
    <div className="flex min-h-0 flex-1">
      <ul className="w-48 shrink-0 border-r border-line py-2 text-sm">
        {(
          [
            ["schema", "Schema"],
            ["files", "Files"],
            ["job", "Job spec"],
            ["syncs", "Syncs"],
            ["metadata", "Custom metadata"],
            ["usage", "Resource usage metrics"],
            ["lifetime", "Lineage-aware retention policies"],
          ] as const
        ).map(([k, l]) => (
          <li key={k}>
            <button type="button" onClick={() => setSection(k)} className={`w-full px-4 py-1.5 text-left ${section === k ? "bg-ocean/10 text-white" : "text-soft hover:bg-panel-2"}`}>
              {l}
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 text-sm">
        {section === "lifetime" && <LifetimePanel datasetId={ds.id} />}
        {section === "schema" && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs text-muted">
                {ds.reader?.split(".").pop()} · {ds.schema_saved ? "saved" : "inferred (not saved yet)"}
              </span>
              {ds.kind !== "parquet" ? (
                <button type="button" onClick={onEditSchema} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
                  <Icon name="edit" className="h-3.5 w-3.5" /> Edit
                </button>
              ) : (
                <span className="ml-auto text-xs text-muted">Written by its build: change the transform or pipeline to change it.</span>
              )}
            </div>
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-ink p-3 font-mono text-[11px] text-soft">{JSON.stringify(ds.schema, null, 2)}</pre>
          </div>
        )}
        {section === "files" && <FilesSection ds={ds} />}
        {section === "job" && (
          <div className="space-y-3 text-xs">
            <SqlDefinitions itemId={ds.id} onBuilt={onChanged} />
            {!ds.producers.length && <p className="text-muted">No job builds this dataset: it was uploaded or synced.</p>}
            {ds.producers.map((p) => (
              <div key={p.id} className="rounded-md border border-line p-3">
                <div className="flex items-center gap-2 font-medium">
                  <Icon name={p.kind === "pipeline" ? "pipeline" : "code"} className="h-3.5 w-3.5 text-ocean" />
                  {p.link ? (
                    <Link href={p.link} className="hover:underline">
                      {p.name}
                    </Link>
                  ) : (
                    p.name
                  )}
                  <span className="text-muted">{p.kind}</span>
                </div>
                {p.replaced_by && (
                  <p className="mt-1 text-amber-300">
                    Replaced: {p.replaced_by.name} has written this dataset since {p.replaced_by.at ? when(p.replaced_by.at) : "its last build"}. Kept as history; the lineage
                    draws and builds the current producer only.
                  </p>
                )}
                <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-y-1">
                  <dt className="text-muted">Last written</dt>
                  <dd>{p.at ? when(p.at) : "—"}</dd>
                  {p.commit && (
                    <>
                      <dt className="text-muted">Commit</dt>
                      <dd className="font-mono">{p.commit.slice(0, 12)}</dd>
                    </>
                  )}
                  <dt className="text-muted">Inputs</dt>
                  <dd>{ds.inputs.filter((i) => i.kind === "dataset" || i.kind === "datasource").map((i) => i.name).join(", ") || "—"}</dd>
                </dl>
              </div>
            ))}
            {ds.lineage_id && (
              <Link href={`/lineage?node=${encodeURIComponent(ds.lineage_id)}`} className="text-ocean hover:underline">
                Open the logic in Data Lineage →
              </Link>
            )}
          </div>
        )}
        {section === "syncs" && (
          <div className="text-xs">
            {ds.inputs.filter((i) => i.kind === "datasource").length ? (
              <ul className="space-y-1">
                {ds.inputs
                  .filter((i) => i.kind === "datasource")
                  .map((i) => (
                    <li key={i.id}>
                      <Link href={i.link ?? "/sources"} className="text-ocean hover:underline">
                        {i.name}
                      </Link>{" "}
                      <span className="text-muted">Data Connection sync writing this dataset</span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-muted">No Data Connection sync writes this dataset.</p>
            )}
          </div>
        )}
        {section === "metadata" && <MetadataSection ds={ds} onChanged={onChanged} />}
        {section === "usage" && <UsageSection ds={ds} />}
      </div>
    </div>
  );
}

function FilesSection({ ds }: { ds: DatasetSummary }) {
  const [files, setFiles] = useState<Awaited<ReturnType<typeof datasetPreview.files>> | null>(null);
  useEffect(() => {
    datasetPreview.files(ds.id).then(setFiles, () => setFiles([]));
  }, [ds.id]);
  if (!files) return <Loading />;
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted">
        <tr>
          <th className="py-1 font-medium">File</th>
          <th className="font-medium">Size</th>
          <th className="font-medium">Updated</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {files.map((f) => (
          <tr key={f.id} className="border-t border-line">
            <td className="py-1.5 font-mono">{f.name}</td>
            <td>{formatBytes(f.size)}</td>
            <td>{when(f.updated_at)}</td>
            <td className="text-right">
              <a href={driveContentUrl(f.id)} className="text-ocean hover:underline">
                Download
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MetadataSection({ ds, onChanged }: { ds: DatasetSummary; onChanged: () => void }) {
  const [rows, setRows] = useState<[string, string][]>(Object.entries(ds.custom_metadata));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="max-w-xl space-y-2 text-xs">
      <p className="text-muted">Fields shown in the information panel (About).</p>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <input value={k} placeholder="Field" onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} className={`${fieldClass} w-40`} />
          <input value={v} placeholder="Value" onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} className={inputClass} />
          <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove field">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" onClick={() => setRows([...rows, ["", ""]])} className={buttonClass.ghost}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Field
        </button>
        <button
          type="button"
          onClick={() => datasetPreview.saveMetadata(ds.id, Object.fromEntries(rows.filter(([k]) => k.trim()))).then(onChanged, (e: Error) => setError(e.message))}
          className={`${buttonClass.primary} ml-auto py-1 text-xs`}
        >
          <Icon name="save" className="h-3.5 w-3.5" /> Save
        </button>
      </div>
      {error && <p className="text-bad">{error}</p>}
    </div>
  );
}

function UsageSection({ ds }: { ds: DatasetSummary }) {
  const [u, setU] = useState<Awaited<ReturnType<typeof datasetPreview.usage>> | null>(null);
  useEffect(() => {
    datasetPreview.usage(ds.id).then(setU, () => setU({ points: [], current_size: 0, versions_on_disk: 0 }));
  }, [ds.id]);
  if (!u) return <Loading />;
  const max = Math.max(1, ...u.points.map((p) => p.size));
  return (
    <div className="space-y-3 text-xs">
      <div className="flex gap-6">
        <div>
          <div className="text-lg font-semibold">{formatBytes(u.current_size)}</div>current size on disk
        </div>
        <div>
          <div className="text-lg font-semibold">{formatBytes(u.versions_on_disk)}</div>kept versions (Time Travel, rollback)
        </div>
      </div>
      <div>
        <div className="mb-1 text-muted">Size per transaction</div>
        <div className="flex h-32 items-end gap-1 border-b border-line">
          {u.points.map((p, i) => (
            <div key={i} title={`${p.at.slice(0, 16).replace("T", " ")} · ${formatBytes(p.size)} · ${p.rows ?? "?"} rows`} className="flex-1 rounded-t bg-ocean/70" style={{ height: `${(p.size / max) * 100}%`, maxWidth: 28 }} />
          ))}
        </div>
        {!u.points.length && <p className="mt-2 text-muted">No transactions yet.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Health

export function HealthTab({ ds }: { ds: DatasetSummary }) {
  const [h, setH] = useState<Awaited<ReturnType<typeof datasetPreview.health>> | null>(null);
  useEffect(() => {
    datasetPreview.health(ds.id).then(setH, () => setH({ rules: [], evaluation: null }));
  }, [ds.id]);
  if (!h) return <Loading />;
  return (
    <div className="max-w-3xl space-y-4 p-4 text-sm">
      {h.evaluation ? (
        <div className={`rounded-xl border p-4 ${h.evaluation.status === "failing" ? "border-bad/40 bg-bad/5" : "border-ok/40 bg-ok/5"}`}>
          <div className="mb-2 font-semibold">{h.evaluation.status === "failing" ? "Failing checks" : "All checks pass"}</div>
          <ul className="space-y-1 text-xs">
            {h.evaluation.results.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className={r.ok ? "text-ok" : "text-bad"}>{r.ok ? "✓" : "✕"}</span>
                <span className="font-medium">{r.kind}</span>
                <span className="text-muted">{r.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted">No health checks on this dataset yet.</p>
      )}
      {ds.schedules.length > 0 && (
        <div className="rounded-xl border border-line bg-panel p-4 text-xs">
          <div className="mb-1 font-semibold">Schedules that build it</div>
          {ds.schedules.map((s, i) => (
            <div key={i}>
              {s.name} · {s.cron ?? ""} {s.enabled === false ? "(off)" : ""} — {s.producer}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Link href={`/data-health?add=${encodeURIComponent(`dataset:${ds.id}`)}&name=${encodeURIComponent(ds.name)}`} className={buttonClass.secondary}>
          <Icon name="bell" className="h-3.5 w-3.5" /> Add checks in Data Health
        </Link>
        {ds.lineage_id && (
          <Link href={`/lineage?node=${encodeURIComponent(ds.lineage_id)}`} className={buttonClass.ghost}>
            Data Lineage health rules
          </Link>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Compare

export function DiffView({ d, aLabel, bLabel }: { d: Diff; aLabel: string; bLabel: string }) {
  const [tab, setTab] = useState<"added" | "removed" | "modified">(d.modified ? "modified" : d.added ? "added" : "removed");
  const cols = d.compared_columns;
  const rows = tab === "added" ? d.added_rows : tab === "removed" ? d.removed_rows : [];
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap gap-4">
        <span>
          <b>{d.rows_a.toLocaleString()}</b> rows in {aLabel} → <b>{d.rows_b.toLocaleString()}</b> in {bLabel}
        </span>
        {d.key ? <span className="text-muted">matched on {d.key}{d.key_unique === false ? " (not unique!)" : ""}</span> : <span className="text-muted">no key column: edits show as removed + added</span>}
      </div>
      {d.schema.length > 0 && (
        <div className="rounded-md border border-warn/40 bg-warn/5 p-2">
          <div className="mb-1 font-medium">Schema changes</div>
          {d.schema.map((s, i) => (
            <div key={i} className="font-mono">
              {s.change === "added" ? "+" : s.change === "removed" ? "−" : "~"} {s.column} {s.change === "type" ? `${s.from} → ${s.to}` : s.type}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        {(
          [
            ["added", `Added ${d.added}`, "text-ok"],
            ["removed", `Removed ${d.removed}`, "text-bad"],
            ["modified", `Modified ${d.modified}`, "text-warn"],
          ] as const
        ).map(([k, l, c]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`rounded-md px-2.5 py-1 ${tab === k ? "bg-panel-2" : ""} ${c}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-md border border-line">
        <table className="min-w-full">
          <thead className="sticky top-0 bg-panel text-left">
            <tr>
              {tab === "modified" && <th className="px-2 py-1">key</th>}
              {cols.map((c) => (
                <th key={c} className="whitespace-nowrap px-2 py-1 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tab === "modified"
              ? d.modified_rows.map((m, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="px-2 py-1 font-mono">{cellText(m.key)}</td>
                    {cols.map((c) => (
                      <td key={c} className={`px-2 py-1 ${m.cells.includes(c) ? "bg-warn/10" : ""}`}>
                        {m.cells.includes(c) ? (
                          <>
                            <span className="text-bad line-through">{cellText(m.before[c])}</span> <span className="text-ok">{cellText(m.after[c])}</span>
                          </>
                        ) : (
                          cellText(m.after[c])
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((r, i) => (
                  <tr key={i} className={`border-t border-line ${tab === "added" ? "bg-ok/5" : "bg-bad/5"}`}>
                    {cols.map((c) => (
                      <td key={c} className="px-2 py-1">
                        {cellText(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CompareTab({ ds, transactions }: { ds: DatasetSummary; transactions: Transaction[] }) {
  const [target, setTarget] = useState<"version" | "branch" | "dataset">("version");
  const [tx, setTx] = useState(transactions[1]?.id ?? transactions[0]?.id ?? "");
  const [branch, setBranch] = useState(ds.branches.find((b) => b.item_id !== ds.id)?.item_id ?? "");
  const [other, setOther] = useState<DatasetListing | null>(null);
  const [q, setQ] = useState("");
  const [list, setList] = useState<DatasetListing[]>([]);
  const [key, setKey] = useState("");
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (target !== "dataset") return;
    const t = setTimeout(() => datasetPreview.list(q).then((l) => setList(l.filter((x) => x.id !== ds.id)), () => setList([])), 200);
    return () => clearTimeout(t);
  }, [q, target, ds.id]);
  const run = async () => {
    setError(null);
    try {
      const body =
        target === "version"
          ? { base: { transaction: tx }, other: {}, key: key || null }
          : target === "branch"
            ? { other: { item_id: branch }, key: key || null }
            : { other: { item_id: other?.id }, key: key || null };
      setDiff(await datasetPreview.compare(ds.id, body as Parameters<typeof datasetPreview.compare>[1]));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
      <div className="mb-4 flex flex-wrap items-end gap-2 text-xs">
        <label>
          <span className="mb-1 block text-soft">Compare with</span>
          <select value={target} onChange={(e) => (setTarget(e.target.value as typeof target), setDiff(null))} className={fieldClass}>
            <option value="version">an older transaction of this dataset</option>
            <option value="branch" disabled={ds.branches.length < 2}>
              another branch
            </option>
            <option value="dataset">another dataset</option>
          </select>
        </label>
        {target === "version" && (
          <select value={tx} onChange={(e) => setTx(e.target.value)} className={`${fieldClass} max-w-xs`}>
            {transactions.filter((t) => t.kept).map((t) => (
              <option key={t.id} value={t.id}>
                {txLabel(t)}
              </option>
            ))}
          </select>
        )}
        {target === "branch" && (
          <select value={branch} onChange={(e) => setBranch(e.target.value)} className={fieldClass}>
            {ds.branches.filter((b) => b.item_id !== ds.id).map((b) => (
              <option key={b.item_id} value={b.item_id}>
                {b.branch}
              </option>
            ))}
          </select>
        )}
        {target === "dataset" && (
          <div className="relative">
            <input value={other ? other.name : q} onChange={(e) => (setOther(null), setQ(e.target.value))} placeholder="Search datasets" className={`${fieldClass} w-64`} />
            {!other && list.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-60 w-80 overflow-y-auto rounded-md border border-line bg-panel shadow-xl">
                {list.slice(0, 30).map((l) => (
                  <li key={l.id}>
                    <button type="button" onClick={() => setOther(l)} className="block w-full px-2 py-1 text-left hover:bg-panel-2">
                      {l.name} <span className="text-muted">{l.path.join(" / ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <label>
          <span className="mb-1 block text-soft">Key column (optional)</span>
          <select value={key} onChange={(e) => setKey(e.target.value)} className={fieldClass}>
            <option value="">none</option>
            {ds.columns.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={run} disabled={(target === "version" && !tx) || (target === "dataset" && !other) || (target === "branch" && !branch)} className={buttonClass.primary}>
          Compare
        </button>
      </div>
      {error && <p className="mb-3 text-bad">{error}</p>}
      {target === "version" && !transactions.filter((t) => t.kept).length && <p className="text-xs text-muted">No earlier transaction with kept data.</p>}
      {diff && (
        <DiffView
          d={diff}
          aLabel={target === "version" ? `transaction ${tx}` : "this dataset"}
          bLabel={target === "version" ? "the current version" : target === "branch" ? (ds.branches.find((b) => b.item_id === branch)?.branch ?? "the branch") : (other?.name ?? "the other dataset")}
        />
      )}
      {diff && target !== "version" && (
        <p className="mt-2 text-[11px] text-muted">
          Rows only in <Link href={datasetHref(ds.id)} className="underline">this dataset</Link> are “removed”, rows only in the other are “added”.
        </p>
      )}
    </div>
  );
}
