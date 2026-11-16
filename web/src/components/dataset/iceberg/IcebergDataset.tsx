"use client";

import { SqlDefinitions } from "@/components/sql/SqlDefinitions";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { iceberg, iecBytes, type HistoryEntry, type IcebergTable, type Rows, type SnapshotsView } from "@/lib/iceberg";
import { MaintenanceTab } from "./Maintenance";
import { SchemaDialog, SnapshotsTab } from "./Snapshots";

type Tab = "preview" | "snapshots" | "maintenance" | "history" | "branches" | "details";
const TABS: [Tab, string, IconName][] = [
  ["preview", "Preview", "table"],
  ["snapshots", "Snapshots", "layers"],
  ["history", "History", "clock"],
  ["branches", "Branches", "split"],
  ["details", "Details", "info"],
  ["maintenance", "Maintenance", "sliders"],
];
const LOCKED = ["foundry.branch.", "foundry.rid", "foundry.table-version", "encryption.", "write.metadata.delete-after-commit.enabled", "write.object-storage.enabled",
  "write.object-storage.partitioned-paths", "write.data.path", "write.folder-storage.path", "write.location-provider.impl", "write.metadata.path", "write.object-storage.path"];
const locked = (k: string) => LOCKED.some((p) => k === p || (p.endsWith(".") && k.startsWith(p)));

/** Dataset Preview for a Foundry Iceberg table (api/iceberg_tables.py): preview on a branch or snapshot, Snapshots,
 *  History, branches and tags, details with the metadata JSON and properties, and Maintenance. */
