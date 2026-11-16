"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon, iconPath, type IconName } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { COLOR_OPTIONS, coloring, PERMISSION_COLORS, permissionLegend, type ColorBy } from "@/components/lineage/coloring";
import { useAuth } from "@/components/AuthGate";
import { auth, type User } from "@/lib/auth";
import { SqlConsole } from "@/components/sql/SqlConsole";
import { BuildsPanel, CodeTab, HealthTab, HistogramPanel, HistoryTab, PreviewTab, PropertiesPanel, RelatedPanel, SchedulesPanel, TimelineTab } from "@/components/lineage/Panels";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import { CARDINALITY, ERD_ENDS, FAMILIES, familyOf, KIND_ICON, lineage, ROOT_APP, type LineageGraph, type Participation, type ParticipationSide, type LineageNode, type LineageRelation, type Permissions, type SavedGraph } from "@/lib/lineage";
import { confirmDialog } from "@/lib/dialogs";
import { runtime, type ScheduleRole, type ScheduleSummary } from "@/lib/runtime";
import { AipAssistButton, AipAssistPanel } from "@/components/aip/AipAssist";
import { lineageAssist } from "@/components/aip/lineageAssist";

const EMPTY: LineageGraph = { nodes: [], edges: [], kinds: {} };
const NODE_W = 210;
const NODE_H = 46;
const COL_GAP = 96;
const ROW_GAP = 22;

type Placed = LineageNode & { x: number; y: number; layer: number; zone?: number };
type Side = "properties" | "build" | "schedules" | "related";
const SIDE_TABS: [Side, string, IconName][] = [
  ["properties", "Properties", "info"],
  ["build", "Build", "play"],
  ["schedules", "Schedules", "clock"],
  ["related", "Related", "link"],
];
type Bottom = "preview" | "history" | "code" | "timeline" | "health" | "sql";

export default function LineagePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Route />
    </Suspense>
  );
}

/** Without a graph to open, the saved lineage graphs; the whole graph is fetched only once one is opened. */
function Route() {
  const params = useSearchParams();
  return ["graph", "nodes", "node", "focus", "all", "new"].some((k) => params.has(k)) ? <Lineage /> : <Landing />;
}

function Landing() {
  const router = useRouter();
  const [graphs, setGraphs] = useState<SavedGraph[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    lineage
      .graphs()
      .then(setGraphs)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <ApiError message={error} />;
  const q = query.trim().toLowerCase();
  const filtered = (graphs ?? []).filter((g) => !q || g.name.toLowerCase().includes(q));
  // test / bug-hunting graphs apart from the demos and real work (test_space.py)
  const regular = filtered.filter((g) => !g.test);
  const tests = filtered.filter((g) => g.test);
  const card = (g: SavedGraph) => (
            <div key={g.id} className="group relative flex h-36 flex-col rounded-xl border border-line bg-panel p-4 transition hover:-translate-y-0.5 hover:border-ocean/50 hover:shadow-lg hover:shadow-black/10">
              <Link href={`/lineage?graph=${g.id}`} className="absolute inset-0" aria-label={`Open ${g.name}`} />
              <div className="flex items-start gap-2">
                <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
                  <Icon name="split" className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{g.name}</div>
                  <div className="text-xs text-muted">
                    {g.nodes.length} node{g.nodes.length === 1 ? "" : "s"} · coloured by {COLOR_OPTIONS.find((o) => o.id === g.color_by)?.label.toLowerCase() ?? g.color_by}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!(await confirmDialog(`Delete the lineage graph "${g.name}"?`))) return;
                    await lineage.deleteGraph(g.id);
                    setGraphs((cur) => cur?.filter((x) => x.id !== g.id) ?? null);
                  }}
                  className="relative z-10 rounded p-1 text-muted opacity-0 hover:text-bad group-hover:opacity-100"
                  title="Delete"
                >
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-auto text-xs text-muted">Updated {when(g.updated_at)}</div>
            </div>
  );
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Data Lineage" icon="split" href="/lineage">
        <Link href="/lineage?all=1" className={buttonClass.ghost} title="Every connected dataset, pipeline and app; can be slow on large workspaces">
          <Icon name="grid" className="h-3.5 w-3.5" /> Explore everything
        </Link>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New data lineage
        </button>
      </AppHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">Lineage graphs</h2>
            <p className="text-sm text-muted">Start from a dataset, pipeline or Nexus object type and expand its parents and children. Saved graphs keep their nodes and colours.</p>
          </div>
          <div className="ml-auto flex w-64 items-center gap-2 rounded-md border border-line-2 bg-ink px-2.5">
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search graphs…" className="w-full bg-transparent py-1.5 text-sm outline-none" />
          </div>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex h-36 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-2 bg-panel/60 text-sm text-muted transition hover:border-ocean/60 hover:text-white"
          >
            <span className="rounded-full bg-ocean/15 p-2 text-ocean">
              <Icon name="plus" className="h-5 w-5" />
            </span>
            New data lineage
            <span className="text-xs">Start from an empty graph and add nodes</span>
          </button>
          {graphs === null
            ? [0, 1].map((i) => <div key={i} className="h-36 animate-pulse rounded-xl border border-line bg-panel" />)
            : regular.map(card)}
        </div>
        {tests.length > 0 && (
          <details className="mt-8 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-amber-200">
              <Icon name="bug" className="h-4 w-4" /> Graf uji & bug ({tests.length})
              <span className="text-xs font-normal text-muted">— dipisah dari demo; nama berisi “test”. Dibuka dengan item uji ditampilkan.</span>
            </summary>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{tests.map(card)}</div>
          </details>
        )}
        {graphs?.length === 0 && <p className="mt-4 text-sm text-muted">No saved lineage graphs yet. Create one to explore how your data flows.</p>}
        {graphs && graphs.length > 0 && filtered.length === 0 && <p className="mt-4 text-sm text-muted">No graphs match &ldquo;{query}&rdquo;.</p>}
      </div>
      {creating && (
        <SaveDialog
          title="New data lineage"
          initial=""
          onClose={() => setCreating(false)}
          onSave={async (name) => {
            const g = await lineage.saveGraph({ name, nodes: [], colors: {}, color_by: "type" });
            router.push(`/lineage?graph=${g.id}`);
          }}
        />
      )}
    </div>
  );
}

/* Zones, left to right as in Foundry's Data Lineage: raw data (connections, sources, uploads, streams and the datasets
   nothing in the platform produces), then everything that transforms or computes (pipelines, code, SQL, notebooks,
   functions, models and the datasets they write), then the Nexus (object types and actions, grouped on the right), then
   the applications built on it. Inside a zone the columns still follow the flow. */
const RAW_KINDS = new Set(["connection", "datasource", "manual", "virtual", "stream", "reference"]);
const ONTOLOGY_KINDS = new Set(["object_type", "action", "restricted_view"]);
const APP_KINDS = new Set(["module", "vertex", "map", "osdk_app", "automation", "agent", "logic", "machinery"]);
const ZONE_LABELS = ["Raw data", "Transformation, functions & models", "Nexus (ontology)", "Applications"];

/* Split roles: when two object types share several relations (a corridor's end A, end B and every node it touches),
   the target side shows one node per role ("Simpul · ujung B"), so each line carries exactly one cardinality. A role
   node is a view of the same object type: its id is "<object type node>~<relation>", and selecting it selects the type. */
const ROLE_SEP = "~";
const baseId = (id: string) => id.split(ROLE_SEP)[0];
const roleWords = (s: string) => s.replace(/\s*\([^)]*\)\s*/g, " ").trim().split(/\s+/);
/** what sets each name apart from its siblings: "Koridor ujung A" / "Koridor ujung B" → "ujung A" / "ujung B" */
function roleNames(names: string[]): string[] {
  const words = names.map(roleWords);
  const shortest = Math.min(...words.map((w) => w.length));
  let common = 0;
  while (common < shortest - 1 && words.every((w) => w[common].toLowerCase() === words[0][common].toLowerCase())) common++;
  return words.map((w) => w.slice(common).join(" ").replace(/^[↔<>\-–—:·]+\s*/, ""));
}
function splitRoles(nodes: LineageNode[], relations: LineageRelation[]): { clones: (LineageNode & { role_of: string })[]; relations: (LineageRelation & { role?: string })[] } {
  const ids = new Set(nodes.map((n) => n.id));
  const byPair = new Map<string, LineageRelation[]>();
  for (const r of relations) {
    if (!ids.has(r.from) || !ids.has(r.to) || r.from === r.to) continue;
    const k = [r.from, r.to].sort().join("|");
    byPair.set(k, [...(byPair.get(k) ?? []), r]);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clones: (LineageNode & { role_of: string })[] = [];
  const moved = new Map<string, string>();
  const roleOfRel = new Map<string, string>();
  for (const rs of byPair.values()) {
    if (rs.length < 2) continue;
    const roles = roleNames(rs.map((r) => r.name));
    rs.forEach((r, i) => roleOfRel.set(r.id, roles[i] || r.name));
    // the first relation stays on the type's own node; every other one gets its own role node of the target side
    rs.slice(1).forEach((r, i) => {
      const orig = byId.get(r.to)!;
      const id = `${orig.id}${ROLE_SEP}${r.id}`;
      // the role first: the card truncates long names from the end
      clones.push({ ...orig, id, name: `${roles[i + 1] || r.name} · ${orig.name}`, role_of: orig.id });
      moved.set(r.id, id);
    });
  }
  return {
    clones,
    relations: relations.map((r) => (moved.has(r.id) || roleOfRel.has(r.id) ? { ...r, to: moved.get(r.id) ?? r.to, role: roleOfRel.get(r.id) } : r)),
  };
}

function zoneOf(n: LineageNode, producedIds: Set<string>): number {
  if (RAW_KINDS.has(n.kind) || (n.kind === "dataset" && !producedIds.has(n.id))) return 0;
  if (ONTOLOGY_KINDS.has(n.kind)) return 2;
  if (APP_KINDS.has(n.kind)) return 3;
  return 1;
}

/** Left-to-right layers by longest path from the sources (back edges of cycles ignored), ordered by barycentre;
 *  zoned: raw data on the left, transformation in the middle, the Nexus on the right (see zoneOf). */
function layout(
  nodes: LineageNode[],
  edges: { from: string; to: string }[],
  zoned = false,
  all: LineageNode[] = nodes,
  anchors: Map<string, string> = new Map(),
  relations: { from: string; to: string }[] = [],
): Placed[] {
  const ids = new Set(nodes.map((n) => n.id));
  const es = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of es) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    inc.set(e.to, [...(inc.get(e.to) ?? []), e.from]);
  }
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.get(t)) visit(t);
    }
    state.set(id, 2);
    order.push(id);
  };
  for (const n of nodes) if (!(inc.get(n.id) ?? []).length && !state.get(n.id)) visit(n.id);
  for (const n of nodes) if (!state.get(n.id)) visit(n.id);
  order.reverse();
  const layer = new Map<string, number>();
  for (const id of order) {
    const preds = (inc.get(id) ?? []).filter((p) => !back.has(`${p}>${id}`));
    layer.set(id, preds.length ? Math.max(...preds.map((p) => (layer.get(p) ?? 0) + 1)) : 0);
  }
  for (const id of [...order].reverse()) {
    const succ = (out.get(id) ?? []).filter((t) => !back.has(`${id}>${t}`));
    if (!(inc.get(id) ?? []).length && succ.length) layer.set(id, Math.max(0, Math.min(...succ.map((t) => layer.get(t)!)) - 1));
  }
  let zoneOfId: Map<string, number> | null = null;
  if (zoned) {
    // a dataset is produced when a pipeline, transform, notebook… writes it (anywhere in the graph, shown or not)
    const kindOf = new Map(all.map((n) => [n.id, n.kind]));
    const producedIds = new Set(edges.filter((e) => !RAW_KINDS.has(kindOf.get(e.from) ?? "") && kindOf.get(e.from) !== "dataset").map((e) => e.to));
    const byIdZ = new Map(nodes.map((n) => [n.id, n]));
    const zone = new Map(nodes.map((n) => [n.id, zoneOf(n, producedIds)]));
    // inside a zone: longest path over the zone's own edges (links between object types do not stack them)
    const local = new Map<string, number>();
    for (const id of order) {
      const z = zone.get(id)!;
      const preds = (inc.get(id) ?? []).filter(
        (p) => !back.has(`${p}>${id}`) && zone.get(p) === z && !(byIdZ.get(p)?.kind === "object_type" && byIdZ.get(id)?.kind === "object_type"),
      );
      local.set(id, preds.length ? Math.max(...preds.map((p) => (local.get(p) ?? 0) + 1)) : 0);
    }
    // a raw node sits right before what reads it (a source dataset next to its pipeline, not at the far left)
    for (const id of [...order].reverse()) {
      if (zone.get(id) !== 0) continue;
      const succ = (out.get(id) ?? []).filter((t) => zone.get(t) === 0);
      if (!succ.length) {
        const width = Math.max(0, ...[...local].filter(([k]) => zone.get(k) === 0).map(([, v]) => v));
        local.set(id, width);
      }
    }
    const widths = [0, 1, 2, 3].map((z) => {
      const ls = [...local].filter(([k]) => zone.get(k) === z).map(([, v]) => v);
      return ls.length ? Math.max(...ls) + 1 : 0;
    });
    const offset = widths.map((_, z) => widths.slice(0, z).reduce((a, b) => a + b, 0));
    for (const id of order) layer.set(id, offset[zone.get(id)!] + local.get(id)!);
    zoneOfId = zone;
  }
  // a role node sits in its object type's column (and zone)
  for (const [clone, orig] of anchors) if (layer.has(orig)) layer.set(clone, layer.get(orig)!);
  if (zoneOfId) for (const [clone, orig] of anchors) zoneOfId.set(clone, zoneOfId.get(orig) ?? 2);
  const layers: string[][] = [];
  for (const [id, l] of layer) (layers[l] ??= []).push(id);
  const pos = new Map<string, number>();
  layers.forEach((col) => col?.sort().forEach((id, i) => pos.set(id, i)));
  for (let pass = 0; pass < 4; pass++) {
    layers.forEach((col, li) => {
      if (!li || !col) return;
      const bary = (id: string) => {
        const ps = (inc.get(id) ?? []).filter((p) => layer.get(p)! < li).map((p) => pos.get(p)!);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(id)!;
      };
      col.sort((a, b) => bary(a) - bary(b)).forEach((id, i) => pos.set(id, i));
    });
  }
  const tallest = Math.max(1, ...layers.map((c) => c?.length ?? 0));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed: Placed[] = [];
  layers.forEach((col, li) => {
    if (!col) return;
    const offset = ((tallest - col.length) * (NODE_H + ROW_GAP)) / 2;
    col.forEach((id, i) => placed.push({ ...byId.get(id)!, layer: li, x: li * (NODE_W + COL_GAP), y: offset + i * (NODE_H + ROW_GAP), ...(zoneOfId ? { zone: zoneOfId.get(id) } : {}) }));
  });
  return zoneOfId ? nexusNetwork(placed, relations, tallest * (NODE_H + ROW_GAP)) : placed;
}

