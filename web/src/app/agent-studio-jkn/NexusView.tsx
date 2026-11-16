"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import type { Rec } from "./liveData";

/* The Nexus answer view: the subgraph Orbis retrieved to answer the last question — cited nodes in the centre,
   their neighbourhood around them, edges as found in the graph. Click a node to see it and its relations. */
export type NexusAnswer = { q: string; answer: string; refs: Rec[]; hits: Rec[]; cited: string[]; subgraph: { nodeIds: string[]; edges: { s: string; p: string; t: string }[] }; ms?: number };

const KIND_COLOR: [RegExp, string][] = [
  [/Faskes/i, "#e5484d"], [/Klaim|SEP/i, "#d6409f"], [/Temuan/i, "#f0a843"], [/Dokter/i, "#3e8ef7"], [/Kasus|Rujukan/i, "#5b84ae"],
  [/Jadwal|Audit/i, "#30a46c"], [/Alat|IoT/i, "#2dd4bf"], [/Wilayah/i, "#a18072"], [/Kategori/i, "#e16a3d"], [/Tarif/i, "#c94f9e"],
];
const humanType = (k: string) => k.replace(/^o:/, "").replace(/Demo$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/Jkn/g, "JKN");

function describe(id: string, known: Map<string, Rec>, typeNames: Map<string, string>) {
  const hit = known.get(id);
  const [ns, a = "", ...rest] = id.split(":");
  const tail = rest.join(":");
  if (ns === "o") {
    const type = hit ? humanType(String(hit.kind)) : typeNames.get(a) ?? "Objek";
    return { label: String(hit?.label ?? tail), kind: type, color: KIND_COLOR.find(([re]) => re.test(type))?.[1] ?? "#8b7cf6" };
  }
  if (ns === "v") return { label: `${a.replace(/_/g, " ")}: ${tail.replace(/-/g, " ")}`, kind: "Nilai properti", color: "#738091" };
  if (ns === "c") return { label: String(hit?.label ?? tail.replace(/[-_]/g, " ")), kind: a === "journal" ? "Jurnal" : a === "decision" ? "Keputusan" : a === "method" ? "Metode" : a, color: "#9d8cf5" };
  return { label: String(hit?.label ?? id), kind: ns, color: "#738091" };
}

