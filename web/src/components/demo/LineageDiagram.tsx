"use client";

import { useMemo, useState } from "react";

export type PipeGraph = {
  groups: { id: string; name: string; hex: string }[];
  nodes: { id: string; name: string; kind: "source" | "sql" | "union" | "join"; group: string; x: number; y: number; doc?: string | null }[];
  edges: [string, string][];
  outputs: { name: string; node: string; backs: boolean }[];
};

const KIND: Record<string, { badge: string; label: string }> = {
  source: { badge: "▤", label: "Sumber (Files)" },
  sql: { badge: "ƒx", label: "Transformasi SQL" },
  union: { badge: "∪", label: "Union" },
  join: { badge: "⋈", label: "Left join" },
};
const BOX_W = 230;
const BOX_H = 52;
const GAP = 16;

/** Boxes of one column moved apart, in order, so none overlaps: each stays as close as it can to where it wants to be. */
function spread<T extends { y: number }>(items: T[], gap = BOX_H + GAP): void {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const want = sorted.map((b) => b.y);
  for (let i = 1; i < sorted.length; i++) sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + gap);
  // pushing only moves boxes down: shift the column back up by half the average push (gaps stay as they are)
  const push = sorted.reduce((a, b, i) => a + (b.y - want[i]), 0) / Math.max(1, sorted.length);
  for (const b of sorted) b.y -= push / 2;
}

/**
 * The whole data pipeline as Pipeline Builder draws it — every source, cleaning step, union, join and transform in
 * its colour group, then the outputs, the object types they back and the apps on top. Hover a box to light up its
 * lineage; click it for what it does (its SQL for a transform). Zoom with the buttons, pan by scrolling.
 */
