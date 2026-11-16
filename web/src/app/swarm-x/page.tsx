"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { UserMenu } from "@/components/Sidebar";
import { KonsultanView } from "@/components/aip/KonsultanView";
import { setTampilBiaya, useTampilBiaya } from "@/components/aip/biaya";
import { DEMO_SPEEDS, demoLive, demoSwarm, installDemo, useDemoSwarm } from "@/components/aip/demoSwarm";
import { SwarmXCabang } from "@/components/aip/SwarmXCabang";
import { TABS_AIP } from "@/components/aip/tabsAip";

/* /swarm-x: two AIP JKN tabs for a demo, answered in the page. AI Agent Swarm Branch (opens first; components/aip/SwarmXCabang.tsx,
   demoCabang.ts, the user, 2026-11-16): a new project, a cardiology audit, and the finished scan replayed as it. ?tab=nasional opens
   the AI Agent Swarm tutorial (components/aip/demoSwarm.ts). It opens empty, as on a first visit — no
   project, no report; "Buat proyek baru" and "Mulai penugasan baru" work as in AIP JKN, and the engagement that runs is a
   recorded one (Blu 1.1: the simulation of Audit Nasional 1.1) released at 1–100× its speed; no model is called. A small
   bar (H hides it while recording) sets the speed, pauses, and starts a new take. ?sumber=<run> replays another finished
   engagement, ?laporan=<run> shows another one's long report (a rewrite of it), ?kecepatan=40 starts at 40×. */

// AIP JKN's bar as /aip-jkn draws it; the two demo tabs switch here, the other tabs open there (and leave the demo)
type Demo = "konsultan" | "cabang";
// the same list as /aip-jkn (components/aip/tabsAip.ts): a tab added there shows here too
const TABS = TABS_AIP;

export default function SwarmXPage() {
  const tampilBiaya = useTampilBiaya();
  const [tab, setTab] = useState<Demo | null>(null);
  const [kecepatan, setKecepatan] = useState<number | null>(null);
  const [biaya, setBiaya] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address is read once the page is in the browser
    setTab(q.get("tab") === "nasional" ? "konsultan" : "cabang");
    setKecepatan(Number(q.get("kecepatan")) || null);
  }, []);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#2f3c48] text-[#f6f7f9]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-black/40 bg-[#111418] px-3 text-[12px]">
        <span title="Orkestrator + agen domain per objek Nexus" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold">
          <Icon name="sparkle" className="h-4 w-4 text-[#9d8cff]" />AIP JKN
        </span>
        <span title="Semua data di aplikasi ini sintetis: dibangkitkan dari pola statistik Data Sampel BPJS 2025 (synthetic-gen/METODOLOGI.md), bukan baris data asli"
          className="shrink-0 whitespace-nowrap rounded border border-amber-300/40 bg-amber-300/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-200">Data sintetis</span>
        <nav className="mx-auto flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {TABS.map(([k, label, icon]) => k === "konsultan" || k === "cabang" ? (
            <button key={k} onClick={() => setTab(k)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 ${tab === k ? "bg-white/10 text-white" : "text-[#d3d8de] hover:bg-white/5"}`}>
              <Icon name={icon} className="h-3.5 w-3.5" />{label}
            </button>
          ) : (
            <Link key={k} href={`/aip-jkn?tab=${k}`} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-[#d3d8de] hover:bg-white/5"><Icon name={icon} className="h-3.5 w-3.5" />{label}</Link>
          ))}
        </nav>
        <Link href="/aip-jkn?tab=agents" title="AIP Operator: tanya dan perintah di atas semua tab"
          className="flex shrink-0 items-center gap-1.5 rounded border border-[#9d8cff]/40 px-2 py-0.5 text-[11.5px] text-[#c7c9ff] hover:bg-[#5b5fd6]/20">
          <Icon name="sparkle" className="h-3.5 w-3.5" /><span className="max-xl:hidden">Operator</span>
        </Link>
        <span className="relative shrink-0">
          <button onClick={() => setBiaya(!biaya)} title="Lihat biaya model" className={`rounded p-1 ${biaya ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>
            <Icon name="gauge" className="h-3.5 w-3.5" />
          </button>
          {biaya && (<>
            <div className="fixed inset-0 z-40" onClick={() => setBiaya(false)} />
            <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded border border-white/10 bg-[#1c2127] p-3 text-[11.5px] shadow-2xl">
              <div className="mb-2 font-semibold text-white">Biaya model</div>
              <label className="flex items-center gap-2 text-[#d3d8de]">
                <input type="checkbox" checked={tampilBiaya} onChange={(e) => setTampilBiaya(e.target.checked)} />
                Tampilkan biaya di tiap jawaban dan penugasan
              </label>
              <p className="mt-2 text-[10.5px] leading-snug text-[#abb3bf]">Biaya yang tampil adalah biaya audit yang diputar ulang; tidak ada panggilan model baru.</p>
            </div>
          </>)}
        </span>
        <UserMenu />
      </header>
      {tab === "konsultan" && <SwarmXNasional kecepatan={kecepatan} />}
      {tab === "cabang" && <SwarmXCabang kecepatan={kecepatan} />}
    </div>
  );
}

/** the AI Agent Swarm tutorial (demoSwarm.ts): opened on mount, closed when the other tab opens */
function SwarmXNasional({ kecepatan }: { kecepatan: number | null }) {
  const [ready, setReady] = useState(false);
  const [take, setTake] = useState(0);  // a new take: the tab again from its empty start
  const [bar, setBar] = useState(true);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const close = installDemo({ sumber: q.get("sumber"), laporan: q.get("laporan"), kecepatan });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the tab mounts once its calls are answered here
    setReady(true);
    return () => { close(); setReady(false); };
  }, [kecepatan]);
  // H shows or hides the bar, the space bar pauses a running engagement, 1–5 set the speed (not while typing)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.code === "KeyH") setBar((b) => !b);
      else if (e.code === "Space" && demoLive()) { e.preventDefault(); demoSwarm.togglePause(); }
      else if (/^Digit[1-5]$/.test(e.code)) demoSwarm.setSpeed(DEMO_SPEEDS[Number(e.code.slice(5)) - 1]);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1">
      {ready && <KonsultanView key={take} />}
      {ready && bar && <DemoBar onReset={() => { demoSwarm.reset(); setTake((t) => t + 1); }} onHide={() => setBar(false)} />}
    </div>
  );
}

