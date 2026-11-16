"use client";

// ML Studio · "ML v7 · tahan distribution shift" (reviewer order: data generating process -> leave-one-generator-out -> domain
// generalization / DRO; the user, 2026-11-13: "do what you think is better, I wanna report for a hackathon").
// Data: testing/ml_v7.py -> ml_v7_benchmark.json (pre-registered in testing/kriteria_ml_v7.json; generator 3 and 4 scored once).

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { GRID, SERIES } from "./viz";

type M = { recall: number; fpr: number; presisi_prev2: number; auprc: number; famili: Record<string, number> };
type CI = { recall: [number, number]; presisi_prev2: [number, number] };
type Logo = Record<string, { recall_fpr1: number; auprc: number }> & { terburuk: number; rata: number };
export type MLV7 = {
  dibuat: string; pilihan: string;
  adopsi: { lolos: boolean; ci_recall_g4: [number, number]; selisih_prec2_g4: number };
  kartu: { logo: Record<string, Logo>; gabungan: Record<string, { rata: number; per_dev: Record<string, number> }>; tidak_stabil: { jumlah: number };
    latih: Record<string, number>; cek_overfit: { auprc_latih_insample: number; auprc_latih_oof_per_peserta: number; porsi_gain_sidik_jari?: number;
      porsi_gain_sidik_jari_ml_v5?: number; peringatan: string[] } };
  set: Record<string, { label: string; klaim: number; fraud: number; skema: number; famili_n: Record<string, number>; model: Record<string, M>; ci_vs_A0: Record<string, CI> }>;
};

const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const pt = (v: number) => `${v > 0 ? "+" : ""}${id(v * 100, 1)}`;
const NAMA: Record<string, string> = { v3_bersih: "v3", v4: "v4", A0: "ML v5", A1: "A1 · data halus", A2: "A2 · bobot seimbang", A3: "A3 · group DRO", A4: "A4 · acak konteks" };
const GEN: [string, string, string][] = [["generator1", "Generator 1", SERIES[0]], ["generator2", "Generator 2", SERIES[3]], ["generator3", "Generator 3", SERIES[2]],
  ["generator4", "Generator 4", "#9470e0"]];
const FAM: Record<string, string> = { koding: "Koding", tagihan: "Tagihan", episode: "Episode", identitas: "Identitas", jaringan: "Jaringan" };

