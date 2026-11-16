"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { zipSync, strToU8 } from "fflate";
import { ActionForm } from "@/components/ontology/ActionForm";
import { VegaView } from "@/components/quiver/TableCards";
import { Icon } from "@/components/Icon";
import { insightApi, type InsightDocument, type InsightFilterStep, type InsightLayout, type InsightLinkStep, type InsightPath, type InsightWorkbook, type ObjectList, type Scenario } from "@/lib/insight";
import { ontology, platformBranch, setOntologyScenario, setPlatformBranch, type ActionType, type ObjectType, type OntologyObject, type Property } from "@/lib/ontology";
import { exportCsv, om, type FilterOp, type Histogram, type Interface, type LinkType, type SearchResult, type SearchSpec } from "@/lib/ontologyModel";
import { useSqlEngine } from "@/lib/useSqlEngine";
import { capture } from "@/lib/drillCapture";
import type { Cell, ColType, Table } from "@/lib/pipeline";
import { allowExport } from "@/lib/checkpoints";

const OPS: { value: FilterOp; label: string }[] = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "is_null", label: "is empty" },
  { value: "not_null", label: "has a value" },
  { value: "any_word", label: "contains any word from" },
  { value: "phrase", label: "contains phrase" },
  { value: "within", label: "matches terms within" },
];
type WithinSpec = { terms: string[]; gap: number; ordered?: boolean; negate?: boolean };
type LinkSpec = { link_type_id: string; direction: "forward" | "reverse"; filters: { property: string; op: FilterOp; value?: unknown }[]; negate?: boolean };
const PAGE_SIZE = 50;
const id = () => globalThis.crypto?.randomUUID?.() ?? `ins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const countLabel = (n: number | null | undefined) => typeof n === "number" ? `${n.toLocaleString()} objects` : "— objects";
const str = (v: unknown) => v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
const valueCell = (v: unknown) => v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.map(str).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
const freshFilter = (props: Property[]): InsightFilterStep => ({ id: id(), property: props[0]?.api_name ?? "__title", op: "eq", value: "", enabled: true });
const freshPath = (kind: "object_type" | "interface", sourceId: string, label: string): InsightPath => ({
  id: id(), name: label || "Path 1", source_kind: kind, source_id: sourceId, query: "", filters: [], links: [], transform: null,
});

/** What referenced object sets and static lists resolve to (their specs; the lists' keys). */
type Refs = { sets: Record<string, SearchSpec>; lists: Record<string, { object_type_id: string; primary_keys: string[] }>; pk: (typeId: string) => string };

function searchSpec(path: InsightPath | null, refs: Refs): SearchSpec | null {
  if (!path) return null;
  const own = path.filters.filter((f) => f.enabled).map(({ property, op, value }) => ({ property, op, value }));
  let base: { object_type_id?: string; interface_id?: string; q: string; filters: NonNullable<SearchSpec["filters"]>; search_around: NonNullable<SearchSpec["search_around"]> };
  if (path.source_kind === "object_set") {
    // a reference: the published object set's definition, read-only, then this path's own steps
    const set = refs.sets[path.source_id];
    if (!set) return null;
    base = { object_type_id: set.object_type_id ?? undefined, interface_id: set.interface_id ?? undefined, q: [set.q, path.query].filter(Boolean).join(" "), filters: [...(set.filters ?? [])], search_around: (set.search_around ?? []).map((l) => ({ ...l, filters: [...(l.filters ?? [])] })) };
  } else if (path.source_kind === "list") {
    const list = refs.lists[path.source_id];
    if (!list) return null;
    base = { object_type_id: list.object_type_id, q: path.query, filters: [{ property: refs.pk(list.object_type_id), op: "in", value: list.primary_keys }], search_around: [] };
  } else {
    base = { object_type_id: path.source_kind === "object_type" ? path.source_id : undefined, interface_id: path.source_kind === "interface" ? path.source_id : undefined, q: path.query, filters: [], search_around: [] };
  }
  // the path's filters narrow its starting data: after a referenced set that searches around, they apply to its result
  const last = base.search_around[base.search_around.length - 1];
  if (last) last.filters = [...(last.filters ?? []), ...own];
  else base.filters = [...base.filters, ...own];
  return {
    object_type_id: base.object_type_id,
    interface_id: base.interface_id,
    q: base.q,
    filters: base.filters,
    search_around: [...base.search_around, ...path.links.filter((l) => l.enabled).map((l) => ({
      link_type_id: l.link_type_id,
      direction: l.direction,
      filters: l.filters.filter((f) => f.enabled).map(({ property, op, value }) => ({ property, op, value })),
    }))],
    aggregate: path.transform?.enabled && !path.transform.set_math ? {
      metric: path.transform.metric,
      property: path.transform.property,
      group_by: path.transform.group_by,
    } : null,
    offset: 0,
    limit: 1000,
    histograms: true,
    resource: "insight",
  };
}

function combineSets(left: SearchResult, right: SearchResult, operation: "union" | "intersect" | "subtract"): SearchResult {
  if (left.result_type.id !== right.result_type.id) throw new Error("Set Math requires both paths to end at the same object type.");
  const key = (o: SearchResult["objects"][number]) => `${o.object_type_id}:${o.primary_key}`;
  const rightKeys = new Set(right.objects.map(key));
  const leftKeys = new Set(left.objects.map(key));
  const merged = operation === "union"
    ? [...left.objects, ...right.objects.filter((o) => !leftKeys.has(key(o)))]
    : operation === "intersect"
      ? left.objects.filter((o) => rightKeys.has(key(o)))
      : left.objects.filter((o) => !rightKeys.has(key(o)));
  return {
    ...left,
    total: merged.length,
    objects: merged.slice(0, 1000),
    path: [],
    histograms: [],
    aggregation: null,
    compute_seconds: left.compute_seconds + right.compute_seconds,
    query_types: [...new Set([...left.query_types, ...right.query_types, "set_math"])],
    execution: left.execution === "distributed" || right.execution === "distributed" ? "distributed" : "in_memory",
  };
}

function nextTypeId(path: InsightPath, links: LinkType[], throughIndex = path.links.length - 1): string | null {
  if (path.source_kind === "interface") return null;
  let current = path.source_kind === "object_type" ? path.source_id : path.start_type_id ?? null;
  if (!current) return null;
  for (let i = 0; i <= throughIndex && i < path.links.length; i++) {
    const step = path.links[i];
    if (!step.enabled) continue;
    const link = links.find((l) => l.id === step.link_type_id);
    if (!link) continue;
    if (step.direction === "forward") {
      if (link.source.object_type_id !== current) return null;
      current = link.target.object_type_id;
    } else {
      if (link.target.object_type_id !== current) return null;
      current = link.source.object_type_id;
    }
  }
  return current;
}

function directions(link: LinkType, current: string): ("forward" | "reverse")[] {
  return [
    ...(link.source.object_type_id === current ? ["forward" as const] : []),
    ...(link.target.object_type_id === current ? ["reverse" as const] : []),
  ];
}

function geoPoint(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const a = Number(value[0]); const b = Number(value[1]);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? [a, b] : null;
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const lat = Number(v.lat ?? v.latitude); const lon = Number(v.lon ?? v.lng ?? v.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
  }
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(value ?? ""));
  if (!m) return null;
  const lat = Number(m[1]); const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

function histogramRows(h: Histogram): { label: string; count: number }[] {
  return h.kind === "numeric"
    ? h.buckets.map((b) => ({ label: `${b.from.toLocaleString(undefined, { maximumFractionDigits: 2 })} – ${b.to.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, count: b.count }))
    : h.buckets.map((b) => ({ label: b.value || "—", count: b.count }));
}

function ChartCard({ title, metric, rows, selected, onToggle, onClear }: { title: string; metric?: string; rows: { label: string; count: number }[]; selected?: string[]; onToggle?: (label: string) => void; onClear?: () => void }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="flex min-h-64 flex-col overflow-hidden rounded border border-line bg-panel shadow-sm">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2 text-[13px] font-semibold text-soft">
        <span className="truncate">{title}</span>
        {metric && <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-normal text-muted">{metric}</span>}
        {onToggle && <span className="ml-auto text-[10px] font-normal text-muted">{selected?.length ? `Filtering on ${selected.length} row${selected.length === 1 ? "" : "s"}` : "Select a row to filter results"}</span>}
        {onClear && !!selected?.length && <button type="button" onClick={onClear} className="text-muted hover:text-white" aria-label="Clear the selection"><Icon name="x" className="h-3 w-3" /></button>}
      </header>
      <div className="flex-1 space-y-2 overflow-auto p-3">
        {rows.slice(0, 18).map((r, i) => (
          <div key={`${r.label}-${i}`} onClick={onToggle ? () => onToggle(r.label) : undefined} className={`grid grid-cols-[minmax(75px,1fr)_minmax(40px,2fr)_40px] items-center gap-2 rounded text-[11px] ${onToggle ? "cursor-pointer hover:bg-panel-2" : ""} ${selected?.includes(r.label) ? "bg-ocean/15 ring-1 ring-ocean/50" : ""}`}>
            <span className="truncate text-soft" title={r.label}>{r.label}</span>
            <span className="h-3 overflow-hidden rounded-sm bg-panel-2"><span className="block h-full rounded-sm bg-blue-600" style={{ width: `${Math.max(1, r.count / max * 100)}%` }} /></span>
            <span className="text-right tabular-nums text-muted">{r.count.toLocaleString()}</span>
          </div>
        ))}
        {!rows.length && <p className="text-xs text-muted">No values to chart.</p>}
      </div>
    </section>
  );
}

