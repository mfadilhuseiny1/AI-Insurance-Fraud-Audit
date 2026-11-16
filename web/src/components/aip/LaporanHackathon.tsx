"use client";

// ML Studio · "Laporan hackathon" (the user, 2026-11-13: "kasih report lengkap di ML Studio"): the full hackathon reports, the
// same pages as the published artifacts, served by /api/laporan-hackathon. Generator 1 is the hackathon scope (data close to
// the BPJS sample distribution); "Lintas generator" is the cross-generator robustness report. Synthetic data only.

import { useState } from "react";
import { Icon } from "@/components/Icon";

const PILIHAN: [string, string, string][] = [
  ["gen1", "Generator 1", "Ruang lingkup hackathon: data yang distribusinya mendekati data sampel BPJS"],
  ["lintas", "Lintas generator", "Uji ketahanan di empat generator, diagnosis distribution shift, ML v7"],
];

export function LaporanHackathon() {
  const [r, setR] = useState("gen1");
  const aktif = PILIHAN.find(([k]) => k === r) ?? PILIHAN[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[.07] px-4 py-2.5">
        <div className="inline-flex overflow-hidden rounded-md border border-white/10" role="group" aria-label="Pilih laporan">
          {PILIHAN.map(([k, nm]) => (
            <button key={k} type="button" onClick={() => setR(k)}
              className={`px-3 py-1.5 text-[12px] ${r === k ? "bg-white/10 font-semibold text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{nm}</button>
          ))}
        </div>
        <p className="min-w-0 flex-1 text-[11.5px] text-[#abb3bf]">{aktif[2]}</p>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
        <a href={`/api/laporan-hackathon?r=${r}&tema=light`} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-[#d3d8de] hover:bg-white/5">
          <Icon name="external" className="h-3.5 w-3.5" />Buka di tab baru</a>
      </div>
      <iframe key={r} title={`Laporan hackathon · ${aktif[1]}`} src={`/api/laporan-hackathon?r=${r}&tema=dark`} className="min-h-0 w-full flex-1 border-0 bg-[#0d1412]" />
    </div>
  );
}
