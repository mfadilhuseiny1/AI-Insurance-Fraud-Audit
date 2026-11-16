"use client";

// ML Studio · Sistem ML terbaru · "ML v5 benchmark" (the user, 2026-11-13: "lakukan perbaikan ML, kasih benchmark di generator
// 1, 2, 3 dibanding v3 dan v4; pastikan ga overfit"). ML v5 = the audit's first layer retrained on generator 1 + 2 with the
// X5 mode features, chosen on two dev sets and frozen before a NEW generator 3 seed was scored once. Read from ml_v5 in
// /api/ml-sistem (testing/ml_v5.py -> testing/laporan_graf.py). Aggregates of synthetic data only.

import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { ChartCard, GRID, SERIES } from "./viz";

type Uk = { recall: number; fpr: number; presisi_prev2: number; presisi_mentah: number; ditandai: number };
type M = Uk & { auprc: number; fpr_kunjungan_pertama: number; fpr_pasien_lama: number; fpr1_pembanding: { recall: number; presisi_mentah: number };
  per_skema: Record<string, number>; tahan?: Uk };
type Set = { label: string; klaim: number; fraud: number; prevalensi: number; model: Record<string, M>;
  ci_ml_v5_vs_v4: { recall: [number, number]; fpr: [number, number]; presisi_prev2: [number, number] } };
type Cek = { auprc_latih_insample: number; auprc_latih_oof_per_peserta: number; auprc_dev: Record<string, number>; selisih_insample_oof: number;
  recall_dev_per_seed: Record<string, number[]>; porsi_gain_blok: Record<string, number>; fitur_teratas: { fitur: string; porsi: number }[]; peringatan: string[] };
export type MLV5 = { dibuat: string; set: Record<string, Set>;
  kartu: { pilihan: string; kandidat: Record<string, { per_dev: Record<string, { recall: number; fpr: number }>; rata_recall: number }>; v4_di_dev: Record<string, { recall: number }>;
    latih: { gen1: number; gen2: number; fraud: number }; dev: { gen1: number; gen2: number }; kolom: number; cek_overfit: Cek } };

const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const MODEL: [string, string, string][] = [["v3_lama", "v3 (lama)", "#5f6b7a"], ["v3_bersih", "v3 bersih", "#8f99a8"], ["v4", "v4", SERIES[0]], ["ml_v5", "ML v5", SERIES[2]]];
const NAMA_KAND: Record<string, string> = { K1g: "K1 · latih gen 1+2, ambang global", K1s: "K1 · ambang per segmen", K2g: "K2 · + fitur X5, ambang global", K2s: "K2 · + X5, ambang per segmen" };

