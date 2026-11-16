"use client";

import { useRef, useState } from "react";
import { AGG_ARG, AGG_FNS, AGG_SQL, aggOutput, newGroup, PAIR_AGGS, uid, type AggFn, type AggSpec, type Column, type SortKey } from "@/lib/pipeline";
import { SPARK_SQL_FUNCTIONS } from "@/lib/sparkSql";
import { Icon } from "../Icon";
import { TYPE_MARK } from "./DataPreview";
import { AddButton, GroupBody, MatchSelect } from "./FilterForm";

const cell = "rounded-md border border-line-2 bg-ink px-2 py-1 text-xs outline-none focus:border-ocean";

function ColumnSelect({
  value,
  columns,
  onChange,
  empty,
}: {
  value: string;
  columns: Column[];
  onChange: (v: string) => void;
  empty: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${cell} min-w-0`}>
      <option value="">{empty}</option>
      {value && !columns.some((c) => c.name === value) && <option value={value}>{value} (missing)</option>}
      {columns.map((c) => (
        <option key={c.name} value={c.name}>
          {TYPE_MARK[c.type]} {c.name}
        </option>
      ))}
    </select>
  );
}

function RowButtons({ onUp, onDown, onRemove }: { onUp?: () => void; onDown?: () => void; onRemove: () => void }) {
  return (
    <div className="flex shrink-0">
      <button type="button" title="Move up" disabled={!onUp} onClick={onUp} className="rounded p-1 text-muted hover:text-white disabled:opacity-25">
        <Icon name="left" className="h-3.5 w-3.5 rotate-90" />
      </button>
      <button type="button" title="Move down" disabled={!onDown} onClick={onDown} className="rounded p-1 text-muted hover:text-white disabled:opacity-25">
        <Icon name="right" className="h-3.5 w-3.5 rotate-90" />
      </button>
      <button type="button" title="Remove" onClick={onRemove} className="rounded p-1 text-muted hover:bg-bad/10 hover:text-bad">
        <Icon name="x" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function move<T>(list: T[], i: number, d: -1 | 1): T[] {
  const next = [...list];
  [next[i], next[i + d]] = [next[i + d], next[i]];
  return next;
}

/** Aggregations of a GROUP BY: function, column, optional argument and output name per row. */
export function AggregationsField({
  value,
  columns,
  onChange,
}: {
  value: AggSpec[];
  columns: Column[];
  onChange: (v: AggSpec[]) => void;
}) {
  const set = (id: string, patch: Partial<AggSpec>) => onChange(value.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  return (
    <div className="space-y-1.5">
      {value.map((a, i) => (
        <div key={a.id}>
        <div className="flex flex-wrap items-center gap-1.5">
          <select value={a.fn} onChange={(e) => set(a.id, { fn: e.target.value as AggFn, arg: "" })} className={cell}>
            {AGG_FNS.map((f) => (
              <option key={f} value={f}>
                {f} — {AGG_SQL[f]}
              </option>
            ))}
          </select>
          <ColumnSelect
            value={a.column}
            columns={columns}
            onChange={(column) => set(a.id, { column })}
            empty={a.fn === "Count" ? "* (all rows)" : "Choose a column…"}
          />
          {PAIR_AGGS.has(a.fn) ? (
            <ColumnSelect value={a.arg ?? ""} columns={columns} onChange={(arg) => set(a.id, { arg })} empty="Second column…" />
          ) : AGG_ARG[a.fn] && (
            <input
              value={a.arg ?? ""}
              onChange={(e) => set(a.id, { arg: e.target.value })}
              placeholder={AGG_ARG[a.fn]}
              className={`${cell} w-36`}
            />
          )}
          <Icon name="right" className="h-3.5 w-3.5 text-muted" />
          <input
            value={a.output ?? ""}
            onChange={(e) => set(a.id, { output: e.target.value })}
            placeholder={aggOutput({ ...a, output: "" })}
            className={`${cell} w-36 flex-1`}
          />
          <button
            type="button"
            title="Only aggregate rows that match a condition — FILTER (WHERE …)"
            onClick={() => set(a.id, { where: a.where ? undefined : newGroup() })}
            className={`rounded px-1.5 py-0.5 text-[11px] ring-1 ${a.where ? "bg-ocean/15 text-ocean ring-ocean/40" : "text-muted ring-line-2 hover:text-white"}`}
          >
            Filter
          </button>
          <RowButtons
            onUp={i > 0 ? () => onChange(move(value, i, -1)) : undefined}
            onDown={i < value.length - 1 ? () => onChange(move(value, i, 1)) : undefined}
            onRemove={() => onChange(value.filter((x) => x.id !== a.id))}
          />
        </div>
        {a.where && (
          <div className="mb-1 ml-4 mt-1.5 rounded-md border border-line-2 bg-ink/40 p-2 text-xs">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="rounded bg-ocean/15 px-1.5 py-0.5 font-mono font-medium text-ocean">FILTER (WHERE</span>
              <span className="text-muted">rows match</span>
              <MatchSelect group={a.where} onChange={(where) => set(a.id, { where })} />
              <span className="font-mono text-ocean">)</span>
            </div>
            <GroupBody group={a.where} depth={1} columns={columns} onChange={(where) => set(a.id, { where })} />
          </div>
        )}
        </div>
      ))}
      <AddButton label="Add aggregation" onClick={() => onChange([...value, { id: uid(), fn: "Sum", column: "" }])} />
    </div>
  );
}

/** ORDER BY keys: column, direction and null placement per row; earlier keys win. */
export function SortKeysField({
  value,
  columns,
  onChange,
}: {
  value: SortKey[];
  columns: Column[];
  onChange: (v: SortKey[]) => void;
}) {
  const set = (i: number, patch: Partial<SortKey>) => onChange(value.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  return (
    <div className="space-y-1.5">
      {value.map((k, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <span className="w-10 text-right text-[11px] text-muted">{i === 0 ? "by" : "then"}</span>
          <ColumnSelect value={k.column} columns={columns} onChange={(column) => set(i, { column })} empty="Choose a column…" />
          <div className="flex overflow-hidden rounded-md border border-line-2 text-xs">
            {(["asc", "desc"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => set(i, { direction: d })}
                className={`px-2 py-1 ${k.direction === d ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
              >
                {d === "asc" ? "Ascending" : "Descending"}
              </button>
            ))}
          </div>
          <select value={k.nulls ?? "last"} onChange={(e) => set(i, { nulls: e.target.value as "first" | "last" })} className={cell}>
            <option value="last">nulls last</option>
            <option value="first">nulls first</option>
          </select>
          <RowButtons
            onUp={i > 0 ? () => onChange(move(value, i, -1)) : undefined}
            onDown={i < value.length - 1 ? () => onChange(move(value, i, 1)) : undefined}
            onRemove={() => onChange(value.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <AddButton label={value.length ? "Then by" : "Add sort column"} onClick={() => onChange([...value, { column: "", direction: "asc" }])} />
    </div>
  );
}

