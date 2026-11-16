/** Bluesand Orbis (api/orbis.py): the operational knowledge graph of the JKN demo, its vector index orbis-1 and answers. */
import { API_URL } from "./api";

export type Fact = [label: string, value: string];

export interface OrbisNode {
  id: string;
  kind: string;
  rawId: string;
  label: string;
  definition?: string;
  facts?: Fact[];
  url?: string;
  degree: number;
  /* injected by the force simulation */
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

export interface OrbisLink {
  source: string;
  target: string;
  predicate: string;
  propertyLabel?: string;
}

export interface KindMeta {
  label: string;
  color: string;
  group: string;
}

export interface PredicateMeta {
  label: string;
  color: string;
  desc: string;
}

export interface Layer {
  n: number;
  key: string;
  name: string;
  gist: string;
  kinds: { kind: string; label: string; count: number }[];
}

export interface OrbisPayload {
  meta: { title: string; subtitle: string; version: string; date: string; project: string; index: string; embedding_model: string };
  kinds: Record<string, KindMeta>;
  predicates: Record<string, PredicateMeta>;
  defaults?: { hiddenPredicates?: string[]; hiddenKinds?: string[] };
  nodes: OrbisNode[];
  links: OrbisLink[];
  layers: Layer[];
  stats: { nodes: number; links: number; kinds: number; generatedAt: string };
}

export type IndexStatus = {
  state: "idle" | "running" | "done" | "failed" | "interrupted";
  index: string;
  bucket: string;
  model: string;
  dimension: number;
  vectors: number;
  total?: number;
  todo?: number | null;
  done?: number;
  cost_usd?: number;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
};

export type SearchHit = { id: string; score: number; label?: string; kind?: string };
export type AskResult = {
  answer: string;
  refs: { n: number; id: string; label: string; kind: string }[];
  cited: string[];
  hits: SearchHit[];
  subgraph: { nodeIds: string[]; edges: { s: string; p: string; t: string }[] };
  ms: number;
  conversation_id?: string;
  message_id?: string;
  title?: string;
};

export type Conversation = { id: string; title: string; created_at: string; updated_at: string; messages: number };
export type StoredMessage = { id: string; role: "user" | "assistant"; content: string; result: AskResult | null; error: string | null; created_at: string };

/** Which Orbis graph the explorer shows: the JKN audit demo (/orbis) or the grid demo (/orbis/grid, api/orbis_grid.py).
 * Set by the page before the explorer renders; the API routes and payloads are the same. */
export type OrbisVariant = {
  base: string;
  title: string;
  index: string;
  intro: string;
  ask: string;
  suggestions: string[];
  sources: string[];
};

export const ORBIS_JKN: OrbisVariant = {
  base: "/api/orbis",
  title: "Bluesand Orbis",
  index: "orbis-1",
  intro:
    "setiap tabel, pipeline, objek, model, rujukan, regulasi, keputusan dan aplikasi yang dipakai demo, terhubung sebagaimana adanya di platform. Berbeda dengan Knowledge Nexus yang memetakan literatur medis, Orbis memetakan data operasional — dari berkas mentah sampai keputusan auditor.",
  ask: "Tanyakan apa saja tentang data demo JKN — faskes, dokter, kasus, dataset dan pipeline, model ML dan jurnal rujukannya, IoT alat medis, regulasi, keputusan tim audit.",
  suggestions: [
    "Faskes mana yang paling berisiko dan kenapa?",
    "Detektor apa saja yang dipakai model anomali dokter dan jurnal rujukannya?",
    "Bagaimana IoT alat medis membuktikan klaim Rontgen yang tidak didukung?",
    "Dataset apa yang mengalir ke tipe objek Faskes Audit?",
    "Regulasi apa yang menjadi dasar 20 subkategori risiko?",
    "Wilayah mana yang punya RS prioritas audit IoT?",
  ],
  sources: [
    "Data Lineage: berkas mentah, pipeline, transform, dataset, tipe objek, action, function, model, Workshop, Vertex, peta, Device and Machinery, aplikasi OSDK.",
    "Nexus: semua objek tipe demo dan link type-nya (foreign key dan join table), apa adanya.",
    "Machine learning: eksperimen dan AUROC, delapan detektor, metode, fitur, dan fitur penyebab anomali tiap dokter (Shapley).",
    "Rujukan: jurnal asal tiap metode, regulasi JKN, standar kode, register ASPAK.",
    "Keputusan tim audit dari riwayat edit (action).",
  ],
};

export const ORBIS_GRID: OrbisVariant = {
  base: "/api/orbis-grid",
  title: "Bluesand Orbis — Grid",
  index: "orbis-grid-1",
  intro:
    "jaringan distribusi (GI, penyulang, gardu, pelanggan), neraca energi, temuan susut teknis dan non-teknis, inspeksi P2TL, model NTL dan jurnal rujukannya, regulasi, keputusan tim susut, skenario what-if dan aplikasinya — terhubung sebagaimana adanya di platform, dari berkas SCADA mentah sampai perintah kerja.",
  ask: "Tanyakan apa saja tentang demo grid — penyulang dan gardu dengan susut tertinggi, pola pencurian, temuan dan buktinya, fitur dan jurnal model NTL, regulasi P2TL, skenario perbaikan teknis.",
  suggestions: [
    "Gardu mana yang susut non-teknisnya tertinggi dan kenapa?",
    "Pola apa yang paling bernilai di pelanggan TM industri?",
    "Fitur apa yang dipakai model NTL dan jurnal rujukannya?",
    "Dataset apa yang mengalir ke tipe objek Temuan Susut?",
    "Golongan P2TL apa untuk manipulasi CT/PT dan bypass meter?",
    "Skenario perbaikan teknis mana yang paling menurunkan susut?",
  ],
  sources: [
    "Data Lineage: berkas SCADA, AMR, tagihan dan P2TL, pipeline aset, susut, beban per jam, skor NTL dan akses per ULP, dataset, tipe objek, action, function, model, aplikasi.",
    "Nexus: semua objek tipe grid dan link type-nya, termasuk transmisi Jawa Barat dari OpenStreetMap.",
    "Pola susut NTL-01..14, TL-01..05 dan pengecoh X-01..05, dengan golongan pelanggaran P2TL.",
    "Machine learning: eksperimen (AUROC CV5, Rp per inspeksi), 22 fitur, metode, dan fitur yang membuat tiap pelanggan menyimpang.",
    "Rujukan: jurnal NTL/TL (DOI terverifikasi), Perdir P2TL, IEEE 1366, IEC CIM; keputusan tim dan skenario what-if.",
  ],
};

let variant: OrbisVariant = ORBIS_JKN;
export const setOrbisVariant = (v: OrbisVariant) => {
  variant = v;
};
export const orbisVariant = () => variant;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${variant.base}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText);
  return r.json();
}

