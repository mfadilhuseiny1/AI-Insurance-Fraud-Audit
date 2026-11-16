"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { API_URL } from "@/lib/api";
import { alertDialog, promptDialog } from "@/lib/dialogs";
import { EditSchema } from "@/components/dataset/EditSchema";
import { PreviewTable } from "@/components/dataset/PreviewTable";
import { CompareTab, DetailsTab, HealthTab, HistoryTab } from "@/components/dataset/Tabs";
import { TimeTravel } from "@/components/dataset/TimeTravel";
import { IcebergDataset } from "@/components/dataset/iceberg/IcebergDataset";
import { folderHref } from "@/components/drive/ui";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { SqlConsole } from "@/components/sql/SqlConsole";
import { LiveRecords, MetricsTab, StreamTab } from "@/components/dataset/StreamTabs";
import { streaming, type StreamDataset } from "@/lib/streaming";
import { contour } from "@/lib/contour";
import { preparation } from "@/lib/preparation";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import {
  cellText,
  datasetHref,
  datasetPreview,
  formatBytes,
  typeShort,
  type ColumnStats,
  type DatasetSummary,
  type Issue,
  type Transaction,
} from "@/lib/datasetPreview";

type Tab = "preview" | "sql" | "stream" | "metrics" | "history" | "details" | "health" | "compare" | "time-travel";
const TABS: [Tab, string, IconName][] = [
  ["preview", "Preview", "table"],
  ["sql", "SQL", "database"],
  ["history", "History", "clock"],
  ["details", "Details", "info"],
  ["health", "Health", "bell"],
  ["compare", "Compare", "split"],
  ["time-travel", "Time Travel", "restore"],
];
// streaming datasets (a stream's archive, api/stream_datasets.py): Stream and Metrics; Health only in the Archive view
const STREAM_TABS: [Tab, string, IconName][] = [
  ["stream", "Stream", "wave"],
  ["metrics", "Metrics", "gauge"],
];

