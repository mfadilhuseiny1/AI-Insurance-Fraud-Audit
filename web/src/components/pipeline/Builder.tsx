"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { conversionFindings, pipelineWarnings } from "@/lib/compat";
import { explainNodes } from "@/lib/describe";
import { when } from "@/lib/format";
import { autoLayout, hiddenIds, snap } from "@/lib/graphLayout";
import { newLlmConfig } from "@/lib/llm";
import {
  ancestors,
  checkExpectations,
  descendants,
  datasetName,
  evaluator,
  FALSE_PORT,
  inputsOf,
  isFalsePort,
  logicKey,
  newGroup,
  newSourceMode,
  supportsIncremental,
  refLabel,
  refNode,
  remapInputs,
  tableNames,
  uid,
  type Column,
  type CustomFunction,
  type Dataset,
  type InputMode,
  type InputNode,
  type LegendColor,
  type LlmConfig,
  type NodeResult,
  type Output,
  type Pipeline,
  type PipelineNode,
  type Sampling,
  type SetMode,
  type SourceNode,
  type Step,
  type StepContext,
  type Subgraph,
  type Table,
  type TextNode,
} from "@/lib/pipeline";
import { usePrefs } from "@/lib/prefs";
import { browserServices, useServicesVersion } from "@/lib/services";
import { useSqlEngine } from "@/lib/useSqlEngine";
import { Icon, type IconName } from "../Icon";
import { ADD_OPTIONS, AddDataDialog, type AddMode, type NewDataset } from "./AddDataDialog";
import { BottomPanel, type BottomTab, type PipelineError } from "./BottomPanel";
import { DataPreview } from "./DataPreview";
import { HotkeysDialog, ParametersDialog, PreferencesDialog, SamplingDialog, SplitEditor } from "./EditorDialogs";
import { FoldersPanel } from "./FoldersPanel";
import { DataPanel, type DraggedDataset } from "./DataPanel";
import { readDriveTable, SAMPLE_ROWS } from "@/lib/deployed";
import { useDuckdbPager, useDuckdbPreview } from "./duckdbPreview";
import { fitZoom, Graph, GRP, NODE_H, NODE_W, nodeHeight, OUT, TXT, type GraphBadge, type OutputNodeView } from "./Graph";
import { JoinEditor, type JoinConfig } from "./JoinEditor";
import { LlmEditor } from "./LlmEditor";
import { buttonClass, inputClass, Modal } from "./Modal";
import { ModelDialog } from "./ModelDialog";
import { UnionDialog } from "./NodeDialogs";
import { AddOutputMenu, ExpectationsEditor, OutputKindList, OutputsPanel, outputResult } from "./OutputsPanel";
import { CreateSubgraphDialog, InputSchemaDialog, ReusablesDialog, SubgraphApplyDialog } from "./Reusables";
import { SearchPanel } from "./SearchPanel";
import { TransformEditor } from "./TransformEditor";
import { AiExplainDialog, AiGenerateDialog } from "./AiDialogs";
import { ContextMenu, DropMenu, ToolButton, type MenuItem } from "./ui";
import { ManualDataEditor } from "./ManualData";
import { BuildsPanel, StatusBadge, useBuilds } from "./Builds";
import { ExportCodeDialog } from "./ExportCodeDialog";
import { BuildSettingsDialog, DeployDialog } from "./Operations";
import { SchedulesPanel } from "./Schedules";
import { isActive, runtime, type BuildRecord } from "@/lib/runtime";
import { EvalSuiteEditor, EvalSuitesPanel, TestResultView, UnitTestEditor, UnitTestsPanel } from "./Testing";
import { DetailsPanel } from "./DetailsPanel";
import type { TestRun } from "@/lib/unitTests";
import { readRef, refLabel as sourceLabel } from "@/lib/inputs";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { AipAssistButton, AipAssistPanel } from "../aip/AipAssist";
import { pipelineAssist } from "../aip/pipelineAssist";

const PALETTE = ["#e2b866", "#3d8bfd", "#34c38f", "#f0616d", "#a78bfa", "#2dd4bf", "#f0a843", "#f472b6", "#94a3b8"];
const CLIPBOARD_KEY = "bluesandai.pipeline.clipboard";
const SCROLLER = "pipeline-graph";

/** A pipeline written through the API can place nodes or text notes above / left of the canvas origin, where the
 * canvas cannot scroll: everything shifts together so they show (saved with the next change). */
function intoView(p: Pipeline): Pipeline {
  const items = [...p.nodes, ...p.outputs, ...(p.textNodes ?? [])];
  const dx = Math.max(0, ...items.map((i) => ((i.x ?? 0) < 0 ? 40 - (i.x ?? 0) : 0)));
  const dy = Math.max(0, ...items.map((i) => ((i.y ?? 0) < 0 ? 40 - (i.y ?? 0) : 0)));
  if (!dx && !dy) return p;
  const shift = <T extends { x?: number; y?: number }>(i: T): T => ({ ...i, x: (i.x ?? 0) + dx, y: (i.y ?? 0) + dy });
  return { ...p, nodes: p.nodes.map(shift), outputs: p.outputs.map(shift), ...(p.textNodes ? { textNodes: p.textNodes.map(shift) } : {}) };
}

type Clip = { nodes: PipelineNode[]; datasets: Record<string, Dataset>; legend: LegendColor[]; textNodes: TextNode[]; from: string };

type Dialog =
  | { kind: "add"; mode: AddMode; files?: File[] }
  | { kind: "union"; id?: string; name: string; inputs: string[]; mode?: SetMode; strict?: boolean }
  | { kind: "hotkeys" }
  | { kind: "prefs" }
  | { kind: "parameters" }
  | { kind: "sampling"; id: string }
  | { kind: "preconditions"; id: string }
  | { kind: "reusables"; tab: "expressions" | "transforms" | "subgraphs" | "udfs" }
  | { kind: "model"; id?: string; input: string }
  | { kind: "explain"; ids: string[] }
  | { kind: "generate"; from: string }
  | { kind: "createSubgraph"; ids: string[]; replace: boolean }
  | { kind: "applySubgraph"; id: string }
  | { kind: "inputSchema"; id: string }
  | { kind: "dataset"; ref: string }
  | { kind: "manual"; id: string }
  | { kind: "deploy"; outputs: string[] }
  | { kind: "buildSettings" }
  | { kind: "exportCode" }
  | { kind: "convert"; to: "faster" | "standard" };

type PickState = { kind: "join"; ids: string[] } | { kind: "union"; ids: string[] } | { kind: "subgraph"; ids: string[]; subgraph: string; inputs: string[] };

/** A subgraph opened in the builder: its nodes are edited like a pipeline's. */
export type SubgraphMode = { def: Subgraph; onApply: (def: Subgraph) => void; onClose: () => void };

/** First free spot at or below (x, y), clear of nodes and of other boxes (output nodes). */
function place(nodes: PipelineNode[], x: number, y: number, others: { x: number; y: number }[] = []) {
  const boxes = [...nodes, ...others];
  while (boxes.some((n) => Math.abs(n.x - x) < NODE_W && Math.abs(n.y - y) < NODE_H + 24)) y += NODE_H + 32;
  return { x, y };
}

/** A node dropped at (x, y): on the grid, never above or left of the canvas. */
const snapAt = (x: number, y: number) => ({ x: Math.max(0, snap(x)), y: Math.max(0, snap(y)) });

const typingIn = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};


