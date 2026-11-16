"use client";

import { useEffect, useRef, useState } from "react";
import { CATEGORIES, defOf, labelOf, UNKNOWN_DEF, type FlowNode } from "@/lib/flow";
import type { DebugEntry } from "@/lib/flowRuntime";
import { Icon, type IconName } from "../Icon";

export type SidebarTab = "info" | "debug" | "devices";
export type Reading = { device: string; metric: string; unit?: string; values: { t: number; v: number }[] };

const TABS: { id: SidebarTab; label: string; icon: IconName }[] = [
  { id: "info", label: "Info", icon: "info" },
  { id: "debug", label: "Debug", icon: "bug" },
  { id: "devices", label: "Devices", icon: "gauge" },
];

export function FlowSidebar({
  tab,
  onTab,
  nodes,
  selected,
  debug,
  readings,
  running,
  onClearDebug,
  onReveal,
}: {
  tab: SidebarTab;
  onTab: (t: SidebarTab) => void;
  nodes: FlowNode[];
  selected: string[];
  debug: DebugEntry[];
  readings: Reading[];
  running: boolean;
  onClearDebug: () => void;
  onReveal: (nodeId: string) => void;
}) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-10 shrink-0 items-stretch border-b border-line text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 ${tab === t.id ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}
          >
            <Icon name={t.icon} className="h-3.5 w-3.5" />
            {t.label}
            {t.id === "debug" && debug.length > 0 && <span className="rounded bg-panel-2 px-1 text-[10px] text-soft">{debug.length}</span>}
          </button>
        ))}
      </div>
      {tab === "info" && <InfoTab nodes={nodes} selected={selected} running={running} />}
      {tab === "debug" && <DebugTab entries={debug} nodes={nodes} selected={selected} onClear={onClearDebug} onReveal={onReveal} />}
      {tab === "devices" && <DevicesTab readings={readings} running={running} />}
    </aside>
  );
}

function InfoTab({ nodes, selected, running }: { nodes: FlowNode[]; selected: string[]; running: boolean }) {
  const node = selected.length === 1 ? nodes.find((n) => n.id === selected[0]) : undefined;
  if (node) {
    const def = defOf(node);
    const props = Object.entries(node).filter(([k]) => !["id", "type", "name", "x", "y", "wires", "d", "itemId", "parentId", "password"].includes(k));
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="h-3 w-3 rounded-sm ring-1 ring-black/20" style={{ background: def.color }} />
          {labelOf(node)}
        </div>
        <table className="mt-3 w-full">
          <tbody className="[&_td]:border-b [&_td]:border-line [&_td]:py-1.5 [&_td:first-child]:w-24 [&_td:first-child]:text-muted">
            <tr>
              <td>Node</td>
              <td className="font-mono">{node.id}</td>
            </tr>
            <tr>
              <td>Type</td>
              <td>{node.type}</td>
            </tr>
            <tr>
              <td>Runs in</td>
              <td>{def === UNKNOWN_DEF ? "—" : def.runtime === "gateway" ? "Device gateway" : "Browser runtime"}</td>
            </tr>
            {node.d && (
              <tr>
                <td>State</td>
                <td className="text-warn">Disabled</td>
              </tr>
            )}
            {props.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="break-all font-mono text-soft">{typeof v === "object" ? JSON.stringify(v) : String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 leading-relaxed text-soft">{def.info}</p>
      </div>
    );
  }
  const counts = CATEGORIES.map((c) => ({ ...c, n: nodes.filter((x) => defOf(x).category === c.id && defOf(x) !== UNKNOWN_DEF).length }));
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs text-soft">
      <p>
        <span className="font-semibold text-white">{nodes.length}</span> nodes in this flow{selected.length > 1 ? `, ${selected.length} selected` : ""}.{" "}
        {running ? <span className="text-ok">Running in this tab.</span> : <span className="text-muted">Not running — Deploy to start it.</span>}
      </p>
      <ul className="space-y-1">
        {counts
          .filter((c) => c.n)
          .map((c) => (
            <li key={c.id} className="flex justify-between border-b border-line pb-1">
              <span className="text-muted">{c.label}</span>
              {c.n}
            </li>
          ))}
      </ul>
      <div className="space-y-2 leading-relaxed text-muted">
        <p>Drag nodes from the palette, wire an output port (right) to an input port (left), double-click a node to edit it, then Deploy.</p>
        <p>
          The flow runs in this browser tab while it is open: simulated sensors, cameras, MQTT over WebSocket and HTTP run here. OPC-UA, Kafka, Modbus and RTSP nodes need the
          device gateway and stay idle.
        </p>
        <p>Import a Node-RED export (Menu → Import) — inject, debug, function, change, switch, range, filter, smooth, delay, json, mqtt and http nodes carry over.</p>
        <p className="font-mono text-[11px]">Ctrl+A select all · Ctrl+C / X / V · Delete · Ctrl+Z / Y · Ctrl+D deploy</p>
      </div>
    </div>
  );
}

const LEVEL_CLASS: Record<DebugEntry["level"], string> = {
  log: "border-line",
  warn: "border-warn/60 bg-warn/5",
  error: "border-bad/60 bg-bad/5",
  alert: "border-bad bg-bad/10",
};

