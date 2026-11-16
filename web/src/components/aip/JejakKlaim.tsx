"use client";

/* Jejak data of one AI Agent Swarm Branch case file (the user, 2026-11-14: "tambahin data lineage di tab baru disini, coba cek
   ai-jkn-audit gimana dia tambahin data lineage di report"): the claim traced from its row in the generator batch through the API
   schema, the realtime rule engine, the feature stream, the 646-feature row, the screening model and its inference, the
   indications, the swarm (RAGU claims only), the decision, the ledger tag and its loss estimate, Box Karantina, to the figure in
   the case file. A generic renderer: the layers, their grid places and this claim's own values at each layer are written by
   testing/graf_cabang.py (g.jejak); this file only draws them, in the look of ai-jkn-audit's JejakData (icon tiles in the four
   Data Lineage families, transforms on the edges, drag to pan, Ctrl + scroll or the buttons to zoom, "Pas" to fit). A click on a
   node opens its values below the flow and lights the path its figure comes from; the case file is selected first. */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, iconPath, type IconName } from "@/components/Icon";

export type JejakSimpul = {
  id: string; col: number; lane: number; fam: "data" | "nexus" | "ml" | "app"; icon: string; kind: string; name: string; sub: string;
  sumber: string; kolom: { nama: string; nilai: string }[]; off?: boolean; alert?: boolean;
};
export type JejakGaris = { from: string; to: string; label: string; off?: boolean };
export type Jejak = { nodes: JejakSimpul[]; edges: JejakGaris[] };

// the families of Data Lineage (ai-jkn-audit lib/lineage.ts FAMILIES) and JejakData's dark palette; transforms ride on the edges
const FAM = { data: "#3987e5", nexus: "#199e70", ml: "#9b5de5", app: "#c88a12" } as const;
const FAM_NAMA = { data: "Data", nexus: "Nexus", ml: "Model ML", app: "Laporan" } as const;
const XF = "#f0a27a";
const DARK = { bg: "#12161b", dot: "#262d36", node: "#1a1f25", edge: "#4f5967", lit: "#8abbff", text: "#e5e8eb", muted: "#8f99a8", label: "#c5cbd3",
  sel: "#ffffff", bad: "#ff8a8a" };
const PX = 156, PY = 124, T = 46;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type Simpul = JejakSimpul & { x: number; y: number };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Up to `lines` lines of at most `max` characters, broken after spaces, _ - / and ·; the rest clipped. */
function wrap(s: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const part of s.split(/(?<=[ _\-/·])/)) {
    for (let p = part; p; ) {
      if ((cur + p).length <= max) { cur += p; p = ""; continue; }
      if (cur) { out.push(cur.trimEnd()); cur = ""; continue; }
      out.push(p.slice(0, max)); p = p.slice(max);
    }
  }
  if (cur) out.push(cur.trimEnd());
  return out.length > lines ? [...out.slice(0, lines - 1), clip(out.slice(lines - 1).join(""), max)] : out;
}
// a name from the data may be an icon this app does not have: a document then
const ikon = (s: string): IconName => ((iconPath as (n: string) => string | undefined)(s) ? (s as IconName) : "doc");

/** A node and everything upstream of it: the path its figure comes from (skipped layers stay dashed). */
function upstream(edges: JejakGaris[], id: string): Set<string> {
  const seen = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of edges) if (seen.has(e.to) && !seen.has(e.from)) { seen.add(e.from); grew = true; }
  }
  return seen;
}

/** The drawing's bounds, labels included. */
function batas(nodes: Simpul[]) {
  const c = Math.max(0, ...nodes.map((n) => n.col)), l = Math.max(0, ...nodes.map((n) => n.lane));
  return { x: -58, y: -22, w: c * PX + T + 116, h: l * PY + T + 92 };
}

