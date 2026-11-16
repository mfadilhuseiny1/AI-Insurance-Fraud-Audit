"use client";

// /swarm-x · AI Agent Swarm Branch (the user, 2026-11-16: "bikin /swarm-x disini saya bisa buka create new project, klik tema
// jantung seakan2 audit baru tema jantung, padahal pake yg sekarang udh selesai scan nya, perbaiki UI UX nya buat demo"): the
// branch tab as AIP JKN draws it (ProyekCabang + the report), answered in the page by demoCabang.ts. It opens empty, as on a first
// visit; "Buat proyek baru" → "Buat audit baru" → "Mulai audit" work as in AIP JKN, and the audit that runs is the finished
// cardiology scan replayed on a clock (1–100×), ending on its report. A small bar (H hides it while recording) sets the speed,
// pauses, and starts a new take.

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon } from "@/components/Icon";
import { CABANG_BUAT_PROYEK, ProyekCabang } from "./ProyekCabang";
import { NetworkOrb } from "./ProyekKonsultan";
import { SwarmCabangView } from "./SwarmCabangView";
import { DEMO_SPEEDS_CABANG, demoCabang, installDemoCabang, useDemoCabang } from "./demoCabang";

const NAMA_TAHAP: Record<string, string> = { fitur: "Data & fitur", zona: "Zona ML v7", iot: "Data alat (IoT)", aturan: "Rule engine", swarm: "AI Agent Swarm",
  laporan: "Laporan", narasi: "Narasi" };
const LANGKAH: [string, string][] = [
  ["Buat proyek", "Pilih kantor cabang, data klaim, dan fokus tema, mis. jantung."],
  ["Buat audit", "Pilih tema, ukuran data, dan data pemakaian alat (IoT)."],
  ["Mulai audit", "Rule engine → ML v7 → AI Agent Swarm membaca klaim, lalu laporan per tema ditulis."],
];

