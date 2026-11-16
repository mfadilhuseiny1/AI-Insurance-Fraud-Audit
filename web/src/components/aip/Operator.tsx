"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import { aip, modelName, usd, wib, type AipEvent, type Rec, type Result, type Run } from "@/components/aip/aipRun";
import { useTampilBiaya } from "@/components/aip/biaya";
import { Konstelasi } from "@/components/aip/Konstelasi";

/* AIP Operator (api/aip/adk_runtime/operator.py): the Agen tab's conversation — one agent with a tool per app of AIP JKN,
   shown like the operator of Palantir AIP (the user, 2026-10-28: "kayak Palantir AIP bisa tool calling ke informasi yg ada
   di" every tab, "UI nya juga enak"): each step says what it read in which app, with a chip that opens that app beside the
   conversation; the answer cites its steps, its numbers are checked by code, and next steps are one click away. The steps
   show while it works and fold into one line under the answer, like Claude ("kalau jawab pasti ada log nya cuman auto hide
   … tapi bisa di show"). The same conversation docks beside any other tab (one store for the page). */

/** the apps a step reads, and the tab each opens (the production service has no tab of its own) */
export const APPS: Record<string, { label: string; icon: IconName; tab?: string }> = {
  konsultan: { label: "AI Agent Swarm", icon: "graph", tab: "konsultan" },
  agents: { label: "Agen", icon: "sparkle", tab: "agents" },
  ml: { label: "ML Studio", icon: "cpu", tab: "ml" },
  karantina: { label: "Box Karantina", icon: "lock", tab: "karantina" },
  produksi: { label: "Layanan produksi", icon: "server" },
  kontrol: { label: "Evaluasi Swarm", icon: "sliders", tab: "kontrol" },
  akses: { label: "Keamanan & Akses", icon: "eye", tab: "akses" },
  objects: { label: "Nexus", icon: "cube", tab: "objects" },
  lineage: { label: "Data Lineage", icon: "split", tab: "lineage" },
  pipeline: { label: "Pipeline Builder", icon: "pipeline", tab: "pipeline" },
};

// tool → [the kind of step, what it does, the app it reads]
const TOOLS: Record<string, [string, string, string]> = {
  penugasan_swarm: ["Baca", "Penugasan AI Agent Swarm", "konsultan"], laporan_swarm: ["Baca", "Laporan AI Agent Swarm", "konsultan"],
  tim_swarm: ["Baca", "Tim AI Agent Swarm", "konsultan"],
  berkas_kasus: ["Baca", "Berkas kasus", "konsultan"], paket_audit: ["Analisis", "Paket audit", "konsultan"],
  jaringan_agen: ["Baca", "Jaringan agen", "agents"], analisis_agen: ["Agen", "Analisis mendalam", "agents"],
  ml_studio: ["Baca", "Model & run", "ml"], kartu_model_ml: ["Baca", "Kartu model", "ml"], kartu_bukti_model: ["Baca", "Kartu bukti model", "ml"],
  skor_risiko_klaim_ml: ["Cari", "Skor risiko klaim", "ml"], risiko_faskes_ml: ["Cari", "Risiko faskes", "ml"], jelaskan_klaim_ml: ["Jelaskan", "Alasan skor klaim", "ml"],
  verifikasi_klaim: ["Verifikasi", "Klaim lewat /verify", "produksi"], pipeline_produksi: ["Baca", "Model terpasang & /verify", "produksi"],
  box_karantina: ["Cari", "Faskes di box", "karantina"], faskes_karantina: ["Baca", "Faskes di box", "karantina"],
  aturan_indikasi: ["Baca", "Aturan indikasi", "karantina"], indikasi_fraud: ["Baca", "Indikasi fraud", "karantina"],
  estimasi_kerugian_klaim: ["Hitung", "Estimasi kerugian", "karantina"], evaluasi_kontrol: ["Baca", "Biaya & validator", "kontrol"],
  evaluasi_swarm: ["Nilai", "Mutu penugasan Swarm", "kontrol"],
  keamanan_akses: ["Baca", "Akses per peran", "akses"], skema_nexus: ["Baca", "Skema", "objects"], cari_objek: ["Cari", "Objek", "objects"],
  agregasi_objek: ["Hitung", "Agregasi", "objects"], detail_objek: ["Baca", "Detail objek", "objects"], objek_terkait: ["Telusuri", "Objek terkait", "objects"],
  jalankan_fungsi: ["Jalankan", "Fungsi", "objects"], telusuri_lineage: ["Telusuri", "Hulu & hilir", "lineage"], cari_nexus: ["Cari", "Graf pengetahuan", "lineage"],
  baca_kode: ["Baca", "Kode", "lineage"], pipeline_builder: ["Baca", "Pipeline", "pipeline"], buka_aplikasi: ["Buka", "Aplikasi", ""],
};

// what to ask each app, on the empty screen (and the dock of that tab)
const STARTERS: [string, string][] = [
  ["konsultan", "Ringkas temuan utama penugasan AI Agent Swarm terakhir"],
  ["karantina", "Faskes mana di kelompok A Box Karantina, dan berapa estimasi kerugiannya?"],
  ["ml", "Seberapa andal model ML produksi, dan model mana yang terbaik per segmen?"],
  ["kontrol", "Berapa biaya model hari ini, dan validator mana yang paling sering gagal?"],
  ["akses", "Peran mana yang tidak bisa membaca Data Bersih, dan kenapa?"],
  ["objects", "Lima provinsi dengan klaim berisiko terbanyak"],
  ["lineage", "Dari mana dataset klaim_berisiko berasal? Buka di Data Lineage."],
  ["pipeline", "Apa saja keluaran pipeline Fakta Klaim?"],
];

