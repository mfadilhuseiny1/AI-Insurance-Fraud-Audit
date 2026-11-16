"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@/components/Icon";
import { backgroundOf, widgetInfo, type SectionLayout, type Widget, type WidgetType } from "@/lib/workshop";
import { useSize } from "./Charts";
import { WidgetView, type ModuleState } from "./WidgetView";
import { acceptsDrop, dropValue, LazyMount, readDrop } from "./CrossApp";

export const COLS = 12;
export const ROW = 44;
export const GAP = 8;
export const DRAG_TYPE = "application/x-workshop-widget";

/** Hidden by conditional visibility (hide_if on a boolean variable). */
export const isHidden = (w: Widget, state: ModuleState) => (w.config.hide_if?.variable ? !!state.variables[w.config.hide_if.variable] === (w.config.hide_if.when ?? true) : false);
const isCollapsed = (w: Widget, state: ModuleState) => !!w.config.collapsible && (state.sections?.[w.id] ?? !!w.config.collapsed);

/** View mode: widgets below a hidden or collapsed one move up into the freed rows (keeping their gaps). */
function reflow(widgets: Widget[], state: ModuleState): Map<string, { y: number; h: number }> {
  const out = new Map<string, { y: number; h: number }>();
  const sorted = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const w of sorted) {
    const h = isHidden(w, state) ? 0 : isCollapsed(w, state) ? 1 : w.h;
    // below its placed blockers (above it, overlapping columns), keeping the original gap to each
    const blockers = sorted.filter((c) => c !== w && c.y + c.h <= w.y && c.x < w.x + w.w && w.x < c.x + c.w && out.has(c.id));
    const y = blockers.length ? Math.max(...blockers.map((c) => out.get(c.id)!.y + out.get(c.id)!.h + (w.y - (c.y + c.h)))) : w.y;
    out.set(w.id, { y, h });
  }
  return out;
}

/** A widget's frame: title bar (block / contained / floating header), background, border style, collapse. */
function Frame({
  w, state, editing, on, hidden, onSelect, onMove, style, compact, children,
}: {
  w: Widget; state: ModuleState; editing: boolean; on: boolean; hidden: boolean; onSelect: (id: string) => void;
  onMove?: (e: ReactPointerEvent) => void; style?: CSSProperties; compact?: boolean; children?: React.ReactNode;
}) {
  const c = w.config;
  const bare = w.type === "text" || w.type === "button" || w.type === "filter" || compact;
  const collapsed = !editing && isCollapsed(w, state);
  const header = c.header_style ?? "block";
  const border = c.border ?? (compact ? "none" : "bordered");
  const ring = on ? "border-ocean ring-1 ring-ocean" : editing ? "border-line-2 hover:border-ocean/50" : border === "none" ? "border-transparent" : "border-line";
  const shadow = border === "shadow" ? "0 6px 18px rgba(0,0,0,.28)" : border === "inner" ? "inset 0 2px 8px rgba(0,0,0,.3)" : undefined;
  const showTitle = (w.title || editing) && !(bare && !w.title && !editing);
  const titleBar = showTitle && (
    <div
      onPointerDown={onMove}
      className={`flex h-8 shrink-0 items-center gap-2 px-3 text-sm font-semibold ${header === "block" && !collapsed ? "border-b border-line" : ""} ${header === "floating" ? "px-1 text-soft" : ""} ${editing && onMove ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      {editing && onMove && <Icon name="dots" className="h-3.5 w-3.5 shrink-0 text-muted" />}
      <span className="truncate">{(w.title && (state.tr?.(w.title) ?? w.title)) || <span className="font-normal text-muted">{widgetInfo(w.type).label}</span>}</span>
      {c.hide_if?.variable && editing && (
        <span title={`Conditional visibility: hidden when ${c.hide_if.variable} is ${c.hide_if.when ?? true}`} className="shrink-0 text-muted">
          <Icon name="eye" className="h-3 w-3" />
        </span>
      )}
      {c.collapsible && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => (e.stopPropagation(), !editing && state.setSection?.(w.id, !collapsed))}
          className="ml-auto text-muted hover:text-white"
          title={editing ? "Collapses in view mode" : collapsed ? "Expand" : "Collapse"}
          data-collapse={w.id}
        >
          <Icon name="down" className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        </button>
      )}
    </div>
  );
  const [over, setOver] = useState(false);
  const lazy = !editing && (c.mount === "delay" || c.unmount === "offscreen");
  const body = !collapsed && (
    <div className={`relative min-h-0 flex-1 ${header === "contained" ? "pt-0" : ""}`}>
      {lazy ? <LazyMount mount={c.mount} unmount={c.unmount}>{children}</LazyMount> : children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded border-2 border-dashed border-ocean bg-ocean/15 text-sm text-white" data-drop-overlay>
          <Icon name={(c.drop_icon as "plus") || "plus"} className="h-5 w-5" />
          {c.drop_label || "Drop objects here"}
        </div>
      )}
    </div>
  );
  // a section with drop handling takes objects dragged from tables, other widgets or other applications
  const drops = w.type === "section" && !!c.drop_handling && !editing;
  const dropProps = drops
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!acceptsDrop(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false);
        },
        onDrop: (e: React.DragEvent) => {
          setOver(false);
          const d = readDrop(e.dataTransfer);
          if (!d) return;
          e.preventDefault();
          e.stopPropagation();
          if (c.drop_output) state.setVariable(c.drop_output, dropValue(d, state.variableTypes?.[c.drop_output]));
          if (c.drop_events?.length) void state.runEvents?.(c.drop_events);
        },
      }
    : {};
  const select = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editing) onSelect(w.id);
  };
  if (header === "floating")
    return (
      <div onClick={select} style={style} className={`flex flex-col ${hidden ? "opacity-40" : ""}`} data-widget={w.id} {...dropProps}>
        {titleBar}
        {!collapsed && (
          <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border ${ring}`} style={{ background: backgroundOf(c.background) ?? "var(--color-panel)", boxShadow: shadow }}>
            {body}
          </div>
        )}
      </div>
    );
  return (
    <div
      onClick={select}
      className={`flex flex-col overflow-hidden rounded-lg border ${ring} ${hidden ? "opacity-40" : ""}`}
      style={{ background: backgroundOf(c.background) ?? (compact ? "transparent" : "var(--color-panel)"), boxShadow: shadow, ...style }}
      data-widget={w.id}
      {...dropProps}
    >
      {titleBar}
      {body}
    </div>
  );
}

