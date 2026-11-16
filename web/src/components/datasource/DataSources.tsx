"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type BatchPreview, type DataSource, type Frequency } from "@/lib/api";
import { when } from "@/lib/format";
import { alertDialog, chooseDialog, confirmDialog } from "@/lib/dialogs";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "../pipeline/Modal";
import { approx, ConnectorLogo, FREQUENCY_LABEL } from "./ConnectorLogo";
import { AdvancedSyncOptions, BatchView, DataSourceWizard, useLoad } from "./DataSourceWizard";
import { SyncCheckBadge, SyncChecks, useSyncCheckStatus } from "./SyncChecks";

function Status({ s }: { s: DataSource }) {
  const run = s.last_run;
  if (s.status === "running")
    return (
      <span className="flex items-center gap-1.5 text-xs text-ocean">
        <Icon name="refresh" className="h-3.5 w-3.5 animate-spin" /> Running
      </span>
    );
  if (run?.status === "failed")
    return (
      <span className="flex items-center gap-1.5 text-xs text-bad" title={run.error ?? undefined}>
        <Icon name="alert" className="h-3.5 w-3.5" /> Failed
      </span>
    );
  if (run?.status === "completed")
    return (
      <span className="flex items-center gap-1.5 text-xs text-ok">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" /> {run.rows.toLocaleString()} rows {when(run.finished_at ?? run.started_at)}
      </span>
    );
  return <span className="text-xs text-muted">Never run</span>;
}