/** The SVG of the flow; `port` spreads several edges into or out of one node so their arrows stay apart. */
function Graph({ nodes, edges, sel, uid }: { nodes: Simpul[]; edges: JejakGaris[]; sel: string; uid: string }) {
  const P = DARK;
  const halo = { paintOrder: "stroke", stroke: P.bg, strokeWidth: 3, strokeLinejoin: "round" } as const;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lit = upstream(edges, sel);
  const ok = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const port = (id: string, side: "in" | "out", e: JejakGaris) => {
    const mine = ok.filter((x) => (side === "in" ? x.to : x.from) === id);
    const sorted = [...mine].sort((a, b) => byId.get(side === "in" ? a.from : a.to)!.y - byId.get(side === "in" ? b.from : b.to)!.y);
    return (sorted.indexOf(e) - (sorted.length - 1) / 2) * 9;
  };
  return (
    <>
      <defs>
        {[["a", P.edge], ["l", P.lit]].map(([k, c]) => (
          <marker key={k} id={`${uid}-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {ok.map((e, i) => {
        const a = byId.get(e.from)!, b = byId.get(e.to)!;
        const x1 = a.x + T + 1, y1 = a.y + T / 2 + port(e.from, "out", e), x2 = b.x - 3, y2 = b.y + T / 2 + port(e.to, "in", e);
        const dx = x2 - x1;
        const d = `M${x1},${y1} C${x1 + dx / 2},${y1} ${x2 - dx / 2},${y2} ${x2},${y2}`;
        const on = lit.has(e.from) && lit.has(e.to);
        const flat = Math.abs(y2 - y1) < 20;
        return (
          <g key={i}>
            <title>{`${a.name} → ${b.name}: ${e.label}${e.off ? " (tidak dilalui klaim ini)" : ""}`}</title>
            <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
            <path d={d} fill="none" stroke={on ? P.lit : P.edge} strokeWidth={on ? 1.9 : 1.3} markerEnd={`url(#${uid}-${on ? "l" : "a"})`}
              strokeDasharray={e.off ? "3 4" : on ? "6 6" : undefined} className={on && !e.off ? "lineage-flow" : undefined} opacity={e.off ? 0.7 : 1} />
            <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - (flat ? 6 : 3)} textAnchor="middle" fontSize={8.5} fill={XF} fillOpacity={e.off ? 0.7 : 1}
              fontFamily={MONO} style={{ ...halo, strokeWidth: 3.5 }}>
              {clip(e.label, flat && Math.abs(x2 - x1) < PX ? 21 : 26)}
            </text>
          </g>
        );
      })}
      {nodes.map((n) => {
        const c = FAM[n.fam] ?? FAM.data;
        const on = sel === n.id;
        const ext = /\.(npz|jsonl|json|joblib|pkl|parquet|dta)$/.exec(n.name)?.[1];
        const name = wrap(n.name, 17, 2), sub = wrap(n.sub, 19, 2);
        return (
          <g key={n.id} data-node={n.id} transform={`translate(${n.x},${n.y})`} opacity={n.off ? 0.62 : !lit.has(n.id) ? 0.5 : 1}
            style={{ cursor: "pointer", outline: "none" }} aria-label={`${n.kind}: ${n.name}`}>
            <title>{`${n.kind}: ${n.name}${n.sub ? `\n${n.sub}` : ""}${n.off ? "\n(tidak dilalui klaim ini)" : ""}`}</title>
            {/* the hit area takes the labels too */}
            <rect x={T / 2 - PX / 2 + 5} y={-20} width={PX - 10} height={T + 84} fill="transparent" />
            <text x={T / 2} y={-8} textAnchor="middle" fontSize={9} fill={P.muted} style={{ ...halo, textTransform: "uppercase", letterSpacing: 0.5 }}>{clip(n.kind, 24)}</text>
            {on && <rect x={-5} y={-5} width={T + 10} height={T + 10} rx={16} fill="none" stroke={c} strokeOpacity={0.55} />}
            <rect width={T} height={T} rx={12} fill={c} fillOpacity={0.16} stroke={on ? P.sel : c} strokeWidth={on ? 2.4 : 1.4} strokeDasharray={n.off ? "4 3" : undefined} />
            <g transform={`translate(${T / 2 - 11},${T / 2 - 11}) scale(0.92)`} stroke={c} fill="none" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d={iconPath(ikon(n.icon))} />
            </g>
            {ext && (
              <g transform={`translate(${T - 17},${T - 8})`}>
                <rect width={ext.length * 6 + 14} height={14} rx={3} fill={P.node} stroke={c} />
                <text x={(ext.length * 6 + 14) / 2} y={10.5} textAnchor="middle" fontSize={8.5} fontWeight={700} fill={c} fontFamily={MONO}>.{ext}</text>
              </g>
            )}
            {n.alert && <circle cx={T - 1} cy={1} r={4.5} fill={P.bad} stroke={P.bg} strokeWidth={1.5} />}
            {name.map((l, i) => (
              <text key={`n${i}`} x={T / 2} y={T + 17 + i * 13} textAnchor="middle" fontSize={11} fontWeight={600} fill={P.text} style={halo}>{l}</text>
            ))}
            {sub.map((l, i) => (
              <text key={`s${i}`} x={T / 2} y={T + 18 + name.length * 13 + i * 12} textAnchor="middle" fontSize={9.5} fill={n.alert ? P.bad : P.label} style={halo}>{l}</text>
            ))}
          </g>
        );
      })}
    </>
  );
}

