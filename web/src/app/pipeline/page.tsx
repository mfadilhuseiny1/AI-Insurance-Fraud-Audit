"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { AppHome } from "@/components/AppHome";
import { Icon, type IconName } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Tabs } from "@/components/pipeline/ui";
import { api, API_URL, type DbConnection, type DriveItem } from "@/lib/api";
import { when } from "@/lib/format";
import { COL_TYPES, deletePipeline, loadPipeline, type BatchCompute, type ColType, type DriveLocation, type PipelineSummary, type PipelineType, type Table } from "@/lib/pipeline";
import { streaming, type IngestStream } from "@/lib/streaming";
import { createPipelineFile, moveToFiles, pathOf, pipelineName, TOP_LEVEL } from "@/lib/pipelineFiles";
import { usePipelineList } from "@/lib/usePipelines";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

type Summary = {
  id: string;
  type: PipelineType;
  compute: BatchCompute;
  external?: string | null;
  nodes: number;
  outputs: number;
  schedules: number;
  branches: number;
  openProposals: number;
  description?: string | null;
  lastBuild: { id: string; status: string; at: string; trigger: string } | null;
  streaming: boolean;
};

const FAVORITES = "bluesandai.pipeline.favorites";
const favListeners = new Set<() => void>();
let favCache: { raw: string | null; set: Set<string> } = { raw: null, set: new Set() };
function readFavs(): Set<string> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(FAVORITES);
  } catch {}
  if (raw !== favCache.raw) {
    let list: string[] = [];
    try {
      list = JSON.parse(raw ?? "[]");
    } catch {}
    favCache = { raw, set: new Set(list) };
  }
  return favCache.set;
}
const EMPTY_FAVS = new Set<string>();
function useFavorites(): [Set<string>, (id: string) => void] {
  const favs = useSyncExternalStore(
    (cb) => {
      favListeners.add(cb);
      return () => favListeners.delete(cb);
    },
    readFavs,
    () => EMPTY_FAVS,
  );
  const toggle = (id: string) => {
    const next = new Set(readFavs());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      localStorage.setItem(FAVORITES, JSON.stringify([...next]));
    } catch {}
    favCache = { raw: JSON.stringify([...next]), set: next };
    favListeners.forEach((l) => l());
  };
  return [favs, toggle];
}

const backendLabel = (s?: Summary) =>
  !s ? "" : s.type === "device" ? "Device flow" : s.type === "streaming" ? "Streaming (Flink-style)" : s.compute === "faster" ? "Faster batch (DataFusion-style)" : s.compute === "external" ? `External · ${s.external ?? "source"}` : "Standard batch (Spark-style)";

