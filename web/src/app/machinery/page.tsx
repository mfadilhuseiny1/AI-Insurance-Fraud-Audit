"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { DrivePicker } from "@/components/DrivePicker";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { api } from "@/lib/api";
import { ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import { om, type LinkType } from "@/lib/ontologyModel";
import { machinery, START, type HierarchyRow, type Machinery, type Metrics, type Mined, type Process, type Transition } from "@/lib/machinery";
import { DIM, layoutGraph, layoutManual, layoutNested, NESTED_DIM, stateIds, type Dim, type GraphLayout } from "@/lib/machineryLayout";
import { timeseries, type DatasetRef } from "@/lib/timeseries";

type View = "current_count" | "historical_count" | "current_duration_s" | "historical_duration_s";
const VIEWS: [View, string][] = [
  ["current_count", "Current count"],
  ["historical_count", "Historical count"],
  ["current_duration_s", "Current duration"],
  ["historical_duration_s", "Historical duration"],
];
const dur = (s: number | null | undefined) => (s === null || s === undefined ? "—" : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} d`);
/** What is selected on the graph: a state or a transition of the process shown or — in an expanded state — of a
 * subprocess (pid), then only among the objects under parent objects in that state (under). */
type Sel = ({ kind: "state"; id: string } | { kind: "transition"; t: Transition }) & { pid?: string; under?: string };

const metricText = (m: Metrics["states"][number] | undefined, view: View) => {
  if (!m) return "";
  const v = m[view];
  return view.endsWith("_s") ? dur(v as number | null) : String(v ?? 0);
};

/** One process level of the drawing (the process itself, or a subprocess inside an expanded state): the routed
 * transitions with their counts and Sankey thickness, the start node and the states with the chosen metric. */
function GraphLayer({ g, dim, nested, label, metrics, view, sankey, edgeStatus, nodeStyle, selState, selTrans, onState, onTransition, onStateOpen, onStateDown }: {
  g: GraphLayout;
  dim: Dim;
  nested?: boolean;
  label: (id: string) => string;
  metrics: Metrics | null;
  view: View;
  sankey: boolean;
  edgeStatus?: (from: string, to: string) => "defined" | "new" | "unused";
  nodeStyle?: (id: string) => { isNew?: boolean; unused?: boolean };
  selState: string | null;
  selTrans: Transition | null;
  onState: (id: string) => void;
  onTransition: (t: Transition) => void;
  onStateOpen?: (id: string) => void;
  /** manual layout: a press on a state starts dragging it */
  onStateDown?: (id: string, e: React.PointerEvent) => void;
}) {
  const stateM = Object.fromEntries((metrics?.states ?? []).map((s) => [s.id, s]));
  const transM = new Map((metrics?.transitions ?? []).map((x) => [`${x.from}->${x.to}`, x]));
  const maxT = Math.max(1, ...(metrics?.transitions ?? []).map((x) => x.count));
  const thick = nested ? 6 : 10;
  return (
    <>
      {g.edges.map((e, i) => {
        const m = transM.get(`${e.from}->${e.to}`);
        const status = edgeStatus?.(e.from, e.to) ?? "defined";
        const sel = selTrans?.from === e.from && selTrans.to === e.to;
        const color = status === "new" ? "#f59e0b" : sel ? "#38bdf8" : "#64748b";
        return (
          <g key={`${e.from}->${e.to}#${i}`} data-transition={`${e.from}->${e.to}`} className="cursor-pointer" onClick={() => onTransition({ from: e.from, to: e.to })}>
            <path d={e.d} fill="none" stroke="transparent" strokeWidth={14} />
            <path d={e.d} fill="none" stroke={color} strokeWidth={sankey && m ? 1 + (m.count / maxT) * thick : nested ? 1.3 : 1.6} strokeOpacity={0.75} strokeDasharray={status === "unused" ? "6 5" : undefined} markerEnd="url(#arr)" />
            {m && (
              <text x={e.label.x} y={e.label.y} textAnchor="middle" fontSize={nested ? 10 : 11} className="fill-muted">
                {m.count}
                {m.mean_duration_s ? ` · ${dur(m.mean_duration_s)}` : ""}
              </text>
            )}
          </g>
        );
      })}
      {Object.entries(g.nodes).map(([id, b]) => {
        if (id === START)
          return (
            <g key={id} transform={`translate(${b.x},${b.y + dim.h / 2 - 10})`}>
              <circle cx={10} cy={10} r={nested ? 7 : 10} fill="#334155" />
              {!nested && (
                <text x={10} y={-6} textAnchor="middle" fontSize={10} className="fill-muted">
                  start
                </text>
              )}
            </g>
          );
        const st = nodeStyle?.(id) ?? {};
        const sel = selState === id;
        return (
          <g key={id} data-state={id} transform={`translate(${b.x},${b.y})`} className={onStateDown ? "cursor-move" : "cursor-pointer"} onClick={() => onState(id)} onDoubleClick={onStateOpen ? () => onStateOpen(id) : undefined} onPointerDown={onStateDown ? (e) => onStateDown(id, e) : undefined}>
            <rect
              width={b.w}
              height={b.h}
              rx={nested ? 8 : 10}
              fill={st.isNew ? "rgba(245,158,11,0.15)" : nested ? "var(--color-ink)" : "var(--color-panel)"}
              stroke={st.isNew ? "#f59e0b" : sel ? "#38bdf8" : "#475569"}
              strokeWidth={sel ? 2.5 : 1.3}
              strokeDasharray={st.unused ? "6 4" : undefined}
            />
            <text x={nested ? 10 : 12} y={nested ? 18 : 21} fontSize={nested ? 11 : 12} className="fill-soft" fontWeight={600}>
              {label(id)}
            </text>
            <text x={nested ? 10 : 12} y={nested ? 36 : 41} fontSize={nested ? 13 : 14} className="fill-ocean" fontWeight={700}>
              {metricText(stateM[id], view)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/**
 * Machinery: model a process (states, transitions, actions) over an object type's state property, keep its process
 * log, mine states and transitions from the data, and monitor counts, durations, paths and conformance.
 */
export default function MachineryPage() {
  // useSearchParams needs a Suspense boundary on a static page
  return (
    <Suspense>
      <MachineryApp />
    </Suspense>
  );
}

function MachineryApp() {
  const router = useRouter();
  const params = useSearchParams();
  const [list, setList] = useState<{ id: string; name: string; processes: number }[] | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rec, setRec] = useState<Machinery | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // the parent states a subprocess opens focused on (opened from a state of the nested drawing)
  const [focus0, setFocus0] = useState<string[]>([]);
  const pick = useCallback((p: string, focus: string[] = []) => {
    setPid(p);
    setFocus0(focus);
  }, []);
  const reloadList = useCallback(() => machinery.list().then(setList, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void reloadList();
    ontology.objectTypes().then(setTypes, () => undefined);
  }, [reloadList]);
  const open = useCallback(async (id: string, processId?: string | null) => {
    try {
      const r = await machinery.get(id);
      setRec(r);
      setFocus0([]);
      setPid(r.processes.find((p) => p.id === processId)?.id ?? r.processes[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  // a link to a resource (and one of its processes): /machinery?id=…&process=…
  const deepId = params.get("id");
  const seenDeep = useRef(false);
  const deepProcess = params.get("process");
  useEffect(() => {
    if (!deepId) {
      // back from /machinery?id=… to the home
      if (seenDeep.current) {
        setRec(null);
        seenDeep.current = false;
      }
      return;
    }
    seenDeep.current = true;
    machinery.get(deepId).then(
      (r) => {
        setRec(r);
        setPid(r.processes.find((p) => p.id === deepProcess)?.id ?? r.processes[0]?.id ?? null);
      },
      (e: Error) => setError(e.message),
    );
  }, [deepId, deepProcess]);
  if (error && !list) return <ApiError message={error} />;
  if (!list) return <Loading />;
  const proc = rec?.processes.find((p) => p.id === pid) ?? null;
  const newProcess = (
    <>
        {creating && (
          <NewProcess
            types={types}
            into={rec}
            onClose={() => setCreating(false)}
            onCreated={async (r, processId) => {
              setCreating(false);
              await reloadList();
              setRec(r);
              setFocus0([]);
              setPid(processId ?? r.processes[0]?.id ?? null);
            }}
          />
        )}
    </>
  );
  // the home: every Machinery resource; one opens from a card (/machinery?id=…) or by creating a process
  if (!rec && !deepId)
    return (
      <>
        <AppHome
          app="Device and Machinery"
          icon="cpu"
          accent="#2563eb"
          href="/machinery"
          tagline="Model and monitor the processes your objects move through: states, transitions, durations and actions."
          description={
            <>
              Model a process (states, transitions, actions) over an object type&apos;s state property, keep its process log, mine states and transitions from the
              data, and monitor counts, durations, paths and conformance. A resource may hold several processes and nested subprocesses.
            </>
          }
          noun={["resource", "resources"]}
          error={error}
          items={list.map((r) => ({
            id: r.id,
            href: `/machinery?id=${r.id}`,
            title: r.name,
            meta: `${r.processes} process${r.processes === 1 ? "" : "es"}`,
          }))}
          empty={{ title: "Create your first process", hint: "Pick an object type with a state property; its process is drawn from the objects' history.", steps: ["Choose an object type", "Pick its state property", "Explore states and transitions"] }}
          create={
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New process
            </button>
          }
        />
        {newProcess}
      </>
    );
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Device and Machinery" icon="cpu" href="/machinery" crumbs={rec ? [{ label: rec.name }] : []}>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New process
        </button>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setRec(null);
              if (deepId) router.replace("/machinery");
            }}
            className="flex items-center gap-1 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-strong"
          >
            <Icon name="left" className="h-3 w-3" /> All resources
          </button>
          {list.map((r) => (
            <button key={r.id} type="button" onClick={() => open(r.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${rec?.id === r.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
              <Icon name="cpu" className="h-3.5 w-3.5 text-ocean" /> <span className="min-w-0 flex-1 truncate">{r.name}</span>
            </button>
          ))}
          {rec && rec.processes.length > 1 && (
            <>
              <div className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Processes</div>
              {tree(rec.processes).map(({ p, depth }) => (
                <button key={p.id} type="button" onClick={() => pick(p.id)} style={{ paddingLeft: 8 + depth * 12 }} className={`w-full rounded py-1 pr-2 text-left text-xs ${pid === p.id ? "text-white" : "text-muted"}`}>
                  {depth > 0 ? "↳ " : ""}
                  {p.name}
                </button>
              ))}
            </>
          )}
        </nav>
        {rec && proc ? (
          <ProcessView key={`${rec.id}|${proc.id}|${focus0.join(",")}`} rec={rec} proc={proc} types={types} initialFocus={focus0} onSaved={(r) => (setRec(r), void reloadList())} onPick={pick} onDeleted={() => (setRec(null), void reloadList())} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted">
            <Icon name="cpu" className="h-8 w-8 text-ocean" />
            Open a Machinery resource, or create a process for an object type with a state property.
          </div>
        )}
      </div>
      {newProcess}
    </div>
  );
}

/** A new Machinery resource with its first process — or, with a resource open, one more process in it (a second
 * root process over another object type, as a resource that follows several kinds of objects needs). */
function NewProcess({ types, into, onClose, onCreated }: { types: ObjectType[]; into: Machinery | null; onClose: () => void; onCreated: (r: Machinery, processId?: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [processName, setProcessName] = useState("");
  const [where, setWhere] = useState<"new" | "open">("new");
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [prop, setProp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const t = types.find((x) => x.id === typeId);
  const strings = (t?.properties ?? []).filter((p) => p.type === "string" && !p.array);
  const stateProp = strings.some((p) => p.api_name === prop) ? prop : strings[0]?.api_name || "";
  const adding = where === "open" && !!into;
  const create = async () => {
    const process: Process = { id: adding ? `proc-${crypto.randomUUID().slice(0, 8)}` : "main", name: processName.trim() || t?.display_name || name, object_type_id: typeId, state_property: stateProp, states: [], transitions: [], actions: [], log: null, excluded: [] };
    try {
      if (adding && into) onCreated(await machinery.save(into.id, { name: into.name, description: into.description, auto_layout: into.auto_layout, processes: [...into.processes, process] }), process.id);
      else onCreated(await machinery.create({ name: name.trim(), description: description.trim(), auto_layout: true, processes: [process] }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="New process" icon="cpu" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        {into && (
          <select value={where} onChange={(e) => setWhere(e.target.value as "new" | "open")} className={inputClass} aria-label="Where the process goes">
            <option value="new">In a new Machinery resource</option>
            <option value="open">In {into.name}</option>
          </select>
        )}
        {!adding && (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Resource name, e.g. Claim handling" className={inputClass} aria-label="Resource name" autoFocus />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} placeholder="Description (optional)" className={inputClass} aria-label="Resource description" />
          </>
        )}
        <input value={processName} onChange={(e) => setProcessName(e.target.value)} placeholder={`Process name (default: ${t?.display_name ?? "the object type"})`} className={inputClass} aria-label="Process name" />
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputClass} aria-label="Process object type">
          {types.map((x) => (
            <option key={x.id} value={x.id}>
              {x.display_name}
            </option>
          ))}
        </select>
        <select value={stateProp} onChange={(e) => setProp(e.target.value)} className={inputClass} aria-label="State property">
          {strings.map((p) => (
            <option key={p.api_name} value={p.api_name}>
              State: {p.display_name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted">Start empty, then mine the states and transitions from the data, or draw them.</p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={(!adding && !name.trim()) || !stateProp} onClick={create} className={buttonClass.primary}>
            {adding ? "Add process" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The processes as a tree: each subprocess under its parent. */
function tree(processes: Process[]): { p: Process; depth: number }[] {
  const out: { p: Process; depth: number }[] = [];
  const ids = new Set(processes.map((p) => p.id));
  const walk = (parent: string | null, depth: number) => {
    for (const p of processes) {
      const up = p.parent && ids.has(p.parent.process_id) ? p.parent.process_id : null;
      if (up !== parent || out.some((x) => x.p.id === p.id)) continue;
      out.push({ p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function ProcessView({ rec, proc, types, initialFocus, onSaved, onPick, onDeleted }: {
  rec: Machinery;
  proc: Process;
  types: ObjectType[];
  initialFocus: string[];
  onSaved: (r: Machinery) => void;
  onPick: (pid: string, focus?: string[]) => void;
  onDeleted: () => void;
}) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [view, setView] = useState<View>("current_count");
  const [deviations, setDeviations] = useState(false);
  const [sankey, setSankey] = useState(true);
  const [mining, setMining] = useState<Mined | null>(null);
  const [keep, setKeep] = useState(100);
  const [selected, setSelected] = useState<Sel | null>(null);
  const [panel, setPanel] = useState<"data" | "mining" | "paths" | "output" | "actions" | "nested">("output");
  // a subprocess: only the objects under parent objects in these parent states
  const [focus, setFocus] = useState<string[]>(initialFocus);
  // the nested drawing: the states drawn open, with the graph of each direct subprocess inside
  const [expanded, setExpanded] = useState<string[]>([]);
  const [nestedM, setNestedM] = useState<Record<string, Metrics>>({});
  const [hier, setHier] = useState<HierarchyRow[]>([]);
  const children = useMemo(() => rec.processes.filter((x) => x.parent?.process_id === proc.id), [rec, proc.id]);
  const parentProc = rec.processes.find((x) => x.id === proc.parent?.process_id) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [actionTypes, setActionTypes] = useState<ActionType[]>([]);
  const t = types.find((x) => x.id === proc.object_type_id);
  const load = useCallback(() => machinery.metrics(rec.id, proc.id, deviations, focus).then(setMetrics, (e: Error) => setError(e.message)), [rec.id, proc.id, deviations, focus]);
  useEffect(() => {
    void load();
    ontology.actionTypes(proc.object_type_id).then(setActionTypes, () => undefined);
  }, [load, proc.object_type_id]);
  /** Save this process (and, with `head`, the resource's name, description or layout mode). */
  const save = async (p: Process, head: Partial<Pick<Machinery, "name" | "description" | "auto_layout">> = {}) => {
    try {
      const r = await machinery.save(rec.id, { name: rec.name, description: rec.description, auto_layout: rec.auto_layout, ...head, processes: rec.processes.map((x) => (x.id === p.id ? p : x)) });
      onSaved(r);
      setError(null);
      void load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  // manual layout: the state being dragged, where it is now, and the view box the drag started in (kept until the drop)
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; x: number; y: number; moved: boolean; vb: { x: number; y: number; w: number; h: number } } | null>(null);
  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const m = svgRef.current?.getScreenCTM();
    return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : { x: 0, y: 0 };
  };
  const mine = (k = keep) => machinery.mine(rec.id, proc.id, { keep_percent: k }).then(setMining, (e: Error) => setError(e.message));
  const newStates = useMemo(() => mining?.states.filter((s) => s.status === "new").map((s) => s.id) ?? [], [mining]);
  const newTrans = useMemo(() => mining?.transitions.filter((x) => x.status === "new") ?? [], [mining]);
  const newOnly = useMemo(() => newTrans.map((x) => ({ from: x.from, to: x.to })).filter((x) => !proc.transitions.some((y) => y.from === x.from && y.to === x.to)), [newTrans, proc.transitions]);
  // drawn by hand when the resource's automatic layout is off (the nested drawing is always laid out automatically)
  const manual = !rec.auto_layout && expanded.length === 0;
  const lay = useMemo(
    () =>
      manual
        ? { ...layoutManual(proc.states.map((s) => (drag?.id === s.id ? { ...s, x: drag.x, y: drag.y } : s)), newStates, [...proc.transitions, ...newOnly]), groups: {} }
        : layoutNested(proc, newStates, newOnly, children, expanded),
    [manual, drag, proc, newStates, newOnly, children, expanded],
  );
  const pos = lay.nodes;
  const vb = drag?.vb ?? { x: lay.bounds.x - 40, y: lay.bounds.y - 80, w: lay.bounds.w + 80, h: lay.bounds.h + 160 };
  /** Switch the layout mode; going manual, every state starts where the automatic layout drew it. */
  const setAuto = (on: boolean) => save(on ? proc : { ...proc, states: proc.states.map((s) => (typeof s.x === "number" && typeof s.y === "number" ? s : { ...s, x: Math.round(pos[s.id]?.x ?? 0), y: Math.round(pos[s.id]?.y ?? 0) })) }, { auto_layout: on });
  // subprocess rows of the hierarchy: how many of each subprocess' objects sit under each state of this process
  useEffect(() => {
    if (!children.length) return;
    machinery.hierarchy(rec.id).then(setHier, () => setHier([]));
  }, [rec, children.length]);
  // the metrics of each subprocess under each expanded state (the subprocess' objects linked to this process'
  // objects currently in that state)
  useEffect(() => {
    let live = true;
    for (const sid of expanded)
      for (const c of children)
        machinery.metrics(rec.id, c.id, deviations, [sid]).then(
          (m) => live && setNestedM((cur) => ({ ...cur, [`${deviations}|${c.id}|${sid}`]: m })),
          (e: Error) => live && setError(e.message),
        );
    return () => {
      live = false;
    };
  }, [rec, children, deviations, expanded]);
  const expandable = children.length > 0 ? proc.states.map((s) => s.id) : [];
  const under = (sid: string) => children.reduce((n, c) => n + (hier.find((r) => r.id === c.id)?.by_parent_state?.[sid] ?? 0), 0);
  const select = (s: Sel) => (setSelected(s), setPanel("output"));
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-ink">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 text-xs">
          <span className="font-medium">{proc.name}</span>
          <span className="text-muted">
            {t?.display_name}.{proc.state_property}
          </span>
          <select value={view} onChange={(e) => setView(e.target.value as View)} className={fieldClass} aria-label="Metric view">
            {VIEWS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={sankey} onChange={(e) => setSankey(e.target.checked)} /> Sankey edges
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={deviations} onChange={(e) => setDeviations(e.target.checked)} /> Include deviations
          </label>
          <button type="button" onClick={() => (mining ? setMining(null) : (setPanel("mining"), void mine()))} className={mining ? buttonClass.primary : buttonClass.secondary}>
            <Icon name="sparkle" className="h-3.5 w-3.5" /> {mining ? "Exit mining" : "Process mining"}
          </button>
          <label className="flex items-center gap-1" title="Off: drag the states where you want them (or type a position after selecting one); the positions are saved with the process">
            <input type="checkbox" checked={rec.auto_layout} onChange={(e) => void setAuto(e.target.checked)} aria-label="Auto layout" /> Auto layout
          </label>
          <button
            type="button"
            onClick={async () => {
              const id = (await promptDialog("State value (as stored in the property)", "", { title: "Add state" }))?.trim();
              if (id && !proc.states.some((s) => s.id === id)) await save({ ...proc, states: [...proc.states, { id, label: id }] });
            }}
            className={buttonClass.ghost}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> State
          </button>
          <button type="button" onClick={() => setLinking(true)} disabled={!proc.states.length} className={buttonClass.ghost} title="Draw a transition between two states (or from the start)">
            <Icon name="plus" className="h-3.5 w-3.5" /> Transition
          </button>
          <button type="button" onClick={() => setEditing(true)} className={buttonClass.ghost} title="Rename the resource or this process, edit the description">
            <Icon name="pencil" className="h-3.5 w-3.5" /> Rename
          </button>
          {expandable.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(expanded.length ? [] : expandable)}
              className={expanded.length ? buttonClass.primary : buttonClass.secondary}
              title={`Draw ${children.map((c) => c.name).join(", ")} inside each state: the objects linked to the ${proc.name} objects currently in it${focus.length ? ". The parent state focus above does not narrow the nested counts." : ""}`}
            >
              <Icon name="plus" className="h-3.5 w-3.5" /> {expanded.length ? "Collapse all" : "Expand all"}
            </button>
          )}
          {parentProc && focus.length > 0 && (
            <button type="button" onClick={() => setFocus([])} className="rounded-full border border-ocean/50 bg-ocean/10 px-2 py-0.5 text-ocean" title="Clear the parent state focus">
              Under {parentProc.name} in {focus.join(", ")} ×
            </button>
          )}
          {metrics && (
            <span className="ml-auto text-muted">
              {metrics.objects} objects · {metrics.conforming} conforming · {metrics.deviating} deviating
            </span>
          )}
        </div>
        <ErrorBox message={error} />
        {parentProc && <ParentStrip rec={rec} parent={parentProc} child={proc} focus={focus} setFocus={setFocus} onPick={onPick} />}
        <svg
          ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          className={`min-h-0 flex-1 ${manual ? "select-none" : ""}`}
          data-layout={manual ? "manual" : "auto"}
          onPointerMove={(e) => {
            if (!drag) return;
            const p = svgPoint(e);
            // positions snap to a 10 px grid
            const x = Math.round((p.x - drag.dx) / 10) * 10;
            const y = Math.round((p.y - drag.dy) / 10) * 10;
            if (x !== drag.x || y !== drag.y) setDrag({ ...drag, x, y, moved: true });
          }}
          onPointerUp={() => {
            if (!drag) return;
            const d = drag;
            if (d.moved) void save({ ...proc, states: proc.states.map((s) => (s.id === d.id ? { ...s, x: d.x, y: d.y } : s)) }).then(() => setDrag(null));
            else setDrag(null);
          }}
          onPointerLeave={() => drag && !drag.moved && setDrag(null)}
        >
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
            </marker>
          </defs>
          <GraphLayer
            g={lay}
            dim={DIM}
            label={(id) => (proc.states.find((s) => s.id === id)?.label ?? id).slice(0, expandable.includes(id) ? 16 : 20)}
            metrics={metrics}
            view={view}
            sankey={sankey}
            edgeStatus={(from, to) => (newOnly.some((x) => x.from === from && x.to === to) ? "new" : mining?.unused_transitions.some((u) => u.from === from && u.to === to) ? "unused" : "defined")}
            nodeStyle={(id) => ({ isNew: newStates.includes(id) && !proc.states.some((s) => s.id === id), unused: mining?.unused_states.includes(id) })}
            selState={selected?.kind === "state" && !selected.pid ? selected.id : null}
            selTrans={selected?.kind === "transition" && !selected.pid ? selected.t : null}
            onState={(id) => select({ kind: "state", id })}
            onTransition={(t) => select({ kind: "transition", t })}
            onStateDown={
              manual
                ? (id, e) => {
                    const b = pos[id];
                    if (!b || !proc.states.some((s) => s.id === id)) return;
                    const p = svgPoint(e);
                    setDrag({ id, dx: p.x - b.x, dy: p.y - b.y, x: b.x, y: b.y, moved: false, vb });
                  }
                : undefined
            }
          />
          {/* the nested level: per state the expand / collapse toggle and, when open, each subprocess' graph */}
          {expandable.map((sid) => {
            const b = pos[sid];
            if (!b) return null;
            const on = expanded.includes(sid);
            const n = under(sid);
            return (
              <g key={`nest-${sid}`}>
                {!on && hier.length > 0 && (
                  <text x={b.x + b.w - 10} y={b.y + 41} textAnchor="end" fontSize={10} className="pointer-events-none fill-muted">
                    {n} linked
                  </text>
                )}
                <g transform={`translate(${b.x + b.w - 26},${b.y + 8})`} className="cursor-pointer" onClick={() => setExpanded(on ? expanded.filter((x) => x !== sid) : [...expanded, sid])}>
                  <title>{on ? "Collapse" : `Expand: draw ${children.map((c) => c.name).join(", ")} for the objects in this state`}</title>
                  <rect width={18} height={18} rx={4} fill="var(--color-panel-2)" stroke="#475569" />
                  <text x={9} y={13.5} textAnchor="middle" fontSize={13} className="fill-soft">
                    {on ? "−" : "+"}
                  </text>
                </g>
                {(lay.groups[sid] ?? []).map((grp) => {
                  const c = children.find((x) => x.id === grp.pid);
                  if (!c) return null;
                  const m = nestedM[`${deviations}|${c.id}|${sid}`] ?? null;
                  const mine = selected?.pid === c.id && selected.under === sid;
                  return (
                    <g key={grp.pid}>
                      <rect x={grp.box.x - 8} y={grp.box.y} width={grp.box.w + 16} height={grp.box.h + 8} rx={8} fill="var(--color-panel-2)" fillOpacity={0.6} stroke="var(--color-line-2)" />
                      <text x={grp.title.x} y={grp.title.y + 2} fontSize={11} className="cursor-pointer fill-ocean" fontWeight={600} onClick={() => onPick(c.id, [sid])}>
                        <title>Open {c.name} focused on this state</title>
                        {c.name.slice(0, 28)} ↗
                        <tspan className="fill-muted" fontWeight={400}>
                          {"  "}
                          {m ? `${m.objects} objects` : "…"}
                        </tspan>
                      </text>
                      <GraphLayer
                        g={grp.graph}
                        dim={NESTED_DIM}
                        nested
                        label={(id) => (c.states.find((s) => s.id === id)?.label ?? id).slice(0, 17)}
                        metrics={m}
                        view={view}
                        sankey={sankey}
                        selState={mine && selected?.kind === "state" ? selected.id : null}
                        selTrans={mine && selected?.kind === "transition" ? selected.t : null}
                        onState={(id) => select({ kind: "state", id, pid: c.id, under: sid })}
                        onTransition={(t) => select({ kind: "transition", t, pid: c.id, under: sid })}
                        onStateOpen={() => onPick(c.id, [sid])}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {proc.actions.map((a, i) => {
            const ins = a.inputs.map((s) => pos[s]).filter(Boolean);
            if (!ins.length) return null;
            const x = Math.max(...ins.map((q) => q.x + q.w)) + 30;
            const y = vb.y + 20 + i * 26;
            return (
              <g key={i} transform={`translate(${x},${y})`}>
                <rect width={170} height={20} rx={4} fill="rgba(167,139,250,0.15)" stroke="#a78bfa" />
                <text x={8} y={14} fontSize={10} className="fill-soft">
                  {a.automation ? "⚡ " : "▶ "}
                  {(actionTypes.find((x) => x.id === a.action_type_id)?.display_name ?? a.action_type_id).slice(0, 26)}
                </text>
              </g>
            );
          })}
        </svg>
      </main>
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel">
        <div className="flex border-b border-line">
          {(["output", "paths", "mining", "data", "actions", "nested"] as const).map((p) => (
            <button key={p} type="button" onClick={() => setPanel(p)} className={`flex-1 px-1 py-2.5 text-[11px] capitalize ${panel === p ? "border-b-2 border-ocean text-white" : "text-muted"}`}>
              {p}
            </button>
          ))}
        </div>
        <div className="space-y-3 p-3 text-xs">
          {panel === "output" && <OutputPanel rec={rec} proc={proc} selected={selected} focus={focus} onRemove={save} manual={manual} />}
          {panel === "nested" && <NestedPanel rec={rec} proc={proc} types={types} focus={focus} setFocus={setFocus} onSaved={onSaved} onPick={onPick} />}
          {panel === "paths" && (
            <div className="space-y-1.5">
              <div className="text-muted">Paths taken (latest path per object)</div>
              {(metrics?.paths ?? []).map((p, i) => (
                <div key={i} className="rounded border border-line p-2">
                  <div className="mb-1 flex justify-between">
                    <span className="font-medium">{p.count} objects</span>
                    <span className="text-muted">{Math.round((p.count / Math.max(1, metrics!.objects)) * 100)}%</span>
                  </div>
                  <div className="text-soft">{p.path.join(" → ")}</div>
                </div>
              ))}
              {!metrics?.paths.length && <div className="text-muted">No process log yet: set it up in Data.</div>}
            </div>
          )}
          {panel === "mining" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span>Keep top</span>
                <input type="number" min={1} max={100} value={keep} onChange={(e) => setKeep(Number(e.target.value) || 100)} onBlur={() => mine()} className={`${fieldClass} w-16`} />
                <span>% of transitions</span>
              </div>
              {!mining && (
                <button type="button" onClick={() => mine()} className={buttonClass.secondary}>
                  Mine the data
                </button>
              )}
              {mining && (
                <>
                  <div className="text-muted">
                    {mining.transitions_kept} of {mining.transitions_total} transitions kept. Amber: found in the data, not defined. Dashed: defined, never seen.
                  </div>
                  {[...newStates.map((s) => ({ key: s, label: `State ${s}` })), ...newTrans.map((x) => ({ key: `${x.from}->${x.to}`, label: `${x.from === START ? "start" : x.from} → ${x.to} (${x.count})` }))].map((el) => (
                    <div key={el.key} className="flex items-center gap-2 rounded border border-warn/40 bg-warn/5 px-2 py-1">
                      <span className="flex-1">{el.label}</span>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            onSaved(await machinery.accept(rec.id, proc.id, { states: [], transitions: [], exclude: [el.key] }));
                            void mine();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                        className="text-muted hover:text-bad"
                      >
                        Exclude
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={!newStates.length && !newTrans.length}
                    onClick={async () => {
                      try {
                        onSaved(await machinery.accept(rec.id, proc.id, { states: newStates, transitions: newTrans.map((x) => ({ from: x.from, to: x.to })), exclude: [] }));
                        setMining(null);
                        void load();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                    className={`${buttonClass.primary} w-full`}
                  >
                    Accept mined elements
                  </button>
                  {proc.excluded.length > 0 && <div className="text-muted">Excluded: {proc.excluded.join(", ")}</div>}
                </>
              )}
            </div>
          )}
          {panel === "data" && <DataPanel rec={rec} proc={proc} onDone={(r) => (r && onSaved(r), void load())} />}
          {panel === "actions" && <ActionsPanel rec={rec} proc={proc} actionTypes={actionTypes} save={save} />}
          {!proc.parent && rec.processes.length > 1 && children.length === 0 && (
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog({ message: `Remove the process ${proc.name} from ${rec.name}? Its process log object type stays.`, danger: true, confirmLabel: "Remove" }))) return;
                try {
                  const rest = rec.processes.filter((p) => p.id !== proc.id);
                  onSaved(await machinery.save(rec.id, { name: rec.name, description: rec.description, auto_layout: rec.auto_layout, processes: rest }));
                  onPick(rest[0].id);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={`${buttonClass.ghost} mt-4`}
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> Remove this process
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              if (await confirmDialog({ message: `Delete ${rec.name}? The process log object type stays.`, danger: true, confirmLabel: "Delete" })) {
                await machinery.remove(rec.id);
                onDeleted();
              }
            }}
            className={`${buttonClass.ghost} mt-4`}
          >
            <Icon name="trash" className="h-3.5 w-3.5" /> Delete resource
          </button>
        </div>
      </aside>
      {editing && <RenameDialog rec={rec} proc={proc} onClose={() => setEditing(false)} onSave={async (head, name) => (await save({ ...proc, name }, head)) && setEditing(false)} />}
      {linking && (
        <TransitionDialog
          proc={proc}
          from={selected?.kind === "state" && !selected.pid ? selected.id : undefined}
          onClose={() => setLinking(false)}
          onAdd={async (t) => (await save({ ...proc, transitions: [...proc.transitions, t] })) && setLinking(false)}
        />
      )}
    </>
  );
}

/** The resource's name and description, and the name of the process shown. */
function RenameDialog({ rec, proc, onClose, onSave }: { rec: Machinery; proc: Process; onClose: () => void; onSave: (head: { name: string; description: string }, processName: string) => void }) {
  const [name, setName] = useState(rec.name);
  const [description, setDescription] = useState(rec.description ?? "");
  const [processName, setProcessName] = useState(proc.name);
  return (
    <Modal title="Rename" icon="pencil" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <label className="block text-xs text-muted">
          Resource name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={`${inputClass} mt-1`} aria-label="Resource name" />
        </label>
        <label className="block text-xs text-muted">
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} className={`${inputClass} mt-1`} aria-label="Resource description" />
        </label>
        <label className="block text-xs text-muted">
          Process name
          <input value={processName} onChange={(e) => setProcessName(e.target.value)} maxLength={200} className={`${inputClass} mt-1`} aria-label="Process name" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim() || !processName.trim()} onClick={() => onSave({ name: name.trim(), description: description.trim() }, processName.trim())} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A transition drawn by hand: from the start or a state, to a state (mining finds the ones the data already took). */
function TransitionDialog({ proc, from: from0, onClose, onAdd }: { proc: Process; from?: string; onClose: () => void; onAdd: (t: Transition) => void }) {
  const [from, setFrom] = useState(from0 ?? START);
  const [to, setTo] = useState(proc.states.find((s) => s.id !== from0)?.id ?? proc.states[0]?.id ?? "");
  const exists = proc.transitions.some((x) => x.from === from && x.to === to);
  const name = (s: { id: string; label?: string }) => s.label || s.id;
  return (
    <Modal title="Add transition" icon="plus" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <label className="block text-xs text-muted">
          From
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} mt-1`} aria-label="Transition from">
            <option value={START}>start (an object&apos;s first state)</option>
            {proc.states.map((s) => (
              <option key={s.id} value={s.id}>
                {name(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          To
          <select value={to} onChange={(e) => setTo(e.target.value)} className={`${inputClass} mt-1`} aria-label="Transition to">
            {proc.states.map((s) => (
              <option key={s.id} value={s.id}>
                {name(s)}
              </option>
            ))}
          </select>
        </label>
        {exists && <p className="text-xs text-warn">This transition is already defined.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Close
          </button>
          <button type="button" disabled={!to || exists} onClick={() => onAdd({ from, to })} className={buttonClass.primary}>
            Add transition
          </button>
        </div>
      </div>
    </Modal>
  );
}

function OutputPanel({ rec, proc: shown, selected, focus: shownFocus, onRemove, manual }: { rec: Machinery; proc: Process; selected: Sel | null; focus: string[]; onRemove: (p: Process) => void; manual?: boolean }) {
  const [mode, setMode] = useState<"current" | "ever">("current");
  const [out, setOut] = useState<{ total: number; objects: { primary_key: string; title: string }[] } | null>(null);
  const [dist, setDist] = useState<{ count: number; buckets: { from_h: number; to_h: number; count: number }[] } | null>(null);
  // a selection inside an expanded state: the subprocess, among the objects under that state
  const sub = selected?.pid ? rec.processes.find((p) => p.id === selected.pid) ?? null : null;
  const proc = sub ?? shown;
  const underState = sub ? selected?.under : undefined;
  const focus = useMemo(() => (sub ? (underState ? [underState] : []) : shownFocus), [sub, underState, shownFocus]);
  useEffect(() => {
    if (!selected) return;
    const body = selected.kind === "state" ? { states: [selected.id], mode } : { transitions: [selected.t] };
    machinery.output(rec.id, proc.id, { ...body, parent_states: focus }).then(setOut, () => setOut(null));
    if (selected.kind === "state") machinery.durations(rec.id, proc.id, selected.id).then(setDist, () => setDist(null));
  }, [rec.id, proc.id, selected, mode, focus]);
  if (!selected) return <div className="text-muted">Select a state or a transition to see its objects and how long objects stay in it.</div>;
  const max = Math.max(1, ...(dist?.buckets ?? []).map((b) => b.count));
  return (
    <div className="space-y-3">
      <div className="font-medium">{selected.kind === "state" ? `State: ${selected.id}` : `Transition: ${selected.t.from === START ? "start" : selected.t.from} → ${selected.t.to}`}</div>
      {sub && (
        <div className="text-muted">
          {sub.name}, under {shown.name} objects currently in {underState}. The duration distribution covers every {sub.name} object.
        </div>
      )}
      {selected.kind === "state" && (
        <select value={mode} onChange={(e) => setMode(e.target.value as "current")} className={fieldClass} aria-label="Selection mode">
          <option value="current">Objects currently in this state</option>
          <option value="ever">Objects ever in this state</option>
        </select>
      )}
      {selected.kind === "state" && dist && dist.count > 0 && (
        <div>
          <div className="mb-1 text-muted">Duration distribution ({dist.count} stays, hours)</div>
          <div className="flex h-20 items-end gap-0.5">
            {dist.buckets.map((b, i) => (
              <div key={i} className="flex-1 rounded-t bg-ocean" style={{ height: `${(b.count / max) * 100}%` }} title={`${b.from_h.toFixed(1)}–${b.to_h.toFixed(1)} h: ${b.count}`} />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-muted">
            <span>{dist.buckets[0].from_h.toFixed(1)} h</span>
            <span>{dist.buckets.at(-1)!.to_h.toFixed(1)} h</span>
          </div>
        </div>
      )}
      {out && (
        <div>
          <div className="mb-1 text-muted">{out.total} objects</div>
          <div className="max-h-64 divide-y divide-line overflow-y-auto rounded border border-line">
            {out.objects.map((o) => (
              <Link key={o.primary_key} href={`/ontology/objects/${proc.object_type_id}/${encodeURIComponent(o.primary_key)}`} className="block truncate px-2 py-1 text-ocean hover:bg-panel-2">
                {o.title}
              </Link>
            ))}
          </div>
          {selected.kind === "state" && mode === "current" && (
            <Link href={`/object-explorer?type=${proc.object_type_id}&q=${encodeURIComponent(`"${selected.id}"`)}`} className="mt-1 inline-block text-ocean">
              Open in Object Explorer
            </Link>
          )}
        </div>
      )}
      {!sub && manual && selected.kind === "state" && proc.states.some((s) => s.id === selected.id) && (
        <StatePosition key={`${selected.id}|${proc.states.find((s) => s.id === selected.id)?.x}|${proc.states.find((s) => s.id === selected.id)?.y}`} state={proc.states.find((s) => s.id === selected.id)!} onSet={(x, y) => onRemove({ ...proc, states: proc.states.map((s) => (s.id === selected.id ? { ...s, x, y } : s)) })} />
      )}
      {!sub && selected.kind === "state" && proc.states.some((s) => s.id === selected.id) && (
        <button type="button" onClick={() => onRemove({ ...proc, states: proc.states.filter((s) => s.id !== selected.id), transitions: proc.transitions.filter((x) => x.from !== selected.id && x.to !== selected.id) })} className={buttonClass.ghost}>
          <Icon name="trash" className="h-3.5 w-3.5" /> Remove state from the definition
        </button>
      )}
      {!sub && selected.kind === "transition" && proc.transitions.some((x) => x.from === selected.t.from && x.to === selected.t.to) && (
        <button type="button" onClick={() => onRemove({ ...proc, transitions: proc.transitions.filter((x) => !(x.from === selected.t.from && x.to === selected.t.to)) })} className={buttonClass.ghost}>
          <Icon name="trash" className="h-3.5 w-3.5" /> Remove transition
        </button>
      )}
    </div>
  );
}

/** Manual layout: where the selected state is drawn, typed (dragging it on the graph does the same). */
function StatePosition({ state, onSet }: { state: { x?: number | null; y?: number | null }; onSet: (x: number, y: number) => void }) {
  const [x, setX] = useState(String(state.x ?? 0));
  const [y, setY] = useState(String(state.y ?? 0));
  const ok = x.trim() !== "" && y.trim() !== "" && Number.isFinite(Number(x)) && Number.isFinite(Number(y));
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted">Position</span>
      <input value={x} onChange={(e) => setX(e.target.value)} className={`${fieldClass} w-16`} aria-label="State x" inputMode="numeric" />
      <input value={y} onChange={(e) => setY(e.target.value)} className={`${fieldClass} w-16`} aria-label="State y" inputMode="numeric" />
      <button type="button" disabled={!ok || (Number(x) === state.x && Number(y) === state.y)} onClick={() => onSet(Number(x), Number(y))} className={buttonClass.secondary}>
        Move
      </button>
    </div>
  );
}

function DataPanel({ rec, proc, onDone }: { rec: Machinery; proc: Process; onDone: (r?: Machinery) => void }) {
  // the newest datasets as a list; any other one is picked in Files (Browse)
  const [datasets, setDatasets] = useState<DatasetRef[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [dataset, setDataset] = useState(proc.log?.changelog_dataset_id ?? "");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    timeseries.datasets().then(setDatasets, () => setDatasets([]));
  }, []);
  useEffect(() => {
    const id = proc.log?.changelog_dataset_id;
    if (id) api.drive.item(id).then((i) => setPicked((p) => p ?? { id: i.id, name: i.name }), () => undefined);
  }, [proc.log?.changelog_dataset_id]);
  const [fromEdits, setFromEdits] = useState(proc.log?.from_edits ?? true);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <div className="font-medium">Process log</div>
      {proc.log ? (
        <div className="text-muted">
          Log object type:{" "}
          <Link href={`/ontology/${proc.log.object_type_id}`} className="text-ocean">
            open in Nexus Manager
          </Link>
        </div>
      ) : (
        <div className="text-muted">No log yet. Machinery creates and maintains a log object type (old state, new state, timestamp, duration, path, isLatest).</div>
      )}
      <div className="flex gap-1.5">
        <select value={dataset} onChange={(e) => setDataset(e.target.value)} className={`${inputClass} min-w-0 flex-1`} aria-label="Changelog dataset">
          <option value="">No changelog dataset</option>
          {dataset && !datasets.some((d) => d.id === dataset) && <option value={dataset}>{picked?.id === dataset ? picked.name : dataset}</option>}
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {[...d.path, d.name].join(" / ")}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setBrowsing(true)} className={buttonClass.secondary} title="Pick the changelog dataset in Files">
          Browse…
        </button>
      </div>
      {browsing && (
        <DrivePicker
          title="Changelog dataset"
          canPick={(i) => (i.name.toLowerCase().endsWith(".parquet") ? null : "not a dataset")}
          onPick={(i) => {
            setPicked({ id: i.id, name: i.name });
            setDataset(i.id);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
      <div className="text-muted">A changelog dataset has the columns processId (the object&apos;s primary key), state and timestamp.</div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={fromEdits} onChange={(e) => setFromEdits(e.target.checked)} /> Track platform edits (needs Track user edit history)
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              const r = await machinery.setupLog(rec.id, proc.id, { changelog_dataset_id: dataset || null, from_edits: fromEdits });
              setMsg(`${r.log_entries} log entries`);
              onDone(await machinery.get(rec.id));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className={buttonClass.primary}
        >
          {proc.log ? "Update log" : "Set up log"}
        </button>
        {proc.log && (
          <button type="button" onClick={() => machinery.rebuildLog(rec.id, proc.id).then((r) => (setMsg(`${r.log_entries} log entries`), onDone()), (e: Error) => setError(e.message))} className={buttonClass.secondary}>
            Rebuild
          </button>
        )}
      </div>
      {msg && <div className="text-ok">{msg}</div>}
      <ErrorBox message={error} />
      <Link href="/object-edits" className="text-ocean">
        Edit history settings
      </Link>
    </div>
  );
}

function ActionsPanel({ rec, proc, actionTypes, save }: { rec: Machinery; proc: Process; actionTypes: ActionType[]; save: (p: Process) => void }) {
  const [options, setOptions] = useState<{ action_type_id: string; automation_id?: string; name: string; outputs: string[]; automation: boolean }[]>([]);
  useEffect(() => {
    machinery.actions(rec.id, proc.id).then(setOptions, () => setOptions([]));
  }, [rec.id, proc.id]);
  const states = proc.states.map((s) => s.id);
  return (
    <div className="space-y-2">
      <div className="text-muted">Actions cause transitions: input states before, output states after. Automations fire when an input state is reached.</div>
      {proc.actions.map((a, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-2">
          <div className="font-medium">
            {a.automation ? "⚡ " : ""}
            {actionTypes.find((x) => x.id === a.action_type_id)?.display_name ?? a.action_type_id}
          </div>
          {(["inputs", "outputs"] as const).map((k) => (
            <div key={k} className="flex flex-wrap gap-1">
              <span className="w-12 text-muted">{k}</span>
              {states.map((s) => (
                <label key={s} className="flex items-center gap-0.5">
                  <input type="checkbox" checked={a[k].includes(s)} onChange={(e) => save({ ...proc, actions: proc.actions.map((x, j) => (j === i ? { ...x, [k]: e.target.checked ? [...x[k], s] : x[k].filter((y) => y !== s) } : x)) })} />
                  {s}
                </label>
              ))}
            </div>
          ))}
          <button type="button" onClick={() => save({ ...proc, actions: proc.actions.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
            Remove
          </button>
        </div>
      ))}
      <select
        value=""
        onChange={(e) => {
          const o = options.find((x) => `${x.action_type_id}|${x.automation_id ?? ""}` === e.target.value);
          if (o) save({ ...proc, actions: [...proc.actions, { action_type_id: o.action_type_id, automation_id: o.automation_id, automation: o.automation, inputs: [], outputs: o.outputs.filter((x) => states.includes(x)) }] });
        }}
        className={inputClass}
        aria-label="Import an action"
      >
        <option value="">Import an action or automation…</option>
        {options.map((o) => (
          <option key={`${o.action_type_id}|${o.automation_id ?? ""}`} value={`${o.action_type_id}|${o.automation_id ?? ""}`}>
            {o.automation ? "Automation: " : "Action: "}
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Subprocess hierarchy: this process' parent and the parent states to focus on, its subprocesses, and a new one. */
function NestedPanel({ rec, proc, types, focus, setFocus, onSaved, onPick }: {
  rec: Machinery;
  proc: Process;
  types: ObjectType[];
  focus: string[];
  setFocus: (s: string[]) => void;
  onSaved: (r: Machinery) => void;
  onPick: (pid: string) => void;
}) {
  const [rows, setRows] = useState<HierarchyRow[]>([]);
  const [links, setLinks] = useState<LinkType[]>([]);
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [prop, setProp] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    machinery.hierarchy(rec.id).then(setRows, () => setRows([]));
    om.linkTypes({ object_type_id: proc.object_type_id }).then(setLinks, () => setLinks([]));
  }, [rec, proc.object_type_id]);
  const me = rows.find((r) => r.id === proc.id);
  const parent = rec.processes.find((p) => p.id === proc.parent?.process_id) ?? null;
  const children = rec.processes.filter((p) => p.parent?.process_id === proc.id);
  const other = (l: LinkType) => (l.source.object_type_id === proc.object_type_id ? l.target.object_type_id : l.source.object_type_id);
  const chosen = links.find((l) => l.id === link) ?? links[0];
  const childType = chosen ? types.find((t) => t.id === other(chosen)) : undefined;
  const strings = (childType?.properties ?? []).filter((p) => p.type === "string" && !p.array);
  const stateProp = strings.some((p) => p.api_name === prop) ? prop : strings[0]?.api_name ?? "";
  const put = async (processes: Process[], pick: string) => {
    try {
      onSaved(await machinery.save(rec.id, { name: rec.name, description: rec.description, auto_layout: rec.auto_layout, processes }));
      setError(null);
      onPick(pick);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      {parent ? (
        <div className="space-y-1.5">
          <div className="font-medium">
            Subprocess of{" "}
            <button type="button" onClick={() => onPick(parent.id)} className="text-ocean hover:underline">
              {parent.name}
            </button>
          </div>
          <div className="text-muted">Covers the {me?.objects ?? "…"} objects linked to that process&apos; objects. Focus on the ones under a parent state:</div>
          {parent.states.map((s) => (
            <label key={s.id} className="flex items-center gap-2">
              <input type="checkbox" checked={focus.includes(s.id)} onChange={(e) => setFocus(e.target.checked ? [...focus, s.id] : focus.filter((x) => x !== s.id))} />
              <span className="flex-1">{s.label || s.id}</span>
              <span className="text-muted">{me?.by_parent_state?.[s.id] ?? "…"}</span>
            </label>
          ))}
          {parent.states.length === 0 && <div className="text-muted">The parent process has no states yet.</div>}
          {children.length === 0 && (
            <button
              type="button"
              onClick={async () => {
                if (await confirmDialog({ message: `Remove the subprocess ${proc.name}? Its process log object type stays.`, danger: true, confirmLabel: "Remove" })) await put(rec.processes.filter((p) => p.id !== proc.id), parent.id);
              }}
              className={buttonClass.ghost}
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> Remove this subprocess
            </button>
          )}
        </div>
      ) : (
        <div className="text-muted">A root process. Nest a subprocess over the objects linked to this process&apos; objects — for example the work orders of each claim.</div>
      )}
      <div className="space-y-1">
        <div className="font-medium">Subprocesses</div>
        {children.map((c) => (
          <button key={c.id} type="button" onClick={() => onPick(c.id)} className="flex w-full justify-between rounded border border-line px-2 py-1 text-left hover:bg-panel-2">
            <span className="text-ocean">{c.name}</span>
            <span className="text-muted">{rows.find((r) => r.id === c.id)?.objects ?? "…"} objects</span>
          </button>
        ))}
        {children.length === 0 && <div className="text-muted">None yet.</div>}
      </div>
      <div className="space-y-1.5 rounded border border-line p-2">
        <div className="font-medium">Add a subprocess</div>
        {links.length === 0 ? (
          <div className="text-muted">This object type has no link types: add one in Nexus Manager.</div>
        ) : (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={inputClass} />
            <select value={chosen?.id ?? ""} onChange={(e) => setLink(e.target.value)} className={inputClass} aria-label="Link type to the subprocess objects">
              {links.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.display_name} → {types.find((t) => t.id === other(l))?.display_name ?? other(l)}
                </option>
              ))}
            </select>
            <select value={stateProp} onChange={(e) => setProp(e.target.value)} className={inputClass} aria-label="Subprocess state property">
              {strings.map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  State: {p.display_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!name || !chosen || !childType || !stateProp}
              onClick={() => {
                if (!chosen || !childType) return;
                const id = `proc-${crypto.randomUUID().slice(0, 8)}`;
                void put([...rec.processes, { id, name, object_type_id: childType.id, state_property: stateProp, states: [], transitions: [], actions: [], log: null, excluded: [], parent: { process_id: proc.id, link_type_id: chosen.id } }], id);
              }}
              className={`${buttonClass.primary} w-full`}
            >
              Add subprocess
            </button>
          </>
        )}
      </div>
      <ErrorBox message={error} />
    </div>
  );
}

/** A subprocess drawn under its parent: the parent's states in flow order, each with how many of this process'
 * objects sit under parent objects in it; clicking one focuses the graph on them. */
function ParentStrip({ rec, parent, child, focus, setFocus, onPick }: {
  rec: Machinery;
  parent: Process;
  child: Process;
  focus: string[];
  setFocus: (s: string[]) => void;
  onPick: (pid: string) => void;
}) {
  const [row, setRow] = useState<HierarchyRow | null>(null);
  useEffect(() => {
    machinery.hierarchy(rec.id).then((h) => setRow(h.find((x) => x.id === child.id) ?? null), () => setRow(null));
  }, [rec, child.id]);
  const order = Object.entries(layoutGraph(stateIds(parent), parent.transitions).nodes).filter(([id]) => id !== START).sort((a, b) => a[1].x - b[1].x || a[1].y - b[1].y).map(([id]) => id);
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel/60 px-3 py-1.5 text-xs">
      <button type="button" onClick={() => onPick(parent.id)} className="shrink-0 font-medium text-ocean hover:underline">
        {parent.name}
      </button>
      <span className="shrink-0 text-muted">›</span>
      {order.map((sid, i) => {
        const on = focus.includes(sid);
        const n = row?.by_parent_state?.[sid];
        return (
          <span key={sid} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span className="text-muted">→</span>}
            <button
              type="button"
              onClick={() => setFocus(on ? focus.filter((x) => x !== sid) : [...focus, sid])}
              title={`${n ?? "…"} ${child.name} objects under ${parent.name} objects in ${sid}`}
              className={`rounded-md border px-2 py-0.5 ${on ? "border-ocean bg-ocean/15 text-white" : "border-line text-soft hover:border-ocean"}`}
            >
              {parent.states.find((x) => x.id === sid)?.label || sid} <span className="text-muted">{n ?? "…"}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
