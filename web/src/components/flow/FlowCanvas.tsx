"use client";

import { useRef, useState } from "react";
import { defOf, inPort, inputCount, labelOf, nodeSize, outPort, outputCount, snap, UNKNOWN_DEF, wirePath, type FlowNode } from "@/lib/flow";
import type { NodeStatus } from "@/lib/flowRuntime";
import { iconPath } from "../Icon";

export type WireRef = { from: string; port: number; to: string };
export const PALETTE_MIME = "application/x-flow-node";

const STATUS_FILL: Record<NonNullable<NodeStatus["fill"]>, string> = {
  red: "#c00",
  green: "#5a8",
  yellow: "#f9df31",
  blue: "#53a3f3",
  grey: "#d3d3d3",
};
const SELECTED = "#ff7f0e";

export function FlowCanvas({
  nodes,
  selected,
  wire,
  zoom,
  statuses,
  changed,
  onSelect,
  onSelectWire,
  onMoveStart,
  onMove,
  onConnect,
  onOpen,
  onDrop,
  onButton,
}: {
  nodes: FlowNode[];
  selected: string[];
  wire: WireRef | null;
  zoom: number;
  statuses: Record<string, NodeStatus>;
  /** nodes changed since the last deploy (Node-RED's blue dot) */
  changed: Set<string>;
  onSelect: (ids: string[]) => void;
  onSelectWire: (w: WireRef | null) => void;
  onMoveStart: () => void;
  onMove: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (w: WireRef) => void;
  onOpen: (id: string) => void;
  onDrop: (type: string, x: number, y: number) => void;
  onButton: (id: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [temp, setTemp] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [lasso, setLasso] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sel = new Set(selected);

  const width = nodes.reduce((m, n) => Math.max(m, n.x + 600), 3000);
  const height = nodes.reduce((m, n) => Math.max(m, n.y + 400), 2000);

  const point = (clientX: number, clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  };

  const track = (move: (e: PointerEvent) => void, up: (e: PointerEvent) => void) => {
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      up(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
  };

  const nodeDown = (e: React.PointerEvent, n: FlowNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelectWire(null);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      onSelect(sel.has(n.id) ? selected.filter((s) => s !== n.id) : [...selected, n.id]);
      return;
    }
    const ids = sel.has(n.id) ? selected : [n.id];
    if (!sel.has(n.id)) onSelect(ids);
    const start = Object.fromEntries(ids.map((id) => [id, { x: byId.get(id)!.x, y: byId.get(id)!.y }]));
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    track(
      (ev) => {
        if (!moved) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
          moved = true;
          onMoveStart();
        }
        const dx = (ev.clientX - sx) / zoom;
        const dy = (ev.clientY - sy) / zoom;
        onMove(Object.fromEntries(Object.entries(start).map(([id, p]) => [id, { x: Math.max(20, snap(p.x + dx)), y: Math.max(20, snap(p.y + dy)) }])));
      },
      () => {},
    );
  };

  const portDown = (e: React.PointerEvent, n: FlowNode, port: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const from = outPort(n, port);
    setTemp({ x1: from.x, y1: from.y, x2: from.x, y2: from.y });
    track(
      (ev) => {
        const p = point(ev.clientX, ev.clientY);
        setTemp({ x1: from.x, y1: from.y, x2: p.x, y2: p.y });
      },
      (ev) => {
        setTemp(null);
        const p = point(ev.clientX, ev.clientY);
        // dropped on a node (or close to its input port) that takes input
        const target = nodes.find((t) => {
          if (t.id === n.id || !inputCount(t)) return false;
          const { w, h } = nodeSize(t);
          const ip = inPort(t);
          return (Math.abs(p.x - t.x) <= w / 2 + 6 && Math.abs(p.y - t.y) <= h / 2 + 6) || Math.hypot(p.x - ip.x, p.y - ip.y) < 14;
        });
        if (target) onConnect({ from: n.id, port, to: target.id });
      },
    );
  };

  const backgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!additive) onSelect([]);
    onSelectWire(null);
    const p0 = point(e.clientX, e.clientY);
    setLasso({ x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y });
    track(
      (ev) => {
        const p = point(ev.clientX, ev.clientY);
        setLasso({ x0: p0.x, y0: p0.y, x1: p.x, y1: p.y });
      },
      (ev) => {
        setLasso(null);
        const p = point(ev.clientX, ev.clientY);
        if (Math.abs(p.x - p0.x) + Math.abs(p.y - p0.y) < 4) return;
        const [x0, x1] = [Math.min(p0.x, p.x), Math.max(p0.x, p.x)];
        const [y0, y1] = [Math.min(p0.y, p.y), Math.max(p0.y, p.y)];
        const inside = nodes.filter((n) => n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1).map((n) => n.id);
        onSelect(additive ? [...new Set([...selected, ...inside])] : inside);
      },
    );
  };

  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-auto bg-ink"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PALETTE_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const type = e.dataTransfer.getData(PALETTE_MIME);
        if (!type) return;
        e.preventDefault();
        const p = point(e.clientX, e.clientY);
        onDrop(type, p.x, p.y);
      }}
    >
      <svg
        ref={svg}
        width={width * zoom}
        height={height * zoom}
        viewBox={`0 0 ${width} ${height}`}
        onPointerDown={backgroundDown}
        className="block select-none"
        style={{ touchAction: "none" }}
      >
        <defs>
          <pattern id="flow-grid" width={20} height={20} patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="var(--color-line)" strokeWidth={1} />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#flow-grid)" />

        {/* wires */}
        {nodes.flatMap((n) =>
          n.wires.flatMap((targets, port) =>
            targets.map((to) => {
              const t = byId.get(to);
              if (!t || port >= outputCount(n)) return null;
              const a = outPort(n, port);
              const b = inPort(t);
              const d = wirePath(a.x, a.y, b.x, b.y);
              const on = wire?.from === n.id && wire.port === port && wire.to === to;
              const linked = sel.has(n.id) || sel.has(to);
              return (
                <g
                  key={`${n.id}:${port}:${to}`}
                  className="cursor-pointer"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect([]);
                    onSelectWire({ from: n.id, port, to });
                  }}
                >
                  <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
                  <path
                    d={d}
                    fill="none"
                    stroke={on || linked ? SELECTED : "#8a94a3"}
                    strokeWidth={on ? 4 : 3}
                    strokeDasharray={n.d || t.d ? "6 4" : undefined}
                  />
                </g>
              );
            }),
          ),
        )}
        {temp && <path d={wirePath(temp.x1, temp.y1, temp.x2, temp.y2)} fill="none" stroke={SELECTED} strokeWidth={3} strokeDasharray="6 4" pointerEvents="none" />}

        {/* nodes */}
        {nodes.map((n) => (
          <NodeShape
            key={n.id}
            node={n}
            selected={sel.has(n.id)}
            status={statuses[n.id]}
            changed={changed.has(n.id)}
            onPointerDown={(e) => nodeDown(e, n)}
            onDoubleClick={() => onOpen(n.id)}
            onPort={(e, i) => portDown(e, n, i)}
            onButton={() => onButton(n.id)}
          />
        ))}

        {lasso && (
          <rect
            x={Math.min(lasso.x0, lasso.x1)}
            y={Math.min(lasso.y0, lasso.y1)}
            width={Math.abs(lasso.x1 - lasso.x0)}
            height={Math.abs(lasso.y1 - lasso.y0)}
            fill="rgba(61,139,253,0.08)"
            stroke="var(--color-ocean)"
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}
      </svg>
    </div>
  );
}

