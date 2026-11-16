"use client";

/** The Slate canvas: a page's widgets on a 12-column grid (rows of 40 px), the toolbar above, dialogs and toasts on
 *  top. In edit mode widgets are selected, dragged (snapping to the grid) and resized. */
import { useRef, useState } from "react";
import type { SlateWidget } from "@/lib/slate";
import type { SlateRuntime } from "@/lib/slateRuntime";
import type { Scope } from "@/lib/slateHandlebars";
import { WidgetBody } from "./SlateWidgets";

export const ROW = 40;

/** "color: red; padding: 4px" → React style. */
export function cssDeclarations(css: string | undefined): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of (css ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || !v || /expression|url\s*\(\s*['"]?javascript/i.test(v)) continue;
    out[k.startsWith("--") ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as React.CSSProperties;
}

const truthy = (v: unknown) => !(v === false || v === null || v === undefined || v === "" || v === "false" || v === 0);

type Props = {
  rt: SlateRuntime;
  scope: Scope;
  widgets: SlateWidget[];
  toolbar: SlateWidget[];
  editing: boolean;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (id: string, patch: Partial<SlateWidget>) => void;
};

export function SlateCanvas({ rt, scope, widgets, toolbar, editing, selected, onSelect, onChange }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "resize"; sx: number; sy: number; w: SlateWidget } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const floating = widgets.filter((w) => w.type === "dialog" || w.type === "toast");
  const placed = widgets.filter((w) => editing || (w.type !== "dialog" && w.type !== "toast"));
  const height = Math.max(12, ...placed.map((w) => w.y + w.h + 2)) * ROW;

  const box = (w: SlateWidget) => {
    const p = rt.widgetProps(w, scope);
    if (!editing && w.hidden && rtHidden(w, scope)) return null;
    const kids = (w.children ?? []).map((c) => (
      <div key={c.id} style={{ height: c.h * ROW, ...cssDeclarations(c.css) }} className={`relative shrink-0 ${c.classes ?? ""} ${editing && selected === c.id ? "outline outline-2 outline-ocean" : ""}`} onMouseDown={(e) => {
        if (!editing) return;
        e.stopPropagation();
        onSelect?.(c.id);
      }}>
        {box(c)}
      </div>
    ));
    const body = <WidgetBody w={w} p={p} rt={rt}>{kids}</WidgetBody>;
    if (w.type === "dialog") return editing ? <div className="h-full overflow-auto rounded border border-dashed border-ocean/50 p-2"><div className="mb-1 text-[11px] text-ocean">Dialog · {String(p.title ?? "")}</div><div className="space-y-2">{kids}</div></div> : null;
    if (w.type === "toast") return editing ? <div className="flex h-full items-center rounded border border-dashed border-warn/50 px-2 text-[11px] text-warn">Toast · {String(p.message ?? "")}</div> : null;
    return body;
  };

  const onMouseDown = (e: React.MouseEvent, w: SlateWidget, mode: "move" | "resize") => {
    if (!editing) return;
    e.stopPropagation();
    onSelect?.(w.id);
    if ((e.target as HTMLElement).closest("input,select,textarea,button,iframe,[data-slate-drag]") && mode === "move") return;
    setDrag({ id: w.id, mode, sx: e.clientX, sy: e.clientY, w });
    setGhost({ x: w.x, y: w.y, w: w.w, h: w.h });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag || !ref.current) return;
    const col = ref.current.clientWidth / 12;
    const dx = Math.round((e.clientX - drag.sx) / col);
    const dy = Math.round((e.clientY - drag.sy) / ROW);
    const w = drag.w;
    setGhost(
      drag.mode === "move"
        ? { x: Math.min(12 - w.w, Math.max(0, w.x + dx)), y: Math.max(0, w.y + dy), w: w.w, h: w.h }
        : { x: w.x, y: w.y, w: Math.min(12 - w.x, Math.max(1, w.w + dx)), h: Math.max(1, w.h + dy) },
    );
  };
  const onMouseUp = () => {
    if (drag && ghost) onChange?.(drag.id, ghost);
    setDrag(null);
    setGhost(null);
  };

  const place = (w: SlateWidget) => {
    const g = drag?.id === w.id && ghost ? ghost : w;
    return { left: `${(g.x / 12) * 100}%`, top: g.y * ROW, width: `${(g.w / 12) * 100}%`, height: g.h * ROW };
  };

  return (
    <div className="slate-app flex min-h-full flex-col" onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
      <style>{rt.doc.styles.css}</style>
      {toolbar.length > 0 && (
        <div className="slate-toolbar flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2">
          {toolbar.map((w) => (
            <div key={w.id} style={{ width: `${(w.w / 12) * 100}%`, height: w.h * ROW, ...cssDeclarations(w.css) }} className={`relative ${w.classes ?? ""} ${editing && selected === w.id ? "outline outline-2 outline-ocean" : ""}`} onMouseDown={(e) => editing && (e.stopPropagation(), onSelect?.(w.id))}>
              {box(w)}
            </div>
          ))}
        </div>
      )}
      <div ref={ref} className="relative flex-1" style={{ minHeight: height }} onMouseDown={() => editing && onSelect?.(null)}>
        {editing && <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)", backgroundSize: `calc(100% / 12) ${ROW}px` }} />}
        {placed.map((w) => {
          const out = box(w);
          if (out === null && !editing) return null;
          return (
            <div
              key={w.id}
              data-slate-widget={w.id}
              style={{ position: "absolute", ...place(w), padding: 4 }}
              onMouseDown={(e) => onMouseDown(e, w, "move")}
              className={editing ? `group ${selected === w.id ? "z-10" : ""}` : ""}
            >
              <div style={cssDeclarations(w.css)} className={`relative h-full ${w.classes ?? ""} ${editing ? `rounded ${selected === w.id ? "outline outline-2 outline-ocean" : "group-hover:outline group-hover:outline-1 group-hover:outline-line-2"}` : ""}`}>
                {out}
                {editing && (
                  <>
                    <span className="pointer-events-none absolute -top-4 left-0 hidden rounded bg-ocean px-1 font-mono text-[10px] text-white group-hover:block">{w.id}</span>
                    <span onMouseDown={(e) => onMouseDown(e, w, "resize")} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize rounded-sm bg-ocean opacity-0 group-hover:opacity-100" />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!editing &&
        floating.map((w) => {
          const p = rt.widgetProps(w, scope);
          if (!truthy(p.open)) return null;
          if (w.type === "toast")
            return (
              <div key={w.id} data-slate-widget={w.id} className={`fixed bottom-5 right-5 z-50 rounded-lg px-4 py-2.5 text-sm text-white shadow-lg ${p.intent === "danger" ? "bg-bad" : p.intent === "warning" ? "bg-warn" : "bg-ok"}`}>
                {String(p.message ?? "")}
              </div>
            );
          return (
            <div key={w.id} className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onMouseDown={() => rt.act(`${w.id}.close`, null)}>
              <div data-slate-widget={w.id} onMouseDown={(e) => e.stopPropagation()} style={cssDeclarations(w.css)} className={`max-h-[85vh] w-[min(42rem,92vw)] overflow-auto rounded-xl border border-line bg-panel p-4 ${w.classes ?? ""}`}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex-1 font-medium">{String(p.title ?? "")}</span>
                  <button type="button" onClick={() => rt.act(`${w.id}.close`, null)} className="text-muted hover:text-white" aria-label="Close">
                    ✕
                  </button>
                </div>
                <div className="space-y-2">
                  {(w.children ?? []).map((c) => (
                    <div key={c.id} style={{ height: c.h * ROW }}>
                      <WidgetBody w={c} p={rt.widgetProps(c, scope)} rt={rt} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}

function rtHidden(w: SlateWidget, scope: Scope) {
  // `hidden` is a template: {{v_showDetails}} hides the widget when truthy
  const v = w.hidden ?? "";
  const m = /^\{\{\s*(!)?\s*([^}]+?)\s*\}\}$/.exec(v.trim());
  if (!m) return truthy(v);
  const path = m[2].split(".");
  let cur: unknown = scope;
  for (const k of path) cur = cur == null ? undefined : (cur as Record<string, unknown>)[k];
  return m[1] ? !truthy(cur) : truthy(cur);
}
