"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, API_URL, type DbConnection } from "@/lib/api";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";

type TableType = "OBJECT" | "METADATA" | "CUSTOMIZATION";
type SourceTable = { tableName: string; datasetTransformsConfig?: { datasetName?: string; deduplicationComparisonColumns?: string[]; batchUnionComponents?: string[]; tableCleaningLibraries?: string[]; changeModeColumn?: string; enforceUniquePrimaryKeys?: boolean } };
type Instance = {
  id: string;
  name: string;
  source_type: string;
  source: { connection_id: string; database: string; schema: string; connection_name: string; connection_kind: string | null };
  repo: { id: string; name: string; template: unknown };
  folders: Record<"raw" | "metadata" | "output", { id: string; path: string }>;
  severed: boolean;
  migrated_to: string | null;
  status: string;
  progress: { at: string; message: string }[];
  error: string | null;
  source_config: { sourceName?: string; cleaningLibraries?: string[]; languageKey?: string; deploymentSemanticVersion?: number; tables?: SourceTable[] };
  pipeline_config: { outputFolder?: string; tables?: Record<string, { displayName?: string; types?: TableType[] }>; disableForeignKeyGeneration?: boolean; disableEnrichedStage?: boolean; disableRenamedStage?: boolean };
  pull_requests: { id: string; title: string; status: string; source: string }[];
  stages: { sync: { tables: number; synced: number; dictionary: boolean }; pipeline: { open_pull_requests: number; built: number; failed: number }; ontology: { object_types: number; link_types: number } };
  updated_at: string;
};
type ExTable = { name: string; comment?: string | null; rows?: number | null; role?: string; configured?: boolean; synced?: boolean; columns?: { name: string; type: string; comment?: string | null }[]; primary_key?: string[]; ordering?: string | null };
type Fk = { table: string; name: string; columns: string[]; ref_table: string; ref_columns: string[] };
type Plan = {
  object_types: { table: string; display_name: string; api_name: string; dataset: { id: string; name: string } | null; properties: number; state: string; object_type_id?: string }[];
  link_types: { from: string; to: string; foreign_key: string; state: string }[];
};
type Migration = { name: string; tables: { name: string; role: string }[]; notes: string[] };

