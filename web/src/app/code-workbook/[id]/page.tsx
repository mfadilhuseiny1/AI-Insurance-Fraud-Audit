"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge } from "@/components/ontology/parts";
import { CodeEditor } from "@/components/code/CodeEditor";
import { codeRepos, type Check, type PreviewResult, type Repo, type TransformInfo, type BuildRecord } from "@/lib/codeRepos";

type GraphNode = {
  id: string;
  kind: "transform" | "input";
  title: string;
  subtitle: string;
  transform?: TransformInfo;
  ref?: string;
};
type GraphEdge = { from: string; to: string; label: string };
type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[]; parents: Map<string, string[]>; children: Map<string, string[]> };
type PositionedNode = GraphNode & { x: number; y: number };
type PanelTab = "logic" | "inputs" | "preview" | "logs";
const EMPTY_TRANSFORMS: TransformInfo[] = [];

const normalizeRef = (value: string) => value.trim().replace(/^Input\(/i, "").replace(/\)\s*$/, "").replace(/^['"`]|['"`]$/g, "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").toLowerCase();
const lastPart = (value: string) => normalizeRef(value).split("/").filter(Boolean).at(-1) ?? normalizeRef(value);
const displayValue = (value: unknown) => value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);

function buildGraph(transforms: TransformInfo[]): GraphModel {
  const outputRefs = new Map<string, Set<string>>();
  const addOutput = (ref: string, key: string) => {
    const normalized = normalizeRef(ref);
    if (!normalized) return;
    const found = outputRefs.get(normalized) ?? new Set<string>();
    found.add(key);
    outputRefs.set(normalized, found);
    const base = lastPart(normalized);
    const baseFound = outputRefs.get(base) ?? new Set<string>();
    baseFound.add(key);
    outputRefs.set(base, baseFound);
  };

  for (const transform of transforms) {
    const outputs = [transform.output?.name, transform.output?.folder && transform.output.name ? `${transform.output.folder}/${transform.output.name}` : "", transform.key];
    for (const output of Object.values(transform.outputs ?? {})) {
      outputs.push(output.name, output.folder && output.name ? `${output.folder}/${output.name}` : "");
    }
    outputs.forEach((output) => output && addOutput(output, transform.key));
  }

  const nodes: GraphNode[] = transforms.map((transform) => ({
    id: transform.key,
    kind: "transform",
    title: `${transform.function}()`,
    subtitle: transform.output?.name || transform.file,
    transform,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];
  const inputNodes = new Map<string, GraphNode>();
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();

  for (const transform of transforms) {
    const upstreams: string[] = [];
    for (const [param, ref] of Object.entries(transform.inputs ?? {})) {
      const normalized = normalizeRef(ref);
      const base = lastPart(normalized);
      const matches = outputRefs.get(normalized) ?? outputRefs.get(base);
      const parent = matches?.size === 1 ? Array.from(matches)[0] : null;
      if (parent && parent !== transform.key && nodeIds.has(parent)) {
        edges.push({ from: parent, to: transform.key, label: param });
        upstreams.push(parent);
        children.set(parent, [...(children.get(parent) ?? []), transform.key]);
      } else {
        const inputId = `input:${encodeURIComponent(normalized || ref)}`;
        if (!inputNodes.has(inputId)) {
          inputNodes.set(inputId, {
            id: inputId,
            kind: "input",
            title: lastPart(ref) || ref || param,
            subtitle: ref,
            ref,
          });
          nodes.push(inputNodes.get(inputId)!);
        }
        edges.push({ from: inputId, to: transform.key, label: param });
        upstreams.push(inputId);
        children.set(inputId, [...(children.get(inputId) ?? []), transform.key]);
      }
    }
    parents.set(transform.key, upstreams);
  }
  for (const node of inputNodes.values()) parents.set(node.id, []);
  return { nodes, edges, parents, children };
}

function positionGraph(graph: GraphModel) {
  const depthCache = new Map<string, number>();
  const depthOf = (id: string, visiting = new Set<string>()): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(id);
    const parents = graph.parents.get(id) ?? [];
    const depth = parents.length ? Math.max(...parents.map((parent) => depthOf(parent, nextVisiting))) + 1 : 0;
    depthCache.set(id, depth);
    return depth;
  };
  const columns = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    const depth = depthOf(node.id);
    columns.set(depth, [...(columns.get(depth) ?? []), node]);
  }
  const positioned: PositionedNode[] = [];
  for (const [depth, nodes] of columns) {
    nodes.forEach((node, index) => positioned.push({ ...node, x: 48 + depth * 330, y: 48 + index * 174 }));
  }
  const maxDepth = Math.max(0, ...Array.from(columns.keys()));
  const maxRows = Math.max(1, ...Array.from(columns.values()).map((items) => items.length));
  return { nodes: positioned, width: 48 + maxDepth * 330 + 292, height: 48 + maxRows * 174 + 36 };
}

function pathNodeIds(graph: GraphModel, target: string | undefined) {
  if (!target) return new Set<string>();
  const found = new Set<string>();
  const visit = (id: string, adjacency: Map<string, string[]>) => {
    const queue = [id];
    while (queue.length) {
      const current = queue.pop()!;
      if (found.has(current)) continue;
      found.add(current);
      for (const next of adjacency.get(current) ?? []) queue.push(next);
    }
  };
  visit(target, graph.parents);
  visit(target, graph.children);
  return found;
}

export default function CodeWorkbookDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();
  const branch = searchParams.get("branch") || undefined;
  const requestKey = `${id}:${branch ?? "default"}`;
  const [reloadToken, setReloadToken] = useState(0);
  const [repoState, setRepoState] = useState<{ key: string; value: Repo } | null>(null);
  const [repoError, setRepoError] = useState<{ key: string; message: string } | null>(null);
  const [checkState, setCheckState] = useState<{ key: string; value: Check } | null>(null);
  const [checkError, setCheckError] = useState<{ key: string; message: string } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [panelTab, setPanelTab] = useState<PanelTab>("logic");
  const [mode, setMode] = useState<"graph" | "paths">("graph");
  const [zoom, setZoom] = useState(1);
  const [previewState, setPreviewState] = useState<{ key: string; value: PreviewResult } | null>(null);
  const [buildState, setBuildState] = useState<{ key: string; value: BuildRecord[] } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "build" | null>(null);
  const [contentsQuery, setContentsQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    const key = `${requestKey}:${reloadToken}`;
    void codeRepos.get(id, branch).then((value) => {
      if (cancelled) return;
      setRepoState({ key, value });
      void codeRepos.runChecks(id, value.branch.name).then((check) => {
        if (!cancelled) setCheckState({ key, value: check });
      }).catch((error: Error) => {
        if (!cancelled) setCheckError({ key, message: error.message });
      });
    }).catch((error: Error) => {
      if (!cancelled) setRepoError({ key, message: error.message });
    });
    return () => { cancelled = true; };
  }, [id, branch, requestKey, reloadToken]);

  const loadKey = `${requestKey}:${reloadToken}`;
  const repo = repoState?.key === loadKey ? repoState.value : null;
  const error = repoError?.key === loadKey ? repoError.message : null;
  const check = checkState?.key === loadKey ? checkState.value : null;
  const currentCheckError = checkError?.key === loadKey ? checkError.message : null;
  const transforms = check?.transforms ?? EMPTY_TRANSFORMS;
  const graph = useMemo(() => buildGraph(transforms), [transforms]);
  const layout = useMemo(() => positionGraph(graph), [graph]);
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes.find((node) => node.kind === "transform") ?? graph.nodes[0];
  const selectedTransform = selectedNode?.transform;
  const currentPreview = selectedTransform && previewState?.key === `${loadKey}:${selectedTransform.key}` ? previewState.value : null;
  const currentBuilds = selectedTransform && buildState?.key === `${loadKey}:${selectedTransform.key}` ? buildState.value : null;
  const filteredTransforms = useMemo(() => {
    const q = contentsQuery.trim().toLowerCase();
    return transforms.filter((transform) => !q || `${transform.function} ${transform.file} ${transform.output.name}`.toLowerCase().includes(q));
  }, [contentsQuery, transforms]);
  const pathIds = useMemo(() => pathNodeIds(graph, selectedTransform?.key), [graph, selectedTransform?.key]);
  const visibleNodeIds = mode === "paths" && selectedTransform ? pathIds : new Set(graph.nodes.map((node) => node.id));
  const positionById = new Map(layout.nodes.map((node) => [node.id, node]));
  const visibleEdges = graph.edges.filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to));
  const canvasWidth = Math.max(560, layout.width);
  const canvasHeight = Math.max(520, layout.height);

  const runPreview = useCallback(async () => {
    if (!selectedTransform || !repo) return;
    setBusy("preview");
    setActionError(null);
    try {
      const value = await codeRepos.preview(id, repo.branch.name, selectedTransform.key, 50);
      setPreviewState({ key: `${loadKey}:${selectedTransform.key}`, value });
      setPanelTab("preview");
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [id, loadKey, repo, selectedTransform]);

  const runBuild = useCallback(async () => {
    if (!selectedTransform || !repo) return;
    setBusy("build");
    setActionError(null);
    try {
      const value = await codeRepos.build(id, repo.branch.name, { transform: selectedTransform.key });
      setBuildState({ key: `${loadKey}:${selectedTransform.key}`, value });
      setPanelTab("logs");
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [id, loadKey, repo, selectedTransform]);

  const changeBranch = (value: string) => {
    const next = `/code-workbook/${encodeURIComponent(id)}?branch=${encodeURIComponent(value)}`;
    router.replace(next);
  };

  if (!repo && error) {
    return (
      <div className="flex-1 p-8">
        <AppHeader app="Code Workbook (Legacy)" icon="graph" href="/code-workbook" crumbs={[{ label: id }]} />
        <div role="alert" className="mx-auto mt-8 max-w-3xl rounded-lg border border-bad/30 bg-bad/10 p-4 text-sm text-bad">{error}</div>
      </div>
    );
  }
  if (!repo) {
    return (
      <div className="flex-1">
        <AppHeader app="Code Workbook (Legacy)" icon="graph" href="/code-workbook" crumbs={[{ label: id }]} />
        <div className="p-8 text-sm text-muted">Loading repository and discovering transforms…</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel-2 text-white">
      <AppHeader app="Code Workbook (Legacy)" icon="graph" href="/code-workbook" crumbs={[{ label: repo.name }]}>
        <label className="hidden items-center gap-2 text-xs text-muted sm:flex">
          <Icon name="split" className="h-3.5 w-3.5" /> Branch
          <select aria-label="Branch" className="max-w-44 rounded-md border border-line bg-panel px-2 py-1.5 text-xs text-soft" value={repo.branch.name} onChange={(event) => changeBranch(event.target.value)}>
            {repo.branches.map((item) => <option key={item.name} value={item.name}>{item.name}{item.protected ? " · protected" : ""}</option>)}
          </select>
        </label>
        <Link href={`/code-repositories/${encodeURIComponent(id)}?branch=${encodeURIComponent(repo.branch.name)}`} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-soft hover:bg-panel-2">
          <Icon name="external" className="h-3.5 w-3.5" /> Repository IDE
        </Link>
      </AppHeader>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2">
          <div className="mr-2 flex items-center gap-2 text-sm font-semibold"><Icon name="graph" className="h-4 w-4 text-sky-700" /> {repo.name}</div>
          <span className="rounded bg-panel-2 px-2 py-1 text-[11px] text-soft">{transforms.length} transform{transforms.length === 1 ? "" : "s"}</span>
          <span className="hidden text-[11px] text-muted lg:inline">Repository-derived graph · layout is not saved</span>
          <div className="ml-auto flex items-center gap-1.5">
            <div className="mr-2 flex rounded-md border border-line p-0.5">
              <button type="button" onClick={() => setMode("graph")} className={`rounded px-2.5 py-1 text-xs ${mode === "graph" ? "bg-panel-2 font-medium text-white" : "text-muted hover:text-white"}`}><Icon name="graph" className="mr-1 inline h-3.5 w-3.5" />Graph</button>
              <button type="button" onClick={() => setMode("paths")} className={`rounded px-2.5 py-1 text-xs ${mode === "paths" ? "bg-panel-2 font-medium text-white" : "text-muted hover:text-white"}`}><Icon name="split" className="mr-1 inline h-3.5 w-3.5" />Paths</button>
            </div>
            <button type="button" onClick={() => setZoom((value) => Math.max(0.6, +(value - 0.1).toFixed(1)))} className="rounded border border-line px-2 py-1 text-xs hover:bg-panel-2" aria-label="Zoom out">−</button>
            <span className="w-10 text-center text-[11px] tabular-nums text-muted">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => Math.min(1.5, +(value + 0.1).toFixed(1)))} className="rounded border border-line px-2 py-1 text-xs hover:bg-panel-2" aria-label="Zoom in">+</button>
            <button type="button" onClick={() => setZoom(1)} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs hover:bg-panel-2"><Icon name="fit" className="h-3.5 w-3.5" /> Fit</button>
            <button type="button" onClick={() => setReloadToken((value) => value + 1)} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs hover:bg-panel-2"><Icon name="refresh" className="h-3.5 w-3.5" /> Refresh</button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
          <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel 2xl:flex">
            <div className="border-b border-line px-3 py-3">
              <div className="flex items-center justify-between text-xs font-semibold text-soft"><span>Contents</span><span className="font-normal text-muted">{transforms.length}</span></div>
              <div className="relative mt-2">
                <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input className="w-full rounded-md border border-line bg-panel-2 py-1.5 pl-8 pr-2 text-xs outline-none focus:border-sky-400" value={contentsQuery} onChange={(event) => setContentsQuery(event.target.value)} placeholder="Find a transform" />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filteredTransforms.map((transform) => (
                <button key={transform.key} type="button" onClick={() => { setSelectedNodeId(transform.key); setPanelTab("logic"); }} className={`mb-1 w-full rounded-md border px-2.5 py-2 text-left ${selectedTransform?.key === transform.key ? "border-sky-300 bg-ocean/10" : "border-transparent hover:bg-panel-2"}`}>
                  <span className="flex items-center gap-2 text-xs font-medium text-white"><Icon name="transform" className="h-3.5 w-3.5 shrink-0 text-sky-700" /><span className="truncate">{transform.function}()</span></span>
                  <span className="mt-1 block truncate pl-5 text-[10px] text-muted">{transform.output.name || transform.file}</span>
                </button>
              ))}
              {filteredTransforms.length === 0 && <div className="px-2 py-4 text-xs text-muted">No transforms found.</div>}
            </div>
            <div className="border-t border-line p-3 text-[10px] leading-4 text-muted">
              <span className="font-medium text-soft">Graph source</span><br />Current branch check metadata. Manual nodes and user-saved positions are not yet supported.
            </div>
          </aside>

          <section className="relative min-h-[42vh] min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle,_var(--color-line-2)_1px,_transparent_1px)] [background-size:20px_20px] xl:min-h-0" aria-label="Transform graph">
            {currentCheckError && <div className="sticky top-2 z-20 mx-3 mt-3 rounded-md border border-amber-300 bg-sand/10 px-3 py-2 text-xs text-sand">Checks unavailable: {currentCheckError}. Existing cached results are not used; refresh to retry.</div>}
            {!transforms.length ? (
              <div className="absolute inset-0 grid place-items-center p-8 text-center">
                <div className="max-w-md rounded-xl border border-line bg-panel/95 p-7 shadow-sm">
                  <Icon name="graph" className="mx-auto h-8 w-8 text-sky-700" />
                  <h2 className="mt-3 font-semibold">No transform graph yet</h2>
                  <p className="mt-1 text-sm leading-6 text-muted">Run or repair repository checks, then refresh. The graph is discovered from transforms in the selected branch.</p>
                  <Link href={`/code-repositories/${encodeURIComponent(id)}?branch=${encodeURIComponent(repo.branch.name)}`} className="mt-4 inline-flex items-center gap-2 rounded-md bg-sky-700 px-3 py-2 text-xs font-medium text-white hover:bg-ocean-deep"><Icon name="external" /> Open repository IDE</Link>
                </div>
              </div>
            ) : (
              <div style={{ width: canvasWidth * zoom, height: canvasHeight * zoom }}>
                <div className="relative origin-top-left" style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${zoom})`, transformOrigin: "top left" }}>
                  <svg className="pointer-events-none absolute left-0 top-0" width={canvasWidth} height={canvasHeight} aria-hidden="true">
                    <defs><marker id="cw-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path style={{ fill: "var(--color-muted)" }} d="M0,0 L0,6 L7,3 z"  /></marker><marker id="cw-arrow-active" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#0284c7" /></marker></defs>
                    {visibleEdges.map((edge, index) => {
                      const from = positionById.get(edge.from);
                      const to = positionById.get(edge.to);
                      if (!from || !to) return null;
                      const active = mode === "paths" || (selectedTransform?.key === edge.to || selectedTransform?.key === edge.from);
                      const x1 = from.x + 250;
                      const y1 = from.y + 62;
                      const x2 = to.x;
                      const y2 = to.y + 62;
                      const middle = (x1 + x2) / 2;
                      return <g key={`${edge.from}-${edge.to}-${index}`}><path d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2 - 6} ${y2}`} fill="none" stroke={active ? "#0284c7" : "var(--color-muted)"} strokeWidth={active ? 2.2 : 1.5} markerEnd={active ? "url(#cw-arrow-active)" : "url(#cw-arrow)"} />{active && <text style={{ fill: "var(--color-soft)" }} x={middle} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize="10" >{edge.label}</text>}</g>;
                    })}
                  </svg>
                  {layout.nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => {
                    const selected = selectedNode?.id === node.id;
                    const transform = node.transform;
                    return (
                      <button key={node.id} type="button" onClick={() => { setSelectedNodeId(node.id); if (node.kind === "transform") setPanelTab("logic"); }} style={{ left: node.x, top: node.y, width: 252 }} className={`absolute overflow-hidden rounded-lg border bg-panel text-left shadow-sm transition ${selected ? "border-sky-500 ring-2 ring-sky-200" : "border-line hover:border-sky-300 hover:shadow-md"}`}>
                        <div className={`flex items-center justify-between border-b px-3 py-2 ${node.kind === "input" ? "border-ok/30 bg-ok/10" : "border-line bg-panel-2"}`}>
                          <span className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-soft"><Icon name={node.kind === "input" ? "database" : "transform"} className={`h-3.5 w-3.5 shrink-0 ${node.kind === "input" ? "text-emerald-700" : "text-sky-700"}`} /><span className="truncate">{node.kind === "input" ? "Input dataset" : transform?.function}</span></span>
                          {transform?.blocked ? <Badge status="failed" label="blocked" /> : transform && <span className="rounded bg-panel px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">{transform.language ?? transform.kind}</span>}
                        </div>
                        <div className="px-3 py-2.5">
                          <div className="truncate text-xs font-medium text-white">{node.kind === "transform" ? transform?.output.name || node.title : node.title}</div>
                          <div className="mt-1 truncate text-[10px] text-muted">{node.kind === "transform" ? transform?.file : node.ref}</div>
                        </div>
                        {node.kind === "transform" && <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[10px] text-muted"><span>{Object.keys(transform?.inputs ?? {}).length} input{Object.keys(transform?.inputs ?? {}).length === 1 ? "" : "s"}</span><span className="truncate pl-2">{transform?.output.folder || "Repository output"}</span></div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <aside className="flex h-[42vh] w-full shrink-0 flex-col border-t border-line bg-panel xl:h-auto xl:w-[min(38vw,500px)] xl:border-l xl:border-t-0">
            <div className="border-b border-line px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{selectedTransform ? "Transform" : "Input"}</div>
                  <h2 className="mt-1 truncate text-sm font-semibold text-white">{selectedNode?.title ?? "Select a graph node"}</h2>
                  {selectedNode?.subtitle && <p className="mt-1 truncate text-[11px] text-muted">{selectedNode.subtitle}</p>}
                </div>
                {selectedTransform && <div className="flex shrink-0 gap-1.5"><button type="button" onClick={runPreview} disabled={Boolean(busy) || Boolean(selectedTransform.blocked)} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1.5 text-[11px] font-medium text-soft hover:bg-panel-2 disabled:opacity-50"><Icon name="play" className="h-3 w-3" />{busy === "preview" ? "Running…" : "Preview"}</button><button type="button" onClick={runBuild} disabled={Boolean(busy) || Boolean(selectedTransform.blocked)} className="inline-flex items-center gap-1 rounded-md bg-sky-700 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-ocean-deep disabled:opacity-50"><Icon name="bolt" className="h-3 w-3" />{busy === "build" ? "Building…" : "Build"}</button></div>}
              </div>
              {actionError && <div role="alert" className="mt-3 rounded-md border border-bad/30 bg-bad/10 px-2.5 py-2 text-[11px] text-red-700">{actionError}</div>}
              <div className="mt-3 flex border-b border-line">
                {(["logic", "inputs", "preview", "logs"] as PanelTab[]).map((tab) => <button key={tab} type="button" onClick={() => setPanelTab(tab)} className={`border-b-2 px-3 py-2 text-[11px] capitalize ${panelTab === tab ? "border-sky-600 font-semibold text-ocean" : "border-transparent text-muted hover:text-white"}`}>{tab}</button>)}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {!selectedNode ? (
                <div className="p-5 text-xs text-muted">Select a transform or input card to inspect it.</div>
              ) : selectedNode.kind === "input" ? (
                <div className="p-4">
                  <div className="rounded-md border border-ok/30 bg-ok/10 p-3 text-xs text-ok"><div className="font-semibold">External input reference</div><div className="mt-1 break-all font-mono text-[11px]">{selectedNode.ref}</div></div>
                  <p className="mt-3 text-xs leading-5 text-muted">This reference is read from transform metadata. It could not be matched to another transform output in this repository.</p>
                </div>
              ) : panelTab === "logic" ? (
                <div className="flex h-full min-h-80 flex-col">
                  <div className="flex items-center justify-between border-b border-line bg-panel-2 px-3 py-2 text-[10px] text-soft"><span className="truncate">{selectedTransform?.file}</span><span>{selectedTransform?.language ?? selectedTransform?.kind}</span></div>
                  <div className="min-h-0 flex-1 bg-ink">
                    <CodeEditor value={repo.files[selectedTransform?.file ?? ""] ?? "# Source file is not available on this branch."} onChange={() => undefined} path={selectedTransform?.file ?? "transform.py"} readOnly />
                  </div>
                  <div className="border-t border-line px-3 py-2 text-[10px] text-muted">Read-only view. Edit and save code in the Repository IDE.</div>
                </div>
              ) : panelTab === "inputs" ? (
                <div className="p-4">
                  <p className="mb-3 text-xs leading-5 text-muted">Declared inputs for this transform. Connections are inferred only when an input reference matches a transform output.</p>
                  {Object.entries(selectedTransform?.inputs ?? {}).length ? <div className="overflow-hidden rounded-lg border border-line"><table className="w-full text-left text-[11px]"><thead className="bg-panel-2 text-muted"><tr><th className="px-3 py-2 font-medium">Input</th><th className="px-3 py-2 font-medium">Reference</th></tr></thead><tbody>{Object.entries(selectedTransform?.inputs ?? {}).map(([param, ref]) => <tr key={param} className="border-t border-line"><td className="px-3 py-2 font-medium text-white">{param}</td><td className="break-all px-3 py-2 font-mono text-[10px] text-soft">{ref}</td></tr>)}</tbody></table></div> : <div className="rounded-lg border border-dashed border-line p-5 text-center text-xs text-muted">No declared inputs.</div>}
                  {selectedTransform?.blocked && <div className="mt-3 rounded-md border border-sand/30 bg-sand/10 p-3 text-xs text-sand">Build limitation: {selectedTransform.blocked}</div>}
                </div>
              ) : panelTab === "preview" ? (
                <PreviewPane result={currentPreview} />
              ) : (
                <LogsPane preview={currentPreview} builds={currentBuilds} check={check} />
              )}
            </div>
            {selectedTransform && <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[10px] text-muted"><span>Line {selectedTransform.line} · {selectedTransform.kind}</span><Link href={`/code-repositories/${encodeURIComponent(id)}?branch=${encodeURIComponent(repo.branch.name)}`} className="inline-flex items-center gap-1 text-sky-700 hover:underline">Open in IDE <Icon name="external" className="h-3 w-3" /></Link></div>}
          </aside>
        </div>
        <div className="flex items-center justify-between border-t border-line bg-panel px-3 py-1.5 text-[10px] text-muted">
          <span>{check ? `Last graph check ${new Date(check.at).toLocaleString()} · ${check.status}` : currentCheckError ? `Checks unavailable: ${currentCheckError}` : "Discovering repository transforms…"}</span>
          <span>Graph metadata only · no saved layout or manual Workbook nodes</span>
        </div>
      </div>
    </div>
  );
}

function PreviewPane({ result }: { result: PreviewResult | null }) {
  if (!result) return <div className="grid h-full min-h-48 place-items-center p-6 text-center text-xs text-muted">Run Preview to execute this transform without committing its outputs.</div>;
  const rows = result.preview ?? [];
  const columns = result.columns?.map((column) => column.name) ?? Object.keys(rows[0] ?? {});
  return (
    <div className="p-3">
      <div className={`mb-3 rounded-md border px-3 py-2 text-xs ${result.ok ? "border-ok/30 bg-ok/10 text-ok" : "border-bad/30 bg-bad/10 text-bad"}`}>
        <span className="font-semibold">{result.ok ? "Preview succeeded" : "Preview failed"}</span>{result.rows !== undefined && <span className="ml-2">{result.rows.toLocaleString()} rows</span>}
        {result.error && <div className="mt-1 break-words">{result.error}</div>}
      </div>
      {rows.length > 0 && columns.length > 0 ? <div className="overflow-auto rounded-md border border-line"><table className="w-full border-collapse text-left text-[10px]"><thead className="sticky top-0 bg-panel-2 text-muted"><tr>{columns.map((column) => <th key={column} className="max-w-48 border-b border-line px-2 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-line last:border-0">{columns.map((column) => <td key={column} className="max-w-48 truncate px-2 py-1.5 text-soft" title={displayValue(row[column])}>{displayValue(row[column])}</td>)}</tr>)}</tbody></table></div> : <p className="text-xs text-muted">No preview rows returned.</p>}
      {result.output_previews && Object.entries(result.output_previews).map(([name, output]) => <div key={name} className="mt-3 rounded-md border border-line p-2 text-[10px] text-soft"><span className="font-medium text-white">{name}</span> · {output.rows} rows · {output.columns.length} columns</div>)}
      {result.expectations?.length ? <div className="mt-3 space-y-1">{result.expectations.map((expectation) => <div key={expectation.id} className={`rounded px-2 py-1 text-[10px] ${expectation.ok ? "bg-ok/10 text-ok" : "bg-sand/10 text-sand"}`}>{expectation.ok ? "Pass" : "Check"} · {expectation.name || expectation.id}: {expectation.message}</div>)}</div> : null}
      <p className="mt-2 text-[10px] text-muted">Preview is limited to 50 rows and does not save dataset outputs.</p>
    </div>
  );
}

function LogsPane({ preview, builds, check }: { preview: PreviewResult | null; builds: BuildRecord[] | null; check: Check | null }) {
  const latestBuild = builds?.[0];
  const logs = latestBuild?.logs || preview?.logs || check?.logs || "No logs yet. Run Preview or Build to see transform output.";
  return (
    <div className="p-3">
      {latestBuild && <div className={`mb-3 rounded-md border px-3 py-2 text-xs ${latestBuild.status === "succeeded" ? "border-ok/30 bg-ok/10 text-ok" : "border-bad/30 bg-bad/10 text-bad"}`}><span className="font-semibold">Build {latestBuild.status}</span><span className="ml-2">{latestBuild.ms} ms</span>{latestBuild.output && <span className="ml-2">{latestBuild.output.rows.toLocaleString()} rows written</span>}</div>}
      <pre className="max-h-full min-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-ink p-3 font-mono text-[10px] leading-5 text-soft">{logs}</pre>
      {preview?.error && <div className="mt-2 rounded-md border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{preview.error}</div>}
    </div>
  );
}