function MapPreview({ result, visible }: { result: SearchResult; visible: boolean }) {
  const candidates = result.result_type.properties.filter((p) => p.type === "geopoint" && p.visibility !== "hidden");
  const [property, setProperty] = useState(candidates[0]?.api_name ?? "");
  const activeProperty = candidates.some((p) => p.api_name === property) ? property : candidates[0]?.api_name ?? "";
  const points = result.objects.map((o) => ({ key: o.primary_key, title: o.title, point: geoPoint(o.properties[activeProperty]) })).filter((p): p is { key: string; title: string; point: [number, number] } => p.point !== null);
  const bounds = points.reduce((b, p) => ({ minLat: Math.min(b.minLat, p.point[0]), maxLat: Math.max(b.maxLat, p.point[0]), minLon: Math.min(b.minLon, p.point[1]), maxLon: Math.max(b.maxLon, p.point[1]) }), { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 });
  const latSpan = Math.max(0.02, bounds.maxLat - bounds.minLat); const lonSpan = Math.max(0.02, bounds.maxLon - bounds.minLon);
  if (!visible) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs">
        <span className="font-medium text-soft">Geographic points</span>
        {candidates.length > 1 && <select value={activeProperty} onChange={(e) => setProperty(e.target.value)} className="rounded border border-line-2 bg-panel px-2 py-1">{candidates.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}</select>}
        <span className="text-muted">{points.length.toLocaleString()} mapped from this result page</span>
        {result.objects[0] && <Link href={`/map/new?object_type=${encodeURIComponent(result.result_type.id)}&pk=${encodeURIComponent(result.objects[0].primary_key)}`} className="ml-auto rounded border border-line-2 px-2.5 py-1 hover:bg-panel-2">Open a record in Map</Link>}
      </div>
      {!candidates.length ? <div className="grid flex-1 place-items-center p-8 text-sm text-muted">This object type has no visible geopoint property. Add one in Nexus Manager to map objects.</div> : !points.length ? <div className="grid flex-1 place-items-center p-8 text-sm text-muted">No valid latitude/longitude values in the loaded result rows.</div> : (
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <svg viewBox="0 0 960 540" className="h-full min-h-[320px] w-full rounded border border-line bg-panel-2" role="img" aria-label={`${points.length} geospatial objects`}>
            <rect style={{ fill: "var(--color-panel-2)" }} x="0" y="0" width="960" height="540"  />
            {[1, 2, 3, 4].map((n) => <g key={n}><path style={{ stroke: "var(--color-line)" }} d={`M ${n * 192} 0 V 540`}  strokeWidth="1" /><path style={{ stroke: "var(--color-line)" }} d={`M 0 ${n * 108} H 960`}  strokeWidth="1" /></g>)}
            <path style={{ stroke: "var(--color-line-2)" }} d="M 0 270 H 960 M 480 0 V 540"  strokeDasharray="5 6" />
            {points.map((p) => {
              const x = 24 + (p.point[1] - bounds.minLon) / lonSpan * 912;
              const y = 24 + (bounds.maxLat - p.point[0]) / latSpan * 492;
              return <circle key={p.key} cx={x} cy={y} r="5" fill="#2873ce" fillOpacity=".75" stroke="white" strokeWidth="1.5"><title>{p.title}: {p.point[0].toFixed(5)}, {p.point[1].toFixed(5)}</title></circle>;
            })}
          </svg>
          <p className="mt-2 text-[11px] text-muted">This lightweight preview plots loaded geopoints on a coordinate grid. Use the full Map app for basemaps, layers, and spatial filters.</p>
        </div>
      )}
    </div>
  );
}

