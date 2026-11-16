"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { HA_DEFAULT_OPTIONS, hyperauto, type HaConfig, type HaListedTable, type HaOptions, type HaSource, type HaTable, type HyperAutoPipeline } from "@/lib/dataConnection";
import { when } from "@/lib/format";
import { DrivePicker, type PickedFolder } from "../DrivePicker";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field, Switch, Tabs } from "../pipeline/ui";
import { ConnectorLogo } from "./ConnectorLogo";
import { useLoad } from "./DataSourceWizard";
import { EmptyState, ErrorLine, RunStatus, TabPage } from "./dcui";
import { confirmDialog } from "@/lib/dialogs";

const OPTION_INFO: { key: keyof HaOptions; label: string; hint: string }[] = [
  { key: "automatic_joins", label: "Automatic joins", hint: "Enrichment tables (lookup / text tables) are left-joined onto the object tables they reference, one row per key, so object rows never multiply." },
  { key: "readable_columns", label: "Human-readable column names", hint: "Columns with a comment in the source become `Description_|_original`." },
  { key: "readable_names", label: "Human-readable output dataset names", hint: "Outputs are named `Description (table)` from table comments." },
  { key: "primary_keys", label: "Generate primary keys", hint: "Tables with a composite key get a `primary_key` column: the key columns joined with `_|_`." },
  { key: "foreign_keys", label: "Generate foreign keys", hint: "Relationships to tables with composite keys get `col1_col2_|_foreign_key_<table>` columns (not for object-to-enrichment relationships when joins are on)." },
  { key: "deduplicate", label: "Deduplicate rows", hint: "One row per primary key: the latest by an ordering column (updated_at, modified…) when the table has one." },
  { key: "cleaning", label: "Data cleaning", hint: "Empty strings become null; DECIMAL columns are cast to DOUBLE." },
  { key: "incremental", label: "Incremental", hint: "Syncs and inputs are incremental where a cursor column exists; outputs merge new rows by primary key (Snapshot replace)." },
  { key: "ontology", label: "Generate ontology", hint: "An object type per object table with a key, and link types for the relationships between them." },
];

