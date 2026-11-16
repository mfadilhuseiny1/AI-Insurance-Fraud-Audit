"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { bytes } from "@/lib/format";
import { columnStats, type Cell, type ColType, type Column, type DataFile, type Row, type Table, isNumericType } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { timeZones } from "./CastFields";
import { Modal } from "./Modal";
import {
  cellText,
  FILTER_OPS,
  filterLabel,
  isDateLike,
  isEmptyQuery,
  monthCounts,
  monthLabel,
  PAGE_ROWS,
  queryRows,
  withoutMonthsOf,
  type FilterOp,
  type MonthCount,
  type PreviewFilter,
  type PreviewPager,
  type PreviewQuery,
  type PreviewSort,
} from "./previewQuery";
import { thumbnailUrl } from "@/lib/inputs";
import { allowExport } from "@/lib/checkpoints";

export const TYPE_MARK: Record<ColType, string> = {
  String: "“”",
  Boolean: "T/F",
  Byte: "i8",
  Short: "i16",
  Integer: "123",
  Long: "i64",
  Float: "f32",
  Double: "1.0",
  Decimal: "1.00",
  Date: "D",
  Timestamp: "TS",
  Binary: "01",
};

// ---- the time zone timestamps are shown in: one choice for every preview, kept for the browser session

