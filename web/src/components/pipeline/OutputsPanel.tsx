"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { outputLocation } from "@/lib/deployed";
import { when } from "@/lib/format";
import { iceberg } from "@/lib/iceberg";
import {
  checkExpectations,
  EXPECTATION_KINDS,
  expectationLabel,
  mappedCount,
  newGroup,
  outputTable,
  readFilter,
  refLabel,
  toCsv,
  uid,
  WRITE_MODES,
  writeModeOf,
  writeModeProblems,
  type Column,
  type DriveLocation,
  type Expectation,
  type NodeResult,
  type ObjectProperty,
  type Output,
  type OutputColumn,
  type OutputKind,
  type Pipeline,
  type PipelineNode,
  type Table,
} from "@/lib/pipeline";
import { DrivePicker } from "../DrivePicker";
import { Icon, type IconName } from "../Icon";
import { ColumnMultiSelect } from "./ColumnMultiSelect";
import { TYPE_MARK } from "./DataPreview";
import { GroupBody, MatchSelect } from "./FilterForm";
import { OUTPUT_ICON } from "./Graph";
import { OutputInterfaces } from "./OutputInterfaces";
import { buttonClass, inputClass } from "./Modal";
import { allowExport } from "@/lib/checkpoints";

export async function download(name: string, text: string, type: string) {
  if (!(await allowExport({ detail: `Pipeline output preview ${name}` }))) return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const fileName = (name: string) => name.replace(/[^\w.-]+/g, "_") || "output";

/** The output's result, or why it cannot be built. */
export function outputResult(o: Output, upstream: NodeResult | undefined): { table?: Table; error?: string } {
  if (!upstream) return { error: "Its input node was removed" };
  if (upstream.error !== undefined) return { error: upstream.error };
  try {
    const t = outputTable(o, upstream.table);
    const problem = kindProblem(o, t);
    return problem ? { table: t, error: problem } : { table: t };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** What an output of a kind still needs before it can deploy. */
function kindProblem(o: Output, t: Table): string | null {
  const has = (c: string | undefined) => !!c && t.columns.some((x) => x.name === c);
  switch (o.kind ?? "dataset") {
    case "objectType": {
      const ot = o.objectType;
      if (!ot?.apiName.trim()) return "Name the object type (API name)";
      if (!has(ot.primaryKey)) return "Choose a primary key column";
      if (!has(ot.titleProperty)) return "Choose a title property";
      return null;
    }
    case "linkType": {
      const l = o.linkType;
      if (!l?.from || !l.to) return "Choose the two object types to link";
      if (!l.apiName.trim()) return "Name the link type";
      if (l.cardinality === "many-to-many" && (!has(l.fromKey) || !has(l.toKey))) return "Choose the two key columns of the join table";
      if (l.cardinality !== "many-to-many" && !l.fromKey) return "Choose the foreign key column";
      return null;
    }
    case "timeSeries":
      return o.timeSeries && has(o.timeSeries.seriesId) && has(o.timeSeries.timestamp) && has(o.timeSeries.value) ? null : "Map the series id, timestamp and value columns";
    case "geotemporal":
      return o.geotemporal && has(o.geotemporal.seriesId) && has(o.geotemporal.timestamp) && has(o.geotemporal.latitude) && has(o.geotemporal.longitude)
        ? null
        : "Map the series id, timestamp, latitude and longitude columns";
    case "mediaSet":
      return has(o.mediaSet?.mediaColumn) ? null : "Choose the media reference column";
    case "virtualTable":
      return o.virtualTable?.connectionId && o.virtualTable.table.trim() ? null : "Choose the source and table to write";
    case "file":
      return o.file?.format === "txt" && !has(o.file.textColumn) ? "Choose the text column to write" : null;
    default:
      return null;
  }
}

export function DeployStatus({ o, compact }: { o: Output; compact?: boolean }) {
  return o.deployed ? (
    <span className="flex items-center gap-1.5 text-xs text-ok" title={`Version ${o.deployed.version}, ${when(o.deployed.at)}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
      {compact ? `Deployed v${o.deployed.version}` : `Deployed v${o.deployed.version} · ${when(o.deployed.at)} · ${o.deployed.rows.toLocaleString()} rows`}
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span className="h-2 w-2 shrink-0 rounded-full border border-muted" /> Not yet deployed
    </span>
  );
}

export const OUTPUT_KINDS: { kind: OutputKind; label: string; hint: string; icon: IconName }[] = [
  { kind: "dataset", label: "New dataset", hint: "A Parquet dataset in Files & Projects", icon: "table" },
  { kind: "icebergTable", label: "New Foundry Iceberg table", hint: "An Iceberg table (Projects with Iceberg storage)", icon: "layers" },
  { kind: "objectType", label: "New object type", hint: "An Nexus object type backed by the output", icon: "graph" },
  { kind: "linkType", label: "New link type", hint: "A relationship between two object type outputs", icon: "link" },
  { kind: "timeSeries", label: "New time series sync", hint: "Timestamp / value pairs per series", icon: "wave" },
  { kind: "geotemporal", label: "New geotemporal series sync", hint: "Positions of entities over time", icon: "globe" },
  { kind: "virtualTable", label: "New virtual table", hint: "A table written to an external database", icon: "database" },
  { kind: "mediaSet", label: "New media set", hint: "Media files referenced by a column", icon: "image" },
  { kind: "file", label: "New file", hint: "CSV, JSON, JSON Lines, Parquet or text", icon: "doc" },
];
export const OUTPUT_KIND_LABEL = Object.fromEntries(OUTPUT_KINDS.map((k) => [k.kind, k.label.replace(/^New /, "")])) as Record<OutputKind, string>;

/** The kinds of output to add: the menu next to a node and under the gold buttons. */
export function OutputKindList({ onPick, className = "", external }: { onPick: (kind: OutputKind) => void; className?: string; external?: boolean }) {
  return (
    <div className={`w-64 rounded-lg border border-line-2 bg-panel-2 py-1 text-left shadow-xl ${className}`}>
      {OUTPUT_KINDS.map((k) => {
        const off = external && k.kind !== "virtualTable";
        return (
          <button
            key={k.kind}
            type="button"
            disabled={off}
            title={off ? "External pipelines write virtual tables only" : k.hint}
            onClick={() => onPick(k.kind)}
            className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sand hover:bg-sand/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name={k.icon} className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{k.label}</span>
              <span className="block truncate text-[11px] text-muted">{k.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The gold "Add output" button and its menu. `onAdd` is null when no node is selected. */
export function AddOutputMenu({ onAdd, align = "right" }: { onAdd: ((kind: OutputKind) => void) | null; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="relative shrink-0" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={!onAdd}
        title={onAdd ? "Add an output for the selected node" : "Select a node on the graph first"}
        className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-sand px-2.5 py-1.5 text-xs font-medium text-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="plus" className="h-3.5 w-3.5" /> Add output <Icon name="down" className="h-3.5 w-3.5" />
      </button>
      {open && onAdd && (
        <OutputKindList
          className={`absolute top-full z-40 mt-1 ${align === "right" ? "right-0" : "left-0"}`}
          onPick={(k) => {
            setOpen(false);
            onAdd(k);
          }}
        />
      )}
    </div>
  );
}

/** Right panel: the outputs grouped by kind (and job group), or one output's editor. */
export function OutputsPanel({
  outputs,
  nodes,
  result,
  selected,
  onSelect,
  onAdd,
  onChange,
  onRemove,
  onDeploy,
  location,
  deploying,
  pipeline,
  onClose,
}: {
  outputs: Output[];
  nodes: PipelineNode[];
  result: (id: string) => NodeResult;
  selected: Output | undefined;
  onSelect: (outputId: string | null) => void;
  onAdd: ((kind: OutputKind) => void) | null;
  onChange: (outputId: string, patch: Partial<Output>) => void;
  onRemove: (outputId: string) => void;
  onDeploy: (outputIds: string[]) => void;
  location: DriveLocation | undefined;
  deploying: boolean;
  pipeline: Pipeline;
  onClose?: () => void;
}) {
  if (selected)
    return (
      <OutputEditor
        key={selected.id}
        o={selected}
        upstream={result(selected.node)}
        inputName={refLabel(nodes, selected.node)}
        location={outputLocation(selected, { location })}
        deploying={deploying}
        pipeline={pipeline}
        result={result}
        onBack={() => onSelect(null)}
        onChange={(patch) => onChange(selected.id, patch)}
        onRemove={() => onRemove(selected.id)}
        onDeploy={() => onDeploy([selected.id])}
      />
    );

  const kinds = OUTPUT_KINDS.filter((k) => outputs.some((o) => (o.kind ?? "dataset") === k.kind));
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-3 text-sm font-medium">
        <span className="flex-1">Pipeline outputs</span>
        <AddOutputMenu onAdd={onAdd} />
        {onClose && (
          <button type="button" onClick={onClose} title="Close panel" className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {outputs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <Icon name="output" className="h-8 w-8 text-line-2" />
          <div className="mt-2 text-sm font-medium">Pipeline outputs</div>
          <p className="mt-1 text-xs text-muted">
            Outputs are what your pipeline builds: datasets, object and link types, time series and geotemporal syncs, virtual tables, media sets and files. Deploys write
            them into Files &amp; Projects (or the external source).
          </p>
          <div className="mt-4">
            <AddOutputMenu onAdd={onAdd} align="left" />
          </div>
          {!onAdd && <p className="mt-2 text-xs text-muted">Select a node on the graph first.</p>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {kinds.map((k) => (
            <section key={k.kind}>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                <Icon name={k.icon} className="h-3 w-3" /> {k.label.replace(/^New /, "")}s
              </div>
              <ul className="space-y-1.5">
                {outputs
                  .filter((o) => (o.kind ?? "dataset") === k.kind)
                  .map((o) => {
                    const r = outputResult(o, result(o.node));
                    const results = r.table ? checkExpectations(r.table, o.expectations) : [];
                    const failing = results.filter((x) => !x.ok).length;
                    return (
                      <li key={o.id}>
                        <button type="button" onClick={() => onSelect(o.id)} className="w-full rounded-lg border border-line bg-panel-2 p-2.5 text-left text-sm hover:border-ocean/50">
                          <span className="flex items-center gap-2">
                            <Icon name={OUTPUT_ICON[o.kind ?? "dataset"]} className="h-4 w-4 shrink-0 text-ocean" />
                            <span className="min-w-0 flex-1 truncate font-medium">{o.name}</span>
                            <Icon name="right" className="h-3.5 w-3.5 text-muted" />
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted">
                            from {refLabel(nodes, o.node)}
                            {o.jobGroup ? ` · job ${pipeline.jobGroups?.find((g) => g.id === o.jobGroup)?.name ?? "?"}` : ""}
                          </span>
                          <span className="mt-1 block">
                            {r.error ? (
                              <span className="flex items-start gap-1.5 text-xs text-bad">
                                <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {r.error}
                              </span>
                            ) : (
                              <span className="flex items-center gap-2">
                                <DeployStatus o={o} compact />
                                {results.length > 0 && (
                                  <span className={`text-xs ${failing ? "text-bad" : "text-ok"}`}>
                                    {failing ? `${failing} expectation${failing > 1 ? "s" : ""} failing` : `${results.length} checks pass`}
                                  </span>
                                )}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
        </div>
      )}
      {outputs.length > 0 && (
        <div className="border-t border-line p-3">
          <button type="button" disabled={deploying} onClick={() => onDeploy(outputs.map((o) => o.id))} className={`${buttonClass.primary} w-full justify-center`}>
            <Icon name={deploying ? "refresh" : "upload"} className={`h-3.5 w-3.5 ${deploying ? "animate-spin" : ""}`} />
            {deploying ? "Deploying…" : "Deploy all pipeline outputs"}
          </button>
        </div>
      )}
    </aside>
  );
}

function ColumnSelect({ value, columns, onChange, placeholder = "Choose a column…" }: { value: string | undefined; columns: Column[]; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={`${inputClass} py-1 text-xs`}>
      <option value="">{placeholder}</option>
      {value && !columns.some((c) => c.name === value) && <option value={value}>{value} (missing)</option>}
      {columns.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name} · {c.type}
        </option>
      ))}
    </select>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[6.5rem_1fr] items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

function OutputEditor({
  o,
  upstream,
  inputName,
  location,
  deploying,
  pipeline,
  result,
  onBack,
  onChange,
  onRemove,
  onDeploy,
}: {
  o: Output;
  upstream: NodeResult;
  inputName: string;
  location: DriveLocation;
  deploying: boolean;
  pipeline: Pipeline;
  result: (id: string) => NodeResult;
  onBack: () => void;
  onChange: (patch: Partial<Output>) => void;
  onRemove: () => void;
  onDeploy: () => void;
}) {
  const kind = o.kind ?? "dataset";
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [open, setOpen] = useState<"expectations" | "mode" | "config" | "job" | null>(kind === "dataset" ? null : "config");
  const [dragging, setDragging] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const up = upstream.table;
  const upCols = up?.columns ?? [];
  const r = outputResult(o, upstream);
  const { mapped, total } = mappedCount(o, up);
  const mapping: OutputColumn[] = o.columns ?? upCols.map((c) => ({ source: c.name, name: c.name }));
  const setMapping = (columns: OutputColumn[]) => onChange({ columns });
  const exps = o.expectations ?? [];
  const results = r.table ? checkExpectations(r.table, exps) : [];
  const unmapped = upCols.filter((c) => !mapping.some((m) => m.source === c.name));
  const outCols = r.table?.columns ?? upCols;
  const rows = mapping
    .map((m, i) => ({ m, i, src: upCols.find((c) => c.name === m.source) }))
    .filter(({ m, src }) => m.name.toLowerCase().includes(search.toLowerCase()) && (!errorsOnly || !src));
  const writesFiles = kind !== "virtualTable";

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel text-sm">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-soft hover:text-white">
          <Icon name="left" className="h-3.5 w-3.5" /> Back to outputs
        </button>
        <button type="button" onClick={onRemove} title="Delete output" className="ml-auto rounded p-1 text-muted hover:bg-bad/10 hover:text-bad">
          <Icon name="trash" className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div>
          <div className="flex items-center gap-2">
            <Icon name={OUTPUT_ICON[kind]} className="h-4 w-4 shrink-0 text-ocean" />
            <input value={o.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Output name" className={inputClass} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 pl-6">
            <span className="text-xs text-soft">{OUTPUT_KIND_LABEL[kind]}</span>
            <DeployStatus o={o} />
            <span className="text-xs text-muted">from {inputName}</span>
          </div>
        </div>

        {writesFiles && (
          <div className="space-y-1.5 rounded-md border border-line-2 p-2.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-muted">Location</span>
              <Link href={location.id ? `/files/${location.id}` : "/files"} className="flex min-w-0 flex-1 items-center gap-1 text-soft hover:text-ocean" title={location.name}>
                <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-sand" />
                <span className="truncate">{location.name}</span>
              </Link>
              <button type="button" onClick={() => setBrowsing(true)} className="shrink-0 text-ocean hover:underline">
                Browse
              </button>
            </div>
            {o.location && (
              <button type="button" onClick={() => onChange({ location: undefined })} className="pl-[4.5rem] text-muted hover:text-white">
                Use the pipeline&apos;s folder
              </button>
            )}
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-muted">Writes</span>
              <span className="truncate text-soft">{writesText(o)}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-16 shrink-0 text-muted">Deployed</span>
              {o.deployed?.itemId ? (
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-soft">{o.deployed.path}</span>
                  {(o.deployed.parentId ?? null) !== location.id && <span className="block text-warn">The location changed — the next deploy creates a new output there.</span>}
                  <Link href={o.deployed.parentId ? `/files/${o.deployed.parentId}` : "/files"} className="mt-0.5 inline-flex items-center gap-1 text-ocean hover:underline">
                    <Icon name="external" className="h-3 w-3" /> Open in Files
                  </Link>
                </span>
              ) : (
                <span className="text-muted">Created by the first deploy.</span>
              )}
            </div>
          </div>
        )}
        {browsing && (
          <DrivePicker
            title="Output location"
            onClose={() => setBrowsing(false)}
            folder={{
              action: "Write the output here",
              onPick: (f) => {
                onChange({ location: { id: f.id, name: f.id ? f.name : "Files & Projects" } });
                setBrowsing(false);
              },
            }}
          />
        )}

        {kind !== "dataset" && (
          <Collapsible title={`Configure ${OUTPUT_KIND_LABEL[kind]}`} icon="sliders" open={open === "config"} onToggle={() => setOpen(open === "config" ? null : "config")}>
            <KindConfig o={o} columns={outCols} pipeline={pipeline} result={result} onChange={onChange} />
          </Collapsible>
        )}

        <div className={`flex items-center gap-1.5 text-xs ${mapped === total && total > 0 ? "text-ok" : "text-warn"}`}>
          <Icon name={mapped === total && total > 0 ? "check" : "alert"} className="h-3.5 w-3.5" />
          {mapped}/{total} columns mapped
          {!o.columns && <span className="text-muted">· input schema</span>}
        </div>
        {r.error && (
          <p className="flex items-start gap-1.5 rounded-md bg-bad/10 px-2 py-1.5 text-xs text-bad">
            <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {r.error}
          </p>
        )}

        <Collapsible
          title={`Configure expectations${exps.length ? ` (${results.filter((x) => x.ok).length}/${exps.length} pass)` : ""}`}
          icon="check"
          open={open === "expectations"}
          onToggle={() => setOpen(open === "expectations" ? null : "expectations")}
        >
          <ExpectationsEditor exps={exps} results={results} columns={outCols} onChange={(expectations) => onChange({ expectations })} />
        </Collapsible>

        {(kind === "dataset" || kind === "timeSeries" || kind === "geotemporal") && (
          <Collapsible
            title={`Configure write mode · ${WRITE_MODES.find((m) => m.id === writeModeOf(o))?.label}`}
            icon="sliders"
            open={open === "mode"}
            onToggle={() => setOpen(open === "mode" ? null : "mode")}
          >
            <WriteModeConfig o={o} columns={outCols} onChange={onChange} />
          </Collapsible>
        )}

        <Collapsible title="Job group" icon="layers" open={open === "job"} onToggle={() => setOpen(open === "job" ? null : "job")}>
          <div className="space-y-1.5 text-xs">
            <p className="text-muted">Outputs in one job group build in one job with one compute profile; ungrouped outputs each get a job of their own.</p>
            <select value={o.jobGroup ?? ""} onChange={(e) => onChange({ jobGroup: e.target.value || undefined })} className={`${inputClass} text-xs`}>
              <option value="">Ungrouped (single job)</option>
              {(pipeline.jobGroups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <p className="text-muted">Manage job groups in Build settings.</p>
          </div>
        </Collapsible>

        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1 text-xs">
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search columns…" className="min-w-0 flex-1 bg-transparent outline-none" />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-soft">
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} className="accent-[var(--color-ocean)]" />
            Errors only
          </label>
        </div>

        <ul className="space-y-1">
          {rows.map(({ m, i, src }) => (
            <li
              key={i}
              onDragOver={(e) => dragging !== null && e.preventDefault()}
              onDrop={() => {
                if (dragging === null || dragging === i) return;
                const next = [...mapping];
                const [moved] = next.splice(dragging, 1);
                next.splice(i, 0, moved);
                setMapping(next);
                setDragging(null);
              }}
              className={`flex items-center gap-1.5 ${dragging === i ? "opacity-40" : ""}`}
            >
              <span draggable onDragStart={() => setDragging(i)} onDragEnd={() => setDragging(null)} title="Drag to reorder" className="cursor-grab select-none px-0.5 font-mono text-xs text-muted hover:text-white">
                ⋮⋮
              </span>
              <span className="w-8 shrink-0 text-center font-mono text-[10px] text-muted" title={src?.type}>
                {src ? TYPE_MARK[src.type] : "?"}
              </span>
              <input
                value={m.name}
                onChange={(e) => setMapping(mapping.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                title={m.name !== m.source ? `from ${m.source}` : undefined}
                className={`${inputClass} min-w-0 flex-1 py-1 text-xs`}
              />
              <span title={src ? (m.name !== m.source ? `Mapped from ${m.source}` : "Mapped") : `"${m.source}" is not in the input`}>
                <Icon name={src ? "check" : "alert"} className={`h-4 w-4 ${src ? "text-ok" : "text-bad"}`} />
              </span>
              <button type="button" title="Remove column" onClick={() => setMapping(mapping.filter((_, j) => j !== i))} className="rounded p-0.5 text-muted hover:bg-bad/10 hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {!rows.length && <li className="py-2 text-center text-xs text-muted">{mapping.length ? "No matching columns." : "No columns."}</li>}
        </ul>

        <div className="flex gap-2">
          <button type="button" disabled={!o.columns} onClick={() => onChange({ columns: null })} className={`${buttonClass.secondary} flex-1 justify-center text-xs`} title="Use the input's schema as it is">
            Use input schema
          </button>
          <select
            value=""
            disabled={!unmapped.length}
            onChange={(e) => e.target.value && setMapping([...mapping, { source: e.target.value, name: e.target.value }])}
            className={`${inputClass} flex-1 text-xs`}
          >
            <option value="">{unmapped.length ? "+ Add column" : "All columns mapped"}</option>
            {unmapped.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2 border-t border-line p-3">
        <button type="button" disabled={!!r.error || deploying} onClick={onDeploy} className={`${buttonClass.primary} w-full justify-center`}>
          <Icon name={deploying ? "refresh" : "upload"} className={`h-3.5 w-3.5 ${deploying ? "animate-spin" : ""}`} />
          {deploying ? "Deploying…" : o.deployed ? "Deploy again" : "Deploy"}
        </button>
        {r.table && (
          <div className="flex gap-1.5">
            <button type="button" onClick={() => download(`${fileName(o.name)}.csv`, toCsv(r.table!), "text/csv")} className={`${buttonClass.secondary} flex-1 justify-center text-xs`}>
              <Icon name="download" className="h-3.5 w-3.5" /> CSV
            </button>
            <button
              type="button"
              onClick={() => download(`${fileName(o.name)}.json`, JSON.stringify(r.table!.rows, null, 2), "application/json")}
              className={`${buttonClass.secondary} flex-1 justify-center text-xs`}
            >
              <Icon name="download" className="h-3.5 w-3.5" /> JSON
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

const writesText = (o: Output) => {
  const base = (o.name.trim() || "output").replace(/\.\w+$/, "");
  switch (o.kind ?? "dataset") {
    case "file":
      return `${o.file?.fileName || base}.${o.file?.format ?? "csv"}`;
    case "mediaSet":
      return `${base}/ (a folder of the media files)`;
    case "objectType":
      return `${base}.parquet + ${base}.objecttype.json`;
    case "linkType":
      return `${base}.parquet + ${base}.linktype.json`;
    case "timeSeries":
      return `${base}.parquet + ${base}.timeseries.json`;
    case "geotemporal":
      return `${base}.parquet + ${base}.geotemporal.json`;
    case "icebergTable":
      return `Iceberg table · ${base}`;
    default:
      return `Parquet · ${base}.parquet`;
  }
};

function KindConfig({ o, columns, pipeline, result, onChange }: { o: Output; columns: Column[]; pipeline: Pipeline; result: (id: string) => NodeResult; onChange: (patch: Partial<Output>) => void }) {
  const kind = o.kind ?? "dataset";
  if (kind === "objectType") {
    const ot = o.objectType ?? { apiName: "", primaryKey: "", titleProperty: "", properties: null };
    const set = (patch: Partial<typeof ot>) => onChange({ objectType: { ...ot, ...patch } });
    const props: ObjectProperty[] = ot.properties ?? columns.map((c) => ({ source: c.name, apiName: camel(c.name), displayName: title(c.name), type: c.type }));
    return (
      <div className="space-y-2">
        <Row label="API name">
          <input value={ot.apiName} onChange={(e) => set({ apiName: e.target.value.replace(/[^A-Za-z0-9]/g, "") })} className={`${inputClass} py-1 text-xs`} />
        </Row>
        <Row label="Plural name">
          <input value={ot.pluralName ?? ""} placeholder={`${ot.apiName}s`} onChange={(e) => set({ pluralName: e.target.value })} className={`${inputClass} py-1 text-xs`} />
        </Row>
        <Row label="Description">
          <input value={ot.description ?? ""} onChange={(e) => set({ description: e.target.value })} className={`${inputClass} py-1 text-xs`} />
        </Row>
        <Row label="Primary key">
          <ColumnSelect value={ot.primaryKey} columns={columns} onChange={(v) => set({ primaryKey: v })} />
        </Row>
        <Row label="Title">
          <ColumnSelect value={ot.titleProperty} columns={columns} onChange={(v) => set({ titleProperty: v })} />
        </Row>
        <div className="text-xs text-muted">Properties (column → property)</div>
        <ul className="space-y-1">
          {props.map((p, i) => (
            <li key={p.source} className="flex items-center gap-1 text-xs">
              <span className="w-24 truncate font-mono text-[11px] text-soft" title={p.source}>
                {p.source}
              </span>
              <Icon name="right" className="h-3 w-3 shrink-0 text-muted" />
              <input value={p.apiName} onChange={(e) => set({ properties: props.map((x, j) => (j === i ? { ...x, apiName: e.target.value } : x)) })} className={`${inputClass} min-w-0 py-0.5 text-xs`} />
              <button type="button" title="Leave out" onClick={() => set({ properties: props.filter((_, j) => j !== i) })} className="rounded p-0.5 text-muted hover:text-bad">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => set({ properties: null })} className="text-xs text-ocean hover:underline">
          Generate properties from the output schema
        </button>
        <div className="space-y-1.5 border-t border-line pt-2 text-xs">
          <label className="flex items-center gap-1.5 text-soft">
            <input type="checkbox" checked={!!ot.register} onChange={(e) => set({ register: e.target.checked })} /> Register in the Nexus on deploy
          </label>
          <p className="text-[11px] text-muted">The first deploy creates the object type from the output dataset; later deploys re-index it. Interfaces below are implemented then.</p>
          <div className="text-muted">Interfaces</div>
          <OutputInterfaces value={ot.interfaces ?? []} properties={props.map((p) => ({ apiName: p.apiName, type: p.type }))} onChange={(v) => set({ interfaces: v })} />
        </div>
      </div>
    );
  }
  if (kind === "linkType") {
    const l = o.linkType ?? { from: "", to: "", cardinality: "many-to-one" as const, fromKey: "", toKey: "", apiName: "", reverseApiName: "" };
    const set = (patch: Partial<typeof l>) => onChange({ linkType: { ...l, ...patch } });
    const objects = pipeline.outputs.filter((x) => x.kind === "objectType");
    const objCols = (id: string) => {
      const ot = objects.find((x) => x.id === id);
      return ot ? (result(ot.node).table?.columns ?? []) : [];
    };
    return (
      <div className="space-y-2">
        {objects.length < 2 && <p className="text-xs text-warn">Add two object type outputs first; a link type relates them.</p>}
        <Row label="From object">
          <select value={l.from} onChange={(e) => set({ from: e.target.value })} className={`${inputClass} py-1 text-xs`}>
            <option value="">Choose…</option>
            {objects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.objectType?.apiName || x.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label="To object">
          <select value={l.to} onChange={(e) => set({ to: e.target.value })} className={`${inputClass} py-1 text-xs`}>
            <option value="">Choose…</option>
            {objects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.objectType?.apiName || x.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Cardinality">
          <select value={l.cardinality} onChange={(e) => set({ cardinality: e.target.value as typeof l.cardinality })} className={`${inputClass} py-1 text-xs`}>
            <option value="one-to-one">One to one</option>
            <option value="many-to-one">Many to one (foreign key)</option>
            <option value="many-to-many">Many to many (join table)</option>
          </select>
        </Row>
        {l.cardinality === "many-to-many" ? (
          <>
            <Row label="From key">
              <ColumnSelect value={l.fromKey} columns={columns} onChange={(v) => set({ fromKey: v })} placeholder="Join table column…" />
            </Row>
            <Row label="To key">
              <ColumnSelect value={l.toKey} columns={columns} onChange={(v) => set({ toKey: v })} placeholder="Join table column…" />
            </Row>
          </>
        ) : (
          <Row label="Foreign key">
            <ColumnSelect value={l.fromKey} columns={objCols(l.from)} onChange={(v) => set({ fromKey: v })} placeholder="Column of the From object…" />
          </Row>
        )}
        <Row label="API name">
          <input value={l.apiName} onChange={(e) => set({ apiName: e.target.value })} placeholder="e.g. employer" className={`${inputClass} py-1 text-xs`} />
        </Row>
        <Row label="Reverse name">
          <input value={l.reverseApiName} onChange={(e) => set({ reverseApiName: e.target.value })} placeholder="e.g. employees" className={`${inputClass} py-1 text-xs`} />
        </Row>
      </div>
    );
  }
  if (kind === "timeSeries") {
    const t = o.timeSeries ?? { seriesId: "", timestamp: "", value: "" };
    const set = (patch: Partial<typeof t>) => onChange({ timeSeries: { ...t, ...patch } });
    return (
      <div className="space-y-2">
        <Row label="Series id">
          <ColumnSelect value={t.seriesId} columns={columns} onChange={(v) => set({ seriesId: v })} />
        </Row>
        <Row label="Timestamp">
          <ColumnSelect value={t.timestamp} columns={columns.filter((c) => c.type === "Timestamp" || c.type === "Date" || c.type === "Long")} onChange={(v) => set({ timestamp: v })} />
        </Row>
        <Row label="Value">
          <ColumnSelect value={t.value} columns={columns} onChange={(v) => set({ value: v })} />
        </Row>
        <p className="text-xs text-muted">Indexes timestamp / value pairs per series to back time series properties.</p>
      </div>
    );
  }
  if (kind === "geotemporal") {
    const g = o.geotemporal ?? { seriesId: "", timestamp: "", latitude: "", longitude: "" };
    const set = (patch: Partial<typeof g>) => onChange({ geotemporal: { ...g, ...patch } });
    const num = columns.filter((c) => ["Float", "Double", "Decimal", "Integer", "Long"].includes(c.type));
    return (
      <div className="space-y-2">
        <Row label="Series id">
          <ColumnSelect value={g.seriesId} columns={columns} onChange={(v) => set({ seriesId: v })} />
        </Row>
        <Row label="Timestamp">
          <ColumnSelect value={g.timestamp} columns={columns} onChange={(v) => set({ timestamp: v })} />
        </Row>
        <Row label="Latitude">
          <ColumnSelect value={g.latitude} columns={num} onChange={(v) => set({ latitude: v })} />
        </Row>
        <Row label="Longitude">
          <ColumnSelect value={g.longitude} columns={num} onChange={(v) => set({ longitude: v })} />
        </Row>
        <div className="text-xs text-muted">Other properties</div>
        <ColumnMultiSelect value={g.properties ?? []} columns={columns} onChange={(v) => set({ properties: v })} placeholder="Columns…" />
      </div>
    );
  }
  if (kind === "mediaSet") {
    const m = o.mediaSet ?? { mediaColumn: "" };
    return (
      <div className="space-y-2">
        <Row label="Media column">
          <ColumnSelect value={m.mediaColumn} columns={columns} onChange={(v) => onChange({ mediaSet: { ...m, mediaColumn: v } })} />
        </Row>
        <Row label="File names">
          <ColumnSelect value={m.pathColumn} columns={columns} onChange={(v) => onChange({ mediaSet: { ...m, pathColumn: v || undefined } })} placeholder="Keep original names" />
        </Row>
        <p className="text-xs text-muted">Copies the media items the column references into a folder named after the output.</p>
      </div>
    );
  }
  if (kind === "file") {
    const f = o.file ?? { format: "csv" as const, fileName: o.name };
    const set = (patch: Partial<typeof f>) => onChange({ file: { ...f, ...patch } });
    return (
      <div className="space-y-2">
        <Row label="Format">
          <select value={f.format} onChange={(e) => set({ format: e.target.value as typeof f.format })} className={`${inputClass} py-1 text-xs`}>
            <option value="csv">CSV</option>
            <option value="json">JSON (array)</option>
            <option value="jsonl">JSON Lines</option>
            <option value="parquet">Parquet</option>
            <option value="txt">Plain text (one column)</option>
          </select>
        </Row>
        <Row label="File name">
          <input value={f.fileName} onChange={(e) => set({ fileName: e.target.value })} className={`${inputClass} py-1 text-xs`} />
        </Row>
        {f.format === "txt" && (
          <Row label="Text column">
            <ColumnSelect value={f.textColumn} columns={columns} onChange={(v) => set({ textColumn: v })} />
          </Row>
        )}
      </div>
    );
  }
  if (kind === "virtualTable") return <VirtualTableConfig o={o} onChange={onChange} />;
  if (kind === "icebergTable") return <IcebergOutputConfig o={o} pipeline={pipeline} />;
  return null;
}

/** Where a Foundry Iceberg table output is written: Iceberg must be enabled for the location's Project (Control Panel). */
function IcebergOutputConfig({ o, pipeline }: { o: Output; pipeline: Pipeline }) {
  const location = outputLocation(o, pipeline);
  const [info, setInfo] = useState<{ enabled: boolean; storage: { name: string }; format_version: number; cse: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    iceberg.resolveStorage(location.id).then(
      (r) => live && setInfo(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [location.id]);
  if (error) return <p className="text-xs text-bad">{error}</p>;
  if (!info) return <p className="text-xs text-muted">Checking Iceberg storage…</p>;
  return info.enabled ? (
    <div className="space-y-1 text-xs text-muted">
      <p>
        Writes the Iceberg table <span className="text-soft">{o.name.trim() || "output"}</span> in {location.name}: a snapshot deploy replaces its rows in one
        overwrite snapshot, Always append adds an append snapshot.
      </p>
      <p>
        Storage: <span className="text-soft">{info.storage.name}</span> · format v{info.format_version}
        {info.cse ? " · client-side encryption" : ""}
      </p>
    </div>
  ) : (
    <p className="text-xs text-warn">Iceberg tables are not enabled for this Project. An administrator can enable them in Control Panel → Iceberg table settings.</p>
  );
}

function VirtualTableConfig({ o, onChange }: { o: Output; onChange: (patch: Partial<Output>) => void }) {
  const [conns, setConns] = useState<{ id: string; name: string; kind: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.dataSources
      .connections()
      .then((c) => setConns(c.map((x) => ({ id: x.id, name: x.name, kind: x.kind }))))
      .catch((e: Error) => setError(e.message));
  }, []);
  const v = o.virtualTable ?? { connectionId: "", database: "", schema: "", table: "" };
  const set = (patch: Partial<typeof v>) => onChange({ virtualTable: { ...v, ...patch } });
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Writes the output as a table in an external database. Branches do not support virtual table outputs, and a pipeline needs at least one dataset output unless it
        is an external pipeline.
      </p>
      {error && <p className="text-xs text-bad">{error}</p>}
      <Row label="Source">
        <select
          value={v.connectionId}
          onChange={(e) => {
            const c = conns?.find((x) => x.id === e.target.value);
            set({ connectionId: e.target.value, connectionName: c?.name });
          }}
          className={`${inputClass} py-1 text-xs`}
        >
          <option value="">{conns === null ? "Loading…" : conns.length ? "Choose a connection…" : "No connections — add one in Data Sources"}</option>
          {conns?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.kind})
            </option>
          ))}
        </select>
      </Row>
      <Row label="Database">
        <input value={v.database} onChange={(e) => set({ database: e.target.value })} placeholder="default database" className={`${inputClass} py-1 text-xs`} />
      </Row>
      <Row label="Schema">
        <input value={v.schema} onChange={(e) => set({ schema: e.target.value })} placeholder="public" className={`${inputClass} py-1 text-xs`} />
      </Row>
      <Row label="Table">
        <input value={v.table} onChange={(e) => set({ table: e.target.value })} className={`${inputClass} py-1 text-xs`} />
      </Row>
    </div>
  );
}

const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toLowerCase());
const title = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export /** Pipeline Builder's output write modes; the keyed ones (datasets only) ask for a primary key. */
function WriteModeConfig({ o, columns, onChange }: { o: Output; columns: Column[]; onChange: (patch: Partial<Output>) => void }) {
  const mode = writeModeOf(o);
  const dataset = (o.kind ?? "dataset") === "dataset" || o.kind === "icebergTable";
  const spec = WRITE_MODES.find((m) => m.id === mode)!;
  const booleans = columns.filter((c) => c.type === "Boolean");
  const problems = writeModeProblems(o, columns);
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted">How each deploy writes this output: as a SNAPSHOT transaction (replacing the data) or an APPEND (adding to it).</p>
      <div className="space-y-0.5">
        {WRITE_MODES.filter((m) => dataset || !m.keyed).map((m) => (
          <label key={m.id} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-panel-2">
            <input type="radio" name={`mode-${o.id}`} checked={mode === m.id} onChange={() => onChange({ writeMode: m.id })} className="mt-0.5 accent-[var(--color-ocean)]" />
            <span>
              <span className="block font-medium">{m.label}</span>
              {mode === m.id && <span className="block text-muted">{m.hint}</span>}
            </span>
          </label>
        ))}
      </div>
      {spec.keyed && (
        <div className="space-y-2 rounded-md border border-line-2 p-2">
          <div>
            <div className="mb-1 font-medium text-soft">Primary key</div>
            <ColumnMultiSelect value={o.primaryKey ?? []} columns={columns} onChange={(primaryKey) => onChange({ primaryKey })} placeholder="Primary key columns…" />
          </div>
          {mode === "snapshotReplaceRemove" && (
            <label className="block">
              <span className="mb-1 block font-medium text-soft">Post-filtering column</span>
              <select value={o.postFilterColumn ?? ""} onChange={(e) => onChange({ postFilterColumn: e.target.value || undefined })} className={`${inputClass} text-xs`}>
                <option value="">Choose a Boolean column…</option>
                {booleans.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className="mt-0.5 block text-muted">TRUE rows are stored; a FALSE row removes its primary key from the output.</span>
            </label>
          )}
          {mode === "directChangelog" && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block font-medium text-soft">Timestamp column</span>
                <select value={o.changelog?.timestamp ?? ""} onChange={(e) => onChange({ changelog: { timestamp: e.target.value, deleted: o.changelog?.deleted ?? "" } })} className={`${inputClass} text-xs`}>
                  <option value="">Choose…</option>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block font-medium text-soft">Deletion column</span>
                <select value={o.changelog?.deleted ?? ""} onChange={(e) => onChange({ changelog: { timestamp: o.changelog?.timestamp ?? "", deleted: e.target.value } })} className={`${inputClass} text-xs`}>
                  <option value="">Choose a Boolean column…</option>
                  {booleans.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {mode === "changelog" && <p className="text-muted">Adds the columns _changelog_timestamp (the build time) and _is_deleted to the output.</p>}
        </div>
      )}
      {problems.map((x) => (
        <p key={x} className="flex items-start gap-1.5 text-warn">
          <Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0" /> {x.replace(`${o.name}: `, "")}
        </p>
      ))}
    </div>
  );
}

/** Output expectations and input pre-conditions: each aborts the build when it fails, or only warns. */
export function ExpectationsEditor({
  exps,
  results,
  columns,
  onChange,
  emptyText = "No checks. If any expectation fails, the build fails and nothing is written.",
}: {
  exps: Expectation[];
  results: { id: string; ok: boolean; message: string }[];
  columns: Column[];
  onChange: (e: Expectation[]) => void;
  emptyText?: string;
}) {
  const add = (kind: Expectation["kind"]) => {
    const id = uid();
    const e: Expectation =
      kind === "rowCount"
        ? { id, kind, min: 1 }
        : kind === "oneOf"
          ? { id, kind, column: "", values: [] }
          : kind === "rowLevel"
            ? { id, kind, condition: JSON.stringify(newGroup()) }
            : { id, kind, columns: [] };
    onChange([...exps, e]);
  };
  return (
    <div className="space-y-2">
      {exps.length === 0 && <p className="text-xs text-muted">{emptyText}</p>}
      {exps.map((e) => {
        const res = results.find((x) => x.id === e.id);
        const patch = (next: Expectation) => onChange(exps.map((x) => (x.id === e.id ? next : x)));
        return (
          <div key={e.id} className="rounded-md border border-line-2 p-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium">{expectationLabel(e)}</span>
              <select
                value={e.mode ?? "abort"}
                onChange={(ev) => patch({ ...e, mode: ev.target.value === "warn" ? "warn" : undefined })}
                title="What a failing check does on a build"
                className={`ml-auto rounded border border-line-2 bg-ink px-1 py-0.5 text-[11px] ${e.mode === "warn" ? "text-warn" : "text-soft"}`}
              >
                <option value="abort">Abort build</option>
                <option value="warn">Warn only</option>
              </select>
              <button type="button" onClick={() => onChange(exps.filter((x) => x.id !== e.id))} className="rounded p-0.5 text-muted hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-1.5">
              {e.kind === "rowCount" ? (
                <div className="flex items-center gap-2">
                  min
                  <input
                    type="number"
                    min={0}
                    value={e.min ?? ""}
                    placeholder="none"
                    onChange={(ev) => patch({ ...e, min: ev.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(ev.target.value))) })}
                    className={`${inputClass} w-24 py-1 text-xs`}
                  />
                  max
                  <input
                    type="number"
                    min={0}
                    value={e.max ?? ""}
                    placeholder="none"
                    onChange={(ev) => patch({ ...e, max: ev.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(ev.target.value))) })}
                    className={`${inputClass} w-24 py-1 text-xs`}
                  />
                </div>
              ) : e.kind === "oneOf" ? (
                <div className="space-y-1">
                  <ColumnSelect value={e.column} columns={columns} onChange={(v) => patch({ ...e, column: v })} />
                  <input
                    value={e.values.join(", ")}
                    onChange={(ev) => patch({ ...e, values: ev.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                    placeholder="Permitted values, comma separated (ACTIVE, INACTIVE, PENDING)"
                    className={`${inputClass} py-1 text-xs`}
                  />
                </div>
              ) : e.kind === "rowLevel" ? (
                <RowLevel condition={e.condition} columns={columns} onChange={(condition) => patch({ ...e, condition })} />
              ) : (
                <ColumnMultiSelect
                  value={e.columns}
                  columns={e.kind === "notNaN" ? columns.filter((c) => ["Float", "Double", "Decimal"].includes(c.type)) : columns}
                  onChange={(cols) => patch({ ...e, columns: cols })}
                  placeholder="Columns…"
                />
              )}
            </div>
            {res && (
              <p className={`mt-1.5 flex items-start gap-1 ${res.ok ? "text-ok" : e.mode === "warn" ? "text-warn" : "text-bad"}`}>
                <Icon name={res.ok ? "check" : "alert"} className="mt-0.5 h-3 w-3 shrink-0" /> {res.message}
              </p>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1.5">
        {EXPECTATION_KINDS.map((k) => (
          <button key={k.kind} type="button" title={k.hint} onClick={() => add(k.kind)} className={`${buttonClass.secondary} px-2 py-1 text-xs`}>
            <Icon name="plus" className="h-3 w-3" /> {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RowLevel({ condition, columns, onChange }: { condition: string; columns: Column[]; onChange: (c: string) => void }) {
  const g = readFilter({ filter: condition });
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-muted">
        Every row matches <MatchSelect group={g} onChange={(x) => onChange(JSON.stringify(x))} />
      </div>
      <GroupBody group={g} depth={0} columns={columns} onChange={(x) => onChange(JSON.stringify(x))} />
    </div>
  );
}

function Collapsible({ title, icon, open, onToggle, children }: { title: string; icon: IconName; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line-2">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-medium hover:bg-panel-2">
        <Icon name={icon} className="h-3.5 w-3.5 text-ocean" />
        {title}
        <Icon name={open ? "down" : "right"} className="ml-auto h-3.5 w-3.5 text-muted" />
      </button>
      {open && <div className="border-t border-line-2 p-2.5">{children}</div>}
    </div>
  );
}