function NodeShape({
  node: n,
  selected,
  status,
  changed,
  onPointerDown,
  onDoubleClick,
  onPort,
  onButton,
}: {
  node: FlowNode;
  selected: boolean;
  status?: NodeStatus;
  changed: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onPort: (e: React.PointerEvent, port: number) => void;
  onButton: () => void;
}) {
  const def = defOf(n);
  const { w, h } = nodeSize(n);
  const outs = outputCount(n);
  const ins = inputCount(n);
  // output-type nodes (debug, mqtt out …) carry their icon on the right, as in Node-RED
  const iconRight = ins > 0 && outs === 0;
  const unknown = def === UNKNOWN_DEF;
  const label = labelOf(n);
  const maxChars = Math.floor((w - 46) / 7);
  const shown = label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
  const debugOn = n.active !== false;
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <g transform={`translate(${n.x - w / 2},${n.y - h / 2})`} opacity={n.d ? 0.45 : 1}>
      {def.button === "left" && (
        <g className="cursor-pointer" onPointerDown={stop} onClick={onButton}>
          <title>Inject now</title>
          <rect x={-24} y={2} width={30} height={h - 4} rx={5} fill="#eee" stroke="#999" />
          <rect x={-19} y={5} width={16} height={h - 10} rx={2} fill={def.color} stroke="#999" />
        </g>
      )}
      {def.button === "right" && (
        <g className="cursor-pointer" onPointerDown={stop} onClick={onButton}>
          <title>{debugOn ? "Turn this debug node off" : "Turn this debug node on"}</title>
          <rect x={w - 6} y={2} width={30} height={h - 4} rx={5} fill="#eee" stroke="#999" />
          <rect x={w + 3} y={5} width={16} height={h - 10} rx={2} fill={debugOn ? def.color : "#eee"} stroke="#999" />
        </g>
      )}

      <g onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} className="cursor-move">
        <title>{`${label} (${n.type}) — double-click to edit`}</title>
        <rect
          width={w}
          height={h}
          rx={5}
          fill={def.color}
          stroke={selected ? SELECTED : unknown ? "#c00" : "#999"}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray={n.d || unknown ? "5 3" : undefined}
        />
        {n.type !== "comment" && (
          <>
            <path d={iconRight ? `M${w - 30} 0h25a5 5 0 0 1 5 5v${h - 10}a5 5 0 0 1-5 5h-25z` : `M5 0h25v${h}h-25a5 5 0 0 1-5-5v-${h - 10}a5 5 0 0 1 5-5z`} fill="#000" fillOpacity={0.06} />
            <line x1={iconRight ? w - 30 : 30} x2={iconRight ? w - 30 : 30} y1={0} y2={h} stroke="#000" strokeOpacity={0.1} />
            <g transform={`translate(${(iconRight ? w - 30 : 0) + 7},${h / 2 - 8}) scale(0.667)`}>
              <path d={iconPath(def.icon)} fill="none" stroke="#333" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </>
        )}
        <text
          x={n.type === "comment" ? 10 : iconRight ? 10 : 38}
          y={h / 2}
          dominantBaseline="central"
          fontSize={13}
          fill="#333"
          fontStyle={n.type === "comment" ? "italic" : undefined}
          className="pointer-events-none"
        >
          {shown}
        </text>
        {def.runtime === "gateway" && (
          <g transform={`translate(${w - (iconRight ? 44 : 14)},${h / 2 - 5})`}>
            <title>Runs on the device gateway</title>
            <rect width={10} height={10} rx={2} fill="none" stroke="#555" strokeWidth={1.2} />
            <path d="M2.5 3.5h5M2.5 6.5h5" stroke="#555" strokeWidth={1.2} />
          </g>
        )}
      </g>

      {changed && <circle cx={w - 1} cy={1} r={4} fill="#00bcff" stroke="#fff" strokeWidth={1}><title>Changed since the last deploy</title></circle>}

      {ins > 0 && <rect x={-5} y={h / 2 - 5} width={10} height={10} rx={3} fill="#d9d9d9" stroke="#999" className="pointer-events-none" />}
      {Array.from({ length: outs }, (_, i) => {
        const y = outPort(n, i).y - (n.y - h / 2);
        return (
          <rect
            key={i}
            x={w - 5}
            y={y - 5}
            width={10}
            height={10}
            rx={3}
            fill="#d9d9d9"
            stroke="#999"
            className="cursor-crosshair hover:fill-[#ff7f0e]"
            onPointerDown={(e) => onPort(e, i)}
          >
            <title>{outs > 1 ? `Output ${i + 1} — drag to wire` : "Drag to wire"}</title>
          </rect>
        );
      })}

      {status && (status.fill || status.text) && (
        <g transform={`translate(3,${h + 4})`} className="pointer-events-none">
          {status.fill &&
            (status.shape === "ring" ? (
              <rect x={0.5} y={0.5} width={8} height={8} rx={2} fill="#fff" stroke={STATUS_FILL[status.fill]} strokeWidth={2} />
            ) : (
              <rect width={9} height={9} rx={2} fill={STATUS_FILL[status.fill]} stroke="#999" strokeWidth={0.5} />
            ))}
          {status.text && (
            <text x={status.fill ? 14 : 0} y={5} dominantBaseline="central" fontSize={11} fill="var(--color-muted)">
              {status.text}
            </text>
          )}
        </g>
      )}
    </g>
  );
}