function Chip({ children, warna = "#8f99a8", garis = false }: { children: ReactNode; warna?: string; garis?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
    style={{ background: garis ? "transparent" : `${warna}22`, color: warna, borderColor: garis ? `${warna}88` : undefined }}>{children}</span>;
}
function Bar({ v, w, label, max = 1 }: { v: number; w: string; label: string; max?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, (v / max) * 100))}%`, background: w }} />
      </div>
      <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label}</span>
    </div>
  );
}

function KartuGenerator({ k, s }: { k: string; s: Set }) {
  const asing = k === "generator3";
  const ci = s.ci_ml_v5_vs_v4;
  const d4 = s.model.ml_v5 && s.model.v4 ? s.model.ml_v5.recall - s.model.v4.recall : 0;
  return (
    <section className={`${box} space-y-3 p-4`} style={asing ? { borderColor: `${SERIES[2]}66` } : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-semibold text-white">{s.label.split(" · ")[0]}</p>
        {asing ? <Chip warna="#7ee2c0">data asing · dinilai sekali</Chip> : <Chip warna="#c5cbd3" garis>dikenal ML v5 · set dipakai ulang</Chip>}
      </div>
      <p className="text-[10.5px] text-[#8f99a8]">{s.label.split(" · ").slice(1).join(" · ")} · {id(s.klaim)} klaim · {id(s.fraud)} fraud ({pct(s.prevalensi)})</p>
      <div className="space-y-2">
        {MODEL.map(([mk, nm, w]) => { const m = s.model[mk]; if (!m) return null; return (
          <div key={mk} className="space-y-0.5">
            <div className="flex items-center justify-between text-[11px]"><span className={mk === "ml_v5" ? "font-semibold text-white" : "text-[#d3d8de]"}>{nm}</span>
              <span className="tabular-nums text-[#abb3bf]">FPR {pct(m.fpr, 2)} · prec@2% {pct(m.presisi_prev2, 0)} · AUPRC {id(m.auprc, 3)}</span></div>
            <Bar v={m.recall} w={w} label={`recall ${pct(m.recall)}`} />
          </div>); })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[.06] pt-2">
        <span className="text-[10.5px] text-[#8f99a8]">ML v5 − v4</span>
        <Chip warna={ci.recall[0] > 0 ? "#7ee2c0" : ci.recall[1] < 0 ? "#f0c661" : "#c5cbd3"}>recall {d4 >= 0 ? "+" : ""}{id(d4 * 100, 1)} poin · CI {id(ci.recall[0] * 100, 1)} s/d {id(ci.recall[1] * 100, 1)}</Chip>
        <Chip warna={ci.presisi_prev2[0] > 0 ? "#7ee2c0" : ci.presisi_prev2[1] < 0 ? "#f0c661" : "#c5cbd3"}>prec@2% CI {id(ci.presisi_prev2[0] * 100, 1)} s/d {id(ci.presisi_prev2[1] * 100, 1)}</Chip>
      </div>
    </section>
  );
}

function SamaFpr({ b }: { b: MLV5 }) {
  const gens = Object.keys(b.set);
  const x = (v: number) => `${Math.min(100, v * 100)}%`;
  return (
    <ChartCard title="Pada FPR yang sama (1%) · recall per generator" insight="Ambang disetel per set hanya untuk membandingkan model secara adil (skor model saja; v3 tanpa rule route-nya)."
      table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">Generator</th>{MODEL.map(([mk, nm]) => <th key={mk} className="px-2 py-1 text-right">{nm}</th>)}</tr></thead>
        <tbody className="text-[#d3d8de]">{gens.map((g) => <tr key={g} className="border-t border-white/[.05]"><td className="px-2 py-1">{b.set[g].label.split(" · ")[0]}</td>
          {MODEL.map(([mk]) => <td key={mk} className="px-2 py-1 text-right tabular-nums">{pct(b.set[g].model[mk]?.fpr1_pembanding.recall)}</td>)}</tr>)}</tbody></table>}>
      <div className="space-y-3">
        {gens.map((g) => (
          <div key={g} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 120px) minmax(0, 1fr)" }}>
            <span className="text-[11.5px] text-[#d3d8de]">{b.set[g].label.split(" · ")[0]}</span>
            <div className="relative h-6 rounded" style={{ background: GRID }}>
              {MODEL.map(([mk, nm, w]) => { const v = b.set[g].model[mk]?.fpr1_pembanding.recall; if (v === undefined) return null; return (
                <span key={mk} title={`${nm}: ${pct(v)}`} className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#1c2127]" style={{ left: x(v), background: w }} />); })}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-3 pl-[132px] text-[10.5px] text-[#8f99a8]">{MODEL.map(([mk, nm, w]) => <span key={mk} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: w }} />{nm}</span>)}
          <span>skala 0–100%</span></div>
      </div>
    </ChartCard>
  );
}

function Overfit({ k }: { k: MLV5["kartu"] }) {
  const c = k.cek_overfit;
  const blokW = [SERIES[0], SERIES[4], SERIES[3], SERIES[2]];
  const blok = Object.entries(c.porsi_gain_blok);
  return (
    <section className={`${box} space-y-3 p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="eye" className="h-4 w-4 text-[#9ec5ff]" />Cek overfit (sebelum benchmark)</h3>
        {c.peringatan.length === 0 ? <Chip warna="#7ee2c0"><Icon name="check" className="h-3 w-3" />tidak ada peringatan</Chip>
          : c.peringatan.map((w) => <Chip key={w} warna="#f0c661">{w}</Chip>)}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">AUPRC: latih vs CV per peserta vs dev</p>
          <Bar v={c.auprc_latih_insample} w="#5f6b7a" label={`latih ${id(c.auprc_latih_insample, 3)}`} />
          <Bar v={c.auprc_latih_oof_per_peserta} w={SERIES[0]} label={`CV ${id(c.auprc_latih_oof_per_peserta, 3)}`} />
          {Object.entries(c.auprc_dev).map(([d, v]) => <Bar key={d} v={v} w={SERIES[2]} label={`dev ${d} ${id(v, 3)}`} />)}
          <p className="text-[10.5px] text-[#abb3bf]">Selisih latih − CV {id(c.selisih_insample_oof, 3)} (batas waspada 0,10).</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Recall dev per seed (FPR 1%)</p>
          {Object.entries(c.recall_dev_per_seed).map(([d, v]) => (
            <p key={d} className="text-[11.5px] text-[#d3d8de]">{d}: {v.map((x) => pct(x)).join(" · ")} <span className="text-[#8f99a8]">(sebaran {id((Math.max(...v) - Math.min(...v)) * 100, 1)} poin)</span></p>))}
          <p className="pt-1 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Kandidat di dev (rata recall)</p>
          {Object.entries(k.kandidat).map(([n, v]) => (
            <p key={n} className="flex items-center gap-1.5 text-[11px] text-[#d3d8de]">{n === k.pilihan && <Chip warna="#7ee2c0">dipilih</Chip>}{NAMA_KAND[n] ?? n}: {pct(v.rata_recall)}</p>))}
          <p className="text-[11px] text-[#abb3bf]">v4 di dev: {Object.entries(k.v4_di_dev).map(([d, v]) => `${d} ${pct(v.recall)}`).join(" · ")}</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Porsi gain per blok fitur</p>
          <div className="flex h-3 overflow-hidden rounded gap-px">{blok.map(([n, v], i) => v > 0 && <span key={n} title={`${n}: ${pct(v)}`} style={{ flex: v, background: blokW[i] }} />)}</div>
          {blok.map(([n, v], i) => <p key={n} className="flex items-center gap-1.5 text-[11px] text-[#d3d8de]"><span className="h-2 w-2.5 rounded-sm" style={{ background: blokW[i] }} />{n}: {pct(v)}</p>)}
          <p className="pt-1 text-[10.5px] text-[#8f99a8]">Fitur teratas: {c.fitur_teratas.slice(0, 4).map((f) => `${f.fitur.replace("klaim: ", "")} ${pct(f.porsi, 0)}`).join(" · ")}</p>
        </div>
      </div>
    </section>
  );
}