export default function PipelinesPage() {
  const router = useRouter();
  const [files, setFiles] = useState<DriveItem[] | null>(null);
  const [summaries, setSummaries] = useState<Map<string, Summary>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // Start pipelining from a stream (Streaming app): /pipeline?new=streaming&ingest=<stream id>
  const [fromStream, setFromStream] = useState<IngestStream | null>(null);
  // /pipeline?new=device (Platform Apps → Device Streams, the Node-RED editor) or ?new=batch|streaming: the create
  // dialog opens with that type chosen
  const [newType, setNewType] = useState<"batch" | "streaming" | "device" | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("ingest");
    if (id) streaming.stream(id).then(setFromStream, (e: Error) => setError(e.message));
    const t = q.get("new");
    if (!id && (t === "batch" || t === "streaming" || t === "device")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the link that opened the page
      setNewType(t);
      setCreating(true);
    }
  }, []);
  // "tests": test and bug-hunting pipelines ("test" in the name or a folder above it), kept out of "all"
  const [filter, setFilter] = useState<"all" | "favorites" | "tests">("all");
  const [favs, toggleFav] = useFavorites();
  // pipelines kept in this browser before pipelines became files
  const local = usePipelineList();
  const [moving, setMoving] = useState<PipelineSummary | null>(null);

  const load = useCallback(() => {
    api.pipelineData
      .files()
      .then((f) => {
        setFiles(f);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    fetch(`${API_URL}/api/pipeline/summaries`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Summary[]) => setSummaries(new Map(list.map((s) => [s.id, s]))))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const remove = async (item: DriveItem) => {
    if (!(await confirmDialog(`Move the pipeline "${pipelineName(item.name)}" to the trash? It can be restored from Files & Projects → Trash.`))) return;
    try {
      await api.drive.trash(item.id);
      load();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };

  const isTest = (f: DriveItem) => !!(f as DriveItem & { test?: boolean }).test;
  const shown = useMemo(
    () => (files ? files.filter((f) => (filter === "tests" ? isTest(f) : filter === "favorites" ? favs.has(f.id) : !isTest(f))) : null),
    [files, filter, favs],
  );
  const total = (k: "nodes" | "outputs") => (shown ?? []).reduce((n, f) => n + (summaries.get(f.id)?.[k] ?? 0), 0);
  const buildTone = (st: string) => (st === "succeeded" ? ("ok" as const) : st === "failed" ? ("bad" as const) : st === "running" || st === "queued" ? ("ocean" as const) : ("muted" as const));

  return (
    <>
      <AppHome
        app="Pipeline Builder"
        icon="pipeline"
        accent="#ea580c"
        href="/pipeline"
        tagline="Build data pipelines: bring data in, transform and check it, and deploy datasets and Nexus outputs."
        description={
          <>
            Bring in parsed documents, files, databases, media and streams; clean, join and enrich them with transforms, LLMs and models; check them with expectations and unit
            tests; and deploy datasets, Nexus outputs, files and virtual tables — on schedules, with branches and proposals. Each pipeline is a file in{" "}
            <Link href="/files" className="text-ocean hover:underline">
              Files &amp; Projects
            </Link>
            .
          </>
        }
        headerActions={
          <button type="button" onClick={() => setGuideOpen(true)} className={buttonClass.ghost}>
            <Icon name="info" /> Builder guide
          </button>
        }
        noun={filter === "favorites" ? ["favorite pipeline", "favorite pipelines"] : filter === "tests" ? ["test pipeline", "test pipelines"] : ["pipeline", "pipelines"]}
        error={error ? `Could not list the pipelines: ${error}` : null}
        items={
          shown?.map((f) => {
            const s = summaries.get(f.id);
            const fav = favs.has(f.id);
            return {
              id: f.id,
              href: `/pipeline/${f.id}`,
              title: pipelineName(f.name),
              path: (f.path ?? []).map((x) => x.name),
              updated_at: f.updated_at,
              icon: s?.type === "device" ? ("signal" as const) : s?.type === "streaming" ? ("wave" as const) : ("pipeline" as const),
              detail: s
                ? `${backendLabel(s)} · ${s.nodes} nodes · ${s.outputs} outputs${s.schedules ? ` · ${s.schedules} schedules` : ""}${s.branches > 1 ? ` · ${s.branches} branches` : ""}${s.openProposals ? ` · ${s.openProposals} open proposals` : ""}`
                : undefined,
              badges: [
                s?.lastBuild ? { label: s.lastBuild.status, tone: buildTone(s.lastBuild.status) } : { label: "not deployed", tone: "muted" as const },
                ...(fav ? [{ label: "★ favorite", tone: "sand" as const }] : []),
                ...(isTest(f) ? [{ label: "uji", tone: "muted" as const }] : []),
                ...(s?.type === "streaming" ? [s.streaming ? { label: "stream running", tone: "ok" as const } : { label: "stream stopped", tone: "muted" as const }] : []),
              ],
              actions: (
                <ActionMenu
                  items={[
                    { label: "Open", icon: "external", onClick: () => router.push(`/pipeline/${f.id}`) },
                    { label: fav ? "Remove from favorites" : "Add to favorites", icon: "star", onClick: () => toggleFav(f.id) },
                    ...(s?.lastBuild ? [{ label: `Last build (${s.lastBuild.trigger}, ${when(s.lastBuild.at)})`, icon: "play" as const, onClick: () => router.push(`/pipeline/${f.id}/builds/${s.lastBuild!.id}`) }] : []),
                    { label: `Open location: ${pathOf(f)}`, icon: "folder", onClick: () => router.push(f.parent_id ? `/files/${f.parent_id}` : "/files") },
                    "divider",
                    { label: "Move to trash", icon: "trash", danger: true, onClick: () => remove(f) },
                  ]}
                />
              ),
            };
          }) ?? null
        }
        empty={
          filter === "favorites"
            ? { title: "No favorites yet", hint: "Star a pipeline to find it here." }
            : filter === "tests"
              ? { title: "Tidak ada pipeline uji", hint: "Pipeline uji & bug — nama atau proyeknya berisi “(test)” — muncul di sini, terpisah dari demo." }
            : { title: "Create your first pipeline", hint: "It is saved as a file in Files & Projects.", steps: ["Pick a batch, streaming or device pipeline", "Add inputs and transforms", "Add outputs and deploy"] }
        }
        create={
          <>
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New pipeline
            </button>
            {files !== null && files.length > 0 && (
              <Tabs
                value={filter}
                onChange={setFilter}
                tabs={[
                  { id: "all", label: "All pipelines", badge: files.filter((f) => !isTest(f)).length },
                  { id: "favorites", label: "Favorites", badge: files.filter((f) => favs.has(f.id)).length },
                  { id: "tests", label: "Uji & bug", badge: files.filter(isTest).length },
                ]}
              />
            )}
            {files !== null && files.length > 0 && (
              <div className="ml-auto flex flex-wrap gap-2 text-xs text-muted">
                <span className="rounded-lg border border-line bg-ink/40 px-2.5 py-1">
                  <span className="font-semibold text-strong">{total("nodes")}</span> graph nodes
                </span>
                <span className="rounded-lg border border-line bg-ink/40 px-2.5 py-1">
                  <span className="font-semibold text-strong">{total("outputs")}</span> outputs
                </span>
                <span className="rounded-lg border border-line bg-ink/40 px-2.5 py-1" title="Latest deployment passed">
                  <span className="font-semibold text-ok">{[...summaries.values()].filter((s) => s.lastBuild?.status === "succeeded").length}</span> healthy builds
                </span>
              </div>
            )}
          </>
        }
      >
        {!!local?.length && (
          <div>
            <h2 className="text-sm font-semibold">In this browser only</h2>
            <p className="mt-1 text-xs text-muted">Created before pipelines became files. Move them to Files &amp; Projects to keep editing them.</p>
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
              {local.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon name="pipeline" className="h-4 w-4 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-xs text-muted">{when(p.updatedAt)}</span>
                  <button type="button" onClick={() => setMoving(p)} className={buttonClass.secondary}>
                    Move to Files
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </AppHome>

      {(creating || fromStream) && (
        <CreatePipelineDialog
          initial={
            fromStream
              ? { name: `${fromStream.name} pipeline`, type: "streaming", note: `Input: ingest stream "${fromStream.name}"` }
              : newType
                ? { name: newType === "device" ? "Device flow" : "Pipeline", type: newType }
                : undefined
          }
          onClose={() => (setCreating(false), setFromStream(null), setNewType(null))}
          onCreate={async (name, type, location, extra) => {
            const inputs =
              fromStream && type === "streaming"
                ? [
                    await streaming.records(fromStream.id, 0, 1000).then(
                      (r) => ({
                        name: fromStream.name,
                        origin: `Ingest stream ${fromStream.name} (Streaming app)`,
                        table: { columns: r.columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType })), rows: r.rows as Table["rows"] },
                        ref: { kind: "ingest" as const, streamId: fromStream.id },
                      }),
                    ),
                  ]
                : undefined;
            const item = await createPipelineFile(name, type, location, { ...extra, inputs });
            router.push(`/pipeline/${item.id}`);
          }}
        />
      )}
      {moving && (
        <LocationDialog
          title={`Move "${moving.name}" to Files — pick where its folder goes`}
          action="Move here"
          onClose={() => setMoving(null)}
          onPick={async (location) => {
            const p = loadPipeline(moving.id);
            if (!p) throw new Error("The pipeline is missing from this browser");
            const item = await moveToFiles(p, location);
            deletePipeline(moving.id);
            setMoving(null);
            router.push(`/pipeline/${item.id}`);
          }}
        />
      )}
      {guideOpen && <PipelineGuide onClose={() => setGuideOpen(false)} />}
    </>
  );
}

function PipelineGuide({ onClose }: { onClose: () => void }) {
  const workflow = [
    ["1. Inputs", "Add datasets from Files & Projects, Data Connection, uploads, generated data, media, streams, or manually entered tables.", "table"],
    ["2. Transform", "Compose type-safe nodes for filters, projections, joins, unions, aggregates, parsing, geospatial work, media, models, and LLMs.", "transform"],
    ["3. Preview", "Inspect sampled records and schemas as you build. Expression validation and strict output checks catch issues before compute runs.", "eye"],
    ["4. Deliver", "Build healthy outputs on schedules or deploy streaming and external pipelines with branch-aware version control.", "play"],
  ] as const;
  const catalogs = [
    ["Expressions", "Numeric, text, boolean, datetime, array, map, struct, geospatial, aggregate, generator, and validation functions."],
    ["Transforms", "Aggregate, filter, join, union, drop, deduplicate, parse CSV/JSON/XML/Excel, decompress files, and compute-if-absent."],
    ["Advanced nodes", "Split transforms, pattern mining, trained models, LLM evaluation suites, media search/chunking, custom functions, and reusable subgraphs."],
    ["Outputs", "Dataset, media set, virtual table, Nexus, geotemporal series, and Marketplace-ready outputs with markings and organizations."],
  ] as const;
  return <Modal title="Pipeline Builder guide" icon="info" onClose={onClose} wide><div className="p-5"><div className="rounded-lg border border-ocean/25 bg-ocean/10 p-3 text-xs leading-5 text-soft"><strong className="text-ocean">Point-and-click data integration.</strong> Pipeline Builder lets technical and non-technical builders collaborate on a graph while the platform handles execution, checks, pruning, and orchestration across batch, faster batch, streaming, and external backends.</div><div className="mt-5 grid gap-3 md:grid-cols-4">{workflow.map(([title, description, icon]) => <div key={title} className="rounded-lg border border-line bg-panel-2 p-3"><Icon name={icon} className="h-4 w-4 text-ocean" /><div className="mt-2 text-sm font-medium">{title}</div><p className="mt-2 text-xs leading-5 text-muted">{description}</p></div>)}</div><div className="mt-5 grid gap-3 md:grid-cols-2">{catalogs.map(([title, description]) => <div key={title} className="rounded-lg border border-line bg-panel p-4"><div className="text-sm font-medium text-soft">{title}</div><p className="mt-1 text-xs leading-5 text-muted">{description}</p></div>)}</div><div className="mt-5 flex items-center justify-between rounded-lg border border-line bg-panel-2 p-3 text-xs"><span className="text-muted">Use branches and proposals to iterate safely, then export generated code or deliver outputs to downstream Foundry applications.</span><button type="button" onClick={onClose} className={buttonClass.primary}>Start building</button></div></div></Modal>;
}

/** The default location for a new pipeline's folder: My Project / Datapipeline (false: the user may not create pipelines there). */
function useDefaultLocation(): DriveLocation | null | false {
  const [loc, setLoc] = useState<DriveLocation | null | false>(null);
  useEffect(() => {
    api.pipelineData
      .defaultFolder()
      .then((f) => setLoc({ id: f.id, name: [...(f.path ?? []).map((x) => x.name), f.name].join(" / ") }))
      .catch(() => setLoc(false));
  }, []);
  return loc;
}

function LocationDialog({ title, action, onPick, onClose }: { title: string; action: string; onPick: (location: DriveLocation) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <DrivePicker
      title={title}
      onClose={onClose}
      folder={{
        action: busy ? "Moving…" : action,
        busy,
        extra: error ? <span className="text-xs text-bad">{error}</span> : undefined,
        onPick: async (f) => {
          setBusy(true);
          setError(null);
          try {
            await onPick({ id: f.id, name: f.name });
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        },
      }}
    />
  );
}

const TYPES: { id: PipelineType; label: string; icon: IconName; description: string; sources: string }[] = [
  {
    id: "batch",
    label: "Batch pipeline",
    icon: "table",
    description: "Builds entire datasets on each deploy (or only new rows of incremental inputs). Use for data that is ingested periodically.",
    sources: "Files · databases · parsed documents · media",
  },
  {
    id: "streaming",
    label: "Streaming pipeline",
    icon: "wave",
    description: "Transforms the records of ingest streams as they arrive, with real-time latency: stateless steps, keys, and stateful aggregations and windows. Outputs are streams.",
    sources: "Ingest streams · streaming syncs · push API",
  },
  {
    id: "device",
    label: "Device stream",
    icon: "signal",
    description: "Node-RED flows for IoT devices, running in Node-RED on the server: wire sensors and cameras through functions to alarms, datasets and streams; any palette plugin.",
    sources: "MQTT · OPC-UA · Kafka · Modbus · Node-RED plugins",
  },
];

const COMPUTE: { id: BatchCompute; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Every transform and expression; best for large data (> 50 GB, > 200 million rows)." },
  { id: "faster", label: "Faster", hint: "Minimal startup, excellent on small and medium data (1–50 GB); no LLM, geospatial, media or trained model nodes." },
  { id: "external", label: "External", hint: "Push compute to Databricks or Snowflake: inputs and outputs are virtual tables of that source." },
];

const EXTERNAL_SOURCES: { kind: string; label: string; status: string; ok: boolean }[] = [
  { kind: "bigquery", label: "BigQuery", status: "Not available — use transforms with compute pushdown", ok: false },
  { kind: "databricks", label: "Databricks", status: "Generally available", ok: true },
  { kind: "snowflake", label: "Snowflake", status: "Generally available", ok: true },
];

function CreatePipelineDialog({
  initial,
  onClose,
  onCreate,
}: {
  initial?: { name: string; type: PipelineType; note?: string };
  onClose: () => void;
  onCreate: (name: string, type: PipelineType, location: DriveLocation, extra: { compute?: BatchCompute; external?: { connectionId: string; connectionName: string; kind: string } }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "Pipeline");
  const [type, setType] = useState<PipelineType>(initial?.type ?? "batch");
  const [compute, setCompute] = useState<BatchCompute>("standard");
  const [conns, setConns] = useState<DbConnection[] | null>(null);
  const [source, setSource] = useState("");
  const defaultLocation = useDefaultLocation();
  const [chosen, setChosen] = useState<DriveLocation | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const location = chosen ?? (defaultLocation || null);
  const shown = name.trim() || "Pipeline";
  useEffect(() => {
    if (compute === "external" && conns === null) api.dataSources.connections().then(setConns, () => setConns([]));
  }, [compute, conns]);
  const conn = conns?.find((c) => c.id === source);
  const externalReady = compute !== "external" || type !== "batch" || (!!conn && EXTERNAL_SOURCES.some((s) => s.ok && s.kind === conn.kind));
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [
    ...(name.trim() ? [] : ["enter a name"]),
    ...(location ? [] : [defaultLocation === null ? "wait for the default location" : "choose a location"]),
    ...(externalReady ? [] : ["choose a supported external source"]),
  ];
  const nameInvalid = tried && !name.trim();

  if (picking)
    return (
      <DrivePicker
        title="Pipeline location — its folder is created here"
        onClose={() => setPicking(false)}
        folder={{
          action: "Choose this folder",
          onPick: (f) => {
            setChosen(f.id ? { id: f.id, name: f.name } : TOP_LEVEL);
            setPicking(false);
          },
        }}
      />
    );

  return (
    <Modal title="Create new pipeline" icon="pipeline" onClose={onClose} wide>
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length || !location) return;
          setBusy(true);
          setError(null);
          try {
            await onCreate(name.trim(), type, location, {
              ...(type === "batch" ? { compute } : {}),
              ...(type === "batch" && compute === "external" && conn ? { external: { connectionId: conn.id, connectionName: conn.name, kind: conn.kind } } : {}),
            });
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        {initial?.note && (
          <p className="flex items-center gap-1.5 rounded-md bg-ocean/10 px-2 py-1.5 text-xs text-soft">
            <Icon name="wave" className="h-3.5 w-3.5 text-ocean" /> {initial.note}
          </p>
        )}
        <div>
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Pipeline name and location <span className="text-bad" aria-hidden>*</span></span>
          <div className="flex gap-2">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} />
            <button type="button" onClick={() => setPicking(true)} className={`${buttonClass.secondary} shrink-0 ${tried && !location ? "border-bad ring-1 ring-bad/40" : ""}`}>
              <Icon name="edit" className="h-3.5 w-3.5" /> Edit location
            </button>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <Icon name="folder" className="h-3.5 w-3.5 text-sand" />
            {location ? (
              <span className="truncate">
                {location.name} / <span className="text-soft">{shown}</span> / {shown}.pipeline
              </span>
            ) : (
              defaultLocation === false ? (
                <span className="text-warn">Choose a location (Edit location): you cannot create pipelines in My Project / Datapipeline.</span>
              ) : (
                "Finding the Datapipeline folder…"
              )
            )}
          </p>
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give the pipeline a name.</span>}
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-soft">Pipeline type</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setType(t.id)}
                className={`rounded-lg border p-3 text-left ${type === t.id ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${type === t.id ? "border-ocean bg-ocean" : "border-line-2"}`} />
                  {t.label}
                  <Icon name={t.icon} className="ml-auto h-4 w-4 text-ocean" />
                </span>
                <span className="mt-1 block text-xs text-muted">{t.description}</span>
                <span className="mt-2 block text-[11px] text-soft">{t.sources}</span>
              </button>
            ))}
          </div>
        </div>
        {type === "batch" && (
          <div>
            <span className="mb-1 block text-xs font-medium text-soft">Select batch compute</span>
            <div className="grid gap-2 sm:grid-cols-3">
              {COMPUTE.map((c) => (
                <label key={c.id} className={`cursor-pointer rounded-lg border p-2.5 text-xs ${compute === c.id ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}>
                  <input type="radio" className="hidden" checked={compute === c.id} onChange={() => setCompute(c.id)} />
                  <span className="block text-sm font-medium text-white">{c.label}</span>
                  <span className="block text-muted">{c.hint}</span>
                </label>
              ))}
            </div>
            {compute === "external" && (
              <div className="mt-2 space-y-2 rounded-md border border-line-2 p-3 text-xs">
                <table className="w-full">
                  <tbody>
                    {EXTERNAL_SOURCES.map((s) => (
                      <tr key={s.kind}>
                        <td className="py-0.5 text-soft">{s.label}</td>
                        <td className={s.ok ? "text-ok" : "text-muted"}>{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <select value={source} onChange={(e) => setSource(e.target.value)} aria-invalid={tried && !externalReady} className={`${inputClass} ${tried && !externalReady ? "border-bad ring-1 ring-bad/40" : ""}`}>
                  <option value="">{conns === null ? "Loading sources…" : "Choose the external source…"}</option>
                  {conns?.map((c) => (
                    <option key={c.id} value={c.id} disabled={!EXTERNAL_SOURCES.some((s) => s.ok && s.kind === c.kind)}>
                      {c.name} ({c.kind_name}){EXTERNAL_SOURCES.some((s) => s.ok && s.kind === c.kind) ? "" : " — not supported"}
                    </option>
                  ))}
                </select>
                {conns?.length === 0 && <p className="text-muted">Connect a Databricks or Snowflake source in Data Sources first.</p>}
                <p className="text-muted">All inputs and outputs are virtual tables of this source; Foundry-style datasets cannot be inputs or outputs. Not supported: incremental computation, LLM features, media sets, union, user-defined functions, geospatial.</p>
              </div>
            )}
          </div>
        )}
        {error && (
          <p className="flex items-center gap-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? "Creating…" : "Create pipeline"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
