"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { driveContentUrl } from "@/lib/api";
import { cipherApi } from "@/lib/cipher";
import { Icon } from "@/components/Icon";
import { mediaKind } from "@/components/media/MediaPreview";
import { accessUrl, mediaSets, type MediaSchema } from "@/lib/mediaSets";
import { ontology, type ActionType } from "@/lib/ontology";
import { sourceKey, workshop, type Widget } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import {
  anchor,
  cellsMoved,
  cellsResized,
  clamp,
  colName,
  inCells,
  moved,
  offsetAtPoint,
  pageOf,
  parseCells,
  parseShape,
  pickAt,
  pickCells,
  quoteOf,
  resized,
  sameCells,
  selectionBoxes,
  serialize,
  spanBoxes,
  spanResized,
  toRange,
  vertexMoved,
  vertexRemoved,
  type Box,
  type Cells,
  type Rect,
  type Shape,
  type Span,
} from "./annotationGeometry";

type Tool = "rect" | "polygon" | "point" | "text" | "cells" | "select";

type SheetGesture = { kind: "draw"; r: number; c: number } | { kind: "move"; r: number; c: number; orig: Cells } | { kind: "resize"; corner: string; orig: Cells };

/** Spreadsheet Display with annotation layers: the sheets, annotated ranges highlighted. Draw mode: drag across cells to
 * select a new range. Select mode: click a range to pick it; with editing allowed, drag it to move it and its corner
 * handles to resize it. Cells under the pointer are found by position, so a touch drag (whose events all go to the cell
 * it started on) works as a mouse drag does. */