export function NexusView({ data, onAsk }: { data: NexusAnswer; onAsk: (q: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const g = useMemo(() => {
    const known = new Map<string, Rec>([...(data.hits ?? []), ...(data.refs ?? [])].map((x) => [String(x.id), x]));
    const typeNames = new Map<string, string>();
    known.forEach((x, id) => { const [ns, t] = id.split(":"); if (ns === "o") typeNames.set(t, humanType(String(x.kind))); });
    const ids = data.subgraph?.nodeIds ?? [];
    const cited = new Set(data.cited ?? []);
    const refN = new Map<string, number>((data.refs ?? []).map((r) => [String(r.id), Number(r.n)]));
    const inner = ids.filter((id) => cited.has(id));
    const middle = ids.filter((id) => !cited.has(id) && refN.has(id));
    const outer = ids.filter((id) => !cited.has(id) && !refN.has(id));
    const W = 1240, H = 760, cx = W / 2, cy = H / 2 + 8;
    const pos = new Map<string, { x: number; y: number }>();
    const ring = (list: string[], rx: number, ry: number, phase: number) => list.forEach((id, i) => {
      const a = phase + (i / Math.max(1, list.length)) * Math.PI * 2;
      pos.set(id, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    });
    if (inner.length === 1) pos.set(inner[0], { x: cx, y: cy }); else ring(inner, 190, 125, -Math.PI / 2);
    ring(middle, 390, 245, -Math.PI / 2 + Math.PI / Math.max(2, middle.length));
    ring(outer.sort((a, b) => a.localeCompare(b)), 560, 330, -Math.PI / 2 + 0.15);
    const nodes = ids.map((id) => ({ id, ...describe(id, known, typeNames), ...pos.get(id)!, cited: cited.has(id), ref: refN.get(id) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = (data.subgraph?.edges ?? []).filter((e) => byId.has(e.s) && byId.has(e.t));
    return { nodes, byId, edges, W, H };
  }, [data]);
  const focus = sel ?? hover;
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    g.edges.forEach((e) => { if (e.s === focus) s.add(e.t); if (e.t === focus) s.add(e.s); });
    return s;
  }, [focus, g.edges]);
  const selNode = sel ? g.byId.get(sel) : null;
  const relations = sel ? g.edges.filter((e) => e.s === sel || e.t === sel) : [];
  const kinds = useMemo(() => {
    const m = new Map<string, { color: string; n: number }>();
    g.nodes.forEach((n) => { const k = m.get(n.kind); if (k) k.n++; else m.set(n.kind, { color: n.color, n: 1 }); });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [g.nodes]);

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#1c2127]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/30 bg-[#252a31] px-3 text-[12px]">
        <Icon name="graph" className="h-4 w-4 text-[#9d8cf5]" /><span className="font-semibold">Nexus</span>
        <span className="min-w-0 truncate text-[#abb3bf]">· “{data.q}”</span>
        <span className="ml-auto shrink-0 rounded bg-black/25 px-1.5 py-0.5 text-[10.5px] text-[#abb3bf]">{g.nodes.length} simpul · {g.edges.length} relasi · {data.cited?.length ?? 0} dikutip{data.ms ? ` · ${(data.ms / 1000).toFixed(1)} s` : ""}</span>
        <Link href="/orbis" className="shrink-0 rounded border border-[#383e47] px-2 py-1 text-[11px] text-[#d3d8de] hover:bg-white/5">Buka di Orbis ↗</Link>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <svg viewBox={`0 0 ${g.W} ${g.H}`} className="h-full w-full" role="img" aria-label="Subgraf Nexus yang dipakai menjawab">
          {g.edges.map((e, i) => {
            const a = g.byId.get(e.s)!, b = g.byId.get(e.t)!;
            const on = !near || (near.has(e.s) && near.has(e.t));
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on && near ? "#c5cbd3" : "#4a5260"} strokeOpacity={on ? 0.9 : 0.25} strokeWidth={on && near ? 1.4 : 0.8} />;
          })}
          {g.nodes.map((n) => {
            const on = !near || near.has(n.id);
            const r = n.cited ? 12 : n.ref ? 9 : 6;
            const showLabel = n.cited || (focus ? near?.has(n.id) : false);
            // labels point away from the centre so neighbouring ones do not sit on each other
            const dx = n.x - g.W / 2, dy = n.y - (g.H / 2 + 8), len = Math.hypot(dx, dy) || 1;
            const lx = n.x + (dx / len) * (r + 8), ly = n.y + (dy / len) * (r + 8) + 4;
            const anchor = Math.abs(dx) < 40 ? "middle" : dx > 0 ? "start" : "end";
            return (
              <g key={n.id} className="cursor-pointer" opacity={on ? 1 : 0.25} onClick={() => setSel(sel === n.id ? null : n.id)} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                <title>{`${n.label} — ${n.kind}`}</title>
                {n.cited && <circle cx={n.x} cy={n.y} r={r + 6} fill={n.color} opacity={0.18} />}
                <circle cx={n.x} cy={n.y} r={r} fill={n.color} stroke={sel === n.id ? "#fff" : "#1c2127"} strokeWidth={sel === n.id ? 2.5 : 1.5} />
                {n.ref && <text x={n.x} y={n.y + 3.5} textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">{n.ref}</text>}
                {showLabel && <text x={lx} y={ly + (Math.abs(dx) < 40 ? (dy > 0 ? 8 : -4) : 0)} textAnchor={anchor} fontSize={n.cited ? 12 : 10.5} fontWeight={n.cited ? 600 : 400} fill={n.cited ? "#f6f7f9" : "#c5cbd3"} style={{ paintOrder: "stroke", stroke: "#1c2127", strokeWidth: 3 }}>{n.label.length > 30 ? n.label.slice(0, 29) + "…" : n.label}</text>}
              </g>
            );
          })}
        </svg>
        <div className="absolute left-3 top-3 max-w-[260px] rounded border border-[#383e47] bg-[#111418]/90 p-2.5 text-[11px]">
          <p className="mb-1.5 font-semibold text-[#e5e8eb]">Jenis simpul</p>
          <div className="space-y-1">{kinds.slice(0, 9).map(([k, v]) => <p key={k} className="flex items-center gap-1.5 text-[#c5cbd3]"><i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: v.color }} /><span className="truncate">{k}</span><span className="ml-auto pl-2 text-[#8f99a8]">{v.n}</span></p>)}</div>
          <p className="mt-2 border-t border-[#383e47] pt-1.5 text-[10px] leading-snug text-[#8f99a8]">Tengah = dikutip jawaban · bernomor = sumber [n] · luar = tetangga 1 hop · arahkan kursor untuk nama</p>
        </div>
        {selNode && (
          <div className="absolute bottom-3 right-3 max-h-[60%] w-[320px] overflow-y-auto rounded border border-[#383e47] bg-[#111418]/95 p-3 text-[12px] shadow-2xl">
            <p className="flex items-start gap-2"><i className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: selNode.color }} /><span className="min-w-0 flex-1"><span className="block font-semibold text-white">{selNode.label}</span><span className="block text-[11px] text-[#8f99a8]">{selNode.kind}{selNode.cited ? " · dikutip jawaban" : ""}</span></span><button onClick={() => setSel(null)} aria-label="Tutup" className="text-[#8f99a8] hover:text-white"><Icon name="x" className="h-3.5 w-3.5" /></button></p>
            <p className="mt-2 text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">Relasi ({relations.length})</p>
            <div className="mt-1 space-y-0.5">{relations.slice(0, 14).map((e, i) => { const other = g.byId.get(e.s === sel ? e.t : e.s)!; return <button key={i} onClick={() => setSel(other.id)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-[#d3d8de] hover:bg-white/5"><span className="shrink-0 text-[#8f99a8]">{e.s === sel ? "→" : "←"} {e.p}</span><i className="h-2 w-2 shrink-0 rounded-full" style={{ background: other.color }} /><span className="truncate">{other.label}</span></button>; })}</div>
            <button onClick={() => onAsk(`Jelaskan ${selNode.label} dan kenapa relevan`)} className="mt-2.5 w-full rounded-sm bg-[#5b5fd6] py-1.5 text-[11.5px] font-medium text-white hover:bg-[#6a6ee0]">Tanya agen tentang simpul ini</button>
          </div>
        )}
      </div>
    </main>
  );
}
