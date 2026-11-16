"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";

export type OntNode = {
  id: string;
  name: string;
  api_name: string;
  color?: string | null;
  description: string;
  objects: number;
  properties: { api_name: string; display_name: string; type: string }[];
  dataset?: string | null;
  dataset_id?: string | null;
  core: boolean;
};
export type OntLink = { id: string; name: string; source: string; target: string; foreign_key?: string | null; cardinality?: string | null };
export type OntAction = { id: string; name: string; object_type_id?: string | null; description: string; parameters: string[] };
export type OntFunction = { id: string; name: string; doc: string; version?: string; output: string; input_type?: string | null; returns_type?: string | null; kind: "search_around" | "derived" };

/** Where each object type sits on the diagram (viewBox 1000 × 620), by name: the facility on the left, the
 * cases above and the claims below it, the doctors on the right — the middle stays free for the arrows. */
const SLOTS: [RegExp, number, number][] = [
  [/^Faskes Audit/, 150, 310],
  [/^Kasus Rujukan/, 500, 95],
  [/^Dokter Audit/, 850, 310],
  [/^Klaim JKN/, 500, 525],
  [/^Peringatan Risiko/, 850, 525],
  // the IoT layer (its own diagram: facility and doctor above, device → finding ← claimed procedure below)
  [/^Alat Medis IoT/, 150, 525],
  [/^Temuan IoT/, 500, 525],
  [/^Tindakan Penunjang/, 850, 525],
];
const W = 240;
const H = 104;
const short = (s: string) => s.replace(/\s*\(demo\)\s*$/, "");

/**
 * The audit Ontology drawn for people who have never seen one: object types (things in the real world) as cards,
 * link types (how they relate) as arrows, and on each card the actions (what the audit team can decide) and
 * functions (what the platform computes). Click a card for its properties, data and logic.
 */
