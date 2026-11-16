"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { actions, functions as fnRegistry, type FunctionRow } from "@/lib/actions";
import { API_URL } from "@/lib/api";
import { notepad as notepadApi } from "@/lib/notepad";
import { ontology, type ActionType } from "@/lib/ontology";
import {
  filterSets,
  fmt,
  resolveVar,
  sourceKey,
  workshop,
  type AnalystAnswer,
  type Column,
  type Filter,
  type FreeCard,
  type FreeformExport,
  type FreeformNotepad,
  type FreeformQuiver,
  type LinkInfo,
  type Module,
  type ObsSeries,
  type OsFilter,
  type PdfAnnotation,
  type QueryResult,
  type SavedAnalysis,
  type Sources,
  type Widget,
  type WidgetConfig,
} from "@/lib/workshop";
import { BarChart, LineChart, PieChart } from "./Charts";
import { valueOf } from "./ModuleRuntime";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

const Msg = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted">{children}</div>;
const W = `${API_URL}/api/workshop`;

/** The media a PDF / video widget shows: a static or variable Files item / media reference, else the selected
 * object's media property (the column) of the source. */
function useMediaRef(widget: Widget, state: ModuleState): { ref: string | null; reason?: string } {
  const c = widget.config;
  const fixed = c.media_ref_variable ? String(state.variables[c.media_ref_variable] ?? "") : c.media_ref ?? "";
  const pk = c.source ? state.selection[sourceKey(c.source)] : undefined;
  const [fromObj, setFromObj] = useState<string | null>(null);
  useEffect(() => {
    if (fixed || !c.source || c.source.kind !== "object_type" || !c.column || !pk) return;
    let stale = false;
    ontology.object(c.source.id, pk).then((o) => !stale && setFromObj(String(o.properties[c.column!] ?? "") || null), () => !stale && setFromObj(null));
    return () => {
      stale = true;
    };
  }, [fixed, c.source, c.column, pk]);
  if (fixed) return { ref: fixed.split("#")[0] };
  if (!c.source || !c.column) return { ref: null, reason: "Choose a file (or a variable), or a source and its media property, in the panel" };
  if (!pk) return { ref: null, reason: "Select an object" };
  return fromObj ? { ref: fromObj.split("#")[0] } : { ref: null, reason: "No media on this object" };
}

/** The passage a PDF viewer highlights: a string variable, else a property of the selected object of the source (a
 * semantic search chunk's text). */
function usePassage(widget: Widget, state: ModuleState): string {
  const c = widget.config;
  const fromVar = c.pdf_highlight_variable ? String(state.variables[c.pdf_highlight_variable] ?? "").trim() : "";
  const pk = c.source && c.pdf_highlight_prop ? state.selection[sourceKey(c.source)] : undefined;
  const [fromObj, setFromObj] = useState<{ key: string; text: string } | null>(null);
  const key = c.source && c.pdf_highlight_prop && pk ? `${c.source.id}\n${pk}\n${c.pdf_highlight_prop}` : "";
  useEffect(() => {
    if (fromVar || !key || c.source?.kind !== "object_type" || !pk) return;
    let stale = false;
    ontology.object(c.source.id, pk).then(
      (o) => !stale && setFromObj({ key, text: String(o.properties[c.pdf_highlight_prop!] ?? "").trim() }),
      () => !stale && setFromObj({ key, text: "" }),
    );
    return () => {
      stale = true;
    };
  }, [fromVar, key, c.source, c.pdf_highlight_prop, pk]);
  if (fromVar) return fromVar;
  return fromObj && fromObj.key === key ? fromObj.text : "";
}

// ------------------------------------------------------------------------------------------------
// PDF Viewer
// ------------------------------------------------------------------------------------------------

type Match = { page: number; boxes: { x: number; y: number; w: number; h: number }[] };
type Ann = { pk: string; page: number; boxes: { x1: number; y1: number; x2: number; y2: number }[]; label: string };
const parseBoxes = (v: unknown): Ann["boxes"] => {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return []; } })() : [];
  return (Array.isArray(arr) ? arr : []).map((b: unknown) => (typeof b === "string" ? (() => { try { return JSON.parse(b); } catch { return null; } })() : b)).filter((b: unknown): b is Ann["boxes"][number] => !!b && typeof b === "object" && "x1" in (b as object));
};