function csvValue(v: unknown): string {
  const s = valueCell(v) === "—" ? "" : valueCell(v);
  return `"${s.replace(/"/g, '""')}"`;
}
function xmlEscape(v: unknown): string { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function columnName(n: number): string { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
async function downloadWorkbookXlsx(result: SearchResult, columns: Property[]) {
  if (!(await allowExport({ detail: `Insight results (XLSX, ${result.objects.length} objects)` }))) return;
  const headers = ["Title", "Primary key", ...columns.map((p) => p.display_name || p.api_name)];
  const rows: unknown[][] = [headers, ...result.objects.map((o) => [o.title, o.primary_key, ...columns.map((p) => o.properties[p.api_name])])];
  const sheetRows = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => {
    const ref = `${columnName(ci + 1)}${ri + 1}`;
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" t="n"><v>${v}</v></c>`;
    if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Insight results" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
  };
  const blob = new Blob([zipSync(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "insight-results.xlsx"; a.click(); URL.revokeObjectURL(url);
}

function makeSqlTable(result: SearchResult): Table {
  const props = result.result_type.properties.filter((p) => p.visibility !== "hidden");
  const definitions: { name: string; type: ColType; value: (o: SearchResult["objects"][number]) => unknown }[] = [
    { name: "title", type: "String", value: (o) => o.title },
    { name: "primary_key", type: "String", value: (o) => o.primary_key },
    ...props.map((p) => ({
      name: p.api_name,
      type: ({ boolean: "Boolean", integer: "Integer", long: "Long", short: "Short", byte: "Byte", float: "Float", double: "Double", decimal: "Decimal", date: "Date", timestamp: "Timestamp" } as Record<string, ColType>)[p.type] ?? "String",
      value: (o: SearchResult["objects"][number]) => o.properties[p.api_name],
    })),
  ];
  const names = new Set<string>();
  const columns = definitions.map((d) => {
    let name = d.name; let n = 2;
    while (names.has(name)) name = `${d.name}_${n++}`;
    names.add(name); return { name, type: d.type };
  });
  const rows = result.objects.map((o) => Object.fromEntries(definitions.map((d, i) => {
    const v = d.value(o);
    const cell: Cell = v === null || v === undefined ? null : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v);
    return [columns[i].name, cell];
  })));
  return { columns, rows };
}

function InsightPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workbookId = searchParams.get("workbook");
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [interfaces, setInterfaces] = useState<Interface[]>([]);
  const [linkTypes, setLinkTypes] = useState<LinkType[]>([]);
  const [savedSearches, setSavedSearches] = useState<{ id: string; name: string; spec: SearchSpec }[]>([]);
  const [workbooks, setWorkbooks] = useState<InsightWorkbook[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paths, setPaths] = useState<InsightPath[]>([]);
  const [activePathId, setActivePathId] = useState<string | null>(null);
  const [tab, setTab] = useState<"table" | "charts" | "map" | "sql">("table");
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [chartColumns, setChartColumns] = useState<string[]>([]);
  const [layouts, setLayouts] = useState<InsightLayout[]>([]);
  const [workbook, setWorkbook] = useState<InsightWorkbook | null>(null);
  const [workbookName, setWorkbookName] = useState("New Insight");
  const [description, setDescription] = useState("");
  const [showSources, setShowSources] = useState(false);
  const [sourceKind, setSourceKind] = useState<"object_type" | "interface">("object_type");
  const [sourceSearch, setSourceSearch] = useState("");
  const [showOpenMenu, setShowOpenMenu] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [sharingRole, setSharingRole] = useState<"viewer" | "editor">("viewer");
  const [shareBusy, setShareBusy] = useState(false);
  const [layoutName, setLayoutName] = useState("");
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [columnMenu, setColumnMenu] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [rowAction, setRowAction] = useState<ActionType | null>(null);
  const [rowActionObject, setRowActionObject] = useState<OntologyObject | null>(null);
  const [bulkAction, setBulkAction] = useState<ActionType | null>(null);
  const [createAction, setCreateAction] = useState<ActionType | null>(null);
  const [actionState, setActionState] = useState<{ typeId: string; actions: ActionType[] } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [resultState, setResultState] = useState<{ key: string; data: SearchResult } | null>(null);
  const [resultError, setResultError] = useState<{ key: string; error: string } | null>(null);
  const [saveName, setSaveName] = useState("New Insight");
  const [saveDescription, setSaveDescription] = useState("");
  const [sqlText, setSqlText] = useState("SELECT * FROM Path LIMIT 100");
  const [sqlResult, setSqlResult] = useState<{ columns: { name: string; type: ColType }[]; rows: Record<string, Cell>[] } | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlRun, setSqlRun] = useState(false);
  const [lists, setLists] = useState<ObjectList[]>([]);
  // Group By rows selected in Charts: a temporary filter on the grouped property (the path itself does not change)
  const [groupSel, setGroupSel] = useState<{ path: string; values: string[] } | null>(null);
  const [baseAgg, setBaseAgg] = useState<{ path: string; agg: NonNullable<SearchResult["aggregation"]> } | null>(null);
  const [vegaSpec, setVegaSpec] = useState("");
  const [listKeys, setListKeys] = useState<Record<string, { object_type_id: string; primary_keys: string[] }>>({});
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [listTarget, setListTarget] = useState("");
  // Branch: the session reads and acts on a scenario (main plus its edits); saving resources is not branch-aware
  const scenario = searchParams.get("scenario");
  const onBranch = Boolean(scenario);
  const branchName = scenarios.find((x) => x.id === scenario)?.name || scenario || "";
  const branchOnly = onBranch ? "Not available on a branch" : undefined;
  setOntologyScenario(scenario);
  useEffect(() => () => setOntologyScenario(null), []);
  useEffect(() => {
    insightApi.scenarios().then((x) => setScenarios(x.filter((s) => !s.merged)), () => setScenarios([]));
    insightApi.objectLists().then(setLists, () => setLists([]));
  }, []);
  const sqlRuntime = useSqlEngine(tab === "sql");

  useEffect(() => {
    let alive = true;
    Promise.allSettled([ontology.objectTypes(), om.interfaces(), om.linkTypes(), om.explorations(), insightApi.list()]).then((results) => {
      if (!alive) return;
      const [t, i, l, e, w] = results;
      if (t.status === "fulfilled") setTypes(t.value);
      if (i.status === "fulfilled") setInterfaces(i.value);
      if (l.status === "fulfilled") setLinkTypes(l.value);
      if (e.status === "fulfilled") setSavedSearches(e.value as { id: string; name: string; spec: SearchSpec }[]);
      if (w.status === "fulfilled") setWorkbooks(w.value);
      setReady(true);
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") setError((failed.reason as Error).message);
    });
    return () => { alive = false; };
  }, []);

  const applyDocument = useCallback((doc: InsightDocument) => {
    setPaths(Array.isArray(doc.paths) ? doc.paths : []);
    setActivePathId(doc.active_path_id ?? doc.paths?.[0]?.id ?? null);
    setTab(doc.tab ?? "table");
    setVisibleColumns(doc.visible_columns ?? []);
    setChartColumns(doc.chart_columns ?? []);
    setLayouts(doc.layouts ?? []);
    setSelectedKeys([]);
    setPageIndex(0);
  }, []);

  useEffect(() => {
    if (!workbookId) return;
    let alive = true;
    insightApi.get(workbookId).then((w) => {
      if (!alive) return;
      setWorkbook(w); setWorkbookName(w.name); setDescription(w.description); setSharingEnabled(w.shared); setSharingRole(w.share_role);
      applyDocument(w.spec);
    }).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [workbookId, applyDocument]);

  const activePath = paths.find((p) => p.id === activePathId) ?? null;
  const refs = useMemo<Refs>(() => ({
    sets: Object.fromEntries(savedSearches.map((x) => [x.id, x.spec])),
    lists: listKeys,
    pk: (typeId: string) => types.find((t) => t.id === typeId)?.primary_key ?? "__pk",
  }), [savedSearches, listKeys, types]);
  // the keys of the static lists the paths start from
  useEffect(() => {
    for (const p of paths) {
      if (p.source_kind !== "list" || listKeys[p.source_id]) continue;
      insightApi.objectList(p.source_id).then((l) => setListKeys((cur) => ({ ...cur, [l.id]: { object_type_id: l.object_type_id, primary_keys: l.primary_keys } })), (e: Error) => setError(e.message));
    }
  }, [paths, listKeys]);
  // on a branch the in-progress analysis autosaves in this browser (a workbook cannot be saved there)
  const draftKey = `bsai:insight-draft:${workbookId ?? "new"}:${scenario ?? ""}`;
  useEffect(() => {
    if (!onBranch || !paths.length) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ version: 1, paths, active_path_id: activePathId, tab, visible_columns: visibleColumns, chart_columns: chartColumns, layouts }));
    } catch {
      // storage unavailable: the draft just is not kept
    }
  }, [onBranch, draftKey, paths, activePathId, tab, visibleColumns, chartColumns, layouts]);
  const selValues = useMemo(() => (groupSel && groupSel.path === activePathId ? groupSel.values : []), [groupSel, activePathId]);
  const spec = useMemo(() => {
    const base = searchSpec(activePath, refs);
    const by = activePath?.transform?.enabled ? activePath.transform.group_by : null;
    if (!base || !by || !selValues.length) return base;
    // the selection filters the objects; the Group By table keeps showing every group (baseAgg)
    return { ...base, aggregate: null, filters: [...(base.filters ?? []), { property: by, op: "in" as FilterOp, value: selValues }] };
  }, [activePath, refs, selValues]);
  const setMath = activePath?.transform?.set_math ?? null;
  const partnerPath = setMath ? paths.find((p) => p.id === setMath.other_path_id) ?? null : null;
  const partnerSpec = useMemo(() => searchSpec(partnerPath, refs), [partnerPath, refs]);
  const queryKey = spec ? JSON.stringify({ spec, setMath, partnerSpec, scenario }) : "";
  useEffect(() => {
    if (!spec) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const request = setMath
        ? partnerSpec
          ? Promise.all([om.search({ ...spec, aggregate: null }), om.search({ ...partnerSpec, aggregate: null })]).then(([a, b]) => combineSets(a, b, setMath.operation))
          : Promise.reject(new Error("Set Math needs a second path. Add or duplicate a path, then select it here."))
        : om.search(spec);
      request.then((data) => {
        if (!live) return;
        setResultState({ key: queryKey, data }); setResultError(null); setSelectedKeys([]);
        capture({ object_type_id: spec.object_type_id, link_type_ids: (spec.search_around ?? []).map((s) => s.link_type_id), q: spec.q || undefined });
        if (data.aggregation && activePathId) setBaseAgg({ path: activePathId, agg: data.aggregation });
      }, (e: Error) => live && setResultError({ key: queryKey, error: e.message }));
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [spec, setMath, partnerSpec, queryKey, refreshToken, activePathId]);
  const result = resultState?.key === queryKey ? resultState.data : null;
  const loading = Boolean(spec && resultState?.key !== queryKey && resultError?.key !== queryKey);
  const activeError = resultError?.key === queryKey ? resultError.error : null;
  const actions = actionState && actionState.typeId === result?.result_type.id ? actionState.actions : [];

  const currentTypeId = activePath ? nextTypeId(activePath, linkTypes) : null;
  const resultType = result?.result_type ?? (currentTypeId ? types.find((t) => t.id === currentTypeId) : undefined);
  const sourceType = activePath && activePath.source_kind !== "interface" ? types.find((t) => t.id === (activePath.source_kind === "object_type" ? activePath.source_id : activePath.start_type_id)) : undefined;
  const referencedSet = activePath?.source_kind === "object_set" ? savedSearches.find((x) => x.id === activePath.source_id) : undefined;
  const sourceList = activePath?.source_kind === "list" ? lists.find((x) => x.id === activePath.source_id) : undefined;
  const finalObjectType = resultType ? types.find((t) => t.id === resultType.id) : undefined;
  const resultProperties = result?.result_type.properties ?? finalObjectType?.properties ?? [];
  const availableProperties = resultProperties.filter((p) => p.visibility !== "hidden");
  const shownColumns = availableProperties.filter((p) => visibleColumns.length === 0 || visibleColumns.includes(p.api_name));
  const filteredHistograms = result?.histograms.filter((h) => chartColumns.length === 0 || chartColumns.includes(h.property)) ?? [];
  const sqlData = useMemo(() => result ? makeSqlTable(result) : null, [result]);
  const pageRows = result?.objects.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE) ?? [];
  const pageCount = result ? Math.max(1, Math.ceil(Math.min(result.objects.length, 1000) / PAGE_SIZE)) : 1;

  useEffect(() => {
    const typeId = result?.result_type.id;
    if (!typeId) return;
    let live = true;
    ontology.actionTypes(typeId).then((a) => live && setActionState({ typeId, actions: a }), () => live && setActionState({ typeId, actions: [] }));
    return () => { live = false; };
  }, [result?.result_type.id]);

  const updatePath = (change: (p: InsightPath) => InsightPath) => {
    if (!activePath) return;
    setPaths((cur) => cur.map((p) => p.id === activePath.id ? change(p) : p));
  };
  const patchFilter = (filterId: string, patch: Partial<InsightFilterStep>, linkId?: string) => updatePath((p) => {
    if (!linkId) return { ...p, filters: p.filters.map((f) => f.id === filterId ? { ...f, ...patch } : f) };
    return { ...p, links: p.links.map((l) => l.id === linkId ? { ...l, filters: l.filters.map((f) => f.id === filterId ? { ...f, ...patch } : f) } : l) };
  });
  const addRootFilter = () => updatePath((p) => ({ ...p, filters: [...p.filters, freshFilter(sourceType?.properties ?? [])] }));
  const addLink = () => {
    if (!activePath || activePath.source_kind === "interface") return;
    const from = nextTypeId(activePath, linkTypes);
    if (!from) return;
    const choice = linkTypes.find((l) => directions(l, from).length > 0);
    if (!choice) { setError("No link types connect to the current result object type."); return; }
    const dir = directions(choice, from)[0];
    updatePath((p) => ({ ...p, links: [...p.links, { id: id(), link_type_id: choice.id, direction: dir, filters: [], enabled: true }] }));
  };
  const addFilterToLink = (linkStep: InsightLinkStep, index: number) => {
    const target = nextTypeId(activePath!, linkTypes, index);
    const props = types.find((t) => t.id === target)?.properties ?? [];
    updatePath((p) => ({ ...p, links: p.links.map((l) => l.id === linkStep.id ? { ...l, filters: [...l.filters, freshFilter(props)] } : l) }));
  };
  const addTransform = () => updatePath((p) => ({ ...p, transform: p.transform ?? { enabled: true, metric: "count", property: null, group_by: null, set_math: null } }));
  const setPathSource = (kind: "object_type" | "interface", sourceId: string, label: string) => {
    const path = freshPath(kind, sourceId, `Path ${paths.length + 1}`);
    setPaths((cur) => [...cur, path]); setActivePathId(path.id); setShowSources(false); setSourceSearch(""); setError(null);
    setVisibleColumns([]); setChartColumns([]); setSelectedKeys([]); setPageIndex(0);
    if (label) setWorkbookName((v) => v === "New Insight" ? label : v);
  };
  const makeDocument = (): InsightDocument => ({ version: 1, paths, active_path_id: activePathId, tab, visible_columns: visibleColumns, chart_columns: chartColumns, layouts });

  const chooseWorkbook = async (w: InsightWorkbook) => {
    setError(null);
    try {
      const saved = await insightApi.get(w.id);
      setWorkbook(saved); setWorkbookName(saved.name); setDescription(saved.description); setSharingEnabled(saved.shared); setSharingRole(saved.share_role);
      applyDocument(saved.spec); setShowOpenMenu(false); router.replace(`/insight?workbook=${encodeURIComponent(saved.id)}`);
    } catch (e) { setError((e as Error).message); }
  };
  const saveWorkbook = async (name: string, desc: string) => {
    setError(null);
    try {
      const doc = makeDocument();
      const saved = workbook?.can_edit
        ? await insightApi.save(workbook.id, name, desc, doc)
        : await insightApi.create(name, desc, doc);
      setWorkbook(saved); setWorkbookName(saved.name); setDescription(saved.description); setWorkbooks((cur) => [saved, ...cur.filter((x) => x.id !== saved.id)]);
      setShowSaveDialog(false); router.replace(`/insight?workbook=${encodeURIComponent(saved.id)}`);
    } catch (e) { setError((e as Error).message); }
  };
  const shareWorkbook = async () => {
    if (!workbook?.can_manage_sharing) return;
    setShareBusy(true); setError(null);
    try {
      const updated = await insightApi.setSharing(workbook.id, sharingEnabled, sharingRole);
      setWorkbook(updated); setWorkbooks((cur) => [updated, ...cur.filter((x) => x.id !== updated.id)]);
      if (updated.shared) {
        const url = `${window.location.origin}/insight?workbook=${encodeURIComponent(updated.id)}`;
        await navigator.clipboard.writeText(url).catch(() => undefined);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setShareBusy(false); }
  };
  const copyShareLink = async () => {
    if (!workbook?.shared) return;
    const url = `${window.location.origin}/insight?workbook=${encodeURIComponent(workbook.id)}`;
    try { await navigator.clipboard.writeText(url); setError("Workbook link copied. Recipients still need Nexus access to its source objects."); }
    catch { setError(`Copy this link: ${url}`); }
  };
  const saveLayout = () => {
    const name = layoutName.trim();
    if (!name) return;
    const layout: InsightLayout = { id: id(), name, tab: tab === "sql" ? "table" : tab, visible_columns: visibleColumns, chart_columns: chartColumns };
    setLayouts((cur) => [...cur.filter((l) => l.name.toLowerCase() !== name.toLowerCase()), layout]);
    setLayoutName(""); setShowLayoutMenu(false);
  };
  const applyLayout = (layout: InsightLayout) => {
    setTab(layout.tab); setVisibleColumns(layout.visible_columns); setChartColumns(layout.chart_columns); setShowLayoutMenu(false);
  };
  const publishObjectSet = async () => {
    if (!spec || !activePath) return;
    const existing = activePath.published_id && savedSearches.some((x) => x.id === activePath.published_id) ? activePath.published_id : null;
    const name = existing ? "" : window.prompt("Name the object set", `${activePath.name} object set`);
    if (!existing && !name?.trim()) return;
    try {
      const definition = { object_type_id: spec.object_type_id, interface_id: spec.interface_id, q: spec.q, filters: spec.filters, search_around: spec.search_around };
      const saved = await insightApi.publish(name?.trim() ?? "", definition, { workbook_id: workbook?.id ?? null, path_id: activePath.id }, existing);
      updatePath((p) => ({ ...p, published_id: saved.id }));
      setError(existing ? "Published object set updated: paths and applications referencing it see the new definition." : "Published as an object set: reference or copy it from Add path, or open it in Object Explorer. Save the workbook to keep the link.");
      om.explorations().then((e) => setSavedSearches(e as { id: string; name: string; spec: SearchSpec }[])).catch(() => undefined);
    } catch (e) { setError((e as Error).message); }
  };
  /** Every object key of the path's result (up to 200,000), page by page. */
  const allKeys = async (): Promise<{ typeId: string; keys: string[] } | null> => {
    if (!spec) return null;
    const keys: string[] = [];
    let typeId = "";
    for (let offset = 0; offset < 200_000; offset += 1000) {
      const page = await om.search({ ...spec, aggregate: null, histograms: false, offset, limit: 1000 });
      typeId = page.result_type.id;
      keys.push(...page.objects.map((o) => o.primary_key));
      if (page.objects.length < 1000 || keys.length >= page.total) break;
    }
    return { typeId, keys };
  };
  const saveAsList = async () => {
    if (!activePath) return;
    const name = window.prompt("Name the list (a snapshot of the objects in this path's results)", `${activePath.name} list`);
    if (!name?.trim()) return;
    try {
      const all = await allKeys();
      if (!all) return;
      const l = await insightApi.createList(name.trim(), all.typeId, all.keys);
      setLists((cur) => [l, ...cur]);
      setError(`Saved ${l.count.toLocaleString()} objects as the list ${l.name}.`);
    } catch (e) { setError((e as Error).message); }
  };
  const addSelectedToList = async (target: string) => {
    if (!result || !selectedKeys.length) return;
    try {
      if (target === "__new") {
        const name = window.prompt("Name the new list", `${result.result_type.display_name} list`);
        if (!name?.trim()) return;
        const l = await insightApi.createList(name.trim(), result.result_type.id, selectedKeys);
        setLists((cur) => [l, ...cur]);
      } else {
        const l = await insightApi.changeList(target, selectedKeys);
        setLists((cur) => cur.map((x) => (x.id === l.id ? l : x)));
        setListKeys((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => k !== l.id)));
      }
      setError(`Added ${selectedKeys.length} objects to the list.`);
    } catch (e) { setError((e as Error).message); }
    finally { setListTarget(""); }
  };
  const resultTypeOf = (s: SearchSpec): string | null => {
    let current = s.object_type_id ?? null;
    for (const step of s.search_around ?? []) {
      const link = linkTypes.find((l) => l.id === step.link_type_id);
      if (!link || !current) return null;
      current = step.direction === "forward" ? link.target.object_type_id : link.source.object_type_id;
    }
    return current;
  };
  const referencePath = (set: { id: string; name: string; spec: SearchSpec }) => {
    const p: InsightPath = { ...freshPath("object_type", set.id, set.name), source_kind: "object_set", start_type_id: resultTypeOf(set.spec) };
    setPaths((cur) => [...cur, p]); setActivePathId(p.id); setShowSources(false);
  };
  const listPath = (l: ObjectList) => {
    const p: InsightPath = { ...freshPath("object_type", l.id, l.name), source_kind: "list", start_type_id: l.object_type_id };
    setPaths((cur) => [...cur, p]); setActivePathId(p.id); setShowSources(false);
  };
  const switchBranch = (sid: string) => {
    const q = new URLSearchParams(searchParams.toString());
    if (sid) q.set("scenario", sid); else q.delete("scenario");
    if (sid) {
      // a draft autosaved on this branch earlier comes back
      try {
        const d = localStorage.getItem(`bsai:insight-draft:${workbookId ?? "new"}:${sid}`);
        if (d) applyDocument(JSON.parse(d) as InsightDocument);
      } catch {
        // no draft
      }
    }
    router.replace(`/insight?${q}`);
    setRefreshToken((x) => x + 1);
  };
  const runSql = () => {
    if (!sqlRuntime.engine || !sqlData) return;
    try {
      setSqlResult(sqlRuntime.engine.query({ Path: sqlData }, sqlText)); setSqlError(null); setSqlRun(true);
    } catch (e) { setSqlError((e as Error).message); setSqlResult(null); }
  };
  const downloadCsvPreview = async () => {
    if (!result) return;
    if (!(await allowExport({ detail: `Insight preview (CSV, ${result.objects.length} objects)` }))) return;
    const props = shownColumns;
    const rows = [["title", "primary_key", ...props.map((p) => p.api_name)], ...result.objects.map((o) => [o.title, o.primary_key, ...props.map((p) => o.properties[p.api_name])])];
    const blob = new Blob([rows.map((r) => r.map(csvValue).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "insight-preview.csv"; a.click(); URL.revokeObjectURL(url);
  };

  const sourceCandidates = sourceKind === "object_type"
    ? types.filter((t) => t.visibility !== "hidden" && `${t.display_name} ${t.plural_name} ${t.api_name}`.toLowerCase().includes(sourceSearch.toLowerCase()))
    : interfaces.filter((i) => `${i.display_name} ${i.api_name}`.toLowerCase().includes(sourceSearch.toLowerCase()));

  const renderFilter = (f: InsightFilterStep, props: Property[], remove: () => void, linkId?: string) => f.property === "__link" ? renderLinkFilter(f, remove, linkId) : (
    <div key={f.id} className={`grid grid-cols-[18px_minmax(100px,1fr)_112px_minmax(80px,1fr)_26px] items-center gap-1.5 rounded border px-2 py-1.5 ${f.enabled ? "border-line bg-panel" : "border-line bg-panel-2 opacity-60"}`}>
      <input aria-label="Enable filter" type="checkbox" checked={f.enabled} onChange={(e) => patchFilter(f.id, { enabled: e.target.checked }, linkId)} className="accent-blue-600" />
      <select value={f.property} onChange={(e) => patchFilter(f.id, e.target.value === "__link" ? { property: "__link", op: "linked", value: { link_type_id: "", direction: "forward", filters: [] } } : { property: e.target.value }, linkId)} className="min-w-0 bg-transparent text-[11px] text-soft outline-none">
        <option value="__title">Title</option>
        {props.filter((p) => p.visibility !== "hidden").map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}
        {!linkId && <option value="__link">On a link…</option>}
      </select>
      <select value={f.op} onChange={(e) => patchFilter(f.id, { op: e.target.value as FilterOp, ...(e.target.value === "within" ? { value: { terms: [], gap: 0 } } : f.op === "within" ? { value: "" } : {}) }, linkId)} className="rounded border border-line bg-panel px-1 py-1 text-[11px] text-soft">
        {OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>
      {f.op === "within" ? (
        <div className="min-w-0 space-y-1">
          <input value={((f.value as WithinSpec | undefined)?.terms ?? []).join(", ")} onChange={(e) => patchFilter(f.id, { value: { ...(f.value as WithinSpec), terms: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } }, linkId)} placeholder="terms, comma-separated" className="w-full min-w-0 rounded border border-line px-2 py-1 text-[11px] outline-none focus:border-blue-500" />
          <div className="flex items-center gap-1.5 text-[10px] text-muted">
            gap <input type="number" min={0} value={(f.value as WithinSpec | undefined)?.gap ?? 0} onChange={(e) => patchFilter(f.id, { value: { ...(f.value as WithinSpec), gap: Number(e.target.value) } }, linkId)} className="w-10 rounded border border-line px-1" />
            <label className="flex items-center gap-0.5"><input type="checkbox" checked={!!(f.value as WithinSpec | undefined)?.ordered} onChange={(e) => patchFilter(f.id, { value: { ...(f.value as WithinSpec), ordered: e.target.checked } }, linkId)} />in order</label>
            <label className="flex items-center gap-0.5"><input type="checkbox" checked={!!(f.value as WithinSpec | undefined)?.negate} onChange={(e) => patchFilter(f.id, { value: { ...(f.value as WithinSpec), negate: e.target.checked } }, linkId)} />does not</label>
          </div>
        </div>
      ) : f.op !== "is_null" && f.op !== "not_null" ? <input value={str(f.value)} onChange={(e) => patchFilter(f.id, { value: e.target.value }, linkId)} placeholder="Value" className="min-w-0 rounded border border-line px-2 py-1 text-[11px] outline-none focus:border-blue-500" /> : <span className="text-[10px] text-muted">—</span>}
      <button type="button" onClick={remove} title="Remove filter" className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-panel-2 hover:text-soft"><Icon name="x" className="h-3 w-3" /></button>
    </div>
  );

  /** "On a link": keep objects with a linked object whose property matches, without moving the path to the linked type. */
  const renderLinkFilter = (f: InsightFilterStep, remove: () => void, linkId?: string) => {
    const spec = (f.value ?? { link_type_id: "", direction: "forward", filters: [] }) as LinkSpec;
    const from = activePath ? (activePath.source_kind === "object_type" ? activePath.source_id : activePath.start_type_id ?? null) : null;
    const choices = from ? linkTypes.flatMap((l) => directions(l, from).map((d) => ({ l, d }))) : [];
    const chosen = linkTypes.find((l) => l.id === spec.link_type_id);
    const other = chosen ? (spec.direction === "forward" ? chosen.target.object_type_id : chosen.source.object_type_id) : null;
    const otherProps = types.find((t) => t.id === other)?.properties ?? [];
    const sub = spec.filters[0] ?? { property: otherProps[0]?.api_name ?? "", op: "eq" as FilterOp, value: "" };
    const set = (p: Partial<LinkSpec>) => patchFilter(f.id, { value: { ...spec, ...p } }, linkId);
    return (
      <div key={f.id} className={`space-y-1.5 rounded border px-2 py-1.5 ${f.enabled ? "border-line bg-panel" : "border-line bg-panel-2 opacity-60"}`}>
        <div className="flex items-center gap-1.5">
          <input aria-label="Enable filter" type="checkbox" checked={f.enabled} onChange={(e) => patchFilter(f.id, { enabled: e.target.checked }, linkId)} className="accent-blue-600" />
          <span className="text-[11px] text-muted">On a link</span>
          <select value={`${spec.link_type_id}|${spec.direction}`} onChange={(e) => { const [lid, d] = e.target.value.split("|"); set({ link_type_id: lid, direction: d as LinkSpec["direction"], filters: [] }); }} className="min-w-0 flex-1 rounded border border-line bg-panel px-1 py-1 text-[11px]">
            <option value="|forward">Choose a link…</option>
            {choices.map(({ l, d }) => <option key={`${l.id}|${d}`} value={`${l.id}|${d}`}>{l.display_name} → {d === "forward" ? l.target.display_name : l.source.display_name}</option>)}
          </select>
          <button type="button" onClick={remove} title="Remove filter" className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-panel-2 hover:text-soft"><Icon name="x" className="h-3 w-3" /></button>
        </div>
        {chosen && (
          <div className="grid grid-cols-[minmax(90px,1fr)_100px_minmax(70px,1fr)] gap-1.5">
            <select value={sub.property} onChange={(e) => set({ filters: [{ ...sub, property: e.target.value }] })} className="min-w-0 rounded border border-line bg-panel px-1 py-1 text-[11px]">
              {otherProps.filter((p) => p.visibility !== "hidden").map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}
            </select>
            <select value={sub.op} onChange={(e) => set({ filters: [{ ...sub, op: e.target.value as FilterOp }] })} className="rounded border border-line bg-panel px-1 py-1 text-[11px]">
              {OPS.filter((o) => o.value !== "within").map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input value={str(sub.value)} onChange={(e) => set({ filters: [{ ...sub, value: e.target.value }] })} placeholder="Value" className="min-w-0 rounded border border-line px-2 py-1 text-[11px]" />
          </div>
        )}
        <label className="flex items-center gap-1 text-[10px] text-muted"><input type="checkbox" checked={!!spec.negate} onChange={(e) => set({ negate: e.target.checked })} />Keep objects without such a linked object</label>
      </div>
    );
  };

  const filterProperties = (typeId: string | null) => types.find((t) => t.id === typeId)?.properties ?? [];
  const linkChoicesFor = (path: InsightPath, index: number) => {
    const sourceId = nextTypeId(path, linkTypes, index - 1);
    return sourceId ? linkTypes.filter((l) => directions(l, sourceId).length) : [];
  };

  return (
    <div className="insight-shell flex h-screen min-h-[680px] flex-col overflow-hidden bg-ink text-white">
      <header className="z-20 flex h-[54px] shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <Link href="/apps" aria-label="Platform Apps" className="grid h-8 w-8 place-items-center rounded bg-sand/15 text-amber-700"><Icon name="sparkle" className="h-4 w-4" /></Link>
        <div className="flex min-w-0 items-center gap-2"><span className="font-semibold text-white">{workbookName}</span>{workbook ? <span className="rounded bg-ok/10 px-1.5 py-0.5 text-[10px] text-emerald-700">Saved</span> : <span className="rounded bg-sand/10 px-1.5 py-0.5 text-[10px] text-amber-700">Unsaved</span>}</div>
        <button type="button" onClick={() => setShowOpenMenu((v) => !v)} className="rounded px-2 py-1 text-xs text-soft hover:bg-panel-2"><Icon name="down" className="mr-1 inline h-3 w-3" />Open</button>
        <button type="button" disabled={onBranch} title={branchOnly} onClick={() => { setSaveName(workbookName); setSaveDescription(description); setShowSaveDialog(true); }} className="rounded px-2 py-1 text-xs text-soft hover:bg-panel-2 disabled:opacity-40">File</button>
        <select aria-label="Branch" value={scenario ?? ""} onChange={(e) => switchBranch(e.target.value)} title="Analyze and run actions on a branch (an Nexus scenario)" className={`rounded border px-2 py-1 text-xs ${onBranch ? "border-violet-400 bg-violet-500/10 text-violet-300" : "border-line bg-panel text-soft"}`}><option value="">main</option>{scenarios.map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}{scenario && !scenarios.some((x) => x.id === scenario) && <option value={scenario}>{scenario}</option>}</select>
        <div className="ml-auto flex items-center gap-1.5">
          {workbook && workbook.shared && <button type="button" onClick={copyShareLink} title="Copy shared workbook link" className="rounded p-2 text-muted hover:bg-panel-2"><Icon name="link" className="h-4 w-4" /></button>}
          <button type="button" onClick={() => { if (workbook?.can_manage_sharing) setShowShareDialog(true); else if (workbook) copyShareLink(); else { setSaveName(workbookName); setShowSaveDialog(true); } }} className="rounded px-2.5 py-1.5 text-xs text-soft hover:bg-panel-2"><Icon name="link" className="mr-1 inline h-3.5 w-3.5" />Share</button>
          <button type="button" disabled={onBranch} title={branchOnly} onClick={() => { setSaveName(workbookName); setSaveDescription(description); setShowSaveDialog(true); }} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40">{workbook?.can_edit ? "Save" : "Save as"}</button>
        </div>
        {showOpenMenu && <div className="absolute right-20 top-12 z-50 w-80 rounded border border-line bg-panel p-2 shadow-xl"><div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-muted">SAVED WORKBOOKS<button onClick={() => setShowOpenMenu(false)} className="text-muted"><Icon name="x" className="h-3.5 w-3.5" /></button></div>{workbooks.length ? workbooks.map((w) => <button key={w.id} type="button" onClick={() => chooseWorkbook(w)} className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-panel-2"><span className="truncate">{w.name}</span><span className="ml-2 text-[10px] text-muted">{w.shared ? w.share_role : "private"}</span></button>) : <p className="px-2 py-3 text-xs text-muted">No saved workbooks yet.</p>}</div>}
      </header>
      {error && <div className="flex shrink-0 items-center gap-2 border-b border-ocean/30 bg-ocean/10 px-4 py-1.5 text-xs text-ocean"><span className="flex-1">{error}</span><button type="button" onClick={() => setError(null)}><Icon name="x" className="h-3 w-3" /></button></div>}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex h-12 items-center gap-2 border-b border-line px-3">
            <Icon name="filter" className="h-4 w-4 text-muted" />
            {activePath ? <input aria-label="Path name" value={activePath.name} onChange={(e) => updatePath((p) => ({ ...p, name: e.target.value }))} className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" /> : <span className="flex-1 text-sm font-semibold">Analysis paths</span>}
            <button type="button" onClick={() => setShowSources((v) => !v)} title="Add a path" className="grid h-7 w-7 place-items-center rounded hover:bg-panel-2"><Icon name="plus" className="h-4 w-4" /></button>
            {activePath && <div className="group relative"><button type="button" className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel-2"><Icon name="down" className="h-3.5 w-3.5" /></button><div className="invisible absolute right-0 top-7 z-30 w-48 rounded border border-line bg-panel p-1 opacity-0 shadow-lg group-hover:visible group-hover:opacity-100 focus-within:visible focus-within:opacity-100"><button onClick={() => { const copy = { ...activePath, id: id(), name: `${activePath.name} copy`, filters: activePath.filters.map((f) => ({ ...f, id: id() })), links: activePath.links.map((l) => ({ ...l, id: id(), filters: l.filters.map((f) => ({ ...f, id: id() })) })) }; setPaths((cur) => [...cur, copy]); setActivePathId(copy.id); }} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-panel-2">Duplicate path</button><button onClick={publishObjectSet} disabled={onBranch} title={branchOnly} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-panel-2 disabled:opacity-40">{activePath.published_id && savedSearches.some((x) => x.id === activePath.published_id) ? "Update published object set" : "Publish as object set"}</button><button onClick={saveAsList} disabled={onBranch} title={branchOnly} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-panel-2 disabled:opacity-40">Save as list</button><button onClick={() => { setPaths((cur) => cur.filter((p) => p.id !== activePath.id)); setActivePathId(paths.find((p) => p.id !== activePath.id)?.id ?? null); }} className="w-full rounded px-2 py-1.5 text-left text-xs text-red-600 hover:bg-bad/10">Delete path</button></div></div>}
          </div>
          {paths.length > 0 && <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1.5">{paths.map((p, i) => <button key={p.id} type="button" onClick={() => { setActivePathId(p.id); setPageIndex(0); }} className={`max-w-40 shrink-0 truncate rounded px-2.5 py-1 text-xs ${p.id === activePathId ? "bg-ocean/10 font-medium text-blue-700" : "text-muted hover:bg-panel-2"}`}>{p.name || `Path ${i + 1}`}</button>)}<button onClick={() => setShowSources(true)} className="rounded px-2 text-muted hover:bg-panel-2"><Icon name="plus" className="h-3 w-3" /></button></div>}
          {showSources && <div className="border-b border-line bg-panel-2 p-3">
            <div className="mb-2 flex gap-1 rounded border border-line bg-panel p-1 text-[11px]"><button onClick={() => setSourceKind("object_type")} className={`flex-1 rounded px-2 py-1 ${sourceKind === "object_type" ? "bg-ocean/10 text-blue-700" : "text-muted"}`}>Object types</button><button onClick={() => setSourceKind("interface")} className={`flex-1 rounded px-2 py-1 ${sourceKind === "interface" ? "bg-ocean/10 text-blue-700" : "text-muted"}`}>Interfaces</button></div>
            <input autoFocus value={sourceSearch} onChange={(e) => setSourceSearch(e.target.value)} placeholder="Search Nexus sources…" className="mb-2 w-full rounded border border-line-2 bg-panel px-2.5 py-2 text-xs outline-none focus:border-blue-500" />
            <div className="max-h-52 overflow-auto rounded border border-line bg-panel">{sourceCandidates.slice(0, 40).map((entry) => {
              const key = entry.id; const name = entry.display_name; const count = "object_count" in entry ? Number(entry.object_count ?? 0) : undefined;
              return <button key={key} type="button" onClick={() => setPathSource(sourceKind, key, name)} className="flex w-full items-center gap-2 border-b border-line px-2.5 py-2 text-left text-xs last:border-0 hover:bg-ocean/10"><Icon name={sourceKind === "object_type" ? "cube" : "link"} className="h-3.5 w-3.5 text-blue-600" /><span className="min-w-0 flex-1 truncate">{name}</span>{count !== undefined && <span className="text-[10px] text-muted">{count.toLocaleString()}</span>}</button>;
            })}{!sourceCandidates.length && <p className="p-3 text-xs text-muted">No matching sources.</p>}</div>
            {sourceKind === "object_type" && savedSearches.length > 0 && <div className="mt-2"><p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Object sets</p>{savedSearches.slice(0, 8).map((s) => <div key={s.id} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-soft hover:bg-panel"><span className="min-w-0 flex-1 truncate" title={s.name}>{s.name}</span><button type="button" title="Start a path from this object set, read-only: changes to it flow into the path" onClick={() => referencePath(s)} className="rounded border border-line px-1.5 py-0.5 text-[10px] hover:bg-panel-2">Reference</button><button type="button" title="Copy its filters into a new path: later changes to the object set do not affect it" onClick={() => { const t = types.find((x) => x.id === s.spec.object_type_id); if (s.spec.object_type_id && t) { const p = freshPath("object_type", t.id, `Path ${paths.length + 1}`); p.query = s.spec.q ?? ""; p.filters = (s.spec.filters ?? []).map((f) => ({ id: id(), property: f.property, op: f.op, value: f.value, enabled: true })); p.links = (s.spec.search_around ?? []).map((l) => ({ id: id(), link_type_id: l.link_type_id, direction: l.direction, filters: (l.filters ?? []).map((f) => ({ id: id(), property: f.property, op: f.op, value: f.value, enabled: true })), enabled: true })); setPaths((cur) => [...cur, p]); setActivePathId(p.id); setShowSources(false); } }} className="rounded border border-line px-1.5 py-0.5 text-[10px] hover:bg-panel-2">Copy</button></div>)}</div>}
            {sourceKind === "object_type" && lists.length > 0 && <div className="mt-2"><p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Lists</p>{lists.slice(0, 8).map((l) => <button key={l.id} type="button" onClick={() => listPath(l)} className="flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left text-xs text-soft hover:bg-panel"><Icon name="list" className="h-3 w-3 text-muted" /><span className="min-w-0 flex-1 truncate">{l.name}</span><span className="text-[10px] text-muted">{l.count.toLocaleString()}</span></button>)}</div>}
          </div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {!activePath ? <div className="grid h-full place-items-center text-center"><div><div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-ocean/10 text-blue-600"><Icon name="search" className="h-5 w-5" /></div><p className="text-sm font-medium text-soft">Start an analysis path</p><p className="mt-1 max-w-60 text-xs leading-5 text-muted">Choose an Nexus object type or interface, then filter, follow relationships, and transform results.</p><button type="button" onClick={() => setShowSources(true)} className="mt-4 rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700">Choose starting data</button></div></div> : <>
              {sourceType && activePath.source_kind === "object_type" && <PathCard title={sourceType.display_name} subtitle="Starting data" count={sourceType.object_count} icon="cube"><div className="mt-2 flex items-center gap-2"><input value={activePath.query} onChange={(e) => updatePath((p) => ({ ...p, query: e.target.value }))} placeholder="Search across properties…" className="min-w-0 flex-1 rounded border border-line px-2 py-1.5 text-xs outline-none focus:border-blue-500" /><button onClick={() => updatePath((p) => ({ ...p, query: "" }))} className="text-muted hover:text-soft"><Icon name="x" className="h-3 w-3" /></button></div></PathCard>}
              {activePath.source_kind === "object_set" && <PathCard title={referencedSet?.name ?? "Object set (not found)"} subtitle={`Object set reference · read-only${sourceType ? ` · ${sourceType.display_name}` : ""}`} icon="link"><div className="mt-2 space-y-1 text-[11px] text-muted">{referencedSet ? <>{referencedSet.spec.q && <p>Search: {referencedSet.spec.q}</p>}{(referencedSet.spec.filters ?? []).map((f, i) => <p key={i}>{f.property} {f.op} {str(f.value)}</p>)}{(referencedSet.spec.search_around ?? []).length > 0 && <p>{(referencedSet.spec.search_around ?? []).length} search-around step(s)</p>}<p className="text-[10px]">Changes to the object set flow into this path; to edit it, copy it instead.</p></> : <p className="text-red-600">The referenced object set was deleted or is not shared with you.</p>}</div></PathCard>}
              {activePath.source_kind === "list" && <PathCard title={sourceList?.name ?? "List"} subtitle={`Static list · ${sourceList?.count.toLocaleString() ?? "?"} objects${sourceType ? ` · ${sourceType.display_name}` : ""}`} icon="table"><p className="mt-2 text-[10px] text-muted">A point-in-time snapshot of objects: later data changes do not add or remove objects.</p></PathCard>}
              {activePath.source_kind === "interface" && <PathCard title={interfaces.find((i) => i.id === activePath.source_id)?.display_name ?? "Interface"} subtitle="Starting data" count={undefined} icon="link"><p className="mt-2 text-[11px] text-muted">Interface searches are supported. Link traversal starts from object types.</p></PathCard>}
              {activePath.filters.map((f) => <PathCard key={f.id} title="Filter" subtitle={f.enabled ? "Enabled" : "Disabled"} count={activePath.links.length ? undefined : result?.total} icon="search" disabled={!f.enabled} collapsed={collapsed[f.id]} onCollapse={() => setCollapsed((c) => ({ ...c, [f.id]: !c[f.id] }))} onRemove={() => updatePath((p) => ({ ...p, filters: p.filters.filter((x) => x.id !== f.id) }))}>
                <div className="mt-2">{renderFilter(f, sourceType?.properties ?? [], () => updatePath((p) => ({ ...p, filters: p.filters.filter((x) => x.id !== f.id) })))}</div>
              </PathCard>)}
              {activePath.links.map((l, i) => {
                const link = linkTypes.find((x) => x.id === l.link_type_id);
                const fromTypeId = nextTypeId(activePath, linkTypes, i - 1);
                const choices = linkChoicesFor(activePath, i);
                const targetId = nextTypeId(activePath, linkTypes, i);
                const props = filterProperties(targetId);
                const linkName = link?.display_name ?? "Choose a link";
                const display = l.direction === "forward" ? link?.target.display_name : link?.source.display_name;
                return <PathCard key={l.id} title="Link" subtitle={display ? `${linkName} → ${display}` : linkName} count={result?.path[i]?.count} icon="link" disabled={!l.enabled} onToggleEnabled={(enabled) => updatePath((p) => ({ ...p, links: p.links.map((x) => x.id === l.id ? { ...x, enabled } : x) }))} collapsed={collapsed[l.id]} onCollapse={() => setCollapsed((c) => ({ ...c, [l.id]: !c[l.id] }))} onRemove={() => updatePath((p) => ({ ...p, links: p.links.filter((x) => x.id !== l.id) }))}>
                  <div className="mt-2 grid grid-cols-[1fr_94px] gap-1.5">
                    <select value={l.link_type_id} onChange={(e) => { const next = linkTypes.find((x) => x.id === e.target.value); if (!next) return; const dirs = directions(next, fromTypeId ?? ""); updatePath((p) => ({ ...p, links: p.links.map((x) => x.id === l.id ? { ...x, link_type_id: next.id, direction: dirs[0] ?? "forward", filters: [] } : x) })); }} className="min-w-0 rounded border border-line bg-panel px-2 py-1.5 text-[11px]">{choices.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select>
                    <select value={l.direction} onChange={(e) => updatePath((p) => ({ ...p, links: p.links.map((x) => x.id === l.id ? { ...x, direction: e.target.value as "forward" | "reverse" } : x) }))} className="rounded border border-line bg-panel px-2 py-1.5 text-[11px]"><option value="forward" disabled={!link || link.source.object_type_id !== fromTypeId}>Forward</option><option value="reverse" disabled={!link || link.target.object_type_id !== fromTypeId}>Reverse</option></select>
                  </div>
                  <div className="mt-2 space-y-1.5">{l.filters.map((f) => renderFilter(f, props, () => updatePath((p) => ({ ...p, links: p.links.map((x) => x.id === l.id ? { ...x, filters: x.filters.filter((y) => y.id !== f.id) } : x) })), l.id))}</div>
                  <button type="button" onClick={() => addFilterToLink(l, i)} className="mt-2 text-[11px] text-blue-700 hover:underline">+ Filter linked objects</button>
                </PathCard>;
              })}
              {activePath.transform && <PathCard title="Group By" subtitle={activePath.transform.enabled ? "Transform" : "Disabled"} count={result?.total} icon="table" disabled={!activePath.transform.enabled} onToggleEnabled={(enabled) => updatePath((p) => ({ ...p, transform: p.transform ? { ...p.transform, enabled } : null }))} collapsed={collapsed.transform} onCollapse={() => setCollapsed((c) => ({ ...c, transform: !c.transform }))} onRemove={() => updatePath((p) => ({ ...p, transform: null }))}>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                  <label className="col-span-2 text-muted">Set operation<select value={activePath.transform.set_math?.operation ?? ""} onChange={(e) => updatePath((p) => { if (!p.transform) return p; const operation = e.target.value as "union" | "intersect" | "subtract" | ""; return { ...p, transform: { ...p.transform, set_math: operation ? { operation, other_path_id: p.transform.set_math?.other_path_id || paths.find((x) => x.id !== p.id)?.id || "" } : null } }; })} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1.5 text-soft"><option value="">None</option><option value="union">Union — include objects from either path</option><option value="intersect">Intersect — keep objects in both paths</option><option value="subtract">Subtract — remove objects from the other path</option></select></label>
                  {activePath.transform.set_math ? <>
                    <label className="col-span-2 text-muted">Compare with<select value={activePath.transform.set_math.other_path_id} onChange={(e) => updatePath((p) => ({ ...p, transform: p.transform?.set_math ? { ...p.transform, set_math: { ...p.transform.set_math, other_path_id: e.target.value } } : p.transform }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1.5 text-soft"><option value="">Choose another path…</option>{paths.filter((p) => p.id !== activePath.id).map((p, i) => <option key={p.id} value={p.id}>{p.name || `Path ${i + 1}`}</option>)}</select></label>
                    <p className="col-span-2 text-[10px] leading-4 text-muted">Set Math runs both paths independently and combines up to 1,000 loaded objects per path. Both paths must end at the same object type.</p>
                  </> : <>
                    <label className="text-muted">Metric<select value={activePath.transform.metric} onChange={(e) => updatePath((p) => ({ ...p, transform: p.transform ? { ...p.transform, metric: e.target.value as NonNullable<InsightPath["transform"]>["metric"] } : null }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1.5 text-soft"><option value="count">Count</option><option value="sum">Sum</option><option value="avg">Average</option><option value="min">Minimum</option><option value="max">Maximum</option></select></label>
                    <label className="text-muted">Group by<select value={activePath.transform.group_by ?? ""} onChange={(e) => updatePath((p) => ({ ...p, transform: p.transform ? { ...p.transform, group_by: e.target.value || null } : null }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1.5 text-soft"><option value="">All objects</option>{availableProperties.filter((p) => !["vector", "geoshape", "struct", "media", "timeseries"].includes(p.type)).map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}</select></label>
                    {activePath.transform.metric !== "count" && <label className="col-span-2 text-muted">Measure<select value={activePath.transform.property ?? ""} onChange={(e) => updatePath((p) => ({ ...p, transform: p.transform ? { ...p.transform, property: e.target.value || null } : null }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1.5 text-soft"><option value="">Choose a property…</option>{availableProperties.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}</select></label>}
                    <p className="col-span-2 text-[10px] leading-4 text-muted">Aggregation uses the Nexus query service. Select a group in Charts to drill back by adding a filter.</p>
                  </>}
                </div>
              </PathCard>}
              <div className="sticky bottom-0 z-10 mt-3 flex items-center justify-center gap-1 rounded border border-line bg-panel p-1.5 shadow-sm">
                <button type="button" onClick={addRootFilter} className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] text-soft hover:bg-panel-2"><Icon name="search" className="h-3.5 w-3.5" />Filter</button>
                <button type="button" onClick={addLink} disabled={!currentTypeId} className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] text-soft hover:bg-panel-2 disabled:opacity-40"><Icon name="link" className="h-3.5 w-3.5" />Link</button>
                <button type="button" onClick={addTransform} className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] text-soft hover:bg-panel-2"><Icon name="table" className="h-3.5 w-3.5" />Transform</button>
                <button type="button" onClick={() => setTab("sql")} className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] text-soft hover:bg-panel-2"><Icon name="code" className="h-3.5 w-3.5" />SQL</button>
              </div>
            </>}
          </div>
          {activePath && <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-2 text-[10px] text-muted"><span>Query usage is metered by Nexus</span><span>{result ? `${result.compute_seconds} compute-seconds` : "—"}</span></div>}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!activePath ? <div className="grid flex-1 place-items-center"><div className="text-center"><p className="text-lg font-semibold text-soft">Explore your Nexus</p><p className="mt-1 text-sm text-muted">Start with an object type or interface from the left panel.</p></div></div> : <>
            <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
              {([ ["table", "Table", "table"], ["charts", "Charts", "sparkle"], ["map", "Map", "globe"] ] as const).map(([key, label, icon]) => <button key={key} type="button" onClick={() => setTab(key)} className={`flex h-full items-center gap-1.5 border-b-2 px-3 text-xs ${tab === key ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-muted hover:text-white"}`}><Icon name={icon} className="h-3.5 w-3.5" />{label}</button>)}
              <div className="ml-auto flex items-center gap-1.5 text-[11px]">
                {result && <span className="mr-2 text-muted">{countLabel(result.total)}{result.total > result.objects.length ? ` · preview ${result.objects.length.toLocaleString()}` : ""}</span>}
                <div className="relative"><button type="button" onClick={() => setShowLayoutMenu((v) => !v)} className="rounded border border-line px-2 py-1.5 text-soft hover:bg-panel-2">Select template</button>{showLayoutMenu && <div className="absolute right-0 top-8 z-40 w-64 rounded border border-line bg-panel p-3 shadow-xl"><p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Saved layouts</p>{layouts.map((layout) => <button key={layout.id} type="button" onClick={() => applyLayout(layout)} className="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-panel-2">{layout.name}</button>)}{!layouts.length && <p className="mb-2 text-xs text-muted">No layouts saved yet.</p>}<div className="mt-2 flex gap-1"><input value={layoutName} onChange={(e) => setLayoutName(e.target.value)} placeholder="Layout name" className="min-w-0 flex-1 rounded border border-line px-2 py-1.5 text-xs" /><button type="button" onClick={saveLayout} disabled={!layoutName.trim() || onBranch} title={branchOnly} className="rounded bg-blue-600 px-2 py-1.5 text-[11px] text-white disabled:opacity-40">Save</button></div><p className="mt-2 text-[10px] text-muted">Save the workbook to persist layouts.</p></div>}</div>
                {actions.some((a) => a.kind === "create") && <select aria-label="Create an object" value="" onChange={(e) => setCreateAction(actions.find((a) => a.id === e.target.value) ?? null)} className="rounded border border-line bg-panel px-2 py-1.5 text-soft"><option value="">Create…</option>{actions.filter((a) => a.kind === "create").map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select>}
                <button type="button" onClick={() => setColumnMenu((v) => !v)} title="Configure table columns" className="rounded p-1.5 text-muted hover:bg-panel-2"><Icon name="sliders" className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={!spec || onBranch} onClick={() => spec && exportCsv(spec)} title={branchOnly ?? "Export full result CSV"} className="rounded p-1.5 text-muted hover:bg-panel-2 disabled:opacity-40"><Icon name="download" className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={!result} onClick={() => void downloadCsvPreview()} title="Download loaded preview as CSV" className="rounded border border-line px-2 py-1 text-soft hover:bg-panel-2 disabled:opacity-40">CSV preview</button>
                <button type="button" disabled={!result || onBranch} onClick={() => result && void downloadWorkbookXlsx(result, shownColumns)} title={branchOnly ?? "Download loaded preview as XLSX"} className="rounded border border-line px-2 py-1 text-soft hover:bg-panel-2 disabled:opacity-40">XLSX</button>
              </div>
              {columnMenu && result && <div className="absolute right-24 top-[106px] z-30 max-h-[70vh] w-64 overflow-auto rounded border border-line bg-panel p-3 shadow-xl"><div className="mb-2 flex items-center justify-between text-xs font-semibold">Visible properties<button onClick={() => setColumnMenu(false)}><Icon name="x" className="h-3 w-3" /></button></div>{availableProperties.map((p) => { const checked = visibleColumns.length === 0 || visibleColumns.includes(p.api_name); return <label key={p.api_name} className="flex items-center gap-2 py-1 text-xs text-soft"><input type="checkbox" checked={checked} onChange={(e) => setVisibleColumns((cur) => { const base = cur.length ? cur : availableProperties.map((x) => x.api_name); return e.target.checked ? [...new Set([...base, p.api_name])] : base.filter((x) => x !== p.api_name); })} className="accent-blue-600" />{p.display_name || p.api_name}</label>; })}</div>}
            </div>
            {tab === "sql" ? <div className="flex min-h-0 flex-1 flex-col bg-panel">
              <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-4 py-2"><Icon name="code" className="h-4 w-4 text-muted" /><span className="text-xs font-semibold">SQL sandbox · local preview</span><span className="text-[10px] text-muted">Path contains up to 1,000 loaded rows; SQL results do not modify the path</span><button onClick={() => setTab("table")} className="ml-auto rounded border border-line px-2 py-1 text-[11px]">Close</button></div>
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(130px,32%)_1fr]">
                <div className="relative border-b border-line"><textarea value={sqlText} onChange={(e) => setSqlText(e.target.value)} spellCheck={false} className="h-full w-full resize-none bg-panel p-4 font-mono text-[13px] leading-6 text-white outline-none" aria-label="SQL query" /><button type="button" onClick={runSql} disabled={!sqlRuntime.engine || !sqlData} className="absolute bottom-3 right-4 rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-40">{sqlRuntime.engine ? "Run" : "Loading SQL…"}</button></div>
                <div className="min-h-0 overflow-auto p-4">{sqlRuntime.error && <p className="mb-2 text-xs text-red-600">{sqlRuntime.error}</p>}{sqlError && <p className="mb-2 text-xs text-red-600">{sqlError}</p>}{sqlResult ? <><ResultGrid columns={sqlResult.columns.map((c) => c.name)} rows={sqlResult.rows} /><details className="mt-3 rounded border border-line p-2 text-xs" open={!!vegaSpec}><summary className="cursor-pointer font-medium text-soft">Vega chart of the SQL result</summary><p className="my-1 text-[11px] text-muted">Vega or Vega-Lite: <code>$SQL</code> is the result&apos;s rows, <code>$SQL.column</code> a column name.</p><textarea rows={8} spellCheck={false} value={vegaSpec || `{\n  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",\n  "data": { "values": $SQL },\n  "mark": "bar",\n  "encoding": {\n    "x": { "field": $SQL.${sqlResult.columns[0]?.name ?? "column1"}, "type": "nominal" },\n    "y": { "field": $SQL.${sqlResult.columns[1]?.name ?? sqlResult.columns[0]?.name ?? "column2"}, "type": "quantitative" }\n  }\n}`} onChange={(e) => setVegaSpec(e.target.value)} className="w-full rounded border border-line bg-panel p-2 font-mono text-[11px]" />{vegaSpec && <VegaView spec={vegaSpec} results={{ SQL: { rows: sqlResult.rows as Record<string, unknown>[], columns: sqlResult.columns.map((c) => c.name) } }} />}{!vegaSpec && <button type="button" onClick={() => setVegaSpec(`{\n  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",\n  "data": { "values": $SQL },\n  "mark": "bar",\n  "encoding": {\n    "x": { "field": $SQL.${sqlResult.columns[0]?.name ?? "column1"}, "type": "nominal" },\n    "y": { "field": $SQL.${sqlResult.columns[1]?.name ?? sqlResult.columns[0]?.name ?? "column2"}, "type": "quantitative" }\n  }\n}`)} className="mt-1 text-blue-700 hover:underline">Draw this chart</button>}</details></> : <p className="text-xs text-muted">{sqlRun ? "No query result." : "Query the current path with SQLite-compatible SQL, for example SELECT title, primary_key FROM Path LIMIT 25."}</p>}</div>
              </div>
            </div> : tab === "table" ? <div className="flex min-h-0 flex-1 flex-col bg-panel">
              {activeError && <div className="border-b border-bad/30 bg-bad/10 px-4 py-2 text-xs text-red-700">{activeError}</div>}
              {!result && loading ? <div className="grid flex-1 place-items-center text-sm text-muted">Running Nexus query…</div> : !result ? <div className="grid flex-1 place-items-center text-sm text-muted">No query result yet.</div> : <>
                <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-[11px] text-muted"><span className="font-medium text-soft">{result.result_type.display_name}</span><span>·</span><span>{result.execution === "in_memory" ? "In-memory" : "Distributed"} query</span><span>·</span><span>{result.query_types.join(" + ")}</span>{selectedKeys.length > 0 && <span className="ml-auto">{selectedKeys.length} selected</span>}
                  {selectedKeys.length > 0 && !onBranch && <select value={listTarget} onChange={(e) => { setListTarget(e.target.value); if (e.target.value) void addSelectedToList(e.target.value); }} className="rounded border border-line bg-panel px-2 py-1"><option value="">Add to list…</option>{lists.filter((l) => l.object_type_id === result.result_type.id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}<option value="__new">New list…</option></select>}
                  {selectedKeys.length > 0 && actions.some((a) => a.kind !== "create") && <select value="" onChange={(e) => setBulkAction(actions.find((a) => a.id === e.target.value) ?? null)} className="rounded border border-line bg-panel px-2 py-1"><option value="">Apply action…</option>{actions.filter((a) => a.kind !== "create").map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select>}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {result.total === 0 ? <p className="p-8 text-center text-sm text-muted">No objects match this path.</p> : <table className="min-w-full border-collapse text-xs">
                    <thead className="sticky top-0 z-10 bg-panel-2 text-left text-[11px] text-soft"><tr><th className="w-9 border-b border-line px-3 py-2"><input type="checkbox" checked={pageRows.length > 0 && pageRows.every((o) => selectedKeys.includes(o.primary_key))} onChange={(e) => setSelectedKeys((cur) => e.target.checked ? [...new Set([...cur, ...pageRows.map((o) => o.primary_key)])] : cur.filter((pk) => !pageRows.some((o) => o.primary_key === pk)))} className="accent-blue-600" /></th><th className="min-w-52 border-b border-line px-3 py-2">Title</th>{shownColumns.map((p) => <th key={p.api_name} className="min-w-36 border-b border-line px-3 py-2">{p.display_name || p.api_name}</th>)}<th className="border-b border-line px-3 py-2">Actions</th></tr></thead>
                    <tbody>{pageRows.map((o) => <tr key={`${o.object_type_id}:${o.primary_key}`} className="border-b border-line align-top hover:bg-blue-50/40"><td className="px-3 py-2"><input type="checkbox" checked={selectedKeys.includes(o.primary_key)} onChange={(e) => setSelectedKeys((cur) => e.target.checked ? [...new Set([...cur, o.primary_key])] : cur.filter((pk) => pk !== o.primary_key))} className="accent-blue-600" /></td><td className="max-w-72 px-3 py-2"><Link href={`/ontology/objects/${result.result_type.id}/${encodeURIComponent(o.primary_key)}`} className="font-medium text-blue-700 hover:underline">{o.title || o.primary_key}</Link><div className="mt-0.5 truncate text-[10px] text-muted">{o.primary_key}</div></td>{shownColumns.map((p) => <td key={p.api_name} className="max-w-72 px-3 py-2 text-soft"><span className="line-clamp-2 break-all" title={str(o.properties[p.api_name])}>{valueCell(o.properties[p.api_name])}</span></td>)}<td className="whitespace-nowrap px-3 py-2">{actions.filter((a) => a.kind !== "create").length > 0 && <select aria-label={`Actions for ${o.title}`} value="" onChange={(e) => { const a = actions.find((x) => x.id === e.target.value); if (a) { setRowAction(a); setRowActionObject(o); } }} className="max-w-32 rounded border border-line bg-panel px-1.5 py-1 text-[10px]"><option value="">Choose…</option>{actions.filter((a) => a.kind !== "create").map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select>}</td></tr>)}</tbody>
                  </table>}
                </div>
                <footer className="flex shrink-0 items-center justify-between border-t border-line px-3 py-2 text-[11px] text-muted"><span>Rows {(pageIndex * PAGE_SIZE + 1).toLocaleString()}–{Math.min((pageIndex + 1) * PAGE_SIZE, result.objects.length).toLocaleString()} of {result.total.toLocaleString()}{result.total > result.objects.length ? ` · first ${result.objects.length.toLocaleString()} loaded` : ""}</span><div className="flex items-center gap-2"><button disabled={pageIndex === 0} onClick={() => setPageIndex((x) => Math.max(0, x - 1))} className="rounded border border-line px-2 py-1 disabled:opacity-40">Previous</button><span>Page {pageIndex + 1} / {pageCount}</span><button disabled={pageIndex + 1 >= pageCount} onClick={() => setPageIndex((x) => Math.min(pageCount - 1, x + 1))} className="rounded border border-line px-2 py-1 disabled:opacity-40">Next</button></div></footer>
              </>}
            </div> : tab === "charts" ? <div className="min-h-0 flex-1 overflow-auto p-3">
              {activeError && <div className="mb-3 rounded border border-bad/30 bg-bad/10 p-2 text-xs text-red-700">{activeError}</div>}
              {(() => {
                const agg = result?.aggregation ?? (selValues.length && baseAgg?.path === activePathId ? baseAgg.agg : null);
                if (!agg) return null;
                return (
                  <div className="mb-3">
                    <ChartCard
                      title={agg.group_by ? `Group by ${availableProperties.find((p) => p.api_name === agg.group_by)?.display_name ?? agg.group_by}` : "Aggregate"}
                      metric={`${agg.metric}${agg.property ? ` · ${agg.property}` : ""}`}
                      rows={agg.groups.map((g) => ({ label: g.group, count: typeof g.value === "number" ? g.value : g.count }))}
                      selected={selValues}
                      onToggle={agg.group_by && activePathId ? (label) => setGroupSel({ path: activePathId, values: selValues.includes(label) ? selValues.filter((v) => v !== label) : [...selValues, label] }) : undefined}
                      onClear={() => setGroupSel(null)}
                    />
                  </div>
                );
              })()}
              <div className="grid auto-rows-[minmax(240px,1fr)] gap-3 xl:grid-cols-2">{filteredHistograms.map((h) => { const metric = h.kind === "numeric" ? "Distribution" : `${h.kind === "month" ? "Timeline" : "Values"} · ${"distinct" in h ? h.distinct : ""}`; return <ChartCard key={h.property} title={h.display_name} metric={metric} rows={histogramRows(h)} />; })}</div>
              {result && result.histograms.length > 0 && <div className="mt-3 rounded border border-line bg-panel p-3"><p className="mb-2 text-xs font-semibold text-soft">Chart properties</p><div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">{result.histograms.map((h) => { const checked = chartColumns.length === 0 || chartColumns.includes(h.property); return <label key={h.property} className="flex items-center gap-2 text-xs text-soft"><input type="checkbox" checked={checked} onChange={(e) => setChartColumns((cur) => { const base = cur.length ? cur : result.histograms.map((x) => x.property); return e.target.checked ? [...new Set([...base, h.property])] : base.filter((x) => x !== h.property); })} className="accent-blue-600" />{h.display_name}</label>; })}</div></div>}
              {!result && loading && <p className="p-8 text-center text-sm text-muted">Running Nexus query…</p>}
            </div> : result ? <MapPreview result={result} visible /> : <div className="grid flex-1 place-items-center bg-panel text-sm text-muted">{loading ? "Running Nexus query…" : "No query result yet."}</div>}
          </>}
        </main>
      </div>

      {showSaveDialog && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4"><form onSubmit={(e) => { e.preventDefault(); void saveWorkbook(saveName, saveDescription); }} className="w-full max-w-md rounded-lg border border-line bg-panel p-5 shadow-2xl"><h2 className="mb-4 text-base font-semibold">{workbook?.can_edit ? "Save Insight workbook" : "Save Insight as"}</h2><label className="mb-3 block text-xs font-medium text-soft">Name<input required maxLength={200} value={saveName} onChange={(e) => setSaveName(e.target.value)} className="mt-1 block w-full rounded border border-line-2 px-3 py-2 text-sm outline-none focus:border-blue-500" /></label><label className="block text-xs font-medium text-soft">Description<textarea maxLength={2000} value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)} rows={3} className="mt-1 block w-full rounded border border-line-2 px-3 py-2 text-sm outline-none focus:border-blue-500" /></label><p className="mt-3 text-[11px] text-muted">Saved workbook configuration stores path definitions and layout preferences, not a copy of source objects.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setShowSaveDialog(false)} className="rounded border border-line-2 px-3 py-2 text-xs">Cancel</button><button type="submit" className="rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white">Save workbook</button></div></form></div>}

      {showShareDialog && workbook?.can_manage_sharing && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4"><div className="w-full max-w-md rounded-lg border border-line bg-panel p-5 shadow-2xl"><h2 className="mb-1 text-base font-semibold">Share Insight workbook</h2><p className="mb-4 text-xs leading-5 text-muted">Workbook links expose its configuration only to signed-in platform users. Source object permissions remain enforced by Nexus.</p><label className="flex items-center gap-2 text-sm text-soft"><input type="checkbox" checked={sharingEnabled} onChange={(e) => setSharingEnabled(e.target.checked)} className="accent-blue-600" />Allow access to anyone with this platform link</label><label className="mt-4 block text-xs text-soft">Access level<select value={sharingRole} onChange={(e) => setSharingRole(e.target.value as "viewer" | "editor")} disabled={!sharingEnabled} className="mt-1 block w-full rounded border border-line-2 bg-panel px-3 py-2 text-sm disabled:opacity-50"><option value="viewer">Viewer — can open, cannot save changes</option><option value="editor">Editor — can save workbook changes</option></select></label>{sharingEnabled && <p className="mt-3 rounded bg-sand/10 p-2 text-[11px] leading-4 text-sand">The link grants workbook access to all signed-in users on this platform. It does not grant access to source objects.</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setShowShareDialog(false)} className="rounded border border-line-2 px-3 py-2 text-xs">Cancel</button><button type="button" onClick={() => { void shareWorkbook().then(() => setShowShareDialog(false)); }} disabled={shareBusy} className="rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{shareBusy ? "Saving…" : "Save sharing"}</button></div></div></div>}

      {rowAction && rowActionObject && finalObjectType && <ActionForm action={rowAction} objectType={finalObjectType} object={rowActionObject} onClose={() => { setRowAction(null); setRowActionObject(null); }} onDone={() => { setRowAction(null); setRowActionObject(null); setRefreshToken((x) => x + 1); }} />}
      {createAction && finalObjectType && <ActionForm action={createAction} objectType={types.find((t) => t.id === createAction.object_type_id) ?? finalObjectType} onClose={() => setCreateAction(null)} onDone={() => { setCreateAction(null); setRefreshToken((x) => x + 1); }} />}
      {bulkAction && finalObjectType && <BulkActionDialog action={bulkAction} type={finalObjectType} keys={selectedKeys} onClose={() => setBulkAction(null)} onDone={() => { setBulkAction(null); setSelectedKeys([]); setRefreshToken((x) => x + 1); }} />}
      {onBranch && <div className="flex shrink-0 items-center gap-3 border-t border-violet-400/40 bg-violet-500/10 px-4 py-1.5 text-xs text-violet-200"><Icon name="split" className="h-3.5 w-3.5" /><span>On branch <b>{branchName}</b>: analysis and actions use this scenario (main plus its edits). Saving the workbook, layouts, object sets, lists and Excel export are off; your work autosaves in this browser.</span><Link href={`/ontology/scenarios`} className="ml-auto underline">Manage scenarios</Link>{platformBranch()?.id !== scenario && <button type="button" onClick={() => scenario && setPlatformBranch({ id: scenario, name: branchName })} className="rounded border border-violet-400/50 px-2 py-0.5 hover:bg-violet-500/20" title="Every app's Nexus reads and actions use this branch until you exit it (the branch taskbar)">Use in every app</button>}<button type="button" onClick={() => switchBranch("")} className="rounded border border-violet-400/50 px-2 py-0.5 hover:bg-violet-500/20">Back to main</button></div>}
      {!ready && <div className="fixed inset-0 z-40 grid place-items-center bg-panel/80 text-sm text-muted">Loading Nexus workspace…</div>}
    </div>
  );
}

function PathCard({ title, subtitle, count, icon, children, disabled = false, collapsed = false, onCollapse, onRemove, onToggleEnabled }: { title: string; subtitle?: string; count?: number; icon: "cube" | "search" | "link" | "table"; children?: React.ReactNode; disabled?: boolean; collapsed?: boolean; onCollapse?: () => void; onRemove?: () => void; onToggleEnabled?: (enabled: boolean) => void }) {
  return <section className={`relative mb-2 rounded border bg-panel shadow-sm ${disabled ? "border-line opacity-60" : "border-line"}`}>
    <div className="flex items-center gap-2 px-2.5 py-2">{onToggleEnabled && <input aria-label={`Enable ${title}`} type="checkbox" checked={!disabled} onChange={(e) => onToggleEnabled(e.target.checked)} className="accent-blue-600" />}<span className="grid h-6 w-6 place-items-center rounded bg-ocean/10 text-blue-700"><Icon name={icon} className="h-3.5 w-3.5" /></span><button type="button" onClick={onCollapse} className="min-w-0 flex-1 text-left"><span className="block text-xs font-semibold text-soft">{title}</span><span className="block truncate text-[10px] text-muted">{subtitle}</span></button><span className="whitespace-nowrap text-[10px] text-muted">{countLabel(count)}</span>{onRemove && <button type="button" onClick={onRemove} title={`Remove ${title} step`} className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-panel-2"><Icon name="x" className="h-3 w-3" /></button>}</div>
    {!collapsed && children && <div className="border-t border-line p-2.5">{children}</div>}
  </section>;
}

function ResultGrid({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (!rows.length) return <p className="text-xs text-muted">No rows returned.</p>;
  return <table className="min-w-full border-collapse text-xs"><thead className="sticky top-0 bg-panel-2 text-left text-soft"><tr>{columns.map((c) => <th key={c} className="border-b border-line px-3 py-2">{c}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i} className="border-b border-line">{columns.map((c) => <td key={c} className="max-w-72 px-3 py-2 text-soft">{valueCell(r[c])}</td>)}</tr>)}</tbody></table>;
}

function BulkActionDialog({ action, type, keys, onClose, onDone }: { action: ActionType; type: ObjectType; keys: string[]; onClose: () => void; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = action.parameters.filter((p) => p.type !== "object");
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const cleaned = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== null && v !== undefined));
      await om.bulkAction(action.id, keys, cleaned); onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4"><div className="w-full max-w-lg rounded-lg border border-line bg-panel p-5 shadow-2xl"><h2 className="text-base font-semibold">{action.display_name} · {keys.length} selected</h2><p className="mt-2 text-xs leading-5 text-muted">{action.kind === "delete" ? `This action will delete ${keys.length} ${type.plural_name || type.display_name} through the configured Nexus action.` : `Filled parameter values will be applied to all ${keys.length} selected objects. Blank parameters are left unchanged.`}</p>{action.kind !== "delete" && <div className="mt-4 space-y-3">{params.map((p) => <label key={p.id} className="block text-xs text-soft">{p.display_name}<input value={str(values[p.id])} onChange={(e) => setValues((v) => ({ ...v, [p.id]: ["integer", "long", "double", "float", "decimal"].includes(p.type) ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value }))} className="mt-1 block w-full rounded border border-line-2 px-2.5 py-2 text-sm" /></label>)}</div>}{error && <p className="mt-3 rounded bg-bad/10 p-2 text-xs text-red-700">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded border border-line-2 px-3 py-2 text-xs">Cancel</button><button type="button" disabled={busy} onClick={apply} className={`rounded px-3 py-2 text-xs font-medium text-white disabled:opacity-50 ${action.kind === "delete" ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"}`}>{busy ? "Applying…" : action.kind === "delete" ? `Confirm delete ${keys.length}` : `Apply to ${keys.length}`}</button></div></div></div>;
}

export default function InsightPage() {
  return <Suspense fallback={<div className="grid h-screen place-items-center bg-panel-2 text-sm text-muted">Loading Insight…</div>}><InsightPageContent /></Suspense>;
}
