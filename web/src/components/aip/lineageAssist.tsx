"use client";

import { COLOR_OPTIONS, type ColorBy } from "@/components/lineage/coloring";
import { CARDINALITY, type LineageGraph, type LineageNode } from "@/lib/lineage";
import type { AssistAdapter } from "./AipAssist";

/* AIP Assist in Data Lineage: reads the selected nodes (the area asked about) in depth — what feeds them, what they
   feed, their builds, schedules, Nexus relations and how far a change would ripple — plus the canvas in brief and the
   graph's nodes that match the question. It proposes canvas actions: select, add, walk up/downstream, recolour. */

export type LineageAssistDeps = {
  graph: LineageGraph;
  /** nodes on the canvas */
  shown: Set<string>;
  selected: string[];
  title: string;
  docKey: string;
  setSelected: (ids: string[]) => void;
  addNodes: (ids: string[]) => void;
  expand: (ids: string[], dir: "up" | "down" | "both", depth: number) => void;
  setColorBy: (c: ColorBy) => void;
  walk: (ids: string[], dir: "up" | "down", depth: number) => Set<string>;
};

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(str) : typeof v === "string" && v ? [v] : []);
const STOP = new Set("the a an of to in on for and or is are what which how why who apa yang dan di ke dari untuk ini itu node nodes data dataset mana siapa bagaimana kenapa ada dengan".split(" "));