export const orbis = {
  graph: () => call<OrbisPayload>("/graph"),
  rebuild: () => call<{ state: string }>("/build", { method: "POST" }),
  buildStatus: () => call<{ state: string; error?: string; finished_at?: string }>("/build"),
  index: () => call<IndexStatus>("/index"),
  reindex: (full = false) => call<IndexStatus>("/index", { method: "POST", body: JSON.stringify({ full }) }),
  search: (q: string, k = 15, kind?: string) => call<{ hits: SearchHit[]; ms: number }>("/search", { method: "POST", body: JSON.stringify({ q, k, kind }) }),
  ask: (q: string, conversationId: string | null) => call<AskResult>("/ask", { method: "POST", body: JSON.stringify({ q, conversation_id: conversationId }) }),
  conversations: (q = "") => call<Conversation[]>(`/conversations?q=${encodeURIComponent(q)}`),
  conversation: (id: string) => call<Omit<Conversation, "messages"> & { messages: StoredMessage[] }>(`/conversations/${encodeURIComponent(id)}`),
  renameConversation: (id: string, title: string) => call<{ id: string; title: string }>(`/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteConversation: (id: string) => call<{ deleted: string }>(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/* ------------------------------------------------------------ graph helpers (after the ai-jkn explorer) */

/** The canonical copy of an edge keeps its endpoints as ids; the canvas builds throwaway objects from it. */
export interface LinkRow {
  id: string;
  s: string;
  t: string;
  predicate: string;
  propertyLabel?: string;
}

export function normalizeLinks(links: OrbisLink[]): LinkRow[] {
  return links.map((l, i) => ({ id: `L${i}`, s: l.source, t: l.target, predicate: l.predicate, propertyLabel: l.propertyLabel }));
}

export interface Adjacency {
  out: Map<string, LinkRow[]>;
  in: Map<string, LinkRow[]>;
  all: Map<string, Set<string>>;
}

export function buildAdjacency(links: LinkRow[]): Adjacency {
  const out = new Map<string, LinkRow[]>();
  const inc = new Map<string, LinkRow[]>();
  const all = new Map<string, Set<string>>();
  const push = (m: Map<string, LinkRow[]>, k: string, v: LinkRow) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  const join = (a: string, b: string) => {
    const s = all.get(a);
    if (s) s.add(b);
    else all.set(a, new Set([b]));
  };
  for (const l of links) {
    push(out, l.s, l);
    push(inc, l.t, l);
    join(l.s, l.t);
    join(l.t, l.s);
  }
  return { out, in: inc, all };
}

/** Nodes within `depth` undirected hops of `rootId`, root included. */
export function egoNodeIds(adj: Adjacency, rootId: string, depth: number): Set<string> {
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const n of adj.all.get(id) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
    frontier = next;
    if (!frontier.length) break;
  }
  return seen;
}

/** Breadth-first shortest path (undirected) as an ordered list of node ids. */
export function shortestPath(adj: Adjacency, fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [fromId];
  const prev = new Map<string, string>([[fromId, ""]]);
  const queue = [fromId];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const n of adj.all.get(cur) ?? []) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      if (n === toId) {
        const path = [n];
        let step = cur;
        while (step) {
          path.push(step);
          step = prev.get(step) ?? "";
        }
        return path.reverse();
      }
      queue.push(n);
    }
  }
  return null;
}

export function pathLinks(links: LinkRow[], path: string[]): LinkRow[] {
  const out: LinkRow[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const hop = links.find((l) => (l.s === a && l.t === b) || (l.s === b && l.t === a));
    if (hop) out.push(hop);
  }
  return out;
}

const haystack = new WeakMap<OrbisNode, string>();
const searchText = (n: OrbisNode) => {
  let s = haystack.get(n);
  if (s === undefined) {
    s = [n.label, n.rawId, n.definition ?? "", ...(n.facts ?? []).map(([a, b]) => `${a} ${b}`)].join(" ").toLowerCase();
    haystack.set(n, s);
  }
  return s;
};

export function searchNodes(nodes: OrbisNode[], query: string, limit = 40): OrbisNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { node: OrbisNode; score: number }[] = [];
  for (const node of nodes) {
    const label = node.label.toLowerCase();
    let score = -1;
    if (label === q) score = 0;
    else if (node.rawId.toLowerCase() === q) score = 1;
    else if (label.startsWith(q)) score = 2;
    else if (label.includes(q)) score = 3;
    else if (searchText(node).includes(q)) score = 4;
    if (score >= 0) scored.push({ node, score: score * 10000 - node.degree });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.node);
}