/** A 12-column grid of widgets — the page, a tab, a section, an overlay, the header or an embedded module — or, for a
 * section's rows / columns / toolbar / flow layout, the widgets in order (y, then x). */
export function Canvas({
  widgets,
  minRows = 12,
  nested = false,
  layout = "grid",
  transparent = false,
  editing,
  selected,
  onSelect,
  onChange,
  onDrop,
  state,
}: {
  widgets: Widget[];
  minRows?: number;
  /** inside a tab, a section, an overlay or an embedded module: fills its box */
  nested?: boolean;
  layout?: SectionLayout;
  /** the page has its own background */
  transparent?: boolean;
  editing: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, c: Partial<Widget>) => void;
  onDrop: (type: WidgetType, x: number, y: number) => void;
  state: ModuleState;
}) {
  // a mobile module: every grid is one column of its widgets in order (y, then x), full width
  if (state.mobile && layout === "grid") layout = "flow";
  const [ref, { w: width }] = useSize<HTMLDivElement>();
  const colW = (Math.max(width, 400) - GAP * (COLS + 1)) / COLS;
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [over, setOver] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const placed = editing ? null : reflow(widgets, state);
  const rows = Math.max(minRows, widgets.reduce((m, w) => Math.max(m, (placed?.get(w.id)?.y ?? w.y) + (placed?.get(w.id)?.h ?? w.h)), 0) + (editing ? 6 : 1));

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const dx = Math.round((e.clientX - drag.sx) / (colW + GAP));
      const dy = Math.round((e.clientY - drag.sy) / (ROW + GAP));
      if (drag.mode === "move") onChange(drag.id, { x: Math.max(0, Math.min(COLS - drag.ow, drag.ox + dx)), y: Math.max(0, drag.oy + dy) });
      else onChange(drag.id, { w: Math.max(1, Math.min(COLS - drag.ox, drag.ow + dx)), h: Math.max(1, drag.oh + dy) });
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, colW, onChange]);

  const cellAt = (clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.floor((clientX - r.left - GAP) / (colW + GAP))),
      y: Math.max(0, Math.floor((clientY - r.top - GAP) / (ROW + GAP))),
    };
  };
  const start = (e: ReactPointerEvent, w: Widget, mode: "move" | "resize") => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(w.id);
    setDrag({ id: w.id, mode, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y, ow: w.w, oh: w.h });
  };

  if (layout !== "grid") {
    const ordered = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x).filter((w) => editing || !isHidden(w, state));
    const row = layout === "columns" || layout === "toolbar";
    const itemStyle = (w: Widget): CSSProperties => {
      const collapsed = !editing && isCollapsed(w, state);
      if (layout === "columns") return { flex: `${w.w} 1 0`, minWidth: 0 };
      if (layout === "toolbar") return { flex: `0 0 calc(${(w.w / COLS) * 100}% - ${GAP}px)`, minWidth: 120, height: ROW };
      if (layout === "rows") return collapsed ? { flex: "0 0 auto" } : { flex: `${w.h} 1 0`, minHeight: 0 };
      return { flex: "0 0 auto", height: collapsed ? undefined : w.h * ROW + (w.h - 1) * GAP }; // flow
    };
    return (
      <div
        ref={ref}
        className={`flex ${nested ? "h-full" : "min-h-0 flex-1"} min-w-0 gap-2 p-2 ${row ? "flex-row" : "flex-col"} ${layout === "toolbar" ? "flex-wrap items-center" : ""} ${layout === "flow" ? "overflow-auto" : "overflow-hidden"} ${editing ? `dot-grid ${over ? "ring-2 ring-inset ring-ocean/60" : ""}` : ""}`}
        onClick={(e) => (e.stopPropagation(), editing && onSelect(null))}
        onDragOver={(e) => {
          if (!editing || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          const type = e.dataTransfer.getData(DRAG_TYPE) as WidgetType;
          setOver(false);
          if (!type) return;
          e.preventDefault();
          e.stopPropagation();
          // appended after the last widget
          onDrop(type, 0, widgets.reduce((m, w) => Math.max(m, w.y + 1), 0));
        }}
        data-layout-kind={layout}
      >
        {ordered.length === 0 && editing && <div className="m-auto text-xs text-muted">Drop widgets here ({layout})</div>}
        {ordered.map((w) => (
          <Frame key={w.id} w={w} state={state} editing={editing} on={editing && selected === w.id} hidden={isHidden(w, state)} onSelect={onSelect} style={itemStyle(w)} compact={layout === "toolbar"}>
            <WidgetView widget={w} state={state} editing={editing} />
          </Frame>
        ))}
      </div>
    );
  }

  return (
    <div ref={scroller} className={`min-w-0 ${nested ? "h-full" : "flex-1"} overflow-auto ${editing ? "dot-grid" : nested || transparent ? "" : "bg-ink"}`} onClick={(e) => (e.stopPropagation(), editing && onSelect(null))}>
      <div
        ref={ref}
        className="relative"
        style={{ height: rows * (ROW + GAP) + GAP, cursor: drag ? (drag.mode === "move" ? "grabbing" : "nwse-resize") : undefined }}
        onDragOver={(e) => {
          if (!editing || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          const { x, y } = cellAt(e.clientX, e.clientY);
          setGhost({ x: Math.min(x, COLS - 3), y, w: 3, h: 3 });
        }}
        // leaving for a widget inside the grid is not leaving the grid
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setGhost(null)}
        onDrop={(e) => {
          const type = e.dataTransfer.getData(DRAG_TYPE) as WidgetType;
          setGhost(null);
          if (!type) return;
          e.preventDefault();
          e.stopPropagation();
          const { x, y } = cellAt(e.clientX, e.clientY);
          onDrop(type, x, y);
        }}
      >
        {ghost && (
          <div
            className="pointer-events-none absolute rounded-lg border-2 border-dashed border-ocean/70 bg-ocean/10"
            style={{ left: GAP + ghost.x * (colW + GAP), top: GAP + ghost.y * (ROW + GAP), width: ghost.w * colW + (ghost.w - 1) * GAP, height: ghost.h * ROW + (ghost.h - 1) * GAP }}
          />
        )}
        {widgets.length === 0 && (
          <div className="absolute inset-x-0 top-24 text-center text-sm text-muted">
            {editing ? "Drag widgets here from the left" : nested ? "" : "This module is empty. Switch to Edit to add widgets."}
          </div>
        )}
        {widgets.map((w) => {
          // conditional visibility: hidden in view mode, dimmed while editing
          const hidden = isHidden(w, state);
          if (hidden && !editing) return null;
          const on = editing && selected === w.id;
          const y = placed?.get(w.id)?.y ?? w.y;
          const h = placed?.get(w.id)?.h ?? w.h;
          return (
            <Frame
              key={w.id}
              w={w}
              state={state}
              editing={editing}
              on={on}
              hidden={hidden}
              onSelect={onSelect}
              onMove={(e) => start(e, w, "move")}
              style={{
                position: "absolute",
                left: GAP + w.x * (colW + GAP),
                top: GAP + y * (ROW + GAP),
                width: w.w * colW + (w.w - 1) * GAP,
                height: h * ROW + (h - 1) * GAP,
                transition: drag?.id === w.id ? "none" : "left 80ms, top 80ms, width 80ms, height 80ms",
                opacity: drag?.id === w.id ? 0.8 : undefined,
              }}
            >
              <div className={`h-full ${editing && drag ? "pointer-events-none" : ""}`}>
                <WidgetView widget={w} state={state} editing={editing} />
              </div>
              {editing && (
                <div
                  onPointerDown={(e) => start(e, w, "resize")}
                  className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
                  title="Resize"
                  style={{ background: "linear-gradient(135deg, transparent 50%, var(--color-ocean) 50%)", opacity: on ? 1 : 0.4 }}
                />
              )}
            </Frame>
          );
        })}
      </div>
    </div>
  );
}
