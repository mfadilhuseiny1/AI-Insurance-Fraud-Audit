"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { AGENT_COLOR } from "@/components/aip/AgentGraph";
import { modelName, type Rec } from "@/components/aip/aipRun";
import { API_URL } from "@/lib/api";

/* Every agent of AIP JKN in one graph to explore (api/aip/jaringan.py), laid out as the orchestration concept reads
   (docs/Agent Orchestration Concept) — top to bottom, without tangles:
     the people;
     the orchestrator ↔ the scrutiny validator (code) ↔ the validator: creator and verifier side by side;
     the machines, writing to the SHARED STATE — one bus every agent reads and writes, instead of agents talking;
     the workers: each domain agent a column, its small agents in a box beneath it (grouped by kind of work); the
     validator's QA reviewers and red team in the last column.
   The delegation tree and the bus are always drawn; the other relations (checks, challenges, tool use, hand-offs to
   people) appear for the agent in focus, or all at once with "Semua hubungan". Zoom (wheel, buttons) and pan (drag);
   search; filter by flow and relation (each relation is a strategy of the concept); click an agent for what it is, its
   function, skills, actions (tools, read from the code) and relations. */

type Node = Rec & { id: string; nama: string; jenis: string; induk?: string | null; lini?: string; alur?: string[] };
type Edge = { dari: string; ke: string; jenis: string; label: string; alur: string[] };
type Net = {
  simpul: Node[]; hubungan: Edge[]; jenis_simpul: Record<string, string>; jenis_hubungan: Record<string, { label: string; strategi: string }>;
  alur: Record<string, string>; konsep: { konsep: string; di_aip: string }[]; ringkasan: Rec;
};
type P = { x: number; y: number; r: number };
type Group = { key: string; label: string; y: number };
type Box = { x: number; y: number; w: number; h: number; lead: string; groups: Group[] };
type Layout = { pos: Record<string, P>; boxes: Box[]; bus: { x: number; y: number; w: number; h: number }; rail: number; modeY: number;
  pill: Record<string, { w: number; h: number }> };
type Skill = Rec & { key: string; nama: string; untuk: string; langkah: string[]; pelajaran: string[]; wajib: string[][] };

const ORCH = "#9d8cff", VALID = "#e5689b", HUB = "#29a383", SERVICE = "#3987e5", MACHINE = "#8f99a8", HUMAN = "#f6f7f9";
const REL_COLOR: Record<string, string> = {
  memimpin: "#7d8796", membentuk: ORCH, memeriksa: "#f0b14c", menantang: "#e5484d", berbagi_state: HUB, mengumpankan: "#5fc4a8", memakai: SERVICE, menyerahkan: "#d3d8de",
  mendeteksi: "#fb923c", menyetel: "#c9c0ff",
};
const DASH: Record<string, string | undefined> = { membentuk: "6 4", menantang: "4 3", menyerahkan: "2 4", menyetel: "3 3" };
const KIND_LABEL: Record<string, string> = {
  pimpinan: "Orkestrator", agen_domain: "Agen domain", validator: "Validator", sub_agen: "Sub-agen teknik ML", agen_kecil: "Agen kecil firma",
  dinamis: "Agen kecil per pertanyaan", state: "Shared state", mesin: "Mesin / validator kode", layanan: "Layanan /verify", manusia: "Manusia",
  modus: "Modus fraud",
};
const WRITE_COLOR: Record<string, string> = { catatan: "#5fc4a8", usulan: "#f0b14c", putusan: VALID, rencana: ORCH, "serah-terima": "#8abbff", pelajaran: ORCH, keputusan: HUMAN };
// the workers left to right as they read: who and where, the patient's path, the clinic, the claims and the box, the model, the data
const LEAD_ORDER = ["faskes_wilayah", "peserta", "klinis", "klaim_fraud", "machine_learning", "data"];
const GROUP_ORDER = ["wilayah", "peer", "modus", "kasus", "ml", "qa", "red_team"];
const GROUP_LABEL: Record<string, string> = { wilayah: "Analis wilayah", peer: "Analis peer kelas", modus: "Spesialis modus", kasus: "Penyidik kasus",
  ml: "Sub-agen teknik", qa: "Reviewer QA", red_team: "Red team" };
// what each kind of small agent is for, in a line under its group (the user, 2026-10-23: "ini fungsinya buat apa sih?")
const GROUP_DESC: Record<string, string> = {
  wilayah: "satu per provinsi: menelusuri indikasi lintas modus, menandai dengan bukti",
  peer: "faskes yang menyimpang dari kelasnya pada beberapa ukuran sekaligus",
  modus: "satu per modus Permenkes 16/2019 yang ada sinyalnya di data",
  kasus: "satu peran dinamis: instans per faskes di antrean box (A → Z), sebanyak kapasitas",
  ml: "satu per teknik: validasi silang; daftar teratas ke konsensus",
  qa: "satu per sintesis agen domain: menghitung ulang angkanya",
  red_team: "satu peran dinamis: instans per indikasi terkuat, membela penjelasan wajarnya",
};
const CELL = 34, PAD = 14, CAP = 34, GAP = 34;
// what the data can show of a fraud mode (aip/semantik.py MODUS_PERMENKES): fill, stroke, caption
const DETEKSI: Record<string, { fill: string; stroke: string; label: string }> = {
  terdeteksi: { fill: "#10291f", stroke: "#29a383", label: "terdeteksi" }, sinyal: { fill: "#2e2510", stroke: "#f0b14c", label: "sinyal lemah" },
  aturan: { fill: "#1d2430", stroke: "#8f99a8", label: "aturan, 0 temuan" }, "tidak ada data": { fill: "#17191d", stroke: "#4b5563", label: "tidak ada data" },
};
const Y = { human: 40, top: 160, machines: 270, bus: 350, rail: 432, lead: 480, box: 545 };

const groupOf = (n: Node) => (String(n.id).startsWith("redteam_") || n.id === "red_team" ? "red_team" : n.lini ?? "lain");

function short(n: Node): string {
  if (n.jenis === "agen_kecil" || n.jenis === "sub_agen") {
    if (n.lini === "wilayah") return String(n.cakupan || n.nama).replace(/\s*\(.*\)$/, "");
    if (n.lini === "ml") return n.nama.replace("Sub-agen ", "");
    if (n.dinamis) return String(n.pendek ?? n.nama);
    if (n.lini === "kasus") return n.pendek ? String(n.pendek) : n.nama.replace("Penyidik Kasus", "Kasus");
    if (n.lini === "modus") return n.nama.replace("Spesialis ", "");
    if (n.lini === "peer") return "Peer kelas";
    return n.nama.replace("Reviewer QA · ", "QA ").replace("Red Team", "Red team");
  }
  return n.jenis === "agen_domain" ? n.nama.replace(" (BPJS)", "").replace(/^Agen /, "") : n.nama;
}