/** The interactive canvas: drag to pan, Ctrl + scroll (or click the canvas, then scroll) to zoom, the toolbar, click a node. */
function Canvas({ nodes, edges, sel, onSel, full, onFull }: { nodes: Simpul[]; edges: JejakGaris[]; sel: string; onSel: (id: string) => void;
  full: boolean; onFull: (on: boolean) => void }) {
  const uid = useId().replace(/:/g, "");
  const GB = useMemo(() => batas(nodes), [nodes]);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 0.6 });
  const [hint, setHint] = useState(false);
  const [panning, setPanning] = useState(false);
  const active = useRef(full);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean; node?: string } | null>(null);
  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !el.clientWidth) return;
    const k = Math.min(1.25, Math.max(0.2, Math.min((el.clientWidth - 24) / GB.w, (el.clientHeight - 20) / GB.h)));
    setView({ k, x: (el.clientWidth - GB.w * k) / 2 - GB.x * k, y: (el.clientHeight - GB.h * k) / 2 - GB.y * k });
  }, [GB]);
  const zoom = useCallback((f: number, px?: number, py?: number) => {
    const el = box.current;
    if (!el) return;
    const cx = px ?? el.clientWidth / 2, cy = py ?? el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(3, Math.max(0.2, v.k * f));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    let t = 0;
    // React's wheel handler is passive: zooming must keep the page from scrolling, so a listener of our own; a plain scroll over
    // the canvas still scrolls the report until the canvas was clicked (or Ctrl is held, or a pinch)
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey || active.current)) {
        setHint(true);
        clearTimeout(t);
        t = window.setTimeout(() => setHint(false), 1400);
        return;
      }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(Math.exp(Math.max(-0.4, Math.min(0.4, -e.deltaY * 0.0022))), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", wheel); clearTimeout(t); };
  }, [fit, zoom]);
  const btn = "flex h-6 min-w-6 items-center justify-center gap-1 rounded border border-white/10 bg-[#1a1f25] px-1.5 text-[10.5px] text-[#c5cbd3] hover:border-[#9d8cff]/60 hover:text-white";
  return (
    <div className={full ? "flex min-h-0 flex-1 flex-col gap-1.5" : "space-y-1.5"}>
      <div className="lp-no-print flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#8f99a8]">
        {(Object.keys(FAM) as (keyof typeof FAM)[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FAM[k] }} />{FAM_NAMA[k]}</span>
        ))}
        <span className="inline-flex items-center gap-1"><span className="font-mono" style={{ color: XF }}>abc</span>proses (transform)</span>
        <span className="inline-flex items-center gap-1"><span className="w-4 border-t border-dashed border-[#8f99a8]" />tidak dilalui klaim ini</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: DARK.bad }} />menyala / ditandai</span>
        <span className="ml-auto hidden text-[#6b7586] lg:inline">seret = geser · Ctrl + scroll = zoom</span>
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => zoom(1 / 1.2)} title="Perkecil" aria-label="Perkecil"><Icon name="minus" className="h-3 w-3" /></button>
          <span className="w-9 text-center text-[10.5px] tabular-nums">{Math.round(view.k * 100)}%</span>
          <button className={btn} onClick={() => zoom(1.2)} title="Perbesar" aria-label="Perbesar"><Icon name="plus" className="h-3 w-3" /></button>
          <button className={btn} onClick={fit} title="Muat semua node"><Icon name="fit" className="h-3 w-3" />Pas</button>
          <button className={btn} onClick={() => onFull(!full)} title={full ? "Tutup layar penuh (Esc)" : "Layar penuh"}>
            <Icon name={full ? "x" : "external"} className="h-3 w-3" />{full ? "Tutup" : "Layar penuh"}
          </button>
        </div>
      </div>
      <div ref={box} className={`relative select-none overflow-hidden rounded border border-white/[.06] ${full ? "min-h-0 flex-1" : "w-full"}`}
        style={{ background: DARK.bg, backgroundImage: `radial-gradient(${DARK.dot} 1px, transparent 1px)`, backgroundSize: `${18 * view.k}px ${18 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`, cursor: panning ? "grabbing" : "grab", touchAction: "none",
          // the flow is wide and shallow: the canvas takes its proportions, within a readable height
          ...(full ? {} : { aspectRatio: `${GB.w} / ${GB.h + 40}`, minHeight: 240, maxHeight: 460 }) }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          active.current = true;
          drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false, node: (e.target as Element).closest("[data-node]")?.getAttribute("data-node") ?? undefined };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          if (!d.moved) setPanning(true);
          d.moved = true;
          setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          setPanning(false);
          if (d && !d.moved && d.node) onSel(d.node);
        }}
        onPointerLeave={() => { if (!full && !drag.current) active.current = false; }}
      >
        <svg className="absolute inset-0 h-full w-full" role="img" aria-label="Jejak data klaim: dari baris data mentah sampai angka di berkas kasus">
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            <Graph nodes={nodes} edges={edges} sel={sel} uid={uid} />
          </g>
        </svg>
        {hint && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded bg-[#0d1014]/90 px-3 py-1.5 text-[11px] text-white shadow">
            Tahan Ctrl lalu scroll untuk zoom, atau klik kanvas dulu
          </p>
        )}
      </div>
    </div>
  );
}

