"use client";

// AI Agent Swarm Branch: the multi-agent flow drawn live (the user, 2026-11-13: "bikin animasi multi agent nya bagus juga").
// Claims stream in, the model and the rule engine split them (pass / hold / uncertain), the uncertain ones go to the ADK
// swarm where three specialists read in parallel and the judge decides (review queue or cleared). The speech bubbles cycle
// through what the agents actually wrote for this branch's claims. No motion when the viewer asks for reduced motion.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SERIES } from "./viz";

type Agen = { p: number; bukti?: string; alasan?: string; famili?: string };
export type Contoh = { id: string; rs: string; inacbg: string; keputusan: string; agen: Record<string, Agen> | null };
type Angka = { klaim: number; lolos: number; tahan: number; ragu: number; periksa: number; dibersihkan: number };

const C = { model: SERIES[0], swarm: SERIES[2], tahan: "#e5484d", periksa: "#e0a02b", lolos: "#5f6b7a", garis: "#2c333b", teks: "#d3d8de", redup: "#8f99a8" };
const AGEN: [string, string, number][] = [["koding", "Koding & klinis", 112], ["tagihan", "Tagihan", 165], ["episode", "Episode & jaringan", 218]];
const id = (v: number) => v.toLocaleString("id-ID");

// motion paths (viewBox 1000 x 330)
const P = {
  masuk: "M 70 165 L 245 165",
  lolos: "M 305 165 C 360 165, 360 300, 430 300 L 905 300",
  tahan: "M 305 165 C 360 165, 360 30, 430 30 L 905 30",
  ragu: "M 305 165 L 455 165",
  sp: (y: number) => `M 455 165 C 490 165, 490 ${y}, 530 ${y} L 610 ${y} C 650 ${y}, 650 165, 690 165`,
  periksa: "M 750 165 C 800 165, 810 120, 860 120 L 905 120",
  bersih: "M 750 165 C 800 165, 810 215, 860 215 L 905 215",
};

const MQ = "(prefers-reduced-motion: reduce)";
function useReduce() {
  return useSyncExternalStore(
    (cb) => { try { const m = window.matchMedia(MQ); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); } catch { return () => {}; } },
    () => { try { return window.matchMedia(MQ).matches; } catch { return false; } },
    () => false,
  );
}

function Titik({ path, warna, dur, begin, r = 4 }: { path: string; warna: string; dur: number; begin: number; r?: number }) {
  return (
    <circle r={r} fill={warna} opacity={0}>
      <animateMotion path={path} dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" />
      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.9;1" dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" />
    </circle>
  );
}

function Simpul({ x, y, w, h, judul, sub, warna, kelas = "" }: { x: number; y: number; w: number; h: number; judul: string; sub?: string; warna: string; kelas?: string }) {
  return (
    <g className={kelas}>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={8} fill="#151a1f" stroke={warna} strokeWidth={1.5} />
      <text x={x} y={sub ? y - 3 : y + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="#ffffff">{judul}</text>
      {sub && <text x={x} y={y + 13} textAnchor="middle" fontSize={10} fill={C.redup}>{sub}</text>}
    </g>
  );
}

function Hitung({ ke, aktif }: { ke: number; aktif: boolean }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!aktif) return;
    let raf = 0; const t0 = performance.now();
    const step = (t: number) => { const f = Math.min(1, (t - t0) / 1600); setV(Math.round(ke * (1 - Math.pow(1 - f, 3)))); if (f < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ke, aktif]);
  return <>{id(aktif ? v : ke)}</>;
}