export function lineageAssist(d: LineageAssistDeps): AssistAdapter {
  const { graph, shown, selected } = d;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sel = selected.filter((id) => byId.has(id));
  const name = (id: string) => byId.get(id)?.name ?? id;

  const resolve = (v: unknown): string | null => {
    const s = str(v).trim();
    if (!s) return null;
    if (byId.has(s)) return s;
    const named = graph.nodes.filter((n) => n.name.toLowerCase() === s.toLowerCase());
    if (named.length === 1) return named[0].id;
    const onCanvas = named.filter((n) => shown.has(n.id));
    return onCanvas.length === 1 ? onCanvas[0].id : null;
  };
  const ids = (v: unknown) => list(v).map(resolve).filter((x): x is string => !!x);

  const brief = (n: LineageNode) =>
    `- [${n.id}] "${n.name}" — ${n.kind_label}${n.project ? `, project ${n.project}` : ""}${n.rows !== undefined ? `, ${n.rows} rows` : ""}${n.last_build ? `, last build ${n.last_build.status}` : ""}${n.stale ? ", OUT OF DATE" : ""}${n.missing ? ", missing" : ""}`;

  const detail = (n: LineageNode) => {
    const ins = graph.edges.filter((e) => e.to === n.id).map((e) => `${name(e.from)} [${e.from}] (${e.label})`);
    const outs = graph.edges.filter((e) => e.from === n.id).map((e) => `${name(e.to)} [${e.to}] (${e.label})`);
    const rel = (graph.relations ?? []).filter((r) => r.from === n.id || r.to === n.id).map((r) => `${r.name}: ${name(r.from)} ${CARDINALITY[r.cardinality] ?? r.cardinality} ${name(r.to)}${r.foreign_key ? ` via ${r.foreign_key}` : ""}`);
    const up = d.walk([n.id], "up", 99).size;
    const down = d.walk([n.id], "down", 99);
    const downKinds = [...down].reduce<Record<string, number>>((m, id) => ((m[byId.get(id)?.kind_label ?? "?"] = (m[byId.get(id)?.kind_label ?? "?"] ?? 0) + 1), m), {});
    return [
      brief(n),
      n.path?.length ? `  path: ${n.path.join(" / ")}` : "",
      n.subtitle ? `  ${n.subtitle}` : "",
      n.columns?.length ? `  columns: ${n.columns.slice(0, 60).join(", ")}${n.columns.length > 60 ? ` … +${n.columns.length - 60}` : ""}` : "",
      n.updated_at ? `  updated ${n.updated_at}` : "",
      n.last_build?.error ? `  last build error: ${n.last_build.error.slice(0, 300)}` : "",
      n.stale ? `  out of date: ${n.stale}` : "",
      n.producers?.length ? `  produced by: ${n.producers.map((p) => JSON.stringify(p).slice(0, 160)).join("; ")}` : "",
      n.schedules?.length ? `  schedules: ${n.schedules.map((s) => JSON.stringify(s).slice(0, 160)).join("; ")}` : "",
      n.transform ? `  transform: ${n.transform}` : "",
      n.defines_object_types?.length ? `  backs Nexus object types: ${n.defines_object_types.join(", ")}` : "",
      n.kind === "object_type" ? `  Nexus object type${n.primary_key ? `, primary key ${n.primary_key}` : ""}${n.object_count !== undefined ? `, ${n.object_count} objects` : ""}` : "",
      n.kind === "reference" ? `  paper: ${n.title ?? n.name}; ${n.authors ?? ""}; DOI ${n.doi ?? "-"}; used for: ${n.note ?? "-"}` : "",
      `  inputs: ${ins.join(", ") || "none"}`,
      `  outputs: ${outs.join(", ") || "none"}`,
      rel.length ? `  Nexus relations: ${rel.join("; ")}` : "",
      `  upstream total ${up}; downstream total ${down.size}${down.size ? ` (${Object.entries(downKinds).map(([k, c]) => `${c} ${k}`).join(", ")})` : ""}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  return {
    key: `lineage:${d.docKey}`,
    app: `Data Lineage — ${d.title}`,
    selectHint: "Klik node, Shift+klik atau seret kotak (Shift+seret) untuk memilih area yang mau ditanyakan.",
    onClearSelection: () => d.setSelected([]),
    system:
      "You explain and explore a data lineage graph: datasets, pipelines, code transforms, Nexus (ontology) object and action types, apps, models and referenced papers, " +
      "connected by data-flow edges (inputs → outputs). Nexus relations between object types are link types, not data flow. Explain impact (what breaks downstream), " +
      "provenance (where data comes from), freshness and build problems. Use canvas tools to point at nodes or bring them onto the canvas.",
    context: (q) => {
      const words = q.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w));
      const candidates = words.length
        ? graph.nodes
            .filter((n) => !sel.includes(n.id))
            .map((n) => ({ n, hit: words.filter((w) => `${n.name} ${n.kind_label} ${(n.columns ?? []).join(" ")}`.toLowerCase().includes(w)).length }))
            .filter((x) => x.hit)
            .sort((a, b) => b.hit - a.hit)
            .slice(0, 25)
            .map((x) => x.n)
        : [];
      const canvas = graph.nodes.filter((n) => shown.has(n.id) && !sel.includes(n.id));
      return {
        selection: sel.map((id) => ({ id, label: name(id) })),
        text: [
          `Lineage graph "${d.title}": ${shown.size} nodes on the canvas, ${graph.nodes.length} in the whole lineage.`,
          sel.length ? `\n## Selected nodes (the area the user is asking about)\n${sel.map((id) => detail(byId.get(id)!)).join("\n")}` : "\n## No node selected — the question is about the canvas.",
          `\n## Other nodes on the canvas\n${canvas.slice(0, 120).map(brief).join("\n") || "none"}${canvas.length > 120 ? `\n… ${canvas.length - 120} more` : ""}`,
          canvas.length <= 40 ? `\n## Edges on the canvas\n${graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to)).slice(0, 150).map((e) => `${name(e.from)} → ${name(e.to)} (${e.label})`).join("\n")}` : "",
          candidates.length ? `\n## Lineage nodes matching the question${candidates.some((n) => !shown.has(n.id)) ? " (some not on the canvas yet)" : ""}\n${candidates.map((n) => `${brief(n)}${shown.has(n.id) ? "" : " [not on canvas]"}`).join("\n")}` : "",
          `\nColour modes: ${COLOR_OPTIONS.map((c) => `${c.id} (${c.label})`).join(", ")}`,
        ].join("\n"),
      };
    },
    suggestions: (has) =>
      has
        ? ["Jelaskan node terpilih: dari mana datanya & dipakai di mana", "Apa dampaknya ke hilir kalau node ini berubah atau gagal?", "Kenapa node ini out of date / gagal build?", "Tampilkan semua hulu node ini"]
        : ["Ringkas alur lineage di kanvas ini", "Node mana yang out of date atau gagal build?", "Object type Nexus mana saja di sini dan relasinya?", "Tandai node yang tidak punya schedule"],
    tools: [
      {
        name: "select_nodes",
        description: 'args {"ids": [node ids]} — selects (highlights) nodes, adding them to the canvas if needed',
        safe: true,
        preview: (a) => {
          const x = ids(a.ids);
          return x.length ? { text: x.map(name).join(", ") } : { error: "Node tidak ditemukan" };
        },
        run: (a) => {
          const x = ids(a.ids);
          d.addNodes(x);
          d.setSelected(x);
          return `${x.length} node dipilih`;
        },
      },
      {
        name: "add_nodes",
        description: 'args {"ids": [node ids]} — puts nodes from the lineage onto the canvas',
        safe: true,
        preview: (a) => {
          const x = ids(a.ids);
          const fresh = x.filter((id) => !shown.has(id));
          return x.length ? { text: `${fresh.length} baru di kanvas: ${fresh.map(name).join(", ") || "(sudah semua)"}` } : { error: "Node tidak ditemukan" };
        },
        run: (a) => {
          const x = ids(a.ids);
          d.addNodes(x);
          return `${x.length} node di kanvas`;
        },
      },
      {
        name: "show_lineage",
        description: 'args {"ids": [node ids], "direction": "up"|"down"|"both", "depth": number (1-99)} — brings upstream/downstream nodes onto the canvas',
        safe: true,
        preview: (a) => {
          const x = ids(a.ids);
          if (!x.length) return { error: "Node tidak ditemukan" };
          const dir = (["up", "down", "both"].includes(str(a.direction)) ? str(a.direction) : "both") as "up" | "down" | "both";
          const depth = Math.max(1, Math.min(99, Number(a.depth) || 1));
          const found = new Set<string>();
          if (dir !== "down") d.walk(x, "up", depth).forEach((i) => found.add(i));
          if (dir !== "up") d.walk(x, "down", depth).forEach((i) => found.add(i));
          return { text: `${dir === "up" ? "hulu" : dir === "down" ? "hilir" : "hulu & hilir"} ${depth >= 99 ? "semua level" : `${depth} level`} dari ${x.map(name).join(", ")}: ${found.size} node (${[...found].filter((i) => !shown.has(i)).length} baru)` };
        },
        run: (a) => {
          const x = ids(a.ids);
          const dir = (["up", "down", "both"].includes(str(a.direction)) ? str(a.direction) : "both") as "up" | "down" | "both";
          d.expand(x, dir, Math.max(1, Math.min(99, Number(a.depth) || 1)));
          d.setSelected(x);
          return "Lineage ditampilkan";
        },
      },
      {
        name: "color_by",
        description: `args {"mode": one of ${COLOR_OPTIONS.map((c) => c.id).join("|")}} — recolours the nodes (e.g. stale, build, health, schedules)`,
        safe: true,
        preview: (a) => {
          const o = COLOR_OPTIONS.find((c) => c.id === str(a.mode));
          return o ? { text: `Warnai menurut: ${o.label}` } : { error: `Mode warna tidak dikenal "${str(a.mode)}"` };
        },
        run: (a) => {
          d.setColorBy(str(a.mode) as ColorBy);
          return "Warna diganti";
        },
      },
    ],
  };
}
