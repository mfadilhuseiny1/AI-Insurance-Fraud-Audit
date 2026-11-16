/**
 * Previews of a DuckDB local pipeline (compute "duckdb"): a transform node compiles to one DuckDB statement, as its
 * build does, and the API runs it over every row of the inputs on disk (api/pipeline_duckdb.py) and answers its
 * first rows. The JS engine cannot preview it: its SQL steps are DuckDB SQL, and it only holds a sample of each input.
 * Source nodes show their stored sample until their first page arrives (duckdbPager).
 */
import { useCallback, useRef, useState } from "react";
import { api } from "@/lib/api";
import { SAMPLE_ROWS } from "@/lib/deployed";
import { compileOutput, localInputs, resolvePivotValues, type Checkpoint } from "@/lib/externalSql";
import { COL_TYPES, outputTable, refNode, type Column, type ColType, type NodeResult, type Output, type Pipeline } from "@/lib/pipeline";
import { filteredSql, monthsSql, orderSql, PAGE_ROWS, type PreviewPager, type PreviewQuery } from "./previewQuery";

/** previews run at most this many at a time (each scans its inputs in full) */
const PARALLEL = 2;
const PENDING: NodeResult = { table: { columns: [], rows: [] }, pending: 1 };

const typed = (columns: { name: string; type: string }[]) =>
  columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType }));

/** The previews asked for: one version of the pipeline at a time (a new version drops what is still queued). */
type Queue = { version: string; asked: Set<string>; jobs: (() => Promise<void>)[]; running: number };

function pump(q: Queue): void {
  while (q.running < PARALLEL && q.jobs.length) {
    const job = q.jobs.shift()!;
    q.running += 1;
    job().finally(() => {
      q.running -= 1;
      pump(q);
    });
  }
}

// the checkpoints a node reads are computed once by the API and shared with the builds and the other previews
const runner = (p: Pipeline) => {
  const inputs = localInputs(p);
  return (sql: string, checkpoints: Checkpoint[], page: { limit?: number; offset?: number; count?: boolean; order?: string } = {}) =>
    api.pipelineData.duckdbPreview({ pipeline_id: p.id, sql, inputs, checkpoints, limit: SAMPLE_ROWS, ...page });
};

type Compiled = { sql: string; checkpoints: Checkpoint[]; order?: string };

/** A node of `p` as one DuckDB statement, with the checkpoints it reads and its own sort. */
async function compileNode(p: Pipeline, ref: string, name: string): Promise<Compiled> {
  const run = runner(p);
  const out = { node: ref, name };
  // a pivot's columns are its values in the data: read first, as a build does
  const pivotValues = await resolvePivotValues(p, out, "duckdb", async (sql, cps) => Object.values((await run(sql, cps)).rows[0] ?? {}), { local: true });
  const { sql, checkpoints, order } = compileOutput(p, out, "duckdb", { local: true, pivotValues });
  return { sql, checkpoints, order };
}