function layout(net: Net): Layout {
  const pos: Record<string, P> = {};
  const boxes: Box[] = [];
  const domain = net.simpul.filter((n) => n.jenis === "agen_domain")
    .sort((a, b) => (LEAD_ORDER.indexOf(a.id) + 1 || 99) - (LEAD_ORDER.indexOf(b.id) + 1 || 99));
  const validator = net.simpul.find((n) => n.jenis === "validator");
  const members = new Map<string, Node[]>();
  net.simpul.filter((n) => (n.jenis === "agen_kecil" || n.jenis === "sub_agen") && n.induk)
    .forEach((m) => members.set(m.induk!, [...(members.get(m.induk!) ?? []), m]));
  let x = 0, workersRight = 0;
  for (const lead of [...domain, ...(validator ? [validator] : [])]) {
    if (lead === validator) x += 70;  // the validators' column stands apart from the workers'
    const list = members.get(lead.id) ?? [];
    const cols = list.length >= 12 ? 6 : list.length >= 7 ? 5 : Math.max(1, Math.min(4, list.length));
    const w = Math.max(170, cols * CELL + 2 * PAD);
    const cx = x + w / 2;
    pos[lead.id] = { x: cx, y: lead === validator ? Y.top : Y.lead, r: lead === validator ? 26 : 22 };
    if (list.length) {
      const groups: Group[] = [];
      let y = Y.box + PAD;
      for (const g of GROUP_ORDER.filter((k) => list.some((m) => groupOf(m) === k))) {
        const items = list.filter((m) => groupOf(m) === g).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        groups.push({ key: g, label: `${GROUP_LABEL[g] ?? g} (${items.length})`, y });
        y += CAP;
        items.forEach((m, j) => {
          const row = Math.floor(j / cols), col = j % cols, inRow = Math.min(cols, items.length - row * cols);
          pos[m.id] = { x: cx + (col - (inRow - 1) / 2) * CELL, y: y + row * CELL + CELL / 2, r: m.dinamis ? 13 : 9 };
        });
        y += Math.ceil(items.length / cols) * CELL + 8;
      }
      boxes.push({ x, y: Y.box, w, h: y - Y.box + PAD - 8, lead: lead.id, groups });
    }
    x += w + GAP;
    if (lead !== validator) workersRight = x - GAP;
  }
  const right = x - GAP;
  const orchX = workersRight / 2;
  pos.orkestrator = { x: orchX, y: Y.top, r: 32 };
  pos.manusia = { x: orchX, y: Y.human, r: 20 };
  pos.penyusun_layar = { x: orchX - 210, y: Y.top, r: 13 };
  pos.agen_kecil_pertanyaan = { x: orchX - 400, y: Y.top, r: 18 };
  pos.penyetel_aturan = { x: orchX - 360, y: Y.human + 20, r: 13 };  // offline: tunes the orchestrator's rules, hands versions to people
  if (validator) pos.validator_scrutiny = { x: (orchX + pos[validator.id].x) / 2, y: Y.top, r: 14 };
  // the machines above the bus they write to, each over the column it works for
  const at = (id: string, dx = 0) => (pos[id] ? pos[id].x + dx : orchX);
  pos.penanda_otomatis = { x: at("klinis"), y: Y.machines, r: 13 };
  pos.karantina = { x: at("klaim_fraud", -60), y: Y.machines, r: 13 };
  pos.konsensus_ml = { x: at("machine_learning"), y: Y.machines, r: 13 };
  pos.sinkron_nexus = { x: at("data"), y: Y.machines, r: 13 };
  pos.pipeline_produksi = { x: right + 110, y: Y.machines, r: 14 };
  pos.layanan_verify = { x: right + 110, y: Y.lead, r: 17 };
  const xs = Object.values(pos).map((p) => p.x);
  const bus = { x: Math.min(...xs) - 50, y: Y.bus - 22, w: Math.max(...xs) - Math.min(...xs) + 100, h: 44 };
  pos.shared_state = { x: bus.x + bus.w / 2, y: Y.bus, r: 22 };
  // the fraud modes under the workers: the focus four as cards under the columns that detect them, the rest in rows
  const bottom = Math.max(...boxes.map((b) => b.y + b.h), Y.box + 60);
  const modeY = bottom + 120;
  const pill: Record<string, { w: number; h: number }> = {};
  const modes = net.simpul.filter((n) => n.jenis === "modus");
  const want = (m: Node) => {
    const xs_ = net.hubungan.filter((e) => e.ke === m.id && e.jenis === "mendeteksi" && e.dari !== "penanda_otomatis" && pos[e.dari]).map((e) => pos[e.dari].x);
    return xs_.length ? xs_.reduce((a, b) => a + b, 0) / xs_.length : orchX;
  };
  const focus = modes.filter((m) => m.fokus).map((m) => ({ m, x: want(m) })).sort((a, b) => a.x - b.x);
  for (let i = 1; i < focus.length; i++) focus[i].x = Math.max(focus[i].x, focus[i - 1].x + 230);  // never overlapping
  focus.forEach(({ m, x }) => { pos[m.id] = { x, y: modeY, r: 23 }; pill[m.id] = { w: 210, h: 48 }; });
  const order = ["terdeteksi", "sinyal", "aturan", "tidak ada data"];
  const rest = modes.filter((m) => !m.fokus).sort((a, b) => order.indexOf(String(a.deteksi)) - order.indexOf(String(b.deteksi)) || Number(a.no) - Number(b.no));
  const perRow = Math.max(4, Math.floor((right + 40) / 150));
  rest.forEach((m, i) => {
    const row = Math.floor(i / perRow), col = i % perRow, inRow = Math.min(perRow, rest.length - row * perRow);
    pos[m.id] = { x: orchX + (col - (inRow - 1) / 2) * 150, y: modeY + 95 + row * 56, r: 16 };
    pill[m.id] = { w: 138, h: 32 };
  });
  let k = 0;
  net.simpul.forEach((n) => {  // anything new the endpoint adds: below everything, never stacked
    if (!pos[n.id]) pos[n.id] = { x: 40 + 60 * k++, y: modeY + 300, r: 10 };
  });
  return { pos, boxes, bus, rail: Y.rail, modeY, pill };
}

