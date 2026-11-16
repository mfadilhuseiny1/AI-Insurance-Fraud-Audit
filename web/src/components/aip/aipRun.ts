"use client";
import { API_URL } from "@/lib/api";

/* AIP runs (api/aip/runs.py): a question goes to the orchestrator and the domain agents on Google ADK; the page polls
   the run's events — plan, tool steps with their receipts, the validator's verdict, proposals, the dynamic screen. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

export type Receipt = {
  type: "tool"; agent: string; tool: string; args: Rec; ok: boolean; ms: number; summary: string; seq: number; t?: string;
  request?: { endpoint: string; body?: Rec }; rid?: string | null; rows?: number;
  links?: { app: string; type_id?: string; type?: string; pk?: string; node?: string; node_id?: string; id?: string; name?: string; path?: string }[];
};
export type Check = { klaim: string; ok: boolean; bukti?: string };
// a visual of the dynamic screen, bound to a run result (aip/adk_runtime/main.py _spec); y/note/kpi: runs before 2026-10-23
export type Panel = {
  widget: "bar" | "donut" | "line" | "map" | "table" | "text" | "kpi" | "leaderboard" | "contrib"; title: string; insight?: string; rid: string | null; fields: string[];
  label?: string | null; value?: string | null; x?: string | null; series?: string | null; highlight?: string[]; y?: string | null; note?: string | null;
};
export type UiSpec = { title: string; panels: Panel[] };
// the writer's briefing (aip/adk_runtime/agents.py BRIEFING_TASK): every number in it is checked by the validator
export type Briefing = {
  judul: string; ringkasan: string;
  angka_kunci: { label: string; nilai: string; satuan: string; konteks: string; rujukan: string }[];
  temuan: { judul: string; isi: string; tingkat: "kritis" | "tinggi" | "sedang" | "info"; rujukan: string[] }[];
  rekomendasi: { tindakan: string; alasan: string; prioritas: string }[];
  keterbatasan: string[]; jawaban: string;
};
export type AipEvent = Rec & { type: string; seq: number };
export type Run = { id: string; status: string; q: string; spent_usd: number; follow?: string | null; created_at: string; finished_at?: string | null; agents_usage?: Rec; answer?: string; ui_spec?: UiSpec;
  /** an AI Agent Swarm engagement's orchestration: "1.0" (Blu 1.0) or "1.1" (Blu 1.1, the clinical review first) */
  versi?: string;
  /** a Blu 1.1 simulation (api/aip/konsultan.py GET /simulasi): an animation only, no model called */
  simulasi?: boolean };
export type SubAgent = { key: string; name: string; technique: string; family: string; research?: string[] };
export type Agent = { key: string; name: string; description: string; group_id: string | null; model: string; tools: string[]; subagents?: SubAgent[];
  peta?: string; menjawab?: string; object_types: { id: string; name: string; api_name: string; primary_key: string; title: string; description: string; properties: { api_name: string; type: string }[] }[] };
export type Result = { columns: string[]; rows: Rec[]; types?: Record<string, string>; total?: number; title?: string; object_type?: { id: string; name: string } | null };

async function req<T = Rec>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}

type RunData = { run: Run; events: AipEvent[]; next: number };
// A finished run's trail never changes: kept after its first load (the user, 2026-10-30: "kalau udh load gausah loading lagi";
// an engagement's trail is ~9 MB and the swarm tab and its chart each asked for it, on every visit). A running or interrupted
// run is always fetched; two loads of the same run at once share one request. Each caller gets its own copy of the list.
const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
const runCache = new Map<string, Promise<RunData>>();
const copyRun = (r: RunData): RunData => ({ ...r, events: r.events.slice() });