/* The Nexus zone as a network, not a column: its object types on a honeycomb (hexagonal) lattice spiralling out from
   the centre, related object types next to each other (breadth-first from the most related one), all inside the
   zone's block; the applications move to the right of it. */
function nexusNetwork(placed: Placed[], relations: { from: string; to: string }[], height: number): Placed[] {
  const nexus = placed.filter((n) => n.zone === 2);
  if (nexus.length < 3) return placed;
  const ids = new Set(nexus.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const r of relations) {
    if (!ids.has(r.from) || !ids.has(r.to) || r.from === r.to) continue;
    adj.set(r.from, (adj.get(r.from) ?? new Set()).add(r.to));
    adj.set(r.to, (adj.get(r.to) ?? new Set()).add(r.from));
  }
  const degree = (id: string) => adj.get(id)?.size ?? 0;
  // order: breadth-first over the relations, each component from its most related type; loose types last
  const order: string[] = [];
  const seen = new Set<string>();
  for (const start of [...nexus].sort((a, b) => degree(b.id) - degree(a.id) || a.y - b.y).map((n) => n.id)) {
    if (seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const nb of [...(adj.get(id) ?? [])].sort((a, b) => degree(b) - degree(a)))
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
    }
  }
  // the hexagonal spiral: ring 0 is the centre, ring k has 6k cells (axial coordinates)
  const cells: [number, number][] = [[0, 0]];
  const dirs: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let k = 1; cells.length < order.length; k++) {
    let [q, r] = [-k, k]; // start at direction 4 × k
    for (const [dq, dr] of dirs)
      for (let i = 0; i < k; i++) {
        cells.push([q, r]);
        q += dq;
        r += dr;
      }
  }
  const W = NODE_W + 70;
  const H = NODE_H + 46;
  const xy = cells.slice(0, order.length).map(([q, r]) => [W * (q + r / 2), H * r] as [number, number]);
  const minX = Math.min(...xy.map((c) => c[0]));
  const minY = Math.min(...xy.map((c) => c[1]));
  const spanY = Math.max(...xy.map((c) => c[1])) - minY + NODE_H;
  const left = Math.min(...nexus.map((n) => n.x));
  const top = Math.max(0, (height - spanY) / 2);
  const pos = new Map(order.map((id, i) => [id, [left + xy[i][0] - minX, top + xy[i][1] - minY] as [number, number]]));
  const right = Math.max(...[...pos.values()].map((c) => c[0])) + NODE_W;
  const appsLeft = Math.min(Infinity, ...placed.filter((n) => n.zone === 3).map((n) => n.x));
  const shift = Number.isFinite(appsLeft) ? Math.max(0, right + COL_GAP - appsLeft) : 0;
  return placed.map((n, i) => {
    const at = pos.get(n.id);
    // each network node is its own "column" (layout by colour keeps it in place)
    if (at) return { ...n, x: at[0], y: at[1], layer: 10_000 + i };
    return n.zone === 3 ? { ...n, x: n.x + shift } : n;
  });
}

/** dataTransfer type of a lineage node dragged from the search results onto the canvas */
const NODE_DRAG = "application/x-bluesandai-lineage-node";

/** Text on a filled node: dark on light colours, white on dark ones. */
function ink(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#ffffff";
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#1f2937" : "#ffffff";
}

/** Layout by color: within each column, nodes of a colour sit together (the column keeps its slots). */
function byColor(placed: Placed[], color: (n: LineageNode) => string): Placed[] {
  const cols = new Map<number, Placed[]>();
  for (const n of placed) cols.set(n.layer, [...(cols.get(n.layer) ?? []), n]);
  const out: Placed[] = [];
  for (const col of cols.values()) {
    const ys = col.map((n) => n.y).sort((a, b) => a - b);
    const first = new Map<string, number>();
    [...col].sort((a, b) => a.y - b.y).forEach((n, i) => first.has(color(n)) || first.set(color(n), i));
    [...col].sort((a, b) => first.get(color(a))! - first.get(color(b))! || a.y - b.y).forEach((n, i) => out.push({ ...n, y: ys[i] }));
  }
  return out;
}

/** Group by color: a box behind each run of same-coloured nodes in a column. */
function colorGroups(placed: Placed[], color: (n: LineageNode) => string): { x: number; y: number; h: number; color: string; count: number }[] {
  const cols = new Map<number, Placed[]>();
  for (const n of placed) cols.set(n.layer, [...(cols.get(n.layer) ?? []), n]);
  const out: { x: number; y: number; h: number; color: string; count: number }[] = [];
  for (const col of cols.values()) {
    const s = [...col].sort((a, b) => a.y - b.y);
    let i = 0;
    while (i < s.length) {
      let j = i;
      while (j + 1 < s.length && color(s[j + 1]) === color(s[i])) j++;
      if (j > i) out.push({ x: s[i].x, y: s[i].y, h: s[j].y + NODE_H - s[i].y, color: color(s[i]), count: j - i + 1 });
      i = j + 1;
    }
  }
  return out;
}