export function IcebergDataset({ id }: { id: string }) {
  const [t, setT] = useState<IcebergTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState("main");
  const [tab, setTab] = useState<Tab>(() => {
    const v = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return TABS.some(([k]) => k === v) ? (v as Tab) : "preview";
  });
  const [reload, setReload] = useState(0);
  const load = useCallback(() => {
    iceberg.get(id, branch).then(setT, (e: Error) => setError(e.message));
  }, [id, branch]);
  useEffect(load, [load, reload]);
  const changed = useCallback(() => setReload((n) => n + 1), []);
  if (error) return <ApiError message={error} />;
  if (!t) return <Loading />;
  const pick = (k: Tab) => {
    setTab(k);
    window.history.replaceState(null, "", `/datasets/${id}${k === "preview" ? "" : `?tab=${k}`}`);
  };
  const branches = t.branches.filter((b) => b.type === "branch").map((b) => b.name);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-3">
        <Icon name="layers" className="h-5 w-5 text-ocean" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-semibold">{t.name}</h1>
            <span className="rounded bg-ocean/15 px-1.5 py-0.5 text-[11px] text-ocean">Iceberg table</span>
            <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">v{t.format_version}</span>
            {t.protected && (
              <span className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn">
                <Icon name="alert" className="h-3 w-3" /> main protected
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
            <Link href="/files" className="hover:text-white">
              Files &amp; Projects
            </Link>
            {t.path.map((p, i) => (
              <span key={i}>/ {p}</span>
            ))}
            <span className="ml-2 font-mono">{t.rid}</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Branch
            <select value={branch} onChange={(e) => setBranch(e.target.value)} className={`${fieldClass} py-1 text-xs`}>
              {(branches.includes("main") ? branches : ["main", ...branches]).map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
          <Link href="/iceberg" className={`${buttonClass.secondary} py-1 text-xs`}>
            <Icon name="layers" className="h-3.5 w-3.5" /> Iceberg tables
          </Link>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <InfoPanel t={t} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 border-b border-line bg-panel px-2 text-sm">
            {TABS.map(([k, l, icon]) => (
              <button key={k} type="button" onClick={() => pick(k)} className={`flex items-center gap-1.5 px-3 py-2 ${tab === k ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
                <Icon name={icon} className="h-3.5 w-3.5" /> {l}
              </button>
            ))}
          </div>
          {tab === "preview" && <PreviewTab key={`${branch}-${reload}`} t={t} branch={branch} />}
          {tab === "snapshots" && <SnapshotsTab key={`${branch}-${reload}`} t={t} branch={branch} onChanged={changed} />}
          {tab === "history" && <HistoryTab key={reload} t={t} />}
          {tab === "branches" && <BranchesTab t={t} onChanged={changed} />}
          {tab === "details" && <DetailsTab t={t} branch={branch} onChanged={changed} />}
          {tab === "maintenance" && <MaintenanceTab t={t} onChanged={changed} />}
        </div>
      </div>
    </div>
  );
}

function InfoPanel({ t }: { t: IcebergTable }) {
  const [schema, setSchema] = useState(false);
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-panel p-3 text-xs">
      <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5">
        <dt className="text-muted">Records</dt>
        <dd>{t.records.toLocaleString()}</dd>
        <dt className="text-muted">Size</dt>
        <dd>{iecBytes(t.size)}</dd>
        <dt className="text-muted">Data files</dt>
        <dd>
          {t.files.toLocaleString()}
          {t.delete_files ? ` · ${t.delete_files} delete` : ""}
        </dd>
        <dt className="text-muted">Snapshots</dt>
        <dd>{t.snapshot_count}</dd>
        <dt className="text-muted">Storage</dt>
        <dd>{t.storage.name}</dd>
        <dt className="text-muted">Encryption</dt>
        <dd>Server-side{t.cse ? " + client-side" : ""}</dd>
        <dt className="text-muted">Writes</dt>
        <dd>{t.merge_on_read ? "merge-on-read" : "copy-on-write"}</dd>
        <dt className="text-muted">Updated</dt>
        <dd>{when(t.updated_at)}</dd>
      </dl>
      <div className="mt-4 flex items-center justify-between">
        <span className="font-medium">Columns</span>
        <button type="button" onClick={() => setSchema(true)} className="text-ocean hover:underline">
          v{t.schema_id}
        </button>
      </div>
      <ul className="mt-1 space-y-0.5">
        {t.columns.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
            <span className="text-muted">{c.type}</span>
            {t.identifier_fields.includes(c.name) && <Icon name="star" className="h-3 w-3 text-sand" />}
          </li>
        ))}
        {!t.columns.length && <li className="text-muted">No schema yet (the table has not been written{t.branch !== "main" ? " on this branch" : ""}).</li>}
      </ul>
      {t.markings.length > 0 && (
        <div className="mt-4">
          <span className="font-medium">Markings</span>
          <p className="mt-1 text-muted">Table-scoped: a marking on any retained snapshot restricts the whole table until that snapshot expires.</p>
        </div>
      )}
      {schema && <SchemaDialog tableId={t.id} schemaId={t.schema_id} onClose={() => setSchema(false)} />}
    </aside>
  );
}

function PreviewTab({ t, branch }: { t: IcebergTable; branch: string }) {
  const [rows, setRows] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const [snaps, setSnaps] = useState<SnapshotsView | null>(null);
  useEffect(() => {
    iceberg.snapshots(t.id, { branch }).then(setSnaps, () => setSnaps(null));
  }, [t.id, branch]);
  useEffect(() => {
    iceberg.rows(t.id, { branch, snapshot_id: snapshot || undefined, row_filter: applied || undefined, limit: 200 }).then(
      (r) => {
        setRows(r);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [t.id, branch, snapshot, applied]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <form
          className="flex min-w-64 flex-1 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filter.trim());
          }}
        >
          <Icon name="filter" className="h-3.5 w-3.5 text-muted" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Row filter, e.g. status = 'active' and amount > 10" className={`${inputClass} py-1 font-mono text-xs`} />
        </form>
        <label className="flex items-center gap-1.5 text-muted">
          At snapshot
          <select value={snapshot} onChange={(e) => setSnapshot(e.target.value)} className={`${fieldClass} max-w-64 py-1 text-xs`}>
            <option value="">Current ({branch})</option>
            {snaps?.snapshots.map((s) => (
              <option key={s.snapshot_id} value={s.snapshot_id}>
                {when(s.at)} · {s.operation} · {s.snapshot_id.slice(0, 10)}…
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="m-3 text-xs text-bad">{error}</p>}
      {!rows && !error && <Loading />}
      {rows && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel-2 text-left">
              <tr>
                {rows.columns.map((c) => (
                  <th key={c.name} className="whitespace-nowrap border-b border-line px-2 py-1.5 font-medium">
                    {c.name} <span className="font-normal text-muted">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.rows.map((r, i) => (
                <tr key={i} className="border-b border-line/60 hover:bg-panel-2">
                  {rows.columns.map((c) => (
                    <td key={c.name} className="max-w-xs truncate whitespace-nowrap px-2 py-1">
                      {r[c.name] === null || r[c.name] === undefined ? <span className="text-muted">null</span> : typeof r[c.name] === "object" ? JSON.stringify(r[c.name]) : String(r[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.rows.length && <p className="p-6 text-center text-sm text-muted">No rows.</p>}
          {rows.count >= 200 && <p className="p-2 text-center text-[11px] text-muted">Showing the first 200 rows.</p>}
        </div>
      )}
    </div>
  );
}

function HistoryTab({ t }: { t: IcebergTable }) {
  const [h, setH] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    iceberg.history(t.id).then(setH, () => setH([]));
  }, [t.id]);
  if (!h) return <Loading />;
  const icon: Record<string, IconName> = { job: "code", pipeline: "pipeline", sync: "database", maintenance: "sliders", external: "plug", user: "edit" };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
      <p className="mb-3 text-xs text-muted">The jobs and clients that changed this table. The Snapshots tab shows the snapshots themselves.</p>
      <ul className="space-y-1.5">
        {h.map((e, i) => (
          <li key={i} className="flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-2 text-xs">
            <Icon name={icon[e.kind] ?? "history"} className="h-4 w-4 text-ocean" />
            <span className="min-w-0 flex-1">
              <span className="block text-soft">{e.label}</span>
              <span className="block text-muted">
                {e.user} · {e.branch ? `branch ${e.branch}` : "main"} · {e.snapshots.length} snapshot{e.snapshots.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="text-muted">{when(e.at)}</span>
          </li>
        ))}
        {!h.length && <li className="text-xs text-muted">No writes recorded yet.</li>}
      </ul>
    </div>
  );
}

function BranchesTab({ t, onChanged }: { t: IcebergTable; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"branch" | "tag">("branch");
  const [snapshot, setSnapshot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      await iceberg.createRef(t.id, name.trim(), type, snapshot.trim() || undefined);
      setName("");
      setSnapshot("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (n: string) => {
    if (!(await confirmDialog({ title: `Delete ${n}`, message: `Delete ${n}? Snapshots only it protected can expire; schemas only it tracked can be dropped.`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await iceberg.deleteRef(t.id, n);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
      <p className="mb-3 text-xs text-muted">
        Iceberg&apos;s main is Foundry&apos;s master. With branch isolation, each branch tracks its own current schema, partition spec and sort order (table properties
        foundry.branch.*); the schema history is shared. Tags protect a snapshot from expiration.
      </p>
      <table className="mb-4 w-full text-xs">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1 font-medium">Name</th>
            <th className="py-1 font-medium">Type</th>
            <th className="py-1 font-medium">Snapshot</th>
            <th className="py-1 font-medium">Schema</th>
            <th className="py-1 font-medium">At</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {t.branches.map((b) => (
            <tr key={b.name} className="border-t border-line">
              <td className="py-1.5 font-medium">{b.name}</td>
              <td className="py-1.5 capitalize">{b.type}</td>
              <td className="py-1.5 font-mono text-muted">{b.snapshot_id ?? "— (no snapshot yet)"}</td>
              <td className="py-1.5">{b.schema_id !== null ? `v${b.schema_id}` : "—"}</td>
              <td className="py-1.5 text-muted">{b.at ? when(b.at) : "—"}</td>
              <td className="py-1.5 text-right">
                {b.name !== "main" && t.can_edit && (
                  <button type="button" onClick={() => remove(b.name)} className="text-muted hover:text-bad">
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {t.can_edit && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-panel p-3 text-xs">
          <label>
            <span className="block text-muted">New</span>
            <select value={type} onChange={(e) => setType(e.target.value as "branch" | "tag")} className={`${fieldClass} py-1 text-xs`}>
              <option value="branch">Branch</option>
              <option value="tag">Tag</option>
            </select>
          </label>
          <label className="flex-1">
            <span className="block text-muted">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} py-1 text-xs`} />
          </label>
          <label className="flex-1">
            <span className="block text-muted">From snapshot (main&apos;s current when empty)</span>
            <input value={snapshot} onChange={(e) => setSnapshot(e.target.value)} className={`${inputClass} py-1 font-mono text-xs`} />
          </label>
          <button type="button" disabled={!name.trim()} onClick={create} className={`${buttonClass.primary} py-1 text-xs`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Create
          </button>
          {error && <p className="w-full text-bad">{error}</p>}
        </div>
      )}
    </div>
  );
}

function DetailsTab({ t, branch, onChanged }: { t: IcebergTable; branch: string; onChanged: () => void }) {
  const [section, setSection] = useState<"overview" | "job" | "properties" | "metadata" | "access" | "connect">("overview");
  return (
    <div className="flex min-h-0 flex-1">
      <ul className="w-48 shrink-0 border-r border-line py-2 text-sm">
        {(
          [
            ["overview", "Table"],
            ["job", "Job spec"],
            ["properties", "Properties"],
            ["metadata", "Metadata JSON"],
            ["access", "Protection & markings"],
            ["connect", "Use this table"],
          ] as const
        ).map(([k, l]) => (
          <li key={k}>
            <button type="button" onClick={() => setSection(k)} className={`w-full px-4 py-1.5 text-left ${section === k ? "bg-ocean/10 text-white" : "text-soft hover:bg-panel-2"}`}>
              {l}
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 text-sm">
        {section === "overview" && <Overview t={t} />}
        {section === "job" && <SqlDefinitions itemId={t.id} always onBuilt={onChanged} />}
        {section === "properties" && <Properties t={t} onChanged={onChanged} />}
        {section === "metadata" && <MetadataJson t={t} branch={branch} />}
        {section === "access" && <Access t={t} onChanged={onChanged} />}
        {section === "connect" && <UseTable t={t} />}
      </div>
    </div>
  );
}

function Overview({ t }: { t: IcebergTable }) {
  const rows: [string, ReactNode][] = [
    ["Identifier", <span key="i" className="font-mono">{t.identifier}</span>],
    ["RID", <span key="r" className="font-mono">{t.rid}</span>],
    ["Table UUID", <span key="u" className="font-mono">{t.uuid}</span>],
    ["Format version", `v${t.format_version}`],
    ["Location", <span key="l" className="break-all font-mono">{t.location}</span>],
    ["Metadata file", <span key="m" className="break-all font-mono">{t.metadata_location}</span>],
    ["Storage", `${t.storage.name} (${t.storage.provider})`],
    ["Encryption", t.cse ? "Server-side and client-side (requested)" : "Server-side"],
    ["Partition spec", t.partition_spec?.fields?.length ? t.partition_spec.fields.map((f) => `${f.transform}(${f.name})`).join(", ") : "Unpartitioned"],
    ["Sort order", t.sort_order?.fields?.length ? `${t.sort_order.fields.length} field(s)` : "Unsorted"],
    ["Producer", t.producer ? (t.producer.repo_id ? <Link key="p" href={`/code-repositories/${t.producer.repo_id}`} className="text-ocean hover:underline">{`${t.producer.repo} · ${t.producer.name}`}</Link> : t.producer.name) : "— (external clients, syncs or pipelines)"],
    ["Created", `${when(t.created_at)} by ${t.created_by}`],
  ];
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Properties({ t, onChanged }: { t: IcebergTable; onChanged: () => void }) {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async (set: Record<string, string>, unset: string[] = []) => {
    try {
      await iceberg.setProperties(t.id, set, unset);
      setK("");
      setV("");
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="text-xs">
      <p className="mb-3 text-muted">
        Foundry sets defaults on new tables (30-day snapshot age, one previous metadata version, object storage paths) and manages foundry.*, encryption.* and the write
        paths. Set properties after the table is written: a replace by a non-incremental write resets them.
      </p>
      <table className="w-full">
        <tbody>
          {Object.entries(t.properties)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => (
              <tr key={key} className="border-t border-line">
                <td className="py-1 pr-3 font-mono">{key}</td>
                <td className="break-all py-1 pr-3 font-mono text-soft">{value}</td>
                <td className="py-1 text-right">
                  {locked(key) ? (
                    <span className="text-muted" title="Managed by Foundry">
                      locked
                    </span>
                  ) : (
                    t.can_edit &&
                    key !== "format-version" && (
                      <button type="button" onClick={() => save({}, [key])} className="text-muted hover:text-bad" title="Remove">
                        <Icon name="x" className="h-3.5 w-3.5" />
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {t.can_edit && (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (k.trim()) save({ [k.trim()]: v });
          }}
        >
          <label className="flex-1">
            <span className="text-muted">Property</span>
            <input value={k} onChange={(e) => setK(e.target.value)} placeholder="write.delete.mode" className={`${inputClass} py-1 font-mono text-xs`} />
          </label>
          <label className="flex-1">
            <span className="text-muted">Value</span>
            <input value={v} onChange={(e) => setV(e.target.value)} placeholder="merge-on-read" className={`${inputClass} py-1 font-mono text-xs`} />
          </label>
          <button type="submit" className={`${buttonClass.primary} py-1 text-xs`}>
            Set
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-bad">{error}</p>}
      <p className="mt-3 text-muted">format-version upgrades v2 → v3 (no downgrade). Merge-on-read tables cannot be read as changelogs or back incrementally indexed object types.</p>
    </div>
  );
}

function MetadataJson({ t, branch }: { t: IcebergTable; branch: string }) {
  const [md, setMd] = useState<{ metadata_location: string; metadata: Record<string, unknown> } | null>(null);
  useEffect(() => {
    iceberg.metadata(t.id, branch).then(setMd, () => setMd(null));
  }, [t.id, branch]);
  if (!md) return <Loading />;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <span className="break-all font-mono">{md.metadata_location}</span>
        <button type="button" onClick={() => navigator.clipboard?.writeText(JSON.stringify(md.metadata, null, 2))} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
          <Icon name="copy" className="h-3.5 w-3.5" /> Copy
        </button>
      </div>
      <pre className="max-h-[70vh] overflow-auto rounded-md bg-ink p-3 font-mono text-[11px] text-soft">{JSON.stringify(md.metadata, null, 2)}</pre>
    </div>
  );
}

function Access({ t, onChanged }: { t: IcebergTable; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [stop, setStop] = useState(false);
  const set = async (change: { protected?: boolean; stop_propagating?: string[] }) => {
    try {
      await iceberg.access(t.id, change);
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-5 text-xs">
      <section>
        <h3 className="mb-1 font-medium">Main branch protection</h3>
        <p className="mb-2 text-muted">
          Changes to main outside the table&apos;s owning job ({t.producer ? `${t.producer.repo ?? ""} · ${t.producer.name}` : "none yet"}) — from external clients, maintenance
          tasks or other jobs — need the Owner role (iceberg:bypass-branch-protection).
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!t.can_own} checked={t.protected} onChange={(e) => set({ protected: e.target.checked })} /> Protect main
        </label>
      </section>
      <section>
        <h3 className="mb-1 font-medium">Markings</h3>
        <p className="mb-2 text-muted">
          A marking inherited by any retained snapshot (on any branch) restricts the whole table — deleting the branch is not enough. Expire the marked snapshots once
          no branch or tag references them, or stop propagating the marking.
        </p>
        {t.markings.length ? (
          <ul className="space-y-1">
            {t.markings.map((m) => (
              <li key={m} className="flex items-center gap-2">
                <span className="rounded bg-bad/15 px-1.5 py-0.5 text-bad">{m}</span>
                {t.can_own && (
                  <button type="button" onClick={() => (setStop(true), set({ stop_propagating: [...t.stop_propagating, m] }))} className="text-muted hover:text-white">
                    Stop propagating
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">No markings.</p>
        )}
        {t.stop_propagating.length > 0 && (
          <div className="mt-2">
            <span className="text-muted">Not propagated:</span>{" "}
            {t.stop_propagating.map((m) => (
              <button key={m} type="button" disabled={!t.can_own} onClick={() => set({ stop_propagating: t.stop_propagating.filter((x) => x !== m) })} className="mr-1 rounded bg-panel-2 px-1.5 py-0.5 hover:text-white" title="Propagate again">
                {m} ×
              </button>
            ))}
          </div>
        )}
        {stop && <p className="mt-2 text-muted">Stopping propagation exposes the marked data to users without the marking.</p>}
      </section>
      {error && <p className="text-bad">{error}</p>}
    </div>
  );
}

function UseTable({ t }: { t: IcebergTable }) {
  const path = `/${[...t.path, t.name].join("/")}`;
  const snippets: [string, string][] = [
    [
      "Python transforms (single node)",
      `from transforms.api import transform\nfrom transforms.tables import IcebergInput, IcebergOutput, TableInput, TableOutput\n\n\n@transform.using(\n    source=TableInput("${path}"),\n    output=TableOutput("${path}_clean"),\n)\ndef compute(source: IcebergInput, output: IcebergOutput):\n    output.write_table(source.polars())`,
    ],
    [
      "Python transforms (Spark SQL)",
      `@transform.spark.using(source=TableInput("${path}"), output=TableOutput("${path}_merged"))\ndef compute(ctx, source, output):\n    ctx.spark_session.sql(f"SELECT * FROM {source.identifier}")`,
    ],
    ["PyIceberg (any client)", `table = catalog.load_table("${t.rid}")\ntable.scan().to_pandas()`],
    ["Spark SQL (external)", `SELECT * FROM foundry.${[...t.path, t.name].map((p) => "`" + p + "`").join(".")};`],
  ];
  return (
    <div className="space-y-3 text-xs">
      {snippets.map(([title, code]) => (
        <div key={title}>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-medium">{title}</span>
            <button type="button" onClick={() => navigator.clipboard?.writeText(code)} className="ml-auto text-muted hover:text-white">
              <Icon name="copy" className="h-3.5 w-3.5" />
            </button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-ink p-2 font-mono text-[11px] text-soft">{code}</pre>
        </div>
      ))}
      <Link href="/iceberg?tab=connect" className="text-ocean hover:underline">
        Connect external clients (tokens, OAuth2, Spark, Snowflake) →
      </Link>
    </div>
  );
}

/** A dialog shown by the Iceberg app: a new empty table. */
export function NewTableDialog({ parentId, parentName, onClose, onCreated }: { parentId: string | null; parentName: string; onClose: () => void; onCreated: (t: IcebergTable) => void }) {
  const [name, setName] = useState("");
  const [cols, setCols] = useState<{ name: string; type: string; key: boolean }[]>([{ name: "id", type: "bigint", key: true }]);
  const [partition, setPartition] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ enabled: boolean; storage: { name: string }; format_version: number; cse: boolean } | null>(null);
  useEffect(() => {
    iceberg.resolveStorage(parentId).then(setInfo, () => setInfo(null));
  }, [parentId]);
  const TYPES = ["string", "int", "bigint", "double", "float", "boolean", "date", "timestamp", "timestamp_ntz", "decimal(38,9)", "binary"];
  const create = async () => {
    try {
      const t = await iceberg.create({
        parent_id: parentId,
        name: name.trim(),
        columns: cols.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), type: c.type })),
        identifier_columns: cols.filter((c) => c.key && c.name.trim()).map((c) => c.name.trim()),
        partition_by: partition ? [partition] : [],
      });
      onCreated(t);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="New Iceberg table" icon="layers" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          In <span className="text-soft">{parentName}</span>
          {info &&
            (info.enabled ? (
              <>
                {" "}
                · {info.storage.name} · format v{info.format_version}
                {info.cse ? " · client-side encryption" : ""}
              </>
            ) : (
              <span className="text-warn"> · Iceberg tables are not enabled for this Project (Control Panel → Iceberg table settings)</span>
            ))}
        </p>
        <label className="block">
          <span className="text-xs text-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
        </label>
        <div>
          <span className="text-xs text-muted">Columns (★ identifier columns are required)</span>
          {cols.map((c, i) => (
            <div key={i} className="mt-1 flex items-center gap-2">
              <input value={c.name} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="column" className={`${inputClass} py-1 text-xs`} />
              <select value={c.type} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} className={`${fieldClass} py-1 text-xs`}>
                {TYPES.map((ty) => (
                  <option key={ty}>{ty}</option>
                ))}
              </select>
              <button type="button" onClick={() => setCols(cols.map((x, j) => (j === i ? { ...x, key: !x.key } : x)))} title="Identifier column" className={c.key ? "text-sand" : "text-muted"}>
                <Icon name="star" className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setCols(cols.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setCols([...cols, { name: "", type: "string", key: false }])} className={`${buttonClass.ghost} mt-1 py-1 text-xs`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Column
          </button>
        </div>
        <label className="block">
          <span className="text-xs text-muted">Partition by (identity)</span>
          <select value={partition} onChange={(e) => setPartition(e.target.value)} className={`${fieldClass} w-full py-1 text-xs`}>
            <option value="">Unpartitioned</option>
            {cols
              .filter((c) => c.name.trim())
              .map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
          </select>
        </label>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim() || (info !== null && !info.enabled)} onClick={create} className={buttonClass.primary}>
            Create table
          </button>
        </div>
      </div>
    </Modal>
  );
}