/** the report area: empty until an audit has finished, as on a first visit; then the report of that audit */
function Laporan() {
  const demo = useDemoCabang();
  if (demo?.selesai) return <SwarmCabangView />;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#15181d]">
      <div className="flex min-h-full flex-col items-center bg-[radial-gradient(ellipse_1100px_620px_at_50%_170px,#262c3a_0%,#1f2430_35%,#191d24_65%,#15181d_100%)] bg-no-repeat px-4 pb-10 pt-2">
        <NetworkOrb size={280} />
        <p className="-mt-3 text-[10.5px] uppercase tracking-[0.2em] text-[#8f99a8]">AIP JKN</p>
        <h2 className="mt-1 text-center text-[22px] font-semibold text-white">AI Agent Swarm Branch</h2>
        <p className="mt-1.5 max-w-[620px] text-center text-[12.5px] leading-relaxed text-[#abb3bf]">
          Audit klaim per kantor cabang BPJS Kesehatan: setiap klaim dicek rule engine dan model ML v7, klaim yang meragukan dibaca tim agen AI
          bersama rekam medis dan data pemakaian alat, lalu laporan per tema ditulis untuk verifikator.
        </p>
        <button onClick={() => window.dispatchEvent(new Event(CABANG_BUAT_PROYEK))}
          className="mt-6 flex items-center gap-2 rounded-md bg-[#5b5fd6] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_0_24px_rgba(91,95,214,0.45)] hover:bg-[#6a6ee0]">
          <Icon name="plus" className="h-3.5 w-3.5" />Buat proyek baru
        </button>
        <ol className="mt-8 grid w-full max-w-[860px] gap-2.5 md:grid-cols-3">
          {LANGKAH.map(([j, s], i) => (
            <li key={j} className="rounded-lg border border-white/10 bg-[#1c2127]/80 p-3">
              <p className="flex items-center gap-2 text-[12.5px] font-semibold text-white">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#5b5fd6]/30 text-[11px] text-[#c7c9ff]">{i + 1}</span>{j}
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-[#abb3bf]">{s}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

const mmss = (s: number) => {
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** the demo's own controls: speed, pause, a new take */
function Bar({ onReset, onHide }: { onReset: () => void; onHide: () => void }) {
  const demo = useDemoCabang();
  const [now, setNow] = useState<ReturnType<typeof demoCabang.now>>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(demoCabang.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!demo) return null;
  const live = now?.status === "berjalan";
  const line = demo.err ? `Data scan tidak bisa dimuat: ${demo.err}`
    : !now ? "Siap: buat proyek, buat audit, lalu mulai."
    : `${live ? (demo.paused ? "Dijeda" : NAMA_TAHAP[now.tahap ?? ""] ?? "Berjalan") : now.status === "selesai" ? "Selesai" : "Dibatalkan"} · ${mmss(now.detik)} waktu audit · ${Math.round(now.pct * 100)}%`;
  return (
    <div className="absolute bottom-2 left-2 z-40 w-[248px] rounded-lg border border-[#c084fc]/30 bg-[#111418]/95 p-2 text-[11px] text-[#d3d8de] shadow-2xl" data-swarm-x>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${live && !demo.paused ? "animate-pulse bg-[#c084fc]" : "bg-[#8f99a8]"}`} />
        <p className="font-semibold text-white">Mode demo</p>
        <span className="text-[10.5px] text-[#8f99a8]">hasil scan tersimpan</span>
        <button onClick={onHide} title="sembunyikan (H)" aria-label="Sembunyikan" className="ml-auto rounded p-0.5 text-[#8f99a8] hover:bg-white/10 hover:text-white">
          <Icon name="x" className="h-3 w-3" />
        </button>
      </div>
      <p className={`mt-0.5 text-[10.5px] tabular-nums ${demo.err ? "text-[#ffb4b4]" : "text-[#abb3bf]"}`}>{line}</p>
      {live && <div className="mt-1 h-1 overflow-hidden rounded bg-white/10"><div className="h-full rounded bg-[#9d8cff]" style={{ width: `${(now?.pct ?? 0) * 100}%` }} /></div>}
      <div className="mt-1.5 flex items-center gap-1">
        <div className="flex overflow-hidden rounded border border-white/15 text-[10.5px]" title="kecepatan audit (tombol 1–5)">
          {DEMO_SPEEDS_CABANG.map((s) => (
            <button key={s} onClick={() => demoCabang.setSpeed(s)} className={`px-1.5 py-0.5 tabular-nums ${demo.speed === s ? "bg-white/15 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>{s}×</button>
          ))}
        </div>
        <button onClick={() => demoCabang.togglePause()} title="jeda / lanjut (spasi)"
          className="ml-auto flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-2 py-0.5 font-medium text-white hover:bg-[#6a6ee0]">
          <Icon name={demo.paused ? "play" : "pause"} className="h-3 w-3" />{demo.paused ? "Lanjut" : "Jeda"}
        </button>
      </div>
      <div className="mt-1.5 flex items-center">
        <span className="text-[10px] text-[#6b7480]">H sembunyikan · spasi jeda · 1–5</span>
        <button onClick={onReset} title="ambil ulang: tanpa proyek, tanpa audit, tanpa laporan"
          className="ml-auto flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10.5px] hover:bg-white/10">
          <Icon name="restore" className="h-3 w-3" />Ulang dari awal
        </button>
      </div>
    </div>
  );
}

/** the branch tab of /swarm-x: the demo opened on mount and closed on unmount */
export function SwarmXCabang({ kecepatan }: { kecepatan?: number | null }) {
  const { me } = useAuth();
  const [siap, setSiap] = useState(false);
  // the demo's projects and audits are made by whoever is signed in
  useEffect(() => { if (me?.display_name || me?.username) demoCabang.setOleh(me.display_name || me.username); }, [me]);
  const [take, setTake] = useState(0);
  const [bar, setBar] = useState(true);
  useEffect(() => {
    const tutup = installDemoCabang({ kecepatan });
    const r = requestAnimationFrame(() => setSiap(true));
    return () => { cancelAnimationFrame(r); tutup(); };
  }, [kecepatan]);
  // H shows or hides the bar, the space bar pauses a running audit, 1–5 set the speed (not while typing)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.code === "KeyH") setBar((b) => !b);
      else if (e.code === "Space" && demoCabang.now()?.status === "berjalan") { e.preventDefault(); demoCabang.togglePause(); }
      else if (/^Digit[1-5]$/.test(e.code)) demoCabang.setSpeed(DEMO_SPEEDS_CABANG[Number(e.code.slice(5)) - 1]);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  if (!siap) return null;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <ProyekCabang key={take}><Laporan /></ProyekCabang>
      {bar && <Bar onReset={() => { demoCabang.reset(); setTake((t) => t + 1); }} onHide={() => setBar(false)} />}
    </div>
  );
}
