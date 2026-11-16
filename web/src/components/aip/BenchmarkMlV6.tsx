"use client";

// ML Studio · "ML v6 · fitur jaringan ala Quantexa" (the user, 2026-11-13: "coba buat v6, gaada biaya LLM?", "cek apakah bakal
// lebih baik di generator 1, 2, 3"). X6 = hospital-hospital graph from shared members, PageRank, communities, propagated rule
// suspicion, referral motifs (testing/fitur_v6.py). The pre-registered rule kept ML v5 when X6 added < 1 point on dev; the
// network model (L2) is still shown on every generator as an exploratory look. Synthetic data only, no LLM cost.

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { GRID, SERIES } from "./viz";

type M = { recall: number; fpr: number; presisi_prev2: number; auprc: number; per_skema: Record<string, number> };
type CI = { recall: [number, number]; presisi_prev2: [number, number] };
export type MLV6 = { dibuat: string;
  kartu: { pilihan: string; kandidat: Record<string, { per_dev: Record<string, { recall: number; auprc: number }>; rata_recall: number }>;
    cek_overfit: { l2_porsi_gain_x6?: number; l2_fitur_x6?: { fitur: string; porsi: number }[]; peringatan: string[] } };
  set: Record<string, { label: string; klaim: number; fraud: number; model: Record<string, M>; ci_l2_vs_ml_v5?: CI }> };