/** HyperAuto: from a source to cleaned, joined, keyed datasets (and objects) in one step. */
export function HyperAutoTab() {
  const list = useLoad("hyperauto", () => hyperauto.list());
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = list.data ?? list.last;
  const busy = rows?.some((h) => h.status === "generating");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(list.retry, 2000);
    return () => clearInterval(t);
  }, [busy, list.retry]);
  const selected = rows?.find((h) => h.id === open) ?? null;

  if (selected) return <HyperAutoDetail key={selected.id} ha={selected} onBack={() => setOpen(null)} onChanged={list.retry} />;
  return (
    <TabPage
      title="HyperAuto"
      description="Software-defined data integration: pick a database (or a folder of extracts) and the tables you need. HyperAuto reads the source's metadata — keys, relationships, comments — creates the syncs, and generates a Pipeline Builder pipeline that cleans, deduplicates, joins and keys the data, optionally with an ontology."
      actions={
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="bolt" /> Create HyperAuto pipeline
        </button>
      }
    >
      {list.error && <ErrorLine text={list.error} onRetry={list.retry} />}
      {!rows ? (
        !list.error && <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="bolt" title="No HyperAuto pipelines yet" text="Go from a source system to application-ready datasets in minutes, without hand-writing the joins and cleaning." action={<button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}><Icon name="bolt" /> Create HyperAuto pipeline</button>} />
      ) : (
        <ul className="space-y-2">
          {rows.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => setOpen(h.id)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-left hover:border-ocean/50">
                {h.source.kind === "connection" ? <ConnectorLogo kind={h.source.connection_kind ?? "postgresql"} size="sm" /> : <Icon name="folder" className="h-5 w-5 text-ocean" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{h.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {h.source.kind === "connection" ? `${h.source.connection_name} · ${h.source.schema}` : `Folder ${h.source.folder_name}`} · {h.config.tables.length} tables
                    {h.summary.outputs ? ` · ${h.summary.outputs.length} outputs` : ""}
                  </span>
                </span>
                {h.pending && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">proposal open</span>}
                <RunStatus status={h.status} at={h.updated_at} error={h.error} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <HyperAutoWizard
          onClose={() => setCreating(false)}
          onCreated={(h) => {
            setCreating(false);
            list.retry();
            setOpen(h.id);
          }}
        />
      )}
    </TabPage>
  );
}

// ---------------------------------------------------------------- wizard

function HyperAutoWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (h: HyperAutoPipeline) => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [location, setLocation] = useState<PickedFolder | null>(null);
  const [picking, setPicking] = useState<"location" | "folder" | null>(null);
  const [kind, setKind] = useState<"connection" | "folder">("connection");
  const conns = useLoad("conns", () => api.dataSources.connections());
  const [connId, setConnId] = useState("");
  const conn = conns.data?.find((c) => c.id === connId);
  const db = String(conn?.config.database ?? conn?.config.service_name ?? "");
  const [schema, setSchema] = useState("");
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const schemas = useLoad(connId ? `ha-schemas:${connId}` : null, () => api.dataSources.schemas(connId, db));
  const source: HaSource | null = kind === "connection" ? (connId && schema ? { kind: "connection", connection_id: connId, database: db, schema } : null) : folder?.id ? { kind: "folder", folder_id: folder.id } : null;
  const [config, setConfig] = useState<HaConfig>({ tables: [], options: HA_DEFAULT_OPTIONS });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steps = ["Name and location", "Source", "Input configuration", "Pipeline configuration"];
  const ok = [name.trim().length > 0, !!source, config.tables.some((t) => t.role === "object"), true];

  const create = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await hyperauto.create({ name: name.trim(), source, config, parent_id: location?.id ?? null }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Create HyperAuto pipeline" icon="bolt" onClose={onClose} wide>
      <div className="flex max-h-[82vh] flex-col">
        <ol className="flex shrink-0 gap-1 border-b border-line px-5 py-3 text-xs">
          {steps.map((s, i) => (
            <li key={s} className={`flex items-center gap-1.5 ${i === step ? "text-white" : i < step ? "text-ok" : "text-muted"}`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ring-1 ${i === step ? "bg-ocean ring-ocean" : "ring-line-2"}`}>{i < step ? "✓" : i + 1}</span>
              {s}
              {i < steps.length - 1 && <span className="mx-1 text-muted">›</span>}
            </li>
          ))}
        </ol>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 text-sm">
          {step === 0 && (
            <div className="space-y-3">
              <Field label="Name" required>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales integration" className={inputClass} autoFocus />
              </Field>
              <Field label="Location" hint="The HyperAuto pipeline gets its own folder here; the generated pipeline and its output datasets go in it.">
                <button type="button" onClick={() => setPicking("location")} className={`${buttonClass.secondary} w-full justify-start`}>
                  <Icon name="folder" className="h-3.5 w-3.5" /> {location?.name ?? "My Project / Datapipeline (default)"}
                </button>
              </Field>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-3">
              <Tabs value={kind} onChange={setKind} tabs={[{ id: "connection", label: "Database connection" }, { id: "folder", label: "Folder of datasets" }]} />
              {kind === "connection" ? (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Connection" required hint="Metadata (keys, relationships, comments) is read from its catalog.">
                    <select value={connId} onChange={(e) => (setConnId(e.target.value), setSchema(""), setConfig({ ...config, tables: [] }))} className={inputClass}>
                      <option value="">Choose…</option>
                      {(conns.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.kind_name})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Schema (sub-system)" required>
                    <select value={schema} onChange={(e) => (setSchema(e.target.value), setConfig({ ...config, tables: [] }))} disabled={!connId} className={inputClass}>
                      <option value="">{schemas.loading ? "Loading…" : "Choose…"}</option>
                      {(schemas.data ?? []).map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <p className="col-span-2 text-xs text-muted">Pipeline mode: batch — each build reprocesses its inputs (or only new rows with the Incremental option).</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted">A static extract: one Parquet dataset per table, named after the table, directly in one folder. Keys are inferred: `id` or `&lt;table&gt;_id` with unique values is the primary key; `&lt;other table&gt;_id` columns are foreign keys.</p>
                  <button type="button" onClick={() => setPicking("folder")} className={buttonClass.secondary}>
                    <Icon name="folder" className="h-3.5 w-3.5" /> {folder?.name ?? "Choose the folder…"}
                  </button>
                </div>
              )}
            </div>
          )}
          {step === 2 && source && <InputConfig source={source} tables={config.tables} onChange={(tables) => setConfig({ ...config, tables })} />}
          {step === 3 && <OptionsConfig options={config.options} tables={config.tables} incrementalAllowed={kind === "connection"} onChange={(options) => setConfig({ ...config, options })} />}
          {error && <div className="mt-3"><ErrorLine text={error} /></div>}
        </div>
        <div className="flex shrink-0 justify-between gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={() => (step ? setStep(step - 1) : onClose())} className={buttonClass.secondary}>
            {step ? "Back" : "Cancel"}
          </button>
          {step < steps.length - 1 ? (
            <button type="button" disabled={!ok[step]} onClick={() => setStep(step + 1)} className={buttonClass.primary}>
              Next
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={create} className={buttonClass.primary}>
              <Icon name={busy ? "refresh" : "bolt"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Creating…" : "Create HyperAuto pipeline"}
            </button>
          )}
        </div>
      </div>
      {picking && (
        <DrivePicker
          title={picking === "location" ? "Where to create the HyperAuto pipeline" : "The folder with the table datasets"}
          folder={{
            action: picking === "location" ? "Create here" : "Use this folder",
            onPick: (f) => {
              if (picking === "location") setLocation(f);
              else {
                setFolder(f);
                setConfig({ ...config, tables: [] });
              }
              setPicking(null);
            },
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </Modal>
  );
}

/** Input tables: browse by module, search, or ask for suggestions; set each table's role and sync. */
function InputConfig({ source, tables, onChange }: { source: HaSource; tables: HaTable[]; onChange: (t: HaTable[]) => void }) {
  const key = JSON.stringify(source);
  const listing = useLoad(`ha-list:${key}`, () => hyperauto.listTables(source));
  const [view, setView] = useState<"modules" | "selected" | "suggest">("modules");
  const [search, setSearch] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [suggested, setSuggested] = useState<{ name: string; why: string }[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byName = useMemo(() => new Map((listing.data?.tables ?? []).map((t) => [t.name, t])), [listing.data]);
  const chosen = new Map(tables.map((t) => [t.name, t]));
  const toggle = (t: HaListedTable, on: boolean) => onChange(on ? [...tables, { name: t.name, role: t.role }] : tables.filter((x) => x.name !== t.name));
  const update = (name: string, patch: Partial<HaTable>) => onChange(tables.map((t) => (t.name === name ? { ...t, ...patch } : t)));
  if (listing.error) return <ErrorLine text={listing.error} onRetry={listing.retry} />;
  if (!listing.data) return <p className="text-muted">Reading the source&apos;s tables…</p>;
  const modules = listing.data.modules;
  const match = (n: string) => !search || n.toLowerCase().includes(search.toLowerCase()) || (byName.get(n)?.comment ?? "").toLowerCase().includes(search.toLowerCase());

  const row = (t: HaListedTable) => {
    const c = chosen.get(t.name);
    return (
      <li key={t.name} className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${c ? "bg-ocean/10" : "hover:bg-panel-2"}`}>
        <input type="checkbox" checked={!!c} onChange={(e) => toggle(t, e.target.checked)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{t.name}</span>
          {t.comment && <span className="block truncate text-[11px] text-muted">{t.comment}</span>}
        </span>
        {t.rows !== null && t.rows !== undefined && <span className="text-[11px] tabular-nums text-muted">~{t.rows.toLocaleString()} rows</span>}
        {c ? (
          <>
            <select value={c.role} onChange={(e) => update(t.name, { role: e.target.value as HaTable["role"] })} className={`${inputClass} w-32 py-0.5 text-xs`}>
              <option value="object">Object</option>
              <option value="enrichment">Enrichment</option>
            </select>
            {source.kind === "connection" && (
              <select value={c.sync_id ?? ""} onChange={(e) => update(t.name, { sync_id: e.target.value || null })} className={`${inputClass} w-44 py-0.5 text-xs`} title="The data source the table is read from">
                <option value="">{t.syncs?.length ? "Latest existing sync" : "New sync (daily)"}</option>
                {(t.syncs ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.mode})
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <span className="text-[11px] text-muted">{t.role === "enrichment" ? "enrichment" : ""}</span>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Tabs value={view} onChange={setView} tabs={[{ id: "modules", label: "Modules" }, { id: "selected", label: "Selected", badge: tables.length }, { id: "suggest", label: "Suggest" }]} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tables…" className={`${inputClass} ml-auto w-56 py-1 text-xs`} />
      </div>
      <p className="text-xs text-muted">
        <b className="text-soft">Object</b> tables are valuable on their own and become outputs; <b className="text-soft">enrichment</b> tables (text, lookup tables) extend the object tables they reference.
      </p>
      {view === "modules" &&
        Object.entries(modules).map(([m, names]) => {
          const shown = names.filter(match);
          if (!shown.length) return null;
          const all = shown.every((n) => chosen.has(n));
          return (
            <div key={m}>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-soft">
                <Icon name="layers" className="h-3.5 w-3.5 text-ocean" /> {m}
                <span className="text-muted">({names.length})</span>
                <button
                  type="button"
                  onClick={() => onChange(all ? tables.filter((t) => !shown.includes(t.name)) : [...tables, ...shown.filter((n) => !chosen.has(n)).map((n) => ({ name: n, role: byName.get(n)!.role }))])}
                  className="ml-auto text-[11px] text-ocean hover:underline"
                >
                  {all ? "Remove all" : "Add all"}
                </button>
              </div>
              <ul className="space-y-0.5">{shown.map((n) => row(byName.get(n)!))}</ul>
            </div>
          );
        })}
      {view === "selected" && (tables.length ? <ul className="space-y-0.5">{tables.map((t) => byName.get(t.name) && row(byName.get(t.name)!))}</ul> : <p className="text-xs text-muted">No tables selected yet.</p>)}
      {view === "suggest" && (
        <div className="space-y-2">
          <Field label="Describe the workflow" hint="Tables relevant to it are suggested, with why (an LLM when configured, otherwise matching names and comments).">
            <textarea value={workflow} onChange={(e) => setWorkflow(e.target.value)} rows={3} placeholder="I want to analyse sales orders, their lines and shipments per customer" className={inputClass} />
          </Field>
          <button
            type="button"
            disabled={suggesting || workflow.trim().length < 3}
            onClick={async () => {
              setSuggesting(true);
              setError(null);
              try {
                setSuggested((await hyperauto.suggest(source, workflow)).tables);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSuggesting(false);
              }
            }}
            className={`${buttonClass.primary} py-1 text-xs`}
          >
            <Icon name={suggesting ? "refresh" : "sparkle"} className={`h-3.5 w-3.5 ${suggesting ? "animate-spin" : ""}`} /> Suggest tables
          </button>
          {error && <p className="text-xs text-bad">{error}</p>}
          {suggested && (suggested.length === 0 ? <p className="text-xs text-muted">No table matched — try other words.</p> : (
            <ul className="space-y-0.5">
              {suggested.map((s) => byName.get(s.name) && (
                <div key={s.name}>
                  {row(byName.get(s.name)!)}
                  <p className="-mt-0.5 mb-1 pl-8 text-[11px] text-muted">{s.why}</p>
                </div>
              ))}
            </ul>
          ))}
        </div>
      )}
    </div>
  );
}

function OptionsConfig({ options, tables, incrementalAllowed, onChange }: { options: HaOptions; tables: HaTable[]; incrementalAllowed: boolean; onChange: (o: HaOptions) => void }) {
  const hasEnrichment = tables.some((t) => t.role === "enrichment");
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        {OPTION_INFO.map((o) => (
          <Switch
            key={o.key}
            on={!!options[o.key]}
            disabled={o.key === "incremental" && !incrementalAllowed}
            onChange={(on) => onChange({ ...options, [o.key]: on })}
            label={o.label}
            hint={o.key === "incremental" && !incrementalAllowed ? "Needs a database connection (folder pipelines read static extracts)." : o.hint}
          />
        ))}
      </div>
      {hasEnrichment && (
        <div className="rounded-lg border border-line-2 p-3">
          <div className="mb-1 text-xs font-medium text-soft">Language selection</div>
          <p className="mb-2 text-xs text-muted">Text tables often hold one row per language. Keep one language before joining (the column is found automatically — lang, language, locale, spras — unless named here).</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Language value">
              <input value={options.language_value ?? ""} onChange={(e) => onChange({ ...options, language_value: e.target.value || null })} placeholder="en" className={inputClass} />
            </Field>
            <Field label="Language column (optional)">
              <input value={options.language_column ?? ""} onChange={(e) => onChange({ ...options, language_column: e.target.value || null })} placeholder="auto" className={inputClass} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- detail

function HyperAutoDetail({ ha, onBack, onChanged }: { ha: HyperAutoPipeline; onBack: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<"overview" | "configuration">("overview");
  const [editing, setEditing] = useState<HaConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = ha.summary;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const source: HaSource = ha.source.kind === "connection" ? { kind: "connection", connection_id: ha.source.connection_id, database: ha.source.database, schema: ha.source.schema } : { kind: "folder", folder_id: ha.source.folder_id };

  return (
    <TabPage
      title={ha.name}
      description={
        <>
          {ha.source.kind === "connection" ? `${ha.source.connection_name} · schema ${ha.source.schema}` : `Folder ${ha.source.folder_name}`} · {ha.config.tables.length} input tables · updated {when(ha.updated_at)}
        </>
      }
      actions={
        <>
          <button type="button" onClick={onBack} className={buttonClass.secondary}>
            <Icon name="left" className="h-3.5 w-3.5" /> All pipelines
          </button>
          {ha.pipeline && (
            <Link href={`/pipeline/${ha.pipeline.id}`} className={buttonClass.primary}>
              <Icon name="pipeline" className="h-3.5 w-3.5" /> View builder pipeline
            </Link>
          )}
        </>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" }, { id: "configuration", label: "Configuration" }]} />
        <span className="flex-1" />
        <RunStatus status={ha.status} at={ha.updated_at} error={ha.error} />
      </div>
      {error && <div className="mb-3"><ErrorLine text={error} /></div>}
      {ha.error && ha.status !== "generating" && <div className="mb-3"><ErrorLine text={ha.error} /></div>}
      {ha.pending && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
          <Icon name="alert" className="mt-0.5 h-4 w-4 text-warn" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-warn">{ha.status === "generating" ? "Generating the proposal…" : "A configuration change is proposed"}</div>
            {ha.pending.branch && (
              <p className="text-xs text-soft">
                Regenerated on branch <b>{ha.pending.branch}</b> with an open proposal. Review its changes and merge it in Pipeline Builder (Proposals), then deploy main to apply it to the outputs.
              </p>
            )}
          </div>
          {ha.pipeline && ha.pending.branch && (
            <Link href={`/pipeline/${ha.pipeline.id}`} className={`${buttonClass.secondary} py-1 text-xs`}>
              View proposal
            </Link>
          )}
        </div>
      )}
      {tab === "overview" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            <section className="rounded-xl border border-line bg-panel p-4">
              <h2 className="mb-2 text-sm font-semibold">Outputs</h2>
              {!s.outputs?.length ? (
                <p className="text-xs text-muted">{ha.status === "generating" ? "Generating…" : "None yet."}</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="py-1 font-medium">Table</th>
                      <th className="font-medium">Output dataset</th>
                      <th className="font-medium">Primary key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.outputs.map((o) => (
                      <tr key={o.table} className="border-t border-line">
                        <td className="py-1 font-mono">{o.table}</td>
                        <td>{o.output}</td>
                        <td className="font-mono text-muted">{o.key ?? "— (no key)"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {ha.pipeline && <p className="mt-2 text-xs text-muted">Pipeline: {ha.pipeline.path} / {ha.pipeline.name}. Deploy it in Pipeline Builder to build the outputs{ha.config.options.ontology ? " and objects" : ""}.</p>}
            </section>
            {!!s.joins?.length && (
              <section className="rounded-xl border border-line bg-panel p-4">
                <h2 className="mb-2 text-sm font-semibold">Automatic joins</h2>
                <ul className="space-y-1 text-xs">
                  {s.joins.map((j) => (
                    <li key={`${j.object}-${j.enrichment}`}>
                      <span className="font-mono">{j.object}</span> ⟵ left join <span className="font-mono">{j.enrichment}</span>
                      <span className="text-muted"> on {j.on.map(([a, b]) => `${a} = ${b}`).join(", ")}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(!!s.links?.length || !!s.foreign_keys?.length) && (
              <section className="rounded-xl border border-line bg-panel p-4">
                <h2 className="mb-2 text-sm font-semibold">Relationships</h2>
                <ul className="space-y-1 text-xs">
                  {(s.links ?? []).map((l) => (
                    <li key={`${l.from}-${l.to}-${l.key}`}>
                      <span className="font-mono">{l.from}</span> → <span className="font-mono">{l.to}</span> <span className="text-muted">via {l.key}</span>
                    </li>
                  ))}
                </ul>
                {!!s.foreign_keys?.length && <p className="mt-2 text-xs text-muted">Generated foreign key columns: {s.foreign_keys.map((f) => f.column).join(", ")}</p>}
              </section>
            )}
          </div>
          <section className="rounded-xl border border-line bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Activity</h2>
            <ol className="max-h-[28rem] space-y-1.5 overflow-y-auto text-xs">
              {[...ha.progress].reverse().map((p, i) => (
                <li key={i}>
                  <span className="text-muted">{when(p.at)}</span>
                  <div className="text-soft">{p.msg}</div>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              {ha.status === "failed" && (
                <button type="button" disabled={busy} onClick={() => act(() => hyperauto.retry(ha.id))} className={`${buttonClass.primary} py-1 text-xs`}>
                  <Icon name="refresh" className="h-3.5 w-3.5" /> Retry generation
                </button>
              )}
              <button
                type="button"
                disabled={busy || ha.status === "generating"}
                onClick={async () => {
                  if (!(await confirmDialog(`Delete the HyperAuto pipeline "${ha.name}"?\n\nIts syncs, the generated pipeline and the outputs stay; the pipeline is released for direct edits.`))) return;
                  void act(() => hyperauto.remove(ha.id)).then(onBack);
                }}
                className={`${buttonClass.secondary} py-1 text-xs text-bad`}
              >
                <Icon name="trash" className="h-3.5 w-3.5" /> Delete
              </button>
            </div>
          </section>
        </div>
      ) : editing ? (
        <div className="space-y-4 rounded-xl border border-line bg-panel p-4">
          <InputConfig source={source} tables={editing.tables} onChange={(tables) => setEditing({ ...editing, tables })} />
          <OptionsConfig options={editing.options} tables={editing.tables} incrementalAllowed={ha.source.kind === "connection"} onChange={(options) => setEditing({ ...editing, options })} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className={buttonClass.secondary}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !editing.tables.some((t) => t.role === "object")}
              onClick={() => act(() => hyperauto.propose(ha.id, editing)).then(() => (setEditing(null), setTab("overview")))}
              className={buttonClass.primary}
            >
              <Icon name="upload" className="h-3.5 w-3.5" /> Create proposal
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs text-muted">Edits are not applied directly: they regenerate the pipeline on a branch with a proposal to review and merge.</p>
            <button type="button" disabled={!!ha.pending || ha.status !== "ready"} onClick={() => setEditing(JSON.parse(JSON.stringify(ha.config)))} className={buttonClass.primary}>
              <Icon name="edit" className="h-3.5 w-3.5" /> Edit
            </button>
          </div>
          <section className="rounded-xl border border-line bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Inputs</h2>
            <ul className="grid gap-1 text-xs sm:grid-cols-2">
              {ha.config.tables.map((t) => (
                <li key={t.name} className="flex items-center gap-2">
                  <Icon name={t.role === "object" ? "cube" : "link"} className="h-3.5 w-3.5 text-ocean" />
                  <span className="font-mono">{t.name}</span>
                  <span className="text-muted">{t.role}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-xl border border-line bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Pipeline configuration</h2>
            <ul className="grid gap-1 text-xs sm:grid-cols-2">
              {OPTION_INFO.map((o) => (
                <li key={o.key} className="flex items-center gap-2">
                  <Icon name={ha.config.options[o.key] ? "check" : "x"} className={`h-3.5 w-3.5 ${ha.config.options[o.key] ? "text-ok" : "text-muted"}`} />
                  {o.label}
                </li>
              ))}
              {ha.config.options.language_value && <li className="text-muted">Language: {ha.config.options.language_value}</li>}
            </ul>
          </section>
        </div>
      )}
    </TabPage>
  );
}
