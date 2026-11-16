"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { cellText, datasetPreview, type BisectResult, type Column, type DatasetSummary, type Diff, type Transaction } from "@/lib/datasetPreview";
import { PreviewTable } from "./PreviewTable";
import { DiffView } from "./Tabs";

type BisectForm = { mode: "row_added" | "row_removed" | "value_changed"; key: string; key_value: string; column: string; value: string };

/**
 * Time Travel [Beta]: the dataset's committed versions (transactions whose data is still kept) as a timeline.
 * Single version: the data and schema at one version (← / → step through them); Refine query runs SQL over `dataset`
 * and follows the version. Range: rows added, removed and (with a key column) modified between two versions, and the
 * schema changes. Bisect: the first loaded version where a row was added or removed, or a cell changed.
 */
export function TimeTravel({ ds, transactions }: { ds: DatasetSummary; transactions: Transaction[] }) {
  const versions = useMemo(() => [...transactions].filter((t) => t.kept).reverse(), [transactions]);
  const [view, setView] = useState<"single" | "range">("single");
  const [index, setIndex] = useState(versions.length - 1);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(versions.length - 1);
  const [key, setKey] = useState("");
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sql, setSql] = useState<string | null>(null);
  const [sqlText, setSqlText] = useState("SELECT * FROM dataset LIMIT 100");
  const [sqlResult, setSqlResult] = useState<{ columns: Column[]; rows: Record<string, unknown>[]; truncated: boolean } | null>(null);
  const [bisect, setBisect] = useState<BisectForm | null>(null);
  const [bisectResult, setBisectResult] = useState<BisectResult | null>(null);
  const tx = versions[index];

  // ← / → move through the loaded versions
  useEffect(() => {
    if (view !== "single") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setIndex((i) => Math.min(versions.length - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, versions.length]);

  // a refined query follows the selected version
  const runSql = useCallback(() => {
    if (!sql || !tx) return;
    datasetPreview.query(ds.id, sql, tx.id).then(
      (r) => {
        setSqlResult(r);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [sql, tx, ds.id]);
  useEffect(runSql, [runSql]);

  const runRange = async () => {
    setError(null);
    try {
      setDiff(await datasetPreview.range(ds.id, { from_transaction: versions[from].id, to_transaction: versions[to].id, key: key || null }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const runBisect = async () => {
    if (!bisect) return;
    setError(null);
    try {
      const r = await datasetPreview.bisect(ds.id, {
        mode: bisect.mode,
        key: bisect.key,
        key_value: bisect.key_value,
        column: bisect.mode === "value_changed" ? bisect.column : undefined,
        value: bisect.mode === "value_changed" && bisect.value !== "" ? bisect.value : undefined,
        transactions: versions.map((v) => v.id),
      });
      setBisectResult(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!versions.length)
    return <p className="p-6 text-sm text-muted">No committed versions with data yet. Builds, deploys, uploads and schema changes record versions (retention may remove older copies).</p>;
  const keyCandidate = key || ds.columns[0]?.name || "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <div className="flex overflow-hidden rounded-md border border-line">
          {(
            [
              ["single", "Single version"],
              ["range", "Range"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setView(k)} className={`px-3 py-1 ${view === k ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}>
              {l}
            </button>
          ))}
        </div>
        <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">Beta</span>
        <span className="text-muted">{versions.length} committed versions loaded</span>
        <span className="ml-auto" />
        {view === "single" && (
          <button type="button" onClick={() => setSql(sql === null ? sqlText : null)} className={`${buttonClass.secondary} py-1 text-xs`}>
            <Icon name="code" className="h-3.5 w-3.5" /> {sql === null ? "Refine query" : "Close query"}
          </button>
        )}
        <button type="button" onClick={() => setBisect(bisect ? null : { mode: "row_added", key: keyCandidate, key_value: "", column: "", value: "" })} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="search" className="h-3.5 w-3.5" /> Bisect
        </button>
      </div>
      {/* the timeline: one dot per committed version, oldest left */}
      <div className="border-b border-line px-4 py-3">
        <div className="relative flex items-center justify-between">
          <div className="absolute inset-x-0 top-1/2 h-px bg-line-2" />
          {versions.map((v, i) => {
            const inRange = view === "range" && i >= Math.min(from, to) && i <= Math.max(from, to);
            const active = view === "single" ? i === index : i === from || i === to;
            return (
              <button
                key={v.id}
                type="button"
                title={`${v.at.slice(0, 19).replace("T", " ")} · ${v.kind} · ${v.rows ?? "?"} rows`}
                onClick={() => (view === "single" ? setIndex(i) : i < to ? setFrom(i) : setTo(i))}
                className={`relative z-10 h-3.5 w-3.5 rounded-full border-2 ${active ? "border-white bg-ocean" : inRange ? "border-ocean bg-ocean/40" : "border-line-2 bg-panel hover:border-ocean"}`}
                aria-label={`Version ${i + 1}`}
              />
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-muted">
          <span>{versions[0].at.slice(0, 16).replace("T", " ")}</span>
          {view === "single" && tx && (
            <span className="text-soft">
              Version {index + 1} of {versions.length} · {tx.at.slice(0, 19).replace("T", " ")} · {tx.kind} · {tx.rows?.toLocaleString() ?? "?"} rows · ← →
            </span>
          )}
          <span>{versions[versions.length - 1].at.slice(0, 16).replace("T", " ")}</span>
        </div>
      </div>
      {error && <p className="px-4 py-2 text-xs text-bad">{error}</p>}
      {bisect && (
        <div className="flex flex-wrap items-end gap-2 border-b border-line bg-panel-2/40 px-4 py-2 text-xs">
          <select value={bisect.mode} onChange={(e) => setBisect({ ...bisect, mode: e.target.value as BisectForm["mode"] })} className={fieldClass}>
            <option value="row_added">When was the row added?</option>
            <option value="row_removed">When was the row removed?</option>
            <option value="value_changed">When did a cell value change?</option>
          </select>
          <label>
            <span className="block text-muted">Key column</span>
            <select value={bisect.key} onChange={(e) => setBisect({ ...bisect, key: e.target.value })} className={fieldClass}>
              {ds.columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="block text-muted">Key value</span>
            <input value={bisect.key_value} onChange={(e) => setBisect({ ...bisect, key_value: e.target.value })} className={`${fieldClass} w-32`} />
          </label>
          {bisect.mode === "value_changed" && (
            <>
              <label>
                <span className="block text-muted">Column</span>
                <select value={bisect.column} onChange={(e) => setBisect({ ...bisect, column: e.target.value })} className={fieldClass}>
                  <option value="">—</option>
                  {ds.columns.map((c) => (
                    <option key={c.name}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="block text-muted">Changed to (optional)</span>
                <input value={bisect.value} onChange={(e) => setBisect({ ...bisect, value: e.target.value })} className={`${fieldClass} w-32`} />
              </label>
            </>
          )}
          <button type="button" onClick={runBisect} disabled={!bisect.key || bisect.key_value === "" || (bisect.mode === "value_changed" && !bisect.column)} className={buttonClass.primary}>
            Search
          </button>
          {bisectResult &&
            (bisectResult.found ? (
              <span className="flex items-center gap-2">
                Found in version {(versions.findIndex((v) => v.id === bisectResult.transaction) ?? 0) + 1}
                {bisectResult.before !== undefined && bisectResult.after !== undefined && (
                  <span className="font-mono text-muted">
                    {cellText(bisectResult.before)} → {cellText(bisectResult.after)}
                  </span>
                )}
                {bisectResult.note && <span className="text-muted">({bisectResult.note})</span>}
                <button
                  type="button"
                  onClick={() => {
                    setView("single");
                    setIndex(versions.findIndex((v) => v.id === bisectResult.transaction));
                  }}
                  className="text-ocean hover:underline"
                >
                  Go to version
                </button>
              </span>
            ) : (
              <span className="text-muted">Not found in the {bisectResult.searched} loaded versions.</span>
            ))}
          <span className="basis-full text-[11px] text-muted">Bisect searches only the versions loaded here. Right-click a cell to start from it.</span>
        </div>
      )}
      {view === "single" && tx && (
        <div className="flex min-h-0 flex-1 flex-col">
          {sql !== null && (
            <div className="border-b border-line p-3">
              <textarea value={sqlText} onChange={(e) => setSqlText(e.target.value)} rows={3} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                <button type="button" onClick={() => setSql(sqlText)} className={`${buttonClass.primary} py-1 text-xs`}>
                  Run
                </button>
                The table is <code>dataset</code>; the query follows the selected version as you move through the timeline.
              </div>
            </div>
          )}
          {sql !== null ? (
            sqlResult ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-panel text-left">
                    <tr>
                      {sqlResult.columns.map((c) => (
                        <th key={c.name} className="border-b border-line px-2 py-1.5 font-medium">
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sqlResult.rows.map((r, i) => (
                      <tr key={i}>
                        {sqlResult.columns.map((c) => (
                          <td key={c.name} className="border-b border-line px-2 py-1">
                            {cellText(r[c.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sqlResult.truncated && <p className="p-2 text-xs text-muted">The first 1,000 rows.</p>}
              </div>
            ) : (
              <Loading />
            )
          ) : (
            <>
              <div className="border-b border-line px-3 py-1.5 text-[11px] text-muted">Schema: {tx.columns.join(", ")}</div>
              <PreviewTable
                key={tx.id}
                datasetId={ds.id}
                transaction={tx.id}
                cellActions={(c) => [
                  { label: `Bisect: when was this row added? (by ${keyCandidate})`, onClick: () => setBisect({ mode: "row_added", key: keyCandidate, key_value: cellText(c.row[keyCandidate]), column: "", value: "" }) },
                  { label: `Bisect: when did ${c.column} become this value?`, onClick: () => setBisect({ mode: "value_changed", key: keyCandidate, key_value: cellText(c.row[keyCandidate]), column: c.column, value: cellText(c.value) }) },
                ]}
              />
            </>
          )}
        </div>
      )}
      {view === "range" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-4 flex flex-wrap items-end gap-2 text-xs">
            <label>
              <span className="mb-1 block text-soft">Baseline (older)</span>
              <select value={from} onChange={(e) => setFrom(Number(e.target.value))} className={fieldClass}>
                {versions.map((v, i) => (
                  <option key={v.id} value={i} disabled={i >= to}>
                    {i + 1}. {v.at.slice(0, 19).replace("T", " ")} ({v.kind})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-soft">Newer version</span>
              <select value={to} onChange={(e) => setTo(Number(e.target.value))} className={fieldClass}>
                {versions.map((v, i) => (
                  <option key={v.id} value={i} disabled={i <= from}>
                    {i + 1}. {v.at.slice(0, 19).replace("T", " ")} ({v.kind})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-soft">Key column</span>
              <select value={key} onChange={(e) => setKey(e.target.value)} className={fieldClass}>
                <option value="">none (edits show as removed + added)</option>
                {ds.columns.map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </select>
            </label>
            <button type="button" onClick={runRange} disabled={from >= to} className={buttonClass.primary}>
              Show changes
            </button>
          </div>
          {diff && <DiffView d={diff} aLabel={`version ${from + 1}`} bLabel={`version ${to + 1}`} />}
        </div>
      )}
    </div>
  );
}
