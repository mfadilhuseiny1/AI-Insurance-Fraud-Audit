"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "@/components/code/CodeEditor";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { CLIP_KEY, copyNodes, pasteNodes, type Clip } from "@/lib/codeWorkbookClipboard";
import type { GraphTemplate } from "@/lib/codeWorkbook";
import { codeWorkbooks, type ConsoleResult, type MergePlan, type NodeKind, type NodeResult, type Preview, type WbEnvironment, type WbNode, type WbTemplate, type Workbook } from "@/lib/codeWorkbook";
import { contour, type Analysis } from "@/lib/contour";
import { datasetPreview } from "@/lib/datasetPreview";
import { when } from "@/lib/format";
import { copyForNotepad } from "@/lib/notepadClip";
import { alertDialog, promptDialog } from "@/lib/dialogs";

const small = `${inputClass} py-1 text-xs`;
const NODE_W = 170;
const KIND_STYLE: Record<NodeKind, { label: string; color: string; icon: "database" | "code" | "table" | "pencil" | "copy" | "filter" }> = {
  input: { label: "Dataset", color: "border-sky-500/60 bg-sky-500/10", icon: "database" },
  python: { label: "Python", color: "border-amber-500/60 bg-amber-500/10", icon: "code" },
  sql: { label: "SQL", color: "border-violet-500/60 bg-violet-500/10", icon: "table" },
  r: { label: "R", color: "border-blue-500/60 bg-blue-500/10", icon: "code" },
  manual: { label: "Manual entry", color: "border-emerald-500/60 bg-emerald-500/10", icon: "pencil" },
  template: { label: "Template", color: "border-pink-500/60 bg-pink-500/10", icon: "copy" },
  contour: { label: "Contour path", color: "border-teal-500/60 bg-teal-500/10", icon: "filter" },
};
// Contour boards that change the working data (choosing one reads the data after it; other boards give their own data)
const CONTOUR_TRANSFORMS = ["filter", "expression", "edit_columns", "reorder_columns", "sort", "join", "enrich", "set_math", "transform_data", "unpivot", "dedupe", "table", "export"];
const uid = () => Math.random().toString(36).slice(2, 12);
const MODEL_MIME = "application/vnd.bluesandai.model+pickle";

function starter(kind: NodeKind, name: string, inputs: string[]): string {
  if (kind === "python") return `def ${name}(${inputs.join(", ")}):\n    df = ${inputs[0] ?? "pd.DataFrame()"}\n    return df\n`;
  if (kind === "sql") return `SELECT * FROM ${inputs[0] ?? "my_input"} LIMIT 100`;
  if (kind === "r") return `${name} <- function(${inputs.join(", ")}) {
  df <- ${inputs[0] ?? "data.frame()"}
  df
}
`;
  return "";
}

export function PreviewTable({ p, max = 100 }: { p?: Preview; max?: number }) {
  if (!p) return null;
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 bg-panel-2 text-muted">
          <tr>{p.columns.map((c) => <th key={c} className="whitespace-nowrap border-b border-line px-2 py-1" title={p.dtypes?.[c]}>{c}<span className="ml-1 text-[9px] text-muted">{p.dtypes?.[c]}</span></th>)}</tr>
        </thead>
        <tbody>
          {p.rows.slice(0, max).map((r, i) => <tr key={i} className="hover:bg-ocean/5">{p.columns.map((c) => <td key={c} className="max-w-56 truncate border-b border-line px-2 py-1">{r[c] === null || r[c] === undefined ? <span className="text-muted">null</span> : String(r[c])}</td>)}</tr>)}
        </tbody>
      </table>
      <p className="py-1 text-[10px] text-muted">{p.total.toLocaleString()} rows{p.total > p.rows.length ? ` · showing ${p.rows.length}` : ""}</p>
    </div>
  );
}

function Figures({ figures }: { figures?: string[] }) {
  if (!figures?.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {figures.map((f, i) => <img key={i} src={`data:image/png;base64,${f}`} alt={`Figure ${i + 1}`} className="max-h-80 rounded border border-line bg-white" />)}
    </div>
  );
}

