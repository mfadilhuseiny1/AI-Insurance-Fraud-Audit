"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { bounds, Canvas, exportPng, MiniMap, type Sel, type View } from "@/components/solutionDesigner/Canvas";
import {
  ArchitectPanel,
  ComponentPicker,
  ConflictDialog,
  CriticPanel,
  eid,
  InfoPanel,
  LineageDialog,
  NodePanel,
  nid,
  ReferencesPanel,
  ResourcePicker,
  SettingsPanel,
  shift,
  VersionsDialog,
  WizardDialog,
} from "@/components/solutionDesigner/Panels";
import { when } from "@/lib/format";
import { autoLayout, sd, type Catalog, type Diagram, type Graph, type ResourceRef, type SDEdge, type SDNode } from "@/lib/solutionDesigner";

/** The link type a connection proposes: its `proposed` field, else a "name (cardinality)" label of an older data model. */
function proposedLink(e: SDEdge): SDEdge["proposed"] {
  if (e.proposed) return e.proposed;
  const m = /^(.*?)\s*\((one-to-many|many-to-many|one-to-one)\)\s*$/.exec(e.label ?? "");
  return m ? { name: m[1].trim(), cardinality: m[2] as "one-to-many" } : null;
}

type Tab = "info" | "architect" | "critic" | "references" | "settings";
const TABS: [Tab, IconName, string][] = [
  ["info", "info", "Diagram information"],
  ["architect", "sparkle", "AIP Architect"],
  ["critic", "comment", "AIP Critic"],
  ["references", "layers", "Reference diagrams"],
  ["settings", "sliders", "Graph settings"],
];

export default function Page() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading…</p>}>
      <DiagramPage />
    </Suspense>
  );
}