async function previewNode(p: Pipeline, ref: string, name: string): Promise<NodeResult> {
  try {
    const c = await compileNode(p, ref, name);
    // in the order of the next pages (duckdbPager): the API's DuckDB keeps no row order of its own
    const t = await runner(p)(c.sql, c.checkpoints, { order: orderSql(null, c.order) ?? undefined });
    // rows is only the preview (SAMPLE_ROWS); totalRows is the node's real count, and what the node card shows
    return { table: { columns: typed(t.columns), rows: t.rows as never, totalRows: t.totalRows } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Next pages, Find and Filter by of a node's preview, over every row of the node: its statement compiled once, then
 * each page is that statement with the query's WHERE around it, ordered (orderSql: the node's first page has the
 * same order) and paged by the API. `output`: an output of the node, whose columns may pick and rename the node's:
 * the query is read in the node's columns, and each page becomes the output's as its first page does (outputTable).
 */
export function duckdbPager(p: Pipeline, ref: string, name: string, output?: Output): PreviewPager {
  const run = runner(p);
  let compiled: Promise<Compiled> | null = null;
  const base = () =>
    (compiled ??= compileNode(p, ref, name).catch((e) => {
      compiled = null;
      throw e;
    }));
  const mapping = output?.columns?.length ? output.columns : null;
  const toNode = (column: string) => mapping?.find((m) => m.name.trim() === column)?.source ?? column;
  const inNode = (q: PreviewQuery, columns: Column[]) => ({
    q: { find: q.find, filters: q.filters.map((f) => ({ ...f, column: toNode(f.column) })), sort: q.sort && { ...q.sort, column: toNode(q.sort.column) } },
    columns: columns.map((c) => ({ ...c, name: toNode(c.name) })),
  });
  // the matching row count of a query, counted with its first page: the next pages do not count again
  const totals = new Map<string, number>();
  return {
    // a source shows its stored sample, in the file's order: its first page in the pages' order is read too
    fetchFirst: p.nodes.find((n) => n.id === refNode(ref))?.kind === "source",
    async page(query, shown, offset) {
      const c = await base();
      const { q, columns } = inNode(query, shown);
      const statement = filteredSql(c.sql, columns, q);
      const known = totals.get(statement);
      const page = (t: { columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }, total: number) => {
        const rows = { columns: typed(t.columns), rows: t.rows as never };
        return { table: { ...(output ? outputTable(output, rows) : rows), totalRows: total }, total };
      };
      // a page in the second half reads from the end, backwards: an offset of millions sorts every row before it
      const backwards = known !== undefined && offset > known / 2 ? orderSql(q.sort, c.order, true) : null;
      if (known !== undefined && backwards) {
        const limit = Math.min(PAGE_ROWS, known - offset);
        if (limit <= 0) return page({ columns, rows: [] }, known);
        const t = await run(statement, c.checkpoints, { limit, offset: known - offset - limit, count: false, order: backwards });
        return page({ ...t, rows: [...t.rows].reverse() }, known);
      }
      const t = await run(statement, c.checkpoints, { limit: PAGE_ROWS, offset, count: known === undefined, order: orderSql(q.sort, c.order) ?? undefined });
      const total = t.totalRows ?? known ?? offset + t.rows.length;
      totals.set(statement, total);
      return page(t, total);
    },
    async months(column, shown, query) {
      const c = await base();
      const { q, columns } = inNode(query, shown);
      const t = await run(monthsSql(c.sql, columns, toNode(column), q), c.checkpoints, { limit: MONTHS_MAX, count: false });
      return t.rows.map((r) => ({ month: String(r.month), rows: Number(r.rows) }));
    },
  };
}

/** at most this many year-months are listed to filter by (the API's preview row cap) */
const MONTHS_MAX = 1000;

/** The pager of a node's (or an output's) preview in a DuckDB local pipeline; one per node and pipeline version. */
export function useDuckdbPager(p: Pipeline, enabled: boolean, version: string): (ref: string, output?: Output) => PreviewPager | undefined {
  const cache = useRef<{ version: string; byKey: Map<string, PreviewPager> }>({ version, byKey: new Map() });
  return useCallback(
    (ref: string, output?: Output) => {
      if (!enabled) return undefined;
      const n = p.nodes.find((x) => x.id === refNode(ref));
      if (!n) return undefined;
      const c = cache.current;
      if (c.version !== version) Object.assign(c, { version, byKey: new Map() });
      const key = `${ref}\u0000${JSON.stringify(output?.columns ?? null)}`;
      let pager = c.byKey.get(key);
      if (!pager) {
        pager = duckdbPager(p, ref, n.name, output);
        c.byKey.set(key, pager);
      }
      return pager;
    },
    [enabled, p, version],
  );
}

/**
 * The preview of a node of `p` from DuckDB, or null where the JS engine's result stands (sources, other engines).
 * `version` changes whenever the logic or the inputs do: results are kept per version and node.
 */
export function useDuckdbPreview(p: Pipeline, enabled: boolean, version: string): (ref: string) => NodeResult | null {
  const [results, setResults] = useState<{ version: string; byRef: Record<string, NodeResult> }>({ version, byRef: {} });
  const queue = useRef<Queue>({ version, asked: new Set(), jobs: [], running: 0 });

  return useCallback(
    (ref: string) => {
      if (!enabled) return null;
      const n = p.nodes.find((x) => x.id === refNode(ref));
      if (!n || n.kind === "source") return null;
      if (results.version === version && results.byRef[ref]) return results.byRef[ref];
      const q = queue.current;
      if (q.version !== version) Object.assign(q, { version, asked: new Set(), jobs: [] });
      if (!q.asked.has(ref)) {
        q.asked.add(ref);
        q.jobs.push(async () => {
          const answer = await previewNode(p, ref, n.name);
          // an answer for an older version is dropped
          if (queue.current.version === version)
            setResults((r) => ({ version, byRef: { ...(r.version === version ? r.byRef : {}), [ref]: answer } }));
        });
        pump(q);
      }
      return PENDING;
    },
    [enabled, p, version, results],
  );
}
