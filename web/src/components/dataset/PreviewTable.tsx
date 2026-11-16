"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { cellText, datasetPreview, typeShort, type Chart, type Column, type Filter, type FilterOp, type Rows, type Sort } from "@/lib/datasetPreview";

const OP_LABEL: Record<FilterOp, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  not_in: "is not one of",
  contains: "contains",
  not_contains: "does not contain",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  is_null: "is empty",
  not_null: "is not empty",
};
export const filterLabel = (f: Filter) =>
  `${f.column} ${OP_LABEL[f.op]}${f.op === "is_null" || f.op === "not_null" ? "" : ` ${Array.isArray(f.value) ? f.value.map(cellText).join(", ") : cellText(f.value)}`}`;

export type CellContext = { column: string; value: unknown; row: Record<string, unknown> };

/**
 * The preview table: a page of the rows (the header says which and of how many; page through, or go to any row);
 * sorting, filtering and the row search run over the whole dataset version — for a big dataset out of core, over every
 * row on disk. Column menu: sort, filter, chart, report an issue. Cell: exclude or keep only its value (and, in Time
 * Travel, start a bisect from the right-click menu).
 */
export function PreviewTable({
  datasetId,
  transaction,
  onReportIssue,
  cellActions,
  sampleSize = 100,
}: {
  datasetId: string;
  transaction?: string | null;
  onReportIssue?: (column: string) => void;
  cellActions?: (ctx: CellContext) => { label: string; onClick: () => void }[];
  sampleSize?: number;
}) {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sort, setSortState] = useState<Sort[]>([]);
  const [limit, setLimit] = useState(sampleSize);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [goTo, setGoTo] = useState("");
  const [data, setData] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colQuery, setColQuery] = useState("");
  const [menu, setMenu] = useState<{ column: Column; x: number; y: number } | null>(null);
  const [cellMenu, setCellMenu] = useState<(CellContext & { x: number; y: number }) | null>(null);
  const [filterFor, setFilterFor] = useState<Column | null>(null);
  const [chartFor, setChartFor] = useState<string | null>(null);
  const load = useCallback(() => {
    let live = true;
    datasetPreview.rows(datasetId, { transaction, filters, sort, limit, offset, search }).then(
      (r) => {
        if (!live) return;
        setData(r);
        setError(null);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [datasetId, transaction, filters, sort, limit, offset, search]);
  useEffect(load, [load]);
  const setSort = (s: Sort[]) => (setSortState(s), setOffset(0));
  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.floor((total - 1) / limit) * limit);
  const jump = (row: number) => setOffset(Math.min(lastPage, Math.max(0, Math.floor((row - 1) / limit) * limit)));
  useEffect(() => {
    const close = () => (setMenu(null), setCellMenu(null));
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  const shown = (data?.columns ?? []).filter((c) => !colQuery.trim() || c.name.toLowerCase().includes(colQuery.trim().toLowerCase()));
  const addFilter = (f: Filter) => {
    setFilters((cur) => [...cur, f]);
    setOffset(0);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <span className="text-muted">
          {data ? (
            <>
              {data.rows.length
                ? `Rows ${(offset + 1).toLocaleString()}–${(offset + data.rows.length).toLocaleString()} of ${data.total.toLocaleString()}`
                : `${data.total.toLocaleString()} rows`}
              {data.total !== data.dataset_rows ? ` (${data.dataset_rows.toLocaleString()} in the dataset)` : ""}
            </>
          ) : (
            "Loading…"
          )}
        </span>
        {data?.out_of_core && (
          <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok" title={data.out_of_core.note}>
            All rows · read from disk
          </span>
        )}
        {search && (
          <span className="flex items-center gap-1 rounded-full border border-ocean/40 bg-ocean/10 px-2 py-0.5 text-soft">
            any column contains “{search}”
            <button type="button" onClick={() => (setSearch(""), setSearchDraft(""), setOffset(0))} aria-label="Clear the row search" className="text-muted hover:text-white">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </span>
        )}
        {filters.map((f, i) => (
          <span key={i} className="flex items-center gap-1 rounded-full border border-ocean/40 bg-ocean/10 px-2 py-0.5 text-soft">
            {filterLabel(f)}
            <button type="button" onClick={() => (setFilters(filters.filter((_, j) => j !== i)), setOffset(0))} aria-label="Remove filter" className="text-muted hover:text-white">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </span>
        ))}
        {sort.map((s) => (
          <span key={s.column} className="flex items-center gap-1 rounded-full border border-line-2 px-2 py-0.5 text-soft">
            {s.column} {s.desc ? "↓" : "↑"}
            <button type="button" onClick={() => setSort(sort.filter((x) => x.column !== s.column))} aria-label="Remove sort" className="text-muted hover:text-white">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </span>
        ))}
        <form
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(searchDraft.trim());
            setOffset(0);
          }}
          title="Rows where any column contains this text (every row of the dataset). Press Enter."
        >
          <Icon name="search" className="h-3.5 w-3.5 text-muted" />
          <input value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="Search rows" className="w-36 bg-transparent py-1 outline-none" />
        </form>
        <div className="flex items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2">
          <Icon name="grid" className="h-3.5 w-3.5 text-muted" />
          <input value={colQuery} onChange={(e) => setColQuery(e.target.value)} placeholder="Search columns" className="w-32 bg-transparent py-1 outline-none" />
        </div>
      </div>
      {error && <div className="m-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              <th className="border-b border-r border-line px-2 py-1.5 text-right font-normal text-muted">#</th>
              {shown.map((c) => {
                const s = sort.find((x) => x.column === c.name);
                return (
                  <th key={c.name} className="whitespace-nowrap border-b border-r border-line px-2 py-1.5 text-left font-medium">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setMenu({ column: c, x: r.left, y: r.bottom });
                      }}
                      className="flex items-center gap-1.5 hover:text-ocean"
                      title={c.description ?? `${c.name} (${c.type})`}
                    >
                      <span className="rounded bg-panel-2 px-1 font-mono text-[9px] text-muted">{typeShort(c.type)}</span>
                      {c.name}
                      {s && <span className="text-ocean">{s.desc ? "↓" : "↑"}</span>}
                      <Icon name="down" className="h-3 w-3 text-muted" />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r, i) => (
              <tr key={i} className="hover:bg-panel-2/60">
                <td className="border-b border-r border-line px-2 py-1 text-right font-mono text-[10px] text-muted">{(offset + i + 1).toLocaleString()}</td>
                {shown.map((c) => {
                  const v = r[c.name];
                  return (
                    <td
                      key={c.name}
                      onClick={(e) => (e.stopPropagation(), setCellMenu({ column: c.name, value: v, row: r, x: e.clientX, y: e.clientY }))}
                      onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), setCellMenu({ column: c.name, value: v, row: r, x: e.clientX, y: e.clientY }))}
                      className={`max-w-72 cursor-pointer truncate border-b border-r border-line px-2 py-1 ${v === null || v === undefined ? "italic text-muted" : typeof v === "number" ? "text-right font-mono" : ""}`}
                      title={cellText(v)}
                    >
                      {v === null || v === undefined ? "null" : cellText(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.rows.length && <p className="p-8 text-center text-sm text-muted">No rows{filters.length || search ? " match the filters" : ""}{offset ? " on this page" : ""}.</p>}
      </div>
      {data && data.total > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-1.5 text-xs">
          {(
            [
              ["First page", "«", 0, offset === 0],
              ["Previous page", "‹", Math.max(0, offset - limit), offset === 0],
              ["Next page", "›", offset + limit, offset + limit >= total],
              ["Last page", "»", lastPage, offset >= lastPage],
            ] as const
          ).map(([label, glyph, to, disabled]) => (
            <button key={label} type="button" disabled={disabled} onClick={() => setOffset(to)} aria-label={label} title={label} className={`${buttonClass.secondary} px-2 py-0.5 disabled:opacity-40`}>
              {glyph}
            </button>
          ))}
          <span className="text-muted">
            Page {(Math.floor(offset / limit) + 1).toLocaleString()} of {(Math.floor(lastPage / limit) + 1).toLocaleString()}
          </span>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(goTo.replace(/[^0-9]/g, ""));
              if (n > 0) jump(n);
            }}
          >
            <span className="text-muted">Go to row</span>
            <input value={goTo} onChange={(e) => setGoTo(e.target.value)} inputMode="numeric" placeholder={total.toLocaleString()} className={`${fieldClass} w-28 py-0.5`} />
          </form>
          <label className="ml-auto flex items-center gap-1 text-muted">
            Rows per page
            <select value={limit} onChange={(e) => (setLimit(Number(e.target.value)), setOffset(0))} className={`${fieldClass} py-0.5`}>
              {[...new Set([sampleSize, 100, 500, 1000, 5000])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {menu && (
        <div className="fixed z-40 w-52 rounded-md border border-line bg-panel py-1 text-xs shadow-2xl" style={{ left: menu.x, top: menu.y + 2 }} onClick={(e) => e.stopPropagation()}>
          {(
            [
              ["Sort ascending", () => setSort([{ column: menu.column.name }])],
              ["Sort descending", () => setSort([{ column: menu.column.name, desc: true }])],
              ["Filter…", () => setFilterFor(menu.column)],
              ["Only empty values", () => addFilter({ column: menu.column.name, op: "is_null" })],
              ["Hide empty values", () => addFilter({ column: menu.column.name, op: "not_null" })],
              ["Chart", () => setChartFor(menu.column.name)],
              ...(onReportIssue ? ([["Report issue…", () => onReportIssue(menu.column.name)]] as const) : []),
            ] as const
          ).map(([label, fn]) => (
            <button key={label} type="button" onClick={() => (fn(), setMenu(null))} className="block w-full px-3 py-1.5 text-left hover:bg-panel-2">
              {label}
            </button>
          ))}
        </div>
      )}
      {cellMenu && (
        <div className="fixed z-40 w-60 rounded-md border border-line bg-panel py-1 text-xs shadow-2xl" style={{ left: cellMenu.x, top: cellMenu.y + 4 }} onClick={(e) => e.stopPropagation()}>
          <div className="truncate border-b border-line px-3 py-1.5 font-mono text-muted">{cellMenu.value === null || cellMenu.value === undefined ? "null" : cellText(cellMenu.value)}</div>
          <button
            type="button"
            onClick={() => (addFilter({ column: cellMenu.column, op: "not_in", value: [cellMenu.value ?? null] }), setCellMenu(null))}
            className="block w-full px-3 py-1.5 text-left hover:bg-panel-2"
          >
            Exclude this value
          </button>
          <button
            type="button"
            onClick={() => (addFilter({ column: cellMenu.column, op: cellMenu.value === null || cellMenu.value === undefined ? "is_null" : "in", value: [cellMenu.value] }), setCellMenu(null))}
            className="block w-full px-3 py-1.5 text-left hover:bg-panel-2"
          >
            Only this value
          </button>
          <button type="button" onClick={() => (navigator.clipboard?.writeText(cellText(cellMenu.value)), setCellMenu(null))} className="block w-full px-3 py-1.5 text-left hover:bg-panel-2">
            Copy value
          </button>
          {cellActions?.(cellMenu).map((a) => (
            <button key={a.label} type="button" onClick={() => (a.onClick(), setCellMenu(null))} className="block w-full border-t border-line px-3 py-1.5 text-left hover:bg-panel-2">
              {a.label}
            </button>
          ))}
        </div>
      )}
      {filterFor && <FilterDialog column={filterFor} onClose={() => setFilterFor(null)} onApply={(f) => (addFilter(f), setFilterFor(null))} />}
      {chartFor && (
        <ChartDialog datasetId={datasetId} transaction={transaction} column={chartFor} filters={filters} search={search} onClose={() => setChartFor(null)} onFilter={(f) => (addFilter(f), setChartFor(null))} />
      )}
    </div>
  );
}

function FilterDialog({ column, onClose, onApply }: { column: Column; onClose: () => void; onApply: (f: Filter) => void }) {
  const numeric = ["BYTE", "SHORT", "INTEGER", "LONG", "FLOAT", "DOUBLE", "DECIMAL", "DATE", "TIMESTAMP"].includes(column.type);
  const [op, setOp] = useState<FilterOp>(numeric ? "gte" : "contains");
  const [value, setValue] = useState("");
  const noValue = op === "is_null" || op === "not_null";
  return (
    <Modal title={`Filter ${column.name}`} icon="filter" onClose={onClose}>
      <form
        className="space-y-3 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          onApply({ column: column.name, op, value: op === "in" || op === "not_in" ? value.split(",").map((s) => s.trim()) : noValue ? undefined : value });
        }}
      >
        <div className="flex gap-2">
          <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)} className={`${fieldClass} w-44`}>
            {(Object.keys(OP_LABEL) as FilterOp[]).map((k) => (
              <option key={k} value={k}>
                {OP_LABEL[k]}
              </option>
            ))}
          </select>
          {!noValue && <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={op.endsWith("in") ? "a, b, c" : "value"} className={inputClass} />}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary}>
            Apply
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChartDialog({
  datasetId,
  transaction,
  column,
  filters,
  search,
  onClose,
  onFilter,
}: {
  datasetId: string;
  transaction?: string | null;
  column: string;
  filters: Filter[];
  search?: string;
  onClose: () => void;
  onFilter: (f: Filter) => void;
}) {
  const [chart, setChart] = useState<Chart | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    datasetPreview.chart(datasetId, { column, transaction, filters, search }).then(setChart, (e: Error) => setError(e.message));
  }, [datasetId, column, transaction, filters, search]);
  const items =
    chart?.kind === "histogram"
      ? chart.bins.map((b) => ({ label: chart.temporal ? String(b.from).slice(0, 10) : Number(b.from).toLocaleString(undefined, { maximumFractionDigits: 2 }), count: b.count, filter: [{ column, op: "gte" as const, value: b.from }, { column, op: "lt" as const, value: b.to }] }))
      : (chart?.values ?? []).map((v) => ({ label: cellText(v.value) || "null", count: v.count, filter: [v.value === null ? { column, op: "is_null" as const } : { column, op: "in" as const, value: [v.value] }] }));
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <Modal title={`${column} · ${chart?.kind === "histogram" ? "distribution" : "most common values"}`} icon="table" onClose={onClose} wide>
      <div className="max-h-[70vh] overflow-y-auto p-4 text-xs">
        {error && <p className="text-bad">{error}</p>}
        {!chart && !error && <p className="text-muted">Loading…</p>}
        <ul className="space-y-1">
          {items.map((it, i) => (
            <li key={i}>
              <button type="button" onClick={() => it.filter.forEach((f) => onFilter(f))} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-panel-2" title="Filter to this">
                <span className="w-32 shrink-0 truncate text-right font-mono text-muted">{it.label}</span>
                <span className="h-4 rounded-sm bg-ocean/70" style={{ width: `${(it.count / max) * 70}%`, minWidth: it.count ? 2 : 0 }} />
                <span className="tabular-nums text-soft">{it.count.toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
        {chart && <p className="mt-3 text-muted">Over every row of the dataset that passes the current filters{search ? " and the row search" : ""}. Select a bar to filter to it.</p>}
      </div>
    </Modal>
  );
}