/** Dataset Preview: one dataset (a Parquet file, a CSV / TSV / JSON file or a folder of them) — see api/dataset_preview.py. */
export default function DatasetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ds, setDs] = useState<DatasetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const t = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return [...TABS, ...STREAM_TABS].some(([k]) => k === t) ? (t as Tab) : "preview";
  });
  const [stream, setStream] = useState<StreamDataset | null>(null);
  const [view, setView] = useState<"live" | "archive">("live");
  const [editing, setEditing] = useState(false);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [reload, setReload] = useState(0);
  const [reporting, setReporting] = useState<string | null | undefined>(undefined);
  const [uploading, setUploading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const load = useCallback(() => {
    datasetPreview.summary(id).then(setDs, (e: Error) => setError(e.message));
    datasetPreview.history(id).then((h) => setTxs(h.transactions), () => setTxs([]));
    streaming.byItem(id).then(setStream, () => setStream(null));
  }, [id]);
  useEffect(load, [load]);
  // a big dataset whose on-disk copy is being made: poll until every row can be read, then reload the preview
  const building = ds?.partial?.building?.state === "running";
  useEffect(() => {
    if (!building) return;
    const t = window.setInterval(() => {
      datasetPreview.summary(id).then((s) => {
        setDs(s);
        if (s.partial?.building?.state !== "running") setReload((n) => n + 1);
      }, () => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [building, id]);
  const pick = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", `${datasetHref(id)}${t === "preview" ? "" : `?tab=${t}`}`);
  };
  const changed = () => {
    load();
    setReload((n) => n + 1);
  };
  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading(f.name);
      try {
        const r = await datasetPreview.upload(id, f);
        setNotice(`${r.file}: ${r.mode === "update" ? "updated the file of the same name" : "appended"}${r.schema_inferred ? " · schema inferred" : ""}`);
      } catch (e) {
        setNotice(`${f.name}: ${(e as Error).message}`);
      }
    }
    setUploading(null);
    changed();
  };
  if (error) return <ApiError message={error} />;
  if (!ds) return <Loading />;
  // a Foundry Iceberg table: Snapshots, Maintenance, branches and the metadata JSON (api/iceberg_tables.py)
  if (ds.kind === "iceberg") return <IcebergDataset id={ds.id} />;
  const canUpload = ds.kind === "raw";
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => canUpload && (e.preventDefault(), setDragging(true))}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(false);
        upload(e.dataTransfer.files);
      }}
    >
      <Header ds={ds} onBranch={(itemId) => router.push(datasetHref(itemId))} onUpload={canUpload ? upload : undefined} onEditSchema={() => setEditing(true)} onReport={() => setReporting(null)} />
      {notice && (
        <button type="button" onClick={() => setNotice(null)} className="border-b border-line bg-ocean/10 px-4 py-1.5 text-left text-xs text-soft">
          {notice} <span className="text-muted">(dismiss)</span>
        </button>
      )}
      <div className="flex min-h-0 flex-1">
        <InfoPanel ds={ds} reload={reload} onEditSchema={() => setEditing(true)} onReport={(c) => setReporting(c)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 border-b border-line bg-panel px-2 text-sm">
            {[...TABS.slice(0, 2), ...(stream ? STREAM_TABS : []), ...TABS.slice(2)]
              .filter(([k]) => !(stream && view === "live" && k === "health"))
              .map(([k, l, icon]) => (
              <button key={k} type="button" onClick={() => pick(k)} className={`flex items-center gap-1.5 px-3 py-2 ${tab === k ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
                <Icon name={icon} className="h-3.5 w-3.5" /> {l}
                {k === "health" && ds.health?.status === "failing" && <span className="h-1.5 w-1.5 rounded-full bg-bad" />}
              </button>
            ))}
          </div>
          {stream && (
            <div className="flex shrink-0 items-center gap-3 border-b border-line bg-panel-2 px-4 py-1.5 text-xs">
              <Icon name="wave" className="h-3.5 w-3.5 text-ocean" />
              <span className="text-soft">
                Streaming dataset · archive of{" "}
                <Link href={`/streaming/streams/${stream.stream.id}`} className="text-ocean hover:underline">
                  {stream.stream.name}
                </Link>
              </span>
              <span className="text-muted">
                {stream.archive?.last_at ? `archived ${stream.archive.rows?.toLocaleString() ?? "?"} records every ${stream.archive.every_minutes} min · last ${stream.archive.last_at.slice(11, 19)}` : ""}
              </span>
              <div className="ml-auto flex overflow-hidden rounded-md border border-line-2">
                {(["live", "archive"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setView(v);
                      if (v === "live" && tab === "health") pick("preview");
                    }}
                    className={`px-2.5 py-1 ${view === v ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
                  >
                    {v === "live" ? "Live" : "Archive"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {stream && tab === "stream" && <StreamTab sd={stream} />}
          {stream && tab === "metrics" && <MetricsTab sd={stream} />}
          {stream && view === "live" && tab === "preview" && <LiveRecords sd={stream} />}
          {tab === "preview" &&
            !(stream && view === "live") &&
            (ds.preview_error ? (
              <div className="m-4 space-y-2 rounded-xl border border-bad/40 bg-bad/5 p-4 text-sm">
                <p className="text-bad">{ds.preview_error}</p>
                {ds.preview_errors && (
                  <ul className="list-disc pl-5 text-xs text-muted">
                    {ds.preview_errors.slice(0, 5).map((e, i) => (
                      <li key={i}>{e.file ? `${e.file}, row ${e.row}: ${e.error}` : e.error}</li>
                    ))}
                  </ul>
                )}
                {ds.kind !== "parquet" && (
                  <button type="button" onClick={() => setEditing(true)} className={buttonClass.secondary}>
                    <Icon name="sliders" className="h-3.5 w-3.5" /> Edit schema
                  </button>
                )}
              </div>
            ) : ds.kind === "raw" && ds.files === 0 ? (
              <div className="m-6 rounded-xl border-2 border-dashed border-line-2 p-10 text-center text-sm text-muted">
                Drag and drop .csv, .tsv, .xls, .xlsm or .xlsx files here (or use Upload files). The schema is inferred from the first file.
              </div>
            ) : (
              <PreviewTable key={reload} datasetId={ds.id} onReportIssue={(c) => setReporting(c)} />
            ))}
          {tab === "sql" && <SqlConsole resource={`ri.foundry.main.dataset.${ds.id}`} name={ds.name} />}
          {tab === "history" && <HistoryTab key={reload} ds={ds} onBranch={(itemId) => router.push(datasetHref(itemId))} />}
          {tab === "details" && <DetailsTab ds={ds} onEditSchema={() => setEditing(true)} onChanged={changed} />}
          {tab === "health" && <HealthTab ds={ds} />}
          {tab === "compare" && <CompareTab ds={ds} transactions={txs} />}
          {tab === "time-travel" && <TimeTravel key={txs.length} ds={ds} transactions={txs} />}
        </div>
      </div>
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-ocean bg-ink/70 text-sm text-white">
          Drop .csv, .tsv or Excel files to add them to {ds.name}
        </div>
      )}
      {uploading && <div className="absolute bottom-4 right-4 z-30 rounded-md border border-line bg-panel px-3 py-2 text-xs shadow-xl">Uploading {uploading}…</div>}
      {editing && ds.schema && (
        <EditSchema
          datasetId={ds.id}
          initial={ds.schema}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice("Schema saved");
            changed();
          }}
        />
      )}
      {reporting !== undefined && <IssueDialog ds={ds} column={reporting} onClose={() => setReporting(undefined)} onDone={() => (setReporting(undefined), changed())} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ header

function Header({
  ds,
  onBranch,
  onUpload,
  onEditSchema,
  onReport,
}: {
  ds: DatasetSummary;
  onBranch: (itemId: string) => void;
  onUpload?: (files: FileList) => void;
  onEditSchema: () => void;
  onReport: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);
  const router = useRouter();
  const path = ds.path.map((p) => p.name).join("/");
  const inputSnippet = `Input("/${path}/${ds.name}")`;
  const actions: { label: string; icon: IconName; href?: string; onClick?: () => void; external?: boolean }[] = [
    { label: "Open in Files & Projects", icon: "folder", href: folderHref(ds.kind === "raw" ? ds.id : ds.parent_id) },
    ...(ds.lineage_id ? [{ label: "Explore in Data Lineage", icon: "split" as IconName, href: `/lineage?node=${encodeURIComponent(ds.lineage_id)}` }] : []),
    { label: "Use in Pipeline Builder", icon: "pipeline", href: "/pipeline" },
    ...(ds.kind !== "raw"
      ? [{
          label: "Analyze in Contour",
          icon: "filter" as IconName,
          onClick: () => contour.create(`${ds.name.replace(/\.parquet$/i, "")} analysis`, { kind: "dataset", id: ds.id }).then((a) => router.push(`/analytics/${a.item.id}`), (e: Error) => window.alert(e.message)),
        }]
      : []),
    { label: "Create a recipe", icon: "bell", href: `/recipes?new=${ds.id}` },
    {
      label: "Clean in Preparation",
      icon: "transform",
      onClick: () => preparation.create(ds.id).then((p) => router.push(`/preparation/${p.id}`), (e: Error) => window.alert(e.message)),
    },
    { label: "Copy Input(...) for Code Repositories", icon: "code", onClick: () => navigator.clipboard?.writeText(inputSnippet) },
    { label: "Monitor in Data Health", icon: "bell", href: `/data-health?add=${encodeURIComponent(`dataset:${ds.id}`)}&name=${encodeURIComponent(ds.name)}` },
    { label: "Scan for sensitive data", icon: "search", href: `/sensitive-data-scanner?include=${ds.id}&name=${encodeURIComponent(ds.name)}` },
    { label: "View audit log (who loaded or exported it)", icon: "history", href: `/security-auditing?resource=${ds.id}` },
    { label: "Download as CSV", icon: "download", href: datasetPreview.downloadUrl(ds.id), external: true },
    { label: "Download as CSV for Excel (; and UTF-8 BOM)", icon: "download", href: datasetPreview.downloadUrl(ds.id, { delimiter: ";", bom: true }), external: true },
    { label: "Download as Parquet", icon: "download", href: datasetPreview.downloadUrl(ds.id, { format: "parquet" }), external: true },
    ...(ds.kind !== "parquet" ? [{ label: "Edit schema", icon: "sliders" as IconName, onClick: onEditSchema }] : []),
    { label: "Report an issue", icon: "alert", onClick: onReport },
  ];
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
      <Icon name={ds.kind === "raw" ? "folder" : "table"} className="h-5 w-5 text-ocean" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-semibold">{ds.name}</h1>
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">{ds.kind === "parquet" ? "Parquet dataset" : ds.kind === "raw" ? "Raw dataset · files" : "File dataset"}</span>
          {ds.partial && (
            <span
              className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn"
              title={
                ds.partial.building?.state === "running"
                  ? "Until every row has been read, filters, sorting, statistics and SQL apply to the first rows; the page switches to all rows by itself"
                  : "Filters, sorting, statistics and SQL apply to the part that was read; download the files from Files for the whole data"
              }
            >
              Partial preview: {ds.partial.reason}
            </span>
          )}
          {ds.out_of_core && (
            <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok" title={ds.out_of_core.note}>
              Big dataset · all {ds.out_of_core.rows.toLocaleString()} rows read from disk
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
          {ds.path.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1">
              {i > 0 && "/"}
              <Link href={folderHref(p.id)} className="hover:text-white hover:underline">
                {p.name}
              </Link>
            </span>
          ))}
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(ds.id).then(() => setCopied(true))}
            className="ml-2 rounded border border-line px-1 font-mono hover:border-ocean"
            title="Copy the dataset id"
          >
            {copied ? "copied" : ds.id}
          </button>
        </div>
      </div>
      <span className="ml-auto" />
      {onBranch && (
        <button
          type="button"
          title="Create a branch of this dataset from its current version"
          onClick={async () => {
            const name = await promptDialog("Name of the new branch", "", { title: "Create branch" });
            if (!name) return;
            try {
              onBranch((await datasetPreview.createBranch(ds.id, name)).item_id);
            } catch (e) {
              alertDialog((e as Error).message);
            }
          }}
          className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white"
          aria-label="Create branch"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
        </button>
      )}
      {ds.branches.length > 0 && (
        <label className="flex items-center gap-1 text-xs text-muted" title="Branch">
          <Icon name="split" className="h-3.5 w-3.5" />
          <select value={ds.id} onChange={(e) => onBranch(e.target.value)} className="rounded border border-line-2 bg-ink px-1.5 py-1 text-xs text-soft">
            {ds.branches.map((b) => (
              <option key={b.item_id} value={b.item_id}>
                {b.branch}
              </option>
            ))}
          </select>
        </label>
      )}
      {onUpload && (
        <label className={`${buttonClass.secondary} cursor-pointer py-1 text-xs`}>
          <Icon name="upload" className="h-3.5 w-3.5" /> Upload files
          <input type="file" multiple accept=".csv,.tsv,.xls,.xlsm,.xlsx" className="hidden" onChange={(e) => e.target.files && onUpload(e.target.files)} />
        </label>
      )}
      {ds.lineage_id && ds.producers.length > 0 && (
        <Link href={`/lineage?node=${encodeURIComponent(ds.lineage_id)}`} className={`${buttonClass.secondary} py-1 text-xs`} title="Build it from Data Lineage">
          <Icon name="play" className="h-3.5 w-3.5" /> Build
        </Link>
      )}
      <div className="relative">
        <button type="button" onClick={(e) => (e.stopPropagation(), setMenu(!menu))} className={`${buttonClass.primary} py-1 text-xs`}>
          All actions <Icon name="down" className="h-3.5 w-3.5" />
        </button>
        {menu && (
          <div className="absolute right-0 z-40 mt-1 w-72 rounded-md border border-line bg-panel py-1 text-xs shadow-2xl">
            {actions.map((a) =>
              a.href ? (
                a.external ? (
                  <a key={a.label} href={a.href} className="flex items-center gap-2 px-3 py-1.5 hover:bg-panel-2">
                    <Icon name={a.icon} className="h-3.5 w-3.5 text-muted" /> {a.label}
                  </a>
                ) : (
                  <Link key={a.label} href={a.href} className="flex items-center gap-2 px-3 py-1.5 hover:bg-panel-2">
                    <Icon name={a.icon} className="h-3.5 w-3.5 text-muted" /> {a.label}
                  </Link>
                )
              ) : (
                <button key={a.label} type="button" onClick={a.onClick} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-2">
                  <Icon name={a.icon} className="h-3.5 w-3.5 text-muted" /> {a.label}
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </header>
  );
}

// ------------------------------------------------------------------------------------------------ information panel

function InfoPanel({ ds, reload, onEditSchema, onReport }: { ds: DatasetSummary; reload: number; onEditSchema: () => void; onReport: (column: string | null) => void }) {
  const [open, setOpen] = useState({ about: true, columns: true, schedules: true, issues: false });
  const [stats, setStats] = useState<ColumnStats[] | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    if (ds.preview_error) return;
    datasetPreview.columns(ds.id).then(setStats, () => setStats([]));
    datasetPreview.issues(ds.id).then(setIssues, () => setIssues([]));
  }, [ds.id, ds.preview_error, reload]);
  const section = (k: keyof typeof open, title: string, extra?: ReactNode) => (
    <button type="button" onClick={() => setOpen({ ...open, [k]: !open[k] })} className="flex w-full items-center gap-1 border-b border-line px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted">
      <Icon name={open[k] ? "down" : "right"} className="h-3 w-3" /> {title}
      {extra}
    </button>
  );
  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel text-xs">
      {section("about", "About")}
      {open.about && (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 border-b border-line px-3 py-2">
          <dt className="text-muted">Created</dt>
          <dd>{when(ds.created_at)}</dd>
          <dt className="text-muted">Updated</dt>
          <dd>
            {when(ds.updated_at)}
            {ds.last_transaction && <span className="text-muted"> · {ds.last_transaction.kind}{ds.last_transaction.source?.by ? ` by ${String(ds.last_transaction.source.by)}` : ""}</span>}
          </dd>
          {ds.kind !== "parquet" && (
            <>
              <dt className="text-muted">Schema</dt>
              <dd>
                <button type="button" onClick={onEditSchema} className="text-ocean hover:underline">
                  Edit schema
                </button>{" "}
                <span className="text-muted">{ds.schema_saved ? "" : "(inferred)"}</span>
              </dd>
            </>
          )}
          <dt className="text-muted">Size</dt>
          <dd>
            {ds.rows?.toLocaleString() ?? "?"} rows · {ds.columns.length} columns · {formatBytes(ds.size)}
            {ds.kind === "raw" ? ` · ${ds.files} files` : ""}
          </dd>
          <dt className="text-muted">Transactions</dt>
          <dd>{ds.transactions}</dd>
          <dt className="text-muted">Built by</dt>
          <dd>
            {ds.producers.length
              ? ds.producers.map((p) => (
                  <div key={p.id}>
                    {p.link ? (
                      <Link href={p.link} className="text-ocean hover:underline">
                        {p.name}
                      </Link>
                    ) : (
                      p.name
                    )}{" "}
                    <span className="text-muted">({p.kind})</span>
                  </div>
                ))
              : ds.kind === "parquet"
                ? "—"
                : "uploads"}
          </dd>
          <dt className="text-muted">Inputs</dt>
          <dd>{ds.inputs.length ? ds.inputs.filter((i) => i.kind === "dataset" || i.kind === "datasource").map((i) => i.name).join(", ") || "—" : "—"}</dd>
          {ds.outputs.length > 0 && (
            <>
              <dt className="text-muted">Used by</dt>
              <dd>{ds.outputs.map((o) => o.name).join(", ")}</dd>
            </>
          )}
          {Object.entries(ds.custom_metadata).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {section("columns", `Columns (${ds.columns.length})`)}
      {open.columns && (
        <p className={`border-b border-line px-3 py-1 text-[10px] ${ds.partial ? "text-warn" : "text-muted"}`}>
          {ds.partial
            ? `Statistics cover the first ${ds.partial.rows_read.toLocaleString()} rows${ds.partial.building?.state === "running" ? " until every row has been read" : ""}`
            : ds.rows !== null && ds.rows !== undefined
              ? `Statistics cover all ${ds.rows.toLocaleString()} rows${ds.out_of_core ? " (read from disk)" : ""}`
              : ""}
        </p>
      )}
      {open.columns && (
        <ul className="border-b border-line">
          {(stats ?? ds.columns.map((c) => ({ ...c, nulls: 0, null_pct: 0, distinct: 0, top: [], open_issues: 0 }) as ColumnStats)).map((c) => (
            <li key={c.name} className="border-b border-line last:border-0">
              <button type="button" onClick={() => setExpanded(expanded === c.name ? null : c.name)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-2">
                <span className="w-9 shrink-0 rounded bg-panel-2 px-1 text-center font-mono text-[9px] text-muted">{typeShort(c.type)}</span>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.open_issues > 0 && <span className="rounded bg-warn/20 px-1 text-[9px] text-warn">{c.open_issues} issue{c.open_issues > 1 ? "s" : ""}</span>}
                {stats && <span className={`tabular-nums ${c.null_pct > 0 ? "text-warn" : "text-muted"}`}>{c.null_pct}% null</span>}
              </button>
              {expanded === c.name && stats && (
                <div className="space-y-1 bg-ink/40 px-3 py-2">
                  {c.description && <p className="text-soft">{c.description}</p>}
                  <div className="text-muted">
                    {c.distinct.toLocaleString()} distinct · {c.nulls.toLocaleString()} null
                    {c.min !== undefined && ` · min ${cellText(c.min)} · max ${cellText(c.max)}`}
                    {typeof c.mean === "number" && ` · mean ${c.mean.toLocaleString(undefined, { maximumFractionDigits: 3 })}`}
                  </div>
                  {c.top.map((t) => {
                    const max = c.top[0]?.count || 1;
                    return (
                      <div key={cellText(t.value)} className="flex items-center gap-1.5">
                        <span className="w-24 shrink-0 truncate font-mono" title={cellText(t.value)}>
                          {cellText(t.value)}
                        </span>
                        <span className="h-2 rounded-sm bg-ocean/60" style={{ width: `${(t.count / max) * 60}%` }} />
                        <span className="text-muted">{t.count}</span>
                      </div>
                    );
                  })}
                  <button type="button" onClick={() => onReport(c.name)} className="text-ocean hover:underline">
                    Report an issue on {c.name}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {section("issues", `Issues (${issues.filter((i) => i.status === "open").length} open)`)}
      {open.issues && <IssueList ds={ds} issues={issues} onChanged={() => datasetPreview.issues(ds.id).then(setIssues)} onReport={() => onReport(null)} />}
      {section("schedules", `Schedules (${ds.schedules.length})`)}
      {open.schedules && (
        <div className="px-3 py-2">
          {!ds.schedules.length && <p className="text-muted">No build schedule updates this dataset.</p>}
          {ds.schedules.map((s, i) => (
            <div key={i} className="mb-1.5">
              <div className="flex items-center gap-1.5">
                <span className={s.enabled === false ? "text-muted" : "text-ok"}>●</span>
                {s.producer_link ? (
                  <Link href={s.producer_link} className="hover:underline">
                    {s.name || "Schedule"}
                  </Link>
                ) : (
                  (s.name ?? "Schedule")
                )}
              </div>
              <div className="pl-4 text-muted">
                {s.cron ?? ""} · {s.producer}
              </div>
            </div>
          ))}
          <Link href="/schedules" className="text-ocean hover:underline">
            Build Schedules →
          </Link>
        </div>
      )}
    </aside>
  );
}

function IssueList({ ds, issues, onChanged, onReport }: { ds: DatasetSummary; issues: Issue[]; onChanged: () => void; onReport: () => void }) {
  const [comment, setComment] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<{ id: string; label: string }[]>([]);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => {
    datasetPreview.people().then(setPeople, () => {});
    fetch(`${API_URL}/api/auth/me`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u: { id?: string } | null) => setMe(u?.id ?? "local"), () => setMe("local"));
  }, []);
  return (
    <div className="space-y-2 border-b border-line px-3 py-2">
      {!issues.length && <p className="text-muted">No issues reported.</p>}
      {issues.map((i) => (
        <div key={i.id} className="rounded border border-line p-2">
          <div className="flex items-center gap-1.5">
            <span className={i.status === "open" ? "text-warn" : "text-ok"}>{i.status === "open" ? "●" : "✓"}</span>
            <span className="font-medium">{i.title}</span>
            {i.column && <span className="rounded bg-panel-2 px-1 font-mono text-[10px] text-muted">{i.column}</span>}
          </div>
          {i.description && <p className="mt-1 text-soft">{i.description}</p>}
          <p className="mt-0.5 text-[10px] text-muted">
            {i.author} · {when(i.created_at)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <label className="flex items-center gap-1">
              Assignee
              <select
                value={i.assignee ?? ""}
                onChange={(e) => datasetPreview.updateIssue(ds.id, i.id, { assignee: e.target.value }).then(onChanged)}
                className="rounded border border-line-2 bg-ink px-1 py-0.5 text-soft"
              >
                <option value="">Unassigned</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {i.assignee && !people.some((p) => p.id === i.assignee) && <option value={i.assignee}>{i.assignee}</option>}
              </select>
            </label>
            {me && (
              <button type="button" onClick={() => datasetPreview.updateIssue(ds.id, i.id, { watch: !(i.watchers ?? []).includes(me) }).then(onChanged)} className="text-ocean hover:underline">
                {(i.watchers ?? []).includes(me) ? "Unwatch" : "Watch"}
              </button>
            )}
            <span>{(i.watchers ?? []).length} watching</span>
          </div>
          {i.comments.map((c, k) => (
            <p key={k} className="mt-1 border-l border-line-2 pl-2 text-soft">
              {c.text} <span className="text-[10px] text-muted">— {c.author}</span>
            </p>
          ))}
          <div className="mt-1.5 flex gap-1">
            <input value={comment[i.id] ?? ""} onChange={(e) => setComment({ ...comment, [i.id]: e.target.value })} placeholder="Comment" className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-1.5 py-0.5" />
            <button
              type="button"
              onClick={() => datasetPreview.updateIssue(ds.id, i.id, { comment: comment[i.id] }).then(() => (setComment({ ...comment, [i.id]: "" }), onChanged()))}
              disabled={!comment[i.id]?.trim()}
              className="text-ocean disabled:opacity-40"
            >
              Send
            </button>
            <button type="button" onClick={() => datasetPreview.updateIssue(ds.id, i.id, { status: i.status === "open" ? "resolved" : "open" }).then(onChanged)} className="text-muted hover:text-white">
              {i.status === "open" ? "Resolve" : "Reopen"}
            </button>
          </div>
        </div>
      ))}
      <button type="button" onClick={onReport} className="text-ocean hover:underline">
        + Report an issue
      </button>
    </div>
  );
}

function IssueDialog({ ds, column, onClose, onDone }: { ds: DatasetSummary; column: string | null; onClose: () => void; onDone: () => void }) {
  const [col, setCol] = useState(column ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Report an issue" icon="alert" onClose={onClose}>
      <form
        className="space-y-3 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          datasetPreview.reportIssue(ds.id, { column: col || null, title, description }).then(onDone, (err: Error) => setError(err.message));
        }}
      >
        <select value={col} onChange={(e) => setCol(e.target.value)} className={inputClass}>
          <option value="">The whole dataset</option>
          {ds.columns.map((c) => (
            <option key={c.name} value={c.name}>
              Column {c.name}
            </option>
          ))}
        </select>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is wrong?" required className={inputClass} />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Details (optional)" className={inputClass} />
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={!title.trim()} className={buttonClass.primary}>
            Report
          </button>
        </div>
      </form>
    </Modal>
  );
}
