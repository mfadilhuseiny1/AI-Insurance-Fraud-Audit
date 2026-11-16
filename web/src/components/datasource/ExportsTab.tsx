"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type DataSource, type Frequency } from "@/lib/api";
import { EXPORT_MODES, RECORD_EXPORT_MODES, exportsApi, type DatasetRef, type ExportMode, type TableExport } from "@/lib/dataConnection";
import { when } from "@/lib/format";
import { DrivePicker } from "../DrivePicker";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field, Panel } from "../pipeline/ui";
import { ConnectorLogo, FREQUENCY_LABEL } from "./ConnectorLogo";
import { useLoad } from "./DataSourceWizard";
import { EmptyState, ErrorLine, FREQUENCIES, RunStatus, TabPage } from "./dcui";
import { SyncCheckBadge, SyncChecks, useSyncCheckStatus } from "./SyncChecks";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

const MODE_LABEL = Object.fromEntries(EXPORT_MODES.map((m) => [m.id, m.label])) as Record<ExportMode, string>;

/** Table exports: datasets written to tables of external databases, or as records into applications (Salesforce, HubSpot, …). */
export function ExportsTab() {
  const list = useLoad("exports", () => exportsApi.list());
  const [creating, setCreating] = useState(false);
  // a link to an export (an in-app sync check notification: /sources?export=<id>) opens it
  const [open, setOpen] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("export")));
  const rows = list.data ?? list.last;
  const running = rows?.some((e) => e.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(list.retry, 2000);
    return () => clearInterval(t);
  }, [running, list.retry]);
  const selected = rows?.find((e) => e.id === open) ?? null;
  // health check states, re-read as runs finish
  const checkStatus = useSyncCheckStatus(rows?.map((e) => `${e.id}:${e.status}:${e.last_run?.id ?? ""}`).join(","));

  return (
    <div className="flex min-h-0 flex-1">
      <TabPage
        title="Exports"
        description="Write a dataset into an existing table of an external SQL database (a run commits all its rows or none), or as records into an application such as Salesforce, HubSpot or Airtable through its write API — on demand or on a schedule. The export mode decides what each run writes."
        actions={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" /> New export
          </button>
        }
      >
        {list.error && <ErrorLine text={list.error} onRetry={list.retry} />}
        {!rows ? (
          !list.error && <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState icon="upload" title="No exports yet" text="Mirror a cleaned dataset into a data warehouse table, or push only new rows to a table another system consumes." action={<button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}><Icon name="plus" /> New export</button>} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-panel text-left text-xs text-muted">
                <tr>
                  {["Name", "Dataset", "Destination", "Mode", "Last run", "Schedule", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-2.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} onClick={() => setOpen(e.id)} className={`cursor-pointer border-t border-line ${open === e.id ? "bg-ocean/10" : "hover:bg-panel/60"}`}>
                    <td className="px-4 py-2.5 font-medium">{e.name}</td>
                    <td className="max-w-[14rem] truncate px-4 py-2.5 text-xs text-soft" title={e.dataset.path}>
                      {e.dataset.name}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className="flex items-center gap-2">
                        <ConnectorLogo kind={e.connection.kind} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-soft">{e.schema ? `${e.schema}.` : ""}{e.table}</span>
                          <span className="block truncate text-muted">{e.connection.name}</span>
                        </span>
                      </span>
                    </td>
                    <td className="max-w-[12rem] truncate px-4 py-2.5 text-xs text-soft">{MODE_LABEL[e.mode]}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {e.status === "running" ? <RunStatus status="running" /> : <RunStatus status={e.last_run?.status} at={e.last_run?.finished_at} error={e.last_run?.error} detail={e.last_run ? `${e.last_run.rows.toLocaleString()} rows` : undefined} />}
                      <SyncCheckBadge status={checkStatus[`export:${e.id}`]} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-soft">
                      {FREQUENCY_LABEL[e.frequency]}
                      {e.next_run_at && <span className="block text-muted">next {when(e.next_run_at)}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        type="button"
                        disabled={e.status === "running"}
                        onClick={async () => {
                          try {
                            await exportsApi.run(e.id);
                            list.retry();
                          } catch (err) {
                            void alertDialog((err as Error).message);
                          }
                        }}
                        className={`${buttonClass.secondary} py-1 text-xs`}
                      >
                        <Icon name="play" className="h-3 w-3" /> Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TabPage>
      {selected && <ExportPanel key={selected.id} id={selected.id} onClose={() => setOpen(null)} onChanged={list.retry} />}
      {creating && (
        <NewExport
          onClose={() => setCreating(false)}
          onCreated={(e) => {
            setCreating(false);
            list.retry();
            setOpen(e.id);
          }}
        />
      )}
    </div>
  );
}

function ExportPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [nonce, setNonce] = useState(0);
  const e = useLoad(`export:${id}:${nonce}`, () => exportsApi.get(id));
  const x = e.data ?? e.last;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (x?.status !== "running") return;
    const t = setInterval(() => setNonce((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [x?.status]);
  const change = async (c: { mode?: ExportMode; frequency?: Frequency }) => {
    setError(null);
    try {
      await exportsApi.update(id, c);
      setNonce((n) => n + 1);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title={x?.name ?? "Export"} icon="upload" onClose={onClose} width="w-[26rem]">
      {!x ? (
        <p className="p-4 text-sm text-muted">{e.error ?? "Loading…"}</p>
      ) : (
        <div className="space-y-4 overflow-y-auto p-4 text-sm">
          <div className="space-y-1 text-xs">
            <div className="text-muted">Dataset</div>
            <div className="text-soft">{x.dataset.name}</div>
            <div className="text-muted">{x.dataset.path}</div>
            <div className="pt-2 text-muted">Destination</div>
            <div className="text-soft">
              {x.connection.name} · {x.database ? `${x.database}.` : ""}
              {x.schema ? `${x.schema}.` : ""}
              {x.table}
            </div>
            {x.key && (
              <>
                <div className="pt-2 text-muted">Key field</div>
                <div className="text-soft">{x.key} (records are created or updated by it)</div>
              </>
            )}
            <div className="pt-2 text-muted">Exported</div>
            <div className="text-soft">
              {x.state.exported_rows.toLocaleString()} rows of the current dataset view · {x.state.runs} run{x.state.runs === 1 ? "" : "s"}
            </div>
          </div>
          <Field label="Export mode">
            <select value={x.mode} onChange={(ev) => change({ mode: ev.target.value as ExportMode })} className={inputClass}>
              {EXPORT_MODES.filter((m) => x.connection.export_kind !== "records" || RECORD_EXPORT_MODES.includes(m.id)).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted">{EXPORT_MODES.find((m) => m.id === x.mode)?.hint}</span>
          </Field>
          <Field label="Schedule">
            <select value={x.frequency} onChange={(ev) => change({ frequency: ev.target.value as Frequency })} className={inputClass}>
              {FREQUENCIES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {error && <p className="text-xs text-bad">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={x.status === "running"}
              onClick={async () => {
                try {
                  await exportsApi.run(id);
                  setNonce((n) => n + 1);
                  onChanged();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              <Icon name={x.status === "running" ? "refresh" : "play"} className={`h-3.5 w-3.5 ${x.status === "running" ? "animate-spin" : ""}`} /> {x.status === "running" ? "Running…" : "Run now"}
            </button>
            <Link
              href={`/data-health?add=${encodeURIComponent(`dc_sync:export:${x.id}`)}&name=${encodeURIComponent(x.name)}`}
              title="Sync status and sync freshness checks in Data Health"
              className={buttonClass.secondary}
            >
              <Icon name="bell" className="h-3.5 w-3.5" /> Monitor
            </Link>
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog(`Delete the export "${x.name}"? The external ${x.connection.export_kind === "records" ? "records are" : "table is"} not changed.`))) return;
                try {
                  await exportsApi.remove(id);
                  onChanged();
                  onClose();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
              className={buttonClass.secondary}
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
          <SyncChecks resourceId={`export:${id}`} refreshKey={`${x.status}:${x.runs?.[0]?.id ?? ""}`} />
          <div>
            <div className="mb-1 text-xs font-medium text-soft">History</div>
            {!x.runs?.length ? (
              <p className="text-xs text-muted">No runs yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {x.runs.map((r) => (
                  <li key={r.id} className="rounded-md border border-line-2 p-2 text-xs">
                    <div className="flex items-center gap-2">
                      <RunStatus status={r.status} at={r.finished_at ?? r.started_at} error={r.error} detail={`${r.rows.toLocaleString()} rows`} />
                      {r.truncated && <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">truncated</span>}
                      <span className="ml-auto text-muted">{r.trigger}</span>
                    </div>
                    {r.detail && <div className="mt-1 text-muted">{r.detail}</div>}
                    {r.error && <div className="mt-1 break-words text-bad">{r.error}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function NewExport({ onClose, onCreated }: { onClose: () => void; onCreated: (e: TableExport) => void }) {
  const conns = useLoad("conns", () => api.dataSources.connections());
  const sources = useLoad("sources", () => api.dataSources.sources());
  const [name, setName] = useState("");
  const [dataset, setDataset] = useState<(DatasetRef & { label: string }) | null>(null);
  const [picking, setPicking] = useState(false);
  const [connId, setConnId] = useState("");
  const conn = conns.data?.find((c) => c.id === connId);
  const specs = useLoad("connectors", () => api.dataSources.connectors());
  // an application (Salesforce, HubSpot, …): records through its write API, no schemas, no truncation
  const app = specs.data?.find((s) => s.id === conn?.kind)?.export_kind === "records";
  const [database, setDatabase] = useState("");
  const [schema, setSchema] = useState("");
  const [table, setTable] = useState("");
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<ExportMode>("mirror");
  const [frequency, setFrequency] = useState<Frequency>("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const databases = useLoad(connId && app ? `databases:${connId}` : null, () => api.dataSources.databases(connId));
  const db = database || (app ? (databases.data?.[0] ?? "") : String(conn?.config.database ?? ""));
  const sch = app ? db : schema;
  const schemas = useLoad(connId && !app ? `schemas:${connId}:${db}` : null, () => api.dataSources.schemas(connId, db));
  const tables = useLoad(connId && sch ? `tables:${connId}:${db}:${sch}` : null, () => api.dataSources.tables(connId, db, sch));
  const modes = app ? EXPORT_MODES.filter((m) => RECORD_EXPORT_MODES.includes(m.id)) : EXPORT_MODES;
  const chosenMode: ExportMode = app && !RECORD_EXPORT_MODES.includes(mode) ? "incremental" : mode;

  const create = async () => {
    if (!dataset || !conn) return;
    setBusy(true);
    setError(null);
    try {
      const { label: _label, ...ref } = dataset;
      void _label;
      onCreated(
        await exportsApi.create({
          name: name.trim() || `${dataset.label} export`,
          connection_id: conn.id,
          dataset: ref as DatasetRef,
          database: db,
          schema: sch,
          table,
          mode: chosenMode,
          frequency,
          ...(app && key.trim() ? { key: key.trim() } : {}),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New export" icon="upload" onClose={onClose} wide>
      <div className="max-h-[75vh] space-y-4 overflow-y-auto p-5 text-sm">
        <Field label="Dataset to export" required hint="A Parquet dataset in Files (written by a pipeline or uploaded), a data source, or a View.">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setPicking(true)} className={buttonClass.secondary}>
              <Icon name="folder" className="h-3.5 w-3.5" /> Choose in Files…
            </button>
            <select
              value={dataset?.kind === "source" ? dataset.id : ""}
              onChange={(e) => {
                const s = sources.data?.find((x: DataSource) => x.id === e.target.value);
                if (s) setDataset({ kind: "source", id: s.id, label: s.name });
              }}
              className={`${inputClass} w-64`}
            >
              <option value="">…or a data source</option>
              {(sources.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {dataset && (
              <span className="flex items-center gap-1.5 rounded-md bg-ocean/10 px-2 py-1 text-xs text-white">
                <Icon name="table" className="h-3.5 w-3.5 text-ocean" /> {dataset.label}
              </span>
            )}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Destination connection" required hint={conn && !conn.exports_enabled ? undefined : "Only connections with exports enabled (Connections tab)."}>
            <select value={connId} onChange={(e) => (setConnId(e.target.value), setSchema(""), setTable(""), setDatabase(""), setKey(""))} className={inputClass}>
              <option value="">Choose…</option>
              {(conns.data ?? []).map((c) => (
                <option key={c.id} value={c.id} disabled={!c.exports_enabled}>
                  {c.name} ({c.kind_name}){c.exports_enabled ? "" : " — exports not enabled"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Export name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={dataset ? `${dataset.label} export` : "Orders to warehouse"} className={inputClass} />
          </Field>
          {conn && app && (
            <>
              {(databases.data?.length ?? 0) > 1 && (
                <Field label="Base" required>
                  <select value={db} onChange={(e) => (setDatabase(e.target.value), setTable(""))} className={inputClass}>
                    {(databases.data ?? []).map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Object" required hint="Each row becomes a record; columns must be fields a record can set (matched case-insensitively). Empty values are left out.">
                <select value={table} onChange={(e) => setTable(e.target.value)} className={inputClass}>
                  <option value="">{tables.loading || databases.loading ? "Loading…" : "Choose…"}</option>
                  {(tables.data ?? []).map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.comment && t.comment !== t.name ? `${t.name} — ${t.comment}` : t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Key field" hint="Optional. Create or update records by this dataset column (Salesforce: an external ID field; HubSpot: a unique property such as email). Empty: every row creates a record.">
                <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. email" className={inputClass} />
              </Field>
              <Field label="Schedule">
                <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className={inputClass}>
                  {FREQUENCIES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {conn && !app && (
            <>
              <Field label="Database" hint="Empty: the connection's database.">
                <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={String(conn.config.database ?? "")} className={inputClass} />
              </Field>
              <Field label="Schema" required>
                <select value={schema} onChange={(e) => (setSchema(e.target.value), setTable(""))} className={inputClass}>
                  <option value="">{schemas.loading ? "Loading…" : "Choose…"}</option>
                  {(schemas.data ?? []).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Table" required hint="The table must exist, with the dataset's column names (case-sensitive) and compatible types.">
                <select value={table} onChange={(e) => setTable(e.target.value)} className={inputClass} disabled={!schema}>
                  <option value="">{tables.loading ? "Loading…" : "Choose…"}</option>
                  {(tables.data ?? [])
                    .filter((t) => t.kind === "table")
                    .map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                </select>
              </Field>
              <Field label="Schedule">
                <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className={inputClass}>
                  {FREQUENCIES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Export mode</div>
          {app && (
            <p className="mb-1.5 text-xs text-muted">
              Applications cannot be truncated, and a run is not one transaction: records written before a failure stay, and incremental runs continue after them.
            </p>
          )}
          <div className="space-y-1">
            {modes.map((m) => (
              <label key={m.id} className={`flex cursor-pointer items-start gap-2 rounded-md p-2 ${chosenMode === m.id ? "bg-ocean/10 ring-1 ring-ocean/40" : "hover:bg-panel-2"}`}>
                <input type="radio" checked={chosenMode === m.id} onChange={() => setMode(m.id)} className="mt-0.5 accent-[var(--color-ocean)]" />
                <span>
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-xs text-muted">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        {error && <ErrorLine text={error} />}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || !dataset || !conn || !sch || !table} onClick={create} className={buttonClass.primary}>
            <Icon name={busy ? "refresh" : "check"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Checking the table…" : "Create export"}
          </button>
        </div>
      </div>
      {picking && (
        <DrivePicker
          title="Choose the dataset to export"
          canPick={(i) => (i.kind === "file" && /\.(parquet|view)$/i.test(i.name) ? null : "Exports read Parquet datasets and Views")}
          onPick={(i) => {
            setDataset(/\.view$/i.test(i.name) ? { kind: "view", item_id: i.id, label: i.name } : { kind: "file", item_id: i.id, label: i.name });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Modal>
  );
}
