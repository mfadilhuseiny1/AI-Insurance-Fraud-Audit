"use client";

import { useState } from "react";
import { CATEGORIES, NODE_DEFS, type NodeDef } from "@/lib/flow";
import { Icon, iconPath } from "../Icon";
import { PALETTE_MIME } from "./FlowCanvas";

/** Node-RED's palette: nodes by category, dragged onto the canvas (or clicked to add). */
export function FlowPalette({ onAdd }: { onAdd: (type: string) => void }) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();
  const match = (d: NodeDef) => !q || d.label.includes(q) || d.type.includes(q) || d.info.toLowerCase().includes(q);

  return (
    <aside className="flex w-48 shrink-0 flex-col border-r border-line bg-panel">
      <div className="border-b border-line p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1">
          <Icon name="search" className="h-3.5 w-3.5 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter nodes" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {CATEGORIES.map((c) => {
          const defs = NODE_DEFS.filter((d) => d.category === c.id && match(d));
          if (!defs.length) return null;
          const open = !!q || !closed.has(c.id);
          return (
            <section key={c.id}>
              <button
                type="button"
                onClick={() => setClosed((s) => (s.has(c.id) ? new Set([...s].filter((x) => x !== c.id)) : new Set([...s, c.id])))}
                className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-soft"
              >
                <Icon name={open ? "down" : "right"} className="h-3 w-3" />
                {c.label}
              </button>
              {open && (
                <div className="space-y-1.5 px-3 pb-2">
                  {defs.map((d) => (
                    <PaletteNode key={d.type} def={d} onAdd={() => onAdd(d.type)} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function PaletteNode({ def, onAdd }: { def: NodeDef; onAdd: () => void }) {
  const outs = typeof def.outputs === "number" ? def.outputs : 1;
  const right = def.inputs > 0 && outs === 0;
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PALETTE_MIME, def.type);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDoubleClick={onAdd}
      title={`${def.info}\n\nDrag onto the canvas, or double-click to add.`}
      className="relative flex h-7 cursor-grab items-center rounded-[5px] border border-[#999] text-[12px] text-[#333] active:cursor-grabbing"
      style={{ background: def.color }}
    >
      {def.inputs > 0 && <span className="absolute -left-[5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-[3px] border border-[#999] bg-[#d9d9d9]" />}
      {outs > 0 && <span className="absolute -right-[5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-[3px] border border-[#999] bg-[#d9d9d9]" />}
      <span className={`flex h-full w-6 shrink-0 items-center justify-center bg-black/5 ${right ? "order-2 ml-auto border-l" : "border-r"} border-black/10`}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="#333" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={iconPath(def.icon)} />
        </svg>
      </span>
      <span className={`truncate px-2 ${right ? "order-1" : ""}`}>{def.label}</span>
      {def.runtime === "gateway" && <span className={`mr-1.5 text-[9px] text-[#555] ${right ? "order-1" : "ml-auto"}`}>gw</span>}
    </div>
  );
}
