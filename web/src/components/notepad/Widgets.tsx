"use client";

import "katex/dist/katex.min.css";
import katex from "katex";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { BoardView } from "@/components/contour/Boards";
import { MapCanvas, type Basemap } from "@/components/map/MapCanvas";
import { dashboardTableCards, SelectionsBar } from "@/components/quiver/PublishedDashboardView";
import { TableCardDashboard } from "@/components/quiver/TableCards";
import { useDashboardSelections, type RunWithSelections } from "@/components/quiver/useDashboardSelections";
import { embeddableCards, type TableResult } from "@/lib/quiverTables";
import { GraphPreview, type GraphPreviewData } from "@/components/vertex/GraphPreview";
import { DiagramPreview } from "@/components/solutionDesigner/DiagramPreview";
import { sd } from "@/lib/solutionDesigner";
import { vertex, type GraphRow } from "@/lib/vertex";
import { codeWorkbooks, type WbNode } from "@/lib/codeWorkbook";
import { QuiverDashboard } from "@/components/timeseries/Quiver";
import { tsOntology, type Analysis as QuiverAnalysis, type PublishedDashboardRow } from "@/lib/timeseries";
import { Icon } from "@/components/Icon";
import { actions, functions } from "@/lib/actions";
import { ActionForm } from "@/components/ontology/ActionForm";
import type { ActionType, ObjectType as OntologyObjectType, OntologyObject } from "@/lib/ontology";
import { contour, type Analysis } from "@/lib/contour";
import { renderMarkdown } from "@/lib/markdown";
import type { DashboardInfo, DashboardInput, NotepadBlock, TemplateInput, WidgetBlock, WidgetConfig, WidgetData } from "@/lib/notepad";
import { notepad, WIDGETS } from "@/lib/notepad";
import { mediaThumbUrl, mediaUrl, ontology, type ObjectType } from "@/lib/ontology";

const field = "w-full rounded border border-line-2 bg-panel px-2 py-1 text-xs text-soft outline-none focus:border-sky-500";
const objectHref = (t: string, pk: string) => `/ontology/objects/${t}/${encodeURIComponent(pk)}`;