const ZONE_KEY = "pipeline.previewTimeZone";
let previewZone: string | null = null;
const zoneListeners = new Set<() => void>();
function currentZone(): string {
  if (previewZone === null) {
    try {
      previewZone = sessionStorage.getItem(ZONE_KEY) || "UTC";
    } catch {
      previewZone = "UTC";
    }
  }
  return previewZone;
}
function setPreviewZone(zone: string) {
  previewZone = zone;
  try {
    sessionStorage.setItem(ZONE_KEY, zone);
  } catch {}
  for (const l of zoneListeners) l();
}
const subscribeZone = (l: () => void) => {
  zoneListeners.add(l);
  return () => zoneListeners.delete(l);
};
export const usePreviewZone = () => useSyncExternalStore(subscribeZone, currentZone, () => "UTC");

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** A timestamp (ISO text) as wall-clock time in `zone` with its UTC offset, e.g. 2026-01-01 17:00:00.000 +07:00. */
export function formatTimestamp(v: string, zone: string): string {
  const d = new Date(v);
  if (zone === "UTC" || Number.isNaN(d.getTime())) return v;
  let f = zoneFormats.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" });
    } catch {
      return v;
    }
    zoneFormats.set(zone, f);
  }
  const part = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  const offset = (part.timeZoneName ?? "").replace("GMT", "") || "+00:00";
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}.${ms} ${offset}`;
}

export function formatCell(v: Cell) {
  if (v === null) return <span className="italic text-muted">null</span>;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 6, useGrouping: false });
  // anything else (never expected) as text rather than crashing the table
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * A table's rows, a page at a time, with Find (cells containing a keyword, highlighted; Enter jumps to the next one)
 * and Filter by (a column's months, or a condition). With `pager` (a DuckDB local pipeline) they run over every row
 * of the node in the API, where `table` holds only its first page; without one, over `table.rows`.
 */
export function DataPreview({ table, title, pager }: { table: Table; title: string; pager?: PreviewPager }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PreviewSort | null>(null);
  const [menu, setMenu] = useState<{ column: string; x: number; y: number } | null>(null);
  const [stats, setStats] = useState<string | null>(null);
  const [findText, setFindText] = useState("");
  const [find, setFind] = useState("");
  const [filters, setFilters] = useState<PreviewFilter[]>([]);
  const [filterMenu, setFilterMenu] = useState<{ anchor: DOMRect; column: string | null; editing?: PreviewFilter } | null>(null);
  const [offset, setOffset] = useState(0);
  // the Find match in focus: per page shown (a page's key), Infinity = its last match
  const [focus, setFocus] = useState<{ page: string; i: number } | null>(null);
  const [remote, setRemote] = useState<{ pager: PreviewPager; key: string; offset: number; table?: Table; total?: number; error?: string } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const zone = usePreviewZone();
  const hasTimestamp = table.columns.some((c) => c.type === "Timestamp");
  const zones = useMemo(() => (hasTimestamp ? timeZones() : []), [hasTimestamp]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  // Find applies a moment after typing stops (Enter applies it at once)
  useEffect(() => {
    if (findText === find) return;
    const t = setTimeout(() => {
      setFind(findText);
      setOffset(0);
    }, 350);
    return () => clearTimeout(t);
  }, [findText, find]);

  const q = useMemo<PreviewQuery>(() => {
    const names = new Set(table.columns.map((c) => c.name));
    return { find, filters: filters.filter((f) => names.has(f.column)), sort: sort && names.has(sort.column) ? sort : null };
  }, [find, filters, sort, table.columns]);
  const key = JSON.stringify([q, offset]);
  const first = offset === 0 && isEmptyQuery(q);
  // the API answers when there is a pager and more than its first page is asked for (or a first page `table` is not)
  const server = !!pager && (!first || !!pager.fetchFirst);

  useEffect(() => {
    if (!server || !pager) return;
    let live = true;
    pager.page(q, table.columns, offset).then(
      (r) => live && setRemote({ pager, key, offset, ...r }),
      (e: Error) => live && setRemote({ pager, key, offset, error: e.message }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for q and offset
  }, [server, pager, key]);

  const local = useMemo(() => (pager ? null : queryRows(table, q)), [pager, table, q]);
  // while the next page loads, the last one stays (dimmed)
  const shown = server && remote?.pager === pager ? remote : null;
  const loading = server && shown?.key !== key;
  const failed = server && shown?.key === key ? shown.error : undefined;
  // a first page that could not be read leaves the rows the table holds in view (a source's stored sample)
  const error = first ? undefined : failed;
  const rows = useMemo(
    () =>
      server
        ? (shown?.table?.rows ?? (first ? table.rows.slice(0, PAGE_ROWS) : []))
        : local
          ? local.slice(offset, offset + PAGE_ROWS)
          : table.rows.slice(0, PAGE_ROWS),
    [server, shown, first, local, offset, table.rows],
  );
  const rowBase = server ? (shown?.offset ?? offset) : offset;
  const all = table.totalRows ?? table.rows.length;
  const total = server ? (shown?.key === key && shown.total !== undefined ? shown.total : first ? all : undefined) : local ? local.length : all;
  // without a pager, a table holding only a sample pages and filters that sample
  const sampleOnly = !pager && table.totalRows !== undefined && table.totalRows > table.rows.length;
  const filtered = !!q.find.trim() || q.filters.length > 0;
  const hasPrev = offset > 0;
  const hasNext = total !== undefined ? offset + PAGE_ROWS < total : rows.length >= PAGE_ROWS;
  const lastOffset = total !== undefined && total > 0 ? Math.floor((total - 1) / PAGE_ROWS) * PAGE_ROWS : 0;
  const pageId = server ? (shown?.key ?? "") : key;

  const columns = useMemo(() => table.columns.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())), [table.columns, search]);
  const kw = q.find.trim().toLowerCase();
  // Find's matches on this page, in reading order: cell → its index
  const matches = useMemo(() => {
    const m = new Map<string, number>();
    if (!kw) return m;
    rows.forEach((r, i) => columns.forEach((c) => cellText(r[c.name]).toLowerCase().includes(kw) && m.set(`${i}\u0000${c.name}`, m.size)));
    return m;
  }, [rows, kw, columns]);
  const at = focus && focus.page === pageId && matches.size ? Math.min(focus.i, matches.size - 1) : -1;

  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [pageId]);
  useEffect(() => {
    if (at >= 0) body.current?.querySelector(`[data-match="${at}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [at, pageId]);

  const go = (o: number) => setOffset(Math.max(0, o));
  const sortBy = (s: PreviewSort | null) => {
    setSort(s);
    setOffset(0);
  };
  /** The next (1) or previous (-1) match of Find, across pages. */
  const step = (dir: 1 | -1) => {
    if (findText !== find) {
      setFind(findText);
      setOffset(0);
      setFocus({ page: JSON.stringify([{ ...q, find: findText }, 0]), i: 0 });
      return;
    }
    if (!kw) return;
    const next = at === -1 ? (dir === 1 ? 0 : matches.size - 1) : at + dir;
    if (next >= 0 && next < matches.size) setFocus({ page: pageId, i: next });
    else if (dir === 1 && hasNext) {
      go(offset + PAGE_ROWS);
      setFocus({ page: JSON.stringify([q, offset + PAGE_ROWS]), i: 0 });
    } else if (dir === -1 && hasPrev) {
      go(offset - PAGE_ROWS);
      setFocus({ page: JSON.stringify([q, Math.max(0, offset - PAGE_ROWS)]), i: Infinity });
    } else if (matches.size) setFocus({ page: pageId, i: dir === 1 ? 0 : matches.size - 1 });
  };
  const clearFind = () => {
    setFindText("");
    setFind("");
    setOffset(0);
  };
  const applyFilter = (f: PreviewFilter, editing?: PreviewFilter) => {
    setFilters((fs) =>
      editing && fs.includes(editing)
        ? fs.map((x) => (x === editing ? f : x))
        : f.op === "months"
          ? [...fs.filter((x) => !(x.op === "months" && x.column === f.column)), f]
          : [...fs, f],
    );
    setOffset(0);
    setFilterMenu(null);
  };
  const removeFilter = (f: PreviewFilter) => {
    setFilters((fs) => fs.filter((x) => x !== f));
    setOffset(0);
  };
  const months = (column: string): Promise<MonthCount[]> => {
    const without = withoutMonthsOf(q, column);
    return pager ? pager.months(column, table.columns, without) : Promise.resolve(monthCounts(queryRows(table, without), column));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <Icon name="table" className="h-3.5 w-3.5 text-ocean" />
          <span className="truncate">{title}</span>
        </span>
        <span className="text-muted">
          {sampleOnly
            ? filtered
              ? `${(total ?? 0).toLocaleString()} of ${table.rows.length.toLocaleString()} sample rows match (of ${all.toLocaleString()})`
              : `Sample: ${table.rows.length.toLocaleString()} of ${all.toLocaleString()} rows`
            : filtered
              ? `${total === undefined ? "…" : total.toLocaleString()} of ${all.toLocaleString()} rows match`
              : `${all.toLocaleString()} rows`}
        </span>
        <span className="text-muted">{table.columns.length} columns</span>
        {sort && (
          <button
            type="button"
            onClick={() => sortBy(null)}
            className="flex items-center gap-1 text-ocean hover:underline"
          >
            sorted by {sort.column} <Icon name="x" className="h-3 w-3" />
          </button>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {hasTimestamp && (
            <label className="flex items-center gap-1 text-muted" title="Time zone timestamps are shown in (every preview)">
              <Icon name="clock" className="h-3.5 w-3.5" />
              <select value={zone} onChange={(e) => setPreviewZone(e.target.value)} className="max-w-40 rounded-md border border-line-2 bg-ink px-1 py-0.5 text-soft outline-none">
                {!zones.includes("UTC") && <option value="UTC">UTC</option>}
                {!zones.includes(zone) && zone !== "UTC" && <option value={zone}>{zone}</option>}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div
            className={`flex items-center gap-1 rounded-md border bg-ink px-2 py-1 ${kw ? "border-warn/50" : "border-line-2"}`}
            title={`Find cells containing a keyword in ${sampleOnly ? "the sample rows" : "every row"} — Enter: next, Shift+Enter: previous, Esc: clear`}
          >
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  step(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") clearFind();
              }}
              placeholder="Find in cells…"
              aria-label="Find in cells"
              className="w-28 bg-transparent outline-none placeholder:text-muted"
            />
            {kw && (
              <>
                <span className="tabular-nums text-muted" title={at >= 0 ? "Match in focus / matches on this page" : "Matches on this page (Enter: go to the first)"}>
                  {at >= 0 ? `${at + 1}/${matches.size}` : matches.size}
                </span>
                <button type="button" onClick={() => step(-1)} title="Previous match (Shift+Enter)" className="text-muted hover:text-white">
                  <Icon name="down" className="h-3.5 w-3.5 rotate-180" />
                </button>
                <button type="button" onClick={() => step(1)} title="Next match (Enter)" className="text-muted hover:text-white">
                  <Icon name="down" className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {findText && (
              <button type="button" onClick={clearFind} title="Clear Find" className="text-muted hover:text-white">
                <Icon name="x" className="h-3 w-3" />
              </button>
            )}
          </div>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => setFilterMenu(filterMenu ? null : { anchor: e.currentTarget.getBoundingClientRect(), column: null })}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-panel-2 ${q.filters.length ? "border-ocean/60 text-ocean" : "border-line-2 text-soft"}`}
          >
            <Icon name="filter" className="h-3.5 w-3.5" /> Filter by
            {q.filters.length > 0 && <span className="rounded-full bg-ocean px-1.5 text-[10px] leading-4 text-white">{q.filters.length}</span>}
          </button>
          <label className="flex items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1">
            <Icon name="table" className="h-3.5 w-3.5 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search columns…"
              className="w-28 bg-transparent outline-none placeholder:text-muted"
            />
          </label>
        </span>
      </div>
      {q.filters.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1 text-xs">
          <Icon name="filter" className="h-3 w-3 text-muted" />
          {q.filters.map((f, i) => (
            <span key={i} className="flex items-center gap-1 rounded-full border border-ocean/40 bg-ocean/10 py-0.5 pl-2 pr-1 text-soft">
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => setFilterMenu({ anchor: e.currentTarget.getBoundingClientRect(), column: f.column, editing: f })}
                className="max-w-80 truncate hover:text-white"
                title="Edit this filter"
              >
                {filterLabel(f)}
              </button>
              <button type="button" onClick={() => removeFilter(f)} title="Remove this filter" className="text-muted hover:text-white">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </span>
          ))}
          {q.filters.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setFilters([]);
                setOffset(0);
              }}
              className="text-ocean hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}
      <div ref={body} className="min-h-0 flex-1 overflow-auto">
        {columns.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">{table.columns.length ? "No matching columns." : "No columns."}</p>
        ) : error ? (
          <p className="p-6 text-center text-sm text-bad">{error}</p>
        ) : loading && !rows.length ? (
          <p className="flex items-center justify-center gap-2 p-6 text-sm text-muted">
            <Icon name="refresh" className="h-4 w-4 animate-spin text-ocean" /> Reading {pager ? "every row of the node" : "the rows"}…
          </p>
        ) : !rows.length ? (
          <p className="p-6 text-center text-sm text-muted">{filtered ? "No rows match the Find and the filters." : "No rows."}</p>
        ) : (
          <table className={`min-w-full border-separate border-spacing-0 text-xs ${loading ? "opacity-50" : ""}`}>
            <thead className="sticky top-0 z-10 bg-panel">
              <tr>
                <th className="sticky left-0 z-10 border-b border-r border-line bg-panel px-2 py-1.5 text-right font-normal text-muted">
                  #
                </th>
                {columns.map((c) => (
                  <th
                    key={c.name}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setMenu({ column: c.name, x: r.left, y: r.bottom });
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="cursor-pointer border-b border-r border-line px-2 py-1.5 text-left font-medium hover:bg-panel-2"
                  >
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {c.name}
                      {sort?.column === c.name && <Icon name={sort.dir === 1 ? "down" : "right"} className="h-3 w-3 text-ocean" />}
                      {q.filters.some((f) => f.column === c.name) && <Icon name="filter" className="h-3 w-3 text-ocean" />}
                    </span>
                    <span className="block font-normal text-muted">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="hover:bg-panel-2/60">
                  <td className="sticky left-0 border-b border-r border-line bg-ink px-2 py-1 text-right tabular-nums text-muted">
                    {(rowBase + i + 1).toLocaleString()}
                  </td>
                  {columns.map((c) => {
                    const m = matches.get(`${i}\u0000${c.name}`);
                    return (
                      <td
                        key={c.name}
                        data-match={m}
                        title={r[c.name] === null || r[c.name] === undefined ? "" : String(r[c.name])}
                        className={`max-w-xs scroll-ml-16 scroll-mt-12 truncate whitespace-nowrap border-b border-r border-line px-2 py-1 ${
                          isNumericType(c.type) ? "text-right tabular-nums" : ""
                        } ${m === undefined ? "" : m === at ? "bg-warn/30 ring-2 ring-inset ring-warn" : "bg-warn/15"}`}
                      >
                        {c.type === "Timestamp" && typeof r[c.name] === "string" ? formatTimestamp(r[c.name] as string, zone) : formatCell(r[c.name] ?? null)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1 text-xs text-muted">
        {loading && <Icon name="refresh" className="h-3 w-3 animate-spin text-ocean" />}
        {first && failed && (
          <span className="max-w-md truncate text-bad" title={failed}>
            Stored sample shown — the first page could not be read: {failed}
          </span>
        )}
        <span className="tabular-nums">
          {rows.length ? `Rows ${(rowBase + 1).toLocaleString()}–${(rowBase + rows.length).toLocaleString()}` : "No rows"}
          {total !== undefined && ` of ${total.toLocaleString()}`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <PageButton label="First" disabled={!hasPrev} onClick={() => go(0)} />
          <PageButton label="Prev" icon="left" disabled={!hasPrev} onClick={() => go(offset - PAGE_ROWS)} />
          <span className="px-1 tabular-nums">
            Page {(Math.floor(offset / PAGE_ROWS) + 1).toLocaleString()}
            {total !== undefined && ` of ${Math.max(1, Math.ceil(total / PAGE_ROWS)).toLocaleString()}`}
          </span>
          <PageButton label="Next" icon="right" after disabled={!hasNext} onClick={() => go(offset + PAGE_ROWS)} />
          <PageButton label="Last" disabled={total === undefined || offset >= lastOffset} onClick={() => go(lastOffset)} />
        </span>
      </div>

      {menu && (
        <div
          className="fixed z-50 w-44 rounded-lg border border-line-2 bg-panel-2 py-1 text-sm shadow-xl"
          style={{ left: menu.x, top: menu.y + 2 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {[
            { icon: "down" as const, label: "Sort ascending", run: () => sortBy({ column: menu.column, dir: 1 }) },
            { icon: "left" as const, label: "Sort descending", run: () => sortBy({ column: menu.column, dir: -1 }) },
            {
              icon: "filter" as const,
              label: "Filter by…",
              run: () => setFilterMenu({ anchor: new DOMRect(menu.x, menu.y - 1, 0, 0), column: menu.column }),
            },
            { icon: "sliders" as const, label: "View stats", run: () => setStats(menu.column) },
            { icon: "copy" as const, label: "Copy column name", run: () => navigator.clipboard?.writeText(menu.column) },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                item.run();
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-soft hover:bg-panel hover:text-white"
            >
              <Icon name={item.icon} className="h-3.5 w-3.5" /> {item.label}
            </button>
          ))}
        </div>
      )}

      {filterMenu && (
        <FilterMenu
          key={`${filterMenu.column}\u0000${filterMenu.anchor.left},${filterMenu.anchor.top}`}
          anchor={filterMenu.anchor}
          columns={table.columns}
          rows={table.rows}
          column={filterMenu.column}
          editing={filterMenu.editing}
          current={q.filters}
          months={months}
          onApply={(f) => applyFilter(f, filterMenu.editing)}
          onClose={() => setFilterMenu(null)}
        />
      )}

      {stats && <StatsDialog table={table} column={stats} onClose={() => setStats(null)} />}
    </div>
  );
}

function PageButton({ label, icon, after, disabled, onClick }: { label: string; icon?: "left" | "right"; after?: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-0.5 rounded-md border border-line-2 px-2 py-0.5 text-soft hover:bg-panel-2 hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {icon && !after && <Icon name={icon} className="h-3 w-3" />}
      {label}
      {icon && after && <Icon name={icon} className="h-3 w-3" />}
    </button>
  );
}

const MENU_W = 336;

/** Filter by: a column's months (dates, timestamps, ISO date text) to keep, or a condition on a column. */
function FilterMenu({
  anchor,
  columns,
  rows,
  column: column0,
  editing,
  current,
  months,
  onApply,
  onClose,
}: {
  anchor: DOMRect;
  columns: Column[];
  rows: Row[];
  column: string | null;
  editing?: PreviewFilter;
  current: PreviewFilter[];
  months: (column: string) => Promise<MonthCount[]>;
  onApply: (f: PreviewFilter) => void;
  onClose: () => void;
}) {
  const dated = useMemo(() => new Set(columns.filter((c) => isDateLike(c, rows)).map((c) => c.name)), [columns, rows]);
  const first = column0 ?? columns.find((c) => dated.has(c.name))?.name ?? columns[0]?.name ?? "";
  const picksOf = (col: string) => new Set(current.find((f) => f.op === "months" && f.column === col)?.values ?? []);
  const [column, setColumn] = useState(first);
  const [mode, setMode] = useState<"months" | "condition">(editing ? (editing.op === "months" ? "months" : "condition") : dated.has(first) ? "months" : "condition");
  const [picked, setPicked] = useState<Set<string>>(() => (editing?.op === "months" ? new Set(editing.values) : picksOf(first)));
  const [op, setOp] = useState<FilterOp>(editing && editing.op !== "months" ? editing.op : "contains");
  const [value, setValue] = useState(editing?.value ?? "");
  const [list, setList] = useState<{ column: string; months?: MonthCount[]; error?: string } | null>(null);

  useEffect(() => {
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  useEffect(() => {
    if (mode !== "months" || !column) return;
    let live = true;
    months(column).then(
      (m) => live && setList({ column, months: m }),
      (e: Error) => live && setList({ column, error: e.message }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the months of this column, once per column
  }, [mode, column]);

  const ready = list?.column === column ? list : null;
  const years = useMemo(() => {
    const by = new Map<string, MonthCount[]>();
    for (const m of ready?.months ?? []) by.set(m.month.slice(0, 4), [...(by.get(m.month.slice(0, 4)) ?? []), m]);
    return [...by];
  }, [ready]);
  const toggle = (ms: string[], on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      for (const m of ms) if (on) n.add(m);
      else n.delete(m);
      return n;
    });
  const needsValue = FILTER_OPS.find((o) => o.op === op)?.needsValue ?? true;
  const canApply = mode === "months" ? picked.size > 0 : !needsValue || value.trim() !== "";
  const apply = () => {
    if (!canApply) return;
    onApply(mode === "months" ? { column, op: "months", values: [...picked].sort() } : needsValue ? { column, op, value } : { column, op });
  };

  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_W - 8));
  const below = window.innerHeight - anchor.bottom;
  const style: CSSProperties =
    below >= 380 || below >= anchor.top
      ? { left, top: anchor.bottom + 4, maxHeight: Math.max(220, below - 12) }
      : { left, bottom: window.innerHeight - anchor.top + 4, maxHeight: Math.max(220, anchor.top - 12) };

  return (
    <div
      className="fixed z-50 flex flex-col rounded-lg border border-line-2 bg-panel-2 text-xs shadow-xl"
      style={{ ...style, width: MENU_W }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="filter" className="h-3.5 w-3.5 text-ocean" />
        <span className="font-medium">{editing ? "Edit filter" : "Filter by"}</span>
        <button type="button" onClick={onClose} className="ml-auto text-muted hover:text-white" title="Close (Esc)">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 py-2">
        <label className="flex items-center gap-2">
          <span className="w-14 text-muted">Column</span>
          <select
            value={column}
            onChange={(e) => {
              const c = e.target.value;
              setColumn(c);
              setMode(dated.has(c) ? "months" : "condition");
              setPicked(picksOf(c));
            }}
            className="min-w-0 flex-1 rounded-md border border-line-2 bg-ink px-1.5 py-1 text-soft outline-none"
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.type}){dated.has(c.name) ? " · months" : ""}
              </option>
            ))}
          </select>
        </label>
        {dated.has(column) && (
          <div className="flex gap-1 self-start rounded-md bg-ink p-0.5">
            {(["months", "condition"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-2 py-0.5 ${mode === m ? "bg-panel-2 text-white" : "text-muted hover:text-soft"}`}
              >
                {m === "months" ? "Months" : "Condition"}
              </button>
            ))}
          </div>
        )}
      </div>
      {mode === "months" ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line">
          <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-muted">
            <span>{ready?.months ? `${ready.months.length} months · ${picked.size} picked` : "Months in the data"}</span>
            <button type="button" onClick={() => toggle((ready?.months ?? []).map((m) => m.month), true)} className="ml-auto text-ocean hover:underline">
              All
            </button>
            <button type="button" onClick={() => setPicked(new Set())} className="text-ocean hover:underline">
              None
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            {!ready ? (
              <p className="flex items-center gap-2 py-3 text-muted">
                <Icon name="refresh" className="h-3.5 w-3.5 animate-spin text-ocean" /> Counting the rows per month…
              </p>
            ) : ready.error ? (
              <p className="py-3 text-bad">{ready.error}</p>
            ) : !years.length ? (
              <p className="py-3 text-muted">No dates in this column{current.length ? " among the rows the other filters keep" : ""}.</p>
            ) : (
              years.map(([year, ms]) => {
                const all = ms.every((m) => picked.has(m.month));
                const some = ms.some((m) => picked.has(m.month));
                return (
                  <div key={year} className="py-1">
                    <label className="flex items-center gap-1.5 font-medium text-soft">
                      <input
                        type="checkbox"
                        checked={all}
                        ref={(el) => {
                          if (el) el.indeterminate = some && !all;
                        }}
                        onChange={(e) => toggle(ms.map((m) => m.month), e.target.checked)}
                        className="accent-ocean"
                      />
                      {year}
                      <span className="ml-auto font-normal tabular-nums text-muted">{ms.reduce((a, m) => a + m.rows, 0).toLocaleString()} rows</span>
                    </label>
                    <div className="mt-1 grid grid-cols-3 gap-x-2 gap-y-0.5 pl-5">
                      {ms.map((m) => (
                        <label key={m.month} className="flex min-w-0 items-center gap-1 text-soft" title={`${monthLabel(m.month)}: ${m.rows.toLocaleString()} rows`}>
                          <input type="checkbox" checked={picked.has(m.month)} onChange={(e) => toggle([m.month], e.target.checked)} className="accent-ocean" />
                          <span>{monthLabel(m.month).slice(0, 3)}</span>
                          <span className="ml-auto truncate tabular-nums text-muted">{compact(m.rows)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
          <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)} className="rounded-md border border-line-2 bg-ink px-1.5 py-1 text-soft outline-none">
            {FILTER_OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          {needsValue && (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder={dated.has(column) ? "2024-03-15" : "value"}
              className="min-w-0 flex-1 rounded-md border border-line-2 bg-ink px-2 py-1 outline-none placeholder:text-muted"
            />
          )}
        </div>
      )}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2">
        <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1 text-soft hover:bg-panel hover:text-white">
          Cancel
        </button>
        <button type="button" disabled={!canApply} onClick={apply} className="rounded-md bg-ocean px-2.5 py-1 text-white disabled:opacity-40">
          Apply
        </button>
      </div>
    </div>
  );
}

const compact = (n: number) => (n < 10_000 ? n.toLocaleString() : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n));

function StatsDialog({ table, column, onClose }: { table: Table; column: string; onClose: () => void }) {
  const s = useMemo(() => columnStats(table, column), [table, column]);
  const type = table.columns.find((c) => c.name === column)?.type;
  const max = Math.max(1, ...s.top.map(([, n]) => n));
  const metrics: [string, string | ReturnType<typeof formatCell>][] = [
    ["Rows", s.rows.toLocaleString()],
    ["Nulls", `${s.nulls.toLocaleString()} (${s.rows ? Math.round((s.nulls / s.rows) * 100) : 0}%)`],
    ["Distinct", s.distinct.toLocaleString()],
    ["Min", formatCell(s.min)],
    ["Max", formatCell(s.max)],
    ...(s.mean !== null ? ([["Mean", formatCell(s.mean)]] as [string, ReturnType<typeof formatCell>][]) : []),
  ];

  return (
    <Modal title={`${column} · ${type}`} icon="sliders" onClose={onClose}>
      <div className="space-y-4 p-4 text-sm">
        <dl className="grid grid-cols-3 gap-3">
          {metrics.map(([k, v]) => (
            <div key={k} className="rounded-lg bg-ink p-2.5">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="truncate font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <div>
          <div className="mb-2 text-xs font-medium text-soft">Most common values</div>
          {s.top.length === 0 ? (
            <p className="text-xs text-muted">No values.</p>
          ) : (
            <ul className="space-y-1.5">
              {s.top.map(([v, n], i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-40 truncate" title={String(v)}>
                    {formatCell(v)}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-line">
                    <span className="block h-full rounded-full bg-ocean" style={{ width: `${(n / max) * 100}%` }} />
                  </span>
                  <span className="w-12 text-right tabular-nums text-muted">{n.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

const VIEW_LINES = 5000;

/** File listing of an unstructured dataset, with a viewer and download per file. */
export function FilesPreview({ files, title }: { files: DataFile[]; title: string }) {
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState<DataFile | null>(null);
  const shown = files.filter((f) => f.path.toLowerCase().includes(search.toLowerCase()));

  const download = async (f: DataFile) => {
    if (!(await allowExport({ detail: `Pipeline preview ${f.path}` }))) return;
    const url = URL.createObjectURL(new Blob([f.text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = f.path;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <Icon name="doc" className="h-3.5 w-3.5 text-ocean" />
          <span className="truncate">{title}</span>
        </span>
        <span className="text-muted">
          {files.length} file{files.length === 1 ? "" : "s"} · no schema
        </span>
        <label className="ml-auto flex items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1">
          <Icon name="search" className="h-3.5 w-3.5 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="w-36 bg-transparent outline-none placeholder:text-muted"
          />
        </label>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto text-sm">
        {shown.map((f, i) => (
          <li key={i} className="flex items-center gap-2 px-3 py-2 hover:bg-panel-2/60">
            <Icon name="doc" className="h-4 w-4 text-muted" />
            <button type="button" onClick={() => setViewing(f)} className="min-w-0 truncate text-left hover:text-ocean">
              {f.path}
            </button>
            <span className="text-xs text-muted">({bytes(f.size)})</span>
            <button type="button" onClick={() => setViewing(f)} className="ml-auto text-xs text-ocean hover:underline">
              Preview
            </button>
            <button type="button" onClick={() => void download(f)} className="text-xs text-ocean hover:underline">
              Download
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="p-6 text-center text-xs text-muted">No matching files.</li>}
      </ul>
      {viewing && (
        <Modal title={viewing.path} icon="doc" wide onClose={() => setViewing(null)}>
          <FileText file={viewing} />
        </Modal>
      )}
    </div>
  );
}

function FileText({ file }: { file: DataFile }) {
  const lines = useMemo(() => file.text.split(/\r?\n/), [file]);
  return (
    <div className="max-h-[70vh] overflow-auto bg-ink p-2 font-mono text-xs leading-5">
      <table className="border-separate border-spacing-0">
        <tbody>
          {lines.slice(0, VIEW_LINES).map((line, i) => (
            <tr key={i}>
              <td className="select-none pr-3 text-right align-top text-muted">{i + 1}</td>
              <td className="whitespace-pre-wrap break-all text-soft">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lines.length > VIEW_LINES && (
        <p className="p-2 text-muted">
          Showing the first {VIEW_LINES.toLocaleString()} of {lines.length.toLocaleString()} lines — download the file to see all of it.
        </p>
      )}
    </div>
  );
}

/** A media set's items as thumbnails (PDF first pages and images); click one to see it larger. */
export function MediaPreview({ table, title, column = "mediaReference" }: { table: Table; title: string; column?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = table.rows.slice(0, 120).filter((r) => r[column]);
  const name = (r: Table["rows"][number]) => String(r.path ?? r.name ?? r[column]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <Icon name="image" className="h-3.5 w-3.5 text-ocean" /> {title}
        </span>
        <span className="text-muted">
          {table.rows.length > 120 ? `Showing 120 of ${table.rows.length.toLocaleString()} items` : `${table.rows.length.toLocaleString()} items`}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] content-start gap-2 overflow-y-auto p-3">
        {items.map((r, i) => (
          <button key={i} type="button" onClick={() => setOpen(String(r[column]))} className="overflow-hidden rounded-md border border-line bg-panel text-left hover:border-ocean/60">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbnailUrl(String(r[column]), 240)} alt={name(r)} loading="lazy" className="h-28 w-full bg-ink object-contain" />
            <span className="block truncate px-1.5 py-1 text-[11px] text-soft" title={name(r)}>
              {name(r)}
            </span>
          </button>
        ))}
      </div>
      {open && (
        <Modal title={open} icon="image" onClose={() => setOpen(null)} wide>
          <div className="flex justify-center bg-ink p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbnailUrl(open, 1400)} alt="" className="max-h-[75vh] object-contain" />
          </div>
        </Modal>
      )}
    </div>
  );
}