export function OntologyDiagram({ nodes, links, actions, functions }: { nodes: OntNode[]; links: OntLink[]; actions: OntAction[]; functions: OntFunction[] }) {
  const [sel, setSel] = useState<string | null>(nodes.find((n) => /^Faskes Audit/.test(n.name))?.id ?? null);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const pos = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    let spare = 0;
    for (const n of nodes) {
      const slot = SLOTS.find(([re]) => re.test(n.name));
      out[n.id] = slot ? { x: slot[1], y: slot[2] } : { x: 830, y: 470 + spare++ * 120 };
    }
    return out;
  }, [nodes]);
  // the drawing fits the rows in use (the IoT diagram uses only the middle and bottom rows)
  const box = useMemo(() => {
    const ys = Object.values(pos).map((p) => p.y);
    const top = Math.max(0, Math.min(...ys, 310) - H / 2 - 40);
    const bottom = Math.min(620, Math.max(...ys, 310) + H / 2 + 40);
    return { top, height: bottom - top };
  }, [pos]);
  // several links between the same two types fan out symmetrically
  const curves = useMemo(() => {
    const shown = links.filter((l) => pos[l.source] && pos[l.target]);
    const pairKey = (l: OntLink) => [l.source, l.target].sort().join("|");
    const count: Record<string, number> = {};
    for (const l of shown) count[pairKey(l)] = (count[pairKey(l)] ?? 0) + 1;
    const seen: Record<string, number> = {};
    return shown.map((l) => {
      const k = pairKey(l);
      const i = (seen[k] = (seen[k] ?? -1) + 1);
      // the same sign means the same side whichever way the link points
      const flip = l.source < l.target ? 1 : -1;
      return { ...l, bend: (i - (count[k] - 1) / 2) * 90 * flip };
    });
  }, [links, pos]);
  const byType = (id: string) => ({ acts: actions.filter((a) => a.object_type_id === id), fns: functions.filter((f) => f.input_type === id) });
  const node = nodes.find((n) => n.id === sel);
  const detail = node ? byType(node.id) : null;

  const edge = (l: (typeof curves)[number]) => {
    const a = pos[l.source];
    const b = pos[l.target];
    // from card edge to card edge (roughly), bent sideways for parallel links
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const off = (u: number, v: number) => Math.min(W / 2 / Math.max(Math.abs(u), 0.01), H / 2 / Math.max(Math.abs(v), 0.01)) + 6;
    const s = { x: a.x + ux * off(ux, uy), y: a.y + uy * off(ux, uy) };
    const t = { x: b.x - ux * off(ux, uy), y: b.y - uy * off(ux, uy) };
    const mx = (s.x + t.x) / 2 - uy * l.bend;
    const my = (s.y + t.y) / 2 + ux * l.bend;
    return { d: `M${s.x},${s.y} Q${mx},${my} ${t.x},${t.y}`, lx: (s.x + 2 * mx + t.x) / 4, ly: (s.y + 2 * my + t.y) / 4 };
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-4 rounded border border-ocean bg-ocean/15" /> Node (object type) — benda nyata: faskes, kasus, dokter</span>
        <span className="flex items-center gap-1.5"><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" strokeWidth="1.5" /></svg> Relasi (link type) — bagaimana mereka terhubung</span>
        <span className="flex items-center gap-1.5"><span className="rounded bg-warn/15 px-1 text-warn">⚡</span> Action — keputusan tim audit</span>
        <span className="flex items-center gap-1.5"><span className="rounded bg-[#a78bfa]/15 px-1 text-[#a78bfa]">ƒ</span> Function — logika yang dihitung platform</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-ink">
        <svg viewBox={`0 ${box.top} 1000 ${box.height}`} className="block w-full min-w-[720px]" role="img" aria-label="Diagram Nexus audit faskes JKN">
          <defs>
            <marker id="ont-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--color-muted)" />
            </marker>
            <marker id="ont-arrow-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--color-ocean)" />
            </marker>
          </defs>
          {curves.map((l) => {
            const e = edge(l);
            const hi = hoverLink === l.id || sel === l.source || sel === l.target;
            return (
              <g key={l.id} onMouseEnter={() => setHoverLink(l.id)} onMouseLeave={() => setHoverLink(null)}>
                <path d={e.d} fill="none" stroke="transparent" strokeWidth={14} />
                <path d={e.d} fill="none" stroke={hi ? "var(--color-ocean)" : "var(--color-line-2)"} strokeWidth={hi ? 2 : 1.4} markerEnd={`url(#${hi ? "ont-arrow-hi" : "ont-arrow"})`} />
                <text x={e.lx} y={e.ly - 4} textAnchor="middle" className="text-[11px]" fill={hi ? "var(--color-strong)" : "var(--color-muted)"}
                  style={{ paintOrder: "stroke", stroke: "var(--color-ink)", strokeWidth: 4 }}>
                  {short(l.name)}
                </text>
                {hi && l.foreign_key && (
                  <text x={e.lx} y={e.ly + 10} textAnchor="middle" className="text-[10px]" fill="var(--color-muted)" style={{ paintOrder: "stroke", stroke: "var(--color-ink)", strokeWidth: 4 }}>
                    kunci: {l.foreign_key} · {l.cardinality === "many_to_one" ? "banyak → satu" : l.cardinality}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = pos[n.id];
            const { acts, fns } = byType(n.id);
            const active = sel === n.id;
            const color = n.color || "#38bdf8";
            return (
              <foreignObject key={n.id} x={p.x - W / 2} y={p.y - H / 2} width={W} height={H} className="overflow-visible">
                <button type="button" onClick={() => setSel(n.id)}
                  className={`block w-full rounded-xl border bg-panel px-3 py-2 text-left shadow-sm transition ${active ? "ring-2 ring-ocean" : "hover:border-ocean/60"}`}
                  style={{ borderColor: active ? "var(--color-ocean)" : color, height: H }}>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                    <span className="truncate text-[13px] font-semibold">{short(n.name)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">{n.objects.toLocaleString("id-ID")} objek · {n.properties.length} properti</div>
                  <div className="mt-0.5 truncate text-[10px] text-muted" title={n.dataset ?? ""}>
                    {n.dataset ? <>▣ dataset: {n.dataset.replace(/\.parquet$/, "")}</> : n.core ? "▣ belum didukung dataset" : "▣ demo klaim JKN"}
                  </div>
                  <div className="mt-1 flex gap-1">
                    <span title={acts.map((a) => short(a.name)).join(", ")} className={`rounded px-1.5 py-0.5 text-[10px] ${acts.length ? "bg-warn/15 text-warn" : "bg-panel-2 text-muted"}`}>⚡ {acts.length} action</span>
                    <span title={fns.map((f) => f.name).join(", ")} className={`rounded px-1.5 py-0.5 text-[10px] ${fns.length ? "bg-[#a78bfa]/15 text-[#a78bfa]" : "bg-panel-2 text-muted"}`}>ƒ {fns.length} function</span>
                  </div>
                </button>
              </foreignObject>
            );
          })}
        </svg>
      </div>
      {node && detail && (
        <div className="grid gap-3 rounded-xl border border-line bg-panel p-4 lg:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: node.color || "#38bdf8" }} />
              <h3 className="font-semibold">{short(node.name)}</h3>
              <Link href={`/ontology/${node.id}`} className="ml-auto text-xs text-ocean hover:underline">Buka di Nexus ↗</Link>
            </div>
            <p className="mt-1 text-xs text-muted">{node.description}</p>
            {node.dataset_id && (
              <Link href={`/lineage?node=${encodeURIComponent(`dataset:${node.dataset_id}`)}`} className="mt-2 inline-flex items-center gap-1 text-xs text-ocean hover:underline">
                <Icon name="pipeline" className="h-3.5 w-3.5" /> Lineage dataset {node.dataset}
              </Link>
            )}
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-line">
              <table className="w-full text-[11px]">
                <tbody>
                  {node.properties.map((p) => (
                    <tr key={p.api_name} className="border-b border-line/60 last:border-0">
                      <td className="px-2 py-1">{p.display_name}</td>
                      <td className="px-2 py-1 text-right text-muted">{p.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-warn">⚡ Actions — keputusan yang bisa diambil</h4>
            {detail.acts.length === 0 && <p className="text-xs text-muted">Tidak ada action pada tipe ini.</p>}
            <ul className="space-y-2">
              {detail.acts.map((a) => (
                <li key={a.id} className="rounded border border-line bg-ink p-2 text-xs">
                  <div className="font-medium">{short(a.name)}</div>
                  <div className="mt-0.5 text-muted">{a.description}</div>
                  {a.parameters.length > 0 && <div className="mt-1 text-[10px] text-muted">Isian: {a.parameters.join(" · ")}</div>}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-[#a78bfa]">ƒ Functions — logika yang menjelaskan & menelusuri</h4>
            {detail.fns.length === 0 && <p className="text-xs text-muted">Tidak ada function yang mengambil tipe ini.</p>}
            <ul className="space-y-2">
              {detail.fns.map((f) => (
                <li key={f.id} className="rounded border border-line bg-ink p-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Link href={`/functions/${encodeURIComponent(f.id)}`} className="font-mono font-medium text-[#a78bfa] hover:underline">{f.name}</Link>
                    <span className="ml-auto rounded bg-panel-2 px-1 text-[10px] text-muted">{f.kind === "search_around" ? "Search Around di Vertex" : "nilai turunan"}</span>
                  </div>
                  <div className="mt-0.5 text-muted">{f.doc}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