const SQL_EXAMPLES: [string, string][] = [
  ["Filter & sort", "SELECT *\nFROM input\nWHERE units > 10\nORDER BY units DESC"],
  ["Group by", "SELECT region, COUNT(*) AS orders, SUM(units) AS units\nFROM input\nGROUP BY region"],
  ["Window", "SELECT *, ROW_NUMBER() OVER (PARTITION BY region ORDER BY units DESC) AS rn\nFROM input"],
  [
    "CTE + join",
    "WITH totals AS (\n  SELECT customer_id, SUM(units) AS units FROM input GROUP BY customer_id\n)\nSELECT t.*, c.name\nFROM totals t\nLEFT JOIN customers c USING (customer_id)",
  ],
  [
    "Palantir style",
    "CREATE TABLE `/path/to/target` AS\nSELECT LOWER(name) AS name_lower,\n  CAST(units AS DECIMAL(10, 2)) AS units,\n  DATE_FORMAT(order_date, 'yyyy-MM') AS month\nFROM input",
  ],
];

/** SQL editor: the query plus chips that insert table and column names at the cursor. */
export function SqlQueryField({
  value,
  columns,
  tables,
  onChange,
}: {
  value: string;
  columns: Column[];
  /** "input" first, then the other nodes' table names */
  tables: string[];
  onChange: (v: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const el = box.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };
  const ident = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

  return (
    <div className="space-y-1.5 text-[11px]">
      <textarea
        ref={box}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the box
          if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            insert("  ");
          }
        }}
        rows={Math.min(18, Math.max(6, value.split("\n").length + 1))}
        spellCheck={false}
        placeholder="SELECT * FROM input"
        className="w-full rounded-md border border-line-2 bg-ink px-2.5 py-2 font-mono text-xs leading-5 outline-none focus:border-ocean"
      />
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-muted">Tables</span>
        {tables.map((t, i) => (
          <button
            key={t}
            type="button"
            title={i === 0 ? "This step's input" : "Another node of the pipeline"}
            onClick={() => insert(t)}
            className={`rounded px-1.5 py-0.5 font-mono ring-1 hover:ring-ocean ${i === 0 ? "bg-ocean/15 text-ocean ring-ocean/40" : "bg-panel-2 ring-line-2"}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-muted">input columns</span>
        {columns.map((c) => (
          <button
            key={c.name}
            type="button"
            title={c.type}
            onClick={() => insert(ident(c.name))}
            className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 ring-1 ring-line-2 hover:ring-ocean"
          >
            <span className="font-mono text-[9px] text-muted">{TYPE_MARK[c.type]}</span>
            {c.name}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-muted">Examples</span>
        {SQL_EXAMPLES.map(([label, sql]) => (
          <button
            key={label}
            type="button"
            title={sql}
            onClick={() => onChange(sql)}
            className="rounded px-1.5 py-0.5 text-ocean ring-1 ring-line-2 hover:ring-ocean"
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-muted">Spark SQL functions on SQLite · booleans are 1 / 0 · dates are text</span>
      </div>
      <SparkFunctionList onInsert={(name) => insert(`${name}(`)} />
    </div>
  );
}

/** Searchable list of the Spark functions the SQL step understands; clicking one inserts it. */
function SparkFunctionList({ onInsert }: { onInsert: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = SPARK_SQL_FUNCTIONS.filter((f) => f.includes(query.toLowerCase()));
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-ocean hover:underline">
        <Icon name={open ? "down" : "right"} className="h-3 w-3" /> Spark functions ({SPARK_SQL_FUNCTIONS.length}) — plus SQLite&apos;s own (substring,
        replace, round, abs, coalesce, nullif, count, sum, avg, min, max, row_number, rank, lag, lead…)
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded-md border border-line-2 bg-ink p-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search functions…"
            className="w-full rounded border border-line-2 bg-panel-2 px-1.5 py-0.5 outline-none focus:border-ocean"
          />
          <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
            {shown.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onInsert(f)}
                className="rounded bg-panel-2 px-1.5 py-0.5 font-mono ring-1 ring-line-2 hover:ring-ocean"
              >
                {f}
              </button>
            ))}
            {!shown.length && <span className="text-muted">No matching functions.</span>}
          </div>
          <p className="text-muted">
            CAST(x AS type) follows Spark for boolean, tinyint, smallint, int, bigint, float, double, decimal(p, s), date, timestamp, binary and
            string. EXPLODE: <code>FROM input, json_each(input.tags) e</code> (e.value, e.key). Aggregates such as collect_list cannot take OVER (…).
          </p>
        </div>
      )}
    </div>
  );
}