function SheetAnnotator({
  id,
  ranges,
  draft,
  onDraft,
  mode,
  selected,
  edit,
  canEdit,
  onPick,
  onEdit,
}: {
  id: string;
  ranges: { pk: string; cells: Cells; label: string }[];
  draft: Cells | null;
  onDraft: (c: Cells | null) => void;
  mode: "draw" | "select" | "none";
  selected: string | null;
  edit: Cells | null;
  canEdit: boolean;
  onPick: (pk: string | null) => void;
  onEdit: (c: Cells) => void;
}) {
  const [sheets, setSheets] = useState<Record<string, { table: (string | number | null)[][] }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const gesture = useRef<SheetGesture | null>(null);
  const table_ = useRef<HTMLTableElement | null>(null);
  useEffect(() => {
    mediaSets.access<Record<string, { table: (string | number | null)[][] }>>(id, "sheets").then(setSheets, (e: Error) => setError(e.message));
  }, [id]);
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (error) return <p className="text-bad">{error}</p>;
  if (!sheets) return <p className="text-muted">Reading the spreadsheet…</p>;
  // a range newly picked: show its sheet
  if (selected !== shownFor) {
    setShownFor(selected);
    const i = edit ? Object.keys(sheets).indexOf(edit.sheet) : -1;
    if (i >= 0 && i !== tab) setTab(i);
  }
  const names = Object.keys(sheets);
  const name = names[tab];
  const table = sheets[name]?.table ?? [];
  const rows = Math.min(500, table.length);
  const cols = Math.max(0, ...table.map((r) => r.length));
  const shownRanges = ranges.map((x) => (x.pk === selected && edit ? { ...x, cells: edit } : x));
  const inside = (x: Cells, r: number, c: number) => inCells(x, name, r, c);
  const counts = Object.fromEntries(names.map((n) => [n, ranges.filter((x) => x.cells.sheet === n).length]));
  const cellOf = (e: { clientX: number; clientY: number }) => {
    const td = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("td[data-r]");
    return td && td.closest("table") === table_.current ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : null;
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || mode === "none") return;
    const at = cellOf(e);
    if (!at) return;
    try {
      table_.current?.setPointerCapture(e.pointerId); // the release is seen even outside the table
    } catch {
      // synthetic pointers have no capture
    }
    const corner =(e.target as HTMLElement).closest<HTMLElement>("[data-cell-handle]")?.dataset.cellHandle;
    if (mode === "select") {
      if (corner && edit && canEdit) {
        gesture.current = { kind: "resize", corner, orig: edit };
        return e.preventDefault();
      }
      // the picked range keeps the pointer where it overlaps another, so it can still be dragged there
      const hit = (sel && inside(sel, at.r, at.c) ? shownRanges.find((x) => x.pk === selected) : null) ?? pickCells(shownRanges, name, at.r, at.c);
      onPick(hit?.pk ?? null);
      if (hit && canEdit) {
        gesture.current = { kind: "move", ...at, orig: hit.cells };
        e.preventDefault();
      }
      return;
    }
    gesture.current = { kind: "draw", ...at };
    onDraft({ sheet: name, r1: at.r, c1: at.c, r2: at.r, c2: at.c });
    e.preventDefault();
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const at = cellOf(e);
    if (!at) return;
    if (g.kind === "draw") onDraft({ sheet: name, r1: Math.min(g.r, at.r), c1: Math.min(g.c, at.c), r2: Math.max(g.r, at.r), c2: Math.max(g.c, at.c) });
    else if (g.kind === "move") onEdit(cellsMoved(g.orig, at.r - g.r, at.c - g.c, rows, cols));
    else onEdit(cellsResized(g.orig, g.corner, at.r, at.c));
  };
  const up = () => (gesture.current = null);
  const sel = edit && selected ? edit : null;
  const corners = sel
    ? ([
        ["nw", sel.r1, sel.c1],
        ["ne", sel.r1, sel.c2],
        ["sw", sel.r2, sel.c1],
        ["se", sel.r2, sel.c2],
      ] as [string, number, number][])
    : [];
  const CORNER: Record<string, string> = { nw: "left-0 top-0", ne: "right-0 top-0", sw: "left-0 bottom-0", se: "right-0 bottom-0" };
  return (
    <div className="space-y-1">
      <table
        ref={table_}
        className="sheet-annotator select-none text-xs"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        data-sheet={name}
      >
        <thead className="sticky top-0 bg-panel-2 text-muted">
          <tr>
            <th className="px-1.5" />
            {Array.from({ length: cols }, (_, i) => (
              <th key={i} className="min-w-16 border-l border-line px-2 py-0.5 font-normal">
                {colName(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.slice(0, 500).map((row, r) => (
            <tr key={r} className="border-t border-line">
              <td className="bg-panel-2 px-1.5 text-right text-muted">{r + 1}</td>
              {Array.from({ length: cols }, (_, cI) => {
                const hit = shownRanges.filter((x) => inside(x.cells, r, cI));
                const starts = hit.filter((x) => x.cells.r1 === r && x.cells.c1 === cI);
                const inSel = !!sel && inside(sel, r, cI);
                // touch: dragging draws (draw mode) or moves a range (select mode); elsewhere the sheet scrolls
                const grab = mode === "draw" || (mode === "select" && hit.length > 0);
                return (
                  <td
                    key={cI}
                    data-r={r}
                    data-c={cI}
                    title={hit.map((x) => x.label).filter(Boolean).join(", ") || undefined}
                    className={`relative max-w-48 truncate border-l border-line px-2 py-0.5 ${mode === "draw" ? "cursor-cell" : mode === "select" && hit.length ? (canEdit && inSel ? "cursor-move" : "cursor-pointer") : ""} ${grab ? "touch-none" : ""} ${
                      (draft && inside(draft, r, cI)) || inSel ? "bg-ok/20 text-white" : hit.length ? "bg-ocean/20 text-white" : "text-soft"
                    }`}
                  >
                    {starts.length > 0 && (
                      <span className={`mr-1 rounded px-1 text-[10px] text-white ${starts.some((x) => x.pk === selected) ? "bg-ok" : "bg-ocean"}`}>{starts.map((x) => x.label || "•").join(", ")}</span>
                    )}
                    {row[cI] ?? ""}
                    {canEdit &&
                      corners
                        .filter(([, cr, cc]) => cr === r && cc === cI)
                        .map(([h]) => (
                          <span
                            key={h}
                            data-cell-handle={h}
                            style={{ cursor: `${h}-resize` }}
                            className={`absolute ${CORNER[h]} h-3 w-3 touch-none border border-white bg-ok after:absolute after:-inset-2 after:content-['']`}
                          />
                        ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {names.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          {names.map((n, i) => (
            <button key={n} type="button" onClick={() => (setTab(i), onDraft(null))} className={`rounded px-2 py-0.5 ${tab === i ? "bg-ocean/15 text-white" : "text-muted hover:bg-panel-2"}`}>
              {n}
              {counts[n] ? ` (${counts[n]})` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Action parameters
// ------------------------------------------------------------------------------------------------

/** Parameters an action gets from the widget: by the property each one sets (or its type), the rest typed in. */
export function fillParameters(action: ActionType, known: Record<string, unknown>) {
  const filled: Record<string, unknown> = {};
  for (const p of action.parameters) if (p.property && p.property in known) filled[p.id] = known[p.property];
  return filled;
}

export function ExtraParameters({ action, filled, values, onChange }: { action: ActionType; filled: Record<string, unknown>; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rest = action.parameters.filter((p) => !(p.id in filled) && p.prefill !== "current_user");
  if (!rest.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {rest.map((p) => (
        <input
          key={p.id}
          value={values[p.id] ?? ""}
          onChange={(e) => onChange({ ...values, [p.id]: e.target.value })}
          placeholder={`${p.display_name}${p.required ? " *" : ""}`}
          className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-2 py-1 text-xs outline-none focus:border-ocean"
        />
      ))}
    </div>
  );
}

export const typed = (action: ActionType, values: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, v]) => v !== "")
      .map(([id, v]) => {
        const p = action.parameters.find((x) => x.id === id);
        return [id, p && /integer|long|short|double|float|decimal/i.test(p.type) ? Number(v) : p?.type === "boolean" ? v === "true" : v];
      }),
  );

// ------------------------------------------------------------------------------------------------
// PDF text layer: transparent, selectable text over the page image (offsets are pdfium character indices)
// ------------------------------------------------------------------------------------------------

type TextLayer = Awaited<ReturnType<typeof workshop.pdfText>>;

/** the character offset of a selection boundary inside the text layer */
const offsetAt = (node: Node, off: number): number | null => {
  if (node.nodeType === Node.TEXT_NODE) {
    const el = node.parentElement?.closest<HTMLElement>("[data-s]");
    return el ? Number(el.dataset.s) + off : null;
  }
  const el = node as HTMLElement;
  if (el.dataset?.s !== undefined) return off > 0 ? Number(el.dataset.e) : Number(el.dataset.s);
  const kids = [...el.childNodes].filter((k): k is HTMLElement => k instanceof HTMLElement && k.dataset.s !== undefined);
  if (!kids.length) return null;
  const at = el.childNodes[off];
  if (at instanceof HTMLElement && at.dataset.s !== undefined) return Number(at.dataset.s);
  return Number(kids[kids.length - 1].dataset.e);
};

type Picked = { quote: string; boxes: { x: number; y: number; w: number; h: number }[] };

function PdfTextLayer({ id, page, onSpan }: { id: string; page: number; onSpan: (start: number, end: number, picked: Picked) => void }) {
  const [layer, setLayer] = useState<TextLayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    let stale = false;
    workshop.pdfText(id, page).then(
      (t) => !stale && (setLayer(t), setError(null)),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [id, page]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** the browser's selection, when it lies in this layer: its offsets, text and line boxes */
  const read = (): { start: number; end: number; picked: Picked } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !box.current) return null;
    const r = sel.getRangeAt(0);
    if (!box.current.contains(r.commonAncestorContainer)) return null;
    const a = offsetAt(r.startContainer, r.startOffset);
    const b = offsetAt(r.endContainer, r.endOffset);
    if (a === null || b === null || a === b) return null;
    return {
      start: Math.min(a, b),
      end: Math.max(a, b),
      picked: { quote: sel.toString().replace(/\s+/g, " ").trim(), boxes: selectionBoxes([...r.getClientRects()], box.current.getBoundingClientRect()) },
    };
  };
  // touch: the selection is made and adjusted with the browser's own handles (no pointer events reach the page), so it
  // is followed here and taken with the "Use selected text" button
  const [held, setHeld] = useState<{ start: number; end: number; picked: Picked } | null>(null);
  useEffect(() => {
    const on = () => setHeld(read());
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);
  // stretch each run to its box's width, as pdf.js does
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !layer || !size.w) return;
    for (const span of el.querySelectorAll<HTMLElement>("[data-s]")) {
      span.style.transform = "";
      const want = Number(span.dataset.w) * size.w;
      const have = span.getBoundingClientRect().width;
      if (have > 0) span.style.transform = `scaleX(${want / have})`;
    }
  }, [layer, size]);
  return (
    <div
      ref={box}
      className="pdf-text-layer absolute inset-0 cursor-text select-text overflow-hidden"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => {
        if (e.pointerType === "touch") return; // a touch selection is taken with the button
        const s = read();
        if (s) onSpan(s.start, s.end, s.picked);
      }}
      data-pdf-text-layer={layer ? layer.runs.length : "loading"}
    >
      {error && <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{error}</span>}
      {layer?.runs.map((r) => (
        <span
          key={r.s}
          data-s={r.s}
          data-e={r.e}
          data-w={r.w}
          className="absolute origin-top-left whitespace-pre leading-none text-transparent selection:bg-ocean/40"
          style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, fontSize: `${Math.max(1, r.h * size.h)}px`, fontFamily: "sans-serif" }}
        >
          {layer.text.slice(r.s, r.e)}
        </span>
      ))}
      {held && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSpan(held.start, held.end, held.picked)}
          className="absolute right-1 top-1 select-none rounded bg-ok px-2 py-1 text-[11px] font-medium text-white shadow"
          data-annotation-use-selection
        >
          Use selected text
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// The widget
// ------------------------------------------------------------------------------------------------

type Ann = { pk: string; shape: Shape | null; cells: Cells | null; label: string };
/** a drag on the selected annotation: moving it, a rectangle handle, a polygon vertex, or a text span's start / end
 * (handle "start" | "end"); `moved` once past a few pixels (a tap on a vertex picks it instead) */
type Drag = { kind: "move" | "handle" | "vertex" | "span"; handle?: string; index?: number; from: { x: number; y: number }; orig: Shape; moved: boolean; last?: Shape };
/** how far (pixels) the pointer reaches: farther for a finger */
const reach = (e: { pointerType?: string }) => (e.pointerType === "touch" ? 12 : 4);

const HANDLES: [string, number, number][] = [
  ["nw", 0, 0],
  ["n", 0.5, 0],
  ["ne", 1, 0],
  ["e", 1, 0.5],
  ["se", 1, 1],
  ["s", 0.5, 1],
  ["sw", 0, 1],
  ["w", 0, 0.5],
];
const TONES = {
  ok: { text: "text-ok", border: "border-ok", bg: "bg-ok" },
  warn: { text: "text-warn", border: "border-warn", bg: "bg-warn" },
  ocean: { text: "text-ocean", border: "border-ocean", bg: "bg-ocean" },
};
const TOOL_LABEL: Record<Tool, string> = { select: "Select", rect: "Rectangle", polygon: "Polygon", point: "Point", text: "Text", cells: "Range" };

/** Image Annotation (and PDF / spreadsheet annotations): the image, PDF page or sheets with the annotation objects drawn
 * as rectangles, polygons, points, text spans (PDF) or cell ranges; tools draw new ones and a create action saves them;
 * the select tool picks one to move, resize or move vertices (the modify action) or delete (the delete action). On a
 * PDF each shape records its page. */
export function ImageAnnotationView({ reference, pk, widget, state }: { reference: string; pk: string; widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const id = reference.split("#")[0];
  const [doc, setDoc] = useState<{ pages: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [cellDraft, setCellDraft] = useState<Cells | null>(null);
  const [page, setPage] = useState(Number(reference.split("#")[1]) || 0);
  useEffect(() => {
    let stale = false;
    mediaSets.metadata(id).then(
      (m) => {
        if (stale) return;
        const kind = mediaKind((m.schema as MediaSchema | null) ?? null, String(m.path ?? ""));
        setDoc(kind === "document" ? { pages: Number(m.pages ?? 0) } : null);
        setSheet(kind === "spreadsheet");
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [id]);
  const [anns, setAnns] = useState<Ann[]>([]);
  const [action, setAction] = useState<ActionType | null>(null);
  const [modifyAction, setModifyAction] = useState<ActionType | null>(null);
  const [deleteAction, setDeleteAction] = useState<ActionType | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number } | null>(null);
  const [building, setBuilding] = useState<[number, number][] | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolPick, setTool] = useState<Tool | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<Shape | null>(null);
  const [editCells, setEditCells] = useState<Cells | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // a polygon vertex tapped (touch has no double-click: "Remove point" removes it), a text span's reselection under way
  const [vertexPick, setVertexPick] = useState<number | null>(null);
  const [reselect, setReselect] = useState(false);
  const [spanLayer, setSpanLayer] = useState<{ key: string; layer: TextLayer } | null>(null);
  const [located, setLocated] = useState<Record<string, Box[]>>({});
  const drag = useRef<Drag | null>(null);
  // Cipher visual obfuscation: annotations picked as areas, and the decrypted image while shown
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const area = useRef<HTMLDivElement | null>(null);
  const ready = !!(c.annotation_type_id && c.annotation_link && c.annotation_box);
  const annKey = c.annotation_type_id ? sourceKey({ kind: "object_type", id: c.annotation_type_id }) : "";
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    workshop
      .query({
        source: { kind: "object_type", id: c.annotation_type_id! },
        filters: [{ column: c.annotation_link!, op: "eq", value: pk }],
        columns: [c.annotation_box!, ...(c.annotation_label ? [c.annotation_label] : [])],
        limit: 500,
      })
      .then(
        (r) =>
          !stale &&
          setAnns(
            (r.rows ?? []).flatMap((row) => {
              const shape = parseShape(row[c.annotation_box!]);
              const cells = shape ? null : parseCells(row[c.annotation_box!]);
              return shape || cells ? [{ pk: String(row.__pk), shape, cells, label: c.annotation_label ? String(row[c.annotation_label] ?? "") : "" }] : [];
            }),
          ),
        (e: Error) => !stale && setError(e.message),
      );
    return () => {
      stale = true;
    };
  }, [ready, c.annotation_type_id, c.annotation_link, c.annotation_box, c.annotation_label, pk, state.version]);
  useEffect(() => {
    if (!c.action_type_id) return;
    ontology.actionType(c.action_type_id).then(setAction, () => setAction(null));
  }, [c.action_type_id]);
  useEffect(() => {
    if (!c.annotation_modify_action) return;
    ontology.actionType(c.annotation_modify_action).then(setModifyAction, () => setModifyAction(null));
  }, [c.annotation_modify_action]);
  useEffect(() => {
    if (!c.annotation_delete_action) return;
    ontology.actionType(c.annotation_delete_action).then(setDeleteAction, () => setDeleteAction(null));
  }, [c.annotation_delete_action]);
  // a read-only (kiosk) module draws, edits and deletes nothing
  const configured = !!(c.action_type_id || c.annotation_modify_action || c.annotation_delete_action);
  const create = c.action_type_id && !state.readOnly ? action : null;
  const modify = c.annotation_modify_action && !state.readOnly ? modifyAction : null;
  const remove = c.annotation_delete_action && !state.readOnly ? deleteAction : null;
  // text spans stored without line boxes (made elsewhere): found on the page by their quote
  const spansToLocate = anns.filter((a) => a.shape?.type === "text" && !a.shape.boxes?.length && a.shape.quote && !(a.pk in located));
  useEffect(() => {
    if (!doc || !spansToLocate.length) return;
    let stale = false;
    for (const a of spansToLocate) {
      const s = a.shape as Span;
      workshop.pdfLocate(id, s.quote).then(
        (r) => !stale && setLocated((m) => ({ ...m, [a.pk]: r.pages.find((x) => x.page === s.page)?.boxes ?? r.pages[0]?.boxes ?? [] })),
        () => !stale && setLocated((m) => ({ ...m, [a.pk]: [] })),
      );
    }
    return () => {
      stale = true;
    };
  }, [doc, id, spansToLocate.map((a) => a.pk).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const allowed = (c.annotation_tools?.length ? c.annotation_tools : ["rect", "polygon", "point", "text"]).filter((t) => t !== "text" || doc);
  const tools: Tool[] = [...(modify || remove ? (["select"] as Tool[]) : []), ...(create ? (sheet ? (["cells"] as Tool[]) : (allowed as Tool[])) : [])];
  const tool: Tool | null = toolPick && tools.includes(toolPick) ? toolPick : (tools.find((t) => t !== "select") ?? tools[0] ?? null);
  const editable = !!(modify || remove);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const onPage = doc ? { page } : {};
  const pending: Shape | Cells | null = sheet ? cellDraft : draft;
  const known = (geo: Shape | Cells, text = label) => ({
    [c.annotation_link!]: pk,
    [c.annotation_box!]: "sheet" in geo ? JSON.stringify(toRange(geo)) : serialize(geo),
    ...(c.annotation_label ? { [c.annotation_label]: text } : {}),
  });
  const clearDraft = () => {
    setDraft(null);
    setCellDraft(null);
    setBuilding(null);
    setDrawing(null);
  };
  const choose = (t: Tool) => {
    setTool(t);
    clearDraft();
    deselect();
  };
  const deselect = () => {
    setSelected(null);
    setEdit(null);
    setEditCells(null);
    setConfirmDelete(false);
    setVertexPick(null);
    setReselect(false);
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!create || !pending) return;
    if (await run(() => ontology.applyAction(create.id, { ...typed(create, extra), ...fillParameters(create, known(pending)) }))) {
      clearDraft();
      setLabel("");
      state.bump();
    }
  };
  const objectParam = (a: ActionType) => a.parameters.find((p) => p.type === "object");
  const current = anns.find((a) => a.pk === selected) ?? null;
  const editGeo: Shape | Cells | null = edit ?? editCells;
  const changed = !!(
    current &&
    editGeo &&
    ((edit && current.shape && serialize(edit) !== serialize(current.shape)) || (editCells && current.cells && !sameCells(editCells, current.cells)) || editLabel !== current.label)
  );
  const saveEdit = async () => {
    if (!modify || !current || !editGeo) return;
    const obj = objectParam(modify);
    const values = known(editGeo, editLabel);
    delete values[c.annotation_link!];
    const filled = fillParameters(modify, values);
    if (!obj) return setError(`${modify.display_name} has no object parameter to receive the annotation`);
    if (!Object.keys(filled).length) return setError(`${modify.display_name} has no parameter setting the box${c.annotation_label ? " or label" : ""} property`);
    if (await run(() => ontology.applyAction(modify.id, { ...filled, [obj.id]: current.pk }))) state.bump();
  };
  const del = async () => {
    if (!remove || !current) return;
    const obj = objectParam(remove);
    if (!obj) return setError(`${remove.display_name} has no object parameter to receive the annotation`);
    if (await run(() => ontology.applyAction(remove.id, { [obj.id]: current.pk }))) {
      deselect();
      state.select(annKey, undefined);
      state.bump();
    }
  };
  const pick = (a: Ann) => {
    setSelected(a.pk);
    setEdit(a.shape);
    setEditCells(a.cells);
    setEditLabel(a.label);
    setConfirmDelete(false);
    setVertexPick(null);
    setReselect(false);
    state.select(annKey, a.pk);
  };
  /** the spreadsheet: a range picked (or none: deselect) */
  const pickRange = (key: string | null) => {
    const a = key ? anns.find((x) => x.pk === key) : null;
    if (!a) {
      deselect();
      return state.select(annKey, undefined);
    }
    if (a.pk !== selected) pick(a);
  };
  // the text layer of the selected span's page: what its ends are dragged over
  const spanPage = modify && edit?.type === "text" && doc ? edit.page : null;
  const layer = spanPage !== null && spanLayer?.key === `${id}#${spanPage}` ? spanLayer.layer : null;
  useEffect(() => {
    if (spanPage === null) return;
    let stale = false;
    workshop.pdfText(id, spanPage).then(
      (t) => !stale && setSpanLayer({ key: `${id}#${spanPage}`, layer: t }),
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [id, spanPage]);
  /** a span's quote and line boxes as the server computes them (the dragged ones are estimates from the runs) */
  const exactSpan = (s: Span) =>
    void workshop.pdfSpan(id, s.page, s.start, s.end).then(
      (x) => setEdit((cur) => (cur?.type === "text" && cur.start === x.start && cur.end === x.end && cur.page === s.page ? { ...cur, quote: x.quote, boxes: x.boxes } : cur)),
      () => {},
    );
  const startDrag = (e: React.PointerEvent, d: Omit<Drag, "from" | "moved">) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      area.current?.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointers have no capture
    }
    drag.current = { ...d, from: at(e), moved: false };
  };
  const finishPolygon = (pts: [number, number][] | null) => {
    if (pts && pts.length >= 3) setDraft({ type: "polygon", points: pts, ...onPage });
    setBuilding(null);
    setCursor(null);
  };

  const rects = anns.flatMap((a) => (a.shape?.type === "rect" ? [{ ...a, box: a.shape as Rect }] : []));
  const shapes = anns.flatMap((a) => (a.shape ? [{ ...a, shape: a.pk === selected && edit ? edit : a.shape }] : []));
  const shown = doc ? shapes.filter((a) => pageOf(a.shape) === page) : shapes;
  const pct = (b: { x: number; y: number; w: number; h: number }) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  const selectable = tool === "select";
  const pickArea = !configured && !doc && !sheet; // the Cipher area picking (no actions configured)
  const tone = (a: { pk: string }) => (a.pk === selected || picked.has(a.pk) ? TONES.ok : hover === a.pk ? TONES.warn : TONES.ocean);
  const shapeDown = (a: { pk: string }, shape: Shape) => (e: React.PointerEvent) => {
    if (pickArea && shape.type === "rect") {
      e.stopPropagation();
      const next = new Set(picked);
      if (next.has(a.pk)) next.delete(a.pk);
      else next.add(a.pk);
      setPicked(next);
      return;
    }
  };
  /** select tool: pick the smallest annotation under the pointer (none: deselect) and start moving it */
  const selectAt = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    const hit = pickAt(shown, at(e), { x: reach(e) / r.width, y: reach(e) / r.height }, located);
    if (!hit) {
      deselect();
      return state.select(annKey, undefined);
    }
    const stored = anns.find((x) => x.pk === hit.pk);
    if (stored && hit.pk !== selected) pick(stored);
    if (modify && hit.shape.type !== "text") startDrag(e, { kind: "move", orig: hit.shape });
  };
  const hoverProps = (a: { pk: string }) => ({ onPointerEnter: () => setHover(a.pk), onPointerLeave: () => setHover(null) });
  const interactive = selectable || pickArea;
  // touch: drawing tools take every touch on the image (no panning); the select tool only touches on annotations and
  // handles, so the image still scrolls elsewhere; the text tool keeps the browser's own text selection
  const drawsOnTouch = !!create && !!tool && tool !== "select" && tool !== "text" && tool !== "cells";
  const grab = selectable && modify ? "touch-none" : "";
  const takeSpan = (start: number, end: number, sel: Picked, put: (s: Span) => void) =>
    void workshop.pdfSpan(id, page, start, end).then(
      (s) => {
        window.getSelection()?.removeAllRanges();
        setError(null);
        if (s.quote) put({ type: "text", page, start: s.start, end: s.end, quote: s.quote, boxes: s.boxes });
      },
      (e: Error) => {
        window.getSelection()?.removeAllRanges();
        // the span route failed: keep what the browser selected (its text and rectangles)
        if (sel.quote && sel.boxes.length) put({ type: "text", page, start, end, quote: sel.quote, boxes: sel.boxes });
        else setError(e.message);
      },
    );
  const spanEdit = modify && selectable && edit?.type === "text" && pageOf(edit) === page && edit.end > edit.start ? edit : null;
  const spanEnds = spanEdit && layer && !reselect && spanEdit.boxes?.length ? { first: spanEdit.boxes[0], last: spanEdit.boxes[spanEdit.boxes.length - 1] } : null;
  const spanHandleDown = (e: React.PointerEvent<HTMLElement>) => spanEdit && startDrag(e, { kind: "span", handle: e.currentTarget.dataset.spanHandle, orig: spanEdit });

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-xs" data-annotation-widget>
      {(doc || tools.length > 1) && (
        <div className="flex flex-wrap items-center gap-2 text-muted">
          {tools.length > 1 && (
            <div className="flex overflow-hidden rounded border border-line-2" role="toolbar" aria-label="Annotation tools">
              {tools.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => choose(t)}
                  aria-pressed={tool === t}
                  className={`px-2 py-0.5 ${tool === t ? "bg-ocean/20 text-white" : "hover:bg-panel-2"}`}
                  data-annotation-tool={t}
                >
                  {TOOL_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          {doc && (
            <>
              <button type="button" disabled={page === 0} onClick={() => (setPage(page - 1), clearDraft(), deselect())} className="rounded px-1.5 hover:bg-panel-2 disabled:opacity-40" aria-label="Previous page">
                <Icon name="left" className="h-3.5 w-3.5" />
              </button>
              <span>
                Page {page + 1}
                {doc.pages ? ` of ${doc.pages}` : ""}
              </span>
              <button
                type="button"
                disabled={!!doc.pages && page >= doc.pages - 1}
                onClick={() => (setPage(page + 1), clearDraft(), deselect())}
                className="rounded px-1.5 hover:bg-panel-2 disabled:opacity-40"
                aria-label="Next page"
              >
                <Icon name="right" className="h-3.5 w-3.5" />
              </button>
              <span className="ml-auto">{shapes.length - shown.length} on other pages</span>
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {sheet ? (
          <SheetAnnotator
            id={id}
            ranges={anns.flatMap((b) => (b.cells ? [{ ...b, cells: b.cells }] : []))}
            draft={cellDraft}
            onDraft={setCellDraft}
            mode={tool === "cells" && create ? "draw" : tool === "select" ? "select" : "none"}
            selected={selected}
            edit={editCells}
            canEdit={!!modify}
            onPick={pickRange}
            onEdit={setEditCells}
          />
        ) : (
          <div
            ref={area}
            tabIndex={0}
            className={`relative inline-block select-none outline-none ${tool && tool !== "select" && tool !== "text" ? "cursor-crosshair" : ""} ${drawsOnTouch ? "touch-none" : ""}`}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                clearDraft();
                deselect();
              }
              if (e.key === "Enter" && building) finishPolygon(building);
              if ((e.key === "Delete" || e.key === "Backspace") && remove && current) setConfirmDelete(true);
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (tool === "select") return selectAt(e);
              if (!create || !tool || tool === "text") return;
              const p = at(e);
              if (tool === "point") return setDraft({ type: "point", ...p, ...onPage });
              if (tool === "polygon") {
                const r = area.current!.getBoundingClientRect();
                const near = (q: [number, number], px: number) => Math.hypot((q[0] - p.x) * r.width, (q[1] - p.y) * r.height) < px;
                setDraft(null);
                if (building && building.length >= 3 && near(building[0], reach(e) * 2)) return finishPolygon(building);
                if (building && near(building[building.length - 1], 4)) return; // a double click's second press
                return setBuilding([...(building ?? []), [p.x, p.y]]);
              }
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                // synthetic pointers have no capture
              }
              setDrawing(p);
              setDraft({ type: "rect", ...p, w: 0, h: 0, ...onPage });
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d) {
                const p = at(e);
                if (!d.moved) {
                  const r = area.current!.getBoundingClientRect();
                  if (Math.hypot((p.x - d.from.x) * r.width, (p.y - d.from.y) * r.height) < 3) return; // a tap, not a drag yet
                  d.moved = true;
                }
                if (d.kind === "move") setEdit(moved(d.orig, p.x - d.from.x, p.y - d.from.y));
                else if (d.kind === "handle" && d.orig.type === "rect") setEdit(resized(d.orig, d.handle!, p));
                else if (d.kind === "vertex" && d.orig.type === "polygon") setEdit(vertexMoved(d.orig, d.index!, p));
                else if (d.kind === "span" && d.orig.type === "text" && layer) {
                  const off = offsetAtPoint(layer.runs, p);
                  if (off === null) return;
                  const { start, end } = spanResized(d.orig, d.handle as "start" | "end", off, layer.text.length);
                  d.last = { ...d.orig, start, end, quote: quoteOf(layer.text, start, end), boxes: spanBoxes(layer.runs, start, end) };
                  setEdit(d.last);
                }
                return;
              }
              if (building) setCursor(at(e));
              if (!drawing) return;
              const p = at(e);
              setDraft({ type: "rect", x: Math.min(p.x, drawing.x), y: Math.min(p.y, drawing.y), w: Math.abs(p.x - drawing.x), h: Math.abs(p.y - drawing.y), ...onPage });
            }}
            onPointerUp={() => {
              const d = drag.current;
              if (d) {
                drag.current = null;
                if (d.kind === "vertex") setVertexPick(d.moved ? null : d.index!);
                if (d.kind === "span" && d.last?.type === "text") exactSpan(d.last);
                return;
              }
              if (!drawing) return;
              setDrawing(null);
              setDraft((d) => (d && d.type === "rect" && d.w > 0.01 && d.h > 0.01 ? d : null));
            }}
            onPointerCancel={() => {
              // the browser took the touch (a scroll or a pinch): drop what the gesture was doing
              const d = drag.current;
              drag.current = null;
              if (d?.moved) setEdit(d.orig);
              if (drawing) {
                setDrawing(null);
                setDraft(null);
              }
            }}
            onDoubleClick={() => building && finishPolygon(building)}
            data-annotation-area
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={decrypted ?? (doc ? accessUrl(id, "page", { page, width: 1000 }) : driveContentUrl(id, true))} alt="" draggable={false} className="block max-w-full bg-white" />
            {/* polygons (and the one being drawn) in an SVG of the image's fractions */}
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              {shown.map(({ shape, ...a }) =>
                shape.type === "polygon" ? (
                  <polygon
                    key={a.pk}
                    points={shape.points.map((p) => p.join(",")).join(" ")}
                    vectorEffect="non-scaling-stroke"
                    strokeWidth={2}
                    stroke="currentColor"
                    fill="currentColor"
                    fillOpacity={a.pk === selected ? 0.2 : 0.1}
                    strokeDasharray={a.pk === selected && changed ? "4 3" : undefined}
                    className={`${tone(a).text} ${interactive ? `pointer-events-auto cursor-move ${grab}` : ""}`}
                    onPointerDown={shapeDown(a, shape)}
                    {...hoverProps(a)}
                    data-annotation={a.pk}
                    data-shape="polygon"
                  />
                ) : null,
              )}
              {draft?.type === "polygon" && <polygon points={draft.points.map((p) => p.join(",")).join(" ")} vectorEffect="non-scaling-stroke" strokeWidth={2} strokeDasharray="4 3" stroke="currentColor" fill="currentColor" fillOpacity={0.1} className="text-ok" />}
              {building && (
                <polyline
                  points={[...building, ...(cursor ? [[cursor.x, cursor.y]] : [])].map((p) => p.join(",")).join(" ")}
                  vectorEffect="non-scaling-stroke"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  stroke="currentColor"
                  fill="none"
                  className="text-ok"
                />
              )}
            </svg>
            {shown.map(({ shape, ...a }) => {
              if (shape.type === "rect")
                return (
                  <div
                    key={a.pk}
                    style={pct(shape)}
                    onPointerDown={shapeDown(a, shape)}
                    {...hoverProps(a)}
                    className={`absolute border-2 ${tone(a).border} ${a.pk === selected || picked.has(a.pk) ? "bg-ok/10" : hover === a.pk ? "bg-warn/10" : ""} ${a.pk === selected && changed ? "border-dashed" : ""} ${interactive ? (modify && selectable ? `cursor-move ${grab}` : "cursor-pointer") : "pointer-events-none"}`}
                    data-annotation={a.pk}
                    data-shape="rect"
                  />
                );
              if (shape.type === "point")
                return (
                  <div
                    key={a.pk}
                    style={{ left: `${shape.x * 100}%`, top: `${shape.y * 100}%` }}
                    onPointerDown={shapeDown(a, shape)}
                    {...hoverProps(a)}
                    className={`absolute -ml-1.5 -mt-1.5 h-3 w-3 rounded-full border-2 border-white ${tone(a).bg} shadow ${a.pk === selected ? "ring-2 ring-ok" : ""} ${interactive ? (modify && selectable ? `cursor-move ${grab} after:absolute after:-inset-2 after:content-['']` : "cursor-pointer") : "pointer-events-none"}`}
                    data-annotation={a.pk}
                    data-shape="point"
                  />
                );
              if (shape.type === "text")
                return (shape.boxes?.length ? shape.boxes : located[a.pk] ?? []).map((b, j) => (
                  <div
                    key={`${a.pk}-${j}`}
                    style={{ ...pct(b), background: a.pk === selected ? "rgba(63,185,80,.35)" : "rgba(227,179,65,.35)", boxShadow: "inset 0 -2px 0 rgba(227,179,65,.9)" }}
                    onPointerDown={shapeDown(a, shape)}
                    {...hoverProps(a)}
                    title={shape.quote}
                    className={`absolute rounded-sm ${interactive ? `cursor-pointer ${grab}` : "pointer-events-none"}`}
                    data-annotation={a.pk}
                    data-shape="text"
                  />
                ));
              return null;
            })}
            {/* labels */}
            {shown.map(({ shape, ...a }) => {
              const p = a.label ? anchor(shape, located[a.pk]) : null;
              return p ? (
                <span
                  key={`label-${a.pk}`}
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                  className={`pointer-events-none absolute -mt-4 whitespace-nowrap rounded px-1 text-[10px] text-white ${a.pk === selected ? "bg-ok" : "bg-ocean"}`}
                >
                  {a.label}
                </span>
              ) : null;
            })}
            {/* handles of the selected annotation */}
            {modify && selectable && edit && (!doc || pageOf(edit) === page) && edit.type === "rect" &&
              HANDLES.map(([h, fx, fy]) => (
                <div
                  key={h}
                  style={{ left: `${(edit.x + edit.w * fx) * 100}%`, top: `${(edit.y + edit.h * fy) * 100}%`, cursor: `${h}-resize` }}
                  onPointerDown={(e) => startDrag(e, { kind: "handle", handle: h, orig: edit })}
                  className="absolute -ml-1 -mt-1 h-2 w-2 touch-none border border-white bg-ok after:absolute after:-inset-2 after:content-['']"
                  data-handle={h}
                />
              ))}
            {modify && selectable && edit && (!doc || pageOf(edit) === page) && edit.type === "polygon" &&
              edit.points.map(([x, y], i) => (
                <div
                  key={i}
                  style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                  onPointerDown={(e) => startDrag(e, { kind: "vertex", index: i, orig: edit })}
                  onDoubleClick={(e) => (e.stopPropagation(), setEdit(vertexRemoved(edit, i)), setVertexPick(null))}
                  title={edit.points.length > 3 ? "Drag to move; double-click (or tap, then Remove point) to remove" : "Drag to move"}
                  className={`absolute -ml-1.5 -mt-1.5 h-3 w-3 cursor-grab touch-none rounded-full border border-white bg-ok after:absolute after:-inset-2 after:content-[''] ${vertexPick === i ? "ring-2 ring-warn" : ""}`}
                  data-vertex={i}
                />
              ))}
            {/* the ends of the selected text span: dragged over the page's text to change its range */}
            {spanEdit &&
              spanEnds &&
              (["start", "end"] as const).map((h) => {
                const b = h === "start" ? spanEnds.first : spanEnds.last;
                return (
                  <div
                    key={h}
                    style={{ left: `${(h === "start" ? b.x : b.x + b.w) * 100}%`, top: `${b.y * 100}%`, height: `${b.h * 100}%` }}
                    onPointerDown={spanHandleDown}
                    title={h === "start" ? "Drag to change where the span starts" : "Drag to change where the span ends"}
                    className="absolute -ml-[3px] w-1.5 cursor-ew-resize touch-none rounded-sm bg-ok after:absolute after:-inset-x-2.5 after:-inset-y-1 after:content-['']"
                    data-span-handle={h}
                  >
                    <span className={`absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-white bg-ok ${h === "start" ? "-top-2.5" : "-bottom-2.5"}`} />
                  </div>
                );
              })}
            {/* drafts */}
            {draft?.type === "rect" && <div style={pct(draft)} className="pointer-events-none absolute border-2 border-dashed border-ok bg-ok/10" data-draft="rect" />}
            {draft?.type === "point" && <div style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }} className="pointer-events-none absolute -ml-1.5 -mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-ok" data-draft="point" />}
            {draft?.type === "text" &&
              (draft.boxes ?? []).map((b, j) => <div key={j} style={{ ...pct(b), background: "rgba(63,185,80,.35)" }} className="pointer-events-none absolute rounded-sm" data-draft="text" />)}
            {building?.map(([x, y], i) => (
              <div key={i} style={{ left: `${x * 100}%`, top: `${y * 100}%` }} className={`pointer-events-none absolute -ml-1 -mt-1 h-2 w-2 rounded-full ${i === 0 ? "bg-white ring-2 ring-ok" : "bg-ok"}`} />
            ))}
            {doc && tool === "text" && create && <PdfTextLayer key={page} id={id} page={page} onSpan={(start, end, sel) => takeSpan(start, end, sel, setDraft)} />}
            {doc && reselect && modify && edit?.type === "text" && pageOf(edit) === page && (
              <PdfTextLayer key={`re-${page}`} id={id} page={page} onSpan={(start, end, sel) => takeSpan(start, end, sel, (s) => (setEdit(s), setReselect(false)))} />
            )}
          </div>
        )}
      </div>
      {error && <p className="text-bad">{error}</p>}
      {pickArea && rects.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !picked.size}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setDecrypted(await cipherApi.visualDecrypt(id, rects.filter((b) => picked.has(b.pk)).map(({ box: { x, y, w, h } }) => ({ x, y, w, h }))));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className="rounded border border-line-2 px-2 py-0.5 hover:text-white disabled:opacity-40"
            title="Cipher visual obfuscation: show the original pixels of the encrypted areas inside the picked annotations (Operational User license)"
          >
            {busy ? "Decrypting…" : `Decrypt selected areas${picked.size ? ` (${picked.size})` : ""}`}
          </button>
          {decrypted && (
            <button type="button" onClick={() => (URL.revokeObjectURL(decrypted), setDecrypted(null), setPicked(new Set()))} className="text-muted hover:text-white">
              Show encrypted
            </button>
          )}
          {!picked.size && <span className="text-muted">click annotations to pick areas</span>}
        </div>
      )}
      {!ready && <p className="text-muted">Choose the annotation object type, its image link and box properties in the panel on the right.</p>}
      {ready && !create && !editable && (
        <p className="text-muted" data-annotation-hint>
          {anns.length} annotations · {state.readOnly && configured ? "read-only (kiosk mode)" : "choose a create action to draw new ones"}
        </p>
      )}
      {ready && !pending && !current && (create || editable) && (
        <p className="text-muted" data-annotation-hint>
          {anns.length} annotations ·{" "}
          {sheet && tool === "cells"
            ? "drag across cells to select a range"
            : tool === "select"
              ? `click an annotation to ${[modify && "edit", remove && "delete"].filter(Boolean).join(" or ")} it`
              : tool === "polygon"
                ? building
                  ? `${building.length} points · click the first point, double-click or press Enter to close; Esc cancels`
                  : "click to place the polygon's points"
                : tool === "point"
                  ? "click to place a point"
                  : tool === "text"
                    ? "select text on the page"
                    : "drag on the image to draw a box"}
          {building && building.length >= 3 && (
            <button type="button" onClick={() => finishPolygon(building)} className="ml-2 rounded border border-line-2 px-2 py-0.5 text-soft hover:text-white" data-annotation-close-polygon>
              Close polygon
            </button>
          )}
        </p>
      )}
      {current && editGeo && !pending && (
        <div className="space-y-1.5" data-annotation-selected={current.pk}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted" data-annotation-geometry>
              {edit
                ? `${TOOL_LABEL[edit.type]}${edit.type === "text" ? ` · “${edit.quote.slice(0, 80)}${edit.quote.length > 80 ? "…" : ""}”` : edit.type === "polygon" ? ` · ${edit.points.length} points` : ""}`
                : editCells
                  ? `Range · ${toRange(editCells).sheet} · ${toRange(editCells).range}`
                  : ""}
            </span>
            {modify && c.annotation_label ? (
              <input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && changed && saveEdit()}
                placeholder="Label"
                className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-2 py-1 outline-none focus:border-ocean"
                data-annotation-edit-label
              />
            ) : (
              current.label && <span className="flex-1 text-white">{current.label}</span>
            )}
            {modify && (
              <button type="button" disabled={busy || !changed} onClick={saveEdit} className="rounded bg-ocean px-2.5 py-1 font-medium text-white hover:bg-ocean-deep disabled:opacity-50" data-annotation-save>
                {busy ? "Saving…" : modify.display_name}
              </button>
            )}
            {modify && changed && (
              <button type="button" onClick={() => (setEdit(current.shape), setEditCells(current.cells), setEditLabel(current.label), setVertexPick(null))} className="rounded px-2 py-1 text-muted hover:text-white">
                Undo
              </button>
            )}
            {modify && edit?.type === "polygon" && vertexPick !== null && vertexPick < edit.points.length && edit.points.length > 3 && (
              <button type="button" onClick={() => (setEdit(vertexRemoved(edit, vertexPick)), setVertexPick(null))} className="rounded border border-line-2 px-2 py-1 text-soft hover:text-white" data-annotation-remove-vertex>
                Remove point {vertexPick + 1}
              </button>
            )}
            {modify && edit?.type === "text" && doc && (
              <button
                type="button"
                onClick={() => (window.getSelection()?.removeAllRanges(), setReselect(!reselect))}
                aria-pressed={reselect}
                className={`rounded border px-2 py-1 ${reselect ? "border-ok text-white" : "border-line-2 text-soft hover:text-white"}`}
                data-annotation-reselect
              >
                {reselect ? "Cancel reselect" : "Reselect text"}
              </button>
            )}
            {remove &&
              (confirmDelete ? (
                <button type="button" disabled={busy} onClick={del} className="rounded bg-bad px-2.5 py-1 font-medium text-white disabled:opacity-50" data-annotation-delete-confirm>
                  Confirm {remove.display_name}
                </button>
              ) : (
                <button type="button" onClick={() => setConfirmDelete(true)} className="rounded border border-bad/60 px-2 py-1 text-bad hover:bg-bad/10" data-annotation-delete>
                  {remove.display_name}
                </button>
              ))}
            <button type="button" onClick={() => (deselect(), state.select(annKey, undefined))} className="rounded px-2 py-1 text-muted hover:text-white">
              Close
            </button>
          </div>
          {modify && edit && edit.type !== "text" && <p className="text-muted">drag the annotation to move it{edit.type === "rect" ? ", its handles to resize it" : edit.type === "polygon" ? ", its points to reshape it" : ""}</p>}
          {modify && edit?.type === "text" && doc && (
            <p className="text-muted">{reselect ? "select the span's new text on the page" : edit.end > edit.start ? "drag the span's ends to change its range, or reselect its text" : "reselect its text to change the range"}</p>
          )}
          {modify && editCells && <p className="text-muted">drag the range to move it, its corners to resize it</p>}
        </div>
      )}
      {create && pending && (
        <div className="space-y-1.5" data-annotation-draft>
          {"sheet" in pending && (
            <p className="text-muted">
              {toRange(pending).sheet} · {toRange(pending).range}
            </p>
          )}
          {"type" in pending && pending.type === "text" && <p className="text-muted">“{pending.quote.slice(0, 160)}{pending.quote.length > 160 ? "…" : ""}”</p>}
          <div className="flex gap-1.5">
            {c.annotation_label && (
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="Label"
                className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-2 py-1 outline-none focus:border-ocean"
              />
            )}
            <button type="button" disabled={busy} onClick={save} className="rounded bg-ocean px-2.5 py-1 font-medium text-white hover:bg-ocean-deep disabled:opacity-50">
              {busy ? "Saving…" : create.display_name}
            </button>
            <button type="button" onClick={clearDraft} className="rounded px-2 py-1 text-muted hover:text-white">
              Cancel
            </button>
          </div>
          <ExtraParameters action={create} filled={fillParameters(create, known(pending))} values={extra} onChange={setExtra} />
        </div>
      )}
    </div>
  );
}