export default function CodeWorkbookEditor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [branch, setBranch] = useState("master");
  const [wb, setWb] = useState<Workbook | null>(null);
  const [nodes, setNodes] = useState<WbNode[]>([]);
  const [globalCode, setGlobalCode] = useState("");
  const [templates, setTemplates] = useState<WbTemplate[]>([]);
  // multi-node templates saved in this workbook; `applying` lists every workbook's while choosing one
  const [graphTemplates, setGraphTemplates] = useState<GraphTemplate[]>([]);
  const [applying, setApplying] = useState<GraphTemplate[] | null>(null);
  const [saved, setSaved] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, NodeResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [side, setSide] = useState<"global" | "console" | "templates" | "environment">("console");
  const [tab, setTab] = useState<"output" | "logs" | "figures">("output");
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [pickFolder, setPickFolder] = useState(false);
  const [pickModel, setPickModel] = useState(false);
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [full]);
  const [merge, setMerge] = useState<{ plan: MergePlan; choice: Record<string, "branch" | "target"> } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const apply = useCallback((w: Workbook) => {
    setWb(w);
    setNodes(w.nodes);
    setGlobalCode(w.global_code);
    setTemplates(w.templates);
    setGraphTemplates(w.graph_templates ?? []);
    setSaved(JSON.stringify([w.nodes, w.global_code, w.templates, w.graph_templates ?? []]));
  }, []);
  useEffect(() => {
    codeWorkbooks.get(id, branch).then(apply, (e: Error) => setLoadError(e.message));
  }, [id, branch, apply]);
  useEffect(() => {
    contour.sources().then((s) => setDatasets(s.datasets), () => undefined);
  }, []);

  const dirty = wb ? JSON.stringify([nodes, globalCode, templates, graphTemplates]) !== saved : false;
  const node = nodes.find((n) => n.id === sel) ?? null;
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);
  // Paths view: the nodes on any path from `pathFrom` to the selected node
  const onPath = useMemo(() => {
    if (!pathFrom || !sel || pathFrom === sel) return null;
    const down = new Set<string>([pathFrom]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) {
        if (!down.has(n.id) && n.inputs.some((i) => down.has(i))) {
          down.add(n.id);
          grew = true;
        }
      }
    }
    const up = new Set<string>([sel]);
    const walk = (id: string): void =>
      byId[id]?.inputs.forEach((i) => {
        if (!up.has(i)) {
          up.add(i);
          walk(i);
        }
      });
    walk(sel);
    return new Set([...down].filter((x) => up.has(x)));
  }, [pathFrom, sel, nodes, byId]);
  const draft = { nodes, global_code: globalCode, templates };
  const merged = !!wb?.branches.find((b) => b.name === branch)?.merged_at && branch !== "master";
  const readOnly = !wb?.can_edit || merged;

  if (loadError) return <ApiError message={loadError} />;
  if (!wb) return <Loading />;

  const setNode = (nid: string, p: Partial<WbNode>) => setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, ...p } : n)));
  const freeName = (base: string) => {
    let name = base;
    let k = 2;
    while (nodes.some((n) => n.name === name)) name = `${base}_${k++}`;
    return name;
  };
  const addNode = (kind: NodeKind, inputs: string[] = sel ? [sel] : [], extra: Partial<WbNode> = {}) => {
    const parent = inputs.length ? byId[inputs[0]] : null;
    const name = freeName(extra.name ?? (kind === "manual" ? "manual_entry" : parent ? `${parent.name}_${kind === "sql" ? "query" : "step"}` : kind === "sql" ? "query" : "transform"));
    const n: WbNode = {
      id: uid(),
      name,
      kind,
      inputs,
      x: (parent?.x ?? 40) + (parent ? NODE_W + 60 : 0),
      y: (parent?.y ?? 40) + (parent ? 0 : 110 * nodes.length),
      ...(kind === "python" || kind === "sql" || kind === "r" ? { code: starter(kind, name, inputs.map((i) => byId[i]?.name)) } : {}),
      ...(kind === "manual" ? { manual: { columns: ["column1", "column2"], rows: [["a", 1]] } } : {}),
      ...extra,
    };
    setNodes((ns) => [...ns, n]);
    setSel(n.id);
  };
  /** Copy the node with its upstream nodes (to paste here or into another workbook). */
  const copy = (nid: string) => {
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(copyNodes(nodes, [nid], [...templates, ...wb.suggested_templates], id)));
      setError(null);
      void alertDialog(`Copied ${byId[nid].name} and the nodes upstream of it. Open any workbook and choose Paste nodes.`);
    } catch (e) {
      setError(`Could not copy: ${(e as Error).message}`);
    }
  };
  const paste = () => {
    let clip: Clip | null = null;
    try {
      clip = JSON.parse(localStorage.getItem(CLIP_KEY) ?? "null") as Clip | null;
    } catch {}
    if (!clip?.nodes?.length) return void alertDialog("Nothing copied yet: select a node and choose Copy.");
    const suggested = new Set(wb.suggested_templates.map((t) => t.id));
    const r = pasteNodes(nodes, templates, { ...clip, templates: clip.templates.filter((t) => !suggested.has(t.id)) });
    setNodes(r.nodes);
    setTemplates(r.templates);
    setSel(r.pasted[r.pasted.length - 1] ?? null);
    const renamed = Object.entries(r.renamed);
    if (renamed.length) void alertDialog(`Pasted ${r.pasted.length} nodes. Renamed (references in the pasted code follow): ${renamed.map(([a, b]) => `${a} → ${b}`).join(", ")}.`);
  };
  const saveTemplate = async (nid: string) => {
    const name = await promptDialog("Template name", `${byId[nid].name} template`, { title: "Save this node and its upstream as a template" });
    if (!name) return;
    const clip = copyNodes(nodes, [nid], [...templates, ...wb.suggested_templates], id);
    setGraphTemplates((gs) => [...gs, { id: `gt-${uid()}`, name, nodes: clip.nodes, templates: clip.templates.filter((t) => !wb.suggested_templates.some((x) => x.id === t.id)) }]);
    void alertDialog(`Saved "${name}" (${clip.nodes.length} nodes). Save the workbook to keep it; any workbook can then apply it.`);
  };
  const applyTemplate = (t: GraphTemplate, bind: Record<string, string>) => {
    const r = pasteNodes(nodes, templates, { version: 1, workbook: t.workbook_id ?? id, nodes: t.nodes, templates: t.templates }, { x: 40, y: 40 }, bind);
    setNodes(r.nodes);
    setTemplates(r.templates);
    setSel(r.pasted[r.pasted.length - 1] ?? null);
    setApplying(null);
  };
  const removeNode = (nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid).map((n) => ({ ...n, inputs: n.inputs.filter((i) => i !== nid) })));
    setSel(null);
  };
  const save = async () => {
    setError(null);
    try {
      apply(await codeWorkbooks.save(id, branch, { ...draft, title: wb.title, graph_templates: graphTemplates }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const run = async (only: string[] | null) => {
    setBusy("Running…");
    setError(null);
    try {
      const r = await codeWorkbooks.run(id, branch, only, draft);
      setResults((cur) => ({ ...cur, ...r.nodes }));
      if (r.global_error) setError(`Global code failed:\n${r.global_error}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Code Workbook (Legacy)" icon="graph" href="/code-workbook" crumbs={[{ label: wb.title }]}>
        <select value={branch} onChange={(e) => { setResults({}); setSel(null); setBranch(e.target.value); }} className={`${small} ml-2 w-40`} aria-label="Branch">
          {wb.branches.map((b) => <option key={b.name} value={b.name}>{b.name}{b.merged_at ? " (merged)" : ""}</option>)}
        </select>
        {!readOnly && (
          <button type="button" className={buttonClass.ghost} onClick={async () => {
            const name = await promptDialog("New branch name (from this branch)", "feature");
            if (!name) return;
            try {
              if (dirty) await codeWorkbooks.save(id, branch, draft);
              const w = await codeWorkbooks.branch(id, name, branch);
              apply(w);
              setBranch(name);
            } catch (e) {
              setError((e as Error).message);
            }
          }}><Icon name="split" className="h-3.5 w-3.5" /> Branch</button>
        )}
        {branch !== "master" && !merged && wb.can_edit && (
          <button type="button" className={buttonClass.ghost} onClick={async () => {
            try {
              if (dirty) apply(await codeWorkbooks.save(id, branch, draft));
              const plan = await codeWorkbooks.mergePlan(id, branch);
              setMerge({ plan, choice: {} });
            } catch (e) {
              setError((e as Error).message);
            }
          }}><Icon name="union" className="h-3.5 w-3.5" /> Merge</button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {busy && <span className="text-xs text-muted">{busy}</span>}
          <button type="button" disabled={!!busy} onClick={() => run(null)} className={buttonClass.secondary}><Icon name="play" className="h-3.5 w-3.5" /> Run all</button>
          {!readOnly && (
            <button type="button" disabled={!!busy || dirty} title={dirty ? "Save first" : "Write the Save as dataset nodes to Files"} className={buttonClass.secondary} onClick={async () => {
              setBusy("Building…");
              try {
                const r = await codeWorkbooks.build(id, branch);
                setResults((cur) => ({ ...cur, ...r.nodes }));
                apply(await codeWorkbooks.get(id, branch));
                await alertDialog(`Built ${Object.keys(r.saved ?? {}).length} dataset(s): ${Object.keys(r.saved ?? {}).join(", ")}`);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(null);
              }
            }}><Icon name="bolt" className="h-3.5 w-3.5" /> Build</button>
          )}
          <button type="button" className={buttonClass.ghost} title="Export to a Code Repository (Python transforms)" onClick={async () => {
            const name = await promptDialog("Repository name", `${wb.title} transforms`);
            if (!name) return;
            try {
              const r = await codeWorkbooks.export(id, branch, name);
              router.push(`/code-repositories/${r.repo_id}`);
            } catch (e) {
              setError((e as Error).message);
            }
          }}><Icon name="external" className="h-3.5 w-3.5" /> Export</button>
          {!readOnly && <button type="button" disabled={!dirty} onClick={save} className={buttonClass.primary}><Icon name="save" className="h-3.5 w-3.5" /> {dirty ? "Save" : "Saved"}</button>}
        </div>
      </AppHeader>
      {merged && <p className="border-b border-line bg-sand/10 px-4 py-1.5 text-xs text-sand">This branch was merged: it is read-only. Create a new branch to keep working.</p>}
      {error && <div className="border-b border-line px-4 py-2"><ErrorBox message={error} /></div>}
      <div className="flex min-h-0 flex-1">
        <aside className="w-52 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-xs">
          <p className="px-1 pb-1 font-semibold uppercase tracking-wide text-muted">Contents</p>
          {nodes.map((n) => (
            <button key={n.id} type="button" onClick={() => setSel(n.id)} className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left ${sel === n.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
              <Icon name={KIND_STYLE[n.kind].icon} className="h-3 w-3 shrink-0 text-muted" />
              <span className="truncate font-mono">{n.name}</span>
              {results[n.name]?.error && <span className="ml-auto text-bad">!</span>}
              {n.save && <Icon name="save" className="ml-auto h-3 w-3 text-muted" />}
            </button>
          ))}
          {!readOnly && (
            <div className="mt-3 space-y-1 border-t border-line pt-2">
              <select value="" onChange={(e) => { const d = datasets.find((x) => x.id === e.target.value); if (d) addNode("input", [], { dataset_id: d.id, name: freeName(d.name.replace(/\.parquet$/, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "d_$1").slice(0, 60) || "dataset") }); }} className={small}>
                <option value="">+ Import dataset…</option>
                {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button type="button" onClick={() => addNode("python")} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ Python transform{sel ? " (from selected)" : ""}</button>
              <button type="button" onClick={() => addNode("sql")} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ SQL transform{sel ? " (from selected)" : ""}</button>
              <button type="button" onClick={() => addNode("r")} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ R transform{sel ? " (from selected)" : ""}</button>
              <button type="button" onClick={() => addNode("manual", [])} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ Manual entry</button>
              <button type="button" onClick={paste} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ Paste nodes</button>
              <button type="button" onClick={() => addNode("contour", [], { name: freeName("contour_path"), contour: {} })} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ Contour path</button>
              <button type="button" onClick={() => setPickFolder(true)} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ Import folder of files</button>
              <button type="button" onClick={() => setPickModel(true)} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ Import saved model</button>
              {pickModel && (
                <DrivePicker
                  title="Import a model saved by a Code Workbook"
                  canPick={(it) => (it.content_type === MODEL_MIME ? null : "not a saved model (.model.pkl from Save as dataset on a model node)")}
                  onPick={(it) => {
                    setPickModel(false);
                    addNode("input", [], { dataset_id: it.id, name: freeName(it.name.replace(/\.model\.pkl$/, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "m_$1").replace(/^_+|_+$/g, "").slice(0, 60) || "model") });
                  }}
                  onClose={() => setPickModel(false)}
                />
              )}
              <button
                type="button"
                onClick={() => codeWorkbooks.graphTemplates().then((l) => setApplying([...graphTemplates.filter((g) => !l.some((x) => x.id === g.id)), ...l]), (e: Error) => setError(e.message))}
                className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2"
              >
                + From multi-node template
              </button>
              {applying && <ApplyTemplate list={applying} nodes={nodes} onApply={applyTemplate} onClose={() => setApplying(null)} />}
              {pickFolder && (
                <DrivePicker
                  title="Import a folder of unstructured files"
                  canPick={() => "choose a folder: Python nodes read its files"}
                  folder={{
                    action: "Import this folder",
                    onPick: (fd) => {
                      setPickFolder(false);
                      if (fd.id) addNode("input", [], { folder_id: fd.id, folder_name: fd.name, name: freeName(fd.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "f_$1").replace(/^_+|_+$/g, "").slice(0, 60) || "files") });
                    },
                  }}
                  onClose={() => setPickFolder(false)}
                />
              )}
              <button type="button" onClick={() => { const t = [...templates, ...wb.suggested_templates][0]; if (t) addNode("template", sel ? [sel] : [], { template: { id: t.id, values: {} }, name: freeName(t.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")) }); }} className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2">+ From template{sel ? " (from selected)" : ""}</button>
            </div>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {pathFrom && (
            <div className="flex items-center gap-2 border-b border-line bg-ocean/10 px-3 py-1 text-xs">
              <Icon name="graph" className="h-3.5 w-3.5 text-ocean" />
              Paths from <span className="font-mono">{byId[pathFrom]?.name}</span>
              {!sel || sel === pathFrom ? " — select the node to trace to" : onPath && onPath.size ? ` to ${byId[sel]?.name}: ${onPath.size} nodes` : ` — no path to ${byId[sel]?.name}`}
              <button type="button" onClick={() => setPathFrom(null)} className="ml-auto text-muted hover:text-white">Close paths</button>
            </div>
          )}
          {/* Graph */}
          <div
            className="dot-grid relative min-h-[260px] flex-1 overflow-auto"
            onMouseMove={(e) => {
              const d = drag.current;
              if (!d || readOnly) return;
              const box = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              setNode(d.id, { x: Math.max(0, e.clientX - box.left - d.dx + e.currentTarget.scrollLeft), y: Math.max(0, e.clientY - box.top - d.dy + e.currentTarget.scrollTop) });
            }}
            onMouseUp={() => (drag.current = null)}
            onMouseLeave={() => (drag.current = null)}
            onClick={() => setSel(null)}
          >
            <svg className="pointer-events-none absolute left-0 top-0" width={Math.max(1200, ...nodes.map((n) => (n.x ?? 0) + NODE_W + 80))} height={Math.max(500, ...nodes.map((n) => (n.y ?? 0) + 120))}>
              {nodes.flatMap((n) => n.inputs.map((i) => {
                const a = byId[i];
                if (!a) return null;
                const x1 = (a.x ?? 0) + NODE_W, y1 = (a.y ?? 0) + 28, x2 = n.x ?? 0, y2 = (n.y ?? 0) + 28;
                const lit = onPath?.has(i) && onPath.has(n.id);
                return <path key={`${i}-${n.id}`} d={`M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`} className={`fill-none ${lit ? "stroke-ocean" : "stroke-line-2"}`} strokeWidth={lit ? 2.5 : 1.5} opacity={onPath && !lit ? 0.35 : 1} />;
              }))}
            </svg>
            {nodes.map((n) => {
              const r = results[n.name];
              return (
                <div
                  key={n.id}
                  onMouseDown={(e) => { const b = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); drag.current = { id: n.id, dx: e.clientX - b.left, dy: e.clientY - b.top }; }}
                  onClick={(e) => { e.stopPropagation(); setSel(n.id); }}
                  className={`absolute cursor-pointer select-none rounded-lg border-2 px-2 py-1.5 text-xs shadow ${KIND_STYLE[n.kind].color} ${sel === n.id || pathFrom === n.id ? "ring-2 ring-ocean" : ""}`}
                  style={{ left: n.x ?? 0, top: n.y ?? 0, width: NODE_W, opacity: onPath && !onPath.has(n.id) ? 0.35 : 1 }}
                >
                  <div className="flex items-center gap-1"><Icon name={KIND_STYLE[n.kind].icon} className="h-3 w-3" /><span className="truncate font-mono font-semibold">{n.name}</span></div>
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
                    {KIND_STYLE[n.kind].label}
                    {n.save && <span>· saved{n.built_at ? " ✓" : ""}</span>}
                    {r?.error ? <span className="ml-auto text-bad">error</span> : r?.total !== undefined ? <span className="ml-auto">{r.total.toLocaleString()} rows</span> : null}
                  </div>
                </div>
              );
            })}
            {!nodes.length && <p className="absolute inset-0 grid place-items-center text-sm text-muted">Import a dataset to start.</p>}
          </div>

          {/* Logic panel */}
          {node && (
            <div className={full ? "fixed inset-0 z-40 flex bg-panel" : "flex h-[46%] min-h-[260px] shrink-0 border-t border-line bg-panel"}>
              <div className="flex w-1/2 min-w-0 flex-col border-r border-line">
                <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5 text-xs">
                  <input value={node.name} disabled={readOnly} onChange={(e) => /^[A-Za-z0-9_]*$/.test(e.target.value) && setNode(node.id, { name: e.target.value })} className={`${small} w-40 font-mono`} aria-label="Alias" />
                  <span className="text-muted">{KIND_STYLE[node.kind].label}</span>
                  {node.kind !== "input" && (
                    <select multiple value={node.inputs} disabled={readOnly} onChange={(e) => setNode(node.id, { inputs: [...e.target.selectedOptions].map((o) => o.value) })} className={`${small} h-14 w-40`} aria-label="Inputs" title="Inputs (Ctrl+click for several)">
                      {nodes.filter((x) => x.id !== node.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  )}
                  {node.kind === "python" &&
                    node.inputs.filter((i) => !!byId[i]).map((i) => (
                      <select key={i} value={node.input_types?.[i] ?? "pandas"} disabled={readOnly} onChange={(e) => setNode(node.id, { input_types: { ...(node.input_types ?? {}), [i]: e.target.value as "pandas" } })} className={small} aria-label={`${byId[i]?.name} as`} title="How this input arrives in the function">
                        <option value="pandas">{byId[i]?.name}: pandas</option>
                        <option value="spark">{byId[i]?.name}: Spark</option>
                      </select>
                    ))}
                  {node.kind === "r" &&
                    node.inputs.filter((i) => !!byId[i]).map((i) => (
                      <select key={i} value={node.input_types?.[i] ?? "pandas"} disabled={readOnly} onChange={(e) => setNode(node.id, { input_types: { ...(node.input_types ?? {}), [i]: e.target.value as "pandas" } })} className={small} aria-label={`${byId[i]?.name} as`} title="How this input arrives in the function: an R data.frame, or a SparkR DataFrame (needs the SparkR package in the platform's R; Environment says whether it is installed)">
                        <option value="pandas">{byId[i]?.name}: R data.frame</option>
                        <option value="spark">{byId[i]?.name}: Spark (SparkR)</option>
                      </select>
                    ))}
                  {node.kind !== "input" && <label className="flex items-center gap-1"><input type="checkbox" checked={!!node.save} disabled={readOnly} onChange={(e) => setNode(node.id, { save: e.target.checked })} />Save as dataset</label>}
                  <button type="button" disabled={!!busy} onClick={() => run([node.id])} className={buttonClass.secondary}><Icon name="play" className="h-3 w-3" /> Run</button>
                  {node.dataset_out && <Link href={`/datasets/${node.dataset_out}`} className="text-ocean hover:underline">dataset</Link>}
                  <button type="button" onClick={() => copy(node.id)} className={buttonClass.ghost} title="Copy this node and its upstream nodes"><Icon name="copy" className="h-3 w-3" /> Copy</button>
                  {node.kind !== "input" && node.kind !== "contour" && (
                    <button
                      type="button"
                      onClick={() => copyForNotepad("code_workbook_chart", { workbook_id: id, node_id: node.id, branch }, `${node.name} (Code Workbook)`) && void alertDialog(dirty ? "Copied. Save the workbook first: Notepad runs the saved node." : "Copied: in a Notepad document, Insert → Paste copied widget.")}
                      className={buttonClass.ghost}
                      title="Copy for Notepad (the node's figures or table)"
                    >
                      For Notepad
                    </button>
                  )}
                  {!readOnly && <button type="button" onClick={() => void saveTemplate(node.id)} className={buttonClass.ghost} title="Save this node and its upstream as a multi-node template">Save as template</button>}
                  <button type="button" onClick={() => setPathFrom(pathFrom === node.id ? null : node.id)} className={buttonClass.ghost} title="Paths view: then select another node to see every path between them">Paths from here</button>
                  <button type="button" onClick={() => setFull(!full)} className={buttonClass.ghost} title={full ? "Exit full screen (Esc)" : "Full-screen editor"}>{full ? "Exit full screen" : "Full screen"}</button>
                  {!readOnly && <button type="button" onClick={() => removeNode(node.id)} className="ml-auto text-muted hover:text-bad" aria-label="Delete node"><Icon name="trash" className="h-3.5 w-3.5" /></button>}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {(node.kind === "python" || node.kind === "sql" || node.kind === "r") && <CodeEditor value={node.code ?? ""} onChange={(v) => setNode(node.id, { code: v })} path={node.kind === "python" ? `${node.name}.py` : node.kind === "r" ? `${node.name}.R` : `${node.name}.sql`} readOnly={readOnly} />}
                  {node.kind === "input" && node.folder_id && (
                    <div className="space-y-2 p-3 text-xs">
                      <div>Folder: <Link href={`/files/${node.folder_id}`} className="text-ocean hover:underline">{node.folder_name ?? node.folder_id}</Link></div>
                      <p className="text-muted">
                        Python nodes receive <code>{node.name}</code>, a read-only file system: <code>{node.name}.ls(&quot;**/*.pdf&quot;)</code>, <code>{node.name}.open(&quot;path/in/folder&quot;)</code> (binary; <code>&quot;r&quot;</code> for text) and <code>{node.name}.path(…)</code> for libraries that want a file name. Subfolders are included (500 files, 200 MB).
                      </p>
                      {results[node.name]?.files && <pre className="max-h-48 overflow-auto rounded bg-panel-2 p-2 text-[11px]">{results[node.name].files!.join("\n")}</pre>}
                    </div>
                  )}
                  {node.kind === "input" && !node.folder_id && (
                    <div className="space-y-2 p-3 text-xs">
                      <select value={node.dataset_id ?? ""} disabled={readOnly} onChange={(e) => setNode(node.id, { dataset_id: e.target.value })} className={small}>
                        {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      <DatasetBranch datasetId={node.dataset_id} value={node.dataset_branch} readOnly={readOnly} workbookBranch={branch} read={results[node.name]?.dataset_branch} onChange={(v) => setNode(node.id, { dataset_branch: v })} />
                      <p className="text-muted">Python nodes receive it as a pandas DataFrame named <code>{node.name}</code>; SQL nodes read the table <code>{node.name}</code>.</p>
                    </div>
                  )}
                  {node.kind === "contour" && <ContourNodeForm value={node.contour ?? {}} readOnly={readOnly} result={results[node.name]} onChange={(v) => setNode(node.id, { contour: v })} />}
                  {node.kind === "manual" && (
                    <div className="space-y-1 p-3 text-xs">
                      <input value={(node.manual?.columns ?? []).join(", ")} disabled={readOnly} onChange={(e) => setNode(node.id, { manual: { columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean), rows: node.manual?.rows ?? [] } })} className={small} placeholder="columns" />
                      <textarea rows={8} disabled={readOnly} value={(node.manual?.rows ?? []).map((r) => r.join(", ")).join("\n")} onChange={(e) => setNode(node.id, { manual: { columns: node.manual?.columns ?? [], rows: e.target.value.split("\n").filter((l) => l.trim()).map((l) => l.split(",").map((s) => { const t = s.trim(); return t !== "" && !Number.isNaN(Number(t)) ? Number(t) : t; })) } })} className={`${small} font-mono`} placeholder="one row per line" />
                    </div>
                  )}
                  {node.kind === "template" && <TemplateForm node={node} nodes={nodes} templates={[...templates, ...wb.suggested_templates]} readOnly={readOnly} onChange={(t) => setNode(node.id, { template: t })} columns={(node.inputs.map((i) => results[byId[i]?.name]?.columns ?? []).flat())} />}
                </div>
              </div>
              <div className="flex w-1/2 min-w-0 flex-col">
                <div className="flex gap-1 border-b border-line px-2 text-xs">
                  {(["output", "logs", "figures"] as const).map((t) => <button key={t} type="button" onClick={() => setTab(t)} className={`border-b-2 px-2 py-1.5 capitalize ${tab === t ? "border-ocean text-white" : "border-transparent text-muted"}`}>{t}{t === "figures" && results[node.name]?.figures?.length ? ` (${results[node.name]?.figures?.length})` : ""}</button>)}
                  {results[node.name]?.ms !== undefined && <span className="ml-auto self-center text-[10px] text-muted">{results[node.name]?.ms} ms</span>}
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
                  {!results[node.name] && <p className="text-muted">Run the node to see its output.</p>}
                  {results[node.name]?.error && <pre className="mb-2 whitespace-pre-wrap rounded bg-bad/10 p-2 text-[11px] text-bad">{results[node.name]?.error}{"\n\n"}{results[node.name]?.traceback}</pre>}
                  {tab === "output" && results[node.name]?.columns && <PreviewTable p={results[node.name] as Preview} />}
                  {tab === "output" && results[node.name]?.input && <p className="text-muted">{results[node.name]?.model ? "Saved model" : "Dataset"} {results[node.name]?.dataset}</p>}
                  {tab === "output" && results[node.name]?.model && <ModelOutput m={results[node.name]!.model!} saved={node.dataset_out} />}
                  {tab === "logs" && <pre className="whitespace-pre-wrap font-mono text-[11px]">{results[node.name]?.logs || "No output printed."}</pre>}
                  {tab === "figures" && (results[node.name]?.figures?.length ? <Figures figures={results[node.name]?.figures} /> : <p className="text-muted">Plots drawn with matplotlib appear here.</p>)}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex border-b border-line text-xs">
            {(["console", "global", "templates", "environment"] as const).map((t) => <button key={t} type="button" onClick={() => setSide(t)} className={`flex-1 border-b-2 px-1 py-2 capitalize ${side === t ? "border-ocean text-white" : "border-transparent text-muted"}`}>{t === "global" ? "Global code" : t}</button>)}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {side === "global" && (
              <div className="flex h-full flex-col">
                <p className="p-2 text-[11px] text-muted">Python run before every Python node: imports, helper functions and constants they share.</p>
                <div className="min-h-0 flex-1"><CodeEditor value={globalCode} onChange={setGlobalCode} path="global.py" readOnly={readOnly} /></div>
              </div>
            )}
            {side === "console" && <Console wb={wb} id={id} branch={branch} draft={draft} sel={sel} onAddNode={(language, code) => addNode(language, sel ? [sel] : [], { code: language === "python" ? `def ${freeName("console_result")}(${sel ? byId[sel].name : ""}):\n${code.split("\n").map((l, i, a) => (i === a.length - 1 ? `    return ${l}` : `    ${l}`)).join("\n")}\n` : code, name: freeName("console_result") })} />}
            {side === "templates" && <Templates templates={templates} onChange={setTemplates} readOnly={readOnly} suggested={wb.suggested_templates} />}
            {side === "environment" && <Environment id={id} readOnly={!wb?.can_edit} />}
          </div>
        </aside>
      </div>

      {merge && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-lg space-y-3 rounded-xl border border-line bg-panel p-5 text-sm shadow-2xl">
            <h2 className="text-lg font-semibold">Merge {branch} into {merge.plan.target}</h2>
            <p className="text-xs text-muted">Nodes changed only on {branch} come in; nodes changed only on {merge.plan.target} stay. {merge.plan.conflicts.length ? "These changed on both sides — choose a version:" : "No conflicts."}</p>
            {merge.plan.conflicts.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-xs">
                <span className="w-40 truncate font-mono">{c.name}</span>
                {(["branch", "target"] as const).map((s) => <label key={s} className="flex items-center gap-1"><input type="radio" name={c.id} checked={merge.choice[c.id] === s} onChange={() => setMerge({ ...merge, choice: { ...merge.choice, [c.id]: s } })} />{s === "branch" ? `${branch} (${c.branch})` : `${merge.plan.target} (${c.target})`}</label>)}
              </div>
            ))}
            {merge.plan.global_conflict && (
              <div className="flex items-center gap-2 text-xs"><span className="w-40">Global code</span>{(["branch", "target"] as const).map((s) => <label key={s} className="flex items-center gap-1"><input type="radio" name="__global__" checked={merge.choice.__global__ === s} onChange={() => setMerge({ ...merge, choice: { ...merge.choice, __global__: s } })} />{s === "branch" ? branch : merge.plan.target}</label>)}</div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonClass.ghost} onClick={() => setMerge(null)}>Cancel</button>
              <button type="button" className={buttonClass.primary} disabled={merge.plan.conflicts.some((c) => !merge.choice[c.id]) || (merge.plan.global_conflict && !merge.choice.__global__)} onClick={async () => {
                try {
                  const w = await codeWorkbooks.merge(id, branch, merge.choice);
                  setMerge(null);
                  setResults({});
                  apply(w);
                  setBranch(w.branch);
                } catch (e) {
                  setError((e as Error).message);
                  setMerge(null);
                }
              }}>Merge</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateForm({ node, nodes, templates, readOnly, onChange, columns }: { node: WbNode; nodes: WbNode[]; templates: WbTemplate[]; readOnly: boolean; onChange: (t: WbNode["template"]) => void; columns: string[] }) {
  const t = templates.find((x) => x.id === node.template?.id);
  const values = node.template?.values ?? {};
  return (
    <div className="space-y-2 p-3 text-xs">
      <select value={node.template?.id ?? ""} disabled={readOnly} onChange={(e) => onChange({ id: e.target.value, values: {} })} className={small}>
        {templates.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.language})</option>)}
      </select>
      {t?.description && <p className="text-muted">{t.description}</p>}
      {t?.params.map((p) => (
        <label key={p.name} className="block">{p.name}
          {p.type === "input" ? (
            <select value={values[p.name] ?? ""} disabled={readOnly} onChange={(e) => onChange({ id: t.id, values: { ...values, [p.name]: e.target.value } })} className={small}>
              <option value="">Node…</option>
              {nodes.filter((x) => x.id !== node.id && node.inputs.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          ) : p.type === "column" && columns.length ? (
            <select value={values[p.name] ?? ""} disabled={readOnly} onChange={(e) => onChange({ id: t.id, values: { ...values, [p.name]: e.target.value } })} className={small}>
              <option value="">Column…</option>
              {[...new Set(columns)].map((c) => <option key={c}>{c}</option>)}
            </select>
          ) : (
            <input value={values[p.name] ?? p.default ?? ""} disabled={readOnly} onChange={(e) => onChange({ id: t.id, values: { ...values, [p.name]: e.target.value } })} className={small} />
          )}
        </label>
      ))}
      <p className="text-[10px] text-muted">Input parameters list the node&apos;s inputs; run the inputs once to pick columns from a list.</p>
    </div>
  );
}

/** Choose a multi-node template and bind each of its imported datasets to a node here (or import it as saved). */
function ApplyTemplate({ list, nodes, onApply, onClose }: { list: GraphTemplate[]; nodes: WbNode[]; onApply: (t: GraphTemplate, bind: Record<string, string>) => void; onClose: () => void }) {
  const [tid, setTid] = useState(list[0]?.id ?? "");
  const [bind, setBind] = useState<Record<string, string>>({});
  const t = list.find((x) => x.id === tid);
  const inputs = (t?.nodes ?? []).filter((n) => n.kind === "input");
  return (
    <div className="space-y-2 rounded border border-line bg-panel-2 p-2 text-xs">
      {!list.length && <p className="text-muted">No multi-node templates yet: select a node and choose Save as template.</p>}
      {list.length > 0 && (
        <select value={tid} onChange={(e) => { setTid(e.target.value); setBind({}); }} className={small}>
          {list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.workbook ? ` — ${x.workbook}` : ""} ({x.nodes.length} nodes)</option>)}
        </select>
      )}
      {t?.description && <p className="text-muted">{t.description}</p>}
      {inputs.map((n) => (
        <label key={n.id} className="block">
          <span className="font-mono">{n.name}</span>
          <select value={bind[n.id] ?? ""} onChange={(e) => setBind({ ...bind, [n.id]: e.target.value })} className={small}>
            <option value="">Import as in the template</option>
            {nodes.map((x) => <option key={x.id} value={x.id}>Use {x.name}</option>)}
          </select>
        </label>
      ))}
      <div className="flex gap-2">
        <button type="button" disabled={!t} onClick={() => t && onApply(t, Object.fromEntries(Object.entries(bind).filter(([, v]) => v)))} className={buttonClass.primary}>Add nodes</button>
        <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
      </div>
    </div>
  );
}

/** A Contour node: the analysis, path, optional board and parameter values. */
function ContourNodeForm({ value, readOnly, result, onChange }: { value: NonNullable<WbNode["contour"]>; readOnly: boolean; result?: NodeResult; onChange: (v: NonNullable<WbNode["contour"]>) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [a, setA] = useState<Analysis | null>(null);
  useEffect(() => {
    contour.list().then((l) => setList(l.map((x) => ({ id: x.id, name: x.name.replace(/\.contour$/, "") }))), () => setList([]));
  }, []);
  useEffect(() => {
    if (!value.analysis_id) return;
    contour.get(value.analysis_id).then((v) => setA(v.analysis), () => setA(null));
  }, [value.analysis_id]);
  const path = a?.paths.find((p) => p.id === value.path_id);
  return (
    <div className="space-y-2 p-3 text-xs">
      <select value={value.analysis_id ?? ""} disabled={readOnly} onChange={(e) => onChange({ analysis_id: e.target.value || undefined })} className={small}>
        <option value="">Contour analysis…</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      {a && (
        <select value={value.path_id ?? ""} disabled={readOnly} onChange={(e) => onChange({ ...value, path_id: e.target.value || undefined, board_id: undefined })} className={small}>
          <option value="">Path…</option>
          {a.paths.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {path && (
        <select value={value.board_id ?? ""} disabled={readOnly} onChange={(e) => onChange({ ...value, board_id: e.target.value || undefined })} className={small}>
          <option value="">The path&apos;s result (after every board)</option>
          {path.boards.map((b, i) => (
            <option key={b.id} value={b.id}>
              {CONTOUR_TRANSFORMS.includes(b.type) ? `Data after board ${i + 1}: ${b.title || b.type}` : `Board ${i + 1}'s data: ${b.title || b.type}`}
            </option>
          ))}
        </select>
      )}
      {(a?.parameters ?? []).map((p) => (
        <label key={p.name} className="flex items-center gap-2">
          <span className="w-28 truncate font-mono">${p.name}</span>
          <input
            value={value.params?.[p.name] ?? ""}
            disabled={readOnly}
            placeholder={p.default === undefined || p.default === null || p.default === "" ? "default" : `default: ${String(p.default)}`}
            onChange={(e) => onChange({ ...value, params: { ...value.params, [p.name]: e.target.value } })}
            className={small}
          />
        </label>
      ))}
      <p className="text-muted">Nodes downstream read it like an imported dataset; it is computed again on each run. Exporting to a repository needs the path saved as a dataset in Contour.</p>
      {result?.total !== undefined && <p className="text-muted">{result.total.toLocaleString()} rows · {(result.columns ?? []).join(", ")}</p>}
    </div>
  );
}

