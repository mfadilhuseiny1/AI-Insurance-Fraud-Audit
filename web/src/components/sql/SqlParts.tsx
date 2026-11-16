"use client";

import { useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { resultCsv, type SqlResult } from "@/lib/sqlStudio";
import { allowExport } from "@/lib/checkpoints";

/** The SQL editor: line numbers and a textarea; Ctrl/Cmd+Enter runs the query, or only the selected text. */
export function SqlEditor({ value, onChange, onRun, minHeight = 220 }: { value: string; onChange: (v: string) => void; onRun: (sql: string) => void; minHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <div className="select-none border-r border-line px-3 py-3 text-right font-mono text-xs leading-6 text-muted">
        {value.split("\n").map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            onRun(selectionOf(ref.current) ?? value);
          }
        }}
        spellCheck={false}
        style={{ minHeight }}
        className="flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-6 text-soft outline-none"
        aria-label="SQL query editor"
      />
    </div>
  );
}

/** The highlighted SQL of the editor, if any (Run runs only the selection). */
export function selectionOf(el: HTMLTextAreaElement | null): string | null {
  if (!el || el.selectionStart === el.selectionEnd) return null;
  const s = el.value.slice(el.selectionStart, el.selectionEnd);
  return s.trim() ? s : null;
}

export async function downloadCsv(r: SqlResult, name = "query-results") {
  if (!(await allowExport({ detail: `SQL results ${name} (CSV)` }))) return;
  const blob = new Blob([resultCsv(r)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w.-]+/g, "_") || "query-results"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return String(v);
}

const NUMERIC = /^(int|uint|float|double|decimal)/;

/** Results below the editor: a table or a chart of the preview rows, the status line and the CSV download. */
export function ResultsPanel({ result, error, running, onDownload }: { result: SqlResult | null; error: string | null; running: boolean; onDownload?: () => void }) {
  const [tab, setTab] = useState<"table" | "chart">("table");
  return (
    <section className="flex min-h-[250px] flex-1 flex-col border-t border-line bg-panel">
      <div className="flex items-center gap-4 border-b border-line px-4">
        {(["table", "chart"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`border-b-2 py-2.5 text-xs ${tab === t ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
            {t === "table" ? "Results" : "Chart"}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted">
          {running
            ? "Running…"
            : result
              ? `Completed in ${(result.ms / 1000).toFixed(2)}s · ${result.row_count.toLocaleString()} row${result.row_count === 1 ? "" : "s"}${result.truncated ? ` (the first ${result.row_count.toLocaleString()})` : ""}`
              : error
                ? "Failed"
                : "Run the query to see results"}
        </span>
        {result && onDownload && (
          <button type="button" onClick={onDownload} className="flex items-center gap-1 text-[10px] text-ocean hover:underline" title="Download the rows shown as CSV">
            <Icon name="download" className="h-3 w-3" /> Download
          </button>
        )}
      </div>
      {error ? (
        <pre className="m-3 whitespace-pre-wrap rounded-md border border-bad/30 bg-bad/10 p-3 font-mono text-xs text-bad">{error}</pre>
      ) : !result ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted">
          <Icon name="play" className="mr-2 h-4 w-4" />
          {running ? "Running…" : "Results will appear here"}
        </div>
      ) : tab === "table" ? (
        <ResultTable result={result} />
      ) : (
        <ResultChart result={result} />
      )}
    </section>
  );
}

function ResultTable({ result }: { result: SqlResult }) {
  if (!result.columns.length) return <p className="p-4 text-xs text-muted">The statement returned no columns.</p>;
  return (
    <div className="result-table min-h-0 flex-1 overflow-auto p-3">
      <table>
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.name} className="bg-panel-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted" title={c.type}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={`text-xs ${cell === null ? "text-muted italic" : "text-soft"}`}>
                  {show(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultChart({ result }: { result: SqlResult }) {
  const numeric = result.columns.filter((c) => NUMERIC.test(c.type));
  const labels = result.columns.filter((c) => !NUMERIC.test(c.type));
  const [label, setLabel] = useState<string>(labels[0]?.name ?? result.columns[0]?.name ?? "");
  const [value, setValue] = useState<string>(numeric[0]?.name ?? "");
  const bars = useMemo(() => {
    const li = result.columns.findIndex((c) => c.name === label);
    const vi = result.columns.findIndex((c) => c.name === value);
    if (vi < 0) return [];
    return result.rows.slice(0, 40).map((r) => ({ label: li >= 0 ? show(r[li]) : "", value: Number(r[vi]) || 0 }));
  }, [result, label, value]);
  if (!numeric.length) return <p className="p-4 text-xs text-muted">A chart needs a numeric column in the results.</p>;
  const max = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 pt-3 text-[11px] text-muted">
        Label
        <select value={label} onChange={(e) => setLabel(e.target.value)} className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-soft outline-none">
          {result.columns.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
        Value
        <select value={value} onChange={(e) => setValue(e.target.value)} className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-soft outline-none">
          {numeric.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
        {result.rows.length > 40 && <span>first 40 rows</span>}
      </div>
      <div className="flex min-h-0 flex-1 items-end gap-5 px-10 pb-8 pt-5">
        <div className="flex h-full flex-1 items-end justify-around gap-2 border-b border-line-2">
          {bars.map((b, i) => (
            <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2" title={`${b.label}: ${b.value}`}>
              <span className="text-[10px] text-muted">{show(b.value)}</span>
              <div className={`w-full max-w-14 rounded-t ${i % 4 === 3 ? "bg-sand/70" : ["bg-ocean", "bg-ocean/70", "bg-ocean/50"][i % 4]}`} style={{ height: `${(Math.abs(b.value) / max) * 85}%` }} />
              <span className="w-full truncate text-center text-[10px] text-muted">{b.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
