/**
 * The build runner (server side): runs a queued build with the same engine as the browser.
 *
 * 1. reads the build record and the pipeline file (the branch it builds) from the API;
 * 2. validates the deployment (dataset outputs, compute profile imports, LLM caches and job groups, …);
 * 3. reads every input fresh from where it lives (Files, data sources, virtual tables, media folders,
 *    streams); incremental inputs only pass the rows added since the last successful build;
 * 4. builds each job (a job group, or one ungrouped output): evaluates the outputs, waiting for async
 *    values (LLM answers, extracted text, parsed files, embeddings) — checkpoint nodes are computed once
 *    per build and shared between jobs; checks the expectations; writes the outputs by kind;
 * 5. reports progress to the build record as it goes, and records deploy state and watermarks.
 *
 * A build runs as someone (the user who clicked Build, a schedule's owner, or a Project-scoped schedule's Projects
 * with its owner's markings): before every input read and output write (every batch of a streaming job) the runner
 * asks the API whether that identity may do it now (POST /builds/{id}/access), and every call it makes for the build
 * carries X-Bsai-Build so the API's pipeline endpoints check it too. A refusal stops the build with the reason.
 *
 * Output write modes: Default appends when every incremental input feeding the output only had rows added
 * (else snapshots); the keyed modes merge with the previous output in the API. A replay reads incremental
 * inputs from the start and resets the outputs; a change to the stateful transforms of an incremental
 * output changed, or an incremental input's schema changed, since the last successful build — the outputs
 * are reset instead of the build failing as a breaking change.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  checkExpectations,
  COL_TYPES,
  deployModeFields,
  evaluator,
  incrementalInputs,
  isStatefulOutput,
  keyedProcessUdfs,
  outputTable,
  refNode,
  statefulFingerprint,
  streamKeys,
  writeModeProblems,
  type Cell,
  type ColType,
  type Dataset,
  type DeployModeFields,
  type ExpectationResult,
  type KeyedStates,
  type NodeResult,
  type ResultStores,
  type Output,
  type Pipeline,
  type ServiceAnswer,
  type ServiceRequest,
  type StreamKeys,
  type Services,
  type SqlRuntime,
  type Table,
} from "../pipeline";
import { branchContent, branchOutputName, fallbackChain, selectOutputs, validate } from "../deploy";
import { checkpointTable, compileExpectations, compileOutput, dialectOf, localInputs, resolvePivotValues, type Checkpoint } from "../externalSql";

/** What the DuckDB local engine did for a checkpoint a statement read (api/pipeline_duckdb.py). */
type CheckpointDone = { table: string; rows: number; columns: number; reused: boolean; seconds: number };
import { makeSqlEngine, type SqlJs } from "../sql";
import { managedProfile } from "../compute";

const API = process.env.BLUESANDAI_API_URL ?? "http://127.0.0.1:8000";
/** the API's service token, handed over with each build (sign-in: the runner acts as the system) */
let serviceToken = process.env.BLUESANDAI_SERVICE_TOKEN ?? "";
export const setServiceToken = (token: string | undefined) => {
  if (token) serviceToken = token;
};

type Log = { at: string; level: "info" | "warn" | "error"; msg: string };
type OutputRun = {
  id: string;
  name: string;
  kind: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  rows?: number;
  columns?: number;
  expectations?: ExpectationResult[];
  error?: string;
  path?: string;
  itemId?: string;
  /** an ingest stream written by a streaming job */
  streamId?: string;
  seconds?: number;
};
type Job = { id: string; name: string; profile: string; status: "pending" | "running" | "succeeded" | "failed" | "cancelled"; outputs: OutputRun[]; started_at?: string; finished_at?: string; logs: Log[] };
export type Build = {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  branch: string;
  outputs: string[];
  target: string;
  trigger: string;
  /** replay from the start of the input data */
  replay?: boolean;
  /** parameter values (by name) over the pipeline's defaults */
  parameters?: Record<string, unknown>;
  /** a schedule's parallel run setup: outputs are written as "name [setup]" with their own state */
  run_setup?: { id: string; name: string } | null;
  /** build this saved version of the logic instead of the branch's latest */
  version_id?: string | null;
  /** who the build runs as (a Project-scoped schedule: whose markings), and the schedule's build scope */
  run_as_name?: string | null;
  scope?: string | null;
  status: string;
  cancel?: boolean;
  jobs: Job[];
};

const now = () => new Date().toISOString();

/** the build the current call chain runs for (several builds may run at once in this process) */
const currentBuild = new AsyncLocalStorage<string>();

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  const buildId = currentBuild.getStore();
  const send = () =>
    fetch(API + p, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
        // the API checks what the runner reads and writes for a build as the build's identity
        ...(buildId ? { "x-bsai-build": buildId } : {}),
        ...(init?.headers ?? {}),
      },
    });
  let res: Response;
  try {
    res = await send();
  } catch (e) {
    // a kept-alive connection the API closed just as it was reused (the API drops connections idle for 5 s, about the
    // time between two quick jobs): the request never reached it, so it is sent once more on a new connection
    const code = (e as Error & { cause?: { code?: string } }).cause?.code ?? "";
    if (!/^(UND_ERR_SOCKET|ECONNRESET|EPIPE)$/.test(code)) throw code ? new Error(`${(e as Error).message} (${code})`) : e;
    res = await send();
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).detail ?? text;
    } catch {}
    const err = new Error(`${typeof msg === "string" ? msg : JSON.stringify(msg)}`.slice(0, 600));
    // a call refused as the build's identity (a marking or role it lost) stops the build
    throw res.status === 403 && buildId ? new AccessDenied(err.message) : Object.assign(err, { status: res.status });
  }
  return (text ? JSON.parse(text) : null) as T;
}
const post = <T>(p: string, body: unknown) => api<T>(p, { method: "POST", body: JSON.stringify(body) });

// ---------------------------------------------------------------- the identity the build runs as

/** The build's identity may not read or write this (any longer): the build stops with the reason. */
class AccessDenied extends Error {}

/** A call of the DuckDB local engine (api/pipeline_duckdb.py): started in the API, polled until it finishes. */
async function duckdbCall<T>(p: string, body: unknown): Promise<T> {
  const { run_id } = await post<{ run_id: string }>(p, body);
  for (let wait = 250; ; wait = Math.min(wait * 2, 2000)) {
    await new Promise((r) => setTimeout(r, wait));
    const r = await api<{ status: string; result?: T; error?: string; code?: number }>(`/api/pipeline/duckdb/runs/${run_id}`);
    if (r.status === "succeeded") return r.result as T;
    if (r.status === "failed") throw r.code === 403 && currentBuild.getStore() ? new AccessDenied(r.error ?? "") : new Error(r.error ?? "the DuckDB run failed");
  }
}

type AccessCheck = { op: "read" | "write"; kind: "item" | "folder" | "pipeline" | "datasource" | "stream" | "ingest" | "connection"; id: string | null; label?: string };

/** Asks the API whether the build's identity may do these reads and writes now; throws AccessDenied with the reason. */
async function checkAccess(checks: AccessCheck[]): Promise<void> {
  const buildId = currentBuild.getStore();
  if (!buildId || !checks.length) return;
  try {
    await post(`/api/pipeline/builds/${buildId}/access`, { checks });
  } catch (e) {
    // an API from before builds carried their identity has no such route: it checks nothing more than before
    if ((e as { status?: number }).status === 404 && (e as Error).message === "Not Found") return;
    throw e;
  }
}

/** The reads an input makes: its Files item, data source, connection, media folder or stream. */
function inputChecks(d: Dataset): AccessCheck[] {
  const ref = d.ref;
  if (!ref) return [];
  const read = (kind: AccessCheck["kind"], id: string | null | undefined): AccessCheck[] => (id ? [{ op: "read", kind, id, label: d.name }] : []);
  switch (ref.kind) {
    case "drive":
      return read("item", ref.itemId);
    case "datasource":
      return read("datasource", ref.id);
    case "virtual":
      return read("connection", ref.connectionId);
    case "media":
      return read("item", ref.folderId);
    case "stream":
      return read("stream", ref.streamId);
    case "ingest":
      return read("ingest", ref.streamId);
  }
  return [];
}

// ---------------------------------------------------------------- services in the server

const ENDPOINT: Record<ServiceRequest["kind"], string> = {
  llm: "/api/pipeline/ai/llm",
  media: "/api/pipeline/media/extract",
  model: "/api/pipeline/ai/models",
  parse: "/api/pipeline/parse",
  embed: "/api/pipeline/ai/embed",
  udf: "/api/code-repos/tools/udfs/run",
  // Python functions (functions registry): one runner call per step's rows
  pyfn: "/api/functions/tools/pipeline-udf/run",
  // Cipher encrypt / decrypt / hash steps: a column chunk per call (Data Manager or Admin licenses)
  cipher: "/api/cipher/pipeline",
};
const BATCH: Record<ServiceRequest["kind"], number> = { llm: 100, media: 10, model: 100, parse: 4, embed: 128, udf: 1, pyfn: 1, cipher: 4 };

class NodeServices implements Services {
  answers = new Map<string, ServiceAnswer>();
  queue = new Map<string, ServiceRequest>();
  calls = 0;
  get = (key: string) => this.answers.get(key);
  request = (r: ServiceRequest) => {
    if (!this.answers.has(r.key)) this.queue.set(r.key, r);
  };
  async flush(onProgress?: (n: number) => void) {
    const reqs = [...this.queue.values()];
    this.queue.clear();
    const byKind = new Map<ServiceRequest["kind"], ServiceRequest[]>();
    for (const r of reqs) (byKind.get(r.kind) ?? byKind.set(r.kind, []).get(r.kind)!).push(r);
    for (const [kind, list] of byKind)
      for (let i = 0; i < list.length; i += BATCH[kind]) {
        const part = list.slice(i, i + BATCH[kind]);
        try {
          const body = await post<{ results: Record<string, ServiceAnswer> }>(ENDPOINT[kind], { calls: part.map((r) => ({ key: r.key, ...r.payload })) });
          for (const r of part) this.answers.set(r.key, body.results[r.key] ?? { error: "No answer" });
        } catch (e) {
          for (const r of part) this.answers.set(r.key, { error: (e as Error).message });
        }
        this.calls += part.length;
        onProgress?.(this.calls);
      }
    return reqs.length;
  }
}

