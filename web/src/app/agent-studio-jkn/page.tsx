"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ACTIONS, AGENTS, EDGES, FILES, FUNCTIONS, LOGICS, OBJECT_TYPES, byId } from "./data";
import { OpenTab, RealApps, TabBtn } from "./RealApp";
import { NexusView, type NexusAnswer } from "./NexusView";
import { CRIT_LABEL, CriteriaPanel, type CritKey } from "./CriteriaPanel";
import { askAgent, askOrbis, loadLive, rp, screenClaim, type Live, type Rec } from "./liveData";
import { fraudApi } from "@/components/demo/fraud/api";
import { PipelineWorkspace } from "../agent-studio/PipelineWorkspace";
import { type PEdge, type PNode } from "../agent-studio/pipelineData";
import { JKN_AI_EDGES, JKN_AI_NODES, JKN_EDGES, JKN_LEGEND, JKN_NODES } from "./pipelineData";
import { AgentsMap, RunView } from "@/components/aip/AipView";
import { MissionControl } from "@/components/aip/MissionControl";
import { aip, follow, modelName, usd, type Agent, type AipEvent, type Run } from "@/components/aip/aipRun";

/* AIP Agent Studio for the JKN audit, laid out like the reference: a thin top bar with the platform apps, an
   Explore sidebar that drills down (object types → property / link / action types), an ambient ontology view in
   the centre with one action pill, and the agent on the right — a transcript of tool steps (Search, Operator,
   Builder, Workshop) that drives the workspace: work plan → pipeline → datasets → proposal → Workshop app →
   lineage. All data is the JKN demo's (fictitious). */

type Mode = "home" | "pipeline" | "ops" | "logic" | "lineage" | "aip" | "missions" | "map";
type Chip = { label: string; icon: IconName; color: string };
type Item =
  | { k: "user"; text: string }
  | { k: "step"; tool: string; text: string; chips?: Chip[]; tail?: string; tailChips?: Chip[] }
  | { k: "agent"; text: string; refs?: Chip[] };
type Pill = { text: string; chips?: Chip[]; tail?: string; tailChips?: Chip[]; crit?: CritKey };
type Turn = [Scripted[], string | null];
type Scripted = Item & { fx?: () => void; pill?: Pill; log?: string };
type ListKind = "types" | "agents" | "actions" | "logic" | "files";
type LeftView = { k: "root" } | { k: "list"; list: ListKind } | { k: "type"; id: string };

const TYPE_ICON: Record<string, IconName> = { faskes: "home", klaim: "doc", peserta: "list", dpjp: "pencil", rujukan: "split", temuan: "alert", tarif: "table", iot: "cpu", jadwal: "clock", berkas: "folder" };
const TOOL_COLOR: Record<string, string> = { Tool: "#f29d49", Orbis: "#72ca9b", Search: "#4c90f0", Operator: "#9d8cf5", Builder: "#3fb5a3", Workshop: "#c58af9", Logic: "#f0b14c" };
const EXPLORE: { list: ListKind; icon: IconName; title: string; sub: string }[] = [
  { list: "types", icon: "cube", title: "Object types", sub: "All integrated object types in the ontology" },
  { list: "agents", icon: "bolt", title: "AI agents", sub: "AI-powered agents taking action using the ontology" },
  { list: "actions", icon: "edit", title: "Actions", sub: "Actions for modifying the ontology" },
  { list: "logic", icon: "logic", title: "AIP logic", sub: "Functions that compute using data in object types" },
  { list: "files", icon: "folder", title: "All files", sub: "All pipelines, datasets, and other files" },
];
const obj = (id: string): Chip => ({ label: byId(id).name, icon: TYPE_ICON[id] ?? "cube", color: byId(id).color });
const ds = (label: string): Chip => ({ label, icon: "table", color: "#5f6b7c" });
const APP_AUDIT: Chip = { label: "Ruang Kerja Audit Faskes", icon: "layers", color: "#7c6bb0" };
const UTIL_OBJ: Chip = { label: "Utilisasi Alat Medis", icon: "cpu", color: "#7c6bb0" };
const FIRST = "gunakan telemetri IoT alat medis untuk audit faskes berisiko";
const SAMPLE_SEP = "BARU-0417";
const timed = async <T,>(f: () => Promise<T>) => { const t0 = performance.now(); const r = await f(); return { r, secs: (performance.now() - t0) / 1000 }; };
const SCRIPTED: Record<string, string> = {
  [FIRST.toLowerCase()]: "plan", "mulai integrasi": "open", "tambah data telemetri iot": "add", deploy: "deploy",
  "skrining pre-payment klaim belum dibayar": "screen", "buat aplikasi audit": "app", "lihat lineage dan akses data": "lineage",
};
// the centre screen a question is about
const viewFor = (q: string): Mode => {
  const s = q.toLowerCase();
  if (/lineage|asal data|sumber data|alur data|hulu|hilir|akses|izin|permission|upstream|downstream/.test(s)) return "lineage";
  if (/pipeline|transform|dataset|ingest|build|join|kolom/.test(s)) return "pipeline";
  if (/workshop|kanban|antrian|tiket|cockpit|kokpit|aplikasi audit/.test(s)) return "ops";
  if (/\blogic\b|fungsi|function|aturan|rule|model ml|rumus|cara skor|skor dihitung/.test(s)) return "logic";
  return "home";
};
const VIEW_LABEL: Record<Mode, string> = { home: "Nexus", pipeline: "Pipeline Builder", lineage: "Data Lineage", ops: "Workshop", logic: "AIP Logic", aip: "AIP · agen", missions: "Mission Control", map: "Peta" };
const TOOL_ICON: Record<string, IconName> = {
  search_nexus: "search", describe_object_type: "cube", query_objects: "table", get_pipeline: "pipeline", trace_lineage: "split",
  read_code: "code", model_benchmark: "gauge", list_logic_functions: "logic", fraud_summary: "alert", check_claim: "check",
};
const VIEW_ICON: Record<Mode, IconName> = { home: "graph", pipeline: "pipeline", lineage: "split", ops: "layers", logic: "logic", aip: "sparkle", missions: "gauge", map: "globe" };
// the JKN audit pipeline: read from the JKN demo status (pipeline_id); this id only until that answers
const JKN_PIPELINE = "4a2e19753992445f";
// the other real apps of the JKN demo (ids read from the platform when it answers; these until then)
const APP = { nexus: "/vertex/jkn-intelligence-nexus", logicName: "Ringkas risiko klaim (demo)", logicFallback: "logic-df0e967a55fa", workshopFallback: "wsm-515999235672" };
const glyph = (t: string) => /date|time/i.test(t) ? "⏱" : /double|long|integer/i.test(t) ? "12" : /link/i.test(t) ? "⇄" : "Aa";

