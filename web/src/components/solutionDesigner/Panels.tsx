"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import {
  CATEGORY_COLOR,
  categoryOf,
  sd,
  size,
  type Architect,
  type AssistTurn,
  type Catalog,
  type Component,
  type CriticMessage,
  type Diagram,
  type Graph,
  type Pattern,
  type Plan,
  type ResourceRef,
  type SDEdge,
  type SDNode,
  type Section,
  type Settings,
  type Step,
  type Version,
  type Wizard,
} from "@/lib/solutionDesigner";

export const nid = () => `n-${Math.random().toString(36).slice(2, 10)}`;
export const eid = () => `e-${Math.random().toString(36).slice(2, 10)}`;
const label = "block text-xs text-muted";

// ------------------------------------------------------------------------------------------------
// Diagram information, settings, reference library
// ------------------------------------------------------------------------------------------------

export function InfoPanel({ graph, onChange, readOnly }: { graph: Graph; onChange: (g: Graph) => void; readOnly: boolean }) {
  return (
    <div className="space-y-3 p-3 text-xs">
      <label className={label}>
        Diagram description
        <textarea value={graph.description} readOnly={readOnly} onChange={(e) => onChange({ ...graph, description: e.target.value })} rows={8} className={`${inputClass} mt-1 text-xs`} placeholder="What this solution does, for whom, and the decisions it supports" />
      </label>
      <div className="text-muted">
        {graph.nodes.length} nodes · {graph.edges.length} connections · {graph.nodes.filter((n) => n.kind === "resource").length} linked resources
      </div>
      <div>
        <div className="mb-1 font-medium text-soft">Documentation</div>
        {[
          ["Diagrams: nodes, connections, groups", "Component (Ctrl+B), Resource, Concept, Group and Text in the toolbar; drag from a node's right handle to another node to connect them."],
          ["AIP Architect", "Plan a workflow from requirements: concept nodes, then implementation patterns for each and a data model for the Nexus node."],
          ["AIP Critic", "Ask questions about the diagram; generate an implementation plan and export it as PDF."],
          ["Shortcuts", "Shift-drag: box select · Ctrl+C / Ctrl+V · Delete · Ctrl+Z / Ctrl+Y · ?viewer=true opens read-only · ?focus=<resource id> centers a node."],
        ].map(([t, d]) => (
          <div key={t} className="border-t border-line py-1.5">
            <div className="text-soft">{t}</div>
            <div className="text-muted">{d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SETTINGS: [keyof Settings, string][] = [
  ["edge_labels", "Edge labels"],
  ["edge_validity", "Edge validity shading"],
  ["flow_animation", "Edge flow animation"],
  ["minimap", "Mini-map"],
  ["dots", "Background grid"],
  ["pan_mode", "Pan mode"],
  ["minimized", "Minimized node display"],
  ["aip", "AIP features"],
];

export function SettingsPanel({ graph, onChange, readOnly }: { graph: Graph; onChange: (g: Graph) => void; readOnly: boolean }) {
  const s = graph.settings;
  return (
    <div className="space-y-2 p-3 text-xs">
      {SETTINGS.map(([k, t]) => (
        <label key={k} className="flex items-center gap-2">
          <input type="checkbox" checked={!!s[k]} disabled={readOnly && k !== "pan_mode"} onChange={(e) => onChange({ ...graph, settings: { ...s, [k]: e.target.checked } })} /> {t}
        </label>
      ))}
      <label className={label}>
        Icons
        <select value={s.icons} disabled={readOnly} onChange={(e) => onChange({ ...graph, settings: { ...s, icons: e.target.value as Settings["icons"] } })} className={`${inputClass} mt-1`}>
          <option value="color">In color</option>
          <option value="mono">Monochrome</option>
          <option value="none">Hidden</option>
        </select>
      </label>
      <p className="text-muted">Settings are saved with the diagram.</p>
    </div>
  );
}

export function ReferencesPanel({ onUse, readOnly }: { onUse: (id: string, mode: "new" | "add" | "replace") => void; readOnly: boolean }) {
  const [refs, setRefs] = useState<Awaited<ReturnType<typeof sd.references>>>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    sd.references().then(setRefs, () => {});
  }, []);
  const shown = refs.filter((r) => `${r.name} ${r.description} ${r.category}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-2 p-3 text-xs">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search patterns" className={inputClass} />
      {[...new Set(shown.map((r) => r.category))].map((c) => (
        <div key={c}>
          <div className="mt-2 text-[10px] uppercase tracking-wider text-muted">{c}</div>
          {shown
            .filter((r) => r.category === c)
            .map((r) => (
              <div key={r.id} className="mt-1 rounded border border-line p-2">
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="w-full text-left font-medium text-soft">
                  {r.name}
                </button>
                {open === r.id && (
                  <>
                    <p className="mt-1 text-muted">{r.description}</p>
                    <div className="mt-1 text-[10px] text-muted">{r.components.join(" → ")}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button type="button" onClick={() => onUse(r.id, "new")} className={buttonClass.secondary}>
                        New diagram
                      </button>
                      {!readOnly && (
                        <>
                          <button type="button" onClick={() => onUse(r.id, "add")} className={buttonClass.secondary}>
                            Add to diagram
                          </button>
                          <button type="button" onClick={() => window.confirm("Replace the whole diagram with this pattern?") && onUse(r.id, "replace")} className={buttonClass.secondary}>
                            Override
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// The selected node: configuration, documentation card, node traversal, object traversal
// ------------------------------------------------------------------------------------------------

const ICONS: IconName[] = ["info", "database", "server", "plug", "cube", "table", "pipeline", "code", "sparkle", "logic", "device", "grid", "doc", "bell", "eye", "globe", "folder", "wave", "filter", "graph", "cpu", "bolt", "link", "clock"];
const COLORS = ["", "#1e3a5f", "#14532d", "#4c1d95", "#7c2d12", "#713f12", "#831843", "#334155"];

/** AIP Assist: questions about the component on a node's documentation card, answered with the diagram as context.
 * The answer streams in; closing the dialog stops it. The conversation lives in the dialog (not saved). */
export function AssistDialog({ diagram, models, node, comp, graph, onClose }: { diagram: Diagram; models: { id: string; label: string; default?: boolean }[]; node: SDNode; comp: Component; graph: Graph; onClose: () => void }) {
  const [turns, setTurns] = useState<AssistTurn[]>([]);
  const [q, setQ] = useState("");
  const [model, setModel] = useState(models.find((m) => m.default)?.id ?? models[0]?.id ?? "");
  const [live, setLive] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" }); // (newer browsers return a promise: never the effect's cleanup)
  }, [turns, live]);
  const suggested = [`What is ${comp.name} for in this diagram?`, `How do I set up ${comp.name} for "${node.title || comp.name}"?`, `What are the alternatives to ${comp.name} here?`];
  const send = async (text: string) => {
    if (!text.trim() || live !== null) return;
    const ac = new AbortController();
    abort.current = ac;
    const history = turns;
    setTurns([...history, { role: "user", text }]);
    setQ("");
    setErr(null);
    setLive("");
    try {
      const r = await sd.assistStream(diagram.id, { node_id: node.id, question: text, history, graph: diagram.can_edit ? graph : undefined, model }, (t) => !ac.signal.aborted && setLive(t ?? ""), ac.signal);
      setTurns([...history, { role: "user", text }, { role: "assistant", text: r.answer }]);
    } catch (e) {
      if (ac.signal.aborted || (e as Error).name === "AbortError") return;
      setErr((e as Error).message);
    }
    if (abort.current === ac) abort.current = null;
    setLive(null);
  };
  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    setLive(null);
  };
  return (
    <Modal title={`AIP Assist · ${comp.name}`} icon="sparkle" onClose={onClose} wide>
      <div className="flex min-h-0 flex-col gap-2 text-xs" data-assist>
        <div className="rounded border border-line bg-panel-2 p-2 text-muted">
          <span className="text-soft">{node.title || comp.name}</span> — {comp.description}
        </div>
        <div className="max-h-[50vh] min-h-24 space-y-2 overflow-auto">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ml-8 rounded-lg bg-ocean/15 px-2.5 py-1.5 text-soft">
                {t.text}
              </div>
            ) : (
              <div key={i} className="md-body rounded-lg border border-line p-2 leading-relaxed text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }} />
            ),
          )}
          {live !== null && (
            <div className="rounded-lg border border-line p-2" data-assist-live>
              {live ? <div className="md-body leading-relaxed text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(live) }} /> : <p className="text-muted">AIP Assist is reading the documentation…</p>}
              <button type="button" onClick={stop} className="mt-1 text-muted hover:text-bad">
                Stop
              </button>
            </div>
          )}
          {!turns.length && live === null && (
            <div className="space-y-1">
              {suggested.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="block text-left text-ocean hover:underline">
                  {s}
                </button>
              ))}
            </div>
          )}
          {err && <p className="text-bad">{err}</p>}
          <div ref={end} />
        </div>
        <div className="flex gap-1">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(q)} placeholder={`Ask about ${comp.name}`} className={inputClass} autoFocus />
          <button type="button" disabled={live !== null || !q.trim()} onClick={() => send(q)} className={buttonClass.primary}>
            Send
          </button>
        </div>
        <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputClass} text-xs`} aria-label="Model">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}

export function NodePanel({
  node,
  graph,
  catalog,
  resolved,
  readOnly,
  onChange,
  onFocus,
  onLink,
  onAddTraversal,
  onAsk,
  onClose,
  onCreateType,
  assist,
}: {
  node: SDNode;
  graph: Graph;
  catalog: Catalog;
  resolved: Record<string, { ok: boolean; name?: string; href?: string; reason?: string }>;
  readOnly: boolean;
  onChange: (n: SDNode) => void;
  onFocus: (id: string) => void;
  onLink: () => void;
  onAddTraversal: (t: { link: string; object_type_id: string; object_type: string }) => void;
  onAsk: (q: string) => void;
  /** a proposed object type: create it in the Ontology */
  onCreateType?: () => void;
  onClose: () => void;
  /** AIP Assist on the documentation card (when AIP features are on) */
  assist?: { diagram: Diagram; models: { id: string; label: string; default?: boolean }[] } | null;
}) {
  const comps = useMemo(() => Object.fromEntries(catalog.components.map((c) => [c.id, c])), [catalog]);
  const comp: Component | undefined = comps[node.component ?? (node.resource?.kind === "object_type" ? "object-type" : node.resource?.kind === "action_type" ? "action-type" : node.resource?.kind === "interface" ? "interface" : "")];
  const [more, setMore] = useState(false);
  // the node whose AIP Assist dialog is open (another node selected closes it)
  const [assistFor, setAssistFor] = useState<string | null>(null);
  const [trav, setTrav] = useState<Awaited<ReturnType<typeof sd.traversal>> | null>(null);
  const res = node.resource ? resolved[`${node.resource.kind}:${node.resource.id}`] : null;
  const href = res?.href ?? node.href ?? comp?.href ?? null;
  const typeId = node.resource?.kind === "object_type" ? node.resource.id : null;
  useEffect(() => {
    if (!typeId) return;
    let stale = false;
    sd.traversal(typeId).then((t) => !stale && setTrav(t), () => {});
    return () => {
      stale = true;
    };
  }, [typeId]);
  const titles = Object.fromEntries(graph.nodes.map((n) => [n.id, n.title || n.kind]));
  const conn = graph.edges.filter((e) => e.from === node.id || e.to === node.id);
  const cats = Object.fromEntries(catalog.concepts.map((c) => [c.id, c]));
  return (
    <aside className="w-80 shrink-0 overflow-auto border-l border-line bg-panel text-xs" data-node-panel>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: CATEGORY_COLOR[categoryOf(node, comps, cats)] }} />
        <span className="flex-1 truncate font-medium">{node.title || node.kind}</span>
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      {comp && node.kind !== "group" && node.kind !== "text" && !node.doc_minimized && (
        <div className="m-3 rounded-lg border border-line bg-panel-2 p-2.5" data-doc-card>
          <div className="flex items-center gap-1.5">
            <Icon name={comp.icon} className="h-3.5 w-3.5 text-ocean" />
            <span className="font-medium">{comp.name}</span>
            <button type="button" onClick={() => onChange({ ...node, doc_minimized: true })} className="ml-auto text-muted hover:text-white" aria-label="Minimize">
              <Icon name="minus" className="h-3 w-3" />
            </button>
          </div>
          <p className="mt-1 text-muted">{comp.description}</p>
          {more && <p className="mt-1 text-muted">Category: {catalog.categories.find((c) => c.id === comp.category)?.name}. {comp.href ? `Built in ${comp.name} at ${comp.href}.` : "Outside the platform."}</p>}
          <div className="mt-1 flex gap-3">
            <button type="button" onClick={() => setMore(!more)} className="text-ocean">
              {more ? "Show less" : "Show more"}
            </button>
            {comp.href && (
              <Link href={comp.href} target="_blank" className="text-ocean">
                Open {comp.name}
              </Link>
            )}
            {assist ? (
              <button type="button" onClick={() => setAssistFor(node.id)} className="text-ocean" data-ask-assist>
                Ask Assist
              </button>
            ) : (
              <button type="button" onClick={() => onAsk(`How should ${comp.name} be used for "${node.title}" in this architecture?`)} className="text-ocean">
                Ask
              </button>
            )}
          </div>
        </div>
      )}
      {assistFor === node.id && assist && comp && <AssistDialog key={node.id} diagram={assist.diagram} models={assist.models} node={node} comp={comp} graph={graph} onClose={() => setAssistFor(null)} />}
      {node.doc_minimized && (
        <button type="button" onClick={() => onChange({ ...node, doc_minimized: false })} className="m-3 flex items-center gap-1 text-ocean">
          <Icon name="info" className="h-3.5 w-3.5" /> Documentation
        </button>
      )}
      <div className="space-y-2 px-3 pb-3">
        <label className={label}>
          Title
          <input value={node.title} readOnly={readOnly} onChange={(e) => onChange({ ...node, title: e.target.value })} className={`${inputClass} mt-1`} />
        </label>
        {node.kind !== "group" && (
          <label className={label}>
            {node.kind === "text" ? "Text" : "Description"}
            <textarea value={node.kind === "text" ? node.title : node.description ?? ""} readOnly={readOnly} rows={4}
              onChange={(e) => onChange(node.kind === "text" ? { ...node, title: e.target.value } : { ...node, description: e.target.value })} className={`${inputClass} mt-1 text-xs`} />
          </label>
        )}
        {(node.kind === "resource" || node.kind === "component") && (
          <div className="rounded border border-line p-2">
            <div className="text-muted">Linked resource</div>
            {node.resource ? (
              <div className="mt-1">
                <div className={res && !res.ok ? "text-bad" : "text-soft"}>
                  {res?.name ?? node.resource.name} <span className="text-muted">({node.resource.kind.replace("_", " ")})</span>
                </div>
                {res && !res.ok && <div className="text-bad">{res.reason}</div>}
                <div className="mt-1 flex gap-3">
                  {href && res?.ok !== false && (
                    <Link href={href} target="_blank" className="text-ocean">
                      Open
                    </Link>
                  )}
                  {!readOnly && (
                    <>
                      <button type="button" onClick={onLink} className="text-ocean">
                        Change
                      </button>
                      <button type="button" onClick={() => onChange({ ...node, kind: node.component ? "component" : "resource", resource: null, component: node.component ?? "custom" })} className="text-muted hover:text-bad">
                        Remove linked resource
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              !readOnly && (
                <button type="button" onClick={onLink} className="mt-1 text-ocean">
                  Link resource
                </button>
              )
            )}
          </div>
        )}
        {node.kind === "object" && node.proposed && (
          <div className="rounded border border-line p-2">
            <div className="text-muted">Proposed object type (AIP Architect)</div>
            <div className="mt-1 text-[10px] text-muted">primary key {node.proposed.primary_key} · title {node.proposed.title_property}</div>
            {node.proposed.properties.map((p) => (
              <div key={p.name} className="flex gap-2 font-mono text-[10px]">
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-muted">{p.dataType}</span>
              </div>
            ))}
            {!readOnly && onCreateType ? (
              <button type="button" onClick={onCreateType} className="mt-1 block text-ocean">
                Create this object type
              </button>
            ) : (
              <Link href="/ontology" target="_blank" className="mt-1 block text-ocean">
                Create in Nexus Manager
              </Link>
            )}
          </div>
        )}
        {!readOnly && (
          <>
            <div className={label}>Background color</div>
            <div className="flex gap-1">
              {COLORS.map((c) => (
                <button key={c || "none"} type="button" onClick={() => onChange({ ...node, color: c || null })} title={c || "Default"}
                  className={`h-5 w-5 rounded border ${(node.color ?? "") === c ? "border-ocean" : "border-line-2"}`} style={{ background: c || "transparent" }} />
              ))}
            </div>
            {node.kind !== "group" && node.kind !== "text" && (
              <>
                <div className={label}>Icon</div>
                <div className="flex flex-wrap gap-1">
                  {ICONS.map((i) => (
                    <button key={i} type="button" onClick={() => onChange({ ...node, icon: node.icon === i ? null : i })} className={`rounded border p-1 ${node.icon === i ? "border-ocean" : "border-line-2"}`} aria-label={i}>
                      <Icon name={i} className="h-3 w-3" />
                    </button>
                  ))}
                  <input type="color" value={node.icon_color ?? "#3b82f6"} onChange={(e) => onChange({ ...node, icon_color: e.target.value })} className="h-6 w-8 rounded border border-line-2 bg-transparent" title="Icon color" />
                </div>
              </>
            )}
            <label className={label}>
              Tags (marking, organization, team; comma-separated)
              <input value={(node.tags ?? []).join(", ")} onChange={(e) => onChange({ ...node, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} className={`${inputClass} mt-1`} />
            </label>
            <div className="flex items-center gap-2">
              <span className="text-muted">Overlap order</span>
              <button type="button" onClick={() => onChange({ ...node, z: Math.max(...graph.nodes.map((n) => n.z ?? 0)) + 1 })} className="text-ocean">
                Bring to front
              </button>
              <button type="button" onClick={() => onChange({ ...node, z: Math.min(...graph.nodes.map((n) => n.z ?? 0)) - 1 })} className="text-ocean">
                Send to back
              </button>
            </div>
          </>
        )}
        <div className="font-medium text-soft">Node traversal</div>
        {conn.map((e) => {
          const other = e.from === node.id ? e.to : e.from;
          return (
            <button key={e.id} type="button" onClick={() => onFocus(other)} className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-panel-2">
              <span className="text-muted">{e.from === node.id ? "→" : "←"}</span>
              <span className="flex-1 truncate">{titles[other]}</span>
              {e.label && <span className="truncate text-[10px] text-muted">{e.label}</span>}
            </button>
          );
        })}
        {!conn.length && <p className="text-muted">Not connected.</p>}
        {node.parent && (
          <button type="button" onClick={() => onFocus(node.parent!)} className="text-ocean">
            In group {titles[node.parent]}
          </button>
        )}
        {typeId && (
          <>
            <div className="font-medium text-soft">Object traversal</div>
            {trav?.map((t) => {
              const there = graph.nodes.some((n) => n.resource?.kind === "object_type" && n.resource.id === t.object_type_id);
              return (
                <div key={t.link_type_id} className="flex items-center gap-1">
                  <span className="flex-1 truncate">
                    {t.name} → {t.object_type}
                  </span>
                  {!readOnly && !there && (
                    <button type="button" onClick={() => onAddTraversal({ link: t.name, object_type_id: t.object_type_id, object_type: t.object_type })} className="text-ocean">
                      Create traversal
                    </button>
                  )}
                  {there && <span className="text-muted">on the diagram</span>}
                </div>
              );
            })}
            {trav && !trav.length && <p className="text-muted">No link types.</p>}
          </>
        )}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------------------------------------
// AIP Architect
// ------------------------------------------------------------------------------------------------

export function WizardDialog({ models, initial, onClose, onGenerate }: { models: { id: string; label: string; default?: boolean }[]; initial?: Wizard | null; onClose: () => void; onGenerate: (w: Wizard) => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [w, setW] = useState<Wizard>(
    initial ?? { artifact: "Workshop application", summary: "", source: "Existing platform data", frequency: "daily", scale: "", data_properties: [], code_level: "low", model: models.find((m) => m.default)?.id ?? models[0]?.id ?? null },
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const opt = (v: string, cur: string, set: (v: string) => void) => (
    <button key={v} type="button" onClick={() => set(v)} className={`rounded-lg border px-3 py-2 text-left text-xs ${cur === v ? "border-ocean bg-ocean/10 text-white" : "border-line-2 text-soft"}`}>
      {v}
    </button>
  );
  return (
    <Modal title="AIP Architect" icon="sparkle" onClose={onClose} wide>
      <div className="space-y-3 p-5 text-sm" data-wizard>
        <div className="flex gap-2 text-xs text-muted">
          {["What to build", "Source data", "How to build"].map((t, i) => (
            <span key={t} className={i === step ? "text-ocean" : ""}>
              {i + 1}. {t}
            </span>
          ))}
        </div>
        {step === 0 && (
          <>
            <div className="text-xs text-muted">The end product or artifact</div>
            <div className="grid grid-cols-3 gap-2">{["Workshop application", "Dataset", "Dashboard", "Document or report", "Custom web application", "Automated workflow"].map((v) => opt(v, w.artifact, (x) => setW({ ...w, artifact: x })))}</div>
            <label className={label}>
              Workflow requirements
              <textarea value={w.summary} onChange={(e) => setW({ ...w, summary: e.target.value })} rows={6} className={`${inputClass} mt-1`} placeholder="I want to build an application that… optimized for…" />
            </label>
          </>
        )}
        {step === 1 && (
          <>
            <div className="text-xs text-muted">Where the data comes from</div>
            <div className="grid grid-cols-2 gap-2">{["External data source/system", "Manual upload", "Existing platform data", "User input data (forms)"].map((v) => opt(v, w.source, (x) => setW({ ...w, source: x })))}</div>
            <div className="grid grid-cols-2 gap-2">
              <label className={label}>
                Update frequency
                <select value={w.frequency} onChange={(e) => setW({ ...w, frequency: e.target.value })} className={`${inputClass} mt-1`}>
                  {["real time", "hourly", "daily", "weekly", "monthly", "one-off"].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label className={label}>
                Data scale
                <input value={w.scale} onChange={(e) => setW({ ...w, scale: e.target.value })} className={`${inputClass} mt-1`} placeholder="e.g. 2M rows, 500 documents a day" />
              </label>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              {["geospatial", "time series", "media (images, audio, video)", "documents", "personal / sensitive"].map((p) => (
                <label key={p} className="flex items-center gap-1">
                  <input type="checkbox" checked={w.data_properties.includes(p)} onChange={(e) => setW({ ...w, data_properties: e.target.checked ? [...w.data_properties, p] : w.data_properties.filter((x) => x !== p) })} /> {p}
                </label>
              ))}
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["no", "No code", "Point-and-click"],
                  ["low", "Low code", "Basic functions"],
                  ["pro", "Pro code", "Mostly in a code editor"],
                ] as const
              ).map(([v, t, d]) => (
                <button key={v} type="button" onClick={() => setW({ ...w, code_level: v })} className={`rounded-lg border p-3 text-left text-xs ${w.code_level === v ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                  <div className="font-medium text-white">{t}</div>
                  <div className="text-muted">{d}</div>
                </button>
              ))}
            </div>
            <label className={label}>
              Model
              <select value={w.model ?? ""} onChange={(e) => setW({ ...w, model: e.target.value })} className={`${inputClass} mt-1`}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-between">
          <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)} className={buttonClass.secondary}>
            Back
          </button>
          {step < 2 ? (
            <button type="button" disabled={step === 0 && w.summary.trim().length < 3} onClick={() => setStep(step + 1)} className={buttonClass.primary}>
              Next
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !w.model}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await onGenerate(w);
                } catch (e) {
                  setErr((e as Error).message);
                  setBusy(false);
                }
              }}
              className={buttonClass.primary}
            >
              {busy ? "Generating…" : "Generate workflow graph"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Pattern nodes placed where the concept node is, wired to the concept's connections (the preview and the insert). */
export function placePattern(p: Pattern, concept: SDNode, graph: Graph): { nodes: SDNode[]; edges: SDEdge[]; rewire: SDEdge[] } {
  const ids: Record<string, string> = {};
  const nodes: SDNode[] = p.components.map((c, i) => {
    const id = nid();
    ids[c.key] = id;
    return { id, kind: "component", component: c.component, title: c.title, description: c.description, tags: ["aip-architect"], x: concept.x + (i % 3) * 250, y: concept.y + 130 + Math.floor(i / 3) * 110 };
  });
  const edges = p.edges.map((e) => ({ id: eid(), from: ids[e.from], to: ids[e.to], label: e.label }));
  const rewire = graph.edges
    .filter((e) => e.from === concept.id || e.to === concept.id)
    .map((e) => (e.to === concept.id ? { ...e, id: eid(), to: ids[p.entry] } : { ...e, id: eid(), from: ids[p.exit] }));
  return { nodes, edges, rewire };
}

export function ArchitectPanel({
  diagram,
  graph,
  models,
  readOnly,
  sel,
  onGraph,
  onPreview,
  onWizard,
  onArchitect,
  onFocus,
}: {
  diagram: Diagram;
  graph: Graph;
  models: { id: string; label: string; default?: boolean }[];
  readOnly: boolean;
  sel: string | null;
  onGraph: (g: Graph) => void;
  onPreview: (p: { nodes: SDNode[]; edges: SDEdge[] } | null) => void;
  onWizard: () => void;
  onArchitect: (a: Architect) => void;
  onFocus: (id: string) => void;
}) {
  const plan = diagram.architect;
  const [model, setModel] = useState(plan?.model ?? models.find((m) => m.default)?.id ?? models[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(plan?.summary ?? "");
  const [patterns, setPatterns] = useState<{ node: string; list: Pattern[] } | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [walk, setWalk] = useState<{ steps: Step[]; i: number } | null>(null);
  // implementation suggestions being written (streamed); aborted when the panel closes
  const [writing, setWriting] = useState<{ node: string; list: Partial<Pattern>[] } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const concepts = graph.nodes.filter((n) => n.kind === "concept");
  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    try {
      await f();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErr((e as Error).message);
    }
    setBusy(null);
  };
  const suggest = (c: SDNode) =>
    run(c.id, async () => {
      setPicked(null);
      onPreview(null);
      setPatterns(null);
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setWriting({ node: c.id, list: [] });
      try {
        const r = await sd.implementStream(diagram.id, c.id, graph, model, (p) => !ac.signal.aborted && setWriting({ node: c.id, list: p?.patterns ?? [] }), ac.signal);
        setPatterns({ node: c.id, list: r.patterns });
      } finally {
        if (abort.current === ac) abort.current = null;
        setWriting(null);
      }
    });
  const stopWriting = () => {
    abort.current?.abort();
    abort.current = null;
    setWriting(null);
    setBusy(null);
  };
  const choose = (i: number) => {
    if (!patterns) return;
    const concept = graph.nodes.find((n) => n.id === patterns.node);
    if (!concept) return;
    setPicked(i);
    const placed = placePattern(patterns.list[i], concept, graph);
    onPreview({ nodes: placed.nodes, edges: [...placed.edges, ...placed.rewire] });
  };
  const insert = async () => {
    if (!patterns || picked === null) return;
    const concept = graph.nodes.find((n) => n.id === patterns.node)!;
    const p = patterns.list[picked];
    const placed = placePattern(p, concept, graph);
    const group: SDNode = { id: nid(), kind: "group", title: concept.title, x: concept.x - 20, y: concept.y + 100, w: Math.min(3, p.components.length) * 250 + 20, h: Math.ceil(p.components.length / 3) * 110 + 50, tags: ["aip-architect"] };
    onGraph({
      ...graph,
      nodes: [...graph.nodes.filter((n) => n.id !== concept.id), group, ...placed.nodes.map((n) => ({ ...n, parent: group.id }))],
      edges: [...graph.edges.filter((e) => e.from !== concept.id && e.to !== concept.id), ...placed.edges, ...placed.rewire],
    });
    onPreview(null);
    setPatterns(null);
    setPicked(null);
    onArchitect(await sd.implemented(diagram.id, concept.id, p.name));
  };
  if (walk) {
    const s = walk.steps[walk.i];
    return (
      <div className="space-y-2 p-3 text-xs" data-walkthrough>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setWalk(null)} className="text-muted hover:text-white">
            ← Plan
          </button>
          <span className="ml-auto text-muted">
            Step {walk.i + 1} of {walk.steps.length}
          </span>
        </div>
        <div className="flex gap-1">
          <button type="button" disabled={walk.i === 0} onClick={() => setWalk({ ...walk, i: walk.i - 1 })} className={buttonClass.secondary}>
            Previous
          </button>
          <button type="button" disabled={walk.i >= walk.steps.length - 1} onClick={() => setWalk({ ...walk, i: walk.i + 1 })} className={buttonClass.secondary}>
            Next
          </button>
        </div>
        {s && (
          <div className="rounded border border-line p-2">
            <button type="button" onClick={() => onFocus(s.node_id)} className="text-sm font-medium text-white hover:underline">
              {s.title}
            </button>
            <div className="text-muted">{s.component}</div>
            {s.description && <p className="mt-1">{s.description}</p>}
            <p className="mt-1 text-soft">{s.what}</p>
            {s.after.length > 0 && <p className="mt-1 text-muted">After: {s.after.join(", ")}</p>}
            {s.href && (
              <Link href={s.href} target="_blank" className="mt-1 inline-block text-ocean">
                Open {s.component} →
              </Link>
            )}
          </div>
        )}
        <div className="space-y-0.5">
          {walk.steps.map((x, i) => (
            <button key={x.node_id} type="button" onClick={() => setWalk({ ...walk, i })} className={`block w-full truncate rounded px-1 text-left ${i === walk.i ? "bg-ocean/15 text-white" : "text-muted hover:text-white"}`}>
              {i + 1}. {x.title}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 p-3 text-xs" data-architect>
      {!plan?.summary && (
        <div className="space-y-2">
          <p className="text-muted">Describe what you want to build; AIP Architect plans it as concept nodes, then suggests implementations for each.</p>
          {!readOnly && (
            <button type="button" onClick={onWizard} className={buttonClass.primary}>
              <Icon name="sparkle" className="h-3.5 w-3.5" /> Start planning
            </button>
          )}
        </div>
      )}
      {plan?.summary && (
        <div className="rounded border border-line p-2">
          <div className="flex items-center">
            <span className="font-medium text-soft">Workflow summary</span>
            {!readOnly && (
              <button type="button" onClick={() => (setEditing(!editing), setSummary(plan.summary))} className="ml-auto text-muted hover:text-white" aria-label="Edit">
                <Icon name="pencil" className="h-3 w-3" />
              </button>
            )}
          </div>
          {editing ? (
            <>
              <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={5} className={`${inputClass} mt-1 text-xs`} />
              <button type="button" onClick={() => run("summary", async () => (onArchitect(await sd.summary(diagram.id, summary, model)), setEditing(false)))} className={`${buttonClass.secondary} mt-1`}>
                Update
              </button>
            </>
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-muted">{plan.summary}</p>
          )}
          {plan.wizard && (
            <p className="mt-1 text-[10px] text-muted">
              {plan.wizard.artifact} · {plan.wizard.source} · {plan.wizard.code_level} code
            </p>
          )}
        </div>
      )}
      <label className={label}>
        Model selection
        <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputClass} mt-1`}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {concepts.length > 0 && <div className="font-medium text-soft">Concept nodes</div>}
      {concepts.map((c) => (
        <div key={c.id} className={`rounded border p-2 ${sel === c.id ? "border-ocean" : "border-line"}`} data-concept={c.concept}>
          <button type="button" onClick={() => onFocus(c.id)} className="font-medium text-white hover:underline">
            {c.title}
          </button>
          <p className="text-muted">{c.description}</p>
          {!readOnly &&
            (c.concept === "ontology" ? (
              <div className="mt-1">
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="Describe the data model (object types and how they relate)" className={`${inputClass} text-xs`} />
                <button type="button" disabled={!!busy || prompt.trim().length < 3}
                  onClick={() => run(c.id, async () => {
                    const dm = await sd.dataModel(diagram.id, c.id, prompt, graph, model);
                    onGraph({ ...graph, nodes: [...graph.nodes, ...dm.nodes], edges: [...graph.edges, ...dm.edges, ...dm.nodes.slice(0, 1).map((n) => ({ id: eid(), from: c.id, to: n.id, label: "data model" }))] });
                  })} className={`${buttonClass.secondary} mt-1`}>
                  {busy === c.id ? "Generating…" : "Generate data model"}
                </button>
              </div>
            ) : (
              <button type="button" disabled={!!busy} onClick={() => suggest(c)} className={`${buttonClass.secondary} mt-1`}>
                {busy === c.id ? "Thinking…" : "Select implementation"}
              </button>
            ))}
          {writing?.node === c.id && (
            <div className="mt-2 space-y-1.5" data-patterns-live>
              {writing.list.length === 0 && <p className="text-muted">AIP Architect is looking at the diagram…</p>}
              {writing.list.map((p, i) => (
                <div key={i} className="rounded border border-line-2 p-2">
                  <div className="font-medium text-white">{p.name || "…"}</div>
                  {p.summary && <p className="text-muted">{p.summary}</p>}
                  {p.rationale && (
                    <p className="mt-1">
                      <span className="text-soft">Why: </span>
                      {p.rationale}
                    </p>
                  )}
                  {p.tradeoffs && (
                    <p className="mt-1">
                      <span className="text-soft">Trade-offs: </span>
                      {p.tradeoffs}
                    </p>
                  )}
                  {!!p.components?.some((x) => x?.title) && (
                    <ul className="mt-1 list-disc pl-4 text-muted">
                      {p.components.filter((x) => x?.title).map((x, j) => (
                        <li key={j}>
                          <span className="text-soft">{x?.title}</span>
                          {x?.description ? ` — ${x.description}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              <button type="button" onClick={stopWriting} className="text-muted hover:text-bad">
                Stop
              </button>
            </div>
          )}
          {patterns?.node === c.id && (
            <div className="mt-2 space-y-1.5" data-patterns>
              {patterns.list.map((p, i) => (
                <div key={i} className={`rounded border p-2 ${picked === i ? "border-ocean bg-ocean/5" : "border-line-2"}`}>
                  <button type="button" onClick={() => choose(i)} className="w-full text-left font-medium text-white">
                    {p.name}
                  </button>
                  <p className="text-muted">{p.summary}</p>
                  {picked === i && (
                    <>
                      <p className="mt-1">
                        <span className="text-soft">Why: </span>
                        {p.rationale}
                      </p>
                      <p className="mt-1">
                        <span className="text-soft">Trade-offs: </span>
                        {p.tradeoffs}
                      </p>
                      <ul className="mt-1 list-disc pl-4 text-muted">
                        {p.components.map((x) => (
                          <li key={x.key}>
                            <span className="text-soft">{x.title}</span> — {x.description}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-1 flex gap-1">
                        <button type="button" onClick={insert} className={buttonClass.primary}>
                          Insert into graph
                        </button>
                        <button type="button" onClick={() => (onPreview(null), setPicked(null))} className={buttonClass.secondary}>
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {diagram.architect?.implemented?.[c.id] && <p className="mt-1 text-ok">Implemented: {diagram.architect.implemented[c.id].pattern}</p>}
        </div>
      ))}
      {plan?.implemented && Object.keys(plan.implemented).length > 0 && (
        <div className="text-muted">Implemented: {Object.values(plan.implemented).map((x) => x.pattern).join(" · ")}</div>
      )}
      {err && <p className="text-bad">{err}</p>}
      {(plan?.summary || graph.nodes.length > 0) && (
        <button type="button" onClick={() => run("walk", async () => setWalk({ steps: (await sd.walkthrough(diagram.id)).steps, i: 0 }))} className={buttonClass.secondary}>
          {busy === "walk" ? "Loading…" : "Save and start building"}
        </button>
      )}
      {!readOnly && plan?.summary && (
        <button type="button" onClick={onWizard} className="block text-ocean">
          Plan again with the wizard
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// AIP Critic
// ------------------------------------------------------------------------------------------------

export function CriticPanel({ diagram, graph, models, onFocusNodes, ask }: { diagram: Diagram; graph: Graph; models: { id: string; label: string; default?: boolean }[]; onFocusNodes: (ids: string[]) => void; ask: { q: string; n: number } | null }) {
  const [state, setState] = useState<{ messages: CriticMessage[]; plan: Plan | null; sections: Section[]; suggested: string[] } | null>(null);
  const [q, setQ] = useState("");
  const [model, setModel] = useState(models.find((m) => m.default)?.id ?? models[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  // the answer being written (streamed); the request is aborted when the panel closes
  const [live, setLive] = useState<{ question: string; answer: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const lastAsk = useRef(0);
  useEffect(() => {
    sd.critic(diagram.id).then(setState, (e: Error) => setErr(e.message));
  }, [diagram.id]);
  useEffect(() => () => abort.current?.abort(), []);
  const send = async (text: string) => {
    if (!text.trim()) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy("ask");
    setErr(null);
    setLive({ question: text, answer: "" });
    try {
      const next = await sd.askStream(diagram.id, { question: text, graph: diagram.can_edit ? graph : undefined, model }, (p) => !ac.signal.aborted && setLive({ question: text, answer: p?.answer ?? "" }), ac.signal);
      setState(next);
      setQ("");
    } catch (e) {
      if (ac.signal.aborted || (e as Error).name === "AbortError") return;
      setErr((e as Error).message);
    }
    if (abort.current === ac) abort.current = null;
    setLive(null);
    setBusy(null);
  };
  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    setLive(null);
    setBusy(null);
  };
  const askN = ask?.n ?? 0;
  useEffect(() => {
    if (!askN || askN === lastAsk.current || !ask) return;
    lastAsk.current = askN;
    void send(ask.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askN]);
  return (
    <div className="flex h-full flex-col text-xs" data-critic>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {state?.sections.map((s) => (
          <details key={s.id} className="rounded border border-line">
            <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1">
              <span className="h-2 w-2 rounded-full" style={{ background: CATEGORY_COLOR[s.id] }} />
              {s.name} <span className="text-muted">{s.nodes.length}</span>
            </summary>
            <div className="px-2 pb-1">
              {s.nodes.map((n) => (
                <button key={n.id} type="button" onClick={() => onFocusNodes([n.id])} className="block truncate text-muted hover:text-white">
                  {n.title}
                </button>
              ))}
            </div>
          </details>
        ))}
        {state?.messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-6 rounded-lg bg-ocean/15 px-2.5 py-1.5 text-soft">
              {m.text}
              <div className="text-[10px] text-muted">
                {m.by} · {when(m.at)}
              </div>
            </div>
          ) : (
            <div key={i} className="rounded-lg border border-line p-2">
              <div className="md-body text-xs leading-relaxed text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
              {!!m.node_ids?.length && (
                <button type="button" onClick={() => onFocusNodes(m.node_ids!)} className="mt-1 text-ocean">
                  Show the {m.node_ids.length} node{m.node_ids.length === 1 ? "" : "s"} on the diagram
                </button>
              )}
              {m.follow_ups?.map((f) => (
                <button key={f} type="button" disabled={!!busy} onClick={() => send(f)} className="mt-1 block text-left text-ocean hover:underline">
                  ↳ {f}
                </button>
              ))}
            </div>
          ),
        )}
        {live && (
          <>
            <div className="ml-6 rounded-lg bg-ocean/15 px-2.5 py-1.5 text-soft">{live.question}</div>
            <div className="rounded-lg border border-line p-2" data-critic-live>
              {live.answer ? (
                <div className="md-body text-xs leading-relaxed text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.answer) }} />
              ) : (
                <p className="text-muted">AIP Critic is reviewing the diagram…</p>
              )}
              <button type="button" onClick={stop} className="mt-1 text-muted hover:text-bad">
                Stop
              </button>
            </div>
          </>
        )}
        {state && !state.messages.length && (
          <div className="space-y-1">
            <div className="text-muted">Suggested questions</div>
            {state.suggested.map((s) => (
              <button key={s} type="button" disabled={!!busy} onClick={() => send(s)} className="block text-left text-ocean hover:underline">
                {s}
              </button>
            ))}
          </div>
        )}
        {err && <p className="text-bad">{err}</p>}
      </div>
      <div className="space-y-1.5 border-t border-line p-2">
        <div className="flex gap-1">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(q)} placeholder="Ask about this diagram" className={inputClass} />
          <button type="button" disabled={!!busy || !q.trim()} onClick={() => send(q)} className={buttonClass.primary}>
            Send
          </button>
        </div>
        <div className="flex items-center gap-1">
          <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputClass} text-xs`}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {diagram.can_edit && state?.messages.length ? (
            <button type="button" onClick={async () => (await sd.clearCritic(diagram.id), setState(await sd.critic(diagram.id)))} className="shrink-0 text-muted hover:text-bad">
              Clear
            </button>
          ) : null}
        </div>
        <div className="flex gap-1">
          {diagram.can_edit && (
            <button type="button" disabled={!!busy} className={buttonClass.secondary}
              onClick={async () => {
                setBusy("plan");
                setErr(null);
                try {
                  const plan = await sd.plan(diagram.id, graph, model);
                  setState((s) => (s ? { ...s, plan } : s));
                  setPlanOpen(true);
                } catch (e) {
                  setErr((e as Error).message);
                }
                setBusy(null);
              }}>
              {busy === "plan" ? "Planning…" : "Generate implementation plan"}
            </button>
          )}
          {state?.plan && (
            <button type="button" onClick={() => setPlanOpen(true)} className={buttonClass.ghost}>
              View plan
            </button>
          )}
        </div>
      </div>
      {planOpen && state?.plan && <PlanDialog did={diagram.id} plan={state.plan} graph={graph} onClose={() => setPlanOpen(false)} onFocus={onFocusNodes} />}
    </div>
  );
}

export function PlanView({ plan, graph, onFocus, print }: { plan: Plan; graph?: Graph; onFocus?: (ids: string[]) => void; print?: boolean }) {
  const titles = Object.fromEntries((graph?.nodes ?? []).map((n) => [n.id, n.title]));
  return (
    <div className="space-y-3 text-sm" data-plan>
      <div>
        <h2 className="text-base font-semibold text-white">{plan.title}</h2>
        <p className="text-xs text-muted">
          Generated by AIP Critic {when(plan.generated_at)} for {plan.by} · diagram version {plan.version}
        </p>
        <p className="mt-2 text-soft">{plan.overview}</p>
      </div>
      {plan.phases.map((p, i) => (
        <details key={i} open={print || i === 0} className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer font-medium text-white">
            {p.name} <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">{p.effort} · {p.estimate}</span>
          </summary>
          <p className="mt-1 text-xs text-muted">{p.goal}</p>
          {p.depends_on.length > 0 && <p className="mt-1 text-xs text-muted">Depends on: {p.depends_on.join(", ")}</p>}
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
            {p.tasks.map((t, j) => (
              <li key={j}>
                <span className="text-soft">{t.title}</span> <span className="text-muted">({t.component})</span>
                <div className="text-muted">{t.detail}</div>
                {!print && onFocus && t.node_ids.some((x) => titles[x]) && (
                  <button type="button" onClick={() => onFocus(t.node_ids.filter((x) => titles[x]))} className="text-ocean">
                    {t.node_ids.filter((x) => titles[x]).map((x) => titles[x]).join(", ")}
                  </button>
                )}
              </li>
            ))}
          </ol>
          {p.best_practices.length > 0 && (
            <>
              <div className="mt-2 text-xs font-medium text-soft">Best practices</div>
              <ul className="list-disc pl-5 text-xs text-muted">
                {p.best_practices.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </>
          )}
        </details>
      ))}
      {plan.risks.length > 0 && (
        <div>
          <div className="font-medium text-white">Risks</div>
          <ul className="list-disc pl-5 text-xs text-muted">
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PlanDialog({ did, plan, graph, onClose, onFocus }: { did: string; plan: Plan; graph: Graph; onClose: () => void; onFocus: (ids: string[]) => void }) {
  return (
    <Modal title="Implementation plan" icon="list" onClose={onClose} wide>
      <div className="p-5">
        <div className="mb-3 flex gap-2">
          <a href={sd.planPdfUrl(did)} className={buttonClass.secondary}>
            <Icon name="download" className="h-3.5 w-3.5" /> Export PDF
          </a>
          <Link href={`/solution-designer/${did}/plan`} target="_blank" className={buttonClass.ghost}>
            Open as a page
          </Link>
        </div>
        <PlanView plan={plan} graph={graph} onFocus={(ids) => (onFocus(ids), onClose())} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------
// Pickers and dialogs
// ------------------------------------------------------------------------------------------------

export function ComponentPicker({ catalog, onPick, onClose }: { catalog: Catalog; onPick: (c: Component) => void; onClose: () => void }) {
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const list = catalog.components.filter((c) => (!cat || c.category === cat) && `${c.name} ${c.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Add a component" icon="grid" onClose={onClose} wide>
      <div className="flex h-[60vh] text-xs" data-component-picker>
        <div className="w-48 shrink-0 overflow-auto border-r border-line p-2">
          <button type="button" onClick={() => setCat(null)} className={`block w-full rounded px-2 py-1 text-left ${!cat ? "bg-ocean/15 text-white" : "text-muted"}`}>
            All components
          </button>
          {catalog.categories.map((c) => (
            <button key={c.id} type="button" onClick={() => setCat(c.id)} className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left ${cat === c.id ? "bg-ocean/15 text-white" : "text-muted"}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: CATEGORY_COLOR[c.id] }} /> {c.name}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="p-2">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search components" className={inputClass} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {list.map((c) => (
              <button key={c.id} type="button" onClick={() => onPick(c)} className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2" data-component={c.id}>
                <Icon name={c.icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean" />
                <span>
                  <span className="block text-soft">{c.name}</span>
                  <span className="block text-muted">{c.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

const RES_LABEL: Record<ResourceRef["kind"], string> = { file: "file", object_type: "object type", interface: "interface", action_type: "action type" };

export function ResourcePicker({ kind, onPick, onClose }: { kind: ResourceRef["kind"]; onPick: (r: ResourceRef & { href: string }) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Awaited<ReturnType<typeof sd.resources>>>([]);
  useEffect(() => {
    let stale = false;
    const t = setTimeout(() => sd.resources(kind, q).then((l) => !stale && setList(l), () => {}), 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [kind, q]);
  return (
    <Modal title={`Link a ${RES_LABEL[kind]}`} icon="link" onClose={onClose}>
      <div className="p-3 text-xs" data-resource-picker>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={inputClass} />
        <div className="mt-2 max-h-80 overflow-auto">
          {list.map((r) => (
            <button key={r.id} type="button" onClick={() => onPick(r)} className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2">
              <span className="block text-soft">{r.name}</span>
              <span className="block truncate text-muted">{r.subtitle}</span>
            </button>
          ))}
          {!list.length && <p className="p-2 text-muted">Nothing found.</p>}
        </div>
      </div>
    </Modal>
  );
}

export function VersionsDialog({ versions, current, onPreview, onRestore, onClose }: { versions: Version[]; current: number; onPreview: (v: number) => void; onRestore: (v: number) => void; onClose: () => void }) {
  return (
    <Modal title="Versions" icon="history" onClose={onClose}>
      <div className="max-h-[60vh] overflow-auto p-2 text-xs" data-versions>
        {versions.map((v) => (
          <div key={v.version} className="flex items-center gap-2 border-b border-line px-2 py-1.5">
            <span className="w-10 font-mono">v{v.version}</span>
            <span className="flex-1">
              <span className="block text-soft">
                {v.description || (v.manual ? "Saved" : "Autosaved")} {v.version === current && <span className="text-ocean">(current)</span>}
              </span>
              <span className="text-muted">
                {when(v.at)} · {v.by} · {v.nodes} nodes
              </span>
            </span>
            <button type="button" onClick={() => onPreview(v.version)} className="text-ocean">
              Preview
            </button>
            {v.version !== current && (
              <button type="button" onClick={() => onRestore(v.version)} className="text-ocean">
                Restore to this version
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** What differs between two versions of a diagram: nodes and connections only one side has, and nodes both have
 * that differ (moved or resized, or edited). */
export function compareGraphs(mine: Graph, theirs: Graph) {
  const a = new Map(mine.nodes.map((n) => [n.id, n]));
  const b = new Map(theirs.nodes.map((n) => [n.id, n]));
  const box = (n: SDNode) => JSON.stringify([n.x, n.y, n.w ?? null, n.h ?? null]);
  const body = (n: SDNode) => JSON.stringify({ ...n, x: 0, y: 0, w: 0, h: 0 });
  const ea = new Set(mine.edges.map((e) => `${e.from}>${e.to}:${e.label}`));
  const eb = new Set(theirs.edges.map((e) => `${e.from}>${e.to}:${e.label}`));
  return {
    onlyMine: mine.nodes.filter((n) => !b.has(n.id)),
    onlyTheirs: theirs.nodes.filter((n) => !a.has(n.id)),
    edited: mine.nodes.filter((n) => b.has(n.id) && body(n) !== body(b.get(n.id)!)),
    moved: mine.nodes.filter((n) => b.has(n.id) && body(n) === body(b.get(n.id)!) && box(n) !== box(b.get(n.id)!)),
    edgesMine: [...ea].filter((k) => !eb.has(k)).length,
    edgesTheirs: [...eb].filter((k) => !ea.has(k)).length,
    other: JSON.stringify(mine.settings) !== JSON.stringify(theirs.settings) || (mine.description ?? "") !== (theirs.description ?? ""),
  };
}

/** "Conflict on save": someone saved the diagram after this editor opened it. Keep your changes (overwrite the server
 * version), keep the server's changes (discard yours and load it), or cancel and merge by hand. */
export function ConflictDialog({ message, mine, server, onKeepMine, onKeepServer, onCancel }: {
  message: string;
  mine: Graph;
  server: Diagram | null;
  onKeepMine: () => Promise<void>;
  onKeepServer: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diff = server ? compareGraphs(mine, server.graph) : null;
  const latest = server?.versions.find((v) => v.version === server.version);
  const names = (ns: SDNode[]) => ns.slice(0, 6).map((n) => n.title || n.kind).join(", ") + (ns.length > 6 ? ` and ${ns.length - 6} more` : "");
  const row = (text: string, n: number, list?: SDNode[]) =>
    n > 0 && (
      <li key={text}>
        <span className="font-medium text-soft">{n}</span> {text}
        {list?.length ? <span className="text-muted"> · {names(list)}</span> : null}
      </li>
    );
  return (
    <Modal title="Conflict on save" icon="alert" onClose={onCancel}>
      <div className="space-y-3 p-4 text-xs" data-conflict-dialog>
        <p className="text-soft">Another user may be editing this diagram: {message}</p>
        {!server ? (
          <p className="text-muted">Reading the version on the server…</p>
        ) : (
          <>
            <p className="text-muted">
              Server: version {server.version}
              {latest ? `, saved ${when(latest.at)} by ${latest.by}` : ""} · {server.graph.nodes.length} nodes. Yours: {mine.nodes.length} nodes.
            </p>
            {diff && (
              <ul className="list-disc space-y-0.5 pl-5" data-conflict-diff>
                {row("nodes only in your version", diff.onlyMine.length, diff.onlyMine)}
                {row("nodes only on the server", diff.onlyTheirs.length, diff.onlyTheirs)}
                {row("nodes edited differently", diff.edited.length, diff.edited)}
                {row("nodes moved or resized differently", diff.moved.length, diff.moved)}
                {row("connections only in your version", diff.edgesMine)}
                {row("connections only on the server", diff.edgesTheirs)}
                {diff.other && <li>Settings or the description differ</li>}
                {!diff.onlyMine.length && !diff.onlyTheirs.length && !diff.edited.length && !diff.moved.length && !diff.edgesMine && !diff.edgesTheirs && !diff.other && <li>The two versions are the same</li>}
              </ul>
            )}
          </>
        )}
        {error && <p className="text-bad">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className={buttonClass.secondary} data-conflict="cancel">
            Cancel
          </button>
          <button type="button" disabled={busy || !server} onClick={onKeepServer} className={buttonClass.secondary} data-conflict="server">
            Keep server changes
          </button>
          <button type="button" disabled={busy || !server} data-conflict="mine" className={buttonClass.primary}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onKeepMine();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}>
            Keep your changes
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function LineageDialog({ onImport, onClose }: { onImport: (nodes: SDNode[], edges: SDEdge[]) => void; onClose: () => void }) {
  const [all, setAll] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [root, setRoot] = useState("");
  const [depth, setDepth] = useState(2);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    sd.lineage().then((g) => setAll(g.lineage_nodes), () => {});
  }, []);
  const shown = all.filter((n) => n.name.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <Modal title="Import from Data Lineage" icon="split" onClose={onClose}>
      <div className="space-y-2 p-4 text-xs">
        <p className="text-muted">Pick a lineage node to import it with its neighbors, or import the most connected part of the graph.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search datasets, pipelines, object types…" className={inputClass} />
        <div className="max-h-56 overflow-auto rounded border border-line">
          {shown.map((n) => (
            <button key={n.id} type="button" onClick={() => setRoot(n.id)} className={`flex w-full gap-2 px-2 py-1 text-left ${root === n.id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
              <span className="flex-1 truncate">{n.name}</span>
              <span className="text-muted">{n.kind}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-muted">
          Steps around it
          <input type="number" min={1} max={8} value={depth} onChange={(e) => setDepth(Number(e.target.value))} className={`${inputClass} w-16`} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={async () => (setBusy(true), (await sd.lineage().then((g) => onImport(g.nodes, g.edges))))} className={buttonClass.secondary}>
            Most connected
          </button>
          <button type="button" disabled={busy || !root} onClick={async () => (setBusy(true), (await sd.lineage(root, depth).then((g) => onImport(g.nodes, g.edges))))} className={buttonClass.primary}>
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The selected nodes' bounding offset, for pasting and inserting near the viewport. */
export function shift(nodes: SDNode[], edges: SDEdge[], dx: number, dy: number) {
  const map: Record<string, string> = Object.fromEntries(nodes.map((n) => [n.id, nid()]));
  return {
    nodes: nodes.map((n) => ({ ...n, id: map[n.id], x: n.x + dx, y: n.y + dy, parent: n.parent && map[n.parent] ? map[n.parent] : null })),
    edges: edges.filter((e) => map[e.from] && map[e.to]).map((e) => ({ ...e, id: eid(), from: map[e.from], to: map[e.to] })),
  };
}

export { size };