export function Latex({ tex, display }: { tex: string; display?: boolean }) {
  const html = katex.renderToString(tex || "", { throwOnError: false, displayMode: !!display });
  return <span className={display ? "block py-2 text-center" : ""} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A widget as readers see it; `data` comes from the server (live data or the locked snapshot). */
export function WidgetView({ b, data, preview, docId }: { b: WidgetBlock; data?: WidgetData; preview?: boolean; docId?: string }) {
  const c = b.config;
  const label = WIDGETS.find((w) => w.kind === b.kind)?.label ?? b.kind;
  if (b.kind === "latex") return <Latex tex={c.tex ?? ""} display={c.display} />;
  if (b.kind === "anchor_link")
    return (
      <button type="button" onClick={() => document.getElementById(`notepad-block-${c.target}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} className="text-ocean underline">
        {c.label || "Jump to section"}
      </button>
    );
  if (!data) return <span className="text-xs text-muted">Loading {label.toLowerCase()}…</span>;
  if (data.error) return <span className="rounded bg-bad/10 px-2 py-1 text-xs text-bad">{label}: {data.error}</span>;
  if (data.generator) return <span className="rounded border border-dashed border-line-2 px-2 py-1 text-xs text-muted">{label} · filled in per object when a document is generated</span>;
  if (data.empty) return <span className="rounded border border-dashed border-line-2 px-2 py-1 text-xs text-muted">{label} · configure it in the properties panel</span>;
  switch (b.kind) {
    case "object_property": {
      if (data.editable && !data.locked && !preview) return <InlineValue data={data} prop={data.property} label={c.show_name ? data.label : undefined} value={data.value} raw={data.raw} />;
      const body = (
        <>
          {c.show_name && <span className="text-muted">{data.label}: </span>}
          {data.value || <span className="text-muted">—</span>}
        </>
      );
      return c.disable_link ? <span>{body}</span> : <Link href={objectHref(data.object_type_id, data.pk)} title={`${data.type_name}: ${data.title}`} className="rounded bg-ocean/10 px-1 text-ocean hover:underline">{body}</Link>;
    }
    case "object_card":
      return (
        <div className="my-2 rounded-lg border border-line bg-panel-2 p-3">
          <Link href={objectHref(data.object_type_id, data.pk)} className="flex items-center gap-2 font-semibold text-ocean hover:underline"><Icon name="cube" className="h-4 w-4" />{data.title}<span className="text-xs font-normal text-muted">{data.type_name}</span></Link>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {(data.properties ?? []).map((p: { name: string; label: string; value: string; raw: unknown; editable: boolean }) => (
              <div key={p.name} className="min-w-0">
                <dt className="text-[11px] text-muted">{p.label}</dt>
                <dd className="truncate">{p.editable && !data.locked && !preview ? <InlineValue data={data} prop={p.name} value={p.value} raw={p.raw} /> : p.value || "—"}</dd>
              </div>
            ))}
          </dl>
          {(data.actions ?? []).length > 0 && !data.locked && !preview && <CardActions data={data} />}
        </div>
      );
    case "object_media":
      return (
        <div className="my-2">
          <p className="mb-1 text-[11px] text-muted"><Link href={objectHref(data.object_type_id, data.pk)} className="hover:underline">{data.title}</Link> · {data.label}</p>
          {(data.refs ?? []).length === 0 ? <p className="text-xs text-muted">No media on this object.</p> : (
            <div className="flex flex-wrap gap-2">
              {(data.refs as string[]).map((r) => (
                <a key={r} href={mediaUrl(r)} target="_blank" rel="noreferrer" className="block rounded border border-line bg-panel-2 p-1 hover:border-ocean" title="Open the media item">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={mediaThumbUrl(r, 320)} alt={data.label} className="max-h-64 max-w-full rounded" />
                </a>
              ))}
            </div>
          )}
        </div>
      );
    case "map":
      return <MapWidget data={data} />;
    case "object_markdown":
      return <MarkdownProperty data={data} editable={!!data.editable && !data.locked && !preview} />;
    case "solution_diagram":
      return (
        <div className="my-2 rounded-lg border border-line p-2">
          <Link href={`/solution-designer/${c.diagram_id}`} className="mb-1 flex items-center gap-1 text-xs text-muted hover:underline">
            <Icon name="graph" className="h-3.5 w-3.5 text-ocean" />Solution Designer · {data.name}
          </Link>
          <DiagramPreview graph={data.graph} height={Number(c.height) || 420} />
        </div>
      );
    case "code_workbook_chart":
      return (
        <div className="my-2 rounded-lg border border-line p-2">
          <Link href={`/code-workbook/workbooks/${c.workbook_id}`} className="mb-1 flex items-center gap-1 text-xs text-muted hover:underline">
            <Icon name="code" className="h-3.5 w-3.5 text-ocean" />Code Workbook · {data.workbook} · {data.node}
          </Link>
          {data.show === "figures" ? (
            (data.figures as string[]).length ? (
              (data.figures as string[]).map((f, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={`data:image/png;base64,${f}`} alt={`${data.node} figure ${i + 1}`} className="mx-auto max-w-full" />
              ))
            ) : (
              <p className="text-xs text-muted">The node drew no figure (matplotlib).</p>
            )
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full border-collapse text-left text-[11px]">
                <thead className="sticky top-0 bg-panel-2 text-muted"><tr>{(data.columns as string[]).map((col) => <th key={col} className="border-b border-line px-2 py-1">{col}</th>)}</tr></thead>
                <tbody>{(data.rows as Record<string, unknown>[]).map((r, i) => <tr key={i}>{(data.columns as string[]).map((col) => <td key={col} className="border-b border-line px-2 py-1">{r[col] === null || r[col] === undefined ? "" : String(r[col])}</td>)}</tr>)}</tbody>
              </table>
              {data.total > (data.rows as unknown[]).length && <p className="py-1 text-[10px] text-muted">First {(data.rows as unknown[]).length} of {data.total} rows</p>}
            </div>
          )}
        </div>
      );
    case "vertex_graph":
      return (
        <div className="my-2 rounded-lg border border-line p-2">
          <Link href={`/vertex?graph=${c.graph_id}`} className="mb-1 flex items-center gap-1 text-xs text-muted hover:underline">
            <Icon name="graph" className="h-3.5 w-3.5 text-ocean" />Vertex · {data.graph?.name}
          </Link>
          <GraphPreview data={data as GraphPreviewData} height={Number(c.height) || 420} />
        </div>
      );
    case "contour_chart":
      return (
        <div className="my-2 rounded-lg border border-line p-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted">
            <Icon name="filter" className="h-3.5 w-3.5 text-ocean" />
            <Link href={`/analytics/${c.analysis_id}`} className="hover:underline">{data.analysis} · {data.path}</Link>
            {Object.keys(data.params ?? {}).length > 0 && <span>· {Object.entries(data.params).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v ?? "")}`).join(", ")}</span>}
          </div>
          <BoardView b={data.board} r={data.result} />
        </div>
      );
    case "quiver_chart":
      if (data.card)
        return (
          <div className="my-2">
            <Link href={`/quiver/${c.analysis_id}`} className="mb-1 flex items-center gap-1 text-xs text-muted hover:underline"><Icon name="wave" className="h-3.5 w-3.5 text-ocean" />Quiver · {data.analysis_name}</Link>
            <TableCardDashboard card={data.card} results={data.results ?? {}} />
          </div>
        );
      return (
        <div className="my-2 rounded-lg border border-line p-3">
          <Link href={`/quiver/${c.analysis_id}`} className="mb-1 flex items-center gap-1 text-xs text-muted hover:underline"><Icon name="wave" className="h-3.5 w-3.5 text-ocean" />Quiver · {data.analysis?.name}</Link>
          <QuiverDashboard analysis={{ ...(data.analysis as QuiverAnalysis), dashboard: { cards: [c.card_id], inputs: [] } }} editableInputs={false} />
        </div>
      );
    case "quiver_dashboard":
      return <QuiverDashboardEmbed b={b} data={data} docId={docId} />;
    case "function":
      return c.markdown ? <div className="notepad-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(data.value ?? "")) }} /> : <span className="whitespace-pre-wrap">{String(data.value ?? "")}</span>;
    case "value_embed":
      return <span className="rounded bg-sand/10 px-1 text-sand" title="Template input">{data.value || `{${c.input ?? "input"}}`}</span>;
    case "user_mention":
      return <span className="rounded bg-ocean/15 px-1 font-medium text-ocean">@{data.name}</span>;
    case "resource_link":
      return <Link href={data.content_type?.includes("contour") ? `/analytics/${c.item_id}` : data.content_type?.includes("notepad") ? `/notepad/${c.item_id}` : data.content_type?.includes("parquet") ? `/datasets/${c.item_id}` : `/files`} className="inline-flex items-center gap-1 text-ocean hover:underline"><Icon name="link" className="h-3.5 w-3.5" />{c.label || data.name}</Link>;
    case "table_row_generator":
      return (
        <div className="my-2 overflow-x-auto">
          <p className="mb-1 text-[11px] text-muted">Table row generator · {data.rows?.length ?? 0} rows {preview ? "" : "with the preview values"}</p>
          <table className="w-full border-collapse text-sm">
            <tbody>
              <tr className="bg-panel-2 font-semibold">{(data.headers ?? []).map((h: string, i: number) => <td key={i} className="border border-line-2 px-3 py-1.5">{h}</td>)}</tr>
              {(data.rows ?? []).slice(0, 20).map((r: string[], i: number) => <tr key={i}>{r.map((x, j) => <td key={j} className="border border-line-2 px-3 py-1.5">{x}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

type EmbeddedDashboard = { item_id: string; name: string; version: number; latest: number; auto_update: boolean };
type MappedInput = { key: string; title: string; type: string; value: unknown; mapped: boolean };
const inputText = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).map(String).join(" – ") : String(v ?? ""));

/**
 * An embedded Quiver dashboard: a published dashboard at the widget's version (pinned, or the latest with Auto-update)
 * and mapped inputs, or (documents made before) an analysis' dashboard. Readers change its selector cards for their
 * view only (each change re-runs the dashboard through the document; nothing is saved into it); "Reset selections"
 * returns to the saved defaults. Printing drops the selections first, so a PDF — like the server's PDF / DOCX exports —
 * shows the widget's version and inputs. A locked widget shows its snapshot and takes no selections.
 */
function QuiverDashboardEmbed({ b, data, docId }: { b: WidgetBlock; data: WidgetData; docId?: string }) {
  const c = b.config;
  const qa = data.analysis as QuiverAnalysis;
  const pub = data.dashboard as EmbeddedDashboard | undefined;
  const locked = !!data.locked;
  // the widget as drafted (an unsaved change of dashboard, version or inputs runs the drafted one); stable while the config is unchanged
  const drafted = JSON.stringify({ id: b.id, type: b.type, kind: b.kind, config: b.config });
  const run = useMemo<RunWithSelections | null>(
    () => (docId && !locked ? (s) => notepad.runDashboard(docId, b.id, s, JSON.parse(drafted) as WidgetBlock).then((x) => x.tables as Record<string, TableResult>) : null),
    [docId, b.id, drafted, locked],
  );
  const sel = useDashboardSelections(run, JSON.stringify([docId, b.id, c.analysis_id, pub?.item_id, pub?.version, locked]));
  const { active, reset } = sel;
  useEffect(() => {
    if (!active) return;
    const before = () => flushSync(reset);
    window.addEventListener("beforeprint", before);
    return () => window.removeEventListener("beforeprint", before);
  }, [active, reset]);
  const tables = dashboardTableCards(qa);
  const results = sel.results((data.tables ?? {}) as Record<string, TableResult>);
  const mapped = ((data.inputs ?? []) as MappedInput[]).filter((i) => i.mapped);
  return (
    <div className="my-2 rounded-lg border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {pub ? (
          <>
            <Link href={`/quiver/dashboards/${pub.item_id}`} className="flex items-center gap-1 text-xs text-muted hover:underline"><Icon name="wave" className="h-3.5 w-3.5 text-ocean" />Quiver dashboard · {pub.name}</Link>
            <span className="text-[11px] text-muted" data-testid="dashboard-version">
              version {pub.version}{pub.auto_update ? " · auto-update" : ` · pinned${pub.latest !== pub.version ? ` (latest ${pub.latest})` : ""}`}
            </span>
            {mapped.length > 0 && (
              <span className="flex flex-wrap gap-1" data-testid="dashboard-inputs">
                {mapped.map((i) => <span key={i.key} className="rounded bg-sand/10 px-1.5 text-[11px] text-sand" title={`Dashboard input (${i.type})`}>{i.title}: {inputText(i.value)}</span>)}
              </span>
            )}
          </>
        ) : (
          <Link href={`/quiver/${c.analysis_id}`} className="flex items-center gap-1 text-xs text-muted hover:underline"><Icon name="wave" className="h-3.5 w-3.5 text-ocean" />Quiver dashboard · {qa.name}</Link>
        )}
        <span className="notepad-ui-chrome flex items-center gap-2"><SelectionsBar sel={sel} /></span>
      </div>
      {sel.error && <p className="notepad-ui-chrome mb-2 rounded bg-bad/10 px-2 py-1 text-xs text-bad">{sel.error}</p>}
      {/* keyed by the version and the mapped object / parameters: they seed the time series side's inputs */}
      <QuiverDashboard
        key={JSON.stringify([pub?.version, data.root ?? null, data.params ?? null])}
        analysis={qa}
        root={(data.root as QuiverAnalysis["root"]) ?? undefined}
        params={(data.params as Record<string, unknown>) ?? undefined}
        editableInputs={!!c.interactive && !locked}
      />
      {tables.length > 0 && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {tables.map((t) => <TableCardDashboard key={String(t.id)} card={sel.cardFor(t) as never} results={results} onSelect={run ? sel.select : undefined} />)}
        </div>
      )}
    </div>
  );
}

function MapWidget({ data }: { data: WidgetData }) {
  const [basemap, setBasemap] = useState<Basemap>("google-satellite");
  const pts = (data.points ?? []) as { lat: number; lon: number; title: string; pk: string; object_type_id: string }[];
  if (!pts.length) return <p className="text-xs text-muted">No objects with a location{data.skipped ? ` (${data.skipped} without one)` : ""}.</p>;
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const span = Math.max(...pts.map((p) => Math.abs(p.lat - lat)), ...pts.map((p) => Math.abs(p.lon - lon)), 0.01);
  const zoom = Math.max(2, Math.min(15, Math.round(Math.log2(180 / span)) - 1));
  return (
    <div className="my-2">
      {/* flex: the map fills the box (MapCanvas is a flex item; in a block box it would have no height) */}
      <div className="flex h-80 overflow-hidden rounded-lg border border-line">
        <MapCanvas basemap={basemap} onBasemap={setBasemap} initial={{ lat, lon, zoom }}>
          {(p) => pts.map((pt) => (
            <g key={`${pt.object_type_id}:${pt.pk}`}>
              <circle cx={p.px(pt.lon)} cy={p.py(pt.lat)} r={6} className="fill-sky-500/80 stroke-white" strokeWidth={1.5}><title>{pt.title}</title></circle>
              <text x={p.px(pt.lon) + 8} y={p.py(pt.lat) + 4} className="fill-white text-[10px]" style={{ paintOrder: "stroke", stroke: "#0008", strokeWidth: 3 }}>{pt.title}</text>
            </g>
          ))}
        </MapCanvas>
      </div>
      <p className="mt-1 text-[11px] text-muted">{pts.length} {data.type_name} location(s){data.skipped ? ` · ${data.skipped} without a location` : ""}</p>
    </div>
  );
}

/** The status line of a section (generator / conditional) above its content. */
export function SectionHeader({ b, data }: { b: WidgetBlock; data?: WidgetData }) {
  if (b.kind === "conditional_section")
    return (
      <p className={`text-[11px] ${data?.shown ? "text-good" : "text-bad"}`}>
        Conditional section · shown when <b>{b.config.input || "an input"}</b> {b.config.op ?? "eq"} “{b.config.value ?? ""}” · with the preview values: {data?.shown ? "shown" : "hidden"}
      </p>
    );
  return (
    <p className="text-[11px] text-muted">
      Section generator · repeated per object{data?.objects ? ` (preview: ${data.objects.length} — ${data.objects.slice(0, 5).join(", ")}${data.objects.length > 5 ? "…" : ""})` : ""}; use {"{{object.property}}"} in text
    </p>
  );
}

function useTypes() {
  const [types, setTypes] = useState<ObjectType[]>([]);
  useEffect(() => {
    ontology.objectTypes().then(setTypes, () => undefined);
  }, []);
  return types;
}

function ObjectPicker({ value, inputs, inGenerator, types, onChange }: { value: WidgetConfig | null | undefined; inputs: TemplateInput[]; inGenerator: boolean; types: ObjectType[]; onChange: (v: WidgetConfig | null) => void }) {
  const [objects, setObjects] = useState<{ primary_key: string; title: string }[]>([]);
  const [q, setQ] = useState("");
  const mode = value?.generator ? "generator" : value?.input ? "input" : "fixed";
  const typeId = value?.object_type_id ?? "";
  useEffect(() => {
    if (mode !== "fixed" || !typeId) return;
    let stale = false;
    ontology.objects(typeId, q).then((r) => !stale && setObjects(r.objects.slice(0, 100)), () => undefined);
    return () => {
      stale = true;
    };
  }, [mode, typeId, q]);
  const objInputs = inputs.filter((i) => i.type === "object");
  return (
    <div className="space-y-1">
      <select value={mode} onChange={(e) => onChange(e.target.value === "generator" ? { generator: true } : e.target.value === "input" ? { input: objInputs[0]?.name ?? "" } : { object_type_id: types[0]?.id ?? "", pk: "" })} className={field}>
        <option value="fixed">A chosen object</option>
        {objInputs.length > 0 && <option value="input">A template input</option>}
        {inGenerator && <option value="generator">Object from generator</option>}
      </select>
      {mode === "input" && (
        <select value={value?.input ?? ""} onChange={(e) => onChange({ input: e.target.value })} className={field}>
          {objInputs.map((i) => <option key={i.name}>{i.name}</option>)}
        </select>
      )}
      {mode === "fixed" && (
        <>
          <select value={typeId} onChange={(e) => onChange({ object_type_id: e.target.value, pk: "" })} className={field}>
            <option value="">Object type…</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
          </select>
          {typeId && (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search objects" className={field} />
              <select value={value?.pk ?? ""} onChange={(e) => onChange({ object_type_id: typeId, pk: e.target.value })} className={field} size={Math.min(6, Math.max(2, objects.length))}>
                {objects.map((o) => <option key={o.primary_key} value={o.primary_key}>{o.title}</option>)}
              </select>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ObjectSetPicker({ value, inputs, inGenerator, types, onChange }: { value: WidgetConfig | undefined; inputs: TemplateInput[]; inGenerator: boolean; types: ObjectType[]; onChange: (v: WidgetConfig) => void }) {
  const setInputs = inputs.filter((i) => i.type === "object_set");
  const mode = value?.linked ? "linked" : value?.object_type_id ? "type" : "input";
  const sortType = value?.linked ? value.linked.object_type_id : value?.object_type_id ?? setInputs.find((i) => i.name === value?.input)?.object_type_id;
  const props = types.find((t) => t.id === sortType)?.properties ?? [];
  return (
    <div className="space-y-1">
      <select value={mode} onChange={(e) => onChange(e.target.value === "linked" ? { linked: { object_type_id: types[0]?.id ?? "", property: "" } } : e.target.value === "type" ? { object_type_id: types[0]?.id ?? "", value: "*" } : { input: setInputs[0]?.name ?? "" })} className={field}>
        <option value="type">All objects of a type</option>
        <option value="input">An object set template input</option>
        {inGenerator && <option value="linked">Objects linked to the generator&apos;s object</option>}
      </select>
      {mode === "type" ? (
        <select value={value?.object_type_id ?? ""} onChange={(e) => onChange({ object_type_id: e.target.value, value: "*", sort: value?.sort })} className={field}>
          {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
        </select>
      ) : mode === "input" ? (
        <select value={value?.input ?? ""} onChange={(e) => onChange({ ...value, input: e.target.value })} className={field}>
          <option value="">Choose…</option>
          {setInputs.map((i) => <option key={i.name}>{i.name}</option>)}
        </select>
      ) : (
        <>
          <select value={value?.linked?.object_type_id ?? ""} onChange={(e) => onChange({ ...value, linked: { ...value?.linked, object_type_id: e.target.value } })} className={field}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
          </select>
          <input value={value?.linked?.property ?? ""} onChange={(e) => onChange({ ...value, linked: { ...value?.linked, property: e.target.value } })} placeholder="whose property…" className={field} />
          <input value={value?.linked?.parent_property ?? ""} onChange={(e) => onChange({ ...value, linked: { ...value?.linked, parent_property: e.target.value || undefined } })} placeholder="…equals the generator object's (empty: its primary key)" className={field} />
        </>
      )}
      <div className="flex gap-1">
        <select value={value?.sort?.property ?? ""} onChange={(e) => onChange({ ...value, sort: e.target.value ? { ...value?.sort, property: e.target.value } : undefined })} className={field}>
          <option value="">No sorting</option>
          {props.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" checked={!!value?.sort?.desc} onChange={(e) => onChange({ ...value, sort: { ...value?.sort, desc: e.target.checked } })} />desc</label>
      </div>
    </div>
  );
}

/** A value for a function / Contour parameter: static, a template input, or (in a generator) the generator object. */
function ValueSource({ value, inputs, inGenerator, onChange }: { value: unknown; inputs: TemplateInput[]; inGenerator: boolean; onChange: (v: unknown) => void }) {
  const v = value as WidgetConfig | string | undefined;
  const mode = typeof v === "object" && v?.input ? "input" : typeof v === "object" && v?.object ? "object" : "value";
  return (
    <div className="flex gap-1">
      <select value={mode} onChange={(e) => onChange(e.target.value === "input" ? { input: inputs[0]?.name ?? "" } : e.target.value === "object" ? { object: true } : { value: "" })} className={`${field} w-24`}>
        <option value="value">Value</option>
        {inputs.length > 0 && <option value="input">Input</option>}
        {inGenerator && <option value="object">Generator object</option>}
      </select>
      {mode === "value" && <input value={String(typeof v === "object" ? v?.value ?? "" : v ?? "")} onChange={(e) => onChange({ value: e.target.value })} className={field} />}
      {mode === "input" && (
        <select value={(v as WidgetConfig).input} onChange={(e) => onChange({ input: e.target.value })} className={field}>
          {inputs.map((i) => <option key={i.name}>{i.name}</option>)}
        </select>
      )}
      {mode === "object" && <input value={(v as WidgetConfig).object === true ? "" : (v as WidgetConfig).object} onChange={(e) => onChange({ object: e.target.value || true })} placeholder="property (empty: primary key)" className={field} />}
    </div>
  );
}

function FunctionConfig({ c, inputs, inGenerator, set }: { c: WidgetConfig; inputs: TemplateInput[]; inGenerator: boolean; set: (p: WidgetConfig) => void }) {
  const [fns, setFns] = useState<{ id: string; name: string; version: string; inputs: { name: string; type: string }[]; output: string }[]>([]);
  useEffect(() => {
    functions.list().then(setFns, () => undefined);
  }, []);
  const fn = fns.find((f) => f.id === c.function_id);
  return (
    <div className="space-y-1">
      <select value={c.function_id ?? ""} onChange={(e) => set({ function_id: e.target.value, inputs: {} })} className={field}>
        <option value="">Function…</option>
        {fns.map((f) => <option key={f.id} value={f.id}>{f.name} {f.version} → {f.output}</option>)}
      </select>
      <input value={c.version ?? ""} onChange={(e) => set({ version: e.target.value || undefined })} placeholder="Version (empty: latest)" className={field} />
      {fn?.inputs.map((i) => (
        <label key={i.name} className="block text-[11px] text-muted">{i.name} <span className="font-mono">{i.type}</span>
          <ValueSource value={c.inputs?.[i.name]} inputs={inputs} inGenerator={inGenerator} onChange={(v) => set({ inputs: { ...c.inputs, [i.name]: v } })} />
        </label>
      ))}
      <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.markdown} onChange={(e) => set({ markdown: e.target.checked })} />Show the result as Markdown</label>
    </div>
  );
}

function ContourConfig({ c, inputs, set }: { c: WidgetConfig; inputs: TemplateInput[]; set: (p: WidgetConfig) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [a, setA] = useState<Analysis | null>(null);
  useEffect(() => {
    contour.list().then(setList, () => undefined);
  }, []);
  useEffect(() => {
    if (!c.analysis_id) return;
    contour.get(c.analysis_id).then((v) => setA(v.analysis), () => setA(null));
  }, [c.analysis_id]);
  const path = a?.paths.find((p) => p.id === c.path_id);
  return (
    <div className="space-y-1">
      <select value={c.analysis_id ?? ""} onChange={(e) => set({ analysis_id: e.target.value, path_id: undefined, board_id: undefined, params: {} })} className={field}>
        <option value="">Contour analysis…</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name.replace(/\.contour$/, "")}</option>)}
      </select>
      {a && (
        <select value={c.path_id ?? ""} onChange={(e) => set({ path_id: e.target.value, board_id: undefined })} className={field}>
          <option value="">Path…</option>
          {a.paths.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {path && (
        <select value={c.board_id ?? ""} onChange={(e) => set({ board_id: e.target.value })} className={field}>
          <option value="">Board…</option>
          {path.boards.map((b) => <option key={b.id} value={b.id}>{b.title || b.type}</option>)}
        </select>
      )}
      {a?.parameters.map((p) => (
        <label key={p.name} className="block text-[11px] text-muted">${p.name}
          <ValueSource value={c.params?.[p.name]} inputs={inputs} inGenerator={false} onChange={(v) => set({ params: { ...c.params, [p.name]: v } })} />
        </label>
      ))}
      {a && a.parameters.length > 0 && (
        <label className="block text-[11px] text-muted">Or JSON (multi-value parameters; {"{{input}}"} allowed)
          <input value={c.params_json ?? ""} onChange={(e) => set({ params_json: e.target.value || undefined })} placeholder='{"fk": ["RS-01", "RS-02"]}' className={`${field} font-mono`} />
        </label>
      )}
    </div>
  );
}

function QuiverConfig({ c, dashboard, set }: { c: WidgetConfig; dashboard: boolean; set: (p: WidgetConfig) => void }) {
  const [list, setList] = useState<QuiverAnalysis[]>([]);
  const [a, setA] = useState<QuiverAnalysis | null>(null);
  useEffect(() => {
    tsOntology.analyses().then(setList, () => undefined);
  }, []);
  useEffect(() => {
    if (!c.analysis_id) return;
    tsOntology.analysis(c.analysis_id).then(setA, () => setA(null));
  }, [c.analysis_id]);
  const cards: [string, string][] = a
    ? [
        ...a.plots.map((p) => [p.id, `Plot · ${p.title}`] as [string, string]),
        ...a.logic.cards.map((x) => [x.id, `$${x.id} ${x.title || x.type}`] as [string, string]),
        ...embeddableCards(a.object_sets as { id: string; kind?: string; title?: string }[]),
      ]
    : [];
  return (
    <div className="space-y-1">
      <select value={c.analysis_id ?? ""} onChange={(e) => set({ analysis_id: e.target.value, card_id: undefined })} className={field}>
        <option value="">Quiver analysis…</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      {!dashboard && a && (
        <select value={c.card_id ?? ""} onChange={(e) => set({ card_id: e.target.value })} className={field}>
          <option value="">Card or plot…</option>
          {cards.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
        </select>
      )}
      {dashboard && <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.interactive} onChange={(e) => set({ interactive: e.target.checked })} />Readers can change the object, parameters and range</label>}
      <p className="text-[11px] text-muted">{dashboard ? "This widget embeds an analysis' dashboard as it is now (no version, no inputs mapping); it is drawn live." : "Tables, charts, values, Vega plots and single cards can be locked; time series plots are drawn live."}</p>
      {dashboard && (
        <button type="button" onClick={() => set({ analysis_id: undefined, card_id: undefined, auto_update: true, inputs: {} })} className="text-ocean hover:underline">
          Embed a published dashboard instead
        </button>
      )}
    </div>
  );
}

const INPUT_HINT: Record<string, string> = {
  Boolean: "true / false",
  Number: "number",
  String: "text",
  Time: "2026-10-01T00:00:00Z",
  "Time Range": "ISO - ISO",
  Object: "primary key",
  "Object Set": '["pk1","pk2"] or pk1, pk2',
  "String List": '["option_1","option_2"]',
};

/** Where a dashboard input's value comes from: the dashboard's default, a value, a template input of a type the input takes, or the generator's object. */
function DashboardInputSource({ input, value, inputs, inGenerator, onChange }: { input: DashboardInput; value: WidgetConfig | undefined; inputs: TemplateInput[]; inGenerator: boolean; onChange: (v: WidgetConfig | undefined) => void }) {
  const fits = inputs.filter((i) => input.accepts.includes(i.type) && (!input.object_type_id || !i.object_type_id || i.object_type_id === input.object_type_id));
  const mode = value?.input ? "input" : value?.object ? "object" : value && "value" in value ? "value" : "default";
  return (
    <div className="flex gap-1">
      <select
        aria-label={`${input.title} source`}
        value={mode}
        onChange={(e) => onChange(e.target.value === "default" ? undefined : e.target.value === "input" ? { input: fits[0]?.name ?? "" } : e.target.value === "object" ? { object: true } : { value: "" })}
        className={`${field} w-28`}
      >
        <option value="default">Default</option>
        <option value="value">Value</option>
        {fits.length > 0 && <option value="input">Input</option>}
        {inGenerator && <option value="object">Generator object</option>}
      </select>
      {mode === "default" && <span className="self-center truncate text-[11px] text-muted" title="The dashboard's saved value">{inputText(input.default) || "—"}</span>}
      {mode === "value" && <input aria-label={`${input.title} value`} value={String(value?.value ?? "")} onChange={(e) => onChange({ value: e.target.value })} placeholder={INPUT_HINT[input.type]} className={field} />}
      {mode === "input" && (
        <select aria-label={`${input.title} input`} value={value?.input} onChange={(e) => onChange({ input: e.target.value })} className={field}>
          {!fits.some((i) => i.name === value?.input) && <option value={value?.input}>{value?.input} (type does not fit)</option>}
          {fits.map((i) => <option key={i.name} value={i.name}>{i.name} ({i.type})</option>)}
        </select>
      )}
      {mode === "object" && <input value={value?.object === true ? "" : value?.object} onChange={(e) => onChange({ object: e.target.value || true })} placeholder="property (empty: primary key)" className={field} />}
    </div>
  );
}

/**
 * A published Quiver dashboard: Dashboard, Version (or Auto-update: always the latest) and, under Dashboard inputs,
 * each input (root object, parameter cards, selector cards) mapped from a value or a template input (doc 07's table).
 */
function DashboardConfig({ c, inputs, inGenerator, set }: { c: WidgetConfig; inputs: TemplateInput[]; inGenerator: boolean; set: (p: WidgetConfig) => void }) {
  const [list, setList] = useState<PublishedDashboardRow[]>([]);
  const [info, setInfo] = useState<DashboardInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auto = !!c.auto_update || c.version === undefined || c.version === null;
  useEffect(() => {
    tsOntology.publishedDashboards().then(setList, () => undefined);
  }, []);
  useEffect(() => {
    if (!c.dashboard_item_id) return;
    let live = true;
    notepad.dashboardInfo(c.dashboard_item_id, auto ? null : Number(c.version)).then(
      (i) => live && (setInfo(i), setError(null)),
      (e: Error) => live && (setInfo(null), setError(e.message)),
    );
    return () => {
      live = false;
    };
  }, [c.dashboard_item_id, auto, c.version]);
  const shown = info && info.item_id === c.dashboard_item_id ? info : null;
  const sources = (c.inputs ?? {}) as Record<string, WidgetConfig>;
  return (
    <div className="space-y-2">
      <select aria-label="Dashboard" value={c.dashboard_item_id ?? ""} onChange={(e) => set({ dashboard_item_id: e.target.value || undefined, version: undefined, auto_update: true, inputs: {} })} className={field}>
        <option value="">Published dashboard…</option>
        {list.map((x) => <option key={x.item_id} value={x.item_id}>{x.name}</option>)}
      </select>
      {list.length === 0 && <p className="text-[11px] text-muted">No published dashboards yet: publish one from a Quiver analysis (Dashboard → Publish).</p>}
      {c.dashboard_item_id && (
        <div className="space-y-1">
          <label className="flex items-center gap-1">
            <input type="checkbox" aria-label="Auto-update" checked={auto} onChange={(e) => set(e.target.checked ? { auto_update: true, version: undefined } : { auto_update: false, version: shown?.latest ?? shown?.version })} />
            Auto-update (always show the latest version)
          </label>
          <select aria-label="Version" disabled={auto} value={auto ? "" : String(c.version)} onChange={(e) => set({ auto_update: false, version: Number(e.target.value) })} className={field}>
            {auto && <option value="">Latest{shown ? ` (version ${shown.latest})` : ""}</option>}
            {!auto && shown && !shown.versions.some((v) => v.version === Number(c.version)) && <option value={String(c.version)}>Version {String(c.version)} (no longer kept)</option>}
            {(shown?.versions ?? []).map((v) => <option key={v.version} value={v.version}>Version {v.version} · {v.at.slice(0, 10)}{v.note ? ` · ${v.note}` : ""}</option>)}
          </select>
        </div>
      )}
      {error && <p className="rounded bg-bad/10 px-2 py-1 text-[11px] text-bad">{error}</p>}
      {shown && (
        <div className="space-y-1">
          <span className="font-semibold uppercase tracking-wide text-muted">Dashboard inputs</span>
          {shown.inputs.length === 0 && <p className="text-[11px] text-muted">This dashboard has no inputs.</p>}
          {shown.inputs.map((i) => (
            <label key={i.key} className="block text-[11px] text-muted">
              {i.title} <span className="font-mono">{i.type}</span> ← <span className="font-mono">{i.accepts.join(" / ")}</span>
              <DashboardInputSource
                input={i}
                value={sources[i.key]}
                inputs={inputs}
                inGenerator={inGenerator}
                onChange={(v) => {
                  const next = { ...sources };
                  if (v === undefined) delete next[i.key];
                  else next[i.key] = v;
                  set({ inputs: next });
                }}
              />
            </label>
          ))}
        </div>
      )}
      <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.interactive} onChange={(e) => set({ interactive: e.target.checked })} />Readers can change the object, parameters and range (time series)</label>
      <p className="text-[11px] text-muted">Readers can change selector cards for their own view. Lock data keeps the tables, charts and values at this version and these inputs; time series are drawn live.</p>
    </div>
  );
}

function PeoplePicker({ c, set }: { c: WidgetConfig; set: (p: WidgetConfig) => void }) {
  const [people, setPeople] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    notepad.people().then(setPeople, () => undefined);
  }, []);
  return (
    <select value={c.user_id ?? ""} onChange={(e) => set({ user_id: e.target.value, label: people.find((p) => p.id === e.target.value)?.label })} className={field}>
      <option value="">Person…</option>
      {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select>
  );
}

function ResourcePicker({ c, set }: { c: WidgetConfig; set: (p: WidgetConfig) => void }) {
  const [items, setItems] = useState<{ id: string; name: string; group: string }[]>([]);
  useEffect(() => {
    Promise.all([contour.list().catch(() => []), notepad.documents().catch(() => []), contour.sources().catch(() => ({ datasets: [] }))]).then(([cs, ns, src]) =>
      setItems([
        ...cs.map((x) => ({ id: x.id, name: x.name, group: "Contour" })),
        ...ns.map((x) => ({ id: x.id, name: x.name, group: "Notepad" })),
        ...(src.datasets ?? []).map((x: { id: string; name: string }) => ({ id: x.id, name: x.name, group: "Datasets" })),
      ]),
    );
  }, []);
  return (
    <div className="space-y-1">
      <select value={c.item_id ?? ""} onChange={(e) => set({ item_id: e.target.value })} className={field}>
        <option value="">Resource…</option>
        {["Contour", "Notepad", "Datasets"].map((g) => <optgroup key={g} label={g}>{items.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>)}
      </select>
      <input value={c.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })} placeholder="Display text (default: the name)" className={field} />
    </div>
  );
}

/** The properties panel of a widget. `headings` are anchor targets; `inGenerator` when inside a section generator. */
export function WidgetConfigPanel({ b, inputs, inGenerator, headings, onChange }: { b: WidgetBlock; inputs: TemplateInput[]; inGenerator: boolean; headings: NotepadBlock[]; onChange: (c: WidgetConfig) => void }) {
  const types = useTypes();
  const c = b.config;
  const set = (p: WidgetConfig) => onChange({ ...c, ...p });
  switch (b.kind) {
    case "object_property": {
      const tid = c.object?.object_type_id ?? inputs.find((i) => i.name === c.object?.input)?.object_type_id;
      const props = types.find((t) => t.id === tid)?.properties ?? [];
      return (
        <div className="space-y-2">
          <ObjectPicker value={c.object} inputs={inputs} inGenerator={inGenerator} types={types} onChange={(o) => set({ object: o })} />
          {props.length > 0 ? (
            <select value={c.property ?? ""} onChange={(e) => set({ property: e.target.value || undefined })} className={field}>
              <option value="">Title</option>
              {props.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
            </select>
          ) : (
            <input value={c.property ?? ""} onChange={(e) => set({ property: e.target.value || undefined })} placeholder="Property (API name; empty: title)" className={field} />
          )}
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.allow_edit} onChange={(e) => set({ allow_edit: e.target.checked })} />Allow editing (when the property has an inline edit action)</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.show_name} onChange={(e) => set({ show_name: e.target.checked })} />Show property name</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.disable_link} onChange={(e) => set({ disable_link: e.target.checked })} />Disable link</label>
          <input value={c.empty_text ?? ""} onChange={(e) => set({ empty_text: e.target.value || undefined })} placeholder="Shown when the value is empty" className={field} />
        </div>
      );
    }
    case "object_card":
      return (
        <div className="space-y-2">
          <ObjectPicker value={c.object} inputs={inputs} inGenerator={inGenerator} types={types} onChange={(o) => set({ object: o })} />
          <input value={(c.properties ?? []).join(", ")} onChange={(e) => set({ properties: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder="Visible properties, in order (API names; empty: first 8)" className={field} />
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.allow_edit} onChange={(e) => set({ allow_edit: e.target.checked })} />Allow editing (properties with an inline edit action)</label>
          <CardActionsConfig c={c} inputs={inputs} set={set} />
        </div>
      );
    case "object_markdown": {
      const tid = c.object?.object_type_id ?? inputs.find((i) => i.name === c.object?.input)?.object_type_id;
      const props = (types.find((t) => t.id === tid)?.properties ?? []).filter((p) => p.type === "string");
      return (
        <div className="space-y-2">
          <ObjectPicker value={c.object} inputs={inputs} inGenerator={inGenerator} types={types} onChange={(o) => set({ object: o })} />
          <select value={c.property ?? ""} onChange={(e) => set({ property: e.target.value || undefined })} className={field}>
            <option value="">Markdown (string) property…</option>
            {props.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
          </select>
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.allow_edit} onChange={(e) => set({ allow_edit: e.target.checked })} />Allow editing</label>
          <p className="text-[11px] text-muted">Editing saves through the property&apos;s inline edit action (Nexus Manager → property → Inline edit); without one the widget is read-only.</p>
        </div>
      );
    }
    case "object_media": {
      const tid = c.object?.object_type_id ?? inputs.find((i) => i.name === c.object?.input)?.object_type_id;
      const props = (types.find((t) => t.id === tid)?.properties ?? []).filter((p) => ["media", "media_reference", "string", "string_array", "attachment"].includes(p.type));
      return (
        <div className="space-y-2">
          <ObjectPicker value={c.object} inputs={inputs} inGenerator={inGenerator} types={types} onChange={(o) => set({ object: o })} />
          <select value={c.property ?? ""} onChange={(e) => set({ property: e.target.value || undefined })} className={field}>
            <option value="">Media property…</option>
            {props.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name} ({p.type})</option>)}
          </select>
        </div>
      );
    }
    case "map": {
      const os = c.object_set as WidgetConfig | undefined;
      const tid = os?.object_type_id ?? os?.linked?.object_type_id ?? inputs.find((i) => i.name === os?.input)?.object_type_id;
      const props = types.find((t) => t.id === tid)?.properties ?? [];
      return (
        <div className="space-y-2">
          <ObjectSetPicker value={os ?? { object_type_id: types[0]?.id ?? "", value: "*" }} inputs={inputs} inGenerator={inGenerator} types={types} onChange={(v) => set({ object_set: v })} />
          <select value={c.property ?? ""} onChange={(e) => set({ property: e.target.value || undefined })} className={field}>
            <option value="">Location (geopoint) property…</option>
            {props.filter((p) => p.type === "geopoint").map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
          </select>
          <select value={c.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })} className={field}>
            <option value="">Label: title</option>
            {props.map((p) => <option key={p.api_name} value={p.api_name}>Label: {p.display_name}</option>)}
          </select>
          <p className="text-[11px] text-muted">Up to 5,000 objects.</p>
        </div>
      );
    }
    case "contour_chart":
      return <ContourConfig c={c} inputs={inputs} set={set} />;
    case "vertex_graph":
      return <VertexConfig c={c} set={set} />;
    case "code_workbook_chart":
      return <CodeWorkbookConfig c={c} set={set} />;
    case "solution_diagram":
      return <DiagramConfig c={c} set={set} />;
    case "quiver_chart":
      return <QuiverConfig c={c} dashboard={false} set={set} />;
    case "quiver_dashboard":
      // documents made before embed an analysis' dashboard: kept as they are
      return c.analysis_id && !c.dashboard_item_id ? <QuiverConfig c={c} dashboard set={set} /> : <DashboardConfig c={c} inputs={inputs} inGenerator={inGenerator} set={set} />;
    case "function":
      return <FunctionConfig c={c} inputs={inputs} inGenerator={inGenerator} set={set} />;
    case "value_embed":
      return (
        <select value={c.input ?? ""} onChange={(e) => set({ input: e.target.value })} className={field}>
          <option value="">Template input…</option>
          {inputs.map((i) => <option key={i.name}>{i.name}</option>)}
        </select>
      );
    case "latex":
      return (
        <div className="space-y-1">
          <textarea rows={3} value={c.tex ?? ""} onChange={(e) => set({ tex: e.target.value })} placeholder="\int_0^1 x^2\,dx" className={`${field} font-mono`} />
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.display} onChange={(e) => set({ display: e.target.checked })} />Display (centered block)</label>
        </div>
      );
    case "user_mention":
      return (
        <div className="space-y-1">
          <PeoplePicker c={c} set={set} />
          <p className="text-[11px] text-muted">The person is notified when the document is saved.</p>
        </div>
      );
    case "anchor_link":
      return (
        <div className="space-y-1">
          <select value={c.target ?? ""} onChange={(e) => set({ target: e.target.value })} className={field}>
            <option value="">Heading…</option>
            {headings.map((h) => <option key={h.id} value={h.id}>{"text" in h ? h.text : h.id}</option>)}
          </select>
          <input value={c.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder="Display text" className={field} />
        </div>
      );
    case "resource_link":
      return <ResourcePicker c={c} set={set} />;
    case "section_generator":
      return (
        <div className="space-y-1">
          <ObjectSetPicker value={c.object_set} inputs={inputs} inGenerator={inGenerator} types={types} onChange={(v) => set({ object_set: v })} />
          <p className="text-[11px] text-muted">At most 30 objects ({inGenerator ? "100 nested" : "100 in a nested generator"}).</p>
        </div>
      );
    case "table_row_generator": {
      const cells: (string | WidgetConfig)[] = c.cells ?? [];
      const headers: string[] = c.headers ?? [];
      return (
        <div className="space-y-1">
          <ObjectSetPicker value={c.object_set} inputs={inputs} inGenerator={inGenerator} types={types} onChange={(v) => set({ object_set: v })} />
          {cells.map((cell, i) => (
            <div key={i} className="space-y-0.5 rounded border border-line p-1">
              <div className="flex gap-1">
                <input value={headers[i] ?? ""} onChange={(e) => set({ headers: cells.map((_, j) => (j === i ? e.target.value : headers[j] ?? "")) })} placeholder="Header" className={field} />
                <button type="button" onClick={() => set({ cells: cells.filter((_, j) => j !== i), headers: headers.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove column"><Icon name="x" className="h-3.5 w-3.5" /></button>
              </div>
              {typeof cell === "string" ? (
                <input value={cell} onChange={(e) => set({ cells: cells.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="{{object.property}}" className={`${field} font-mono`} />
              ) : (
                <FunctionConfig c={cell.function ?? {}} inputs={inputs} inGenerator set={(p) => set({ cells: cells.map((x, j) => (j === i ? { function: { ...(cell.function ?? {}), ...p } } : x)) })} />
              )}
              {typeof cell !== "string" && (
                <div className="flex gap-1 text-[11px]">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={!!cell.function?.batched} onChange={(e) => set({ cells: cells.map((x, j) => (j === i ? { function: { ...cell.function, batched: e.target.checked } } : x)) })} />Batched</label>
                  {cell.function?.batched && <input value={cell.function?.set_input ?? ""} onChange={(e) => set({ cells: cells.map((x, j) => (j === i ? { function: { ...cell.function, set_input: e.target.value || undefined } } : x)) })} placeholder="object set argument (default: objects)" className={field} />}
                </div>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <button type="button" onClick={() => set({ cells: [...cells, "{{object.title}}"], headers: [...headers, "Column"] })} className="text-ocean hover:underline">+ Text column</button>
            <button type="button" onClick={() => set({ cells: [...cells, { function: {} }], headers: [...headers, "Function"] })} className="text-ocean hover:underline">+ Function column</button>
          </div>
        </div>
      );
    }
    case "conditional_section": {
      const strings = inputs.filter((i) => i.type === "string");
      return (
        <div className="space-y-1">
          <select value={c.input ?? ""} onChange={(e) => set({ input: e.target.value })} className={field}>
            <option value="">String template input…</option>
            {strings.map((i) => <option key={i.name}>{i.name}</option>)}
          </select>
          <div className="flex gap-1">
            <select value={c.op ?? "eq"} onChange={(e) => set({ op: e.target.value })} className={field}>
              <option value="eq">is equal to</option>
              <option value="neq">is not equal to</option>
              <option value="contains">contains</option>
              <option value="empty">is empty</option>
              <option value="not_empty">is not empty</option>
            </select>
            {!["empty", "not_empty"].includes(c.op) && <input value={c.value ?? ""} onChange={(e) => set({ value: e.target.value })} className={field} />}
          </div>
          <p className="text-[11px] text-muted">Then show the section&apos;s content.</p>
        </div>
      );
    }
  }
}

function VertexConfig({ c, set }: { c: WidgetConfig; set: (p: WidgetConfig) => void }) {
  const [graphs, setGraphs] = useState<GraphRow[]>([]);
  useEffect(() => {
    vertex.graphs().then((g) => setGraphs(g.filter((x) => !x.template)), () => setGraphs([]));
  }, []);
  return (
    <div className="space-y-2">
      <select value={c.graph_id ?? ""} onChange={(e) => set({ graph_id: e.target.value || undefined })} className={field}>
        <option value="">Vertex graph…</option>
        {graphs.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.nodes} objects)</option>)}
      </select>
      <select value={String(c.height ?? 420)} onChange={(e) => set({ height: Number(e.target.value) })} className={field}>
        {[300, 420, 560, 720].map((h) => <option key={h} value={h}>Height {h}px</option>)}
      </select>
      <p className="text-[11px] text-muted">The saved graph as laid out in Vertex: objects, links, transactional edges and layer colors. Lock the widget to keep today&apos;s graph.</p>
    </div>
  );
}

function CodeWorkbookConfig({ c, set }: { c: WidgetConfig; set: (p: WidgetConfig) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [nodes, setNodes] = useState<WbNode[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => {
    codeWorkbooks.list().then((l) => setList(l.map((x) => ({ id: x.id, name: x.name.replace(/\.codeworkbook$/i, "") }))), () => setList([]));
  }, []);
  useEffect(() => {
    if (!c.workbook_id) return;
    codeWorkbooks.get(c.workbook_id, c.branch || "master").then(
      (w) => {
        setNodes(w.nodes.filter((n) => n.kind !== "input"));
        setBranches(w.branches.map((b) => b.name));
      },
      () => setNodes([]),
    );
  }, [c.workbook_id, c.branch]);
  return (
    <div className="space-y-2">
      <select value={c.workbook_id ?? ""} onChange={(e) => set({ workbook_id: e.target.value || undefined, node_id: undefined, branch: undefined })} className={field}>
        <option value="">Code Workbook…</option>
        {list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      {c.workbook_id && branches.length > 1 && (
        <select value={c.branch ?? "master"} onChange={(e) => set({ branch: e.target.value, node_id: undefined })} className={field}>
          {branches.map((b) => <option key={b}>{b}</option>)}
        </select>
      )}
      {c.workbook_id && (
        <select value={c.node_id ?? ""} onChange={(e) => set({ node_id: e.target.value || undefined })} className={field}>
          <option value="">Node…</option>
          {nodes.map((n) => <option key={n.id} value={n.id}>{n.name} ({n.kind})</option>)}
        </select>
      )}
      <select value={c.show ?? ""} onChange={(e) => set({ show: e.target.value || undefined })} className={field}>
        <option value="">Show: figures when the node draws any, else its table</option>
        <option value="figures">Show: figures (matplotlib)</option>
        <option value="table">Show: table (first 50 rows)</option>
      </select>
      <p className="text-[11px] text-muted">The node runs with what it needs upstream each time the document is opened; lock the widget to keep a snapshot.</p>
    </div>
  );
}

/** The Object property Markdown editor: the property as rich text; Edit shows the raw Markdown with a live preview. */
function MarkdownProperty({ data, editable }: { data: WidgetData; editable: boolean }) {
  const [value, setValue] = useState<string>(String(data.value ?? ""));
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      // someone else may have changed it since it was read: do not overwrite their version
      const now = await ontology.object(data.object_type_id, data.pk);
      const current = now.properties[data.property];
      if (String(current ?? "") !== value) {
        setValue(String(current ?? ""));
        throw new Error("The property changed since you opened it: its new value is shown — edit again.");
      }
      await actions.inlineEdit(data.object_type_id, data.pk, data.property, draft);
      setValue(draft);
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="my-2 rounded-lg border border-line p-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">
        <Icon name="pencil" className="h-3.5 w-3.5 text-ocean" />
        <Link href={objectHref(data.object_type_id, data.pk)} className="hover:underline">{data.title}</Link> · {data.label}
        {editable && draft === null && (
          <button type="button" onClick={() => setDraft(value)} className="ml-auto text-ocean hover:underline print:hidden">Edit</button>
        )}
        {draft !== null && (
          <span className="ml-auto flex gap-2 print:hidden">
            <button type="button" disabled={busy} onClick={() => void save()} className="text-ocean hover:underline">{busy ? "Saving…" : "Save to Nexus"}</button>
            <button type="button" disabled={busy} onClick={() => (setDraft(null), setError(null))} className="hover:text-white">Cancel</button>
          </span>
        )}
      </div>
      {error && <p className="mb-1 text-xs text-bad">{error}</p>}
      {draft === null ? (
        value ? <div className="prose-sm max-w-none text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} /> : <p className="text-xs text-muted">Empty</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className={`${field} font-mono`} aria-label="Raw Markdown" />
          <div className="prose-sm max-h-72 max-w-none overflow-auto rounded border border-line p-2 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }} />
        </div>
      )}
    </div>
  );
}

/** A property edited in place through its inline edit action (Notepad widgets with Allow editing). */
function InlineValue({ data, prop, label, value, raw }: { data: WidgetData; prop: string; label?: string; value: string; raw: unknown }) {
  const [shown, setShown] = useState(value);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (draft === null) return;
    try {
      const v = typeof raw === "number" ? Number(draft) : typeof raw === "boolean" ? draft === "true" : draft;
      await actions.inlineEdit(data.object_type_id, data.pk, prop, v);
      setShown(draft);
      setDraft(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (draft !== null)
    return (
      <span className="inline-flex items-center gap-1">
        {label && <span className="text-muted">{label}: </span>}
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void save() : e.key === "Escape" ? setDraft(null) : undefined)} className="rounded border border-ocean bg-panel px-1 text-sm" aria-label={prop} />
        <button type="button" onClick={() => void save()} className="text-xs text-ocean">Save</button>
        {error && <span className="text-xs text-bad">{error}</span>}
      </span>
    );
  return (
    <button type="button" onClick={() => setDraft(raw === null || raw === undefined ? "" : String(raw))} title="Edit (saved through the property's inline edit action)" className="rounded px-0.5 text-left hover:bg-ocean/10">
      {label && <span className="text-muted">{label}: </span>}
      {shown || <span className="text-muted">—</span>}
      <Icon name="pencil" className="ml-1 inline h-3 w-3 text-muted" />
    </button>
  );
}

/** Action buttons on an object card: the Ontology's action form, with the card's object. */
function CardActions({ data }: { data: WidgetData }) {
  const [open, setOpen] = useState<{ action: ActionType; type: OntologyObjectType; object: OntologyObject } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (id: string) => {
    setError(null);
    try {
      const [list, type, object] = await Promise.all([ontology.actionTypes(data.object_type_id), ontology.objectType(data.object_type_id), ontology.object(data.object_type_id, data.pk)]);
      const action = list.find((a) => a.id === id);
      if (!action) throw new Error("The action type no longer exists");
      setOpen({ action, type, object });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 print:hidden">
      {(data.actions as { id: string; display_name: string }[]).map((a) => (
        <button key={a.id} type="button" onClick={() => void start(a.id)} className="rounded border border-line-2 px-2 py-0.5 text-xs text-ocean hover:border-ocean">
          {a.display_name}
        </button>
      ))}
      {done && <span className="text-xs text-ok">{done} applied — reopen the document to see the new values</span>}
      {error && <span className="text-xs text-bad">{error}</span>}
      {open && (
        <ActionForm
          action={open.action}
          objectType={open.type}
          object={open.object}
          onClose={() => setOpen(null)}
          onDone={() => {
            setDone(open.action.display_name);
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

function CardActionsConfig({ c, inputs, set }: { c: WidgetConfig; inputs: TemplateInput[]; set: (p: WidgetConfig) => void }) {
  const [list, setList] = useState<ActionType[]>([]);
  const tid = c.object?.object_type_id ?? inputs.find((i) => i.name === c.object?.input)?.object_type_id;
  useEffect(() => {
    if (!tid) return;
    ontology.actionTypes(tid).then(setList, () => setList([]));
  }, [tid]);
  const chosen: string[] = c.actions ?? [];
  if (!tid) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted">Action buttons</div>
      {list.map((a) => (
        <label key={a.id} className="flex items-center gap-1">
          <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => set({ actions: e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id) })} />
          {a.display_name}
        </label>
      ))}
      {list.length === 0 && <p className="text-[11px] text-muted">No action types on this object type.</p>}
    </div>
  );
}

function DiagramConfig({ c, set }: { c: WidgetConfig; set: (p: WidgetConfig) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    sd.list().then((l) => setList(l.map((d) => ({ id: d.id, name: d.name }))), () => setList([]));
  }, []);
  return (
    <div className="space-y-2">
      <select value={c.diagram_id ?? ""} onChange={(e) => set({ diagram_id: e.target.value || undefined })} className={field}>
        <option value="">Solution Designer diagram…</option>
        {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <select value={String(c.height ?? 420)} onChange={(e) => set({ height: Number(e.target.value) })} className={field}>
        {[300, 420, 560, 720].map((h) => <option key={h} value={h}>Height {h}px</option>)}
      </select>
      <p className="text-[11px] text-muted">The diagram as saved, read-only. Lock the widget to keep today&apos;s version.</p>
    </div>
  );
}