function colorsOf(net: Net): Record<string, string> {
  const out: Record<string, string> = { orkestrator: ORCH, validator: VALID, shared_state: HUB, manusia: HUMAN, agen_kecil_pertanyaan: ORCH };
  net.simpul.filter((n) => n.jenis === "agen_domain").forEach((n, i) => { out[n.id] = AGENT_COLOR[i % AGENT_COLOR.length]; });
  net.simpul.forEach((n) => {
    if (out[n.id]) return;
    if (n.jenis === "mesin") out[n.id] = n.id === "validator_scrutiny" ? VALID : MACHINE;
    else if (n.jenis === "layanan") out[n.id] = SERVICE;
    else out[n.id] = (n.induk && out[n.induk]) || MACHINE;
  });
  return out;
}

// how an edge is drawn: the delegation tree as elbows, a link to the shared state as a stub onto the bus, the rest curved
function route(e: Edge, L: Layout, byId: Map<string, Node>): { d: string; mx: number; my: number; arrow: boolean } {
  const a = L.pos[e.dari], b = L.pos[e.ke];
  if (e.ke === "shared_state" || e.dari === "shared_state") {
    const n = e.ke === "shared_state" ? a : b;
    const off = ["agen_domain", "pimpinan", "validator"].includes(byId.get(e.ke === "shared_state" ? e.dari : e.ke)?.jenis ?? "") ? 14 : 0;
    const top = n.y < L.bus.y;
    const ny = top ? n.y + n.r : n.y - n.r, by = top ? L.bus.y : L.bus.y + L.bus.h;
    const [y0, y1] = e.ke === "shared_state" ? [ny, by] : [by, ny];
    return { d: `M${n.x + off},${y0} L${n.x + off},${y1}`, mx: n.x + off, my: (y0 + y1) / 2, arrow: true };
  }
  if (e.jenis === "memimpin" && e.dari === "orkestrator" && byId.get(e.ke)?.jenis === "agen_domain") {
    return { d: `M${a.x},${a.y + a.r} L${a.x},${L.rail} L${b.x},${L.rail} L${b.x},${b.y - b.r - 4}`, mx: b.x, my: L.rail, arrow: true };
  }
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const s = { x: a.x + ux * a.r, y: a.y + uy * a.r }, t = { x: b.x - ux * (b.r + 4), y: b.y - uy * (b.r + 4) };
  const off = Math.min(80, len * 0.16);
  const cx = (s.x + t.x) / 2 - uy * off, cy = (s.y + t.y) / 2 + ux * off;
  return { d: `M${s.x},${s.y} Q${cx},${cy} ${t.x},${t.y}`, mx: 0.25 * s.x + 0.5 * cx + 0.25 * t.x, my: 0.25 * s.y + 0.5 * cy + 0.25 * t.y, arrow: true };
}

// the relations always drawn: the delegation tree, the bus, the creator–verifier pair on top, the short machine links
function main(e: Edge, byId: Map<string, Node>): boolean {
  const a = byId.get(e.dari), b = byId.get(e.ke);
  if (!a || !b) return false;
  if (e.jenis === "memimpin") return a.jenis === "pimpinan" && b.jenis === "agen_domain";
  if (e.jenis === "berbagi_state") return true;
  if (e.jenis === "mengumpankan") return a.id === "shared_state" || b.id === "shared_state" || (a.id === "pipeline_produksi" && b.id === "layanan_verify")
    || (a.id === "orkestrator" && b.id === "penyusun_layar");
  if (e.jenis === "mendeteksi") return !!b.fokus && (a.jenis === "agen_kecil" || a.jenis === "sub_agen");
  if (e.jenis === "memeriksa") return b.jenis === "pimpinan";
  if (e.jenis === "membentuk" || e.jenis === "menyetel") return true;
  if (e.jenis === "menyerahkan") return a.jenis === "pimpinan";
  return false;
}