export function PdfViewerWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { ref, reason } = useMediaRef(widget, state);
  const [loaded, setInfo] = useState<{ ref: string; pages: number; sizes: [number, number][] } | null>(null);
  const info = loaded && loaded.ref === ref ? loaded : null;
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const initial = c.search_variable ? String(state.variables[c.search_variable] ?? "") : "";
  const [q, setQ] = useState(initial);
  const [found, setMatches] = useState<Match[]>([]);
  const [cur, setCur] = useState(0);
  const matches = useMemo(() => (q.trim() ? found : []), [q, found]);
  const [anns, setAnns] = useState<Ann[]>([]);
  const [drag, setDrag] = useState<{ page: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [pick, setPick] = useState<{ page: number; box: Ann["boxes"][number] } | null>(null);
  const pages = useRef<(HTMLDivElement | null)[]>([]);
  const a: PdfAnnotation | undefined = c.pdf_annotation?.object_type_id ? c.pdf_annotation : undefined;
  const linkValue = a?.link_value ? valueOf(a.link_value, state.variables) : undefined;
  useEffect(() => {
    if (!ref) return;
    let stale = false;
    workshop.pdfInfo(ref).then((x) => !stale && (setInfo({ ref, ...x }), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [ref]);
  // a search term from a variable runs as soon as it changes
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setQ(initial);
  }
  useEffect(() => {
    if (!ref || !q.trim()) return;
    let stale = false;
    const t = setTimeout(() => workshop.pdfSearch(ref, q).then((m) => !stale && (setMatches(m), setCur(0)), () => !stale && setMatches([])), 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [ref, q]);
  // scroll to the current match, or to the page variable's page
  const pageVar = c.page_variable ? Number(state.variables[c.page_variable] ?? 0) || 0 : null;
  useEffect(() => {
    const m = matches[cur];
    if (m) pages.current[m.page]?.scrollIntoView({ block: "start" });
  }, [matches, cur]);
  useEffect(() => {
    if (pageVar !== null && pageVar >= 1) pages.current[pageVar - 1]?.scrollIntoView({ block: "start" });
  }, [pageVar, info]);
  useEffect(() => {
    if (!a) return;
    let stale = false;
    workshop
      .query({ source: { kind: "object_type", id: a.object_type_id }, filters: a.link_prop && linkValue !== undefined ? [{ column: a.link_prop, op: "eq", value: linkValue }] : [], columns: [a.page_prop, a.boxes_prop, ...(a.label ? [a.label] : [])], limit: 1000 })
      .then((r) => !stale && setAnns((r.rows ?? []).map((x) => ({ pk: String(x.__pk), page: Number(x[a.page_prop]) || 0, boxes: parseBoxes(x[a.boxes_prop]), label: a.label ? fmt(x[a.label]) : "" }))), () => !stale && setAnns([]));
    return () => {
      stale = true;
    };
  }, [a, linkValue, state.version]);
  // the passage to highlight: a semantic search chunk (a property of the selected object) or a string variable
  const passage = usePassage(widget, state);
  const [located, setLocated] = useState<{ key: string; pages: Match[]; matched: number } | null>(null);
  const passageKey = ref && passage ? `${ref}\n${passage}` : "";
  const chunk = located && located.key === passageKey ? located : null;
  useEffect(() => {
    if (!ref || !passage) return;
    let stale = false;
    const key = `${ref}\n${passage}`;
    workshop.pdfLocate(ref, passage).then((r) => !stale && setLocated({ key, pages: r.pages, matched: r.matched }), () => !stale && setLocated({ key, pages: [], matched: 0 }));
    return () => {
      stale = true;
    };
  }, [ref, passage]);
  // scroll the viewer (only the viewer, not the module page) so the passage's first line is near the top
  const scroller = useRef<HTMLDivElement>(null);
  const toPassage = (m: Match | undefined) => {
    const el = m ? pages.current[m.page] : null;
    const box = scroller.current;
    if (!m || !el || !box) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + (m.boxes[0]?.y ?? 0) * el.offsetHeight;
    box.scrollTo({ top: Math.max(0, top - 24) });
  };
  useEffect(() => {
    if (info) toPassage(chunk?.pages[0]);
  }, [chunk, info]);
  if (!ref) return <Msg>{reason}</Msg>;
  if (error) return <Msg>{error}</Msg>;
  if (!info) return <Msg>Loading the PDF…</Msg>;
  const color = a?.color ?? "#e3b341";
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!c.page_variable) return;
    const top = e.currentTarget.scrollTop;
    const i = pages.current.findIndex((p) => p && p.offsetTop + p.offsetHeight > top + 40);
    if (i >= 0 && i + 1 !== pageVar) state.setVariable(c.page_variable, i + 1);
  };
  const create = async () => {
    if (!pick || !a?.create_action) return;
    const params: Record<string, unknown> = {};
    if (a.page_param) params[a.page_param] = pick.page;
    if (a.boxes_param) params[a.boxes_param] = [JSON.stringify(pick.box)];
    if (a.link_param && linkValue !== undefined) params[a.link_param] = linkValue;
    try {
      await actions.apply(a.create_action, params);
      setPick(null);
      state.bump();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex h-full flex-col text-xs" data-pdf={ref}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
        <Icon name="search" className="h-3.5 w-3.5 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the document" className={`${fieldClass} w-40 text-xs`} data-pdf-search />
        {q && (
          <span className="text-muted" data-pdf-hits>
            {matches.length ? `${cur + 1} / ${matches.length}` : "0 matches"}
          </span>
        )}
        <button type="button" disabled={!matches.length} onClick={() => setCur((cur - 1 + matches.length) % matches.length)} className="text-muted hover:text-white disabled:opacity-30">
          ↑
        </button>
        <button type="button" disabled={!matches.length} onClick={() => setCur((cur + 1) % matches.length)} className="text-muted hover:text-white disabled:opacity-30">
          ↓
        </button>
        {passage && (
          <button
            type="button"
            disabled={!chunk?.pages.length}
            onClick={() => toPassage(chunk?.pages[0])}
            title={passage.slice(0, 300)}
            className="rounded border border-[#f0883e]/60 px-1.5 text-[11px] text-[#f0883e] disabled:opacity-60"
            data-pdf-passage={chunk ? (chunk.pages.length ? chunk.pages.map((p) => p.page + 1).join(",") : "none") : "loading"}
          >
            {!chunk ? "Finding the passage…" : chunk.pages.length ? `Passage · page ${chunk.pages.map((p) => p.page + 1).join("–")}${chunk.matched < 1 ? ` (${Math.round(chunk.matched * 100)}%)` : ""}` : "Passage not in the text layer"}
          </button>
        )}
        <span className="ml-auto text-muted">{info.pages} pages</span>
        <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="px-1 text-muted hover:text-white">
          −
        </button>
        <span className="w-9 text-center text-muted">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="px-1 text-muted hover:text-white">
          +
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-ink p-3" onScroll={onScroll}>
        {info.sizes.map(([w, h], n) => (
          <div
            key={n}
            ref={(el) => {
              pages.current[n] = el;
            }}
            className="relative mx-auto mb-3 bg-white shadow"
            style={{ width: `${zoom * 100}%`, maxWidth: zoom * 900, aspectRatio: `${w} / ${h}` }}
            onPointerDown={(e) => {
              if (!a?.create_action || editing || state.readOnly) return;
              const r = e.currentTarget.getBoundingClientRect();
              const x = (e.clientX - r.left) / r.width;
              const y = (e.clientY - r.top) / r.height;
              setDrag({ page: n, x0: x, y0: y, x1: x, y1: y });
            }}
            onPointerMove={(e) => {
              if (!drag || drag.page !== n) return;
              const r = e.currentTarget.getBoundingClientRect();
              setDrag({ ...drag, x1: (e.clientX - r.left) / r.width, y1: (e.clientY - r.top) / r.height });
            }}
            onPointerUp={() => {
              if (!drag) return;
              const box = { x1: Math.min(drag.x0, drag.x1), y1: Math.min(drag.y0, drag.y1), x2: Math.max(drag.x0, drag.x1), y2: Math.max(drag.y0, drag.y1) };
              setDrag(null);
              if (box.x2 - box.x1 > 0.01 && box.y2 - box.y1 > 0.005) setPick({ page: n, box });
            }}
            data-pdf-page={n}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${W}/pdf/${ref}/page/${n}?scale=${zoom > 1.25 ? 2 : 1.5}`} alt={`Page ${n + 1}`} loading="lazy" className="pointer-events-none h-full w-full select-none" />
            {(chunk?.pages ?? [])
              .filter((m) => m.page === n)
              .flatMap((m) =>
                m.boxes.map((b, j) => (
                  <span key={`chunk-${j}`} className="pointer-events-none absolute rounded-sm" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, background: "rgba(240,136,62,.32)", boxShadow: "inset 0 -2px 0 rgba(240,136,62,.9)" }} data-pdf-chunk-box />
                )),
              )}
            {matches.flatMap((m, i) =>
              m.page === n
                ? m.boxes.map((b, j) => (
                    <span key={`${i}-${j}`} className="pointer-events-none absolute rounded-sm" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, background: i === cur ? "rgba(63,185,80,.45)" : "rgba(163,113,247,.35)" }} data-pdf-hit={i === cur ? "current" : "other"} />
                  ))
                : [],
            )}
            {anns.filter((x) => x.page === n).flatMap((x) =>
              x.boxes.map((b, j) => (
                <button
                  key={`${x.pk}-${j}`}
                  type="button"
                  title={x.label || x.pk}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    state.select(sourceKey({ kind: "object_type", id: a!.object_type_id }), x.pk);
                    if (a!.on_select?.length) void state.runEvents?.(a!.on_select);
                  }}
                  className="absolute rounded-sm border"
                  style={{ left: `${b.x1 * 100}%`, top: `${b.y1 * 100}%`, width: `${(b.x2 - b.x1) * 100}%`, height: `${(b.y2 - b.y1) * 100}%`, background: `color-mix(in srgb, ${color} 35%, transparent)`, borderColor: color }}
                  data-pdf-annotation={x.pk}
                />
              )),
            )}
            {drag && drag.page === n && (
              <span className="pointer-events-none absolute border-2 border-dashed border-ocean bg-ocean/10" style={{ left: `${Math.min(drag.x0, drag.x1) * 100}%`, top: `${Math.min(drag.y0, drag.y1) * 100}%`, width: `${Math.abs(drag.x1 - drag.x0) * 100}%`, height: `${Math.abs(drag.y1 - drag.y0) * 100}%` }} />
            )}
            <span className="absolute bottom-1 right-2 rounded bg-black/50 px-1 text-[10px] text-white">{n + 1}</span>
          </div>
        ))}
      </div>
      {pick && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-2 py-1">
          <span className="text-muted">Area on page {pick.page + 1}</span>
          <button type="button" onClick={create} className="ml-auto rounded bg-ocean px-2 py-0.5 text-white">
            Annotate
          </button>
          <button type="button" onClick={() => setPick(null)} className="text-muted">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Video Display
// ------------------------------------------------------------------------------------------------

export function VideoWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const { ref, reason } = useMediaRef(widget, state);
  const video = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [sceneData, setScenes] = useState<{ key: string; times: number[] } | null>(null);
  const sceneKey = `${ref}:${c.sensitivity ?? "standard"}`;
  const scenes = sceneData && sceneData.key === sceneKey ? sceneData.times : null;
  const seek = c.seek_variable ? Number(state.variables[c.seek_variable]) : NaN;
  useEffect(() => {
    if (!ref) return;
    workshop.videoInfo(ref).then((x) => setDuration(x.duration), () => setDuration(null));
  }, [ref]);
  useEffect(() => {
    if (!ref || c.frames !== "advanced") return;
    const key = `${ref}:${c.sensitivity ?? "standard"}`;
    workshop.videoScenes(ref, c.sensitivity ?? "standard").then((times) => setScenes({ key, times }), () => setScenes({ key, times: [] }));
  }, [ref, c.frames, c.sensitivity]);
  useEffect(() => {
    const v = video.current;
    if (!v || !Number.isFinite(seek)) return;
    v.currentTime = Math.max(0, Math.min(seek, v.duration || seek));
  }, [seek]);
  const frames = useMemo(() => {
    if (!c.frames || c.frames === "none") return [];
    if (c.frames === "custom") return (Array.isArray(state.variables[c.frames_variable ?? ""]) ? (state.variables[c.frames_variable ?? ""] as unknown[]) : []).map(Number).filter(Number.isFinite);
    if (c.frames === "advanced") return scenes ?? [];
    const every = Number(c.frames);
    if (!duration) return [];
    const out: number[] = [];
    for (let t = 0; t < duration && out.length < 120; t += every) out.push(t);
    return out;
  }, [c.frames, c.frames_variable, state.variables, scenes, duration]);
  if (!ref) return <Msg>{reason}</Msg>;
  return (
    <div className="flex h-full flex-col bg-ink" data-video={ref}>
      <video ref={video} src={`${W}/video/${ref}/content`} controls className="min-h-0 w-full flex-1 bg-black" data-video-player />
      {frames.length > 0 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-line p-1" data-video-frames>
          {frames.map((t) => (
            <button key={t} type="button" onClick={() => video.current && (video.current.currentTime = t)} className="shrink-0 text-center text-[9px] text-muted hover:text-white" title={`${t.toFixed(1)} s`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${W}/video/${ref}/frame?t=${t}`} alt="" loading="lazy" className="h-12 rounded" />
              {t.toFixed(t % 1 ? 1 : 0)}s
            </button>
          ))}
        </div>
      )}
      {c.frames === "advanced" && !scenes && <div className="p-1 text-[10px] text-muted">Finding scene changes…</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Observability Chart
// ------------------------------------------------------------------------------------------------

export function ObservabilityWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const start = c.start_variable ? state.variables[c.start_variable] : undefined;
  const end = c.end_variable ? state.variables[c.end_variable] : undefined;
  const iso = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : new Date(String(v)).toISOString());
  const [data, setData] = useState<ObsSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null);
  const [big, setBig] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!c.obs_kind || !c.obs_id) return;
    let stale = false;
    workshop.observability(c.obs_kind, c.obs_id, c.obs_metric ?? "executions", iso(start), iso(end)).then((x) => !stale && (setData(x), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [c.obs_kind, c.obs_id, c.obs_metric, start, end, state.version]);
  if (!c.obs_kind || !c.obs_id) return <Msg>Choose a function or an action type in the panel</Msg>;
  if (error) return <Msg>{error.includes("not found") ? "The resource cannot be found" : error}</Msg>;
  if (!data) return <Msg>Loading…</Msg>;
  const s = data.series;
  const p95 = (c.obs_metric ?? "executions") === "p95";
  const max = Math.max(1, ...s.map((x) => (p95 ? x.p95 ?? 0 : x.succeeded + x.failed)));
  const total = s.reduce((n, x) => n + x.succeeded + x.failed, 0);
  const fail = s.reduce((n, x) => n + x.failed, 0);
  const pct = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const commit = () => {
    if (!brush || !c.start_variable || !c.end_variable || Math.abs(brush.b - brush.a) < 0.02) return setBrush(null);
    const t0 = Date.parse(data.start);
    const t1 = Date.parse(data.end);
    const at = (f: number) => new Date(t0 + (t1 - t0) * f).toISOString();
    state.setVariable(c.start_variable, at(Math.min(brush.a, brush.b)));
    state.setVariable(c.end_variable, at(Math.max(brush.a, brush.b)));
    setBrush(null);
  };
  const chart = (h: string) => (
    <div
      ref={box}
      className={`relative flex ${h} items-end gap-px border-b border-line select-none`}
      onPointerDown={(e) => setBrush({ a: pct(e), b: pct(e) })}
      onPointerMove={(e) => brush && setBrush({ ...brush, b: pct(e) })}
      onPointerUp={commit}
      data-obs-chart
    >
      {s.map((x) =>
        p95 ? (
          <div key={x.t} className="flex-1 rounded-t bg-ocean/70" style={{ height: `${((x.p95 ?? 0) / max) * 100}%` }} title={`${new Date(x.t).toLocaleString()}: p95 ${x.p95 ?? "—"} ms`} />
        ) : (
          <div key={x.t} className="flex flex-1 flex-col justify-end" style={{ height: "100%" }} title={`${new Date(x.t).toLocaleString()}: ${x.succeeded} succeeded, ${x.failed} failed`}>
            <div className="rounded-t bg-bad/80" style={{ height: `${(x.failed / max) * 100}%` }} />
            <div className="bg-ok/80" style={{ height: `${(x.succeeded / max) * 100}%` }} />
          </div>
        ),
      )}
      {brush && <span className="pointer-events-none absolute inset-y-0 bg-ocean/20" style={{ left: `${Math.min(brush.a, brush.b) * 100}%`, width: `${Math.abs(brush.b - brush.a) * 100}%` }} />}
    </div>
  );
  const body = (h: string) => (
    <div className="flex h-full flex-col gap-1 p-2 text-xs" data-observability>
      <div className="flex items-center gap-2">
        <span className="font-semibold">{data.name}</span>
        <span className="text-muted">
          {p95 ? "P95 duration (ms)" : `${total} executions${fail ? `, ${fail} failed` : ""}`} · per {data.bucket}
        </span>
        <button type="button" onClick={() => setBig(!big)} className="ml-auto text-muted hover:text-white" title="Expand">
          <Icon name="fit" className="h-3.5 w-3.5" />
        </button>
        <a href={c.obs_kind === "action" ? `/ontology/action-types/${c.obs_id}` : `/functions/${c.obs_id}`} target="_blank" rel="noreferrer" className="text-muted hover:text-white" title="Run history">
          <Icon name="history" className="h-3.5 w-3.5" />
        </a>
      </div>
      {chart(h)}
      <div className="flex justify-between text-[10px] text-muted">
        <span>{new Date(data.start).toLocaleDateString()}</span>
        {c.show_legend !== false && !p95 && (
          <span className="flex gap-2">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-ok/80" /> succeeded</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-bad/80" /> failed</span>
          </span>
        )}
        <span>{new Date(data.end).toLocaleDateString()}</span>
      </div>
    </div>
  );
  return (
    <>
      {body("min-h-0 flex-1")}
      {big && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70" onClick={() => setBig(false)}>
          <div className="h-[60vh] w-[80vw] rounded-xl border border-line bg-panel" onClick={(e) => e.stopPropagation()}>
            {body("min-h-0 flex-1")}
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// result rendering (AIP Analyst and Free-form cards)
// ------------------------------------------------------------------------------------------------

function ResultView({ chart, r, label }: { chart: string; r: QueryResult; label: string }) {
  if (chart === "metric") return <div className="py-2 text-2xl font-semibold" data-result="metric">{fmt(r.value ?? r.total)}</div>;
  if (chart === "table" || !r.groups)
    return (
      <div className="max-h-56 overflow-auto" data-result="table">
        <table className="w-full text-[11px]">
          <thead>
            <tr>
              {r.columns.slice(0, 8).map((c) => (
                <th key={c.name} className="border-b border-line px-1 text-left text-muted">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(r.rows ?? []).slice(0, 100).map((x, i) => (
              <tr key={i}>
                {r.columns.slice(0, 8).map((c) => (
                  <td key={c.name} className="border-b border-line/50 px-1">
                    {fmt(x[c.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  const data = r.groups.map((g) => ({ key: g.key, value: g.value, count: g.count }));
  return (
    <div className="h-48" data-result={chart}>
      {chart === "pie" ? <PieChart data={data} metricLabel={label} /> : chart === "line" ? <LineChart data={data} metricLabel={label} /> : <BarChart data={data} metricLabel={label} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// AIP Analyst
// ------------------------------------------------------------------------------------------------

export function AnalystWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [turns, setTurns] = useState<{ q: string; a?: AnalystAnswer; error?: string }[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);
  if (!c.source) return <Msg>Choose the object set (a source) in the panel</Msg>;
  const ask = async (q: string) => {
    if (!q.trim() || busy || editing) return;
    setBusy(true);
    setText("");
    const history = turns.flatMap((t) => [{ role: "user", content: t.q }, ...(t.a ? [{ role: "assistant", content: `${t.a.explanation} (query: ${JSON.stringify(t.a.query)})` }] : [])]);
    setTurns((x) => [...x, { q }]);
    try {
      const a = await workshop.analyst({ source: c.source!, filters: (c.filters ?? []).map((f) => ({ ...f, value: resolveVar(f.value, state.variables) })), filter_sets: filterSets(c, state.variables), question: q, history, model: c.analyst_model || undefined,
        derived: (state.derived ?? []).filter((d) => c.source?.kind === "object_type" && d.object_type_id === c.source.id && d.name && d.column).map((d) => ({ name: d.name, op: d.op, column: d.column, other_column: d.other_column, value: d.value })) });
      setTurns((x) => x.map((t, i) => (i === x.length - 1 ? { ...t, a } : t)));
    } catch (e) {
      setTurns((x) => x.map((t, i) => (i === x.length - 1 ? { ...t, error: (e as Error).message } : t)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col text-xs" data-analyst>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!turns.length && (
          <div className="space-y-1 text-muted">
            <p>Ask a question about these objects; the answer runs as a query on the data.</p>
            {(c.starters ?? []).map((s) => (
              <button key={s} type="button" onClick={() => void ask(s)} disabled={editing} className="block rounded border border-line-2 px-2 py-1 text-left text-soft hover:border-ocean" data-analyst-starter>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-1" data-analyst-turn={i}>
            <div className="ml-8 rounded-lg bg-ocean/15 p-2">{t.q}</div>
            {t.a ? (
              <div className="rounded-lg border border-line p-2">
                <p className="mb-1 text-soft" data-analyst-explanation>{t.a.explanation}</p>
                <ResultView chart={t.a.chart} r={t.a.result} label={String(t.a.query.metric ?? "count")} />
                <details className="mt-1 text-[10px] text-muted">
                  <summary className="cursor-pointer">Query</summary>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(t.a.query, null, 1)}</pre>
                </details>
              </div>
            ) : t.error ? (
              <p className="text-bad">{t.error}</p>
            ) : (
              <p className="text-muted">Analyzing…</p>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="flex shrink-0 gap-1 border-t border-line p-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void ask(text)} disabled={editing || busy} placeholder="Ask AIP Analyst…" className={`${inputClass} text-xs`} data-analyst-input />
        <button type="button" onClick={() => void ask(text)} disabled={editing || busy || !text.trim()} className="rounded bg-ocean px-2.5 text-white disabled:opacity-40">
          <Icon name="sparkle" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Free-form Analysis
// ------------------------------------------------------------------------------------------------

const CARD_LABEL: Record<FreeCard["kind"], string> = {
  filter: "Filter object set", metric: "Metric", text: "Text", table: "Object table", pivot: "Pivot table", bar: "Bar chart", pie: "Pie chart",
  line: "Line chart", heat: "Heat grid", waterfall: "Waterfall", linked: "Linked objects", selector: "Object selector",
};
const ccfg = (card: FreeCard, k: string) => (card.config[k] as string | undefined) ?? "";

function FreeCardView({ card, set, base, cols, links, state, editing }: { card: FreeCard; set: (c: Partial<FreeCard["config"]>) => void; base: { source: NonNullable<WidgetConfig["source"]>; filter_sets: OsFilter[] }; cols: Column[]; links: LinkInfo[]; state: ModuleState; editing: boolean }) {
  const k = card.kind;
  const g = ccfg(card, "group_by");
  const g2 = ccfg(card, "group_by2");
  const metric = (ccfg(card, "metric") || "count") as "count";
  const mcol = ccfg(card, "metric_column");
  const needsRows = k === "pivot" || k === "heat" || k === "table" || k === "selector";
  const body =
    k === "metric" ? { metric, metric_column: mcol || undefined, limit: 0 }
      : k === "bar" || k === "pie" || k === "line" || k === "waterfall" ? (g ? { group_by: g, metric: k === "waterfall" ? ("sum" as const) : metric, metric_column: (k === "waterfall" ? ccfg(card, "value") : mcol) || undefined, sort: k === "line" || k === "waterfall" ? "key" : undefined, limit: 100 } : null)
        : needsRows ? { columns: k === "table" ? (card.config.columns as string[] | undefined) ?? [] : [g, g2, mcol].filter(Boolean), limit: k === "table" ? 200 : 5000 }
          : null;
  const [r, setR] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([base, body, state.version]);
  useEffect(() => {
    if (!body) return;
    let stale = false;
    workshop.query({ ...base, ...body }).then((x) => !stale && (setR(x), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
    // key holds the base set, the card's query and the version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const colSel = (kk: string, empty: string) => (
    <select value={ccfg(card, kk)} onChange={(e) => set({ [kk]: e.target.value || undefined })} disabled={editing} className={`${fieldClass} text-[11px]`}>
      <option value="">{empty}</option>
      {cols.map((x) => (
        <option key={x.name}>{x.name}</option>
      ))}
    </select>
  );
  const metricSel = (
    <>
      <select value={metric} onChange={(e) => set({ metric: e.target.value })} disabled={editing} className={`${fieldClass} text-[11px]`}>
        {["count", "sum", "avg", "min", "max", "distinct"].map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      {metric !== "count" && colSel("metric_column", "of…")}
    </>
  );
  if (k === "text")
    return <textarea value={ccfg(card, "text")} onChange={(e) => set({ text: e.target.value })} rows={3} placeholder="Notes on this analysis…" className={`${inputClass} text-xs`} />;
  if (k === "filter") {
    const flt = (card.config.filters as Filter[] | undefined) ?? [];
    return (
      <div className="space-y-1">
        {flt.map((f, i) => (
          <div key={i} className="flex gap-1">
            <select value={f.column} onChange={(e) => set({ filters: flt.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })} className={`${fieldClass} text-[11px]`}>
              {cols.map((x) => (
                <option key={x.name}>{x.name}</option>
              ))}
            </select>
            <select value={f.op} onChange={(e) => set({ filters: flt.map((x, j) => (j === i ? { ...x, op: e.target.value as Filter["op"] } : x)) })} className={`${fieldClass} text-[11px]`}>
              {["eq", "neq", "gt", "gte", "lt", "lte", "contains", "is_null", "not_null"].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <input value={String(f.value ?? "")} onChange={(e) => set({ filters: flt.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`} />
            <button type="button" onClick={() => set({ filters: flt.filter((_, j) => j !== i) })} className="px-1 text-muted">
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => set({ filters: [...flt, { column: cols[0]?.name ?? "", op: "eq", value: "" }] })} className="text-[11px] text-ocean">
          + Condition
        </button>
      </div>
    );
  }
  if (k === "linked") {
    const sel = ccfg(card, "link");
    return (
      <div className="flex flex-wrap items-center gap-1">
        <select value={sel} onChange={(e) => set({ link: e.target.value || undefined })} className={`${fieldClass} text-[11px]`}>
          <option value="">Link…</option>
          {links.map((l) => (
            <option key={l.link_type_id + l.direction} value={`${l.link_type_id}:${l.direction}`}>
              {l.name} ({l.target_name})
            </option>
          ))}
        </select>
        {sel && <span className="text-muted">Following cards keep only objects with this link.</span>}
      </div>
    );
  }
  const head = (
    <div className="mb-1 flex flex-wrap items-center gap-1">
      {(k === "bar" || k === "pie" || k === "line" || k === "waterfall" || k === "pivot" || k === "heat") && colSel("group_by", k === "line" ? "X (date)…" : "Group by…")}
      {(k === "pivot" || k === "heat") && colSel("group_by2", "Columns by…")}
      {k === "waterfall" ? colSel("value", "Value…") : k !== "table" && k !== "selector" && metricSel}
      {k === "table" && (
        <select multiple value={(card.config.columns as string[] | undefined) ?? []} onChange={(e) => set({ columns: [...e.target.selectedOptions].map((o) => o.value) })} className={`${fieldClass} h-16 text-[11px]`}>
          {cols.map((x) => (
            <option key={x.name}>{x.name}</option>
          ))}
        </select>
      )}
      {k === "selector" && colSel("title", "Title property…")}
    </div>
  );
  if (error) return <>{head}<p className="text-bad">{error}</p></>;
  if (!body || !r) return <>{head}<p className="text-muted">{body ? "Loading…" : "Choose the properties"}</p></>;
  if (k === "metric") return <>{head}<div className="text-2xl font-semibold" data-card-metric>{fmt(r.value)}</div></>;
  if (k === "bar" || k === "pie" || k === "line") return <>{head}<ResultView chart={k} r={r} label={metric} /></>;
  if (k === "waterfall") {
    const steps = waterfallSteps(r.groups ?? []);
    const lo = Math.min(0, ...steps.map((s) => Math.min(s.from, s.to)));
    const hi = Math.max(1, ...steps.map((s) => Math.max(s.from, s.to)));
    return (
      <>
        {head}
        <div className="flex h-40 items-stretch gap-1" data-card-waterfall>
          {steps.map((s) => (
            <div key={String(s.key)} className="relative flex-1" title={`${fmt(s.key)}: ${fmt(s.to - s.from)} (running ${fmt(s.to)})`}>
              <span className={`absolute inset-x-0 rounded-sm ${s.to >= s.from ? "bg-ok/70" : "bg-bad/70"}`} style={{ bottom: `${((Math.min(s.from, s.to) - lo) / (hi - lo)) * 100}%`, height: `max(2px, ${(Math.abs(s.to - s.from) / (hi - lo)) * 100}%)` }} />
              <span className="absolute -bottom-4 left-0 right-0 truncate text-center text-[9px] text-muted">{fmt(s.key)}</span>
            </div>
          ))}
        </div>
        <div className="h-4" />
      </>
    );
  }
  if (k === "pivot" || k === "heat") {
    // client-side two-way aggregation over the rows
    const rows = r.rows ?? [];
    const keysA = [...new Set(rows.map((x) => fmt(x[g])))].slice(0, 30);
    const keysB = g2 ? [...new Set(rows.map((x) => fmt(x[g2])))].slice(0, 12) : ["Total"];
    const cell = (a: string, b: string) => {
      const sel = rows.filter((x) => fmt(x[g]) === a && (!g2 || fmt(x[g2]) === b));
      if (metric === "count") return sel.length;
      const nums = sel.map((x) => Number(x[mcol])).filter(Number.isFinite);
      if (!nums.length) return null;
      return metric === "sum" ? nums.reduce((p, q) => p + q, 0) : metric === "avg" ? nums.reduce((p, q) => p + q, 0) / nums.length : metric === "min" ? Math.min(...nums) : metric === "max" ? Math.max(...nums) : new Set(nums).size;
    };
    const vals = keysA.flatMap((a) => keysB.map((b) => cell(a, b) ?? 0));
    const top = Math.max(1, ...vals);
    return (
      <>
        {head}
        {!g ? (
          <p className="text-muted">Choose the rows</p>
        ) : (
          <div className="max-h-56 overflow-auto" data-card-pivot={k}>
            <table className="text-[11px]">
              <thead>
                <tr>
                  <th />
                  {keysB.map((b) => (
                    <th key={b} className="px-1 text-muted">
                      {b}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keysA.map((a) => (
                  <tr key={a}>
                    <td className="pr-2 text-muted">{a}</td>
                    {keysB.map((b) => {
                      const v = cell(a, b);
                      return (
                        <td key={b} className="px-1 text-right" style={k === "heat" ? { background: `color-mix(in srgb, #1f6feb ${Math.round(((v ?? 0) / top) * 80)}%, transparent)` } : undefined}>
                          {fmt(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }
  if (k === "selector") {
    const pinned = ccfg(card, "pk");
    return (
      <>
        {head}
        <select
          value={pinned}
          onChange={(e) => {
            set({ pk: e.target.value || undefined });
            if (e.target.value) state.select(sourceKey(base.source), e.target.value);
          }}
          className={`${fieldClass} w-full text-[11px]`}
          data-card-selector
        >
          <option value="">Pin an object…</option>
          {(r.rows ?? []).slice(0, 300).map((x) => (
            <option key={String(x.__pk)} value={String(x.__pk)}>
              {ccfg(card, "title") ? fmt(x[ccfg(card, "title")]) : String(x.__pk)}
            </option>
          ))}
        </select>
      </>
    );
  }
  return (
    <>
      {head}
      <ResultView chart="table" r={r} label="" />
    </>
  );
}

/** Running totals: each group's step from the total before it to the total after it. */
function waterfallSteps(groups: { key: unknown; value: number | null }[]): { key: unknown; from: number; to: number }[] {
  const out: { key: unknown; from: number; to: number }[] = [];
  for (const g of groups) {
    const from = out.length ? out[out.length - 1].to : 0;
    out.push({ key: g.key, from, to: from + (g.value ?? 0) });
  }
  return out;
}

/** A Quiver analysis' time range in words: all time, the last …, or its bounds (days). */
const quiverRange = (r: NonNullable<FreeformQuiver["range"]>) =>
  r.last ? `last ${r.last}` : r.start || r.end ? `${r.start?.slice(0, 10) ?? "…"} → ${r.end?.slice(0, 10) ?? "…"}` : "all time";

export function FreeformWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [cards, setCards] = useState<FreeCard[]>([]);
  const [saved, setSaved] = useState<SavedAnalysis[]>([]);
  const [cur, setCur] = useState<SavedAnalysis | null>(null);
  const [name, setName] = useState("");
  const [vis, setVis] = useState<"private" | "public">("private");
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const [exported, setExported] = useState<{ busy?: boolean; error?: string; quiver?: FreeformQuiver; notepad?: FreeformNotepad } | null>(null);
  const [copying, setCopying] = useState(false);
  const cols = useCols(c.source, state.version);
  const mid = state.moduleId;
  useEffect(() => {
    if (!c.path_saving || !mid) return;
    workshop.analyses(mid, widget.id).then(setSaved, () => setSaved([]));
  }, [c.path_saving, mid, widget.id]);
  useEffect(() => {
    if (c.source?.kind === "object_type") workshop.links(c.source.id).then(setLinks, () => setLinks([]));
  }, [c.source]);
  // each card sees the object set after the filter and link cards before it
  const bases = useMemo(() => {
    if (!c.source) return [];
    const sets = filterSets(c, state.variables);
    const own = (c.filters ?? []).map((f) => ({ ...f, value: resolveVar(f.value, state.variables) }));
    const out: { source: NonNullable<WidgetConfig["source"]>; filter_sets: OsFilter[]; filters: Filter[] }[] = [];
    const acc: Filter[] = [];
    for (const card of cards) {
      out.push({ source: c.source, filters: own, filter_sets: acc.length ? [...sets, { filters: [...acc], mode: "all" }] : sets });
      if (card.kind === "filter") acc.push(...(((card.config.filters as Filter[] | undefined) ?? []).filter((f) => f.column && (f.op === "is_null" || f.op === "not_null" || f.value !== ""))));
      if (card.kind === "linked" && card.config.link) {
        const [id, dir] = String(card.config.link).split(":");
        acc.push({ column: "__link", op: "eq", value: { link_type_id: id, direction: dir, filters: [] } });
      }
    }
    return out;
  }, [c, cards, state.variables]);
  // the output: the path's filters as an object set filter variable
  const outFilters = JSON.stringify(cards.flatMap((x) => (x.kind === "filter" ? ((x.config.filters as Filter[] | undefined) ?? []) : [])));
  useEffect(() => {
    if (c.filter_output) state.setVariable(c.filter_output, { filters: JSON.parse(outFilters), mode: "all" });
    // only when the path's filters change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outFilters, c.filter_output]);
  if (!c.source) return <Msg>Choose the input object set (a source) in the panel</Msg>;
  const setCard = (i: number, x: Partial<FreeCard["config"]>) => setCards((cs) => cs.map((cc, j) => (j === i ? { ...cc, config: { ...cc.config, ...x } } : cc)));
  const save = async () => {
    if (!mid || !name.trim()) return;
    try {
      const rec = await workshop.saveAnalysis(mid, widget.id, { id: cur?.id, name: name.trim(), visibility: vis, cards });
      setCur(rec);
      setSaved((xs) => [...xs.filter((x) => x.id !== rec.id), rec]);
      setNote("Saved");
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  // Open in Quiver / Copy to Notepad: the path as it is now, over the widget's input object set
  const exportBody = (): FreeformExport => ({
    name: cur?.name || name.trim() || widget.title || "Free-form analysis",
    source: c.source!,
    filters: (c.filters ?? []).map((f) => ({ ...f, value: resolveVar(f.value, state.variables) })),
    filter_sets: filterSets(c, state.variables),
    cards,
    module_id: mid || undefined,
  });
  const openInQuiver = async () => {
    const tab = window.open("", "_blank");
    setExported({ busy: true });
    try {
      const r = await workshop.freeformQuiver(exportBody());
      setExported({ quiver: r });
      if (tab) tab.location.href = `/quiver/${r.analysis_id}`;
    } catch (e) {
      tab?.close();
      setExported({ error: (e as Error).message });
    }
  };
  const canCopy = !!(c.path_saving && c.notepad_copy && cur);
  return (
    <div className="flex h-full flex-col text-xs" data-freeform>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        {c.path_saving && (
          <>
          <select
            value={cur?.id ?? ""}
            onChange={(e) => {
              const a = saved.find((x) => x.id === e.target.value) ?? null;
              setCur(a);
              setCards(a?.cards ?? []);
              setName(a?.name ?? "");
              setVis(a?.visibility ?? "private");
            }}
            className={`${fieldClass} text-[11px]`}
            data-freeform-open
          >
            <option value="">New analysis</option>
            {saved.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.visibility}{x.owner_name ? `, ${x.owner_name}` : ""})
              </option>
            ))}
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Analysis name" className={`${fieldClass} w-32 text-[11px]`} data-freeform-name />
          <select value={vis} onChange={(e) => setVis(e.target.value as "private")} className={`${fieldClass} text-[11px]`}>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
          <button type="button" disabled={editing || !name.trim()} onClick={save} className="text-ocean disabled:opacity-40" data-freeform-save>
            Save
          </button>
          {note && <span className="text-muted">{note}</span>}
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          {c.path_saving && c.notepad_copy && (
            <button
              type="button"
              disabled={editing || !canCopy || !cards.length}
              onClick={() => setCopying(!copying)}
              title={canCopy ? "Copy cards of this analysis to a Notepad document" : "Save the analysis (or open a saved one) to copy its cards to Notepad"}
              className="flex items-center gap-1 text-soft hover:text-white disabled:opacity-40"
              data-freeform-notepad
            >
              <Icon name="doc" className="h-3 w-3" /> Copy to Notepad
            </button>
          )}
          <button type="button" disabled={editing || !cards.length || exported?.busy} onClick={() => void openInQuiver()} className="flex items-center gap-1 text-soft hover:text-white disabled:opacity-40" data-freeform-quiver>
            <Icon name="wave" className="h-3 w-3" /> {exported?.busy ? "Opening…" : "Open in Quiver"}
          </button>
        </span>
      </div>
      {exported && !exported.busy && (
        <div className="shrink-0 border-b border-line bg-panel-2/40 px-2 py-1" data-freeform-exported>
          <div className="flex items-center gap-2">
            {exported.error ? (
              <span className="text-bad">{exported.error}</span>
            ) : exported.quiver ? (
              <a href={`/quiver/${exported.quiver.analysis_id}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline" data-freeform-quiver-link>
                Opened “{exported.quiver.name}” in Quiver
                {exported.quiver.range && (
                  // the widget has no time range: the analysis gets the path's time filter bounds, else all time
                  <span className="text-muted" data-freeform-quiver-range>
                    {" "}
                    (time range: {quiverRange(exported.quiver.range)})
                  </span>
                )}
              </a>
            ) : exported.notepad ? (
              <a href={`/notepad/${exported.notepad.item.id}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline" data-freeform-notepad-link>
                {exported.notepad.added.length} card{exported.notepad.added.length === 1 ? "" : "s"} copied to {exported.notepad.item.name.replace(/\.notepad$/, "")}
              </a>
            ) : null}
            <button type="button" onClick={() => setExported(null)} className="ml-auto text-muted hover:text-white" aria-label="Dismiss">
              ✕
            </button>
          </div>
          {(() => {
            const notes = exported.quiver?.notes ?? (exported.notepad ? [...exported.notepad.skipped.map((x) => `${x}: not set up`), ...exported.notepad.notes] : []);
            return notes.length > 0 ? (
              <ul className="mt-0.5 list-disc pl-4 text-[11px] text-muted" data-freeform-export-notes>
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null;
          })()}
        </div>
      )}
      {copying && canCopy && <NotepadCopy cards={cards} name={cur?.name ?? name} onDone={(r) => (setCopying(false), setExported({ notepad: r }))} run={(x) => workshop.freeformNotepad({ ...exportBody(), ...x })} />}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {!cards.length && (
          <div className="py-6 text-center text-muted">
            <div className="font-semibold text-soft">{c.empty_title || "Start an analysis"}</div>
            <div>{c.empty_message || "Add cards: each one works on the objects left by the filters above it."}</div>
          </div>
        )}
        {cards.map((card, i) => (
          <div key={card.id} className="rounded-lg border border-line p-2" data-free-card={card.kind}>
            <div className="mb-1 flex items-center gap-2">
              <span className="font-semibold">{CARD_LABEL[card.kind]}</span>
              <button type="button" onClick={() => setCards((cs) => cs.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
                ✕
              </button>
            </div>
            <FreeCardView card={card} set={(x) => setCard(i, x)} base={bases[i]} cols={cols} links={links} state={state} editing={editing} />
          </div>
        ))}
        <div className="relative">
          <button type="button" disabled={editing} onClick={() => setAdding(!adding)} className="rounded border border-dashed border-line-2 px-2 py-1 text-muted hover:text-white disabled:opacity-40" data-freeform-add>
            + Add card
          </button>
          {adding && (
            <div className="absolute left-0 top-full z-20 mt-1 grid w-72 grid-cols-2 gap-1 rounded-lg border border-line-2 bg-panel p-2 shadow-xl">
              {(Object.keys(CARD_LABEL) as FreeCard["kind"][]).map((k) => (
                <button key={k} type="button" onClick={() => (setCards((cs) => [...cs, { id: `c${Date.now().toString(36)}${cs.length}`, kind: k, config: k === "filter" ? { filters: [] } : {} }]), setAdding(false))} className="rounded px-2 py-1 text-left hover:bg-panel-2" data-add-card={k}>
                  {CARD_LABEL[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Copy to Notepad: which cards (charts, tables, metrics, text) and where — a new document or an existing one. */
function NotepadCopy({ cards, name, run, onDone }: { cards: FreeCard[]; name: string; run: (x: { card_ids: string[]; document_id?: string; document_name?: string }) => Promise<FreeformNotepad>; onDone: (r: FreeformNotepad) => void }) {
  const shown = cards.filter((x) => x.kind !== "filter" && x.kind !== "linked");
  const [pick, setPick] = useState<string[]>(shown.map((x) => x.id));
  const [docs, setDocs] = useState<{ id: string; name: string }[]>([]);
  const [target, setTarget] = useState("");
  const [docName, setDocName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    notepadApi.documents().then((d) => setDocs(d.map((x) => ({ id: x.id, name: x.name.replace(/\.notepad$/, "") }))), () => setDocs([]));
  }, []);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await run({ card_ids: pick, ...(target ? { document_id: target } : { document_name: docName.trim() || name }) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 space-y-1 border-b border-line bg-panel-2/40 px-2 py-1.5" data-freeform-notepad-panel>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {shown.map((x, i) => (
          <label key={x.id} className="flex items-center gap-1">
            <input type="checkbox" checked={pick.includes(x.id)} onChange={(e) => setPick((p) => (e.target.checked ? [...p, x.id] : p.filter((y) => y !== x.id)))} data-notepad-card={x.id} />
            {CARD_LABEL[x.kind]} {i + 1}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <select value={target} onChange={(e) => setTarget(e.target.value)} className={`${fieldClass} text-[11px]`} data-notepad-target>
          <option value="">New document</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {!target && <input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="Document name" className={`${fieldClass} w-40 text-[11px]`} data-notepad-name />}
        <button type="button" disabled={busy || !pick.length} onClick={() => void go()} className="rounded bg-ocean px-2 py-0.5 text-white disabled:opacity-40" data-notepad-copy>
          {busy ? "Copying…" : "Copy"}
        </button>
        {error && <span className="text-bad">{error}</span>}
      </div>
    </div>
  );
}

function useCols(source: WidgetConfig["source"], version: number): Column[] {
  const [cols, setCols] = useState<Column[]>([]);
  useEffect(() => {
    if (!source) return;
    workshop.query({ source, limit: 1 }).then((r) => setCols(r.columns), () => setCols([]));
  }, [source, version]);
  return cols;
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

export const MEDIA_TYPES = new Set(["pdf_viewer", "video_display", "observability", "freeform", "aip_analyst"]);

export function MediaWidgetConfig({ widget, set, mod, cols, sources }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[]; sources: Sources }) {
  const c = widget.config;
  const t = widget.type;
  const vars = mod.variables ?? [];
  const [fns, setFns] = useState<FunctionRow[]>([]);
  const [acts, setActs] = useState<ActionType[]>([]);
  useEffect(() => {
    if (t === "observability") {
      fnRegistry.list().then(setFns, () => {});
      ontology.actionTypes().then(setActs, () => {});
    }
  }, [t]);
  const varSel = (value: string | undefined, onChange: (v: string | undefined) => void, types: string[], empty = "None") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{empty}</option>
      {vars.filter((v) => types.includes(v.type)).map((v) => (
        <option key={v.name}>{v.name}</option>
      ))}
    </select>
  );
  const mediaFields = (
    <>
      <Field label="File (a Files item ID or media reference)">
        <input value={c.media_ref ?? ""} onChange={(e) => set({ media_ref: e.target.value || undefined })} className={inputClass} />
      </Field>
      <Field label="…or from a string variable">{varSel(c.media_ref_variable, (v) => set({ media_ref_variable: v }), ["string"])}</Field>
      <Field label="…or the selected object's media property (of the source)">
        <select value={c.column ?? ""} onChange={(e) => set({ column: e.target.value || undefined })} className={inputClass}>
          <option value="">None</option>
          {cols.map((x) => (
            <option key={x.name}>{x.name}</option>
          ))}
        </select>
      </Field>
    </>
  );
  if (t === "pdf_viewer") {
    const a = c.pdf_annotation;
    const setA = (x: Partial<PdfAnnotation>) => set({ pdf_annotation: { ...(a ?? { object_type_id: "", page_prop: "", boxes_prop: "" }), ...x } });
    const aType = sources.object_types.find((x) => x.id === a?.object_type_id);
    return (
      <div className="space-y-3">
        {mediaFields}
        <Field label="Page number variable (a number; both ways)">{varSel(c.page_variable, (v) => set({ page_variable: v }), ["number"])}</Field>
        <Field label="Initial search from a string variable">{varSel(c.search_variable, (v) => set({ search_variable: v }), ["string"])}</Field>
        <Field label="Highlight a passage: the selected object's text property (a semantic search chunk)">
          <select value={c.pdf_highlight_prop ?? ""} onChange={(e) => set({ pdf_highlight_prop: e.target.value || undefined })} className={inputClass} data-pdf-highlight-prop>
            <option value="">None</option>
            {cols.map((x) => (
              <option key={x.name}>{x.name}</option>
            ))}
          </select>
        </Field>
        <Field label="…or the passage from a string variable">{varSel(c.pdf_highlight_variable, (v) => set({ pdf_highlight_variable: v }), ["string"])}</Field>
        <details className="rounded border border-line p-2 text-xs" open={!!a?.object_type_id}>
          <summary className="cursor-pointer text-soft">Annotations</summary>
          <div className="mt-2 space-y-1">
            <select value={a?.object_type_id ?? ""} onChange={(e) => (e.target.value ? setA({ object_type_id: e.target.value }) : set({ pdf_annotation: undefined }))} className={`${fieldClass} w-full text-xs`}>
              <option value="">No annotations</option>
              {sources.object_types.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            {a?.object_type_id && (
              <>
                <div className="grid grid-cols-2 gap-1">
                  {(["page_prop", "boxes_prop", "label", "link_prop"] as const).map((k) => (
                    <select key={k} value={(a[k] as string | undefined) ?? ""} onChange={(e) => setA({ [k]: e.target.value || undefined })} className={`${fieldClass} text-xs`}>
                      <option value="">{{ page_prop: "Page property…", boxes_prop: "Bounding boxes property…", label: "Tooltip property…", link_prop: "Link property…" }[k]}</option>
                      {(aType?.properties ?? []).map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
                {a.link_prop && <input value={a.link_value ?? ""} onChange={(e) => setA({ link_value: e.target.value || undefined })} placeholder="link value ($var:name)" className={`${fieldClass} w-full text-xs`} />}
                <input value={a.create_action ?? ""} onChange={(e) => setA({ create_action: e.target.value || undefined })} placeholder="create action type ID (area selections)" className={`${fieldClass} w-full text-xs`} />
                {a.create_action && (
                  <div className="grid grid-cols-3 gap-1">
                    {(["page_param", "boxes_param", "link_param"] as const).map((k) => (
                      <input key={k} value={(a[k] as string | undefined) ?? ""} onChange={(e) => setA({ [k]: e.target.value || undefined })} placeholder={k.replace("_param", "")} className={`${fieldClass} text-xs`} />
                    ))}
                  </div>
                )}
                <EventsEditor events={a.on_select ?? []} mod={mod} onChange={(ev) => setA({ on_select: ev })} label="On annotation select" />
              </>
            )}
          </div>
        </details>
      </div>
    );
  }
  if (t === "video_display")
    return (
      <div className="space-y-3">
        {mediaFields}
        <Field label="Seek to (a numeric variable, seconds)">{varSel(c.seek_variable, (v) => set({ seek_variable: v }), ["number"])}</Field>
        <Field label="Key frames">
          <select value={c.frames ?? "none"} onChange={(e) => set({ frames: e.target.value as "none" })} className={inputClass}>
            <option value="none">None</option>
            <option value="1">Every second</option>
            <option value="5">Every 5 seconds</option>
            <option value="10">Every 10 seconds</option>
            <option value="60">Every 60 seconds</option>
            <option value="custom">Custom (a numeric array variable)</option>
            <option value="advanced">Advanced (scene changes)</option>
          </select>
        </Field>
        {c.frames === "custom" && <Field label="Frame times">{varSel(c.frames_variable, (v) => set({ frames_variable: v }), ["array"])}</Field>}
        {c.frames === "advanced" && (
          <Field label="Sensitivity">
            <select value={c.sensitivity ?? "standard"} onChange={(e) => set({ sensitivity: e.target.value as "standard" })} className={inputClass}>
              <option value="less">Less sensitive</option>
              <option value="standard">Standard</option>
              <option value="more">More sensitive</option>
            </select>
          </Field>
        )}
      </div>
    );
  if (t === "observability")
    return (
      <div className="space-y-3">
        <Field label="Resource type">
          <select value={c.obs_kind ?? ""} onChange={(e) => set({ obs_kind: (e.target.value || undefined) as "action", obs_id: undefined })} className={inputClass}>
            <option value="">Choose…</option>
            <option value="function">Function</option>
            <option value="action">Action</option>
          </select>
        </Field>
        {c.obs_kind && (
          <Field label="Resource">
            <select value={c.obs_id ?? ""} onChange={(e) => set({ obs_id: e.target.value || undefined })} className={inputClass}>
              <option value="">Choose…</option>
              {c.obs_kind === "function"
                ? fns.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))
                : acts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}
                    </option>
                  ))}
            </select>
          </Field>
        )}
        <Field label="Metric">
          <select value={c.obs_metric ?? "executions"} onChange={(e) => set({ obs_metric: e.target.value as "p95" })} className={inputClass}>
            <option value="executions">Executions (succeeded and failed)</option>
            <option value="p95">P95 duration</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start time">{varSel(c.start_variable, (v) => set({ start_variable: v }), ["timestamp", "date", "string"])}</Field>
          <Field label="End time">{varSel(c.end_variable, (v) => set({ end_variable: v }), ["timestamp", "date", "string"])}</Field>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={c.show_legend !== false} onChange={(e) => set({ show_legend: e.target.checked })} /> Legend
        </label>
      </div>
    );
  if (t === "freeform")
    return (
      <div className="space-y-3">
        <Field label="Empty state header and description">
          <input value={c.empty_title ?? ""} onChange={(e) => set({ empty_title: e.target.value || undefined })} placeholder="Start an analysis" className={inputClass} />
          <input value={c.empty_message ?? ""} onChange={(e) => set({ empty_message: e.target.value || undefined })} placeholder="Description" className={`${inputClass} mt-1`} />
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.path_saving} onChange={(e) => set({ path_saving: e.target.checked })} /> Path saving (private or public analyses)
        </label>
        {c.path_saving && (
          <label className="flex items-center gap-2 pl-5 text-xs">
            <input type="checkbox" checked={!!c.notepad_copy} onChange={(e) => set({ notepad_copy: e.target.checked || undefined })} /> Enable copy for Notepad (saved analyses)
          </label>
        )}
        <Field label="Output (the path's filters, as an object set filter variable)">{varSel(c.filter_output, (v) => set({ filter_output: v }), ["object_set_filter"])}</Field>
      </div>
    );
  if (t === "aip_analyst") {
    const st = c.starters ?? [];
    return (
      <div className="space-y-3">
        <Field label="Model (empty: the default)">
          <input value={c.analyst_model ?? ""} onChange={(e) => set({ analyst_model: e.target.value || undefined })} className={inputClass} />
        </Field>
        <Field label="Starter questions">
          <div className="space-y-1">
            {st.map((x, i) => (
              <div key={i} className="flex gap-1">
                <input value={x} onChange={(e) => set({ starters: st.map((y, j) => (j === i ? e.target.value : y)) })} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                <button type="button" onClick={() => set({ starters: st.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
            ))}
            <button type="button" onClick={() => set({ starters: [...st, ""] })} className="text-xs text-ocean">
              + Question
            </button>
          </div>
        </Field>
      </div>
    );
  }
  return null;
}
