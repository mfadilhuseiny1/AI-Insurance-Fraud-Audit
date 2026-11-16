"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, iconPath, type IconName } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import {
  COLOR_MODES,
  colorFor,
  KIND_COLOR,
  KIND_ICON,
  layoutNodes,
  wl,
  type Details,
  type Frame,
  type GraphState,
  type Index,
  type Placed,
  type SavedGraph,
  type TextNode,
  type WEdge,
  type WNode,
} from "@/lib/workflowLineage";

type View = { x: number; y: number; k: number };
type Bottom = null | "criteria" | "upgrades" | "model" | "weekly" | "model_usage" | "move" | "publish";
const H = 64;
const EMPTY: GraphState = { nodes: [], texts: [], color_mode: "node_type", frames: [], groups: [] };

export function WorkflowLineageEditor({ graphId, add }: { graphId: string | null; add: string | null }) {
  const router = useRouter();
  const [idx, setIdx] = useState<Index | null>(null);
  const [saved, setSaved] = useState<SavedGraph | null>(null);
  const [state, setState] = useState<GraphState>(EMPTY);
  const [past, setPast] = useState<GraphState[]>([]);
  const [future, setFuture] = useState<GraphState[]>([]);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [view, setView] = useState<View>({ x: 40, y: 60, k: 1 });
  const [tab, setTab] = useState<"add" | "details" | "presentation" | "legend" | null>("add");
  const [bottom, setBottom] = useState<Bottom>(null);
  const [workshopPanel, setWorkshopPanel] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; key?: string } | null>(null);
  const [org, setOrg] = useState<Record<string, { project: string; folder: string; project_id: string; folder_id: string }>>({});
  const [perms, setPerms] = useState<Awaited<ReturnType<typeof wl.permissions>>>({});
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [viewAs, setViewAs] = useState("");
  const [editingText, setEditingText] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [frameAt, setFrameAt] = useState(0);
  const [hideTrashed, setHideTrashed] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<null | { kind: "pan" | "move" | "box" | "text"; sx: number; sy: number; vx: number; vy: number; start?: Record<string, { x: number; y: number }>; before?: GraphState; moved?: boolean }>(null);
  const [box, setBox] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const width = state.node_width ?? 240;

  useEffect(() => {
    wl.index().then(setIdx, (e: Error) => setErr(e.message));
    wl.users().then(setUsers, () => {});
  }, []);
  useEffect(() => {
    if (!graphId) return;
    wl.graph(graphId).then(
      (g) => {
        setSaved(g);
        const st = { ...EMPTY, ...g.state };
        // nodes saved without positions (made through the API) get a layout once the index is known
        setState(st.nodes.some((p) => typeof p.x !== "number" || typeof p.y !== "number") ? { ...st, nodes: st.nodes.map((p, i) => ({ ...p, x: Number.isFinite(p.x) ? p.x : NaN, y: Number.isFinite(p.y) ? p.y : i })) } : st);
      },
      (e: Error) => setErr(e.message),
    );
  }, [graphId]);
  const byKey = useMemo(() => Object.fromEntries((idx?.nodes ?? []).map((n) => [n.key, n])), [idx]);
  const onGraph = useMemo(() => new Set(state.nodes.map((p) => p.key)), [state.nodes]);
  const ups = useMemo(() => {
    const u: Record<string, WEdge[]> = {};
    const d: Record<string, WEdge[]> = {};
    for (const e of idx?.edges ?? []) {
      (u[e.to] ??= []).push(e);
      (d[e.from] ??= []).push(e);
    }
    return { u, d };
  }, [idx]);

  const change = useCallback((s: GraphState, record = true, prev?: GraphState) => {
    setState((cur) => {
      if (record) {
        setPast((p) => [...p.slice(-80), prev ?? cur]);
        setFuture([]);
      }
      return s;
    });
    setDirty(true);
  }, []);
  const addKeys = useCallback(
    (keys: string[], near?: { x: number; y: number }) => {
      setState((cur) => {
        const have = new Set(cur.nodes.map((p) => p.key));
        const fresh = keys.filter((k) => !have.has(k));
        if (!fresh.length) return cur;
        const maxY = cur.nodes.length ? Math.max(...cur.nodes.map((p) => p.y)) + 100 : 0;
        const base = near ?? { x: 0, y: maxY };
        const nodes = [...cur.nodes, ...fresh.map((k, i) => ({ key: k, x: base.x + (i % 4) * (width + 60), y: base.y + Math.floor(i / 4) * 96 }))];
        setPast((p) => [...p.slice(-80), cur]);
        return { ...cur, nodes };
      });
      setDirty(true);
    },
    [width],
  );
  const expand = useCallback(
    (key: string, dir: "up" | "down", all = false) => {
      const seen = new Set<string>([key]);
      let frontier = [key];
      do {
        const next: string[] = [];
        for (const k of frontier)
          for (const e of (dir === "up" ? ups.u[k] : ups.d[k]) ?? []) {
            if (e.kind === "link") continue;
            const o = dir === "up" ? e.from : e.to;
            if (!seen.has(o)) {
              seen.add(o);
              next.push(o);
            }
          }
        frontier = next;
      } while (all && frontier.length && seen.size < 800);
      seen.delete(key);
      const p = state.nodes.find((x) => x.key === key);
      const keys = [...seen].slice(0, 800);
      if (!p) return addKeys(keys);
      // place them beside the node, upstream on the left and downstream on the right
      setState((cur) => {
        const have = new Set(cur.nodes.map((x) => x.key));
        const fresh = keys.filter((k) => !have.has(k));
        if (!fresh.length) return cur;
        setPast((pp) => [...pp.slice(-80), cur]);
        return { ...cur, nodes: [...cur.nodes, ...fresh.map((k, i) => ({ key: k, x: p.x + (dir === "up" ? -1 : 1) * (width + 90) * (1 + Math.floor(i / 8)), y: p.y + ((i % 8) - Math.min(fresh.length, 8) / 2 + 0.5) * 84 }))] };
      });
      setDirty(true);
    },
    [ups, state.nodes, addKeys, width],
  );
  useEffect(() => {
    if (!idx || !state.nodes.some((p) => Number.isNaN(p.x))) return;
    const t = setTimeout(() => setState((cur) => ({ ...cur, nodes: layoutNodes(cur.nodes, idx.edges, "layers", width) })), 0);
    return () => clearTimeout(t);
  }, [idx, state.nodes, width]);
  // ?add=<key>: open a resource with one step up and downstream (the Ctrl+I entry point)
  const added = useRef(false);
  useEffect(() => {
    if (!add || !idx || added.current) return;
    added.current = true;
    const keys = add.split(",").filter((k) => byKey[k]);
    const near = new Set(keys);
    for (const k of keys) for (const e of [...(ups.u[k] ?? []), ...(ups.d[k] ?? [])]) if (e.kind !== "link" && near.size < 800) {
        near.add(e.from);
        near.add(e.to);
      }
    const placed = layoutNodes([...near].map((k) => ({ key: k, x: 0, y: 0 })), idx.edges, "layers", width);
    const t = setTimeout(() => {
      setState((s) => ({ ...s, nodes: placed }));
      setSel(keys);
    }, 0);
    return () => clearTimeout(t);
  }, [add, idx, byKey, ups, width]);

  // color mode data
  const shownKeys = state.nodes.map((p) => p.key).join(",");
  useEffect(() => {
    if (!shownKeys || !["project", "folder"].includes(state.color_mode)) return;
    let stale = false;
    wl.organization(shownKeys.split(",")).then((o) => !stale && setOrg(o), () => {});
    return () => {
      stale = true;
    };
  }, [shownKeys, state.color_mode]);
  useEffect(() => {
    if (!shownKeys || !viewAs || !state.color_mode.startsWith("permissions")) return;
    let stale = false;
    wl.permissions(shownKeys.split(","), viewAs).then((o) => !stale && setPerms(o), () => {});
    return () => {
      stale = true;
    };
  }, [shownKeys, viewAs, state.color_mode]);

  const nodes = state.nodes.filter((p) => byKey[p.key] && !(hideTrashed && byKey[p.key]?.trashed));
  const maxViews = Math.max(1, ...nodes.map((p) => byKey[p.key].views_4w ?? 0));
  const maxTokens = Math.max(1, ...nodes.map((p) => byKey[p.key].tokens ?? 0));
  const groupColor = (p: Placed) => state.groups.find((g) => g.id === p.color)?.color ?? null;
  const col = (p: Placed) => colorFor(byKey[p.key], state.color_mode, { org, perms, custom: groupColor(p), maxViews, maxTokens });
  const visibleEdges = (idx?.edges ?? []).filter((e) => onGraph.has(e.from) && onGraph.has(e.to) && (e.kind !== "link" || sel.includes(e.from) || sel.includes(e.to)));

  const world = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  const fit = useCallback(
    (only?: Placed[]) => {
      const list = (only?.length ? only : state.nodes).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      const el = svgRef.current;
      if (!list.length || !el) return;
      const x0 = Math.min(...list.map((p) => p.x));
      const y0 = Math.min(...list.map((p) => p.y));
      const x1 = Math.max(...list.map((p) => p.x + width));
      const y1 = Math.max(...list.map((p) => p.y + H));
      const k = Math.min(1.3, Math.max(0.15, Math.min((el.clientWidth - 80) / (x1 - x0), (el.clientHeight - 80) / (y1 - y0))));
      setView({ k, x: (el.clientWidth - (x1 - x0) * k) / 2 - x0 * k, y: (el.clientHeight - (y1 - y0) * k) / 2 - y0 * k });
    },
    [state.nodes, width],
  );
  const fitted = useRef("");
  useEffect(() => {
    const key = `${graphId}|${state.nodes.length > 0}`;
    if (fitted.current === key || !state.nodes.length || state.nodes.some((p) => !Number.isFinite(p.x))) return;
    fitted.current = key;
    const t = setTimeout(() => fit(), 50);
    return () => clearTimeout(t);
  }, [graphId, state.nodes, fit]);

  const save = async () => {
    if (!saved) return setSaveDialog(true);
    try {
      const g = await wl.saveGraph(saved.id, state);
      setSaved(g);
      setDirty(false);
      setMsg(`Saved ${when(g.updated_at)}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [state, ...f]);
    setState(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, state]);
    setState(future[0]);
    setFuture((f) => f.slice(1));
  };
  const layout = (mode: "layers" | "vertical" | "grid" | "horizontal", onlySel = false) => {
    const target = onlySel && sel.length > 1 ? state.nodes.filter((p) => sel.includes(p.key)) : state.nodes;
    const laid = layoutNodes(target, idx?.edges ?? [], mode, width);
    if (onlySel && sel.length > 1) {
      const ox = Math.min(...target.map((p) => p.x));
      const oy = Math.min(...target.map((p) => p.y));
      const m = Object.fromEntries(laid.map((p) => [p.key, { ...p, x: p.x + ox, y: p.y + oy }]));
      change({ ...state, nodes: state.nodes.map((p) => m[p.key] ?? p) });
    } else change({ ...state, nodes: laid });
    setTimeout(() => fit(), 0);
  };
  const reach = (keys: string[], dir: "up" | "down", all: boolean) => {
    const out = new Set<string>();
    let frontier = keys;
    do {
      const next: string[] = [];
      for (const k of frontier)
        for (const e of (dir === "up" ? ups.u[k] : ups.d[k]) ?? []) {
          const o = dir === "up" ? e.from : e.to;
          if (e.kind !== "link" && onGraph.has(o) && !out.has(o)) {
            out.add(o);
            next.push(o);
          }
        }
      frontier = next;
    } while (all && frontier.length);
    return [...out];
  };
  const applyFrame = (f: Frame) => {
    setState((s) => ({ ...s, nodes: f.state.nodes, texts: f.state.texts, color_mode: f.state.color_mode }));
    setView(f.state.view);
  };

  // keyboard shortcuts (Help → hotkeys)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      const run = (f: () => void) => (e.preventDefault(), f());
      if (mod && k.toLowerCase() === "s") run(() => void save());
      else if (mod && (k.toLowerCase() === "y" || (k.toLowerCase() === "z" && e.shiftKey))) run(redo);
      else if (mod && k.toLowerCase() === "z") run(undo);
      else if (mod && e.shiftKey && k.toLowerCase() === "a") run(() => layout("layers"));
      else if (mod && k.toLowerCase() === "a") run(() => setSel(state.nodes.map((p) => p.key)));
      else if (mod && k.toLowerCase() === "i") run(() => setSel(state.nodes.map((p) => p.key).filter((x) => !sel.includes(x))));
      else if (mod && k.toLowerCase() === "c") run(() => void navigator.clipboard?.writeText(sel.map((x) => byKey[x]?.name).join("\n")));
      else if (k === "ArrowUp" || k === "Home") run(() => fit());
      else if (k === "ArrowRight") run(() => setSel(reach(sel, "down", e.shiftKey)));
      else if (k === "ArrowLeft") run(() => setSel(reach(sel, "up", e.shiftKey)));
      else if (k === "Escape") run(() => (setSel([]), setMenu(null), setEditingText(null)));
      else if ((k === "Delete" || k === "Backspace") && sel.length) run(() => (change({ ...state, nodes: state.nodes.filter((p) => !sel.includes(p.key)), texts: state.texts.filter((t) => !sel.includes(t.id)) }), setSel([])));
      else if (k.toLowerCase() === "l" && e.shiftKey) run(() => layout("layers"));
      else if (k.toLowerCase() === "l" && e.altKey) run(() => layout("layers"));
      else if (k.toLowerCase() === "l") run(() => layout("layers", true));
      else if (k.toLowerCase() === "g") run(() => layout("grid", true));
      else if (k.toLowerCase() === "v") run(() => layout("vertical", true));
      else if (k.toLowerCase() === "h") run(() => layout("horizontal", true));
      else if (k.toLowerCase() === "i") run(() => setWorkshopPanel((w) => !w));
      else if ((k === "," || k === ".") && state.frames.length) {
        const i = Math.max(0, Math.min(state.frames.length - 1, frameAt + (k === "." ? 1 : -1)));
        run(() => (setFrameAt(i), applyFrame(state.frames[i])));
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (err) return <p className="p-8 text-sm text-bad">{err}</p>;
  if (!idx) return <p className="p-8 text-sm text-muted">Loading the workflow graph…</p>;
  const one = sel.length === 1 ? byKey[sel[0]] : null;
  const selNodes = sel.map((k) => byKey[k]).filter(Boolean);
  const workshops = state.nodes.map((p) => byKey[p.key]).filter((n) => n?.kind === "workshop");
  const legend = (() => {
    const m: Record<string, { color: string; n: number }> = {};
    for (const p of nodes) {
      const c = col(p);
      const o = (m[c.label] ??= { color: c.color, n: 0 });
      o.n += 1;
    }
    return Object.entries(m);
  })();
  const ontologies = [...new Set(nodes.map((p) => byKey[p.key].ontology_id).filter(Boolean))];

  const down = (e: React.PointerEvent, key?: string, text?: TextNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = world(e.clientX, e.clientY);
    const id = key ?? text?.id;
    if (!id) {
      if (e.shiftKey) drag.current = { kind: "box", sx: p.x, sy: p.y, vx: 0, vy: 0 };
      else {
        drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
        setSel([]);
      }
      return;
    }
    const picked = e.shiftKey || e.ctrlKey || e.metaKey ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : sel.includes(id) ? sel : [id];
    setSel(picked);
    if (presenting) return;
    const start: Record<string, { x: number; y: number }> = {};
    for (const q of state.nodes) if (picked.includes(q.key)) start[q.key] = { x: q.x, y: q.y };
    for (const t of state.texts) if (picked.includes(t.id)) start[t.id] = { x: t.x, y: t.y };
    drag.current = { kind: "move", sx: p.x, sy: p.y, vx: 0, vy: 0, start, before: state };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") return setView({ ...view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
    const p = world(e.clientX, e.clientY);
    if (d.kind === "box") return setBox({ x0: d.sx, y0: d.sy, x1: p.x, y1: p.y });
    const dx = Math.round(p.x - d.sx);
    const dy = Math.round(p.y - d.sy);
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    const st = d.start ?? {};
    setState((s) => ({
      ...s,
      nodes: s.nodes.map((q) => (st[q.key] ? { ...q, x: st[q.key].x + dx, y: st[q.key].y + dy } : q)),
      texts: s.texts.map((t) => (st[t.id] ? { ...t, x: st[t.id].x + dx, y: st[t.id].y + dy } : t)),
    }));
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "box" && box) {
      const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
      const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
      setSel([...new Set([...sel, ...state.nodes.filter((p) => p.x >= x0 && p.x + width <= x1 && p.y >= y0 && p.y + H <= y1).map((p) => p.key)])]);
      setBox(null);
    }
    if (d?.kind === "move" && d.moved && d.before) {
      setPast((p) => [...p.slice(-80), d.before!]);
      setFuture([]);
      setDirty(true);
    }
  };

  return (
    <div className="flex h-full flex-col" data-workflow-lineage>
      {!presenting && (
        <AppHeader app="Workflow Lineage" icon="split" href="/workflow-lineage" crumbs={[{ label: saved?.name ?? "Unsaved graph" }]}>
          <select value={state.color_mode} onChange={(e) => change({ ...state, color_mode: e.target.value }, false)} className={`${fieldClass} text-xs`} aria-label="Color mode" data-color-mode>
            {[...new Set(COLOR_MODES.map((m) => m.group))].map((g) => (
              <optgroup key={g} label={g}>
                {COLOR_MODES.filter((m) => m.group === g).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {state.color_mode.startsWith("permissions") && (
            <select value={viewAs} onChange={(e) => setViewAs(e.target.value)} className={`${fieldClass} text-xs`} aria-label="View as">
              <option value="">View as…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          )}
          <span className="text-[11px] text-muted">{msg ?? (dirty ? "Unsaved changes" : "")}</span>
          <button type="button" onClick={undo} title="Undo (Ctrl+Z)" className={buttonClass.ghost}>
            <Icon name="left" className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={redo} title="Redo (Ctrl+Y)" className={buttonClass.ghost}>
            <Icon name="right" className="h-3.5 w-3.5" />
          </button>
          {(saved?.can_edit ?? true) && (
            <button type="button" onClick={save} className={buttonClass.primary}>
              <Icon name="save" className="h-3.5 w-3.5" /> Save
            </button>
          )}
        </AppHeader>
      )}
      <div className="flex min-h-0 flex-1">
        {!presenting && (
          <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
            {(
              [
                ["add", "search", "Add resources"],
                ["details", "info", "Selection details"],
                ["legend", "palette", "Color legend"],
                ["presentation", "play", "Presentation"],
              ] as const
            ).map(([t, icon, title]) => (
              <button key={t} type="button" title={title} aria-label={title} onClick={() => setTab(tab === t ? null : t)} className={`rounded p-1.5 ${tab === t ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`} data-tab={t}>
                <Icon name={icon} className="h-4 w-4" />
              </button>
            ))}
          </nav>
        )}
        {!presenting && tab && (
          <aside className="w-80 shrink-0 overflow-auto border-r border-line bg-panel text-xs">
            {tab === "add" && <AddPanel idx={idx} onGraph={onGraph} onAdd={(k) => addKeys(k)} onHighlight={setHighlight} />}
            {tab === "details" && (
              <DetailsPanel sel={selNodes} byKey={byKey} onSelect={setSel} viewAs={viewAs || users[0]?.id || ""} users={users} onOpenBottom={setBottom}
                onExpand={(k, d) => expand(k, d)} onHighlight={setHighlight} idx={idx} />
            )}
            {tab === "legend" && (
              <div className="space-y-2 p-3" data-legend>
                <div className="font-medium text-soft">{COLOR_MODES.find((m) => m.id === state.color_mode)?.name}</div>
                {legend.map(([l, v]) => (
                  <div key={l} className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded" style={{ background: v.color }} />
                    <span className="flex-1">{l}</span>
                    <span className="text-muted">{v.n}</span>
                  </div>
                ))}
                {state.color_mode === "custom" && (
                  <div className="space-y-1 border-t border-line pt-2">
                    {state.groups.map((g) => (
                      <div key={g.id} className="flex items-center gap-1">
                        <input type="color" value={g.color} onChange={(e) => change({ ...state, groups: state.groups.map((x) => (x.id === g.id ? { ...x, color: e.target.value } : x)) })} className="h-5 w-6 bg-transparent" />
                        <input value={g.name} onChange={(e) => change({ ...state, groups: state.groups.map((x) => (x.id === g.id ? { ...x, name: e.target.value } : x)) }, false)} className={`${fieldClass} flex-1 text-xs`} />
                        <button type="button" disabled={!sel.length} onClick={() => change({ ...state, nodes: state.nodes.map((p) => (sel.includes(p.key) ? { ...p, color: g.id } : p)) })} className="text-ocean disabled:opacity-40">
                          Apply
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => change({ ...state, groups: [...state.groups, { id: `g-${Date.now().toString(36)}`, name: `Group ${state.groups.length + 1}`, color: "#3b82f6" }] })} className="text-ocean">
                      + Color group
                    </button>
                  </div>
                )}
                {state.color_mode.startsWith("permissions") && !viewAs && <p className="text-warn">Choose a user in “View as” (top bar).</p>}
                <label className="flex items-center gap-2 border-t border-line pt-2">
                  Node width
                  <input type="range" min={180} max={420} value={width} onChange={(e) => change({ ...state, node_width: Number(e.target.value) }, false)} />
                </label>
                {ontologies.length > 1 && <p className="text-warn">Resources from {ontologies.length} ontologies are on the graph: {ontologies.join(", ")}</p>}
              </div>
            )}
            {tab === "presentation" && (
              <div className="space-y-2 p-3" data-presentation>
                {!saved && <p className="text-warn">Save the graph before using presentation mode.</p>}
                <button type="button" disabled={!saved}
                  onClick={() => change({ ...state, frames: [...state.frames, { id: `f-${Date.now().toString(36)}`, name: `Frame (${state.frames.length + 1})`, state: { nodes: state.nodes, texts: state.texts, color_mode: state.color_mode, view } }] })}
                  className={buttonClass.secondary}>
                  Save state as new frame
                </button>
                {state.frames.map((f, i) => (
                  <div key={f.id} className={`flex items-center gap-1 rounded border px-2 py-1 ${i === frameAt ? "border-ocean" : "border-line"}`}>
                    <button type="button" onClick={() => (setFrameAt(i), applyFrame(f))} className="text-muted">
                      {i + 1}
                    </button>
                    <input value={f.name} onChange={(e) => change({ ...state, frames: state.frames.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)) }, false)} className={`${fieldClass} flex-1 text-xs`} />
                    <button type="button" disabled={i === 0} onClick={() => { const fr = [...state.frames]; [fr[i - 1], fr[i]] = [fr[i], fr[i - 1]]; change({ ...state, frames: fr }); }} className="text-muted disabled:opacity-30" aria-label="Move up">
                      ↑
                    </button>
                    <button type="button" onClick={() => change({ ...state, frames: state.frames.filter((x) => x.id !== f.id) })} className="text-muted hover:text-bad" aria-label="Delete frame">
                      <Icon name="trash" className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {state.frames.length > 0 && (
                  <button type="button" onClick={() => (setPresenting(true), setFrameAt(0), applyFrame(state.frames[0]))} className={buttonClass.primary}>
                    <Icon name="play" className="h-3.5 w-3.5" /> Present
                  </button>
                )}
                <p className="text-muted">Use , and . to move between frames.</p>
              </div>
            )}
          </aside>
        )}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {!presenting && (
            <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1 text-xs" data-toolbar>
              <button type="button" onClick={() => change({ ...state, texts: [...state.texts, { id: `t-${Date.now().toString(36)}`, x: (-view.x + 80) / view.k, y: (-view.y + 80) / view.k, w: 320, h: 90, text: "**Note**" }] })} className={buttonClass.ghost}>
                <Icon name="doc" className="h-3.5 w-3.5" /> Text
              </button>
              <button type="button" disabled={!sel.length} onClick={() => sel.forEach((k) => expand(k, "up"))} className={buttonClass.ghost} title="Expand selected nodes one step upstream">
                ← Upstream
              </button>
              <button type="button" disabled={!sel.length} onClick={() => sel.forEach((k) => expand(k, "down"))} className={buttonClass.ghost} title="Expand selected nodes one step downstream">
                Downstream →
              </button>
              <button type="button" onClick={() => layout("layers")} className={buttonClass.ghost} title="Lay out all nodes (Ctrl+Shift+A)">
                Layout
              </button>
              <button type="button" onClick={() => fit()} className={buttonClass.ghost} title="Zoom to fit (↑ / Home)">
                <Icon name="fit" className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setHideTrashed(!hideTrashed)} className={`${buttonClass.ghost} ${hideTrashed ? "text-ocean" : ""}`} title="Filter trashed resources">
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
              {workshops.length > 0 && (
                <button type="button" onClick={() => setWorkshopPanel(!workshopPanel)} className={`${buttonClass.ghost} ${workshopPanel ? "text-ocean" : ""}`} title="Workshop panel (I)">
                  <Icon name="device" className="h-3.5 w-3.5" /> Workshop
                </button>
              )}
              <span className="mx-1 h-4 w-px bg-line" />
              {(
                [
                  ["criteria", "Submission criteria"],
                  ["upgrades", "Function upgrades"],
                  ["model", "Replace model"],
                  ["weekly", "Weekly views"],
                  ["model_usage", "Model usage"],
                  ["move", "Move resources"],
                  ["publish", "Publish Workshop"],
                ] as const
              ).map(([b, t]) => (
                <button key={b} type="button" onClick={() => setBottom(bottom === b ? null : b)} className={`rounded px-2 py-1 ${bottom === b ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`} data-bottom={b}>
                  {t}
                </button>
              ))}
              <span className="ml-auto text-muted">
                {nodes.length} nodes · {visibleEdges.length} edges
              </span>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <svg ref={svgRef} className="h-full w-full touch-none select-none bg-ink" onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up}
              onWheel={(e) => {
                const r = svgRef.current!.getBoundingClientRect();
                const k = Math.min(2.5, Math.max(0.12, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
                const mx = e.clientX - r.left;
                const my = e.clientY - r.top;
                setView({ k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k });
              }}
              onContextMenu={(e) => e.preventDefault()} data-wl-canvas>
              <defs>
                <marker id="wl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-muted)" />
                </marker>
              </defs>
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {state.texts.map((t) => (
                  <foreignObject key={t.id} x={t.x} y={t.y} width={t.w} height={t.h} onPointerDown={(e) => down(e, undefined, t)} onDoubleClick={() => setEditingText(t.id)} data-text-node={t.id}>
                    <div className={`h-full w-full overflow-auto rounded-md border p-2 text-xs ${sel.includes(t.id) ? "border-ocean" : "border-line-2"}`} style={{ background: t.color ? `${t.color}55` : "var(--color-panel)" }}>
                      {editingText === t.id ? (
                        <textarea autoFocus defaultValue={t.text} onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
                          }}
                          onBlur={(e) => (change({ ...state, texts: state.texts.map((x) => (x.id === t.id ? { ...x, text: e.target.value } : x)) }), setEditingText(null))} className="h-full w-full resize-none bg-transparent text-xs outline-none" />
                      ) : (
                        <div className="md-body text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }} />
                      )}
                    </div>
                  </foreignObject>
                ))}
                {visibleEdges.map((e, i) => {
                  const a = state.nodes.find((p) => p.key === e.from)!;
                  const b = state.nodes.find((p) => p.key === e.to)!;
                  const x1 = a.x + width;
                  const y1 = a.y + H / 2;
                  const x2 = b.x;
                  const y2 = b.y + H / 2;
                  const c = Math.max(40, Math.abs(x2 - x1) / 2);
                  const hot = sel.includes(e.from) || sel.includes(e.to);
                  return (
                    <path key={i} d={e.kind === "link" ? `M ${a.x + width / 2} ${a.y + H} C ${a.x + width / 2} ${a.y + H + 60}, ${b.x + width / 2} ${b.y + H + 60}, ${b.x + width / 2} ${b.y + H}` : `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`}
                      fill="none" stroke={e.out_of_date ? "var(--color-bad)" : hot ? "var(--color-ocean)" : "var(--color-line-2)"} strokeWidth={hot ? 2 : 1.3} strokeDasharray={e.kind === "link" ? "4 3" : e.kind === "triggers" ? "2 3" : undefined}
                      markerEnd={e.kind === "link" ? undefined : "url(#wl-arrow)"}>
                      <title>{e.kind}{e.name ? ` · ${e.name}` : ""}{e.version ? ` · v${e.version}${e.latest && e.latest !== e.version ? ` (latest ${e.latest})` : ""}` : ""}</title>
                    </path>
                  );
                })}
                {nodes.map((p) => {
                  const n = byKey[p.key];
                  const c = col(p);
                  const hidUp = (ups.u[p.key] ?? []).filter((e) => e.kind !== "link" && !onGraph.has(e.from)).length;
                  const hidDown = (ups.d[p.key] ?? []).filter((e) => e.kind !== "link" && !onGraph.has(e.to)).length;
                  const on = sel.includes(p.key);
                  const lit = highlight.includes(p.key);
                  const sub =
                    state.color_mode === "failure_rate" && n.failure_rate !== undefined && n.failure_rate !== null
                      ? `${Math.round(n.failure_rate * 100)}% failed · ${n.runs_30d} runs`
                      : state.color_mode === "usage" && n.kind === "workshop"
                        ? `${n.views_4w ?? 0} views · ${n.users_4w ?? 0} users (4 weeks)`
                        : state.color_mode === "model_usage" && n.kind === "language_model"
                          ? `${n.requests ?? 0} requests · ${(n.tokens ?? 0).toLocaleString()} tokens`
                          : state.color_mode === "last_modified" && n.updated_at
                            ? `modified ${when(n.updated_at)}`
                            : `${idx.kinds[n.kind]}${n.api_name ? ` · ${n.api_name}` : ""}`;
                  return (
                    <g key={p.key} transform={`translate(${p.x},${p.y})`} onPointerDown={(e) => down(e, p.key)} onDoubleClick={() => n.kind === "workshop" && (setSel([p.key]), setWorkshopPanel(true))}
                      onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), !sel.includes(p.key) && setSel([p.key]), setMenu({ x: e.clientX, y: e.clientY, key: p.key }))} className="cursor-pointer" data-wl-node={p.key}>
                      <rect width={width} height={H} rx={7} fill="var(--color-panel-2)" stroke={on ? "var(--color-ocean)" : lit ? "#fde047" : "var(--color-line-2)"} strokeWidth={on || lit ? 2.2 : 1.2} />
                      <rect width={width} height={6} rx={3} fill={c.color} />
                      <g transform="translate(10,16) scale(0.75)">
                        <path d={iconPath((n.icon && n.kind === "object_type" ? n.icon : KIND_ICON[n.kind]) as IconName) ?? iconPath("cube")} fill="none" stroke={KIND_COLOR[n.kind]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                      </g>
                      <text x={34} y={31} fontSize={13} fontWeight={600} fill="var(--color-strong)">
                        {clip(n.name, Math.floor((width - 70) / 7.3))}
                      </text>
                      <text x={34} y={50} fontSize={10.5} fill="var(--color-muted)">
                        {clip(sub, Math.floor((width - 70) / 5.9))}
                      </text>
                      {n.ontology_id && n.ontology_id !== "default" && (
                        <text x={width - 18} y={22} fontSize={12} fill="var(--color-warn)">
                          ⚠
                        </text>
                      )}
                      {hidUp > 0 && (
                        <g transform={`translate(-14,${H / 2})`} onPointerDown={(e) => (e.stopPropagation(), expand(p.key, "up", e.shiftKey))} className="cursor-pointer" data-expand="up">
                          <circle r={11} fill="var(--color-panel)" stroke="var(--color-line-2)" />
                          <text textAnchor="middle" y={4} fontSize={10} fill="var(--color-soft)">
                            {hidUp}
                          </text>
                        </g>
                      )}
                      {hidDown > 0 && (
                        <g transform={`translate(${width + 14},${H / 2})`} onPointerDown={(e) => (e.stopPropagation(), expand(p.key, "down", e.shiftKey))} className="cursor-pointer" data-expand="down">
                          <circle r={11} fill="var(--color-panel)" stroke="var(--color-ocean)" />
                          <text textAnchor="middle" y={4} fontSize={10} fill="var(--color-soft)">
                            {hidDown}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {box && <rect x={Math.min(box.x0, box.x1)} y={Math.min(box.y0, box.y1)} width={Math.abs(box.x1 - box.x0)} height={Math.abs(box.y1 - box.y0)} fill="var(--color-ocean)" fillOpacity={0.08} stroke="var(--color-ocean)" strokeDasharray="4 3" />}
              </g>
            </svg>
            {!state.nodes.length && !add && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">Search for resources on the left (or open one with ?add=) to start the graph.</div>
            )}
            {one && !presenting && (
              <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-md border border-line bg-panel p-1 text-xs shadow">
                <span className="max-w-56 truncate px-1 text-soft">{one.name}</span>
                {hrefOf(one) && (
                  <Link href={hrefOf(one)!} target="_blank" className="text-ocean hover:underline">
                    Open in new tab
                  </Link>
                )}
              </div>
            )}
            {presenting && (
              <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-xs shadow">
                <button type="button" disabled={frameAt === 0} onClick={() => (setFrameAt(frameAt - 1), applyFrame(state.frames[frameAt - 1]))} className="disabled:opacity-30">
                  ‹
                </button>
                <span>
                  {state.frames[frameAt]?.name} ({frameAt + 1}/{state.frames.length})
                </span>
                <button type="button" disabled={frameAt >= state.frames.length - 1} onClick={() => (setFrameAt(frameAt + 1), applyFrame(state.frames[frameAt + 1]))} className="disabled:opacity-30">
                  ›
                </button>
                <button type="button" onClick={() => setPresenting(false)} className="text-ocean">
                  Exit
                </button>
              </div>
            )}
          </div>
          {bottom && !presenting && (
            <BottomPanel which={bottom} sel={selNodes} graphKeys={state.nodes.map((p) => p.key)} byKey={byKey} idx={idx} onDone={async (m) => (setMsg(m), setIdx(await wl.index(true)))} onClose={() => setBottom(null)} onSelect={setSel} />
          )}
        </div>
        {workshopPanel && !presenting && workshops.length > 0 && <WorkshopPanel workshops={workshops} sel={sel} onSelect={setSel} byKey={byKey} onClose={() => setWorkshopPanel(false)} />}
      </div>
      {menu && menu.key && (
        <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)}>
          <div style={{ left: menu.x, top: menu.y }} className="absolute w-60 rounded-lg border border-line bg-panel p-1 text-xs shadow-xl" onPointerDown={(e) => e.stopPropagation()} data-wl-menu>
            {(() => {
              const n = byKey[menu.key!];
              const item = (t: string, f: () => void, danger = false) => (
                <button key={t} type="button" onClick={() => (setMenu(null), f())} className={`block w-full rounded px-2 py-1 text-left hover:bg-panel-2 ${danger ? "text-bad" : ""}`}>
                  {t}
                </button>
              );
              return (
                <>
                  {hrefOf(n) && item("Open in new tab", () => window.open(hrefOf(n)!, "_blank"))}
                  {n.kind === "object_type" && item("Open in Data Lineage", () => window.open(`/lineage?focus=${encodeURIComponent(`object_type:${n.id}`)}`, "_blank"))}
                  {item("Expand upstream", () => sel.forEach((k) => expand(k, "up")))}
                  {item("Expand downstream", () => sel.forEach((k) => expand(k, "down")))}
                  {item("Expand all upstream", () => sel.forEach((k) => expand(k, "up", true)))}
                  {item("Expand all downstream", () => sel.forEach((k) => expand(k, "down", true)))}
                  {item("Selection details", () => setTab("details"))}
                  {state.groups.length > 0 && state.groups.map((g) => item(`Color nodes: ${g.name}`, () => change({ ...state, color_mode: "custom", nodes: state.nodes.map((p) => (sel.includes(p.key) ? { ...p, color: g.id } : p)) })))}
                  {item("Color nodes: new group", () => {
                    const g = { id: `g-${Date.now().toString(36)}`, name: `Group ${state.groups.length + 1}`, color: ["#3b82f6", "#22c55e", "#f59e0b", "#ec4899"][state.groups.length % 4] };
                    change({ ...state, color_mode: "custom", groups: [...state.groups, g], nodes: state.nodes.map((p) => (sel.includes(p.key) ? { ...p, color: g.id } : p)) });
                  })}
                  {n.kind === "action_type" && item("Debug permissions", () => setTab("details"))}
                  {sel.some((k) => byKey[k]?.kind === "action_type") && item(`Update submission criteria (${sel.filter((k) => byKey[k]?.kind === "action_type").length})`, () => setBottom("criteria"))}
                  {item(`Move resources (${sel.length})`, () => setBottom("move"))}
                  {sel.some((k) => byKey[k]?.kind === "workshop") && item(`Publish Workshop modules (${sel.filter((k) => byKey[k]?.kind === "workshop").length})`, () => setBottom("publish"))}
                  {item(`Remove from graph (${sel.length})`, () => (change({ ...state, nodes: state.nodes.filter((p) => !sel.includes(p.key)) }), setSel([])), true)}
                </>
              );
            })()}
          </div>
        </div>
      )}
      {saveDialog && <SaveDialog state={state} onClose={() => setSaveDialog(false)} onSaved={(g) => (setSaveDialog(false), setDirty(false), router.replace(`/workflow-lineage/${g.id}`))} />}
    </div>
  );
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + "…" : t);
function hrefOf(n: WNode): string | null {
  const m: Record<string, string> = {
    object_type: `/ontology/${n.id}`,
    action_type: `/ontology/actions/${n.id}`,
    logic: `/logic/${n.id}`,
    automation: `/automate/${n.id}`,
    workshop: `/workshop/${n.id}`,
    slate: `/slate/${n.id}`,
    widget_set: "/custom-widgets",
    osdk_app: "/developer-console",
    vertex: `/vertex?id=${n.id}`,
    notepad: `/notepad/${n.id}`,
    machinery: `/machinery?id=${n.id}`,
    function: "/functions",
    interface: "/ontology",
    language_model: "/models",
  };
  return m[n.kind] ?? null;
}

function AddPanel({ idx, onGraph, onAdd, onHighlight }: { idx: Index; onGraph: Set<string>; onAdd: (keys: string[]) => void; onHighlight: (k: string[]) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<(WNode & { match: string })[]>([]);
  const [kind, setKind] = useState("");
  const [folder, setFolder] = useState<{ id: string | null; items: DriveItem[]; path: { id: string; name: string }[] }>({ id: null, items: [], path: [] });
  useEffect(() => {
    let stale = false;
    const t = setTimeout(() => {
      if (!q.trim()) {
        setRes([]);
        onHighlight([]);
        return;
      }
      wl.search(q).then((r) => {
        if (stale) return;
        setRes(r);
        onHighlight(r.map((x) => x.key));
      }, () => {});
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, onHighlight]);
  useEffect(() => {
    let stale = false;
    api.drive.folder(folder.id).then((f) => !stale && setFolder((cur) => ({ ...cur, items: f.items.filter((i) => i.kind === "project" || i.kind === "folder") })), () => {});
    return () => {
      stale = true;
    };
  }, [folder.id]);
  const browse = kind ? idx.nodes.filter((n) => n.kind === kind) : [];
  return (
    <div className="space-y-2 p-3" data-add-panel>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names, RIDs, API names or property names" className={inputClass} />
      {res.map((n) => (
        <div key={n.key} className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
          <span className="flex-1 truncate" title={n.id}>
            {n.name} <span className="text-muted">{n.match === "property" ? "· has the property" : `· ${idx.kinds[n.kind]}`}</span>
          </span>
          {onGraph.has(n.key) ? <span className="text-muted">on graph</span> : (
            <button type="button" onClick={() => onAdd([n.key])} className="text-ocean">
              Add
            </button>
          )}
        </div>
      ))}
      {res.length > 1 && (
        <button type="button" onClick={() => onAdd(res.map((r) => r.key))} className="text-ocean">
          Add all {res.length}
        </button>
      )}
      <div className="border-t border-line pt-2 font-medium text-soft">Browse by type</div>
      <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
        <option value="">Choose a resource type</option>
        {Object.entries(idx.kinds).map(([k, v]) => (
          <option key={k} value={k}>
            {v} ({idx.nodes.filter((n) => n.kind === k).length})
          </option>
        ))}
      </select>
      <div className="max-h-56 overflow-auto">
        {browse.map((n) => (
          <div key={n.key} className="flex items-center gap-1">
            <span className="flex-1 truncate">{n.name}</span>
            {!onGraph.has(n.key) && (
              <button type="button" onClick={() => onAdd([n.key])} className="text-ocean">
                Add
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-line pt-2 font-medium text-soft">Files</div>
      <div className="flex flex-wrap gap-1 text-muted">
        <button type="button" onClick={() => setFolder({ id: null, items: [], path: [] })} className="hover:text-white">
          All
        </button>
        {folder.path.map((p, i) => (
          <button key={p.id} type="button" onClick={() => setFolder({ id: p.id, items: [], path: folder.path.slice(0, i + 1) })} className="hover:text-white">
            / {p.name}
          </button>
        ))}
      </div>
      {folder.items.map((f) => (
        <div key={f.id} className="flex items-center gap-1">
          <button type="button" onClick={() => setFolder({ id: f.id, items: [], path: [...folder.path, { id: f.id, name: f.name }] })} className="flex flex-1 items-center gap-1 truncate text-left hover:text-white">
            <Icon name={f.kind === "project" ? "project" : "folder"} className="h-3.5 w-3.5 text-muted" /> {f.name}
          </button>
          <button type="button" onClick={async () => onAdd(await wl.folder(f.id))} className="text-ocean" title="Add every supported resource in it">
            Add all
          </button>
        </div>
      ))}
    </div>
  );
}

function DetailsPanel({ sel, byKey, onSelect, viewAs, users, onOpenBottom, onExpand, onHighlight, idx }: {
  sel: WNode[]; byKey: Record<string, WNode>; onSelect: (k: string[]) => void; viewAs: string; users: { id: string; name: string }[]; onOpenBottom: (b: Bottom) => void;
  onExpand: (k: string, d: "up" | "down") => void; onHighlight: (k: string[]) => void; idx: Index;
}) {
  const [d, setD] = useState<Details | null>(null);
  const [dbgUser, setDbgUser] = useState(viewAs);
  const [dbg, setDbg] = useState<Awaited<ReturnType<typeof wl.debug>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const key = sel.length === 1 ? sel[0].key : "";
  useEffect(() => {
    if (!key) return;
    let stale = false;
    wl.node(key).then((x) => !stale && (setD(x), setDbg(null)), () => {});
    return () => {
      stale = true;
    };
  }, [key]);
  if (!sel.length) return <p className="p-3 text-muted">Select nodes on the graph.</p>;
  if (sel.length > 1) {
    const hist: Record<string, string[]> = {};
    for (const n of sel) (hist[n.kind === "action_type" ? `Action · ${n.rule}` : idx.kinds[n.kind]] ??= []).push(n.key);
    const max = Math.max(...Object.values(hist).map((v) => v.length));
    return (
      <div className="space-y-2 p-3" data-selection>
        <div className="font-medium text-soft">{sel.length} selected</div>
        {Object.entries(hist).map(([k, v]) => (
          <button key={k} type="button" onClick={() => onSelect(v)} className="block w-full text-left" title="Filter the selection">
            <div className="flex justify-between">
              <span>{k}</span>
              <span className="text-muted">{v.length}</span>
            </div>
            <div className="h-1.5 rounded bg-ocean/60" style={{ width: `${(v.length / max) * 100}%` }} />
          </button>
        ))}
      </div>
    );
  }
  if (!d || d.node.key !== key) return <p className="p-3 text-muted">Loading…</p>;
  const n = d.node;
  return (
    <div className="space-y-3 p-3" data-details={n.kind}>
      <div>
        <div className="flex items-center gap-1.5 text-sm font-medium text-white">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
          {n.name}
        </div>
        <div className="font-mono text-[10px] text-muted">{n.id}{n.api_name ? ` · ${n.api_name}` : ""}</div>
        {d.href && (
          <Link href={d.href} target="_blank" className="text-ocean">
            Open in new tab
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onExpand(n.key, "up")} className="rounded border border-line p-1.5 text-left hover:border-ocean">
          <div className="text-muted">Upstream</div>
          <div className="text-sm">{d.upstream.length}</div>
        </button>
        <button type="button" onClick={() => onExpand(n.key, "down")} className="rounded border border-line p-1.5 text-left hover:border-ocean">
          <div className="text-muted">Downstream</div>
          <div className="text-sm">{d.downstream.length}</div>
        </button>
      </div>
      {d.properties && (
        <div>
          <div className="mb-1 font-medium text-soft">Properties · provenance</div>
          {d.properties.map((p) => (
            <div key={p.api_name}>
              <button type="button" onClick={() => (setOpen(open === p.api_name ? null : p.api_name), onHighlight(p.usages.map((u) => `${u.kind}:${u.id}`)))} className="flex w-full items-center gap-1 py-0.5 text-left hover:text-white" data-prop={p.api_name}>
                <span className="flex-1 truncate">{p.display_name || p.api_name}</span>
                <span className="text-muted">{p.type}</span>
                <span className={`w-6 text-right ${p.usages.length ? "text-ocean" : "text-muted"}`}>{p.usages.length}</span>
              </button>
              {open === p.api_name &&
                p.usages.map((u, i) => (
                  <div key={i} className="ml-2 truncate text-[11px] text-muted">
                    {u.kind.replace("_", " ")} · {u.name} · {u.how}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
      {d.links && d.links.length > 0 && (
        <div>
          <div className="mb-1 font-medium text-soft">Links</div>
          {d.links.map((l, i) => (
            <button key={i} type="button" onClick={() => onSelect([l.key])} className="block w-full truncate text-left hover:text-white">
              {l.name} → {l.other} <span className="text-muted">{l.cardinality}</span>
            </button>
          ))}
        </div>
      )}
      {d.backing_dataset && <div>Backing data source: {d.backing_dataset}</div>}
      {d.security && (
        <div className="text-muted">
          Security: {d.security.markings.length ? `markings ${d.security.markings.join(", ")}` : "no markings"} · {d.security.policies} property polic{d.security.policies === 1 ? "y" : "ies"}
        </div>
      )}
      {d.preview && d.preview.length > 0 && (
        <div className="overflow-auto">
          <div className="mb-1 font-medium text-soft">Data preview</div>
          <table className="text-[10px]">
            <tbody>
              {d.preview.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  {Object.values(r).slice(0, 4).map((v, j) => (
                    <td key={j} className="max-w-24 truncate pr-2">
                      {v === null || v === undefined ? "—" : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.action && (
        <div className="space-y-2">
          <div>
            <div className="font-medium text-soft">Inputs</div>
            {d.action.parameters.map((p) => (
              <div key={p.id} className="flex gap-1">
                <span className="flex-1 truncate">{p.display_name}</span>
                <span className="text-muted">{p.type}{p.property ? ` → ${p.property}` : ""}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="font-medium text-soft">Nexus edits</div>
            <div className="text-muted">{(d.action.rules ?? []).map((r) => r.kind).join(", ") || d.action.kind}</div>
          </div>
          <div>
            <div className="font-medium text-soft">Submission criteria ({(d.action.submission_criteria ?? []).length})</div>
            {(d.action.submission_criteria as { failure_message?: string }[] | undefined)?.map((c, i) => (
              <div key={i} className="text-muted">
                • {c.failure_message || "criterion"}
              </div>
            ))}
            {(d.action.submission_criteria ?? []).length > 0 && (
              <button type="button" onClick={() => onHighlight(idx.nodes.filter((x) => x.kind === "action_type" && x.criteria === (d.action!.submission_criteria ?? []).length).map((x) => x.key))} className="text-ocean">
                Highlight matching actions
              </button>
            )}
            <button type="button" onClick={() => onOpenBottom("criteria")} className="ml-2 text-ocean">
              Update submission criteria
            </button>
          </div>
          <div className="rounded border border-line p-2" data-debug>
            <div className="font-medium text-soft">Debug permissions · check action submission</div>
            <div className="mt-1 flex gap-1">
              <select value={dbgUser} onChange={(e) => setDbgUser(e.target.value)} className={`${fieldClass} flex-1 text-xs`}>
                <option value="">Choose a user</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!dbgUser} onClick={async () => setDbg(await wl.debug(n.id, dbgUser))} className={buttonClass.secondary}>
                Check
              </button>
            </div>
            {dbg && (
              <div className="mt-1">
                <div className={dbg.can_submit ? "text-ok" : "text-bad"}>{dbg.user} {dbg.can_submit ? "can submit" : "cannot submit"} this action</div>
                {dbg.checks.map((c) => (
                  <div key={c.name}>
                    {c.ok ? "✓" : "✗"} {c.name} {c.detail && <span className="text-muted">— {c.detail}</span>}
                  </div>
                ))}
                {dbg.criteria.map((c, i) => (
                  <div key={i}>
                    {c.ok === null ? "?" : c.ok ? "✓" : "✗"} {c.message || "criterion"} <span className="text-muted">— {c.result}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {(d.function_code || d.code) && (
        <div>
          <div className="font-medium text-soft">Code {(d.function_code || d.code)?.file && <span className="text-muted">· {(d.function_code || d.code)!.file}</span>}</div>
          <pre className="max-h-56 overflow-auto rounded bg-ink p-2 font-mono text-[10px]">{(d.function_code || d.code)?.code ?? "(the source is not available)"}</pre>
        </div>
      )}
      {d.metrics && <div className="text-muted">30 days: {d.metrics.succeeded} succeeded · {d.metrics.failed} failed · p95 {d.metrics.p95_ms ?? "—"} ms</div>}
      {d.usages && d.usages.length > 0 && (
        <div>
          <div className="font-medium text-soft">Used in</div>
          {d.usages.map((u, i) => (
            <div key={i} className="text-muted">
              {u.kind} · {u.name} {u.version && `· v${u.version}`}
            </div>
          ))}
        </div>
      )}
      {d.logic && (
        <div>
          <div className="font-medium text-soft">Blocks</div>
          {d.logic.blocks.map((b, i) => (
            <div key={i} className="text-muted">
              {b.name} · {b.type} {b.model && `· ${b.model}`}
            </div>
          ))}
        </div>
      )}
      {d.automation && (
        <div>
          <div className="font-medium text-soft">Condition</div>
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-muted">{JSON.stringify(d.automation.condition, null, 1)}</pre>
          {d.condition_properties && d.condition_properties.length > 0 && <div>Condition ontology dependencies: {d.condition_properties.join(", ")}</div>}
          <div className="font-medium text-soft">Effect</div>
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-muted">{JSON.stringify(d.automation.effect, null, 1)}</pre>
        </div>
      )}
      {d.usage && <div>Last 28 days: {d.usage.attempted} attempts · {d.usage.succeeded} succeeded · {d.usage.rate_limited} rate-limited · {(d.usage.tokens ?? 0).toLocaleString()} tokens</div>}
      {d.interface && (
        <div>
          <div className="font-medium text-soft">Implemented by</div>
          {d.interface.implemented_by.map((x) => (
            <button key={x.object_type_id} type="button" onClick={() => onSelect([`object_type:${x.object_type_id}`])} className="block text-left hover:text-white">
              {x.display_name}
            </button>
          ))}
        </div>
      )}
      {d.recent_runs && d.recent_runs.length > 0 && (
        <div>
          <div className="font-medium text-soft">Run history</div>
          {d.recent_runs.slice(0, 10).map((r, i) => (
            <div key={i} className="flex gap-1">
              <span className={r.status === "failed" ? "text-bad" : "text-ok"}>{r.status}</span>
              <span className="text-muted">{when(r.at)}</span>
              {r.error && <span className="truncate text-bad">{r.error}</span>}
            </div>
          ))}
        </div>
      )}
      <div>
        <div className="font-medium text-soft">Dependencies</div>
        {[...d.upstream.map((x) => ({ ...x, dir: "←" })), ...d.downstream.map((x) => ({ ...x, dir: "→" }))].slice(0, 60).map((x, i) => (
          <button key={i} type="button" onClick={() => onSelect([x.key])} className="block w-full truncate text-left text-muted hover:text-white">
            {x.dir} {x.name ?? byKey[x.key]?.name} <span className="text-[10px]">({x.kind})</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkshopPanel({ workshops, sel, onSelect, byKey, onClose }: { workshops: WNode[]; sel: string[]; onSelect: (k: string[]) => void; byKey: Record<string, WNode>; onClose: () => void }) {
  const pick = workshops.find((w) => sel.includes(w.key)) ?? workshops[0];
  const [cur, setCur] = useState(pick.key);
  const [d, setD] = useState<Details | null>(null);
  const [ent, setEnt] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    wl.node(cur).then((x) => !stale && setD(x), () => {});
    return () => {
      stale = true;
    };
  }, [cur]);
  const rows = Math.max(8, ...(d?.widgets ?? []).map((w) => (w.y ?? 0) + (w.h ?? 1)));
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel text-xs" data-workshop-panel>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <select value={cur} onChange={(e) => setCur(e.target.value)} className={`${fieldClass} flex-1 text-xs`}>
          {workshops.map((w) => (
            <option key={w.key} value={w.key}>
              {w.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="relative rounded border border-line bg-ink" style={{ height: rows * 22 }}>
          {d?.widgets?.map((w) => {
            const lit = w.uses.some((u) => sel.includes(u)) || (ent && w.uses.includes(ent));
            return (
              <button key={w.id} type="button" onClick={() => onSelect(w.uses.filter((u) => byKey[u]))} title={`${w.type}: uses ${w.uses.map((u) => byKey[u]?.name ?? u).join(", ")}`}
                style={{ left: `${((w.x ?? 0) / 12) * 100}%`, top: (w.y ?? 0) * 22, width: `${((w.w ?? 4) / 12) * 100}%`, height: (w.h ?? 1) * 22 }}
                className={`absolute overflow-hidden rounded border p-1 text-left text-[10px] ${lit ? "border-warn bg-warn/15" : "border-line-2 bg-panel-2"}`} data-widget={w.id}>
                <div className="truncate font-medium">{w.title || w.type}</div>
                <div className="truncate text-muted">{w.type}</div>
              </button>
            );
          })}
        </div>
        <div className="mt-3 font-medium text-soft">Entities</div>
        {d?.entities?.map((e) => (
          <button key={e.key} type="button" onClick={() => (setEnt(ent === e.key ? null : e.key), onSelect([e.key]))} className={`block w-full rounded px-1 py-0.5 text-left ${ent === e.key ? "bg-ocean/15 text-white" : "hover:text-white"}`}>
            {e.name} <span className="text-muted">· {e.widgets.length} widget{e.widgets.length === 1 ? "" : "s"}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function BottomPanel({ which, sel, graphKeys, byKey, idx, onDone, onClose, onSelect }: {
  which: Exclude<Bottom, null>; sel: WNode[]; graphKeys: string[]; byKey: Record<string, WNode>; idx: Index; onDone: (m: string) => void; onClose: () => void; onSelect: (k: string[]) => void;
}) {
  const acts = sel.filter((n) => n.kind === "action_type");
  const [source, setSource] = useState("");
  const [ups, setUps] = useState<Awaited<ReturnType<typeof wl.upgrades>> | null>(null);
  const [mode, setMode] = useState<"partial" | "all_or_nothing">("partial");
  const [target, setTarget] = useState("");
  const [skip, setSkip] = useState<string[]>([]);
  const [weekly, setWeekly] = useState<Awaited<ReturnType<typeof wl.weekly>> | null>(null);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof wl.modelUsage>> | null>(null);
  const [moving, setMoving] = useState<Awaited<ReturnType<typeof wl.move>> | null>(null);
  const [publishing, setPublishing] = useState<Awaited<ReturnType<typeof wl.publishWorkshop>> | null>(null);
  const [dest, setDest] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const model = sel.find((n) => n.kind === "language_model");
  const consumers = model ? idx.edges.filter((e) => e.from === model.key && e.to.startsWith("logic:") && graphKeys.includes(e.to)).map((e) => byKey[e.to]) : [];
  const selKeys = sel.map((n) => n.key).join(",");
  const wsKeys = sel.filter((n) => n.kind === "workshop").map((n) => n.id).join(",");
  useEffect(() => {
    let stale = false;
    if (which === "upgrades") wl.upgrades(selKeys ? selKeys.split(",") : graphKeys).then((u) => !stale && setUps(u), () => {});
    if (which === "weekly" && wsKeys) wl.weekly(wsKeys.split(",")).then((w) => !stale && setWeekly(w), () => {});
    if (which === "model_usage") wl.modelUsage().then((u) => !stale && setUsage(u), () => {});
    if (which === "move" && selKeys) wl.move(selKeys.split(",")).then((m) => !stale && setMoving(m), () => {});
    if (which === "publish" && wsKeys) wl.publishWorkshop(wsKeys.split(",")).then((p) => !stale && setPublishing(p), () => {});
    if (which === "move") api.drive.folder(null).then((f) => !stale && setProjects(f.items.filter((i) => i.kind === "project")), () => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which, selKeys, wsKeys]);
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    try {
      const m = await f();
      setOut(m);
      onDone(m);
    } catch (e) {
      setOut((e as Error).message);
    }
    setBusy(false);
  };
  const title = { criteria: "Update submission criteria", upgrades: "Function upgrades", model: "Replace model", weekly: "Weekly views", model_usage: "Model usage", move: "Move resources", publish: "Publish Workshop modules" }[which];
  return (
    <div className="h-64 shrink-0 overflow-auto border-t border-line bg-panel p-3 text-xs" data-bottom-panel={which}>
      <div className="mb-2 flex items-center">
        <span className="font-medium text-soft">{title}</span>
        {out && <span className="ml-3 text-muted">{out}</span>}
        <button type="button" onClick={onClose} className="ml-auto text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      {which === "criteria" &&
        (acts.length < 2 ? (
          <p className="text-muted">Select the source action and the actions to update on the graph (at least two actions).</p>
        ) : (
          <div className="flex gap-4">
            <div className="w-64">
              <div className="text-muted">Source action</div>
              {acts.map((a) => (
                <label key={a.key} className="flex items-center gap-1">
                  <input type="radio" name="src" checked={source === a.id} onChange={() => setSource(a.id)} /> {a.name} <span className="text-muted">({a.criteria as number} criteria)</span>
                </label>
              ))}
            </div>
            <div className="flex-1">
              <div className="text-muted">Will be updated</div>
              {acts.filter((a) => a.id !== source).map((a) => (
                <div key={a.key}>{a.name}</div>
              ))}
              <button type="button" disabled={!source || busy} onClick={() => run(async () => { const r = await wl.copyCriteria(source, acts.filter((a) => a.id !== source).map((a) => a.id)); return `Updated ${r.updated.length} actions directly on main${r.failed.length ? `; ${r.failed.length} failed` : ""}`; })} className={`${buttonClass.primary} mt-2`}>
                Update {acts.filter((a) => a.id !== source).length} actions
              </button>
              <p className="mt-1 text-muted">Applies directly on main (no branch or proposal).</p>
            </div>
          </div>
        ))}
      {which === "upgrades" && (
        <div>
          {!ups && <p className="text-muted">Checking…</p>}
          {ups && !ups.length && <p className="text-muted">Every function reference among {sel.length ? "the selected nodes" : "the graph's nodes"} is on its latest version.</p>}
          {ups && ups.length > 0 && (
            <>
              <table className="w-full">
                <tbody>
                  {ups.map((u, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1">{byKey[u.resource]?.name}</td>
                      <td>{byKey[u.function]?.name}</td>
                      <td className="font-mono">{u.from} → {u.to}</td>
                      <td className={u.status === "upgradable" ? "text-ok" : u.status === "breaking" ? "text-warn" : "text-bad"}>{u.status}{u.breaking.length ? `: ${u.breaking.join("; ")}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex items-center gap-2">
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={`${fieldClass} text-xs`}>
                  <option value="partial">Partial: skip breaking changes</option>
                  <option value="all_or_nothing">All or nothing</option>
                </select>
                <button type="button" disabled={busy} onClick={() => run(async () => { const r = await wl.applyUpgrades(ups, mode); return r.reason ?? `Upgraded ${r.upgraded.length}, skipped ${r.skipped.length}`; })} className={buttonClass.primary}>
                  Upgrade
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {which === "model" &&
        (!model ? (
          <p className="text-muted">Select a language model node; its AIP Logic consumers on the graph appear here.</p>
        ) : (
          <div className="flex gap-4">
            <div className="w-64">
              <div className="text-muted">Source model</div>
              <div className="text-sm">{model.name}</div>
              <div className="mt-2 text-muted">Replace with</div>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputClass}>
                <option value="">Choose a model</option>
                {idx.nodes.filter((n) => n.kind === "language_model" && n.key !== model.key && !n.registered).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <div className="text-muted">Used in ({consumers.length} on the graph)</div>
              {consumers.map((c) => (
                <label key={c.key} className="flex items-center gap-1">
                  <input type="checkbox" checked={!skip.includes(c.id)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== c.id) : [...skip, c.id])} /> {c.name}
                </label>
              ))}
              {!consumers.length && (
                <button type="button" onClick={() => onSelect(idx.edges.filter((e) => e.from === model.key).map((e) => e.to))} className="text-ocean">
                  Add its AIP Logic consumers to the graph first
                </button>
              )}
              <button type="button" disabled={!target || busy || !consumers.length || !!model.registered}
                onClick={() => run(async () => { const r = await wl.replaceModel(model.id, target, consumers.filter((c) => !skip.includes(c.id)).map((c) => c.id)); return `Replaced in ${r.replaced.length} Logic function${r.replaced.length === 1 ? "" : "s"}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`; })}
                className={`${buttonClass.primary} mt-2`}>
                Replace model
              </button>
              {!!model.registered && <p className="text-warn">Registered models cannot be replaced in bulk.</p>}
            </div>
          </div>
        ))}
      {which === "publish" &&
        (!wsKeys ? (
          <p className="text-muted">Select Workshop nodes: their latest versions are published together.</p>
        ) : (
          <div className="flex gap-6" data-bulk-publish>
            <div className="flex-1">
              <div className="text-muted">Modules to publish</div>
              {publishing?.publish?.map((m) => (
                <div key={m.id}>
                  {m.name}: <span className="text-muted">{m.from ? `v${m.from}` : "unpublished"} → v{m.to}</span>
                </div>
              ))}
              {publishing && !publishing.publish?.length && <div className="text-muted">None.</div>}
              <div className="mt-2 text-muted">Skipped</div>
              {publishing?.skipped.map((s) => (
                <div key={s.id}>
                  {s.name ?? s.id}: <span className="text-muted">{s.reason}</span>
                </div>
              ))}
            </div>
            <div className="w-64">
              <button type="button" disabled={busy || !publishing?.publish?.length} onClick={() => run(async () => { const r = await wl.publishWorkshop(wsKeys.split(","), false); setPublishing({ publish: [], skipped: r.skipped }); return `Published ${r.published?.length ?? 0} module${r.published?.length === 1 ? "" : "s"}`; })} className={buttonClass.primary} data-publish-run>
                Publish {publishing?.publish?.length ?? 0}
              </button>
            </div>
          </div>
        ))}
      {which === "weekly" &&
        (!wsKeys ? (
          <p className="text-muted">Select Workshop nodes.</p>
        ) : (
          <div className="flex gap-6">
            {Object.entries(weekly ?? {}).map(([m, wk]) => {
              const max = Math.max(1, ...wk.map((w) => w.total));
              return (
                <div key={m}>
                  <div className="mb-1 text-soft">{byKey[`workshop:${m}`]?.name}</div>
                  <div className="flex h-28 items-end gap-2">
                    {wk.map((w) => (
                      <div key={w.week_start} className="flex flex-col items-center" title={`${w.total} views · ${w.unique} users`}>
                        <span className="text-[10px] text-muted">{w.total}</span>
                        <div className="flex items-end gap-0.5">
                          <div className="w-3 rounded-t bg-ocean" style={{ height: (w.total / max) * 80 + 2 }} />
                          <div className="w-3 rounded-t bg-ocean/40" style={{ height: (w.unique / max) * 80 + 2 }} />
                        </div>
                        <span className="text-[10px] text-muted">{w.week_start.slice(5)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <p className="text-muted">Dark: total views · light: unique users, per week (4 weeks).</p>
          </div>
        ))}
      {which === "model_usage" && (
        <div>
          {usage && !Object.keys(usage).length && <p className="text-muted">No model requests recorded yet (recording started with this version).</p>}
          <table className="w-full">
            <tbody>
              {Object.entries(usage ?? {}).map(([m, u]) => (
                <tr key={m} className="border-t border-line">
                  <td className="py-1">{byKey[`language_model:${m}`]?.name ?? m}</td>
                  <td>{u.attempted} attempted</td>
                  <td>{u.succeeded} succeeded</td>
                  <td>{u.rate_limited} rate-limited</td>
                  <td>{(u.tokens ?? 0).toLocaleString()} tokens</td>
                  <td>
                    <div className="flex h-6 items-end gap-px">
                      {u.by_day.map((d) => (
                        <div key={d.day} title={`${d.day}: ${d.attempted} requests, ${d.tokens} tokens`} className="w-1.5 bg-warn" style={{ height: 2 + (d.attempted / Math.max(1, ...u.by_day.map((x) => x.attempted))) * 22 }} />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-muted">Per model, across the platform (requests are not yet attributed to the Workshop module or automation that made them).</p>
        </div>
      )}
      {which === "move" &&
        (!sel.length ? (
          <p className="text-muted">Select the resources to move.</p>
        ) : (
          <div className="flex gap-4">
            <div className="flex-1">
              <div className="text-muted">Resources to move</div>
              {moving?.move?.map((m) => (
                <div key={m.key}>{m.name}</div>
              ))}
              <div className="mt-2 text-muted">Skipped</div>
              {moving?.skipped.map((s) => (
                <div key={s.key}>
                  {s.name ?? byKey[s.key]?.name}: <span className="text-muted">{s.reason}</span>
                </div>
              ))}
            </div>
            <div className="w-64">
              <div className="text-muted">Destination Project</div>
              <select value={dest} onChange={(e) => setDest(e.target.value)} className={inputClass}>
                <option value="">Choose</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!dest || busy || !moving?.move?.length} onClick={() => run(async () => { const r = await wl.move(sel.map((n) => n.key), dest, false); return `Moved ${r.moved?.length ?? 0}`; })} className={`${buttonClass.primary} mt-2`}>
                Move {moving?.move?.length ?? 0}
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

function SaveDialog({ state, onClose, onSaved }: { state: GraphState; onClose: () => void; onSaved: (g: SavedGraph) => void }) {
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Save stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="Save graph" icon="save" onClose={onClose}>
      <form className="space-y-3 p-5 text-sm" onSubmit={async (e) => (e.preventDefault(), setTried(true), missing.length ? undefined : wl.createGraph(name.trim(), folder, state).then(onSaved, (x: Error) => setErr(x.message)))}>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Project <span className="text-bad" aria-hidden>*</span></span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={projectInvalid} className={`${inputClass} mt-1 ${projectInvalid ? "border-bad ring-1 ring-bad/40" : ""}`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projectInvalid && <span className="mt-1 block text-[11px] text-bad">{projects.length ? "Choose the Project it is saved in." : "No Project to save it in: create or join one first."}</span>}
        </label>
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To save: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
