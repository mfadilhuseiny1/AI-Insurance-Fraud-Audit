"use client";

import { ResourceMarkings } from "@/components/auth/ItemMarkings";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import {
  api,
  type Job,
  type SearchMode,
  type VectorConfig,
  type VectorCount,
  type VectorIndex,
  type VectorIngest,
  type VectorRow,
  type VectorSearch,
  type VectorSettings,
} from "@/lib/api";
import { usd, when } from "@/lib/format";
import { CreateIndexDialog } from "./CreateIndexDialog";
import { EmbedDialog } from "./EmbedDialog";
import { EmbedDocumentsDialog } from "./EmbedDocumentsDialog";
import { IndexSettings, parseFilter } from "./IndexSettings";
import { pageLabel, ResultList, smallButton, VectorDetail } from "./VectorDetail";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";

const nf = (n: number) => n.toLocaleString();
const selectClass = `${fieldClass} w-auto`;

/**
 * The Vector Storage tab: indexes in the S3 Vectors bucket, parse results embedded into them, and
 * tools to look inside (browse, one vector in full, semantic search). Nothing heavy loads up
 * front: vectors page by 50, a vector's values only when opened, and counts only when asked for.
 */
export default function VectorStorage() {
  const router = useRouter();
  const params = useSearchParams();
  const [config, setConfig] = useState<VectorConfig | null>(null);
  const [indexes, setIndexes] = useState<VectorIndex[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the open index lives in the address (?index=…); without one the home lists every index
  const selected = params.get("index");
  const setSelected = useCallback((name: string | null) => router.replace(name ? `/vector-storage?index=${encodeURIComponent(name)}` : "/vector-storage"), [router]);
  const [creating, setCreating] = useState(false);

  const loadIndexes = useCallback(
    () =>
      api.vectors
        .indexes()
        .then((list) => setIndexes(list))
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    api.vectors
      .config()
      .then((c) => {
        setConfig(c);
        if (!c.problem) loadIndexes();
      })
      .catch((e: Error) => setError(e.message));
  }, [loadIndexes]);

  if (!config && error) return <ApiError message={error} />;
  if (!config) return <Loading />;

  const index = indexes?.find((i) => i.name === selected) ?? null;
  const bucket = config.bucket && (
    <span className="rounded border border-line-2 px-1.5 py-0.5 font-mono text-[11px] text-muted" title="Vector bucket">
      {config.bucket}
      {config.region && ` · ${config.region}`}
    </span>
  );
  const createDialog = creating && (
    <CreateIndexDialog
      config={config}
      taken={(indexes ?? []).map((i) => i.name)}
      onClose={() => setCreating(false)}
      onCreated={(created) => {
        setCreating(false);
        setIndexes((list) => [...(list ?? []), { ...created, documents: 0 }]);
        setSelected(created.name);
      }}
    />
  );

  if (!selected || config.problem)
    return (
      <>
        <AppHome
          app="Vector Storage"
          icon="database"
          accent="#10b981"
          href="/vector-storage"
          tagline="Embeddings of your parsed documents, kept in vector indexes for semantic search and RAG."
          description={
            <>
              Indexes live in the S3 Vectors bucket{config.bucket ? <span className="font-mono"> {config.bucket}</span> : null}
              {config.region ? ` (${config.region})` : ""}. Embed parse results into an index, then browse its vectors, open one in full or run a semantic
              search. Nothing heavy loads up front: vectors page by 50, a vector&apos;s values only when opened, and counts only when asked for.
            </>
          }
          headerActions={bucket}
          noun={["index", "indexes"]}
          error={config.problem ? `Vector storage is not available: ${config.problem}.` : error}
          items={
            config.problem
              ? []
              : (indexes?.map((i) => ({
                  id: i.name,
                  href: `/vector-storage?index=${encodeURIComponent(i.name)}`,
                  title: i.name,
                  updated_at: i.created_at,
                  detail: i.model ?? "No embedding model chosen yet",
                  badges: [
                    { label: `${i.dimension}d`, tone: "muted" as const },
                    { label: i.metric, tone: "muted" as const },
                    ...(i.model ? [] : [{ label: "no model", tone: "warn" as const }]),
                  ],
                  meta: [`${i.documents ?? 0} docs`, i.vectors != null ? `${nf(i.vectors)} vectors` : ""].filter(Boolean).join(" · "),
                })) ?? null)
          }
          empty={
            config.problem
              ? undefined
              : { title: "Create your first index", hint: "An index stores the embeddings of your parsed documents for semantic search and RAG.", steps: ["Create an index and choose a model", "Embed parsed documents into it", "Browse vectors or run a search"] }
          }
          create={
            <button type="button" onClick={() => setCreating(true)} disabled={!!config.problem || !indexes} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Create index
            </button>
          }
        />
        {createDialog}
      </>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
        <Link href="/vector-storage" className="text-muted hover:text-strong">
          Vector Storage
        </Link>
        {bucket}
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={!!config.problem || !indexes}
          className={`${buttonClass.primary} ml-auto`}
        >
          <Icon name="plus" className="h-4 w-4" /> Create index
        </button>
      </header>

      {(
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel/40">
            <Link href="/vector-storage" className="flex items-center gap-1 px-4 pb-2 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted hover:text-strong">
              <Icon name="left" className="h-3 w-3" /> All indexes {indexes && `· ${indexes.length}`}
            </Link>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
              {!indexes && !error && <p className="px-2 text-xs text-muted">Loading…</p>}
              {error && <p className="px-2 text-xs text-bad">{error}</p>}
              {indexes?.length === 0 && (
                <p className="px-2 text-xs text-muted">No indexes yet. Create one to start embedding parsed documents.</p>
              )}
              {indexes?.map((i) => (
                <button
                  key={i.name}
                  type="button"
                  onClick={() => setSelected(i.name)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                    i.name === selected ? "bg-ocean/15 ring-1 ring-ocean/30" : "hover:bg-panel-2"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Icon name="database" className="h-3.5 w-3.5 shrink-0 text-ocean" />
                    <span className="truncate font-mono text-[13px]">{i.name}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted">
                    <span>{i.dimension}d</span>
                    <span>{i.metric}</span>
                    <span>{i.documents ?? 0} docs</span>
                    {i.vectors != null && <span>{nf(i.vectors)} vectors</span>}
                  </div>
                  <div className={`mt-0.5 truncate font-mono text-[10.5px] ${i.model ? "text-soft" : "text-warn"}`}>
                    {i.model ?? "no model chosen"}
                  </div>
                </button>
              ))}
            </div>
          </aside>

          {index ? (
            <IndexView
              key={index.name}
              config={config}
              index={index}
              indexes={indexes ?? []}
              onChanged={loadIndexes}
              onDeleted={() => {
                setSelected(null);
                loadIndexes();
              }}
            />
          ) : (
            indexes && (
              <div className="flex flex-1 items-center justify-center p-8">
                <div className="max-w-sm text-center">
                  <Icon name="database" className="mx-auto h-8 w-8 text-muted" />
                  <p className="mt-3 text-sm text-soft">
                    An index stores the embeddings of your parsed documents for semantic search and RAG.
                  </p>
                  <button type="button" onClick={() => setCreating(true)} className={`${buttonClass.primary} mt-4`}>
                    <Icon name="plus" className="h-4 w-4" /> Create index
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {createDialog}
    </div>
  );
}

/* ------------------------------------------------------------ one index */

type Tab = "documents" | "browse" | "search" | "settings";

function IndexView({
  config,
  index,
  indexes,
  onChanged,
  onDeleted,
}: {
  config: VectorConfig;
  index: VectorIndex;
  indexes: VectorIndex[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<Tab>("documents");
  const [ingests, setIngests] = useState<VectorIngest[] | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [embedJobs, setEmbedJobs] = useState<Job[] | null>(null);
  const [settings, setSettings] = useState<VectorSettings | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [count, setCount] = useState<VectorCount | null>(null);
  const [counting, setCounting] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);

  const loadIngests = useCallback(
    () =>
      api.vectors
        .ingests(index.name)
        .then((rows) => {
          setIngests(rows);
          setIngestError(null);
        })
        .catch((e: Error) => setIngestError(e.message)),
    [index.name],
  );

  const loadSettings = useCallback(
    () =>
      api.vectors
        .settings(index.name)
        .then(setSettings)
        .catch(() => {}),
    [index.name],
  );

  useEffect(() => {
    loadIngests();
    loadSettings();
  }, [loadIngests, loadSettings]);

  // poll while documents are being embedded; refresh the index list once they finish
  const active = ingests?.some((i) => i.status === "queued" || i.status === "running") ?? false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(loadIngests, 1500);
    return () => {
      clearInterval(t);
      onChanged();
      loadSettings();
    };
  }, [active, loadIngests, onChanged, loadSettings]);

  const runCount = async (refresh: boolean) => {
    setCounting(true);
    setCountError(null);
    try {
      setCount(await api.vectors.count(index.name, refresh));
    } catch (e) {
      setCountError((e as Error).message);
    } finally {
      setCounting(false);
    }
  };

  const remove = async () => {
    const typed = (await promptDialog(
      `Delete index "${index.name}" and every vector in it? This cannot be undone.\n\nType the index name to confirm:`,
    ));
    if (typed !== index.name) return;
    try {
      await api.vectors.deleteIndex(index.name);
      onDeleted();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };

  const model = config.models.find((m) => m.id === index.model);
  const completed = ingests?.filter((i) => i.status === "completed") ?? [];
  const storedVectors = completed.reduce((n, i) => n + i.vectors, 0);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="@container min-w-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-5">
          {/* ------------------------------------------- title and actions */}
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0">
              <h1 className="truncate font-mono text-lg">{index.name}</h1>
              <p className="mt-0.5 text-xs text-muted">Created {when(index.created_at)}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={remove} className={buttonClass.ghost} title="Delete index">
                <Icon name="trash" className="h-4 w-4" /> Delete
              </button>
              <button
                type="button"
                onClick={() => setEmbedding(true)}
                disabled={!index.model}
                className={buttonClass.primary}
                title={index.model ? undefined : "Choose an embedding model first"}
              >
                <Icon name="sparkle" className="h-4 w-4" /> Embed parsed results
              </button>
            </div>
          </div>

          {!index.model && <ChooseModel config={config} index={index} onChosen={onChanged} />}

          {/* ------------------------------------------- summary */}
          <div className="grid gap-3 @4xl:grid-cols-[1fr_320px]">
            <div className="rounded-xl border border-line bg-panel p-4">
              <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
                <Tile label="Documents" value={nf(completed.length)} />
                <Tile label="Vectors stored" value={nf(storedVectors)} sub={count ? `S3 count: ${nf(count.total)}` : undefined} />
                <Tile label="Dimension" value={String(index.dimension)} />
                <Tile label="Metric" value={index.metric} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <button type="button" className={smallButton} disabled={counting} onClick={() => runCount(!!count)}>
                  <Icon name="refresh" className={`h-3.5 w-3.5 ${counting ? "animate-spin" : ""}`} />
                  {counting ? "Counting in S3…" : count ? "Count again" : "Count vectors in S3"}
                </button>
                {count && (
                  <span className="text-muted">
                    {nf(count.total)} vectors ·{" "}
                    {count.total === storedVectors ? (
                      <span className="text-ok">matches embedded documents</span>
                    ) : (
                      <span className="text-warn">{nf(count.total - storedVectors)} not from documents listed here</span>
                    )}{" "}
                    · counted {new Date(count.counted_at).toLocaleTimeString()} in {(count.ms / 1000).toFixed(1)} s
                  </span>
                )}
                {countError && <span className="text-bad">{countError}</span>}
              </div>
            </div>

            <dl className="space-y-1 rounded-xl border border-line bg-panel p-4 text-xs">
              <Kv k="model" v={index.model ? `${model?.label ?? index.model}` : "—"} />
              <Kv k="model id" v={index.model ?? "—"} />
              <Kv k="data type" v={index.data_type ?? "—"} />
              <Kv k="mode" v={index.mode ?? "—"} />
              <Kv
                k="text"
                v={
                  index.non_filterable_keys.includes("text")
                    ? "stored in metadata"
                    : "read from parse results (not stored in the index)"
                }
              />
              <Kv k="filterable" v="job_id, file_id, file_name, tier, chunk_index, page_start, page_end, language + your tags" />
              {settings && <Kv k="spent" v={`${usd(settings.spent_usd)}${settings.budget_usd != null ? ` of ${usd(settings.budget_usd)}` : ""}`} />}
            </dl>
          </div>

          {/* ------------------------------------------- tabs */}
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            <div className="flex gap-1 border-b border-line px-3 py-2">
              {(
                [
                  ["documents", "Documents", "doc"],
                  ["browse", "Browse vectors", "layers"],
                  ["search", "Search", "search"],
                  ["settings", "Settings", "sliders"],
                ] as const
              ).map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
                    tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2 hover:text-white"
                  }`}
                >
                  <Icon name={icon} className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
            {tab === "documents" && (
              <Documents
                index={index}
                ingests={ingests}
                error={ingestError}
                database={config.database}
                counts={count?.by_job}
                onEmbed={() => setEmbedding(true)}
                onChanged={() => {
                  loadIngests();
                  onChanged();
                }}
              />
            )}
            {tab === "browse" && <Browser index={index} openKey={openKey} onOpen={setOpenKey} />}
            {tab === "search" && <Search index={index} documents={completed} settings={settings} config={config} onOpen={setOpenKey} />}
            {tab === "settings" && <ResourceMarkings kind="vector_index" id={index.name} className="mb-4" />}
            {tab === "settings" && (
              <IndexSettings
                config={config}
                index={index}
                indexes={indexes}
                settings={settings}
                documents={completed.length}
                failed={ingests?.filter((i) => i.status === "failed").length ?? 0}
                onSettings={setSettings}
                onChanged={() => {
                  loadIngests();
                  onChanged();
                }}
              />
            )}
          </div>
        </div>
      </div>

      {openKey && (
        <VectorDetail
          key={openKey}
          index={index.name}
          metric={index.metric}
          vectorKey={openKey}
          onOpen={setOpenKey}
          onClose={() => setOpenKey(null)}
        />
      )}

      {embedding && (
        <EmbedDialog
          index={index}
          ingests={ingests ?? []}
          onClose={() => setEmbedding(false)}
          onNext={(jobs) => {
            setEmbedding(false);
            setEmbedJobs(jobs);
          }}
        />
      )}
      {embedJobs && (
        <EmbedDocumentsDialog
          jobs={embedJobs}
          ingests={ingests ?? []}
          initialIndex={index.name}
          onClose={() => setEmbedJobs(null)}
          onStarted={() => {
            setEmbedJobs(null);
            setTab("documents");
            loadIngests();
            loadSettings();
          }}
        />
      )}
    </div>
  );
}

/** An index made outside this app has no model yet: pick one that produces its dimension. */
function ChooseModel({ config, index, onChosen }: { config: VectorConfig; index: VectorIndex; onChosen: () => void }) {
  const options = config.models.filter((m) => index.compatible_models.includes(m.id));
  const [model, setModel] = useState(options.find((m) => m.id === config.default_model)?.id ?? options[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.vectors.setModel(index.name, model);
      onChosen();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-warn">
        <Icon name="alert" className="h-4 w-4" /> This index has no embedding model yet
      </div>
      <p className="mt-1 text-xs text-soft">
        It was created outside this app. Choose the model whose vectors it will hold; every document and search query in this
        index uses it, and it can&apos;t be changed afterwards. Models that produce {index.dimension} dimensions:
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={model} onChange={(e) => setModel(e.target.value)} className={selectClass}>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </select>
        <button type="button" onClick={save} disabled={busy || !model} className={buttonClass.primary}>
          {busy ? "Saving…" : "Use this model"}
        </button>
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ documents */

function Documents({
  index,
  ingests,
  error,
  database,
  counts,
  onEmbed,
  onChanged,
}: {
  index: VectorIndex;
  ingests: VectorIngest[] | null;
  error: string | null;
  database: boolean;
  counts?: Record<string, number>;
  onEmbed: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const reembed = async (row: VectorIngest) => {
    const jobId = row.job_id;
    setBusy(jobId);
    try {
      // with the settings it was embedded with (always replacing)
      await api.vectors.ingest(index.name, [jobId], row.options ? { ...row.options, on_existing: "replace" } : undefined);
      onChanged();
    } catch (e) {
      void alertDialog((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: VectorIngest) => {
    if (!(await confirmDialog(`Delete the ${row.vectors} vectors of ${row.file_name} from ${index.name}?`))) return;
    setBusy(row.job_id);
    try {
      await api.vectors.removeIngest(index.name, row.job_id);
      onChanged();
    } catch (e) {
      void alertDialog((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="p-4 text-sm text-bad">{error}</p>;
  if (!ingests) return <p className="p-4 text-sm text-muted">Loading…</p>;

  return (
    <div>
      {!database && (
        <p className="border-b border-line px-4 py-2 text-xs text-warn">
          The database is not connected, so this list is only kept until the API restarts. The vectors themselves stay in the
          index.
        </p>
      )}
      {!ingests.length ? (
        <div className="px-4 py-10 text-center text-sm text-muted">
          No documents embedded into this index yet.{" "}
          {index.model && (
            <button type="button" onClick={onEmbed} className="text-ocean hover:underline">
              Embed parsed results
            </button>
          )}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              {["Document", "Status", "Vectors", "Model", "Cost", "Embedded", ""].map((h) => (
                <th key={h} className="px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ingests.map((r) => {
              const running = r.status === "queued" || r.status === "running";
              const s3 = counts?.[r.job_id];
              return (
                <tr key={r.job_id} className="border-t border-line align-top">
                  <td className="max-w-xs px-4 py-2.5">
                    <div className="truncate" title={r.file_name}>
                      {r.file_name}
                    </div>
                    <span className="font-mono text-[11px] text-muted">{r.job_id}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <IngestStatus row={r} />
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {nf(r.vectors)}
                    {r.total > 0 && r.vectors !== r.total && <span className="text-muted"> / {nf(r.total)}</span>}
                    {s3 != null && s3 !== r.vectors && <div className="text-[11px] text-warn">S3: {nf(s3)}</div>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-soft">
                    {r.model}
                    <div className="text-muted">{r.dimension}d</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-soft">{usd(r.cost_usd)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-soft">
                    {when(r.finished_at ?? r.created_at)}
                    {r.trigger && r.trigger !== "manual" && (
                      <div className="mt-0.5 w-fit rounded bg-panel-2 px-1.5 py-px text-[10px] text-muted ring-1 ring-line-2">
                        {r.trigger === "auto" ? "auto-embed" : r.trigger === "copy" ? "re-embedded from another index" : `retry ${r.attempts}`}
                      </div>
                    )}
                    {r.options && Object.keys(r.options.metadata).length > 0 && (
                      <div className="mt-0.5 font-mono text-[10px] text-muted">
                        {Object.entries(r.options.metadata)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" ")}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => reembed(r)}
                      disabled={running || busy === r.job_id}
                      title="Embed again"
                      className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white disabled:opacity-30"
                    >
                      <Icon name="refresh" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r)}
                      disabled={running || busy === r.job_id}
                      title="Delete its vectors"
                      className="rounded p-1.5 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-30"
                    >
                      <Icon name="trash" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function IngestStatus({ row }: { row: VectorIngest }) {
  if (row.status === "completed")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-ok">
        <Icon name="check" className="h-3.5 w-3.5" /> Embedded
      </span>
    );
  if (row.status === "failed")
    return (
      <span className="block max-w-xs text-xs text-bad" title={row.error ?? undefined}>
        Failed{row.error && <span className="line-clamp-2 text-[11px] text-soft">{row.error}</span>}
      </span>
    );
  const pct = row.total ? (row.vectors / row.total) * 100 : 0;
  return (
    <div className="w-32">
      <span className="text-xs text-ocean">{row.status === "queued" ? "Queued" : `Embedding ${Math.round(pct)}%`}</span>
      <div className="mt-1 h-1 rounded-full bg-line">
        <div className="h-full rounded-full bg-ocean transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ browse */

function Browser({ index, openKey, onOpen }: { index: VectorIndex; openKey: string | null; onOpen: (k: string) => void }) {
  /** token of every page passed so far, for going back */
  const [tokens, setTokens] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<{ at: number; rows: VectorRow[]; nextToken: string | null } | null>(null);
  const [error, setError] = useState<{ at: number; message: string } | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const at = tokens.length;
    api.vectors
      .list(index.name, tokens.at(-1) ?? null, ctl.signal)
      .then((res) => setPage({ at, rows: res.rows, nextToken: res.next_token }))
      .catch((e: Error) => !ctl.signal.aborted && setError({ at, message: e.message }));
    return () => ctl.abort();
  }, [index.name, tokens]);

  // the page shown until the one asked for arrives
  const loading = page?.at !== tokens.length && error?.at !== tokens.length;
  const rows = page?.rows ?? null;
  const nextToken = page?.nextToken ?? null;
  const shownError = error?.at === tokens.length ? error.message : null;

  return (
    <div>
      <p className="border-b border-line px-4 py-2 text-xs text-muted">
        Vectors in the index&apos;s own order (ListVectors), 50 per page. Click one to see its values and neighbors.
      </p>
      {shownError && <p className="px-4 py-3 text-sm text-bad">{shownError}</p>}
      <div className={`overflow-x-auto ${loading ? "opacity-60" : ""}`}>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Key</th>
              <th className="px-2 py-2 font-medium">Chunk</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr
                key={r.key ?? r.chunk_index}
                onClick={() => r.key && onOpen(r.key)}
                className={`cursor-pointer border-t border-line align-top hover:bg-panel-2 ${openKey === r.key ? "bg-ocean/10" : ""}`}
              >
                <td className="w-[1%] whitespace-nowrap px-4 py-2 font-mono text-[11px]">{r.key}</td>
                <td className="max-w-0 px-2 py-2 pr-4 text-xs">
                  <div className="truncate text-muted">
                    {r.file_name ?? "—"} {r.pages.length > 0 && `· ${pageLabel(r.pages)}`} {r.language && `· ${r.language}`}
                  </div>
                  <div className="line-clamp-2 text-soft" dir="auto">
                    {r.preview ?? <span className="text-muted">—</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && !rows.length && <p className="px-4 py-6 text-sm text-muted">This index is empty.</p>}
        {!rows && !shownError && <p className="px-4 py-6 text-sm text-muted">Loading…</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2">
        <button
          type="button"
          className={smallButton}
          disabled={tokens.length < 2 || loading}
          onClick={() => setTokens((t) => t.slice(0, -1))}
        >
          <Icon name="left" className="h-3.5 w-3.5" /> Previous
        </button>
        <button
          type="button"
          className={smallButton}
          disabled={!nextToken || loading}
          onClick={() => setTokens((t) => [...t, nextToken])}
        >
          Next <Icon name="right" className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs text-muted">page {tokens.length}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ search */

function Search({
  index,
  documents,
  settings,
  config,
  onOpen,
}: {
  index: VectorIndex;
  documents: VectorIngest[];
  settings: VectorSettings | null;
  config: VectorConfig;
  onOpen: (k: string) => void;
}) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("vector");
  const [rerank, setRerank] = useState(false);
  const [asKey, setAsKey] = useState("");
  const [topK, setTopK] = useState(10);
  const [jobId, setJobId] = useState("");
  const [where, setWhere] = useState("");
  const key = settings?.keys.find((k) => k.id === asKey) ?? null;
  const [result, setResult] = useState<VectorSearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim() || !index.model) return;
    // "tenant=acme, access_level=internal": metadata that must match exactly
    const typed = parseFilter(where);
    if (!typed) {
      setError("Write the filter as key=value, separated by commas.");
      return;
    }
    // searching as a key: its filter wins over the typed one, as on the key's own endpoint
    const filter = { ...typed, ...(key?.filter ?? {}) };
    setLoading(true);
    setError(null);
    try {
      setResult(await api.vectors.search(index.name, { q, top_k: topK, job_id: jobId || null, filter, mode, rerank }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!index.model) return <p className="p-4 text-sm text-muted">Choose an embedding model for this index first.</p>;

  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <div className="inline-flex rounded-md border border-line-2 p-0.5">
          {(
            [
              ["vector", "Vector", "Meaning only (embeddings)"],
              ["hybrid", "Hybrid", "Meaning + exact words (BM25), fused by rank: better for names, codes and numbers"],
            ] as const
          ).map(([id, label, title]) => (
            <button
              key={id}
              type="button"
              title={title}
              onClick={() => setMode(id)}
              className={`rounded px-2.5 py-1 ${mode === id ? "bg-ocean/20 text-white" : "text-soft hover:text-white"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label
          className="flex cursor-pointer items-center gap-1.5 text-soft"
          title={`The best candidates are re-ordered by ${config.rerank_model} judging relevance (slower, paid)`}
        >
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} className="accent-ocean" />
          AI re-rank
        </label>
        {settings && settings.keys.length > 0 && (
          <label className="ml-auto flex items-center gap-1.5 text-soft" title="See exactly what an app using this key would get">
            Search as
            <select value={asKey} onChange={(e) => setAsKey(e.target.value)} className={`${selectClass} py-1 text-xs`}>
              <option value="">Admin (whole index)</option>
              {settings.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  key: {k.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              run();
            }
          }}
          rows={2}
          dir="auto"
          placeholder="Ask something the embedded documents should answer…"
          className={`${inputClass} resize-none`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-soft">
          <label className="flex items-center gap-1.5">
            Document
            <select value={jobId} onChange={(e) => setJobId(e.target.value)} className={`${selectClass} max-w-[16rem] py-1 text-xs`}>
              <option value="">All documents</option>
              {documents.map((d) => (
                <option key={d.job_id} value={d.job_id}>
                  {d.file_name} ({d.job_id})
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5" title="Metadata that must match exactly, e.g. tags set when embedding">
            Filter
            <input
              value={where}
              onChange={(e) => setWhere(e.target.value)}
              placeholder="tenant=acme, access_level=internal"
              className={`${selectClass} w-60 py-1 font-mono text-xs`}
            />
            {key && Object.keys(key.filter).length > 0 && (
              <span className="font-mono text-[11px] text-sand" title="Applied by the key; can't be overridden">
                + {Object.entries(key.filter).map(([a, b]) => `${a}=${b}`).join(", ")}
              </span>
            )}
          </label>
          <label className="flex items-center gap-1.5">
            Top K
            <select value={topK} onChange={(e) => setTopK(Number(e.target.value))} className={`${selectClass} py-1 text-xs`}>
              {[5, 10, 20, 50, 100].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={`${buttonClass.primary} ml-auto`} disabled={loading || !q.trim()}>
            <Icon name="search" className="h-3.5 w-3.5" />
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {result && (
        <div className="mt-4">
          <p className="mb-2 font-mono text-[11px] text-muted">
            {result.model} · embedding {result.embed_ms} ms · query {result.query_ms} ms
            {result.keyword_ms != null && ` · keywords ${result.keyword_ms} ms (${result.keyword_hits} hits)`}
            {result.rerank_ms != null && ` · re-rank ${result.rerank_ms} ms`} ·{" "}
            {result.score_kind === "rerank"
              ? "AI relevance (higher is better)"
              : result.score_kind === "rrf"
                ? "fused rank score (higher is better)"
                : result.metric === "cosine"
                  ? "cosine similarity (higher is closer)"
                  : "euclidean distance (lower is closer)"}
          </p>
          <ResultList rows={result.rows} metric={result.metric} scoreKind={result.score_kind} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ small */

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10.5px] text-muted">{sub}</div>}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-2">
      <dt className="font-mono text-[11px] text-muted">{k}</dt>
      <dd className="break-words font-mono text-[11px]">{v}</dd>
    </div>
  );
}