export const aip = {
  agents: () => req<{ agents: Agent[]; roles: Record<string, string>; apps?: Record<string, string>; links?: { id: string; name: string; source: string; target: string }[];
    aturan?: { rencana?: { id: string; model: string; label: string } } }>("/api/aip/agents"),
  // follow: the run this question follows up (the server reads that run's thread as the conversation)
  ask: (q: string, history: { role: string; text: string }[], voice = false, follow?: string) =>
    req<{ run: string }>("/api/aip/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, history, voice, follow }) }),
  run: (id: string, after = 0): Promise<RunData> => {
    if (after !== 0) return req<RunData>(`/api/aip/runs/${id}?after=${after}`);
    let p = runCache.get(id);
    if (!p) {
      p = req<RunData>(`/api/aip/runs/${id}?after=0`);
      runCache.set(id, p);
      p.then((r) => {
        if (!FINISHED.has(r.run.status)) runCache.delete(id);
        while (runCache.size > 8) runCache.delete(runCache.keys().next().value as string);
      }, () => runCache.delete(id));
    }
    return p.then(copyRun);
  },
  runs: () => req<Run[]>("/api/aip/runs?limit=60"),  // turns, grouped into conversations on the page
  result: (id: string, rid: string) => req<Result>(`/api/aip/runs/${id}/results/${rid}`),
  cancel: (id: string) => req(`/api/aip/runs/${id}/cancel`, { method: "POST" }),
  spend: () => req<Rec>("/api/aip/spend"),
  // missions (api/aip/missions.py): every call that changes a mission is a human gate, logged with who and when
  missions: () => req<Rec[]>("/api/aip/missions"),
  mission: (id: string) => req<MissionDetail>(`/api/aip/missions/${id}`),
  newMission: (goal: string) => req<Rec>("/api/aip/missions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal }) }),
  approve: (id: string, budget_usd?: number) => req<Rec>(`/api/aip/missions/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budget_usd }) }),
  extend: (id: string, usd: number, reason: string) => req<Rec>(`/api/aip/missions/${id}/extend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usd, reason }) }),
  waive: (id: string, assertion: string, reason: string) => req<Rec>(`/api/aip/missions/${id}/waive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assertion, reason }) }),
  control: (id: string, action: "pause" | "resume" | "stop") => req<Rec>(`/api/aip/missions/${id}/${action}`, { method: "POST" }),
  // voice (api/aip/voice.py): speech to text and text to speech on OpenAI; the answers stay the run's own
  voiceStatus: () => req<VoiceStatus>("/api/aip/voice/status"),
  transcribe: (audio: Blob) => {
    const form = new FormData();
    form.append("audio", audio, `ucapan.${audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm"}`);
    form.append("language", "id");
    return req<{ text: string; seconds: number; usd: number }>("/api/aip/voice/transcribe", { method: "POST", body: form });
  },
  speak: async (text: string, voice: string) => {
    const r = await fetch(`${API_URL}/api/aip/voice/speak`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
    return { audio: await r.arrayBuffer(), usd: Number(r.headers.get("X-Audio-Usd") ?? 0), similarity: Number(r.headers.get("X-Read-Similarity") ?? 1) };
  },
  // machine learning (api/aip/ml.py): the claim-risk model card, training and the benchmark across techniques
  ml: () => req<MlCard>("/api/aip/ml"),
  mlTrain: (body: { model?: string[]; lipatan?: number }) => req<MlJob>("/api/aip/ml/train", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  mlBenchmark: (body: { tugas: string; model?: string[]; lipatan?: number; provinsi_kode?: number | null }) =>
    req<MlJob>("/api/aip/ml/benchmark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  mlJob: (id: string) => req<MlJob>(`/api/aip/ml/jobs/${id}`),
  mlEvidence: (body: { kapasitas?: number; n_boot?: number }) =>
    req<MlJob>("/api/aip/ml/bukti", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  // the kit's benchmark rule 2: fraud planted in real hospital claims, three dials, held-out types, placebo (admin)
  mlRule2: (body: { n_boot?: number } = {}) =>
    req<MlJob>("/api/aip/ml/aturan2", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
};

export type MlRef = { penulis: string; tahun: number; judul: string; venue: string; url: string; sumber: "consensus" | "web" | "metode"; temuan: string; sitasi: number | null };
type Stat = { mean: number; sd: number };
export type MlBoardRow = {
  model: string; keluarga: string; rujukan: string | null; pembanding: boolean; detik_latih: number; riset?: MlRef[];
  menang?: number; dari?: number; uji_vs_terbaik?: { selisih_auprc: number | null; t: number; p: number; berbeda_nyata: boolean; pasangan: number };
  rata: Record<string, Stat>; gabungan_oof: Record<string, number> & { ci95?: Record<string, [number, number]> };
};
export type MlTask = {
  label: string; papan: MlBoardRow[]; evaluasi: { klaim: number; positif: number; bobot_negatif: number; latih_negatif: number }; terbaik: string;
  ulangan?: number; lipatan?: number; uji?: string;
  temporal?: { batas_uji: string; positif_uji: number; model: Record<string, Record<string, number>> };
  penjelas?: { model: string; metode: { metode: string; keterangan: string; deletion_auc: number; detik_per_klaim: number; stabilitas: number | null; kesepakatan_treeshap: number | null; klaim: number; riset?: MlRef[] }[]; metrik_rujukan?: MlRef[] } | null;
  kepentingan_global?: { fitur: string; label: string; penurunan_auprc: number }[];
  ablasi_undersampling?: { porsi_negatif_latih: number; porsi_semua_negatif: number; auprc: number; auroc: number; f1: number; presisi: number; recall: number; detik: number; baris_latih: number }[];
  porsi_ditandai?: number;
};
export type MlKitHeadline = { precision: number; precision_low: number; precision_high: number; caught: number; caught_low: number; caught_high: number;
  random_expected: number; lift: number; rupiah_recall: number | null; honest_audit: { rate: number; flagged: number; honest: number };
  false_positives?: { rate: number; false_positives: number; honest: number } };
/** a value with its 95% interval, facility profiles resampled (api/aip/ml.py _intervals) */
export type MlInterval = { nilai: number; bawah: number; atas: number };
export type MlEvidenceCard = {
  kartu: {
    conditions: { n: number; prevalence: number; capacity: number; k: number; data_source: string; benchmark: string };
    headline: MlKitHeadline;
    permutation?: { observed: number; null_mean: number; null_q95: number; p_value: number } | null;
    strata?: { stratum: string; value: string; honest_groups: number; flagged: number; rate: number }[] | null;
  };
  kalimat_juri: string;
  negatif_sulit: { kelompok: string; klaim: number; jujur: number; jujur_ditandai: number; porsi_jujur_ditandai: number; porsi_ditandai_keseluruhan: number }[];
  ablasi: { variant: string; precision_at_k: number; ci_low: number; ci_high: number; lift: number; pr_auc: number; honest_group_audit_rate: number;
    rupiah_recall?: number; diff: number | null; diff_low: number | null; diff_high: number | null; p_value: number | null }[];
  interval?: Record<"precision" | "lift" | "recall_at_k" | "rupiah_recall" | "honest_audit", MlInterval | null>;
  auc?: { roc_auc: number; pr_auc: number };
  /** the k audited claims themselves (CSV): rank, score and the verifier's label, to count by hand */
  daftar_audit?: { file: string; klaim: number; dikoreksi: number };
};
export type MlLeak = { feature: string; auc: number; flagged: boolean; penjelasan?: string; auc_pola_klinik?: number; auc_rumah_sakit?: number; dijelaskan?: boolean };
export type MlEvidence = {
  kapasitas: number; catatan_kapasitas: string; hkeval_commit: string; kartu: Record<string, MlEvidenceCard>;
  kebocoran: MlLeak[]; kebocoran_di_atas_0_8: MlLeak[]; kebocoran_rumah_sakit?: MlLeak[];
  /** the preregistered targets, checked by code (lulus null = waiting or not applicable) */
  praregistrasi?: { berkas: string; commit: string; detektor_saat_itu: string;
    target: { metrik: string; kartu: string; ambang: string; nilai: number | null; lulus: boolean | null; catatan: string }[] };
  tidak_berlaku: Record<string, string>;
};
/** the kit's benchmark rule 2 (api/ml_sintetis.py): fraud planted in real hospital claims */
export type MlRule2 = {
  spesifikasi: { modus: Record<string, { label: string; mudah: string; sulit: string }>; kondisi: Record<string, { kesulitan: string; frekuensi: number; klaster: string }>;
    detektor: string; lipatan: number; kapasitas: number; seed: number };
  kondisi: Record<string, { kesulitan: string; frekuensi: number; klaster: string; klaim: number; fraud: number; profil_pelaku: number; k: number; acak_k_per_n: number;
    kartu: { headline: MlKitHeadline; conditions: { prevalence: number; k: number } }; recall_per_modus: { modus: string; n: number; caught: number; recall: number }[];
    pr_auc: number; roc_auc: number }>;
  tahan: Record<string, { label: string; kasus: number; tertangkap: number; recall_at_k: number; acak_k_per_n: number; recall_bila_dilatih: number | null; precision_at_k: number }>;
  plasebo?: { threshold: number; n: number; flagged: number; flagged_groups: number; groups: number; porsi: number; k_tanam: number };
};
export type MlCard = {
  status: "siap" | "belum dilatih"; version?: string; trained_at?: string; model?: { model_id: string; version: string; link: string };
  datasets?: Record<string, string>; bukti?: MlEvidence | null; aturan2?: MlRule2 | null; jobs: { id: string; kind: string; status: string; created_at: string; finished_at?: string; error?: string }[];
  laporan?: {
    label: { nama: string; keterangan: string }; tugas: Record<string, MlTask>;
    segmen: Record<string, { model: string; tugas: string; ambang: number; porsi_ditandai: number; baris_latih: number; positif_latih: number }>;
    keluaran: { klaim: number; ditandai: number; lolos_verifikasi_berisiko: number; faskes: number };
    riset_protokol: { keputusan: string; rujukan: MlRef[] }[]; riset_model: Record<string, MlRef[]>; riset_penjelas: Record<string, MlRef[]>;
  };
};
export type MlJob = { id: string; kind: string; status: string; params: Rec; created_at: string; finished_at?: string; log: string[]; result: Rec | null; error: string | null };

export type VoiceStatus = {
  configured: boolean; reader: string; transcriber: string; default_voice: string; vocabulary: string;
  voices: { name: string; style: string; gender: string }[]; spend: { month: string; usd: number; calls: number; cap_usd: number | null };
};

export type Task = { id: string; milestone: string; agent: string; title: string; instruction: string; status: string; run: string | null };
export type Assertion = { id: string; text: string; status: "open" | "passed" | "failed" | "waived"; evidence?: string; waived_by?: string; waiver_reason?: string };
export type MissionDetail = {
  mission: Rec & { id: string; goal: string; status: string; budget_usd: number | null; spent_usd: number; estimate_usd?: number; proposed_cap_usd?: number; approver?: string; plan?: { summary: string; milestones: { id: string; title: string }[] } };
  tasks: Task[]; contract: Assertion[]; handoffs: Rec[]; validations: Rec[]; runs: (Run & { kind: string })[]; log: { t: string; who: string; what: string; detail: string }[];
};

/** Poll a run until it ends: every new event goes to onEvent, the run as it stands (its spend so far) to onRun; resolves
    with the final run. */
export async function follow(id: string, onEvent: (e: AipEvent) => void, stop?: { current: boolean }, onRun?: (r: Run) => void): Promise<Run> {
  let after = 0;
  for (;;) {
    const r = await aip.run(id, after);
    r.events.forEach(onEvent);
    onRun?.(r.run);
    after = r.next;
    if (r.run.status !== "running" || stop?.current) return r.run;
    await new Promise((res) => setTimeout(res, 900));
  }
}

/** Where a receipt's link opens: the connected app, as the viewer. */
export function appHref(l: NonNullable<Receipt["links"]>[number]): string {
  switch (l.app) {
    case "objects": return `/object-explorer?type=${encodeURIComponent(l.type_id ?? "")}`;
    case "object": return `/object-explorer?type=${encodeURIComponent(l.type_id ?? "")}&q=${encodeURIComponent(l.pk ?? "")}`;
    case "lineage": return l.node_id ? `/lineage?node=${encodeURIComponent(l.node_id)}` : "/lineage";
    case "function": return `/functions/${encodeURIComponent(l.id ?? "")}`;
    case "code": return `/code-repositories/${encodeURIComponent(l.id ?? "")}`;
    default: return "/";
  }
}
export const APP_LABEL: Record<string, string> = { objects: "Object Explorer", object: "Objek", lineage: "Data Lineage", function: "Function", code: "Code Repository" };

/** What an agent wrote, as text: a string as it is, anything else readable — a validator sometimes answers its evidence as
    an object or a list ({ukuran, nilai_total, hasil_id}; [{kelompok, nilai}]), which React cannot render as a child. */
export const txt = (x: unknown): string =>
  x == null ? "" : typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x)
    : Array.isArray(x) ? x.map(txt).join("; ") : typeof x === "object" ? Object.entries(x as Rec).map(([k, v]) => `${k}: ${txt(v)}`).join(", ") : String(x);
export const usd = (n: number | undefined) => (n == null ? "—" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
const WIB = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23" });
/** A time from the API in Western Indonesia Time (the user, 2026-10-24: "timestamp pake WIB"): "2026-10-24 08:15 WIB". The API
    writes UTC, with an offset ("…+00:00") or without one (event times "2026-10-24T01:15:26"), which is UTC too. */
export const wib = (iso?: string | null, seconds = false): string => {
  if (!iso) return "";
  const s = String(iso);
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace("T", " ");
  const p = Object.fromEntries(WIB.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${seconds ? `:${p.second}` : ""} WIB`;
};
// display the model of a role without the route prefix; OpenAI's Decisions API by its name (api/aip/models.py DECISIONS)
const NAMED: Record<string, string> = { "openai/gpt-6-luna": "OpenAI Decisions · gpt-6-luna" };
export const modelName = (id?: string) => NAMED[id ?? ""] ?? (id ?? "").split("/").pop()?.replace(/-maas$/, "") ?? "";