async function req<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/sddi${path}`, {
    method,
    cache: "no-store",
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** HyperAuto V1 [Sunset] — the SDDI Cockpit (api/sddi.py). */
export default function SddiPage() {
  return (
    <Suspense fallback={null}>
      <Sddi />
    </Suspense>
  );
}

function Sddi() {
  const router = useRouter();
  const id = useSearchParams().get("id");
  const [list, setList] = useState<Instance[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => req<Instance[]>("").then(setList, (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  if (id) return <Cockpit id={id} onBack={() => (router.push("/sddi"), load())} />;
  return (
    <div className="mx-auto max-w-5xl p-6 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-xl font-semibold">Software Defined Data Integration</h1>
        <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs text-warn">HyperAuto V1 · Sunset</span>
        <button type="button" onClick={() => setCreating(true)} className={`${buttonClass.primary} ml-auto`}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Create new instance
        </button>
      </div>
      <p className="mb-4 text-xs text-muted">
        An SDDI instance ties a source to an automatic pipeline generator repository. Creating new V1 pipelines is discouraged: migrate to{" "}
        <Link href="/datasource" className="text-ocean hover:underline">
          HyperAuto V2
        </Link>{" "}
        (Cockpit → Migration).
      </p>
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      <ul className="space-y-2">
        {list?.map((x) => (
          <li key={x.id}>
            <Link href={`/sddi?id=${x.id}`} className="flex items-center gap-3 rounded-lg border border-line bg-panel p-3 hover:border-ocean">
              <Icon name="bolt" className="h-4 w-4 text-ocean" />
              <div>
                <div className="font-medium text-soft">{x.name}</div>
                <div className="text-xs text-muted">
                  {x.source_type} · {x.source.connection_name} {x.source.schema && `· ${x.source.schema}`} · {x.stages.sync.tables} tables
                  {x.severed && " · severed"}
                  {x.migrated_to && " · migrated to V2"}
                </div>
              </div>
              <span className="ml-auto text-xs text-muted">{when(x.updated_at)}</span>
            </Link>
          </li>
        ))}
        {list && !list.length && <li className="text-xs text-muted">No SDDI instances.</li>}
      </ul>
      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={(i) => router.push(`/sddi?id=${i.id}`)} />}
    </div>
  );
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (i: Instance) => void }) {
  const [conns, setConns] = useState<DbConnection[]>([]);
  const [f, setF] = useState({ repository_name: "", source_type: "GENERIC", connection_id: "", database: "", schema: "", source_name: "" });
  const [dbs, setDbs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.dataSources.connections().then(setConns, () => setConns([]));
  }, []);
  const pickConn = (id: string) => {
    setF((v) => ({ ...v, connection_id: id, database: "", schema: "" }));
    setDbs([]);
    setSchemas([]);
    if (id) api.dataSources.databases(id).then(setDbs, (e: Error) => setErr(e.message));
  };
  const pickDb = (d: string) => {
    setF((v) => ({ ...v, database: d, schema: "" }));
    setSchemas([]);
    if (d) api.dataSources.schemas(f.connection_id, d).then(setSchemas, () => setSchemas([]));
  };
  const submit = () => {
    setBusy(true);
    req<Instance>("", "POST", { ...f, source_name: f.source_name || null }).then(onCreated, (e: Error) => (setErr(e.message), setBusy(false)));
  };
  return (
    <Modal title="Create new SDDI instance" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Source type</span>
          <select value={f.source_type} onChange={(e) => setF({ ...f, source_type: e.target.value })} className={inputClass}>
            {["GENERIC", "SAP_ERP", "SALESFORCE", "ORACLE_NETSUITE"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Repository name</span>
          <input value={f.repository_name} onChange={(e) => setF({ ...f, repository_name: e.target.value })} className={inputClass} placeholder="sddi-erp" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Data Connection source</span>
          <select value={f.connection_id} onChange={(e) => pickConn(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {conns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind_name})
              </option>
            ))}
          </select>
        </label>
        {dbs.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Database</span>
            <select value={f.database} onChange={(e) => pickDb(e.target.value)} className={inputClass}>
              <option value="">Choose…</option>
              {dbs.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
        )}
        {schemas.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Schema</span>
            <select value={f.schema} onChange={(e) => setF({ ...f, schema: e.target.value })} className={inputClass}>
              <option value="">Choose…</option>
              {schemas.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Source name (prefixes primary and foreign keys)</span>
          <input value={f.source_name} onChange={(e) => setF({ ...f, source_name: e.target.value })} className={inputClass} placeholder="defaults to the connection name" />
        </label>
        <p className="text-xs text-muted">The raw, metadata and output folders are created under My Project / Datapipeline / &lt;repository name&gt;.</p>
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || !f.repository_name || !f.connection_id} onClick={submit} className={buttonClass.primary}>
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

type Step = "sync" | "pipeline" | "ontology" | "migration";

function Cockpit({ id, onBack }: { id: string; onBack: () => void }) {
  const [inst, setInst] = useState<Instance | null>(null);
  const [step, setStep] = useState<Step>("sync");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => req<Instance>(`/${id}`).then((i) => (setInst(i), setErr(null)), (e: Error) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);
  const busy = inst?.status === "syncing" || inst?.status === "building";
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [busy, load]);
  if (!inst) return <div className="p-6 text-sm text-muted">{err ?? "Loading…"}</div>;
  const s = inst.stages;
  const steps: { key: Step; label: string; status: string }[] = [
    { key: "sync", label: "Sync data", status: `${s.sync.synced}/${s.sync.tables} tables synced${s.sync.dictionary ? "" : " · no data dictionary"}` },
    { key: "pipeline", label: "Pipeline generation", status: `${s.pipeline.built} built${s.pipeline.failed ? ` · ${s.pipeline.failed} failed` : ""}${s.pipeline.open_pull_requests ? ` · ${s.pipeline.open_pull_requests} open PR` : ""}` },
    { key: "ontology", label: "Nexus changes", status: `${s.ontology.object_types} object types · ${s.ontology.link_types} link types` },
    { key: "migration", label: "Migration", status: inst.migrated_to ? "migrated to V2" : inst.severed ? "severed" : "V1" },
  ];
  return (
    <div className="flex h-full min-h-0 text-sm">
      <aside className="w-64 shrink-0 border-r border-line bg-panel p-4">
        <button type="button" onClick={onBack} className="mb-3 flex items-center gap-1 text-xs text-muted hover:text-soft">
          <Icon name="left" className="h-3.5 w-3.5" /> SDDI instances
        </button>
        <div className="mb-1 font-semibold">{inst.name}</div>
        <div className="mb-4 text-xs text-muted">
          {inst.source_type} · {inst.source.connection_name}
          {inst.source.schema && ` · ${inst.source.schema}`}
          <br />
          <Link href={`/code-repositories?repo=${inst.repo.id}`} className="text-ocean hover:underline">
            {inst.repo.name}
          </Link>
          {inst.severed && <span className="ml-1 text-warn">(severed)</span>}
        </div>
        <ol className="space-y-1">
          {steps.map((x, i) => (
            <li key={x.key}>
              <button type="button" onClick={() => setStep(x.key)} className={`w-full rounded-md p-2 text-left ${step === x.key ? "bg-ocean/10 text-soft" : "hover:bg-line/40"}`}>
                <div className="font-medium">
                  {i + 1}. {x.label}
                </div>
                <div className="text-xs text-muted">{x.status}</div>
              </button>
            </li>
          ))}
        </ol>
        <div className="mt-4 space-y-1 text-xs text-muted">
          {(["raw", "metadata", "output"] as const).map((k) => (
            <div key={k} className="truncate" title={inst.folders[k].path}>
              {k}: <span className="font-mono">{inst.folders[k].path}</span>
            </div>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-6">
        {err && <p className="mb-2 text-xs text-bad">{err}</p>}
        <Status inst={inst} />
        {step === "sync" && <SyncStep inst={inst} reload={load} />}
        {step === "pipeline" && <PipelineStep inst={inst} reload={load} />}
        {step === "ontology" && <OntologyStep inst={inst} reload={load} />}
        {step === "migration" && <MigrationStep inst={inst} reload={load} />}
      </main>
    </div>
  );
}

function Status({ inst }: { inst: Instance }) {
  if (!inst.progress.length && !inst.error) return null;
  return (
    <section className="mb-4 rounded-lg border border-line bg-panel p-3 text-xs">
      <div className="mb-1 flex items-center gap-2 font-medium">
        Status summary
        <span className={inst.status === "failed" ? "text-bad" : inst.status === "idle" ? "text-ok" : "text-ocean"}>{inst.status}</span>
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-auto font-mono text-muted">
        {inst.progress.map((p, i) => (
          <li key={i} className="whitespace-pre-wrap">
            {p.message}
          </li>
        ))}
      </ul>
      {inst.error && <p className="mt-1 whitespace-pre-wrap text-bad">{inst.error}</p>}
    </section>
  );
}

function PullRequests({ inst, reload }: { inst: Instance; reload: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const open = inst.pull_requests.filter((p) => p.status === "open");
  if (!open.length) return null;
  return (
    <section className="mb-4 rounded-lg border border-ocean/40 bg-ocean/5 p-3 text-xs">
      <div className="mb-1 font-medium">Open pull requests on {inst.repo.name}</div>
      {open.map((p) => (
        <div key={p.id} className="flex items-center gap-2 py-0.5">
          <span>
            #{p.id} {p.title}
          </span>
          <Link href={`/code-repositories?repo=${inst.repo.id}`} className="text-ocean hover:underline">
            Review
          </Link>
          <button type="button" onClick={() => req(`/${inst.id}/pulls/${p.id}/merge`, "POST").then(reload, (e: Error) => setErr(e.message))} className={`${buttonClass.secondary} ml-auto`}>
            Merge
          </button>
        </div>
      ))}
      {err && <p className="mt-1 text-bad">{err}</p>}
    </section>
  );
}

type Cart = Record<string, { transaction: "snapshot" | "incremental"; cursor: string; types: TableType[] }>;

function SyncStep({ inst, reload }: { inst: Instance; reload: () => void }) {
  const [tables, setTables] = useState<ExTable[] | null>(null);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"all" | "graph" | "cart" | "configured">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ table: ExTable; fks: Fk[] } | null>(null);
  const [preview, setPreview] = useState<{ columns: { name: string }[]; rows: Record<string, unknown>[] } | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [err, setErr] = useState<string | null>(null);
  // the lineage graph: tables on it, their positions, the schema's relations (loaded with the first table added)
  const [graph, setGraph] = useState<string[]>([]);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [fks, setFks] = useState<Fk[] | null>(null);
  const [history, setHistory] = useState<string[][]>([]);
  useEffect(() => {
    req<{ tables: ExTable[] }>(`/${inst.id}/explore`, "POST", {}).then((m) => setTables(m.tables), (e: Error) => setErr(e.message));
  }, [inst.id]);
  const toGraph = (names: string[]) => {
    const fresh = names.filter((n) => !graph.includes(n));
    if (!fresh.length) return;
    setHistory((h) => [...h, graph]);
    setGraph((g) => [...g, ...fresh]);
    setPos((p) => {
      const next = { ...p };
      fresh.forEach((n, i) => (next[n] = next[n] ?? { x: 30 + ((Object.keys(next).length + i) % 5) * 170, y: 30 + Math.floor((Object.keys(next).length + i) / 5) * 90 }));
      return next;
    });
    if (fks === null)
      req<{ foreign_keys: Fk[] }>(`/${inst.id}/explore`, "POST", { tables: [fresh[0]] }).then((m) => setFks(m.foreign_keys), (e: Error) => setErr(e.message));
  };
  const related = (name: string) => (fks ?? []).flatMap((f) => (f.table === name ? [f.ref_table] : f.ref_table === name ? [f.table] : []));
  const layout = () =>
    setPos(Object.fromEntries(graph.map((n, i) => [n, { x: 30 + (i % 5) * 170, y: 30 + Math.floor(i / 5) * 90 }])));
  const open = (name: string) => {
    setSelected(name);
    setDetail(null);
    setPreview(null);
    req<{ tables: ExTable[]; foreign_keys: Fk[] }>(`/${inst.id}/explore`, "POST", { tables: [name] }).then(
      (m) => setDetail({ table: m.tables[0], fks: m.foreign_keys.filter((f) => f.table === name || f.ref_table === name) }),
      (e: Error) => setErr(e.message),
    );
    req<{ columns: { name: string }[]; rows: Record<string, unknown>[] }>(`/${inst.id}/preview/${encodeURIComponent(name)}?limit=20`).then(setPreview, () => setPreview(null));
  };
  const add = (t: ExTable) => setCart((c) => ({ ...c, [t.name]: { transaction: "snapshot", cursor: "", types: [t.role === "enrichment" ? "CUSTOMIZATION" : "OBJECT"] } }));
  const shown = (tables ?? []).filter((t) => t.name.toLowerCase().includes(q.toLowerCase()) || (t.comment ?? "").toLowerCase().includes(q.toLowerCase()))
    .filter((t) => (mode === "cart" ? t.name in cart : mode === "configured" ? t.configured : mode === "graph" ? graph.includes(t.name) : true));
  const busy = inst.status === "syncing" || inst.status === "building";
  const submit = () =>
    req(`/${inst.id}/sync`, "POST", { tables: Object.entries(cart).map(([name, v]) => ({ name, transaction: v.transaction, cursor: v.cursor || null, types: v.types })) }).then(
      () => (setCart({}), reload()),
      (e: Error) => setErr(e.message),
    );
  return (
    <div>
      <PullRequests inst={inst} reload={reload} />
      <h2 className="mb-1 text-base font-semibold">Sync data</h2>
      <p className="mb-3 text-xs text-muted">
        Explore the source, add tables to the shopping cart, then Create syncs and integrate: the data dictionary is written into the metadata folder, each table gets a sync
        (an existing one is reused) and its data is copied into the raw folder, and a pull request adds new tables to the pipeline configuration.
      </p>
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      {graph.length > 0 && (
        <SourceGraph
          nodes={graph}
          pos={pos}
          fks={fks ?? []}
          selected={selected}
          inCart={(n) => n in cart}
          onMove={(n, x, y) => setPos((p) => ({ ...p, [n]: { x, y } }))}
          onOpen={open}
          onExpand={(n) => toGraph(related(n))}
          onRemove={(n) => (setHistory((h) => [...h, graph]), setGraph((g) => g.filter((x) => x !== n)))}
          onCart={(n) => {
            const t = tables?.find((x) => x.name === n);
            if (t) add(t);
          }}
          onLayout={layout}
          onUndo={history.length ? () => (setGraph(history[history.length - 1]), setHistory((h) => h.slice(0, -1))) : undefined}
        />
      )}
      <div className="grid grid-cols-[16rem_1fr_18rem] gap-3">
        <div className="rounded-lg border border-line bg-panel p-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tables…" className={`${inputClass} mb-2 text-xs`} />
          <div className="mb-2 flex gap-1 text-xs">
            {(["all", "graph", "cart", "configured"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-2 py-0.5 ${mode === m ? "bg-ocean/15 text-ocean" : "text-muted"}`}>
                {m === "all" ? "All" : m === "graph" ? "Graph" : m === "cart" ? "To sync" : "In pipeline"}
              </button>
            ))}
          </div>
          <ul className="max-h-[28rem] overflow-auto text-xs">
            {shown.map((t) => (
              <li key={t.name} className={`group flex items-center gap-1 rounded px-1.5 py-1 ${selected === t.name ? "bg-ocean/10" : "hover:bg-line/40"}`}>
                <button type="button" onClick={() => open(t.name)} className="min-w-0 flex-1 text-left">
                  <div className="truncate font-mono">{t.name}</div>
                  {t.comment && <div className="truncate text-muted">{t.comment}</div>}
                </button>
                {t.synced && <span title="Synced into the raw folder" className="text-ok">●</span>}
                <button type="button" onClick={() => toGraph([t.name])} disabled={graph.includes(t.name)} className="text-muted hover:text-ocean disabled:opacity-30" aria-label="Add to graph" title="Add to graph">
                  <Icon name="graph" className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => add(t)} disabled={t.name in cart} className="text-muted hover:text-ocean disabled:opacity-30" aria-label="Add to shopping cart">
                  <Icon name="plus" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            {!tables && <li className="text-muted">Loading…</li>}
          </ul>
        </div>
        <div className="min-w-0 rounded-lg border border-line bg-panel p-3 text-xs">
          {!selected && <p className="text-muted">Select a table to see its columns, keys, relations and a preview.</p>}
          {selected && !detail && <p className="text-muted">Loading {selected}…</p>}
          {detail && (
            <>
              <div className="mb-2 font-semibold">
                <span className="font-mono">{detail.table.name}</span> {detail.table.comment && <span className="font-normal text-muted">— {detail.table.comment}</span>}
              </div>
              <div className="mb-1 font-medium">Columns</div>
              <ul className="mb-3 grid grid-cols-2 gap-x-4">
                {detail.table.columns?.map((c) => (
                  <li key={c.name} className="flex gap-1">
                    {detail.table.primary_key?.includes(c.name) && <span title="Primary key" className="text-warn">⚿</span>}
                    <span className="font-mono">{c.name}</span>
                    <span className="text-muted">{c.type}</span>
                    {c.comment && <span className="truncate text-muted">· {c.comment}</span>}
                  </li>
                ))}
              </ul>
              <div className="mb-1 font-medium">Relations</div>
              <ul className="mb-3">
                {detail.fks.map((f) => (
                  <li key={f.name} className="font-mono">
                    {f.table}({f.columns.join(", ")}) → <button type="button" onClick={() => open(f.table === detail.table.name ? f.ref_table : f.table)} className="text-ocean hover:underline">{f.ref_table}</button>({f.ref_columns.join(", ")})
                  </li>
                ))}
                {!detail.fks.length && <li className="text-muted">None declared.</li>}
              </ul>
              {preview && (
                <div className="overflow-auto">
                  <table className="text-xs">
                    <thead>
                      <tr>
                        {preview.columns.map((c) => (
                          <th key={c.name} className="border-b border-line px-2 py-1 text-left font-mono">
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, i) => (
                        <tr key={i}>
                          {preview.columns.map((c) => (
                            <td key={c.name} className="border-b border-line-2 px-2 py-0.5 font-mono">
                              {r[c.name] == null ? <span className="text-muted">null</span> : String(r[c.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
        <div className="rounded-lg border border-line bg-panel p-3 text-xs">
          <div className="mb-1 font-medium">Shopping cart</div>
          <p className="mb-2 text-muted">
            Target folder: <span className="font-mono">{inst.folders.raw.path}</span>
          </p>
          <ul className="mb-2 space-y-2">
            {Object.entries(cart).map(([name, v]) => {
              const t = tables?.find((x) => x.name === name);
              return (
                <li key={name} className="rounded border border-line-2 p-2">
                  <div className="flex items-center gap-1">
                    <span className="font-mono">{name}</span>
                    <span className="text-muted">{t?.synced ? "update extract" : "create extract"}</span>
                    <button type="button" onClick={() => setCart((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== name)))} className="ml-auto text-muted hover:text-bad" aria-label="Remove">
                      <Icon name="x" className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-1 flex gap-1">
                    <select value={v.transaction} onChange={(e) => setCart({ ...cart, [name]: { ...v, transaction: e.target.value as "snapshot" | "incremental" } })} className={`${inputClass} text-xs`}>
                      <option value="snapshot">Snapshot</option>
                      <option value="incremental">Incremental</option>
                    </select>
                    <select value={v.types[0]} onChange={(e) => setCart({ ...cart, [name]: { ...v, types: [e.target.value as TableType] } })} className={`${inputClass} text-xs`}>
                      {(["OBJECT", "CUSTOMIZATION", "METADATA"] as const).map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </div>
                  {v.transaction === "incremental" && (
                    <input value={v.cursor} onChange={(e) => setCart({ ...cart, [name]: { ...v, cursor: e.target.value } })} placeholder="cursor column (guessed when empty)" className={`${inputClass} mt-1 text-xs`} />
                  )}
                </li>
              );
            })}
            {!Object.keys(cart).length && <li className="text-muted">Add tables with +.</li>}
          </ul>
          <button type="button" disabled={busy || !Object.keys(cart).length} onClick={submit} className={`${buttonClass.primary} w-full justify-center`}>
            {inst.status === "syncing" ? "Syncing…" : "Create syncs and integrate"}
          </button>
        </div>
      </div>
    </div>
  );
}

type TableForm = { display_name: string; types: TableType[]; dedup: string; change_mode_column: string; unions: string; libs: string; unique: boolean };

function PipelineStep({ inst, reload }: { inst: Instance; reload: () => void }) {
  const initial = useMemo(() => {
    const out: Record<string, TableForm> = {};
    for (const t of inst.source_config.tables ?? []) {
      const tc = t.datasetTransformsConfig ?? {};
      const pt = inst.pipeline_config.tables?.[t.tableName] ?? {};
      out[t.tableName] = {
        display_name: pt.displayName ?? t.tableName,
        types: pt.types ?? ["OBJECT"],
        dedup: (tc.deduplicationComparisonColumns ?? []).join(", "),
        change_mode_column: tc.changeModeColumn ?? "",
        unions: (tc.batchUnionComponents ?? []).join(", "),
        libs: (tc.tableCleaningLibraries ?? []).join(", "),
        unique: !!tc.enforceUniquePrimaryKeys,
      };
    }
    return out;
  }, [inst.source_config, inst.pipeline_config]);
  const [forms, setForms] = useState(initial);
  const [globalLibs, setGlobalLibs] = useState((inst.source_config.cleaningLibraries ?? []).join(", "));
  const [flags, setFlags] = useState({
    disable_foreign_key_generation: !!inst.pipeline_config.disableForeignKeyGeneration,
    disable_enriched_stage: !!inst.pipeline_config.disableEnrichedStage,
    disable_renamed_stage: !!inst.pipeline_config.disableRenamedStage,
  });
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const propose = () =>
    req<{ pull_request: { id: string } }>(`/${inst.id}/pipeline`, "POST", {
      tables: Object.fromEntries(
        Object.entries(forms).map(([n, f]) => [
          n,
          { display_name: f.display_name, types: f.types, deduplication_comparison_columns: split(f.dedup), change_mode_column: f.change_mode_column || null, batch_union_components: split(f.unions), table_cleaning_libraries: split(f.libs), enforce_unique_primary_keys: f.unique },
        ]),
      ),
      cleaning_libraries: split(globalLibs),
      ...flags,
    }).then(
      (r) => (setNote(`Opened pull request #${r.pull_request.id}`), setErr(null), reload()),
      (e: Error) => setErr(e.message),
    );
  const busy = inst.status === "syncing" || inst.status === "building";
  const setF = (n: string, patch: Partial<TableForm>) => setForms({ ...forms, [n]: { ...forms[n], ...patch } });
  return (
    <div>
      <PullRequests inst={inst} reload={reload} />
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-base font-semibold">Pipeline generation</h2>
        <button type="button" disabled={busy} onClick={() => req(`/${inst.id}/build`, "POST").then(reload, (e: Error) => setErr(e.message))} className={`${buttonClass.primary} ml-auto`}>
          <Icon name="play" className="h-3.5 w-3.5" /> {inst.status === "building" ? "Building…" : "Build pipeline"}
        </button>
        <Link href={`/lineage?item=${inst.folders.output.id}`} className={buttonClass.secondary}>
          Data lineage
        </Link>
      </div>
      <p className="mb-3 text-xs text-muted">
        Changes are proposed as a pull request on <span className="font-mono">transforms-bellhop/src/config</span> (SourceConfig.yaml, PipelineConfig.yaml). Build runs every generated
        transform on the default branch: metadata → cleaned → enriched → final → renamed → BUILD. Cleaning libraries are functions of{" "}
        <span className="font-mono">function_libraries.py</span> (add your own there).
      </p>
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      {note && <p className="mb-2 text-xs text-ok">{note}</p>}
      {inst.severed && <p className="mb-2 text-xs text-warn">The repository is severed: edit its configuration files in the repository instead.</p>}
      <div className="overflow-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              {["Table", "Display name", "Types", "Dedup comparison columns", "Change mode column", "Batch union components", "Table cleaning libraries", "Unique keys"].map((h) => (
                <th key={h} className="border-b border-line px-2 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(forms).map(([n, f]) => (
              <tr key={n}>
                <td className="border-b border-line-2 px-2 py-1 font-mono">{n}</td>
                <td className="border-b border-line-2 px-2 py-1">
                  <input value={f.display_name} onChange={(e) => setF(n, { display_name: e.target.value })} className={`${inputClass} text-xs`} />
                </td>
                <td className="border-b border-line-2 px-2 py-1">
                  {(["OBJECT", "METADATA", "CUSTOMIZATION"] as const).map((t) => (
                    <label key={t} className="mr-2 inline-flex items-center gap-1">
                      <input type="checkbox" checked={f.types.includes(t)} onChange={(e) => setF(n, { types: e.target.checked ? [...f.types, t] : f.types.filter((x) => x !== t) })} />
                      {t[0] + t.slice(1).toLowerCase()}
                    </label>
                  ))}
                </td>
                {(["dedup", "change_mode_column", "unions", "libs"] as const).map((k) => (
                  <td key={k} className="border-b border-line-2 px-2 py-1">
                    <input value={f[k]} onChange={(e) => setF(n, { [k]: e.target.value })} className={`${inputClass} text-xs`} />
                  </td>
                ))}
                <td className="border-b border-line-2 px-2 py-1 text-center">
                  <input type="checkbox" checked={f.unique} onChange={(e) => setF(n, { unique: e.target.checked })} />
                </td>
              </tr>
            ))}
            {!Object.keys(forms).length && (
              <tr>
                <td colSpan={8} className="px-2 py-3 text-muted">
                  No tables yet: sync tables first (and merge their pull request).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1">
          Cleaning libraries (every table)
          <input value={globalLibs} onChange={(e) => setGlobalLibs(e.target.value)} className={`${inputClass} w-72 text-xs`} />
        </label>
        {(
          [
            ["disable_foreign_key_generation", "Disable foreign key generation"],
            ["disable_enriched_stage", "Disable enriched stage"],
            ["disable_renamed_stage", "Disable renamed stage"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-1">
            <input type="checkbox" checked={flags[k]} onChange={(e) => setFlags({ ...flags, [k]: e.target.checked })} /> {label}
          </label>
        ))}
        <button type="button" disabled={inst.severed || !Object.keys(forms).length} onClick={propose} className={`${buttonClass.primary} ml-auto`}>
          Open pull request
        </button>
      </div>
    </div>
  );
}

function OntologyStep({ inst, reload }: { inst: Instance; reload: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => req<Plan>(`/${inst.id}/ontology`).then(setPlan, (e: Error) => setErr(e.message)), [inst.id]);
  useEffect(() => {
    load();
  }, [load]);
  const apply = () => {
    setBusy(true);
    req<Plan>(`/${inst.id}/ontology`, "POST", {}).then(
      (p) => (setPlan(p), setBusy(false), reload()),
      (e: Error) => (setErr(e.message), setBusy(false)),
    );
  };
  const ready = (plan?.object_types.filter((o) => o.state === "ready").length ?? 0) + (plan?.link_types.filter((l) => l.state === "ready").length ?? 0);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-base font-semibold">Nexus changes</h2>
        <button type="button" disabled={busy || !ready} onClick={apply} className={`${buttonClass.primary} ml-auto`}>
          Create {ready} in bulk
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">Object types for the OBJECT tables (keyed by the generated primary_key, backed by their built datasets) and link types for the foreign keys between them.</p>
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      <div className="rounded-lg border border-line bg-panel p-3 text-xs">
        <div className="mb-1 font-medium">Object types</div>
        <ul className="mb-3 space-y-1">
          {plan?.object_types.map((o) => (
            <li key={o.table} className="flex items-center gap-2">
              <span className="font-medium">{o.display_name}</span>
              <span className="font-mono text-muted">{o.api_name}</span>
              <span className="text-muted">
                {o.table} · {o.dataset ? `${o.properties} columns` : "no dataset"}
              </span>
              <span className={`ml-auto ${o.state === "ready" ? "text-ocean" : o.state === "created" ? "text-ok" : "text-muted"}`}>{o.state}</span>
              {o.object_type_id && (
                <Link href={`/ontology?type=${o.object_type_id}`} className="text-ocean hover:underline">
                  Open
                </Link>
              )}
            </li>
          ))}
          {plan && !plan.object_types.length && <li className="text-muted">No OBJECT tables.</li>}
        </ul>
        <div className="mb-1 font-medium">Link types</div>
        <ul className="space-y-1">
          {plan?.link_types.map((l) => (
            <li key={`${l.from}-${l.to}-${l.foreign_key}`} className="flex gap-2">
              <span className="font-mono">
                {l.from} → {l.to}
              </span>
              <span className="text-muted">{l.foreign_key}</span>
              <span className={`ml-auto ${l.state === "ready" ? "text-ocean" : "text-ok"}`}>{l.state}</span>
            </li>
          ))}
          {plan && !plan.link_types.length && <li className="text-muted">None (build the pipeline with foreign keys first).</li>}
        </ul>
      </div>
    </div>
  );
}

function MigrationStep({ inst, reload }: { inst: Instance; reload: () => void }) {
  const [plan, setPlan] = useState<Migration | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [v2, setV2] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    req<Migration>(`/${inst.id}/migration`).then(setPlan, (e: Error) => setErr(e.message));
  }, [inst.id]);
  const migrate = () => req<{ v2: { id: string; name: string } }>(`/${inst.id}/migrate`, "POST", {}).then((r) => (setV2(r.v2), reload()), (e: Error) => setErr(e.message));
  const sever = async () => {
    if (!(await confirmDialog({ title: "Sever the repository?", message: "It becomes a regular Python transforms repository and the Cockpit stops opening pull requests for it. This cannot be undone.", confirmLabel: "Sever" }))) return;
    req(`/${inst.id}/sever`, "POST").then(reload, (e: Error) => setErr(e.message));
  };
  return (
    <div className="max-w-3xl">
      <h2 className="mb-1 text-base font-semibold">Migrating to HyperAuto V2</h2>
      <p className="mb-3 text-xs text-muted">
        Create a V2 pipeline that replicates this configuration and consumes the same syncs, then point downstream consumers at its outputs gradually. The V1 repository keeps
        running.
      </p>
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      {plan && (
        <div className="mb-4 rounded-lg border border-line bg-panel p-3 text-xs">
          <div className="mb-1 font-medium">{plan.name}</div>
          <div className="mb-2 text-muted">{plan.tables.map((t) => `${t.name} (${t.role})`).join(", ") || "No tables"}</div>
          <div className="mb-1 font-medium">Not carried over</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted">
            {plan.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" disabled={!plan?.tables.length} onClick={migrate} className={buttonClass.primary}>
          Create V2 pipeline
        </button>
        {(v2 || inst.migrated_to) && (
          <Link href="/datasource" className="text-xs text-ocean hover:underline">
            {v2 ? `Created ${v2.name}` : "Migrated"} — open HyperAuto V2
          </Link>
        )}
        <button type="button" disabled={inst.severed} onClick={sever} className={`${buttonClass.secondary} ml-auto`}>
          {inst.severed ? "Severed" : "Sever from template"}
        </button>
      </div>
    </div>
  );
}

/** Source exploration's lineage graph: tables as draggable nodes, the source's relations as edges. */
function SourceGraph({
  nodes,
  pos,
  fks,
  selected,
  inCart,
  onMove,
  onOpen,
  onExpand,
  onRemove,
  onCart,
  onLayout,
  onUndo,
}: {
  nodes: string[];
  pos: Record<string, { x: number; y: number }>;
  fks: Fk[];
  selected: string | null;
  inCart: (n: string) => boolean;
  onMove: (n: string, x: number, y: number) => void;
  onOpen: (n: string) => void;
  onExpand: (n: string) => void;
  onRemove: (n: string) => void;
  onCart: (n: string) => void;
  onLayout: () => void;
  onUndo?: () => void;
}) {
  const [drag, setDrag] = useState<{ n: string; dx: number; dy: number } | null>(null);
  const W = 150;
  const H = 52;
  const edges = fks.filter((f) => nodes.includes(f.table) && nodes.includes(f.ref_table) && f.table !== f.ref_table);
  const height = Math.max(220, ...nodes.map((n) => (pos[n]?.y ?? 0) + H + 30));
  return (
    <div className="mb-3 rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        <span className="font-medium">Lineage graph</span>
        <span className="text-muted">
          {nodes.length} tables · {edges.length} relations · drag to arrange, click to inspect
        </span>
        <button type="button" onClick={onLayout} className="ml-auto text-ocean hover:underline">
          Layout
        </button>
        {onUndo && (
          <button type="button" onClick={onUndo} className="text-ocean hover:underline">
            Undo
          </button>
        )}
      </div>
      <svg
        width="100%"
        height={height}
        onPointerMove={(e) => {
          if (!drag) return;
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          onMove(drag.n, Math.max(0, e.clientX - r.left - drag.dx), Math.max(0, e.clientY - r.top - drag.dy));
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {edges.map((f) => {
          const a = pos[f.table];
          const b = pos[f.ref_table];
          if (!a || !b) return null;
          return (
            <g key={f.name}>
              <line x1={a.x + W / 2} y1={a.y + H / 2} x2={b.x + W / 2} y2={b.y + H / 2} stroke="currentColor" className="text-ocean/50" strokeWidth={1.5} />
              <title>{`${f.table}(${f.columns.join(", ")}) → ${f.ref_table}(${f.ref_columns.join(", ")})`}</title>
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos[n] ?? { x: 0, y: 0 };
          return (
            <g key={n} transform={`translate(${p.x},${p.y})`}>
              <rect
                width={W}
                height={H}
                rx={8}
                className={`cursor-move ${selected === n ? "fill-ocean/20 stroke-ocean" : "fill-panel-2 stroke-line-2"}`}
                strokeWidth={1.5}
                onPointerDown={(e) => {
                  const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setDrag({ n, dx: e.clientX - r.left - p.x, dy: e.clientY - r.top - p.y });
                }}
                onClick={() => onOpen(n)}
              />
              <text x={10} y={20} className="pointer-events-none fill-current text-[12px] font-mono">
                {n.length > 18 ? `${n.slice(0, 17)}…` : n}
              </text>
              <text x={10} y={40} className="cursor-pointer fill-current text-[10px] text-ocean" onClick={() => onExpand(n)}>
                + related
              </text>
              <text x={66} y={40} className={`cursor-pointer fill-current text-[10px] ${inCart(n) ? "text-ok" : "text-ocean"}`} onClick={() => onCart(n)}>
                {inCart(n) ? "in cart" : "+ cart"}
              </text>
              <text x={W - 16} y={16} className="cursor-pointer fill-current text-[11px] text-muted" onClick={() => onRemove(n)}>
                ×
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