/** One node's values: what the layer is, where it lives, what fed it, and this claim's own values there. */
function Detail({ n, nodes, edges, onSel }: { n: Simpul; nodes: Simpul[]; edges: JejakGaris[]; onSel: (id: string) => void }) {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const into = edges.filter((e) => e.to === n.id && byId.has(e.from));
  const jalur = [...upstream(edges, n.id)].map((id) => byId.get(id)).filter((x): x is Simpul => !!x && x.id !== n.id)
    .sort((a, b) => b.col - a.col || a.lane - b.lane);
  const c = FAM[n.fam] ?? FAM.data;
  return (
    <div className="rounded border border-white/[.06] bg-black/20 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: c }}>
          <Icon name={ikon(n.icon)} className="h-3.5 w-3.5" />{n.kind}
        </span>
        <span className="text-[12px] font-semibold text-[#e5e8eb]">{n.name}</span>
        {n.sub && <span className="text-[11px] text-[#c5cbd3]">· {n.sub}</span>}
      </div>
      <p className="mt-0.5 break-all font-mono text-[10.5px] text-[#d3d8de]" title="sumber data lapis ini">{n.sumber}</p>
      {into.length > 0 && (
        <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">
          ← {into.map((e, i) => (
            <span key={e.from}>{i > 0 && " · "}<button onClick={() => onSel(e.from)} className="text-[#c5cbd3] underline decoration-white/20 hover:text-white">{byId.get(e.from)!.name}</button>
              {" "}(<span className="font-mono" style={{ color: XF }}>{e.label}</span>{e.off ? ", tidak dilalui" : ""})</span>
          ))}
        </p>
      )}
      {n.off && <p className="mt-1 text-[11px] text-[#f2b35a]">Lapis ini tidak dilalui klaim ini; nilai di bawah menjelaskan alasannya.</p>}
      <dl className="mt-1.5 grid gap-x-5 gap-y-0 sm:grid-cols-2 xl:grid-cols-3">
        {n.kolom.map((k, i) => {
          const long = k.nilai.length > 42;  // a sentence: the whole row, the label above it
          return (
            <div key={i} className={`border-t border-white/[.04] py-0.5 text-[11px] ${long ? "sm:col-span-2 xl:col-span-3" : "flex items-baseline justify-between gap-2"}`}>
              <dt className="min-w-0 break-words text-[#8f99a8]">{k.nama}</dt>
              <dd className={long ? "text-[#e5e8eb]" : "shrink-0 text-right tabular-nums text-[#e5e8eb]"}>{k.nilai}</dd>
            </div>
          );
        })}
      </dl>
      {jalur.length > 0 && (
        <p className="mt-1.5 text-[10.5px] leading-snug text-[#8f99a8]">
          Jalur asal: {jalur.map((x) => `${x.name}${x.off ? " (dilewati)" : ""}`).join(" ← ")}
        </p>
      )}
    </div>
  );
}

