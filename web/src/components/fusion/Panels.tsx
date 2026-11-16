"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { fusion, type ConditionalRule, type DatasetIndex, type DocumentLookups, type FusionView, type IndexedDataset, type IndexStatus, type Sheet, type Snapshot } from "@/lib/fusion";
import { ontology, type ObjectType } from "@/lib/ontology";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Props = {
  kind: "data" | "sources" | "history" | "conditional" | "indexes";
  view: FusionView;
  sheet: Sheet;
  target: string;
  onClose: () => void;
  onInsert: (formula: string) => void;
  onView: (v: FusionView) => void;
  run: (fn: () => Promise<FusionView>) => Promise<FusionView | null>;
};

export function FusionPanel(p: Props) {
  return (
    <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-panel p-4 text-sm">
      <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
        <Icon name={p.kind === "data" ? "database" : p.kind === "sources" ? "link" : p.kind === "conditional" ? "palette" : p.kind === "indexes" ? "bolt" : "history"} className="h-4 w-4 text-ocean" />
        <span className="font-semibold">{p.kind === "data" ? "Find and use data" : p.kind === "sources" ? "Sources" : p.kind === "conditional" ? "Conditional formatting" : p.kind === "indexes" ? "Indexed datasets" : "Edit history"}</span>
        <button type="button" onClick={p.onClose} className="ml-auto rounded p-1 text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      {p.kind === "data" && <DataPanel {...p} />}
      {p.kind === "sources" && <SourcesPanel {...p} />}
      {p.kind === "history" && <HistoryPanel {...p} />}
      {p.kind === "conditional" && <ConditionalPanel {...p} />}
      {p.kind === "indexes" && <IndexesPanel {...p} />}
    </aside>
  );
}

const RULE_OPS: [ConditionalRule["op"], string][] = [
  ["gt", "greater than"],
  ["gte", "at least"],
  ["lt", "less than"],
  ["lte", "at most"],
  ["eq", "equal to"],
  ["neq", "not equal to"],
  ["between", "between"],
  ["contains", "text contains"],
  ["empty", "is empty"],
  ["not_empty", "is not empty"],
  ["scale", "color scale"],
];