const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number, d = 1) => (v === undefined || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const W = { v4: SERIES[0], ml_v5: SERIES[2], l2: SERIES[4] };

function Chip({ children, warna = "#8f99a8", garis = false }: { children: ReactNode; warna?: string; garis?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
    style={{ background: garis ? "transparent" : `${warna}22`, color: warna, borderColor: garis ? `${warna}88` : undefined }}>{children}</span>;
}
function Bar({ v, w, label, max = 1, lw = "w-28" }: { v: number; w: string; label: string; max?: number; lw?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, (v / max) * 100))}%`, background: w }} />
      </div>
      <span className={`${lw} shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]`}>{label}</span>
    </div>
  );
}

function Langkah({ ikon, judul, sub }: { ikon: IconName; judul: string; sub: string }) {
  return (
    <div className="flex min-w-[160px] flex-1 items-start gap-2 rounded-md border border-white/[.08] bg-[#151a1f] px-3 py-2">
      <span style={{ color: W.l2 }}><Icon name={ikon} className="h-4 w-4" /></span>
      <div><p className="text-[11.5px] font-semibold text-white">{judul}</p><p className="text-[10.5px] leading-snug text-[#abb3bf]">{sub}</p></div>
    </div>
  );
}

export function BenchmarkMlV6({ b }: { b: MLV6 }) {
  const k = b.kartu;
  const l1 = k.kandidat.L1, l2 = k.kandidat.L2;
  const x6 = [...(k.cek_overfit.l2_fitur_x6 ?? [])].sort((a, c) => c.porsi - a.porsi);
  const maxX6 = Math.max(0.001, ...x6.map((f) => f.porsi));
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg text-white" style={{ background: `${W.l2}33` }}><Icon name="graph" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">ML v6 · {b.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">Fitur jaringan ala Quantexa: apakah menambah?</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Chip warna="#7ee2c0">tanpa biaya LLM · CPU lokal</Chip>
            <Chip warna={k.pilihan === "L2" ? "#7ee2c0" : "#f0c661"}>{k.pilihan === "L2" ? "dipakai: ML v6 = ML v5 + jaringan" : "tidak dipakai: ML v6 = ML v5 (selisih dev < 1 poin)"}</Chip>
            {k.cek_overfit.l2_porsi_gain_x6 !== undefined && <Chip>fitur jaringan memegang {pct(k.cek_overfit.l2_porsi_gain_x6)} keputusan model</Chip>}
          </div>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>
      <section className={`${box} space-y-3 p-4`}>
        <h3 className="text-[13px] font-semibold text-white">Cara fitur jaringan dibentuk (setiap hari, dari klaim 30 hari sebelumnya)</h3>
        <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
          <Langkah ikon="graph" judul="Peserta ↔ RS" sub="siapa berobat di RS mana" />
          <Icon name="right" className="hidden h-4 w-4 shrink-0 self-center text-[#5f6b7a] md:block" />
          <Langkah ikon="split" judul="Graph RS ↔ RS" sub="RS terhubung bila berbagi peserta" />
          <Icon name="right" className="hidden h-4 w-4 shrink-0 self-center text-[#5f6b7a] md:block" />
          <Langkah ikon="constellation" judul="Komunitas & PageRank" sub="kelompok RS, RS sentral, kecurigaan rule menular 1 langkah" />
          <Icon name="right" className="hidden h-4 w-4 shrink-0 self-center text-[#5f6b7a] md:block" />
          <Langkah ikon="refresh" judul="Motif peserta" sub="bolak-balik A→B→A, lintas komunitas, peserta baru" />
        </div>
      </section>
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <section className={`${box} space-y-3 p-4`}>
          <h3 className="text-[13px] font-semibold text-white">Di data dev (dipakai memilih)</h3>
          {["gen1", "gen2"].map((d) => (
            <div key={d} className="space-y-1">
              <p className="text-[11px] text-[#8f99a8]">{d === "gen1" ? "Generator 1" : "Generator 2"} · recall pada FPR 1%</p>
              <Bar v={l1.per_dev[d].recall} w={W.ml_v5} label={`ML v5 ${pct(l1.per_dev[d].recall)}`} />
              <Bar v={l2.per_dev[d].recall} w={W.l2} label={`+ jaringan ${pct(l2.per_dev[d].recall)}`} />
            </div>
          ))}
          <p className="text-[11px] text-[#abb3bf]">Rata-rata {pct(l1.rata_recall, 2)} vs {pct(l2.rata_recall, 2)}: selisih {id((l2.rata_recall - l1.rata_recall) * 100, 2)} poin.</p>
        </section>
        <section className={`${box} space-y-2 p-4`}>
          <h3 className="text-[13px] font-semibold text-white">Seberapa dipakai model (porsi gain, model + jaringan)</h3>
          {x6.slice(0, 8).map((f) => <Bar key={f.fitur} v={f.porsi} max={maxX6} w={W.l2} lw="w-52" label={`${f.fitur.replace("v6: ", "").replace(/_/g, " ")} ${pct(f.porsi, 2)}`} />)}
          <p className="text-[10.5px] text-[#8f99a8]">Model lebih banyak memakai fitur graph tetangga yang sudah ada; informasi jaringan RS sebagian besar sudah tertangkap di sana.</p>
        </section>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        {["generator1", "generator2", "generator3"].filter((g) => b.set[g]).map((g) => {
          const s = b.set[g], m = s.model, ci = s.ci_l2_vs_ml_v5;
          return (
            <section key={g} className={`${box} space-y-2 p-4`} style={g === "generator3" ? { borderColor: `${SERIES[2]}66` } : undefined}>
              <div className="flex flex-wrap items-center gap-2"><p className="text-[13px] font-semibold text-white">{s.label.split(" · ")[0]}</p>
                {g === "generator3" ? <Chip warna="#7ee2c0">data asing · seed baru · dinilai sekali</Chip> : <Chip warna="#c5cbd3" garis>dikenal · set dipakai ulang</Chip>}</div>
              {([["v4", "v4", W.v4], ["ml_v5", "ML v5 (= ML v6)", W.ml_v5], ["l2_jaringan", "+ jaringan (eksplorasi)", W.l2]] as const).map(([mk, nm, w]) => m[mk] && (
                <div key={mk} className="space-y-0.5">
                  <div className="flex items-center justify-between text-[11px]"><span className="text-[#d3d8de]">{nm}</span>
                    <span className="tabular-nums text-[#abb3bf]">prec@2% {pct(m[mk].presisi_prev2, 0)} · AUPRC {id(m[mk].auprc, 3)}</span></div>
                  <Bar v={m[mk].recall} w={w} label={`recall ${pct(m[mk].recall)}`} />
                </div>))}
              {ci && <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[.06] pt-2"><span className="text-[10.5px] text-[#8f99a8]">jaringan − ML v5</span>
                <Chip warna={ci.recall[0] > 0 ? "#7ee2c0" : ci.recall[1] < 0 ? "#f0c661" : "#c5cbd3"}>recall CI {id(ci.recall[0] * 100, 1)} s/d {id(ci.recall[1] * 100, 1)}</Chip>
                <Chip warna={ci.presisi_prev2[0] > 0 ? "#7ee2c0" : ci.presisi_prev2[1] < 0 ? "#f0c661" : "#c5cbd3"}>prec CI {id(ci.presisi_prev2[0] * 100, 1)} s/d {id(ci.presisi_prev2[1] * 100, 1)}</Chip></div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