/** A model output: what it is, its parameters and features; downstream Python nodes receive the object. */
function ModelOutput({ m, saved }: { m: NonNullable<NodeResult["model"]>; saved?: string }) {
  return (
    <div className="space-y-2 text-xs">
      <div><span className="text-muted">Model</span> <span className="font-mono">{m.type}</span></div>
      {m.feature_names_in && <div><span className="text-muted">Features</span> {m.feature_names_in.join(", ")}</div>}
      {m.classes && <div><span className="text-muted">Classes</span> {m.classes.join(", ")}</div>}
      {m.params && (
        <table className="text-[11px]"><tbody>{Object.entries(m.params).map(([k, v]) => <tr key={k}><td className="pr-3 text-muted">{k}</td><td className="font-mono">{v}</td></tr>)}</tbody></table>
      )}
      <p className="text-muted">Downstream Python nodes receive the model object. {saved ? "Saved in Files (a pickle other workbooks import)." : "Save as dataset + Build keeps it in Files."}</p>
    </div>
  );
}

/** The imported dataset's branch: a fixed one, or the workbook's branch when the dataset has it (else master). */
function DatasetBranch({ datasetId, value, readOnly, workbookBranch, read, onChange }: { datasetId?: string; value?: string; readOnly: boolean; workbookBranch: string; read?: string; onChange: (v: string | undefined) => void }) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!datasetId) return;
    datasetPreview.summary(datasetId).then((d) => setNames(d.branches.map((b) => b.branch)), () => setNames([]));
  }, [datasetId]);
  return (
    <div className="space-y-1">
      <select value={value ?? ""} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)} className={small} aria-label="Dataset branch">
        <option value="">Dataset branch: the workbook&apos;s ({workbookBranch}), else master</option>
        {[...new Set(["master", ...names, ...(value ? [value] : [])])].map((b) => <option key={b} value={b}>Dataset branch: {b}</option>)}
      </select>
      {read && <p className="text-[11px] text-muted">Last run read the {read} branch.</p>}
    </div>
  );
}