function ConditionalPanel({ view, sheet, target, onView, run }: Props) {
  const [rules, setRules] = useState<ConditionalRule[]>(sheet.conditional ?? []);
  const [busy, setBusy] = useState(false);
  const field = `${inputClass} py-1 text-xs`;
  const set = (i: number, p: Partial<ConditionalRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted">Rules apply to computed values, so cells restyle as lookups change. Later rules win.</p>
      {rules.map((r, i) => (
        <div key={r.id ?? i} className="space-y-1 rounded border border-line p-2">
          <div className="flex gap-1">
            <input value={r.range} onChange={(e) => set(i, { range: e.target.value.toUpperCase() })} placeholder="A1:C20" className={`${field} w-24 font-mono`} aria-label="Range" />
            <select value={r.op} onChange={(e) => set(i, { op: e.target.value as ConditionalRule["op"] })} className={field}>
              {RULE_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove rule"><Icon name="x" className="h-3.5 w-3.5" /></button>
          </div>
          {!["empty", "not_empty", "scale"].includes(r.op) && (
            <div className="flex gap-1">
              <input value={r.value ?? ""} onChange={(e) => set(i, { value: e.target.value })} placeholder="value" className={field} />
              {r.op === "between" && <input value={r.value2 ?? ""} onChange={(e) => set(i, { value2: e.target.value })} placeholder="and" className={field} />}
            </div>
          )}
          {r.op === "scale" ? (
            <div className="flex items-center gap-2">
              lowest <input type="color" value={r.min_color ?? "#ffffff"} onChange={(e) => set(i, { min_color: e.target.value })} />
              highest <input type="color" value={r.max_color ?? "#16a34a"} onChange={(e) => set(i, { max_color: e.target.value })} />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              fill <input type="color" value={r.fill ?? "#fef08a"} onChange={(e) => set(i, { fill: e.target.value })} />
              text <input type="color" value={r.color ?? "#111827"} onChange={(e) => set(i, { color: e.target.value })} />
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!r.bold} onChange={(e) => set(i, { bold: e.target.checked })} />bold</label>
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" onClick={() => setRules([...rules, { range: `${target}:${target}`, op: "gt", value: "0", fill: "#fef08a" }])} className={buttonClass.ghost}>+ Rule</button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass.primary}
          onClick={async () => {
            setBusy(true);
            const v = await run(() => fusion.conditional(view.item.id, sheet.id, rules));
            if (v) {
              onView(v);
              setRules(v.document.sheets.find((s) => s.id === sheet.id)?.conditional ?? []);
            }
            setBusy(false);
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function DataPanel({ target, onInsert }: Props) {
  const [tab, setTab] = useState<"datasets" | "objects">("datasets");
  const [datasets, setDatasets] = useState<IndexedDataset[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [query, setQuery] = useState("");
  const [ds, setDs] = useState<IndexedDataset | null>(null);
  const [cols, setCols] = useState<string[]>([]);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [col, setCol] = useState("");
  const [fcol, setFcol] = useState("");
  const [fcell, setFcell] = useState("");
  const [ot, setOt] = useState<ObjectType | null>(null);
  const [prop, setProp] = useState("");
  useEffect(() => {
    fusion.datasets().then(setDatasets, () => setDatasets([]));
    ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, []);
  const pick = async (d: IndexedDataset) => {
    setDs(d);
    const pv = await fusion.preview(d.id).catch(() => null);
    setCols(pv?.columns.map((c) => c.name) ?? []);
    setPreview(pv?.rows.slice(0, 5) ?? []);
    setCol(pv?.columns[0]?.name ?? "");
    setFcol("");
  };
  const name = ds ? ds.name.replace(/\.parquet$/i, "") : "";
  const filter = fcol && fcell ? `, ${q(fcol)}, ${fcell.toUpperCase()}` : "";
  const needle = query.toLowerCase();
  return (
    <div className="space-y-3">
      <div className="flex border-b border-line text-xs">
        {(["datasets", "objects"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-1.5 ${tab === t ? "border-ocean text-ocean" : "border-transparent text-muted"}`}>
            {t === "datasets" ? "Datasets" : "Objects"}
          </button>
        ))}
      </div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className={inputClass} />
      <p className="text-[11px] text-muted">Inserts into {target}. Lookups return at most 2,000 values; filter values can be cell references.</p>
      {tab === "datasets" &&
        (!ds ? (
          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            {datasets
              .filter((d) => !needle || d.name.toLowerCase().includes(needle))
              .map((d) => (
                <button key={d.id} type="button" onClick={() => pick(d)} className="block w-full rounded border border-line px-2 py-1.5 text-left text-xs hover:bg-panel-2">
                  <span className="block truncate text-soft">{d.name}</span>
                  <span className="block truncate text-[10px] text-muted">{d.path.join(" / ")}</span>
                </button>
              ))}
            {datasets.length === 0 && <p className="text-xs text-muted">No Parquet datasets in Files.</p>}
          </div>
        ) : (
          <div className="space-y-2 text-xs">
            <button type="button" onClick={() => setDs(null)} className="text-ocean hover:underline">
              ← {ds.name}
            </button>
            {preview.length > 0 && (
              <div className="overflow-x-auto rounded border border-line">
                <table className="text-[10px]">
                  <thead>
                    <tr>
                      {cols.map((c) => (
                        <th key={c} className="px-1.5 py-1 text-left text-muted">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        {cols.map((c) => (
                          <td key={c} className="px-1.5 py-0.5">
                            {String(r[c] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <label className="block text-muted">
              Column
              <select value={col} onChange={(e) => setCol(e.target.value)} className={inputClass}>
                {cols.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <label className="block flex-1 text-muted">
                Filter column
                <select value={fcol} onChange={(e) => setFcol(e.target.value)} className={inputClass}>
                  <option value="">None</option>
                  {cols.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="block w-24 text-muted">
                equals cell
                <input value={fcell} onChange={(e) => setFcell(e.target.value)} placeholder="A2" className={inputClass} />
              </label>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => onInsert(`=lookup(${q(name)}, ${q(col)}${filter})`)} className={buttonClass.primary}>
                Insert lookup
              </button>
              <button type="button" onClick={() => onInsert(`=lookup_array(${q(name)}, ${q(col)}${filter})`)} className={buttonClass.secondary}>
                As array
              </button>
              <button type="button" onClick={() => onInsert(`=lookup_dropdown(${q(name)}, ${q(col)}${filter})`)} className={buttonClass.secondary}>
                As dropdown
              </button>
              <button type="button" onClick={() => onInsert(`=sum(lookup_array(${q(name)}, ${q(col)}${filter}))`)} className={buttonClass.secondary}>
                Sum
              </button>
            </div>
          </div>
        ))}
      {tab === "objects" &&
        (!ot ? (
          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            {types
              .filter((t) => !needle || t.display_name.toLowerCase().includes(needle))
              .map((t) => (
                <button key={t.id} type="button" onClick={() => (setOt(t), setProp(t.properties[0]?.api_name ?? ""))} className="block w-full rounded border border-line px-2 py-1.5 text-left text-xs hover:bg-panel-2">
                  <span className="text-soft">{t.display_name}</span> <span className="text-muted">({t.object_count})</span>
                </button>
              ))}
          </div>
        ) : (
          <div className="space-y-2 text-xs">
            <button type="button" onClick={() => setOt(null)} className="text-ocean hover:underline">
              ← {ot.display_name}
            </button>
            <label className="block text-muted">
              Property
              <select value={prop} onChange={(e) => setProp(e.target.value)} className={inputClass}>
                {ot.properties.map((pp) => (
                  <option key={pp.api_name} value={pp.api_name}>
                    {pp.display_name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <label className="block flex-1 text-muted">
                Filter property
                <select value={fcol} onChange={(e) => setFcol(e.target.value)} className={inputClass}>
                  <option value="">None</option>
                  {ot.properties.map((pp) => (
                    <option key={pp.api_name} value={pp.api_name}>
                      {pp.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block w-24 text-muted">
                equals cell
                <input value={fcell} onChange={(e) => setFcell(e.target.value)} placeholder="B2" className={inputClass} />
              </label>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => onInsert(`=object_lookup(${q(ot.api_name)}, ${q(prop)}${filter})`)} className={buttonClass.primary}>
                Insert property lookup
              </button>
              <button type="button" onClick={() => onInsert(`=object_dropdown(${q(ot.api_name)}${filter})`)} className={buttonClass.secondary}>
                Object dropdown
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

function SourcesPanel({ view, sheet, run }: Props) {
  const tables = view.document.sheets.flatMap((s) => [...(s.sync ? [{ sheet: s.name, t: { id: s.id, name: "whole sheet", sync: s.sync } }] : []), ...s.tables.filter((t) => t.sync).map((t) => ({ sheet: s.name, t }))]);
  const id = view.item.id;
  const manual = view.document.settings.auto_update === false;
  const saveDoc = (auto: boolean) => run(() => fusion.save(id, { ...view.document, settings: { ...view.document.settings, auto_update: auto } }));
  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-1">
        <label className="flex items-center gap-2">
          <input type="radio" checked={!manual} disabled={!view.can_edit} onChange={() => void saveDoc(true)} /> Update automatically
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={manual} disabled={!view.can_edit} onChange={() => void saveDoc(false)} /> Update manually
        </label>
        <p className="text-muted">
          {manual
            ? "Lookups use the data read at the last update; new dataset data waits until you update."
            : "Values are computed from the datasets' current data each time the sheet is opened or edited."}
        </p>
        {manual && view.can_edit && (
          <button type="button" onClick={() => void run(() => fusion.updateSources(id))} className={buttonClass.primary}>
            <Icon name="refresh" className="h-3.5 w-3.5" /> Update sources
          </button>
        )}
      </div>
      <div className="divide-y divide-line rounded border border-line">
        {view.sources.map((s) => (
          <Link key={s.id} href={`/datasets/${s.id}`} className="block p-2 hover:bg-panel-2">
            <span className="block text-ocean">{s.name}</span>
            <span className="text-[10px] text-muted">
              updated {when(s.updated_at)}
              {s.cached_at && ` · read ${when(s.cached_at)}`}
            </span>
          </Link>
        ))}
        {view.sources.length === 0 && <p className="p-2 text-muted">No dataset lookups.</p>}
      </div>
      <div className="font-medium">Synced tables</div>
      <div className="divide-y divide-line rounded border border-line">
        {tables.map(({ sheet, t }) => (
          <div key={t.id} className="p-2">
            <span className="block">
              {sheet} · {t.name}
            </span>
            {t.sync?.dataset_id ? (
              <Link href={`/datasets/${t.sync.dataset_id}`} className="text-[10px] text-ocean hover:underline">
                {t.sync.name} · {t.sync.rows ?? 0} rows · synced {when(t.sync.synced_at ?? "")}
              </Link>
            ) : (
              <span className="text-[10px] text-muted">waiting for the first sync</span>
            )}
          </div>
        ))}
        {tables.length === 0 && <p className="p-2 text-muted">No table regions synced to datasets.</p>}
      </div>
      {view.can_edit && (
        <button
          type="button"
          onClick={async () => {
            if (sheet.sync) {
              await run(() => fusion.syncSheet(id, sheet.id, { enabled: false }));
              return;
            }
            const name = await promptDialog("Dataset name (the sheet's first used row is the header)", sheet.name, { title: `Sync sheet ${sheet.name} to a dataset` });
            if (name) await run(() => fusion.syncSheet(id, sheet.id, { name }));
          }}
          className={buttonClass.ghost}
        >
          <Icon name="database" className="h-3.5 w-3.5" /> {sheet.sync ? `Stop syncing sheet ${sheet.name}` : `Sync sheet ${sheet.name} to a dataset`}
        </button>
      )}
    </div>
  );
}

function HistoryPanel({ view, run }: Props) {
  const id = view.item.id;
  const [rows, setRows] = useState<Snapshot[]>([]);
  const at = view.item.updated_at;
  useEffect(() => {
    fusion.history(id).then(setRows, () => setRows([]));
  }, [id, at]);
  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted">Snapshots are taken automatically while editing (at most every 10 minutes) and when you save a version.</p>
      {view.can_edit && (
        <button
          type="button"
          onClick={async () => {
            const label = await promptDialog("Name this version", "Saved version");
            if (label) {
              await fusion.snapshot(id, label);
              setRows(await fusion.history(id));
            }
          }}
          className={buttonClass.secondary}
        >
          Save a version
        </button>
      )}
      <div className="space-y-2">
        {rows.map((h) => (
          <div key={h.id} className="rounded border border-line bg-panel-2 p-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">{h.label}</span>
              {view.can_edit && (
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirmDialog(`Restore "${h.label}"? The current state is saved as a version first.`)) {
                      await run(() => fusion.restore(id, h.id));
                      setRows(await fusion.history(id));
                    }
                  }}
                  className="text-ocean hover:underline"
                >
                  Restore
                </button>
              )}
            </div>
            <div className="text-[10px] text-muted">
              {h.by} · {when(h.at)} · {h.cells} cells{h.auto ? " · automatic" : ""}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-muted">No snapshots yet.</p>}
      </div>
    </div>
  );
}

const STATUS: Record<IndexStatus, [string, string]> = {
  up_to_date: ["Up-to-date", "border-ok/40 bg-ok/10 text-ok"],
  syncing: ["Syncing", "border-ocean/40 bg-ocean/10 text-ocean"],
  stale: ["Stale", "border-warn/40 bg-warn/10 text-warn"],
  failed: ["Failed", "border-bad/40 bg-bad/10 text-bad"],
  missing: ["Dataset missing", "border-bad/40 bg-bad/10 text-bad"],
};

function StatusBadge({ status }: { status: IndexStatus }) {
  const [label, cls] = STATUS[status] ?? [status, "border-line text-muted"];
  return <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${cls}`}>{label}</span>;
}

const bytes = (n: number | null | undefined) =>
  n == null ? "–" : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Lime indexing (Analytics doc 09, "Index datasets"): the datasets indexed for lookups and their status (Up-to-date,
 * Syncing, Stale), how this document's lookups ran (through an index or by scanning), Index new dataset, Sync, Remove. */
function IndexesPanel({ view, run }: Props) {
  const id = view.item.id;
  const [lookups, setLookups] = useState<DocumentLookups | null>(null);
  const [all, setAll] = useState<DatasetIndex[]>([]);
  const [datasets, setDatasets] = useState<IndexedDataset[]>([]);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [cols, setCols] = useState<string[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const at = view.item.updated_at;
  const syncing = all.some((x) => x.status === "syncing");
  const maxKeys = lookups?.limits.max_keys ?? 8;

  useEffect(() => {
    fusion.lookups(id).then(setLookups, (e: Error) => setErr(e.message));
    fusion.indexes().then(setAll, (e: Error) => setErr(e.message));
  }, [id, at, tick]);
  useEffect(() => {
    if (!syncing) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), 2000);
    return () => window.clearTimeout(t);
  }, [syncing, all]);
  useEffect(() => {
    if (!adding || datasets.length) return;
    fusion.datasets().then(setDatasets, () => setDatasets([]));
  }, [adding, datasets.length]);
  useEffect(() => {
    if (!pick) {
      setCols([]);
      return;
    }
    fusion.preview(pick).then(
      (pv) => setCols(pv.columns.map((c) => c.name)),
      () => setCols([]),
    );
  }, [pick]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await run(() => fusion.get(id)); // the lookups run again: through the index once it is up to date
      setTick((n) => n + 1);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const create = (datasetId: string, k: string[]) => act(`create:${datasetId}`, () => fusion.createIndex(datasetId, k.slice(0, maxKeys)));
  const toggleKey = (c: string) => setKeys((k) => (k.includes(c) ? k.filter((x) => x !== c) : k.length < maxKeys ? [...k, c] : k));

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted">
        An index answers a lookup&apos;s filters on its key columns without reading the whole dataset, with the same results as a scan. It is built
        from one version of the dataset: a newer version makes it stale until it is synced again, which the next lookup starts by itself.
      </p>
      {err && <p className="rounded border border-bad/40 bg-bad/10 p-2 text-bad">{err}</p>}

      <div className="font-medium">This document&apos;s lookups</div>
      {lookups?.manual && <p className="text-muted">Update manually is on: lookups read the data kept at the last update, not the indexes.</p>}
      <div className="divide-y divide-line rounded border border-line">
        {(lookups?.datasets ?? []).map((d) => {
          const lk = d.lookup;
          const suggested = (lk?.filter_columns ?? []).filter((c) => d.columns.includes(c)).slice(0, maxKeys);
          return (
            <div key={d.id} className="space-y-1 p-2">
              <div className="flex items-center gap-2">
                <Link href={`/datasets/${d.id}`} className="min-w-0 flex-1 truncate text-ocean hover:underline">
                  {d.name}
                </Link>
                {d.index ? <StatusBadge status={d.index.status} /> : <span className="text-[10px] text-muted">not indexed</span>}
              </div>
              {lk && lk.count > 0 && (
                <div className="text-[10px] text-muted">
                  {lk.count} lookup{lk.count === 1 ? "" : "s"}: {lk.indexed} through the index, {lk.scanned} scanned · {lk.ms} ms
                  {lk.filter_columns.length > 0 && ` · filters on ${lk.filter_columns.join(", ")}`}
                  {lk.scanned > 0 && lk.scan_reason && <span className="block">scanned: {lk.scan_reason}</span>}
                </div>
              )}
              {!d.index && view.can_edit && !d.pinned && (
                <button
                  type="button"
                  disabled={busy !== null || suggested.length === 0}
                  onClick={() => void create(d.id, suggested)}
                  className="text-ocean hover:underline disabled:opacity-50"
                  title={suggested.length ? undefined : "No lookup filters on this dataset yet"}
                >
                  {busy === `create:${d.id}` ? "Indexing…" : `Index on ${suggested.join(", ") || "its filter columns"}`}
                </button>
              )}
            </div>
          );
        })}
        {lookups && lookups.datasets.length === 0 && <p className="p-2 text-muted">No dataset lookups in this document.</p>}
        {!lookups && !err && <p className="p-2 text-muted">Loading…</p>}
      </div>

      <div className="flex items-center gap-2">
        <span className="font-medium">Indexed datasets</span>
        <button type="button" onClick={() => setTick((n) => n + 1)} className="ml-auto rounded p-1 text-muted hover:text-white" aria-label="Refresh" title="Refresh">
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="divide-y divide-line rounded border border-line">
        {all.map((x) => (
          <div key={x.dataset_id} className="space-y-1 p-2">
            <div className="flex items-center gap-2">
              <Link href={`/datasets/${x.dataset_id}`} className="min-w-0 flex-1 truncate text-ocean hover:underline" title={x.path.join(" / ")}>
                {x.name}
              </Link>
              <StatusBadge status={x.status} />
            </div>
            <div className="text-[10px] text-muted">
              keys {(x.built_keys ?? x.keys ?? []).join(", ")}
              {x.rows != null && ` · ${x.rows.toLocaleString()} rows`}
              {x.size_bytes != null && ` · ${bytes(x.size_bytes)}`}
              {x.built_at && ` · built ${when(x.built_at)}${x.build_ms != null ? ` in ${(x.build_ms / 1000).toFixed(1)} s` : ""}`}
              {x.dataset_rows != null && x.rows != null && x.dataset_rows > x.rows && ` · first ${x.rows.toLocaleString()} of ${x.dataset_rows.toLocaleString()} rows`}
            </div>
            {x.progress && (
              <div className="text-[10px] text-ocean">
                building: {x.progress.rows.toLocaleString()}
                {x.progress.total ? ` of ${x.progress.total.toLocaleString()}` : ""} rows
              </div>
            )}
            {x.unheld_columns.length > 0 && <div className="text-[10px] text-muted">lookups reading {x.unheld_columns.join(", ")} scan the dataset</div>}
            {x.error && <div className="text-[10px] text-bad">{x.error}</div>}
            {view.can_edit && (
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={busy !== null || x.status === "syncing" || x.status === "missing"}
                  onClick={() => void act(`sync:${x.dataset_id}`, () => fusion.rebuildIndex(x.dataset_id))}
                  className="text-ocean hover:underline disabled:opacity-50"
                >
                  {busy === `sync:${x.dataset_id}` ? "Syncing…" : "Sync"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null || x.status === "syncing"}
                  onClick={async () => {
                    if (await confirmDialog(`Remove the index of "${x.name}"? Lookups on it scan the dataset again; the dataset is not changed.`))
                      await act(`rm:${x.dataset_id}`, () => fusion.removeIndex(x.dataset_id));
                  }}
                  className="text-bad hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}
        {all.length === 0 && <p className="p-2 text-muted">No datasets are indexed.</p>}
      </div>
      {lookups && (
        <p className="text-[10px] text-muted">
          {lookups.limits.indexes} of {lookups.limits.max_indexes} indexes · {bytes(lookups.limits.total_bytes)} of {bytes(lookups.limits.max_total_bytes)} ·
          at most {lookups.limits.max_keys} key columns and the first {lookups.limits.max_rows.toLocaleString()} rows of a dataset
        </p>
      )}

      {view.can_edit &&
        (!adding ? (
          <button type="button" onClick={() => setAdding(true)} className={buttonClass.secondary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Index new dataset
          </button>
        ) : (
          <div className="space-y-2 rounded border border-line p-2">
            <label className="block text-muted">
              Dataset
              <select
                value={pick}
                onChange={(e) => {
                  setPick(e.target.value);
                  setKeys([]);
                }}
                className={inputClass}
              >
                <option value="">Choose a Parquet dataset…</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {all.some((x) => x.dataset_id === d.id) ? " (indexed)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {cols.length > 0 && (
              <div>
                <div className="mb-1 text-muted">Key columns: the columns lookups filter on (at most {maxKeys})</div>
                <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                  {cols.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleKey(c)}
                      className={`rounded border px-1.5 py-0.5 ${keys.includes(c) ? "border-ocean bg-ocean/15 text-ocean" : "border-line text-soft hover:bg-panel-2"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={!pick || keys.length === 0 || busy !== null}
                onClick={async () => {
                  if (await create(pick, keys)) {
                    setAdding(false);
                    setPick("");
                    setKeys([]);
                  }
                }}
                className={buttonClass.primary}
              >
                {busy?.startsWith("create:") ? "Indexing…" : "Index"}
              </button>
              <button type="button" onClick={() => setAdding(false)} className={buttonClass.ghost}>
                Cancel
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