export type Turn = { id: string; q: string; status: string; events: AipEvent[]; spent?: number; created?: string };
type State = { turns: Turn[]; busy: boolean; err: string };

// one conversation for the page: the Agen tab and the dock beside the other tabs show the same store
let store: State = { turns: [], busy: false, err: "" };
const subs = new Set<() => void>();
const put = (f: (s: State) => State) => { store = f(store); subs.forEach((s) => s()); };
const setTurn = (id: string, f: (t: Turn) => Turn) => put((s) => ({ ...s, turns: s.turns.map((t) => (t.id === id ? f(t) : t)) }));
// what a live run does on the page: open an app (a "nav" event), refresh the history when it ends — set by the mounted view
const hooks: { nav?: (tab: string, target: Rec) => void; done?: () => void } = {};
let epoch = 0; // a new conversation stops following the old one

function useStore(): State {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => store, () => store);
}

// the conversation on screen survives a reload of the page (like a chat): its latest turn, per browser tab
const LAST = "bluesandai.aip.operator.last";
const remember = (id: string | null) => {
  try {
    if (id) sessionStorage.setItem(LAST, id);
    else sessionStorage.removeItem(LAST);
  } catch {
    /* private window or storage off: the conversation lives in memory only */
  }
};
const remembered = (): string | null => {
  try {
    return sessionStorage.getItem(LAST);
  } catch {
    return null;
  }
};

async function track(id: string, live: boolean) {
  const mine = epoch;
  try {
    // polled quicker than the shared follow(): the answer is written in pieces, and a chat should show them as they come
    let after = 0;
    let run: Run;
    for (;;) {
      const r = await aip.run(id, after);
      if (mine !== epoch) return;
      const fresh = r.events;
      after = r.next;
      if (fresh.length) {
        setTurn(id, (t) => ({ ...t, events: [...t.events, ...fresh.filter((e) => !t.events.some((x) => x.seq === e.seq))] }));
        if (live) fresh.filter((e) => e.type === "nav").forEach((e) => hooks.nav?.(String(e.tab), (e.target as Rec) ?? {}));
      }
      setTurn(id, (t) => ({ ...t, status: r.run.status, spent: r.run.spent_usd }));
      run = r.run;
      if (run.status !== "running") break;
      const writing = fresh.some((e) => e.type === "delta") || fresh.at(-1)?.type === "delta";
      await new Promise((res) => setTimeout(res, writing ? 250 : 600));
    }
    if (mine === epoch) setTurn(id, (t) => ({ ...t, status: run.status, spent: run.spent_usd }));
  } catch (e) {
    if (mine === epoch) put((s) => ({ ...s, err: `Koneksi ke run terputus: ${(e as Error).message}` }));
  } finally {
    if (mine === epoch) put((s) => ({ ...s, busy: false }));
    hooks.done?.();
  }
}

/** ask the operator; a turn continues the conversation on screen (its thread is read on the server) */
export async function askOperator(q: string, tab: string) {
  const text = q.trim();
  if (!text || store.busy) return;
  const prev = store.turns.at(-1);
  put((s) => ({ ...s, busy: true, err: "" }));
  try {
    const r = await fetch(`${API_URL}/api/aip/operator`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, follow: prev?.id ?? null, tab }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
    const { run } = (await r.json()) as { run: string };
    remember(run);
    put((s) => ({ ...s, turns: [...s.turns, { id: run, q: text, status: "running", events: [], created: new Date().toISOString() }] }));
    hooks.done?.();
    await track(run, true);
  } catch (e) {
    put((s) => ({ ...s, busy: false, err: (e as Error).message }));
  }
}

/** a new conversation */
export function clearOperator() {
  epoch++;
  remember(null);
  put(() => ({ turns: [], busy: false, err: "" }));
}

/** open an earlier conversation at its turn `id`: the turns it followed, oldest first (each turn names the one it
 *  follows; `runs`, when the page has them, saves a request per turn) */
export async function openOperator(id: string, runs: Run[] = [], restoring = false) {
  epoch++;
  remember(id);
  const mine = epoch;
  put(() => ({ turns: [], busy: false, err: "" }));
  const byId = new Map(runs.map((r) => [r.id, r]));
  const turns: Turn[] = [];
  try {
    for (let x: string | null | undefined = id; x && turns.length < 20 && !turns.some((t) => t.id === x);) {
      const r = await aip.run(x, 0);
      turns.unshift({ id: x, q: r.run.q, status: r.run.status, events: r.events, spent: r.run.spent_usd, created: r.run.created_at });
      x = r.run.follow ?? byId.get(x)?.follow;
    }
  } catch (e) {
    // a turn kept from an earlier visit that is gone (deleted, another account): start empty, without an error
    if (restoring && !turns.length) { remember(null); return; }
    if (mine === epoch) put((s) => ({ ...s, err: (e as Error).message }));
  }
  if (mine !== epoch) return;
  const running = turns.at(-1)?.status === "running";
  put(() => ({ turns, busy: running, err: "" }));
  if (running) await track(turns.at(-1)!.id, true);
}

/** the runs of the conversation on screen (the history marks it) */
export function useOperatorIds(): string[] {
  const turns = useStore().turns;
  return useMemo(() => turns.map((t) => t.id), [turns]);
}

// ------------------------------------------------------------------------------------------------ the view

type Props = {
  mode: "full" | "dock";
  /** the tab the user has open: the operator's context, and the dock's suggestions */
  tab: string;
  onNav: (tab: string, target: Rec) => void;
  /** open a run of the agents' full pipeline (analisis_agen) */
  onOpenRun: (id: string) => void;
  onDone?: () => void;
  onClose?: () => void;
  onExpand?: () => void;
};