function Chip({ children, warna = "#8f99a8", garis = false }: { children: ReactNode; warna?: string; garis?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
    style={{ background: garis ? "transparent" : `${warna}22`, color: warna, borderColor: garis ? `${warna}88` : undefined }}>{children}</span>;
}
function Bar({ v, w, label, redup = false }: { v: number; w: string; label: string; redup?: boolean }) {
  return (
    <div className="flex items-center gap-2" title={label}>
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, v * 100))}%`, background: w, opacity: redup ? 0.4 : 1 }} />
      </div>
      <span className={`w-36 shrink-0 text-right text-[11px] tabular-nums ${redup ? "text-[#8f99a8]" : "text-[#d3d8de]"}`}>{label}</span>
    </div>
  );
}
function Langkah({ ikon, judul, sub }: { ikon: IconName; judul: string; sub: string }) {
  return (
    <div className="flex min-w-[180px] flex-1 items-start gap-2 rounded-md border border-white/[.08] bg-[#151a1f] px-3 py-2">
      <span className="text-[#7ee2c0]"><Icon name={ikon} className="h-4 w-4" /></span>
      <div><p className="text-[11.5px] font-semibold text-white">{judul}</p><p className="text-[10.5px] leading-snug text-[#abb3bf]">{sub}</p></div>
    </div>
  );
}

export function BenchmarkMlV7({ b }: { b: MLV7 }) {
  const P = b.pilihan, K = b.kartu, ad = b.adopsi;
  const kand = ["A1", "A2", "A3", "A4"];
  const lain = kand.filter((k) => k !== P);
  const g4 = b.set.generator4;
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg text-white" style={{ background: `${SERIES[2]}33` }}><Icon name="layers" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">ML v7 · {b.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">Perbaikan distribution shift, urutan reviewer</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Chip warna="#7ee2c0">tanpa biaya LLM · CPU lokal</Chip>
            <Chip warna="#c5cbd3">pilihan seleksi: {NAMA[P]}</Chip>
            <Chip warna={ad.lolos ? "#7ee2c0" : "#f0c661"}>{ad.lolos ? "lolos aturan adopsi: ML v7 menggantikan ML v5" : "belum lolos aturan adopsi: ML v5 tetap"}</Chip>
            <Chip warna="#c5cbd3" garis>generator 4 ditulis buta · dinilai sekali</Chip>
          </div>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>

      <section className={`${box} space-y-3 p-4`}>
        <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
          <Langkah ikon="sliders" judul="1 · Data halus" sub={`generator 2 tanpa sidik jari: peserta lokal dengan riwayat (${id(K.latih.g2h_tr)} klaim latih)`} />
          <Icon name="right" className="hidden h-4 w-4 shrink-0 self-center text-[#5f6b7a] md:block" />
          <Langkah ikon="layers" judul="2 · Leave-one-generator-out" sub="latih G1 → uji G2, latih G2 → uji G1; skor = arah terburuk" />
          <Icon name="right" className="hidden h-4 w-4 shrink-0 self-center text-[#5f6b7a] md:block" />
          <Langkah ikon="filter" judul="3 · Domain generalization" sub={`bobot seimbang, group DRO, acak konteks (${K.tidak_stabil.jumlah} fitur tidak stabil)`} />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <section className={`${box} space-y-3 p-4`}>
          <h3 className="text-[13px] font-semibold text-white">Seleksi tanpa generator 3 dan 4 (recall pada FPR 1%)</h3>
          {kand.map((k) => {
            const L = K.logo[k];
            return (
              <div key={k} className="space-y-1">
                <div className="flex items-center justify-between text-[11.5px]"><span className={k === P ? "font-semibold text-white" : "text-[#d3d8de]"}>{NAMA[k]}{k === P && " · dipilih"}</span>
                  <span className="tabular-nums text-[#abb3bf]">terburuk {pct(L.terburuk)} · dev gabungan {pct(K.gabungan[k]?.rata)}</span></div>
                <Bar v={L.latih_G1_uji_G2.recall_fpr1} w={SERIES[3]} label={`G1 → G2 ${pct(L.latih_G1_uji_G2.recall_fpr1)}`} />
                <Bar v={L.latih_G2_uji_G1.recall_fpr1} w={SERIES[0]} label={`G2 → G1 ${pct(L.latih_G2_uji_G1.recall_fpr1)}`} />
              </div>
            );
          })}
          <p className="text-[10.5px] text-[#8f99a8]">ML v5 di dev gabungan: {pct(K.gabungan.A0?.rata)}. Seri &lt; 1 poin → kandidat yang lebih sederhana.</p>
        </section>
        <section className={`${box} space-y-3 p-4`}>
          <h3 className="text-[13px] font-semibold text-white">Aturan adopsi (ditulis sebelum uji) di generator 4</h3>
          <div className="flex flex-wrap gap-1.5">
            <Chip warna={ad.ci_recall_g4[0] > 0 ? "#7ee2c0" : "#f0c661"}>CI recall {pt(ad.ci_recall_g4[0])} s/d {pt(ad.ci_recall_g4[1])} poin (harus &gt; 0)</Chip>
            <Chip warna={ad.selisih_prec2_g4 >= -0.02 ? "#7ee2c0" : "#f0c661"}>prec@2% {pt(ad.selisih_prec2_g4)} poin (boleh turun ≤ 2)</Chip>
          </div>
          <h3 className="pt-1 text-[12px] font-semibold text-white">Generator 4 per famili skema</h3>
          {Object.keys(g4.famili_n).filter((f) => FAM[f]).map((f) => (
            <div key={f} className="space-y-0.5">
              <p className="text-[10.5px] text-[#8f99a8]">{FAM[f]} · {g4.famili_n[f]} klaim fraud</p>
              <Bar v={g4.model.A0.famili[f] ?? 0} w={SERIES[0]} label={`ML v5 ${pct(g4.model.A0.famili[f], 0)}`} />
              <Bar v={g4.model[P].famili[f] ?? 0} w={SERIES[2]} label={`ML v7 ${pct(g4.model[P].famili[f], 0)}`} />
            </div>
          ))}
          {K.cek_overfit.porsi_gain_sidik_jari !== undefined && <p className="text-[10.5px] text-[#8f99a8]">Porsi keputusan pada 4 sidik jari: ML v5 {pct(K.cek_overfit.porsi_gain_sidik_jari_ml_v5)} → ML v7 {pct(K.cek_overfit.porsi_gain_sidik_jari)}. AUPRC latih {id(K.cek_overfit.auprc_latih_insample, 3)} vs OOF {id(K.cek_overfit.auprc_latih_oof_per_peserta, 3)}.</p>}
        </section>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {GEN.filter(([g]) => b.set[g]).map(([g, nm, w]) => {
          const s = b.set[g], m = s.model, ci = s.ci_vs_A0[P];
          return (
            <section key={g} className={`${box} space-y-2 p-4`} style={{ borderTop: `3px solid ${w}` }}>
              <div className="flex flex-wrap items-center gap-2"><p className="text-[13px] font-semibold text-white">{nm}</p>
                {g === "generator4" ? <Chip warna="#7ee2c0">ditulis buta · sekali</Chip> : g === "generator3" ? <Chip warna="#7ee2c0">seed baru · sekali</Chip> : <Chip warna="#c5cbd3" garis>dikenal</Chip>}</div>
              <p className="text-[10.5px] text-[#8f99a8]">{id(s.klaim)} klaim · {id(s.fraud)} fraud · {s.skema} skema</p>
              {(["v4", "A0", P] as string[]).map((k) => <Bar key={k} v={m[k].recall} w={k === P ? SERIES[2] : k === "A0" ? SERIES[0] : "#8f99a8"} label={`${k === P ? "ML v7" : NAMA[k]} ${pct(m[k].recall)}`} />)}
              {lain.map((k) => <Bar key={k} v={m[k].recall} w="#8f99a8" redup label={`${k} ${pct(m[k].recall)}`} />)}
              <div className="flex flex-wrap gap-1.5 border-t border-white/[.06] pt-2">
                <Chip warna="#c5cbd3">prec@2% {pct(m.A0.presisi_prev2, 0)} → {pct(m[P].presisi_prev2, 0)}</Chip>
                <Chip warna="#c5cbd3">FPR {pct(m.A0.fpr, 2)} → {pct(m[P].fpr, 2)}</Chip>
                <Chip warna={ci.recall[0] > 0 ? "#7ee2c0" : ci.recall[1] < 0 ? "#f0c661" : "#c5cbd3"}>CI recall {pt(ci.recall[0])} s/d {pt(ci.recall[1])}</Chip>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