export default function AgentStudioJknPage() {
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("home");
  const [opened, setOpened] = useState<Set<Mode>>(new Set());
  const [leftHidden, setLeftHidden] = useState(false);
  const [left, setLeft] = useState<LeftView>({ k: "root" });
  const [active, setActive] = useState<string[]>([]);
  const [agentOpen, setAgentOpen] = useState(true);
  const [mobileAgent, setMobileAgent] = useState(false);
  const [agentId, setAgentId] = useState("audit");
  const [items, setItems] = useState<Item[]>([]);
  const [logs, setLogs] = useState<string[]>(['Agent Type: "jkn_audit_agent"', 'Instance Id: "a7f3c2e1-jkn-audit-copilot"', "> Ontology JKN terindeks · 10 tipe objek"]);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pill, setPill] = useState<Pill | null>(null);
  const [next, setNext] = useState<string | null>(FIRST);
  const [input, setInput] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [pNodes, setPNodes] = useState<PNode[]>(JKN_NODES);
  const [pEdges, setPEdges] = useState<PEdge[]>(JKN_EDGES);
  const [proposalState, setProposalState] = useState("Saved");
  const [showProposals, setShowProposals] = useState(0);
  // the centre's real apps: the JKN audit pipeline in Pipeline Builder, the saved JKN lineage graph in Data Lineage
  const [pipeTab, setPipeTab] = useState<"asli" | "proposal">("asli");
  const [lineageColor, setLineageColor] = useState<"type" | "permissions">("type");
  const [nexusTab, setNexusTab] = useState<"asli" | "jawaban">("jawaban");
  const timers = useRef<number[]>([]);
  const [live, setLive] = useState<Live>({});
  const [nexus, setNexus] = useState<NexusAnswer | null>(null);
  const [critOpen, setCritOpen] = useState(false);
  const [auto, setAuto] = useState(false);
  // AIP on Google ADK: the domain agents (one per Nexus object group), the run being followed and its events
  const [aipAgents, setAipAgents] = useState<{ agents: Agent[]; roles: Record<string, string>; apps?: Record<string, string> } | null>(null);
  // which data the connected apps show: the BPJS data (Data Sampel 2025: gold pipeline, its lineage) or the audit demo
  const [dataSrc, setDataSrc] = useState<"bpjs" | "demo">("bpjs");
  const [aipRun, setAipRun] = useState<Run | null>(null);
  const [aipEvents, setAipEvents] = useState<AipEvent[]>([]);
  useEffect(() => { loadLive().then(setLive); aip.agents().then(setAipAgents).catch(() => setAipAgents(null)); }, []);

  useEffect(() => {
    window.dispatchEvent(new Event("bluesandai:sidebar-rail"));
    const m = new URLSearchParams(window.location.search).get("mode");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link mode from the URL on entry
    if (m === "pipeline" || m === "ops" || m === "logic" || m === "lineage" || m === "aip" || m === "missions" || m === "map") { setMode(m); setOpened(new Set([m])); }
    if (window.innerWidth < 768) setLeftHidden(true);
    const t = setTimeout(() => setLoading(false), 700);
    const pending = timers.current;
    return () => { clearTimeout(t); pending.forEach(clearTimeout); };
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t); }, [toast]);

  const open = (m: Mode) => { setMode(m); if (m !== "home") setOpened((s) => new Set(s).add(m)); };
  const notify = (m: string) => { setToast(m); setLogs((l) => [...l, `> ${m}`]); };
  const activate = (ids: string[]) => setActive((a) => [...a, ...ids.filter((x) => !a.includes(x))]);

  // play a scripted turn: one step every ~700 ms, the pill shows the step being run, side effects as they land
  const play = (steps: Scripted[], then: string | null) => {
    steps.forEach((s, i) => {
      timers.current.push(window.setTimeout(() => {
        const { fx, pill: p, log, ...item } = s;
        setItems((it) => [...it, item as Item]);
        if (p) setPill(p);
        fx?.();
        setLogs((l) => [...l, log ?? (item.k === "step" ? `Tool: ${item.tool} — ${item.text}${item.chips ? " " + item.chips.map((c) => c.label).join(", ") : ""}` : `Final answer: ${item.text}`)]);
        if (i === steps.length - 1) { setBusy(false); setNext(then); timers.current.push(window.setTimeout(() => setPill(null), 2600)); }
      }, 700 * (i + 1)));
    });
  };

  const stages: Record<string, (q: string) => Turn | Promise<Turn>> = {
    plan: () => [[
      { k: "step", tool: "Search", text: "Found objects", chips: [obj("faskes")], fx: () => activate(["faskes"]) },
      { k: "step", tool: "Operator", text: "Create work plan", pill: { text: "Create work plan", crit: "presentasi" }, fx: () => setOpened((s) => new Set(s).add("home")) },
      { k: "agent", text: "Rencana kerja: integrasikan telemetri IoT alat medis ke skrining klaim, lalu bangun aplikasi audit berbasis AI." },
    ], "mulai integrasi"],
    open: () => [[
      { k: "step", tool: "Operator", text: "Open pipeline", chips: [{ ...obj("faskes"), icon: "pipeline" }], pill: { text: "Open pipeline", chips: [{ ...obj("faskes"), icon: "pipeline" }] }, fx: () => { setPipeTab("asli"); open("pipeline"); } },
      { k: "agent", text: "Membuka pipeline jkn-risk-screening." },
    ], "tambah data telemetri IoT"],
    add: () => {
      const dsets = [ds("Log Utilisasi Alat"), ds("Kalibrasi Alat"), ds("Jadwal Tindakan")];
      return [[
        { k: "step", tool: "Builder", text: "Create pipeline branch for", chips: [obj("faskes")], fx: () => { setPipeTab("proposal"); open("pipeline"); setProposalState("Branch: Tambah Telemetri IoT"); } },
        { k: "step", tool: "Search", text: "Found datasets", chips: dsets },
        { k: "step", tool: "Builder", text: "Add datasets", chips: dsets, tail: "to", tailChips: [obj("faskes")], pill: { text: "Add datasets", chips: dsets, tail: "to", tailChips: [obj("faskes")], crit: "kreativitas" },
          fx: () => setPNodes((ns) => [...ns.filter((n) => !n.proposed), ...JKN_AI_NODES.filter((n) => n.kind === "dataset")]) },
        { k: "step", tool: "Builder", text: "Add 1 object target", chips: [UTIL_OBJ] },
        { k: "step", tool: "Builder", text: "Menambah dataset telemetri dan membuat objek target Utilisasi Alat Medis", pill: { text: "Menambah dataset telemetri dan membuat objek target Utilisasi Alat Medis" } },
        { k: "agent", text: "Menambah objek ke target, menambah dataset ke pipeline." },
        { k: "step", tool: "Builder", text: "Generate 6 transforms", pill: { text: "Generate 6 transforms", crit: "kreativitas" },
          fx: () => { setPNodes((ns) => [...ns.filter((n) => !n.proposed), ...JKN_AI_NODES]); setPEdges([...JKN_EDGES, ...JKN_AI_EDGES]); setProposalState("Draft proposal"); activate(["iot"]); } },
      ], "deploy"];
    },
    deploy: () => [[
      { k: "step", tool: "Builder", text: "Create pipeline proposal for", chips: [obj("faskes")], fx: () => { setPipeTab("proposal"); open("pipeline"); setProposalState("Proposed"); } },
      { k: "step", tool: "Operator", text: "Open pipeline proposal for", chips: [obj("faskes")], pill: { text: "Open proposal", chips: [obj("faskes")], crit: "kesiapan" }, fx: () => setShowProposals((n) => n + 1) },
      { k: "agent", text: "Membuka proposal pipeline — tinjau Changes sebelum merge ke main. Tidak ada yang ter-deploy tanpa persetujuan." },
    ], "skrining pre-payment klaim belum dibayar"],
    screen: async () => {
      const [r, qq] = await Promise.all([screenClaim(), fraudApi.queue()]);
      const n = qq.ringkasan ?? {};
      const total = (n.hold ?? 0) + (n.review ?? 0) + (n.otomatis ?? 0);
      const issues = (r.issues ?? []) as Rec[];
      const held = issues.reduce((a, i) => a + (i.nilai_risiko ?? 0), 0);
      const factors = ((r.faktor_skor ?? []) as Rec[]).map((f) => `${f.faktor} +${f.kontribusi}`).join(", ");
      return [[
        { k: "step", tool: "Search", text: `Found ${total} klaim belum dibayar`, chips: [obj("klaim")] },
        { k: "step", tool: "Logic", text: "Run skrining pre-payment · skor risiko explainable", pill: { text: `Skrining pre-payment · ${total} klaim`, crit: "dampak" } },
        { k: "step", tool: "Logic", text: `Antrian: ${n.hold ?? 0} ditahan · ${n.review ?? 0} review verifikator · ${n.otomatis ?? 0} bayar otomatis`, fx: () => setLive((l) => ({ ...l, queue: qq })) },
        { k: "step", tool: "Logic", text: `Klaim baru ${SAMPLE_SEP} → ${r.keputusan} · skor ${r.skor_risiko} (${r.tier}) · ${r.latensi_ms} ms`, pill: { text: `${r.keputusan} · skor ${r.skor_risiko} · ${r.latensi_ms} ms`, crit: "kesiapan" } },
        { k: "agent", text: r.keputusan === "HOLD"
          ? `Pembayaran klaim ini ditahan sebelum keluar: ${issues.map((i) => i.label).join(", ")}. Nilai berisiko ${rp(held)}. Skor dijelaskan per faktor — ${factors}. Verifikator yang memutuskan; tidak ada klaim yang ditolak otomatis.`
          : `Keputusan ${r.keputusan} (skor ${r.skor_risiko}). Faktor: ${factors || "tidak ada anomali"}.` },
      ], "buat aplikasi audit"];
    },
    app: () => {
      const used = ["temuan", "klaim", "berkas", "jadwal", "iot", "tarif"];
      return [[
        { k: "step", tool: "Search", text: "Found objects", chips: used.map(obj), fx: () => activate(used) },
        { k: "step", tool: "Workshop", text: "Create module", chips: [APP_AUDIT], tail: "from template “[Template] Operational Kanban” using", tailChips: [obj("faskes"), ...used.map(obj)] },
        { k: "step", tool: "Operator", text: "Open module", chips: [APP_AUDIT], pill: { text: "Open module", chips: [APP_AUDIT], crit: "kesiapan" }, fx: () => { open("ops"); setLeftHidden(true); } },
        { k: "agent", text: "Membuat aplikasi operasional dari objek Fasilitas Kesehatan dan template Kanban." },
      ], "lihat lineage dan akses data"];
    },
    lineage: () => [[
      { k: "step", tool: "Operator", text: "Open Data Lineage", chips: [{ label: "Audit Faskes", icon: "split", color: "#2d72d2" }], pill: { text: "Open Data Lineage", crit: "bisnis" }, fx: () => { setLineageColor("permissions"); open("lineage"); setLeftHidden(false); } },
      { k: "agent", text: "Lineage dibuka: dataset mentah → transform → objek → aplikasi. Pilih Permissions dan View as untuk memeriksa akses tiap akun." },
    ], null],
    // a question: the AIP orchestrator on Google ADK plans, hands it to the domain agents that own the objects, writes,
    // validates and composes the screen; the run streams into the agent panel and the centre. Without the AIP service
    // the earlier copilot answers (copilot below).
    investigate: async (q) => {
      try {
        const history = items.filter((x) => x.k === "user" || x.k === "agent").slice(-6).map((x) => ({ role: x.k === "user" ? "user" : "assistant", text: x.text }));
        const { run } = await aip.ask(q, history);
        setAipEvents([]); setAipRun({ id: run, status: "running", q, spent_usd: 0, created_at: new Date().toISOString() }); open("aip");
        const agentName = (k: string) => aipAgents?.agents.find((a) => `agen_${a.key}` === k || a.key === k)?.name.replace(" (BPJS)", "") ?? k;
        const final = await follow(run, (e) => {
          setAipEvents((es) => [...es, e]);
          const push = (it: Item) => setItems((x) => [...x, it]);
          if (e.type === "plan") push({ k: "step", tool: "Operator", text: `Rencana: ${e.summary} → ${(e.tasks as { name: string }[]).map((t) => t.name.replace(" (BPJS)", "")).join(", ")}` });
          if (e.type === "tool") push({ k: "step", tool: "Tool", text: `${agentName(e.agent)} — ${e.summary}`, chips: [{ label: e.tool, icon: "bolt", color: e.ok ? "#5f6b7c" : "#c23030" }] });
          if (e.type === "verdict") push({ k: "step", tool: "Logic", text: `Validator ${modelName(e.model)}: ${e.passed}/${e.total} cek lolos` });
          if (e.type === "proposal") push({ k: "step", tool: "Workshop", text: `Usulan: ${e.action} · ${e.pk} — menunggu keputusan Anda` });
          if (e.type === "stage") setLogs((l) => [...l, `Stage: ${e.stage} · ${e.agent ?? (e.agents ?? []).join(", ")} · ${modelName(e.model)}`]);
          if (e.type === "error") setLogs((l) => [...l, `Error: ${e.agent ?? ""} ${e.message}`]);
        });
        setAipRun(final);
        const answer = String(final.answer ?? "").replace(/\*\*/g, "").replace(/^#+\s*/gm, "").replace(/^\* /gm, "• ");
        return [[{ k: "agent", text: `${answer || "Run selesai tanpa jawaban — lihat langkahnya di tab AIP."}\n\n(AIP · ${final.status} · ${usd(final.spent_usd)})` }], next];
      } catch { return stages.copilot(q); }
    },
    copilot: async (q) => {
      try {
        const history = items.filter((x) => x.k === "user" || x.k === "agent").slice(-6).map((x) => ({ role: x.k === "user" ? "user" : "assistant", text: x.text }));
        const { r, secs } = await timed(() => askAgent(q, history));
        const used = (r.steps ?? []) as Rec[];
        const last = [...used].reverse().find((st) => st.view)?.view as Mode | undefined;
        const view: Mode = last ?? viewFor(q);
        const show = () => {
          if (view === "lineage") setLineageColor(/akses|izin|permission|siapa/i.test(q) ? "permissions" : "type");
          if (view === "pipeline") setPipeTab("asli");
          if (view === "home") setNexusTab("asli");
          open(view);
        };
        return [[
          ...used.map((st, i): Scripted => ({
            k: "step", tool: "Tool", text: `${st.label} — ${st.summary}`, chips: [{ label: st.tool, icon: TOOL_ICON[st.tool] ?? "bolt", color: st.ok ? "#5f6b7c" : "#c23030" }],
            pill: { text: `Tool · ${st.label}`, crit: "kreativitas" }, log: `Tool: ${st.tool}(${JSON.stringify(st.args)}) → ${st.summary} · ${st.ms} ms`,
            ...(i === used.length - 1 ? { fx: show } : {}),
          })),
          ...(used.length === 0 ? [{ k: "step" as const, tool: "Operator", text: `Open ${VIEW_LABEL[view]}`, fx: show }] : []),
          { k: "agent", text: `${String(r.answer ?? "").replace(/\*\*/g, "").replace(/`/g, "").replace(/^#+\s*/gm, "").replace(/^\* /gm, "• ")}\n\n(${used.length} tool · ${r.model} · ${secs.toFixed(1)} s)` },
        ], next];
      } catch { return stages.orbis(q); }
    },
    orbis: async (q) => {
      try {
        const { r, secs } = await timed(() => askOrbis(q));
        const refs: Chip[] = ((r.refs ?? []) as Rec[]).slice(0, 5).map((x) => ({ label: String(x.label), icon: /Faskes/.test(x.kind) ? "home" : "graph", color: /Faskes/.test(x.kind) ? "#c62f3b" : "#7c6bb0" }));
        const view = viewFor(q);
        const graph: NexusAnswer = { q, answer: String(r.answer ?? ""), refs: r.refs ?? [], hits: r.hits ?? [], cited: r.cited ?? [], subgraph: r.subgraph ?? { nodeIds: [], edges: [] }, ms: r.ms };
        return [[
          { k: "step", tool: "Search", text: "Found nodes in the Nexus graph", chips: refs, fx: () => { setNexus(graph); setNexusTab("jawaban"); if (view === "home") open("home"); } },
          { k: "step", tool: "Orbis", text: `RAG atas graf Nexus · ${graph.subgraph.nodeIds.length} simpul · ${graph.subgraph.edges.length} relasi · ${secs.toFixed(1)} s`, pill: { text: "GenAI menjawab dari graf Nexus, dengan sitasi", crit: "kreativitas" } },
          ...(view !== "home" ? [{ k: "step" as const, tool: "Operator", text: `Open ${VIEW_LABEL[view]}`, chips: [{ label: VIEW_LABEL[view], icon: VIEW_ICON[view], color: "#2d72d2" }], pill: { text: `Open ${VIEW_LABEL[view]}` }, fx: () => { if (view === "lineage") setLineageColor(/akses|izin|permission|siapa/i.test(q) ? "permissions" : "type"); if (view === "pipeline") setPipeTab("asli"); open(view); } }] : []),
          { k: "agent", text: String(r.answer ?? "").replace(/\*\*/g, "").replace(/^\* /gm, "• "), refs },
        ], next];
      } catch { return stages.fallback(q); }
    },
    fallback: () => [[
      { k: "step", tool: "Search", text: "Found objects", chips: [obj("faskes"), obj("klaim"), obj("temuan")], fx: () => activate(["faskes", "klaim", "temuan"]) },
      { k: "step", tool: "Logic", text: "Run Skrining Efisiensi Risiko (20 kategori)", pill: { text: "Run Skrining Efisiensi Risiko" } },
      { k: "agent", text: "RSUD Al-Ihsan paling mungkin melakukan upcoding INA-CBG (temuan TMN-118, keyakinan 0.91): 42 klaim LOS menyimpang senilai Rp 1,24 M. Tim Audit A tersedia untuk audit lapangan 27 Okt. (Orbis tidak menjawab — ini jawaban contoh.)" },
    ], next],
  };
  // scripted demo steps run only for commands; a question is answered by Orbis and routed to the screen it is about
  const intent = (q: string) => {
    const s = q.toLowerCase().trim();
    if (SCRIPTED[s]) return SCRIPTED[s];
    if (/\?|^(apa|mana|siapa|berapa|kenapa|mengapa|bagaimana|kapan|coba|tolong|kasih|berikan|tunjuk|jelaskan|cari|what|which|who|how|why|show|give|explain)\b/.test(s)) return "investigate";
    if (/lineage|akses|izin|permission/.test(s)) return "lineage";
    if (/aplikasi|app|workshop|modul|kanban/.test(s)) return "app";
    if (/skrining|screen|pre-?payment|bayar/.test(s)) return "screen";
    if (/deploy|proposal|usul/.test(s)) return "deploy";
    if (/tambah|dataset|add/.test(s)) return "add";
    if (/mulai|integras|start|buka pipeline|open pipeline/.test(s)) return "open";
    if (/rencana|plan|telemetri|iot|gunakan/.test(s)) return "plan";
    return "investigate";
  };
  const ask = async (raw?: string) => {
    const q = (raw ?? input).trim(); if (!q || busy) return;
    if (q === "__autoplay") { startDemo(); return; }
    setInput(""); setShowLogs(false); setBusy(true);
    setItems((it) => [...it, { k: "user", text: q }]);
    setLogs((l) => [...l, "> Entering new AgentExecutor chain...", `Thought: operator asked "${q}" — plan the tools to call.`]);
    let turn: Turn;
    try { turn = await stages[intent(q)](q); } catch (e) { turn = [[{ k: "agent", text: `Layanan tidak menjawab: ${(e as Error).message}` }], next]; }
    play(...turn);
  };
  const clear = () => { timers.current.forEach(clearTimeout); setItems([]); setBusy(false); setPill(null); setNext(FIRST); setAuto(false); };
  const startDemo = () => { clear(); open("home"); setCritOpen(false); setAuto(true); };
  // the guided demo (~2 min): each suggested next step runs on its own, with time to narrate between turns
  useEffect(() => {
    if (!auto || busy) return;
    if (!next) { const t = setTimeout(() => setAuto(false), 0); return () => clearTimeout(t); }
    const t = setTimeout(() => ask(next), items.length ? 14000 : 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ask is re-created each render; the trigger is auto/busy/next
  }, [auto, busy, next]);

  if (loading) return (
    <div className="flex flex-1 items-center justify-center bg-[#2f3c48] text-[#c5cbd3]">
      <div className="text-center"><div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[#46525e] border-t-violet-400" /><p className="mt-4 text-[13px]">Loading AIP Agent Studio…</p><p className="mt-1 text-[11px] text-[#8f99a8]">Indexing ontology · pipelines · agents</p></div>
    </div>
  );

  const showLeft = !leftHidden && mode !== "ops" && mode !== "missions";
  const bpjsApps = aipAgents?.apps ?? {};
  const appSrc: Record<Mode, string> = {
    aip: "/agent-studio-jkn?mode=aip",
    missions: "/agent-studio-jkn?mode=missions",
    home: APP.nexus,
    pipeline: dataSrc === "bpjs" && bpjsApps.pipeline ? bpjsApps.pipeline : `/pipeline/${live.e2e?.pipeline_id ?? JKN_PIPELINE}`,
    lineage: dataSrc === "bpjs" && bpjsApps.lineage ? `${bpjsApps.lineage}&color=${lineageColor}` : `/lineage?graph=jknaudit&color=${lineageColor}`,
    map: bpjsApps.map ?? "/map",
    logic: `/logic/${(live.logic ?? []).find((f) => f.name === APP.logicName)?.id ?? APP.logicFallback}`,
    ops: `/workshop/${live.e2e?.workshop_id ?? APP.workshopFallback}`,
  };
  const pipeTabs = <><TabBtn active={pipeTab === "asli"} onClick={() => setPipeTab("asli")}>Pipeline asli</TabBtn><TabBtn active={pipeTab === "proposal"} onClick={() => setPipeTab("proposal")}>Proposal agen (draft){pNodes.some((n) => n.proposed) ? ` · ${pNodes.filter((n) => n.proposed).length}` : ""}</TabBtn></>;
  const tab = (m: Mode, label: string, icon: IconName, color: string) => (
    <button onClick={() => open(m)} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 ${mode === m ? "bg-white/10 text-white" : "text-[#d3d8de] hover:bg-white/5 hover:text-white"}`}>
      <span style={{ color }}><Icon name={icon} className="h-3.5 w-3.5" /></span>{label}
      {opened.has(m) && <span className="rounded bg-[#383e47] px-1 text-[9px] text-[#c5cbd3]">1</span>}
    </button>
  );
  const agentPanel = <AgentPanel {...{ items, busy, logs, showLogs, setShowLogs, next, input, setInput, ask, clear, opened, agentId, setAgentId }} onReturn={() => setShowLogs(false)} />;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#2f3c48] text-[#f6f7f9]">
      {/* thin top bar: explore controls · platform apps · agent */}
      <header className="relative flex h-8 shrink-0 items-center gap-1 border-b border-black/40 bg-[#111418] px-1.5 text-[11.5px]">
        <button onClick={() => { setLeftHidden(false); setLeft({ k: "list", list: "types" }); }} title="Search object types" className="rounded p-1.5 text-[#c5cbd3] hover:bg-white/10"><Icon name="search" className="h-3.5 w-3.5" /></button>
        <button onClick={() => setLeftHidden(!leftHidden)} title={leftHidden ? "Show Explore" : "Hide Explore"} className={`rounded p-1.5 hover:bg-white/10 ${leftHidden ? "text-[#8f99a8]" : "text-[#c5cbd3]"}`}><Icon name="sliders" className="h-3.5 w-3.5" /></button>
        <nav className="mx-auto flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] max-sm:ml-1">
          {tab("lineage", "Data Lineage", "split", "#f29d49")}
          {tab("pipeline", "Pipeline Builder", "pipeline", "#3fb5a3")}
          <button onClick={() => open("home")} title="Nexus — graf objek yang dipakai agen menjawab" className={`mx-1 flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 ${mode === "home" ? "bg-white/10 text-white" : "text-[#d3d8de] hover:bg-white/5"}`}><span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-current"><span className="h-1.5 w-1.5 rounded-full bg-current" /></span>Nexus</button>
          {tab("aip", "AIP · agen", "sparkle", "#9d8cff")}
          {tab("missions", "Mission Control", "gauge", "#f0b14c")}
          {bpjsApps.map && tab("map", "Peta", "globe", "#72ca9b")}
          {tab("logic", "AIP Logic", "logic", "#c5cbd3")}
          {tab("ops", "Workshop", "layers", "#9d8cf5")}
        </nav>
        <div className="hidden shrink-0 items-center gap-1 border-r border-white/10 pr-2 lg:flex">
          {(mode === "pipeline" || mode === "lineage") && (bpjsApps.pipeline || bpjsApps.lineage) && <><TabBtn active={dataSrc === "bpjs"} onClick={() => setDataSrc("bpjs")}>Data Sampel BPJS</TabBtn><TabBtn active={dataSrc === "demo"} onClick={() => setDataSrc("demo")}>Audit demo</TabBtn><span className="mx-1 h-4 w-px bg-white/10" /></>}
          {mode === "pipeline" && pipeTabs}
          {mode === "lineage" && <><TabBtn active={lineageColor === "type"} onClick={() => setLineageColor("type")}>Jenis node</TabBtn><TabBtn active={lineageColor === "permissions"} onClick={() => setLineageColor("permissions")}>Permissions</TabBtn></>}
          {mode === "home" && <><TabBtn active={nexusTab === "asli"} onClick={() => setNexusTab("asli")}>Nexus asli</TabBtn><TabBtn active={nexusTab === "jawaban"} onClick={() => setNexusTab("jawaban")}>Agen{nexus ? " · graf jawaban" : ""}</TabBtn></>}
          {mode === "aip" && aipRun && <><TabBtn active={false} onClick={() => setAipRun(null)}>Arsitektur agen</TabBtn></>}
          {!(mode === "pipeline" && pipeTab === "proposal") && !(mode === "home" && nexusTab === "jawaban") && mode !== "aip" && mode !== "missions" && <OpenTab href={appSrc[mode]} />}
        </div>
        <button onClick={() => auto ? setAuto(false) : startDemo()} title="Jalankan seluruh alur demo otomatis" className={`hidden shrink-0 items-center gap-1 rounded px-2 py-1 font-medium sm:flex ${auto ? "bg-[#c23030] text-white" : "text-[#d3d8de] hover:bg-white/10"}`}><Icon name={auto ? "stop" : "play"} className="h-3 w-3" />{auto ? "Stop demo" : "Demo otomatis"}</button>
        <button onClick={() => setCritOpen(!critOpen)} title="Kriteria penilaian dan buktinya" className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 font-medium ${critOpen ? "bg-[#f0b14c] text-[#1c2127]" : "text-[#d3d8de] hover:bg-white/10"}`}><Icon name="star" className="h-3 w-3" />Kriteria</button>
        <button onClick={() => { setAgentOpen(!agentOpen); setMobileAgent(!mobileAgent); }} title={agentOpen ? "Hide agent" : "Show agent"} className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${agentOpen ? "bg-[#5b5fd6] text-white" : "bg-[#383e47] text-[#c5cbd3]"}`}><Icon name="cube" className="h-3.5 w-3.5" /></button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {showLeft && (
          <aside className="absolute inset-y-0 left-0 z-20 flex w-[232px] shrink-0 flex-col overflow-y-auto border-r border-black/30 bg-[#1c2127] text-[12px] shadow-xl md:static md:shadow-none">
            <ExploreSidebar view={left} setView={setLeft} active={active} agentId={agentId} setAgentId={(id) => { setAgentId(id); setAgentOpen(true); }} ask={ask} onAction={(n) => notify(`${n} — staged for review in Nexus before applying.`)} />
          </aside>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col">
          {mode === "missions" && <MissionControl agents={aipAgents?.agents ?? []} roles={aipAgents?.roles ?? {}} />}
          {mode === "aip" && (aipRun ? <RunView run={aipRun} events={aipEvents} agents={aipAgents?.agents ?? []} />
            : aipAgents ? <AgentsMap agents={aipAgents.agents} roles={aipAgents.roles} />
            : <div className="flex flex-1 items-center justify-center bg-[#252f3a] text-[12px] text-[#8f99a8]">Layanan AIP (ADK) tidak menjawab.</div>)}
          {mode === "home" && nexusTab === "jawaban" && (nexus ? <NexusView data={nexus} onAsk={(q) => ask(q)} /> : <Visualization active={busy} />)}
          {mode === "home" && nexusTab === "jawaban" && !nexus && live.overview && <ImpactStrip live={live} />}
          <RealApps
            active={mode === "home" ? (nexusTab === "asli" ? "nexus" : null) : mode === "pipeline" ? (pipeTab === "asli" ? "pipeline" : null) : mode === "aip" || mode === "missions" ? null : mode}
            apps={[
              { key: "nexus", src: APP.nexus, title: "JKN Intelligence Nexus" },
              { key: "pipeline", src: appSrc.pipeline, title: "Pipeline Builder" },
              { key: "ops", src: appSrc.ops, title: "Workshop" },
              { key: "logic", src: appSrc.logic, title: "AIP Logic" },
              { key: "lineage", src: appSrc.lineage, title: "Data Lineage" },
              { key: "map", src: appSrc.map, title: "Peta risiko klaim BPJS" },
            ]}
          />
          {critOpen && <CriteriaPanel live={live} onRun={(w) => { setCritOpen(false); ask(w); }} onClose={() => setCritOpen(false)} />}
          {mode === "pipeline" && pipeTab === "proposal" && <div className="flex min-h-0 min-w-0 flex-1 flex-col"><PipelineWorkspace title="[JKN] Audit Risiko › Fasilitas Kesehatan" legend={[...JKN_LEGEND]} promptDefault="Gabungkan telemetri IoT alat medis dengan klaim tindakan" firstNodeId="faskesOut" nodes={pNodes} edges={pEdges} setNodes={setPNodes} setEdges={setPEdges} notify={notify} onAiGenerate={() => ask("tambah data telemetri IoT")} proposalState={proposalState} setProposalState={setProposalState} branch="Tambah Telemetri IoT" showProposals={showProposals} /></div>}

          {/* the action pill: the step the agent is running, or on the home view the next thing to do */}
          {(pill || (mode === "home" && nexusTab === "jawaban" && !nexus && next && !busy)) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-8 z-30 flex justify-center px-4">
              {pill ? <PillView p={pill} judge /> : (
                <button onClick={() => ask(next!)} className="pointer-events-auto flex items-center gap-2.5 rounded-md bg-gradient-to-r from-[#7a6af5] to-[#5b6ee1] px-5 py-3 text-[14px] font-medium text-white shadow-[0_8px_40px_rgba(122,106,245,.45)] hover:brightness-110">
                  <Icon name="layers" className="h-5 w-5" />{items.length ? next : "Create work plan"}
                </button>
              )}
            </div>
          )}
          {toast && <div className="absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded border border-violet-400/40 bg-[#1c1830] px-3 py-2 text-[12px] shadow-xl">{toast}</div>}
        </div>

        {agentOpen && <aside className="flex w-[268px] shrink-0 flex-col border-l border-black/40 bg-[#111418] max-lg:hidden">{agentPanel}</aside>}
        {mobileAgent && <div className="fixed inset-x-0 bottom-0 z-40 flex h-[70vh] flex-col border-t border-[#383e47] bg-[#111418] lg:hidden">{agentPanel}</div>}
      </div>
    </div>
  );
}

function ChipView({ c, big }: { c: Chip; big?: boolean }) {
  return <span className={`inline-flex max-w-full items-center gap-1 rounded-sm ${big ? "bg-[#2b3a8f] px-1.5 py-0.5 text-[13px]" : "bg-white/[.06] px-1 text-[10.5px]"} align-middle text-[#e5e8eb]`}><span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] text-white" style={{ background: c.color }}><Icon name={c.icon} className="h-2.5 w-2.5" /></span><span className="truncate">{c.label}</span></span>;
}

// the measured impact, live from the fraud engine (demo data)
function ImpactStrip({ live }: { live: Live }) {
  const k = live.overview?.kpi ?? {}, q = live.queue?.ringkasan ?? {};
  const tiles: [string, string, string][] = [
    [rp(k.estimasi_kerugian_rp), "estimasi kerugian terdeteksi", "#f0b14c"],
    [`${k.klaim_terflag ?? "—"} / ${k.total_klaim ?? "—"}`, "klaim terflag", "#f6f7f9"],
    [`${k.kasus_investigasi ?? "—"}`, "kasus investigasi otomatis", "#f6f7f9"],
    [`${q.hold ?? "—"}`, "klaim ditahan sebelum dibayar", "#ff8f8f"],
  ];
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap gap-2 max-sm:right-3">
      {tiles.map(([v, l, c]) => <div key={l} className="rounded border border-white/10 bg-black/25 px-3 py-2 backdrop-blur-sm"><p className="text-[17px] font-semibold tabular-nums" style={{ color: c }}>{v}</p><p className="text-[10.5px] text-[#c5cbd3]">{l}</p></div>)}
      <p className="basis-full text-[10px] text-[#8f99a8]">Live dari mesin fraud JKN · data demo fiktif</p>
    </div>
  );
}

function PillView({ p, judge }: { p: Pill; judge?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
    {judge && p.crit && <span className="pointer-events-auto flex items-center gap-1 rounded-full bg-[#f0b14c] px-2.5 py-0.5 text-[11px] font-semibold text-[#1c2127] shadow-lg"><Icon name="star" className="h-3 w-3" />Kriteria: {CRIT_LABEL[p.crit]}</span>}
    <div className="pointer-events-auto flex max-w-[640px] items-start gap-3 rounded-md bg-gradient-to-r from-[#7a6af5] to-[#5b6ee1] px-4 py-3 text-[14px] font-medium text-white shadow-[0_8px_40px_rgba(122,106,245,.45)] [animation:pillIn_.25s_ease-out]">
      <style>{`@keyframes pillIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
      <Icon name="layers" className="mt-0.5 h-5 w-5 shrink-0" />
      <span className="flex flex-wrap items-center gap-1.5">{p.text}{p.chips?.map((c) => <ChipView key={c.label} c={c} big />)}{p.tail && <span>{p.tail}</span>}{p.tailChips?.map((c) => <ChipView key={c.label} c={c} big />)}</span>
    </div>
    </div>
  );
}

function AgentPanel({ items, busy, logs, showLogs, setShowLogs, next, input, setInput, ask, clear, opened, agentId, setAgentId, onReturn }: {
  items: Item[]; busy: boolean; logs: string[]; showLogs: boolean; setShowLogs: (b: boolean) => void; next: string | null; input: string; setInput: (s: string) => void;
  ask: (q?: string) => void; clear: () => void; opened: Set<Mode>; agentId: string; setAgentId: (s: string) => void; onReturn: () => void;
}) {
  const [sugOpen, setSugOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [items, logs, showLogs]);
  const agent = AGENTS.find((a) => a.id === agentId)!;
  const suggestions = [next, "Investigasi RSUD Al-Ihsan dan susun rencana audit", "Klaim INA-CBG mana yang berpotensi upcoding minggu ini?", "lihat lineage dan akses data"].filter((s, i, a): s is string => !!s && a.indexOf(s) === i);
  return (
    <>
      <AppFlow opened={opened} />
      <div className="relative min-h-0 flex-1">
        {!showLogs && <Cube faded={items.length > 6} />}
        {showLogs ? (
          <div className="absolute inset-0 overflow-y-auto px-2.5 py-2 font-mono text-[10px] leading-[1.45]">
            {logs.map((l, i) => <p key={i} className={l.startsWith("Thought") ? "text-[#72ca9b]" : l.startsWith("Tool") ? "text-[#f0b14c]" : l.startsWith("Agent") || l.startsWith("Instance") ? "text-[#4c90f0]" : "text-[#d3d8de]"}>{l}</p>)}
            <div ref={end} />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col overflow-y-auto px-2 pb-1">
            <div className="mt-auto space-y-1.5 pt-2">
              {items.length === 0 && <p className="px-1 text-[11px] leading-snug text-[#8f99a8]">{agent.name} · {agent.model}. Ask me to investigate faskes, or press <span className="text-white">Create work plan</span>.</p>}
              {items.map((it, i) => it.k === "user" ? (
                <p key={i} className="ml-auto w-fit max-w-[92%] rounded-sm bg-[#383e47] px-2 py-1 text-[11px] font-medium text-white">{it.text}</p>
              ) : it.k === "agent" ? (
                <div key={i} className="rounded-sm bg-[#4a4fd6] px-2 py-1.5 text-[11px] font-medium leading-snug text-white"><p className="whitespace-pre-line">{it.text}</p>{it.refs && it.refs.length > 0 && <p className="mt-1.5 flex flex-wrap gap-1 border-t border-white/20 pt-1.5 text-[10px] font-normal text-white/80">Sumber:{it.refs.map((c, j) => <span key={c.label} className="rounded-sm bg-black/20 px-1">[{j + 1}] {c.label}</span>)}</p>}</div>
              ) : (
                <div key={i} className="flex gap-2 text-[11px] leading-snug">
                  <span className="w-[52px] shrink-0" style={{ color: TOOL_COLOR[it.tool] ?? "#8f99a8" }}>{it.tool}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1 text-[#e5e8eb]">{it.text}{it.chips?.map((c) => <ChipView key={c.label} c={c} />)}{it.tail && <span>{it.tail}</span>}{it.tailChips?.map((c) => <ChipView key={c.label} c={c} />)}</span>
                </div>
              ))}
              {busy && <p className="w-fit rounded-sm bg-[#4a4fd6] px-3 py-1 text-[11px] text-white [animation:pulse_1.2s_ease-in-out_infinite]">• • •</p>}
              <div ref={end} />
            </div>
          </div>
        )}
      </div>
      {showLogs ? (
        <button onClick={onReturn} className="flex items-center gap-1.5 border-t border-white/5 px-3 py-2 text-[11px] text-[#d3d8de] hover:text-white"><Icon name="restore" className="h-3.5 w-3.5" />Return to Operator</button>
      ) : (
        <div className="border-t border-white/5 px-2 pb-2 pt-1.5">
          <button onClick={() => setSugOpen(!sugOpen)} className="flex w-full items-center px-1 py-1 text-[11px] text-[#c5cbd3] hover:text-white">Suggested next steps<Icon name="dots" className="ml-auto h-3.5 w-3.5" /></button>
          {sugOpen && <div className="mb-1.5 space-y-1">{suggestions.map((s) => <button key={s} disabled={busy} onClick={() => { setSugOpen(false); ask(s); }} className="block w-full rounded-sm bg-white/[.04] px-2 py-1 text-left text-[11px] text-[#d3d8de] hover:bg-white/10 disabled:opacity-50">{s}</button>)}</div>}
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent" className="mb-1.5 w-full rounded-sm border border-[#383e47] bg-[#1c2127] px-1.5 py-1 text-[11px] text-[#d3d8de] outline-none">{AGENTS.map((a) => <option key={a.id} value={a.id}>{a.name}{a.online ? "" : " (offline)"}</option>)}</select>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} rows={3} placeholder="What would you like to do?" className="w-full resize-none rounded-sm border border-[#2d72d2] bg-[#1c2127] px-2 py-1.5 text-[11.5px] outline-none placeholder:text-[#8f99a8]" />
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-white/5 px-2.5 py-1.5 text-[11px] font-medium text-[#d3d8de]">
        <button onClick={() => setShowLogs(!showLogs)} className="flex items-center gap-1 hover:text-white"><Icon name="eye" className="h-3.5 w-3.5" />{showLogs ? "Hide agent logs" : "Show agent logs"}</button>
        <button onClick={() => ask()} disabled={busy || !input.trim()} className="ml-auto flex items-center gap-1 text-[#4c90f0] hover:text-white disabled:opacity-40"><Icon name="play" className="h-3 w-3" />Send</button>
        <button onClick={clear} className="flex items-center gap-1 hover:text-white"><Icon name="x" className="h-3 w-3" />Clear</button>
      </div>
    </>
  );
}

// the apps the agent has opened, wired the way data flows between them
function AppFlow({ opened }: { opened: Set<Mode> }) {
  const nodes: { m: Mode; x: number; y: number; icon: IconName; bg: string; title: string }[] = [
    { m: "pipeline", x: 30, y: 38, icon: "pipeline", bg: "#1f9d8b", title: "Pipeline Builder" },
    { m: "home", x: 112, y: 10, icon: "home", bg: "#c62f3b", title: "Fasilitas Kesehatan" },
    { m: "lineage", x: 112, y: 66, icon: "split", bg: "#2d72d2", title: "Data Lineage" },
    { m: "ops", x: 194, y: 38, icon: "layers", bg: "#6c5ce7", title: "Workshop" },
  ];
  const shown = nodes.filter((n) => opened.has(n.m));
  if (!shown.length) return null;
  const at = (m: Mode) => shown.find((n) => n.m === m);
  const links: [Mode, Mode][] = [["pipeline", "home"], ["pipeline", "lineage"], ["home", "ops"], ["lineage", "ops"]];
  return (
    <div className="relative h-[104px] shrink-0 border-b border-white/5 bg-[#0d1014]">
      <svg className="absolute inset-0 h-full w-full">{links.map(([a, b]) => { const p = at(a), q = at(b); return p && q ? <line key={a + b} x1={p.x + 13} y1={p.y + 13} x2={q.x + 13} y2={q.y + 13} stroke="#5f6b7c" strokeWidth="1" /> : null; })}</svg>
      {shown.map((n) => <span key={n.m} title={n.title} className="absolute flex h-[26px] w-[26px] items-center justify-center rounded-[4px] text-white ring-2 ring-white/10" style={{ left: n.x, top: n.y, background: n.bg }}><Icon name={n.icon} className="h-3.5 w-3.5" /></span>)}
    </div>
  );
}

// the stacked isometric cube of the reference (decorative)
function Cube({ faded }: { faded: boolean }) {
  const layer = (y: number, o: number) => (
    <g key={y} opacity={o}>
      <polygon points={`80,${y} 150,${y + 38} 80,${y + 76} 10,${y + 38}`} fill="url(#cTop)" />
      <polygon points={`10,${y + 38} 80,${y + 76} 80,${y + 128} 10,${y + 90}`} fill="url(#cL)" />
      <polygon points={`150,${y + 38} 80,${y + 76} 80,${y + 128} 150,${y + 90}`} fill="url(#cR)" />
    </g>
  );
  return (
    <svg viewBox="0 0 160 330" aria-hidden className={`pointer-events-none absolute left-1/2 top-4 h-[min(60%,300px)] -translate-x-1/2 transition-opacity duration-700 ${faded ? "opacity-15" : "opacity-80"}`}>
      <defs>
        <linearGradient id="cTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6b63e6" /><stop offset="1" stopColor="#3b37a8" /></linearGradient>
        <linearGradient id="cL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4c45c9" /><stop offset="1" stopColor="#1e1b5e" stopOpacity=".2" /></linearGradient>
        <linearGradient id="cR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3a34a6" /><stop offset="1" stopColor="#15134a" stopOpacity=".2" /></linearGradient>
      </defs>
      {[layer(150, 0.55), layer(80, 0.75), layer(10, 0.95)]}
    </svg>
  );
}

function ExploreSidebar({ view, setView, active, agentId, setAgentId, ask, onAction }: {
  view: LeftView; setView: (v: LeftView) => void; active: string[]; agentId: string; setAgentId: (id: string) => void; ask: (q: string) => void; onAction: (n: string) => void;
}) {
  const [q, setQ] = useState("");
  const [openSec, setOpenSec] = useState({ props: true, links: true, actions: false });
  const typeRow = (id: string, onClick: () => void, extra?: React.ReactNode) => {
    const o = byId(id);
    return <button key={id} onClick={onClick} className="flex w-full items-center gap-2 px-2.5 py-[5px] text-left font-medium text-[#e5e8eb] hover:bg-white/5"><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-white" style={{ background: o.color }}><Icon name={TYPE_ICON[id] ?? "cube"} className="h-2.5 w-2.5" /></span><span className="min-w-0 flex-1 truncate">{o.name}</span>{extra}</button>;
  };

  if (view.k === "type") {
    const o = byId(view.id);
    const links = EDGES.filter(([a, b]) => a === o.id || b === o.id);
    const acts = ACTIONS.filter((a) => a.on === o.name);
    const head = (key: keyof typeof openSec, label: string, n: number) => <button onClick={() => setOpenSec((s) => ({ ...s, [key]: !s[key] }))} className="flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-[11px] font-semibold text-[#e5e8eb]">{label}<span className="rounded-sm bg-[#383e47] px-1 text-[9.5px] font-normal">{n}</span><Icon name={openSec[key] ? "down" : "right"} className="ml-auto h-3 w-3 text-[#8f99a8]" /></button>;
    return (
      <>
        <div className="flex items-center px-2.5 py-2"><button onClick={() => setView({ k: "list", list: "types" })} className="flex items-center gap-1 font-semibold text-[#e5e8eb] hover:text-white"><Icon name="left" className="h-3 w-3" />Object types</button><Link href="/object-explorer" title="Open in Object Explorer" className="ml-auto text-[#8f99a8] hover:text-white"><Icon name="external" className="h-3.5 w-3.5" /></Link></div>
        <div className="px-2.5 pb-1"><p className="flex items-center gap-2 text-[13px] font-semibold"><span className="flex h-5 w-5 items-center justify-center rounded-full text-white" style={{ background: o.color }}><Icon name={TYPE_ICON[o.id] ?? "cube"} className="h-3 w-3" /></span>{o.name}</p><p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">{o.desc} · {o.count.toLocaleString("id-ID")} objek · {o.freshness}</p></div>
        {head("props", "Property types", o.props.length)}
        {openSec.props && o.props.map((p, i) => <p key={p.name} className="flex items-center gap-2 px-2.5 py-[3px] text-[11.5px] text-[#d3d8de]"><span className="w-4 shrink-0 text-center font-mono text-[9px] text-[#8f99a8]">{glyph(p.type)}</span><span className="min-w-0 flex-1 truncate">{p.name}</span>{i === 0 ? <span className="rounded-sm bg-[#1c6e42]/60 px-1 text-[9.5px] text-[#72ca9b]">Primary key</span> : i === 1 ? <span className="rounded-sm bg-[#383e47] px-1 text-[9.5px] text-[#c5cbd3]">Title</span> : null}</p>)}
        {head("links", "Link types", links.length)}
        {openSec.links && links.map(([a, b, l]) => { const other = a === o.id ? b : a; return <button key={a + b} onClick={() => setView({ k: "type", id: other })} title={l} className="flex w-full items-center gap-1.5 px-2.5 py-[3px] text-left text-[11px] text-[#d3d8de] hover:bg-white/5"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: o.color }} /><Icon name="link" className="h-3 w-3 shrink-0 text-[#8f99a8]" /><span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] text-white" style={{ background: byId(other).color }}><Icon name={TYPE_ICON[other] ?? "cube"} className="h-2.5 w-2.5" /></span><span className="min-w-0 flex-1 truncate">{byId(other).name}</span><span className="shrink-0 text-[9.5px] text-[#8f99a8]">{l}</span><span className="rounded-sm bg-[#383e47] px-1 text-[9px]">Active</span></button>; })}
        {head("actions", "Action types", acts.length)}
        {openSec.actions && acts.map((a) => <button key={a.name} onClick={() => onAction(a.name)} className="flex w-full items-center gap-2 px-2.5 py-[3px] text-left text-[11.5px] text-[#d3d8de] hover:bg-white/5"><Icon name="edit" className="h-3 w-3 text-[#8f99a8]" />{a.name}</button>)}
        <div className="mt-3 space-y-1.5 px-2.5 pb-3">
          <button onClick={() => ask(`Investigasi ${o.name} berisiko dan susun rencana audit`)} className="w-full rounded-sm bg-[#5b5fd6] py-1.5 text-[11.5px] font-medium text-white hover:bg-[#6a6ee0]">Ask agent about {o.name}</button>
          <Link href="/object-explorer" className="block w-full rounded-sm border border-[#383e47] py-1.5 text-center text-[11.5px] text-[#d3d8de] hover:bg-white/5">Explore objects</Link>
        </div>
      </>
    );
  }

  if (view.k === "list") {
    const s = q.toLowerCase();
    const hit = (t: string) => t.toLowerCase().includes(s);
    return (
      <>
        <div className="flex items-center px-2.5 py-1.5 text-[11px] text-[#c5cbd3]"><button onClick={() => { setQ(""); setView({ k: "root" }); }} className="flex items-center gap-1 hover:text-white"><Icon name="left" className="h-3 w-3" />Back</button><button onClick={() => { setQ(""); setView({ k: "root" }); }} aria-label="Close" className="ml-auto hover:text-white"><Icon name="x" className="h-3 w-3" /></button></div>
        <label className="mx-2 mb-1.5 flex items-center gap-1.5 rounded-sm border border-[#2d72d2] bg-[#111418] px-1.5 py-1"><Icon name="search" className="h-3.5 w-3.5 text-[#8f99a8]" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search..." className="w-full bg-transparent text-[11.5px] outline-none placeholder:text-[#8f99a8]" /></label>
        {view.list === "types" && OBJECT_TYPES.filter((o) => hit(o.name)).map((o) => typeRow(o.id, () => setView({ k: "type", id: o.id }), <span className="text-[10px] font-normal tabular-nums text-[#8f99a8]">{o.count.toLocaleString("id-ID")}</span>))}
        {view.list === "agents" && AGENTS.filter((a) => hit(a.name)).map((a) => <button key={a.id} onClick={() => setAgentId(a.id)} className={`block w-full px-2.5 py-1.5 text-left hover:bg-white/5 ${a.id === agentId ? "bg-white/5" : ""}`}><span className="flex items-center gap-1.5 font-medium"><Icon name="bolt" className="h-3 w-3 text-[#f0b14c]" />{a.name}<span className={`ml-auto h-1.5 w-1.5 rounded-full ${a.online ? "bg-emerald-400" : "bg-[#5f6b7c]"}`} /></span><span className="mt-0.5 block text-[10.5px] leading-snug text-[#8f99a8]">{a.desc}</span></button>)}
        {view.list === "actions" && ACTIONS.filter((a) => hit(a.name)).map((a) => <button key={a.name} onClick={() => onAction(a.name)} className="block w-full px-2.5 py-1.5 text-left hover:bg-white/5"><span className="flex items-center gap-1.5 font-medium"><Icon name="edit" className="h-3 w-3 text-[#8f99a8]" />{a.name}</span><span className="block pl-[18px] text-[10.5px] text-[#8f99a8]">on {a.on}</span></button>)}
        {view.list === "logic" && <>{LOGICS.filter((l) => hit(l.name)).map((l) => <Link key={l.name} href={l.href} className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-white/5"><Icon name="logic" className="h-3 w-3 shrink-0 text-[#8f99a8]" /><span className="min-w-0 flex-1 truncate">{l.name}</span><span className="text-[10px] text-[#8f99a8]">{l.runs} runs</span></Link>)}{FUNCTIONS.filter((f) => hit(f.name)).map((f) => <Link key={f.name} href={f.href} className="flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[11px] hover:bg-white/5"><Icon name="code" className="h-3 w-3 text-[#8f99a8]" />{f.name}<span className="text-[#8f99a8]">{f.ver}</span></Link>)}</>}
        {view.list === "files" && FILES.filter((f) => hit(f.name)).map((f) => <Link key={f.name} href={f.href} className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-white/5"><Icon name={f.kind === "Pipeline" ? "pipeline" : f.kind === "Dataset" ? "table" : "folder"} className="h-3 w-3 shrink-0 text-[#8f99a8]" /><span className="min-w-0 flex-1 truncate">{f.name}</span><span className="text-[10px] text-[#8f99a8]">{f.kind}</span></Link>)}
      </>
    );
  }

  return (
    <>
      {active.length > 0 && <>
        <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-[#e5e8eb]">Active objects</p>
        <div className="border-b border-black/30 pb-1.5">{active.map((id) => typeRow(id, () => setView({ k: "type", id })))}</div>
      </>}
      <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-[#e5e8eb]">Explore</p>
      {EXPLORE.map((e) => (
        <button key={e.list} onClick={() => setView({ k: "list", list: e.list })} className="flex w-full items-center gap-2 border-b border-black/20 px-2.5 py-2 text-left hover:bg-white/5">
          <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 font-semibold text-[#f6f7f9]"><Icon name={e.icon} className="h-3.5 w-3.5" />{e.title}</span><span className="mt-0.5 block text-[10.5px] leading-snug text-[#abb3bf]">{e.sub}</span></span>
          <Icon name="right" className="h-3.5 w-3.5 shrink-0 text-[#8f99a8]" />
        </button>
      ))}
    </>
  );
}

/* Ambient ontology view, as in the reference: a faint node network around a glowing violet ring on a slate
   canvas; the ring brightens while the agent works. Not a graph editor — the Explore sidebar is for that. */
function Visualization({ active }: { active: boolean }) {
  const pts = useMemo(() => {
    const out: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < 52; i++) {
      const a = i * 2.39996, rad = 30 + 165 * Math.sqrt((i + 0.5) / 52);
      out.push({ x: 400 + Math.cos(a) * rad * 1.05 + ((i * 37) % 23) - 11, y: 262 + Math.sin(a) * rad * 0.95 + ((i * 53) % 19) - 9, r: 1.3 + (i % 3) * 0.5 });
    }
    return out;
  }, []);
  const lines = useMemo(() => {
    const ls: [number, number][] = [];
    pts.forEach((p, i) => pts.forEach((q, j) => { if (j > i && Math.hypot(p.x - q.x, p.y - q.y) < 105) ls.push([i, j]); }));
    return ls.slice(0, 120);
  }, [pts]);
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#2f3c48]">
      <style>{`@keyframes spinSlow{to{transform:rotate(360deg)}}`}</style>
      <svg viewBox="0 0 800 524" className="h-full w-full" role="img" aria-label="Ontology visualization">
        <defs>
          <radialGradient id="vizGlow"><stop offset="58%" stopColor="#7c6cf0" stopOpacity="0" /><stop offset="80%" stopColor="#8b7cf6" stopOpacity={active ? 0.55 : 0.32} /><stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" /></radialGradient>
        </defs>
        <g style={{ transformOrigin: "400px 262px", animation: `spinSlow ${active ? 40 : 140}s linear infinite` }}>
          <circle cx="400" cy="262" r="200" fill="url(#vizGlow)" style={{ transition: "opacity .6s" }} />
          <circle cx="400" cy="262" r="150" fill="none" stroke="#9d8cff" strokeWidth={active ? 10 : 7} strokeOpacity={active ? 0.75 : 0.45} style={{ filter: "blur(3px)", transition: "all .6s" }} />
          {lines.map(([a, b], i) => <line key={i} x1={pts[a].x} y1={pts[a].y} x2={pts[b].x} y2={pts[b].y} stroke="#dbe6f2" strokeOpacity=".3" strokeWidth=".7" />)}
          {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} fill="#eef3fa" fillOpacity={i % 4 === 0 ? 0.35 : 0.9} />)}
        </g>
      </svg>
    </div>
  );
}
