"use client";
import { useEffect, useRef, useState } from "react";
import { HISTORY, KIND_LABEL, LEGEND, type PEdge, type PNode } from "./pipelineData";

export function PipelineWorkspace({ nodes, edges, setNodes, setEdges, notify, onAiGenerate, proposalState, setProposalState, title = "[kk] Power Outages › Power Outage", legend = LEGEND, promptDefault = "Join drone footage to outages and detect defects", firstNodeId = "pOutage", branch = "Add Drone Footage", showProposals = 0 }: {
  nodes: PNode[]; edges: PEdge[]; setNodes: (n: PNode[]) => void; setEdges: (e: PEdge[]) => void;
  notify: (m: string) => void; onAiGenerate: () => void; proposalState: string; setProposalState: (s: string) => void;
  title?: string; legend?: typeof LEGEND; promptDefault?: string; firstNodeId?: string;
  branch?: string; showProposals?: number; // bump showProposals to switch to the Proposals tab from outside
}) {
  const [tab, setTab] = useState<"Graph" | "Proposals" | "History">("Graph");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- an agent opens the proposal from outside
  useEffect(() => { if (showProposals) setTab("Proposals"); }, [showProposals]);
  const [sel, setSel] = useState<string | null>(firstNodeId);
  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pan, setPan] = useState({ x: 10, y: 6 }); const [zoom, setZoom] = useState(0.72);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [paramOpen, setParamOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState(promptDefault);
  const drag = useRef<{ id?: string; sx: number; sy: number; ox: number; oy: number; px: number; py: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fitZoom = () => { const w = wrapRef.current?.clientWidth ?? 1200; setZoom(Math.max(0.38, Math.min(0.85, w / 1420))); setPan({ x: 8, y: 6 }); };
  useEffect(() => { fitZoom(); }, []);
  const selected = nodes.find((n) => n.id === sel);
  const visible = nodes.filter((n) => !hidden.has(n.group));
  const proposed = nodes.filter((n) => n.proposed);

  const addNode = (kind: PNode["kind"], label: string) => {
    const id = "n" + Date.now();
    setNodes([...nodes, { id, label, kind, group: nodes[0]?.group ?? "Dataset", color: kind === "function" ? "#8b5cf6" : "#5b84ae", x: 640 - pan.x, y: 240 - pan.y, cols: 4, desc: "New node — configure inputs" }]);
    setSel(id); notify(`${label} added to the graph. Drag to position, then connect a port.`);
  };
  const onNodeDown = (e: React.PointerEvent, n: PNode) => {
    if (connectFrom && connectFrom !== n.id) { if (!edges.some((x) => x.from === connectFrom && x.to === n.id)) setEdges([...edges, { from: connectFrom, to: n.id }]); notify(`Connected ${nodes.find((x) => x.id === connectFrom)?.label} → ${n.label}`); setConnectFrom(null); setSel(n.id); return; }
    setSel(n.id); drag.current = { id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, px: pan.x, py: pan.y }; (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    if (d.id) setNodes(nodes.map((n) => n.id === d.id ? { ...n, x: d.ox + (e.clientX - d.sx) / zoom, y: d.oy + (e.clientY - d.sy) / zoom } : n));
    else setPan({ x: d.px + e.clientX - d.sx, y: d.py + e.clientY - d.sy });
  };
  const byId = (id: string) => nodes.find((n) => n.id === id)!;
  const NW = 148, NH = 44;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#eef1f4] text-[#263746]">
      {/* Pipeline Builder chrome — light canvas inside the dark platform frame, as in the reference */}
      <div className="flex h-10 shrink-0 flex-wrap items-center gap-2 border-b border-[#d5dce3] bg-white px-3 text-[12px]">
        <span className="font-semibold">{title}</span>
        <span className="rounded bg-[#eef1f4] px-1.5 py-0.5 text-[10px]">Batch</span>
        <div className="ml-2 flex gap-1">{(["Graph", "Proposals", "History"] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded px-2.5 py-1 ${tab === t ? "bg-[#263746] text-white" : "text-[#5b6b7a] hover:bg-[#eef1f4]"}`}>{t}{t === "Proposals" && proposed.length ? ` (${proposed.length})` : ""}</button>)}</div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="rounded border border-[#d5dce3] px-2 py-1 text-[11px] text-[#5b6b7a]">⎇ main ▾</span>
          <button onClick={() => { setProposalState("Saved"); notify(`Pipeline saved to branch “${branch}”.`); }} className="rounded border border-emerald-600 px-2.5 py-1 font-medium text-emerald-700 hover:bg-emerald-50">✓ Save</button>
          <button onClick={() => { setTab("Proposals"); setProposalState("Proposed"); notify("Proposal created — review the Changes tab before deploying."); }} className="rounded border border-[#b9c4cf] px-2.5 py-1 hover:bg-[#eef1f4]">Propose</button>
          <button onClick={() => { setProposalState("Deploying"); setTimeout(() => { setProposalState("Deployed"); setNodes(nodes.map((n) => ({ ...n, proposed: false }))); notify("Deployed to main. Outputs are building — see History."); }, 900); }} className="rounded bg-[#5b6ee1] px-2.5 py-1 font-medium text-white hover:bg-[#4c5ed6]">{proposalState === "Deploying" ? "Deploying…" : "Deploy ▾"}</button>
          <span className="text-[11px] text-[#7a8794]">{proposalState}</span>
        </div>
      </div>

      {tab === "Graph" && <>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[#d5dce3] bg-white px-3 py-1.5 text-[11.5px]">
          <button onClick={() => addNode("dataset", "New dataset")} className="rounded border border-[#b9c4cf] px-2 py-1 hover:bg-[#eef1f4]">⇩ Add data</button>
          <button onClick={() => setParamOpen(!paramOpen)} className="rounded border border-[#b9c4cf] px-2 py-1 hover:bg-[#eef1f4]">{"{x}"} Parameters</button>
          <button onClick={() => addNode("function", "Custom function")} className="rounded border border-[#b9c4cf] px-2 py-1 hover:bg-[#eef1f4]">fx Custom functions</button>
          <span className="mx-1 h-4 w-px bg-[#d5dce3]" />
          <button onClick={() => addNode("union", "Union")} className="rounded px-2 py-1 hover:bg-[#eef1f4]">Union</button>
          <button onClick={() => addNode("join", "Left join")} className="rounded px-2 py-1 hover:bg-[#eef1f4]">Left join</button>
          <button onClick={() => addNode("transform", "Transform")} className="rounded px-2 py-1 hover:bg-[#eef1f4]">Transform</button>
          <button onClick={() => setAiOpen(!aiOpen)} className="rounded bg-violet-600 px-2 py-1 font-medium text-white hover:bg-violet-500">✦ AI transform</button>
          <button onClick={() => { if (sel) { setNodes(nodes.filter((n) => n.id !== sel)); setEdges(edges.filter((e) => e.from !== sel && e.to !== sel)); setSel(null); } }} className="rounded px-2 py-1 text-[#8a2f35] hover:bg-red-50">Remove</button>
          <button onClick={() => selected && setConnectFrom(selected.id)} className={`rounded px-2 py-1 ${connectFrom ? "bg-blue-100 text-blue-800" : "hover:bg-[#eef1f4]"}`}>{connectFrom ? `Connecting from ${selected?.label} — click a target node` : "Connect"}</button>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 rounded border border-[#b9c4cf] px-2 py-1"><span className="text-[#7a8794]">⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search nodes…" className="w-28 bg-transparent outline-none" /></label>
            <button onClick={() => setZoom((z) => Math.min(1.3, z + 0.1))} className="rounded border border-[#b9c4cf] px-2 py-1">＋</button>
            <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))} className="rounded border border-[#b9c4cf] px-2 py-1">－</button>
            <button onClick={fitZoom} className="rounded border border-[#b9c4cf] px-2 py-1">Fit</button>
          </div>
        </div>
        {paramOpen && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#d5dce3] bg-[#f7f9fb] px-3 py-2 text-[11.5px]"><span className="font-medium">Parameters</span><label>region = <input defaultValue="West Java" className="ml-1 rounded border border-[#b9c4cf] px-1.5 py-0.5" /></label><label>min_customers = <input defaultValue="25" className="ml-1 w-16 rounded border border-[#b9c4cf] px-1.5 py-0.5" /></label><button onClick={() => { setParamOpen(false); notify("Parameters applied to the next build."); }} className="rounded bg-[#263746] px-2 py-1 text-white">Apply</button></div>}
        {aiOpen && <div className="shrink-0 border-b border-violet-200 bg-violet-50 px-3 py-2.5"><p className="text-[11.5px] text-violet-900">Select tables on the graph as inputs. Describe what you want from your data — the AI assistant generates transforms for review, never directly on main.</p><div className="mt-1.5 flex gap-2"><input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} className="min-w-0 flex-1 rounded border border-violet-300 bg-white px-2 py-1.5 text-[12px] outline-none" /><button onClick={() => { setAiOpen(false); onAiGenerate(); }} className="rounded bg-violet-600 px-3 py-1.5 text-[12px] font-medium text-white">✦ Generate</button></div><p className="mt-1 text-[10.5px] text-violet-700">{nodes.length} inputs available · target: Power Outage + Aerial Photography</p></div>}
        <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden" onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onPointerDown={(e) => { if (e.target === e.currentTarget) { drag.current = { sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, px: pan.x, py: pan.y }; } }}>
          <svg className="absolute inset-0 h-full w-full">
            <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
              {edges.map((e, i) => { const a = byId(e.from), b = byId(e.to); if (!a || !b) return null; const hot = sel === e.from || sel === e.to; return <path key={i} d={`M ${a.x + NW} ${a.y + NH / 2} C ${a.x + NW + 45} ${a.y + NH / 2}, ${b.x - 45} ${b.y + NH / 2}, ${b.x} ${b.y + NH / 2}`} fill="none" stroke={hot ? "#5b6ee1" : "#9aa8b5"} strokeWidth={hot ? 1.8 : 1.1} markerEnd="url(#arr)" />; })}
              <defs><marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#7a8794" /></marker></defs>
            </g>
          </svg>
          <div className="absolute" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: "0 0", width: 1400, height: 800 }}>
            {visible.map((n) => {
              const isSel = sel === n.id, dim = q && !n.label.toLowerCase().includes(q.toLowerCase());
              return <div key={n.id} onPointerDown={(e) => onNodeDown(e, n)} className={`absolute cursor-grab select-none rounded-[3px] border bg-white shadow-sm ${isSel ? "border-[#5b6ee1] ring-2 ring-[#5b6ee1]/30" : "border-[#c3ccd4]"} ${n.proposed ? "border-dashed !border-violet-500 ring-2 ring-violet-300/50" : ""}`} style={{ left: n.x, top: n.y, width: NW, opacity: dim ? 0.25 : 1 }} title={n.desc}>
                <div className="flex items-center gap-1 rounded-t-[2px] px-1.5 py-[3px] text-[10px] font-semibold text-white" style={{ background: n.color === "#ffffff" ? "#68707a" : n.color }}><span className="truncate">{n.label}</span>{n.proposed && <span className="ml-auto shrink-0 rounded bg-white/25 px-1 text-[8px]">AI · NEW</span>}</div>
                <div className="flex items-center justify-between px-1.5 py-[3px] text-[9px] text-[#68707a]"><span>{KIND_LABEL[n.kind]} · {n.cols} columns</span></div>
                <span className="absolute -left-[5px] top-1/2 h-[9px] w-[9px] -translate-y-1/2 rounded-full border border-[#68707a] bg-white" /><span className="absolute -right-[5px] top-1/2 h-[9px] w-[9px] -translate-y-1/2 rounded-full border border-[#68707a] bg-white" />
              </div>;
            })}
          </div>
          {/* Legend, as in the reference */}
          <div className="absolute right-3 top-3 w-[218px] rounded border border-[#d5dce3] bg-white/95 p-2.5 shadow-sm">
            <p className="text-[11px] font-semibold">Legend</p>
            {legend.map((l) => { const off = hidden.has(l.group); return <button key={l.group} onClick={() => { const s = new Set(hidden); if (off) { s.delete(l.group); } else { s.add(l.group); } setHidden(s); }} className={`flex w-full items-center gap-2 py-[3px] text-left text-[11px] ${off ? "opacity-40" : ""}`}><span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: l.color }} /><span className="flex-1 truncate">{l.group}</span><span className="text-[#7a8794]">({l.count})</span></button>; })}
            <p className="mt-1 border-t border-[#e3e8ed] pt-1.5 text-[10px] text-[#7a8794]">Click a group to show/hide it. Dashed violet = AI-proposed.</p>
          </div>
          {selected && <div className="absolute bottom-3 left-3 max-w-[330px] rounded border border-[#d5dce3] bg-white p-2.5 text-[11.5px] shadow"><p className="font-semibold">{selected.label} <span className="font-normal text-[#7a8794]">· {KIND_LABEL[selected.kind]}</span></p><p className="mt-0.5 text-[#5b6b7a]">{selected.desc} · {selected.cols} columns · group: {selected.group}</p><p className="mt-1 text-[#7a8794]">Inputs: {edges.filter((e) => e.to === selected.id).map((e) => byId(e.from)?.label).join(", ") || "—"} · Outputs: {edges.filter((e) => e.from === selected.id).map((e) => byId(e.to)?.label).join(", ") || "—"}</p></div>}
          <p className="absolute bottom-3 right-3 rounded bg-white/85 px-2 py-1 text-[10px] text-[#7a8794]">Drag canvas to pan · drag nodes to move · Connect, then click a target</p>
        </div>
      </>}

      {tab === "Proposals" && <div className="flex min-h-0 flex-1">
        <div className="w-[240px] shrink-0 overflow-y-auto border-r border-[#d5dce3] bg-white p-3 text-[12px]">
          <p className="font-semibold">Changes <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800">Open</span></p>
          <p className="mt-0.5 text-[11px] text-[#7a8794]">Merging “{branch}” into main</p>
          <p className="mt-3 text-[11px] font-medium">Pipeline settings · Parameters · Custom functions</p>
          <p className="mt-2 text-[11px]"><span className="font-medium">Transforms {proposed.length + 4}</span> · <span className="font-medium">Outputs 2</span></p>
          {(proposed.length ? proposed : [{ id: "x", label: "Generate an AI transform to populate this proposal", kind: "transform" as const, group: "", color: "", x: 0, y: 0, cols: 0, desc: "" }]).map((n) => <div key={n.id} className="mt-1.5 rounded border border-[#e3e8ed] px-2 py-1.5"><p className="font-medium">{n.label}</p><p className="text-[10px] text-emerald-700">Added{n.desc ? ` · ${n.desc}` : ""}</p></div>)}
          <div className="mt-3 space-y-1.5">
            <button onClick={() => setProposalState("Saved")} className="w-full rounded border border-emerald-600 py-1.5 font-medium text-emerald-700">Save</button>
            <button onClick={() => { setProposalState("In review"); notify("Proposal sent for review. Reviewers see exactly this diff."); }} className="w-full rounded border border-[#b9c4cf] py-1.5">Propose for review</button>
            <button onClick={() => { setProposalState("Approved"); notify("Proposal approved by operator. Ready to deploy."); }} className="w-full rounded bg-emerald-600 py-1.5 font-medium text-white">Approve</button>
            <button onClick={() => { setProposalState("Deploying"); setTimeout(() => { setProposalState("Deployed"); setNodes(nodes.map((n) => ({ ...n, proposed: false }))); notify("Proposal deployed to main."); }, 900); }} className="w-full rounded bg-[#5b6ee1] py-1.5 font-medium text-white">Deploy to main</button>
            <p className="text-center text-[11px] text-[#7a8794]">Status: {proposalState}</p>
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-auto p-3">
          <div className="grid gap-3 xl:grid-cols-2">
            <Compare title="main (current)" nodes={nodes.filter((n) => !n.proposed)} edges={edges} muted />
            <Compare title={`${branch} (proposed)`} nodes={nodes} edges={edges} />
          </div>
          <p className="mt-2 text-[11px] text-[#68707a]">Green outline = added by the proposal. Nothing deploys until an operator approves above.</p>
        </div>
      </div>}

      {tab === "History" && <div className="min-h-0 flex-1 overflow-y-auto p-3"><table className="w-full rounded border border-[#d5dce3] bg-white text-left text-[12px]"><thead className="bg-[#f7f9fb] text-[#68707a]"><tr><th className="px-3 py-2">Version</th><th className="px-3 py-2">Change</th><th className="px-3 py-2">By</th><th className="px-3 py-2">When</th><th className="px-3 py-2">State</th></tr></thead><tbody>{HISTORY.map((h) => <tr key={h.v} className="border-t border-[#e3e8ed]"><td className="px-3 py-2 font-mono text-[11px]">{h.v}</td><td className="px-3 py-2">{h.what}</td><td className="px-3 py-2">{h.who}</td><td className="px-3 py-2 text-[#68707a]">{h.at}</td><td className="px-3 py-2">{h.state}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
function Compare({ title, nodes, edges, muted }: { title: string; nodes: PNode[]; edges: PEdge[]; muted?: boolean }) {
  return <div className={`rounded border border-[#d5dce3] bg-white ${muted ? "opacity-70" : ""}`}><p className="border-b border-[#e3e8ed] px-2.5 py-1.5 font-mono text-[11px]">{title}</p><div className="space-y-1 p-2.5">{nodes.slice(0, 12).map((n) => <p key={n.id} className={`flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${n.proposed ? "border-emerald-500 bg-emerald-50" : "border-[#e3e8ed]"}`}><span className="h-2 w-2 rounded-sm" style={{ background: n.color === "#ffffff" ? "#68707a" : n.color }} />{n.label}<span className="ml-auto text-[10px] text-[#7a8794]">{n.proposed ? "Added" : KIND_LABEL[n.kind]}</span></p>)}{nodes.length > 12 && <p className="text-[10px] text-[#7a8794]">+ {nodes.length - 12} more nodes · {edges.length} edges</p>}</div></div>;
}