export function GrafAgen({ full = false }: { full?: boolean }) {
  const [net, setNet] = useState<Net | null>(null);
  const [skills, setSkills] = useState<Record<string, Skill>>({});
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // where the pointer is over the graph, for the hover card (the agent, its kind, its function: for showing the network)
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const enter = (id: string) => (e: React.PointerEvent) => {
    const r = stage.current?.getBoundingClientRect();
    setHover(id);
    setAt({ x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0), w: r?.width ?? 0 });
  };
  const [flows, setFlows] = useState<Set<string>>(new Set(["tanya_jawab", "firma", "produksi"]));
  const [rels, setRels] = useState<Set<string>>(new Set(Object.keys(REL_COLOR)));
  const [all, setAll] = useState(false);
  const [legend, setLegend] = useState(true);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"" | "konsep" | "gabung">("");
  const [view, setView] = useState({ k: 0.6, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/aip/jaringan`, { cache: "no-store" }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).detail ?? r.statusText}`);
      setNet(await r.json());
    }).catch((e) => setErr((e as Error).message));
    fetch(`${API_URL}/api/aip/skills`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j) setSkills(Object.fromEntries((j.skills as Skill[]).map((s) => [s.key, s])));
    }).catch(() => {});
  }, []);

  const L = useMemo<Layout | null>(() => (net ? layout(net) : null), [net]);
  const color = useMemo(() => (net ? colorsOf(net) : {}), [net]);
  const byId = useMemo(() => new Map((net?.simpul ?? []).map((n) => [n.id, n])), [net]);
  const nodes = useMemo(() => (net?.simpul ?? []).filter((n) => (n.alur ?? []).some((f) => flows.has(f))), [net, flows]);
  const shown = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const edges = useMemo(() => (net?.hubungan ?? []).filter((e) => rels.has(e.jenis) && e.alur.some((f) => flows.has(f)) && shown.has(e.dari) && shown.has(e.ke)),
    [net, rels, flows, shown]);
  const focus = sel ?? hover;
  // the agent in focus, its neighbours; a lead in focus brings its box of small agents along
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    edges.forEach((e) => { if (e.dari === focus) s.add(e.ke); if (e.ke === focus) s.add(e.dari); });
    return s;
  }, [focus, edges]);

  const fit = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !L) return;
    const ps = nodes.map((n) => ({ ...L.pos[n.id], r: Math.max(L.pos[n.id]?.r ?? 0, (L.pill[n.id]?.w ?? 0) / 2) })).filter((p) => p.x != null);
    // room on the left for the names of the tiers
    const minx = Math.min(L.bus.x, ...ps.map((p) => p.x - p.r)) - 190, maxx = Math.max(L.bus.x + L.bus.w, ...ps.map((p) => p.x + p.r)) + 40;
    const miny = Math.min(...ps.map((p) => p.y - p.r)) - 20, maxy = Math.max(...L.boxes.map((b) => b.y + b.h), ...ps.map((p) => p.y + p.r)) + 30;
    const { width, height } = svg.getBoundingClientRect();
    const room = height - (legend ? 96 : 30);  // the legend keeps the bottom of the canvas
    const k = Math.max(0.2, Math.min(width / (maxx - minx), room / (maxy - miny)));
    setView({ k, x: width / 2 - (k * (minx + maxx)) / 2, y: room / 2 - (k * (miny + maxy)) / 2 });
  }, [L, nodes, legend]);
  useEffect(() => { if (L) requestAnimationFrame(fit); }, [L]);  // eslint-disable-line react-hooks/exhaustive-deps

  // the wheel zooms around the pointer (a native listener: React's wheel handler cannot stop the page from scrolling)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      setView((v) => {
        const k = Math.max(0.2, Math.min(5, v.k * Math.pow(1.0015, -e.deltaY)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [L]);
  const zoom = (f: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    setView((v) => {
      const k = Math.max(0.2, Math.min(5, v.k * f));
      return { k, x: width / 2 - ((width / 2 - v.x) * k) / v.k, y: height / 2 - ((height / 2 - v.y) * k) / v.k };
    });
  };
  const centerOn = (id: string) => {
    const svg = svgRef.current, p = L?.pos[id];
    if (!svg || !p) return;
    const { width, height } = svg.getBoundingClientRect();
    setView((v) => {
      const k = Math.max(v.k, 1.4);
      return { k, x: (width - 380) / 2 - k * p.x, y: height / 2 - k * p.y };  // the detail panel takes the right 380 px
    });
  };
  const pick = (id: string, center = false) => { setSel(id); if (center) centerOn(id); };

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !net) return [];
    return net.simpul.filter((n) => `${n.nama} ${n.cakupan ?? ""} ${n.id}`.toLowerCase().includes(q)).slice(0, 12);
  }, [query, net]);

  if (err) return <div className="flex flex-1 items-center justify-center text-[12px] text-red-300">Graf agen tidak termuat: {err}</div>;
  if (!net || !L) return <div className="flex flex-1 items-center justify-center text-[12px] text-[#8f99a8]">Memuat graf semua agen…</div>;
  const r = net.ringkasan;
  const selected = sel ? byId.get(sel) : undefined;
  const u = 1 / view.k;  // one screen pixel in graph units: labels keep their size at any zoom
  const memberLabels = view.k >= 1.45;
  const inFocus = (e: Edge) => !!focus && (e.dari === focus || e.ke === focus);
  // the big labels where they fit — under the node, else over it, else on hover or selection only: they keep their screen
  // size while a zoomed-out view draws the nodes together ("Agen kecil per pertanyaan" ran into "Penyusun layar", 2026-10-23)
  const labelAt: Record<string, "below" | "above" | "none"> = {};
  {
    const taken: number[][] = [];
    const rank: Record<string, number> = { pimpinan: 0, manusia: 1, validator: 2, agen_domain: 3 };
    const free = (b: number[]) => !taken.some((t) => b[0] < t[2] && t[0] < b[2] && b[1] < t[3] && t[1] < b[3]);
    for (const n of nodes.filter((x) => L.pos[x.id] && !["agen_kecil", "sub_agen", "modus", "state"].includes(x.jenis))
      .sort((a, b) => (rank[a.jenis] ?? 4) - (rank[b.jenis] ?? 4))) {
      const p = L.pos[n.id], fs = (n.jenis === "pimpinan" ? 13 : 11.5) * u, w = short(n).length * fs * 0.6, h = fs * 1.3;
      const below = [p.x - w / 2, p.y + p.r + 6, p.x + w / 2, p.y + p.r + 6 + h];
      const above = [p.x - w / 2, p.y - p.r - 6 * u - h, p.x + w / 2, p.y - p.r - 6 * u];
      const at = free(below) ? "below" : free(above) ? "above" : "none";
      labelAt[n.id] = at;
      if (at !== "none") taken.push(at === "below" ? below : above);
    }
  }

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col bg-[#14181d] text-[12px] text-[#d3d8de] ${full ? "h-screen" : ""}`}>
      {/* the toolbar: what the graph holds, search, flows */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/5 bg-[#1c2127] px-3 py-2">
        <div className="mr-1">
          <p className="text-[13px] font-semibold text-white">Graf semua agen AIP JKN</p>
          <p className="text-[10.5px] text-[#8f99a8]">
            {r.agen} agen ({r.sebelum?.total} − {r.dihemat} digabung + {r.jumlah_ditambah ?? 0} ditambah) · {r.modus?.total ?? 0} modus fraud, {(r.modus?.fokus ?? []).length} fokus ·
            {r.skill} skill · {r.pelajaran_aktif} pelajaran aktif ·
            perencanaan {modelName(r.model_per_peran?.perencanaan)} · validasi {modelName(r.model_per_peran?.validasi)}
          </p>
        </div>
        <div className="relative">
          <div className="flex items-center gap-1 rounded border border-white/15 bg-[#111418] px-2 py-1">
            <Icon name="search" className="h-3.5 w-3.5 text-[#8f99a8]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari agen, provinsi, modus, teknik…" aria-label="Cari agen"
              className="w-[210px] bg-transparent text-[11.5px] outline-none placeholder:text-[#6b7480]" />
          </div>
          {hits.length > 0 && (
            <div className="absolute left-0 top-full z-30 mt-1 w-[320px] overflow-hidden rounded border border-white/15 bg-[#1c2127] shadow-xl">
              {hits.map((n) => (
                <button key={n.id} onClick={() => { pick(n.id, true); setQuery(""); }} className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-white/10">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color[n.id] }} />
                  <span className="truncate text-[#e5e8eb]">{n.nama}</span><span className="ml-auto shrink-0 text-[10px] text-[#8f99a8]">{KIND_LABEL[n.jenis]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Alur">
          {Object.entries(net.alur).map(([k, label]) => (
            <button key={k} onClick={() => setFlows((s) => { const n = new Set(s); if (n.has(k)) { if (n.size > 1) n.delete(k); } else n.add(k); return n; })}
              className={`rounded border px-2 py-0.5 text-[11px] ${flows.has(k) ? "border-[#9d8cff]/60 bg-[#9d8cff]/15 text-white" : "border-white/10 text-[#8f99a8]"}`} title={label}>
              {label.split(" (")[0]}
            </button>
          ))}
          <button onClick={() => setAll(!all)} title="Tampilkan semua hubungan sekaligus, bukan hanya alur utama"
            className={`ml-1 rounded border px-2 py-0.5 text-[11px] ${all ? "border-[#f0b14c]/60 bg-[#f0b14c]/15 text-white" : "border-white/10 text-[#8f99a8]"}`}>Semua hubungan</button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setPanel(panel === "konsep" ? "" : "konsep")} className={`rounded border px-2 py-0.5 text-[11px] ${panel === "konsep" ? "border-white/40 bg-white/10 text-white" : "border-white/15 hover:bg-white/5"}`}>Konsep orkestrasi</button>
          <button onClick={() => setPanel(panel === "gabung" ? "" : "gabung")} className={`rounded border px-2 py-0.5 text-[11px] ${panel === "gabung" ? "border-white/40 bg-white/10 text-white" : "border-white/15 hover:bg-white/5"}`}>Agen yang digabung</button>
          {!full && <a href="/aip-jkn/graf" target="_blank" rel="noreferrer" title="Buka graf di halaman sendiri" className="rounded border border-white/15 p-1 hover:bg-white/5"><Icon name="external" className="h-3.5 w-3.5" /></a>}
        </div>
      </div>

      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
        <svg ref={svgRef} className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing" role="img" aria-label="Graf semua agen AIP JKN dan hubungannya"
          onPointerDown={(e) => { drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false }; }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (!d.moved && Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 4) { d.moved = true; setHover(null); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); }
            if (d.moved) setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
          }}
          onPointerUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved && (e.target as Element).tagName === "svg") setSel(null); }}>
          <defs>
            {Object.entries(REL_COLOR).map(([k, c]) => (
              <marker key={k} id={`gr-arr-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={c} />
              </marker>
            ))}
            <radialGradient id="gr-orch"><stop offset="0%" stopColor="#c9c0ff" /><stop offset="100%" stopColor={ORCH} /></radialGradient>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {/* the tiers, named on the left */}
            {([["Manusia", Y.human], ["Orkestrator & validator", Y.top], ["Mesin", Y.machines], ["Shared state", Y.bus], ["Pekerja: agen domain", Y.lead], ["Agen kecil", Y.box + 40], ["Modus fraud (Permenkes 16/2019)", L.modeY]] as const).map(([t, y]) => (
              <text key={t} x={L.bus.x - 14} y={y + 4} textAnchor="end" fontSize={10 * u} fill="#5f6b7c" fontWeight={600}>{t}</text>
            ))}
            {/* the shared state: the bus everyone reads and writes */}
            <g className="cursor-pointer" onPointerDown={(e) => e.stopPropagation()} onClick={() => pick("shared_state")}
              onPointerEnter={enter("shared_state")} onPointerMove={enter("shared_state")} onPointerLeave={() => setHover((h) => (h === "shared_state" ? null : h))}
              opacity={near && !near.has("shared_state") ? 0.35 : 1}>
              <rect x={L.bus.x} y={L.bus.y} width={L.bus.w} height={L.bus.h} rx={L.bus.h / 2} fill="#10291f" stroke={HUB} strokeWidth={sel === "shared_state" ? 3 : 1.6} />
              <text x={L.bus.x + 24} y={L.bus.y + L.bus.h / 2 + 5 * u} fontSize={13 * u} fontWeight={700} fill="#e5e8eb">Shared state</text>
              <text x={L.bus.x + 24 + 110 * u} y={L.bus.y + L.bus.h / 2 + 4 * u} fontSize={10.5 * u} fill="#7ee2c0">
                {((byId.get("shared_state")?.isi ?? []) as string[]).join("  ·  ")}
              </text>
            </g>
            {/* the boxes of small agents under their lead */}
            {L.boxes.map((b) => {
              const lead = L.pos[b.lead], c = color[b.lead];
              const dim = near && !near.has(b.lead) && !(L.boxes.find((x) => x.lead === b.lead) && nodes.some((m) => m.induk === b.lead && near.has(m.id)));
              return (
                <g key={b.lead} opacity={dim ? 0.3 : 1}>
                  <line x1={lead.x} y1={lead.y + lead.r} x2={lead.x} y2={b.y} stroke={c} strokeOpacity={0.55} strokeWidth={1.4 * Math.min(u, 1.6)} />
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} fill="#1a2028" stroke={c} strokeOpacity={0.45} />
                  {b.groups.map((g) => (
                    <g key={g.key}>
                      <text x={b.x + 10} y={g.y + 11} fontSize={Math.min(10 * u, 13)} fontWeight={600} fill="#d3d8de">{g.label}</text>
                      <text x={b.x + 10} y={g.y + 11 + Math.min(10 * u, 13) + 2} fontSize={Math.min(8.5 * u, 10.5)} fill="#8f99a8">
                        {(GROUP_DESC[g.key] ?? "").slice(0, Math.max(24, Math.floor(b.w / Math.min(4.6 * u, 5.6))))}
                      </text>
                    </g>
                  ))}
                </g>
              );
            })}
            {/* relations: the main flow always; the rest in focus or with "Semua hubungan" */}
            {edges.map((e, i) => {
              const isMain = main(e, byId);
              if (!isMain && !all && !inFocus(e)) return null;
              // a lead's small agents are its box: a line to one of them only when that one is in focus
              if (e.jenis === "memimpin" && byId.get(e.ke)?.induk === e.dari && L.boxes.some((b) => b.lead === e.dari) && focus !== e.ke) return null;
              const { d, arrow } = route(e, L, byId);
              const on = !near || inFocus(e);
              return (
                <path key={i} d={d} fill="none" stroke={REL_COLOR[e.jenis]} strokeWidth={(isMain ? 1.6 : 1.3) * Math.min(u, 1.6)} strokeDasharray={DASH[e.jenis]}
                  strokeOpacity={on ? (near ? 0.95 : isMain ? 0.7 : 0.45) : 0.08} strokeLinejoin="round" markerEnd={arrow ? `url(#gr-arr-${e.jenis})` : undefined} />
              );
            })}
            {nodes.map((n) => {
              const p = L.pos[n.id];
              if (!p || n.jenis === "state") return null;
              if (n.jenis === "modus") {
                const pl = L.pill[n.id] ?? { w: 130, h: 30 }, st = DETEKSI[String(n.deteksi)] ?? DETEKSI["tidak ada data"];
                return (
                  <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={near && !near.has(n.id) ? 0.25 : 1} className="cursor-pointer"
                    onPointerDown={(e) => e.stopPropagation()} onClick={() => pick(n.id)} onDoubleClick={() => pick(n.id, true)}
                    onPointerEnter={enter(n.id)} onPointerMove={enter(n.id)} onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}>
                    <rect x={-pl.w / 2} y={-pl.h / 2} width={pl.w} height={pl.h} rx={pl.h / 2} fill={st.fill} stroke={sel === n.id ? "#ffffff" : st.stroke}
                      strokeWidth={n.fokus ? 2.6 : 1.4} strokeDasharray={n.deteksi === "tidak ada data" ? "4 3" : undefined} />
                    {n.fokus && <text y={-pl.h / 2 - 6} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fb923c" letterSpacing={1}>FOKUS</text>}
                    <text y={n.fokus ? -2 : 4} textAnchor="middle" fontSize={n.fokus ? 14 : 11} fontWeight={n.fokus ? 700 : 600} fill="#f6f7f9">{String(n.pendek)}</text>
                    {n.fokus && <text y={14} textAnchor="middle" fontSize={9.5} fill={st.stroke}>{st.label}</text>}
                  </g>
                );
              }
              const c = color[n.id];
              const dim = near && !near.has(n.id);
              const big = !["agen_kecil", "sub_agen"].includes(n.jenis);
              const isSel = sel === n.id;
              const lab = big || memberLabels || isSel || focus === n.id;
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.22 : 1} className="cursor-pointer"
                  onPointerDown={(e) => e.stopPropagation()} onClick={() => pick(n.id)} onDoubleClick={() => pick(n.id, true)}
                  onPointerEnter={enter(n.id)} onPointerMove={enter(n.id)} onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}>
                  <circle r={p.r + 7} fill="transparent" />
                  {n.jenis === "mesin" ? (
                    <rect x={-p.r} y={-p.r} width={p.r * 2} height={p.r * 2} transform="rotate(45)" fill="#232a33" stroke={c} strokeWidth={isSel ? 3 : 1.8} />
                  ) : n.jenis === "layanan" ? (
                    <rect x={-p.r} y={-p.r} width={p.r * 2} height={p.r * 2} rx={5} fill="#16304f" stroke={c} strokeWidth={isSel ? 3 : 1.8} />
                  ) : n.jenis === "manusia" ? (
                    <>
                      <circle r={p.r} fill="#2a3038" stroke={c} strokeWidth={isSel ? 3 : 1.8} />
                      <circle cy={-5} r={5} fill={c} /><path d="M-9,11 Q0,-1 9,11 Z" fill={c} />
                    </>
                  ) : n.jenis === "dinamis" ? (
                    <circle r={p.r} fill={`${ORCH}1f`} stroke={ORCH} strokeWidth={isSel ? 3 : 1.6} strokeDasharray="5 4" />
                  ) : (
                    <>
                      {n.jenis === "pimpinan" && <circle r={p.r + 9} fill={ORCH} fillOpacity={0.12} />}
                      <circle r={p.r} fill={n.jenis === "pimpinan" ? "url(#gr-orch)" : c} fillOpacity={n.dinamis ? 0.25 : big ? 1 : 0.9}
                        stroke={isSel ? "#ffffff" : n.dinamis ? c : "#14181d"} strokeWidth={isSel ? 3 : n.dinamis ? 2 : 1.5} strokeDasharray={n.dinamis ? "4 3" : undefined} />
                      {n.dinamis && <text y={4} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">×{n.kapasitas}</text>}
                      {n.jenis === "pimpinan" && <text y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">AIP</text>}
                      {(n.jenis === "agen_domain" || n.jenis === "validator") && Number(n.memimpin ?? 0) > 0 && <text y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">{n.memimpin}</text>}
                    </>
                  )}
                  {lab && (big ? (
                    (labelAt[n.id] !== "none" || isSel || focus === n.id) &&
                    <text y={labelAt[n.id] === "above" ? -(p.r + 6 * u) : p.r + 6 + 12 * u} textAnchor="middle" fontSize={(n.jenis === "pimpinan" ? 13 : 11.5) * u} fontWeight={600} fill="#f6f7f9" stroke="#14181d" strokeWidth={3 * u} paintOrder="stroke">{short(n)}</text>
                  ) : (
                    <text y={p.r + 3 + 9 * u} textAnchor="middle" fontSize={8.5 * u} fill="#d3d8de" stroke="#14181d" strokeWidth={2.5 * u} paintOrder="stroke">
                      {focus === n.id || isSel ? short(n) : short(n).slice(0, 13)}
                    </text>
                  ))}
                </g>
              );
            })}
            {/* the relations of the agent in focus, labelled */}
            {focus && edges.filter((e) => inFocus(e) && !(e.jenis === "memimpin" && byId.get(e.ke)?.induk === e.dari)).slice(0, 30).map((e, i) => {
              const { mx, my } = route(e, L, byId);
              return <text key={`l${i}`} x={mx} y={my - 3 * u} textAnchor="middle" fontSize={9.5 * u} fill={REL_COLOR[e.jenis]} stroke="#14181d" strokeWidth={3 * u} paintOrder="stroke">{e.label.slice(0, 52)}</text>;
            })}
          </g>
        </svg>
        {hover && at && (() => {
          const n = byId.get(hover);
          if (!n) return null;
          const wide = at.w;
          const st = n.jenis === "modus" ? DETEKSI[String(n.deteksi)] ?? DETEKSI["tidak ada data"] : null;
          return (
            <div className="pointer-events-none absolute z-30 w-[320px] rounded-lg border border-white/15 bg-[#111418] px-3 py-2 text-[11.5px] shadow-2xl"
              style={{ top: at.y + 14, ...(at.x > wide - 340 ? { right: wide - at.x + 14 } : { left: at.x + 14 }) }}>
              <p className="font-semibold leading-snug text-white">{n.id === "shared_state" ? "Shared state" : n.nama}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[#abb3bf]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: st?.stroke ?? color[n.id] ?? HUB }} />
                {KIND_LABEL[n.jenis] ?? n.jenis}{st ? ` · ${st.label}` : ""}{n.cakupan ? ` · ${String(n.cakupan)}` : ""}
              </p>
              {n.fungsi && <p className="mt-1.5 line-clamp-5 leading-snug text-[#e5e8eb]">{String(n.fungsi)}</p>}
              {n.model && <p className="mt-1.5 border-t border-white/[.06] pt-1.5 text-[10.5px] text-[#abb3bf]">{String(n.model).split("/").pop()?.replace(/-maas$/, "")}</p>}
            </div>
          );
        })()}

        {/* zoom */}
        <div className="absolute top-3 flex flex-col gap-1" style={{ right: selected ? 392 : 12 }}>
          <button onClick={() => zoom(1.25)} title="Perbesar" aria-label="Perbesar" className="rounded border border-white/15 bg-[#1c2127] p-1.5 hover:bg-white/10"><Icon name="plus" className="h-3.5 w-3.5" /></button>
          <button onClick={() => zoom(0.8)} title="Perkecil" aria-label="Perkecil" className="rounded border border-white/15 bg-[#1c2127] p-1.5 hover:bg-white/10"><Icon name="minus" className="h-3.5 w-3.5" /></button>
          <button onClick={() => fit()} title="Pas di layar" aria-label="Pas di layar" className="rounded border border-white/15 bg-[#1c2127] p-1.5 hover:bg-white/10"><Icon name="fit" className="h-3.5 w-3.5" /></button>
        </div>

        {/* legend: kinds of node; relations are toggles (each a strategy of the orchestration concept) */}
        <div className="absolute bottom-3 left-3 max-w-[calc(100%-420px)] rounded border border-white/10 bg-[#1c2127]/95 px-2 py-1.5 text-[10.5px]" style={{ maxWidth: selected ? "calc(100% - 420px)" : "calc(100% - 80px)" }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button onClick={() => setLegend(!legend)} className="font-semibold text-[#e5e8eb]">Legenda {legend ? "▾" : "▸"}</button>
            {legend && [["pimpinan", ORCH], ["agen_domain", AGENT_COLOR[1]], ["validator", VALID], ["agen_kecil", "#6b7685"], ["state", HUB], ["mesin", MACHINE], ["layanan", SERVICE], ["manusia", HUMAN], ["modus", "#fb923c"]].map(([k, c]) => (
              <span key={k} className="flex items-center gap-1" title={net.jenis_simpul[k]}>
                <span className={k === "mesin" ? "h-2 w-2 rotate-45" : k === "state" || k === "layanan" ? "h-2 w-2.5 rounded-sm" : "h-2 w-2 rounded-full"} style={{ background: c }} />{KIND_LABEL[k]}
              </span>
            ))}
          </div>
          {legend && (
            <>
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(net.jenis_hubungan).map(([k, v]) => (
                  <button key={k} onClick={() => setRels((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} title={`${v.label} — strategi: ${v.strategi}`}
                    className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${rels.has(k) ? "border-white/15 text-[#d3d8de]" : "border-transparent text-[#5f6b7c] line-through"}`}>
                    <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke={REL_COLOR[k]} strokeWidth="2" strokeDasharray={DASH[k]} /></svg>{k.replace("_", " ")}
                    <span className="text-[#8f99a8]">· {v.strategi}</span>
                  </button>
                ))}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#abb3bf]">Modus fraud:
                {Object.entries(DETEKSI).map(([k, d]) => <span key={k} className="flex items-center gap-1"><span className="h-2 w-3 rounded-full border" style={{ background: d.fill, borderColor: d.stroke }} />{d.label}{r.modus?.per_deteksi?.[k] != null ? ` (${r.modus.per_deteksi[k]})` : ""}</span>)}
              </div>
              <p className="mt-1 text-[10px] text-[#6b7480]">Alur utama selalu tampil; hubungan lain muncul saat agen disorot atau dengan “Semua hubungan”. Gulir untuk zoom, seret untuk menggeser, klik agen untuk detail, klik dua kali untuk memusatkan.</p>
            </>
          )}
        </div>

        {panel && (
          <div className="absolute left-3 top-3 max-h-[70%] w-[520px] overflow-y-auto rounded border border-white/15 bg-[#1c2127]/97 p-3 shadow-xl">
            <div className="mb-2 flex items-center"><p className="font-semibold text-white">{panel === "konsep" ? "Konsep orkestrasi → penerapan di AIP JKN" : `Agen yang digabung dan ditambah: ${r.sebelum?.total} → ${r.agen}`}</p>
              <button onClick={() => setPanel("")} aria-label="Tutup" className="ml-auto rounded p-0.5 hover:bg-white/10"><Icon name="x" className="h-3.5 w-3.5" /></button></div>
            {panel === "konsep" ? net.konsep.map((k) => (
              <div key={k.konsep} className="border-t border-white/5 py-1.5"><p className="font-medium text-[#c9c0ff]">{k.konsep}</p><p className="text-[11px] leading-snug text-[#d3d8de]">{k.di_aip}</p></div>
            )) : (
              <>
                <p className="mb-1 text-[11px] text-[#8f99a8]">Sebelum: {r.sebelum?.rincian}. Bukti diukur pada dua penugasan 2026-10-23 dan buku besar tag.</p>
                {((r.ditambah ?? []) as Rec[]).map((d, i) => (
                  <div key={`t${i}`} className="border-t border-white/5 py-1.5">
                    <p className="text-[11.5px] text-[#e5e8eb]"><span className="text-[#fb923c]">Ditambah</span> <b className="text-white">{d.apa}</b> <span className="text-[#fb923c]">({Number(d.jumlah) < 0 ? "−" : "+"}{Math.abs(Number(d.jumlah))})</span></p>
                    <p className="text-[11px] leading-snug text-[#abb3bf]">{d.alasan}</p>
                  </div>
                ))}
                {(r.gabung as Rec[]).map((g, i) => (
                  <div key={i} className="border-t border-white/5 py-1.5">
                    <p className="text-[11.5px] text-[#e5e8eb]">{(g.dari as string[]).join(" + ")} <span className="text-[#8f99a8]">→</span> <b className="text-white">{g.jadi}</b> <span className="text-[#7ee2c0]">(−{g.dihemat})</span></p>
                    <p className="text-[11px] leading-snug text-[#abb3bf]">{g.alasan}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {selected && <Detail n={selected} net={net} color={color} skills={skills} onPick={(id) => pick(id, true)} onClose={() => setSel(null)} />}
      </div>
    </div>
  );
}

function Detail({ n, net, color, skills, onPick, onClose }: { n: Node; net: Net; color: Record<string, string>; skills: Record<string, Skill>;
  onPick: (id: string) => void; onClose: () => void }) {
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const byId = new Map(net.simpul.map((x) => [x.id, x]));
  const out = net.hubungan.filter((e) => e.dari === n.id);
  const inc = net.hubungan.filter((e) => e.ke === n.id);
  const rel = (e: Edge, other: string, dir: "→" | "←") => {
    const o = byId.get(other);
    const kind = net.jenis_hubungan[e.jenis];
    return (
      <button key={`${dir}${other}${e.jenis}${e.label}`} onClick={() => onPick(other)} className="flex w-full items-start gap-1.5 border-t border-white/5 py-1 text-left hover:bg-white/5">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: color[other] }} />
        <span className="min-w-0 flex-1">
          <span className="text-[#e5e8eb]">{dir} {o?.nama ?? other}</span>
          <span className="block text-[10.5px] leading-snug text-[#8f99a8]"><span style={{ color: REL_COLOR[e.jenis] }}>{kind?.label ?? e.jenis}</span> · {kind?.strategi} · {e.label}</span>
        </span>
      </button>
    );
  };
  const acts = (n.aksi ?? []) as Rec[];
  return (
    <aside className="absolute bottom-0 right-0 top-0 w-[380px] overflow-y-auto border-l border-white/10 bg-[#1c2127] p-3 text-[12px]">
      <div className="flex items-start gap-2">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: color[n.id] }} />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold leading-snug text-white">{n.nama}</p>
          <p className="text-[10.5px] text-[#8f99a8]">{KIND_LABEL[n.jenis] ?? n.jenis}{n.cakupan ? ` · ${n.cakupan}` : ""}{n.induk && byId.get(n.induk) ? ` · dipimpin ${byId.get(n.induk)!.nama}` : ""}</p>
        </div>
        <button onClick={onClose} aria-label="Tutup detail" className="rounded p-0.5 hover:bg-white/10"><Icon name="x" className="h-4 w-4" /></button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-[10.5px]">
        {n.model && <span className="rounded bg-white/[.06] px-1.5 py-0.5">{modelName(n.model)}</span>}
        {(n.alur ?? []).map((f) => <span key={f} className="rounded bg-[#9d8cff]/15 px-1.5 py-0.5 text-[#c9c0ff]">{net.alur[f]?.split(" (")[0] ?? f}</span>)}
        {(n.alias as string[] | undefined)?.map((a) => <span key={a} className="rounded bg-white/[.04] px-1.5 py-0.5 text-[#8f99a8]">juga: {a}</span>)}
      </div>

      <Section title="Fungsi"><p className="leading-snug text-[#d3d8de]">{n.fungsi || "—"}</p>
        {n.menjawab && <p className="mt-1 text-[11px] text-[#abb3bf]">Menjawab: {n.menjawab}</p>}
        {n.isi && <ul className="mt-1 list-disc pl-4 text-[11px] text-[#abb3bf]">{(n.isi as string[]).map((x) => <li key={x}>{x}</li>)}</ul>}
      </Section>

      {n.dinamis && (
        <Section title="Peran dinamis">
          <p className="text-[11px] leading-snug text-[#d3d8de]">Bukan agen per kasus: satu peran dengan skill-nya. Saat penugasan, orkestrator membentuk satu instans berkonteks segar per item antrean, sampai kapasitas {n.kapasitas}; instans selesai bersama kasusnya.</p>
          {(n.antrean as Rec[] | undefined)?.length ? (
            <>
              <p className="mt-1 text-[10.5px] text-[#8f99a8]">Antrean box saat ini ({n.antrean_total} faskes; {Math.min(Number(n.kapasitas), (n.antrean as Rec[]).length)} teratas akan diaudit):</p>
              <ol className="mt-0.5 list-decimal pl-5 text-[11px] text-[#d3d8de]">{(n.antrean as Rec[]).map((f) => <li key={f.faskes_profil_id}><span className="text-[#8f99a8]">{f.kelompok}</span> · {f.pendek}</li>)}</ol>
            </>
          ) : null}
        </Section>
      )}

      {(n.skill as string[] | undefined)?.length ? (
        <Section title={`Skill (${(n.skill as string[]).length})`}>
          {(n.skill as string[]).map((k) => {
            const s = skills[k];
            return (
              <div key={k} className="border-t border-white/5">
                <button onClick={() => setOpenSkill(openSkill === k ? null : k)} className="flex w-full items-center gap-1 py-1 text-left">
                  <span className="font-medium text-[#e5e8eb]">{s?.nama ?? k}</span><span className="ml-auto text-[10.5px] text-[#8f99a8]">{s?.pelajaran?.length ? `${s.pelajaran.length} pelajaran · ` : ""}{openSkill === k ? "▾" : "▸"}</span>
                </button>
                {openSkill === k && s && (
                  <div className="mb-1.5 rounded bg-black/25 p-1.5 text-[11px]">
                    <p className="text-[#abb3bf]">{s.untuk}</p>
                    <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[#d3d8de]">{s.langkah.map((x, i) => <li key={i}>{x}</li>)}</ol>
                    {s.wajib?.length > 0 && <p className="mt-1 text-[10.5px] text-[#8f99a8]">Wajib (dicek kode di serah-terima): {s.wajib.map((g) => g.join(" / ")).join("; ")}</p>}
                    {s.pelajaran?.length > 0 && <><p className="mt-1 text-[10.5px] font-medium text-[#c9c0ff]">Pelajaran dari run sebelumnya</p><ul className="list-disc pl-4 text-[#d3d8de]">{s.pelajaran.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      ) : null}

      {acts.length > 0 && (
        <Section title={`Aksi yang bisa dilakukan (${acts.length})`}>
          {acts.map((a) => (
            <div key={a.nama} className="border-t border-white/5 py-1">
              <p className="flex items-center gap-1.5"><span className="font-mono text-[11px] text-[#e5e8eb]">{a.nama}</span>
                {a.menulis ? <span className="rounded px-1 text-[10px] text-black" style={{ background: WRITE_COLOR[a.menulis] ?? "#8f99a8" }}>menulis {a.menulis}</span>
                  : a.alat ? <span className="rounded bg-white/[.06] px-1 text-[10px] text-[#8f99a8]">baca</span> : <span className="rounded bg-white/[.06] px-1 text-[10px] text-[#8f99a8]">langkah</span>}</p>
              <p className="text-[11px] leading-snug text-[#abb3bf]">{a.arti}</p>
            </div>
          ))}
        </Section>
      )}

      {(n.objek as string[] | undefined)?.length ? <Section title="Objek Nexus yang dipegang"><p className="text-[11px] leading-snug text-[#d3d8de]">{(n.objek as string[]).join(" · ")}</p></Section> : null}

      <Section title={`Hubungan (${out.length + inc.length})`}>
        {out.map((e) => rel(e, e.ke, "→"))}
        {inc.map((e) => rel(e, e.dari, "←"))}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="mt-3"><p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]">{title}</p>{children}</div>;
}