const hms = (s: number) => {
  const t = Math.floor(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** The tutorial's own controls, over the tab's list of projects: speed, pause, idle skipping, a new take. */
function DemoBar({ onReset, onHide }: { onReset: () => void; onHide: () => void }) {
  const demo = useDemoSwarm();
  const [now, setNow] = useState<ReturnType<typeof demoSwarm.now>>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(demoSwarm.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!demo) return null;
  const live = now?.status === "running";
  const line = demo.err ? `Jejak tidak bisa dimuat: ${demo.err}`
    : !now ? (demo.ready ? "Siap: buat proyek, lalu mulai penugasan." : "Memuat jejak penugasan…")
    : `${live ? (demo.paused ? "Dijeda" : "Berjalan") : now.status === "succeeded" ? "Selesai" : "Dihentikan"} · ${hms(now.detik)} waktu penugasan · ${Math.round(now.pct * 100)}%`;
  return (
    <div className="absolute bottom-2 left-2 z-40 w-[244px] rounded-lg border border-[#c084fc]/30 bg-[#111418]/95 p-2 text-[11px] text-[#d3d8de] shadow-2xl" data-swarm-x>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${live && !demo.paused ? "animate-pulse bg-[#c084fc]" : "bg-[#8f99a8]"}`} />
        <p className="font-semibold text-white">Mode tutorial</p>
        <span className="text-[10.5px] text-[#8f99a8]">tanpa panggilan model</span>
        <button onClick={onHide} title="sembunyikan (H)" aria-label="Sembunyikan" className="ml-auto rounded p-0.5 text-[#8f99a8] hover:bg-white/10 hover:text-white">
          <Icon name="x" className="h-3 w-3" />
        </button>
      </div>
      <p className={`mt-0.5 text-[10.5px] tabular-nums ${demo.err ? "text-[#ffb4b4]" : "text-[#abb3bf]"}`}>{line}</p>
      <div className="mt-1.5 flex items-center gap-1">
        <div className="flex overflow-hidden rounded border border-white/15 text-[10.5px]" title="kecepatan penugasan (tombol 1–5)">
          {DEMO_SPEEDS.map((s) => (
            <button key={s} onClick={() => demoSwarm.setSpeed(s)} className={`px-1.5 py-0.5 tabular-nums ${demo.speed === s ? "bg-white/15 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>{s}×</button>
          ))}
        </div>
        <button onClick={() => demoSwarm.togglePause()} title="jeda / lanjut (spasi)"
          className="ml-auto flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-2 py-0.5 font-medium text-white hover:bg-[#6a6ee0]">
          <Icon name={demo.paused ? "play" : "pause"} className="h-3 w-3" />{demo.paused ? "Lanjut" : "Jeda"}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <label className="flex items-center gap-1 text-[10.5px] text-[#abb3bf]" title="jeda panjang (model berpikir, telaah klinis di antara hitungannya) dipadatkan menjadi paling lama 20 detik waktu penugasan">
          <input type="checkbox" checked={demo.skip} onChange={(e) => demoSwarm.setSkip(e.target.checked)} />lewati jeda
        </label>
        <button onClick={onReset} title="ambil ulang: tanpa proyek, tanpa penugasan, tanpa laporan"
          className="ml-auto flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10.5px] hover:bg-white/10">
          <Icon name="restore" className="h-3 w-3" />Ulang dari awal
        </button>
      </div>
      <p className="mt-1 text-[10px] text-[#6b7480]">H sembunyikan · spasi jeda · 1–5 kecepatan</p>
    </div>
  );
}