function DiagramPage() {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  const router = useRouter();
  const viewer = q.get("viewer") === "true";
  const [d, setD] = useState<Diagram | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [past, setPast] = useState<Graph[]>([]);
  const [future, setFuture] = useState<Graph[]>([]);
  const [dirty, setDirty] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [conflict, setConflict] = useState<string | null>(null);
  // "Conflict on save": the version on the server when the save was refused, and whether its dialog is open
  const [conflictServer, setConflictServer] = useState<Diagram | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [models, setModels] = useState<{ id: string; label: string; default?: boolean }[]>([]);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [sel, setSel] = useState<Sel>({ nodes: [], edge: null });
  const [tab, setTab] = useState<Tab | null>(q.get("wizard") ? "architect" : "info");
  const [side, setSide] = useState(300);
  const [dialog, setDialog] = useState<null | "components" | "versions" | "wizard" | "lineage" | { resource: ResourceRef["kind"]; link?: string }>(q.get("wizard") ? "wizard" : null);
  const [menu, setMenu] = useState<null | { x: number; y: number; node?: string; edge?: string; wx: number; wy: number; kind?: "actions" | "resource" | "concept" | "node" }>(null);
  const [label, setLabel] = useState<{ id: string; x: number; y: number; text: string } | null>(null);
  const [preview, setPreview] = useState<{ nodes: SDNode[]; edges: SDEdge[] } | null>(null);
  const [previewing, setPreviewing] = useState<Diagram | null>(null);
  const [resolved, setResolved] = useState<Record<string, { ok: boolean; name?: string; href?: string; reason?: string }>>({});
  const [locked, setLocked] = useState(viewer);
  const [ask, setAsk] = useState<{ q: string; n: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 1000, h: 700 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [clip, setClip] = useState<{ nodes: SDNode[]; edges: SDEdge[] } | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    sd.get(id).then(
      (x) => {
        setD(x);
        setGraph(x.graph);
      },
      (e: Error) => setErr(e.message),
    );
    sd.catalog().then(setCatalog, () => {});
    sd.models().then(setModels, () => {});
  }, [id]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [d]);
  const shown = previewing?.graph ?? graph;
  const readOnly = viewer || !d?.can_edit || !!previewing;
  const comps = useMemo(() => Object.fromEntries((catalog?.components ?? []).map((c) => [c.id, c])), [catalog]);
  const concepts = useMemo(() => Object.fromEntries((catalog?.concepts ?? []).map((c) => [c.id, c])), [catalog]);

  // linked resources: current names, links, or why they cannot be opened
  const resKey = (shown?.nodes ?? []).filter((n) => n.resource).map((n) => `${n.resource!.kind}:${n.resource!.id}`).sort().join(",");
  useEffect(() => {
    if (!resKey) return;
    let stale = false;
    sd.resolve(resKey.split(",").map((k) => ({ kind: k.split(":")[0], id: k.slice(k.indexOf(":") + 1) }))).then((r) => !stale && setResolved(r), () => {});
    return () => {
      stale = true;
    };
  }, [resKey]);

  const fit = useCallback(
    (nodes?: SDNode[]) => {
      const list = nodes ?? shown?.nodes ?? [];
      const b = bounds(list);
      const k = Math.min(1.4, Math.max(0.2, Math.min((box.w - 80) / (b.w || 1), (box.h - 80) / (b.h || 1))));
      setView({ k, x: (box.w - b.w * k) / 2 - b.x * k, y: (box.h - b.h * k) / 2 - b.y * k });
    },
    [shown, box],
  );
  // first open: fit, or center the node of ?focus=<resource id>
  useEffect(() => {
    if (focused.current || !graph || box.w < 100) return;
    focused.current = true;
    const f = q.get("focus") ?? q.get("focusRID");
    const hit = f ? graph.nodes.find((n) => n.resource?.id === f || n.id === f) : null;
    const t = setTimeout(() => {
      if (hit) {
        setSel({ nodes: [hit.id], edge: null });
        fit([hit]);
      } else fit(graph.nodes);
    }, 0);
    return () => clearTimeout(t);
  }, [graph, box, q, fit]);

  const change = useCallback((g: Graph, record = true, prev?: Graph) => {
    setGraph((cur) => {
      if (record && cur) {
        setPast((p) => [...p.slice(-99), prev ?? cur]);
        setFuture([]);
      }
      return g;
    });
    setDirty((n) => n + 1);
  }, []);
  const onConflict = (message: string) => {
    setConflict(message);
    setConflictOpen(true);
    setConflictServer(null);
    sd.get(id).then(setConflictServer, (e: Error) => setStatus(`Could not read the server version: ${e.message}`));
  };
  const endConflict = () => {
    setConflict(null);
    setConflictOpen(false);
    setConflictServer(null);
  };
  // autosave two seconds after the last change
  useEffect(() => {
    if (!dirty || !d || !graph || readOnly || conflict) return;
    const t = setTimeout(() => {
      setStatus("Saving…");
      sd.save(id, { graph, base_version: d.version }).then(
        (x) => {
          setD((cur) => (cur ? { ...x, graph: cur.graph } : x));
          setStatus(`Saved ${when(x.updated_at)}`);
        },
        (e: Error & { status?: number }) => (e.status === 409 ? onConflict(e.message) : setStatus(`Not saved: ${e.message}`)),
      );
    }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  const saveNow = async (description = "") => {
    if (!d || !graph) return;
    try {
      const x = await sd.save(id, { graph, base_version: d.version, manual: true, description });
      setD(x);
      setStatus("Up to date with manually saved version");
    } catch (e) {
      const ex = e as Error & { status?: number };
      if (ex.status === 409) onConflict(ex.message);
      else setErr(ex.message);
    }
  };
  const undo = () => {
    if (!past.length || !graph) return;
    setFuture((f) => [graph, ...f]);
    setGraph(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setDirty((n) => n + 1);
  };
  const redo = () => {
    if (!future.length || !graph) return;
    setPast((p) => [...p, graph]);
    setGraph(future[0]);
    setFuture((f) => f.slice(1));
    setDirty((n) => n + 1);
  };
  const center = () => ({ x: (box.w / 2 - view.x) / view.k - 110, y: (box.h / 2 - view.y) / view.k - 37 });
  const add = (n: Omit<SDNode, "id" | "x" | "y"> & Partial<Pick<SDNode, "x" | "y">>) => {
    if (!graph) return;
    const c = center();
    const node = { id: nid(), x: Math.round(n.x ?? c.x), y: Math.round(n.y ?? c.y), tags: [], ...n } as SDNode;
    change({ ...graph, nodes: [...graph.nodes, node] });
    setSel({ nodes: [node.id], edge: null });
  };
  const addMany = (nodes: SDNode[], edges: SDEdge[], at?: { x: number; y: number }) => {
    if (!graph) return;
    const b = bounds(nodes);
    const c = at ?? (graph.nodes.length ? { x: bounds(graph.nodes).x, y: bounds(graph.nodes).y + bounds(graph.nodes).h + 120 } : { x: 80, y: 80 });
    const s = shift(nodes, edges, Math.round(c.x - b.x), Math.round(c.y - b.y));
    change({ ...graph, nodes: [...graph.nodes, ...s.nodes], edges: [...graph.edges, ...s.edges] });
    setSel({ nodes: s.nodes.map((n) => n.id), edge: null });
    setTimeout(() => fit([...graph.nodes, ...s.nodes]), 0);
  };
  const remove = () => {
    if (!graph || readOnly) return;
    if (sel.edge) change({ ...graph, edges: graph.edges.filter((e) => e.id !== sel.edge) });
    else if (sel.nodes.length) {
      const gone = new Set(sel.nodes);
      change({
        ...graph,
        nodes: graph.nodes.filter((n) => !gone.has(n.id)).map((n) => (n.parent && gone.has(n.parent) ? { ...n, parent: null } : n)),
        edges: graph.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
      });
    }
    setSel({ nodes: [], edge: null });
  };
  const group = () => {
    if (!graph || readOnly) return;
    const ns = graph.nodes.filter((n) => sel.nodes.includes(n.id));
    const b = ns.length ? bounds(ns) : { ...center(), w: 340, h: 200 };
    const g: SDNode = { id: nid(), kind: "group", title: "Group", x: b.x - 24, y: b.y - 44, w: b.w + 48, h: b.h + 68, tags: [] };
    change({ ...graph, nodes: [g, ...graph.nodes.map((n) => (sel.nodes.includes(n.id) ? { ...n, parent: g.id } : n))] });
    setSel({ nodes: [g.id], edge: null });
  };
  const copy = () => {
    if (!graph || !sel.nodes.length) return;
    const ids = new Set(sel.nodes);
    const c = { nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
    setClip(c);
    void navigator.clipboard?.writeText(JSON.stringify({ format: "bluesandai.solution-diagram.nodes", ...c })).catch(() => {});
    return c;
  };
  const paste = async () => {
    if (!graph || readOnly) return;
    let data = clip;
    try {
      const t = await navigator.clipboard.readText();
      const j = JSON.parse(t);
      if (j?.format?.startsWith("bluesandai.solution-diagram")) data = j.graph ?? j;
    } catch {}
    if (!data?.nodes?.length) return;
    const s = shift(data.nodes, data.edges, 40, 40);
    change({ ...graph, nodes: [...graph.nodes, ...s.nodes], edges: [...graph.edges, ...s.edges] });
    setSel({ nodes: s.nodes.map((n) => n.id), edge: null });
  };
  // keyboard shortcuts
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const act: [boolean, () => void][] = [
        [mod && k === "b" && !readOnly, () => setDialog("components")],
        [mod && k === "c", copy],
        [mod && k === "v", () => void paste()],
        [mod && (k === "y" || (k === "z" && e.shiftKey)), redo],
        [mod && k === "z", undo],
        [mod && k === "s", () => void saveNow()],
        [(e.key === "Delete" || e.key === "Backspace") && !readOnly, remove],
      ];
      const hit = act.find(([c]) => c);
      if (hit) {
        e.preventDefault();
        hit[1]();
      } else if (e.key === "Escape") {
        setSel({ nodes: [], edge: null });
        setMenu(null);
        setPreview(null);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (err) return <p className="p-8 text-sm text-bad">{err}</p>;
  if (!d || !graph || !shown || !catalog) return <p className="p-8 text-sm text-muted">Loading…</p>;
  const one = sel.nodes.length === 1 ? shown.nodes.find((n) => n.id === sel.nodes[0]) : undefined;
  const setNode = (n: SDNode) => change({ ...graph, nodes: graph.nodes.map((x) => (x.id === n.id ? n : x)) });
  const focusNodes = (ids: string[]) => {
    const ns = shown.nodes.filter((n) => ids.includes(n.id));
    if (!ns.length) return;
    setSel({ nodes: ns.map((n) => n.id), edge: null });
    fit(ns);
  };
  const linkTo = (target: SDNode | undefined, kind: ResourceRef["kind"]) => setDialog({ resource: kind, link: target?.id });
  const resKind = (n: SDNode): ResourceRef["kind"] =>
    n.resource?.kind ?? (n.component === "object-type" ? "object_type" : n.component === "action-type" ? "action_type" : n.component === "interface" ? "interface" : "file");
  const s = shown.settings;
  const toggle = (k: keyof Graph["settings"]) => change({ ...graph, settings: { ...graph.settings, [k]: !graph.settings[k] } }, false);
  const screen = (n: SDNode) => ({ x: n.x * view.k + view.x, y: n.y * view.k + view.y });
  const onePos = one ? screen(one) : null;
  const ctl = (icon: IconName, title: string, f: () => void, on?: boolean) => (
    <button key={title} type="button" title={title} aria-label={title} onClick={f} className={`rounded p-1.5 hover:bg-panel-2 ${on ? "text-ocean" : "text-muted hover:text-white"}`}>
      <Icon name={icon} className="h-4 w-4" />
    </button>
  );
  const tool = (icon: IconName, text: string, f: (e: React.MouseEvent) => void, show = true) =>
    show && (
      <button key={text} type="button" onClick={f} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-soft hover:bg-panel-2 hover:text-white" data-tool={text}>
        <Icon name={icon} className="h-3.5 w-3.5" /> {text}
      </button>
    );
  const download = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  // Data Lineage opened on the diagram's linked resources: the tab is opened straight away (a popup blocker allows it
  // only within the click) and sent to the graph of those nodes once their lineage ids are known
  const openLineage = async () => {
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const r = await sd.lineageFocus(
        graph.nodes.filter((n) => n.resource).map((n) => ({ kind: n.resource!.kind, id: n.resource!.id, name: n.resource!.name })),
        graph.nodes.flatMap((n) => (n.lineage_id ? [n.lineage_id] : [])),
      );
      const url = r.ids.length ? `/lineage?nodes=${r.ids.map(encodeURIComponent).join(",")}` : "/lineage";
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener");
      setStatus(
        !r.ids.length
          ? "None of the linked resources is in Data Lineage"
          : r.missing.length
            ? `Opened ${r.ids.length} nodes in Data Lineage; not in the graph: ${r.missing.map((m) => m.name || m.id).join(", ")}`
            : `Opened ${r.ids.length} nodes in Data Lineage`,
      );
    } catch (e) {
      tab?.close();
      setStatus(`Could not open Data Lineage: ${(e as Error).message}`);
    }
  };
  // a proposed (AIP Architect) link type between two object type nodes becomes an Ontology link type
  const createLink = async (edgeId: string, kind: "auto" | "join_table") => {
    try {
      // save what is on screen first, then create from that version
      const saved = await sd.save(id, { graph, base_version: d.version });
      setD(saved);
      const r = await sd.createLinkType(id, edgeId, saved.version, kind);
      setD(r.diagram);
      setGraph(r.diagram.graph);
      setStatus(`Created the link type ${r.link_type.display_name}${r.link_type.foreign_key ? ` (foreign key ${r.link_type.foreign_key})` : r.link_type.kind === "join_table" ? " (join table)" : ""}`);
    } catch (e) {
      const ex = e as Error & { status?: number };
      if (ex.status === 409 && !ex.message.includes("already created")) onConflict(ex.message);
      else setStatus(`Link type not created: ${ex.message}`);
    }
  };
  const exportJson = (only?: string[]) => {
    const ids = only?.length ? new Set(only) : null;
    const g = ids ? { ...graph, nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) } : graph;
    download(new Blob([JSON.stringify({ format: "bluesandai.solution-diagram", version: 1, name: d.name, graph: g }, null, 1)], { type: "application/json" }), `${d.name}.json`);
  };

  return (
    <div className="flex h-full flex-col" data-solution-designer>
      <AppHeader app="Solution Designer" icon="pencil" href="/solution-designer" crumbs={[{ label: d.name }]}>
        {!readOnly && (
          <input defaultValue={d.name} onBlur={async (e) => e.target.value.trim() && e.target.value.trim() !== d.name && setD(await sd.save(id, { graph, base_version: d.version, name: e.target.value.trim(), description: "Renamed" }))}
            className={`${inputClass} w-56 text-xs`} aria-label="Diagram name" />
        )}
        <button type="button" onClick={() => setDialog("versions")} className="font-mono text-xs text-muted hover:text-white" title="Versions">
          v{d.version}
        </button>
        <span className="text-[11px] text-muted" data-save-status>
          {viewer ? "Viewer mode" : !d.can_edit ? "Read only" : status || (d.saved_version === d.version ? "Up to date with manually saved version" : `Saved ${when(d.updated_at)}`)}
        </span>
        {!readOnly && (
          <>
            {ctl("left", "Undo (Ctrl+Z)", undo)}
            {ctl("right", "Redo (Ctrl+Y)", redo)}
            <button type="button" onClick={() => saveNow()} className={buttonClass.primary}>
              <Icon name="save" className="h-3.5 w-3.5" /> Save
            </button>
          </>
        )}
        <button type="button" onClick={(e) => setMenu({ x: e.clientX - 200, y: e.clientY + 16, wx: 0, wy: 0, kind: "actions" })} className={buttonClass.secondary}>
          Actions <Icon name="down" className="h-3 w-3" />
        </button>
      </AppHeader>
      {conflict && (
        <div className="flex items-center gap-2 border-b border-line bg-warn/10 px-4 py-1.5 text-xs text-warn">
          {conflict}
          <button type="button" onClick={() => onConflict(conflict)} className="text-ocean hover:underline" data-conflict-resolve>
            Resolve…
          </button>
          <button type="button" onClick={() => location.reload()} className="text-ocean hover:underline">
            Reload
          </button>
        </div>
      )}
      {previewing && (
        <div className="flex items-center gap-2 border-b border-line bg-ocean/10 px-4 py-1.5 text-xs">
          Previewing version {previewing.previewing}
          {d.can_edit && (
            <button type="button" onClick={async () => { const x = await sd.restore(id, previewing.previewing!); setD(x); setGraph(x.graph); setPreviewing(null); }} className="text-ocean hover:underline">
              Restore to this version
            </button>
          )}
          <button type="button" onClick={() => setPreviewing(null)} className="text-ocean hover:underline">
            Back to the current version
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
          {TABS.filter(([t]) => s.aip || (t !== "architect" && t !== "critic")).map(([t, icon, title]) => (
            <button key={t} type="button" title={title} aria-label={title} onClick={() => setTab(tab === t ? null : t)} className={`rounded p-1.5 ${tab === t ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`} data-tab={t}>
              <Icon name={icon} className="h-4 w-4" />
            </button>
          ))}
        </nav>
        {tab && (
          <aside style={{ width: side }} className="relative shrink-0 overflow-hidden border-r border-line bg-panel">
            <div className="flex h-full flex-col">
              <div className="border-b border-line px-3 py-2 text-xs font-medium">{TABS.find((x) => x[0] === tab)![2]}</div>
              <div className="min-h-0 flex-1 overflow-auto">
                {tab === "info" && <InfoPanel graph={shown} onChange={(g) => change(g, false)} readOnly={readOnly} />}
                {tab === "settings" && <SettingsPanel graph={shown} onChange={(g) => (readOnly ? setGraph(g) : change(g, false))} readOnly={readOnly} />}
                {tab === "references" && (
                  <ReferencesPanel readOnly={readOnly}
                    onUse={async (rid, mode) => {
                      const r = await sd.reference(rid);
                      if (mode === "new") {
                        const folder = d.folder_id;
                        if (!folder) return;
                        const x = await sd.create({ name: r.name, folder_id: folder, reference_id: rid });
                        router.push(`/solution-designer/${x.id}`);
                      } else if (mode === "replace") change({ ...graph, nodes: r.graph.nodes, edges: r.graph.edges, description: r.graph.description || graph.description });
                      else addMany(r.graph.nodes, r.graph.edges);
                    }} />
                )}
                {tab === "architect" && (
                  <ArchitectPanel diagram={d} graph={graph} models={models} readOnly={readOnly} sel={one?.id ?? null} onGraph={(g) => change(g)} onPreview={setPreview}
                    onWizard={() => setDialog("wizard")} onArchitect={(a) => setD({ ...d, architect: a })} onFocus={(x) => focusNodes([x])} />
                )}
                {tab === "critic" && <CriticPanel diagram={d} graph={shown} models={models} onFocusNodes={focusNodes} ask={ask} />}
              </div>
            </div>
            <div className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-ocean/40"
              onPointerDown={(e) => {
                const x0 = e.clientX;
                const w0 = side;
                const mv = (m: PointerEvent) => setSide(Math.max(220, Math.min(640, w0 + m.clientX - x0)));
                const upf = () => (window.removeEventListener("pointermove", mv), window.removeEventListener("pointerup", upf));
                window.addEventListener("pointermove", mv);
                window.addEventListener("pointerup", upf);
              }} />
          </aside>
        )}
        <div ref={wrapRef} className="relative min-w-0 flex-1 overflow-hidden">
          {!readOnly && (
            <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-0.5 rounded-lg border border-line bg-panel/95 p-1 shadow" data-toolbar>
              {tool("sparkle", "AIP Generate", () => (setTab("architect"), setDialog("wizard")), s.aip)}
              {tool("bolt", "Concept", (e) => setMenu({ x: e.clientX, y: e.clientY + 14, wx: 0, wy: 0, kind: "concept" }))}
              {tool("grid", "Component", () => setDialog("components"))}
              {tool("link", "Resource", (e) => setMenu({ x: e.clientX, y: e.clientY + 14, wx: 0, wy: 0, kind: "resource" }))}
              {tool("layers", "Group", group)}
              {tool("doc", "Text", () => add({ kind: "text", title: "Note" }))}
              {tool("comment", "AIP Critic", () => setTab("critic"), s.aip)}
              <button type="button" onClick={() => toggle("pan_mode")} title="Pan mode" className={`rounded px-2 py-1 text-xs ${s.pan_mode ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`}>
                <Icon name="move" className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {graph.nodes.length === 0 && !readOnly && (
            <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
              <div className="pointer-events-auto space-y-2 text-center text-sm text-muted">
                <p>An empty diagram.</p>
                <div className="flex gap-2">
                  {s.aip && (
                    <button type="button" onClick={() => (setTab("architect"), setDialog("wizard"))} className={buttonClass.primary}>
                      <Icon name="sparkle" className="h-3.5 w-3.5" /> Start planning
                    </button>
                  )}
                  <button type="button" onClick={() => setTab("references")} className={buttonClass.secondary}>
                    Reference diagrams
                  </button>
                  <button type="button" onClick={() => setDialog("components")} className={buttonClass.secondary}>
                    Add a component
                  </button>
                </div>
              </div>
            </div>
          )}
          <Canvas graph={shown} onChange={change} sel={sel} onSel={(x) => (setSel(x), setMenu(null))} view={view} setView={setView} comps={comps} concepts={concepts} locked={readOnly || locked}
            resolved={resolved} preview={preview} svgRef={svgRef} onContext={(c) => setMenu({ ...c, kind: c.node || c.edge ? "node" : undefined })}
            onOpen={(nodeId) => { setSel({ nodes: [nodeId], edge: null }); }}
            onEditLabel={(eId, x, y) => {
              const r = wrapRef.current?.getBoundingClientRect();
              setLabel({ id: eId, x: x - (r?.left ?? 0), y: y - (r?.top ?? 0), text: graph.edges.find((e) => e.id === eId)?.label ?? "" });
            }} />
          {one && onePos && !readOnly && !locked && one.kind !== "text" && (
            <div style={{ left: Math.max(4, onePos.x), top: Math.max(4, onePos.y - 34) }} className="absolute z-20 flex items-center gap-0.5 rounded-md border border-line bg-panel p-0.5 text-xs shadow" data-node-toolbar>
              {one.resource && (resolved[`${one.resource.kind}:${one.resource.id}`]?.href || one.href) ? (
                <Link href={resolved[`${one.resource.kind}:${one.resource.id}`]?.href ?? one.href!} target="_blank" className="rounded px-1.5 py-0.5 text-ocean hover:bg-panel-2">
                  Open
                </Link>
              ) : one.kind === "component" && comps[one.component ?? ""]?.href ? (
                <Link href={comps[one.component!].href!} target="_blank" className="rounded px-1.5 py-0.5 text-ocean hover:bg-panel-2">
                  Open {comps[one.component!].name}
                </Link>
              ) : null}
              {(one.kind === "component" || one.kind === "resource") && (
                <button type="button" onClick={() => linkTo(one, resKind(one))} className="rounded px-1.5 py-0.5 hover:bg-panel-2">
                  Link resource
                </button>
              )}
              <button type="button" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY + 12, node: one.id, wx: 0, wy: 0, kind: "node" })} className="rounded px-1.5 py-0.5 hover:bg-panel-2" aria-label="More">
                …
              </button>
            </div>
          )}
          {label && (
            <input autoFocus value={label.text} onChange={(e) => setLabel({ ...label, text: e.target.value })} placeholder="Click to Edit"
              onBlur={() => (change({ ...graph, edges: graph.edges.map((e) => (e.id === label.id ? { ...e, label: label.text } : e)) }), setLabel(null))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              style={{ left: label.x - 80, top: label.y - 14 }}
              className={`${inputClass} absolute z-30 w-40 text-xs`} data-edge-label />
          )}
          <div className="absolute bottom-3 left-3 z-10 flex flex-col rounded-lg border border-line bg-panel/95 p-0.5 shadow" data-canvas-controls>
            {ctl("plus", "Zoom in", () => setView({ ...view, k: Math.min(2.5, view.k * 1.2), x: box.w / 2 - ((box.w / 2 - view.x) / view.k) * Math.min(2.5, view.k * 1.2), y: box.h / 2 - ((box.h / 2 - view.y) / view.k) * Math.min(2.5, view.k * 1.2) }))}
            {ctl("minus", "Zoom out", () => setView({ ...view, k: Math.max(0.15, view.k / 1.2), x: box.w / 2 - ((box.w / 2 - view.x) / view.k) * Math.max(0.15, view.k / 1.2), y: box.h / 2 - ((box.h / 2 - view.y) / view.k) * Math.max(0.15, view.k / 1.2) }))}
            {ctl("fit", "Fit all nodes into view", () => fit())}
            {!viewer && d.can_edit && ctl(locked ? "lock" : "unlock", locked ? "Unlock diagram" : "Lock diagram", () => setLocked(!locked), locked)}
            {ctl("grid", "Hide/show background dots", () => (readOnly ? setGraph({ ...graph, settings: { ...s, dots: !s.dots } }) : toggle("dots")), s.dots)}
            {!readOnly && ctl("graph", "Layout nodes automatically", () => (change({ ...graph, nodes: autoLayout(graph.nodes, graph.edges) }), setTimeout(() => fit(), 0)))}
            {ctl("play", "Toggle edge flow animation", () => (readOnly ? setGraph({ ...graph, settings: { ...s, flow_animation: !s.flow_animation } }) : toggle("flow_animation")), s.flow_animation)}
            {ctl("comment", "Hide/Show Edge labels", () => (readOnly ? setGraph({ ...graph, settings: { ...s, edge_labels: !s.edge_labels } }) : toggle("edge_labels")), s.edge_labels)}
            {ctl("check", "Hide/Show Edge Validity", () => (readOnly ? setGraph({ ...graph, settings: { ...s, edge_validity: !s.edge_validity } }) : toggle("edge_validity")), s.edge_validity)}
            {ctl("layers", "Minimize/Maximize node display", () => (readOnly ? setGraph({ ...graph, settings: { ...s, minimized: !s.minimized } }) : toggle("minimized")), s.minimized)}
          </div>
          {s.minimap && <MiniMap graph={shown} view={view} box={box} onJump={(x, y) => setView({ ...view, x: box.w / 2 - x * view.k, y: box.h / 2 - y * view.k })} />}
          {preview && (
            <div className="absolute right-3 top-3 z-10 rounded border border-ocean bg-panel px-3 py-1.5 text-xs text-ocean">
              Previewing an implementation pattern — Insert or Cancel in AIP Architect
            </div>
          )}
        </div>
        {one && (
          <NodePanel node={one} graph={shown} catalog={catalog} resolved={resolved} readOnly={readOnly} onChange={setNode} onFocus={(x) => focusNodes([x])}
            onLink={() => linkTo(one, resKind(one))} onClose={() => setSel({ nodes: [], edge: null })}
            onAsk={(question) => (setTab("critic"), setAsk({ q: question, n: Date.now() }))}
            assist={s.aip ? { diagram: d, models } : null}
            onCreateType={async () => {
              if (!d || !graph) return;
              try {
                // save what is on screen first, then create from that version
                const saved = await sd.save(id, { graph, base_version: d.version });
                const r = await sd.createObjectType(id, one.id, saved.version);
                setD(r.diagram);
                setGraph(r.diagram.graph);
                setStatus(`Created the object type ${r.object_type.display_name}`);
              } catch (e) {
                const ex = e as Error & { status?: number };
                if (ex.status === 409) onConflict(ex.message);
                else setErr(ex.message);
              }
            }}
            onAddTraversal={(t) => {
              const n: SDNode = { id: nid(), kind: "resource", component: "object-type", resource: { kind: "object_type", id: t.object_type_id, name: t.object_type }, title: t.object_type, x: one.x + 300, y: one.y + 40 * graph.edges.filter((e) => e.from === one.id).length, tags: [] };
              change({ ...graph, nodes: [...graph.nodes, n], edges: [...graph.edges, { id: eid(), from: one.id, to: n.id, label: t.link }] });
            }} />
        )}
      </div>

      {menu && (
        <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))}>
          <div style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 320) }} className="absolute w-56 rounded-lg border border-line bg-panel p-1 text-xs shadow-xl" onPointerDown={(e) => e.stopPropagation()} data-menu={menu.kind ?? "canvas"}>
            {(() => {
              const item = (t: string, f: () => void, danger = false) => (
                <button key={t} type="button" onClick={() => (setMenu(null), f())} className={`block w-full rounded px-2 py-1 text-left hover:bg-panel-2 ${danger ? "text-bad" : ""}`}>
                  {t}
                </button>
              );
              if (menu.kind === "actions")
                return (
                  <>
                    {!readOnly && item("Import diagram from JSON…", () => document.getElementById("sd-json-file")?.click())}
                    {!readOnly && s.aip && item("Import from an image (AI vision)…", () => document.getElementById("sd-image-file")?.click())}
                    {!readOnly && item("Import from Data Lineage…", () => setDialog("lineage"))}
                    {d.can_edit && item("Export diagram as JSON", () => exportJson())}
                    {d.can_edit && sel.nodes.length > 0 && item("Export selected nodes as JSON", () => exportJson(sel.nodes))}
                    {d.can_edit && item("Copy diagram JSON", () => void navigator.clipboard?.writeText(JSON.stringify({ format: "bluesandai.solution-diagram", version: 1, name: d.name, graph })))}
                    {d.can_edit && item("Export diagram as PNG", async () => download(await exportPng(document.querySelector("[data-sd-canvas]") as SVGSVGElement, shown), `${d.name}.png`))}
                    {d.can_edit && sel.nodes.length > 0 && item("Export selected nodes as PNG", async () => download(await exportPng(document.querySelector("[data-sd-canvas]") as SVGSVGElement, shown, sel.nodes), `${d.name} (selection).png`))}
                    {!d.can_edit && <div className="px-2 py-1 text-muted">Viewers cannot export diagrams.</div>}
                    {graph.nodes.some((n) => n.resource || n.lineage_id) && item("Open in Data Lineage", () => void openLineage())}
                    {item("Copy link to view-only diagram", () => void navigator.clipboard?.writeText(`${location.origin}/solution-designer/${id}?viewer=true`))}
                    {!readOnly && item("Clear diagram", () => window.confirm("Remove every node and connection?") && change({ ...graph, nodes: [], edges: [] }), true)}
                    {d.can_edit && item("Delete diagram", async () => window.confirm("Move this diagram to the trash?") && (await sd.remove(id), router.push("/solution-designer")), true)}
                  </>
                );
              if (menu.kind === "concept") return catalog.concepts.map((c) => item(c.name, () => add({ kind: "concept", concept: c.id, title: c.name, description: "" })));
              if (menu.kind === "resource")
                return (
                  <>
                    {item("New file node", () => linkTo(undefined, "file"))}
                    {item("New object node", () => linkTo(undefined, "object_type"))}
                    {item("New interface node", () => linkTo(undefined, "interface"))}
                    {item("New action node", () => linkTo(undefined, "action_type"))}
                  </>
                );
              if (menu.edge) {
                const ed = graph.edges.find((e) => e.id === menu.edge);
                const prop = ed ? proposedLink(ed) : null;
                const typed = !!ed && [ed.from, ed.to].every((x) => graph.nodes.find((n) => n.id === x)?.resource?.kind === "object_type");
                return readOnly ? null : (
                  <>
                    {ed?.link_type && item(`Open link type ${ed.link_type.name}`, () => window.open("/ontology?tab=link-types", "_blank"))}
                    {ed && !ed.link_type && prop && typed && item(`Create this link type (${prop.cardinality})`, () => void createLink(ed.id, "auto"))}
                    {ed && !ed.link_type && prop && typed && prop.cardinality !== "many-to-many" && item("Create as a many-to-many join table", () => void createLink(ed.id, "join_table"))}
                    {ed && !ed.link_type && prop && !typed && <div className="px-2 py-1 text-muted">Create or link both object types to create this link type</div>}
                    {item("Edit label", () => {
                      const r = document.querySelector("[data-sd-canvas]")?.getBoundingClientRect();
                      setLabel({ id: menu.edge!, x: menu.x - (r?.left ?? 0), y: menu.y - (r?.top ?? 0), text: graph.edges.find((e) => e.id === menu.edge)?.label ?? "" });
                    })}
                    {item("Delete Edge", () => change({ ...graph, edges: graph.edges.filter((e) => e.id !== menu.edge) }), true)}
                  </>
                );
              }
              if (menu.node) {
                const n = graph.nodes.find((x) => x.id === menu.node);
                if (!n || readOnly) return <div className="px-2 py-1 text-muted">Read only</div>;
                const ids = sel.nodes.includes(n.id) ? sel.nodes : [n.id];
                return (
                  <>
                    {item("Bring to front", () => setNode({ ...n, z: Math.max(...graph.nodes.map((x) => x.z ?? 0)) + 1 }))}
                    {item("Send to back", () => setNode({ ...n, z: Math.min(...graph.nodes.map((x) => x.z ?? 0)) - 1 }))}
                    {item(ids.length > 1 ? `Group ${ids.length} nodes` : "Group", () => (setSel({ nodes: ids, edge: null }), setTimeout(group, 0)))}
                    {item("Change Bg color", () => setSel({ nodes: [n.id], edge: null }))}
                    {n.resource && item("Remove linked resource", () => setNode({ ...n, kind: "component", resource: null, component: n.component ?? "custom" }))}
                    {item("Edit tags", () => setSel({ nodes: [n.id], edge: null }))}
                    {n.parent && item("Remove from group", () => setNode({ ...n, parent: null }))}
                    {item("Duplicate", () => {
                      const ns = graph.nodes.filter((x) => ids.includes(x.id));
                      const dup = shift(ns, graph.edges.filter((e) => ids.includes(e.from) && ids.includes(e.to)), 40, 40);
                      change({ ...graph, nodes: [...graph.nodes, ...dup.nodes], edges: [...graph.edges, ...dup.edges] });
                      setSel({ nodes: dup.nodes.map((x) => x.id), edge: null });
                    })}
                    {s.aip && item("Ask AIP Critic about this node", () => (setTab("critic"), setAsk({ q: `What should I consider for "${n.title}" in this architecture?`, n: Date.now() })))}
                    {item("Delete", () => (setSel({ nodes: ids, edge: null }), setTimeout(remove, 0)), true)}
                  </>
                );
              }
              return readOnly ? (
                <div className="px-2 py-1 text-muted">Read only</div>
              ) : (
                <>
                  {item("Add Comment", () => add({ kind: "text", title: "Comment", x: menu.wx, y: menu.wy }))}
                  {item("Add Empty group", () => add({ kind: "group", title: "Group", x: menu.wx, y: menu.wy, w: 400, h: 260 }))}
                  {item("Add component here…", () => setDialog("components"))}
                  {item("Layout nodes automatically", () => change({ ...graph, nodes: autoLayout(graph.nodes, graph.edges) }))}
                  {item("Paste", () => void paste())}
                </>
              );
            })()}
          </div>
        </div>
      )}
      <input id="sd-json-file" type="file" accept="application/json,.json" className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            const j = JSON.parse(await f.text());
            const g = j.graph ?? j;
            if (!Array.isArray(g.nodes)) throw new Error("not a Solution Designer diagram (no nodes)");
            addMany(g.nodes, g.edges ?? []);
          } catch (ex) {
            alert(`Import failed: ${(ex as Error).message}`);
          }
        }} />
      <input id="sd-image-file" type="file" accept="image/*" className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setStatus("Reading the image…");
          try {
            const r = await sd.importImage(id, f, models.find((m) => m.default)?.id);
            addMany(r.nodes, r.edges);
            setStatus(`Imported ${r.nodes.length} nodes from the image`);
          } catch (ex) {
            setStatus(`Image import failed: ${(ex as Error).message}`);
          }
        }} />
      {dialog === "components" && (
        <ComponentPicker catalog={catalog} onClose={() => setDialog(null)}
          onPick={(c) => {
            setDialog(null);
            add({ kind: "component", component: c.id, title: c.name, description: "" });
          }} />
      )}
      {dialog && typeof dialog === "object" && (
        <ResourcePicker kind={dialog.resource} onClose={() => setDialog(null)}
          onPick={(r) => {
            const target = dialog.link ? graph.nodes.find((n) => n.id === dialog.link) : undefined;
            const comp = r.kind === "object_type" ? "object-type" : r.kind === "action_type" ? "action-type" : r.kind === "interface" ? "interface" : target?.component ?? "dataset";
            setDialog(null);
            if (target) setNode({ ...target, kind: "resource", resource: { kind: r.kind, id: r.id, name: r.name }, component: target.component ?? comp, title: target.title || r.name, href: r.href });
            else add({ kind: "resource", resource: { kind: r.kind, id: r.id, name: r.name }, component: comp, title: r.name, href: r.href });
          }} />
      )}
      {dialog === "versions" && (
        <VersionsDialog versions={d.versions} current={d.version} onClose={() => setDialog(null)}
          onPreview={async (v) => (setDialog(null), v === d.version ? setPreviewing(null) : setPreviewing(await sd.get(id, v)))}
          onRestore={async (v) => {
            const x = await sd.restore(id, v);
            setD(x);
            setGraph(x.graph);
            setPreviewing(null);
            setDialog(null);
          }} />
      )}
      {dialog === "wizard" && (
        <WizardDialog models={models} initial={d.architect?.wizard} onClose={() => setDialog(null)}
          onGenerate={async (w) => {
            const r = await sd.generate(id, w);
            const keep = graph.nodes.length ? bounds(graph.nodes) : null;
            const s2 = keep ? shift(r.nodes, r.edges, 0, keep.y + keep.h + 160 - Math.min(...r.nodes.map((n) => n.y))) : { nodes: r.nodes, edges: r.edges };
            const g2 = { ...graph, nodes: [...graph.nodes, ...s2.nodes], edges: [...graph.edges, ...s2.edges], description: graph.description || w.summary };
            change(g2);
            setD({ ...d, architect: r.architect });
            setDialog(null);
            setTab("architect");
            setTimeout(() => fit(s2.nodes), 0);
          }} />
      )}
      {conflict && conflictOpen && (
        <ConflictDialog message={conflict} mine={graph} server={conflictServer} onCancel={() => setConflictOpen(false)}
          onKeepServer={() => {
            if (!conflictServer) return;
            setD(conflictServer);
            setGraph(conflictServer.graph);
            setPast([]);
            setFuture([]);
            setPreviewing(null);
            endConflict();
            setStatus(`Loaded the server version ${conflictServer.version}; your changes were discarded`);
          }}
          onKeepMine={async () => {
            if (!conflictServer) return;
            try {
              const x = await sd.save(id, { graph, base_version: conflictServer.version, manual: true, description: `Kept my changes over version ${conflictServer.version}` });
              setD(x);
              endConflict();
              setStatus(`Saved your changes as version ${x.version}`);
            } catch (e) {
              // saved again meanwhile: compare with that version instead
              if ((e as Error & { status?: number }).status === 409) setConflictServer(await sd.get(id));
              throw e;
            }
          }} />
      )}
      {dialog === "lineage" && (
        <LineageDialog onClose={() => setDialog(null)}
          onImport={(nodes, edges) => {
            setDialog(null);
            addMany(nodes, edges);
          }} />
      )}
    </div>
  );
}