/** Node color options: a searchable list with headings. */
function ColorPicker({ value, onChange }: { value: ColorBy; onChange: (v: ColorBy) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const compact = useContext(Compact);
  const cur = COLOR_OPTIONS.find((o) => o.id === value);
  const hits = COLOR_OPTIONS.filter((o) => `${o.label} ${o.group}`.toLowerCase().includes(q.trim().toLowerCase()));
  const groups = [...new Set(hits.map((o) => o.group))];
  return (
    <div className="relative" data-color-picker>
      <div className="flex w-52 items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1">
        <Icon name={cur?.icon ?? "palette"} className="h-3.5 w-3.5 shrink-0 text-soft" />
        <input
          value={open ? q : cur?.label ?? ""}
          onFocus={() => (setOpen(true), setQ(""))}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search color options…"
          aria-label="Node color options"
          className="w-full bg-transparent outline-none"
        />
        <Icon name="down" className="h-3 w-3 shrink-0 text-muted" />
      </div>
      {!compact && <span className="mt-0.5 block text-center text-[10px] text-muted">Node color options</span>}
      {open && (
        <div className="absolute right-0 top-8 z-30 max-h-80 w-60 overflow-y-auto rounded-md border border-line-2 bg-panel p-1 shadow-xl">
          {groups.map((g) => (
            <div key={g}>
              <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted">{g}</div>
              {hits
                .filter((o) => o.group === g)
                .map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onMouseDown={(e) => (e.preventDefault(), onChange(o.id), setOpen(false))}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${o.id === value ? "bg-ocean text-white" : "hover:bg-panel-2"}`}
                  >
                    <Icon name={o.icon} className="h-3.5 w-3.5" /> {o.label}
                  </button>
                ))}
            </div>
          ))}
          {!hits.length && <div className="px-2 py-1.5 text-muted">No color option matches</div>}
        </div>
      )}
    </div>
  );
}

/** Embedded in another page (?embed=1): one toolbar row — icons without captions, the caption in the tooltip. */
const Compact = createContext(false);

function ToolButton({ icon, label, on, onClick, title }: { icon: IconName; label: string; on: boolean; onClick: () => void; title: string }) {
  const compact = useContext(Compact);
  if (compact)
    return (
      <button type="button" onClick={onClick} title={`${label} — ${title}`} aria-label={label} aria-pressed={on} className={`flex h-7 w-7 items-center justify-center rounded-md border text-muted hover:text-white ${on ? "border-ocean bg-ocean/20 text-white" : "border-line-2 bg-ink"}`}>
        <Icon name={icon} className="h-3.5 w-3.5" />
      </button>
    );
  return (
    <button type="button" onClick={onClick} title={title} className="flex w-14 flex-col items-center gap-0.5 text-[10px] text-muted hover:text-white">
      <span className={`flex h-7 w-7 items-center justify-center rounded-md border ${on ? "border-ocean bg-ocean/20 text-white" : "border-line-2 bg-ink"}`}>
        <Icon name={icon} className="h-3.5 w-3.5" />
      </span>
      <span className="leading-tight">{label}</span>
    </button>
  );
}

/** a relation's name without its "(…)" qualifier, kept short for the canvas */
const shortRel = (name: string) => {
  const s = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return s.length > 26 ? `${s.slice(0, 25)}…` : s;
};

function walk(graph: LineageGraph, ids: Iterable<string>, dir: "up" | "down", depth: number): Set<string> {
  const found = new Set<string>();
  let frontier = [...ids];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier)
      for (const e of graph.edges) {
        const n = dir === "up" ? (e.to === f ? e.from : null) : e.from === f ? e.to : null;
        if (n && !found.has(n)) {
          found.add(n);
          next.push(n);
        }
      }
    frontier = next;
  }
  return found;
}

function Lineage() {
  const router = useRouter();
  const params = useSearchParams();
  // the whole graph, read in the background: the canvas shows straight away (empty for a new lineage)
  const [loaded, setLoaded] = useState<LineageGraph | null>(null);
  const graph = loaded ?? EMPTY;
  const [error, setError] = useState<string | null>(null);
  // the nodes on the canvas; null = overview (everything connected, only with ?all); a saved graph starts empty
  // until it is read
  const [nodeSet, setNodeSet] = useState<Set<string> | null>(() => (params.has("all") ? null : new Set()));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [colorBy, setColorBy] = useState<ColorBy>("type");
  // toolbar: layout by color, group by color, legend
  const [layoutByColor, setLayoutByColor] = useState(false);
  // raw data left, transformation in the middle, the Nexus right (Layout → by flow to turn off); kept per browser
  const [zoned, setZoned] = useState(true);
  // several relations between two object types: one node per role (see splitRoles)
  const [rolesSplit, setRolesSplit] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (localStorage.getItem("bluesandai:lineage-zones") === "0") setZoned(false);
      } catch {
        /* default */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const [groupByColor, setGroupByColor] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  // Permissions: the account viewed as, and the permission type
  const { me } = useAuth();
  const [people, setPeople] = useState<User[] | null>(null);
  const [viewAs, setViewAs] = useState(() => params.get("viewAs") ?? "");
  const [permType, setPermType] = useState<"read" | "discover">("read");
  const [perms, setPerms] = useState<Permissions | null>(null);
  // the accounts a saved graph is about (its domain's demo accounts): the lists show only these unless asked for all
  const [accounts, setAccounts] = useState<string[] | null>(null);
  const [allAccounts, setAllAccounts] = useState(false);
  // nodes placed by hand: dragged on the canvas, or dropped there from the search results
  const [pins, setPins] = useState<Record<string, { x: number; y: number }>>({});
  const [permErr, setPermErr] = useState<string | null>(null);
  // "Resolved schedule" colouring: the schedule shown and its nodes' roles
  const [schedules, setSchedules] = useState<ScheduleSummary[] | null>(null);
  const [scheduleKey, setScheduleKey] = useState("");
  const [roles, setRoles] = useState<Record<string, ScheduleRole>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [flow, setFlow] = useState(false);
  const [query, setQuery] = useState("");
  const [find, setFind] = useState("");
  const [side, setSide] = useState<Side>("properties");
  // the right panel folds to a thin rail (like Pipeline Builder's outputs); embedded in another app it starts folded
  const [sideOpen, setSideOpen] = useState(() => params.get("embed") !== "1");
  useEffect(() => {
    if (params.get("embed") === "1") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- this device's choice, read after hydration
    try { if (localStorage.getItem("bluesandai.lineage-side") === "0") setSideOpen(false); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on entry
  }, []);
  const foldSide = (open: boolean, tab?: Side) => {
    setSideOpen(open);
    if (tab) setSide(tab);
    if (params.get("embed") !== "1") try { localStorage.setItem("bluesandai.lineage-side", open ? "1" : "0"); } catch {}
  };
  const [bottom, setBottom] = useState<Bottom | null>(null);
  const [saved, setSaved] = useState<SavedGraph | null>(null);
  const [dialog, setDialog] = useState<null | "save" | "open">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  // test and bug-hunting items (test_space.py) stay out of the graph unless asked for, or a test graph is open
  const [showTests, setShowTests] = useState(() => params.get("tests") === "1");
  const [assist, setAssist] = useState(false);
  const toggleAssist = useCallback(() => setAssist((a) => !a), []);

  const load = useCallback(() => {
    lineage
      .graph(showTests)
      .then(setLoaded)
      .catch((e: Error) => setError(e.message));
  }, [showTests]);
  useEffect(load, [load]);

  // the starting graph: a list of nodes, or one node with its direct neighbours; else the overview
  if (loaded && !initialized) {
    setInitialized(true);
    const nodes = params.get("nodes");
    const focus = params.get("node");
    // ?focus=a,b,…: each node with everything upstream of it (where its data comes from) and one step downstream —
    // several object types together make one branching tree (Object Explorer → Explore data lineage)
    const many = (params.get("focus") ?? "").split(",").filter((id) => graph.nodes.some((n) => n.id === id));
    if (many.length) {
      setNodeSet(new Set([...many, ...walk(graph, many, "up", 99), ...walk(graph, many, "down", 1)]));
      setSelected(new Set(many));
    } else if (nodes) setNodeSet(new Set(nodes.split(",").filter((id) => graph.nodes.some((n) => n.id === id))));
    else if (focus && graph.nodes.some((n) => n.id === focus)) {
      setNodeSet(new Set([focus, ...walk(graph, [focus], "up", 1), ...walk(graph, [focus], "down", 1)]));
      setSelected(new Set([focus]));
    }
  }
  const graphParam = params.get("graph");
  useEffect(() => {
    if (!graphParam) return;
    let stale = false;
    lineage
      .savedGraph(graphParam)
      .then((g) => {
        if (stale) return;
        setSaved(g);
        if (g.test) setShowTests(true);
        setNodeSet(new Set(g.nodes));
        setCustom(g.colors);
        setColorBy((params.get("color") as ColorBy | null) ?? (g.color_by as ColorBy));
        if (g.permissions?.view_as && !params.get("viewAs")) setViewAs(g.permissions.view_as);
        if (g.permissions?.accounts?.length) setAccounts(g.permissions.accounts);
        if (g.permissions?.type) setPermType(g.permissions.type);
        setPins(g.positions ?? {});
      })
      .catch((e: Error) => !stale && setNotice(e.message));
    return () => {
      stale = true;
    };
  }, [graphParam]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const shown = useMemo(() => {
    const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
    const nodes = graph.nodes.filter((n) => (nodeSet ? nodeSet.has(n.id) : linked.has(n.id)));
    const ids = new Set(nodes.map((n) => n.id));
    const split = rolesSplit ? splitRoles(nodes, graph.relations ?? []) : { clones: [], relations: graph.relations ?? [] };
    const anchors = new Map(split.clones.map((c) => [c.id, c.role_of]));
    return {
      nodes: layout([...nodes, ...split.clones], graph.edges, zoned, graph.nodes, anchors, split.relations),
      edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      ids,
      relations: split.relations,
      roleIds: [...anchors.keys()],
    };
  }, [graph, nodeSet, zoned, rolesSplit]);
  // the canvas sees the relations moved onto role nodes
  const canvasGraph = useMemo(() => (shown.relations === graph.relations ? graph : { ...graph, relations: shown.relations }), [graph, shown.relations]);
  // Permissions are asked for the real nodes only; a role node (1:N) shows its type's access
  const permBody = () => shown.nodes.filter((n) => n.id === baseId(n.id)).map((n) => ({ id: n.id, kind: n.kind, item_id: n.item_id, repo_id: n.repo_id, size: n.size, missing: n.missing }));
  const withRoles = (r: Permissions): Permissions => {
    const nodes = { ...r.nodes };
    for (const id of shown.roleIds) if (nodes[baseId(id)]) nodes[id] = nodes[baseId(id)];
    return { ...r, nodes };
  };
  // Permissions: the accounts to view as (administrators: everyone; others: themselves). None is picked for you: with no
  // account ticked the nodes stay gray (no information), as a saved graph or a link (?viewAs=) may pick one
  useEffect(() => {
    if (colorBy !== "permissions" || people !== null) return;
    if (me?.role !== "admin") {
      setPeople(me ? [me as unknown as User] : []);
      return;
    }
    auth.users().then(setPeople, () => setPeople(me ? [me as unknown as User] : []));
  }, [colorBy, people, me]);
  // Permissions: what the account viewed as can do with each node on the canvas
  const permKey = colorBy === "permissions" && viewAs ? `${viewAs}|${permType}|${[...shown.ids].sort().join(",")}|${shown.roleIds.length}` : "";
  useEffect(() => {
    if (!permKey) return;
    let stale = false;
    setPermErr(null);
    lineage.permissions({ user_id: viewAs, type: permType, nodes: permBody() }).then(
      (r) => !stale && setPerms(withRoles(r)),
      (e: Error) => !stale && (setPerms(null), setPermErr(e.message)),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permKey]);

  if (error) return <ApiError message={error} />;
  // the overview and shared node lists need the graph before anything can be drawn
  if (!loaded && nodeSet === null) return <Loading />;

  const visibleIds = shown.ids;
  const ensureSet = () => new Set(nodeSet ?? visibleIds);
  const addNodes = (ids: Iterable<string>) => {
    const s = ensureSet();
    for (const id of ids) s.add(id);
    setNodeSet(s);
  };
  const expand = (ids: string[], dir: "up" | "down" | "both", depth: number) => {
    const add = new Set<string>();
    if (dir !== "down") walk(graph, ids, "up", depth).forEach((x) => add.add(x));
    if (dir !== "up") walk(graph, ids, "down", depth).forEach((x) => add.add(x));
    addNodes(add);
  };
  const removeNodes = (ids: string[]) => {
    const s = ensureSet();
    ids.forEach((id) => s.delete(id));
    setNodeSet(s);
    setSelected(new Set());
  };
  const focusOn = (id: string) => {
    setNodeSet(new Set([id, ...walk(graph, [id], "up", 99), ...walk(graph, [id], "down", 99)]));
    setSelected(new Set([id]));
  };
  const selectOne = (id: string) => {
    if (!visibleIds.has(id)) addNodes([id]);
    setSelected(new Set([id]));
  };
  const selArr = [...selected].filter((id) => byId.has(id));
  const selNodes = selArr.map((id) => byId.get(id)!);
  const single = selNodes.length === 1 ? selNodes[0] : null;
  const matches = query.trim()
    ? graph.nodes.filter((n) => `${n.name} ${n.kind_label} ${(n.path ?? []).join("/")}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12)
    : [];
  const findQ = find.trim().toLowerCase();
  const found = findQ ? new Set(shown.nodes.filter((n) => n.name.toLowerCase().includes(findQ) || (n.columns ?? []).some((c) => c.toLowerCase().includes(findQ))).map((n) => n.id)) : null;
  // the ticked account's access, once it has arrived (until then, and with no account ticked, every node is gray)
  const shownPerms = viewAs && perms?.user.id === viewAs && perms.type === permType ? perms : null;
  const paint = coloring(colorBy, shown.nodes, custom, roles, shownPerms);
  const laid = layoutByColor ? byColor(shown.nodes, paint.color) : shown.nodes;
  const placed = Object.keys(pins).length ? laid.map((n) => (pins[n.id] ? { ...n, ...pins[n.id] } : n)) : laid;
  const groups = groupByColor ? colorGroups(placed, paint.color) : [];
  // the zones' bands behind the nodes: raw data, transformation, Nexus, applications
  const bands = zoned
    ? [0, 1, 2, 3].flatMap((z) => {
        const ns = placed.filter((n) => n.zone === z);
        if (!ns.length) return [];
        const top = Math.min(...placed.map((n) => n.y));
        const bottom = Math.max(...placed.map((n) => n.y)) + NODE_H;
        return [{ zone: z, label: ZONE_LABELS[z], x: Math.min(...ns.map((n) => n.x)) - 24, w: Math.max(...ns.map((n) => n.x)) - Math.min(...ns.map((n) => n.x)) + NODE_W + 48, y: top - 44, h: bottom - top + 64 }];
      })
    : [];
  const legendRows = shownPerms ? permissionLegend(shown.nodes, shownPerms) : [];
  // the node's tooltip says what the ticked account may do with it, and why
  const access = shownPerms
    ? (n: LineageNode) => {
        const a = shownPerms.nodes[n.id];
        return a ? `${shownPerms.user.name ?? viewAs}: ${PERMISSION_COLORS[a.status].label}${a.detail ? ` — ${a.detail}` : ""}` : undefined;
      }
    : undefined;
  const saveBody = () => ({ name: saved?.name ?? "", nodes: currentNodes(), colors: custom, color_by: colorBy, permissions: { view_as: viewAs || undefined, type: permType, accounts: accounts ?? undefined }, positions: pins });
  // View as: the graph's own accounts (and you, and whoever is ticked), or everyone
  const listed = people && accounts && !allAccounts ? people.filter((u) => accounts.includes(u.id) || u.id === me?.id || u.id === viewAs) : people;
  const showSchedule = async (key: string) => {
    setScheduleKey(key);
    setRoles({});
    if (!key) return;
    const [pid, sid] = key.split("/");
    try {
      const r = await runtime.resolveSchedule(pid, sid);
      setRoles(r.roles);
      const ids = Object.keys(r.roles).filter((id) => byId.has(id));
      if (ids.length) addNodes(ids);
      if (r.never_built.length) {
        setNotice(`Not built yet (not on the graph): ${r.never_built.join(", ")}`);
        setTimeout(() => setNotice(null), 5000);
      }
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const staleCount = graph.nodes.filter((n) => n.stale).length;
  const currentNodes = () => [...(nodeSet ?? visibleIds)];
  const shareLink = () => {
    const url = `${window.location.origin}/lineage?${saved ? `graph=${saved.id}` : `nodes=${encodeURIComponent(currentNodes().join(","))}`}`;
    navigator.clipboard.writeText(url);
    setNotice("Share link copied");
    setTimeout(() => setNotice(null), 2500);
  };
  const exportSvg = () => {
    const svg = document.querySelector("#lineage-svg") as SVGSVGElement | null;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("style", "background:#070b12;font-family:sans-serif");
    const css = getComputedStyle(document.documentElement);
    let text = new XMLSerializer().serializeToString(clone);
    for (const v of ["--color-panel", "--color-line", "--color-line-2", "--color-muted", "--color-soft", "--color-ink", "--color-sand", "--color-ocean", "--color-warn", "--color-bad"])
      text = text.replaceAll(`var(${v})`, css.getPropertyValue(v).trim() || "#888");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    a.download = `${saved?.name ?? "lineage"}.svg`;
    a.click();
  };

  const compact = params.get("embed") === "1";
  return (
    <Compact.Provider value={compact}>
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader compact={compact} app="Data Lineage" icon="split" href="/lineage" crumbs={saved ? [{ label: saved.name }] : single ? [{ label: single.name }] : []}>
        {notice && <span className="text-xs text-ok">{notice}</span>}
        <AipAssistButton open={assist} onToggle={toggleAssist} />
        {staleCount > 0 && (
          <button type="button" onClick={() => setColorBy("stale")} className="flex items-center gap-1.5 text-xs text-warn hover:underline">
            <Icon name="alert" className="h-3.5 w-3.5" /> {staleCount} out of date
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            saved
              ? lineage.saveGraph({ ...saveBody(), name: saved.name }, saved.id).then((g) => {
                  setSaved(g);
                  setNotice("Saved");
                  setTimeout(() => setNotice(null), 2000);
                }, (e: Error) => setNotice(e.message))
              : setDialog("save")
          }
          className={buttonClass.secondary}
        >
          <Icon name="save" className="h-3.5 w-3.5" /> Save
        </button>
        <button type="button" onClick={load} className={buttonClass.ghost} title="Reload">
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </button>
        <ActionMenu
          items={[
            {
              label: saved ? `Save "${saved.name}"` : "Save graph…",
              icon: "save",
              onClick: () => (saved ? lineage.saveGraph({ ...saveBody(), name: saved.name }, saved.id).then(setSaved) : setDialog("save")),
            },
            { label: "Save as…", icon: "copy", onClick: () => setDialog("save") },
            { label: "Open graph…", icon: "folder", onClick: () => setDialog("open") },
            "divider",
            { label: "Copy share link", icon: "link", onClick: shareLink },
            { label: "Export graph to SVG", icon: "download", onClick: exportSvg },
            "divider",
            {
              label: "Show everything",
              icon: "grid",
              onClick: () => {
                setNodeSet(null);
                setSaved(null);
                router.replace("/lineage?all=1");
              },
            },
            { label: "Clear graph", icon: "trash", onClick: () => (setNodeSet(new Set()), setSelected(new Set())) },
          ]}
        />
      </AppHeader>

      <div className={`flex shrink-0 flex-wrap items-center border-b border-line bg-panel px-3 text-xs ${compact ? "gap-1.5 py-1" : "gap-2 py-1.5"}`}>
        <div className="relative">
          <div className={`flex items-center gap-2 rounded-md border border-line-2 bg-ink px-2.5 ${compact ? "w-48" : "w-64"}`}>
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={loaded ? "Search a dataset to add…" : "Loading datasets…"} className="w-full bg-transparent py-1.5 text-sm outline-none" />
          </div>
          {matches.length > 0 && (
            <div className="absolute left-0 top-full z-30 mt-1 w-96 overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl">
              {matches.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(NODE_DRAG, n.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title="Click to add, or drag onto the canvas"
                  data-search-result={n.name}
                  data-search-id={n.id}
                  onClick={() => {
                    selectOne(n.id);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel-2"
                >
                  <Icon name={KIND_ICON[n.kind]} className="h-3.5 w-3.5" />
                  <span className="truncate">{n.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{visibleIds.has(n.id) ? "on graph" : n.kind_label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="mx-1 h-5 w-px bg-line" />
        <ToolMenu
          icon="split"
          label="Expand"
          disabled={!selArr.length}
          items={[
            ["Parents (1 level)", () => expand(selArr, "up", 1)],
            ["Children (1 level)", () => expand(selArr, "down", 1)],
            ["All ancestors", () => expand(selArr, "up", 99)],
            ["All descendants", () => expand(selArr, "down", 99)],
            [
              "Everything in between the selected",
              () => {
                const up = new Set(selArr.flatMap((i) => [...walk(graph, [i], "up", 99)]));
                const down = new Set(selArr.flatMap((i) => [...walk(graph, [i], "down", 99)]));
                addNodes([...up].filter((x) => down.has(x)));
              },
            ],
          ]}
        />
        <ToolMenu
          icon="check"
          label="Select"
          items={[
            ["Select all", () => setSelected(new Set(visibleIds))],
            ["Invert selection", () => setSelected(new Set([...visibleIds].filter((x) => !selected.has(x))))],
            ["Select parents", () => setSelected(new Set([...selected, ...[...walk(graph, selArr, "up", 1)].filter((x) => visibleIds.has(x))]))],
            ["Select children", () => setSelected(new Set([...selected, ...[...walk(graph, selArr, "down", 1)].filter((x) => visibleIds.has(x))]))],
            ["Clear selection", () => setSelected(new Set())],
          ]}
        />
        <button type="button" disabled={!selArr.length} onClick={() => removeNodes(selArr)} className={buttonClass.ghost} title="Remove the selected nodes from the graph">
          <Icon name="minus" className="h-3.5 w-3.5" /> Remove
        </button>
        <div className={`flex items-center gap-2 rounded-md border border-line-2 bg-ink px-2 ${compact ? "w-40" : "w-52"}`}>
          <Icon name="filter" className="h-3.5 w-3.5 text-muted" />
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find node or column…" className="w-full bg-transparent py-1 outline-none" />
          {found && <span className="shrink-0 text-muted">{found.size}</span>}
        </div>
        {found && found.size > 0 && (
          <button type="button" onClick={() => setSelected(new Set(found))} className={buttonClass.ghost}>
            Select found
          </button>
        )}
        <div className={`ml-auto flex gap-1.5 ${compact ? "items-center" : "items-start"}`}>
          {Object.keys(pins).length > 0 && (
            <ToolButton icon="refresh" label="Auto layout" on={false} onClick={() => setPins({})} title="Forget the nodes placed by hand and lay the graph out again" />
          )}
          <ToolButton
            icon="layers"
            label="Zones"
            on={zoned}
            onClick={() => {
              setZoned(!zoned);
              try {
                localStorage.setItem("bluesandai:lineage-zones", zoned ? "0" : "1");
              } catch {
                /* not remembered */
              }
            }}
            title="Raw data on the left, transformation, functions and models in the middle, the Nexus (ontology) on the right"
          />
          <ToolButton
            icon="split"
            label="Split roles"
            on={rolesSplit}
            onClick={() => setRolesSplit(!rolesSplit)}
            title="When two object types share several relations, show one node per role so each line carries one cardinality"
          />
          <ToolButton icon="grid" label="Layout by color" on={layoutByColor} onClick={() => setLayoutByColor(!layoutByColor)} title="Arrange each column so nodes of a colour sit together" />
          <ToolButton icon="layers" label="Group by color" on={groupByColor} onClick={() => setGroupByColor(!groupByColor)} title="Draw a box around neighbouring nodes of the same colour" />
          <ToolButton icon="eye" label="Legend" on={showLegend} onClick={() => setShowLegend(!showLegend)} title="Show or hide the legend" />
          <ColorPicker
            value={colorBy}
            onChange={(v) => {
              setColorBy(v);
              if (v === "schedule" && schedules === null) runtime.schedules().then(setSchedules, () => setSchedules([]));
            }}
          />
          {colorBy === "schedule" && (
            <select value={scheduleKey} onChange={(e) => showSchedule(e.target.value)} className="max-w-56 rounded-md border border-line-2 bg-ink px-2 py-1">
              <option value="">{schedules === null ? "Loading schedules…" : schedules.length ? "Choose a schedule…" : "No schedules"}</option>
              {(schedules ?? []).map((s) => (
                <option key={`${s.pipeline_id}/${s.schedule.id}`} value={`${s.pipeline_id}/${s.schedule.id}`}>
                  {s.pipeline_name} · {s.schedule.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setFlow(!flow)}
            title="Animate edges between nodes"
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${flow ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted hover:text-white"}`}
          >
            <Icon name="play" className="h-3 w-3" /> Flow
          </button>
          <button
            type="button"
            onClick={() => setShowTests(!showTests)}
            title={showTests ? "Sembunyikan item uji & bug (nama/proyek berisi \"test\")" : `Tampilkan item uji & bug${loaded?.hidden_tests ? ` — ${loaded.hidden_tests} disembunyikan` : ""}`}
            aria-pressed={showTests}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${showTests ? "border-amber-400/70 bg-amber-500/15 text-amber-100" : "border-line-2 text-muted hover:text-white"}`}
          >
            <Icon name="bug" className="h-3 w-3" /> Uji{!showTests && loaded?.hidden_tests ? <span className="tabular-nums text-[10px] text-muted">{loaded.hidden_tests}</span> : null}
          </button>
          <button
            type="button"
            onClick={() => setBottom(bottom === "timeline" ? null : "timeline")}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${bottom === "timeline" ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted hover:text-white"}`}
          >
            <Icon name="clock" className="h-3 w-3" /> Build timeline
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Canvas
            graph={canvasGraph}
            loading={!loaded && !error}
            nodes={placed}
            edges={shown.edges}
            onMoveNodes={(moves) => setPins((p) => ({ ...p, ...Object.fromEntries(moves.map((m) => [m.id, { x: m.x, y: m.y }])) }))}
            onDropNode={(id, x, y) => {
              addNodes([id]);
              setPins((p) => ({ ...p, [id]: { x: Math.round(x - NODE_W / 2), y: Math.round(y - NODE_H / 2) } }));
              setQuery("");
              setSelected(new Set([id]));
            }}
            visible={shown.roleIds.length ? new Set([...visibleIds, ...shown.roleIds]) : visibleIds}
            selected={selected}
            found={found}
            color={paint.color}
            groups={groups}
            bands={bands}
            access={access}
            solid={colorBy === "permissions"}
            flow={flow}
            onSelect={(raw, additive) => {
              if (!raw) return setSelected(new Set());
              const id = baseId(raw);
              const s = additive ? new Set(selected) : new Set<string>();
              if (additive && s.has(id)) s.delete(id);
              else s.add(id);
              setSelected(s);
            }}
            onSelectMany={(ids, additive) => setSelected(new Set([...(additive ? selected : []), ...ids.map(baseId)]))}
            onExpand={(id, dir) => expand([baseId(id)], dir, 1)}
            onFocus={(id) => focusOn(baseId(id))}
            onRemove={(id) => removeNodes([baseId(id)])}
            legend={
              !showLegend ? null : colorBy === "permissions" ? (
                <div className="absolute right-3 top-3 z-10 w-80 rounded-lg border border-line-2 bg-panel/95 p-3 text-xs shadow-xl" data-permissions-panel>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                    {viewAs && !shownPerms ? (
                      <span className="col-span-2 text-muted">{permErr ? "Could not read this account's access" : "Reading this account's access…"}</span>
                    ) : (
                      (shownPerms ? legendRows : permissionLegend(shown.nodes, null)).map((e) => (
                        <div key={e.status} className={`flex items-center gap-2 ${shownPerms ? "" : "col-span-2"}`}>
                          <span className="h-4 w-4 shrink-0 rounded" style={{ background: e.color }} />
                          <span className="text-soft">
                            {e.label} ({e.count})
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <p className="mt-2 text-center text-[11px] text-muted">You are only able to view a user&apos;s access level if you have that access level</p>
                  <label className="mt-2 flex items-center gap-2">
                    <span className="w-28 text-muted">Permissions type:</span>
                    <select value={permType} onChange={(e) => setPermType(e.target.value as "read" | "discover")} className="min-w-0 flex-1 rounded border border-line-2 bg-ink px-1.5 py-1">
                      <option value="read">Data access in datasets</option>
                      <option value="discover">Discover (see that it exists)</option>
                    </select>
                  </label>
                  <div className="mt-2 border-t border-line pt-2">
                    <div className="mb-1 flex items-center">
                      <span className="text-muted">View as — tick one account</span>
                      {accounts && (people ?? []).length > 0 && (
                        <button type="button" onClick={() => setAllAccounts(!allAccounts)} className="ml-2 text-[11px] text-ocean hover:underline"
                          title={allAccounts ? "Show only the accounts this graph is about" : "Show every account of the platform"}>
                          {allAccounts ? "Only this graph's accounts" : `All accounts (${(people ?? []).length})`}
                        </button>
                      )}
                      {viewAs && (
                        <button type="button" onClick={() => setViewAs("")} className="ml-auto text-[11px] text-muted hover:text-white">
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="max-h-48 space-y-0.5 overflow-y-auto">
                      {[
                        ...(listed ?? []).map((u) => ({ id: u.id, name: u.display_name || u.username })),
                        // an account a saved graph or a link names that the page cannot list (non-administrators)
                        ...(viewAs && !(people ?? []).some((u) => u.id === viewAs) ? [{ id: viewAs, name: shownPerms?.user.name ?? viewAs }] : []),
                      ].map((u) => {
                        // one account at a time: ticking another replaces it, unticking leaves none (gray)
                        const on = u.id === viewAs;
                        return (
                          <label key={u.id} className="flex items-center gap-1.5">
                            <input type="checkbox" checked={on} onChange={() => setViewAs(on ? "" : u.id)} />
                            <span className={`min-w-0 flex-1 truncate ${on ? "text-white" : "text-soft"}`}>{u.name}</span>
                            {on && legendRows.length > 0 && (
                              <span className="shrink-0 text-[10px]">
                                <span style={{ color: PERMISSION_COLORS.view.color }}>{legendRows.find((e) => e.status === "view")?.count ?? 0}</span>/
                                <span style={{ color: PERMISSION_COLORS.no_access.color }}>{legendRows.find((e) => e.status === "no_access")?.count ?? 0}</span>
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                    <p className="mt-1 text-[10.5px] text-muted">Blue: the account may view the node · red: not granted · gray: no account ticked. Hover a node for the reason.</p>
                  </div>
                  {permErr && <p className="mt-1 text-bad">{permErr}</p>}
                </div>
              ) : (
              <div className="absolute right-3 top-3 z-10 max-w-64 rounded-lg border border-line-2 bg-panel/95 p-2.5 text-xs shadow-xl">
                <div className="mb-1 font-medium text-soft">{COLOR_OPTIONS.find((o) => o.id === colorBy)?.label}</div>
                {paint.legend.map((l) => (
                  <div key={l.label} className="flex items-center gap-2 py-0.5">
                    {l.icon ? <Icon name={l.icon} className="h-3 w-3 text-muted" /> : <span className="w-3" />}
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: l.color }} />
                    <span className="text-soft">{l.label}</span>
                  </div>
                ))}
                {colorBy !== "type" && <div className="mt-1.5 border-t border-line pt-1.5 text-[11px] text-muted">Node type: the label and icon on each node</div>}
              </div>
              )
            }
          />
          <BottomPanel node={single} tab={bottom} onTab={setBottom} selected={selected} onSelect={selectOne} onChanged={load} />
        </div>

        {!sideOpen && (
          <aside className="flex w-9 shrink-0 flex-col items-center gap-1 border-l border-line bg-panel py-2" aria-label="Panel detail (diciutkan)">
            <button type="button" onClick={() => foldSide(true)} title="Buka panel" className="rounded p-1.5 text-muted hover:bg-white/5 hover:text-white">
              <Icon name="left" className="h-3.5 w-3.5" />
            </button>
            {SIDE_TABS.map(([k, label, icon]) => (
              <button key={k} type="button" onClick={() => foldSide(true, k)} title={label} className={`rounded p-1.5 hover:bg-white/5 hover:text-white ${side === k ? "text-white" : "text-muted"}`}>
                <Icon name={icon} className="h-3.5 w-3.5" />
              </button>
            ))}
            <button type="button" onClick={() => foldSide(true)} className="mt-2 text-xs text-muted [writing-mode:vertical-rl] hover:text-white">
              {SIDE_TABS.find(([k]) => k === side)?.[1]}
            </button>
          </aside>
        )}
        <aside className={`w-[360px] shrink-0 flex-col border-l border-line bg-panel ${sideOpen ? "flex" : "hidden"}`}>
          <div className="flex border-b border-line px-2 text-xs">
            {SIDE_TABS.map(([k, label, icon]) => (
              <button key={k} type="button" onClick={() => setSide(k)} className={`-mb-px flex items-center gap-1 border-b-2 px-2.5 py-2.5 ${side === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
                <Icon name={icon} className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
            <button type="button" onClick={() => foldSide(false)} title="Ciutkan panel" className="ml-auto self-center rounded p-1.5 text-muted hover:bg-white/5 hover:text-white">
              <Icon name="right" className="h-3.5 w-3.5" />
            </button>
          </div>
          {side === "properties" &&
            (single ? (
              <PropertiesPanel
                key={single.id}
                id={single.id}
                onSelect={selectOne}
                onFocus={focusOn}
                customColor={custom[single.id]}
                onCustomColor={
                  colorBy === "custom"
                    ? (c) => {
                        const next = { ...custom };
                        for (const id of selArr) {
                          if (c) next[id] = c;
                          else delete next[id];
                        }
                        setCustom(next);
                      }
                    : undefined
                }
              />
            ) : selNodes.length > 1 ? (
              <HistogramPanel nodes={selNodes} onSelectIds={(ids) => setSelected(new Set(ids))} />
            ) : (
              <Overview graph={graph} onSelect={selectOne} />
            ))}
          {side === "build" && <BuildsPanel key={selArr.join(",")} selected={selArr} onBuilt={load} />}
          {side === "schedules" && <SchedulesPanel nodes={selNodes} onChanged={load} />}
          {side === "related" && <RelatedPanel nodes={selNodes} all={byId} edges={graph.edges} onSelect={selectOne} />}
        </aside>
      </div>

      {dialog === "save" && (
        <SaveDialog
          initial={saved?.name ?? ""}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            const g = await lineage.saveGraph({ ...saveBody(), name });
            setSaved(g);
            setDialog(null);
            router.replace(`/lineage?graph=${g.id}`);
          }}
        />
      )}
      {dialog === "open" && <OpenDialog onClose={() => setDialog(null)} onOpen={(g) => (setDialog(null), router.replace(`/lineage?graph=${g.id}`))} />}
      {assist && (
        <AipAssistPanel
          adapter={lineageAssist({
            graph,
            shown: visibleIds,
            selected: selArr,
            title: saved?.name ?? (single ? single.name : "kanvas"),
            docKey: saved?.id ?? "canvas",
            setSelected: (ids) => setSelected(new Set(ids)),
            addNodes,
            expand,
            setColorBy,
            walk: (ids, dir, depth) => walk(graph, ids, dir, depth),
          })}
          onClose={() => setAssist(false)}
        />
      )}
    </div>
    </Compact.Provider>
  );
}

function ToolMenu({ icon, label, items, disabled }: { icon: IconName; label: string; items: [string, () => void][]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen(!open)} className={buttonClass.ghost}>
        <Icon name={icon} className="h-3.5 w-3.5" /> {label} <Icon name="down" className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-60 overflow-hidden rounded-lg border border-line-2 bg-panel py-1 shadow-2xl">
          {items.map(([l, fn]) => (
            <button
              key={l}
              type="button"
              onClick={() => {
                setOpen(false);
                fn();
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-soft hover:bg-panel-2 hover:text-white"
            >
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Overview({ graph, onSelect }: { graph: LineageGraph; onSelect: (id: string) => void }) {
  const stale = graph.nodes.filter((n) => n.stale);
  const failing = graph.nodes.filter((n) => n.health?.status === "failing" || n.last_build?.status === "failed");
  const groups: [string, LineageNode[], IconName, string][] = [
    ["Out of date", stale, "alert", "text-warn"],
    ["Failing builds or health checks", failing, "x", "text-bad"],
  ];
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
      <p className="text-xs text-muted">Click a node for its details; Ctrl/Shift-click or Shift-drag to select several. The numbered circles on a node expand its hidden parents and children.</p>
      <div className="grid grid-cols-3 gap-2 text-center">
        {FAMILIES.map((f) => (
          <div key={f.id} className="rounded-lg bg-panel-2 p-2">
            <div className="text-lg font-semibold tabular-nums">{graph.nodes.filter((n) => familyOf(n.kind).id === f.id).length}</div>
            <div className="text-[11px] text-muted">{f.label}</div>
          </div>
        ))}
      </div>
      {groups.map(([title, list, icon, cls]) => (
        <div key={title}>
          <div className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${cls}`}>
            <Icon name={icon} className="h-3.5 w-3.5" /> {title} ({list.length})
          </div>
          {list.map((n) => (
            <button key={n.id} type="button" onClick={() => onSelect(n.id)} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-xs text-soft hover:bg-panel-2">
              {n.name} <span className="text-muted">· {n.stale ?? n.last_build?.error ?? n.health?.results.find((r) => !r.ok)?.message}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function BottomPanel({
  node,
  tab,
  onTab,
  selected,
  onSelect,
  onChanged,
}: {
  node: LineageNode | null;
  tab: Bottom | null;
  onTab: (t: Bottom | null) => void;
  selected: Set<string>;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const data = node && (node.kind === "dataset" || node.kind === "object_type");
  const tabs: [Bottom, string, IconName, boolean][] = [
    ["preview", "Preview", "table", !!data],
    ["history", "History", "history", !!node],
    ["code", "Code", "code", !!node && ["dataset", "transform", "pipeline"].includes(node.kind)],
    ["timeline", "Build timeline", "clock", true],
    ["health", "Data health", "wave", node?.kind === "dataset"],
    ["sql", "SQL", "code", !!data],
  ];
  const open = tab && tabs.find((t) => t[0] === tab)?.[3] ? tab : null;
  return (
    <div className={`flex shrink-0 flex-col border-t border-line bg-panel ${open ? "h-72" : ""}`}>
      <div className="flex h-9 shrink-0 items-center gap-1 px-2 text-xs">
        {tabs
          .filter((t) => t[3])
          .map(([k, label, icon]) => (
            <button key={k} type="button" onClick={() => onTab(open === k ? null : k)} className={`flex items-center gap-1.5 rounded px-2 py-1 ${open === k ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}>
              <Icon name={icon} className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        {node && <span className="ml-auto truncate pr-2 text-muted">{node.name}</span>}
        {open && (
          <button type="button" onClick={() => onTab(null)} className="rounded p-1 text-muted hover:text-white" aria-label="Collapse">
            <Icon name="down" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto border-t border-line">
          {open === "preview" && node && <PreviewTab id={node.id} />}
          {open === "history" && node && <HistoryTab key={node.id} id={node.id} onChanged={onChanged} />}
          {open === "code" && node && <CodeTab id={node.id} />}
          {open === "timeline" && <TimelineTab highlight={selected} onSelect={onSelect} />}
          {open === "health" && node && <HealthTab key={node.id} node={node} onChanged={onChanged} />}
          {open === "sql" && node && (
            <div className="flex h-full min-h-0 flex-col">
              <SqlConsole
                key={node.id}
                name={node.name}
                mode={node.kind === "object_type" ? "object" : "data"}
                resource={node.kind === "object_type" ? `ri.ontology.main.object-type.${node.id.split(":").pop()}` : `ri.foundry.main.dataset.${node.id.split(":").pop()}`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SaveDialog({ title = "Save graph", initial, onClose, onSave }: { title?: string; initial: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} icon={title === "Save graph" ? "save" : "plus"} onClose={onClose}>
      <form
        className="space-y-3 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onSave(name.trim());
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer 360 pipeline" className={inputClass} />
        <p className="text-xs text-muted">Saves the nodes on the graph, the node colouring and custom colours. Anyone with the link sees the same graph.</p>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={!name.trim()} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function OpenDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (g: SavedGraph) => void }) {
  const [graphs, setGraphs] = useState<SavedGraph[] | null>(null);
  useEffect(() => {
    lineage.graphs().then(setGraphs).catch(() => setGraphs([]));
  }, []);
  return (
    <Modal title="Open graph" icon="folder" onClose={onClose}>
      <div className="max-h-96 space-y-1 overflow-y-auto p-3">
        {graphs === null && <p className="p-2 text-sm text-muted">Loading…</p>}
        {graphs?.length === 0 && <p className="p-2 text-sm text-muted">No saved graphs yet.</p>}
        {graphs?.map((g) => (
          <div key={g.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2">
            <button type="button" onClick={() => onOpen(g)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-sm">{g.name}</div>
              <div className="text-xs text-muted">
                {g.nodes.length} nodes · updated {when(g.updated_at)}
              </div>
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog(`Delete the saved graph "${g.name}"?`))) return;
                await lineage.deleteGraph(g.id);
                setGraphs((cur) => cur?.filter((x) => x.id !== g.id) ?? null);
              }}
              className="p-1 text-muted hover:text-bad"
            >
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

type RelMode = "focus" | "all" | "off";
const REL_MODE_KEY = "bluesandai.lineage.relations";
type RelStyle = "compact" | "erd";
const REL_STYLE_KEY = "bluesandai.lineage.relation-style";
const REL_MODE_LABEL: Record<RelMode, string> = { focus: "hanya object type terpilih/disorot", all: "semua (samar)", off: "disembunyikan" };

/** a cubic Bézier as [x0, y0, c1x, c1y, c2x, c2y, x1, y1] */
type Cubic = [number, number, number, number, number, number, number, number];
const cubicPath = (c: Cubic) => `M${c[0]},${c[1]} C${c[2]},${c[3]} ${c[4]},${c[5]} ${c[6]},${c[7]}`;
/** de Casteljau at t = ½: the halves meet at the curve's midpoint (where the ERD diamond sits) */
function splitCubic(c: Cubic): [Cubic, Cubic] {
  const mid = (x1: number, y1: number, x2: number, y2: number): [number, number] => [(x1 + x2) / 2, (y1 + y2) / 2];
  const [ax, ay] = mid(c[0], c[1], c[2], c[3]);
  const [bx, by] = mid(c[2], c[3], c[4], c[5]);
  const [cx, cy] = mid(c[4], c[5], c[6], c[7]);
  const [dx, dy] = mid(ax, ay, bx, by);
  const [ex, ey] = mid(bx, by, cx, cy);
  const [mx, my] = mid(dx, dy, ex, ey);
  return [[c[0], c[1], ax, ay, dx, dy, mx, my], [mx, my, ex, ey, cx, cy, c[6], c[7]]];
}

function Canvas({
  graph,
  loading = false,
  nodes,
  edges,
  visible,
  selected,
  found,
  color,
  onMoveNodes,
  onDropNode,
  groups = [],
  bands = [],
  access,
  solid = false,
  flow,
  onSelect,
  onSelectMany,
  onExpand,
  onFocus,
  onRemove,
  legend,
}: {
  groups?: { x: number; y: number; h: number; color: string; count: number }[];
  bands?: { zone: number; label: string; x: number; y: number; w: number; h: number }[];
  /** fill whole nodes with their colour (Permissions: blue can view, red no access) */
  solid?: boolean;
  /** nodes dragged to a new place (graph coordinates) */
  onMoveNodes?: (moves: { id: string; x: number; y: number }[]) => void;
  /** a node dragged from the search results was dropped at (x, y) */
  onDropNode?: (id: string, x: number, y: number) => void;
  /** Permissions: what the account viewed as may do with a node, and why (a line of its tooltip) */
  access?: (n: LineageNode) => string | undefined;
  graph: LineageGraph;
  /** the lineage is still being fetched: a spinner, not "the graph is empty" */
  loading?: boolean;
  nodes: Placed[];
  edges: { from: string; to: string; label: string }[];
  visible: Set<string>;
  selected: Set<string>;
  found: Set<string> | null;
  color: (n: LineageNode) => string;
  flow: boolean;
  onSelect: (id: string | null, additive: boolean) => void;
  onSelectMany: (ids: string[], additive: boolean) => void;
  onExpand: (id: string, dir: "up" | "down") => void;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
  legend: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [drag, setDrag] = useState<{ mode: "pan" | "box"; sx: number; sy: number; ox: number; oy: number; cx: number; cy: number; additive: boolean } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // room on the right for same-column relation brackets (ERD), so fit keeps them in view
  const width = Math.max(0, ...nodes.map((n) => n.x + NODE_W)) + ((graph.relations ?? []).length ? 120 : 0);
  const height = Math.max(0, ...nodes.map((n) => n.y + NODE_H));
  // hidden neighbours per node: the expand circles
  const hidden = useMemo(() => {
    const up = new Map<string, number>();
    const down = new Map<string, number>();
    for (const e of graph.edges) {
      if (visible.has(e.to) && !visible.has(e.from)) up.set(e.to, (up.get(e.to) ?? 0) + 1);
      if (visible.has(e.from) && !visible.has(e.to)) down.set(e.from, (down.get(e.from) ?? 0) + 1);
    }
    return { up, down };
  }, [graph.edges, visible]);
  // Nexus relations (link types) between the object types on the canvas, and each type's relation count
  // relations on the canvas — "focus": only those of the selected / hovered object types (full ERD marks); "all": every
  // relation as a faint line, marks only where focused; "off": none. Remembered in this browser.
  const [relMode, setRelMode] = useState<RelMode>(() => {
    try {
      const v = localStorage.getItem(REL_MODE_KEY);
      return v === "focus" || v === "off" ? v : "all";
    } catch {
      return "all";
    }
  });
  // how a relation is drawn — "compact": a thin line with a small cardinality pill (the default, easy to read);
  // "erd": Chen notation (diamond, 1/N/M at the ends, double lines for total participation)
  const [relStyle, setRelStyle] = useState<RelStyle>(() => {
    try {
      return localStorage.getItem(REL_STYLE_KEY) === "erd" ? "erd" : "compact";
    } catch {
      return "compact";
    }
  });
  const toggleRelStyle = () =>
    setRelStyle((s) => {
      const next: RelStyle = s === "erd" ? "compact" : "erd";
      try {
        localStorage.setItem(REL_STYLE_KEY, next);
      } catch {
        /* private window */
      }
      return next;
    });
  const cycleRelMode = () =>
    setRelMode((m) => {
      const next: RelMode = m === "focus" ? "all" : m === "all" ? "off" : "focus";
      try {
        localStorage.setItem(REL_MODE_KEY, next);
      } catch {
        /* private window */
      }
      return next;
    });
  const showRel = relMode !== "off";
  const [hoverRel, setHoverRel] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const rels = useMemo(() => (graph.relations ?? []).filter((r) => byId.has(r.from) && byId.has(r.to)), [graph.relations, byId]);
  const focusIds = useMemo(() => new Set([...selected, ...(hoverNode ? [hoverNode] : [])]), [selected, hoverNode]);
  const shownRels = useMemo(
    () => (relMode === "off" ? [] : relMode === "all" ? rels : rels.filter((r) => focusIds.has(baseId(r.from)) || focusIds.has(baseId(r.to)))),
    [relMode, rels, focusIds],
  );
  // ERD participation (total = every object of that side is linked), asked only for the relations being looked at:
  // hovered, or of a selected / hovered object type (the only ones whose marks and tooltip show it). Asking for every
  // relation on the canvas counted every object of every type as the graph opened (~11 s for the BPJS graph).
  const [part, setPart] = useState<Record<string, Participation>>({});
  const asked = useRef(new Set<string>());
  const litKey = showRel
    ? rels.filter((r) => r.id === hoverRel || focusIds.has(baseId(r.from)) || focusIds.has(baseId(r.to))).map((r) => r.id).sort().join(",")
    : "";
  useEffect(() => {
    if (!litKey) return;
    // a pointer passing over the canvas asks nothing: only where it rests
    const t = setTimeout(() => {
      const ids = litKey.split(",").filter((id) => !asked.current.has(id));
      if (!ids.length) return;
      ids.forEach((id) => asked.current.add(id));
      lineage.participation(ids).then(
        (p) => setPart((prev) => ({ ...prev, ...p })),
        () => ids.forEach((id) => asked.current.delete(id)),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [litKey]);
  const relCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of graph.relations ?? []) {
      m.set(r.from, (m.get(r.from) ?? 0) + 1);
      if (r.to !== r.from) m.set(r.to, (m.get(r.to) ?? 0) + 1);
    }
    return m;
  }, [graph.relations]);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !nodes.length) return;
    const k = Math.min(1.2, Math.max(0.25, Math.min((el.clientWidth - 80) / Math.max(1, width), (el.clientHeight - 80) / Math.max(1, height))));
    setView({ k, x: (el.clientWidth - width * k) / 2, y: (el.clientHeight - height * k) / 2 });
  }, [nodes.length, width, height]);
  const signature = nodes.map((n) => n.id).join("|");
  useEffect(() => {
    const t = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const zoom = (factor: number, cx?: number, cy?: number) => {
    const el = box.current!;
    const px = cx ?? el.clientWidth / 2;
    const py = cy ?? el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.2, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: ReactPointerEvent) => {
    if ((e.target as Element).closest("[data-node]") || e.button !== 0) return;
    setMenu(null);
    const p = local(e);
    setDrag({ mode: e.shiftKey ? "box" : "pan", sx: p.x, sy: p.y, ox: view.x, oy: view.y, cx: p.x, cy: p.y, additive: e.ctrlKey || e.metaKey });
  };
  // dragging nodes: the selection moves together; a drag is not a click
  const nodeDrag = useRef<{ ids: string[]; sx: number; sy: number; start: Map<string, { x: number; y: number }>; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const startNodeDrag = (e: ReactPointerEvent, n: Placed) => {
    if (e.button !== 0 || !onMoveNodes) return;
    e.stopPropagation();
    const p = local(e);
    const ids = selected.has(n.id) ? [...selected].filter((id) => byId.has(id)) : [n.id];
    nodeDrag.current = { ids, sx: p.x, sy: p.y, start: new Map(ids.map((id) => [id, { x: byId.get(id)!.x, y: byId.get(id)!.y }])), moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const moveNodes = (e: ReactPointerEvent) => {
    const d = nodeDrag.current;
    if (!d) return false;
    const p = local(e);
    const dx = (p.x - d.sx) / view.k;
    const dy = (p.y - d.sy) / view.k;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return true;
    d.moved = true;
    onMoveNodes?.(d.ids.map((id) => ({ id, x: Math.round(d.start.get(id)!.x + dx), y: Math.round(d.start.get(id)!.y + dy) })));
    return true;
  };
  const move = (e: ReactPointerEvent) => {
    if (moveNodes(e)) return;
    if (!drag) return;
    const p = local(e);
    if (drag.mode === "pan") setView((v) => ({ ...v, x: drag.ox + p.x - drag.sx, y: drag.oy + p.y - drag.sy }));
    setDrag({ ...drag, cx: p.x, cy: p.y });
  };
  const up = () => {
    if (nodeDrag.current) {
      suppressClick.current = nodeDrag.current.moved;
      nodeDrag.current = null;
      return;
    }
    if (!drag) return;
    if (drag.mode === "box") {
      const [x1, x2] = [Math.min(drag.sx, drag.cx), Math.max(drag.sx, drag.cx)].map((x) => (x - view.x) / view.k);
      const [y1, y2] = [Math.min(drag.sy, drag.cy), Math.max(drag.sy, drag.cy)].map((y) => (y - view.y) / view.k);
      onSelectMany(
        nodes.filter((n) => n.x + NODE_W > x1 && n.x < x2 && n.y + NODE_H > y1 && n.y < y2).map((n) => n.id),
        drag.additive,
      );
    } else if (Math.abs(drag.cx - drag.sx) < 3 && Math.abs(drag.cy - drag.sy) < 3) onSelect(null, false);
    setDrag(null);
  };

  return (
    <div
      ref={box}
      className="dot-grid relative min-h-0 flex-1 select-none overflow-hidden"
      style={{ cursor: drag?.mode === "pan" ? "grabbing" : "default" }}
      onWheel={(e) => {
        const p = local(e);
        zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
      }}
      onPointerDown={down}
      onDragOver={(e) => {
        if (onDropNode && e.dataTransfer.types.includes(NODE_DRAG)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(NODE_DRAG);
        if (!id || !onDropNode) return;
        e.preventDefault();
        const p = local(e);
        onDropNode(id, (p.x - view.x) / view.k, (p.y - view.y) / view.k);
      }}
      onPointerMove={move}
      onPointerUp={up}
      onPointerLeave={() => setDrag(null)}
    >
      {legend}
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted" role="status" aria-live="polite">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-line-2 border-t-ocean" />
          Loading the lineage…
        </div>
      )}
      {!loading && nodes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted">
          <Icon name="split" className="h-6 w-6" />
          The graph is empty. Search for a dataset, pipeline or Nexus object type at the top left to start its lineage.
        </div>
      )}
      <svg id="lineage-svg" className="absolute inset-0 h-full w-full" role="img" aria-label="Lineage graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--color-muted)" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const a = byId.get(e.from)!;
            const b = byId.get(e.to)!;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const d =
              x2 <= x1
                ? `M${x1},${y1} C${x1 + 60},${y1 - 70} ${x2 - 60},${y2 - 70} ${x2},${y2}`
                : `M${x1},${y1} C${x1 + COL_GAP / 2},${y1} ${x2 - COL_GAP / 2},${y2} ${x2},${y2}`;
            const lit = selected.has(e.from) || selected.has(e.to);
            return (
              <g key={i} onMouseEnter={() => setHoverEdge(i)} onMouseLeave={() => setHoverEdge(null)}>
                <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
                <path
                  d={d}
                  fill="none"
                  stroke={lit ? "var(--color-ocean)" : "var(--color-line-2)"}
                  strokeWidth={lit ? 2 : 1.5}
                  markerEnd="url(#arrow)"
                  strokeDasharray={flow ? "6 6" : undefined}
                  className={flow ? "lineage-flow" : undefined}
                  opacity={found && !found.has(e.from) && !found.has(e.to) ? 0.25 : 1}
                />
                {(hoverEdge === i || lit) && e.label && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize={10} fill="var(--color-soft)" style={{ paintOrder: "stroke", stroke: "var(--color-ink)", strokeWidth: 3 }}>
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
          {showRel &&
            (() => {
              // parallel relations between the same two types fan out; ends clipped to the node boxes
              const pairs = new Map<string, number>();
              const seen = new Map<string, number>();
              for (const r of shownRels) {
                const k = [r.from, r.to].sort().join("|");
                pairs.set(k, (pairs.get(k) ?? 0) + 1);
              }
              const clip = (cx: number, cy: number, tx: number, ty: number): [number, number] => {
                const dx = tx - cx;
                const dy = ty - cy;
                const s = Math.min(dx ? NODE_W / 2 / Math.abs(dx) : Infinity, dy ? NODE_H / 2 / Math.abs(dy) : Infinity, 1);
                return [cx + dx * s, cy + dy * s];
              };
              return shownRels.map((r) => {
                const a = byId.get(r.from)!;
                const b = byId.get(r.to)!;
                const key = [r.from, r.to].sort().join("|");
                const k = seen.get(key) ?? 0;
                seen.set(key, k + 1);
                const n = pairs.get(key) ?? 1;
                const lit = hoverRel === r.id || focusIds.has(baseId(r.from)) || focusIds.has(baseId(r.to));
                // "all" mode: an unfocused relation is only a faint line — no diamond, no marks, no labels
                const quiet = !lit;
                const label = CARDINALITY[r.cardinality] ?? r.cardinality;
                const ax = a.x + NODE_W / 2;
                const ay = a.y + NODE_H / 2;
                // every shape as one cubic (P0 C1 C2 P3), split at the diamond: each half belongs to one entity's side
                let cub: Cubic;
                // ERD (Chen): the cardinality sits at each end, next to its entity; the relationship is the diamond
                let ends: [[number, number], [number, number]];
                let tagX: number | null = null;
                if (r.from === r.to) {
                  const x0 = a.x + NODE_W - 30 - k * 14;
                  cub = [x0, a.y, x0 - 10, a.y - 46 - k * 10, x0 + 40, a.y - 46 - k * 10, x0 + 24, a.y];
                  ends = [[x0 - 8, a.y - 10], [x0 + 32, a.y - 10]];
                } else if (Math.abs(a.x - b.x) < NODE_W / 2) {
                  // both types in one column: a bracket out past the column's right edge, not through the nodes between them
                  const sx = a.x + NODE_W;
                  const ex = b.x + NODE_W;
                  const bulge = 52 + k * (n > 1 ? 100 : 40); // labelled pills (several relations) need room side by side
                  // parallel relations leave and reach each node at their own height, so their marks never stack
                  const lane = (k - (n - 1) / 2) * 14;
                  const sy = ay + lane;
                  const ey = b.y + NODE_H / 2 + lane;
                  cub = [sx, sy, sx + bulge, sy, ex + bulge, ey, ex, ey];
                  // each mark sits on its own line just outside the node, the names line up past the outermost bracket
                  ends = [[sx + 30, sy - 7], [ex + 30, ey - 7]];
                  if (n > 1) tagX = sx + 0.75 * (52 + (n - 1) * 40) + 18;
                } else {
                  const bx = b.x + NODE_W / 2;
                  const by = b.y + NODE_H / 2;
                  const len = Math.hypot(bx - ax, by - ay) || 1;
                  // parallel relations: their diamonds and end marks side by side (wider apart when the line runs vertically)
                  const off = (k - (n - 1) / 2) * (Math.abs(by - ay) > Math.abs(bx - ax) ? 44 : 26);
                  const px = (-(by - ay) / len) * off;
                  const py = ((bx - ax) / len) * off;
                  const [x1, y1] = clip(ax, ay, bx + px, by + py);
                  const [x2, y2] = clip(bx, by, ax + px, ay + py);
                  const qx = (x1 + x2) / 2 + px * 1.6;
                  const qy = (y1 + y2) / 2 + py * 1.6;
                  // the quadratic through (qx, qy) as a cubic
                  cub = [x1, y1, x1 + (2 / 3) * (qx - x1), y1 + (2 / 3) * (qy - y1), x2 + (2 / 3) * (qx - x2), y2 + (2 / 3) * (qy - y2), x2, y2];
                  // a point on the curve near each end, nudged off the line so the mark reads beside it
                  const at = (t: number): [number, number] => {
                    const u = 1 - t;
                    const x = u * u * x1 + 2 * u * t * qx + t * t * x2;
                    const y = u * u * y1 + 2 * u * t * qy + t * t * y2;
                    const tx = 2 * u * (qx - x1) + 2 * t * (x2 - qx);
                    const ty = 2 * u * (qy - y1) + 2 * t * (y2 - qy);
                    const l = Math.hypot(tx, ty) || 1;
                    return [x - (ty / l) * 8, y + (tx / l) * 8];
                  };
                  const reach = Math.min(0.22, 22 / (Math.hypot(x2 - x1, y2 - y1) || 1));
                  ends = [at(reach), at(1 - reach)];
                }
                const [srcMark, tgtMark] = ERD_ENDS[r.cardinality] ?? ["?", "?"];
                const halo = { paintOrder: "stroke" as const, stroke: "var(--color-ink)", strokeWidth: 3 };
                const halves = splitCubic(cub);
                const [mx, my] = [halves[0][6], halves[0][7]];
                const p = part[r.id];
                const sides = [p?.source, p?.target];
                const sideText = (name: string | undefined, s: ParticipationSide | undefined) =>
                  s ? `\n${name ?? ""}: ${s.linked.toLocaleString("id-ID")} dari ${s.objects.toLocaleString("id-ID")} objek terhubung — partisipasi ${s.total ? "total" : "parsial"}${s.required ? " (kunci wajib)" : ""}` : "";
                const tip = `Relasi Nexus: ${r.name}\n${r.source_label ?? a.name} (${srcMark}) — ${r.target_label ?? b.name} (${tgtMark}) · ${label}${r.foreign_key ? `, kunci ${r.foreign_key}` : ""}${sideText(r.source_label, p?.source)}${sideText(r.target_label, p?.target)}`;
                if (relStyle === "compact") {
                  // executive view: one thin line and a small pill with the cardinality in its middle
                  // the cardinality only; the relation's name shows on hover (and a split role node names its role)
                  const text = `${srcMark}:${tgtMark}`;
                  const w = text.length * 6 + 14;
                  const hot = hoverRel === r.id || focusIds.has(baseId(r.from)) || focusIds.has(baseId(r.to));
                  return (
                    <g key={`rel-${r.id}`} onMouseEnter={() => setHoverRel(r.id)} onMouseLeave={() => setHoverRel(null)} opacity={found && !found.has(r.from) && !found.has(r.to) ? 0.25 : 1}>
                      <title>{tip}</title>
                      <path d={cubicPath(cub)} fill="none" stroke="transparent" strokeWidth={10} />
                      <path d={cubicPath(cub)} fill="none" stroke="#a78bfa" strokeOpacity={hot ? 0.95 : 0.5} strokeWidth={hot ? 1.6 : 1.1} strokeLinecap="round" />
                      <rect x={mx - w / 2} y={my - 7.5} width={w} height={15} rx={7.5} fill="var(--color-panel)" stroke="#a78bfa" strokeOpacity={hot ? 1 : 0.65} strokeWidth={hot ? 1.3 : 0.9} />
                      <text x={mx} y={my + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={600} fill={hot ? "#ffffff" : "#ddd6fe"}>
                        {text}
                      </text>
                      {hoverRel === r.id && (
                        <text x={mx} y={my + 20} textAnchor="middle" fontSize={9.5} fill="#ddd6fe" style={halo}>
                          {r.name}
                        </text>
                      )}
                    </g>
                  );
                }
                return (
                  <g key={`rel-${r.id}`} onMouseEnter={() => setHoverRel(r.id)} onMouseLeave={() => setHoverRel(null)} opacity={found && !found.has(r.from) && !found.has(r.to) ? 0.25 : 1}>
                    <title>{`Relasi Nexus: ${r.name}\n${r.source_label ?? ""} (${srcMark}) — ${r.target_label ?? ""} (${tgtMark}) · ${label}${r.kind ? `, ${r.kind.replace("_", " ")}` : ""}${r.foreign_key ? `, kunci ${r.foreign_key}` : ""}${sideText(r.source_label, p?.source)}${sideText(r.target_label, p?.target)}`}</title>
                    <path d={cubicPath(cub)} fill="none" stroke="transparent" strokeWidth={10} />
                    {halves.map((h, i) =>
                      quiet ? (
                        <path key={i} d={cubicPath(h)} fill="none" stroke="#a78bfa" strokeOpacity={0.28} strokeWidth={1} strokeLinecap="round" />
                      ) : sides[i]?.total ? (
                        // total participation: a double line between the entity and the diamond
                        <g key={i}>
                          <path d={cubicPath(h)} fill="none" stroke="#a78bfa" strokeOpacity={lit ? 1 : 0.75} strokeWidth={lit ? 4.6 : 4.2} strokeLinecap="butt" />
                          <path d={cubicPath(h)} fill="none" stroke="var(--color-ink)" strokeWidth={lit ? 1.8 : 1.6} strokeLinecap="butt" />
                        </g>
                      ) : (
                        <path key={i} d={cubicPath(h)} fill="none" stroke="#a78bfa" strokeOpacity={lit ? 1 : 0.6} strokeWidth={lit ? 1.8 : 1.2} strokeLinecap="round" />
                      ),
                    )}
                    {!quiet && (
                    <>
                    <polygon
                      points={`${mx},${my - 9} ${mx + 13},${my} ${mx},${my + 9} ${mx - 13},${my}`}
                      fill="#134e4a"
                      stroke="#2dd4bf"
                      strokeOpacity={lit ? 1 : 0.8}
                      strokeWidth={lit ? 1.6 : 1.1}
                    />
                    <g transform={`translate(${mx - 4.6},${my - 4.6}) scale(0.38)`} stroke="#99f6e4" fill="none" strokeWidth={2.6} strokeLinecap="round">
                      <path d={iconPath("link")} />
                    </g>
                    {[srcMark, tgtMark].map((m, i) => (
                      <text key={i} x={ends[i][0]} y={ends[i][1] + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={lit ? "#ffffff" : "#ddd6fe"} style={halo}>
                        {m}
                      </text>
                    ))}
                    {hoverRel === r.id ? (
                      <text x={mx} y={my + 22} textAnchor="middle" fontSize={9.5} fill="#ddd6fe" style={halo}>
                        {r.name}
                      </text>
                    ) : (
                      // several relations between the same two types: each diamond says which one it is
                      n > 1 && (
                        <g>
                          {tagX !== null && <path d={`M${mx + 13},${my} H${tagX - 3}`} stroke="#2dd4bf" strokeOpacity={0.45} strokeDasharray="2 2" />}
                          <text x={tagX ?? mx + 17} y={my + 3.5} fontSize={9} fill="#ccfbf1" style={halo}>
                            {shortRel(r.name)}
                          </text>
                        </g>
                      )
                    )}
                    </>
                    )}
                  </g>
                );
              });
            })()}
          {bands.map((b) => (
            <g key={`band${b.zone}`} pointerEvents="none" data-zone={b.zone}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={14} fill={["#a371f7", "#4f8cff", "#2bb673", "#f2a33a"][b.zone]} fillOpacity={0.045} stroke={["#a371f7", "#4f8cff", "#2bb673", "#f2a33a"][b.zone]} strokeOpacity={0.25} strokeDasharray="6 5" />
              <text x={b.x + 14} y={b.y + 26} fontSize={20} fontWeight={600} fill={["#a371f7", "#4f8cff", "#2bb673", "#f2a33a"][b.zone]} fillOpacity={0.85}>
                {b.label}
              </text>
            </g>
          ))}
          {groups.map((gr, i) => (
            <g key={`grp${i}`} pointerEvents="none">
              <rect x={gr.x - 10} y={gr.y - 10} width={NODE_W + 20} height={gr.h + 20} rx={10} fill={gr.color} fillOpacity={0.12} stroke={gr.color} strokeOpacity={0.6} strokeDasharray="4 3" />
              <text x={gr.x - 6} y={gr.y - 14} fontSize={10} fill={gr.color}>
                {gr.count} nodes
              </text>
            </g>
          ))}
          {nodes.map((n) => {
            const c = color(n);
            const on = selected.has(n.id);
            const dim = found && !found.has(n.id);
            const upCount = hidden.up.get(n.id) ?? 0;
            const downCount = hidden.down.get(n.id) ?? 0;
            const failing = n.health?.status === "failing";
            const nexus = n.kind === "object_type";
            return (
              <g
                key={n.id}
                data-node
                data-node-id={n.id}
                transform={`translate(${n.x},${n.y})`}
                opacity={dim ? 0.3 : 1}
                onPointerDown={(e) => startNodeDrag(e, n)}
                onMouseEnter={nexus ? () => setHoverNode(n.id) : undefined}
                onMouseLeave={nexus ? () => setHoverNode((h) => (h === n.id ? null : h)) : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onSelect(n.id, e.ctrlKey || e.metaKey || e.shiftKey);
                }}
                onDoubleClick={() => onFocus(n.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const p = local(e);
                  if (!selected.has(n.id)) onSelect(n.id, false);
                  setMenu({ id: n.id, x: p.x, y: p.y });
                }}
                style={{ cursor: "pointer" }}
              >
                <title>{`${n.kind_label}: ${n.name}${n.stale ? `\nOut of date: ${n.stale}` : ""}${n.columns?.length ? `\n${n.columns.length} columns` : ""}${
                  nexus ? `\nNexus object type · primary key ${n.primary_key ?? "-"} · ${relCount.get(n.id) ?? 0} relations` : ""
                }${access?.(n) ? `\n${access(n)}` : ""}`}</title>
                {nexus ? (
                  // a Nexus object type: a dark object card with an icon block, a link glyph, its relations — in every
                  // colouring; with solid colours (Permissions) the block and border carry the node's colour (its access)
                  <>
                    <rect width={NODE_W} height={NODE_H} rx={6} fill="#10151f" stroke={on ? "#ffffff" : found?.has(n.id) ? "var(--color-sand)" : solid ? c : n.type_color ?? c} strokeWidth={on || found?.has(n.id) ? 2 : solid ? 1.6 : 1.2} />
                    <path d={`M6,0 H${NODE_H} V${NODE_H} H6 a6,6 0 0 1 -6,-6 V6 a6,6 0 0 1 6,-6 z`} fill={solid ? c : n.type_color ?? c} />
                    <g transform={`translate(${NODE_H / 2 - 9},${NODE_H / 2 - 9}) scale(0.75)`} stroke={solid ? ink(c) : "#ffffff"} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d={(n.icon && iconPath(n.icon as IconName)) || iconPath(KIND_ICON[n.kind])} />
                    </g>
                    {!solid && <rect x={NODE_H} y={NODE_H - 3} width={NODE_W - NODE_H} height={3} fill={c} opacity={0.9} />}
                    {/* bottom right */}
                    <g
                      transform={`translate(${NODE_W - 18},${NODE_H - 18}) scale(0.5)`}
                      stroke="#c4b5fd"
                      fill="none"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                    >
                      <path d={iconPath("link")} />
                    </g>
                  </>
                ) : (
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={6}
                    fill={solid ? c : "var(--color-panel)"}
                    stroke={on ? "#ffffff" : found?.has(n.id) ? "var(--color-sand)" : solid ? "rgba(0,0,0,0.25)" : "var(--color-line-2)"}
                    strokeWidth={on || found?.has(n.id) ? 2 : 1}
                    strokeDasharray={n.missing ? "4 3" : undefined}
                  />
                )}
                {!solid && !nexus && <rect width={5} height={NODE_H} rx={2} fill={c} />}
                {!nexus && (
                  <g transform="translate(14,15) scale(0.62)" stroke={solid ? ink(c) : c} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d={iconPath(KIND_ICON[n.kind])} />
                  </g>
                )}
                <text
                  x={nexus ? NODE_H + 8 : 36}
                  y={18}
                  fontSize={9.5}
                  fill={nexus ? "#c4b5fd" : solid ? ink(c) : "var(--color-muted)"}
                  fillOpacity={solid && !nexus ? 0.8 : 1}
                  style={{ textTransform: "uppercase", letterSpacing: 0.4 }}
                >
                  {nexus ? `Nexus object${n.object_count != null ? ` · ${n.object_count.toLocaleString("id-ID")}` : ""}` : n.kind_label}
                </text>
                <text x={nexus ? NODE_H + 8 : 36} y={34} fontSize={12.5} fill={solid && !nexus ? ink(c) : n.missing ? "var(--color-bad)" : "#e8edf5"} fontWeight={500} textDecoration={n.missing ? "line-through" : undefined}>
                  {nexus ? (n.name.length > 20 ? `${n.name.slice(0, 19)}…` : n.name) : n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name}
                </text>
                {n.stale && (
                  <g transform={`translate(${NODE_W - 20},6)`}>
                    <circle cx={7} cy={7} r={7} fill="var(--color-warn)" />
                    <text x={7} y={10.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#000">
                      !
                    </text>
                  </g>
                )}
                {failing && (
                  <g transform={`translate(${NODE_W - (n.stale ? 38 : 20)},6)`}>
                    <circle cx={7} cy={7} r={7} fill="#d03b3b" />
                    <text x={7} y={10.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff">
                      ✕
                    </text>
                  </g>
                )}
                {(n.schedule_count ?? 0) > 0 && (
                  <g transform={`translate(${NODE_W - 20 - (n.stale ? 18 : 0) - (failing ? 18 : 0)},8) scale(0.5)`} stroke="var(--color-muted)" fill="none" strokeWidth={2.4}>
                    <path d={iconPath("clock")} />
                  </g>
                )}
                {upCount > 0 && (
                  <g
                    transform={`translate(-10,${NODE_H / 2})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onExpand(n.id, "up");
                    }}
                  >
                    <title>{`Show ${upCount} hidden parent${upCount > 1 ? "s" : ""}`}</title>
                    <circle r={8} fill="var(--color-panel)" stroke="var(--color-ocean)" />
                    <text textAnchor="middle" y={3.5} fontSize={9} fill="var(--color-ocean)">
                      {upCount}
                    </text>
                  </g>
                )}
                {downCount > 0 && (
                  <g
                    transform={`translate(${NODE_W + 10},${NODE_H / 2})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onExpand(n.id, "down");
                    }}
                  >
                    <title>{`Show ${downCount} hidden child${downCount > 1 ? "ren" : ""}`}</title>
                    <circle r={8} fill="var(--color-panel)" stroke="var(--color-ocean)" />
                    <text textAnchor="middle" y={3.5} fontSize={9} fill="var(--color-ocean)">
                      {downCount}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
        {drag?.mode === "box" && (
          <rect
            x={Math.min(drag.sx, drag.cx)}
            y={Math.min(drag.sy, drag.cy)}
            width={Math.abs(drag.cx - drag.sx)}
            height={Math.abs(drag.cy - drag.sy)}
            fill="rgba(61,139,253,0.1)"
            stroke="var(--color-ocean)"
            strokeDasharray="4 3"
          />
        )}
      </svg>
      {menu && (
        <div className="absolute z-40 w-60 overflow-hidden rounded-lg border border-line-2 bg-panel py-1 text-sm shadow-2xl" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {(
            [
              ["Expand parents", () => onExpand(menu.id, "up")],
              ["Expand children", () => onExpand(menu.id, "down")],
              ["Focus lineage (all up and down)", () => onFocus(menu.id)],
              ["Remove from graph", () => onRemove(menu.id)],
              ...(byId.get(menu.id)?.training ? [[byId.get(menu.id)!.training!.app ? `Training · ${byId.get(menu.id)!.training!.app}` : "Kode training · Code Repositories", () => window.open(byId.get(menu.id)!.training!.link, "_blank")] as [string, () => void]] : []),
              ...(byId.get(menu.id)?.link
                ? [[`Buka di ${ROOT_APP[byId.get(menu.id)!.kind]?.app ?? "app"}`, () => window.open(byId.get(menu.id)!.link!, "_blank")] as [string, () => void]]
                : []),
            ] as [string, () => void][]
          ).map(([label, fn]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setMenu(null);
                fn();
              }}
              className="block w-full px-3 py-1.5 text-left text-soft hover:bg-panel-2 hover:text-white"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1">
        <button type="button" onClick={() => zoom(1.2)} title="Zoom in" className="rounded-md border border-line-2 bg-panel p-1.5 text-soft hover:text-white">
          <Icon name="plus" className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => zoom(1 / 1.2)} title="Zoom out" className="rounded-md border border-line-2 bg-panel p-1.5 text-soft hover:text-white">
          <Icon name="minus" className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => fit()} title="Fit" className="rounded-md border border-line-2 bg-panel p-1.5 text-soft hover:text-white">
          <Icon name="fit" className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={cycleRelMode}
          title={`Relasi Nexus (ERD): ${REL_MODE_LABEL[relMode]} — klik untuk ${REL_MODE_LABEL[relMode === "focus" ? "all" : relMode === "all" ? "off" : "focus"]}.
ERD: belah ketupat = relasi; 1 = satu, N/M = banyak; garis ganda = partisipasi total; arahkan ke relasi untuk namanya.`}
          aria-label={`Relasi Nexus: ${REL_MODE_LABEL[relMode]}`}
          className={`flex items-center gap-1 rounded-md border p-1.5 ${showRel ? "border-violet-400/70 bg-violet-500/15 text-violet-200" : "border-line-2 bg-panel text-soft hover:text-white"}`}
        >
          <Icon name="link" className="h-3.5 w-3.5" />
          <span className="pr-0.5 text-[10px] leading-none">{relMode === "focus" ? "pilihan" : relMode === "all" ? "semua" : "mati"}</span>
        </button>
        {showRel && (
          <button
            type="button"
            onClick={toggleRelStyle}
            title={relStyle === "erd" ? "Gaya ERD (Chen) — klik untuk gaya ringkas: garis tipis + label kardinalitas" : "Gaya ringkas — klik untuk ERD lengkap (belah ketupat, 1/N/M di ujung, partisipasi)"}
            className={`rounded-md border px-1.5 py-1 text-[10px] font-semibold leading-none ${relStyle === "erd" ? "border-teal-400/70 bg-teal-500/15 text-teal-200" : "border-line-2 bg-panel text-soft hover:text-white"}`}
          >
            {relStyle === "erd" ? "ERD" : "1:N"}
          </button>
        )}
      </div>
      <div className="absolute bottom-3 right-3 z-10 text-xs text-muted">
        {nodes.length} nodes
        {rels.length
          ? relMode === "focus"
            ? ` · ${shownRels.length ? `${shownRels.length}/${rels.length} relasi Nexus` : `${rels.length} relasi Nexus — pilih object type untuk melihatnya`}`
            : relMode === "all"
              ? ` · ${rels.length} relasi Nexus${relStyle === "erd" ? " (samar)" : ""}`
              : ` · relasi disembunyikan`
          : ""}{selected.size ? ` · ${selected.size} selected` : ""} · Shift-drag to select · double-click to focus
      </div>
    </div>
  );
}