export default function DataSources() {
  const [sources, setSources] = useState<DataSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  // a link to a sync (an in-app sync check notification: /sources?source=<id>) opens it
  const [open, setOpen] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("source")));
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.dataSources
      .sources()
      .then((s) => {
        setSources(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // follow running sources
  const running = sources?.some((s) => s.status === "running");
  // health check states, re-read as runs finish
  const checkStatus = useSyncCheckStatus(sources?.map((s) => `${s.id}:${s.status}:${s.last_run?.id ?? ""}`).join(","));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [running, load]);

  const run = async (s: DataSource) => {
    setBusy(s.id);
    try {
      await api.dataSources.run(s.id);
      load();
    } catch (e) {
      void alertDialog((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const selected = sources?.find((s) => s.id === open) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="dot-grid min-w-0 flex-1 overflow-y-auto">
        <header className="flex h-14 items-center justify-between border-b border-line bg-panel px-5 text-sm">
          Data Sources
          <button type="button" onClick={() => setWizard(true)} className={buttonClass.primary}>
            <Icon name="plus" /> New data source
          </button>
        </header>
        <div className="mx-auto max-w-6xl p-8">
          <h1 className="text-xl font-semibold">Ingest tables from your databases</h1>
          <p className="mt-1 text-sm text-muted">
            Connect PostgreSQL, MySQL, SQL Server and more, pick a table, and ingest it as a snapshot or incrementally. Each run writes Parquet to
            My Project / Data Source, ready for Pipeline Builder.
          </p>

          {error && (
            <p className="mt-6 flex items-center gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              <Icon name="alert" /> {error}
              <button type="button" onClick={load} className="ml-auto text-xs underline">
                Retry
              </button>
            </p>
          )}

          {sources === null ? (
            !error && <p className="mt-8 text-sm text-muted">Loading…</p>
          ) : sources.length === 0 ? (
            <button
              type="button"
              onClick={() => setWizard(true)}
              className="mt-8 flex w-full flex-col items-center rounded-2xl border-2 border-dashed border-line-2 py-16 hover:border-ocean/60 hover:bg-panel/60"
            >
              <span className="mb-3 rounded-full bg-panel-2 p-3 text-ocean ring-1 ring-line-2">
                <Icon name="database" className="h-6 w-6" />
              </span>
              <span className="font-semibold">Connect your first database</span>
              <span className="mt-1 text-sm text-muted">Browse its tables, preview them, and choose how they are ingested.</span>
            </button>
          ) : (
            <div className="mt-8 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-panel text-left text-xs text-muted">
                  <tr>
                    {["Name", "Table", "Mode", "Last run", "Ingested", "Schedule", ""].map((h) => (
                      <th key={h} className="whitespace-nowrap px-4 py-2.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => setOpen(s.id)}
                      className={`cursor-pointer border-t border-line ${open === s.id ? "bg-ocean/10" : "hover:bg-panel/60"}`}
                    >
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2.5">
                          <ConnectorLogo kind={s.connection.kind} size="sm" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{s.name}</span>
                            <span className="block truncate text-xs text-muted">{s.connection.name}</span>
                          </span>
                        </span>
                      </td>
                      <td className="max-w-[14rem] truncate px-4 py-2.5 text-xs text-soft">
                        {s.schema}.{s.table}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {s.mode === "incremental" ? (
                          <span title={s.config.cursor_column === DELTA_CURSOR ? "Delta token (OData change tracking)" : `APPEND transactions on cursor ${s.config.cursor_column}`}>
                            Incremental{" "}
                            <span className="text-muted">
                              ·{" "}
                              {s.config.cursor_column === DELTA_CURSOR
                                ? s.config.delta_write === "upsert"
                                  ? "delta, upsert by key"
                                  : "delta, change log"
                                : `APPEND on ${s.config.cursor_column}`}
                            </span>
                            {s.state.resync && <span className="block text-warn">re-sync pending</span>}
                          </span>
                        ) : (
                          <span title="SNAPSHOT transactions">
                            Snapshot <span className="text-muted">· {s.config.snapshot_behavior === "new" ? "keeps history" : "replace"}</span>
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <Status s={s} />
                        <SyncCheckBadge status={checkStatus[`source:${s.id}`]} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-soft">{approx(s.state.rows_total)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-soft">
                        {FREQUENCY_LABEL[s.config.frequency]}
                        {s.next_run_at && <span className="block text-muted">next {when(s.next_run_at)}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <Link
                          href={`/data-health?add=${encodeURIComponent(`dc_sync:source:${s.id}`)}&name=${encodeURIComponent(s.name)}`}
                          title="Sync status and sync freshness checks in Data Health"
                          className={`${buttonClass.secondary} mr-1.5 py-1 text-xs`}
                        >
                          <Icon name="bell" className="h-3 w-3" /> Monitor
                        </Link>
                        <button type="button" disabled={s.status === "running" || busy === s.id} onClick={() => run(s)} className={`${buttonClass.secondary} py-1 text-xs`}>
                          <Icon name="play" className="h-3 w-3" /> Run now
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selected && (
        <SourcePanel
          key={selected.id}
          initial={selected}
          onClose={() => setOpen(null)}
          onChanged={load}
          onRun={() => run(selected)}
        />
      )}
      {wizard && (
        <DataSourceWizard
          onClose={() => {
            setWizard(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Snapshot ↔ incremental for an existing source (the next run re-syncs as a SNAPSHOT). */
/** api/datasources.py DELTA_CURSOR: a source following an OData service's delta links (SAP ODP / OData v4) */
const DELTA_CURSOR = "!deltatoken";

/** How a delta-token source writes its dataset: the change log (APPEND) or the current rows by key (UPDATE). */
function DeltaWriteSwitch({ source, act }: { source: DataSource; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const mode = source.config.delta_write ?? "log";
  const keep = !!source.config.keep_change_mode;
  const set = (delta_write: "log" | "upsert", keep_change_mode?: boolean) =>
    act(() => api.dataSources.changeDeltaWrite(source.id, { delta_write, ...(keep_change_mode === undefined ? {} : { keep_change_mode }) }));
  return (
    <div className="space-y-2 rounded-lg border border-line-2 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Delta write mode</span>
        <div className="ml-auto flex rounded-md border border-line-2 p-0.5 text-xs" role="radiogroup">
          {(["log", "upsert"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={source.status === "running" || mode === m}
              onClick={() => set(m)}
              className={`rounded px-2.5 py-1 font-medium ${mode === m ? "bg-ocean text-white" : "text-muted hover:text-white"}`}
            >
              {m === "log" ? "Change log" : "Upsert by key"}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">
        {mode === "log"
          ? "Each delta run APPENDs the changed rows with ODQ_CHANGEMODE (U / C, D for deleted keys); the dataset is the full change log."
          : `Each delta run applies the changes by key (${(source.config.delta_key ?? []).join(", ") || "the entity set's key"}) and writes the current rows as a new version (UPDATE): last version per key, deleted keys removed.`}
      </p>
      {mode === "upsert" && (
        <label className="flex items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={keep} disabled={source.status === "running"} onChange={(e) => set("upsert", e.target.checked)} />
          Keep the ODQ_CHANGEMODE column in the current rows
        </label>
      )}
      {source.state.compact && <p className="text-xs text-warn">The next run rewrites the dataset as the current rows (even with no new changes).</p>}
      {source.state.widen && !source.state.compact && (
        <p className="text-xs text-warn">The ODQ_CHANGEMODE column was added: the next run rewrites the change log so far once in the new schema (its rows without a change mode).</p>
      )}
      {mode === "upsert" && !keep && (
        <p className="text-[11px] text-muted">Switching back to the change log without the ODQ_CHANGEMODE column starts a new initial load (re-sync).</p>
      )}
    </div>
  );
}

function ModeSwitch({ source, act }: { source: DataSource; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [target, setTarget] = useState<"snapshot" | "incremental" | null>(null);
  const [cursor, setCursor] = useState("");
  const [start, setStart] = useState("");
  const cols = useLoad(target === "incremental" ? `cols:${source.id}` : null, () => api.dataSources.preview(source.connection.id, source.database, source.schema, source.table));
  const usable = (cols.data?.columns ?? []).filter((c) => c.cursor);
  const chosen = cursor || usable.find((c) => c.recommended)?.name || "";
  const current = source.mode;
  return (
    <div className="rounded-lg border border-line-2 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Ingestion mode</span>
        <div className="ml-auto flex rounded-md border border-line-2 p-0.5 text-xs" role="radiogroup">
          {(["snapshot", "incremental"] as const).map((m) => {
            const on = (target ?? current) === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={source.status === "running"}
                onClick={() => setTarget(m === current ? null : m)}
                className={`rounded px-2.5 py-1 font-medium ${on ? "bg-ocean text-white" : "text-muted hover:text-white"}`}
              >
                {m === "snapshot" ? "Snapshot" : "Incremental"}
              </button>
            );
          })}
        </div>
      </div>
      {target && (
        <div className="mt-3 space-y-2 text-xs">
          {target === "incremental" ? (
            <>
              <p className="text-muted">Each run appends only rows whose cursor is above the last value read (APPEND). Pick a column that increases with every new — and changed — row, such as an id or an updated-at timestamp.</p>
              {cols.error && <p className="text-bad">{cols.error}</p>}
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-muted">Cursor column</span>
                  <select value={chosen} onChange={(e) => setCursor(e.target.value)} className={`${inputClass} py-1 text-xs`}>
                    {cols.loading && <option>Loading…</option>}
                    {!cols.loading && !usable.length && <option value="">No usable column</option>}
                    {usable.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.db_type}){c.recommended ? " — recommended" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-muted">Initial value (exclusive)</span>
                  <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="empty: every row" className={`${inputClass} py-1 text-xs`} />
                </label>
              </div>
            </>
          ) : (
            <p className="text-muted">Each run replaces the dataset with the whole table (SNAPSHOT).</p>
          )}
          <p className="rounded bg-warn/10 p-2 text-warn">The next run re-syncs: a SNAPSHOT that starts a new dataset view. Pipelines reading this source incrementally will process every row once.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setTarget(null)} className={`${buttonClass.secondary} py-1 text-xs`}>
              Cancel
            </button>
            <button
              type="button"
              disabled={target === "incremental" && !chosen}
              onClick={() =>
                act(() => api.dataSources.changeMode(source.id, target === "incremental" ? { mode: "incremental", cursor_column: chosen, start_from: start || null } : { mode: "snapshot" })).then(() => setTarget(null))
              }
              className={`${buttonClass.primary} py-1 text-xs`}
            >
              Switch to {target}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SourcePanel({ initial, onClose, onChanged, onRun }: { initial: DataSource; onClose: () => void; onChanged: () => void; onRun: () => void }) {
  const [source, setSource] = useState(initial);
  const [next, setNext] = useState<{ data?: BatchPreview; error?: string; loading?: boolean }>({});
  const [error, setError] = useState<string | null>(null);

  // the list polls while running; keep the panel (with its run history) in step
  const status = initial.status;
  const lastRun = initial.last_run?.id;
  useEffect(() => {
    let live = true;
    api.dataSources
      .source(initial.id)
      .then((s) => live && setSource(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [initial.id, status, lastRun]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
      setSource(await api.dataSources.source(source.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const previewNext = async () => {
    setNext({ loading: true });
    try {
      setNext({ data: await api.dataSources.nextBatch(source.id) });
    } catch (e) {
      setNext({ error: (e as Error).message });
    }
  };

  const remove = async () => {
    const pick = await chooseDialog({
      title: `Delete the data source "${source.name}"?`,
      message: "Its schedule and run history are removed. Choose what happens to the Parquet it ingested in Files.",
      choices: [
        { id: "keep", label: "Delete, keep the data" },
        { id: "all", label: "Delete with its data", danger: true },
      ],
    });
    if (!pick) return;
    await act(() => api.dataSources.deleteSource(source.id, pick === "all"));
    onClose();
  };

  const incremental = source.mode === "incremental";
  const info: [string, React.ReactNode][] = [
    ["Connection", source.connection.name],
    ["Table", `${source.database} / ${source.schema}.${source.table}`],
    ["Columns", `${source.columns.length}`],
    [
      "Mode",
      !incremental
        ? "Snapshot — SNAPSHOT transactions"
        : source.config.cursor_column === DELTA_CURSOR
          ? source.config.delta_write === "upsert"
            ? "Delta token — upsert by key (UPDATE transactions holding the current rows)"
            : "Delta token — change log (APPEND transactions)"
          : `Incremental — APPEND transactions on ${source.config.cursor_column}`,
    ],
    ...(incremental
      ? ([
          [
            "Last cursor",
            source.state.resync
              ? "re-sync pending: the next run is a SNAPSHOT from the initial value"
              : (source.state.last_cursor ?? "— (the first run reads after the initial value)"),
          ],
        ] as [string, React.ReactNode][])
      : []),
    ["Rows in dataset", source.state.rows_total.toLocaleString()],
    ["Dataset view", `${source.state.view_files} Parquet file${source.state.view_files === 1 ? "" : "s"}`],
    ["Batch size", source.config.batch_size.toLocaleString()],
    [
      "Output",
      source.folder ? (
        <Link key="f" href={`/files/${source.folder.id}`} className="text-ocean hover:underline">
          {source.folder.path.slice(1).join(" / ")}
        </Link>
      ) : (
        "—"
      ),
    ],
  ];

  return (
    <aside className="flex w-[28rem] shrink-0 flex-col border-l border-line bg-panel text-sm">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <ConnectorLogo kind={source.connection.kind} size="sm" />
        <span className="min-w-0 flex-1 truncate font-semibold">{source.name}</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
          <Icon name="x" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={source.status === "running"} onClick={onRun} className={buttonClass.primary}>
            <Icon name={source.status === "running" ? "refresh" : "play"} className={`h-3.5 w-3.5 ${source.status === "running" ? "animate-spin" : ""}`} />
            {source.status === "running" ? "Running…" : "Run now"}
          </button>
          {incremental && (
            <button type="button" onClick={previewNext} disabled={next.loading} className={buttonClass.secondary}>
              <Icon name="eye" className="h-3.5 w-3.5" /> Preview next batch
            </button>
          )}
        </div>
        {error && <p className="rounded-md bg-bad/10 px-2.5 py-1.5 text-xs text-bad">{error}</p>}
        {next.loading && <p className="text-xs text-muted">Querying the new rows…</p>}
        {next.error && <p className="rounded-md bg-bad/10 px-2.5 py-1.5 text-xs text-bad">{next.error}</p>}
        {next.data && <BatchView batch={next.data} title={`${source.name} — next batch`} />}

        <dl className="space-y-2">
          {info.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[7.5rem_1fr] gap-2">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="min-w-0 break-words text-xs">{v}</dd>
            </div>
          ))}
        </dl>

        <ModeSwitch source={source} act={act} />
        {incremental && source.config.cursor_column === DELTA_CURSOR && <DeltaWriteSwitch source={source} act={act} />}

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Frequency</span>
            <select
              value={source.config.frequency}
              onChange={(e) => act(() => api.dataSources.updateSource(source.id, { frequency: e.target.value as Frequency }))}
              className={`${inputClass} py-1 text-xs`}
            >
              {Object.entries(FREQUENCY_LABEL).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {!incremental && (
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Snapshot behavior</span>
              <select
                value={source.config.snapshot_behavior}
                onChange={(e) => act(() => api.dataSources.updateSource(source.id, { snapshot_behavior: e.target.value as "replace" | "new" }))}
                className={`${inputClass} py-1 text-xs`}
              >
                <option value="replace">Replace target</option>
                <option value="new">Create new snapshot</option>
              </select>
            </label>
          )}
        </div>
        <AdvancedSyncOptions
          compact
          value={source.config}
          incremental={incremental}
          onChange={(change) => act(() => api.dataSources.updateSource(source.id, { ...change, max_duration_minutes: change.max_duration_minutes ?? undefined }))}
        />

        <SyncChecks resourceId={`source:${source.id}`} refreshKey={`${source.status}:${source.last_run?.id ?? ""}`} />

        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Runs</h4>
          {!source.runs?.length ? (
            <p className="text-xs text-muted">No runs yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {source.runs.map((r) => (
                <li key={r.id} className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={r.status === "completed" ? "text-ok" : r.status === "failed" ? "text-bad" : "text-ocean"}>
                      {r.status === "running" ? "Running" : r.status === "completed" ? "Completed" : "Failed"}
                    </span>
                    {r.transaction && (
                      <span className={`rounded px-1 font-mono text-[10px] ring-1 ${r.transaction === "SNAPSHOT" ? "text-sand ring-sand/40" : "text-ocean ring-ocean/40"}`}>
                        {r.transaction}
                      </span>
                    )}
                    <span className="text-muted">· {r.trigger}</span>
                    <span className="ml-auto text-muted">{when(r.started_at)}</span>
                  </div>
                  <div className="mt-0.5 text-soft">
                    {r.status === "completed" && !r.transaction ? "nothing new — no transaction" : `${r.rows.toLocaleString()} rows`}
                    {(r.from || r.to) && (
                      <span className="text-muted">
                        {" "}
                        · {r.from ?? "start"} → {r.to ?? "—"}
                      </span>
                    )}
                  </div>
                  {r.error && <div className="mt-0.5 break-words text-bad">{r.error}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          {incremental && (source.state.last_cursor || source.state.view_files > 0) && !source.state.resync && (
            <button
              type="button"
              disabled={source.status === "running"}
              title="Re-read everything after the initial value as one SNAPSHOT that replaces the dataset — for rows missed or changed below the cursor"
              onClick={async () =>
                (await confirmDialog(
                  "Re-sync from the initial value?\n\nThe next run is a SNAPSHOT: it reads every row after the initial value and replaces the dataset (no duplicates). Later runs append again.",
                )) && act(() => api.dataSources.resetCursor(source.id))
              }
              className={`${buttonClass.secondary} text-xs`}
            >
              <Icon name="restore" className="h-3.5 w-3.5" /> Re-sync from start
            </button>
          )}
          <button type="button" disabled={source.status === "running"} onClick={remove} className={`${buttonClass.secondary} text-xs hover:text-bad`}>
            <Icon name="trash" className="h-3.5 w-3.5" /> Delete data source
          </button>
        </div>
      </div>
    </aside>
  );
}