/** The lineage tab of one case file: the flow, then the chosen node's values (the case file first). */
export function JejakKlaim({ jejak, judul }: { jejak: Jejak; judul?: string }) {
  const nodes = useMemo<Simpul[]>(() => jejak.nodes.map((n) => ({ ...n, x: n.col * PX, y: n.lane * PY })), [jejak]);
  const awal = useMemo(() => nodes.find((n) => n.id === "berkas") ?? [...nodes].sort((a, b) => b.col - a.col)[0], [nodes]);
  const [pilih, setPilih] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [full]);
  const cur = nodes.find((n) => n.id === pilih) ?? awal;
  if (!cur) return <p className="text-[11px] text-[#8f99a8]">Jejak data klaim ini kosong.</p>;
  return (
    <div className="space-y-2.5">
      <p className="text-[11.5px] leading-snug text-[#c5cbd3]">
        Dari baris data mentah, lewat validasi, mesin realtime, fitur, model ML dan tim agen AI, sampai angka di berkas kasus. Setiap kotak memuat nilai <b className="text-white">klaim ini</b> di lapis itu; garis putus-putus = lapis yang tidak dilalui.
      </p>
      <Canvas nodes={nodes} edges={jejak.edges} sel={cur.id} onSel={setPilih} full={false} onFull={setFull} />
      <p className="text-[10.5px] text-[#8f99a8]">Rincian node <b className="text-[#e5e8eb]">{cur.name}</b> · klik node lain untuk rinciannya; garis menyala = jalur asal angkanya</p>
      <Detail n={cur} nodes={nodes} edges={jejak.edges} onSel={setPilih} />
      {full && createPortal(
        <div className="fixed inset-0 z-[80] flex flex-col gap-2 bg-[#0d1014]/95 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Jejak data, layar penuh">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Icon name="graph" className="h-4 w-4 text-[#c9c0ff]" />
            <span className="font-semibold text-[#e5e8eb]">Jejak data{judul ? ` · ${judul}` : ""}</span>
            <span className="text-[#8f99a8]">{awal?.sub}</span>
          </div>
          <div className="flex min-h-0 flex-1 gap-3">
            <Canvas nodes={nodes} edges={jejak.edges} sel={cur.id} onSel={setPilih} full onFull={setFull} />
            <aside className="w-[420px] shrink-0 overflow-y-auto"><Detail n={cur} nodes={nodes} edges={jejak.edges} onSel={setPilih} /></aside>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