export function LineageDiagram({ graph, rows, backs, objectCounts, sql }: {
  graph: PipeGraph;
  rows: Record<string, number>;
  backs: Record<string, string>;
  objectCounts: Record<string, number>;
  sql: Record<string, string>;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.6);
  const color = useMemo(() => Object.fromEntries(graph.groups.map((g) => [g.id, g.hex])), [graph.groups]);
  const short = (s: string) => s.replace(/\s*\(demo\)\s*$/, "").replace(/ JKN$/, "");

  // the pipeline's own boxes, then three columns to its right: outputs, object types, apps
  const layout = useMemo(() => {
    const strip = (s: string) => s.replace(/\s*\(demo\)\s*$/, "").replace(/ JKN$/, "");
    const pos: Record<string, { x: number; y: number }> = {};
    for (const n of graph.nodes) pos[n.id] = { x: n.x, y: n.y };
    const xmax = Math.max(...graph.nodes.map((n) => n.x));
    const xo = xmax + 340;
    const xt = xo + 340;
    const xa = xt + 340;
    const boxes: { id: string; label: string; sub: string; hex: string; badge: string; x: number; y: number; kind: string }[] = [];
    for (const n of graph.nodes) {
      boxes.push({ id: n.id, label: n.name, sub: n.kind === "source" ? `${(rows[n.name] ?? 0).toLocaleString("id-ID")} baris` : KIND[n.kind].label,
        hex: color[n.group] ?? "#718096", badge: KIND[n.kind].badge, x: n.x, y: n.y, kind: n.kind });
    }
    const byX = new Map<number, typeof boxes>();
    for (const b of boxes) byX.set(b.x, [...(byX.get(b.x) ?? []), b]);
    for (const col of byX.values()) spread(col);
    for (const b of boxes) pos[b.id] = { x: b.x, y: b.y };
    const edges: [string, string][] = [...graph.edges];
    for (const o of graph.outputs) {
      const id = `out:${o.name}`;
      boxes.push({ id, label: `${o.name}.parquet`, sub: `output · ${(rows[o.name] ?? 0).toLocaleString("id-ID")} baris`, hex: "#22c55e", badge: "⇥", x: xo, y: pos[o.node].y, kind: "output" });
      pos[id] = { x: xo, y: pos[o.node].y };
      edges.push([o.node, id]);
      if (o.backs && backs[o.name]) {
        const tid = `ot:${o.name}`;
        boxes.push({ id: tid, label: strip(backs[o.name]), sub: `object type · ${(objectCounts[backs[o.name]] ?? 0).toLocaleString("id-ID")} objek`, hex: "#f97316", badge: "◆", x: xt, y: pos[o.node].y, kind: "ontology" });
        pos[tid] = { x: xt, y: pos[o.node].y };
        edges.push([id, tid]);
      }
    }
    spread(boxes.filter((b) => b.kind === "output"));
    for (const b of boxes.filter((b) => b.kind === "ontology")) b.y = boxes.find((o) => o.id === `out:${b.id.slice(3)}`)!.y;
    spread(boxes.filter((b) => b.kind === "ontology"));
    for (const b of boxes) pos[b.id] = { x: b.x, y: b.y };
    const types = boxes.filter((b) => b.kind === "ontology");
    const midY = types.length ? types.reduce((a, b) => a + b.y, 0) / types.length : 300;
    const apps = [
      { id: "app:map", label: "Peta audit faskes", sub: "titik faskes + alur rujukan", from: ["ot:faskes_audit", "ot:kasus_berisiko"] },
      { id: "app:vertex", label: "Vertex", sub: "graph alur, template, function", from: types.map((t) => t.id) },
      { id: "app:workshop", label: "Kokpit audit (Workshop)", sub: "metrik, function, actions", from: ["ot:faskes_audit", "ot:kasus_berisiko"] },
      { id: "app:actions", label: "Actions", sub: "keputusan tim audit", from: types.map((t) => t.id) },
    ];
    apps.forEach((a, i) => {
      const y = midY + (i - 1.5) * 110;
      boxes.push({ id: a.id, label: a.label, sub: a.sub, hex: "#ef4444", badge: "▣", x: xa, y, kind: "app" });
      pos[a.id] = { x: xa, y };
      for (const f of a.from) if (pos[f]) edges.push([f, a.id]);
    });
    const minY = Math.min(...boxes.map((b) => b.y)) - 60;
    const maxY = Math.max(...boxes.map((b) => b.y)) + BOX_H + 40;
    return { boxes, edges, pos, width: xa + BOX_W + 40, minY, height: maxY - minY, cols: { xo, xt, xa } };
  }, [graph, rows, backs, objectCounts, color]);

  // what the hovered box comes from and feeds
  const lit = useMemo(() => {
    if (!hover) return null;
    const up = new Set([hover]);
    const down = new Set([hover]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [a, b] of layout.edges) {
        if (up.has(b) && !up.has(a)) {
          up.add(a);
          grew = true;
        }
        if (down.has(a) && !down.has(b)) {
          down.add(b);
          grew = true;
        }
      }
    }
    return new Set([...up, ...down]);
  }, [hover, layout.edges]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of graph.nodes) c[n.group] = (c[n.group] ?? 0) + 1;
    return c;
  }, [graph.nodes]);
  const node = graph.nodes.find((n) => n.id === picked);
  const out = graph.outputs.find((o) => `out:${o.name}` === picked);
  const zoomButtons: [string, () => void][] = [
    ["−", () => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2)))],
    ["+", () => setZoom((z) => Math.min(1.2, +(z + 0.1).toFixed(2)))],
    ["⤢", () => setZoom(0.6)],
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-[11px]">
        <span className="font-semibold">Legend</span>
        {graph.groups.map((g) => (
          <span key={g.id} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: g.hex }} />
            {g.name} <span className="tabular-nums text-muted">({counts[g.id] ?? 0})</span>
          </span>
        ))}
        {([["#22c55e", `Output dataset (${graph.outputs.length})`], ["#f97316", "Object type (Nexus)"], ["#ef4444", "Aplikasi"]] as [string, string][]).map(([hex, label]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: hex }} />
            {label}
          </span>
        ))}
      </div>
      <div className="relative overflow-hidden rounded-xl border border-line bg-ink">
        <div className="absolute left-3 top-3 z-10 flex gap-1">
          {zoomButtons.map(([l, f]) => (
            <button key={l} type="button" onClick={f} className="h-7 w-7 rounded border border-line-2 bg-panel text-sm hover:border-ocean">{l}</button>
          ))}
          <span className="ml-1 self-center text-[11px] text-muted">{Math.round(zoom * 100)}% · {graph.nodes.length} node · {graph.outputs.length} output</span>
        </div>
        <div className="max-h-[640px] overflow-auto pt-12" style={{ backgroundImage: "radial-gradient(var(--color-line) 1px, transparent 1px)", backgroundSize: "18px 18px" }}>
          <svg width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 ${layout.minY} ${layout.width} ${layout.height}`} role="img" aria-label="Graph pipeline audit faskes JKN">
            {([[layout.cols.xo, "Output"], [layout.cols.xt, "Nexus"], [layout.cols.xa, "Aplikasi"]] as [number, string][]).map(([x, t]) => (
              <text key={t} x={x + BOX_W / 2} y={layout.minY + 30} textAnchor="middle" className="text-[18px] font-semibold" fill="var(--color-muted)">{t}</text>
            ))}
            {layout.edges.map(([a, b], i) => {
              const p = layout.pos[a];
              const q = layout.pos[b];
              if (!p || !q) return null;
              const x1 = p.x + BOX_W;
              const y1 = p.y + BOX_H / 2;
              const x2 = q.x;
              const y2 = q.y + BOX_H / 2;
              const mx = (x1 + x2) / 2;
              const on = !lit || (lit.has(a) && lit.has(b));
              return (
                <g key={i} opacity={on ? 1 : 0.15}>
                  <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={lit && on ? "var(--color-ocean)" : "var(--color-muted)"} strokeWidth={lit && on ? 2.6 : 1.4} />
                  <circle cx={x1} cy={y1} r={4} fill="var(--color-ink)" stroke="var(--color-muted)" strokeWidth={1.4} />
                  <circle cx={x2} cy={y2} r={4} fill="var(--color-ink)" stroke="var(--color-muted)" strokeWidth={1.4} />
                </g>
              );
            })}
            {layout.boxes.map((b) => {
              const on = !lit || lit.has(b.id);
              const sel = picked === b.id;
              return (
                <g key={b.id} transform={`translate(${b.x},${b.y})`} opacity={on ? 1 : 0.25} onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)}
                  onClick={() => setPicked(b.id)} className="cursor-pointer">
                  <rect width={BOX_W} height={BOX_H} rx={6} fill="var(--color-panel)" stroke={sel ? "var(--color-ocean)" : "var(--color-line-2)"} strokeWidth={sel ? 2.5 : 1} />
                  <rect width={BOX_W} height={22} rx={6} fill={b.hex} />
                  <rect y={14} width={BOX_W} height={8} fill={b.hex} />
                  <text x={10} y={16} className="text-[13px] font-semibold" fill="#fff">{b.badge}</text>
                  <text x={32} y={16} className="text-[13px] font-semibold" fill="#fff">{b.label.length > 27 ? `${b.label.slice(0, 26)}…` : b.label}</text>
                  <text x={10} y={41} className="text-[12px]" fill="var(--color-muted)">{b.sub}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      {(node || out) && (
        <div className="rounded-xl border border-line bg-panel p-3 text-xs">
          {node && (
            <>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-sm" style={{ background: color[node.group] }} />
                <span className="font-mono font-semibold">{node.name}</span>
                <span className="text-muted">· {KIND[node.kind].label} · {graph.groups.find((g) => g.id === node.group)?.name}</span>
              </div>
              {node.doc && <p className="mt-1 text-muted">{node.doc}</p>}
              {node.kind === "source" && <p className="mt-1 text-muted">{(rows[node.name] ?? 0).toLocaleString("id-ID")} baris · Files / raw / {node.name}.parquet</p>}
              {node.kind === "union" && <p className="mt-1 text-muted">Menggabungkan {graph.edges.filter(([, b]) => b === node.id).map(([a]) => graph.nodes.find((n) => n.id === a)?.name).join(" + ")} (union all, skema harus sama).</p>}
              {node.kind === "join" && <p className="mt-1 text-muted">Left join {graph.edges.filter(([, b]) => b === node.id).map(([a]) => graph.nodes.find((n) => n.id === a)?.name).join(" ⋈ ")}.</p>}
              {sql[node.name] && <pre className="mt-2 max-h-72 overflow-auto rounded border border-line bg-ink p-2 text-[11px] leading-relaxed text-soft">{sql[node.name]}</pre>}
            </>
          )}
          {out && (
            <div>
              <span className="font-mono font-semibold">{out.name}.parquet</span>
              <span className="text-muted"> · output · {(rows[out.name] ?? 0).toLocaleString("id-ID")} baris{out.backs && backs[out.name] ? ` · mendukung object type ${short(backs[out.name])} (re-index otomatis)` : " · dataset analitik"}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