let sqlRuntime: Promise<SqlRuntime> | null = null;
function loadSql(): Promise<SqlRuntime> {
  sqlRuntime ??= (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const initSqlJs = require("sql.js") as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJs>;
      const dist = path.join(process.cwd(), "node_modules", "sql.js", "dist");
      const SQL = await initSqlJs({ locateFile: (f) => path.join(dist, f) });
      return { engine: makeSqlEngine(SQL), error: null };
    } catch (e) {
      return { engine: null, error: `SQL engine unavailable on the server: ${(e as Error).message}` };
    }
  })();
  return sqlRuntime;
}

// ---------------------------------------------------------------- inputs

const ICEBERG_TYPE = "application/vnd.apache.iceberg+json";
const typed = (columns: { name: string; type: string }[]) => columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType }));

async function readInput(d: Dataset, chain: string[] = ["main"]): Promise<Table> {
  const ref = d.ref;
  if (!ref) return { columns: d.columns, rows: d.rows, files: d.files };
  // read as the build's identity: its markings and Project roles as they are now
  await checkAccess(inputChecks(d));
  switch (ref.kind) {
    case "drive": {
      let item = await api<{ id: string; name: string; parent_id: string | null; content_type?: string | null }>(`/api/drive/items/${ref.itemId}`);
      // an Iceberg table: its rows in append order (incremental inputs read what was appended past their watermark)
      if (item.content_type === ICEBERG_TYPE) {
        const t = await api<{ columns: { name: string; type: string }[]; rows: Table["rows"] }>(`/api/pipeline/datasets/${ref.itemId}/table`);
        return { columns: typed(t.columns), rows: t.rows };
      }
      // on a branch: the dataset built on the branch (or the first fallback that has it), else main's
      if (chain[0] !== "main" && /\.parquet$/i.test(item.name)) {
        const siblings = await api<{ items: { id: string; name: string; kind: string }[] }>(`/api/drive/folders/${item.parent_id ?? "root"}`);
        const stem = item.name.replace(/\.parquet$/i, "");
        for (const b of chain) {
          if (b === "main") break;
          const hit = siblings.items.find((x) => x.kind === "file" && x.name === `${stem} [${b}].parquet`);
          if (hit) {
            // the branch's dataset is another Files item: read as the build's identity too
            await checkAccess([{ op: "read", kind: "item", id: hit.id, label: d.name }]);
            item = { ...item, id: hit.id, name: hit.name };
            break;
          }
        }
      }
      ref.itemId = item.id;
      // a View: the union (and deduplication) of its backing datasets, resolved by the API
      if (/\.view$/i.test(item.name)) {
        const t = await api<{ columns: { name: string; type: string }[]; rows: Table["rows"] }>(`/api/views/${ref.itemId}/table`);
        return { columns: typed(t.columns), rows: t.rows };
      }
      if (/\.parquet$/i.test(item.name)) {
        const t = await api<{ columns: { name: string; type: string }[]; rows: Table["rows"] }>(`/api/pipeline/datasets/${ref.itemId}/table`);
        return { columns: typed(t.columns), rows: t.rows };
      }
      // CSV / JSON / Excel kept as the copy taken when added (re-read in the browser with Refresh)
      return { columns: d.columns, rows: d.rows };
    }
    case "datasource": {
      const t = await api<{ columns: { name: string; type: string }[]; rows: Table["rows"] }>(`/api/datasources/sources/${ref.id}/table`);
      return { columns: typed(t.columns), rows: t.rows };
    }
    case "virtual": {
      const q = new URLSearchParams({ connection_id: ref.connectionId, database: ref.database, schema: ref.schema, table: ref.table });
      const t = await api<{ columns: { name: string; type: string }[]; rows: Table["rows"] }>(`/api/pipeline/virtual/read?${q}`);
      return { columns: typed(t.columns), rows: t.rows };
    }
    case "media": {
      const f = await api<{ items: { id: string; name: string; kind: string; content_type?: string | null; size?: number | null }[] }>(`/api/drive/folders/${ref.folderId ?? "root"}`);
      const items = f.items.filter((i) => i.kind === "file" && /\.(pdf|png|jpe?g|gif|webp|bmp|tiff?|mp3|wav|m4a|ogg|flac|aac|mp4|webm|mov|mkv)$/i.test(i.name));
      return { columns: d.columns, rows: items.map((i) => ({ mediaReference: i.id, path: i.name, mediaType: i.content_type ?? "", size: i.size ?? null })) };
    }
    case "stream":
    case "ingest": {
      const t = await api<{ columns: { name: string; type: string }[]; rows: Table["rows"] }>(`${streamBase(ref.kind)}/${ref.streamId}/records?limit=100000`);
      return { columns: typed(t.columns), rows: t.rows };
    }
  }
}

/** records of a pipeline stream, or of an ingest stream (Streaming app) */
const streamBase = (kind: "stream" | "ingest") => (kind === "ingest" ? "/api/streaming/streams" : "/api/pipeline/streams");

// ---------------------------------------------------------------- writers

/** The rows a time series sync (series_id, timestamp, value) or geotemporal series sync (series_id, timestamp,
 *  latitude, longitude, properties) gets from an output's table; null for other outputs. */
function seriesTable(o: Output, t: Table): Table | null {
  if (o.kind === "timeSeries" && o.timeSeries) {
    const ts = o.timeSeries;
    return {
      columns: [
        { name: "series_id", type: "String" },
        { name: "timestamp", type: t.columns.find((c) => c.name === ts.timestamp)?.type ?? "Timestamp" },
        { name: "value", type: t.columns.find((c) => c.name === ts.value)?.type ?? "Double" },
      ],
      rows: t.rows.map((r) => ({ series_id: r[ts.seriesId] === null || r[ts.seriesId] === undefined ? null : String(r[ts.seriesId]), timestamp: r[ts.timestamp] ?? null, value: r[ts.value] ?? null })),
    };
  }
  if (o.kind === "geotemporal" && o.geotemporal) {
    const g = o.geotemporal;
    const extra = g.properties ?? [];
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    return {
      columns: [
        { name: "series_id", type: "String" },
        { name: "timestamp", type: t.columns.find((c) => c.name === g.timestamp)?.type ?? "Timestamp" },
        { name: "latitude", type: "Double" },
        { name: "longitude", type: "Double" },
        ...extra.map((e) => ({ name: e, type: t.columns.find((c) => c.name === e)?.type ?? ("String" as ColType) })),
      ],
      rows: t.rows.map((r) => ({
        series_id: r[g.seriesId] === null || r[g.seriesId] === undefined ? null : String(r[g.seriesId]),
        timestamp: r[g.timestamp] ?? null,
        latitude: num(r[g.latitude]),
        longitude: num(r[g.longitude]),
        ...Object.fromEntries(extra.map((e) => [e, r[e] ?? null])),
      })),
    };
  }
  return null;
}

/**
 * Writes a time series / geotemporal output's rows into its sync (timeseries.py: the Time Series DB, or the
 * observations the Map reads); output monitors count these writes. The sync is created on first use.
 */
async function writeSeries(o: Output, p: Pipeline, mode: "batch" | "streaming", rows: Table["rows"], snapshot: boolean, backing?: string, streamId?: string) {
  const geo = o.kind === "geotemporal";
  const sync = await post<{ id: string }>("/api/timeseries/syncs/register", {
    kind: geo ? "geotemporal" : "timeseries",
    name: o.name.trim(),
    pipeline_id: p.id,
    pipeline_name: p.name,
    output_id: o.id,
    mode,
    mapping: (geo ? o.geotemporal : o.timeSeries) ?? {},
    backing_dataset: backing ?? null,
    stream_id: streamId ?? null,
  });
  const res = await post<{ written: number; errors: number }>(`/api/timeseries/syncs/${sync.id}/write`, { rows, snapshot });
  return { id: sync.id, ...res };
}

type Written = {
  rows: number;
  columns: number;
  itemId?: string;
  parentId?: string | null;
  path?: string;
  /** SNAPSHOT or APPEND, and the rows that transaction holds */
  transaction?: string;
  written?: number;
  /** what the next deploy compares to detect breaking changes */
  fingerprint?: string;
  columnNames?: string[];
  version?: number;
};
type WriteFields = Partial<DeployModeFields> & { reset?: boolean };
type DriveItemLite = { id: string; parent_id: string | null; name: string; path?: { name: string }[] };
const pathOf = (item: DriveItemLite) => ["Files & Projects", ...(item.path ?? []).map((x) => x.name), item.name].join(" / ");