function PerSkema({ s }: { s: Set }) {
  const a = s.model.v4?.per_skema ?? {}, b = s.model.ml_v5?.per_skema ?? {};
  const rows = Object.keys(b).map((k) => ({ k, d: (b[k] ?? 0) - (a[k] ?? 0) })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 8);
  return (
    <ChartCard title="Generator 3 (data asing) · skema yang paling berubah, v4 → ML v5" insight="Recall per skema; skema dengan klaim sedikit bisa berfluktuasi."
      table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">Skema</th><th className="px-2 py-1 text-right">v4</th><th className="px-2 py-1 text-right">ML v5</th></tr></thead>
        <tbody className="text-[#d3d8de]">{Object.keys(b).map((k) => <tr key={k} className="border-t border-white/[.05]"><td className="px-2 py-1">{k}</td><td className="px-2 py-1 text-right tabular-nums">{pct(a[k])}</td><td className="px-2 py-1 text-right tabular-nums">{pct(b[k])}</td></tr>)}</tbody></table>}>
      <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
        {rows.map(({ k }) => (
          <div key={k} className="space-y-1"><p className="text-[11px] text-[#d3d8de]">{k.replace(/_/g, " ")}</p>
            <Bar v={a[k] ?? 0} w={SERIES[0]} label={`v4 ${pct(a[k], 0)}`} /><Bar v={b[k] ?? 0} w={SERIES[2]} label={`v5 ${pct(b[k], 0)}`} /></div>))}
      </div>
    </ChartCard>
  );
}

// the top of ML Studio: v5 in one row of numbers (ML v5 on each generator, and the swarm on top of the model)
type SwarmV5 = { hasil: { v4_B: { recall: number; presisi_prev2: number; fpr: number }; v5: { recall: number; presisi_prev2: number; fpr: number } }; adopsi: { lolos: boolean } };