export function Operator({ mode, tab, onNav, onOpenRun, onDone, onClose, onExpand }: Props) {
  const s = useStore();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const dock = mode === "dock";
  useEffect(() => { hooks.nav = onNav; hooks.done = onDone; }, [onNav, onDone]);
  // back to the conversation this browser tab had open before a reload
  useEffect(() => {
    const kept = remembered();
    if (kept && !store.turns.length && !store.busy) openOperator(kept, [], true);
  }, []);

  const send = (text: string) => {
    if (!text.trim() || s.busy) return;
    pinned.current = true;
    askOperator(text, tab);
  };
  // the view follows the newest step while the reader is at the bottom
  const size = s.turns.reduce((n, t) => n + t.events.length, 0) + s.turns.length;
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [size]);
  const last = s.turns.at(-1);
  const empty = !s.turns.length;
  const starters = dock ? [...STARTERS.filter(([a]) => a === tab), ...STARTERS.filter(([a]) => a !== tab)].slice(0, 4) : STARTERS;

  return (
    <div className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden text-[13px] text-[#e8ecf0] ${dock
      ? "w-[380px] shrink-0 border-l border-white/10 bg-[#1f262d] max-md:hidden"
      : "flex-1 bg-[radial-gradient(ellipse_at_50%_30%,#34414d_0%,#2a343e_45%,#222a32_100%)]"}`} data-aip-operator={mode}>
      {!dock && (
        <Konstelasi level={empty ? 1 : s.busy ? 0.42 : 0.14}
          className={`absolute left-1/2 -translate-x-1/2 transition-all duration-700 ${empty ? "top-[1vh] h-[min(46vh,540px)] w-[min(46vh,540px)]" : "top-[12vh] h-[min(70vh,720px)] w-[min(70vh,720px)] opacity-70"}`} />
      )}
      {dock && (
        <div className="relative z-10 flex h-10 shrink-0 items-center gap-2 border-b border-white/[.07] px-3">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-[#8b7cff] to-[#5b5fd6]"><Icon name="sparkle" className="h-3 w-3 text-white" /></span>
          <span className="font-semibold text-white">AIP Operator</span>
          <span className="ml-auto flex gap-0.5">
            <button onClick={() => clearOperator()} disabled={empty} title="Percakapan baru" className="rounded-md p-1.5 text-[#a9b3be] hover:bg-white/10 hover:text-white disabled:opacity-30"><Icon name="plus" className="h-3.5 w-3.5" /></button>
            {onExpand && <button onClick={onExpand} title="Buka percakapan penuh di tab Agen" className="rounded-md p-1.5 text-[#a9b3be] hover:bg-white/10 hover:text-white"><Icon name="fit" className="h-3.5 w-3.5" /></button>}
            {onClose && <button onClick={onClose} title="Tutup" className="rounded-md p-1.5 text-[#a9b3be] hover:bg-white/10 hover:text-white"><Icon name="x" className="h-3.5 w-3.5" /></button>}
          </span>
        </div>
      )}

      {empty && !dock ? (
        /* the text starts below the ring (its radius is 0.34 of the backdrop): at 1366×768 the title sat in the ring's lines */
        <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-[calc(min(46vh,540px)*0.84+1vh)]">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#b7adff]">AIP Operator</p>
          <h1 className="mt-2 text-center text-[28px] font-semibold tracking-tight text-white">Apa yang ingin Anda lakukan?</h1>
          <p className="mt-2 max-w-[560px] text-center text-[13px] leading-relaxed text-[#a9b3be]">
            Satu asisten di atas semua tab AIP JKN: membaca datanya lewat tool, membuka aplikasinya di samping percakapan, dan
            memeriksa setiap angka jawabannya terhadap hasil tool.
          </p>
          <div className="mt-6 w-full max-w-[720px]"><Composer busy={s.busy} onSend={send} big /></div>
          <div className="mt-5 flex max-w-[860px] flex-wrap justify-center gap-2">
            {starters.map(([app, text]) => (
              <button key={text} onClick={() => send(text)}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-[#1b2229]/70 px-3 py-1.5 text-[12px] text-[#d5dbe1] backdrop-blur transition hover:border-[#9d8cff]/60 hover:bg-[#2b2f45]/80 hover:text-white">
                <Icon name={APPS[app].icon} className="h-3.5 w-3.5 shrink-0 text-[#a99bff]" />{text}
              </button>
            ))}
          </div>
          {s.err && <p className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{s.err}</p>}
        </div>
      ) : (
        <>
          <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}
            className="relative z-10 min-h-0 flex-1 overflow-y-auto">
            <div className={dock ? "space-y-5 px-3.5 py-4" : "mx-auto w-full max-w-[800px] space-y-8 px-6 pb-10 pt-8"}>
              {empty && <DockEmpty starters={starters} onAsk={send} />}
              {s.turns.map((t, i) => (
                <TurnView key={t.id} turn={t} dock={dock} last={i === s.turns.length - 1} busy={s.busy} onNav={onNav} onOpenRun={onOpenRun} onAsk={send} />
              ))}
              {s.err && <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{s.err}</p>}
            </div>
          </div>
          <div className={`relative z-10 shrink-0 ${dock ? "border-t border-white/[.07] p-2.5" : "px-6 pb-5 pt-2"}`}>
            <div className={dock ? "" : "mx-auto max-w-[800px]"}>
              <Composer busy={s.busy} onSend={send} onStop={last && s.busy ? () => aip.cancel(last.id).catch(() => {}) : undefined}
                placeholder={last ? "Tanyakan lanjutan, atau minta buka aplikasinya…" : undefined} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Composer({ busy, onSend, onStop, placeholder, big }: { busy: boolean; onSend: (q: string) => void; onStop?: () => void; placeholder?: string; big?: boolean }) {
  const [q, setQ] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [q]);
  const go = () => {
    if (!q.trim() || busy) return;
    onSend(q);
    setQ("");
  };
  return (
    <div className={`group rounded-2xl border border-white/[.12] bg-[#161c22]/85 shadow-[0_8px_30px_rgba(0,0,0,.35)] backdrop-blur transition focus-within:border-[#8b7cff]/70 focus-within:shadow-[0_0_0_3px_rgba(139,124,255,.15),0_8px_30px_rgba(0,0,0,.35)]`}>
      <textarea ref={ta} value={q} onChange={(e) => setQ(e.target.value)} rows={1} data-aip-operator-input
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }}
        placeholder={placeholder ?? "Tanyakan tentang klaim, faskes, model, akses, lineage…"}
        className={`block w-full resize-none bg-transparent px-4 text-white outline-none placeholder:text-[#7d8894] ${big ? "min-h-[56px] pt-4 text-[14px]" : "min-h-[44px] pt-3 text-[13px]"}`} />
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
        <span className="truncate text-[11px] text-[#6f7a86]">Enter kirim · Shift+Enter baris baru · setiap angka diperiksa kode</span>
        {onStop ? (
          <button onClick={onStop} title="Hentikan" className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-white" />
          </button>
        ) : (
          <button onClick={go} disabled={busy || !q.trim()} title="Kirim" data-aip-operator-send
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#8b7cff] to-[#5b5fd6] text-white shadow-[0_2px_10px_rgba(110,96,255,.45)] transition hover:brightness-110 disabled:from-white/10 disabled:to-white/10 disabled:shadow-none disabled:text-[#6f7a86]">
            <Icon name="right" className="h-4 w-4 -rotate-90" />
          </button>
        )}
      </div>
    </div>
  );
}