export function SwarmAnimasi({ angka, contoh, kc, model = "Model v4" }: { angka: Angka; contoh: Contoh[]; kc: string; model?: string }) {
  const reduce = useReduce();
  const gerak = !reduce;
  // the cycling bubbles: claims the swarm read, with all four answers
  const dibaca = useMemo(() => contoh.filter((c) => c.agen), [contoh]);
  const [i, setI] = useState(0);
  useEffect(() => {  // the parent remounts this per branch (key), so the cycle restarts at the first claim
    if (!gerak || dibaca.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % dibaca.length), 3600);
    return () => clearInterval(t);
  }, [gerak, dibaca.length]);
  const k = dibaca[i];
  // dots in proportion (bounded), staggered
  const nL = Math.max(3, Math.min(9, Math.round((9 * angka.lolos) / Math.max(1, angka.klaim))));
  const nR = angka.ragu ? 4 : 0;
  const nT = angka.tahan ? 2 : 0;
  const sel = (d: number) => [...Array(d).keys()];
  return (
    <section className="rounded-lg border border-white/[.07] bg-[#1c2127] p-4">
      <style>{`
        @keyframes swarm-denyut { 0%,100% { stroke-opacity: .45; } 50% { stroke-opacity: 1; } }
        @keyframes swarm-cincin { 0% { r: 9; opacity: .8; } 100% { r: 22; opacity: 0; } }
        @keyframes swarm-muncul { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .swarm-pikir rect { animation: swarm-denyut 1.6s ease-in-out infinite; }
        .swarm-pikir-2 rect { animation: swarm-denyut 1.6s ease-in-out .5s infinite; }
        .swarm-pikir-3 rect { animation: swarm-denyut 1.6s ease-in-out 1s infinite; }
        .swarm-gelembung { animation: swarm-muncul .45s ease-out; }
        @media (prefers-reduced-motion: reduce) { .swarm-pikir rect, .swarm-pikir-2 rect, .swarm-pikir-3 rect, .swarm-gelembung { animation: none; } }
      `}</style>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-white">AI Agent Swarm bekerja · {kc}</h3>
        <span className="rounded border border-dashed border-white/20 px-1.5 py-0.5 text-[10.5px] text-[#c5cbd3]">Google ADK · 3 spesialis paralel → hakim</span>
        {reduce && <span className="text-[10.5px] text-[#8f99a8]">animasi dimatikan (preferensi perangkat)</span>}
      </div>
      <div className="overflow-x-auto">
        <svg viewBox="0 0 1000 330" className="h-auto w-full min-w-[640px]" role="img" aria-label={`Alur ${id(angka.klaim)} klaim melalui model, rule engine dan AI Agent Swarm`}>
          {/* rails */}
          {[P.masuk, P.lolos, P.tahan, P.ragu, ...AGEN.map(([, , y]) => P.sp(y)), P.periksa, P.bersih].map((d, j) => <path key={j} d={d} fill="none" stroke={C.garis} strokeWidth={2} />)}
          {/* the swarm's box */}
          <rect x={440} y={72} width={325} height={186} rx={12} fill={`${C.swarm}0d`} stroke={`${C.swarm}88`} strokeDasharray="5 4" />
          <text x={452} y={90} fontSize={10.5} fill={C.swarm} fontWeight={600}>AI AGENT SWARM · VERTEX AI</text>
          {/* moving claims */}
          {gerak && sel(5).map((j) => <Titik key={`m${j}`} path={P.masuk} warna="#c5cbd3" dur={1.6} begin={j * 0.32} />)}
          {gerak && sel(nL).map((j) => <Titik key={`l${j}`} path={P.lolos} warna={C.lolos} dur={3.2} begin={j * (3.2 / nL)} />)}
          {gerak && sel(nT).map((j) => <Titik key={`t${j}`} path={P.tahan} warna={C.tahan} dur={3.4} begin={0.8 + j * 1.7} r={4.5} />)}
          {gerak && sel(nR).map((j) => <Titik key={`r${j}`} path={P.ragu} warna={C.periksa} dur={1.2} begin={j * 0.9} />)}
          {gerak && nR > 0 && AGEN.map(([, , y], a) => sel(3).map((j) => <Titik key={`s${a}${j}`} path={P.sp(y)} warna={C.swarm} dur={2.4} begin={0.6 + j * 0.8 + a * 0.12} r={3.5} />))}
          {gerak && nR > 0 && sel(2).map((j) => <Titik key={`p${j}`} path={P.periksa} warna={C.periksa} dur={1.8} begin={1.5 + j * 1.6} r={4.5} />)}
          {gerak && nR > 0 && sel(2).map((j) => <Titik key={`b${j}`} path={P.bersih} warna={C.lolos} dur={1.8} begin={0.7 + j * 1.6} />)}
          {/* nodes */}
          <Simpul x={70} y={165} w={110} h={58} judul="Klaim masuk" sub={`${id(angka.klaim)} klaim`} warna="#8f99a8" />
          <Simpul x={275} y={165} w={120} h={58} judul={`${model.replace(/^model /, "Model ")} + rule`} sub="skor & rule engine" warna={C.model} />
          {AGEN.map(([key, nama, y], a) => (
            <g key={key}>
              {gerak && <circle cx={570} cy={y} r={9} fill="none" stroke={C.swarm} strokeWidth={1.5} style={{ animation: `swarm-cincin 1.8s ease-out ${a * 0.45}s infinite` }} />}
              <Simpul x={570} y={y} w={130} h={36} judul={nama} warna={C.swarm} kelas={gerak ? ["swarm-pikir", "swarm-pikir-2", "swarm-pikir-3"][a] : ""} />
            </g>
          ))}
          <Simpul x={720} y={165} w={64} h={58} judul="Hakim" sub="skor risiko" warna="#ffffff" kelas={gerak ? "swarm-pikir" : ""} />
          {/* outcomes */}
          <g><rect x={905} y={12} width={88} height={38} rx={7} fill="#151a1f" stroke={C.tahan} /><text x={949} y={28} textAnchor="middle" fontSize={11} fontWeight={600} fill={C.tahan}>TAHAN</text>
            <text x={949} y={43} textAnchor="middle" fontSize={11} fill="#fff"><Hitung ke={angka.tahan} aktif={gerak} /></text></g>
          <g><rect x={905} y={101} width={88} height={38} rx={7} fill="#151a1f" stroke={C.periksa} /><text x={949} y={117} textAnchor="middle" fontSize={11} fontWeight={600} fill={C.periksa}>PERIKSA</text>
            <text x={949} y={132} textAnchor="middle" fontSize={11} fill="#fff"><Hitung ke={angka.periksa} aktif={gerak} /></text></g>
          <g><rect x={905} y={196} width={88} height={38} rx={7} fill="#151a1f" stroke={C.lolos} /><text x={949} y={212} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#c5cbd3">DIBERSIHKAN</text>
            <text x={949} y={227} textAnchor="middle" fontSize={11} fill="#fff"><Hitung ke={angka.dibersihkan} aktif={gerak} /></text></g>
          <g><rect x={905} y={281} width={88} height={38} rx={7} fill="#151a1f" stroke={C.lolos} /><text x={949} y={297} textAnchor="middle" fontSize={11} fontWeight={600} fill="#c5cbd3">LOLOS</text>
            <text x={949} y={312} textAnchor="middle" fontSize={11} fill="#fff"><Hitung ke={angka.lolos} aktif={gerak} /></text></g>
          <text x={372} y={152} fontSize={10} fill={C.periksa}>RAGU {id(angka.ragu)}</text>
        </svg>
      </div>
      {/* what the agents wrote, cycling */}
      {k && k.agen && (
        <div key={`${kc}-${i}`} className="swarm-gelembung mt-3 rounded-md border border-white/[.08] bg-[#151a1f] p-3">
          <p className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[#8f99a8]">
            <span className="font-medium text-white">{k.id}</span><span>{k.rs}</span><span className="tabular-nums">{k.inacbg}</span>
            <span className="rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: `${k.keputusan === "DIBERSIHKAN" ? C.lolos : k.keputusan === "TAHAN" ? C.tahan : C.periksa}22`, color: k.keputusan === "DIBERSIHKAN" ? "#c5cbd3" : k.keputusan === "TAHAN" ? "#ff8a8d" : "#f0c661" }}>
              {k.keputusan === "DIBERSIHKAN" ? "dibersihkan swarm" : k.keputusan.toLowerCase()}</span>
            {dibaca.length > 1 && <span className="ml-auto tabular-nums">{i + 1}/{dibaca.length}</span>}
          </p>
          <div className="grid gap-2 md:grid-cols-4">
            {[...AGEN.map(([key, nama]) => [key, nama] as const), ["hakim", "Hakim"] as const].map(([key, nama]) => {
              const a = k.agen?.[key];
              if (!a) return null;
              return (
                <div key={key} className={`rounded border px-2.5 py-2 ${key === "hakim" ? "border-white/25 bg-white/[.04]" : "border-white/[.07]"}`}>
                  <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-semibold" style={{ color: key === "hakim" ? "#fff" : C.swarm }}>{nama}</span>
                    <span className="text-[11px] tabular-nums text-white">skor {a.p.toFixed(2).replace(".", ",")}</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-[#2c333b]"><div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, a.p * 100)}%`, background: a.p >= 0.6 ? C.periksa : a.p >= 0.35 ? "#8f99a8" : "#5f6b7a" }} /></div>
                  <p className="mt-1.5 text-[10.5px] leading-snug text-[#d3d8de]">{a.bukti || a.alasan}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
