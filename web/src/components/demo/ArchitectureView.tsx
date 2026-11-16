"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { API_URL } from "@/lib/api";

/* The end-to-end architecture of a demo, live: sources → storage → pipelines → clean data → Nexus → intelligence →
   applications, with lineage and governance across every layer. Pick a flow to see the path a record takes; click a
   block for what it is and where it lives. Used by /demo-jkn/arsitektur (api/demo_jkn_arsitektur.py) and
   /demo-grid/arsitektur (api/demo_grid_arsitektur.py). */

type Block = { id: string; layer: string; title: string; plain: string; tech: string; metrics: [string, string][]; links: [string, string][] };
type Flow = { id: string; title: string; color: string; path: string[]; story: string };
type Arch = {
  project: string;
  layers: { key: string; title: string; desc: string }[];
  blocks: Block[];
  flows: Flow[];
  edges: { from: string; to: string }[];
  cross: { id: string; title: string; desc: string; href: string; metric?: string }[];
};

const LAYER_ICON: Record<string, IconName> = { sumber: "database", simpan: "folder", olah: "pipeline", bersih: "table", nexus: "cube", cerdas: "sparkle", aplikasi: "grid" };
const LAYER_COLOR: Record<string, string> = { sumber: "#64748b", simpan: "#0ea5e9", olah: "#38bdf8", bersih: "#22c55e", nexus: "#f59e0b", cerdas: "#a855f7", aplikasi: "#10b981" };

export type ArchitectureProps = {
  /** the API route returning the architecture (layers, blocks, flows, edges, cross) */
  endpoint: string;
  crumb: { href: string; label: string };
  links: { href: string; label: string; primary?: boolean }[];
  /** shown under the flow buttons while no flow is picked */
  intro: string;
};