export function Builder({
  initial: opened,
  persist,
  subgraph,
  header,
  readOnly,
  branch = "main",
  banner,
  onSaveVersion,
  onLive,
}: {
  initial: Pipeline;
  /** writes the pipeline (autosave); missing in subgraph mode */
  persist?: (p: Pipeline) => Promise<void>;
  subgraph?: SubgraphMode;
  /** extra header content (branch picker, views) from the page */
  header?: (ctx: { pipeline: Pipeline; saveState: string }) => React.ReactNode;
  readOnly?: boolean;
  /** the branch being edited (deploys build it) */
  branch?: string;
  /** shown above the graph (e.g. why the branch cannot be edited) */
  banner?: React.ReactNode;
  /** Save: records a version of the branch (deploys save first) */
  onSaveVersion?: (p: Pipeline) => Promise<void>;
  /** every change, so the page can write it before switching branches */
  onLive?: (p: Pipeline) => void;
}) {
  const [initial] = useState(() => intoView(opened));
  const [pipeline, setPipeline] = useState<Pipeline>(initial);
  const [past, setPast] = useState<Pipeline[]>([]);
  const [future, setFuture] = useState<Pipeline[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [joinEdit, setJoinEdit] = useState<{ id?: string; config: JoinConfig } | null>(null);
  const [splitEdit, setSplitEdit] = useState<string | null>(null);
  const [llmEdit, setLlmEdit] = useState<string | null>(null);
  const [sgEdit, setSgEdit] = useState<{ def: Subgraph; replace?: string[]; isNew: boolean } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [outputMenu, setOutputMenu] = useState<string | null>(null);
  const [pick, setPick] = useState<PickState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<"pan" | "select">("pan");
  const [rail, setRail] = useState<"outputs" | "data" | "folders" | "search" | "builds" | "schedules" | "tests" | "evals" | "details" | null>(subgraph ? null : "outputs");
  // embedded in another page (?embed=1) the side panel starts folded to its icon rail
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read from the URL once, after hydration
    if (new URLSearchParams(window.location.search).get("embed") === "1") setRail(null);
  }, []);
  // drag & drop: an output port released on empty canvas offers the next step there; that step is placed at the drop
  const [portDrop, setPortDrop] = useState<{ from: string; x: number; y: number; cx: number; cy: number } | null>(null);
  const dropAt = useRef<{ x: number; y: number } | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  // choosing the nodes of a new (or re-selected) unit test, or the Use LLM node of a new evaluation
  const [testPick, setTestPick] = useState<{ kind: "test" | "eval"; ids: string[]; testId?: string } | null>(null);
  const [unitEdit, setUnitEdit] = useState<string | null>(null);
  const [evalEdit, setEvalEdit] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; run: TestRun } | null>(null);
  const [searchKey, setSearchKey] = useState(0);
  const [bottomTab, setBottomTab] = useState<BottomTab>("preview");
  const [notice, setNotice] = useState<{ text: string; ok?: boolean } | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [previewed, setPreviewed] = useState<Set<string>>(new Set());
  const [assist, setAssist] = useState(false);
  const assistLast = useRef<string | null>(null);
  const [prefs, setPrefs] = usePrefs();
  // a subgraph being edited: its inputs (InputNodes refer to them) and its output node
  const [sgInputs, setSgInputs] = useState(subgraph?.def.inputs ?? []);
  const [sgOutput, setSgOutput] = useState(subgraph?.def.output ?? "");
  const services = useServicesVersion();
  const runs = useBuilds(subgraph ? undefined : initial.id, branch);
  // outputs shown with their last server deploy
  const shownOutputs = useMemo(
    () =>
      pipeline.outputs.map((o) => {
        const st = runs.outputs.get(o.id);
        return st ? { ...o, deployed: { at: st.at, version: st.version, rows: st.rows, columns: st.columns, itemId: st.itemId, parentId: st.parentId ?? null, path: st.path } } : o;
      }),
    [pipeline.outputs, runs.outputs],
  );
  const latestBuild = runs.builds?.[0];
  // the build still running or queued: stopped from the header (Cancel build was only inside a build's details)
  const activeBuild = runs.builds?.find(isActive);
  // the version last written, or the one that failed to save
  const [persisted, setPersisted] = useState<{ version: Pipeline; failed: boolean }>({ version: initial, failed: false });
  const [writing, setWriting] = useState(false);
  const saveState = !persist ? "local" : persisted.failed && persisted.version === pipeline ? "error" : persisted.version === pipeline ? "saved" : "saving";

  useEffect(() => {
    if (!persist || pipeline === persisted.version || writing) return;
    const t = setTimeout(async () => {
      setWriting(true);
      try {
        await persist(pipeline);
        setPersisted({ version: pipeline, failed: false });
      } catch (e) {
        setPersisted({ version: pipeline, failed: true });
        setNotice({ text: `Not saved: ${(e as Error).message}` });
      } finally {
        setWriting(false);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [pipeline, persisted.version, writing, persist]);

  useEffect(() => {
    if (saveState !== "saving" && saveState !== "error") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  useEffect(() => {
    onLive?.(pipeline);
  }, [pipeline, onLive]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.ok ? 4000 : 9000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---------------------------------------------------------------- evaluation
  const logic = logicKey(pipeline.nodes);
  const datasets = pipeline.datasets;
  const reuse = JSON.stringify([pipeline.parameters ?? [], pipeline.functions ?? [], pipeline.subgraphs ?? []]);
  const needsSql =
    pipeline.nodes.some((n) => n.kind === "transform" && n.steps.some((s) => s.kind === "sql" || s.kind.startsWith("fn:"))) || (pipeline.functions ?? []).length > 0;
  const sql = useSqlEngine(needsSql);
  const subgraphInputs = useMemo(
    () => (subgraph ? Object.fromEntries(sgInputs.map((i) => [i.id, { columns: i.columns, rows: [] } as Table])) : undefined),
    [subgraph, sgInputs],
  );
  const jsResult = useMemo(() => {
    const [parameters, functions, subgraphs] = JSON.parse(reuse);
    return evaluator({ nodes: JSON.parse(logic), datasets, parameters, functions, subgraphs }, sql, {
      preview: true,
      services: browserServices,
      inputs: subgraphInputs,
    });
    // services.version: re-evaluate when LLM answers / extracted text arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logic, datasets, sql, reuse, subgraphInputs, services.version]);
  // a DuckDB local pipeline previews its transforms in DuckDB, over every input row (its SQL is DuckDB SQL)
  const duckdbVersion = `${logic}\u0000${reuse}\u0000${JSON.stringify(Object.values(datasets).map((d) => [d.id, d.ref ?? null]))}`;
  const duckdbResult = useDuckdbPreview(pipeline, pipeline.compute === "duckdb" && !subgraph, duckdbVersion);
  // its previews page, find and filter over every row of the node too (the browser holds only the first page)
  const pagerOf = useDuckdbPager(pipeline, pipeline.compute === "duckdb" && !subgraph, duckdbVersion);
  const result = useCallback((ref: string) => duckdbResult(ref) ?? jsResult(ref), [duckdbResult, jsResult]);

  const change = (fn: (p: Pipeline) => Pipeline, record = true) => {
    if (readOnly) return;
    if (record) {
      setPast((h) => [...h.slice(-79), pipeline]);
      setFuture([]);
    }
    setPipeline((p) => fn(p));
  };
  const undo = () => {
    if (!past.length) return;
    setFuture([pipeline, ...future]);
    setPipeline(past[past.length - 1]);
    setPast(past.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast([...past, pipeline]);
    setPipeline(future[0]);
    setFuture(future.slice(1));
  };

  const nodes = pipeline.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hidden = useMemo(() => hiddenIds(pipeline, OUT), [pipeline]);
  const single = selected.length === 1 ? byId.get(selected[0]) : undefined;
  const outputOf = (id: string) => (id.startsWith(OUT) ? pipeline.outputs.find((o) => OUT + o.id === id) : undefined);
  const singleOutput = selected.length === 1 ? outputOf(selected[0]) : undefined;

  const editContext = useMemo<StepContext | undefined>(() => {
    if (!editing) return undefined;
    const others = nodes.filter((n) => n.id !== editing);
    const names = tableNames(nodes);
    return {
      names: () => others.map((n) => names.get(n.id)!),
      table: (name) => {
        const n = others.find((x) => names.get(x.id) === name);
        if (!n) return undefined;
        const r = result(n.id);
        if (r.error !== undefined) throw new Error(`Input "${n.name}" failed: ${r.error}`);
        return r.table;
      },
      functions: pipeline.functions,
    };
  }, [editing, nodes, result, pipeline.functions]);

  // ---------------------------------------------------------------- node actions
  // the DuckDB local engine builds from the files on disk: the editor keeps only a preview sample of each input
  const sampleRows = pipeline.compute === "duckdb" ? SAMPLE_ROWS : undefined;

  const addDatasets = (items: NewDataset[], at?: { x: number; y: number }) => {
    const now = new Date().toISOString();
    const ids = items.map(() => uid());
    change((p) => {
      const placed = [...p.nodes];
      const ds = { ...p.datasets };
      items.forEach((d, i) => {
        ds[ids[i]] = { id: ids[i], name: d.name, origin: d.origin, createdAt: now, ...d.table, ...(d.ref ? { ref: d.ref, refreshedAt: now } : {}), ...(d.media ? { media: true } : {}), ...(d.generator ? { generator: d.generator } : {}) };
        // dropped from the Data panel: where it was dropped (several stack downwards)
        placed.push({ id: ids[i], kind: "source", name: d.name, datasetId: ids[i], mode: newSourceMode(p), ...(at ? snapAt(at.x - NODE_W / 2, at.y - 24 + i * 96) : place(placed, 80, 80)) });
      });
      return { ...p, nodes: placed, datasets: ds };
    });
    setSelected(ids.slice(-1));
    setDialog(null);
  };

  /** where output nodes are drawn (stored position, else next to their input) */
  const p0Outputs = () =>
    pipeline.outputs.map((o) => {
      const src = byId.get(refNode(o.node));
      return { x: o.x ?? (src ? src.x + NODE_W + 90 : 80), y: o.y ?? (src?.y ?? 80) };
    });

  const addNode = (node: Omit<PipelineNode, "id" | "x" | "y">, after: string[], at?: { x: number; y: number }) => {
    const id = uid();
    const srcs = after.map((a) => byId.get(refNode(a))).filter((n): n is PipelineNode => !!n);
    const x = srcs.reduce((m, s) => Math.max(m, s.x), 80) + NODE_W + 90;
    const y = srcs.length ? Math.round(srcs.reduce((a, s) => a + s.y, 0) / srcs.length) : 80;
    const folder = srcs.find((s) => s.folder)?.folder;
    const outBoxes = p0Outputs();
    const pos = at ?? dropAt.current ?? undefined;
    dropAt.current = null;
    change((p) => ({ ...p, nodes: [...p.nodes, { ...node, id, ...(folder ? { folder } : {}), ...(pos ? snapAt(pos.x - 20, pos.y - 24) : place(p.nodes, x, y, outBoxes)) } as PipelineNode] }));
    setSelected([id]);
    return id;
  };

  const updateNode = (nodeId: string, patch: Partial<PipelineNode>, record = true) =>
    change((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch } as PipelineNode) : n)) }), record);

  const updateOutput = (outputId: string, patch: Partial<Output>, record = true) =>
    change((p) => ({ ...p, outputs: p.outputs.map((o) => (o.id === outputId ? { ...o, ...patch } : o)) }), record);

  const newTransform = (ref: string) => {
    const input = byId.get(refNode(ref));
    if (!input) return;
    const nodeId = addNode({ kind: "transform", name: prefs.autoName ? "Transform" : `Clean ${refLabel(nodes, ref)}`, input: ref, steps: [] } as Omit<PipelineNode, "id" | "x" | "y">, [ref]);
    setEditing(nodeId);
  };

  const newSplit = (ref: string) => {
    const id = addNode({ kind: "split", name: "Split", input: ref, condition: JSON.stringify(newGroup()) } as Omit<PipelineNode, "id" | "x" | "y">, [ref]);
    setSplitEdit(id);
  };

  const newLlm = (ref: string) => {
    const t = result(ref).table;
    const firstText = t?.columns.find((c) => c.type === "String")?.name ?? "";
    const id = addNode({ kind: "llm", name: "Use LLM", input: ref, config: newLlmConfig("empty", firstText) } as Omit<PipelineNode, "id" | "x" | "y">, [ref]);
    setLlmEdit(id);
  };

  const newInput = () => {
    if (!subgraph) return;
    const inputId = uid();
    const id = addNode({ kind: "input", name: `Input ${sgInputs.length + 1}`, inputId } as Omit<PipelineNode, "id" | "x" | "y">, []);
    setSgInputs([...sgInputs, { id: inputId, name: `Input ${sgInputs.length + 1}`, columns: [] }]);
    setDialog({ kind: "inputSchema", id });
  };

  /** Datasets dragged from the Data panel and dropped on the canvas: read, then added where they were dropped. */
  const dropDatasets = async (payload: string, x: number, y: number) => {
    let dragged: DraggedDataset[];
    try {
      dragged = JSON.parse(payload) as DraggedDataset[];
    } catch {
      return;
    }
    const out: NewDataset[] = [];
    for (const d of dragged) {
      setDropping(d.item.name);
      try {
        out.push({ name: datasetName(d.item.name), origin: `Files & Projects / ${[...d.path, d.item.name].join(" / ")}`, table: await readDriveTable(d.item, sampleRows),
                   ref: { kind: "drive", itemId: d.item.id } });
      } catch (e) {
        setNotice({ text: `${d.item.name}: ${(e as Error).message}` });
      }
    }
    setDropping(null);
    if (out.length) addDatasets(out, { x, y });
  };

  /** The next step chosen after dragging an output port onto empty canvas. */
  const portStep = (kind: "transform" | "sql" | "join" | "union" | "output") => {
    if (!portDrop) return;
    const { from, x, y } = portDrop;
    setPortDrop(null);
    if (kind === "output") {
      setSelected([refNode(from)]);
      setOutputMenu(refNode(from));
      return;
    }
    if (kind === "join" || kind === "union") {
      // the join / union is created after its other inputs are picked: it lands where the port was dropped
      dropAt.current = { x, y };
      startPick(kind, [refNode(from)]);
      return;
    }
    const input = byId.get(refNode(from));
    if (!input) return;
    const steps = kind === "sql" ? [{ id: uid(), kind: "sql", params: { query: "SELECT *\nFROM input" } }] : [];
    const id = addNode({ kind: "transform", name: prefs.autoName ? "Transform" : `Clean ${refLabel(nodes, from)}`, input: from, steps } as Omit<PipelineNode, "id" | "x" | "y">,
                       [from], { x, y });
    setEditing(id);
  };

  const startPick = (kind: "join" | "union", ids: string[]) => {
    const tables = ids.filter((i) => byId.has(refNode(i)));
    setPick(kind === "join" ? { kind, ids: tables.slice(0, 2) } : { kind, ids: tables });
    setOutputMenu(null);
    setMenu(null);
  };

  const startSubgraphPick = (ids: string[]) => {
    const list = pipeline.subgraphs ?? [];
    if (!list.length) {
      setNotice({ text: "No subgraphs yet — create one from Reusables → Subgraphs, or right-click nodes → Subgraphs → Create subgraph." });
      return;
    }
    const sg = list[0];
    const starts = ids.filter((i) => byId.has(refNode(i)));
    setPick({ kind: "subgraph", ids: starts, subgraph: sg.id, inputs: sg.inputs.map((_, i) => starts[i] ?? "") });
    setMenu(null);
  };

  const pickNode = (id: string) => {
    if (!pick || !byId.has(refNode(id))) return;
    if (pick.kind === "join") {
      const [left, right] = pick.ids;
      if (!left) setPick({ ...pick, ids: [id] });
      else if (id === left) return;
      else setPick({ ...pick, ids: right === id ? [left] : [left, id] });
    } else if (pick.kind === "union") setPick({ ...pick, ids: pick.ids.includes(id) ? pick.ids.filter((i) => i !== id) : [...pick.ids, id] });
    else {
      // fill the first unmapped subgraph input
      const at = pick.inputs.findIndex((x) => !x);
      const inputs = [...pick.inputs];
      if (at >= 0) inputs[at] = id;
      else inputs[inputs.length - 1] = id;
      setPick({ ...pick, inputs });
    }
  };

  const finishPick = () => {
    if (!pick) return;
    if (pick.kind === "join") openJoin(pick.ids[0], pick.ids[1]);
    else if (pick.kind === "union") setDialog({ kind: "union", name: "Union", inputs: pick.ids, strict: true });
    else {
      const sg = (pipeline.subgraphs ?? []).find((s) => s.id === pick.subgraph);
      if (!sg) return;
      const id = addNode({ kind: "subgraph", name: sg.name, subgraph: sg.id, inputs: pick.inputs } as Omit<PipelineNode, "id" | "x" | "y">, pick.inputs.filter(Boolean));
      setDialog({ kind: "applySubgraph", id });
    }
    setSelected(pick.kind === "subgraph" ? selected : pick.ids);
    setPick(null);
  };

  const openJoin = (left: string, right = "") => {
    const name = [refLabel(nodes, left), right ? refLabel(nodes, right) : ""].filter(Boolean).join(" | ") || "Join";
    setJoinEdit({ config: { name, left, right, leftKey: "", rightKey: "", keys: [], how: "left", leftColumns: null, rightColumns: null, rightPrefix: "" } });
  };

  const addOutput = (ref: string, kind: Output["kind"] = "dataset") => {
    const node = byId.get(refNode(ref));
    if (!node) return;
    const id = uid();
    const taken = pipeline.outputs.filter((o) => refNode(o.node) === node.id).length;
    const name = refLabel(nodes, ref);
    const t = result(ref).table;
    // a free spot right of the node: clear of other nodes and outputs
    const boxes = [
      ...nodes.map((n) => ({ x: n.x, y: n.y, h: nodeHeight(n, prefs) })),
      ...outputViews.map((o) => ({ x: o.x, y: o.y, h: NODE_H })),
    ];
    const ox = node.x + NODE_W + 90;
    let oy = node.y + taken * (NODE_H + 24);
    while (boxes.some((b) => Math.abs(b.x - ox) < NODE_W + 20 && oy < b.y + b.h + 16 && oy + NODE_H + 16 > b.y)) oy += 24;
    const base: Output = { id, name, node: ref, kind, columns: null, writeMode: "default", x: ox, y: oy };
    if (kind === "objectType") {
      const pk = t?.columns.find((c) => /(^|_)id$/i.test(c.name))?.name ?? t?.columns[0]?.name ?? "";
      base.objectType = { apiName: name.replace(/[^A-Za-z0-9]+/g, "") || "Object", primaryKey: pk, titleProperty: t?.columns.find((c) => c.type === "String")?.name ?? pk, properties: null };
    }
    if (kind === "linkType") base.linkType = { from: "", to: "", cardinality: "many-to-one", fromKey: "", toKey: "", apiName: "", reverseApiName: "" };
    if (kind === "file") base.file = { format: "csv", fileName: name };
    if (kind === "timeSeries") base.timeSeries = { seriesId: "", timestamp: "", value: "" };
    if (kind === "geotemporal") base.geotemporal = { seriesId: "", timestamp: "", latitude: "", longitude: "" };
    if (kind === "mediaSet") base.mediaSet = { mediaColumn: t?.columns.find((c) => /media/i.test(c.name))?.name ?? "" };
    if (kind === "virtualTable") base.virtualTable = { connectionId: pipeline.external?.connectionId ?? "", connectionName: pipeline.external?.connectionName, database: "", schema: "", table: name.replace(/\W+/g, "_").toLowerCase() };
    change((p) => ({ ...p, outputs: [...p.outputs, base] }));
    setSelected([OUT + id]);
    setRail("outputs");
  };

  const open = (id: string) => {
    if (id.startsWith(TXT)) return;
    const n = byId.get(id);
    if (!n) {
      if (outputOf(id)) {
        setSelected([id]);
        setRail("outputs");
      }
      return;
    }
    if (n.kind === "transform") setEditing(n.id);
    else if (n.kind === "join") setJoinEdit({ id: n.id, config: n });
    else if (n.kind === "union") setDialog({ kind: "union", id: n.id, name: n.name, inputs: n.inputs, mode: n.mode, strict: n.strict });
    else if (n.kind === "split") setSplitEdit(n.id);
    else if (n.kind === "llm") setLlmEdit(n.id);
    else if (n.kind === "model") setDialog({ kind: "model", id: n.id, input: n.input });
    else if (n.kind === "subgraph") setDialog({ kind: "applySubgraph", id: n.id });
    else if (n.kind === "input") setDialog({ kind: "inputSchema", id: n.id });
    else if (pipeline.datasets[n.datasetId]?.origin === "Entered manually") setDialog({ kind: "manual", id: n.id });
    else setDialog({ kind: "dataset", ref: n.id });
  };

  /** Removes nodes (and what depends on them, after asking), outputs and text nodes. */
  const removeNodes = async (ids: string[], ask = true) => {
    const outputIds = new Set(ids.filter((i) => i.startsWith(OUT)).map((i) => i.slice(OUT.length)));
    const textIds = new Set(ids.filter((i) => i.startsWith(TXT)).map((i) => i.slice(TXT.length)));
    const nodeIds = ids.filter((i) => byId.has(i));
    if (!nodeIds.length && !outputIds.size && !textIds.size) return;
    const doomed = new Set(nodeIds);
    for (const id of nodeIds) for (const d of descendants(nodes, id)) doomed.add(d);
    const extra = doomed.size - nodeIds.length;
    if (ask && extra && !(await confirmDialog(`This also deletes ${extra} downstream node${extra > 1 ? "s" : ""} that depend on it. Continue?`))) return;
    change((p) => {
      const kept = p.nodes.filter((n) => !doomed.has(n.id));
      const used = new Set(kept.flatMap((n) => (n.kind === "source" ? [n.datasetId] : [])));
      for (const sg of p.subgraphs ?? []) for (const n of sg.nodes) if (n.kind === "source") used.add(n.datasetId);
      return {
        ...p,
        nodes: kept,
        outputs: p.outputs.filter((o) => !doomed.has(refNode(o.node)) && !outputIds.has(o.id)),
        textNodes: (p.textNodes ?? []).filter((t) => !textIds.has(t.id)),
        datasets: Object.fromEntries(Object.entries(p.datasets).filter(([dsId]) => used.has(dsId))),
        hidden: (p.hidden ?? []).filter((h) => !doomed.has(h)),
      };
    });
    setSelected([]);
  };

  /** Re-reads an input's preview copy from where it lives (builds always read it fresh). */
  const refresh = async (n: SourceNode) => {
    const ds = pipeline.datasets[n.datasetId];
    if (!ds?.ref) return;
    setNotice({ text: `Refreshing ${n.name} from ${sourceLabel(ds.ref)}…`, ok: true });
    try {
      const table = await readRef(ds.ref, sampleRows);
      change((p) => ({ ...p, datasets: { ...p.datasets, [ds.id]: { ...p.datasets[ds.id], ...table, refreshedAt: new Date().toISOString() } } }));
      setNotice({ text: `${n.name}: ${table.rows.length.toLocaleString()} rows · ${table.columns.length} columns`, ok: true });
    } catch (e) {
      setNotice({ text: `Could not refresh ${n.name}: ${(e as Error).message}` });
    }
  };

  // ---------------------------------------------------------------- clipboard (works across pipelines)
  const copy = (ids: string[]) => {
    const chosen = nodes.filter((n) => ids.includes(n.id));
    const texts = (pipeline.textNodes ?? []).filter((t) => ids.includes(TXT + t.id));
    if (!chosen.length && !texts.length) return;
    const clip: Clip = {
      nodes: chosen,
      textNodes: texts,
      datasets: Object.fromEntries(chosen.flatMap((n) => (n.kind === "source" && pipeline.datasets[n.datasetId] ? [[n.datasetId, pipeline.datasets[n.datasetId]]] : []))),
      legend: pipeline.legend.filter((c) => chosen.some((n) => n.color === c.id) || texts.some((t) => t.color === c.id)),
      from: pipeline.id,
    };
    try {
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clip));
      setNotice({ text: `Copied ${chosen.length + texts.length} node${chosen.length + texts.length === 1 ? "" : "s"} — paste here or in another pipeline.`, ok: true });
    } catch {
      setNotice({ text: "These nodes hold too much data to copy (their datasets are copied with them)." });
    }
  };

  const readClip = (): Clip | null => {
    try {
      const c = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? "null");
      return c && Array.isArray(c.nodes) ? (c as Clip) : null;
    } catch {
      return null;
    }
  };

  /** Copies of nodes next to the originals; inputs inside the set point to the copies, datasets and colours come along. */
  const paste = (clip: Clip | null = readClip(), offset = 40) => {
    if (!clip || (!clip.nodes.length && !clip.textNodes?.length)) return;
    const ids = new Map(clip.nodes.map((n) => [n.id, uid()]));
    const remap = (ref: string) => {
      const base = refNode(ref);
      return ids.has(base) ? ids.get(base)! + (isFalsePort(ref) ? FALSE_PORT : "") : ref;
    };
    const dangling = clip.nodes.find((n) => inputsOf(n).some((i) => i && !ids.has(refNode(i)) && !byId.has(refNode(i))));
    if (dangling) {
      setNotice({ text: `"${dangling.name}" needs an input that is not in this pipeline — copy its inputs too.` });
      return;
    }
    change((p) => {
      // colour groups: same id, else same name and colour, else added
      const legend = [...p.legend];
      const colorMap = new Map<string, string>();
      for (const c of clip.legend ?? []) {
        const hit = legend.find((x) => x.id === c.id) ?? legend.find((x) => x.name === c.name && x.hex === c.hex);
        if (hit) colorMap.set(c.id, hit.id);
        else {
          legend.push(c);
          colorMap.set(c.id, c.id);
        }
      }
      const ds = { ...p.datasets };
      const dsMap = new Map<string, string>();
      for (const [id, d] of Object.entries(clip.datasets ?? {})) {
        if (ds[id]) dsMap.set(id, id);
        else {
          const nid = clip.from === p.id ? id : uid();
          ds[nid] = { ...d, id: nid };
          dsMap.set(id, nid);
        }
      }
      const fresh = clip.nodes.map((n): PipelineNode => {
        const base = remapInputs({ ...n, id: ids.get(n.id)!, name: clip.from === p.id ? `${n.name} (copy)` : n.name, x: n.x + offset, y: n.y + offset }, remap);
        const colored = base.color ? { ...base, color: colorMap.get(base.color) } : base;
        if (colored.kind === "source") return { ...colored, datasetId: dsMap.get(colored.datasetId) ?? colored.datasetId };
        if (colored.kind === "transform") return { ...colored, steps: colored.steps.map((s) => ({ ...s, id: uid() })) };
        return colored;
      });
      const texts = (clip.textNodes ?? []).map((t) => ({ ...t, id: uid(), x: t.x + offset, y: t.y + offset, color: t.color ? colorMap.get(t.color) : undefined }));
      setSelected([...fresh.map((n) => n.id), ...texts.map((t) => TXT + t.id)]);
      return { ...p, legend, datasets: ds, nodes: [...p.nodes, ...fresh], textNodes: [...(p.textNodes ?? []), ...texts] };
    });
  };

  const duplicate = (ids: string[]) => {
    const chosen = nodes.filter((n) => ids.includes(n.id));
    paste({ nodes: chosen, datasets: {}, legend: [], textNodes: (pipeline.textNodes ?? []).filter((t) => ids.includes(TXT + t.id)), from: pipeline.id });
  };

  const rename = async (id: string) => {
    const n = byId.get(id);
    const o = outputOf(id);
    const name = (await promptDialog("Rename", n?.name ?? o?.name ?? ""));
    if (name === null || !name.trim()) return;
    if (n) updateNode(n.id, { name: name.trim() });
    else if (o) updateOutput(o.id, { name: name.trim() });
  };

  // a streaming pipeline's outputs are deployed while its job runs (they are written continuously, not versioned)
  const streamingJob = pipeline.type === "streaming" ? runs.builds?.find((b) => b.streaming && (b.branch || "main") === branch && (b.status === "running" || b.status === "queued")) : undefined;
  const outputViews: OutputNodeView[] = shownOutputs.map((o) => {
    const src = byId.get(refNode(o.node));
    const siblings = shownOutputs.filter((x) => x.node === o.node);
    const r = outputResult(o, result(o.node));
    const job = streamingJob && (!streamingJob.outputs.length || streamingJob.outputs.includes(o.id)) ? streamingJob : undefined;
    const rows = job?.jobs?.[0]?.outputs.find((x) => x.id === o.id)?.rows;
    return {
      id: o.id,
      name: o.name,
      node: o.node,
      kind: o.kind ?? "dataset",
      x: o.x ?? (src ? src.x + NODE_W + 90 : 80),
      y: o.y ?? (src ? src.y + siblings.indexOf(o) * (NODE_H + 24) : 80),
      status: r.error ? "error" : job || o.deployed ? "deployed" : "pending",
      detail:
        r.error ??
        (job
          ? `Streaming ${job.status === "queued" ? "· starting" : `since ${when(job.started_at ?? job.created_at)}`}${rows ? ` · ${rows.toLocaleString()} rows` : ""}`
          : o.deployed
            ? `Deployed v${o.deployed.version} · ${when(o.deployed.at)}`
            : "Not yet deployed"),
    };
  });

  // ---------------------------------------------------------------- graph view actions
  const scroller = () => document.getElementById(SCROLLER)?.firstElementChild as HTMLElement | null;
  const viewCenter = () => {
    const el = scroller();
    if (!el) return { x: 200, y: 160 };
    return { x: Math.round((el.scrollLeft + el.clientWidth / 2) / zoom), y: Math.round((el.scrollTop + el.clientHeight / 3) / zoom) };
  };

  const fit = (ids?: string[]) => {
    const el = scroller();
    if (!el) return;
    const boxes = [
      ...nodes.filter((n) => !hidden.has(n.id) && (!ids || ids.includes(n.id))).map((n) => ({ x: n.x, y: n.y, w: NODE_W, h: nodeHeight(n, prefs) })),
      ...(ids ? [] : outputViews.filter((o) => !hidden.has(OUT + o.id)).map((o) => ({ x: o.x, y: o.y, w: NODE_W, h: NODE_H }))),
      ...(ids ? [] : (pipeline.textNodes ?? []).map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h }))),
    ];
    if (!boxes.length) return;
    const f = fitZoom(boxes, el.clientWidth, el.clientHeight);
    const z = ids ? Math.min(1, Math.max(zoom, f.zoom)) : f.zoom;
    setZoom(z);
    requestAnimationFrame(() => {
      el.scrollLeft = ids ? (Math.min(...boxes.map((b) => b.x)) - 80) * z : f.left;
      el.scrollTop = ids ? (Math.min(...boxes.map((b) => b.y)) - 80) * z : f.top;
    });
  };

  const layout = () => {
    const pos = autoLayout(
      nodes,
      pipeline.outputs,
      (n) => ({ w: NODE_W, h: nodeHeight(n, prefs) }),
      { w: NODE_W, h: NODE_H },
      // one lane per legend colour, in the legend's order
      (pipeline.legend ?? []).map((l) => l.id),
    );
    change((p) => ({
      ...p,
      nodes: p.nodes.map((n) => ({ ...n, ...(pos.nodes.get(n.id) ?? {}) })),
      outputs: p.outputs.map((o) => ({ ...o, ...(pos.outputs.get(o.id) ?? {}) })),
    }));
    setTimeout(() => fit(), 50);
  };

  const addText = () => {
    const c = viewCenter();
    const id = uid();
    change((p) => ({ ...p, textNodes: [...(p.textNodes ?? []), { id, x: c.x, y: c.y, w: 320, h: 160, text: "## Section\nDescribe this part of the pipeline." }] }));
    setSelected([TXT + id]);
  };

  const hide = (ids: string[], others = false) => {
    const nodeIds = ids.filter((i) => byId.has(i));
    const target = others ? nodes.filter((n) => !nodeIds.includes(n.id)).map((n) => n.id) : nodeIds;
    if (!target.length) return;
    change((p) => ({ ...p, hidden: [...new Set([...(p.hidden ?? []), ...target])] }), false);
    setSelected([]);
  };
  const unhideAll = () =>
    change(
      (p) => ({
        ...p,
        hidden: [],
        folders: (p.folders ?? []).map((f) => ({ ...f, hidden: false })),
        legend: p.legend.map((c) => ({ ...c, hidden: false })),
      }),
      false,
    );
  const showInputs = (id: string) => {
    const ups = ancestors(nodes, id);
    change((p) => ({ ...p, hidden: (p.hidden ?? []).filter((h) => !ups.has(h)) }), false);
  };

  const selectRelated = (dir: "children" | "parents") => {
    const base = selected.filter((s) => byId.has(s));
    const out = new Set(base);
    for (const s of base) for (const x of dir === "children" ? descendants(nodes, s) : ancestors(nodes, s)) out.add(x);
    setSelected([...out]);
  };

  /** Dragging an output port onto an input port rewires that input (or an output's source). */
  const connect = (fromRef: string, to: string, port: number) => {
    if (to.startsWith(OUT)) {
      updateOutput(to.slice(OUT.length), { node: fromRef });
      return;
    }
    const n = byId.get(to);
    if (!n || refNode(fromRef) === to) return;
    if (ancestors(nodes, refNode(fromRef)).has(to)) {
      setNotice({ text: "That connection would make a cycle." });
      return;
    }
    switch (n.kind) {
      case "transform":
      case "split":
      case "llm":
      case "model":
        updateNode(to, { input: fromRef } as Partial<PipelineNode>);
        break;
      case "join":
        updateNode(to, (port === 0 ? { left: fromRef } : { right: fromRef }) as Partial<PipelineNode>);
        break;
      case "union":
        if (!n.inputs.includes(fromRef)) updateNode(to, { inputs: [...n.inputs, fromRef] } as Partial<PipelineNode>);
        break;
      case "subgraph": {
        const at = n.inputs.findIndex((x) => !x);
        const inputs = [...n.inputs];
        inputs[at >= 0 ? at : Math.max(0, inputs.length - 1)] = fromRef;
        updateNode(to, { inputs } as Partial<PipelineNode>);
        break;
      }
      default:
        setNotice({ text: `"${n.name}" takes no input.` });
    }
  };

  /** The input's computation mode; an incremental input over a snapshot data source offers to make the sync incremental too
   * (reading new rows only has an effect when the dataset receives APPEND transactions). */
  const setInputMode = async (id: string, mode: InputMode) => {
    updateNode(id, { mode } as Partial<PipelineNode>);
    const n = byId.get(id);
    const ref = n?.kind === "source" ? pipeline.datasets[n.datasetId]?.ref : undefined;
    if (ref?.kind !== "datasource") return;
    try {
      const src = await api.dataSources.source(ref.id);
      if (src.mode === mode) return;
      const question =
        mode === "incremental"
          ? `"${src.name}" is synced as a SNAPSHOT: every run replaces the whole dataset, so an incremental input still reads every row.

Also switch the data source sync to incremental? Its next run re-syncs, then each run appends only new rows (by its recommended cursor column — change it under Data Connection → Syncs).`
          : `"${src.name}" is synced incrementally (APPEND on ${src.config.cursor_column}). A snapshot input reads its whole dataset either way.

Also switch the data source sync to snapshot? Each run will then replace the dataset with the whole table.`;
      if (!(await confirmDialog({ title: `Switch the data source sync to ${mode}?`, message: question, confirmLabel: `Switch the sync to ${mode}`, cancelLabel: "Only this pipeline" }))) {
        setNotice({ text: `The pipeline reads "${src.name}" as a ${mode}; the data source still syncs as ${src.mode === "incremental" ? "incremental (APPEND)" : "a snapshot"}. Change it any time under Data Connection → Syncs.`, ok: true });
        return;
      }
      const changed = await api.dataSources.changeMode(src.id, { mode });
      setNotice({
        text:
          mode === "incremental"
            ? `"${changed.name}" now syncs incrementally on ${changed.config.cursor_column} — its next run re-syncs, later runs append new rows.`
            : `"${changed.name}" now syncs as a snapshot — each run replaces the dataset with the whole table.`,
        ok: true,
      });
    } catch (e) {
      setNotice({ text: `The input is ${mode}, but its data source sync could not be switched: ${(e as Error).message}${mode === "incremental" ? " Choose a cursor column under Data Connection → Syncs." : ""}` });
    }
  };

  // ---------------------------------------------------------------- deploy: save, then build on the server
  const deploy = (outputIds: string[]) => setDialog({ kind: "deploy", outputs: outputIds });
  const stopBuild = async (b: BuildRecord) => {
    const streaming = !!b.streaming || pipeline.type === "streaming";
    const ok = await confirmDialog({
      title: streaming ? "Stop streaming?" : "Stop this build?",
      message: streaming
        ? "The streaming job stops after the batch it is on; its outputs keep what they already wrote. Deploy starts it again."
        : "The build stops; outputs it already finished stay written. Deploy runs it again.",
      confirmLabel: streaming ? "Stop streaming" : "Stop build",
    });
    if (!ok) return;
    try {
      await runtime.cancel(b.id);
      setNotice({ text: streaming ? "Stopping the streaming job…" : "Stopping the build…", ok: true });
      runs.refresh();
    } catch (e) {
      setNotice({ text: `Could not stop: ${(e as Error).message}` });
    }
  };
  const startBuild = async (outputIds: string[], opts: { replay?: boolean } = {}) => {
    setDeploying(true);
    try {
      if (persist) {
        await persist(pipeline);
        setPersisted({ version: pipeline, failed: false });
      }
      if (onSaveVersion) await onSaveVersion(pipeline);
      const b = await runtime.build(pipeline.id, { outputs: outputIds, branch, replay: opts.replay });
      setNotice({ text: `Deploy started (${outputIds.length || pipeline.outputs.length} output${(outputIds.length || pipeline.outputs.length) === 1 ? "" : "s"}) — follow it in Builds.`, ok: true });
      setRail("builds");
      runs.refresh();
      void b;
    } finally {
      setDeploying(false);
    }
  };


  // ---------------------------------------------------------------- subgraphs
  const saveSubgraph = (def: Subgraph) =>
    change((p) => ({ ...p, subgraphs: (p.subgraphs ?? []).some((s) => s.id === def.id) ? (p.subgraphs ?? []).map((s) => (s.id === def.id ? def : s)) : [...(p.subgraphs ?? []), def] }));

  /** Packages selected nodes into a new subgraph (inputs from outside the selection, one output). */
  const subgraphFrom = (ids: string[]): { def: Subgraph; error?: string } => {
    const set = new Set(ids.filter((i) => byId.has(i)));
    const chosen = nodes.filter((n) => set.has(n.id));
    const empty: Subgraph = { id: uid(), name: "New subgraph", inputs: [], nodes: [], output: "" };
    if (!chosen.length) return { def: empty, error: "Select the nodes to package" };
    if (chosen.some((n) => n.kind === "source")) return { def: empty, error: "Datasets cannot go in a subgraph — select the transforms after them" };
    const usedOutside = (id: string) => nodes.some((n) => !set.has(n.id) && inputsOf(n).some((r) => refNode(r) === id)) || pipeline.outputs.some((o) => refNode(o.node) === id);
    const terminals = chosen.filter((n) => !chosen.some((m) => inputsOf(m).some((r) => refNode(r) === n.id)));
    const exits = chosen.filter((n) => usedOutside(n.id));
    const out = exits[0] ?? terminals[terminals.length - 1];
    if (exits.length > 1) return { def: empty, error: "Only one of the selected nodes can be used outside the selection" };
    if (terminals.length > 1 && !exits.length) return { def: empty, error: "The selection has more than one end — a subgraph has one output" };
    const outside = [...new Set(chosen.flatMap((n) => inputsOf(n).filter((r) => r && !set.has(refNode(r)))))];
    const inputNodes: InputNode[] = outside.map((ref, i) => ({ id: uid(), kind: "input", name: refLabel(nodes, ref), inputId: uid(), x: 80, y: 80 + i * 120 }));
    const refMap = new Map(outside.map((ref, i) => [ref, inputNodes[i].id]));
    const minX = Math.min(...chosen.map((n) => n.x));
    const minY = Math.min(...chosen.map((n) => n.y));
    const inner = chosen.map((n) => remapInputs({ ...n, x: n.x - minX + 400, y: n.y - minY + 80, folder: undefined }, (r) => refMap.get(r) ?? r));
    const def: Subgraph = {
      id: uid(),
      name: "New subgraph",
      inputs: outside.map((ref, i) => ({ id: inputNodes[i].inputId, name: inputNodes[i].name, columns: result(ref).table?.columns ?? [] })),
      nodes: [...inputNodes, ...inner],
      output: out.id,
      outputColumns: result(out.id).table?.columns ?? [],
    };
    return { def };
  };

  /** Replaces the selected nodes with one subgraph node: downstream readers and outputs read it instead. */
  const replaceWithSubgraph = (ids: string[], def: Subgraph, inputs: string[], outId: string) => {
    const set = new Set(ids);
    const first = nodes.find((n) => set.has(n.id));
    const nodeId = uid();
    change((p) => {
      const node: PipelineNode = { id: nodeId, kind: "subgraph", name: def.name, subgraph: def.id, inputs, x: first?.x ?? 80, y: first?.y ?? 80 };
      const swap = (r: string) => (refNode(r) === outId ? nodeId : r);
      return {
        ...p,
        subgraphs: (p.subgraphs ?? []).some((s) => s.id === def.id) ? (p.subgraphs ?? []).map((s) => (s.id === def.id ? def : s)) : [...(p.subgraphs ?? []), def],
        nodes: [...p.nodes.filter((n) => !set.has(n.id)).map((n) => remapInputs(n, swap)), node],
        outputs: p.outputs.map((o) => ({ ...o, node: swap(o.node) })),
      };
    });
    setSelected([nodeId]);
  };

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e) || editing || joinEdit || splitEdit || llmEdit || sgEdit || (dialog && dialog.kind !== "explain")) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (mod && key === "c" && selected.length) copy(selected);
      else if (mod && key === "v") {
        e.preventDefault();
        paste();
      } else if (mod && key === "a") {
        e.preventDefault();
        setSelected([...nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id), ...(pipeline.textNodes ?? []).map((t) => TXT + t.id)]);
      } else if (mod && key === "f") {
        e.preventDefault();
        setRail("search");
        setSearchKey((k) => k + 1);
      } else if (mod && key === "h") {
        e.preventDefault();
        hide(selected);
      } else if (mod && key === "k") {
        e.preventDefault();
        unhideAll();
      } else if (mod && key === "d") {
        e.preventDefault();
        selectRelated("children");
      } else if (mod && key === "e") {
        e.preventDefault();
        selectRelated("parents");
      } else if (mod && e.shiftKey && key === "l") {
        e.preventDefault();
        layout();
      } else if (mod && key === "s") {
        e.preventDefault();
        if (onSaveVersion) onSaveVersion(pipeline).then(() => setNotice({ text: "Saved a version of this branch.", ok: true }), (err: Error) => setNotice({ text: `Not saved: ${err.message}` }));
        else if (persist) persist(pipeline).then(() => setPersisted({ version: pipeline, failed: false }), (err: Error) => setNotice({ text: `Not saved: ${err.message}` }));
      } else if (e.key === "ArrowUp" && !mod) {
        e.preventDefault();
        fit();
      } else if (e.key === "Delete" || e.key === "Backspace") removeNodes(selected);
      else if (e.key === "Escape") {
        if (pick) return setPick(null);
        if (outputMenu) return setOutputMenu(null);
        setSelected([]);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- derived views

  const errors: PipelineError[] = useMemo(() => {
    const out: PipelineError[] = [];
    for (const n of nodes) {
      const r = result(n.id);
      if (r.error !== undefined && !/^Input ".*" failed/.test(r.error)) out.push({ node: n.id, title: n.name, detail: r.error });
    }
    for (const o of pipeline.outputs) {
      const r = outputResult(o, result(o.node));
      if (r.error && result(o.node).error === undefined) out.push({ output: o.id, title: o.name || "Unnamed output", detail: r.error });
    }
    return out;
  }, [nodes, pipeline.outputs, result]);
  const warnings = useMemo(() => pipelineWarnings(pipeline), [pipeline]);

  const badges = useMemo(() => {
    const m = new Map<string, GraphBadge[]>();
    const add = (id: string, b: GraphBadge) => m.set(id, [...(m.get(id) ?? []), b]);
    for (const n of nodes) {
      if (n.kind === "source" && n.sampling && n.sampling.kind !== "none") add(n.id, { icon: "filter", title: "Preview uses a sample of this input", tone: "info" });
      if (n.kind === "source" && n.mode === "incremental") add(n.id, { icon: "plus", title: "Incremental input: builds read new rows only", tone: "info" });
      if (n.kind === "source" && pipeline.datasets[n.datasetId]?.ref) add(n.id, { icon: "link", title: "Builds read the latest data from its source", tone: "info" });
      if (n.description) add(n.id, { icon: "comment", title: n.description, tone: "info" });
    }
    if (pipeline.showConversionChecks) for (const f of conversionFindings(pipeline, "faster")) if (f.node) add(f.node, { icon: "bolt", title: `Not supported in faster pipelines: ${f.detail}`, tone: "warn" });
    if (subgraph && sgOutput) add(sgOutput, { icon: "output", title: "Subgraph output", tone: "ok" });
    return m;
  }, [nodes, pipeline, subgraph, sgOutput]);


  const editNode = editing ? byId.get(editing) : undefined;
  const splitNode = splitEdit ? byId.get(splitEdit) : undefined;
  const llmNode = llmEdit ? byId.get(llmEdit) : undefined;
  const boardOpen = !!(editNode || joinEdit || splitNode || llmNode);
  const confirmPreview = prefs.previewMode === "confirm";
  const previewResult = (ref: string): NodeResult | null => (confirmPreview && !previewed.has(refNode(ref)) ? null : result(ref));

  // a hook above the subgraph editor's early return: below it, opening a nested subgraph changed the hook count and
  // React threw "Rendered fewer hooks than expected"
  const toggleAssist = useCallback(() => setAssist((a) => !a), []);

  // ---------------------------------------------------------------- nested subgraph editor
  if (sgEdit) {
    const synthetic: Pipeline = {
      ...pipeline,
      nodes: sgEdit.def.nodes,
      outputs: [],
      textNodes: [],
      folders: [],
      hidden: [],
      name: sgEdit.def.name,
    };
    return (
      <Builder
        key={sgEdit.def.id}
        initial={synthetic}
        subgraph={{
          def: sgEdit.def,
          onClose: () => setSgEdit(null),
          onApply: (def) => {
            if (sgEdit.replace?.length) {
              const outsideRefs = [...new Set(nodes.filter((n) => sgEdit.replace!.includes(n.id)).flatMap((n) => inputsOf(n).filter((r) => r && !sgEdit.replace!.includes(refNode(r)))))];
              replaceWithSubgraph(sgEdit.replace, def, outsideRefs, nodes.find((n) => sgEdit.replace!.includes(n.id) && n.id === sgEdit.def.output)?.id ?? sgEdit.def.output);
            } else saveSubgraph(def);
            setSgEdit(null);
            setNotice({ text: sgEdit.replace?.length ? `Subgraph "${def.name}" created and applied in place of the selected nodes.` : `Subgraph "${def.name}" saved — apply it from Reusables or a node's Subgraphs menu.`, ok: true });
          },
        }}
      />
    );
  }

  // ---------------------------------------------------------------- menus
  const legendItems = (ids: string[]): MenuItem[] => [
    ...pipeline.legend.map((c) => ({
      label: c.name,
      swatch: c.hex,
      run: () => change((p) => ({ ...p, nodes: p.nodes.map((x) => (ids.includes(x.id) ? { ...x, color: c.id } : x)), textNodes: (p.textNodes ?? []).map((t) => (ids.includes(TXT + t.id) ? { ...t, color: c.id } : t)) })),
    })),
    {
      icon: "plus",
      label: "Add color",
      run: () => {
        const colorId = uid();
        change((p) => ({
          ...p,
          legend: [...p.legend, { id: colorId, name: `Color ${p.legend.length + 1}`, hex: PALETTE[p.legend.length % PALETTE.length] }],
          nodes: p.nodes.map((x) => (ids.includes(x.id) ? { ...x, color: colorId } : x)),
          textNodes: (p.textNodes ?? []).map((t) => (ids.includes(TXT + t.id) ? { ...t, color: colorId } : t)),
        }));
      },
    },
    {
      icon: "x",
      label: "Clear color",
      run: () => change((p) => ({ ...p, nodes: p.nodes.map((x) => (ids.includes(x.id) ? { ...x, color: undefined } : x)), textNodes: (p.textNodes ?? []).map((t) => (ids.includes(TXT + t.id) ? { ...t, color: undefined } : t)) })),
    },
  ];

  // Data Lineage opens in a new tab, so unsaved pipeline edits stay here
  const openLineage = (node: string) => window.open(`/lineage?node=${encodeURIComponent(node)}`, "_blank", "noopener");

  const nodeMenu = (n: PipelineNode): MenuItem[] => {
    const chosen = selected.filter((s) => byId.has(s)).length > 1 && selected.includes(n.id) ? selected.filter((s) => byId.has(s)) : [n.id];
    const many = chosen.length > 1;
    const folders = pipeline.folders ?? [];
    return [
      ...(n.kind !== "source" ? [{ icon: "edit" as IconName, label: "Edit", run: () => open(n.id) }] : []),
      { icon: "table", label: "Open", hint: "Full data preview", run: () => setDialog({ kind: "dataset", ref: n.id }) },
      ...(n.kind === "source"
        ? [
            {
              icon: "split" as IconName,
              label: "Explore data lineage",
              run: () => {
                const ref = n.datasetId ? pipeline.datasets[n.datasetId]?.ref : undefined;
                openLineage(ref?.kind === "drive" ? `dataset:${ref.itemId}` : ref?.kind === "datasource" ? `datasource:${ref.id}` : `pipeline:${pipeline.id}`);
              },
            },
          ]
        : []),
      { icon: "edit", label: "Rename", run: () => rename(n.id) },
      {
        icon: "comment",
        label: n.description ? "Edit note" : "Add note",
        run: async () => {
          const d = (await promptDialog("Note shown on the node", n.description ?? ""));
          if (d !== null) updateNode(n.id, { description: d.trim() || undefined });
        },
      },
      { divider: true },
      { icon: "transform", label: "Transform", run: () => newTransform(n.id) },
      { icon: "join", label: "Join", run: () => startPick("join", [n.id]) },
      { icon: "union", label: "Union", run: () => startPick("union", chosen) },
      { icon: "split", label: "Split", run: () => newSplit(n.id) },
      { icon: "sparkle", label: "Use LLM", run: () => newLlm(n.id) },
      { icon: "cpu", label: "Trained model", run: () => setDialog({ kind: "model", input: n.id }) },
      { icon: "bolt", label: "Generate with AI…", run: () => setDialog({ kind: "generate", from: n.id }) },
      {
        submenu: "Subgraphs",
        icon: "layers",
        items: [
          { icon: "layers", label: "Apply subgraph", run: () => startSubgraphPick(chosen) },
          {
            icon: "plus",
            label: "Create subgraph",
            run: () => {
              const r = subgraphFrom(chosen);
              if (r.error) return setNotice({ text: r.error });
              setDialog({ kind: "createSubgraph", ids: chosen, replace: false });
            },
          },
          { icon: "refresh", label: "Replace with subgraph", disabled: !(pipeline.subgraphs ?? []).length && "No subgraphs yet", run: () => setDialog({ kind: "createSubgraph", ids: chosen, replace: true }) },
        ],
      },
      { icon: "output", label: "Add output…", run: () => (setSelected([n.id]), setOutputMenu(n.id)) },
      { divider: true },
      { icon: "copy", label: many ? `Copy ${chosen.length} nodes` : "Copy", shortcut: "Ctrl+C", run: () => copy(chosen) },
      { icon: "copy", label: "Paste", shortcut: "Ctrl+V", disabled: !readClip(), run: () => paste() },
      { icon: "layers", label: "Duplicate", run: () => duplicate(chosen) },
      {
        submenu: "Hide nodes",
        icon: "eye",
        items: [
          { label: many ? `Hide ${chosen.length} selected nodes` : "Hide selected nodes", shortcut: "Ctrl+H", run: () => hide(chosen) },
          { label: "Hide other nodes", run: () => hide(chosen, true) },
        ],
      },
      {
        submenu: "Select",
        icon: "check",
        items: [
          { label: "Select parents", shortcut: "Ctrl+E", run: () => selectRelated("parents") },
          { label: "Select children", shortcut: "Ctrl+D", run: () => selectRelated("children") },
        ],
      },
      ...(n.kind !== "source" && n.kind !== "input"
        ? [{ icon: "star" as IconName, label: n.checkpoint ? "Unmark checkpoint" : "Mark as checkpoint", hint: "Computed once per build, shared by its outputs", run: () => chosen.forEach((id) => updateNode(id, { checkpoint: !n.checkpoint })) }]
        : []),
      ...(n.kind === "source"
        ? [
            ...(pipeline.datasets[n.datasetId]?.ref ? [{ icon: "refresh" as IconName, label: "Refresh from source", hint: sourceLabel(pipeline.datasets[n.datasetId]!.ref!), run: () => refresh(n) }] : []),
            ...(pipeline.datasets[n.datasetId]?.origin === "Entered manually" ? [{ icon: "keyboard" as IconName, label: "Edit data / generate", run: () => setDialog({ kind: "manual", id: n.id }) }] : []),
            { icon: "filter" as IconName, label: "Sampling strategies…", run: () => setDialog({ kind: "sampling", id: n.id }) },
            {
              icon: "check" as IconName,
              label: `Pre-conditions…${pipeline.datasets[n.datasetId]?.preconditions?.length ? ` (${pipeline.datasets[n.datasetId]!.preconditions!.length})` : ""}`,
              hint: "Checks on the input before a build runs",
              run: () => setDialog({ kind: "preconditions", id: n.id }),
            },
            {
              submenu: "Computation mode",
              icon: "refresh" as IconName,
              items: [
                { label: "Snapshot", hint: "Each build reads every row", checked: (n.mode ?? "snapshot") === "snapshot", run: () => updateNode(n.id, { mode: "snapshot" } as Partial<PipelineNode>) },
                { label: "Incremental", hint: "Each build reads only rows added since the last one", checked: n.mode === "incremental", disabled: supportsIncremental(pipeline) ? undefined : "Incremental computation is not supported by this pipeline's engine (DuckDB local / external read every row)", run: () => updateNode(n.id, { mode: "incremental" } as Partial<PipelineNode>) },
              ],
            } as MenuItem,
          ]
        : []),
      ...(subgraph && n.kind !== "input"
        ? [{ icon: "output" as IconName, label: "Set as subgraph output", run: () => setSgOutput(n.id) }]
        : []),
      {
        submenu: "Move to folder",
        icon: "folder",
        items: [
          ...folders.map((f) => ({ icon: "folder" as IconName, label: f.name, checked: n.folder === f.id, run: () => change((p) => ({ ...p, nodes: p.nodes.map((x) => (chosen.includes(x.id) ? { ...x, folder: f.id } : x)) })) })),
          {
            icon: "folderPlus",
            label: "New folder",
            run: async () => {
              const id = uid();
              const name = (await promptDialog("Folder name", "New folder"));
              if (!name) return;
              change((p) => ({ ...p, folders: [...(p.folders ?? []), { id, name, parent: null }], nodes: p.nodes.map((x) => (chosen.includes(x.id) ? { ...x, folder: id } : x)) }));
            },
          },
          ...(n.folder ? [{ icon: "x" as IconName, label: "Remove from folder", run: () => change((p) => ({ ...p, nodes: p.nodes.map((x) => (chosen.includes(x.id) ? { ...x, folder: undefined } : x)) })) }] : []),
        ],
      },
      { submenu: "Color nodes", icon: "palette", items: legendItems(chosen) },
      { icon: "bolt", label: "Explain", run: () => setDialog({ kind: "explain", ids: chosen }) },
      { divider: true },
      { icon: "trash", label: many ? `Remove ${chosen.length} nodes` : "Remove node", danger: true, run: () => removeNodes(chosen) },
    ];
  };

  const contextItems = (id: string): MenuItem[] => {
    if (id.startsWith(OUT))
      return [
        { icon: "edit", label: "Edit", run: () => (setSelected([id]), setRail("outputs")) },
        { icon: "edit", label: "Rename", run: () => rename(id) },
        {
          icon: "comment",
          label: pipeline.outputs.find((o) => o.id === id.slice(OUT.length))?.description ? "Edit note" : "Add note",
          run: async () => {
            const oid = id.slice(OUT.length);
            const d = await promptDialog("Note on the output: what it is for and who reads it", pipeline.outputs.find((o) => o.id === oid)?.description ?? "");
            if (d !== null) change((p) => ({ ...p, outputs: p.outputs.map((o) => (o.id === oid ? { ...o, description: d.trim() || undefined } : o)) }));
          },
        },
        { icon: "upload", label: "Deploy", run: () => deploy([id.slice(OUT.length)]) },
        {
          icon: "split",
          label: "Explore data lineage",
          run: () => {
            const out = pipeline.outputs.find((o) => o.id === id.slice(OUT.length));
            openLineage(out?.deployed?.itemId ? `dataset:${out.deployed.itemId}` : `pipeline:${pipeline.id}`);
          },
        },
        { icon: "eye", label: "Hide", run: () => change((p) => ({ ...p, hidden: [...(p.hidden ?? []), id] }), false) },
        { icon: "trash", label: "Remove output", danger: true, run: () => removeNodes([id]) },
      ];
    if (id.startsWith(TXT)) {
      const ids = selected.includes(id) ? selected : [id];
      return [
        { submenu: "Color nodes", icon: "palette", items: legendItems(ids) },
        { icon: "copy", label: "Copy", run: () => copy(ids) },
        { icon: "layers", label: "Duplicate", run: () => duplicate(ids) },
        { icon: "trash", label: "Remove text node", danger: true, run: () => removeNodes(ids) },
      ];
    }
    const n = byId.get(id);
    return n ? nodeMenu(n) : [];
  };

  const sources = nodes.filter((n): n is SourceNode => n.kind === "source");
  const hiddenCount = nodes.filter((n) => hidden.has(n.id)).length;

  // ---------------------------------------------------------------- render
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-4 text-sm">
        {subgraph ? (
          <>
            <Icon name="layers" className="h-4 w-4 text-ocean" />
            <span className="text-muted">Subgraph</span>
            <input
              value={pipeline.name}
              onChange={(e) => change((p) => ({ ...p, name: e.target.value }), false)}
              aria-label="Subgraph name"
              className="w-64 rounded-md border border-line-2 bg-ink px-2 py-1 font-medium outline-none focus:border-ocean"
            />
            <span className="text-xs text-muted">
              {sgInputs.length} input{sgInputs.length === 1 ? "" : "s"} · output: {sgOutput ? (byId.get(sgOutput)?.name ?? "missing") : "not set"}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <ToolButton icon="left" label="Undo" onClick={undo} disabled={!past.length || boardOpen} hideLabel shortcut="Ctrl+Z" />
              <ToolButton icon="right" label="Redo" onClick={redo} disabled={!future.length || boardOpen} hideLabel shortcut="Ctrl+Shift+Z" />
              <button
                type="button"
                disabled={!sgOutput || !byId.has(sgOutput) || !pipeline.name.trim()}
                title={sgOutput ? "Save the subgraph" : "Right-click a node → Set as subgraph output first"}
                onClick={() => {
                  const inputIds = new Set(nodes.filter((n): n is InputNode => n.kind === "input").map((n) => n.inputId));
                  const out = sgOutput;
                  subgraph.onApply({
                    ...subgraph.def,
                    name: pipeline.name.trim(),
                    nodes,
                    inputs: sgInputs.filter((i) => inputIds.has(i.id)),
                    output: out,
                    outputColumns: result(out).table?.columns ?? subgraph.def.outputColumns,
                    updatedAt: new Date().toISOString(),
                  });
                }}
                className={buttonClass.primary}
              >
                <Icon name="check" className="h-3.5 w-3.5" /> Apply all subgraph changes
              </button>
              <button type="button" onClick={async () => (await confirmDialog("Close the subgraph without applying its changes?")) && subgraph.onClose()} className={buttonClass.secondary}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Link href="/pipeline" title="Pipeline Builder — all pipelines" className="shrink-0 text-muted hover:text-white">
                <Icon name="pipeline" className="h-4 w-4" />
              </Link>
              <input
                value={pipeline.name}
                onChange={(e) => change((p) => ({ ...p, name: e.target.value }), false)}
                onBlur={(e) => !e.target.value.trim() && change((p) => ({ ...p, name: "Pipeline" }), false)}
                aria-label="Pipeline name"
                size={Math.min(28, Math.max(8, pipeline.name.length + 1))}
                className="min-w-[7rem] shrink rounded-md border border-transparent bg-transparent px-1.5 py-1 font-medium outline-none hover:border-line-2 focus:border-ocean"
              />
              {/* "Batch", not "Batch · Duckdb" (the user, 2026-10-30): the engine stays in Build settings and the tooltip */}
              <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[11px] capitalize text-soft ring-1 ring-line-2"
                title={pipeline.compute === "duckdb" ? "Pipeline type · engine DuckDB local (Build settings)" : "Pipeline type"}>
                {pipeline.type}
                {pipeline.type === "batch" && pipeline.compute && pipeline.compute !== "standard" && pipeline.compute !== "duckdb" ? ` · ${pipeline.compute}` : ""}
              </span>
              {header?.({ pipeline, saveState })}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span
                title={saveState === "error" ? "The draft could not be written" : saveState === "saving" ? "Writing the draft…" : onSaveVersion ? "Your working copy is kept; Save records a version" : "Saved"}
                className={`flex items-center text-xs ${saveState === "error" ? "text-bad" : "text-muted"}`}
              >
                <Icon name={saveState === "error" ? "alert" : saveState === "saving" ? "refresh" : "check"} className={`h-3.5 w-3.5 ${saveState === "saving" ? "animate-spin" : ""}`} />
              </span>
              <ToolButton icon="left" label="Undo" onClick={undo} disabled={!past.length || boardOpen} hideLabel shortcut="Ctrl+Z" />
              <ToolButton icon="right" label="Redo" onClick={redo} disabled={!future.length || boardOpen} hideLabel shortcut="Ctrl+Shift+Z" />
              <DropMenu
                label="Help"
                icon="info"
                hideLabel
                title="Help"
                align="right"
                items={[
                  { icon: "keyboard", label: "View hotkeys", run: () => setDialog({ kind: "hotkeys" }) },
                  { icon: "external", label: "Pipeline Builder documentation", run: () => window.open("https://www.palantir.com/docs/foundry/pipeline-builder/overview/", "_blank", "noopener") },
                ]}
              />
              <DropMenu
                label="Settings"
                icon="sliders"
                hideLabel
                title="Settings"
                align="right"
                items={[
                  { icon: "sliders", label: "User preferences", run: () => setDialog({ kind: "prefs" }) },
                  { icon: "sliders", label: "Parameters", run: () => setDialog({ kind: "parameters" }) },
                  { icon: "cpu", label: "Build settings", run: () => setDialog({ kind: "buildSettings" }) },
                  ...(pipeline.type === "batch" && (pipeline.compute ?? "standard") === "standard"
                    ? [{ icon: "code" as IconName, label: "Export code", hint: "Python transforms in a Code Repository", run: () => setDialog({ kind: "exportCode" }) }]
                    : []),
                  ...(pipeline.type === "batch" && (pipeline.compute ?? "standard") === "standard"
                    ? [{ icon: "bolt" as IconName, label: "Convert to Faster pipeline", hint: "DataFusion-style engine for small and medium data", run: () => setDialog({ kind: "convert", to: "faster" }) }]
                    : []),
                  ...(pipeline.type === "batch" && pipeline.compute === "faster"
                    ? [{ icon: "table" as IconName, label: "Convert to Batch pipeline", hint: "Back to the standard (Spark-style) engine", run: () => setDialog({ kind: "convert", to: "standard" }) }]
                    : []),
                  {
                    label: "Show pipeline conversion checks",
                    hint: "List what faster pipelines would not support",
                    checked: !!pipeline.showConversionChecks,
                    run: () => change((p) => ({ ...p, showConversionChecks: !p.showConversionChecks }), false),
                  },
                ]}
              />
              {latestBuild && (
                <button type="button" title="Builds and checks status" onClick={() => setRail("builds")} className="rounded-md px-2 py-1 hover:bg-panel-2">
                  <StatusBadge status={latestBuild.status} />
                </button>
              )}
              {activeBuild && (
                <button
                  type="button"
                  data-stop-build
                  onClick={() => stopBuild(activeBuild)}
                  title={activeBuild.streaming || pipeline.type === "streaming" ? "Stop the running streaming job" : "Stop the running build"}
                  className={`${buttonClass.secondary} py-1 text-xs text-bad`}
                >
                  <Icon name="stop" className="h-3.5 w-3.5" />
                  {activeBuild.streaming || pipeline.type === "streaming" ? "Stop streaming" : "Stop build"}
                </button>
              )}
              <button
                type="button"
                disabled={!pipeline.outputs.length || boardOpen || deploying}
                title={pipeline.outputs.length ? "Save and deploy the pipeline outputs" : "Add a pipeline output first"}
                onClick={() => deploy(pipeline.outputs.map((o) => o.id))}
                className={buttonClass.primary}
              >
                <Icon name={deploying ? "refresh" : "upload"} className={`h-3.5 w-3.5 ${deploying ? "animate-spin" : ""}`} />
                {deploying ? "Deploying…" : "Deploy"}
              </button>
              <ToolButton
                icon="split"
                label="Data lineage"
                hideLabel
                title="Explore data lineage: where this pipeline's inputs come from and what uses its outputs"
                onClick={() => openLineage(`pipeline:${pipeline.id}`)}
              />
              <ToolButton icon="cpu" label="Build settings" hideLabel onClick={() => setDialog({ kind: "buildSettings" })} />
              <ToolButton icon="link" label="Share" hideLabel title="Share: details, access and roles" onClick={() => setRail("details")} />
            </div>
          </>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {joinEdit ? (
            <JoinEditor
              key={joinEdit.id ?? "new"}
              initial={joinEdit.config}
              isNew={!joinEdit.id}
              nodes={nodes.filter((n) => n.id !== joinEdit.id)}
              result={result}
              onApply={(c) => {
                if (joinEdit.id) updateNode(joinEdit.id, c);
                else {
                  const id = addNode({ kind: "join", ...c } as Omit<PipelineNode, "id" | "x" | "y">, [c.left, c.right]);
                  setJoinEdit({ id, config: c });
                  return;
                }
                setJoinEdit({ id: joinEdit.id, config: c });
              }}
              onClose={() => setJoinEdit(null)}
            />
          ) : editNode?.kind === "transform" ? (
            <TransformEditor
              key={editNode.id}
              node={editNode}
              input={result(editNode.input).table ?? null}
              inputName={refLabel(nodes, editNode.input)}
              inputError={result(editNode.input).error}
              context={editContext}
              functions={pipeline.functions}
              parameters={pipeline.parameters}
              autoName={prefs.autoName}
              onApply={(name: string, steps: Step[]) => updateNode(editNode.id, { name, steps })}
              onCreateFunction={(fn: CustomFunction) => change((p) => ({ ...p, functions: [...(p.functions ?? []), fn] }))}
              onClose={() => setEditing(null)}
            />
          ) : splitNode?.kind === "split" ? (
            <SplitEditor
              key={splitNode.id}
              initial={splitNode}
              input={result(splitNode.input)}
              inputName={refLabel(nodes, splitNode.input)}
              onApply={(c) => updateNode(splitNode.id, c)}
              onClose={() => setSplitEdit(null)}
            />
          ) : llmNode?.kind === "llm" ? (
            <LlmEditor
              key={llmNode.id}
              node={llmNode}
              input={result(llmNode.input)}
              output={result(llmNode.id)}
              inputName={refLabel(nodes, llmNode.input)}
              onApply={(name: string, config: LlmConfig) => updateNode(llmNode.id, { name, config })}
              onClose={() => setLlmEdit(null)}
            />
          ) : (
            <>
              {banner}
              {/* wraps when narrow: a scrolling toolbar would clip its dropdowns (Add data, More, Add output, Legend) */}
              <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-0.5 border-b border-line bg-panel px-2 py-1">
                <ToolButton icon="move" label="Panning mode" hideLabel active={mode === "pan"} onClick={() => setMode("pan")} title="Panning mode: drag the background to move around" />
                <ToolButton icon="grid" label="Drag select mode" hideLabel active={mode === "select"} onClick={() => setMode("select")} title="Drag select mode: drag to select nodes (or hold Shift)" />
                <ToolButton icon="check" label="Select all" hideLabel shortcut="Ctrl+A" onClick={() => setSelected(nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id))} />
                <ToolButton icon="trash" label="Remove" hideLabel danger disabled={!selected.length} onClick={() => removeNodes(selected)} />
                <ToolButton icon="graph" label="Layout" hideLabel shortcut="Ctrl+Shift+L" onClick={layout} disabled={!nodes.length} />
                <ToolButton icon="pencil" label="Text" hideLabel title="Add new text node" onClick={addText} />
                <span className="mx-1 h-5 w-px shrink-0 bg-line-2" />
                {subgraph ? (
                  <ToolButton icon="download" label="Add input" onClick={newInput} />
                ) : (
                  <DropMenu
                    label="Add data"
                    icon="download"
                    width="w-80"
                    items={ADD_OPTIONS.map((o) => ({ icon: o.icon, label: o.label, hint: o.hint, run: () => setDialog({ kind: "add", mode: o.mode }) }))}
                  />
                )}
                <ToolButton icon="sliders" label="Parameters" hideLabel onClick={() => setDialog({ kind: "parameters" })} />
                <DropMenu
                  label="Reusables"
                  icon="layers"
                  items={[
                    { icon: "code", label: "Custom expressions", run: () => setDialog({ kind: "reusables", tab: "expressions" }) },
                    { icon: "transform", label: "Custom transform paths", run: () => setDialog({ kind: "reusables", tab: "transforms" }) },
                    { icon: "code", label: "User-defined functions", run: () => setDialog({ kind: "reusables", tab: "udfs" }) },
                    ...(subgraph ? [] : [{ icon: "layers" as IconName, label: "Subgraphs", run: () => setDialog({ kind: "reusables", tab: "subgraphs" }) }]),
                  ]}
                />
                <span className="mx-1 h-5 w-px shrink-0 bg-line-2" />
                <ToolButton icon="transform" label="Transform" disabled={!single} onClick={() => single && newTransform(single.id)} />
                <ToolButton icon="join" label="Join" disabled={!selected.length || selected.length > 2 || selected.some((s) => !byId.has(s))} onClick={() => startPick("join", selected)} />
                <ToolButton icon="union" label="Union" disabled={!selected.length || selected.some((s) => !byId.has(s))} onClick={() => startPick("union", selected)} />
                <ToolButton icon="split" label="Split" title="Split table" disabled={!single || pipeline.type === "streaming"} onClick={() => single && newSplit(single.id)} />
                <ToolButton icon="sparkle" label="Use LLM" disabled={!single} onClick={() => single && newLlm(single.id)} />
                <DropMenu
                  label="More"
                  items={[
                    { icon: "cpu", label: "Trained model", disabled: !single && "Select a node", run: () => single && setDialog({ kind: "model", input: single.id }) },
                    ...(subgraph ? [] : [{ icon: "layers" as IconName, label: "Apply subgraph to table", disabled: !selected.some((s) => byId.has(s)) && "Select the start node(s)", run: () => startSubgraphPick(selected) }]),
                    { icon: "bolt", label: "Generate with AI", disabled: !single && "Select a node", run: () => single && setDialog({ kind: "generate", from: single.id }) },
                  ]}
                />
                <ToolButton icon="bolt" label="Explain" hideLabel title="Explain the selected nodes (AI)" disabled={!selected.some((s) => byId.has(s))} onClick={() => setDialog({ kind: "explain", ids: selected.filter((s) => byId.has(s)) })} />
                <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
                  <AipAssistButton open={assist} onToggle={toggleAssist} className="mr-1" />
                  {!subgraph && <AddOutputMenu onAdd={single ? (kind) => addOutput(single.id, kind) : null} />}
                  <span className="mx-1 h-5 w-px bg-line-2" />
                  <ToolButton icon="minus" label="Zoom out" hideLabel onClick={() => setZoom((z) => Math.max(0.2, +(z - 0.1).toFixed(2)))} />
                  <button type="button" onClick={() => setZoom(1)} title="Reset zoom" className="w-11 text-center text-xs tabular-nums text-muted hover:text-white">
                    {Math.round(zoom * 100)}%
                  </button>
                  <ToolButton icon="plus" label="Zoom in" hideLabel onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))} />
                  <ToolButton icon="fit" label="Zoom to fit" hideLabel shortcut="↑" onClick={() => fit()} />
                  <span className="mx-1 h-5 w-px bg-line-2" />
                  <Legend pipeline={pipeline} selected={selected} change={change} hiddenCount={hiddenCount} onShowAll={unhideAll} />
                </div>
              </div>

              <div
                id={SCROLLER}
                className="relative flex min-h-0 flex-1"
                onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files.length && !subgraph) setDialog({ kind: "add", mode: "upload", files: [...e.dataTransfer.files] });
                }}
              >
                <Graph
                  nodes={nodes}
                  outputs={outputViews}
                  textNodes={pipeline.textNodes ?? []}
                  legend={pipeline.legend}
                  result={result}
                  selected={testPick ? testPick.ids : pick ? [...pick.ids, ...(pick.kind === "subgraph" ? pick.inputs : [])] : selected}
                  zoom={zoom}
                  setZoom={setZoom}
                  hidden={hidden}
                  prefs={prefs}
                  mode={mode}
                  functions={pipeline.functions}
                  subgraphs={pipeline.subgraphs}
                  badges={badges}
                  readOnly={readOnly}
                  onSelect={(id, additive) => {
                    if (testPick) {
                      const n = byId.get(id);
                      if (!n) return;
                      if (testPick.kind === "eval") return n.kind === "llm" && setTestPick({ ...testPick, ids: [id] });
                      if (n.kind === "source") return;
                      return setTestPick({ ...testPick, ids: testPick.ids.includes(id) ? testPick.ids.filter((x) => x !== id) : [...testPick.ids, id] });
                    }
                    if (pick) return pickNode(id);
                    setOutputMenu(null);
                    setSelected(additive ? (selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]) : [id]);
                  }}
                  onSelectMany={(ids, additive) => setSelected(additive ? [...new Set([...selected, ...ids])] : ids)}
                  onClear={() => {
                    if (pick) return;
                    setSelected([]);
                    setMenu(null);
                    setOutputMenu(null);
                  }}
                  onMoveStart={() => change((p) => p)}
                  onMove={(moves) =>
                    change((p) => {
                      const m = new Map(moves.map((x) => [x.id, x]));
                      return {
                        ...p,
                        nodes: p.nodes.map((n) => (m.has(n.id) ? { ...n, x: m.get(n.id)!.x, y: m.get(n.id)!.y } : n)),
                        outputs: p.outputs.map((o) => (m.has(OUT + o.id) ? { ...o, x: m.get(OUT + o.id)!.x, y: m.get(OUT + o.id)!.y } : o)),
                        textNodes: (p.textNodes ?? []).map((t) => (m.has(TXT + t.id) ? { ...t, x: m.get(TXT + t.id)!.x, y: m.get(TXT + t.id)!.y } : t)),
                      };
                    }, false)
                  }
                  onOpen={open}
                  onPort={(id) => {
                    setSelected([id]);
                    setOutputMenu(id);
                  }}
                  onConnect={connect}
                  onPortDrop={(from, x, y, cx, cy) => {
                    setSelected([refNode(from)]);
                    setPortDrop({ from, x, y, cx, cy });
                  }}
                  onDropDataset={subgraph ? undefined : (payload, x, y) => void dropDatasets(payload, x, y)}
                  onTextChange={(id, patch, record) => change((p) => ({ ...p, textNodes: (p.textNodes ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)) }), record)}
                  onShowInputs={showInputs}
                  onSourceMode={setInputMode}
                  onContextMenu={(id, x, y) => {
                    if (id.startsWith(GRP)) return;
                    if (!selected.includes(id)) setSelected([id]);
                    setMenu({ id, x, y });
                  }}
                  toolbar={
                    !pick &&
                    !testPick &&
                    single &&
                    (outputMenu === single.id ? (
                      <OutputKindList
                        onPick={(kind) => {
                          setOutputMenu(null);
                          addOutput(single.id, kind);
                        }}
                        external={pipeline.compute === "external"}
                      />
                    ) : (
                      <NodeToolbar
                        node={single}
                        streaming={pipeline.type === "streaming"}
                        onTransform={() => newTransform(single.id)}
                        onJoin={() => startPick("join", [single.id])}
                        onUnion={() => startPick("union", [single.id])}
                        onSplit={() => newSplit(single.id)}
                        onLlm={() => newLlm(single.id)}
                        onSubgraph={() => startSubgraphPick([single.id])}
                        onGenerate={() => setDialog({ kind: "generate", from: single.id })}
                        onOutput={subgraph ? undefined : () => setOutputMenu(single.id)}
                        onEdit={() => open(single.id)}
                        onDelete={() => removeNodes([single.id])}
                      />
                    ))
                  }
                />
                {portDrop && (
                  <div className="fixed inset-0 z-40" onPointerDown={() => setPortDrop(null)}>
                    <div
                      className="absolute w-56 rounded-lg border border-line-2 bg-panel p-1 text-xs shadow-xl"
                      style={{ left: portDrop.cx, top: portDrop.cy }}
                      onPointerDown={(e) => e.stopPropagation()}
                      data-port-drop-menu
                    >
                      <div className="px-2 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-muted">Next step from {refLabel(nodes, portDrop.from)}</div>
                      {(
                        [
                          ["transform", "transform", "Transform", "Add steps (filter, cast, formulas…)"],
                          ["sql", "code", "SQL transform", "A SQL query over this and any other node"],
                          ["join", "join", "Join…", "Then click the other input"],
                          ["union", "union", "Union…", "Then click the other inputs"],
                          ["output", "output", "Output", "A dataset, object type or other output"],
                        ] as const
                      ).map(([k, icon, label, hint]) => (
                        <button key={k} type="button" onClick={() => portStep(k)} className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2" data-step={k}>
                          <Icon name={icon} className="mt-0.5 h-3.5 w-3.5 text-ocean" />
                          <span>
                            <span className="block font-medium">{label}</span>
                            <span className="text-[10.5px] text-muted">{hint}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {dropping && (
                  <p className="fixed left-1/2 top-4 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-lg bg-panel px-4 py-2 text-sm text-muted shadow-xl">
                    <Icon name="refresh" /> Reading {dropping}…
                  </p>
                )}
                {pick && (
                  <PickBanner
                    pick={pick}
                    nodes={nodes}
                    subgraphs={pipeline.subgraphs ?? []}
                    onChange={setPick}
                    onStart={finishPick}
                    onCancel={() => setPick(null)}
                  />
                )}
                {testPick && (
                  <div className="absolute bottom-4 left-1/2 z-30 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-line-2 bg-panel-2 px-4 py-3 text-sm shadow-2xl">
                    <span className="min-w-0 flex-1">
                      {testPick.kind === "eval"
                        ? testPick.ids.length
                          ? `Evaluate "${byId.get(testPick.ids[0])?.name}"`
                          : "Select the Use LLM node to evaluate on the graph."
                        : testPick.ids.length
                          ? `${testPick.ids.length} transform node${testPick.ids.length > 1 ? "s" : ""} to test: ${testPick.ids.map((i) => byId.get(i)?.name).join(", ")}`
                          : "Select the transform nodes to test on the graph."}
                    </span>
                    <button
                      type="button"
                      disabled={!testPick.ids.length}
                      onClick={() => {
                        if (testPick.kind === "eval") {
                          const id = uid();
                          change((p) => ({ ...p, evalSuites: [...(p.evalSuites ?? []), { id, name: "New evaluation", node: testPick.ids[0], testData: { columns: [], rows: [] }, evaluators: [] }] }));
                          setEvalEdit(id);
                        } else if (testPick.testId) {
                          const tid = testPick.testId;
                          change((p) => ({ ...p, unitTests: (p.unitTests ?? []).map((t) => (t.id === tid ? { ...t, nodes: testPick.ids } : t)) }));
                          setUnitEdit(tid);
                        } else {
                          const id = uid();
                          change((p) => ({ ...p, unitTests: [...(p.unitTests ?? []), { id, name: `Test ${(p.unitTests ?? []).length + 1}`, nodes: testPick.ids, inputs: {}, expected: {} }] }));
                          setUnitEdit(id);
                        }
                        setTestPick(null);
                      }}
                      className={buttonClass.primary}
                    >
                      Start
                    </button>
                    <button type="button" onClick={() => setTestPick(null)} title="Cancel" className="rounded p-1 text-muted hover:bg-panel hover:text-white">
                      <Icon name="x" className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {nodes.length === 0 && !subgraph && <Welcome onPick={(m) => setDialog({ kind: "add", mode: m })} />}
                {nodes.length === 0 && subgraph && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <button type="button" onClick={newInput} className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border border-dashed border-ocean/60 bg-panel px-5 py-4 text-sm hover:bg-panel-2">
                      <Icon name="plus" className="h-4 w-4 text-ocean" /> Add input
                    </button>
                  </div>
                )}
                {pipeline.managedBy && (
                  <div className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-ocean/40 bg-panel px-3 py-1.5 text-xs shadow-lg">
                    <Icon name="bolt" className="h-3.5 w-3.5 text-ocean" />
                    <span className="text-soft">
                      Generated by HyperAuto <b className="text-white">{pipeline.managedBy.name}</b> — change it through its configuration (a proposal); direct edits are replaced on the next proposal.
                    </span>
                    <a href="/sources" className="text-ocean hover:underline">
                      Open HyperAuto
                    </a>
                  </div>
                )}
                {notice && (
                  <div className={`absolute bottom-4 left-4 z-40 flex max-w-xl items-start gap-2 rounded-lg border bg-panel px-3 py-2 text-sm shadow-xl ${notice.ok ? "border-ok/40 text-ok" : "border-bad/40 text-bad"}`}>
                    <Icon name={notice.ok ? "check" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex-1">{notice.text}</span>
                    <button type="button" onClick={() => setNotice(null)} className="text-muted hover:text-white">
                      <Icon name="x" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {services.busy && (
                  <span className="absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-full bg-panel px-2.5 py-1 text-xs text-soft shadow ring-1 ring-line-2">
                    <Icon name="refresh" className="h-3 w-3 animate-spin text-ocean" /> Computing LLM / media values…
                  </span>
                )}
              </div>

              <BottomPanel
                pipeline={pipeline}
                node={single}
                output={singleOutput ? { o: shownOutputs.find((o) => o.id === singleOutput.id) ?? singleOutput, ...outputResult(singleOutput, result(singleOutput.node)) } : undefined}
                count={selected.length}
                result={(ref) => previewResult(ref) ?? ({ error: "" } as NodeResult)}
                pager={pagerOf}
                errors={errors}
                warnings={warnings}
                tab={bottomTab}
                setTab={setBottomTab}
                confirmPreview={confirmPreview && !!single && !previewed.has(single.id)}
                onRunPreview={() => single && setPreviewed(new Set([...previewed, single.id]))}
                onRename={(name) => single && updateNode(single.id, { name }, false)}
                extra={testResult ? { label: "Unit test results", content: <TestResultView name={testResult.name} run={testResult.run} /> } : undefined}
                onGo={(id) => {
                  setSelected([id]);
                  if (byId.has(id)) {
                    if (hidden.has(id)) change((p) => ({ ...p, hidden: (p.hidden ?? []).filter((h) => h !== id) }), false);
                    fit([id]);
                  }
                }}
              />
            </>
          )}
        </div>

        {!boardOpen && rail === "outputs" && !subgraph && (
          <OutputsPanel
            outputs={shownOutputs}
            nodes={nodes}
            result={result}
            selected={singleOutput ? shownOutputs.find((o) => o.id === singleOutput.id) : undefined}
            onSelect={(outputId) => setSelected(outputId ? [OUT + outputId] : [])}
            onAdd={single ? (kind) => addOutput(single.id, kind) : null}
            onChange={(outputId, patch) => updateOutput(outputId, patch)}
            onRemove={(outputId) => removeNodes([OUT + outputId])}
            onDeploy={deploy}
            location={pipeline.location}
            deploying={deploying}
            pipeline={pipeline}
            onClose={() => setRail(null)}
          />
        )}
        {!boardOpen && rail === "folders" && (
          <FoldersPanel
            pipeline={pipeline}
            selected={selected}
            onSelect={(ids, additive) => setSelected(additive ? [...new Set([...selected, ...ids])] : ids)}
            change={change}
            onCenter={(ids) => ids.length && fit(ids)}
            onRemoveNodes={(ids) => removeNodes(ids, false)}
            onClose={() => setRail(null)}
          />
        )}
        {!boardOpen && rail === "builds" && !subgraph && (
          <BuildsPanel pipelineId={pipeline.id} builds={runs.builds} error={runs.error} onRefresh={runs.refresh} onClose={() => setRail(null)} />
        )}
        {!boardOpen && rail === "schedules" && !subgraph && <SchedulesPanel pipeline={pipeline} builds={runs.builds} change={change} onClose={() => setRail(null)} />}
        {!boardOpen && rail === "details" && !subgraph && (
          <DetailsPanel
            pipeline={pipeline}
            user={prefs.userName?.trim() || "You"}
            change={change}
            onGoNode={(id) => {
              setSelected([id]);
              fit([id]);
            }}
            onClose={() => setRail(null)}
          />
        )}
        {!boardOpen && rail === "tests" && (
          <UnitTestsPanel
            pipeline={pipeline}
            change={change}
            onNew={() => setTestPick({ kind: "test", ids: selected.filter((s) => byId.has(s) && byId.get(s)!.kind !== "source") })}
            onEdit={setUnitEdit}
            onShowResult={(r) => {
              setTestResult(r);
              setBottomTab("extra");
            }}
            onClose={() => setRail(null)}
          />
        )}
        {!boardOpen && rail === "evals" && (
          <EvalSuitesPanel
            pipeline={pipeline}
            onOpen={setEvalEdit}
            onNew={() => setTestPick({ kind: "eval", ids: single?.kind === "llm" ? [single.id] : [] })}
            onClose={() => setRail(null)}
          />
        )}
        {!boardOpen && rail === "data" && !subgraph && <DataPanel onClose={() => setRail(null)} />}
        {!boardOpen && rail === "search" && (
          <SearchPanel
            key={searchKey}
            pipeline={pipeline}
            result={result}
            onGo={(id) => {
              setSelected([id]);
              fit([id]);
            }}
            change={change}
            onClose={() => setRail(null)}
          />
        )}
        {!boardOpen && (
          <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-line bg-panel py-2">
            {(
              [
                ...(subgraph ? [] : [["outputs", "output", "Pipeline outputs"], ["data", "table", "Data: drag datasets from Files onto the canvas"]]),
                ["folders", "folder", "Pipeline file tree (folders)"],
                ["search", "search", "Search pipeline · find and replace"],
                ...(subgraph
                  ? []
                  : [
                      ["builds", "pipeline", "Builds (deploy history and progress)"],
                      ["schedules", "clock", "Schedules"],
                      ["tests", "check", "Unit tests"],
                      ["evals", "sparkle", "LLM evaluation suites"],
                      ["details", "info", "Details: description, comments, access (Share)"],
                    ]),
              ] as [typeof rail, IconName, string][]
            ).map(([id, icon, label]) => (
              <button
                key={id}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => setRail(rail === id ? null : id)}
                className={`rounded-md p-2 ${rail === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
              >
                <Icon name={icon} className="h-4 w-4" />
              </button>
            ))}
          </nav>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={contextItems(menu.id)} onClose={() => setMenu(null)} />}

      {dialog?.kind === "add" && (
        <AddDataDialog mode={dialog.mode} files={dialog.files} onClose={() => setDialog(null)} onAdd={addDatasets} nodes={nodes} result={result} location={pipeline.location} sampleRows={sampleRows} />
      )}
      {dialog?.kind === "manual" &&
        (() => {
          const n = byId.get(dialog.id);
          const ds = n?.kind === "source" ? pipeline.datasets[n.datasetId] : undefined;
          if (!n || !ds) return null;
          return (
            <ManualDataEditor
              initial={{ name: n.name, table: { columns: ds.columns, rows: ds.rows }, generator: ds.generator }}
              nodes={nodes.filter((x) => x.id !== n.id)}
              result={result}
              onClose={() => setDialog(null)}
              onSave={(d) => {
                change((p) => ({
                  ...p,
                  nodes: p.nodes.map((x) => (x.id === n.id ? { ...x, name: d.name } : x)),
                  datasets: { ...p.datasets, [ds.id]: { ...ds, name: d.name, columns: d.table.columns, rows: d.table.rows, generator: d.generator } },
                }));
                setDialog(null);
              }}
            />
          );
        })()}
      {dialog?.kind === "union" && (
        <UnionDialog
          initial={{ name: dialog.name, inputs: dialog.inputs, mode: dialog.mode, strict: dialog.strict }}
          nodes={nodes.filter((n) => n.id !== dialog.id)}
          result={result}
          onClose={() => setDialog(null)}
          onSave={(c) => {
            if (dialog.id) updateNode(dialog.id, c);
            else addNode({ kind: "union", ...c } as Omit<PipelineNode, "id" | "x" | "y">, c.inputs);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "hotkeys" && <HotkeysDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "convert" &&
        (() => {
          const to = dialog.to;
          const findings = to === "faster" ? conversionFindings(pipeline, "faster") : [];
          return (
            <Modal title={to === "faster" ? "Convert to Faster pipeline" : "Convert to Batch pipeline"} icon="bolt" onClose={() => setDialog(null)}>
              <div className="space-y-3 p-4 text-sm">
                {findings.length ? (
                  <>
                    <p className="flex items-start gap-2 text-warn">
                      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" /> This pipeline uses {findings.length} transform{findings.length > 1 ? "s or expressions" : " or expression"} faster pipelines do not support. Remove or change them first.
                    </p>
                    <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
                      {findings.map((f, i) => (
                        <li key={i} className="flex items-center gap-2 rounded bg-panel-2 px-2 py-1.5">
                          <span className="w-36 shrink-0 truncate font-medium">{f.title}</span>
                          <span className="flex-1 text-soft">{f.detail}</span>
                          {f.node && (
                            <button
                              type="button"
                              title="Go to node"
                              onClick={() => {
                                setDialog(null);
                                setSelected([f.node!]);
                                fit([f.node!]);
                              }}
                              className="text-ocean"
                            >
                              <Icon name="external" className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => {
                        change((p) => ({ ...p, showConversionChecks: true }), false);
                        setDialog(null);
                        setBottomTab("warnings");
                      }}
                      className={buttonClass.secondary}
                    >
                      Show pipeline conversion checks
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-soft">
                      {to === "faster"
                        ? "Everything in this pipeline is supported by faster pipelines. Results can differ slightly (floating point digits, decimal overflow errors, formats of dates as text) — verify with Preview or the build outputs."
                        : "The pipeline goes back to the standard engine, which supports every transform."}
                    </p>
                    <p className="text-xs text-muted">You can convert back at any time.</p>
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setDialog(null)} className={buttonClass.secondary}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          change((p) => ({
                            ...p,
                            compute: to,
                            buildSettings: { ...(p.buildSettings ?? {}), profile: to === "faster" ? "faster-s" : "xs", strategy: "standard" },
                          }));
                          setDialog(null);
                          setNotice({ text: to === "faster" ? "Converted to a faster pipeline." : "Converted to a standard batch pipeline.", ok: true });
                        }}
                        className={buttonClass.primary}
                      >
                        Convert pipeline
                      </button>
                    </div>
                  </>
                )}
              </div>
            </Modal>
          );
        })()}
      {unitEdit &&
        (() => {
          const t = (pipeline.unitTests ?? []).find((x) => x.id === unitEdit);
          if (!t) return null;
          return (
            <UnitTestEditor
              key={t.id}
              pipeline={pipeline}
              test={t}
              result={result}
              onSave={(next) => change((p) => ({ ...p, unitTests: (p.unitTests ?? []).map((x) => (x.id === next.id ? next : x)) }))}
              onReselect={() => {
                setUnitEdit(null);
                setTestPick({ kind: "test", ids: t.nodes, testId: t.id });
              }}
              onClose={() => setUnitEdit(null)}
            />
          );
        })()}
      {evalEdit &&
        (() => {
          const suite = (pipeline.evalSuites ?? []).find((x) => x.id === evalEdit);
          if (!suite) return null;
          return (
            <EvalSuiteEditor
              key={suite.id}
              pipeline={pipeline}
              suite={suite}
              result={result}
              onSave={(next) => change((p) => ({ ...p, evalSuites: (p.evalSuites ?? []).map((x) => (x.id === next.id ? next : x)) }))}
              onDelete={() => {
                change((p) => ({ ...p, evalSuites: (p.evalSuites ?? []).filter((x) => x.id !== suite.id) }));
                setEvalEdit(null);
              }}
              onClose={() => setEvalEdit(null)}
            />
          );
        })()}
      {dialog?.kind === "deploy" && <DeployDialog pipeline={pipeline} branch={branch} initial={dialog.outputs} onDeploy={startBuild} onClose={() => setDialog(null)} />}
      {dialog?.kind === "exportCode" && <ExportCodeDialog pipeline={pipeline} branch={branch} onClose={() => setDialog(null)} />}
      {dialog?.kind === "buildSettings" && (
        <BuildSettingsDialog pipeline={pipeline} builds={runs.builds ?? []} onSave={(patch) => change((p) => ({ ...p, ...patch }))} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "prefs" && <PreferencesDialog prefs={prefs} onSave={setPrefs} onClose={() => setDialog(null)} />}
      {dialog?.kind === "parameters" && (
        <ParametersDialog parameters={pipeline.parameters ?? []} onSave={(parameters) => change((p) => ({ ...p, parameters }))} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "preconditions" &&
        (() => {
          const n = byId.get(dialog.id);
          if (n?.kind !== "source") return null;
          const ds = pipeline.datasets[n.datasetId];
          if (!ds) return null;
          const exps = ds.preconditions ?? [];
          return (
            <Modal title={`Pre-conditions — ${ds.name}`} icon="check" onClose={() => setDialog(null)} wide>
              <div className="space-y-3 p-4">
                <p className="text-xs text-muted">
                  Checked on every row of the input when a build reads it, before any job runs. A failing pre-condition aborts the build (nothing is written) or, in warn mode, is logged and
                  shown in Data Health. Results below use the preview copy of the input.
                </p>
                <ExpectationsEditor
                  exps={exps}
                  results={checkExpectations({ columns: ds.columns, rows: ds.rows }, exps)}
                  columns={ds.columns}
                  emptyText="No pre-conditions. Add checks the input must pass before the pipeline builds."
                  onChange={(preconditions) => change((p) => ({ ...p, datasets: { ...p.datasets, [ds.id]: { ...p.datasets[ds.id], preconditions } } }))}
                />
              </div>
            </Modal>
          );
        })()}
      {dialog?.kind === "sampling" &&
        (() => {
          const n = byId.get(dialog.id);
          if (n?.kind !== "source") return null;
          const ds = pipeline.datasets[n.datasetId];
          return (
            <SamplingDialog
              node={n}
              sources={sources}
              table={ds ? { columns: ds.columns, rows: ds.rows } : undefined}
              onApply={(s: Sampling) => updateNode(n.id, { sampling: s } as Partial<PipelineNode>)}
              onApplyAll={(s: Sampling) => {
                const warn: string[] = [];
                change((p) => ({
                  ...p,
                  nodes: p.nodes.map((x) => {
                    if (x.kind !== "source") return x;
                    const d = p.datasets[x.datasetId];
                    if (d?.media && s.kind === "random") {
                      warn.push(`${x.name}: media sets do not support percentage sampling`);
                      return x;
                    }
                    if (d?.files && s.kind !== "none") {
                      warn.push(`${x.name}: unstructured datasets are not sampled`);
                      return x;
                    }
                    if (s.kind === "filter" && d && !readyForFilter(d.columns, s.filter)) {
                      warn.push(`${x.name}: the filter uses columns it does not have`);
                      return x;
                    }
                    return { ...x, sampling: s };
                  }),
                }));
                return warn;
              }}
              onClose={() => setDialog(null)}
            />
          );
        })()}
      {dialog?.kind === "reusables" && (
        <ReusablesDialog
          tab={dialog.tab}
          pipeline={pipeline}
          change={change}
          onEditSubgraph={(def) => {
            setDialog(null);
            setSgEdit({ def, isNew: !(pipeline.subgraphs ?? []).some((s) => s.id === def.id) });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "createSubgraph" && (
        <CreateSubgraphDialog
          replace={dialog.replace}
          subgraphs={pipeline.subgraphs ?? []}
          onClose={() => setDialog(null)}
          onCreate={() => {
            const r = subgraphFrom(dialog.ids);
            if (r.error) return setNotice({ text: r.error });
            setDialog(null);
            setSgEdit({ def: r.def, replace: dialog.ids, isNew: true });
          }}
          onReplace={(sg) => {
            const set = new Set(dialog.ids);
            const outside = [...new Set(nodes.filter((n) => set.has(n.id)).flatMap((n) => inputsOf(n).filter((r) => r && !set.has(refNode(r)))))];
            const chosen = nodes.filter((n) => set.has(n.id));
            const exit = chosen.find((n) => nodes.some((m) => !set.has(m.id) && inputsOf(m).some((r) => refNode(r) === n.id)) || pipeline.outputs.some((o) => refNode(o.node) === n.id)) ?? chosen[chosen.length - 1];
            replaceWithSubgraph(dialog.ids, sg, sg.inputs.map((_, i) => outside[i] ?? ""), exit.id);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "applySubgraph" &&
        (() => {
          const n = byId.get(dialog.id);
          if (n?.kind !== "subgraph") return null;
          const def = (pipeline.subgraphs ?? []).find((s) => s.id === n.subgraph);
          return (
            <SubgraphApplyDialog
              node={n}
              def={def}
              nodes={nodes}
              result={result}
              onChange={(patch) => updateNode(n.id, patch as Partial<PipelineNode>)}
              onEdit={() => {
                if (!def) return;
                setDialog(null);
                setSgEdit({ def, isNew: false });
              }}
              onClose={() => setDialog(null)}
            />
          );
        })()}
      {dialog?.kind === "inputSchema" &&
        (() => {
          const n = byId.get(dialog.id);
          if (n?.kind !== "input") return null;
          const inp = sgInputs.find((i) => i.id === n.inputId) ?? { id: n.inputId, name: n.name, columns: [] as Column[] };
          return (
            <InputSchemaDialog
              input={inp}
              datasets={Object.values(pipeline.datasets)}
              onApply={(next) => {
                setSgInputs([...sgInputs.filter((i) => i.id !== next.id), next]);
                updateNode(n.id, { name: next.name });
                setDialog(null);
              }}
              onClose={() => setDialog(null)}
            />
          );
        })()}
      {dialog?.kind === "model" && (
        <ModelDialog
          node={dialog.id ? (byId.get(dialog.id) as Extract<PipelineNode, { kind: "model" }>) : undefined}
          input={result(dialog.input)}
          inputName={refLabel(nodes, dialog.input)}
          onSave={(patch) => {
            if (dialog.id) updateNode(dialog.id, patch as Partial<PipelineNode>);
            else addNode({ kind: "model", input: dialog.input, ...patch } as Omit<PipelineNode, "id" | "x" | "y">, [dialog.input]);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "explain" && (
        <AiExplainDialog
          fallback={explainNodes(dialog.ids, nodes, pipeline.outputs, pipeline.functions, pipeline.subgraphs)}
          title={dialog.ids.length === 1 ? (byId.get(dialog.ids[0])?.name ?? "Node") : `${dialog.ids.length} nodes`}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "generate" && (
        <AiGenerateDialog
          input={result(dialog.from)}
          inputName={refLabel(nodes, dialog.from)}
          functions={pipeline.functions}
          onCreate={(name, steps) => {
            const id = addNode({ kind: "transform", name, input: dialog.from, steps } as Omit<PipelineNode, "id" | "x" | "y">, [dialog.from]);
            setDialog(null);
            setSelected([id]);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {assist && (
        <AipAssistPanel
          adapter={pipelineAssist({ pipeline, selected, setSelected, result, schema: jsResult, addNode, updateNode, fit, functions: pipeline.functions, readOnly, last: assistLast }) /* eslint-disable-line react-hooks/refs -- the ref itself is passed; last.current is read and written only when a proposal is applied, never while rendering */}
          onClose={() => setAssist(false)}
        />
      )}
      {dialog?.kind === "dataset" &&
        (() => {
          const r = result(dialog.ref);
          return (
            <Modal title={`${refLabel(nodes, dialog.ref)} — dataset preview`} icon="table" onClose={() => setDialog(null)} wide>
              <div className="flex h-[70vh] flex-col">
                {r.table ? <DataPreview table={r.table} title={refLabel(nodes, dialog.ref)} pager={pagerOf(dialog.ref)} /> : <p className="p-6 text-sm text-bad">{r.error}</p>}
              </div>
            </Modal>
          );
        })()}
    </div>
  );
}

const readyForFilter = (columns: Column[], filter: string) => {
  const names = new Set(columns.map((c) => c.name));
  const used: string[] = [];
  JSON.parse(filter, (k, v) => {
    if (k === "column" && typeof v === "string") used.push(v);
    return v;
  });
  return used.every((u) => names.has(u));
};

/** Over the graph while choosing a join's, union's or subgraph's inputs by clicking them. */
function PickBanner({
  pick,
  nodes,
  subgraphs,
  onChange,
  onStart,
  onCancel,
}: {
  pick: PickState;
  nodes: PipelineNode[];
  subgraphs: Subgraph[];
  onChange: (p: PickState) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const name = (ref: string | undefined) => (ref ? refLabel(nodes, ref) : undefined);
  if (pick.kind === "subgraph") {
    const sg = subgraphs.find((s) => s.id === pick.subgraph);
    const ready = !!sg && pick.inputs.length === sg.inputs.length && pick.inputs.every(Boolean);
    return (
      <div className="absolute bottom-4 left-1/2 z-30 w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-line-2 bg-panel-2 px-4 py-3 text-sm shadow-2xl">
        <div className="flex items-center gap-2">
          <Icon name="layers" className="h-4 w-4 text-ocean" />
          <select
            value={pick.subgraph}
            onChange={(e) => {
              const next = subgraphs.find((s) => s.id === e.target.value);
              onChange({ ...pick, subgraph: e.target.value, inputs: (next?.inputs ?? []).map((_, i) => pick.ids[i] ?? "") });
            }}
            className={`${inputClass} flex-1`}
            aria-label="Select a subgraph"
          >
            {subgraphs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={!ready} onClick={onStart} className={buttonClass.primary}>
            Start
          </button>
          <button type="button" onClick={onCancel} title="Cancel (Esc)" className="rounded p-1 text-muted hover:bg-panel hover:text-white">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-2 text-xs text-muted">Map inputs — pick a node for each subgraph input (or click nodes on the graph):</div>
        <div className="mt-1 space-y-1">
          {sg?.inputs.map((inp, i) => (
            <label key={inp.id} className="flex items-center gap-2 text-xs">
              <span className="w-36 truncate text-soft" title={inp.columns.map((c) => c.name).join(", ")}>
                {inp.name} <span className="text-muted">({inp.columns.length} cols)</span>
              </span>
              <select
                value={pick.inputs[i] ?? ""}
                onChange={(e) => {
                  const inputs = [...pick.inputs];
                  inputs[i] = e.target.value;
                  onChange({ ...pick, inputs });
                }}
                className={`${inputClass} flex-1 py-1 text-xs`}
              >
                <option value="">Choose a node…</option>
                {nodes
                  .filter((n) => n.kind !== "input")
                  .flatMap((n) => (n.kind === "split" ? [n.id, n.id + FALSE_PORT] : [n.id]))
                  .map((ref) => (
                    <option key={ref} value={ref}>
                      {name(ref)}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
      </div>
    );
  }
  const ready = pick.kind === "join" ? pick.ids.length === 2 : pick.ids.length >= 2;
  const verb = pick.kind;
  return (
    <div className="absolute bottom-4 left-1/2 z-30 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-line-2 bg-panel-2 px-4 py-3 text-sm shadow-2xl">
      <div className="min-w-0 flex-1">
        <p>
          {pick.ids.length === 0
            ? `Select the tables on the graph to start configuring the ${verb}.`
            : pick.kind === "join" || pick.ids.length < 2
              ? `Select another table on the graph to start configuring the ${verb}.`
              : "Select more tables to add them to the union, or start."}
        </p>
        <div className="mt-1.5 flex min-w-0 gap-6 text-xs">
          {pick.kind === "join" ? (
            <>
              <span className="truncate">
                <span className="text-muted">Left:</span> {name(pick.ids[0]) ?? <i className="text-muted">click a table</i>}
              </span>
              <span className="truncate">
                <span className="text-muted">Right:</span> {name(pick.ids[1]) ?? <i className="text-muted">click a table</i>}
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate">
              <span className="text-muted">Inputs:</span> {pick.ids.length ? pick.ids.map((i) => name(i)).join(", ") : <i className="text-muted">click tables</i>}
            </span>
          )}
        </div>
      </div>
      <button type="button" disabled={!ready} onClick={onStart} className={buttonClass.primary}>
        Start
      </button>
      <button type="button" onClick={onCancel} title="Cancel (Esc)" className="rounded p-1 text-muted hover:bg-panel hover:text-white">
        <Icon name="x" className="h-4 w-4" />
      </button>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (mode: AddMode) => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl">
        <div className="border-b border-line p-5">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Icon name="pipeline" className="h-5 w-5 text-ocean" /> Welcome to Pipeline Builder
          </div>
          <p className="mt-1 text-sm text-muted">Get started by adding datasets, then define transform logic to derive outputs.</p>
        </div>
        {ADD_OPTIONS.map((o) => (
          <button key={o.mode} type="button" onClick={() => onPick(o.mode)} className="flex w-full items-start gap-3 border-b border-line px-5 py-3 text-left last:border-0 hover:bg-panel-2">
            <Icon name={o.icon} className="mt-0.5 h-4 w-4 text-ocean" />
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-muted">{o.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NodeToolbar({
  node,
  streaming,
  onTransform,
  onJoin,
  onUnion,
  onSplit,
  onLlm,
  onSubgraph,
  onGenerate,
  onOutput,
  onEdit,
  onDelete,
}: {
  node: PipelineNode;
  streaming: boolean;
  onTransform: () => void;
  onJoin: () => void;
  onUnion: () => void;
  onSplit: () => void;
  onLlm: () => void;
  onSubgraph: () => void;
  onGenerate: () => void;
  onOutput?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tabular = node.kind !== "source" || true;
  const items: { icon: IconName; label: string; run: () => void; danger?: boolean }[] = [
    ...(node.kind !== "source" ? [{ icon: "edit" as const, label: "Edit", run: onEdit }] : []),
    { icon: "transform", label: "Transform", run: onTransform },
    { icon: "join", label: "Join", run: onJoin },
    { icon: "union", label: "Union", run: onUnion },
    ...(!streaming && tabular ? [{ icon: "split" as const, label: "Split", run: onSplit }] : []),
    { icon: "sparkle", label: "Use LLM", run: onLlm },
    { icon: "bolt", label: "Generate", run: onGenerate },
    { icon: "layers", label: "Subgraph", run: onSubgraph },
    ...(onOutput ? [{ icon: "output" as const, label: "Add output", run: onOutput }] : []),
    { icon: "trash", label: "Delete", run: onDelete, danger: true },
  ];
  return (
    <div className="flex flex-col rounded-lg border border-line-2 bg-panel-2 p-1 shadow-xl">
      {items.map((i) => (
        <button
          key={i.label}
          type="button"
          onClick={i.run}
          className={`flex items-center gap-2 rounded px-2 py-1 text-left text-xs ${i.danger ? "text-soft hover:bg-bad/10 hover:text-bad" : "text-soft hover:bg-panel hover:text-white"}`}
        >
          <Icon name={i.icon} className={`h-3.5 w-3.5 ${i.danger ? "" : "text-ocean"}`} /> {i.label}
        </button>
      ))}
    </div>
  );
}

/** Colour legend: add colours, apply them, hide or collapse a colour group. */
function Legend({
  pipeline,
  selected,
  change,
  hiddenCount,
  onShowAll,
}: {
  pipeline: Pipeline;
  selected: string[];
  change: (fn: (p: Pipeline) => Pipeline, record?: boolean) => void;
  hiddenCount: number;
  onShowAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [eye, setEye] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const counts = new Map<string, number>();
  for (const n of pipeline.nodes) if (n.color) counts.set(n.color, (counts.get(n.color) ?? 0) + 1);
  const apply = (colorId: string | undefined) =>
    change((p) => ({
      ...p,
      nodes: p.nodes.map((n) => (selected.includes(n.id) ? { ...n, color: colorId } : n)),
      textNodes: (p.textNodes ?? []).map((t) => (selected.includes(TXT + t.id) ? { ...t, color: colorId } : t)),
    }));
  const add = () => {
    const colorId = uid();
    change((p) => ({
      ...p,
      legend: [...p.legend, { id: colorId, name: `Color ${p.legend.length + 1}`, hex: PALETTE[p.legend.length % PALETTE.length] }],
      nodes: p.nodes.map((n) => (selected.includes(n.id) ? { ...n, color: colorId } : n)),
    }));
  };
  const edit = (colorId: string, patch: Partial<LegendColor>, record = false) => change((p) => ({ ...p, legend: p.legend.map((c) => (c.id === colorId ? { ...c, ...patch } : c)) }), record);

  return (
    <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(!open)} className={buttonClass.ghost}>
        <Icon name="palette" className="h-4 w-4" /> <span className="text-xs">Legend</span>
        {hiddenCount > 0 && <span className="rounded bg-warn/20 px-1 text-[10px] text-warn">{hiddenCount} hidden</span>}
        <Icon name="down" className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-80 rounded-lg border border-line-2 bg-panel-2 p-2 shadow-xl">
          <p className="px-1 pb-2 text-xs text-muted">
            {selected.length ? `Click a colour to apply it to ${selected.length} selected node${selected.length > 1 ? "s" : ""}.` : "Select nodes to colour them."}
          </p>
          <ul className="space-y-1">
            {pipeline.legend.map((c) => (
              <li key={c.id} className="relative flex items-center gap-1.5">
                <button
                  type="button"
                  title={selected.length ? "Apply to selection" : "Select nodes first"}
                  disabled={!selected.length}
                  onClick={() => apply(c.id)}
                  className="h-5 w-5 shrink-0 rounded ring-1 ring-line-2 hover:ring-white disabled:cursor-default"
                  style={{ background: c.hex }}
                />
                <input
                  value={c.name}
                  onChange={(e) => edit(c.id, { name: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none hover:border-line-2 focus:border-ocean"
                />
                <span className="text-xs tabular-nums text-muted" title="Nodes in this colour group">
                  {counts.get(c.id) ?? 0}
                </span>
                <button
                  type="button"
                  title={c.collapsed ? "Expand this colour group" : "Collapse this colour group into one node"}
                  onClick={() => edit(c.id, { collapsed: !c.collapsed }, true)}
                  className={`rounded p-0.5 ${c.collapsed ? "text-ocean" : "text-muted hover:text-white"}`}
                >
                  <Icon name="layers" className="h-3.5 w-3.5" />
                </button>
                <button type="button" title="Show / hide this colour group" onClick={() => setEye(eye === c.id ? null : c.id)} className={`rounded p-0.5 ${c.hidden ? "text-warn" : "text-muted hover:text-white"}`}>
                  <Icon name="eye" className="h-3.5 w-3.5" />
                </button>
                {eye === c.id && (
                  <div className="absolute right-6 top-6 z-10 w-44 rounded-md border border-line-2 bg-panel py-1 text-xs shadow-xl">
                    <button type="button" onClick={() => (edit(c.id, { hidden: !c.hidden }, true), setEye(null))} className="block w-full px-3 py-1.5 text-left hover:bg-panel-2">
                      {c.hidden ? "Show this color" : "Hide this color"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        change((p) => ({ ...p, legend: p.legend.map((x) => ({ ...x, hidden: x.id !== c.id })) }));
                        setEye(null);
                      }}
                      className="block w-full px-3 py-1.5 text-left hover:bg-panel-2"
                    >
                      Hide other colors
                    </button>
                  </div>
                )}
                <input type="color" value={c.hex} onChange={(e) => edit(c.id, { hex: e.target.value })} title="Change colour" className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0" />
                <button
                  type="button"
                  title="Delete colour"
                  onClick={() => change((p) => ({ ...p, legend: p.legend.filter((l) => l.id !== c.id), nodes: p.nodes.map((n) => (n.color === c.id ? { ...n, color: undefined } : n)) }))}
                  className="rounded p-0.5 text-muted hover:text-bad"
                >
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={add} className={`${buttonClass.secondary} flex-1 justify-center text-xs`}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add color
            </button>
            {selected.length > 0 && (
              <button type="button" onClick={() => apply(undefined)} className={`${buttonClass.ghost} text-xs`}>
                Clear
              </button>
            )}
          </div>
          {hiddenCount > 0 && (
            <button type="button" onClick={onShowAll} className="mt-2 w-full rounded-md bg-warn/10 px-2 py-1.5 text-xs text-warn hover:bg-warn/20">
              Show {hiddenCount} hidden node{hiddenCount > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