function Console({ id, branch, draft, sel, onAddNode }: { wb: Workbook; id: string; branch: string; draft: { nodes: WbNode[]; global_code: string; templates?: WbTemplate[] }; sel: string | null; onAddNode: (language: "python" | "sql", code: string) => void }) {
  const [language, setLanguage] = useState<"python" | "sql">("python");
  const [code, setCode] = useState("");
  const [log, setLog] = useState<{ language: string; code: string; out: ConsoleResult }[]>([]);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const run = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const out = await codeWorkbooks.console(id, branch, language, code, sel ? [sel] : null, draft);
      setLog((l) => [...l, { language, code, out }]);
      setNames(out.names ?? []);
    } catch (e) {
      setLog((l) => [...l, { language, code, out: { error: (e as Error).message } }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <p className="text-[11px] text-muted">Every node {sel ? "up to the selected one" : "in the workbook"} is available by its alias. The console keeps a session: names you define stay defined, and nodes are recomputed only when the graph or its datasets change (idle sessions stop after 20 minutes). A DataFrame result can become a node.</p>
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted">
          <span>Session:</span>
          {names.length ? names.map((n) => <code key={n} className="rounded bg-panel-2 px-1">{n}</code>) : <span>no names defined yet</span>}
          <button type="button" onClick={() => codeWorkbooks.restartSession(id, branch).then(() => { setNames([]); setLog((l) => [...l, { language: "python", code: "# session restarted", out: { value: "Session restarted: earlier names are gone." } }]); }, () => undefined)} className="ml-auto text-ocean hover:underline">Restart session</button>
        </div>
        {log.map((x, i) => (
          <div key={i} className="rounded border border-line p-1.5">
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-sky-300">{x.language === "sql" ? "sql> " : ">>> "}{x.code}</pre>
            {x.out.logs && <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted">{x.out.logs}</pre>}
            {x.out.value && <pre className="whitespace-pre-wrap font-mono text-[11px]">{x.out.value}</pre>}
            {x.out.error && <pre className="whitespace-pre-wrap text-[11px] text-bad">{x.out.error}</pre>}
            {x.out.table && <><PreviewTable p={x.out.table} max={20} /><button type="button" onClick={() => onAddNode(x.language as "python" | "sql", x.code)} className="text-ocean hover:underline">+ Add to graph</button></>}
            <Figures figures={x.out.figures} />
          </div>
        ))}
      </div>
      <div className="border-t border-line p-2">
        <div className="mb-1 flex gap-1">
          {(["python", "sql"] as const).map((l) => <button key={l} type="button" onClick={() => setLanguage(l)} className={`rounded px-2 py-0.5 ${language === l ? "bg-ocean/15 text-ocean" : "text-muted"}`}>{l === "python" ? "Python" : "SQL"}</button>)}
          <span className="ml-auto text-[10px] text-muted">Ctrl+Enter runs</span>
        </div>
        <textarea rows={4} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void run(); } }} placeholder={language === "python" ? "my_dataset.describe()" : "SELECT COUNT(*) FROM my_dataset"} className={`${small} font-mono`} />
        <button type="button" disabled={busy} onClick={run} className={`${buttonClass.secondary} mt-1`}><Icon name="play" className="h-3 w-3" /> {busy ? "Running…" : "Run"}</button>
      </div>
    </div>
  );
}

