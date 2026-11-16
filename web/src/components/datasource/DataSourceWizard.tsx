"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  type BatchPreview,
  type ConnectorSpec,
  type DataSource,
  type DbConnection,
  type Frequency,
  type IngestConfig,
  type SourceColumn,
  type TablePreview,
} from "@/lib/api";
import type { ColType, Table } from "@/lib/pipeline";
import { Icon, type IconName } from "../Icon";
import { DataPreview, TYPE_MARK } from "../pipeline/DataPreview";
import { buttonClass, inputClass } from "../pipeline/Modal";
import { Switch } from "../pipeline/ui";
import { CapabilityBadges, ConnectorInfoDialog } from "./ConnectorInfo";
import { OAuthSignIn } from "./FileTools";
import { approx, ConnectorLogo, FREQUENCY_LABEL, GROUP_LABEL } from "./ConnectorLogo";
import { confirmDialog } from "@/lib/dialogs";

type Step = "choose" | "connect" | "browse" | "ingest" | "review" | "done";
type Selection = { database: string; schema: string; table: string };
/** api/datasources.py DELTA_CURSOR: an incremental source following the delta links of an OData service with change tracking */
const DELTA_CURSOR = "!deltatoken";

const STEPS: { id: Step; label: string }[] = [
  { id: "choose", label: "Source" },
  { id: "connect", label: "Connection" },
  { id: "browse", label: "Table" },
  { id: "ingest", label: "Ingestion" },
  { id: "review", label: "Review" },
];

const asTable = (columns: { name: string; type: string }[], rows: Record<string, unknown>[]): Table => ({
  columns: columns.map((c) => ({ name: c.name, type: c.type as ColType })),
  rows: rows as Table["rows"],
});

/**
 * Connect a database and create a data source: choose a connector (or a saved connection) →
 * connection form and test → browse and preview a table → ingestion mode → review → first run.
 */