async function writeOutput(o: Output, t: Table, p: Pipeline, prev: Written | undefined, others: Map<string, Table>, write: WriteFields): Promise<Written> {
  const location = o.location ?? p.location ?? { id: null, name: "Files & Projects" };
  const sameFolder = prev?.parentId !== undefined && (prev.parentId ?? null) === location.id;
  const itemId = sameFolder ? (prev?.itemId ?? null) : null;
  // written as the build's identity: Editor where it is written (a virtual table: through its connection), and still
  // reading the inputs whose data the output carries
  const label = o.name.trim();
  await checkAccess([
    ...(o.kind === "virtualTable" && o.virtualTable
      ? [{ op: "write" as const, kind: "connection" as const, id: o.virtualTable.connectionId, label }]
      : [{ op: "write" as const, kind: "folder" as const, id: location.id, label }, ...(itemId ? [{ op: "write" as const, kind: "item" as const, id: itemId, label }] : [])]),
    ...Object.values(p.datasets).flatMap(inputChecks),
  ]);
  const dataset = async (name: string, table: Table, fields: WriteFields = write, id = itemId, format: "dataset" | "iceberg" = "dataset") => {
    const res = await post<{ item: DriveItemLite; rows: number; columns: number; transaction: string; written: number }>("/api/pipeline/datasets/deploy", {
      name,
      format,
      parent_id: location.id,
      item_id: id,
      ...fields,
      columns: table.columns,
      rows: table.rows,
      // recorded for Data Lineage
      pipeline_id: p.id,
      output_id: o.id,
      output_name: o.name.trim(),
    });
    return { rows: res.rows, columns: res.columns, itemId: res.item.id, parentId: res.item.parent_id, path: pathOf(res.item), transaction: res.transaction, written: res.written };
  };
  const definition = async (suffix: string, def: Record<string, unknown>) =>
    post("/api/pipeline/outputs/definition", { name: `${o.name.trim()}.${suffix}.json`, parent_id: location.id, definition: { ...def, generatedAt: now(), pipeline: p.name } });
  const kind = o.kind ?? "dataset";
  switch (kind) {
    case "dataset":
      return dataset(o.name.trim(), t);
    case "icebergTable":
      // a Foundry Iceberg table (iceberg_catalog.py): snapshot → one overwrite snapshot, append → an append snapshot
      return dataset(o.name.trim(), t, write, itemId, "iceberg");
    case "file": {
      const f = o.file ?? { format: "csv" as const, fileName: o.name };
      const res = await post<{ item: DriveItemLite; rows: number }>("/api/pipeline/outputs/file", {
        name: f.fileName || o.name,
        parent_id: location.id,
        item_id: itemId,
        format: f.format,
        columns: t.columns,
        rows: t.rows,
        text_column: f.textColumn,
      });
      return { rows: res.rows, columns: t.columns.length, itemId: res.item.id, parentId: res.item.parent_id, path: pathOf(res.item) };
    }
    case "virtualTable": {
      const v = o.virtualTable!;
      const res = await post<{ rows: number; table: string }>("/api/pipeline/virtual/write", {
        connection_id: v.connectionId,
        database: v.database,
        schema: v.schema,
        table: v.table,
        mode: write.mode === "append" && !write.reset ? "append" : "snapshot",
        columns: t.columns,
        rows: t.rows,
      });
      return { rows: res.rows, columns: t.columns.length, path: `${v.connectionName ?? "source"} · ${res.table}` };
    }
    case "mediaSet": {
      const m = o.mediaSet!;
      const res = await post<{ item: DriveItemLite; rows: number }>("/api/pipeline/outputs/media", {
        name: o.name.trim(),
        parent_id: location.id,
        folder_id: itemId,
        items: t.rows.filter((r) => r[m.mediaColumn]).map((r) => ({ ref: String(r[m.mediaColumn]), name: m.pathColumn ? String(r[m.pathColumn] ?? "") || null : null })),
      });
      return { rows: res.rows, columns: 1, itemId: res.item.id, parentId: res.item.parent_id, path: pathOf(res.item) };
    }
    case "objectType": {
      const ot = o.objectType!;
      const props = ot.properties ?? t.columns.map((c) => ({ source: c.name, apiName: c.name, displayName: c.name }));
      const table: Table = {
        columns: props.map((pp) => ({ name: pp.apiName, type: t.columns.find((c) => c.name === pp.source)?.type ?? "String" })),
        rows: t.rows.map((r) => Object.fromEntries(props.map((pp) => [pp.apiName, r[pp.source] ?? null]))),
      };
      const pk = props.find((pp) => pp.source === ot.primaryKey)?.apiName ?? ot.primaryKey;
      const keys = new Set<string>();
      for (const r of table.rows) {
        const k = String(r[pk]);
        if (r[pk] === null) throw new Error(`Object type ${ot.apiName}: primary key "${pk}" has nulls`);
        if (keys.has(k)) throw new Error(`Object type ${ot.apiName}: primary key "${pk}" is not unique (${k})`);
        keys.add(k);
      }
      const w = await dataset(o.name.trim(), table, { mode: "snapshot" });
      await definition("objecttype", {
        kind: "objectType",
        apiName: ot.apiName,
        pluralName: ot.pluralName || `${ot.apiName}s`,
        description: ot.description ?? "",
        primaryKey: pk,
        titleProperty: props.find((pp) => pp.source === ot.titleProperty)?.apiName ?? ot.titleProperty,
        properties: props.map((pp) => ({ apiName: pp.apiName, displayName: pp.displayName, type: table.columns.find((c) => c.name === pp.apiName)?.type, source: pp.source })),
        interfaces: ot.interfaces ?? [],
        backingDataset: w.path,
        objects: table.rows.length,
      });
      if (ot.register && w.itemId) {
        // the Ontology object type this output backs (api/ontology_datasources.py): created on the first deploy, re-indexed later
        await post("/api/ontology/object-types/from-pipeline-output", {
          dataset_id: w.itemId,
          api_name: ot.apiName,
          display_name: o.name.trim(),
          plural_name: ot.pluralName || null,
          description: ot.description ?? "",
          primary_key: pk,
          title_property: props.find((pp) => pp.source === ot.titleProperty)?.apiName ?? ot.titleProperty,
          columns: props.map((pp) => ({ column: pp.apiName, api_name: pp.apiName, display_name: pp.displayName || pp.apiName })),
          interfaces: (ot.interfaces ?? []).filter((i) => i.interfaceId).map((i) => ({ interface_id: i.interfaceId, mapping: i.mapping })),
        });
      }
      return w;
    }
    case "linkType": {
      const l = o.linkType!;
      const from = p.outputs.find((x) => x.id === l.from);
      const to = p.outputs.find((x) => x.id === l.to);
      if (!from?.objectType || !to?.objectType) throw new Error("A link type needs two object type outputs");
      let table: Table;
      if (l.cardinality === "many-to-many") {
        table = { columns: [{ name: `${from.objectType.apiName}_pk`, type: "String" }, { name: `${to.objectType.apiName}_pk`, type: "String" }], rows: t.rows.map((r) => ({ [`${from.objectType!.apiName}_pk`]: r[l.fromKey] === null ? null : String(r[l.fromKey]), [`${to.objectType!.apiName}_pk`]: r[l.toKey] === null ? null : String(r[l.toKey]) })) };
      } else {
        const ft = others.get(from.id);
        if (!ft) throw new Error(`Build "${from.name}" in the same build to link it`);
        table = {
          columns: [{ name: `${from.objectType.apiName}_pk`, type: "String" }, { name: `${to.objectType.apiName}_pk`, type: "String" }],
          rows: ft.rows.filter((r) => r[l.fromKey] !== null && r[l.fromKey] !== undefined).map((r) => ({ [`${from.objectType!.apiName}_pk`]: String(r[from.objectType!.primaryKey]), [`${to.objectType!.apiName}_pk`]: String(r[l.fromKey]) })),
        };
      }
      const w = await dataset(o.name.trim(), table, { mode: "snapshot" });
      await definition("linktype", { kind: "linkType", apiName: l.apiName, reverseApiName: l.reverseApiName, cardinality: l.cardinality, from: from.objectType.apiName, to: to.objectType.apiName, foreignKey: l.fromKey, links: table.rows.length, backingDataset: w.path });
      return w;
    }
    case "timeSeries": {
      const ts = o.timeSeries!;
      const table = seriesTable(o, t)!;
      const w = await dataset(o.name.trim(), table);
      const sync = await writeSeries(o, p, "batch", table.rows, w.transaction === "SNAPSHOT", w.path);
      await definition("timeseries", { kind: "timeSeriesSync", seriesIdColumn: ts.seriesId, timestampColumn: ts.timestamp, valueColumn: ts.value, series: new Set(table.rows.map((r) => r.series_id)).size, backingDataset: w.path, syncId: sync.id, pointsWritten: sync.written });
      return w;
    }
    case "geotemporal": {
      const table = seriesTable(o, t)!;
      const w = await dataset(o.name.trim(), table);
      const sync = await writeSeries(o, p, "batch", table.rows, w.transaction === "SNAPSHOT", w.path);
      await definition("geotemporal", { kind: "geotemporalSeriesSync", observations: table.rows.length, backingDataset: w.path, syncId: sync.id, observationsSent: sync.written, rejected: sync.errors });
      return w;
    }
  }
}

// ---------------------------------------------------------------- the run