function DockEmpty({ starters, onAsk }: { starters: [string, string][]; onAsk: (q: string) => void }) {
  return (
    <div className="pt-1">
      <div className="relative mx-auto -mb-6 h-[200px] w-[200px]"><Konstelasi level={0.9} className="absolute inset-0 h-full w-full" /></div>
      <p className="text-center text-[16px] font-semibold text-white">Apa yang ingin Anda lakukan?</p>
      <p className="mx-auto mt-1 max-w-[320px] text-center text-[11.5px] leading-snug text-[#a9b3be]">Operator membaca tab ini dan tab lainnya lewat tool, lalu membukanya di sebelah kiri.</p>
      <div className="mt-4 space-y-1.5">
        {starters.map(([app, text]) => (
          <button key={text} onClick={() => onAsk(text)} className="flex w-full items-start gap-2.5 rounded-xl border border-white/[.08] bg-white/[.03] px-3 py-2 text-left text-[12px] text-[#d5dbe1] transition hover:border-[#9d8cff]/50 hover:bg-white/[.06] hover:text-white">
            <Icon name={APPS[app].icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#a99bff]" />{text}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ one turn

// an answer's tables: a soft framed box with row lines, not the black-headed grid of the shared markdown style
const TABLES = "[&_.md-table]:my-2 [&_.md-table]:w-fit [&_.md-table]:max-w-full [&_.md-table]:rounded-lg [&_.md-table]:border [&_.md-table]:border-white/[.09] "
  // "!": the shared .md-body th/td rules are outside Tailwind's layers and would win over these (the header stayed black)
  + "[&_.md-table]:bg-white/[.02] [&_th]:border-0! [&_th]:bg-white/[.05]! [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:font-medium [&_th]:text-[#b6bfc9] "
  + "[&_td]:border-0! [&_td]:border-t! [&_td]:border-white/[.06]! [&_td]:px-2.5 [&_td]:py-1.5 [&_tr:hover_td]:bg-white/[.03] "
  // a short value stays on one line ("GLM-5.2" broke at its hyphen); in the narrow dock a column keeps a readable width
  // and the table scrolls, instead of one word per line
  + "[&_td[data-nw]]:whitespace-nowrap";
const DOCK_TABLES = "[&_td]:min-w-[84px] [&_th]:whitespace-nowrap";
/** marks the short cells of the rendered tables (no markup inside), which TABLES keeps on one line */
const shortCells = (html: string) => html.replace(/<td([^>]*)>([^<]{1,24})<\/td>/g, "<td$1 data-nw>$2</td>");

type Step = { e: AipEvent; n: number; results: AipEvent[]; subs: AipEvent[] };
type Item = { kind: "step"; step: Step } | { kind: "note" | "nav" | "error" | "sub"; e: AipEvent };

const toDate = (s?: string) => (s ? new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).getTime() : NaN);
const secs = (n: number) => (n < 60 ? `${Math.round(n)} dtk` : `${Math.floor(n / 60)} mnt ${Math.round(n % 60)} dtk`);

function TurnView({ turn, dock, last, busy, onNav, onOpenRun, onAsk }: {
  turn: Turn; dock: boolean; last: boolean; busy: boolean; onNav: Props["onNav"]; onOpenRun: Props["onOpenRun"]; onAsk: (q: string) => void;
}) {
  const tampilBiaya = useTampilBiaya();
  const [open, setOpen] = useState<number | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [copied, setCopied] = useState(false);
  const ev = turn.events;
  // the steps in order; a step's results (emitted while its tool ran) and a delegated analysis' progress belong to it
  const { items, ridStep, steps } = useMemo(() => {
    const items: Item[] = [];
    const ridStep: Record<string, Step> = {};
    const steps: Step[] = [];
    let pending: AipEvent[] = [];
    let subsAcc: AipEvent[] = [];
    let opened: AipEvent | null = null; // an app opened by the step still running: shown after that step
    for (const e of ev) {
      if (e.type === "result") pending.push(e);
      else if (e.type === "sub_run" || e.type === "sub_step") subsAcc.push(e);
      else if (e.type === "tool") {
        const step: Step = { e, n: steps.length + 1, results: pending, subs: e.tool === "analisis_agen" ? subsAcc : [] };
        if (e.tool === "analisis_agen") subsAcc = [];
        pending.forEach((r) => { ridStep[String(r.rid)] = step; });
        if (e.rid) ridStep[String(e.rid)] = step;
        pending = [];
        steps.push(step);
        items.push({ kind: "step", step });
        if (opened && e.tool === "buka_aplikasi") { items.push({ kind: "nav", e: opened }); opened = null; }
      } else if (e.type === "catatan") items.push({ kind: "note", e });
      else if (e.type === "catatan_sistem") items.push({ kind: "error", e: { ...e, message: e.text, sistem: true } });
      else if (e.type === "nav") opened = e;
      else if (e.type === "error") items.push({ kind: "error", e });
    }
    if (opened) items.push({ kind: "nav", e: opened });
    if (subsAcc.length) items.push({ kind: "sub", e: { type: "sub", seq: -1, events: subsAcc } });
    return { items, ridStep, steps };
  }, [ev]);
  const answer = ev.find((e) => e.type === "answer");
  const check = ev.filter((e) => e.type === "cek_angka").at(-1);
  const started = ev.find((e) => e.type === "run");
  const navs = ev.filter((e) => e.type === "nav");
  const running = turn.status === "running";
  const failed = !running && !answer;
  // the answer as it is being written: the pieces of its latest attempt (2 = the number revision), until the answer is out
  const seg = Math.max(0, ...ev.filter((e) => e.type === "delta").map((e) => Number(e.seg ?? 1)));
  const draft = !answer && seg ? ev.filter((e) => e.type === "delta" && Number(e.seg ?? 1) === seg).map((e) => String(e.text ?? "")).join("")
    .replace(/\n?[ \t*_>-]*(?:SARAN|Saran|Langkah berikutnya)\s*[*_]*\s*:[\s\S]*$/, "") : "";
  const writing = running && !!draft;
  // like Claude: the steps show while the work goes on, and fold into one line once the answer is being written
  const expanded = (running && !writing) || showSteps || failed;
  const took = (toDate(String(answer?.t ?? ev.at(-1)?.t ?? "")) - toDate(turn.created)) / 1000;
  const apps = [...new Set(steps.map((s) => String(s.e.app ?? TOOLS[String(s.e.tool)]?.[2] ?? "")).filter((a) => APPS[a]))];
  const lastNote = [...ev].reverse().find((e) => e.type === "catatan");
  // the tool being read right now: its start came after the last finished step (the API's reads can take a while)
  const lastTool = [...ev].reverse().find((e) => e.type === "tool" || e.type === "tool_mulai");
  const reading = lastTool?.type === "tool_mulai" ? lastTool : undefined;
  const readingLabel = reading ? (() => {
    const [, what, app] = TOOLS[String(reading.tool)] ?? ["", String(reading.tool), ""];
    const scope = scopeOf({ ...reading, type: "tool" } as AipEvent);
    return `${APPS[app] ? `${APPS[app].label} · ` : ""}${what}${scope ? ` · ${scope}` : ""}`;
  })() : "";

  const shown = answer ? String(answer.text ?? "") : draft;
  const html = useMemo(() => {
    if (!shown) return "";
    // a citation is a chip to the step that read it; one of no step of this turn (a report's own [r1443]) is left out
    return shortCells(renderMarkdown(shown)).replace(/\s?\[(r\d+(?:\s*,\s*r\d+)*)\]/g, (_, ids: string) => ids.split(/\s*,\s*/).map((rid) => {
      const st = ridStep[rid];
      if (!st) return "";
      const title = (st.results.find((r) => r.rid === rid)?.title as string | undefined) ?? TOOLS[String(st.e.tool)]?.[1] ?? rid;
      return ` <button type="button" data-rid="${rid}" title="${String(title).replace(/"/g, "&quot;")}" class="aip-cite">${st.n}</button>`;
    }).join(""));
  }, [shown, ridStep]);

  const cite = (rid: string | null | undefined) => {
    const st = rid ? ridStep[rid] : undefined;
    if (!st) return;
    setShowSteps(true);
    setOpen(st.n);
    setTimeout(() => document.querySelector(`[data-aip-turn="${turn.id}"] [data-aip-step="${st.n}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
  };

  return (
    <section className="space-y-3" data-aip-turn={turn.id}>
      <div className="flex justify-end">
        <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-white/[.08] bg-white/[.07] px-3.5 py-2 leading-relaxed text-white backdrop-blur ${dock ? "text-[12.5px]" : "text-[13.5px]"}`}>{turn.q}</p>
      </div>
      <div className="flex gap-3">
        <span className={`mt-0.5 flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#8b7cff] to-[#5b5fd6] shadow-[0_2px_12px_rgba(110,96,255,.35)] ${dock ? "h-5 w-5" : "h-6 w-6"} ${running ? "animate-pulse" : ""}`}>
          <Icon name="sparkle" className={`${dock ? "h-3 w-3" : "h-3.5 w-3.5"} text-white`} />
        </span>
        <div className="min-w-0 flex-1 space-y-2.5">
          {/* the work: live while it runs, then one line that opens it */}
          {(steps.length > 0 || running || items.length > 0) && (
            <div className={expanded && !running ? "rounded-xl border border-white/[.08] bg-[#151b21]/60 p-2.5" : ""}>
              {(!running || writing) && (
                <button onClick={() => setShowSteps(!showSteps)} aria-expanded={expanded} data-aip-steps-toggle
                  className="flex max-w-full items-center gap-1.5 text-[12px] text-[#a9b3be] hover:text-white">
                  <Icon name="right" className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
                  <span className="flex shrink-0 -space-x-1">
                    {apps.slice(0, 4).map((a) => <span key={a} className="flex h-4 w-4 items-center justify-center rounded-full bg-[#2b333c] ring-1 ring-[#1f262d]"><Icon name={APPS[a].icon} className="h-2.5 w-2.5 text-[#c4b5fd]" /></span>)}
                  </span>
                  <span className="truncate">
                    {steps.length ? `${apps.length ? `Membaca ${apps.map((a) => APPS[a].label).join(", ")}` : "Bekerja"} · ${steps.length} langkah` : "Tanpa tool"}
                    {Number.isFinite(took) && took > 0 ? ` · ${secs(took)}` : ""}
                  </span>
                </button>
              )}
              {expanded && (
                <div className={`space-y-1.5 ${!running || writing ? "mt-2" : ""}`}>
                  {items.map((it, i) => it.kind === "step" ? (
                    <StepRow key={i} step={it.step} turn={turn.id} dock={dock} open={open === it.step.n}
                      onToggle={() => setOpen(open === it.step.n ? null : it.step.n)} onNav={onNav} onOpenRun={onOpenRun} />
                  ) : it.kind === "note" ? (
                    <p key={i} className="border-l-2 border-[#8b7cff]/60 pl-2.5 text-[12px] italic leading-snug text-[#c9cfd6]">{String(it.e.text)}</p>
                  ) : it.kind === "nav" ? (
                    <NavPill key={i} e={it.e} onNav={onNav} />
                  ) : it.kind === "sub" ? (
                    <SubRun key={i} events={it.e.events as AipEvent[]} onOpenRun={onOpenRun} />
                  ) : (
                    <p key={i} className={`text-[11.5px] ${it.e.sistem ? "italic text-[#8f99a8]" : "text-red-300/90"}`}>{String(it.e.message ?? "").slice(0, 300)}</p>
                  ))}
                  {running && !writing && (
                    <div className="flex items-center gap-2 text-[12px] text-[#a9b3be]">
                      <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#8b7cff]/30 border-t-[#a99bff]" aria-label="bekerja" />
                      <span className="truncate">{answer ? "Memeriksa angka…" : reading ? `Membaca ${readingLabel}…`
                        : steps.length ? "Menyusun jawaban dari hasil tool…" : lastNote ? "Membaca data…" : "Memilih tool…"}</span>
                      <Elapsed since={turn.created ?? started?.t} />
                    </div>
                  )}
                  {!running && started?.model && (
                    <p className="pt-1 text-[10.5px] text-[#6f7a86]">model {modelName(String(started.model))}{tampilBiaya && turn.spent != null ? ` · ${usd(turn.spent)}` : ""} · klik langkah untuk melihat argumen, endpoint dan barisnya</p>
                  )}
                </div>
              )}
            </div>
          )}

          {shown && (
            <div className={`md-body leading-relaxed text-[#e8ecf0] ${dock ? `text-[12.5px] ${DOCK_TABLES}` : "text-[14px]"} ${TABLES} [&_.aip-cite]:mx-[1px] [&_.aip-cite]:inline-flex [&_.aip-cite]:h-[15px] [&_.aip-cite]:min-w-[15px] [&_.aip-cite]:-translate-y-[1px] [&_.aip-cite]:items-center [&_.aip-cite]:justify-center [&_.aip-cite]:rounded-[4px] [&_.aip-cite]:bg-[#8b7cff]/25 [&_.aip-cite]:px-[3px] [&_.aip-cite]:align-middle [&_.aip-cite]:text-[9.5px] [&_.aip-cite]:font-semibold [&_.aip-cite]:text-[#d4ccff] [&_.aip-cite:hover]:bg-[#8b7cff] [&_.aip-cite:hover]:text-white [&_strong]:text-white [&_h2]:mt-3 [&_h3]:mt-3 [&_.md-table]:my-2`}
              onClick={(e) => cite((e.target as HTMLElement).closest("[data-rid]")?.getAttribute("data-rid"))}
              dangerouslySetInnerHTML={{ __html: html }} data-aip-answer />
          )}

          {writing && (
            <div className="flex items-center gap-2 text-[11.5px] text-[#8f99a8]" aria-label="bekerja">
              <span className="inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-[#a99bff]" />
              <span>{seg >= 2 ? "Merevisi angka agar sesuai hasil tool…" : ev.at(-1)?.type === "delta" ? "Menulis…" : "Memeriksa angka…"}</span>
              <Elapsed since={turn.created ?? started?.t} />
            </div>
          )}

          {answer && !running && navs.length > 0 && !expanded && (
            <div className="flex flex-wrap gap-1.5">{navs.map((n, i) => <NavPill key={i} e={n} onNav={onNav} small />)}</div>
          )}

          {answer && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-[#7d8894]">
              {check && <NumberCheck check={check} />}
              {turn.created && <span className="tabular-nums">{wib(turn.created)}</span>}
              {tampilBiaya && turn.spent != null && <span className="tabular-nums">{usd(turn.spent)}</span>}
              <button onClick={() => { navigator.clipboard?.writeText(String(answer.text ?? "")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/[.06] hover:text-white" title="Salin jawaban">
                <Icon name={copied ? "check" : "copy"} className="h-3 w-3" />{copied ? "Disalin" : "Salin"}
              </button>
            </div>
          )}

          {failed && (
            <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
              {turn.status === "cancelled" ? "Dihentikan." : `Operator berhenti tanpa jawaban (${turn.status}). ${String(ev.filter((e) => e.type === "error").at(-1)?.message ?? "")}`}
            </p>
          )}

          {answer && last && !busy && ((answer.saran as string[] | undefined) ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1" data-aip-next>
              {(answer.saran as string[]).map((x) => (
                <button key={x} onClick={() => onAsk(x)} className="flex items-center gap-1.5 rounded-full border border-white/[.12] bg-white/[.04] px-3 py-1 text-left text-[12px] text-[#d5dbe1] transition hover:border-[#9d8cff]/70 hover:bg-[#8b7cff]/15 hover:text-white">
                  <Icon name="right" className="h-3 w-3 shrink-0 text-[#a99bff]" />{x}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function NavPill({ e, onNav, small }: { e: AipEvent; onNav: Props["onNav"]; small?: boolean }) {
  const app = APPS[String(e.tab)];
  return (
    <button onClick={() => onNav(String(e.tab), (e.target as Rec) ?? {})} title="Buka lagi"
      className={`flex max-w-full items-center gap-2 rounded-lg border border-[#4c90f0]/40 bg-[#2d72d2]/20 text-left text-[#cfe3ff] transition hover:bg-[#2d72d2]/35 hover:text-white ${small ? "px-2 py-1 text-[11.5px]" : "px-2.5 py-1.5 text-[12px]"}`}>
      <Icon name={app?.icon ?? "external"} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{small ? "Dibuka" : "Membuka"} {String(e.label)}</span>
      <Icon name="external" className="h-3 w-3 shrink-0 opacity-60" />
    </button>
  );
}

function Elapsed({ since }: { since?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const t0 = toDate(since);
  if (!Number.isFinite(t0)) return null;
  return <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[#6f7a86]">{secs(Math.max(0, (now - t0) / 1000))}</span>;
}

function NumberCheck({ check }: { check: AipEvent }) {
  const [open, setOpen] = useState(false);
  const fails = (check.gagal as string[] | undefined) ?? [];
  const n = Number(check.diperiksa ?? 0);
  if (!n && !fails.length) return null;
  return (
    <span className="relative">
      <button onClick={() => setOpen(!open)} title="Kode memeriksa setiap angka jawaban terhadap hasil tool" data-aip-check={check.ok ? "ok" : "gagal"}
        className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${check.ok ? "bg-[#238551]/20 text-[#72ca9b]" : "bg-[#c87619]/20 text-[#fbb360]"}`}>
        <Icon name={check.ok ? "check" : "alert"} className="h-3 w-3" />
        {check.ok ? `${n} angka cocok dengan hasil tool` : `${fails.length} dari ${n} angka belum terkonfirmasi`}
        {check.direvisi ? " · direvisi" : ""}
      </button>
      {open && fails.length > 0 && (
        <span className="absolute left-0 top-full z-20 mt-1 block w-[340px] space-y-0.5 rounded-lg border border-white/10 bg-[#161c22] p-2 text-[11px] text-[#fbb360] shadow-xl">
          {fails.map((f) => <span key={f} className="block">· {f}</span>)}
        </span>
      )}
    </span>
  );
}

function StepRow({ step, turn, dock, open, onToggle, onNav, onOpenRun }: {
  step: Step; turn: string; dock: boolean; open: boolean; onToggle: () => void; onNav: Props["onNav"]; onOpenRun: Props["onOpenRun"];
}) {
  const e = step.e;
  const [verb, what, appKey0] = TOOLS[String(e.tool)] ?? ["Baca", String(e.tool), ""];
  const appKey = String(e.app ?? appKey0);
  const app = APPS[appKey];
  const buka = (e.buka as Rec | undefined) ?? {};
  const scope = scopeOf(e);
  const target = app?.tab ? () => (e.tool === "analisis_agen" && buka.run ? onOpenRun(String(buka.run)) : onNav(app.tab!, buka)) : undefined;
  return (
    <div data-aip-step={step.n} className="group">
      <div className="flex items-start gap-2">
        <span className={`mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${e.ok ? "bg-[#238551]/25 text-[#72ca9b]" : "bg-red-500/20 text-red-300"}`}>
          <Icon name={e.ok ? "check" : "x"} className="h-2.5 w-2.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 items-baseline gap-1.5 text-left hover:text-white" title="Lihat rincian langkah">
              <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-[#8abbff]">{verb}</span>
              <span className={`shrink-0 text-[12.5px] ${e.ok ? "text-[#e8ecf0]" : "text-red-300"}`}>{what}</span>
              {scope && <span className="truncate text-[12px] text-[#8f99a8]">{scope}</span>}
            </button>
            {app && (
              <button onClick={target} disabled={!target} title={target ? `Buka di ${app.label}` : app.label}
                className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[.04] px-1.5 py-[1px] text-[11px] text-[#c9cfd6] transition enabled:hover:border-[#4c90f0] enabled:hover:text-white">
                <Icon name={app.icon} className="h-3 w-3" />{dock ? "" : app.label}
              </button>
            )}
          </div>
          <p className={`text-[11.5px] leading-snug ${e.ok ? "text-[#7d8894]" : "text-red-300/80"} ${open ? "" : "truncate"}`}>
            {String(e.summary ?? "") || (e.ok ? "" : "gagal")}{e.ms != null ? ` · ${(Number(e.ms) / 1000).toFixed(1)} dtk` : ""}
          </p>
          {e.tool === "analisis_agen" && buka.run && (
            <button onClick={() => onOpenRun(String(buka.run))} className="mt-1 flex items-center gap-1 text-[11.5px] text-[#8abbff] hover:text-white">
              <Icon name="graph" className="h-3 w-3" />Buka analisis agen lengkap (rencana, agen, validator, dasbor)
            </button>
          )}
          {step.subs.length > 0 && <SubRun events={step.subs} onOpenRun={onOpenRun} nested />}
          {open && <StepDetail step={step} turn={turn} />}
        </div>
      </div>
    </div>
  );
}

/** what a step was about, in a few words: its type, scope or query */
function scopeOf(e: AipEvent): string {
  const a = (e.args as Rec | undefined) ?? {};
  if (e.tool === "paket_audit") return Object.entries(a).filter(([, v]) => v).map(([, v]) => String(v)).join(" · ") || "nasional";
  if (e.tool === "buka_aplikasi") return [APPS[String(a.aplikasi)]?.label ?? a.aplikasi, a.sasaran].filter(Boolean).join(" · ");
  const v = a.tipe ?? a.faskes ?? a.kata_kunci ?? a.cari ?? a.nama ?? a.kueri ?? a.model ?? a.peran ?? a.bab ?? a.provinsi ?? a.kelompok ?? a.klaim_id ?? a.pertanyaan ?? a.bagian ?? a.pipeline;
  const extra = [a.kelompok && a.tipe === undefined && a.kelompok !== v ? `kelompok ${a.kelompok}` : "", a.kata_kunci && a.tipe ? a.kata_kunci : ""].filter(Boolean);
  return [v, ...extra].filter((x) => x !== undefined && x !== null && String(x).trim()).map(String).join(" · ");
}

function StepDetail({ step, turn }: { step: Step; turn: string }) {
  const e = step.e;
  const rids = [...new Set([...(e.rid ? [String(e.rid)] : []), ...step.results.map((r) => String(r.rid))])];
  const [rid, setRid] = useState(rids[0]);
  const [data, setData] = useState<Record<string, Result | string>>({});
  useEffect(() => {
    if (!rid || data[rid]) return;
    aip.result(turn, rid).then((r) => setData((d) => ({ ...d, [rid]: r }))).catch((x) => setData((d) => ({ ...d, [rid]: (x as Error).message })));
  }, [rid, turn, data]);
  const r = rid ? data[rid] : undefined;
  const args = Object.entries((e.args as Rec | undefined) ?? {}).filter(([, v]) => v !== "" && v != null);
  return (
    <div className="mt-1.5 space-y-1.5 rounded-lg border border-white/10 bg-[#11161b] p-2 text-[11px]">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[#8f99a8]">
        <span className="font-mono text-[#c9cfd6]">{String(e.tool)}</span>
        {args.map(([k, v]) => <span key={k}><span className="text-[#5f6b7c]">{k}=</span>{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>)}
        {(e.request as Rec | undefined)?.endpoint && <span className="font-mono">{String((e.request as Rec).endpoint)}</span>}
      </div>
      {rids.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {rids.map((x) => (
            <button key={x} onClick={() => setRid(x)} className={`rounded px-1.5 py-0.5 ${x === rid ? "bg-white/15 text-white" : "bg-white/5 text-[#abb3bf] hover:bg-white/10"}`}>
              {String(step.results.find((y) => y.rid === x)?.title ?? x).slice(0, 48)}
            </button>
          ))}
        </div>
      )}
      {typeof r === "string" ? <p className="text-red-300">{r}</p> : r ? <ResultTable r={r} /> : rid ? <p className="text-[#8f99a8]">Memuat hasil…</p> : null}
    </div>
  );
}

const fmt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

function ResultTable({ r }: { r: Result }) {
  const rows = (r.rows ?? []).slice(0, 8);
  // names before keys: a column of 32-character ids (faskes_profil_id) goes last, after what a reader recognises
  const hash = (c: string) => rows.length > 0 && rows.every((x) => typeof x[c] === "string" && /^[0-9a-f]{24,}$/.test(String(x[c])));
  const shown = (r.columns ?? []).filter((c) => !c.startsWith("_") || c === "_judul");
  const cols = [...shown.filter((c) => !hash(c)), ...shown.filter(hash)].slice(0, 7);
  if (!rows.length) return <p className="text-[#8f99a8]">Tidak ada baris.</p>;
  const cell = (v: unknown) => (v == null ? "" : typeof v === "number" ? fmt.format(v) : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[10.5px]">
        <thead>
          <tr>{cols.map((c) => <th key={c} className="whitespace-nowrap border-b border-white/10 px-1.5 py-1 text-left font-medium text-[#abb3bf]">{c === "_judul" ? "judul" : c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="odd:bg-white/[.02]">
              {cols.map((c) => <td key={c} className={`max-w-[220px] truncate px-1.5 py-0.5 ${typeof row[c] === "number" ? "text-right tabular-nums" : ""}`} title={cell(row[c])}>{cell(row[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[#5f6b7c]">{r.title} · {fmt.format(r.total ?? r.rows.length)} baris{(r.total ?? r.rows.length) > rows.length ? `, ${rows.length} ditampilkan` : ""}</p>
    </div>
  );
}

/** a delegated analysis (analisis_agen) as it runs: its run, and the agents' last steps */
function SubRun({ events, onOpenRun, nested }: { events: AipEvent[]; onOpenRun: Props["onOpenRun"]; nested?: boolean }) {
  const run = events.find((e) => e.type === "sub_run");
  const steps = events.filter((e) => e.type === "sub_step");
  return (
    <div className={`${nested ? "mt-1" : ""} rounded-lg border border-[#9d8cff]/25 bg-[#9d8cff]/[.06] px-2.5 py-1.5 text-[11px]`}>
      <div className="flex items-center gap-2 text-[#d4ccff]">
        <Icon name="graph" className="h-3 w-3" />
        <span className="font-medium">Orkestrator dan agen domain</span>
        <span className="text-[#8f99a8]">{steps.length} langkah</span>
        {run?.run && <button onClick={() => onOpenRun(String(run.run))} className="ml-auto text-[#8abbff] hover:text-white">Ikuti ↗</button>}
      </div>
      {steps.slice(-4).map((s, i) => (
        <p key={i} className={`truncate ${s.ok === false ? "text-red-300/80" : "text-[#a9b3be]"}`}>
          <span className="text-[#7d8894]">{String(s.agent ?? "")}</span>{s.tool ? ` · ${String(s.tool)}` : ""} {String(s.text ?? "")}
        </p>
      ))}
    </div>
  );
}