export function DataSourceWizard({
  onClose,
  onUse,
  useLabel = "Add to pipeline",
}: {
  onClose: () => void;
  /** offered once the first run has finished (e.g. add the dataset to a pipeline) */
  onUse?: (source: DataSource) => Promise<void> | void;
  useLabel?: string;
}) {
  const catalog = useLoad("catalog", () => Promise.all([api.dataSources.connectors(), api.dataSources.connections()]));
  const specs = catalog.data?.[0] ?? null;
  // saved connections, as loaded and then as added or deleted here
  const [edited, setConnections] = useState<DbConnection[] | null>(null);
  const connections = edited ?? catalog.data?.[1] ?? null;
  const loadError = catalog.error;
  const [step, setStep] = useState<Step>("choose");
  const [spec, setSpec] = useState<ConnectorSpec | null>(null);
  const [connection, setConnection] = useState<DbConnection | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  // null: every column
  const [columns, setColumns] = useState<string[] | null>(null);
  const [ingest, setIngest] = useState<IngestConfig>({ mode: "snapshot", batch_size: 10_000, frequency: "manual", snapshot_behavior: "replace", cursor_column: null, start_from: "" });
  const [batch, setBatch] = useState<BatchPreview | null>(null);
  const [created, setCreated] = useState<DataSource | null>(null);


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && step !== "done" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  const specOf = (kind: string) => specs?.find((s) => s.id === kind) ?? null;
  const at = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4">
      <div className="flex h-[min(92vh,880px)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Icon name="database" className="h-5 w-5 text-ocean" />
          <span className="text-sm font-semibold">Connect a database</span>
          {step !== "done" && (
            <ol className="ml-6 hidden items-center gap-1 text-xs md:flex">
              {STEPS.map((s, i) => (
                <li key={s.id} className="flex items-center gap-1">
                  <span
                    className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 ${
                      i === at ? "bg-ocean/15 text-ocean ring-1 ring-ocean/40" : i < at ? "text-soft" : "text-muted"
                    }`}
                  >
                    <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${i < at ? "bg-ok text-ink" : i === at ? "bg-ocean text-white" : "bg-panel-2 ring-1 ring-line-2"}`}>
                      {i < at ? <Icon name="check" className="h-3 w-3" /> : i + 1}
                    </span>
                    {s.label}
                  </span>
                  {i < STEPS.length - 1 && <Icon name="right" className="h-3 w-3 text-muted" />}
                </li>
              ))}
            </ol>
          )}
          <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-muted hover:bg-panel-2 hover:text-white" title="Close">
            <Icon name="x" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {loadError ? (
            <Problem message={`Could not load the connectors: ${loadError}`} onRetry={catalog.retry} />
          ) : !specs || !connections ? (
            <Loading text="Loading connectors…" />
          ) : step === "choose" ? (
            <ChooseStep
              specs={specs}
              connections={connections}
              onNew={(s) => {
                setSpec(s);
                setStep("connect");
              }}
              onSaved={(c) => {
                setConnection(c);
                setSpec(specOf(c.kind));
                setStep("browse");
              }}
              onDeleted={(id) => setConnections(connections.filter((c) => c.id !== id))}
            />
          ) : step === "connect" && spec ? (
            <ConnectStep
              spec={spec}
              onBack={() => setStep("choose")}
              onConnected={(c) => {
                setConnections([c, ...connections]);
                setConnection(c);
                setStep("browse");
              }}
            />
          ) : step === "browse" && connection && spec ? (
            <BrowseStep
              connection={connection}
              spec={spec}
              initial={selection}
              columns={columns}
              onColumns={setColumns}
              onBack={() => setStep("choose")}
              onSelect={(sel, p) => {
                const changed = sel.table !== selection?.table || sel.schema !== selection?.schema || sel.database !== selection?.database;
                setSelection(sel);
                setPreview(p);
                if (changed) {
                  setColumns(null);
                  setBatch(null);
                  const best = p?.columns.find((c) => c.recommended && (c.type === "Timestamp" || c.type === "Date")) ?? p?.columns.find((c) => c.recommended);
                  setIngest((x) => ({ ...x, cursor_column: best?.name ?? null, start_from: "" }));
                }
              }}
              onNext={() => setStep("ingest")}
            />
          ) : step === "ingest" && connection && selection && preview ? (
            <IngestStep
              connection={connection}
              selection={selection}
              preview={preview}
              columns={columns}
              ingest={ingest}
              onIngest={(patch) => {
                setIngest({ ...ingest, ...patch });
                if ("cursor_column" in patch || "start_from" in patch || "mode" in patch) setBatch(null);
              }}
              batch={batch}
              onBatch={setBatch}
              onBack={() => setStep("browse")}
              onNext={() => setStep("review")}
            />
          ) : step === "review" && connection && selection && preview ? (
            <ReviewStep
              connection={connection}
              selection={selection}
              preview={preview}
              columns={columns}
              ingest={ingest}
              batch={batch}
              onBack={() => setStep("ingest")}
              onCreated={(s) => {
                setCreated(s);
                setStep("done");
              }}
            />
          ) : step === "done" && created ? (
            <DoneStep initial={created} onClose={onClose} onUse={onUse} useLabel={useLabel} />
          ) : (
            <Problem message="Something is missing — start again." onRetry={() => setStep("choose")} retryLabel="Start again" />
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// shared bits

function Loading({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted">
      <Icon name="refresh" className="h-4 w-4 animate-spin" /> {text}
    </div>
  );
}

function Problem({ message, onRetry, retryLabel = "Retry" }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-xl items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="flex-1 break-words">{message}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="shrink-0 rounded px-2 text-xs font-medium underline hover:no-underline">
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function Footer({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-line bg-panel px-5 py-3">
      <div className="min-w-0 flex-1 text-xs text-muted">{note}</div>
      {children}
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-bad/10 px-2.5 py-1.5 text-xs text-bad">
      <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="break-words">{message}</span>
    </p>
  );
}

// ------------------------------------------------------------------------------------------------
// 1. choose a connector or a saved connection

function ChooseStep({
  specs,
  connections,
  onNew,
  onSaved,
  onDeleted,
}: {
  specs: ConnectorSpec[];
  connections: DbConnection[];
  onNew: (s: ConnectorSpec) => void;
  onSaved: (c: DbConnection) => void;
  onDeleted: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [info, setInfo] = useState<ConnectorSpec | null>(null);
  const q = search.trim().toLowerCase();
  const shown = specs.filter(
    (s) => (!onlyAvailable || s.available) && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
  );
  // available connectors first within each group
  const groups = Object.keys(GROUP_LABEL)
    .map((g) => ({ g, items: shown.filter((s) => s.group === g).sort((a, b) => Number(b.available) - Number(a.available)) }))
    .filter(({ items }) => items.length > 0);
  const remove = async (c: DbConnection) => {
    if (!(await confirmDialog(`Delete the saved connection "${c.name}"? Its credentials are removed.`))) return;
    try {
      await api.dataSources.deleteConnection(c.id);
      onDeleted(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      {connections.length > 0 && (
        <section className="mb-8">
          <h3 className="mb-1 text-sm font-semibold">Saved connections</h3>
          <p className="mb-3 text-xs text-muted">Pick a table from a database you already connected.</p>
          {error && <ErrorLine message={error} />}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {connections.map((c) => (
              <div key={c.id} className="group flex items-center gap-3 rounded-lg border border-line-2 bg-panel-2 p-3 hover:border-ocean/60">
                <button type="button" onClick={() => onSaved(c)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <ConnectorLogo kind={c.kind} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {c.kind_name}
                      {c.config.host ? ` · ${c.config.host}` : ""}
                      {c.config.database ? ` / ${c.config.database}` : ""}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => remove(c)}
                  title="Delete connection"
                  className="rounded p-1 text-muted opacity-0 hover:bg-bad/10 hover:text-bad group-hover:opacity-100"
                >
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      <h3 className="mb-1 text-sm font-semibold">New connection</h3>
      <p className="mb-3 text-xs text-muted">
        Choose the source to connect. Credentials are encrypted and never shown again after saving. Capabilities come from Foundry&apos;s connector
        catalog; green ones work on this server.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 flex-1 sm:max-w-sm">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${specs.length} connectors`} className={`${inputClass} pl-8`} />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} className="accent-[var(--color-ocean)]" />
          Available only ({specs.filter((s) => s.available).length})
        </label>
      </div>
      {groups.length === 0 && <p className="text-sm text-muted">No connector matches “{search}”.</p>}
      <div className="space-y-6">
        {groups.map(({ g, items }) => (
          <section key={g}>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{GROUP_LABEL[g]}</h4>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {items.map((s) => (
                <div
                  key={s.id}
                  className={`relative flex flex-col gap-2 rounded-lg border border-line-2 bg-panel-2 p-3 hover:border-ocean/60 hover:bg-panel ${s.available ? "" : "opacity-60 hover:opacity-90"}`}
                >
                  <button
                    type="button"
                    title={s.available ? s.description : `${s.unavailable} — click for its capabilities and configuration`}
                    onClick={() => (s.available ? onNew(s) : setInfo(s))}
                    className="flex items-center gap-3 pr-5 text-left"
                  >
                    <ConnectorLogo kind={s.id} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {s.name}
                        {s.beta && <span className="ml-1.5 align-middle text-[9px] font-medium uppercase text-warn">beta</span>}
                      </span>
                      <span className="block truncate text-xs text-muted">{s.available ? s.description : "Coming soon"}</span>
                    </span>
                  </button>
                  <CapabilityBadges spec={s} limit={4} />
                  <button
                    type="button"
                    onClick={() => setInfo(s)}
                    title="Capabilities and configuration"
                    className="absolute right-2 top-2 rounded p-0.5 text-muted hover:bg-panel-2 hover:text-white"
                  >
                    <Icon name="info" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {info && (
        <ConnectorInfoDialog
          spec={info}
          onClose={() => setInfo(null)}
          onConnect={() => {
            setInfo(null);
            onNew(info);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// 2. connection form and test

function ConnectStep({ spec, onBack, onConnected }: { spec: ConnectorSpec; onBack: () => void; onConnected: (c: DbConnection) => void }) {
  const [name, setName] = useState(`${spec.name} connection`);
  const [showInfo, setShowInfo] = useState(false);
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(spec.fields.map((f) => [f.name, f.default ?? (f.kind === "bool" ? false : "")])),
  );
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; message?: string; key?: string }>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const key = JSON.stringify(values);
  const missing = spec.fields.filter((f) => f.required && f.kind !== "bool" && (values[f.name] === "" || values[f.name] === null)).map((f) => f.label);
  const tested = test.state === "ok" && test.key === key;

  const run = async () => {
    setTest({ state: "testing", key });
    try {
      const r = await api.dataSources.testConnection(spec.id, values);
      setTest({ state: "ok", message: r.version, key });
    } catch (e) {
      setTest({ state: "error", message: (e as Error).message, key });
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      onConnected(await api.dataSources.createConnection(spec.id, name.trim(), values));
    } catch (e) {
      setSaveError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <form
          className="mx-auto max-w-xl space-y-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            if (!missing.length) run();
          }}
        >
          <div className="flex items-start gap-3">
            <ConnectorLogo kind={spec.id} size="lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div>
                <h3 className="text-base font-semibold">{spec.name}</h3>
                <p className="text-xs text-muted">{spec.description}</p>
              </div>
              <CapabilityBadges spec={spec} />
            </div>
            <button type="button" onClick={() => setShowInfo(true)} className="flex shrink-0 items-center gap-1 text-xs text-ocean hover:underline">
              <Icon name="info" className="h-3.5 w-3.5" /> Reference
            </button>
          </div>
          {showInfo && <ConnectorInfoDialog spec={spec} onClose={() => setShowInfo(false)} />}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-soft">Connection name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="BRIN PostgreSQL" />
          </label>
          <div className="grid grid-cols-6 gap-3">
            {spec.fields.map((f) => {
              const span = f.name === "port" ? "col-span-2" : f.name === "host" ? "col-span-4" : "col-span-6";
              const set = (v: string | number | boolean) => setValues({ ...values, [f.name]: v });
              if (f.kind === "bool")
                return (
                  <label key={f.name} className="col-span-6 flex cursor-pointer items-start gap-2 text-sm">
                    <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(e.target.checked)} className="mt-0.5 accent-[var(--color-ocean)]" />
                    <span>
                      {f.label}
                      {f.help && <span className="block text-xs text-muted">{f.help}</span>}
                    </span>
                  </label>
                );
              return (
                <label key={f.name} className={`block ${span}`}>
                  <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">
                    {f.label}
                    {!f.required && <span className="font-normal text-muted">(optional)</span>}
                    {f.secret && <Icon name="eye" className="h-3 w-3 text-muted" />}
                  </span>
                  {f.kind === "textarea" ? (
                    <textarea
                      rows={4}
                      value={String(values[f.name] ?? "")}
                      onChange={(e) => set(e.target.value)}
                      placeholder={f.placeholder}
                      className={`${inputClass} font-mono text-xs`}
                      spellCheck={false}
                    />
                  ) : f.kind === "select" ? (
                    <select value={String(values[f.name] ?? "")} onChange={(e) => set(e.target.value)} className={inputClass}>
                      {f.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.kind === "password" ? "password" : f.kind === "number" ? "number" : "text"}
                      autoComplete={f.kind === "password" ? "new-password" : "off"}
                      value={String(values[f.name] ?? "")}
                      onChange={(e) => set(f.kind === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                      placeholder={f.placeholder}
                      className={inputClass}
                    />
                  )}
                  {f.help && <span className="mt-0.5 block text-xs text-muted">{f.help}</span>}
                </label>
              );
            })}
            <OAuthSignIn spec={spec} values={values} onToken={(field, ref) => setValues((v) => ({ ...v, [field]: ref }))} />
          </div>

          <div className="flex items-center gap-3">
            <button type="submit" disabled={!!missing.length || test.state === "testing"} className={buttonClass.secondary}>
              <Icon name={test.state === "testing" ? "refresh" : "bolt"} className={`h-3.5 w-3.5 ${test.state === "testing" ? "animate-spin" : ""}`} />
              {test.state === "testing" ? "Testing…" : "Test connection"}
            </button>
            {missing.length > 0 && <span className="text-xs text-muted">Fill in {missing.join(", ")}.</span>}
          </div>
          {test.key === key && test.state === "ok" && (
            <p className="flex items-center gap-2 rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
              <Icon name="check" className="h-4 w-4" /> Connection successful
              {test.message && <span className="truncate text-xs text-soft">· {test.message}</span>}
            </p>
          )}
          {test.key === key && test.state === "error" && test.message && (
            <div className="space-y-1">
              <ErrorLine message={test.message} />
              <button type="button" onClick={run} className="text-xs text-ocean hover:underline">
                Retry
              </button>
            </div>
          )}
          {test.state !== "idle" && test.key !== key && <p className="text-xs text-warn">The settings changed — test the connection again.</p>}
          {saveError && <ErrorLine message={saveError} />}
        </form>
      </div>
      <Footer note={tested ? "The connection is saved (password encrypted) when you continue." : "Test the connection before continuing."}>
        <button type="button" onClick={onBack} className={buttonClass.secondary}>
          Back
        </button>
        <button type="button" disabled={!tested || !name.trim() || saving} onClick={save} className={buttonClass.primary}>
          {saving ? "Saving…" : "Continue"} <Icon name="right" className="h-3.5 w-3.5" />
        </button>
      </Footer>
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// 3. browse: database → schema → table, with a bounded preview

/**
 * Loads `fetch()` whenever `key` changes (null: nothing to load). Loading and errors are derived
 * from which key the last answer belongs to, so effects never set state synchronously.
 */
export function useLoad<T>(key: string | null, fetch: () => Promise<T>) {
  const [res, setRes] = useState<{ key: string; data?: T; error?: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const full = key === null ? null : `${key}#${nonce}`;
  useEffect(() => {
    if (full === null) return;
    let live = true;
    fetch()
      .then((data) => live && setRes({ key: full, data }))
      .catch((e: Error) => live && setRes({ key: full, error: e.message }));
    return () => {
      live = false;
    };
    // the key names everything the fetch depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);
  const current = res && res.key === full ? res : null;
  return {
    data: current?.data,
    error: current?.error,
    loading: full !== null && !current,
    /** the last answer, even for an earlier key (keeps a list visible while the next loads) */
    last: res?.data,
    retry: () => setNonce((n) => n + 1),
  };
}

function BrowseStep({
  connection,
  spec,
  initial,
  columns,
  onColumns,
  onBack,
  onSelect,
  onNext,
}: {
  connection: DbConnection;
  spec: ConnectorSpec;
  initial: Selection | null;
  columns: string[] | null;
  onColumns: (c: string[] | null) => void;
  onBack: () => void;
  onSelect: (s: Selection, preview: TablePreview | null) => void;
  onNext: () => void;
}) {
  const [pickedDb, setPickedDb] = useState(initial?.database ?? "");
  const [pickedSchema, setPickedSchema] = useState(initial?.schema ?? "");
  const [table, setTable] = useState(initial?.table ?? "");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"data" | "columns">("data");

  const databases = useLoad(connection.id, () => api.dataSources.databases(connection.id));
  const own = String(connection.config.database ?? "");
  const database = pickedDb || (databases.data ? (databases.data.includes(own) ? own : databases.data[0] ?? "") : "");

  // MySQL-style connectors: the database is the schema
  const schemas = useLoad(spec.schemas && database ? `${connection.id}/${database}` : null, () => api.dataSources.schemas(connection.id, database));
  const schemaList = spec.schemas ? schemas.data : database ? [database] : undefined;
  const schema = !spec.schemas
    ? database
    : schemaList?.includes(pickedSchema)
      ? pickedSchema
      : schemaList?.includes("public")
        ? "public"
        : schemaList?.includes("dbo")
          ? "dbo"
          : (schemaList?.[0] ?? "");

  // search waits for typing to pause
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const tables = useLoad(database && schema ? JSON.stringify([connection.id, database, schema, query]) : null, () =>
    api.dataSources.tables(connection.id, database, schema, query),
  );
  const tableList = tables.data ?? (tables.loading ? tables.last : undefined);

  // the selected table's preview: the server reads at most 100 rows
  const preview = useLoad(database && schema && table ? JSON.stringify([connection.id, database, schema, table]) : null, () =>
    api.dataSources.preview(connection.id, database, schema, table).then((p) => {
      onSelect({ database, schema, table }, p);
      return p;
    }),
  );

  const listed = tableList?.find((t) => t.name === table);
  const chosen = columns ?? preview.data?.columns.map((c) => c.name) ?? [];
  const toggle = (name: string) => {
    const all = preview.data?.columns.map((c) => c.name) ?? [];
    const next = chosen.includes(name) ? chosen.filter((c) => c !== name) : all.filter((c) => c === name || chosen.includes(c));
    onColumns(next.length === all.length ? null : next);
  };

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-line">
          <div className="space-y-2 border-b border-line p-3">
            <div className="flex items-center gap-2 text-xs text-muted">
              <ConnectorLogo kind={connection.kind} size="sm" />
              <span className="truncate text-sm text-white">{connection.name}</span>
            </div>
            {databases.error ? (
              <div>
                <ErrorLine message={databases.error} />
                <button type="button" onClick={databases.retry} className="mt-1 text-xs text-ocean hover:underline">
                  Retry
                </button>
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Database</span>
                <select
                  value={database}
                  disabled={!databases.data}
                  onChange={(e) => {
                    setPickedDb(e.target.value);
                    setPickedSchema("");
                    setTable("");
                  }}
                  className={`${inputClass} py-1 text-xs`}
                >
                  {!databases.data && <option>Loading…</option>}
                  {databases.data?.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
            )}
            {spec.schemas && (
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Schema</span>
                <select
                  value={schema}
                  disabled={!schemas.data}
                  onChange={(e) => {
                    setPickedSchema(e.target.value);
                    setTable("");
                  }}
                  className={`${inputClass} py-1 text-xs`}
                >
                  {schemas.loading && <option>Loading…</option>}
                  {schemas.data?.length === 0 && <option value="">No readable schemas</option>}
                  {schemas.data?.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                {schemas.error && (
                  <div className="mt-1">
                    <ErrorLine message={schemas.error} />
                    <button type="button" onClick={schemas.retry} className="mt-1 text-xs text-ocean hover:underline">
                      Retry
                    </button>
                  </div>
                )}
              </label>
            )}
            <label className="flex items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1 text-xs">
              <Icon name="search" className="h-3.5 w-3.5 text-muted" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tables…" className="min-w-0 flex-1 bg-transparent outline-none" />
              {tables.loading && <Icon name="refresh" className="h-3 w-3 animate-spin text-muted" />}
            </label>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {tables.error && (
              <li className="p-2">
                <ErrorLine message={tables.error} />
                <button type="button" onClick={tables.retry} className="mt-1 text-xs text-ocean hover:underline">
                  Retry
                </button>
              </li>
            )}
            {!tableList && tables.loading && <li className="p-4 text-center text-xs text-muted">Loading tables…</li>}
            {tableList?.length === 0 && (
              <li className="p-4 text-center text-xs text-muted">{query ? `No tables match “${query}”.` : "No readable tables in this schema."}</li>
            )}
            {tableList?.map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={() => setTable(t.name)}
                  title={t.comment ?? undefined}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${t.name === table ? "bg-ocean/15 ring-1 ring-ocean/40" : "hover:bg-panel-2"}`}
                >
                  <Icon name={t.kind === "view" ? "eye" : "table"} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${t.name === table ? "text-ocean" : "text-muted"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{t.name}</span>
                    {t.comment && <span className="block truncate text-[11px] text-muted">{t.comment}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted" title={t.kind === "view" ? undefined : "Estimated rows"}>
                    {t.kind === "view" ? "view" : approx(t.rows)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {!table ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted">
              <Icon name="table" className="h-8 w-8 text-line-2" />
              Select a table to preview it.
              <span className="text-xs">Only the first 100 rows are read — never the whole table.</span>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon name={listed?.kind === "view" ? "eye" : "table"} className="h-4 w-4 text-ocean" />
                    <span className="truncate font-semibold">{table}</span>
                    <span className="truncate text-xs text-muted">{spec.schemas ? `${database} / ${schema}` : database}</span>
                  </div>
                  {(preview.data?.comment ?? listed?.comment) && <p className="mt-0.5 truncate text-xs text-muted">{preview.data?.comment ?? listed?.comment}</p>}
                </div>
                <div className="ml-auto flex items-center gap-4 text-xs">
                  <span>
                    <span className="text-muted">Rows </span>
                    <span className="tabular-nums">
                      {preview.data?.rows_estimate != null ? preview.data.rows_estimate.toLocaleString() : listed?.kind === "view" ? "view" : "unknown"}
                    </span>
                    {preview.data?.rows_estimate != null && <span className="text-muted"> (estimate)</span>}
                  </span>
                  <span>
                    <span className="text-muted">Columns </span>
                    {preview.data ? (columns ? `${columns.length} of ${preview.data.columns.length}` : preview.data.columns.length) : "…"}
                  </span>
                  <button type="button" onClick={preview.retry} disabled={preview.loading} className={`${buttonClass.secondary} py-1 text-xs`}>
                    <Icon name="refresh" className={`h-3.5 w-3.5 ${preview.loading ? "animate-spin" : ""}`} /> Refresh preview
                  </button>
                </div>
              </div>
              <div className="flex gap-1 border-b border-line px-3 pt-2 text-xs">
                {(
                  [
                    ["data", "Sample data"],
                    ["columns", "Columns"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={`-mb-px rounded-t-md border px-3 py-1.5 ${tab === id ? "border-line border-b-panel bg-panel text-white" : "border-transparent text-muted hover:text-white"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {preview.loading ? (
                <Loading text="Reading the first 100 rows…" />
              ) : preview.error ? (
                <Problem message={preview.error} onRetry={preview.retry} />
              ) : preview.data && tab === "data" ? (
                preview.data.rows.length ? (
                  <div className="flex min-h-0 flex-1">
                    <DataPreview table={asTable(preview.data.columns, preview.data.rows)} title={table} />
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted">The table is empty.</div>
                )
              ) : preview.data ? (
                <ColumnList columns={preview.data.columns} chosen={chosen} onToggle={toggle} onAll={(all) => onColumns(all ? null : [])} />
              ) : null}
            </>
          )}
        </section>
      </div>
      <Footer note={table && preview.data ? `Preview: ${preview.data.rows.length} rows (LIMIT 100).` : undefined}>
        <button type="button" onClick={onBack} className={buttonClass.secondary}>
          Back
        </button>
        <button type="button" disabled={!preview.data || chosen.length === 0} onClick={onNext} className={buttonClass.primary}>
          Continue <Icon name="right" className="h-3.5 w-3.5" />
        </button>
      </Footer>
    </>
  );
}

function ColumnList({ columns, chosen, onToggle, onAll }: { columns: SourceColumn[]; chosen: string[]; onToggle: (n: string) => void; onAll: (all: boolean) => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-muted">
        {chosen.length} of {columns.length} columns will be ingested
        <button type="button" onClick={() => onAll(true)} className="text-ocean hover:underline">
          Select all
        </button>
        <button type="button" onClick={() => onAll(false)} className="text-ocean hover:underline">
          Select none
        </button>
      </div>
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
          <tr>
            <th className="w-8 px-4 py-1.5" />
            <th className="px-2 py-1.5 font-medium">Column</th>
            <th className="px-2 py-1.5 font-medium">Database type</th>
            <th className="px-2 py-1.5 font-medium">Dataset type</th>
            <th className="px-2 py-1.5 font-medium">Nullable</th>
            <th className="px-2 py-1.5 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="border-t border-line hover:bg-panel-2/60">
              <td className="px-4 py-1.5">
                <input type="checkbox" checked={chosen.includes(c.name)} onChange={() => onToggle(c.name)} className="accent-[var(--color-ocean)]" />
              </td>
              <td className="px-2 py-1.5">
                {c.name}
                {c.recommended && c.cursor && <span className="ml-2 rounded bg-sand/15 px-1.5 py-0.5 text-[10px] text-sand">cursor</span>}
              </td>
              <td className="px-2 py-1.5 font-mono text-xs text-soft">{c.db_type}</td>
              <td className="px-2 py-1.5 text-xs text-soft">
                <span className="mr-1.5 font-mono text-muted">{TYPE_MARK[c.type as ColType] ?? ""}</span>
                {c.type}
              </td>
              <td className="px-2 py-1.5 text-xs text-soft">{c.nullable ? "Yes" : "No"}</td>
              <td className="max-w-xs truncate px-2 py-1.5 text-xs text-muted" title={c.comment ?? undefined}>
                {c.comment}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// 4. ingestion mode

function Flow({ steps }: { steps: string[] }) {
  return (
    <div className="mt-3 flex flex-col items-start gap-0.5 font-mono text-[11px] text-soft">
      {steps.map((s, i) => (
        <span key={i} className="flex flex-col items-start">
          <span className="rounded border border-line-2 bg-ink px-2 py-0.5">{s}</span>
          {i < steps.length - 1 && <span className="pl-3 text-muted">↓</span>}
        </span>
      ))}
    </div>
  );
}

function ModeCard({ active, title, icon, children, onClick }: { active: boolean; title: string; icon: IconName; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 flex-col rounded-lg border p-4 text-left ${active ? "border-ocean bg-ocean/10 ring-1 ring-ocean/40" : "border-line-2 bg-panel-2 hover:border-ocean/50"}`}
    >
      <span className="flex items-center gap-2 font-medium">
        <span className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${active ? "border-ocean" : "border-line-2"}`}>
          {active && <span className="h-1.5 w-1.5 rounded-full bg-ocean" />}
        </span>
        <Icon name={icon} className="h-4 w-4 text-ocean" />
        {title}
      </span>
      {children}
    </button>
  );
}

const START_HINT: Record<string, string> = {
  Timestamp: "2026-10-01 00:00:00",
  Date: "2026-10-01",
};

function IngestStep({
  connection,
  selection,
  preview,
  columns,
  ingest,
  onIngest,
  batch,
  onBatch,
  onBack,
  onNext,
}: {
  connection: DbConnection;
  selection: Selection;
  preview: TablePreview;
  columns: string[] | null;
  ingest: IngestConfig;
  onIngest: (patch: Partial<IngestConfig>) => void;
  batch: BatchPreview | null;
  onBatch: (b: BatchPreview | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useMemo(
    () =>
      preview.columns
        .filter((c) => c.cursor)
        .sort(
          (a, b) =>
            Number(b.recommended) - Number(a.recommended) ||
            Number(/updat|modif|change/i.test(b.name)) - Number(/updat|modif|change/i.test(a.name)),
        ),
    [preview.columns],
  );
  const cursor = preview.columns.find((c) => c.name === ingest.cursor_column);
  const incremental = ingest.mode === "incremental";
  const deltaMode = ingest.cursor_column === DELTA_CURSOR;
  const ready = !incremental || !!cursor || deltaMode;

  const previewBatch = async () => {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      onBatch(
        await api.dataSources.incrementalPreview(connection.id, {
          ...selection,
          cursor_column: cursor.name,
          start_from: ingest.start_from?.trim() || null,
          columns,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      onBatch(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <div>
            <h3 className="text-base font-semibold">How should this data be ingested?</h3>
            <p className="text-xs text-muted">
              {selection.schema}.{selection.table} · ~{approx(preview.rows_estimate)} rows · {columns?.length ?? preview.columns.length} columns
            </p>
          </div>
          <div className="flex flex-col gap-3 md:flex-row">
            <ModeCard active={!incremental} title="Snapshot" icon="layers" onClick={() => onIngest({ mode: "snapshot" })}>
              <span className="mt-2 text-sm text-soft">Copy the current state of the table on each run.</span>
              <span className="mt-1 text-xs text-muted">
                Each run is a <b>SNAPSHOT</b> transaction: the whole table is read (streamed in batches) and the new file replaces the dataset&apos;s
                current view. For tables that hold the current state — projects, customers, settings — or tables whose rows are updated and deleted.
              </span>
              <Flow steps={["Source table", "SNAPSHOT (entire table)", "Replaces the dataset view"]} />
            </ModeCard>
            <ModeCard active={incremental} title="Incremental (Append)" icon="clock" onClick={() => onIngest({ mode: "incremental" })}>
              <span className="mt-2 text-sm text-soft">Only ingest records added since the previous successful run.</span>
              <span className="mt-1 text-xs text-muted">
                Each run is an <b>APPEND</b> transaction: only rows past the saved cursor are read and added as a new file; files already in the
                dataset are never modified. For append-only data — events, logs, sensor readings, time series.
              </span>
              <Flow steps={["Previous run", "Its maximum cursor value", "WHERE cursor > that value", "APPEND to the dataset view"]} />
            </ModeCard>
          </div>

          {incremental ? (
            <section className="space-y-4 rounded-lg border border-line-2 p-4">
              <h4 className="text-sm font-semibold">Incremental configuration</h4>
              {candidates.length === 0 && !preview.delta ? (
                <ErrorLine message="This table has no timestamp, date or integer column to use as a cursor. Use a snapshot instead." />
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-soft">Incremental column</span>
                    <select value={ingest.cursor_column ?? ""} onChange={(e) => onIngest({ cursor_column: e.target.value || null })} className={inputClass}>
                      <option value="">Choose a column…</option>
                      {preview.delta && <option value={DELTA_CURSOR}>Delta token — the service&apos;s change tracking (SAP ODP / OData)</option>}
                      {candidates.some((c) => c.recommended) && (
                        <optgroup label="Recommended">
                          {candidates
                            .filter((c) => c.recommended)
                            .map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name} — {c.db_type}
                              </option>
                            ))}
                        </optgroup>
                      )}
                      {candidates.some((c) => !c.recommended) && (
                        <optgroup label="Other usable columns">
                          {candidates
                            .filter((c) => !c.recommended)
                            .map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name} — {c.db_type}
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </select>
                    {cursor && (
                      <span className="mt-1 block text-xs text-muted">
                        Column type: <span className="font-mono text-soft">{cursor.db_type.toUpperCase()}</span>
                        {cursor.nullable && " · rows where it is empty are never ingested"}
                      </span>
                    )}
                  </label>
                  {deltaMode ? (
                  <div className="md:col-span-2 rounded-md bg-panel-2 px-3 py-2 text-xs text-soft">
                    <Icon name="info" className="mr-1.5 inline h-3.5 w-3.5 text-ocean" />
                    The first run is the initial load (a SNAPSHOT, requested with <code className="text-sand">Prefer: odata.track-changes</code>); the delta link
                    the service returns is kept, and each later run appends only the rows changed since (ODP rows carry ODQ_CHANGEMODE: N new, U updated,
                    D deleted). Re-sync starts a new initial load.
                  </div>
                  ) : null}
                  {deltaMode ? (
                  <fieldset className="md:col-span-2 space-y-2">
                    <legend className="mb-1 text-xs font-medium text-soft">Write mode</legend>
                    <label className="flex items-start gap-2 text-xs text-soft">
                      <input type="radio" name="delta-write" checked={(ingest.delta_write ?? "log") === "log"} onChange={() => onIngest({ delta_write: "log" })} className="mt-0.5" />
                      <span>
                        <b>Change log</b> (default) — each delta run APPENDs the changed rows with their ODQ_CHANGEMODE; the dataset keeps every change.
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-xs text-soft">
                      <input type="radio" name="delta-write" checked={ingest.delta_write === "upsert"} onChange={() => onIngest({ delta_write: "upsert" })} className="mt-0.5" />
                      <span>
                        <b>Upsert by key</b> — each delta run applies the changes by the entity set&apos;s key (last version per key, deleted keys removed) and
                        writes the current rows as a new dataset version (an UPDATE transaction). Needs the key columns and ODQ_CHANGEMODE selected.
                      </span>
                    </label>
                    {ingest.delta_write === "upsert" && (
                      <label className="ml-5 flex items-center gap-2 text-xs text-soft">
                        <input type="checkbox" checked={!!ingest.keep_change_mode} onChange={(e) => onIngest({ keep_change_mode: e.target.checked })} />
                        Keep the ODQ_CHANGEMODE column (each key&apos;s last change) in the current rows
                      </label>
                    )}
                  </fieldset>
                  ) : (<>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-soft">Initial value</span>
                    <input
                      value={ingest.start_from ?? ""}
                      onChange={(e) => onIngest({ start_from: e.target.value })}
                      placeholder={cursor ? (cursor.cursor_kind === "ObjectId" ? "65f1c0ffee0123456789abcd" : (START_HINT[cursor.type] ?? "1000")) : ""}
                      className={inputClass}
                    />
                    <span className="mt-1 block text-xs text-muted">
                      The first run ingests rows with a value <b>greater than</b> this (empty: every row)
                      {cursor?.cursor_kind === "ObjectId" ? "; a 24-character ObjectId" : cursor?.type === "Timestamp" ? "; times are UTC" : ""}. If rows
                      were already ingested elsewhere, use their maximum so none is ingested twice.
                    </span>
                  </label>
                  <div className="md:col-span-2 rounded-md bg-panel-2 px-3 py-2 text-xs text-soft">
                    <Icon name="info" className="mr-1.5 inline h-3.5 w-3.5 text-ocean" />
                    The connector uses this column as the cursor to find records not ingested yet: each run reads rows where{" "}
                    <code className="text-sand">{cursor?.name ?? "column"} &gt; previous run&apos;s maximum</code> (the initial value on the first run),
                    up to the column&apos;s maximum when the run starts, in keyset batches. A run commits all at once: if it fails, nothing is added and
                    the cursor stays where it was.
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">
                      <li>
                        The column must only grow. If rows are <b>never updated</b>, an auto-increment id or an insert time works. If rows can be
                        <b> updated</b>, use a column that changes on every update (such as <code>updated_at</code>) — an id or insert time misses updates.
                      </li>
                      <li>An updated row is appended again, so the dataset keeps every version: remove duplicates downstream (e.g. in a pipeline).</li>
                      <li>A row arriving with a value below the last cursor is never picked up; re-sync the source to bring such rows in.</li>
                    </ul>
                  </div>
                  </>)}
                  <BatchSize value={ingest.batch_size} onChange={(batch_size) => onIngest({ batch_size })} />
                  <FrequencySelect value={ingest.frequency} onChange={(frequency) => onIngest({ frequency })} />
                </div>
              )}
              {cursor && (
                <div className="space-y-3">
                  <button type="button" onClick={previewBatch} disabled={busy} className={buttonClass.secondary}>
                    <Icon name={busy ? "refresh" : "eye"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                    {busy ? "Querying…" : batch ? "Refresh incremental preview" : "Preview incremental data"}
                  </button>
                  {error && <ErrorLine message={error} />}
                  {batch && <BatchView batch={batch} title={`${selection.table} — first batch`} />}
                </div>
              )}
            </section>
          ) : (
            <section className="space-y-4 rounded-lg border border-line-2 p-4">
              <h4 className="text-sm font-semibold">Snapshot configuration</h4>
              <p className="text-xs text-muted">Each run reads the selected table as it exists at ingestion time.</p>
              <div className="grid gap-4 md:grid-cols-2">
                <FrequencySelect value={ingest.frequency} onChange={(frequency) => onIngest({ frequency })} />
                <BatchSize value={ingest.batch_size} onChange={(batch_size) => onIngest({ batch_size })} />
                <div className="md:col-span-2">
                  <span className="mb-1 block text-xs font-medium text-soft">Snapshot behavior</span>
                  <div className="grid gap-2 md:grid-cols-2">
                    {(
                      [
                        ["replace", "Replace target", "Only the latest snapshot is kept: the previous file is deleted once the new one is committed."],
                        ["new", "Keep previous snapshots", "Each snapshot is a new dated file; older ones stay in the folder as history. The dataset is the latest."],
                      ] as const
                    ).map(([id, label, hint]) => (
                      <label key={id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm ${ingest.snapshot_behavior === id ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                        <input type="radio" checked={ingest.snapshot_behavior === id} onChange={() => onIngest({ snapshot_behavior: id })} className="mt-0.5 accent-[var(--color-ocean)]" />
                        <span>
                          {label}
                          <span className="block text-xs text-muted">{hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}
          <AdvancedSyncOptions value={ingest} incremental={incremental} onChange={onIngest} />
        </div>
      </div>
      <Footer note={incremental && !cursor && !deltaMode ? "Choose the incremental column." : undefined}>
        <button type="button" onClick={onBack} className={buttonClass.secondary}>
          Back
        </button>
        <button type="button" disabled={!ready} onClick={onNext} className={buttonClass.primary}>
          Review <Icon name="right" className="h-3.5 w-3.5" />
        </button>
      </Footer>
    </>
  );
}

const NAIVE_OPTIONS = [
  ["utc", "As UTC (default)"],
  ["string", "As text"],
  ["long", "As a number (epoch milliseconds)"],
  ["zone", "As wall-clock time in a time zone…"],
] as const;

/** Options shared by every sync: timestamps without a time zone, maximum duration, schema changes. */
export function AdvancedSyncOptions({
  value,
  incremental,
  onChange,
  compact,
}: {
  value: Pick<IngestConfig, "naive_timestamps" | "max_duration_minutes" | "allow_schema_changes">;
  incremental: boolean;
  onChange: (patch: { naive_timestamps?: string; max_duration_minutes?: number | null; allow_schema_changes?: boolean }) => void;
  compact?: boolean;
}) {
  const naive = value.naive_timestamps ?? "utc";
  const isZone = !["utc", "string", "long"].includes(naive);
  const [zone, setZone] = useState(isZone ? naive : "Asia/Jakarta");
  const [open, setOpen] = useState(!compact && (naive !== "utc" || !!value.max_duration_minutes || !!value.allow_schema_changes));
  return (
    <section className="rounded-lg border border-line-2">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 p-3 text-left text-sm font-semibold">
        <Icon name={open ? "down" : "right"} className="h-3.5 w-3.5 text-muted" /> Advanced options
        <span className="ml-auto text-xs font-normal text-muted">
          {[naive !== "utc" && `timestamps ${isZone ? `in ${naive}` : `as ${naive}`}`, value.max_duration_minutes && `max ${value.max_duration_minutes} min`, value.allow_schema_changes && "schema changes allowed"].filter(Boolean).join(" · ")}
        </span>
      </button>
      {open && (
        <div className="grid gap-4 border-t border-line-2 p-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-soft">Timestamps without a time zone</span>
            <select value={isZone ? "zone" : naive} onChange={(e) => onChange({ naive_timestamps: e.target.value === "zone" ? zone : e.target.value })} className={inputClass}>
              {NAIVE_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {isZone && (
              <input value={zone} onChange={(e) => setZone(e.target.value)} onBlur={() => onChange({ naive_timestamps: zone.trim() || "utc" })} placeholder="Asia/Jakarta" className={`${inputClass} mt-1`} />
            )}
            <span className="mt-1 block text-xs text-muted">How DATETIME / TIMESTAMP columns without a zone are written. Columns with a zone are always instants (UTC).</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-soft">Maximum duration</span>
            <select value={value.max_duration_minutes ?? 0} onChange={(e) => onChange({ max_duration_minutes: Number(e.target.value) || (compact ? 0 : null) })} className={inputClass}>
              {[[0, "No limit"], [15, "15 minutes"], [60, "1 hour"], [180, "3 hours"], [720, "12 hours"], [2880, "48 hours"]].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted">A run past this is stopped and commits nothing.</span>
          </label>
          <div className="md:col-span-2">
            <Switch
              on={!!value.allow_schema_changes}
              disabled={incremental}
              onChange={(allow_schema_changes) => onChange({ allow_schema_changes })}
              label="Allow schema changes"
              hint={incremental ? "Incremental datasets cannot mix schemas: a changed column type fails the run (re-sync after creating a new source)." : "When a column type changes in the database, follow it instead of failing the run. A removed column always fails."}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function BatchSize({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-soft">Batch size</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={inputClass}>
        {[10_000, 50_000, 100_000].map((n) => (
          <option key={n} value={n}>
            {n.toLocaleString()} rows per query
          </option>
        ))}
      </select>
    </label>
  );
}

function FrequencySelect({ value, onChange }: { value: Frequency; onChange: (f: Frequency) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-soft">Frequency</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Frequency)} className={inputClass}>
        {Object.entries(FREQUENCY_LABEL).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-xs text-muted">{value === "manual" ? "Runs only when you start them." : "Runs automatically while the API is running."}</span>
    </label>
  );
}

export function BatchView({ batch, title }: { batch: BatchPreview; title: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line-2">
      <div className="grid grid-cols-3 gap-3 border-b border-line bg-panel-2 px-4 py-3 text-sm">
        <div>
          <div className="text-xs text-muted">From {batch.from ? (batch.from_inclusive ? "(inclusive)" : "(exclusive)") : ""}</div>
          <div className="font-mono text-xs">{batch.from ?? "the first row"}</div>
        </div>
        <div>
          <div className="text-xs text-muted">To (current maximum)</div>
          <div className="font-mono text-xs">{batch.to ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Rows found</div>
          <div className="font-semibold tabular-nums">{batch.rows_found.toLocaleString()}</div>
        </div>
      </div>
      {batch.rows.length ? (
        <div className="flex h-72">
          <DataPreview table={asTable(batch.columns, batch.rows)} title={title} />
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-sm text-muted">No rows in this range — nothing new to ingest.</p>
      )}
      {batch.rows_found > batch.rows.length && (
        <p className="border-t border-line px-4 py-1.5 text-xs text-muted">Showing the first {batch.rows.length} of {batch.rows_found.toLocaleString()} rows.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// 5. review and create

function ReviewStep({
  connection,
  selection,
  preview,
  columns,
  ingest,
  batch,
  onBack,
  onCreated,
}: {
  connection: DbConnection;
  selection: Selection;
  preview: TablePreview;
  columns: string[] | null;
  ingest: IngestConfig;
  batch: BatchPreview | null;
  onBack: () => void;
  onCreated: (s: DataSource) => void;
}) {
  const [name, setName] = useState(selection.table);
  const [runNow, setRunNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const incremental = ingest.mode === "incremental";

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.dataSources.createSource({
          name: name.trim(),
          connection_id: connection.id,
          ...selection,
          columns,
          config: { ...ingest, start_from: incremental ? ingest.start_from?.trim() || null : null, cursor_column: incremental ? ingest.cursor_column : null },
          run_now: runNow,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const rows: [string, ReactNode][] = [
    [
      "Connection",
      <span key="c" className="flex items-center gap-2">
        <ConnectorLogo kind={connection.kind} size="sm" /> {connection.kind_name} — {connection.name}
      </span>,
    ],
    ["Table", `${selection.database} / ${selection.schema}.${selection.table}`],
    ["Columns", columns ? `${columns.length} of ${preview.columns.length}` : `${preview.columns.length} (all)`],
    ["Rows", preview.rows_estimate != null ? `${approx(preview.rows_estimate)} (estimate)` : "unknown"],
    ["Mode", incremental ? "Incremental (Append)" : "Snapshot"],
    ...(incremental
      ? ([
          ["Cursor", ingest.cursor_column === DELTA_CURSOR ? "Delta token (the service's change tracking)" : `${ingest.cursor_column}`],
          ...(ingest.cursor_column === DELTA_CURSOR
            ? ([
                [
                  "Write mode",
                  ingest.delta_write === "upsert"
                    ? `Upsert by key — current rows${ingest.keep_change_mode ? ", ODQ_CHANGEMODE kept" : ""}`
                    : "Change log (APPEND)",
                ],
              ] as [string, ReactNode][])
            : []),
          [
            "First run",
            batch
              ? `${batch.from ? `after ${batch.from}` : "every row"} → ${batch.to ?? "—"} (${batch.rows_found.toLocaleString()} rows)`
              : `${ingest.start_from?.trim() ? `after ${ingest.start_from.trim()}` : "every row"} → current maximum`,
          ],
          ["Later runs", "APPEND rows past the previous run's maximum"],
        ] as [string, ReactNode][])
      : ([
          ["Each run", "SNAPSHOT: replaces the dataset view"],
          ["Snapshot behavior", ingest.snapshot_behavior === "replace" ? "Replace target" : "Keep previous snapshots"],
        ] as [string, ReactNode][])),
    ["Batch size", `${ingest.batch_size.toLocaleString()} rows`],
    ["Frequency", FREQUENCY_LABEL[ingest.frequency]],
  ];

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-5">
          <h3 className="text-base font-semibold">Review data source</h3>
          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line-2">
            {rows.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[10rem_1fr] gap-3 px-4 py-2.5 text-sm">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 break-words">{v}</dd>
              </div>
            ))}
          </dl>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-soft">Data source name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            <span className="mt-1 flex items-center gap-1 text-xs text-muted">
              <Icon name="folder" className="h-3.5 w-3.5 text-sand" /> My Project / Data Source / {name.trim() || "…"} — the ingested Parquet goes here
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} className="accent-[var(--color-ocean)]" />
            Run the first ingestion now
          </label>
          {error && <ErrorLine message={error} />}
        </div>
      </div>
      <Footer>
        <button type="button" onClick={onBack} className={buttonClass.secondary}>
          Back
        </button>
        <button type="button" disabled={!name.trim() || busy} onClick={create} className={buttonClass.primary}>
          {busy ? "Creating…" : "Create data source"}
        </button>
      </Footer>
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// 6. created: follow the first run

function DoneStep({
  initial,
  onClose,
  onUse,
  useLabel,
}: {
  initial: DataSource;
  onClose: () => void;
  onUse?: (s: DataSource) => Promise<void> | void;
  useLabel: string;
}) {
  const [source, setSource] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = source.status === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api.dataSources
        .source(source.id)
        .then(setSource)
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [running, source.id]);

  const run = source.last_run;
  const ok = run?.status === "completed";
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <span className={`rounded-full p-3 ring-1 ${ok ? "bg-ok/10 text-ok ring-ok/40" : run?.status === "failed" ? "bg-bad/10 text-bad ring-bad/40" : "bg-ocean/10 text-ocean ring-ocean/40"}`}>
          <Icon name={ok ? "check" : run?.status === "failed" ? "alert" : running ? "refresh" : "database"} className={`h-6 w-6 ${running ? "animate-spin" : ""}`} />
        </span>
        <div>
          <h3 className="text-lg font-semibold">Data source “{source.name}” created</h3>
          <p className="mt-1 text-sm text-muted">
            {running
              ? "Running the first ingestion… you can close this window; it continues in the background."
              : ok
                ? `Ingested ${run!.rows.toLocaleString()} rows${source.mode === "incremental" && source.state.last_cursor ? ` · cursor now ${source.state.last_cursor}` : ""}.`
                : run?.status === "failed"
                  ? "The first run failed. Fix the problem and run it again from Data Sources."
                  : "Not run yet — start it from Data Sources."}
          </p>
          {run?.status === "failed" && run.error && (
            <div className="mx-auto mt-3 max-w-xl text-left">
              <ErrorLine message={run.error} />
            </div>
          )}
        </div>
        {source.folder && (
          <Link href={`/files/${source.folder.id}`} className="flex items-center gap-1.5 text-sm text-ocean hover:underline">
            <Icon name="folder" className="h-4 w-4 text-sand" /> {source.folder.path.slice(1).join(" / ")}
          </Link>
        )}
        {error && <ErrorLine message={error} />}
      </div>
      <Footer>
        <Link href="/sources" className={buttonClass.secondary}>
          Open Data Sources
        </Link>
        {onUse && (
          <button
            type="button"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onUse(source);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
            className={buttonClass.primary}
          >
            {busy ? "Adding…" : useLabel}
          </button>
        )}
        <button type="button" onClick={onClose} className={onUse ? buttonClass.secondary : buttonClass.primary}>
          {running ? "Close (keeps running)" : "Done"}
        </button>
      </Footer>
    </>
  );
}