/** A short, stable hash of an output row (stateful outputs only emit rows they have not emitted yet). */
function rowHash(r: Record<string, unknown>): string {
  const text = JSON.stringify(r);
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/** Network errors and 5xx answers may pass on their own: the job retries them before it fails. */
const isTransient = (e: unknown) => /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|\b50[0-9]\b|Service Unavailable|Bad Gateway/i.test(String((e as Error)?.message ?? e));

type Buffered = { at: number; row: Table["rows"][number] };
type StreamCheckpoint = {
  offsets: Record<string, number>;
  views: Record<string, string>;
  /** stateful outputs: the input records kept as state, and hashes of the rows already emitted */
  buffers?: Record<string, Buffered[]>;
  emitted?: Record<string, string[]>;
  /** keyed process UDF steps: state, timers and watermark per step (node id:step id) */
  keyed?: Record<string, unknown>;
};

/** A keyed process UDF step's checkpointed timer (KeyedRunner.saved: {state, timers, watermark}). */
type KeyedTimer = { key?: string; time?: number; domain?: string };

/** Is a processing-time timer of any keyed process UDF step due (at or before now)? */
function processingTimersDue(keyed: StreamCheckpoint["keyed"], now = Date.now()): boolean {
  for (const scope of Object.values(keyed ?? {})) {
    const timers = (scope as { timers?: KeyedTimer[] } | null)?.timers;
    if (timers?.some((t) => t.domain === "PROCESSING_TIME" && typeof t.time === "number" && t.time <= now)) return true;
  }
  return false;
}

/**
 * A streaming job: every couple of seconds it reads the records pushed to its input streams since the
 * last ones it processed, runs the pipeline on them and pushes the results to one output stream per
 * output (an ingest stream of the Streaming app, with the keys the pipeline propagates). Stateless outputs
 * see each new record once; outputs behind stateful transforms (aggregations, windows, dedupe …) run over
 * the records kept as state — bounded by the profile's buffered records and the state expiry — and emit
 * the rows that changed, like a running aggregate. Offsets and state are checkpointed together; network
 * failures are retried, and the API restarts a job that stopped on one. It runs until cancelled or until
 * the max job duration (default one day off main).
 */
async function runStreaming(
  build: Build,
  pipeline: Pipeline,
  outputs: Output[],
  log: (level: Log["level"], msg: string) => void,
  flushLogs: (patch?: Record<string, unknown>) => Promise<void>,
) {
  const branch = build.branch || "main";
  const suffix = branch === "main" ? "" : `@${branch}`;
  const settings = pipeline.buildSettings ?? {};
  const maxMinutes = settings.maxDurationMinutes === null ? null : (settings.maxDurationMinutes ?? (branch === "main" ? null : 1440));
  const deadline = maxMinutes ? Date.now() + maxMinutes * 60_000 : Infinity;
  const tuned = settings.streamingSettings;
  const batch = Math.max(1, Math.min(100_000, tuned?.batch_records ?? 5000));
  const stateLimit = Math.max(100, tuned?.buffer_records ?? 10_000);
  const stateTtlMs = (settings.stateTtlMinutes ?? 1440) * 60_000;
  const checkpointMs = Math.max(2, Math.min(tuned?.checkpoint_interval_s ?? 10, 60)) * 1000;
  const state = await api<Record<string, unknown>>(`/api/pipeline/state/${pipeline.id}`);
  const saved = (state[`checkpoint${suffix}`] as StreamCheckpoint | undefined) ?? {
    offsets: (state[`offsets${suffix}`] as Record<string, number>) ?? {},
    views: (state[`views${suffix}`] as Record<string, string>) ?? {},
  };
  const cp: StreamCheckpoint = build.replay ? { offsets: {}, views: {}, buffers: {}, emitted: {}, keyed: {} } : { buffers: {}, emitted: {}, keyed: {}, ...saved };
  cp.keyed ??= {};
  // keyed process UDF steps read the committed state; the answers they use carry the next one (committed per batch)
  const keyedUsed = new Map<string, string>();
  const keyedState: KeyedStates = { get: (scope) => cp.keyed?.[scope] ?? null, use: (scope, key) => void keyedUsed.set(scope, key) };
  if (build.replay) log("info", "Replay: reading the input streams from the start and resetting the state");
  const streamInputs = Object.values(pipeline.datasets).filter((d) => d.ref?.kind === "stream" || d.ref?.kind === "ingest");
  if (!streamInputs.length) {
    log("error", "A streaming pipeline needs at least one stream input (Add data → Add a stream)");
    await flushLogs({ status: "failed", finished_at: now(), error: "No stream input", failure_type: "immediate" });
    return;
  }
  // static inputs are read once
  const statics: Record<string, Dataset> = {};
  for (const [id, d] of Object.entries(pipeline.datasets)) if (d.ref?.kind !== "stream" && d.ref?.kind !== "ingest") statics[id] = { ...d, ...(await readInput(d)) };
  const sql = (pipeline.functions ?? []).length || pipeline.nodes.some((n) => n.kind === "transform" && n.steps.some((st) => st.kind === "sql")) ? await loadSql() : undefined;
  const services = new NodeServices();
  const stateful = new Set(outputs.filter((o) => isStatefulOutput(pipeline, o.node)).map((o) => o.id));
  // stateless outputs behind keyed process UDFs: they also run when a processing-time timer is due
  const keyedOuts = outputs.filter((o) => !stateful.has(o.id) && keyedProcessUdfs(pipeline, o.node).length > 0);
  if (stateful.size) log("info", `Stateful outputs (${[...stateful].map((id) => outputs.find((o) => o.id === id)!.name).join(", ")}): state keeps up to ${stateLimit.toLocaleString()} records per input for ${Math.round(stateTtlMs / 60_000)} minutes`);

  // keys of the input streams, for the output streams' keys
  const inputKeys: Record<string, StreamKeys | undefined> = {};
  for (const d of streamInputs) {
    const ref = d.ref as { kind: "stream" | "ingest"; streamId: string };
    if (ref.kind === "ingest") inputKeys[d.id] = (await api<{ keys?: StreamKeys }>(`/api/streaming/streams/${ref.streamId}`)).keys;
  }
  for (const n of pipeline.nodes) if (n.kind === "source" && inputKeys[n.datasetId] === undefined) inputKeys[n.datasetId] = undefined;

  // one output stream per output: an ingest stream (pipelines deployed before keep their pipeline stream)
  const outStreams: Record<string, { kind: "stream" | "ingest"; id: string }> = {};
  for (const o of outputs) {
    const legacy = state[`stream:${o.id}${suffix}`] as string | undefined;
    const preview = evaluator(pipeline, sql, { services, preview: true })(o.node);
    const columns = preview.table ? outputTable(o, preview.table).columns : [];
    const keys = streamKeys(pipeline, o.node, inputKeys, columns.map((c) => c.name));
    if (legacy) {
      outStreams[o.id] = { kind: "stream", id: legacy };
      continue;
    }
    const key = `istream:${o.id}${suffix}`;
    let id = state[key] as string | undefined;
    // the output stream is the pipeline's: changed or created by an Editor of the pipeline
    await checkAccess([{ op: "write", kind: "pipeline", id: pipeline.id }]);
    if (id) {
      try {
        await api(`/api/streaming/streams/${id}/keys`, { method: "PUT", body: JSON.stringify(keys) });
      } catch {
        id = undefined; // the stream was deleted: create it again
      }
    }
    if (!id) {
      const created = await post<{ id: string }>("/api/streaming/streams", {
        name: `${branchOutputName(o.name, branch)}`,
        schema: columns.map((c) => ({ name: c.name, type: c.type })),
        keys,
        origin: { kind: "pipeline", pipeline_id: pipeline.id, pipeline_name: pipeline.name, output_id: o.id, branch },
      });
      id = created.id;
      await api(`/api/pipeline/state/${pipeline.id}`, { method: "PUT", body: JSON.stringify({ values: { [key]: id } }) });
      log("info", `${o.name}: created output stream ${id}`);
    }
    if (keys.partition.length) log("info", `${o.name}: partition key ${keys.partition.join(", ")}${keys.primary ? ` · primary key (CDC) ${keys.primary.columns.join(", ")}` : ""}`);
    outStreams[o.id] = { kind: "ingest", id };
  }
  const writeOut = (o: Output, rows: Table["rows"]) =>
    post(outStreams[o.id].kind === "ingest" ? `/api/streaming/streams/${outStreams[o.id].id}/records` : `/api/pipeline/streams/${outStreams[o.id].id}/records`, rows);

  const consistency = settings.consistency ? settings.consistency.replace(/-/g, " ") : "not configured";
  const profiles = settings.streamingProfiles?.length ? ` · streaming profiles ${settings.streamingProfiles.join(" + ")}${settings.streamingAdvanced && Object.keys(settings.streamingAdvanced).length ? " (advanced)" : ""}` : "";
  log("info", `Streaming job started on ${branch} · profile ${settings.streamingProfile ?? "xs"}${profiles} · consistency ${consistency}${maxMinutes ? ` · stops after ${maxMinutes} minutes` : ""}`);
  const jobs: Job[] = [
    {
      id: "stream",
      name: "Streaming job",
      profile: settings.streamingProfile ?? "xs",
      status: "running",
      started_at: now(),
      logs: [],
      outputs: outputs.map((o) => ({ id: o.id, name: o.name, kind: "stream", status: "running", rows: 0, path: `${outStreams[o.id].kind === "ingest" ? "ingest stream" : "stream"} ${outStreams[o.id].id}`, streamId: outStreams[o.id].kind === "ingest" ? outStreams[o.id].id : undefined })),
    },
  ];
  await flushLogs({ jobs, streaming: true });

  const saveCheckpoint = () =>
    api(`/api/pipeline/state/${pipeline.id}`, { method: "PUT", body: JSON.stringify({ values: { [`checkpoint${suffix}`]: cp, [`offsets${suffix}`]: cp.offsets, [`views${suffix}`]: cp.views } }) });
  const evaluate = async (datasets: Record<string, Dataset>, keyed?: KeyedStates) => {
    const live: Pipeline = { ...pipeline, datasets: { ...statics, ...datasets } };
    let ev = evaluator(live, sql, { services, keyedState: keyed });
    for (let round = 0; round < 20; round++) {
      let pending = 0;
      for (const o of outputs) pending += ev(o.node).pending ?? 0;
      if (!pending && !services.queue.size) break;
      await services.flush();
      ev = evaluator(live, sql, { services, keyedState: keyed });
    }
    return ev;
  };

  let processed = 0;
  let lastReport = Date.now();
  let lastCheckpoint = Date.now();
  let dirty = false;
  let failures = 0;
  for (;;) {
    try {
      const current = await api<Build>(`/api/pipeline/builds/${build.id}`);
      // the API gave up on this job (marked it failed after losing contact) and restarted it as a new build:
      // this runner stops, so the two never process the same records
      if (current.status !== "running") {
        log("warn", `Runner stopped: the build is ${current.status} (a restarted job took over from the last checkpoint)`);
        await flushLogs();
        return;
      }
      if (current.cancel || Date.now() > deadline) {
        if (dirty) await saveCheckpoint();
        const stopped = current.cancel ? "cancelled" : "succeeded";
        jobs[0].status = current.cancel ? "cancelled" : "succeeded";
        jobs[0].finished_at = now();
        for (const o of jobs[0].outputs) o.status = current.cancel ? "skipped" : "succeeded";
        log("info", current.cancel ? `Stopped by the user after ${processed.toLocaleString()} records` : `Reached the max job duration after ${processed.toLocaleString()} records`);
        await flushLogs({ status: stopped, finished_at: now(), jobs, summary: { jobs: 1, succeeded: current.cancel ? 0 : 1, serviceCalls: services.calls, records: processed } });
        return;
      }
      // every batch reads its inputs and writes its outputs as the build's identity, as it is now
      await checkAccess([
        ...streamInputs.flatMap(inputChecks),
        { op: "write", kind: "pipeline", id: pipeline.id },
        ...outputs.map((o): AccessCheck => ({ op: "write", kind: outStreams[o.id].kind === "ingest" ? "ingest" : "stream", id: outStreams[o.id].id, label: o.name })),
      ]);
      // new records of each input stream
      const fresh: Record<string, Dataset> = {};
      let any = false;
      const nextOffsets = { ...cp.offsets };
      const nextViews = { ...cp.views };
      for (const d of streamInputs) {
        const ref = d.ref as { kind: "stream" | "ingest"; streamId: string };
        const read = (after: number) =>
          api<{ columns: { name: string; type: string }[]; rows: Table["rows"]; last_seq: number; view_id?: string }>(`${streamBase(ref.kind)}/${ref.streamId}/records?after=${after}&limit=${batch}`);
        let r = await read(cp.offsets[d.id] ?? 0);
        if (r.view_id && cp.views[d.id] && r.view_id !== cp.views[d.id]) {
          log("warn", `${d.name}: the ingest stream was reset (view ${r.view_id}); reading the new view from the start and clearing its state`);
          if (cp.buffers) cp.buffers[d.id] = [];
          r = await read(0);
        }
        if (r.view_id) nextViews[d.id] = r.view_id;
        fresh[d.id] = { ...d, columns: r.columns.length ? typed(r.columns) : d.columns, rows: r.rows, files: undefined };
        nextOffsets[d.id] = r.last_seq;
        any ||= r.rows.length > 0;
      }
      // keyed process UDFs: processing-time timers fire on the job's clock, also while no records arrive — a timer
      // tick runs the outputs behind keyed process UDFs over no new records, so their due timers fire
      const tick = !any && keyedOuts.length > 0 && processingTimersDue(cp.keyed);
      if (any || tick) {
        // stateless outputs: the new records only
        const statelessOuts = outputs.filter((o) => !stateful.has(o.id) && (any || keyedOuts.includes(o)));
        keyedUsed.clear();
        const evFresh = statelessOuts.length ? await evaluate(fresh, keyedState) : null;
        // stateful outputs: every record kept as state
        let evState: Awaited<ReturnType<typeof evaluate>> | null = null;
        if (stateful.size && any) {
          const t = Date.now();
          const kept: Record<string, Dataset> = {};
          for (const d of streamInputs) {
            const buf = [...(cp.buffers![d.id] ?? []), ...fresh[d.id].rows.map((row) => ({ at: t, row }))].filter((b) => t - b.at <= stateTtlMs);
            cp.buffers![d.id] = buf.slice(-stateLimit);
            kept[d.id] = { ...fresh[d.id], rows: cp.buffers![d.id].map((b) => b.row) };
          }
          evState = await evaluate(kept);
        }
        for (const o of any ? outputs : keyedOuts) {
          const run = jobs[0].outputs.find((x) => x.id === o.id)!;
          const r = (stateful.has(o.id) ? evState : evFresh)!(o.node);
          if (r.error !== undefined) {
            run.error = r.error;
            log("error", `${o.name}: ${r.error}`);
            continue;
          }
          let rows = outputTable(o, r.table).rows;
          if (stateful.has(o.id)) {
            // emit what changed: rows not emitted before (a running aggregate emits its updated row)
            const seen = new Set(cp.emitted![o.id] ?? []);
            const hashes = rows.map(rowHash);
            rows = rows.filter((_, i) => !seen.has(hashes[i]));
            cp.emitted![o.id] = [...new Set(hashes)].slice(-stateLimit * 2);
          }
          if (rows.length) await writeOut(o, rows);
          // time series and geotemporal outputs also land in their sync (an empty batch still counts as a write)
          const series = seriesTable(o, { columns: [], rows });
          if (series) {
            const w = await writeSeries({ ...o, name: branchOutputName(o.name, branch) }, pipeline, "streaming", series.rows, false, undefined, outStreams[o.id].kind === "ingest" ? outStreams[o.id].id : undefined);
            if (w.errors) log("warn", `${o.name}: ${w.errors} row${w.errors === 1 ? "" : "s"} rejected by the ${o.kind === "geotemporal" ? "geotemporal" : "time series"} sync (see its errors)`);
          }
          run.rows = (run.rows ?? 0) + rows.length;
          run.error = undefined;
        }
        processed += Object.values(fresh).reduce((n, d) => n + d.rows.length, 0);
        // keyed process UDFs: their new state goes into the checkpoint with the offsets it belongs to
        for (const [scope, key] of keyedUsed) {
          const a = services.get(key);
          if (a && "value" in a && (a.value as { keyed?: unknown }).keyed !== undefined) cp.keyed![scope] = (a.value as { keyed: unknown }).keyed;
          services.answers.delete(key);
        }
        cp.offsets = nextOffsets;
        cp.views = nextViews;
        dirty = true;
      }
      if (dirty && (!stateful.size || Date.now() - lastCheckpoint >= checkpointMs)) {
        await saveCheckpoint();
        dirty = false;
        lastCheckpoint = Date.now();
      }
      failures = 0;
      if (Date.now() - lastReport > 10_000 || any) {
        lastReport = Date.now();
        if (any) log("info", `${processed.toLocaleString()} records processed`);
        await flushLogs({ jobs });
      }
    } catch (e) {
      // transient: retried with backoff, then the job fails and the API restarts it; anything else fails now
      // a refusal as the build's identity is never retried (its reason could read like a transient error)
      const transient = !(e instanceof AccessDenied) && isTransient(e);
      failures += 1;
      if (transient && failures <= 5) {
        log("warn", `Transient failure (attempt ${failures} of 5): ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** failures)));
        continue;
      }
      jobs[0].status = "failed";
      jobs[0].finished_at = now();
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { failureType: transient ? "transient" : "persistent", jobs });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

type QueueLease = { id: string; granted: boolean; queue_name: string; vcpu_limit: number; vcpus: number; in_use: number; ahead: number; timer?: ReturnType<typeof setInterval> };

/** Room in the Project's resource queue for a job (api/resource_queues.py): waits until granted, then keeps the lease
 *  alive while the job runs. Null when the build is cancelled while waiting. */
async function queueLease(itemId: string, profile: string, label: string, log: (level: Log["level"], msg: string) => void, flush: () => Promise<void>, cancelled: () => Promise<boolean>): Promise<QueueLease | null> {
  let l = await post<QueueLease>("/api/resource-queues/leases", { item_id: itemId, profile, label, kind: "pipeline" });
  if (!l.granted) {
    log("info", `${label}: waiting in the Project's resource queue ${l.queue_name} (${l.in_use}/${l.vcpu_limit} vCPUs in use, ${l.ahead} job${l.ahead === 1 ? "" : "s"} ahead; this job needs ${l.vcpus})`);
    await flush();
  }
  const waited = Date.now();
  while (!l.granted) {
    if (await cancelled()) {
      await api(`/api/resource-queues/leases/${l.id}`, { method: "DELETE" }).catch(() => {});
      return null;
    }
    await new Promise((r) => setTimeout(r, 3000));
    l = await post<QueueLease>(`/api/resource-queues/leases/${l.id}/poll`, {});
  }
  if (Date.now() - waited > 3000) log("info", `${label}: started after ${Math.round((Date.now() - waited) / 1000)} s in the resource queue ${l.queue_name}`);
  const id = l.id;
  l.timer = setInterval(() => void post(`/api/resource-queues/leases/${id}/poll`, {}).catch(() => {}), 60_000);
  return l;
}

async function releaseLease(l: QueueLease | null): Promise<void> {
  if (!l) return;
  if (l.timer) clearInterval(l.timer);
  await api(`/api/resource-queues/leases/${l.id}`, { method: "DELETE" }).catch(() => {});
}

/** Runs a build: every API call it makes carries the build (X-Bsai-Build), so it is checked as the build's identity. */
export function runBuild(buildId: string): Promise<void> {
  return currentBuild.run(buildId, () => runBuildAs(buildId));
}

async function runBuildAs(buildId: string): Promise<void> {
  const build = await api<Build>(`/api/pipeline/builds/${buildId}`);
  const logs: Log[] = [];
  const log = (level: Log["level"], msg: string) => logs.push({ at: now(), level, msg });
  const flushLogs = async (patch: Record<string, unknown> = {}) => {
    const out = logs.splice(0);
    await api(`/api/pipeline/builds/${buildId}`, { method: "PATCH", body: JSON.stringify({ ...patch, logs: out }) });
  };
  const fail = async (error: string, extra: Record<string, unknown> = {}) => {
    log("error", error);
    await flushLogs({ status: "failed", finished_at: now(), error, ...extra });
  };
  let lease: QueueLease | null = null;

  try {
    await flushLogs({ status: "running", started_at: now() });
    // the pipeline is read as the build's identity (the user it runs as may have lost access since it was queued)
    await checkAccess([{ op: "read", kind: "pipeline", id: build.pipeline_id }]);
    const file = await api<{ item: { id: string; name: string; parent_id: string | null; path?: { name: string }[] }; content: Record<string, unknown> }>(`/api/pipeline/files/${build.pipeline_id}`);
    const content = branchContent(file.content, build.branch, build.version_id ?? undefined);
    const parent = file.item.path?.[file.item.path.length - 1];
    const pipeline = {
      nodes: [],
      outputs: [],
      datasets: {},
      legend: [],
      type: "batch",
      ...content,
      id: file.item.id,
      name: file.item.name.replace(/\.pipeline$/i, ""),
      location: file.item.parent_id ? { id: file.item.parent_id, name: parent?.name ?? "" } : { id: null, name: "Files & Projects" },
    } as unknown as Pipeline;
    log("info", `Building ${pipeline.name} on branch ${build.branch || "main"} (${pipeline.compute ?? "standard"} ${pipeline.type})${build.version_id ? ` from the earlier logic version ${build.version_id}` : ""}`);
    if (build.run_as_name)
      log("info", build.scope === "project" ? `Runs in the schedule's Projects with the markings of ${build.run_as_name}` : `Runs as ${build.run_as_name}: reads and writes with their markings and Project roles`);
    const overrides = Object.entries(build.parameters ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (overrides.length) {
      const known = new Set((pipeline.parameters ?? []).map((x) => x.name));
      for (const [k] of overrides) if (!known.has(k)) log("warn", `Parameter "${k}" is not defined in the pipeline: ignored`);
      pipeline.parameters = (pipeline.parameters ?? []).map((x) => (build.parameters && x.name in build.parameters && build.parameters[x.name] !== "" ? { ...x, value: String(build.parameters[x.name]) } : x));
      log("info", `Parameters: ${overrides.map(([k, v]) => `${k} = ${String(v)}`).join(", ")}${build.run_setup ? ` (run setup ${build.run_setup.name})` : ""}`);
    }
    // a run setup keeps its own outputs, deploy state and watermarks
    const setupSuffix = build.run_setup ? `#${build.run_setup.id}` : "";
    const outputName = (name: string) => branchOutputName(name, build.branch) + (build.run_setup ? ` [${build.run_setup.name}]` : "");

    const outputs = selectOutputs(pipeline, build.outputs, build.target);
    const { errors, warnings } = validate(pipeline, outputs);
    for (const w of warnings) log("warn", w);
    if (errors.length) return fail("Deployment validation failed", { validation: errors.map((e) => ({ level: "error", message: e })), failure_type: "immediate" });
    if (pipeline.type === "streaming") return await runStreaming(build, pipeline, outputs, log, flushLogs);

    // inputs: fresh from their sources; incremental ones only past their watermark
    const state = await api<Record<string, unknown>>(`/api/pipeline/state/${pipeline.id}`);
    const watermarks = ((state[`watermarks${setupSuffix}`] as Record<string, number>) ?? {}) as Record<string, number>;
    const datasets: Record<string, Dataset> = {};
    const nextMarks: Record<string, number> = {};
    // Compute if expression absent: results by store id, kept across builds (a replay keeps them too: they are keyed)
    const storesKey = `stores${setupSuffix}`;
    const storeBook = ((state[storesKey] as Record<string, { type?: ColType; results: Record<string, Cell> }>) ?? {}) as Record<string, { type?: ColType; results: Record<string, Cell> }>;
    const storeAdded: Record<string, number> = {};
    const stores: ResultStores = {
      get: (id) => storeBook[id]?.results,
      type: (id) => storeBook[id]?.type,
      put: (id, results, type) => {
        const s = (storeBook[id] ??= { results: {} });
        for (const k of Object.keys(results)) if (!(k in s.results)) storeAdded[id] = (storeAdded[id] ?? 0) + 1;
        Object.assign(s.results, results);
        s.type ??= type;
      },
    };
    const incremental = new Set(pipeline.nodes.filter((n) => n.kind === "source" && n.mode === "incremental").map((n) => (n as { datasetId: string }).datasetId));
    const effectiveMarks: Record<string, number> = {};
    const settings = pipeline.buildSettings ?? {};
    // regular snapshotting: an incremental pipeline re-processes its inputs in full now and then, so many small
    // APPEND transactions do not pile up in its outputs (Foundry: "Maintaining high performance")
    const snapKey = `snapshot${setupSuffix}`;
    const snapBook = (state[snapKey] as { at?: string; builds?: number; appends?: number } | undefined) ?? {};
    const regular = settings.regularSnapshot;
    const hasIncremental = pipeline.nodes.some((n) => n.kind === "source" && n.mode === "incremental");
    let snapshotReason: string | null = null;
    if (regular?.enabled && hasIncremental && !build.replay) {
      const days = snapBook.at ? (Date.now() - Date.parse(snapBook.at)) / 86_400_000 : Infinity;
      if (regular.everyBuilds && (snapBook.builds ?? 0) >= regular.everyBuilds) snapshotReason = `${snapBook.builds} incremental builds since the last snapshot`;
      else if (regular.everyDays && snapBook.at && days >= regular.everyDays) snapshotReason = `${Math.floor(days)} days since the last snapshot`;
      else if (regular.maxAppends && (snapBook.appends ?? 0) >= regular.maxAppends) snapshotReason = `${snapBook.appends} APPEND transactions since the last snapshot`;
    }
    let replay = !!build.replay || !!snapshotReason;
    // incremental inputs that were recomputed (a SNAPSHOT) since the last build: their outputs snapshot
    const recomputed = new Set<string>();
    if (snapshotReason) log("info", `Regular snapshot (${snapshotReason}): incremental inputs are read in full and the outputs are replaced with a fresh SNAPSHOT`);
    else if (replay) log("info", "Replay strategy: replay from start of input data — incremental inputs are read in full and the outputs are reset");
    let appendsThisBuild = 0;
    // external pipelines: the inputs stay in the source; every output runs there as one SQL statement
    const external = pipeline.compute === "external";
    if (external) log("info", `External pipeline: compute is pushed down to ${pipeline.external?.connectionName ?? "the source"} (${pipeline.external?.kind ?? "?"}) — no rows are read here`);
    // the DuckDB local engine: every output runs in the API as one DuckDB statement over the Files datasets on disk
    const duckdb = pipeline.compute === "duckdb";
    if (duckdb) log("info", "DuckDB local engine: each output runs as one SQL statement over the input datasets on disk — no rows are read here");
    // checkpoint nodes there: computed once into a file the API keeps per content, shared by every output (logged once)
    const checkpointNames = new Map(pipeline.nodes.map((n) => [checkpointTable(n.id), n.name]));
    const checkpointsLogged = new Set<string>();
    const logCheckpoints = (done: CheckpointDone[] | undefined) => {
      for (const c of done ?? []) {
        if (checkpointsLogged.has(c.table)) continue;
        checkpointsLogged.add(c.table);
        const name = checkpointNames.get(c.table) ?? c.table;
        log("info", `Checkpoint ${name}: ${c.reused ? "unchanged since it was last computed — reused" : `computed in ${c.seconds.toLocaleString()} s`} (${c.rows.toLocaleString()} rows)`);
      }
    };
    for (const [id, d] of Object.entries(pipeline.datasets)) {
      if (external || duckdb) {
        datasets[id] = d;
        continue;
      }
      try {
        const t = await readInput(d, fallbackChain(file.content, build.branch));
        datasets[id] = { ...d, ...t };
        if (incremental.has(id)) {
          const mark = watermarks[id] ?? 0;
          if (replay) effectiveMarks[id] = 0;
          else if (t.rows.length < mark) {
            log("warn", `${d.name}: the input has fewer rows than already processed (it was recomputed, a SNAPSHOT) — processing every row`);
            effectiveMarks[id] = 0;
            recomputed.add(id);
          } else effectiveMarks[id] = mark;
          nextMarks[id] = t.rows.length;
          log("info", `${d.name}: incremental — ${(t.rows.length - effectiveMarks[id]).toLocaleString()} new rows (${t.rows.length.toLocaleString()} total)`);
        } else if (d.ref) log("info", `${d.name}: read ${t.rows.length.toLocaleString()} rows from ${d.ref.kind}`);
      } catch (e) {
        // the build's identity may not read it (any longer): the build stops with the reason
        if (e instanceof AccessDenied) throw e;
        return fail(`Could not read input "${d.name}": ${(e as Error).message}`);
      }
    }
    // automatic replay (2026-10-26: incremental is the default for new pipelines, and a replay starts on its
    // own): the stateful transforms feeding an incremental output changed, or an incremental input's schema
    // changed, since the last successful build — read every input in full and reset the outputs instead of
    // failing as a breaking change (the per-output check below stays as the safety net)
    if (!replay && hasIncremental) {
      const reasons: string[] = [];
      for (const o of outputs) {
        if (!incrementalInputs(pipeline, o.node).length) continue;
        const key = (build.branch && build.branch !== "main" ? `output:${o.id}@${build.branch}` : `output:${o.id}`) + setupSuffix;
        const prev = state[key] as Written | undefined;
        if (prev?.fingerprint !== undefined && prev.fingerprint !== statefulFingerprint(pipeline, o.node))
          reasons.push(`${o.name}: stateful transforms changed`);
      }
      const prevSchemas = (state[`inputSchemas${setupSuffix}`] as Record<string, string> | undefined) ?? {};
      for (const id of incremental) {
        const cur = (datasets[id]?.columns ?? []).map((c) => `${c.name}:${c.type}`).join(",");
        if (prevSchemas[id] && prevSchemas[id] !== cur) reasons.push(`${pipeline.datasets[id]?.name ?? id}: input schema changed`);
      }
      if (reasons.length) {
        replay = true;
        snapshotReason = reasons.join("; ");
        for (const id of incremental) {
          effectiveMarks[id] = 0;
          recomputed.add(id);
        }
        log("info", `Automatic replay (${snapshotReason}): incremental inputs are read in full and the outputs are reset`);
      }
    }
    // pre-conditions: checks on the inputs before any job runs (abort the build, or warn)
    const preconditions: (ExpectationResult & { input: string })[] = [];
    for (const [id, d] of Object.entries(pipeline.datasets))
      if (!external && !duckdb) for (const r of checkExpectations(datasets[id], d.preconditions)) preconditions.push({ ...r, input: d.name });
    if (preconditions.length) {
      const failed = preconditions.filter((r) => !r.ok);
      for (const r of failed) log(r.mode === "warn" ? "warn" : "error", `Pre-condition on "${r.input}"${r.mode === "warn" ? " (warn only)" : ""}: ${r.message}`);
      log("info", `${preconditions.length - failed.length}/${preconditions.length} input pre-conditions pass`);
      const aborting = failed.filter((r) => r.mode !== "warn");
      if (aborting.length) return fail(`Pre-condition failed on ${[...new Set(aborting.map((r) => `"${r.input}"`))].join(", ")}: ${aborting.map((r) => r.message).join("; ")}`, { preconditions, failure_type: "persistent" });
      await flushLogs({ preconditions });
    }
    const live: Pipeline = { ...pipeline, datasets };
    const needsSql = live.nodes.some((n) => n.kind === "transform" && n.steps.some((s) => s.kind === "sql" || s.kind.startsWith("fn:"))) || (live.functions ?? []).length > 0;
    const sql = needsSql ? await loadSql() : undefined;
    const services = new NodeServices();

    // jobs: one per job group, one per ungrouped output
    const groups = new Map<string, Output[]>();
    for (const o of outputs) {
      const key = o.jobGroup && pipeline.jobGroups?.some((g) => g.id === o.jobGroup) ? o.jobGroup : `single:${o.id}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
    }
    let defaultProfile: string = pipeline.buildSettings?.profile ?? (pipeline.compute === "faster" ? "faster-s" : "xs");
    // managed profile: the allocation follows the last five successful builds (never above the selected one)
    if (settings.strategy === "managed" && pipeline.compute !== "faster") {
      try {
        const prev = await api<Build[]>(`/api/pipeline/builds?pipeline_id=${pipeline.id}&status=succeeded&limit=20`);
        const recent = prev
          .filter((b) => (b.branch || "main") === (build.branch || "main") && b.jobs.length)
          .map((b) => ({
            profile: b.jobs[0].profile,
            seconds: Math.max(...b.jobs.map((j) => (j.started_at && j.finished_at ? (Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000 : 0))),
          }));
        const choice = managedProfile(defaultProfile, recent);
        log("info", `Managed profile: ${choice.profile} (selected ${defaultProfile}) — ${choice.reason}`);
        defaultProfile = choice.profile;
      } catch (e) {
        log("warn", `Managed profile: could not read recent builds (${(e as Error).message}); using the selected allocation`);
      }
    }
    const jobs: Job[] = [...groups].map(([key, outs]) => {
      const g = pipeline.jobGroups?.find((x) => x.id === key);
      return {
        id: key,
        name: g ? g.name : outs[0].name,
        profile: g?.profile ?? defaultProfile,
        status: "pending",
        logs: [],
        outputs: outs.map((o) => ({ id: o.id, name: o.name, kind: o.kind ?? "dataset", status: "pending" })),
      };
    });
    await flushLogs({ jobs });

    // checkpoints: computed once per build and shared by every job
    const checkpointIds = new Set(pipeline.nodes.filter((n) => n.checkpoint).map((n) => n.id));
    const shared = new Map<string, NodeResult>();
    const built = new Map<string, Table>();
    let anyFailed = false;
    // incremental inputs read by an output that committed a transaction, and by one that committed nothing
    const committedFrom = new Set<string>();
    const emptyFrom = new Set<string>();

    for (const job of jobs) {
      const current = await api<Build>(`/api/pipeline/builds/${buildId}`);
      if (current.cancel) {
        job.status = "cancelled";
        for (const j of jobs) if (j.status === "pending") j.status = "cancelled";
        log("warn", "Build cancelled");
        await flushLogs({ status: "cancelled", finished_at: now(), jobs });
        return;
      }
      if (!external) {
        lease = await queueLease(build.pipeline_id, job.profile, job.name, log, () => flushLogs({ jobs }), async () => !!(await api<Build>(`/api/pipeline/builds/${buildId}`)).cancel);
        if (lease === null) {
          job.status = "cancelled";
          for (const j of jobs) if (j.status === "pending") j.status = "cancelled";
          log("warn", "Build cancelled while waiting in the resource queue");
          await flushLogs({ status: "cancelled", finished_at: now(), jobs });
          return;
        }
      }
      job.status = "running";
      job.started_at = now();
      await flushLogs({ jobs });
      const jobOutputs = outputs.filter((o) => job.outputs.some((x) => x.id === o.id));

      // evaluate until no async value is missing (each round asks the API for what is missing)
      let ev = evaluator(live, sql, { services, watermarks: effectiveMarks, stores });
      for (let round = 0; round < 40 && !external && !duckdb; round++) {
        let pending = 0;
        for (const o of jobOutputs) pending += ev(o.node).pending ?? 0;
        if (!pending && !services.queue.size) break;
        log("info", `${job.name}: computing ${services.queue.size.toLocaleString()} values (LLM answers, extracted text, parsed files…)`);
        await flushLogs({ jobs });
        await services.flush();
        ev = evaluator(live, sql, { services, watermarks: effectiveMarks, stores });
      }
      const result = (ref: string): NodeResult => {
        const id = refNode(ref);
        if (checkpointIds.has(id) && shared.has(ref)) return shared.get(ref)!;
        const r = ev(ref);
        if (checkpointIds.has(id)) shared.set(ref, r);
        return r;
      };

      let jobFailed = false;
      for (const o of jobOutputs) {
        const run = job.outputs.find((x) => x.id === o.id)!;
        const started = Date.now();
        run.status = "running";
        try {
          if (duckdb) {
            if ((o.kind ?? "dataset") !== "dataset") throw new Error("The DuckDB local engine writes dataset outputs only");
            const mode = deployModeFields(o, "snapshot").mode;
            if (mode && mode !== "snapshot") throw new Error(`The DuckDB local engine writes snapshots: the write mode "${mode}" is not supported — use Default or Snapshot`);
            const onBranch = build.branch && build.branch !== "main";
            const stateKey = (onBranch ? `output:${o.id}@${build.branch}` : `output:${o.id}`) + setupSuffix;
            const prev = state[stateKey] as Written | undefined;
            const location = o.location ?? pipeline.location ?? { id: null, name: "Files & Projects" };
            const itemId = prev?.parentId !== undefined && (prev.parentId ?? null) === location.id ? (prev?.itemId ?? null) : null;
            const label = o.name.trim();
            await checkAccess([
              { op: "write", kind: "folder", id: location.id, label },
              ...(itemId ? [{ op: "write" as const, kind: "item" as const, id: itemId, label }] : []),
              ...Object.values(pipeline.datasets).flatMap(inputChecks),
            ]);
            const inputs = localInputs(pipeline);
            const check = async (sql: string, checkpoints: Checkpoint[]) => {
              const res = await duckdbCall<{ values: unknown[]; checkpoints?: CheckpointDone[] }>("/api/pipeline/duckdb/check", { pipeline_id: pipeline.id, sql, inputs, checkpoints });
              logCheckpoints(res.checkpoints);
              return res.values;
            };
            // pivot columns come from the data: their distinct values are read first (one row each)
            const opts = { local: true, pivotValues: await resolvePivotValues(pipeline, o, "duckdb", check, { local: true }) };
            const { sql: statement, checkpoints } = compileOutput(pipeline, o, "duckdb", opts);
            if (o.expectations?.length) {
              // checked before the write: one SELECT of counts over the output's statement
              const checks = compileExpectations(pipeline, o, "duckdb", o.expectations, opts);
              const values = await check(checks.sql, checks.checkpoints);
              run.expectations = checks.evaluate(Object.fromEntries(checks.aliases.map((k, i) => [k, values[i]])));
              for (const w of run.expectations.filter((x) => !x.ok && x.mode === "warn")) log("warn", `${o.name}: expectation (warn only) — ${w.message}`);
              const failedChecks = run.expectations.filter((x) => !x.ok && x.mode !== "warn");
              if (failedChecks.length) throw new Error(`Expectation failed: ${failedChecks.map((f) => f.message).join("; ")}`);
            }
            log("info", `${o.name}: running in DuckDB over ${Object.keys(inputs).length} input dataset${Object.keys(inputs).length === 1 ? "" : "s"}`);
            const res = await duckdbCall<{ item: DriveItemLite; rows: number; columns: number; transaction: string; written: number; checkpoints?: CheckpointDone[] }>("/api/pipeline/duckdb/run", {
              pipeline_id: pipeline.id,
              sql: statement,
              inputs,
              checkpoints,
              name: outputName(o.name).trim(),
              parent_id: location.id,
              item_id: itemId,
              output_id: o.id,
              output_name: label,
            });
            logCheckpoints(res.checkpoints);
            const w: Written = { rows: res.rows, columns: res.columns, itemId: res.item.id, parentId: res.item.parent_id, path: pathOf(res.item), transaction: res.transaction, written: res.written };
            await api(`/api/pipeline/state/${pipeline.id}`, {
              method: "PUT",
              body: JSON.stringify({ values: { [stateKey]: { ...w, at: now(), version: (prev?.version ?? 0) + 1, build: buildId, branch: build.branch } } }),
            });
            Object.assign(run, { status: "succeeded", path: w.path, itemId: w.itemId, rows: w.rows, columns: w.columns });
            log("info", `${o.name}: snapshot — ${w.rows.toLocaleString()} rows (${res.transaction})${w.path ? ` in ${w.path}` : ""}`);
            run.seconds = Math.round((Date.now() - started) / 100) / 10;
            await flushLogs({ jobs });
            continue;
          }
          if (external) {
            const v = o.virtualTable;
            const dialect = dialectOf(pipeline.external?.kind);
            if ((o.kind ?? "dataset") !== "virtualTable" || !v) throw new Error("External pipelines write virtual table outputs only");
            if (!dialect) throw new Error(`External pipelines run on Databricks or Snowflake, not ${pipeline.external?.kind ?? "this source"}`);
            if (build.branch && build.branch !== "main") {
              Object.assign(run, { status: "skipped", error: "Branches do not support virtual table outputs — merge to main to write it" });
              log("warn", `${o.name}: skipped on branch ${build.branch} (virtual table outputs build on main only)`);
              continue;
            }
            // run in the source as the build's identity: it reads and writes there through the connection
            await checkAccess([{ op: "write", kind: "connection", id: v.connectionId, label: o.name.trim() }]);
            // pivot columns come from the data: their distinct values are read in the warehouse first (one row each)
            const pivotValues = await resolvePivotValues(pipeline, o, dialect, async (sql) =>
              (await post<{ values: unknown[] }>("/api/pipeline/external/check", {
                pipeline_id: pipeline.id,
                connection_id: v.connectionId,
                sql,
                profile: settings.externalProfile ?? null,
                cluster_id: settings.clusterId ?? null,
                warehouse: settings.warehouse ?? null,
              })).values,
            );
            const { sql: statement } = compileOutput(pipeline, o, dialect, { pivotValues });
            const mode = deployModeFields(o, "snapshot").mode === "append" && !replay ? "append" : "snapshot";
            if (o.expectations?.length) {
              // checked in the warehouse before the write: one SELECT of counts over the output's query
              const checks = compileExpectations(pipeline, o, dialect, o.expectations, { pivotValues });
              const got = await post<{ values: unknown[] }>("/api/pipeline/external/check", {
                pipeline_id: pipeline.id,
                connection_id: v.connectionId,
                sql: checks.sql,
                profile: settings.externalProfile ?? null,
                cluster_id: settings.clusterId ?? null,
                warehouse: settings.warehouse ?? null,
              });
              run.expectations = checks.evaluate(Object.fromEntries(checks.aliases.map((k, i) => [k, got.values[i]])));
              for (const w of run.expectations.filter((x) => !x.ok && x.mode === "warn")) log("warn", `${o.name}: expectation (warn only) — ${w.message}`);
              const failedChecks = run.expectations.filter((x) => !x.ok && x.mode !== "warn");
              if (failedChecks.length) throw new Error(`Expectation failed: ${failedChecks.map((f) => f.message).join("; ")}`);
              log("info", `${o.name}: ${run.expectations.length} expectation${run.expectations.length === 1 ? "" : "s"} checked in the source`);
            }
            log("info", `${o.name}: running in ${dialect === "databricks" ? "Databricks" : "Snowflake"} (${mode === "append" ? "INSERT INTO" : "CREATE OR REPLACE TABLE"} ${[v.database, v.schema, v.table].filter(Boolean).join(".")})`);
            const res = await post<{ rows: number | null; table: string; columns: number | null; statement: string }>("/api/pipeline/external/run", {
              pipeline_id: pipeline.id,
              connection_id: v.connectionId,
              database: v.database,
              schema: v.schema,
              table: v.table,
              mode,
              sql: statement,
              profile: settings.externalProfile ?? null,
              cluster_id: settings.clusterId ?? null,
              warehouse: settings.warehouse ?? null,
            });
            Object.assign(run, { status: "succeeded", rows: res.rows ?? undefined, columns: res.columns ?? undefined, path: `${v.connectionName ?? pipeline.external?.connectionName ?? "source"} · ${res.table}` });
            log("info", `${o.name}: ${mode} — ${res.rows === null ? "rows not counted" : `${res.rows.toLocaleString()} rows`} in ${res.table}`);
            run.seconds = Math.round((Date.now() - started) / 100) / 10;
            await flushLogs({ jobs });
            continue;
          }
          const up = result(o.node);
          if (up.error !== undefined) throw new Error(up.error);
          if (up.pending) throw new Error(`${up.pending} values could not be computed`);
          const table = outputTable(o, up.table);
          run.rows = table.rows.length;
          run.columns = table.columns.length;
          run.expectations = checkExpectations(table, o.expectations);
          const failed = run.expectations.filter((x) => !x.ok && x.mode !== "warn");
          for (const w of run.expectations.filter((x) => !x.ok && x.mode === "warn")) log("warn", `${o.name}: expectation (warn only) — ${w.message}`);
          if (failed.length) throw new Error(`Expectation failed: ${failed.map((f) => f.message).join("; ")}`);
          built.set(o.id, table);
          const onBranch = build.branch && build.branch !== "main";
          if (onBranch && (o.kind ?? "dataset") === "virtualTable") {
            Object.assign(run, { status: "skipped", error: "Branches do not support virtual table outputs — merge to main to write it" });
            log("warn", `${o.name}: skipped on branch ${build.branch} (virtual table outputs build on main only)`);
            continue;
          }
          const stateKey = (onBranch ? `output:${o.id}@${build.branch}` : `output:${o.id}`) + setupSuffix;
          const prev = state[stateKey] as Written | undefined;
          const problems = writeModeProblems(o, table.columns);
          if (problems.length) throw new Error(problems.join("; "));
          // write mode: Default appends when every incremental input feeding the output only had rows added
          const incIds = incrementalInputs(pipeline, o.node);
          const fingerprint = statefulFingerprint(pipeline, o.node);
          const columnNames = table.columns.map((c) => c.name);
          if (incIds.length && prev && !replay) {
            if (prev.fingerprint !== undefined && prev.fingerprint !== fingerprint)
              throw new Error("Breaking change: the stateful transforms (aggregations, windows, pivots…) feeding this incremental output changed since the last deploy — deploy again with Replay from start of input data");
            const removed = (prev.columnNames ?? []).filter((c) => !columnNames.includes(c));
            if (removed.length) throw new Error(`Breaking change: ${removed.map((c) => `"${c}"`).join(", ")} removed from this incremental output — deploy again with Replay from start of input data`);
          }
          const snapshotted = incIds.filter((id) => recomputed.has(id));
          if (settings.requireIncremental && incIds.length && snapshotted.length && !replay)
            throw new Error(`Require incremental execution: ${snapshotted.map((id) => `"${pipeline.datasets[id]?.name ?? id}"`).join(", ")} was recomputed (a SNAPSHOT) since the last build, so this output cannot run incrementally`);
          const write: WriteFields = { ...deployModeFields(o, incIds.length && !snapshotted.length && !replay ? "append" : "snapshot"), reset: replay };
          // an incremental build with no rows commits nothing unless Commit empty transactions is on
          if (incIds.length && !table.rows.length && !settings.commitEmptyTransactions && !replay) {
            for (const id of incIds) emptyFrom.add(id);
            Object.assign(run, { status: "succeeded", rows: 0 });
            log("info", `${o.name}: no rows — nothing committed (its input rows are processed again next build; turn on Commit empty transactions to skip them)`);
          } else {
            const w = await writeOutput({ ...o, name: outputName(o.name) }, table, pipeline, prev, built, write);
            if (w.transaction === "APPEND") appendsThisBuild += 1;
            for (const id of incIds) committedFrom.add(id);
            const version = (prev?.version ?? 0) + 1;
            await api(`/api/pipeline/state/${pipeline.id}`, {
              method: "PUT",
              body: JSON.stringify({ values: { [stateKey]: { ...w, fingerprint, columnNames, at: now(), version, build: buildId, branch: build.branch } } }),
            });
            Object.assign(run, { status: "succeeded", path: w.path, itemId: w.itemId, rows: w.rows });
            const txn = w.transaction ? ` (${w.transaction}${w.written !== undefined && w.written !== w.rows ? ` of ${w.written.toLocaleString()} rows` : ""})` : "";
            log("info", `${o.name}: ${write.mode ?? "snapshot"} — ${w.rows.toLocaleString()} rows${txn}${w.path ? ` in ${w.path}` : ""}`);
          }
        } catch (e) {
          jobFailed = true;
          run.status = "failed";
          run.error = (e as Error).message;
          log("error", `${o.name}: ${run.error}`);
          if (e instanceof AccessDenied) {
            // the build's identity lost access: nothing more is read or written
            run.seconds = Math.round((Date.now() - started) / 100) / 10;
            job.status = "failed";
            job.finished_at = now();
            for (const x of job.outputs) if (x.status === "pending") x.status = "skipped";
            for (const j of jobs) if (j.status === "pending") j.status = "cancelled";
            throw Object.assign(e, { jobs });
          }
        }
        run.seconds = Math.round((Date.now() - started) / 100) / 10;
        await flushLogs({ jobs });
      }
      job.status = jobFailed ? "failed" : "succeeded";
      job.finished_at = now();
      await releaseLease(lease);
      lease = null;
      anyFailed ||= jobFailed;
      await flushLogs({ jobs });
    }

    // inputs only outputs that committed nothing read are processed again next build
    for (const id of emptyFrom) if (!committedFrom.has(id)) delete nextMarks[id];
    if (!anyFailed && Object.keys(nextMarks).length) await api(`/api/pipeline/state/${pipeline.id}`, { method: "PUT", body: JSON.stringify({ values: { [`watermarks${setupSuffix}`]: { ...watermarks, ...nextMarks } } }) });
    // the incremental inputs' schemas, so the next build replays on its own when one of them changes
    if (!anyFailed && incremental.size) {
      const schemas: Record<string, string> = {};
      for (const id of incremental) schemas[id] = (datasets[id]?.columns ?? []).map((c) => `${c.name}:${c.type}`).join(",");
      await api(`/api/pipeline/state/${pipeline.id}`, { method: "PUT", body: JSON.stringify({ values: { [`inputSchemas${setupSuffix}`]: schemas } }) });
    }
    if (!anyFailed && Object.keys(storeAdded).length) {
      await api(`/api/pipeline/state/${pipeline.id}`, { method: "PUT", body: JSON.stringify({ values: { [storesKey]: storeBook } }) });
      log("info", `Compute if expression absent: stored ${Object.entries(storeAdded).map(([id, n]) => `${n.toLocaleString()} new results in ${id}`).join(", ")}`);
    }
    if (!anyFailed && hasIncremental) {
      // a snapshot (regular or a replay) resets the counters; incremental builds add to them
      const book = replay ? { at: now(), builds: 0, appends: 0, last: snapshotReason ?? "replay" } : { ...snapBook, at: snapBook.at ?? now(), builds: (snapBook.builds ?? 0) + 1, appends: (snapBook.appends ?? 0) + appendsThisBuild };
      await api(`/api/pipeline/state/${pipeline.id}`, { method: "PUT", body: JSON.stringify({ values: { [snapKey]: book } }) });
    }
    const ok = jobs.filter((j) => j.status === "succeeded").length;
    log(anyFailed ? "error" : "info", `${ok}/${jobs.length} jobs succeeded${services.calls ? ` · ${services.calls.toLocaleString()} service calls` : ""}`);
    await flushLogs({ status: anyFailed ? "failed" : "succeeded", finished_at: now(), jobs, summary: { jobs: jobs.length, succeeded: ok, serviceCalls: services.calls, replay, ...(snapshotReason ? { regularSnapshot: snapshotReason } : {}) } });
  } catch (e) {
    await releaseLease(lease);
    const err = e as Error & { failureType?: string; jobs?: Job[] };
    const denied = e instanceof AccessDenied;
    await fail(denied ? `Stopped: ${err.message}` : err.failureType ? `Streaming job failed (${err.failureType}): ${err.message}` : `Build crashed: ${err.message}`, {
      failure_type: denied ? "persistent" : (err.failureType ?? (isTransient(err) ? "transient" : "persistent")),
      ...(err.jobs ? { jobs: err.jobs } : {}),
    }).catch(() => {});
  }
}