function DebugTab({
  entries,
  nodes,
  selected,
  onClear,
  onReveal,
}: {
  entries: DebugEntry[];
  nodes: FlowNode[];
  selected: string[];
  onClear: () => void;
  onReveal: (nodeId: string) => void;
}) {
  const [onlySelected, setOnlySelected] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const shown = onlySelected ? entries.filter((e) => selected.includes(e.nodeId)) : entries;
  const stick = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  const known = new Set(nodes.map((n) => n.id));
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs text-muted">
        <select value={onlySelected ? "sel" : "all"} onChange={(e) => setOnlySelected(e.target.value === "sel")} className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-xs outline-none">
          <option value="all">all nodes</option>
          <option value="sel">selected nodes</option>
        </select>
        <button type="button" onClick={onClear} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-panel-2 hover:text-white" title="Clear messages">
          <Icon name="trash" className="h-3.5 w-3.5" /> clear
        </button>
      </div>
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2"
      >
        {!shown.length && <p className="p-2 text-xs text-muted">Messages from debug nodes, warnings and alerts appear here.</p>}
        {shown.map((e) => (
          <div key={e.id} className={`rounded border-l-2 bg-ink/40 px-2 py-1.5 text-[11px] ${LEVEL_CLASS[e.level]}`}>
            <div className="flex items-center gap-1.5 text-muted">
              <span className="tabular-nums">{new Date(e.at).toLocaleTimeString()}</span>
              <button
                type="button"
                disabled={!known.has(e.nodeId)}
                onClick={() => onReveal(e.nodeId)}
                className="min-w-0 truncate text-ocean hover:underline disabled:text-muted disabled:no-underline"
              >
                node: {e.nodeName}
              </button>
            </div>
            {(e.topic || e.property) && (
              <div className="text-muted">
                {e.topic ? `${e.topic} : ` : ""}
                {e.property ?? ""}
                {e.property ? ` : ${typeName(e.value)}` : ""}
              </div>
            )}
            <Value value={e.value} level={e.level} />
          </div>
        ))}
      </div>
    </>
  );
}

const typeName = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? `array[${v.length}]` : typeof v);

function Value({ value, level }: { value: unknown; level: DebugEntry["level"] }) {
  const image = findImage(value);
  if (typeof value !== "object" || value === null)
    return <div className={`break-all font-mono ${level === "error" ? "text-bad" : level === "warn" ? "text-warn" : level === "alert" ? "font-semibold text-white" : "text-soft"}`}>{String(value)}</div>;
  const text = JSON.stringify(value, (_, v) => (typeof v === "string" && v.startsWith("data:image/") ? `<image ${Math.round(v.length / 1024)} kB>` : v), 2);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL frame */}
      {image && <img src={image} alt="" className="my-1 max-h-32 rounded border border-line" />}
      <details>
        <summary className="cursor-pointer truncate font-mono text-soft">{text.replace(/\s+/g, " ").slice(0, 120)}</summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-soft">{text}</pre>
      </details>
    </>
  );
}

function findImage(v: unknown, depth = 0): string | undefined {
  if (typeof v === "string") return v.startsWith("data:image/") ? v : undefined;
  if (!v || typeof v !== "object" || depth > 2) return undefined;
  for (const x of Object.values(v)) {
    const found = findImage(x, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function DevicesTab({ readings, running }: { readings: Reading[]; running: boolean }) {
  const devices = [...new Set(readings.map((r) => r.device))].sort();
  if (!devices.length)
    return (
      <p className="p-3 text-xs leading-relaxed text-muted">
        {running ? "Waiting for readings…" : "Deploy the flow to see live readings."} Sensors, cameras, telemetry nodes and numeric MQTT messages are listed here per device.
      </p>
    );
  // a device is stale when it has been quiet for 30 s while others kept reporting
  const now = Math.max(...readings.map((r) => r.values[r.values.length - 1]?.t ?? 0));
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
      {devices.map((d) => {
        const rows = readings.filter((r) => r.device === d);
        const seen = Math.max(...rows.map((r) => r.values[r.values.length - 1]?.t ?? 0));
        const stale = now - seen > 30000;
        return (
          <div key={d} className="rounded-lg border border-line bg-ink/40">
            <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-xs">
              <span className={`h-2 w-2 rounded-full ${stale ? "bg-muted" : "bg-ok"}`} />
              <Icon name="device" className="h-3.5 w-3.5 text-muted" />
              <span className="min-w-0 flex-1 truncate font-medium">{d}</span>
              <span className="text-[10px] text-muted">{new Date(seen).toLocaleTimeString()}</span>
            </div>
            <ul>
              {rows.map((r) => {
                const vs = r.values.map((x) => x.v);
                const last = vs[vs.length - 1];
                return (
                  <li key={r.metric} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                    <span className="w-20 truncate text-muted">{r.metric}</span>
                    <span className="w-20 text-right font-mono tabular-nums">
                      {+last.toFixed(2)}
                      {r.unit ? <span className="ml-0.5 text-muted">{r.unit}</span> : null}
                    </span>
                    <Sparkline values={vs} />
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="flex-1" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = 100;
  const h = 22;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${max === min ? h / 2 : h - 2 - ((v - min) / (max - min)) * (h - 4)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-5 min-w-0 flex-1" aria-label={`min ${min}, max ${max}`}>
      <polyline points={pts} fill="none" stroke="var(--color-ocean)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