export function ArchitectureView({ endpoint, crumb, links, intro }: ArchitectureProps) {
  const [d, setD] = useState<Arch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // a link can open a flow: ?flow=<id> (only drawn once the data has loaded, so no hydration mismatch)
  const [flow, setFlow] = useState<string | null>(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("flow") : null));
  const [step, setStep] = useState<number | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [pos, setPos] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    fetch(`${API_URL}${endpoint}`, { credentials: "include", cache: "no-store" })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).detail ?? r.statusText))))
      .then(setD, (e: Error) => setErr(e.message));
  }, [endpoint]);

  // block positions, for the connectors
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const b = box.getBoundingClientRect();
    const next: typeof pos = {};
    for (const [id, el] of Object.entries(nodeRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      next[id] = { x: r.left - b.left + box.scrollLeft, y: r.top - b.top, w: r.width, h: r.height };
    }
    setPos(next);
    setSize({ w: box.scrollWidth, h: box.scrollHeight });
  }, []);
  useLayoutEffect(() => {
    measure();
  }, [d, measure]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (boxRef.current) ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [measure]);

  const f = d?.flows.find((x) => x.id === flow) ?? null;
  // "play": the flow lights up block by block
  useEffect(() => {
    if (step === null || !f) return;
    if (step >= f.path.length) {
      const t = setTimeout(() => setStep(null), 1200);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => (s === null ? null : s + 1)), 750);
    return () => clearTimeout(t);
  }, [step, f]);

  const lit = useMemo(() => {
    if (f) {
      const path = step === null ? f.path : f.path.slice(0, step + 1);
      return { nodes: new Set(path), edges: new Set(path.slice(1).map((b, i) => `${path[i]}>${b}`)), color: f.color, order: new Map(f.path.map((b, i) => [b, i + 1])) };
    }
    const a = hover ?? sel;
    if (a && d) {
      const es = d.edges.filter((e) => e.from === a || e.to === a);
      return { nodes: new Set([a, ...es.map((e) => e.from), ...es.map((e) => e.to)]), edges: new Set(es.map((e) => `${e.from}>${e.to}`)), color: "#60a5fa", order: new Map<string, number>() };
    }
    return null;
  }, [f, step, hover, sel, d]);

  if (err) return <div className="p-6 text-sm text-bad">{err}</div>;
  if (!d)
    return (
      <div className="flex flex-1 items-center justify-center gap-3 text-sm text-muted">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-line-2 border-t-ocean" /> Membaca arsitektur dari platform…
      </div>
    );
  const block = sel ? d.blocks.find((b) => b.id === sel) : null;
  const edgePath = (a: string, b: string) => {
    const p = pos[a];
    const q = pos[b];
    if (!p || !q) return "";
    const forward = q.x > p.x + p.w / 2;
    const x1 = forward ? p.x + p.w : p.x;
    const x2 = forward ? q.x : q.x + q.w;
    const y1 = p.y + p.h / 2;
    const y2 = q.y + q.h / 2;
    const dx = Math.max(30, Math.abs(x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + (forward ? dx : -dx)},${y1} ${x2 - (forward ? dx : -dx)},${y2} ${x2},${y2}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ocean/15 text-ocean"><Icon name="layers" className="h-4 w-4" /></span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <Link href={crumb.href} className="hover:text-white">{crumb.label}</Link>/<span>{d.project}</span>
          </div>
          <h1 className="text-[15px] font-semibold leading-tight">Arsitektur sistem — end to end</h1>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5 text-xs">
          {links.map((l) => (
            <Link key={l.href} href={l.href}
              className={l.primary ? "rounded-md bg-ocean px-2.5 py-1.5 font-medium text-white hover:bg-ocean-deep" : "rounded-md border border-line-2 px-2.5 py-1.5 text-soft hover:border-ocean hover:text-white"}>
              {l.label}
            </Link>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-ink p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted">Lihat alur:</span>
            {d.flows.map((x) => (
              <button key={x.id} type="button" onClick={() => (setFlow(flow === x.id ? null : x.id), setStep(null))}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${flow === x.id ? "text-white" : "border-line-2 text-soft hover:text-white"}`}
                style={flow === x.id ? { borderColor: x.color, background: `${x.color}22` } : undefined}>
                <span className="h-2 w-2 rounded-full" style={{ background: x.color }} />
                {x.title}
              </button>
            ))}
            {f && (
              <button type="button" onClick={() => setStep(0)} className="ml-auto flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1 text-xs text-soft hover:border-ocean hover:text-white">
                <Icon name="play" className="h-3.5 w-3.5" /> Putar alur
              </button>
            )}
          </div>
          <p className="mb-3 min-h-[2.5em] max-w-5xl text-xs leading-relaxed text-muted">
            {f ? (
              <><b style={{ color: f.color }}>{f.title}.</b> {f.story}</>
            ) : (
              intro
            )}
          </p>

          <div ref={boxRef} className="relative overflow-x-auto pb-2">
            <svg className="pointer-events-none absolute left-0 top-0" width={size.w} height={size.h}>
              <defs>
                <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
                </marker>
              </defs>
              {d.edges.map((e) => {
                const on = lit?.edges.has(`${e.from}>${e.to}`);
                return (
                  <path key={`${e.from}>${e.to}`} d={edgePath(e.from, e.to)} fill="none" stroke={on ? lit!.color : "#334155"} strokeWidth={on ? 2.2 : 1}
                    strokeOpacity={lit && !on ? 0.25 : on ? 0.95 : 0.7} markerEnd="url(#arch-arrow)" />
                );
              })}
            </svg>
            <div className="relative grid min-w-[1600px] gap-12" style={{ gridTemplateColumns: `repeat(${d.layers.length}, minmax(0, 1fr))` }}>
              {d.layers.map((l) => (
                <div key={l.key} className="flex flex-col gap-2.5">
                  <div className="rounded-lg border-t-2 bg-panel/60 px-2.5 py-2" style={{ borderColor: LAYER_COLOR[l.key] }}>
                    <div className="flex items-center gap-1.5 text-[12px] font-semibold"><span style={{ color: LAYER_COLOR[l.key] }}><Icon name={LAYER_ICON[l.key]} className="h-3.5 w-3.5" /></span>{l.title}</div>
                    <div className="mt-0.5 text-[10.5px] leading-snug text-muted">{l.desc}</div>
                  </div>
                  <div className="flex flex-1 flex-col justify-around gap-2.5">
                    {d.blocks.filter((b) => b.layer === l.key).map((b) => {
                      const on = !lit || lit.nodes.has(b.id);
                      const n = lit?.order.get(b.id);
                      return (
                        <div key={b.id} ref={(el) => { nodeRefs.current[b.id] = el; }} role="button" tabIndex={0}
                          onClick={() => setSel(b.id)} onKeyDown={(e) => e.key === "Enter" && setSel(b.id)}
                          onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)}
                          className={`relative cursor-pointer rounded-lg border bg-panel p-2.5 transition ${on ? "opacity-100" : "opacity-30"} ${sel === b.id ? "ring-2 ring-ocean" : ""}`}
                          style={{ borderColor: lit?.nodes.has(b.id) ? lit.color : "var(--color-line)" }}>
                          {n && f && (
                            <span className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: f.color }}>{n}</span>
                          )}
                          <div className="text-[12px] font-semibold leading-tight">{b.title}</div>
                          <div className="mt-0.5 text-[10px] text-muted">{b.tech}</div>
                          {b.metrics.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
                              {b.metrics.slice(0, 2).map(([k, v], i) => (
                                <span key={`${k}-${i}`} className="text-[10.5px]"><b className="tabular-nums text-soft">{v}</b> <span className="text-muted">{k}</span></span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {d.cross.map((c) => (
              <Link key={c.id} href={c.href} className="flex items-center gap-3 rounded-xl border border-dashed border-line-2 bg-panel/70 p-3 hover:border-ocean">
                <Icon name={c.id === "governance" ? "lock" : "split"} className="h-5 w-5 shrink-0 text-ocean" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">{c.title} <span className="text-[11px] font-normal text-muted">· melintasi semua lapisan</span></span>
                  <span className="block text-[11.5px] text-muted">{c.desc}</span>
                </span>
                {c.metric && <span className="ml-auto shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-[11px] text-ok">{c.metric}</span>}
              </Link>
            ))}
          </div>
        </main>

        {block && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-panel">
            <header className="flex items-start gap-2 border-b border-line p-4">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `${LAYER_COLOR[block.layer]}22`, color: LAYER_COLOR[block.layer] }}>
                <Icon name={LAYER_ICON[block.layer]} className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-muted">{d.layers.find((l) => l.key === block.layer)?.title}</div>
                <h2 className="text-[15px] font-semibold">{block.title}</h2>
                <div className="text-[11px] text-ocean">{block.tech}</div>
              </div>
              <button type="button" onClick={() => setSel(null)} className="text-muted hover:text-white" aria-label="Tutup">✕</button>
            </header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
              <p className="leading-relaxed text-soft">{block.plain}</p>
              {block.metrics.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {block.metrics.map(([k, v], i) => (
                    <div key={`${k}-${i}`} className="rounded-md bg-ink p-2">
                      <div className="text-[15px] font-semibold tabular-nums">{v}</div>
                      <div className="text-[10.5px] text-muted">{k}</div>
                    </div>
                  ))}
                </div>
              )}
              {block.links.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-muted">Buka di platform</div>
                  {block.links.map(([k, href]) => (
                    <Link key={href + k} href={href} className="flex items-center justify-between rounded-md border border-line-2 px-2.5 py-1.5 hover:border-ocean">
                      <span className="truncate">{k}</span><span className="text-ocean">→</span>
                    </Link>
                  ))}
                </div>
              )}
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted">Dilalui alur</div>
                <div className="flex flex-wrap gap-1.5">
                  {d.flows.filter((x) => x.path.includes(block.id)).map((x) => (
                    <button key={x.id} type="button" onClick={() => (setFlow(x.id), setStep(null))} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
                      style={{ borderColor: `${x.color}66`, color: x.color }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: x.color }} />{x.title}
                    </button>
                  ))}
                </div>
              </div>
              {(["from", "to"] as const).map((dir) => {
                const ids = d.edges.filter((e) => (dir === "to" ? e.from : e.to) === block.id).map((e) => (dir === "to" ? e.to : e.from));
                if (!ids.length) return null;
                return (
                  <div key={dir} className="space-y-1">
                    <div className="text-[11px] font-medium text-muted">{dir === "from" ? "Menerima dari" : "Mengirim ke"}</div>
                    {ids.map((i) => (
                      <button key={i} type="button" onClick={() => setSel(i)} className="block w-full truncate rounded px-1.5 py-1 text-left text-soft hover:bg-ink hover:text-white">
                        {dir === "from" ? "← " : "→ "}{d.blocks.find((b) => b.id === i)?.title}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