export function RingkasanV5({ b, v }: { b?: MLV5; v?: SwarmV5 }) {
  const kartu: { judul: string; sub: string; a: number; z: number; pa: number; pz: number; asing?: boolean }[] = [];
  for (const [g, nm] of [["generator3", "Generator 3 · data asing"], ["generator2", "Generator 2"], ["generator1", "Generator 1"]] as const) {
    const s = b?.set[g];
    if (s?.model.v4 && s.model.ml_v5) kartu.push({ judul: `ML v5 · ${nm}`, sub: "vs v4, ambang beku", a: s.model.v4.recall, z: s.model.ml_v5.recall, pa: s.model.v4.presisi_prev2, pz: s.model.ml_v5.presisi_prev2, asing: g === "generator3" });
  }
  if (v) kartu.push({ judul: "AI Agent Swarm · generator 3", sub: "klaim ragu dibaca 4 agen, di atas ML v4", a: v.hasil.v4_B.recall, z: v.hasil.v5.recall, pa: v.hasil.v4_B.presisi_prev2, pz: v.hasil.v5.presisi_prev2, asing: true });
  return (
    <section className="rounded-xl border p-4" style={{ borderColor: `${SERIES[2]}55`, background: `linear-gradient(135deg, ${SERIES[2]}14, transparent 60%)` }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#199e70]/20 text-[#7ee2c0]"><Icon name="layers" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-[0.16em] text-[#7ee2c0]">Sistem terbaru · v5</p>
          <h2 className="text-[17px] font-semibold text-white">ML v5 (LightGBM, graph, dilatih generator 1 + 2) + rule engine + AI Agent Swarm</h2>
          <p className="text-[11px] text-[#abb3bf]">Recall dan precision (fraud 2%) sebelum → sesudah. Generator 3 = data asing, seed baru, dinilai sekali. /testing masih v3 (ganti model = keputusan pengguna).</p>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {kartu.map((k) => {
          const dr = k.z - k.a, dp = k.pz - k.pa;
          return (
            <div key={k.judul} className={`rounded-lg border bg-[#151a1f] p-3 ${k.asing ? "border-[#199e70]/50" : "border-white/[.08]"}`}>
              <p className="text-[11.5px] font-semibold text-white">{k.judul}</p>
              <p className="text-[10px] text-[#8f99a8]">{k.sub}</p>
              <p className="mt-2 text-[24px] font-semibold leading-none tabular-nums text-white">{pct(k.z)}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px] text-[#abb3bf]">recall dari {pct(k.a)}
                <Chip warna={dr > 0.005 ? "#7ee2c0" : dr < -0.005 ? "#f0c661" : "#c5cbd3"}>{dr >= 0 ? "+" : "−"}{id(Math.abs(dr) * 100, 1)} poin</Chip></p>
              <p className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px] text-[#abb3bf]">precision {pct(k.pa, 0)} → {pct(k.pz, 0)}
                <Chip warna={dp > 0.005 ? "#7ee2c0" : dp < -0.005 ? "#f0c661" : "#c5cbd3"}>{dp >= 0 ? "+" : "−"}{id(Math.abs(dp) * 100, 1)}</Chip></p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function BenchmarkMlV5({ b }: { b: MLV5 }) {
  const g3 = b.set.generator3;
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#199e70]/20 text-[#7ee2c0]"><Icon name="cpu" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">ML v5 · benchmark · {b.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">ML v5 vs v4 vs v3 di generator 1, 2, 3</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Chip warna="#7ee2c0">dipilih: {NAMA_KAND[b.kartu.pilihan] ?? b.kartu.pilihan}</Chip>
            <Chip>latih {id(b.kartu.latih.gen1 + b.kartu.latih.gen2)} klaim (gen 1 {id(b.kartu.latih.gen1)} + gen 2 {id(b.kartu.latih.gen2)})</Chip>
            <Chip>{b.kartu.kolom} fitur</Chip><Chip warna="#c5cbd3" garis>generator 3 = data asing, seed baru, dinilai sekali</Chip>
          </div>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>
      <Overfit k={b.kartu} />
      <div className="grid gap-3 xl:grid-cols-3">{["generator1", "generator2", "generator3"].filter((g) => b.set[g]).map((g) => <KartuGenerator key={g} k={g} s={b.set[g]} />)}</div>
      <SamaFpr b={b} />
      {g3 && (
        <section className={`${box} p-4`}>
          <h3 className="mb-2 text-[13px] font-semibold text-white">Alarm salah pasien baru vs pasien lama · generator 3</h3>
          <div className="grid gap-2 md:grid-cols-4">
            {MODEL.map(([mk, nm, w]) => { const m = g3.model[mk]; if (!m) return null; return (
              <div key={mk} className="rounded-md border border-white/[.08] bg-[#151a1f] p-2.5"><p className="text-[11px] font-semibold" style={{ color: w === "#5f6b7a" ? "#c5cbd3" : w }}>{nm}</p>
                <p className="text-[11px] text-[#d3d8de]">pasien baru {pct(m.fpr_kunjungan_pertama, 2)} · lama {pct(m.fpr_pasien_lama, 2)}</p>
                <p className="text-[10.5px] text-[#8f99a8]">rasio {id(m.fpr_kunjungan_pertama / Math.max(1e-6, m.fpr_pasien_lama), 1)}×</p></div>); })}
          </div>
        </section>
      )}
      {g3 && <PerSkema s={g3} />}
    </div>
  );
}