function Templates({ templates, onChange, readOnly, suggested }: { templates: WbTemplate[]; onChange: (t: WbTemplate[]) => void; readOnly: boolean; suggested: WbTemplate[] }) {
  const set = (i: number, p: Partial<WbTemplate>) => onChange(templates.map((t, j) => (j === i ? { ...t, ...p } : t)));
  return (
    <div className="space-y-2 p-2 text-xs">
      <p className="text-[11px] text-muted">Templates turn code into a form: write {"{{param}}"} in the code; a template node fills the values in. Input parameters name nodes; in Python, {"{{__name__}}"} is the node&apos;s name.</p>
      {templates.map((t, i) => (
        <div key={t.id} className="space-y-1 rounded border border-line p-2">
          <div className="flex gap-1">
            <input value={t.name} disabled={readOnly} onChange={(e) => set(i, { name: e.target.value })} className={small} />
            <select value={t.language} disabled={readOnly} onChange={(e) => set(i, { language: e.target.value as "python" | "sql" })} className={`${small} w-24`}><option value="sql">SQL</option><option value="python">Python</option></select>
            {!readOnly && <button type="button" onClick={() => onChange(templates.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Delete template"><Icon name="x" className="h-3.5 w-3.5" /></button>}
          </div>
          <input value={t.params.map((p) => `${p.name}:${p.type}`).join(", ")} disabled={readOnly} onChange={(e) => set(i, { params: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [name, type] = s.split(":"); return { name: name.trim(), type: (["input", "column", "string", "number"].includes((type ?? "").trim()) ? type.trim() : "string") as WbTemplate["params"][number]["type"] }; }) })} placeholder="dataset:input, column:column, value:string" className={`${small} font-mono`} />
          <textarea rows={4} value={t.code} disabled={readOnly} onChange={(e) => set(i, { code: e.target.value })} className={`${small} font-mono`} />
        </div>
      ))}
      {!readOnly && <button type="button" onClick={() => onChange([...templates, { id: `tpl-${Math.random().toString(36).slice(2, 8)}`, name: "My template", language: "sql", params: [{ name: "dataset", type: "input" }], code: "SELECT * FROM {{dataset}}" }])} className="text-ocean hover:underline">+ New template</button>}
      <p className="pt-2 font-semibold uppercase tracking-wide text-muted">Suggested</p>
      {suggested.map((t) => <p key={t.id}><b>{t.name}</b> <span className="text-muted">({t.language}) — {t.description}</span></p>)}
    </div>
  );
}

function Environment({ id, readOnly }: { id: string; readOnly: boolean }) {
  const [env, setEnv] = useState<WbEnvironment | null>(null);
  // session history reloads when the Spark environment changes (the sessions were restarted)
  const [version, setVersion] = useState(0);
  useEffect(() => {
    codeWorkbooks.environment(id).then(setEnv, () => undefined);
  }, [id]);
  if (!env) return <p className="p-2 text-xs text-muted">Loading…</p>;
  return (
    <div className="space-y-1 p-2 text-xs">
      <p>Python {env.python}{env.r ? ` · R ${env.r}` : ""} · timeout {env.timeout_s}s</p>
      <p className="text-muted">{env.notes}</p>
      <SparkEnvironment id={id} env={env} readOnly={readOnly} onSaved={(e) => { setEnv(e); setVersion((v) => v + 1); }} />
      <table className="mt-2 w-full text-[11px]"><tbody>{env.packages.map((p) => <tr key={p.name}><td className="py-0.5">{p.name}</td><td className="text-right text-muted">{p.version}</td></tr>)}</tbody></table>
      <SessionHistory key={version} id={id} />
    </div>
  );
}

const SETTING_LABEL: Record<string, string> = { driver_memory_mb: "driver memory (MB)", executor_memory_mb: "executor memory (MB)", executor_cores: "executor cores", driver_cores: "driver cores",
  executors: "executors", shuffle_partitions: "shuffle partitions", offheap_fraction: "off-heap fraction", cross_join: "cross joins", broadcast_disabled: "broadcast joins off", adaptive: "adaptive execution" };
const settingText = (sets: Record<string, unknown>) => Object.entries(sets).map(([k, v]) => `${SETTING_LABEL[k] ?? k}: ${String(v)}`).join(" · ");

/** Spark environment: the workbook's Spark profiles (the names Python transforms use). The API refuses unknown or
 *  contradicting profiles with the reason; a change restarts the workbook's console sessions. Also says whether R has SparkR. */
function SparkEnvironment({ id, env, readOnly, onSaved }: { id: string; env: WbEnvironment; readOnly: boolean; onSaved: (e: WbEnvironment) => void }) {
  const [profiles, setProfiles] = useState<string[]>(env.spark_profiles);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dirty = profiles.join("\n") !== env.spark_profiles.join("\n");
  const sets = (name: string) => settingText(env.available_profiles.find((p) => p.name === name)?.sets ?? {});
  const save = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await codeWorkbooks.setEnvironment(id, profiles);
      setProfiles(r.spark_profiles);
      setNote(r.changed ? (r.sessions_restarted ? `Updated: ${r.sessions_restarted} running session${r.sessions_restarted === 1 ? " was" : "s were"} restarted.` : "Updated: the next Spark session starts with these profiles.") : "No change.");
      onSaved(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-1 border-t border-line pt-2">
      <div className="font-semibold">Spark environment</div>
      <p className="text-[11px] text-muted">Spark profiles size the Spark session of Python nodes with Spark inputs (driver memory, cores, shuffle partitions, adaptive execution, cross joins). Changing them restarts the console session.</p>
      {profiles.length === 0 && <p className="text-[11px] text-muted">No profiles: the default session (2 cores, 2048 MB driver, 4 shuffle partitions).</p>}
      {profiles.map((p) => (
        <div key={p} className="flex items-center gap-1 text-[11px]">
          <span className="rounded bg-ocean/15 px-1 font-mono text-ocean">{p}</span>
          <span className="flex-1 truncate text-muted" title={sets(p)}>{sets(p)}</span>
          {!readOnly && <button type="button" onClick={() => setProfiles(profiles.filter((x) => x !== p))} className="text-muted hover:text-white" aria-label={`Remove ${p}`}>×</button>}
        </div>
      ))}
      {!readOnly && (
        <div className="flex items-center gap-1">
          <select value="" onChange={(e) => e.target.value && setProfiles([...profiles, e.target.value])} className={`${small} min-w-0 flex-1`} aria-label="Add a Spark profile">
            <option value="">+ Add a Spark profile…</option>
            {env.available_profiles.filter((p) => !profiles.includes(p.name)).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button type="button" disabled={busy || !dirty} onClick={save} className={buttonClass.secondary}>Update Spark environment</button>
        </div>
      )}
      {env.spark_profiles_problem && !dirty && <p className="text-bad">{env.spark_profiles_problem}</p>}
      {!dirty && Object.keys(env.spark_settings).length > 0 && <p className="text-[11px] text-muted">Resolved: {settingText(env.spark_settings)}</p>}
      {err && <p className="text-bad">{err}</p>}
      {note && <p className="text-[11px] text-muted">{note}</p>}
      <p className={`text-[11px] ${env.sparkr.installed ? "text-muted" : "text-sand"}`}>
        {env.sparkr.installed ? `SparkR ${env.sparkr.version ?? ""}: R nodes can take inputs as Spark DataFrames.` : `SparkR is not available — R nodes that ask for a Spark input fail: ${env.sparkr.problem ?? "SparkR is missing"}.`}
      </p>
    </div>
  );
}

/** Session history: interactive console sessions and batch builds, compare with now, pin one (drift is reported). */
function SessionHistory({ id }: { id: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof codeWorkbooks.sessions>> | null>(null);
  const [cmp, setCmp] = useState<{ sid: string; rows: { name: string; a: string | null; b: string | null }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => codeWorkbooks.sessions(id).then(setData, (e: Error) => setErr(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-line pt-2">
      <div className="font-semibold">Session history</div>
      {data.pinned_session && (
        <p className={data.drift.length ? "text-sand" : "text-muted"}>
          Pinned to {data.pinned_session}: {data.drift.length ? `${data.drift.length} packages differ now (runs report them)` : "the environment matches"}
        </p>
      )}
      {data.sessions.map((s) => (
        <div key={s.id} className="flex items-center gap-1 text-[11px]">
          <span className={`rounded px-1 ${s.kind === "batch" ? "bg-violet-500/15 text-violet-300" : "bg-ocean/15 text-ocean"}`}>{s.kind}</span>
          <span className="flex-1 truncate" title={`${s.by} · ${s.branch} · Python ${s.resolved.python} · Spark profiles: ${s.requested.spark_profiles?.join(", ") || "none"}`}>
            {when(s.at)}{s.requested.spark_profiles?.length ? <span className="text-muted"> · {s.requested.spark_profiles.join(", ")}</span> : null}
          </span>
          <button type="button" onClick={() => codeWorkbooks.compareSessions(id, s.id).then((r) => setCmp({ sid: s.id, rows: r.resolved }), (e: Error) => setErr(e.message))} className="text-ocean hover:underline">compare</button>
          <button type="button" onClick={() => codeWorkbooks.pinSession(id, s.id, data.pinned_session !== s.id).then(() => load(), (e: Error) => setErr(e.message))} className="text-muted hover:text-white">
            {data.pinned_session === s.id ? "unpin" : "pin"}
          </button>
        </div>
      ))}
      {data.sessions.length === 0 && <p className="text-[11px] text-muted">A session is recorded when a console session starts or a build runs.</p>}
      {cmp && (
        <div className="rounded border border-line p-1 text-[11px]">
          <div className="text-muted">{cmp.sid} vs now: {cmp.rows.length ? `${cmp.rows.length} differences` : "identical resolved environment"}</div>
          {cmp.rows.slice(0, 50).map((r) => <div key={r.name}>{r.name}: {r.a ?? "—"} → {r.b ?? "—"}</div>)}
        </div>
      )}
      {err && <p className="text-bad">{err}</p>}
    </div>
  );
}
